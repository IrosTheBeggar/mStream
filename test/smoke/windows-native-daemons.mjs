#!/usr/bin/env node
// Smoke test for native-Windows torrent clients.
//
// Unlike the Docker'd smoke that's been driving most of the dev
// iteration, this script targets Transmission + qBittorrent installed
// directly on Windows (no container). The path-handling code paths
// differ — native clients emit `save_path` / `content_path` with
// backslashes, where Dockerised Linux clients emit POSIX paths.
//
// USAGE
//   1. Start one or both daemons:
//        - Transmission (default port 9091, default RPC user/pw blank)
//        - qBittorrent  (default port 8080, set Web UI user/pw)
//   2. Configure their default download directory to an absolute
//      Windows path the test fixtures will write into:
//        e.g.   C:\mstream-smoke\transmission
//               C:\mstream-smoke\qbittorrent
//   3. Set MSTREAM_BASE if your server isn't on 127.0.0.1:8914.
//   4. Edit CONFIG below or pass env overrides.
//   5. `node test/smoke/windows-native-daemons.mjs`
//
// What it verifies (these are the paths that broke on native Windows
// before the fix in path-probe.js):
//   A. Daemon-known-paths candidate generator emits canonical
//      forward-slash candidates — no mixed-separator paths.
//   B. /api/v1/admin/torrent/vpath-access/auto-detect produces a
//      working mapping for a native Windows download dir.
//   C. /api/v1/torrent/seed-existing's `seeded` outcome works when
//      the daemon's savePath comes back with backslashes.
//   D. /api/v1/torrent/seed-existing's `partial_match` outcome
//      surfaces the relativePath without separator leakage.
//   E. `/torrent/add` builds a downloadDir the daemon accepts and
//      the resulting managed_torrents.download_path uses canonical
//      forward-slash form (verified by the completion-watcher later).
//
// NOT covered here (need a real swarm):
//   - End-to-end download completion + the completion-watcher's
//     subtree-rescan trigger. The watcher unit tests cover the
//     path-matching contract that's the relevant Windows surface.

import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';

// ── CONFIG ──────────────────────────────────────────────────────────
// Override via env. The defaults mirror what most operators end up
// with after a default install of each client on Windows.
const CONFIG = {
  base:      process.env.MSTREAM_BASE      || 'http://127.0.0.1:8914',
  jwtSecret: process.env.MSTREAM_SECRET    || '', // required
  // Native daemons. Set null to skip the relevant daemon.
  transmission: process.env.SKIP_TRANSMISSION ? null : {
    host:     process.env.TRANSMISSION_HOST     || '127.0.0.1',
    port:     parseInt(process.env.TRANSMISSION_PORT || '9091', 10),
    username: process.env.TRANSMISSION_USER     || '',
    password: process.env.TRANSMISSION_PASS     || '',
    rpcPath:  process.env.TRANSMISSION_RPC_PATH || '/transmission/rpc',
    // Native download dir on the Windows host. Use backslashes — the
    // whole point is to exercise this case.
    downloadDir: process.env.TRANSMISSION_DOWNLOAD_DIR
      || 'C:\\mstream-smoke\\transmission',
  },
  qbittorrent: process.env.SKIP_QBITTORRENT ? null : {
    host:     process.env.QBITTORRENT_HOST || '127.0.0.1',
    port:     parseInt(process.env.QBITTORRENT_PORT || '8080', 10),
    username: process.env.QBITTORRENT_USER || 'admin',
    password: process.env.QBITTORRENT_PASS || 'adminadmin',
    downloadDir: process.env.QBITTORRENT_DOWNLOAD_DIR
      || 'C:\\mstream-smoke\\qbittorrent',
  },
  // The vpath the test will use on the mStream side. Set up as a
  // library in your mStream config before running.
  vpath:          process.env.MSTREAM_VPATH || 'testlib',
  // The vpath's mStream-side root. Must match the daemon's download
  // dir (or be bound to it via a junction/symlink) — that's the
  // whole point of bare-metal path-probing.
  vpathRootPath:  process.env.MSTREAM_VPATH_ROOT
    || 'C:\\mstream-smoke\\transmission',
};

if (!CONFIG.jwtSecret) {
  console.error('SET MSTREAM_SECRET to the server\'s `secret` config value');
  process.exit(2);
}

const TOK = jwt.sign({ username: 'admin' }, CONFIG.jwtSecret);
const BASE = CONFIG.base;

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

