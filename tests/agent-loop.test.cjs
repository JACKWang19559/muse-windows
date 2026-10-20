'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentConversation } = require('../backend/agent-loop.cjs');
const { normalizeToolTrace, traceHistory } = require('../backend/tool-trace.cjs');

const messages = [{ role: 'user', content: '请整理资料' }];
const settings = { baseUrl: 'http://unused.invalid/v1', model: 'mock-only' };
const clone = value => JSON.parse(JSON.stringify(value));
const call = (id, name = 'workspace_list_files', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const tools = [{ type: 'function', function: { name: 'workspace_list_files', parameters: { type: 'object', properties: {} } } }];
const runtimeWith = execute => ({ getTools: () => tools, execute });
const terminal = trace => trace.every(round => round.calls.every(item => ['complete', 'denied', 'error', 'cancelled'].includes(item.status) && typeof item.result === 'string'));

test('ordinary chat remains compatible with a provider stub without toolCalls or runtime', async () => {
  const texts = [], requests = [];
  const result = await runAgentConversation({ provider: { streamCompletion: async input => { requests.push(input); input.onDelta('你好'); input.onDelta('世界'); return { content: '你好世界', usage: { total_tokens: 3 } }; } }, settings, messages, onText: value => texts.push(value) });
  assert.deepEqual(result, { content: '你好世界', toolTrace: [], usage: { total_tokens: 3 } });
  assert.equal('tools' in requests[0], false); assert.equal('toolChoice' in requests[0], false);
  assert.deepEqual(texts, [{ delta: '', content: '' }, { delta: '你好', content: '你好' }, { delta: '世界', content: '你好世界' }]);
});

test('multi-tool rounds append complete assistant/tool history and sum usage while resetting current text', async () => {
  const original = clone(messages), requests = [], snapshots = [], texts = [], executed = [];
  const responses = [
    { content: '先列出资料', toolCalls: [call('list_1'), call('read_1', 'workspace_read_file', '{"id":"file_1"}')], finishReason: 'tool_calls', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    { content: '再核对一份', toolCalls: [call('read_2', 'workspace_read_file', '{"id":"file_2"}')], finishReason: 'tool_calls', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    { content: '已整理完成', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  ];
  const result = await runAgentConversation({ provider: { streamCompletion: async input => { requests.push(clone({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice })); const response = responses.shift(); input.onDelta(response.content); return response; } }, settings, messages, runtime: runtimeWith(async value => { executed.push(value.id); return { ok: true, result: { id: value.id } }; }), onText: value => texts.push(value), onTrace: value => snapshots.push(clone(value)) });
  assert.equal(result.content, '已整理完成'); assert.equal(result.toolTrace.length, 2); assert.deepEqual(executed, ['list_1', 'read_1', 'read_2']);
  assert.deepEqual(result.usage, { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 });
  assert.deepEqual(messages, original); assert.deepEqual(requests[1].messages, [...original, ...traceHistory([result.toolTrace[0]])]);
  assert.deepEqual(requests[2].messages, [...original, ...traceHistory(result.toolTrace)]); assert.equal(requests[0].toolChoice, 'auto');
  assert.deepEqual(result.toolTrace.map(round => round.content), ['先列出资料', '再核对一份']); assert.equal(terminal(result.toolTrace), true);
  assert.equal(snapshots.every(snapshot => snapshot.content === ''), true); assert.equal(texts.filter(value => value.content === '').length, 5);
  snapshots.forEach(snapshot => normalizeToolTrace(snapshot.trace));
});

test('denied and failed tools return structured results to the model without aborting the conversation', async () => {
  let requestCount = 0, finalHistory;
  const result = await runAgentConversation({ provider: { streamCompletion: async input => { if (!requestCount++) return { content: '', toolCalls: [call('denied_1'), call('failed_1')] }; finalHistory = clone(input.messages); return { content: '用户拒绝了操作，另一个工具未完成。' }; } }, settings, messages, runtime: runtimeWith(async value => { if (value.id === 'denied_1') return { ok: false, error: { code: 'denied', message: '用户未批准' } }; throw new Error('private backend details'); }) });
  assert.deepEqual(result.toolTrace[0].calls.map(value => value.status), ['denied', 'error']);
  const returned = finalHistory.filter(value => value.role === 'tool').map(value => JSON.parse(value.content));
  assert.equal(returned[0].error.code, 'denied'); assert.equal(returned[1].error.code, 'tool_failed'); assert.equal(JSON.stringify(returned).includes('private backend'), false);
});

test('cancel while awaiting execution fills cancelled results for all unexecuted calls', async () => {
  const controller = new AbortController(), snapshots = [], executed = []; let providerCalls = 0, started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = runAgentConversation({ provider: { streamCompletion: async () => { providerCalls++; return { content: '等待审批', toolCalls: [call('wait_1'), call('never_2')] }; } }, settings, messages, signal: controller.signal, runtime: runtimeWith(value => new Promise((resolve, reject) => { executed.push(value.id); started(); controller.signal.addEventListener('abort', () => reject(new DOMException('mock cancellation', 'AbortError')), { once: true }); })), onTrace: value => snapshots.push(clone(value)) });
  await begun; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(executed, ['wait_1']); assert.equal(providerCalls, 1);
  const trace = snapshots.at(-1).trace; assert.deepEqual(trace[0].calls.map(value => value.status), ['cancelled', 'cancelled']); assert.equal(terminal(trace), true);
  assert.equal(traceHistory(trace).filter(value => value.role === 'tool').length, 2);
});

test('a successful committed write is recorded before cancellation and later calls stay cancelled', async () => {
  const controller = new AbortController(), snapshots = [], executed = []; let providerCalls = 0;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => { providerCalls++; return { content: '', toolCalls: [call('write_1', 'workspace_create_text_file', '{"name":"note.md","content":"hello"}'), call('never_2')] }; } }, settings, messages, signal: controller.signal, runtime: runtimeWith(async value => { executed.push(value.id); controller.abort(); return { ok: true, result: { file: { id: 'new_file', name: 'note.md', size: 5 } } }; }), onTrace: value => snapshots.push(clone(value)) }), { name: 'AbortError' });
  assert.equal(providerCalls, 1); assert.deepEqual(executed, ['write_1']);
  const trace = snapshots.at(-1).trace; assert.deepEqual(trace[0].calls.map(value => value.status), ['complete', 'cancelled']);
  assert.deepEqual(JSON.parse(trace[0].calls[0].result), { ok: true, result: { file: { id: 'new_file', name: 'note.md', size: 5 } } });
  assert.equal(snapshots.some(snapshot => snapshot.trace[0].calls[0].status === 'complete' && snapshot.trace[0].calls[1].status === 'pending'), true);
});

