'use strict';
const crypto=require('node:crypto');
const {types,isDeepStrictEqual}=require('node:util');
const TERMINAL=new Set(['ended','stopped','error']);
const fail=message=>{throw new Error(message);};
const wipe=value=>{if(types.isArrayBuffer(value?.audio))new Uint8Array(value.audio).fill(0);};

class AudioSession {
  #getBinding;#onState;#records=new Map();#active=null;#disposed=false;#timeoutMs;#cancelledRequests=new Set();
  constructor({getBinding,onState,timeoutMs=130000}){if(typeof getBinding!=='function'||onState!=null&&typeof onState!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)fail('音频会话配置无效。');this.#getBinding=getBinding;this.#onState=onState;this.#timeoutMs=timeoutMs;}
  #meta(record){return structuredClone(record.meta);}
  #emit(record){try{this.#onState?.(this.#meta(record));}catch{}}
  #end(record,state,reason){if(TERMINAL.has(record.meta.state))return this.#meta(record);record.meta={...record.meta,state,reason,updatedAt:new Date().toISOString()};clearTimeout(record.timer);record.binding=null;record.controller.abort();if(this.#active===record)this.#active=null;this.#emit(record);while(this.#records.size>20)this.#records.delete(this.#records.keys().next().value);return this.#meta(record);}
  #valid(record){if(record!==this.#active||TERMINAL.has(record.meta.state))return false;try{const binding=this.#getBinding(record.meta.owner);if(binding==null||!isDeepStrictEqual(binding,record.binding)){this.#end(record,'stopped','scope_changed');return false;}}catch{this.#end(record,'stopped','scope_changed');return false;}return true;}
  validateCurrent(){return this.#active?this.#valid(this.#active):false;}
  async prepare({owner,load}){
    if(this.#disposed)fail('音频窗口已关闭。');
    if(!owner||typeof owner!=='object'||Array.isArray(owner)||typeof load!=='function')fail('音频来源无效。');
    const captured=structuredClone(owner),binding=this.#getBinding(captured);if(binding==null)fail('音频来源已经失效。');
    if(this.#cancelledRequests.has(captured.requestId)||[...this.#records.values()].some(record=>record.meta.owner.requestId===captured.requestId))fail('音频请求已取消或已使用。');
    this.stop();const now=new Date().toISOString();
    const record={meta:{id:`audio_${crypto.randomUUID()}`,owner:captured,state:'loading',createdAt:now,updatedAt:now},controller:new AbortController(),binding:structuredClone(binding),timer:null};
    this.#records.set(record.meta.id,record);this.#active=record;
    record.timer=setTimeout(()=>this.#end(record,'error','timeout'),this.#timeoutMs);record.timer.unref?.();this.#emit(record);
    const signal=record.controller.signal;
    const cancelled=new Promise(resolve=>signal.addEventListener('abort',()=>resolve({cancelled:true}),{once:true}));
    const pending=Promise.resolve().then(()=>signal.aborted||!this.#valid(record)?null:load({signal})).then(value=>{if(signal.aborted){wipe(value);return {cancelled:true};}return {value};},()=>({failed:true}));
    const result=await Promise.race([pending,cancelled]);
    if(result.cancelled||!this.#valid(record)){wipe(result.value);return this.#meta(record);}
    if(result.failed)return this.#end(record,'error','load_failed');
    const value=result.value;
    if(!types.isArrayBuffer(value?.audio)||value.audio.byteLength<12||value.audio.byteLength>25*1024*1024||!['audio/wav','audio/mpeg','audio/ogg','audio/mp4','audio/flac','audio/webm','audio/aac'].includes(value.mimeType)){wipe(value);return this.#end(record,'error','invalid_audio');}
    clearTimeout(record.timer);record.timer=setTimeout(()=>this.#end(record,'error','playback_not_ready'),20000);record.timer.unref?.();
    record.meta={...record.meta,state:'ready',updatedAt:new Date().toISOString()};this.#emit(record);
    return {...this.#meta(record),audio:value.audio,mimeType:value.mimeType};
  }
  update({id,state}){
    const record=this.#records.get(id);if(!record)fail('音频会话已失效。');
    if(!['playing','paused','ended','error'].includes(state))fail('音频状态无效。');
    if(TERMINAL.has(record.meta.state)||!this.#valid(record))return this.#meta(record);
    if(record.meta.state==='loading'||state==='paused'&&record.meta.state==='ready')fail('音频尚未就绪。');
    if(state==='ended'||state==='error')return this.#end(record,state,state==='error'?'playback_failed':'completed');
    clearTimeout(record.timer);record.timer=null;record.meta={...record.meta,state,updatedAt:new Date().toISOString()};this.#emit(record);return this.#meta(record);
  }
  stop({id,requestId}={}){if(requestId){this.#cancelledRequests.add(requestId);while(this.#cancelledRequests.size>100)this.#cancelledRequests.delete(this.#cancelledRequests.values().next().value);}const record=id?this.#records.get(id):requestId?[...this.#records.values()].find(item=>item.meta.owner.requestId===requestId):this.#active;return record?this.#end(record,'stopped','cancelled'):null;}
  snapshot(){const record=this.#active||[...this.#records.values()].at(-1);return record?this.#meta(record):null;}
  dispose(){this.stop();this.#disposed=true;}
}
module.exports={AudioSession};
