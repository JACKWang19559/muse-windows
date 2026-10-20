'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../backend/store.cjs');
const { extractDocument, MAX_TEXT_CHARS } = require('../backend/documents.cjs');
const { zipSync, strToU8 } = require('fflate');

function fixture(t) {
  const scratch = path.resolve(__dirname, '.tmp'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'muse-backend-'));
  t.after(() => { if (path.dirname(root) === scratch && path.basename(root).startsWith('muse-backend-')) fs.rmSync(root, { recursive: true, force: true }); });
  const secretKey = crypto.randomBytes(32);
  const encrypt = text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv); const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]); };
  const decrypt = bytes => { const cipher = crypto.createDecipheriv('aes-256-gcm', secretKey, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); };
  const options = { encrypt, decrypt }, dataDir = path.join(root, 'data');
  const source = (name, content) => { const filename = path.join(root, name); fs.writeFileSync(filename, content); return filename; };
  return { root, dataDir, options, source, store: new Store(dataDir, options) };
}

test('store persists settings/chats atomically and keeps API keys out of public data and exports', t => {
  const { store, dataDir, options } = fixture(t), key = 'test-key-that-must-not-appear-in-json';
  store.saveSettings({ baseUrl: 'http://localhost:1234/v1', model: 'local', apiKey: key });
  const workspace = store.createWorkspace({ name: '研究' }), chat = store.createChat({ workspaceId: workspace.id });
  store.appendMessage(chat.id, { role: 'user', content: 'hello' });
  const assistant = store.appendMessage(chat.id, { role: 'assistant', content: 'partial', status: 'streaming' });
  assert.equal(store.secret(), key); assert.equal(store.settings().hasApiKey, true);
  const disk = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'); assert.equal(disk.includes(key), false);
  for (const value of [store.snapshot(), store.settings(), store.exportData()]) { const serialized = JSON.stringify(value); assert.equal(serialized.includes(key), false); assert.equal(serialized.includes('encryptedApiKey'), false); assert.equal(serialized.includes(dataDir), false); }
  const restarted = new Store(dataDir, options);
  assert.equal(restarted.secret(), key); assert.equal(restarted.getChat(chat.id).messages[1].id, assistant.id); assert.equal(restarted.getChat(chat.id).messages[1].status, 'cancelled');
  assert.match(restarted.recoveryNotice, /已停止/); assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
  restarted.saveSettings({ apiKey: '', theme: 'dark' }); assert.equal(restarted.secret(), key);
  restarted.saveSettings({ clearApiKey: true }); assert.equal(restarted.secret(), '');
});

test('saving a secret never falls back to plaintext if OS encryption is unavailable', t => {
  const { dataDir } = fixture(t), store = new Store(dataDir);
  assert.throws(() => store.saveSettings({ apiKey: 'test-secret' }), /加密服务不可用/);
  assert.equal(store.settings().hasApiKey, false);
  assert.throws(() => store.saveSettings({ temperature: NaN }), /温度/);
  assert.throws(() => store.createWorkspace({ name: '' }), /名称/);
});

test('managed file copies survive original changes and remain private; deletion preserves originals', async t => {
  const { store, source, dataDir } = fixture(t), original = source('notes.md', '# 研究\n原文');
  const file = await store.addFile({ sourcePath: original });
  assert.equal(file.textStatus, 'ready'); assert.equal(file.mime, 'text/markdown');
  fs.writeFileSync(original, 'changed'); assert.equal(store.readFile(file.id).text, '# 研究\n原文');
  assert.equal(JSON.stringify(store.snapshot()).includes('_storedName'), false); assert.equal(JSON.stringify(store.snapshot()).includes(original), false);
  const managed = store.filePath(file.id); assert.equal(path.dirname(managed), path.join(dataDir, 'attachments'));
  store.removeFile(file.id); assert.equal(fs.existsSync(managed), false); assert.equal(fs.readFileSync(original, 'utf8'), 'changed');
  assert.throws(() => store.filePath('../escape'), /标识符/);
});

