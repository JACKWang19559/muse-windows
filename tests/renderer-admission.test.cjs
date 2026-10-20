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
const exposed = ['send', 'stop', 'retry', 'busy', 'sending', 'updateDraft', 'removeQueued', 'addFiles', 'replaceSnapshot', 'quoteMessage',
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

test('Stop during first create restores the empty origin, ignores its late return, and cannot unlock a newer admission', async () => {
  const first=deferred(),second=deferred(),sent=[],cancelled=[];let count=0;
  const h=harness({createChat:()=>++count===1?first.promise:second.promise,sendMessage:async input=>{sent.push(clone(input));return{requestId:'new_request'};},cancelSendAdmission:async input=>{cancelled.push(clone(input));return{state:'cancelled',unseen:true,recoverable:[]};}});
  h.load(fixture());h.probe.updateDraft('FIRST_UNSENT');h.render();const old=h.probe.send();h.render();await h.probe.stop();let p=h.render();
  assert.equal(p.drafts['new:personal'],'FIRST_UNSENT');assert.equal(p.admissionRecoveries.length,0);
  p.updateDraft('SECOND_UNSENT');h.render();const newer=h.probe.send();h.render();
  first.resolve({id:'cancelled_empty_chat',workspaceId:null,messages:[]});assert.equal(await old,false);p=h.render();assert.equal(p.route.type,'welcome');assert.equal(sent.length,0);
  p.updateDraft('THIRD_NOT_ADMITTED');h.render();assert.equal(await h.probe.send(),false,'Old finally must not release the new admission');assert.equal(count,2);
  second.resolve({id:'real_second_chat',workspaceId:null,messages:[]});assert.equal(await newer,true);p=h.render();assert.equal(p.route.id,'real_second_chat');assert.equal(p.drafts['chat:real_second_chat'],'THIRD_NOT_ADMITTED');assert.equal(sent.length,1);assert.equal(sent[0].content,'SECOND_UNSENT');assert.equal(cancelled.length,1);
});

test('Stop keeps later whitespace, attachment and quote separate from a first-create cancelled intent', async () => {
  for(const kind of ['whitespace','attachment','quote']){
    const create=deferred(),imports=deferred(),h=harness({createChat:()=>create.promise,importFiles:()=>imports.promise,cancelSendAdmission:async()=>({state:'cancelled',unseen:true,recoverable:[]})});
    const state=fixture();state.chats=[{id:'other',workspaceId:null,messages:[{id:'quote_NEW',role:'assistant',content:'later'}]}];h.load(state);h.probe.updateDraft('ORIGINAL');h.render();const sending=h.probe.send();
    if(kind==='whitespace')h.probe.updateDraft('  ');
    if(kind==='attachment'){const adding=h.probe.addFiles();imports.resolve([{id:'file_NEW',name:'new.txt'}]);await adding;}
    if(kind==='quote'){h.probe.setRoute({type:'chat',id:'other'});h.render();h.probe.quoteMessage({id:'quote_NEW'});}
    h.render();if(kind==='quote'){h.probe.setRoute({type:'welcome',workspaceId:null});h.render();h.probe.updateDraft('new note');}
    await h.probe.stop();let p=h.render();assert.equal(p.admissionRecoveries.length,1);assert.equal(p.admissionRecoveries[0].content,'ORIGINAL');
    if(kind==='whitespace')assert.equal(p.drafts['new:personal'],'  ');if(kind==='attachment')assert.deepEqual(clone(p.attachments['new:personal']),['file_NEW']);
    create.resolve({id:'late_empty',workspaceId:null,messages:[]});assert.equal(await sending,false);p=h.render();assert.equal(p.route.type,'welcome');
  }
});

test('an exact IPC cancellation restores a host-confirmed intent once and deletes only its recovery item', async () => {
  const send=deferred(),calls=[];let input;
  const h=harness({sendMessage:value=>{input=clone(value);return send.promise;},cancelSendAdmission:async()=>({state:'cancelled',unseen:false,recoverable:[{id:'recovery_1',chatId:'chat_A',clientMessageId:input.clientMessageId,content:input.content,attachmentIds:[],workspaceId:null,profileId:null,useTools:false}]}),stopGeneration:async value=>{calls.push({stop:clone(value)});return{state:'cancelled',recoverable:[]};},cancelQueuedMessage:async value=>{calls.push({remove:clone(value)});return{};}});
  h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[]}]},{type:'chat',id:'chat_A'});h.probe.updateDraft('CANCEL_IPC');h.render();const pending=h.probe.send();h.render();await h.probe.stop();let p=h.render();assert.equal(p.drafts['chat:chat_A'],'CANCEL_IPC');
  send.resolve(Promise.reject(new Error('cancelled by exact client id')));assert.equal(await pending,false);p=h.render();assert.equal(p.drafts['chat:chat_A'],'CANCEL_IPC');assert.equal(p.admissionRecoveries.length,0);assert.deepEqual(calls.filter(x=>x.remove),[{remove:{id:'recovery_1'}}]);assert.deepEqual(calls[0].stop.clientMessageIds,[input.clientMessageId]);
});

