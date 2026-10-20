'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');

const MAX_OUTBOX_MESSAGES = 32;
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
const OUTBOX_MAX_AGE_MS = 5 * 60 * 1000;
const OUTBOX_RETRY_DELAY_MS = 2000;
const DEFAULT_LANE = 'global';
const METADATA_KEYS = new Set(['chatId', 'requestId', 'messageId', 'workspaceId']);
const CANCEL_REASONS = new Set(['cancelled', 'expired', 'aborted', 'scope_changed', 'target_changed', 'shutdown', 'removed', 'user_cancelled']);
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const invalid = () => { throw new TypeError('发送队列参数无效。'); };
const reason = value => { if (!CANCEL_REASONS.has(value)) invalid(); return value; };
function positive(value, maximum) { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(); return value; }
function metadata(value = {}) {
  if (!plain(value)) invalid();
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (!METADATA_KEYS.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const item = descriptor.value;
    if (key === 'workspaceId' && item === null) { output[key] = null; continue; }
    if (typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(item)) invalid();
    output[key] = item;
  }
  return Object.freeze(output);
}

/**
 * Recovered inspiration: bounded, memory-only send admission FIFO. Per-lane
 * scheduling is an independent Windows adapter policy; it is not evidence of
 * original Muse lanes or of the original server's handling of a busy session.
 * No message bodies, attachments, settings or credentials belong in this queue.
 */
