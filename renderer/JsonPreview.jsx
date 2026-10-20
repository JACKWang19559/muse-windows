import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2 } from 'lucide-react';
import { parseJsonPreview } from './file-json.cjs';
import './json-file.css';

function JsonNode({ label = null, value, root = false }) {
  const container = value !== null && typeof value === 'object';
  const [expanded, setExpanded] = useState(root);
  if (!container) {
    const kind = value === null ? 'null' : typeof value;
    return <li className="json-node json-leaf">{label !== null && <span className="json-key">{label}: </span>}<span className={`json-value json-${kind}`}>{typeof value === 'string' ? `"${value}"` : String(value)}</span></li>;
  }
  const entries = Object.entries(value), array = Array.isArray(value);
  return <li className="json-node">
    <button className="json-toggle" type="button" aria-expanded={expanded} aria-label={`${expanded ? '折叠' : '展开'} ${label ?? '根节点'}`} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {label !== null && <span className="json-key">{label}: </span>}<span className="json-container-size">{array ? `[${entries.length}]` : `{${entries.length}}`}</span>
    </button>
    {expanded && entries.length > 0 && <ul>{entries.map(([key, item]) => <JsonNode key={key} label={key} value={item} />)}</ul>}
  </li>;
}

export default function JsonPreview({ text, onEdit, editable }) {
  const parsed = useMemo(() => parseJsonPreview(text), [text]);
  if (!parsed.ok) return <div className="json-invalid" data-testid="json-parse-error"><p role="alert">无法解析 JSON 或逐行 JSON。源码已保留，请检查格式。</p>{editable && <button className="button secondary small" onClick={onEdit}><FileCode2 size={13} />查看源码</button>}<pre className="plain-preview">{text}</pre></div>;
  return <section className="json-preview" aria-label="JSON 结构预览" data-testid="json-preview">
    {parsed.kind === 'jsonl' && <p className="inline-note" data-testid="jsonl-note">按行展示 {parsed.value.length} 条记录；当前编辑入口保存时需要一个完整 JSON 值。</p>}
    <ul className="json-root"><JsonNode value={parsed.value} root /></ul>
  </section>;
}
