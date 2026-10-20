'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {isJsonFile,parseJsonPreview,jsonSaveError}=require('../renderer/file-json.cjs');
const {isImageFile}=require('../backend/image-format.cjs');
const {isPreviewMediaFile,isVideoFile}=require('../backend/video-format.cjs');

test('JSON editor classification handles case and keeps unrelated text extensions separate',()=>{
  for(const name of ['data.json','data.JSON','rows.jsonl','rows.JsOnL'])assert.equal(isJsonFile(name),true);
  for(const name of ['json','data.json.bak','rows.ndjson','note.md',null])assert.equal(isJsonFile(name),false);
});
test('structured preview accepts every JSON root type, including null and false',()=>{
  for(const [source,value]of [['null',null],['false',false],['0',0],['"name"','name'],['[]',[]],['{"a":1}',{a:1}]])assert.deepEqual(parseJsonPreview(source),{ok:true,value,kind:'json'});
});
test('JSONL preview skips blank CRLF lines and accepts scalar, array and object records',()=>{
  assert.deepEqual(parseJsonPreview(' \r\n null\r\n1\r\n {"a":2}\r\n["x"]\r\n'),{ok:true,value:[null,1,{a:2},['x']],kind:'jsonl'});
});
test('JSONL preview rejects the whole view when any nonempty row is invalid',()=>{
  assert.deepEqual(parseJsonPreview('{"a":1}\nnot json\n{"b":2}'),{ok:false});
  assert.deepEqual(parseJsonPreview('  \r\n\t'),{ok:false});
});
test('preview fallback does not silently relax the single-value Save contract',()=>{
  const source='{ "a":1 }\n{ "a":2 }';assert.equal(parseJsonPreview(source).kind,'jsonl');assert(jsonSaveError(source));
  const bom='\ufeff{"a":1}';assert.deepEqual(parseJsonPreview(bom),{ok:true,value:[{a:1}],kind:'jsonl'});assert(jsonSaveError(bom));
});
test('JSON save checks syntax without formatting, constraining roots or rejecting parser-supported numbers',()=>{
  for(const text of ['null','false','"text"','9007199254740993','1e400','{ "a": 1, "a": 2 }','{\n "汉字": "\\u4e2d"\n}\n'])assert.equal(jsonSaveError(text),null);
});
test('JSON save diagnostics retain parser details and derive the line from its UTF-16 position',()=>{
  const text='{\r\n "emoji":"😀",\r\n}';const error=jsonSaveError(text);assert(error);assert.equal(error.line,3);assert.match(error.detail,/position\s+\d+/i);assert.match(error.message,/第 3 行/);
  assert.equal(jsonSaveError('').line,null);
});

const componentBuild=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../renderer/JsonPreview.jsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','lucide-react']});
const componentModule={exports:{}};vm.runInNewContext(componentBuild.outputFiles[0].text,{module:componentModule,exports:componentModule.exports,require});
const JsonPreview=componentModule.exports.default;
test('actual JSON preview opens only the root, labels arrays and escapes text values',()=>{
  const html=renderToStaticMarkup(React.createElement(JsonPreview,{text:'{"nested":{"hidden":"NESTED_VALUE"},"items":[1,2],"html":"<img src=x onerror=alert(1)>"}'}));
  assert.match(html,/aria-label="折叠 根节点"/);assert.match(html,/aria-label="展开 nested"/);assert.match(html,/aria-label="展开 items"/);assert.match(html,/\[2\]/);assert(!html.includes('NESTED_VALUE'));assert(html.includes('&lt;img'));assert(!html.includes('<img src=x'));
});
test('actual JSON preview represents primitive roots and invalid content without treating null as an error',()=>{
  for(const text of ['null','false','0'])assert.match(renderToStaticMarkup(React.createElement(JsonPreview,{text})),/data-testid="json-preview"/);
  assert.match(renderToStaticMarkup(React.createElement(JsonPreview,{text:'broken'})),/data-testid="json-parse-error"/);
  assert.match(renderToStaticMarkup(React.createElement(JsonPreview,{text:'1\n2'})),/data-testid="jsonl-note"/);
});

