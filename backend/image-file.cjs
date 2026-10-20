'use strict';
const { readManagedBinary } = require('./managed-binary.cjs');
const { imageMime, MAX_IMAGE_FILE_BYTES } = require('./image-format.cjs');
function readManagedImage(store, input) {
  return readManagedBinary(store, input, { label: '图片', mimeForName: imageMime, maxBytes: MAX_IMAGE_FILE_BYTES, payload: 'image' });
}
module.exports = { readManagedImage };
