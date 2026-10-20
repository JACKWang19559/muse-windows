'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');

function fixture(t) {
  const scratch = path.resolve(__dirname, '.tmp'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'chat-lifecycle-'));
  t.after(() => { assert.equal(path.dirname(root), scratch); assert.match(path.basename(root), /^chat-lifecycle-/); fs.rmSync(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data');
  return { root, dataDir, store: new Store(dataDir) };
}
const trace = [{ content: '创建资料', calls: [{ id: 'committed_file_write', name: 'workspace_create_text_file', arguments: '{"name":"saved.md","content":"keep this committed write"}', status: 'complete', result: '{"ok":true,"result":{"file":{"id":"file_receipt","name":"saved.md"}}}' }] }];

test('reply input creates a detached same-chat snapshot for earlier user and assistant messages', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat();
  const first = store.appendMessage(chat.id, { role: 'user', content: '原始问题' });
  const answer = store.appendMessage(chat.id, { role: 'assistant', content: '可供引用的回答' });
  const toUser = store.appendMessage(chat.id, { role: 'user', content: '补充', replyToMessageId: first.id });
  const toAssistant = store.appendMessage(chat.id, { role: 'user', content: '追问', replyToMessageId: answer.id });
  assert.deepEqual(toUser.replyTo, { messageId: first.id, role: 'user', excerpt: first.content });
  assert.deepEqual(toAssistant.replyTo, { messageId: answer.id, role: 'assistant', excerpt: answer.content });
  assert.equal(Object.hasOwn(toAssistant, 'replyToMessageId'), false);
  toAssistant.replyTo.excerpt = 'observer mutation'; store.updateMessage(chat.id, answer.id, { content: '后续内容' });
  assert.equal(store.getChat(chat.id).messages.at(-1).replyTo.excerpt, '可供引用的回答');
  const restarted = new Store(dataDir); assert.deepEqual(restarted.getChat(chat.id).messages.at(-1).replyTo, { messageId: answer.id, role: 'assistant', excerpt: '可供引用的回答' });
});

test('reply excerpts stop at 2000 UTF-16 characters without splitting a surrogate pair', t => {
  const { store } = fixture(t), chat = store.createChat();
  const target = store.appendMessage(chat.id, { role: 'assistant', content: 'x'.repeat(1999) + '😀tail' });
  const reply = store.appendMessage(chat.id, { role: 'user', content: 'follow', replyToMessageId: target.id });
  assert.equal(reply.replyTo.excerpt, 'x'.repeat(1999)); assert.ok(reply.replyTo.excerpt.length <= 2000);
  assert.equal(Buffer.from(reply.replyTo.excerpt).toString('utf8'), reply.replyTo.excerpt);
});

test('reply admission rejects self, cross-chat, future, deleted, streaming and forged snapshots without mutation', t => {
  const { store } = fixture(t), chat = store.createChat(), other = store.createChat();
  const target = store.appendMessage(chat.id, { role: 'user', content: 'will be deleted' });
  const foreign = store.appendMessage(other.id, { role: 'assistant', content: 'foreign' });
  const streaming = store.appendMessage(chat.id, { role: 'assistant', content: 'partial', status: 'streaming' });
  store.deleteTurn({ chatId: chat.id, messageId: target.id });
  const before = JSON.stringify(store.snapshot());
  for (const patch of [
    { id: 'self_id', replyToMessageId: 'self_id' }, { replyToMessageId: 'future_message' }, { replyToMessageId: foreign.id },
    { replyToMessageId: target.id }, { replyToMessageId: streaming.id }, { replyToMessageId: '../escape' }, { replyToMessageId: 7 },
    { role: 'assistant', replyToMessageId: foreign.id }, { replyTo: { messageId: target.id, role: 'user', excerpt: 'forged' } }, { isDeleted: true }
  ]) { assert.throws(() => store.appendMessage(chat.id, { role: 'user', content: 'follow', ...patch })); assert.equal(JSON.stringify(store.snapshot()), before); }
});

test('selected user deletion keeps identity/order and committed assistant receipts, clearing only its own surfaces', async t => {
  const { store } = fixture(t), chat = store.createChat(), file = (await store.createTextFile({ name: 'attached.md', content: 'attachment survives' })).file;
  const prior = store.appendMessage(chat.id, { role: 'assistant', content: 'prior assistant' });
  const selected = store.appendMessage(chat.id, { role: 'user', content: 'delete this body', attachmentIds: [file.id], replyToMessageId: prior.id, error: 'private failed-send detail' });
  const receipt = store.appendMessage(chat.id, { role: 'assistant', content: 'already performed', agentMode: true, toolTrace: trace });
  const later = store.appendMessage(chat.id, { role: 'user', content: 'later turn', replyToMessageId: selected.id });
  const result = store.deleteTurn({ chatId: chat.id, messageId: selected.id }), updated = result.chat.messages[1];
  assert.deepEqual(result.deletedMessageIds, [selected.id]);
  assert.deepEqual(updated, { id: selected.id, role: 'user', content: '', createdAt: selected.createdAt, status: 'complete', isDeleted: true });
  assert.deepEqual(result.chat.messages.map(message => message.id), [prior.id, selected.id, receipt.id, later.id]);
  assert.deepEqual(result.chat.messages[2], receipt); assert.deepEqual(result.chat.messages[3].replyTo, { messageId: selected.id, role: 'user', excerpt: '' });
  assert.equal(store.readFile(file.id).text, 'attachment survives'); assert.equal(store.snapshot().files.length, 1);
  assert.deepEqual(store.deleteTurn({ chatId: chat.id, messageId: selected.id }).chat.messages, result.chat.messages);
});

test('deleted body and quoted copies are scrubbed from current state, automatic backup and future exports', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat(), body = 'UNIQUE_DELETED_BODY_FIXTURE_7951';
  const selected = store.appendMessage(chat.id, { role: 'user', content: body });
  store.appendMessage(chat.id, { role: 'user', content: 'ref one', replyToMessageId: selected.id });
  store.appendMessage(chat.id, { role: 'assistant', content: 'unrelated retained reply' });
  store.appendMessage(chat.id, { role: 'user', content: 'ref two', replyToMessageId: selected.id });
  const oldManualBackup = store.exportData();
  store.deleteTurn({ chatId: chat.id, messageId: selected.id });
  for (const value of [store.snapshot(), store.exportData(), JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dataDir, 'state.backup.json'), 'utf8'))]) assert.equal(JSON.stringify(value).includes(body), false);
  assert.equal(JSON.stringify(oldManualBackup).includes(body), true); // Existing external exports are not retroactively edited.
  const restarted = new Store(dataDir); assert.equal(restarted.getChat(chat.id).messages[0].isDeleted, true); assert.equal(restarted.getChat(chat.id).messages[1].replyTo.excerpt, '');
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{bad primary');
  const recovered = new Store(dataDir); assert.equal(recovered.getChat(chat.id).messages[0].isDeleted, true); assert.equal(JSON.stringify(recovered.exportData()).includes(body), false);
});

