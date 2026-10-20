'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { transcribeAudio, normalizeSpeechBaseUrl, validateWavAudio, ASR_LIMITS, ASRProviderError } = require('../backend/asr-provider.cjs');

function wav(durationMs = 100) {
  const length = Math.round(durationMs * 32), data = Buffer.alloc(length + 44);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(length, 40);
  return data;
}

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
      handler(request, response, requests);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function options(baseUrl, extra = {}) { return { settings: { speechBaseUrl: baseUrl, transcriptionModel: 'synthetic-asr-model' }, audio: wav(), ...extra }; }
function json(response, body, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
function code(expected) { return error => error instanceof ASRProviderError && error.code === expected; }

test('ASR endpoint uses explicit speech root, prefix or full transcription path and preserves non-auth query', () => {
  assert.equal(normalizeSpeechBaseUrl('https://example.invalid').href, 'https://example.invalid/v1/audio/transcriptions');
  assert.equal(normalizeSpeechBaseUrl('https://example.invalid/v1/').href, 'https://example.invalid/v1/audio/transcriptions');
  assert.equal(normalizeSpeechBaseUrl('https://example.invalid/proxy/v1?api-version=2026-01-01').href, 'https://example.invalid/proxy/v1/audio/transcriptions?api-version=2026-01-01');
  assert.equal(normalizeSpeechBaseUrl('https://example.invalid/audio/transcriptions/').href, 'https://example.invalid/audio/transcriptions');
  assert.equal(normalizeSpeechBaseUrl('http://127.0.0.1:9900').protocol, 'http:');
});

test('ASR endpoint rejects missing speech configuration, original hosts, URL credentials, fragments and auth queries', () => {
  for (const value of [undefined, '', 'localhost:9999', 'file:///tmp/audio', 'ftp://example.invalid', 'https://user:pass@example.invalid', 'https://@example.invalid', 'https://example.invalid/#', 'https://example.invalid/#sample',
    'https://meta.ai', 'https://shortwave.meta.ai', 'https://SHORTWAVE.META.AI.', 'https://a.metaaivm.com', 'https://facebook.com', 'https://metaaiusercontent.com', 'https://a.ecto1usercontent.com',
    'https://example.invalid?api_key=synthetic', 'https://example.invalid?Access-Token=synthetic', 'https://example.invalid?%61uthorization=synthetic', 'https://example.invalid?client_secret=synthetic',
    'https://example.invalid?x-api-key=synthetic', 'https://example.invalid?subscription-key=synthetic',
    'https://example.invalid/chat/completions', 'https://example.invalid/v1/models', 'https://example.invalid/\npath']) {
    assert.throws(() => normalizeSpeechBaseUrl(value), code('configuration'), String(value));
  }
  assert.equal(normalizeSpeechBaseUrl('https://meta.ai.example.invalid').hostname, 'meta.ai.example.invalid');
});

test('canonical WAV validator accepts inclusive 0.1/120 second boundaries and copies offset views without retaining input', () => {
  const first = wav(), result = validateWavAudio(first);
  assert.equal(result.durationMs, 100); assert.equal(result.sampleRate, 16000); assert.equal(result.channels, 1); assert.equal(result.bitsPerSample, 16);
  assert.deepEqual(Buffer.from(result.bytes), first);
  first[44] = 99; assert.equal(result.bytes[44], 0);
  const container = Buffer.concat([Buffer.alloc(9), wav(), Buffer.alloc(8)]);
  assert.equal(validateWavAudio(container.subarray(9, container.length - 8)).bytes.length, ASR_LIMITS.MIN_WAV_BYTES);
  const maximum = wav(120000);
  assert.equal(maximum.length, ASR_LIMITS.MAX_WAV_BYTES); assert.equal(validateWavAudio(maximum).durationMs, 120000);
  const arrayBuffer = Uint8Array.from(wav()).buffer;
  assert.ok(arrayBuffer instanceof ArrayBuffer);
  assert.equal(validateWavAudio(arrayBuffer).durationMs, 100);
  assert.equal(Object.isFrozen(ASR_LIMITS), true);
});

test('WAV validator rejects alternate formats, inconsistent sizes, extra chunks, trailing data and duration violations', () => {
  const mutations = [
    data => data.write('RIFX', 0), data => data.writeUInt32LE(data.length - 9, 4), data => data.write('MP3 ', 8),
    data => data.write('JUNK', 12), data => data.writeUInt32LE(18, 16), data => data.writeUInt16LE(3, 20),
    data => data.writeUInt16LE(2, 22), data => data.writeUInt32LE(24000, 24), data => data.writeUInt32LE(16000, 28),
    data => data.writeUInt16LE(4, 32), data => data.writeUInt16LE(8, 34), data => data.write('LIST', 36),
    data => data.writeUInt32LE(data.length - 45, 40)
  ];
  for (const mutate of mutations) { const data = wav(); mutate(data); assert.throws(() => validateWavAudio(data), code('invalid_audio')); }
  for (const data of [wav(99), wav(120001), Buffer.alloc(44), Buffer.concat([wav(), Buffer.from('x')])]) assert.throws(() => validateWavAudio(data), code('invalid_audio'));
  const extraChunk = Buffer.concat([wav(), Buffer.from('JUNK\x00\x00\x00\x00')]);
  extraChunk.writeUInt32LE(extraChunk.length - 8, 4);
  assert.throws(() => validateWavAudio(extraChunk), code('invalid_audio'));
});

test('WAV input admits only ArrayBuffer/Uint8Array and rejects proxies, shared backing and detached buffers', () => {
  for (const value of [null, {}, [], new Uint16Array(4000), new DataView(new ArrayBuffer(4000)), new Proxy(wav(), {})]) assert.throws(() => validateWavAudio(value), code('invalid_audio'));
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => validateWavAudio(new Uint8Array(new SharedArrayBuffer(4000))), code('invalid_audio'));
  const buffer = Uint8Array.from(wav()).buffer;
  structuredClone(buffer, { transfer: [buffer] });
  assert.throws(() => validateWavAudio(buffer), code('invalid_audio'));
  const data = Uint8Array.from(wav());
  Object.defineProperties(data, { byteLength: { get() { throw Error('untrusted getter'); } }, buffer: { get() { throw Error('untrusted getter'); } } });
  assert.equal(validateWavAudio(data).durationMs, 100);
});

