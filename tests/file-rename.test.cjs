'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { MAX_FILE_BYTES } = require('../backend/documents.cjs');

function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'file-rename-')), data = path.join(root, 'data'), store = new Store(data);
  t.after(() => { if (path.dirname(root) === parent && path.basename(root).startsWith('file-rename-')) fs.rmSync(root, { recursive: true, force: true }); });
  return { root, data, store, import: async (name, bytes, workspaceId = null) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return store.addFile({ sourcePath: file, workspaceId }); } };
}
const rename = (store, file, name) => store.renameFile({ id: file.id, expectedName: file.name, name });
const journals = data => fs.readdirSync(data).filter(name => name.startsWith('.file-edit-'));

test('rename preserves managed identity, exact BOM/CRLF bytes and original import', async t => {
  const f = fixture(t), bytes = Buffer.from('\ufeffa,b\r\n"c\r\nd",2\r\n'), file = await f.import('source.csv', bytes);
  const renamed = await rename(f.store, file, ' renamed.tsv ');
  assert.equal(renamed.id, file.id); assert.equal(renamed.name, 'renamed.tsv'); assert.equal(renamed.createdAt, file.createdAt); assert.equal(renamed.sha256, file.sha256);
  assert.deepEqual(fs.readFileSync(f.store.filePath(file.id)), bytes); assert.deepEqual(fs.readFileSync(path.join(f.root, 'source.csv')), bytes);
  assert.equal(f.store.readFile(file.id, { preserveCsvSource: true }).text, bytes.toString('utf8'));
  assert.equal(f.store.readFile(file.id).text, 'a,b\n"c\nd",2\n'); assert.deepEqual(journals(f.data), []);
  assert.equal(new Store(f.data).getFile(file.id).name, 'renamed.tsv');
});

test('extension rename refreshes MIME, preview eligibility and managed suffix without converting bytes', async t => {
  const f = fixture(t), created = await f.store.createTextFile({ name: 'plain.txt', content: '{"a":1}' }), id = created.file.id;
  const oldPath = f.store.filePath(id), json = await rename(f.store, created.file, 'structure.json');
  assert.equal(json.mime, 'application/json'); assert.equal(path.extname(f.store.filePath(id)), '.json'); assert.equal(fs.existsSync(oldPath), false);
  const binary = await rename(f.store, json, 'original.bin'); assert.equal(binary.textStatus, 'unsupported'); assert.throws(() => f.store.readFile(id), /不支持/);
  const text = await rename(f.store, binary, 'restored.md'); assert.equal(text.textStatus, 'ready'); assert.equal(text.mime, 'text/markdown'); assert.equal(f.store.readFile(id).text, '{"a":1}');
  assert.equal(fs.readFileSync(f.store.filePath(id), 'utf8'), '{"a":1}'); assert.deepEqual(journals(f.data), []);
});

