'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { createArtifactRuntime, MAX_ARGUMENT_CHARS, MAX_READ_CHARS } = require('../backend/artifact-tools.cjs');
const model = require('../backend/artifact-model.cjs');
const { runAgentConversation } = require('../backend/agent-loop.cjs');
const builder = require('../backend/artifact-builder.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const execute = (runtime, name, args) => runtime.executeTool(call(name, args));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// State-based Store double: source/build commits enforce the real model's
// invariants and CAS, rather than merely echoing the tool's arguments.
class ArtifactStore {
  apps = new Map(); workspaces = new Set(['a', 'b']); changes = []; onCommit;
  snapshot() { return { workspaces: [...this.workspaces].map(id => ({ id })), artifacts: [...this.apps.values()].map(model.publicArtifact), settings: { apiKey: 'NEVER-READ-SETTINGS' }, privateProfilePath: 'C:/private-profile' }; }
  getArtifact(id) { const value = this.apps.get(id); if (!value) throw new Error('private missing path'); return { ...model.publicArtifact(value), data: { private: 'NEVER-READ-DATA' }, sourcePath: 'C:/private-source' }; }
  createArtifact({ name, runtime, workspaceId = null }) {
    if (workspaceId !== null && !this.workspaces.has(workspaceId)) throw new Error('工作区不存在');
    const timestamp = new Date().toISOString(), value = model.validateArtifact({ id: crypto.randomUUID(), name, runtime, workspaceId, createdAt: timestamp, updatedAt: timestamp, entryPath: runtime === 'html' ? 'index.html' : 'src/main.tsx', sourceRevision: 1, files: model.starterFiles(runtime), builds: [], data: { version: 0, values: {} } });
    this.apps.set(value.id, value); this.changes.push({ type: 'create', id: value.id }); this.onCommit?.('create', value); return this.getArtifact(value.id);
  }
  artifactSourceSnapshot(id) { const value = this.apps.get(id); if (!value) throw new Error('missing'); return copy({ id: value.id, name: value.name, workspaceId: value.workspaceId, runtime: value.runtime, entryPath: value.entryPath, sourceRevision: value.sourceRevision, createdAt: value.createdAt, updatedAt: value.updatedAt, files: value.files }); }
  readArtifactFile({ id, path }) { const file = this.apps.get(id)?.files.find(file => file.path === path); if (!file) throw new Error('missing'); return { ...copy(file), private: 'NEVER-READ-DATA', sourcePath: 'C:/private-source' }; }
  writeArtifactFiles({ id, expectedRevision, files, deletePaths = [], entryPath }) {
    const before = this.apps.get(id); if (!before || before.sourceRevision !== expectedRevision) throw new Error('源码版本冲突');
    const map = new Map(before.files.map(file => [file.path, file])); deletePaths.forEach(path => map.delete(path)); files.forEach(file => map.set(file.path, file));
    const value = model.validateArtifact({ ...before, sourceRevision: expectedRevision + 1, files: [...map.values()], entryPath: entryPath ?? before.entryPath });
    this.apps.set(id, value); this.changes.push({ type: 'write', id }); this.onCommit?.('write', value); return this.getArtifact(id);
  }
  commitArtifactBuild({ id, sourceRevision, build }) {
    const before = this.apps.get(id); if (!before || before.sourceRevision !== sourceRevision || build.sourceRevision !== sourceRevision || model.sourceDigest(before) !== build.sourceDigest) throw new Error('源码版本冲突');
    const value = model.validateArtifact({ ...before, builds: [model.validateArtifactBuild(build), ...before.builds].slice(0, 3) });
    this.apps.set(id, value); this.changes.push({ type: 'build', id }); this.onCommit?.('build', value); return this.getArtifact(id);
  }
}
const app = (store, workspaceId = null, runtime = 'html', name = '示例') => store.createArtifact({ name, runtime, workspaceId });
const mutate = (store, value, text = '<h1>用户的修改</h1>') => store.writeArtifactFiles({ id: value.id, expectedRevision: value.sourceRevision, files: [{ path: value.entryPath, text }] });
function fakeBuilder(t, fn) { const original = builder.buildArtifact; builder.buildArtifact = fn; t.after(() => { builder.buildArtifact = original; }); return original; }

test('five function schemas are detached, bounded, and expose source/build operations without app data APIs', () => {
  const runtime = createArtifactRuntime({ store: new ArtifactStore() });
  assert.deepEqual(runtime.tools.map(tool => tool.function.name), ['muse_list_apps', 'muse_read_app', 'muse_create_app', 'muse_write_app', 'muse_build_app']);
  for (const tool of runtime.tools) { assert.equal(tool.type, 'function'); assert.equal(tool.function.parameters.additionalProperties, false); assert.equal('permissions' in tool.function, false); }
  runtime.tools[0].function.description = 'changed'; assert.notEqual(runtime.tools[0].function.description, 'changed');
  assert.throws(() => createArtifactRuntime({ store: {} }), /Store/);
  assert.throws(() => createArtifactRuntime({ store: new ArtifactStore(), workspaceId: '../bad' }), /工作区/);
  assert.throws(() => createArtifactRuntime({ store: new ArtifactStore(), attachedArtifactIds: Array(2) }), /附件/);
});

test('scope distinguishes workspace, explicit cross-workspace attachments, and unrelated ungrouped apps', async () => {
  const store = new ArtifactStore(), a = app(store, 'a'), b = app(store, 'b'), global = app(store);
  const runtime = createArtifactRuntime({ store, workspaceId: 'a', attachedArtifactIds: [b.id] });
  assert.deepEqual(new Set((await execute(runtime, 'muse_list_apps')).result.apps.map(app => app.id)), new Set([a.id, b.id]));
  assert.equal((await execute(runtime, 'muse_read_app', { id: b.id })).ok, true);
  assert.equal((await execute(runtime, 'muse_read_app', { id: global.id })).error.code, 'out_of_scope');
  assert.equal((await execute(createArtifactRuntime({ store }), 'muse_list_apps')).result.total, 0);
  assert.equal((await execute(createArtifactRuntime({ store, attachedArtifactIds: [global.id] }), 'muse_read_app', { id: global.id })).ok, true);
});

test('list/meta/source reads need no approval and only return public metadata plus the requested text', async () => {
  const store = new ArtifactStore(), value = app(store, 'a'); let approvals = 0;
  const runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => { approvals++; return true; } });
  const meta = await execute(runtime, 'muse_read_app', { id: value.id }); assert.equal(meta.result.files[0].path, 'index.html');
  const read = await execute(runtime, 'muse_read_app', { id: value.id, path: 'index.html', offset: 0, length: 12 });
  assert.equal(read.result.file.text, store.apps.get(value.id).files[0].text.slice(0, 12)); assert.equal(read.result.file.nextOffset, 12); assert.equal(approvals, 0);
  const serialized = JSON.stringify([meta, read, await execute(runtime, 'muse_list_apps')]);
  for (const forbidden of ['NEVER-READ', 'private-profile', 'private-source', 'apiKey', 'sourcePath', 'dataVersion', 'dataBase64']) assert.equal(serialized.includes(forbidden), false);
});

