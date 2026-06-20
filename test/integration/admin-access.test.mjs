/**
 * Integration contract for the adminAccess security feature.
 *
 * The backend (config.program.adminAccess = { mode, whitelist }) is the
 * frozen subject under test here. Four modes gate the admin surface:
 *
 *   'all'       — admin reachable from anywhere.
 *   'none'      — admin disabled: /api/v1/admin/* → 405 {error:'Admin API
 *                 Disabled'}. config.program.lockAdmin is DERIVED as
 *                 mode==='none', so this is exactly the old lockAdmin=true.
 *   'localhost' — only loopback IPs (127.0.0.0/8 + ::1); others → 403
 *                 {error:'Admin access restricted to local network'}.
 *   'whitelist' — only IPs/CIDRs in adminAccess.whitelist; others → 403.
 *
 * The gate is an application-level req.ip check (src/util/admin-network.js)
 * that honors Express "trust proxy", and all four modes take effect LIVE
 * (no reboot).
 *
 * Technique for simulating remote clients without a real network: boot with
 * trustProxy=true, then attach an "X-Forwarded-For: <ip>" header to the
 * fetch. Express then reports req.ip as that forwarded value, so the gate
 * sees the spoofed IP. With no XFF header, req.ip is the real loopback
 * connection (127.0.0.1), which is what an operator sitting at the box sees.
 *
 * We boot in PUBLIC mode (no users): auth.js pins req.user to the anonymous
 * sentinel and req.user.admin is true whenever mode!=='none', so we can hit
 * admin endpoints token-free. The mode='none' branch demotes that to
 * admin=false (and short-circuits with 405 in admin.js regardless).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('server not ready');
}

/**
 * Boot a fresh mStream in public mode. `extraConfig` is merged over the
 * minimal base so each describe-block can pin the adminAccess shape (or the
 * legacy lockAdmin flag) it needs. trustProxy defaults ON here so tests can
 * forge req.ip via X-Forwarded-For; pass trustProxy:false to override.
 */
async function bootMstream(tmpDir, musicDir, extraConfig = {}) {
  const port = await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    // The IP gate reads req.ip; with trust proxy on, an X-Forwarded-For
    // header becomes req.ip, letting us simulate remote clients.
    trustProxy: true,
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
    ...extraConfig,
  };
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    },
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// GET /api/v1/admin/config, optionally forging the client IP via XFF.
function getAdminConfig(baseUrl, forwardedFor) {
  const headers = {};
  if (forwardedFor !== undefined) headers['X-Forwarded-For'] = forwardedFor;
  return fetch(`${baseUrl}/api/v1/admin/config`, { headers });
}

