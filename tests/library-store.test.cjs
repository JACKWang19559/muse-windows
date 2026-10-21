'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../backend/store.cjs');

function fixture(t){
 const parent=path.resolve(__dirname,'../.test-tmp/library-store');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'synthetic-library-')),data=path.join(root,'data'),store=new Store(data);
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),parent);assert.match(path.basename(root),/^synthetic-library-/);fs.rmSync(root,{recursive:true,force:true});});
 return{store,data,root};
}
const tuple=(kind,item)=>({kind,id:item.id,workspaceId:item.workspaceId});
const pin=(store,p,pinned=true,expectedPinned=false)=>store.setLibraryPin({...p,pinned,expectedPinned});
async function items(store,workspaceId=null){const {file}=await store.createTextFile({name:'synthetic.txt',content:'synthetic original bytes',workspaceId});const artifact=store.createArtifact({name:'synthetic app',runtime:'html',workspaceId});return{file,artifact,f:tuple('file',file),a:tuple('artifact',artifact)};}
function retained(store){return{state:structuredClone(store.state),primary:fs.readFileSync(store.statePath),backup:fs.existsSync(store.backupPath)?fs.readFileSync(store.backupPath):null,attachments:fs.readdirSync(store.attachmentsDir).sort().map(name=>({name,bytes:fs.readFileSync(path.join(store.attachmentsDir,name))}))};}
function unchanged(store,before){assert.deepEqual(retained(store),before);}

