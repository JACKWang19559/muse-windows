'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const captureModule = import('../renderer/dictation-capture.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
async function fixture(options = {}) {
  const { DictationCapture } = await captureModule, calls = [], contexts = [], listeners = new Set(), tracks = [{ stopped: 0, readyState: options.ended ? 'ended' : 'live', addEventListener(type, listener) { assert.equal(type, 'ended'); listeners.add(listener); }, removeEventListener(type, listener) { assert.equal(type, 'ended'); listeners.delete(listener); }, end() { this.readyState = 'ended'; for (const listener of [...listeners]) listener(); }, stop() { this.stopped++; calls.push('track.stop'); this.end(); } }], stream = { getTracks: () => tracks }, timers = new Map(); let serial = 0;
  const node = name => ({ name, connections: [], disconnected: false, connect(other) { this.connections.push(other); }, disconnect() { this.disconnected = true; calls.push(`${name}.disconnect`); } });
  class AudioContext {
    constructor() { this.sampleRate = options.rate || 48000; this.state = options.suspended ? 'suspended' : 'running'; this.destination = {}; contexts.push(this); }
    createMediaStreamSource(value) { assert.equal(value, stream); return this.source = node('source'); }
    createScriptProcessor(size, inputs, outputs) { assert.deepEqual([size,inputs,outputs], [4096,1,1]); return this.processor = node('processor'); }
    createGain() { this.gain = node('gain'); this.gain.gain = { value: 1 }; return this.gain; }
    resume() { calls.push('context.resume'); return options.resume?.promise || Promise.resolve(); }
    close() { calls.push('context.close'); this.state = 'closed'; return options.close?.promise || Promise.resolve(); }
  }
  const levels = [], limits = [], errors = [], capture = new DictationCapture({ AudioContext, getUserMedia: constraints => { calls.push({ constraints }); return options.permission?.promise || Promise.resolve(stream); }, onLevel: value => levels.push(value), onLimit: value => { assert.ok(tracks.every(track => track.stopped)); limits.push(value); }, onError: value => errors.push(value), setTimer: callback => { timers.set(++serial, callback); return serial; }, clearTimer: id => timers.delete(id), ...options.config });
  return { capture, calls, contexts, tracks, stream, timers, levels, limits, errors, listeners, emit(channels, rate = options.rate || 48000) { const processor = contexts.at(-1).processor; processor.onaudioprocess?.({ inputBuffer: { length: channels[0].length, sampleRate: rate, numberOfChannels: channels.length, getChannelData: channel => channels[channel] } }); } };
}
function parse(buffer) { const view = new DataView(buffer); return { rate: view.getUint32(24, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true), bytes: view.getUint32(40, true), frames: (buffer.byteLength - 44) / 2, samples: Array.from({ length: (buffer.byteLength - 44) / 2 }, (_, index) => view.getInt16(44 + index * 2, true)), riff: String.fromCharCode(...new Uint8Array(buffer, 0, 4)) }; }

test('capture is explicit and audio-only, mono 48k resamples to canonical PCM16k WAV', async () => {
  const f = await fixture(); assert.equal(f.calls.length, 0); assert.equal(f.capture.state, 'idle'); await f.capture.start();
  assert.equal(f.calls[0].constraints.video, false); assert.equal(f.calls[0].constraints.audio.channelCount, 1); assert.equal(f.contexts[0].gain.gain.value, 0);
  const values = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(index / 20) * 0.5); f.emit([values]);
  const output = parse(await f.capture.stop()); assert.deepEqual([output.riff,output.rate,output.channels,output.bits,output.frames,output.bytes], ['RIFF',16000,1,16,16000,32000]);
  assert.equal(f.capture.durationMs, 1000); assert.equal(f.capture.state, 'stopped'); assert.equal(f.tracks[0].stopped, 1); assert.equal(f.timers.size, 0); assert.equal(f.contexts[0].processor.onaudioprocess, null);
  assert.equal(f.levels.length, 1); assert.ok(f.levels[0].rms > 0.3); assert.deepEqual(await f.capture.stop(), await f.capture.stop());
});

