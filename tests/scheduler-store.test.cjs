'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const model = require('../backend/scheduler-model.cjs');
const START = '2026-01-01T00:00:00.000Z';
const time = minutes => new Date(Date.parse(START) + minutes * 60000).toISOString();
const binding = { baseUrl: 'https://provider.example/v1/chat/completions', model: 'synthetic-test-model' };
const authorization = { approvedAt: START, allowReadTools: false };
function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'scheduler-store-')), dataDir = path.join(root, 'data');
  t.after(() => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^scheduler-store-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, store: new Store(dataDir) };
}
const fields = patch => ({ name: '合成计划', prompt: '总结已授权资料，不要修改文件。', workspaceId: null, attachmentIds: [], enabled: true, cadence: { kind: 'interval', timeZone: 'UTC', everyMinutes: 10, anchorAt: START }, providerBinding: binding, authorization, notification: 'all', ...patch });
const create = (store, patch = {}) => store.createSchedule(fields(patch), START);
const claim = (store, schedule, now = START, trigger = 'manual') => store.claimScheduleRun({ id: schedule.id, expectedRevision: schedule.revision, trigger, now });
const finish = (store, run, patch = {}) => store.finishScheduleRun({ runId: run.id, status: 'succeeded', now: time(1), content: '合成执行结果', ...patch });

test('old schema-v1 state and backups get empty scheduler fields and a false boolean background default', async t => {
  const { store, dataDir } = fixture(t), legacy = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  delete legacy.schedules; delete legacy.scheduleRuns; delete legacy.settings.backgroundTasks; fs.writeFileSync(store.statePath, JSON.stringify(legacy));
  const restored = new Store(dataDir); assert.deepEqual(restored.snapshot().schedules, []); assert.deepEqual(restored.snapshot().scheduleRuns, []); assert.equal(restored.settings().backgroundTasks, false);
  restored.saveSettings({ backgroundTasks: true }); assert.equal(restored.settings().backgroundTasks, true); assert.throws(() => restored.saveSettings({ backgroundTasks: 'true' }));
  const backup = restored.exportData(); delete backup.schedules; delete backup.scheduleRuns; delete backup.settings.backgroundTasks; await restored.importData(backup);
  assert.equal(restored.settings().backgroundTasks, true); assert.deepEqual(restored.snapshot().schedules, []);
});

test('creation normalizes approved records without storing undeclared secrets or host paths', t => {
  const { store } = fixture(t), schedule = create(store, { cadence: { kind: 'interval', timeZone: 'UTC', everyMinutes: 10 } });
  assert.equal(schedule.revision, 1); assert.equal(schedule.nextRunAt, time(10)); assert.equal(schedule.cadence.anchorAt, START); assert.equal(schedule.authorization.allowReadTools, false);
  schedule.prompt = 'mutated observer'; assert.notEqual(store.getSchedule(schedule.id).prompt, schedule.prompt);
  const before = store.snapshot();
  for (const input of [fields({ apiKey: 'synthetic-undeclared-field' }), fields({ providerBinding: { ...binding, apiKey: 'synthetic' } }), fields({ providerBinding: { ...binding, baseUrl: 'file:///private' } }), fields({ authorization: { ...authorization, allowWriteTools: true } }), fields({ authorization: undefined }), fields({ name: 'bad\nname' }), fields({ prompt: '' }), fields({ workspaceId: 'missing' }), fields({ attachmentIds: ['missing'] }), fields({ enabled: null }), fields({ attachmentIds: null }), fields({ notification: null }), fields({ cadence: { kind: 'runonce', timeZone: 'UTC', runAt: START } })]) assert.throws(() => store.createSchedule(input, START));
  assert.deepEqual(store.snapshot(), before);
});

test('schedule updates use CAS and reauthorization fields without widening a stale record', t => {
  const { store } = fixture(t), original = create(store), updated = store.updateSchedule({ id: original.id, expectedRevision: 1, prompt: '新的明确提示词', authorization: { approvedAt: time(1), allowReadTools: true } }, time(1));
  assert.equal(updated.revision, 2); assert.equal(updated.prompt, '新的明确提示词'); assert.equal(updated.nextRunAt, original.nextRunAt);
  assert.throws(() => store.updateSchedule({ id: original.id, expectedRevision: 1, enabled: false }, time(2)), /重新载入/);
  assert.throws(() => store.updateSchedule({ id: original.id, expectedRevision: 2, workspaceId: 'missing' }, time(2)));
  assert.equal(store.getSchedule(original.id).revision, 2);
});