test('source pagination preserves surrogate pairs and bounds JSON receipts for multibyte/escaped source', async () => {
  const store = new ArtifactStore(), value = app(store, 'a');
  const text = '😀' + '界'.repeat(30000) + '\u0001'.repeat(20000);
  mutate(store, value, text); const runtime = createArtifactRuntime({ store, workspaceId: 'a' });
  const one = await execute(runtime, 'muse_read_app', { id: value.id, path: 'index.html', length: 1 }); assert.equal(one.result.file.text, '😀'); assert.equal(one.result.file.nextOffset, 2);
  const middle = await execute(runtime, 'muse_read_app', { id: value.id, path: 'index.html', offset: 1, length: 4 }); assert.equal(middle.result.file.offset, 0); assert.equal(Buffer.from(middle.result.file.text).toString(), middle.result.file.text);
  let offset = 0, joined = '';
  do { const result = await execute(runtime, 'muse_read_app', { id: value.id, path: 'index.html', offset }); assert.equal(result.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024); assert.ok(result.result.file.text.length <= MAX_READ_CHARS); joined += result.result.file.text; const next = result.result.file.nextOffset; if (next === undefined) break; assert.ok(next > offset); offset = next; } while (offset < text.length);
  assert.equal(joined, text);
});

test('binary files return only metadata and paginated file lists stay below parent trace limits', async () => {
  const store = new ArtifactStore(), value = app(store, 'a'); const extra = [{ path: 'image.png', dataBase64: Buffer.from('private binary content').toString('base64') }];
  for (let i = 0; i < 180; i++) extra.push({ path: `long/${'目录'.repeat(100)}${i}.txt`, text: 'text' });
  // Keep individual path segments within the model's 240-character maximum.
  store.writeArtifactFiles({ id: value.id, expectedRevision: 1, files: extra });
  const runtime = createArtifactRuntime({ store, workspaceId: 'a' }), binary = await execute(runtime, 'muse_read_app', { id: value.id, path: 'image.png' });
  assert.equal(binary.result.file.encoding, 'binary'); assert.equal('text' in binary.result.file, false); assert.equal('dataBase64' in binary.result.file, false);
  const paths = []; let offset = 0;
  while (true) { const page = await execute(runtime, 'muse_read_app', { id: value.id, offset, length: 100 }); assert.equal(page.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024); paths.push(...page.result.files.map(file => file.path)); if (page.result.nextOffset === undefined) break; offset = page.result.nextOffset; }
  assert.equal(new Set(paths).size, 182); assert.equal(paths.length, 182);
});

