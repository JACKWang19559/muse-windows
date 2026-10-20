'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Actual Electron UI checks. This module may mutate only the synthetic desktop
// fixture that was created by test-desktop; it never opens a real user profile.
module.exports = async ({ window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw new Error('Artifact editing verification requires the isolated desktop fixture profile.');
  const originalWrite = operations.writeArtifactFiles;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const entered = deferred(), released = deferred(), attempts = [];
  const nodeWait = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Artifact editing fixture operation did not settle.');
  };
  let gateUsed = false, targetId;
  const selectFile = async value => {
    await wait(name => { const element = document.querySelector('[data-testid="artifact-file"]'); return element && [...element.options].some(option => option.value === name); }, value);
    await page(name => { const element = document.querySelector('[data-testid="artifact-file"]'); element.value = name; element.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    const expected = store.readArtifactFile({ id: targetId, path: value }).text;
    await wait(input => document.querySelector('[data-testid="artifact-file"]')?.value === input.path && document.querySelector('[data-testid="artifact-code"]')?.value === input.expected && !document.querySelector('[data-testid="artifact-code"]').disabled, { path: value, expected });
  };
  const clickConfirm = text => page(label => {
    const element = [...document.querySelectorAll('.artifact-confirm button')].find(button => button.textContent.trim() === label);
    if (!element) throw new Error('Missing artifact confirmation action.'); element.click();
  }, text);
  const exitGuard = () => page(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });

  try {
    const fixture = await page(async () => {
      const snapshot = await window.muse.bootstrap();
      const artifact = snapshot.artifacts.find(item => item.name === '桌面 React 应用' && item.runtime === 'react');
      return artifact ? { artifact, workspace: snapshot.workspaces.find(item => item.id === artifact.workspaceId) } : null;
    });
    if (!fixture?.artifact || !fixture.workspace) throw new Error('Run artifact-scenario before artifact-editing-scenario.');
    targetId = fixture.artifact.id;
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element => element.textContent.includes(name)), fixture.workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element => element.textContent.includes(name)).click(), fixture.workspace.name);
    await page(() => document.querySelector('[data-testid="artifacts-open"]').click());
    await wait(() => !!document.querySelector('[data-testid="artifact-panel"]'));
    await page(id => document.querySelector(`[data-artifact-id="${id}"]`).click(), targetId);
    await selectFile('src/main.tsx');
    const entryBefore = store.readArtifactFile({ id: targetId, path: 'src/main.tsx' }).text;
    await wait(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, entryBefore);
    const cleanExitGuard = await exitGuard();
    const revisionBefore = store.getArtifact(targetId).sourceRevision;
    const savedEntry = `${entryBefore}\n// ARTIFACT_EDITOR_SAVED_71\n`;

    operations.writeArtifactFiles = async input => {
      if (input?.id !== targetId) return originalWrite(input);
      const record = { id: input.id, expectedRevision: input.expectedRevision, paths: input.files.map(file => file.path), deletePaths: [...(input.deletePaths || [])], settled: false, outcome: null };
      attempts.push(record);
      try {
        const result = await originalWrite(input);
        if (!gateUsed) { gateUsed = true; entered.resolve(); await released.promise; }
        record.outcome = 'success'; return result;
      } catch (error) { record.outcome = 'error'; throw error; }
      finally { record.settled = true; }
    };
    await fill('artifact-code', savedEntry);
    await wait(() => !document.querySelector('[data-testid="artifact-save"]').disabled);
    await page(() => document.querySelector('[data-testid="artifact-save"]').click());
    await nodeWait(() => gateUsed);
    await entered.promise;
    await wait(revision => document.querySelector('.artifact-revision')?.textContent.includes(`源码 ${revision}`), revisionBefore + 1);
    check('Pending source save blocks editing after the host has committed and refreshed its revision', store.getArtifact(targetId).sourceRevision === revisionBefore + 1 && await page(expected => document.querySelector('[data-testid="artifact-code"]')?.disabled && document.querySelector('[data-testid="artifact-code"]').value === expected, savedEntry));
    released.resolve();
    await nodeWait(() => attempts[0]?.settled);
    await wait(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected && !document.querySelector('[data-testid="artifact-code"]').disabled && document.querySelector('[data-testid="artifact-save"]').disabled, savedEntry);
    check('Successful source save reloads the exact committed editor text after a revision refresh', store.readArtifactFile({ id: targetId, path: 'src/main.tsx' }).text === savedEntry && await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, savedEntry));

    await selectFile('src/style.css');
    const styleBefore = store.readArtifactFile({ id: targetId, path: 'src/style.css' }).text;
    await wait(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, styleBefore);
    await selectFile('src/main.tsx');
    check('Switching source files after saving retains the current persisted entry text', await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, savedEntry));
    const temporaryPath = 'src/temporary-editor-fixture.ts';
    await page(value => { const element = document.querySelector('[aria-label="新源码路径"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }, temporaryPath);
    await page(() => document.querySelector('.artifact-add-file button').click());
    await wait(name => document.querySelector('[data-testid="artifact-file"]')?.value === name && document.querySelector('[data-testid="artifact-code"]')?.value === '', temporaryPath);
    await fill('artifact-code', '// unsaved temporary source');
    await page(() => document.querySelector('[aria-label="删除源码文件"]').click());
    await wait(name => ![...document.querySelector('[data-testid="artifact-file"]').options].some(option => option.value === name) && !!document.querySelector('[data-testid="artifact-code"]'), temporaryPath);
    check('Deleting a new unsaved source removes its draft and selects an existing editable file', !store.getArtifact(targetId).files.some(file => file.path === temporaryPath) && await page(() => { const element = document.querySelector('[data-testid="artifact-file"]'); return [...element.options].some(option => option.value === element.value) && !document.querySelector('[data-testid="artifact-code"]').disabled; }));
    await selectFile('src/style.css');
    const savedStyle = `${styleBefore}\n/* ARTIFACT_OTHER_FILE_SAVED_71 */\n`, attemptBeforeStyle = attempts.length;
    await fill('artifact-code', savedStyle); await page(() => document.querySelector('[data-testid="artifact-save"]').click());
    await nodeWait(() => attempts.length > attemptBeforeStyle && attempts.at(-1).settled);
    await wait(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected && !document.querySelector('[data-testid="artifact-code"]').disabled && document.querySelector('[data-testid="artifact-save"]').disabled, savedStyle);
    check('Saving another source after deleting a temporary draft sends no nonexistent delete path', attempts.at(-1).outcome === 'success' && !attempts.at(-1).deletePaths.includes(temporaryPath) && store.readArtifactFile({ id: targetId, path: 'src/style.css' }).text === savedStyle);

    const localDraft = `${savedStyle}\n/* ARTIFACT_LOCAL_CONFLICT_DRAFT_71 */\n`;
    await fill('artifact-code', localDraft); await wait(() => !document.querySelector('[data-testid="artifact-save"]').disabled);
    const conflictBase = store.getArtifact(targetId).sourceRevision, externalStyle = `${savedStyle}\n/* ARTIFACT_EXTERNAL_EDIT_71 */\n`;
    await originalWrite({ id: targetId, expectedRevision: conflictBase, files: [{ path: 'src/style.css', text: externalStyle }] });
    await wait(() => document.querySelector('.artifact-warning')?.textContent.includes('源码已被其他操作修改'));
    check('An external source revision keeps the unsaved editor draft and exposes a CAS conflict', await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, localDraft) && store.readArtifactFile({ id: targetId, path: 'src/style.css' }).text === externalStyle);
    const attemptBeforeConflict = attempts.length;
    await page(() => document.querySelector('[data-testid="artifact-save"]').click());
    await nodeWait(() => attempts.length > attemptBeforeConflict && attempts.at(-1).settled);
    await wait(() => !document.querySelector('[data-testid="artifact-code"]')?.disabled && !document.querySelector('[data-testid="artifact-save"]').disabled);
    check('A rejected stale save preserves the full draft without overwriting the newer source', attempts.at(-1).outcome === 'error' && attempts.at(-1).expectedRevision === conflictBase && store.getArtifact(targetId).sourceRevision === conflictBase + 1 && store.readArtifactFile({ id: targetId, path: 'src/style.css' }).text === externalStyle && await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, localDraft));
    await page(() => document.querySelector('.artifact-warning button').click());
    await selectFile('src/style.css');
    await wait(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected && !document.querySelector('.artifact-warning') && document.querySelector('[data-testid="artifact-save"]').disabled, externalStyle);
    check('Explicit conflict discard reloads the newest source and clears the pending draft', await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, externalStyle));

    const closingDraft = `${externalStyle}\n/* ARTIFACT_CLOSE_DRAFT_71 */\n`;
    await fill('artifact-code', closingDraft); await wait(() => !document.querySelector('[data-testid="artifact-save"]').disabled);
    await new Promise(resolve => setTimeout(resolve, 80));
    check('Dirty application source installs a beforeunload guard without closing the desktop window', await exitGuard());
    await page(() => document.querySelector('[aria-label="关闭本地应用"]').click());
    await wait(() => document.querySelector('.artifact-confirm h3')?.textContent === '有未保存的源码');
    check('Closing a dirty application panel asks before discarding its source draft', await page(expected => !!document.querySelector('[data-testid="artifact-panel"]') && document.querySelector('[data-testid="artifact-code"]')?.value === expected, closingDraft));
    await clickConfirm('继续编辑');
    await wait(() => !document.querySelector('.artifact-confirm'));
    check('Continue editing dismisses the close confirmation while preserving the source draft', await page(expected => document.querySelector('[data-testid="artifact-code"]')?.value === expected, closingDraft));
    await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(folder, 'artifact-editing.png'), image.toPNG()));
    await page(() => document.querySelector('[aria-label="关闭本地应用"]').click());
    await wait(() => !!document.querySelector('.artifact-confirm'));
    await clickConfirm('放弃修改');
    await wait(() => !document.querySelector('[data-testid="artifact-panel"]'));
    await new Promise(resolve => setTimeout(resolve, 80));
    check('Explicit close discard leaves persisted source intact and removes the artifact exit guard', store.readArtifactFile({ id: targetId, path: 'src/style.css' }).text === externalStyle && await exitGuard() === cleanExitGuard);
  } finally {
    released.resolve();
    operations.writeArtifactFiles = originalWrite;
  }
};
