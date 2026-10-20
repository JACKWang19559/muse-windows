'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MAX_FILE_BYTES, TEXT_EXTENSIONS, describeFile } = require('./documents.cjs');

function request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('下载参数无效。');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !['id', 'content'].includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('下载包含不支持的参数。');
  const id = descriptors.id?.value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('文件标识无效。');
  const draft = Object.hasOwn(descriptors, 'content');
  const content = descriptors.content?.value;
  if (draft && (typeof content !== 'string' || content.length > MAX_FILE_BYTES)) throw new Error('下载草稿须为 25 MB 以内的文本。');
  return { id, draft, content };
}

function exportName(name) {
  let value = path.basename(name).replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_').replace(/[. ]+$/, '').slice(0, 240) || 'Muse 文件';
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) value = '_' + value;
  return value;
}

// Capture bytes before opening the picker. A dirty draft is independent of the
// managed file's current revision; downloading it must not attempt Save/CAS.
function captureFileExport(store, input) {
  const selected = request(input), file = store.getFile(selected.id);
  let bytes;
  if (selected.draft) {
    if (!TEXT_EXTENSIONS.has(describeFile(file.name).ext)) throw new Error('此文件只能下载原始副本。');
    bytes = Buffer.from(selected.content, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw new Error('下载草稿超过 25 MB。');
  } else {
    let fd;
    try {
      fd = fs.openSync(store.filePath(selected.id), 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('文件不是普通文件，或超过 25 MB。');
      const chunks = [], buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, MAX_FILE_BYTES + 1 - size), null);
        if (!count) break;
        size += count;
        if (size > MAX_FILE_BYTES) throw new Error('文件超过 25 MB。');
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      if (error?.code) throw new Error('无法读取工作台中的文件副本。');
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { name: exportName(file.name), bytes, draft: selected.draft };
}

function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function destination(store, selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('请选择有效的下载位置。');
  const parent = fs.realpathSync(path.dirname(selected));
  const target = path.join(parent, path.basename(selected));
  if (within(fs.realpathSync(store.dataDir), target)) throw new Error('请选择工作台数据目录以外的位置，下载不会替代文件保存。');
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载位置必须是普通文件，不能是文件链接。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

async function exportManagedFile({ store, input, chooseDestination }) {
  const captured = captureFileExport(store, input);
  const choice = await chooseDestination(captured.name);
  if (choice?.canceled || !choice?.filePath) return { cancelled: true };
  let temporary;
  try {
    const target = destination(store, choice.filePath);
    temporary = path.join(path.dirname(target), '.muse-download-' + require('node:crypto').randomUUID() + '.tmp');
    fs.writeFileSync(temporary, captured.bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    temporary = null;
    return { cancelled: false, name: captured.name, size: captured.bytes.length, draft: captured.draft };
  } catch (error) {
    if (error?.code) throw new Error('无法写入下载副本，请检查目标文件是否被占用或缺少权限。');
    throw error;
  } finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}

module.exports = { captureFileExport, exportManagedFile, exportName };
