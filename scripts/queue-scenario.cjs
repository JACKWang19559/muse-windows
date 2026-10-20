'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !same(app.getPath('userData'), path.join(folder, 'data')) || !same(store.dataDir, path.join(folder, 'data'))) throw new Error('Queue verification requires the isolated desktop fixture profile.');
  const provider = require('../backend/provider.cjs');
  const originals = { completion: provider.streamCompletion, send: operations.sendMessage, create: operations.createChat, cancel: operations.cancelQueuedMessage };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const plans = new Map(), calls = [], releases = [], chatIds = [];
  const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Queue fixture operation did not start.')), 7000); })]); } finally { clearTimeout(timer); } };
  const plan = content => { const entered = deferred(), gate = deferred(); const value = { entered, gate }; plans.set(content, value); releases.push(gate.resolve); return value; };
  const waitGate = (gate, signal) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); handler(value); };
    const abort = () => finish(reject, new DOMException('Queue fixture stopped.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else gate.then(value => finish(resolve, value));
  });
  // Deterministic injected completions exercise the actual Electron host/IPC
  // and queue lifecycle without making any network or reading key/settings.
  provider.streamCompletion = async input => {
    const content = input.messages.filter(message => message.role === 'user').at(-1)?.content || '';
    calls.push(content);
    const selected = plans.get(content);
    if (selected) { selected.entered.resolve(); await waitGate(selected.gate.promise, input.signal); }
    if (input.signal?.aborted) throw new DOMException('Queue fixture stopped.', 'AbortError');
    const answer = `队列验收回复：${content}`; input.onDelta(answer); return { content: answer };
  };
  const setMode = async enabled => {
    await wait(() => !document.querySelector('[data-testid="agent-mode-toggle"]')?.disabled);
    if (await page(() => document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed') === 'true') !== enabled) await page(() => document.querySelector('[data-testid="agent-mode-toggle"]').click());
    await wait(value => (document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed') === 'true') === value, enabled);
  };
  const draft = () => page(() => document.querySelector('[data-testid="composer-input"]').value);
  const mode = () => page(() => document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed') === 'true');
  const send = async content => {
    await fill('composer-input', content);
    await wait(() => !!document.querySelector('[data-testid="send-message"]') && !document.querySelector('[data-testid="send-message"]').disabled);
    await page(() => document.querySelector('[data-testid="send-message"]').click());
  };
  const open = async chat => {
    await wait(title => [...document.querySelectorAll('.sidebar-chat-main')].some(element => element.title === title), chat.title);
    await page(title => [...document.querySelectorAll('.sidebar-chat-main')].find(element => element.title === title).click(), chat.title);
    await wait(title => document.querySelector('.content-heading h1')?.textContent === title, chat.title);
  };
  const fresh = async title => { const chat = store.createChat({ title }); chatIds.push(chat.id); operations.updateChat({ id: chat.id, title }); await open(chat); return chat; };
  const queued = (chatId, content) => wait(async input => (await window.muse.bootstrap()).pendingSends.find(item => item.chatId === input.chatId && item.content === input.content), { chatId, content });
  const rowClick = async (id, action) => page(input => {
    const row = [...document.querySelectorAll('[data-testid="pending-send"]')].find(element => element.dataset.queueId === input.id);
    if (!row) throw new Error('Queue row is missing.'); row.querySelector(`[data-testid="${input.action}"]`).click();
  }, { id, action });
  const noPending = chatId => wait(async id => !(await window.muse.bootstrap()).pendingSends.some(item => item.chatId === id), chatId);
  const finished = (chatId, count) => wait(async input => {
    const snapshot = await window.muse.bootstrap(), chat = snapshot.chats.find(item => item.id === input.chatId);
    return chat?.messages.filter(message => message.role === 'user').length === input.count && chat.messages.at(-1)?.status === 'complete' && !snapshot.pendingSends.some(item => item.chatId === input.chatId) ? chat : false;
  }, { chatId, count });
  const active = async (chat, text, enabled = false) => { const gate = plan(text); await setMode(enabled); await send(text); await bounded(gate.entered.promise); await wait(() => !!document.querySelector('[data-testid="stop-generation"]')); return gate; };
  const stop = async chatId => {
    await page(() => document.querySelector('[data-testid="stop-generation"]').click());
    await wait(async id => (await window.muse.bootstrap()).chats.find(chat => chat.id === id)?.messages.at(-1)?.status === 'cancelled', chatId);
  };

  try {
    const fifo = await fresh('队列验收 · 顺序');
    const firstText = 'QUEUE_FIFO_FIRST_61', secondText = 'QUEUE_FIFO_SECOND_61', thirdText = 'QUEUE_FIFO_THIRD_61';
    const firstGate = await active(fifo, firstText);
    await fill('composer-input', secondText);
    check('Active generation keeps a Send action for nonempty input beside Stop', await page(() => !!document.querySelector('[data-testid="stop-generation"]') && document.querySelector('[data-testid="send-message"]')?.getAttribute('aria-label') === '加入待发送'));
    await page(() => document.querySelector('[data-testid="send-message"]').click()); const secondIntent = await queued(fifo.id, secondText);
    await send(thirdText); const thirdIntent = await queued(fifo.id, thirdText);
    check('Queued UI does not append later user turns or dispatch providers before the active round completes', store.getChat(fifo.id).messages.filter(message => message.role === 'user').length === 1 && calls.filter(text => [firstText, secondText, thirdText].includes(text)).join('|') === firstText && secondIntent.state === 'queued' && thirdIntent.state === 'queued' && await page(() => document.querySelectorAll('[data-testid="pending-send"]').length === 2));
    firstGate.gate.resolve(); const completed = await finished(fifo.id, 3);
    check('Queued messages dispatch exactly once in FIFO order after the preceding completion', completed.messages.filter(message => message.role === 'user').map(message => message.content).join('|') === [firstText, secondText, thirdText].join('|') && calls.filter(text => [firstText, secondText, thirdText].includes(text)).join('|') === [firstText, secondText, thirdText].join('|'));

    const controls = await fresh('队列验收 · 恢复与停止'); await active(controls, 'QUEUE_CONTROLS_ACTIVE_61');
    await setMode(true); await send('QUEUE_RESTORE_TO_EMPTY_61'); const empty = await queued(controls.id, 'QUEUE_RESTORE_TO_EMPTY_61');
    await setMode(false); await rowClick(empty.id, 'queue-restore'); await noPending(controls.id);
    await wait(() => document.querySelector('[data-testid="composer-input"]').value === 'QUEUE_RESTORE_TO_EMPTY_61');
    check('Restoring an intent into an empty composer restores its original file-assistant mode', await mode() === true && store.getChat(controls.id).messages.filter(message => message.role === 'user').length === 1);
    await fill('composer-input', ''); await setMode(false); await send('QUEUE_CANCEL_WITHOUT_SEND_61'); const removed = await queued(controls.id, 'QUEUE_CANCEL_WITHOUT_SEND_61');
    await rowClick(removed.id, 'queue-cancel'); await noPending(controls.id);
    check('Cancel removes a waiting intent without sending it or restoring a draft', await draft() === '' && !store.getChat(controls.id).messages.some(message => message.content === 'QUEUE_CANCEL_WITHOUT_SEND_61'));
    await setMode(true); await send('QUEUE_MERGE_INTENT_61'); const merged = await queued(controls.id, 'QUEUE_MERGE_INTENT_61');
    await setMode(false); await fill('composer-input', 'QUEUE_EXISTING_DRAFT_61'); await rowClick(merged.id, 'queue-restore'); await noPending(controls.id);
    await wait(() => document.querySelector('[data-testid="composer-input"]').value.includes('QUEUE_MERGE_INTENT_61'));
    check('Restoring into an existing draft merges content while retaining its current mode', await draft() === 'QUEUE_EXISTING_DRAFT_61\n\nQUEUE_MERGE_INTENT_61' && await mode() === false);
    await fill('composer-input', ''); await send('QUEUE_STOP_PRESERVED_61'); const failed = await queued(controls.id, 'QUEUE_STOP_PRESERVED_61');
    await stop(controls.id);
    await wait(id => [...document.querySelectorAll('[data-testid="pending-send"]')].some(element => element.dataset.queueId === id && element.classList.contains('failed')), failed.id);
    check('Stop retains waiting intents as failed recoverable rows without appending them', (await page(async id => (await window.muse.bootstrap()).pendingSends.find(item => item.id === id)?.state, failed.id)) === 'failed' && !store.getChat(controls.id).messages.some(message => message.content === 'QUEUE_STOP_PRESERVED_61'));
    await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(folder, 'queue.png'), image.toPNG()));
    await rowClick(failed.id, 'queue-restore'); await noPending(controls.id);
    await wait(() => document.querySelector('[data-testid="composer-input"]').value === 'QUEUE_STOP_PRESERVED_61');
    check('A stopped failed intent remains explicitly recoverable without automatic resubmission', await draft() === 'QUEUE_STOP_PRESERVED_61' && store.getChat(controls.id).messages.filter(message => message.role === 'user').length === 1);
    await fill('composer-input', '');

    const admission = await fresh('队列验收 · 发送响应竞态'); await setMode(false);
    const admissionEntered = deferred(), admissionGate = deferred(); releases.push(admissionGate.resolve);
    operations.sendMessage = async input => { const result = await originals.send(input); admissionEntered.resolve(); await admissionGate.promise; return result; };
    try {
      await send('QUEUE_ADMISSION_SENT_61'); await bounded(admissionEntered.promise); await fill('composer-input', 'QUEUE_TYPED_DURING_SEND_61'); admissionGate.resolve();
      await finished(admission.id, 1); await wait(() => !document.querySelector('[data-testid="agent-mode-toggle"]').disabled);
      check('A delayed successful send response cannot erase text typed during admission', await draft() === 'QUEUE_TYPED_DURING_SEND_61' && store.getChat(admission.id).messages.filter(message => message.role === 'user').map(message => message.content).join('|') === 'QUEUE_ADMISSION_SENT_61');
    } finally { admissionGate.resolve(); operations.sendMessage = originals.send; }

    await fill('composer-input', '');
    const failureEntered = deferred(), failureGate = deferred(); releases.push(failureGate.resolve);
    operations.sendMessage = async () => { failureEntered.resolve(); await failureGate.promise; throw new Error('Synthetic queue admission rejection.'); };
    try {
      await send('QUEUE_NOT_ADMITTED_61'); await bounded(failureEntered.promise); await fill('composer-input', 'QUEUE_TYPED_DURING_REJECTION_61'); failureGate.resolve();
      await wait(() => document.querySelector('[data-testid="composer-input"]').value.includes('QUEUE_NOT_ADMITTED_61'));
      check('A delayed admission rejection merges the unsent submission with newer typing exactly once', await draft() === 'QUEUE_NOT_ADMITTED_61\n\nQUEUE_TYPED_DURING_REJECTION_61' && !store.getChat(admission.id).messages.some(message => message.content === 'QUEUE_NOT_ADMITTED_61'));
    } finally { failureGate.resolve(); operations.sendMessage = originals.send; }

    await page(() => document.querySelector('[data-testid="new-chat"]').click()); await wait(() => !document.querySelector('.content-heading h1')); await setMode(false);
    const createEntered = deferred(), createGate = deferred(); releases.push(createGate.resolve);
    operations.createChat = async input => { createEntered.resolve(); await createGate.promise; const result = await originals.create(input); chatIds.push(result.id); return result; };
    try {
      await send('QUEUE_PROMOTED_FIRST_61'); await bounded(createEntered.promise); await fill('composer-input', 'QUEUE_TYPED_DURING_CREATE_61'); createGate.resolve();
      const promoted = await wait(async () => (await window.muse.bootstrap()).chats.find(chat => chat.messages.some(message => message.role === 'user' && message.content === 'QUEUE_PROMOTED_FIRST_61') && chat.messages.at(-1)?.status === 'complete'));
      await wait(() => document.querySelector('[data-testid="composer-input"]').value === 'QUEUE_TYPED_DURING_CREATE_61');
      check('New-chat promotion carries typing entered while createChat is pending into the new chat draft', promoted.messages.filter(message => message.role === 'user').length === 1 && await draft() === 'QUEUE_TYPED_DURING_CREATE_61');
    } finally { createGate.resolve(); operations.createChat = originals.create; }

    const recovery = await fresh('队列验收 · 恢复响应竞态'); await active(recovery, 'QUEUE_RECOVERY_ACTIVE_61');
    const recoverWithDelay = async ({ text, intentMode, beforeMode, typed, afterMode }) => {
      await fill('composer-input', ''); await setMode(intentMode); await send(text); const intent = await queued(recovery.id, text); await setMode(beforeMode);
      const entered = deferred(), gate = deferred(); releases.push(gate.resolve);
      operations.cancelQueuedMessage = async input => { const result = await originals.cancel(input); entered.resolve(); await gate.promise; return result; };
      try {
        await rowClick(intent.id, 'queue-restore'); await bounded(entered.promise);
        if (typed) await fill('composer-input', typed); await setMode(afterMode); gate.resolve();
        await wait(value => document.querySelector('[data-testid="composer-input"]').value.includes(value), text);
        return { content: await draft(), mode: await mode() };
      } finally { gate.resolve(); operations.cancelQueuedMessage = originals.cancel; }
    };
    const latestTyping = await recoverWithDelay({ text: 'QUEUE_DELAYED_RESTORE_61', intentMode: true, beforeMode: true, typed: 'QUEUE_NEW_TYPING_DURING_RESTORE_61', afterMode: false });
    check('A delayed restore reads the latest draft and preserves a mode changed while awaiting cancellation', latestTyping.content === 'QUEUE_NEW_TYPING_DURING_RESTORE_61\n\nQUEUE_DELAYED_RESTORE_61' && latestTyping.mode === false);
    const latestMode = await recoverWithDelay({ text: 'QUEUE_MODE_ONLY_RESTORE_61', intentMode: false, beforeMode: false, typed: '', afterMode: true });
    check('An empty-draft restore cannot overwrite an explicit mode change made while its response is pending', latestMode.content === 'QUEUE_MODE_ONLY_RESTORE_61' && latestMode.mode === true);
    await fill('composer-input', ''); await stop(recovery.id); await noPending(recovery.id);
  } finally {
    operations.sendMessage = originals.send; operations.createChat = originals.create; operations.cancelQueuedMessage = originals.cancel;
    for (const chatId of chatIds) { try { operations.stopGeneration({ chatId }); } catch {} }
    releases.forEach(release => release()); provider.streamCompletion = originals.completion;
  }
};
