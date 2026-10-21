import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AppWindow,FileText,GripVertical} from 'lucide-react';
import {libraryItems} from '../backend/library-model.cjs';
import './pinned-library.css';

const tuple=item=>({kind:item.kind,id:item.id,workspaceId:item.source.workspaceId??null});

export default function PinnedLibrary({files,artifacts,pins,workspaceId,disabled,onOpen,onManage,onMove}){
 const items=useMemo(()=>libraryItems({files,artifacts,pins,workspaceId}).filter(item=>item.pinned).sort((a,b)=>a.pinnedOrder-b.pinnedOrder),[files,artifacts,pins,workspaceId]);
 const signature=JSON.stringify(items.map(tuple)),latest=useRef(null),root=useRef(null),gesture=useRef(null),flight=useRef(false),mounted=useRef(true);
 const[busy,setBusy]=useState(false),[drag,setDrag]=useState(null),[announcement,setAnnouncement]=useState('');
 latest.current={items,signature,disabled,onMove};
 const cancel=()=>{const g=gesture.current;if(!g)return;gesture.current=null;g.cleanup();try{if(g.handle.hasPointerCapture(g.pointerId))g.handle.releasePointerCapture(g.pointerId);}catch{}if(mounted.current)setDrag(null);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancel();};},[]);
 useEffect(()=>{cancel();},[signature,disabled]);
 const move=async(item,position,expectedOrder)=>{
  if(flight.current||latest.current.disabled)return;
  flight.current=true;setBusy(true);setAnnouncement('正在保存固定项目顺序');
  try{const saved=await latest.current.onMove({item:tuple(item),position,expectedOrder});if(mounted.current)setAnnouncement(saved?'已调整 '+item.name+' 的位置':'顺序未能保存，请重试');}
  catch{if(mounted.current)setAnnouncement('顺序未能保存，请重试');}
  finally{flight.current=false;if(mounted.current)setBusy(false);}
 };
 const start=(event,item)=>{
  if(event.button!==0||!event.isPrimary||flight.current||latest.current.disabled||gesture.current)return;
  event.preventDefault();event.stopPropagation();event.currentTarget.focus();
  const handle=event.currentTarget,g={handle,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,active:false,item,signature:latest.current.signature,items:latest.current.items,cleanup:()=>{}};
  const targetAt=e=>{
   if(latest.current.signature!==g.signature||latest.current.disabled)return null;
   const row=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-pinned-key]');
   if(!row||!root.current?.contains(row)||row.dataset.pinnedKey===item.key)return null;
   const target=g.items.find(x=>x.key===row.dataset.pinnedKey);if(!target)return null;
   const rect=row.getBoundingClientRect();return{target,side:e.clientY<rect.top+rect.height/2?'before':'after'};
  };
  const pointerMove=e=>{
   if(gesture.current!==g||e.pointerId!==g.pointerId)return;
   if(!g.active&&Math.hypot(e.clientX-g.startX,e.clientY-g.startY)<5)return;
   g.active=true;e.preventDefault();const target=targetAt(e);setDrag({key:item.key,target:target?.target.key??null,side:target?.side??null});
  };
  const pointerUp=e=>{
   if(gesture.current!==g||e.pointerId!==g.pointerId)return;
   const target=g.active?targetAt(e):null;cancel();e.preventDefault();e.stopPropagation();
   if(target)void move(item,{[target.side]:tuple(target.target)},g.items.map(tuple));
  };
  const pointerCancel=e=>{if(e.pointerId===g.pointerId)cancel();};
  const lostCapture=()=>{if(gesture.current===g)cancel();};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  const visibility=()=>{if(document.hidden)cancel();};
  g.cleanup=()=>{window.removeEventListener('pointermove',pointerMove,true);window.removeEventListener('pointerup',pointerUp,true);window.removeEventListener('pointercancel',pointerCancel,true);window.removeEventListener('keydown',key,true);window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',visibility);handle.removeEventListener('lostpointercapture',lostCapture);};
  gesture.current=g;window.addEventListener('pointermove',pointerMove,{capture:true,passive:false});window.addEventListener('pointerup',pointerUp,true);window.addEventListener('pointercancel',pointerCancel,true);window.addEventListener('keydown',key,true);window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',visibility);handle.addEventListener('lostpointercapture',lostCapture);
  try{handle.setPointerCapture(g.pointerId);}catch{} // Window capture listeners also cover a failed capture.
 };
 const keyboard=(event,item)=>{
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey)return;
  event.preventDefault();event.stopPropagation();if(flight.current||disabled||gesture.current)return;
  const index=items.findIndex(x=>x.key===item.key),up=event.key==='ArrowUp'||event.key==='Home',target=items[event.key==='Home'?0:event.key==='End'?items.length-1:index+(up?-1:1)];
  if(target&&target.key!==item.key)void move(item,{[up?'before':'after']:tuple(target)},items.map(tuple));
 };
 if(!items.length)return null;
 return<section ref={root} className="sidebar-group pinned-library" aria-label="固定资料" data-testid="pinned-library" aria-busy={busy}>
  <div className="sidebar-group-heading"><span>固定资料</span><button className="text-button" onClick={onManage}>管理</button></div>
  <p className="pinned-instructions" id="pinned-library-instructions">拖动调整顺序，或聚焦排序按钮后使用上下方向键、Home 和 End。</p>
  <div className="pinned-library-list">{items.map(item=>{const Icon=item.kind==='artifact'?AppWindow:FileText;return<div key={item.key} data-pinned-key={item.key} data-pinned-id={item.id} data-pinned-kind={item.kind} className={'pinned-library-row'+(drag?.key===item.key?' dragging':'')+(drag?.target===item.key?' drop-'+drag.side:'')}>
   <button className="pinned-library-open" data-testid="pinned-library-open" title={item.name} disabled={busy||disabled} onClick={()=>onOpen(item,items)}><Icon size={15}/><span>{item.name}</span></button>
   <button className="pinned-library-grip" data-testid="pinned-library-grip" aria-label={'调整 '+item.name+' 的位置'} aria-describedby="pinned-library-instructions" aria-disabled={busy||disabled} title="拖动排序，或使用上下方向键" disabled={disabled} onPointerDown={e=>start(e,item)} onKeyDown={e=>keyboard(e,item)}><GripVertical size={15}/></button>
  </div>;})}</div>
  <span className="pinned-instructions" role="status" aria-live="polite">{announcement}</span>
 </section>;
}
