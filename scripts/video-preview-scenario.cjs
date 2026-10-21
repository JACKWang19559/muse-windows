'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { dialog } = require('electron');
const fixtures = require('./video-fixtures.cjs');
const { isVideoFile, isPreviewMediaFile } = require('../backend/video-format.cjs');

// Owned silent clips only. Media elements, clocks, decoders, IPC and file bytes
// are real. Instrumentation forwards native methods. Only the save picker is
// simulated; a play-promise gate delays delivery after the real play call.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('Video checks require the isolated desktop fixture profile.');
  const sourceDir = path.join(folder, 'video-fixtures'), output = path.join(folder, 'video-output');
  fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const originalRead = operations.readVideoFile, originalExport = operations.exportFile, originalSave = operations.saveTextFile, originalPicker = dialog.showSaveDialog;
  const ids = new Set(), sources = [], reads = [], exports = [], choices = [], holds = new Map(), releases = [], samples = [], seekProofs = [], seekAttempts = [];
  let installed = false, saves = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const nodeWait = async predicate => { const end = Date.now() + 10000; while (Date.now() < end) { if (predicate()) return; await pause(20); } throw Error('Video fixture host gate did not settle.'); };
  const click = id => page(value => { const button = document.querySelector('[data-testid="' + value + '"]'); if (!button) throw Error('Missing video action ' + value); button.click(); }, id);
  const currentId = () => page(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.fileId);
  const metadata = id => store.getFile(id);
  const raw = id => fs.readFileSync(store.filePath(id));
  const snapshotVideo = (inline = false) => page(isInline => {
    const root = document.querySelector(isInline ? '[data-testid="file-preview"] [data-testid="video-preview"]' : '[data-testid="image-lightbox"] [data-testid="video-preview"]'), video = root?.querySelector('video');
    return video ? { id: root.dataset.fileId, state: root.dataset.state, src: video.currentSrc, paused: video.paused, muted: video.muted, autoplay: video.autoplay, loop: video.loop, playsInline: video.playsInline, controls: video.controls, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, duration: video.duration, time: video.currentTime, error: video.error?.code ?? null, totalFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null } : null;
  }, inline);
  const pauseVideo = async () => {
    if (!(await snapshotVideo())?.paused) await click('video-play-toggle');
    await wait(() => document.querySelector('[data-testid="image-lightbox"] video')?.paused);
  };
  const ready = (file, inline = false) => wait(input => {
    const container = document.querySelector(input.inline ? '[data-testid="file-preview"]' : '[data-testid="image-lightbox"]');
    if (input.kind === 'video') {
      const root = container?.querySelector('[data-testid="video-preview"]'), video = root?.querySelector('video');
      return root?.dataset.fileId === input.id && video?.currentSrc.startsWith('blob:') && video.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180 && !video.error && ['ready', 'playing', 'paused', 'buffering'].includes(root.dataset.state);
    }
    const root = container?.querySelector('[data-testid="image-preview"]'), image = root?.querySelector('img');
    return container?.dataset.fileId === input.id && root?.dataset.state === 'ready' && image?.complete && image.naturalWidth > 0;
  }, { id: file.id, kind: isVideoFile(file.name) ? 'video' : 'image', inline });
  const closeViewer = async () => { if (await currentId()) { await click('image-lightbox-close'); await wait(() => !document.querySelector('[data-testid="image-lightbox"]')); } };
  const closeEditor = async () => {
    if (await page(() => !!document.querySelector('[data-testid="file-preview"]'))) {
      await page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
      if (await page(() => !!document.querySelector('[data-testid="file-discard"]'))) await click('file-discard');
      await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    }
  };
  const openWorkspace = async workspace => {
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(el => el.textContent.includes(name)), workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(el => el.textContent.includes(name)).click(), workspace.name);
    await wait(name => document.querySelector('.workspace-title h2')?.textContent === name, workspace.name);
  };
  const openFile = async (file, decode = true) => {
    await wait(name => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === name), file.name);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), file.name);
    if (!isPreviewMediaFile(file.name)) { await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name, file.name); return; }
    if (decode) await ready(file); else await wait(id => document.querySelector('[data-testid="image-lightbox"]')?.dataset.fileId === id, file.id);
  };
  const refresh = workspace => operations.updateWorkspace({ id: workspace.id, name: workspace.name });
  const orderFor = workspace => store.snapshot().files.filter(file => file.workspaceId === workspace.id && isPreviewMediaFile(file.name)).map(file => file.id);
  const navigateTo = async (order, id) => {
    let current = order.indexOf(await currentId()), target = order.indexOf(id);
    if (current < 0 || target < 0) throw Error('Video target is outside the captured gallery.');
    while (current !== target) { await click(current < target ? 'image-lightbox-next' : 'image-lightbox-previous'); current += current < target ? 1 : -1; await ready(metadata(order[current])); }
  };
  const add = async (workspace, name, bytes) => {
    const target = path.join(sourceDir, name); fs.writeFileSync(target, bytes);
    const file = await store.addFile({ sourcePath: target, workspaceId: workspace.id });
    ids.add(file.id); sources.push({ path: target, bytes: Buffer.from(bytes) }); return file;
  };
  const holdRead = id => { const hold = { used: false, gate: deferred() }; holds.set(id, hold); releases.push(hold.gate.resolve); return hold; };
  const state = () => page(() => ({ created: [...window.__videoProbe24.created], revoked: [...window.__videoProbe24.revoked], active: [...window.__videoProbe24.active], log: [...window.__videoProbe24.log], pointerEvents: [...window.__videoProbe24.pointerEvents], playGate: window.__videoProbe24.playGate ? { used: window.__videoProbe24.playGate.used, nativeSettled: window.__videoProbe24.playGate.nativeSettled, delivered: window.__videoProbe24.playGate.delivered } : null }));
  const screenshot = async name => { await pause(180); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };
  const key = (name, extra = {}) => page(input => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: input.name, bubbles: true, cancelable: true, ...input.extra })), { name, extra });
  const seekDown = async () => {
    window.focus(); window.webContents.focus();
    const geometry = await page(() => {
      const input = document.querySelector('[data-testid="video-seek"]'), controls = input.closest('.video-controls'), rect = input.getBoundingClientRect(), box = controls.getBoundingClientRect();
      return { down: { x: Math.round(rect.left + rect.width * 0.35), y: Math.round(rect.top + rect.height / 2) }, outside: { x: Math.min(innerWidth - 12, Math.round(box.right + 40)), y: Math.max(45, Math.round(box.top - 55)) }, range: rect.toJSON(), controls: box.toJSON(), before: window.__videoProbe24.pointerEvents.length };
    });
    const attempt = { geometry }; seekAttempts.push(attempt);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...geometry.down });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...geometry.down, button: 'left', clickCount: 1 });
    const down = await wait(input => {
      const event = window.__videoProbe24.pointerEvents.slice(input.before).find(event => event.type === 'pointerdown' && event.target === 'video-seek'), range = document.querySelector('[data-testid="video-seek"]'), video = document.querySelector('[data-testid="image-lightbox"] video');
      return event?.trusted && range?.isConnected && video?.paused ? { ...event, capturedAfterDispatch: range.hasPointerCapture(event.pointerId), pausedAfterDispatch: video.paused, source: video.currentSrc } : false;
    }, geometry);
    attempt.down = down;
    return { ...geometry, down };
  };
  const seekUpOutside = async gesture => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...gesture.outside, modifiers: ['leftButtonDown'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...gesture.outside, button: 'left', clickCount: 1 });
    return wait(input => {
      const events = window.__videoProbe24.pointerEvents.slice(input.before), up = events.find(event => event.type === 'pointerup' && event.pointerId === input.down.pointerId), range = document.querySelector('[data-testid="video-seek"]'), video = document.querySelector('[data-testid="image-lightbox"] video');
      return up?.trusted && !range?.hasPointerCapture(input.down.pointerId) && video ? { ...up, capturedAfterDispatch: false, pausedAfterDispatch: video.paused, source: video.currentSrc, fileId: document.querySelector('[data-testid="image-lightbox"]').dataset.fileId } : false;
    }, gesture);
  };
  const openAttachment = async (message, file, kind) => {
    await page(input => {
      const row = [...document.querySelectorAll('[data-message-id]')].find(el => el.dataset.messageId === input.messageId);
      const target = [...(row?.querySelectorAll('[data-testid="' + input.kind + '-attachment"]') || [])].find(el => el.textContent.includes(input.name));
      if (!target) throw Error('Missing owned video/image attachment.'); target.click();
    }, { messageId: message.id, name: file.name, kind });
    await ready(file);
  };
  try {
    await closeViewer(); await closeEditor();
    window.webContents.setAudioMuted(true); window.show(); if (window.isMinimized()) window.restore(); window.focus(); window.webContents.focus();
    const bytes = Object.fromEntries(Object.entries(fixtures).map(([name, value]) => { const data = Buffer.from(value.base64, 'base64'); if (crypto.createHash('sha256').update(data).digest('hex') !== value.sha256) throw Error('Owned video fixture hash changed.'); return [name, data]; }));
    const space = await operations.createWorkspace({ name: '视频混合预览验收' });
    const pngBytes = Buffer.from(await page(() => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const context = canvas.getContext('2d'); context.fillStyle = '#395f55'; context.fillRect(0, 0, 320, 180); context.fillStyle = 'white'; context.font = '20px sans-serif'; context.fillText('OWNED MIXED MEDIA 24', 20, 95); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
    const firstImage = await add(space, '混合首图.png', pngBytes);
    const mp4 = await add(space, '自有-H264.MP4', bytes.mp4), webm = await add(space, '自有-VP8.webm', bytes.webm);
    const lastImage = await add(space, '混合末图.png', pngBytes);
    const note = (await operations.createTextFile({ workspaceId: space.id, name: '不属于视觉组.txt', content: 'OWNED_VIDEO_NOTE_24' })).file; ids.add(note.id);
    operations.readVideoFile = async input => {
      if (!ids.has(input?.id)) return originalRead(input);
      const record = { id: input.id, expectedName: input.expectedName, settled: false }; reads.push(record);
      try { const result = await originalRead(input); record.ok = true; record.size = result.size; record.sha256 = result.sha256; const hold = holds.get(input.id); if (hold && !hold.used) { hold.used = true; await hold.gate.promise; } return result; }
      finally { record.settled = true; }
    };
    operations.exportFile = async input => {
      if (!ids.has(input?.id)) return originalExport(input);
      const record = { input: { ...input }, settled: false }; exports.push(record);
      try { const result = await originalExport(input); record.result = result; return result; }
      finally { record.settled = true; }
    };
    operations.saveTextFile = async input => { if (ids.has(input?.id)) saves++; return originalSave(input); };
    dialog.showSaveDialog = async (_owner, options) => {
      if (options?.title !== '下载文件副本') throw Error('Unexpected picker during video checks.');
      const choice = choices.shift(); if (!choice || !same(path.dirname(choice.target), output)) throw Error('Video picker escaped fixture output.');
      choice.name = options.defaultPath; if (choice.gate) await choice.gate.promise;
      return { canceled: false, filePath: choice.target };
    };
    await page(() => {
      const proto = HTMLMediaElement.prototype, elementProto = Element.prototype, eventProto = EventTarget.prototype;
      const probe = { created: [], revoked: [], active: new Set(), videoURLs: new Set(), log: [], pointerEvents: [], activePointer: null, playGate: null, lastURL: new WeakMap(), elementIds: new WeakMap(), ordinal: 0 };
      const originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, play: proto.play, pause: proto.pause, load: proto.load, remove: elementProto.removeAttribute, off: eventProto.removeEventListener };
      probe.originals = originals;
      const record = (kind, element, detail) => {
        if (!(element instanceof HTMLVideoElement)) return;
        const source = [element.getAttribute('src'), element.currentSrc, probe.lastURL.get(element)].find(url => probe.videoURLs.has(url) && probe.active.has(url));
        if (!source) return;
        probe.lastURL.set(element, source);
        if (!probe.elementIds.has(element)) probe.elementIds.set(element, ++probe.ordinal);
        probe.log.push({ kind, element: probe.elementIds.get(element), url: source, ...(detail ? { detail } : {}) });
      };
      URL.createObjectURL = function(blob) { const url = Reflect.apply(originals.create, URL, [blob]); if (/^(image|video)\//.test(blob?.type || '')) { probe.created.push({ url, type: blob.type }); probe.active.add(url); if (blob.type.startsWith('video/')) probe.videoURLs.add(url); } return url; };
      URL.revokeObjectURL = function(url) { if (probe.created.some(item => item.url === url)) { probe.log.push({ kind: 'revoke', url }); probe.revoked.push(url); probe.active.delete(url); } return Reflect.apply(originals.revoke, URL, [url]); };
      proto.play = function(...args) {
        record('play', this); const actual = Reflect.apply(originals.play, this, args), gate = probe.playGate;
        if (gate && !gate.used && gate.element === this) { gate.used = true; return Promise.resolve(actual).then(value => { gate.nativeSettled = true; return gate.promise.then(() => { gate.delivered = true; return value; }); }); }
        return actual;
      };
      proto.pause = function(...args) { record('pause', this); return Reflect.apply(originals.pause, this, args); };
      proto.load = function(...args) { record('load', this); return Reflect.apply(originals.load, this, args); };
      elementProto.removeAttribute = function(...args) { if (args[0] === 'src') record('remove-src', this); return Reflect.apply(originals.remove, this, args); };
      eventProto.removeEventListener = function(...args) { record('remove-listener', this, args[0]); return Reflect.apply(originals.off, this, args); };
      probe.pointerListener = event => {
        const target = event.target?.closest?.('[data-testid="video-seek"]');
        if (event.type === 'pointerdown' && target) probe.activePointer = event.pointerId;
        if (event.pointerId !== probe.activePointer) return;
        probe.pointerEvents.push({ type: event.type, pointerId: event.pointerId, trusted: event.isTrusted, target: target ? 'video-seek' : event.target?.tagName?.toLowerCase() || null, x: event.clientX, y: event.clientY });
      };
      for (const name of ['pointerdown', 'gotpointercapture', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(name, probe.pointerListener, true);
      window.__videoProbe24 = probe;
    }); installed = true;
    check('Video acceptance uses hashed owned silent fixtures with muted output and real media methods', window.webContents.isAudioMuted() && fixtures.mp4.mime === 'video/mp4' && fixtures.webm.mime === 'video/webm' && sources.length === 4);
    await openWorkspace(space); await openFile(mp4);
    await wait(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return !!video && !video.paused && video.currentTime > 0.15; });
    const mp4State = await snapshotVideo(); samples.push({ checkpoint: 'mp4-decoded', ...mp4State });
    check('Video MP4 H264 decodes actual 320 by 180 frames and exposes its real duration', mp4State.width === 320 && mp4State.height === 180 && mp4State.duration > 2.3 && mp4State.duration < 2.8 && mp4State.readyState >= 2 && !mp4State.error);
    const beforeTime = mp4State.time; await pause(450); const advanced = await snapshotVideo();
    check('Video lightbox autoplay advances the actual playback clock while initially muted and looping', !advanced.paused && advanced.muted && advanced.autoplay && advanced.loop && advanced.playsInline && !advanced.controls && (advanced.time - beforeTime + advanced.duration) % advanced.duration > 0.1);
    await click('video-play-toggle'); await wait(() => document.querySelector('[data-testid="image-lightbox"] video')?.paused && document.querySelector('[data-testid="video-preview"]')?.dataset.state === 'paused');
    const pausedAt = (await snapshotVideo()).time; await pause(250);
    check('Video custom Pause stops the real clock without releasing its decoded source', Math.abs((await snapshotVideo()).time - pausedAt) < 0.035 && (await snapshotVideo()).src.startsWith('blob:'));
    await fill('video-seek', '1.1'); await wait(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return video?.paused && Math.abs(video.currentTime - 1.1) < 0.16; });
    check('Video seek moves the real paused element to the requested finite position', Math.abs((await snapshotVideo()).time - 1.1) < 0.16 && (await snapshotVideo()).paused);
    await click('video-play-toggle'); await wait(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return video && !video.paused && video.currentTime > 1.25; });
    check('Video custom Play resumes actual playback after a paused seek', !(await snapshotVideo()).paused && (await snapshotVideo()).time > 1.25);
    await click('video-mute-toggle'); await wait(() => document.querySelector('[data-testid="image-lightbox"] video')?.muted === false);
    await page(() => { window.__videoCarryElement24 = document.querySelector('[data-testid="image-lightbox"] video'); });
    const order = orderFor(space); await navigateTo(order, webm.id);
    await wait(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return video && !video.paused && video.currentTime > 0.15; });
    const webmState = await snapshotVideo(); samples.push({ checkpoint: 'webm-decoded', ...webmState });
    check('Video WebM VP8 decodes actual 320 by 180 frames through the managed byte IPC', webmState.id === webm.id && webmState.width === 320 && webmState.height === 180 && webmState.duration > 2.3 && webmState.duration < 2.8 && !webmState.error && reads.some(read => read.id === webm.id && read.ok && read.settled));
    check('Video source replacement reuses the element and preserves the chosen mute state', webmState.muted === false && await page(() => window.__videoCarryElement24 === document.querySelector('[data-testid="image-lightbox"] video')));
    const capturedSeek = await seekDown(), releasedSeek = await seekUpOutside(capturedSeek);
    const resumedAt = (await snapshotVideo()).time;
    await wait(start => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return video && !video.paused && (video.currentTime - start + video.duration) % video.duration > 0.08; }, resumedAt);
    const outsideControls = releasedSeek.x < capturedSeek.controls.left || releasedSeek.x > capturedSeek.controls.right || releasedSeek.y < capturedSeek.controls.top || releasedSeek.y > capturedSeek.controls.bottom;
    seekProofs.push({ kind: 'release-outside', down: capturedSeek.down, up: releasedSeek, effectiveCapture: releasedSeek.target === 'video-seek', outsideControls, evidence: 'Actual trusted pointerup outside the controls ends the gesture and playback advances. Native range routing/capture is observed separately from the required playback outcome.' });
    check('Video trusted seek pauses and resumes after release outside the controls with or without native capture', capturedSeek.down.trusted && capturedSeek.down.pausedAfterDispatch && outsideControls && releasedSeek.trusted && releasedSeek.pointerId === capturedSeek.down.pointerId && !releasedSeek.capturedAfterDispatch && !(await snapshotVideo()).paused);
    const replacedSeek = await seekDown(); await navigateTo(order, mp4.id); await pauseVideo();
    const replacementSource = (await snapshotVideo()).src, releasedOldSeek = await seekUpOutside(replacedSeek); await pause(140);
    seekProofs.push({ kind: 'source-replaced-before-release', down: replacedSeek.down, up: releasedOldSeek, replacementSource });
    check('Video ending an old trusted seek gesture cannot start the replacement source', replacedSeek.down.trusted && replacedSeek.down.pausedAfterDispatch && releasedOldSeek.trusted && releasedOldSeek.pointerId === replacedSeek.down.pointerId && releasedOldSeek.fileId === mp4.id && replacementSource !== replacedSeek.down.source && (await snapshotVideo()).paused);
    await click('video-play-toggle'); await wait(() => !document.querySelector('[data-testid="image-lightbox"] video').paused);
    const fallback = await page(() => {
      const range = document.querySelector('[data-testid="video-seek"]'), capture = range.setPointerCapture; let failure = null;
      range.setPointerCapture = function (id) { try { return capture.call(this, id); } catch (error) { failure = error.name; throw error; } };
      try { range.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 910038, pointerType: 'mouse', isPrimary: true, button: 0, bubbles: true })); }
      finally { range.setPointerCapture = capture; }
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 910039 }));
      return { synthetic: true, failure, paused: document.querySelector('[data-testid="image-lightbox"] video').paused };
    });
    await pause(100);
    check('Video synthetic capture rejection pauses the source and ignores an unrelated pointer release', fallback.failure === 'NotFoundError' && fallback.paused && (await snapshotVideo()).paused);
    await page(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 910038 })));
    await wait(() => !document.querySelector('[data-testid="image-lightbox"] video').paused);
    const fallbackTime = (await snapshotVideo()).time;
    await wait(start => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return video && !video.paused && (video.currentTime - start + video.duration) % video.duration > 0.08; }, fallbackTime);
    seekProofs.push({ kind: 'synthetic-capture-rejection', ...fallback, matching_window_cancel_resumed: true, native_input_claimed: false });
    check('Video matching window cancellation resumes real playback after synthetic capture rejection', !(await snapshotVideo()).paused);
    await pauseVideo();
    await screenshot('video-lightbox.png'); await closeViewer();
    await openFile(webm); check('Video new viewer mount restores the default muted state', (await snapshotVideo()).muted === true);
    await navigateTo(order, order[0]); const traversed = [order[0]];
    for (let index = 1; index < order.length; index++) { await click('image-lightbox-next'); await ready(metadata(order[index])); traversed.push(await currentId()); }
    check('Video Library gallery navigates the captured mixed image and video order with a clamped boundary', traversed.join(',') === order.join(',') && order.length === 4 && await page(() => document.querySelector('[data-testid="image-lightbox-next"]').disabled) && order.some(id => isVideoFile(metadata(id).name)) && order.some(id => !isVideoFile(metadata(id).name)));
    await closeViewer(); await openFile(mp4); await click('image-lightbox-open-file'); await ready(mp4, true);
    const inlineBefore = await snapshotVideo(true); await pause(250); const inlineAfter = await snapshotVideo(true);
    check('Video inline workbench exposes native controls without autoplay loop or initial forced mute', inlineAfter.controls && !inlineAfter.autoplay && !inlineAfter.loop && !inlineAfter.muted && inlineAfter.paused && Math.abs(inlineAfter.time - inlineBefore.time) < 0.035 && await page(() => document.querySelector('[data-testid="file-edit-mode"]').disabled && document.querySelector('[data-testid="file-save"]').disabled));
    window.focus(); window.webContents.focus();
    const playPoint = await page(() => { const rect = document.querySelector('[data-testid="file-preview"] video').getBoundingClientRect(); return { x: Math.round(rect.left + 27), y: Math.round(rect.bottom - 48) }; });
    window.webContents.sendInputEvent({ type: 'mouseMove', ...playPoint });
    await pause(150);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...playPoint, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...playPoint, button: 'left', clickCount: 1 });
    await wait(() => { const video = document.querySelector('[data-testid="file-preview"] video'); return video && !video.paused && video.currentTime > 0.15; });
    check('Video inline native play control responds to a trusted pointer and advances actual time', !(await snapshotVideo(true)).paused && (await snapshotVideo(true)).time > 0.15);
    await screenshot('video-inline.png');
    await page(() => { const element = document.querySelector('[data-testid="file-preview"] video'); window.__videoInlinePrior24 = { element, src: element.currentSrc }; });
    await click('image-open-fullscreen'); await ready(mp4);
    check('Video fullscreen suspends and unloads the previously playing inline element', await page(() => { const prior = window.__videoInlinePrior24; return !prior.element.isConnected && prior.element.paused && !prior.element.getAttribute('src') && !window.__videoProbe24.active.has(prior.src) && document.querySelectorAll('[data-testid="managed-video"]').length === 1; }));
    await closeViewer(); await ready(mp4, true);
    check('Video leaving fullscreen reloads a single paused inline player without autoplay', await page(() => { const video = document.querySelector('[data-testid="file-preview"] video'); return video && video !== window.__videoInlinePrior24.element && video.paused && !video.autoplay && !video.loop && video.controls && video.currentTime < 0.1 && document.querySelectorAll('[data-testid="managed-video"]').length === 1; }));
    await closeEditor(); await wait(() => window.__videoProbe24.active.size === 0);

    const chat = store.createChat({ title: '视频与图片分组验收', workspaceId: space.id });
    const message = store.appendMessage(chat.id, { role: 'user', content: 'Owned mixed attachments for origin grouping only.', attachmentIds: [mp4.id, firstImage.id, note.id, webm.id, lastImage.id] });
    operations.updateChat({ id: chat.id, title: chat.title });
    await wait(name => [...document.querySelectorAll('.sidebar-chat-main')].some(el => el.title === name), chat.title);
    await page(name => [...document.querySelectorAll('.sidebar-chat-main')].find(el => el.title === name).click(), chat.title);
    await wait(id => !!document.querySelector('[data-message-id="' + id + '"]'), message.id);
    await openAttachment(message, mp4, 'video');
    check('Video chat attachment opens a single item even when its message contains another video', await page(() => document.querySelector('[data-testid="image-lightbox-counter"]').textContent === '1 / 1' && !document.querySelector('[data-testid="image-lightbox-next"]') && !document.querySelector('[data-testid="image-lightbox-previous"]')) && (await snapshotVideo()).muted && (await snapshotVideo()).autoplay && (await snapshotVideo()).loop);
    await closeViewer(); await openAttachment(message, firstImage, 'image'); await key('ArrowLeft'); await ready(lastImage);
    check('Video attachments stay outside the chat image-only wrapping gallery', await currentId() === lastImage.id && await page(() => document.querySelector('[data-testid="image-lightbox-counter"]').textContent === '2 / 2' && !document.querySelector('[data-testid="video-preview"]')));
    await closeViewer(); await openWorkspace(space); await openFile(mp4);
    const saveGate = deferred(), target = path.join(output, 'captured-original.mp4'), choice = { target, gate: saveGate };
    releases.push(saveGate.resolve); choices.push(choice); const beforeExport = exports.length;
    await click('image-lightbox-download'); await nodeWait(() => typeof choice.name === 'string'); await navigateTo(order, webm.id);
    check('Video download captures the clicked file while another video keeps playing', exports.length === beforeExport + 1 && exports.at(-1).input.id === mp4.id && Object.keys(exports.at(-1).input).join(',') === 'id' && choice.name === mp4.name && await currentId() === webm.id && await page(() => document.querySelector('[data-testid="image-lightbox-download"]').disabled));
    saveGate.resolve(); await nodeWait(() => exports.at(-1).settled); await wait(() => !document.querySelector('[data-testid="image-lightbox-download"]').disabled);
    check('Video download writes identical original bytes and leaves the new selection untouched', fs.readFileSync(target).equals(bytes.mp4) && raw(mp4.id).equals(bytes.mp4) && exports.at(-1).result?.draft === false && await currentId() === webm.id);
    await closeViewer();

    const lateRead = holdRead(mp4.id); await openFile(mp4, false); await nodeWait(() => lateRead.used); await navigateTo(order, webm.id); await pauseVideo();
    const beforeLateRead = (await state()).created.length; lateRead.gate.resolve(); await nodeWait(() => reads.filter(read => read.id === mp4.id).at(-1)?.settled); await pause(120);
    await page(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); video.dispatchEvent(new Event('playing')); video.dispatchEvent(new Event('error')); });
    check('Video late read and synthetic stale media signals cannot allocate or revive the replaced source', (await state()).created.length === beforeLateRead && await currentId() === webm.id && (await snapshotVideo()).paused && !(await snapshotVideo()).error && !await page(() => !!document.querySelector('[data-testid="video-error"]')));
    await closeViewer(); const closedRead = holdRead(mp4.id); await openFile(mp4, false); await nodeWait(() => closedRead.used); await closeViewer();
    const beforeClosedRead = (await state()).created.length; closedRead.gate.resolve(); await nodeWait(() => reads.filter(read => read.id === mp4.id).at(-1)?.settled); await pause(120);
    check('Video closing during a real byte read prevents its late object URL allocation', (await state()).created.length === beforeClosedRead && (await state()).active.length === 0);
    await openFile(mp4); await pauseVideo();
    await page(() => { let release; const promise = new Promise(resolve => { release = resolve; }); window.__videoProbe24.playGate = { element: document.querySelector('[data-testid="image-lightbox"] video'), promise, release, used: false, nativeSettled: false, delivered: false }; });
    await click('video-play-toggle'); await wait(() => { const video = document.querySelector('[data-testid="image-lightbox"] video'); return window.__videoProbe24.playGate.used && window.__videoProbe24.playGate.nativeSettled && video && !video.paused; });
    await pauseVideo(); await navigateTo(order, webm.id); await pauseVideo();
    await page(() => window.__videoProbe24.playGate.release()); await wait(() => window.__videoProbe24.playGate.delivered); await pause(80);
    check('Video delayed real play completion cannot undo pause or alter a later source', await currentId() === webm.id && (await snapshotVideo()).paused && !await page(() => !!document.querySelector('[data-testid="video-error"]')));
    await closeViewer();

    const errors = await operations.createWorkspace({ name: '视频错误验收' }), corrupt = await add(errors, '真实解码失败.webm', Buffer.from('OWNED_CORRUPT_VIDEO_24')); await refresh(errors);
    await openWorkspace(errors); await openFile(corrupt, false); await wait(() => !!document.querySelector('[data-testid="video-error"]'));
    check('Video actual codec failure produces an error without disabling original download', await page(() => document.querySelector('[data-testid="video-preview"]').dataset.state === 'error' && !document.querySelector('[data-testid="image-lightbox-download"]').disabled) && (await state()).active.length === 0);
    const beforeRetry = reads.length; await click('video-retry'); await nodeWait(() => reads.length === beforeRetry + 1 && reads.at(-1).settled); await wait(() => !!document.querySelector('[data-testid="video-error"]'));
    check('Video Retry performs another real read and retains a truthful decode error for corrupt bytes', reads.at(-1).id === corrupt.id && reads.at(-1).ok && raw(corrupt.id).toString() === 'OWNED_CORRUPT_VIDEO_24' && (await state()).active.length === 0);
    await screenshot('video-codec-error.png'); await closeViewer(); await openWorkspace(space);

    await openFile(mp4); const beforeRename = orderFor(space), oldIndex = beforeRename.indexOf(mp4.id);
    await operations.renameFile({ id: mp4.id, expectedName: mp4.name, name: '视频已改非媒体.bin' });
    const afterRename = beforeRename.filter(id => id !== mp4.id), expected = afterRename[Math.min(oldIndex, afterRename.length - 1)]; await ready(metadata(expected));
    check('Video rename out of the media category unloads it and selects the adjacent stable item', await currentId() === expected && raw(mp4.id).equals(bytes.mp4) && await page(count => document.querySelector('[data-testid="image-lightbox-counter"]').textContent.endsWith('/ ' + count), afterRename.length));
    await closeViewer(); await openFile(webm); await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]')); await key('Escape'); await wait(() => !document.querySelector('.confirm-modal'));
    check('Video deletion confirmation owns Escape without closing or deleting the underlying player', await currentId() === webm.id && !!store.getFile(webm.id));
    const beforeDelete = orderFor(space), deletedIndex = beforeDelete.indexOf(webm.id), remaining = beforeDelete.filter(id => id !== webm.id);
    await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]')); await click('confirm-delete'); const neighbor = remaining[Math.min(deletedIndex, remaining.length - 1)]; await ready(metadata(neighbor));
    check('Video confirmed removal unloads playback and preserves the neighboring mixed gallery item', !store.snapshot().files.some(file => file.id === webm.id) && await currentId() === neighbor && sources.every(source => fs.readFileSync(source.path).equals(source.bytes)));
    await closeViewer();

    const dirtySpace = await operations.createWorkspace({ name: '视频重命名草稿验收' }), companion = await add(dirtySpace, '草稿旁视频.mp4', bytes.mp4);
    const dirtyFile = (await operations.createTextFile({ workspaceId: dirtySpace.id, name: '保留草稿.txt', content: 'OWNED_VIDEO_DIRTY_BASELINE_24' })).file; ids.add(dirtyFile.id);
    await openWorkspace(dirtySpace); await openFile(dirtyFile); await wait(() => !document.querySelector('[data-testid="file-edit-mode"]').disabled); await click('file-edit-mode'); const draft = 'VIDEO_LOCAL_DRAFT_MUST_SURVIVE_24'; await fill('file-editor-input', draft);
    await operations.renameFile({ id: dirtyFile.id, expectedName: dirtyFile.name, name: '保留草稿.mp4' }); await wait(() => !!document.querySelector('[data-testid="file-renamed-warning"]'));
    check('Video extension change preserves an existing dirty text draft instead of replacing it with a player', await page(value => document.querySelector('[data-testid="file-editor-input"]')?.value === value && !document.querySelector('[data-testid="file-preview"] [data-testid="video-preview"]'), draft) && raw(dirtyFile.id).toString() === 'OWNED_VIDEO_DIRTY_BASELINE_24');
    const beforeSave = saves; await openFile(companion);
    await page(() => { window.__videoSaveBubbles24 = 0; window.__videoSaveListener24 = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') window.__videoSaveBubbles24++; }; window.addEventListener('keydown', window.__videoSaveListener24); });
    await key('s', { ctrlKey: true });
    check('Video viewer blocks Save propagation to the hidden dirty text editor', saves === beforeSave && await page(() => window.__videoSaveBubbles24 === 0) && raw(dirtyFile.id).toString() === 'OWNED_VIDEO_DIRTY_BASELINE_24');
    await closeViewer(); await closeEditor(); await wait(() => window.__videoProbe24.active.size === 0);
    const final = await state(), videoURLs = final.created.filter(item => item.type.startsWith('video/'));
    const cleanup = videoURLs.map(item => {
      const end = final.log.findIndex(event => event.kind === 'revoke' && event.url === item.url), events = final.log.slice(0, end).map((event, index) => ({ ...event, index })).filter(event => event.url === item.url);
      const remove = events.findLast(event => event.kind === 'remove-src'), stopped = events.findLast(event => event.kind === 'pause' && event.index < (remove?.index ?? -1)), unload = events.find(event => event.kind === 'load' && event.index > (remove?.index ?? Infinity)), off = events.findLast(event => event.kind === 'remove-listener' && event.index < (stopped?.index ?? -1));
      return { url: item.url, valid: !!off && !!stopped && !!remove && !!unload && unload.index < end };
    });
    check('Video cleanup removes listeners then pauses unloads and revokes every real video source', cleanup.length > 8 && cleanup.every(item => item.valid) && final.active.length === 0 && final.created.every(item => final.revoked.includes(item.url)));
    check('Video scenarios preserve all owned source files and complete their real host operations', sources.every(source => fs.readFileSync(source.path).equals(source.bytes)) && reads.every(read => read.settled) && exports.every(item => item.settled) && choices.length === 0 && window.webContents.isAudioMuted());
    const remainingMedia = await page(() => [...document.querySelectorAll('audio,video')].map(element => ({ tag: element.tagName.toLowerCase(), paused: element.paused, ended: element.ended, hasSource: !!element.currentSrc, readyState: element.readyState })));
    fs.writeFileSync(path.join(folder, 'video-preview-receipt.json'), JSON.stringify({ schema: 'muse-video-preview-acceptance-round24-v1', source: 'owned local FFmpeg testsrc2 H264 and VP8 clips; no original or physical device media', fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, file]) => [name, { mime: file.mime, sha256: file.sha256, size: Buffer.from(file.base64, 'base64').length }])), physical_output_muted: window.webContents.isAudioMuted(), native_save_picker: 'simulated only; exporter IPC and output bytes real', media_instrumentation: 'all methods forward native implementation; one real play-result promise delivery held', decoded_samples: samples, trusted_seek_proofs: seekProofs, reads, downloads: exports.map(item => ({ id: item.input.id, keys: Object.keys(item.input), settled: item.settled, draft: item.result?.draft })), URL_counts: { created: final.created.length, revoked: final.revoked.length, active: final.active.length, video: videoURLs.length }, URLs: final, cleanup, remaining_media: remainingMedia, remaining_media_all_paused: remainingMedia.every(element => element.paused), target_mac_app_executed: false, real_provider_used: false }, null, 2));
  } catch (error) {
    const diagnostic = await page(() => {
      const probe = window.__videoProbe24, root = document.querySelector('[data-testid="image-lightbox"]'), video = root?.querySelector('video'), range = document.querySelector('[data-testid="video-seek"]'), controls = range?.closest('.video-controls');
      const pointerIds = [...new Set(probe?.pointerEvents.map(event => event.pointerId) || [])];
      const captures = pointerIds.map(pointerId => { try { return { pointerId, capturedByHostRange: range?.hasPointerCapture(pointerId) ?? null }; } catch { return { pointerId, capturedByHostRange: null, queryFailed: true }; } });
      return {
        currentFileId: root?.dataset.fileId ?? null,
        video: video ? { connected: video.isConnected, paused: video.paused, muted: video.muted, ended: video.ended, readyState: video.readyState, currentSrc: video.currentSrc, sourceAttribute: video.getAttribute('src'), currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null } : null,
        seek: range ? { connected: range.isConnected, disabled: range.disabled, value: range.value, min: range.min, max: range.max, rect: range.getBoundingClientRect().toJSON(), controlsRect: controls?.getBoundingClientRect().toJSON(), captures, pointerEvents: getComputedStyle(range).pointerEvents } : null,
        pointerEvents: probe?.pointerEvents ?? [],
        probe: probe ? { created: probe.created, revoked: probe.revoked, active: [...probe.active], log: probe.log, playGate: probe.playGate ? { used: probe.playGate.used, nativeSettled: probe.playGate.nativeSettled, delivered: probe.playGate.delivered } : null } : null
      };
    }).catch(diagnosticError => ({ diagnosticUnavailable: String(diagnosticError.message || diagnosticError) }));
    fs.writeFileSync(path.join(folder, 'video-preview-failure-state.json'), JSON.stringify({ schema: 'muse-video-preview-failure-round24-v1', error: String(error.message || error), seekAttempts, reads, state: diagnostic }, null, 2));
    await screenshot('video-preview-failure.png').catch(() => {}); throw error;
  }
  finally {
    for (const release of releases) release();
    if (installed) await page(() => window.__videoProbe24.playGate?.release()).catch(() => {});
    await closeViewer().catch(() => {}); await closeEditor().catch(() => {}); await pause(80);
    if (installed) await page(() => {
      const probe = window.__videoProbe24;
      for (const name of ['pointerdown', 'gotpointercapture', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) document.removeEventListener(name, probe.pointerListener, true);
      URL.createObjectURL = probe.originals.create; URL.revokeObjectURL = probe.originals.revoke;
      HTMLMediaElement.prototype.play = probe.originals.play; HTMLMediaElement.prototype.pause = probe.originals.pause; HTMLMediaElement.prototype.load = probe.originals.load;
      Element.prototype.removeAttribute = probe.originals.remove; EventTarget.prototype.removeEventListener = probe.originals.off;
      window.removeEventListener('keydown', window.__videoSaveListener24);
      delete window.__videoSaveListener24; delete window.__videoSaveBubbles24; delete window.__videoCarryElement24; delete window.__videoInlinePrior24; delete window.__videoProbe24;
    }).catch(() => {});
    operations.readVideoFile = originalRead; operations.exportFile = originalExport; operations.saveTextFile = originalSave; dialog.showSaveDialog = originalPicker;
  }
};
