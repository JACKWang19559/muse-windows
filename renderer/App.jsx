import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight,
  Copy, Download, ExternalLink, Eye, EyeOff, File, FileText, Folder, FolderOpen,
  FolderPlus, Info, KeyRound, LoaderCircle, MessageCircle, Minus, Monitor, Moon,
  MoreHorizontal, PanelLeft, Paperclip, Pencil, Pin, Plus, RefreshCw, Search,
  Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square, Sun, Trash2,
  Upload, X, AlertCircle, Database, Server, StopCircle, Reply, AlarmClock,
} from 'lucide-react';
import './styles.css';
import FileEditor from './FileEditor.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import { isImageFile } from '../backend/image-format.cjs';
import { isVideoFile, isPreviewMediaFile } from '../backend/video-format.cjs';
import { isPdfFile } from '../backend/pdf-format.cjs';
import { isDocxFile } from '../backend/docx-format.cjs';
import RenameFileDialog from './RenameFileDialog.jsx';
import { AgentActivity, ApprovalQueue } from './AgentActivity.jsx';
import SearchDialog from './SearchDialog.jsx';
import PendingSends from './PendingSends.jsx';
import ArtifactPanel from './ArtifactPanel.jsx';
import SchedulePanel from './SchedulePanel.jsx';
import KnowledgePanel from './KnowledgePanel.jsx';
import { useDictation } from './DictationControl.jsx';
import { useAudioPlayback, AudioControls, isAudioFile as legacyIsAudioFile } from './AudioPlayback.jsx';

const api = window.muse;
const isAudioFile = file => legacyIsAudioFile(file) && !isVideoFile(file?.name);
const COLORS = ['#47766a', '#607eb3', '#a07cb5', '#c49456', '#bd7777', '#7c8992'];
const EMPTY = { settings: {}, chats: [], workspaces: [], files: [], artifacts: [], schedules: [], scheduleRuns: [], memoryDocuments:[],memories:[],skills:[],agentProfiles:[],memoryIndexes:[],approvals: [], pendingSends: [], app: {} };

function Brand({ size = 28, className = '' }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" className={`brand-mark ${className}`} aria-hidden="true">
    <path d="M20 3C20 12.39 12.39 20 3 20C12.39 20 20 27.61 20 37C20 27.61 27.61 20 37 20C27.61 20 20 12.39 20 3Z" fill="currentColor" />
    <path d="M30.3 4.7C30.3 7.46 28.06 9.7 25.3 9.7C28.06 9.7 30.3 11.94 30.3 14.7C30.3 11.94 32.54 9.7 35.3 9.7C32.54 9.7 30.3 7.46 30.3 4.7Z" fill="currentColor" opacity=".55" />
  </svg>;
}

function IconButton({ icon: Icon, label, className = '', children, ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>
    {Icon && <Icon size={17} strokeWidth={1.7} />}{children}
  </button>;
}

function Spinner({ size = 17 }) { return <LoaderCircle size={size} className="spin" aria-label="正在处理" />; }
function formatBytes(value = 0) { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(0)} KB` : `${(value / 1048576).toFixed(1)} MB`; }
function dateText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function excerpt(text = '', max = 75) { const element = document.createElement('div'); element.innerHTML = DOMPurify.sanitize(marked.parse(text.slice(0, Math.max(2000, max * 8)), { gfm: true, async: false }), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }); const plain = element.textContent.replace(/\s+/g, ' ').trim(); return plain.length > max ? `${plain.slice(0, max)}…` : plain; }
function upsert(items, item) { return items.some(x => x.id === item.id) ? items.map(x => x.id === item.id ? item : x) : [item, ...items]; }
function sortChats(chats) { return [...chats].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()); }

function Modal({ title, subtitle, onClose, children, className = '', testId }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector('input,textarea') || panel.current?.querySelector('button'))?.focus());
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); }
      if (event.key === 'Tab') {
        const elements = [...(panel.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])].filter(x => x.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
    <section ref={panel} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} className={`modal ${className}`}>
      <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton icon={X} label="关闭" onClick={onClose} /></header>
      {children}
    </section>
  </div>;
}

const literalPattern = query => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
function HighlightText({ text, query }) {
  if (!query) return text;
  const parts = []; let start = 0, count = 0;
  for (const match of text.matchAll(literalPattern(query))) {
    parts.push(text.slice(start, match.index), <mark key={match.index}>{match[0]}</mark>);
    start = match.index + match[0].length;
    if (++count >= 40) break;
  }
  parts.push(text.slice(start)); return parts;
}
function Markdown({ content, notify, highlight }) {
  const html = useMemo(() => {
    const safe = DOMPurify.sanitize(marked.parse(content || '', { gfm: true, breaks: true, async: false }), {
      FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'audio', 'video'],
      FORBID_ATTR: ['style', 'srcset'],
    });
    if (!highlight) return safe;
    const container = document.createElement('div'); container.innerHTML = safe;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('mark')) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      const fragment = document.createDocumentFragment(); let start = 0;
      for (const match of node.textContent.matchAll(literalPattern(highlight))) {
        fragment.append(node.textContent.slice(start, match.index));
        const mark = document.createElement('mark'); mark.textContent = match[0]; fragment.append(mark);
        start = match.index + match[0].length;
        if (++count >= 40) break;
      }
      if (start) { fragment.append(node.textContent.slice(start)); node.replaceWith(fragment); }
      if (count >= 40) break;
    }
    return container.innerHTML;
  }, [content, highlight]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) api.openExternal(href).catch(error => notify(error.message, 'error'));
    else notify('只能打开 http 或 https 网页链接', 'info');
  }} />;
}

function Composer({ value, onChange, attachedFiles, onRemoveAttachment, onImport, onDrop, onSend, onStop, busy, admitting, importing, welcome = false, placeholder, model, configured, useTools, onToolsChange, quote, onClearQuote, artifactContext, onClearArtifactContext, activePanel, onClearActivePanel, historyMessages = [], historyKey, knowledgeControl, dictationProps }) {
  const dictation=useDictation({...dictationProps,value,onChange,onSend});
  const input = useRef(null);
  const composing = useRef(false);
  const recall = useRef(null);
  useEffect(() => { recall.current = null; }, [historyKey]);
  useLayoutEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 190)}px`; } }, [value]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('muse-focus-composer', focus);
    return () => window.removeEventListener('muse-focus-composer', focus);
  }, []);
  return <div className={`composer-shell ${welcome ? 'composer-welcome' : ''}`} data-testid="composer" onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); onDrop?.(Array.from(event.dataTransfer.files)); }}>
    {knowledgeControl}
    {dictation.banner}
    {activePanel && <div className="composer-quote composer-active-panel" data-testid="composer-active-panel"><Monitor size={15}/><div><strong>{activePanel.artifactName}</strong><span>本次消息引用的应用</span></div>{onClearActivePanel && <IconButton icon={X} label="移除应用引用" onClick={onClearActivePanel}/>}</div>}
    {artifactContext && <div className="composer-quote" data-testid="composer-artifact-context"><Monitor size={15}/><div><strong>{artifactContext.artifactName} · 页面选区</strong><span>{artifactContext.element.text || artifactContext.element.tag}</span></div><IconButton icon={X} label="移除页面选区" onClick={onClearArtifactContext}/></div>}
    {quote && <div className="composer-quote" data-testid="composer-quote"><Reply size={15} /><div><strong>回复 {quote.role === 'user' ? '你' : 'Muse'}</strong><span>{excerpt(quote.content || '附件消息', 180)}</span></div><IconButton icon={X} label="取消引用" onClick={onClearQuote} /></div>}
    {attachedFiles.length > 0 && <div className="attachment-tray">{attachedFiles.map(file => <div className="attachment-pill" key={file.id} title={file.name}><FileText size={15} /><span>{file.name}</span><IconButton icon={X} label={`移除附件 ${file.name}`} onClick={() => onRemoveAttachment(file.id)} /></div>)}</div>}
    <textarea ref={input} value={value} disabled={dictation.finishing} onChange={event => { recall.current = null; onChange(event.target.value); }} data-testid="composer-input" rows={welcome ? 2 : 1}
      aria-label="发送消息" placeholder={placeholder || (configured ? '写下你的想法，或拖入一份文件…' : '先连接你的模型，再聊聊想做什么…')}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const element = event.currentTarget;
        if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && element.selectionStart === element.selectionEnd) {
          const up = event.key === 'ArrowUp' && element.selectionStart === 0;
          const down = event.key === 'ArrowDown' && element.selectionEnd === value.length;
          if (up || down && recall.current) {
            const state = recall.current || { original: value, index: 0, values: historyMessages.filter(message => message.role === 'user' && !message.isDeleted && !['streaming', 'error'].includes(message.status) && message.content.trim()).map(message => message.content).reverse() };
            if (!recall.current) state.index = -1;
            const next = up ? Math.min(state.index + 1, state.values.length - 1) : state.index - 1;
            if (state.values.length && next >= -1) {
              event.preventDefault(); state.index = next; recall.current = next < 0 ? null : state;
              const text = next < 0 ? state.original : state.values[next]; onChange(text);
              requestAnimationFrame(() => input.current?.setSelectionRange(up ? 0 : text.length, up ? 0 : text.length));
              return;
            }
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (value.trim() || attachedFiles.length || dictation.active) dictation.send(); }
      }} />
    <div className="composer-toolbar"><div className="composer-tools">{dictation.toolbar}<IconButton icon={Paperclip} label="添加文件" data-testid="file-import" onClick={onImport} disabled={importing||dictation.finishing} />{importing && <Spinner size={15} />}
      <button className={`agent-mode-toggle ${useTools ? 'enabled' : ''}`} aria-pressed={!!useTools} title="让模型使用当前工作区的文件、应用和计划工具；更改前会请求确认" data-testid="agent-mode-toggle" disabled={admitting||dictation.finishing} onClick={() => onToolsChange(!useTools)}><ShieldCheck size={13} />工作区助手</button>
      <span className="composer-model"><span className={`connection-dot ${configured ? 'connected' : ''}`} />{configured ? model || '选择模型' : '尚未连接模型'}</span></div>
      <div className="composer-submit"><span className="composer-keyhint">Shift + Enter 换行</span>{busy && <button type="button" className="send-button stop-button" onClick={onStop} title="停止生成及等待发送" aria-label="停止生成" data-testid="stop-generation"><Square size={13} fill="currentColor" /></button>}
        {(!busy || value.trim() || attachedFiles.length > 0 || dictation.active) && <button type="button" className="send-button" onClick={dictation.send} disabled={!value.trim() && !attachedFiles.length && !dictation.active || importing || admitting || dictation.finishing} title={busy ? '加入待发送' : '发送消息'} aria-label={busy ? '加入待发送' : '发送消息'} data-testid="send-message"><ArrowUp size={19} strokeWidth={2} /></button>}</div>
    </div>
  </div>;
}

function FileRow({ file, onPreview, onRemove, compact = false }) {
  const extension = file.name.includes('.') ? file.name.split('.').at(-1).toUpperCase().slice(0, 5) : 'FILE';
  return <div className={`file-row ${compact ? 'compact' : ''}`} data-testid="file-row">
    <button className="file-main" onClick={() => onPreview(file.id)}><span className="file-type-icon"><FileText size={21} /><small>{extension}</small></span>
      <span className="file-info"><strong>{file.name}</strong><span>{formatBytes(file.size)}<span className="middle-dot">·</span>{file.textStatus === 'ready' ? '可用于对话' : file.textStatus === 'error' ? '文字读取失败' : '仅保存文件'}</span></span></button>
    <IconButton icon={MoreHorizontal} label={`文件选项 ${file.name}`} onClick={() => onPreview(file.id)} />
    {onRemove && <IconButton className="file-remove" icon={X} label={`移除 ${file.name}`} onClick={() => onRemove(file)} />}
  </div>;
}