// POST /api/v1/admin/config/admin-access. Sent from loopback (no XFF) so the
// admin gate itself never blocks the mode-change call under localhost mode.
function postAdminAccess(baseUrl, body) {
  return fetch(`${baseUrl}/api/v1/admin/config/admin-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ────────────────────────────────────────────────────────────────────

describe("adminAccess mode 'all' — reachable from anywhere", () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-all-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'all' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('GET admin/config from a remote IP (XFF 8.8.8.8) → 200', async () => {
    const r = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(r.status, 200, "mode 'all' must serve any IP");
    const body = await r.json();
    assert.equal(body.adminAccess.mode, 'all', 'config echoes the active mode');
    assert.ok(Array.isArray(body.adminAccess.whitelist), 'config exposes the whitelist array');
  });
});

// ────────────────────────────────────────────────────────────────────

describe("adminAccess mode 'localhost' — loopback only", () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-local-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'localhost' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('no XFF (real loopback connection) → 200', async () => {
    const r = await getAdminConfig(server.baseUrl);
    assert.equal(r.status, 200, 'loopback must always reach admin under localhost mode');
  });

  test('remote IP (XFF 8.8.8.8) → 403', async () => {
    const r = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(r.status, 403, 'non-loopback must be blocked');
    const body = await r.json();
    assert.equal(body.error, 'Admin access restricted to local network');
  });

  test('IPv4-mapped remote (XFF ::ffff:8.8.8.8) → 403', async () => {
    // The mapped form normalizes to plain IPv4 8.8.8.8, which is still not
    // loopback — must stay blocked.
    const r = await getAdminConfig(server.baseUrl, '::ffff:8.8.8.8');
    assert.equal(r.status, 403, 'IPv4-mapped non-loopback must be blocked');
  });

  test('IPv4-mapped loopback (XFF ::ffff:127.0.0.1) → 200', async () => {
    // normalizeIp strips the ::ffff: prefix so this is checked as 127.0.0.1
    // against the 127.0.0.0/8 loopback subnet — allowed.
    const r = await getAdminConfig(server.baseUrl, '::ffff:127.0.0.1');
    assert.equal(r.status, 200, 'IPv4-mapped loopback must be normalized and allowed');
  });
});

// ────────────────────────────────────────────────────────────────────

describe("adminAccess mode 'whitelist' — default LAN list", () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-wl-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    // Omit `whitelist` so the schema's default LAN list applies
    // (127/8, ::1/128, 10/8, 172.16/12, 192.168/16).
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'whitelist' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('whitelisted LAN IP (XFF 192.168.1.50) → 200', async () => {
    const r = await getAdminConfig(server.baseUrl, '192.168.1.50');
    assert.equal(r.status, 200, '192.168.0.0/16 is in the default whitelist');
  });

  test('off-list public IP (XFF 8.8.8.8) → 403', async () => {
    const r = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(r.status, 403, 'a public IP is not in the default whitelist');
    const body = await r.json();
    assert.equal(body.error, 'Admin access restricted to local network');
  });
});

// ────────────────────────────────────────────────────────────────────

describe("adminAccess mode 'none' — admin fully disabled", () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-none-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'none' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('GET admin/config from loopback → 405 (disabled regardless of IP)', async () => {
    const r = await getAdminConfig(server.baseUrl);
    assert.equal(r.status, 405);
    const body = await r.json();
    assert.equal(body.error, 'Admin API Disabled');
  });

  test('GET admin/config from a whitelisted-looking IP → 405', async () => {
    // 'none' wins even over an IP that other modes would allow — the
    // lockAdmin-derived 405 short-circuits before the IP gate.
    const r = await getAdminConfig(server.baseUrl, '192.168.1.50');
    assert.equal(r.status, 405);
    const body = await r.json();
    assert.equal(body.error, 'Admin API Disabled');
  });
});

// ────────────────────────────────────────────────────────────────────

describe('legacy lockAdmin=true migration → mode none', () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-legacy-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    // Pre-adminAccess config: lockAdmin=true and NO adminAccess key. setup()
    // migrates this to adminAccess.mode='none' before validation.
    server = await bootMstream(tmpDir, musicDir, { lockAdmin: true });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('a legacy lockAdmin=true config disables admin → 405', async () => {
    const r = await getAdminConfig(server.baseUrl);
    assert.equal(r.status, 405, 'lockAdmin=true must migrate to mode none');
    const body = await r.json();
    assert.equal(body.error, 'Admin API Disabled');
  });
});

// ────────────────────────────────────────────────────────────────────

describe('live mode change without reboot', () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-live-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'all' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("flipping 'all' → 'localhost' via the API blocks a remote IP immediately", async () => {
    // Sanity: remote IP allowed under 'all'.
    const before = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(before.status, 200, "remote IP reachable while mode is 'all'");

    // Flip live (POST sent from loopback so the gate doesn't block it).
    const change = await postAdminAccess(server.baseUrl, { mode: 'localhost' });
    assert.equal(change.status, 200, 'mode change should succeed');
    assert.deepEqual(await change.json(), {}, 'endpoint returns {}');

    // No reboot: the same remote IP is now blocked.
    const after = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(after.status, 403, 'change must take effect with no restart');

    // And loopback still works under the new mode.
    const loop = await getAdminConfig(server.baseUrl);
    assert.equal(loop.status, 200, 'loopback reachable under the new localhost mode');
    const body = await loop.json();
    assert.equal(body.adminAccess.mode, 'localhost', 'config reflects the live change');
  });
});

// ────────────────────────────────────────────────────────────────────

describe('legacy lock-api alias semantics', () => {
  // NOTE on the round-trip: once lock-api{lock:true} flips mode to 'none',
  // the admin guard's first check (config.program.lockAdmin===true → 405)
  // fires for EVERY /api/v1/admin/* route — including lock-api itself. So a
  // subsequent {lock:false} can't reach its handler over HTTP; relaxing from
  // 'none' is an out-of-band (config-edit + reboot) operation by design. We
  // therefore exercise each lock-api branch against the behavior it actually
  // produces rather than asserting an impossible none→all HTTP transition:
  //   • lock:true   → mode 'none', admin disabled (verified below).
  //   • lock:false  → no-op when already non-'none' (preserves the richer
  //                   configured mode), call returns 200 (verified below).
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-lockapi-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'all' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function postLockApi(lock) {
    return fetch(`${server.baseUrl}/api/v1/admin/lock-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock }),
    });
  }

  test('{lock:false} on a non-none mode is a no-op that preserves the mode', async () => {
    // We boot 'all'. lock:false must NOT touch the configured mode (it only
    // relaxes when currently 'none'), and admin stays reachable.
    const r = await postLockApi(false);
    assert.equal(r.status, 200, 'unlock call succeeds');

    const cfg = await getAdminConfig(server.baseUrl);
    assert.equal(cfg.status, 200, 'admin still reachable after a no-op unlock');
    const body = await cfg.json();
    assert.equal(body.adminAccess.mode, 'all', "lock:false left the 'all' mode intact");
  });

  test('{lock:true} disables admin → 405', async () => {
    // Run after the no-op-unlock test (node:test runs tests in source order
    // within a describe), so we are still in 'all' and the call gets through.
    const lock = await postLockApi(true);
    assert.equal(lock.status, 200, 'lock-api call itself succeeds while still unlocked');

    const locked = await getAdminConfig(server.baseUrl);
    assert.equal(locked.status, 405, 'lock:true must map to mode none (admin disabled)');
    const body = await locked.json();
    assert.equal(body.error, 'Admin API Disabled');
  });

  test('once locked, lock-api itself is gated (405) — relaxing from none is out-of-band', async () => {
    // Confirms the documented limitation above: the unlock can't reach its
    // handler because the admin guard short-circuits the locked surface.
    const unlock = await postLockApi(false);
    assert.equal(unlock.status, 405, 'lock-api is behind the same guard it disabled');
  });
});

// ────────────────────────────────────────────────────────────────────

describe('whitelist /0 range is rejected by validation', () => {
  let tmpDir, server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-aa-zero-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir, { adminAccess: { mode: 'localhost' } });
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("POST admin-access with whitelist ['0.0.0.0/0'] → 400 and mode unchanged", async () => {
    const r = await postAdminAccess(server.baseUrl, {
      mode: 'whitelist',
      whitelist: ['0.0.0.0/0'],
    });
    assert.equal(r.status, 400, 'a /0 allow-all range must fail Joi validation');
    const body = await r.json();
    assert.ok(body.error, 'a validation error message is returned');

    // The rejected POST must not have applied any change: mode is still the
    // localhost we booted with, so a remote IP is still 403 and loopback is
    // still 200 (proving we did NOT silently flip to allow-all whitelist).
    const remote = await getAdminConfig(server.baseUrl, '8.8.8.8');
    assert.equal(remote.status, 403, 'mode must be unchanged after the rejected write');
    const loop = await getAdminConfig(server.baseUrl);
    assert.equal(loop.status, 200);
    const cfg = await loop.json();
    assert.equal(cfg.adminAccess.mode, 'localhost', 'mode stayed localhost');
  });
});
