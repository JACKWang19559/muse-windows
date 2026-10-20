'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Store}=require('../backend/store.cjs');
const {sourceDigest,pagesDigest}=require('../backend/artifact-model.cjs');
const {createAnnotation}=require('../backend/artifact-annotation.cjs');
function fixture(t){
  const parent=path.resolve(__dirname,'../.test-tmp/artifact-annotation-store');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'synthetic-annotation-')),dataDir=path.join(root,'data');
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),parent);assert.match(path.basename(root),/^synthetic-annotation-/);fs.rmSync(root,{recursive:true,force:true});});
  return{store:new Store(dataDir),root,dataDir};
}
function compile(store,id,label='synthetic'){
  const source=store.artifactSourceSnapshot(id),pages=[{path:'index.html',html:`<!doctype html><h1>${label}</h1>`}];
  const build={id:`build_${crypto.randomUUID()}`,sourceRevision:source.sourceRevision,createdAt:new Date().toISOString(),pages,sha256:pagesDigest(pages),sourceDigest:sourceDigest(source),builderVersion:'annotation-test'};
  store.commitArtifactBuild({id,sourceRevision:source.sourceRevision,build});return build;
}
function selected(store){
  const workspace=store.createWorkspace({name:'注释测试工作区'}),artifact=store.createArtifact({name:'注释测试应用',runtime:'html',workspaceId:workspace.id}),build=compile(store,artifact.id);
  const element={tag:'button',id:'submit',classes:['primary'],text:'ELEMENT_CONTEXT_SENTINEL',path:'body > main > button#submit.primary',viewport:{width:1280,height:800},click:{x:30,y:40}};
  const context=createAnnotation({artifact,build,pagePath:'index.html',element}),chat=store.createChat({title:'注释对话',workspaceId:workspace.id});
  return{workspace,artifact,build,context,chat};
}
const copies=store=>[store.statePath,store.backupPath].map(file=>fs.readFileSync(file,'utf8'));
function assertAtomic(store,before,files){assert.deepEqual(store.state,before);assert.deepEqual(copies(store),files);}

