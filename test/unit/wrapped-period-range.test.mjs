/**
 * Regression test for the wrapped stats period windows (src/api/wrapped.js).
 *
 * play_events.started_at is written by SQLite as 'YYYY-MM-DD HH:MM:SS'
 * (datetime('now') — UTC, space separator). The window bounds from
 * getPeriodRange() are compared against it as TEXT, i.e. lexicographically.
 * They used to be toISOString() output ('YYYY-MM-DDTHH:MM:SS.sssZ'), whose
 * 'T' separator sorts AFTER ' ' — so whenever an event's DATE equalled the
 * window's start date, the event compared as before-the-window and was
 * dropped. In practice: every play made on the first day of a month
 * vanished from "This Month" (first surfaced 2026-07-01, when CI and the
 * public-mode-privacy suite failed on exactly this).
 *
 * These tests pin the two properties that prevent the bug class:
 *   1. Bounds use the exact SQLite datetime format (space, no ms, no zone).
 *   2. A datetime('now')-style timestamp taken right now falls inside the
 *      current window of every period — true on EVERY calendar day,
 *      including period-boundary days, which is where the old code failed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getPeriodRange } from '../../src/api/wrapped.js';

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PERIODS = ['weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'anything-else-defaults'];

// What SQLite's datetime('now') produces, built the same way (UTC).
function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

describe('getPeriodRange SQLite-format contract', () => {
  test('bounds are SQLite datetime strings, start < end', () => {
    for (const period of PERIODS) {
      for (const offset of [0, -1, -3]) {
        const { start, end } = getPeriodRange(period, offset);
        assert.match(start, SQLITE_DATETIME, `${period} offset ${offset} start`);
        assert.match(end, SQLITE_DATETIME, `${period} offset ${offset} end`);
        assert.ok(start < end, `${period} offset ${offset}: start sorts before end`);
      }
    }
  });

  test("an event stamped datetime('now') falls inside every current window", () => {
    // The exact property that broke: on a period's first day, the old
    // ISO-format bounds excluded same-day events by string comparison.
    const nowStamp = sqliteNow();
    for (const period of PERIODS) {
      const { start, end } = getPeriodRange(period, 0);
      assert.ok(start <= nowStamp, `${period}: now (${nowStamp}) not before start (${start})`);
      assert.ok(nowStamp < end, `${period}: now (${nowStamp}) inside end bound (${end})`);
    }
  });

  test('documents the lexicographic trap the format avoids', () => {
    // A same-date SQLite timestamp sorts BEFORE any ISO 'T' string —
    // this is why mixing the two formats in one comparison is never safe.
    assert.ok('2026-07-01 23:59:59' < '2026-07-01T00:00:00.000Z');
  });

  test('consecutive windows tile exactly (no gap, no overlap)', () => {
    // The default branch (unrecognized period string) deliberately ignores
    // offset — it always answers "this month" — so only the real periods
    // are expected to tile.
    for (const period of ['weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly']) {
      const prev = getPeriodRange(period, -1);
      const cur = getPeriodRange(period, 0);
      assert.equal(prev.end, cur.start,
        `${period}: previous window's end must equal current window's start`);
    }
  });
});
