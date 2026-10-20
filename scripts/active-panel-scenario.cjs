'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Actual isolated Electron UI/IPC; only the harness's loopback model is used.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (!path.isAbsolute(folder || '') || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data')) || new URL(process.env.MUSE_E2E_BASE_URL).hostname !== '127.0.0.1') throw Error('Active-panel checks require the isolated loopback desktop fixture.');
  const originalSend = operations.sendMessage, originalBounds = window.getBounds(), releases = [], chatIds = [];
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Active-panel fixture operation did not start.')), 7000); })]); } finally { clearTimeout(timer); } };
  const paint = async () => { await new Promise(resolve => setTimeout(resolve, 180)); };
  const snapshot = () => page(() => window.muse.bootstrap());
  const draft = () => page(() => document.querySelector('[data-testid="composer-input"]').value);
  const panelName = () => page(() => document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent || '');
  const click = testId => page(id => { const node = document.querySelector(`[data-testid="${id}"]`); if (!node) throw Error('Missing '+id); node.click(); }, testId);
  const rowClick = (id, action) => page(input => { const row = [...document.querySelectorAll('[data-testid="pending-send"]')].find(node => node.dataset.queueId === input.id); if (!row) throw Error('Pending row missing'); row.querySelector(`[data-testid="${input.action}"]`).click(); }, {id,action});
  const send = async text => { await fill('composer-input',text); await wait(() => document.querySelector('[data-testid="send-message"]')?.disabled === false); await click('send-message'); };
  const complete = (chatId, note) => wait(async input => { const chat = (await window.muse.bootstrap()).chats.find(chat => chat.id === input.chatId); return chat?.messages.some(message => message.role === 'user' && message.content === input.note) && chat.messages.at(-1)?.status === 'complete' ? chat : false; }, {chatId,note});
  const choose = async artifact => {
    await page(id => document.querySelector(`[data-artifact-id="${id}"]`).click(), artifact.id);
    await wait(name => document.querySelector('.artifact-workbench h3')?.textContent === name && document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent === name, artifact.name);
    await wait(() => document.querySelector('[data-testid="artifact-pick"]')?.disabled === false);
  };
  const open = async artifact => {
    if (!await page(() => !!document.querySelector('[data-testid="artifact-panel"]'))) {
      await page(() => document.querySelector('[aria-label="展开侧栏"]')?.click());
      await click('artifacts-open'); await wait(() => !!document.querySelector('[data-testid="artifact-panel"]'));
    }
    await choose(artifact);
  };
  const geometry = () => page(() => {
    const box = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    const composer=box('[data-testid="composer-input"]'),panel=box('[data-testid="artifact-panel"]'),main=box('.main-content'),frame=box('[data-testid="artifact-frame"]'),source=box('.artifact-source');
    const button=document.querySelector('[data-testid="send-message"]'),r=button?.getBoundingClientRect(),hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    const identify=e=>e?{tag:e.tagName,className:typeof e.className==='string'?e.className:'',testId:e.dataset?.testid||null,role:e.getAttribute('role'),label:e.getAttribute('aria-label'),text:(e.textContent||'').trim().slice(0,180)}:null;
    return {width:innerWidth,height:innerHeight,composer,panel,main,frame,source,sendClickable:!!hit&&(hit===button||button.contains(hit)),view:document.querySelector('.artifact-workbench')?.dataset.view,
      send:r?{x:r.x,y:r.y,width:r.width,height:r.height,disabled:button.disabled,center:{x:r.x+r.width/2,y:r.y+r.height/2}}:null,hit:identify(hit),hitStack:r?document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).slice(0,8).map(identify):[],
      focused:document.hasFocus(),visibility:document.visibilityState,devicePixelRatio,rootClasses:document.querySelector('.desktop-app')?.className,activeElement:identify(document.activeElement),
      overlays:[...document.querySelectorAll('.modal-backdrop,.confirm-modal,.artifact-confirm,.toast,.sidebar-mobile-backdrop')].map(e=>{const r=e.getBoundingClientRect();return{...identify(e),x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(e).display,pointerEvents:getComputedStyle(e).pointerEvents};})};
  });
  const nonoverlap = g => g.composer?.width > 220 && g.panel?.width >= 490 && g.main?.right <= g.panel.x + 1 && g.composer.right <= g.panel.x + 1 && g.panel.right <= g.width + 1 && g.panel.bottom <= g.height + 1 && g.sendClickable;
  const minimal = (message, artifact) => message?.activePanel?.artifactId === artifact.id && message.activePanel.artifactName === artifact.name && message.activePanel.kind === 'artifact' && Object.keys(message.activePanel).sort().join(',') === 'artifactId,artifactName,kind' && message.artifactContext === undefined;

  try {
    window.setSize(1320,880); window.show(); window.restore(); window.focus(); await paint();
    const workspace=await page(() => window.muse.createWorkspace({name:'并排应用引用验收'}));
    const apps=[];
    for (const label of ['A','B']) {
      const artifact=await page(input => window.muse.createArtifact(input), {name:`并排应用 ${label} · R12`,runtime:'html',workspaceId:workspace.id});
      const source=`<!doctype html><html><head><style>body{font:16px system-ui;padding:24px;color:#234}button{padding:12px}</style></head><body><main><h1>PANEL_DOM_PRIVATE_${label}_12</h1><input value="PANEL_INPUT_PRIVATE_${label}_12"><p>PANEL_SELECTION_PRIVATE_${label}_12</p><button>Independent app ${label}</button></main><script>const internalOnly="PANEL_SOURCE_PRIVATE_${label}_12";const noScreenshot="PANEL_SCREENSHOT_PRIVATE_${label}_12";</script></body></html>`;
      await page(input => window.muse.writeArtifactFiles(input),{id:artifact.id,expectedRevision:artifact.sourceRevision,files:[{path:'index.html',text:source}]});
      await page(input => window.muse.buildArtifact(input),{id:artifact.id,expectedRevision:artifact.sourceRevision+1});apps.push(artifact);
    }
    const [a,b]=apps,chat=await page(input => window.muse.createChat(input),{workspaceId:workspace.id,title:'并排应用当前对话'});chatIds.push(chat.id);
    await wait(title => [...document.querySelectorAll('.sidebar-chat-main')].some(node => node.title===title),chat.title);
    await page(title => [...document.querySelectorAll('.sidebar-chat-main')].find(node => node.title===title).click(),chat.title);
    await open(a);await paint();
    const initialGeometry=await geometry();
    fs.writeFileSync(path.join(folder,'active-panel-start-geometry.json'),JSON.stringify({geometry:initialGeometry,host:{bounds:window.getBounds(),contentBounds:window.getContentBounds(),visible:window.isVisible(),minimized:window.isMinimized(),maximized:window.isMaximized(),zoomFactor:window.webContents.getZoomFactor()},checks:{composerWide:initialGeometry.composer?.width>220,panelWide:initialGeometry.panel?.width>=490,mainBesidePanel:initialGeometry.main?.right<=initialGeometry.panel?.x+1,composerBesidePanel:initialGeometry.composer?.right<=initialGeometry.panel?.x+1,panelWithinWidth:initialGeometry.panel?.right<=initialGeometry.width+1,panelWithinHeight:initialGeometry.panel?.bottom<=initialGeometry.height+1,sendClickable:initialGeometry.sendClickable}},null,2));
    try{await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'active-panel-start.png'),image.toPNG()));}catch(error){fs.writeFileSync(path.join(folder,'active-panel-start-capture-error.txt'),String(error?.message||error));}
    check('The current app docks beside a visible usable chat composer without overlap at 1320px',nonoverlap(initialGeometry));
    await wait(() => !!document.querySelector('[data-testid="artifact-code"]'));
    await page(() => { const editor=document.querySelector('[data-testid="artifact-code"]');editor.focus();editor.setSelectionRange(0,Math.min(100,editor.value.length)); });
    const ordinary='PANEL_DEMO_ORDINARY_A_12';await send(ordinary);const first=await complete(chat.id,ordinary),firstUser=first.messages.find(message=>message.content===ordinary);
    check('Ordinary composer send persists only the host-named minimal active app reference',minimal(firstUser,a)&&firstUser.attachmentIds.length===0);
    check('The loopback model receives the app resource but no source DOM input selected text or screenshot',first.messages.at(-1).content==='PANEL_CONTEXT_RECEIVED');
    check('Ordinary send leaves the selected app and preview open beside the chat',await page(name=>!!document.querySelector('[data-testid="artifact-panel"]')&&document.querySelector('.artifact-workbench h3')?.textContent===name,a.name));
    await paint();await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'active-panel-1320.png'),image.toPNG()));

    await send('取消 ACTIVE_PANEL_HOLD_12');await wait(async id=>(await window.muse.bootstrap()).chats.find(chat=>chat.id===id)?.messages.at(-1)?.status==='streaming',chat.id);
    const queuedText='PANEL_DEMO_QUEUE_A_12';await send(queuedText);
    const queued=await wait(async input=>(await window.muse.bootstrap()).pendingSends.find(item=>item.chatId===input.chatId&&item.content===input.content),{chatId:chat.id,content:queuedText});
    await choose(b);
    check('Queued ordinary feedback captures app A even after the live preview switches to app B',minimal(queued,a)&&!store.getChat(chat.id).messages.some(message=>message.content===queuedText)&&await panelName()===b.name);
    await click('stop-generation');await wait(async id=>{const s=await window.muse.bootstrap();return s.chats.find(chat=>chat.id===id)?.messages.at(-1)?.status==='cancelled'&&s.pendingSends.some(item=>item.chatId===id&&item.state==='failed');},chat.id);
    const stopped=(await snapshot()).pendingSends.find(item=>item.id===queued.id);
    check('Stopping the active reply keeps queued app A as a failed unsent intent',stopped?.state==='failed'&&minimal(stopped,a)&&!store.getChat(chat.id).messages.some(message=>message.content===queuedText));
    await fill('composer-input','OCCUPIED_DRAFT_UNDER_B_12');await rowClick(queued.id,'queue-restore');await paint();
    check('Contextual queue recovery refuses an occupied draft and retains the original A intent',await draft()==='OCCUPIED_DRAFT_UNDER_B_12'&&await panelName()===b.name&&(await snapshot()).pendingSends.some(item=>item.id===queued.id));
    await fill('composer-input','');await rowClick(queued.id,'queue-restore');
    await wait(input=>document.querySelector('[data-testid="composer-input"]').value===input.text&&document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent===input.name,{text:queuedText,name:a.name});
    check('Restored queue feedback visibly retains app A while app B remains displayed',await page(name=>document.querySelector('.artifact-workbench h3')?.textContent===name,b.name)&&!(await snapshot()).pendingSends.some(item=>item.id===queued.id));
    await click('send-message');const resent=await complete(chat.id,queuedText);
    check('Resending restored feedback uses captured app A rather than the newly displayed B',minimal(resent.messages.find(message=>message.content===queuedText),a)&&resent.messages.at(-1).content==='PANEL_CONTEXT_RECEIVED'&&await panelName()===b.name);

    await choose(a);
    const failedText='PANEL_DEMO_FAILED_A_12',typedB='PANEL_NEW_TYPING_UNDER_B_12',entered=deferred(),gate=deferred();releases.push(gate.resolve);let captured;
    operations.sendMessage=async input=>{if(input.content!==failedText)return originalSend(input);captured=structuredClone(input);entered.resolve();await gate.promise;throw Error('Synthetic active-panel admission rejection.');};
    try {
      await send(failedText);await bounded(entered.promise);await choose(b);await fill('composer-input',typedB);gate.resolve();
      await wait(input=>[...document.querySelectorAll('[data-testid="pending-send"]')].some(row=>row.dataset.queueId===input.id)&&document.querySelector('[data-testid="agent-mode-toggle"]')?.disabled===false,{id:captured.clientMessageId});
      check('A delayed rejected A admission keeps text typed under B separate from the failed A recovery',minimal(captured,a)&&await draft()===typedB&&await panelName()===b.name&&!store.getChat(chat.id).messages.some(message=>message.content===failedText));
      await rowClick(captured.clientMessageId,'queue-restore');await paint();
      check('A local rejected A recovery cannot merge itself into the newer B draft',await draft()===typedB&&await panelName()===b.name&&await page(id=>!!document.querySelector(`[data-queue-id="${id}"]`),captured.clientMessageId));
      await fill('composer-input','');await rowClick(captured.clientMessageId,'queue-restore');
      await wait(input=>document.querySelector('[data-testid="composer-input"]').value===input.text&&document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent===input.name,{text:failedText,name:a.name});
      check('After explicitly clearing the new draft the failed A intent restores without mixing resource context',await page(input=>document.querySelector('.artifact-workbench h3')?.textContent===input.name&&!document.querySelector(`[data-queue-id="${input.id}"]`),{name:b.name,id:captured.clientMessageId}));
    } finally {gate.resolve();operations.sendMessage=originalSend;}
    await click('send-message');const recovered=await complete(chat.id,failedText);
    check('Recovered admission failure resends once with its original app reference',recovered.messages.filter(message=>message.role==='user'&&message.content===failedText).length===1&&minimal(recovered.messages.find(message=>message.content===failedText),a)&&recovered.messages.at(-1).content==='PANEL_CONTEXT_RECEIVED');

    await page(()=>document.querySelector('[aria-label="关闭本地应用"]').click());await wait(()=>!document.querySelector('[data-testid="artifact-panel"]')&&!document.querySelector('[data-testid="composer-active-panel"]'));
    const plainText='PANEL_DEMO_NO_PANEL_12';await send(plainText);const plain=await complete(chat.id,plainText),plainUser=plain.messages.find(message=>message.content===plainText);
    check('Closing the app panel prevents a later ordinary message from inheriting historical app context',plainUser.activePanel===undefined&&plainUser.artifactContext===undefined&&plain.messages.at(-1).content==='PANEL_CONTEXT_ABSENT');

    await open(a);await page(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})));await wait(()=>!!document.querySelector('.welcome-page')&&!document.querySelector('.content-heading h1'));
    const newText='PANEL_DEMO_NEW_CHAT_12';await send(newText);
    const promoted=await wait(async note=>(await window.muse.bootstrap()).chats.find(chat=>chat.messages.some(message=>message.role==='user'&&message.content===note)&&chat.messages.at(-1)?.status==='complete'),newText);chatIds.push(promoted.id);
    check('A new-chat ordinary send captures the visible app before promotion and keeps the dock open',promoted.id!==chat.id&&promoted.workspaceId===workspace.id&&minimal(promoted.messages[0],a)&&promoted.messages.at(-1).content==='PANEL_CONTEXT_RECEIVED'&&await page(()=>!!document.querySelector('[data-testid="artifact-panel"]')));

    window.setSize(900,880);await paint();await click('artifact-view-preview');await paint();const previewGeometry=await geometry();
    check('At 900px preview tab keeps chat and live preview visible without overlap',nonoverlap(previewGeometry)&&previewGeometry.view==='preview'&&previewGeometry.frame?.width>200&&previewGeometry.source?.width===0);
    await click('artifact-view-source');await paint();const sourceGeometry=await geometry();
    check('At 900px source tab exposes the editor without covering the usable chat composer',nonoverlap(sourceGeometry)&&sourceGeometry.view==='source'&&sourceGeometry.source?.width>200&&sourceGeometry.frame?.width===0);
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'active-panel-900-source.png'),image.toPNG()));
    window.setSize(1320,880);await click('artifact-view-preview');await paint();
    check('Returning to 1320px preserves the current app and restores the wide dock geometry',nonoverlap(await geometry())&&await panelName()===a.name);
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'active-panel-final.png'),image.toPNG()));
    await page(()=>document.querySelector('[aria-label="关闭本地应用"]').click());
  } finally {
    operations.sendMessage=originalSend;releases.forEach(release=>release());
    for(const chatId of chatIds){try{operations.stopGeneration({chatId});}catch{}}
    window.setBounds(originalBounds);
  }
};
