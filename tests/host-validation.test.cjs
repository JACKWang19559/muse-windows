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
const API_METHODS = 'bootstrap saveSettings testConnection listModels createWorkspace updateWorkspace deleteWorkspace createChat updateChat deleteChat sendMessage stopGeneration respondApproval retryMessage importFiles importDroppedFiles removeFile createTextFile saveTextFile readFile openFile exportChat exportData importData copyText openExternal windowControl subscribe'.split(' ');

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
  const scheduled = [], events = [], errors = [], external = [], handlers = new Map();
  const provider = {
    streamCompletion: async options => { options.onDelta('answer'); return { content: 'answer' }; },
    listModels: async () => ['model-a'], testConnection: async () => ({ ok: true, message: 'local stub' }),
    ...overrides
  };
  const webContents = { mainFrame: { url: rendererURL }, send: (_channel, event) => events.push(structuredClone(event)) };
  const window = { webContents, isDestroyed: () => false, minimize() {}, maximize() {}, unmaximize() {}, isMaximized: () => false, close() {} };
  const app = { setName() {}, getVersion: () => 'test', getPath: () => dir, on() {}, requestSingleInstanceLock: () => true, quit() {}, whenReady: () => ({ then: () => ({ catch() {} }) }) };
  const electron = {
    app, BrowserWindow: function () {}, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    safeStorage: {}, shell: { openExternal: async url => external.push(url), openPath: async () => '', showItemInFolder() {} },
    clipboard: { writeText() {} }, nativeTheme: {}, Menu: { setApplicationMenu() {} }
  };
  const sandbox = {
    require: name => name === 'electron' ? electron : name === './backend/provider.cjs' ? provider : name === './backend/agent-loop.cjs' ? {
      // This VM is a separate JS realm. Recreate the host-owned wire payload
      // in the module's realm, as the actual Electron main process constructs it.
      runAgentConversation: options => mainRequire(name).runAgentConversation({ ...options, messages: JSON.parse(JSON.stringify(options.messages)) })
    } : mainRequire(name),
    __dirname: appRoot, process, console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setImmediate: callback => { scheduled.push(callback); }
  };
  const expose = '\n;globalThis.hostUnderTest={operations,active,assertSender,contextMessages,cleanError,setState:(s,w)=>{store=s;window=w;}};';
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8') + expose, sandbox, { filename: mainFile });
  // Production main and Store share a realm; the VM fixture serializes its
  // host-owned data at this test boundary without relaxing JSON validators.
  const mainStore = new Proxy(store, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? (...args) => value.apply(target, args.map(arg => arg && typeof arg === 'object' ? JSON.parse(JSON.stringify(arg)) : arg)) : value; } });
  sandbox.hostUnderTest.setState(mainStore, window);
  return { ...sandbox.hostUnderTest, store, dir, window, webContents, provider, scheduled, events, errors, external };
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
  await assert.rejects(host.operations.sendMessage({ chatId: chat.id, content: 'duplicate' }), /正在生成/);
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
