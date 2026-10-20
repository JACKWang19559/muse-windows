'use strict';

// Independent Windows persistence schema. It is not the original Muse wire.
const { types } = require('node:util');
const { normalizeCadence, nextOccurrence } = require('./schedule-time.cjs');
const MAX_SCHEDULES = 500, MAX_SCHEDULE_RUNS = 5000, MAX_RUNS_PER_SCHEDULE = 100;
const fail = message => { throw new Error(message || '计划数据格式无效。'); };
function input(value, keys, label = '计划') {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}格式无效。`);
  for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label}包含不支持的字段。`); }
  return value;
}
function text(value, maximum, label, empty = false) { if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || !empty && !value.trim() || Buffer.from(value).toString('utf8') !== value) fail(`${label}无效或过长。`); return value; }
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('计划引用标识符无效。'); return value; }
function iso(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('计划时间必须是规范 UTC ISO 日期。'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('计划版本无效。'); return value; }
function array(value, maximum, label) { if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail(`${label}数量或格式无效。`); for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label}格式无效。`); } return value; }
function attachments(value) { const result = array(value, 100, '计划附件').map(id); if (new Set(result).size !== result.length) fail('计划附件不能重复。'); return result; }
function providerBinding(value) {
  input(value, ['baseUrl', 'model'], '计划模型绑定'); const baseUrl = text(value.baseUrl, 2048, '计划 API 地址'), model = text(value.model, 500, '计划模型名称');
  let url; try { url = new URL(baseUrl); } catch { fail('计划模型地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || baseUrl !== baseUrl.trim() || model !== model.trim()) fail('计划模型绑定只能包含有效服务地址和模型名称。');
  return { baseUrl, model };
}
function authorization(value) { input(value, ['approvedAt', 'allowReadTools'], '计划授权'); if (typeof value.allowReadTools !== 'boolean') fail('计划读取权限无效。'); return { approvedAt: iso(value.approvedAt), allowReadTools: value.allowReadTools }; }
function scope(value) { input(value, ['workspaceId', 'attachmentIds'], '计划范围'); return { workspaceId: value.workspaceId === null ? null : id(value.workspaceId), attachmentIds: attachments(value.attachmentIds) }; }
const SCHEDULE_KEYS = ['id','name','prompt','workspaceId','attachmentIds','enabled','cadence','revision','createdAt','updatedAt','nextRunAt','lastRunId','providerBinding','authorization','notification'];
function scheduleShape(value) {
  input(value, SCHEDULE_KEYS);
  if (typeof value.enabled !== 'boolean' || !['all','failures','none'].includes(value.notification)) fail('计划启用或通知选项无效。');
  if (value.enabled && value.nextRunAt === null) fail('启用的计划需要有效的下一次执行时间。');
  const name = text(value.name, 160, '计划名称'); if (/[\p{Cc}\p{Cf}]/u.test(name)) fail('计划名称不能包含控制字符。');
  const result = { id: id(value.id), name, prompt: text(value.prompt, 50000, '计划提示词'), ...scope({ workspaceId: value.workspaceId, attachmentIds: value.attachmentIds }), enabled: value.enabled, cadence: normalizeCadence(value.cadence), revision: revision(value.revision), createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt), nextRunAt: value.nextRunAt === null ? null : iso(value.nextRunAt), providerBinding: providerBinding(value.providerBinding), authorization: authorization(value.authorization), notification: value.notification };
  if (value.lastRunId != null) result.lastRunId = id(value.lastRunId);
  return result;
}
const RUN_STATUSES = ['running','succeeded','failed','cancelled','interrupted'];
const RUN_KEYS = ['id','scheduleId','scheduleRevision','scheduleName','chatId','messageId','scheduledFor','trigger','status','dispatchStarted','createdAt','startedAt','finishedAt','error','scopeSnapshot','providerBinding','authorization'];
function runShape(value) {
  input(value, RUN_KEYS, '计划执行记录');
  if (!RUN_STATUSES.includes(value.status) || !['scheduled','manual'].includes(value.trigger) || typeof value.dispatchStarted !== 'boolean') fail('计划执行状态无效。');
  if ((value.chatId === null) !== (value.messageId === null)) fail('计划对话与消息引用必须同时存在或同时清除。');
  const result = { id: id(value.id), scheduleId: value.scheduleId === null ? null : id(value.scheduleId), scheduleRevision: revision(value.scheduleRevision), scheduleName: text(value.scheduleName, 160, '执行计划名称'), chatId: value.chatId === null ? null : id(value.chatId), messageId: value.messageId === null ? null : id(value.messageId), scheduledFor: iso(value.scheduledFor), trigger: value.trigger, status: value.status, dispatchStarted: value.dispatchStarted, createdAt: iso(value.createdAt), startedAt: iso(value.startedAt), scopeSnapshot: scope(value.scopeSnapshot), providerBinding: providerBinding(value.providerBinding), authorization: authorization(value.authorization) };
  if (value.error != null) result.error = text(value.error, 1400, '计划执行错误', true);
  if (value.finishedAt != null) result.finishedAt = iso(value.finishedAt);
  if (value.status === 'running' ? result.finishedAt != null : result.finishedAt == null) fail('计划终态与完成时间不一致。');
  return result;
}
function initialNextRun(cadence, now) {
  // A newly approved run-once must be in the future. Existing persisted overdue
  // records retain their due instant so claim can catch up exactly once.
  const next = nextOccurrence(cadence, now); if (next === null) fail('此规则没有未来的有效执行时间，请调整日期。'); return next;
}
function pruneRuns(state) {
  const counts = new Map(), retained = new Set(); let total = 0;
  // Never remove a live durable claim. Keep newest appended terminal runs.
  for (const run of state.scheduleRuns) if (run.status === 'running') { retained.add(run.id); total++; if (run.scheduleId !== null) counts.set(run.scheduleId, (counts.get(run.scheduleId) || 0) + 1); }
  if (total > MAX_SCHEDULE_RUNS) fail('正在执行的计划记录超出上限。');
  for (let i = state.scheduleRuns.length - 1; i >= 0; i--) {
    const run = state.scheduleRuns[i]; if (run.status === 'running' || total >= MAX_SCHEDULE_RUNS) continue;
    const key = run.scheduleId; if (key !== null && (counts.get(key) || 0) >= MAX_RUNS_PER_SCHEDULE) continue;
    retained.add(run.id); total++; if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
  }
  state.scheduleRuns = state.scheduleRuns.filter(run => retained.has(run.id));
  for (const schedule of state.schedules) if (schedule.lastRunId && !retained.has(schedule.lastRunId)) delete schedule.lastRunId;
}
module.exports = { MAX_SCHEDULES, MAX_SCHEDULE_RUNS, MAX_RUNS_PER_SCHEDULE, RUN_STATUSES, SCHEDULE_KEYS, RUN_KEYS, input, text, id, iso, revision, array, attachments, providerBinding, authorization, scope, scheduleShape, runShape, initialNextRun, pruneRuns };
