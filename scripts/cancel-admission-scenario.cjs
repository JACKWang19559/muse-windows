'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {dialog}=require('electron');

// Runs only inside the isolated Windows desktop harness. Delays wrap real host
// operations; no renderer bridge or acceptance/cancellation receipt is replaced.
// Synthetic model bytes arrive through the harness's actual loopback HTTP stream.
module.exports=async({app,window,store,operations,folder,page,wait,check,fill})=>{
  const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
  const endpoint=new URL(process.env.MUSE_E2E_BASE_URL||'http://invalid');
  if(!path.isAbsolute(folder||'')||!same(app.getPath('userData'),path.join(folder,'data'))||!same(store.dataDir,path.join(folder,'data'))||endpoint.hostname!=='127.0.0.1')throw Error('Admission cancellation requires the isolated loopback desktop fixture.');
  if(typeof operations.cancelSendAdmission!=='function')throw Error('The production cancelSendAdmission contract is unavailable.');
  const original={create:operations.createChat,send:operations.sendMessage,retry:operations.retryMessage,cancel:operations.cancelSendAdmission,stop:operations.stopGeneration,picker:dialog.showOpenDialog};
  const releases=[],chatIds=[],events=[],cancellations=[];
  let ordinal=0;
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
  const gate=()=>{const value={entered:deferred(),release:deferred(),returned:deferred()};releases.push(value.release.resolve);return value;};
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Admission fixture gate timed out.')),7000);})]);}finally{clearTimeout(timer);}};
  const paint=()=>new Promise(resolve=>setTimeout(resolve,140));
  const click=id=>page(testId=>{const element=document.querySelector(`[data-testid="${testId}"]`);if(!element||element.disabled)throw Error('Missing or disabled test control '+testId);element.click();},id);
  const draft=()=>page(()=>document.querySelector('[data-testid="composer-input"]').value);
  const pending=chatId=>page(async id=>(await window.muse.bootstrap()).pendingSends.filter(item=>item.chatId===id),chatId);
  const noStop=()=>wait(()=>!document.querySelector('[data-testid="stop-generation"]'));
  const routeTo=async chat=>{
    await page(()=>document.querySelector('[aria-label="展开侧栏"]')?.click());
    await wait(title=>[...document.querySelectorAll('.sidebar-chat-main')].some(element=>element.title===title),chat.title);
    await page(title=>[...document.querySelectorAll('.sidebar-chat-main')].find(element=>element.title===title).click(),chat.title);
    await wait(title=>document.querySelector('.content-heading h1')?.textContent===title,chat.title);
  };
  const fresh=async label=>{const chat=store.createChat({title:`取消准入 ${++ordinal} · ${label}`});chatIds.push(chat.id);operations.updateChat({id:chat.id,title:chat.title});await routeTo(chat);await fill('composer-input','');return chat;};
  const send=async text=>{await fill('composer-input',text);await wait(()=>document.querySelector('[data-testid="send-message"]')?.disabled===false);await click('send-message');};
  const stop=async()=>{await wait(()=>!!document.querySelector('[data-testid="stop-generation"]'));await click('stop-generation');};
  const queued=(chatId,text)=>wait(async input=>(await window.muse.bootstrap()).pendingSends.find(item=>item.chatId===input.chatId&&item.content===input.text),{chatId,text});
  const restore=async id=>page(queueId=>{const row=[...document.querySelectorAll('[data-testid="pending-send"]')].find(element=>element.dataset.queueId===queueId);if(!row)throw Error('Recoverable intent missing.');row.querySelector('[data-testid="queue-restore"]').click();},id);
  const requestCount=async marker=>{
    const url=new URL('/__muse_test/cancel-admission-state',endpoint),response=await fetch(url,{signal:AbortSignal.timeout(2500)});if(!response.ok)throw Error('Loopback request observer unavailable.');
    const value=await response.json();return value.requests.filter(request=>request.markers.includes(marker)).length;
  };
  const noDispatch=async(chat,text)=>!store.getChat(chat.id).messages.some(message=>message.role==='user'&&message.content===text)&&(await requestCount(text)??0)===0;
  const waitPartial=chatId=>wait(async id=>{const chat=(await window.muse.bootstrap()).chats.find(item=>item.id===id),assistant=chat?.messages.find(message=>message.role==='assistant'&&message.status==='streaming'&&message.content.includes('CANCEL17_PARTIAL_'));return assistant||false;},chatId);
  const active=async(chat,text)=>{await send(text);await waitPartial(chat.id);return store.getChat(chat.id);};
  const waitCancelled=chatId=>wait(async id=>{const chat=(await window.muse.bootstrap()).chats.find(item=>item.id===id);return chat?.messages.at(-1)?.status==='cancelled'?chat:false;},chatId);
  const setMode=async enabled=>{await wait(()=>document.querySelector('[data-testid="agent-mode-toggle"]')?.disabled===false);if(await page(()=>document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed')==='true')!==enabled)await click('agent-mode-toggle');};
  const wrapSend=(text,after=false)=>{const held=gate();operations.sendMessage=async input=>{if(input.content!==text)return original.send(input);held.input=structuredClone(input);if(after){const receipt=await original.send(input);held.entered.resolve(receipt);await held.release.promise;held.returned.resolve();return receipt;}held.entered.resolve();await held.release.promise;try{return await original.send(input);}finally{held.returned.resolve();}};return held;};
  operations.cancelSendAdmission=async input=>{const result=await original.cancel(input);cancellations.push({clientMessageId:input.clientMessageId,state:result.state,unseen:result.unseen,recoverable:result.recoverable?.length??0});return result;};
  try{
    check('Cancellation desktop fixture uses the production immutable preload contract',await page(()=>typeof window.muse.cancelSendAdmission==='function'&&Object.isFrozen(window.muse)));

    await page(()=>document.querySelector('[aria-label="展开侧栏"]')?.click());await click('new-chat');await noStop();
    const creation=gate(),first='CANCEL17_FIRST_CREATE',beforeChats=new Set(store.snapshot().chats.map(chat=>chat.id));let created;
    operations.createChat=async input=>{creation.entered.resolve();await creation.release.promise;try{created=await original.create(input);chatIds.push(created.id);return created;}finally{creation.returned.resolve();}};
    try{
      await send(first);await bounded(creation.entered.promise);await stop();await wait(text=>document.querySelector('[data-testid="composer-input"]').value===text,first);
      check('Stopping first createChat restores its unsent text before the delayed creation returns',await draft()===first&&store.snapshot().chats.filter(chat=>!beforeChats.has(chat.id)).length===0);
      const other=await operations.createWorkspace({name:'取消准入 · 另一工作区'});
      await page(()=>document.querySelector('[aria-label="展开侧栏"]')?.click());await wait(name=>[...document.querySelectorAll('[data-testid="workspace-nav"]')].some(element=>element.textContent.includes(name)),other.name);
      await page(name=>[...document.querySelectorAll('[data-testid="workspace-nav"]')].find(element=>element.textContent.includes(name)).click(),other.name);await fill('composer-input','CANCEL17_NEW_SCOPE_DRAFT');
      creation.release.resolve();await bounded(creation.returned.promise);await paint();
      const lateCreated=store.snapshot().chats.find(chat=>chat.id===created?.id);
      check('A late real createChat result neither sends the cancelled intent nor navigates over a new workspace draft',!!created&&(!lateCreated||lateCreated.messages.length===0)&&!store.snapshot().chats.some(chat=>chat.messages.some(message=>message.role==='user'&&message.content===first))&&await draft()==='CANCEL17_NEW_SCOPE_DRAFT'&&await page(name=>document.querySelector('.workspace-title h2')?.textContent===name,other.name)&&(await requestCount(first)??0)===0);
      await page(()=>document.querySelector('[aria-label="展开侧栏"]')?.click());await click('new-chat');await wait(text=>document.querySelector('[data-testid="composer-input"]').value===text,first);
      check('First-create cancellation preserves its draft in the original personal composer exactly once',await draft()===first);await fill('composer-input','');
      events.push({case:'create-before',lateEmptyChat:created.id,providerRequests:await requestCount(first)});
    }finally{creation.release.resolve();operations.createChat=original.create;}

    const pre=await fresh('发送 IPC 前'),preText='CANCEL17_BEFORE_ADMISSION',before=wrapSend(preText);
    try{
      await send(preText);await bounded(before.entered.promise);await stop();await wait(text=>document.querySelector('[data-testid="composer-input"]').value===text,preText);
      const cancelled=cancellations.find(entry=>entry.clientMessageId===before.input.clientMessageId);
      check('Stop during pending send IPC creates an unseen cancellation tombstone and restores once',cancelled?.state==='cancelled'&&cancelled.unseen===true&&await noDispatch(pre,preText));
      before.release.resolve();await bounded(before.returned.promise);await noStop();await paint();
      check('The late original send cannot append, dispatch, duplicate or erase the restored draft',await draft()===preText&&await noDispatch(pre,preText)&&(await pending(pre.id)).length===0);
    }finally{before.release.resolve();operations.sendMessage=original.send;}

    const post=await fresh('已准入但响应延迟'),postText='CANCEL17_ACTIVE_RECEIPT',after=wrapSend(postText,true);
    try{
      await send(postText);await bounded(after.entered.promise);await waitPartial(post.id);await stop();const stopped=await waitCancelled(post.id);
      after.release.resolve();await bounded(after.returned.promise);await noStop();await paint();
      check('A real admitted HTTP stream keeps its user turn and partial reply when its IPC receipt arrives after Stop',stopped.messages.filter(message=>message.role==='user'&&message.content===postText).length===1&&stopped.messages.at(-1).content.includes('CANCEL17_PARTIAL_')&&store.getChat(post.id).messages.at(-1).status==='cancelled'&&await draft()===''&&!await page(()=>!!document.querySelector('[data-testid="stop-generation"]'))&&(await requestCount(postText)??1)===1);
    }finally{after.release.resolve();operations.sendMessage=original.send;}

    const retryChat=await fresh('重试旧回执不停止新请求'),retryText='CANCEL17_ACTIVE_RETRY',afterRetry='CANCEL17_ACTIVE_AFTER_RETRY';
    store.appendMessage(retryChat.id,{role:'user',content:retryText});store.appendMessage(retryChat.id,{role:'assistant',content:'Synthetic completed local reply for retry.',status:'complete'});operations.updateChat({id:retryChat.id,title:retryChat.title});
    const retryGate=gate();operations.retryMessage=async input=>{if(input.chatId!==retryChat.id)return original.retry(input);const receipt=await original.retry(input);retryGate.receipt=receipt;retryGate.entered.resolve();await retryGate.release.promise;retryGate.returned.resolve();return receipt;};
    try{
      await wait(()=>document.querySelector('[data-testid="retry-message"]')?.disabled===false);await click('retry-message');await bounded(retryGate.entered.promise);await waitPartial(retryChat.id);
      // The live host snapshot already exposes this real request identity. The
      // missing-request-id microtask window is covered by the separate renderer
      // closure regressions, not claimed as an Electron observation here.
      const observedRequest=await page(async id=>(await window.muse.bootstrap()).activeRequests?.find(entry=>entry.chatId===id)?.requestId,retryChat.id);
      await stop();await waitCancelled(retryChat.id);await noStop();
      check('Stopping a retry with an observed real request identity retains its canonical user without a draft copy',!!observedRequest&&store.getChat(retryChat.id).messages.filter(message=>message.role==='user'&&message.content===retryText).length===1&&await draft()==='');
      await send(afterRetry);const newerPartial=await waitPartial(retryChat.id);retryGate.release.resolve();await bounded(retryGate.returned.promise);await paint();
      check('A late old retry receipt precisely stops its old request and cannot cancel a newer same-chat HTTP stream',store.getChat(retryChat.id).messages.find(message=>message.id===newerPartial.id)?.status==='streaming'&&await page(()=>!!document.querySelector('[data-testid="stop-generation"]'))&&(await requestCount(retryText)??1)===1&&(await requestCount(afterRetry)??1)===1);
      await stop();const finalRetry=await waitCancelled(retryChat.id);await noStop();
      check('The newer HTTP request remains separately stoppable without duplicate user turns or restored drafts',finalRetry.messages.filter(message=>message.role==='user').length===2&&finalRetry.messages.at(-1).content.includes('CANCEL17_PARTIAL_')&&await draft()===''&&(await pending(retryChat.id)).length===0);
      events.push({case:'retry-late-receipt',snapshotRequestIdObserved:true,missingRequestIdWindowExercised:false,oldReceiptRequestId:retryGate.receipt?.requestId,newerStreamPreserved:true});
    }finally{retryGate.release.resolve();operations.retryMessage=original.retry;}

    const fifo=await fresh('两项排队'),firstQueued='CANCEL17_FIFO_FIRST',secondQueued='CANCEL17_FIFO_SECOND';
    await active(fifo,'CANCEL17_ACTIVE_FIFO');await send(firstQueued);const firstIntent=await queued(fifo.id,firstQueued);await send(secondQueued);const secondIntent=await queued(fifo.id,secondQueued);await stop();await waitCancelled(fifo.id);
    const fifoState=async input=>{
      const snapshot=await window.muse.bootstrap(),pending=snapshot.pendingSends.filter(item=>item.chatId===input.chatId),chat=snapshot.chats.find(item=>item.id===input.chatId);
      const rows=[...document.querySelectorAll('[data-testid="pending-send"]')].map(row=>({id:row.dataset.queueId,text:row.querySelector('p')?.textContent||'',failed:row.classList.contains('failed')}));
      const state={draft:document.querySelector('[data-testid="composer-input"]').value,stopVisible:!!document.querySelector('[data-testid="stop-generation"]'),rows,hostPending:pending.map(item=>({id:item.id,content:item.content,state:item.state})),lastMessageStatus:chat?.messages.at(-1)?.status};
      const settled=state.draft===input.firstText&&!state.stopVisible&&state.lastMessageStatus==='cancelled'&&rows.length===1&&rows[0].id===input.secondId&&rows[0].text===input.secondText&&rows[0].failed&&pending.length===1&&pending[0].id===input.secondId&&pending[0].state==='failed';
      return input.diagnostic?state:settled?state:false;
    };
    const fifoInput={chatId:fifo.id,firstText:firstQueued,secondText:secondQueued,firstId:firstIntent.id,secondId:secondIntent.id};let settledFifo;
    try{settledFifo=await wait(fifoState,fifoInput);}catch(error){fs.writeFileSync(path.join(folder,'cancel-admission-fifo-failure.json'),JSON.stringify(await page(fifoState,{...fifoInput,diagnostic:true}),null,2));throw error;}
    check('Stop restores only the oldest queued intent into an unchanged empty draft and preserves the second in both host and rendered UI',!!settledFifo&&await noDispatch(fifo,firstQueued)&&await noDispatch(fifo,secondQueued));
    events.push({case:'fifo-renderer-settled',...settledFifo});
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'cancel-admission-empty-restore.png'),image.toPNG()));
    await fill('composer-input','');await restore(secondIntent.id);await wait(text=>document.querySelector('[data-testid="composer-input"]').value===text,secondQueued);
    check('The second stopped intent remains manually recoverable without automatic dispatch',await draft()===secondQueued&&(await pending(fifo.id)).length===0&&await noDispatch(fifo,secondQueued));

    for(const kind of ['text','whitespace','file','quote','panel','mode']){
      const chat=await fresh(`新 ${kind} 不覆盖`),text=`CANCEL17_CONFLICT_${kind.toUpperCase()}`;
      const quoteTarget=kind==='quote'?store.appendMessage(chat.id,{role:'user',content:'CANCEL17_QUOTE_TARGET'}):null;
      if(quoteTarget)operations.updateChat({id:chat.id,title:chat.title});
      await setMode(false);await active(chat,`CANCEL17_ACTIVE_${kind.toUpperCase()}`);await send(text);const intent=await queued(chat.id,text);let artifact;
      if(kind==='text'||kind==='whitespace')await fill('composer-input',kind==='text'?'CANCEL17_NEW_TYPED_CONTENT':'   ');
      if(kind==='file'){
        dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(folder,'reference.txt')]});
        try{await click('file-import');await wait(()=>document.querySelectorAll('.attachment-tray .attachment-pill').length===1);}finally{dialog.showOpenDialog=original.picker;}
      }
      if(kind==='panel'){
        artifact=await operations.createArtifact({name:'取消准入 · 新应用引用',runtime:'html'});await page(()=>document.querySelector('[aria-label="展开侧栏"]')?.click());await click('artifacts-open');await wait(id=>!!document.querySelector(`[data-artifact-id="${id}"]`),artifact.id);await page(id=>document.querySelector(`[data-artifact-id="${id}"]`).click(),artifact.id);await wait(name=>document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent===name,artifact.name);
      }
      if(kind==='mode')await setMode(true);
      if(kind==='quote'){
        // Quoting is intentionally disabled during a live reply. Exercise a
        // legitimate new selection after the real abort event, while only the
        // original Stop receipt is delayed and automatic recovery still waits.
        const held=gate();operations.stopGeneration=async input=>{const receipt=await original.stop(input);held.entered.resolve();await held.release.promise;held.returned.resolve();return receipt;};
        try{
          await stop();await bounded(held.entered.promise);await waitCancelled(chat.id);
          await wait(id=>document.querySelector(`[data-message-id="${id}"] [data-testid="quote-message"]`)?.disabled===false,quoteTarget.id);
          await page(id=>document.querySelector(`[data-message-id="${id}"] [data-testid="quote-message"]`).click(),quoteTarget.id);await wait(()=>!!document.querySelector('[data-testid="composer-quote"]'));
          held.release.resolve();await bounded(held.returned.promise);
        }finally{held.release.resolve();operations.stopGeneration=original.stop;}
      }else{await stop();await waitCancelled(chat.id);}
      await wait(id=>!!document.querySelector(`[data-queue-id="${id}"].failed`),intent.id);
      const retained=await pending(chat.id),untouched=await page(type=>({draft:document.querySelector('[data-testid="composer-input"]').value,attachments:document.querySelectorAll('.attachment-tray .attachment-pill').length,quote:!!document.querySelector('[data-testid="composer-quote"]'),panel:document.querySelector('[data-testid="composer-active-panel"] strong')?.textContent||'',mode:document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed')==='true'}),kind);
      const preserved=kind==='text'?untouched.draft==='CANCEL17_NEW_TYPED_CONTENT':kind==='whitespace'?untouched.draft==='   ':kind==='file'?untouched.attachments===1&&untouched.draft==='':kind==='quote'?untouched.quote&&untouched.draft==='':kind==='panel'?untouched.panel===artifact.name&&untouched.draft==='':untouched.mode&&untouched.draft==='';
      check(`Stop preserves a newer ${kind} context and leaves the unsent intent separate`,preserved&&retained.some(item=>item.id===intent.id&&item.state==='failed')&&await noDispatch(chat,text));
      if(kind==='text'||kind==='whitespace')await fill('composer-input','');
      if(kind==='file')await page(()=>document.querySelector('.attachment-tray [aria-label^="移除附件 "]').click());
      if(kind==='quote')await page(()=>document.querySelector('[data-testid="composer-quote"] [aria-label="取消引用"]').click());
      if(kind==='panel'){await page(()=>document.querySelector('[aria-label="关闭本地应用"]').click());await wait(()=>!document.querySelector('[data-testid="composer-active-panel"]'));}
      if(kind==='mode')await setMode(false);
      await restore(intent.id);await wait(value=>document.querySelector('[data-testid="composer-input"]').value===value,text);
      check(`The separate ${kind} conflict intent can be manually restored after resolving the new context`,await draft()===text&&(await pending(chat.id)).length===0&&await noDispatch(chat,text));
      events.push({case:'conflict-'+kind,intentId:intent.id,preserved:true,manuallyRecovered:true,providerRequests:await requestCount(text)});
      if(kind==='text')await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'cancel-admission-conflict-recovered.png'),image.toPNG()));
    }

    const stream=await fresh('正常 HTTP 流停止'),streamText='CANCEL17_ACTIVE_HTTP';await active(stream,streamText);await stop();const stopped=await waitCancelled(stream.id);await noStop();await paint();
    check('Normal Stop after real HTTP partial output preserves the canonical user and partial assistant without restoring a duplicate draft',stopped.messages.filter(message=>message.role==='user'&&message.content===streamText).length===1&&stopped.messages.at(-1).content.includes('CANCEL17_PARTIAL_')&&await draft()===''&&(await pending(stream.id)).length===0&&(await requestCount(streamText)??1)===1);
    await window.webContents.capturePage().then(image=>fs.writeFileSync(path.join(folder,'cancel-admission-stream-stop.png'),image.toPNG()));
    fs.writeFileSync(path.join(folder,'cancel-admission-evidence.json'),JSON.stringify({scope:'Independent Windows reconstruction; real loopback HTTP and host operations, no original Mac app execution.',events,cancellations,externalModelProviderUsed:false,modelResultSynthetic:true,fakeHostAcknowledgement:false,rendererBridgeReplaced:false},null,2));
  }finally{
    operations.createChat=original.create;operations.sendMessage=original.send;operations.retryMessage=original.retry;operations.cancelSendAdmission=original.cancel;operations.stopGeneration=original.stop;dialog.showOpenDialog=original.picker;
    releases.forEach(release=>release());
    for(const chatId of chatIds){try{await operations.stopGeneration({chatId});}catch{}}
  }
};