test('local pin order persists through restart and detached snapshots without exposing managed content or paths',async t=>{
 const {store,data}=fixture(t),x=await items(store),workspace=store.createWorkspace({name:'second scope'}),y=await items(store,workspace.id);
 assert.deepEqual(store.snapshot().libraryPins,[]);assert.deepEqual(store.libraryItem(x.f),x.f);
 const result=pin(store,x.a);assert.deepEqual(result,{...x.a,pinned:true});result.id='caller-changed';
 pin(store,y.f);pin(store,x.f);pin(store,x.a,true,true);
 const expected=[x.a,y.f,x.f];assert.deepEqual(store.snapshot().libraryPins,expected);
 const snapshot=store.snapshot();snapshot.libraryPins[0].id='caller-changed';snapshot.libraryPins.push(y.a);
 assert.deepEqual(new Store(data).snapshot().libraryPins,expected);assert.deepEqual(store.exportData().libraryPins,expected);
 assert.deepEqual(Object.keys(store.libraryItem(x.f)),['kind','id','workspaceId']);
});
test('unpin then repin appends to the fixed order, and stale expectedPinned never changes durable data',async t=>{
 const {store}=fixture(t),x=await items(store);pin(store,x.f);pin(store,x.a);pin(store,x.f,false,true);pin(store,x.f);
 assert.deepEqual(store.snapshot().libraryPins,[x.a,x.f]);const before=retained(store);
 assert.throws(()=>pin(store,x.f,false,false),/固定状态已变化/);unchanged(store,before);
 assert.throws(()=>pin(store,x.a,true,false),/固定状态已变化/);unchanged(store,before);
 pin(store,x.f,false,true);const unpinned=retained(store);assert.throws(()=>pin(store,x.f,true,true),/固定状态已变化/);unchanged(store,unpinned);
});
test('live item lookup and pin changes require the exact current kind, identifier and workspace',async t=>{
 const {store}=fixture(t),workspace=store.createWorkspace({name:'scoped'}),other=store.createWorkspace({name:'other'}),x=await items(store,workspace.id),before=retained(store);
 for(const p of [{...x.f,workspaceId:null},{...x.f,workspaceId:other.id},{...x.a,kind:'file'},{...x.f,kind:'artifact'},{kind:'file',id:'missing',workspaceId:workspace.id}]){
  assert.throws(()=>store.libraryItem(p));assert.throws(()=>pin(store,p));unchanged(store,before);
 }
 store.deleteWorkspace(workspace.id);const afterMove=retained(store);assert.throws(()=>pin(store,x.f));unchanged(store,afterMove);
 assert.deepEqual(store.libraryItem({...x.f,workspaceId:null}),{...x.f,workspaceId:null});
});
test('pin and deletion tuple validation reject coercion, getters, proxies, inherited and unexpected fields before side effects',async t=>{
 const {store}=fixture(t),x=await items(store),before=retained(store);let accessed=0;
 const getter={...x.f};Object.defineProperty(getter,'id',{enumerable:true,get(){accessed++;return x.f.id;}});
 const hidden={...x.f};Object.defineProperty(hidden,'extra',{value:'ignored',enumerable:false});
 const symbol={...x.f,[Symbol('extra')]:true};const badId={...x.f,id:{toString(){accessed++;return x.f.id;}}};
 const proxy=new Proxy(x.f,{ownKeys(){accessed++;throw Error('must not inspect');}});
 const inherited=Object.assign(Object.create({workspaceId:null}),{kind:'file',id:x.f.id});
 for(const p of [null,[],getter,hidden,symbol,badId,proxy,inherited,Object.assign(Object.create(null),x.f),{...x.f,kind:1},{...x.f,id:'../path'},{...x.f,path:'not-an-allowed-path'},{kind:'file',id:x.f.id}, {...x.f,content:'never accepted'}]){
  assert.throws(()=>store.libraryItem(p));assert.throws(()=>store.setLibraryPin(p));unchanged(store,before);
 }
 for(const p of [{...x.f,pinned:true},{...x.f,pinned:'true',expectedPinned:false},{...x.f,pinned:true,expectedPinned:0},{...x.f,pinned:true,expectedPinned:false,path:'unexpected'}]){assert.throws(()=>store.setLibraryPin(p));unchanged(store,before);}
 assert.equal(accessed,0);
});
test('old local state without libraryPins migrates to an empty list while existing files and apps remain intact',async t=>{
 const {store,data}=fixture(t),x=await items(store);store.flush();
 for(const filename of [store.statePath,store.backupPath]){const old=JSON.parse(fs.readFileSync(filename,'utf8'));delete old.libraryPins;fs.writeFileSync(filename,JSON.stringify(old));}
 const reopened=new Store(data);assert.deepEqual(reopened.snapshot().libraryPins,[]);assert.deepEqual(reopened.getFile(x.file.id),x.file);assert.equal(reopened.getArtifact(x.artifact.id).id,x.artifact.id);
 assert.deepEqual(JSON.parse(fs.readFileSync(reopened.statePath,'utf8')).libraryPins,[]);
});
test('backup merge remaps scoped and personal pins by kind and appends after existing local pins without changing the backup',async t=>{
 const a=fixture(t),b=fixture(t),ws=a.store.createWorkspace({name:'import scope'}),scoped=await items(a.store,ws.id),personal=await items(a.store),local=await items(b.store);
 pin(a.store,scoped.a);pin(a.store,personal.f);pin(a.store,scoped.f);pin(a.store,personal.a);pin(b.store,local.a);pin(b.store,local.f);
 const backup=a.store.exportData(),untouched=structuredClone(backup);await b.store.importData(backup);assert.deepEqual(backup,untouched);
 const s=b.store.snapshot(),newWs=s.workspaces.find(w=>w.name===ws.name),imported=s.libraryPins.slice(2);
 assert.deepEqual(s.libraryPins.slice(0,2),[local.a,local.f]);assert.deepEqual(imported.map(p=>p.kind),['artifact','file','file','artifact']);
 assert.deepEqual(imported.map(p=>p.workspaceId),[newWs.id,null,newWs.id,null]);assert.notEqual(newWs.id,ws.id);
 for(let i=0;i<imported.length;i++){assert.notEqual(imported[i].id,backup.libraryPins[i].id);assert.deepEqual(b.store.libraryItem(imported[i]),imported[i]);}
 assert.deepEqual(new Store(b.data).snapshot().libraryPins,s.libraryPins);
});
test('kind-qualified import IDs remain distinct even when a valid backup file and app share an old identifier',async t=>{
 const a=fixture(t),b=fixture(t),x=await items(a.store),backup=a.store.exportData();backup.artifacts[0].id=x.file.id;
 backup.libraryPins=[x.f,{kind:'artifact',id:x.file.id,workspaceId:null}];await b.store.importData(backup);
 const s=b.store.snapshot();assert.deepEqual(s.libraryPins,[tuple('file',s.files[0]),tuple('artifact',s.artifacts[0])]);assert.notEqual(s.files[0].id,s.artifacts[0].id);
});
test('an old backup missing pins merges without inventing or clearing existing local pins',async t=>{
 const a=fixture(t),b=fixture(t),source=await items(a.store),local=await items(b.store);pin(a.store,source.f);pin(b.store,local.a);
 const old=a.store.exportData();delete old.libraryPins;await b.store.importData(old);assert.deepEqual(b.store.snapshot().libraryPins,[local.a]);
 assert.equal(b.store.snapshot().files.length,2);assert.equal(b.store.snapshot().artifacts.length,2);
});
test('dangling, duplicate, cross-scope or wrong-kind backup pins reject the entire merge before preparing file copies',async t=>{
 const a=fixture(t),b=fixture(t),ws=a.store.createWorkspace({name:'source'}),x=await items(a.store,ws.id);pin(a.store,x.f);await items(b.store);const backup=a.store.exportData(),before=retained(b.store);
 const malformed=[[],[x.f,x.f],[{...x.f,id:'missing'}],[{...x.f,workspaceId:null}],[{...x.f,workspaceId:'missing_workspace'}],[{...x.f,kind:'artifact'}],[{...x.f,path:'not allowed'}]];
 malformed[0]=[{...x.f,pinned:true}];
 for(const libraryPins of malformed){await assert.rejects(b.store.importData({...structuredClone(backup),libraryPins}));unchanged(b.store,before);}
});
test('backup pin accessors, sparse arrays, extra keys and proxies are rejected without invoking serialization hooks',async t=>{
 const a=fixture(t),b=fixture(t),x=await items(a.store),backup=a.store.exportData(),before=retained(b.store);let reads=0;
 const p={...x.f};Object.defineProperty(p,'id',{enumerable:true,get(){reads++;return x.f.id;}});
 const toJSON={...x.f,toJSON(){reads++;return x.f;}};
 const sparse=Array(1),arrayGetter=[];Object.defineProperty(arrayGetter,'0',{enumerable:true,get(){reads++;return x.f;}});
 const extra=[x.f];extra.path='unexpected';const oversize=[];oversize.length=20001;
 for(const libraryPins of [[p],[toJSON],sparse,arrayGetter,extra,oversize,new Proxy([x.f],{}),[new Proxy(x.f,{})]]){
  await assert.rejects(b.store.importData({...backup,libraryPins}));unchanged(b.store,before);
 }
 const top={...backup};Object.defineProperty(top,'libraryPins',{enumerable:true,get(){reads++;return[x.f];}});await assert.rejects(b.store.importData(top));unchanged(b.store,before);assert.equal(reads,0);
});
test('deleting a file or app clears only that live pin and preserves descriptive chat data and other pins',async t=>{
 const {store,data}=fixture(t),x=await items(store),y=await items(store),chat=store.createChat({title:'synthetic history'});
 store.appendMessage(chat.id,{role:'user',content:'PIN_IS_ONLY_LOCAL_UI_STATE',activePanel:{kind:'artifact',artifactId:x.artifact.id,artifactName:x.artifact.name},attachmentIds:[x.file.id]});
 pin(store,x.f);pin(store,x.a);pin(store,y.f);pin(store,y.a);store.removeFile(x.file.id);
 assert.deepEqual(store.snapshot().libraryPins,[x.a,y.f,y.a]);assert.equal(fs.existsSync(path.join(store.attachmentsDir,x.file.id+'.txt')),false);
 store.deleteArtifact(x.artifact.id);assert.deepEqual(store.snapshot().libraryPins,[y.f,y.a]);const message=store.getChat(chat.id).messages[0];
 assert.equal(message.content,'PIN_IS_ONLY_LOCAL_UI_STATE');assert.equal(message.activePanel.artifactId,x.artifact.id);assert.deepEqual(message.attachmentIds,[]);
 assert.deepEqual(new Store(data).snapshot().libraryPins,[y.f,y.a]);
});
test('workspace deletion moves existing pinned files and apps to personal scope without reordering or losing them',async t=>{
 const {store,data}=fixture(t),ws=store.createWorkspace({name:'moving scope'}),x=await items(store,ws.id),y=await items(store);pin(store,x.f);pin(store,y.a);pin(store,x.a);
 store.deleteWorkspace(ws.id);const expected=[{...x.f,workspaceId:null},y.a,{...x.a,workspaceId:null}];assert.deepEqual(store.snapshot().libraryPins,expected);
 assert.equal(store.getFile(x.file.id).workspaceId,null);assert.equal(store.getArtifact(x.artifact.id).workspaceId,null);assert.deepEqual(new Store(data).snapshot().libraryPins,expected);
 const before=retained(store);assert.throws(()=>store.libraryItem(x.a));assert.throws(()=>pin(store,x.f,false,true));unchanged(store,before);
 pin(store,expected[0],false,true);assert.deepEqual(store.snapshot().libraryPins,[y.a,expected[2]]);
});
test('failed persistence does not acknowledge a pin or mutate in-memory order',async t=>{
 const {store}=fixture(t),x=await items(store),before=retained(store),persist=store._persistState;
 store._persistState=()=>{throw Error('SYNTHETIC_DISK_FAILURE');};try{assert.throws(()=>pin(store,x.f),/SYNTHETIC_DISK_FAILURE/);}finally{store._persistState=persist;}
 unchanged(store,before);pin(store,x.f);assert.deepEqual(store.snapshot().libraryPins,[x.f]);
});
test('invalid pin records in both local state and its recovery backup are rejected without rewriting either source',async t=>{
 const {store,data}=fixture(t),x=await items(store);pin(store,x.f);store.flush();
 for(const filename of [store.statePath,store.backupPath]){const malformed=JSON.parse(fs.readFileSync(filename,'utf8'));malformed.libraryPins=[x.f,x.f];fs.writeFileSync(filename,JSON.stringify(malformed));}
 const bytes=[store.statePath,store.backupPath].map(f=>fs.readFileSync(f));assert.throws(()=>new Store(data),/自动备份均无法读取/);
 assert.deepEqual([store.statePath,store.backupPath].map(f=>fs.readFileSync(f)),bytes);assert.deepEqual(fs.readdirSync(data).filter(n=>n.includes('.corrupt-')),[]);
});