test('every create/write/build approval requires literal true and does not disclose callback errors', async () => {
  const store = new ArtifactStore(), value = app(store, 'a'), before = store.changes.length;
  for (const requestApproval of [undefined, () => false, () => 'yes', () => ({ approved: true }), () => { throw new Error('private secret'); }]) {
    const runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval });
    for (const [name, args] of [['muse_create_app', { name: '拒绝', runtime: 'html' }], ['muse_write_app', { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: '<p>No</p>' }] }], ['muse_build_app', { id: value.id, expectedRevision: 1 }]]) {
      const result = await execute(runtime, name, args); assert.equal(result.error.code, 'denied'); assert.equal(JSON.stringify(result).includes('private secret'), false);
    }
  }
  assert.equal(store.changes.length, before);
});

test('approved create/write/build are separate concrete approvals; same-round create gains scope and build never executes source', async () => {
  const store = new ArtifactStore(), approvals = [], events = [], runtime = createArtifactRuntime({ store, requestApproval: request => { assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.arguments)); approvals.push(request); return true; }, onActivity: event => events.push(event) });
  const created = await execute(runtime, 'muse_create_app', { name: '独立应用', runtime: 'html' }); assert.equal(created.ok, true); const id = created.result.app.id;
  assert.equal((await execute(runtime, 'muse_list_apps')).result.apps[0].id, id);
  assert.equal((await execute(createArtifactRuntime({ store }), 'muse_list_apps')).result.total, 0);
  const updated = await execute(runtime, 'muse_write_app', { id, expectedRevision: 1, files: [{ path: 'index.html', text: '<!doctype html><h1>应用</h1><script>globalThis.__artifactToolExecuted = true;</script>' }] }); assert.equal(updated.result.app.sourceRevision, 2);
  const built = await execute(runtime, 'muse_build_app', { id, expectedRevision: 2 }); assert.equal(built.ok, true); assert.equal(built.result.sourceRevision, 2); assert.equal(typeof built.result.buildId, 'string'); assert.equal(store.apps.get(id).builds.length, 1); assert.equal(globalThis.__artifactToolExecuted, undefined);
  assert.deepEqual(approvals.map(request => request.name), ['muse_create_app', 'muse_write_app', 'muse_build_app']); assert.deepEqual(approvals.map(request => request.permissions), [['artifact.source.write'], ['artifact.source.write'], ['artifact.build']]); assert.match(approvals[1].summary, /版本 1/); assert.match(approvals[2].summary, /版本 2/);
  assert.equal(events.filter(event => event.type === 'tool-complete' && event.writeCommitted).length, 3);
  assert.equal(JSON.stringify(built).includes('globalThis'), false); assert.equal(JSON.stringify(built).includes('pages'), false);
});

