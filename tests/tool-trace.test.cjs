'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../backend/store.cjs');
const { normalizeToolTrace, traceHistory, cancelToolTrace, hasUnfinishedToolCalls, remapToolTrace, MAX_TRACE_BYTES, MAX_TRACE_ROUNDS, MAX_TRACE_CALLS } = require('../backend/tool-trace.cjs');

const done = (id, patch = {}) => ({ id, name: 'workspace_read_file', arguments: '{"fileId":"file_1"}', status: 'complete', result: '{"ok":true,"text":"original"}', ...patch });
const active = (id, status = 'running') => ({ id, name: 'workspace_write_file', arguments: '{"fileId":"file_1","content":"should not execute"}', status });
const round = (...calls) => ({ content: '', calls });
function fixture(t) {
  const scratch = path.resolve(__dirname, '.tmp'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'tool-trace-'));
  t.after(() => {
    assert.equal(path.dirname(root), scratch);
    assert.match(path.basename(root), /^tool-trace-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'data');
  return { root, dataDir, store: new Store(dataDir) };
}
function invalid(value) { assert.throws(() => normalizeToolTrace(value), /记录格式无效|容量限制/); }

test('normalizes detached trace data and emits exact assistant/tool wire pairs', () => {
  const source = [{ content: '先读取资料', calls: [done('call_1'), done('call_2', { name: 'workspace_list_files', arguments: '{}', status: 'denied', result: '{"ok":false,"error":{"code":"denied"}}' })] }, round(done('call_3', { status: 'error', result: 'read failed' }))];
  const normalized = normalizeToolTrace(source);
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source); assert.notEqual(normalized[0], source[0]); assert.notEqual(normalized[0].calls[0], source[0].calls[0]);
  assert.deepEqual(traceHistory(source), [
    { role: 'assistant', content: '先读取资料', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'workspace_read_file', arguments: source[0].calls[0].arguments } }, { id: 'call_2', type: 'function', function: { name: 'workspace_list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: source[0].calls[0].result },
    { role: 'tool', tool_call_id: 'call_2', content: source[0].calls[1].result },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'workspace_read_file', arguments: source[1].calls[0].arguments } }] },
    { role: 'tool', tool_call_id: 'call_3', content: 'read failed' }
  ]);
  assert.equal(hasUnfinishedToolCalls(source), false);
  assert.deepEqual(traceHistory([]), []);
});

test('an unfinished round never appears as executed history, including mixed complete/active calls', () => {
  for (const status of ['pending', 'running', 'awaiting_approval']) {
    const trace = [round(done('prior')), round(done('finished'), active('unfinished', status))];
    assert.equal(hasUnfinishedToolCalls(trace), true);
    assert.deepEqual(traceHistory(trace), traceHistory([trace[0]]));
    const cancelled = cancelToolTrace(trace);
    assert.equal(cancelled[1].calls[0].status, 'complete');
    assert.equal(cancelled[1].calls[0].result, trace[1].calls[0].result);
    assert.equal(cancelled[1].calls[1].status, 'cancelled');
    assert.equal(JSON.parse(cancelled[1].calls[1].result).ok, false);
    assert.equal(JSON.parse(cancelled[1].calls[1].result).error.code, 'cancelled');
    assert.equal(hasUnfinishedToolCalls(cancelled), false);
    assert.equal(traceHistory(cancelled).at(-1).tool_call_id, 'unfinished');
    assert.deepEqual(cancelToolTrace(cancelled), cancelled);
    assert.equal(Object.hasOwn(trace[1].calls[1], 'result'), false);
  }
});

test('rejects a forged active result and impossible rounds after an unfinished tool', () => {
  for (const status of ['pending', 'running', 'awaiting_approval']) {
    invalid([round({ ...active('call', status), result: '{"ok":true}' })]);
  }
  for (const status of ['complete', 'denied', 'error', 'cancelled']) {
    const call = done('call', { status }); delete call.result; invalid([round(call)]);
  }
  invalid([round(active('first')), round(done('later'))]);
});

test('rejects repeated call IDs within and across rounds and incorrect shapes', () => {
  invalid([round(done('same'), done('same'))]);
  invalid([round(done('same')), round(done('same'))]);
  for (const value of [null, {}, '[]', [null], [{}], [{ content: '', calls: [] }], [{ content: null, calls: [done('a')] }], [{ content: '', calls: [done('a')], unexpected: true }], [round({ ...done('a'), arguments: {} })], [round(done('white space'))], [round(done('control\u0001'))], [round(done('a', { name: 'bad.name' }))], [round(done('a', { name: 'x'.repeat(65) }))], [round(done('a', { status: 'unknown' }))], [round(done('a', { result: 7 }))], [round(done('a', { extra: true }))]]) invalid(value);
});

