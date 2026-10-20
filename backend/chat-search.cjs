'use strict';

const crypto = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const fail = () => { throw new Error('搜索条件或分页位置无效，请重新搜索。'); };
const compare = (a, b) => b.time - a.time || a.chatId.localeCompare(b.chatId, 'en') || a.messageId.localeCompare(b.messageId, 'en');

// The original client searches server transcript sequence numbers. This local
// implementation searches saved message identities and uses a stable tuple.
function searchMessages(chats, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'chatId', 'workspaceId', 'limit', 'cursor'].includes(key))) fail();
  if (typeof input.query !== 'string' || input.query.length > 500 || input.query.includes('\0')) fail();
  const query = input.query.trim(), limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail();
  if (input.chatId != null && (typeof input.chatId !== 'string' || !ID.test(input.chatId))) fail();
  if (Object.hasOwn(input, 'workspaceId') && input.workspaceId !== null && (typeof input.workspaceId !== 'string' || !ID.test(input.workspaceId))) fail();
  if (input.chatId != null && Object.hasOwn(input, 'workspaceId')) fail();
  const scope = input.chatId != null ? ['chat', input.chatId] : Object.hasOwn(input, 'workspaceId') ? ['workspace', input.workspaceId] : ['all'];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([query, scope])).digest('hex').slice(0, 24);
  let after = null;
  if (input.cursor != null) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) fail();
    let value; try { value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { fail(); }
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== fingerprint || !Number.isSafeInteger(value[1]) || typeof value[2] !== 'string' || !ID.test(value[2]) || typeof value[3] !== 'string' || !ID.test(value[3]) || value[4] !== 1) fail();
    after = { time: value[1], chatId: value[2], messageId: value[3] };
  }
  if (!query) return { hits: [], nextCursor: null };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const candidates = [];
  for (const chat of chats) {
    if (scope[0] === 'chat' && chat.id !== scope[1] || scope[0] === 'workspace' && chat.workspaceId !== scope[1]) continue;
    for (const message of chat.messages) {
      if (message.isDeleted) continue;
      const tuple = { time: Date.parse(message.createdAt), chatId: chat.id, messageId: message.id };
      if (after && compare(tuple, after) <= 0) continue;
      const match = pattern.exec(message.content);
      if (!match) continue;
      // Keep exact offsets in original text, including Unicode and punctuation.
      let start = Math.max(0, match.index - 55), end = Math.min(message.content.length, match.index + match[0].length + 95);
      if (/[\uDC00-\uDFFF]/.test(message.content[start] || '')) start--;
      if (/[\uD800-\uDBFF]/.test(message.content[end - 1] || '')) end++;
      const prefix = start ? '…' : '';
      candidates.push({ ...tuple, title: chat.title, role: message.role, workspaceId: chat.workspaceId, createdAt: message.createdAt, snippet: prefix + message.content.slice(start, end) + (end < message.content.length ? '…' : ''), matchStart: prefix.length + match.index - start, matchLength: match[0].length });
      candidates.sort(compare);
      if (candidates.length > limit + 1) candidates.pop();
    }
  }
  const hasMore = candidates.length > limit;
  const hits = candidates.slice(0, limit), last = hits.at(-1);
  const nextCursor = hasMore ? Buffer.from(JSON.stringify([fingerprint, last.time, last.chatId, last.messageId, 1])).toString('base64url') : null;
  return { hits: hits.map(({ time, ...hit }) => hit), nextCursor };
}

module.exports = { searchMessages };
