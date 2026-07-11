/**
 * Spawns an mStream server in a child process for integration tests.
 *
 * Each test run gets a fresh temp directory (config, DB, logs, image cache)
 * and a free TCP port — so tests don't collide with a dev server running on
 * the default 3000, and don't leave state behind between runs.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) { return; }
    } catch (err) { lastErr = err; }
    await sleep(50);
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

async function waitForScanComplete(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/db/status`);
      if (r.ok) {
        const j = await r.json();
        if (!j.locked && j.totalFileCount > 0) { return j.totalFileCount; }
      }
    } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error('initial scan did not complete within timeout');
}

/**
 * Start an mStream instance. Returns { baseUrl, port, stop }.
 *
 * @param {Object} opts
 * @param {string} [opts.dlnaMode='same-port']     DLNA mode to configure
 * @param {string} [opts.browseMode='dirs']        `dlna.browse` default-view setting
 * @param {boolean} [opts.dlnaShareUserData]       `dlna.shareUserData`; omit for the
 *                                                 config default (true). Set false to
 *                                                 hide the per-user DLNA containers.
 * @param {string} [opts.subsonicMode='same-port'] Subsonic API mode to configure
 * @param {number} [opts.subsonicPort]             Port for Subsonic separate-port mode
 * @param {boolean} [opts.waitForScan=true]        Block until the initial scan finishes
 * @param {boolean} [opts.captureLogs=false]       Pipe stdout/stderr to the test process
 * @param {number}  [opts.rustPlayerPort]          Override config.rustPlayerPort so tests
 *                                                 can point the server-playback proxy
 *                                                 (and Subsonic jukeboxControl) at a stub.
 * @param {Object[]} [opts.users]                  Users to create after boot (PUT
 *   /api/v1/admin/users while the server is still in public-access mode).
 *   Each entry: { username, password, admin?, vpaths? }.
 */
