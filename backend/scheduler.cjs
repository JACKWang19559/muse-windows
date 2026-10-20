'use strict';

// Independent Windows scheduler. Store owns durable claims and recurrence;
// this orchestrator owns bounded live execution and cancellation, never retries.
class Scheduler {
  #store; #execute; #now; #onChange; #onFinish; #active = new Map(); #timer; #running = false; #ticking = false;
  #concurrency; #timeout; #setTimer; #clearTimer;
  constructor({ store, execute, now = Date.now, onChange, onFinish, concurrency = 2, timeoutMs = 300000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!store || ['snapshot','claimScheduleRun','markScheduleDispatched','finishScheduleRun'].some(key => typeof store[key] !== 'function') || typeof execute !== 'function') throw new TypeError('计划执行环境无效。');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new TypeError('计划执行限制无效。');
    this.#store=store;this.#execute=execute;this.#now=now;this.#onChange=onChange;this.#onFinish=onFinish;this.#concurrency=concurrency;this.#timeout=timeoutMs;this.#setTimer=setTimer;this.#clearTimer=clearTimer;
  }
  get activeRuns() { return [...this.#active.values()].map(entry=>({scheduleId:entry.claim.schedule.id,runId:entry.claim.run.id,chatId:entry.claim.run.chatId})); }
  #notify(callback,value) { try { Promise.resolve(callback?.(value)).catch(()=>{}); } catch {} }
  #arm() {
    if (!this.#running || this.#timer) return;
    this.#timer=this.#setTimer(()=>{this.#timer=null;try{this.tick();}finally{this.#arm();}},1000);
    this.#timer?.unref?.();
  }
  start() { if(this.#running)return;this.#running=true;this.tick();this.#arm(); }
  stop() { this.#running=false;if(this.#timer){this.#clearTimer(this.#timer);this.#timer=null;}for(const entry of this.#active.values())entry.controller.abort(); }
  cancel(scheduleId) { let cancelled=0;for(const entry of this.#active.values())if(entry.claim.schedule.id===scheduleId){entry.controller.abort();cancelled++;}return{cancelled}; }
  runNow({id,expectedRevision}) {
    if (this.#active.size>=this.#concurrency) throw new Error('已有计划正在执行，请稍后再运行。');
    if (this.#active.has(id)) throw new Error('这项计划正在执行，请先停止。');
    return this.#claim(id,expectedRevision,'manual');
  }
  tick() {
    if(this.#ticking)return;this.#ticking=true;
    try{
      const now=this.#now(),snapshot=this.#store.snapshot();
      const due=(snapshot.schedules||[]).filter(task=>task.enabled&&task.nextRunAt&&Date.parse(task.nextRunAt)<=now&&!this.#active.has(task.id)).sort((a,b)=>Date.parse(a.nextRunAt)-Date.parse(b.nextRunAt)||a.id.localeCompare(b.id));
      for(const task of due){if(this.#active.size>=this.#concurrency)break;try{this.#claim(task.id,task.revision,'scheduled');}catch(error){this.#notify(this.#onChange,{type:'admission-error',scheduleId:task.id,message:String(error?.message||'计划未启动。').slice(0,1400)});}}
    }finally{this.#ticking=false;}
  }
  #claim(id,expectedRevision,trigger) {
    const claim=this.#store.claimScheduleRun({id,expectedRevision,trigger,now:new Date(this.#now()).toISOString()});
    const controller=new AbortController(),entry={claim,controller};
    this.#active.set(id,entry);this.#notify(this.#onChange,{type:'started',run:claim.run});
    // Execution starts after the durable Store claim and its UI event.
    Promise.resolve().then(()=>this.#run(entry)).catch(()=>{});
    return{runId:claim.run.id,chatId:claim.run.chatId};
  }
  async #run(entry) {
    const {claim,controller}=entry;
    let timedOut=false,dispatched=false;
    const timer=this.#setTimer(()=>{timedOut=true;controller.abort();},this.#timeout);timer?.unref?.();
    let result,status='succeeded',error='',pause=false,receipt;const finalizers=[];
    const markDispatched=()=>{
      if(controller.signal.aborted)throw new DOMException('计划已停止。','AbortError');
      if(dispatched)throw new Error('计划请求已经开始，不允许自动重发。');
      this.#store.markScheduleDispatched({runId:claim.run.id,now:new Date(this.#now()).toISOString()});dispatched=true;
      this.#notify(this.#onChange,{type:'dispatched',runId:claim.run.id});
    };
    try {
      if(controller.signal.aborted)throw new DOMException('计划已停止。','AbortError');
      let removeAbort;
      try{result=await Promise.race([Promise.resolve().then(()=>this.#execute({schedule:structuredClone(claim.schedule),run:structuredClone(claim.run),signal:controller.signal,controller,markDispatched,onFinalized:callback=>{if(typeof callback!=='function')throw new TypeError('计划清理回调无效。');finalizers.push(callback);}})),new Promise((_,reject)=>{const abort=()=>reject(new DOMException('计划已停止。','AbortError'));controller.signal.addEventListener('abort',abort,{once:true});removeAbort=()=>controller.signal.removeEventListener('abort',abort);if(controller.signal.aborted)abort();})]);}
      finally{removeAbort?.();}
      if(controller.signal.aborted)throw new DOMException('计划已停止。','AbortError');
      if(!dispatched)throw new Error('计划执行没有提交模型请求。');
    }catch(failure){
      status=timedOut?'failed':controller.signal.aborted||failure?.name==='AbortError'?'cancelled':'failed';
      error=timedOut?'计划执行超过时间限制，已停止；不会自动重试。':status==='cancelled'?'已停止执行，不会自动重试。':String(failure?.message||'计划未完成。').slice(0,1400);
      pause=failure?.pauseSchedule===true;
    }finally{
      this.#clearTimer(timer);
      try {receipt=this.#store.finishScheduleRun({runId:claim.run.id,status,now:new Date(this.#now()).toISOString(),...(result?{content:result.content||'',...(result.toolTrace?{toolTrace:result.toolTrace}:{})}:{}),error,pause});}
      catch(failure){this.#notify(this.#onChange,{type:'persistence-error',runId:claim.run.id,message:String(failure?.message||'无法保存计划结果。').slice(0,1400)});}
      for(const finalize of finalizers){try{finalize({persisted:!!receipt,status});}catch{/* A cleanup observer cannot rewrite the durable outcome. */}}
      this.#active.delete(claim.schedule.id);
      this.#notify(this.#onChange,{type:'finished',runId:claim.run.id,status});
      if(receipt)this.#notify(this.#onFinish,{schedule:claim.schedule,run:receipt});
      if(this.#running)this.tick();
    }
  }
}
module.exports={Scheduler};