const scopeOrder=(store,workspaceId)=>store.snapshot().libraryPins.filter(p=>p.workspaceId===workspaceId);
const move=(store,item,edge,anchor,expectedOrder=scopeOrder(store,item.workspaceId))=>store.moveLibraryPin({item,position:{[edge]:anchor},expectedOrder});

test('relative pin movement changes only its scope slots across file and app kinds and preserves all content and references',async t=>{
 const {store}=fixture(t),ws=store.createWorkspace({name:'reorder scope'}),other=store.createWorkspace({name:'untouched scope'}),x=await items(store,ws.id),y=await items(store,ws.id),personal=await items(store),foreign=await items(store,other.id);
 const chat=store.createChat({workspaceId:ws.id,title:'retained history'});store.appendMessage(chat.id,{role:'user',content:'SYNTHETIC_REORDER_DOES_NOT_EDIT_CHAT',attachmentIds:[x.file.id],activePanel:{kind:'artifact',artifactId:x.artifact.id,artifactName:x.artifact.name}});
 const original=[personal.f,x.f,foreign.a,x.a,personal.a,y.f,foreign.f,y.a];for(const p of original)pin(store,p);
 const before=retained(store),input={item:y.a,position:{before:x.f},expectedOrder:[x.f,x.a,y.f,y.a]},copy=structuredClone(input),result=store.moveLibraryPin(input);
 const expected=[personal.f,y.a,foreign.a,x.f,personal.a,x.a,foreign.f,y.f];assert.deepEqual(store.snapshot().libraryPins,expected);assert.deepEqual(result,[y.a,x.f,x.a,y.f]);assert.deepEqual(input,copy);
 result[0].id='caller-edited';assert.deepEqual(store.snapshot().libraryPins,expected);
 const after=retained(store);assert.deepEqual({...after.state,libraryPins:before.state.libraryPins},before.state);assert.deepEqual(after.attachments,before.attachments);
 assert.deepEqual(move(store,y.a,'after',x.a),[x.f,x.a,y.a,y.f]);assert.deepEqual(store.snapshot().libraryPins,[personal.f,x.f,foreign.a,x.a,personal.a,y.a,foreign.f,y.f]);
 const scopedSlots=store.snapshot().libraryPins.map((p,i)=>p.workspaceId===ws.id?i:null).filter(i=>i!==null);assert.deepEqual(scopedSlots,[1,3,5,7]);
 move(store,personal.a,'before',personal.f);assert.deepEqual(store.snapshot().libraryPins,[personal.a,x.f,foreign.a,x.a,personal.f,y.a,foreign.f,y.f]);
});