test('invalid text disguised by a new extension remains inert with a readable extraction error', async t => {
  const f = fixture(t), file = await f.import('opaque.bin', Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
  const result = await rename(f.store, file, 'opaque.txt'); assert.equal(result.textStatus, 'error'); assert.throws(() => f.store.readFile(file.id));
  assert.deepEqual(fs.readFileSync(f.store.filePath(file.id)), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
});

test('rename accepts read-only files larger than the edit limit and preserves the full source', async t => {
  const f = fixture(t), bytes = Buffer.alloc(2 * 1024 * 1024, 65), file = await f.import('long.txt', bytes);
  const result = await rename(f.store, file, 'long.md'); assert.equal(result.size, bytes.length);
  assert.equal(f.store.readFile(file.id).editable, false); assert.equal(f.store.readFile(file.id).truncated, true);
  assert.deepEqual(fs.readFileSync(f.store.filePath(file.id)), bytes);
});

test('collision is scoped, Unicode-normalized and case insensitive, with no overwrite', async t => {
  const f = fixture(t), a = f.store.createWorkspace({ name: 'A' }), b = f.store.createWorkspace({ name: 'B' });
  const first = (await f.store.createTextFile({ workspaceId: a.id, name: 'first.md', content: 'A' })).file;
  const other = (await f.store.createTextFile({ workspaceId: a.id, name: 'Café.md', content: 'B' })).file;
  await assert.rejects(rename(f.store, first, 'CAFE\u0301.MD'), /同名/);
  assert.equal(f.store.getFile(first.id).name, 'first.md'); assert.equal(f.store.readFile(other.id).text, 'B');
  const outside = (await f.store.createTextFile({ workspaceId: b.id, name: 'outside.md', content: 'C' })).file;
  assert.equal((await rename(f.store, outside, 'Café.md')).name, 'Café.md');
  assert.equal((await rename(f.store, first, 'FIRST.MD')).name, 'FIRST.MD');
});

test('invalid basenames, reserved names, paths, unknown fields and stale dialogs do not mutate files', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'valid.txt', content: 'keep' })).file;
  for (const name of ['', '..', '../outside.txt', 'x\\y.txt', 'C:\\bad.txt', 'CON.txt', 'COM¹.txt', 'trailing.', 'a\u202eb.txt', 'a\ud800.txt', 'x'.repeat(241)]) await assert.rejects(rename(f.store, file, name));
  await assert.rejects(f.store.renameFile({ id: file.id, name: 'safe.txt' }), /文件名/);
  await assert.rejects(f.store.renameFile({ id: file.id, expectedName: file.name, name: 'safe.txt', destination: '../escape' }), /不支持/);
  const next = await rename(f.store, file, 'safe.txt'); await assert.rejects(rename(f.store, file, 'stale.txt'), /已变化/);
  assert.equal(f.store.getFile(file.id).name, next.name); assert.equal(f.store.readFile(file.id).text, 'keep'); assert.deepEqual(journals(f.data), []);
});

test('a no-op rename does not rewrite metadata, source or recovery journals', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'stable.md', content: 'unchanged' })).file;
  const state = fs.readFileSync(f.store.statePath), bytes = fs.readFileSync(f.store.filePath(file.id));
  assert.deepEqual(await rename(f.store, file, ' stable.md '), file);
  assert.deepEqual(fs.readFileSync(f.store.statePath), state); assert.deepEqual(fs.readFileSync(f.store.filePath(file.id)), bytes); assert.deepEqual(journals(f.data), []);
});

test('stale editor name cannot save after a format-changing rename with identical content hash', async t => {
  const f = fixture(t), created = await f.store.createTextFile({ name: 'before.txt', content: '{}' });
  const changed = await rename(f.store, created.file, 'after.json');
  assert.throws(() => f.store.saveTextFile({ id: changed.id, content: 'stale draft', expectedSha256: created.preview.sha256, expectedName: 'before.txt' }), /文件名已变化/);
  assert.equal(f.store.readFile(changed.id).text, '{}');
  assert.equal(f.store.saveTextFile({ id: changed.id, content: '{"ok":true}', expectedSha256: changed.sha256, expectedName: changed.name }).preview.text, '{"ok":true}');
});

test('concurrent content save wins over an extraction-pending rename', async t => {
  const f = fixture(t), created = await f.store.createTextFile({ name: 'pending.txt', content: 'before' });
  const pending = rename(f.store, created.file, 'pending.md');
  f.store.saveTextFile({ id: created.file.id, content: 'newer', expectedSha256: created.preview.sha256 });
  await assert.rejects(pending, /已发生变化/); assert.equal(f.store.getFile(created.file.id).name, 'pending.txt'); assert.equal(f.store.readFile(created.file.id).text, 'newer');
});

test('concurrent deletion cannot resurrect a file from a pending rename', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'deleted.txt', content: 'before' })).file;
  const pending = rename(f.store, file, 'deleted.md'); f.store.removeFile(file.id);
  await assert.rejects(pending, /不存在/); assert.deepEqual(f.store.snapshot().files, []); assert.deepEqual(journals(f.data), []);
});

test('the second overlapping rename cannot overwrite the first committed decision', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'one.txt', content: 'same' })).file;
  const results = await Promise.allSettled([rename(f.store, file, 'two.md'), rename(f.store, file, 'three.json')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.store.getFile(file.id).name, 'two.md');
  assert.equal(f.store.readFile(file.id).text, 'same'); assert.deepEqual(journals(f.data), []);
});

