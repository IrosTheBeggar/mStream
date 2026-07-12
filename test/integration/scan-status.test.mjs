/**
 * Integration tests for GET /api/v1/scan/status — the enrichment status
 * endpoint (queue snapshot + per-pass gates/state/lastRun + durable
 * coverage counts).
 *
 * Runs against a real booted server: the boot scan indexes the shared
 * fixture library, and — because generateWaveforms defaults on and the
 * repo ships a rust-parser prebuilt — the waveform enrichment pass
 * genuinely runs behind it, so the test can assert a real lastRun and
 * real coverage numbers end-to-end. The other passes stay disabled by
 * config (the server helper forces autoAlbumArt/collectDiscoveryData
 * off; lyrics/BPM/AcoustID default off), which pins the disabledReason
 * mapping over HTTP.
 *
 * Library filtering: coverage counts are scoped by the caller's
 * accessible libraries — a user with no vpaths must see zeroed
 * library-scoped counts (and totals), while hash-keyed passes stay
 * global by design.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../helpers/server.mjs';

const ADMIN    = { username: 'admin',  password: 'pw-admin' };
const NOACCESS = { username: 'novpath', password: 'pw-novpath', vpaths: [] };

let server;
let adminJwt;
let noAccessJwt;

async function login(user) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  return (await r.json()).token;
}

async function getStatus(jwt) {
  const r = await fetch(`${server.baseUrl}/api/v1/scan/status`, {
    headers: { 'x-access-token': jwt },
  });
  assert.equal(r.status, 200);
  return r.json();
}

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users: [
      { ...ADMIN, admin: true },
      NOACCESS,
    ],
  });
  adminJwt = await login(ADMIN);
  noAccessJwt = await login(NOACCESS);

  // Let the post-scan enrichment chain settle: the waveform pass runs
  // for real over the fixtures. Poll the endpoint itself — it's the
  // component under test AND the only authenticated view of the queue.
  const start = Date.now();
  for (;;) {
    const body = await getStatus(adminJwt);
    const wf = body.enrichment.find((p) => p.pass === 'waveform');
    if (body.queue.activeTask === null && body.queue.queued.length === 0 && wf.lastRun) { break; }
    if (Date.now() - start > 90_000) {
      throw new Error('enrichment queue did not settle within 90s');
    }
    await sleep(200);
  }
});

after(async () => {
  if (server) { await server.stop(); }
});

describe('GET /api/v1/scan/status', () => {
  test('requires authentication', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/scan/status`);
    assert.equal(r.status, 401);
  });

  test('reports the queue snapshot and all six passes', async () => {
    const body = await getStatus(adminJwt);

    assert.deepEqual(body.queue, { scanning: false, activeTask: null, queued: [] },
      'settled server: no heavy work, nothing queued');
    assert.ok(body.totals.tracks > 0, 'fixture library was scanned');

    assert.deepEqual(
      body.enrichment.map((p) => p.pass),
      ['waveform', 'albumart', 'lyrics', 'audioanalysis', 'discovery', 'acoustid']);
    for (const p of body.enrichment) {
      for (const key of ['enabled', 'disabledReason', 'state', 'progress', 'lastRun', 'coverage']) {
        assert.ok(key in p, `'${p.pass}' entry must carry '${key}'`);
      }
    }
  });

  test('config-disabled passes surface state=disabled with reason=config', async () => {
    const body = await getStatus(adminJwt);
    // The server helper forces autoAlbumArt + collectDiscoveryData off;
    // lyrics backfill, analyzeBpm and analyzeAcoustid default off.
    for (const kind of ['albumart', 'lyrics', 'audioanalysis', 'discovery', 'acoustid']) {
      const p = body.enrichment.find((e) => e.pass === kind);
      assert.equal(p.enabled, false, `${kind} should be disabled in the test config`);
      assert.equal(p.disabledReason, 'config');
      assert.equal(p.state, 'disabled');
    }
  });

  test('the waveform pass really ran: lastRun + coverage agree with the library', async () => {
    const body = await getStatus(adminJwt);
    const wf = body.enrichment.find((p) => p.pass === 'waveform');

    assert.equal(wf.enabled, true);
    assert.equal(wf.state, 'idle');
    assert.equal(wf.lastRun.outcome, 'completed');
    assert.ok(wf.lastRun.counts.generated > 0, 'fixtures should have produced waveforms');

    assert.equal(wf.coverage.scope, 'global');
    assert.ok(wf.coverage.done > 0, 'generated .bins must show up as durable coverage');
    assert.equal(wf.coverage.done + wf.coverage.remaining + (wf.coverage.outcomes.failed || 0),
      body.totals.tracks,
      'bins + backlog + failed markers account for every fixture hash');
  });

  test('coverage carries per-pass backlogs grounded in worker eligibility', async () => {
    const body = await getStatus(adminJwt);
    const byPass = Object.fromEntries(body.enrichment.map((p) => [p.pass, p]));

    // Fixtures embed artist/title but no lyrics — all lookup-able.
    assert.equal(byPass.lyrics.coverage.done, 0);
    assert.equal(byPass.lyrics.coverage.remaining, body.totals.tracks);

    // Fixtures are 1-second clips: below the analysis (30s) and AcoustID
    // (10s) duration floors, so neither pass has anything to do — the
    // backlog must NOT count structurally ineligible tracks.
    assert.equal(byPass.audioanalysis.coverage.remaining, 0);
    assert.equal(byPass.acoustid.coverage.remaining, 0);

    // Fixture albums ship no cover art.
    assert.ok(byPass.albumart.coverage.eligible > 0);
    assert.equal(byPass.albumart.coverage.done, 0);

    // Discovery has never been enabled → no discovery.db → no coverage.
    assert.equal(byPass.discovery.coverage, null);
  });

  test('library-scoped coverage is filtered by the caller\'s access', async () => {
    const body = await getStatus(noAccessJwt);

    assert.equal(body.totals.tracks, 0, 'no vpaths → no visible tracks');
    const byPass = Object.fromEntries(body.enrichment.map((p) => [p.pass, p]));
    assert.equal(byPass.albumart.coverage.eligible, 0);
    assert.equal(byPass.lyrics.coverage.remaining, 0);
    assert.deepEqual(byPass.acoustid.coverage.bySource, { tag: 0, acoustid: 0 });

    // Hash-keyed passes are global by design — the same numbers every
    // caller sees (waveforms are shared cache artifacts, not library rows).
    assert.ok(byPass.waveform.coverage.done > 0);
  });
});