test('delete rejects assistant, absent and foreign ids and tombstones cannot be resurrected with patches', t => {
  const { store } = fixture(t), chat = store.createChat(), other = store.createChat();
  const user = store.appendMessage(chat.id, { role: 'user', content: 'body' }), assistant = store.appendMessage(chat.id, { role: 'assistant', content: 'answer', agentMode: true, toolTrace: trace }), foreign = store.appendMessage(other.id, { role: 'user', content: 'foreign' });
  const baseline = JSON.stringify(store.snapshot());
  for (const input of [{ chatId: chat.id, messageId: assistant.id }, { chatId: chat.id, messageId: 'missing' }, { chatId: chat.id, messageId: foreign.id }, { chatId: '../escape', messageId: user.id }, { chatId: chat.id, messageId: user.id, truncate: true }]) { assert.throws(() => store.deleteTurn(input)); assert.equal(JSON.stringify(store.snapshot()), baseline); }
  store.deleteTurn({ chatId: chat.id, messageId: user.id });
  for (const patch of [{ content: 'resurrected' }, { isDeleted: false }, { attachmentIds: [] }, { replyTo: { messageId: assistant.id, role: 'assistant', excerpt: 'forged' } }, { error: 'deleted content' }, { status: 'streaming' }]) assert.throws(() => store.updateMessage(chat.id, user.id, patch));
  assert.deepEqual(store.getChat(chat.id).messages[1], assistant);
});

