'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../backend/store.cjs');
const { sourceDigest, pagesDigest, validateArtifactFiles, validateArtifactData, MAX_ARTIFACT_DATA_VALUE_BYTES, MAX_ARTIFACT_BINARY_BYTES } = require('../backend/artifact-model.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'artifact-store-')), dataDir = path.join(root, 'data');
  t.after(() => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^artifact-store-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, store: new Store(dataDir) };
}
const create = (store, extra = {}) => store.createArtifact({ name: '测试 Space', runtime: 'html', ...extra });
function build(store, id, suffix = '') {
  const snapshot = store.artifactSourceSnapshot(id), pages = [{ path: snapshot.runtime === 'react' ? 'index.html' : snapshot.entryPath, html: `<!doctype html><html><body>Built ${suffix}</body></html>` }];
  return { id: `build_${crypto.randomUUID()}`, sourceRevision: snapshot.sourceRevision, createdAt: new Date().toISOString(), pages, sha256: pagesDigest(pages), sourceDigest: sourceDigest(snapshot), builderVersion: '1' };
}
const commit = (store, artifact, suffix) => store.commitArtifactBuild({ id: artifact.id, sourceRevision: artifact.sourceRevision, build: build(store, artifact.id, suffix) });

test('schema-v1 states and backups without artifacts restore and merge compatibly', async t => {
  const { store, dataDir } = fixture(t); store.createChat({ title: 'old chat' });
  const legacy = JSON.parse(fs.readFileSync(store.statePath, 'utf8')); delete legacy.artifacts; fs.writeFileSync(store.statePath, JSON.stringify(legacy));
  const restarted = new Store(dataDir); assert.deepEqual(restarted.snapshot().artifacts, []); assert.equal(restarted.snapshot().chats.length, 1);
  const backup = restarted.exportData(); delete backup.artifacts; await restarted.importData(backup);
  assert.equal(restarted.snapshot().chats.length, 2); assert.deepEqual(restarted.snapshot().artifacts, []);
});

test('HTML and React starters expose only detached public metadata in snapshots', t => {
  const { store, dataDir } = fixture(t), workspace = store.createWorkspace({ name: 'apps' });
  const html = create(store, { workspaceId: workspace.id }), react = create(store, { name: 'React 应用', runtime: 'react' });
  assert.equal(html.sourceRevision, 1); assert.equal(html.entryPath, 'index.html'); assert.equal(html.workspaceId, workspace.id); assert.equal(html.dataVersion, 0);
  assert.equal(react.entryPath, 'src/main.tsx'); assert.equal(react.workspaceId, null); assert.equal(react.files.length, 2);
  for (const artifact of store.snapshot().artifacts) { assert.equal(Object.hasOwn(artifact, 'data'), false); for (const file of artifact.files) { assert.equal(Object.hasOwn(file, 'text'), false); assert.equal(Object.hasOwn(file, 'dataBase64'), false); assert.match(file.sha256, /^[a-f0-9]{64}$/); } }
  const source = store.artifactSourceSnapshot(html.id); assert.match(source.files[0].text, /increment/); source.files[0].text = 'mutated caller copy';
  html.files[0].path = 'mutated public copy'; assert.equal(store.getArtifact(html.id).files[0].path, 'index.html'); assert.match(store.readArtifactFile({ id: html.id, path: 'index.html' }).text, /increment/);
  assert.deepEqual(new Store(dataDir).snapshot().artifacts, store.snapshot().artifacts);
});

test('logical source updates are atomic and source revision CAS rejects stale editors', t => {
  const { store } = fixture(t), artifact = create(store);
  const next = store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: 'pages/start.html', text: '<h1>next</h1>\r\n' }, { path: 'asset.bin', dataBase64: 'AAH/' }], deletePaths: ['index.html'], entryPath: 'pages/start.html' });
  assert.equal(next.sourceRevision, 2); assert.equal(next.entryPath, 'pages/start.html');
  assert.deepEqual(store.readArtifactFile({ id: artifact.id, path: 'asset.bin' }), { path: 'asset.bin', dataBase64: 'AAH/', size: 3, sha256: hash(Buffer.from('AAH/', 'base64')), editable: false });
  assert.equal(store.readArtifactFile({ id: artifact.id, path: next.entryPath }).text, '<h1>next</h1>\r\n');
  const before = store.artifactSourceSnapshot(artifact.id);
  assert.throws(() => store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: next.entryPath, text: 'stale' }] }), /重新载入/);
  assert.throws(() => store.writeArtifactFiles({ id: artifact.id, expectedRevision: 2, files: [{ path: 'temporary.txt', text: 'must not stick' }], deletePaths: [next.entryPath] }), /入口/);
  assert.deepEqual(store.artifactSourceSnapshot(artifact.id), before);
});