test('an overdue scheduled claim creates chat and run atomically and catches up once before advancing into the future', t => {
  const { store } = fixture(t), schedule = create(store);
  assert.throws(() => claim(store, schedule, time(9), 'scheduled'), /尚未到期/);
  const result = claim(store, schedule, time(151), 'scheduled');
  assert.equal(result.schedule.nextRunAt, time(10)); assert.equal(result.run.scheduledFor, time(10)); assert.equal(store.getSchedule(schedule.id).nextRunAt, time(160));
  assert.equal(result.run.startedAt, time(151)); assert.equal(result.run.status, 'running'); assert.equal(result.run.dispatchStarted, false);
  const chat = store.getChat(result.run.chatId); assert.equal(chat.workspaceId, null); assert.equal(chat.messages[0].content, schedule.prompt); assert.equal(chat.messages[1].id, result.run.messageId); assert.equal(chat.messages[1].status, 'streaming');
  assert.throws(() => claim(store, schedule, time(151), 'scheduled'), /正在执行/);
  for (const filename of [store.statePath, store.backupPath]) { const persisted = JSON.parse(fs.readFileSync(filename, 'utf8')); assert.equal(persisted.scheduleRuns[0].id, result.run.id); assert.equal(persisted.schedules[0].nextRunAt, time(160)); assert.equal(persisted.chats[0].messages[1].id, result.run.messageId); }
});

test('manual execution of a paused plan preserves its automatic cadence and enabled state', t => {
  const { store } = fixture(t), schedule = create(store, { enabled: false }), before = store.getSchedule(schedule.id), result = claim(store, schedule, time(2));
  assert.equal(result.run.trigger, 'manual'); assert.equal(result.run.scheduledFor, time(2)); assert.equal(store.getSchedule(schedule.id).enabled, false); assert.equal(store.getSchedule(schedule.id).nextRunAt, before.nextRunAt);
  assert.throws(() => store.claimScheduleRun({ id: schedule.id, expectedRevision: 1, trigger: 'scheduled', now: time(20) }));
});

test('automatic run-once is exhausted by claim without changing its authorization revision', t => {
  const { store } = fixture(t), schedule = create(store, { cadence: { kind: 'runonce', timeZone: 'UTC', runAt: time(1) } }), result = claim(store, schedule, time(3), 'scheduled');
  assert.equal(store.getSchedule(schedule.id).nextRunAt, null); assert.equal(store.getSchedule(schedule.id).enabled, false); assert.equal(store.getSchedule(schedule.id).revision, 1);
  assert.equal(store.markScheduleDispatched({ runId: result.run.id, now: time(3) }).dispatchStarted, true); finish(store, result.run, { now: time(4) });
  const manual = claim(store, store.getSchedule(schedule.id), time(5)); assert.equal(manual.run.trigger, 'manual'); assert.equal(store.getSchedule(schedule.id).nextRunAt, null); assert.equal(store.getSchedule(schedule.id).enabled, false);
});

test('dispatch decision is durable and exactly one transition is permitted', t => {
  const { store } = fixture(t), schedule = create(store), { run } = claim(store, schedule);
  assert.equal(store.markScheduleDispatched({ runId: run.id, now: START }).dispatchStarted, true);
  for (const filename of [store.statePath, store.backupPath]) assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).scheduleRuns[0].dispatchStarted, true);
  assert.throws(() => store.markScheduleDispatched({ runId: run.id, now: time(1) }), /不允许重发/);
  finish(store, run); assert.throws(() => store.markScheduleDispatched({ runId: run.id, now: time(2) }));
});

