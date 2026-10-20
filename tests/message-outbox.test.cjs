'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { MessageOutbox, isSafeOutboxRetry, waitForOutboxRetry, MAX_OUTBOX_MESSAGES, MAX_OUTBOX_BYTES, OUTBOX_MAX_AGE_MS } = require('../backend/message-outbox.cjs');

class FakeClock {
  time = 0; next = 1; timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => { const id = this.next++; this.timers.set(id, { callback, at: this.time + delay }); return id; };
  clearTimer = id => { this.timers.delete(id); };
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = target;
  }
  options(extra = {}) { return { now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer, ...extra }; }
}

test('default FIFO prevents premature attempts and release advances exactly one turn', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const a = queue.reserve({ bytes: 10 }), b = queue.reserve({ bytes: 20 }), c = queue.reserve({ bytes: 30 });
  assert.equal(await a.waitForTurn(), true); assert.equal(b.canDispatch(), false); assert.equal(b.beginAttempt(), false);
  assert.equal(a.beginAttempt(), true); assert.equal(a.beginAttempt(), false);
  const waiting = b.waitForTurn(); a.release(); a.release();
  assert.equal(await waiting, true); assert.equal(c.canDispatch(), false); assert.equal(queue.size, 2); assert.equal(queue.bytes, 50);
  b.release(); assert.equal(await c.waitForTurn(), true); c.release();
  assert.equal(queue.size, 0); assert.equal(queue.bytes, 0); assert.equal(clock.timers.size, 0);
});

test('hard total message and estimated-byte caps apply across every lane without allocating payloads', () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  for (let i = 0; i < MAX_OUTBOX_MESSAGES; i++) assert.ok(queue.reserve({ bytes: 0, laneKey: `chat-${i}` }));
  assert.equal(queue.reserve({ bytes: 0, laneKey: 'extra' }), null); queue.cancelAll();
  const almost = queue.reserve({ bytes: MAX_OUTBOX_BYTES - 1 }); assert.ok(almost);
  assert.ok(queue.reserve({ bytes: 1 })); assert.equal(queue.reserve({ bytes: 1 }), null);
  queue.cancelAll(); assert.equal(queue.bytes, 0); assert.equal(queue.reserve({ bytes: MAX_OUTBOX_BYTES + 1 }), null);
});

test('explicit Windows per-chat lanes run independently while preserving each chat order', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const a1 = queue.reserve({ bytes: 1, laneKey: 'chat-A' }), a2 = queue.reserve({ bytes: 1, laneKey: 'chat-A' }), b1 = queue.reserve({ bytes: 1, laneKey: 'chat-B' });
  assert.equal(await a1.waitForTurn(), true); assert.equal(a1.beginAttempt(), true);
  assert.equal(await b1.waitForTurn(), true); assert.equal(b1.beginAttempt(), true); assert.equal(a2.canDispatch(), false);
  b1.release(); assert.equal(a2.canDispatch(), false); a1.release(); assert.equal(await a2.waitForTurn(), true); a2.release();
  assert.equal(queue.size, 0);
});

test('queued and already-cancelled waits resolve false instead of rejecting or creating unhandled promises', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options()), controller = new AbortController();
  const head = queue.reserve({ bytes: 3 }), queued = queue.reserve({ bytes: 5, signal: controller.signal });
  const pending = queued.waitForTurn(); controller.abort();
  assert.deepEqual(await Promise.allSettled([pending, queued.waitForTurn()]), [{ status: 'fulfilled', value: false }, { status: 'fulfilled', value: false }]);
  assert.equal(queued.signal.aborted, true); assert.equal(queued.cancellationReason, 'cancelled'); assert.equal(queue.bytes, 3);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); head.release();
  const preAborted = queue.reserve({ bytes: 8, signal: controller.signal });
  assert.equal(await preAborted.waitForTurn(), false); assert.equal(queue.size, 0); assert.equal(clock.timers.size, 0);
});