test('workspace context isolates documents and requires explicit cross-workspace attachments', async t => {
  const { store, source } = fixture(t), first = store.createWorkspace({ name: 'A' }), second = store.createWorkspace({ name: 'B' });
  const a = await store.addFile({ sourcePath: source('a.txt', 'A private'), workspaceId: first.id });
  const b = await store.addFile({ sourcePath: source('b.json', '{"scope":"B"}'), workspaceId: second.id });
  const global = await store.addFile({ sourcePath: source('global.csv', 'a,b\n1,2') });
  const chat = store.createChat({ workspaceId: first.id }), unscoped = store.createChat();
  assert.deepEqual(store.contextDocuments(chat.id).map(item => item.id), [a.id]);
  assert.deepEqual(store.contextDocuments(unscoped.id), []);
  assert.deepEqual(new Set(store.contextDocuments(chat.id, [b.id, global.id]).map(item => item.id)), new Set([a.id, b.id, global.id]));
  store.deleteWorkspace(first.id); assert.equal(store.getChat(chat.id).workspaceId, null); assert.equal(store.getFile(a.id).workspaceId, null); assert.deepEqual(store.contextDocuments(chat.id), []);
});

test('backup roundtrip merges data, regenerates identifiers, remaps relations and preserves local secret', async t => {
  const { store, source, root, options } = fixture(t), workspace = store.createWorkspace({ name: '保存的空间' });
  const file = await store.addFile({ sourcePath: source('keep.md', 'backup document'), workspaceId: workspace.id });
  const chat = store.createChat({ workspaceId: workspace.id }); store.appendMessage(chat.id, { role: 'user', content: 'question', attachmentIds: [file.id] });
  const backup = store.exportData();
  const other = new Store(path.join(root, 'other-data'), options); other.saveSettings({ apiKey: 'destination-private-secret' }); other.createChat({ title: 'existing' });
  const result = await other.importData(backup);
  assert.equal(result.chats.length, 2); assert.equal(other.secret(), 'destination-private-secret');
  const imported = result.chats.find(item => item.title !== 'existing');
  assert.notEqual(imported.id, chat.id); assert.notEqual(imported.workspaceId, workspace.id); assert.notEqual(imported.messages[0].id, chat.messages[0]?.id);
  assert.notEqual(imported.messages[0].attachmentIds[0], file.id); assert.equal(result.files[0].workspaceId, imported.workspaceId); assert.equal(other.readFile(result.files[0].id).text, 'backup document');
  assert.equal(JSON.stringify(backup).includes('_storedName'), false); assert.equal(JSON.stringify(backup).includes('apiKey'), false);
});

test('backup validation rejects filesystem paths, corruption and dangling relations before writing files', async t => {
  const { store, source, dataDir } = fixture(t); await store.addFile({ sourcePath: source('safe.txt', 'safe') });
  const original = store.exportData(), baseline = JSON.stringify(store.snapshot()), filesBefore = fs.readdirSync(path.join(dataDir, 'attachments'));
  const cases = [
    backup => { backup.files[0].path = 'C:\\private\\secret.txt'; },
    backup => { backup.files[0].name = '../secret.txt'; },
    backup => { backup.files[0].id = '..\\escape'; },
    backup => { backup.files[0].dataBase64 = '%%%'; },
    backup => { backup.files[0].sha256 = '0'.repeat(64); },
    backup => { backup.files[0].workspaceId = 'missing-workspace'; },
    backup => { backup.settings.apiKey = 'not-allowed'; },
    backup => { backup.schemaVersion = 999; }
  ];
  for (const modify of cases) { const backup = structuredClone(original); modify(backup); await assert.rejects(store.importData(backup)); assert.equal(JSON.stringify(store.snapshot()), baseline); assert.deepEqual(fs.readdirSync(path.join(dataDir, 'attachments')), filesBefore); }
});

