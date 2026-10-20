'use strict';
const { readManagedBinary } = require('./managed-binary.cjs');
const { pdfMime, MAX_PDF_FILE_BYTES } = require('./pdf-format.cjs');
function readManagedPdf(store, input) {
  return readManagedBinary(store, input, { label: 'PDF', mimeForName: pdfMime, maxBytes: MAX_PDF_FILE_BYTES, payload: 'pdf' });
}
module.exports = { readManagedPdf };
