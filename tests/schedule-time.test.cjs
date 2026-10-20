'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCadence, nextOccurrence, resolveLocalTime, localDateTime } = require('../backend/schedule-time.cjs');
const daily = (time, timeZone = 'America/New_York') => ({ kind: 'daily', timeZone, time });

test('cadence normalization gives deterministic ordinary JSON, sorted ISO lists and a fixed interval anchor', () => {
  assert.deepEqual(normalizeCadence({ kind: 'weekly', timeZone: 'utc', time: '09:00', weekdays: [7, 1, 3] }), { kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays: [1, 3, 7] });
  assert.deepEqual(normalizeCadence({ kind: 'interval', timeZone: 'UTC', everyMinutes: 10 }), { kind: 'interval', timeZone: 'UTC', everyMinutes: 10, anchorAt: '1970-01-01T00:00:00.000Z' });
  const input = Object.assign(Object.create(null), { kind: 'hourly', timeZone: 'Asia/Kathmandu', minute: 12 });
  const normalized = normalizeCadence(input);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
});

test('normalization rejects unused fields, duplicate lists, malformed dates, missing required fields and non-IANA zones', () => {
  for (const value of [
    { kind: 'hourly', timeZone: 'UTC', time: '03:12' },
    { kind: 'hourly', timeZone: 'UTC', minute: 60 },
    { kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays: [1, 1] },
    { kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays: [] },
    { kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays: [0] },
    { kind: 'yearly', timeZone: 'UTC', time: '09:00', months: [2, 2], monthDays: [29] },
    { kind: 'monthly', timeZone: 'UTC', time: '09:00', monthDays: [32] },
    { kind: 'daily', timeZone: 'UTC', time: '24:00' },
    { kind: 'daily', timeZone: 'UTC', time: '9:00' },
    { kind: 'daily', timeZone: 'UTC', time: '09:00', weekDays: [1] },
    { kind: 'daily', timeZone: 'UTC', time: undefined },
    { kind: 'daily', timeZone: '+05:45', time: '09:00' },
    { kind: 'daily', timeZone: 'Not/A_Zone', time: '09:00' },
    { kind: 'daily', timeZone: ' UTC', time: '09:00' },
    { kind: 'runonce', timeZone: 'UTC', runAt: '2026-02-30T10:00:00.000Z' },
    { kind: 'runonce', timeZone: 'UTC', runAt: '2026-01-01T00:00:00Z' },
    { kind: 'runonce', timeZone: 'UTC', runAt: '2026-01-01T01:00:00.000+01:00' },
    { kind: 'runonce', timeZone: 'UTC', runAt: '0000-01-01T00:00:00.000Z' },
    { kind: 'interval', timeZone: 'UTC', everyMinutes: 0 },
    { kind: 'interval', timeZone: 'UTC', everyMinutes: 525601 },
    { kind: 'interval', timeZone: 'UTC', everyMinutes: 1.5 },
    { kind: 'interval', timeZone: 'UTC', everyMinutes: 1, anchorAt: null }
  ]) assert.throws(() => normalizeCadence(value), { code: 'ERR_SCHEDULE_TIME' });
});

test('getters, proxies, custom prototypes, sparse arrays, extra properties and symbols are rejected without executing user code', () => {
  let reads = 0;
  const getter = { kind: 'daily', timeZone: 'UTC', get time() { reads++; return '09:00'; } };
  const proxy = new Proxy(daily('09:00'), { ownKeys() { reads++; throw Error('must not run'); }, getPrototypeOf() { reads++; throw Error('must not run'); } });
  const arrayProxy = new Proxy([1], { ownKeys() { reads++; throw Error('must not run'); } });
  const listGetter = [1]; Object.defineProperty(listGetter, 0, { get() { reads++; return 1; }, enumerable: true });
  const hidden = daily('09:00'); Object.defineProperty(hidden, 'extra', { value: 1 });
  const symbol = daily('09:00'); symbol[Symbol('x')] = 1;
  const sparse = Array(2); sparse[0] = 1;
  const extra = [1]; extra.other = 1;
  for (const value of [getter, proxy, hidden, symbol, Object.assign(Object.create({ inherited: true }), daily('09:00')), ...[arrayProxy, listGetter, sparse, extra].map(weekdays => ({ kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays }))]) assert.throws(() => normalizeCadence(value), { code: 'ERR_SCHEDULE_TIME' });
  assert.equal(reads, 0);
  assert.throws(() => resolveLocalTime(new Proxy({}, { get() { reads++; } })), { code: 'ERR_SCHEDULE_TIME' });
  assert.equal(reads, 0);
});

