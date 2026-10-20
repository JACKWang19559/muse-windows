'use strict';

const { types } = require('node:util');
const { normalizeToolTrace, traceHistory, MAX_TRACE_BYTES, MAX_TRACE_ROUNDS, MAX_TRACE_CALLS } = require('./tool-trace.cjs');

const MAX_ARGUMENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 2000000;
const FINAL_STATES = new Set(['complete', 'denied', 'error', 'cancelled']);
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const abortError = () => new DOMException('操作已取消，尚未执行的工具不会自动恢复。', 'AbortError');
const failure = (code, message) => Object.assign(new Error(message), { code });
const regexpEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function secretFilter(apiKey) {
  const secret = typeof apiKey === 'string' ? apiKey : '';
  const replacement = secret && '[已隐藏密钥]'.includes(secret) ? '***' : '[已隐藏密钥]';
  const encodings = secret.split('').map(character => {
    const forms = [{ text: character, hex: false }, { text: `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`, hex: true }];
    const short = { '"': '"', '\\': '\\', '/': '/', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't' }[character];
    if (short !== undefined) forms.push({ text: `\\${short}`, hex: false });
    return forms;
  });
  // Recognize both literal credentials and JSON escaped spellings, including
  // mixed literal/escaped strings. This also catches escaped file contents.
  const pattern = secret ? new RegExp(secret.split('').map(character => {
    const hex = character.charCodeAt(0).toString(16).padStart(4, '0').replace(/[a-f]/g, letter => `[${letter}${letter.toUpperCase()}]`);
    const alternatives = [regexpEscape(character), `\\\\u${hex}`];
    const short = { '"': '"', '\\': '\\', '/': '/', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't' }[character];
    if (short !== undefined) alternatives.push(regexpEscape(`\\${short}`));
    return `(?:${alternatives.join('|')})`;
  }).join(''), 'g') : null;
  const contains = value => { if (!pattern || typeof value !== 'string') return false; pattern.lastIndex = 0; return pattern.test(value); };
  const text = value => { const source = String(value ?? '').replace(/\0/g, '\uFFFD'); if (!pattern) return source; pattern.lastIndex = 0; return source.replace(pattern, replacement); };
  const possiblePrefix = suffix => {
    let offsets = new Set([0]);
    for (const forms of encodings) {
      const next = new Set();
      for (const offset of offsets) for (const form of forms) {
        const part = suffix.slice(offset, offset + form.text.length), expected = form.text.slice(0, part.length);
        if ((form.hex ? part.toLowerCase() === expected.toLowerCase() : part === expected)) {
          if (offset + part.length === suffix.length) return true;
          if (part.length === form.text.length) next.add(offset + part.length);
        }
      }
      if (!next.size) return false;
      offsets = next;
    }
    return false;
  };
  const partial = value => {
    const source = text(value);
    if (!secret) return source;
    let end = source.length;
    // A stopped stream may finish with a literal key prefix or half of a JSON
    // escape. Discard only that ambiguous suffix; ordinary short text survives.
    const escape = /(?:\\u[0-9a-fA-F]{0,3}|\\)$/.exec(source);
    if (escape) end = escape.index;
    for (let start = Math.max(0, source.length - secret.length * 6); start < end; start++) if ((source[start] === secret[0] || source[start] === '\\') && possiblePrefix(source.slice(start))) { end = start; break; }
    return source.slice(0, end);
  };
  return { contains, text, partial, holdback: secret.length * 6 };
}