test('Stop does not restore or erase an already dispatched send even if its IPC receipt arrives later', async () => {
  const send=deferred();let removed=0;
  const h=harness({sendMessage:()=>send.promise,cancelSendAdmission:async()=>({state:'dispatched',recoverable:[]}),stopGeneration:async()=>({state:'dispatched',recoverable:[]}),cancelQueuedMessage:async()=>{removed++;}});
  h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[]}]},{type:'chat',id:'chat_A'});h.probe.updateDraft('ALREADY_SENT');h.render();const pending=h.probe.send();h.render();await h.probe.stop();assert.equal(h.render().drafts['chat:chat_A'],'');send.resolve({requestId:'actual_dispatch'});assert.equal(await pending,true);const p=h.render();assert.equal(p.drafts['chat:chat_A'],'');assert.equal(p.admissionRecoveries.length,0);assert.equal(removed,0);
});

test('queued Stop recovers only the earliest intent and never merges it into a newer live app target', async () => {
  for(const panelChanged of [false,true]){
    const removed=[],intents=['A','B'].map(x=>({id:'q_'+x,clientMessageId:'c_'+x,chatId:'chat_A',content:'OLD_'+x,attachmentIds:[],workspaceId:null,profileId:null,useTools:false,...(panelChanged?{activePanel:{kind:'artifact',artifactId:'artifact_A',artifactName:'A'}}:{})}));
    const h=harness({stopGeneration:async()=>({state:'cancelled',recoverable:intents}),cancelQueuedMessage:async value=>{removed.push(value.id);return{};}});
    h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[]}],pendingSends:intents.map(x=>({...x,state:'queued'}))},{type:'chat',id:'chat_A'});if(panelChanged){h.select('artifact_A');h.probe.setActiveArtifactId(null);h.render();}
    await h.probe.stop();const p=h.render();assert.equal(p.drafts['chat:chat_A']||'',panelChanged?'':'OLD_A');assert.deepEqual(removed,panelChanged?[]:['q_A']);
  }
});

test('a quote chosen while cancellation waits blocks automatic recovery even before the next paint', async () => {
  const sending=deferred(),cancelling=deferred(),removed=[];let input;
  const h=harness({sendMessage:value=>{input=clone(value);return sending.promise;},cancelSendAdmission:()=>cancelling.promise,stopGeneration:async()=>({recoverable:[]}),cancelQueuedMessage:async value=>removed.push(value.id)});
  h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[{id:'quote_NEW',role:'assistant',content:'new quoted text'}]}]},{type:'chat',id:'chat_A'});h.probe.updateDraft('OLD_REQUEST');h.render();const pending=h.probe.send();h.render();const stop=h.probe.stop();
  h.probe.quoteMessage({id:'quote_NEW'}); // Deliberately no render before the IPC result.
  cancelling.resolve({state:'cancelled',unseen:false,recoverable:[{id:'keep_host',chatId:'chat_A',clientMessageId:input.clientMessageId,content:input.content,attachmentIds:[],workspaceId:null,profileId:null,useTools:false}]});await stop;sending.resolve(Promise.reject(new Error('cancelled')));assert.equal(await pending,false);
  const p=h.render();assert.equal(p.quotes['chat:chat_A'],'quote_NEW');assert.equal(p.drafts['chat:chat_A'],'');assert.deepEqual(removed,[],'Host recovery must remain available');
});

test('cancelling an in-flight annotation does not also restore its card text into the ordinary composer', async () => {
  const sending=deferred(),removed=[];let input;
  const h=harness({sendMessage:value=>{input=clone(value);return sending.promise;},cancelSendAdmission:async()=>({state:'cancelled',unseen:false,recoverable:[{id:'annotation_keep',chatId:'chat_A',clientMessageId:input.clientMessageId,content:input.content,attachmentIds:[],workspaceId:null,profileId:null,useTools:false,artifactContext:input.artifactContext,activePanel:input.activePanel}]}),stopGeneration:async()=>({recoverable:[]}),cancelQueuedMessage:async value=>removed.push(value.id)});
  h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[]}]},{type:'chat',id:'chat_A'});h.select('artifact_A');const pending=h.probe.send('CARD_NOTE',{artifactId:'artifact_A',artifactName:'A'});h.render();await h.probe.stop();sending.resolve(Promise.reject(new Error('cancelled')));assert.equal(await pending,false);const p=h.render();assert.equal(p.drafts['chat:chat_A']||'','');assert.equal(p.artifactDraftContexts['chat:chat_A']??null,null);assert.deepEqual(removed,[]);
});

