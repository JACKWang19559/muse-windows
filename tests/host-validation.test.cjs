'use strict';

// Main-process integration tests with real Store persistence and a stubbed
// Electron boundary/provider. These tests execute the actual main/preload code;
// they do not launch Electron, call a network service or execute imported files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { Store } = require('../backend/store.cjs');

const appRoot = path.resolve(__dirname, '..');
const mainFile = path.join(appRoot, 'main.cjs');
const mainRequire = createRequire(mainFile);
const rendererURL = pathToFileURL(path.join(appRoot, 'build', 'index.html')).href;
const API_METHODS = 'bootstrap saveSettings testConnection listModels createWorkspace updateWorkspace deleteWorkspace createChat updateChat deleteChat searchMessages deleteTurn sendMessage cancelQueuedMessage stopGeneration respondApproval retryMessage importFiles importDroppedFiles removeFile createTextFile saveTextFile readFile openFile exportChat exportData importData copyText openExternal windowControl subscribe createArtifact writeArtifactFiles readArtifactFile buildArtifact deleteArtifact openArtifactPreview activateArtifactPreview closeArtifactPreview artifactRequest exportArtifact previewSchedule createSchedule updateSchedule pauseSchedule deleteSchedule runScheduleNow stopSchedule saveBackgroundSettings'.split(' ');

