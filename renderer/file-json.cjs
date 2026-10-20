'use strict';

const isJsonFile = name => typeof name === 'string' && /\.(json|jsonl)$/i.test(name);

// Preview accepts one JSON value, or independently parsed nonempty JSONL rows.
// Keep the original text outside this view model; rendering never rewrites it.
function parseJsonPreview(text) {
  try { return { ok: true, value: JSON.parse(text), kind: 'json' }; } catch {}
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { values.push(JSON.parse(trimmed)); } catch { return { ok: false }; }
  }
  return values.length ? { ok: true, value: values, kind: 'jsonl' } : { ok: false };
}

// This belongs to the file editor's Save action. Generic file tools can write
// arbitrary text, as they could before this editor-specific format check.
function jsonSaveError(text) {
  try { JSON.parse(text); return null; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const match = /position\s+(\d+)/i.exec(detail);
    const position = match ? Number(match[1]) : null;
    const line = position !== null ? text.substring(0, position).split('\n').length : null;
    return { line, detail, message: `JSON 格式无效${line !== null ? `（第 ${line} 行）` : ''}。请检查逗号、引号和括号。` };
  }
}

module.exports = { isJsonFile, parseJsonPreview, jsonSaveError };
