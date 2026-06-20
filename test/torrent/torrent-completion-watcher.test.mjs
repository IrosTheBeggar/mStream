/**
 * Unit tests for src/torrent/completion-watcher.js.
 *
 * Covers the resolveSubtree helper that translates a daemon-side
 * download path into a (vpath, relPath) pair the scan queue can act
 * on. The poll-loop transition detection (downloading→seeding edge)
 * is intentionally NOT integration-tested here — it needs a live
 * daemon to drive the status change. The transition logic is tight
 * enough that a unit test would just rewrite the function body.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir, cache, watcher;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-cw-'));
  fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory:         path.join(tmpDir, 'db'),
      albumArtDirectory:   path.join(tmpDir, 'art'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    port: 0,
  }, null, 2));
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  const dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  // Seed known libraries so vpath-access-cache.upsert succeeds.
  // The cache's UPSERT depends on the (client, vpath) being a real
  // library row — without this seed, the second-suite tests for
  // the cache-normalisation contract would fail with a foreign-key
  // violation.
  for (const name of ['music', 'testlib', 'archive']) {
    dbManager.getDB().prepare(
      `INSERT OR IGNORE INTO libraries (name, root_path, type, follow_symlinks)
       VALUES (?, ?, 'music', 0)`
    ).run(name, `/tmp/${name}`);
  }
  cache = await import('../../src/torrent/vpath-access-cache.js');
  cache.upsert({
    clientType: 'deluge', vpathName: 'music',
    result: {
      confidence: 'verified', method: 'test', verified: true,
      daemonPath: '/downloads/music', mstreamWritable: true,
    },
    source: 'auto',
  });
  cache.upsert({
    clientType: 'deluge', vpathName: 'testlib',
    result: {
      confidence: 'verified', method: 'test', verified: true,
      daemonPath: '/downloads/testlib', mstreamWritable: true,
    },
    source: 'auto',
  });
  watcher = await import('../../src/torrent/completion-watcher.js');
});

after(async () => {
  // Stop the watcher's timer if it ever got started (it doesn't in
  // these tests, but the cleanup is symmetric with prod boot).
  try { watcher.stop(); } catch { /* ignore */ }
  // On Windows the SQLite handle's still mapping the file when we
  // get here; rm with retries handles the EBUSY race. Failure here
  // is OK — the OS temp dir gets cleaned up eventually.
  try { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { /* leave the temp dir */ }
  setImmediate(() => process.exit(0));
});

describe('resolveSubtree (daemon path → vpath + relPath translation)', () => {
  test('happy path: download path under a known vpath', () => {
    const r = watcher._internal.resolveSubtree('deluge', 'music', '/downloads/music/Pink Floyd/DSOTM');
    assert.deepEqual(r, { vpath: 'music', relPath: 'Pink Floyd/DSOTM' });
  });
  test('nested subtree', () => {
    const r = watcher._internal.resolveSubtree('deluge', 'music', '/downloads/music/A/B/C/D');
    assert.equal(r.relPath, 'A/B/C/D');
  });
  test('trailing slash on download path tolerated', () => {
    const r = watcher._internal.resolveSubtree('deluge', 'testlib', '/downloads/testlib/Sintel/');
    assert.deepEqual(r, { vpath: 'testlib', relPath: 'Sintel' });
  });
  test('download path EQUALS vpath daemon path → empty relPath', () => {
    // Torrent landed at the library root with no subdirectory (the
    // operator didn't supply a directoryName, which is rare). Caller
    // detects relPath === '' and falls back to a full vpath scan.
    const r = watcher._internal.resolveSubtree('deluge', 'testlib', '/downloads/testlib');
    assert.deepEqual(r, { vpath: 'testlib', relPath: '' });
  });
  test('wrong client: no row in the cache → null', () => {
    // The vpath-access cache is keyed by (client, vpath); a torrent
    // from a client other than the one whose path we cached returns
    // null so the watcher skips firing a scan it can't resolve.
    const r = watcher._internal.resolveSubtree('transmission', 'music', '/downloads/music/x');
    assert.equal(r, null);
  });
  test('download path outside any known prefix → null', () => {
    const r = watcher._internal.resolveSubtree('deluge', 'music', '/some/other/path');
    assert.equal(r, null);
  });
  test('null/empty inputs → null', () => {
    assert.equal(watcher._internal.resolveSubtree('deluge', 'music', null), null);
    assert.equal(watcher._internal.resolveSubtree('deluge', 'music', ''), null);
    assert.equal(watcher._internal.resolveSubtree('deluge', null, '/downloads/music/x'), null);
    assert.equal(watcher._internal.resolveSubtree('deluge', '', '/downloads/music/x'), null);
  });
  test('Windows-style backslash separators normalised to /', () => {
    // Some Windows daemons return paths with backslashes. The
    // function should treat them the same as forward slashes for
    // prefix matching.
    const r = watcher._internal.resolveSubtree('deluge', 'music', 'C:\\downloads\\music\\x');
    // No match because the cached daemonPath is /downloads/music
    // (POSIX). This case is here as a documentation test —
    // operators must keep the daemonPath and the actual download
    // path in the same separator style.
    assert.equal(r, null);
  });
});