test('44.1k resampling is continuous across irregular callback boundaries', async () => {
  const samples = Float32Array.from({ length: 44100 }, (_, index) => Math.sin(index / 13) * 0.7), whole = await fixture({ rate: 44100 }), chunks = await fixture({ rate: 44100 });
  await whole.capture.start(); await chunks.capture.start(); whole.emit([samples]);
  for (let offset = 0; offset < samples.length; offset += 997) chunks.emit([samples.subarray(offset, Math.min(samples.length, offset + 997))]);
  const a = parse(await whole.capture.stop()), b = parse(await chunks.capture.stop()); assert.equal(a.frames, 16000); assert.deepEqual(a.samples, b.samples);
});

test('stereo mixes down, clamps nonfinite input and upsamples actual 8k rate', async () => {
  const f = await fixture({ rate: 8000 }); await f.capture.start(); f.emit([Float32Array.of(1, -1, NaN, 2), Float32Array.of(-1, -1, 0, 0)]);
  const output = parse(await f.capture.stop()); assert.equal(output.frames, 8); assert.deepEqual(output.samples, [0,-16384,-32768,-16384,0,8192,16384,16384]); assert.ok(Number.isFinite(f.levels[0].rms));
});

test('stop releases tracks and nodes before WAV resolves and awaits context close', async () => {
  const close = deferred(), f = await fixture({ close }); await f.capture.start(); f.emit([new Float32Array(480)]); let settled = false;
  const stopped = f.capture.stop().then(value => { settled = true; return value; }); await flush(); assert.equal(settled, false); assert.equal(f.tracks[0].stopped, 1);
  assert.ok(['source','processor','gain'].every(name => f.contexts[0][name].disconnected)); close.resolve(); assert.equal(parse(await stopped).frames, 160);
});

test('cancel while permission pending immediately releases late stream without creating context', async () => {
  const permission = deferred(), f = await fixture({ permission }), starting = f.capture.start(); await f.capture.cancel(); assert.equal(f.capture.state, 'cancelled'); assert.equal(f.contexts.length, 0);
  permission.resolve(f.stream); await assert.rejects(starting, { name: 'AbortError' }); assert.equal(f.tracks[0].stopped, 1); await assert.rejects(f.capture.stop(), { name: 'AbortError' }); assert.equal(f.limits.length, 0);
});

test('cancel during suspended resume or slow stop cannot return a recording', async () => {
  const resume = deferred(), f = await fixture({ suspended: true, resume }), starting = f.capture.start(); await flush(); const cancelled = f.capture.cancel(); resume.resolve(); await cancelled; await assert.rejects(starting, { name: 'AbortError' }); assert.equal(f.tracks[0].stopped, 1);
  const close = deferred(), second = await fixture({ close }); await second.capture.start(); second.emit([new Float32Array(480)]); const stopped = second.capture.stop(), cancel = second.capture.cancel(); close.resolve(); await cancel; await assert.rejects(stopped, { name: 'AbortError' }); assert.equal(second.capture.durationMs, 0);
});

test('byte and wall-clock limits notify once only after resources close, data remains bounded', async () => {
  const f = await fixture({ config: { maxPcmBytes: 320 } }); await f.capture.start(); const stale = f.contexts[0].processor.onaudioprocess;
  f.emit([new Float32Array(4800)]); assert.equal(f.capture.state, 'limited'); assert.equal(f.tracks[0].stopped, 1); stale({ inputBuffer: {} }); await flush(); assert.equal(f.limits.length, 1); assert.equal(f.limits[0].reason, 'bytes'); assert.equal(parse(await f.capture.stop()).bytes, 320);
  const timed = await fixture({ config: { maxDurationMs: 10 } }); await timed.capture.start(); timed.emit([new Float32Array(240)]); [...timed.timers.values()][0](); await flush(); assert.equal(timed.limits.length, 1); assert.equal(timed.limits[0].reason, 'duration'); assert.equal(parse(await timed.capture.stop()).frames, 80);
});

