'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { synthesizeSpeech, normalizeSynthesisUrl, TTS_LIMITS, TTSProviderError } = require('../backend/tts-provider.cjs');

// A genuine PCM WAV container containing generated silence/tone, never user
// recordings. The renderer's real Audio decoder is exercised by desktop tests.
function wav({ dataBytes = 4800, rate = 24000, tone = false } = {}) {
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  if (tone) for (let index = 0; index < dataBytes / 2; index++) bytes.writeInt16LE(Math.round(3000 * Math.sin(index * 2 * Math.PI * 440 / rate)), 44 + index * 2);
  return bytes;
}
// A structurally complete MPEG1 layer-III frame is sufficient to exercise the
// adapter's header guard; this test makes no codec-decoding claim for MP3.
function mp3(id3 = false) {
  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x00]);
  return id3 ? Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), frame]) : frame;
}

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, method: request.method, headers: request.headers, body: body ? JSON.parse(body) : null });
      handler(request, response, requests);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}
const options = (speechBaseUrl, extra = {}) => ({ settings: { speechBaseUrl, synthesisModel: 'synthetic-tts-model', synthesisVoice: 'synthetic-voice' }, text: '这是本机模拟声音试听。', ...extra });
const code = expected => error => error instanceof TTSProviderError && error.code === expected;
const audioResponse = (response, bytes = wav(), type = 'audio/wav') => { response.writeHead(200, { 'Content-Type': type }); response.end(bytes); };

test('TTS normalizes root/v1, full transcription and full speech URLs by replacing only the same-origin suffix', () => {
  const cases = [
    ['https://example.invalid', 'https://example.invalid/v1/audio/speech'],
    ['https://example.invalid/v1/', 'https://example.invalid/v1/audio/speech'],
    ['https://example.invalid/proxy/v1/audio/transcriptions?api-version=2026-01-01', 'https://example.invalid/proxy/v1/audio/speech?api-version=2026-01-01'],
    ['https://example.invalid/proxy/audio/speech/', 'https://example.invalid/proxy/audio/speech'],
    ['http://127.0.0.1:9090/custom', 'http://127.0.0.1:9090/custom/audio/speech']
  ];
  for (const [input, expected] of cases) { const result = normalizeSynthesisUrl(input); assert.equal(result.href, expected); assert.equal(result.origin, new URL(input).origin); }
});

test('TTS refuses missing speech URLs, original Muse hosts, userinfo, fragments, auth queries and chat endpoints', () => {
  for (const value of [undefined, '', 'file:///tmp/speech', 'https://user:pass@example.invalid', 'https://@example.invalid', 'https://example.invalid/#',
    'https://shortwave.meta.ai', 'https://a.metaaivm.com', 'https://META.AI.', 'https://facebook.com', 'https://metaaiusercontent.com', 'https://ecto1usercontent.com',
    'https://example.invalid?x-api-key=synthetic', 'https://example.invalid?access_token=synthetic', 'https://example.invalid/v1/chat/completions']) {
    assert.throws(() => normalizeSynthesisUrl(value), code('configuration'));
  }
});

test('TTS posts only explicit synthesis JSON and returns owned playable PCM WAV bytes without credentials or extra provider fields', async t => {
  const sample = wav({ tone: true }), apiKey = 'synthetic-independent-tts-key';
  const { baseUrl, requests } = await fixture(t, (_request, response) => audioResponse(response, sample));
  const settings = { speechBaseUrl: `${baseUrl}/v1/audio/transcriptions?api-version=2026-01-01`, synthesisModel: 'custom-model', synthesisVoice: 'custom-voice', model: 'chat-model-do-not-send', apiKey: 'chat-secret-do-not-send', systemPrompt: 'chat-prompt-do-not-send' };
  const result = await synthesizeSpeech({ settings, apiKey, text: '试听\nSynthetic preview 🎙' });
  assert.ok(result.audio instanceof ArrayBuffer); assert.deepEqual(Buffer.from(result.audio), sample);
  assert.equal(result.mimeType, 'audio/wav'); assert.equal(result.format, 'wav');
  assert.deepEqual(Object.keys(result).sort(), ['audio', 'format', 'mimeType']);
  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.equal(sent.path, '/v1/audio/speech?api-version=2026-01-01'); assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.authorization, `Bearer ${apiKey}`); assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(sent.body, { input: '试听\nSynthetic preview 🎙', model: 'custom-model', voice: 'custom-voice', response_format: 'wav', speed: 1, stream_format: 'audio' });
  assert.equal(JSON.stringify(sent.body).includes(apiKey), false); assert.equal(JSON.stringify(sent.body).includes('chat-'), false);
  new Uint8Array(result.audio)[44] = 42; assert.notEqual(sample[44], 42);
});

