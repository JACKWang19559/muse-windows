'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fileCategory,libraryItems,selectLibraryItems,libraryIntentTarget,LIBRARY_INTENTS}=require('../backend/library-model.cjs');
test('Library filename categories preserve image/video declarations and separate local documents',()=>{
 for(const name of['a.HEIC','a.svg','a.TIFF'])assert.equal(fileCategory({name}),'images');
 for(const name of['a.mp4','a.WEBM','a.mkv'])assert.equal(fileCategory({name}),'videos');
 for(const name of['a.wav','a.mp3','a.aac'])assert.equal(fileCategory({name}),'audio');
 for(const name of['a.docx','a.PDF','a.xlsx','a.csv','a.md','a.json','a.tsx'])assert.equal(fileCategory({name}),'documents');
 for(const name of['archive.zip','LICENSE','x.bin','not.png.exe'])assert.equal(fileCategory({name}),'files');
});
const files=[{id:'same',name:'报告2.md',workspaceId:'w',size:20,createdAt:'2026-01-01T00:00:00Z'},{id:'new',name:'报告10.PDF',workspaceId:'w',size:100,createdAt:'2026-02-01T00:00:00Z'},{id:'image',name:'[literal].PNG',workspaceId:'w',size:30},{id:'personal',name:'私有.md',workspaceId:null},{id:'other',name:'别处.md',workspaceId:'other'}];
const artifacts=[{id:'same',name:'网页应用',workspaceId:'w',createdAt:'2026-03-01T00:00:00Z'},{id:'personal',name:'个人应用',workspaceId:null},{id:'other',name:'另一空间',workspaceId:'other'}];
test('Library scope applies to files and applications before any query or counts',()=>{const x=libraryItems({files,artifacts,workspaceId:'w'});assert.deepEqual(x.map(v=>v.key),['file:same','file:new','file:image','app:same']);assert.equal(new Set(x.map(v=>v.key)).size,4);assert.deepEqual(libraryItems({files,artifacts}).map(v=>v.key),['file:personal','app:personal']);assert.equal(libraryItems({files,artifacts,workspaceId:'missing'}).length,0);});
test('Library documents, media, applications and all-file views keep distinct sources',()=>{const x=libraryItems({files,artifacts,workspaceId:'w'});assert.deepEqual(selectLibraryItems(x,{view:'documents',sort:'name'}).map(v=>v.id),['same','new']);assert.deepEqual(selectLibraryItems(x,{view:'images'}).map(v=>v.id),['image']);assert.deepEqual(selectLibraryItems(x,{view:'web'}).map(v=>v.kind),['artifact']);assert(selectLibraryItems(x,{view:'files'}).every(v=>v.kind==='file'));assert.equal(selectLibraryItems(x,{view:'all'}).length,4);});
test('Library search is trimmed case-insensitive literal name matching with no content search',()=>{const x=libraryItems({files,artifacts,workspaceId:'w'});assert.deepEqual(selectLibraryItems(x,{query:' [LITERAL] '}).map(v=>v.id),['image']);assert.equal(selectLibraryItems(x,{query:'[.*'}).length,0);assert.equal(selectLibraryItems(x,{query:'私有'}).length,0);assert.equal(selectLibraryItems(x,{view:'documents',query:'PNG'}).length,0);});
test('Library date, natural name and size sorts are deterministic without mutating snapshot arrays',()=>{const x=libraryItems({files,artifacts,workspaceId:'w'}),keys=x.map(v=>v.key);assert.deepEqual(selectLibraryItems(x).slice(0,3).map(v=>v.key),['app:same','file:new','file:same']);assert.deepEqual(selectLibraryItems(x,{view:'documents',sort:'name'}).map(v=>v.id),['same','new']);assert.deepEqual(selectLibraryItems(x,{sort:'size'}).map(v=>v.key),['file:new','file:image','file:same','app:same']);assert.deepEqual(x.map(v=>v.key),keys);});
test('Wide creation targets current chat while narrow creation resolves the destination new-draft key first',()=>{for(const[kind,prompt]of Object.entries(LIBRARY_INTENTS)){assert.deepEqual(libraryIntentTarget({kind,workspaceId:'w',composerKey:'chat:old'}),{prompt,key:'chat:old',route:null});assert.deepEqual(libraryIntentTarget({kind,workspaceId:'w',composerKey:'chat:old',narrow:true}),{prompt,key:'new:w',route:{type:'welcome',workspaceId:'w'}});}assert.equal(libraryIntentTarget({kind:'document',composerKey:'chat:personal',narrow:true}).key,'new:personal');assert.throws(()=>libraryIntentTarget({kind:'__proto__'}));});

test('Library pin identities distinguish same-ID files and apps and stay inside their scope',()=>{
 const x=libraryItems({files,artifacts,workspaceId:'w',pins:[{kind:'file',id:'same',workspaceId:'w'},{kind:'artifact',id:'same',workspaceId:'other'}]});
 assert.equal(x.find(x=>x.key==='file:same').pinned,true);assert.equal(x.find(x=>x.key==='app:same').pinned,false);assert.equal(x.filter(x=>x.pinned).length,1);
});
test('Artifact Library views put pins first in persisted order before each chosen secondary sort',()=>{
 const x=libraryItems({files,artifacts,workspaceId:'w',pins:[{kind:'file',id:'same',workspaceId:'w'},{kind:'artifact',id:'same',workspaceId:'w'}]});
 for(const sort of['date','name','size'])assert.deepEqual(selectLibraryItems(x,{sort}).slice(0,2).map(x=>x.key),['file:same','app:same']);
 assert.deepEqual(selectLibraryItems(x,{query:'网页'}).map(x=>x.key),['app:same']);assert.deepEqual(files.map(x=>x.id),['same','new','image','personal','other']);
});
test('Filesystem and media Library views retain their ordinary sort instead of applying artifact pin order',()=>{
 const x=libraryItems({files,artifacts,workspaceId:'w',pins:[{kind:'file',id:'same',workspaceId:'w'}]});
 assert.equal(selectLibraryItems(x,{view:'files'})[0].id,'new');assert.deepEqual(selectLibraryItems(x,{view:'images'}).map(x=>x.id),['image']);
});