test('does not execute accessors, proxy traps or silently drop hidden data', () => {
  let effects = 0;
  const getter = done('a'); Object.defineProperty(getter, 'result', { enumerable: true, get() { effects++; return 'forged'; } });
  invalid([round(getter)]);
  const proxy = new Proxy(done('a'), { getPrototypeOf() { effects++; return Object.prototype; }, ownKeys() { effects++; return []; } });
  invalid([round(proxy)]);
  const hidden = done('a'); Object.defineProperty(hidden, 'hidden', { value: 'x' }); invalid([round(hidden)]);
  const symbol = done('a'); symbol[Symbol('hidden')] = 1; invalid([round(symbol)]);
  const inherited = Object.create(done('a')); invalid([round(inherited)]);
  const sparse = new Array(1); invalid(sparse);
  const extra = [round(done('a'))]; extra.extra = 1; invalid(extra);
  assert.equal(effects, 0);
});

test('enforces calls/rounds/field and UTF-8 byte limits', () => {
  invalid(Array.from({ length: MAX_TRACE_ROUNDS + 1 }, (_, index) => round(done(`call_${index}`))));
  invalid([round(...Array.from({ length: MAX_TRACE_CALLS + 1 }, (_, index) => done(`call_${index}`)))]);
  invalid([round(done('a', { arguments: 'x'.repeat(256001) }))]);
  invalid([round(done('a', { result: 'x'.repeat(128001) }))]);
  invalid([{ content: 'x'.repeat(2000001), calls: [done('a')] }]);
  invalid([{ content: '中'.repeat(1500000), calls: [done('a')] }]);
  assert.equal(normalizeToolTrace([round(...Array.from({ length: MAX_TRACE_CALLS }, (_, index) => done(`call_${index}`)))]).length, 1);
  // An accepted active record always has capacity for its explicit recovery
  // result. The fixture is close enough to the cap to expose missing reserves.
  const near = [{ content: 'x'.repeat(2000000), calls: [done('prior')] }, { content: 'x'.repeat(2000000), calls: [active('pending')] }];
  near[1].calls[0].arguments = '';
  const currentBytes = Buffer.byteLength(JSON.stringify(near));
  near[1].calls[0].arguments = 'x'.repeat(MAX_TRACE_BYTES - currentBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(near)), MAX_TRACE_BYTES);
  invalid(near); // Cancellation metadata would overflow the cap.
  near[1].calls[0].arguments = near[1].calls[0].arguments.slice(0, -2000);
  assert.ok(Buffer.byteLength(JSON.stringify(cancelToolTrace(near))) <= MAX_TRACE_BYTES);
});

test('Store persists tool traces through disk and backup without losing ordinary chat compatibility', async t => {
  const { store, dataDir, root } = fixture(t);
  const plain = store.createChat({ title: '普通聊天' });
  const user = store.appendMessage(plain.id, { role: 'user', content: '你好' });
  store.appendMessage(plain.id, { role: 'assistant', content: '普通回复' });
  const chat = store.createChat({ title: '工具聊天' });
  const trace = [round(done('call_persist'))];
  const assistant = store.appendMessage(chat.id, { role: 'assistant', content: '完成', agentMode: true, toolTrace: trace });
  const restarted = new Store(dataDir);
  assert.deepEqual(restarted.getChat(chat.id).messages[0].toolTrace, trace);
  assert.equal(restarted.getChat(plain.id).messages[0].id, user.id);
  assert.equal(Object.hasOwn(restarted.getChat(plain.id).messages[1], 'toolTrace'), false);
  const backup = restarted.exportData();
  assert.equal(backup.schemaVersion, 1);
  const destination = new Store(path.join(root, 'imported'));
  const imported = await destination.importData(backup);
  const importedMessage = imported.chats.find(item => item.title === '工具聊天').messages[0];
  assert.notEqual(importedMessage.id, assistant.id);
  assert.equal(importedMessage.agentMode, true);
  assert.deepEqual(importedMessage.toolTrace, trace);
  assert.deepEqual(traceHistory(importedMessage.toolTrace), traceHistory(trace));
  assert.equal(Object.hasOwn(imported.chats.find(item => item.title === '普通聊天').messages[0], 'agentMode'), false);
});