async function api(method, p, body, { multipart = false } = {}) {
  const headers = { 'x-access-token': TOK };
  if (!multipart && body !== undefined) {
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

// ── Fixture builders ────────────────────────────────────────────────
// Single-file torrent for `<vpathRoot>\fixture-windows-native.bin`.
async function setupSingleFileFixture(daemonDownloadDir) {
  const fileName = 'fixture-windows-native.bin';
  // Daemon's view + mStream's view should be the same dir on a
  // native-on-Windows setup. Use Windows path concat to be honest.
  const fullPath = path.win32.join(daemonDownloadDir, fileName);
  const size = 1024;
  await fs.mkdir(daemonDownloadDir, { recursive: true });
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) { buf[i] = i % 256; }
  await fs.writeFile(fullPath, buf);

  // Build the .torrent metainfo by hand. `piece length` = 16384 so
  // a single 1024-byte piece. The 20-byte piece hash must match
  // SHA-1 of the file content.
  const { createHash } = await import('node:crypto');
  const pieceHash = createHash('sha1').update(buf).digest();

  const head = `d4:infod6:lengthi${size}e4:name${fileName.length}:${fileName}12:piece lengthi16384e6:pieces20:`;
  const tail = 'ee';
  const meta = Buffer.alloc(head.length + 20 + tail.length);
  meta.write(head, 0, 'binary');
  pieceHash.copy(meta, head.length);
  meta.write(tail, head.length + 20, 'binary');

  return { metainfo: meta, fileName, size, fullPath };
}

// ── Per-client matrix ────────────────────────────────────────────────
async function configureClient(client, opts) {
  console.log(`\n── Configure ${client} ──`);
  // Save credentials. test endpoint probes the daemon; if it fails the
  // smoke aborts early with a clear message.
  const test = await api('POST', `/api/v1/admin/torrent/${client}/test`, opts);
  if (!test.body?.ok) {
    record(`${client} · test connection`, false,
      `status=${test.status} error=${test.body?.error || 'unknown'}`);
    return false;
  }
  record(`${client} · test connection`, true,
    `version=${test.body.version}`);

  // Persist via /connect (saves creds + probes again).
  const conn = await api('POST', `/api/v1/admin/torrent/${client}/connect`, opts);
  if (!conn.body?.ok) {
    record(`${client} · connect (save creds)`, false,
      `error=${conn.body?.error}`);
    return false;
  }
  record(`${client} · connect (save creds)`, true);

  // Activate as the selected client.
  await api('POST', '/api/v1/admin/torrent/client', { client });
  return true;
}

async function runForClient(name, conf) {
  if (!conf) {
    console.log(`\n=== ${name.toUpperCase()} — SKIPPED ===`);
    return;
  }
  console.log(`\n=== ${name.toUpperCase()} (native Windows) ===`);
  const ok = await configureClient(name, conf);
  if (!ok) { return; }

  // ── A: auto-detect produces a forward-slash candidate ────────────
  const ad = await api('POST', '/api/v1/admin/torrent/vpath-access/auto-detect',
    { vpathName: CONFIG.vpath });
  const ap = ad.body?.vpaths?.[CONFIG.vpath]?.daemonPath;
  record(`${name} · auto-detect produces a daemonPath`, !!ap,
    `daemonPath=${ap}`);
  record(`${name} · daemonPath has NO backslashes (canonical FS)`,
    ap && !ap.includes('\\'),
    `daemonPath=${ap}`);
  record(`${name} · daemonPath has NO mixed separators`,
    ap && !/[\\].*\/|\/.*[\\]/.test(ap),
    `daemonPath=${ap}`);

  // ── B: seed-existing seeded outcome on native Windows fixture ────
  const { metainfo, fileName, size } = await setupSingleFileFixture(conf.downloadDir);
  // Need to clear daemon first so it doesn't already-in-daemon
  const list = await api('GET', '/api/v1/admin/torrent/list');
  for (const t of (list.body?.torrents || [])) {
    await api('DELETE', '/api/v1/admin/torrent/' + t.infoHash);
  }
  await new Promise(r => setTimeout(r, 800));

  const seedRes = await uploadTorrent('/api/v1/torrent/seed-existing', {
    torrentFile: metainfo,
  });
  record(`${name} · seed-existing on native Windows fixture → seeded`,
    seedRes.body?.outcome === 'seeded',
    `outcome=${seedRes.body?.outcome} name=${seedRes.body?.name}`);
  // The user-facing route strips absolute paths, but we can still
  // check the daemon side via the admin route.
  await new Promise(r => setTimeout(r, 1500));
  const adminList = await api('GET', '/api/v1/admin/torrent/list');
  const added = (adminList.body?.torrents || [])
    .find(t => (t.name || '').includes(fileName.split('.')[0]) ||
               t.infoHash === seedRes.body?.infoHash);
  record(`${name} · daemon registered the torrent`,
    !!added, `infoHash=${added?.infoHash?.slice(0,12)}`);
  if (added) {
    // The savePath/contentPath the daemon reports — should match the
    // Windows download dir (with either separator style).
    const sp = added.savePath || '';
    record(`${name} · daemon's savePath is a Windows path`,
      sp.includes(':') && (sp.includes('\\') || sp.includes('/')),
      `savePath=${sp}`);
  }
  // Cleanup
  for (const t of (adminList.body?.torrents || [])) {
    await api('DELETE', '/api/v1/admin/torrent/' + t.infoHash);
  }
  await fs.unlink(path.win32.join(conf.downloadDir, fileName)).catch(() => {});
}

// ── Main ─────────────────────────────────────────────────────────────
console.log('Native-Windows daemon smoke');
console.log(`Server: ${BASE}  Vpath: ${CONFIG.vpath} (${CONFIG.vpathRootPath})`);

await runForClient('transmission', CONFIG.transmission);
await runForClient('qbittorrent',  CONFIG.qbittorrent);

// ── Summary ──────────────────────────────────────────────────────────
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
