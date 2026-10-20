'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');

// Real renderer, isolated preload/IPC and Store/filesystem operations. The
// delayed-operation hook always forwards to production; it fabricates no result.
// Navigation during the delayed response uses real React DOM handlers, not OS
// pointer automation. Only this bounded synthetic test profile is read/copied.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('File rename checks require the isolated desktop fixture profile.');
  const originalRename = operations.renameFile, originalSave = operations.saveTextFile, originalRead = operations.readFile;
  const ids = new Set(), renames = [], saves = [], reads = [], gates = [];
  let nextGate = null, nextReadGate = null;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const nodeWait = async test => { const deadline = Date.now() + 9000; while (Date.now() < deadline) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('File rename operation did not settle.'); };
  const click = testId => page(id => { const element = document.querySelector(`[data-testid="${id}"]`); if (!element) throw Error('Missing file rename action ' + id); element.click(); }, testId);
  const raw = id => fs.readFileSync(store.filePath(id));
  const current = file => store.getFile(file.id);
  const domText = () => page(() => document.querySelector('[data-testid="file-editor-input"]')?.value);
  const close = () => page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
  const open = async file => {
    const name = current(file).name;
    await wait(value => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === value), name);
    await page(value => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === value).querySelector('.file-main').click(), name);
    await wait(value => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + value && document.querySelector('[role="tab"][aria-selected="true"]')?.title === value && !document.querySelector('.loading-inline'), name);
  };
  const beginRename = async () => { await click('file-rename'); await wait(() => !!document.querySelector('[data-testid="file-rename-name"]')); };
  const cancelRename = async () => {
    await page(() => [...document.querySelector('[data-testid="file-rename-name"]').closest('form').querySelectorAll('button')].find(button => button.textContent === '取消').click());
    await wait(() => !document.querySelector('[data-testid="file-rename-name"]'));
  };
  const errorVisible = () => wait(() => !!document.querySelector('[data-testid="file-rename-name"]')?.closest('form').querySelector('[role="alert"]'));
  const rename = async (file, name) => {
    const count = renames.length; await beginRename(); await fill('file-rename-name', name); await click('file-rename-submit');
    await nodeWait(() => renames.length === count + 1 && renames.at(-1).settled);
    if (!renames.at(-1).ok) throw Error('Expected successful real file rename.');
    await wait(() => !document.querySelector('[data-testid="file-rename-name"]'));
    await wait(value => document.querySelector('[role="tab"][aria-selected="true"]')?.title === value && document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + value && !document.querySelector('.loading-inline'), name);
    if (current(file).name !== name) throw Error('Rename did not update the captured file.');
    return renames.at(-1);
  };
  const edit = async text => { await click('file-edit-mode'); await wait(() => !!document.querySelector('[data-testid="file-editor-input"]')); await fill('file-editor-input', text); };
  const continueEditing = async () => { await page(() => [...document.querySelectorAll('.confirm-modal button')].find(button => button.textContent === '继续编辑').click()); await wait(() => !document.querySelector('.confirm-modal')); };
  const screenshot = async name => { await new Promise(resolve => setTimeout(resolve, 180)); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };

  try {
    if (await page(() => !!document.querySelector('[data-testid="file-preview"]'))) { await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]')); }
    const workspace = await operations.createWorkspace({ name: '文件重命名验收工作区' });
    const tableText = 'name\tnote\nRENAME_TABLE_22\tvalue\n';
    const table = (await operations.createTextFile({ workspaceId: workspace.id, name: '初始资料.txt', content: tableText })).file;
    const shapeText = '{\n  "kind": "RENAME_JSON_22", "enabled": true\n}\n';
    const shape = (await operations.createTextFile({ workspaceId: workspace.id, name: '格式切换.txt', content: shapeText })).file;
    const dirtyBase = 'RENAME_DIRTY_BASE_22\n';
    const dirty = (await operations.createTextFile({ workspaceId: workspace.id, name: '草稿文件.txt', content: dirtyBase })).file;
    const a = (await operations.createTextFile({ workspaceId: workspace.id, name: '捕获目标A.txt', content: 'RENAME_TARGET_A_22' })).file;
    const b = (await operations.createTextFile({ workspaceId: workspace.id, name: '捕获目标B.txt', content: 'RENAME_TARGET_B_22' })).file;
    const lateText = '{"kind":"RENAME_LATE_READ_22","enabled":true}\n';
    const late = (await operations.createTextFile({ workspaceId: workspace.id, name: '迟到读取.txt', content: lateText })).file;
    await operations.createTextFile({ workspaceId: workspace.id, name: '已占用.CSV', content: 'occupied' });
    const bomSource = path.join(folder, '重命名原始BOM.csv'), bomText = '\ufeffname,note\r\nvalue,"two\r\nlines"\r\n', bomBytes = Buffer.from(bomText);
    fs.writeFileSync(bomSource, bomBytes); const bom = await store.addFile({ sourcePath: bomSource, workspaceId: workspace.id });
    for (const file of [table, shape, dirty, a, b, bom, late]) ids.add(file.id);
    const refChat = store.createChat({ workspaceId: workspace.id, title: '重命名身份引用验收' });
    const refMessage = store.appendMessage(refChat.id, { role: 'user', content: 'SYNTHETIC_RENAME_REFERENCE_22', attachmentIds: [table.id, bom.id] });
    const profile = store.createAgentProfile({ workspaceId: workspace.id, name: '重命名快照验收' });
    const captured = store.captureProfileKnowledge({ id: profile.id, expectedRevision: profile.revision, kind: 'file', sourceId: table.id });
    const immutableSnapshot = JSON.stringify(captured.knowledgeSnapshots);
    operations.renameFile = async input => {
      if (!ids.has(input?.id)) return originalRename(input);
      const record = { input: { ...input }, settled: false, ok: false }; renames.push(record);
      const gate = nextGate; nextGate = null;
      try { if (gate) { gate.entered = true; await gate.release.promise; } const result = await originalRename(input); record.ok = true; record.result = result; return result; }
      finally { record.settled = true; }
    };
    operations.saveTextFile = async input => {
      if (!ids.has(input?.id)) return originalSave(input);
      const record = { input: { ...input }, settled: false, ok: false }; saves.push(record);
      try { const result = await originalSave(input); record.ok = true; return result; } finally { record.settled = true; }
    };
    operations.readFile = async input => {
      const result = await originalRead(input);
      if (!ids.has(input?.id)) return result;
      const record = { id: input.id, result, settled: false }; reads.push(record);
      const gate = nextReadGate?.id === input.id ? nextReadGate : null;
      if (gate) { nextReadGate = null; gate.entered = true; gate.captured = result; await gate.release.promise; }
      record.settled = true; return result;
    };
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element => element.textContent.includes(name)), workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element => element.textContent.includes(name)).click(), workspace.name);

    await open(table); await beginRename();
    const originalSelection = await page(() => { const input = document.querySelector('[data-testid="file-rename-name"]'); return { value: input.value, start: input.selectionStart, end: input.selectionEnd }; });
    await screenshot('file-rename-dialog.png');
    await fill('file-rename-name', '取消的提案.tsv'); await cancelRename();
    check('File rename opens from the real editor with only the stem selected and Cancel changes nothing', originalSelection.value === table.name && originalSelection.start === 0 && originalSelection.end === table.name.lastIndexOf('.') && renames.length === 0 && current(table).name === table.name && raw(table.id).equals(Buffer.from(tableText)));
    const firstRename = await rename(table, '重命名后的资料.txt');
    check('A Unicode rename updates the file card, active tab and header without changing bytes or identity', firstRename.input.id === table.id && firstRename.input.expectedName === table.name && firstRename.result.id === table.id && current(table).workspaceId === workspace.id && raw(table.id).equals(Buffer.from(tableText)) && store.getChat(refChat.id).messages.find(message => message.id === refMessage.id).attachmentIds.includes(table.id) && await page(() => [...document.querySelectorAll('[data-testid="file-row"] strong')].some(element => element.textContent === '重命名后的资料.txt')));

    await beginRename(); await fill('file-rename-name', '../越界.txt'); await click('file-rename-submit'); await errorVisible();
    check('Invalid rename is rejected by the real host while the dialog keeps the complete proposed name', !renames.at(-1).ok && renames.at(-1).settled && current(table).name === '重命名后的资料.txt' && raw(table.id).equals(Buffer.from(tableText)) && await page(() => document.querySelector('[data-testid="file-rename-name"]').value === '../越界.txt' && !/muse:invoke|Error invoking remote method/.test(document.querySelector('[data-testid="file-rename-name"]').closest('form').querySelector('[role="alert"]').textContent)));
    const duplicateBefore = renames.length; await fill('file-rename-name', '已占用.csv'); await click('file-rename-submit'); await nodeWait(() => renames.length === duplicateBefore + 1 && renames.at(-1).settled); await errorVisible();
    check('Same-workspace case-insensitive name collisions retain the dialog and leave both files unchanged', !renames.at(-1).ok && current(table).name === '重命名后的资料.txt' && store.snapshot().files.some(file => file.name === '已占用.CSV') && await page(() => document.querySelector('[data-testid="file-rename-name"]').value === '已占用.csv'));
    await cancelRename();
    await beginRename(); await fill('file-rename-name', '迟到的提案.tsv');
    const staleExpected = current(table).name;
    await originalRename({ id: table.id, name: '外部先到.txt', expectedName: staleExpected });
    await wait(() => document.querySelector('[role="tab"][aria-selected="true"]')?.title === '外部先到.txt');
    const staleBefore = renames.length; await click('file-rename-submit'); await nodeWait(() => renames.length === staleBefore + 1 && renames.at(-1).settled); await errorVisible();
    check('A rename dialog submits its captured old name and rejects a stale proposal after an external rename', renames.at(-1).input.expectedName === staleExpected && !renames.at(-1).ok && current(table).name === '外部先到.txt' && await page(() => document.querySelector('[data-testid="file-rename-name"]').value === '迟到的提案.tsv'));
    await cancelRename(); await rename(table, '表格预览.tsv'); await wait(() => !!document.querySelector('[data-testid="csv-preview"]'));
    check('Changing the full extension to lowercase TSV re-extracts and reloads the actual two-column preview', await page(() => document.querySelectorAll('[data-testid="csv-preview"] th').length === 2 && document.querySelector('[data-testid="csv-preview"] tbody tr').cells[1].textContent === 'value') && path.extname(store.filePath(table.id)) === '.tsv' && raw(table.id).equals(Buffer.from(tableText)));
    await rename(table, '表格预览.TSV'); await wait(() => document.querySelectorAll('[data-testid="csv-preview"] th').length === 1);
    check('A case-only extension rename refreshes TSV presentation while preserving the original uppercase delimiter quirk', current(table).name === '表格预览.TSV' && await page(() => document.querySelector('[data-testid="csv-preview"] th').textContent === 'name\tnote') && raw(table.id).equals(Buffer.from(tableText)));

    await open(shape); await rename(shape, '格式切换.json'); await wait(() => !!document.querySelector('[data-testid="json-preview"]'));
    check('Renaming ordinary text to JSON reloads structured preview without formatting or modifying its source', await page(() => document.querySelector('[data-testid="json-preview"]').textContent.includes('RENAME_JSON_22')) && raw(shape.id).equals(Buffer.from(shapeText)) && path.extname(store.filePath(shape.id)) === '.json');
    await rename(shape, '格式切换.bin'); await wait(() => document.querySelector('.empty-preview h4')?.textContent === '暂无文字预览');
    check('Renaming text to an unsupported binary extension invalidates the old preview and disables editing', await page(() => !document.querySelector('[data-testid="json-preview"]') && document.querySelector('[data-testid="file-edit-mode"]').disabled && !/muse:invoke|Error invoking remote method/.test(document.querySelector('.empty-preview').textContent)) && raw(shape.id).equals(Buffer.from(shapeText)) && path.extname(store.filePath(shape.id)) === '.bin');
    await rename(shape, '格式恢复.txt'); await wait(() => !!document.querySelector('.plain-preview'));
    check('Renaming the same binary-classified copy back to text restores current extraction and editable content', current(shape).textStatus === 'ready' && store.readFile(shape.id).editable && await page(() => document.querySelector('.plain-preview').textContent.includes('RENAME_JSON_22') && !document.querySelector('[data-testid="file-edit-mode"]').disabled) && raw(shape.id).equals(Buffer.from(shapeText)));
    await open(bom); const oldManaged = store.filePath(bom.id); await rename(bom, '保留原字节.tsv');
    const editorBom = await page(id => window.muse.readFile({ id }), bom.id);
    check('Pure extension rename migrates the managed suffix while preserving BOM and CRLF bytes and the imported source', raw(bom.id).equals(bomBytes) && fs.readFileSync(bomSource).equals(bomBytes) && store.filePath(bom.id) !== oldManaged && !fs.existsSync(oldManaged) && editorBom.text === bomText && current(bom).id === bom.id);

    await open(dirty); const dirtyDraft = 'RENAME_PENDING_DRAFT_22\n'; await edit(dirtyDraft); await click('file-rename'); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); const noRename = renames.length; await continueEditing();
    check('Dirty rename Continue keeps the full draft and never opens or submits a rename', renames.length === noRename && await domText() === dirtyDraft && raw(dirty.id).equals(Buffer.from(dirtyBase)) && !await page(() => !!document.querySelector('[data-testid="file-rename-name"]')));
    await click('file-rename'); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await click('file-discard'); await wait(() => !!document.querySelector('[data-testid="file-rename-name"]')); await fill('file-rename-name', '已放弃草稿.txt'); await click('file-rename-submit'); await wait(() => !document.querySelector('[data-testid="file-rename-name"]') && !document.querySelector('.loading-inline'));
    check('Dirty rename Discard abandons only the local draft and renames the unchanged managed bytes', current(dirty).name === '已放弃草稿.txt' && raw(dirty.id).equals(Buffer.from(dirtyBase)) && await page(() => !document.querySelector('[aria-label="未保存"]')));
    const savedDraft = 'RENAME_SAVED_BEFORE_NAME_22\n'; await edit(savedDraft); const savedCount = saves.length; await click('file-rename'); await wait(() => !!document.querySelector('[data-testid="file-save-and-close"]')); await click('file-save-and-close'); await wait(() => !!document.querySelector('[data-testid="file-rename-name"]'));
    const savedBeforeRename = raw(dirty.id).equals(Buffer.from(savedDraft)); await fill('file-rename-name', '先保存再重命名.md'); await click('file-rename-submit'); await wait(() => !document.querySelector('[data-testid="file-rename-name"]') && !document.querySelector('.loading-inline'));
    check('Dirty rename Save commits exact editor text with old-name CAS before the rename is submitted', savedBeforeRename && saves.length === savedCount + 1 && saves.at(-1).ok && saves.at(-1).input.expectedName === '已放弃草稿.txt' && current(dirty).name === '先保存再重命名.md' && raw(dirty.id).equals(Buffer.from(savedDraft)));
    await screenshot('file-rename.png');

    const externalDraft = 'RENAME_EXTERNAL_LOCAL_DRAFT_22\n'; await edit(externalDraft); const externalOld = current(dirty).name, externalSha = store.readFile(dirty.id).sha256;
    await originalRename({ id: dirty.id, name: '外部名称已变化.txt', expectedName: externalOld }); await wait(() => !!document.querySelector('[data-testid="file-renamed-warning"]'));
    const blockedCount = saves.length; await click('file-save');
    check('An externally renamed dirty tab keeps its draft and warns instead of silently saving under a new name', await domText() === externalDraft && raw(dirty.id).equals(Buffer.from(savedDraft)) && saves.length === blockedCount && await page(() => document.querySelector('[data-testid="file-renamed-warning"]').textContent.includes('外部名称已变化.txt')));
    const staleSaveRejected = await page(async input => { try { await window.muse.saveTextFile(input); return false; } catch (error) { const message = (error.message || '').replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, ''); return message.includes('文件名已变化') && !/muse:invoke|Error invoking remote method/.test(message); } }, { id: dirty.id, content: externalDraft, expectedSha256: externalSha, expectedName: externalOld });
    check('The isolated save IPC independently rejects an old captured filename without overwriting the newer named file', staleSaveRejected && !saves.at(-1).ok && current(dirty).name === '外部名称已变化.txt' && raw(dirty.id).equals(Buffer.from(savedDraft)));
    await page(() => [...document.querySelectorAll('[data-testid="file-renamed-warning"] button')].find(button => button.textContent === '重新读取文件').click()); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await continueEditing(); const keptAfterReloadCancel = await domText() === externalDraft;
    await page(() => [...document.querySelectorAll('[data-testid="file-renamed-warning"] button')].find(button => button.textContent === '重新读取文件').click()); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await click('file-discard'); await wait(() => !document.querySelector('[data-testid="file-renamed-warning"]') && !document.querySelector('.loading-inline'));
    check('Reload after external rename still requires a dirty-draft decision and explicit discard clears the warning', keptAfterReloadCancel && await page(() => !document.querySelector('[aria-label="未保存"]') && document.querySelector('.plain-preview')?.textContent === 'RENAME_SAVED_BEFORE_NAME_22\n') && raw(dirty.id).equals(Buffer.from(savedDraft)));

    const roundTripDraft = 'RENAME_ROUND_TRIP_DRAFT_22\n', roundTripName = current(dirty).name;
    await edit(roundTripDraft); await originalRename({ id: dirty.id, name: '临时外部名称.txt', expectedName: roundTripName });
    await wait(() => !!document.querySelector('[data-testid="file-renamed-warning"]'));
    await originalRename({ id: dirty.id, name: roundTripName, expectedName: '临时外部名称.txt' });
    await wait(() => !document.querySelector('[data-testid="file-renamed-warning"]'));
    const roundTripKept = await domText() === roundTripDraft, roundTripSaveCount = saves.length;
    await click('file-save'); await nodeWait(() => saves.length === roundTripSaveCount + 1 && saves.at(-1).settled);
    await wait(() => document.querySelector('[data-testid="file-save"]')?.disabled === true);
    check('Returning an externally renamed dirty file to its captured name clears the warning and permits its unchanged draft to save', roundTripKept && saves.at(-1).ok && saves.at(-1).input.expectedName === roundTripName && current(dirty).name === roundTripName && raw(dirty.id).equals(Buffer.from(roundTripDraft)));

    await open(late);
    const readGate = { id: late.id, release: deferred(), entered: false }; gates.push(readGate); nextReadGate = readGate;
    await page(() => document.querySelector('[aria-label="重新读取文件"]').click()); await nodeWait(() => readGate.entered);
    await originalRename({ id: late.id, name: '迟到读取已改格式.json', expectedName: late.name });
    await wait(() => document.querySelector('[role="tab"][aria-selected="true"]')?.title === '迟到读取已改格式.json');
    readGate.release.resolve();
    await wait(() => !!document.querySelector('[data-testid="json-preview"]') && !document.querySelector('.loading-inline') && document.querySelector('[data-testid="json-preview"]').textContent.includes('RENAME_LATE_READ_22'));
    await nodeWait(() => reads.some(record => record.id === late.id && record.settled && record.result.name === '迟到读取已改格式.json'));
    check('An old real read arriving after an external extension rename triggers a fresh read for the new name and preview', readGate.captured.name === late.name && readGate.captured.text === lateText && reads.filter(record => record.id === late.id).at(-1).result.name === current(late).name && store.readFile(late.id).editable && await page(() => !document.querySelector('[data-testid="file-edit-mode"]').disabled && !document.querySelector('.plain-preview') && !!document.querySelector('[data-testid="json-preview"]')) && raw(late.id).equals(Buffer.from(lateText)));

    await open(a); await open(b); await page(() => document.querySelector('[role="tab"][title="捕获目标A.txt"]').click()); await wait(() => document.querySelector('[role="tab"][aria-selected="true"]')?.title === '捕获目标A.txt');
    const gate = { release: deferred(), entered: false }; gates.push(gate); nextGate = gate;
    await beginRename(); await fill('file-rename-name', '捕获目标A已完成.md'); await click('file-rename-submit'); await nodeWait(() => gate.entered);
    await page(() => document.querySelector('[role="tab"][title="捕获目标B.txt"]').click()); await wait(() => document.querySelector('[role="tab"][aria-selected="true"]')?.title === '捕获目标B.txt'); gate.release.resolve();
    await nodeWait(() => renames.at(-1).settled); await wait(() => !document.querySelector('[data-testid="file-rename-name"]'));
    check('A delayed rename retains its captured file identity when real renderer tab handlers select another file', renames.at(-1).input.id === a.id && current(a).name === '捕获目标A已完成.md' && current(b).name === b.name && raw(a.id).toString() === 'RENAME_TARGET_A_22' && raw(b.id).toString() === 'RENAME_TARGET_B_22' && await page(() => document.querySelector('[role="tab"][aria-selected="true"]')?.title === '捕获目标B.txt' && !!document.querySelector('[role="tab"][title="捕获目标A已完成.md"]')));

    const backup = store.exportData(), restartPath = path.join(folder, 'file-rename-restart');
    if (fs.existsSync(restartPath) || path.dirname(restartPath) !== path.resolve(folder)) throw Error('Unsafe restart fixture directory.');
    // Reopen only Store-owned persisted records/copies. Chromium's live cache
    // directories are unrelated and may be locked by this same test window.
    // No secret() call, browser profile copy or provider configuration read.
    fs.mkdirSync(restartPath);
    fs.copyFileSync(store.statePath, path.join(restartPath, 'state.json'));
    if (fs.existsSync(store.backupPath)) fs.copyFileSync(store.backupPath, path.join(restartPath, 'state.backup.json'));
    fs.cpSync(store.attachmentsDir, path.join(restartPath, 'attachments'), { recursive: true });
    const restarted = new Store(restartPath);
    check('Renamed IDs, raw backups, attachment links and immutable knowledge snapshots survive a real Store restart', restarted.getFile(table.id).name === '表格预览.TSV' && restarted.getFile(a.id).name === '捕获目标A已完成.md' && fs.readFileSync(restarted.filePath(bom.id)).equals(bomBytes) && restarted.getChat(refChat.id).messages.find(message => message.id === refMessage.id).attachmentIds.join(',') === [table.id, bom.id].join(',') && JSON.stringify(restarted.getAgentProfile(profile.id).knowledgeSnapshots) === immutableSnapshot && Buffer.from(backup.files.find(file => file.id === bom.id).dataBase64, 'base64').equals(bomBytes) && backup.files.find(file => file.id === table.id).name === '表格预览.TSV');
    await screenshot('file-rename-final.png'); await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
  } finally {
    for (const gate of gates) gate.release.resolve();
    operations.renameFile = originalRename; operations.saveTextFile = originalSave; operations.readFile = originalRead;
  }
};
