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
const API_METHODS = 'bootstrap saveSettings testConnection listModels createWorkspace updateWorkspace deleteWorkspace createChat updateChat deleteChat sendMessage stopGeneration retryMessage importFiles importDroppedFiles removeFile readFile openFile exportChat exportData importData copyText openExternal windowControl subscribe'.split(' ');

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
    require: name => name === 'electron' ? electron : name === './backend/provider.cjs' ? provider : mainRequire(name),
    __dirname: appRoot, process, console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setImmediate: callback => { scheduled.push(callback); }
  };
  const expose = '\n;globalThis.hostUnderTest={operations,active,assertSender,contextMessages,cleanError,setState:(s,w)=>{store=s;window=w;}};';
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8') + expose, sandbox, { filename: mainFile });
  sandbox.hostUnderTest.setState(store, window);
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
