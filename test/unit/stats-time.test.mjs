/**
 * src/stats/time.js — period and timezone arithmetic for the stats API.
 *
 * Pins the contract the read routes rely on:
 *  - stored-text round trips (SQLite datetime text with milliseconds, the
 *    no-ms form datetime('now') writes, and the ISO/Z tolerance);
 *  - zonedToUtc solves wall-clock midnights in the caller's zone, on both
 *    sides of a DST change and in a half-hour zone;
 *  - periodRange produces [from, to) as LOCAL midnights, Monday-first weeks,
 *    whole-period offsets, and the labels;
 *  - bucketKeyFor re-buckets a UTC hour into the caller's calendar.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSqlite, fromSqlite, toIso, hourKey, fromHourKey, isValidTimeZone, zonedParts,
  zonedToUtc, periodRange, customRange, bucketKeyFor, localDay, dayKeyPlus,
} from '../../src/stats/time.js';

const iso = (d) => d.toISOString();

describe('stored text formats', () => {
  test('toSqlite writes UTC with milliseconds; fromSqlite reads it back', () => {
    const d = new Date('2026-09-04T19:04:00.123Z');
    assert.equal(toSqlite(d), '2026-09-04 19:04:00.123');
    assert.equal(iso(fromSqlite('2026-09-04 19:04:00.123')), '2026-09-04T19:04:00.123Z');
  });

  test("fromSqlite accepts datetime('now') rows, a T separator and a Z", () => {
    assert.equal(iso(fromSqlite('2026-09-04 19:04:00')), '2026-09-04T19:04:00.000Z');
    assert.equal(iso(fromSqlite('2026-09-04T19:04:00Z')), '2026-09-04T19:04:00.000Z');
    assert.equal(fromSqlite('yesterday'), null);
    assert.equal(fromSqlite(null), null);
    assert.equal(toIso('2026-09-04 19:04:00'), '2026-09-04T19:04:00.000Z');
  });

  test('hourKey / fromHourKey', () => {
    assert.equal(hourKey(new Date('2026-09-04T19:59:59.999Z')), '2026-09-04T19');
    assert.equal(iso(fromHourKey('2026-09-04T19')), '2026-09-04T19:00:00.000Z');
    assert.equal(fromHourKey('2026-09-04'), null);
  });
});

describe('timezones', () => {
  test('isValidTimeZone', () => {
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone(undefined), false);
  });

  test('zonedParts reads the wall clock in the zone', () => {
    const p = zonedParts(new Date('2026-09-05T23:30:00Z'), 'Europe/Berlin');
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 9, 6, 1, 30, 0]);
  });

  test('zonedToUtc: UTC identity, summer and winter offsets, half-hour zone', () => {
    assert.equal(iso(zonedToUtc({ year: 2026, month: 7, day: 1 }, 'UTC')), '2026-07-01T00:00:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 7, day: 1 }, 'Europe/Berlin')), '2026-06-30T22:00:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 1, day: 1 }, 'Europe/Berlin')), '2025-12-31T23:00:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 9, day: 6 }, 'Asia/Kolkata')), '2026-09-05T18:30:00.000Z');
  });

  test('zonedToUtc across the US spring-forward day', () => {
    // 2026-03-08: clocks jump 02:00 → 03:00 in New York. Midnight before
    // and 03:00 after are both real wall times.
    assert.equal(iso(zonedToUtc({ year: 2026, month: 3, day: 8 }, 'America/New_York')), '2026-03-08T05:00:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 3 }, 'America/New_York')), '2026-03-08T07:00:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 3, day: 9 }, 'America/New_York')), '2026-03-09T04:00:00.000Z');
  });
});

describe('periodRange', () => {
  // A Sunday, midday UTC, in a summer-time zone one hour ahead.
  const now = new Date('2026-09-06T12:00:00Z');
  const tz = 'Europe/Berlin';

  test('month, current and previous, as local midnights', () => {
    const cur = periodRange({ period: 'month', tz, now });
    assert.equal(iso(cur.from), '2026-08-31T22:00:00.000Z');
    assert.equal(iso(cur.to), '2026-09-30T22:00:00.000Z');
    assert.equal(cur.label, 'September 2026');
    const prev = periodRange({ period: 'month', offset: -1, tz, now });
    assert.equal(iso(prev.from), '2026-07-31T22:00:00.000Z');
    assert.equal(iso(prev.to), '2026-08-31T22:00:00.000Z');
    assert.equal(prev.label, 'August 2026');
  });

  test('week is Monday-first', () => {
    const cur = periodRange({ period: 'week', tz, now });
    assert.equal(iso(cur.from), '2026-08-30T22:00:00.000Z'); // Mon 2026-08-31 local
    assert.equal(iso(cur.to), '2026-09-06T22:00:00.000Z');
    assert.equal(cur.label, 'Week of 2026-08-31');
    const prev = periodRange({ period: 'week', offset: -1, tz, now });
    assert.equal(iso(prev.from), '2026-08-23T22:00:00.000Z');
    assert.equal(prev.label, 'Week of 2026-08-24');
  });

  test('quarter, half, year — and a year boundary crosses the winter offset', () => {
    const q = periodRange({ period: 'quarter', tz, now });
    assert.equal(iso(q.from), '2026-06-30T22:00:00.000Z');
    assert.equal(iso(q.to), '2026-09-30T22:00:00.000Z');
    assert.equal(q.label, 'Q3 2026');
    const h = periodRange({ period: 'half', tz, now });
    assert.equal(iso(h.from), '2026-06-30T22:00:00.000Z');
    assert.equal(iso(h.to), '2026-12-31T23:00:00.000Z');
    assert.equal(h.label, 'H2 2026');
    const y = periodRange({ period: 'year', tz, now });
    assert.equal(iso(y.from), '2025-12-31T23:00:00.000Z');
    assert.equal(iso(y.to), '2026-12-31T23:00:00.000Z');
    assert.equal(y.label, '2026');
    const lastYear = periodRange({ period: 'year', offset: -1, tz, now });
    assert.equal(lastYear.label, '2025');
    assert.equal(iso(lastYear.to), '2025-12-31T23:00:00.000Z');
  });

  test("'all' is open-ended and unknown periods throw", () => {
    const all = periodRange({ period: 'all', tz, now });
    assert.equal(iso(all.from), '2000-01-01T00:00:00.000Z');
    assert.ok(all.to > now);
    assert.equal(all.label, 'All time');
    assert.throws(() => periodRange({ period: 'fortnight', tz, now }), RangeError);
  });

  test('customRange validates order and instants', () => {
    const r = customRange('2026-09-01T00:00:00Z', '2026-09-04T00:00:00Z');
    assert.equal(r.label, '2026-09-01 to 2026-09-04');
    assert.throws(() => customRange('2026-09-04T00:00:00Z', '2026-09-01T00:00:00Z'), RangeError);
    assert.throws(() => customRange('soon', '2026-09-01T00:00:00Z'), RangeError);
  });
});

describe('re-bucketing', () => {
  test('a UTC hour lands in the local calendar', () => {
    // 23:00Z on Saturday 2026-09-05 is 01:00 on Sunday 2026-09-06 in Berlin.
    const k = '2026-09-05T23';
    assert.equal(bucketKeyFor(k, 'hour', 'Europe/Berlin'), '2026-09-06T01');
    assert.equal(bucketKeyFor(k, 'day', 'Europe/Berlin'), '2026-09-06');
    assert.equal(bucketKeyFor(k, 'week', 'Europe/Berlin'), '2026-08-31');
    assert.equal(bucketKeyFor(k, 'month', 'Europe/Berlin'), '2026-09');
    assert.equal(bucketKeyFor(k, 'hourOfDay', 'Europe/Berlin'), '1');
    assert.equal(bucketKeyFor(k, 'weekday', 'Europe/Berlin'), '0');
    assert.equal(bucketKeyFor(k, 'day', 'UTC'), '2026-09-05');
    assert.equal(bucketKeyFor(k, 'fortnight', 'UTC'), null);
    assert.equal(bucketKeyFor('nope', 'day', 'UTC'), null);
  });

  test('localDay and dayKeyPlus', () => {
    assert.equal(localDay('2026-09-05 23:30:00', 'Europe/Berlin'), '2026-09-06');
    assert.equal(localDay(new Date('2026-09-05T23:30:00Z'), 'UTC'), '2026-09-05');
    assert.equal(dayKeyPlus('2026-08-31', 1), '2026-09-01');
    assert.equal(dayKeyPlus('2026-03-01', -1), '2026-02-28');
    assert.equal(dayKeyPlus('bad', 1), null);
  });
});
