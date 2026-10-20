'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { remapToolTrace } = require('../backend/tool-trace.cjs');
const map = (from, to) => new Map([[from, to]]);
const mappings = () => ({ fileIds: map('file_old','file_new'),workspaceIds:map('ws_old','ws_new'),scheduleIds:map('plan_old','plan_new'),runIds:map('run_old','run_new'),chatIds:map('chat_old','chat_new'),messageIdsByChat:new Map([['chat_old',map('msg_old','msg_new')]]) });
const call = (name,args,payload,id=name) => ({ id, name, arguments:JSON.stringify(args),status:'complete',result:JSON.stringify({ok:true,result:payload}) });
const remap = (calls,options=mappings()) => remapToolTrace([{content:'plan_old file_old run_old chat_old',calls}],options)[0];
const meta = () => ({id:'plan_old',workspaceId:'ws_old',attachmentIds:['file_old','unmapped'],lastRunId:'run_old',name:'plan_old',prompt:'file_old',cadence:{kind:'runonce',runAt:'plan_old'},data:{id:'plan_old',workspaceId:'ws_old',attachmentIds:['file_old'],lastRunId:'run_old'},providerBinding:{baseUrl:'https://plan_old.test',model:'plan_old'}});

test('all seven plan tools remap only actual argument and receipt identity relationships',()=>{
  const source=[
    call('muse_list_schedules',{}, {schedules:[meta()]}),
    call('muse_read_schedule',{id:'plan_old',offset:0},{schedule:meta(),prompt:'plan_old file_old run_old chat_old'}),
    call('muse_create_schedule',{name:'plan_old',prompt:'file_old',cadence:{timeZone:'plan_old'},attachmentIds:['file_old']},{committed:true,schedule:meta()}),
    call('muse_update_schedule',{id:'plan_old',expectedRevision:2,name:'plan_old',prompt:'plan_old',cadence:{time:'file_old'},attachmentIds:['file_old']},{committed:true,schedule:meta()}),
    call('muse_pause_schedule',{id:'plan_old',expectedRevision:2},{committed:true,schedule:meta()}),
    call('muse_delete_schedule',{id:'plan_old',expectedRevision:2},{committed:true,deletedId:'plan_old'}),
    call('muse_run_schedule',{id:'plan_old',expectedRevision:2},{committed:true,scheduleId:'plan_old',runId:'run_old',chatId:'chat_old'})
  ];
  const result=remap(source);assert.equal(result.content,'plan_old file_old run_old chat_old');
  for(const item of result.calls){
    const args=JSON.parse(item.arguments),payload=JSON.parse(item.result).result;
    if(['muse_read_schedule','muse_update_schedule','muse_pause_schedule','muse_delete_schedule','muse_run_schedule'].includes(item.name))assert.equal(args.id,'plan_new');
    if(['muse_create_schedule','muse_update_schedule'].includes(item.name)){assert.deepEqual(args.attachmentIds,['file_new']);assert.equal(args.name,'plan_old');}
    const schedule=payload.schedule??payload.schedules?.[0];
    if(schedule){assert.equal(schedule.id,'plan_new');assert.equal(schedule.workspaceId,'ws_new');assert.deepEqual(schedule.attachmentIds,['file_new','unmapped']);assert.equal(schedule.lastRunId,'run_new');assert.equal(schedule.name,'plan_old');assert.equal(schedule.prompt,'file_old');assert.deepEqual(schedule.cadence,meta().cadence);assert.deepEqual(schedule.data,meta().data);assert.deepEqual(schedule.providerBinding,meta().providerBinding);}
    if(item.name==='muse_delete_schedule')assert.equal(payload.deletedId,'plan_new');
    if(item.name==='muse_run_schedule')assert.deepEqual(payload,{committed:true,scheduleId:'plan_new',runId:'run_new',chatId:'chat_new'});
    if(item.name==='muse_read_schedule')assert.equal(payload.prompt,'plan_old file_old run_old chat_old');
  }
  assert.equal(JSON.parse(source[1].arguments).id,'plan_old');assert.equal(JSON.parse(source[0].result).result.schedules[0].id,'plan_old');
});

test('unknown tool names, unknown nested shapes, failed results and opaque malformed JSON retain exact bytes',()=>{
  const unknown=call('other_tool',{id:'plan_old',attachmentIds:['file_old']},{schedule:meta(),scheduleId:'plan_old',runId:'run_old',chatId:'chat_old'});
  const failed={...call('muse_run_schedule',{id:'plan_old'},{scheduleId:'plan_old'},'failed'),result:' {"ok":false,"error":{"id":"plan_old"},"result":{"chatId":"chat_old"}} '};
  const malformed={id:'broken',name:'muse_update_schedule',arguments:'not-json plan_old',status:'complete',result:'["plan_old","file_old"]'};
  const extra=call('muse_run_schedule',{id:'plan_old',prompt:'plan_old',data:{id:'plan_old'}},{scheduleId:'plan_old',source:{chatId:'chat_old'},data:{runId:'run_old'},messageId:'msg_old'});
  const result=remap([unknown,failed,malformed,extra]).calls;
  assert.deepEqual(result[0],unknown);assert.equal(result[1].result,failed.result);assert.equal(result[2].arguments,malformed.arguments);assert.equal(result[2].result,malformed.result);
  const payload=JSON.parse(result[3].result).result;assert.equal(payload.source.chatId,'chat_old');assert.equal(payload.data.runId,'run_old');assert.equal(payload.messageId,'msg_old');
  assert.deepEqual(JSON.parse(result[3].arguments).data,{id:'plan_old'});
});

