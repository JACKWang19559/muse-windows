'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { assertLiveTestProfile } = require('../backend/live-test-profile.cjs');

module.exports = async ({ app, window, store, operations, snapshot }) => {
  const folder = process.env.MUSE_LIVE_REPORT_DIR;
  const report = { startedAt: new Date().toISOString(), fixtureOnly: false, checks: [] };
  const check = (name, condition, detail) => { assert.ok(condition, name); report.checks.push({ name, passed: true, ...detail }); };
  const page = (fn, value) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`);
  const wait = async (callback, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Real provider test timed out.');
  };
  let secret = '';
  let previousPrompt;
  try {
    const profile = assertLiveTestProfile(path.resolve(__dirname, '..'), app.getPath('userData'), process.argv.some(arg => arg.startsWith('--data-dir=')));
    report.fixtureOnly = profile.fixtureOnly;
    await wait(() => page(() => !!document.querySelector('[data-testid="composer-input"]')), 10000);
    const settings = store.settings();
    report.requestedModel = settings.model;
    report.endpointHost = new URL(settings.baseUrl).host;
    secret = store.secret();
    check('Credential was entered in the app and decrypted by Windows', !!secret && settings.hasApiKey);
    check('Credential is absent from public snapshots', !JSON.stringify(snapshot()).includes(secret));
    previousPrompt = settings.systemPrompt;
    store.saveSettings({ systemPrompt: '这是独立的合成资料接口验收。仅按用户要求简短回答，不包含其他信息。' });
    const discovery = await operations.testConnection();
    report.modelDiscovery = { ok: discovery.ok, message: discovery.message, requestedModelListed: discovery.models?.includes(settings.model) };
    const code = 'WIND-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const docxCode = 'CEDAR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const txt = path.join(folder, 'synthetic-reference.txt');
    const docx = path.join(folder, 'synthetic-reference.docx');
    fs.writeFileSync(txt, '这是合成验收资料，项目代号为 ' + code + '。', 'utf8');
    fs.writeFileSync(docx, zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>这份合成文档的第二个代号为 ' + docxCode + '。</w:t></w:r></w:p></w:body></w:document>') }));
    const workspace = store.createWorkspace({ name: '真实模型验收 ' + code });
    const files = [];
    for (const sourcePath of [txt, docx]) files.push(await store.addFile({ sourcePath, workspaceId: workspace.id }));
    check('Actual TXT and DOCX extraction succeeded', files.every(file => file.textStatus === 'ready'));
    const chat = await page(input => window.muse.createChat(input), { workspaceId: workspace.id });
    await page(() => { window.__liveEvents = []; window.__liveUnsubscribe = window.muse.subscribe(event => window.__liveEvents.push(event)); });
    const answer = async content => {
      const started = Date.now();
      await page(input => window.muse.sendMessage(input), { chatId: chat.id, content });
      const message = await wait(() => {
        const value = store.getChat(chat.id).messages.at(-1);
        return value?.role === 'assistant' && value.status !== 'streaming' ? value : null;
      });
      if (message.status !== 'complete') throw new Error(message.error || 'Real generation did not complete.');
      return { message, elapsedMs: Date.now() - started };
    };
    const first = await answer('请读取当前工作区的两份参考文件，只回复 MUSE_LIVE_OK 加上文件里的两个代号，不要解释。');
    check('Real model received workspace TXT and DOCX context through IPC', first.message.content.includes('MUSE_LIVE_OK') && first.message.content.includes(code) && first.message.content.includes(docxCode), { answerCharacters: first.message.content.length, elapsedMs: first.elapsedMs });
    const second = await answer('请把你上一条回复中的两个代号按原顺序再写一遍，只写代号。');
    check('Real multi-turn conversation preserved the prior answer', second.message.content.includes(code) && second.message.content.includes(docxCode), { answerCharacters: second.message.content.length, elapsedMs: second.elapsedMs });
    const events = await page(() => { window.__liveUnsubscribe(); return window.__liveEvents.map(event => ({ type: event.type, chatId: event.chatId })); });
    check('Real response deltas reached isolated preload subscribers', events.some(event => event.type === 'chat-delta'));
    check('Each generation completed without an error event', events.filter(event => event.type === 'chat-complete').length === 2 && !events.some(event => event.type === 'chat-error'));
    const backup = await store.exportData();
    check('Export omits the real API key', !JSON.stringify(backup).includes(secret));
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = secret ? String(error.message).split(secret).join('[redacted]') : String(error.message);
  } finally {
    if (previousPrompt !== undefined) {
      try { store.saveSettings({ systemPrompt: previousPrompt }); }
      catch (error) { report.passed = false; report.promptRestoreError = String(error.message); }
    }
    report.completedAt = new Date().toISOString();
    const redact = value => typeof value === 'string' ? secret ? value.split(secret).join('[redacted]') : value : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item)])) : value;
    const safeReport = JSON.stringify(redact(report), null, 2);
    fs.writeFileSync(path.join(folder, 'report.json'), safeReport);
    console.log(safeReport);
    app.exit(report.passed ? 0 : 1);
  }
};
