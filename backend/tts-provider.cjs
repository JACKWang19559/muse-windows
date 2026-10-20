'use strict';

// Independently configured binary speech synthesis. This is not Muse's
// preview MP3/SSE service, and it never discovers or borrows chat credentials.
const { normalizeSpeechBaseUrl } = require('./asr-provider.cjs');

const TTS_LIMITS = Object.freeze({
  MAX_INPUT_CODEPOINTS: 4096,
  MAX_INPUT_BYTES: 16 * 1024,
  MAX_MODEL_CODEPOINTS: 300,
  MAX_VOICE_CODEPOINTS: 100,
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
  REQUEST_TIMEOUT_MS: 120000,
  MIN_SPEED: 0.25,
  MAX_SPEED: 4
});

class TTSProviderError extends Error {
  constructor(message, { code = 'input', status } = {}) {
    super(message);
    this.name = 'TTSProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const configuration = message => new TTSProviderError(message, { code: 'configuration' });
const abortError = () => new DOMException('声音试听已取消。', 'AbortError');

function normalizeSynthesisUrl(value) {
  let url;
  try { url = normalizeSpeechBaseUrl(value); }
  catch (error) { throw configuration(error.message); }
  const originalPath = new URL(value.trim()).pathname.replace(/\/+$/, '');
  // Validation above checks the original string, including an empty fragment
  // or userinfo. Only pathname changes; origin and non-auth queries survive.
  url.pathname = originalPath.endsWith('/audio/speech') ? originalPath :
    `${url.pathname.slice(0, -'/audio/transcriptions'.length)}/audio/speech`;
  return url;
}

function urlContainsKey(url, apiKey) {
  if (!apiKey) return false;
  let text = url.href;
  for (;;) {
    if (text.includes(apiKey)) return true;
    // Same tolerant, strictly length-decreasing byte decoding as ASR. Keys
    // have already passed the ASCII-only header validation.
    const decoded = text.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded.length >= text.length) return false;
    text = decoded;
  }
}

function settingName(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum * 2 ||
      [...value].length > maximum || /[\p{Cc}\p{Cf}]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw configuration(`请填写有效的${label}。`);
  }
  return value.trim();
}

function speechText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > TTS_LIMITS.MAX_INPUT_CODEPOINTS * 2 ||
      [...value].length > TTS_LIMITS.MAX_INPUT_CODEPOINTS || Buffer.byteLength(value, 'utf8') > TTS_LIMITS.MAX_INPUT_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TTSProviderError('试听文字必须为 1 至 4096 字的有效文字，且不能超过 16 KiB。');
  }
  return value;
}

function linkedSignal(external) {
  if (external?.aborted) throw abortError();
  if (external !== undefined && external !== null && !(external instanceof AbortSignal)) throw new TTSProviderError('取消信号格式无效。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TTS_LIMITS.REQUEST_TIMEOUT_MS);
  timer.unref?.();
  return { signal: controller.signal, isTimeout: () => timedOut, cleanup() { clearTimeout(timer); external?.removeEventListener('abort', onAbort); } };
}

async function cancelBody(response) { try { await response.body?.cancel(); } catch { /* No remote errors leave this adapter. */ } }
const tooLarge = () => new TTSProviderError('语音服务返回的音频超过 16 MiB 限制。', { code: 'response_too_large' });

async function readBoundedAudio(response) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > TTS_LIMITS.MAX_AUDIO_BYTES) { await cancelBody(response); throw tooLarge(); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > TTS_LIMITS.MAX_AUDIO_BYTES) throw tooLarge();
      chunks.push(new Uint8Array(item.value));
    }
    const output = new Uint8Array(bytes);
    let at = 0;
    for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
    complete = true;
    return output;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const tag = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
function wavHeader(bytes) {
  if (bytes.length < 44 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = view.getUint32(4, true);
  // Some binary streaming WAV encoders use an unknown-length RIFF/data size.
  // Bound the actual full response independently instead of trusting that size.
  if (size !== bytes.length - 8 && size !== 0xffffffff) return false;
  let at = 12, format = null, dataLength = null;
  while (at + 8 <= bytes.length) {
    const name = tag(bytes, at), declared = view.getUint32(at + 4, true), start = at + 8;
    const length = name === 'data' && declared === 0xffffffff ? bytes.length - start : declared;
    if (length > bytes.length - start) return false;
    if (name === 'fmt ') {
      if (format || length < 16) return false;
      const encoding = view.getUint16(start, true), channels = view.getUint16(start + 2, true), rate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true), align = view.getUint16(start + 12, true), bits = view.getUint16(start + 14, true);
      if (![1, 3].includes(encoding) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000 ||
          !(encoding === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) || align !== channels * bits / 8 || byteRate !== rate * align) return false;
      format = { align };
    } else if (name === 'data') {
      if (dataLength !== null) return false;
      dataLength = length;
    }
    at = start + length + (length % 2);
  }
  return at === bytes.length && format !== null && dataLength !== null && dataLength > 0 && dataLength % format.align === 0;
}