test('keyless local synthesis never borrows a chat key or guesses model/voice from chat or transcription settings', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => audioResponse(response));
  const configured = options(baseUrl);
  configured.settings.apiKey = 'synthetic-chat-only-key'; configured.settings.model = 'chat-model';
  assert.equal((await synthesizeSpeech(configured)).format, 'wav'); assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(requests[0].body).includes('synthetic-chat-only-key'), false);
  await assert.rejects(synthesizeSpeech({ settings: { baseUrl, model: 'chat', transcriptionModel: 'asr' }, text: 'sample' }), code('configuration'));
  await assert.rejects(synthesizeSpeech({ settings: { speechBaseUrl: baseUrl, transcriptionModel: 'asr' }, text: 'sample' }), code('configuration'));
  assert.equal(requests.length, 1);
});

test('MP3 with or without ID3 is returned with fixed audio/mpeg MIME and speed endpoints remain explicit', async t => {
  let index = 0;
  const samples = [mp3(), mp3(true)];
  const { baseUrl, requests } = await fixture(t, (_request, response) => audioResponse(response, samples[index++], 'audio/mpeg'));
  for (const [position, speed] of [0.25, 4].entries()) {
    const result = await synthesizeSpeech(options(`${baseUrl}/audio/speech`, { responseFormat: 'mp3', speed }));
    assert.equal(result.format, 'mp3'); assert.equal(result.mimeType, 'audio/mpeg'); assert.deepEqual(Buffer.from(result.audio), samples[position]);
    assert.equal(requests[position].body.speed, speed); assert.equal(requests[position].body.response_format, 'mp3');
  }
});

test('invalid models, voices, speed, format and header-key controls fail before fetch without echoing input', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('must not fetch'); });
  const invalidSettings = [{ synthesisModel: '' }, { synthesisVoice: '' }, { synthesisModel: 'a'.repeat(301) }, { synthesisVoice: 'v'.repeat(101) },
    { synthesisModel: 'a\nb' }, { synthesisVoice: 'a\u202eb' }, { synthesisVoice: '\ud800' }];
  for (const patch of invalidSettings) {
    const input = options('https://example.invalid'); Object.assign(input.settings, patch);
    await assert.rejects(synthesizeSpeech(input), code('configuration'));
  }
  for (const extra of [{ speed: 0.24 }, { speed: 4.01 }, { speed: NaN }, { speed: '1' }, { responseFormat: 'sse' }, { responseFormat: 'pcm' }, { apiKey: 'bad\r\nsynthetic' }]) {
    await assert.rejects(synthesizeSpeech(options('https://example.invalid', extra)), code('configuration'));
  }
  assert.equal(requests, 0);
});

test('text uses Unicode codepoint/UTF-8 limits, preserves paragraphs and rejects empty, controls, malformed Unicode or 4097 characters', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => audioResponse(response));
  const maximum = '🎙'.repeat(4096);
  assert.equal(Buffer.byteLength(maximum), TTS_LIMITS.MAX_INPUT_BYTES);
  assert.equal((await synthesizeSpeech(options(baseUrl, { text: maximum }))).format, 'wav'); assert.equal(requests[0].body.input, maximum);
  for (const text of ['', '  \n', '字'.repeat(4097), '\ud800', 'a\0b', 'a\u0007b']) await assert.rejects(synthesizeSpeech(options(baseUrl, { text })), code('input'));
  assert.equal(requests.length, 1); assert.equal(Object.isFrozen(TTS_LIMITS), true);
});