test('credentials split across deltas or JSON escaped in tool arguments never reach persistence or execution', async () => {
  const apiKey = 'mock-key-protected-123', encoded = apiKey.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const texts = [], snapshots = [], requests = []; let providerCalls = 0, executions = 0;
  const result = await runAgentConversation({ provider: { streamCompletion: async input => {
    requests.push(clone(input.messages));
    if (!providerCalls++) { input.onDelta(`准备 ${apiKey.slice(0, 8)}`); input.onDelta(apiKey.slice(8)); input.onDelta(` ${encoded}`); return { content: `准备 ${apiKey} ${encoded}`, toolCalls: [call('sensitive_raw', 'workspace_create_text_file', JSON.stringify({ name: 'secret.md', content: apiKey })), call('sensitive_escaped', 'workspace_create_text_file', `{"name":"secret.md","content":"${encoded}"}`)] }; }
    input.onDelta('已拒绝'); return { content: '已拒绝不安全内容' };
  } }, settings, apiKey, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }), onText: value => texts.push(clone(value)), onTrace: value => snapshots.push(clone(value)) });
  assert.equal(executions, 0); assert.equal(providerCalls, 2); assert.equal(result.toolTrace[0].calls.every(value => value.arguments === '{}' && value.status === 'error'), true);
  for (const value of [texts, snapshots, requests, result]) { const serialized = JSON.stringify(value); assert.equal(serialized.includes(apiKey), false); assert.equal(serialized.includes(encoded), false); }
  assert.equal(result.toolTrace[0].content.includes('[已隐藏密钥]'), true);
});

