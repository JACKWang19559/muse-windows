'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Real rendered editor and isolated IPC only. No original application code,
// provider credentials, live user profile or mocked save result is used here.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('JSON checks require the isolated desktop fixture profile.');
  const originalSave = operations.saveTextFile, attempts = [], fixtureIds = new Set();
  const click = testId => page(id => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) throw Error('Missing JSON action ' + id);
    element.click();
  }, testId);
  const toggle = label => page(name => {
    const element = [...document.querySelectorAll('[data-testid="json-preview"] button')].find(button => button.getAttribute('aria-label') === name);
    if (!element) throw Error('Missing JSON tree action ' + name);
    element.click();
  }, label);
  const source = async text => {
    await click('file-edit-mode');
    await wait(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected, text);
  };
  const open = async file => {
    await wait(name => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === name), file.name);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), file.name);
    await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name && document.querySelector('[role="tab"][aria-selected="true"]')?.title === name && !document.querySelector('.loading-inline'), file.name);
  };
  const settle = async count => {
    await wait(() => document.querySelector('[data-testid="file-save"]')?.disabled === true);
    if (attempts.length !== count || !attempts.at(-1)?.settled) throw Error('JSON save did not settle exactly once.');
  };
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 180));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(folder, name), image.toPNG());
  };
  const diskText = id => fs.readFileSync(store.filePath(id), 'utf8');
  const closeDirty = () => page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
  const continueEditing = () => page(() => [...document.querySelectorAll('.confirm-modal button')].find(button => button.textContent === '继续编辑').click());

  try {
    // A previous full-suite scenario may leave a clean preview open.
    if (await page(() => !!document.querySelector('[data-testid="file-preview"]'))) {
      await closeDirty();
      await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    }
    const workspace = await operations.createWorkspace({ name: 'JSON 结构验收工作区' });
    const initial = '{\n  "config": { "enabled": true, "count": 7, "empty": null },\n  "items": [ { "name": "中文值 JSON_TREE_19" }, 3 ],\n  "literal": "<b>JSON_LITERAL_ONLY_19</b>"\n}\n';
    const json = (await operations.createTextFile({ workspaceId: workspace.id, name: '结构验收.json', content: initial })).file;
    const invalidText = '{ "broken": [1, 2, }\n';
    const invalid = (await operations.createTextFile({ workspaceId: workspace.id, name: '格式错误.json', content: invalidText })).file;
    const jsonlText = '{"record":"JSONL_FIRST_19","n":1}\n\n{"record":"JSONL_SECOND_19","n":2}\n';
    const jsonl = (await operations.createTextFile({ workspaceId: workspace.id, name: '逐行记录.jsonl', content: jsonlText })).file;
    for (const file of [json, invalid, jsonl]) fixtureIds.add(file.id);
    operations.saveTextFile = async input => {
      if (!fixtureIds.has(input?.id)) return originalSave(input);
      const record = { id: input.id, expectedSha256: input.expectedSha256, settled: false, ok: false };
      attempts.push(record);
      try { const result = await originalSave(input); record.ok = true; return result; }
      finally { record.settled = true; }
    };
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element => element.textContent.includes(name)), workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element => element.textContent.includes(name)).click(), workspace.name);
    await open(json);
    await wait(() => !!document.querySelector('[data-testid="json-preview"]'));
    check('JSON structure opens the root while nested containers remain folded', await page(() => document.querySelector('[aria-label="折叠 根节点"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[aria-label="展开 config"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('[aria-label="展开 items"]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.json-number')));
    await toggle('展开 config');
    await toggle('展开 items');
    await toggle('展开 0');
    check('Expanded JSON nodes render primitive types and nested Unicode values', await page(() => {
      const root = document.querySelector('[data-testid="json-preview"]');
      return root.textContent.includes('JSON_TREE_19') && root.querySelector('.json-boolean')?.textContent === 'true' && root.querySelector('.json-null')?.textContent === 'null' && [...root.querySelectorAll('.json-number')].some(node => node.textContent === '7');
    }));
    check('JSON string markup is displayed as literal text without creating elements', await page(() => { const root = document.querySelector('[data-testid="json-preview"]'); return root.textContent.includes('<b>JSON_LITERAL_ONLY_19</b>') && !root.querySelector('b'); }));
    await toggle('折叠 根节点');
    check('Collapsing the root hides descendants without rewriting managed JSON bytes', await page(() => document.querySelector('[aria-label="展开 根节点"]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.json-string')) && diskText(json.id) === initial);
    await toggle('展开 根节点');
    await source(initial);
    check('JSON source switching preserves the complete original formatting', await page(expected => document.querySelector('[data-testid="file-editor-input"]').value === expected && document.querySelector('[data-testid="file-edit-mode"]').textContent.includes('源码'), initial) && diskText(json.id) === initial);
    const saved = '{\n    "config" : { "enabled": false, "count": 19, "empty": null },\n    "items": ["JSON_SAVED_19", "第二项"],\n    "literal": "原样保存"\n}\n\n';
    await fill('file-editor-input', saved);
    await click('file-preview-mode');
    await wait(() => !!document.querySelector('[data-testid="json-preview"]'));
    await toggle('展开 items');
    check('JSON preview reflects the unsaved source draft without writing the file', await page(() => document.querySelector('[data-testid="json-preview"]').textContent.includes('JSON_SAVED_19') && !!document.querySelector('[aria-label="未保存"]')) && diskText(json.id) === initial && attempts.length === 0);
    await source(saved);
    const initialHash = store.readFile(json.id).sha256;
    await click('file-save');
    await settle(1);
    check('JSON Save commits exact source bytes once through the real CAS-protected host', attempts[0].ok && attempts[0].expectedSha256 === initialHash && diskText(json.id) === saved && store.readFile(json.id).text === saved && store.readFile(json.id).sha256 !== initialHash);
    check('A successful JSON save retains the source view and clears its dirty baseline', await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected && document.querySelector('[data-testid="file-save"]').disabled && !document.querySelector('[aria-label="未保存"]'), saved));

    await open(invalid);
    await wait(() => !!document.querySelector('[data-testid="json-parse-error"]'));
    check('Invalid JSON opens a clear parse error beside its unmodified source text', await page(expected => document.querySelector('[data-testid="json-parse-error"] pre')?.textContent === expected && !!document.querySelector('[data-testid="json-parse-error"] [role="alert"]'), invalidText) && diskText(invalid.id) === invalidText);
    await source(invalidText);
    const badDraft = '{\n "broken": [1, 2,\n "JSON_INVALID_DRAFT_19": true\n';
    await fill('file-editor-input', badDraft);
    const beforeInvalid = attempts.length;
    await click('file-save');
    await wait(() => !!document.querySelector('.editor-error[role="alert"]'));
    check('Invalid JSON Save stops before IPC and preserves both the full draft and disk content', attempts.length === beforeInvalid && diskText(invalid.id) === invalidText && await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected && document.querySelector('.editor-error').textContent.includes('JSON 格式无效'), badDraft));
    await closeDirty();
    await wait(() => !!document.querySelector('[data-testid="file-save-and-close"]'));
    await click('file-save-and-close');
    await wait(() => !!document.querySelector('.editor-error[role="alert"]'));
    check('Save-and-close refuses invalid JSON while preserving the confirmation and editable draft', attempts.length === beforeInvalid && diskText(invalid.id) === invalidText && await page(expected => !!document.querySelector('[data-testid="file-save-and-close"]') && document.querySelector('[data-testid="file-editor-input"]')?.value === expected, badDraft));
    await continueEditing();
    await wait(() => !document.querySelector('.confirm-modal'));
    check('Continue editing dismisses the close confirmation without consuming a JSON error draft', await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected, badDraft));
    await closeDirty(); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await click('file-discard');
    await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    check('Explicit discard closes invalid JSON without changing its persisted file', diskText(invalid.id) === invalidText && attempts.length === beforeInvalid);

    await open(jsonl);
    await wait(() => !!document.querySelector('[data-testid="jsonl-note"]'));
    await toggle('展开 0'); await toggle('展开 1');
    check('JSONL preview skips blank lines and exposes each independently parsed record', await page(() => document.querySelector('[data-testid="jsonl-note"]')?.textContent.includes('2 条记录') && document.querySelector('[data-testid="json-preview"]').textContent.includes('JSONL_FIRST_19') && document.querySelector('[data-testid="json-preview"]').textContent.includes('JSONL_SECOND_19')) && diskText(jsonl.id) === jsonlText);
    await screenshot('jsonl-preview.png');
    await source(jsonlText);
    const jsonlDraft = jsonlText.replace('JSONL_SECOND_19', 'JSONL_UNSAVED_19');
    await fill('file-editor-input', jsonlDraft); const beforeJsonl = attempts.length; await click('file-save');
    await wait(() => !!document.querySelector('.editor-error[role="alert"]'));
    check('Multiline JSONL saving retains the documented whole-JSON restriction and full draft', attempts.length === beforeJsonl && diskText(jsonl.id) === jsonlText && await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected && document.querySelector('.editor-error').textContent.includes('JSON 格式无效'), jsonlDraft));
    const arrayText = '[\n {"record":"JSONL_CONVERTED_19","n":1},\n {"record":"保留缩进","n":2}\n]\n';
    await fill('file-editor-input', arrayText); await click('file-save'); await settle(beforeJsonl + 1);
    await click('file-preview-mode'); await wait(() => !!document.querySelector('[data-testid="json-preview"]') && !document.querySelector('[data-testid="jsonl-note"]'));
    check('A JSONL-named file can save one complete JSON value without automatic reformatting', attempts.at(-1).ok && diskText(jsonl.id) === arrayText && store.readFile(jsonl.id).text === arrayText);

    await open(json); await source(saved);
    const localDraft = '{"local":"JSON_CAS_DRAFT_19"}\n', external = '{\n "external": "JSON_EXTERNAL_19"\n}\n';
    await fill('file-editor-input', localDraft);
    const baseHash = store.readFile(json.id).sha256;
    await originalSave({ id: json.id, content: external, expectedSha256: baseHash });
    const beforeConflict = attempts.length; await click('file-save');
    await wait(() => !!document.querySelector('.editor-error[role="alert"]'));
    check('JSON CAS conflict preserves the local draft and the newer external file', attempts.length === beforeConflict + 1 && attempts.at(-1).settled && !attempts.at(-1).ok && attempts.at(-1).expectedSha256 === baseHash && diskText(json.id) === external && await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected, localDraft));
    await page(() => document.querySelector('.editor-error button').click());
    await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await click('file-discard');
    await wait(() => !!document.querySelector('[data-testid="json-preview"]') && !document.querySelector('.editor-error'));
    await source(external);
    check('Explicit JSON conflict discard reloads the current host source and baseline', await page(expected => document.querySelector('[data-testid="file-editor-input"]')?.value === expected && document.querySelector('[data-testid="file-save"]').disabled && !document.querySelector('[aria-label="未保存"]'), external));
    const finalText = '{\n  "final": "JSON_CLOSE_SAVED_19",\n  "config": {"safe": true}\n}\n';
    await fill('file-editor-input', finalText); await closeDirty(); await wait(() => !!document.querySelector('[data-testid="file-save-and-close"]'));
    const beforeClose = attempts.length; await click('file-save-and-close');
    await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    check('Valid JSON save-and-close commits the complete source before closing all file tabs', attempts.length === beforeClose + 1 && attempts.at(-1).settled && attempts.at(-1).ok && diskText(json.id) === finalText);
    await open(json); await wait(() => !!document.querySelector('[data-testid="json-preview"]')); await toggle('展开 config');
    check('Reopening saved JSON reconstructs its tree from the durable managed file', await page(() => document.querySelector('[data-testid="json-preview"]').textContent.includes('JSON_CLOSE_SAVED_19') && document.querySelector('.json-boolean')?.textContent === 'true') && store.readFile(json.id).text === finalText);
    await screenshot('json-structure.png');
    await closeDirty(); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
  } finally { operations.saveTextFile = originalSave; }
};