test('strict nested arguments reject unsafe paths, foreign fields, prototype keys, malformed binary, overlapping writes, and invalid versions before approval', async () => {
  const store = new ArtifactStore(), value = app(store, 'a'); let approvals = 0;
  const runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => { approvals++; return true; } });
  const base = { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'valid' }] };
  const bad = [
    { ...base, workspaceId: 'b' }, { ...base, expectedRevision: 0 }, { ...base, expectedRevision: 1.5 }, { ...base, files: [] },
    { ...base, files: [{ path: '../outside.html', text: 'x' }] }, { ...base, files: [{ path: 'CON.html', text: 'x' }] }, { ...base, files: [{ path: 'a%2fb.html', text: 'x' }] },
    { ...base, files: [{ path: 'index.html', text: 'x', dataBase64: 'eA==' }] }, { ...base, files: [{ path: 'index.html', text: 'x', privileged: true }] },
    { ...base, files: [{ path: 'index.html', dataBase64: 'eB==' }] }, { ...base, files: [{ path: 'index.html', text: '\ud800' }] },
    { ...base, deletePaths: ['index.html'] }, { ...base, deletePaths: ['missing'] }, { ...base, deletePaths: ['a', 'A'] }, { ...base, files: [], entryPath: 'missing.html' },
    { ...base, files: [], deletePaths: ['index.html'] }
  ];
  for (const args of bad) { const result = await execute(runtime, 'muse_write_app', args); assert.equal(result.ok, false, JSON.stringify(args)); assert.equal(result.error.code, 'invalid_arguments'); }
  const injected = call('muse_write_app', base); injected.function.arguments = `{"id":${JSON.stringify(value.id)},"expectedRevision":1,"files":[{"path":"index.html","text":"x","__proto__":{"polluted":true}}]}`;
  assert.equal((await runtime.executeTool(injected)).error.code, 'invalid_arguments'); assert.equal({}.polluted, undefined);
  assert.equal(approvals, 0); assert.equal(store.apps.get(value.id).sourceRevision, 1);
});

test('tool-call validation avoids accessors and rejects malformed types, extra fields, and excessive arguments', async () => {
  const runtime = createArtifactRuntime({ store: new ArtifactStore() }); let reads = 0;
  const accessor = { id: 'x', type: 'function', get function() { reads++; throw new Error('must not run'); } };
  assert.equal((await runtime.executeTool(accessor)).error.code, 'invalid_tool_call'); assert.equal(reads, 0);
  for (const value of [null, [], new Proxy({}, {}), { ...call('muse_list_apps'), extra: true }, call('muse_list_apps', { offset: -1 }), call('muse_list_apps', { limit: 101 }), call('muse_create_app', { name: 'x', runtime: 'node' })]) assert.equal((await runtime.executeTool(value)).ok, false);
  const tooLarge = call('muse_create_app'); tooLarge.function.arguments = ' '.repeat(MAX_ARGUMENT_CHARS + 1); assert.equal((await runtime.executeTool(tooLarge)).error.code, 'invalid_arguments');
  assert.equal((await execute(runtime, 'data_query', {})).error.code, 'unknown_tool');
});

test('stale source versions fail before approval and user edits during approval cannot be overwritten', async () => {
  const store = new ArtifactStore(), value = app(store, 'a'); let approvals = 0;
  const runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => { approvals++; mutate(store, value); return true; } });
  assert.equal((await execute(runtime, 'muse_write_app', { id: value.id, expectedRevision: 2, files: [{ path: 'index.html', text: 'no' }] })).error.code, 'conflict'); assert.equal(approvals, 0);
  assert.equal((await execute(runtime, 'muse_write_app', { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'no' }] })).error.code, 'conflict'); assert.equal(approvals, 1);
  assert.equal(store.apps.get(value.id).files[0].text, '<h1>用户的修改</h1>'); assert.equal(store.changes.filter(change => change.type === 'write').length, 1);
});