test('out-of-band source changes and managed destination collisions are preserved and rejected', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'source.txt', content: 'original' })).file;
  const target = f.store._managedPath(`${file.id}.md`); fs.writeFileSync(target, 'orphan must survive');
  await assert.rejects(rename(f.store, file, 'source.md'), /存储位置/); assert.equal(fs.readFileSync(target, 'utf8'), 'orphan must survive');
  fs.writeFileSync(f.store.filePath(file.id), 'changed outside'); await assert.rejects(rename(f.store, file, 'other.txt'), /内容已发生变化/);
  assert.equal(f.store.getFile(file.id).name, file.name); assert.equal(fs.readFileSync(f.store.filePath(file.id), 'utf8'), 'changed outside');
});

test('a source growing after stat is bounded during rename rather than fully allocated', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'growth.txt', content: 'ok' })).file, source = f.store.filePath(file.id);
  const original = fs.readSync; let grown = false;
  fs.readSync = (...args) => { if (!grown) { grown = true; fs.appendFileSync(source, Buffer.alloc(MAX_FILE_BYTES)); } return original(...args); };
  try { await assert.rejects(rename(f.store, file, 'growth.md'), /25 MB/); } finally { fs.readSync = original; }
  assert.equal(grown, true); assert.equal(f.store.getFile(file.id).name, file.name); assert.deepEqual(journals(f.data), []);
});

test('failed cache replacement rolls back both suffix movement and metadata', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'rollback.txt', content: 'before' })).file, oldPath = f.store.filePath(file.id);
  const original = f.store._replaceManagedBytes; let failed = false;
  f.store._replaceManagedBytes = function (name, bytes) { if (!failed) { failed = true; throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); } return original.call(this, name, bytes); };
  try { await assert.rejects(rename(f.store, file, 'rollback.md'), /原文件已恢复/); } finally { f.store._replaceManagedBytes = original; }
  assert.equal(f.store.getFile(file.id).name, file.name); assert.equal(f.store.filePath(file.id), oldPath); assert.equal(fs.readFileSync(oldPath, 'utf8'), 'before'); assert.deepEqual(journals(f.data), []);
});

test('a preview cache growing during rename is bounded before any source movement', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'cache.txt', content: 'keep' })).file;
  const cache = f.store._managedPath(f.store._file(file.id)._textName), open = fs.openSync, read = fs.readSync;
  let selected, grown = false;
  fs.openSync = (filename, ...args) => { const fd = open(filename, ...args); if (filename === cache && args[0] === 'r') selected = fd; return fd; };
  fs.readSync = (fd, ...args) => { if (fd === selected && !grown) { grown = true; fs.appendFileSync(cache, Buffer.alloc(1024 * 1024)); } return read(fd, ...args); };
  try { await assert.rejects(rename(f.store, file, 'cache.md'), /预览缓存/); } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(grown, true); assert.equal(f.store.getFile(file.id).name, file.name); assert.equal(path.extname(f.store.filePath(file.id)), '.txt'); assert.deepEqual(journals(f.data), []);
});

test('prepared rename recovers the old filename, source and cache after process interruption', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'crash.txt', content: 'before' })).file;
  const persist = f.store._persistState, restore = f.store._restoreFileEdit;
  f.store._persistState = () => { throw new Error('fixture termination before metadata'); };
  f.store._restoreFileEdit = function (directory, journal, side) { if (side === 'before') throw new Error('fixture termination before rollback'); return restore.call(this, directory, journal, side); };
  try { await assert.rejects(rename(f.store, file, 'crash.bin'), /恢复数据已保留/); } finally { f.store._persistState = persist; f.store._restoreFileEdit = restore; }
  assert.equal(journals(f.data).length, 1); const restarted = new Store(f.data);
  assert.equal(restarted.getFile(file.id).name, 'crash.txt'); assert.equal(restarted.readFile(file.id).text, 'before'); assert.equal(path.extname(restarted.filePath(file.id)), '.txt'); assert.deepEqual(journals(f.data), []);
});