test('reorder compares the entire current scope order, rejecting omissions extras changed kinds and stale concurrent writes',async t=>{
 const {store}=fixture(t),x=await items(store),y=await items(store);for(const p of[x.f,x.a,y.f])pin(store,p);const expected=scopeOrder(store,null);
 for(const order of [[x.f,x.a],expected.slice().reverse(),[x.f,x.a,y.f,y.a],[x.f,{...x.a,kind:'file'},y.f]]){const before=retained(store);assert.throws(()=>move(store,x.f,'after',x.a,order),/顺序已变化/);unchanged(store,before);}
 pin(store,y.a);let before=retained(store);assert.throws(()=>move(store,x.f,'after',x.a,expected),/顺序已变化/);unchanged(store,before);
 const current=scopeOrder(store,null);move(store,y.a,'before',x.f,current);before=retained(store);assert.throws(()=>move(store,x.a,'after',y.f,current),/顺序已变化/);unchanged(store,before);
 pin(store,y.a,false,true);before=retained(store);assert.throws(()=>move(store,x.f,'after',x.a,[y.a,x.f,x.a,y.f]),/顺序已变化/);unchanged(store,before);
});

test('reorder requires live pinned distinct item and anchor in exactly the same workspace',async t=>{
 const {store}=fixture(t),ws=store.createWorkspace({name:'scope'}),x=await items(store,ws.id),personal=await items(store),y=await items(store,ws.id);for(const p of[x.f,x.a,personal.a])pin(store,p);
 const invalid=[{item:x.f,position:{before:x.f},expectedOrder:[x.f,x.a]},{item:x.f,position:{after:personal.a},expectedOrder:[x.f,x.a]},{item:{...x.f,workspaceId:null},position:{before:personal.a},expectedOrder:[personal.a]},{item:y.f,position:{before:x.f},expectedOrder:[x.f,x.a]},{item:x.f,position:{before:y.a},expectedOrder:[x.f,x.a]},{item:{...x.f,kind:'artifact'},position:{before:x.a},expectedOrder:[x.f,x.a]},{item:x.f,position:{before:{kind:'artifact',id:'missing',workspaceId:ws.id}},expectedOrder:[x.f,x.a]}];
 for(const input of invalid){const before=retained(store);assert.throws(()=>store.moveLibraryPin(input));unchanged(store,before);}
 store.removeFile(x.file.id);let before=retained(store);assert.throws(()=>move(store,x.f,'before',x.a,[x.f,x.a]),/不存在/);unchanged(store,before);
 store.deleteArtifact(x.artifact.id);before=retained(store);assert.throws(()=>move(store,y.f,'after',x.a,[]),/不存在/);unchanged(store,before);
});

