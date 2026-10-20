'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { streamCompletion, listModels, testConnection, configuredUrl, SSEParser } = require('../backend/provider.cjs');

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null }); handler(request, response, requests); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}
const messages = [{ role: 'user', content: '测试' }];

test('provider normalizes roots, v1 prefixes and full endpoint URLs', () => {
  assert.equal(configuredUrl({ baseUrl: 'https://example.invalid' }, 'completion').href, 'https://example.invalid/v1/chat/completions');
  assert.equal(configuredUrl({ baseUrl: 'https://example.invalid/v1/' }, 'models').href, 'https://example.invalid/v1/models');
  assert.equal(configuredUrl({ baseUrl: 'https://example.invalid/custom/v1/chat/completions?version=1' }, 'models').href, 'https://example.invalid/custom/v1/models?version=1');
  assert.throws(() => configuredUrl({ baseUrl: 'file:///tmp/x' }, 'models'), /HTTP/);
  assert.throws(() => configuredUrl({ baseUrl: 'https://secret@example.invalid/v1' }, 'models'), /登录信息/);
  assert.throws(() => configuredUrl({ baseUrl: 'https://agent.meta.ai' }, 'models'), /不连接原 Muse/);
});

test('SSE parser preserves multiline data, comments and CRLF split across chunks', () => {
  const received = [], parser = new SSEParser((data, event) => received.push({ data, event }));
  for (const chunk of [':keepalive\r', '\nevent: result\r\ndata: {"a":\r', '\ndata: 1}\r', '\n\r', '\n']) parser.feed(chunk);
  parser.feed('', true);
  assert.deepEqual(received, [{ data: '{"a":\n1}', event: 'result' }]);
});

test('provider streams UTF-8 and multiline SSE through local HTTP', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const source = Buffer.from(': keep alive\r\ndata:\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"，世界"}}]}\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":9}}\r\n\r\ndata: [DONE]\r\n\r\n');
    const split = source.indexOf(Buffer.from('你')) + 1;
    response.write(source.subarray(0, split)); setTimeout(() => { response.write(source.subarray(split, split + 1)); setTimeout(() => response.end(source.subarray(split + 1)), 5); }, 5);
  });
  const deltas = [];
  const result = await streamCompletion({ settings: { baseUrl, model: 'local-model', temperature: 0.2 }, apiKey: 'test-only-key', messages, onDelta: value => deltas.push(value) });
  assert.equal(result.content, '你好，世界'); assert.deepEqual(deltas, ['你好', '，世界']); assert.deepEqual(result.usage, { total_tokens: 9 });
  assert.equal(requests[0].path, '/v1/chat/completions'); assert.equal(requests[0].authorization, 'Bearer test-only-key');
  assert.equal(requests[0].body.stream, true); assert.equal(requests[0].body.temperature, 0.2);
});

test('provider accepts non-streaming JSON fallback without an API key', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'fallback reply' }] } }], usage: { total_tokens: 4 } })); });
  const result = await streamCompletion({ settings: { baseUrl: `${baseUrl}/v1/chat/completions`, model: 'local' }, messages });
  assert.equal(result.content, 'fallback reply'); assert.equal(requests[0].authorization, undefined);
});

test('provider accepts JSON fallback with an inaccurate content type', async t => {
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('{"choices":[{"message":{"content":"plain-json"}}]}'); });
  assert.equal((await streamCompletion({ settings: { baseUrl, model: 'local' }, messages })).content, 'plain-json');
});

test('cancel stops the HTTP response and rejects with AbortError', async t => {
  let closed = false;
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    const timer = setInterval(() => response.write(': waiting\n\n'), 50);
    response.on('close', () => { closed = true; clearInterval(timer); });
  });
  const controller = new AbortController(), seen = [];
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, messages, signal: controller.signal, onDelta: text => { seen.push(text); controller.abort(); } }), { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, true); assert.deepEqual(seen, ['partial']);
});

test('HTTP JSON errors are clear and redact echoed API keys', async t => {
  const apiKey = 'test-echo-key-not-a-real-secret';
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: `Rejected ${apiKey}` } })); });
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, apiKey, messages }), error => error.status === 401 && /密钥/.test(error.message) && !error.message.includes(apiKey));
});

test('HTML responses and malformed streams surface useful errors', async t => {
  const { baseUrl } = await fixture(t, (request, response) => {
    if (request.url.startsWith('/html')) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>login</html>'); }
    else { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: {invalid}\n\n'); }
  });
  await assert.rejects(streamCompletion({ settings: { baseUrl: `${baseUrl}/html`, model: 'local' }, messages }), /网页/);
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, messages }), /无效 JSON/);
});

test('model discovery and connection testing use GET only, never a completion', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"}]}'); });
  assert.deepEqual(await listModels({ settings: { baseUrl } }), ['a-model', 'z-model']);
  assert.equal((await testConnection({ settings: { baseUrl } })).ok, true);
  assert.deepEqual(requests.map(item => [item.method, item.path]), [['GET', '/v1/models'], ['GET', '/v1/models']]);
});

test('network failure and pre-aborted requests are reported without leaking secrets', async () => {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const result = await testConnection({ settings: { baseUrl: `http://127.0.0.1:${port}` }, apiKey: 'test-only-key' });
  assert.equal(result.ok, false); assert.match(result.message, /无法连接/);
  await assert.rejects(listModels({ settings: { baseUrl: `http://127.0.0.1:${port}` }, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