test('committed rename restores its new name even from an older metadata backup', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'committed.txt', content: 'persist' })).file, persist = f.store._persistState; let writes = 0;
  f.store._persistState = function (state, options) { if (++writes === 2) throw new Error('fixture backup interruption'); return persist.call(this, state, options); };
  let result; try { result = await rename(f.store, file, 'committed.md'); } finally { f.store._persistState = persist; }
  assert.equal(journals(f.data).length, 1); fs.writeFileSync(f.store.statePath, '{broken primary');
  const restarted = new Store(f.data); assert.deepEqual(restarted.getFile(file.id), result); assert.equal(restarted.readFile(file.id).text, 'persist'); assert.deepEqual(journals(f.data), []);
  fs.writeFileSync(restarted.statePath, '{broken again'); assert.equal(new Store(f.data).getFile(file.id).name, 'committed.md');
});

test('stale rename journal cannot roll back a newer edit or resurrect a deleted file', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'later.txt', content: 'before' })).file, cleanup = f.store._cleanupFileEdit;
  f.store._cleanupFileEdit = () => { throw new Error('deferred cleanup'); };
  const renamed = await rename(f.store, file, 'later.md');
  f.store._cleanupFileEdit = cleanup;
  f.store.saveTextFile({ id: file.id, content: 'newer', expectedSha256: renamed.sha256, expectedName: renamed.name });
  let restarted = new Store(f.data); assert.equal(restarted.getFile(file.id).name, 'later.md'); assert.equal(restarted.readFile(file.id).text, 'newer');
  restarted._cleanupFileEdit = () => { throw new Error('deferred cleanup'); }; await rename(restarted, restarted.getFile(file.id), 'deleted.txt'); restarted._cleanupFileEdit = cleanup;
  restarted.removeFile(file.id); restarted = new Store(f.data); assert.deepEqual(restarted.snapshot().files, []); assert.deepEqual(journals(f.data), []);
});

test('recovery refuses to overwrite source bytes that changed after an interrupted rename', async t => {
  const f = fixture(t), file = (await f.store.createTextFile({ name: 'tamper.txt', content: 'before' })).file;
  const persist = f.store._persistState, restore = f.store._restoreFileEdit;
  f.store._persistState = () => { throw new Error('fixture termination'); };
  f.store._restoreFileEdit = function (dir, journal, side) { if (side === 'before') throw new Error('fixture termination'); return restore.call(this, dir, journal, side); };
  try { await assert.rejects(rename(f.store, file, 'tamper.md'), /恢复数据已保留/); } finally { f.store._persistState = persist; f.store._restoreFileEdit = restore; }
  const destination = f.store._managedPath(`${file.id}.md`); fs.writeFileSync(destination, 'external change');
  assert.throws(() => new Store(f.data), /内容已变化/); assert.equal(fs.readFileSync(destination, 'utf8'), 'external change'); assert.equal(journals(f.data).length, 1);
});

test('chat attachment IDs and current context survive rename and backup remapping', async t => {
  const f = fixture(t), w = f.store.createWorkspace({ name: 'refs' }), file = (await f.store.createTextFile({ workspaceId: w.id, name: 'before.md', content: 'context' })).file;
  const chat = f.store.createChat({ workspaceId: w.id }); f.store.appendMessage(chat.id, { role: 'user', content: 'reference', attachmentIds: [file.id] });
  await rename(f.store, file, 'after.txt'); assert.deepEqual(f.store.getChat(chat.id).messages[0].attachmentIds, [file.id]);
  assert.equal(f.store.contextDocuments(chat.id)[0].name, 'after.txt');
  const restored = new Store(path.join(f.root, 'imported')); await restored.importData(f.store.exportData());
  const restoredFile = restored.snapshot().files[0]; assert.notEqual(restoredFile.id, file.id); assert.equal(restoredFile.name, 'after.txt');
  assert.equal(restored.contextDocuments(restored.snapshot().chats[0].id)[0].text, 'context');
});