test('backup import remaps quote targets per chat while preserving snapshots, tombstones and tool receipts', async t => {
  const { store, root } = fixture(t), chat = store.createChat({ title: 'quoted chat' }), first = store.appendMessage(chat.id, { role: 'user', content: 'deleted' });
  store.appendMessage(chat.id, { role: 'assistant', content: 'committed result', agentMode: true, toolTrace: trace });
  const assistant = store.appendMessage(chat.id, { role: 'assistant', content: 'answer snapshot' });
  store.appendMessage(chat.id, { role: 'user', content: 'quote deleted', replyToMessageId: first.id });
  store.appendMessage(chat.id, { role: 'user', content: 'quote assistant', replyToMessageId: assistant.id });
  store.deleteTurn({ chatId: chat.id, messageId: first.id });
  const target = new Store(path.join(root, 'other-data')), existing = target.createChat({ title: 'keep existing' });
  const result = await target.importData(store.exportData()), imported = result.chats.find(item => item.id !== existing.id);
  assert.notEqual(imported.id, chat.id); assert.equal(imported.messages[0].isDeleted, true);
  assert.deepEqual(imported.messages[3].replyTo, { messageId: imported.messages[0].id, role: 'user', excerpt: '' });
  assert.deepEqual(imported.messages[4].replyTo, { messageId: imported.messages[2].id, role: 'assistant', excerpt: 'answer snapshot' });
  assert.equal(imported.messages.every(message => !store.getChat(chat.id).messages.some(old => old.id === message.id)), true);
  assert.deepEqual(imported.messages[1].toolTrace, trace); assert.equal(target.getChat(existing.id).messages.length, 0);
  const restarted = new Store(target.dataDir); assert.deepEqual(restarted.getChat(imported.id).messages, imported.messages);
});

test('backup validation rejects dangling, future, cross-chat, forged-role and oversized quote state before writes', async t => {
  const { store, dataDir } = fixture(t), chat = store.createChat(), target = store.appendMessage(chat.id, { role: 'assistant', content: 'target' });
  store.appendMessage(chat.id, { role: 'user', content: 'reply', replyToMessageId: target.id });
  const other = store.createChat(), foreign = store.appendMessage(other.id, { role: 'assistant', content: 'foreign' }), original = store.exportData(), before = JSON.stringify(store.snapshot()), files = fs.readdirSync(store.attachmentsDir);
  const invalid = [
    data => { data.chats[0].messages[1].replyTo.messageId = 'missing'; },
    data => { data.chats[0].messages[0] = { ...data.chats[0].messages[0], role: 'user', replyTo: { messageId: data.chats[0].messages[1].id, role: 'user', excerpt: 'future' } }; },
    data => { data.chats[0].messages[1].replyTo.messageId = foreign.id; },
    data => { data.chats[0].messages[1].replyTo.messageId = data.chats[0].messages[1].id; },
    data => { data.chats[0].messages[1].replyTo.role = 'user'; },
    data => { data.chats[0].messages[1].replyTo.excerpt = 'x'.repeat(2001); },
    data => { data.chats[0].messages[1].replyTo.path = 'private'; },
    data => { data.chats[0].messages[1].role = 'assistant'; },
    data => { data.chats[0].messages[1].replyToMessageId = target.id; }
  ];
  for (const modify of invalid) { const data = structuredClone(original); modify(data); await assert.rejects(store.importData(data)); assert.equal(JSON.stringify(store.snapshot()), before); assert.deepEqual(fs.readdirSync(store.attachmentsDir), files); }
  assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
});

