'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runAgentConversation}=require('../backend/agent-loop.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const messages=[{role:'user',content:'Synthetic stream verification.'}];

function openStream(apiKey,{signal}={}){
 const started=deferred(),finish=deferred(),texts=[],traces=[];let input;
 const run=runAgentConversation({apiKey,settings:{},messages,signal,provider:{streamCompletion:async value=>{input=value;started.resolve();return finish.promise;}},onText:value=>texts.push(structuredClone(value)),onTrace:value=>traces.push(structuredClone(value))});
 return{started:started.promise,emit:part=>input.onDelta(part),finish:content=>finish.resolve({content}),fail:error=>finish.resolve(Promise.reject(error)),texts,traces,run};
}

test('a short ordinary keyed reply is visible while the provider is still open',async()=>{
 const stream=openStream('mock-long-stream-key-'+ 'x'.repeat(100));await stream.started;
 try{stream.emit('短回复应当立即可见');await tick();assert.equal(stream.texts.at(-1).content,'短回复应当立即可见');assert.equal(stream.texts.at(-1).delta,'短回复应当立即可见');}
 finally{stream.finish('短回复应当立即可见');await stream.run;}
});

test('every literal, Unicode-escaped and mixed credential split keeps the prefix private until redaction',async()=>{
 const apiKey='mock-sensitive-7z';
 const encoded=apiKey.split('').map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const mixed=apiKey.split('').map((char,i)=>i%2?'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase():char).join('');
 for(const spelling of [apiKey,encoded,mixed])for(let split=1;split<spelling.length;split++){
  const stream=openStream(apiKey);await stream.started;
  try{stream.emit('OPEN '+spelling.slice(0,split));await tick();assert.equal(stream.texts.at(-1).content,'OPEN ',`split ${split}`);
   stream.emit(spelling.slice(split)+' tail');await tick();assert.equal(stream.texts.at(-1).content,'OPEN [已隐藏密钥] tail');
   assert.equal(stream.texts.some(value=>value.content.includes(apiKey)||value.content.includes(encoded)||value.content.includes(mixed)),false);
  }finally{stream.finish('OPEN '+spelling+' tail');await stream.run;}
 }
});

test('short JSON escapes and Unicode credentials remain protected across individual code units',async()=>{
 for(const apiKey of ['Q"\\/\tZ','密钥🔒末尾']){
  const spelling=JSON.stringify(apiKey).slice(1,-1),stream=openStream(apiKey);await stream.started;
  try{stream.emit('OPEN ');for(const codeUnit of spelling.split('')){stream.emit(codeUnit);await tick();assert.equal(stream.texts.some(value=>value.content.includes(apiKey)),false);}
   stream.emit(' END');await tick();assert.equal(stream.texts.at(-1).content,'OPEN [已隐藏密钥] END');
  }finally{stream.finish('OPEN '+spelling+' END');await stream.run;}
 }
});

test('ordinary text sharing an initial credential prefix is released as soon as it differs',async()=>{
 const stream=openStream('mock-sensitive-7z');await stream.started;
 try{stream.emit('OPEN mo');await tick();assert.equal(stream.texts.at(-1).content,'OPEN ');stream.emit('use');await tick();assert.equal(stream.texts.at(-1).content,'OPEN mouse');}
 finally{stream.finish('OPEN mouse');await stream.run;}
});

test('cancellation retains safe visible text and drops a pending escaped credential prefix',async()=>{
 const apiKey='mock-stop-stream-key',controller=new AbortController(),stream=openStream(apiKey,{signal:controller.signal});await stream.started;
 stream.emit('OPEN \\u006d\\u006f\\u');await tick();assert.equal(stream.texts.at(-1).content,'OPEN ');
 controller.abort();stream.fail(new DOMException('Synthetic cancellation','AbortError'));await assert.rejects(stream.run,{name:'AbortError'});
 assert.equal(stream.traces.at(-1).content,'OPEN ');assert.equal(JSON.stringify(stream.traces).includes(apiKey),false);
});

test('a long repetitive credential stays redacted without withholding unrelated reply text',async()=>{
 const apiKey='a'.repeat(600)+'b',stream=openStream(apiKey);await stream.started;
 try{stream.emit('开头 ');await tick();assert.equal(stream.texts.at(-1).content,'开头 ');
  stream.emit('a'.repeat(600));await tick();assert.equal(stream.texts.at(-1).content,'开头 ');
  stream.emit('b 结束');await tick();assert.equal(stream.texts.at(-1).content,'开头 [已隐藏密钥] 结束');
 }finally{stream.finish('开头 '+apiKey+' 结束');await stream.run;}
});

test('overlapping-prefix budget fallback keeps a full encoded-key window private',async()=>{
 const apiKey='a'.repeat(600)+'b',ordinary='a'.repeat(4000)+'c',stream=openStream(apiKey);await stream.started;
 try{stream.emit('OPEN '+ordinary);await tick();const partial=stream.texts.at(-1).content;assert.equal(partial.startsWith('OPEN '),true);assert.equal(partial.length<'OPEN '.length+ordinary.length,true);
  stream.emit(' '+apiKey+' END');await tick();for(const value of stream.texts)assert.equal(value.content.includes(apiKey),false);
 }finally{stream.finish('OPEN '+ordinary+' '+apiKey+' END');await stream.run;}
 assert.equal(stream.texts.at(-1).content,'OPEN '+ordinary+' [已隐藏密钥] END');
});

test('redaction replacement boundaries cannot form the credential with adjacent text',async()=>{
 for(const apiKey of [']X','X[','*X','X*',']X\u2063']){
  const content=apiKey+apiKey.at(-1).repeat(3),stream=openStream(apiKey);await stream.started;
  try{stream.emit(content);await tick();for(const value of stream.texts){assert.equal(value.content.includes(apiKey),false);assert.equal(value.delta.includes(apiKey),false);}}
  finally{stream.finish(content);const result=await stream.run;assert.equal(result.content.includes(apiKey),false);assert.equal(stream.texts.map(value=>value.delta).join('').includes(apiKey),false);}
 }
});
