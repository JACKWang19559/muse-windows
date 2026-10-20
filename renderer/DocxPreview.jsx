import React,{useLayoutEffect,useRef,useState} from 'react';
import {FileText,LoaderCircle,RefreshCw} from 'lucide-react';
import {DocxSession} from './docx-session.cjs';
import './docx-preview.css';
export default function DocxPreview({file}){
 const container=useRef(null),[attempt,setAttempt]=useState(0),[view,setView]=useState({status:'loading'});
 useLayoutEffect(()=>{const session=new DocxSession({readFile:input=>window.muse.readDocxFile(input),onState:setView,onLink:href=>window.muse.openExternal(href)});session.start(file,container.current);return()=>session.dispose();},[file.id,file.name,file.sha256,attempt]);
 return <div className="docx-preview" data-testid="docx-preview" data-file-id={file.id} data-docx-state={view.status}>
  <div className="docx-preview-status" role="status">{view.status==='loading'?<><LoaderCircle size={14} className="spin"/>正在加载 Word 文档…</>:view.status==='ready'?<><FileText size={14}/>{view.pages} 页 · 只读预览</>:<><FileText size={14}/>{view.error||'文档暂时无法预览。'}<button className="text-button" data-testid="docx-retry" onClick={()=>setAttempt(x=>x+1)}><RefreshCw size={13}/>重试</button></>}</div>
  <div ref={container} className="docx-frame-container" data-testid="docx-frame-container"/>
  <div className="docx-preview-note">排版可能与 Word 不同，可下载原文件查看。</div>
 </div>;
}
