'use strict';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 20000;
const COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_ARGUMENT_CHARS = 256000;
const MAX_TOOL_DECLARATIONS = 64;
const MAX_TOOL_DECLARATION_CHARS = 256000;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

class ProviderError extends Error {
  constructor(message, { status, code, cause } = {}) { super(message, { cause }); this.name = 'ProviderError'; this.status = status; this.code = code; }
}

function abortError() { return new DOMException('请求已取消。', 'AbortError'); }
function configuredUrl(settings, operation) {
  if (!settings || typeof settings.baseUrl !== 'string' || !settings.baseUrl.trim()) throw new ProviderError('请先在设置中填写模型服务的 API 地址。', { code: 'configuration' });
  let url;
  try { url = new URL(settings.baseUrl.trim()); } catch { throw new ProviderError('API 地址无效，请填写完整的 http:// 或 https:// 地址。', { code: 'configuration' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ProviderError('API 地址仅支持 HTTP/HTTPS，且不能包含登录信息或 URL 片段。', { code: 'configuration' });
  const hostname = url.hostname.toLowerCase();
  if (['meta.ai', 'metaaivm.com', 'facebook.com', 'metaaiusercontent.com', 'ecto1usercontent.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) throw new ProviderError('请配置你自己的模型服务；此应用不连接原 Muse 服务。', { code: 'configuration' });
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) pathname = pathname.slice(0, -'/chat/completions'.length);
  else if (pathname.endsWith('/models')) pathname = pathname.slice(0, -'/models'.length);
  if (!pathname) pathname = '/v1';
  url.pathname = `${pathname}/${operation === 'models' ? 'models' : 'chat/completions'}`;
  return url;
}

function cleanError(text, apiKey) {
  let result = String(text || '未知错误').replace(/[\u0000-\u001f]/g, ' ');
  if (apiKey) result = result.split(apiKey).join('[已隐藏密钥]');
  return result.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏密钥]').slice(0, 700);
}

function headers(apiKey, streaming = false) {
  const output = { 'Content-Type': 'application/json', Accept: streaming ? 'text/event-stream, application/json' : 'application/json' };
  if (apiKey) output.Authorization = `Bearer ${apiKey}`;
  return output;
}

function linkedSignal(signal, timeout) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const listener = () => controller.abort();
  signal?.addEventListener('abort', listener, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  timer.unref?.();
  return { signal: controller.signal, isTimeout: () => timedOut, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', listener); } };
}

async function readBoundedText(response, limit = MAX_RESPONSE_BYTES) {
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let result = '', bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new ProviderError('服务返回的数据过大。', { code: 'response_too_large' });
    result += decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

function looksHtml(text, contentType) { return /text\/html/i.test(contentType || '') || /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text); }

async function httpFailure(response, apiKey) {
  let text = '';
  try { text = await readBoundedText(response, 65536); } catch {}
  const status = response.status;
  if (looksHtml(text, response.headers.get('content-type'))) return new ProviderError(`API 返回了网页（HTTP ${status}），请检查地址是否指向兼容的模型 API，而不是网站登录页。`, { status, code: 'html_response' });
  let detail;
  try { const body = JSON.parse(text); detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message || body.detail; } catch {}
  const hint = status === 401 || status === 403 ? '密钥无效或没有访问权限' : status === 404 ? '接口不存在，请检查 API 地址' : status === 429 ? '请求过于频繁或服务额度不足' : status >= 500 ? '模型服务暂时不可用' : '模型服务拒绝了请求';
  return new ProviderError(`${hint}（HTTP ${status}）${detail ? `：${cleanError(typeof detail === 'string' ? detail : JSON.stringify(detail), apiKey)}` : ''}`, { status, code: 'http_error' });
}

function normalizeFailure(error, lifecycle, externalSignal, apiKey) {
  if (externalSignal?.aborted) return abortError();
  if (lifecycle?.isTimeout()) return new ProviderError('模型服务响应超时，请检查地址或稍后重试。', { code: 'timeout' });
  if (error?.name === 'AbortError') return abortError();
  if (error instanceof ProviderError) return error;
  return new ProviderError(`无法连接模型服务：${cleanError(error?.cause?.message || error?.message, apiKey)}。请检查网络和 API 地址。`, { code: 'network', cause: error });
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '').join('');
  return '';
}

function toolFailure(code = 'invalid_tool_calls') { return new ProviderError(code === 'input' ? '工具声明或工具对话格式无效，或超出大小限制。' : '模型服务返回的工具调用格式无效、不完整，或超出大小限制。', { code }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validCallId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value); }

// Copy only JSON schema data, with bounds before serialization and without invoking toJSON.
function copySchema(value, budget, depth = 0) {
  if (depth > 32 || --budget.nodes < 0) throw toolFailure('input');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') { budget.chars -= value.length; if (budget.chars < 0) throw toolFailure('input'); return value; }
  if (Array.isArray(value)) return value.map(item => copySchema(item, budget, depth + 1));
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw toolFailure('input');
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) { budget.chars -= key.length; if (budget.chars < 0) throw toolFailure('input'); output[key] = copySchema(item, budget, depth + 1); }
  return output;
}

function requestTools(tools, toolChoice) {
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > MAX_TOOL_DECLARATIONS)) throw toolFailure('input');
  const names = new Set(), budget = { nodes: 20000, chars: MAX_TOOL_DECLARATION_CHARS };
  const declarations = (tools || []).map(tool => {
    const fn = tool?.function;
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(fn) || typeof fn.name !== 'string' || !FUNCTION_NAME.test(fn.name) || names.has(fn.name)) throw toolFailure('input');
    names.add(fn.name);
    const definition = { name: fn.name };
    if (fn.description !== undefined) { if (typeof fn.description !== 'string' || fn.description.length > 16000) throw toolFailure('input'); definition.description = fn.description; }
    if (fn.parameters !== undefined) { if (!isRecord(fn.parameters)) throw toolFailure('input'); definition.parameters = copySchema(fn.parameters, budget); }
    if (fn.strict !== undefined) { if (typeof fn.strict !== 'boolean') throw toolFailure('input'); definition.strict = fn.strict; }
    return { type: 'function', function: definition };
  });
  if (JSON.stringify(declarations).length > MAX_TOOL_DECLARATION_CHARS) throw toolFailure('input');
  let choice;
  if (toolChoice !== undefined) {
    if (typeof toolChoice === 'string' && ['none', 'auto', 'required'].includes(toolChoice)) choice = toolChoice;
    else if (isRecord(toolChoice) && toolChoice.type === 'function' && isRecord(toolChoice.function) && names.has(toolChoice.function.name)) choice = { type: 'function', function: { name: toolChoice.function.name } };
    else throw toolFailure('input');
    if (!declarations.length && choice !== 'none') throw toolFailure('input');
  }
  return { ...(declarations.length ? { tools: declarations } : {}), ...(choice !== undefined ? { tool_choice: choice } : {}) };
}

