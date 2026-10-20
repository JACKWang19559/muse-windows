// App-owned microphone capture. No network, filesystem or provider secret.
const TARGET_RATE = 16000, MAX_DURATION_MS = 120000, MAX_PCM_BYTES = 3840000;
const captureError = (code, message = '无法完成录音，请检查麦克风权限后重试。') => Object.assign(new Error(message), { code });
const abortError = () => Object.assign(new Error('录音已取消。'), { name: 'AbortError', code: 'cancelled' });
const notify = (callback, value) => { try { const result = callback?.(value); if (result?.catch) result.catch(() => {}); } catch { /* Observers do not own microphone lifecycle. */ } };
function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch {} } }
function wav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), bytes = new Uint8Array(buffer), view = new DataView(buffer), word = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index); };
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, samples[index], true); return buffer;
}
class DictationCapture {
  #getUserMedia; #AudioContext; #onLevel; #onLimit; #onError; #setTimer; #clearTimer;
  #maxDurationMs; #maxPcmBytes; #maxSamples; #state = 'idle'; #generation = 0; #stream = null; #trackListeners = []; #context = null; #source = null; #processor = null; #gain = null; #timer = null; #cleanup = Promise.resolve(); #stopPromise = null;
  #sampleRate = null; #inputCount = 0; #nextPosition = 0; #lastSample = 0; #chunks = []; #samples = 0; #finalDurationMs = 0; #limited = false;
  constructor({ getUserMedia = constraints => globalThis.navigator.mediaDevices.getUserMedia(constraints), AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext, onLevel, onLimit, onError, maxDurationMs = MAX_DURATION_MS, maxPcmBytes = MAX_PCM_BYTES, targetSampleRate = TARGET_RATE, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args) } = {}) {
    if (typeof getUserMedia !== 'function' || typeof AudioContext !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function' || targetSampleRate !== TARGET_RATE || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > MAX_DURATION_MS || !Number.isSafeInteger(maxPcmBytes) || maxPcmBytes < 2 || maxPcmBytes > MAX_PCM_BYTES || maxPcmBytes % 2) throw captureError('invalid_configuration');
    this.#getUserMedia = getUserMedia; this.#AudioContext = AudioContext; this.#onLevel = onLevel; this.#onLimit = onLimit; this.#onError = onError; this.#setTimer = setTimer; this.#clearTimer = clearTimer; this.#maxDurationMs = maxDurationMs; this.#maxPcmBytes = maxPcmBytes; this.#maxSamples = Math.min(Math.floor(maxDurationMs * TARGET_RATE / 1000), maxPcmBytes / 2);
  }
  get state() { return this.#state; }
  get durationMs() { return this.#state === 'stopped' ? this.#finalDurationMs : this.#samples / TARGET_RATE * 1000; }
  #release() {
    if (this.#timer != null) this.#clearTimer(this.#timer); this.#timer = null;
    for (const [track, listener] of this.#trackListeners) { try { track.removeEventListener?.('ended', listener); } catch {} } this.#trackListeners = [];
    if (this.#processor) this.#processor.onaudioprocess = null;
    for (const node of [this.#source, this.#processor, this.#gain]) { try { node?.disconnect(); } catch {} }
    this.#source = this.#processor = this.#gain = null; stopTracks(this.#stream); this.#stream = null;
    const context = this.#context; this.#context = null;
    let closed; try { closed = context?.close?.(); } catch { closed = null; }
    this.#cleanup = Promise.allSettled([this.#cleanup, Promise.resolve(closed)]).then(() => {}); return this.#cleanup;
  }
  #streamFailed() {
    if (!['preparing','recording'].includes(this.#state)) return;
    this.#state = 'error'; this.#generation++; this.#discard(); this.#release(); notify(this.#onError, { code: 'capture_failed' });
  }
  #watchTracks(stream) {
    const tracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
    if (!tracks.length || tracks.some(track => track.readyState === 'ended')) throw captureError('capture_failed');
    for (const track of tracks) {
      const listener = () => this.#streamFailed();
      this.#trackListeners.push([track, listener]); track.addEventListener?.('ended', listener, { once: true });
    }
  }
  #limit(reason) {
    if (this.#limited || this.#state !== 'recording') return;
    this.#limited = true; this.#state = 'limited'; const generation = this.#generation, event = { reason, durationMs: this.durationMs, pcmBytes: this.#samples * 2 };
    this.#release().then(() => { if (generation === this.#generation && this.#state === 'limited') notify(this.#onLimit, event); });
  }
  #process(event) {
    if (this.#state !== 'recording') return;
    try {
      const input = event.inputBuffer, size = input.length, rate = input.sampleRate || this.#context?.sampleRate, channels = input.numberOfChannels || 1;
      if (!Number.isSafeInteger(size) || size < 0 || size > 65536 || !Number.isFinite(rate) || rate < 8000 || rate > 384000 || !Number.isSafeInteger(channels) || channels < 1 || channels > 32 || this.#sampleRate !== null && this.#sampleRate !== rate) throw captureError('invalid_audio_stream');
      if (!size) return; this.#sampleRate = rate;
      const mono = new Float32Array(size); let sum = 0;
      for (let channel = 0; channel < channels; channel++) { const data = input.getChannelData(channel); if (data.length !== size) throw captureError('invalid_audio_stream'); for (let index = 0; index < size; index++) mono[index] += (Number.isFinite(data[index]) ? Math.max(-1, Math.min(1, data[index])) : 0) / channels; }
      for (const value of mono) sum += value * value;
      const start = this.#inputCount, end = start + size - 1, output = [], step = rate / TARGET_RATE;
      while (this.#nextPosition <= end && this.#samples + output.length < this.#maxSamples) {
        const index = Math.floor(this.#nextPosition), fraction = this.#nextPosition - index;
        if (fraction > 0 && index + 1 > end) break;
        const left = index === start - 1 ? this.#lastSample : mono[index - start], right = fraction === 0 ? left : mono[index + 1 - start];
        const value = Math.max(-1, Math.min(1, left + (right - left) * fraction)); output.push(Math.round(value < 0 ? value * 32768 : value * 32767)); this.#nextPosition += step;
      }
      this.#inputCount += size; this.#lastSample = mono[size - 1];
      if (output.length) { this.#chunks.push(Int16Array.from(output)); this.#samples += output.length; }
      notify(this.#onLevel, { rms: Math.sqrt(sum / size), durationMs: this.durationMs });
      if (this.#samples >= this.#maxSamples) this.#limit(this.#maxPcmBytes / 2 <= this.#maxDurationMs * TARGET_RATE / 1000 ? 'bytes' : 'duration');
    } catch { this.#streamFailed(); }
  }
  #discard() { for (const chunk of this.#chunks) chunk.fill(0); this.#chunks = []; this.#samples = 0; }
  async start() {
    if (this.#state !== 'idle') throw captureError('invalid_state', '请为每次录音创建新的采集会话。');
    this.#state = 'preparing'; const generation = ++this.#generation;
    try {
      const stream = await this.#getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== this.#generation || this.#state !== 'preparing') { stopTracks(stream); throw abortError(); }
      this.#stream = stream; this.#watchTracks(stream); const context = new this.#AudioContext({ latencyHint: 'interactive' }); this.#context = context;
      this.#source = context.createMediaStreamSource(stream); this.#processor = context.createScriptProcessor(4096, 1, 1); this.#gain = context.createGain(); this.#gain.gain.value = 0;
      this.#processor.onaudioprocess = event => this.#process(event); this.#source.connect(this.#processor); this.#processor.connect(this.#gain); this.#gain.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      if (generation !== this.#generation || this.#state !== 'preparing') throw abortError();
      this.#state = 'recording'; this.#timer = this.#setTimer(() => this.#limit('duration'), this.#maxDurationMs); this.#timer?.unref?.();
    } catch (error) {
      if (generation !== this.#generation && this.#state === 'error') { await this.#release(); throw captureError('capture_failed'); }
      if (generation !== this.#generation || this.#state === 'cancelled') { await this.#release(); throw abortError(); }
      this.#state = 'error'; this.#discard(); await this.#release();
      const code = ['NotAllowedError','SecurityError'].includes(error?.name) ? 'microphone_denied' : error?.name === 'NotFoundError' ? 'microphone_missing' : 'capture_failed'; notify(this.#onError, { code }); throw captureError(code);
    }
  }
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (!['recording','limited'].includes(this.#state)) return Promise.reject(this.#state === 'cancelled' ? abortError() : captureError('invalid_state', '录音尚未就绪。'));
    this.#state = 'stopping'; const generation = this.#generation;
    this.#stopPromise = (async () => {
      await this.#release(); if (generation !== this.#generation || this.#state === 'cancelled') throw abortError();
      const expected = Math.min(this.#maxSamples, this.#sampleRate === null ? 0 : Math.floor(this.#inputCount * TARGET_RATE / this.#sampleRate)), data = new Int16Array(expected); let offset = 0;
      for (const chunk of this.#chunks) { const count = Math.min(chunk.length, expected - offset); if (count > 0) { data.set(chunk.subarray(0, count), offset); offset += count; } }
      if (offset < expected) { const value = this.#lastSample; data.fill(Math.round(value < 0 ? value * 32768 : value * 32767), offset); }
      const result = wav(data); this.#finalDurationMs = expected / TARGET_RATE * 1000; data.fill(0); this.#discard(); this.#state = 'stopped'; return result;
    })(); return this.#stopPromise;
  }
  async cancel() { if (this.#state === 'cancelled') return this.#cleanup; this.#generation++; this.#state = 'cancelled'; this.#discard(); await this.#release(); }
}
export const createDictationCapture = options => new DictationCapture(options);
export { DictationCapture, TARGET_RATE, MAX_DURATION_MS, MAX_PCM_BYTES };