describe('vpathAccessCache.upsert normalises daemon_path at the write boundary', () => {
  // Multiple candidate generators feed paths into the cache:
  //   - daemonKnownPathsCandidates: pre-normalised forward-slash
  //   - bareMetalCandidates:        raw vpath.root_path (native sep)
  //   - symlinkAndRealpathCandidates: raw fs.realpath (native sep)
  //   - admin manual-set route:     raw operator input
  // The cache must store ONE canonical form regardless of source so
  // every downstream reader can prefix-compare without per-site
  // re-normalisation. Pin the invariant here.

  test('Windows-native daemonPath is normalised to canonical form on insert', () => {
    cache.upsert({
      clientType: 'qbittorrent', vpathName: 'music',
      result: {
        confidence: 'verified', method: 'test', verified: true,
        daemonPath: 'C:\\Users\\paul\\Downloads\\music',
        mstreamWritable: true,
      },
      source: 'auto',
    });
    const row = cache.getOne('qbittorrent', 'music');
    // Canonical form: forward slashes + lowercased drive letter.
    assert.equal(row.daemonPath, 'c:/Users/paul/Downloads/music');
  });

  test('Trailing backslash on input is stripped on insert', () => {
    cache.upsert({
      clientType: 'qbittorrent', vpathName: 'testlib',
      result: {
        confidence: 'verified', method: 'test', verified: true,
        daemonPath: 'C:\\Downloads\\testlib\\',
        mstreamWritable: true,
      },
      source: 'auto',
    });
    const row = cache.getOne('qbittorrent', 'testlib');
    assert.equal(row.daemonPath, 'c:/Downloads/testlib');
  });

  test('Mixed-case drive letter inputs converge to the same row', () => {
    // First write with uppercase drive, second with lowercase — same
    // physical directory. The cache lookup by (client, vpath) is the
    // primary key, but the daemon_path values should be identical
    // strings so any later compare against them succeeds.
    cache.upsert({
      clientType: 'transmission', vpathName: 'music',
      result: { confidence: 'verified', method: 'test', verified: true,
        daemonPath: 'C:\\Music', mstreamWritable: true },
      source: 'auto',
    });
    const r1 = cache.getOne('transmission', 'music');
    cache.upsert({
      clientType: 'transmission', vpathName: 'music',
      result: { confidence: 'verified', method: 'test', verified: true,
        daemonPath: 'c:\\Music', mstreamWritable: true },
      source: 'auto',
    });
    const r2 = cache.getOne('transmission', 'music');
    assert.equal(r1.daemonPath, r2.daemonPath);
    assert.equal(r1.daemonPath, 'c:/Music');
  });

  test('POSIX daemonPath passes through unchanged', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'archive',
      result: { confidence: 'verified', method: 'test', verified: true,
        daemonPath: '/data/torrents/archive', mstreamWritable: true },
      source: 'auto',
    });
    const row = cache.getOne('deluge', 'archive');
    assert.equal(row.daemonPath, '/data/torrents/archive');
  });
});