test('forged tombstones cannot retain body, attachments, errors, references or deleted-target excerpts in backup import', async t => {
  const { store } = fixture(t), chat = store.createChat(), selected = store.appendMessage(chat.id, { role: 'user', content: 'to delete' });
  store.appendMessage(chat.id, { role: 'user', content: 'quote', replyToMessageId: selected.id }); store.deleteTurn({ chatId: chat.id, messageId: selected.id });
  const original = store.exportData(), baseline = JSON.stringify(store.snapshot());
  const invalid = [
    data => { data.chats[0].messages[0].content = 'old deleted body'; },
    data => { data.chats[0].messages[0].attachmentIds = []; },
    data => { data.chats[0].messages[0].error = 'old deleted body'; },
    data => { data.chats[0].messages[0].status = 'streaming'; },
    data => { data.chats[0].messages[0].isDeleted = 'true'; },
    data => { data.chats[0].messages[1].replyTo.excerpt = 'old deleted body'; },
    data => { data.chats[0].messages[0].replyTo = { messageId: data.chats[0].messages[1].id, role: 'user', excerpt: '' }; }
  ];
  for (const modify of invalid) { const data = structuredClone(original); modify(data); await assert.rejects(store.importData(data)); assert.equal(JSON.stringify(store.snapshot()), baseline); }
});

test('schema-v1 states and backups without lifecycle fields restore unchanged', async t => {
  const { store, dataDir, root } = fixture(t), chat = store.createChat(), user = store.appendMessage(chat.id, { role: 'user', content: 'legacy user' }), answer = store.appendMessage(chat.id, { role: 'assistant', content: 'legacy answer' });
  const restarted = new Store(dataDir); assert.deepEqual(restarted.getChat(chat.id).messages, [user, answer]);
  const other = new Store(path.join(root, 'legacy-import')); await other.importData(store.exportData());
  assert.deepEqual(other.snapshot().chats[0].messages.map(({ id, ...message }) => message), [user, answer].map(({ id, ...message }) => message));
});

test('automatic-backup write failure honestly rejects deletion and leaves primary and memory intact', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat(), selected = store.appendMessage(chat.id, { role: 'user', content: 'NOT_COMMITTED_DELETE' });
  const before = JSON.stringify(store.getChat(chat.id)), primaryBefore = fs.readFileSync(store.statePath, 'utf8'), write = store._writeSynced;
  store._writeSynced = function (filename, bytes) { if (path.basename(filename).startsWith('.backup-')) throw Object.assign(new Error('mock backup failure'), { code: 'EIO' }); return write.call(this, filename, bytes); };
  assert.throws(() => store.deleteTurn({ chatId: chat.id, messageId: selected.id }), /无法保存/); store._writeSynced = write;
  assert.equal(JSON.stringify(store.getChat(chat.id)), before); assert.equal(fs.readFileSync(store.statePath, 'utf8'), primaryBefore); assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
  assert.equal(new Store(dataDir).getChat(chat.id).messages[0].content, selected.content);
});

test('primary rename failure after a scrubbed backup returns an error without losing uncommitted data', t => {
  const { store, dataDir } = fixture(t), chat = store.createChat(), selected = store.appendMessage(chat.id, { role: 'user', content: 'PRIMARY_STILL_HAS_UNCOMMITTED_BODY' });
  const baseline = store.getChat(chat.id), rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === store.statePath && path.basename(from).startsWith('.state-')) throw Object.assign(new Error('mock primary rename failure'), { code: 'EIO' }); return rename.call(this, from, to); };
  try { assert.throws(() => store.deleteTurn({ chatId: chat.id, messageId: selected.id }), /无法保存/); } finally { fs.renameSync = rename; }
  assert.deepEqual(store.getChat(chat.id), baseline); assert.equal(JSON.parse(fs.readFileSync(store.statePath, 'utf8')).chats[0].messages[0].content, selected.content);
  assert.equal(JSON.parse(fs.readFileSync(store.backupPath, 'utf8')).chats[0].messages[0].isDeleted, true); assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
  const restarted = new Store(dataDir); assert.equal(restarted.getChat(chat.id).messages[0].content, selected.content);
  assert.equal(restarted.deleteTurn({ chatId: chat.id, messageId: selected.id }).chat.messages[0].isDeleted, true);
});