function NewFileDialog({ workspaceId, onClose, onCreated, notify }) {
  const [name, setName] = useState('笔记.md');
  const [saving, setSaving] = useState(false);
  return <Modal title="新建文件" subtitle="在工作区写下内容，并用于后续对话。" onClose={() => !saving && onClose()} className="entity-modal"><form onSubmit={async event => {
    event.preventDefault(); setSaving(true);
    try { const result = await api.createTextFile({ workspaceId, name, content: '' }); onCreated(result.file); }
    catch (error) { notify(error.message, 'error'); }
    finally { setSaving(false); }
  }}><div className="form-body"><label className="field-label" htmlFor="new-file-name">文件名</label><input id="new-file-name" className="text-input" data-testid="new-file-name" value={name} maxLength={180} onChange={event => setName(event.target.value)} /><p className="field-hint">例如：笔记.md、计划.txt、配置.json。</p></div><footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" data-testid="new-file-create" disabled={!name.trim() || saving}>{saving && <Spinner size={14} />}创建文件</button></footer></form></Modal>;
}

function EntityDialog({ entity, onClose, onSave }) {
  const [name, setName] = useState(entity.name || '');
  const [description, setDescription] = useState(entity.description || '');
  const [color, setColor] = useState(entity.color || COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const workspace = entity.kind === 'workspace';
  const isNew = !entity.id;
  return <Modal title={workspace ? isNew ? '创建工作区' : '编辑工作区' : '重命名对话'} subtitle={workspace ? '把相关资料和对话，放在同一处。' : undefined} onClose={() => !saving && onClose()} className="entity-modal">
    <form onSubmit={async event => { event.preventDefault(); if (!name.trim() || saving) return; setSaving(true); setError(''); try { await onSave({ ...entity, name: name.trim(), description: description.trim(), color }); } catch (error) { setError(error.message); setSaving(false); } }}>
      <div className="form-body"><label className="field"><span>{workspace ? '工作区名称' : '对话名称'}</span><input data-testid={workspace ? 'workspace-name' : 'chat-name'} value={name} onChange={event => setName(event.target.value)} maxLength={160} placeholder={workspace ? '例如：产品想法、日常学习' : '给这段对话起个名字'} autoFocus /></label>
        {workspace && <><label className="field"><span>描述 <em>选填</em></span><textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="这个工作区用来做什么？" rows={3} maxLength={4000} data-testid="workspace-description" /></label><div className="field"><span>选择颜色</span><div className="color-options">{COLORS.map(value => <button type="button" key={value} aria-label={`颜色 ${value}`} aria-pressed={color === value} style={{ '--swatch': value }} className={`color-swatch ${color === value ? 'selected' : ''}`} onClick={() => setColor(value)}>{color === value && <Check size={15} />}</button>)}</div></div></>}
        {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}</div>
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={!name.trim() || saving} data-testid={workspace && isNew ? 'workspace-create' : 'entity-save'}>{saving && <Spinner size={15} />}{isNew ? '创建工作区' : '保存修改'}</button></footer>
    </form>
  </Modal>;
}

function SettingsDialog({ settings, app, onClose, onSaved, onImport, notify, onThemePreview }) {
  const preview=useAudioPlayback('preview',notify);
  const [sampleText,setSampleText]=useState('Hi, I’m Muse. Glad to be here!');
  const [tab, setTab] = useState('connection');
  const [draft, setDraft] = useState({ ...settings, apiKey: '', clearApiKey: false, speechApiKey:'', clearSpeechApiKey:false });
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState('');
  const busyRef=useRef(false),editRevision=useRef(0),previewIntent=useRef(0);
  const [result, setResult] = useState(null);
  const [showKey, setShowKey] = useState(false);
  useEffect(()=>{if(tab!=='speech')preview.stop();},[tab]);
  useEffect(()=>()=>{previewIntent.current++;},[]);
  const set = (name, value) => {editRevision.current++;if(['speechBaseUrl','speechApiKey','clearSpeechApiKey','synthesisModel','synthesisVoice'].includes(name)){previewIntent.current++;preview.stop();}setDraft(previous => ({ ...previous, [name]: value }));};
  const save = async () => {
    const revision=editRevision.current,submitted=draft;
    const input = { baseUrl: (draft.baseUrl || '').trim(), model: (draft.model || '').trim(), systemPrompt: draft.systemPrompt || '', temperature: Number(draft.temperature ?? .7), theme: draft.theme || 'system', speechBaseUrl:draft.speechBaseUrl||'', transcriptionModel: draft.transcriptionModel || '', synthesisModel:draft.synthesisModel||'',synthesisVoice:draft.synthesisVoice||'',dictationAutoSend:draft.dictationAutoSend===true };
    if (draft.apiKey.trim()) input.apiKey = draft.apiKey.trim();
    else if (draft.clearApiKey) input.clearApiKey = true;
    if(draft.speechApiKey.trim())input.speechApiKey=draft.speechApiKey.trim();else if(draft.clearSpeechApiKey)input.clearSpeechApiKey=true;
    const saved = await api.saveSettings(input);
    onSaved(saved);
    setDraft(previous => editRevision.current===revision?({ ...previous, ...saved, apiKey: '', clearApiKey: false, speechApiKey:'', clearSpeechApiKey:false }):({...previous,hasApiKey:saved.hasApiKey,hasSpeechApiKey:saved.hasSpeechApiKey,apiKey:previous.apiKey===submitted.apiKey?'':previous.apiKey,speechApiKey:previous.speechApiKey===submitted.speechApiKey?'':previous.speechApiKey,clearApiKey:previous.clearApiKey===submitted.clearApiKey?false:previous.clearApiKey,clearSpeechApiKey:previous.clearSpeechApiKey===submitted.clearSpeechApiKey?false:previous.clearSpeechApiKey}));
    return saved;
  };
  const perform = async (kind, task) => { if (busyRef.current) return;busyRef.current=true; setBusy(kind); setResult(null); try { await task(); } catch (error) { setResult({ ok: false, message: error.message }); } finally { busyRef.current=false;setBusy(''); } };
  const close = () => { if (!busyRef.current) {previewIntent.current++; onThemePreview(null); onClose(); } };
  return <Modal title="设置" subtitle="让 Muse 按你的方式工作。" onClose={close} className="settings-modal" testId="settings-dialog">
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{[
      ['connection', Server, '模型连接'], ['speech', MessageCircle, '语音输入与声音'], ['preferences', SlidersHorizontal, '使用偏好'], ['data', Database, '数据管理'],
    ].map(([id, Icon, label]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => {previewIntent.current++;preview.stop();setTab(id); setResult(null); }}><Icon size={17} />{label}</button>)}<span className="settings-version">Muse Windows<br />版本 {app.version || '0.1.0'}</span></nav>
      <div className="settings-pane">{tab === 'connection' && <>
        <div className="section-heading"><span className="section-icon"><Server size={20} /></span><div><h3>连接你的模型</h3><p>支持 OpenAI 兼容的模型 API。</p></div></div>
        <label className="field"><span>API 地址</span><input data-testid="settings-base-url" value={draft.baseUrl || ''} onChange={event => set('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} /><small>填写服务地址，也可以填写完整的 /chat/completions 地址。</small></label>
        <label className="field"><span>API 密钥 <span className={`key-status ${draft.clearApiKey ? '' : draft.hasApiKey ? 'saved' : ''}`}>{draft.clearApiKey ? '将清除' : draft.hasApiKey ? '已安全保存' : '尚未设置'}</span></span><div className="input-with-action"><input data-testid="settings-api-key" type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={event => { set('apiKey', event.target.value); set('clearApiKey', false); }} placeholder={draft.hasApiKey && !draft.clearApiKey ? '保持留空，继续使用已保存的密钥' : '输入你的 API Key'} autoComplete="off" spellCheck={false} /><IconButton icon={showKey ? EyeOff : Eye} label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(value => !value)} /></div><small>密钥由桌面程序加密保存在本机，不包含在备份中。</small></label>
        {(draft.hasApiKey || draft.clearApiKey) && <button className="text-button danger-text clear-key" onClick={() => { set('clearApiKey', !draft.clearApiKey); set('apiKey', ''); }}>{draft.clearApiKey ? '撤销清除密钥' : '清除已保存的密钥'}</button>}
        <label className="field"><span>模型名称</span><div className="model-input-row"><input data-testid="settings-model" value={draft.model || ''} list="provider-models" onChange={event => set('model', event.target.value)} placeholder="服务商提供的模型名" spellCheck={false} /><button className="button secondary" disabled={!!busy} data-testid="settings-models" onClick={() => perform('models', async () => { await save(); const list = await api.listModels(); setModels(list); setResult({ ok: true, message: list.length ? `已读取 ${list.length} 个可用模型，可在下方选择。` : '服务已连接，但没有返回模型列表。请手动填写模型名。' }); })}>{busy === 'models' ? <Spinner size={15} /> : <RefreshCw size={15} />}读取模型</button></div><datalist id="provider-models">{models.map(model => <option value={model} key={model} />)}</datalist></label>
        {models.length > 0 && <div className="available-models">{models.slice(0, 30).map(model => <button key={model} className={`model-option ${draft.model === model ? 'selected' : ''}`} onClick={() => set('model', model)} title={model}>{draft.model === model && <Check size={12} />}{model}</button>)}{models.length > 30 && <span className="muted tiny">更多模型可在输入框中搜索选择</span>}</div>}
        <div className="connection-test-row"><button className="button secondary" disabled={!!busy} data-testid="settings-test" onClick={() => perform('test', async () => { await save(); const response = await api.testConnection(); if (response.models) setModels(response.models); setResult(response); })}>{busy === 'test' ? <Spinner size={15} /> : <ShieldCheck size={15} />}保存并测试连接</button><span>将向当前服务发送真实测试请求</span></div>
      </>}
      {tab === 'speech' && <>
        <div className="section-heading"><span className="section-icon"><MessageCircle size={20}/></span><div><h3>把想法说出来</h3><p>录音结束后，由你选择的语音服务识别为文字。</p></div></div>
        <label className="field"><span>语音识别服务地址</span><input data-testid="settings-speech-url" value={draft.speechBaseUrl||''} onChange={event=>set('speechBaseUrl',event.target.value)} placeholder="https://speech-provider.example/v1" spellCheck={false}/><small>服务需支持音频文件转写。聊天模型连接不会自动用于听写。</small></label>
        <label className="field"><span>语音识别模型</span><input data-testid="settings-speech-model" value={draft.transcriptionModel||''} onChange={event=>set('transcriptionModel',event.target.value)} placeholder="服务商提供的语音识别模型名" spellCheck={false}/></label>
        <label className="field"><span>语音服务密钥 <span className="key-status">{draft.clearSpeechApiKey?'将清除':draft.hasSpeechApiKey?'已安全保存':'尚未设置'}</span></span><input data-testid="settings-speech-key" type="password" value={draft.speechApiKey} onChange={event=>{set('speechApiKey',event.target.value);set('clearSpeechApiKey',false);}} placeholder="留空保留已保存的语音密钥；免密本地服务可留空" autoComplete="off" spellCheck={false}/><small>单独加密保存，不会自动使用聊天密钥。</small></label>
        {(draft.hasSpeechApiKey||draft.clearSpeechApiKey)&&<button className="text-button danger-text" onClick={()=>{set('clearSpeechApiKey',!draft.clearSpeechApiKey);set('speechApiKey','');}}>{draft.clearSpeechApiKey?'撤销清除语音密钥':'清除语音密钥'}</button>}
        <label className="speech-auto-send"><input type="checkbox" data-testid="settings-dictation-auto-send" checked={draft.dictationAutoSend===true} onChange={event=>set('dictationAutoSend',event.target.checked)}/>停止录音后自动发送识别文字</label>
        <p className="field-hint">默认先放回草稿审阅，也可在录音时点“识别后发送”。每段最多两分钟；识别请求只发送这段录音，音频不保存到聊天或备份。转写后发送聊天会使用当前资料和模型设置。</p>
        <div className="section-heading voice-preview-heading"><div><h3>声音试听</h3><p>使用上方语音服务和密钥，试听指定声音。</p></div></div>
        <label className="field"><span>声音合成模型</span><input data-testid="settings-synthesis-model" value={draft.synthesisModel||''} onChange={event=>set('synthesisModel',event.target.value)} placeholder="服务商提供的声音合成模型名"/></label>
        <label className="field"><span>声音 ID</span><input data-testid="settings-synthesis-voice" value={draft.synthesisVoice||''} onChange={event=>set('synthesisVoice',event.target.value)} placeholder="服务商提供的声音 ID"/></label>
        <label className="field"><span>试听文字</span><textarea data-testid="settings-sample-text" rows={2} value={sampleText} maxLength={8192} onChange={event=>{previewIntent.current++;preview.stop();setSampleText(event.target.value);}}/><small>仅这段样句发送到语音服务，不附带聊天和文件。合成音频只用于本次试听。</small></label>
        <button type="button" className="button secondary" data-testid="voice-preview-start" disabled={!!busy||!draft.synthesisModel?.trim()||!draft.synthesisVoice?.trim()||!draft.speechBaseUrl?.trim()} onClick={()=>perform('preview',async()=>{const intent=++previewIntent.current;await save();if(intent!==previewIntent.current)return;await preview.play({text:sampleText.trim()?sampleText:'Hi, I’m Muse. Glad to be here!'},{label:'声音试听'});})}>保存并试听</button>
        <AudioControls player={preview} compact/>
      </>}
      {tab === 'preferences' && <>
        <div className="section-heading"><span className="section-icon"><SlidersHorizontal size={20} /></span><div><h3>为你的想法，留一点空间</h3><p>调整助手的回应方式和工作台外观。</p></div></div>
        <label className="field"><span>系统提示词</span><textarea rows={6} data-testid="settings-system-prompt" value={draft.systemPrompt || ''} onChange={event => set('systemPrompt', event.target.value)} placeholder="例如：请用中文清晰地回答。遇到不确定的信息，请直接说明。" /><small>用于设定助手的角色与回答风格，会随请求发送给模型。</small></label>
        <label className="field"><span>创造性 <strong className="field-value">{Number(draft.temperature ?? .7).toFixed(1)}</strong></span><input className="temperature-range" type="range" min="0" max="2" step="0.1" value={draft.temperature ?? .7} onChange={event => set('temperature', Number(event.target.value))} /><div className="range-labels"><span>更稳定</span><span>更有变化</span></div></label>
        <div className="field"><span>外观</span><div className="theme-options">{[['light', Sun, '浅色'], ['dark', Moon, '深色'], ['system', Monitor, '跟随系统']].map(([id, Icon, label]) => <button type="button" key={id} className={draft.theme === id ? 'selected' : ''} data-testid={`theme-${id}`} onClick={() => { set('theme', id); onThemePreview(id); }}><span className={`theme-sample theme-sample-${id}`}><i /><b /><b /></span><span><Icon size={14} />{label}{draft.theme === id && <Check size={13} />}</span></button>)}</div></div>
      </>}
      {tab === 'data' && <>
        <div className="section-heading"><span className="section-icon"><Database size={20} /></span><div><h3>你的资料，留在你的手里</h3><p>管理本机工作台的对话、工作区和备份。</p></div></div>
        <div className="data-action-card"><span className="data-action-icon"><Download size={21} /></span><div><h4>导出工作台备份</h4><p>导出对话、工作区及支持的文件数据。API 密钥不会导出。</p></div><button className="button secondary small" disabled={!!busy} data-testid="backup-export" onClick={() => perform('export', async () => { const result = await api.exportData(); if (!result.cancelled) notify('工作台备份已导出'); })}>{busy === 'export' ? <Spinner size={15} /> : <Download size={15} />}导出</button></div>
        <div className="data-action-card"><span className="data-action-icon"><Upload size={21} /></span><div><h4>导入工作台备份</h4><p>将备份中的内容合并到当前工作台，保留现有资料。</p></div><button className="button secondary small" disabled={!!busy} data-testid="backup-import" onClick={() => perform('import', async () => { const result = await api.importData(); if (result) { onImport(result); notify('备份内容已导入'); } })}>{busy === 'import' ? <Spinner size={15} /> : <Upload size={15} />}导入</button></div>
        <div className="privacy-note"><ShieldCheck size={19} /><div><strong>本地保存，由你掌控</strong><p>对话和导入的文件保存在这台电脑中。发送消息时，相关内容会交给你配置的模型服务处理。</p></div></div>
      </>}
      {result && <div className={`connection-result ${result.ok ? 'success' : 'failure'}`} role="status">{result.ok ? <Check size={17} /> : <AlertCircle size={17} />}<span>{result.message || (result.ok ? '连接成功' : '连接未成功')}</span></div>}
      </div></div>
    <footer className="modal-footer settings-footer"><span className="settings-footer-note"><ShieldCheck size={13} />仅使用你配置的模型服务</span><button className="button secondary" onClick={close} disabled={!!busy}>关闭</button><button className="button primary" disabled={!!busy} data-testid="settings-save" onClick={() => perform('save', async () => { await save(); onThemePreview(null); notify('设置已保存'); })}>{busy === 'save' && <Spinner size={15} />}保存设置</button></footer>
  </Modal>;
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const snapshotRef = useRef(null);
  const [bootError, setBootError] = useState('');
  const [route, writeRoute] = useState({ type: 'welcome', workspaceId: null });
  const routeTarget = useRef(route); routeTarget.current=route;
  const recoveryEpoch = useRef(0);
  const setRoute = update => {const next=typeof update==='function'?update(routeTarget.current):update;if(next.type!==routeTarget.current.type||next.id!==routeTarget.current.id||next.workspaceId!==routeTarget.current.workspaceId)recoveryEpoch.current++;routeTarget.current=next;writeRoute(next);};
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.hash === '#settings');
  const [searchOpen, setSearchOpen] = useState(false);
  const [artifactsOpen, writeArtifactsOpen] = useState(false);
  const [activeArtifactId, writeActiveArtifactId] = useState(null);
  const artifactTarget = useRef({open:artifactsOpen,id:activeArtifactId});artifactTarget.current={open:artifactsOpen,id:activeArtifactId};
  const setArtifactsOpen = update => {const open=typeof update==='function'?update(artifactTarget.current.open):update;if(open!==artifactTarget.current.open)recoveryEpoch.current++;artifactTarget.current={...artifactTarget.current,open};writeArtifactsOpen(open);};
  const setActiveArtifactId = update => {const id=typeof update==='function'?update(artifactTarget.current.id):update;if(id!==artifactTarget.current.id)recoveryEpoch.current++;artifactTarget.current={...artifactTarget.current,id};writeActiveArtifactId(id);};
  const artifactVisibility = useRef(false); artifactVisibility.current = artifactsOpen;
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [knowledgeOpen,setKnowledgeOpen]=useState(false);
  const [draftProfiles,setDraftProfiles]=useState({});
  const [contextPreview,setContextPreview]=useState(null);
  const [entity, setEntity] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [filePreviewId, selectFilePreview] = useState(null);
  const [filePreviewIds, setFilePreviewIds] = useState([]);
  const [newFile, setNewFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);
  const [imageViewer, setImageViewer] = useState(null);
  const openFileTab = id => { if (id) setFilePreviewIds(previous => previous.includes(id) ? previous : [...previous, id]); selectFilePreview(id); };
  const setFilePreviewId = (id, ids = [id], wrap = false, kind = 'visual') => {
    const file = data.files.find(value => value.id === id);
    if (file && isPreviewMediaFile(file.name)) setImageViewer({ initialId: id, ids: Array.isArray(ids) ? [...ids] : [id], wrap, kind });
    else openFileTab(id);
  };
  const openMessageFile = (file, message) => {
    if (isAudioFile(file)) playAudioAttachment(file, message);
    else if (isVideoFile(file.name)) setFilePreviewId(file.id, [file.id], false, 'video');
    else if (isImageFile(file.name)) setFilePreviewId(file.id, message.attachmentIds || [file.id], true, 'image');
    else openFileTab(file.id);
  };
  const closeFilePreview = id => { const remaining = filePreviewIds.filter(value => value !== id); setFilePreviewIds(remaining); if (filePreviewId === id) selectFilePreview(remaining.at(-1) || null); };
  const [menu, setMenu] = useState(null);
  const [drafts, writeDrafts] = useState({});
  const [attachments, writeAttachments] = useState({});
  const [agentModes, setAgentModes] = useState({});
  const [quotes, writeQuotes] = useState({});
  const [artifactDraftContexts, writeArtifactDraftContexts] = useState({});
  const [panelDraftContexts, writePanelDraftContexts] = useState({});
  const [admissionRecoveries, setAdmissionRecoveries] = useState([]);
  const draftState = useRef({ drafts, attachments, artifactDraftContexts, panelDraftContexts, quotes });
  draftState.current = { drafts, attachments, artifactDraftContexts, panelDraftContexts, quotes };
  // IPC can resolve before React paints. Keep the admission/recovery guards in
  // step with every draft edit, including imports, quotes and route promotion.
  const writeDraftField = (field,write,update) => {const next=typeof update==='function'?update(draftState.current[field]):update;draftState.current={...draftState.current,[field]:next};write(next);};
  const setDrafts = update => writeDraftField('drafts',writeDrafts,update);
  const setAttachments = update => writeDraftField('attachments',writeAttachments,update);
  const setQuotes = update => writeDraftField('quotes',writeQuotes,update);
  const setArtifactDraftContexts = update => writeDraftField('artifactDraftContexts',writeArtifactDraftContexts,update);
  const setPanelDraftContexts = update => writeDraftField('panelDraftContexts',writePanelDraftContexts,update);
  const modeRevisions = useRef(new Map());
  const [importing, setImporting] = useState(false);
  const [pendingChats, setPendingChats] = useState(new Set());
  const [admittingKeys, setAdmittingKeys] = useState(new Set());
  const sendAdmissions = useRef(new Map());
  const queuedAdmissions = useRef(new Map());
  const restoredAdmissions = useRef(new Set());
  const composerEnvironment = useRef(null);
  const annotationPromotion = useRef(null);
  const queueActions = useRef(new Map());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [themePreview, setThemePreview] = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragCount = useRef(0);
  const scroll = useRef(null);
  const jumpSequence = useRef(0);
  const followBottom = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const deferredDeltas = useRef(new Map());
  const notify = useCallback((message, kind = 'success') => { clearTimeout(toastTimer.current); setToast({ message: String(message || '操作完成'), kind }); toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6500 : 3200); }, []);
  const chatAudio=useAudioPlayback('chat',notify);

  const replaceSnapshot = useCallback(incoming => {
    if (!incoming) return;
    setSnapshot(previous => {
      const next = { ...EMPTY, ...incoming, settings: incoming.settings || {} };
      next.chats = next.chats.map(chat => ({ ...chat, messages: (chat.messages || []).map(message => {
        const pending = deferredDeltas.current.get(`${chat.id}:${message.id}`);
        if (!pending) return message;
        deferredDeltas.current.delete(`${chat.id}:${message.id}`);
        return message.status === 'streaming' ? { ...message, content: pending.content ?? message.content } : message;
      }) }));
      snapshotRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!api) { setBootError('请从 Muse Windows 桌面程序打开工作台。'); return; }
    let alive = true, initialized = false;
    const queue = [];
    const apply = event => {
      if (!alive || !event) return;
      if (event.type === 'snapshot') { replaceSnapshot(event.snapshot); return; }
      if (event.type === 'open-chat'&&event.chatId) {setRoute({type:'chat',id:event.chatId});return;}
      if (event.type === 'runtime-error') {notify(event.message,'error');return;}
      if (event.type === 'schedule-notification') {notify(event.title,'info');return;}
      if (event.type === 'chat-delta') {
        setSnapshot(previous => {
          if (!previous) { deferredDeltas.current.set(`${event.chatId}:${event.messageId}`, event); return previous; }
          let found = false;
          const chats = previous.chats.map(chat => chat.id !== event.chatId ? chat : { ...chat, messages: chat.messages.map(message => {
            if (message.id !== event.messageId) return message;
            found = true;
            if (message.status !== 'streaming') return message;
            return { ...message, content: typeof event.content === 'string' ? event.content : message.content + (event.delta || '') };
          }) });
          if (!found) deferredDeltas.current.set(`${event.chatId}:${event.messageId}`, event);
          const next = { ...previous, chats };
          snapshotRef.current = next;
          return next;
        });
      }
      if (['chat-complete', 'chat-error', 'chat-cancelled'].includes(event.type)) {
        deferredDeltas.current.delete(`${event.chatId}:${event.messageId}`);
        setPendingChats(previous => { const next = new Set(previous); next.delete(event.chatId); return next; });
        if (event.chat) setSnapshot(previous => {
          if (!previous) return previous;
          const next = { ...previous, chats: upsert(previous.chats, event.chat) };
          snapshotRef.current = next;
          return next;
        });
      }
    };
    const unsubscribe = api.subscribe(event => { if (!initialized) queue.push(event); else apply(event); });
    api.bootstrap().then(value => { if (!alive) return; replaceSnapshot(value); initialized = true; queue.splice(0).forEach(apply); }).catch(error => { if (alive) setBootError(error.message || '无法打开工作台'); });
    return () => { alive = false; unsubscribe?.(); clearTimeout(toastTimer.current); };
  }, [replaceSnapshot]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { const theme = themePreview || snapshot?.settings?.theme || 'system'; document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [snapshot?.settings?.theme, themePreview]);

  const data = snapshot || EMPTY;
  const chat = route.type === 'chat' ? data.chats.find(item => item.id === route.id) : null;
  const workspace = route.type === 'workspace' ? data.workspaces.find(item => item.id === route.id) : chat?.workspaceId ? data.workspaces.find(item => item.id === chat.workspaceId) : route.workspaceId ? data.workspaces.find(item => item.id === route.workspaceId) : null;
  const workspaceId = workspace?.id || null;
  const composerKey = chat ? `chat:${chat.id}` : `new:${workspaceId || 'personal'}`;
  const composerIdentity = useRef(composerKey); composerIdentity.current = composerKey;
  const candidateProfileId=chat?.profileId||(!chat?draftProfiles[workspaceId||'global']||'':'');
  const selectedProfileId=data.agentProfiles.some(item=>item.id===candidateProfileId&&item.workspaceId===workspaceId)?candidateProfileId:'';
  const useTools = agentModes[composerKey] ?? !!chat?.messages.filter(message => message.role === 'assistant').at(-1)?.agentMode;
  const draft = drafts[composerKey] || '';
  const attachedIds = attachments[composerKey] || [];
  const attachedFiles = attachedIds.map(id => data.files.find(file => file.id === id)).filter(Boolean);
  const quote = chat?.messages.find(message => message.id === quotes[composerKey] && !message.isDeleted);
  const visibleArtifact = artifactsOpen && data.artifacts.find(item => item.id === activeArtifactId && (item.workspaceId ?? null) === workspaceId);
  const activePanel = panelDraftContexts[composerKey] || (visibleArtifact ? {kind:'artifact',artifactId:visibleArtifact.id,artifactName:visibleArtifact.name} : null);
  const configured = !!data.settings.baseUrl && !!data.settings.model;
  const sending = admittingKeys.has(composerKey);
  // The queue receipt can beat its snapshot to the renderer. Retain its client
  // identity until a later snapshot either shows failure or its admitted row.
  for(const [identity,queued]of queuedAdmissions.current){const target=data.chats.find(x=>x.id===queued.chatId),pending=data.pendingSends.find(x=>x.clientMessageId===identity);if(!target||pending&&pending.state!=='queued'||target.messages.some(x=>x.id===identity))queuedAdmissions.current.delete(identity);}
  composerEnvironment.current = {key:composerKey,workspaceId,profileId:selectedProfileId||null,useTools:!!useTools,activePanel,modeRevision:modeRevisions.current.get(composerKey)||0};
  const busy = sending || !!chat && (pendingChats.has(chat.id) || chat.messages.some(message => message.status === 'streaming'));
  const sortedChats = useMemo(() => sortChats(data.chats), [data.chats]);
  const openRoute = useCallback(next => { setRoute(next.messageId ? { ...next, jumpToken: ++jumpSequence.current } : next); setMenu(null); if (window.innerWidth < 900 || artifactVisibility.current) setSidebarOpen(false); followBottom.current = !next.messageId; setShowScrollBottom(false); }, []);
  const newChat = useCallback((scope = null) => { openRoute({ type: 'welcome', workspaceId: typeof scope === 'string' ? scope : null }); setTimeout(() => window.dispatchEvent(new Event('muse-focus-composer')), 60); }, [openRoute]);

  useEffect(() => {
    const key = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!settingsOpen && !entity && !confirm) newChat(workspaceId); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [newChat, workspaceId, settingsOpen, entity, confirm]);
  useEffect(() => { if (!menu) return; const close = event => { if (!event.target.closest('[data-menu-root]')) setMenu(null); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [menu]);
  useEffect(() => { if (route.type === 'chat' && snapshot && !chat || route.type === 'workspace' && snapshot && !workspace) setRoute({ type: 'welcome', workspaceId: null }); }, [route, snapshot, chat, workspace]);
  const lastMessage = chat?.messages.at(-1);
  useLayoutEffect(() => { if (scroll.current && followBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat?.id, chat?.messages.length, lastMessage?.content, lastMessage?.status]);
  useLayoutEffect(() => {
    if (!route.messageId || !chat) return;
    const target = [...(scroll.current?.querySelectorAll('[data-message-id]') || [])].find(element => element.dataset.messageId === route.messageId);
    if (target) { followBottom.current = false; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
  }, [route.messageId, route.jumpToken, chat?.id, chat?.messages.length]);

  const updateDraft = value => { draftState.current.drafts = { ...draftState.current.drafts, [composerKey]: value }; setDrafts(previous => ({ ...previous, [composerKey]: value })); };
  const addFiles = async (dropped, scope = workspaceId, attach = true) => {
    if (importing) return;
    setImporting(true);
    const key = composerKey;
    try {
      const imported = dropped ? await api.importDroppedFiles(dropped, scope) : await api.importFiles({ workspaceId: scope });
      if (imported?.length) {
        setSnapshot(previous => ({ ...previous, files: imported.reduce((files, file) => upsert(files, file), previous.files) }));
        if (attach) setAttachments(previous => ({ ...previous, [key]: [...new Set([...(previous[key] || []), ...imported.map(file => file.id)])] }));
        else notify(`已添加 ${imported.length} 份资料`);
      }
    } catch (error) { notify(error.message, 'error'); } finally { setImporting(false); }
  };
  const send = async (inputText, annotation) => {
    const submittedText=typeof inputText==='string'?inputText:draft;
    if (sendAdmissions.current.has(composerKey) || !submittedText.trim() && !(annotation ? 0 : attachedIds.length)) return false;
    if (!configured) { setSettingsOpen(true); notify('连接你的模型后，就可以开始对话了', 'info'); return false; }
    if(annotation)annotationPromotion.current=null;
    const key = composerKey, text = submittedText, files = annotation ? [] : [...attachedIds], quotedId = quote?.id, clientMessageId = crypto.randomUUID();
    const artifactContext = annotation || artifactDraftContexts[key];
    // Capture the visible resource at admission. Later panel changes cannot
    // silently rebind queued messages or an interrupted draft.
    const panelContext = panelDraftContexts[key] || (!document.hidden ? activePanel : null);
    const admission={id:clientMessageId,key,restoreKey:key,chatId:chat?.id||null,phase:chat?'submit':'create',cancelled:false,annotation:!!annotation,modeRevision:modeRevisions.current.get(key)||0,
      intent:{id:clientMessageId,clientMessageId,chatId:chat?.id||null,draftKey:key,content:text,attachmentIds:files,useTools:!!useTools,workspaceId,profileId:selectedProfileId||null,...(quotedId?{replyToMessageId:quotedId}:{}),...(artifactContext?{artifactContext}:{}),...(panelContext?{activePanel:panelContext}:{}),localOnly:true,state:'failed',error:'已停止发送，可恢复为草稿。'}};
    sendAdmissions.current.set(key,admission);setAdmittingKeys(previous=>new Set(previous).add(key));
    // Remove only this submitted draft now. New typing during admission stays
    // separate and cannot be erased by a later IPC response.
    if (!annotation) {
      setDrafts(previous => ({ ...previous, [key]: previous[key] === text || previous[key] === draft ? '' : previous[key] }));
      setAttachments(previous => ({ ...previous, [key]: (previous[key] || []).filter(id => !files.includes(id)) }));
      setQuotes(previous => previous[key] === quotedId ? { ...previous, [key]: null } : previous);
      setArtifactDraftContexts(previous => previous[key] === artifactContext ? { ...previous, [key]: null } : previous);
      setPanelDraftContexts(previous => previous[key] === panelContext ? { ...previous, [key]: null } : previous);
      draftState.current = {...draftState.current,drafts:{...draftState.current.drafts,[key]:''},attachments:{...draftState.current.attachments,[key]:[]},quotes:{...draftState.current.quotes,[key]:null},artifactDraftContexts:{...draftState.current.artifactDraftContexts,[key]:null},panelDraftContexts:{...draftState.current.panelDraftContexts,[key]:null}};
    }
    let target = chat, createdTarget = false, restoreKey = key;
    try {
      if (!target) {
        target = await api.createChat({ workspaceId,...(selectedProfileId?{profileId:selectedProfileId}:{}) }); const nextKey = `chat:${target.id}`;
        createdTarget = true;
        admission.chatId=target.id;
        if(admission.cancelled)return false;
        if(!annotation && composerIdentity.current===key){
        restoreKey=nextKey;
        admission.restoreKey=nextKey;admission.intent.draftKey=nextKey;admission.intent.chatId=target.id;
        sendAdmissions.current.set(nextKey,admission);setAdmittingKeys(previous=>new Set(previous).add(nextKey));
        setDrafts(previous => ({ ...previous, [nextKey]: previous[key] || '', [key]: '' }));
        setAttachments(previous => ({ ...previous, [nextKey]: previous[key] || [], [key]: [] }));
        setQuotes(previous => ({ ...previous, [nextKey]: previous[key] || null, [key]: null }));
        setArtifactDraftContexts(previous => ({ ...previous, [nextKey]: previous[key] || null, [key]: null }));
        setPanelDraftContexts(previous => ({ ...previous, [nextKey]: previous[key] || null, [key]: null }));
        setAgentModes(previous => ({ ...previous, [nextKey]: useTools }));
        setSnapshot(previous => ({ ...previous, chats: upsert(previous.chats, target) })); openRoute({ type: 'chat', id: target.id });
        }
      }
      if(admission.cancelled)return false;
      admission.phase='submit';admission.chatId=target.id;
      setPendingChats(previous => new Set(previous).add(target.id));
      followBottom.current = true;
      const receipt=await api.sendMessage({ chatId: target.id, content: text, attachmentIds: files, useTools, clientMessageId, ...(artifactContext ? { artifactContext } : {}), ...(panelContext ? {activePanel:panelContext} : {}), ...(quotedId ? { replyToMessageId: quotedId } : {}) });
      clearAdmissionPending(target.id,admission);
      if(receipt?.queued)queuedAdmissions.current.set(clientMessageId,{chatId:target.id,queueId:receipt.queueId});
      if(admission.cancelled){const outcome=await admission.cancelPromise;if(outcome?.state==='cancelled')return false;}
      if(annotation&&createdTarget)annotationPromotion.current={originKey:key,target};
      return true;
    } catch (error) {
      if (target) clearAdmissionPending(target.id,admission);
      if(admission.cancelled){await admission.cancelPromise;return false;}
      let admitted = false;
      try { admitted = target && (await api.bootstrap()).chats.find(item => item.id === target.id)?.messages.some(message => message.id === clientMessageId); } catch { /* Preserve input if admission cannot be confirmed. */ }
      if (!admitted && !annotation) {
        const intent={id:clientMessageId,chatId:target?.id||null,draftKey:restoreKey,content:text,attachmentIds:files,useTools,...(quotedId?{replyToMessageId:quotedId}:{}),...(artifactContext?{artifactContext}:{}),...(panelContext?{activePanel:panelContext}:{}),state:'failed',error:'尚未发送，恢复后可重试',localOnly:true};
        if((artifactContext||panelContext)&&draftOccupied(restoreKey))setAdmissionRecoveries(previous=>[...previous,intent]);
        else restoreIntent(intent,restoreKey,true);
      }
      notify(error.message, 'error');
      if(admitted&&annotation&&createdTarget)annotationPromotion.current={originKey:key,target};
      return !!admitted;
    } finally { releaseAdmission(admission); }
  };
  const annotationSent=()=>{
    const promotion=annotationPromotion.current;annotationPromotion.current=null;
    if(promotion?.originKey===composerKey){
      const key=promotion.originKey,nextKey=`chat:${promotion.target.id}`;
      setDrafts(previous=>({...previous,[nextKey]:previous[key]||'',[key]:''}));
      setAttachments(previous=>({...previous,[nextKey]:previous[key]||[],[key]:[]}));
      setQuotes(previous=>({...previous,[nextKey]:previous[key]||null,[key]:null}));
      setArtifactDraftContexts(previous=>({...previous,[nextKey]:previous[key]||null,[key]:null}));
      setPanelDraftContexts(previous=>({...previous,[nextKey]:previous[key]||null,[key]:null}));
      setAgentModes(previous=>({...previous,[nextKey]:previous[key]??useTools}));
      openRoute({type:'chat',id:promotion.target.id});
    }
  };
  const releaseAdmission = admission => {
    const removed=[];for(const [key,value]of sendAdmissions.current)if(value===admission){sendAdmissions.current.delete(key);removed.push(key);}
    if(removed.length)setAdmittingKeys(previous=>{const next=new Set(previous);for(const key of removed)if(!sendAdmissions.current.has(key))next.delete(key);return next;});
  };
  const clearAdmissionPending = (chatId,admission) => {const current=sendAdmissions.current.get(`chat:${chatId}`);if(current&&current!==admission)return;setPendingChats(previous=>{const next=new Set(previous);next.delete(chatId);return next;});};
  const retainLocalRecovery = intent => setAdmissionRecoveries(previous=>previous.some(x=>(x.clientMessageId||x.id)===(intent.clientMessageId||intent.id))?previous:[...previous,intent]);
  const recoverCancelled = async (intent,key,modeRevision,targetRevision) => {
    const identity=intent.clientMessageId||intent.id,env=composerEnvironment.current;
    if(restoredAdmissions.current.has(identity))return false;
    const target=routeTarget.current,currentKey=target.type==='chat'?`chat:${target.id}`:`new:${(target.type==='workspace'?target.id:target.workspaceId)||'personal'}`;
    const visible=artifactTarget.current.open&&(snapshotRef.current||data).artifacts.find(x=>x.id===artifactTarget.current.id&&(x.workspaceId??null)===(intent.workspaceId??null));
    const panel=draftState.current.panelDraftContexts[key]||(visible?{artifactId:visible.id}:null);
    const samePanel=(panel?.artifactId||null)===(intent.activePanel?.artifactId||null);
    const empty=!(draftState.current.drafts[key]?.length||draftState.current.attachments[key]?.length||draftState.current.quotes[key]||draftState.current.artifactDraftContexts[key]||draftState.current.panelDraftContexts[key]);
    if(!env||env.key!==key||currentKey!==key||targetRevision!==recoveryEpoch.current||!empty||!samePanel||env.workspaceId!==(intent.workspaceId??null)||env.profileId!==(intent.profileId??null)||env.useTools!==!!intent.useTools||(modeRevisions.current.get(key)||0)!==modeRevision){if(intent.localOnly)retainLocalRecovery({...intent,draftKey:key});return false;}
    restoredAdmissions.current.add(identity);restoreIntent(intent,key);
    setAdmissionRecoveries(previous=>previous.filter(x=>(x.clientMessageId||x.id)!==identity));
    if(!intent.localOnly)try{await api.cancelQueuedMessage({id:intent.id});}catch{notify('已恢复到草稿；待发送记录仍保留，可手动移除。','info');}
    window.dispatchEvent(new Event('muse-focus-composer'));return true;
  };
  const stop = () => {
    const key=composerKey,admission=sendAdmissions.current.get(key),revision=modeRevisions.current.get(key)||0,targetRevision=recoveryEpoch.current,isRetry=admission?.phase==='retry';
    const ids=new Set(data.pendingSends.filter(x=>x.chatId===chat?.id&&x.state==='queued').map(x=>x.clientMessageId).filter(Boolean));
    for(const [identity,queued]of queuedAdmissions.current)if(queued.chatId===chat?.id)ids.add(identity);
    if(chat?.messages.some(x=>x.status==='streaming')){const user=[...chat.messages].reverse().find(x=>x.role==='user'&&!x.isDeleted);if(user)ids.add(user.id);}
    if(admission){admission.cancelled=true;if(!isRetry)ids.add(admission.id);}
    const cancel=admission&&!isRetry?Promise.resolve().then(()=>api.cancelSendAdmission({clientMessageId:admission.id,...(admission.chatId?{chatId:admission.chatId}:{})})):Promise.resolve(null);
    const requestId=data.activeRequests?.find(x=>x.chatId===chat?.id)?.requestId;
    const stopping=chat?Promise.resolve().then(()=>api.stopGeneration({chatId:chat.id,clientMessageIds:[...ids],...(requestId?{requestId}:{})})):Promise.resolve(null);
    // Before createChat returns, this UI has never called sendMessage. Restore
    // locally now; the cancelled token fences its eventual continuation.
    if(admission?.phase==='create'&&!admission.annotation)void recoverCancelled(admission.intent,admission.restoreKey,admission.modeRevision,targetRevision);
    const pending=Promise.allSettled([cancel,stopping]).then(async results=>{
      const first=results[0].status==='fulfilled'?results[0].value:null,global=results[1].status==='fulfilled'?results[1].value:null;
      for(const result of results)if(result.status==='rejected')notify(result.reason?.message||'停止结果尚未确认，请查看消息记录。','error');
      if(first?.state==='cancelled'&&admission?.chatId)clearAdmissionPending(admission.chatId,admission);
      if(global?.state==='cancelled'&&chat)clearAdmissionPending(chat.id,admission);
      const recovered=[...(first?.recoverable||[]),...(global?.recoverable||[])];
      for(const identity of ids)queuedAdmissions.current.delete(identity);
      for(const intent of recovered){const own=admission&&intent.clientMessageId===admission.id;if(own&&admission.annotation)continue;await recoverCancelled(intent,own?admission.restoreKey:`chat:${intent.chatId}`,own?admission.modeRevision:revision,targetRevision);}
      if(admission&&first?.state==='cancelled'&&first.unseen&&!admission.annotation&&!isRetry)await recoverCancelled(admission.intent,admission.restoreKey,admission.modeRevision,targetRevision);
      return first||global||{state:'uncertain'};
    });
    if(admission){admission.cancelPromise=pending;releaseAdmission(admission);}return pending;
  };
  const draftOccupied = key => !!(draftState.current.drafts[key]?.trim() || draftState.current.attachments[key]?.length || draftState.current.artifactDraftContexts[key] || draftState.current.panelDraftContexts[key] || draftState.current.quotes[key]);
  const restoreIntent = (intent,key,prepend=false) => {
    const previous=draftState.current;
    const next={drafts:{...previous.drafts,[key]:previous.drafts[key]?(prepend?`${intent.content}\n\n${previous.drafts[key]}`:`${previous.drafts[key]}\n\n${intent.content}`):intent.content},attachments:{...previous.attachments,[key]:[...new Set([...(previous.attachments[key]||[]),...intent.attachmentIds.filter(id=>data.files.some(file=>file.id===id))])]},quotes:{...previous.quotes,[key]:previous.quotes[key]||intent.replyToMessageId||null},artifactDraftContexts:{...previous.artifactDraftContexts,[key]:intent.artifactContext||previous.artifactDraftContexts[key]||null},panelDraftContexts:{...previous.panelDraftContexts,[key]:intent.activePanel||previous.panelDraftContexts[key]||null}};
    draftState.current=next;
    setDrafts(next.drafts);setAttachments(next.attachments);setQuotes(next.quotes);setArtifactDraftContexts(next.artifactDraftContexts);setPanelDraftContexts(next.panelDraftContexts);
  };
  const removeQueued = async (item, restore = false) => {
    const key = item.localOnly ? item.draftKey : `chat:${item.chatId}`, modeRevision = modeRevisions.current.get(key) || 0;
    if(restore&&queueActions.current.has(item.id))return;
    const token={};queueActions.current.set(item.id,token);
    try {
      const contextual=!!(item.artifactContext||item.activePanel);
      if (restore && contextual && draftOccupied(key)) throw new Error('当前草稿已有内容，请先处理草稿，再恢复带应用引用的消息。');
      const preserve=restore&&contextual;
      const intent = item.localOnly ? item : await api.cancelQueuedMessage({ id: item.id,...(preserve?{preserveForRestore:true}:{}) });
      if(queueActions.current.get(item.id)!==token)return;
      if (restore) {
        if(preserve&&draftOccupied(key))throw new Error('恢复期间草稿已有新内容，原消息仍保留在待发送列表。');
        const hasDraft = !!draftState.current.drafts[key]?.trim() || (draftState.current.attachments[key] || []).length > 0;
        restoreIntent(intent,key);
        restoredAdmissions.current.add(intent.clientMessageId||intent.id);
        if (!hasDraft && (modeRevisions.current.get(key) || 0) === modeRevision) setAgentModes(previous => ({ ...previous, [key]: intent.useTools }));
        if(preserve&&!item.localOnly){try{await api.cancelQueuedMessage({id:item.id});}catch{notify('已恢复到草稿；待发送记录未移除，可以稍后手动移除。','info');return;}}
        notify('已恢复到草稿，可以修改后发送'); window.dispatchEvent(new Event('muse-focus-composer'));
      }
      if(item.localOnly)setAdmissionRecoveries(previous=>previous.filter(value=>value.id!==item.id));
    } catch (error) { notify(error.message, 'error'); }
    finally{if(queueActions.current.get(item.id)===token)queueActions.current.delete(item.id);}
  };
  const retry = async () => {
    if(!chat||busy||sendAdmissions.current.has(composerKey))return;
    const admission={id:crypto.randomUUID(),key:composerKey,restoreKey:composerKey,chatId:chat.id,phase:'retry',cancelled:false};
    sendAdmissions.current.set(composerKey,admission);setAdmittingKeys(previous=>new Set(previous).add(composerKey));setPendingChats(previous=>new Set(previous).add(chat.id));
    try{const receipt=await api.retryMessage({chatId:chat.id});if(admission.cancelled&&receipt?.requestId)await api.stopGeneration({chatId:chat.id,requestId:receipt.requestId,clientMessageIds:[]});}
    catch(error){if(!admission.cancelled)notify(error.message,'error');}
    finally{clearAdmissionPending(chat.id,admission);releaseAdmission(admission);}
  };
  const saveEntity = async value => {
    if (value.kind === 'workspace') {
      const saved = value.id ? await api.updateWorkspace({ id: value.id, name: value.name, description: value.description, color: value.color }) : await api.createWorkspace({ name: value.name, description: value.description, color: value.color });
      setSnapshot(previous => ({ ...previous, workspaces: upsert(previous.workspaces, saved) }));
      if (!value.id) openRoute({ type: 'workspace', id: saved.id });
      notify(value.id ? '工作区已更新' : '工作区已创建');
    } else { const saved = await api.updateChat({ id: value.id, title: value.name }); setSnapshot(previous => ({ ...previous, chats: upsert(previous.chats, saved) })); }
    setEntity(null);
  };
  const updateChat = async input => { try { const saved = await api.updateChat(input); setSnapshot(previous => ({ ...previous, chats: upsert(previous.chats, saved) })); } catch (error) { notify(error.message, 'error'); } setMenu(null); };
  const askRemoveFile = file => setConfirm({ title: '移除这份文件？', body: `“${file.name}”及其未保存修改将从工作台中移除。你电脑中的原始文件不会改变。`, action: '移除文件', run: async () => { replaceSnapshot(await api.removeFile({ id: file.id })); setAttachments(previous => Object.fromEntries(Object.entries(previous).map(([key, ids]) => [key, ids.filter(id => id !== file.id)]))); closeFilePreview(file.id); } });
  const quoteMessage = message => { setQuotes(previous => ({ ...previous, [composerKey]: message.id })); window.dispatchEvent(new Event('muse-focus-composer')); };
  const playAudioAttachment=(file,message)=>{if(chatAudio.view?.owner?.fileId===file.id){if(chatAudio.view.state==='playing')chatAudio.pause();else if(chatAudio.view.state==='paused')chatAudio.resume();return;}chatAudio.play({chatId:chat.id,messageId:message.id,fileId:file.id},{label:file.name});};
  const askDeleteTurn = message => setConfirm({ title: '删除这条消息？', body: '这条用户消息的正文、附件关联、应用引用、页面选区和引用摘录将被清除，并保留删除占位。其他回复和已经完成的文件操作记录会保留。', action: '删除消息', run: async () => {
    const result = await api.deleteTurn({ chatId: chat.id, messageId: message.id });
    setSnapshot(previous => ({ ...previous, chats: upsert(previous.chats, result.chat) }));
    setQuotes(previous => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, value === message.id ? null : value])));
  } });
  const askDeleteChat = item => { setMenu(null); setConfirm({ title: '删除这段对话？', body: `“${item.title}”中的消息将从工作台删除。`, action: '删除对话', run: async () => { replaceSnapshot(await api.deleteChat({ id: item.id })); if (chat?.id === item.id) newChat(item.workspaceId); } }); };
  const askDeleteWorkspace = item => { setMenu(null); setConfirm({ title: '删除这个工作区？', body: `“${item.name}”将被删除，其中的对话和文件会保留在个人工作台。`, action: '删除工作区', run: async () => { replaceSnapshot(await api.deleteWorkspace({ id: item.id })); newChat(); } }); };
  const exportChat = async format => { setMenu(null); try { const result = await api.exportChat({ chatId: chat.id, format }); if (!result.cancelled) notify('对话已导出'); } catch (error) { notify(error.message, 'error'); } };
  const composerProps = { value: draft, onChange: updateDraft, attachedFiles, onRemoveAttachment: id => setAttachments(previous => ({ ...previous, [composerKey]: attachedIds.filter(item => item !== id) })), onImport: () => addFiles(), onDrop: files => { dragCount.current = 0; setDragging(false); if (files.length) addFiles(files); }, onSend: send, onStop: stop, busy, admitting: sending, importing, model: data.settings.model, configured, useTools, onToolsChange: enabled => { modeRevisions.current.set(composerKey, (modeRevisions.current.get(composerKey) || 0) + 1); setAgentModes(previous => ({ ...previous, [composerKey]: enabled })); }, quote, onClearQuote: () => setQuotes(previous => ({ ...previous, [composerKey]: null })), historyMessages: chat?.messages, historyKey: composerKey };
  composerProps.artifactContext=artifactDraftContexts[composerKey];composerProps.onClearArtifactContext=()=>setArtifactDraftContexts(previous=>({...previous,[composerKey]:null}));
  composerProps.activePanel=activePanel;composerProps.onClearActivePanel=panelDraftContexts[composerKey]?()=>setPanelDraftContexts(previous=>({...previous,[composerKey]:null})):undefined;
  composerProps.knowledgeControl=<div className="knowledge-chatbar"><button className="text-button" data-testid="knowledge-open" onClick={()=>setKnowledgeOpen({workspaceId,workspaceName:workspace?.name})}><Database size={13}/>知识与技能</button><select aria-label="聊天知识配置" data-testid="chat-profile" value={selectedProfileId} disabled={busy||sending} onChange={async event=>{const profileId=event.target.value||null;try{if(chat)await api.updateChat({id:chat.id,profileId});else setDraftProfiles(previous=>({...previous,[workspaceId||'global']:profileId}));}catch(error){notify(error.message,'error');}}}><option value="">不附加知识配置</option>{data.agentProfiles.filter(item=>item.workspaceId===workspaceId).map(item=><option key={item.id} value={item.id} disabled={item.needsReview}>{item.name}{item.needsReview?'（待确认）':''}</option>)}</select>{chat&&selectedProfileId&&<button className="text-button" data-testid="context-preview" onClick={async()=>{try{setContextPreview(await api.previewSelectedContext({chatId:chat.id,useTools}));}catch(error){notify(error.message,'error');}}}>查看将发送的知识</button>}</div>;
  composerProps.dictationProps={owner:{scopeKey:composerKey,workspaceId,chatId:chat?.id||null,profileId:selectedProfileId||null,useTools},contextKey:JSON.stringify([composerKey,workspaceId,selectedProfileId,data.agentProfiles.find(item=>item.id===selectedProfileId)?.revision,useTools,attachedIds,quote?.id,artifactDraftContexts[composerKey],activePanel,Object.fromEntries(Object.entries(data.settings).filter(([key])=>!['synthesisModel','synthesisVoice'].includes(key)))]),settings:data.settings,onConfigure:()=>setSettingsOpen(true),notify};
  const pendingSendItems=[...data.pendingSends.filter(item=>chat&&item.chatId===chat.id),...admissionRecoveries.filter(item=>item.draftKey===composerKey)];
  const pendingSendList=<PendingSends items={pendingSendItems} onRestore={item=>removeQueued(item,true)} onCancel={item=>removeQueued(item)}/>;

  if (!snapshot) return <div className="boot-screen"><Brand size={56} /><h1>Muse</h1>{bootError ? <><p className="boot-error">{bootError}</p><button className="button secondary" onClick={() => window.location.reload()}><RefreshCw size={15} />重新打开</button></> : <p><Spinner size={16} />正在打开你的工作台…</p>}</div>;

  const renderChatItem = item => <div className={`sidebar-chat ${chat?.id === item.id ? 'active' : ''}`} key={item.id} data-menu-root>
    <button className="sidebar-chat-main" onClick={() => openRoute({ type: 'chat', id: item.id })} title={item.title}><span className="chat-row-icon">{item.pinned ? <Pin size={13} /> : <MessageCircle size={15} />}</span><span>{item.title || '新对话'}</span>{item.messages.some(message => message.status === 'streaming') && <span className="streaming-dot" />}</button>
    <IconButton icon={MoreHorizontal} label={`对话选项 ${item.title}`} className="chat-more" onClick={() => setMenu(menu === item.id ? null : item.id)} />
    {menu === item.id && <div className="popmenu sidebar-popmenu"><button onClick={() => { setEntity({ kind: 'chat', id: item.id, name: item.title }); setMenu(null); }}><Pencil size={14} />重命名</button><button onClick={() => updateChat({ id: item.id, pinned: !item.pinned })}><Pin size={14} />{item.pinned ? '取消置顶' : '置顶对话'}</button>{data.workspaces.length > 0 && <><div className="popmenu-label">移动到工作区</div><button onClick={() => updateChat({ id: item.id, workspaceId: null })}><MessageCircle size={14} />个人对话{!item.workspaceId && <Check size={13} />}</button>{data.workspaces.map(space => <button key={space.id} onClick={() => updateChat({ id: item.id, workspaceId: space.id })}><Folder size={14} style={{ color: space.color }} /><span>{space.name}</span>{item.workspaceId === space.id && <Check size={13} />}</button>)}</>}<div className="menu-divider" /><button className="danger-text" disabled={item.messages.some(message => message.status === 'streaming')} onClick={() => askDeleteChat(item)}><Trash2 size={14} />删除对话</button></div>}
  </div>;

  return <div className={`desktop-app${artifactsOpen?' artifact-docked':''}`} onDragEnter={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); dragCount.current += 1; setDragging(true); } }} onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }} onDragLeave={event => { event.preventDefault(); dragCount.current = Math.max(0, dragCount.current - 1); if (!dragCount.current) setDragging(false); }} onDrop={event => { event.preventDefault(); dragCount.current = 0; setDragging(false); const files = Array.from(event.dataTransfer.files); if (files.length) addFiles(files, workspaceId, route.type !== 'workspace'); }}>
    <header className="titlebar"><div className="titlebar-brand" onDoubleClick={() => api.windowControl('maximize')}><Brand size={19} /><span>Muse</span><span className="titlebar-separator" /><span className="titlebar-subtitle">灵感工作台</span></div><div className="window-controls"><button aria-label="最小化" onClick={() => api.windowControl('minimize')}><Minus size={15} /></button><button aria-label="最大化或还原" onClick={() => api.windowControl('maximize')}><Square size={12} /></button><button className="window-close" aria-label="关闭窗口" onClick={() => api.windowControl('close')}><X size={16} /></button></div></header>
    <div className="app-body">{sidebarOpen && <div className="sidebar-mobile-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-top"><button className="personal-space" onClick={() => newChat()}><span className="personal-avatar"><Brand size={19} /></span><span><strong>我的工作台</strong><small>让想法慢慢成形</small></span></button><IconButton icon={PanelLeft} label="收起侧栏" onClick={() => setSidebarOpen(false)} /></div>
        <div className="sidebar-primary"><button className="new-chat-button" onClick={() => newChat()} data-testid="new-chat"><Plus size={18} /><span>新对话</span><kbd>Ctrl N</kbd></button><button className="sidebar-search" onClick={() => setSearchOpen(true)} data-testid="search-open"><Search size={17} /><span>搜索</span><kbd>Ctrl K</kbd></button><button className="sidebar-search" onClick={() => {setArtifactsOpen(true);setSidebarOpen(false);}} data-testid="artifacts-open"><Monitor size={17}/><span>本地应用</span><small>{data.artifacts.filter(item=>(item.workspaceId??null)===workspaceId).length||''}</small></button></div>
        <div className="sidebar-scroll"><div className="sidebar-group"><div className="sidebar-group-heading"><span>工作区</span><IconButton icon={Plus} label="创建工作区" data-testid="workspace-new" onClick={() => setEntity({ kind: 'workspace' })} /></div>{data.workspaces.length ? data.workspaces.map(space => <button key={space.id} className={`workspace-nav ${workspace?.id === space.id && route.type === 'workspace' ? 'active' : ''}`} onClick={() => openRoute({ type: 'workspace', id: space.id })} data-testid="workspace-nav"><Folder size={17} style={{ color: space.color || COLORS[0] }} /><span>{space.name}</span><span className="workspace-count">{data.chats.filter(item => item.workspaceId === space.id).length || ''}</span></button>) : <button className="workspace-empty-link" onClick={() => setEntity({ kind: 'workspace' })}><FolderPlus size={15} /><span>创建你的第一个工作区</span></button>}</div>
          {sortedChats.some(item => item.pinned) && <div className="sidebar-group"><div className="sidebar-group-heading"><span>置顶</span></div>{sortedChats.filter(item => item.pinned).map(renderChatItem)}</div>}
          <div className="sidebar-group conversation-group"><div className="sidebar-group-heading"><span>最近对话</span>{sortedChats.length > 0 && <small>{sortedChats.length}</small>}</div>{sortedChats.some(item => !item.pinned) ? sortedChats.filter(item => !item.pinned).map(renderChatItem) : <div className="sidebar-chat-empty"><MessageCircle size={23} strokeWidth={1.2} /><span>好想法，从一句话开始</span><small>你的对话会出现在这里</small></div>}</div>
        </div>
        <footer className="sidebar-footer"><button className="settings-entry" data-testid="schedules-open" onClick={()=>setSchedulesOpen(true)}><span className="settings-entry-icon"><AlarmClock size={17}/></span><span>计划任务</span><small>{data.schedules.filter(task=>task.enabled).length||""}</small></button><button className="settings-entry" onClick={() => setSettingsOpen(true)} data-testid="settings-open"><span className="settings-entry-icon"><Settings2 size={17} /></span><span>设置</span>{configured ? <span className="sidebar-connected" title="已配置模型服务" /> : <span className="setup-badge">连接模型</span>}</button><div className="sidebar-footnote"><span className="local-dot" />本地工作台<span>Windows</span></div></footer>
      </aside>

      <main className="main-content"><header className="content-header"><div className="content-heading">{!sidebarOpen && <IconButton icon={PanelLeft} label="展开侧栏" onClick={() => setSidebarOpen(true)} />}{chat ? <><MessageCircle size={16} className="muted" /><h1>{chat.title || '新对话'}</h1>{workspace && <button className="workspace-breadcrumb" onClick={() => openRoute({ type: 'workspace', id: workspace.id })}><Folder size={12} style={{ color: workspace.color }} />{workspace.name}</button>}</> : route.type === 'workspace' && workspace ? <><Folder size={17} style={{ color: workspace.color }} /><h1>{workspace.name}</h1><span className="header-label">工作区</span></> : <span className="header-welcome-label">{workspace ? <><Folder size={15} style={{ color: workspace.color }} />{workspace.name}</> : '给想法一个开始'}</span>}</div>
          <div className="content-header-actions">{chat ? <div className="header-menu-root" data-menu-root><IconButton icon={MoreHorizontal} label="当前对话选项" data-testid="chat-options" onClick={() => setMenu(menu === 'chat-header' ? null : 'chat-header')} />{menu === 'chat-header' && <div className="popmenu header-popmenu"><button onClick={() => { setEntity({ kind: 'chat', id: chat.id, name: chat.title }); setMenu(null); }}><Pencil size={14} />重命名对话</button><button onClick={() => exportChat('markdown')}><Download size={14} />导出 Markdown</button><button onClick={() => exportChat('json')}><Download size={14} />导出 JSON</button><div className="menu-divider" /><button className="danger-text" disabled={busy} onClick={() => askDeleteChat(chat)}><Trash2 size={14} />删除对话</button></div>}</div> : <button className="header-model-status" onClick={() => setSettingsOpen(true)}><span className={`connection-dot ${configured ? 'connected' : ''}`} /><span>{configured ? data.settings.model : '连接模型'}</span><ChevronDown size={13} /></button>}</div>
        </header>

        {route.type === 'workspace' && workspace ? <div className="workspace-scroll"><div className="workspace-page"><div className="workspace-hero"><span className="workspace-hero-icon" style={{ '--space-color': workspace.color || COLORS[0] }}><FolderOpen size={31} strokeWidth={1.4} /></span><div className="workspace-title"><span className="eyebrow">一个专注的空间</span><h2>{workspace.name}</h2><p>{workspace.description || '收集资料、整理思路，让相关的事都在这里。'}</p></div><div className="workspace-hero-actions"><IconButton icon={Pencil} label="编辑工作区" data-testid="workspace-edit" onClick={() => setEntity({ kind: 'workspace', ...workspace })} /><IconButton icon={Trash2} label="删除工作区" onClick={() => askDeleteWorkspace(workspace)} /></div></div>
          <div className="workspace-section"><div className="workspace-section-title"><h3>资料 <span>{data.files.filter(file => file.workspaceId === workspace.id).length}</span></h3><div className="workspace-file-actions"><button className="button ghost small" onClick={() => setNewFile({ workspaceId: workspace.id })} data-testid="workspace-file-new"><FileText size={14} />新建文件</button><button className="button secondary small" onClick={() => addFiles(null, workspace.id, false)} disabled={importing} data-testid="workspace-file-import">{importing ? <Spinner size={14} /> : <Plus size={14} />}添加资料</button></div></div>{data.files.some(file => file.workspaceId === workspace.id) ? <div className="workspace-files">{data.files.filter(file => file.workspaceId === workspace.id).map(file => <FileRow key={file.id} file={file} onPreview={id => setFilePreviewId(id, data.files.filter(value => value.workspaceId === workspace.id).map(value => value.id))} onRemove={askRemoveFile} />)}</div> : <button className="workspace-file-empty" onClick={() => addFiles(null, workspace.id, false)}><span className="empty-file-illustration"><FileText size={31} strokeWidth={1.2} /><Plus size={12} /></span><strong>给这个空间，添一点资料</strong><span>拖入文件，或点击选择。工作区内的文字资料会用于相关对话。</span><small>文本 · Markdown · 代码文件</small></button>}</div>
          <div className="workspace-section"><div className="workspace-section-title"><h3>对话 <span>{data.chats.filter(item => item.workspaceId === workspace.id).length}</span></h3><button className="text-button" onClick={() => newChat(workspace.id)}><Plus size={14} />新对话</button></div>{data.chats.some(item => item.workspaceId === workspace.id) ? <div className="workspace-chats">{sortChats(data.chats.filter(item => item.workspaceId === workspace.id)).map(item => <button className="workspace-chat-card" key={item.id} onClick={() => openRoute({ type: 'chat', id: item.id })}><MessageCircle size={19} /><strong>{item.title}</strong><p>{excerpt(item.messages.find(message => message.role === 'user')?.content || '等待第一条消息', 85)}</p><span>{dateText(item.updatedAt)}<ArrowRight size={14} /></span></button>)}</div> : <div className="workspace-chat-empty"><MessageCircle size={19} /><span>还没有对话。在下方写一个问题，和资料聊聊。</span></div>}</div>
          <div className="workspace-composer-area">{pendingSendList}<Composer {...composerProps} placeholder={`在「${workspace.name}」中开始一段对话…`} /><p className="composer-caption">工作区中的文字资料会随相关消息发送至你配置的模型。</p></div>
        </div></div> : chat ? <>
          <div className="chat-scroll" ref={scroll} onScroll={() => { const element = scroll.current; const near = element.scrollHeight - element.scrollTop - element.clientHeight < 100; followBottom.current = near; setShowScrollBottom(!near); }} data-testid="chat-messages"><div className="chat-messages">
            {chat.messages.length ? chat.messages.map((message, index) => <article className={`message message-${message.role} ${route.messageId === message.id ? 'message-search-target' : ''}`} key={message.id} tabIndex={-1} data-role={message.role} data-message-id={message.id} data-status={message.status || 'complete'}>
              {message.role === 'assistant' && <span className="assistant-avatar"><Brand size={23} /></span>}<div className="message-body">{message.role === 'user' ? message.isDeleted ? <p className="message-deleted" data-testid="deleted-message"><Trash2 size={13} />你删除了一条消息</p> : <>
                {message.replyTo && <button className="message-quote" data-testid="message-quote" onClick={() => openRoute({ type: 'chat', id: chat.id, messageId: message.replyTo.messageId })}><Reply size={14} /><span><strong>{message.replyTo.role === 'user' ? '你' : 'Muse'}</strong>{chat.messages.find(item => item.id === message.replyTo.messageId)?.isDeleted ? '已删除的消息' : excerpt(message.replyTo.excerpt || '附件消息', 180)}</span></button>}
                {message.activePanel && message.activePanel.artifactId!==message.artifactContext?.artifactId && <div className="message-artifact-context" data-testid="message-active-panel"><Monitor size={13}/>{message.activePanel.artifactName} · 应用</div>}{message.artifactContext && <div className="message-artifact-context" data-testid="message-artifact-context"><Monitor size={13}/>{message.artifactContext.artifactName} · 页面选区</div>}<div className="user-message-content"><HighlightText text={message.content} query={route.messageId === message.id ? route.query : null} /></div>{message.attachmentIds?.length > 0 && <div className="message-attachments">{message.attachmentIds.map(id => { const file = data.files.find(file => file.id === id); return file ? <button key={id} data-testid={isVideoFile(file.name)?'video-attachment':isAudioFile(file)?'audio-attachment':isImageFile(file.name)?'image-attachment':isPdfFile(file.name)?'pdf-attachment':isDocxFile(file.name)?'docx-attachment':undefined} onClick={() => openMessageFile(file,message)}><FileText size={14} /><span>{file.name}{isVideoFile(file.name)?' · 播放视频':isAudioFile(file)?' · 播放音频':''}</span></button> : null; })}</div>}
                <div className="message-actions user-message-actions"><CopyButton content={message.content} notify={notify} /><IconButton icon={Reply} label="引用回复" data-testid="quote-message" onClick={() => quoteMessage(message)} disabled={busy} /><IconButton icon={Trash2} label="删除消息" data-testid="delete-turn" onClick={() => askDeleteTurn(message)} disabled={busy} />{index === chat.messages.length - 1 && <IconButton icon={RefreshCw} label="继续回复" data-testid="retry-message" onClick={retry} disabled={busy} />}<span>{dateText(message.createdAt)}</span></div>
              </> : <>
                {!!message.attachmentIds?.length&&<div className="message-attachments">{message.attachmentIds.map(id=>{const file=data.files.find(item=>item.id===id);return file&&(isAudioFile(file)||isPreviewMediaFile(file.name)||isPdfFile(file.name)||isDocxFile(file.name))?<button key={id} data-testid={isVideoFile(file.name)?"video-attachment":isAudioFile(file)?"audio-attachment":isPdfFile(file.name)?"pdf-attachment":isDocxFile(file.name)?"docx-attachment":"image-attachment"} disabled={message.status==='streaming'} onClick={()=>openMessageFile(file,message)}><FileText size={14}/>{file.name}{isVideoFile(file.name)?' · 播放视频':isAudioFile(file)?' · 播放音频':''}</button>:null;})}</div>}
                <AgentActivity trace={message.toolTrace} files={data.files} onOpenFile={setFilePreviewId} />
                {!message.content && message.status === 'streaming' ? <div className="thinking"><span /><span /><span /><small>{data.approvals.some(approval => approval.chatId === chat.id) ? '等待你确认文件操作' : '正在思考'}</small></div> : <Markdown content={message.content} notify={notify} highlight={route.messageId === message.id ? route.query : null} />}
                {message.status === 'streaming' && message.content && <span className="stream-caret" aria-label="正在生成" />}
                {message.status === 'error' && <div className="message-error" role="alert"><AlertCircle size={16} /><div><strong>这次回复没有完成</strong><p>{message.error || '请检查模型连接后重试。'}</p></div></div>}
                {message.status === 'cancelled' && <p className="message-stopped"><Square size={11} />已停止生成</p>}
                {message.status !== 'streaming' && <div className="message-actions"><CopyButton content={message.content} notify={notify} /><IconButton icon={Reply} label="引用回复" data-testid="quote-message" onClick={() => quoteMessage(message)} disabled={busy} />{index === chat.messages.length - 1 && <IconButton icon={RefreshCw} label="重新生成" data-testid="retry-message" onClick={retry} disabled={busy} />}<span>{dateText(message.createdAt)}</span></div>}
              </>}</div></article>) : <div className="chat-empty"><Brand size={45} /><h3>新的对话，新的可能。</h3><p>从一个问题，或一份资料开始。</p></div>}
          </div></div>
          {showScrollBottom && <button className="scroll-bottom" title="回到底部" aria-label="回到底部" onClick={() => { followBottom.current = true; setShowScrollBottom(false); if (scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={16} /></button>}
          <div className="chat-composer-area">{pendingSendList}<Composer {...composerProps} /><p className="composer-caption">模型的回答可能有误，重要信息请自行核实。<span>你的资料，留在你的工作台。</span></p></div>
        </> : <div className="welcome-scroll"><section className="welcome-page"><div className="welcome-emblem"><Brand size={63} /><span className="orbit-dot orbit-one" /><span className="orbit-dot orbit-two" /></div><span className="welcome-eyebrow">留一点空间，给新的可能</span><h2>今天，让什么想法发生？</h2><p className="welcome-subtitle">从一句话、一份资料，或一个还没成形的念头开始。</p>
          {workspace && <button className="welcome-scope" onClick={() => openRoute({ type: 'workspace', id: workspace.id })}><Folder size={14} style={{ color: workspace.color }} />在 {workspace.name} 中开始<ChevronRight size={13} /></button>}
          {pendingSendList}<Composer {...composerProps} welcome />
          <div className="welcome-suggestions">{[[FileText, '读懂一份资料', '请帮我总结这份资料的重点，并整理值得进一步思考的问题。'], [Sparkles, '梳理一个想法', '我有一个还没有成形的想法，想请你和我一起梳理。'], [MessageCircle, '一起想一想', '帮我从不同角度思考一个问题。']].map(([Icon, label, text]) => <button key={label} onClick={() => { updateDraft(text); window.dispatchEvent(new Event('muse-focus-composer')); }}><Icon size={15} />{label}<ArrowUp size={12} /></button>)}</div>
          {!configured && <button className="welcome-connect-note" onClick={() => setSettingsOpen(true)}><span><KeyRound size={17} /></span><div><strong>带上你喜欢的模型</strong><small>连接自己的 API，开始真实对话。</small></div><ArrowRight size={16} /></button>}
        </section><footer className="welcome-footer"><ShieldCheck size={13} /><span>本地保存，安静思考。使用你自己的模型服务。</span></footer></div>}
      </main>
      {filePreviewIds.length > 0 && <FileEditor ids={filePreviewIds} activeId={filePreviewId} files={data.files} previewSuspended={Boolean(imageViewer)} onSelect={openFileTab} onOpenImage={setFilePreviewId} onCloseTab={closeFilePreview} onClose={() => { setFilePreviewIds([]); selectFilePreview(null); }} onRemove={askRemoveFile} onRename={setRenameFile} notify={notify} Modal={Modal} renderMarkdown={content => <Markdown content={content} notify={notify} />} />}
    </div>
    <ApprovalQueue approvals={data.approvals} chats={data.chats} files={data.files} onRespond={input => api.respondApproval(input)} onOpenChat={id => openRoute({ type: 'chat', id })} notify={notify} />
    <AudioControls player={chatAudio}/>
    {imageViewer && <ImageLightbox selection={imageViewer} files={data.files} onClose={() => setImageViewer(null)} onOpenFile={openFileTab} onRemove={askRemoveFile} notify={notify} />}
    {artifactsOpen && <ArtifactPanel artifacts={data.artifacts} workspaceId={workspaceId} workspaceName={workspace?.name} onClose={()=>setArtifactsOpen(false)} onActiveArtifactChange={setActiveArtifactId} notify={notify} annotationTarget={chat?.title || '新对话'} annotationTargetKey={composerKey} annotationUseTools={useTools} onAnnotationToolsChange={composerProps.onToolsChange} onAnnotate={(note,context)=>send(note,context)} onAnnotationSent={annotationSent}/>}
    {knowledgeOpen&&<KnowledgePanel data={data} workspaceId={knowledgeOpen.workspaceId} workspaceName={knowledgeOpen.workspaceName} onClose={()=>setKnowledgeOpen(false)} notify={notify}/>}
    {contextPreview&&<Modal title="将发送的知识上下文" subtitle="包含所选配置的资料；不包含密钥和其他未选择的知识。" onClose={()=>setContextPreview(null)} wide><div className="context-preview">{contextPreview.messages.map((message,index)=><pre key={index}>{message.content}</pre>)}<details><summary>来源与版本记录</summary><pre>{JSON.stringify(contextPreview.receipt,null,2)}</pre></details></div></Modal>}
    {schedulesOpen&&<SchedulePanel schedules={data.schedules} runs={data.scheduleRuns} workspaceId={workspaceId} workspaces={data.workspaces} files={data.files} settings={data.settings} app={data.app} notify={notify} onClose={()=>setSchedulesOpen(false)} onOpenChat={id=>{setSchedulesOpen(false);openRoute({type:'chat',id});}}/>}
    {dragging && <div className="drop-overlay"><div><span><Upload size={31} /></span><h2>把资料放到这里</h2><p>{route.type === 'workspace' ? `添加到「${workspace?.name || '工作区'}」` : '作为附件，和模型一起看看。'}</p></div></div>}
    {settingsOpen && <SettingsDialog settings={data.settings} app={data.app} onClose={() => { setSettingsOpen(false); setThemePreview(null); }} onSaved={settings => setSnapshot(previous => ({ ...previous, settings }))} onImport={replaceSnapshot} notify={notify} onThemePreview={setThemePreview} />}
    {searchOpen && <SearchDialog snapshot={data} currentChatId={chat?.id} Modal={Modal} onClose={() => setSearchOpen(false)} onSelect={item => { if (item.type === 'file') setFilePreviewId(item.id); else openRoute({ type: item.type === 'message' ? 'chat' : item.type, id: item.id, ...(item.messageId ? { messageId: item.messageId, query: item.query } : {}) }); }} />}
    {entity && <EntityDialog key={`${entity.kind}:${entity.id || 'new'}`} entity={entity} onClose={() => setEntity(null)} onSave={saveEntity} />}
    {newFile && <NewFileDialog workspaceId={newFile.workspaceId} onClose={() => setNewFile(null)} notify={notify} onCreated={file => { setSnapshot(previous => ({ ...previous, files: upsert(previous.files, file) })); setFilePreviewId(file.id); setNewFile(null); notify('文件已创建'); }} />}
    {renameFile && <RenameFileDialog key={renameFile.id} file={renameFile} Modal={Modal} onClose={() => setRenameFile(null)} onRenamed={file => { setSnapshot(previous => ({ ...previous, files: upsert(previous.files, file) })); setRenameFile(null); notify('文件已重命名'); }} />}
    {confirm && <Modal title={confirm.title} onClose={() => !confirmBusy && setConfirm(null)} className="confirm-modal"><p className="confirm-body">{confirm.body}</p><footer className="modal-footer"><button className="button secondary" onClick={() => setConfirm(null)} disabled={confirmBusy}>取消</button><button className="button danger" disabled={confirmBusy} data-testid="confirm-delete" onClick={async () => { setConfirmBusy(true); try { await confirm.run(); setConfirm(null); } catch (error) { notify(error.message, 'error'); } finally { setConfirmBusy(false); } }}>{confirmBusy && <Spinner size={15} />}{confirm.action}</button></footer></Modal>}
    {toast && <div className={`toast toast-${toast.kind}`} role="status">{toast.kind === 'error' ? <AlertCircle size={17} /> : toast.kind === 'info' ? <Info size={17} /> : <Check size={17} />}<span>{toast.message}</span><IconButton icon={X} label="关闭提示" onClick={() => setToast(null)} /></div>}
  </div>;
}

function CopyButton({ content, notify }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <IconButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制回答'} disabled={!content} onClick={async () => { try { await api.copyText(content); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); } catch (error) { notify(error.message, 'error'); } }} />;
}

createRoot(document.getElementById('root')).render(<App />);
