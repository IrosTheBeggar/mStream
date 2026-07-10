/**
 * Backup-worker filesystem semantics (audit batch 1).
 *
 * The task-queue suite exercises queue mechanics; nothing previously
 * asserted what the worker actually does to the destination tree. These
 * tests drive src/backup/worker.mjs directly (spawned exactly like
 * task-queue does — argv JSON, line-JSON events on stdout) and cover the
 * three audit fixes:
 *
 *   1. Excluded-only source must NOT pass the empty-source guard.
 *      A dead mountpoint holding only OS litter (.DS_Store, Thumbs.db —
 *      the default excludes) previously passed hasAnyFiles() while the
 *      merge-walk saw an empty source, sweeping the ENTIRE destination
 *      into trash.
 *   2. follow_symlinks wiring. The destination getters never SELECTed
 *      libraries.follow_symlinks, so the worker always received
 *      followSymlinks:false and silently skipped symlinked content.
 *   3. utimes-hostile destinations. A failed mtime stamp used to abort
 *      the copy AFTER the bytes were written (tmp unlinked), so files
 *      never landed; and without the fidelity probe, files that DID land
 *      would be trashed + recopied on every subsequent run. Injected via
 *      test/fixtures/fail-utimes.cjs preloaded into the worker.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'backup', 'worker.mjs');
// NODE_OPTIONS parses backslashes as escapes — always hand it forward
// slashes, which Node's module loader accepts on Windows too.
const FAIL_UTIMES = path.join(REPO_ROOT, 'test', 'fixtures', 'fail-utimes.cjs').replace(/\\/g, '/');

const DEFAULT_EXCLUDES = ['Thumbs.db', 'desktop.ini', '.DS_Store', '._*'];

let envCounter = 0;
function makeTempRoot(tag) {
  const root = path.join(os.tmpdir(), `mstream-bw-${tag}-` + Date.now() + '-' + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Spawn the worker exactly as task-queue.js does (single JSON argv) and
// collect its line-JSON events. Resolves with the exit code, the parsed
// event list, and raw stderr.
function runWorker(payload, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const events = out.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
      resolve({ code, events, stderr: errOut });
    });
  });
}

function doneEvent(events) {
  return events.find((e) => e.event === 'done') || null;
}
function errorEvent(events) {
  return events.find((e) => e.event === 'error') || null;
}

// Give a file an mtime `days` in the past (or negative for the future).
// The injection tests MUST separate source mtimes from copy-time, or
// they stop pinning anything: files written moments before the run land
// within the worker's 2s mtime tolerance, so even a broken comparison
// path looks correct.
function shiftMtime(p, days) {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(p, t, t);
}

// Force dest copies into the shape a timestamp-stripping destination
// (Linux copyFile onto NFS/FUSE with utimes denied) leaves behind:
// copy-time mtimes. Windows CopyFileEx preserves source mtimes, which
// would otherwise mask a missing fidelity fallback on this platform.
function forceCopyTimeMtimes(destDir) {
  for (const rel of listFiles(destDir)) {
    const now = new Date();
    fs.utimesSync(path.join(destDir, rel), now, now);
  }
}

// List a directory tree as sorted relative paths of regular files,
// ignoring the worker's trash bucket.
function listFiles(root, sub = '') {
  const dir = path.join(root, sub);
  if (!fs.existsSync(dir)) { return []; }
  const acc = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.mstream-trash') { continue; }
    const rel = sub ? path.join(sub, entry.name) : entry.name;
    if (entry.isDirectory()) { acc.push(...listFiles(root, rel)); }
    else if (entry.isFile()) { acc.push(rel); }
  }
  return acc.sort();
}

// ── 1. Excluded-only source must not sweep the destination ─────────────────

describe('backup worker: empty-source guard vs exclude globs', () => {
  test('source holding only default-excluded litter refuses to run; dest untouched', async () => {
    const root = makeTempRoot('guard');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    // The disconnected-mountpoint shape: no real files anywhere, just OS
    // litter — including litter nested in a non-excluded subdirectory.
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, '.DS_Store'), 'litter');
    fs.writeFileSync(path.join(src, 'Thumbs.db'), 'litter');
    fs.writeFileSync(path.join(src, 'sub', 'desktop.ini'), 'litter');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'precious-a.mp3'), 'aaaa');
    fs.writeFileSync(path.join(dest, 'precious-b.mp3'), 'bbbb');

    const { code, events } = await runWorker({
      sourcePath: src, destPath: dest, retentionDays: 30,
      excludeGlobs: DEFAULT_EXCLUDES,
    });

    assert.equal(code, 1, 'worker must exit 1 (fatal) instead of syncing');
    const err = errorEvent(events);
    assert.ok(err, 'a fatal error event must be emitted');
    assert.match(err.message, /zero files/i);
    assert.deepEqual(listFiles(dest), ['precious-a.mp3', 'precious-b.mp3'],
      'destination files must be untouched');
    assert.equal(fs.existsSync(path.join(dest, '.mstream-trash')), false,
      'nothing may be trashed by a refused run');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a single real file among the litter still syncs', async () => {
    const root = makeTempRoot('guard-ok');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, '.DS_Store'), 'litter');
    fs.writeFileSync(path.join(src, 'real.mp3'), 'music');

    const { code, events } = await runWorker({
      sourcePath: src, destPath: dest, retentionDays: 30,
      excludeGlobs: DEFAULT_EXCLUDES,
    });

    assert.equal(code, 0);
    assert.equal(doneEvent(events)?.filesCopied, 1);
    assert.deepEqual(listFiles(dest), ['real.mp3'],
      'the real file lands; excluded litter is not mirrored');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── 2. utimes-hostile destination (root-squash NFS / SMB / FUSE shape) ─────

describe('backup worker: destination that rejects utimes', () => {
  const injectEnv = { NODE_OPTIONS: `--require "${FAIL_UTIMES}"` };

  test('control (no injection): copy run then unchanged run, no file errors', async () => {
    const root = makeTempRoot('ctl');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(src, `t${i}.mp3`), `data-${i}`); }

    const run1 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(run1.code, 0);
    assert.equal(doneEvent(run1.events)?.filesCopied, 3);
    assert.equal(doneEvent(run1.events)?.fileErrors, 0);

    const run2 = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    assert.equal(run2.code, 0);
    assert.equal(doneEvent(run2.events)?.filesUnchanged, 3, 'second run must skip all files');
    assert.equal(doneEvent(run2.events)?.filesCopied, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('files still land when every utimes call fails', async () => {
    const root = makeTempRoot('inj1');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(src, `t${i}.mp3`), `data-${i}`); }

    const { code, events } = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: injectEnv },
    );

    assert.equal(code, 0, 'utimes failure is not fatal');
    const done = doneEvent(events);
    assert.equal(done.filesCopied, 3, 'all files must be copied');
    assert.deepEqual(listFiles(dest), ['t0.mp3', 't1.mp3', 't2.mp3'],
      'copies must land despite the failed stamps');
    for (let i = 0; i < 3; i++) {
      assert.equal(fs.readFileSync(path.join(dest, `t${i}.mp3`), 'utf8'), `data-${i}`);
    }
    // Exactly ONE warning for the whole run (the fidelity probe), not
    // one per file.
    assert.equal(done.fileErrors, 1, 'a single per-run warning, not a per-file flood');
    assert.match(done.sampleErrorMessage, /modification times/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('second run treats landed files as unchanged (no trash+recopy churn)', async () => {
    const root = makeTempRoot('inj2');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const p = path.join(src, `t${i}.mp3`);
      fs.writeFileSync(p, `data-${i}`);
      shiftMtime(p, 1);   // realistic library: files predate the run
    }

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 }, { env: injectEnv });
    forceCopyTimeMtimes(dest);
    // Dest copies now carry copy-time mtimes (a day newer than the
    // source stamps). Without the fidelity probe's fallback, the exact
    // compare would classify every file as changed and trash + recopy
    // the whole tree on this and every following run.
    const run2 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: injectEnv },
    );

    assert.equal(run2.code, 0);
    const done = doneEvent(run2.events);
    assert.equal(done.filesUnchanged, 3, 'landed files must be recognised as unchanged');
    assert.equal(done.filesCopied, 0, 'no recopy churn');
    assert.equal(done.filesTrashed, 0, 'no trash churn');
    assert.equal(fs.existsSync(path.join(dest, '.mstream-trash')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('source edits are still detected in size-based fallback mode', async () => {
    const root = makeTempRoot('inj3');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'grows.mp3'), 'v1');
    fs.writeFileSync(path.join(src, 'stable.mp3'), 'same');
    shiftMtime(path.join(src, 'grows.mp3'), 1);
    shiftMtime(path.join(src, 'stable.mp3'), 1);

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 }, { env: injectEnv });
    forceCopyTimeMtimes(dest);
    // A size-changing edit must be picked up even with unfaithful dest
    // mtimes, while the untouched same-size file must ride the fallback
    // (dest copy-time mtime >= source stamp) instead of churning.
    fs.writeFileSync(path.join(src, 'grows.mp3'), 'v2-bigger');

    const run2 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: injectEnv },
    );
    const done = doneEvent(run2.events);
    assert.equal(done.filesCopied, 1, 'the edited file must be recopied');
    assert.equal(done.filesUnchanged, 1, 'the untouched file must be left alone');
    assert.equal(fs.readFileSync(path.join(dest, 'grows.mp3'), 'utf8'), 'v2-bigger');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('future-stamped source files do not churn in fallback mode', async () => {
    const root = makeTempRoot('inj4');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    const futureFile = path.join(src, 'future.mp3');
    fs.writeFileSync(futureFile, 'wrong-clock-rip');
    shiftMtime(futureFile, -1);   // stamped a day in the future

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 }, { env: injectEnv });
    forceCopyTimeMtimes(dest);
    // The dest copy is "older" than the source stamp and always will be
    // until wall time passes it. Without the future-mtime clamp the file
    // would be trashed + recopied on every run for the next day.
    const run2 = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: injectEnv },
    );
    const done = doneEvent(run2.events);
    assert.equal(done.filesUnchanged, 1, 'future-stamped file must not churn');
    assert.equal(done.filesTrashed, 0);
    assert.equal(fs.existsSync(path.join(dest, '.mstream-trash')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── 3. follow_symlinks reaches the worker ───────────────────────────────────

describe('backup destinations: follow_symlinks wiring', () => {
  let testRoot, dbManager, taskQueue;
  let libFollow, destFollow, destNoFollow;
  let linksWork = true;

  // Same shape as a library whose content sits behind a link: one real
  // file at the root, one dir-link to content OUTSIDE the library root.
  // 'junction' works unprivileged on Windows and degrades to a plain
  // symlink elsewhere. Link creation failure only disables the
  // end-to-end mirror tests — the library dirs and DB rows are created
  // regardless, so the pure-SQL getter assertions always run.
  function makeLinkedLibrary(root, name) {
    const lib = path.join(root, name);
    const outside = path.join(root, `${name}-outside`);
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(lib, 'a.mp3'), 'root-track');
    fs.writeFileSync(path.join(outside, 'b.mp3'), 'linked-track');
    try {
      fs.symlinkSync(outside, path.join(lib, 'linked'), 'junction');
    } catch (_) {
      linksWork = false;   // e.g. EPERM — E2E link tests will skip
    }
    return lib;
  }

  before(async () => {
    testRoot = makeTempRoot('symlink');
    fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(testRoot, 'db'),
        albumArtDirectory: path.join(testRoot, 'art'),
        logsDirectory: path.join(testRoot, 'logs'),
      },
      port: 0,
    }, null, 2));
    const config = await import('../../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    taskQueue = await import('../../src/db/task-queue.js');

    const followRoot = makeLinkedLibrary(testRoot, 'lib-follow');
    const noFollowRoot = makeLinkedLibrary(testRoot, 'lib-nofollow');
    const db = dbManager.getDB();
    db.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 1)`)
      .run('lib-follow', followRoot, 'music');
    db.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`)
      .run('lib-nofollow', noFollowRoot, 'music');
    dbManager.invalidateCache();
    const idFollow = dbManager.getLibraryByName('lib-follow').id;
    const idNoFollow = dbManager.getLibraryByName('lib-nofollow').id;
    destFollow = dbManager.addBackupDestination({
      libraryId: idFollow, destPath: path.join(testRoot, 'dest-follow'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    destNoFollow = dbManager.addBackupDestination({
      libraryId: idNoFollow, destPath: path.join(testRoot, 'dest-nofollow'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
    libFollow = idFollow;
  });

  after(() => {
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  });

  test('every destination getter surfaces the library follow_symlinks flag', () => {
    assert.equal(dbManager.getBackupDestinationById(destFollow).follow_symlinks, 1);
    assert.equal(dbManager.getBackupDestinationById(destNoFollow).follow_symlinks, 0);
    const all = dbManager.getBackupDestinations();
    assert.ok(all.every((d) => d.follow_symlinks !== undefined),
      'getBackupDestinations rows must carry follow_symlinks');
    const byLib = dbManager.getBackupDestinationsByLibrary(libFollow, { enabledOnly: false });
    assert.equal(byLib[0].follow_symlinks, 1);
  });

  test('follow_symlinks=1 library mirrors linked content end-to-end', async (t) => {
    if (!linksWork) { return t.skip('link creation unavailable on this host'); }
    taskQueue.addBackupTask(destFollow, 'manual');
    await waitForIdle(taskQueue);
    assert.equal(dbManager.getBackupHistory(destFollow, 1)[0]?.status, 'success');
    const files = listFiles(path.join(testRoot, 'dest-follow'));
    assert.deepEqual(files, ['a.mp3', path.join('linked', 'b.mp3')],
      'linked content must be mirrored when the library follows symlinks');
  });

  test('follow_symlinks=0 library still skips linked content', async (t) => {
    if (!linksWork) { return t.skip('link creation unavailable on this host'); }
    taskQueue.addBackupTask(destNoFollow, 'manual');
    await waitForIdle(taskQueue);
    assert.equal(dbManager.getBackupHistory(destNoFollow, 1)[0]?.status, 'success');
    const files = listFiles(path.join(testRoot, 'dest-nofollow'));
    assert.deepEqual(files, ['a.mp3'],
      'linked content must be skipped when the library does not follow symlinks');
  });

  async function waitForIdle(tq) {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if (tq.getActiveBackupRun() === null && tq.getQueueLength() === 0 && !tq.isScanning()) { return; }
      await sleep(50);
    }
    throw new Error('Queue did not drain within 60s');
  }
});
