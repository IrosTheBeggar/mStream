/**
 * Backup low-severity cleanup + deferred decisions (audit batch 6).
 *
 * Four describes:
 *   - Worker mirror semantics: FAT/DST ±1h mtime-skew carve-out, orphan-dir
 *     bookkeeping cleanup, empty-dir mirror stability, source-root
 *     .mstream-trash filtering (walk AND pre-flight guard in lockstep).
 *   - Long paths: trash rename past Windows MAX_PATH (worker) and pruning
 *     such buckets (manager sweep).
 *   - Scheduler decisions: missedDailyWindow / shouldTriggerScheduled
 *     matrix incl. the anacron catch-up and its documented
 *     double-run-on-catch-up-day consequence.
 *   - Crash recovery: markStaleBackupRunsFailed flip + exclusion.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'backup', 'worker.mjs');
// Forward slashes: NODE_OPTIONS eats backslashes on Windows.
const FAIL_UTIMES = path.join(REPO_ROOT, 'test', 'fixtures', 'fail-utimes.cjs').replace(/\\/g, '/');

let envCounter = 0;
function makeTempRoot(tag) {
  const rand = crypto.randomBytes(4).toString('hex');
  const root = path.join(os.tmpdir(), `mstream-b6-${tag}-${rand}-` + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Mirror of the worker/manager \\?\ opt-in so the TEST can create and
// inspect paths past MAX_PATH on Windows hosts without LongPathsEnabled.
function longPath(p) {
  if (process.platform !== 'win32') { return p; }
  const abs = path.resolve(p);
  if (abs.startsWith('\\\\?\\')) { return abs; }
  if (abs.startsWith('\\\\')) { return '\\\\?\\UNC\\' + abs.slice(2); }
  return '\\\\?\\' + abs;
}

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
      const events = out.split(/\r?\n/).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
      resolve({ code, events, stderr: errOut });
    });
  });
}
const doneEvent = (events) => events.find((e) => e.event === 'done') || null;

// ── Worker mirror semantics ─────────────────────────────────────────────────

describe('batch6 worker: DST skew, orphan bookkeeping, empty dirs, source trash', () => {
  test('dest mtimes shifted by exactly ±1h (FAT DST skew) read as unchanged; ±30min does not', async () => {
    const root = makeTempRoot('dst');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(src, { recursive: true });
      for (const n of ['plus.mp3', 'minus.mp3', 'ctrl.mp3']) {
        fs.writeFileSync(path.join(src, n), `data-${n}`);
      }

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      assert.equal(doneEvent(first.events).filesCopied, 3);

      // Simulate the post-DST-transition read: FAT stores local time, so
      // every stored mtime comes back shifted by exactly one hour.
      const shift = (name, deltaSec) => {
        const p = path.join(dest, name);
        const st = fs.statSync(p);
        fs.utimesSync(p, st.atime, new Date(st.mtimeMs + deltaSec * 1000));
      };
      shift('plus.mp3', 3600);
      shift('minus.mp3', -3600);
      shift('ctrl.mp3', 1800);   // NOT a DST offset — must still recopy

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(second.code, 0);
      const done = doneEvent(second.events);
      assert.equal(done.filesUnchanged, 2,
        'exact ±3600s deltas are FAT DST skew and must not trigger a recopy');
      assert.equal(done.filesCopied, 1, 'the ±30min control file is genuinely changed');
      assert.equal(done.filesTrashed, 1, 'only the control file gets trash+recopied');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('untrusted-mtime destinations honour the ±1h carve-out too (dest older by exactly 1h)', async () => {
    const root = makeTempRoot('dstuntrusted');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'a.mp3'), 'data');
      // Backdate the source well past tolerance so only the carve-out
      // can save the shifted dest copy below.
      const past = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      fs.utimesSync(path.join(src, 'a.mp3'), past, past);

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      assert.equal(doneEvent(first.events).filesCopied, 1);

      // Dest copy reads exactly 1h OLDER than the source (the DST-skew
      // direction the untrusted branch's dest-not-older rule rejects).
      const st = fs.statSync(path.join(dest, 'a.mp3'));
      fs.utimesSync(path.join(dest, 'a.mp3'), st.atime, new Date(st.mtimeMs - 3600 * 1000));

      // fail-utimes forces the fidelity probe to fail → untrusted branch.
      const second = await runWorker(
        { sourcePath: src, destPath: dest, retentionDays: 30 },
        { env: { NODE_OPTIONS: `--require "${FAIL_UTIMES}"` } });
      assert.equal(second.code, 0);
      const done = doneEvent(second.events);
      assert.equal(done.filesUnchanged, 1,
        'exact -3600s on an mtime-dropping destination is DST skew, not a change');
      assert.equal(done.filesCopied, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('orphan dir with leftover tmp/partial bookkeeping is fully removed, bookkeeping unlinked not trashed', async () => {
    const root = makeTempRoot('orphanbk');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'keep.mp3'), 'keep');
      fs.writeFileSync(path.join(src, 'sub', 'gone.mp3'), 'gone');

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);

      // A killed previous worker left bookkeeping behind, then the user
      // removed the whole directory from the source.
      fs.writeFileSync(path.join(dest, 'sub', '.mstream-tmp-deadbeef'), 'x');
      fs.writeFileSync(path.join(dest, 'sub', '.mstream-partial-deadbeef-1-2-v2'), 'x');
      fs.rmSync(path.join(src, 'sub'), { recursive: true, force: true });

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(second.code, 0);
      const done = doneEvent(second.events);
      assert.equal(done.fileErrors, 0);
      assert.equal(done.filesTrashed, 1,
        'only the real file counts as trashed — bookkeeping must not inflate the count');
      assert.ok(!fs.existsSync(path.join(dest, 'sub')),
        'the orphan dir must be fully removed, not survive as a ghost holding a stale tmp');

      // The deletion log holds the user file and ONLY the user file.
      // (Bucket name discovered by listing, not recomputed — the worker
      // stamps it at trash time, and recomputing here would flake if a
      // UTC midnight fell between the run and this assertion.)
      const buckets = fs.readdirSync(path.join(dest, '.mstream-trash'));
      assert.equal(buckets.length, 1);
      assert.deepEqual(fs.readdirSync(path.join(dest, '.mstream-trash', buckets[0], 'sub')).sort(), ['gone.mp3'],
        'never-finalised bookkeeping must be unlinked, not hauled into the deletion log');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a hand-made DIRECTORY wearing a bookkeeping prefix inside an orphan dir trashes cleanly, no error loop', async () => {
    const root = makeTempRoot('bkdir');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'keep.mp3'), 'keep');
      fs.writeFileSync(path.join(src, 'sub', 'gone.mp3'), 'gone');

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);

      // The worker only ever creates prefixed FILES — a prefixed
      // DIRECTORY is hand-made user content. fs.unlink on it is
      // EISDIR/EPERM; without the dirent-type check this became a
      // permanent per-run fileError plus an unremovable ghost dir.
      fs.mkdirSync(path.join(dest, 'sub', '.mstream-partial-fakedir'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'sub', '.mstream-partial-fakedir', 'inner.mp3'), 'x');
      fs.rmSync(path.join(src, 'sub'), { recursive: true, force: true });

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(second.code, 0);
      const done = doneEvent(second.events);
      assert.equal(done.fileErrors, 0, 'must not error-loop on a directory it cannot unlink');
      assert.ok(!fs.existsSync(path.join(dest, 'sub')),
        'the orphan dir (including the fake bookkeeping dir) must be fully removed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an empty source directory keeps a stable dest mirror across runs (no create/delete flip-flop)', async () => {
    const root = makeTempRoot('emptydir');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'placeholder-album'), { recursive: true });
      fs.writeFileSync(path.join(src, 'a.mp3'), 'a');

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      assert.ok(fs.existsSync(path.join(dest, 'placeholder-album')), 'run 1 mirrors the empty dir');

      // Pre-fix, run 2's matched-pair prune rmdir'd it, and run 3
      // recreated it — permanently oscillating.
      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(second.code, 0);
      assert.ok(fs.existsSync(path.join(dest, 'placeholder-album')),
        'run 2 must leave the mirror of an existing (empty) source dir in place');
      const done = doneEvent(second.events);
      assert.equal(done.filesCopied, 0);
      assert.equal(done.filesTrashed, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('source-root .mstream-trash is skipped (not mirrored into the dest trash), deeper ones still mirror', async () => {
    const root = makeTempRoot('srctrash');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, '.mstream-trash', '2026-01-01'), { recursive: true });
      fs.writeFileSync(path.join(src, '.mstream-trash', '2026-01-01', 'old.mp3'), 'old');
      fs.mkdirSync(path.join(src, 'sub', '.mstream-trash'), { recursive: true });
      fs.writeFileSync(path.join(src, 'sub', '.mstream-trash', 'legit.mp3'), 'legit');
      fs.writeFileSync(path.join(src, 'real.mp3'), 'real');

      const { code, events, stderr } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(code, 0);
      assert.equal(doneEvent(events).fileErrors, 0, 'the skip is a log-only warning, not a per-run failure');
      assert.match(stderr, /source root contains/i);

      assert.ok(fs.existsSync(path.join(dest, 'real.mp3')));
      assert.ok(!fs.existsSync(path.join(dest, '.mstream-trash', '2026-01-01')),
        'the source trash bucket must NOT commingle with the dest trash, where the sweep would delete it');
      assert.ok(fs.existsSync(path.join(dest, 'sub', '.mstream-trash', 'legit.mp3')),
        'a .mstream-trash folder DEEPER in the tree is legitimate user content and mirrors normally');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a source containing ONLY a trash bucket reads as empty to the guard — dest is refused, not swept', async () => {
    const root = makeTempRoot('trashonly');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, '.mstream-trash', '2026-01-01'), { recursive: true });
      fs.writeFileSync(path.join(src, '.mstream-trash', '2026-01-01', 'x.mp3'), 'x');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'existing.mp3'), 'precious');

      // If the walk filters the source-root trash but the pre-flight
      // guard doesn't (or vice versa), this source passes the guard while
      // the walk sees nothing — and sweeps the whole destination. The
      // two MUST stay in lockstep.
      const { code } = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(code, 1, 'zero mirrorable files must refuse the run');
      assert.ok(fs.existsSync(path.join(dest, 'existing.mp3')), 'the dest must be untouched');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Long paths (Windows MAX_PATH) ───────────────────────────────────────────

describe('batch6 long paths: trash rename and sweep past MAX_PATH', () => {
  // Pin the LIVE file path to exactly LIVE_LEN chars so that ONLY the
  // trash path (+26: '.mstream-trash/YYYY-MM-DD/') crosses 260 — the
  // code under test. Everything the worker touches un-prefixed stays
  // inside every strict Win32 limit even with LongPathsEnabled=0:
  // live dir <= 231 (< 248 CreateDirectoryW), atomicCopy's tmp sibling
  // <= ~258 (< 260), live file 237 — while the trash target lands at
  // 263. An earlier version let the live path float up to 255, which
  // pushed the UNPREFIXED tmp sibling past 260 and would have failed
  // run 1 on exactly the hosts the fix targets.
  const LIVE_LEN = 237;
  function buildDeepRel(destRoot) {
    const SEG = 's'.repeat(16);
    let rel = '';
    // Leave room for a separator + a >=5-char filename after the segments.
    for (;;) {
      const next = rel ? path.join(rel, SEG) : SEG;
      if (path.join(destRoot, next).length + 1 + 5 > LIVE_LEN) { break; }
      rel = next;
    }
    const dirLen = path.join(destRoot, rel).length;
    const nameLen = LIVE_LEN - dirLen - 1;
    if (!rel || nameLen < 5) { return null; }   // pathologically long tmpdir
    return { rel, fileName: 'f'.repeat(nameLen - 4) + '.mp3' };
  }

  test('a changed file whose trash path exceeds 260 chars is still trashed and refreshed', async (t) => {
    const root = makeTempRoot('lp');
    try {
      const src = path.join(root, 'src');
      const dest = path.join(root, 'dest');
      const deep = buildDeepRel(dest);
      if (!deep) { t.skip('tmpdir too long to pin a near-MAX_PATH live path'); return; }
      const { rel, fileName } = deep;
      assert.equal(path.join(dest, rel, fileName).length, LIVE_LEN);
      fs.mkdirSync(longPath(path.join(src, rel)), { recursive: true });
      const srcFile = path.join(src, rel, fileName);
      fs.writeFileSync(longPath(srcFile), 'v1');
      // Backdate so the v2 edit is unambiguously newer than tolerance.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(longPath(srcFile), past, past);

      const first = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(first.code, 0);
      assert.equal(doneEvent(first.events).filesCopied, 1);

      fs.writeFileSync(longPath(srcFile), 'v2-changed');

      const second = await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
      assert.equal(second.code, 0);
      const done = doneEvent(second.events);
      assert.equal(done.fileErrors, 0, 'the near-MAX_PATH trash rename must not fail');
      assert.equal(done.filesTrashed, 1);
      assert.equal(done.filesCopied, 1);

      // Bucket discovered by listing (not date-recomputed — avoids the
      // UTC-midnight-rollover flake).
      const buckets = fs.readdirSync(path.join(dest, '.mstream-trash'));
      assert.equal(buckets.length, 1);
      const trashed = path.join(dest, '.mstream-trash', buckets[0], rel, fileName);
      assert.ok(trashed.length > 260, `test must actually exceed MAX_PATH (got ${trashed.length})`);
      assert.ok(fs.existsSync(longPath(trashed)), 'the old copy must land in the deletion log');
      assert.equal(fs.readFileSync(longPath(path.join(dest, rel, fileName)), 'utf8'), 'v2-changed');
    } finally {
      fs.rmSync(longPath(root), { recursive: true, force: true });
    }
  });

  test('the retention sweep can prune a bucket containing >MAX_PATH entries', async (t) => {
    const root = makeTempRoot('lpsweep');
    try {
      const dest = path.join(root, 'dest');
      const deep = buildDeepRel(dest);
      if (!deep) { t.skip('tmpdir too long to pin a near-MAX_PATH live path'); return; }
      const { rel, fileName } = deep;
      const bucket = path.join(dest, '.mstream-trash', '2020-01-01');
      fs.mkdirSync(longPath(path.join(bucket, rel)), { recursive: true });
      fs.writeFileSync(longPath(path.join(bucket, rel, fileName)), 'old');

      const manager = await import('../../src/backup/manager.js');
      await manager.sweepDestTrash({ dest_path: dest, retention_days: 7 });
      assert.ok(!fs.existsSync(longPath(bucket)),
        'a years-old bucket must be pruned even when its contents exceed MAX_PATH');
    } finally {
      fs.rmSync(longPath(root), { recursive: true, force: true });
    }
  });
});

// ── Scheduler decisions ─────────────────────────────────────────────────────

describe('batch6 scheduler: missed-window catch-up decision', () => {
  let manager;
  before(async () => { manager = await import('../../src/backup/manager.js'); });

  // Build a backup_history-shaped row whose started_at (stored UTC)
  // corresponds to the given LOCAL wall-clock moment — keeps every
  // assertion TZ-independent.
  const rowAtLocal = (y, mo, d, h, mi = 0) =>
    ({ started_at: new Date(y, mo - 1, d, h, mi).toISOString().slice(0, 19).replace('T', ' ') });
  // "now" for all cases: 2026-07-10 09:00 local, scheduled hour 23.
  const NOW = new Date(2026, 6, 10, 9, 0, 0);
  const DEST = { daily_at_hour: 23 };

  test('missedDailyWindow: compares against yesterday\'s window MOMENT, keyed on finish time', () => {
    assert.equal(manager.missedDailyWindow(null, 23, NOW), false, 'fresh destination waits for its first window');
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 10, 1), 23, NOW), false, 'ran today');
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 9, 23), 23, NOW), false, 'served yesterday\'s window — normal cadence');
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 8, 23), 23, NOW), true, 'a whole window was missed');
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 1, 23), 23, NOW), true, 'off for a week');
    // The always-off-at-window machine: yesterday's attempt was a MORNING
    // catch-up (hour 8), so yesterday's 23:00 window was ALSO missed. A
    // date-only comparison called this served and halved the cadence to
    // every other day.
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 9, 8), 23, NOW), true,
      'a morning catch-up does not serve that evening\'s window — cadence stays daily');
    // Marathon run: started days ago but FINISHED after yesterday's
    // window — it covered everything up to its finish; no pointless
    // catch-up walk right behind it.
    const marathon = {
      started_at: rowAtLocal(2026, 7, 8, 23).started_at,
      finished_at: rowAtLocal(2026, 7, 10, 6).started_at,
    };
    assert.equal(manager.missedDailyWindow(marathon, 23, NOW), false,
      'a run finishing this morning covered yesterday\'s window');
    // Same run still in flight (no finished_at): reads as missed, which
    // is harmless — the dedup gate drops the trigger while it runs.
    assert.equal(manager.missedDailyWindow(rowAtLocal(2026, 7, 8, 23), 23, NOW), true);
  });

  test('before the scheduled hour: strict wait normally, catch-up when a window was missed', () => {
    // 09:00 < 23 — normally nothing fires.
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 9, 23), NOW), false,
      'yesterday ran fine — wait for tonight');
    assert.equal(manager.shouldTriggerScheduled(DEST, null, NOW), false,
      'a freshly-created destination must not fire the moment it is saved');
    // Server was off during last night's window: catch up right now.
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 8, 23), NOW), true,
      'missed window triggers promptly after boot instead of waiting for tonight');
    // And the machine that is off EVERY night still gets one backup per
    // day: yesterday's morning catch-up doesn't mask last night's miss.
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 9, 8), NOW), true,
      'daily cadence holds for always-off-at-window machines');
  });

  test('at/after the scheduled hour: once per local day, catch-up day runs twice (documented)', () => {
    const tonight = new Date(2026, 6, 10, 23, 5, 0);
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 9, 23), tonight), true,
      'regular nightly fire');
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 10, 23, 2), tonight), false,
      'already served tonight');
    // The 09:00 catch-up run started before daily_at_hour, so it does not
    // satisfy scheduledWindowServed — the regular window fires again
    // tonight. Accepted consequence: the second run walks an
    // already-synced mirror.
    assert.equal(manager.shouldTriggerScheduled(DEST, rowAtLocal(2026, 7, 10, 9), tonight), true,
      'catch-up day double-run is the documented trade-off');
    assert.equal(manager.shouldTriggerScheduled({ daily_at_hour: null }, null, tonight), false,
      'no scheduled hour, never fires');
  });
});

// ── Crash recovery ──────────────────────────────────────────────────────────

describe('batch6 db: markStaleBackupRunsFailed crash recovery', () => {
  let testRoot, dbManager, destId;

  before(async () => {
    testRoot = makeTempRoot('crashdb');
    fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
      storage: { dbDirectory: path.join(testRoot, 'db'), albumArtDirectory: path.join(testRoot, 'art'), logsDirectory: path.join(testRoot, 'logs') },
      port: 0,
    }));
    const config = await import('../../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    const src = path.join(testRoot, 'lib');
    fs.mkdirSync(src, { recursive: true });
    dbManager.getDB().prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)`)
      .run('lib', src, 'music');
    dbManager.invalidateCache();
    destId = dbManager.addBackupDestination({
      libraryId: dbManager.getLibraryByName('lib').id, destPath: path.join(testRoot, 'dest'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
  });

  after(() => {
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  });

  test('stale running rows flip to failed; the reboot-surviving run is spared', () => {
    const mkRunning = () => dbManager.createBackupRunRow({
      destinationId: destId, triggerReason: 'manual', status: 'running',
    });
    const stale1 = mkRunning();
    const stale2 = mkRunning();
    const live = mkRunning();   // the reboot()-surviving worker's row

    const flipped = dbManager.markStaleBackupRunsFailed(live);
    assert.equal(flipped, 2);

    for (const id of [stale1, stale2]) {
      const row = dbManager.getBackupHistoryRowById(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error_message, 'Interrupted by server restart');
      assert.ok(row.finished_at, 'recovered rows must be finalised');
    }
    assert.equal(dbManager.getBackupHistoryRowById(live).status, 'running',
      'the excluded (genuinely alive) run must be left running');

    // Cold boot (no exclusion): everything running flips.
    assert.equal(dbManager.markStaleBackupRunsFailed(null), 1);
    assert.equal(dbManager.getBackupHistoryRowById(live).status, 'failed');
  });
});
