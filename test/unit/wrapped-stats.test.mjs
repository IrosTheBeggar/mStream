/**
 * Pins for the wrapped-stats fixes (2026-07 audit PR-I):
 *
 *   H7 — listening_by_hour / listening_by_weekday come from one GROUP BY
 *        strftime pass; buckets must equal what the old per-row
 *        Date#getHours()/getDay() loop produced (oracle reimplemented here);
 *   H7 — earliest_play is the period's true earliest TIME OF DAY. The old
 *        loop compared against `new Date('2000-01-01T09:13 AM')` — Invalid
 *        Date, NaN comparison — and froze on the first row, reporting the
 *        period's first event instead;
 *   M2 — the V65 composite index exists on a fresh DB.
 *
 * wrapped.setup() is mounted on a bare express app (it only needs config +
 * db manager), with req.user injected directly — the same harness shape as
 * test/db/db-read-paths.test.mjs.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

let testRoot, server, base;
let config, manager, wrapped;
let uid, uidOther;
const pad = (n) => String(n).padStart(2, '0');

// This month's window, in the DB's own 'YYYY-MM-DD HH:MM:SS' shape.
const now = new Date();
const Y = now.getUTCFullYear(), M = now.getUTCMonth();
const ts = (day, hh, mm, ss = 0) => `${Y}-${pad(M + 1)}-${pad(day)} ${pad(hh)}:${pad(mm)}:${pad(ss)}`;

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-wrap-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  wrapped = await import('../../src/api/wrapped.js');

  const d = manager.getDB();
  d.prepare(`INSERT INTO users (username, password, salt) VALUES ('wrapper', 'x', 'x')`).run();
  d.prepare(`INSERT INTO users (username, password, salt) VALUES ('other', 'x', 'x')`).run();
  uid = d.prepare("SELECT id FROM users WHERE username='wrapper'").get().id;
  uidOther = d.prepare("SELECT id FROM users WHERE username='other'").get().id;

  const ins = d.prepare(`INSERT INTO play_events
    (event_id, user_id, filepath, library_id, session_id, track_duration_ms,
     started_at, ended_at, outcome, played_ms, pause_count)
    VALUES (?, ?, ?, NULL, ?, 200000, ?, ?, ?, ?, 0)`);
  let n = 0;
  const add = (userId, when, outcome = 'completed') =>
    ins.run(`we-${n++}`, userId, `song${n % 7}.mp3`, `s-${Math.floor(n / 3)}`, when, when, outcome, 60000);

  // The period's FIRST event is 09:13 on day 1; the true earliest
  // time-of-day (04:07) happens later in the month — the frozen bug
  // reported 09:13.
  add(uid, ts(1, 9, 13));
  add(uid, ts(1, 22, 40));
  add(uid, ts(2, 4, 7));           // earliest time-of-day, NOT the first row
  add(uid, ts(2, 4, 30));
  add(uid, ts(3, 23, 59, 59));
  // Bulk filler stays inside 06:00–22:59 so 04:07 remains the true minimum.
  for (let i = 0; i < 40; i++) { add(uid, ts(4 + (i % 20), 6 + ((8 + i) % 17), i % 60), i % 4 === 0 ? 'skipped' : 'completed'); }
  // Another user's plays in the same window must not leak in.
  add(uidOther, ts(2, 1, 1));
  add(uidOther, ts(2, 1, 2));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.headers['x-uid'] ? Number(req.headers['x-uid']) : uid, libraryIds: [] }; next(); });
  wrapped.setup(app);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Await the close: exiting while the listen handle is still tearing down
  // trips libuv's UV_HANDLE_CLOSING assert on Windows.
  try { if (server) { await new Promise((r) => server.close(r)); } } catch (_e) { /* closed */ }
  try { manager.close(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  // No forced process.exit here: everything this suite starts is closed
  // above and the process exits cleanly on its own — a setImmediate exit(0)
  // raced libuv handle teardown on Windows and tripped
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (async.c).
});

async function getWrapped(params = 'period=monthly', headers = {}) {
  const r = await fetch(`${base}/api/v1/user/wrapped?${params}`, { headers });
  return r.json();
}

describe('wrapped H7: histograms + earliest_play', () => {
  test('hour/weekday buckets equal the old per-row loop exactly', async () => {
    const j = await getWrapped();
    // Oracle: the pre-PR loop, verbatim semantics (local-parse + getHours/
    // getDay), over the same rows.
    const d = manager.getDB();
    const { start, end } = wrapped.getPeriodRange('monthly', 0);
    const rows = d.prepare(
      'SELECT started_at FROM play_events WHERE user_id = ? AND started_at >= ? AND started_at < ?'
    ).all(uid, start, end);
    const hour = new Array(24).fill(0);
    const weekday = new Array(7).fill(0);
    for (const row of rows) {
      const dt = new Date(row.started_at);
      hour[dt.getHours()]++;
      weekday[dt.getDay()]++;
    }
    assert.deepEqual(j.listening_by_hour, hour);
    assert.deepEqual(j.listening_by_weekday, weekday);
    assert.equal(j.listening_by_hour.reduce((a, b) => a + b, 0), j.total_plays,
      'every play lands in exactly one hour bucket');
  });

  test('earliest_play is the true earliest time-of-day, not the first event', async () => {
    const j = await getWrapped();
    // Expected string built through the SAME toLocaleTimeString call the
    // handler uses, so the assertion is ICU-version-proof.
    const expected = new Date('2000-01-01 04:07:00')
      .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const frozen = new Date('2000-01-01 09:13:00')
      .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    assert.equal(j.fun_facts.earliest_play, expected);
    assert.notEqual(j.fun_facts.earliest_play, frozen,
      'the frozen-on-row-1 value must be gone');
  });

  test('another user\'s plays in the window do not leak in', async () => {
    const mine = await getWrapped();
    const theirs = await getWrapped('period=monthly', { 'x-uid': String(uidOther) });
    assert.equal(theirs.total_plays, 2);
    assert.equal(mine.total_plays, 45);
    // Their 01:01 play must not become my earliest.
    assert.notEqual(mine.fun_facts.earliest_play, theirs.fun_facts.earliest_play);
  });

  test('an empty period is zeros and nulls, not a crash', async () => {
    // monthly offset far in the past — no events there.
    const j = await getWrapped('period=monthly&offset=-120');
    assert.equal(j.total_plays, 0);
    assert.deepEqual(j.listening_by_hour, new Array(24).fill(0));
    assert.deepEqual(j.listening_by_weekday, new Array(7).fill(0));
    assert.equal(j.fun_facts.earliest_play, null);
  });
});

describe('wrapped M2: composite index', () => {
  test('a fresh DB carries idx_play_events_user_time', () => {
    const row = manager.getDB().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_play_events_user_time'"
    ).get();
    assert.ok(row, 'V65 index present');
  });

  test('the period window query uses it', () => {
    const plan = manager.getDB().prepare(`EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM play_events WHERE user_id = ? AND started_at >= ? AND started_at < ?`)
      .all(uid, '2026-01-01 00:00:00', '2026-02-01 00:00:00')
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_play_events_user_time/);
  });
});
