'use strict';

const isCsvFile = name => typeof name === 'string' && /\.(csv|tsv)$/i.test(name);
// The original preview selects tabs only for the lowercase filename suffix.
const csvDelimiter = name => typeof name === 'string' && name.endsWith('.tsv') ? '\t' : ',';

// This is a view parser. Keep the source in the editor: it is never rebuilt
// from these cells, normalized, validated on Save or treated as a formula.
function parseCsv(text, separator = ',') {
  const rows = [];
  let fields = [], field = '', quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[offset + 1] === '"') { field += '"'; offset++; }
      else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === separator) { fields.push(field); field = ''; }
    else if (character === '\n') { fields.push(field); rows.push(fields); fields = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  if (field.length || fields.length) { fields.push(field); rows.push(fields); }
  return rows;
}

function csvPreview(text, name) {
  const parsed = parseCsv(text, csvDelimiter(name));
  return { headers: parsed[0] || [], rows: parsed.slice(1, 1001), totalRows: Math.max(0, parsed.length - 1), truncated: parsed.length > 1001 };
}

module.exports = { isCsvFile, csvDelimiter, parseCsv, csvPreview };
