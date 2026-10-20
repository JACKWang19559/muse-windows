'use strict';
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
// A declared image type is not a promise that the installed browser can decode it.
const IMAGE_MIMES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif' });
function imageMime(name) {
  const extension = typeof name === 'string' ? /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() : '';
  return Object.hasOwn(IMAGE_MIMES, extension || '') ? IMAGE_MIMES[extension] : null;
}
const isImageFile = name => imageMime(name) !== null;
module.exports = { IMAGE_MIMES, MAX_IMAGE_FILE_BYTES, imageMime, isImageFile };
