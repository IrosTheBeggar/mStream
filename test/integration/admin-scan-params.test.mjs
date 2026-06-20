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
    // maps Joi.ValidationError to 400 Bad Request. Same status used by
    // every other admin-API validation failure in the codebase — see
    // any of the sibling /db/params/* routes for the pattern.
    for (const bad of [{ analyzeBpm: 'yes' }, { analyzeBpm: 1 }, { analyzeBpm: null }]) {
      const r = await adminPost('/api/v1/admin/db/params/analyze-bpm', bad);
      assert.equal(r.status, 400,
        `expected validation rejection for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });

  test('rejects missing analyzeBpm field', async () => {
    const r = await adminPost('/api/v1/admin/db/params/analyze-bpm', {});
    assert.equal(r.status, 400);
  });

  test('rejects non-admin users with 405', async () => {
    const r = await adminPost('/api/v1/admin/db/params/analyze-bpm',
      { analyzeBpm: true }, userJwt);
    assert.equal(r.status, 405);
  });
});

// ── POST /db/params/auto-album-art-* (the downloader's config family) ──────
//
// Same four-part pattern as analyze-bpm above: GET defaults, happy-path
// flip + reflect, Joi boundary rejections (400), non-admin 405. All
// side-effect-free against the fixtures: the helper boots with
// autoAlbumArt:false, so no flip here can enqueue a download pass.

describe('downloader config params', () => {
  test('GET includes the downloader defaults', async () => {
    const body = await (await adminGet('/api/v1/admin/db/params')).json();
    assert.equal(body.autoAlbumArtMode, 'missing');
    assert.equal(body.autoAlbumArtWriteToFolder, false);
    assert.equal(body.autoAlbumArtPerRun, 100);
  });

  test('auto-album-art-mode: flips + reflects; rejects junk; 405 non-admin', async () => {
    const r1 = await adminPost('/api/v1/admin/db/params/auto-album-art-mode',
      { autoAlbumArtMode: 'all' });
    assert.equal(r1.status, 200);
    assert.equal((await (await adminGet('/api/v1/admin/db/params')).json()).autoAlbumArtMode, 'all');
    await adminPost('/api/v1/admin/db/params/auto-album-art-mode', { autoAlbumArtMode: 'missing' });

    for (const bad of [{ autoAlbumArtMode: 'sometimes' }, { autoAlbumArtMode: true }, {}]) {
      const r = await adminPost('/api/v1/admin/db/params/auto-album-art-mode', bad);
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
    }
    assert.equal((await adminPost('/api/v1/admin/db/params/auto-album-art-mode',
      { autoAlbumArtMode: 'all' }, userJwt)).status, 405);
  });

  test('auto-album-art-write-to-folder: flips + reflects; rejects junk; 405 non-admin', async () => {
    const r1 = await adminPost('/api/v1/admin/db/params/auto-album-art-write-to-folder',
      { autoAlbumArtWriteToFolder: true });
    assert.equal(r1.status, 200);
    assert.equal((await (await adminGet('/api/v1/admin/db/params')).json()).autoAlbumArtWriteToFolder, true);
    await adminPost('/api/v1/admin/db/params/auto-album-art-write-to-folder',
      { autoAlbumArtWriteToFolder: false });

    for (const bad of [{ autoAlbumArtWriteToFolder: 'yes' }, { autoAlbumArtWriteToFolder: 1 }, {}]) {
      const r = await adminPost('/api/v1/admin/db/params/auto-album-art-write-to-folder', bad);
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
    }
    assert.equal((await adminPost('/api/v1/admin/db/params/auto-album-art-write-to-folder',
      { autoAlbumArtWriteToFolder: true }, userJwt)).status, 405);
  });

  test('auto-album-art-per-run: sets + reflects; rejects out-of-range; 405 non-admin', async () => {
    const r1 = await adminPost('/api/v1/admin/db/params/auto-album-art-per-run',
      { autoAlbumArtPerRun: 250 });
    assert.equal(r1.status, 200);
    assert.equal((await (await adminGet('/api/v1/admin/db/params')).json()).autoAlbumArtPerRun, 250);
    await adminPost('/api/v1/admin/db/params/auto-album-art-per-run', { autoAlbumArtPerRun: 100 });

    for (const bad of [{ autoAlbumArtPerRun: 0 }, { autoAlbumArtPerRun: 10001 },
      { autoAlbumArtPerRun: 'abc' }, { autoAlbumArtPerRun: 2.5 }, {}]) {
      const r = await adminPost('/api/v1/admin/db/params/auto-album-art-per-run', bad);
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
    }
    assert.equal((await adminPost('/api/v1/admin/db/params/auto-album-art-per-run',
      { autoAlbumArtPerRun: 50 }, userJwt)).status, 405);
  });

  test('auto-album-art toggle ON routes through the guarded enqueue (no crash, empty 200)', async () => {
    // Toggling ON exercises the maybeEnqueueAlbumArt path. The fixture
    // library IS scanned and art-less, so without a guard this would fork
    // a REAL-network download pass — empty the service list first: the
    // guard treats it as feature-off and declines to fork, which is
    // exactly the gate this test pins. Restore everything after.
    await adminPost('/api/v1/admin/db/params/album-art-services', { albumArtServices: [] });
    const r1 = await adminPost('/api/v1/admin/db/params/auto-album-art', { autoAlbumArt: true });
    assert.equal(r1.status, 200);
    const r2 = await adminPost('/api/v1/admin/db/params/auto-album-art', { autoAlbumArt: false });
    assert.equal(r2.status, 200);
    await adminPost('/api/v1/admin/db/params/album-art-services',
      { albumArtServices: ['musicbrainz', 'itunes', 'deezer'] });
    assert.equal((await (await adminGet('/api/v1/admin/db/params')).json()).autoAlbumArt, false);
  });
});

// ── POST /config/trust-proxy ──────────────────────────────────────────────

describe('POST /api/v1/admin/config/trust-proxy', () => {
  async function getTrustProxy() {
    const r = await adminGet('/api/v1/admin/config');
    assert.equal(r.status, 200);
    return (await r.json()).trustProxy;
  }

  // Changing the value triggers a soft reboot (Express' 'trust proxy' is
  // applied at boot), and the teardown happens AFTER the 200 response — so
  // polls right after the POST may hit the old instance (stale value) or the
  // connection-refused window. Poll for the expected VALUE, tolerating
  // connection errors, until the rebooted instance answers.
  async function waitForTrustProxy(expected, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await adminGet('/api/v1/admin/config');
        if (r.status === 200 && (await r.json()).trustProxy === expected) { return; }
      } catch { /* mid-reboot */ }
      if (Date.now() > deadline) { throw new Error(`trustProxy never became ${expected} after reboot`); }
      await new Promise(res => setTimeout(res, 250));
    }
  }

  async function postTrustProxyWithRetry(value, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await adminPost('/api/v1/admin/config/trust-proxy', { trustProxy: value });
        if (r.status === 200) { return; }
      } catch { /* mid-reboot */ }
      if (Date.now() > deadline) { throw new Error('trust-proxy POST never succeeded'); }
      await new Promise(res => setTimeout(res, 250));
    }
  }

  test('GET /admin/config exposes trustProxy (default false)', async () => {
    assert.equal(await getTrustProxy(), false);
  });

  test('no-op POST of the current value returns 200 without a reboot', async () => {
    const r = await adminPost('/api/v1/admin/config/trust-proxy', { trustProxy: false });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    assert.equal(await getTrustProxy(), false);
  });

  test('changing the value persists across the triggered reboot', async () => {
    const r = await adminPost('/api/v1/admin/config/trust-proxy', { trustProxy: true });
    assert.equal(r.status, 200);
    await waitForTrustProxy(true);

    // Flip back so the suite leaves the server in its default state.
    await postTrustProxyWithRetry(false);
    await waitForTrustProxy(false);
  });

  test('rejects non-boolean payload', async () => {
    for (const bad of [{ trustProxy: 'yes' }, { trustProxy: 1 }, {}]) {
      const r = await adminPost('/api/v1/admin/config/trust-proxy', bad);
      assert.equal(r.status, 400,
        `expected validation rejection for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });

  test('rejects non-admin users with 405', async () => {
    const r = await adminPost('/api/v1/admin/config/trust-proxy', { trustProxy: true }, userJwt);
    assert.equal(r.status, 405);
  });
});