function temporary(t) {
  // The managed Windows sandbox's redirected system temp permits writes but
  // can deny atomic rename. Keep integration fixtures in this writable project.
  const parentPath = process.env.MUSE_TEST_TMP_ROOT || path.join(appRoot, '.test-tmp', 'host');
  fs.mkdirSync(parentPath, { recursive: true });
  const parent = fs.realpathSync(parentPath);
  const dir = fs.mkdtempSync(path.join(parent, 'muse-host-review-'));
  t.after(() => {
    // Verify the exact resolved deletion target before recursive cleanup.
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('muse-host-review-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

function fixture(t, overrides = {}) {
  const dir = temporary(t);
  const store = new Store(path.join(dir, 'state'), {
    encrypt: value => Buffer.from(`test-encrypted:${value}`),
    decrypt: bytes => Buffer.from(bytes).toString().slice('test-encrypted:'.length)
  });
  store.saveSettings({ baseUrl: 'https://provider-a.example/v1', model: 'model-a', apiKey: 'review-key-original-12345', systemPrompt: 'PROMPT_AT_SEND' });
  const scheduled = [], events = [], errors = [], external = [], handlers = new Map(), appEvents=new Map(), windowEvents=new Map(),webEvents=new Map();
  const provider = {
    configuredUrl: mainRequire('./backend/provider.cjs').configuredUrl,
    streamCompletion: async options => { options.onDelta('answer'); return { content: 'answer' }; },
    listModels: async () => ['model-a'], testConnection: async () => ({ ok: true, message: 'local stub' }),
    ...overrides
  };
  const webContents = { mainFrame: { url: rendererURL }, send: (_channel, event) => events.push(structuredClone(event)),on:(name,fn)=>webEvents.set(name,fn),setWindowOpenHandler(){},session:{on(){},setPermissionCheckHandler(){},setPermissionRequestHandler(){}} };
  const window = { webContents, isDestroyed: () => false, minimize() {}, maximize() {}, unmaximize() {}, isMaximized: () => false, close() {},on:(name,fn)=>windowEvents.set(name,fn),loadFile(){},show(){},focus(){},hide(){},isMinimized:()=>false };
  const app = { setName() {}, getVersion: () => 'test', getPath: () => dir, on:(name,fn)=>appEvents.set(name,fn), requestSingleInstanceLock: () => true, quit() {}, whenReady: () => ({ then: () => ({ catch() {} }) }) };
  const electron = {
    app, BrowserWindow: function () {return window;}, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }),showMessageBoxSync:()=>0 },
    safeStorage: {}, shell: { openExternal: async url => external.push(url), openPath: async () => '', showItemInFolder() {} },
    clipboard: { writeText() {} }, nativeTheme: {}, Menu: { setApplicationMenu() {},buildFromTemplate:entries=>entries }, protocol: {registerSchemesAsPrivileged(){},handle(){}},Tray:class{setToolTip(){}setContextMenu(){}on(){}isDestroyed(){return false;}destroy(){}}
  };
  const sandbox = {
    require: name => name === 'electron' ? electron : name === './backend/provider.cjs' ? provider : name === './backend/agent-loop.cjs' ? {
      // This VM is a separate JS realm. Recreate the host-owned wire payload
      // in the module's realm, as the actual Electron main process constructs it.
      runAgentConversation: options => mainRequire(name).runAgentConversation({ ...options, messages: JSON.parse(JSON.stringify(options.messages)) })
    } : name === './backend/schedule-tools.cjs'?{...mainRequire(name),createScheduleRuntime:options=>mainRequire(name).createScheduleRuntime({...options,attachmentIds:JSON.parse(JSON.stringify(options.attachmentIds)),getProviderBinding:()=>JSON.parse(JSON.stringify(options.getProviderBinding()))})}: name === './backend/schedule-time.cjs' ? Object.fromEntries(Object.entries(mainRequire(name)).map(([key,value])=>[key,['normalizeCadence','nextOccurrence','resolveLocalTime','localDateTime'].includes(key)?(...args)=>value(...args.map(arg=>arg&&typeof arg==='object'?JSON.parse(JSON.stringify(arg)):arg)):value])) : name === './backend/message-outbox.cjs' ? {
      ...mainRequire(name), MessageOutbox: class extends mainRequire(name).MessageOutbox {
        // Production creates this host-owned envelope in the module's realm.
        reserve(input) { return super.reserve({ ...input, ...(input.metadata ? { metadata: JSON.parse(JSON.stringify(input.metadata)) } : {}) }); }
      }
    } : mainRequire(name),
    __dirname: appRoot, process, console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setImmediate: callback => { scheduled.push(callback); }
  };
  const expose = '\n;globalThis.hostUnderTest={operations,active,assertSender,contextMessages,cleanError,createWindow,setState:(s,w)=>{store=s;window=w;}};';
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8') + expose, sandbox, { filename: mainFile });
  // Production main and Store share a realm; the VM fixture serializes its
  // host-owned data at this test boundary without relaxing JSON validators.
  const mainStore = new Proxy(store, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? (...args) => value.apply(target, args.map(arg => arg && typeof arg === 'object' ? JSON.parse(JSON.stringify(arg)) : arg)) : value; } });
  sandbox.hostUnderTest.setState(mainStore, window);
  return { ...sandbox.hostUnderTest, store, dir, window, webContents, provider, scheduled, events, errors, external, appEvents,windowEvents,webEvents };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out: ${label}`);
}
async function runQueued(host) {
  const callback = host.scheduled.shift();
  assert.equal(typeof callback, 'function');
  await callback();
  await waitFor(() => host.active.size === 0, 'generation settles');
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('same-chat sends wait in FIFO while other chats can generate and no intent is appended before dispatch', async t => {
  const entered = deferred(), firstDone = deferred(), requests = [];
  const host = fixture(t, { streamCompletion: async options => {
    const prompt = options.messages.at(-1).content; requests.push({ prompt, messages: options.messages });
    if (prompt === 'first') { entered.resolve(); await firstDone.promise; }
    return { content: `reply to ${prompt}` };
  } });
  const chat = host.store.createChat(), other = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'first' }); host.scheduled.shift()(); await entered.promise;
  const queued = await host.operations.sendMessage({ chatId: chat.id, content: 'second' });
  assert.equal(queued.queued, true); assert.equal(host.store.getChat(chat.id).messages.length, 2);
  const snapshot = host.operations.bootstrap(); snapshot.pendingSends[0].attachmentIds.push('forged');
  assert.equal(host.operations.bootstrap().pendingSends[0].attachmentIds.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('review-key-original-12345'));
  await host.operations.sendMessage({ chatId: other.id, content: 'other' }); host.scheduled.shift()();
  await waitFor(() => !host.active.has(other.id), 'independent chat completes');
  assert.deepEqual(requests.map(request => request.prompt), ['first', 'other']);
  firstDone.resolve(); await waitFor(() => host.scheduled.length === 1, 'next FIFO send admitted');
  assert.equal(host.operations.bootstrap().pendingSends.length, 0);
  await runQueued(host);
  assert.deepEqual(requests.map(request => request.prompt), ['first', 'other', 'second']);
  assert.ok(requests[2].messages.some(message => message.role === 'assistant' && message.content === 'reply to first'));
  assert.deepEqual(host.store.getChat(chat.id).messages.filter(message => message.role === 'user').map(message => message.content), ['first', 'second']);
});

test('generation setup failure rolls back only its newly admitted suffix before any provider request', async t => {
  let requests = 0;
  const host = fixture(t, { streamCompletion: async () => { requests++; return { content: 'done' }; } });
  const workspace = host.store.createWorkspace({ name: 'admission' }), chat = host.store.createChat({ workspaceId: workspace.id });
  await host.store.createTextFile({ workspaceId: workspace.id, name: 'reference.md', content: 'reference' });
  const read = host.store.readFile.bind(host.store); host.store.readFile = () => { throw new Error('context source unavailable'); };
  const input = { chatId: chat.id, clientMessageId: 'client_admission_1', content: 'single request' };
  await assert.rejects(host.operations.sendMessage(input), /context source unavailable/);
  assert.equal(host.store.getChat(chat.id).messages.length, 0); assert.equal(host.active.size, 0); assert.equal(host.scheduled.length, 0); assert.equal(requests, 0);
  host.store.readFile = read;
  await host.operations.sendMessage(input); await runQueued(host);
  assert.equal(requests, 1); assert.equal(host.store.getChat(chat.id).messages.filter(message => message.id === input.clientMessageId).length, 1);
});

test('a queued setup failure restores an unsent intent after rollback and explicit resend cannot duplicate its user message', async t => {
  const entered = deferred(), done = deferred(); let requests = 0;
  const host = fixture(t, { streamCompletion: async () => { if (++requests === 1) { entered.resolve(); await done.promise; } return { content: 'done' }; } });
  const workspace = host.store.createWorkspace({ name: 'queued admission' }), chat = host.store.createChat({ workspaceId: workspace.id });
  await host.store.createTextFile({ workspaceId: workspace.id, name: 'reference.md', content: 'reference' });
  await host.operations.sendMessage({ chatId: chat.id, content: 'first' }); host.scheduled.shift()(); await entered.promise;
  const queued = await host.operations.sendMessage({ chatId: chat.id, clientMessageId: 'client_queued_admission', content: 'second once' });
  const read = host.store.readFile.bind(host.store); host.store.readFile = () => { throw new Error('missing document'); }; done.resolve();
  await waitFor(() => host.operations.bootstrap().pendingSends[0]?.state === 'failed', 'queue setup rollback');
  assert.equal(host.store.getChat(chat.id).messages.length, 2); assert.equal(requests, 1);
  const intent = host.operations.cancelQueuedMessage({ id: queued.queueId }); host.store.readFile = read;
  await host.operations.sendMessage(intent); await runQueued(host);
  assert.equal(requests, 2); assert.equal(host.store.getChat(chat.id).messages.filter(message => message.content === 'second once').length, 1);
});

test('failed rollback keeps admitted identity and never exposes the same request as a new unsent intent', async t => {
  const entered = deferred(), done = deferred(); let requests = 0;
  const host = fixture(t, { streamCompletion: async () => { if (++requests === 1) { entered.resolve(); await done.promise; } return { content: 'done' }; } });
  const workspace = host.store.createWorkspace({ name: 'admitted fallback' }), chat = host.store.createChat({ workspaceId: workspace.id });
  await host.store.createTextFile({ workspaceId: workspace.id, name: 'reference.md', content: 'reference' });
  await host.operations.sendMessage({ chatId: chat.id, content: 'first' }); host.scheduled.shift()(); await entered.promise;
  await host.operations.sendMessage({ chatId: chat.id, clientMessageId: 'client_already_saved', content: 'saved once' });
  const read = host.store.readFile.bind(host.store), rollback = host.store.rollbackUnsentMessages.bind(host.store);
  host.store.readFile = () => { throw new Error('missing document'); }; host.store.rollbackUnsentMessages = () => { throw new Error('disk unavailable'); }; done.resolve();
  await waitFor(() => host.active.size === 0 && host.store.getChat(chat.id).messages.length === 4, 'admitted failure retained');
  assert.equal(host.operations.bootstrap().pendingSends.length, 0); assert.equal(host.store.getChat(chat.id).messages.at(-1).status, 'error'); assert.equal(requests, 1);
  host.store.readFile = read; host.store.rollbackUnsentMessages = rollback;
  await host.operations.retryMessage({ chatId: chat.id }); await runQueued(host);
  assert.equal(requests, 2); assert.equal(host.store.getChat(chat.id).messages.filter(message => message.id === 'client_already_saved').length, 1);
});

test('host queue capacity includes the active send and waiting intents are not silently discarded', async t => {
  const host = fixture(t), chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'active not yet dispatched' });
  for (let i = 0; i < 31; i++) assert.equal((await host.operations.sendMessage({ chatId: chat.id, content: `queued ${i}` })).queued, true);
  await assert.rejects(host.operations.sendMessage({ chatId: chat.id, content: 'over capacity' }), /队列已满/);
  assert.equal(host.operations.bootstrap().pendingSends.length, 31);
  host.operations.stopGeneration({ chatId: chat.id }); await runQueued(host);
  assert.equal(host.operations.bootstrap().pendingSends.filter(item => item.state === 'failed').length, 31);
  for (const item of host.operations.bootstrap().pendingSends) host.operations.cancelQueuedMessage({ id: item.id });
});

test('stop cancels waiting intents without dispatch and recovery returns their draft for an explicit resend', async t => {
  const entered = deferred(); let requests = 0;
  const host = fixture(t, { streamCompletion: async options => {
    requests++; entered.resolve();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'running' }); host.scheduled.shift()(); await entered.promise;
  const queued = await host.operations.sendMessage({ chatId: chat.id, content: 'restore this', useTools: true });
  host.operations.stopGeneration({ chatId: chat.id }); await waitFor(() => host.active.size === 0, 'stop all pending work');
  const item = host.operations.bootstrap().pendingSends[0];
  assert.equal(item.state, 'failed'); assert.equal(requests, 1); assert.equal(host.scheduled.length, 0);
  const draft = host.operations.cancelQueuedMessage({ id: queued.queueId });
  assert.equal(draft.content, 'restore this'); assert.equal(draft.useTools, true); assert.equal(host.operations.bootstrap().pendingSends.length, 0);
  assert.throws(() => host.operations.cancelQueuedMessage({ id: queued.queueId }), /已发送|移出/);
});

test('queued sends refuse changed model credentials but a theme change does not change the provider binding', async t => {
  for (const change of [{ model: 'model-b' }, { apiKey: 'other-mock-key-12345' }, { theme: 'dark' }]) {
    const entered = deferred(), done = deferred(); let requests = 0;
    const host = fixture(t, { streamCompletion: async () => { if (++requests === 1) { entered.resolve(); await done.promise; } return { content: 'answer' }; } });
    const chat = host.store.createChat();
    await host.operations.sendMessage({ chatId: chat.id, content: 'running' }); host.scheduled.shift()(); await entered.promise;
    await host.operations.sendMessage({ chatId: chat.id, content: 'pending' }); host.operations.saveSettings(change); done.resolve();
    if (change.theme) {
      await waitFor(() => host.scheduled.length === 1, 'theme permits next send'); await runQueued(host); assert.equal(requests, 2);
    } else {
      await waitFor(() => host.operations.bootstrap().pendingSends[0]?.state === 'failed', 'changed connection prevents send');
      assert.equal(requests, 1); assert.equal(host.scheduled.length, 0); assert.equal(host.store.getChat(chat.id).messages.length, 2);
      host.operations.cancelQueuedMessage({ id: host.operations.bootstrap().pendingSends[0].id });
    }
  }
});

test('moving or deleting a chat invalidates its waiting sends and never recreates a deleted chat', async t => {
  for (const operation of ['move', 'delete']) {
    const entered = deferred(); let requests = 0;
    const host = fixture(t, { streamCompletion: async options => { requests++; entered.resolve(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); } });
    const workspace = host.store.createWorkspace({ name: 'queue scope' }), chat = host.store.createChat({ workspaceId: workspace.id });
    await host.operations.sendMessage({ chatId: chat.id, content: 'running' }); host.scheduled.shift()(); await entered.promise;
    await host.operations.sendMessage({ chatId: chat.id, content: 'never dispatch' });
    if (operation === 'move') host.operations.updateChat({ id: chat.id, workspaceId: null }); else host.operations.deleteChat({ id: chat.id });
    await waitFor(() => host.active.size === 0, 'scope change cancels active generation');
    assert.equal(requests, 1); assert.equal(host.scheduled.length, 0);
    if (operation === 'move') assert.equal(host.operations.bootstrap().pendingSends[0].state, 'failed');
    else { assert.equal(host.operations.bootstrap().pendingSends.length, 0); assert.throws(() => host.store.getChat(chat.id)); }
  }
});

test('uncertain provider failures are never retried automatically and queued next messages send only once', async t => {
  const entered = deferred(), disconnected = deferred(); let requests = 0;
  const host = fixture(t, { streamCompletion: async () => { if (++requests === 1) { entered.resolve(); await disconnected.promise; throw new Error('connection lost after dispatch'); } return { content: 'next answer' }; } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'first' }); host.scheduled.shift()(); await entered.promise;
  await host.operations.sendMessage({ chatId: chat.id, content: 'next' }); disconnected.resolve();
  await waitFor(() => host.scheduled.length === 1, 'next intent admitted'); await runQueued(host);
  assert.equal(requests, 2); assert.equal(host.store.getChat(chat.id).messages[1].status, 'error');
  assert.equal(host.store.getChat(chat.id).messages.filter(message => message.content === 'first').length, 1);
});

test('quoted message identity is checked locally and its bounded excerpt reaches model context', async t => {
  let history;
  const host = fixture(t, { streamCompletion: async options => { history = options.messages; return { content: 'quoted response' }; } });
  const chat = host.store.createChat(), other = host.store.createChat();
  const original = host.store.appendMessage(chat.id, { role: 'assistant', content: 'QUOTE-CONTEXT-42' });
  const foreign = host.store.appendMessage(other.id, { role: 'user', content: 'FOREIGN-CONTEXT-MUST-NOT-LEAK' });
  for (let i = 0; i < 83; i++) host.store.appendMessage(chat.id, { role: i % 2 ? 'assistant' : 'user', content: `history ${i}` });
  await assert.rejects(host.operations.sendMessage({ chatId: chat.id, content: 'wrong quote', replyToMessageId: foreign.id }), /引用|消息/);
  assert.equal(host.store.getChat(chat.id).messages.length, 84);
  await host.operations.sendMessage({ chatId: chat.id, content: 'explain quoted text', replyToMessageId: original.id }); await runQueued(host);
  const sent = host.store.getChat(chat.id).messages.at(-2);
  assert.equal(sent.replyTo.messageId, original.id); assert.equal(sent.replyTo.excerpt, 'QUOTE-CONTEXT-42');
  assert.ok(history.at(-1).content.includes('QUOTE-CONTEXT-42')); assert.ok(history.at(-1).content.includes('explain quoted text'));
  assert.ok(!JSON.stringify(history).includes('FOREIGN-CONTEXT-MUST-NOT-LEAK'));
  assert.ok(!history.some(message => message.content === original.content), 'the target is outside the recent-message budget; quote still supplies it');
});

test('deleting a user message is prohibited while generating and scrubs subsequent context and search', async t => {
  let history;
  const host = fixture(t, { streamCompletion: async options => { history = options.messages; return { content: 'after deletion' }; } });
  const chat = host.store.createChat(), target = host.store.appendMessage(chat.id, { role: 'user', content: 'DELETE-SECRET-ONE' });
  host.store.appendMessage(chat.id, { role: 'assistant', content: 'kept response' });
  host.store.appendMessage(chat.id, { role: 'user', content: 'followup', replyToMessageId: target.id });
  await host.operations.sendMessage({ chatId: chat.id, content: 'wait' });
  assert.throws(() => host.operations.deleteTurn({ chatId: chat.id, messageId: target.id }), /停止/);
  await runQueued(host);
  assert.equal(host.operations.searchMessages({ query: 'DELETE-SECRET-ONE' }).hits[0].messageId, target.id);
  const deleted = host.operations.deleteTurn({ chatId: chat.id, messageId: target.id });
  assert.equal(deleted.chat.messages[0].isDeleted, true); assert.equal(deleted.chat.messages[1].content, 'kept response');
  assert.equal(host.operations.searchMessages({ query: 'DELETE-SECRET-ONE' }).hits.length, 0);
  await host.operations.sendMessage({ chatId: chat.id, content: 'continue' }); await runQueued(host);
  assert.ok(!JSON.stringify(history).includes('DELETE-SECRET-ONE')); assert.ok(JSON.stringify(history).includes('引用的历史消息已删除'));
});

test('agent writes wait for a concrete one-shot approval and return the result to the model', async t => {
  let requests = 0, finalHistory;
  const host = fixture(t, { streamCompletion: async options => {
    requests++;
    if (requests === 1) { assert.ok(options.tools.some(tool => tool.function.name === 'workspace_create_text_file')); return { content: '准备创建文件。', toolCalls: [toolCall('call-create', 'workspace_create_text_file', { name: 'agent.md', content: '# APPROVED-CONTENT' })] }; }
    finalHistory = options.messages;
    return { content: '已按确认创建文件。' };
  } });
  const workspace = host.store.createWorkspace({ name: 'Agent approval' }), chat = host.store.createChat({ workspaceId: workspace.id });
  await host.operations.sendMessage({ chatId: chat.id, content: '创建一份说明', useTools: true });
  host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'concrete approval appears');
  const approval = host.operations.bootstrap().approvals[0];
  assert.equal(approval.arguments.content, '# APPROVED-CONTENT');
  assert.equal(host.store.snapshot().files.length, 0);
  assert.equal(host.store.getChat(chat.id).messages.at(-1).toolTrace[0].calls[0].status, 'awaiting_approval');
  assert.throws(() => host.operations.respondApproval({ id: approval.id, decision: true }), /允许或拒绝/);
  host.operations.respondApproval({ id: approval.id, decision: 'approve' });
  await waitFor(() => host.active.size === 0, 'approved agent completes');
  const file = host.store.snapshot().files[0], answer = host.store.getChat(chat.id).messages.at(-1);
  assert.equal(host.store.readFile(file.id).text, '# APPROVED-CONTENT');
  assert.equal(file.workspaceId, workspace.id);
  assert.equal(answer.status, 'complete'); assert.equal(answer.agentMode, true);
  assert.equal(answer.toolTrace[0].calls[0].status, 'complete');
  assert.ok(finalHistory.some(message => message.role === 'assistant' && message.tool_calls?.[0].id === 'call-create'));
  assert.equal(JSON.parse(finalHistory.find(message => message.role === 'tool').content).result.file.id, file.id);
  assert.equal(host.operations.bootstrap().approvals.length, 0);
  assert.throws(() => host.operations.respondApproval({ id: approval.id, decision: 'approve' }), /失效/);
});

test('denied agent writes return denial to the model without creating a file', async t => {
  let requests = 0, result;
  const host = fixture(t, { streamCompletion: async options => ++requests === 1 ? { content: '', toolCalls: [toolCall('deny-call', 'workspace_create_text_file', { name: 'denied.txt', content: 'MUST NOT EXIST' })] } : (result = JSON.parse(options.messages.at(-1).content), { content: '没有写入。' }) });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'write', useTools: true }); host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'denial prompt');
  host.operations.respondApproval({ id: host.operations.bootstrap().approvals[0].id, decision: 'deny' });
  await waitFor(() => host.active.size === 0, 'denied conversation completes');
  assert.equal(host.store.snapshot().files.length, 0); assert.equal(result.ok, false); assert.equal(result.error.code, 'denied');
  assert.equal(host.store.getChat(chat.id).messages.at(-1).toolTrace[0].calls[0].status, 'denied');
});

test('stopping an approval cancels it permanently and retry asks for fresh approval', async t => {
  let attempt = 0;
  const host = fixture(t, { streamCompletion: async () => ({ content: '', toolCalls: [toolCall(`retry-call-${++attempt}`, 'workspace_create_text_file', { name: 'retry.txt', content: 'not approved' })] }) });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'write', useTools: true }); host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'cancel prompt');
  const oldId = host.operations.bootstrap().approvals[0].id;
  host.operations.stopGeneration({ chatId: chat.id });
  await waitFor(() => host.active.size === 0, 'cancel waiting agent');
  assert.equal(host.operations.bootstrap().approvals.length, 0); assert.equal(host.store.snapshot().files.length, 0);
  assert.equal(host.store.getChat(chat.id).messages.at(-1).toolTrace[0].calls[0].status, 'cancelled');
  assert.throws(() => host.operations.respondApproval({ id: oldId, decision: 'approve' }), /失效/);
  await host.operations.retryMessage({ chatId: chat.id }); host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'fresh retry prompt');
  assert.notEqual(host.operations.bootstrap().approvals[0].id, oldId);
  host.operations.stopGeneration({ chatId: chat.id }); await waitFor(() => host.active.size === 0, 'stop retried agent');
});

test('moving or deleting a workspace invalidates its pending write', async t => {
  for (const operation of ['move', 'delete']) {
    const host = fixture(t, { streamCompletion: async () => ({ content: '', toolCalls: [toolCall('scope-call', 'workspace_create_text_file', { name: 'scope.txt', content: 'MUST NOT WRITE' })] }) });
    const workspace = host.store.createWorkspace({ name: 'Old scope' }), chat = host.store.createChat({ workspaceId: workspace.id });
    await host.operations.sendMessage({ chatId: chat.id, content: 'write', useTools: true }); host.scheduled.shift()();
    await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'scope prompt');
    const approvalId = host.operations.bootstrap().approvals[0].id;
    if (operation === 'move') host.operations.updateChat({ id: chat.id, workspaceId: null }); else host.operations.deleteWorkspace({ id: workspace.id });
    await waitFor(() => host.active.size === 0, 'scope changed');
    assert.equal(host.store.snapshot().files.length, 0);
    assert.throws(() => host.operations.respondApproval({ id: approvalId, decision: 'approve' }), /失效/);
  }
});

test('completed writes remain recorded when Stop arrives immediately after the atomic commit', async t => {
  let requests = 0;
  const host = fixture(t, { streamCompletion: async () => { requests++; return { content: '', toolCalls: [toolCall('commit-call', 'workspace_create_text_file', { name: 'committed.txt', content: 'COMMITTED-ONCE' })] }; } });
  const chat = host.store.createChat(), original = host.store.createTextFile.bind(host.store);
  host.store.createTextFile = async input => { const result = await original(input); host.operations.stopGeneration({ chatId: chat.id }); return result; };
  await host.operations.sendMessage({ chatId: chat.id, content: 'write', useTools: true }); host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'commit prompt');
  host.operations.respondApproval({ id: host.operations.bootstrap().approvals[0].id, decision: 'approve' });
  await waitFor(() => host.active.size === 0, 'committed cancellation');
  const answer = host.store.getChat(chat.id).messages.at(-1), call = answer.toolTrace[0].calls[0];
  assert.equal(answer.status, 'cancelled'); assert.equal(call.status, 'complete'); assert.equal(JSON.parse(call.result).ok, true);
  assert.equal(host.store.snapshot().files.length, 1); assert.equal(requests, 1);
  let retryHistory;
  host.provider.streamCompletion = async options => { retryHistory = options.messages; return { content: '确认前一次写入已完成。' }; };
  await host.operations.retryMessage({ chatId: chat.id }); await runQueued(host);
  const messages = host.store.getChat(chat.id).messages;
  assert.equal(messages.length, 3); assert.equal(messages[1].id, answer.id);
  assert.deepEqual(messages[1].toolTrace, answer.toolTrace);
  assert.equal(JSON.parse(retryHistory.find(message => message.role === 'tool').content).ok, true);
  assert.equal(host.store.snapshot().files.length, 1);
});

test('a failed final reply keeps committed tool receipts in the next conversation context', async t => {
  let requests = 0, nextHistory;
  const host = fixture(t, { streamCompletion: async options => {
    if (++requests === 1) return { content: '准备写入', toolCalls: [toolCall('error-commit-call', 'workspace_create_text_file', { name: 'saved-before-error.md', content: 'KEPT' })] };
    if (requests === 2) { options.onDelta('FAILED_FINAL_TEXT'); throw new Error('provider disconnected after write'); }
    nextHistory = options.messages; return { content: '看到了上次的写入结果。' };
  } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'write', useTools: true }); host.scheduled.shift()();
  await waitFor(() => host.operations.bootstrap().approvals.length === 1, 'write before failure');
  host.operations.respondApproval({ id: host.operations.bootstrap().approvals[0].id, decision: 'approve' });
  await waitFor(() => host.active.size === 0, 'final provider failure');
  const failed = host.store.getChat(chat.id).messages.at(-1);
  assert.equal(failed.status, 'error'); assert.equal(failed.toolTrace[0].calls[0].status, 'complete');
  await host.operations.sendMessage({ chatId: chat.id, content: 'what happened?', useTools: true }); await runQueued(host);
  assert.equal(JSON.parse(nextHistory.find(message => message.role === 'tool').content).ok, true);
  assert.ok(!nextHistory.some(message => message.content === 'FAILED_FINAL_TEXT'));
  assert.equal(host.store.getChat(chat.id).messages.find(message => message.id === failed.id).toolTrace[0].calls[0].status, 'complete');
  assert.equal(host.store.snapshot().files.length, 1);
});

test('preload exposes the documented minimal API and accepts drop paths only through webUtils', async () => {
  const calls = [], approved = new WeakMap(), listeners = new Map();
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'muse'); exposed = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return []; }, on: (channel, callback) => listeners.set(channel, callback), removeListener: channel => listeners.delete(channel) },
    webUtils: { getPathForFile: file => approved.get(file) || '' }
  };
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'preload.cjs'), 'utf8'), { require: () => electron, console });
  assert.deepEqual(Array.from(Object.keys(exposed)).sort(), [...API_METHODS].sort());
  assert.equal(exposed.importDroppedPaths, undefined);
  assert.equal(exposed.invoke, undefined);
  assert.equal(exposed.ipcRenderer, undefined);
  assert.ok(Object.isFrozen(exposed));
  await assert.rejects(exposed.importDroppedFiles([{ path: 'C:\\untrusted-renderer-path.txt' }]), /真实文件/);
  assert.equal(calls.length, 0);
  const genuineFile = {};
  approved.set(genuineFile, 'C:\\chosen-native-file.txt');
  await exposed.importDroppedFiles([genuineFile], 'workspace-id');
  assert.equal(calls[0][1], 'importDroppedPaths');
  assert.equal(calls[0][2].paths[0], 'C:\\chosen-native-file.txt');
  const unsubscribe = exposed.subscribe(() => {});
  assert.ok(listeners.has('muse:event'));
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('main rejects foreign webContents, child frames and remote documents before IPC work', t => {
  const host = fixture(t);
  assert.doesNotThrow(() => host.assertSender({ sender: host.webContents, senderFrame: host.webContents.mainFrame }));
  host.webContents.mainFrame.url = `${rendererURL}#chat/local`;
  assert.doesNotThrow(() => host.assertSender({ sender: host.webContents, senderFrame: host.webContents.mainFrame }));
  assert.throws(() => host.assertSender({ sender: {}, senderFrame: host.webContents.mainFrame }));
  assert.throws(() => host.assertSender({ sender: host.webContents, senderFrame: { url: rendererURL } }));
  host.webContents.mainFrame.url = 'https://provider-a.example/';
  assert.throws(() => host.assertSender({ sender: host.webContents, senderFrame: host.webContents.mainFrame }));
});

