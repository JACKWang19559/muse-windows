const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'test-results', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'reference.txt'), '桌面验收参考资料：项目代号 WIND-CEDAR-42。工作区文档应进入模型上下文。', 'utf8');
const {zipSync,strToU8}=require('fflate');
fs.writeFileSync(path.join(folder,'reference.docx'),zipSync({'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX desktop fixture</w:t></w:r></w:p></w:body></w:document>')}));
{
  const stream='BT /F1 12 Tf 30 100 Td (Hello PDF) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let data='%PDF-1.4\n';const offsets=[];
  objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(data));data+=`${index+1} 0 obj\n${value}\nendobj\n`;});
  const xref=Buffer.byteLength(data);data+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(folder,'reference.pdf'),data);
}
const requests = [];
const speechRequests=[];
const ttsRequests=[];
function silentWav(seconds=8){const rate=24000,length=Math.round(rate*seconds)*2,bytes=Buffer.alloc(44+length);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(length,40);return bytes;}
fs.writeFileSync(path.join(folder,'reference.wav'),silentWav(12));
const server = http.createServer(async (request, response) => {
  if(request.url==='/__muse_test/cancel-admission-state'){
    const summary=requests.map((entry,index)=>{const content=entry.messages.filter(message=>message.role==='user').at(-1)?.content||'';return{ordinal:index+1,markers:[...new Set(content.match(/CANCEL17_[A-Z0-9_]+/g)||[])]};});
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({requests:summary}));return;
  }
  if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data:[{id:'desktop-test-model'}] })); return; }
  if(request.url==='/v1/audio/speech'){
    try{let data='';for await(const chunk of request){data+=chunk;if(data.length>40000)throw new Error('Oversized mock input');}const parsed=JSON.parse(data);
      if(request.headers.authorization!=='Bearer desktop-speech-secret'||parsed.response_format!=='wav'||parsed.stream_format!=='audio'||!['desktop-tts','desktop-tts-slow','desktop-tts-error'].includes(parsed.model))throw new Error('Invalid mock TTS request');
      ttsRequests.push({model:parsed.model,voice:parsed.voice,input:parsed.input,format:parsed.response_format});
      setTimeout(()=>{if(response.destroyed)return;if(parsed.model==='desktop-tts-error'){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'synthetic provider failure'}}));}else{response.writeHead(200,{'content-type':'audio/wav'});response.end(silentWav());}},parsed.model==='desktop-tts-slow'?900:30);
    }catch{response.writeHead(400);response.end('Invalid mock TTS request');}return;
  }
  if(request.url==='/v1/audio/transcriptions'){
    try{
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>3900000)throw new Error('Synthetic audio upload too large');chunks.push(chunk);}
      const form=await new Request('http://localhost/v1/audio/transcriptions',{method:'POST',headers:request.headers,body:Buffer.concat(chunks)}).formData();
      const file=form.get('file'),model=form.get('model');
      const audio=require('../backend/asr-provider.cjs').validateWavAudio(await file.arrayBuffer());
      if(request.headers.authorization!=='Bearer desktop-speech-secret'||file.name!=='voice.wav'||form.get('response_format')!=='json'||!['desktop-asr','desktop-asr-slow','desktop-asr-error'].includes(model))throw new Error('Invalid synthetic ASR request');
      const ordinal=speechRequests.length+1;speechRequests.push({ordinal,model,filename:file.name,bytes:audio.bytes.length,durationMs:audio.durationMs,sampleRate:audio.sampleRate,channels:audio.channels});audio.bytes.fill(0);
      setTimeout(()=>{if(response.destroyed)return;response.writeHead(model==='desktop-asr-error'?503:200,{'content-type':'application/json'});response.end(JSON.stringify(model==='desktop-asr-error'?{error:{message:'synthetic failure'}}:{text:`听写验收 DICTATION-RESULT-${ordinal}`}));},model==='desktop-asr-slow'?900:30);
    }catch{response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Invalid synthetic WAV multipart'}}));}return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end('Not found'); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body); requests.push(parsed);
  response.writeHead(200, { 'content-type':'text/event-stream' });
  const user = parsed.messages.filter(x => x.role === 'user').at(-1)?.content || '';
  if(/CANCEL17_ACTIVE_[A-Z0-9_]+/.test(user)){
    // A real loopback HTTP stream stays active until the production request is
    // aborted. No host acceptance, cancellation receipt or renderer API is faked.
    let count=0;const write=()=>response.write('data: '+JSON.stringify({choices:[{delta:{content:`CANCEL17_PARTIAL_${++count} `}}]})+'\n\n');
    write();const timer=setInterval(write,150);response.on('close',()=>clearInterval(timer));return;
  }
  if (parsed.tools?.length && /AGENT_(CREATE|SAVE|DENY|STOP|APP|SCHEDULE|MEMORY|ANNOTATION)_DEMO|SCHEDULE_WRITE_DEMO/.test(user)) {
    const emitTool = (name, args) => {
      const id = 'call-desktop-' + requests.length, data = JSON.stringify(args), cut = Math.floor(data.length / 2);
      response.write('data: ' + JSON.stringify({ choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:data.slice(0,cut)}}]}}] }) + '\n\n');
      setTimeout(() => response.end('data: ' + JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:data.slice(cut)}}]},finish_reason:'tool_calls'}]}) + '\n\ndata: [DONE]\n\n'), 15);
    };
    const last = parsed.messages.at(-1);
    if (last?.role === 'tool') {
      const receipt = JSON.parse(last.content), previous = parsed.messages.filter(message=>message.role==='assistant'&&message.tool_calls?.length).at(-1).tool_calls.at(-1);
      if(user.includes('AGENT_ANNOTATION_DEMO')&&receipt.ok){
        if(previous.function.name==='muse_read_app'){emitTool('muse_write_app',{id:receipt.result.app.id,expectedRevision:receipt.result.app.sourceRevision,files:[{path:'index.html',text:'<!doctype html><main><h1>ANNOTATED_APP_UPDATED_11</h1><button id="selected-action" class="one two three four">ELEMENT_CONTEXT_TOKEN</button></main>'}]});return;}
        if(previous.function.name==='muse_write_app'){emitTool('muse_build_app',{id:receipt.result.app.id,expectedRevision:receipt.result.app.sourceRevision});return;}
      }
      if(user.includes('AGENT_MEMORY_DEMO')&&receipt.ok&&previous.function.name==='memory_create'){emitTool('memory_read',{id:receipt.result.memory.id});return;}
      if (user.includes('AGENT_APP_DEMO') && receipt.ok) {
        if (previous.function.name === 'muse_create_app') { emitTool('muse_write_app',{id:receipt.result.app.id,expectedRevision:receipt.result.app.sourceRevision,files:[{path:'index.html',text:'<!doctype html><h1>MODEL-APP-42</h1><button onclick="this.textContent=\'READY\'">Run</button>'}]}); return; }
        if (previous.function.name === 'muse_write_app') { emitTool('muse_build_app',{id:receipt.result.app.id,expectedRevision:receipt.result.app.sourceRevision}); return; }
      }
      if (user.includes('AGENT_SAVE_DEMO') && receipt.ok) {
        if (previous.function.name === 'workspace_list_files') { const file = receipt.result.files.find(file=>file.name==='agent-created.md'); if (file) { emitTool('workspace_read_file',{id:file.id}); return; } }
        if (previous.function.name === 'workspace_read_file') { emitTool('workspace_save_text_file',{id:receipt.result.id,content:'# AGENT-SAVED-42',expectedSha256:receipt.result.sha256}); return; }
      }
      const text = receipt.ok ? '文件操作已完成，结果已回传。' : '用户没有批准，本次没有写入。';
      response.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'); return;
    }
    if(user.includes('AGENT_ANNOTATION_DEMO')){const target=/\n应用: [^\n]* \(([A-Za-z0-9_-]+)\)\n构建:/.exec(user);emitTool('muse_read_app',{id:target?.[1]||'missing-annotation-target'});}
    else if(user.includes('AGENT_MEMORY_DEMO'))emitTool('memory_create',{name:'模型创建的知识',contentMarkdown:'KNOWLEDGE-MODEL-CREATED-42'});
    else if (user.includes('AGENT_SCHEDULE_DEMO')) emitTool('muse_create_schedule',{name:'模型创建的计划',prompt:'SCHEDULE_MODEL_CREATED_RESULT',cadence:{kind:'daily',timeZone:'Asia/Shanghai',time:'09:00'},enabled:false,notification:'none'});
    else if(user.includes('SCHEDULE_WRITE_DEMO'))emitTool('workspace_create_text_file',{name:'scheduled-write-rejected.md',content:'must not commit'});
    else if (user.includes('AGENT_APP_DEMO')) emitTool('muse_create_app',{name:'模型创建的应用',runtime:'html'});
    else if (user.includes('AGENT_SAVE_DEMO')) emitTool('workspace_list_files',{});
    else emitTool('workspace_create_text_file',{name:user.includes('AGENT_DENY_DEMO')?'denied-agent.md':user.includes('AGENT_STOP_DEMO')?'stopped-agent.md':'agent-created.md',content:'# AGENT-CREATED-42'});
    return;
  }
  const annotationOK=user.includes('[User annotated an element in their artifact]')&&user.includes('Element: button#selected-action.one.two.three')&&user.includes('DOM path: body > main > button')&&user.includes('Viewport: ')&&user.includes('Click position: ')&&user.includes('ELEMENT_CONTEXT_TOKEN')&&!user.includes('PRIVATE_INPUT_VALUE_NOT_CONTEXT');
  const panelPresent=user.includes('[用户当前引用的应用]'),panelOK=panelPresent&&/\n应用: [^\n]+ \([A-Za-z0-9_-]+\)\n/.test(user)&&!(/PANEL_(SOURCE|DOM|INPUT|SELECTION|SCREENSHOT)_PRIVATE_[AB]_12/.test(user));
  const chunks = user.includes('PANEL_DEMO_') ? [panelPresent?(panelOK?'PANEL_CONTEXT_RECEIVED':'PANEL_CONTEXT_INVALID'):'PANEL_CONTEXT_ABSENT'] : user.includes('ANNOTATION_DEMO') ? [annotationOK?'ANNOTATION_CONTEXT_RECEIVED':'ANNOTATION_CONTEXT_MISSING'] : user.includes('取消') ? Array(200).fill('进行中的回复。') : ['# 桌面验收通过\n\n','已收到你的问题。','参考资料代号：**WIND-CEDAR-42**。\n\n','- 流式中文回复\n- 本地文件上下文\n'];
  let index = 0;
  const timer = setInterval(() => {
    if (index >= chunks.length) { clearInterval(timer); response.end('data: [DONE]\n\n'); return; }
    response.write('data: ' + JSON.stringify({ choices:[{delta:{content:chunks[index++]}}] }) + '\n\n');
  }, 45);
  response.on('close', () => clearInterval(timer));
});
server.listen(0, '127.0.0.1', async () => {
  const env = { ...process.env, MUSE_E2E_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`, MUSE_E2E_FOLDER:folder };
  delete env.ELECTRON_RUN_AS_NODE;
  const binary = process.env.MUSE_PACKAGED_EXE || require('electron');
  const crypto=require('node:crypto');
  const application=process.env.MUSE_PACKAGED_EXE?path.join(path.dirname(binary),'resources','app'):root;
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const manifest=()=>{
    const result={};const visit=relative=>{const file=path.join(application,relative);if(fs.statSync(file).isDirectory()){for(const name of fs.readdirSync(file).sort())visit(relative+'/'+name);}else result[relative]=hash(file);};
    for(const name of ['main.cjs','preload.cjs','package.json','backend','build'])visit(name);
    for(const name of fs.readdirSync(path.join(application,'scripts')).filter(name=>/scenario\.cjs$/.test(name)).sort())visit('scripts/'+name);
    visit('scripts/video-fixtures.cjs');
    visit('scripts/pdf-fixtures.cjs');
    return result;
  };
  const runtimeAtLaunch=manifest(),executableAtLaunch=hash(binary);
  const args = process.env.MUSE_PACKAGED_EXE ? [] : [root];
  args.push('--desktop-test', '--data-dir=' + path.join(folder, 'data'));
  args.push('--background-lifecycle-test');
  args.push('--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required');
  const child = spawn(binary, args, { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const timeout = setTimeout(() => { output += '\nDesktop test timeout'; child.kill(); }, 180000);
  child.on('error', error => { clearTimeout(timeout); server.close(); console.error(error.message); process.exitCode=1; });
  child.on('exit', code => {
    clearTimeout(timeout); server.close();
    fs.writeFileSync(path.join(folder, 'electron.log'), output);
    fs.writeFileSync(path.join(folder, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(folder,'speech-requests.json'),JSON.stringify({capture:'Chromium fake device only',requests:speechRequests},null,2));
    fs.writeFileSync(path.join(folder,'tts-requests.json'),JSON.stringify({playback:'synthetic silent WAV with webContents muted',requests:ttsRequests},null,2));
    let desktopChecks;try{desktopChecks=JSON.parse(fs.readFileSync(path.join(folder,'desktop-checks.json'),'utf8'));}catch{}
    const runtimeAtExit=manifest(),driftedFiles=[...new Set([...Object.keys(runtimeAtLaunch),...Object.keys(runtimeAtExit)])].filter(name=>runtimeAtLaunch[name]!==runtimeAtExit[name]);
    const evidence = { exit_code:code, desktop_checks_completed:desktopChecks?.passed===true, desktop_check_count:desktopChecks?.check_count??desktopChecks?.checks?.length??0, folder, application, executable:binary, executable_sha256:executableAtLaunch, version:JSON.parse(fs.readFileSync(path.join(application,'package.json'),'utf8')).version, main_sha256:runtimeAtLaunch['main.cjs'], runtime_source_unchanged:driftedFiles.length===0&&hash(binary)===executableAtLaunch, drifted_runtime_files:driftedFiles,runtime_hashes:runtimeAtLaunch, provider_requests:requests.length, workspace_document_reached_provider:requests.some(x=>JSON.stringify(x.messages).includes('WIND-CEDAR-42')) };
    fs.writeFileSync(path.join(folder, 'test-run.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    if (code !== 0||!evidence.desktop_checks_completed||!evidence.runtime_source_unchanged) { console.error(output.slice(-6000)||'Desktop checks incomplete or runtime files changed during the test.'); process.exitCode=1; }
  });
});
