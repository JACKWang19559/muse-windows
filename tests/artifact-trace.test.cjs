'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { remapToolTrace, traceHistory } = require('../backend/tool-trace.cjs');
const { sourceDigest, pagesDigest } = require('../backend/artifact-model.cjs');

const receipt = result => JSON.stringify({ ok: true, result });
const completed = (id, name, args, result) => ({ id, name, arguments: JSON.stringify(args), status: 'complete', result: receipt(result) });
function fixture(t, label) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, `artifact-trace-${label}-`));
  t.after(() => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^artifact-trace-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { store: new Store(directory), directory };
}
function commit(store, artifact, id = 'original_build') {
  const source = store.artifactSourceSnapshot(artifact.id), pages = [{ path: 'index.html', html: `<!doctype html><h1>${artifact.name}</h1>` }];
  const build = { id, sourceRevision: source.sourceRevision, createdAt: new Date().toISOString(), pages, sha256: pagesDigest(pages), sourceDigest: sourceDigest(source), builderVersion: '1' };
  store.commitArtifactBuild({ id: artifact.id, sourceRevision: source.sourceRevision, build }); return build;
}

test('artifact receipt remapping changes only known identity slots, never source, names, arbitrary data, or call pairing', () => {
  const ids = { artifactIds: new Map([['old_app', 'new_app']]), workspaceIds: new Map([['old_ws', 'new_ws']]), buildIds: new Map([['old_build', 'new_build']]) };
  const app = { id: 'old_app', name: 'old_app', workspaceId: 'old_ws', builds: [{ id: 'old_build', name: 'old_build' }], data: { id: 'old_app', buildId: 'old_build', workspaceId: 'old_ws' } };
  const source = [{ content: 'literal old_app old_build old_ws', calls: [
    completed('list', 'muse_list_apps', {}, { apps: [app, { id: 'unmapped', workspaceId: null, builds: [{ id: 'unmapped_build' }] }] }),
    completed('read', 'muse_read_app', { id: 'old_app', path: 'old_app/index.html' }, { app, file: { text: 'old_app old_build old_ws', id: 'old_app', path: 'old_app/index.html' } }),
    completed('create', 'muse_create_app', { name: 'old_app', runtime: 'html' }, { app }),
    completed('write', 'muse_write_app', { id: 'old_app', expectedRevision: 1, files: [{ path: 'index.html', text: '{"id":"old_app","buildId":"old_build"}' }] }, { app }),
    completed('build', 'muse_build_app', { id: 'old_app', expectedRevision: 2 }, { app, buildId: 'old_build' }),
    completed('unknown', 'muse_other_app', { id: 'old_app' }, { app, apps: [app], buildId: 'old_build' })
  ] }];
  const original = structuredClone(source), mapped = remapToolTrace(source, ids), calls = mapped[0].calls;
  const expectedApp = { ...app, id: 'new_app', workspaceId: 'new_ws', builds: [{ id: 'new_build', name: 'old_build' }] };
  assert.deepEqual(JSON.parse(calls[0].result).result.apps, [expectedApp, { id: 'unmapped', workspaceId: null, builds: [{ id: 'unmapped_build' }] }]);
  assert.deepEqual(JSON.parse(calls[1].arguments), { id: 'new_app', path: 'old_app/index.html' });
  assert.deepEqual(JSON.parse(calls[1].result).result.file, JSON.parse(original[0].calls[1].result).result.file);
  assert.equal(calls[2].arguments, original[0].calls[2].arguments);
  assert.deepEqual(JSON.parse(calls[3].arguments), { ...JSON.parse(original[0].calls[3].arguments), id: 'new_app' });
  assert.deepEqual(JSON.parse(calls[4].result).result, { app: expectedApp, buildId: 'new_build' });
  assert.deepEqual(calls[5], original[0].calls[5]); assert.equal(mapped[0].content, original[0].content); assert.deepEqual(source, original);
  assert.deepEqual(calls.map(call => call.id), original[0].calls.map(call => call.id));
  assert.deepEqual(traceHistory(mapped).slice(1).map(message => message.tool_call_id), calls.map(call => call.id));
});