test('explicit cancellation of an active attempt aborts it but cannot start the next lane operation early', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const a = queue.reserve({ bytes: 1 }), b = queue.reserve({ bytes: 1 });
  assert.equal(a.beginAttempt(), true); a.cancel('scope_changed');
  assert.equal(a.signal.aborted, true); assert.equal(a.cancellationReason, 'scope_changed'); assert.equal(await a.waitForTurn(), false);
  assert.equal(queue.snapshot()[0].state, 'cancelling'); assert.equal(b.beginAttempt(), false);
  assert.equal(a.endAttempt(), false); assert.equal(await b.waitForTurn(), true); b.release(); assert.equal(queue.size, 0);
});

test('waiting age expiry resolves false and advances to a younger entry with fake time', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options({ maxAgeMs: 100 }));
  const a = queue.reserve({ bytes: 4 }); clock.advance(50);
  const b = queue.reserve({ bytes: 7 }), waiting = b.waitForTurn(); clock.advance(50);
  assert.equal(a.cancellationReason, 'expired'); assert.equal(a.signal.aborted, true); assert.equal(await a.waitForTurn(), false);
  assert.equal(await waiting, true); assert.equal(b.signal.aborted, false); assert.equal(queue.bytes, 7); b.release();
});

test('expiry cannot interrupt an already begun operation or let a later send overlap it', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const active = queue.reserve({ bytes: 8 }); assert.equal(active.beginAttempt(), true);
  clock.advance(OUTBOX_MAX_AGE_MS * 2);
  assert.equal(active.signal.aborted, false); assert.equal(active.cancellationReason, null); assert.equal(queue.snapshot()[0].state, 'attempting');
  const younger = queue.reserve({ bytes: 2 }); assert.equal(younger.canDispatch(), false);
  assert.equal(active.endAttempt(), false); assert.equal(active.cancellationReason, 'expired');
  assert.equal(await younger.waitForTurn(), true); younger.release(); assert.equal(queue.size, 0);
});

test('admission reclaims expired waiting capacity even when host timers have not run yet', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options({ maxMessages: 1, maxAgeMs: 100 }));
  const old = queue.reserve({ bytes: 4 });
  clock.time = 101; // Simulate an event loop too busy to dispatch its timer.
  const next = queue.reserve({ bytes: 5 });
  assert.ok(next); assert.equal(old.cancellationReason, 'expired'); assert.equal(await old.waitForTurn(), false);
  assert.equal(await next.waitForTurn(), true); assert.equal(queue.bytes, 5); next.release(); assert.equal(clock.timers.size, 0);
});

test('successful release after age expiry retains a non-cancelled operation outcome', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options({ maxAgeMs: 30 }));
  const a = queue.reserve({ bytes: 1 }); a.beginAttempt(); clock.advance(100);
  a.release(); assert.equal(a.signal.aborted, false); assert.equal(a.cancellationReason, null); assert.equal(await a.waitForTurn(), false); assert.equal(queue.size, 0);
});

test('ending a safe retry attempt retains its FIFO place until release or expiry', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options({ maxAgeMs: 100 }));
  const a = queue.reserve({ bytes: 1 }), b = queue.reserve({ bytes: 2 });
  assert.equal(a.beginAttempt(), true); clock.advance(20); assert.equal(a.endAttempt(), true);
  assert.equal(a.canDispatch(), true); assert.equal(b.canDispatch(), false); assert.equal(a.beginAttempt(), true);
  a.release(); assert.equal(await b.waitForTurn(), true); b.release();
});

