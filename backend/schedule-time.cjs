'use strict';

const { types } = require('node:util');

// Independent Windows scheduling policy, not a recovered Muse server algorithm.
// Calendar gaps are skipped and an overlap chooses the earlier instant once.
// Intl performs named-zone conversion (ECMA-402 §11); Gregorian arithmetic and
// explicit candidate validation keep host locale and host time zone irrelevant.
// https://tc39.es/ecma402/2026/#sec-intl.datetimeformat.prototype.formattoparts
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EPOCH = '1970-01-01T00:00:00.000Z';
const ISO_PATTERN = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FIELDS = Object.freeze({
  runonce: ['kind', 'timeZone', 'runAt'],
  interval: ['kind', 'timeZone', 'everyMinutes', 'anchorAt'],
  hourly: ['kind', 'timeZone', 'minute'],
  daily: ['kind', 'timeZone', 'time'],
  weekly: ['kind', 'timeZone', 'time', 'weekdays'],
  monthly: ['kind', 'timeZone', 'time', 'monthDays'],
  yearly: ['kind', 'timeZone', 'time', 'months', 'monthDays']
});
const formatterCache = new Map();
const offsetCache = new Map();

class ScheduleTimeError extends TypeError {
  constructor(reason) {
    super(`计划时间无效：${reason}`);
    this.name = 'ScheduleTimeError';
    this.code = 'ERR_SCHEDULE_TIME';
  }
}
const invalid = reason => { throw new ScheduleTimeError(reason); };
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Descriptor inspection never invokes toJSON, getters, iterators or proxy traps.
function record(input, allowed) {
  if (input === null || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) invalid('需要普通 JSON 对象');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid('需要普通 JSON 对象');
  const output = {};
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid('包含不适用或未知字段');
    const descriptor = descriptors[key];
    if (!hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('字段必须是 JSON 数据');
    output[key] = descriptor.value;
  }
  return output;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(label);
  return value === 0 ? 0 : value;
}

function integerList(value, min, max, label) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > max - min + 1 || Reflect.ownKeys(descriptors).length !== length + 1) invalid(label);
  const output = [];
  const seen = new Set();
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(label);
    const item = integer(descriptor.value, min, max, label);
    if (seen.has(item)) invalid('日期列表包含重复值');
    seen.add(item);
    output.push(item);
  }
  return output.sort((a, b) => a - b);
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || value.startsWith('0000-')) invalid('需要标准 UTC 时间（含三位毫秒）');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid('UTC 日期不存在');
  return value;
}

function instantMs(value) {
  if (typeof value === 'string') return Date.parse(canonicalInstant(value));
  if (!Number.isSafeInteger(value)) invalid('时间必须是 UTC 字符串或整数毫秒');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) invalid('时间超出支持范围');
  return value;
}

function cacheSet(cache, key, value, limit) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function namedTimeZone(value) {
  // An explicit named IANA zone is required; numeric offset zones are not IANA
  // identifiers and would conceal future daylight-saving behavior from users.
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) invalid('需要有效 IANA 时区');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    invalid('IANA 时区不存在');
  }
}

function formatter(timeZone) {
  if (formatterCache.has(timeZone)) return formatterCache.get(timeZone);
  const value = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return cacheSet(formatterCache, timeZone, value, 32);
}

function utcMillis(year, month, day, hour = 0, minute = 0, second = 0) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, 0);
  return value.getTime();
}

function partsAt(ms, timeZone) {
  const output = {};
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type === 'era') output.era = part.value;
    else if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) output[part.type] = Number(part.value);
  }
  if (output.era === 'BC') output.year = 1 - output.year;
  return output;
}

function pad(value, length = 2) { return String(value).padStart(length, '0'); }
function dateString(year, month, day) { return `${pad(year, 4)}-${pad(month)}-${pad(day)}`; }
function parseDate(value) {
  if (typeof value !== 'string') invalid('需要 YYYY-MM-DD 日期');
  const match = DATE_PATTERN.exec(value);
  if (!match) invalid('需要 YYYY-MM-DD 日期');
  const [year, month, day] = match.slice(1).map(Number);
  if (!validDate(year, month, day)) invalid('本地日期不存在');
  return { year, month, day };
}
function validDate(year, month, day) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(utcMillis(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}
function parseTime(value) {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) invalid('需要 HH:mm 时间');
  return { hour: Number(value.slice(0, 2)), minute: Number(value.slice(3)) };
}

function normalizeCadence(input) {
  const source = record(input, ['kind', 'timeZone', 'runAt', 'everyMinutes', 'anchorAt', 'minute', 'time', 'weekdays', 'monthDays', 'months']);
  if (typeof source.kind !== 'string' || !hasOwn(FIELDS, source.kind)) invalid('计划类型不存在');
  for (const key of Object.keys(source)) if (!FIELDS[source.kind].includes(key)) invalid('该类型包含不适用字段');
  const output = { kind: source.kind, timeZone: namedTimeZone(source.timeZone) };
  switch (source.kind) {
    case 'runonce': output.runAt = canonicalInstant(source.runAt); break;
    case 'interval':
      output.everyMinutes = integer(source.everyMinutes, 1, 525600, '间隔须为 1 至 525600 分钟');
      output.anchorAt = hasOwn(source, 'anchorAt') ? canonicalInstant(source.anchorAt) : EPOCH;
      break;
    case 'hourly': output.minute = integer(source.minute, 0, 59, '每小时分钟须为 0 至 59'); break;
    default:
      parseTime(source.time);
      output.time = source.time;
      if (source.kind === 'weekly') output.weekdays = integerList(source.weekdays, 1, 7, '须选择 ISO 周一至周日（1 至 7）');
      if (source.kind === 'monthly' || source.kind === 'yearly') output.monthDays = integerList(source.monthDays, 1, 31, '须选择日期（1 至 31）');
      if (source.kind === 'yearly') output.months = integerList(source.months, 1, 12, '须选择月份（1 至 12）');
  }
  return output;
}