test('workspace deletion invalidates captured reorder tuples and permits a fresh personal-scope order only',async t=>{
 const {store}=fixture(t),ws=store.createWorkspace({name:'removed scope'}),x=await items(store,ws.id),personal=await items(store);for(const p of[x.f,personal.a,x.a])pin(store,p);
 const old=[x.f,x.a];store.deleteWorkspace(ws.id);const before=retained(store);assert.throws(()=>move(store,x.a,'before',x.f,old),/空间/);unchanged(store,before);
 const f={...x.f,workspaceId:null},a={...x.a,workspaceId:null};assert.deepEqual(move(store,a,'before',f),[a,f,personal.a]);
});

test('reorder strict envelopes positions tuples and order arrays reject accessors proxies symbols and inherited data without invoking hooks',async t=>{
 const {store}=fixture(t),x=await items(store);pin(store,x.f);pin(store,x.a);const good={item:x.f,position:{after:x.a},expectedOrder:[x.f,x.a]},before=retained(store);let accesses=0;
 const getter=(object,key)=>{const result={...object};Object.defineProperty(result,key,{enumerable:true,get(){accesses++;return object[key];}});return result;};
 const proxy=value=>new Proxy(value,{ownKeys(){accesses++;throw Error('PROXY_MUST_NOT_BE_INSPECTED');},get(){accesses++;throw Error('PROXY_MUST_NOT_BE_READ');}});
 const arrayGetter=[x.f,x.a];Object.defineProperty(arrayGetter,'0',{enumerable:true,get(){accesses++;return x.f;}});const extra=[x.f,x.a];extra.extra=true;const oversize=[];oversize.length=20001;
 const inputs=[null,[],Object.assign(Object.create(null),good),Object.assign(Object.create({item:x.f}),{position:good.position,expectedOrder:good.expectedOrder}),getter(good,'item'),getter(good,'position'),getter(good,'expectedOrder'),proxy(good),{...good,extra:true},{...good,[Symbol('hidden')]:true},{...good,item:getter(x.f,'id')},{...good,item:proxy(x.f)},{...good,position:null},{...good,position:{}},{...good,position:{before:x.a,after:x.a}},{...good,position:{before:x.a,extra:true}},{...good,position:getter(good.position,'after')},{...good,position:proxy(good.position)},{...good,position:{after:getter(x.a,'id')}},{...good,position:{after:proxy(x.a)}},{...good,position:Object.assign(Object.create(null),good.position)},{...good,expectedOrder:undefined},{...good,expectedOrder:null},{...good,expectedOrder:Array(2)},{...good,expectedOrder:arrayGetter},{...good,expectedOrder:extra},{...good,expectedOrder:oversize},{...good,expectedOrder:proxy(good.expectedOrder)},{...good,expectedOrder:[x.f,getter(x.a,'workspaceId')]},{...good,expectedOrder:[x.f,proxy(x.a)]},{...good,expectedOrder:[x.f,x.f]}];
 const hidden={...good};Object.defineProperty(hidden,'extra',{value:true,enumerable:false});inputs.push(hidden);
 for(const input of inputs){assert.throws(()=>store.moveLibraryPin(input));unchanged(store,before);}
 assert.equal(accesses,0);
});