export async function startServer(opts = {}) {
  const {
    dlnaMode      = 'same-port',
    browseMode    = 'dirs',
    dlnaShareUserData,
    subsonicMode  = 'same-port',
    subsonicPort,
    rustPlayerPort,
    waitForScan   = true,
    captureLogs   = false,
    users         = [],
    // Additional library mounts beyond the default `testlib` fixtures.
    // Shape: { vpathName: '/absolute/dir', ... }. Each entry is added
    // as a music folder the scanner will walk at boot. Useful for
    // tests that need a curated library distinct from the shared
    // fixtures (e.g. the V17 multi-artist suite builds compilation
    // and collab tracks on the fly).
    extraFolders  = {},
    // Which UI to serve: 'default' (webapp/alpha), 'velvet', or
    // 'subsonic' (webapp/subsonic → bundled Airsonic Refix). Only
    // affects the `/` HTML + SPA-fallback routing — all API tests
    // ignore this knob.
    ui            = 'default',
    // Optional extra process-env overrides passed to the spawned
    // mStream process. Used by the lyrics-cache test to point the
    // LRCLib fetcher at a local mock HTTP server instead of the real
    // lrclib.net.
    env           = {},
    // Extra top-level config keys merged into the generated config.json.
    // Keeps `startServer` honest as new config surfaces show up
    // (lyrics settings, etc.) without growing the options list.
    extraConfig   = {},
  } = opts;

  const musicDir = await ensureFixtures();
  const tmpDir   = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-test-'));
  const port     = await findFreePort();

  // Separate-port Subsonic needs its own free port if the caller didn't pick one.
  const sPort = subsonicMode === 'separate-port'
    ? (subsonicPort ?? await findFreePort())
    : 3012;

  const config = {
    port,
    address: '127.0.0.1',
    ui,
    dlna: {
      mode: dlnaMode,
      name: 'mStream Test',
      browse: browseMode,
      ...(dlnaShareUserData != null ? { shareUserData: dlnaShareUserData } : {}),
    },
    subsonic: {
      mode: subsonicMode,
      port: sPort,
    },
    ...(rustPlayerPort != null ? { rustPlayerPort } : {}),
    folders: {
      testlib: { root: musicDir },
      ...Object.fromEntries(
        Object.entries(extraFolders).map(([name, root]) => [name, { root }])
      ),
    },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      // Without this the waveform pass + endpoint write .bins and
      // .failed markers into the REPO's default waveform-cache/ —
      // persistent state shared across runs and parallel test files.
      waveformCacheDirectory: path.join(tmpDir, 'waveform-cache'),
    },
    // autoAlbumArt defaults ON in config.js, and the fixture albums have
    // no art — without this every scan in the suite would chain an
    // album-art download pass that queries REAL external services
    // (MusicBrainz/iTunes/Deezer) from CI. DEEP-merged below so an
    // extraConfig.scanOptions can't silently drop the guard; a test that
    // really wants the downloader sets autoAlbumArt: true explicitly and
    // points the service base URLs at a local mock via env
    // (MSTREAM_*_BASE).
    //
    // collectDiscoveryData also defaults ON in config.js now — same guard
    // idea: without this every scan would init discovery.db and fork the
    // CPU-heavy embedding worker (onnxruntime + a one-time ~18MB model
    // download), and unrelated suites would see the Discover panel/local
    // similarity APIs light up. Discovery suites opt in by setting
    // collectDiscoveryData: true (usually with discoveryModel: 'test-fake').
    ...extraConfig,
    scanOptions: { autoAlbumArt: false, collectDiscoveryData: false, ...(extraConfig.scanOptions || {}) },
    // Same guard idea for the discovery network's community seeds — TWO
    // layers, both load-bearing:
    //  - seedListUrl → dead local port, so no test fetches GitHub;
    //  - useCommunitySeeds → false, so no test falls back to the BAKED
    //    seed list. Without this, every suite that enables discoveryP2p
    //    would join the REAL public network through the shipped seeds and
    //    broadcast its fake test announcements into real users' catalogs.
    // A test that specifically exercises the seed mechanics overrides both
    // and brings its own stub list server.
    discoveryP2p: {
      seedListUrl: 'http://127.0.0.1:9/discovery-seeds.json',
      useCommunitySeeds: false,
      ...(extraConfig.discoveryP2p || {}),
    },
  };

  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  // Make the storage dirs up front so config.js doesn't log about them.
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    {
      cwd: REPO_ROOT,
      stdio: captureLogs ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', ...env },
    },
  );

  // Drain output so the buffer doesn't back up even when not captured.
  if (!captureLogs) {
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  let exitedEarly = null;
  proc.once('exit', code => {
    if (!exitedEarly) { exitedEarly = `server exited with code ${code}`; }
  });

  try {
    await waitForReady(baseUrl);
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw exitedEarly ? new Error(exitedEarly) : err;
  }

  if (waitForScan) {
    await waitForScanComplete(baseUrl);
  }

  // Create users before the caller starts testing. While there are zero users
  // the server is in public-access mode and admin endpoints are unauthenticated;
  // once the first user is added, subsequent ones need an admin token, so we
  // always mark the first created user as admin.
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const body = {
      username:    u.username,
      password:    u.password,
      admin:       u.admin ?? (i === 0),
      vpaths:      u.vpaths ?? ['testlib'],
      allowMkdir:  u.allowMkdir ?? true,
      allowUpload: u.allowUpload ?? true,
    };
    // First user created in public mode — no token needed. Subsequent users
    // require the first user's JWT; easier to just do them all via the
    // pre-user public path: add them in a loop while at least one survives
    // as a singleton is incorrect, so we create the first admin, then log in
    // and reuse that token for the rest.
    const headers = { 'Content-Type': 'application/json' };
    if (i > 0) {
      const loginR = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers,
        body: JSON.stringify({ username: users[0].username, password: users[0].password }),
      });
      const j = await loginR.json();
      if (j?.token) { headers['x-access-token'] = j.token; }
    }
    const r = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const msg = await r.text();
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`failed to create user "${u.username}": ${r.status} ${msg}`);
    }
  }

  async function stop() {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGKILL');
      await new Promise(r => proc.once('exit', r));
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // When Subsonic runs on a separate port, expose its base URL too — tests
  // that want to hit /rest on the secondary port use this directly.
  const subsonicBaseUrl = subsonicMode === 'separate-port'
    ? `http://127.0.0.1:${sPort}`
    : baseUrl;

  return { baseUrl, port, tmpDir, musicDir, subsonicBaseUrl, subsonicPort: sPort, stop };
}
