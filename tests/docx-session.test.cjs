'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DocxSession,httpsLink}=require('../renderer/docx-session.cjs');
const file={id:'owned_docx',name:'自建.DOCX',sha256:'1'.repeat(64)};
const result=()=>({...file,size:4,docx:Uint8Array.of(80,75,3,4).buffer});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(readFile=async()=>result()){
 const frames=[],channels=[],states=[],links=[],listeners=new Set(),timers=new Set();let nonce=0;
 const win={crypto:{randomUUID:()=>String(++nonce).padStart(8,'0')+'-1111-1111-1111-111111111111'},navigator:{userActivation:{isActive:false}},setTimeout:fn=>{timers.add(fn);return fn},clearTimeout:fn=>timers.delete(fn),addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
 const container={children:[],appendChild(f){this.children.push(f);f.parent=this}};
 const doc={createElement:()=>{const f={dataset:{},attributes:{},contentWindow:{postMessage(...args){f.sent=args}},setAttribute(k,v){this.attributes[k]=v},remove(){this.removed=(this.removed||0)+1;this.parent.children=this.parent.children.filter(x=>x!==this)}};frames.push(f);return f}};
 class Channel{constructor(){const make=()=>({closeCount:0,close(){this.closeCount++},start(){}});this.port1=make();this.port2=make();channels.push(this)}}
 const session=new DocxSession({readFile,onState:x=>states.push(x),onLink:x=>links.push(x),win,doc,Channel});
 const ready=(frame=frames.at(-1),overrides={})=>{for(const fn of [...listeners])fn({source:frame.contentWindow,origin:'null',data:{type:'muse-docx-ready',nonce:frame.src.split('#')[1]},...overrides})};
 return{session,frames,channels,states,links,listeners,timers,container,ready,win};
}
test('DOCX session confines the byte transfer to one ready opaque selected frame and one port',async()=>{
 const f=fixture();f.session.start(file,f.container);await flush();const frame=f.frames[0];
 assert.equal(frame.attributes.sandbox,'allow-scripts');assert.equal(frame.referrerPolicy,'no-referrer');
 f.ready(frame,{origin:'muse-docx://viewer'});f.ready(frame,{source:{}});f.ready(frame,{data:{type:'muse-docx-ready',nonce:'wrong'}});assert.equal(f.channels.length,0);
 f.ready();f.ready();assert.equal(f.channels.length,1);assert.equal(frame.sent[1],'*');assert.equal(frame.sent[2][0],f.channels[0].port2);assert.equal(frame.sent[2][1],frame.sent[0].bytes);
 f.channels[0].port1.onmessage({data:{type:'muse-docx-link',href:'https://owned.example.invalid/'}});assert.deepEqual(f.links,[]);
 f.channels[0].port1.onmessage({data:{type:'muse-docx-rendered',pages:3}});assert.deepEqual(f.states.at(-1),{status:'ready',pages:3});assert.equal(f.timers.size,0);
 f.channels[0].port1.onmessage({data:{type:'muse-docx-link',href:'https://owned.example.invalid/'}});assert.equal(f.links.length,0);f.win.navigator.userActivation.isActive=true;
 f.channels[0].port1.onmessage({data:{type:'muse-docx-link',href:'https://owned.example.invalid/'}});assert.equal(f.links.length,1);
 f.session.dispose();f.session.dispose();assert.equal(frame.removed,1);assert.equal(f.channels[0].port1.closeCount,1);assert.equal(f.listeners.size,0);
});
test('DOCX replacement clears the old port/frame and ignores its delayed message',async()=>{
 const f=fixture(async input=>({...result(),id:input.id}));f.session.start(file,f.container);await flush();f.ready();const old=f.channels[0].port1.onmessage,oldFrame=f.frames[0];
 f.session.start({...file,id:'second'},f.container);await flush();old({data:{type:'muse-docx-rendered',pages:99}});assert.equal(f.states.at(-1).status,'loading');assert.equal(oldFrame.removed,1);assert.equal(f.channels[0].port1.closeCount,1);assert.equal(f.container.children.length,1);f.ready();f.channels[1].port1.onmessage({data:{type:'muse-docx-rendered',pages:2}});assert.deepEqual(f.states.at(-1),{status:'ready',pages:2});f.session.dispose();
});
test('DOCX close during managed read zeroes a late private copy and cannot create an iframe',async()=>{
 let release;const response=result(),f=fixture(()=>new Promise(r=>release=r));f.session.start(file,f.container);await flush();f.session.dispose();release(response);await flush();assert.deepEqual([...new Uint8Array(response.docx)],[0,0,0,0]);assert.equal(f.frames.length,0);assert.equal(f.states.length,1);assert.equal(f.timers.size,0);
});
test('DOCX timeout or child error retires the active frame and exact listener',async()=>{
 for(const cause of ['timeout','error']){const f=fixture();f.session.start(file,f.container);await flush();f.ready();if(cause==='timeout')[...f.timers][0]();else f.channels[0].port1.onmessage({data:{type:'muse-docx-error',message:'untrusted'}});assert.equal(f.states.at(-1).status,'error');assert(!f.states.at(-1).error.includes('untrusted'));assert.equal(f.frames[0].removed,1);assert.equal(f.channels[0].port1.closeCount,1);assert.equal(f.listeners.size,0);}
});
test('DOCX stale selection and oversized/malformed read responses fail before iframe creation',async()=>{
 for(const change of [r=>{r.name='changed.docx'},r=>{r.sha256='2'.repeat(64)},r=>{r.size=5},r=>{r.docx='not bytes'},r=>{r.docx=new ArrayBuffer(25*1024*1024+1);r.size=r.docx.byteLength}]){const r=result();change(r);const f=fixture(async()=>r);f.session.start(file,f.container);await flush();assert.equal(f.states.at(-1).status,'error');assert.equal(f.frames.length,0);assert.equal(f.timers.size,0);}
});
test('DOCX hyperlink protocol rejects credentials non-HTTPS and oversized URLs',()=>{for(const u of ['http://owned.example.invalid','javascript:alert(1)','file:///x','https://user:pass@owned.example.invalid','https://owned.example.invalid/'+ 'a'.repeat(8000),null])assert.equal(httpsLink(u),null);assert.equal(httpsLink('https://owned.example.invalid'),'https://owned.example.invalid/');});