test('reorder rejects an order containing another workspace even when identifiers otherwise match',async t=>{
 const {store}=fixture(t),ws=store.createWorkspace({name:'specific scope'}),x=await items(store,ws.id),personal=await items(store);for(const p of[x.f,personal.f,x.a])pin(store,p);const before=retained(store);
 assert.throws(()=>move(store,x.a,'before',x.f,[x.f,personal.f,x.a]),/其他空间/);unchanged(store,before);
 assert.throws(()=>move(store,x.a,'before',x.f,[{...x.f,workspaceId:null},x.a]),/其他空间/);unchanged(store,before);
});

test('real persistence path failure does not acknowledge or publish a reordered state and a later retry persists it',async t=>{
 const {store,data}=fixture(t),x=await items(store);pin(store,x.f);pin(store,x.a);const before=retained(store),open=fs.openSync;let failures=0;
 fs.openSync=function(filename,...args){if(typeof filename==='string'&&path.dirname(filename)===store.dataDir&&/^\.state-.*\.tmp$/.test(path.basename(filename))){failures++;throw Object.assign(Error('SYNTHETIC_DISK_OPEN_FAILURE'),{code:'EIO'});}return open.call(this,filename,...args);};
 try{assert.throws(()=>move(store,x.a,'before',x.f),/无法保存本地数据/);}finally{fs.openSync=open;}
 assert.equal(failures,1);unchanged(store,before);assert.deepEqual(new Store(data).snapshot().libraryPins,[x.f,x.a]);assert.deepEqual(fs.readdirSync(data).filter(name=>/^\.(state|backup)-/.test(name)),[]);
 assert.deepEqual(move(store,x.a,'before',x.f),[x.a,x.f]);assert.deepEqual(new Store(data).snapshot().libraryPins,[x.a,x.f]);
});