test('paths reject traversal, absolute hosts, controls, reserved names and case/directory conflicts', t => {
  const { store } = fixture(t), artifact = create(store), before = store.artifactSourceSnapshot(artifact.id);
  for (const value of ['../escape.js', '/absolute.js', 'C:/host.js', 'a\\host.js', 'a//b.js', './index.html', 'a/../b.js', 'con.js', 'AUX/file.js', 'folder/LPT9.md', 'trailing./a', 'trailing /a', 'colon:a', 'percent%2f.js', 'bad\u0001.js', 'nul.txt', 'a/COM¹.js', 'e\u0301.js']) {
    assert.throws(() => store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: value, text: '' }] }), value);
  }
  for (const files of [[{ path: 'INDEX.html', text: '' }], [{ path: 'a', text: '' }, { path: 'a/b.js', text: '' }], [{ path: 'a.js', text: '' }, { path: 'A.js', text: '' }]]) assert.throws(() => store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files }));
  assert.deepEqual(store.artifactSourceSnapshot(artifact.id), before);
});

test('source validation bounds bytes, file counts, canonical base64 and strict JSON fields', t => {
  fixture(t);
  for (const files of [new Array(1), Array.from({ length: 201 }, (_, i) => ({ path: `${i}.txt`, text: '' })), [{ path: 'a', text: '界'.repeat(400000) }], [{ path: 'b', dataBase64: Buffer.alloc(MAX_ARTIFACT_BINARY_BYTES + 1).toString('base64') }], [{ path: 'b', dataBase64: 'AB==' }], [{ path: 'b', dataBase64: '@@@@' }], [{ path: 'x', text: '', dataBase64: '' }], [{ path: 'x', text: '', _hostPath: '/private' }], [{ path: 'x', text: '\ud800' }]]) assert.throws(() => validateArtifactFiles(files));
  assert.throws(() => validateArtifactFiles([{ path: 'a', dataBase64: Buffer.alloc(MAX_ARTIFACT_BINARY_BYTES).toString('base64') }, { path: 'b', dataBase64: Buffer.alloc(MAX_ARTIFACT_BINARY_BYTES).toString('base64') }]), /5 MiB/);
  let invoked = false; const getter = { path: 'a', get text() { invoked = true; return ''; } }; assert.throws(() => validateArtifactFiles([getter])); assert.equal(invoked, false);
});

test('source limits apply to the merged virtual filesystem rather than only the incoming batch', t => {
  const { store } = fixture(t), artifact = create(store);
  const next = store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: Array.from({ length: 199 }, (_, index) => ({ path: `file-${index}.txt`, text: '' })) });
  assert.equal(next.files.length, 200);
  assert.throws(() => store.writeArtifactFiles({ id: artifact.id, expectedRevision: 2, files: [{ path: 'overflow.txt', text: '' }] }), /数量/);
  assert.equal(store.getArtifact(artifact.id).sourceRevision, 2); assert.equal(store.getArtifact(artifact.id).files.length, 200);
});

test('builds are immutable, hashed, revision-bound and retain only the last three successes', t => {
  const { store } = fixture(t), artifact = create(store), ids = [];
  for (let i = 0; i < 4; i++) { const result = commit(store, artifact, i); ids.push(result.builds.at(-1).id); }
  assert.deepEqual(store.getArtifact(artifact.id).builds.map(item => item.id), ids.slice(-3)); assert.throws(() => store.readArtifactBuild({ id: artifact.id, buildId: ids[0] }));
  const latest = store.readArtifactBuild({ id: artifact.id }); assert.equal(latest.id, ids.at(-1)); latest.pages[0].html = 'observer mutation'; assert.notEqual(store.readArtifactBuild({ id: artifact.id }).pages[0].html, latest.pages[0].html);
  assert.equal(Object.hasOwn(store.getArtifact(artifact.id).builds[0].pages[0], 'html'), false);
  assert.throws(() => store.commitArtifactBuild({ id: artifact.id, sourceRevision: 1, build: store.readArtifactBuild({ id: artifact.id }) }), /不可变/);
  const corrupt = build(store, artifact.id); corrupt.pages[0].html += 'tamper'; assert.throws(() => store.commitArtifactBuild({ id: artifact.id, sourceRevision: 1, build: corrupt }), /校验/);
  const inFlight = build(store, artifact.id); store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: 'notes.md', text: 'new source' }] });
  assert.throws(() => store.commitArtifactBuild({ id: artifact.id, sourceRevision: 1, build: inFlight }), /源码已变化/);
  assert.equal(store.readArtifactBuild({ id: artifact.id }).id, ids.at(-1));
});