test('Store rejects wrong owners and invalid trace patches atomically', t => {
  const { store } = fixture(t), chat = store.createChat();
  assert.throws(() => store.appendMessage(chat.id, { role: 'user', content: '', agentMode: true, toolTrace: [] }));
  assert.throws(() => store.appendMessage(chat.id, { role: 'assistant', content: '', toolTrace: [] }));
  const message = store.appendMessage(chat.id, { role: 'assistant', content: 'kept', agentMode: true, toolTrace: [round(done('a'))] });
  const before = store.snapshot();
  assert.throws(() => store.updateMessage(chat.id, message.id, { toolTrace: [round(done('duplicate'), done('duplicate'))] }));
  assert.throws(() => store.updateMessage(chat.id, message.id, { agentMode: false }));
  assert.deepEqual(store.snapshot(), before);
});

test('startup cancels every interrupted call, preserves completed results and never replays writes', async t => {
  const { store, dataDir } = fixture(t), file = await store.createTextFile({ name: 'unchanged.txt', content: 'unchanged' });
  const chat = store.createChat();
  const trace = [round(done('finished')), round(active('pending', 'pending'), active('running'), active('approval', 'awaiting_approval'))];
  const assistant = store.appendMessage(chat.id, { role: 'assistant', content: '处理中', status: 'streaming', agentMode: true, toolTrace: trace });
  const filePath = store.filePath(file.file.id), beforeHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const restarted = new Store(dataDir), recovered = restarted.getChat(chat.id).messages.find(item => item.id === assistant.id);
  assert.equal(recovered.status, 'cancelled');
  assert.deepEqual(recovered.toolTrace[0], trace[0]);
  assert.deepEqual(recovered.toolTrace[1].calls.map(call => call.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(hasUnfinishedToolCalls(recovered.toolTrace), false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), beforeHash);
  assert.deepEqual(new Store(dataDir).getChat(chat.id).messages.find(item => item.id === assistant.id), recovered);
});

test('import and startup cancel orphan active calls even when the enclosing message is already cancelled', async t => {
  const { store, root } = fixture(t), chat = store.createChat();
  store.appendMessage(chat.id, { role: 'assistant', content: '', status: 'streaming', agentMode: true, toolTrace: [round(active('backup_active', 'awaiting_approval'))] });
  const backup = store.exportData();
  const destinationPath = path.join(root, 'destination'), destination = new Store(destinationPath);
  const imported = await destination.importData(backup), importedMessage = imported.chats[0].messages[0];
  assert.equal(importedMessage.status, 'cancelled');
  assert.equal(importedMessage.toolTrace[0].calls[0].status, 'cancelled');
  assert.equal(hasUnfinishedToolCalls(importedMessage.toolTrace), false);
  // Simulate an older interrupted snapshot whose parent was already cancelled.
  const statePath = path.join(destinationPath, 'state.json');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  raw.chats[0].messages[0].toolTrace = [round(active('orphan', 'running'))];
  fs.writeFileSync(statePath, JSON.stringify(raw));
  const restarted = new Store(destinationPath);
  assert.equal(restarted.getChat(imported.chats[0].id).messages[0].toolTrace[0].calls[0].status, 'cancelled');
});

test('invalid backup trace is rejected before mutating destination data', async t => {
  const { store, root } = fixture(t), chat = store.createChat();
  store.appendMessage(chat.id, { role: 'assistant', content: '', agentMode: true, toolTrace: [round(done('a'))] });
  const backup = store.exportData(), destination = new Store(path.join(root, 'destination'));
  destination.createChat({ title: 'kept' });
  const before = destination.snapshot();
  backup.chats[0].messages[0].toolTrace[0].calls.push(done('a'));
  await assert.rejects(destination.importData(backup));
  assert.deepEqual(destination.snapshot(), before);
});

test('remaps only known file/workspace identity slots and preserves tool pairing and document literals', () => {
  const fileIds = new Map([['file_old', 'file_new']]), workspaceIds = new Map([['ws_old', 'ws_new']]);
  const receipt = payload => JSON.stringify({ ok: true, result: payload });
  const file = { id: 'file_old', workspaceId: 'ws_old', name: 'file_old.txt' };
  const source = [{ content: 'file_old ws_old', calls: [
    done('list', { name: 'workspace_list_files', arguments: '{}', result: receipt({ files: [file, { id: 'unmapped', workspaceId: null }] }) }),
    done('read', { name: 'workspace_read_file', arguments: '{"id":"file_old"}', result: receipt({ id: 'file_old', text: 'literal file_old ws_old', name: 'file_old.txt' }) }),
    done('create', { name: 'workspace_create_text_file', arguments: '{"name":"file_old.txt","content":"literal file_old ws_old"}', result: receipt({ file, preview: { id: 'file_old', text: 'file_old' } }) }),
    done('save', { name: 'workspace_save_text_file', arguments: '{"id":"file_old","content":"file_old","expectedSha256":"unchanged"}', result: receipt({ file, preview: { id: 'file_old', text: 'file_old' } }) }),
    done('unknown', { name: 'unknown_tool', arguments: '{"id":"file_old"}', result: receipt({ id: 'file_old', file, files: [file] }) }),
    done('error', { name: 'workspace_read_file', arguments: '{"id":"unmapped"}', status: 'error', result: '{"ok":false,"error":{"message":"file_old ws_old"}}' })
  ] }];
  const mapped = remapToolTrace(source, { fileIds, workspaceIds });
  assert.equal(mapped[0].content, source[0].content);
  assert.deepEqual(mapped[0].calls.map(call => call.id), source[0].calls.map(call => call.id));
  const [list, read, create, save, unknown, error] = mapped[0].calls;
  assert.deepEqual(JSON.parse(list.result).result.files, [{ ...file, id: 'file_new', workspaceId: 'ws_new' }, { id: 'unmapped', workspaceId: null }]);
  assert.equal(JSON.parse(read.arguments).id, 'file_new');
  assert.deepEqual(JSON.parse(read.result).result, { id: 'file_new', text: 'literal file_old ws_old', name: 'file_old.txt' });
  assert.equal(create.arguments, source[0].calls[2].arguments);
  assert.deepEqual(JSON.parse(create.result).result, { file: { ...file, id: 'file_new', workspaceId: 'ws_new' }, preview: { id: 'file_new', text: 'file_old' } });
  assert.deepEqual(JSON.parse(save.arguments), { id: 'file_new', content: 'file_old', expectedSha256: 'unchanged' });
  assert.equal(JSON.parse(save.result).result.file.workspaceId, 'ws_new');
  assert.deepEqual(unknown, source[0].calls[4]); assert.deepEqual(error, source[0].calls[5]);
  assert.equal(traceHistory(mapped).at(-1).tool_call_id, 'error');
  assert.equal(JSON.parse(source[0].calls[1].arguments).id, 'file_old');
});

test('remapping retains malformed/unknown payloads and unmapped IDs as opaque history', () => {
  const source = [round(done('a', { arguments: 'not json', result: '{"ok":true,"result":{"id":"missing"}}' }), done('b', { arguments: '{"id":"missing"}', result: '{"id":"missing"}' }))];
  assert.deepEqual(remapToolTrace(source, { fileIds: new Map([['other', 'new']]), workspaceIds: new Map() }), source);
  assert.throws(() => remapToolTrace(source, { fileIds: {} }));
});

test('backup remaps actual managed file and workspace IDs while preserving history text', async t => {
  const { store, root } = fixture(t), workspace = store.createWorkspace({ name: '空间' });
  const created = await store.createTextFile({ name: 'retained.txt', content: 'plain', workspaceId: workspace.id });
  const oldId = created.file.id, chat = store.createChat({ workspaceId: workspace.id });
  const trace = [round(done('actual_read', { arguments: JSON.stringify({ id: oldId }), result: JSON.stringify({ ok: true, result: { id: oldId, text: `literal ${oldId}` } }) }), done('actual_list', { name: 'workspace_list_files', arguments: '{}', result: JSON.stringify({ ok: true, result: { files: [{ id: oldId, workspaceId: workspace.id, name: oldId }] } }) }))];
  store.appendMessage(chat.id, { role: 'assistant', content: `literal ${oldId}`, agentMode: true, toolTrace: trace });
  const destination = new Store(path.join(root, 'destination'));
  const imported = await destination.importData(store.exportData()), newFile = imported.files[0], message = imported.chats[0].messages[0];
  assert.notEqual(newFile.id, oldId); assert.notEqual(newFile.workspaceId, workspace.id);
  assert.equal(JSON.parse(message.toolTrace[0].calls[0].arguments).id, newFile.id);
  assert.deepEqual(JSON.parse(message.toolTrace[0].calls[1].result).result.files, [{ id: newFile.id, workspaceId: newFile.workspaceId, name: oldId }]);
  assert.equal(message.content, `literal ${oldId}`);
  assert.equal(JSON.parse(message.toolTrace[0].calls[0].result).result.text, `literal ${oldId}`);
});
