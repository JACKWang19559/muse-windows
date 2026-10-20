'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PdfSession, createAssetFactories, pdfErrorMessage } = require('../renderer/pdf-session.cjs');
const { MAX_PAGE_PIXELS } = require('../renderer/pdf-layout.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const file = { id: 'owned_pdf', name: 'owned.pdf', sha256: 'a'.repeat(64) };
const reply = input => ({ id: input.id, name: input.expectedName, sha256: 'a'.repeat(64), mimeType: 'application/pdf', size: 10, pdf: new ArrayBuffer(10) });
class WorkerPort {}
function fixture(options = {}) {
  const events = [], views = [], pageViews = [], workers = [], tasks = [];
  let getDocumentCount = 0, documentOptions;
  const pages = new Map();
  function page(number) {
    if (!pages.has(number)) pages.set(number, {
      getViewport({ scale }) { return { width: (number === 2 ? 500 : 400) * scale, height: (number === 2 ? 400 : 500) * scale }; },
      cleanup() { events.push('cleanup:' + number); return true; },
      render(input) {
        events.push('render:' + number); const pending = deferred();
        const task = { promise: pending.promise, cancel() { events.push('cancel:' + number); if (!options.ignoreCancel) pending.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
        tasks.push({ number, input, pending, task });
        if (!options.manualRender) pending.resolve();
        return task;
      }
    });
    return pages.get(number);
  }
  const document = { numPages: options.numPages || 80, getPage: number => options.getPage?.(number) || Promise.resolve(page(number)) };
  const pdfjs = { GlobalWorkerOptions: {},
    PDFWorker: class {
      constructor() { this.port = options.fakeWorker ? {} : new WorkerPort(); this.promise = options.workerPromise || Promise.resolve(); workers.push(this); events.push('worker-create'); options.onWorkerCreate?.(); }
      destroy() { if (!this.destroyed) { events.push('worker-destroy'); options.onWorkerDestroy?.(); } this.destroyed = true; }
    },
    getDocument(input) { getDocumentCount++; const index = getDocumentCount; documentOptions = input; events.push('get-document'); return { promise: typeof options.documentPromise === 'function' ? options.documentPromise(index) : options.documentPromise || Promise.resolve(document), async destroy() { events.push('document-destroy'); await options.destroyDocument?.(index); } }; }
  };
  const session = new PdfSession({ pdfjs, readFile: options.readFile || (input => Promise.resolve(reply(input))), readAsset: options.readAsset || (() => Promise.resolve(new ArrayBuffer(8))), workerSrc: 'file:///owned/build/pdf.worker.mjs', WorkerClass: WorkerPort, dpr: 1,
    onChange: value => views.push(value), onPage: (number, value) => pageViews.push({ number, ...value }), ...options.sessionOptions });
  return { session, events, views, pageViews, workers, tasks, pages, document, get documentOptions() { return documentOptions; }, get getDocumentCount() { return getDocumentCount; } };
}
test('a real worker port is required and local document options keep fonts/CMaps/wasm on the host bridge', async () => {
  const f = fixture(); await f.session.load(file);
  assert.equal(f.views.at(-1).status, 'ready'); assert.equal(f.views.at(-1).actualWorker, true);
  const o = f.documentOptions;
  assert.equal(o.useWorkerFetch, false); assert.equal(o.useWasm, true); assert.equal(o.isEvalSupported, false); assert.equal(o.enableXfa, false); assert.equal(o.useSystemFonts, false);
  assert.equal(o.stopAtErrors, true); assert(o.CMapReaderFactory && o.StandardFontDataFactory && o.WasmFactory); assert(!o.url);
  assert(!Object.hasOwn(o, 'maxImageSize'), 'A successful page must not silently omit images above an arbitrary pixel threshold');
  await f.session.dispose();
  const fake = fixture({ fakeWorker: true }); await fake.session.load(file); await fake.session.dispose();
  assert.equal(fake.getDocumentCount, 0); assert.match(fake.views.at(-1).error, /独立 PDF/); assert.equal(fake.workers[0].destroyed, true);
});
test('closing or replacing during a delayed file read prevents the old response from creating any worker', async () => {
  const first = deferred(), f = fixture({ readFile: input => input.id === file.id ? first.promise : Promise.resolve(reply(input)) });
  const stale = f.session.load(file); await tick();
  await f.session.load({ ...file, id: 'new_pdf' });
  first.resolve(reply({ id: file.id, expectedName: file.name })); await stale;
  assert.equal(f.workers.length, 1); assert.equal(f.views.at(-1).key.includes('new_pdf'), true);
  await f.session.dispose();
  const delayed = deferred(), closed = fixture({ readFile: () => delayed.promise }); const pending = closed.session.load(file);
  await closed.session.dispose(); delayed.resolve(reply({ id: file.id, expectedName: file.name })); await pending;
  assert.equal(closed.workers.length, 0);
});
test('retirement of a pending worker or document stops publication and explicitly destroys the worker', async () => {
  const pending = deferred(), f = fixture({ workerPromise: pending.promise }); const load = f.session.load(file);
  await tick(); const count = f.views.length; await f.session.dispose(); await load;
  pending.resolve(); await tick(); assert.equal(f.views.length, count); assert.equal(f.getDocumentCount, 0); assert.equal(f.workers[0].destroyed, true);
  const data = deferred(), g = fixture({ documentPromise: data.promise }); const loading = g.session.load(file);
  await tick(); await g.session.dispose(); await loading; data.resolve(g.document); await tick();
  assert(g.events.indexOf('document-destroy') < g.events.indexOf('worker-destroy')); assert(g.views.every(v => v.status !== 'ready'));
});
test('visible pages are actually rendered serially; leaving one cancels before another canvas is drawn', async () => {
  const f = fixture({ manualRender: true }); await f.session.load(file);
  const first = { width: 300, height: 150 }, second = { width: 300, height: 150 };
  const releaseFirst = f.session.attachPage(1, first); f.session.attachPage(2, second); await tick();
  assert.equal(f.tasks.length, 1); assert.equal(second.width, 0);
  releaseFirst(); await tick(); assert.equal(f.tasks.length, 2); assert.equal(f.tasks[1].number, 2);
  assert.equal(first.width, 0); assert.equal(first.height, 0);
  assert(f.events.indexOf('cancel:1') < f.events.indexOf('render:2'));
  f.tasks[1].pending.resolve(); await tick(); assert.equal(f.pageViews.at(-1).status, 'ready');
  assert(second.width * second.height <= MAX_PAGE_PIXELS);
  await f.session.dispose(); assert.equal(second.width, 0); assert.equal(second.height, 0);
});
test('last-page requests are not a first-N preview and preserve the page rotation dimensions', async () => {
  const f = fixture(); await f.session.load(file);
  const canvas = {}; const release = f.session.attachPage(80, canvas); await tick();
  assert.equal(f.tasks[0].number, 80); assert.equal(f.pageViews.at(-1).status, 'ready');
  release(); const rotated = {}; f.session.attachPage(2, rotated); await tick();
  assert.equal(rotated.width, 750); assert.equal(rotated.height, 600);
  await f.session.dispose();
});
test('replacement awaits the old document teardown and never publishes late page work into the new document', async () => {
  const f = fixture({ manualRender: true }); await f.session.load(file); const canvas = {}; f.session.attachPage(1, canvas); await tick();
  const before = f.pageViews.length; await f.session.load({ ...file, id: 'replacement' });
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  assert.equal(f.pageViews.length, before); assert.equal(f.workers[0].destroyed, true);
  const oldDestroyed = f.events.indexOf('worker-destroy'), newCreated = f.events.lastIndexOf('worker-create'); assert(oldDestroyed < newCreated);
  await f.session.dispose();
});
test('a fast retry and replacement after parse failure wait for the already-retired worker teardown', async () => {
  const teardown = deferred(); let f;
  f = fixture({ documentPromise: index => index === 1 ? Promise.reject(Object.assign(new Error('bad PDF'), { name: 'InvalidPDFException' })) : Promise.resolve(f.document), destroyDocument: index => index === 1 ? teardown.promise : undefined });
  await f.session.load(file); assert.equal(f.views.at(-1).status, 'error');
  const retry = f.session.load({ ...file, id: 'retry' }); await tick(); assert.equal(f.workers.length, 1);
  const replacement = f.session.load({ ...file, id: 'replacement' }); await tick(); assert.equal(f.workers.length, 1);
  teardown.resolve(); await Promise.all([retry, replacement]);
  assert.equal(f.workers.length, 2); assert.equal(f.workers[0].destroyed, true);
  assert(f.events.indexOf('worker-destroy') < f.events.lastIndexOf('worker-create'));
  assert.equal(f.views.at(-1).status, 'ready'); assert(f.views.at(-1).key.includes('replacement'));
  await f.session.dispose();
});
test('a retired render ignoring cancel cannot retire or draw into the replacement document', async () => {
  const f = fixture({ manualRender: true, ignoreCancel: true, sessionOptions: { cancelTimeout: 5, destroyTimeout: 5 } });
  await f.session.load(file); const oldCanvas = {}; f.session.attachPage(1, oldCanvas); await tick();
  await f.session.load({ ...file, id: 'replacement' });
  assert.equal(f.views.at(-1).status, 'ready'); assert(f.views.at(-1).key.includes('replacement'));
  assert.equal(oldCanvas.width, 0); assert.equal(f.workers.length, 2); assert.equal(f.workers[1].destroyed, undefined);
  const before = f.views.length; f.tasks[0].pending.resolve(); await tick(); assert.equal(f.views.length, before);
  await f.session.dispose();
});
test('new preview instances may read but wait for every already-retired document, including parse-error cleanup', async () => {
  const firstDestroy = deferred(), secondDestroy = deferred(), order = [];
  // Both documents are live before either starts retiring. The barrier covers
  // all of their cleanups, rather than only the last component's promise.
  const first = fixture({ destroyDocument: () => firstDestroy.promise, onWorkerDestroy: () => order.push('first-stopped') });
  const second = fixture({ destroyDocument: () => secondDestroy.promise, onWorkerDestroy: () => order.push('second-stopped') });
  await first.session.load(file); await second.session.load({ ...file, id: 'second' });
  const closeFirst = first.session.dispose(), closeSecond = second.session.dispose();
  let reads = 0;
  const next = fixture({ readFile: input => { reads++; return Promise.resolve(reply(input)); }, onWorkerCreate: () => order.push('next-started') });
  const loading = next.session.load({ ...file, id: 'next' }); await tick();
  assert.equal(reads, 1); assert.equal(next.workers.length, 0);
  firstDestroy.resolve(); await closeFirst; await tick(); assert.equal(next.workers.length, 0);
  secondDestroy.resolve(); await Promise.all([closeSecond, loading]);
  assert.deepEqual(order, ['first-stopped', 'second-stopped', 'next-started']);
  assert.equal(next.views.at(-1).status, 'ready'); await next.session.dispose();

  const errorDestroy = deferred();
  const failed = fixture({ documentPromise: Promise.reject(Object.assign(new Error('broken'), { name: 'InvalidPDFException' })), destroyDocument: () => errorDestroy.promise });
  await failed.session.load(file); assert.equal(failed.views.at(-1).status, 'error');
  const afterError = fixture(); const waiting = afterError.session.load(file); await tick(); assert.equal(afterError.workers.length, 0);
  errorDestroy.resolve(); await waiting; assert.equal(failed.workers[0].destroyed, true); assert.equal(afterError.workers.length, 1);
  await Promise.all([failed.session.dispose(), afterError.session.dispose()]);
});
test('font-held retirement terminates without its reply and a late asset cannot alter the reopened preview', async () => {
  const fontReply = deferred(), order = [];
  const old = fixture({ readAsset: () => fontReply.promise, destroyDocument: () => fontReply.promise, onWorkerDestroy: () => order.push('old-stopped'), sessionOptions: { destroyTimeout: 20 } });
  await old.session.load(file);
  const asset = new old.documentOptions.StandardFontDataFactory().fetch({ filename: 'FoxitSans.pfb' });
  const assetRejected = assert.rejects(asset, /取消/);
  const closing = old.session.dispose();
  let read = false; const reopened = fixture({ readFile: input => { read = true; return Promise.resolve(reply(input)); }, onWorkerCreate: () => order.push('new-started') });
  const loading = reopened.session.load({ ...file, id: 'reopened' }); await tick();
  assert.equal(read, true); assert.equal(reopened.workers.length, 0);
  await Promise.all([closing, loading]);
  assert.deepEqual(order, ['old-stopped', 'new-started']);
  const before = reopened.views.length; fontReply.resolve(new ArrayBuffer(8)); await assetRejected; await tick();
  assert.equal(reopened.views.length, before); assert.equal(reopened.views.at(-1).status, 'ready');
  await reopened.session.dispose();
});
test('closing or replacing while a cross-instance cleanup barrier is pending cannot revive a cancelled request', async () => {
  const release = deferred(), old = fixture({ destroyDocument: () => release.promise });
  await old.session.load(file); const closing = old.session.dispose();
  const cancelled = fixture(); const cancelledLoad = cancelled.session.load(file); await tick();
  await cancelled.session.dispose(); await cancelledLoad; assert.equal(cancelled.workers.length, 0);
  const next = fixture(); const superseded = next.session.load({ ...file, id: 'superseded' }); await tick();
  const final = next.session.load({ ...file, id: 'final' }); await tick(); assert.equal(next.workers.length, 0);
  release.resolve(); await Promise.all([closing, superseded, final]);
  assert.equal(cancelled.workers.length, 0); assert.equal(next.workers.length, 1);
  assert(next.views.at(-1).key.includes('final'));
  await next.session.dispose();
  // No completed retirement remains in the shared set to block unrelated work.
  const later = fixture(); await later.session.load(file); assert.equal(later.workers.length, 1); await later.session.dispose();
});
test('page failures are isolated and a real retry performs another render without reusing a running task', async () => {
  const f = fixture({ manualRender: true }); await f.session.load(file); f.session.attachPage(3, {}); await tick();
  f.tasks[0].pending.reject(new Error('bad page')); await tick(); assert.equal(f.pageViews.at(-1).status, 'error');
  f.session.retryPage(3); await tick(); assert.equal(f.tasks.length, 2); f.tasks[1].pending.resolve(); await tick();
  assert.equal(f.pageViews.at(-1).status, 'ready'); await f.session.dispose();
});
test('a render that never settles or honours cancel terminates its worker before releasing the canvas', async () => {
  const f = fixture({ manualRender: true, ignoreCancel: true, sessionOptions: { renderTimeout: 5, cancelTimeout: 5, destroyTimeout: 5 } });
  await f.session.load(file); const canvas = {}; f.session.attachPage(1, canvas);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.workers[0].destroyed, true); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  assert.equal(f.views.at(-1).status, 'error'); assert.match(f.views.at(-1).error, /停止/);
  const count = f.views.length; f.tasks[0].pending.resolve(); await tick(); assert.equal(f.views.length, count);
  await f.session.dispose();
});
test('controller independently bounds mounted canvases and accepts a later page after a release', async () => {
  const f = fixture(); await f.session.load(file);
  const release = f.session.attachPage(1, {}); f.session.attachPage(2, {}); f.session.attachPage(3, {});
  assert.throws(() => f.session.attachPage(4, {}), /资源上限/); release(); f.session.attachPage(80, {});
  await tick(); assert(f.tasks.some(x => x.number === 80)); await f.session.dispose();
});
test('asset factories use exact data names and ignore late replies after cancellation', async () => {
  const calls = []; let current = true;
  const factories = createAssetFactories(async input => { calls.push(input); return new ArrayBuffer(8); }, () => current);
  const map = await new factories.CMapReaderFactory().fetch({ name: 'UniGB-UCS2-H' }); assert(map.cMapData instanceof Uint8Array); assert.equal(map.isCompressed, true);
  await new factories.StandardFontDataFactory().fetch({ filename: 'FoxitSans.pfb' });
  await new factories.WasmFactory().fetch({ filename: 'openjpeg.wasm' });
  assert.deepEqual(calls, [{ kind: 'cmap', name: 'UniGB-UCS2-H.bcmap' }, { kind: 'standard-font', name: 'FoxitSans.pfb' }, { kind: 'wasm', name: 'openjpeg.wasm' }]);
  await assert.rejects(new factories.WasmFactory().fetch({ filename: '../escape.wasm' }), /名称/);
  const pending = deferred(), stale = createAssetFactories(() => pending.promise, () => current);
  const load = new stale.StandardFontDataFactory().fetch({ filename: 'FoxitSans.pfb' }); current = false; pending.resolve(new ArrayBuffer(8)); await assert.rejects(load, /取消/);
  const invalid = createAssetFactories(() => Promise.resolve(new Uint8Array(8)), () => true); await assert.rejects(new invalid.WasmFactory().fetch({ filename: 'openjpeg.wasm' }), /数据无效/);
});
test('password, corrupt input, mismatched IPC and load timeout fail clearly without leaving a worker', async () => {
  assert.match(pdfErrorMessage({ name: 'PasswordException' }), /密码/);
  for (const name of ['PasswordException', 'InvalidPDFException']) {
    const f = fixture({ documentPromise: Promise.reject(Object.assign(new Error('unsafe path'), { name })) });
    await f.session.load(file); assert.equal(f.views.at(-1).status, 'error'); assert(!f.views.at(-1).error.includes('unsafe path')); await f.session.dispose(); assert.equal(f.workers[0].destroyed, true);
  }
  const mismatch = fixture({ readFile: input => Promise.resolve({ ...reply(input), id: 'wrong' }) }); await mismatch.session.load(file); assert.equal(mismatch.workers.length, 0);
  const timeout = fixture({ readFile: () => new Promise(() => {}), sessionOptions: { loadTimeout: 5 } }); await timeout.session.load(file); assert.match(timeout.views.at(-1).error, /时间过长/); await timeout.session.dispose();
});
