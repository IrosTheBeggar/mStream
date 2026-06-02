/**
 * HTTP-level tests for the backup admin API (src/api/backup.js).
 *
 * Focus: the validation-status-code regression found in the audit.
 * requireDailyHour() throws a plain Error, and the create/patch handlers
 * called it OUTSIDE a try/catch — so under Express 5 the throw reached the
 * global error middleware, which only maps Joi.ValidationError / WebError
 * and turned this client mistake into `500 { error: 'Server Error' }`,
 * dropping the explanatory message. The handlers now catch it and return
 * 400 with the real message. Express routing is the thing under test, so
 * this has to run over real HTTP rather than against the handler in
 * isolation.
 *
 * requireDailyHour runs before the destPath / library-existence checks, so
 * these cases don't need a real library id or a writable destPath.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };

let server, adminJwt;

before(async () => {
  // No need to wait for the library scan — we only exercise input validation.
  server = await startServer({ dlnaMode: 'disabled', waitForScan: false, users: [{ ...ADMIN, admin: true }] });
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminJwt = (await r.json()).token;
});

after(async () => { if (server) { await server.stop(); } });

function adminReq(method, urlPath, body) {
  return fetch(`${server.baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': adminJwt },
    body: JSON.stringify(body),
  });
}

describe('backup destinations: daily-hour validation status code', () => {
  test('POST triggerType=daily without dailyAtHour → 400 with a useful message (not 500)', async () => {
    const r = await adminReq('POST', '/api/v1/admin/backup/destinations', {
      libraryId: 1,
      destPath: '/tmp/mstream-audit-daily-no-hour',
      triggerType: 'daily',
    });
    assert.equal(r.status, 400, 'a missing daily hour is a client error, not a server error');
    const body = await r.json();
    assert.match(body.error || '', /dailyAtHour/i, 'the explanatory message must reach the client');
  });

  test('POST triggerType=daily WITH a valid dailyAtHour passes the daily-hour gate', async () => {
    // libraryId 999999 doesn't exist, so this is expected to fail the LATER
    // library-existence check with 400 "Library not found" — the point is it
    // gets PAST requireDailyHour (no 500, and not the daily-hour message).
    const r = await adminReq('POST', '/api/v1/admin/backup/destinations', {
      libraryId: 999999,
      destPath: '/tmp/mstream-audit-daily-with-hour',
      triggerType: 'daily',
      dailyAtHour: 3,
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.doesNotMatch(body.error || '', /dailyAtHour/i,
      'with a valid hour the request must clear the daily-hour gate');
    assert.match(body.error || '', /library not found/i,
      'it should fail at the next check (unknown library), proving the gate passed');
  });

  test('malformed :id (non-numeric) returns 404, not a 500', async () => {
    // Number('abc') === NaN; node:sqlite binds NaN to a no-match, so the
    // existing "destination not found" path handles it cleanly.
    const r = await fetch(`${server.baseUrl}/api/v1/admin/backup/destinations/abc`, {
      headers: { 'x-access-token': adminJwt },
    });
    assert.equal(r.status, 404);
  });
});
