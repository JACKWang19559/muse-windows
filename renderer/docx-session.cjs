'use strict';
const {DOCX_URL}=require('../backend/docx-preview-url.cjs');
const {isDocxFile,MAX_DOCX_FILE_BYTES}=require('../backend/docx-format.cjs');
function httpsLink(value){try{if(typeof value!=='string'||value.length>8000)return null;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
class DocxSession{
 constructor({readFile,onState=()=>{},onLink=()=>{},win=globalThis.window,doc=globalThis.document,Channel=globalThis.MessageChannel,timeoutMs=30000}){Object.assign(this,{readFile,onState,onLink,win,doc,Channel,timeoutMs});this.generation=0;this.current=null;}
 start(file,container){
  this.dispose();const generation=this.generation,nonce=this.win.crypto.randomUUID(),state={generation,nonce,frame:null,port:null,listener:null,timer:null,ready:false,closed:false};this.current=state;
  const live=()=>this.current===state&&!state.closed&&this.generation===generation;
  const fail=message=>{if(!live())return;this.dispose();this.onState({status:'error',error:message});};
  this.onState({status:'loading'});
  state.timer=this.win.setTimeout(()=>fail('文档加载超时，请重试或下载原文件。'),this.timeoutMs);
  Promise.resolve().then(async()=>{
   if(!isDocxFile(file.name))throw Error('此文件不支持 Word 文档预览。');
   const result=await this.readFile({id:file.id,expectedName:file.name,...(file.sha256?{expectedSha256:file.sha256}:{})});
   if(!live()){if(result?.docx instanceof ArrayBuffer)new Uint8Array(result.docx).fill(0);return;}
   if(result.id!==file.id||result.name!==file.name||!(result.docx instanceof ArrayBuffer)||!result.docx.byteLength||result.docx.byteLength>MAX_DOCX_FILE_BYTES||result.size!==result.docx.byteLength||file.sha256&&result.sha256!==file.sha256)throw Error('文档副本已变化，请重新打开。');
   const frame=this.doc.createElement('iframe');state.frame=frame;frame.title='Word 文档只读预览';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.src=DOCX_URL+'#'+nonce;frame.dataset.testid='docx-frame';
   state.listener=event=>{
    if(!live()||state.ready||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='muse-docx-ready'||event.data.nonce!==nonce)return;
    state.ready=true;const channel=new this.Channel();state.port=channel.port1;
    channel.port1.onmessage=event=>{
     if(!live())return;const data=event.data;
     if(data?.type==='muse-docx-rendered'&&Number.isSafeInteger(data.pages)&&data.pages>0){this.win.clearTimeout(state.timer);state.timer=null;state.rendered=true;this.onState({status:'ready',pages:data.pages});}
     else if(data?.type==='muse-docx-error')fail('文档损坏、格式不支持，或超出预览资源限制。可下载原文件查看。');
     else if(data?.type==='muse-docx-link'&&state.rendered&&this.win.navigator?.userActivation?.isActive===true){const href=httpsLink(data.href);if(href)Promise.resolve(this.onLink(href)).catch(()=>{});}
    };
    channel.port1.start?.();try{frame.contentWindow.postMessage({type:'muse-docx-load',nonce,bytes:result.docx},'*',[channel.port2,result.docx]);}catch{channel.port2.close();fail('文档传输失败，请重试。');}
   };
   this.win.addEventListener('message',state.listener);container.appendChild(frame);
  }).catch(error=>fail(typeof error?.message==='string'?error.message.replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/,''):'无法读取文档。'));
 }
 dispose(){this.generation++;const s=this.current;this.current=null;if(!s)return;s.closed=true;if(s.timer!==null)this.win.clearTimeout(s.timer);if(s.listener)this.win.removeEventListener('message',s.listener);if(s.port){s.port.onmessage=null;s.port.close();}s.frame?.remove();}
}
module.exports={DocxSession,httpsLink};