test('preload never exposes the host API inside a child frame',()=>{
  let exposed=false;
  vm.runInNewContext(fs.readFileSync(path.join(appRoot,'preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld(){exposed=true;}},ipcRenderer:{}}),process:{isMainFrame:false}});
  assert.equal(exposed,false);
});

test('managed file creation and edits refresh public state and subsequent model context', async t => {
  const host = fixture(t);
  const workspace = host.store.createWorkspace({ name: 'Editable reference' });
  const result = await host.operations.createTextFile({ workspaceId: workspace.id, name: 'editable.md', content: 'BEFORE-EDIT' });
  assert.ok(host.events.at(-1).snapshot.files.some(file => file.id === result.file.id));
  const chat = host.store.createChat({ workspaceId: workspace.id });
  const saved = host.operations.saveTextFile({ id: result.file.id, content: 'AFTER-EDIT', expectedSha256: result.preview.sha256 });
  const current = host.events.at(-1).snapshot;
  assert.equal(current.files.find(file => file.id === result.file.id).textPreview, 'AFTER-EDIT');
  const context = host.contextMessages(chat, null, host.store.settings(), current).map(message => message.content).join('\n');
  assert.ok(context.includes('AFTER-EDIT'));
  assert.ok(!context.includes('BEFORE-EDIT'));
  assert.ok(!JSON.stringify(current).includes('_contentRevision'));
  assert.equal(saved.preview.text, 'AFTER-EDIT');
  assert.throws(() => host.operations.saveTextFile({ id: result.file.id, content: 'STALE-EDIT', expectedSha256: result.preview.sha256 }), /修改/);
  assert.equal(host.operations.readFile({ id: result.file.id }).text, 'AFTER-EDIT');
});

test('external links reject file, script and embedded credentials', async t => {
  const host = fixture(t);
  for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'https://user:pass@example.com/']) await assert.rejects(host.operations.openExternal(url));
  assert.equal(host.external.length, 0);
  await host.operations.openExternal('https://example.com/help?q=desktop');
  assert.deepEqual(host.external, ['https://example.com/help?q=desktop']);
});

test('Store return values satisfy host integration and public state/export omit secret storage', async t => {
  const host = fixture(t);
  const workspace = await host.operations.createWorkspace({ name: 'Docs' });
  assert.equal(typeof workspace.id, 'string');
  const chat = await host.operations.createChat({ workspaceId: workspace.id });
  assert.ok(Array.isArray(chat.messages));
  const publicState = await host.operations.bootstrap();
  const exported = await host.store.exportData();
  for (const payload of [publicState, exported, host.events]) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('review-key-original-12345'));
    assert.ok(!text.includes('encryptedApiKey'));
    assert.ok(!text.includes('_storedName'));
    assert.ok(!text.includes(host.store.attachmentsDir));
  }
  assert.equal(publicState.settings.hasApiKey, true);
});