function completeToolCalls(value, code = 'invalid_tool_calls') {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) throw toolFailure(code);
  const ids = new Set();
  return value.map(call => {
    const fn = call?.function;
    if (!isRecord(call) || call.type !== 'function' || !validCallId(call.id) || ids.has(call.id) || !isRecord(fn) || typeof fn.name !== 'string' || !FUNCTION_NAME.test(fn.name) || typeof fn.arguments !== 'string' || fn.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw toolFailure(code);
    ids.add(call.id);
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });
}

function requestMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.some(message => !isRecord(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role))) throw new ProviderError('对话内容格式无效。', { code: 'input' });
  return messages.map(message => {
    const output = { role: message.role };
    if (message.content !== undefined) output.content = message.content;
    if (message.name !== undefined) { if (typeof message.name !== 'string' || !FUNCTION_NAME.test(message.name)) throw toolFailure('input'); output.name = message.name; }
    if (message.role === 'tool') { if (!validCallId(message.tool_call_id) || typeof message.content !== 'string') throw toolFailure('input'); output.tool_call_id = message.tool_call_id; }
    if (message.role === 'assistant' && message.tool_calls !== undefined) { output.tool_calls = completeToolCalls(message.tool_calls, 'input'); if (output.content === undefined) output.content = null; }
    return output;
  });
}

