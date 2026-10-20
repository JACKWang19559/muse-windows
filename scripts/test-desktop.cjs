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
const server = http.createServer(async (request, response) => {
  if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data:[{id:'desktop-test-model'}] })); return; }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end('Not found'); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body); requests.push(parsed);
  response.writeHead(200, { 'content-type':'text/event-stream' });
  const user = parsed.messages.filter(x => x.role === 'user').at(-1)?.content || '';
  if (parsed.tools?.length && /AGENT_(CREATE|SAVE|DENY|STOP)_DEMO/.test(user)) {
    const emitTool = (name, args) => {
      const id = 'call-desktop-' + requests.length, data = JSON.stringify(args), cut = Math.floor(data.length / 2);
      response.write('data: ' + JSON.stringify({ choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:data.slice(0,cut)}}]}}] }) + '\n\n');
      setTimeout(() => response.end('data: ' + JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:data.slice(cut)}}]},finish_reason:'tool_calls'}]}) + '\n\ndata: [DONE]\n\n'), 15);
    };
    const last = parsed.messages.at(-1);
    if (last?.role === 'tool') {
      const receipt = JSON.parse(last.content), previous = parsed.messages.filter(message=>message.role==='assistant'&&message.tool_calls?.length).at(-1).tool_calls.at(-1);
      if (user.includes('AGENT_SAVE_DEMO') && receipt.ok) {
        if (previous.function.name === 'workspace_list_files') { const file = receipt.result.files.find(file=>file.name==='agent-created.md'); if (file) { emitTool('workspace_read_file',{id:file.id}); return; } }
        if (previous.function.name === 'workspace_read_file') { emitTool('workspace_save_text_file',{id:receipt.result.id,content:'# AGENT-SAVED-42',expectedSha256:receipt.result.sha256}); return; }
      }
      const text = receipt.ok ? '文件操作已完成，结果已回传。' : '用户没有批准，本次没有写入。';
      response.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'); return;
    }
    if (user.includes('AGENT_SAVE_DEMO')) emitTool('workspace_list_files',{});
    else emitTool('workspace_create_text_file',{name:user.includes('AGENT_DENY_DEMO')?'denied-agent.md':user.includes('AGENT_STOP_DEMO')?'stopped-agent.md':'agent-created.md',content:'# AGENT-CREATED-42'});
    return;
  }
  const chunks = user.includes('取消') ? Array(200).fill('进行中的回复。') : ['# 桌面验收通过\n\n','已收到你的问题。','参考资料代号：**WIND-CEDAR-42**。\n\n','- 流式中文回复\n- 本地文件上下文\n'];
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
  const args = process.env.MUSE_PACKAGED_EXE ? [] : [root];
  args.push('--desktop-test', '--data-dir=' + path.join(folder, 'data'));
  const child = spawn(binary, args, { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const timeout = setTimeout(() => { output += '\nDesktop test timeout'; child.kill(); }, 120000);
  child.on('error', error => { clearTimeout(timeout); server.close(); console.error(error.message); process.exitCode=1; });
  child.on('exit', code => {
    clearTimeout(timeout); server.close();
    fs.writeFileSync(path.join(folder, 'electron.log'), output);
    fs.writeFileSync(path.join(folder, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    const evidence = { exit_code:code, folder, provider_requests:requests.length, workspace_document_reached_provider:requests.some(x=>JSON.stringify(x.messages).includes('WIND-CEDAR-42')) };
    fs.writeFileSync(path.join(folder, 'test-run.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    if (code !== 0) { console.error(output.slice(-6000)); process.exitCode=1; }
  });
});
