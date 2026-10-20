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
  assert.deepEqual(result.toolCalls, []); assert.equal(result.finishReason, null);
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

const tool = name => ({ type: 'function', function: { name, description: 'local tool', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false }, strict: true } });
const call = (id = 'call_one', name = 'list_files', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

test('provider merges interleaved tool id/name/arguments fragments by index without text', async t => {
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { role: 'assistant', content: null, tool_calls: [{ index: 1, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"id":' } }, { index: 0, id: 'call_', type: 'function', function: { name: 'list_', arguments: '{"query":"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'files', arguments: '中文' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'two', function: { name: 'file', arguments: '"file_1"}' } }, { index: 0, function: { arguments: '"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
    ];
    const bytes = Buffer.from(chunks.map(sse).join('') + 'data: [DONE]\n\n');
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    response.write(bytes.subarray(0, split)); setTimeout(() => response.end(bytes.subarray(split)), 5);
  });
  const deltas = [];
  const result = await streamCompletion({ settings: { baseUrl, model: 'local' }, messages, tools: [tool('list_files'), tool('read_file')], toolChoice: 'auto', onDelta: text => deltas.push(text) });
  assert.deepEqual(result, { content: '', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, toolCalls: [call('call_one', 'list_files', '{"query":"中文"}'), call('call_two', 'read_file', '{"id":"file_1"}')], finishReason: 'tool_calls' });
  assert.deepEqual(deltas, []);
});

test('tool declarations, choices and history expose API fields only, with the key only in authorization', async t => {
  const apiKey = 'mock-provider-key-never-in-json';
  const declaration = tool('list_files');
  declaration.execute = () => apiKey; declaration.apiKey = apiKey; declaration.function.localCredentials = { apiKey };
  const previousCall = { ...call(), internalKey: apiKey, function: { ...call().function, apiKey } };
  const history = [...messages, { role: 'assistant', content: null, tool_calls: [previousCall], apiKey }, { role: 'tool', tool_call_id: 'call_one', content: '{"files":[]}', localState: { apiKey } }];
  const { baseUrl, requests } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] })); });
  const result = await streamCompletion({ settings: { baseUrl, model: 'local', apiKey }, apiKey, messages: history, tools: [declaration], toolChoice: { type: 'function', function: { name: 'list_files', apiKey }, apiKey } });
  const sent = requests[0];
  assert.equal(sent.authorization, `Bearer ${apiKey}`); assert.equal(JSON.stringify(sent.body).includes(apiKey), false);
  assert.deepEqual(sent.body.tools, [tool('list_files')]);
  assert.deepEqual(sent.body.tool_choice, { type: 'function', function: { name: 'list_files' } });
  assert.deepEqual(sent.body.messages, [...messages, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', content: '{"files":[]}', tool_call_id: 'call_one' }]);
  assert.equal(result.finishReason, 'stop'); assert.deepEqual(result.toolCalls, []);
});

test('JSON fallback accepts tool-only and mixed responses with accurate or inaccurate content types', async t => {
  const { baseUrl } = await fixture(t, (request, response) => {
    const plain = request.url.startsWith('/plain');
    response.writeHead(200, { 'Content-Type': plain ? 'text/plain' : 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: plain ? '正在查找' : null, tool_calls: [call()] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 7 } }));
  });
  for (const suffix of ['', '/plain']) {
    const seen = [], result = await streamCompletion({ settings: { baseUrl: baseUrl + suffix, model: 'local' }, messages, tools: [tool('list_files')], toolChoice: 'required', onDelta: text => seen.push(text) });
    assert.equal(result.content, suffix ? '正在查找' : ''); assert.deepEqual(result.toolCalls, [call()]); assert.equal(result.finishReason, 'tool_calls'); assert.deepEqual(result.usage, { total_tokens: 7 });
    assert.deepEqual(seen, suffix ? ['正在查找'] : []);
  }
});

test('SSE rejects malformed, sparse, duplicate and out-of-range tool indices without echoing data', async t => {
  const apiKey = 'mock-index-secret-only-for-redaction';
  const cases = [
    [{ index: -1, ...call() }], [{ index: 16, ...call() }], [{ index: 0.5, ...call() }], [{ index: '0', ...call() }],
    [{ index: 1, ...call() }], [{ index: 0, ...call() }, { index: 0, ...call('call_two') }],
    [{ index: 0, ...call() }, { index: 1, ...call() }],
    [{ index: 0, type: 'function', function: { name: 'list_files', arguments: '{}' } }],
    [{ index: 0, ...call('call_one', `${apiKey}/invalid`) }],
    [{ index: 0, id: 'call_one', type: 'function', function: { name: 'list_files' } }],
    [{ index: 0, ...call(), function: { name: 'list_files', arguments: { value: apiKey } } }],
    { index: 0, ...call() }
  ];
  const { baseUrl } = await fixture(t, (_request, response, requests) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse({ choices: [{ delta: { tool_calls: cases[requests.length - 1] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'); });
  for (let index = 0; index < cases.length; index++) await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, apiKey, messages }), error => error.code === 'invalid_tool_calls' && !error.message.includes(apiKey), `case ${index}`);
});

test('JSON tool calls require unique ids, valid names and string arguments even alongside text', async t => {
  const cases = [[call('')], [call('contains space')], [call('x'.repeat(257))], [call(), call()], [call('ok', 'invalid.name')], [call('ok', 'x'.repeat(65))], [{ ...call(), type: 'custom' }], [{ ...call(), function: { name: 'list_files' } }], [call('ok', 'list_files', null)], { unexpected: true }];
  const { baseUrl } = await fixture(t, (_request, response, requests) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'partial', tool_calls: cases[requests.length - 1] } }] })); });
  for (let index = 0; index < cases.length; index++) await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, messages }), error => error.code === 'invalid_tool_calls', `case ${index}`);
});