class ToolCallAccumulator {
  constructor() { this.calls = new Map(); }
  add(value) {
    if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) throw toolFailure();
    const indices = new Set();
    for (const delta of value) {
      if (!isRecord(delta) || !Number.isSafeInteger(delta.index) || delta.index < 0 || delta.index >= MAX_TOOL_CALLS || indices.has(delta.index)) throw toolFailure();
      indices.add(delta.index);
      if (delta.type !== undefined && delta.type !== 'function') throw toolFailure();
      let call = this.calls.get(delta.index);
      if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' }, hasArguments: false }; this.calls.set(delta.index, call); }
      if (delta.id !== undefined) { if (typeof delta.id !== 'string' || delta.id.length + call.id.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(delta.id)) throw toolFailure(); call.id += delta.id; }
      if (delta.function !== undefined) {
        if (!isRecord(delta.function)) throw toolFailure();
        const fn = delta.function;
        if (fn.name !== undefined) { if (typeof fn.name !== 'string' || fn.name.length + call.function.name.length > 64 || /[^A-Za-z0-9_-]/.test(fn.name)) throw toolFailure(); call.function.name += fn.name; }
        if (fn.arguments !== undefined) { if (typeof fn.arguments !== 'string' || fn.arguments.length + call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw toolFailure(); call.function.arguments += fn.arguments; call.hasArguments = true; }
      }
    }
  }
  finish() {
    const entries = [...this.calls.entries()].sort(([left], [right]) => left - right);
    if (entries.some(([index, call], position) => index !== position || !call.hasArguments)) throw toolFailure();
    return completeToolCalls(entries.map(([, call]) => call));
  }
}

function responseFinishReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new ProviderError('模型服务返回了无效的结束原因。', { code: 'invalid_response' });
  return value;
}

class SSEParser {
  constructor(onData) { this.onData = onData; this.buffer = ''; this.data = []; this.event = ''; this.events = 0; }
  emit() {
    if (this.data.length) { this.events++; this.onData(this.data.join('\n'), this.event); }
    this.data = []; this.event = '';
  }
  line(line) {
    if (line === '') { this.emit(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') this.data.push(value);
    else if (name === 'event') this.event = value;
  }
  feed(text, final = false) {
    this.buffer += text;
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const width = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + width);
      this.line(line);
    }
    if (final) { if (this.buffer) this.line(this.buffer); this.buffer = ''; this.emit(); }
  }
}