test('relative order survives restart export and ID-remapped import without changing local pins or imported document bytes',async t=>{
 const a=fixture(t),b=fixture(t),ws=a.store.createWorkspace({name:'reordered imported scope'}),x=await items(a.store,ws.id),y=await items(a.store,ws.id),personal=await items(a.store),local=await items(b.store);
 for(const p of[x.f,personal.f,x.a,y.f,personal.a,y.a])pin(a.store,p);move(a.store,y.a,'before',x.f);move(a.store,x.a,'after',y.f);pin(b.store,local.a);pin(b.store,local.f);
 const order=a.store.snapshot().libraryPins;assert.deepEqual(order,[y.a,personal.f,x.f,y.f,personal.a,x.a]);assert.deepEqual(new Store(a.data).snapshot().libraryPins,order);
 const backup=a.store.exportData(),copy=structuredClone(backup);assert.deepEqual(backup.libraryPins,order);await b.store.importData(backup);assert.deepEqual(backup,copy);
 const snapshot=b.store.snapshot(),imported=snapshot.libraryPins.slice(2),newWs=snapshot.workspaces.find(w=>w.name===ws.name),files=snapshot.files.filter(f=>f.id!==local.file.id),artifacts=snapshot.artifacts.filter(v=>v.id!==local.artifact.id),fileIds=new Map(backup.files.map((file,i)=>[file.id,files[i].id])),artifactIds=new Map(backup.artifacts.map((artifact,i)=>[artifact.id,artifacts[i].id]));
 const expected=order.map(p=>({kind:p.kind,id:(p.kind==='file'?fileIds:artifactIds).get(p.id),workspaceId:p.workspaceId===null?null:newWs.id}));assert.deepEqual(imported,expected);assert.deepEqual(snapshot.libraryPins.slice(0,2),[local.a,local.f]);
 for(const p of imported){assert.deepEqual(b.store.libraryItem(p),p);if(p.kind==='file')assert.equal(b.store.readFile(p.id).text,'synthetic original bytes');}
 assert.deepEqual(new Store(b.data).snapshot().libraryPins,[local.a,local.f,...expected]);
});
