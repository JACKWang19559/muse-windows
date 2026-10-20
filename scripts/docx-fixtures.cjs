'use strict';
// Entirely owned OOXML, pixels and malformed ZIP fixtures. No original app,
// downloaded template/font, user document or private-analysis bytes are used.
const { zipSync, strToU8, zlibSync } = require('fflate');
const crypto = require('node:crypto');
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
const xml = body => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = entries => xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + entries.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target.replace(/&/g, '&amp;')}"${external ? ' TargetMode="External"' : ''}/>`).join('') + '</Relationships>');
const text = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paragraph = value => `<w:p><w:r><w:t xml:space="preserve">${text(value)}</w:t></w:r></w:p>`;
const hyperlink = (label, id, anchor) => `<w:p><w:hyperlink${id ? ` r:id="${id}"` : ''}${anchor ? ` w:anchor="${anchor}"` : ''}><w:r><w:rPr><w:color w:val="1665B0"/><w:u w:val="single"/></w:rPr><w:t>${label}</w:t></w:r></w:hyperlink></w:p>`;
function png() {
  const chunk = (type, data) => { const name = Buffer.from(type), body = Buffer.concat([name, data]), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc(body), data.length + 8); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 6;
  const scan = Buffer.alloc(24 * (1 + 32 * 4));
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) { const i = y * 129 + 1 + x * 4; scan.set(x < 16 ? [238, 44, 44, 255] : [32, 96, 238, 255], i); }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', Buffer.from(zlibSync(scan))), chunk('IEND', Buffer.alloc(0))]);
}
function drawing(id, number) {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="685800"/><wp:docPr id="${number}" name="Owned32x24"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${number}" name="owned.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function parts(external) {
  const rows = [['OWNED_TABLE_A', 'OWNED_TABLE_B'], ['自有单元格', '42']].map(row => '<w:tr>' + row.map(cell => '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + paragraph(cell) + '</w:tc>').join('') + '</w:tr>').join('');
  const table = '<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders>' + ['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="8" w:color="334455"/>`).join('') + '</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' + rows + '</w:tbl>';
  const body = paragraph('OWNED_DOCX_PAGE_1') + paragraph('自有中文文档：分页、表格和图片。') + '<w:p><w:r><w:rPr><w:b/><w:color w:val="994422"/></w:rPr><w:t>OWNED_BOLD</w:t></w:r></w:p>' + table + drawing('rImage', 1) + hyperlink('OWNED_INTERNAL_LINK', null, 'owned_docx_target') + hyperlink('OWNED_HTTPS_LINK', 'rHttps') + hyperlink('OWNED_UNSAFE_LINK', 'rUnsafe') + '<w:altChunk r:id="rAlt"/>' + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + paragraph('OWNED_DOCX_PAGE_2') + paragraph('Second independently authored page.') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + '<w:p><w:bookmarkStart w:id="7" w:name="owned_docx_target"/><w:r><w:t>OWNED_DOCX_PAGE_3_BOOKMARK</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>' + paragraph('Third independently authored page.') + (external ? drawing('rExternalImage', 2) : '') + '<w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>';
  const files = {
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>'),
    '_rels/.rels': rels([['rDocument', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': xml(`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`),
    'word/_rels/document.xml.rels': rels([['rStyles', 'styles', 'styles.xml'], ['rFontTable', 'fontTable', 'fontTable.xml'], ['rHeader', 'header', 'header1.xml'], ['rFooter', 'footer', 'footer1.xml'], ['rImage', 'image', 'media/owned.png'], ['rHttps', 'hyperlink', 'https://owned.example.invalid/docx-approved', true], ['rUnsafe', 'hyperlink', 'javascript:globalThis.__OWNED_DOCX_UNSAFE=1', true], ['rAlt', 'aFChunk', 'owned-alt.html'], ...(external ? [['rExternalImage', 'image', 'https://docx-owned.invalid/image-tripwire.png', true], ['rExternalCSS', 'attachedTemplate', 'https://docx-owned.invalid/style-tripwire.css', true]] : [])]),
    'word/styles.xml': xml(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${external ? 'OwnedExternal' : 'Arial'}" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`),
    'word/header1.xml': xml(`<w:hdr xmlns:w="${W}">${paragraph('OWNED_DOCX_HEADER')}</w:hdr>`),
    'word/footer1.xml': xml(`<w:ftr xmlns:w="${W}">${paragraph('OWNED_DOCX_FOOTER')}</w:ftr>`),
    'word/fontTable.xml': xml(`<w:fonts xmlns:w="${W}" xmlns:r="${R}">${external ? '<w:font w:name="OwnedExternal"><w:embedRegular r:id="rExternalFont" w:fontKey="{00112233-4455-6677-8899-AABBCCDDEEFF}"/></w:font>' : '<w:font w:name="Arial"/>'}</w:fonts>`),
    'word/_rels/fontTable.xml.rels': rels(external ? [['rExternalFont', 'font', 'https://docx-owned.invalid/font-tripwire.odttf', true]] : []),
    'word/owned-alt.html': '<!doctype html><html><head><link rel="stylesheet" href="https://docx-owned.invalid/alt-style.css"></head><body>OWNED_ALTCHUNK_MUST_NOT_APPEAR<script>globalThis.__OWNED_ALT_EXECUTED=1</script></body></html>',
    'word/media/owned.png': png()
  };
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]));
}
function archive(files, level) { return Buffer.from(zipSync(files, { level, mtime: new Date(2020, 0, 1, 0, 0, 0) })); }
function mutateMember(bytes, action) {
  const result = Buffer.from(bytes); let end = result.length - 22; const directory = result.readUInt32LE(end + 16), count = result.readUInt16LE(end + 10); let offset = directory;
  for (let i = 0; i < count; i++) { const nameLength = result.readUInt16LE(offset + 28), name = result.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), local = result.readUInt32LE(offset + 42); action(result, name, local, offset); offset += 46 + nameLength + result.readUInt16LE(offset + 30) + result.readUInt16LE(offset + 32); }
  return result;
}
function describe(bytes, description, extra = {}) { return { mime: MIME, size: bytes.length, sha256: digest(bytes), description, base64: bytes.toString('base64'), ...extra }; }
const files = parts(false), rich = archive(files, 6), stored = archive(files, 0), external = archive(parts(true), 6);
const cachedFiles = parts(false);
cachedFiles['word/document.xml'] = strToU8(xml(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${paragraph('OWNED_CACHED_BREAK_BEFORE')}<w:p><w:r><w:lastRenderedPageBreak/><w:t>OWNED_CACHED_BREAK_AFTER</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`));
const cachedBreak = archive(cachedFiles, 6);
const crcMismatch = mutateMember(rich, (bytes, name, local, central) => { if (name === 'word/document.xml') { bytes.writeUInt32LE(0x12345678, local + 14); bytes.writeUInt32LE(0x12345678, central + 16); } });
const bombSize = 16 * 1024 * 1024 + 1;
const expansionMismatch = mutateMember(archive({ 'word/document.xml': new Uint8Array(bombSize).fill(65) }, 9), (bytes, _name, local, central) => { bytes.writeUInt32LE(1, local + 22); bytes.writeUInt32LE(1, central + 24); });
module.exports = {
  rich: describe(rich, 'Owned deflated three-page Word package: Chinese, bold,2x2table,32x24red/bluePNG, header/footer, bookmark, HTTPS/unsafe links and disabled altChunk.', { pages: 3, image: { width: 32, height: 24, red: 384, blue: 384 } }),
  stored: describe(stored, 'The identical owned rich OOXML using stored ZIP entries.', { pages: 3 }),
  cachedBreak: describe(cachedBreak, 'Owned cached lastRenderedPageBreak marker without a manual page break; it must remain one page.', { pages: 1 }),
  external: describe(external, 'Owned rich OOXML plus external image,font and stylesheet-template relationships; parser may drop relationships before CSP. No target should be requested.', { pages: 3, externalTargets: ['https://docx-owned.invalid/image-tripwire.png','https://docx-owned.invalid/font-tripwire.odttf','https://docx-owned.invalid/style-tripwire.css'] }),
  corrupt: describe(Buffer.from('OWNED_NOT_A_ZIP_DOCUMENT\n'), 'Owned invalid Word ZIP bytes.'),
  crcMismatch: describe(crcMismatch, 'Valid declared/local ZIP metadata with deliberately incorrect document CRC; actual decompressed bytes are unchanged.'),
  expansionMismatch: describe(expansionMismatch, 'Own compressed16MiB+1 repeated bytes while both headers declare1byte; actual framing must reject understated expansion before full inflation.', { actualExpandedBytes: bombSize, declaredExpandedBytes: 1 })
};
