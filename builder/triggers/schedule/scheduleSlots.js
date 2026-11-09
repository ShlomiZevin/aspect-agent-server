/**
 * scheduleSlots — the wall-clock arithmetic behind the Schedule trigger.
 *
 * Pure: no database, no clock beyond the `nowMs` it is handed. Kept apart
 * from `trigger.schedule.js` so the risky part — "which instant is
 * Sunday 09:00 in Jerusalem?" — can be tested on its own, DST included.
 *
 * ── Slots ──────────────────────────────────────────────────────────
 *
 * A SLOT is one scheduled moment: a local date + a local time in the
 * schedule's timezone, resolved to exactly ONE real instant. Weekly
 * schedules produce a slot for every chosen day × every chosen time
 * (inside the optional date range); a one-off schedule produces one.
 *
 * ── Daylight saving — one instant per local slot, always ──────────
 *
 *   Spring forward (Israel: the Friday before the last Sunday of March,
 *   02:00 → 03:00): 02:30 does not exist that night. It is resolved to
 *   the first real minute after the gap — 03:30, an hour "late" by the
 *   wall clock but on the right day, and never skipped.
 *
 *   Fall back (Israel: the last Sunday of October, 02:00 → 01:00):
 *   01:30 happens twice. The EARLIER one is the slot. The second pass of
 *   the same wall time is not a new slot, so nobody gets it twice.
 *
 * Everything in local time goes through `Intl.DateTimeFormat`, the same
 * API quiet hours use — no tz library, no hand-written offset tables.
 */

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMES = 8;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

/** The wall clock in `tz` at instant `ms`. */
function wallParts(ms, tz) {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const hour = get('hour');
  return { y: get('year'), mo: get('month'), d: get('day'), h: hour === 24 ? 0 : hour, mi: get('minute'), s: get('second') };
}

