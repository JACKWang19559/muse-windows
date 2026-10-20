// Owned isolated renderer. This page has no preload, application API or network.
import {renderAsync} from 'docx-preview';
import {validateDocxPreviewZip} from '../scripts/docx-zip.cjs';
const nonce=location.hash.slice(1),root=document.querySelector('#document');
let used=false,closed=false,port=null,linkTargets=new WeakMap();
function https(value){try{if(typeof value!=='string'||value.length>8000)return null;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function fit(){const section=root.querySelector('section.docx');if(!section)return;root.style.zoom='1';const width=section.getBoundingClientRect().width+32;root.style.zoom=String(Math.min(1,Math.max(0.05,(innerWidth-4)/width)));}
function clear(){closed=true;port?.close();port=null;root.replaceChildren();linkTargets=new WeakMap();}
addEventListener('pagehide',clear,{once:true});addEventListener('resize',fit);
root.addEventListener('click',event=>{
 const anchor=event.target instanceof Element?event.target.closest('a'):null;
 if(!anchor||!root.contains(anchor))return;event.preventDefault();
 if(!event.isTrusted||!navigator.userActivation?.isActive||closed)return;
 const target=linkTargets.get(anchor);if(!target)return;
 if(target.startsWith('#')){let id;try{id=decodeURIComponent(target.slice(1))}catch{return}const element=document.getElementById(id);if(element&&root.contains(element))element.scrollIntoView({block:'center'});}
 else{const href=https(target);if(href)port?.postMessage({type:'muse-docx-link',href});}
});
addEventListener('message',async event=>{
 if(used||closed||event.source!==parent||event.data?.type!=='muse-docx-load'||event.data.nonce!==nonce||event.ports.length!==1)return;
 used=true;port=event.ports[0];port.start();let bytes=event.data.bytes;
 try{
  if(!(bytes instanceof ArrayBuffer))throw Error('Invalid input');
  const zip=validateDocxPreviewZip(new Uint8Array(bytes));
  root.inert=true;
  await renderAsync(bytes,root,root,{className:'docx',inWrapper:true,breakPages:true,ignoreLastRenderedPageBreak:true,renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,renderComments:false,renderAltChunks:false,useBase64URL:true,debug:false});
  if(closed)return;
  for(const node of root.querySelectorAll('iframe,object,embed,script,form'))node.remove();
  for(const anchor of root.querySelectorAll('a')){const raw=anchor.getAttribute('href');anchor.removeAttribute('href');anchor.removeAttribute('target');anchor.removeAttribute('download');anchor.removeAttribute('ping');if(raw&&(raw.startsWith('#')||https(raw))){linkTargets.set(anchor,raw);anchor.setAttribute('role','link');anchor.tabIndex=0;}else anchor.tabIndex=-1;}
  const pages=root.querySelectorAll('section.docx').length;if(!pages)throw Error('Empty document');
  await Promise.all([...root.querySelectorAll('img')].map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true});})));
  // Force layout before waiting for fonts selected by the generated styles.
  void root.offsetHeight;await document.fonts.ready;if(closed)return;
  if(root.scrollWidth>8192||root.scrollHeight>262144)throw Error('Document dimensions exceed preview limit');
  fit();root.inert=false;port.postMessage({type:'muse-docx-rendered',pages,inputBytes:zip.inputBytes,expandedBytes:zip.actualExpandedBytes});
 }catch{if(!closed){root.replaceChildren();port?.postMessage({type:'muse-docx-error'});}}
 finally{bytes=null;}
});
root.addEventListener('keydown',event=>{if(event.key!=='Enter')return;const anchor=event.target instanceof Element?event.target.closest('a[role="link"]'):null;if(!anchor||!event.isTrusted||!navigator.userActivation?.isActive)return;event.preventDefault();const target=linkTargets.get(anchor);if(target?.startsWith('#')){let id;try{id=decodeURIComponent(target.slice(1))}catch{return}const el=document.getElementById(id);if(el&&root.contains(el))el.scrollIntoView({block:'center'});}else{const href=https(target);if(href)port?.postMessage({type:'muse-docx-link',href});}});
if(/^[a-f0-9-]{36}$/.test(nonce)&&parent!==window)parent.postMessage({type:'muse-docx-ready',nonce},'*');
