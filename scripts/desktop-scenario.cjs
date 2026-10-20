const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {dialog} = require('electron');
module.exports = async ({ app, window, store, operations, snapshot }) => {
  const folder = process.env.MUSE_E2E_FOLDER;
  const checks = [];
  const page = async (fn, value) => {
    const reply=await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${fn.toString()})(${JSON.stringify(value)})};}catch(error){return {ok:false,error:String(error?.message||error)}}})()`);
    if(!reply.ok)throw new Error(reply.error+' in '+fn.toString().slice(0,220));
    return reply.value;
  };
  const wait = async (fn, value, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await page(fn, value); if (result) return result; await new Promise(r=>setTimeout(r,60)); }
    throw new Error('Timed out waiting for renderer: ' + fn.toString().slice(0,150));
  };
  const check = (name, result) => { assert.ok(result, name); checks.push({name,passed:true}); fs.writeFileSync(path.join(folder,'desktop-progress.json'),JSON.stringify({checks,check_count:checks.length},null,2)); };
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
    if(process.env.MUSE_E2E_SCENARIO==='file-export'){
      await require('./file-export-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'file-export only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='json-file'){
      await require('./json-file-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'json-file only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='cancel-admission'){
      await require('./cancel-admission-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'cancel admission only',provider:'local deterministic HTTP test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='knowledge'){
      await require('./knowledge-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'knowledge only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='dictation'){
      await require('./dictation-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'dictation only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='active-panel'){
      await require('./active-panel-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'active-panel only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='annotation'){
      await require('./artifact-annotation-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'annotation only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
    if(process.env.MUSE_E2E_SCENARIO==='audio'){
      await require('./audio-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
      fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:true,checks,check_count:checks.length,scenario:'audio only',provider:'local deterministic test server only',target_mac_app_executed:false},null,2));app.exit(0);return;
    }
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
    await page(()=>Array.from(document.querySelectorAll('.settings-footer button')).find(x=>x.textContent==='关闭').click());
    await page(()=>document.querySelector('[data-testid="workspace-nav"]').click());
    await wait(()=>!!document.querySelector('[data-testid="workspace-file-new"]'));
    const createEditorFile=async name=>{
      await page(()=>document.querySelector('[data-testid="workspace-file-new"]').click());
      await wait(()=>!!document.querySelector('[data-testid="new-file-name"]'));
      await fill('new-file-name',name);
      await page(()=>document.querySelector('[data-testid="new-file-create"]').click());
      await wait(()=>!!document.querySelector('[data-testid="file-edit-mode"]:not(:disabled)'));
      return await page(async name=>(await window.muse.bootstrap()).files.find(file=>file.name===name),name);
    };
    const editorFile=await createEditorFile('编辑验收.md');
    await page(()=>document.querySelector('[data-testid="file-edit-mode"]').click());
    await fill('file-editor-input','## 编辑验收\n\nSOURCE-EDIT-42');
    await page(()=>document.querySelector('[data-testid="file-save"]').click());
    await wait(async id=>(await window.muse.readFile({id})).text.includes('SOURCE-EDIT-42'),editorFile.id);
    check('New Markdown file is created and saved through the rendered editor',true);
    const secondFile=await createEditorFile('第二份.md');
    await page(()=>document.querySelector('[data-testid="file-edit-mode"]').click());
    await fill('file-editor-input','未保存的第二个标签页');
    await page(()=>document.querySelector('[role="tab"][title="编辑验收.md"]').click());
    await page(()=>document.querySelector('[data-testid="file-preview-mode"]').click());
    check('Multiple file tabs retain drafts and render sanitized Markdown',await page(()=>document.querySelectorAll('.file-tab').length===2&&!!Array.from(document.querySelectorAll('.file-editor h2')).find(x=>x.textContent==='编辑验收')&&!!document.querySelector('[aria-label="未保存"]')));
    await page(()=>document.querySelector('[role="tab"][title="第二份.md"]').click());
    check('Switching file tabs preserves unsaved editor text',await page(()=>document.querySelector('[data-testid="file-editor-input"]')?.value==='未保存的第二个标签页'));
    await page(()=>document.querySelector('[aria-label="关闭文件 第二份.md"]').click());
    await wait(()=>!!document.querySelector('[data-testid="file-save-and-close"]'));
    check('Closing a dirty file requires an explicit save or discard choice',true);
    await page(()=>document.querySelector('[data-testid="file-save-and-close"]').click());
    await wait(()=>document.querySelectorAll('.file-tab').length===1);
    check('Save-and-close persists the draft before closing its tab',(await page(id=>window.muse.readFile({id}),secondFile.id)).text==='未保存的第二个标签页');
    await page(()=>document.querySelector('[data-testid="file-edit-mode"]').click());
    await fill('file-editor-input','THIS DRAFT MUST SURVIVE A CANCELLED WINDOW CLOSE');
    const nativeMessage=dialog.showMessageBoxSync;
    let closePrompts=0;
    try{dialog.showMessageBoxSync=()=>{closePrompts++;return 0;};window.close();await new Promise(resolve=>setTimeout(resolve,200));}
    finally{dialog.showMessageBoxSync=nativeMessage;}
    check('Native window close preserves unsaved files when Continue is selected',!window.isDestroyed()&&closePrompts===1);
    const external=await page(async id=>{const before=await window.muse.readFile({id});return window.muse.saveTextFile({id,content:'EXTERNAL EDIT MUST NOT BE OVERWRITTEN',expectedSha256:before.sha256});},editorFile.id);
    await page(()=>document.querySelector('[data-testid="file-save"]').click());
    await wait(()=>!!document.querySelector('.editor-error'));
    check('Stale editor save detects a conflict and preserves the newer file',(await page(id=>window.muse.readFile({id}),editorFile.id)).text==='EXTERNAL EDIT MUST NOT BE OVERWRITTEN');
    check('Conflict keeps the unsaved local draft available',await page(()=>document.querySelector('[data-testid="file-editor-input"]')?.value==='THIS DRAFT MUST SURVIVE A CANCELLED WINDOW CLOSE'));
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'file-editor.png'),image.toPNG()));
    await page(()=>document.querySelector('.editor-error button').click());
    await wait(()=>!!document.querySelector('[data-testid="file-discard"]'));
    await page(()=>document.querySelector('[data-testid="file-discard"]').click());
    await wait(()=>document.querySelector('.file-editor .markdown')?.textContent.trim()==='EXTERNAL EDIT MUST NOT BE OVERWRITTEN');
    check('Explicit discard-and-reload recovers the newest managed file',true);
    await page(()=>document.querySelector('[aria-label="关闭文件预览"]').click());
    await page(()=>Array.from(document.querySelectorAll('.workspace-section button')).find(button=>button.textContent.trim()==='新对话').click());
    await wait(()=>!!document.querySelector('[data-testid="agent-mode-toggle"]'));
    await page(()=>document.querySelector('[data-testid="agent-mode-toggle"]').click());
    check('File assistant is explicitly enabled in the rendered composer',await page(()=>document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed')==='true'));
    await page(()=>document.querySelector('.toast button[aria-label="关闭提示"]')?.click());
    const sendAgent=async text=>{await fill('composer-input',text);await page(()=>document.querySelector('[data-testid="send-message"]').click());};
    const pendingApproval=()=>wait(async()=>{const s=await window.muse.bootstrap();return s.approvals[0]||false;});
    const finishedAgent=chatId=>wait(async chatId=>{const chat=(await window.muse.bootstrap()).chats.find(chat=>chat.id===chatId);return chat?.messages.at(-1)?.status==='complete'?chat:false;},chatId);
    await sendAgent('AGENT_CREATE_DEMO 请创建文件。');
    const createApproval=await pendingApproval();
    check('Agent create is held before any write and shows the exact proposed content',!(await page(()=>window.muse.bootstrap())).files.some(file=>file.name==='agent-created.md')&&createApproval.arguments.content==='# AGENT-CREATED-42');
    await wait(()=>!!document.querySelector('[data-testid="approval-approve"]'));
    await page(()=>document.querySelector('.approval-card details').open=true);
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'agent-approval.png'),image.toPNG()));
    await page(()=>document.querySelector('[data-testid="approval-approve"]').click());
    const agentChat=await finishedAgent(createApproval.chatId);
    const agentFile=(await page(()=>window.muse.bootstrap())).files.find(file=>file.name==='agent-created.md');
    check('Approve UI executes the managed write and the model receives its result',(await page(id=>window.muse.readFile({id}),agentFile.id)).text==='# AGENT-CREATED-42'&&agentChat.messages.at(-1).content.includes('结果已回传'));
    check('Durable agent activity is visible with a complete tool receipt',agentChat.messages.at(-1).toolTrace[0].calls[0].status==='complete'&&await page(()=>!!document.querySelector('[data-testid="agent-activity"] [data-tool-status="complete"]')));
    check('File assistant selection survives the new-chat transition',await page(()=>document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed')==='true'));
    await sendAgent('AGENT_SAVE_DEMO 请修改刚创建的文件。');
    const saveApproval=await pendingApproval();
    check('Agent lists and reads current files before requesting a CAS-protected save',saveApproval.name==='workspace_save_text_file'&&saveApproval.arguments.id===agentFile.id&&/^[a-f0-9]{64}$/.test(saveApproval.arguments.expectedSha256));
    check('Proposed save leaves the old bytes intact until approved',(await page(id=>window.muse.readFile({id}),agentFile.id)).text==='# AGENT-CREATED-42');
    await page(()=>document.querySelector('[data-testid="approval-approve"]').click());
    const savedAgent=await finishedAgent(createApproval.chatId);
    check('Approved save commits once and all three tool rounds persist',(await page(id=>window.muse.readFile({id}),agentFile.id)).text==='# AGENT-SAVED-42'&&savedAgent.messages.at(-1).toolTrace.length===3);
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'agent-complete.png'),image.toPNG()));
    await sendAgent('AGENT_DENY_DEMO 请创建另一份文件。');
    await pendingApproval();
    await page(()=>document.querySelector('[data-testid="approval-deny"]').click());
    const deniedAgent=await finishedAgent(createApproval.chatId);
    check('Deny UI refuses the write and the model acknowledges that no file was written',deniedAgent.messages.at(-1).toolTrace[0].calls[0].status==='denied'&&!(await page(()=>window.muse.bootstrap())).files.some(file=>file.name==='denied-agent.md'));
    await sendAgent('AGENT_STOP_DEMO 请准备写入。');
    const stoppedApproval=await pendingApproval();
    await page(()=>document.querySelector('[data-testid="stop-generation"]').click());
    await wait(async id=>(await window.muse.bootstrap()).chats.find(chat=>chat.id===id)?.messages.at(-1)?.status==='cancelled',createApproval.chatId);
    const stopState=await page(()=>window.muse.bootstrap());
    check('Stop UI cancels a pending approval without creating its file',stopState.approvals.length===0&&!stopState.files.some(file=>file.name==='stopped-agent.md'));
    const staleDenied=await page(async id=>{try{await window.muse.respondApproval({id,decision:'approve'});return false;}catch{return true;}},stoppedApproval.id);
    check('Stale approval cannot be replayed through the real isolated IPC',staleDenied);
    await require('./json-file-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./file-export-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./chat-lifecycle-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./queue-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./cancel-admission-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./artifact-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./artifact-editing-scenario.cjs')({window,store,operations,folder,page,wait,check,fill});
    await require('./artifact-annotation-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./active-panel-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./scheduler-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./quit-cancel-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./knowledge-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./dictation-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    await require('./audio-scenario.cjs')({app,window,store,operations,folder,page,wait,check,fill});
    const report={passed:true,checks,check_count:checks.length,provider:'local deterministic test server only',target_mac_app_executed:false};
    fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify(report,null,2));
    app.exit(0);
  } catch(error) {
    try { await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'failure.png'),image.toPNG())); } catch {}
    fs.writeFileSync(path.join(folder,'desktop-checks.json'),JSON.stringify({passed:false,checks,check_count:checks.length,error:error.stack},null,2));
    throw error;
  }
};
