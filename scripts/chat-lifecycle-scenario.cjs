'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Called only by the existing isolated desktop test. No credentials are read;
// the provider wrapper below observes message context, never its other options.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !samePath(app.getPath('userData'), path.join(folder, 'data')) || !samePath(store.dataDir, path.join(folder, 'data'))) throw new Error('Chat lifecycle verification requires the isolated desktop fixture profile.');

  const query = 'LIFECYCLE_SEARCH_CEDAR_61';
  const targetToken = 'LIFECYCLE_QUOTE_TARGET_61';
  const delayedQuery = 'LIFECYCLE_OLD_PENDING_61';
  const replyText = 'LIFECYCLE_QUOTED_REPLY_61 请解释这段资料。';
  const titleA = '聊天语义验收 A', titleB = '聊天语义验收 B';
  const created = await store.createTextFile({ name: 'lifecycle-receipt.md', content: 'Synthetic committed file receipt fixture.' });
  const receiptTrace = [{ content: '已创建验收资料', calls: [{ id: 'lifecycle_committed_write', name: 'workspace_create_text_file', arguments: JSON.stringify({ name: created.file.name, content: 'Synthetic committed file receipt fixture.' }), status: 'complete', result: JSON.stringify({ ok: true, result: { file: created.file } }) }] }];
  const first = store.createChat({ title: titleA }), second = store.createChat({ title: titleB });
  const idsA = [], idsB = [];
  let target, retainedAssistant;
  for (let index = 0; index < 25; index++) {
    const user = store.appendMessage(first.id, { role: 'user', content: `${query} · A${String(index).padStart(2, '0')} ${index === 0 ? targetToken : index === 7 ? delayedQuery : '独立分页命中'}`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index * 2)).toISOString(), ...(index === 0 ? { attachmentIds: [created.file.id] } : {}) });
    idsA.push(user.id); if (index === 0) target = user;
    const assistant = store.appendMessage(first.id, { role: 'assistant', content: `A${index}：保留这条助手回复。\n\n这是合成的桌面验收资料，用来验证较长对话中的精确定位。\n\n回复与已经完成的文件操作不能被用户消息删除静默截断。`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index * 2 + 1)).toISOString(), ...(index === 0 ? { agentMode: true, toolTrace: receiptTrace } : {}) });
    if (index === 0) retainedAssistant = assistant;
  }
  for (let index = 0; index < 7; index++) idsB.push(store.appendMessage(second.id, { role: 'user', content: `${query} · B${index} 跨对话范围验收`, createdAt: new Date(Date.UTC(2024, 0, 2, 0, 0, index)).toISOString() }).id);
  operations.updateChat({ id: second.id, title: titleB }); operations.updateChat({ id: first.id, title: titleA });

  const openChat = async title => {
    await wait(name => [...document.querySelectorAll('.sidebar-chat-main')].some(button => button.title === name), title);
    await page(name => [...document.querySelectorAll('.sidebar-chat-main')].find(button => button.title === name).click(), title);
    await wait(name => document.querySelector('.content-heading h1')?.textContent === name, title);
  };
  const openSearch = async () => { await page(() => document.querySelector('[data-testid="search-open"]').click()); await wait(() => !!document.querySelector('[data-testid="search-input"]')); };
  const searchSettled = count => wait(value => document.querySelector('.search-results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-testid="search-message-hit"]').length === value, count);
  const closeSearch = async () => { await page(() => document.querySelector('[data-testid="search-dialog"] [aria-label="关闭"]').click()); await wait(() => !document.querySelector('[data-testid="search-dialog"]')); };
  const messageVisible = id => wait(value => {
    const message = [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === value), scroll = document.querySelector('[data-testid="chat-messages"]');
    if (!message || !scroll || !message.classList.contains('message-search-target')) return false;
    const box = message.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    return box.bottom > viewport.top && box.top < viewport.bottom;
  }, id);
  const key = async input => page(value => {
    const element = document.querySelector('[data-testid="composer-input"]'); element.focus();
    const caret = value.edge === 'end' ? element.value.length : 0; element.setSelectionRange(caret, caret);
    const event = new KeyboardEvent('keydown', { key: value.key, bubbles: true, cancelable: true, ...(value.options || {}) }); element.dispatchEvent(event);
    return { value: element.value, prevented: event.defaultPrevented };
  }, input);

  await openChat(titleA); await openSearch(); await fill('search-input', query); await searchSettled(20);
  check('Message search renders twenty first-page hits with marked exact matches', await page(() => document.querySelectorAll('[data-testid="search-message-hit"] mark').length === 20 && !!document.querySelector('[data-testid="search-more"]')));
  const initialIds = await page(() => [...document.querySelectorAll('[data-testid="search-message-hit"]')].map(element => element.dataset.messageId));
  await page(() => document.querySelector('[data-testid="search-more"]').click()); await searchSettled(32);
  const allIds = await page(() => [...document.querySelectorAll('[data-testid="search-message-hit"]')].map(element => element.dataset.messageId));
  check('Load more appends all thirty-two cross-chat hits without duplicate identities', new Set(allIds).size === 32 && initialIds.every(id => allIds.includes(id)) && idsA.every(id => allIds.includes(id)) && idsB.every(id => allIds.includes(id)) && await page(() => !document.querySelector('[data-testid="search-more"]')));
  await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(folder, 'chat-search.png'), image.toPNG()));
  await page(() => document.querySelector('[data-testid="search-current-chat"]').click()); await searchSettled(20);
  await page(() => document.querySelector('[data-testid="search-more"]').click()); await searchSettled(25);
  check('Current-chat search scope excludes every other-chat hit across pagination', await page(allowed => [...document.querySelectorAll('[data-testid="search-message-hit"]')].every(element => allowed.includes(element.dataset.messageId)) && document.querySelector('[data-testid="search-current-chat"]').getAttribute('aria-pressed') === 'true', idsA));

  // Exercise a real out-of-order IPC response rather than merely typing two
  // queries before the debounce. The old result resolves after the new one.
  const originalSearch = operations.searchMessages;
  let releaseOld, signalStarted, signalFinished;
  const oldGate = new Promise(resolve => { releaseOld = resolve; }), oldStarted = new Promise(resolve => { signalStarted = resolve; }), oldFinished = new Promise(resolve => { signalFinished = resolve; });
  operations.searchMessages = async input => {
    if (input.query !== delayedQuery) return originalSearch(input);
    signalStarted(); await oldGate;
    try { return await originalSearch(input); } finally { signalFinished(); }
  };
  try {
    await fill('search-input', delayedQuery);
    let timer;
    try { await Promise.race([oldStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Delayed search request was not dispatched.')), 5000); })]); }
    finally { clearTimeout(timer); }
    check('Changing a query clears obsolete message rows before the next response', await page(() => document.querySelectorAll('[data-testid="search-message-hit"]').length === 0));
    await fill('search-input', targetToken); await searchSettled(1); releaseOld(); await oldFinished;
    await page(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('A late old-query IPC response cannot replace the current exact-message result', await page(input => {
      const hits = [...document.querySelectorAll('[data-testid="search-message-hit"]')];
      return document.querySelector('[data-testid="search-input"]').value === input.token && hits.length === 1 && hits[0].dataset.messageId === input.id && hits[0].querySelector('mark')?.textContent === input.token;
    }, { token: targetToken, id: target.id }));
  } finally { releaseOld(); operations.searchMessages = originalSearch; }

  await page(id => [...document.querySelectorAll('[data-testid="search-message-hit"]')].find(element => element.dataset.messageId === id).click(), target.id);
  await wait(() => !document.querySelector('[data-testid="search-dialog"]')); await messageVisible(target.id);
  check('Selecting a message result scrolls to its precise message id and highlights matching text', await page(input => {
    const selected = document.querySelector('.message-search-target');
    return selected?.dataset.messageId === input.id && selected.querySelector('mark')?.textContent === input.token;
  }, { id: target.id, token: targetToken }));

  await fill('composer-input', '保留引用旁边的草稿');
  await page(id => [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id).querySelector('[data-testid="quote-message"]').click(), target.id);
  await wait(token => document.querySelector('[data-testid="composer-quote"]')?.textContent.includes(token), targetToken);
  check('Quote button opens a dismissible composer preview of the selected target', await page(() => document.querySelector('[data-testid="composer-input"]').value === '保留引用旁边的草稿' && !!document.querySelector('[data-testid="composer-quote"] [aria-label="取消引用"]')));
  await page(() => document.querySelector('[data-testid="composer-quote"] [aria-label="取消引用"]').click()); await wait(() => !document.querySelector('[data-testid="composer-quote"]'));
  check('Dismissing a composer quote preserves the unsent draft and all stored messages', await page(() => document.querySelector('[data-testid="composer-input"]').value === '保留引用旁边的草稿') && store.getChat(first.id).messages.length === 50);

  await page(id => [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id).querySelector('[data-testid="quote-message"]').click(), target.id);
  await wait(() => !!document.querySelector('[data-testid="composer-quote"]')); await fill('composer-input', replyText);
  if (await page(() => document.querySelector('[data-testid="agent-mode-toggle"]').getAttribute('aria-pressed') === 'true')) await page(() => document.querySelector('[data-testid="agent-mode-toggle"]').click());
  await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(folder, 'chat-quote.png'), image.toPNG()));
  const provider = require('../backend/provider.cjs'), originalCompletion = provider.streamCompletion, contexts = [];
  provider.streamCompletion = async options => { contexts.push(JSON.parse(JSON.stringify(options.messages))); return originalCompletion(options); };
  let quotedChat;
  try {
    await page(() => document.querySelector('[data-testid="send-message"]').click());
    quotedChat = await wait(async id => { const chat = (await window.muse.bootstrap()).chats.find(item => item.id === id); return chat?.messages.length === 52 && chat.messages.at(-1).status === 'complete' ? chat : false; }, first.id);
  } finally { provider.streamCompletion = originalCompletion; }
  const quotedUser = quotedChat.messages.at(-2);
  check('Sending a quoted reply stores the stable target id, role and bounded excerpt', quotedUser.content === replyText && quotedUser.replyTo?.messageId === target.id && quotedUser.replyTo.role === 'user' && quotedUser.replyTo.excerpt.includes(targetToken));
  check('The real provider call receives explicit quoted reference context before the new question', contexts.some(history => history.some(message => message.role === 'user' && message.content.includes('引用的历史消息') && message.content.includes(targetToken) && message.content.includes(replyText))));
  check('Successful quoted send clears the composer quote', await page(() => !document.querySelector('[data-testid="composer-quote"]') && document.querySelector('[data-testid="composer-input"]').value === ''));

  await openChat(titleA);
  await page(id => [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id).querySelector('[data-testid="message-quote"]').click(), quotedUser.id);
  await messageVisible(target.id);
  check('Clicking a saved inline quote navigates to its original message id', await page(id => document.querySelector('.message-search-target')?.dataset.messageId === id, target.id));
  await page(() => { const scroll = document.querySelector('[data-testid="chat-messages"]'); scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); });
  await wait(() => { const scroll = document.querySelector('[data-testid="chat-messages"]'); return scroll.scrollTop > scroll.clientHeight; });
  await page(id => [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id).querySelector('[data-testid="message-quote"]').click(), quotedUser.id);
  await messageVisible(target.id);
  check('Clicking the same inline quote again repositions its target after manually scrolling away', await page(id => {
    const target = document.querySelector('.message-search-target'), scroll = document.querySelector('[data-testid="chat-messages"]');
    const box = target?.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    return target?.dataset.messageId === id && box.bottom > viewport.top && box.top < viewport.bottom;
  }, target.id));
  const beforeDeletion = store.getChat(first.id);
  await page(id => [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id).querySelector('[data-testid="delete-turn"]').click(), target.id);
  await wait(() => !!document.querySelector('[data-testid="confirm-delete"]'));
  check('User message deletion requires confirmation and explains retained replies and receipts', await page(() => document.querySelector('.confirm-modal')?.textContent.includes('其他回复和已经完成的文件操作记录会保留')));
  await page(() => document.querySelector('[data-testid="confirm-delete"]').click());
  const afterDeletion = await wait(async input => { const chat = (await window.muse.bootstrap()).chats.find(item => item.id === input.chatId); return chat?.messages.find(message => message.id === input.messageId)?.isDeleted ? chat : false; }, { chatId: first.id, messageId: target.id });
  await wait(id => !![...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id)?.querySelector('[data-testid="deleted-message"]'), target.id);
  const deleted = afterDeletion.messages.find(message => message.id === target.id), scrubbedQuote = afterDeletion.messages.find(message => message.id === quotedUser.id);
  check('Confirmed deletion leaves an identity-preserving tombstone and clears quote excerpt and attachments', deleted.content === '' && !deleted.attachmentIds && !deleted.replyTo && scrubbedQuote.replyTo.messageId === target.id && scrubbedQuote.replyTo.excerpt === '' && afterDeletion.messages.map(message => message.id).join(',') === beforeDeletion.messages.map(message => message.id).join(','));
  check('Deleting a user message retains every other reply and the completed file-operation receipt', afterDeletion.messages.filter(message => message.id !== target.id && message.id !== quotedUser.id).every(message => JSON.stringify(message) === JSON.stringify(beforeDeletion.messages.find(previous => previous.id === message.id))) && JSON.stringify(afterDeletion.messages.find(message => message.id === retainedAssistant.id).toolTrace) === JSON.stringify(receiptTrace) && store.getFile(created.file.id).id === created.file.id);
  check('Inline quote displays the deleted-target label without resurrecting its text', await page(id => {
    const quote = [...document.querySelectorAll('.chat-messages > [data-message-id]')].find(element => element.dataset.messageId === id)?.querySelector('[data-testid="message-quote"]');
    return quote?.textContent.includes('已删除的消息') && !quote.textContent.includes('LIFECYCLE_QUOTE_TARGET_61');
  }, quotedUser.id));
  await openSearch(); await fill('search-input', targetToken); await searchSettled(0);
  check('Deleted message text is absent from actual message search and future exported quote snapshots', await page(() => document.querySelector('.search-empty')?.textContent.includes('没有找到相关内容')) && !JSON.stringify(store.exportData()).includes(targetToken));
  await closeSearch();

  const originalDraft = 'LIFECYCLE_UNSENT_DRAFT_61 保留原草稿', storedBeforeRecall = JSON.stringify(store.getChat(first.id).messages);
  await fill('composer-input', originalDraft); await key({ key: 'ArrowUp' }); await wait(expected => document.querySelector('[data-testid="composer-input"]').value === expected, replyText);
  check('ArrowUp recalls the latest eligible user text into the composer', await page(expected => document.querySelector('[data-testid="composer-input"]').value === expected, replyText));
  await key({ key: 'ArrowDown', edge: 'end' }); await wait(expected => document.querySelector('[data-testid="composer-input"]').value === expected, originalDraft);
  check('ArrowDown restores the original unsent draft without editing canonical messages', JSON.stringify(store.getChat(first.id).messages) === storedBeforeRecall);
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
    await fill('composer-input', originalDraft); const unchanged = await key({ key: 'ArrowUp', options });
    if (unchanged.value !== originalDraft || unchanged.prevented) throw new Error('Modified or IME ArrowUp unexpectedly recalled message history.');
  }
  check('Modifier and native IME key events do not trigger history recall', true);
  await page(() => { const element = document.querySelector('[data-testid="composer-input"]'); element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '拼' })); });
  const ime = await key({ key: 'ArrowUp' });
  await page(() => document.querySelector('[data-testid="composer-input"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  check('An active composition session preserves the draft and canonical history', ime.value === originalDraft && !ime.prevented && JSON.stringify(store.getChat(first.id).messages) === storedBeforeRecall);
  await fill('composer-input', '');
};
