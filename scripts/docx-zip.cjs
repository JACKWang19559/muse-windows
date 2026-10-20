'use strict';

// Independent browser/Node ZIP preflight. This module performs no I/O, extracts
// no files and retains no expanded member. It is not an OOXML/XML validator.
const { Inflate } = require('fflate');
const MAX_DOCX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 4096;
const MAX_DOCX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;
const INFLATE_CHUNK_BYTES = 256;
const ARRAY_BYTES = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const TYPED = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_TAG = Object.getOwnPropertyDescriptor(TYPED, Symbol.toStringTag).get;
const TYPED_BUFFER = Object.getOwnPropertyDescriptor(TYPED, 'buffer').get;
const TYPED_OFFSET = Object.getOwnPropertyDescriptor(TYPED, 'byteOffset').get;
const TYPED_BYTES = Object.getOwnPropertyDescriptor(TYPED, 'byteLength').get;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

class DocxZipError extends Error {
  constructor(code) { super('DOCX ZIP validation failed.'); this.name = 'DocxZipError'; this.code = code; }
}
const fail = code => { throw new DocxZipError(code); };
const need = (condition, code = 'invalid_zip') => { if (!condition) fail(code); };
function snapshot(input) {
  let buffer, offset = 0, length;
  try {
    if (ArrayBuffer.isView(input)) {
      need(TYPED_TAG.call(input) === 'Uint8Array', 'invalid_input');
      buffer = TYPED_BUFFER.call(input); offset = TYPED_OFFSET.call(input); length = TYPED_BYTES.call(input);
      ARRAY_BYTES.call(buffer); // Reject SharedArrayBuffer even for a valid view.
    } else { buffer = input; length = ARRAY_BYTES.call(input); }
    need(length <= MAX_DOCX_INPUT_BYTES, 'input_limit'); need(length >= 22, 'invalid_zip');
    return new Uint8Array(buffer, offset, length).slice();
  } catch (error) { if (error instanceof DocxZipError) throw error; fail('invalid_input'); }
}
function updateCRC(crc, bytes) { for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return crc >>> 0; }
function extras(view, start, length) {
  const end = start + length;
  while (start < end) {
    need(end - start >= 4); const id = view.getUint16(start, true), size = view.getUint16(start + 2, true); start += 4; need(size <= end - start);
    need(id !== 0x0001 && id !== 0x7075 && id !== 0x9901, 'unsupported_zip'); start += size;
  }
}
function memberName(raw, flags) {
  need(raw.length > 0, 'invalid_name');
  if (!(flags & 0x800)) need(raw.every(value => value < 128), 'unsupported_name_encoding');
  let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('invalid_name'); }
  need(name && !/[\u0000-\u001f\u007f\\:]/u.test(name) && !name.startsWith('/'), 'invalid_name');
  const directory = name.endsWith('/'), parts = (directory ? name.slice(0, -1) : name).split('/'), keys = [];
  for (const part of parts) {
    let decoded; try { decoded = decodeURIComponent(part); } catch { fail('invalid_name'); }
    need(part && decoded && decoded !== '.' && decoded !== '..' && !/[\u0000-\u001f\u007f/\\:]/u.test(decoded), 'invalid_name');
    keys.push(decoded.normalize('NFC').toLowerCase());
  }
  return { name, directory, key: keys.join('/') };
}
function parse(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = bytes.length;
  let end = -1;
  for (let i = length - 22; i >= Math.max(0, length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === length) { end = i; break; }
  need(end >= 0); need(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0, 'unsupported_zip');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  need(count > 0 && count !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff, 'unsupported_zip');
  need(count <= MAX_DOCX_ENTRIES, 'entry_limit'); need(view.getUint16(end + 8, true) === count, 'unsupported_zip');
  need(directoryOffset <= end && directorySize === end - directoryOffset);
  const entries = [], names = new Map(); let offset = directoryOffset, expanded = 0;
  for (let i = 0; i < count; i++) {
    need(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50);
    const version = view.getUint16(offset + 6, true), flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), crc32 = view.getUint32(offset + 16, true), compressedSize = view.getUint32(offset + 20, true), expandedSize = view.getUint32(offset + 24, true), nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true), localOffset = view.getUint32(offset + 42, true);
    need(version <= 20 && view.getUint16(offset + 34, true) === 0 && (flags & ~0x80e) === 0 && (method === 0 || method === 8) && (method !== 0 || (flags & 6) === 0), 'unsupported_zip');
    need(compressedSize !== 0xffffffff && expandedSize !== 0xffffffff && localOffset !== 0xffffffff, 'unsupported_zip');
    need(expandedSize <= MAX_DOCX_ENTRY_BYTES, 'entry_size_limit'); expanded += expandedSize; need(expanded <= MAX_DOCX_EXPANDED_BYTES, 'expanded_limit');
    need(method !== 8 || compressedSize > 0); need(method !== 0 || compressedSize === expandedSize);
    const next = offset + 46 + nameSize + extraSize + commentSize; need(next <= end); extras(view, offset + 46 + nameSize, extraSize);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameSize), info = memberName(rawName, flags), mode = view.getUint32(offset + 38, true) >>> 16, type = mode & 0xf000, dosDirectory = (view.getUint32(offset + 38, true) & 0x10) !== 0;
    need(type === 0 || type === 0x8000 || type === 0x4000, 'unsupported_zip'); need((type !== 0x4000 && !dosDirectory || info.directory) && (type !== 0x8000 || !info.directory), 'invalid_name');
    need(!info.directory || expandedSize === 0); need(!names.has(info.key), 'duplicate_name'); names.set(info.key, info.directory);
    entries.push({ ...info, version, flags, compressionMethod: method, crc32, compressedSize, expandedSize, localOffset, rawName }); offset = next;
  }
  need(offset === end);
  for (const [name] of names) { const parts = name.split('/'); parts.pop(); while (parts.length) { need(names.get(parts.join('/')) !== false, 'invalid_name'); parts.pop(); } }
  const physical = [...entries].sort((a, b) => a.localOffset - b.localOffset); need(physical[0].localOffset === 0);
  for (let i = 0; i < physical.length; i++) {
    const entry = physical[i], start = entry.localOffset, boundary = physical[i + 1]?.localOffset ?? directoryOffset;
    need(start + 30 <= boundary && boundary <= directoryOffset && view.getUint32(start, true) === 0x04034b50, 'record_overlap');
    need(view.getUint16(start + 4, true) === entry.version && view.getUint16(start + 6, true) === entry.flags && view.getUint16(start + 8, true) === entry.compressionMethod, 'header_mismatch');
    const localCRC = view.getUint32(start + 14, true), localCompressed = view.getUint32(start + 18, true), localExpanded = view.getUint32(start + 22, true), nameSize = view.getUint16(start + 26, true), extraSize = view.getUint16(start + 28, true), dataOffset = start + 30 + nameSize + extraSize, dataEnd = dataOffset + entry.compressedSize;
    need(dataOffset <= boundary && dataEnd <= boundary, 'record_overlap'); need(nameSize === entry.rawName.length && bytes.subarray(start + 30, start + 30 + nameSize).every((value, index) => value === entry.rawName[index]), 'header_mismatch'); extras(view, start + 30 + nameSize, extraSize);
    if (entry.flags & 8) {
      need((localCRC === 0 || localCRC === entry.crc32) && (localCompressed === 0 || localCompressed === entry.compressedSize) && (localExpanded === 0 || localExpanded === entry.expandedSize), 'header_mismatch');
      const descriptorBytes = boundary - dataEnd; need(descriptorBytes === 12 || descriptorBytes === 16, 'descriptor_mismatch'); let descriptor = dataEnd;
      if (descriptorBytes === 16) { need(view.getUint32(descriptor, true) === 0x08074b50, 'descriptor_mismatch'); descriptor += 4; }
      need(view.getUint32(descriptor, true) === entry.crc32 && view.getUint32(descriptor + 4, true) === entry.compressedSize && view.getUint32(descriptor + 8, true) === entry.expandedSize, 'descriptor_mismatch');
    } else need(dataEnd === boundary && localCRC === entry.crc32 && localCompressed === entry.compressedSize && localExpanded === entry.expandedSize, 'header_mismatch');
    entry.dataOffset = dataOffset;
  }
  return { entries, expanded };
}