test('changed authorization, scope or removed chat fences dispatch before any network request', async t => {
  const { store } = fixture(t), workspace = store.createWorkspace({ name: '资料' }), file = (await store.createTextFile({ name: 'reference.md', content: 'safe reference', workspaceId: workspace.id })).file;
  const first = create(store, { workspaceId: workspace.id, attachmentIds: [file.id] }), a = claim(store, first);
  store.updateSchedule({ id: first.id, expectedRevision: 1, authorization: { approvedAt: time(1), allowReadTools: true } }, time(1));
  assert.throws(() => store.markScheduleDispatched({ runId: a.run.id, now: time(2) }), /授权/); assert.equal(store.getScheduleRun(a.run.id).dispatchStarted, false);
  finish(store, a.run, { status: 'failed', pause: true }); assert.equal(store.getSchedule(first.id).enabled, true, 'old failed run cannot pause a newly authorized revision');
  const second = create(store), b = claim(store, second); store.deleteChat(b.run.chatId); assert.throws(() => store.markScheduleDispatched({ runId: b.run.id, now: time(1) }), /对话/);
  const terminal = finish(store, b.run, { status: 'cancelled' }); assert.equal(terminal.chatId, null); assert.equal(terminal.messageId, null);
  const third = create(store, { workspaceId: workspace.id }), c = claim(store, third); store.updateChat({ id: c.run.chatId, workspaceId: null });
  assert.throws(() => store.markScheduleDispatched({ runId: c.run.id, now: time(1) }), /范围|对话/); assert.equal(store.getScheduleRun(c.run.id).dispatchStarted, false);
});

test('finish preserves safe partial content, cancellation receipts and immutable terminal state', t => {
  const { store } = fixture(t), schedule = create(store, { authorization: { ...authorization, allowReadTools: true } }), { run } = claim(store, schedule);
  store.markScheduleDispatched({ runId: run.id, now: START });
  const trace = [{ content: 'reading', calls: [{ id: 'read_once', name: 'workspace_read_file', arguments: '{"id":"synthetic_file"}', status: 'complete', result: '{"ok":true,"result":{"text":"safe"}}' }, { id: 'read_cancelled', name: 'workspace_read_file', arguments: '{"id":"synthetic_file"}', status: 'running' }] }];
  store.updateMessage(run.chatId, run.messageId, { content: 'safe partial', toolTrace: trace });
  const terminal = store.finishScheduleRun({ runId: run.id, status: 'cancelled', now: time(1), error: 'synthetic cancellation', pause: false });
  const message = store.getChat(run.chatId).messages.at(-1); assert.equal(message.content, 'safe partial'); assert.equal(message.status, 'cancelled'); assert.equal(message.toolTrace[0].calls[0].status, 'complete'); assert.equal(message.toolTrace[0].calls[1].status, 'cancelled');
  assert.equal(terminal.finishedAt, time(1)); assert.equal(store.finishScheduleRun({ runId: run.id, status: 'cancelled', now: time(2), content: 'late overwrite' }).finishedAt, time(1));
  assert.equal(store.getChat(run.chatId).messages.at(-1).content, 'safe partial'); assert.throws(() => finish(store, run), /终态/);
});

test('ordinary text schedules tolerate an empty final trace and provider failure can pause the current revision', t => {
  const { store } = fixture(t), schedule = create(store), { run } = claim(store, schedule);
  finish(store, run, { status: 'failed', content: 'safe fallback', toolTrace: [], error: 'synthetic provider changed', pause: true });
  assert.equal(store.getSchedule(schedule.id).enabled, false); assert.equal(store.getSchedule(schedule.id).revision, 2); assert.equal(store.getChat(run.chatId).messages.at(-1).status, 'error'); assert.equal(store.getChat(run.chatId).messages.at(-1).toolTrace, undefined);
});

test('restart interrupts live runs without replaying, preserving partial text and advanced occurrence identity', t => {
  const { store, dataDir } = fixture(t), schedule = create(store), { run } = claim(store, schedule, time(10), 'scheduled');
  store.markScheduleDispatched({ runId: run.id, now: time(10) }); store.updateMessage(run.chatId, run.messageId, { content: 'partial before restart' });
  const restarted = new Store(dataDir); assert.equal(restarted.getScheduleRun(run.id).status, 'interrupted'); assert.equal(restarted.getScheduleRun(run.id).dispatchStarted, true); assert.equal(restarted.getSchedule(schedule.id).nextRunAt, time(20));
  assert.equal(restarted.getChat(run.chatId).messages.at(-1).content, 'partial before restart'); assert.equal(restarted.getChat(run.chatId).messages.at(-1).status, 'cancelled'); assert.equal(restarted.snapshot().scheduleRuns.length, 1); assert.match(restarted.recoveryNotice, /不会自动重发/);
  for (const filename of [restarted.statePath, restarted.backupPath]) assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).scheduleRuns[0].status, 'interrupted');
});