test('only user messages persist detached annotation snapshots; visible note remains separate on restart',t=>{
  const {store,dataDir}=fixture(t),s=selected(store),note='VISIBLE_NOTE_SENTINEL';
  const message=store.appendMessage(s.chat.id,{role:'user',content:note,artifactContext:s.context}),expected=structuredClone(message.artifactContext);
  s.context.element.text='changed by caller';message.artifactContext.element.id='changed returned copy';
  const saved=store.getChat(s.chat.id).messages[0];assert.equal(saved.content,note);assert.deepEqual(saved.artifactContext,expected);assert.equal(saved.content.includes(expected.element.text),false);
  assert.deepEqual(new Store(dataDir).getChat(s.chat.id).messages[0],saved);
  const before=structuredClone(store.state),files=copies(store);
  for(const role of ['assistant','system']){assert.throws(()=>store.appendMessage(s.chat.id,{role,content:'must not persist',artifactContext:expected}));assertAtomic(store,before,files);}
});
test('message updates may change normal delivery fields but cannot replace, add or remove the captured annotation',t=>{
  const {store}=fixture(t),s=selected(store),message=store.appendMessage(s.chat.id,{role:'user',content:'note',artifactContext:s.context});
  const plain=store.appendMessage(s.chat.id,{role:'user',content:'ordinary'}),before=structuredClone(store.state),files=copies(store);
  for(const [id,artifactContext]of [[message.id,{...s.context,buildId:'other_build'}],[message.id,null],[plain.id,s.context]]){
    assert.throws(()=>store.updateMessage(s.chat.id,id,{artifactContext}));assertAtomic(store,before,files);
  }
  const updated=store.updateMessage(s.chat.id,message.id,{status:'cancelled'});assert.equal(updated.status,'cancelled');assert.deepEqual(updated.artifactContext,s.context);
});
test('user-message deletion removes annotation and note from current state, recovery copy and new exports',t=>{
  const {store,dataDir}=fixture(t),s=selected(store),message=store.appendMessage(s.chat.id,{role:'user',content:'VISIBLE_NOTE_DELETE_SENTINEL',artifactContext:s.context});
  const reply=store.appendMessage(s.chat.id,{role:'user',content:'reply survives',replyToMessageId:message.id});
  store.deleteTurn({chatId:s.chat.id,messageId:message.id});const tomb=store.getChat(s.chat.id).messages.find(x=>x.id===message.id);
  assert.equal(tomb.isDeleted,true);assert.equal(tomb.content,'');assert.equal(Object.hasOwn(tomb,'artifactContext'),false);
  assert.equal(store.getChat(s.chat.id).messages.find(x=>x.id===reply.id).replyTo.excerpt,'');
  for(const serialized of [...copies(store),JSON.stringify(store.exportData())]){assert.equal(serialized.includes('ELEMENT_CONTEXT_SENTINEL'),false);assert.equal(serialized.includes('VISIBLE_NOTE_DELETE_SENTINEL'),false);}
  assert.deepEqual(new Store(dataDir).getChat(s.chat.id).messages.find(x=>x.id===message.id),tomb);
});
test('backup roundtrip maps surviving artifact/build identities and keeps all selected page literals unchanged',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store);s.context.element.text=`${s.artifact.id} ${s.build.id}`;s.context.element.id=s.artifact.id;s.context.element.classes=[s.build.id];s.context.element.path=`body > ${s.artifact.id} > ${s.build.id}`;
  const first=a.store.appendMessage(s.chat.id,{role:'user',content:'visible original note',artifactContext:s.context});
  a.store.appendMessage(s.chat.id,{role:'user',content:'quoted note',replyToMessageId:first.id,artifactContext:s.context});const backup=a.store.exportData(),unchanged=structuredClone(backup);
  await b.store.importData(JSON.parse(JSON.stringify(backup)));assert.deepEqual(backup,unchanged);
  const state=b.store.snapshot(),artifact=state.artifacts[0],chat=state.chats[0],context=chat.messages[0].artifactContext;
  assert.notEqual(artifact.id,s.artifact.id);assert.notEqual(artifact.builds[0].id,s.build.id);assert.equal(context.artifactId,artifact.id);assert.equal(context.buildId,artifact.builds[0].id);
  assert.equal(context.artifactName,s.context.artifactName);assert.equal(context.sourceRevision,s.context.sourceRevision);assert.equal(context.pagePath,'index.html');assert.deepEqual(context.element,s.context.element);
  assert.equal(chat.messages[0].content,'visible original note');assert.equal(chat.messages[1].replyTo.messageId,chat.messages[0].id);assert.deepEqual(chat.messages[1].artifactContext,context);
  assert.equal(chat.workspaceId,artifact.workspaceId);assert.equal('permissions'in context,false);
  assert.deepEqual(new Store(b.dataDir).getChat(chat.id).messages,chat.messages);
});
test('an older build remains a historical identity when export retains only the latest build',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store);a.store.appendMessage(s.chat.id,{role:'user',content:'old selected build',artifactContext:s.context});
  const latest=compile(a.store,s.artifact.id,'new build'),backup=a.store.exportData();assert.deepEqual(backup.artifacts[0].builds.map(x=>x.id),[latest.id]);
  await b.store.importData(backup);const artifact=b.store.snapshot().artifacts[0],context=b.store.snapshot().chats[0].messages[0].artifactContext;
  assert.equal(context.artifactId,artifact.id);assert.equal(context.buildId,s.build.id);assert.notEqual(artifact.builds[0].id,context.buildId);assert.throws(()=>b.store.readArtifactBuild({id:artifact.id,buildId:context.buildId}));
});
test('deleting an app keeps prior annotation history and importing it creates no phantom app/build',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store),message=a.store.appendMessage(s.chat.id,{role:'user',content:'history remains after app deletion',artifactContext:s.context});
  a.store.deleteArtifact(s.artifact.id);assert.deepEqual(a.store.getChat(s.chat.id).messages[0].artifactContext,s.context);
  const backup=a.store.exportData();assert.deepEqual(backup.artifacts,[]);await b.store.importData(backup);
  const chat=b.store.snapshot().chats[0];assert.notEqual(chat.id,s.chat.id);assert.notEqual(chat.messages[0].id,message.id);assert.deepEqual(chat.messages[0].artifactContext,s.context);
  assert.deepEqual(b.store.snapshot().artifacts,[]);assert.throws(()=>b.store.getArtifact(s.artifact.id));
});
test('deleted-app history never binds to an unrelated local app during an import merge',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store);a.store.appendMessage(s.chat.id,{role:'user',content:'historic note',artifactContext:s.context});a.store.deleteArtifact(s.artifact.id);
  const local=b.store.createArtifact({name:s.context.artifactName,runtime:'html'});compile(b.store,local.id);
  await b.store.importData(a.store.exportData());const context=b.store.snapshot().chats[0].messages[0].artifactContext;
  assert.equal(b.store.snapshot().artifacts.length,1);assert.equal(context.artifactId,s.artifact.id);assert.notEqual(context.artifactId,local.id);assert.equal(context.buildId,s.build.id);
});
test('malformed append contexts are rejected atomically without touching existing messages or recovery files',t=>{
  const {store}=fixture(t),s=selected(store),before=structuredClone(store.state),files=copies(store);
  for(const mutate of [a=>{a.kind='tool_grant';},a=>{a.element.click.x=Infinity;},a=>{a.sourceRevision=0;},a=>{a.pagePath='../outside.html';},a=>{a.element.path='x'.repeat(8193);},a=>{a.element.authority='write';},a=>{a.permissions=['write'];}]){
    const context=structuredClone(s.context);mutate(context);assert.throws(()=>store.appendMessage(s.chat.id,{role:'user',content:'rejected',artifactContext:context}));assertAtomic(store,before,files);
  }
  let called=0;const accessor=structuredClone(s.context);Object.defineProperty(accessor.element,'text',{enumerable:true,get(){called++;return'never';}});
  assert.throws(()=>store.appendMessage(s.chat.id,{role:'user',content:'rejected',artifactContext:accessor}));assert.equal(called,0);assertAtomic(store,before,files);
});
test('malformed, assistant and tombstoned backup contexts fail the entire merge before any mutation',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store);a.store.appendMessage(s.chat.id,{role:'user',content:'source note',artifactContext:s.context});b.store.createChat({title:'existing destination'});
  const backup=a.store.exportData(),before=structuredClone(b.store.state),files=copies(b.store);
  for(const mutate of [m=>{m.artifactContext.element.viewport.height=-1;},m=>{m.artifactContext.toolsAllowed=true;},m=>{m.role='assistant';},m=>{m.isDeleted=true;m.content='';},m=>{m.artifactContext.buildId='../../bad';}]){
    const value=structuredClone(backup);mutate(value.chats[0].messages[0]);await assert.rejects(b.store.importData(value));assertAtomic(b.store,before,files);
  }
});
test('valid tombstones survive backup import without recreating cleared annotation data',async t=>{
  const a=fixture(t),b=fixture(t),s=selected(a.store),message=a.store.appendMessage(s.chat.id,{role:'user',content:'removed',artifactContext:s.context});a.store.deleteTurn({chatId:s.chat.id,messageId:message.id});
  await b.store.importData(a.store.exportData());const tomb=b.store.snapshot().chats[0].messages[0];assert.equal(tomb.isDeleted,true);assert.equal(tomb.content,'');assert.equal('artifactContext'in tomb,false);
});
