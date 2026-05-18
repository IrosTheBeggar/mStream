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
  const config = await import('../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  const dbManager = await import('../src/db/manager.js');
  dbManager.initDB();
  // Seed a known library so vpath-access-cache.upsert succeeds
  dbManager.getDB().prepare(
    "INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('music', '/tmp/m', 'music', 0)"
  ).run();
  cache = await import('../src/torrent/vpath-access-cache.js');
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
  watcher = await import('../src/torrent/completion-watcher.js');
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