test('tolerant URL checks reject raw, mixed, malformed-query and nested encoded keys before any fetch or error reflection', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('must not fetch'); });
  const apiKey = 'synthetic:tts/key+only', encoded = [apiKey, encodeURIComponent(apiKey).replace('synthetic', '%73ynthetic')];
  let current = apiKey;
  for (let depth = 1; depth <= 24; depth++) { current = encodeURIComponent(current); if ([1, 2, 5, 24].includes(depth)) encoded.push(current); }
  for (const value of encoded) await assert.rejects(synthesizeSpeech(options(`https://example.invalid?bad=%E0%ZZ&deployment=${value}`, { apiKey })), error => {
    assert.equal(error.code, 'configuration'); const exposed = `${error.stack} ${JSON.stringify(error)}`;
    assert.equal(exposed.includes(apiKey), false); assert.equal(exposed.includes(value), false); return true;
  });
  for (const field of ['text', 'synthesisModel', 'synthesisVoice']) {
    const input = options('https://example.invalid', { apiKey });
    if (field === 'text') input.text = apiKey; else input.settings[field] = apiKey;
    await assert.rejects(synthesizeSpeech(input), code('configuration'));
  }
  assert.equal(requests, 0);
});

test('non-auth malformed query values are preserved with a header-only key', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => audioResponse(response));
  await synthesizeSpeech(options(`${baseUrl}?bad=%E0%ZZ&api-version=preview`, { apiKey: 'synthetic-tts-header-key' }));
  assert.equal(requests[0].path, '/v1/audio/speech?bad=%E0%ZZ&api-version=preview');
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-tts-header-key');
});

test('TTS redirects are not followed and cannot forward the independent speech key to another origin', async t => {
  const target = await fixture(t, (_request, response) => audioResponse(response));
  const source = await fixture(t, (_request, response) => { response.writeHead(307, { Location: `${target.baseUrl}/redirected` }); response.end(); });
  await assert.rejects(synthesizeSpeech(options(source.baseUrl, { apiKey: 'synthetic-redirect-key' })), code('network'));
  assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 0);
});

test('HTTP errors expose fixed status hints without raw, escaped or URL-encoded credential/body details and never retry', async t => {
  const apiKey = 'synthetic:tts/secret+echo', unicode = [...apiKey].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const { baseUrl, requests } = await fixture(t, (_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `REMOTE-ECHO ${apiKey} ${unicode} ${encodeURIComponent(apiKey)}` } }));
  });
  await assert.rejects(synthesizeSpeech(options(baseUrl, { apiKey })), error => {
    assert.equal(error.status, 401); assert.equal(error.code, 'http_error'); assert.match(error.message, /密钥/);
    const exposed = `${error.stack} ${JSON.stringify(error)}`;
    for (const value of [apiKey, unicode, encodeURIComponent(apiKey), 'REMOTE-ECHO']) assert.equal(exposed.includes(value), false);
    assert.equal(error.cause, undefined); return true;
  });
  assert.equal(requests.length, 1);
});

test('JSON/HTML/SSE and mismatched MIME are rejected even with HTTP success, while generic binary MIME is accepted', async t => {
  const cases = [['application/json', Buffer.from('{"error":"synthetic detail"}')], ['text/html', Buffer.from('<html>login</html>')],
    ['text/event-stream', Buffer.from('data: audio\n\n')], ['audio/mpeg', mp3()], ['application/octet-stream', wav()]];
  let index = 0;
  const { baseUrl } = await fixture(t, (_request, response) => { const [type, bytes] = cases[index++]; audioResponse(response, bytes, type); });
  for (let at = 0; at < cases.length - 1; at++) await assert.rejects(synthesizeSpeech(options(baseUrl)), code('invalid_response'));
  assert.equal((await synthesizeSpeech(options(baseUrl))).mimeType, 'audio/wav');
});

