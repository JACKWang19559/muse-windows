'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../backend/store.cjs');
const { AgentRuntime, MAX_ARGUMENT_CHARS, MAX_READ_CHARS } = require('../backend/agent-runtime.cjs');

function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'agent-runtime-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^agent-runtime-/); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new Store(path.join(root, 'profile'));
  const file = async (name, content, workspaceId = null) => {
    const sourcePath = path.join(root, name); fs.writeFileSync(sourcePath, content);
    return { original: sourcePath, file: await store.addFile({ sourcePath, workspaceId }) };
  };
  return { root, store, file };
}
const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const execute = (runtime, name, args) => runtime.execute(call(name, args));
const created = (store, name, content, workspaceId = null) => store.createTextFile({ name, content, workspaceId });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('function schemas expose four bounded file tools and no shell or original Muse permissions', t => {
  const { store } = fixture(t), runtime = new AgentRuntime({ store });
  const tools = runtime.getTools();
  assert.deepEqual(tools.map(tool => tool.function.name), ['workspace_list_files', 'workspace_read_file', 'workspace_create_text_file', 'workspace_save_text_file']);
  for (const tool of tools) { assert.equal(tool.type, 'function'); assert.equal(tool.function.parameters.additionalProperties, false); assert.equal('permissions' in tool.function, false); }
  assert.deepEqual(tools[3].function.parameters.required, ['id', 'content', 'expectedSha256']);
  tools[0].function.description = 'mutated'; assert.notEqual(runtime.getTools()[0].function.description, 'mutated');
  assert.throws(() => new AgentRuntime({ store, workspaceId: 123 }), /工作区/);
});

test('workspace scope includes only that workspace and explicit cross-workspace/global attachments', async t => {
  const { store } = fixture(t), a = store.createWorkspace({ name: 'A' }), b = store.createWorkspace({ name: 'B' });
  const one = await created(store, 'one.md', 'A private', a.id), two = await created(store, 'two.md', 'B private', b.id), global = await created(store, 'global.txt', 'global private');
  const runtime = new AgentRuntime({ store, workspaceId: a.id, attachmentIds: [two.file.id] });
  const list = await execute(runtime, 'workspace_list_files'); assert.equal(list.ok, true);
  assert.deepEqual(new Set(list.result.files.map(file => file.id)), new Set([one.file.id, two.file.id]));
  assert.equal((await execute(runtime, 'workspace_read_file', { id: two.file.id })).result.text, 'B private');
  assert.equal((await execute(runtime, 'workspace_read_file', { id: global.file.id })).error.code, 'out_of_scope');
  assert.equal((await execute(runtime, 'workspace_read_file', { id: 'missing' })).error.code, 'out_of_scope');
});

test('global conversation does not enumerate ungrouped files and can read only explicitly attached files', async t => {
  const { store } = fixture(t), global = await created(store, 'unscoped.md', 'unscoped');
  const empty = new AgentRuntime({ store }); assert.deepEqual((await execute(empty, 'workspace_list_files')).result.files, []);
  assert.equal((await execute(empty, 'workspace_read_file', { id: global.file.id })).error.code, 'out_of_scope');
  const attached = new AgentRuntime({ store, attachmentIds: [global.file.id] });
  assert.equal((await execute(attached, 'workspace_read_file', { id: global.file.id })).result.text, 'unscoped');
});

test('256-character call IDs reach approval and execution while 257-character IDs are rejected before either', async t => {
  const { store } = fixture(t), approvals = [], events = [];
  const runtime = new AgentRuntime({ store, onApproval: request => { approvals.push(request); return true; }, onToolEvent: event => events.push(event) });
  const acceptedId = 'c'.repeat(256), rejectedId = 'c'.repeat(257);
  const accepted = await runtime.execute(call('workspace_create_text_file', { name: 'boundary.md', content: 'created once' }, acceptedId));
  assert.equal(accepted.ok, true); assert.equal(approvals.length, 1); assert.equal(approvals[0].toolCallId, acceptedId);
  assert.equal(events.find(event => event.type === 'tool-complete').toolCallId, acceptedId);
  const rejected = await runtime.execute(call('workspace_create_text_file', { name: 'rejected.md', content: 'must not write' }, rejectedId));
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid_tool_call');
  assert.equal(approvals.length, 1); assert.deepEqual(store.snapshot().files.map(file => file.name), ['boundary.md']);
  assert.equal(events.some(event => event.toolCallId === rejectedId), false);
});

