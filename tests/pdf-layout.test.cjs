'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { pagePlan, PdfLayout, MAX_PAGE_PIXELS, MAX_CANVAS_EDGE, MAX_RESIDENT_PAGES, validatePdfReply } = require('../renderer/pdf-layout.cjs');

test('ordinary PDF geometry keeps the nominal1.5 scale; high DPR and huge pages obey the raster budget', () => {
  assert.deepEqual(pagePlan(400, 500, 1), { cssWidth: 600, cssHeight: 750, pixelWidth: 600, pixelHeight: 750, scale: 1.5, reduced: false });
  for (const [width, height, dpr] of [[595, 842, 4], [20000, 20000, 3], [1, 1e9, 2], [1e9, 1, 1]]) {
    const p = pagePlan(width, height, dpr);
    assert(p.pixelWidth * p.pixelHeight <= MAX_PAGE_PIXELS);
    assert(p.pixelWidth <= MAX_CANVAS_EDGE && p.pixelHeight <= MAX_CANVAS_EDGE);
    assert(p.cssWidth <= 8192 && p.cssHeight <= 8192);
    assert(p.reduced);
  }
  for (const pair of [[0, 4], [-1, 4], [Infinity, 1], [NaN, 9]]) assert.throws(() => pagePlan(...pair), /尺寸/);
});
test('virtual PDF layout reaches every late page while retaining all visible rows and at most three canvases', () => {
  const layout = new PdfLayout(800, { width: 600, height: 750 }); layout.resize(1000, 850);
  for (const number of [1, 2, 400, 799, 800]) {
    const position = layout.offset(number), range = layout.window(position);
    assert(number >= range.start && number <= range.end);
    assert(range.end - range.start + 1 <= MAX_RESIDENT_PAGES);
    assert(range.start <= layout.locate(position) && range.end >= layout.locate(position + layout.height));
  }
  layout.measure(400, 200, 30); layout.measure(401, 500, 8000);
  for (let at = layout.offset(399); at < layout.offset(403); at += 71) {
    const range = layout.window(at);
    assert(range.end - range.start + 1 <= MAX_RESIDENT_PAGES);
    assert(range.end >= layout.locate(at + layout.height));
  }
  assert(layout.window(layout.offset(800)).bottom === 0);
});
test('PDF IPC validation accepts genuine cross-realm ArrayBuffers and rejects spoofing, tampering and oversized payloads', () => {
  const file = { id: 'pdf1', name: 'owned.pdf', sha256: 'a'.repeat(64) };
  const reply = { ...file, mimeType: 'application/pdf', size: 8, pdf: vm.runInNewContext('new ArrayBuffer(8)') };
  assert.equal(validatePdfReply(file, reply).byteLength, 8);
  for (const patch of [{ pdf: { byteLength: 8, [Symbol.toStringTag]: 'ArrayBuffer' } }, { pdf: new Uint8Array(8) }, { pdf: new SharedArrayBuffer(8) }, { size: 9 }, { name: 'else.pdf' }, { sha256: 'b'.repeat(64) }, { mimeType: 'image/png' }, { pdf: new ArrayBuffer(25 * 1024 * 1024 + 1) }]) assert.throws(() => validatePdfReply(file, { ...reply, ...patch }));
});
