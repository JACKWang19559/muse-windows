'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Store}=require('../backend/store.cjs');
const {remapToolTrace,traceHistory}=require('../backend/tool-trace.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const maps=()=>({memoryIds:new Map([['memory_old','memory_new']]),workspaceIds:new Map([['workspace_old','workspace_new']])});
const completed=(id,name,args,result)=>({id,name,arguments:JSON.stringify(args),status:'complete',result:JSON.stringify({ok:true,result})});
const round=calls=>[{content:'memory_old workspace_old',calls}];
const meta=()=>({id:'memory_old',workspaceId:'workspace_old',name:'memory_old',revision:2,digest:'a'.repeat(64),contentMarkdown:'memory_old workspace_old',guidance:'memory_old workspace_old',data:{id:'memory_old',workspaceId:'workspace_old'}});
function fixture(t,label){
  const parent=path.resolve(__dirname,'.tmp');fs.mkdirSync(parent,{recursive:true});const directory=fs.mkdtempSync(path.join(parent,'knowledge-trace-'+label+'-'));
  t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^knowledge-trace-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return{store:new Store(directory),directory};
}

test('known memory read/update/delete arguments and memory/search/deletion receipt slots remap without rewriting literal guidance',()=>{
  const source=round([
    completed('search','memory_search',{query:'memory_old'},{status:'ready',hits:[meta()],data:{id:'memory_old',workspaceId:'workspace_old'}}),
    completed('read','memory_read',{id:'memory_old',offset:0},{memory:meta(),contentMarkdown:'memory_old workspace_old',guidance:'memory_old'}),
    completed('create','memory_create',{name:'memory_old',contentMarkdown:'memory_old workspace_old'},{committed:true,memory:meta()}),
    completed('update','memory_update',{id:'memory_old',expectedRevision:1,name:'memory_old',contentMarkdown:'memory_old workspace_old',data:{id:'memory_old'}},{committed:true,memory:meta()}),
    completed('delete','memory_delete',{id:'memory_old',expectedRevision:2},{committed:true,deletedId:'memory_old',contentMarkdown:'memory_old'}),
    completed('index','memory_rebuild_index',{}, {committed:true,status:'ready',sourceDigest:'a'.repeat(64),workspaceId:'workspace_old'})
  ]),before=copy(source),result=remapToolTrace(source,maps());
  assert.equal(result[0].content,source[0].content);assert.deepEqual(source,before);
  for(const call of result[0].calls){
    const args=JSON.parse(call.arguments),payload=JSON.parse(call.result).result;
    if(['memory_read','memory_update','memory_delete'].includes(call.name))assert.equal(args.id,'memory_new');
    if(call.name==='memory_update'){assert.equal(args.contentMarkdown,'memory_old workspace_old');assert.equal(args.name,'memory_old');assert.deepEqual(args.data,{id:'memory_old'});}
    if(call.name==='memory_create')assert.equal(args.contentMarkdown,'memory_old workspace_old');
    const item=payload.memory??payload.hits?.[0];
    if(item){assert.equal(item.id,'memory_new');assert.equal(item.workspaceId,'workspace_new');assert.equal(item.contentMarkdown,'memory_old workspace_old');assert.equal(item.guidance,'memory_old workspace_old');assert.equal(item.name,'memory_old');assert.deepEqual(item.data,{id:'memory_old',workspaceId:'workspace_old'});}
    if(call.name==='memory_search'){assert.equal(args.query,'memory_old');assert.deepEqual(payload.data,{id:'memory_old',workspaceId:'workspace_old'});}
    if(call.name==='memory_read'){assert.equal(payload.contentMarkdown,'memory_old workspace_old');assert.equal(payload.guidance,'memory_old');}
    if(call.name==='memory_delete')assert.equal(payload.deletedId,'memory_new');
    if(call.name==='memory_rebuild_index')assert.equal(payload.workspaceId,'workspace_old'); // Not an identity slot returned by this runtime.
  }
  const history=traceHistory(result);assert.deepEqual(history[0].tool_calls.map(call=>call.id),source[0].calls.map(call=>call.id));assert.deepEqual(history.slice(1).map(row=>row.tool_call_id),source[0].calls.map(call=>call.id));
});

test('unknown tools, failed receipts, malformed payloads and unmapped historical IDs stay opaque',()=>{
  const source=round([
    completed('other','unknown_tool',{id:'memory_old'},{memory:meta(),deletedId:'memory_old'}),
    {...completed('error','memory_update',{id:'memory_old'},{}),status:'error',result:' {"ok":false,"error":{"id":"memory_old","message":"workspace_old"}} '},
    {...completed('broken','memory_read',{id:'memory_old'},{}),arguments:'malformed memory_old',result:'malformed workspace_old'},
    completed('missing','memory_read',{id:'deleted_memory'},{memory:{id:'deleted_memory',workspaceId:null},contentMarkdown:'memory_old'})
  ]),result=remapToolTrace(source,maps())[0].calls;
  assert.deepEqual(result[0],source[0].calls[0]);assert.equal(result[1].result,source[0].calls[1].result);assert.equal(result[2].arguments,source[0].calls[2].arguments);assert.equal(result[2].result,source[0].calls[2].result);
  assert.equal(JSON.parse(result[3].arguments).id,'deleted_memory');assert.deepEqual(JSON.parse(result[3].result).result.memory,{id:'deleted_memory',workspaceId:null});
  assert.throws(()=>remapToolTrace(source,{memoryIds:new Proxy(new Map(),{})}),/格式无效/);
});

test('minimal committed memory create/update receipts remap only their direct ID while opaque names and nested data retain literals',()=>{
  const literal={id:'memory_old',workspaceId:'workspace_old'},payload={committed:true,id:'memory_old',text:'memory_old',contentMarkdown:'memory_old',guidance:'memory_old',unknown:{...literal},data:{...literal}};
  const source=round([
    completed('create-fallback','memory_create',{name:'memory_old',contentMarkdown:'memory_old'},payload),
    completed('update-fallback','memory_update',{id:'memory_old',expectedRevision:1,contentMarkdown:'memory_old'},payload),
    completed('unknown-fallback','unknown_tool',{id:'memory_old'},payload)
  ]),original=copy(source),result=remapToolTrace(source,maps())[0].calls;
  for(const call of result.slice(0,2)){
    const value=JSON.parse(call.result).result;assert.equal(value.id,'memory_new');assert.equal(value.text,'memory_old');assert.equal(value.contentMarkdown,'memory_old');assert.equal(value.guidance,'memory_old');assert.deepEqual(value.unknown,literal);assert.deepEqual(value.data,literal);
  }
  assert.equal(JSON.parse(result[0].arguments).name,'memory_old');assert.equal(JSON.parse(result[1].arguments).id,'memory_new');assert.equal(JSON.parse(result[1].arguments).contentMarkdown,'memory_old');assert.deepEqual(result[2],source[0].calls[2]);assert.deepEqual(source,original);
});

test('real Store backup/import remaps memory/tool references and preserves pairing and all user-provided literal content',async t=>{
  const {store,directory}=fixture(t,'import'),workspace=store.createWorkspace({name:'original knowledge'}),memory=store.createMemory({workspaceId:workspace.id,name:'记忆',contentMarkdown:'original body'});
  const literal=`${memory.id} ${workspace.id}`,chat=store.createChat({workspaceId:workspace.id}),memoryMeta={...store.getMemory(memory.id),contentMarkdown:literal,data:{id:memory.id,workspaceId:workspace.id}};
  const trace=[{content:literal,calls:[
    completed('list','memory_search',{query:literal},{status:'ready',hits:[memoryMeta]}),
    completed('read','memory_read',{id:memory.id},{memory:memoryMeta,contentMarkdown:literal}),
    completed('write','memory_update',{id:memory.id,expectedRevision:1,contentMarkdown:literal},{committed:true,memory:memoryMeta}),
    completed('delete','memory_delete',{id:memory.id,expectedRevision:1},{committed:true,deletedId:memory.id})
  ]}];
  store.appendMessage(chat.id,{role:'assistant',content:literal,agentMode:true,toolTrace:trace});
  const original=store.getChat(chat.id).messages[0],result=await store.importData(store.exportData()),importedMemory=result.memories.find(value=>value.id!==memory.id),importedChat=result.chats.find(value=>value.id!==chat.id),message=importedChat.messages[0];
  assert.notEqual(importedMemory.id,memory.id);assert.notEqual(importedMemory.workspaceId,workspace.id);assert.equal(importedChat.workspaceId,importedMemory.workspaceId);assert.notEqual(message.id,original.id);
  for(const call of message.toolTrace[0].calls){
    const args=JSON.parse(call.arguments),payload=JSON.parse(call.result).result;
    if(call.name!=='memory_search')assert.equal(args.id,importedMemory.id);
    const item=payload.memory??payload.hits?.[0];if(item){assert.equal(item.id,importedMemory.id);assert.equal(item.workspaceId,importedMemory.workspaceId);assert.equal(item.contentMarkdown,literal);assert.deepEqual(item.data,{id:memory.id,workspaceId:workspace.id});}
    if(call.name==='memory_delete')assert.equal(payload.deletedId,importedMemory.id);
    if(call.name==='memory_update')assert.equal(args.contentMarkdown,literal);
  }
  assert.equal(message.content,literal);assert.equal(message.toolTrace[0].content,literal);assert.deepEqual(message.toolTrace[0].calls.map(call=>call.id),trace[0].calls.map(call=>call.id));
  assert.deepEqual(traceHistory(message.toolTrace).slice(1).map(row=>row.tool_call_id),trace[0].calls.map(call=>call.id));
  assert.deepEqual(new Store(directory).getChat(importedChat.id).messages[0].toolTrace,message.toolTrace);
});

test('import cancels pending memory writes before remapping and never reconstructs an execution from history',async t=>{
  const source=fixture(t,'pending-source'),destination=fixture(t,'pending-target'),workspace=source.store.createWorkspace({name:'pending'}),memory=source.store.createMemory({workspaceId:workspace.id,name:'source',contentMarkdown:'unchanged'}),chat=source.store.createChat({workspaceId:workspace.id});
  source.store.appendMessage(chat.id,{role:'assistant',content:'',status:'streaming',agentMode:true,toolTrace:[{content:'',calls:[{id:'waiting',name:'memory_update',arguments:JSON.stringify({id:memory.id,expectedRevision:1,contentMarkdown:'must never execute'}),status:'awaiting_approval'}]}]});
  const result=await destination.store.importData(source.store.exportData()),importedMemory=result.memories[0],message=result.chats[0].messages[0],call=message.toolTrace[0].calls[0];
  assert.equal(message.status,'cancelled');assert.equal(call.status,'cancelled');assert.equal(JSON.parse(call.arguments).id,importedMemory.id);assert.equal(JSON.parse(call.result).error.code,'cancelled');assert.equal(destination.store.getMemory(importedMemory.id).contentMarkdown,'unchanged');assert.equal(destination.store.getMemory(importedMemory.id).revision,1);
});

test('invalid memory trace backup is rejected atomically before destination memory/chat/state files change',async t=>{
  const source=fixture(t,'invalid-source'),destination=fixture(t,'invalid-target'),memory=source.store.createMemory({name:'source',contentMarkdown:'body'}),chat=source.store.createChat();
  source.store.appendMessage(chat.id,{role:'assistant',content:'history',agentMode:true,toolTrace:round([completed('valid','memory_read',{id:memory.id},{memory:{id:memory.id,workspaceId:null},contentMarkdown:'body'})])});
  destination.store.createMemory({name:'keep',contentMarkdown:'destination unchanged'});destination.store.createChat({title:'existing'});
  const before=destination.store.snapshot(),disk=fs.readFileSync(path.join(destination.directory,'state.json'));
  for(const mutate of [
    calls=>{calls.push({...calls[0]});},
    calls=>{calls[0].status='awaiting_approval';},
    calls=>{calls[0].arguments='x'.repeat(256001);},
    calls=>{calls[0].unexpected='injected';}
  ]){
    const backup=source.store.exportData();mutate(backup.chats[0].messages[0].toolTrace[0].calls);
    await assert.rejects(destination.store.importData(backup));assert.deepEqual(destination.store.snapshot(),before);assert.deepEqual(fs.readFileSync(path.join(destination.directory,'state.json')),disk);
  }
});

test('actual main context builder strips historical memory arguments/bodies on resend and preserves stored receipts and wire pairing',()=>{
  const mainPath=path.resolve(__dirname,'../main.cjs'),source=fs.readFileSync(mainPath,'utf8'),start=source.indexOf('function contextMessages('),end=source.indexOf('\nfunction releaseSend(',start);
  assert.ok(start>=0&&end>start,'actual main context function exists');
  const sandbox={store:{readFile(){throw Error('no files selected');}},traceHistory};
  vm.runInNewContext(source.slice(start,end)+'\n;globalThis.build=contextMessages;',sandbox,{filename:mainPath,timeout:1000});
  const names=['memory_search','memory_read','memory_create','memory_update','memory_delete','memory_rebuild_index'],secret='SYNTHETIC-OLD-MEMORY-BODY';
  const calls=names.map((name,index)=>completed('memory_'+index,name,{id:'memory_old',contentMarkdown:secret,guidance:secret},{memory:meta(),contentMarkdown:secret,guidance:secret}));
  calls.push(completed('ordinary','workspace_read_file',{id:'file_id'},{id:'file_id',text:'ordinary historical file receipt'}));
  const trace=round(calls),original=copy(trace),chat={workspaceId:null,messages:[{id:'assistant',role:'assistant',content:'ordinary summary',status:'complete',toolTrace:trace}]};
  const output=copy(sandbox.build(chat,null,{systemPrompt:'host policy'},{workspaces:[],files:[]})),assistant=output.find(row=>row.tool_calls),toolRows=output.filter(row=>row.role==='tool');
  assert.equal(JSON.stringify(output).includes(secret),false);assert.deepEqual(trace,original);assert.ok(JSON.stringify(trace).includes(secret));
  for(let index=0;index<names.length;index++){assert.equal(assistant.tool_calls[index].function.arguments,'{}');const result=JSON.parse(toolRows[index].content);assert.equal(result.result.historical,true);assert.equal(toolRows[index].tool_call_id,calls[index].id);}
  assert.deepEqual(JSON.parse(assistant.tool_calls.at(-1).function.arguments),{id:'file_id'});assert.equal(JSON.parse(toolRows.at(-1).content).result.text,'ordinary historical file receipt');
  assert.equal(output.at(-1).content,'ordinary summary');assert.deepEqual(assistant.tool_calls.map(row=>row.id),toolRows.map(row=>row.tool_call_id));
});
