/**
 * Integration tests for the configurable response-compression + DB page-cache
 * admin controls (PR #620, "fully configurable" pass).
 *
 *   GET  /api/v1/admin/config                  exposes `compression` + `dbCacheSizeMb`
 *   POST /api/v1/admin/config/compression      { mode: none | gzip | brotli }
 *   POST /api/v1/admin/config/db-cache-size    { cacheSizeMb: 1..2048 }
 *
 * The compression mode is read live by src/util/compression.js on every
 * request, so flipping it via the admin API takes effect on the next response
 * with no reboot. We assert against a large static asset (webapp/alpha/m.js,
 * ~190 KB, application/javascript → compressible, well over the 256-byte floor).
 *
 * NOTE: Node's global fetch (undici) transparently decompresses responses and
 * STRIPS the Content-Encoding header, so it cannot observe the wire encoding.
 * These tests use raw http.request to read Content-Encoding and to verify the
 * bytes actually decode with the matching zlib codec. fetch() is fine for the
 * (tiny, uncompressed) admin JSON calls.
 *
 * Pattern mirrors test/admin-scan-params.test.mjs for the boot + admin-auth.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
// Large, compressible, public static file served by the default UI (webapp/).
const ASSET = '/alpha/m.js';

let server;
let adminJwt;

// Raw GET so we can see Content-Encoding (undici hides it) and the real bytes.
function rawGet(path, headers = {}) {
  const u = new URL(server.baseUrl + path);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function adminPost(path, body) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': adminJwt },
    body: JSON.stringify(body),
  });
}
async function setCompression(mode) { return (await adminPost('/api/v1/admin/config/compression', { mode })).status; }
async function getConfig() {
  const r = await fetch(`${server.baseUrl}/api/v1/admin/config`, { headers: { 'x-access-token': adminJwt } });
  return r.json();
}

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled', subsonicMode: 'disabled', waitForScan: false,
    users: [{ ...ADMIN, admin: true }],
  });
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminJwt = (await r.json()).token;
  assert.ok(adminJwt, 'admin login should return a token');
});

after(async () => { if (server) { await server.stop(); } });

describe('compression config — defaults (none)', () => {
  test('GET /config reports compression=none and dbCacheSizeMb=64 by default', async () => {
    const cfg = await getConfig();
    assert.equal(cfg.compression, 'none');
    assert.equal(cfg.dbCacheSizeMb, 64);
  });

  test('none: a compressible asset is served identity even when br/gzip are offered', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200, `asset ${ASSET} should be served (200)`);
    assert.ok(r.body.length > 256, `asset should exceed the 256-byte floor (got ${r.body.length})`);
    assert.equal(r.headers['content-encoding'], undefined);
  });
});

describe('compression config — gzip mode', () => {
  before(async () => { assert.equal(await setCompression('gzip'), 200); });

  test('gzip-capable client gets gzip and the body decodes', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(Number(r.headers['content-length']), r.body.length, 'Content-Length matches compressed bytes');
    assert.match(zlib.gunzipSync(r.body).toString('utf8'), /function|const|var/);
  });

  test('gzip mode never serves brotli — a br-only client gets identity', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'br' });
    assert.equal(r.headers['content-encoding'], undefined);
  });
});

describe('compression config — brotli mode', () => {
  before(async () => { assert.equal(await setCompression('brotli'), 200); });

  test('br-capable client gets brotli and the body decodes', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.match(zlib.brotliDecompressSync(r.body).toString('utf8'), /function|const|var/);
  });

  test('brotli mode falls back to gzip for gzip-only clients', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip');
  });

  test('Vary: Accept-Encoding is set when compressing', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'br' });
    assert.match(String(r.headers['vary'] || ''), /accept-encoding/i);
  });
});

describe('compression config — back to none (live, no reboot)', () => {
  before(async () => { assert.equal(await setCompression('none'), 200); });

  test('switching back to none disables compression again', async () => {
    const r = await rawGet(ASSET, { 'accept-encoding': 'br, gzip' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal((await getConfig()).compression, 'none');
  });
});

describe('compression config — validation', () => {
  test('rejects an unknown mode and leaves the setting unchanged', async () => {
    const r = await adminPost('/api/v1/admin/config/compression', { mode: 'lz4' });
    assert.ok(r.status >= 400, `expected 4xx for an invalid mode, got ${r.status}`);
    assert.equal((await getConfig()).compression, 'none');
  });
});

describe('db cache-size config', () => {
  test('accepts a valid size and reflects it in GET /config', async () => {
    const r = await adminPost('/api/v1/admin/config/db-cache-size', { cacheSizeMb: 128 });
    assert.equal(r.status, 200);
    assert.equal((await getConfig()).dbCacheSizeMb, 128);
  });

  test('rejects out-of-range sizes (0 and >2048); last good value stands', async () => {
    for (const bad of [0, 5000]) {
      const r = await adminPost('/api/v1/admin/config/db-cache-size', { cacheSizeMb: bad });
      assert.ok(r.status >= 400, `cacheSizeMb=${bad} should be rejected, got ${r.status}`);
    }
    assert.equal((await getConfig()).dbCacheSizeMb, 128);
  });
});
