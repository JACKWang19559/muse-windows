'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');

function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'message-admission-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^message-admission-/); fs.rmSync(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data');
  return { root, dataDir, store: new Store(dataDir) };
}
const append = (store, chatId, role, content, extra = {}) => store.appendMessage(chatId, { role, content, ...extra });
const trace = status => [{ content: '', calls: [{ id: 'tool_once', name: 'workspace_create_text_file', arguments: '{"name":"written.md","content":"done"}', status, ...(['complete', 'denied', 'error', 'cancelled'].includes(status) ? { result: status === 'complete' ? '{"ok":true,"result":{"file":{"id":"file_receipt"}}}' : JSON.stringify({ ok: false, error: { code: status } }) } : {}) }] }];

test('rolls back only the exact admitted user/assistant suffix, preserving files, older history and other chats', async t => {
  const { store, dataDir } = fixture(t), workspace = store.createWorkspace({ name: '保留资料' });
  const file = await store.createTextFile({ name: 'kept.md', content: '# Keep the file', workspaceId: workspace.id });
  const chat = store.createChat({ workspaceId: workspace.id }), other = store.createChat({ title: '不要修改' });
  append(store, chat.id, 'user', 'older'); append(store, chat.id, 'assistant', 'older answer');
  append(store, other.id, 'user', 'other history');
  const before = store.snapshot(), otherBefore = store.getChat(other.id);
  const user = append(store, chat.id, 'user', 'not dispatched', { attachmentIds: [file.file.id] });
  const assistant = append(store, chat.id, 'assistant', '', { status: 'streaming', agentMode: true, toolTrace: [] });
  const result = store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [user.id, assistant.id] });
  assert.deepEqual(result.messages, before.chats.find(item => item.id === chat.id).messages);
  assert.deepEqual(store.getChat(other.id), otherBefore); assert.deepEqual(store.snapshot().files, before.files); assert.deepEqual(store.snapshot().workspaces, before.workspaces);
  assert.equal(store.readFile(file.file.id).text, '# Keep the file');
  result.messages[0].content = 'mutated return'; assert.equal(store.getChat(chat.id).messages[0].content, 'older');
  assert.deepEqual(new Store(dataDir).getChat(chat.id), store.getChat(chat.id));
});

test('one-message admission rollback leaves no phantom request in either durable copy', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat();
  const user = append(store, chat.id, 'user', 'UNSENT-SYNTHETIC-TEXT');
  const result = store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [user.id] });
  assert.deepEqual(result.messages, []);
  for (const filename of ['state.json', 'state.backup.json']) assert.equal(fs.readFileSync(path.join(dataDir, filename), 'utf8').includes('UNSENT-SYNTHETIC-TEXT'), false);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{corrupt synthetic primary');
  const recovered = new Store(dataDir); assert.deepEqual(recovered.getChat(chat.id).messages, []);
});

test('rejects missing, reordered, duplicated, non-suffix or oversized selections without changing memory or disk', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat(), other = store.createChat();
  const a = append(store, chat.id, 'user', 'a'), b = append(store, chat.id, 'assistant', 'b'), c = append(store, chat.id, 'user', 'c');
  const baseline = store.snapshot(), disk = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  for (const messageIds of [[], [a.id], [b.id], [c.id, b.id], [a.id, c.id], [c.id, c.id], [a.id, b.id, c.id], ['missing'], ['../path'], [null], new Array(1)]) {
    assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds }));
    assert.deepEqual(store.snapshot(), baseline); assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), disk);
  }
  assert.throws(() => store.rollbackUnsentMessages({ chatId: other.id, messageIds: [c.id] }));
  assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [c.id], dispatched: false }));
  assert.deepEqual(store.snapshot(), baseline);
});

test('protects every nonempty tool trace, including a still-active or cancelled receipt', t => {
  const { store } = fixture(t);
  for (const status of ['complete', 'denied', 'error', 'cancelled', 'pending', 'running', 'awaiting_approval']) {
    const chat = store.createChat(), user = append(store, chat.id, 'user', 'request');
    const assistant = append(store, chat.id, 'assistant', '', { status: 'streaming', agentMode: true, toolTrace: trace(status) });
    const baseline = store.snapshot();
    assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [assistant.id] }), /工具执行记录/);
    assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [user.id, assistant.id] }), /工具执行记录/);
    assert.deepEqual(store.snapshot(), baseline);
  }
});

test('refuses to remove a target even when the referencing message is in the same selected suffix', t => {
  const { store } = fixture(t), chat = store.createChat();
  append(store, chat.id, 'user', 'earlier');
  const target = append(store, chat.id, 'assistant', 'referenced assistant');
  const reply = append(store, chat.id, 'user', 'reply', { replyToMessageId: target.id });
  const baseline = store.snapshot();
  assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [target.id, reply.id] }), /其它消息引用/);
  assert.deepEqual(store.snapshot(), baseline);
});

test('retains earlier quote snapshots and does not confuse repeated message IDs in another chat', t => {
  const { store } = fixture(t), a = store.createChat(), b = store.createChat();
  const targetA = append(store, a.id, 'assistant', 'A target', { id: 'same_id' });
  const replyA = append(store, a.id, 'user', 'A quote', { replyToMessageId: targetA.id });
  append(store, b.id, 'assistant', 'B target', { id: 'same_id' });
  append(store, b.id, 'user', 'B quote', { replyToMessageId: 'same_id' });
  const beforeB = store.getChat(b.id);
  store.rollbackUnsentMessages({ chatId: a.id, messageIds: [replyA.id] });
  assert.deepEqual(store.getChat(a.id).messages, [targetA]); assert.deepEqual(store.getChat(b.id), beforeB);
  // B's reference to its own same_id must not block removing A's same_id.
  store.rollbackUnsentMessages({ chatId: a.id, messageIds: [targetA.id] });
  assert.deepEqual(store.getChat(a.id).messages, []); assert.deepEqual(store.getChat(b.id), beforeB);
});

test('a persistence failure cannot mutate the in-memory chat or lose its durable suffix', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat();
  const user = append(store, chat.id, 'user', 'retained after failed cleanup'), assistant = append(store, chat.id, 'assistant', '', { status: 'error' });
  const baseline = store.snapshot(), primary = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), backup = fs.readFileSync(path.join(dataDir, 'state.backup.json'), 'utf8');
  const persist = store._persistState;
  store._persistState = () => { throw new Error('synthetic admission persistence failure'); };
  try { assert.throws(() => store.rollbackUnsentMessages({ chatId: chat.id, messageIds: [user.id, assistant.id] }), /synthetic admission persistence failure/); }
  finally { store._persistState = persist; }
  assert.deepEqual(store.snapshot(), baseline); assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), primary); assert.equal(fs.readFileSync(path.join(dataDir, 'state.backup.json'), 'utf8'), backup);
  assert.deepEqual(new Store(dataDir).getChat(chat.id), store.getChat(chat.id));
});
