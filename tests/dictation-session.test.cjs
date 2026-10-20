'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { DictationSessionManager, MAX_AUDIO_BYTES } = require('../backend/dictation-session.cjs');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const owner = () => ({ scopeKey: 'chat:fixture:revision:1', workspaceId: 'workspace_fixture', chatId: 'chat_fixture' });
function wav(samples = 160) {
  const audio = new ArrayBuffer(44 + samples * 2), bytes = new Uint8Array(audio), view = new DataView(audio);
  for (const [offset, word] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']]) for (let at = 0; at < word.length; at++) bytes[offset + at] = word.charCodeAt(at);
  view.setUint32(4, audio.byteLength - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true);
  for (let at = 44; at < audio.byteLength; at += 2) view.setInt16(at, 1234, true);
  return audio;
}
function fixture(options = {}) {
  let binding = { generation: 1, providerId: 'fixture' }, valid = true, clock = Date.UTC(2026, 9, 20), serial = 0;
  const timers = new Map(), states = [], calls = [];
  const manager = new DictationSessionManager({ getProviderBinding: () => binding, validateScope: () => valid, transcribe: async input => { calls.push(input); return { text: ' 模拟听写正文 ' }; }, onState: state => states.push(state), now: () => clock++, setTimer: callback => { timers.set(++serial, callback); return serial; }, clearTimer: id => timers.delete(id), ...options });
  return { manager, timers, states, calls, setBinding(value) { binding = value; }, setValid(value) { valid = value; }, start() { const meta = manager.start({ owner: owner() }); manager.captureReady({ id: meta.id }); return meta.id; } };
}

test('session lifecycle has metadata-only history and grants capture only before transcription', async () => {
  const f = fixture(), start = f.manager.start({ owner: owner() });
  assert.equal(start.state, 'preparing'); assert.equal(f.manager.allowsCapture(), true); assert.equal(f.manager.validateCurrent(), true);
  assert.equal(f.manager.captureReady({ id: start.id }).state, 'recording');
  const finishing = f.manager.finish({ id: start.id, audio: wav() });
  assert.equal(f.manager.snapshot().state, 'finishing'); assert.equal(f.manager.allowsCapture(), false); assert.equal(f.manager.validateCurrent(), true);
  const result = await finishing;
  assert.equal(result.text, '模拟听写正文'); assert.equal(result.state, 'complete'); assert.equal(f.manager.validateCurrent(), false); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.states.map(item => item.state), ['preparing','recording','finishing','complete']);
  for (const state of [...f.states, f.manager.snapshot()]) assert.deepEqual(Object.keys(state).sort(), ['createdAt','endedAt','id','owner','state','updatedAt'].filter(key => key !== 'endedAt' || state.endedAt).sort());
  assert.equal(JSON.stringify(f.states).includes('模拟听写正文'), false);
  assert.equal(f.calls[0].binding.owner.scopeKey, owner().scopeKey); assert.ok(Object.isFrozen(f.calls[0].binding.provider));
});

test('one active session, owner validation and state transitions reject invalid operations', async () => {
  const f = fixture(), first = f.manager.start({ owner: owner() });
  assert.throws(() => f.manager.start({ owner: owner() }), { code: 'dictation_busy' });
  await assert.rejects(f.manager.finish({ id: first.id, audio: wav() }), { code: 'invalid_state' });
  f.manager.captureReady({ id: first.id }); assert.throws(() => f.manager.captureReady({ id: first.id }), { code: 'invalid_state' });
  f.manager.cancel();
  for (const invalid of [null, { ...owner(), scopeKey: '' }, { ...owner(), chatId: '../outside' }, { ...owner(), token: 'unwanted' }]) assert.throws(() => f.manager.start({ owner: invalid }), { code: 'invalid_owner' });
  assert.throws(() => f.manager.cancel({ id: 'missing' }), { code: 'unknown_session' });
});

test('cancel settles a provider which ignores abort, clears copied audio and discards late text', async () => {
  const pending = deferred(), entered = deferred(); let received;
  const f = fixture({ transcribe: input => { received = input; entered.resolve(); return pending.promise; } }), id = f.start(), input = wav(), original = new Uint8Array(input).slice();
  const finished = f.manager.finish({ id, audio: input }); await entered.promise;
  assert.notEqual(received.audio, input); assert.equal(received.signal.aborted, false);
  const cancelled = f.manager.cancel({ id }); assert.equal(cancelled.state, 'cancelled');
  const result = await finished; assert.equal(result.state, 'cancelled'); assert.equal(Object.hasOwn(result, 'text'), false); assert.equal(received.signal.aborted, true);
  assert.ok(new Uint8Array(received.audio).every(value => value === 0)); assert.deepEqual(new Uint8Array(input), original);
  const next = f.manager.start({ owner: { ...owner(), scopeKey: 'new_owner' } }); pending.resolve({ text: '迟到正文' }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.manager.snapshot().id, next.id); assert.equal(f.manager.snapshot(id).state, 'cancelled'); assert.equal(JSON.stringify(f.states).includes('迟到正文'), false); f.manager.cancel();
});