test('ASR posts canonical WAV multipart and only explicit model/format to local HTTP, with key only in Authorization', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, { text: '这是合成录音的模拟识别结果。', ignored: 'not returned' }));
  const audio = wav(), apiKey = 'synthetic-asr-key-only-for-local-tests';
  const result = await transcribeAudio(options(`${baseUrl}/v1/audio/transcriptions?api-version=2026-01-01`, { audio, apiKey }));
  assert.deepEqual(result, { text: '这是合成录音的模拟识别结果。' });
  assert.equal(requests.length, 1);
  const sent = requests[0], body = sent.body.toString('latin1');
  assert.equal(sent.method, 'POST'); assert.equal(sent.path, '/v1/audio/transcriptions?api-version=2026-01-01');
  assert.equal(sent.headers.authorization, `Bearer ${apiKey}`); assert.equal(sent.headers.accept, 'application/json');
  assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(body, /name="file"; filename="voice\.wav"\r\nContent-Type: audio\/wav/);
  assert.ok(sent.body.includes(audio)); assert.match(body, /name="model"\r\n\r\nsynthetic-asr-model\r\n/);
  assert.match(body, /name="response_format"\r\n\r\njson\r\n/);
  assert.equal(body.includes(apiKey), false); assert.equal(sent.path.includes(apiKey), false);
  assert.equal(body.includes('chat/completions'), false);
});

test('local ASR works without a key and accepts an empty transcript for silence', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, { text: '' }));
  assert.deepEqual(await transcribeAudio(options(baseUrl)), { text: '' });
  assert.equal(requests[0].headers.authorization, undefined); assert.equal(requests[0].path, '/v1/audio/transcriptions');
});
test('shared speech service full synthesis endpoint maps to the same prefix transcription endpoint',async t=>{
  const {baseUrl,requests}=await fixture(t,(_request,response)=>json(response,{text:'shared speech service'}));
  for(const prefix of ['/v1','/custom',''])await transcribeAudio(options(`${baseUrl}${prefix}/audio/speech?api-version=fixture`));
  assert.deepEqual(requests.map(item=>item.path),['/v1/audio/transcriptions?api-version=fixture','/custom/audio/transcriptions?api-version=fixture','/audio/transcriptions?api-version=fixture']);
});

test('configuration and invalid audio fail before any fetch; chat settings never substitute for speech settings', async t => {
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('must not fetch'); });
  for (const input of [
    { settings: { baseUrl: 'https://example.invalid/v1', model: 'chat', transcriptionModel: 'asr' }, audio: wav() },
    { settings: { speechBaseUrl: 'https://example.invalid' }, audio: wav() },
    { settings: { speechBaseUrl: 'https://example.invalid', transcriptionModel: 'a\nb' }, audio: wav() },
    options('https://example.invalid', { apiKey: 'secret\r\nInjected: value' }),
    options('https://example.invalid', { audio: Buffer.alloc(999) })
  ]) await assert.rejects(transcribeAudio(input), error => error instanceof ASRProviderError);
  assert.equal(fetched, 0);
});

