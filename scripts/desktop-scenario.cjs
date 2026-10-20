const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {dialog} = require('electron');
module.exports = async ({ app, window, store, operations, snapshot }) => {
  const folder = process.env.MUSE_E2E_FOLDER;
  const checks = [];
  const page = (fn, value) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`);
  const wait = async (fn, value, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await page(fn, value); if (result) return result; await new Promise(r=>setTimeout(r,60)); }
    throw new Error('Timed out waiting for renderer: ' + fn.toString().slice(0,150));
  };
  const check = (name, result) => { assert.ok(result, name); checks.push({name,passed:true}); };
  const fill = async (testId,value) => page(input=>{
    const el=document.querySelector(`[data-testid="${input.testId}"]`);
    if(!el)throw new Error('Missing input '+input.testId);
    const prototype=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,input.value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
  },{testId,value});
  try {
    await wait(() => !!document.querySelector('[data-testid="composer-input"]'));
    const initial = await page(() => window.muse.bootstrap());
    check('Local renderer bootstraps through isolated preload', initial.app.platform === 'win32' && initial.chats.length === 0);
    await new Promise(r=>setTimeout(r,300));
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'welcome.png'),image.toPNG()));
    await page(()=>document.querySelector('[data-testid="settings-open"]').click());
    await wait(()=>!!document.querySelector('[data-testid="settings-base-url"]'));
    await fill('settings-base-url',process.env.MUSE_E2E_BASE_URL);
    await fill('settings-api-key','desktop-test-secret');
    await fill('settings-model','desktop-test-model');
    await page(()=>document.querySelector('[data-testid="settings-save"]').click());
    const settings = await wait(async ()=>{const s=await window.muse.bootstrap();return s.settings.model==='desktop-test-model'?s.settings:false;});
    check('Settings snapshot hides API key', settings.hasApiKey && !JSON.stringify(settings).includes('desktop-test-secret'));
    const connection = await page(() => window.muse.testConnection());
    check('Configured local provider connection test', connection.ok);
    const models = await page(() => window.muse.listModels());
    check('Model discovery works through main process', models.includes('desktop-test-model'));
    await new Promise(r=>setTimeout(r,300));
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'settings.png'),image.toPNG()));
    await page(()=>Array.from(document.querySelectorAll('.settings-footer button')).find(x=>x.textContent==='关闭').click());
    await page(()=>document.querySelector('[data-testid="workspace-new"]').click());
    await wait(()=>!!document.querySelector('[data-testid="workspace-name"]'));
    await fill('workspace-name','桌面验收工作区');
    await fill('workspace-description','仅用于自动验收');
    await page(()=>document.querySelector('[data-testid="workspace-create"]').click());
    const workspace = await wait(async ()=>{const s=await window.muse.bootstrap();return s.workspaces.find(x=>x.name==='桌面验收工作区');});
    check('Workspace creation works through the rendered form',!!workspace.id);
    const nativePicker=dialog.showOpenDialog;
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(folder,'reference.txt')]});
    let imported;
    try{[imported]=await page(input=>window.muse.importFiles(input),{workspaceId:workspace.id});}
    finally{dialog.showOpenDialog=nativePicker;}
    check('File import IPC copies a selected file (picker selection simulated)',!!imported?.id);
    for(const name of ['reference.pdf','reference.docx']){
      const file=await store.addFile({sourcePath:path.join(folder,name),workspaceId:workspace.id});
      check('Electron runtime extracts '+path.extname(name)+' text',file.textStatus==='ready');
    }
    const chat = await page(input => window.muse.createChat(input), { workspaceId:workspace.id });
    await wait(()=>!!Array.from(document.querySelectorAll('.sidebar-chat-main')).find(x=>x.title==='新对话'));
    await page(()=>Array.from(document.querySelectorAll('.sidebar-chat-main')).find(x=>x.title==='新对话').click());
    await fill('composer-input','请总结工作区资料。');
    await page(()=>document.querySelector('[data-testid="send-message"]').click());
    await wait(() => !!Array.from(document.querySelectorAll('.sidebar-chat-main')).find(x=>x.title==='请总结工作区资料。'));
    await page(() => Array.from(document.querySelectorAll('.sidebar-chat-main')).find(x=>x.title==='请总结工作区资料。').click());
    const finished = await wait(async chatId => { const s=await window.muse.bootstrap(); const c=s.chats.find(x=>x.id===chatId); return c?.messages.at(-1)?.status==='complete' ? c : false; }, chat.id);
    check('Real desktop IPC streams and persists assistant reply', finished.messages.at(-1).content.includes('WIND-CEDAR-42'));
    check('User and assistant messages are not duplicated', finished.messages.length === 2);
    await wait(() => document.body.textContent.includes('桌面验收通过'));
    check('Streaming Markdown is rendered by the UI', await page(() => !!Array.from(document.querySelectorAll('h1,h2,h3')).find(x=>x.textContent.includes('桌面验收通过'))));
    await new Promise(r=>setTimeout(r,300));
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'chat.png'),image.toPNG()));
    await page(input=>window.muse.retryMessage(input), {chatId:chat.id});
    const retried = await wait(async chatId=>{const s=await window.muse.bootstrap();const c=s.chats.find(x=>x.id===chatId);return c?.messages.at(-1)?.status==='complete'?c:false;},chat.id);
    check('Retry replaces the last assistant response', retried.messages.length===2);
    await page(input=>window.muse.sendMessage(input),{chatId:chat.id,content:'取消生成测试'});
    await wait(async chatId=>(await window.muse.bootstrap()).chats.find(x=>x.id===chatId)?.messages.at(-1)?.status==='streaming',chat.id);
    await new Promise(r=>setTimeout(r,140));
    await page(input=>window.muse.stopGeneration(input),{chatId:chat.id});
    const cancelled = await wait(async chatId=>{const s=await window.muse.bootstrap();const c=s.chats.find(x=>x.id===chatId);return c?.messages.at(-1)?.status==='cancelled'?c:false;},chat.id);
    check('Stop cancels network generation and persists status', cancelled.messages.at(-1).status==='cancelled');
    const preview=await page(input=>window.muse.readFile(input),{id:imported.id});
    check('Managed document preview preserves Unicode',preview.text.includes('WIND-CEDAR-42'));
    const backup=await store.exportData();
    check('Backup has no API key or original source path',!JSON.stringify(backup).includes('desktop-test-secret')&&!JSON.stringify(backup).includes(path.join(folder,'reference.txt')));
    const data=fs.readFileSync(path.join(app.getPath('userData'),'state.json'),'utf8');
    check('API key is not stored in plaintext on disk',!data.includes('desktop-test-secret'));
    const after=await page(()=>window.muse.bootstrap());
    check('Snapshot never exposes private file paths',!JSON.stringify(after.files).includes(folder));
    await page(()=>{document.querySelector('[data-testid="settings-open"]').click();});
    await wait(()=>!!document.querySelector('[data-testid="settings-base-url"]'));
    await new Promise(r=>setTimeout(r,300));
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'settings-after.png'),image.toPNG()));
    check('Settings dialog opens in the production renderer',true);
    const originalSave=dialog.showSaveDialog,originalOpen=dialog.showOpenDialog;
    try{
      const markdownPath=path.join(folder,'exported-chat.md');
      dialog.showSaveDialog=async()=>({canceled:false,filePath:markdownPath});
      await page(input=>window.muse.exportChat(input),{chatId:chat.id,format:'markdown'});
      check('Chat export IPC writes real Markdown (save destination simulated)',fs.readFileSync(markdownPath,'utf8').includes('桌面验收通过'));
      const backupPath=path.join(folder,'exported-backup.json');
      dialog.showSaveDialog=async()=>({canceled:false,filePath:backupPath});
      await page(()=>window.muse.exportData());
      check('Backup export IPC writes a key-free backup',!fs.readFileSync(backupPath,'utf8').includes('desktop-test-secret'));
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[backupPath]});
      const merged=await page(()=>window.muse.importData());
      check('Backup import IPC merges without replacing the current workspace',merged.workspaces.length===2&&merged.settings.hasApiKey&&merged.chats.length===2);
      const originalCopy=store.filePath(imported.id);
      await page(input=>window.muse.removeFile(input),{id:imported.id});
      check('Remove-file IPC deletes only the managed copy',!fs.existsSync(originalCopy)&&fs.existsSync(path.join(folder,'reference.txt')));
      await page(input=>window.muse.deleteChat(input),{id:chat.id});
      const detached=await page(input=>window.muse.deleteWorkspace(input),{id:workspace.id});
      check('Workspace deletion preserves and detaches remaining documents',detached.files.filter(f=>f.workspaceId===null).length===2&&detached.workspaces.length===1);
    }finally{dialog.showSaveDialog=originalSave;dialog.showOpenDialog=originalOpen;}
    const report={passed:true,checks,check_count:checks.length,provider:'local deterministic test server only',target_mac_app_executed:false};
    fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify(report,null,2));
    app.exit(0);
  } catch(error) {
    try { await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'failure.png'),image.toPNG())); } catch {}
    fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));
    throw error;
  }
};