test('tool receipts and thrown errors redact credentials without retaining unsafe causes', async () => {
  const apiKey = 'mock-key-redact-result', snapshots = []; let count = 0;
  const result = await runAgentConversation({ provider: { streamCompletion: async () => count++ ? { content: 'done' } : { content: '', toolCalls: [call('read_1')] } }, settings, apiKey, messages, runtime: runtimeWith(async () => ({ ok: false, error: { code: 'denied', message: `rejected ${apiKey}` }, result: { text: apiKey } })), onTrace: value => snapshots.push(clone(value)) });
  assert.equal(JSON.stringify(result).includes(apiKey), false); assert.equal(JSON.stringify(snapshots).includes(apiKey), false);
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => { throw Object.assign(new Error(`network ${apiKey}`), { cause: new Error(apiKey) }); } }, settings, apiKey, messages }), error => !error.message.includes(apiKey) && !error.cause);
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: 'ok' }) }, settings, apiKey, messages, onText: () => { throw new Error(`persist ${apiKey}`); } }), error => !error.message.includes(apiKey));
});

test('repeated call ids across rounds or existing history are rejected before execution', async () => {
  let count = 0, executions = 0; const snapshots = [];
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => { count++; return { content: '', toolCalls: [call('same_id')] }; } }, settings, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }), onTrace: value => snapshots.push(clone(value)) }), error => error.code === 'duplicate_tool_call');
  assert.equal(count, 2); assert.equal(executions, 1); assert.equal(terminal(snapshots.at(-1).trace), true);
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: [call('old_id')] }) }, settings, messages: [...messages, { role: 'assistant', content: null, tool_calls: [call('old_id')] }, { role: 'tool', tool_call_id: 'old_id', content: '{"ok":true}' }], runtime: runtimeWith(async () => { executions++; return { ok: true }; }) }), error => error.code === 'duplicate_tool_call');
  assert.equal(executions, 1);
});

test('truncated or filtered tool responses and missing runtimes never execute tools', async () => {
  let executions = 0;
  for (const finishReason of ['length', 'content_filter', 'max_tokens', 'incomplete']) await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: 'partial', toolCalls: [call('cut_1')], finishReason }) }, settings, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }) }), error => error.code === 'incomplete_tool_calls');
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async input => { assert.equal('tools' in input, false); return { content: '', toolCalls: [call('no_runtime')] }; } }, settings, messages }), error => error.code === 'tools_unavailable');
  assert.equal(executions, 0);
});

test('eight tool rounds and sixteen total calls are hard budgets with no automatic continuation', async () => {
  let count = 0, executions = 0; const snapshots = [];
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: [call(`round_${++count}`)] }) }, settings, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }), onTrace: value => snapshots.push(clone(value)) }), error => error.code === 'tool_budget');
  assert.equal(count, 9); assert.equal(executions, 8); assert.equal(snapshots.at(-1).trace.length, 8); assert.equal(terminal(snapshots.at(-1).trace), true);
  count = 0; executions = 0;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: count++ ? [call('extra_17')] : Array.from({ length: 16 }, (_, index) => call(`batch_${index}`)) }) }, settings, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }) }), error => error.code === 'tool_budget');
  assert.equal(executions, 16); assert.equal(count, 2);
});

