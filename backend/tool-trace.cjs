'use strict';

const { types } = require('node:util');

const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_TRACE_ROUNDS = 8;
const MAX_TRACE_CALLS = 16;
const CALL_STATES = new Set(['pending', 'running', 'awaiting_approval', 'complete', 'denied', 'error', 'cancelled']);
const FINAL_STATES = new Set(['complete', 'denied', 'error', 'cancelled']);
const CANCELLED_RESULT = JSON.stringify({ ok: false, error: { code: 'cancelled', message: '上次操作被中断，未恢复自动执行。' } });
const fail = () => { throw new Error('工具调用记录格式无效或超出容量限制。'); };
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function text(value, max, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || nonempty && !value.length) fail();
  return value;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}
function array(value, min, max) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) fail();
    output.push(descriptor.value);
  }
  return output;
}
function normalizeToolTrace(value) {
  const input = array(value, 0, MAX_TRACE_ROUNDS);
  const ids = new Set();
  const rounds = input.map((sourceRound, index) => {
    const round = record(sourceRound, ['content', 'calls']);
    const calls = array(round.calls, 1, MAX_TRACE_CALLS).map(sourceCall => {
      const call = record(sourceCall, ['id', 'name', 'arguments', 'status', 'result']);
      const id = text(call.id, 256, true), name = text(call.name, 64, true);
      if (/[\s\p{Cc}\p{Cf}]/u.test(id) || !/^[A-Za-z0-9_-]+$/.test(name) || ids.has(id) || !CALL_STATES.has(call.status)) fail();
      ids.add(id);
      const result = { id, name, arguments: text(call.arguments, 256000), status: call.status };
      if (FINAL_STATES.has(call.status)) result.result = text(call.result, 128000);
      else if (call.result != null) fail(); // A result must never imply completion of an active call.
      return result;
    });
    // The next model round cannot begin until every prior tool result exists.
    if (index < input.length - 1 && calls.some(call => !FINAL_STATES.has(call.status))) fail();
    return { content: text(round.content, 2000000), calls };
  });
  // Recovery must be able to append explicit cancellation results without
  // making an otherwise accepted on-disk trace exceed its own size limit.
  if (ids.size > MAX_TRACE_CALLS || Buffer.byteLength(JSON.stringify(rounds)) > MAX_TRACE_BYTES || Buffer.byteLength(JSON.stringify(cancelRounds(rounds))) > MAX_TRACE_BYTES) fail();
  return rounds;
}
function traceHistory(value) {
  const messages = [];
  for (const round of normalizeToolTrace(value)) {
    if (round.calls.some(call => !FINAL_STATES.has(call.status))) break;
    messages.push({ role: 'assistant', content: round.content || null, tool_calls: round.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
    for (const call of round.calls) messages.push({ role: 'tool', tool_call_id: call.id, content: call.result });
  }
  return messages;
}
function cancelRounds(rounds) { return rounds.map(round => ({ ...round, calls: round.calls.map(call => FINAL_STATES.has(call.status) ? call : { ...call, status: 'cancelled', result: CANCELLED_RESULT }) })); }
function cancelToolTrace(value) { return cancelRounds(normalizeToolTrace(value)); }
function hasUnfinishedToolCalls(value) { return normalizeToolTrace(value).some(round => round.calls.some(call => !FINAL_STATES.has(call.status))); }
function remapToolTrace(value, { fileIds = new Map(), workspaceIds = new Map(), artifactIds = new Map(), buildIds = new Map(), scheduleIds = new Map(), runIds = new Map(), chatIds = new Map(), messageIdsByChat = new Map() } = {}) {
  if ([fileIds, workspaceIds, artifactIds, buildIds, scheduleIds, runIds, chatIds, messageIdsByChat].some(mapping => types.isProxy(mapping) || !(mapping instanceof Map))) fail();
  for (const mapping of messageIdsByChat.values()) if (types.isProxy(mapping) || !(mapping instanceof Map)) fail();
  const known = new Set(['workspace_list_files', 'workspace_read_file', 'workspace_create_text_file', 'workspace_save_text_file']);
  const appTools = new Set(['muse_list_apps', 'muse_read_app', 'muse_create_app', 'muse_write_app', 'muse_build_app']);
  const scheduleTools = new Set(['muse_list_schedules', 'muse_read_schedule', 'muse_create_schedule', 'muse_update_schedule', 'muse_pause_schedule', 'muse_delete_schedule', 'muse_run_schedule']);
  const object = candidate => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
  const rewrite = (source, transform) => {
    let parsed;
    try { parsed = JSON.parse(source); } catch { return source; }
    let changed = false;
    const field = (target, key, mapping) => {
      if (!object(target) || !hasOwn(target, key) || typeof target[key] !== 'string') return;
      const replacement = mapping.get(target[key]);
      if (typeof replacement === 'string' && replacement !== target[key]) { target[key] = replacement; changed = true; }
    };
    const list = (target, key, mapping) => {
      if (!object(target) || !Array.isArray(target[key])) return;
      for (let index = 0; index < target[key].length; index++) {
        const previous = target[key][index], replacement = typeof previous === 'string' ? mapping.get(previous) : undefined;
        if (typeof replacement === 'string' && replacement !== previous) { target[key][index] = replacement; changed = true; }
      }
    };
    transform(parsed, field, list);
    // Historical malformed/deep JSON remains opaque, rather than breaking an
    // otherwise readable history entry or inventing a replacement result.
    if (!changed) return source;
    try { return JSON.stringify(parsed); } catch { return source; }
  };
  const rounds = normalizeToolTrace(value).map(round => ({ ...round, calls: round.calls.map(call => {
    if (!known.has(call.name) && !appTools.has(call.name) && !scheduleTools.has(call.name)) return call;
    const result = { ...call };
    if (call.name === 'workspace_read_file' || call.name === 'workspace_save_text_file') {
      result.arguments = rewrite(call.arguments, (args, field) => field(args, 'id', fileIds));
    }
    if (['muse_read_app', 'muse_write_app', 'muse_build_app'].includes(call.name)) {
      result.arguments = rewrite(call.arguments, (args, field) => field(args, 'id', artifactIds));
    }
    if (scheduleTools.has(call.name)) result.arguments = rewrite(call.arguments, (args, field, list) => {
      if (['muse_read_schedule', 'muse_update_schedule', 'muse_pause_schedule', 'muse_delete_schedule', 'muse_run_schedule'].includes(call.name)) field(args, 'id', scheduleIds);
      if (['muse_create_schedule', 'muse_update_schedule'].includes(call.name)) list(args, 'attachmentIds', fileIds);
    });
    if (call.result != null) result.result = rewrite(call.result, (envelope, field, list) => {
      if (!object(envelope) || envelope.ok !== true || !object(envelope.result)) return;
      const payload = envelope.result;
      if (call.name === 'workspace_list_files' && Array.isArray(payload.files)) {
        for (const file of payload.files) { field(file, 'id', fileIds); field(file, 'workspaceId', workspaceIds); }
      } else if (call.name === 'workspace_read_file') {
        field(payload, 'id', fileIds);
      } else if (call.name === 'workspace_create_text_file' || call.name === 'workspace_save_text_file') {
        field(payload.file, 'id', fileIds); field(payload.file, 'workspaceId', workspaceIds);
        field(payload.preview, 'id', fileIds);
      } else if (appTools.has(call.name)) {
        // Artifact source, page HTML, arbitrary app data and display names are
        // opaque history. Only known receipt identity slots may be remapped.
        const app = target => {
          if (!object(target)) return;
          field(target, 'id', artifactIds); field(target, 'workspaceId', workspaceIds);
          if (Array.isArray(target.builds)) for (const build of target.builds) field(build, 'id', buildIds);
        };
        app(payload.app);
        if (Array.isArray(payload.apps)) for (const item of payload.apps) app(item);
        field(payload, 'buildId', buildIds);
      } else if (scheduleTools.has(call.name)) {
        // Only schema-defined identity slots are relationships. Prompt text,
        // cadence, provider binding and arbitrary nested data remain opaque.
        const schedule = target => {
          if (!object(target)) return;
          field(target, 'id', scheduleIds); field(target, 'workspaceId', workspaceIds);
          list(target, 'attachmentIds', fileIds); field(target, 'lastRunId', runIds);
        };
        if (call.name === 'muse_list_schedules' && Array.isArray(payload.schedules)) for (const item of payload.schedules) schedule(item);
        if (['muse_read_schedule', 'muse_create_schedule', 'muse_update_schedule', 'muse_pause_schedule'].includes(call.name)) schedule(payload.schedule);
        if (['muse_create_schedule', 'muse_update_schedule', 'muse_pause_schedule', 'muse_run_schedule'].includes(call.name)) field(payload, 'id', scheduleIds); // Minimal committed receipt.
        if (call.name === 'muse_delete_schedule') field(payload, 'deletedId', scheduleIds);
        if (call.name === 'muse_run_schedule') {
          field(payload, 'scheduleId', scheduleIds); field(payload, 'runId', runIds); field(payload, 'chatId', chatIds);
        }
      }
    });
    return result;
  }) }));
  return normalizeToolTrace(rounds);
}
module.exports = { normalizeToolTrace, traceHistory, cancelToolTrace, hasUnfinishedToolCalls, remapToolTrace, MAX_TRACE_BYTES, MAX_TRACE_ROUNDS, MAX_TRACE_CALLS };