test('config/scope changes invalidate all active phases and cannot expose provider errors', async () => {
  for (const phase of ['preparing','recording','finishing']) {
    const pending = deferred(), entered = deferred();
    const f = fixture({ transcribe: () => { entered.resolve(); return pending.promise; } }), meta = f.manager.start({ owner: owner() }); let result;
    if (phase !== 'preparing') f.manager.captureReady({ id: meta.id });
    if (phase === 'finishing') { result = f.manager.finish({ id: meta.id, audio: wav() }); await entered.promise; }
    f.setBinding({ generation: 2, providerId: 'fixture' }); assert.equal(f.manager.validateCurrent(), false);
    assert.equal(f.manager.snapshot().errorCode, 'configuration_changed'); if (result) assert.equal((await result).state, 'cancelled'); pending.resolve('late');
  }
  const f = fixture(), id = f.start(); f.setValid('truthy'); assert.equal(f.manager.allowsCapture(), false); assert.equal(f.manager.snapshot(id).errorCode, 'scope_changed');
  const rejected = fixture({ getProviderBinding() { throw new Error('MOCK_PRIVATE_PROVIDER_VALUE'); } });
  assert.throws(() => rejected.manager.start({ owner: owner() }), error => error.code === 'provider_unavailable' && !error.message.includes('MOCK_PRIVATE'));
});

test('timeout and destruction cancel capture/transcription and prohibit late publication', async () => {
  for (const phase of ['preparing','recording','finishing']) {
    const pending = deferred(), f = fixture({ transcribe: () => pending.promise }), first = f.manager.start({ owner: owner() }); let result;
    if (phase !== 'preparing') f.manager.captureReady({ id: first.id });
    if (phase === 'finishing') result = f.manager.finish({ id: first.id, audio: wav() });
    [...f.timers.values()][0](); assert.equal(f.manager.snapshot().state, 'error'); assert.equal(f.manager.snapshot().errorCode, 'timeout'); if (result) assert.equal((await result).state, 'error'); pending.resolve('late');
  }
  const f = fixture(); f.start(); assert.equal(f.manager.dispose().errorCode, 'window_destroyed'); assert.equal(f.manager.allowsCapture(), false); assert.throws(() => f.manager.start({ owner: owner() }), { code: 'disposed' });
});

test('only bounded canonical mono PCM WAV accepted, including cross-realm ArrayBuffers', async () => {
  const invalid = [new Uint8Array(wav()), new ArrayBuffer(44), new ArrayBuffer(MAX_AUDIO_BYTES + 2), wav()]; new DataView(invalid[3]).setUint32(24, 48000, true);
  for (const audio of invalid) { const f = fixture(), id = f.start(); await assert.rejects(f.manager.finish({ id, audio }), { code: 'invalid_audio' }); assert.equal(f.calls.length, 0); assert.equal(f.manager.snapshot().state, 'error'); }
  const audio = vm.runInNewContext('new ArrayBuffer(364)'); new Uint8Array(audio).set(new Uint8Array(wav()));
  const f = fixture(), id = f.start(); assert.equal((await f.manager.finish({ id, audio })).state, 'complete');
});

test('provider failures and malformed result text produce generic terminal metadata', async () => {
  for (const output of ['', '  ', { text: '\0hidden' }, { text: '\ud800' }, { text: 'a'.repeat(200001) }, {}, null]) {
    const f = fixture({ transcribe: async () => output }), id = f.start(), result = await f.manager.finish({ id, audio: wav() });
    assert.equal(result.state, 'error'); assert.equal(result.errorCode, 'invalid_result'); assert.equal(Object.hasOwn(result, 'text'), false);
  }
  const f = fixture({ transcribe: async () => { throw new Error('MOCK_PRIVATE_ADAPTER_ERROR'); } }), result = await f.manager.finish({ id: f.start(), audio: wav() });
  assert.equal(result.errorCode, 'transcription_failed'); assert.equal(JSON.stringify(result).includes('MOCK_PRIVATE'), false);
});

test('owner snapshots cannot mutate authority, observer failures are isolated, history bounded', () => {
  const f = fixture({ onState() { throw new Error('ignored observer'); } }), owned = owner(), first = f.manager.start({ owner: owned }); owned.scopeKey = 'changed'; first.owner.scopeKey = 'tampered';
  assert.equal(f.manager.snapshot().owner.scopeKey, owner().scopeKey); f.manager.cancel();
  for (let index = 0; index < 22; index++) { f.manager.start({ owner: owner() }); f.manager.cancel(); }
  assert.equal(f.manager.snapshot(first.id), null); assert.equal(f.manager.snapshot().state, 'cancelled');
});

test('transcription limit counts Unicode codepoints rather than UTF16 units', async () => {
  const text = '😀'.repeat(200000), f = fixture({ transcribe: async () => ({ text }) });
  const accepted = await f.manager.finish({ id: f.start(), audio: wav() }); assert.equal(accepted.state, 'complete'); assert.equal(accepted.text, text); assert.equal(Object.hasOwn(f.manager.snapshot(), 'text'), false);
  const overflow = fixture({ transcribe: async () => ({ text: text + 'a' }) }), rejected = await overflow.manager.finish({ id: overflow.start(), audio: wav() }); assert.equal(rejected.state, 'error'); assert.equal(rejected.errorCode, 'invalid_result'); assert.equal(Object.hasOwn(rejected, 'text'), false);
});