// Run the actual file-editor Save/guard closures; do not copy their validation.
const source=fs.readFileSync(path.resolve(__dirname,'../renderer/FileEditor.jsx'),'utf8');
const dirtyStart=source.indexOf('const dirty ='),start=source.indexOf('export default function FileEditor('),end=source.indexOf('  const tab = tabs[activeId]',start);
assert(dirtyStart>=0&&start>dirtyStart&&end>start);
const actionCode=esbuild.transformSync(source.slice(dirtyStart,start)+source.slice(start,end).replace('export default ','')+'globalThis.probe={load,save,download,guard,patch,tabs,pending,saving,downloading};return null;}',{loader:'jsx',format:'cjs'}).code;
function editor(name='fixture.json',baseline='{"before":true}'){
  let cursor=0;const hooks=[],updates=[],calls=[],notices=[],downloads=[],readCalls=[];let failSave=false,failRead=false,failDownload=false,downloadResult={cancelled:false,draft:true};
  const preview=text=>({name,text,editable:true,truncated:false,sha256:'a'.repeat(64)});
  const api={readFile:async input=>{readCalls.push(input);if(failRead)throw Error('Synthetic unsupported format');return preview(baseline);},saveTextFile:async input=>{calls.push(JSON.parse(JSON.stringify(input)));if(failSave)throw Error('Synthetic save conflict');return{preview:preview(input.content)};},exportFile:async input=>{downloads.push(JSON.parse(JSON.stringify(input)));if(failDownload)throw Error('Synthetic download error');return await downloadResult;}};
  const useState=initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],v=>updates.push(()=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;})];};
  const useRef=initial=>{const i=cursor++;return hooks[i]||(hooks[i]={current:initial});};
  const context=vm.createContext({api,isJsonFile,jsonSaveError,isImageFile,isVideoFile,isPreviewMediaFile,useState,useRef,useEffect(){},props:{ids:['file_fixture'],activeId:'file_fixture',files:[{id:'file_fixture',name}],notify:(...args)=>notices.push(args)}});vm.runInContext(actionCode,context);
  const render=()=>{while(updates.length)updates.shift()();cursor=0;vm.runInContext('FileEditor(props)',context);return context.probe;};render();
  return{calls,notices,downloads,readCalls,render,get probe(){return context.probe;},async load(){await context.probe.load('file_fixture');return render();},edit(text){context.probe.patch('file_fixture',{text,mode:'edit'});return render();},fail(value){failSave=value;},failRead(value){failRead=value;},failDownload(value){failDownload=value;},replyDownload(value){downloadResult=value;}};
}

test('opening images and videos bypasses the text reader and never enables text saving',async()=>{
  for(const name of ['photo.PNG','drawing.svg','camera.heic','clip.MP4','clip.webm','clip.mov','clip.m4v','clip.avi','clip.mkv']){
    const h=editor(name,'text extraction must not be used as media bytes');h.failRead(true);await h.load();
    assert.equal(h.readCalls.length,0);assert.equal(h.probe.tabs.file_fixture.loading,false);assert.equal(h.probe.tabs.file_fixture.editable,false);assert.equal(h.probe.tabs.file_fixture.text,'');
    await h.probe.save('file_fixture');assert.equal(h.calls.length,0);
  }
});

test('image and video workbench downloads request original bytes without sending a text draft',async()=>{
  for(const name of ['drawing.svg','clip.mp4','clip.webm']){
    const h=editor(name,'must not be a text draft');await h.load();await h.probe.download('file_fixture');
    assert.deepEqual(h.downloads,[{id:'file_fixture'}]);assert.equal(h.readCalls.length,0);assert.equal(h.calls.length,0);
  }
});