async function streamCompletion({ settings, apiKey = '', messages, tools, toolChoice, signal, onDelta = () => {} }) {
  const url = configuredUrl(settings, 'completion');
  if (typeof settings.model !== 'string' || !settings.model.trim()) throw new ProviderError('请先在设置中选择或填写模型名称。', { code: 'configuration' });
  const apiMessages = requestMessages(messages), toolOptions = requestTools(tools, toolChoice);
  const lifecycle = linkedSignal(signal, COMPLETION_TIMEOUT_MS);
  let content = '', usage, finishReason = null, toolCalls = [];
  const toolStream = new ToolCallAccumulator();
  const append = text => { if (signal?.aborted) throw abortError(); if (text) { content += text; onDelta(text); } };
  try {
    const response = await fetch(url, { method: 'POST', headers: headers(apiKey, true), body: JSON.stringify({ model: settings.model.trim(), messages: apiMessages, temperature: Number.isFinite(settings.temperature) ? settings.temperature : 0.7, stream: true, ...toolOptions }), signal: lifecycle.signal, redirect: 'error' });
    if (!response.ok) throw await httpFailure(response, apiKey);
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) throw new ProviderError('服务返回了网页，请将 API 地址改为兼容的模型接口。', { code: 'html_response' });
    const acceptJson = text => {
      let body;
      try { body = JSON.parse(text); } catch { throw new ProviderError('模型服务返回了无法解析的 JSON 数据。', { code: 'invalid_json' }); }
      if (body?.error) throw new ProviderError(`模型服务错误：${cleanError(body.error.message || body.error, apiKey)}`, { code: 'provider_error' });
      const choice = body?.choices?.[0];
      const answer = extractText(choice?.message?.content ?? choice?.text);
      if (choice?.message?.tool_calls !== undefined && choice.message.tool_calls !== null) toolCalls = completeToolCalls(choice.message.tool_calls);
      finishReason = responseFinishReason(choice?.finish_reason);
      if (!answer && !toolCalls.length) throw new ProviderError('模型服务返回了空内容或不兼容的响应格式。', { code: 'empty_response' });
      append(answer); usage = body.usage;
    };
    if (/application\/(?:[^;]+\+)?json\b/i.test(contentType)) {
      acceptJson(await readBoundedText(response));
    } else {
      let done = false, bytes = 0, raw = '';
      const parser = new SSEParser((data, event) => {
        if (done) return;
        if (!data.trim()) return;
        if (data.trim() === '[DONE]') { done = true; return; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new ProviderError('模型服务的流式响应包含无效 JSON。', { code: 'invalid_stream' }); }
        if (event === 'error' || chunk.error) throw new ProviderError(`模型服务错误：${cleanError(chunk.error?.message || chunk.error || chunk.message || '流式生成失败', apiKey)}`, { code: 'provider_error' });
        usage = chunk.usage || usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = responseFinishReason(choice.finish_reason);
        if (choice?.delta?.tool_calls !== undefined && choice.delta.tool_calls !== null) toolStream.add(choice.delta.tool_calls);
        append(extractText(choice?.delta?.content ?? choice?.text));
      });
      const decoder = new TextDecoder();
      if (response.body) for await (const chunk of response.body) {
        if (signal?.aborted) throw abortError();
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new ProviderError('服务返回的数据过大。', { code: 'response_too_large' });
        const text = decoder.decode(chunk, { stream: true });
        raw += text;
        parser.feed(text);
        if (done) break;
      }
      const tail = decoder.decode(); raw += tail; parser.feed(tail, true);
      if (parser.events === 0) {
        if (looksHtml(raw, contentType)) throw new ProviderError('服务返回了网页，请检查模型 API 地址。', { code: 'html_response' });
        acceptJson(raw);
      } else {
        toolCalls = toolStream.finish();
        if (!content && !toolCalls.length) throw new ProviderError('模型服务已结束响应，但没有返回文字或工具调用。', { code: 'empty_response' });
      }
    }
    if (signal?.aborted) throw abortError();
    return { content, ...(usage ? { usage } : {}), toolCalls, finishReason };
  } catch (error) { throw normalizeFailure(error, lifecycle, signal, apiKey); }
  finally { lifecycle.cleanup(); }
}

async function listModels({ settings, apiKey = '', signal }) {
  const url = configuredUrl(settings, 'models');
  const lifecycle = linkedSignal(signal, MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: headers(apiKey), signal: lifecycle.signal, redirect: 'error' });
    if (!response.ok) throw await httpFailure(response, apiKey);
    const text = await readBoundedText(response, 2 * 1024 * 1024);
    if (looksHtml(text, response.headers.get('content-type'))) throw new ProviderError('模型列表接口返回了网页，请检查 API 地址。', { code: 'html_response' });
    let body;
    try { body = JSON.parse(text); } catch { throw new ProviderError('模型列表接口返回了无效 JSON。', { code: 'invalid_json' }); }
    const items = Array.isArray(body) ? body : body.data || body.models;
    if (!Array.isArray(items)) throw new ProviderError('模型列表响应格式不兼容；可在设置中手动填写模型名称。', { code: 'models_format' });
    return [...new Set(items.map(item => typeof item === 'string' ? item : item?.id || item?.name || item?.model).filter(item => typeof item === 'string' && item.length > 0 && item.length <= 300))].sort();
  } catch (error) { throw normalizeFailure(error, lifecycle, signal, apiKey); }
  finally { lifecycle.cleanup(); }
}

async function testConnection(options) {
  try { const models = await listModels(options); return { ok: true, message: models.length ? `连接成功，发现 ${models.length} 个模型。` : '连接成功，服务尚未列出模型；可以手动填写名称。', models }; }
  catch (error) { if (error.name === 'AbortError') throw error; return { ok: false, message: error.message }; }
}

module.exports = { streamCompletion, listModels, testConnection, ProviderError, configuredUrl, SSEParser };
