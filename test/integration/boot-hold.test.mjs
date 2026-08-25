// The boot hold end to end (src/server.js + src/util/boot-errors.js): a
// server whose database cannot open for an ENVIRONMENTAL reason must not
// crash into the supervisor's restart loop — it binds its port, answers
// every request 503 with the diagnosis, retries on a timer, and swaps the
// real app in the moment the problem is fixed.
//
// The environmental stand-in is a damaged mstream.db (garbage bytes →
// SQLITE_NOTADB at the WAL pragma): fully cross-platform, unlike faking
// ENOSPC. The recovery step deletes the damaged file while the server is
// HOLDING — which doubles as a regression test for the hold's
// dbManager.close() call: a leaked half-open handle would make that
// delete fail with EPERM on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFreePort } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RETRY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryFetch(url, headers = {}) {
  try {
    return await fetch(url, { headers });
  } catch (_err) {
    return null; // not bound yet / connection refused
  }
}

test('an environmental db failure holds the boot with a 503 diagnosis, then recovers when fixed', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-boot-hold-'));
  const dirs = {
    db: path.join(tmp, 'db'),
    logs: path.join(tmp, 'logs'),
    art: path.join(tmp, 'image-cache'),
    waveform: path.join(tmp, 'waveform-cache'),
    music: path.join(tmp, 'music'),
    home: path.join(tmp, 'home'),
  };
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));

  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    port,
    address: '127.0.0.1',
    folders: { lib: { root: dirs.music } },
    storage: {
      dbDirectory: dirs.db,
      logsDirectory: dirs.logs,
      albumArtDirectory: dirs.art,
      waveformCacheDirectory: dirs.waveform,
    },
    // The helper suite's hermetic guards (test/helpers/server.mjs): no
    // album-art downloads, no discovery/embedding workers, no BPM pass, no
    // community seeds — and a boot scan pushed past this test's lifetime.
    scanOptions: { autoAlbumArt: false, collectDiscoveryData: false, analyzeBpm: false, bootScanDelay: 60 },
    discoveryP2p: { seedListUrl: 'http://127.0.0.1:9/discovery-seeds.json', useCommunitySeeds: false },
  }, null, 2));

  // The damage: sixteen-plus non-SQLite bytes, so the header check fails
  // with SQLITE_NOTADB on the first statement.
  const dbFile = path.join(dirs.db, 'mstream.db');
  await fs.writeFile(dbFile, 'mStream test fixture: deliberately not a SQLite database file.');

  const child = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MSTREAM_BOOT_HOLD_RETRY_MS: String(RETRY_MS),
      MSTREAM_TEST_BAKED_SEEDS: '[]',
      // Sandbox anything that keys on the user's data home (the boot
      // watchdog's attempt file, dataRoot fallbacks) into the temp dir.
      HOME: dirs.home,
      XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'),
      APPDATA: path.join(dirs.home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'),
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out = (out + d).slice(-8192); });
  child.stderr.on('data', (d) => { out = (out + d).slice(-8192); });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    // Phase 1: the hold. The port must come up (bound by the hold listener,
    // not the app) and answer 503 with the machine-readable diagnosis.
    // Generous ceiling for loaded CI runners, same reasoning as the server
    // helper's waitForReady.
    const deadline = Date.now() + 90_000;
    let held = null;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `server exited during the hold phase:\n${out}`);
      held = await tryFetch(`${base}/api/`);
      if (held) { break; }
      await sleep(50);
    }
    assert.ok(held, `no response from the held server within 90s:\n${out}`);
    assert.equal(held.status, 503);
    assert.equal(held.headers.get('x-mstream-boot-hold'), 'db-damaged');
    const body = await held.json();
    assert.equal(body.code, 'db-damaged');
    assert.match(body.error, /damaged/);
    assert.match(body.hint, /playlists/);

    // Browsers get the human page from the same handler. Polled like the
    // /api/ probe: every hold response closes its connection, so a single
    // fetch can race a just-closed socket on a loaded runner.
    let page = null;
    const pageDeadline = Date.now() + 30_000;
    while (!page && Date.now() < pageDeadline) {
      page = await tryFetch(`${base}/`, { accept: 'text/html,application/xhtml+xml' });
      if (!page) { await sleep(100); }
    }
    assert.ok(page, `no response for the HTML hold page:\n${out}`);
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /mStream cannot start/);
    assert.match(html, /refreshes itself/);

    // The whole point: several retry periods pass and the process is still
    // this same, single, live process — no crash, no supervisor loop.
    await sleep(RETRY_MS * 3);
    assert.equal(child.exitCode, null, `server crashed instead of holding:\n${out}`);
    const stillHeld = await tryFetch(`${base}/api/`);
    assert.equal(stillHeld?.status, 503, 'must still be holding before the fix');

    // Phase 1b: a config failure during a retry must not end the hold.
    // (The docker layout keeps config.json on the same volume as the db,
    // so the held failure can take the config read down with it.) Break
    // the config, watch the diagnosis flip to 'config', restore it, watch
    // it flip back — the process must stay alive throughout.
    const goodConfig = await fs.readFile(configPath, 'utf8');
    await fs.writeFile(configPath, '{ not json at all');
    const flipDeadline = Date.now() + 30_000;
    let flipped = null;
    while (Date.now() < flipDeadline) {
      assert.equal(child.exitCode, null, `server exited after a config failure mid-hold:\n${out}`);
      const r = await tryFetch(`${base}/api/`);
      if (r && r.headers.get('x-mstream-boot-hold') === 'config') { flipped = r; break; }
      await sleep(100);
    }
    assert.ok(flipped, `hold never reported the config failure:\n${out}`);
    await fs.writeFile(configPath, goodConfig);
    const backDeadline = Date.now() + 30_000;
    let back = false;
    while (Date.now() < backDeadline) {
      assert.equal(child.exitCode, null, `server exited restoring the config mid-hold:\n${out}`);
      const r = await tryFetch(`${base}/api/`);
      if (r && r.headers.get('x-mstream-boot-hold') === 'db-damaged') { back = true; break; }
      await sleep(100);
    }
    assert.ok(back, `hold never returned to the db diagnosis after the config was restored:\n${out}`);

    // Phase 2: the fix. Deleting the damaged file must succeed while the
    // server holds (the hold's dbManager.close() released the half-open
    // handle — on Windows a leaked handle turns this into EPERM), and the
    // next retry must boot the real app onto the SAME socket.
    await fs.rm(dbFile);
    const recoverDeadline = Date.now() + 90_000;
    let recovered = null;
    while (Date.now() < recoverDeadline) {
      assert.equal(child.exitCode, null, `server exited during recovery:\n${out}`);
      const r = await tryFetch(`${base}/api/`);
      if (r && r.status < 500) { recovered = r; break; }
      await sleep(100);
    }
    assert.ok(recovered, `server did not recover within 90s of the fix:\n${out}`);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await Promise.race([exited, sleep(10_000)]);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