test('the cumulative argument budget counts UTF-8 bytes rather than only characters', async () => {
  let count = 0, executions = 0;
  const first = `{"text":"${'中'.repeat(87000)}"}`, next = `{"text":"${'中'.repeat(1000)}"}`;
  assert.ok(Buffer.byteLength(first) * 2 <= 512 * 1024); assert.ok(Buffer.byteLength(first) * 2 + Buffer.byteLength(next) > 512 * 1024);
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: count++ ? [call('over_budget', 'workspace_read_file', next)] : [call('large_1', 'workspace_read_file', first), call('large_2', 'workspace_read_file', first)] }) }, settings, messages, runtime: runtimeWith(async () => { executions++; return { ok: true }; }) }), error => error.code === 'tool_budget');
  assert.equal(executions, 2);
});

test('oversized tool JSON is valid and bounded while retaining success and file metadata', async () => {
  let count = 0, finalHistory;
  const result = await runAgentConversation({ provider: { streamCompletion: async input => { if (!count++) return { content: '', toolCalls: [call('large_result')] }; finalHistory = clone(input.messages); return { content: 'saved' }; } }, settings, messages, runtime: runtimeWith(async () => ({ ok: true, result: { file: { id: 'file_saved', name: 'note.md', size: 200000, workspaceId: 'workspace_1' }, preview: { name: 'note.md', text: '中'.repeat(200000), sha256: 'a'.repeat(64), editable: true } } })) });
  const serialized = result.toolTrace[0].calls[0].result, receipt = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized) <= 64 * 1024); assert.equal(receipt.ok, true); assert.equal(receipt.truncated, true); assert.equal(receipt.result.file.id, 'file_saved'); assert.equal(receipt.result.preview.truncated, true);
  assert.equal(finalHistory.at(-1).content, serialized); assert.equal(result.toolTrace[0].calls[0].status, 'complete');
});

test('late deltas from a settled provider round cannot affect the next round', async () => {
  let count = 0, oldDelta; const texts = [];
  const result = await runAgentConversation({ provider: { streamCompletion: async input => {
    if (!count++) { oldDelta = input.onDelta; input.onDelta('planning'); return { content: 'planning', toolCalls: [call('list_1')] }; }
    oldDelta('LATE_OLD_ROUND'); input.onDelta('final'); await new Promise(resolve => setTimeout(resolve, 5)); oldDelta('LATE_AGAIN'); return { content: 'final' };
  } }, settings, messages, runtime: runtimeWith(async () => ({ ok: true })), onText: value => texts.push(clone(value)) });
  oldDelta('AFTER_RETURN'); assert.equal(result.content, 'final'); assert.equal(JSON.stringify(texts).includes('LATE'), false); assert.equal(JSON.stringify(texts).includes('AFTER_RETURN'), false); assert.equal(result.toolTrace[0].content, 'planning');
});

test('async persistence completes before executing a tool and snapshots cannot mutate live state', async () => {
  let count = 0, persistedRunning = false, executed = false; const seen = [];
  const result = await runAgentConversation({ provider: { streamCompletion: async input => { input.onDelta(count ? 'done' : 'plan'); return count++ ? { content: 'done' } : { content: 'plan', toolCalls: [call('list_1')] }; } }, settings, messages, runtime: runtimeWith(async () => { assert.equal(persistedRunning, true); executed = true; return { ok: true }; }), onText: async value => { await Promise.resolve(); seen.push(value.content); }, onTrace: async value => { await new Promise(resolve => setTimeout(resolve, 2)); normalizeToolTrace(value.trace); if (value.trace[0].calls[0].status === 'running') persistedRunning = true; value.trace[0].calls[0].name = 'mutated_observer_copy'; } });
  assert.equal(executed, true); assert.equal(result.toolTrace[0].calls[0].name, 'workspace_list_files'); assert.equal(seen.at(-1), 'done');
});

