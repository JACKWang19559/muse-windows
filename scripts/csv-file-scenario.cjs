'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MAX_TEXT_CHARS } = require('../backend/documents.cjs');

// Actual renderer -> isolated preload/host -> managed file bytes. No provider,
// native picker, original module or real user profile is used by this scenario.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw Error('CSV checks require the isolated desktop fixture profile.');
  const originalRead = operations.readFile, originalSave = operations.saveTextFile, ids = new Set(), reads = [], writes = [];
  const click = testId => page(id => { const element = document.querySelector(`[data-testid="${id}"]`); if (!element) throw Error('Missing CSV action ' + id); element.click(); }, testId);
  const open = async file => {
    await wait(name => [...document.querySelectorAll('[data-testid="file-row"]')].some(row => row.querySelector('strong')?.textContent === name), file.name);
    await page(name => [...document.querySelectorAll('[data-testid="file-row"]')].find(row => row.querySelector('strong')?.textContent === name).querySelector('.file-main').click(), file.name);
    await wait(name => document.querySelector('[data-testid="file-preview"]')?.getAttribute('aria-label') === '文件预览 ' + name && document.querySelector('[role="tab"][aria-selected="true"]')?.title === name && !document.querySelector('.loading-inline'), file.name);
  };
  const source = async expected => { await click('file-edit-mode'); await wait(text => document.querySelector('[data-testid="file-editor-input"]')?.value === text, expected); };
  const save = async () => {
    const count = writes.length; await click('file-save');
    await wait(() => document.querySelector('[data-testid="file-editor-input"]')?.disabled === false && document.querySelector('[data-testid="file-save"]')?.disabled === true);
    if (writes.length !== count + 1 || !writes.at(-1).settled || !writes.at(-1).ok) throw Error('CSV save did not commit exactly once.');
    return writes.at(-1);
  };
  const close = () => page(() => document.querySelector('[aria-label="关闭文件预览"]').click());
  const bytes = id => fs.readFileSync(store.filePath(id));
  const screenshot = async name => { await new Promise(resolve => setTimeout(resolve, 180)); fs.writeFileSync(path.join(folder, name), (await window.webContents.capturePage()).toPNG()); };
  const domSource = () => page(() => document.querySelector('[data-testid="file-editor-input"]')?.value);

  try {
    if (await page(() => !!document.querySelector('[data-testid="file-preview"]'))) { await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]')); }
    const workspace = await operations.createWorkspace({ name: 'CSV 表格验收工作区' });
    const bomText = '\ufefffirst,note\r\n"csv,raw","quoted\r\nline"\r\n', bomBytes = Buffer.from(bomText, 'utf8');
    const bomPath = path.join(folder, '原文-BOM.csv'); fs.writeFileSync(bomPath, bomBytes);
    const bom = await store.addFile({ sourcePath: bomPath, workspaceId: workspace.id });
    const longPath = path.join(folder, '截取预览.csv'), longText = 'heading\n' + 'x'.repeat(MAX_TEXT_CHARS + 40) + '\nCSV_TRUNCATED_TAIL_21';
    fs.writeFileSync(longPath, longText); const truncated = await store.addFile({ sourcePath: longPath, workspaceId: workspace.id });
    const binaryPath = path.join(folder, '表格旁二进制.bin'), binaryBytes = Buffer.from([0, 255, 0, 128, 1, 0, 13, 10]);
    fs.writeFileSync(binaryPath, binaryBytes); const binary = await store.addFile({ sourcePath: binaryPath, workspaceId: workspace.id });
    const sampleText = 'name,note,tail\n"comma,value","said ""hello""",=SUM(A1)\n"two\nlines","<b>CSV_LITERAL_21</b>",last\nmissing\nextra,normal,third,EXTRA_HIDDEN_21\n';
    const sample = (await operations.createTextFile({ workspaceId: workspace.id, name: '表格数据.csv', content: sampleText })).file;
    const lowerText = 'name\tnote\n"lower,comma"\t"inside\ttab"\n';
    const lower = (await operations.createTextFile({ workspaceId: workspace.id, name: '小写.tsv', content: lowerText })).file;
    const upperText = 'name\tnote\nUPPER_TSV_21\tvalue\n';
    const upper = (await operations.createTextFile({ workspaceId: workspace.id, name: '大写.TSV', content: upperText })).file;
    const rowText = 'heading,value\n' + Array.from({ length: 1001 }, (_, index) => `CSV_ROW_${index},${index}`).join('\n') + '\n';
    const rows = (await operations.createTextFile({ workspaceId: workspace.id, name: '千行数据.csv', content: rowText })).file;
    for (const file of [sample, lower, upper, rows, bom, truncated, binary]) ids.add(file.id);
    operations.readFile = async input => {
      if (!ids.has(input?.id)) return originalRead(input);
      try { const result = await originalRead(input); reads.push({ id: input.id, input: { ...input }, result }); return result; }
      catch (error) { reads.push({ id: input.id, input: { ...input }, failed: true }); throw error; }
    };
    operations.saveTextFile = async input => {
      if (!ids.has(input?.id)) return originalSave(input);
      const record = { input: { ...input }, settled: false, ok: false }; writes.push(record);
      try { const result = await originalSave(input); record.ok = true; return result; }
      finally { record.settled = true; }
    };
    await wait(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element => element.textContent.includes(name)), workspace.name);
    await page(name => [...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element => element.textContent.includes(name)).click(), workspace.name);

    await open(sample); await wait(() => !!document.querySelector('[data-testid="csv-preview"]'));
    check('CSV preview renders the first row as fixed headers and data as an actual table', await page(() => document.querySelectorAll('[data-testid="csv-preview"] th').length === 3 && document.querySelectorAll('[data-testid="csv-preview"] tbody tr').length === 4 && document.querySelector('[data-testid="file-preview-mode"]').textContent === '表格' && document.querySelector('[data-testid="file-edit-mode"]').textContent.includes('源码')));
    check('CSV table parses quoted commas, doubled quotes and embedded line breaks', await page(() => { const rows = [...document.querySelectorAll('[data-testid="csv-preview"] tbody tr')].map(row => [...row.cells].map(cell => cell.textContent)); return rows[0][0] === 'comma,value' && rows[0][1] === 'said "hello"' && rows[1][0] === 'two\nlines'; }));
    check('CSV missing fields are padded and extra fields stay out of the fixed-width table', await page(() => { const rows = [...document.querySelectorAll('[data-testid="csv-preview"] tbody tr')]; return rows[2].cells.length === 3 && rows[2].cells[1].textContent === '' && rows[2].cells[2].textContent === '' && rows[3].cells.length === 3 && !document.querySelector('[data-testid="csv-preview"]').textContent.includes('EXTRA_HIDDEN_21'); }));
    check('CSV markup and formulas are inert text rather than elements or evaluated values', await page(() => { const root = document.querySelector('[data-testid="csv-preview"]'); return root.textContent.includes('<b>CSV_LITERAL_21</b>') && root.textContent.includes('=SUM(A1)') && !root.querySelector('b,script,iframe'); }));
    await screenshot('csv-preview.png');
    await source(sampleText);
    check('CSV source switching exposes every original field without rebuilding it from the table', await domSource() === sampleText && sampleText.includes('EXTRA_HIDDEN_21') && bytes(sample.id).toString('utf8') === sampleText && writes.length === 0);
    const permissive = 'a,b\n"unfinished,with,commas';
    await fill('file-editor-input', permissive); const initialSha = store.readFile(sample.id).sha256; const saved = await save();
    check('CSV Save accepts permissive unfinished quoting and sends exact text through the real CAS host', saved.input.expectedSha256 === initialSha && saved.input.content === permissive && bytes(sample.id).toString('utf8') === permissive && await domSource() === permissive && !await page(() => !!document.querySelector('.editor-error')));
    const local = 'a,b\nCSV_LOCAL_DRAFT_21,one\n', external = 'a,b\nCSV_EXTERNAL_21,two\n';
    await fill('file-editor-input', local); const beforeConflictSha = store.readFile(sample.id).sha256;
    await originalSave({ id: sample.id, content: external, expectedSha256: beforeConflictSha });
    const beforeConflict = writes.length; await click('file-save'); await wait(() => !!document.querySelector('.editor-error[role="alert"]'));
    check('CSV stale saves preserve the local draft and newer managed bytes without leaking IPC internals', writes.length === beforeConflict + 1 && writes.at(-1).settled && !writes.at(-1).ok && writes.at(-1).input.expectedSha256 === beforeConflictSha && bytes(sample.id).toString('utf8') === external && await domSource() === local && await page(() => !/muse:invoke|Error invoking remote method/.test(document.querySelector('.editor-error').textContent)));
    await page(() => document.querySelector('.editor-error button').click()); await wait(() => !!document.querySelector('[data-testid="file-discard"]')); await click('file-discard');
    await wait(() => !!document.querySelector('[data-testid="csv-preview"]') && !document.querySelector('.editor-error')); await source(external);
    check('Explicit CSV conflict discard reloads the current file and clears its dirty baseline', await domSource() === external && await page(() => document.querySelector('[data-testid="file-save"]').disabled && !document.querySelector('[aria-label="未保存"]')));
    const finalText = 'header,note\nCSV_CLOSE_SAVED_21,"two\nlines"\n'; await fill('file-editor-input', finalText); await close(); await wait(() => !!document.querySelector('[data-testid="file-save-and-close"]'));
    check('Closing a dirty CSV requires an explicit decision and retains all pending text', await domSource() === finalText && bytes(sample.id).toString('utf8') === external);
    await page(() => [...document.querySelectorAll('.confirm-modal button')].find(button => button.textContent === '继续编辑').click()); await wait(() => !document.querySelector('.confirm-modal'));
    await close(); await wait(() => !!document.querySelector('[data-testid="file-save-and-close"]')); const closeBefore = writes.length; await click('file-save-and-close'); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
    check('CSV save-and-close persists the complete unformatted source before closing its tabs', writes.length === closeBefore + 1 && writes.at(-1).ok && bytes(sample.id).toString('utf8') === finalText);

    await open(lower); await wait(() => !!document.querySelector('[data-testid="csv-preview"]'));
    check('Lowercase TSV selects tab delimiters while retaining commas and quoted tabs as data', await page(() => { const root = document.querySelector('[data-testid="csv-preview"]'); return root.querySelectorAll('th').length === 2 && root.querySelector('tbody tr').cells[0].textContent === 'lower,comma' && root.querySelector('tbody tr').cells[1].textContent === 'inside\ttab'; }));
    await open(upper); await wait(() => !!document.querySelector('[data-testid="csv-preview"]'));
    check('Uppercase TSV preserves the original comma-delimiter quirk without silently rewriting source', await page(() => { const root = document.querySelector('[data-testid="csv-preview"]'); return root.querySelectorAll('th').length === 1 && root.querySelector('th').textContent === 'name\tnote' && root.querySelector('tbody td').textContent === 'UPPER_TSV_21\tvalue'; }) && bytes(upper.id).toString('utf8') === upperText);
    await open(rows); await wait(() => !!document.querySelector('[data-testid="csv-row-limit"]'));
    check('CSV preview caps data at 1000 rows plus headers and displays its explicit limit notice', await page(() => { const root = document.querySelector('[data-testid="csv-preview"]'); return root.querySelectorAll('tbody tr').length === 1000 && root.querySelectorAll('thead tr').length === 1 && root.textContent.includes('CSV_ROW_999') && !root.textContent.includes('CSV_ROW_1000') && document.querySelector('[data-testid="csv-row-limit"]').textContent.includes('1000'); }));
    await screenshot('csv-row-limit.png'); await source(rowText);
    check('The capped CSV view retains all 1001 data rows in source and durable bytes', await domSource() === rowText && rowText.includes('CSV_ROW_1000') && bytes(rows.id).toString('utf8') === rowText && await page(() => document.querySelector('[data-testid="file-save"]').disabled));

    await open(bom); await wait(() => !!document.querySelector('[data-testid="csv-preview"]'));
    const editorRead = reads.filter(read => read.id === bom.id && !read.failed).at(-1)?.result;
    check('CSV editor host reads original BOM and quoted CRLF while model previews remain normalized', editorRead?.text === bomText && bytes(bom.id).equals(bomBytes) && store.readFile(bom.id).text === 'first,note\n"csv,raw","quoted\nline"\n' && await page(() => document.querySelector('[data-testid="csv-preview"] th')?.textContent === '\ufefffirst' && document.querySelector('[data-testid="csv-preview"] tbody tr')?.cells[1].textContent === 'quoted\r\nline'));
    // The browser's textarea.value normalizes CRLF to LF. A user edit must be
    // saved exactly as that actual DOM input, not as a forged React-state value.
    await source(bomText.replace(/\r\n/g, '\n'));
    const editedDom = (await domSource()) + 'CSV_DOM_EDIT_21,end\n'; await fill('file-editor-input', editedDom); const bomSaved = await save();
    check('CSV Save preserves BOM and exact actual DOM edit bytes without claiming textarea CRLF fidelity', bomSaved.input.content === editedDom && bytes(bom.id).equals(Buffer.from(editedDom)) && editedDom.startsWith('\ufeff') && fs.readFileSync(bomPath).equals(bomBytes) && await domSource() === editedDom);
    await open(truncated); await wait(() => !!document.querySelector('.plain-preview'));
    check('A truncated CSV falls back to plain preview and remains read-only instead of parsing an incomplete table', store.readFile(truncated.id).truncated && await page(() => !document.querySelector('[data-testid="csv-preview"]') && !!document.querySelector('.inline-note') && document.querySelector('[data-testid="file-edit-mode"]').disabled && !document.querySelector('.plain-preview').textContent.includes('CSV_TRUNCATED_TAIL_21')) && bytes(truncated.id).toString('utf8') === longText);
    await open(binary); await wait(() => document.querySelector('.empty-preview h4')?.textContent === '暂无文字预览');
    check('Unsupported binary preview shows a useful file error without internal IPC method text', await page(() => document.querySelector('.empty-preview p')?.textContent.length > 0 && !/muse:invoke|Error invoking remote method/.test(document.querySelector('.empty-preview').textContent) && document.querySelector('[data-testid="file-edit-mode"]').disabled) && bytes(binary.id).equals(binaryBytes));
    await close(); await wait(() => !document.querySelector('[data-testid="file-preview"]'));
  } finally { operations.readFile = originalRead; operations.saveTextFile = originalSave; }
};
