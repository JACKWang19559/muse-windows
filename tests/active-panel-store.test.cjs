'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { createActivePanel } = require('../backend/active-panel.cjs');
function fixture(t) {
  const parent = path.resolve(__dirname, '../.test-tmp/active-panel-store'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-panel-')), dataDir = path.join(root, 'data');
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), parent); assert.match(path.basename(root), /^synthetic-panel-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { store: new Store(dataDir), root, dataDir };
}
function selected(store) {
  const workspace = store.createWorkspace({ name: '引用测试工作区' });
  const artifact = store.createArtifact({ name: '引用测试应用', runtime: 'html', workspaceId: workspace.id });
  const chat = store.createChat({ title: '引用测试对话', workspaceId: workspace.id });
  return { workspace, artifact, chat, panel: createActivePanel({ artifact }) };
}
const durable = store => [store.statePath, store.backupPath].map(file => fs.readFileSync(file, 'utf8'));
function unchanged(store, state, files) { assert.deepEqual(store.state, state); assert.deepEqual(durable(store), files); }

test('user-only current-app reference is detached from callers and survives restart independently of visible content', t => {
  const { store, dataDir } = fixture(t), s = selected(store), expected = structuredClone(s.panel);
  const sent = store.appendMessage(s.chat.id, { role: 'user', content: 'VISIBLE_PANEL_NOTE', activePanel: s.panel });
  s.panel.artifactName = 'caller changed'; sent.activePanel.artifactId = 'artifact_changed';
  const saved = store.getChat(s.chat.id).messages[0]; assert.deepEqual(saved.activePanel, expected); assert.equal(saved.content, 'VISIBLE_PANEL_NOTE');
  assert.equal(saved.content.includes(expected.artifactId), false); assert.deepEqual(new Store(dataDir).getChat(s.chat.id).messages[0], saved);
  const state = structuredClone(store.state), files = durable(store);
  for (const role of ['assistant', 'system']) { assert.throws(() => store.appendMessage(s.chat.id, { role, content: 'rejected', activePanel: expected })); unchanged(store, state, files); }
});
test('captured active panel is immutable through message update while delivery state may change', t => {
  const { store } = fixture(t), s = selected(store), sent = store.appendMessage(s.chat.id, { role: 'user', content: 'one', activePanel: s.panel });
  const ordinary = store.appendMessage(s.chat.id, { role: 'user', content: 'two' }), state = structuredClone(store.state), files = durable(store);
  for (const [id, activePanel] of [[sent.id, { ...s.panel, artifactId: 'other_artifact' }], [sent.id, null], [ordinary.id, s.panel]]) {
    assert.throws(() => store.updateMessage(s.chat.id, id, { activePanel })); unchanged(store, state, files);
  }
  const updated = store.updateMessage(s.chat.id, sent.id, { status: 'cancelled' }); assert.equal(updated.status, 'cancelled'); assert.deepEqual(updated.activePanel, s.panel);
});
test('deleting a user message scrubs current-app history in primary, recovery and exported copies', t => {
  const { store, dataDir } = fixture(t), s = selected(store), panel = { ...s.panel, artifactName: 'DELETE_PANEL_NAME_SENTINEL' };
  const sent = store.appendMessage(s.chat.id, { role: 'user', content: 'DELETE_PANEL_NOTE_SENTINEL', activePanel: panel });
  store.deleteTurn({ chatId: s.chat.id, messageId: sent.id }); const tomb = store.getChat(s.chat.id).messages[0];
  assert.equal(tomb.isDeleted, true); assert.equal(tomb.content, ''); assert.equal('activePanel' in tomb, false);
  for (const data of [...durable(store), JSON.stringify(store.exportData())]) { assert.equal(data.includes('DELETE_PANEL_NAME_SENTINEL'), false); assert.equal(data.includes('DELETE_PANEL_NOTE_SENTINEL'), false); }
  assert.deepEqual(new Store(dataDir).getChat(s.chat.id).messages[0], tomb);
});
test('backup remaps only a restored artifact ID and preserves text, saved name and ordinary reply identities', async t => {
  const a = fixture(t), b = fixture(t), s = selected(a.store), name = `Saved name containing ${s.artifact.id}`;
  const sent = a.store.appendMessage(s.chat.id, { role: 'user', content: `note ${s.artifact.id}`, activePanel: { ...s.panel, artifactName: name } });
  a.store.appendMessage(s.chat.id, { role: 'user', content: 'reply note', replyToMessageId: sent.id, activePanel: s.panel });
  const backup = a.store.exportData(), before = structuredClone(backup); await b.store.importData(backup); assert.deepEqual(backup, before);
  const state = b.store.snapshot(), artifact = state.artifacts[0], chat = state.chats[0], message = chat.messages[0];
  assert.notEqual(artifact.id, s.artifact.id); assert.equal(message.activePanel.artifactId, artifact.id); assert.equal(message.activePanel.artifactName, name);
  assert.equal(message.content, `note ${s.artifact.id}`); assert.equal(chat.messages[1].replyTo.messageId, message.id);
  assert.equal(chat.messages[1].activePanel.artifactId, artifact.id); assert.equal(chat.workspaceId, artifact.workspaceId);
  assert.deepEqual(new Store(b.dataDir).getChat(chat.id).messages, chat.messages);
});
test('removed-app history remains descriptive during merge and never creates or binds to a same-name local app', async t => {
  const a = fixture(t), b = fixture(t), s = selected(a.store);
  a.store.appendMessage(s.chat.id, { role: 'user', content: 'historic reference', activePanel: s.panel }); a.store.deleteArtifact(s.artifact.id);
  assert.deepEqual(a.store.getChat(s.chat.id).messages[0].activePanel, s.panel); const backup = a.store.exportData(); assert.deepEqual(backup.artifacts, []);
  const local = b.store.createArtifact({ name: s.panel.artifactName, runtime: 'html' }); await b.store.importData(backup);
  const state = b.store.snapshot(), panel = state.chats[0].messages[0].activePanel;
  assert.equal(state.artifacts.length, 1); assert.deepEqual(panel, s.panel); assert.notEqual(panel.artifactId, local.id); assert.throws(() => b.store.getArtifact(panel.artifactId));
});
test('current panel coexists with separate annotation and reply snapshots without becoming a live app relation', t => {
  const { store, dataDir } = fixture(t), s = selected(store), base = store.appendMessage(s.chat.id, { role: 'user', content: 'reply target' });
  const annotation = { kind: 'artifact_element', artifactId: 'artifact_historical', artifactName: '历史注释', buildId: 'build_historical', sourceRevision: 1, pagePath: 'index.html',
    element: { tag: 'p', id: '', classes: [], text: 'selected', path: 'body > p', viewport: { width: 100, height: 100 }, click: { x: 2, y: 3 } } };
  const sent = store.appendMessage(s.chat.id, { role: 'user', content: 'visible note', replyToMessageId: base.id, artifactContext: annotation, activePanel: s.panel });
  assert.deepEqual(sent.artifactContext, annotation); assert.deepEqual(sent.activePanel, s.panel); assert.equal(sent.replyTo.messageId, base.id);
  store.deleteArtifact(s.artifact.id); assert.deepEqual(new Store(dataDir).getChat(s.chat.id).messages[1], sent);
});
test('invalid append references are atomically rejected and do not invoke nested accessors', t => {
  const { store } = fixture(t), s = selected(store), state = structuredClone(store.state), files = durable(store);
  for (const panel of [{ ...s.panel, kind: 'screenshot' }, { ...s.panel, artifactId: '../x' }, { ...s.panel, artifactName: 'x\n' },
    { ...s.panel, artifactName: '\ud800' }, { ...s.panel, artifactName: 'a'.repeat(161) }, { ...s.panel, permissions: ['write'] }, new Proxy(s.panel, {})]) {
    assert.throws(() => store.appendMessage(s.chat.id, { role: 'user', content: 'rejected', activePanel: panel })); unchanged(store, state, files);
  }
  let reads = 0; const accessor = { ...s.panel }; Object.defineProperty(accessor, 'artifactName', { enumerable: true, get() { reads++; return 'never'; } });
  assert.throws(() => store.appendMessage(s.chat.id, { role: 'user', content: 'rejected', activePanel: accessor })); assert.equal(reads, 0); unchanged(store, state, files);
});
test('invalid, assistant and deleted backup references reject the full merge before changing destination data', async t => {
  const a = fixture(t), b = fixture(t), s = selected(a.store); a.store.appendMessage(s.chat.id, { role: 'user', content: 'source note', activePanel: s.panel });
  b.store.createChat({ title: 'existing data' }); const backup = a.store.exportData(), state = structuredClone(b.store.state), files = durable(b.store);
  for (const mutate of [m => { m.activePanel.artifactName = '\u202e'; }, m => { m.activePanel.artifactId = 'bad/path'; },
    m => { m.activePanel.source = '<html>'; }, m => { m.role = 'assistant'; }, m => { m.isDeleted = true; m.content = ''; }]) {
    const malformed = structuredClone(backup); mutate(malformed.chats[0].messages[0]); await assert.rejects(b.store.importData(malformed)); unchanged(b.store, state, files);
  }
});
test('ordinary old-schema messages and deleted references survive import without invented metadata', async t => {
  const a = fixture(t), b = fixture(t), s = selected(a.store), ordinary = a.store.appendMessage(s.chat.id, { role: 'user', content: 'ordinary' });
  const removed = a.store.appendMessage(s.chat.id, { role: 'user', content: 'removed', activePanel: s.panel }); a.store.deleteTurn({ chatId: s.chat.id, messageId: removed.id });
  assert.equal('activePanel' in new Store(a.dataDir).getChat(s.chat.id).messages.find(m => m.id === ordinary.id), false);
  await b.store.importData(a.store.exportData()); const messages = b.store.snapshot().chats[0].messages;
  assert.equal('activePanel' in messages[0], false); assert.equal(messages[1].isDeleted, true); assert.equal('activePanel' in messages[1], false);
});
