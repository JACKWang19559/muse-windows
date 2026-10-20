'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { imageMime, MAX_IMAGE_FILE_BYTES } = require('./image-format.cjs');

function request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('图片参数无效。');
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !['id', 'expectedName', 'expectedSha256'].includes(key) || !Object.hasOwn(fields[key], 'value'))) throw new Error('图片参数包含不支持的字段。');
  const id = fields.id?.value, name = fields.expectedName?.value, digest = fields.expectedSha256?.value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('图片标识无效。');
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\0')) throw new Error('请重新打开图片。');
  if (digest !== undefined && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest))) throw new Error('图片校验值无效。');
  return { id, name, digest: digest?.toLowerCase() };
}

function readManagedImage(store, input) {
  const selected = request(input), file = store.getFile(selected.id);
  if (file.name !== selected.name) throw new Error('文件名已变化，请重新打开图片。');
  const mimeType = imageMime(file.name);
  if (!mimeType) throw new Error('此文件格式不支持内置图片预览。');
  let fd, bytes;
  try {
    fd = fs.openSync(store.filePath(file.id), 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_FILE_BYTES) throw new Error('图片不是普通文件，或超过 25 MiB。');
    const chunks = [], buffer = Buffer.alloc(64 * 1024); let size = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, MAX_IMAGE_FILE_BYTES + 1 - size), null);
      if (!count) break;
      size += count;
      if (size > MAX_IMAGE_FILE_BYTES) throw new Error('图片超过 25 MiB。');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    bytes = Buffer.concat(chunks, size);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== file.size || file.sha256 && file.sha256 !== digest || selected.digest && selected.digest !== digest) throw new Error('图片副本已变化，请重新导入或重新打开。');
    return { id: file.id, name: file.name, mimeType, size, sha256: digest, image: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  } catch (error) {
    if (error?.code) throw new Error('无法读取工作台中的图片副本。');
    throw error;
  } finally { bytes?.fill(0); if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { readManagedImage };