test('document context is workspace-scoped unless another file is explicitly attached', async t => {
  const host = fixture(t);
  const workspaceA = host.store.createWorkspace({ name: 'A' });
  const workspaceB = host.store.createWorkspace({ name: 'B' });
  const makeFile = async (name, content, workspaceId) => {
    const sourcePath = path.join(host.dir, name); fs.writeFileSync(sourcePath, content);
    return host.store.addFile({ sourcePath, workspaceId });
  };
  await makeFile('a.txt', 'ONLY_WORKSPACE_A', workspaceA.id);
  const privateB = await makeFile('b.txt', 'ONLY_WORKSPACE_B', workspaceB.id);
  await makeFile('unscoped.txt', 'ONLY_UNSCOPED', null);
  const chat = host.store.createChat({ workspaceId: workspaceA.id });
  let context = JSON.stringify(await host.contextMessages(chat, undefined, host.store.settings(), host.store.snapshot()));
  assert.match(context, /ONLY_WORKSPACE_A/);
  assert.doesNotMatch(context, /ONLY_WORKSPACE_B|ONLY_UNSCOPED/);
  host.store.appendMessage(chat.id, { role: 'user', content: 'Explicit attachment', attachmentIds: [privateB.id] });
  context = JSON.stringify(await host.contextMessages(host.store.getChat(chat.id), undefined, host.store.settings(), host.store.snapshot()));
  assert.match(context, /ONLY_WORKSPACE_B/);
  assert.doesNotMatch(context, /ONLY_UNSCOPED/);
  assert.doesNotMatch(context, /attachments[\\/]/);
});

