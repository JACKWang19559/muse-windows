'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {tokenizeText,memorySourceDigest,rebuildMemoryIndex,validateMemoryIndex,indexHash,searchMemories}=require('../backend/knowledge-search.cjs');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const memory=(id,name,contentMarkdown,workspaceId=null,revision=1)=>({id,name,contentMarkdown,workspaceId,revision,digest:hash(name+contentMarkdown),provenance:{private:'not-indexed'}});
const records=[memory('one','工作笔记','工作区里有苹果和 APPLE 计划。'),memory('two','Fruit','banana 苹果'),memory('foreign','秘密苹果','foreign private apple','workspace_b')];
const build=(source=records,revision=1,workspaceId=null)=>rebuildMemoryIndex(source,{workspaceId,revision,builtAt:'2026-10-20T00:00:00.000Z'});
test('real lexical rebuild creates verifiable inverted postings with deterministic Unicode and CJK terms',()=>{
  const index=build();assert.equal(index.status,'ready');assert.deepEqual(index.documents.map(value=>value.id),['one','two']);assert.ok(index.postings.some(value=>value.term==='苹果'));assert.ok(index.postings.some(value=>value.term==='apple'));
  assert.deepEqual(validateMemoryIndex(index),index);assert.equal(index.sourceDigest,memorySourceDigest(records,{workspaceId:null}));assert.equal(index.sourceDigest,memorySourceDigest([...records].reverse(),null));
  assert.deepEqual(tokenizeText('苹果工作区 APPLE ＡＢＣ __proto__'),['__proto__','abc','apple','工作','果工','苹果','作区'].sort());
});
test('scope is exact, results are scored, literal punctuation is safe, highlights use source UTF16 offsets',()=>{
  const index=build(),result=searchMemories(records,index,{query:'苹果'});assert.equal(result.status,'ready');assert.deepEqual(result.hits.map(value=>value.id),['one','two']);assert.equal(result.hits.some(value=>value.id==='foreign'),false);
  for(const hit of result.hits){assert.equal(hit.snippet.slice(hit.highlights[0].start,hit.highlights[0].start+hit.highlights[0].length),'苹果');assert.equal('contentMarkdown'in hit,false);}
  const source=[memory('punct','regex','🪴'.repeat(100)+' [a+b].* '+ 'tail '.repeat(200)),memory('unicode','letters','ＡＢＣ café cafe\u0301')],own=build(source);
  const punctuation=searchMemories(source,own,{query:'[a+b].*'}).hits[0];assert.equal(punctuation.snippet.slice(punctuation.highlights[0].start,punctuation.highlights[0].start+punctuation.highlights[0].length),'[a+b].*');
  const full=searchMemories(source,own,{query:'abc'}).hits[0];assert.equal(full.snippet.slice(full.highlights[0].start,full.highlights[0].start+full.highlights[0].length),'ＡＢＣ');
  assert.equal(searchMemories(source,own,{query:'café'}).hits[0].highlights.length,2);
  assert.equal(searchMemories(source,own,{query:'does-not-exist'}).total,0);
});
test('missing, stale, invalid and failed indexes never masquerade as a successful empty search',()=>{
  assert.deepEqual(searchMemories(records,null,{query:'苹果'}),{status:'missing',reason:'index_missing'});
  const index=build(),changed=records.map(value=>({...value}));changed[0].contentMarkdown='changed without revision';
  const stale=searchMemories(changed,index,{query:'苹果'});assert.equal(stale.status,'stale');assert.equal('hits'in stale,false);
  const removed=searchMemories(records.slice(1),index,{query:'苹果'});assert.equal(removed.status,'stale');
  const forged={...index,indexDigest:'a'.repeat(64)};assert.equal(searchMemories(records,forged,{query:'苹果'}).status,'failed');
  const foreign=[...records];foreign[2]={...foreign[2],contentMarkdown:'foreign changed'};assert.equal(searchMemories(foreign,index,{query:'苹果'}).status,'ready');
  assert.equal(searchMemories(records,index,{query:'苹果',workspaceId:'workspace_b'}).status,'missing');
});
test('stable pagination binds the real index, query and host allowed IDs without returning foreign records',()=>{
  const source=Array.from({length:31},(_,i)=>memory('id_'+String(i).padStart(2,'0'),'same','苹果资料')),index=build(source),ids=[];let cursor;
  do{const page=searchMemories(source,index,{query:'苹果',limit:7,...cursor?{cursor}:{}});ids.push(...page.hits.map(value=>value.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(ids.length,31);assert.equal(new Set(ids).size,31);assert.deepEqual(ids,[...ids].sort());
  const first=searchMemories(source,index,{query:'苹果',limit:2,allowedIds:['id_01','id_05','id_09']});assert.deepEqual(first.hits.map(value=>value.id),['id_01','id_05']);
  assert.throws(()=>searchMemories(source,index,{query:'资料',cursor:first.nextCursor,allowedIds:['id_01','id_05','id_09']}),/重新搜索/);
  assert.throws(()=>searchMemories(source,index,{query:'苹果',cursor:first.nextCursor,allowedIds:['id_01','id_05']}),/重新搜索/);
  assert.equal(searchMemories(source,index,{query:'苹果',allowedIds:[]}).total,0);
});
test('source digest and index validation reject prototype injection/accessors and never run getters',()=>{
  let reads=0;const getter={...records[0]};Object.defineProperty(getter,'contentMarkdown',{get(){reads++;return'';},enumerable:true});
  const proxy=new Proxy(records,{ownKeys(){reads++;throw Error();}});
  for(const value of [[getter],proxy,Array(1)])assert.throws(()=>memorySourceDigest(value),{code:'ERR_MEMORY_INDEX'});
  const index=build(),bad={...index};Object.defineProperty(bad,'postings',{get(){reads++;return[];},enumerable:true});assert.throws(()=>validateMemoryIndex(bad),{code:'ERR_MEMORY_INDEX'});
  assert.throws(()=>indexHash(bad),{code:'ERR_MEMORY_INDEX'});assert.equal(indexHash(index),index.indexDigest);
  assert.equal(reads,0);assert.throws(()=>validateMemoryIndex({...index,__proto__:{}}),{code:'ERR_MEMORY_INDEX'});
  const protoSource=[memory('safe','__proto__ constructor','__proto__')],protoIndex=build(protoSource);assert.equal(searchMemories(protoSource,protoIndex,{query:'__proto__'}).hits[0].id,'safe');assert.equal(Object.prototype.polluted,undefined);
});

test('a real over-capacity rebuild records failure and does not erase the distinction from empty success',()=>{
  const source=Array.from({length:6},(_,group)=>memory('capacity_'+group,'capacity',Array.from({length:18000},(_,i)=>'w'+(group*18000+i).toString(36).padStart(5,'0')).join(' ')));
  const failed=build(source);assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'capacity');assert.deepEqual(failed.documents,[]);assert.deepEqual(validateMemoryIndex(failed),failed);
  const result=searchMemories(source,failed,{query:'capacity'});assert.equal(result.status,'failed');assert.equal(result.reason,'capacity');assert.equal('hits'in result,false);
});

test('result byte budget paginates multibyte metadata and overlapping CJK highlights merge safely',()=>{
  const source=Array.from({length:50},(_,i)=>memory('large_'+String(i).padStart(2,'0'),'界'.repeat(160),'界'.repeat(100)+' 工作区内知识 '+ '界'.repeat(300))),index=build(source);
  const result=searchMemories(source,index,{query:'工作区知识',limit:50});assert.ok(Buffer.byteLength(JSON.stringify(result))<45000);assert.ok(result.nextCursor);assert.ok(result.hits.length<50);
  const positions=result.hits[0].highlights;for(let i=1;i<positions.length;i++)assert.ok(positions[i].start>positions[i-1].start+positions[i-1].length);
  assert.equal(result.hits[0].snippet.slice(positions[0].start,positions[0].start+positions[0].length),'工作区');
});
