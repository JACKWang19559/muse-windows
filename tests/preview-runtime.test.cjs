'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const { buildArtifact } = require('../backend/artifact-builder.cjs');
const { PreviewRuntime, decorate, CSP } = require('../backend/preview-runtime.cjs');
async function setup(t) {
  const parent = path.resolve(__dirname,'../.test-tmp/preview'); fs.mkdirSync(parent,{recursive:true});
  const directory = fs.mkdtempSync(path.join(parent,'preview-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),parent);fs.rmSync(directory,{recursive:true,force:true});});
  const store = new Store(directory,{encrypt:value=>Buffer.from(value),decrypt:value=>Buffer.from(value).toString()});
  const space = store.createWorkspace({name:'preview scope'});
  const artifact = store.createArtifact({name:'test app',runtime:'html',workspaceId:space.id});
  const source = store.artifactSourceSnapshot(artifact.id), build = await buildArtifact(source);
  store.commitArtifactBuild({id:artifact.id,sourceRevision:source.sourceRevision,build});
  let now = 100;
  const runtime = new PreviewRuntime(store,{now:()=>now});
  const session = await runtime.open({id:artifact.id});
  return {store,space,artifact,build,runtime,session,advance:()=>{now+=31*60*1000;}};
}
test('preview injects its restrictive policy and SDK before authored content without executing it',async()=>{
  globalThis.previewExecuted = false;
  const html = await decorate('<base href="file:///C:/"><meta http-equiv="refresh" content="0;url=https://example.com"><script>globalThis.previewExecuted=true</script><p>safe</p>',{sessionId:'test',documentToken:'token'});
  assert.equal(globalThis.previewExecuted,false); delete globalThis.previewExecuted;
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('museArtifact'));
  assert.ok(html.indexOf('museArtifact')<html.indexOf('globalThis.previewExecuted=true'));
  assert.ok(!html.includes('<base')); assert.ok(!html.includes('http-equiv="refresh"'));
  assert.match(CSP,/connect-src 'none'/);assert.match(CSP,/frame-src 'none'/);
});
test('preview owns only its app data; identity, loaded acknowledgement and exact request fields are required',async t=>{
  const {runtime,session,store,artifact} = await setup(t);
  assert.match(session.url,/^muse-preview:\/\/document\//);
  assert.equal(session.html,undefined);
  assert.ok(runtime.document(session.url).includes('museArtifact'));
  assert.throws(()=>runtime.document(session.url+'?x=1'));
  const input={...session,requestId:'first',action:'set',payload:{key:'count',value:1,expectedVersion:0}};
  assert.throws(()=>runtime.request(input),/尚未就绪/);
  assert.throws(()=>runtime.activate({...session,documentToken:'wrong'}),/失效/);
  runtime.activate(session);
  assert.throws(()=>runtime.request({...input,payload:{...input.payload,id:'another-app'}}),/未授权字段/);
  const result=runtime.request(input); assert.equal(result.version,1);
  assert.deepEqual(runtime.request(input),result);
  assert.equal(store.getArtifact(artifact.id).dataVersion,1,'replayed request does not commit twice');
  assert.throws(()=>runtime.request({...input,payload:{...input.payload,value:2}}),/不同内容/);
  assert.throws(()=>runtime.request({...input,requestId:'stale-version',payload:{...input.payload,value:2}}),/版本|变化/);
  const state=store.snapshot();assert.equal(state.artifacts[0].data,undefined);
  assert.equal(state.artifacts[0].files[0].text,undefined);assert.equal(state.artifacts[0].builds[0].pages[0].html,undefined);
  runtime.close(session);assert.throws(()=>runtime.request({...input,requestId:'closed'}),/失效/);
});
test('preview sessions reject expiration and workspace changes while immutable older builds may run',async t=>{
  const {runtime,session,store,artifact,space,advance}=await setup(t);
  runtime.activate(session);
  store.writeArtifactFiles({id:artifact.id,expectedRevision:1,files:[{path:'extra.txt',text:'new revision'}]});
  assert.ok(runtime.document(session.url),'editing source keeps immutable build usable');
  store.deleteWorkspace(space.id);
  assert.throws(()=>runtime.document(session.url),/范围已变化/);
  const fresh=await runtime.open({id:artifact.id});advance();assert.throws(()=>runtime.activate(fresh),/失效/);
});
test('deleting an app revokes its preview and document URL',async t=>{
  const {runtime,session,store,artifact}=await setup(t);store.deleteArtifact(artifact.id);
  assert.throws(()=>runtime.document(session.url),/不存在/);
  assert.deepEqual(runtime.close(session),{closed:true},'invalidated sessions can still be cleaned up');
});
test('parallel preview admission never exceeds 32 sessions and close authenticates the token',async t=>{
  const {runtime,session,artifact}=await setup(t);
  const results=await Promise.allSettled(Array.from({length:33},()=>runtime.open({id:artifact.id})));
  assert.equal(results.filter(value=>value.status==='fulfilled').length,31);
  assert.throws(()=>runtime.close({...session,documentToken:'wrong'}),/身份无效/);
  assert.ok(runtime.document(session.url));runtime.close(session);
  assert.ok(await runtime.open({id:artifact.id}));runtime.closeAll();
  assert.throws(()=>runtime.document(session.url),/失效/);
});