/** Milliseconds `tz` is ahead of UTC at instant `ms`. */
function offsetAt(ms, tz) {
  const p = wallParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Local wall time → the one instant it names. See the header for how a
 * time that does not exist (spring) or exists twice (autumn) resolves.
 */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const t0 = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(t0 - DAY_MS, tz);
  const after = offsetAt(t0 + DAY_MS, tz);
  const candidates = Array.from(new Set([t0 - before, t0 - after])).sort((a, b) => a - b);
  const matches = candidates.filter(c => {
    const p = wallParts(c, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  });
  if (matches.length) return matches[0];           // fall-back night → the earlier one
  return t0 - before;                              // spring gap → shifted forward past it
}

// ── local dates as day numbers (days since 1970-01-01, calendar only) ──

function dayNumOf(y, mo, d) { return Math.round(Date.UTC(y, mo - 1, d) / DAY_MS); }
function ymdOf(dayNum) {
  const dt = new Date(dayNum * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function dowOf(dayNum) { return new Date(dayNum * DAY_MS).getUTCDay(); }

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dn = dayNumOf(y, mo, d);
  const back = ymdOf(dn);
  return back.y === y && back.mo === mo && back.d === d ? dn : null;
}

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? { h, mi } : null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A hand-edited body can hold anything. Normalise it once and report
 * what is unusable as `problems` — a schedule with a problem fires for
 * nobody (failing closed: a message at the wrong time is worse than a
 * message not sent, and the explainer says exactly why).
 */
function normalizeSchedule(config) {
  const c = config || {};
  const problems = [];

  const repeat = c.repeat === 'once' ? 'once' : 'weekly';

  const days = Array.from(new Set((Array.isArray(c.days) ? c.days : [])
    .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b);

  const times = Array.from(new Set((Array.isArray(c.times) ? c.times : [])
    .map(parseTime).filter(Boolean).map(t => `${pad(t.h)}:${pad(t.mi)}`))).sort().slice(0, MAX_TIMES);

  let onceAt = null;
  if (typeof c.onceAt === 'string') {
    const [datePart, timePart] = c.onceAt.split('T');
    const dn = parseDate(datePart);
    const t = parseTime(timePart);
    if (dn !== null && t) onceAt = { dayNum: dn, time: `${pad(t.h)}:${pad(t.mi)}` };
  }

  const startDay = c.startDate ? parseDate(c.startDate) : null;
  const endDay = c.endDate ? parseDate(c.endDate) : null;

  const tzGiven = c.timezone === undefined || c.timezone === null || c.timezone === '' ? DEFAULT_TIMEZONE : c.timezone;
  const timezone = isValidTimezone(tzGiven) ? tzGiven : null;
  if (!timezone) problems.push(`unknown timezone "${tzGiven}"`);

  if (repeat === 'weekly') {
    if (days.length === 0) problems.push('no days picked');
    if (times.length === 0) problems.push('no time of day set');
    if (c.startDate && startDay === null) problems.push(`start date "${c.startDate}" is not a date`);
    if (c.endDate && endDay === null) problems.push(`end date "${c.endDate}" is not a date`);
    if (startDay !== null && endDay !== null && endDay < startDay) problems.push('the end date is before the start date');
  } else if (!onceAt) {
    problems.push('no date and time set for the one-off send');
  }

  return { repeat, days, times, onceAt, startDay, endDay, timezone, problems };
}

/** Every slot instant on one local day, ascending. */
function slotsOnDay(s, dayNum) {
  if (!s.days.includes(dowOf(dayNum))) return [];
  if (s.startDay !== null && dayNum < s.startDay) return [];
  if (s.endDay !== null && dayNum > s.endDay) return [];
  const { y, mo, d } = ymdOf(dayNum);
  return s.times.map(t => {
    const { h, mi } = parseTime(t);
    return { at: zonedToUtc(y, mo, d, h, mi, s.timezone), dayNum, time: t };
  }).sort((a, b) => a.at - b.at);
}

function onceSlot(s) {
  const { y, mo, d } = ymdOf(s.onceAt.dayNum);
  const { h, mi } = parseTime(s.onceAt.time);
  return { at: zonedToUtc(y, mo, d, h, mi, s.timezone), dayNum: s.onceAt.dayNum, time: s.onceAt.time };
}

function todayIn(s, nowMs) {
  const p = wallParts(nowMs, s.timezone);
  return dayNumOf(p.y, p.mo, p.d);
}

/** The most recent slot at or before `nowMs`, or null. */
function latestSlot(s, nowMs) {
  if (s.problems.length) return null;
  if (s.repeat === 'once') {
    const slot = onceSlot(s);
    return slot.at <= nowMs ? slot : null;
  }
  const today = todayIn(s, nowMs);
  // Today first (a slot later today has not happened yet), then back a
  // week — every chosen weekday recurs inside eight days.
  for (let dn = today; dn >= today - 8; dn--) {
    const past = slotsOnDay(s, dn).filter(x => x.at <= nowMs);
    if (past.length) return past[past.length - 1];
  }
  return null;
}

/** The first slot strictly after `nowMs`, or null if there is none. */
function nextSlot(s, nowMs) {
  if (s.problems.length) return null;
  if (s.repeat === 'once') {
    const slot = onceSlot(s);
    return slot.at > nowMs ? slot : null;
  }
  const from = Math.max(todayIn(s, nowMs), s.startDay ?? -Infinity);
  for (let dn = from; dn <= from + 8; dn++) {
    if (s.endDay !== null && dn > s.endDay) return null;
    const ahead = slotsOnDay(s, dn).filter(x => x.at > nowMs);
    if (ahead.length) return ahead[0];
  }
  return null;
}

/** "Sun 10 Nov 09:00" — a slot as the author wrote it, in its own zone. */
function slotLabel(slot) {
  const { mo, d } = ymdOf(slot.dayNum);
  return `${DOW[dowOf(slot.dayNum)]} ${d} ${MONTHS[mo - 1]} ${slot.time}`;
}

/** Wall clock of any instant in the schedule's zone, "HH:MM". */
function wallTime(ms, tz) {
  const p = wallParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "Sun 10 Nov 09:20" for an arbitrary instant. */
function instantLabel(ms, tz) {
  const p = wallParts(ms, tz);
  const dn = dayNumOf(p.y, p.mo, p.d);
  return `${DOW[dowOf(dn)]} ${p.d} ${MONTHS[p.mo - 1]} ${pad(p.h)}:${pad(p.mi)}`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  MAX_TIMES,
  DOW,
  normalizeSchedule,
  latestSlot,
  nextSlot,
  slotLabel,
  instantLabel,
  wallTime,
  zonedToUtc,
  wallParts,
  isValidTimezone,
};
