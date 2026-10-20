'use strict';
const { pdfKey, ownedBuffer, validatePdfReply, pagePlan, MAX_PAGE_PIXELS, MAX_RESIDENT_PAGES } = require('./pdf-layout.cjs');
const { isPdfFile } = require('../backend/pdf-format.cjs');
const CANCELLED = Symbol('cancelled');
// A closed preview may still await PDF.js's Terminate acknowledgement. Share
// this set across component instances so reopening cannot accumulate workers
// behind a slow font response or an unfinished document teardown.
const retiringCleanups = new Set();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const message = error => {
  if (error?.name === 'PasswordException') return '此 PDF 需要密码，暂不支持在这里解锁；仍可下载原文件。';
  if (error?.name === 'InvalidPDFException' || error?.name === 'MissingPDFException') return 'PDF 无法解析或文件已损坏；仍可下载原文件。';
  return (typeof error?.message === 'string' ? error.message : '').replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '').trim() || '无法预览此 PDF；仍可下载原文件。';
};
function createAssetFactories(readAsset, isCurrent) {
  const bytes = async (kind, name) => {
    if (!isCurrent()) throw new Error('PDF 加载已取消。');
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(name) || name.includes('..')) throw new Error('PDF 本地资源名称无效。');
    const value = await readAsset({ kind, name });
    if (!isCurrent()) throw new Error('PDF 加载已取消。');
    ownedBuffer(value, 512 * 1024);
    return new Uint8Array(value);
  };
  return {
    CMapReaderFactory: class { async fetch({ name }) { return { cMapData: await bytes('cmap', name + '.bcmap'), isCompressed: true }; } },
    StandardFontDataFactory: class { async fetch({ filename }) { return bytes('standard-font', filename); } },
    WasmFactory: class { async fetch({ filename }) { return bytes('wasm', filename); } }
  };
}
class PdfSession {
  constructor({ pdfjs, readFile, readAsset, workerSrc, WorkerClass = globalThis.Worker, onChange = () => {}, onPage = () => {}, dpr = 1, loadTimeout = 30000, renderTimeout = 30000, cancelTimeout = 1000, destroyTimeout = 1500 }) {
    Object.assign(this, { pdfjs, readFile, readAsset, workerSrc, WorkerClass, onChange, onPage, dpr, loadTimeout, renderTimeout, cancelTimeout, destroyTimeout });
    this.epoch = 0; this.active = null; this.closed = false; this.view = null; this.retired = new Set();
  }
  current(active) { return !this.closed && this.active === active && !active.closed; }
  publish(active, patch) { if (!this.current(active)) return; this.view = { ...this.view, ...patch }; this.onChange(this.view); }
  pageState(active, entry, patch) { if (this.current(active) && !entry.closed && active.pages.get(entry.number) === entry) this.onPage(entry.number, patch); }
  async wait(promise, active, timeout) {
    let timer;
    try {
      const value = await Promise.race([promise, active.abort.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF 处理时间过长，请重试或下载原文件。')), timeout); })]);
      if (value === CANCELLED || !this.current(active)) throw CANCELLED;
      return value;
    } finally { clearTimeout(timer); }
  }
  async load(file) {
    if (this.closed) return;
    this.retire();
    const active = { epoch: ++this.epoch, abort: deferred(), closed: false, pages: new Map(), worker: null, loading: null, document: null, pumping: null };
    this.active = active; this.view = { key: pdfKey(file), status: 'loading', error: '', numPages: 0, actualWorker: false, firstSize: null }; this.onChange(this.view);
    try {
      if (!isPdfFile(file.name)) throw new Error('此文件不支持 PDF 预览。');
      const reply = await this.wait(this.readFile({ id: file.id, expectedName: file.name, ...(file.sha256 ? { expectedSha256: file.sha256 } : {}) }), active, this.loadTimeout);
      const data = validatePdfReply(file, reply);
      // Reads may proceed while an old preview closes, but constructing a new
      // worker must wait for every retiring instance. Repeat for retirements
      // added while awaiting a previous batch, with one overall deadline.
      const cleanupDeadline = Date.now() + this.loadTimeout;
      while (retiringCleanups.size) {
        await this.wait(Promise.allSettled([...retiringCleanups]), active, Math.max(1, cleanupDeadline - Date.now()));
      }
      if (!this.current(active)) throw CANCELLED;
      this.pdfjs.GlobalWorkerOptions.workerSrc = this.workerSrc;
      active.worker = new this.pdfjs.PDFWorker({ name: 'muse-local-pdf' });
      await this.wait(active.worker.promise, active, this.loadTimeout);
      if (typeof this.WorkerClass !== 'function' || !(active.worker.port instanceof this.WorkerClass)) throw new Error('无法启动独立 PDF 处理进程，请重试。');
      active.loading = this.pdfjs.getDocument({ data, worker: active.worker,
        ...createAssetFactories(this.readAsset, () => this.current(active)),
        cMapPacked: true, useWorkerFetch: false, useWasm: true, isEvalSupported: false, enableXfa: false, useSystemFonts: false,
        disableAutoFetch: true, disableRange: true, disableStream: true, stopAtErrors: true,
        canvasMaxAreaInBytes: MAX_PAGE_PIXELS * 4, verbosity: 0 });
      active.document = await this.wait(active.loading.promise, active, this.loadTimeout);
      if (!Number.isSafeInteger(active.document.numPages) || active.document.numPages < 1) throw new Error('PDF 页数无效。');
      const first = await this.wait(active.document.getPage(1), active, this.loadTimeout);
      let plan;
      try { const viewport = first.getViewport({ scale: 1 }); plan = pagePlan(viewport.width, viewport.height, this.dpr); } finally { first.cleanup(); }
      this.publish(active, { status: 'ready', numPages: active.document.numPages, actualWorker: true, firstSize: { width: plan.cssWidth, height: plan.cssHeight } });
      this.pump(active);
    } catch (error) {
      if (!this.current(active) || error === CANCELLED) return;
      this.publish(active, { status: 'error', error: message(error), numPages: 0 }); this.retire(active);
    }
  }
  attachPage(number, canvas) {
    const active = this.active;
    if (!this.current(active) || !active.document || number < 1 || number > active.document.numPages) return () => {};
    const old = active.pages.get(number); if (old) this.releasePage(active, old);
    if (active.pages.size >= MAX_RESIDENT_PAGES) throw new Error('PDF 可见页面数量超过预览资源上限。');
    canvas.width = 0; canvas.height = 0;
    const entry = { number, canvas, closed: false, queued: true, task: null, page: null };
    active.pages.set(number, entry); this.pageState(active, entry, { status: 'queued' }); this.pump(active);
    return () => this.releasePage(active, entry);
  }
  releasePage(active, entry) {
    if (entry.closed) return; entry.closed = true;
    if (active.pages.get(entry.number) === entry) active.pages.delete(entry.number);
    try { entry.task?.cancel(); } catch {}
    if (!entry.task) { entry.canvas.width = 0; entry.canvas.height = 0; }
  }
  retryPage(number) {
    const active = this.active, entry = active?.pages.get(number);
    if (!this.current(active) || !entry || entry.closed || entry.task) return;
    entry.queued = true; this.pageState(active, entry, { status: 'queued', error: '' }); this.pump(active);
  }
  pump(active) {
    if (!this.current(active) || !active.document || active.pumping) return;
    active.pumping = (async () => {
      while (this.current(active)) {
        const entry = [...active.pages.values()].find(e => !e.closed && e.queued);
        if (!entry) break; entry.queued = false;
        try {
          entry.page = await this.wait(active.document.getPage(entry.number), active, this.renderTimeout);
          if (entry.closed) continue;
          const viewport = entry.page.getViewport({ scale: 1 }), plan = pagePlan(viewport.width, viewport.height, this.dpr);
          this.pageState(active, entry, { status: 'rendering', ...plan });
          entry.canvas.width = plan.pixelWidth; entry.canvas.height = plan.pixelHeight;
          entry.task = entry.page.render({ canvas: entry.canvas, viewport: entry.page.getViewport({ scale: plan.scale }), background: 'rgb(255,255,255)' });
          await this.wait(entry.task.promise, active, this.renderTimeout);
          this.pageState(active, entry, { status: 'ready', ...plan });
        } catch (error) {
          if (error !== CANCELLED && !entry.closed && error?.name !== 'RenderingCancelledException') this.pageState(active, entry, { status: 'error', error: '此页无法绘制。文件可能损坏或包含暂不支持的内容；仍可下载原文件。' });
          if (entry.task) { try { entry.task.cancel(); } catch {} }
        } finally {
          // PDF.js cancel rejects its render promise. Wait for settlement before
          // clearing that canvas, so a retired task cannot draw into a new one.
          if (entry.task) {
            let timer, settled;
            try { settled = await Promise.race([entry.task.promise.then(() => true, () => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.cancelTimeout); })]); }
            finally { clearTimeout(timer); }
            if (!settled) {
              // A misbehaving task must not retain an offscreen canvas or draw
              // after it is cleared. Terminate its owning worker before release.
              try { active.worker?.destroy(); } catch {}
              this.publish(active, { status: 'error', error: 'PDF 绘制未能及时停止，请重新打开；仍可下载原文件。', numPages: 0 });
              this.retire(active);
            }
          }
          entry.task = null; try { entry.page?.cleanup(); } catch {} entry.page = null;
          if (entry.closed || !this.current(active)) { entry.canvas.width = 0; entry.canvas.height = 0; }
        }
      }
    })().finally(() => { active.pumping = null; if (this.current(active) && [...active.pages.values()].some(e => e.queued && !e.closed)) this.pump(active); });
    active.pumping.catch(() => {});
  }
  retire(active = this.active) {
    if (!active || active.closed) return;
    active.closed = true; active.abort.resolve(CANCELLED);
    for (const entry of active.pages.values()) this.releasePage(active, entry);
    const cleanup = (async () => {
      let timer;
      try { await Promise.race([Promise.resolve().then(() => active.loading?.destroy()).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, this.destroyTimeout); })]); }
      finally { clearTimeout(timer); try { active.worker?.destroy(); } catch {} }
      await active.pumping;
      active.document = null; active.loading = null; active.worker = null;
    })();
    this.retired.add(cleanup); retiringCleanups.add(cleanup);
    cleanup.finally(() => { this.retired.delete(cleanup); retiringCleanups.delete(cleanup); }).catch(() => {});
    return cleanup;
  }
  dispose() { if (!this.closed) { this.closed = true; this.retire(); } return Promise.allSettled([...this.retired]); }
}
module.exports = { PdfSession, createAssetFactories, pdfErrorMessage: message };