test('a failed reload clears previous editability instead of inheriting the old format capability',async()=>{
  const h=editor();await h.load();assert.equal(h.probe.tabs.file_fixture.editable,true);h.failRead(true);await h.load();
  assert.equal(h.probe.tabs.file_fixture.editable,false);assert.equal(h.probe.tabs.file_fixture.loading,false);assert.match(h.probe.tabs.file_fixture.error,/unsupported/);
  await h.probe.save('file_fixture');assert.equal(h.calls.length,0);
});
test('invalid JSON Save preserves draft and baseline, reports the error and performs no host write',async()=>{
  const h=editor();await h.load();const invalid='{\n "a":1,\n}';h.edit(invalid);assert.equal(await h.probe.save('file_fixture'),false);h.render();assert.equal(h.calls.length,0);assert.equal(h.probe.tabs.file_fixture.text,invalid);assert.equal(h.probe.tabs.file_fixture.baseline,'{"before":true}');assert.match(h.probe.tabs.file_fixture.saveError,/JSON/);assert.equal(h.probe.saving,false);assert.equal(h.notices.at(-1)[1],'error');
});
test('valid JSON Save sends original source bytes and the existing CAS digest',async()=>{
  const h=editor();await h.load();const text='{\n  "large":9007199254740993,\n  "字":"\\u4e2d"\n}\n';h.edit(text);assert.equal(await h.probe.save('file_fixture'),true);h.render();assert.deepEqual(h.calls,[{id:'file_fixture',content:text,expectedSha256:'a'.repeat(64),expectedName:'fixture.json'}]);assert.equal(h.probe.tabs.file_fixture.baseline,text);assert.equal(h.probe.tabs.file_fixture.saveError,'');
});
test('JSONL editor Save retains the original single-JSON-value constraint',async()=>{
  const h=editor('rows.jsonl','{"line":1}');await h.load();h.edit('{"line":1}\n{"line":2}');assert.equal(await h.probe.save('file_fixture'),false);h.render();assert.equal(h.calls.length,0);assert.equal(h.probe.tabs.file_fixture.text,'{"line":1}\n{"line":2}');
});
test('generic text Save remains available for content which is not valid JSON',async()=>{
  const h=editor('notes.txt','before');await h.load();h.edit('{ malformed');assert.equal(await h.probe.save('file_fixture'),true);assert.equal(h.calls[0].content,'{ malformed');
});
test('save conflict preserves a valid JSON draft and allows retry against the same baseline',async()=>{
  const h=editor();await h.load();h.edit('{"after":true}');h.fail(true);assert.equal(await h.probe.save('file_fixture'),false);h.render();assert.equal(h.probe.tabs.file_fixture.text,'{"after":true}');assert.equal(h.probe.tabs.file_fixture.baseline,'{"before":true}');assert.match(h.probe.tabs.file_fixture.saveError,/conflict/);h.fail(false);assert.equal(await h.probe.save('file_fixture'),true);h.render();assert.equal(h.probe.tabs.file_fixture.baseline,'{"after":true}');
});
test('failed JSON Save leaves the dirty-file close guard pending',async()=>{
  const h=editor();await h.load();h.edit('broken');let closed=false;h.probe.guard(['file_fixture'],()=>{closed=true;});h.render();assert(h.probe.pending);assert.equal(await h.probe.save('file_fixture'),false);h.render();assert(h.probe.pending);assert.equal(closed,false);assert.equal(h.probe.tabs.file_fixture.text,'broken');
});

test('actual editor downloads invalid JSON without Save and keeps the dirty-close guard pending',async()=>{
  const h=editor();await h.load();const invalid='{ broken\r\n';h.edit(invalid);h.probe.guard(['file_fixture'],()=>assert.fail('dirty draft must remain open'));h.render();
  await h.probe.download('file_fixture');h.render();
  assert.deepEqual(h.downloads,[{id:'file_fixture',content:invalid}]);assert.equal(h.calls.length,0);
  assert.equal(h.probe.tabs.file_fixture.text,invalid);assert.equal(h.probe.tabs.file_fixture.baseline,'{"before":true}');assert(h.probe.pending);assert.equal(h.probe.downloading,false);
});

test('download cancellation and errors retain editor source and baseline',async()=>{
  const h=editor('rows.jsonl','1');await h.load();h.edit('1\n2');h.replyDownload({cancelled:true});await h.probe.download('file_fixture');h.render();assert.equal(h.notices.length,0);
  h.failDownload(true);await h.probe.download('file_fixture');h.render();assert.equal(h.notices.at(-1)[1],'error');assert.equal(h.probe.tabs.file_fixture.text,'1\n2');assert.equal(h.probe.tabs.file_fixture.baseline,'1');assert.equal(h.calls.length,0);
});

test('pending download captures the clicked draft once and does not replace newer edits on completion',async()=>{
  const h=editor();await h.load();h.edit('first draft');let resolve;const pending=new Promise(r=>{resolve=r;});h.replyDownload(pending);
  const first=h.probe.download('file_fixture');h.render();assert.equal(h.probe.downloading,true);await h.probe.download('file_fixture');h.edit('newer draft');
  assert.deepEqual(h.downloads,[{id:'file_fixture',content:'first draft'}]);resolve({cancelled:false,draft:true});await first;h.render();assert.equal(h.probe.tabs.file_fixture.text,'newer draft');assert.equal(h.probe.tabs.file_fixture.baseline,'{"before":true}');assert.equal(h.probe.downloading,false);
});

test('clean and binary-preview-error download requests the managed original without preview text',async()=>{
  const h=editor('note.txt','saved');await h.load();await h.probe.download('file_fixture');h.render();
  h.probe.patch('file_fixture',{editable:false,error:'No text preview'});h.render();await h.probe.download('file_fixture');
  assert.deepEqual(h.downloads,[{id:'file_fixture'},{id:'file_fixture'}]);assert.equal(h.calls.length,0);
});
