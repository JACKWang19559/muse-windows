'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {VideoResource,videoKey}=require('../renderer/video-resource.cjs');
const {videoMime,MAX_VIDEO_FILE_BYTES}=require('../backend/video-format.cjs');
const hash='a'.repeat(64),file=(id='first',name=id+'.mp4')=>({id,name,sha256:hash});
const reply=(f,video=Uint8Array.from([0,255,2,128]).buffer)=>({id:f.id,name:f.name,mimeType:videoMime(f.name),size:video.byteLength,sha256:f.sha256||hash,video});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
class FakeMedia {
 constructor(log){this.log=log;this.listeners=new Map();this._src='';this.currentSrc='';this.readyState=0;this.error=null;this.paused=true;this.ended=false;this.muted=false;this.duration=NaN;this.currentTime=0;this.videoWidth=0;this.videoHeight=0;this.playCalls=0;this.playImplementation=null;}
 get src(){return this._src;}set src(value){this.log.push(['src',value]);this._src=value;}
 addEventListener(name,fn){this.log.push(['add',name]);if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.log.push(['remove',name]);this.listeners.get(name)?.delete(fn);}
 emit(name,patch={}){Object.assign(this,patch);for(const fn of [...this.listeners.get(name)||[]])fn({type:name,target:this});}
 pause(){this.log.push(['pause']);this.paused=true;this.emit('pause');}
 removeAttribute(name){this.log.push(['removeAttribute',name]);if(name==='src')this._src='';}
 load(){this.log.push(['load']);this.currentSrc=this._src;this.readyState=0;this.error=null;this.paused=true;this.ended=false;this.currentTime=0;this.duration=NaN;this.videoWidth=0;this.videoHeight=0;}
 play(){this.log.push(['play']);this.playCalls++;if(this.playImplementation)return this.playImplementation();this.paused=false;this.ended=false;this.emit('play');return Promise.resolve();}
}
function fixture({read=async input=>reply({id:input.id,name:input.expectedName,sha256:input.expectedSha256}),variant='inline'}={}){
 const log=[],element=new FakeMedia(log),reads=[],views=[],created=[],revoked=[];
 const resource=new VideoResource({element,variant,readFile:input=>{reads.push(input);return read(input);},onChange:view=>views.push({...view}),createURL:blob=>{created.push(blob);const url='blob:video-'+created.length;log.push(['createURL',url]);return url;},revokeURL:url=>{revoked.push(url);log.push(['revokeURL',url]);}});
 return{resource,element,log,reads,views,created,revoked,view:()=>views.at(-1)};
}
const decoded=(f,patch={})=>f.element.emit('loadeddata',{readyState:4,duration:120,videoWidth:640,videoHeight:360,...patch});
test('video preparation owns exact binary but metadata and arbitrary events cannot assert decoder readiness',async()=>{
 const f=fixture(),selected=file();await f.resource.load(selected);assert.deepEqual(f.reads,[{id:selected.id,expectedName:selected.name,expectedSha256:hash}]);assert.deepEqual(f.views.map(v=>v.status),['loading','prepared']);assert.equal(f.view().decoded,false);
 assert.equal(f.created[0].type,'video/mp4');assert.deepEqual([...new Uint8Array(await f.created[0].arrayBuffer())],[0,255,2,128]);assert.equal(f.element.controls,true);assert.equal(f.element.autoplay,false);assert.equal(f.element.loop,false);assert.equal(f.element.muted,false);assert.equal(f.element.playCalls,0);
 f.element.emit('canplay');assert.equal(f.view().status,'prepared');f.element.emit('playing',{readyState:0,paused:false});assert.equal(f.view().status,'prepared');assert.equal(f.view().decoded,false);f.element.emit('loadedmetadata',{readyState:1,paused:true,duration:90,videoWidth:1280,videoHeight:720});assert.equal(f.view().decoded,false);assert.equal(f.view().duration,90);assert.equal(f.view().videoWidth,1280);
 decoded(f);assert.equal(f.view().status,'ready');assert.equal(f.view().decoded,true);assert.equal(f.element.playCalls,0);f.resource.dispose();
});
test('lightbox is muted and looping, starts only on real readiness and attempts autoplay just once',async()=>{
 const f=fixture({variant:'lightbox'});await f.resource.load(file());assert.equal(f.element.controls,false);assert.equal(f.element.autoplay,true);assert.equal(f.element.loop,true);assert.equal(f.element.muted,true);assert.equal(f.element.playCalls,0);
 f.element.emit('loadedmetadata',{readyState:1,duration:10});assert.equal(f.element.playCalls,0);decoded(f);await turn();assert.equal(f.element.playCalls,1);assert.equal(f.view().status,'playing');assert.equal(f.view().muted,true);
 f.element.emit('canplay');f.element.emit('canplaythrough');f.element.emit('volumechange');await turn();assert.equal(f.element.playCalls,1);f.resource.dispose();
 const already=fixture({variant:'lightbox'});await already.resource.load(file());decoded(already,{paused:false});await turn();assert.equal(already.element.playCalls,0);assert.equal(already.view().status,'playing');already.resource.dispose();
});
test('playback status follows actual readyState, paused, ended and media error rather than event names',async()=>{
 const f=fixture();await f.resource.load(file());decoded(f);await f.resource.play();assert.equal(f.view().status,'playing');
 f.element.emit('waiting',{readyState:4});assert.equal(f.view().status,'playing');f.element.emit('stalled',{readyState:2});assert.equal(f.view().status,'buffering');f.element.emit('playing',{readyState:4});assert.equal(f.view().status,'playing');
 f.element.emit('pause',{paused:false});assert.equal(f.view().status,'playing');f.resource.pause();assert.equal(f.view().status,'paused');assert.equal(f.view().paused,true);
 f.element.emit('ended',{ended:true,paused:true,currentTime:120});assert.equal(f.view().status,'ended');await f.resource.togglePlay();assert.equal(f.view().status,'playing');f.resource.dispose();
});
test('seek is finite and clamped, mute follows the real element and survives same-instance source changes',async()=>{
 const f=fixture({variant:'lightbox'});await f.resource.load(file());f.resource.seek(50);assert.equal(f.element.currentTime,0);decoded(f);await turn();f.resource.pause();
 f.resource.seek(500);assert.equal(f.element.currentTime,120);assert.equal(f.view().currentTime,120);f.resource.seek(-10);assert.equal(f.element.currentTime,0);f.resource.seek(NaN);f.resource.seek(Infinity);assert.equal(f.element.currentTime,0);
 f.element.duration=Infinity;f.resource.seek(12);assert.equal(f.element.currentTime,0);f.element.duration=120;
 f.resource.toggleMute();assert.equal(f.element.muted,false);assert.equal(f.view().muted,false);await f.resource.load(file('second','second.webm'));assert.equal(f.element.muted,false);assert.equal(f.view().key,videoKey(file('second','second.webm')));decoded(f);await turn();assert.equal(f.view().muted,false);
 f.element.emit('volumechange',{muted:true});assert.equal(f.view().muted,true);f.resource.dispose();
});
test('manual play after a decoded seek reaches native play at readyState1 and a late result cannot affect a replacement',async()=>{
 const f=fixture();await f.resource.load(file());decoded(f);f.resource.seek(1.1);f.element.emit('seeking',{readyState:1,paused:true});assert.equal(f.view().decoded,true);
 const resumed=deferred();f.element.playImplementation=()=>resumed.promise;const play=f.resource.play();assert.equal(f.element.playCalls,1);assert.equal(f.element.currentTime,1.1);
 f.element.emit('playing',{readyState:4,paused:false});resumed.resolve();assert.equal(await play,true);assert.equal(f.view().status,'playing');assert.equal(f.view().currentTime,1.1);
 f.resource.pause();f.resource.seek(2.2);f.element.emit('seeking',{readyState:1});const pending=deferred();f.element.playImplementation=()=>pending.promise;const stale=f.resource.play();assert.equal(f.element.playCalls,2);
 await f.resource.load(file('replacement'));const current={...f.view()},count=f.views.length;pending.resolve();assert.equal(await stale,false);assert.equal(f.views.length,count);assert.deepEqual(f.view(),current);assert.equal(f.view().status,'prepared');assert.equal(f.element.paused,true);f.resource.dispose();
});
test('continuous seeking retains the final readyState1 target only after the source has decoded',async()=>{
 const f=fixture();await f.resource.load(file());f.element.emit('loadedmetadata',{readyState:1,duration:120,videoWidth:640,videoHeight:360});assert.equal(f.view().decoded,false);
 f.resource.seek(35);assert.equal(f.element.currentTime,0);assert.equal(await f.resource.play(),false);assert.equal(f.element.playCalls,0);
 decoded(f);f.resource.seek(5);f.element.emit('seeking',{readyState:1});f.resource.seek(25);assert.equal(f.element.currentTime,25);f.resource.seek(500);assert.equal(f.element.currentTime,120);f.resource.seek(47.5);assert.equal(f.element.currentTime,47.5);
 f.element.emit('seeked',{readyState:4});assert.equal(f.view().currentTime,47.5);assert.equal(f.view().decoded,true);assert.equal(f.view().status,'ready');assert.equal(f.element.playCalls,0);f.resource.dispose();
});
test('superseded or disposed pending reads never allocate a URL or notify an unmounted viewer',async()=>{
 const pending=deferred(),a=file('old'),b=file('new'),f=fixture({read:input=>input.id===a.id?pending.promise:Promise.resolve(reply(b))});const first=f.resource.load(a);await f.resource.load(b);const latest={...f.view()},count=f.views.length;pending.resolve(reply(a));await first;assert.equal(f.created.length,1);assert.equal(f.views.length,count);assert.deepEqual(f.view(),latest);f.resource.dispose();
 const late=deferred(),g=fixture({read:()=>late.promise}),load=g.resource.load(a);g.resource.dispose();g.resource.dispose();const n=g.views.length;late.resolve(reply(a));await load;await g.resource.load(b);assert.equal(g.created.length,0);assert.equal(g.reads.length,1);assert.equal(g.views.length,n);assert.deepEqual(g.revoked,[]);
});
test('source replacement removes old listeners before pause, unload and URL revocation; stale events are ignored',async()=>{
 const f=fixture();await f.resource.load(file('old'));decoded(f);const oldURL=f.view().url,oldCallbacks=[...f.element.listeners.values()].flatMap(set=>[...set]);const start=f.log.length;
 await f.resource.load(file('new'));const log=f.log.slice(start),pause=log.findIndex(x=>x[0]==='pause'),removeSrc=log.findIndex(x=>x[0]==='removeAttribute'),load=log.findIndex(x=>x[0]==='load'),revoke=log.findIndex(x=>x[0]==='revokeURL');
 assert(pause>0);assert(log.slice(0,pause).every(x=>x[0]==='remove'));assert(pause<removeSrc&&removeSrc<load&&load<revoke);assert.deepEqual(f.revoked,[oldURL]);const newURL=f.view().url,count=f.views.length;
 for(const fn of oldCallbacks)fn({type:'error',target:f.element});assert.equal(f.views.length,count);assert.equal(f.view().status,'prepared');
 f.element.emit('loadeddata',{currentSrc:oldURL,readyState:4});assert.equal(f.view().status,'prepared');f.element.emit('error',{error:{code:3}});assert.equal(f.view().status,'prepared');assert.deepEqual(f.revoked,[oldURL]);
 f.element.currentSrc=newURL;f.element.error=null;decoded(f);assert.equal(f.view().status,'ready');f.resource.dispose();assert.deepEqual(f.revoked,[oldURL,newURL]);
});
test('late successful or rejected play promises cannot revive a paused source or contaminate a new source',async()=>{
 const f=fixture();await f.resource.load(file());decoded(f);const pending=deferred();f.element.playImplementation=()=>pending.promise;const playing=f.resource.play();f.resource.pause();const paused={...f.view()},n=f.views.length;pending.resolve();assert.equal(await playing,false);assert.equal(f.views.length,n);assert.deepEqual(f.view(),paused);
 const old=deferred();f.element.playImplementation=()=>old.promise;const stale=f.resource.play();await f.resource.load(file('new'));const latest={...f.view()},count=f.views.length;old.reject(Object.assign(Error('old autoplay refusal'),{name:'NotAllowedError'}));assert.equal(await stale,false);assert.equal(f.views.length,count);assert.deepEqual(f.view(),latest);f.resource.dispose();
});
test('autoplay refusal is an actionable notice and AbortError is quiet; both allow a later manual play',async()=>{
 const f=fixture({variant:'lightbox'});await f.resource.load(file());f.element.playImplementation=()=>Promise.reject(Object.assign(Error('gesture required'),{name:'NotAllowedError'}));decoded(f);await turn();assert.equal(f.view().status,'ready');assert.equal(f.view().error,'');assert.match(f.view().notice,/点击播放/);assert.equal(f.view().decoded,true);assert.equal(f.revoked.length,0);
 f.element.playImplementation=null;assert.equal(await f.resource.play(),true);assert.equal(f.view().status,'playing');assert.equal(f.view().notice,'');f.resource.pause();
 f.element.playImplementation=()=>Promise.reject(Object.assign(Error('interrupted'),{name:'AbortError'}));assert.equal(await f.resource.play(),false);assert.equal(f.view().status,'paused');assert.equal(f.view().notice,'');assert.equal(f.view().error,'');f.element.playImplementation=null;assert.equal(await f.resource.play(),true);f.resource.dispose();
});
test('real decode errors revoke the source, ignore old events and permit a new binary/decode retry',async()=>{
 const f=fixture();await f.resource.load(file());const old=f.view().url;f.element.emit('error');assert.equal(f.view().status,'prepared');
 f.element.emit('error',{readyState:0,error:{code:3}});assert.equal(f.view().status,'error');assert.equal(f.view().decoded,false);assert.equal(f.view().url,null);assert.match(f.view().error,/无法解码/);assert.deepEqual(f.revoked,[old]);
 await f.resource.load(file());const next=f.view().url;assert.notEqual(next,old);assert.equal(f.view().status,'prepared');decoded(f);assert.equal(f.view().status,'ready');f.element.emit('error',{error:{code:2}});assert.match(f.view().error,/读取中断/);assert.deepEqual(f.revoked,[old,next]);f.resource.dispose();
});
test('malformed, cross-type, spoofed and oversized host payloads never create a media URL',async()=>{
 const selected=file(),buffer=Uint8Array.from([0,1,2,3]).buffer,large=new ArrayBuffer(MAX_VIDEO_FILE_BYTES+1),variants=[null,{}, {...reply(selected),id:'other'},{...reply(selected),name:'other.mp4'},{...reply(selected),mimeType:'image/png'},{...reply(selected),video:new Uint8Array(buffer)},{...reply(selected),video:{[Symbol.toStringTag]:'ArrayBuffer',byteLength:4}},{...reply(selected),size:-1},{...reply(selected),size:4.5},{...reply(selected),size:3},{...reply(selected),sha256:'bad'},{...reply(selected),sha256:'b'.repeat(64)},reply(selected,large)];
 if(typeof SharedArrayBuffer==='function')variants.push({...reply(selected),video:new SharedArrayBuffer(4)});
 for(const result of variants){const f=fixture({read:async()=>result});await f.resource.load(selected);assert.equal(f.view().status,'error');assert.equal(f.view().url,null);assert.equal(f.created.length,0);assert.deepEqual(f.revoked,[]);f.resource.dispose();}
 const ipc=vm.runInNewContext('new Uint8Array([0,255,3,4]).buffer'),valid=fixture({read:async()=>reply(selected,ipc)});await valid.resource.load(selected);assert.equal(valid.view().status,'prepared');assert.deepEqual([...new Uint8Array(await valid.created[0].arrayBuffer())],[0,255,3,4]);valid.resource.dispose();
});
test('unsupported names avoid host reads, current failures clean IPC prefixes and stale read failures are silent',async()=>{
 const f=fixture();await f.resource.load(file('image','image.png'));assert.equal(f.reads.length,0);assert.equal(f.created.length,0);assert.equal(f.view().status,'error');f.resource.dispose();
 const g=fixture({read:async()=>{throw Error("Error invoking remote method 'muse:invoke': Error: 视频读取失败");}});await g.resource.load(file());assert.equal(g.view().error,'视频读取失败');g.resource.dispose();
 const late=deferred(),h=fixture({read:input=>input.id==='old'?late.promise:Promise.resolve(reply(file('new')))}),load=h.resource.load(file('old'));await h.resource.load(file('new'));const n=h.views.length;late.reject(Error('old request'));await load;assert.equal(h.views.length,n);assert.equal(h.view().status,'prepared');h.resource.dispose();assert.notEqual(videoKey(file()),videoKey({...file(),name:'renamed.mp4'}));assert.notEqual(videoKey(file()),videoKey({...file(),sha256:'b'.repeat(64)}));
});
test('dispose unloads and revokes once, suppressing event and play settlement notifications',async()=>{
 const f=fixture();await f.resource.load(file());decoded(f);const pending=deferred();f.element.playImplementation=()=>pending.promise;const play=f.resource.play(),callbacks=[...f.element.listeners.values()].flatMap(set=>[...set]),count=f.views.length,start=f.log.length,url=f.view().url;
 f.resource.dispose();f.resource.dispose();const log=f.log.slice(start),pause=log.findIndex(x=>x[0]==='pause'),remove=log.findIndex(x=>x[0]==='removeAttribute'),load=log.findIndex(x=>x[0]==='load'),revoke=log.findIndex(x=>x[0]==='revokeURL');assert(log.slice(0,pause).every(x=>x[0]==='remove'));assert(pause>=0&&pause<remove&&remove<load&&load<revoke);assert.equal(f.element.src,'');assert.equal(f.element.currentSrc,'');assert.equal([...f.element.listeners.values()].reduce((n,set)=>n+set.size,0),0);
 for(const fn of callbacks)fn({type:'canplay',target:f.element});pending.reject(Object.assign(Error('late refusal'),{name:'NotAllowedError'}));assert.equal(await play,false);f.resource.pause();f.resource.toggleMute();f.resource.seek(1);assert.equal(f.views.length,count);assert.deepEqual(f.revoked,[url]);
});
