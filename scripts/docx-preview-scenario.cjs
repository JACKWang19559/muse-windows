'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog, shell } = require('electron');
const fixtures = require('./docx-fixtures.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// These are owned test documents and an isolated fixture profile. IPC, DOM,
// MessageChannels and the document renderer are real. Only the native save
// picker is simulated; the export operation and filesystem bytes are real.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('Word checks require the isolated desktop fixture profile.');
  const sourceDir = path.join(folder, 'docx-fixtures'), outputDir = path.join(folder, 'docx-output');
  fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(outputDir, { recursive: true });
  const original = { read: operations.readDocxFile, export: operations.exportFile, save: operations.saveTextFile, picker: dialog.showSaveDialog, external: operations.openExternal, shellExternal: shell.openExternal };
  const ids = new Set(), sources = [], reads = [], downloads = [], choices = [], holds = new Map(), releases = [], samples = [], external = [], consoleMessages = [], gestures = [], externalCallbacks = [], browserLaunches = [];
  const initialBounds = window.getBounds();
  let installed = false, saves = 0, debuggerAttached = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), release: () => resolve() }; };
  const hostWait = async (fn, timeout = 12000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (fn()) return; await pause(30); } throw Error('Owned Word host gate did not settle.'); };
  const click = id => page(name => { const target = document.querySelector('[data-testid="' + name + '"]'); if (!target) throw Error('Missing Word action ' + name); target.click(); }, id);
  const closeEditor = async () => {
    if (!await page(() => !!document.querySelector('[data-testid="file-preview"]'))) return;
    await page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
    if (await page(() => !!document.querySelector('[data-testid="file-discard"]'))) await click('file-discard');
    await wait(() => !document.querySelector('[data-testid="file-preview"]'));
  };
  const openWorkspace = async space => {
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(el => el.textContent.includes(name)), space.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(el => el.textContent.includes(name)).click(), space.name);
    await wait(name => document.querySelector('.workspace-title h2')?.textContent === name, space.name);
  };
  const openFile = async file => {
    await wait(name => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === name), file.name);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), file.name);
    await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name, file.name);
  };
  const refresh = space => operations.updateWorkspace({ id: space.id, name: space.name });
  const add = async (space, name, bytes) => {
    const sourcePath = path.join(sourceDir, name); fs.writeFileSync(sourcePath, bytes);
    const file = await store.addFile({ sourcePath, workspaceId: space.id }); ids.add(file.id);
    sources.push({ path: sourcePath, sha256: hash(bytes), bytes: Buffer.from(bytes) }); return file;
  };
  const ready = file => wait(id => { const root = document.querySelector('[data-testid="docx-preview"]'); return root?.dataset.fileId === id && root.dataset.docxState === 'ready' && !!root.querySelector('[data-testid="docx-frame"]'); }, file.id, 25000);
  const failed = file => wait(id => { const root = document.querySelector('[data-testid="docx-preview"]'); return root?.dataset.fileId === id && root.dataset.docxState === 'error' && !!root.querySelector('[data-testid="docx-retry"]'); }, file.id, 18000);
  const currentFrame = () => window.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('muse-docx://viewer/preview.html#'));
  const child = async (fn, value) => {
    const frame = currentFrame(); if (!frame) throw Error('No current real Word child frame');
    return frame.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${fn.toString()})(${JSON.stringify(value)})};}catch(error){return {ok:false,error:String(error?.message||error)}}})()`).then(result => { if (!result.ok) throw Error(result.error); return result.value; });
  };
  const sample = async (name, file) => {
    const result = await child(() => {
      const root = document.querySelector('#document'), pages = [...root.querySelectorAll('section.docx')], image = [...root.querySelectorAll('img')].find(img => img.complete && img.naturalWidth === 32 && img.naturalHeight === 24);
      let pixels = null;
      if (image) { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, 32, 24).data; let red = 0, blue = 0; for (let i = 0; i < data.length; i += 4) { if (data[i] === 238 && data[i + 1] === 44 && data[i + 2] === 44 && data[i + 3] === 255) red++; if (data[i] === 32 && data[i + 1] === 96 && data[i + 2] === 238 && data[i + 3] === 255) blue++; } pixels = { red, blue, width: image.naturalWidth, height: image.naturalHeight }; canvas.width = 0; canvas.height = 0; }
      const bold = [...root.querySelectorAll('span')].find(el => el.textContent === 'OWNED_BOLD'), rect = pages[0]?.getBoundingClientRect();
      let parentBlocked = false; try { void parent.document.body; } catch (error) { parentBlocked = error.name === 'SecurityError'; }
      return { pages: pages.length, text: root.innerText, tableCells: [...root.querySelectorAll('td')].map(el => el.innerText.trim()), boldWeight: bold ? getComputedStyle(bold).fontWeight : null, headerCount: root.querySelectorAll('header').length, footerCount: root.querySelectorAll('footer').length, pixels, zoom: getComputedStyle(root).zoom, firstPageWidth: rect?.width, innerWidth, scrollTop: document.scrollingElement.scrollTop, origin: globalThis.origin, locationOrigin: location.origin, node: typeof require !== 'undefined' || typeof process !== 'undefined', muse: typeof window.muse !== 'undefined', parentBlocked, unsafeExecuted: globalThis.__OWNED_DOCX_UNSAFE === 1, altExecuted: globalThis.__OWNED_ALT_EXECUTED === 1, embeddedElements: root.querySelectorAll('iframe,object,embed,script,form').length, anchors: [...root.querySelectorAll('a')].map(el => ({ text: el.textContent, href: el.getAttribute('href'), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex') })), externalDOMURLs: [...root.querySelectorAll('[src],[href]')].map(el => el.getAttribute('src') || el.getAttribute('href')).filter(value => /^https?:/i.test(value || '')) };
    });
    const activeId = await page(() => document.querySelector('[data-testid="docx-preview"]')?.dataset.fileId);
    if (activeId !== file.id) throw Error('Wrong Word document sampled');
    samples.push({ fixture: name, fileId: file.id, ...result }); return result;
  };
  const probe = () => page(() => { const p = window.__docxProbe28; return { channels: p.channels.map(c => ({ id: c.id, createdOrder: c.createdOrder, closedOrder: c.closedOrder, closeCalls: c.closeCalls, messages: c.messages.slice() })), frames: p.frames.map(f => ({ connected: f.isConnected, src: f.src, sandbox: f.getAttribute('sandbox'), referrerPolicy: f.referrerPolicy })), readyEvents: p.readyEvents.slice(), unhandled: p.unhandled.slice() }; });
  const screenshot = async name => { await pause(120); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };
  const holdRead = id => { const hold = { used: false, gate: deferred() }; holds.set(id, hold); releases.push(hold.gate.release); return hold; };
  const consoleListener = event => { if (typeof event.message === 'string') consoleMessages.push({ level: event.level, message: event.message }); };
  const trustedLink = async label => {
    const geometry = await child(text => { const el = [...document.querySelectorAll('#document a')].find(a => a.textContent === text); if (!el) throw Error('No owned link'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight }; }, label);
    const frameRect = await page(() => { const r = document.querySelector('[data-testid="docx-frame"]').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    if (!geometry.visible) throw Error('Owned link is outside the actual Word viewport');
    window.focus(); window.webContents.focus(); const point = { x: Math.round(frameRect.x + geometry.x), y: Math.round(frameRect.y + geometry.y) };
    if (!window.webContents.debugger.isAttached()) { window.webContents.debugger.attach('1.3'); debuggerAttached = true; }
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
    gestures.push({ label, kind: 'trusted CDP Input.dispatchMouseEvent', x: point.x, y: point.y });
  };
  try {
    await closeEditor();
    window.webContents.setAudioMuted(true); window.show(); if (window.isMinimized()) window.restore();
    const bytes = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => { const data = Buffer.from(fixture.base64, 'base64'); if (data.length !== fixture.size || hash(data) !== fixture.sha256) throw Error('Owned Word fixture hash changed'); return [name, data]; }));
    const space = await operations.createWorkspace({ name: 'Word 富文档隔离验收' }), files = {};
    for (const [key, name] of Object.entries({ rich: '自有富文档.DOCX', stored: '自有未压缩.docx', cachedBreak: '自有缓存分页.docx', external: '自有外部关系.docx', corrupt: '自有损坏.docx', crcMismatch: '自有错误校验.docx', expansionMismatch: '自有膨胀错误.docx' })) files[key] = await add(space, name, bytes[key]);
    const note = (await operations.createTextFile({ workspaceId: space.id, name: 'Word草稿保护.txt', content: 'OWNED_DOCX_NOTE_BASELINE' })).file; ids.add(note.id);
    await refresh(space); await openWorkspace(space);
    operations.readDocxFile = async input => {
      if (!ids.has(input?.id)) return original.read(input);
      const entry = { id: input.id, name: input.expectedName, keys: Object.keys(input), settled: false }; reads.push(entry);
      try { const result = await original.read(input); entry.ok = true; entry.size = result.size; entry.sha256 = result.sha256; const hold = holds.get(input.id); if (hold && !hold.used) { hold.used = true; await hold.gate.promise; } return result; } finally { entry.settled = true; }
    };
    operations.exportFile = async input => {
      if (!ids.has(input?.id)) return original.export(input);
      const entry = { input: { ...input }, settled: false }; downloads.push(entry);
      try { const result = await original.export(input); entry.result = result; return result; } finally { entry.settled = true; }
    };
    operations.saveTextFile = async input => { if (ids.has(input?.id)) saves++; return original.save(input); };
    operations.openExternal = async value => { const entry = { href: value, settled: false }; externalCallbacks.push(entry); try { return await original.external(value); } finally { entry.settled = true; } };
    shell.openExternal = async href => { if (href !== 'https://owned.example.invalid/docx-approved') throw Error('Unexpected external target during owned Word checks'); browserLaunches.push({ href, simulated: true }); };
    dialog.showSaveDialog = async (_owner, options) => {
      if (options?.title !== '下载文件副本') throw Error('Unexpected picker during Word scenario');
      const choice = choices.shift(); if (!choice || !same(path.dirname(choice.target), outputDir)) throw Error('Word picker escaped the owned output directory');
      choice.name = options.defaultPath; choice.used = true; if (choice.gate) await choice.gate.promise; return { canceled: false, filePath: choice.target };
    };
    window.webContents.on('console-message', consoleListener);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { external.push({ scheme: new URL(details.url).protocol, ownedTripwire: details.url.startsWith('https://docx-owned.invalid/'), resourceType: details.resourceType }); callback({ cancel: true }); });
    await page(() => {
      const NativeChannel = window.MessageChannel, create = document.createElement;
      const p = { channels: [], frames: [], sequence: 0, unhandled: [], readyEvents: [], originals: { NativeChannel, create } }; window.__docxProbe28 = p;
      window.MessageChannel = function () { const channel = new NativeChannel(), entry = { id: p.channels.length + 1, createdOrder: ++p.sequence, closedOrder: null, closeCalls: 0, messages: [] }; p.channels.push(entry); const close = channel.port1.close; channel.port1.close = function (...args) { entry.closeCalls++; entry.closedOrder = ++p.sequence; return Reflect.apply(close, this, args); }; channel.port1.addEventListener('message', event => { const data = event.data; if (data && typeof data.type === 'string') entry.messages.push({ type: data.type, ...(Number.isSafeInteger(data.pages) ? { pages: data.pages } : {}), ...(data.type === 'muse-docx-link' ? { parentActivation: navigator.userActivation.isActive } : {}), keys: Object.keys(data).sort() }); }); return channel; };
      window.MessageChannel.prototype = NativeChannel.prototype;
      document.createElement = function (...args) { const node = Reflect.apply(create, this, args); if (node instanceof HTMLIFrameElement) p.frames.push(node); return node; };
      p.readyListener = event => { if (event.data?.type === 'muse-docx-ready') p.readyEvents.push({ origin: event.origin, sourceIsCurrent: event.source === document.querySelector('[data-testid="docx-frame"]')?.contentWindow, nonceMatches: event.data.nonce === document.querySelector('[data-testid="docx-frame"]')?.src.split('#')[1] }); };
      p.unhandledListener = event => p.unhandled.push(String(event.reason?.message || event.reason)); window.addEventListener('message', p.readyListener); window.addEventListener('unhandledrejection', p.unhandledListener);
    }); installed = true;
    check('Word acceptance uses independently owned OOXML pixels and real host operations', Object.keys(bytes).length === 7 && sources.every(source => hash(fs.readFileSync(source.path)) === source.sha256));
    await openFile(files.rich); await ready(files.rich); const rich = await sample('rich', files.rich);
    check('Word explicit manual page breaks render three actual document pages', rich.pages === 3 && rich.text.includes('OWNED_DOCX_PAGE_1') && rich.text.includes('OWNED_DOCX_PAGE_2') && rich.text.includes('OWNED_DOCX_PAGE_3_BOOKMARK'));
    check('Word actual layout preserves Chinese bold text table cells and page headers and footers', rich.text.includes('自有中文文档') && rich.tableCells.join('|').includes('OWNED_TABLE_A|OWNED_TABLE_B|自有单元格|42') && Number(rich.boldWeight) >= 600 && rich.headerCount === 3 && rich.footerCount === 3);
    check('Word embedded owned PNG decodes to its exact natural size and red blue pixels', rich.pixels?.width === 32 && rich.pixels.height === 24 && rich.pixels.red === 384 && rich.pixels.blue === 384);
    check('Word iframe is genuinely opaque without Node preload or parent document access', rich.origin === 'null' && !rich.node && !rich.muse && rich.parentBlocked && (await probe()).frames.at(-1).sandbox === 'allow-scripts' && (await probe()).frames.at(-1).referrerPolicy === 'no-referrer');
    check('Word local preview fits the actual workbench width without enabling text editing', rich.firstPageWidth > 0 && rich.firstPageWidth <= rich.innerWidth + 1 && await page(() => document.querySelector('[data-testid="file-edit-mode"]').disabled && document.querySelector('[data-testid="file-save"]').disabled && !document.querySelector('[data-testid="file-download"]').disabled));
    check('Word disabled altChunk never creates active embedded HTML or sentinel content', !rich.text.includes('OWNED_ALTCHUNK_MUST_NOT_APPEAR') && !rich.altExecuted && rich.embeddedElements === 0);
    const safeAnchor = rich.anchors.find(a => a.text === 'OWNED_HTTPS_LINK'), unsafeAnchor = rich.anchors.find(a => a.text === 'OWNED_UNSAFE_LINK');
    check('Word links lose raw hrefs while only approved HTTPS and bookmark targets remain interactive', rich.anchors.every(a => a.href === null) && safeAnchor?.role === 'link' && safeAnchor.tabindex === '0' && unsafeAnchor?.role !== 'link' && unsafeAnchor.tabindex === '-1' && !rich.unsafeExecuted);
    await screenshot('docx-rich-three-pages.png');
    await trustedLink('OWNED_UNSAFE_LINK'); await pause(70);
    check('Word trusted activation of an unsafe document link cannot execute its script', !await child(() => globalThis.__OWNED_DOCX_UNSAFE === 1) && external.length === 0 && externalCallbacks.length === 0);
    await trustedLink('OWNED_HTTPS_LINK'); await hostWait(() => browserLaunches.length === 1 && externalCallbacks[0]?.settled);
    check('Word trusted HTTPS activation crosses the real child port parent gate IPC and host URL validation', externalCallbacks.length === 1 && externalCallbacks[0].href === 'https://owned.example.invalid/docx-approved' && browserLaunches[0].href === externalCallbacks[0].href && (await probe()).channels.at(-1).messages.some(message => message.type === 'muse-docx-link' && message.parentActivation === true));
    await trustedLink('OWNED_INTERNAL_LINK');
    // The asynchronous condition is evaluated in the real child; no scroll or
    // link callback is injected by the harness.
    const bookmarkDeadline = Date.now() + 3000; let bookmark = null;
    while (Date.now() < bookmarkDeadline) { bookmark = await child(() => { const target = document.getElementById('owned_docx_target') || document.querySelector('[id="owned_docx_target"]'); return { top: document.scrollingElement.scrollTop, targetTop: target?.getBoundingClientRect().top, innerHeight }; }); if (bookmark.top > 0) break; await pause(30); }
    check('Word trusted bookmark activation scrolls inside the real opaque document', bookmark.top > 0 && typeof bookmark.targetTop === 'number' && bookmark.targetTop >= -2 && bookmark.targetTop < bookmark.innerHeight);
    await screenshot('docx-bookmark.png');
    await openFile(files.cachedBreak); await ready(files.cachedBreak); const cached = await sample('cachedBreak', files.cachedBreak);
    check('Word cached last rendered page break does not create an extra page', cached.pages === 1 && cached.text.includes('OWNED_CACHED_BREAK_BEFORE') && cached.text.includes('OWNED_CACHED_BREAK_AFTER'));
    await openFile(files.stored); await ready(files.stored); const stored = await sample('stored', files.stored);
    check('Word stored ZIP entries render the same rich three page content and embedded pixels', stored.pages === 3 && stored.tableCells.length === 4 && stored.pixels?.red === 384 && stored.pixels.blue === 384);
    await openFile(files.external); await ready(files.external); const linked = await sample('external', files.external);
    check('Word external relationships expose no remote DOM resource URL or outbound request', linked.pages === 3 && linked.externalDOMURLs.length === 0 && external.length === 0);
    const delayed = deferred(), target = path.join(outputDir, 'captured-original.DOCX'), choice = { target, gate: delayed }; choices.push(choice); releases.push(delayed.release);
    await click('file-download'); await hostWait(() => choice.used); await openFile(files.rich); await ready(files.rich); delayed.release(); await hostWait(() => downloads.length === 1 && downloads[0].settled);
    check('Word original download captures the clicked document while another Word tab opens', downloads[0].input.id === files.external.id && Object.keys(downloads[0].input).join(',') === 'id' && fs.readFileSync(target).equals(bytes.external) && await page(id => document.querySelector('[data-testid="docx-preview"]').dataset.fileId === id, files.rich.id));
    await page(() => { const p = window.__docxProbe28; p.container = document.querySelector('[data-testid="docx-frame-container"]'); p.replacementChannel = p.channels.at(-1).id; });
    await openFile(files.stored); await ready(files.stored); const replaced = await probe();
    check('Word replacing a source reuses its container and closes the previous real port once', await page(() => window.__docxProbe28.container === document.querySelector('[data-testid="docx-frame-container"]')) && replaced.channels.slice(0, -1).every(c => c.closeCalls === 1) && replaced.frames.filter(f => f.connected).length === 1);
    await closeEditor(); const beforeLate = (await probe()).channels.length, hold = holdRead(files.stored.id); await openFile(files.stored); await hostWait(() => hold.used); await openFile(files.rich); await ready(files.rich); const afterReplacement = (await probe()).channels.length;
    hold.gate.release(); await hostWait(() => reads.every(read => read.settled)); await pause(100);
    check('Word a late real read cannot create a stale iframe or replace a newer document', afterReplacement === beforeLate + 1 && (await probe()).channels.length === afterReplacement && await page(id => document.querySelector('[data-testid="docx-preview"]').dataset.fileId === id, files.rich.id) && (await probe()).frames.filter(f => f.connected).length === 1);
    await closeEditor(); const closeHold = holdRead(files.stored.id), beforeClose = (await probe()).channels.length; await openFile(files.stored); await hostWait(() => closeHold.used); await closeEditor(); closeHold.gate.release(); await hostWait(() => reads.every(read => read.settled)); await pause(80);
    check('Word closing during a real read discards its late bytes without allocating a frame or port', (await probe()).channels.length === beforeClose && !(await probe()).frames.some(f => f.connected) && !await page(() => !!document.querySelector('[data-testid="docx-preview"]')));
    await openFile(files.corrupt); await failed(files.corrupt);
    check('Word malformed bytes show an actual isolated render error with original download available', await page(() => !document.querySelector('[data-testid="docx-frame"]') && !document.querySelector('[data-testid="file-download"]').disabled));
    const corruptReads = reads.filter(read => read.id === files.corrupt.id).length; await click('docx-retry'); await hostWait(() => reads.filter(read => read.id === files.corrupt.id).length > corruptReads); await failed(files.corrupt);
    check('Word retry rereads the real damaged file and does not fabricate a successful document', await page(() => document.querySelector('[data-testid="docx-preview"]').dataset.docxState === 'error' && !document.querySelector('[data-testid="docx-frame"]')));
    await screenshot('docx-corrupt-error.png'); await openFile(files.crcMismatch); await failed(files.crcMismatch);
    check('Word real child ZIP validation rejects a document with inconsistent actual CRC', await page(() => document.querySelector('[data-testid="docx-preview"]').dataset.docxState === 'error' && !document.querySelector('[data-testid="docx-frame"]')));
    await openFile(files.expansionMismatch); await failed(files.expansionMismatch);
    check('Word real child ZIP validation rejects understated compressed expansion before rendering', await page(() => document.querySelector('[data-testid="docx-preview"]').dataset.docxState === 'error' && !document.querySelector('[data-testid="docx-frame"]')));
    await closeEditor(); const chat = store.createChat({ title: 'Word 双向附件验收', workspaceId: space.id });
    const user = store.appendMessage(chat.id, { role: 'user', content: 'Owned Word user attachment.', attachmentIds: [files.rich.id] });
    const assistant = store.appendMessage(chat.id, { role: 'assistant', content: 'Owned Word assistant attachment.', attachmentIds: [files.cachedBreak.id], status: 'complete' });
    await operations.updateChat({ id: chat.id, title: chat.title });
    await wait(name => [...document.querySelectorAll('.sidebar-chat-main')].some(el => el.title === name), chat.title); await page(name => [...document.querySelectorAll('.sidebar-chat-main')].find(el => el.title === name).click(), chat.title);
    await wait(id => !!document.querySelector('[data-message-id="' + id + '"] [data-testid="docx-attachment"]'), user.id); await page(id => document.querySelector('[data-message-id="' + id + '"] [data-testid="docx-attachment"]').click(), user.id); await ready(files.rich);
    check('Word user chat attachments open the actual read only Word file workbench', (await sample('userAttachmentRich', files.rich)).pages === 3);
    await page(id => document.querySelector('[data-message-id="' + id + '"] [data-testid="docx-attachment"]').click(), assistant.id); await ready(files.cachedBreak);
    check('Word assistant chat attachments use the same isolated renderer and correct source', (await sample('assistantAttachmentCached', files.cachedBreak)).pages === 1);
    await closeEditor(); await openWorkspace(space); await openFile(note); await click('file-edit-mode'); await fill('file-editor-input', 'OWNED_DOCX_UNSAVED_DRAFT'); const beforeNote = reads.filter(read => read.id === note.id).length;
    const changed = await operations.renameFile({ id: note.id, expectedName: note.name, name: 'Word草稿保护.docx' }); await wait(() => !!document.querySelector('[data-testid="file-renamed-warning"]'));
    check('Word extension retargeting preserves an unrelated dirty text draft without reading it as Word', await page(() => document.querySelector('[data-testid="file-editor-input"]')?.value === 'OWNED_DOCX_UNSAVED_DRAFT' && !document.querySelector('[data-testid="docx-preview"]')) && reads.filter(read => read.id === note.id).length === beforeNote);
    const beforeSave = saves; await click('file-save'); await pause(50);
    check('Word renamed dirty text cannot overwrite the original through a stale filename', saves === beforeSave && fs.readFileSync(store.filePath(note.id), 'utf8') === 'OWNED_DOCX_NOTE_BASELINE');
    await openFile(files.rich); await ready(files.rich); await page(name => [...document.querySelectorAll('[role="tab"]')].find(el => el.title === name).click(), changed.name);
    check('Word switching back from a rendered document retains the existing dirty draft', await page(() => document.querySelector('[data-testid="file-editor-input"]')?.value === 'OWNED_DOCX_UNSAVED_DRAFT'));
    await page(() => document.querySelector('[aria-label="关闭文件预览"]').click()); await wait(() => !!document.querySelector('[data-testid="file-discard"]'));
    check('Word dirty close keeps its real unsaved draft behind the existing confirmation guard', await page(() => document.querySelector('[data-testid="file-editor-input"]')?.value === 'OWNED_DOCX_UNSAVED_DRAFT' && !!document.querySelector('[data-testid="file-discard"]')));
    await click('file-discard'); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    await openFile(files.rich); await ready(files.rich); const renamed = await operations.renameFile({ id: files.rich.id, expectedName: files.rich.name, name: '自有富文档.txt' }); await wait(() => !document.querySelector('[data-testid="docx-preview"]'));
    check('Word renaming a clean source out of its category disposes the frame without changing bytes', fs.readFileSync(store.filePath(renamed.id)).equals(bytes.rich) && !(await probe()).frames.some(frame => frame.connected));
    await closeEditor(); await pause(80); const final = await probe();
    check('Word teardown closes each actual parent MessagePort exactly once and removes every child', final.channels.length >= 10 && final.channels.every(channel => channel.closeCalls === 1 && channel.closedOrder > channel.createdOrder) && final.frames.every(frame => !frame.connected));
    check('Word real child ready and render messages retain opaque source ownership and positive page counts', final.readyEvents.length > 0 && final.readyEvents.every(event => event.origin === 'null' && event.sourceIsCurrent && event.nonceMatches) && final.channels.some(channel => channel.messages.some(message => message.type === 'muse-docx-rendered' && message.pages === 3)));
    check('Word rendering and relationship handling issue no HTTP request or unhandled parent promise failure', external.length === 0 && final.unhandled.length === 0);
    check('Word scenarios preserve owned source files and settle actual IPC and download operations', sources.every(source => fs.readFileSync(source.path).equals(source.bytes)) && reads.every(read => read.settled) && downloads.every(download => download.settled) && choices.length === 0);
    fs.writeFileSync(path.join(folder, 'docx-preview-receipt.json'), JSON.stringify({ schema: 'muse-docx-preview-acceptance-round28-v1', original_target_executed: false, real_provider_used: false, native_save_picker: 'simulated choice only; renderer IPC export and output bytes are real', external_browser: 'shell.openExternal simulated only for the exact owned synthetic HTTPS URL; child checks port parent activation IPC and host validation are real', fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, { size: fixture.size, sha256: fixture.sha256, ...(fixture.pages ? { pages: fixture.pages } : {}) }])), samples, gestures, external_callbacks: externalCallbacks, simulated_browser_launches: browserLaunches, channels: final.channels, frames: final.frames, ready_events: final.readyEvents, unhandled_rejections: final.unhandled, reads, downloads: downloads.map(download => ({ id: download.input.id, keys: Object.keys(download.input), settled: download.settled })), original_download: { file: target, sha256: hash(fs.readFileSync(target)) }, external_HTTP_HTTPS_attempts: external, console: consoleMessages, limits: ['Owned small OOXML samples on Windows Chromium only; no original Mac, original wrapper or service is executed.', 'External image/font/template relationships may be ignored by the parser before a resource request; zero requests alone does not prove each CSP rule was exercised.', 'A real browser was not launched and native save-picker interaction is not OS-verified.', 'PNG pixels are read from the real decoded image into a temporary measurement canvas; it is not a substitute rendering.', 'Instrumentation observes real parent MessagePort.close calls; transferred child port cleanup is not inferred from those counts.', 'ZIP byte budgets do not bound all document parser, font, image or DOM memory.'] }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(folder, 'docx-preview-failure-state.json'), JSON.stringify({ schema: 'muse-docx-preview-failure-round28-v1', error: String(error.message || error), reads, downloads, external, externalCallbacks, browserLaunches, gestures, console: consoleMessages, probe: installed ? await probe().catch(() => null) : null, child: currentFrame() ? await child(() => ({ text: document.body.innerText.slice(0, 3000), pages: document.querySelectorAll('section.docx').length, scrollTop: document.scrollingElement.scrollTop, width: innerWidth, height: innerHeight })).catch(() => null) : null }, null, 2));
    await screenshot('docx-preview-failure.png').catch(() => {}); throw error;
  } finally {
    releases.forEach(release => release()); await closeEditor().catch(() => {}); await pause(80);
    if (installed) await page(() => { const p = window.__docxProbe28; window.removeEventListener('message', p.readyListener); window.removeEventListener('unhandledrejection', p.unhandledListener); window.MessageChannel = p.originals.NativeChannel; document.createElement = p.originals.create; delete window.__docxProbe28; }).catch(() => {});
    window.webContents.removeListener('console-message', consoleListener); window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, null);
    operations.readDocxFile = original.read; operations.exportFile = original.export; operations.saveTextFile = original.save; operations.openExternal = original.external; dialog.showSaveDialog = original.picker; shell.openExternal = original.shellExternal;
    if (debuggerAttached && !window.webContents.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    if (!window.isDestroyed()) window.setBounds(initialBounds);
  }
};
