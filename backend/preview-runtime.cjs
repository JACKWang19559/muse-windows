'use strict';
const crypto = require('node:crypto');
const { types } = require('node:util');
const CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = message => { throw new Error(message); };
function sdkBootstrap(config) {
  'use strict';
  let port, sequence = 0, resolveReady, announceTimer;
  const pending = new Map();
  const ready = new Promise(resolve => { resolveReady = resolve; });
  function request(action, payload) {
    return ready.then(() => new Promise((resolve, reject) => {
      if (pending.size >= 64) return reject(new Error('应用请求过多。'));
      const requestId = String(++sequence);
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('应用数据请求超时。')); }, 15000);
      pending.set(requestId, { resolve, reject, timeout });
      port.postMessage({ type: 'muse:request', requestId, action, payload });
    }));
  }
  const api = Object.freeze({ ready, data: Object.freeze({
    get: key => request('get', { key }), list: (prefix = '') => request('list', { prefix }),
    set: (key, value, expectedVersion) => request('set', { key, value, expectedVersion }),
    delete: (key, expectedVersion) => request('delete', { key, expectedVersion })
  }) });
  Object.defineProperty(window, 'museArtifact', { value: api, writable: false, configurable: false });
  function connect(event) {
    if (port || event.source !== parent || event.data?.type !== 'muse:connect' || event.data.sessionId !== config.sessionId || event.data.documentToken !== config.documentToken || event.ports.length !== 1) return;
    port = event.ports[0];
    clearInterval(announceTimer);
    port.onmessage = event => {
      const message = event.data;
      if (message?.type !== 'muse:response' || typeof message.requestId !== 'string') return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId); clearTimeout(entry.timeout);
      if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.error || '应用数据请求失败。'));
    };
    port.start(); window.removeEventListener('message', connect); resolveReady();
  }
  window.addEventListener('message', connect);
  window.addEventListener('pagehide', () => { port?.close(); for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('预览已关闭。')); } pending.clear(); });
  const announce = () => parent.postMessage({ type: 'muse:ready', sessionId: config.sessionId, documentToken: config.documentToken }, '*');
  announce(); announceTimer = setInterval(announce,250); setTimeout(()=>clearInterval(announceTimer),15000);
}
async function decorate(html, config) {
  const { parse, serialize, defaultTreeAdapter: adapter } = await import('parse5');
  const document = parse(html), namespace = 'http://www.w3.org/1999/xhtml';
  function scrub(node) {
    for (const child of [...(node.childNodes || [])]) {
      const attrs = Object.fromEntries((child.attrs || []).map(a => [a.name, a.value]));
      if (child.tagName === 'base' || child.tagName === 'meta' && ['refresh','content-security-policy'].includes((attrs['http-equiv'] || '').toLowerCase())) adapter.detachNode(child);
      else scrub(child);
    }
    if (node.content) scrub(node.content);
  }
  scrub(document);
  const head = document.childNodes.find(n => n.tagName === 'html').childNodes.find(n => n.tagName === 'head');
  const meta = adapter.createElement('meta', namespace, [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: CSP }]);
  const script = adapter.createElement('script', namespace, []);
  adapter.insertText(script, `(${sdkBootstrap.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')});`);
  if (head.childNodes.length) { adapter.insertBefore(head, meta, head.childNodes[0]); adapter.insertBefore(head, script, head.childNodes[1]); }
  else { adapter.appendChild(head, meta); adapter.appendChild(head, script); }
  return serialize(document);
}
class PreviewRuntime {
  #store; #sessions = new Map(); #now;
  constructor(store, { now = Date.now } = {}) { this.#store = store; this.#now = now; }
  #session(input) {
    if (!plain(input) || typeof input.sessionId !== 'string' || typeof input.documentToken !== 'string') fail('预览身份无效。');
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.documentToken !== input.documentToken || this.#now() - session.createdAt > 30 * 60 * 1000) fail('预览已失效，请重新打开。');
    let artifact, build;
    try { artifact = this.#store.getArtifact(session.artifactId); build = this.#store.readArtifactBuild({ id: session.artifactId, buildId: session.buildId }); } catch { fail('应用或构建已不存在，请重新打开。'); }
    if (artifact.workspaceId !== session.workspaceId || build.id !== session.buildId || build.sha256 !== session.buildHash) fail('预览范围已变化，请重新打开。');
    return session;
  }
  async open(input) {
    if (!plain(input) || typeof input.id !== 'string' || input.buildId != null && typeof input.buildId !== 'string' || input.pagePath != null && typeof input.pagePath !== 'string') fail('应用预览参数无效。');
    const artifact = this.#store.getArtifact(input.id), build = this.#store.readArtifactBuild({ id: input.id, ...(input.buildId ? { buildId: input.buildId } : {}) });
    const page = input.pagePath ? build.pages.find(page => page.path === input.pagePath) : build.pages[0];
    if (!page) fail('这个构建中没有所选页面。');
    for (const [id, session] of this.#sessions) if (this.#now() - session.createdAt > 30 * 60 * 1000) this.#sessions.delete(id);
    if (this.#sessions.size >= 32) fail('打开的应用预览过多，请关闭一些后重试。');
    const sessionId = crypto.randomUUID(), documentToken = crypto.randomBytes(32).toString('hex');
    const html = await decorate(page.html, { sessionId, documentToken });
    if (this.#sessions.size >= 32) fail('打开的应用预览过多，请关闭一些后重试。');
    // Recheck after asynchronous parsing so a moved/deleted artifact cannot gain a session.
    const session = { artifactId: artifact.id, workspaceId: artifact.workspaceId, buildId: build.id, buildHash: build.sha256, documentToken, html, createdAt: this.#now(), active: false, replies: new Map() };
    this.#sessions.set(sessionId, session);
    try { this.#session({ sessionId, documentToken }); } catch (error) { this.#sessions.delete(sessionId); throw error; }
    return { sessionId, documentToken, url: `muse-preview://document/${sessionId}/${documentToken}`, artifactId: artifact.id, buildId: build.id, sourceRevision: build.sourceRevision, pagePath: page.path, pages: build.pages.map(page => page.path) };
  }
  document(url) {
    const parsed = new URL(url);
    const match = /^\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(parsed.pathname);
    if (parsed.protocol !== 'muse-preview:' || parsed.hostname !== 'document' || parsed.search || parsed.hash || !match) fail('预览页面地址无效。');
    return this.#session({ sessionId: match[1], documentToken: match[2] }).html;
  }
  activate(input) { const session = this.#session(input); session.active = true; return { active: true }; }
  close(input) {
    if (!plain(input) || typeof input.sessionId !== 'string' || typeof input.documentToken !== 'string') fail('预览身份无效。');
    const session = this.#sessions.get(input.sessionId);
    if (session && session.documentToken !== input.documentToken) fail('预览身份无效。');
    this.#sessions.delete(input.sessionId); return { closed: true };
  }
  closeAll() { this.#sessions.clear(); }
  request(input) {
    const session = this.#session(input);
    if (!session.active || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId) || !['get','list','set','delete'].includes(input.action) || !plain(input.payload)) fail('应用数据请求无效或预览尚未就绪。');
    const allowed = { get: ['key'], list: ['prefix'], set: ['key','value','expectedVersion'], delete: ['key','expectedVersion'] }[input.action];
    if (Object.keys(input.payload).some(key => !allowed.includes(key))) fail('应用数据请求包含未授权字段。');
    const serialized = JSON.stringify([input.action, input.payload]);
    if (Buffer.byteLength(serialized) > 270 * 1024) fail('应用数据请求过大。');
    const fingerprint = crypto.createHash('sha256').update(serialized).digest('hex');
    if (session.replies.has(input.requestId)) {
      const prior = session.replies.get(input.requestId);
      if (prior.fingerprint !== fingerprint) fail('重复的请求标识包含不同内容。');
      return structuredClone(prior.result);
    }
    if (session.replies.size >= 256) fail('此预览已达请求上限，请重新打开。');
    const method = { get: 'artifactDataGet', list: 'artifactDataList', set: 'artifactDataSet', delete: 'artifactDataDelete' }[input.action];
    const result = this.#store[method]({ ...input.payload, id: session.artifactId });
    session.replies.set(input.requestId, { fingerprint, result: structuredClone(result) });
    return result;
  }
}
module.exports = { PreviewRuntime, decorate, CSP };
