'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { MAX_FILE_BYTES } = require('../backend/documents.cjs');
const { captureFileExport, exportManagedFile, exportName } = require('../backend/file-export.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../.test-tmp/file-export');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'owned-'));
  t.after(() => {
    const target = fs.realpathSync(directory);
    assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('owned-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { directory, store: new Store(path.join(directory, 'data')) };
}

test('dirty download captures invalid JSON/JSONL without saving or changing the managed file', async t => {
  const { store } = fixture(t), file = await store.createTextFile({ name: 'draft.json', content: '{"before":true}' });
  const before = fs.readFileSync(store.filePath(file.file.id)), state = fs.readFileSync(store.statePath);
  const draft = '\ufeff{"坏":1,}\r\n{"line":2}\r\n😀\ud800';
  const captured = captureFileExport(store, { id: file.file.id, content: draft });
  assert.equal(captured.draft, true);
  assert.deepEqual(captured.bytes, Buffer.from(await new Blob([draft]).arrayBuffer()));
  assert.deepEqual(fs.readFileSync(store.filePath(file.file.id)), before);
  assert.deepEqual(fs.readFileSync(store.statePath), state);
});

test('empty dirty content remains a zero-byte export instead of falling back to the saved text', async t => {
  const { store } = fixture(t), file = await store.createTextFile({ name: 'empty.txt', content: 'saved' });
  assert.equal(captureFileExport(store, { id: file.file.id, content: '' }).bytes.length, 0);
  assert.equal(captureFileExport(store, { id: file.file.id }).bytes.toString(), 'saved');
});

test('clean download rereads actual managed bytes and preserves encoding and line endings', async t => {
  const { store } = fixture(t), file = await store.createTextFile({ name: 'bytes.txt', content: 'preview cache' });
  const source = Buffer.from([0xff, 0xfe, 0x41, 0, 13, 0, 10, 0]);
  fs.writeFileSync(store.filePath(file.file.id), source);
  const result = captureFileExport(store, { id: file.file.id });
  assert.equal(result.draft, false); assert.deepEqual(result.bytes, source);
  assert.equal(store.readFile(file.file.id).text, 'preview cache');
});

test('binary download copies original bytes and refuses renderer-supplied text for a binary file', async t => {
  const { store, directory } = fixture(t), source = path.join(directory, 'original.bin');
  const bytes = Buffer.from([0, 255, 17, 0, 128, 13, 10]); fs.writeFileSync(source, bytes);
  const file = await store.addFile({ sourcePath: source });
  assert.deepEqual(captureFileExport(store, { id: file.id }).bytes, bytes);
  assert.throws(() => captureFileExport(store, { id: file.id, content: 'extracted text' }), /原始副本/);
});

test('cancelled picker leaves the original, state and destination untouched', async t => {
  const { store, directory } = fixture(t), file = await store.createTextFile({ name: 'cancel.md', content: 'before' });
  const state = fs.readFileSync(store.statePath), before = fs.readdirSync(directory);
  let prompts = 0;
  const result = await exportManagedFile({ store, input: { id: file.file.id, content: 'unsaved' }, chooseDestination: async name => { prompts++; assert.equal(name, 'cancel.md'); return { canceled: true }; } });
  assert.deepEqual(result, { cancelled: true }); assert.equal(prompts, 1);
  assert.deepEqual(fs.readFileSync(store.statePath), state); assert.deepEqual(fs.readdirSync(directory), before);
  assert.equal(store.readFile(file.file.id).text, 'before');
});

test('download commits the captured snapshot even if the managed source changes while choosing a location', async t => {
  const { store, directory } = fixture(t), file = await store.createTextFile({ name: 'snapshot.txt', content: 'captured' });
  const target = path.join(directory, 'output.txt'); fs.writeFileSync(target, 'replace after selection');
  const result = await exportManagedFile({ store, input: { id: file.file.id }, chooseDestination: async () => {
    store.saveTextFile({ id: file.file.id, content: 'new managed value', expectedSha256: file.preview.sha256 });
    return { canceled: false, filePath: target };
  } });
  assert.equal(result.cancelled, false); assert.equal(result.size, 8);
  assert.equal(fs.readFileSync(target, 'utf8'), 'captured'); assert.equal(store.readFile(file.file.id).text, 'new managed value');
  assert(!fs.readdirSync(directory).some(name => name.startsWith('.muse-download-')));
});

test('invalid identities, extra paths and accessor fields fail before opening a picker', async t => {
  const { store } = fixture(t); let prompted = 0, invoked = 0;
  const getter = {}; Object.defineProperty(getter, 'id', { enumerable: true, get() { invoked++; return 'file_fake'; } });
  const inherited = Object.create({ get id() { invoked++; return 'file_fake'; } });
  for (const input of [null, [], { id: '../state' }, { id: 'file_missing' }, { id: 'file_fake', path: 'outside' }, { id: 'file_fake', content: null }, getter, inherited, { id: 'file_fake', [Symbol('hidden')]: true }]) {
    await assert.rejects(exportManagedFile({ store, input, chooseDestination: async () => { prompted++; return { canceled: true }; } }));
  }
  assert.equal(prompted, 0); assert.equal(invoked, 0);
});

test('download rejects both oversized draft UTF8 bytes and oversized stored bytes', async t => {
  const { store } = fixture(t), file = await store.createTextFile({ name: 'large.txt', content: 'saved' });
  assert.throws(() => captureFileExport(store, { id: file.file.id, content: '汉'.repeat(Math.floor(MAX_FILE_BYTES / 3) + 1) }), /25 MB/);
  fs.truncateSync(store.filePath(file.file.id), MAX_FILE_BYTES + 1);
  assert.throws(() => captureFileExport(store, { id: file.file.id }), /25 MB/);
});

test('picker cannot overwrite the worktable source, state, directories or a parent junction into data', async t => {
  const { store, directory } = fixture(t), file = await store.createTextFile({ name: 'kept.txt', content: 'saved' });
  for (const target of [store.filePath(file.file.id), store.statePath, directory]) {
    await assert.rejects(exportManagedFile({ store, input: { id: file.file.id, content: 'must not overwrite' }, chooseDestination: async () => ({ filePath: target }) }));
  }
  const linked = path.join(directory, 'linked-data');
  fs.symlinkSync(store.dataDir, linked, 'junction');
  await assert.rejects(exportManagedFile({ store, input: { id: file.file.id }, chooseDestination: async () => ({ filePath: path.join(linked, 'state.json') }) }), /工作台数据目录/);
  assert.equal(store.readFile(file.file.id).text, 'saved');
});

test('clean export stops at the byte cap when a stored file grows after its initial stat', async t => {
  const { store } = fixture(t), file = await store.createTextFile({ name: 'growing.txt', content: 'saved' });
  const source = store.filePath(file.file.id), original = fs.fstatSync;
  let grew = false;
  const patched = t.mock.method(fs, 'fstatSync', function (fd, ...args) {
    const result = original.call(fs, fd, ...args);
    if (!grew) { grew = true; fs.truncateSync(source, MAX_FILE_BYTES + 1); }
    return result;
  });
  try { assert.throws(() => captureFileExport(store, { id: file.file.id }), /25 MB/); assert.equal(grew, true); }
  finally { patched.mock.restore(); }
});

test('write failure preserves the draft source and reports no host paths', async t => {
  const { store, directory } = fixture(t), file = await store.createTextFile({ name: 'failure.txt', content: 'saved' });
  await assert.rejects(exportManagedFile({ store, input: { id: file.file.id, content: 'draft' }, chooseDestination: async () => ({ filePath: path.join(directory, 'missing', 'out.txt') }) }), error => !error.message.includes(directory) && /无法写入下载副本/.test(error.message));
  assert.equal(store.readFile(file.file.id).text, 'saved');
});

test('Windows filename suggestions retain the extension while adapting reserved names', () => {
  assert.equal(exportName('资料.jsonl'), '资料.jsonl'); assert.equal(exportName('CON.txt'), '_CON.txt');
  assert.equal(exportName('隐\u202e藏.txt'), '隐_藏.txt');
});
