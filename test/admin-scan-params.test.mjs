/**
 * Integration tests for the admin-panel scanOptions toggle endpoints.
 *
 * Currently focused on /api/v1/admin/db/params/analyze-bpm — the
 * stratum-dsp BPM + key detection toggle added alongside this file.
 * Sibling toggles (skip-img, generate-waveforms, scan-threads, …)
 * share the same shape; the broader family is a candidate for a
 * follow-up sweep here if/when one is needed.
 *
 *   GET  /api/v1/admin/db/params                 whole scanOptions object
 *   POST /api/v1/admin/db/params/analyze-bpm     boolean toggle, persists to
 *                                                config.json + config.program
 *                                                in-memory
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

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

function adminGet(path, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, { headers: { 'x-access-token': jwt } });
}
function adminPost(path, body, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}

// ── GET /db/params ────────────────────────────────────────────────────────

describe('GET /api/v1/admin/db/params', () => {
  test('returns the full scanOptions object including analyzeBpm', async () => {
    const r = await adminGet('/api/v1/admin/db/params');
    assert.equal(r.status, 200);
    const body = await r.json();
    // Defaults from src/state/config.js scanOptions:
    //   analyzeBpm: false  (opt-in — expensive on large libraries / weak hardware)
    //   generateWaveforms: true
    //   skipImg: false
    // These are the surrounding fields the new toggle slots into;
    // assert them too so a regression in the schema shape (e.g. a
    // typoed key) shows up here instead of as a silent UI bug.
    assert.equal(typeof body.analyzeBpm, 'boolean',
      `analyzeBpm should be a boolean, got ${typeof body.analyzeBpm}`);
    assert.equal(body.analyzeBpm, false, 'analyzeBpm default is false (opt-in)');
    assert.equal(typeof body.generateWaveforms, 'boolean');
    assert.equal(typeof body.skipImg, 'boolean');
  });

  test('rejects non-admin users with 405 (outer admin guard)', async () => {
    const r = await adminGet('/api/v1/admin/db/params', userJwt);
    assert.equal(r.status, 405);
  });
});

// ── POST /db/params/analyze-bpm ───────────────────────────────────────────

describe('POST /api/v1/admin/db/params/analyze-bpm', () => {
  test('toggles analyzeBpm and reflects in subsequent GET', async () => {
    // Read current value first — order matters because the param
    // gate test below mutates it again. We don't assume an initial
    // value (the test runner might re-use a previous run's tmp).
    const r1 = await adminGet('/api/v1/admin/db/params');
    const before = (await r1.json()).analyzeBpm;

    // Flip
    const flipTo = !before;
    const r2 = await adminPost('/api/v1/admin/db/params/analyze-bpm',
      { analyzeBpm: flipTo });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), {},
      'happy-path response is the empty object {}');

    // GET reflects the change — proves the in-memory mutation
    // actually happened (config.program.scanOptions.analyzeBpm).
    // The on-disk write is exercised by the same code path; if
    // saveFile threw, the helper would have rejected.
    const r3 = await adminGet('/api/v1/admin/db/params');
    assert.equal((await r3.json()).analyzeBpm, flipTo);

    // Flip back so subsequent tests start in a known state
    await adminPost('/api/v1/admin/db/params/analyze-bpm',
      { analyzeBpm: before });
  });

  test('rejects non-boolean payload', async () => {
    // joiValidate throws on bad input; mStream's global error handler
    // surfaces all thrown route errors as 403. Same status used by
    // every other admin-API validation failure in the codebase — see
    // any of the sibling /db/params/* routes for the pattern.
    for (const bad of [{ analyzeBpm: 'yes' }, { analyzeBpm: 1 }, { analyzeBpm: null }]) {
      const r = await adminPost('/api/v1/admin/db/params/analyze-bpm', bad);
      assert.equal(r.status, 403,
        `expected validation rejection for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });

  test('rejects missing analyzeBpm field', async () => {
    const r = await adminPost('/api/v1/admin/db/params/analyze-bpm', {});
    assert.equal(r.status, 403);
  });

  test('rejects non-admin users with 405', async () => {
    const r = await adminPost('/api/v1/admin/db/params/analyze-bpm',
      { analyzeBpm: true }, userJwt);
    assert.equal(r.status, 405);
  });
});
