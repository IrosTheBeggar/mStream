// Period and timezone arithmetic for the stats API (src/api/stats.js).
//
// Every bound the API hands to SQL is computed here, in the CALLER's IANA
// timezone, and rendered in the one text format play_events.started_at and
// user_hour_stats.hour use — so "this month" is the caller's month, not the
// server's, and TEXT comparison against the stored rows is exact. This
// replaces the wrapped-era bug class: bounds built in server-local time and
// compared as ISO 'T' strings against SQLite's space-separated text, which
// silently dropped every play made on a period's first day.
//
// Pure — no DB, no config. Unit-tested in test/unit/stats-time.test.mjs.

const PERIODS = new Set(['week', 'month', 'quarter', 'half', 'year', 'all']);
export function isPeriod(p) { return PERIODS.has(p); }

const BUCKETS = new Set(['hour', 'day', 'week', 'month', 'hourOfDay', 'weekday']);
export function isBucket(b) { return BUCKETS.has(b); }

// One formatter per zone: Intl.DateTimeFormat construction is the expensive
// part (the 2026-07 audit's 8.4 s hour loop was a fresh formatter per row).
const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) { return false; }
  try { formatter(tz); return true; } catch (_) { return false; }
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock parts of [date] in [tz]. month is 1-12; weekday 0 = Sunday.
export function zonedParts(date, tz) {
  const out = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) {
    switch (type) {
      case 'year': out.year = Number(value); break;
      case 'month': out.month = Number(value); break;
      case 'day': out.day = Number(value); break;
      case 'hour': out.hour = Number(value); break;
      case 'minute': out.minute = Number(value); break;
      case 'second': out.second = Number(value); break;
      case 'weekday': out.weekday = WEEKDAYS[value]; break;
      default: break;
    }
  }
  return out;
}

// The instant at which the wall clock in [tz] reads [parts] (month 1-12).
// Two-pass offset solve: guess the UTC instant with the same digits, read
// the zone's wall clock back at that guess, correct by the difference, and
// check once more so a DST-edge guess settles. A wall time inside a
// spring-forward gap (one that never happens on the clock) resolves to a
// nearby instant; period bounds are midnights, which no supported zone
// skips, so callers never land there in practice.
export function zonedToUtc({ year, month, day = 1, hour = 0, minute = 0, second = 0 }, tz) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = seen - wanted;
    if (diff === 0) { break; }
    guess -= diff;
  }
  return new Date(guess);
}

// ── Stored text formats ──────────────────────────────────────────────────
// play_events.started_at / ended_at: 'YYYY-MM-DD HH:MM:SS.SSS', UTC.
// user_hour_stats.hour: 'YYYY-MM-DDTHH', UTC.
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function toSqlite(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    + `.${pad(d.getUTCMilliseconds(), 3)}`;
}

// Reads the stored shape with or without milliseconds — datetime('now')
// rows elsewhere in the schema have none — and tolerates a 'T' separator
// and a trailing 'Z'. Null for anything else.
export function fromSqlite(text) {
  if (text == null) { return null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(String(text));
  if (!m) { return null; }
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso(value) {
  const d = value instanceof Date ? value : fromSqlite(value);
  return d ? d.toISOString() : null;
}

export function hourKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
}

export function fromHourKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(String(key));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])) : null;
}

export const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// The oldest start still inside the retention window: [retentionMonths]
// back from [now], to the hour; 2000-01-01 when retention is off. Ingest
// refuses anything older; the sweep prunes anything older.
export function retentionFloor(now, retentionMonths) {
  if (!(retentionMonths > 0)) { return new Date(Date.UTC(2000, 0, 1)); }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retentionMonths,
    now.getUTCDate(), now.getUTCHours()));
}

// ── Periods ──────────────────────────────────────────────────────────────
const daysSinceMonday = (weekday) => (weekday + 6) % 7;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function periodLabel(period, startWall) {
  const y = startWall.getUTCFullYear();
  const m = startWall.getUTCMonth();
  switch (period) {
    case 'month': return `${MONTHS[m]} ${y}`;
    case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`;
    case 'half': return `H${m < 6 ? 1 : 2} ${y}`;
    case 'year': return String(y);
    default: return '';
  }
}

// [from, to) for a preset period in [tz], shifted by [offset] whole periods
// (0 = the one containing [now], -1 = the previous, …). Bounds are local
// midnights; weeks start on Monday. 'all' is an open range from 2000.
export function periodRange({ period, offset = 0, tz = 'UTC', now = new Date() }) {
  if (!isPeriod(period)) { throw new RangeError(`unknown period '${period}'`); }
  if (period === 'all') {
    return {
      from: new Date(Date.UTC(2000, 0, 1)),
      to: new Date(now.getTime() + 86_400_000),
      label: 'All time',
    };
  }
  const p = zonedParts(now, tz);
  const wall = (d) => zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz);

  if (period === 'week') {
    // Wall dates as UTC-midnight Dates so day arithmetic normalises itself.
    const start = new Date(Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday(p.weekday) + offset * 7));
    const end = new Date(start.getTime() + 7 * 86_400_000);
    return { from: wall(start), to: wall(end), label: `Week of ${isoDate(start)}` };
  }

  let months = 1;
  let m = p.month;
  switch (period) {
    case 'quarter': months = 3; m -= (m - 1) % 3; break;
    case 'half': months = 6; m = m <= 6 ? 1 : 7; break;
    case 'year': months = 12; m = 1; break;
    default: break;
  }
  const startWall = new Date(Date.UTC(p.year, m - 1 + offset * months, 1));
  const endWall = new Date(Date.UTC(p.year, m - 1 + (offset + 1) * months, 1));
  return { from: wall(startWall), to: wall(endWall), label: periodLabel(period, startWall) };
}

// An explicit [from, to) from two ISO instants.
export function customRange(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('from/to must be ISO 8601 instants');
  }
  if (!(from < to)) { throw new RangeError('from must be before to'); }
  return { from, to, label: `${isoDate(from)} to ${isoDate(to)}` };
}

// ── Re-bucketing the UTC-hour rollup into the caller's zone ──────────────
// hour → 'YYYY-MM-DDTHH' local; day → 'YYYY-MM-DD'; week → the Monday's
// 'YYYY-MM-DD'; month → 'YYYY-MM'; hourOfDay → '0'..'23'; weekday →
// '0'..'6' with Sunday = 0. Null for a malformed key or unknown bucket.
export function bucketKeyFor(hourKeyUtc, bucket, tz) {
  const instant = fromHourKey(hourKeyUtc);
  if (!instant || !isBucket(bucket)) { return null; }
  const p = zonedParts(instant, tz);
  switch (bucket) {
    case 'hour': return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
    case 'day': return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    case 'week': return isoDate(new Date(Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday(p.weekday))));
    case 'month': return `${p.year}-${pad(p.month)}`;
    case 'hourOfDay': return String(p.hour);
    case 'weekday': return String(p.weekday);
    default: return null;
  }
}

// The local calendar day of an instant (or stored text), for streaks and
// the top listening day.
export function localDay(value, tz) {
  const d = value instanceof Date ? value : fromSqlite(value);
  if (!d) { return null; }
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Day arithmetic on 'YYYY-MM-DD' keys (UTC-midnight Dates underneath).
export function dayKeyPlus(dayKey, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey));
  if (!m) { return null; }
  return isoDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)));
}