test('a key hidden in arbitrary or repeatedly encoded URL query data is rejected before request', async t => {
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('must not fetch'); });
  const apiKey = 'synthetic:key/with+symbols';
  for (const value of [encodeURIComponent(apiKey), encodeURIComponent(encodeURIComponent(apiKey))]) {
    await assert.rejects(transcribeAudio(options(`https://example.invalid?deployment=${value}`, { apiKey })), code('configuration'));
  }
  assert.equal(fetched, 0);
});

test('malformed UTF-8 or percent parameters cannot hide an encoded key elsewhere in the URL', async t => {
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('unexpected local mock invocation'); });
  const apiKey = 'synthetic:secret/for+url', encoded = encodeURIComponent(apiKey);
  for (const unrelated of ['%E0', '%FF', '%ED%A0%80', '%', '%2', '%ZZ', '%25E0']) {
    await assert.rejects(transcribeAudio(options(`https://example.invalid?bad=${unrelated}&deployment=${encoded}`, { apiKey })), error => {
      assert.equal(error.code, 'configuration');
      const exposed = `${error.stack} ${JSON.stringify(error)}`;
      assert.equal(exposed.includes(apiKey), false); assert.equal(exposed.includes(encoded), false);
      return true;
    });
  }
  assert.equal(fetched, 0);
});

test('raw, mixed and deeply encoded URL keys are rejected to a stable decode bound despite unrelated bad data', async t => {
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('unexpected local mock invocation'); });
  const apiKey = 'synthetic:secret/for+url', variants = [apiKey, encodeURIComponent(apiKey).replace('synthetic', '%73ynthetic')];
  let encoded = apiKey;
  for (let depth = 1; depth <= 24; depth++) { encoded = encodeURIComponent(encoded); if ([2, 5, 12, 24].includes(depth)) variants.push(encoded); }
  for (const value of variants) {
    await assert.rejects(transcribeAudio(options(`https://example.invalid?bad=%E0%ZZ&deployment=${value}`, { apiKey })), error => {
      assert.equal(error.code, 'configuration'); assert.equal(error.message.includes(apiKey), false); assert.equal(error.message.includes(value), false);
      return true;
    });
  }
  assert.equal(fetched, 0);
});

test('tolerant key checking preserves unrelated malformed query data without modifying its request or borrowing credentials', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, { text: 'safe synthetic query' }));
  const apiKey = 'synthetic-header-only-key';
  assert.deepEqual(await transcribeAudio(options(`${baseUrl}?bad=%E0%ZZ&api-version=2026-01-01`, { apiKey })), { text: 'safe synthetic query' });
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/v1/audio/transcriptions?bad=%E0%ZZ&api-version=2026-01-01');
  assert.equal(requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(requests[0].path.includes(apiKey), false); assert.equal(requests[0].body.includes(Buffer.from(apiKey)), false);
});

test('redirects are not followed and do not forward the Authorization header to a second origin', async t => {
  const target = await fixture(t, (_request, response) => json(response, { text: 'must not reach' }));
  const source = await fixture(t, (_request, response) => { response.writeHead(307, { Location: `${target.baseUrl}/stolen` }); response.end(); });
  await assert.rejects(transcribeAudio(options(source.baseUrl, { apiKey: 'synthetic-redirect-key' })), code('network'));
  assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 0);
});