test('NY spring gap is absent, autumn overlap resolves to the earlier instant', () => {
  assert.equal(resolveLocalTime({ date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' }), null);
  assert.equal(resolveLocalTime({ date: '2026-11-01', time: '01:30', timeZone: 'America/New_York' }), '2026-11-01T05:30:00.000Z');
  assert.equal(resolveLocalTime({ date: '2026-11-01', time: '02:30', timeZone: 'America/New_York' }), '2026-11-01T07:30:00.000Z');
});

test('daily recurrence skips a gap and does not run a second time in a repeated clock hour', () => {
  assert.equal(nextOccurrence(daily('02:30'), '2026-03-08T06:59:00.000Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(nextOccurrence(daily('01:30'), '2026-11-01T05:29:59.999Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(nextOccurrence(daily('01:30'), '2026-11-01T05:30:00.000Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(nextOccurrence(daily('01:30'), '2026-11-01T06:15:00.000Z'), '2026-11-02T06:30:00.000Z');
});

test('Lord Howe half-hour DST gap/fold and Kathmandu quarter-hour offset use actual IANA offsets', () => {
  assert.equal(resolveLocalTime({ date: '2026-10-04', time: '02:15', timeZone: 'Australia/Lord_Howe' }), null);
  assert.equal(resolveLocalTime({ date: '2026-04-05', time: '01:45', timeZone: 'Australia/Lord_Howe' }), '2026-04-04T14:45:00.000Z');
  assert.equal(resolveLocalTime({ date: '2026-06-01', time: '09:00', timeZone: 'Asia/Kathmandu' }), '2026-06-01T03:15:00.000Z');
  assert.deepEqual(localDateTime('2026-06-01T03:15:29.123Z', 'Asia/Kathmandu'), { date: '2026-06-01', time: '09:00' });
});

test('historical second offsets and a quarter-hour civil offset change are resolved without rounding', () => {
  assert.equal(resolveLocalTime({ date: '1890-01-01', time: '12:00', timeZone: 'Europe/Paris' }), '1890-01-01T11:50:39.000Z');
  assert.equal(resolveLocalTime({ date: '1985-12-31', time: '23:59', timeZone: 'Asia/Kathmandu' }), '1985-12-31T18:29:00.000Z');
  assert.equal(resolveLocalTime({ date: '1986-01-01', time: '00:05', timeZone: 'Asia/Kathmandu' }), null);
  assert.equal(resolveLocalTime({ date: '1986-01-01', time: '00:15', timeZone: 'Asia/Kathmandu' }), '1985-12-31T18:30:00.000Z');
});

test('Apia whole-day date-line gap is skipped instead of shifted to a different local date', () => {
  assert.equal(resolveLocalTime({ date: '2011-12-30', time: '12:00', timeZone: 'Pacific/Apia' }), null);
  assert.equal(nextOccurrence(daily('12:00', 'Pacific/Apia'), '2011-12-29T22:00:00.000Z'), '2011-12-30T22:00:00.000Z');
  assert.deepEqual(localDateTime('2011-12-30T22:00:00.000Z', 'Pacific/Apia'), { date: '2011-12-31', time: '12:00' });
});

test('hourly uses a dedicated minute field, skips nonexistent hours and executes folded hours once', () => {
  const cadence = { kind: 'hourly', minute: 30, timeZone: 'America/New_York' };
  assert.equal(nextOccurrence(cadence, '2026-03-08T06:30:00.000Z'), '2026-03-08T07:30:00.000Z');
  assert.equal(nextOccurrence(cadence, '2026-11-01T05:30:00.000Z'), '2026-11-01T07:30:00.000Z');
  assert.equal(nextOccurrence(cadence, '2026-11-01T06:15:00.000Z'), '2026-11-01T07:30:00.000Z');
  assert.equal(nextOccurrence({ kind: 'hourly', minute: 0, timeZone: 'Asia/Kathmandu' }, '2026-06-01T03:15:00.000Z'), '2026-06-01T04:15:00.000Z');
});

test('weekly uses ISO Monday1/Sunday7 and skips a missing selected day', () => {
  assert.equal(nextOccurrence({ kind: 'weekly', timeZone: 'UTC', time: '09:00', weekdays: [1, 7] }, '2026-10-18T09:00:00.000Z'), '2026-10-19T09:00:00.000Z');
  assert.equal(nextOccurrence({ kind: 'weekly', timeZone: 'Pacific/Apia', time: '12:00', weekdays: [5] }, '2011-12-29T22:00:00.000Z'), '2012-01-05T22:00:00.000Z');
});

test('month31 skips invalid calendar dates rather than clamping and selected dates are chronological', () => {
  assert.equal(nextOccurrence({ kind: 'monthly', timeZone: 'UTC', time: '08:10', monthDays: [31] }, '2026-01-31T08:10:00.000Z'), '2026-03-31T08:10:00.000Z');
  assert.equal(nextOccurrence({ kind: 'monthly', timeZone: 'UTC', time: '08:10', monthDays: [31, 2, 15] }, '2026-02-02T08:10:00.000Z'), '2026-02-15T08:10:00.000Z');
});

test('yearly leap-day finds the next valid leap, including the eight-year century wait', () => {
  const leap = { kind: 'yearly', timeZone: 'UTC', time: '09:00', months: [2], monthDays: [29] };
  assert.equal(nextOccurrence(leap, '2026-03-01T00:00:00.000Z'), '2028-02-29T09:00:00.000Z');
  assert.equal(nextOccurrence(leap, '2096-02-29T09:00:00.000Z'), '2104-02-29T09:00:00.000Z');
  assert.equal(nextOccurrence({ ...leap, monthDays: [30] }, '2026-01-01T00:00:00.000Z'), null);
  assert.equal(nextOccurrence({ ...leap, months: [12, 1], monthDays: [31, 1] }, '2026-12-31T09:00:00.000Z'), '2027-01-01T09:00:00.000Z');
});

test('runonce is strictly after, expired runonce returns null and numeric after is accepted', () => {
  const runAt = '2026-10-20T12:34:56.789Z';
  const cadence = { kind: 'runonce', timeZone: 'Asia/Shanghai', runAt };
  assert.equal(nextOccurrence(cadence, Date.parse(runAt) - 1), runAt);
  assert.equal(nextOccurrence(cadence, runAt), null);
  assert.equal(nextOccurrence(cadence, Date.parse(runAt) + 1), null);
});

test('interval remains anchored to UTC across DST, catches up in one calculation and never precedes anchor', () => {
  const cadence = { kind: 'interval', timeZone: 'America/New_York', everyMinutes: 60, anchorAt: '2026-03-08T05:45:12.123Z' };
  assert.equal(nextOccurrence(cadence, '2026-03-08T05:00:00.000Z'), cadence.anchorAt);
  assert.equal(nextOccurrence(cadence, cadence.anchorAt), '2026-03-08T06:45:12.123Z');
  assert.equal(nextOccurrence(cadence, '2026-03-08T07:45:12.123Z'), '2026-03-08T08:45:12.123Z');
  assert.equal(nextOccurrence({ kind: 'interval', timeZone: 'UTC', everyMinutes: 10 }, '2050-01-01T00:00:00.000Z'), '2050-01-01T00:10:00.000Z');
});

test('invalid resolver/after input is rejected without Date coercion and supported-year exhaustion returns null', () => {
  for (const value of [NaN, Infinity, 1.2, {}, new Date(), '2026-01-01', '2026-02-30T00:00:00.000Z']) assert.throws(() => nextOccurrence(daily('09:00', 'UTC'), value), { code: 'ERR_SCHEDULE_TIME' });
  for (const value of [
    { date: '2026-02-30', time: '12:00', timeZone: 'UTC' },
    { date: '2026-2-03', time: '12:00', timeZone: 'UTC' },
    { date: '2026-02-03', time: '12:00', timeZone: 'UTC', extra: true },
    { date: '2026-02-03', time: '12:00:00', timeZone: 'UTC' }
  ]) assert.throws(() => resolveLocalTime(value), { code: 'ERR_SCHEDULE_TIME' });
  assert.equal(nextOccurrence(daily('09:00', 'UTC'), '9999-12-31T23:59:59.999Z'), null);
  assert.equal(nextOccurrence({ kind: 'interval', timeZone: 'UTC', everyMinutes: 1 }, '9999-12-31T23:59:59.999Z'), null);
  assert.equal(resolveLocalTime({ date: '0001-01-01', time: '00:00', timeZone: 'UTC' }), '0001-01-01T00:00:00.000Z');
});
