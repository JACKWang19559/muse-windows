'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deflateSync, zipSync, strToU8, Inflate } = require('fflate');
const { validateDocxPreviewZip: validate, DocxZipError, MAX_DOCX_INPUT_BYTES, MAX_DOCX_ENTRIES, MAX_DOCX_ENTRY_BYTES, MAX_DOCX_EXPANDED_BYTES, INFLATE_CHUNK_BYTES } = require('../scripts/docx-zip.cjs');

// Owned ZIP constructor. Each member contains synthetic bytes only. This also
// permits exact metadata faults which ordinary ZIP writers will not produce.
function crc32(data) { let crc = 0xffffffff; for (const value of data) { crc ^= value; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function fixture(items, options = {}) {
  const locals = [], members = []; let offset = options.preamble?.length || 0;
  if (offset) locals.push(Buffer.from(options.preamble));
  for (const item of items) {
    const data = Buffer.from(item.data || []), name = Buffer.from(item.name), localName = Buffer.from(item.localName ?? item.name), method = item.method ?? 0, compressed = Buffer.from(item.compressed ?? (method === 8 ? deflateSync(data) : data)), expanded = item.expandedSize ?? data.length, crc = item.crc32 ?? crc32(data), flags = item.flags ?? ((item.descriptor ? 8 : 0) | (/[^\x00-\x7f]/.test(item.name) ? 0x800 : 0)), localExtra = Buffer.from(item.localExtra || []), centralExtra = Buffer.from(item.centralExtra || []);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(item.localFlags ?? flags, 6); header.writeUInt16LE(item.localMethod ?? method, 8);
    if (!item.descriptor || item.localExact) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(expanded, 22); }
    header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(localExtra.length, 28);
    const descriptor = item.descriptor ? Buffer.alloc(item.descriptor === 'signed' ? 16 : 12) : Buffer.alloc(0); if (descriptor.length) { const start = descriptor.length === 16 ? 4 : 0; if (start) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, start); descriptor.writeUInt32LE(compressed.length, start + 4); descriptor.writeUInt32LE(expanded, start + 8); }
    const localOffset = offset, dataOffset = offset + header.length + localName.length + localExtra.length;
    const local = Buffer.concat([header, localName, localExtra, compressed, descriptor]); locals.push(local); offset += local.length;
    members.push({ item, name, method, flags, compressed, expanded, crc, centralExtra, localOffset, dataOffset, descriptorOffset: dataOffset + compressed.length });
  }
  const directoryOffset = offset, central = [];
  for (const member of members) {
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(member.flags, 8); header.writeUInt16LE(member.method, 10); header.writeUInt32LE(member.crc, 16); header.writeUInt32LE(member.compressed.length, 20); header.writeUInt32LE(member.expanded, 24); header.writeUInt16LE(member.name.length, 28); header.writeUInt16LE(member.centralExtra.length, 30); header.writeUInt32LE(member.item.externalAttributes ?? 0, 38); header.writeUInt32LE(member.localOffset, 42);
    member.centralOffset = offset; const record = Buffer.concat([header, member.name, member.centralExtra]); central.push(record); offset += record.length;
  }
  const comment = Buffer.from(options.comment || []), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(offset - directoryOffset, 12); end.writeUInt32LE(directoryOffset, 16); end.writeUInt16LE(comment.length, 20);
  return { bytes: Buffer.concat([...locals, ...central, end, comment]), members, directoryOffset, endOffset: offset };
}
function rejected(bytes, code) { assert.throws(() => validate(bytes), error => error instanceof DocxZipError && (!code || error.code === code) && !/word\/|secret|private/.test(error.message)); }
function mutate(archive, change) { const bytes = Buffer.from(archive.bytes); change(bytes, archive); return bytes; }
function extra(id, body = []) { const bytes = Buffer.alloc(4 + body.length); bytes.writeUInt16LE(id); bytes.writeUInt16LE(body.length, 2); Buffer.from(body).copy(bytes, 4); return bytes; }
function pseudoRandom(length) { const data = Buffer.alloc(length); let state = 0x12345678; for (let i = 0; i < length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; data[i] = state & 255; } return data; }

