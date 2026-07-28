#!/usr/bin/env node
// All-Docker smoke runner.
//
// Brings up the mStream container (via compose.smoke.yaml) against
// the already-running daemon containers, primes a JWT-backed config,
// then exercises the smart-torrent flow end-to-end:
//
//   1. mStream container is reachable on 127.0.0.1:8915
//   2. Activate Deluge (Docker container on host:8112, reached via
//      host.docker.internal) — proves cross-container RPC works
//   3. /api/v1/torrent/seed-existing on testlib's valid-single
//      fixture → expect `seeded` outcome. Files live on a shared
//      host volume; daemon sees them at /downloads/testlib, mStream
//      sees them at /music/testlib. Verifies the mapping does the
//      right thing when BOTH sides are POSIX containers.
//   4. Same flow against Docker qBittorrent (host:8085).
//
// Pre-reqs:
//   * `docker compose -f test/smoke/docker/compose.smoke.yaml up
//      --build -d` has run and the healthcheck is passing.
//   * mstream-deluge + mstream-qbittorrent containers are running.
//   * Library fixtures already populated at
//     C:\tmp\transmission-downloads\testlib (shared with mStream
//     via the compose volume).
//
// Writes the generated config to ./run/config/config.json so the
// container can pick it up on boot. Idempotent: existing config is
// overwritten each run.

import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────
const SECRET = process.env.MSTREAM_SECRET || 'docker-smoke-secret-not-for-production';
const BASE   = 'http://127.0.0.1:8915';
// host.docker.internal resolves to the host gateway from inside the
// mStream container — that's how it reaches daemon ports published
// on the host's loopback.
const HOST_FROM_CONTAINER = 'host.docker.internal';

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// ─── Render the container's config + library ───────────────────────
async function writeConfig() {
  const configDir = path.join(__dirname, 'run', 'config');
  await fs.mkdir(configDir, { recursive: true });
  // mStream wants the storage dirs to exist before boot so it
  // doesn't log warnings.
  for (const sub of ['db', 'image-cache', 'logs', 'sync']) {
    await fs.mkdir(path.join(configDir, sub), { recursive: true });
  }
  const config = {
    port:    3000,
    address: '0.0.0.0',
    secret:  SECRET,
    // Single library mounted at /music/testlib inside the container,
    // backed by the same Windows-host source dir the daemon
    // containers see as /downloads/testlib.
    folders: {
      testlib: { root: '/music/testlib' },
    },
    storage: {
      dbDirectory:         '/config/db',
      albumArtDirectory:   '/config/image-cache',
      logsDirectory:       '/config/logs',
    },
    dlna:   { mode: 'disabled' },
    discogs:{ enabled: false },
    lyrics: { lrclib: false },
    // The smoke exercises path-handling/RPC, not art download — and its
    // generated library is art-less, so the post-scan downloader would
    // otherwise query REAL external services from the container.
    scanOptions: { autoAlbumArt: false },
  };
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
  console.log(`  wrote ${path.join(configDir, 'config.json')}`);
}

// ─── HTTP helpers ──────────────────────────────────────────────────
const TOK = jwt.sign({ username: 'admin' }, SECRET);

