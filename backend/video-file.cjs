'use strict';
const { readManagedBinary } = require('./managed-binary.cjs');
const { videoMime, MAX_VIDEO_FILE_BYTES } = require('./video-format.cjs');
function readManagedVideo(store, input) {
  return readManagedBinary(store, input, { label: '视频', mimeForName: videoMime, maxBytes: MAX_VIDEO_FILE_BYTES, payload: 'video' });
}
module.exports = { readManagedVideo };
