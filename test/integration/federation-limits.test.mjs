/**
 * Federation bandwidth limits end-to-end over plain HTTP (no iroh — the key
 * is the credential, same trick as federation-e2e):
 *
 *  - minting without limit fields applies the config defaults
 *    (federation.limits: 8000 kbps / 2048 MB / 3 streams); explicit fields
 *    (including 0 = unlimited) stick, and the key list exposes them plus a
 *    live usage_today_bytes;
 *  - POST /keys/:id/limits edits live, 404s unknown ids, 400s garbage;
 *  - an unlimited key streams byte-identical content, its usage is counted,
 *    and the accumulator flushes to federation_key_usage on disk
 *    (MSTREAM_TEST_FED_FLUSH_MS shrinks the interval);
 *  - a daily quota 429s the byte-heavy routes with Retry-After while
 *    health/browse keep answering;
 *  - maxStreams 429s a second concurrent stream, and the slot frees on
 *    completion;
 *  - streamKbps paces a download without corrupting it (timing asserted
 *    with WIDE margins — CI runners and Windows clocks are noisy).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { parseFederationTicket } from '../../src/state/federation.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fedHeaders = (key) => ({ 'x-federation-key': key, 'Content-Type': 'application/json' });

const KiB = 1024;
const FILE_QUOTA = crypto.randomBytes(256 * KiB);   // 4 pulls = exactly 1 MiB
const FILE_THROTTLE = crypto.randomBytes(300 * KiB);
const FILE_CONC = crypto.randomBytes(200 * KiB);

describe('federation bandwidth limits e2e', () => {
  let srv, libDir, adminToken;
  const keys = {}; // name -> mint response json

  async function mintKey(name, extra = {}) {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ name, vpaths: ['shared'], ...extra }),
    });
    const text = await r.text();
    assert.equal(r.status, 200, `mint '${name}' failed: ${text}`);
    return JSON.parse(text);
  }

  async function listKeys() {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      headers: { 'x-access-token': adminToken },
    });
    assert.equal(r.status, 200);
    return r.json();
  }

  before(async () => {
    libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fedlimits-'));
    await fs.writeFile(path.join(libDir, 'q.bin'), FILE_QUOTA);
    await fs.writeFile(path.join(libDir, 't.bin'), FILE_THROTTLE);
    await fs.writeFile(path.join(libDir, 'c.bin'), FILE_CONC);

    srv = await startServer({
      extraFolders: { shared: libDir },
      extraConfig: { federation: { enabled: true } },
      users: [{ username: 'boss', password: 'pw', admin: true, vpaths: ['testlib', 'shared'] }],
      waitForScan: false,
      env: { MSTREAM_TEST_FED_FLUSH_MS: '200' },
    });

    const login = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'pw' }),
    });
    adminToken = (await login.json()).token;

    keys.defaults = await mintKey('defaults');
    keys.open = await mintKey('open', { streamKbps: 0, dailyMb: 0, maxStreams: 0 });
    keys.edit = await mintKey('edit', { streamKbps: 0, dailyMb: 0, maxStreams: 0 });
    keys.quota = await mintKey('quota', { streamKbps: 0, dailyMb: 1, maxStreams: 0 });
    // 800 kbps = 100 KiB/s wire budget with a 1s burst bucket, so the
    // 200 KiB file below holds its stream open for ~1s — long enough for
    // the concurrency probe, short enough for CI.
    keys.throttle = await mintKey('throttle', { streamKbps: 800, dailyMb: 0, maxStreams: 0 });
    keys.conc = await mintKey('conc', { streamKbps: 800, dailyMb: 0, maxStreams: 1 });
  });

  after(async () => {
    await srv?.stop();
    if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('minting without limit fields applies the config defaults', async () => {
    assert.equal(keys.defaults.streamKbps, 8000);
    assert.equal(keys.defaults.dailyMb, 2048);
    assert.equal(keys.defaults.maxStreams, 3);

    const rows = await listKeys();
    const row = rows.find((k) => k.id === keys.defaults.id);
    assert.equal(row.stream_kbps, 8000);
    assert.equal(row.daily_mb, 2048);
    assert.equal(row.max_streams, 3);
    assert.equal(typeof row.usage_today_bytes, 'number');

    const zero = rows.find((k) => k.id === keys.open.id);
    assert.deepEqual(
      { kbps: zero.stream_kbps, mb: zero.daily_mb, streams: zero.max_streams },
      { kbps: 0, mb: 0, streams: 0 });
  });

  test('limits edit route updates live, 404s unknown ids, 400s garbage', async () => {
    const ok = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/${keys.edit.id}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ streamKbps: 1234, dailyMb: 5, maxStreams: 2 }),
    });
    assert.equal(ok.status, 200);
    const row = (await listKeys()).find((k) => k.id === keys.edit.id);
    assert.deepEqual(
      { kbps: row.stream_kbps, mb: row.daily_mb, streams: row.max_streams },
      { kbps: 1234, mb: 5, streams: 2 });

    const missing = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/999999/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ streamKbps: 0, dailyMb: 0, maxStreams: 0 }),
    });
    assert.equal(missing.status, 404);

    const garbage = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/${keys.edit.id}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ streamKbps: -5, dailyMb: 0, maxStreams: 0 }),
    });
    assert.equal(garbage.status, 400);
  });

  test('unlimited key streams intact, usage is counted live and flushed to disk', async () => {
    const r = await fetch(`${srv.baseUrl}/media/shared/q.bin`, { headers: fedHeaders(keys.open.key) });
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.length, FILE_QUOTA.length);
    assert.ok(body.equals(FILE_QUOTA), 'unthrottled body should be byte-identical');

    // Live figure (includes the not-yet-flushed accumulator).
    const row = (await listKeys()).find((k) => k.id === keys.open.id);
    assert.ok(row.usage_today_bytes >= FILE_QUOTA.length,
      `usage_today_bytes ${row.usage_today_bytes} should cover the ${FILE_QUOTA.length}B download`);

    // Flush proof: the accumulator lands in federation_key_usage on disk
    // (200ms interval via MSTREAM_TEST_FED_FLUSH_MS). WAL allows a
    // read-only peek from this process while the server holds the DB.
    let flushed = 0;
    for (let i = 0; i < 40 && flushed < FILE_QUOTA.length; i++) {
      await sleep(250);
      try {
        const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
        try {
          const u = db.prepare('SELECT bytes FROM federation_key_usage WHERE key_id = ?').get(keys.open.id);
          flushed = u ? Number(u.bytes) : 0;
        } finally { db.close(); }
      } catch { /* transient lock — retry */ }
    }
    assert.ok(flushed >= FILE_QUOTA.length,
      `flushed bytes ${flushed} should cover the ${FILE_QUOTA.length}B download`);
  });

  test('daily quota 429s media with Retry-After while browse keeps answering', async () => {
    // dailyMb=1: four 256 KiB pulls land exactly on the 1 MiB quota; the
    // fifth heavy request must be refused before a byte is served.
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${srv.baseUrl}/media/shared/q.bin`, { headers: fedHeaders(keys.quota.key) });
      assert.equal(r.status, 200, `pull ${i + 1} of 4 should still be inside the quota`);
      await r.arrayBuffer();
    }

    const blocked = await fetch(`${srv.baseUrl}/media/shared/q.bin`, { headers: fedHeaders(keys.quota.key) });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /quota/i);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 24 * 3600,
      `Retry-After should count down to UTC midnight, got '${blocked.headers.get('retry-after')}'`);

    // The light surface stays up so the peer can see WHY playback stopped.
    const health = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(keys.quota.key) });
    assert.equal(health.status, 200);

    const stillBlocked = await fetch(`${srv.baseUrl}/media/shared/q.bin`, { headers: fedHeaders(keys.quota.key) });
    assert.equal(stillBlocked.status, 429);
  });

  test('maxStreams caps concurrent media responses and frees on completion', async () => {
    // Stream A: 200 KiB at 800 kbps ≈ 1s on the wire (burst covers the
    // first ~100 KiB). Fire B while A is mid-body.
    const aPromise = fetch(`${srv.baseUrl}/media/shared/c.bin`, { headers: fedHeaders(keys.conc.key) });
    const a = await aPromise; // headers arrive once the slot is taken
    assert.equal(a.status, 200);

    await sleep(150);
    const b = await fetch(`${srv.baseUrl}/media/shared/c.bin`, { headers: fedHeaders(keys.conc.key) });
    assert.equal(b.status, 429);
    assert.match((await b.json()).error, /concurrent/i);

    const aBody = Buffer.from(await a.arrayBuffer());
    assert.ok(aBody.equals(FILE_CONC), 'the throttled first stream should still be byte-identical');

    // Slot freed — the next stream is welcome. The server decrements on
    // res 'close', which can land a beat after the client sees the last
    // byte, so poll briefly instead of asserting the first attempt.
    let cStatus = 0;
    for (let i = 0; i < 20 && cStatus !== 200; i++) {
      await sleep(100);
      const c = await fetch(`${srv.baseUrl}/media/shared/c.bin`, { headers: fedHeaders(keys.conc.key) });
      cStatus = c.status;
      if (cStatus === 200) { await c.arrayBuffer(); }
    }
    assert.equal(cStatus, 200);
  });

  test('expiry: rejected in the past, enforced wall-wide, renewable, clearable', async () => {
    // A past date never mints.
    const past = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ name: 'past', vpaths: ['shared'], expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    assert.equal(past.status, 400);

    // Mint a key that dies in ~2s (skew between this process and the
    // spawned server is millisecond-scale; the margins here are seconds).
    const iso = new Date(Date.now() + 2000).toISOString();
    const k = await mintKey('shortlived', { streamKbps: 0, dailyMb: 0, maxStreams: 0, expiresAt: iso });
    // Stored form drops sub-seconds; response and ticket both carry it.
    const expectIso = `${iso.slice(0, 19)}Z`;
    assert.equal(k.expiresAt, expectIso);
    assert.equal(parseFederationTicket(k.ticket).expiresAt, expectIso);

    // Alive before the cutoff…
    const alive = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(k.key) });
    assert.equal(alive.status, 200);

    // …dead everywhere after it: the light surface too, not just media.
    await sleep(4000);
    const deadHealth = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(k.key) });
    assert.equal(deadHealth.status, 401);
    const deadMedia = await fetch(`${srv.baseUrl}/media/shared/q.bin`, { headers: fedHeaders(k.key) });
    assert.equal(deadMedia.status, 401);
    const row = (await listKeys()).find((r) => r.id === k.id);
    assert.equal(row.expired, 1);

    // Renewal: a new future date through the limits route re-arms the key.
    const renew = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/${k.id}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ streamKbps: 0, dailyMb: 0, maxStreams: 0, expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    assert.equal(renew.status, 200);
    const renewed = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(k.key) });
    assert.equal(renewed.status, 200);

    // Clearing to null = never; omitting the field leaves expiry alone.
    const clear = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/${k.id}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ streamKbps: 0, dailyMb: 0, maxStreams: 0, expiresAt: null }),
    });
    assert.equal(clear.status, 200);
    const cleared = (await listKeys()).find((r) => r.id === k.id);
    assert.equal(cleared.expires_at, null);
    assert.equal(cleared.expired, 0);
  });

  test('streamKbps paces the download without corrupting it', async () => {
    // 300 KiB at 800 kbps (100 KiB/s): ~1s of burst + ~2s paced ⇒ expect
    // roughly 2s. Assert only a 1s floor — wide margins on purpose
    // (loaded CI runners stretch time; they never compress it).
    const started = Date.now();
    const r = await fetch(`${srv.baseUrl}/media/shared/t.bin`, { headers: fedHeaders(keys.throttle.key) });
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    const elapsed = Date.now() - started;

    assert.ok(body.equals(FILE_THROTTLE), 'throttled body should be byte-identical');
    assert.ok(elapsed >= 1000,
      `300 KiB at 100 KiB/s should take well over 1s, finished in ${elapsed}ms`);
  });
});
