'use strict';
const { isImageFile } = require('./image-format.cjs');
const MAX_VIDEO_FILE_BYTES = 25 * 1024 * 1024;
// These are filename declarations. Browser support depends on the actual codec.
const VIDEO_MIMES = Object.freeze({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska' });
function videoMime(name) {
  const extension = typeof name === 'string' ? /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() : '';
  return Object.hasOwn(VIDEO_MIMES, extension || '') ? VIDEO_MIMES[extension] : null;
}
const isVideoFile = name => videoMime(name) !== null;
const isPreviewMediaFile = name => isImageFile(name) || isVideoFile(name);
module.exports = { VIDEO_MIMES, MAX_VIDEO_FILE_BYTES, videoMime, isVideoFile, isPreviewMediaFile };
