'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { createScheduleRuntime } = require('../backend/schedule-tools.cjs');
const { normalizeCadence, nextOccurrence } = require('../backend/schedule-time.cjs');
const { scheduleShape } = require('../backend/scheduler-model.cjs');
const NOW = Date.parse('2032-10-20T00:00:00.000Z');
const binding = { baseUrl: 'https://model.example.test/v1', model: 'own-test-model' };
const draft = overrides => ({ name: '每日资料摘要', prompt: '概括所选资料', cadence: { kind: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' }, ...overrides });
const copy = value => JSON.parse(JSON.stringify(value));
const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const execute = (runtime, name, args) => runtime.executeTool(call(name, args));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

class ScheduleStore {
  schedules = new Map(); workspaces = new Set(['a', 'b']); files = [{ id: 'file_a', name: '本区资料', workspaceId: 'a' }, { id: 'file_b', name: '用户显式附件', workspaceId: 'b' }, { id: 'file_global', name: '未分组', workspaceId: null }]; mutations = []; onCommit;
  snapshot() { return { workspaces: [...this.workspaces].map(id => ({ id })), schedules: [...this.schedules.values()].map(copy), files: copy(this.files), settings: { apiKey: 'NEVER-EXPOSE-KEY' }, unrelatedPrivate: 'NEVER-EXPOSE-PRIVATE' }; }
  getSchedule(id) { const value = this.schedules.get(id); if (!value) throw Error('private missing'); return { ...copy(value), apiKey: 'NEVER-EXPOSE-KEY', sourcePath: 'C:/private' }; }
  createSchedule(input) {
    const value = scheduleShape({ id: crypto.randomUUID(), workspaceId: null, attachmentIds: [], notification: 'all', enabled: true, ...copy(input), cadence: normalizeCadence(input.cadence), revision: 1, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), nextRunAt: input.enabled === false ? null : nextOccurrence(input.cadence, NOW) });
    this.schedules.set(value.id, value); this.mutations.push(['create', copy(input)]); this.onCommit?.(value); return this.getSchedule(value.id);
  }
  updateSchedule(input) {
    const current = this.schedules.get(input.id); if (!current || current.revision !== input.expectedRevision) throw Error('计划版本冲突');
    const { id, expectedRevision, ...patch } = copy(input);
    const value = scheduleShape({ ...current, ...patch, revision: expectedRevision + 1, nextRunAt: patch.enabled === false || current.enabled === false && patch.enabled !== true ? null : nextOccurrence(patch.cadence ?? current.cadence, NOW) });
    this.schedules.set(id, value); this.mutations.push(['update', copy(input)]); this.onCommit?.(value); return this.getSchedule(id);
  }
  deleteSchedule(id) { if (!this.schedules.has(id)) throw Error('missing'); this.schedules.delete(id); this.mutations.push(['delete', id]); this.onCommit?.({ id }); return this.snapshot(); }
}
function seeded(store, workspaceId = 'a', overrides = {}) { return store.createSchedule({ ...draft(), workspaceId, attachmentIds: [], enabled: true, notification: 'all', providerBinding: binding, authorization: { approvedAt: new Date(NOW).toISOString(), allowReadTools: false }, ...overrides }); }
const runtimeFor = (store, options = {}) => createScheduleRuntime({ store, now: () => NOW, getProviderBinding: () => binding, ...options });

test('seven detached function tools expose scoped plan operations with strict top-level JSON schemas', () => {
  const runtime = runtimeFor(new ScheduleStore());
  assert.deepEqual(runtime.tools.map(tool => tool.function.name), ['muse_list_schedules','muse_read_schedule','muse_create_schedule','muse_update_schedule','muse_pause_schedule','muse_delete_schedule','muse_run_schedule']);
  for (const tool of runtime.tools) { assert.equal(tool.function.parameters.additionalProperties, false); assert.equal('permissions' in tool.function, false); }
  runtime.tools[0].function.description = 'mutated'; assert.notEqual(runtime.tools[0].function.description, 'mutated');
  assert.throws(() => createScheduleRuntime({ store: {} }), /Store/);
  assert.throws(() => runtimeFor(new ScheduleStore(), { attachmentIds: Array(1) }));
});

test('workspace list/read exclude foreign and ungrouped plans; global only admits plans created in this runtime', async () => {
  const store = new ScheduleStore(), a = seeded(store, 'a'), b = seeded(store, 'b'), global = seeded(store, null);
  const workspace = runtimeFor(store, { workspaceId: 'a' });
  const list = await execute(workspace, 'muse_list_schedules'); assert.deepEqual(list.result.schedules.map(item => item.id), [a.id]); assert.equal(list.result.currentTime, new Date(NOW).toISOString()); assert.equal(typeof list.result.timeZone, 'string');
  assert.equal((await execute(workspace, 'muse_read_schedule', { id: b.id })).error.code, 'out_of_scope');
  assert.equal((await execute(workspace, 'muse_read_schedule', { id: global.id })).error.code, 'out_of_scope');
  const runtime = runtimeFor(store, { requestApproval: () => true });
  assert.equal((await execute(runtime, 'muse_list_schedules')).result.total, 0);
  const created = await execute(runtime, 'muse_create_schedule', draft()); assert.equal(created.ok, true);
  assert.deepEqual((await execute(runtime, 'muse_list_schedules')).result.schedules.map(item => item.id), [created.result.schedule.id]);
  assert.equal((await execute(runtimeFor(store), 'muse_list_schedules')).result.total, 0);
});

test('create/update approvals show complete immutable instruction, provider, next time and read scope; host fields cannot be supplied by model', async () => {
  const store = new ScheduleStore(), approvals = [], changes = [];
  const runtime = runtimeFor(store, { workspaceId: 'a', attachmentIds: ['file_b'], requestApproval: proposal => { approvals.push(proposal); assert.ok(Object.isFrozen(proposal.arguments)); assert.ok(Object.isFrozen(proposal.arguments.cadence)); return true; }, onChanged: event => changes.push(event) });
  const created = await execute(runtime, 'muse_create_schedule', draft({ attachmentIds: ['file_a', 'file_b'], allowReadTools: true })); assert.equal(created.ok, true);
  const value = created.result.schedule;
  const args = approvals[0].arguments;
  assert.equal(args.prompt, '概括所选资料'); assert.equal(args.workspaceId, 'a'); assert.deepEqual(args.providerBinding, binding); assert.equal(args.authorization.allowReadTools, true); assert.equal(args.nextRunAt, '2032-10-20T01:00:00.000Z'); assert.deepEqual(args.readScope.attachments.map(value => value.id), ['file_a', 'file_b']); assert.match(approvals[0].summary, /API 费用/); assert.match(approvals[0].summary, /只读/);
  assert.equal(store.mutations.at(-1)[1].authorization.approvedAt, new Date(NOW).toISOString());
  const updated = await execute(runtime, 'muse_update_schedule', { ...draft({ name: '新版计划' }), id: value.id, expectedRevision: 1 }); assert.equal(updated.ok, true); assert.equal(updated.result.schedule.revision, 2); assert.deepEqual(updated.result.schedule.attachmentIds, ['file_a', 'file_b']);
  assert.equal('workspaceId' in store.mutations.at(-1)[1], false); assert.deepEqual(changes.map(value => value.type), ['create','update']);
  for (const field of ['workspaceId','providerBinding','authorization','nextRunAt']) assert.equal((await execute(runtime, 'muse_create_schedule', { ...draft(), [field]: field === 'workspaceId' ? 'b' : {} })).error.code, 'invalid_arguments');
});

test('foreign attachment selection is denied unless explicitly attached, and interval anchor is host captured', async () => {
  const store = new ScheduleStore(), runtime = runtimeFor(store, { workspaceId: 'a', requestApproval: () => true });
  assert.equal((await execute(runtime, 'muse_create_schedule', draft({ attachmentIds: ['file_b'] }))).error.code, 'out_of_scope');
  const created = await execute(runtime, 'muse_create_schedule', draft({ cadence: { kind: 'interval', timeZone: 'UTC', everyMinutes: 5 } }));
  assert.equal(created.result.schedule.cadence.anchorAt, new Date(NOW).toISOString()); assert.equal(created.result.schedule.nextRunAt, '2032-10-20T00:05:00.000Z');
});

test('all five mutations require literal true for each operation, while reads do not ask', async () => {
  const store = new ScheduleStore(), value = seeded(store), originalCount = store.mutations.length;
  for (const approve of [undefined, () => false, () => 'true', () => ({ approved: true }), () => { throw Error('SECRET-APPROVAL-DETAIL'); }]) {
    const runtime = runtimeFor(store, { workspaceId: 'a', requestApproval: approve, runSchedule: () => { throw Error('must not run'); } });
    for (const [name,args] of [['muse_create_schedule',draft()],['muse_update_schedule',{ ...draft(),id:value.id,expectedRevision:1 }],['muse_pause_schedule',{id:value.id,expectedRevision:1}],['muse_delete_schedule',{id:value.id,expectedRevision:1}],['muse_run_schedule',{id:value.id,expectedRevision:1}]]) {
      const result = await execute(runtime,name,args); assert.equal(result.error.code,'denied',name); assert.equal(JSON.stringify(result).includes('SECRET-APPROVAL-DETAIL'),false);
    }
    assert.equal((await execute(runtime,'muse_read_schedule',{id:value.id})).ok,true);
  }
  assert.equal(store.mutations.length,originalCount);
});

test('same call ID deduplicates concurrent approval and commit; changed arguments cannot reuse an ID', async () => {
  const store = new ScheduleStore(), gate = deferred(); let count = 0;
  const runtime = runtimeFor(store,{requestApproval:()=>{count++;return gate.promise;}}), request = call('muse_create_schedule',draft());
  const one = runtime.executeTool(request), two = runtime.executeTool(request); await new Promise(resolve=>setImmediate(resolve)); assert.equal(count,1);
  gate.resolve(true); const [a,b]=await Promise.all([one,two]); assert.deepEqual(a,b); assert.equal(store.mutations.length,1);
  a.result.schedule.name='changed'; assert.notEqual((await runtime.executeTool(request)).result.schedule.name,'changed');
  assert.equal((await runtime.executeTool(call('muse_create_schedule',draft({name:'other'}),request.id))).error.code,'invalid_tool_call');
});

test('scope, CAS, provider, attachment and elapsed next occurrence are rechecked after approval', async () => {
  for (const mode of ['revision','workspace','provider','attachment','time']) {
    const store = new ScheduleStore(), value=seeded(store,'a',{attachmentIds:['file_a']}), gate=deferred(); let target=binding, clock=NOW;
    const runtime=runtimeFor(store,{workspaceId:'a',getProviderBinding:()=>target,now:()=>clock,requestApproval:()=>gate.promise});
    const pending=execute(runtime,'muse_update_schedule',{...draft({cadence:{kind:'daily',timeZone:'Asia/Shanghai',time:'08:30'}}),id:value.id,expectedRevision:1}); await new Promise(resolve=>setImmediate(resolve));
    if(mode==='revision')store.schedules.get(value.id).revision++;
    if(mode==='workspace')store.schedules.get(value.id).workspaceId='b';
    if(mode==='provider')target={...binding,model:'other-model'};
    if(mode==='attachment')store.files.find(value=>value.id==='file_a').workspaceId='b';
    if(mode==='time')clock=Date.parse('2032-10-20T01:00:00.000Z');
    gate.resolve(true); const result=await pending;
    assert.equal(result.ok,false,mode); assert.ok(['conflict','out_of_scope','target_changed','expired'].includes(result.error.code),mode); assert.equal(store.mutations.length,1,mode);
  }
});

test('abort while waiting for approval stops promptly, ignores late approval and never commits', async () => {
  const store=new ScheduleStore(),gate=deferred(),controller=new AbortController();
  const runtime=runtimeFor(store,{signal:controller.signal,requestApproval:()=>gate.promise});
  const pending=execute(runtime,'muse_create_schedule',draft()); await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,{name:'AbortError'});gate.resolve(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(store.mutations.length,0);
});

test('late abort and throwing/rejected observers cannot erase a committed creation or claim receipt', async () => {
  const store=new ScheduleStore(),controller=new AbortController();store.onCommit=()=>controller.abort();
  const runtime=runtimeFor(store,{signal:controller.signal,requestApproval:()=>true,onChanged:()=>{throw Error('observer-private');},onActivity:()=>Promise.reject(Error('observer-private'))});
  const result=await execute(runtime,'muse_create_schedule',draft());assert.equal(result.ok,true);assert.equal(result.result.committed,true);assert.equal(store.schedules.size,1);
  const another=new ScheduleStore(),value=seeded(another),control=new AbortController();let runs=0;
  const runRuntime=runtimeFor(another,{workspaceId:'a',signal:control.signal,requestApproval:()=>true,runSchedule:async()=>{runs++;control.abort();return{runId:'run_1',chatId:'chat_1',apiKey:'NEVER-EXPOSE'};}});
  const receipt=await execute(runRuntime,'muse_run_schedule',{id:value.id,expectedRevision:1});assert.equal(receipt.ok,true);assert.equal(receipt.result.runId,'run_1');assert.equal(runs,1);assert.equal(JSON.stringify(receipt).includes('apiKey'),false);
});

test('pause/delete/run respect versions, preserve metadata receipts and manual run refuses a different provider', async () => {
  const store=new ScheduleStore(),value=seeded(store);const approved=[];let runs=0;
  const runtime=runtimeFor(store,{workspaceId:'a',requestApproval:request=>{approved.push(request.name);return true;},runSchedule:()=>{runs++;return{runId:'run_1',chatId:'chat_1'};}});
  const pause=await execute(runtime,'muse_pause_schedule',{id:value.id,expectedRevision:1});assert.equal(pause.result.schedule.enabled,false);assert.equal(pause.result.schedule.revision,2);
  assert.equal((await execute(runtime,'muse_run_schedule',{id:value.id,expectedRevision:1})).error.code,'conflict');
  const run=await execute(runtime,'muse_run_schedule',{id:value.id,expectedRevision:2});assert.equal(run.result.chatId,'chat_1');assert.equal(runs,1);
  const different=runtimeFor(store,{workspaceId:'a',getProviderBinding:()=>({...binding,model:'changed'}),requestApproval:()=>true,runSchedule:()=>{throw Error('must not run');}});
  assert.equal((await execute(different,'muse_run_schedule',{id:value.id,expectedRevision:2})).error.code,'target_changed');
  const deleted=await execute(runtime,'muse_delete_schedule',{id:value.id,expectedRevision:2});assert.equal(deleted.result.deletedId,value.id);assert.equal(store.schedules.size,0);assert.deepEqual(approved,['muse_pause_schedule','muse_run_schedule','muse_delete_schedule']);
});

test('expired and malformed cadence or nested/host-field injection is rejected before approval', async () => {
  const store=new ScheduleStore();let approvals=0;const runtime=runtimeFor(store,{requestApproval:()=>{approvals++;return true;}});
  for(const args of [draft({cadence:{kind:'runonce',timeZone:'UTC',runAt:new Date(NOW).toISOString()}}),draft({cadence:{kind:'hourly',timeZone:'UTC',time:'09:00'}}),draft({cadence:{kind:'weekly',timeZone:'UTC',time:'09:00',weekdays:[1,1]}}),draft({attachmentIds:['file_a','file_a']}),draft({name:'bad\nname'}),draft({prompt:'\ud800'})])assert.equal((await execute(runtime,'muse_create_schedule',args)).ok,false);
  const request=call('muse_create_schedule');request.function.arguments='{"name":"a","prompt":"b","cadence":{"kind":"daily","timeZone":"UTC","time":"09:00","__proto__":{"polluted":true}}}';
  assert.equal((await runtime.executeTool(request)).error.code,'invalid_arguments');assert.equal({}.polluted,undefined);assert.equal(approvals,0);
});

test('prompt pagination is lossless, keeps Unicode pairs and bounds JSON bytes while private Store data stays absent', async () => {
  const store=new ScheduleStore(),text='😀'+'界'.repeat(20000)+'\u0001'.repeat(20000),value=seeded(store,'a',{prompt:text});
  const runtime=runtimeFor(store,{workspaceId:'a'});let offset=0,joined='';
  do{const receipt=await execute(runtime,'muse_read_schedule',{id:value.id,offset});assert.equal(receipt.ok,true);assert.ok(Buffer.byteLength(JSON.stringify(receipt))<65536);assert.equal(Buffer.from(receipt.result.prompt).toString(),receipt.result.prompt);joined+=receipt.result.prompt;offset=receipt.result.nextOffset;}while(offset!==undefined);
  assert.equal(joined,text);const serialized=JSON.stringify(await execute(runtime,'muse_list_schedules'));
  for(const forbidden of ['NEVER-EXPOSE','apiKey','sourcePath','C:/private','"prompt"'])assert.equal(serialized.includes(forbidden),false);
});

test('list paginates up to 500 records without losing scoped items or exceeding result byte bounds', async () => {
  const store=new ScheduleStore();for(let index=0;index<120;index++)seeded(store,'a',{name:'任务'+index});
  const runtime=runtimeFor(store,{workspaceId:'a'});const ids=[];let offset=0;
  do{const result=await execute(runtime,'muse_list_schedules',{offset,limit:50});assert.equal(result.ok,true);assert.ok(Buffer.byteLength(JSON.stringify(result))<65536);ids.push(...result.result.schedules.map(value=>value.id));offset=result.result.nextOffset;}while(offset!==undefined);
  assert.equal(ids.length,120);assert.equal(new Set(ids).size,120);
});

test('tool call envelope is checked without invoking proxy/getter and hidden host errors are not returned', async () => {
  const runtime=runtimeFor(new ScheduleStore());let reads=0;
  for(const value of [new Proxy({},{ownKeys(){reads++;throw Error();}}),{id:'x',type:'function',get function(){reads++;return{};}}])assert.equal((await runtime.executeTool(value)).error.code,'invalid_tool_call');
  assert.equal(reads,0);
  const store=new ScheduleStore();store.createSchedule=()=>{throw Error('PRIVATE-STATE-PATH');};
  const result=await execute(runtimeFor(store,{requestApproval:()=>true}),'muse_create_schedule',draft());assert.equal(result.error.code,'operation_failed');assert.equal(JSON.stringify(result).includes('PRIVATE-STATE-PATH'),false);
});

test('real Store commits approval-bound plans atomically and round-trips create/update/pause through restart', async t => {
  const scratch=path.resolve(__dirname,'.tmp');fs.mkdirSync(scratch,{recursive:true});
  const root=fs.mkdtempSync(path.join(scratch,'schedule-tools-'));
  t.after(()=>{if(path.dirname(root)===scratch&&path.basename(root).startsWith('schedule-tools-'))fs.rmSync(root,{recursive:true,force:true});});
  const store=new Store(path.join(root,'data')),workspace=store.createWorkspace({name:'计划测试'});
  const adapter={snapshot:()=>store.snapshot(),getSchedule:id=>store.getSchedule(id),createSchedule:input=>store.createSchedule(input,new Date(NOW).toISOString()),updateSchedule:input=>store.updateSchedule(input,new Date(NOW).toISOString()),deleteSchedule:id=>store.deleteSchedule(id)};
  const approvals=[],runtime=runtimeFor(adapter,{workspaceId:workspace.id,requestApproval:request=>{approvals.push(request);return true;}});
  const created=await execute(runtime,'muse_create_schedule',draft());assert.equal(created.ok,true);
  const id=created.result.schedule.id;assert.equal(store.getSchedule(id).nextRunAt,approvals[0].arguments.nextRunAt);
  const updated=await execute(runtime,'muse_update_schedule',{...draft({prompt:'新的明确指令'}),id,expectedRevision:1});assert.equal(updated.ok,true);assert.equal(store.getSchedule(id).nextRunAt,approvals[1].arguments.nextRunAt);
  const pause=await execute(runtime,'muse_pause_schedule',{id,expectedRevision:2});assert.equal(pause.ok,true);
  const restarted=new Store(path.join(root,'data'));assert.equal(restarted.getSchedule(id).enabled,false);assert.equal(restarted.getSchedule(id).prompt,'新的明确指令');assert.equal(restarted.getSchedule(id).revision,3);
  const removed=await execute(runtime,'muse_delete_schedule',{id,expectedRevision:3});assert.equal(removed.result.deletedId,id);assert.equal(store.snapshot().schedules.length,0);
});

test('a background claim changing due state without a configuration revision invalidates a pending approval', async () => {
  const store=new ScheduleStore(),value=seeded(store),gate=deferred();
  const runtime=runtimeFor(store,{workspaceId:'a',requestApproval:()=>gate.promise});
  const pending=execute(runtime,'muse_update_schedule',{...draft(),id:value.id,expectedRevision:1});await new Promise(resolve=>setImmediate(resolve));
  store.schedules.get(value.id).nextRunAt='2032-10-21T01:00:00.000Z';gate.resolve(true);
  const result=await pending;assert.equal(result.error.code,'conflict');assert.equal(store.mutations.length,1);
});
