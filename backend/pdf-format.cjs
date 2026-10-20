'use strict';
const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
function pdfMime(name) {
  return typeof name === 'string' && name.length > 4 && !/[\\/\0]/.test(name) && /\.pdf$/i.test(name) ? 'application/pdf' : null;
}
const isPdfFile = name => pdfMime(name) !== null;
module.exports = { isPdfFile, pdfMime, MAX_PDF_FILE_BYTES };
