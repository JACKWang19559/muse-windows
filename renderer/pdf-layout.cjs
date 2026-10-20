'use strict';
const PDF_SCALE = 1.5;
const { MAX_PDF_FILE_BYTES } = require('../backend/pdf-format.cjs');
const MAX_PAGE_PIXELS = 4 * 1024 * 1024;
const MAX_CANVAS_EDGE = 4096;
const MAX_RESIDENT_PAGES = 3;
const PAGE_GAP = 20;
const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const pdfKey = file => JSON.stringify([file.id, file.name, file.sha256 || '']);
function ownedBuffer(value, limit) {
  let size;
  try { size = arrayBufferSize.call(value); } catch { throw new Error('PDF 数据无效，请重新打开。'); }
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit) throw new Error('PDF 数据无效或超过预览限制。');
  return size;
}
function validatePdfReply(file, reply) {
  const size = ownedBuffer(reply?.pdf, MAX_PDF_FILE_BYTES);
  if (reply.id !== file.id || reply.name !== file.name || reply.mimeType !== 'application/pdf' || reply.size !== size || typeof reply.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reply.sha256) || file.sha256 && file.sha256.toLowerCase() !== reply.sha256) throw new Error('PDF 副本已变化，请重新打开。');
  return new Uint8Array(reply.pdf);
}
function pagePlan(width, height, dpr = 1) {
  if (![width, height].every(x => Number.isFinite(x) && x > 0)) throw new Error('此页的尺寸无效，无法预览。');
  const nominal = PDF_SCALE;
  // Limit both display geometry and the raster; extreme dimensions must not
  // allocate a huge canvas or an effectively infinite scroll placeholder.
  const cssScale = Math.min(nominal, 8192 / width, 8192 / height);
  const cssWidth = Math.max(1, width * cssScale), cssHeight = Math.max(1, height * cssScale);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
  const scale = Math.min(cssScale * ratio, MAX_CANVAS_EDGE / width, MAX_CANVAS_EDGE / height, Math.sqrt(MAX_PAGE_PIXELS / width / height));
  const pixelWidth = Math.max(1, Math.floor(width * scale)), pixelHeight = Math.max(1, Math.floor(height * scale));
  if (!Number.isFinite(scale) || scale <= 0 || pixelWidth * pixelHeight > MAX_PAGE_PIXELS) throw new Error('此页的尺寸超出安全预览范围。');
  return { cssWidth, cssHeight, pixelWidth, pixelHeight, scale, reduced: cssScale < nominal || scale + 1e-6 < cssScale * ratio };
}
class PdfLayout {
  constructor(count, first = { width: 600, height: 780 }) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('PDF 页数无效。');
    this.count = count; this.first = first; this.sizes = new Map(); this.width = 600; this.height = 800;
  }
  resize(width, height) { this.width = Math.max(80, Number.isFinite(width) ? width - 32 : 600); this.height = Math.max(200, Number.isFinite(height) ? height : 800); }
  measure(number, width, height) { if (number >= 1 && number <= this.count && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) this.sizes.set(number, { width, height }); }
  dimensions(number) {
    const size = this.sizes.get(number) || this.first, factor = Math.min(1, this.width / size.width);
    return { width: size.width * factor, height: size.height * factor };
  }
  rowHeight(number) { return Math.max(220, this.height / 2, this.dimensions(number).height) + PAGE_GAP; }
  offset(number) {
    const defaultHeight = Math.max(220, this.height / 2, this.first.height * Math.min(1, this.width / this.first.width)) + PAGE_GAP;
    let result = (number - 1) * defaultHeight;
    for (const [index] of this.sizes) if (index < number) result += this.rowHeight(index) - defaultHeight;
    return result;
  }
  locate(position) {
    let low = 1, high = this.count;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.offset(mid) <= position) low = mid; else high = mid - 1; }
    return low;
  }
  window(scrollTop) {
    const top = Math.max(0, scrollTop), visibleStart = this.locate(top), visibleEnd = this.locate(top + this.height);
    let start = visibleStart, end = visibleEnd;
    // A row is at least viewport/2 tall, so every visible page fits in this
    // bounded window. Spare slots pre-render adjacent pages, never a first-N cap.
    if (end - start + 1 < MAX_RESIDENT_PAGES && start > 1) start--;
    if (end - start + 1 < MAX_RESIDENT_PAGES && end < this.count) end++;
    return { start, end, top: this.offset(start), bottom: Math.max(0, this.offset(this.count + 1) - this.offset(end + 1)) };
  }
}
module.exports = { PDF_SCALE, MAX_PDF_FILE_BYTES, MAX_PAGE_PIXELS, MAX_CANVAS_EDGE, MAX_RESIDENT_PAGES, PAGE_GAP, pdfKey, ownedBuffer, validatePdfReply, pagePlan, PdfLayout };
