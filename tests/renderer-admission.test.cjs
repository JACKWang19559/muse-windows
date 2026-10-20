'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');

// Exercise the actual App action closures, not a copy of send/recovery logic.
// Only the presentation suffix is replaced with an observation seam. Hook
// setters stay queued until render(), allowing several IPC microtasks to finish
// before a paint. Electron desktop tests separately cover real React and DOM.
const appSource = fs.readFileSync(path.resolve(__dirname, '../renderer/App.jsx'), 'utf8');
const begin = appSource.indexOf('function App() {'), end = appSource.indexOf('  const composerProps =', begin);
assert.ok(begin >= 0 && end > begin, 'Actual App action boundary must be available');
const exposed = ['send', 'updateDraft', 'removeQueued', 'addFiles', 'replaceSnapshot', 'quoteMessage',
  'setRoute', 'setArtifactsOpen', 'setActiveArtifactId', 'drafts', 'attachments', 'quotes', 'panelDraftContexts',
  'artifactDraftContexts', 'admissionRecoveries', 'route', 'composerKey', 'activePanel'];
const code = esbuild.transformSync(appSource.slice(begin, end) + `globalThis.probe={${exposed.join(',')}};return null;}`, { loader: 'jsx', format: 'cjs', sourcefile: 'actual-App-admission.jsx' }).code;
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
function fixture() {
  return { settings: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, chats: [], files: [], workspaces: [],
    artifacts: [{ id: 'artifact_A', name: 'A', workspaceId: null }], agentProfiles: [], pendingSends: [] };
}
function harness(api) {
  let cursor = 0;
  const hooks = [], updates = [], events = [];
  const useState = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], value => { updates.push(() => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }); }];
  };
  const useRef = initial => { const index = cursor++; return hooks[index] || (hooks[index] = { current: initial }); };
  const context = vm.createContext({ api, EMPTY: fixture(), useState, useRef, useCallback: callback => callback,
    useEffect() {}, useLayoutEffect() {}, useMemo: callback => callback(), useAudioPlayback: () => ({}), sortChats: values => values,
    upsert: (values, value) => [...values.filter(item => item.id !== value.id), value],
    window: { location: { hash: '' }, innerWidth: 1320, dispatchEvent: event => events.push(event.type) },
    document: { hidden: false }, crypto: webcrypto, Event: class Event { constructor(type) { this.type = type; } },
    setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(code, context);
  const render = () => { while (updates.length) updates.shift()(); cursor = 0; vm.runInContext('App()', context); return context.probe; };
  render();
  return { render, events, get probe() { return context.probe; },
    load(snapshot, route = { type: 'welcome', workspaceId: null }) { context.probe.replaceSnapshot(snapshot); context.probe.setRoute(route); return render(); },
    select(id) { context.probe.setArtifactsOpen(true); context.probe.setActiveArtifactId(id); return render(); } };
}

test('new-chat rejection after draft promotion preserves newer typing and keeps the old resource send separately recoverable', async () => {
  const create = deferred(), sent = [], h = harness({ createChat: () => create.promise,
    sendMessage: async input => { sent.push(clone(input)); throw new Error('synthetic admission rejection'); }, bootstrap: async () => ({ chats: [] }) });
  h.load(fixture()); h.select('artifact_A'); h.probe.updateDraft('OLD_A'); h.render();
  const pending = h.probe.send(); h.probe.updateDraft('NEW_B'); h.render();
  create.resolve({ id: 'chat_new', workspaceId: null, messages: [] }); assert.equal(await pending, false);
  const result = h.render();
  assert.equal(result.route.id, 'chat_new'); assert.equal(result.drafts['chat:chat_new'], 'NEW_B'); assert.equal(result.drafts['new:personal'], '');
  assert.equal(result.panelDraftContexts['chat:chat_new'] ?? null, null); assert.equal(result.admissionRecoveries.length, 1);
  const recovery = clone(result.admissionRecoveries[0]); assert.equal(recovery.content, 'OLD_A'); assert.equal(recovery.activePanel.artifactId, 'artifact_A');
  assert.equal(recovery.draftKey, 'chat:chat_new'); assert.equal(recovery.localOnly, true); assert.equal(sent.length, 1); assert.equal(sent[0].content, 'OLD_A');
});
test('a new attachment import completed before the next render blocks contextual queue restore without dropping the attachment', async () => {
  const cancel = deferred(), imports = deferred(), requests = [], h = harness({
    cancelQueuedMessage: input => { requests.push(clone(input)); return cancel.promise; }, importFiles: () => imports.promise });
  h.load({ ...fixture(), chats: [{ id: 'chat_queued', workspaceId: null, messages: [] }] }, { type: 'chat', id: 'chat_queued' });
  const intent = { id: 'queue_A', chatId: 'chat_queued', content: 'OLD_CONTEXT', attachmentIds: [], useTools: false,
    activePanel: { kind: 'artifact', artifactId: 'artifact_A', artifactName: 'A' } };
  const restoring = h.probe.removeQueued(intent, true), adding = h.probe.addFiles();
  imports.resolve([{ id: 'file_NEW', name: 'new.txt' }]); await adding;
  // Do not render between the independent IPC completions.
  cancel.resolve(intent); await restoring; const result = h.render();
  assert.deepEqual(clone(result.attachments['chat:chat_queued']), ['file_NEW']); assert.equal(result.drafts['chat:chat_queued'] ?? '', '');
  assert.equal(result.panelDraftContexts['chat:chat_queued'] ?? null, null);
  assert.deepEqual(requests, [{ id: 'queue_A', preserveForRestore: true }]); assert.equal(h.events.includes('muse-focus-composer'), false);
});
test('a quote chosen before a restore response cannot be combined with an older app-context intent', async () => {
  const cancel = deferred(), requests = [], h = harness({ cancelQueuedMessage: input => { requests.push(clone(input)); return cancel.promise; } });
  h.load({ ...fixture(), chats: [{ id: 'chat_A', workspaceId: null, messages: [{ id: 'msg_NEW', role: 'assistant', content: 'new quote' }] }] }, { type: 'chat', id: 'chat_A' });
  const intent = { id: 'queue_A', chatId: 'chat_A', content: 'old note', attachmentIds: [], useTools: false,
    activePanel: { kind: 'artifact', artifactId: 'artifact_A', artifactName: 'A' } };
  const pending = h.probe.removeQueued(intent, true); h.probe.quoteMessage({ id: 'msg_NEW' }); cancel.resolve(intent); await pending;
  const result = h.render(); assert.equal(result.quotes['chat:chat_A'], 'msg_NEW'); assert.equal(result.drafts['chat:chat_A'] ?? '', '');
  assert.equal(result.panelDraftContexts['chat:chat_A'] ?? null, null); assert.equal(requests.length, 1); assert.equal(requests[0].preserveForRestore, true);
});
test('switching workspace/chat while createChat waits cannot redirect the captured resource or replace the new route draft', async () => {
  const create = deferred(), requests = [], h = harness({ createChat: input => { requests.push({ create: clone(input) }); return create.promise; },
    sendMessage: async input => { requests.push({ send: clone(input) }); throw new Error('synthetic rejection'); }, bootstrap: async () => ({ chats: [] }) });
  const state = fixture(); state.workspaces = [{ id: 'ws_B', name: 'B' }]; state.chats = [{ id: 'chat_B', workspaceId: 'ws_B', messages: [] }];
  state.artifacts.push({ id: 'artifact_B', name: 'B', workspaceId: 'ws_B' });
  h.load(state); h.select('artifact_A'); h.probe.updateDraft('origin note'); h.render(); const pending = h.probe.send();
  h.probe.setRoute({ type: 'chat', id: 'chat_B' }); h.probe.setActiveArtifactId('artifact_B'); h.render(); h.probe.updateDraft('B PRIVATE DRAFT'); h.render();
  create.resolve({ id: 'chat_created_A', workspaceId: null, messages: [] }); assert.equal(await pending, false); const result = h.render();
  assert.equal(result.route.id, 'chat_B'); assert.equal(result.drafts['chat:chat_B'], 'B PRIVATE DRAFT');
  assert.equal(result.drafts['new:personal'], 'origin note'); assert.equal(result.panelDraftContexts['new:personal'].artifactId, 'artifact_A');
  assert.equal(result.panelDraftContexts['chat:chat_B'] ?? null, null); assert.equal(result.activePanel.artifactId, 'artifact_B');
  assert.equal(requests[0].create.workspaceId, null); assert.equal(requests[1].send.chatId, 'chat_created_A'); assert.equal(requests[1].send.activePanel.artifactId, 'artifact_A');
  assert.equal(JSON.stringify(requests).includes('B PRIVATE DRAFT'), false);
});
test('queue restore after route change remains bound to its original chat and leaves the current chat context untouched', async () => {
  const cancel = deferred(), requests = [], h = harness({ cancelQueuedMessage: input => { requests.push(clone(input)); return requests.length === 1 ? cancel.promise : Promise.resolve(null); } });
  h.load({ ...fixture(), chats: [{ id: 'chat_A', workspaceId: null, messages: [] }, { id: 'chat_B', workspaceId: null, messages: [] }] }, { type: 'chat', id: 'chat_A' });
  const intent = { id: 'queue_A', chatId: 'chat_A', content: 'A restored note', attachmentIds: [], useTools: false,
    activePanel: { kind: 'artifact', artifactId: 'artifact_A', artifactName: 'A' } };
  const pending = h.probe.removeQueued(intent, true); h.probe.setRoute({ type: 'chat', id: 'chat_B' }); h.render(); h.probe.updateDraft('B NEW NOTE'); h.render();
  cancel.resolve(intent); await pending; const result = h.render();
  assert.equal(result.route.id, 'chat_B'); assert.equal(result.drafts['chat:chat_B'], 'B NEW NOTE'); assert.equal(result.panelDraftContexts['chat:chat_B'] ?? null, null);
  assert.equal(result.drafts['chat:chat_A'], 'A restored note'); assert.equal(result.panelDraftContexts['chat:chat_A'].artifactId, 'artifact_A');
  assert.deepEqual(requests, [{ id: 'queue_A', preserveForRestore: true }, { id: 'queue_A' }]);
});
test('lost acknowledgement confirmed in saved history never restores or duplicates the captured app send', async () => {
  const response = deferred(); let sent;
  const h = harness({ sendMessage: input => { sent = clone(input); return response.promise; }, bootstrap: async () => ({ chats: [{ id: 'chat_A', messages: [{ id: sent.clientMessageId, role: 'user', content: sent.content }] }] }) });
  h.load({ ...fixture(), chats: [{ id: 'chat_A', workspaceId: null, messages: [] }] }, { type: 'chat', id: 'chat_A' }); h.select('artifact_A');
  h.probe.updateDraft('OLD CONFIRMED'); h.render(); const pending = h.probe.send(); h.probe.updateDraft('NEW REMAINS'); h.render();
  // A rejected IPC Promise can arrive after the host already admitted the send.
  response.resolve(Promise.reject(new Error('synthetic acknowledgement lost'))); assert.equal(await pending, true);
  const result = h.render(); assert.equal(result.drafts['chat:chat_A'], 'NEW REMAINS'); assert.equal(result.admissionRecoveries.length, 0);
  assert.equal(result.panelDraftContexts['chat:chat_A'] ?? null, null); assert.equal(sent.activePanel.artifactId, 'artifact_A');
});
