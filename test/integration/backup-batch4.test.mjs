/**
 * Backup lifecycle / scheduler / error-surfacing (audit batch 4).
 *
 * Split into three describes:
 *   - DB layer: finished_at timestamp format, history pruning cap,
 *     'partial' status excluded from getLastSuccessfulBackup.
 *   - Scheduler: the pure scheduledWindowServed() day/hour dedup
 *     decision (one attempt per local day, any-status, midnight
 *     straddle) and the trash-sweep off-by-one + retention-0 legacy
 *     drain.
 *   - Worker: 'partial' status on per-file errors, the torn-copy
 *     guard, and the expanded default temp-file excludes.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(REPO_ROOT, 'src', 'backup', 'worker.mjs');

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T/;                 // JS toISOString shape (bad)
const SQLITE_DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;   // datetime('now') shape (good)

let envCounter = 0;
function makeTempRoot(tag) {
  const root = path.join(os.tmpdir(), `mstream-b4-${tag}-` + Date.now() + '-' + (envCounter++));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
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
const liveNames = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir)
  .filter((n) => n !== '.mstream-trash' && !n.startsWith('.mstream-tmp-') && !n.startsWith('.mstream-partial-'))
  .sort() : []);

// ── DB layer ────────────────────────────────────────────────────────────────

describe('batch4 db: history rows', () => {
  let testRoot, dbManager, destId;

  before(async () => {
    testRoot = makeTempRoot('db');
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
    const libId = dbManager.getLibraryByName('lib').id;
    destId = dbManager.addBackupDestination({
      libraryId: libId, destPath: path.join(testRoot, 'dest'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true,
      excludeGlobs: [], interFileDelayMs: 0,
    });
  });

  after(() => {
    if (dbManager) { dbManager.close(); }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  });

  test("pre-finished rows write finished_at in datetime('now') format, not ISO", () => {
    const id = dbManager.createBackupRunRow({
      destinationId: destId, triggerReason: 'manual', status: 'skipped', errorMessage: 'busy',
    });
    const row = dbManager.getBackupHistoryRowById(id);
    assert.match(row.finished_at, SQLITE_DT,
      "skipped rows must use the SQLite datetime format so the UI's replace(' ','T')+'Z' parse works");
    assert.doesNotMatch(row.finished_at, ISO_LIKE);
    // Round-trips to a valid Date through the consumer normalisation.
    const parsed = new Date(row.finished_at.replace(' ', 'T') + 'Z');
    assert.ok(!Number.isNaN(parsed.getTime()), 'normalised timestamp must be a valid Date');
  });

  test("running rows leave finished_at NULL", () => {
    const id = dbManager.createBackupRunRow({ destinationId: destId, triggerReason: 'manual', status: 'running' });
    assert.equal(dbManager.getBackupHistoryRowById(id).finished_at, null);
  });

  test("'partial' is not counted as the last successful run", () => {
    const db = dbManager.getDB();
    const ins = db.prepare(`INSERT INTO backup_history (destination_id, started_at, finished_at, status, trigger_reason, files_copied)
                            VALUES (?, datetime('now'), datetime('now'), ?, 'manual', ?)`);
    ins.run(destId, 'success', 10);
    const partialId = ins.run(destId, 'partial', 5).lastInsertRowid;
    const lastSuccess = dbManager.getLastSuccessfulBackup(destId);
    assert.equal(lastSuccess.files_copied, 10, 'the partial run must be skipped by getLastSuccessfulBackup');
    // getLastBackupRun (used by the scheduler dedup) DOES see it.
    assert.equal(Number(dbManager.getLastBackupRun(destId).id), Number(partialId));
  });

  test("'partial' DOES count as the progress denominator (getLastCountedBackupBefore)", () => {
    const db = dbManager.getDB();
    const d2 = dbManager.addBackupDestination({
      libraryId: dbManager.getLibraryByName('lib').id, destPath: path.join(testRoot, 'dest-prog'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true, excludeGlobs: [], interFileDelayMs: 0,
    });
    const ins = db.prepare(`INSERT INTO backup_history (destination_id, started_at, finished_at, status, trigger_reason, files_copied)
                            VALUES (?, datetime('now'), datetime('now'), ?, 'manual', ?)`);
    // A destination whose only prior run was 'partial' (one perpetually
    // failing file) must still get a progress denominator — otherwise the
    // live bar shows an indeterminate spinner forever.
    const partialId = ins.run(d2, 'partial', 42).lastInsertRowid;
    const currentRun = ins.run(d2, 'running', 0).lastInsertRowid;
    const prev = dbManager.getLastCountedBackupBefore(d2, Number(currentRun));
    assert.ok(prev, 'a prior partial run must serve as the progress denominator');
    assert.equal(Number(prev.id), Number(partialId));
    assert.equal(prev.files_copied, 42);
  });

  test('pruneBackupHistory never deletes a live running row', () => {
    const d3 = dbManager.addBackupDestination({
      libraryId: dbManager.getLibraryByName('lib').id, destPath: path.join(testRoot, 'dest-prune'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true, excludeGlobs: [], interFileDelayMs: 0,
    });
    // Insert a running row first (lowest id), then push >500 finished rows
    // behind it. The running row must survive despite being oldest.
    const runningId = dbManager.createBackupRunRow({ destinationId: d3, triggerReason: 'manual', status: 'running' });
    for (let i = 0; i < 510; i++) {
      dbManager.createBackupRunRow({ destinationId: d3, triggerReason: 'manual', status: 'failed', errorMessage: 'x' });
    }
    assert.ok(dbManager.getBackupHistoryRowById(runningId),
      'the live running row must never be pruned, even as the oldest row past the cap');
  });

  test('history is pruned to the 500-row cap per destination', () => {
    const db = dbManager.getDB();
    // Use a fresh destination so a leftover 'running' row from an earlier
    // test (never pruned by design) doesn't skew the count.
    const capDest = dbManager.addBackupDestination({
      libraryId: dbManager.getLibraryByName('lib').id, destPath: path.join(testRoot, 'dest-cap'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true, excludeGlobs: [], interFileDelayMs: 0,
    });
    // createBackupRunRow prunes on every insert; push well past the cap.
    for (let i = 0; i < 560; i++) {
      dbManager.createBackupRunRow({ destinationId: capDest, triggerReason: 'manual', status: 'failed', errorMessage: 'x' });
    }
    const count = db.prepare('SELECT COUNT(*) c FROM backup_history WHERE destination_id = ?').get(capDest).c;
    assert.equal(count, 500, `finished-run history must be capped at exactly 500, got ${count}`);
    // The cap keeps the NEWEST rows — the latest insert must survive.
    const newest = dbManager.getLastBackupRun(capDest);
    assert.ok(newest, 'the most recent row must be retained');
  });
});

// ── Scheduler decision + trash sweep ─────────────────────────────────────────

describe('batch4 scheduler: window-served decision', () => {
  let manager;
  // Fixed reference instant, expressed in LOCAL time so the test is
  // TZ-independent: build the SQLite-UTC string from a known local Date.
  const toSqliteUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

  before(async () => {
    // manager.js imports db/manager + task-queue; a prior describe already
    // set config up in this process, so the singleton import is ready.
    manager = await import('../../src/backup/manager.js');
  });

  test('null last run → window not served (fires)', () => {
    assert.equal(manager.scheduledWindowServed(null, 3, new Date()), false);
  });

  test('a run earlier today at/after the hour → served (skips), any status', () => {
    const now = new Date(2026, 6, 10, 14, 0, 0);           // local 14:00
    const ranAt = new Date(2026, 6, 10, 13, 0, 0);          // local 13:00 today, hour 13 >= 3
    for (const status of ['success', 'failed', 'partial', 'running']) {
      assert.equal(
        manager.scheduledWindowServed({ started_at: toSqliteUtc(ranAt), status }, 3, now),
        true,
        `${status} run earlier today must count as served — no per-tick retry`);
    }
  });

  test('a run yesterday → not served (fires today)', () => {
    const now = new Date(2026, 6, 10, 14, 0, 0);
    const ranAt = new Date(2026, 6, 9, 23, 0, 0);
    assert.equal(manager.scheduledWindowServed({ started_at: toSqliteUtc(ranAt), status: 'success' }, 3, now), false);
  });

  test('midnight-straddle: a run that slipped to 00:0x does NOT consume a daily_at_hour=23 slot', () => {
    const now = new Date(2026, 6, 10, 23, 30, 0);          // local 23:30, window hour 23 open
    const ranAt = new Date(2026, 6, 10, 0, 5, 0);          // local 00:05 today, hour 0 < 23
    assert.equal(
      manager.scheduledWindowServed({ started_at: toSqliteUtc(ranAt), status: 'success' }, 23, now),
      false,
      'a run started before the scheduled hour must not satisfy the window — else the 23:00 daily silently skips');
  });

  test('a run today at exactly the scheduled hour → served', () => {
    const now = new Date(2026, 6, 10, 23, 30, 0);
    const ranAt = new Date(2026, 6, 10, 23, 5, 0);         // hour 23 >= 23
    assert.equal(manager.scheduledWindowServed({ started_at: toSqliteUtc(ranAt), status: 'failed' }, 23, now), true);
  });
});

describe('batch4 scheduler: trash retention sweep', () => {
  let manager;
  before(async () => { manager = await import('../../src/backup/manager.js'); });

  // Build a dest dir with dated trash buckets and run the real sweep.
  function seedTrash(retentionDays, bucketDates) {
    const root = makeTempRoot('trash');
    const dest = path.join(root, 'dest');
    const trash = path.join(dest, '.mstream-trash');
    for (const d of bucketDates) {
      fs.mkdirSync(path.join(trash, d), { recursive: true });
      fs.writeFileSync(path.join(trash, d, 'old.mp3'), 'x');
    }
    return { root, dest, retentionDays };
  }
  const ymd = (daysAgo) => {
    const ms = Date.UTC(2026, 6, 10) - daysAgo * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  };

  test('retention_days=1 keeps a bucket for its full window (off-by-one fix)', async () => {
    // Pin "now" to 2026-07-10T12:00Z so the arithmetic is deterministic.
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 6, 10, 12, 0, 0);
    try {
      // Yesterday's bucket (2026-07-09): its youngest file (trashed
      // 07-09 23:59) is ~12h old — well within a 1-day window. The old
      // start-of-bucket comparison pruned it the moment 07-09 fell past
      // the cutoff, shorting those files.
      const { root, dest, retentionDays } = seedTrash(1, [ymd(1), ymd(3)]);
      await manager.sweepDestTrash({ dest_path: dest, retention_days: retentionDays });
      assert.ok(fs.existsSync(path.join(dest, '.mstream-trash', ymd(1))),
        'yesterday bucket must survive a 1-day retention');
      assert.equal(fs.existsSync(path.join(dest, '.mstream-trash', ymd(3))), false,
        '3-days-old bucket must be pruned');
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      Date.now = realNow;
    }
  });

  test('retention_days=0 drains legacy trash buckets (previously orphaned forever)', async () => {
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 6, 10, 12, 0, 0);
    try {
      const { root, dest } = seedTrash(0, [ymd(1), ymd(5)]);
      await manager.sweepDestTrash({ dest_path: dest, retention_days: 0 });
      assert.equal(fs.existsSync(path.join(dest, '.mstream-trash')),
        false,
        'a retention-0 destination must drain (and remove) leftover trash, not skip it');
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      Date.now = realNow;
    }
  });
});

// ── Worker: partial status, torn-copy, excludes ──────────────────────────────

describe('batch4 worker: partial status + torn-copy + temp excludes', () => {
  test("a run with per-file errors reports done.status hints (fileErrors > 0)", async () => {
    const root = makeTempRoot('partial');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'ok.mp3'), 'fine');
    // A name invalid on the dest filesystem would fail per-file, but that
    // is platform-specific; instead inject a copyFile failure for one
    // file so the worker records a fileError and still exits 0.
    fs.writeFileSync(path.join(src, 'FAILCOPY-bad.mp3'), 'nope');

    const { code, events } = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: { NODE_OPTIONS: `--require "${path.join(REPO_ROOT, 'test', 'fixtures', 'fail-copyfile.cjs').replace(/\\/g, '/')}"` } },
    );
    assert.equal(code, 0, 'per-file errors are non-fatal — worker still exits 0');
    const done = doneEvent(events);
    assert.ok(done.fileErrors >= 1, 'the failed file must be counted');
    assert.equal(liveNames(dest).includes('ok.mp3'), true, 'the good file still lands');
    // task-queue maps (exit 0 && fileErrors>0) → status 'partial'; the
    // worker just reports the count. Assert the signal it emits.
    assert.ok(done.sampleErrorMessage, 'a sample error message must accompany the count');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a file modified during copy is not finalised as a torn mirror', async () => {
    const root = makeTempRoot('torn');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    const f = path.join(src, 'GROW-track.mp3');
    fs.writeFileSync(f, 'v1');

    await runWorker({ sourcePath: src, destPath: dest, retentionDays: 30 });
    // Change the file's content+size AND stamp its mtime to match the
    // ORIGINAL, so only the post-copy re-stat (size check) catches it —
    // then use the grow-during-copy fixture to enlarge it mid-copy.
    fs.writeFileSync(f, 'v2-bigger-content');

    const { code, events } = await runWorker(
      { sourcePath: src, destPath: dest, retentionDays: 30 },
      { env: { NODE_OPTIONS: `--require "${path.join(REPO_ROOT, 'test', 'fixtures', 'grow-during-copy.cjs').replace(/\\/g, '/')}"`, GROW_MATCH: 'GROW-track' } },
    );
    assert.equal(code, 0);
    const done = doneEvent(events);
    assert.ok(done.fileErrors >= 1, 'the torn copy must be recorded as a per-file error');
    // The dest must hold the PREVIOUS good copy, never a torn one.
    const destContent = fs.readFileSync(path.join(dest, 'GROW-track.mp3'), 'utf8');
    assert.equal(destContent, 'v1', 'dest keeps the prior copy — no torn bytes finalised');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('default excludes skip in-flight temp files (no mirror, no churn)', async () => {
    const root = makeTempRoot('excl');
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'real.mp3'), 'music');
    fs.writeFileSync(path.join(src, 'cover.tmp_art.jpg'), 'inflight');
    fs.writeFileSync(path.join(src, 'download.part'), 'inflight');
    fs.writeFileSync(path.join(src, 'remux.tmp.opus'), 'inflight');
    fs.writeFileSync(path.join(src, 'torrent.mp3.!qb'), 'inflight');

    // Pass the DEFAULT globs explicitly (task-queue resolves NULL →
    // defaults; here we mirror that by importing the constant).
    const dbManager = await import('../../src/db/manager.js');
    const { code, events } = await runWorker({
      sourcePath: src, destPath: dest, retentionDays: 30,
      excludeGlobs: dbManager.DEFAULT_BACKUP_EXCLUDE_GLOBS,
    });
    assert.equal(code, 0);
    assert.deepEqual(liveNames(dest), ['real.mp3'],
      'only the real track is mirrored; in-flight temp files are excluded');
    assert.equal(doneEvent(events).filesCopied, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