function mp3Header(bytes) {
  let at = 0;
  if (bytes.length >= 10 && tag(bytes, 0).startsWith('ID3')) {
    if (![2, 3, 4].includes(bytes[3]) || bytes[4] === 0xff || bytes.subarray(6, 10).some(value => value > 0x7f)) return false;
    const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    at = 10 + size + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
  }
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3;
  const bitrateIndex = bytes[at + 2] >> 4, rateIndex = (bytes[at + 2] >> 2) & 3, padding = (bytes[at + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return false;
  const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
  const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / rate) + padding;
  return frameLength >= 4 && at + frameLength <= bytes.length;
}

function httpFailure(status) {
  const hint = status === 401 || status === 403 ? '语音服务密钥无效或没有访问权限' : status === 404 ? '声音合成接口不存在，请检查服务地址' :
    status === 429 ? '语音服务请求过于频繁或额度不足' : status >= 500 ? '声音合成服务暂时不可用' : '语音服务拒绝了请求';
  return new TTSProviderError(`${hint}（HTTP ${status}）。`, { code: 'http_error', status });
}

async function synthesizeSpeech({ settings, apiKey = '', text, responseFormat = 'wav', speed = 1, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const url = normalizeSynthesisUrl(settings?.speechBaseUrl), input = speechText(text);
  const model = settingName(settings?.synthesisModel, TTS_LIMITS.MAX_MODEL_CODEPOINTS, '声音合成模型名称');
  const voice = settingName(settings?.synthesisVoice, TTS_LIMITS.MAX_VOICE_CODEPOINTS, '声音名称');
  if (!['wav', 'mp3'].includes(responseFormat)) throw configuration('声音试听只支持 WAV 或 MP3 格式。');
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < TTS_LIMITS.MIN_SPEED || speed > TTS_LIMITS.MAX_SPEED) throw configuration('语速必须在 0.25 至 4 之间。');
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || (apiKey && /[^\x21-\x7e]/.test(apiKey))) throw configuration('语音服务密钥格式无效。');
  if (urlContainsKey(url, apiKey) || apiKey && [input, model, voice].some(value => value.includes(apiKey))) throw configuration('语音服务密钥只能通过授权请求头发送。');
  const lifecycle = linkedSignal(signal);
  let bytes, transferred = false;
  try {
    const mimeType = responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const headers = { 'Content-Type': 'application/json', Accept: `${mimeType}, application/octet-stream` };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ input, model, voice, response_format: responseFormat, speed, stream_format: 'audio' }), signal: lifecycle.signal, redirect: 'error' });
    if (!response.ok) { await cancelBody(response); throw httpFailure(response.status); }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const acceptedTypes = responseFormat === 'wav' ? ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'] : ['audio/mpeg', 'audio/mp3'];
    if (type && type !== 'application/octet-stream' && !acceptedTypes.includes(type)) {
      await cancelBody(response); throw new TTSProviderError('语音服务未返回所需的二进制音频，请检查声音合成接口与格式。', { code: 'invalid_response' });
    }
    bytes = await readBoundedAudio(response);
    if (lifecycle.signal.aborted) throw abortError();
    if (!(responseFormat === 'wav' ? wavHeader(bytes) : mp3Header(bytes))) throw new TTSProviderError('语音服务返回的音频格式无效或不完整。', { code: 'invalid_audio' });
    transferred = true;
    // Header checks are not a full codec decode; the player must handle its
    // actual browser decode/play errors and own the returned bytes' lifetime.
    return { audio: bytes.buffer, mimeType, format: responseFormat };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (lifecycle.isTimeout()) throw new TTSProviderError('声音合成超过 120 秒仍未完成，请稍后重试。', { code: 'timeout' });
    if (error instanceof TTSProviderError) throw error;
    if (error?.name === 'AbortError') throw abortError();
    // No provider body, request URL, original exception or cause is exposed.
    throw new TTSProviderError('无法连接声音合成服务，请检查地址、网络和服务设置。', { code: 'network' });
  } finally { if (bytes && !transferred) bytes.fill(0); lifecycle.cleanup(); }
}

module.exports = { synthesizeSpeech, normalizeSynthesisUrl, TTS_LIMITS, TTSProviderError };