async function api(method, p, body) {
  const headers = { 'x-access-token': TOK };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${p}`, { method, headers, body });
  let json = null;
  try { json = await r.json(); } catch { /* */ }
  return { status: r.status, body: json };
}

async function uploadTorrent(p, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Uint8Array || v instanceof Buffer) {
      fd.append(k, new Blob([v]), 'fixture.torrent');
    } else if (v != null) {
      fd.append(k, v);
    }
  }
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'x-access-token': TOK },
    body: fd,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function ensureAdminUser() {
  // If the JWT already works against an admin endpoint, the user
  // is set up from a prior run — skip the PUT. The PUT route
  // throws a 500 when the username collides instead of returning
  // a clean idempotent OK, so we have to gate on existence first.
  const check = await api('GET', '/api/v1/admin/users');
  if (check.status === 200) { return true; }
  // First boot: create the admin. PUT /admin/users only accepts
  // the core user fields (the Joi schema rejects allow_torrent —
  // that's a separate per-user flag toggled via POST
  // /admin/users/access). For this smoke we set enabledFor=all
  // later, which makes allow_torrent irrelevant.
  const r = await api('PUT', '/api/v1/admin/users', {
    username: 'admin',
    password: 'docker-smoke',
    admin:    true,
    vpaths:   ['testlib'],
  });
  return r.status === 200;
}

// ─── Fixture builder ───────────────────────────────────────────────
// Single-file torrent matching C:/tmp/transmission-downloads/testlib/
// tier3-test.flac. Reuses the deterministic SHA-1 piece hash from the
// earlier release smoke (same on-disk byte content).
const VALID_SINGLE_B64 = 'ZDQ6aW5mb2Q2Omxlbmd0aGkxMDAwZTQ6bmFtZTE1OnRpZXIzLXRlc3QuZmxhYzEyOnBpZWNlIGxlbmd0aGkxNjM4NGU2OnBpZWNlczIwOtZ9wRBl5vsplzT+2OlPBDn+D0zXZWU=';
const VALID_SINGLE = Buffer.from(VALID_SINGLE_B64, 'base64');

// ─── Per-client matrix ─────────────────────────────────────────────
async function clearDaemon() {
  // Loop until empty — qBit's async indexing means a DELETE returns
  // before the torrent disappears from /list. Cap at ~5s.
  for (let i = 0; i < 25; i++) {
    const l = await api('GET', '/api/v1/admin/torrent/list');
    const torrents = l.body?.torrents || [];
    if (torrents.length === 0) { return; }
    for (const t of torrents) {
      await api('DELETE', '/api/v1/admin/torrent/' + t.infoHash);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function configureClient(client, opts) {
  const test = await api('POST', `/api/v1/admin/torrent/${client}/test`, opts);
  if (!test.body?.ok) {
    record(`${client} · test connection`, false,
      `status=${test.status} error=${test.body?.error}`);
    return false;
  }
  record(`${client} · test connection`, true, `version=${test.body.version}`);
  const conn = await api('POST', `/api/v1/admin/torrent/${client}/connect`, opts);
  if (!conn.body?.ok) {
    record(`${client} · connect (save creds)`, false, `error=${conn.body?.error}`);
    return false;
  }
  record(`${client} · connect (save creds)`, true);
  await api('POST', '/api/v1/admin/torrent/client', { client });
  return true;
}

async function runForClient(label, client, creds) {
  console.log(`\n=== ${label} ===`);
  if (!await configureClient(client, creds)) { return; }
  await clearDaemon();
  await new Promise(r => setTimeout(r, 800));

  // Auto-detect for testlib. With mStream in a container seeing
  // /music/testlib and the daemon container seeing /downloads/testlib
  // for the SAME host directory, the daemon-known-paths generator
  // produces /downloads/testlib as a candidate; the verifier checks
  // it against the daemon's known-paths.
  const ad = await api('POST', '/api/v1/admin/torrent/vpath-access/auto-detect',
    { vpathName: 'testlib' });
  const access = ad.body?.vpaths?.testlib;
  record(`${client} · auto-detect produces a daemonPath`,
    !!access?.daemonPath, `daemonPath=${access?.daemonPath} confidence=${access?.confidence}`);
  record(`${client} · daemonPath is canonical POSIX (no separators to normalise)`,
    access?.daemonPath?.startsWith('/') && !access?.daemonPath?.includes('\\'),
    `daemonPath=${access?.daemonPath}`);

  // seed-existing: tier3-test.flac (1000 bytes) exists on the
  // shared host volume at C:/tmp/transmission-downloads/testlib/
  // (mounted into mStream as /music/testlib and into the daemon
  // as /downloads/testlib). Files match → seeded.
  const seedRes = await uploadTorrent('/api/v1/torrent/seed-existing', {
    torrentFile: VALID_SINGLE,
  });
  record(`${client} · seed-existing → seeded (cross-container shared volume)`,
    seedRes.body?.outcome === 'seeded',
    `outcome=${seedRes.body?.outcome} name=${seedRes.body?.name}`);

  // The daemon should now have a torrent registered. List + verify.
  await new Promise(r => setTimeout(r, 1500));
  const list = await api('GET', '/api/v1/admin/torrent/list');
  const added = (list.body?.torrents || [])
    .find(t => t.infoHash === seedRes.body?.infoHash);
  record(`${client} · daemon registered the torrent`,
    !!added, `count=${list.body?.torrents?.length || 0}`);

  await clearDaemon();
}

// ─── Main ──────────────────────────────────────────────────────────
async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Any HTTP response means the server is listening — even a
      // 500 ("Authentication Error" on /api/ when an admin user
      // exists) tells us mStream is up and serving. We're checking
      // liveness, not auth here.
      const r = await fetch(`${BASE}/api/`);
      if (r.status >= 100 && r.status < 600) { return; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`mStream container did not respond at ${BASE} within ${timeoutMs}ms`);
}

console.log('All-Docker smoke: mStream container + dockerised daemons');
console.log(`mStream:  ${BASE}`);
console.log(`Daemons via host gateway: ${HOST_FROM_CONTAINER}:{8085,8112,9091}`);

await writeConfig();

// Wait for the mStream container (started externally via compose up)
// to start responding. The compose healthcheck handles the same
// signal, but if the caller skipped compose we still wait politely.
console.log('\nWaiting for mStream container to be ready…');
await waitForServer();
console.log('  ready.');

// First-boot: create admin so the smoke's JWT is accepted.
if (!await ensureAdminUser()) {
  console.error('Could not create admin user — aborting.');
  process.exit(2);
}

// Disable the whitelist gate (we didn't set allow_torrent on the
// admin user because the schema rejects it; flipping to 'all' makes
// every user pass the whitelist check uniformly).
await api('POST', '/api/v1/admin/torrent/enabled-for', { enabledFor: 'all' });

await runForClient('DELUGE (Docker)', 'deluge', {
  host: HOST_FROM_CONTAINER, port: 8112, password: 'deluge', useHttps: false,
});

// qBit Docker container is on host:8085. The linuxserver/qbittorrent
// image generates a random admin password on first boot (printed
// once to the container logs and then lost). Pass it explicitly:
//   QBIT_DOCKER_PASS=<password> node test/smoke/docker/run-...
// Skipped (not failed) when no password is provided.
if (process.env.QBIT_DOCKER_PASS) {
  await runForClient('QBITTORRENT (Docker)', 'qbittorrent', {
    host: HOST_FROM_CONTAINER, port: 8085,
    username: process.env.QBIT_DOCKER_USER || 'admin',
    password: process.env.QBIT_DOCKER_PASS,
    useHttps: false,
  });
} else {
  console.log('\n=== QBITTORRENT (Docker) — SKIPPED ===');
  console.log('  Set QBIT_DOCKER_PASS env var to the container admin password.');
  console.log('  (linuxserver/qbittorrent generates a random one on first boot; find it');
  console.log('   in `docker logs mstream-qbittorrent` from the very first run, or reset');
  console.log('   via the WebUI from inside the container where LocalHostAuth bypass works.)');
}

// Transmission Docker container is on host:9091. linuxserver's
// image enables RPC auth by default with admin/admin or a value the
// operator set via the TRANSMISSION_USER / TRANSMISSION_PASS image
// env vars. Pass them through here when the daemon container has
// non-default creds.
//
// Auto-skip when port 9091 is bound by a native Transmission install
// — best-effort detection via the unauthenticated session-get probe:
// the native default download-dir is the user's Windows-style
// %USERPROFILE%\Downloads, the Docker container's is /downloads.
const sessionGet = await fetch('http://127.0.0.1:9091/transmission/rpc', {
  method: 'POST',
  headers: { 'X-Transmission-Session-Id': 'x' },
  body: JSON.stringify({ method: 'session-get', arguments: { fields: ['download-dir'] }}),
}).catch(() => null);
if (sessionGet && (sessionGet.status === 409 || sessionGet.status === 401)) {
  // 409 = auth-disabled, just needs the session token.
  // 401 = auth-required; we'll let mStream's RPC module handle
  //       the auth handshake itself (we just need to know the port
  //       is reachable and it's a Transmission daemon).
  await runForClient('TRANSMISSION (Docker)', 'transmission', {
    host: HOST_FROM_CONTAINER, port: 9091,
    username: process.env.TRANSMISSION_DOCKER_USER || 'admin',
    password: process.env.TRANSMISSION_DOCKER_PASS || '',
    rpcPath: '/transmission/rpc', useHttps: false,
  });
}

// ─── Summary ───────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`TOTAL: ${pass} pass / ${fail} fail`);
if (fail) {
  console.log('\nFailures:');
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  ✗ ${r.label}  — ${r.detail || ''}`);
  }
}
process.exit(fail === 0 ? 0 : 1);
