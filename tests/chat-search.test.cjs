'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchMessages } = require('../backend/chat-search.cjs');
const message = (id, content, second = 0) => ({ id, role: 'user', content, createdAt: new Date(1700000000000 + second * 1000).toISOString() });
const chats = [
  { id: 'chat_a', title: '第一段', workspaceId: 'ws_one', messages: [message('msg_a', '这个苹果是红色'), message('msg_b', '苹果也可以是绿色', 3)] },
  { id: 'chat_b', title: '第二段', workspaceId: null, messages: [message('msg_c', 'APPLE 苹果', 2), message('msg_d', '只有标题匹配')] },
  { id: 'chat_c', title: '苹果标题', workspaceId: 'ws_two', messages: [message('msg_e', '不相关')] }
];
test('search returns each exact matching message with its chat identity and highlight span', () => {
  const result = searchMessages(chats, { query: '苹果' });
  assert.deepEqual(result.hits.map(hit => [hit.chatId, hit.messageId]), [['chat_a', 'msg_b'], ['chat_b', 'msg_c'], ['chat_a', 'msg_a']]);
  for (const hit of result.hits) assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength), '苹果');
  assert.equal(result.nextCursor, null); assert.equal(searchMessages(chats, { query: 'apple' }).hits[0].messageId, 'msg_c');
});
test('pagination is stable for equal dates and each page remains tied to query and scope', () => {
  const sameTime = [{ ...chats[0], messages: Array.from({ length: 27 }, (_, i) => message('msg_' + String(i).padStart(2, '0'), 'match')) }];
  const ids = []; let cursor;
  do { const result = searchMessages(sameTime, { query: 'match', limit: 4, ...(cursor ? { cursor } : {}) }); ids.push(...result.hits.map(hit => hit.messageId)); cursor = result.nextCursor; } while (cursor);
  assert.equal(ids.length, 27); assert.equal(new Set(ids).size, 27); assert.equal(ids[0], 'msg_00');
  const page = searchMessages(chats, { query: '苹果', limit: 1 });
  assert.throws(() => searchMessages(chats, { query: 'APPLE', cursor: page.nextCursor }), /重新搜索/);
  assert.throws(() => searchMessages(chats, { query: '苹果', chatId: 'chat_a', cursor: page.nextCursor }), /重新搜索/);
});
test('chat, workspace and explicitly ungrouped searches keep their scope', () => {
  assert.deepEqual(searchMessages(chats, { query: '苹果', chatId: 'chat_a' }).hits.map(hit => hit.messageId), ['msg_b', 'msg_a']);
  assert.deepEqual(searchMessages(chats, { query: '苹果', workspaceId: 'ws_one' }).hits.map(hit => hit.messageId), ['msg_b', 'msg_a']);
  assert.deepEqual(searchMessages(chats, { query: '苹果', workspaceId: null }).hits.map(hit => hit.messageId), ['msg_c']);
});
test('punctuation is literal and Unicode highlight offsets refer to original text', () => {
  const data = [{ ...chats[0], messages: [message('msg_x', '🪴'.repeat(70) + ' [a+b].* Ω ' + '🪴'.repeat(80))] }];
  const hit = searchMessages(data, { query: '[a+b].* ω' }).hits[0];
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength), '[a+b].* Ω');
  assert.ok(hit.snippet.length < 180); assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(hit.snippet));
  assert.equal(searchMessages(chats, { query: '.*' }).hits.length, 0);
});
test('invalid search input and foreign cursors are rejected without returning transcript content', () => {
  for (const input of [{ query: 'x'.repeat(501) }, { query: '\0' }, { query: 'a', limit: 0 }, { query: 'a', chatId: '../../' }, { query: 'a', chatId: 'chat_a', workspaceId: null }, { query: 'a', cursor: 'not-json' }, { query: 'a', extra: true }]) assert.throws(() => searchMessages(chats, input), /搜索条件/);
  assert.deepEqual(searchMessages(chats, { query: '  ' }), { hits: [], nextCursor: null });
});
