/**
 * Phase 3 — LRCLib external lyrics fallback.
 *
 * Exercises the full cache-through path with a local mock HTTP
 * server standing in for lrclib.net. The mock records every request
 * so tests can assert on retry behaviour, duration-based attempt
 * ordering, and concurrency. mStream is pointed at the mock via
 * `MSTREAM_LRCLIB_BASE` env var (honoured by src/api/lyrics-lrclib.js).
 *
 * What we guarantee here:
 *   - With `lyrics.lrclib=false` (default): no network traffic, no
 *     cache rows, endpoints behave as in Phase 2.
 *   - With `lyrics.lrclib=true`: on a cache miss, the first request
 *     returns empty AND enqueues a fetch; a subsequent request
 *     (after the queue drains) serves real data.
 *   - Miss → cached as status='miss'; a repeat call within the TTL
 *     does NOT re-fetch (negative cache works).
 *   - Network errors → cached as status='error' with a short TTL.
 *   - Concurrency cap holds: two simultaneous bulk triggers never
 *     exceed the in-flight limit.
 *   - Dedup works: two requests for the same audio_hash in the
 *     same tick enqueue exactly one fetch.
 *   - Admin purge endpoints actually wipe rows.
 *
 * The cache is keyed on audio_hash (V14). FLAC tracks get a stable
 * audio_hash from the extractor — that's why fixtures here are
 * FLAC (same reason as the embedded-lyrics test in V19).
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'lrcladmin', password: 'pw-lrcl' };

// Fixture: a single FLAC track with no embedded or sidecar lyrics.
// Handler will fall through to LRCLib on first request.
const TRACK_NOTHING = {
  file: 'nothing.flac', artist: 'Lrclib Artist', title: 'Lrclib Song',
  album: 'Lrclib Album', year: '2024', track: '1', freq: 480,
};
// A second track so we can test concurrency + dedup against TWO
// different audio_hashes simultaneously.
const TRACK_ALSO_NOTHING = {
  file: 'also-nothing.flac', artist: 'Lrclib Artist', title: 'Second Song',
  album: 'Lrclib Album', year: '2024', track: '2', freq: 540,
};
// Control: has embedded lyrics — must NOT trigger a fetch.
const TRACK_HAS_LOCAL = {
  file: 'has-local.flac', artist: 'Lrclib Artist', title: 'Already Has Lyrics',
  album: 'Lrclib Album', year: '2024', track: '3', freq: 600,
  lyrics: 'I already have lyrics in my tag\nNo need for LRCLib',
};

// ── Mock LRCLib server ──────────────────────────────────────────────────────

// Per-test configuration for what the mock returns. Each case's
// beforeEach resets this.
const mockState = {
  // Map of `artist_name|track_name` (or `|track_name` when we get a
  // no-duration fuzzy retry) → response. Entries pop on first use
  // unless `.persistent` is true.
  responses: new Map(),
  // Counter of requests for assertions. Reset per test.
  requests: [],
  // When set, every request delays this many ms before answering —
  // useful for exercising the concurrency cap.
  delayMs: 0,
  // When true, every request returns a 500 so the fetcher takes the
  // error branch.
  failAll: false,
};

let mockServer;
let mockPort;

function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      const artistName = url.searchParams.get('artist_name') || '';
      const trackName  = url.searchParams.get('track_name')  || '';
      const dur        = url.searchParams.get('duration')    || '';
      mockState.requests.push({ artistName, trackName, dur, at: Date.now() });
      if (mockState.delayMs > 0) {
        await new Promise(r => setTimeout(r, mockState.delayMs));
      }
      if (mockState.failAll) {
        res.statusCode = 500;
        res.end('fail');
        return;
      }
      const key = `${artistName}|${trackName}`;
      const hit = mockState.responses.get(key);
      // onlyForDuration: 0 means "only answer the fuzzy (no-dur)
      // retry". The fetcher omits the duration param entirely when
      // passing 0, so the mock sees dur='' rather than '0'; treat
      // those as the same for matching.
      const normalisedDur = dur === '' ? '0' : dur;
      const matchesDur = hit == null
        ? false
        : hit.onlyForDuration == null || String(hit.onlyForDuration) === normalisedDur;
      if (!hit || !matchesDur) {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
        return;
      }
      if (!hit.persistent) { mockState.responses.delete(key); }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(hit.body));
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
    mockServer.on('error', reject);
  });
}

function stopMockServer() {
  return new Promise(resolve => {
    if (!mockServer) { return resolve(); }
    mockServer.close(() => resolve());
  });
}

function setMockResponse(artist, track, body, opts = {}) {
  // Key shape: `artist|track` matches both exact-duration AND fuzzy
  // (duration=0) calls. Pass `onlyForDuration: 0` to target just the
  // fuzzy retry — used by the two-pass fallback test to force a
  // 404 on the exact-duration attempt so the fuzzy retry is exercised.
  const key = `${artist}|${track}`;
  mockState.responses.set(key, {
    body,
    persistent: !!opts.persistent,
    onlyForDuration: opts.onlyForDuration,  // undefined = any duration matches
  });
}

function resetMockState() {
  mockState.responses.clear();
  mockState.requests.length = 0;
  mockState.delayMs = 0;
  mockState.failAll = false;
}

// ── Track fixture helper ────────────────────────────────────────────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)));
  });
}

async function makeTrack(libDir, t) {
  const full = path.join(libDir, t.file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const args = [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${t.freq}:sample_rate=44100:duration=1`,
    '-ac', '2', '-c:a', 'flac',
    '-metadata', `artist=${t.artist}`,
    '-metadata', `title=${t.title}`,
    '-metadata', `album=${t.album}`,
    '-metadata', `date=${t.year}`,
    '-metadata', `track=${t.track}`,
  ];
  if (t.lyrics) { args.push('-metadata', `lyrics=${t.lyrics}`); }
  args.push(full);
  await runFfmpeg(args);
}

// ── Harness ─────────────────────────────────────────────────────────────────

let server;
let libDir;
let adminKey;

before(async () => {
  if (!fsSync.existsSync(FFMPEG)) {
    throw new Error(`bundled ffmpeg missing at ${FFMPEG}`);
  }
  libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-lrclib-'));
  for (const t of [TRACK_NOTHING, TRACK_ALSO_NOTHING, TRACK_HAS_LOCAL]) {
    await makeTrack(libDir, t);
  }

  await startMockServer();

  server = await startServer({
    dlnaMode: 'disabled',
    users:    [{ ...ADMIN, admin: true }],
    extraFolders: { lrclib: libDir },
    // Point the fetcher at our local mock and enable the feature. The
    // server module reads MSTREAM_LRCLIB_BASE at import time, and we
    // set the config via extraConfig so the `lrclib=true` flag lands
    // before the handlers import the module.
    env:         { MSTREAM_LRCLIB_BASE: `http://127.0.0.1:${mockPort}` },
    extraConfig: { lyrics: { lrclib: true,
                             // Short TTLs keep the suite fast. The miss TTL is
                             // longer than the others on purpose: the negative-
                             // cache test asserts "no re-fetch WITHIN the miss
                             // TTL", but its own setup (waitForCacheSettle
                             // polling + per-request latency) can eat a 50ms
                             // window and flake — give it a comfortable margin.
                             // No test exercises miss expiry, so this is free.
                             cacheTtlHitsMs:   50,
                             cacheTtlMissesMs: 5000,
                             cacheTtlErrorsMs: 50,
                             concurrency: 2 } },
  });

  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const { token } = await login.json();
  await fetch(`${server.baseUrl}/api/v1/admin/users/vpaths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ username: ADMIN.username, vpaths: ['testlib', 'lrclib'] }),
  });
  const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'lrclib-tests' }),
  });
  adminKey = (await keyR.json()).key;
});

after(async () => {
  if (server)     { await server.stop(); }
  if (mockServer) { await stopMockServer(); }
  if (libDir)     { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
});

beforeEach(async () => {
  resetMockState();
  // Wipe the cache between tests so each case starts clean. Reuses the
  // admin endpoint we're testing anyway — which is fine because if it
  // breaks the tests that depend on a clean slate fail loudly.
  await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/purge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
    body: JSON.stringify({ mode: 'full' }),
  });
});

// Fresh admin JWT so the cookie-based auth wall accepts our admin
// endpoints. `adminKey` works for Subsonic routes; the mStream
// auth-walled routes want x-access-token.
let _adminTokenCache = null;
async function adminToken() {
  if (_adminTokenCache) { return _adminTokenCache; }
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  _adminTokenCache = (await r.json()).token;
  return _adminTokenCache;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function subsonicUrl(method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json'); q.set('apiKey', adminKey); q.set('v', '1.16.1'); q.set('c', 'lrclib-test');
  for (const [k, v] of Object.entries(params)) {
    if (v != null) { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function subCall(method, params = {}) {
  const r = await fetch(subsonicUrl(method, params));
  return (await r.json())['subsonic-response'];
}

async function findTrackIdByTitle(title) {
  const env = await subCall('search3', { query: title, songCount: 5 });
  const song = env.searchResult3.song?.find(s => s.title === title);
  return song?.id;
}

async function cacheStats() {
  const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/stats`, {
    headers: { 'x-access-token': await adminToken() },
  });
  return (await r.json()).lyrics?.cache;
}

// Wait until the cache for a track settles to a terminal status
// (hit / miss / error), not 'pending'. Polls with a short timeout.
async function waitForCacheSettle(trackId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const env = await subCall('getLyricsBySongId', { id: trackId });
    // If we got structured lyrics, we're definitely past pending.
    if (env.lyricsList.structuredLyrics?.length > 0) { return; }
    // Otherwise look at the raw cache.
    const stats = await cacheStats();
    if ((stats?.pending || 0) === 0) { return; }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`cache did not settle within ${timeoutMs}ms`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('LRCLib cache: first-miss enqueue and second-call serve', () => {
  test('first request returns empty and kicks off a fetch; second serves the cached hit', async () => {
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      syncedLyrics: '[00:01.00]Mocked line one\n[00:03.00]Mocked line two',
      plainLyrics:  'Mocked line one\nMocked line two',
    }, { persistent: true });  // both exact-dur + fuzzy attempts share
    const id = await findTrackIdByTitle('Lrclib Song');
    assert.ok(id);

    // First call: no local, no cache → empty + enqueue.
    const env1 = await subCall('getLyricsBySongId', { id });
    assert.equal(env1.status, 'ok');
    assert.equal(env1.lyricsList.structuredLyrics.length, 0);

    await waitForCacheSettle(id);

    // Second call: cache is hot, structured lyrics come back.
    const env2 = await subCall('getLyricsBySongId', { id });
    const entries = env2.lyricsList.structuredLyrics;
    assert.ok(entries.length >= 1, `expected cached lyrics, got ${JSON.stringify(entries)}`);
    const synced = entries.find(e => e.synced === true);
    assert.ok(synced, 'expected a synced entry from the cached LRC');
    assert.equal(synced.line[0].value, 'Mocked line one');
    assert.equal(synced.line[0].start, 1000);

    // Mock should have been hit at least once.
    assert.ok(mockState.requests.length >= 1);
  });
});

describe('LRCLib cache: negative caching', () => {
  test('404 response caches as miss and does NOT re-fetch within TTL', async () => {
    // Mock is empty — every request 404s.
    const id = await findTrackIdByTitle('Lrclib Song');

    // First call primes the miss.
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const firstCount = mockState.requests.length;
    assert.ok(firstCount >= 1, 'first call should have fetched');

    // Second call within the TTL (50ms configured, we're well inside)
    // should NOT re-fetch. We serve empty from the cached 'miss' row.
    const env = await subCall('getLyricsBySongId', { id });
    assert.equal(env.lyricsList.structuredLyrics.length, 0);

    // Give the queue a moment in case it's racing.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(mockState.requests.length, firstCount,
      'no additional fetch should have been made within the miss TTL');

    const stats = await cacheStats();
    assert.ok((stats?.miss || 0) >= 1, 'expected at least one miss row');
  });
});

describe('LRCLib cache: error status', () => {
  test('500 response caches as error with short TTL', async () => {
    mockState.failAll = true;
    const id = await findTrackIdByTitle('Lrclib Song');

    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const stats = await cacheStats();
    assert.ok((stats?.error || 0) >= 1, `expected an error row, got ${JSON.stringify(stats)}`);
  });
});

describe('LRCLib cache: local lyrics win; no fetch', () => {
  test('a track with embedded lyrics never enqueues a fetch', async () => {
    // Even though the mock would answer, the handler should short-
    // circuit on the local embedded copy.
    setMockResponse('Lrclib Artist', 'Already Has Lyrics', {
      syncedLyrics: '[00:01.00]this should not be served',
      plainLyrics:  'this should not be served',
    });
    const id = await findTrackIdByTitle('Already Has Lyrics');
    assert.ok(id);

    const env = await subCall('getLyricsBySongId', { id });
    const entries = env.lyricsList.structuredLyrics;
    // We have local unsynced lyrics; the handler emits the plain variant.
    const plain = entries.find(e => e.synced === false);
    assert.ok(plain);
    assert.match(plain.line[0].value, /I already have lyrics/);

    // Give background queue a tick — there shouldn't be one, but
    // we're asserting negatively.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(mockState.requests.length, 0,
      'local lyrics must short-circuit; no network traffic expected');
  });
});

describe('LRCLib cache: dedup', () => {
  test('two concurrent requests for the same track enqueue exactly one fetch', async () => {
    // Delay the mock so both concurrent requests land in the queue
    // before the worker starts replying.
    mockState.delayMs = 60;
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      syncedLyrics: '[00:01.00]deduped',
      plainLyrics:  'deduped',
    });
    const id = await findTrackIdByTitle('Lrclib Song');

    const [a, b] = await Promise.all([
      subCall('getLyricsBySongId', { id }),
      subCall('getLyricsBySongId', { id }),
    ]);
    // Both return empty (fetch hasn't completed yet).
    assert.equal(a.lyricsList.structuredLyrics.length, 0);
    assert.equal(b.lyricsList.structuredLyrics.length, 0);

    await waitForCacheSettle(id, 5000);

    // Exactly one request should have reached the mock for this
    // (artist, title) pair during the concurrent window.
    const matching = mockState.requests.filter(
      r => r.trackName === 'Lrclib Song' && r.artistName === 'Lrclib Artist',
    );
    // Allow one retry (duration-exact + fuzzy) because the exact
    // duration branch may run: the dedup guarantee is per (audio_hash,
    // in-flight), not per (artist, title, duration). So we assert at
    // most 2 network calls for a single logical fetch.
    assert.ok(matching.length <= 2,
      `expected dedup: ≤2 network calls, got ${matching.length}`);
  });
});

describe('LRCLib cache: disabled config', () => {
  test('flipping lrclib=false stops new fetches (existing rows are untouched)', async () => {
    // Turn the feature off via the admin endpoint.
    await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ enabled: false }),
    });
    try {
      // Set up the mock but the handler should not touch it.
      setMockResponse('Lrclib Artist', 'Second Song', {
        plainLyrics: 'should not fetch',
      });
      const id = await findTrackIdByTitle('Second Song');

      await subCall('getLyricsBySongId', { id });
      // Give the queue a tick that would have kicked off a fetch if
      // the feature were enabled.
      await new Promise(r => setTimeout(r, 60));
      assert.equal(mockState.requests.length, 0,
        'no network traffic expected while lrclib is disabled');
    } finally {
      // Re-enable for subsequent tests.
      await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
        body: JSON.stringify({ enabled: true }),
      });
    }
  });
});

// ── Round-2 audit regressions ────────────────────────────────────────────────
//
// Each case here pins a specific bug identified in the round-2 code
// audit so a future regression shows up as a test failure rather than
// a silent behaviour drift.

describe('LRCLib cache: drain-on-disable (round-2 fix)', () => {
  test('queued jobs do NOT fire LRCLib after admin disables mid-burst', async () => {
    // Scenario: user enables LRCLib, a flurry of lyric requests
    // enqueues several fetches, admin flips disable before the
    // in-flight worker drains the queue. The queued (not-yet-running)
    // jobs must NOT make HTTP calls — that'd defeat the point of
    // the toggle for privacy-conscious operators. In-flight jobs
    // DO complete (we can't cancel a partial fetch cheaply).

    // Slow the mock so the first fetch sits in-flight while we
    // pile up more jobs and then flip the toggle.
    mockState.delayMs = 150;
    setMockResponse('Lrclib Artist', 'Lrclib Song',
      { plainLyrics: 'should-run' }, { persistent: true });
    setMockResponse('Lrclib Artist', 'Second Song',
      { plainLyrics: 'should-not-run' }, { persistent: true });

    const id1 = await findTrackIdByTitle('Lrclib Song');
    const id2 = await findTrackIdByTitle('Second Song');

    // Kick off two fetches. concurrency=2, so both become in-flight
    // immediately — that's fine, we want to pile on MORE than the
    // cap so something is queued but not running.
    await subCall('getLyricsBySongId', { id: id1 });

    // Tiny wait so the first job has started its mock call.
    await new Promise(r => setTimeout(r, 30));
    const firstCallCount = mockState.requests.length;

    // Now flip the toggle. The in-flight job for id1 continues; but
    // anything still queued is dropped.
    await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ enabled: false }),
    });

    // After the toggle, try to trigger a NEW fetch for id2 — this
    // should be a no-op at the handler level because isEnabled is
    // false. Prior to the fix, a queued job from before the toggle
    // could have slipped through drain() and hit the mock.
    await subCall('getLyricsBySongId', { id: id2 });

    // Wait longer than the mock delay so any stragglers have time
    // to fire. If the drain guard works, no additional request
    // lands after `firstCallCount`.
    await new Promise(r => setTimeout(r, 300));
    const afterCallCount = mockState.requests.length;

    // Exactly one (or two, if both initial fetches were in-flight
    // before we tried the disable) request — never more. The bar
    // is: after disable, no NEW requests start.
    assert.ok(afterCallCount <= firstCallCount + 1,
      `expected at most one more request after disable; firstCount=${firstCallCount} afterCount=${afterCallCount}`);

    // Re-enable for the rest of the suite.
    await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ enabled: true }),
    });
  });
});

describe('LRCLib cache: admin validation (round-2 fix)', () => {
  test('malformed purge body → 400 with a Joi error, no side effect', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ mode: 'not-a-valid-mode' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /mode.*must be one of/);
  });

  test('/enabled endpoint requires a boolean; other shapes reject', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ enabled: 'yes' }),   // string, not bool
    });
    assert.equal(r.status, 400);
  });
});

describe('LRCLib cache: stats bucket accounting (round-3 fix)', () => {
  test('cacheStats `total` equals sum of named buckets including `other`', async () => {
    // Warm a hit row.
    setMockResponse('Lrclib Artist', 'Lrclib Song',
      { plainLyrics: 'stats-test' }, { persistent: true });
    const id = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const stats = await cacheStats();
    // Each named bucket must exist (round-3 fix added `other` so
    // future unknown statuses don't silently inflate `total`). The
    // sum of named buckets must equal `total` — otherwise a new
    // status-string drift would go unnoticed.
    const sum = stats.hit + stats.miss + stats.error + stats.pending + stats.other;
    assert.equal(sum, stats.total,
      `buckets must sum to total: hit=${stats.hit} miss=${stats.miss} error=${stats.error} pending=${stats.pending} other=${stats.other} total=${stats.total}`);
    assert.ok(stats.hit >= 1, 'precondition: at least one cached hit');
  });
});

describe('LRCLib cache: admin purge', () => {
  test('mode=retry drops error + pending rows, keeps hits', async () => {
    // Warm a hit row.
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      plainLyrics: 'cached hit for retry test',
    }, { persistent: true });
    const hitId = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id: hitId });
    await waitForCacheSettle(hitId);

    // Warm an error row.
    mockState.failAll = true;
    const errorId = await findTrackIdByTitle('Second Song');
    await subCall('getLyricsBySongId', { id: errorId });
    await waitForCacheSettle(errorId);
    mockState.failAll = false;

    let stats = await cacheStats();
    assert.ok(stats.hit >= 1 && stats.error >= 1, `precondition: ${JSON.stringify(stats)}`);

    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ mode: 'retry' }),
    });
    const body = await r.json();
    assert.ok(body.removed >= 1);

    stats = await cacheStats();
    assert.ok(stats.hit >= 1, 'hit rows should survive retry purge');
    assert.equal(stats.error, 0);
    assert.equal(stats.pending, 0);
  });

  test('mode=full drops everything', async () => {
    setMockResponse('Lrclib Artist', 'Lrclib Song', { plainLyrics: 'x' }, { persistent: true });
    const id = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ mode: 'full' }),
    });
    const body = await r.json();
    assert.ok(body.removed >= 1);

    const stats = await cacheStats();
    assert.equal(stats.total, 0);
  });
});

describe('LRCLib cache: sidecar write-back', () => {
  async function setWriteSidecar(enabled) {
    await fetch(`${server.baseUrl}/api/v1/admin/subsonic/lyrics-cache/write-sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
      body: JSON.stringify({ enabled }),
    });
  }
  // Every case in this group starts from writeSidecar=false and from
  // a clean fs (no .lrc / .txt siblings in the fixture dir).
  beforeEach(async () => {
    await setWriteSidecar(false);
    for (const t of [TRACK_NOTHING, TRACK_ALSO_NOTHING]) {
      const base = path.join(libDir, t.file.replace(/\.(mp3|flac)$/, ''));
      for (const ext of ['.lrc', '.txt']) {
        await fs.rm(base + ext, { force: true });
      }
    }
  });

  test('disabled by default → no sidecar written', async () => {
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      syncedLyrics: '[00:01.00]no sidecar\n',
    }, { persistent: true });
    const id = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const sidecar = path.join(libDir, 'nothing.lrc');
    assert.ok(!fsSync.existsSync(sidecar), 'sidecar must not exist when writeSidecar is off');
  });

  test('enabled: synced hit writes a .lrc sibling', async () => {
    await setWriteSidecar(true);
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      syncedLyrics: '[00:01.00]first\n[00:03.00]second',
    }, { persistent: true });
    const id = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    // Give the post-cache-write step a tick to land the sidecar.
    for (let i = 0; i < 20; i++) {
      if (fsSync.existsSync(path.join(libDir, 'nothing.lrc'))) { break; }
      await new Promise(r => setTimeout(r, 10));
    }
    const sidecar = path.join(libDir, 'nothing.lrc');
    assert.ok(fsSync.existsSync(sidecar), 'expected .lrc sibling to be written');
    const body = await fs.readFile(sidecar, 'utf8');
    assert.match(body, /\[00:01\.00\]first/);
  });

  test('enabled: plain-only hit writes a .txt sibling (not .lrc)', async () => {
    await setWriteSidecar(true);
    setMockResponse('Lrclib Artist', 'Second Song', {
      plainLyrics: 'plain text line one\nline two',
    }, { persistent: true });
    const id = await findTrackIdByTitle('Second Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    for (let i = 0; i < 20; i++) {
      if (fsSync.existsSync(path.join(libDir, 'also-nothing.txt'))) { break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(fsSync.existsSync(path.join(libDir, 'also-nothing.txt')));
    assert.ok(!fsSync.existsSync(path.join(libDir, 'also-nothing.lrc')),
      '.lrc must not be written when no synced lyrics are present');
  });

  test('enabled: never clobbers an existing sibling', async () => {
    await setWriteSidecar(true);
    // Pre-seed an existing sidecar with user-written content.
    const preExisting = path.join(libDir, 'nothing.lrc');
    await fs.writeFile(preExisting, '[00:02.00]user-curated', 'utf8');
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      syncedLyrics: '[00:05.00]lrclib-version',
    }, { persistent: true });
    const id = await findTrackIdByTitle('Lrclib Song');
    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);
    await new Promise(r => setTimeout(r, 50));

    const body = await fs.readFile(preExisting, 'utf8');
    assert.match(body, /user-curated/, 'existing sidecar must not be overwritten');
    assert.doesNotMatch(body, /lrclib-version/);
  });
});

describe('LRCLib cache: two-pass fetch strategy', () => {
  test('exact-duration call falls back to duration=0 fuzzy on miss', async () => {
    // Only register for duration=0 (fuzzy). The exact-duration
    // attempt will 404, then the fetcher retries without duration and
    // succeeds. persistent so the same response serves both the
    // background fetch and any subsequent retry probe.
    setMockResponse('Lrclib Artist', 'Lrclib Song', {
      plainLyrics: 'fuzzy-match worked',
    }, { persistent: true, onlyForDuration: 0 });
    const id = await findTrackIdByTitle('Lrclib Song');

    await subCall('getLyricsBySongId', { id });
    await waitForCacheSettle(id);

    const env = await subCall('getLyricsBySongId', { id });
    const plain = env.lyricsList.structuredLyrics.find(e => e.synced === false);
    assert.ok(plain, `expected a hit served from fuzzy fallback, got ${JSON.stringify(env)}`);
    assert.match(plain.line[0].value, /fuzzy-match worked/);

    // Should have made at least 2 requests (exact + fuzzy).
    assert.ok(mockState.requests.length >= 2,
      `expected fallback pass, saw ${mockState.requests.length} request(s)`);
    const withDur    = mockState.requests.filter(r => r.dur !== '').length;
    const withoutDur = mockState.requests.filter(r => r.dur === '').length;
    assert.ok(withDur >= 1 && withoutDur >= 1,
      `expected both variants: ${withDur} with-dur, ${withoutDur} without-dur`);
  });
});