test('permission errors and stream format changes clear audio and return fixed safe errors', async () => {
  const permission = deferred(), f = await fixture({ permission }), starting = f.capture.start(); permission.reject(Object.assign(new Error('MOCK_PRIVATE_DEVICE_DETAIL'), { name: 'NotAllowedError' }));
  await assert.rejects(starting, error => error.code === 'microphone_denied' && !error.message.includes('MOCK_PRIVATE')); assert.deepEqual(f.errors, [{ code: 'microphone_denied' }]);
  const changed = await fixture(); await changed.capture.start(); changed.emit([new Float32Array(480)]); changed.emit([new Float32Array(441)], 44100); await flush(); assert.equal(changed.capture.state, 'error'); assert.equal(changed.capture.durationMs, 0); assert.equal(changed.tracks[0].stopped, 1); assert.deepEqual(changed.errors, [{ code: 'capture_failed' }]);
});

test('invalid configuration, repeated start and stop before readiness do not capture', async () => {
  const { DictationCapture } = await captureModule; for (const config of [{ targetSampleRate: 48000 }, { maxDurationMs: 120001 }, { maxPcmBytes: 3 }]) assert.throws(() => new DictationCapture({ AudioContext: class {}, ...config }), { code: 'invalid_configuration' });
  const f = await fixture(); await assert.rejects(f.capture.stop(), { code: 'invalid_state' }); await f.capture.start(); await assert.rejects(f.capture.start(), { code: 'invalid_state' }); await f.capture.cancel(); assert.equal(f.tracks[0].stopped, 1);
});

test('device ended releases capture immediately, discards samples and emits only fixed failure', async () => {
  const f = await fixture(); await f.capture.start(); f.emit([new Float32Array(480)]); assert.equal(f.listeners.size, 1);
  f.tracks[0].end(); assert.equal(f.capture.state, 'error'); assert.equal(f.capture.durationMs, 0); assert.equal(f.tracks[0].stopped, 1); assert.equal(f.listeners.size, 0); assert.equal(f.contexts[0].processor.onaudioprocess, null); assert.equal(f.timers.size, 0); assert.deepEqual(f.errors, [{ code: 'capture_failed' }]);
  f.tracks[0].end(); await assert.rejects(f.capture.stop(), { code: 'invalid_state' }); assert.equal(f.errors.length, 1);
});

test('ended during preparing aborts suspended resume and normal stop/cancel never report device failure', async () => {
  const resume = deferred(), f = await fixture({ suspended: true, resume }), starting = f.capture.start(); await flush(); f.tracks[0].end(); resume.resolve(); await assert.rejects(starting, { code: 'capture_failed' }); assert.deepEqual(f.errors, [{ code: 'capture_failed' }]); assert.equal(f.listeners.size, 0);
  for (const action of ['stop','cancel']) { const normal = await fixture(); await normal.capture.start(); normal.emit([new Float32Array(480)]); await normal.capture[action](); assert.equal(normal.errors.length, 0); assert.equal(normal.listeners.size, 0); normal.tracks[0].end(); assert.equal(normal.errors.length, 0); }
  const ended = await fixture({ ended: true }); await assert.rejects(ended.capture.start(), { code: 'capture_failed' }); assert.equal(ended.contexts.length, 0); assert.equal(ended.tracks[0].stopped, 1);
});

test('default timers preserve Window receiver instead of invoking native timer on capture object', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout; let created = 0, cleared = 0;
  globalThis.setTimeout = function (...args) { assert.equal(this, globalThis, 'Window timer requires its branded receiver'); created++; return Reflect.apply(originalSet, globalThis, args); };
  globalThis.clearTimeout = function (...args) { assert.equal(this, globalThis, 'Window timer requires its branded receiver'); cleared++; return Reflect.apply(originalClear, globalThis, args); };
  try {
    const f = await fixture({ config: { setTimer: undefined, clearTimer: undefined } }); await f.capture.start(); assert.equal(f.capture.state, 'recording'); assert.equal(created, 1); f.emit([new Float32Array(480)]); assert.equal(parse(await f.capture.stop()).frames, 160); assert.equal(cleared, 1); assert.deepEqual(f.errors, []);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