test('automatic backup recovery pauses all restored plans and clears host background consent', t => {
  const { store, dataDir } = fixture(t), schedule = create(store); store.saveSettings({ backgroundTasks: true });
  const { run } = claim(store, schedule); finish(store, run); fs.writeFileSync(store.statePath, '{synthetic corrupt primary');
  const recovered = new Store(dataDir); assert.equal(recovered.getSchedule(schedule.id).enabled, false); assert.equal(recovered.settings().backgroundTasks, false); assert.equal(recovered.getScheduleRun(run.id).status, 'succeeded');
});

test('workspace and attached-file removal pause plans, clear dangling scopes and preserve results', async t => {
  const { store } = fixture(t), workspace = store.createWorkspace({ name: 'scope' }), file = (await store.createTextFile({ name: 'file.txt', content: 'reference', workspaceId: workspace.id })).file;
  const schedule = create(store, { workspaceId: workspace.id, attachmentIds: [file.id] }), { run } = claim(store, schedule);
  store.removeFile(file.id); assert.equal(store.getSchedule(schedule.id).enabled, false); assert.deepEqual(store.getSchedule(schedule.id).attachmentIds, []); assert.deepEqual(store.getScheduleRun(run.id).scopeSnapshot.attachmentIds, []);
  assert.throws(() => store.markScheduleDispatched({ runId: run.id, now: START }));
  store.deleteWorkspace(workspace.id); assert.equal(store.getSchedule(schedule.id).workspaceId, null); assert.equal(store.getScheduleRun(run.id).scopeSnapshot.workspaceId, null); assert.equal(store.getChat(run.chatId).workspaceId, null);
  finish(store, run, { status: 'cancelled' }); assert.equal(store.getScheduleRun(run.id).status, 'cancelled');
});

test('deleting a schedule retains active run and chat records so their final receipt can still commit', t => {
  const { store } = fixture(t), schedule = create(store), { run } = claim(store, schedule); store.markScheduleDispatched({ runId: run.id, now: START });
  store.deleteSchedule(schedule.id); assert.throws(() => store.getSchedule(schedule.id)); assert.equal(store.getScheduleRun(run.id).scheduleId, null); assert.equal(store.getScheduleRun(run.id).scheduleName, schedule.name);
  finish(store, run, { status: 'cancelled', content: 'already produced partial' }); assert.equal(store.getChat(run.chatId).messages.at(-1).content, 'already produced partial'); assert.equal(store.getScheduleRun(run.id).status, 'cancelled');
});

test('backup export never resumes live plans and import remaps every scope/chat/message/run relation', async t => {
  const a = fixture(t), b = fixture(t), workspace = a.store.createWorkspace({ name: 'schedule workspace' }), file = (await a.store.createTextFile({ name: 'context.txt', content: 'fixture reference', workspaceId: workspace.id })).file;
  const schedule = create(a.store, { workspaceId: workspace.id, attachmentIds: [file.id] }), { run } = claim(a.store, schedule); a.store.markScheduleDispatched({ runId: run.id, now: START }); a.store.updateMessage(run.chatId, run.messageId, { content: 'backed-up safe partial' });
  a.store.saveSettings({ backgroundTasks: true }); const backup = a.store.exportData();
  assert.equal(backup.schedules[0].enabled, false); assert.equal(backup.scheduleRuns[0].status, 'interrupted'); assert.equal(backup.settings.backgroundTasks, false); assert.equal(a.store.getScheduleRun(run.id).status, 'running'); assert.equal(a.store.getSchedule(schedule.id).enabled, true);
  // Even an older or deliberately live-shaped backup must be inert on import.
  backup.schedules[0].enabled = true; backup.scheduleRuns[0].status = 'running'; delete backup.scheduleRuns[0].finishedAt; backup.chats[0].messages.at(-1).status = 'streaming';
  const existing = create(b.store, { name: 'keep local enabled' }); b.store.saveSettings({ backgroundTasks: true }); const imported = await b.store.importData(backup), restored = imported.schedules.find(item => item.id !== existing.id), restoredRun = imported.scheduleRuns[0];
  assert.equal(b.store.getSchedule(existing.id).enabled, true); assert.equal(restored.enabled, false); assert.notEqual(restored.id, schedule.id); assert.notEqual(restoredRun.id, run.id); assert.notEqual(restoredRun.chatId, run.chatId); assert.notEqual(restoredRun.messageId, run.messageId);
  assert.equal(restored.lastRunId, restoredRun.id); assert.equal(restoredRun.scheduleId, restored.id); assert.equal(restored.workspaceId, imported.workspaces[0].id); assert.deepEqual(restored.attachmentIds, [imported.files[0].id]); assert.deepEqual(restoredRun.scopeSnapshot, { workspaceId: restored.workspaceId, attachmentIds: restored.attachmentIds });
  assert.equal(restoredRun.status, 'interrupted'); assert.equal(b.store.getChat(restoredRun.chatId).messages.at(-1).id, restoredRun.messageId); assert.equal(b.store.getChat(restoredRun.chatId).messages.at(-1).content, 'backed-up safe partial'); assert.equal(b.store.getChat(restoredRun.chatId).messages.at(-1).status, 'cancelled'); assert.equal(b.store.settings().backgroundTasks, true);
});