test('unknown, malformed, failed, and unmapped artifact history remains opaque; old Map arguments stay compatible', () => {
  const source = [{ content: '', calls: [
    { ...completed('a', 'muse_read_app', { id: 'missing' }, { app: { id: 'missing', workspaceId: null } }), arguments: 'not json' },
    { ...completed('b', 'muse_build_app', { id: 'missing' }, {}), result: 'not json' },
    { id: 'c', name: 'muse_read_app', arguments: '{"id":"missing"}', status: 'error', result: '{"ok":false,"error":{"id":"old_app","message":"old_build"}}' }
  ] }];
  assert.deepEqual(remapToolTrace(source, { artifactIds: new Map([['old_app', 'new']]), buildIds: new Map([['old_build', 'new_build']]) }), source);
  assert.deepEqual(remapToolTrace(source, { fileIds: new Map(), workspaceIds: new Map() }), source);
  assert.throws(() => remapToolTrace(source, { artifactIds: {} })); assert.throws(() => remapToolTrace(source, { buildIds: new Proxy(new Map(), {}) }));
});

test('actual Store backup merge maps artifact/build/workspace identities to imported objects while preserving literal source/data/history', async t => {
  const { store, directory } = fixture(t, 'merge'), workspace = store.createWorkspace({ name: 'original workspace' });
  const artifact = store.createArtifact({ name: 'original app', runtime: 'html', workspaceId: workspace.id }), oldBuildId = 'original_build';
  const literal = `${artifact.id} ${oldBuildId} ${workspace.id}`;
  store.writeArtifactFiles({ id: artifact.id, expectedRevision: 1, files: [{ path: 'literal.txt', text: literal }] });
  commit(store, store.getArtifact(artifact.id), oldBuildId);
  store.artifactDataSet({ id: artifact.id, key: 'literal', value: { id: artifact.id, workspaceId: workspace.id, buildId: oldBuildId }, expectedVersion: 0 });
  const meta = store.getArtifact(artifact.id), chat = store.createChat({ workspaceId: workspace.id });
  const trace = [{ content: literal, calls: [
    completed('list', 'muse_list_apps', {}, { apps: [meta] }),
    completed('read', 'muse_read_app', { id: artifact.id, path: 'literal.txt' }, { app: meta, file: { path: 'literal.txt', text: literal } }),
    completed('write', 'muse_write_app', { id: artifact.id, expectedRevision: 2, files: [{ path: 'literal.txt', text: literal }] }, { app: meta }),
    completed('build', 'muse_build_app', { id: artifact.id, expectedRevision: 2 }, { app: meta, buildId: oldBuildId })
  ] }];
  store.appendMessage(chat.id, { role: 'assistant', content: literal, status: 'complete', agentMode: true, toolTrace: trace });
  const backup = store.exportData(), result = await store.importData(backup);
  const imported = result.artifacts.find(item => item.id !== artifact.id), importedChat = result.chats.find(item => item.id !== chat.id), message = importedChat.messages[0], importedBuildId = imported.builds[0].id;
  assert.notEqual(imported.id, artifact.id); assert.notEqual(importedBuildId, oldBuildId); assert.notEqual(imported.workspaceId, workspace.id); assert.equal(importedChat.workspaceId, imported.workspaceId);
  for (const call of message.toolTrace[0].calls.slice(1)) assert.equal(JSON.parse(call.arguments).id, imported.id);
  const listed = JSON.parse(message.toolTrace[0].calls[0].result).result.apps[0]; assert.equal(listed.id, imported.id); assert.equal(listed.workspaceId, imported.workspaceId); assert.equal(listed.builds[0].id, importedBuildId);
  const built = JSON.parse(message.toolTrace[0].calls[3].result).result; assert.equal(built.app.id, imported.id); assert.equal(built.buildId, importedBuildId); assert.equal(store.readArtifactBuild({ id: built.app.id, buildId: built.buildId }).id, importedBuildId);
  assert.equal(JSON.parse(message.toolTrace[0].calls[1].result).result.file.text, literal); assert.equal(JSON.parse(message.toolTrace[0].calls[2].arguments).files[0].text, literal); assert.equal(message.content, literal); assert.equal(message.toolTrace[0].content, literal);
  assert.equal(store.readArtifactFile({ id: imported.id, path: 'literal.txt' }).text, literal); assert.deepEqual(store.artifactDataGet({ id: imported.id, key: 'literal' }).value, { id: artifact.id, workspaceId: workspace.id, buildId: oldBuildId });
  assert.deepEqual(new Store(directory).getChat(importedChat.id).messages[0].toolTrace, message.toolTrace);
  assert.deepEqual(message.toolTrace[0].calls.map(call => call.id), trace[0].calls.map(call => call.id));
});