test('approval is not a scope lease: removed workspace or moved/deleted target prevents commit', async () => {
  for (const change of ['workspace', 'move', 'delete']) {
    const store = new ArtifactStore(), value = app(store, 'a'); const runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => { if (change === 'workspace') store.workspaces.delete('a'); if (change === 'move') store.apps.get(value.id).workspaceId = 'b'; if (change === 'delete') store.apps.delete(value.id); return true; } });
    const result = await execute(runtime, 'muse_write_app', { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'no' }] }); assert.equal(result.error.code, change === 'workspace' ? 'scope_changed' : 'out_of_scope'); assert.equal(store.changes.length, 1);
  }
  const store = new ArtifactStore(), runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => { store.workspaces.delete('a'); return true; } });
  assert.equal((await execute(runtime, 'muse_create_app', { name: 'no', runtime: 'react' })).error.code, 'scope_changed'); assert.equal(store.apps.size, 0);
});

test('cancel pending approval rejects promptly and a later approval cannot create an app', async () => {
  const store = new ArtifactStore(), controller = new AbortController(), started = deferred(), approval = deferred(), events = [];
  const runtime = createArtifactRuntime({ store, signal: controller.signal, requestApproval: () => { started.resolve(); return approval.promise; }, onActivity: event => events.push(event) });
  const pending = execute(runtime, 'muse_create_app', { name: 'cancel', runtime: 'html' }); await started.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); approval.resolve(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.apps.size, 0); assert.equal(events.at(-1).type, 'tool-cancelled');
});

test('replayed or concurrent identical call IDs do not duplicate approvals/commits and returned receipts are detached', async () => {
  const store = new ArtifactStore(), approval = deferred(), started = deferred(); let approvals = 0;
  const runtime = createArtifactRuntime({ store, requestApproval: () => { approvals++; started.resolve(); return approval.promise; } }), input = call('muse_create_app', { name: 'once', runtime: 'html' }, 'same-call');
  const first = runtime.executeTool(input); await started.promise; const second = runtime.executeTool(input); approval.resolve(true); const [one, two] = await Promise.all([first, second]);
  assert.equal(approvals, 1); assert.equal(store.apps.size, 1); assert.deepEqual(one, two); one.result.app.name = 'mutated'; assert.equal((await runtime.executeTool(input)).result.app.name, 'once');
  assert.equal((await runtime.executeTool(call('muse_create_app', { name: 'other', runtime: 'html' }, 'same-call'))).error.code, 'invalid_tool_call');
});

test('late cancellation after committed create/write/build preserves one successful receipt', async () => {
  for (const operation of ['create', 'write', 'build']) {
    const store = new ArtifactStore(), value = app(store, 'a'), controller = new AbortController(), events = [];
    store.onCommit = kind => { if (kind === operation) controller.abort(); };
    const runtime = createArtifactRuntime({ store, workspaceId: 'a', signal: controller.signal, requestApproval: () => true, onActivity: event => events.push(event) });
    const result = await execute(runtime, `muse_${operation}_app`, operation === 'create' ? { name: 'committed', runtime: 'html' } : operation === 'write' ? { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: '<h1>committed</h1>' }] } : { id: value.id, expectedRevision: 1 });
    assert.equal(result.ok, true); assert.equal(result.result.committed, true); assert.equal(store.changes.filter(change => change.type === operation).length, operation === 'create' ? 2 : 1); assert.equal(events.at(-1).writeCommitted, true); assert.equal(events.at(-1).cancelledAfterCommit, true);
  }
});