test('pre-aborted runs perform no provider or runtime activity', async () => {
  let called = false;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => { called = true; return { content: 'no' }; } }, settings, messages, runtime: { getTools: () => { called = true; return tools; }, execute: async () => { called = true; return { ok: true }; } }, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('committed success remains complete when optional receipt data cannot be serialized', async () => {
  const controller = new AbortController(), snapshots = [], cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: [call('committed_1')] }) }, settings, messages, signal: controller.signal, runtime: runtimeWith(async () => { controller.abort(); return { ok: true, result: cyclic }; }), onTrace: value => snapshots.push(clone(value)) }), { name: 'AbortError' });
  const recorded = snapshots.at(-1).trace[0].calls[0]; assert.equal(recorded.status, 'complete'); assert.deepEqual(JSON.parse(recorded.result), { ok: true, result: { truncated: true, unavailable: true } });
});

test('a persistence failure stops execution and still attempts to terminalize the pending trace', async () => {
  const snapshots = []; let first = true, executed = false;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async () => ({ content: '', toolCalls: [call('persist_1'), call('persist_2')] }) }, settings, messages, runtime: runtimeWith(async () => { executed = true; return { ok: true }; }), onTrace: value => { snapshots.push(clone(value)); if (first) { first = false; throw new Error('mock persistence failure'); } } }), /mock persistence failure/);
  assert.equal(executed, false); assert.equal(terminal(snapshots.at(-1).trace), true); assert.deepEqual(snapshots.at(-1).trace[0].calls.map(value => value.status), ['error', 'error']);
});

test('stopping a short keyed response delivers safe partial text through onTrace even without tools', async () => {
  const controller = new AbortController(), snapshots = [], apiKey = 'mock-stop-key-123456';
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async input => { input.onDelta('partial'); controller.abort(); throw new DOMException('stopped', 'AbortError'); } }, settings, apiKey, messages, signal: controller.signal, onText: () => { /* The host ignores onText after abort. */ }, onTrace: value => snapshots.push(clone(value)) }), { name: 'AbortError' });
  assert.deepEqual(snapshots.at(-1), { trace: [], content: 'partial' });
});

test('failed streams release ordinary text while discarding literal or escaped credential prefixes', async () => {
  const apiKey = 'mock-stop-key-123456', escaped = apiKey.slice(0, 7).split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const cases = [
    { text: 'partial', expected: 'partial' },
    { text: `partial ${apiKey.slice(0, 10)}`, expected: 'partial ' },
    { text: `partial ${escaped}`, expected: 'partial ' },
    { text: `partial ${escaped}\\u00`, expected: 'partial ' },
    { text: 'partial \\u00', expected: 'partial ' },
    { text: `partial ${apiKey}`, expected: 'partial [已隐藏密钥]' }
  ];
  for (const item of cases) {
    const snapshots = [], texts = [];
    await assert.rejects(runAgentConversation({ provider: { streamCompletion: async input => { input.onDelta(item.text); throw new Error('mock stream failure'); } }, settings, apiKey, messages, onText: value => texts.push(clone(value)), onTrace: value => snapshots.push(clone(value)) }), /mock stream failure/);
    assert.equal(snapshots.at(-1).content, item.expected, item.text); assert.deepEqual(snapshots.at(-1).trace, []);
    assert.equal(JSON.stringify(snapshots).includes(apiKey), false); assert.equal(texts.at(-1).content, item.expected);
  }
});

test('a later failed model round persists only its safe partial text alongside completed tool history', async () => {
  const apiKey = 'mock-later-round-key', snapshots = []; let count = 0;
  await assert.rejects(runAgentConversation({ provider: { streamCompletion: async input => { if (!count++) return { content: 'plan', toolCalls: [call('completed_1')] }; input.onDelta('partial answer'); throw new Error('stream lost'); } }, settings, apiKey, messages, runtime: runtimeWith(async () => ({ ok: true, result: { files: [] } })), onTrace: value => snapshots.push(clone(value)) }), /stream lost/);
  const final = snapshots.at(-1); assert.equal(final.content, 'partial answer'); assert.equal(final.trace[0].content, 'plan'); assert.equal(final.trace[0].calls[0].status, 'complete');
});
