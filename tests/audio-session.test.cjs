'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AudioSession}=require('../backend/audio-session.cjs');
const deferred=()=>{let resolve;return{promise:new Promise(yes=>resolve=yes),resolve:value=>resolve(value)};};
const audio=()=>({audio:new ArrayBuffer(64),mimeType:'audio/wav'});
const owner=id=>({channel:'preview',requestId:id});
test('audio session metadata-only lifecycle, pause and terminal state never retain payload',async()=>{
 const events=[],s=new AudioSession({getBinding:()=>({revision:1}),onState:value=>events.push(value)});
 const ready=await s.prepare({owner:owner('first'),load:async()=>audio()});assert.equal(ready.state,'ready');assert.ok(ready.audio instanceof ArrayBuffer);assert.equal('audio'in s.snapshot(),false);
 assert.equal(s.update({id:ready.id,state:'playing'}).state,'playing');assert.equal(s.update({id:ready.id,state:'paused'}).state,'paused');assert.equal(s.update({id:ready.id,state:'playing'}).state,'playing');s.update({id:ready.id,state:'ended'});assert.equal(s.snapshot().state,'ended');assert.ok(events.every(e=>!('audio'in e)&&!('binding'in e)));s.dispose();
});
test('request identity cancels before preparation and stale stop cannot cancel replacement',async()=>{
 const s=new AudioSession({getBinding:()=>({revision:1})});let invoked=0;s.stop({requestId:'cancel-before-start'});
 await assert.rejects(s.prepare({owner:owner('cancel-before-start'),load:()=>{invoked++;return audio();}}));assert.equal(invoked,0);
 const first=await s.prepare({owner:owner('one'),load:()=>audio()}),second=await s.prepare({owner:owner('two'),load:()=>audio()});s.stop({id:first.id,requestId:'one'});assert.equal(s.snapshot().id,second.id);assert.equal(s.snapshot().state,'ready');s.dispose();
});
test('scope change aborts ignored loaders immediately and wipes any late audio',async()=>{
 let revision=1;const wait=deferred(),started=deferred(),s=new AudioSession({getBinding:()=>({revision})});
 const pending=s.prepare({owner:owner('one'),load:({signal})=>{started.resolve(signal);return wait.promise;}}),signal=await started.promise;revision=2;assert.equal(s.validateCurrent(),false);assert.equal(signal.aborted,true);assert.equal((await pending).state,'stopped');
 const late=audio();new Uint8Array(late.audio).fill(9);wait.resolve(late);await new Promise(r=>setImmediate(r));assert.ok(new Uint8Array(late.audio).every(n=>n===0));s.dispose();
});
test('source binding is rechecked before load dispatch and a missing source cannot start',async()=>{
 let revision=1,called=0;const s=new AudioSession({getBinding:()=>revision?{revision}:null});const pending=s.prepare({owner:owner('one'),load:()=>{called++;return audio();}});revision=2;assert.equal((await pending).state,'stopped');assert.equal(called,0);revision=0;await assert.rejects(s.prepare({owner:owner('two'),load:()=>audio()}));s.dispose();
});
test('load errors and unsupported/oversized payloads remain fixed metadata errors',async()=>{
 const s=new AudioSession({getBinding:()=>({ok:true})});for(const [index,load]of [()=>{throw new Error('PRIVATE_PROVIDER_DETAILS');},()=>({audio:new ArrayBuffer(12),mimeType:'text/html'}),()=>({audio:new ArrayBuffer(25*1024*1024+1),mimeType:'audio/wav'})].entries()){
  const result=await s.prepare({owner:owner('case-'+index),load});assert.equal(result.state,'error');assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER'),false);assert.equal('audio'in result,false);
 }s.dispose();await assert.rejects(s.prepare({owner:owner('after-close'),load:()=>audio()}));
});
test('timeout and disposal settle pending requests; independent channels do not exclude one another',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const a=new AudioSession({getBinding:()=>({a:1}),timeoutMs:50}),b=new AudioSession({getBinding:()=>({b:2})});const started=deferred();
 const pending=a.prepare({owner:owner('a'),load:()=>{started.resolve();return new Promise(()=>{});}});await started.promise;const other=await b.prepare({owner:owner('b'),load:()=>audio()});b.update({id:other.id,state:'playing'});t.mock.timers.tick(50);assert.equal((await pending).reason,'timeout');assert.equal(b.snapshot().state,'playing');a.dispose();b.dispose();
});