test('minimal committed receipts and null references survive independent missing mapping sets',()=>{
  const result=remap([
    call('muse_create_schedule',{}, {committed:true,id:'plan_old'}),
    call('muse_pause_schedule',{id:'plan_old'}, {committed:true,id:'plan_old'}),
    call('muse_run_schedule',{id:'plan_old'}, {committed:true,scheduleId:'plan_old',runId:'run_old',chatId:null}),
    call('muse_read_schedule',{id:'plan_old'}, {schedule:{id:'plan_old',workspaceId:null,attachmentIds:['file_old'],lastRunId:'run_old'}})
  ],{scheduleIds:map('plan_old','plan_new')}).calls;
  assert.equal(JSON.parse(result[0].result).result.id,'plan_new');assert.equal(JSON.parse(result[1].result).result.id,'plan_new');assert.equal(JSON.parse(result[2].result).result.chatId,null);
  assert.deepEqual(JSON.parse(result[3].result).result.schedule,{id:'plan_new',workspaceId:null,attachmentIds:['file_old'],lastRunId:'run_old'});
});

test('new mapping options reject proxies or malformed per-chat message maps before transformation',()=>{
  for(const options of [{scheduleIds:{}},{runIds:new Proxy(new Map(),{})},{chatIds:[]},{messageIdsByChat:new Map([['chat_old',{}]])}])assert.throws(()=>remap([call('muse_run_schedule',{id:'plan_old'},{})],options),/格式无效/);
});

test('actual backup merge rewrites plan/file/workspace/run/chat receipts but keeps literal instructions and cancels imported plans',async t=>{
  const parent=path.resolve(__dirname,'.tmp');fs.mkdirSync(parent,{recursive:true});
  const directory=fs.mkdtempSync(path.join(parent,'schedule-trace-'));
  t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^schedule-trace-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const store=new Store(directory),workspace=store.createWorkspace({name:'计划映射'});
  const created=await store.createTextFile({workspaceId:workspace.id,name:'notes.md',content:'literal text'}),file=created.file;
  const at='2032-10-20T00:00:00.000Z';
  const schedule=store.createSchedule({name:'计划',prompt:'明确说明',workspaceId:workspace.id,attachmentIds:[file.id],enabled:true,cadence:{kind:'daily',timeZone:'UTC',time:'09:00'},providerBinding:{baseUrl:'https://model.example.test/v1',model:'test'},authorization:{approvedAt:at,allowReadTools:true},notification:'all'},at);
  const claimed=store.claimScheduleRun({id:schedule.id,expectedRevision:1,trigger:'manual',now:at});
  const literal=`${schedule.id} ${workspace.id} ${file.id} ${claimed.run.id} ${claimed.run.chatId}`;
  const chat=store.createChat({workspaceId:workspace.id}),scheduleMeta=store.getSchedule(schedule.id);
  const calls=[
    call('muse_list_schedules',{}, {schedules:[{...scheduleMeta,prompt:literal,data:{id:schedule.id}}]}),
    call('muse_update_schedule',{id:schedule.id,expectedRevision:1,name:'计划',prompt:literal,cadence:schedule.cadence,attachmentIds:[file.id]},{committed:true,schedule:scheduleMeta}),
    call('muse_run_schedule',{id:schedule.id,expectedRevision:1},{committed:true,scheduleId:schedule.id,runId:claimed.run.id,chatId:claimed.run.chatId})
  ];
  store.appendMessage(chat.id,{role:'assistant',content:literal,agentMode:true,toolTrace:[{content:literal,calls}]});
  const imported=await store.importData(store.exportData()),newSchedule=imported.schedules.find(value=>value.id!==schedule.id);
  const importedHistory=imported.chats.find(value=>value.id!==chat.id&&value.messages.some(message=>message.content===literal));
  const importedRun=imported.scheduleRuns.find(value=>value.id!==claimed.run.id),message=importedHistory.messages.find(value=>value.content===literal);
  assert.notEqual(newSchedule.id,schedule.id);assert.notEqual(newSchedule.workspaceId,workspace.id);assert.equal(newSchedule.enabled,false);
  const listed=JSON.parse(message.toolTrace[0].calls[0].result).result.schedules[0];
  assert.equal(listed.id,newSchedule.id);assert.equal(listed.workspaceId,newSchedule.workspaceId);assert.equal(listed.attachmentIds[0],newSchedule.attachmentIds[0]);assert.equal(listed.lastRunId,importedRun.id);assert.equal(listed.prompt,literal);assert.equal(listed.data.id,schedule.id);
  const updated=JSON.parse(message.toolTrace[0].calls[1].arguments);assert.equal(updated.id,newSchedule.id);assert.deepEqual(updated.attachmentIds,newSchedule.attachmentIds);assert.equal(updated.prompt,literal);
  const receipt=JSON.parse(message.toolTrace[0].calls[2].result).result;assert.equal(receipt.scheduleId,newSchedule.id);assert.equal(receipt.runId,importedRun.id);assert.equal(receipt.chatId,importedRun.chatId);assert.equal(importedRun.status,'interrupted');
  assert.equal(message.content,literal);assert.equal(message.toolTrace[0].content,literal);assert.deepEqual(new Store(directory).getChat(importedHistory.id).messages.find(value=>value.id===message.id).toolTrace,message.toolTrace);
});
