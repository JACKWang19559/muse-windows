import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './artifact-annotation.css';
import './active-panel.css';
import { Code2, Play, Plus, RefreshCw, Save, Trash2, X, Download, AppWindow, LoaderCircle, MousePointer2, Send } from 'lucide-react';
const api = window.muse;

function IsolatedPreview({ artifact, buildId, notify, onAnnotate, onAnnotationSent, annotationTarget, annotationTargetKey, annotationUseTools, onAnnotationToolsChange }) {
  const frame = useRef(null), live = useRef(null);
  const [prepared, setPrepared] = useState(null), [error, setError] = useState(''), [pagePath, setPagePath] = useState('');
  const [reload, setReload] = useState(0);
  const [connected,setConnected]=useState(false),[picking,setPicking]=useState(false),[annotation,setAnnotation]=useState(null),[note,setNote]=useState(''),[annotationBusy,setAnnotationBusy]=useState(false);
  const annotationRef=useRef(null),noteRef=useRef(''),sending=useRef(null);
  const annotationRoot=useRef(null);
  const targetRef=useRef(annotationTargetKey);targetRef.current=annotationTargetKey;
  annotationRef.current=annotation;noteRef.current=note;
  const dismissAnnotation=()=>{annotationRef.current=null;noteRef.current='';if(live.current)live.current.annotationId=null;setAnnotation(null);setNote('');};
  useEffect(()=>{
    const outside=event=>{if(annotationRef.current&&!annotationRoot.current?.contains(event.target))dismissAnnotation();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside,true);};
  },[]);
  useEffect(()=>{if(annotation)annotationRoot.current?.querySelector('textarea')?.focus();},[annotation]);
  useEffect(()=>{
    annotationRef.current=null;setAnnotation(null);setNote('');setPicking(false);sending.current=null;setAnnotationBusy(false);
    const current=live.current;if(current?.port){current.pickId=null;current.annotationId=null;current.port.postMessage({type:'muse:pick',enabled:false,requestId:crypto.randomUUID()});}
  },[annotationTargetKey]);
  useEffect(() => { setPagePath(''); }, [artifact.id, buildId]);
  useEffect(() => {
    let disposed = false, session;
    setPrepared(null); setError('');setConnected(false);setPicking(false);setAnnotation(null);setNote('');annotationRef.current=null;sending.current=null;setAnnotationBusy(false);
    api.openArtifactPreview({ id:artifact.id, buildId, ...(pagePath ? {pagePath} : {}) }).then(value => {
      session = value;
      if (disposed) { api.closeArtifactPreview(value).catch(() => {}); return; }
      live.current = { ...value, port:null, connecting:false, loaded:false, ready:false };
      setPrepared(value);
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; annotationRef.current=null;sending.current=null;live.current?.port?.close(); live.current = null; if (session) api.closeArtifactPreview(session).catch(() => {}); };
  }, [artifact.id, buildId, pagePath, reload]);
  const connect = async () => {
    const current = live.current, target = frame.current?.contentWindow;
    if (!current || !target || !current.loaded || !current.ready || current.connecting) return;
    current.connecting = true;
    const channel = new MessageChannel();
    try {
      await api.activateArtifactPreview({ sessionId:current.sessionId, documentToken:current.documentToken });
      if (live.current !== current || target !== frame.current?.contentWindow) { channel.port1.close(); channel.port2.close(); return; }
      current.port = channel.port1;
      let inFlight = 0;
      channel.port1.onmessage = async event => {
        if (live.current !== current) return;
        const message = event.data;
        if(message?.type==='muse:selection-dismiss'){
          if(message.requestId===current.annotationId&&annotationRef.current?.session===current)dismissAnnotation();
          return;
        }
        if (['muse:selection','muse:selection-error','muse:selection-cancelled'].includes(message?.type)) {
          if(message.requestId!==current.pickId)return;
          current.pickId=null;setPicking(false);
          if(message.type==='muse:selection'&&message.element&&typeof message.element.text==='string'&&message.element.text.length<=201&&typeof message.element.tag==='string'){
            const value={element:message.element,session:current};current.annotationId=message.requestId;annotationRef.current=value;noteRef.current='';setAnnotation(value);setNote('');
          }else if(message.type==='muse:selection-error')notify('这个元素的信息过长，请选择较小的区域。','error');
          return;
        }
        if (message?.type !== 'muse:request' || typeof message.requestId !== 'string' || message.requestId.length > 80) return;
        let response, counted = false;
        try {
          if (inFlight >= 64 || JSON.stringify(message).length > 275000) throw new Error('应用数据请求过大或过多。');
          inFlight++; counted = true;
          response = { ok:true, result:await api.artifactRequest({ sessionId:current.sessionId, documentToken:current.documentToken, requestId:message.requestId, action:message.action, payload:message.payload }) };
        } catch (error) { response = { ok:false, error:error.message }; }
        finally { if(counted) inFlight--; }
        if (live.current === current) channel.port1.postMessage({ type:'muse:response', requestId:message.requestId, ...response });
      };
      channel.port1.start();
      target.postMessage({ type:'muse:connect', sessionId:current.sessionId, documentToken:current.documentToken }, '*', [channel.port2]);
      setConnected(true);
    } catch (error) { channel.port1.close(); channel.port2.close(); if (live.current === current) setError(error.message); }
  };
  useEffect(() => {
    const receive = event => {
      const current = live.current;
      if (!current || event.source !== frame.current?.contentWindow || event.origin !== 'null' || event.data?.type !== 'muse:ready' || event.data.sessionId !== current.sessionId || event.data.documentToken !== current.documentToken) return;
      current.ready = true; connect();
    };
    window.addEventListener('message',receive); return () => window.removeEventListener('message',receive);
  }, []);
  const choose=()=>{
    const current=live.current;if(!current?.port||sending.current)return;
    const enabled=!picking;current.pickId=crypto.randomUUID();
    current.port.postMessage({type:'muse:pick',enabled,requestId:current.pickId});
    annotationRef.current=null;setAnnotation(null);setNote('');setPicking(enabled);
  };
  const submitAnnotation=async()=>{
    const selected=annotationRef.current,content=noteRef.current.trim();
    if(!selected||!content||sending.current)return;
    const token={},target=targetRef.current;sending.current=token;setAnnotationBusy(true);
    try{
      const context={kind:'artifact_element',artifactId:artifact.id,artifactName:artifact.name,buildId:selected.session.buildId,sourceRevision:selected.session.sourceRevision,pagePath:selected.session.pagePath,element:selected.element};
      const admitted=await onAnnotate(content,context);
      if(admitted&&targetRef.current===target&&annotationRef.current===selected&&live.current===selected.session&&noteRef.current.trim()===content){annotationRef.current=null;setAnnotation(null);setNote('');onAnnotationSent?.();}
    }catch(error){if(annotationRef.current===selected)notify(error.message||'注释没有发送，请重试。','error');}
    finally{if(sending.current===token){sending.current=null;setAnnotationBusy(false);}}
  };
  return <div className="artifact-preview"><div className="artifact-preview-bar"><span>独立预览 · 源码版本 {prepared?.sourceRevision ?? '…'}</span><div><button className="button ghost small" data-testid="artifact-pick" disabled={!connected||annotationBusy} onClick={choose}><MousePointer2 size={14}/>{picking?'退出选择':'选择元素'}</button>{prepared?.pages.length > 1 && <select aria-label="预览页面" value={prepared.pagePath} onChange={event => setPagePath(event.target.value)}>{prepared.pages.map(path => <option key={path}>{path}</option>)}</select>}<button className="button ghost small" aria-label="重新打开预览" onClick={() => setReload(value => value+1)}><RefreshCw size={14}/></button></div></div>{error ? <p className="artifact-error" role="alert">{error}</p> : prepared ? <iframe key={prepared.sessionId} ref={frame} src={prepared.url} title={`${artifact.name} 独立预览`} sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" data-testid="artifact-frame" onLoad={() => { const current = live.current; if (!current) return; if (current.loaded) { current.port?.close(); api.closeArtifactPreview(current).catch(() => {}); setError('页面发生重新导航，请重新打开预览。'); return; } current.loaded = true; connect(); }} /> : <div className="artifact-empty"><LoaderCircle size={20} className="spin"/>正在打开预览…</div>}{picking&&<div className="artifact-pick-hint" role="status">点击预览中的元素，为它添加修改说明。按 Esc 退出。</div>}{annotation&&<div ref={annotationRoot} className="artifact-annotation" data-testid="artifact-annotation"><div><strong>已选择 {annotation.element.text.replace(/\s+/g,' ').trim().slice(0,80)||annotation.element.tag}</strong><button className="icon-button" aria-label="取消页面注释" onClick={dismissAnnotation}><X size={14}/></button></div><textarea data-testid="artifact-annotation-note" aria-label="选区修改说明" maxLength={20000} rows={2} placeholder="想调整这个地方？写下你的要求…" value={note} onChange={event=>{noteRef.current=event.target.value;setNote(event.target.value);}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismissAnnotation();return;}if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submitAnnotation();}}}/><footer><span>发送到：{annotationTarget}</span><label className="artifact-annotation-tools" title="允许助手提出应用修改，执行前仍需逐次确认"><input data-testid="annotation-tools" type="checkbox" checked={annotationUseTools} disabled={annotationBusy} onChange={event=>onAnnotationToolsChange(event.target.checked)}/>工作区助手</label><button className="button primary small" data-testid="artifact-annotation-send" disabled={!note.trim()||annotationBusy} onClick={submitAnnotation}>{annotationBusy?<LoaderCircle size={14} className="spin"/>:<Send size={14}/>}发送说明</button></footer></div>}</div>;
}

export default function ArtifactPanel({ requestedArtifact, artifacts, workspaceId, workspaceName, onClose, notify, onAnnotate, onAnnotationSent, annotationTarget, annotationTargetKey, annotationUseTools, onAnnotationToolsChange, onActiveArtifactChange }) {
  const scoped = artifacts.filter(item => (item.workspaceId ?? null) === workspaceId);
  const [selectedId, setSelectedId] = useState(null), [name, setName] = useState(''), [runtime, setRuntime] = useState('react');
  const selected = scoped.find(item => item.id === selectedId);
  useEffect(()=>{if(selectedId&&!artifacts.some(item=>item.id===selectedId))setSelectedId(null);},[artifacts,selectedId]);
  const [workbenchView, setWorkbenchView] = useState('preview');
  const activeArtifactCallback = useRef(onActiveArtifactChange); activeArtifactCallback.current = onActiveArtifactChange;
  useLayoutEffect(() => { activeArtifactCallback.current?.(selected?.id || null); }, [selected?.id]);
  useLayoutEffect(() => () => { activeArtifactCallback.current?.(null); }, []);
  const [filePath, setFilePath] = useState(''), [file, setFile] = useState(null), [drafts, setDrafts] = useState({}), [deleted, setDeleted] = useState([]);
  const [revision, setRevision] = useState(null), [busy, setBusy] = useState(''), [buildId, setBuildId] = useState(null), [newPath, setNewPath] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = Object.keys(drafts).length > 0 || deleted.length > 0;
  const [discardTarget, setDiscardTarget] = useState(null);
  const editSequence = useRef(0);
  const selection = useRef(selectedId); selection.current = selectedId;
  const switchTo = id => { if (busy) return; if (dirty) { setDiscardTarget({id}); return; } setSelectedId(id); };
  const requestedSelection=useRef(null);
  useEffect(()=>{
    if(!requestedArtifact||busy||requestedSelection.current===requestedArtifact.requestId)return;
    requestedSelection.current=requestedArtifact.requestId;
    if(scoped.some(item=>item.id===requestedArtifact.id)&&selectedId!==requestedArtifact.id)switchTo(requestedArtifact.id);
  },[requestedArtifact,busy]);
  const files = [...new Set([...(selected?.files.map(file => file.path) || []),...Object.keys(drafts)])].filter(path => !deleted.includes(path));
  useEffect(() => { setFilePath(''); setFile(null); setDrafts({}); setDeleted([]); setRevision(null); setBuildId(null); setConfirmDelete(false); }, [selectedId]);
  useEffect(() => { if (selected && !files.includes(filePath)) setFilePath(files[0] || ''); }, [selected, filePath, files.join('\n')]);
  useEffect(() => {
    let alive = true; setFile(null);
    if (selectedId && filePath && !Object.hasOwn(drafts,filePath)) api.readArtifactFile({id:selectedId,path:filePath}).then(value => { if (alive) setFile(value); }).catch(error => { if (alive) notify(error.message,'error'); });
    return () => { alive = false; };
  }, [selectedId,filePath,selected?.sourceRevision,Object.hasOwn(drafts,filePath)]);
  useEffect(() => {
    if (!dirty) return;
    const guard = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload',guard); return () => window.removeEventListener('beforeunload',guard);
  },[dirty]);
  useEffect(()=>{if(!dirty)setRevision(null);},[dirty]);
  const perform = async (label, action) => { setBusy(label); try { return await action(); } catch(error) { notify(error.message,'error'); } finally {setBusy('');} };
  const save = () => perform('save', async () => {
    const id = selected.id;
    const sequence = editSequence.current;
    const result = await api.writeArtifactFiles({ id, expectedRevision:revision ?? selected.sourceRevision, files:Object.entries(drafts).map(([path,text]) => ({path,text})), deletePaths:deleted });
    if (selection.current === id) {
      if (editSequence.current === sequence) { setDrafts({}); setDeleted([]); setRevision(null); }
      else { setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([path,text])=>drafts[path]!==text))); setDeleted(current=>current.filter(path=>!deleted.includes(path))); setRevision(result.sourceRevision); }
    }
    notify('源码已保存；构建后更新预览'); return result;
  });
  const make = () => perform('create', async () => { const sequence=editSequence.current; const app = await api.createArtifact({ name:name.trim() || '我的应用', runtime, workspaceId }); setName(''); if(editSequence.current===sequence)setSelectedId(app.id);else setDiscardTarget({id:app.id}); notify('应用已创建'); });
  const build = () => perform('build', async () => {
    if (dirty) throw new Error('请先保存源码，再构建应用。');
    const id = selected.id; await api.buildArtifact({id,expectedRevision:selected.sourceRevision});
    if (selection.current === id) setBuildId(null); notify('构建完成，预览已更新');
  });
  const builds = selected?.builds || [], latestBuild = builds.at(-1);
  const chosenBuild = builds.find(build => build.id === buildId) || latestBuild;
  const edit = value => { editSequence.current++; if (revision == null) setRevision(selected.sourceRevision); setDrafts(previous => ({...previous,[filePath]:value})); };
  const discard = () => { editSequence.current++; setDrafts({}); setDeleted([]); setRevision(null); setFilePath(''); setFile(null); };
  const close = () => { if(busy)return; if (dirty) setDiscardTarget({close:true}); else onClose(); };
  return <section className="artifact-panel" role="dialog" aria-label="本地应用" data-testid="artifact-panel"><header className="artifact-header"><AppWindow size={21}/><div><h2>本地应用</h2><p>{workspaceName || '未分组'} · 创建、修改和运行你的想法</p></div><button className="icon-button" aria-label="关闭本地应用" onClick={close}><X size={18}/></button></header><div className="artifact-body"><aside className="artifact-library"><div className="artifact-create"><input aria-label="新应用名称" data-testid="artifact-name" placeholder="给应用起个名字" value={name} onChange={event=>setName(event.target.value)} maxLength={120}/><div><select aria-label="应用类型" value={runtime} onChange={event=>setRuntime(event.target.value)}><option value="react">React</option><option value="html">HTML</option></select><button className="button primary small" data-testid="artifact-create" disabled={!!busy||dirty} onClick={make}><Plus size={14}/>创建</button></div></div><nav>{scoped.map(item=><button key={item.id} className={selectedId===item.id?'selected':''} data-artifact-id={item.id} onClick={()=>switchTo(item.id)}><AppWindow size={16}/><span>{item.name}<small>{item.runtime.toUpperCase()} · 版本 {item.sourceRevision}</small></span></button>)}</nav><p className="artifact-library-note">在工作区对话中打开助手，也可以让模型创建和修改这里的应用。</p></aside>{selected ? <div className="artifact-workbench" data-view={workbenchView}><header><h3>{selected.name}</h3><span className="artifact-revision">源码 {selected.sourceRevision}{dirty?' · 有修改':''}</span><div className="artifact-workbench-tabs" role="group" aria-label="应用编辑视图"><button type="button" aria-pressed={workbenchView==='source'} data-testid="artifact-view-source" onClick={()=>setWorkbenchView('source')}><Code2 size={13}/>源码</button><button type="button" aria-pressed={workbenchView==='preview'} data-testid="artifact-view-preview" onClick={()=>setWorkbenchView('preview')}><Play size={13}/>预览</button></div><div className="artifact-workbench-actions"><button className="button secondary small" data-testid="artifact-save" disabled={!dirty||!!busy} onClick={save}><Save size={14}/>保存</button><button className="button primary small" data-testid="artifact-build" disabled={dirty||!!busy} onClick={build}>{busy==='build'?<LoaderCircle size={14} className="spin"/>:<Play size={14}/>}构建</button><button className="icon-button" aria-label="导出应用页面" disabled={!chosenBuild||!!busy} onClick={()=>perform('export',async()=>{const result=await api.exportArtifact({id:selected.id,buildId:chosenBuild.id});if(!result.cancelled)notify('应用页面已导出；应用数据保留在工作台');})}><Download size={16}/></button><button className="icon-button" aria-label="删除应用" onClick={()=>setConfirmDelete(true)}><Trash2 size={16}/></button></div></header>{dirty&&revision!==selected.sourceRevision&&<div className="artifact-warning">源码已被其他操作修改。你的草稿仍在；请复制需要的内容，再放弃草稿重新读取。<button onClick={discard}>放弃草稿并重新读取</button></div>}<div className="artifact-split"><div className="artifact-source"><div className="artifact-file-bar"><Code2 size={15}/><select aria-label="应用源码文件" data-testid="artifact-file" value={filePath} onChange={event=>setFilePath(event.target.value)}>{files.map(path=><option key={path}>{path}</option>)}</select><button className="icon-button" aria-label="删除源码文件" disabled={!filePath||!!busy} onClick={()=>{editSequence.current++;if(revision==null)setRevision(selected.sourceRevision);if(selected.files.some(file=>file.path===filePath))setDeleted(previous=>[...previous,filePath]);setDrafts(previous=>{const next={...previous};delete next[filePath];return next;});setFilePath(files.find(path=>path!==filePath)||'');}}><Trash2 size={13}/></button></div>{Object.hasOwn(drafts,filePath)||typeof file?.text==='string'?<textarea className="artifact-code" data-testid="artifact-code" spellCheck={false} disabled={!!busy} aria-label="源码内容" value={Object.hasOwn(drafts,filePath)?drafts[filePath]:file?.text??''} onChange={event=>edit(event.target.value)}/>:<div className="artifact-empty">{file?.dataBase64?'二进制资源，仅可通过应用工具替换。':'选择一个源码文件。'}</div>}<div className="artifact-add-file"><input aria-label="新源码路径" placeholder="例如 src/style.css" value={newPath} onChange={event=>setNewPath(event.target.value)}/><button className="button ghost small" disabled={!newPath.trim()||!!busy} onClick={()=>{editSequence.current++;const path=newPath.trim();if(files.includes(path)){notify('文件已存在','error');return;}if(revision==null)setRevision(selected.sourceRevision);setDrafts(previous=>({...previous,[path]:''}));setDeleted(previous=>previous.filter(value=>value!==path));setFilePath(path);setNewPath('');}}><Plus size={14}/>文件</button></div>{dirty&&<button className="text-button artifact-discard" onClick={()=>setDiscardTarget({id:selected.id,discard:true})}>放弃未保存修改</button>}</div><div className="artifact-preview-column">{builds.length>0&&<div className="artifact-build-picker"><select aria-label="构建版本" value={chosenBuild?.id||''} onChange={event=>setBuildId(event.target.value)}>{[...builds].reverse().map(build=><option key={build.id} value={build.id}>源码 {build.sourceRevision} · {new Date(build.createdAt).toLocaleTimeString()}</option>)}</select>{chosenBuild?.sourceRevision!==selected.sourceRevision&&<span>预览使用较早构建</span>}</div>}{chosenBuild?<IsolatedPreview key={`${selected.id}:${chosenBuild.id}`} artifact={selected} buildId={chosenBuild.id} notify={notify} onAnnotate={onAnnotate} onAnnotationSent={onAnnotationSent} annotationTarget={annotationTarget} annotationTargetKey={annotationTargetKey} annotationUseTools={annotationUseTools} onAnnotationToolsChange={onAnnotationToolsChange}/>:<div className="artifact-empty"><Play size={26}/><strong>构建后在这里运行</strong><span>保存源码，点击「构建」。预览中的应用可使用自己的本地数据。</span></div>}</div></div><footer className="artifact-footnote">预览无法访问本机文件、模型密钥或外部网络。导出包含静态页面；工作台备份包含源码与应用数据。</footer></div>:<div className="artifact-empty artifact-intro"><AppWindow size={46}/><h3>让想法变成可以使用的小应用</h3><p>创建一个应用，或在工作区对话中让助手帮你编写。</p></div>}</div>{discardTarget&&<div className="artifact-confirm"><div><h3>有未保存的源码</h3><p>继续编辑，或放弃这些修改。</p><button className="button secondary" onClick={()=>setDiscardTarget(null)}>继续编辑</button><button className="button danger" onClick={()=>{const target=discardTarget;setDiscardTarget(null);discard();if(target.close)onClose();else setSelectedId(target.id);}}>放弃修改</button></div></div>}{confirmDelete&&selected&&<div className="artifact-confirm"><div><h3>删除「{selected.name}」？</h3><p>会删除它的源码、构建和应用数据。</p><button className="button secondary" onClick={()=>setConfirmDelete(false)}>取消</button><button className="button danger" disabled={!!busy} data-testid="artifact-confirm-delete" onClick={()=>perform('delete',async()=>{await api.deleteArtifact({id:selected.id});setSelectedId(null);discard();setConfirmDelete(false);})}>删除应用</button></div></div>}</section>;
}
