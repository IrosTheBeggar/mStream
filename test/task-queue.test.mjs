/**
 * Integration tests for the unified scan + backup task queue.
 *
 * task-queue.js owns the concurrency rules that keep mstream from
 * shooting itself in the foot — strict-serial dispatch (one task at
 * a time, scan or backup, never concurrent), dedup-on-enqueue so
 * long-running tasks don't accumulate redundant retries from periodic
 * timers, and the cross-task wiring that lets the backup module hook
 * onScanComplete without creating a load-time cycle. The bugs we
 * hit while building the backup feature (a scan-counter leak in the
 * Rust→JS fallback path, a missing dedup that piled up duplicate
 * backups during long scans) all came from this layer, so it gets
 * its own targeted test file.
 *
 * Strategy: import the production modules directly and exercise the
 * public queue API. Real backup workers are spawned (they're cheap
 * — fs ops on a small temp tree). Scan workers are spawned where
 * the test specifically needs cross-category mutex behaviour; tests
 * tolerate scan workers that exit non-zero (e.g. ffmpeg missing in
 * CI) because we're observing queue state, not scanner output.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Test environment helpers ────────────────────────────────────────────────

let envCounter = 0;
function makeTestEnv() {
  const root = path.join(os.tmpdir(), 'mstream-tq-test-' + Date.now() + '-' + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(root, 'db'),
      albumArtDirectory: path.join(root, 'art'),
      logsDirectory: path.join(root, 'logs'),
    },
    port: 0,
  }, null, 2));
  return root;
}

function makeFakeLibrary(root, name, fileCount = 3) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    // Tiny non-audio "mp3" files. The scanner will fail to parse them
    // (no valid frame headers) but exit cleanly with 0 tracks indexed
    // — which is fine for queue-state tests.
    fs.writeFileSync(path.join(dir, `track-${i}.mp3`), Buffer.alloc(2048, i));
  }
  return dir;
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return true; }
    await sleep(intervalMs);
  }
  return false;
}

// Drain the queue completely. Useful between tests so module-level state
// (the activeTask slot + the queue array) returns to zero.
async function waitForIdle(taskQueue) {
  const ok = await waitFor(
    () => taskQueue.getActiveBackupRun() === null
       && taskQueue.getQueueLength() === 0
       && !taskQueue.isScanning(),
    { timeoutMs: 60_000 },
  );
  if (!ok) {
    throw new Error('Queue did not drain within 60s — test likely leaked state');
  }
}

// ── describe: backup-only mutex + dedup ─────────────────────────────────────
//
// Self-contained, no scanner dependency. Verifies the parts of the queue
// behaviour that backup workers alone can exercise.

describe('task-queue: backup-only behaviours', () => {
  let testRoot, dbManager, taskQueue, backupManager, srcLib, libId;

  before(async () => {
    testRoot = makeTestEnv();
    const config = await import('../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../src/db/manager.js');
    dbManager.initDB();
    taskQueue = await import('../src/db/task-queue.js');
    backupManager = await import('../src/backup/manager.js');

    srcLib = makeFakeLibrary(testRoot, 'src', 5);
    dbManager.getDB().prepare(
      `INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`
    ).run('test-lib', srcLib, 'music');
    dbManager.invalidateCache();
    libId = dbManager.getLibraryByName('test-lib').id;
  });

  after(async () => {
    if (taskQueue) { await waitForIdle(taskQueue); }
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
  });

  beforeEach(async () => {
    // Drain anything lingering from the previous test before starting.
    await waitForIdle(taskQueue);
  });

  test('idle state: queue empty, no active run, isScanning false', () => {
    assert.equal(taskQueue.getQueueLength(), 0);
    assert.equal(taskQueue.getActiveBackupRun(), null);
    assert.equal(taskQueue.isScanning(), false);
  });

  test('addBackupTask: first add returns true, duplicate returns false', () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd1-dedup'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    const first = taskQueue.addBackupTask(dest, 'manual');
    const dupe = taskQueue.addBackupTask(dest, 'manual');
    assert.equal(first, true);
    assert.equal(dupe, false, 'second add for same destination must be dropped');
  });

  test('isBackupQueuedOrActive: matches both queue and active state', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd2-active'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    assert.equal(taskQueue.isBackupQueuedOrActive(dest), false);
    taskQueue.addBackupTask(dest, 'manual');
    // Should be queued OR active immediately (synchronous push + synchronous nextTask)
    assert.equal(taskQueue.isBackupQueuedOrActive(dest), true,
      'must be true once enqueued');
    await waitForIdle(taskQueue);
    assert.equal(taskQueue.isBackupQueuedOrActive(dest), false,
      'returns false once drained');
  });

  test('sequential mutex: second backup waits behind first', async () => {
    const dA = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd3-a'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    const dB = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd3-b'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    taskQueue.addBackupTask(dA, 'manual');
    taskQueue.addBackupTask(dB, 'manual');

    // After the synchronous push, exactly one is active and one is queued.
    await sleep(100);
    const active = taskQueue.getActiveBackupRun();
    assert.notEqual(active, null, 'one backup should be active');
    assert.equal(taskQueue.getQueueLength(), 1, 'one backup should be queued');
    assert.ok([dA, dB].includes(active.destinationId));

    await waitForIdle(taskQueue);

    // Both runs should have produced a success row in history.
    const histA = dbManager.getBackupHistory(dA, 1)[0];
    const histB = dbManager.getBackupHistory(dB, 1)[0];
    assert.equal(histA?.status, 'success');
    assert.equal(histB?.status, 'success');
  });

  test('isScanning is true while a backup runs (post-mutex semantic)', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd4-scanning'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    taskQueue.addBackupTask(dest, 'manual');
    await sleep(100);
    assert.equal(taskQueue.isScanning(), true,
      'isScanning returns true while ANY task runs (covers the post-mutex callers)');
    await waitForIdle(taskQueue);
    assert.equal(taskQueue.isScanning(), false);
  });

  test('getActiveBackupRun returns a snapshot copy, not a reference', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd5-copy'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    taskQueue.addBackupTask(dest, 'manual');
    await sleep(100);
    const a = taskQueue.getActiveBackupRun();
    const b = taskQueue.getActiveBackupRun();
    assert.notEqual(a, null);
    assert.notEqual(a, b, 'each call must return a fresh object');
    assert.deepEqual(a, b, 'contents identical');
    // Mutating the returned copy must not affect subsequent reads.
    a.destinationId = -1;
    const c = taskQueue.getActiveBackupRun();
    assert.notEqual(c.destinationId, -1, 'internal state must be insulated');
    await waitForIdle(taskQueue);
  });

  test('getAdminStats returns defensive copies of taskQueue and vpaths', async () => {
    const dA = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd6-defcopy-a'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    const dB = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd6-defcopy-b'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 200,
    });
    taskQueue.addBackupTask(dA, 'manual');
    taskQueue.addBackupTask(dB, 'manual');  // queues
    const stats = taskQueue.getAdminStats();
    const lengthBefore = stats.taskQueue.length;
    // Try to nuke the returned arrays — must not affect internal state.
    stats.taskQueue.length = 0;
    stats.vpaths.push('rogue');
    const stats2 = taskQueue.getAdminStats();
    assert.ok(stats2.taskQueue.length >= lengthBefore || stats2.taskQueue.length > 0,
      'mutating returned taskQueue must not clear internal queue');
    assert.equal(stats2.vpaths.includes('rogue'), false,
      'mutating returned vpaths must not poison internal limiter');
    await waitForIdle(taskQueue);
  });

  test('disabled-while-queued does not run', async () => {
    // Lock the queue with one backup, then enqueue a second and disable it.
    const dHold = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd7-hold'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    const dDisabled = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd7-disabled'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    taskQueue.addBackupTask(dHold, 'manual');
    taskQueue.addBackupTask(dDisabled, 'manual');
    // Disable the queued one before the queue advances to it.
    dbManager.updateBackupDestination(dDisabled, { enabled: false });
    await waitForIdle(taskQueue);

    const hist = dbManager.getBackupHistory(dDisabled, 1)[0];
    assert.equal(hist?.status, 'failed', 'disabled-while-queued task should be marked failed');
    assert.match(hist?.error_message || '', /disabled/i,
      'failure message should mention disabled');
    // dDisabled directory should NOT have been populated.
    const dPath = path.join(testRoot, 'd7-disabled');
    const liveFiles = fs.existsSync(dPath)
      ? fs.readdirSync(dPath).filter((n) => !n.startsWith('.mstream-'))
      : [];
    assert.equal(liveFiles.length, 0, 'disabled dest must stay empty');
  });

  test('triggerForDestination(reason=manual) writes a skipped row when busy', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd8-manual-skip'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    taskQueue.addBackupTask(dest, 'manual');
    await sleep(50);
    const histBefore = dbManager.getBackupHistory(dest, 100).length;
    // Manual trigger of a busy dest → 'skipped' row recorded.
    const skipId = backupManager.triggerForDestination(dest, 'manual');
    assert.equal(typeof skipId, 'number', 'manual skip should return new history row id');
    const histAfter = dbManager.getBackupHistory(dest, 100).length;
    assert.equal(histAfter, histBefore + 1, 'one skipped row recorded');
    await waitForIdle(taskQueue);
  });

  test('triggerForDestination(reason=scheduled) does NOT write a skipped row when busy', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'd9-sched-silent'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    taskQueue.addBackupTask(dest, 'manual');
    await sleep(50);
    const histBefore = dbManager.getBackupHistory(dest, 100).length;
    // 100 scheduled triggers in a tight loop — none should record a row,
    // because 5-minute scheduler ticks shouldn't pile up history during
    // a long-running backup.
    for (let i = 0; i < 100; i++) {
      backupManager.triggerForDestination(dest, 'scheduled');
    }
    await sleep(50);
    const histAfter = dbManager.getBackupHistory(dest, 100).length;
    assert.equal(histAfter, histBefore,
      'scheduled triggers during active run must NOT pile up history rows');
    await waitForIdle(taskQueue);
  });
});

// ── describe: scan + backup mutex ───────────────────────────────────────────
//
// These exercise the cross-category mutex. Real scan workers are spawned;
// the test asserts on QUEUE STATE, not scanner output, so it tolerates
// scanners that exit non-zero (e.g. CI without ffmpeg).

describe('task-queue: scan ↔ backup mutex', () => {
  let testRoot, dbManager, taskQueue, srcLibA, srcLibB, libIdA, libIdB;

  before(async () => {
    testRoot = makeTestEnv();
    const config = await import('../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../src/db/manager.js');
    dbManager.initDB();
    taskQueue = await import('../src/db/task-queue.js');

    srcLibA = makeFakeLibrary(testRoot, 'libA', 3);
    srcLibB = makeFakeLibrary(testRoot, 'libB', 3);
    const db = dbManager.getDB();
    db.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`)
      .run('libA', srcLibA, 'music');
    db.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`)
      .run('libB', srcLibB, 'music');
    dbManager.invalidateCache();
    libIdA = dbManager.getLibraryByName('libA').id;
    libIdB = dbManager.getLibraryByName('libB').id;
  });

  after(async () => {
    if (taskQueue) { await waitForIdle(taskQueue); }
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
  });

  beforeEach(async () => {
    await waitForIdle(taskQueue);
  });

  test('backup running: scan goes to queue', async () => {
    const dest = dbManager.addBackupDestination({
      libraryId: libIdA, destPath: path.join(testRoot, 'mutex-d1'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    taskQueue.addBackupTask(dest, 'manual');
    await sleep(100);
    assert.notEqual(taskQueue.getActiveBackupRun(), null, 'backup should be active');

    // Add a scan; it must NOT start while backup runs.
    taskQueue.scanVPath('libA');
    assert.equal(taskQueue.getQueueLength(), 1,
      'scan should be queued, not running');

    // Inspect the queue contents via getAdminStats — the scan we just
    // added must be there (defensive copy, but contents are observable).
    const stats = taskQueue.getAdminStats();
    const queuedScan = stats.taskQueue.find((t) => t.task === 'scan' && t.vpath === 'libA');
    assert.ok(queuedScan, 'queued scan must appear in getAdminStats output');

    await waitForIdle(taskQueue);
  });

  test('scan dedup: same vpath drops duplicate enqueue', async () => {
    taskQueue.scanVPath('libA');
    const lengthAfterFirst = taskQueue.getQueueLength()
                           + (taskQueue.isScanning() ? 1 : 0);
    // Three more adds — all must be dropped (running or queued already).
    taskQueue.scanVPath('libA');
    taskQueue.scanVPath('libA');
    taskQueue.scanVPath('libA');
    const lengthAfterDupes = taskQueue.getQueueLength()
                           + (taskQueue.isScanning() ? 1 : 0);
    assert.equal(lengthAfterDupes, lengthAfterFirst,
      'duplicate scan adds for the same vpath must not increase pending work');

    await waitForIdle(taskQueue);
  });

  test('scan dedup: different vpaths queue independently', async () => {
    taskQueue.scanVPath('libA');
    taskQueue.scanVPath('libB');
    // Strictly-serial dispatch: libA runs, libB queues. Total
    // pending+running must account for both — different vpaths are
    // independent at the dedup level even though they execute
    // sequentially.
    const stats = taskQueue.getAdminStats();
    const totalPendingPlusRunning = stats.taskQueue.length
                                  + stats.vpaths.length;
    assert.equal(totalPendingPlusRunning, 2,
      'libA and libB are independent — both should be in flight or queued');

    await waitForIdle(taskQueue);
  });

  test('backup queues behind scan when scan is active', async () => {
    // We need to observe queue state in the SAME synchronous tick as the
    // adds, because the test fixture is small (3 dummy mp3 files) and the
    // real scanner can finish in well under a millisecond on a fast disk.
    // addScanTask's synchronous path: enqueues → runs nextTask → which
    // synchronously forks the worker and claims the activeTask slot. By
    // the time addBackupTask runs, the slot is taken even though the
    // worker's close handler hasn't fired yet. canStart() returns false,
    // so the backup is queued, not started.
    const dest = dbManager.addBackupDestination({
      libraryId: libIdA, destPath: path.join(testRoot, 'mutex-d2'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 300,
    });
    taskQueue.scanVPath('libA');
    const queued = taskQueue.addBackupTask(dest, 'manual');

    assert.equal(queued, true, 'addBackupTask returns true when newly enqueued');
    assert.equal(taskQueue.getActiveBackupRun(), null,
      'backup must NOT start in the same tick a scan was just spawned');
    const stats = taskQueue.getAdminStats();
    const queuedBackup = stats.taskQueue.find((t) => t.task === 'backup' && t.destinationId === dest);
    assert.ok(queuedBackup, 'backup task should be in the queue');

    await waitForIdle(taskQueue);
  });
});

// ── describe: onScanComplete callback wiring ────────────────────────────────

describe('task-queue: onScanComplete callback', () => {
  let testRoot, dbManager, taskQueue, srcLib;

  before(async () => {
    testRoot = makeTestEnv();
    const config = await import('../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../src/db/manager.js');
    dbManager.initDB();
    taskQueue = await import('../src/db/task-queue.js');

    srcLib = makeFakeLibrary(testRoot, 'cb-lib', 2);
    dbManager.getDB().prepare(
      `INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`
    ).run('cb-lib', srcLib, 'music');
    dbManager.invalidateCache();
  });

  after(async () => {
    if (taskQueue) {
      // Restore default no-op callback so subsequent describe blocks
      // (if any imports re-run) aren't hooked into our test fn.
      taskQueue.setOnScanCompleteCallback(null);
      await waitForIdle(taskQueue);
    }
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('callback fires once per scan, receiving the scanObj', async () => {
    const calls = [];
    taskQueue.setOnScanCompleteCallback((scanObj) => { calls.push(scanObj); });
    taskQueue.scanVPath('cb-lib');
    await waitForIdle(taskQueue);
    assert.equal(calls.length, 1, 'callback should fire exactly once per scan');
    assert.equal(calls[0].vpath, 'cb-lib', 'scanObj should carry the vpath');
    assert.equal(calls[0].task, 'scan', 'scanObj should carry the task type');
  });

  test('errors thrown in callback do not break queue advancement', async () => {
    let queueAdvanced = false;
    taskQueue.setOnScanCompleteCallback(() => {
      throw new Error('test-thrown error');
    });
    taskQueue.scanVPath('cb-lib');
    await waitForIdle(taskQueue);
    queueAdvanced = taskQueue.getQueueLength() === 0 && !taskQueue.isScanning();
    assert.equal(queueAdvanced, true,
      'queue must drain even if the callback throws');
  });
});

// ── describe: resumable migration-rescan epoch id ───────────────────────────
//
// The .rescan-pending marker triggers a force rescan after a
// rescanRequired migration. The bug: the old boot path used a fresh scan
// id every restart, so an interrupted rescan restarted from file zero and
// the marker never cleared — on a large library it re-scanned forever.
// The fix stores a STABLE scan id in the marker and reuses it across
// restarts; the scanner skips rows already stamped with it. This verifies
// the id is assigned once and stays stable (resolveRescanEpochId is the
// coordination point — config/db-free, so it's tested in isolation).

describe('task-queue: resumable migration-rescan epoch id', () => {
  let taskQueue, tmpDir;

  before(async () => {
    taskQueue = await import('../src/db/task-queue.js');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-epoch-'));
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ } });

  test('assigns a stable id into an empty marker and reuses it across restarts', () => {
    const marker = path.join(tmpDir, '.rescan-pending-a');
    fs.writeFileSync(marker, '');                       // legacy empty marker
    const first = taskQueue.resolveRescanEpochId(marker);
    assert.match(first, /^rescan-/, 'should assign a rescan-* id');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), first,
      'assigned id must be persisted to the marker');
    // A second call simulates the next boot — it MUST return the same id,
    // which is what lets the scanner resume instead of restarting at zero.
    assert.equal(taskQueue.resolveRescanEpochId(marker), first,
      'epoch id must be stable across restarts');
  });

  test('honours an id already present in the marker', () => {
    const marker = path.join(tmpDir, '.rescan-pending-b');
    fs.writeFileSync(marker, 'rescan-PREEXIST\n');
    assert.equal(taskQueue.resolveRescanEpochId(marker), 'rescan-PREEXIST');
  });

  test('two independent markers get distinct ids', () => {
    const m1 = path.join(tmpDir, '.rescan-pending-c1');
    const m2 = path.join(tmpDir, '.rescan-pending-c2');
    fs.writeFileSync(m1, '');
    fs.writeFileSync(m2, '');
    assert.notEqual(taskQueue.resolveRescanEpochId(m1), taskQueue.resolveRescanEpochId(m2));
  });
});

// ── describe: boot rescan marker lifecycle ──────────────────────────────────
//
// Covers the two marker-lifecycle fixes:
//   #3 — with zero libraries, rescanAll() enqueues nothing, so no scan ever
//        closes to trigger the drain check. The marker must still clear
//        (runAfterBoot calls the drain check inline) instead of lingering.
//   #2 — a boot rescan that completes successfully clears the marker (and,
//        by construction, onScanClose must not mis-flag a successful scan
//        as failed, which would wrongly keep the marker forever).
describe('task-queue: boot rescan marker lifecycle', () => {
  let testRoot, config, dbManager, taskQueue, markerPath;

  before(async () => {
    testRoot = makeTestEnv();
    config = await import('../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    // Fire the boot rescan immediately and leave no periodic timer behind.
    config.program.scanOptions.bootScanDelay = 0;
    config.program.scanOptions.scanInterval = 0;
    dbManager = await import('../src/db/manager.js');
    dbManager.initDB();
    // Drop any library cache carried over from earlier describe blocks
    // (the manager is a singleton) so this env genuinely has zero libraries.
    dbManager.invalidateCache();
    taskQueue = await import('../src/db/task-queue.js');
    markerPath = path.join(testRoot, 'db', '.rescan-pending');
  });

  after(async () => {
    if (taskQueue) { await waitForIdle(taskQueue); }
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  });

  test('zero libraries: marker is cleared (no scan closes to trigger the drain check)', async () => {
    fs.writeFileSync(markerPath, 'rescan-zerolib\n');
    assert.ok(fs.existsSync(markerPath));

    taskQueue.runAfterBoot();
    // bootScanDelay=0 → the boot-rescan setTimeout fires next tick; with no
    // libraries it enqueues nothing and clears the marker inline.
    const cleared = await waitFor(() => !fs.existsSync(markerPath), { timeoutMs: 10_000 });
    assert.ok(cleared, '.rescan-pending must clear when there are no libraries to scan');
  });

  test('successful boot rescan clears the marker', async () => {
    const lib = makeFakeLibrary(testRoot, 'marker-lib', 3);
    dbManager.getDB().prepare(
      `INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`
    ).run('marker-lib', lib, 'music');
    dbManager.invalidateCache();

    fs.writeFileSync(markerPath, 'rescan-happy\n');
    assert.ok(fs.existsSync(markerPath));

    taskQueue.runAfterBoot();
    await waitForIdle(taskQueue);
    const cleared = await waitFor(() => !fs.existsSync(markerPath), { timeoutMs: 30_000 });
    assert.ok(cleared, 'a completed boot rescan must clear .rescan-pending');
  });
});
