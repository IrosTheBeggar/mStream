/**
 * Integration tests for POST /api/v1/admin/users/lastfm — the admin endpoint
 * that stores a target user's Last.fm credentials (the V1
 * lastfm_user/lastfm_password columns on the users row).
 *
 * This route was previously dead on arrival on two counts:
 *   1. it called admin.setUserLastFM(), which didn't exist / wasn't exported
 *      from src/util/admin.js → TypeError on every request;
 *   2. its Joi schema required `lasftfmUser`/`lasftfmPassword` (typo'd) while
 *      the handler read req.body.username/req.body.password — so the required
 *      fields were never used and the read fields were never validated.
 *
 * The fix settles the request shape as { username, lastfmUser, lastfmPassword }
 * (matching /lastfm/connect's lastfmUser/lastfmPassword naming and the
 * username-targeting of the sibling /admin/users/* routes). These tests pin
 * that shape: the happy path persists + reflects via /lastfm/status, and the
 * old typo'd field names are now rejected.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
let adminJwt;
let userJwt;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users: [
      { ...ADMIN, admin: true },
      { ...USER,  admin: false },
    ],
  });
  for (const [u, setJwt] of [[ADMIN, v => adminJwt = v], [USER, v => userJwt = v]]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    setJwt((await r.json()).token);
  }
});

after(async () => {
  if (server) { await server.stop(); }
});

function post(path, body, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}

// /lastfm/status echoes the requesting user's stored lastfm_user as
// `linkedUser` — a clean end-to-end read-back of what the admin endpoint wrote.
async function linkedUser(jwt) {
  const r = await fetch(`${server.baseUrl}/api/v1/lastfm/status`, {
    headers: { 'x-access-token': jwt },
  });
  assert.equal(r.status, 200);
  return (await r.json()).linkedUser;
}

describe('POST /api/v1/admin/users/lastfm', () => {
  test('stores the target user\'s creds; reflected via that user\'s /lastfm/status', async () => {
    // Precondition: bob has no linked Last.fm account yet.
    assert.equal(await linkedUser(userJwt), null);

    const r = await post('/api/v1/admin/users/lastfm', {
      username: 'bob', lastfmUser: 'bob-fm', lastfmPassword: 'hunter2',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {}, 'happy-path response is the empty object {}');

    // The write targeted bob by username, persisted lastfm_user, and the
    // helper's db.invalidateCache() means bob's next authenticated request
    // re-reads the fresh row — so /lastfm/status surfaces the linked account.
    assert.equal(await linkedUser(userJwt), 'bob-fm');

    // ...and only bob's row: the admin who made the call is unaffected
    // (proves we keyed off req.body.username, not the caller's identity).
    assert.equal(await linkedUser(adminJwt), null);
  });

  test('rejects the legacy typo\'d field names (lasftfmUser/lasftfmPassword) with 400', async () => {
    // This is the exact mismatch the fix corrected — the old schema required
    // these misspelled keys. They must now fail validation (unknown keys +
    // the real required fields absent).
    const r = await post('/api/v1/admin/users/lastfm', {
      username: 'bob', lasftfmUser: 'x', lasftfmPassword: 'y',
    });
    assert.equal(r.status, 400);
  });

  test('rejects missing / malformed payloads with 400', async () => {
    const bad = [
      {},                                                       // nothing
      { username: 'bob' },                                      // creds missing
      { username: 'bob', lastfmUser: 'x' },                     // password missing
      { username: 'bob', lastfmPassword: 'y' },                 // user missing
      { lastfmUser: 'x', lastfmPassword: 'y' },                 // username missing
      { username: 'bob', password: 'y' },                       // the old handler's read shape
      { username: 'bob', lastfmUser: 'x', lastfmPassword: 'y', extra: 1 }, // unknown key
    ];
    for (const body of bad) {
      const r = await post('/api/v1/admin/users/lastfm', body);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${r.status}`);
    }
  });

  test('rejects non-admin callers with 405 (outer admin guard)', async () => {
    const r = await post('/api/v1/admin/users/lastfm', {
      username: 'bob', lastfmUser: 'bob-fm', lastfmPassword: 'hunter2',
    }, userJwt);
    assert.equal(r.status, 405);
  });

  test('unknown target user surfaces the helper\'s thrown error (500)', async () => {
    // setUserLastFM throws a bare Error for a non-existent user — same shape as
    // every sibling user-management helper (editUserPassword, deleteUser, …),
    // which the global handler maps to 500. Pinned here so the not-found guard
    // can't silently regress into a no-op or a wrong-row write.
    const r = await post('/api/v1/admin/users/lastfm', {
      username: 'ghost', lastfmUser: 'x', lastfmPassword: 'y',
    });
    assert.equal(r.status, 500);
  });
});
