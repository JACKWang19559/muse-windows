'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Scheduler}=require('../backend/scheduler.cjs');
const {readOnlyRuntime}=require('../backend/read-only-runtime.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(execute,options={}){
  let now=Date.parse('2026-01-01T00:00:00.000Z'),serial=0;
  const schedules=[{id:'a',revision:1,enabled:true,nextRunAt:new Date(now).toISOString()},{id:'b',revision:1,enabled:true,nextRunAt:new Date(now).toISOString()},{id:'c',revision:1,enabled:true,nextRunAt:new Date(now).toISOString()}];
  const runs=[],events=[],finished=[];
  const store={snapshot:()=>({schedules:structuredClone(schedules)}),claimScheduleRun(input){const schedule=schedules.find(item=>item.id===input.id);if(!schedule||schedule.revision!==input.expectedRevision)throw new Error('revision conflict');if(runs.some(run=>run.scheduleId===input.id&&run.status==='running'))throw new Error('already running');const run={id:'run_'+ ++serial,scheduleId:input.id,status:'running',dispatchStarted:false,chatId:'chat_'+serial};runs.push(run);if(input.trigger==='scheduled')schedule.nextRunAt=new Date(now+60000).toISOString();return{schedule:structuredClone(schedule),run:structuredClone(run)};},markScheduleDispatched({runId}){const run=runs.find(run=>run.id===runId);if(run.dispatchStarted)throw new Error('duplicate dispatch');run.dispatchStarted=true;},finishScheduleRun({runId,...patch}){const run=runs.find(run=>run.id===runId);Object.assign(run,patch);return structuredClone(run);}};
  const scheduler=new Scheduler({store,execute,now:()=>now,onChange:event=>events.push(event),onFinish:event=>finished.push(event),...options});
  return{store,scheduler,schedules,runs,events,finished,advance:ms=>{now+=ms;}};
}
test('durable claims precede execution; capacity, due order, catch-up and manual admission never duplicate a live schedule',async()=>{
  const waiting=[];const f=fixture(async({run,markDispatched})=>{assert.ok(f.runs.some(item=>item.id===run.id));markDispatched();await new Promise(resolve=>waiting.push(resolve));return{content:'result'};});
  f.scheduler.tick();f.scheduler.tick();assert.equal(f.runs.length,2);assert.equal(f.scheduler.activeRuns.length,2);
  assert.throws(()=>f.scheduler.runNow({id:'c',expectedRevision:1}),/正在执行/);await flush();assert.equal(waiting.length,2);
  waiting.shift()();await flush();assert.equal(f.runs[0].status,'succeeded');
  f.scheduler.tick();await flush();assert.equal(f.runs.length,3);assert.equal(f.runs[2].scheduleId,'c');
  while(waiting.length)waiting.shift()();await flush();assert.equal(f.finished.length,3);assert.equal(f.scheduler.activeRuns.length,0);
});
test('manual run of a paused task does not change its automatic enabled or due state',async()=>{
  const f=fixture(async({markDispatched})=>{markDispatched();return{content:'manual'};});f.schedules[0].enabled=false;const before=f.schedules[0].nextRunAt;
  const result=f.scheduler.runNow({id:'a',expectedRevision:1});assert.ok(result.runId);await flush();
  assert.equal(f.schedules[0].enabled,false);assert.equal(f.schedules[0].nextRunAt,before);assert.equal(f.runs[0].status,'succeeded');
});
test('cancellation after dispatch is terminal and does not retry the network attempt',async()=>{
  let calls=0;const f=fixture(({signal,markDispatched})=>{calls++;markDispatched();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}));});
  f.scheduler.runNow({id:'a',expectedRevision:1});await flush();f.scheduler.cancel('a');await flush();
  assert.equal(calls,1);assert.equal(f.runs[0].status,'cancelled');assert.equal(f.runs[0].dispatchStarted,true);assert.equal(f.scheduler.activeRuns.length,0);
});
test('provider/scope failure can pause a schedule; observer errors cannot turn execution into retries',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw Object.assign(new Error('provider changed'),{pauseSchedule:true});},{onChange(){throw new Error('observer');},onFinish(){throw new Error('observer');}});
  f.scheduler.runNow({id:'a',expectedRevision:1});await flush();assert.equal(calls,1);assert.equal(f.runs[0].status,'failed');assert.equal(f.runs[0].pause,true);assert.equal(f.runs[0].dispatchStarted,false);
});
test('timeout cancels cooperative providers and preserves uncertain delivery without automatic retry',async()=>{
  let timeout;const f=fixture(({signal,markDispatched})=>{markDispatched();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stop','AbortError')),{once:true}));},{timeoutMs:100,setTimer:fn=>{timeout=fn;return{};},clearTimer(){}});
  f.scheduler.runNow({id:'a',expectedRevision:1});await flush();timeout();await flush();
  assert.equal(f.runs[0].status,'failed');assert.match(f.runs[0].error,/超过时间限制/);assert.equal(f.runs.length,1);
});
test('read-only scheduler runtime denies forged write/build/scheduler calls before reaching any owner',async()=>{
  const called=[];const tools=names=>names.map(name=>({type:'function',function:{name}}));
  const runtime=readOnlyRuntime([{getTools:()=>tools(['workspace_read_file','workspace_create_text_file']),execute:call=>{called.push(call.function.name);return{ok:true};}},{tools:tools(['muse_read_app','muse_build_app','muse_create_schedule']),executeTool:call=>{called.push(call.function.name);return{ok:true};}}]);
  assert.deepEqual(runtime.getTools().map(tool=>tool.function.name),['workspace_read_file','muse_read_app']);
  for(const name of ['workspace_create_text_file','muse_build_app','muse_create_schedule'])assert.equal((await runtime.execute({function:{name}})).error.code,'scheduled_read_only');
  assert.equal(called.length,0);await runtime.execute({function:{name:'muse_read_app'}});assert.deepEqual(called,['muse_read_app']);
});
test('an uncooperative executor cannot retain a slot or overwrite a timed-out terminal run later',async()=>{
  let complete,timeout;const f=fixture(({markDispatched})=>{markDispatched();return new Promise(resolve=>{complete=resolve;});},{timeoutMs:100,setTimer:fn=>{timeout=fn;return{};},clearTimer(){}});
  f.scheduler.runNow({id:'a',expectedRevision:1});await flush();timeout();await flush();
  assert.equal(f.runs[0].status,'failed');assert.equal(f.scheduler.activeRuns.length,0);
  complete({content:'late result'});await flush();assert.equal(f.runs[0].status,'failed');assert.equal(f.runs[0].content,undefined);assert.equal(f.finished.length,1);
});