test('DOCX ZIP accepts actual stored and deflated bytes plus directory entries with CRC metadata', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const archive = fixture([{ name: 'word/', data: [] }, { name: 'word/document.xml', data: '<document>owned text</document>', method: 8 }, { name: 'word/media/中文.txt', data: 'owned unicode path' }]), before = Buffer.from(archive.bytes), result = validate(archive.bytes);
  assert.equal(result.entryCount, 3); assert.equal(result.inputBytes, archive.bytes.length); assert.equal(result.actualExpandedBytes, result.declaredExpandedBytes); assert.equal(result.entries[0].directory, true); assert.equal(result.entries[1].compressionMethod, 8); assert.deepEqual(archive.bytes, before); assert(result.entries.every(entry => !Object.values(entry).some(value => ArrayBuffer.isView(value))));
});
test('DOCX ZIP accepts ordinary fflate-produced OOXML-like ZIP data', () => {
  const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<document/>') });
  assert.deepEqual(validate(bytes).entries.map(entry => entry.name), ['[Content_Types].xml', 'word/document.xml']);
});
test('DOCX ZIP supports signed and unsigned data descriptors with zero or exact local sizes', () => {
  for (const descriptor of ['signed', 'unsigned']) for (const localExact of [false, true]) {
    const result = validate(fixture([{ name: 'word/document.xml', data: 'descriptor '.repeat(100), method: 8, descriptor, localExact }]).bytes);
    assert.equal(result.actualExpandedBytes, 1100);
  }
});
test('DOCX ZIP rejects changed data descriptor CRC and sizes and missing descriptors', () => {
  const archive = fixture([{ name: 'word/document.xml', data: 'descriptor', method: 8, descriptor: 'signed' }]);
  for (const field of [4, 8, 12]) rejected(mutate(archive, bytes => { bytes[archive.members[0].descriptorOffset + field] ^= 1; }), 'descriptor_mismatch');
  const absent = fixture([{ name: 'word/document.xml', data: 'descriptor', method: 8, flags: 8 }]); rejected(absent.bytes, 'descriptor_mismatch');
});
test('DOCX ZIP accepts exact views and cross-realm buffers but rejects shared or false byte brands', () => {
  const bytes = fixture([{ name: 'x', data: 'x' }]).bytes, enclosing = new Uint8Array(bytes.length + 10); enclosing.set(bytes, 5); assert.equal(validate(enclosing.subarray(5, 5 + bytes.length)).entryCount, 1);
  const foreign = vm.runInNewContext('Uint8Array.from(input).buffer', { input: [...bytes] }); assert.equal(validate(foreign).entryCount, 1);
  for (const input of [new Uint16Array(20), new DataView(new ArrayBuffer(40)), {}, { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: bytes.length }, new Proxy(new ArrayBuffer(40), {})]) rejected(input, 'invalid_input');
  if (typeof SharedArrayBuffer !== 'undefined') { rejected(new SharedArrayBuffer(40), 'invalid_input'); rejected(new Uint8Array(new SharedArrayBuffer(40)), 'invalid_input'); }
});
test('DOCX ZIP enforces the independent 25 MiB input bound before copying or parsing', () => {
  rejected(new Uint8Array(MAX_DOCX_INPUT_BYTES + 1), 'input_limit'); rejected(new Uint8Array(MAX_DOCX_INPUT_BYTES), 'invalid_zip'); rejected(new Uint8Array(21), 'invalid_zip');
});
test('DOCX ZIP requires an exact EOCD comment and complete records', () => {
  const archive = fixture([{ name: 'x', data: 'owned' }], { comment: 'owned comment' }); assert.equal(validate(archive.bytes).entryCount, 1);
  rejected(Buffer.concat([archive.bytes, Buffer.from([0])])); rejected(archive.bytes.subarray(0, -1)); rejected(mutate(archive, bytes => bytes.writeUInt16LE(1, archive.endOffset + 20)));
});
test('DOCX ZIP rejects all multi-disk directory fields and central disk-start metadata', () => {
  const archive = fixture([{ name: 'x', data: 'x' }]); for (const position of [archive.endOffset + 4, archive.endOffset + 6, archive.endOffset + 8, archive.members[0].centralOffset + 34]) rejected(mutate(archive, bytes => bytes.writeUInt16LE(2, position)), 'unsupported_zip');
});
test('DOCX ZIP accepts 4096 entries and rejects the next entry before decompression', () => {
  const items = Array.from({ length: MAX_DOCX_ENTRIES }, (_, i) => ({ name: 'part/' + i, data: [] })); assert.equal(validate(fixture(items).bytes).entryCount, MAX_DOCX_ENTRIES); items.push({ name: 'part/overflow', data: [] }); rejected(fixture(items).bytes, 'entry_limit');
});
test('DOCX ZIP rejects ZIP64 sentinels and ZIP64 extra fields even without a sentinel', () => {
  const archive = fixture([{ name: 'x', data: 'x' }]);
  for (const position of [archive.endOffset + 12, archive.endOffset + 16, archive.members[0].centralOffset + 20, archive.members[0].centralOffset + 24, archive.members[0].centralOffset + 42]) rejected(mutate(archive, bytes => bytes.writeUInt32LE(0xffffffff, position)), 'unsupported_zip');
  rejected(mutate(archive, bytes => bytes.writeUInt16LE(0xffff, archive.endOffset + 10)), 'unsupported_zip');
  for (const key of ['localExtra', 'centralExtra']) rejected(fixture([{ name: 'x', data: 'x', [key]: extra(1) }]).bytes, 'unsupported_zip');
});
test('DOCX ZIP rejects encryption flags unsupported methods versions and AES extras', () => {
  for (const flags of [1, 0x40, 0x2000, 0x10]) rejected(fixture([{ name: 'x', data: 'x', flags }]).bytes, 'unsupported_zip');
  rejected(fixture([{ name: 'x', data: 'x', method: 99 }]).bytes, 'unsupported_zip'); rejected(fixture([{ name: 'x', data: 'x', centralExtra: extra(0x9901) }]).bytes, 'unsupported_zip');
  const archive = fixture([{ name: 'x', data: 'x' }]); rejected(mutate(archive, bytes => bytes.writeUInt16LE(45, archive.members[0].centralOffset + 6)), 'unsupported_zip');
});
test('DOCX ZIP rejects local versus central method flags name CRC and size disagreement', () => {
  const archive = fixture([{ name: 'x', data: 'owned', method: 8 }]);
  for (const position of [4, 6, 8, 14, 18, 22, 30]) rejected(mutate(archive, bytes => { bytes[position] ^= 1; }), 'header_mismatch');
  rejected(fixture([{ name: 'same', localName: 'else', data: 'x' }]).bytes, 'header_mismatch');
});
test('DOCX ZIP rejects stored-size disagreement and actual stored CRC corruption', () => {
  rejected(fixture([{ name: 'x', data: 'stored', expandedSize: 3 }]).bytes, 'invalid_zip');
  const archive = fixture([{ name: 'x', data: 'stored' }]); rejected(mutate(archive, bytes => { bytes[archive.members[0].dataOffset] ^= 1; }), 'crc_mismatch');
});
test('DOCX ZIP rejects overlapping local records payloads hidden gaps and preambles', () => {
  const archive = fixture([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }]); rejected(mutate(archive, bytes => bytes.writeUInt32LE(0, archive.members[1].centralOffset + 42)), 'record_overlap');
  rejected(mutate(archive, bytes => bytes.writeUInt32LE(1000, archive.members[0].centralOffset + 20)));
  rejected(fixture([{ name: 'a', data: 'a' }], { preamble: [0] }).bytes, 'invalid_zip');
});
test('DOCX ZIP rejects unsafe ambiguous duplicate and file-directory member names', () => {
  for (const name of ['../x', '/absolute', 'C:relative', 'a\\b', 'a//b', 'a/./b', 'a/%2e%2e/b', 'a/%2f/b', 'a/%5c/b', 'a/%00/b', 'a\u0000b']) rejected(fixture([{ name, data: 'x' }]).bytes, 'invalid_name');
  for (const names of [['a', 'a'], ['A', 'a'], ['a%20b', 'a b'], ['word', 'word/document.xml'], ['word/', 'word']]) rejected(fixture(names.map(name => ({ name, data: name.endsWith('/') ? [] : 'x' }))).bytes);
  rejected(fixture([{ name: 'é', data: 'x', flags: 0 }]).bytes, 'unsupported_name_encoding');
});
test('DOCX ZIP rejects symlink special-file and inconsistent directory metadata', () => {
  for (const mode of [0xa000, 0x6000]) rejected(fixture([{ name: 'x', data: 'x', externalAttributes: (mode * 65536) >>> 0 }]).bytes, 'unsupported_zip');
  rejected(fixture([{ name: 'x', data: [], externalAttributes: 0x10 }]).bytes, 'invalid_name'); rejected(fixture([{ name: 'folder/', data: 'not empty' }]).bytes);
});
test('DOCX ZIP parses extra TLVs strictly and rejects alternative Unicode path metadata', () => {
  assert.equal(validate(fixture([{ name: 'x', data: 'x', localExtra: extra(0x5455), centralExtra: extra(0x5455) }]).bytes).entryCount, 1);
  for (const key of ['localExtra', 'centralExtra']) { rejected(fixture([{ name: 'x', data: 'x', [key]: [1, 2] }]).bytes); rejected(fixture([{ name: 'x', data: 'x', [key]: [0x55, 0x54, 3, 0] }]).bytes); rejected(fixture([{ name: 'x', data: 'x', [key]: extra(0x7075) }]).bytes, 'unsupported_zip'); }
});
test('DOCX ZIP detects reserved truncated trailing and malformed raw DEFLATE framing', () => {
  const data = Buffer.from('owned deflate '.repeat(50)), compressed = deflateSync(data);
  for (const bad of [Uint8Array.from([7]), compressed.subarray(0, -1), Buffer.concat([compressed, Buffer.from([0])])]) rejected(fixture([{ name: 'x', data, compressed: bad, method: 8 }]).bytes, 'invalid_deflate');
  const emptyStoredBlock = Uint8Array.from([1, 0, 0, 255, 255]); assert.equal(validate(fixture([{ name: 'x', data: [], compressed: emptyStoredBlock, method: 8 }]).bytes).actualExpandedBytes, 0);
  rejected(fixture([{ name: 'x', data: [], compressed: [1, 0, 0, 254, 255], method: 8 }]).bytes, 'invalid_deflate'); rejected(fixture([{ name: 'x', data: [], compressed: [], method: 8 }]).bytes);
});
test('DOCX ZIP rejects understated expansion and independently checks actual deflate CRC', () => {
  const data = Buffer.from('x'.repeat(200000)); rejected(fixture([{ name: 'x', data, expandedSize: 1, method: 8 }]).bytes, 'expanded_size_mismatch');
  rejected(fixture([{ name: 'x', data: 'owned CRC', crc32: 0, method: 8 }]).bytes, 'crc_mismatch');
});
test('DOCX ZIP handles real stored fixed and dynamic DEFLATE output across levels', () => {
  const data = Buffer.concat([pseudoRandom(3000), Buffer.from('actual dynamic huffman '.repeat(500))]);
  for (const level of [0, 1, 6, 9]) { const compressed = deflateSync(data, { level }); assert.equal(validate(fixture([{ name: 'x', data, compressed, method: 8 }]).bytes).actualExpandedBytes, data.length); }
});
test('DOCX ZIP accepts consecutive empty fixed-Huffman blocks without allocating expanded copies', () => {
  const blocks = 10000, compressed = new Uint8Array(Math.ceil(blocks * 10 / 8)); let bit = 0;
  const write = value => { compressed[bit >>> 3] |= value << (bit & 7); bit++; };
  for (let i = 0; i < blocks; i++) { write(i === blocks - 1 ? 1 : 0); write(1); write(0); for (let j = 0; j < 7; j++) write(0); }
  assert.equal(validate(fixture([{ name: 'empty', data: [], compressed, method: 8 }]).bytes).actualExpandedBytes, 0);
});
test('DOCX ZIP accepts exact per-entry and total expanded budgets and rejects one-byte excess', () => {
  const data = Buffer.alloc(MAX_DOCX_ENTRY_BYTES, 65), compressed = deflateSync(data), entries = [{ name: 'a', data, compressed, method: 8 }, { name: 'b', data, compressed, method: 8 }];
  assert.equal(validate(fixture(entries).bytes).actualExpandedBytes, MAX_DOCX_EXPANDED_BYTES);
  rejected(fixture([{ name: 'a', data: [], expandedSize: MAX_DOCX_ENTRY_BYTES + 1, compressed: [3, 0], method: 8 }]).bytes, 'entry_size_limit');
  rejected(fixture([...entries, { name: 'c', data: 'x' }]).bytes, 'expanded_limit');
});
test('DOCX ZIP runs without Buffer or Node APIs and forwards bounded chunks to the actual browser inflater', () => {
  const lengths = []; class TrackedInflate extends Inflate { push(bytes, final) { lengths.push(bytes.length); super.push(bytes, final); } }
  const module = { exports: {} }, context = vm.createContext({ module, exports: module.exports, require: name => { assert.equal(name, 'fflate'); return { Inflate: TrackedInflate }; }, TextDecoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../scripts/docx-zip.cjs'), 'utf8'), context);
  const archive = fixture([{ name: 'x', data: pseudoRandom(12000), method: 8 }]), result = context.module.exports.validateDocxPreviewZip(archive.bytes);
  assert.equal(result.actualExpandedBytes, 12000); assert(lengths.length > 2); assert.equal(Math.max(...lengths), INFLATE_CHUNK_BYTES); assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
});
