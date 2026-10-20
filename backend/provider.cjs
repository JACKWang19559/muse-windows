'use strict';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 20000;
const COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;

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

async function streamCompletion({ settings, apiKey = '', messages, signal, onDelta = () => {} }) {
  const url = configuredUrl(settings, 'completion');
  if (typeof settings.model !== 'string' || !settings.model.trim()) throw new ProviderError('请先在设置中选择或填写模型名称。', { code: 'configuration' });
  if (!Array.isArray(messages) || !messages.length || messages.some(message => !message || !['system', 'user', 'assistant', 'tool'].includes(message.role))) throw new ProviderError('对话内容格式无效。', { code: 'input' });
  const lifecycle = linkedSignal(signal, COMPLETION_TIMEOUT_MS);
  let content = '', usage;
  const append = text => { if (signal?.aborted) throw abortError(); if (text) { content += text; onDelta(text); } };
  try {
    const response = await fetch(url, { method: 'POST', headers: headers(apiKey, true), body: JSON.stringify({ model: settings.model.trim(), messages, temperature: Number.isFinite(settings.temperature) ? settings.temperature : 0.7, stream: true }), signal: lifecycle.signal, redirect: 'error' });
    if (!response.ok) throw await httpFailure(response, apiKey);
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) throw new ProviderError('服务返回了网页，请将 API 地址改为兼容的模型接口。', { code: 'html_response' });
    const acceptJson = text => {
      let body;
      try { body = JSON.parse(text); } catch { throw new ProviderError('模型服务返回了无法解析的 JSON 数据。', { code: 'invalid_json' }); }
      if (body?.error) throw new ProviderError(`模型服务错误：${cleanError(body.error.message || body.error, apiKey)}`, { code: 'provider_error' });
      const answer = extractText(body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text);
      if (!answer) throw new ProviderError('模型服务返回了空内容或不兼容的响应格式。', { code: 'empty_response' });
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
        append(extractText(chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.text));
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
      } else if (!content) throw new ProviderError('模型服务已结束响应，但没有返回文字。', { code: 'empty_response' });
    }
    if (signal?.aborted) throw abortError();
    return { content, ...(usage ? { usage } : {}) };
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
