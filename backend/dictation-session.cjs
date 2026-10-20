'use strict';

const crypto = require('node:crypto');
const { types, isDeepStrictEqual } = require('node:util');
const MAX_AUDIO_BYTES = 3840000 + 44;
const FINAL_STATES = new Set(['complete', 'cancelled', 'error']);
const REASONS = new Set(['user_cancelled', 'scope_changed', 'configuration_changed', 'timeout', 'window_destroyed', 'capture_failed', 'disposed']);
const reasonCode = value => REASONS.has(value) ? value : 'user_cancelled';
const failure = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype; }
function ownerShape(value) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['scopeKey','workspaceId','chatId'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw failure('invalid_owner', '听写所属对话无效。');
  const key = value.scopeKey, identifier = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  if (typeof key !== 'string' || !key.trim() || key.length > 500 || /[\u0000-\u001f\u007f]/.test(key) || !identifier(value.workspaceId) || !identifier(value.chatId)) throw failure('invalid_owner', '听写所属对话无效。');
  return { scopeKey: key, workspaceId: value.workspaceId, chatId: value.chatId };
}
function audioCopy(value) {
  if (!types.isArrayBuffer(value) || value.byteLength < 46 || value.byteLength > MAX_AUDIO_BYTES) throw failure('invalid_audio', '录音数据无效或超出长度限制。');
  const audio = new Uint8Array(value).slice(), view = new DataView(audio.buffer);
  const ascii = (at, length) => String.fromCharCode(...audio.subarray(at, at + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || ascii(36, 4) !== 'data' || view.getUint32(4, true) !== audio.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== audio.length - 44 || (audio.length - 44) % 2) throw failure('invalid_audio', '只接受有界的单声道 16 kHz PCM WAV 录音。');
  return audio.buffer;
}

class DictationSessionManager {
  #getProviderBinding; #validateScope; #transcribe; #onState; #timeoutMs; #now; #setTimer; #clearTimer;
  #active = null; #records = new Map(); #disposed = false;
  constructor({ getProviderBinding, validateScope, transcribe, onState, timeoutMs = 150000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if ([getProviderBinding, validateScope, transcribe, now, setTimer, clearTimer].some(value => typeof value !== 'function') || onState != null && typeof onState !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new TypeError('听写会话配置无效。');
    this.#getProviderBinding = getProviderBinding; this.#validateScope = validateScope; this.#transcribe = transcribe; this.#onState = onState; this.#timeoutMs = timeoutMs; this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
  }
  #stamp() { return new Date(this.#now()).toISOString(); }
  #public(record) { return clone(record.meta); }
  #emit(record) { if (!this.#onState) return; try { const result = this.#onState(this.#public(record)); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch { /* UI observers cannot alter authority or return private provider errors. */ } }
  #current(id) { const record = this.#records.get(id); if (!record) throw failure('unknown_session', '听写会话已失效。'); return record; }
  #end(record, state, errorCode) {
    if (FINAL_STATES.has(record.meta.state)) return this.#public(record);
    record.meta = { ...record.meta, state, updatedAt: this.#stamp(), endedAt: this.#stamp(), ...(errorCode ? { errorCode } : {}) };
    if (record.timer != null) this.#clearTimer(record.timer); record.timer = null;
    record.controller.abort(); record.binding = null;
    if (this.#active === record) this.#active = null;
    this.#emit(record);
    while (this.#records.size > 20) { const key = this.#records.keys().next().value; if (this.#records.get(key) === this.#active) break; this.#records.delete(key); }
    return this.#public(record);
  }
  #valid(record) {
    if (record !== this.#active || FINAL_STATES.has(record.meta.state)) return false;
    let current;
    try { current = this.#getProviderBinding(); if (!isDeepStrictEqual(current, record.binding.provider)) { this.#end(record, 'cancelled', 'configuration_changed'); return false; } }
    catch { this.#end(record, 'cancelled', 'configuration_changed'); return false; }
    try { if (this.#validateScope(record.binding) !== true) { this.#end(record, 'cancelled', 'scope_changed'); return false; } }
    catch { this.#end(record, 'cancelled', 'scope_changed'); return false; }
    return record === this.#active && !record.controller.signal.aborted;
  }
  start({ owner } = {}) {
    if (this.#disposed) throw failure('disposed', '听写窗口已关闭。');
    if (this.#active) throw failure('dictation_busy', '已有录音或转写正在进行，请先停止或取消。');
    const capturedOwner = ownerShape(owner), createdAt = this.#stamp(), record = { meta: { id: `dictation_${crypto.randomUUID()}`, owner: capturedOwner, state: 'preparing', createdAt, updatedAt: createdAt }, controller: new AbortController(), binding: null, timer: null };
    try { const provider = this.#getProviderBinding(); if (provider == null || typeof provider === 'function' || types.isProxy(provider)) throw new Error(); record.binding = freeze({ owner: clone(capturedOwner), provider: clone(provider) }); }
    catch { throw failure('provider_unavailable', '请先配置可用的听写服务。'); }
    this.#records.set(record.meta.id, record); this.#active = record;
    if (!this.#valid(record)) throw failure(record.meta.errorCode, '听写配置或所属对话已经变化。');
    record.timer = this.#setTimer(() => this.#end(record, 'error', 'timeout'), this.#timeoutMs);
    record.timer?.unref?.(); this.#emit(record); return this.#public(record);
  }
  allowsCapture() { const record = this.#active; return Boolean(record && ['preparing','recording'].includes(record.meta.state) && this.#valid(record)); }
  validateCurrent() { const record = this.#active; return Boolean(record && this.#valid(record)); }
  captureReady({ id } = {}) {
    const record = this.#current(id);
    if (!this.#valid(record)) return this.#public(record);
    if (record.meta.state !== 'preparing') throw failure('invalid_state', '当前会话不接受新的录音。');
    record.meta.state = 'recording'; record.meta.updatedAt = this.#stamp(); this.#emit(record); return this.#public(record);
  }
  async finish({ id, audio } = {}) {
    const record = this.#current(id);
    if (FINAL_STATES.has(record.meta.state) || !this.#valid(record)) return this.#public(record);
    if (record.meta.state !== 'recording') throw failure('invalid_state', '录音尚未就绪或已经在转写。');
    let ownedAudio;
    try { ownedAudio = audioCopy(audio); } catch (error) { this.#end(record, 'error', 'invalid_audio'); throw error; }
    record.meta.state = 'finishing'; record.meta.updatedAt = this.#stamp(); this.#emit(record);
    if (!this.#valid(record)) { new Uint8Array(ownedAudio).fill(0); return this.#public(record); }
    try {
      const binding = record.binding, signal = record.controller.signal;
      // Cancellation settles immediately even if a third-party ASR adapter
      // ignores AbortSignal. Its late result is consumed but never published.
      const cancelled = new Promise(resolve => { if (signal.aborted) resolve({ cancelled: true }); else signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }); });
      const pending = Promise.resolve().then(() => { if (signal.aborted) return { cancelled: true }; return this.#transcribe({ audio: ownedAudio, signal, binding }); }).then(value => ({ value }), () => ({ failed: true }));
      const result = await Promise.race([pending, cancelled]);
      if (result.cancelled || !this.#valid(record)) return this.#public(record);
      if (result.failed) return this.#end(record, 'error', 'transcription_failed');
      const raw = typeof result.value === 'string' ? result.value : result.value?.text;
      if (typeof raw !== 'string' || raw.length > 400000 || [...raw].length > 200000 || raw.includes('\0') || Buffer.from(raw).toString('utf8') !== raw || !raw.trim()) return this.#end(record, 'error', 'invalid_result');
      const text = raw.trim(), meta = this.#end(record, 'complete'); return { ...meta, text };
    } finally { new Uint8Array(ownedAudio).fill(0); }
  }
  cancel({ id, reason = 'user_cancelled' } = {}) { const record = id == null ? this.#active : this.#current(id); return record ? this.#end(record, 'cancelled', reasonCode(reason)) : null; }
  invalidate(reason = 'scope_changed') { return this.cancel({ reason }); }
  snapshot(id) { const record = id == null ? this.#active || [...this.#records.values()].at(-1) : this.#records.get(id); return record ? this.#public(record) : null; }
  dispose(reason = 'window_destroyed') { this.#disposed = true; return this.invalidate(reason); }
}
const createDictationSessionManager = options => new DictationSessionManager(options);
module.exports = { DictationSessionManager, createDictationSessionManager, MAX_AUDIO_BYTES };