test('queued generation binds provider endpoint, model and API key to one settings revision', async t => {
  let actual;
  const host = fixture(t, { streamCompletion: async options => { actual = options; return { content: 'ok' }; } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.store.saveSettings({ baseUrl: 'https://provider-b.example/v1', model: 'model-b', apiKey: 'review-key-changed-67890' });
  await runQueued(host);
  assert.equal(actual.settings.baseUrl, 'https://provider-a.example/v1');
  assert.equal(actual.settings.model, 'model-a');
  assert.equal(actual.apiKey, 'review-key-original-12345');
  assert.equal(host.store.getChat(chat.id).messages.at(-1).status, 'complete');
});

test('explicit recent attachments take priority when workspace documents exceed the context budget', async t => {
  const host=fixture(t);
  const workspace=host.store.createWorkspace({name:'Full workspace'});
  for(let index=0;index<5;index++){
    const sourcePath=path.join(host.dir,`context-${index}.txt`);fs.writeFileSync(sourcePath,'W'.repeat(16000));
    await host.store.addFile({sourcePath,workspaceId:workspace.id});
  }
  const sourcePath=path.join(host.dir,'explicit.txt');fs.writeFileSync(sourcePath,'PRIORITY_EXPLICIT_DOCUMENT');
  const file=await host.store.addFile({sourcePath});
  const chat=host.store.createChat({workspaceId:workspace.id});
  host.store.appendMessage(chat.id,{role:'user',content:'Read this attachment',attachmentIds:[file.id]});
  const context=await host.contextMessages(host.store.getChat(chat.id),undefined,host.store.settings(),host.store.snapshot());
  assert.match(JSON.stringify(context),/PRIORITY_EXPLICIT_DOCUMENT/);
});

test('queued generation retains its starting prompt and workspace document scope', async t => {
  let actual;
  const host = fixture(t, { streamCompletion: async options => { actual = options; return { content: 'ok' }; } });
  const workspaceA = host.store.createWorkspace({ name: 'A' });
  const workspaceB = host.store.createWorkspace({ name: 'B' });
  for (const [name, content, workspaceId] of [['start.txt', 'DOC_AT_SEND', workspaceA.id], ['later.txt', 'DOC_AFTER_MOVE', workspaceB.id]]) {
    const sourcePath = path.join(host.dir, name); fs.writeFileSync(sourcePath, content);
    await host.store.addFile({ sourcePath, workspaceId });
  }
  const chat = host.store.createChat({ workspaceId: workspaceA.id });
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.store.saveSettings({ systemPrompt: 'PROMPT_AFTER_SEND' });
  host.store.updateChat({ id: chat.id, workspaceId: workspaceB.id });
  await runQueued(host);
  const context = JSON.stringify(actual.messages);
  assert.match(context, /PROMPT_AT_SEND/);
  assert.match(context, /DOC_AT_SEND/);
  assert.doesNotMatch(context, /PROMPT_AFTER_SEND|DOC_AFTER_MOVE/);
});

test('deleting a queued chat leaves its provider signal aborted and produces no lifecycle errors', async t => {
  const host = fixture(t, { streamCompletion: async options => {
    // Provider contract permits a pre-aborted call, but it must never send it.
    assert.equal(options.signal.aborted, true);
    throw Object.assign(new Error('cancelled before dispatch'), { name: 'AbortError' });
  } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.operations.deleteChat({ id: chat.id });
  await runQueued(host);
  assert.equal(host.errors.length, 0);
  assert.throws(() => host.store.getChat(chat.id));
  assert.equal(host.events.filter(e => /^chat-(complete|cancelled|error)$/.test(e.type)).length, 0);
});

test('stopping a stream persists partial output once, drops late deltas and permits retry', async t => {
  const entered = deferred(); let options;
  const host = fixture(t, { streamCompletion: async value => {
    options = value; value.onDelta('partial'); entered.resolve();
    return new Promise((_resolve, reject) => value.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.scheduled.shift()();
  await entered.promise;
  const queued = await host.operations.sendMessage({ chatId: chat.id, content: 'duplicate' });
  assert.equal(queued.queued, true);
  host.operations.stopGeneration({ chatId: chat.id });
  options.onDelta('late forbidden');
  await waitFor(() => host.active.size === 0, 'cancelled job clears');
  const saved = host.store.getChat(chat.id);
  assert.equal(saved.messages.at(-1).status, 'cancelled');
  assert.equal(saved.messages.at(-1).content, 'partial');
  assert.equal(host.events.filter(e => e.type === 'chat-cancelled').length, 1);
  assert.equal(host.events.filter(e => e.type === 'chat-complete').length, 0);
  assert.equal(host.events.filter(e => e.type === 'chat-delta').length, 1);
  host.provider.streamCompletion = async () => ({ content: 'retried' });
  await host.operations.retryMessage({ chatId: chat.id });
  await runQueued(host);
  assert.equal(host.store.getChat(chat.id).messages.filter(m => m.role === 'user').length, 1);
  assert.equal(host.store.getChat(chat.id).messages.at(-1).content, 'retried');
});

test('deleting a running chat aborts its request and does not recreate the deleted record', async t => {
  const entered = deferred(); let signal;
  const host = fixture(t, { streamCompletion: async value => {
    signal = value.signal; entered.resolve();
    return new Promise((_resolve, reject) => value.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.scheduled.shift()(); await entered.promise;
  host.operations.deleteChat({ id: chat.id });
  assert.equal(signal.aborted, true);
  await waitFor(() => host.active.size === 0, 'deleted job clears');
  assert.equal(host.errors.length, 0);
  assert.equal(host.store.snapshot().chats.some(c => c.id === chat.id), false);
  assert.equal(host.events.filter(e => /^chat-(complete|cancelled|error)$/.test(e.type)).length, 0);
});

test('old job key is redacted from errors even after provider settings are replaced', async t => {
  const host = fixture(t, { streamCompletion: async () => { throw new Error('remote rejected review-key-original-12345'); } });
  const chat = host.store.createChat();
  await host.operations.sendMessage({ chatId: chat.id, content: 'question' });
  host.store.saveSettings({ apiKey: 'review-key-changed-67890' });
  await runQueued(host);
  const state = JSON.stringify({ events: host.events, chat: host.store.getChat(chat.id), errors: host.errors });
  assert.doesNotMatch(state, /review-key-original-12345|review-key-changed-67890/);
  assert.equal(host.store.getChat(chat.id).messages.at(-1).status, 'error');
});

function scheduleInput(host,patch={}){
  const preview=host.operations.previewSchedule({cadence:{kind:'daily',timeZone:'Asia/Shanghai',time:'09:00'}});
  return{name:'host schedule',prompt:'SCHEDULE_HOST_FIXTURE',workspaceId:null,attachmentIds:[],enabled:false,cadence:preview.cadence,allowReadTools:false,notification:'none',expectedProviderBinding:preview.providerBinding,...patch};
}
test('host binds reviewed schedules to the current provider and refuses stale review or hidden authority fields',t=>{
  const host=fixture(t),input=scheduleInput(host);
  assert.throws(()=>host.operations.createSchedule({...input,authorization:{allowReadTools:true}}),/未声明/);
  host.store.saveSettings({model:'changed'});assert.throws(()=>host.operations.createSchedule(input),/模型连接已变化/);
  assert.equal(host.store.snapshot().schedules.length,0);
  const task=host.operations.createSchedule(scheduleInput(host));assert.equal(task.authorization.allowReadTools,false);
  assert.equal(task.providerBinding.model,'changed');assert.ok(!JSON.stringify(task).includes('review-key-original'));
});
test('a plain scheduled completion is saved as a distinct scoped chat without an invalid empty tool trace',async t=>{
  let captured;const host=fixture(t,{streamCompletion:async input=>{captured=input;input.onDelta('scheduled answer');return{content:'scheduled answer'};}});
  const workspace=host.store.createWorkspace({name:'schedule workspace'});
  const task=host.operations.createSchedule(scheduleInput(host,{workspaceId:workspace.id}));
  const result=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});
  await waitFor(()=>host.store.getScheduleRun(result.runId).status==='succeeded','scheduled result');
  const run=host.store.getScheduleRun(result.runId),chat=host.store.getChat(result.chatId);
  assert.equal(run.dispatchStarted,true);assert.equal(chat.workspaceId,workspace.id);assert.equal(chat.messages.length,2);assert.equal(chat.messages.at(-1).content,'scheduled answer');assert.equal(chat.messages.at(-1).toolTrace,undefined);assert.equal(captured.tools,undefined);assert.equal(host.active.size,0);
});
test('background completion cannot forge a write call even when the provider ignores its read-only declarations',async t=>{
  const host=fixture(t,{streamCompletion:async input=>input.messages.at(-1)?.role==='tool'?{content:'policy denied'}:{content:'',toolCalls:[toolCall('forged-write','workspace_create_text_file',{name:'must-not-exist.md',content:'blocked'})],finishReason:'tool_calls'}});
  const task=host.operations.createSchedule(scheduleInput(host,{allowReadTools:true})),result=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});
  await waitFor(()=>host.store.getScheduleRun(result.runId).status==='succeeded','denied tool returned');
  assert.equal(host.store.snapshot().files.length,0);assert.equal(host.operations.bootstrap().approvals.length,0);
  const call=host.store.getChat(result.chatId).messages.at(-1).toolTrace[0].calls[0];assert.equal(JSON.parse(call.result).error.code,'scheduled_read_only');assert.equal(call.status,'error');
});
test('provider changes pause a future run before dispatch and never send it to the new service',async t=>{
  let calls=0;const host=fixture(t,{streamCompletion:async()=>{calls++;return{content:'must not send'};}});
  const task=host.operations.createSchedule(scheduleInput(host));host.store.saveSettings({baseUrl:'https://new-provider.example/v1'});
  const result=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});await waitFor(()=>host.store.getScheduleRun(result.runId).status==='failed','changed provider rejected');
  const run=host.store.getScheduleRun(result.runId);assert.equal(calls,0);assert.equal(run.dispatchStarted,false);assert.equal(host.store.getSchedule(task.id).enabled,false);assert.match(run.error,/模型地址或名称已变化/);
});
test('stopping an uncooperative scheduled stream detaches the job, saves partial output and ignores its late result',async t=>{
  let resolve,started=false;const host=fixture(t,{streamCompletion:async input=>{started=true;input.onDelta('safe partial response '.repeat(30));return new Promise(done=>{resolve=done;});}});
  const task=host.operations.createSchedule(scheduleInput(host)),result=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});await waitFor(()=>started,'scheduled stream starts');
  host.operations.stopSchedule({id:task.id});await waitFor(()=>host.store.getScheduleRun(result.runId).status==='cancelled','scheduled stream stops');
  const before=host.store.getChat(result.chatId).messages.at(-1);assert.equal(host.active.size,0);assert.ok(before.content.length>0);assert.equal(before.status,'cancelled');
  resolve({content:'LATE MUST NOT REPLACE'});await new Promise(done=>setTimeout(done,15));assert.equal(host.store.getChat(result.chatId).messages.at(-1).content,before.content);
});

test('scheduled finalization persists its answer before admitting a queued user follow-up and retry preserves the old run result',async t=>{
  let release,followHistory;const host=fixture(t,{streamCompletion:async input=>{const last=input.messages.filter(message=>message.role==='user').at(-1)?.content;if(last==='SCHEDULE_HOST_FIXTURE')return new Promise(done=>{release=()=>done({content:'SCHEDULED_ANSWER_REQUIRED_IN_CONTEXT'});});followHistory=input.messages;return{content:'follow-up answer'};}});
  const task=host.operations.createSchedule(scheduleInput(host)),result=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});await waitFor(()=>!!release,'schedule provider starts');
  await host.operations.sendMessage({chatId:result.chatId,content:'follow-up question'});release();
  await waitFor(()=>host.scheduled.length>0,'follow-up admitted');await runQueued(host);
  assert.ok(followHistory.some(message=>message.role==='assistant'&&message.content==='SCHEDULED_ANSWER_REQUIRED_IN_CONTEXT'));
  const run=host.store.getScheduleRun(result.runId);assert.equal(host.store.getChat(result.chatId).messages.find(message=>message.id===run.messageId).content,'SCHEDULED_ANSWER_REQUIRED_IN_CONTEXT');
  release=null;const second=host.operations.runScheduleNow({id:task.id,expectedRevision:task.revision});await waitFor(()=>!!release,'second run starts');release();await waitFor(()=>host.store.getScheduleRun(second.runId).status==='succeeded','second run finishes');
  const oldId=host.store.getScheduleRun(second.runId).messageId;await host.operations.retryMessage({chatId:second.chatId});
  assert.notEqual(host.active.get(second.chatId).messageId,oldId);assert.equal(host.store.getChat(second.chatId).messages.find(message=>message.id===oldId).content,'SCHEDULED_ANSWER_REQUIRED_IN_CONTEXT');
  host.operations.stopGeneration({chatId:second.chatId});await runQueued(host);
});
test('cancelled unsaved-window quit retains the tray and permits new chat admission',async t=>{
  const host=fixture(t);host.operations.saveBackgroundSettings({backgroundTasks:true,launchAtLogin:false});host.createWindow();
  host.appEvents.get('before-quit')();assert.equal(host.operations.bootstrap().app.backgroundTrayActive,true);
  host.webEvents.get('will-prevent-unload')({preventDefault(){assert.fail('Continue editing must keep unload prevented');}});
  let prevented=false;host.windowEvents.get('close')({preventDefault(){prevented=true;}});assert.equal(prevented,true,'background Close is restored after cancelled quit');
  const chat=host.store.createChat();await host.operations.sendMessage({chatId:chat.id,content:'after cancelled quit'});await runQueued(host);assert.equal(host.store.getChat(chat.id).messages.at(-1).status,'complete');
  host.operations.saveBackgroundSettings({backgroundTasks:false,launchAtLogin:false});
});

test('provider redacts credentials before truncating an overlong remote error', async () => {
  const providerFile = path.join(appRoot, 'backend', 'provider.cjs');
  const credential = 'CUSTOM_CREDENTIAL_CROSSES_TRUNCATION_BOUNDARY_123456789';
  const sandbox = {
    module: { exports: {} }, exports: {}, URL, AbortController, DOMException, TextDecoder, setTimeout, clearTimeout,
    fetch: async () => new Response(JSON.stringify({ error: { message: 'x'.repeat(684) + credential + ' denied' } }), { status: 401, headers: { 'content-type': 'application/json' } })
  };
  vm.runInNewContext(fs.readFileSync(providerFile, 'utf8'), sandbox, { filename: providerFile });
  await assert.rejects(
    sandbox.module.exports.listModels({ settings: { baseUrl: 'https://provider.example/v1' }, apiKey: credential }),
    error => {
      assert.ok(!error.message.includes(credential.slice(0, 12)), 'Remote error leaked a recognizable credential prefix at the truncation boundary');
      return true;
    }
  );
});