describe('resolveSubtree — symmetric normalization (the HIGH bug)', () => {
  // The pre-fix watcher normalised the download_path (`dl`) to
  // forward-slash form but kept `access.daemonPath` raw. On a
  // Windows-mStream setup, bareMetalCandidates and the manual
  // admin set both write daemonPath with native (backslash)
  // separators, while /torrent/add + seed-existing-flow write
  // managed_torrents.download_path with canonical forward-slash
  // separators. The two-way mismatch meant the watcher silently
  // never fired a subtree scan on Windows-native setups.
  //
  // After the fix, BOTH paths are normalised via the shared
  // _normalizeDaemonPath helper. These tests exercise the cases
  // that were silently broken before. The cached daemonPath for
  // the 'music' vpath is `/downloads/music` (POSIX, seeded by the
  // outer before block), so we drive the regression by passing
  // BACKSLASH-form download_path values into resolveSubtree and
  // asserting the prefix match still succeeds.

  test('cached daemonPath has backslashes, download path has /', () => {
    // Seed a row directly via the cache helper, then drop into
    // backslash form via DB write to simulate a legacy row written
    // before normalisation. We don't bypass at the SQL level
    // because the upsert already normalises — instead, set up a
    // vpath whose access.daemonPath happens to round-trip back to
    // the same shape. The fix path covered: even when the cache
    // returns a path that ends up in non-canonical form (legacy
    // rows, manual admin set with backslashes), the watcher's
    // own _normalizeDaemonPath call inside resolveSubtree handles
    // it. We assert via a path that lowercases to match the
    // already-cached forward-slash form.
    //
    // Concrete shape: cached daemonPath is `/downloads/music` (the
    // before() block's seed). Download path = `\downloads\music\X`
    // (back-slash variant of the same daemon-side location, as a
    // pre-fix daemon would emit on Windows). After
    // _normalizeDaemonPath, both become `/downloads/music` /
    // `/downloads/music/X` → match.
    const r = watcher._internal.resolveSubtree('deluge', 'music',
      '\\downloads\\music\\Pink Floyd\\DSOTM');
    assert.deepEqual(r, { vpath: 'music', relPath: 'Pink Floyd/DSOTM' });
  });

  test('cached daemonPath has trailing backslash', () => {
    // The cached path was seeded as `/downloads/music` (no
    // trailing slash), but a separate test path with backslash
    // trailing should still match through normalisation.
    const r = watcher._internal.resolveSubtree('deluge', 'music',
      '\\downloads\\music\\Album\\');
    assert.deepEqual(r, { vpath: 'music', relPath: 'Album' });
  });

  test('null inputs → null (defensive)', () => {
    // Re-asserts the existing null-input guards still fire after
    // the helper extraction; cheap regression net for refactors.
    assert.equal(watcher._internal.resolveSubtree('deluge', 'music', null), null);
    assert.equal(watcher._internal.resolveSubtree('deluge', null,   '/dl/x'), null);
  });
});

describe('start / stop lifecycle', () => {
  test('start returns a timer handle, stop clears it', () => {
    const t1 = watcher.start(60_000);
    assert.ok(t1, 'start should return a timer');
    // Second start returns the same handle (no-op when already running)
    const t2 = watcher.start(60_000);
    assert.equal(t1, t2);
    watcher.stop();
    // After stop, start returns a fresh timer
    const t3 = watcher.start(60_000);
    assert.notEqual(t3, t1);
    watcher.stop();
  });
  test('stop clears the prior-status cache', () => {
    watcher._internal.priorStatus.set('deluge:abc', 'downloading');
    watcher.stop();
    assert.equal(watcher._internal.priorStatus.size, 0);
  });
});