// Validate raw DEFLATE framing without producing an expanded copy. This also
// rejects truncated/trailing streams and known expansion overruns before the
// streaming inflater allocates output. CRC is still checked on actual output.
function deflateSize(data, expected) {
  let bit = 0, output = 0;
  const bits = count => { need(bit + count <= data.length * 8, 'invalid_deflate'); let value = 0; for (let i = 0; i < count; i++, bit++) value |= (data[bit >>> 3] >>> (bit & 7) & 1) << i; return value; };
  const add = count => { output += count; need(output <= MAX_DOCX_ENTRY_BYTES, 'entry_size_limit'); need(output <= expected, 'expanded_size_mismatch'); };
  const tree = lengths => { const counts = new Uint16Array(16); let max = 0; for (const length of lengths) { need(length >= 0 && length <= 15, 'invalid_deflate'); if (length) { counts[length]++; max = Math.max(max, length); } } let remaining = 1; for (let i = 1; i <= 15; i++) { remaining = remaining * 2 - counts[i]; need(remaining >= 0, 'invalid_deflate'); } const symbols = []; for (let length = 1; length <= max; length++) for (let i = 0; i < lengths.length; i++) if (lengths[i] === length) symbols.push(i); return { counts, symbols, max }; };
  const symbol = t => { let code = 0, first = 0, index = 0; for (let length = 1; length <= t.max; length++) { code = code * 2 + bits(1); const count = t.counts[length]; if (code >= first && code < first + count) return t.symbols[index + code - first]; index += count; first = (first + count) * 2; } fail('invalid_deflate'); };
  const lengthBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258], lengthExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0], distanceBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577], distanceExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  let last, fixed;
  do {
    last = bits(1); const kind = bits(2); need(kind !== 3, 'invalid_deflate');
    if (kind === 0) { bit = (bit + 7) & ~7; const length = bits(16), inverse = bits(16); need((length ^ inverse) === 0xffff && bit + length * 8 <= data.length * 8, 'invalid_deflate'); add(length); bit += length * 8; continue; }
    let literals, distances;
    if (kind === 1) { fixed ||= { literals: tree(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)), distances: tree(Array(32).fill(5)) }; literals = fixed.literals; distances = fixed.distances; }
    else {
      const literalCount = bits(5) + 257, distanceCount = bits(5) + 1, codeCount = bits(4) + 4; need(literalCount <= 286, 'invalid_deflate');
      const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15], codeLengths = Array(19).fill(0); // RFC1951 code-length order.
      for (let i = 0; i < codeCount; i++) codeLengths[order[i]] = bits(3);
      const codes = tree(codeLengths), lengths = [];
      while (lengths.length < literalCount + distanceCount) {
        const s = symbol(codes); if (s < 16) lengths.push(s); else { need(s <= 18 && (s !== 16 || lengths.length > 0), 'invalid_deflate'); const count = s === 16 ? bits(2) + 3 : s === 17 ? bits(3) + 3 : bits(7) + 11, value = s === 16 ? lengths[lengths.length - 1] : 0; need(lengths.length + count <= literalCount + distanceCount, 'invalid_deflate'); for (let i = 0; i < count; i++) lengths.push(value); }
      }
      need(lengths[256] !== 0, 'invalid_deflate'); literals = tree(lengths.slice(0, literalCount)); distances = tree(lengths.slice(literalCount));
    }
    for (;;) { const s = symbol(literals); if (s < 256) add(1); else if (s === 256) break; else { need(s <= 285, 'invalid_deflate'); const index = s - 257, length = lengthBase[index] + bits(lengthExtra[index]), distanceCode = symbol(distances); need(distanceCode < 30, 'invalid_deflate'); const distance = distanceBase[distanceCode] + bits(distanceExtra[distanceCode]); need(distance <= output, 'invalid_deflate'); add(length); } }
  } while (!last);
  need(Math.ceil(bit / 8) === data.length, 'invalid_deflate'); need(output === expected, 'expanded_size_mismatch'); return output;
}
function verifyEntry(bytes, entry) {
  const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize); let actual = 0, crc = 0xffffffff;
  const accept = chunk => { actual += chunk.length; need(actual <= MAX_DOCX_ENTRY_BYTES, 'entry_size_limit'); need(actual <= entry.expandedSize, 'expanded_size_mismatch'); crc = updateCRC(crc, chunk); };
  if (entry.compressionMethod === 0) for (let i = 0; i < data.length; i += INFLATE_CHUNK_BYTES) accept(data.subarray(i, i + INFLATE_CHUNK_BYTES));
  else {
    deflateSize(data, entry.expandedSize); let final = false;
    try { const inflate = new Inflate((chunk, done) => { accept(chunk); final ||= done; }); for (let i = 0; i < data.length; i += INFLATE_CHUNK_BYTES) inflate.push(data.subarray(i, i + INFLATE_CHUNK_BYTES), i + INFLATE_CHUNK_BYTES >= data.length); }
    catch (error) { if (error instanceof DocxZipError) throw error; fail('invalid_deflate'); }
    need(final, 'invalid_deflate');
  }
  need(actual === entry.expandedSize, 'expanded_size_mismatch'); need(((crc ^ 0xffffffff) >>> 0) === entry.crc32, 'crc_mismatch'); return actual;
}
function validateDocxPreviewZip(input) {
  const bytes = snapshot(input), { entries, expanded } = parse(bytes); let actual = 0;
  for (const entry of entries) { actual += verifyEntry(bytes, entry); need(actual <= MAX_DOCX_EXPANDED_BYTES, 'expanded_limit'); }
  return { inputBytes: bytes.length, entryCount: entries.length, declaredExpandedBytes: expanded, actualExpandedBytes: actual, entries: entries.map(entry => ({ name: entry.name, directory: entry.directory, compressionMethod: entry.compressionMethod, compressedSize: entry.compressedSize, expandedSize: entry.expandedSize, crc32: entry.crc32 })) };
}
module.exports = { validateDocxPreviewZip, DocxZipError, MAX_DOCX_INPUT_BYTES, MAX_DOCX_ENTRIES, MAX_DOCX_ENTRY_BYTES, MAX_DOCX_EXPANDED_BYTES, INFLATE_CHUNK_BYTES };