test('reads are bounded, retain CAS hashes and expose no source paths, settings, secret or private metadata', async t => {
  const { store, file, root } = fixture(t), imported = await file('long.txt', '中文'.repeat(10000));
  store.secret = () => { throw new Error('Secrets must not be read by tools.'); };
  const snapshot = store.snapshot.bind(store);
  store.snapshot = () => { const data = snapshot(); data.files[0]._storedName = '/private/raw'; data.files[0].sourcePath = imported.original; data.settings.hiddenSentinel = 'not-tool-data'; return data; };
  const runtime = new AgentRuntime({ store, attachmentIds: [imported.file.id] });
  const read = await execute(runtime, 'workspace_read_file', { id: imported.file.id });
  assert.equal(read.ok, true); assert.equal(read.result.text.length, MAX_READ_CHARS); assert.equal(read.result.truncated, true); assert.match(read.result.sha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify([read, await execute(runtime, 'workspace_list_files')]);
  for (const forbidden of [root, imported.original, '_storedName', 'sourcePath', 'hiddenSentinel', 'not-tool-data']) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), read);
});

test('create requires literal true approval every time; missing, false and truthy callbacks cannot write', async t => {
  const { store } = fixture(t);
  for (const onApproval of [undefined, () => false, () => 'yes', async () => ({ approved: true }), () => { throw new Error('private/path token must not leak'); }]) {
    const runtime = new AgentRuntime({ store, onApproval }), result = await execute(runtime, 'workspace_create_text_file', { name: 'denied.md', content: 'unapproved' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'denied'); assert.equal(JSON.stringify(result).includes('token'), false);
  }
  assert.equal(store.snapshot().files.length, 0);
});

test('approved create is scoped, readable in the same runtime and requests separate approval for each write', async t => {
  const { store } = fixture(t), requests = [], events = [];
  const runtime = new AgentRuntime({ store, onApproval: async request => { requests.push(request); assert.equal(Object.isFrozen(request.arguments), true); return true; }, onToolEvent: event => events.push(event) });
  const first = await execute(runtime, 'workspace_create_text_file', { name: 'new.md', content: '# 新建' });
  assert.equal(first.ok, true); assert.equal(first.result.preview.text, '# 新建'); assert.equal(requests[0].name, 'workspace_create_text_file'); assert.deepEqual(requests[0].permissions, ['workspace.files.write']);
  const read = await execute(runtime, 'workspace_read_file', { id: first.result.file.id }); assert.equal(read.result.text, '# 新建');
  assert.deepEqual((await execute(runtime, 'workspace_list_files')).result.files.map(file => file.id), [first.result.file.id]);
  assert.deepEqual((await execute(new AgentRuntime({ store }), 'workspace_list_files')).result.files, []);
  const saved = await execute(runtime, 'workspace_save_text_file', { id: first.result.file.id, content: '# 更新', expectedSha256: read.result.sha256 });
  assert.equal(saved.ok, true); assert.equal(requests.length, 2); assert.equal(requests[1].name, 'workspace_save_text_file');
  assert.equal(events.filter(event => event.type === 'tool-approval').length, 2); assert.equal(events.filter(event => event.type === 'tool-complete' && event.writeCommitted).length, 2);
});

test('save changes only the managed copy and preserves the imported original', async t => {
  const { store, file } = fixture(t), workspace = store.createWorkspace({ name: '编辑' }), imported = await file('original.csv', 'a,b\r\n1,2', workspace.id);
  const runtime = new AgentRuntime({ store, workspaceId: workspace.id, onApproval: () => true });
  const read = await execute(runtime, 'workspace_read_file', { id: imported.file.id });
  const result = await execute(runtime, 'workspace_save_text_file', { id: imported.file.id, content: 'a,b\n3,4', expectedSha256: read.result.sha256 });
  assert.equal(result.ok, true); assert.equal(store.readFile(imported.file.id).text, 'a,b\n3,4'); assert.equal(fs.readFileSync(imported.original, 'utf8'), 'a,b\r\n1,2');
});

test('save rejects stale hashes before approval and rechecks a concurrent edit after approval', async t => {
  const { store } = fixture(t), item = await created(store, 'cas.md', 'before'); let approvals = 0;
  const runtime = new AgentRuntime({ store, attachmentIds: [item.file.id], onApproval: () => { approvals++; store.saveTextFile({ id: item.file.id, content: 'user edit during approval', expectedSha256: item.preview.sha256 }); return true; } });
  const stale = await execute(runtime, 'workspace_save_text_file', { id: item.file.id, content: 'bad', expectedSha256: '0'.repeat(64) });
  assert.equal(stale.error.code, 'conflict'); assert.equal(approvals, 0);
  const concurrent = await execute(runtime, 'workspace_save_text_file', { id: item.file.id, content: 'must not overwrite', expectedSha256: item.preview.sha256 });
  assert.equal(concurrent.error.code, 'conflict'); assert.equal(approvals, 1); assert.equal(store.readFile(item.file.id).text, 'user edit during approval');
});

test('workspace deletion or target scope movement while awaiting approval cannot grant a write lease', async t => {
  const { store } = fixture(t), workspace = store.createWorkspace({ name: '撤销范围' }), item = await created(store, 'scope.md', 'before', workspace.id);
  const runtime = new AgentRuntime({ store, workspaceId: workspace.id, onApproval: () => { store.deleteWorkspace(workspace.id); return true; } });
  const saved = await execute(runtime, 'workspace_save_text_file', { id: item.file.id, content: 'no', expectedSha256: item.preview.sha256 });
  assert.equal(saved.error.code, 'scope_changed'); assert.equal(store.readFile(item.file.id).text, 'before');
  const next = store.createWorkspace({ name: '新建审批范围' });
  const creating = new AgentRuntime({ store, workspaceId: next.id, onApproval: () => { store.deleteWorkspace(next.id); return true; } });
  assert.equal((await execute(creating, 'workspace_create_text_file', { name: 'no.md', content: 'no' })).error.code, 'scope_changed');
  assert.equal(store.snapshot().files.length, 1);
});

test('an independently changed file scope is checked again after approval', async t => {
  const { store } = fixture(t), a = store.createWorkspace({ name: 'A' }), b = store.createWorkspace({ name: 'B' }), item = await created(store, 'move.md', 'before', a.id);
  const snapshot = store.snapshot.bind(store); let moved = false, writes = 0;
  store.snapshot = () => { const data = snapshot(); if (moved) data.files.find(file => file.id === item.file.id).workspaceId = b.id; return data; };
  const save = store.saveTextFile.bind(store); store.saveTextFile = input => { writes++; return save(input); };
  const runtime = new AgentRuntime({ store, workspaceId: a.id, onApproval: () => { moved = true; return true; } });
  const result = await execute(runtime, 'workspace_save_text_file', { id: item.file.id, content: 'must not write', expectedSha256: item.preview.sha256 });
  assert.equal(result.error.code, 'out_of_scope'); assert.equal(writes, 0); assert.equal(store.readFile(item.file.id).text, 'before');
});

test('workspace creates stay in that workspace and unsupported/read-only documents cannot be saved', async t => {
  const { store, file } = fixture(t), workspace = store.createWorkspace({ name: '资料工具' }); let approvals = 0;
  const runtime = new AgentRuntime({ store, workspaceId: workspace.id, onApproval: () => { approvals++; return true; } });
  const next = await execute(runtime, 'workspace_create_text_file', { name: 'scoped.json', content: '{"scope":"workspace"}' });
  assert.equal(next.ok, true); assert.equal(next.result.file.workspaceId, workspace.id);
  assert.equal((await execute(new AgentRuntime({ store, workspaceId: workspace.id }), 'workspace_list_files')).result.files[0].id, next.result.file.id);
  const binary = await file('inert.exe', 'MZ do not execute', workspace.id);
  assert.equal((await execute(runtime, 'workspace_read_file', { id: binary.file.id })).error.code, 'read_unavailable');
  const utf16 = await file('readonly.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('只读', 'utf16le')]), workspace.id);
  const read = await execute(runtime, 'workspace_read_file', { id: utf16.file.id }); assert.equal(read.result.editable, false);
  assert.equal((await execute(runtime, 'workspace_save_text_file', { id: utf16.file.id, content: 'no', expectedSha256: read.result.sha256 })).error.code, 'read_only');
  assert.equal(approvals, 1);
});

test('cancellation during a pending approval rejects promptly with AbortError and does not write later', async t => {
  const { store } = fixture(t), controller = new AbortController(), started = deferred(), approval = deferred(), events = [];
  const runtime = new AgentRuntime({ store, signal: controller.signal, onApproval: () => { started.resolve(); return approval.promise; }, onToolEvent: event => events.push(event) });
  const pending = execute(runtime, 'workspace_create_text_file', { name: 'cancel.md', content: 'never saved' });
  await started.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  approval.resolve(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.snapshot().files.length, 0); assert.equal(events.at(-1).type, 'tool-cancelled'); assert.equal(events.at(-1).writeCommitted, false);
});

test('pre-aborted calls and callback AbortError remain cancellations rather than readable tool failures', async t => {
  const { store } = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(execute(new AgentRuntime({ store, signal: controller.signal }), 'workspace_list_files'), { name: 'AbortError' });
  const runtime = new AgentRuntime({ store, onApproval: () => { throw new DOMException('cancel', 'AbortError'); } });
  await assert.rejects(execute(runtime, 'workspace_create_text_file', { name: 'cancel.txt', content: '' }), { name: 'AbortError' });
  assert.equal(store.snapshot().files.length, 0);
});

test('abort after an atomic write returns the committed receipt and never triggers an automatic retry', async t => {
  const { store } = fixture(t), controller = new AbortController(), events = []; let calls = 0;
  const createTextFile = store.createTextFile.bind(store);
  store.createTextFile = async input => { calls++; const result = await createTextFile(input); controller.abort(); return result; };
  const runtime = new AgentRuntime({ store, signal: controller.signal, onApproval: () => true, onToolEvent: event => events.push(event) });
  const result = await execute(runtime, 'workspace_create_text_file', { name: 'committed.md', content: 'saved once' });
  assert.equal(result.ok, true); assert.equal(result.result.preview.text, 'saved once');
  assert.equal(calls, 1); assert.equal(store.snapshot().files.length, 1); assert.equal(events.at(-1).type, 'tool-complete'); assert.equal(events.at(-1).writeCommitted, true); assert.equal(events.at(-1).cancelledAfterCommit, true); assert.deepEqual(events.at(-1).result, result.result);
});

test('a committed save also returns its receipt if cancellation arrives immediately afterward', async t => {
  const { store } = fixture(t), item = await created(store, 'save-once.md', 'before'), controller = new AbortController(); let writes = 0;
  const save = store.saveTextFile.bind(store); store.saveTextFile = input => { writes++; const result = save(input); controller.abort(); return result; };
  const runtime = new AgentRuntime({ store, attachmentIds: [item.file.id], signal: controller.signal, onApproval: () => true });
  const result = await execute(runtime, 'workspace_save_text_file', { id: item.file.id, content: 'committed exactly once', expectedSha256: item.preview.sha256 });
  assert.equal(result.ok, true); assert.equal(result.result.preview.text, 'committed exactly once'); assert.equal(writes, 1);
});

test('invalid, oversized, unknown and unsafe calls return stable tool errors without invoking approval', async t => {
  const { store } = fixture(t); let approvals = 0;
  const runtime = new AgentRuntime({ store, onApproval: () => { approvals++; return true; } });
  assert.equal((await runtime.execute(null)).error.code, 'invalid_tool_call');
  assert.equal((await execute(runtime, 'run_shell', { command: 'echo never' })).error.code, 'unknown_tool');
  for (const raw of ['{', 'null', '[]', '{"id":1}', '{"id":"file_1","path":"private"}', '{"__proto__":{}}', ' '.repeat(MAX_ARGUMENT_CHARS + 1)]) {
    const tool = call('workspace_read_file'); tool.function.arguments = raw;
    assert.equal((await runtime.execute(tool)).error.code, 'invalid_arguments');
  }
  for (const name of ['../escape.md', 'C:\\private.txt', 'CON.txt', 'run.exe', 'safe.txt\u202e']) assert.equal((await execute(runtime, 'workspace_create_text_file', { name, content: 'no' })).error.code, 'invalid_arguments');
  for (const content of ['bad\u0000text', '\ud800', 'x'.repeat(200001)]) assert.equal((await execute(runtime, 'workspace_create_text_file', { name: 'bad.md', content })).error.code, 'invalid_arguments');
  assert.equal(approvals, 0); assert.equal(store.snapshot().files.length, 0);
});

test('tool envelopes cannot invoke accessors and optional observers cannot mutate execution or leak failures', async t => {
  const { store } = fixture(t); let invoked = false;
  const hostile = { type: 'function', function: { name: 'workspace_list_files', arguments: '{}' } };
  Object.defineProperty(hostile, 'id', { get() { invoked = true; throw new Error('must not execute'); } });
  const runtime = new AgentRuntime({ store, onApproval: () => true, onToolEvent: () => Promise.reject(new Error('observer-only secret')) });
  assert.equal((await runtime.execute(hostile)).error.code, 'invalid_tool_call'); assert.equal(invoked, false);
  const result = await execute(runtime, 'workspace_create_text_file', { name: 'safe.txt', content: 'safe' }); assert.equal(result.ok, true);
  store.readFile = () => { throw new Error('C:\\private\\original.txt key-SYNTHETIC-do-not-return'); };
  const read = await execute(runtime, 'workspace_read_file', { id: result.result.file.id });
  assert.equal(read.error.code, 'read_unavailable'); assert.equal(JSON.stringify(read).includes('SYNTHETIC'), false); assert.equal(JSON.stringify(read).includes('private'), false);
});