test('import cancels unfinished artifact operations before remapping and retains missing artifact/build identities as history', async t => {
  const a = fixture(t, 'pending'), b = fixture(t, 'pending-destination'), workspace = a.store.createWorkspace({ name: 'pending workspace' }), artifact = a.store.createArtifact({ name: 'pending app', runtime: 'html', workspaceId: workspace.id });
  const chat = a.store.createChat({ workspaceId: workspace.id });
  a.store.appendMessage(chat.id, { role: 'assistant', content: '', status: 'streaming', agentMode: true, toolTrace: [{ content: '', calls: [{ id: 'pending-write', name: 'muse_write_app', arguments: JSON.stringify({ id: artifact.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'must never execute' }] }), status: 'awaiting_approval' }] }] });
  const missingChat = a.store.createChat({ workspaceId: workspace.id });
  a.store.appendMessage(missingChat.id, { role: 'assistant', content: 'old history', agentMode: true, toolTrace: [{ content: '', calls: [completed('missing', 'muse_build_app', { id: 'deleted_artifact', expectedRevision: 8 }, { app: { id: 'deleted_artifact', workspaceId: workspace.id }, buildId: 'pruned_build' })] }] });
  const imported = await b.store.importData(a.store.exportData()), newArtifact = imported.artifacts[0];
  const pending = imported.chats.find(item => item.messages[0].toolTrace[0].calls[0].id === 'pending-write').messages[0], call = pending.toolTrace[0].calls[0];
  assert.equal(pending.status, 'cancelled'); assert.equal(call.status, 'cancelled'); assert.equal(JSON.parse(call.result).error.code, 'cancelled'); assert.equal(JSON.parse(call.arguments).id, newArtifact.id); assert.equal(b.store.getArtifact(newArtifact.id).sourceRevision, 1);
  assert.notEqual(b.store.readArtifactFile({ id: newArtifact.id, path: 'index.html' }).text, 'must never execute');
  const missing = imported.chats.find(item => item.messages[0].toolTrace[0].calls[0].id === 'missing').messages[0].toolTrace[0].calls[0];
  assert.equal(JSON.parse(missing.arguments).id, 'deleted_artifact'); assert.equal(JSON.parse(missing.result).result.buildId, 'pruned_build'); assert.equal(JSON.parse(missing.result).result.app.workspaceId, newArtifact.workspaceId);
  assert.equal(new Store(b.directory).getArtifact(newArtifact.id).sourceRevision, 1);
});

test('build IDs remain scoped by imported app identity when valid source apps share an old build ID', async t => {
  const a = fixture(t, 'shared'), b = fixture(t, 'shared-destination'), workspace = a.store.createWorkspace({ name: 'scope' });
  const first = a.store.createArtifact({ name: 'A', runtime: 'html', workspaceId: workspace.id }), second = a.store.createArtifact({ name: 'B', runtime: 'html', workspaceId: workspace.id }); commit(a.store, first, 'shared_build'); commit(a.store, second, 'shared_build');
  const chat = a.store.createChat({ workspaceId: workspace.id }); a.store.appendMessage(chat.id, { role: 'assistant', content: '', agentMode: true, toolTrace: [{ content: '', calls: [first, second].map((value, index) => completed(`build-${index}`, 'muse_build_app', { id: value.id, expectedRevision: 1 }, { app: a.store.getArtifact(value.id), buildId: 'shared_build' })) }] });
  const result = await b.store.importData(a.store.exportData());
  for (const call of result.chats[0].messages[0].toolTrace[0].calls) { const built = JSON.parse(call.result).result; assert.notEqual(built.buildId, 'shared_build'); const value = b.store.readArtifactBuild({ id: built.app.id, buildId: built.buildId }); assert.match(value.pages[0].html, new RegExp(`<h1>${built.app.name}</h1>`)); }
});
