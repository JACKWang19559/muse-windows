import React, { useMemo } from 'react';
import { Table2 } from 'lucide-react';
import { csvPreview } from './file-csv.cjs';
import './csv-file.css';

export default function CsvPreview({ text, name }) {
  const view = useMemo(() => csvPreview(text, name), [text, name]);
  if (!view.headers.length) return <div className="empty-preview" data-testid="csv-empty"><Table2 size={28} /><h4>暂无表格数据</h4></div>;
  return <section className="csv-preview" aria-label="表格预览" data-testid="csv-preview">
    {view.truncated && <p className="inline-note" data-testid="csv-row-limit">仅显示前 1000 行数据（表头不计入）；其余内容保留在源码中。</p>}
    <div className="csv-scroll"><table><thead><tr>{view.headers.map((value, index) => <th key={index} scope="col">{value}</th>)}</tr></thead>
      <tbody>{view.rows.map((row, index) => <tr key={index}>{view.headers.map((_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table></div>
  </section>;
}