test('corrupt primary state recovers the previous atomic backup and preserves the corrupt input', t => {
  const { store, dataDir, options } = fixture(t); const workspace = store.createWorkspace({ name: 'recover me' }); store.createChat({ workspaceId: workspace.id });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{broken');
  const recovered = new Store(dataDir, options);
  assert.equal(recovered.snapshot().workspaces[0].name, 'recover me'); assert.match(recovered.recoveryNotice, /自动备份/);
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('state.json.corrupt-')), true);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{broken'); fs.writeFileSync(path.join(dataDir, 'state.backup.json'), '{broken');
  assert.throws(() => new Store(dataDir, options), /均无法读取/);
});

test('a missing primary state also recovers the automatic backup', t => {
  const { store, dataDir, options } = fixture(t); store.createWorkspace({ name: 'from backup' }); store.createChat();
  fs.unlinkSync(path.join(dataDir, 'state.json'));
  const recovered = new Store(dataDir, options);
  assert.equal(recovered.snapshot().workspaces[0].name, 'from backup'); assert.match(recovered.recoveryNotice, /文件缺失/);
});

test('message patches can clear stale errors without retaining private optional fields', t => {
  const { store } = fixture(t), chat = store.createChat();
  const message = store.appendMessage(chat.id, { role: 'assistant', content: '', status: 'error', error: 'old error' });
  const updated = store.updateMessage(chat.id, message.id, { content: 'recovered', status: 'complete', error: undefined });
  assert.equal('error' in updated, false); assert.equal('error' in store.getChat(chat.id).messages[0], false);
});

test('document import handles invalid files, size limits and unsupported files as inert content', async t => {
  const { store, source, root } = fixture(t);
  await assert.rejects(store.addFile({ sourcePath: root }), /普通文件/);
  const invalid = await store.addFile({ sourcePath: source('broken.json', Buffer.from([0xff, 0, 0xfe, 1])) });
  assert.equal(invalid.textStatus, 'error'); assert.throws(() => store.readFile(invalid.id), /编码/);
  const unsupported = await store.addFile({ sourcePath: source('program.exe', 'MZ inert test fixture') });
  assert.equal(unsupported.textStatus, 'unsupported'); assert.equal(path.extname(store.filePath(unsupported.id)), '.bin');
  const tooBig = source('large.txt', ''); fs.truncateSync(tooBig, 25 * 1024 * 1024 + 1); await assert.rejects(store.addFile({ sourcePath: tooBig }), /25 MB/);
});

test('text decoder supports BOM UTF-16 and reports truncation', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\n段落', 'utf16le')]);
  assert.equal((await extractDocument(utf16, 'text.txt')).text, '中文\n段落');
  const long = await extractDocument(Buffer.from('x'.repeat(MAX_TEXT_CHARS + 100)), 'code.ts');
  assert.equal(long.text.length, MAX_TEXT_CHARS); assert.equal(long.truncated, true);
});

test('DOCX extraction reads paragraph/tab/break entities and ignores external relationships', async () => {
  const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello &amp; 世界</w:t><w:tab/><w:t>&lt;safe&gt;</w:t><w:br/><w:t>&#65;</w:t></w:r></w:p></w:body></w:document>';
  const bytes = Buffer.from(zipSync({ 'word/document.xml': strToU8(document), 'word/_rels/document.xml.rels': strToU8('<Relationship Target="https://example.invalid/never-fetch"/>') }));
  const result = await extractDocument(bytes, 'document.docx');
  assert.equal(result.textStatus, 'ready'); assert.equal(result.text, 'Hello & 世界\t<safe>\nA\n');
  const malicious = Buffer.from(zipSync({ 'word/document.xml': strToU8('<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///private">]><w:t>&x;</w:t>') }));
  assert.equal((await extractDocument(malicious, 'bad.docx')).textStatus, 'error');
  const oversized = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:t>' + 'x'.repeat(8 * 1024 * 1024 + 1) + '</w:t>') }));
  assert.equal((await extractDocument(oversized, 'large.docx')).textStatus, 'error');
});

function minimalPdf() {
  const stream = 'BT /F1 12 Tf 30 100 Td (Hello PDF) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text); text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('PDF extraction parses a real minimal text PDF and rejects broken content', async () => {
  const parsed = await extractDocument(minimalPdf(), 'test.pdf');
  assert.equal(parsed.textStatus, 'ready', parsed.error); assert.match(parsed.text, /Hello PDF/);
  assert.equal((await extractDocument(Buffer.from('%PDF-broken'), 'broken.pdf')).textStatus, 'error');
});
