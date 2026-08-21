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

// How much of the child's stderr to keep when logs aren't captured. Big
// enough for a full ERR_MODULE_NOT_FOUND / Joi stack, small enough that a
// chatty server can't grow test-process memory.
const STDERR_TAIL_BYTES = 4096;

// The timeout is a ceiling, not a wait: healthy boots return as soon as the
// API answers, and a crashed boot bails immediately via getExitError. 90s
// because heavy discovery suites (onnxruntime + iroh sidecar init) have blown
// a 30s budget on loaded windows-latest CI runners ("server not ready within
// 30000ms: fetch failed"), taking every test in the file down with them.
async function waitForReady(baseUrl, { timeoutMs = 90_000, getExitError = () => null } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    const exitErr = getExitError();
    if (exitErr) { throw new Error(exitErr); }
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) { return; }
    } catch (err) { lastErr = err; }
    await sleep(50);
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

// Same loaded-CI-runner ceiling as waitForReady — the scan (plus the
// embedding pass some discovery suites run behind it) shares the risk.
//
// "Complete" must mean the whole QUEUE of scans, not "no scan active this
// instant": boot scans enqueue ONE TASK PER LIBRARY (task-queue scanAll()),
// and onScanClose nulls the active task BEFORE nextTask() dispatches the
// next one — so /db/status's `locked` bit reads false between two
// per-library scans while later libraries are still unscanned. This 50ms
// poll slipped through exactly that gap on a contended runner (PR #803's
// ubuntu full-ci shard) and returned a half-scanned fixture to a suite
// using extraFolders. So gate on /api/v1/scan/status, which exposes the
// queue itself: done means no scan task ACTIVE and none QUEUED. Enrichment
// kinds (waveform, albumart, ...) are deliberately not waited on — same
// reasoning as isScanning() ignoring them; a throttled art pass can run for
// minutes after the library is fully browsable. The totalFileCount > 0
// guard (from /db/status, as before) covers the window before the boot scan
// is enqueued at all (scanOptions.bootScanDelay), when the queue is exactly
// as empty as when everything finished.
//
// ORDER MATTERS, and the two facts must NOT be sampled concurrently. The
// return condition ANDs an observation from /db/status (count > 0) with one
// from /api/v1/scan/status (queue idle). Issued together via Promise.all,
// those are two independent round-trips whose SERVICE times can diverge by
// far more than the 50ms poll: /db/status runs COUNT(*) over tracks, which
// blocks behind the scanner's SQLite write lock (busy_timeout 5000), while
// /scan/status answers from in-memory queue state plus a TTL-cached
// coverage read. Skews of 300ms were measured locally on an idle box; a
// contended Windows CI runner is worse. Concurrent sampling can therefore
// satisfy the condition with two observations that were never true at the
// same moment -- queue read as idle during the bootScanDelay window, count
// read seconds later once rows had landed -- and return a half-scanned
// fixture. Sampling SEQUENTIALLY, count first and queue second, makes the
// pair a sound proof instead: count > 0 means scanning had already begun,
// so every boot scan task was already enqueued; an idle queue observed
// strictly AFTER that means all of them have since finished.
async function waitForScanComplete(baseUrl, timeoutMs = 90_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      // Count FIRST -- see the ordering note above; do not merge these two
      // awaits back into a Promise.all.
      const statusR = await fetch(`${baseUrl}/api/v1/db/status`);
      if (statusR.ok) {
        const status = await statusR.json();
        if (status.totalFileCount > 0) {
          const queueR = await fetch(`${baseUrl}/api/v1/scan/status`);
          if (queueR.ok) {
            const { queue } = await queueR.json();
            // queue.scanning covers an active scan OR backup (the old
            // `locked` bit); the two kind checks close the between-tasks
            // and not-yet-dispatched gaps that bit can't see.
            const pending = queue.scanning
              || queue.activeTask === 'scan'
              || queue.queued.includes('scan');
            last = { totalFileCount: status.totalFileCount, queue };
            if (!pending) { return status.totalFileCount; }
          }
        } else {
          last = { totalFileCount: status.totalFileCount, queue: null };
        }
      }
    } catch (err) { last = { error: err.message }; }
    await sleep(50);
  }
  // Surface what the poll last saw -- a bare timeout tells the next person
  // nothing about WHICH half of the condition never came true.
  throw new Error(
    `initial scan did not complete within ${timeoutMs}ms; last seen: ${JSON.stringify(last)}`);
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
 * @param {string[]} [opts.extraArgs]              Extra CLI args after `-j <config>`
 *                                                 (e.g. ['--supervised'])
 * @param {string}  [opts.stdin='ignore']          stdio mode for the child's stdin;
 *                                                 'pipe' lets a test hold it open and
 *                                                 close it (the supervision suite)
 * @param {string}  [opts.execPath]                Runtime to spawn the server with
 *                                                 (default: this Node). The supervision
 *                                                 suite's bun legs pass 'bun'.
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
    extraArgs     = [],
    stdin         = 'ignore',
    execPath      = process.execPath,
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
    //
    // analyzeBpm ALSO defaults ON now — same guard: otherwise every scan in
    // the suite would fork the essentia BPM/key pass (a full ffmpeg decode +
    // analysis per fixture track), slowing the suite and risking the
    // CPU-saturation boot-timeout flakiness we've hit before. The
    // audio-analysis suites drive that worker directly / opt in explicitly.
    ...extraConfig,
    scanOptions: { autoAlbumArt: false, collectDiscoveryData: false, analyzeBpm: false, ...(extraConfig.scanOptions || {}) },
    // Same guard idea for the discovery network's community seeds — THREE
    // layers, all load-bearing:
    //  - seedListUrl → dead local port, so no test fetches GitHub;
    //  - useCommunitySeeds → false, so no test falls back to the BAKED
    //    seed list. Without this, every suite that enables discoveryP2p
    //    would join the REAL public network through the shipped seeds and
    //    broadcast its fake test announcements into real users' catalogs.
    //  - MSTREAM_TEST_BAKED_SEEDS='[]' (spawn env below) → empties the
    //    baked list itself. resolveBootstrap() UNIONS baked + fetched
    //    rather than picking one, so a seed-mechanics suite that re-enables
    //    useCommunitySeeds for its stub list still joined the real seeds
    //    through the first two guards — that union put the suite's fake
    //    "Stranger" announcements into real users' catalogs (2026-07-27).
    // A test that specifically exercises the seed mechanics overrides the
    // two config keys and brings its own stub list server; the env layer
    // stays, so the stub list is the entire seed universe it can reach.
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
    execPath,
    ['cli-boot-wrapper.js', '-j', configPath, ...extraArgs],
    {
      cwd: REPO_ROOT,
      stdio: captureLogs ? 'inherit' : [stdin, 'pipe', 'pipe'],
      // MSTREAM_SIDECAR_BASE → dead local port: same guard family as the
      // seedListUrl one above. When no sidecar binary is on disk, a suite
      // that enables discoveryP2p would otherwise have the server fetch the
      // manifest-pinned binary from the REAL sidecar release mid-test; the
      // dead base makes that path fail instantly and locally instead (the
      // stack degrades exactly like the missing-binary case). Suites that
      // exercise the fetch itself bring their own loopback store and
      // override this via `env`.
      env: { ...process.env, NODE_ENV: 'test', MSTREAM_TEST_BAKED_SEEDS: '[]', MSTREAM_SIDECAR_BASE: 'http://127.0.0.1:9', MSTREAM_PLAYER_BASE: 'http://127.0.0.1:9', ...env },
    },
  );

  // Drain output so the buffer doesn't back up even when not captured — but
  // keep a rolling tail of stderr. A boot crash used to surface as a bare
  // "server exited with code 1" with the real cause (e.g. a missing package
  // taking every integration suite down) discarded here.
  const stderrChunks = [];
  let stderrTailLen = 0;
  if (!captureLogs) {
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      stderrTailLen += chunk.length;
      while (stderrTailLen > STDERR_TAIL_BYTES) {
        const excess = stderrTailLen - STDERR_TAIL_BYTES;
        if (stderrChunks[0].length <= excess) {
          stderrTailLen -= stderrChunks.shift().length;
        } else {
          stderrChunks[0] = stderrChunks[0].subarray(excess);
          stderrTailLen -= excess;
        }
      }
    });
  }
  // Empty when captureLogs is true (stdio inherited — the crash already
  // printed to the test's own console) or when the child wrote nothing.
  const stderrTail = () => {
    const text = Buffer.concat(stderrChunks).toString('utf8').trim();
    return text ? `\n--- server stderr (tail) ---\n${text}` : '';
  };
  // 'exit' can fire while stderr data is still in the pipe; before building
  // an error message from the tail, wait (capped — a surviving scanner
  // grandchild can hold the pipe open) for the child's stdio to close.
  const procClosed = new Promise(r => proc.once('close', r));
  const flushStderr = () => Promise.race([procClosed, sleep(250)]);

  const baseUrl = `http://127.0.0.1:${port}`;
  let exitedEarly = null;
  proc.once('exit', code => {
    if (!exitedEarly) { exitedEarly = `server exited with code ${code}`; }
  });

  try {
    await waitForReady(baseUrl, { getExitError: () => exitedEarly });
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    if (exitedEarly) { await flushStderr(); }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw exitedEarly ? new Error(exitedEarly + stderrTail()) : err;
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
      await flushStderr();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`failed to create user "${u.username}": ${r.status} ${msg}${stderrTail()}`);
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

  // `proc` is the raw child handle, for tests that exercise process-level
  // behavior (the supervision suite destroys its pipes / closes its stdin).
  return { baseUrl, port, tmpDir, musicDir, subsonicBaseUrl, subsonicPort: sPort, proc, stop };
}