test('malformed backups cannot inject schedules, dangling claims or unknown credential fields', async t => {
  const { store } = fixture(t), schedule = create(store), { run } = claim(store, schedule); finish(store, run); const backup = store.exportData(), before = store.snapshot();
  for (const change of [data => { data.schedules = null; }, data => { data.schedules[0].apiKey = 'synthetic'; }, data => { data.schedules[0].workspaceId = 'missing'; }, data => { data.schedules[0].lastRunId = 'missing'; }, data => { data.scheduleRuns[0].messageId = 'missing'; }, data => { data.scheduleRuns[0].scheduleId = 'missing'; }, data => { data.scheduleRuns[0].scheduleRevision = 99; }, data => { data.scheduleRuns[0].scopeSnapshot.attachmentIds = ['missing']; }, data => { data.scheduleRuns[0].status = 'running'; }]) {
    const input = structuredClone(backup); change(input); await assert.rejects(store.importData(input)); assert.deepEqual(store.snapshot(), before);
  }
});

test('retention preserves live claims and latest per-task/global history without dangling lastRunId', () => {
  const state = { schedules: [{ id: 'task', lastRunId: 'run149' }], scheduleRuns: Array.from({ length: 150 }, (_, i) => ({ id: `run${i}`, scheduleId: 'task', status: i === 0 ? 'running' : 'succeeded' })) };
  model.pruneRuns(state); assert.equal(state.scheduleRuns.length, 100); assert.equal(state.scheduleRuns[0].id, 'run0'); assert.equal(state.scheduleRuns.at(-1).id, 'run149'); assert.equal(state.schedules[0].lastRunId, 'run149');
  const global = { schedules: [], scheduleRuns: Array.from({ length: 5100 }, (_, i) => ({ id: `orphan${i}`, scheduleId: null, status: 'succeeded' })) }; model.pruneRuns(global); assert.equal(global.scheduleRuns.length, 5000); assert.equal(global.scheduleRuns[0].id, 'orphan100');
});

test('persistence failures cannot leave phantom claims, dispatch success or rewritten terminal receipts', t => {
  const { store, dataDir } = fixture(t), schedule = create(store), before = store.snapshot(), persist = store._persistState;
  store._persistState = () => { throw Error('synthetic claim persistence failure'); };
  try { assert.throws(() => claim(store, schedule), /synthetic/); } finally { store._persistState = persist; } assert.deepEqual(store.snapshot(), before);
  const { run } = claim(store, schedule); const claimed = store.snapshot(); store._persistState = () => { throw Error('synthetic dispatch persistence failure'); };
  try { assert.throws(() => store.markScheduleDispatched({ runId: run.id, now: START }), /synthetic/); } finally { store._persistState = persist; } assert.deepEqual(store.snapshot(), claimed);
  store.updateMessage(run.chatId, run.messageId, { content: 'partial retained on persistence error' }); store._persistState = () => { throw Error('synthetic finish persistence failure'); };
  try { assert.throws(() => finish(store, run), /synthetic/); } finally { store._persistState = persist; }
  assert.equal(store.getScheduleRun(run.id).status, 'running'); assert.equal(store.getChat(run.chatId).messages.at(-1).content, 'partial retained on persistence error');
  assert.equal(new Store(dataDir).getScheduleRun(run.id).status, 'interrupted');
});
