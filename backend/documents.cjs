'use strict';

const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const TEXT_EXTENSIONS = new Set('txt md markdown mdx csv tsv json jsonl ndjson yaml yml toml ini cfg conf log xml html htm css scss sass less js jsx cjs mjs ts tsx py pyw rb rs go java c h cpp hpp cc cs swift kt kts sql sh bash zsh ps1 bat cmd r lua vue svelte graphql gql env properties dockerfile gitignore'.split(' '));
const MIME = { md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', jsonl: 'application/x-ndjson', html: 'text/html', htm: 'text/html', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function extension(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext || path.basename(name).replace(/^\./, '').toLowerCase();
}

function describeFile(name) {
  const ext = extension(name);
  return { ext, mime: MIME[ext] || (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream'), managedExtension: TEXT_EXTENSIONS.has(ext) || ext === 'docx' || ext === 'pdf' || ext === 'xlsx' ? ext : 'bin' };
}

function trimText(text) {
  const clean = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  return { text: clean.slice(0, MAX_TEXT_CHARS), truncated: clean.length > MAX_TEXT_CHARS };
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const controlCount = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  if (controlCount > Math.max(2, text.length / 100)) throw new Error('文件内容看起来是二进制，无法按文本读取。');
  return text;
}

// Inspect the ZIP directory before handing DOCX bytes to a parser. No archive
// member is written to disk and external document relationships are not opened.
function validateDocxZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('DOCX 压缩目录无效。');
  const count = buffer.readUInt16LE(end + 10);
  const directoryBytes = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16), expanded = 0;
  if (count > 10000 || offset + directoryBytes > end) throw new Error('DOCX 压缩目录超出限制。');
  let hasDocument = false;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('DOCX 压缩目录损坏。');
    const flags = buffer.readUInt16LE(offset + 8);
    const bytes = buffer.readUInt32LE(offset + 24);
    const nameBytes = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extra + comment;
    if (next > buffer.length || flags & 1 || bytes === 0xffffffff) throw new Error('不支持加密或超大 DOCX 文件。');
    const name = buffer.subarray(offset + 46, offset + 46 + nameBytes).toString('utf8');
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('DOCX 包含不安全的成员路径。');
    hasDocument ||= name === 'word/document.xml';
    expanded += bytes;
    if (expanded > 80 * 1024 * 1024) throw new Error('DOCX 解压后的内容过大。');
    offset = next;
  }
  if (!hasDocument) throw new Error('文件不是有效的 DOCX 文档。');
}

function xmlText(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('不支持带有实体声明的 DOCX 文档。');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = text => text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (all, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()];
    const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
  let result = '';
  const token = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>|<(?:[A-Za-z_][\w.-]*:)?(tab|br|cr)\b[^>]*\/>|<\/(?:[A-Za-z_][\w.-]*:)?p\s*>/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] != null) result += decode(match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'));
    else result += match[2] === 'tab' ? '\t' : '\n';
    if (result.length > MAX_TEXT_CHARS) break;
  }
  return result;
}

async function extractDocument(buffer, name) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_FILE_BYTES) throw new Error('单个文件不能超过 25 MB。');
  const { ext, mime } = describeFile(name);
  let text;
  try {
    if (TEXT_EXTENSIONS.has(ext)) text = decodeText(buffer);
    else if(ext==='xlsx'){
      const extracted=await require('./spreadsheet-text.cjs').extractSpreadsheetText(buffer);
      return {mime,textStatus:'ready',text:extracted.text,truncated:extracted.truncated};
    }
    else if (ext === 'docx') {
      validateDocxZip(buffer);
      let unzipSync;
      try { ({ unzipSync } = require('fflate')); } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return { mime, textStatus: 'unsupported', text: '', truncated: false, error: '此安装尚未包含 DOCX 文本提取组件。' };
        throw error;
      }
      const allowed = new Set(['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']);
      const documents = unzipSync(new Uint8Array(buffer), { filter: entry => {
        if (!allowed.has(entry.name)) return false;
        if (entry.originalSize > 8 * 1024 * 1024) throw new Error('DOCX 文本内容过大。');
        return true;
      } });
      text = [...allowed].filter(name => documents[name]).map(name => {
        if (documents[name].byteLength > 8 * 1024 * 1024) throw new Error('DOCX 文本内容过大。');
        return xmlText(new TextDecoder('utf-8', { fatal: true }).decode(documents[name]));
      }).join('\n');
    } else if (ext === 'pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件不是有效的 PDF 文档。');
      let pdf;
      try { pdf = require('pdf-parse'); } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return { mime, textStatus: 'unsupported', text: '', truncated: false, error: '此安装尚未包含 PDF 文本提取组件。' };
        throw error;
      }
      if (typeof pdf.PDFParse === 'function') {
        const parser = new pdf.PDFParse({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0, useSystemFonts: false });
        try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
      } else if (typeof pdf === 'function') text = (await pdf(buffer)).text;
      else throw new Error('PDF 文本提取组件接口不兼容。');
      if (!String(text || '').trim()) return { mime, textStatus: 'unsupported', text: '', truncated: false, error: 'PDF 没有可提取的文字，扫描件需要先进行 OCR。' };
    } else return { mime, textStatus: 'unsupported', text: '', truncated: false, error: '此格式暂不支持提取文字；附件仅保存为本地副本。' };
    return { mime, textStatus: 'ready', ...trimText(text) };
  } catch (error) {
    // Do not expose parser internals, relationship targets or source paths.
    const message = TEXT_EXTENSIONS.has(ext) ? '文本编码或内容无效；请使用 UTF-8 或带 BOM 的 UTF-16 文件。' : ext === 'xlsx' ? 'Excel 文字提取失败，文件可能损坏、加密或超出限制。' : ext === 'pdf' ? 'PDF 文字提取失败，文件可能损坏、加密或不受支持。' : 'DOCX 文字提取失败，文件可能损坏、加密或超出限制。';
    return { mime, textStatus: 'error', text: '', truncated: false, error: message };
  }
}

module.exports = { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEXT_EXTENSIONS, describeFile, extractDocument };