function safeJson(value, filter, budget = { nodes: 50000 }, depth = 0, seen = new Set()) {
  if (depth > 40 || --budget.nodes < 0) throw failure('invalid_tool_result', '工具结果格式无效或过于复杂。');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return filter.text(value);
  if ((!plain(value) && !Array.isArray(value)) || types.isProxy(value) || seen.has(value)) throw failure('invalid_tool_result', '工具结果必须是有效的 JSON 数据。');
  seen.add(value);
  const output = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure('invalid_tool_result', '工具结果必须是普通的 JSON 数据。');
    if (descriptor.value !== undefined) output[filter.text(key)] = safeJson(descriptor.value, filter, budget, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function prefix(value, length = 8000) {
  let result = value.slice(0, length);
  if (/[\uD800-\uDBFF]/.test(result.at(-1) || '')) result = result.slice(0, -1);
  return result;
}

function fileMetadata(value) {
  if (!plain(value)) return undefined;
  const result = {};
  for (const key of ['id', 'name', 'mime', 'size', 'workspaceId', 'textStatus', 'sha256', 'editable', 'createdAt']) {
    const field = value[key];
    if (typeof field === 'string') result[key] = prefix(field, 1000);
    else if (field === null || typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field)) result[key] = field;
  }
  return result;
}

function resultReceipt(value, filter) {
  let safe;
  try {
    if (!plain(value) || typeof value.ok !== 'boolean') throw new Error();
    safe = safeJson(value, filter);
    // Runtime transport/observer fields are never part of model history.
    safe = { ok: safe.ok, ...(safe.result !== undefined ? { result: safe.result } : {}), ...(safe.error !== undefined ? { error: safe.error } : {}) };
  } catch {
    // A committed write receipt stays successful even if its optional result
    // data is not serializable. Never turn a successful write into a retry.
    safe = plain(value) && Object.getOwnPropertyDescriptor(value, 'ok')?.value === true ? { ok: true, result: { truncated: true, unavailable: true } } : { ok: false, error: { code: 'invalid_tool_result', message: '工具没有返回有效的执行结果。' } };
  }
  let serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES) return { value: safe, serialized };
  const result = safe.result;
  const compact = { ok: safe.ok, truncated: true };
  if (safe.error !== undefined) compact.error = plain(safe.error) ? { code: prefix(String(safe.error.code || 'tool_failed'), 100), message: prefix(String(safe.error.message || '工具操作未完成。'), 1000) } : prefix(String(safe.error), 1000);
  const retained = { truncated: true };
  if (typeof result === 'string') retained.text = prefix(result);
  else if (plain(result)) {
    Object.assign(retained, fileMetadata(result));
    if (plain(result.file)) retained.file = fileMetadata(result.file);
    if (Array.isArray(result.files)) { retained.files = result.files.slice(0, 16).map(fileMetadata).filter(Boolean); retained.totalFiles = result.files.length; }
    for (const key of ['text', 'content']) if (typeof result[key] === 'string') retained[key] = prefix(result[key]);
    if (plain(result.preview)) retained.preview = { ...fileMetadata(result.preview), ...(typeof result.preview.text === 'string' ? { text: prefix(result.preview.text) } : {}), truncated: true };
  }
  compact.result = retained;
  serialized = JSON.stringify(compact);
  // Even adversarially large file names/lists must leave valid bounded JSON.
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) { delete retained.files; delete retained.text; delete retained.content; if (retained.preview) delete retained.preview.text; serialized = JSON.stringify(compact); }
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) serialized = JSON.stringify({ ok: safe.ok, truncated: true, result: { truncated: true, ...(retained.file ? { file: retained.file } : {}) } });
  return { value: JSON.parse(serialized), serialized };
}

function responseCalls(value, filter) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TRACE_CALLS) throw failure('invalid_tool_calls', '模型返回的工具调用格式无效或数量过多。');
  return value.map(call => {
    const fn = call?.function;
    if (!plain(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id.length || call.id.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(call.id) || !plain(fn) || typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name) || typeof fn.arguments !== 'string' || fn.arguments.length > 256000 || fn.arguments.includes('\0') || filter.contains(call.id) || filter.contains(fn.name)) throw failure('invalid_tool_calls', '模型返回的工具调用格式无效或不完整。');
    const sensitive = filter.contains(fn.arguments);
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: sensitive ? '{}' : fn.arguments }, sensitive, argumentBytes: Buffer.byteLength(fn.arguments) };
  });
}

function safeFailure(error, filter) {
  if (error?.name === 'AbortError') return abortError();
  const message = filter.text(typeof error?.message === 'string' ? error.message : '模型或工具操作未完成。').slice(0, 1000);
  const safe = new Error(message || '模型或工具操作未完成。');
  if (typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.code) && !filter.contains(error.code)) safe.code = error.code;
  return safe;
}