test('active compile cancellation rejects promptly and never commits its late result', async t => {
  const store = new ArtifactStore(), value = app(store, 'a'), controller = new AbortController(), started = deferred(), finished = deferred(); let snapshot;
  const original = fakeBuilder(t, input => { snapshot = input; assert.ok(Object.isFrozen(input.files)); started.resolve(); return finished.promise; });
  const runtime = createArtifactRuntime({ store, workspaceId: 'a', signal: controller.signal, requestApproval: () => true }), pending = execute(runtime, 'muse_build_app', { id: value.id, expectedRevision: 1 });
  await started.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); finished.resolve(await original(snapshot)); await new Promise(resolve => setImmediate(resolve)); assert.equal(store.apps.get(value.id).builds.length, 0);
});

test('source mutation, movement, and deletion during compile invalidate the approved build', async t => {
  const real = builder.buildArtifact;
  fakeBuilder(t, async snapshot => { const action = actions.shift(); action(); return real(snapshot); });
  const actions = [];
  for (const kind of ['write', 'move', 'delete']) {
    const store = new ArtifactStore(), value = app(store, 'a'); actions.push(() => { if (kind === 'write') mutate(store, value); if (kind === 'move') store.apps.get(value.id).workspaceId = 'b'; if (kind === 'delete') store.apps.delete(value.id); });
    const result = await execute(createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => true }), 'muse_build_app', { id: value.id, expectedRevision: 1 });
    assert.equal(result.error.code, kind === 'write' ? 'conflict' : 'out_of_scope'); assert.equal(store.changes.filter(change => change.type === 'build').length, 0);
  }
});

test('build failures preserve source and previous immutable build and never expose exception details', async t => {
  const store = new ArtifactStore(), value = app(store, 'a'), runtime = createArtifactRuntime({ store, workspaceId: 'a', requestApproval: () => true });
  assert.equal((await execute(runtime, 'muse_build_app', { id: value.id, expectedRevision: 1 })).ok, true); const previous = copy(store.apps.get(value.id).builds);
  fakeBuilder(t, () => { throw new Error('C:/private-profile apiKey=hidden'); });
  const result = await execute(runtime, 'muse_build_app', { id: value.id, expectedRevision: 1 }); assert.equal(result.error.code, 'build_failed'); assert.equal(JSON.stringify(result).includes('private-profile'), false); assert.deepEqual(store.apps.get(value.id).builds, previous); assert.equal(store.apps.get(value.id).sourceRevision, 1);
});

test('activity observers cannot mutate approval arguments or turn a real commit into failure', async () => {
  const store = new ArtifactStore(); const runtime = createArtifactRuntime({ store, requestApproval: request => { assert.throws(() => { request.arguments.name = 'wrong'; }, TypeError); return true; }, onActivity: event => { if (event.type === 'tool-start') throw new Error('observer'); return Promise.reject(new Error('observer')); } });
  const result = await execute(runtime, 'muse_create_app', { name: 'correct', runtime: 'react' }); assert.equal(result.ok, true); assert.equal(store.apps.get(result.result.app.id).name, 'correct');
});

test('pre-aborted signals and explicit approval AbortError remain cancellations', async () => {
  const store = new ArtifactStore(), controller = new AbortController(); controller.abort();
  await assert.rejects(execute(createArtifactRuntime({ store, signal: controller.signal }), 'muse_list_apps'), { name: 'AbortError' });
  await assert.rejects(execute(createArtifactRuntime({ store, requestApproval: () => { throw new DOMException('cancel', 'AbortError'); } }), 'muse_create_app', { name: 'no', runtime: 'html' }), { name: 'AbortError' }); assert.equal(store.apps.size, 0);
});