test('cancelAll settles pending waits, removes timers and preserves active-operation fences', async () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const a = queue.reserve({ bytes: 1 }), b = queue.reserve({ bytes: 2 }), c = queue.reserve({ bytes: 3, laneKey: 'other' });
  a.beginAttempt(); const waits = [a.waitForTurn(), b.waitForTurn(), c.waitForTurn()]; queue.cancelAll('shutdown');
  assert.deepEqual(await Promise.all(waits), [false, false, false]); assert.equal(queue.size, 1); assert.equal(queue.bytes, 1);
  assert.equal(a.signal.aborted, true); a.release(); assert.equal(clock.timers.size, 0); assert.deepEqual(queue.snapshot(), []);
});

test('host snapshots contain detached ID-only metadata and never accept credentials, content or callbacks', () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  const source = { chatId: 'chat_1', requestId: 'request_1', workspaceId: null }, item = queue.reserve({ bytes: 9, metadata: source });
  source.chatId = 'changed'; const view = queue.snapshot(); assert.equal(view[0].metadata.chatId, 'chat_1'); view[0].metadata.requestId = 'mutated';
  assert.equal(queue.snapshot()[0].metadata.requestId, 'request_1');
  for (const forbidden of ['signal', 'controller', 'resolveTurn', 'externalAbort', 'setTimer']) assert.equal(JSON.stringify(queue.snapshot()).includes(forbidden), false);
  for (const key of ['apiKey', 'token', 'authorization', 'content', 'sourcePath', 'callback']) assert.throws(() => queue.reserve({ bytes: 0, metadata: { [key]: 'synthetic-forbidden-value' } }), TypeError);
  item.release(); assert.equal(clock.timers.size, 0);
});

test('invalid sizes, unknown payload fields and accessor metadata are rejected before reservation', () => {
  const clock = new FakeClock(), queue = new MessageOutbox(clock.options());
  for (const bytes of [-1, NaN, Infinity, 1.5, '10']) assert.throws(() => queue.reserve({ bytes }), TypeError);
  assert.throws(() => queue.reserve({ bytes: 1, apiKey: 'synthetic-only' }), TypeError);
  assert.throws(() => new MessageOutbox(clock.options({ maxMessages: 33 })), TypeError);
  let effects = 0; const hostile = {}; Object.defineProperty(hostile, 'chatId', { enumerable: true, get() { effects++; return 'bad'; } });
  assert.throws(() => queue.reserve({ bytes: 1, metadata: hostile }), TypeError); assert.equal(effects, 0); assert.equal(queue.size, 0);
});

test('safe retry classification refuses ambiguous/changed-target requests and accepts only explicit safe cases', () => {
  assert.equal(isSafeOutboxRetry({ deliveryState: 'not_sent' }), true);
  for (const code of ['startup_not_ready', 'session_busy']) assert.equal(isSafeOutboxRetry({ kind: 'jarvis_rejection', code }), true);
  for (const error of [null, new Error('network disconnected'), { code: 'ECONNRESET' }, { deliveryState: 'unknown' }, { deliveryState: 'sent' }, { code: 'session_busy' }, { kind: 'jarvis_rejection', code: 'other' }, { kind: 'jarvis_rejection', code: 'session_busy', deliveryState: 'unknown' }, { deliveryState: 'not_sent', code: 'gateway_target_changed' }, { deliveryState: 'not_sent', code: 'ERR_GATEWAY_TARGET_CHANGED' }, { deliveryState: 'not_sent', targetChanged: true }]) assert.equal(isSafeOutboxRetry(error), false);
});

test('retry delay uses fake time, resolves on abort and cleans its abort listener', async () => {
  const clock = new FakeClock(), controller = new AbortController(); let completed = false;
  const waited = waitForOutboxRetry(controller.signal, clock.options()).then(() => { completed = true; });
  clock.advance(1999); await Promise.resolve(); assert.equal(completed, false); clock.advance(1); await waited;
  assert.equal(completed, true); assert.equal(clock.timers.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const early = waitForOutboxRetry(controller.signal, clock.options()); controller.abort(); await early;
  assert.equal(clock.timers.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await waitForOutboxRetry(controller.signal, clock.options()); assert.equal(clock.timers.size, 0);
});