test('WAV response header guard rejects empty/truncated/inconsistent PCM but accepts bounded metadata chunks and streaming length sentinels', async t => {
  const malformed = [Buffer.alloc(0), Buffer.from('<html>not audio</html>'), wav().subarray(0, 20), wav(), wav(), wav(), Buffer.concat([wav(), Buffer.from('x')])];
  malformed[3].writeUInt32LE(9, 4); malformed[4].writeUInt16LE(99, 22); malformed[5].writeUInt32LE(9999999, 40);
  const original = wav(), metadata = Buffer.concat([original.subarray(0, 36), Buffer.from('JUNK\x00\x00\x00\x00'), original.subarray(36)]);
  metadata.writeUInt32LE(metadata.length - 8, 4);
  const streamed = wav(); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
  const cases = [...malformed, metadata, streamed]; let index = 0;
  const { baseUrl } = await fixture(t, (_request, response) => audioResponse(response, cases[index++]));
  for (const _ of malformed) await assert.rejects(synthesizeSpeech(options(baseUrl)), code('invalid_audio'));
  assert.deepEqual(Buffer.from((await synthesizeSpeech(options(baseUrl))).audio), metadata);
  assert.deepEqual(Buffer.from((await synthesizeSpeech(options(baseUrl))).audio), streamed);
});

test('MP3 header guard rejects ID3-only, truncated frames and reserved MPEG header values', async t => {
  const cases = [Buffer.from('ID3'), mp3(true).subarray(0, 10), mp3().subarray(0, 20), mp3(), mp3(), mp3(true)];
  cases[3][1] = 0xe9; cases[4][2] = 0x0c; cases[5][6] = 0xff;
  let index = 0;
  const { baseUrl } = await fixture(t, (_request, response) => audioResponse(response, cases[index++], 'audio/mpeg'));
  for (const _ of cases) await assert.rejects(synthesizeSpeech(options(baseUrl, { responseFormat: 'mp3' })), code('invalid_audio'));
});

test('audio byte cap accepts exactly 16 MiB and cancels declared or chunked overflow', async t => {
  let index = 0, closed;
  const ended = new Promise(resolve => { closed = resolve; });
  const maximum = wav({ dataBytes: TTS_LIMITS.MAX_AUDIO_BYTES - 44 });
  const { baseUrl } = await fixture(t, (_request, response) => {
    const current = index++;
    if (current === 0) audioResponse(response, maximum);
    else if (current === 1) { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': TTS_LIMITS.MAX_AUDIO_BYTES + 1 }); response.end(' '); }
    else { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.on('close', closed); response.write(maximum); response.write('x'); }
  });
  assert.equal((await synthesizeSpeech(options(baseUrl))).audio.byteLength, TTS_LIMITS.MAX_AUDIO_BYTES);
  await assert.rejects(synthesizeSpeech(options(baseUrl)), code('response_too_large'));
  await assert.rejects(synthesizeSpeech(options(baseUrl)), code('response_too_large'));
  await ended;
});

test('pre-abort and cancellation during a binary response stop delivery without retry or leaking abort reason', async t => {
  let entered, closed;
  const ready = new Promise(resolve => { entered = resolve; }), ended = new Promise(resolve => { closed = resolve; });
  const { baseUrl, requests } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.write(wav().subarray(0, 44)); response.on('close', closed); entered();
  });
  await assert.rejects(synthesizeSpeech(options(baseUrl, { signal: AbortSignal.abort(Error('SYNTHETIC_PRIVATE_ABORT_REASON')) })), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  const controller = new AbortController(), pending = synthesizeSpeech(options(baseUrl, { signal: controller.signal }));
  await ready; controller.abort(Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('SYNTHETIC_PRIVATE_ABORT_REASON'));
  await ended; assert.equal(requests.length, 1);
});

test('120 second synthesis timeout aborts exactly once and suppresses original exceptions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { calls++; signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('SYNTHETIC_TIMEOUT_KEY')), { once: true })); });
  const pending = synthesizeSpeech(options('http://127.0.0.1:9999'));
  t.mock.timers.tick(TTS_LIMITS.REQUEST_TIMEOUT_MS - 1); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, error => error.code === 'timeout' && !error.message.includes('SYNTHETIC_TIMEOUT_KEY'));
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('local network failure is fixed, safe and never automatically retried', async t => {
  const { baseUrl, requests } = await fixture(t, request => request.socket.destroy());
  await assert.rejects(synthesizeSpeech(options(baseUrl, { apiKey: 'synthetic-local-network-key' })), error => error.code === 'network' && error.cause === undefined && !error.message.includes('synthetic-local-network-key'));
  assert.equal(requests.length, 1);
});