test('real HTML and React source snapshots build and commit with the shared source digest contract', async t => {
  const { buildArtifact } = require('../backend/artifact-builder.cjs'), { store, dataDir } = fixture(t);
  for (const runtime of ['html', 'react']) {
    const artifact = create(store, { runtime }), snapshot = store.artifactSourceSnapshot(artifact.id), compiled = await buildArtifact(snapshot);
    const saved = store.commitArtifactBuild({ id: artifact.id, sourceRevision: snapshot.sourceRevision, build: compiled });
    assert.equal(saved.builds.at(-1).sourceDigest, sourceDigest(snapshot)); assert.equal(saved.builds.at(-1).sha256, compiled.sha256);
    assert.match(store.readArtifactBuild({ id: artifact.id }).pages[0].html, /<script>/); assert.equal(JSON.stringify(saved).includes('<script>'), false);
  }
  assert.deepEqual(new Store(dataDir).snapshot().artifacts, store.snapshot().artifacts);
});

test('data is artifact-scoped, detached and protected by a separate version CAS', t => {
  const { store, dataDir } = fixture(t), a = create(store), b = create(store);
  assert.deepEqual(store.artifactDataGet({ id: a.id, key: 'count' }), { key: 'count', found: false, version: 0 });
  const original = { count: 2, list: ['hello'] }, result = store.artifactDataSet({ id: a.id, key: 'prefs', value: original, expectedVersion: 0 }); original.count = 8; result.value.count = 9;
  assert.equal(store.artifactDataGet({ id: a.id, key: 'prefs' }).value.count, 2); assert.equal(store.artifactDataGet({ id: b.id, key: 'prefs' }).found, false);
  assert.equal(store.getArtifact(a.id).sourceRevision, 1); assert.equal(store.getArtifact(a.id).dataVersion, 1);
  assert.throws(() => store.artifactDataSet({ id: a.id, key: 'prefs', value: {}, expectedVersion: 0 }), /数据已变化/);
  assert.deepEqual(store.artifactDataList({ id: a.id, prefix: 'pr' }), { version: 1, items: [{ key: 'prefs', value: { count: 2, list: ['hello'] } }] });
  assert.equal(JSON.stringify(store.snapshot()).includes('hello'), false);
  assert.deepEqual(new Store(dataDir).artifactDataGet({ id: a.id, key: 'prefs' }), store.artifactDataGet({ id: a.id, key: 'prefs' }));
  assert.deepEqual(store.artifactDataDelete({ id: a.id, key: 'prefs', expectedVersion: 1 }), { version: 2, deleted: true });
  assert.deepEqual(store.artifactDataDelete({ id: a.id, key: 'absent', expectedVersion: 2 }), { version: 3, deleted: false });
});

test('data limits reject unsafe keys, non-JSON values, getters, oversized values and aggregate budgets', t => {
  const { store } = fixture(t), artifact = create(store);
  for (const key of ['', '__proto__', 'constructor', 'prototype', 'a\0b', 'x'.repeat(257)]) assert.throws(() => store.artifactDataSet({ id: artifact.id, key, value: 1, expectedVersion: 0 }));
  for (const value of [undefined, Infinity, NaN, 1n, new Date(), { a: undefined }, JSON.parse('{"__proto__":{"polluted":true}}'), 'x'.repeat(MAX_ARTIFACT_DATA_VALUE_BYTES)]) assert.throws(() => store.artifactDataSet({ id: artifact.id, key: 'value', value, expectedVersion: 0 }));
  let invoked = false; assert.throws(() => store.artifactDataSet({ id: artifact.id, key: 'getter', value: { get token() { invoked = true; return 'no'; } }, expectedVersion: 0 })); assert.equal(invoked, false);
  const keys = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`key${i}`, 1])); assert.throws(() => validateArtifactData({ version: 0, values: keys }), /4096/);
  const large = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`key${i}`, 'x'.repeat(250000)])); assert.throws(() => validateArtifactData({ version: 0, values: large }), /5 MiB/);
  assert.equal(store.getArtifact(artifact.id).dataVersion, 0); assert.equal({}.polluted, undefined);
});

test('workspace deletion detaches artifacts and artifact deletion scrubs source/data from recovery copies', t => {
  const { store } = fixture(t), workspace = store.createWorkspace({ name: 'apps' }), artifact = create(store, { workspaceId: workspace.id });
  store.artifactDataSet({ id: artifact.id, key: 'unique', value: 'ARTIFACT_DELETE_SENTINEL', expectedVersion: 0 }); commit(store, artifact, 'keep');
  store.deleteWorkspace(workspace.id); assert.equal(store.getArtifact(artifact.id).workspaceId, null); assert.equal(store.readArtifactBuild({ id: artifact.id }).pages.length, 1);
  store.deleteArtifact(artifact.id); assert.deepEqual(store.snapshot().artifacts, []); assert.throws(() => store.getArtifact(artifact.id));
  for (const p of [store.statePath, store.backupPath]) assert.equal(fs.readFileSync(p, 'utf8').includes('ARTIFACT_DELETE_SENTINEL'), false);
});

