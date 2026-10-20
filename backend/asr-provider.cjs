'use strict';

const { types } = require('node:util');

const ASR_LIMITS = Object.freeze({
  SAMPLE_RATE: 16000,
  CHANNELS: 1,
  BITS_PER_SAMPLE: 16,
  MIN_DURATION_MS: 100,
  MAX_DURATION_MS: 120000,
  MIN_WAV_BYTES: 3244,
  MAX_WAV_BYTES: 3840044,
  MAX_RESPONSE_BYTES: 1024 * 1024,
  MAX_TEXT_CODEPOINTS: 200000,
  REQUEST_TIMEOUT_MS: 120000
});

const ORIGINAL_DOMAINS = ['meta.ai', 'metaaivm.com', 'facebook.com', 'metaaiusercontent.com', 'ecto1usercontent.com'];
const AB_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TA_LENGTH = Object.getOwnPropertyDescriptor(TA_PROTO, 'byteLength').get;
const TA_BUFFER = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;

class ASRProviderError extends Error {
  constructor(message, { code = 'input', status } = {}) {
    super(message);
    this.name = 'ASRProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function abortError() { return new DOMException('听写已取消。', 'AbortError'); }
function configuration(message) { return new ASRProviderError(message, { code: 'configuration' }); }

function normalizedParameterName(name) { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normalizeSpeechBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw configuration('请先单独配置语音识别服务的 API 地址。');
  const input = value.trim();
  if (input.length > 8192 || /[\u0000-\u001f\u007f]/u.test(input)) throw configuration('语音服务 API 地址无效。');
  let url;
  try { url = new URL(input); } catch { throw configuration('语音服务 API 地址无效，请填写完整的 HTTP/HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.includes('#') || /^[a-z]+:\/\/[^/?#]*@/i.test(input)) {
    throw configuration('语音服务地址仅支持 HTTP/HTTPS，且不能包含登录信息或 URL 片段。');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (ORIGINAL_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw configuration('请配置你自己的语音识别服务；此应用不连接原 Muse 服务。');
  }
  for (const [name] of url.searchParams) {
    const normalized = normalizedParameterName(name);
    if (/^(?:key|apikey|xapikey|subscriptionkey|ocpapimsubscriptionkey|secretkey|privatekey|accesskey|token|accesstoken|authtoken|sastoken|auth|authorization|bearer|credential|credentials|secret|clientsecret|signature|sig|password|passwd)$/.test(normalized)) {
      throw configuration('请把语音服务密钥保存在密钥设置中，不能放在 API 地址的查询参数里。');
    }
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|models)$/.test(pathname)) throw configuration('请填写语音识别服务地址，不能使用聊天或模型列表接口。');
  if (!pathname) pathname = '/v1';
  if (!pathname.endsWith('/audio/transcriptions')) pathname += '/audio/transcriptions';
  url.pathname = pathname;
  return url;
}

function wavFailure() { return new ASRProviderError('录音必须是 0.1 至 120 秒的标准 WAV：单声道、16 kHz、16 位 PCM，且不能包含额外区块或尾随数据。', { code: 'invalid_audio' }); }

function validateWavAudio(audio) {
  let length, bytes;
  try {
    if (types.isProxy(audio)) throw wavFailure();
    if (types.isArrayBuffer(audio)) {
      length = AB_LENGTH.call(audio);
      if (length < ASR_LIMITS.MIN_WAV_BYTES || length > ASR_LIMITS.MAX_WAV_BYTES) throw wavFailure();
      bytes = new Uint8Array(length);
      Uint8Array.prototype.set.call(bytes, new Uint8Array(audio));
    } else if (types.isUint8Array(audio)) {
      if (types.isSharedArrayBuffer(TA_BUFFER.call(audio))) throw wavFailure();
      length = TA_LENGTH.call(audio);
      if (length < ASR_LIMITS.MIN_WAV_BYTES || length > ASR_LIMITS.MAX_WAV_BYTES) throw wavFailure();
      bytes = new Uint8Array(length);
      Uint8Array.prototype.set.call(bytes, audio);
    } else throw wavFailure();
    const data = new DataView(bytes.buffer);
    const tag = offset => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const dataLength = data.getUint32(40, true);
    if (tag(0) !== 'RIFF' || data.getUint32(4, true) !== length - 8 || tag(8) !== 'WAVE' ||
        tag(12) !== 'fmt ' || data.getUint32(16, true) !== 16 || data.getUint16(20, true) !== 1 ||
        data.getUint16(22, true) !== ASR_LIMITS.CHANNELS || data.getUint32(24, true) !== ASR_LIMITS.SAMPLE_RATE ||
        data.getUint32(28, true) !== 32000 || data.getUint16(32, true) !== 2 ||
        data.getUint16(34, true) !== ASR_LIMITS.BITS_PER_SAMPLE || tag(36) !== 'data' ||
        dataLength !== length - 44 || dataLength % 2 !== 0) throw wavFailure();
    return { bytes, durationMs: dataLength / 32, sampleRate: ASR_LIMITS.SAMPLE_RATE, channels: ASR_LIMITS.CHANNELS, bitsPerSample: ASR_LIMITS.BITS_PER_SAMPLE };
  } catch { throw wavFailure(); }
}

function linkedSignal(external) {
  if (external?.aborted) throw abortError();
  if (external !== undefined && external !== null && !(external instanceof AbortSignal)) throw new ASRProviderError('取消信号格式无效。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ASR_LIMITS.REQUEST_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    cleanup() { clearTimeout(timer); external?.removeEventListener('abort', onAbort); }
  };
}

async function readBoundedText(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > ASR_LIMITS.MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ASRProviderError('语音服务返回的数据超过 1 MiB 限制。', { code: 'response_too_large' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '', complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > ASR_LIMITS.MAX_RESPONSE_BYTES) throw new ASRProviderError('语音服务返回的数据超过 1 MiB 限制。', { code: 'response_too_large' });
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return text;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpFailure(status) {
  const hint = status === 401 || status === 403 ? '语音服务密钥无效或没有访问权限' :
    status === 404 ? '语音识别接口不存在，请检查服务地址' :
    status === 429 ? '语音服务请求过于频繁或额度不足' :
    status >= 500 ? '语音识别服务暂时不可用' : '语音服务拒绝了请求';
  // Remote details and original causes can contain raw, JSON-escaped or URL-encoded
  // credentials. Only fixed host messages and the numeric status leave this adapter.
  return new ASRProviderError(`${hint}（HTTP ${status}）。`, { status, code: 'http_error' });
}

function urlContainsKey(url, apiKey) {
  if (!apiKey) return false;
  let text = url.href;
  for (;;) {
    if (text.includes(apiKey)) return true;
    // Keys are validated as ASCII before this check. Decode individual bytes
    // without letting an unrelated malformed percent/UTF-8 sequence suppress
    // another parameter's credential. Each successful round removes at least
    // two characters, so nested encoding has a strict input-length bound.
    const decoded = text.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded.length >= text.length) return false;
    text = decoded;
  }
}

async function transcribeAudio({ settings, apiKey = '', audio, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const url = normalizeSpeechBaseUrl(settings?.speechBaseUrl);
  if (typeof settings?.transcriptionModel !== 'string' || !settings.transcriptionModel.trim() ||
      [...settings.transcriptionModel].length > 300 || /[\u0000-\u001f\u007f]/u.test(settings.transcriptionModel)) {
    throw configuration('请先填写语音识别模型名称。');
  }
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || (apiKey && /[^\x21-\x7e]/.test(apiKey))) throw configuration('语音服务密钥格式无效。');
  if (urlContainsKey(url, apiKey) || (apiKey && settings.transcriptionModel.includes(apiKey))) throw configuration('语音服务密钥只能通过授权请求头发送。');
  const wav = validateWavAudio(audio), lifecycle = linkedSignal(signal);
  try {
    const form = new FormData();
    form.append('file', new Blob([wav.bytes], { type: 'audio/wav' }), 'voice.wav');
    form.append('model', settings.transcriptionModel.trim());
    form.append('response_format', 'json');
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { method: 'POST', headers, body: form, signal: lifecycle.signal, redirect: 'error' });
    const text = await readBoundedText(response);
    if (lifecycle.signal.aborted) throw abortError();
    if (!response.ok) throw httpFailure(response.status);
    if (/text\/html/i.test(response.headers.get('content-type') || '') || /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text)) {
      throw new ASRProviderError('语音服务返回了网页，请检查 API 地址。', { code: 'html_response' });
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new ASRProviderError('语音服务返回了无效 JSON。', { code: 'invalid_json' }); }
    if (body && typeof body === 'object' && !Array.isArray(body) && body.error !== undefined) throw new ASRProviderError('语音服务报告识别失败，请检查模型和服务设置。', { code: 'provider_error' });
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') throw new ASRProviderError('语音服务响应格式不兼容，需要 JSON text 字段。', { code: 'invalid_response' });
    let codepoints = 0;
    for (const point of body.text) {
      const value = point.codePointAt(0);
      if (++codepoints > ASR_LIMITS.MAX_TEXT_CODEPOINTS) throw new ASRProviderError('识别文字超过 200000 字限制。', { code: 'text_too_large' });
      if (value >= 0xd800 && value <= 0xdfff) throw new ASRProviderError('语音服务返回了无效的 Unicode 文字。', { code: 'invalid_response' });
    }
    if (lifecycle.signal.aborted) throw abortError();
    return { text: body.text };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (lifecycle.isTimeout()) throw new ASRProviderError('语音识别超过 120 秒仍未完成，请稍后重新录音。', { code: 'timeout' });
    if (error instanceof ASRProviderError) throw error;
    if (error?.name === 'AbortError') throw abortError();
    if (error instanceof TypeError && /encoded data/.test(error.message)) throw new ASRProviderError('语音服务返回了无效 UTF-8 数据。', { code: 'invalid_response' });
    throw new ASRProviderError('无法连接语音识别服务，请检查地址、网络和服务设置。', { code: 'network' });
  } finally { wav.bytes.fill(0); lifecycle.cleanup(); }
}

module.exports = { transcribeAudio, normalizeSpeechBaseUrl, validateWavAudio, ASR_LIMITS, ASRProviderError };