function offsetsAround(date, wallMs, timeZone) {
  const key = `${timeZone}|${date}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const offsets = new Set();
  // Sampling both sides of the date discovers offsets for 30-minute DST shifts
  // and 24-hour date-line changes too. IANA transition states around this date
  // are sampled across six days, rather than guessing the offset from UTC noon.
  const noon = Math.floor(wallMs / DAY) * DAY + 12 * HOUR;
  for (let delta = -72; delta <= 72; delta += 6) {
    const at = noon + delta * HOUR;
    const part = partsAt(at, timeZone);
    offsets.add(utcMillis(part.year, part.month, part.day, part.hour, part.minute, part.second) - at);
  }
  return cacheSet(offsetCache, key, [...offsets], 512);
}

function resolveNormalized(date, time, timeZone) {
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(time);
  const wallMs = utcMillis(year, month, day, hour, minute);
  let earliest = Infinity;
  for (const offset of offsetsAround(date, wallMs, timeZone)) {
    const candidate = wallMs - offset;
    if (candidate >= earliest) continue;
    const part = partsAt(candidate, timeZone);
    if (part.year === year && part.month === month && part.day === day && part.hour === hour && part.minute === minute && part.second === 0) earliest = candidate;
  }
  if (!Number.isFinite(earliest)) return null;
  const result = new Date(earliest);
  return result.getUTCFullYear() >= 1 && result.getUTCFullYear() <= 9999 ? result.toISOString() : null;
}

function resolveLocalTime(input) {
  const value = record(input, ['date', 'time', 'timeZone']);
  const zone = namedTimeZone(value.timeZone);
  return resolveNormalized(value.date, value.time, zone);
}

function localDateTime(instant, timeZone) {
  const part = partsAt(instantMs(instant), namedTimeZone(timeZone));
  if (part.year < 1 || part.year > 9999) invalid('本地日期超出支持范围');
  return { date: dateString(part.year, part.month, part.day), time: `${pad(part.hour)}:${pad(part.minute)}` };
}

function dayParts(dayMs) {
  const date = new Date(dayMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nextOccurrence(input, after) {
  const cadence = normalizeCadence(input);
  const afterMs = instantMs(after);
  if (cadence.kind === 'runonce') return Date.parse(cadence.runAt) > afterMs ? cadence.runAt : null;
  if (cadence.kind === 'interval') {
    const anchor = Date.parse(cadence.anchorAt), step = cadence.everyMinutes * MINUTE;
    const increments = Math.max(0, Math.floor((afterMs - anchor) / step) + 1);
    const result = new Date(anchor + increments * step);
    return Number.isFinite(result.getTime()) && result.getUTCFullYear() >= 1 && result.getUTCFullYear() <= 9999 ? result.toISOString() : null;
  }
  const zone = cadence.timeZone;
  const local = partsAt(afterMs, zone);
  const startDay = utcMillis(local.year, local.month, local.day);
  const candidate = (year, month, day, time) => {
    if (!validDate(year, month, day)) return null;
    const at = resolveNormalized(dateString(year, month, day), time, zone);
    return at !== null && Date.parse(at) > afterMs ? at : null;
  };
  if (cadence.kind === 'hourly') {
    // Calendar hours, not fixed 60-minute duration. Repeated hours run once.
    for (let index = 0; index <= 3; index++) {
      const { year, month, day } = dayParts(startDay + index * DAY);
      for (let hour = 0; hour < 24; hour++) {
        const at = candidate(year, month, day, `${pad(hour)}:${pad(cadence.minute)}`);
        if (at !== null) return at;
      }
    }
    return null;
  }
  if (cadence.kind === 'daily' || cadence.kind === 'weekly') {
    for (let index = 0; index <= 370; index++) {
      const dayMs = startDay + index * DAY;
      if (cadence.kind === 'weekly' && !cadence.weekdays.includes(new Date(dayMs).getUTCDay() || 7)) continue;
      const { year, month, day } = dayParts(dayMs);
      const at = candidate(year, month, day, cadence.time);
      if (at !== null) return at;
    }
    return null;
  }
  if (cadence.kind === 'monthly') {
    for (let index = 0; index <= 24; index++) {
      const monthIndex = local.year * 12 + local.month - 1 + index;
      const year = Math.floor(monthIndex / 12), month = monthIndex % 12 + 1;
      if (year > 9999) return null;
      for (const day of cadence.monthDays) {
        const at = candidate(year, month, day, cadence.time);
        if (at !== null) return at;
      }
    }
    return null;
  }
  // Eight years include the longest Gregorian leap-day wait across a century
  // not divisible by 400 (for example 2096-02-29 -> 2104-02-29).
  for (let year = Math.max(1, local.year); year <= Math.min(9999, local.year + 8); year++) {
    for (const month of cadence.months) for (const day of cadence.monthDays) {
      const at = candidate(year, month, day, cadence.time);
      if (at !== null) return at;
    }
  }
  return null;
}

module.exports = { normalizeCadence, nextOccurrence, resolveLocalTime, localDateTime, ScheduleTimeError };