test('backup roundtrip preserves source, latest build and data while remapping artifact/build/workspace ids', async t => {
  const a = fixture(t), b = fixture(t), workspace = a.store.createWorkspace({ name: 'Space 资料' }), artifact = create(a.store, { workspaceId: workspace.id });
  a.store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: 'icon.bin', dataBase64: 'AAH/' }] });
  const current = a.store.getArtifact(artifact.id); commit(a.store, current, 'one'); commit(a.store, current, 'two');
  a.store.artifactDataSet({ id: artifact.id, key: 'state', value: { counter: 17 }, expectedVersion: 0 });
  const backup = a.store.exportData(); assert.equal(backup.artifacts[0].builds.length, 1); assert.equal(JSON.stringify(backup).includes(a.dataDir), false);
  const existing = create(b.store, { name: 'keep existing' }), imported = await b.store.importData(backup); assert.equal(imported.artifacts.length, 2); assert.ok(imported.artifacts.some(item => item.id === existing.id));
  const restored = imported.artifacts.find(item => item.id !== existing.id); assert.notEqual(restored.id, artifact.id); assert.notEqual(restored.workspaceId, workspace.id); assert.notEqual(restored.builds[0].id, current.builds[0]?.id); assert.notEqual(restored.builds[0].id, backup.artifacts[0].builds[0].id);
  assert.equal(restored.workspaceId, imported.workspaces[0].id); assert.equal(restored.sourceRevision, 2);
  assert.deepEqual(b.store.artifactDataGet({ id: restored.id, key: 'state' }).value, { counter: 17 });
  assert.equal(b.store.readArtifactFile({ id: restored.id, path: 'icon.bin' }).dataBase64, 'AAH/'); assert.equal(b.store.readArtifactBuild({ id: restored.id }).sha256, backup.artifacts[0].builds[0].sha256);
  assert.deepEqual(new Store(b.dataDir).snapshot(), b.store.snapshot());
});

test('artifact backup validation rejects unknown fields, forged relations, source/build corruption and invalid data atomically', async t => {
  const { store } = fixture(t), artifact = create(store); commit(store, artifact, 'valid'); const clean = store.exportData(), baseline = store.snapshot();
  const variants = [data => { data.artifacts = null; }, data => { data.artifacts[0]._sourcePath = '/host'; }, data => { data.artifacts[0].workspaceId = 'missing'; }, data => { data.artifacts[0].files[0].path = '../escape.html'; }, data => { data.artifacts[0].builds[0].pages[0].html = 'tampered'; }, data => { data.artifacts[0].builds[0].sourceDigest = '0'.repeat(64); }, data => { data.artifacts[0].data.values = JSON.parse('{"__proto__":1}'); }];
  for (const change of variants) { const data = structuredClone(clean); change(data); await assert.rejects(store.importData(data)); assert.deepEqual(store.snapshot(), baseline); }
});

test('persistence failures leave artifact source, build and data unchanged without partial imports', async t => {
  const a = fixture(t), b = fixture(t), artifact = create(a.store), snapshot = a.store.artifactSourceSnapshot(artifact.id), before = a.store.snapshot(), persist = a.store._persistState;
  a.store._persistState = () => { throw Error('synthetic persistence failure'); };
  try {
    assert.throws(() => a.store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: 'new.txt', text: 'not committed' }] }), /synthetic/);
    assert.throws(() => commit(a.store, artifact, 'not committed'), /synthetic/);
    assert.throws(() => a.store.artifactDataSet({ id: artifact.id, key: 'draft', value: true, expectedVersion: 0 }), /synthetic/);
  } finally { a.store._persistState = persist; }
  assert.deepEqual(a.store.snapshot(), before); assert.deepEqual(a.store.artifactSourceSnapshot(artifact.id), snapshot);
  await b.store.createTextFile({ name: 'import.txt', content: 'temporary managed import' }); create(b.store); const data = b.store.exportData();
  const originalFiles = fs.readdirSync(a.store.attachmentsDir); a.store._persistState = () => { throw Error('synthetic import failure'); };
  try { await assert.rejects(a.store.importData(data), /synthetic import failure/); } finally { a.store._persistState = persist; }
  assert.deepEqual(a.store.snapshot(), before); assert.deepEqual(fs.readdirSync(a.store.attachmentsDir), originalFiles); assert.deepEqual(new Store(a.dataDir).snapshot(), before);
});
