'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ImageResource,imageKey}=require('../renderer/image-resource.cjs');
const {MAX_IMAGE_FILE_BYTES}=require('../backend/image-format.cjs');
const hash='a'.repeat(64),file=(id='first',name=id+'.png')=>({id,name,sha256:hash});
function reply(f,bytes=Uint8Array.from([0,1,2,255]).buffer){return{id:f.id,name:f.name,mimeType:f.name.toLowerCase().endsWith('.svg')?'image/svg+xml':'image/png',size:bytes.byteLength,sha256:f.sha256||hash,image:bytes};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(read=async input=>reply({id:input.id,name:input.expectedName,sha256:input.expectedSha256})){
 const reads=[],views=[],created=[],revoked=[];
 const resource=new ImageResource({readFile:input=>{reads.push(input);return read(input);},onChange:view=>views.push({...view}),createURL:blob=>{created.push(blob);return'blob:fixture-'+created.length;},revokeURL:url=>revoked.push(url)});
 return{resource,reads,views,created,revoked};
}
test('binary preparation owns a Blob but only the matching decode event marks an image ready',async()=>{
 const f=fixture(),selected=file();await f.resource.load(selected);assert.deepEqual(f.reads,[{id:selected.id,expectedName:selected.name,expectedSha256:hash}]);
 assert.deepEqual(f.views.map(v=>v.status),['loading','prepared']);assert.equal(f.created[0].type,'image/png');assert.deepEqual([...new Uint8Array(await f.created[0].arrayBuffer())],[0,1,2,255]);
 f.resource.decoded('blob:unrelated');assert.equal(f.views.at(-1).status,'prepared');f.resource.decoded(f.views.at(-1).url);assert.equal(f.views.at(-1).status,'ready');f.resource.dispose();assert.deepEqual(f.revoked,['blob:fixture-1']);
});
test('SVG Blob preserves complete UTF8 bytes rather than injecting document markup',async()=>{
 const selected=file('svg','drawing.svg'),bytes=new TextEncoder().encode('\ufeff<svg>\r\n<text>汉字</text></svg>').buffer,f=fixture(async()=>reply(selected,bytes));
 await f.resource.load(selected);assert.equal(f.created[0].type,'image/svg+xml');assert.deepEqual(Buffer.from(await f.created[0].arrayBuffer()),Buffer.from(bytes));assert.equal(f.views.at(-1).status,'prepared');f.resource.dispose();
});
test('a replaced pending read cannot allocate a URL or publish after the current image',async()=>{
 const first=deferred(),a=file('old'),b=file('new'),f=fixture(input=>input.id===a.id?first.promise:Promise.resolve(reply(b)));
 const old=f.resource.load(a);await f.resource.load(b);const current={...f.views.at(-1)},count=f.views.length;first.resolve(reply(a));await old;
 assert.equal(f.created.length,1);assert.equal(f.views.length,count);assert.deepEqual(f.views.at(-1),current);assert.equal(current.key,imageKey(b));f.resource.dispose();
});
test('late errors and closing a pending viewer cause no allocation or future publication',async()=>{
 const pending=deferred(),f=fixture(()=>pending.promise),load=f.resource.load(file());assert.equal(f.views.at(-1).status,'loading');f.resource.decoded(null);f.resource.failed(null);assert.equal(f.views.at(-1).status,'loading');f.resource.dispose();f.resource.dispose();const count=f.views.length;
 pending.resolve(reply(file()));await load;await f.resource.load(file('ignored'));assert.equal(f.views.length,count);assert.equal(f.reads.length,1);assert.equal(f.created.length,0);assert.deepEqual(f.revoked,[]);
 const old=deferred(),g=fixture(input=>input.id==='old'?old.promise:Promise.resolve(reply(file('new'))));const stale=g.resource.load(file('old'));await g.resource.load(file('new'));old.reject(Error('stale read failure'));await stale;assert.equal(g.views.at(-1).status,'prepared');assert.equal(g.created.length,1);g.resource.dispose();
});
test('replacing an existing URL revokes it immediately and stale load/error events cannot affect the new view',async()=>{
 const pending=deferred(),a=file('first'),b=file('second'),f=fixture(input=>input.id===b.id?pending.promise:Promise.resolve(reply(a)));
 await f.resource.load(a);const oldURL=f.views.at(-1).url;f.resource.decoded(oldURL);const second=f.resource.load(b);assert.deepEqual(f.revoked,[oldURL]);assert.equal(f.views.at(-1).status,'loading');
 f.resource.decoded(oldURL);f.resource.failed(oldURL);assert.equal(f.views.at(-1).status,'loading');pending.resolve(reply(b));await second;const newURL=f.views.at(-1).url;
 f.resource.failed(oldURL);f.resource.decoded(oldURL);assert.equal(f.views.at(-1).status,'prepared');f.resource.decoded(newURL);assert.equal(f.views.at(-1).status,'ready');f.resource.dispose();assert.deepEqual(f.revoked,[oldURL,newURL]);
});
test('decode failure releases its URL, preserves an actionable error and permits a fresh retry',async()=>{
 const f=fixture(),selected=file();await f.resource.load(selected);const old=f.views.at(-1).url;f.resource.failed(old);assert.equal(f.views.at(-1).status,'error');assert.equal(f.views.at(-1).url,null);assert.match(f.views.at(-1).error,/无法解码/);assert.deepEqual(f.revoked,[old]);
 f.resource.decoded(old);assert.equal(f.views.at(-1).status,'error');await f.resource.load(selected);const next=f.views.at(-1).url;assert.notEqual(next,old);assert.equal(f.views.at(-1).status,'prepared');f.resource.failed(old);assert.equal(f.views.at(-1).status,'prepared');f.resource.decoded(next);assert.equal(f.views.at(-1).status,'ready');f.resource.dispose();
});
test('malformed host replies never allocate a Blob URL',async()=>{
 const selected=file(),oversized=new ArrayBuffer(MAX_IMAGE_FILE_BYTES+1),variants=[null,{}, {...reply(selected),id:'other'},{...reply(selected),name:'other.png'},{...reply(selected),mimeType:'text/html'},{...reply(selected),image:new Uint8Array(4)},{...reply(selected),size:-1},{...reply(selected),size:4.5},{...reply(selected),size:3},{...reply(selected),sha256:'bad'},{...reply(selected),sha256:'b'.repeat(64)},reply(selected,oversized)];
 for(const result of variants){const f=fixture(async()=>result);await f.resource.load(selected);assert.equal(f.views.at(-1).status,'error');assert.equal(f.views.at(-1).url,null);assert.equal(f.created.length,0);assert.deepEqual(f.revoked,[]);f.resource.dispose();}
});
test('unsupported files avoid host reads and current read failures clean the IPC prefix for retry',async()=>{
 const f=fixture();await f.resource.load(file('text','text.txt'));assert.equal(f.reads.length,0);assert.equal(f.created.length,0);assert.equal(f.views.at(-1).status,'error');f.resource.dispose();
 const g=fixture(async()=>{throw Error("Error invoking remote method 'muse:invoke': Error: 图片读取失败");});await g.resource.load(file());assert.equal(g.views.at(-1).error,'图片读取失败');assert.equal(g.created.length,0);g.resource.dispose();
 assert.notEqual(imageKey(file()),imageKey({...file(),name:'renamed.png'}));assert.notEqual(imageKey(file()),imageKey({...file(),sha256:'b'.repeat(64)}));
});
