'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../renderer/audio-player.mjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;return{promise:new Promise(yes=>resolve=yes),resolve:value=>resolve(value)};};
async function fixture(options={}){
 const {AudioPlayer}=await modulePromise,listeners=new Set(),audios=[],created=[],revoked=[],views=[],errors=[],calls=[];let serial=0;
 class Audio{constructor(){this.events=new Map();this.duration=options.duration||4;this.currentTime=0;this.paused=true;audios.push(this);}addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}removeEventListener(name,fn){this.events.get(name)?.delete(fn);}emit(name){for(const fn of [...this.events.get(name)||[]])fn();}load(){if(this.src)queueMicrotask(()=>this.emit('loadedmetadata'));}removeAttribute(){this.src='';}play(){if(options.rejectPlay)return Promise.reject(new Error('PRIVATE_MEDIA_FAILURE'));this.paused=false;queueMicrotask(()=>this.emit('playing'));return Promise.resolve();}pause(){const was=this.paused;this.paused=true;if(!was)this.emit('pause');}}
 const api={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},prepareAudio:async input=>{calls.push(['prepare',input]);const result={id:'audio-'+(++serial),owner:{channel:input.channel,requestId:input.requestId},state:'ready',audio:new ArrayBuffer(64),mimeType:'audio/wav'};new Uint8Array(result.audio).fill(7);if(options.pending)await options.pending.promise;return result;},stopAudio:async input=>{calls.push(['stop',input]);return{state:'stopped'};},updateAudioState:async input=>{calls.push(['state',input]);return {state:input.state};}};
 const player=new AudioPlayer({api,channel:options.channel||'preview',Audio,createURL:blob=>{created.push(blob);return'blob:owned-'+created.length;},revokeURL:url=>revoked.push(url),onChange:view=>views.push(view),onError:error=>errors.push(error.message)});
 return{player,audios,created,revoked,views,errors,calls,listeners,emit:session=>{for(const fn of listeners)fn({type:'audio-state',channel:options.channel||'preview',session});}};
}
test('player decodes via a local Blob, tracks pause/resume/seek and releases URLs on stop',async()=>{
 const f=await fixture({channel:'chat'});await f.player.play({chatId:'chat',messageId:'msg',fileId:'file'},{label:'clip.wav'});await tick();assert.equal(f.views.at(-1).state,'playing');assert.ok(new Uint8Array(await f.created[0].arrayBuffer()).every(n=>n===7));
 f.player.pause();await tick();assert.equal(f.views.at(-1).state,'paused');f.player.seek(2);assert.equal(f.audios[0].currentTime,2);f.player.resume();await tick();assert.equal(f.views.at(-1).state,'playing');f.player.stop();assert.deepEqual(f.revoked,['blob:owned-1']);assert.equal(f.audios[0].src,'');assert.equal(f.views.at(-1),null);f.player.dispose();assert.equal(f.listeners.size,0);
});
test('cancel before provider reply cannot play late audio or stop a newer generation',async()=>{
 const pending=deferred(),f=await fixture({pending});const first=f.player.play({text:'first'});f.player.stop();const second=f.player.play({text:'second'});pending.resolve();await first;await second;await tick();assert.equal(f.audios.length,1);assert.equal(f.created.length,1);assert.equal(f.views.at(-1).state,'playing');const prepare=f.calls.filter(x=>x[0]==='prepare');assert.notEqual(prepare[0][1].requestId,prepare[1][1].requestId);f.player.dispose();
});
test('source revocation and ended/error release playback without exposing media errors',async()=>{
 const f=await fixture();await f.player.play({text:'sample'});await tick();const req=f.calls.find(x=>x[0]==='prepare')[1];f.emit({id:'audio-1',owner:{requestId:req.requestId},state:'stopped'});assert.equal(f.views.at(-1),null);assert.equal(f.revoked.length,1);f.player.dispose();
 const rejected=await fixture({rejectPlay:true});await rejected.player.play({text:'sample'});await tick();assert.equal(rejected.views.at(-1),null);assert.equal(rejected.errors.length,1);assert.equal(rejected.errors[0].includes('PRIVATE_MEDIA_FAILURE'),false);assert.equal(rejected.revoked.length,1);rejected.player.dispose();
});
test('preview duration bounds reject oversized decoded clips; attachment channel retains longer audio',async()=>{
 const preview=await fixture({duration:121});await preview.player.play({text:'sample'});await tick();assert.equal(preview.views.at(-1),null);assert.equal(preview.errors.length,1);preview.player.dispose();const chat=await fixture({duration:121,channel:'chat'});await chat.player.play({fileId:'file'});await tick();assert.equal(chat.views.at(-1).state,'playing');chat.player.dispose();
});