test('tool argument and call count bounds are enforced for JSON and fragmented SSE', async t => {
  const argumentsAtLimit = `{"q":"${'x'.repeat(255992)}"}`;
  assert.equal(argumentsAtLimit.length, 256000);
  const cases = [
    { json: Array.from({ length: 16 }, (_, index) => call(`call_${index}`, 'list_files', index ? '{}' : argumentsAtLimit)), ok: true },
    { json: Array.from({ length: 17 }, (_, index) => call(`call_${index}`)) },
    { json: [call('call_one', 'list_files', argumentsAtLimit + ' ')] },
    { fragments: [argumentsAtLimit.slice(0, 123456), argumentsAtLimit.slice(123456)], ok: true },
    { fragments: [argumentsAtLimit, ' '] }
  ];
  const { baseUrl } = await fixture(t, (_request, response, requests) => {
    const item = cases[requests.length - 1];
    response.writeHead(200, { 'Content-Type': item.json ? 'application/json' : 'text/event-stream' });
    if (item.json) response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: item.json }, finish_reason: 'tool_calls' }] }));
    else response.end(item.fragments.map((args, index) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...(index ? {} : { id: 'call_one', type: 'function' }), function: { ...(index ? {} : { name: 'list_files' }), arguments: args } }] } }] })).join('') + 'data: [DONE]\n\n');
  });
  for (const item of cases) {
    const pending = streamCompletion({ settings: { baseUrl, model: 'local' }, messages });
    if (item.ok) { const result = await pending; assert.equal(result.toolCalls[0].function.arguments, argumentsAtLimit); assert.equal(result.toolCalls.length, item.json ? 16 : 1); }
    else await assert.rejects(pending, error => error.code === 'invalid_tool_calls');
  }
});

test('invalid or oversized tool declarations and tool history fail before any HTTP request', async t => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"choices":[{"message":{"content":"ok"}}]}'); });
  const settings = { baseUrl, model: 'local' }, circular = {}; circular.self = circular;
  let deep = {}; for (let index = 0; index < 40; index++) deep = { child: deep };
  const invalid = [
    { tools: {} }, { tools: Array.from({ length: 65 }, (_, index) => tool(`tool_${index}`)) }, { tools: [tool('same'), tool('same')] }, { tools: [tool('invalid.name')] },
    { tools: [{ ...tool('ok'), type: 'custom' }] }, { tools: [{ type: 'function', function: { name: 'ok', description: 'x'.repeat(16001) } }] },
    { tools: [{ type: 'function', function: { name: 'ok', parameters: { description: 'x'.repeat(256001) } } }] },
    { tools: [{ type: 'function', function: { name: 'ok', parameters: circular } }] }, { tools: [{ type: 'function', function: { name: 'ok', parameters: deep } }] },
    { tools: [tool('ok')], toolChoice: 'invalid' }, { toolChoice: 'required' }, { tools: [tool('ok')], toolChoice: { type: 'function', function: { name: 'missing' } } },
    { messages: [{ role: 'tool', content: 'result' }] }, { messages: [{ role: 'assistant', tool_calls: [call(), call()] }] },
    { messages: [{ role: 'assistant', tool_calls: [call('ok', 'list_files', 'x'.repeat(256001))] }] }
  ];
  for (let index = 0; index < invalid.length; index++) await assert.rejects(streamCompletion({ settings, messages, ...invalid[index] }), error => error.code === 'input', `case ${index}`);
  assert.equal(requests.length, 0);
  await streamCompletion({ settings, messages, tools: Array.from({ length: 64 }, (_, index) => tool(`tool_${index}`)), toolChoice: 'auto' });
  assert.equal(requests[0].body.tools.length, 64);
  await streamCompletion({ settings, messages, tools: [], toolChoice: 'none' });
  assert.equal('tools' in requests[1].body, false); assert.equal(requests[1].body.tool_choice, 'none');
});

test('empty content without calls still fails for JSON and SSE', async t => {
  const { baseUrl } = await fixture(t, (request, response) => {
    const json = request.url.startsWith('/json'); response.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/event-stream' });
    response.end(json ? '{"choices":[{"message":{"content":null,"tool_calls":[]},"finish_reason":"stop"}]}' : sse({ choices: [{ delta: { content: null, tool_calls: [] }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  for (const suffix of ['', '/json']) await assert.rejects(streamCompletion({ settings: { baseUrl: baseUrl + suffix, model: 'local' }, messages }), error => error.code === 'empty_response');
});

test('tool-only streaming cancellation closes the connection and never returns pending calls', async t => {
  const controller = new AbortController(); let closed = false;
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...call() }] } }] }));
    const timer = setInterval(() => response.write(': waiting\n\n'), 50);
    response.on('close', () => { closed = true; clearInterval(timer); }); setTimeout(() => controller.abort(), 25);
  });
  const seen = [];
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, messages, signal: controller.signal, onDelta: text => seen.push(text) }), { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, true); assert.deepEqual(seen, []);
});

test('streamed provider errors redact mocked credentials after a tool fragment', async t => {
  const apiKey = 'mock-stream-error-secret';
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...call() }] } }] }) + sse({ error: { message: `failed ${apiKey} Bearer another-private-value` } })); });
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, apiKey, messages }), error => error.code === 'provider_error' && !error.message.includes(apiKey) && !error.message.includes('another-private-value'));
});

test('tool streams retain the existing total response byte limit', async t => {
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...call() }] } }] }) + `:${'x'.repeat(16 * 1024 * 1024)}\n\n`); });
  await assert.rejects(streamCompletion({ settings: { baseUrl, model: 'local' }, messages }), error => error.code === 'response_too_large');
});