test('HTTP errors retain useful fixed status hints and never expose raw, escaped or encoded server echoes', async t => {
  const apiKey = 'synthetic:secret/for-local-echo-test';
  const unicode = [...apiKey].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, { error: { message: `remote-detail ${apiKey} ${unicode} ${encodeURIComponent(apiKey)} Bearer ${apiKey}` } }, 401));
  await assert.rejects(transcribeAudio(options(baseUrl, { apiKey })), error => {
    assert.equal(error.code, 'http_error'); assert.equal(error.status, 401); assert.match(error.message, /密钥/);
    const exposed = `${error.stack} ${JSON.stringify(error)}`;
    for (const value of [apiKey, unicode, encodeURIComponent(apiKey), 'remote-detail']) assert.equal(exposed.includes(value), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('successful error envelopes, malformed JSON, HTML and wrong text shape are not accepted as transcripts', async t => {
  const cases = [
    ['application/json', JSON.stringify({ error: { message: 'synthetic-secret' } }), 'provider_error'],
    ['application/json', '{invalid', 'invalid_json'], ['text/html', '<html>login</html>', 'html_response'],
    ['application/json', JSON.stringify({ text: 7 }), 'invalid_response'], ['application/json', '[]', 'invalid_response'],
    ['application/json', JSON.stringify({ text: '\ud800' }), 'invalid_response']
  ];
  let index = 0;
  const { baseUrl } = await fixture(t, (_request, response) => { const [type, body] = cases[index++]; response.writeHead(200, { 'Content-Type': type }); response.end(body); });
  for (const [, , expected] of cases) await assert.rejects(transcribeAudio(options(baseUrl)), code(expected));
});

test('UTF-8 decoding is bounded and handles split multi-byte transcript characters', async t => {
  let count = 0;
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (count++ === 0) {
      const body = Buffer.from(JSON.stringify({ text: '你好🎙️' })), split = body.indexOf(Buffer.from('你')) + 1;
      response.write(body.subarray(0, split)); setImmediate(() => response.end(body.subarray(split)));
    } else response.end(Buffer.from([123, 34, 116, 101, 120, 116, 34, 58, 34, 0xff, 34, 125]));
  });
  assert.deepEqual(await transcribeAudio(options(baseUrl)), { text: '你好🎙️' });
  await assert.rejects(transcribeAudio(options(baseUrl)), code('invalid_response'));
});

test('transcript limit counts Unicode code points and rejects 200001 characters', async t => {
  let count = 0;
  const { baseUrl } = await fixture(t, (_request, response) => json(response, { text: count++ === 0 ? '🎙'.repeat(200000) : '字'.repeat(200001) }));
  assert.equal([...(await transcribeAudio(options(baseUrl))).text].length, 200000);
  await assert.rejects(transcribeAudio(options(baseUrl)), code('text_too_large'));
});

test('response byte cap accepts exactly 1 MiB but stops declared and chunked overflow', async t => {
  let count = 0, streamClosed;
  const closed = new Promise(resolve => { streamClosed = resolve; });
  const { baseUrl } = await fixture(t, (_request, response) => {
    const index = count++;
    if (index === 0) {
      const content = JSON.stringify({ text: 'bounded' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(content + ' '.repeat(ASR_LIMITS.MAX_RESPONSE_BYTES - Buffer.byteLength(content)));
    } else if (index === 1) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': ASR_LIMITS.MAX_RESPONSE_BYTES + 1 }); response.end(' ');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.on('close', streamClosed);
      response.write(' '.repeat(ASR_LIMITS.MAX_RESPONSE_BYTES)); response.write(' ');
    }
  });
  assert.deepEqual(await transcribeAudio(options(baseUrl)), { text: 'bounded' });
  await assert.rejects(transcribeAudio(options(baseUrl)), code('response_too_large'));
  await assert.rejects(transcribeAudio(options(baseUrl)), code('response_too_large'));
  await closed;
});

test('pre-abort causes no request and abort during response closes it without automatic retries', async t => {
  let started, closed;
  const ready = new Promise(resolve => { started = resolve; }), ended = new Promise(resolve => { closed = resolve; });
  const { baseUrl, requests } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"text":"');
    response.on('close', closed); started();
  });
  await assert.rejects(transcribeAudio(options(baseUrl, { signal: AbortSignal.abort(Error('synthetic abort secret')) })), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  const controller = new AbortController(), pending = transcribeAudio(options(baseUrl, { signal: controller.signal }));
  await ready; controller.abort(Error('synthetic abort reason never exposed'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('synthetic'));
  await ended;
  assert.equal(requests.length, 1);
});

test('120 second timeout aborts the request once and reports timeout without reflecting provider errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, capturedSignal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    attempts++; capturedSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('synthetic timeout cause must be hidden')), { once: true }));
  });
  const pending = transcribeAudio(options('http://127.0.0.1:9999'));
  t.mock.timers.tick(ASR_LIMITS.REQUEST_TIMEOUT_MS - 1);
  assert.equal(capturedSignal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, error => error.code === 'timeout' && !error.message.includes('synthetic'));
  assert.equal(capturedSignal.aborted, true); assert.equal(attempts, 1);
});

test('local network disconnect reports a fixed safe error without retry', async t => {
  const { baseUrl, requests } = await fixture(t, (request) => request.socket.destroy());
  await assert.rejects(transcribeAudio(options(baseUrl, { apiKey: 'synthetic-key-for-local-disconnect' })), error => error.code === 'network' && error.cause === undefined && !error.message.includes('synthetic'));
  assert.equal(requests.length, 1);
});