test('the existing agent loop records a committed artifact receipt before stopping on cancellation', async () => {
  const store = new ArtifactStore(), controller = new AbortController(), traces = []; let requests = 0;
  store.onCommit = () => controller.abort();
  const runtime = createArtifactRuntime({ store, signal: controller.signal, requestApproval: () => true });
  const provider = { streamCompletion: async input => { requests++; assert.ok(input.tools.some(tool => tool.function.name === 'muse_create_app')); return { content: '', finishReason: 'tool_calls', toolCalls: [call('muse_create_app', { name: 'persisted', runtime: 'html' }, 'artifact-create')] }; } };
  await assert.rejects(runAgentConversation({ provider, settings: {}, messages: [{ role: 'user', content: '创建应用' }], signal: controller.signal, runtime: { getTools: () => runtime.tools, execute: runtime.executeTool }, onTrace: ({ trace }) => traces.push(copy(trace)) }), { name: 'AbortError' });
  assert.equal(requests, 1); assert.equal(store.apps.size, 1); const last = traces.at(-1)[0].calls[0]; assert.equal(last.status, 'complete'); assert.equal(JSON.parse(last.result).ok, true); assert.equal(JSON.parse(last.result).result.committed, true);
});

function persisted(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'artifact-tools-'));
  t.after(() => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^artifact-tools-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { directory, store: new Store(directory) };
}

test('real Store, tools, and builder persist a scoped application across restart without model access to app data', async t => {
  const { store, directory } = persisted(t), workspace = store.createWorkspace({ name: '工具集成' }), approvals = [];
  store.secret = () => { throw new Error('tools must never inspect credentials'); };
  const runtime = createArtifactRuntime({ store, workspaceId: workspace.id, requestApproval: request => { approvals.push(request); return true; } });
  const created = await execute(runtime, 'muse_create_app', { name: '真实存储应用', runtime: 'html' }); assert.equal(created.ok, true); const id = created.result.app.id;
  store.artifactDataSet({ id, key: 'private', value: 'PRIVATE-DATA-NOT-FOR-MODEL', expectedVersion: 0 });
  const text = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>真实构建</h1></body></html>';
  assert.equal((await execute(runtime, 'muse_write_app', { id, expectedRevision: 1, files: [{ path: 'index.html', text }, { path: 'style.css', text: 'h1{color:rebeccapurple}' }] })).ok, true);
  const built = await execute(runtime, 'muse_build_app', { id, expectedRevision: 2 }); assert.equal(built.ok, true);
  const restarted = new Store(directory), meta = restarted.getArtifact(id), build = restarted.readArtifactBuild({ id, buildId: built.result.buildId });
  assert.equal(meta.sourceRevision, 2); assert.equal(meta.workspaceId, workspace.id); assert.match(build.pages[0].html, /<style>h1\{color:(?:#639|rebeccapurple)\}/); assert.match(build.pages[0].html, /真实构建/); assert.equal(build.pages[0].html.includes('href="style.css"'), false);
  const results = [await execute(runtime, 'muse_list_apps'), await execute(runtime, 'muse_read_app', { id }), await execute(runtime, 'muse_read_app', { id, path: 'index.html' }), built];
  for (const forbidden of ['PRIVATE-DATA-NOT-FOR-MODEL', 'apiKey', directory, 'dataVersion', 'dataBase64']) assert.equal(JSON.stringify(results).includes(forbidden), false);
  assert.deepEqual(approvals.map(request => request.name), ['muse_create_app', 'muse_write_app', 'muse_build_app']);
});

test('a real Store CAS rejection inside the final write is reported as conflict without overwriting the concurrent save', async t => {
  const { store } = persisted(t), workspace = store.createWorkspace({ name: 'CAS' }), value = store.createArtifact({ name: 'CAS target', runtime: 'html', workspaceId: workspace.id }), write = store.writeArtifactFiles.bind(store); let raced = false;
  store.writeArtifactFiles = input => { if (!raced) { raced = true; write({ id: input.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'concurrent final-boundary save' }] }); } return write(input); };
  const runtime = createArtifactRuntime({ store, workspaceId: workspace.id, requestApproval: () => true });
  const result = await execute(runtime, 'muse_write_app', { id: value.id, expectedRevision: 1, files: [{ path: 'index.html', text: 'must not overwrite' }] });
  assert.equal(result.error.code, 'conflict'); assert.equal(store.readArtifactFile({ id: value.id, path: 'index.html' }).text, 'concurrent final-boundary save'); assert.equal(store.getArtifact(value.id).sourceRevision, 2);
});