test('Stop before a retry receipt retains its cancellation and later stops only that exact request', async () => {
  const receipt=deferred(),next=deferred(),stops=[],sends=[];
  const h=harness({retryMessage:()=>receipt.promise,stopGeneration:async input=>{stops.push(clone(input));return{state:'cancelled',recoverable:[]};},sendMessage:input=>{sends.push(clone(input));return next.promise;}});
  h.load({...fixture(),chats:[{id:'chat_retry',workspaceId:null,messages:[{id:'original_user',role:'user',content:'original'},{id:'original_answer',role:'assistant',content:'answer',status:'complete'}]}]},{type:'chat',id:'chat_retry'});
  const retry=h.probe.retry();h.render();await h.probe.stop();h.render();h.probe.updateDraft('NEXT_GENERATION');h.render();const sending=h.probe.send();h.render();
  receipt.resolve({requestId:'old_retry_request'});await retry;let p=h.render();assert.equal(p.sending,true,'Old retry finally cannot unlock the new generation');assert.equal(stops.length,2);assert.deepEqual(stops[1],{chatId:'chat_retry',requestId:'old_retry_request',clientMessageIds:[]});assert.equal(sends.length,1);
  p.updateDraft('NOT_A_THIRD_REQUEST');h.render();assert.equal(await h.probe.send(),false);next.resolve({requestId:'new_send_request'});assert.equal(await sending,true);p=h.render();assert.equal(p.drafts['chat:chat_retry'],'NOT_A_THIRD_REQUEST');
});

test('an application target changed before paint invalidates a waiting cancellation recovery', async () => {
  const sending=deferred(),cancel=deferred(),removed=[];let input;
  const state=fixture();state.artifacts.push({id:'artifact_B',name:'B',workspaceId:null});state.chats=[{id:'chat_A',workspaceId:null,messages:[]}];
  const h=harness({sendMessage:value=>{input=clone(value);return sending.promise;},cancelSendAdmission:()=>cancel.promise,stopGeneration:async()=>({recoverable:[]}),cancelQueuedMessage:async value=>removed.push(value.id)});
  h.load(state,{type:'chat',id:'chat_A'});h.select('artifact_A');h.probe.updateDraft('A_CONTEXT_NOTE');h.render();const pending=h.probe.send();h.render();const stopping=h.probe.stop();
  h.probe.setActiveArtifactId('artifact_B'); // No parent render before the result.
  cancel.resolve({state:'cancelled',unseen:false,recoverable:[{id:'keep_A',...input,workspaceId:null,profileId:null,useTools:false}]});await stopping;sending.resolve(Promise.reject(new Error('cancelled')));assert.equal(await pending,false);
  const p=h.render();assert.equal(p.activePanel.artifactId,'artifact_B');assert.equal(p.drafts['chat:chat_A'],'');assert.equal(p.panelDraftContexts['chat:chat_A']??null,null);assert.deepEqual(removed,[]);
});

test('leaving and returning to the same chat while Stop waits does not consume a hidden recovery', async () => {
  const cancel=deferred(),removed=[],intent={id:'keep_A',chatId:'chat_A',clientMessageId:'client_A',content:'old draft',attachmentIds:[],workspaceId:null,profileId:null,useTools:false};
  const h=harness({stopGeneration:()=>cancel.promise,cancelQueuedMessage:async input=>removed.push(input.id)});
  h.load({...fixture(),chats:[{id:'chat_A',workspaceId:null,messages:[]},{id:'chat_B',workspaceId:null,messages:[]}],pendingSends:[{...intent,state:'queued'}]},{type:'chat',id:'chat_A'});const pending=h.probe.stop();
  h.probe.setRoute({type:'chat',id:'chat_B'});h.probe.setRoute({type:'chat',id:'chat_A'});cancel.resolve({state:'cancelled',recoverable:[intent]});await pending;const p=h.render();assert.equal(p.drafts['chat:chat_A']||'','');assert.deepEqual(removed,[]);
});