function addUsage(total, source) {
  if (!plain(source)) return;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) if (Number.isSafeInteger(source[key]) && source[key] >= 0) total[key] = Math.min(Number.MAX_SAFE_INTEGER, (total[key] || 0) + source[key]);
  for (const key of ['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']) if (plain(source[key])) {
    for (const field of ['cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens', 'text_tokens', 'image_tokens']) if (Number.isSafeInteger(source[key][field]) && source[key][field] >= 0) { total[key] ||= {}; total[key][field] = Math.min(Number.MAX_SAFE_INTEGER, (total[key][field] || 0) + source[key][field]); }
  }
}

async function runAgentConversation({ provider, settings, apiKey = '', messages, runtime, signal, onText = () => {}, onTrace = () => {} }) {
  const filter = secretFilter(apiKey);
  if (!provider || typeof provider.streamCompletion !== 'function' || !Array.isArray(messages) || !messages.length) throw failure('input', '对话需要有效的模型接口和消息。');
  let history;
  try { history = safeJson(messages, filter); } catch { throw failure('input', '历史消息格式无效或过于复杂。'); }
  let content = '', toolTrace = [], version = 0, totalCalls = 0, argumentBytes = 0, releasePending;
  const usage = {}, seenIds = new Set();
  for (const message of history) for (const call of message?.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : []) if (typeof call?.id === 'string') seenIds.add(call.id);
  let callbackQueue = Promise.resolve(), callbackError;
  const queueText = payload => {
    const snapshot = { delta: filter.text(payload.delta), content: filter.text(payload.content) };
    callbackQueue = callbackQueue.then(async () => { if (!callbackError) { try { await onText(snapshot); } catch (error) { callbackError = safeFailure(error, filter); } } });
  };
  const flushText = async () => { await callbackQueue; if (callbackError) throw callbackError; };
  const emitTrace = async (cleanup = false) => { if (cleanup) await callbackQueue; else await flushText(); const trace = normalizeToolTrace(toolTrace); await onTrace({ trace, content: filter.text(content) }); };
  const checkAbort = () => { if (signal?.aborted) throw abortError(); };
  const stopUnfinished = cancelled => {
    for (const round of toolTrace) for (const call of round.calls) if (!FINAL_STATES.has(call.status)) {
      call.status = cancelled ? 'cancelled' : 'error';
      call.result = JSON.stringify({ ok: false, error: { code: cancelled ? 'cancelled' : 'agent_stopped', message: cancelled ? '操作已取消，此工具未继续执行，也不会自动恢复。' : '对话已停止，此工具没有继续执行。' } });
    }
  };
  try {
    checkAbort();
    let tools;
    if (runtime) {
      if (typeof runtime.getTools !== 'function' || typeof runtime.execute !== 'function') throw failure('runtime', '工具执行环境不可用。');
      tools = await runtime.getTools();
      if (!Array.isArray(tools)) throw failure('runtime', '工具执行环境没有提供有效声明。');
    }
    for (;;) {
      checkAbort(); content = ''; queueText({ delta: '', content }); await flushText();
      const token = ++version;
      let active = true, pending = '';
      const publish = (text, final = false) => {
        pending = filter.text(pending + text);
        const count = final ? pending.length : Math.max(0, pending.length - filter.holdback);
        if (count) { const delta = pending.slice(0, count); pending = pending.slice(count); content += delta; if (content.length > MAX_CONTENT_CHARS) throw failure('content_budget', '模型文字超出本次对话的容量限制。'); queueText({ delta, content }); }
      };
      releasePending = () => {
        const delta = filter.partial(pending); pending = '';
        if (delta && content.length + delta.length <= MAX_CONTENT_CHARS) { content += delta; queueText({ delta, content }); }
      };
      let response;
      try {
        response = await provider.streamCompletion({ settings, apiKey, messages: history, ...(tools?.length ? { tools, toolChoice: 'auto' } : {}), signal, onDelta: delta => { if (active && version === token && !signal?.aborted && typeof delta === 'string') publish(delta); } });
      } finally { active = false; }
      checkAbort(); publish('', true); releasePending = undefined; await flushText();
      const finalText = filter.text(typeof response?.content === 'string' ? response.content : content);
      if (finalText.length > MAX_CONTENT_CHARS) throw failure('content_budget', '模型文字超出本次对话的容量限制。');
      if (finalText !== content) { content = finalText; queueText({ delta: '', content }); await flushText(); }
      addUsage(usage, response?.usage);
      const calls = responseCalls(response?.toolCalls, filter);
      if (!calls.length) {
        if (!content) throw failure('empty_response', '模型没有返回文字或工具调用。');
        checkAbort(); return { content, toolTrace: normalizeToolTrace(toolTrace), ...(Object.keys(usage).length ? { usage } : {}) };
      }
      if (!runtime) throw failure('tools_unavailable', '当前对话没有启用工具，无法执行模型提出的操作。');
      if (response?.finishReason != null && !['tool_calls', 'stop'].includes(response.finishReason)) throw failure('incomplete_tool_calls', '模型工具响应被截断或未完整结束，本次没有执行这些操作。');
      const ids = new Set();
      for (const call of calls) { if (seenIds.has(call.id) || ids.has(call.id)) throw failure('duplicate_tool_call', '模型重复使用了工具调用标识，本次没有执行这些操作。'); ids.add(call.id); }
      const newArgumentBytes = calls.reduce((sum, call) => sum + call.argumentBytes, 0);
      if (toolTrace.length >= MAX_TRACE_ROUNDS || totalCalls + calls.length > MAX_TRACE_CALLS || argumentBytes + newArgumentBytes > MAX_ARGUMENT_BYTES) throw failure('tool_budget', '本次工具操作已达到轮数、调用数量或参数容量限制，请重新发起对话。');
      const round = { content, calls: calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'pending' })) };
      const prospective = [...toolTrace, round];
      // Reserve worst-case JSON string escaping for every upcoming receipt so
      // even a committed write can always be represented in a valid trace.
      if (Buffer.byteLength(JSON.stringify(prospective)) + calls.length * (MAX_RESULT_BYTES * 2 + 256) > MAX_TRACE_BYTES) throw failure('tool_budget', '本次工具记录已达到容量限制，请重新发起对话。');
      normalizeToolTrace(prospective);
      toolTrace = prospective; totalCalls += calls.length; argumentBytes += newArgumentBytes; ids.forEach(id => seenIds.add(id));
      content = ''; queueText({ delta: '', content }); await emitTrace();
      for (let index = 0; index < calls.length; index++) {
        checkAbort();
        const call = calls[index], trace = round.calls[index];
        let receipt;
        if (call.sensitive) receipt = { ok: false, error: { code: 'sensitive_arguments', message: '此操作包含受保护的信息，未执行。' } };
        else {
          trace.status = 'running'; await emitTrace(); checkAbort();
          try { receipt = await runtime.execute({ id: call.id, type: 'function', function: { ...call.function } }); }
          catch (error) { if (error?.name === 'AbortError' || signal?.aborted) throw abortError(); receipt = { ok: false, error: { code: 'tool_failed', message: '工具操作未完成，请检查资料状态后重试。' } }; }
        }
        const result = resultReceipt(receipt, filter);
        trace.status = result.value.ok ? 'complete' : result.value.error?.code === 'denied' ? 'denied' : result.value.error?.code === 'cancelled' ? 'cancelled' : 'error';
        trace.result = result.serialized;
        // execute may resolve after committing a write and observing abort.
        // Its successful receipt must be persisted before cancellation wins.
        await emitTrace(); checkAbort();
      }
      history.push(...traceHistory([round]));
    }
  } catch (error) {
    ++version;
    const cancelled = signal?.aborted || error?.name === 'AbortError';
    try { releasePending?.(); stopUnfinished(cancelled); await emitTrace(true); await flushText(); } catch (persistenceError) { if (!cancelled) throw safeFailure(persistenceError, filter); }
    throw cancelled ? abortError() : safeFailure(error, filter);
  }
}

module.exports = { runAgentConversation };
