'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');

// The native save picker alone is simulated. UI, isolated IPC, the production
// exporter and all output-byte checks are real and confined to this fixture.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('File export checks require the isolated desktop fixture profile.');
  const output = path.join(folder, 'file-export-output');
  fs.mkdirSync(output, { recursive: true });
  const originalPicker = dialog.showSaveDialog, originalExport = operations.exportFile, originalSave = operations.saveTextFile;
  const exports = [], prompts = [], pendingChoices = [], ids = new Set(), releases = [];
  let saves = 0;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const click = testId => page(id => { const button = document.querySelector(`[data-testid="${id}"]`); if (!button) throw Error('Missing export action ' + id); button.click(); }, testId);
  const nodeWait = async predicate => { const deadline = Date.now() + 7000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('File export fixture operation did not settle.'); };
  const open = async file => {
    await wait(name => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === name), file.name);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), file.name);
    await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name && document.querySelector('[role="tab"][aria-selected="true"]')?.title === name && document.querySelector('[data-testid="file-download"]')?.disabled === false, file.name);
  };
  const edit = async text => { await click('file-edit-mode'); await wait(() => !!document.querySelector('[data-testid="file-editor-input"]')); await fill('file-editor-input', text); };
  const close = () => page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
  const raw = id => fs.readFileSync(store.filePath(id));
  const draftEquals = text => page(value => document.querySelector('[data-testid="file-editor-input"]')?.value === value && !!document.querySelector('[aria-label="未保存"]'), text);
  const choose = (name, extra = {}) => { const target = path.join(output, name); pendingChoices.push({ target, ...extra }); return target; };
  const download = async (name, extra = {}) => {
    const target = choose(name, extra), before = exports.length;
    await click('file-download'); await nodeWait(() => exports.length === before + 1 && exports.at(-1).settled);
    await wait(() => document.querySelector('[data-testid="file-download"]')?.disabled === false);
    return { target, call: exports.at(-1), prompt: prompts.at(-1) };
  };
  const screenshot = async name => { await new Promise(resolve => setTimeout(resolve, 180)); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };

  try {
    if (await page(() => !!document.querySelector('[data-testid="file-preview"]'))) { await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]')); }
    const workspace = await operations.createWorkspace({ name: '文件下载验收工作区' });
    const rawSource = path.join(folder, '原字节-BOM.txt'), rawBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM_CRLF_RAW_20\r\n第二行\r\n')]);
    const binarySource = path.join(folder, '不支持预览.bin'), binaryBytes = Buffer.from([0, 255, 4, 128, 0, 13, 10, 0, 22, 199]);
    fs.writeFileSync(rawSource, rawBytes); fs.writeFileSync(binarySource, binaryBytes);
    const rawFile = await store.addFile({ sourcePath: rawSource, workspaceId: workspace.id });
    const binary = await store.addFile({ sourcePath: binarySource, workspaceId: workspace.id });
    const originalJson = '{\n  "saved": "FILE_EXPORT_MANAGED_20"\n}\n';
    const json = (await operations.createTextFile({ workspaceId: workspace.id, name: '未保存副本.json', content: originalJson })).file;
    const originalJsonl = '{"saved":"JSONL_MANAGED_20"}\n';
    const jsonl = (await operations.createTextFile({ workspaceId: workspace.id, name: '逐行副本.jsonl', content: originalJsonl })).file;
    for (const file of [rawFile, binary, json, jsonl]) ids.add(file.id);
    operations.exportFile = async input => {
      if (!ids.has(input?.id)) return originalExport(input);
      const record = { input: { ...input }, settled: false, result: null, failed: false }; exports.push(record);
      try { const result = await originalExport(input); record.result = result; return result; }
      catch (error) { record.failed = true; throw error; }
      finally { record.settled = true; }
    };
    operations.saveTextFile = async input => { if (ids.has(input?.id)) saves++; return originalSave(input); };
    dialog.showSaveDialog = async (_owner, options) => {
      if (options?.title !== '下载文件副本') throw Error('Unexpected picker in file export fixture.');
      const choice = pendingChoices.shift(); if (!choice) throw Error('Missing bounded export picker choice.');
      if (!same(path.dirname(choice.target), output)) throw Error('Export picker choice escaped fixture output.');
      prompts.push({ defaultPath: options.defaultPath });
      choice.entered?.resolve(); if (choice.gate) await choice.gate.promise;
      if (choice.reject) throw Error('SYNTHETIC_SAVE_PICKER_UNAVAILABLE_20');
      return { canceled: choice.cancelled === true, filePath: choice.target };
    };
    check('File download acceptance uses a simulated native picker with real isolated IPC and filesystem writes', same(store.dataDir, path.join(folder, 'data')) && same(path.dirname(output), folder));
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element => element.textContent.includes(name)), workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element => element.textContent.includes(name)).click(), workspace.name);

    await open(json); await edit('{\n "invalid": [1,\n "DRAFT_EXPORT_20"\n');
    const invalidDraft = '{\n "invalid": [1,\n "DRAFT_EXPORT_20"\n';
    const invalid = await download('invalid-draft.json');
    check('Invalid JSON downloads exact unsaved text without invoking Save or mutating the managed file', !invalid.call.failed && invalid.call.result?.draft === true && fs.readFileSync(invalid.target, 'utf8') === invalidDraft && raw(json.id).toString('utf8') === originalJson && saves === 0);
    check('Downloading keeps the JSON draft dirty and retains the original suggested filename', await draftEquals(invalidDraft) && invalid.prompt.defaultPath === json.name && Object.keys(invalid.call.input).sort().join(',') === 'content,id' && invalid.call.input.id === json.id);
    await close(); await wait(() => !!document.querySelector('[data-testid="file-discard"]'));
    check('Downloading a draft does not consume its unsaved-close confirmation', await page(() => !!document.querySelector('[data-testid="file-save-and-close"]') && !!document.querySelector('[data-testid="file-preview"]')) && raw(json.id).toString('utf8') === originalJson);
    await page(() => [...document.querySelectorAll('.confirm-modal button')].find(button => button.textContent === '继续编辑').click());
    await wait(() => !document.querySelector('.confirm-modal'));
    await fill('file-editor-input', ''); const empty = await download('empty-draft.json');
    check('An empty dirty draft downloads zero bytes instead of falling back to saved JSON', fs.statSync(empty.target).size === 0 && empty.call.input.content === '' && empty.call.result?.draft === true && raw(json.id).toString('utf8') === originalJson && await draftEquals('') && saves === 0);

    const cancelDraft = '{ invalid CANCEL_EXPORT_20 }'; await fill('file-editor-input', cancelDraft);
    const cancelPath = path.join(output, 'cancel-keeps-existing.json'); fs.writeFileSync(cancelPath, 'CANCEL_EXISTING_20');
    const cancelled = await download(path.basename(cancelPath), { cancelled: true });
    check('Cancelling the save picker returns cancellation and leaves destination and draft untouched', cancelled.call.result?.cancelled === true && fs.readFileSync(cancelPath, 'utf8') === 'CANCEL_EXISTING_20' && await draftEquals(cancelDraft) && raw(json.id).toString('utf8') === originalJson && saves === 0);
    const rejected = await download('picker-rejected.json', { reject: true });
    await wait(() => document.querySelector('.toast')?.textContent.includes('SYNTHETIC_SAVE_PICKER_UNAVAILABLE_20'));
    check('Native picker failure is reported without changing or saving the draft', rejected.call.failed && !fs.existsSync(rejected.target) && await draftEquals(cancelDraft) && raw(json.id).toString('utf8') === originalJson && saves === 0);
    fs.mkdirSync(path.join(output, 'not-a-file.json'));
    const failure = await download('not-a-file.json');
    await wait(() => document.querySelector('.toast')?.textContent.includes('下载位置必须是普通文件'));
    check('A real invalid filesystem destination reports export failure and preserves the draft', failure.call.failed && fs.statSync(failure.target).isDirectory() && await draftEquals(cancelDraft) && raw(json.id).toString('utf8') === originalJson && !fs.readdirSync(output).some(name => name.startsWith('.muse-download-')));
    await screenshot('file-download-draft.png');

    const capturedDraft = '{ CAPTURED_EXPORT_20 }', laterDraft = '{ LATER_EDITOR_DRAFT_20 }';
    await fill('file-editor-input', capturedDraft);
    const entered = deferred(), gate = deferred(); releases.push(gate.resolve);
    const heldTarget = choose('captured-before-picker.json', { entered, gate }), beforeHeld = exports.length;
    await click('file-download'); await nodeWait(() => prompts.length === beforeHeld + 1); await entered.promise;
    await fill('file-editor-input', laterDraft);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), rawFile.name);
    await wait(name => document.querySelector('[role="tab"][aria-selected="true"]')?.title === name && document.querySelector('[data-testid="file-download"]')?.disabled === true, rawFile.name);
    check('A pending download retains its captured target and blocks duplicate downloads after tab switching', exports.length === beforeHeld + 1 && exports.at(-1).input.id === json.id && exports.at(-1).input.content === capturedDraft && prompts.at(-1).defaultPath === json.name && await page(() => document.querySelector('[data-testid="file-download"]').disabled));
    gate.resolve(); await nodeWait(() => exports.at(-1).settled); await wait(() => document.querySelector('[data-testid="file-download"]')?.disabled === false);
    check('Delayed picker completion writes the originally captured draft and leaves the new tab selected', fs.readFileSync(heldTarget, 'utf8') === capturedDraft && await page(name => document.querySelector('[role="tab"][aria-selected="true"]')?.title === name, rawFile.name) && raw(json.id).toString('utf8') === originalJson);
    await page(name => document.querySelector(`[role="tab"][title="${name}"]`).click(), json.name);
    await wait(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected, laterDraft);
    check('Editing during the native picker keeps the newer dirty text after completion', await draftEquals(laterDraft) && saves === 0 && !exports.at(-1).failed);

    await open(jsonl); const multiLine = '{"record":"JSONL_DRAFT_FIRST_20"}\n{"record":"JSONL_DRAFT_SECOND_20"}\n';
    await edit(multiLine); const lines = await download('multi-record.jsonl');
    check('Multi-record JSONL downloads its full unsaved source despite the editor Save restriction', lines.call.result?.draft === true && fs.readFileSync(lines.target, 'utf8') === multiLine && raw(jsonl.id).toString('utf8') === originalJsonl && await draftEquals(multiLine) && saves === 0);
    await close(); await wait(() => !!document.querySelector('[data-testid="file-discard"]'));
    check('JSON and JSONL draft downloads preserve dirty guards for every open tab', await page(() => document.querySelector('.confirm-body')?.textContent.includes('未保存副本.json') && document.querySelector('.confirm-body')?.textContent.includes('逐行副本.jsonl')) && saves === 0);
    await click('file-discard'); await wait(() => !document.querySelector('[data-testid="file-preview"]'));

    await open(rawFile);
    const preview = store.readFile(rawFile.id);
    check('The clean text fixture has normalized preview content distinct from original BOM and CRLF bytes', preview.text === 'BOM_CRLF_RAW_20\n第二行\n' && !rawBytes.equals(Buffer.from(preview.text)) && raw(rawFile.id).equals(rawBytes));
    const rawCopy = await download('clean-raw-copy.txt');
    check('Clean download copies original BOM and CRLF bytes rather than normalized preview text', !rawCopy.call.failed && rawCopy.call.result?.draft === false && Object.keys(rawCopy.call.input).join(',') === 'id' && fs.readFileSync(rawCopy.target).equals(rawBytes) && rawCopy.prompt.defaultPath === rawFile.name && raw(rawFile.id).equals(rawBytes));

    await open(binary); await wait(() => document.querySelector('.empty-preview h4')?.textContent === '暂无文字预览');
    check('Unsupported binary preview still exposes Download while its source editor stays disabled', await page(() => !document.querySelector('[data-testid="file-download"]').disabled && document.querySelector('[data-testid="file-edit-mode"]').disabled));
    const binaryCopy = await download('binary-copy.bin');
    check('Binary preview failure downloads identical original bytes through the real exporter', !binaryCopy.call.failed && binaryCopy.call.result?.draft === false && binaryCopy.call.result?.size === binaryBytes.length && binaryCopy.prompt.defaultPath === binary.name && fs.readFileSync(binaryCopy.target).equals(binaryBytes) && raw(binary.id).equals(binaryBytes));
    await screenshot('file-download-binary.png');
    check('All download paths leave managed originals and source files unchanged without invoking Save', saves === 0 && raw(json.id).toString('utf8') === originalJson && raw(jsonl.id).toString('utf8') === originalJsonl && fs.readFileSync(rawSource).equals(rawBytes) && fs.readFileSync(binarySource).equals(binaryBytes) && pendingChoices.length === 0 && exports.every(item => item.settled) && !fs.readdirSync(output).some(name => name.startsWith('.muse-download-')));
    await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
  } finally {
    for (const release of releases) release();
    dialog.showSaveDialog = originalPicker;
    operations.exportFile = originalExport;
    operations.saveTextFile = originalSave;
  }
};
