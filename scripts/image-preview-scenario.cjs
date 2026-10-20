'use strict';

const fs = require('node:fs'), path = require('node:path');
const { dialog } = require('electron');
const { isImageFile } = require('../backend/image-format.cjs');

// All files/profile/output belong to the existing isolated fixture. Only the
// native save picker is simulated; image reads, browser decoding, isolated IPC,
// rename/delete and exported bytes use production implementations.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('Image checks require the isolated desktop fixture profile.');
  const output = path.join(folder, 'image-output'), sourceFolder = path.join(folder, 'image-fixtures');
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(sourceFolder, { recursive: true });
  const originalRead = operations.readImageFile, originalExport = operations.exportFile, originalSave = operations.saveTextFile, originalPicker = dialog.showSaveDialog;
  const ids = new Set(), reads = [], exports = [], choices = [], sources = [], holds = new Map(), releases = [], tripwireRequests = [];
  let saves = 0, urlInstalled = false, requestInstalled = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const nodeWait = async predicate => { const end = Date.now() + 10000; while (Date.now() < end) { if (predicate()) return; await pause(20); } throw Error('Image fixture host operation did not settle.'); };
  const click = id => page(value => { const el = document.querySelector('[data-testid="' + value + '"]'); if (!el) throw Error('Missing image action ' + value); el.click(); }, id);
  const currentId = () => page(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.fileId);
  const ready = id => wait(value => {
    const root = document.querySelector('[data-testid="image-lightbox"]'), image = root?.querySelector('[data-testid="managed-image"]');
    return root?.dataset.fileId === value && root.querySelector('[data-testid="image-preview"]')?.dataset.state === 'ready' && image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, id);
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
    await page(name => { const trigger = [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main'); trigger.focus(); window.__imageReturnFocus23 = trigger; trigger.click(); }, file.name);
    if (!isImageFile(file.name)) { await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name, file.name); return; }
    if (decode) await ready(file.id); else await wait(id => document.querySelector('[data-testid="image-lightbox"]')?.dataset.fileId === id, file.id);
  };
  const refresh = workspace => operations.updateWorkspace({ id: workspace.id, name: workspace.name });
  const imageOrder = workspace => store.snapshot().files.filter(file => file.workspaceId === workspace.id && isImageFile(file.name)).map(file => file.id);
  const metadata = id => store.getFile(id);
  const raw = id => fs.readFileSync(store.filePath(id));
  const key = (name, extra = {}) => page(input => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: input.name, bubbles: true, cancelable: true, ...input.extra })), { name, extra });
  const stats = () => page(() => ({ created: [...window.__imageURLs23.created], revoked: [...window.__imageURLs23.revoked], active: [...window.__imageURLs23.active] }));
  const screenshot = async name => { await pause(180); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };
  const add = async (workspace, name, bytes) => {
    const target = path.join(sourceFolder, name); fs.writeFileSync(target, bytes);
    const file = await store.addFile({ sourcePath: target, workspaceId: workspace.id });
    ids.add(file.id); sources.push({ path: target, bytes: Buffer.from(bytes) }); return file;
  };
  const holdRead = id => { const gate = deferred(), entered = deferred(); const hold = { gate, entered, used: false }; holds.set(id, hold); releases.push(gate.resolve); return hold; };
  const openChat = async chat => {
    await wait(name => [...document.querySelectorAll('.sidebar-chat-main')].some(el => el.title === name), chat.title);
    await page(name => [...document.querySelectorAll('.sidebar-chat-main')].find(el => el.title === name).click(), chat.title);
    await wait(name => document.querySelector('.content-heading h1')?.textContent === name, chat.title);
  };
  const openAttachment = async (message, file) => {
    await page(input => { const row = [...document.querySelectorAll('[data-message-id]')].find(el => el.dataset.messageId === input.messageId); const button = [...(row?.querySelectorAll('[data-testid="image-attachment"]') || [])].find(el => el.textContent.includes(input.name)); if (!button) throw Error('Missing synthetic image attachment'); button.click(); }, { messageId: message.id, name: file.name });
    await ready(file.id);
  };
  try {
    await closeViewer(); await closeEditor();
    window.show(); if (window.isMinimized()) window.restore();
    const encoded = await page(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, '#244c4a'); gradient.addColorStop(1, '#c7d9af'); context.fillStyle = gradient; context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#ffffff'; context.font = '28px sans-serif'; context.fillText('OWNED IMAGE PREVIEW 23', 40, 185);
      return Object.fromEntries(['png', 'jpeg', 'webp'].map(type => { const data = canvas.toDataURL('image/' + type); if (!data.startsWith('data:image/' + type + ';base64,')) throw Error('Fixture encoder unsupported: ' + type); return [type, data.split(',')[1]]; }));
    });
    const space = await operations.createWorkspace({ name: '图片预览验收工作区' });
    const png = await add(space, '图片-PNG.PNG', Buffer.from(encoded.png, 'base64'));
    const jpeg = await add(space, '图片-JPEG.jpg', Buffer.from(encoded.jpeg, 'base64'));
    const gif = await add(space, '图片-GIF.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    const webp = await add(space, '图片-WebP.webp', Buffer.from(encoded.webp, 'base64'));
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" rx="18" fill="#416c60"/><circle cx="500" cy="80" r="130" fill="#a6c6a5"/><text x="35" y="190" fill="white" font-family="sans-serif" font-size="30">OWNED SVG PREVIEW 23</text></svg>';
    const svg = await add(space, '图片-SVG.svg', Buffer.from(svgText));
    const note = (await operations.createTextFile({ workspaceId: space.id, name: '图片旁文字.txt', content: svgText })).file; ids.add(note.id);
    const corpus = [png, jpeg, gif, webp, svg];
    operations.readImageFile = async input => {
      if (!ids.has(input?.id)) return originalRead(input);
      const record = { id: input.id, expectedName: input.expectedName, settled: false }; reads.push(record);
      try {
        const result = await originalRead(input), hold = holds.get(input.id);
        record.ok = true; record.size = result.size; record.sha256 = result.sha256;
        if (hold && !hold.used) { hold.used = true; hold.entered.resolve(); await hold.gate.promise; }
        return result;
      } finally { record.settled = true; }
    };
    operations.exportFile = async input => {
      if (!ids.has(input?.id)) return originalExport(input);
      const record = { input: { ...input }, settled: false }; exports.push(record);
      try { const result = await originalExport(input); record.result = result; return result; }
      finally { record.settled = true; }
    };
    operations.saveTextFile = async input => { if (ids.has(input?.id)) saves++; return originalSave(input); };
    dialog.showSaveDialog = async (_owner, options) => {
      if (options?.title !== '下载文件副本') throw Error('Unexpected picker during image checks.');
      const choice = choices.shift(); if (!choice || !same(path.dirname(choice.target), output)) throw Error('Image picker escaped fixture output.');
      choice.name = options.defaultPath; choice.entered?.resolve(); if (choice.gate) await choice.gate.promise;
      return { canceled: false, filePath: choice.target };
    };
    await page(() => {
      const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
      const state = { originalCreate, originalRevoke, created: [], revoked: [], active: new Set() };
      URL.createObjectURL = function(blob) { const url = Reflect.apply(originalCreate, URL, [blob]); if (blob?.type?.startsWith('image/')) { state.created.push(url); state.active.add(url); } return url; };
      URL.revokeObjectURL = function(url) { if (state.created.includes(url)) { state.revoked.push(url); state.active.delete(url); } return Reflect.apply(originalRevoke, URL, [url]); };
      window.__imageURLs23 = state;
    }); urlInstalled = true;
    check('Image acceptance uses owned image fixtures and a simulated native picker with real isolated reads and exports', corpus.every(file => ids.has(file.id)) && same(store.dataDir, path.join(folder, 'data')));
    await openWorkspace(space);
    for (const [file, label] of [[png, 'PNG'], [jpeg, 'JPEG'], [gif, 'GIF'], [webp, 'WebP'], [svg, 'SVG']]) {
      await openFile(file);
      check('Managed ' + label + ' image reaches actual browser decode with nonzero natural dimensions', await page(id => { const root = document.querySelector('[data-testid="image-lightbox"]'), img = root?.querySelector('img'); return root?.dataset.fileId === id && img?.src.startsWith('blob:') && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0; }, file.id) && reads.some(read => read.id === file.id && read.ok && read.settled));
      await closeViewer();
    }
    const order = imageOrder(space);
    await openFile(metadata(order[0]));
    check('Library image gallery excludes text files and clamps at its first image', await page(count => document.querySelector('[data-testid="image-lightbox-counter"]').textContent === '1 / ' + count && document.querySelector('[data-testid="image-lightbox-previous"]').disabled, order.length));
    await page(() => { const buttons = [...document.querySelector('[data-testid="image-lightbox"]').querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length); buttons.at(-1).focus(); });
    await key('Tab');
    const forwardFocus = await page(() => document.activeElement === document.querySelector('[data-testid="image-lightbox-close"]'));
    await key('Tab', { shiftKey: true });
    check('Tab and Shift Tab wrap within the actual fullscreen image controls', forwardFocus && await page(() => document.activeElement === document.querySelector('[data-testid="image-lightbox-remove"]')));
    await key('ArrowLeft'); check('Library previous at the first image does not wrap', await currentId() === order[0]);
    await key('ArrowRight', { ctrlKey: true }); check('Modified arrow keys do not navigate the image viewer', await currentId() === order[0]);
    await key('ArrowRight'); await ready(order[1]);
    await page(() => document.querySelector('[data-testid="managed-image"]').click());
    await page(() => { const stage = document.querySelector('.image-lightbox-stage'); stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'mouse', pointerId: 23, button: 0, clientX: 200, clientY: 180 })); stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'mouse', pointerId: 23, button: 0, clientX: 270, clientY: 190 })); });
    await ready(order[0]);
    await page(() => document.querySelector('.image-lightbox-stage').click());
    check('Clicking an image keeps the viewer open and a horizontal swipe over fifty pixels navigates', await currentId() === order[0]);
    await screenshot('image-lightbox.png');
    await page(() => document.querySelector('.image-lightbox-stage').click()); await wait(() => !document.querySelector('[data-testid="image-lightbox"]')); await pause(50);
    check('Clicking the viewer background closes it reclaims object URLs and restores a connected focus target', (await stats()).active.length === 0 && await page(() => document.activeElement === window.__imageReturnFocus23 && document.activeElement?.isConnected && !document.querySelector('[data-testid="image-lightbox"]')));

    const chat = store.createChat({ title: '图片附件分组验收', workspaceId: space.id });
    const first = store.appendMessage(chat.id, { role: 'user', content: 'Only these two image attachments form this gallery.', attachmentIds: [png.id, note.id, gif.id] });
    store.appendMessage(chat.id, { role: 'user', content: 'Separate image message must stay outside the first gallery.', attachmentIds: [jpeg.id] });
    operations.updateChat({ id: chat.id, title: chat.title });
    await openChat(chat); await openAttachment(first, png); await key('ArrowLeft'); await ready(gif.id);
    check('Chat image gallery wraps only its own image attachments and excludes text and another message', await page(() => document.querySelector('[data-testid="image-lightbox-counter"]').textContent === '2 / 2') && await currentId() === gif.id);
    await key('ArrowRight'); await ready(png.id);
    check('Chat next wraps the last image back to its captured first attachment', await currentId() === png.id);
    await closeViewer(); await openWorkspace(space); await openFile(png);

    const downloadGate = deferred(), downloadEntered = deferred(), target = path.join(output, 'captured-original.png');
    releases.push(downloadGate.resolve); const choice = { target, gate: downloadGate, entered: downloadEntered }; choices.push(choice);
    const beforeExport = exports.length; await click('image-lightbox-download'); await nodeWait(() => typeof choice.name === 'string'); await downloadEntered.promise;
    const pngIndex = order.indexOf(png.id), direction = pngIndex < order.length - 1 ? 'image-lightbox-next' : 'image-lightbox-previous', adjacent = order[pngIndex + (pngIndex < order.length - 1 ? 1 : -1)];
    await click(direction); await ready(adjacent);
    check('A pending original-image download captures its target while navigation remains available', exports.length === beforeExport + 1 && exports.at(-1).input.id === png.id && Object.keys(exports.at(-1).input).join(',') === 'id' && choice.name === png.name && await page(() => document.querySelector('[data-testid="image-lightbox-download"]').disabled));
    downloadGate.resolve(); await nodeWait(() => exports.at(-1).settled); await wait(() => !document.querySelector('[data-testid="image-lightbox-download"]').disabled);
    check('Delayed download writes exact original bytes without changing the newly selected image', fs.readFileSync(target).equals(raw(png.id)) && exports.at(-1).result?.draft === false && await currentId() === adjacent);
    await click('image-lightbox-open-file'); await wait(() => !document.querySelector('[data-testid="image-lightbox"]') && document.querySelector('[data-testid="file-preview"] [data-testid="image-preview"]')?.dataset.state === 'ready');
    check('File workbench image preview stays read-only and offers a fullscreen entry', await page(() => document.querySelector('[data-testid="file-edit-mode"]').disabled && document.querySelector('[data-testid="file-save"]').disabled && !!document.querySelector('[data-testid="image-open-fullscreen"]') && !document.querySelector('[data-testid="file-editor-input"]')));
    await screenshot('image-inline.png'); await closeEditor(); await wait(() => window.__imageURLs23.active.size === 0);

    const late = holdRead(order[0]); await openFile(metadata(order[0]), false); await nodeWait(() => late.used); await late.entered.promise;
    await click('image-lightbox-next'); await ready(order[1]); const beforeLate = (await stats()).created.length;
    late.gate.resolve(); await nodeWait(() => reads.filter(item => item.id === order[0]).at(-1)?.settled); await pause(120);
    check('A late read from the previous image cannot allocate or replace the current object URL', await currentId() === order[1] && (await stats()).created.length === beforeLate);
    await closeViewer(); const closing = holdRead(order[0]); await openFile(metadata(order[0]), false); await nodeWait(() => closing.used); await closing.entered.promise;
    await closeViewer(); const beforeCloseLate = (await stats()).created.length; closing.gate.resolve(); await nodeWait(() => reads.filter(item => item.id === order[0]).at(-1)?.settled); await pause(120);
    check('Closing a loading image discards its late bytes without allocating an orphan URL', (await stats()).created.length === beforeCloseLate && (await stats()).active.length === 0);

    const unsafe = await operations.createWorkspace({ name: '图片错误与隔离验收' });
    const origin = new URL(process.env.MUSE_E2E_BASE_URL).origin, endpoint = name => origin + '/image-tripwire-23-' + name;
    const attack = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="360" onload="top.__imageTripwireExecuted23=true;fetch(&quot;' + endpoint('onload') + '&quot;)"><script>fetch("' + endpoint('script') + '");try{top.__imageTripwireExecuted23=true}catch(e){}</script><style>@import url("' + endpoint('css') + '");@font-face{font-family:Tripwire;src:url("' + endpoint('font') + '")}text{font-family:Tripwire}</style><rect width="640" height="360" fill="#5c7167"/><image href="' + endpoint('href') + '" x="0" y="0" width="16" height="16"/><foreignObject x="0" y="0" width="20" height="20"><body xmlns="http://www.w3.org/1999/xhtml"><img src="' + endpoint('foreign') + '"/><script>top.__imageTripwireExecuted23=true</script></body></foreignObject><text x="35" y="190" fill="white" font-size="25">SVG IMAGE CONTEXT TRIPWIRE</text></svg>';
    const dangerous = await add(unsafe, '隔离检测.svg', Buffer.from(attack));
    const corrupt = await add(unsafe, '损坏图片.png', Buffer.from('OWNED_CORRUPT_IMAGE_23'));
    await refresh(unsafe);
    window.webContents.session.webRequest.onBeforeRequest({ urls: [origin + '/*'] }, (details, callback) => { if (new URL(details.url).pathname.startsWith('/image-tripwire-23-')) tripwireRequests.push({ path: new URL(details.url).pathname, resourceType: details.resourceType }); callback({ cancel: false }); }); requestInstalled = true;
    await page(() => { window.__imageTripwireExecuted23 = false; window.__imageTripwireCsp23 = []; window.__imageCspListener23 = event => { if (event.blockedURI?.includes('/image-tripwire-23-')) window.__imageTripwireCsp23.push({ blocked: event.blockedURI.split('/').at(-1), directive: event.violatedDirective }); }; document.addEventListener('securitypolicyviolation', window.__imageCspListener23); });
    await openWorkspace(unsafe); await openFile(dangerous); await pause(450);
    const safety = await page(() => ({ executed: window.__imageTripwireExecuted23, csp: [...window.__imageTripwireCsp23], inlineNodes: document.querySelector('[data-testid="image-preview"]')?.querySelectorAll('svg,script,iframe,foreignObject').length || 0, src: document.querySelector('[data-testid="managed-image"]')?.src.startsWith('blob:') }));
    check('SVG script onload foreignObject href and CSS tripwires stay inert inside the actual blob image context', safety.executed === false && safety.inlineNodes === 0 && safety.src && safety.csp.length === 0 && tripwireRequests.length === 0 && raw(dangerous.id).toString() === attack);
    await screenshot('image-svg-isolation.png'); await closeViewer(); await openFile(corrupt, false); await wait(() => !!document.querySelector('[data-testid="image-error"]'));
    check('Actual decoder failure displays a readable error while keeping original download available', await page(() => document.querySelector('[data-testid="image-preview"]')?.dataset.state === 'error' && !document.querySelector('[data-testid="image-lightbox-download"]').disabled && !document.querySelector('[data-testid="managed-image"]')) && (await stats()).active.length === 0);
    await closeViewer(); await openWorkspace(space);

    await openFile(jpeg); const beforeRename = imageOrder(space), oldIndex = beforeRename.indexOf(jpeg.id);
    await operations.renameFile({ id: jpeg.id, expectedName: jpeg.name, name: '图片-JPEG已改格式.bin' });
    const afterRename = beforeRename.filter(id => id !== jpeg.id), expectedAfterRename = afterRename[Math.min(oldIndex, afterRename.length - 1)];
    await ready(expectedAfterRename);
    check('Renaming the current image to a non-image format removes its ID and clamps to its former gallery position', await currentId() === expectedAfterRename && await page(count => document.querySelector('[data-testid="image-lightbox-counter"]').textContent.endsWith('/ ' + count), afterRename.length));
    await closeViewer(); await openFile(note, false);
    // The text row intentionally opens the normal editor instead of a lightbox.
    await wait(() => !!document.querySelector('[data-testid="file-edit-mode"]') && !document.querySelector('[data-testid="file-edit-mode"]').disabled);
    await click('file-edit-mode'); const dirtyText = 'UNSAVED_TEXT_BEFORE_IMAGE_RENAME_23'; await fill('file-editor-input', dirtyText);
    await operations.renameFile({ id: note.id, expectedName: note.name, name: '文字已改图片.svg' });
    await wait(() => !!document.querySelector('[data-testid="file-renamed-warning"]'));
    check('Renaming a dirty text tab to SVG retains its original unsaved text and explicit reload warning', await page(text => document.querySelector('[data-testid="file-editor-input"]')?.value === text && !document.querySelector('[data-testid="file-preview"] [data-testid="image-preview"]'), dirtyText) && raw(note.id).toString() === svgText);
    const beforeShortcut = saves; await openFile(png);
    await page(() => { window.__imageSaveBubbles23 = 0; window.__imageSaveListener23 = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') window.__imageSaveBubbles23++; }; window.addEventListener('keydown', window.__imageSaveListener23); });
    await key('s', { ctrlKey: true });
    check('Image viewer intercepts Save so the hidden dirty workbench cannot silently write', saves === beforeShortcut && raw(note.id).toString() === svgText && await page(() => window.__imageSaveBubbles23 === 0));
    await page(() => { window.removeEventListener('keydown', window.__imageSaveListener23); delete window.__imageSaveListener23; delete window.__imageSaveBubbles23; });
    await closeViewer(); await closeEditor();

    await openFile(png); await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]'));
    await key('Escape'); await wait(() => !document.querySelector('.confirm-modal'));
    check('Escape dismisses the top deletion confirmation without closing or deleting the underlying image', await currentId() === png.id && !!store.getFile(png.id));
    const beforeDelete = imageOrder(space), deletedIndex = beforeDelete.indexOf(png.id), remaining = beforeDelete.filter(id => id !== png.id);
    await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]')); await click('confirm-delete');
    const expectedAfterDelete = remaining[Math.min(deletedIndex, remaining.length - 1)]; await ready(expectedAfterDelete);
    check('Confirmed image removal retains the neighboring gallery position and leaves the original source untouched', !store.snapshot().files.some(file => file.id === png.id) && await currentId() === expectedAfterDelete && sources.every(source => fs.readFileSync(source.path).equals(source.bytes)));
    await closeViewer();
    const tiny = await operations.createWorkspace({ name: '图片清空验收' });
    const one = await add(tiny, '清空一.png', Buffer.from(encoded.png, 'base64')), two = await add(tiny, '清空二.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); await refresh(tiny);
    await openWorkspace(tiny); await openFile(one);
    await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]')); await click('confirm-delete'); await ready(two.id);
    await click('image-lightbox-remove'); await wait(() => !!document.querySelector('[data-testid="confirm-delete"]')); await click('confirm-delete'); await wait(() => !document.querySelector('[data-testid="image-lightbox"]'));
    check('Removing every captured image automatically closes the empty gallery', !store.snapshot().files.some(file => file.id === one.id || file.id === two.id));
    await closeEditor(); await wait(() => window.__imageURLs23.active.size === 0);
    const finalURLs = await stats();
    check('All image object URLs are reclaimed after navigation errors late reads and closing without changing imported originals', finalURLs.created.length > 10 && finalURLs.active.length === 0 && finalURLs.created.every(url => finalURLs.revoked.includes(url)) && sources.every(source => fs.readFileSync(source.path).equals(source.bytes)) && reads.every(read => read.settled) && choices.length === 0 && exports.every(item => item.settled));
    fs.writeFileSync(path.join(folder, 'image-preview-receipt.json'), JSON.stringify({ native_save_picker: 'simulated only; IPC and filesystem export real', fixture_image_sources: 'owned canvas encodings, tiny GIF and synthetic SVG; no original app material', raw_browser_decode_formats: ['PNG', 'JPEG', 'GIF', 'WebP', 'SVG'], reads, exports: exports.map(item => ({ id: item.input.id, keys: Object.keys(item.input), settled: item.settled, draft: item.result?.draft })), image_URLs: finalURLs, SVG_tripwire: { ...safety, requests: tripwireRequests }, real_provider: false, target_mac_app_executed: false }, null, 2));
  } catch (error) {
    await screenshot('image-preview-failure.png').catch(() => {}); throw error;
  } finally {
    for (const release of releases) release();
    await closeViewer().catch(() => {});
    await closeEditor().catch(() => {});
    await pause(80);
    if (requestInstalled) window.webContents.session.webRequest.onBeforeRequest(null);
    if (urlInstalled) await page(() => { const state = window.__imageURLs23; if (state) { URL.createObjectURL = state.originalCreate; URL.revokeObjectURL = state.originalRevoke; delete window.__imageURLs23; } document.removeEventListener('securitypolicyviolation', window.__imageCspListener23); window.removeEventListener('keydown', window.__imageSaveListener23); delete window.__imageSaveListener23; delete window.__imageSaveBubbles23; delete window.__imageCspListener23; delete window.__imageTripwireCsp23; delete window.__imageTripwireExecuted23; delete window.__imageReturnFocus23; }).catch(() => {});
    operations.readImageFile = originalRead; operations.exportFile = originalExport; operations.saveTextFile = originalSave; dialog.showSaveDialog = originalPicker;
  }
};
