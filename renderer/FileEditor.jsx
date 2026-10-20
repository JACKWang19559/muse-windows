import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Info, LoaderCircle, Pencil, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import JsonPreview from './JsonPreview.jsx';
import CsvPreview from './CsvPreview.jsx';
import { isJsonFile, jsonSaveError } from './file-json.cjs';
import { isCsvFile } from './file-csv.cjs';

const api = window.muse;
const dirty = tab => tab && !tab.loading && !tab.error && tab.text !== tab.baseline;
const fileErrorMessage = error => {
  const message = typeof error?.message === 'string' ? error.message : '';
  return message.replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '').trim() || '文件操作失败，请重试。';
};

export default function FileEditor({ ids, activeId, files, onSelect, onCloseTab, onClose, onRemove, notify, Modal, renderMarkdown }) {
  const [tabs, setTabs] = useState({});
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadInFlight = useRef(false);
  const [pending, setPending] = useState(null);
  const latest = useRef({ ids, tabs, activeId });
  latest.current = { ids, tabs, activeId };
  const requested = useRef(new Set());
  const requests = useRef(new Map());
  const alive = useRef(true);
  const patch = (id, value) => setTabs(previous => ({ ...previous, [id]: { ...previous[id], ...value } }));
  const load = async id => {
    const token = Symbol();
    requests.current.set(id, token);
    patch(id, { loading: true, error: '', saveError: '', saveDetail: '' });
    try {
      const result = await api.readFile({ id });
      if (alive.current && latest.current.ids.includes(id) && requests.current.get(id) === token) patch(id, { ...result, baseline: result.text, loading: false, mode: 'preview' });
    } catch (error) { if (alive.current && requests.current.get(id) === token) patch(id, { loading: false, error: fileErrorMessage(error) }); }
  };
  useEffect(() => {
    for (const id of ids) if (!requested.current.has(id)) { requested.current.add(id); load(id); }
    for (const id of requested.current) if (!ids.includes(id)) { requested.current.delete(id); requests.current.delete(id); }
  }, [ids]);
  useEffect(() => () => { alive.current = false; }, []);
  const save = async id => {
    const tab = latest.current.tabs[id];
    if (!tab?.editable || !dirty(tab)) return true;
    const syntax = isJsonFile(tab.name) ? jsonSaveError(tab.text) : null;
    if (syntax) {
      patch(id, { saveError: syntax.message, saveDetail: syntax.detail });
      notify(syntax.message, 'error');
      return false;
    }
    setSaving(true);
    try {
      const result = await api.saveTextFile({ id, content: tab.text, expectedSha256: tab.sha256 });
      patch(id, { ...result.preview, baseline: result.preview.text, saveError: '', saveDetail: '' });
      notify('文件已保存，相关对话会使用更新后的内容');
      return true;
    } catch (error) { const message = fileErrorMessage(error); patch(id, { saveError: message, saveDetail: '' }); notify(message, 'error'); return false; }
    finally { setSaving(false); }
  };
  const download = async id => {
    const current = latest.current.tabs[id];
    if (!current || current.loading || downloadInFlight.current) return;
    const input = { id, ...(current.editable && dirty(current) ? { content: current.text } : {}) };
    downloadInFlight.current = true;
    setDownloading(true);
    try {
      const result = await api.exportFile(input);
      if (!result.cancelled) notify(result.draft ? '草稿副本已下载，工作台文件尚未保存' : '文件副本已下载');
    } catch (error) { notify(fileErrorMessage(error), 'error'); }
    finally { downloadInFlight.current = false; if (alive.current) setDownloading(false); }
  };
  const guard = (scope, run) => {
    if (saving) return;
    const changed = scope.filter(id => dirty(latest.current.tabs[id]));
    if (changed.length) setPending({ ids: changed, run });
    else run();
  };
  useEffect(() => {
    const unload = event => { if (latest.current.ids.some(id => dirty(latest.current.tabs[id]))) { event.preventDefault(); event.returnValue = false; } };
    const shortcut = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!saving) save(latest.current.activeId); }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', shortcut); };
  }, [saving]);
  const tab = tabs[activeId] || { loading: true };
  const file = files.find(item => item.id === activeId) || { id: activeId, name: tab.name || '文件已移除' };
  const isMarkdown = /\.(md|markdown)$/i.test(file.name);
  const isJson = isJsonFile(file.name);
  const isCsv = isCsvFile(file.name);
  return <aside className="file-preview file-editor" aria-label={`文件预览 ${file.name}`} data-testid="file-preview">
    <header className="preview-header"><span className="eyebrow">文件工作台</span><button className="icon-button" aria-label="关闭文件预览" onClick={() => guard(ids, onClose)} disabled={saving}><X size={17} /></button></header>
    <div className="file-tabs" role="tablist" aria-label="已打开文件">{ids.map(id => {
      const metadata = files.find(item => item.id === id);
      return <div key={id} className={`file-tab ${activeId === id ? 'active' : ''}`}><button role="tab" aria-selected={activeId === id} title={metadata?.name || tabs[id]?.name} onClick={() => onSelect(id)}><FileText size={13} /><span>{metadata?.name || tabs[id]?.name || '文件'}</span>{dirty(tabs[id]) && <span className="dirty-indicator" aria-label="未保存">●</span>}</button><button className="tab-close" aria-label={`关闭文件 ${metadata?.name || tabs[id]?.name || ''}`} onClick={() => guard([id], () => onCloseTab(id))} disabled={saving}><X size={12} /></button></div>;
    })}</div>
    <div className="editor-toolbar"><div className="editor-modes"><button className={tab.mode !== 'edit' ? 'active' : ''} onClick={() => patch(activeId, { mode: 'preview' })} data-testid="file-preview-mode">{isJson ? '结构' : isCsv ? '表格' : '预览'}</button><button className={tab.mode === 'edit' ? 'active' : ''} disabled={!tab.editable || tab.loading} onClick={() => patch(activeId, { mode: 'edit' })} data-testid="file-edit-mode"><Pencil size={12} />{isJson || isCsv ? '源码' : '编辑'}</button></div><button className="button primary small" onClick={() => save(activeId)} disabled={!tab.editable || !dirty(tab) || saving} data-testid="file-save">{saving ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}保存</button></div>
    {tab.saveError && <div className="editor-error" role="alert">{tab.saveError}{tab.saveDetail && <p className="json-save-detail">{tab.saveDetail}</p>}<button onClick={() => guard([activeId], () => load(activeId))}>重新读取文件</button></div>}
    <div className={`preview-content ${tab.mode === 'edit' ? 'editing' : ''}`}>{tab.loading ? <div className="centered loading-inline"><LoaderCircle size={16} className="spin" />读取文件中…</div> : tab.error ? <div className="empty-preview"><FileText size={28} /><h4>暂无文字预览</h4><p>{tab.error}</p></div> : tab.mode === 'edit' ? <textarea className="file-editor-input" aria-label={`编辑 ${file.name}`} data-testid="file-editor-input" spellCheck={false} value={tab.text} disabled={saving} onChange={event => patch(activeId, { text: event.target.value, saveError: '', saveDetail: '' })} /> : <>
      {tab.truncated && <div className="inline-note"><Info size={14} />文件较长，仅预览前面部分内容。</div>}
      {tab.text ? isJson && !tab.truncated ? <JsonPreview key={activeId} text={tab.text} editable={tab.editable} onEdit={() => patch(activeId, { mode: 'edit' })} /> : isCsv && !tab.truncated ? <CsvPreview text={tab.text} name={file.name} /> : isMarkdown ? renderMarkdown(tab.text) : <pre className="plain-preview">{tab.text}</pre> : <div className="empty-preview"><FileText size={28} /><h4>{tab.editable ? '这是一份空文件' : '这份文件没有可预览的文字'}</h4><p>{tab.editable ? '点击“编辑”开始写作。' : '使用系统应用打开这份文件。'}</p></div>}
    </>}</div>
    <div className="editor-file-actions"><button className="text-button" disabled={saving || downloading || tab.loading} data-testid="file-download" onClick={() => download(activeId)}>{downloading ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}下载副本</button><button className="text-button" onClick={() => api.openFile({ id: activeId }).catch(error => notify(fileErrorMessage(error), 'error'))}><ExternalLink size={13} />打开文件</button><button className="icon-button" title="重新读取文件" aria-label="重新读取文件" onClick={() => guard([activeId], () => load(activeId))} disabled={saving}><RefreshCw size={14} /></button><button className="text-button danger-text" onClick={() => onRemove(file)} disabled={saving}><Trash2 size={13} />移除</button></div>
    <footer className="preview-footer"><ShieldCheck size={13} />{dirty(tab) ? '有未保存的修改 · Ctrl + S 保存' : tab.editable ? '修改仅保存到工作台中的文件副本' : '此文件为只读预览'}</footer>
    {pending && <Modal title="文件有未保存的修改" subtitle="保存后再离开，或放弃这些修改。" onClose={() => !saving && setPending(null)} className="confirm-modal"><p className="confirm-body">{pending.ids.map(id => tabs[id]?.name || files.find(file => file.id === id)?.name).join('、')}</p><footer className="modal-footer"><button className="button secondary" disabled={saving} onClick={() => setPending(null)}>继续编辑</button><button className="button ghost danger-text" disabled={saving} data-testid="file-discard" onClick={() => { const run = pending.run; setPending(null); run(); }}>放弃修改</button><button className="button primary" disabled={saving} data-testid="file-save-and-close" onClick={async () => { for (const id of pending.ids) if (!await save(id)) return; const run = pending.run; setPending(null); run(); }}>保存并继续</button></footer></Modal>}
  </aside>;
}