class MessageOutbox {
  #entries = new Map(); #lanes = new Map(); #bytes = 0;
  #now; #setTimer; #clearTimer; #maxMessages; #maxBytes; #maxAgeMs;
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, maxMessages = MAX_OUTBOX_MESSAGES, maxBytes = MAX_OUTBOX_BYTES, maxAgeMs = OUTBOX_MAX_AGE_MS } = {}) {
    if ([now, setTimer, clearTimer].some(value => typeof value !== 'function')) invalid();
    this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    this.#maxMessages = positive(maxMessages, MAX_OUTBOX_MESSAGES); this.#maxBytes = positive(maxBytes, MAX_OUTBOX_BYTES); this.#maxAgeMs = positive(maxAgeMs, OUTBOX_MAX_AGE_MS);
    this.#time();
  }
  #time() { const now = this.#now(); if (!Number.isFinite(now)) invalid(); return now; }
  get size() { return this.#entries.size; }
  get bytes() { return this.#bytes; }
  #settle(entry, granted) { if (!entry.settled) { entry.settled = true; entry.resolveTurn(granted); } }
  #finish(entry) {
    if (entry.ended) return;
    entry.ended = true; this.#settle(entry, false);
    if (entry.timer != null) this.#clearTimer(entry.timer);
    entry.timer = null;
    entry.externalSignal?.removeEventListener('abort', entry.externalAbort);
    if (!this.#entries.delete(entry.id)) return;
    this.#bytes -= entry.bytes;
    const lane = this.#lanes.get(entry.laneKey), index = lane?.indexOf(entry) ?? -1;
    if (index >= 0) lane.splice(index, 1);
    if (!lane?.length) this.#lanes.delete(entry.laneKey);
    else if (index === 0) this.#pump(entry.laneKey);
  }
  #cancel(entry, cancellationReason) {
    if (entry.ended) return;
    if (entry.reason === null) { entry.reason = cancellationReason; entry.controller.abort(); }
    this.#settle(entry, false);
    // Cancellation is not permission for a later job to overlap an operation
    // that has already begun. Its owner must end/release that attempt first.
    if (!entry.active) this.#finish(entry);
  }
  #expire(entry) {
    if (!entry.ended && !entry.active && this.#time() - entry.createdAt >= this.#maxAgeMs) this.#cancel(entry, 'expired');
  }
  #pump(laneKey) {
    const head = this.#lanes.get(laneKey)?.[0];
    if (!head) return;
    this.#expire(head);
    if (!head.ended && head.reason === null) this.#settle(head, true);
  }
  #canDispatch(entry) {
    this.#expire(entry);
    return !entry.ended && entry.reason === null && !entry.active && this.#lanes.get(entry.laneKey)?.[0] === entry;
  }
  reserve(input) {
    if (!plain(input) || Reflect.ownKeys(input).some(key => !['bytes', 'laneKey', 'signal', 'metadata'].includes(key))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some(value => !value.enumerable || !Object.hasOwn(value, 'value'))) invalid();
    const { bytes, laneKey = DEFAULT_LANE, signal } = input;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof laneKey !== 'string' || !laneKey.length || laneKey.length > 256 || /[\p{Cc}\p{Cf}]/u.test(laneKey)) invalid();
    if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) invalid();
    const publicMetadata = metadata(input.metadata);
    // Timer callbacks may be delayed by a busy host; elapsed wall-clock age is
    // still authoritative when admitting new work. Active attempts stay fenced.
    for (const entry of [...this.#entries.values()]) this.#expire(entry);
    if (!signal?.aborted && (this.#entries.size >= this.#maxMessages || bytes > this.#maxBytes - this.#bytes)) return null;
    const createdAt = this.#time(), controller = new AbortController(); let resolveTurn;
    const entry = { id: crypto.randomUUID(), createdAt, bytes, laneKey, metadata: publicMetadata, controller, externalSignal: signal, externalAbort: null, timer: null, active: false, ended: false, reason: null, settled: false, resolveTurn: null, turn: new Promise(resolve => { resolveTurn = resolve; }) };
    entry.resolveTurn = resolveTurn;
    const reservation = Object.freeze({
      id: entry.id, createdAt, signal: controller.signal,
      get cancellationReason() { return entry.reason; },
      waitForTurn: () => {
        this.#expire(entry);
        if (entry.ended || entry.reason !== null) return Promise.resolve(false);
        return entry.turn.then(granted => granted && this.#canDispatch(entry));
      },
      canDispatch: () => this.#canDispatch(entry),
      beginAttempt: () => { if (!this.#canDispatch(entry)) return false; entry.active = true; return true; },
      endAttempt: () => {
        if (entry.ended) return false;
        entry.active = false;
        if (entry.reason !== null) { this.#finish(entry); return false; }
        this.#expire(entry);
        return this.#canDispatch(entry);
      },
      release: () => this.#finish(entry),
      cancel: (cancellationReason = 'cancelled') => this.#cancel(entry, reason(cancellationReason))
    });
    if (signal?.aborted) { this.#cancel(entry, 'cancelled'); return reservation; }
    this.#entries.set(entry.id, entry); this.#bytes += bytes;
    const lane = this.#lanes.get(laneKey) || []; lane.push(entry); this.#lanes.set(laneKey, lane);
    entry.externalAbort = () => this.#cancel(entry, 'cancelled');
    signal?.addEventListener('abort', entry.externalAbort, { once: true });
    try {
      entry.timer = this.#setTimer(() => { entry.timer = null; this.#expire(entry); }, this.#maxAgeMs);
      entry.timer?.unref?.();
    } catch (error) { this.#cancel(entry, 'cancelled'); throw error; }
    if (signal?.aborted) this.#cancel(entry, 'cancelled');
    this.#pump(laneKey);
    return reservation;
  }
  cancelAll(cancellationReason = 'cancelled') { const checked = reason(cancellationReason); for (const entry of [...this.#entries.values()]) this.#cancel(entry, checked); }
  snapshot() {
    for (const entry of [...this.#entries.values()]) this.#expire(entry);
    return [...this.#entries.values()].map(entry => ({
      id: entry.id, createdAt: entry.createdAt, expiresAt: entry.createdAt + this.#maxAgeMs,
      bytes: entry.bytes, laneKey: entry.laneKey, metadata: { ...entry.metadata },
      state: entry.active ? entry.reason === null ? 'attempting' : 'cancelling' : this.#lanes.get(entry.laneKey)?.[0] === entry ? 'ready' : 'waiting',
      cancellationReason: entry.reason
    }));
  }
}

/** Only known-not-sent delivery, or an explicit supported server rejection. */
function isSafeOutboxRetry(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.targetChanged === true || error.kind === 'target_changed' || typeof error.code === 'string' && /(?:^|_)target_changed$/i.test(error.code)) return false;
  if (error.deliveryState != null) return error.deliveryState === 'not_sent';
  return error.kind === 'jarvis_rejection' && ['startup_not_ready', 'session_busy'].includes(error.code);
}

/** Resolves on timer or abort; cancelling a retry wait never rejects. */
function waitForOutboxRetry(signal, { delayMs = OUTBOX_RETRY_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || typeof setTimer !== 'function' || typeof clearTimer !== 'function') invalid();
  if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) invalid();
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false, timer;
    const done = () => { if (settled) return; settled = true; if (timer != null) clearTimer(timer); signal?.removeEventListener('abort', done); resolve(); };
    signal?.addEventListener('abort', done, { once: true });
    try { timer = setTimer(done, delayMs); timer?.unref?.(); }
    catch { done(); }
    if (signal?.aborted) done();
  });
}

module.exports = { MessageOutbox, isSafeOutboxRetry, waitForOutboxRetry, MAX_OUTBOX_MESSAGES, MAX_OUTBOX_BYTES, OUTBOX_MAX_AGE_MS, OUTBOX_RETRY_DELAY_MS };
