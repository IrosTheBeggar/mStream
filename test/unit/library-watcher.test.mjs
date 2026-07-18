/**
 * Library watcher — pure mapping/coalescing logic + one real-chokidar
 * round trip.
 *
 * The watcher only ever ENQUEUES scans, so these tests pin the decision
 * layer: which events count (scan-ignore rules + watched extensions),
 * which directory a scan targets (files → parent; deletions walk up to
 * the nearest surviving ancestor), how bursts coalesce (debounce until
 * quiet, 3× back-off while a scan runs), and how nested targets collapse
 * (segment-boundary safe, '' absorbs all). Timer behaviour runs under
 * node:test mock timers — deterministic on every CI runner.
 *
 * The single integration test drives real chokidar over a temp dir with
 * an injected enqueue, because watch backends differ per OS; it uses a
 * directory event (not gated by awaitWriteFinish) and a generous
 * timeout to stay CI-safe.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  relFromRoot, parentRel, walkUpToExisting, eventLooksRelevant,
  collapseTargets, ScanCoalescer, startLibraryWatchers, stopLibraryWatchers,
} from '../../src/util/library-watcher.js';

const AUDIO = { mp3: true, flac: true };

describe('event → target mapping', () => {
  test('relFromRoot normalises separators and rejects escapes', () => {
    // Separator semantics are platform-owned (backslash is a plain name
    // character on POSIX), so each platform asserts its native form.
    if (process.platform === 'win32') {
      assert.equal(relFromRoot('C:\\lib', 'C:\\lib\\Artist\\a.mp3'), 'Artist/a.mp3');
      assert.equal(relFromRoot('C:\\lib', 'C:\\lib'), '');
      assert.equal(relFromRoot('C:\\lib', 'C:\\outside\\a.mp3'), null);
    } else {
      assert.equal(relFromRoot('/lib', '/lib/Artist/a.mp3'), 'Artist/a.mp3');
      assert.equal(relFromRoot('/lib', '/lib'), '');
      assert.equal(relFromRoot('/lib', '/outside/a.mp3'), null);
    }
  });

  test('parentRel maps files to their directory', () => {
    assert.equal(parentRel('Artist/Album/a.mp3'), 'Artist/Album');
    assert.equal(parentRel('a.mp3'), '');
  });

  test('walkUpToExisting climbs to the nearest surviving ancestor', () => {
    const alive = new Set(['/lib', path.join('/lib', 'Artist')]);
    const isDir = (p) => alive.has(p);
    assert.equal(walkUpToExisting('/lib', 'Artist/Album/Disc', isDir), 'Artist');
    assert.equal(walkUpToExisting('/lib', 'Gone/Deeper', isDir), '');
    assert.equal(walkUpToExisting('/lib', 'Artist', isDir), 'Artist');
  });

  test('eventLooksRelevant: extensions, blocklist, and LIVE dot flags', () => {
    const base = { supportedFiles: AUDIO };
    assert.equal(eventLooksRelevant('Artist/a.mp3', false, base), true);
    assert.equal(eventLooksRelevant('Artist/cover.jpg', false, base), true,
      'folder art counts');
    assert.equal(eventLooksRelevant('Artist/a.lrc', false, base), true,
      'lyric sidecars count');
    assert.equal(eventLooksRelevant('Artist/notes.pdf', false, base), false);
    assert.equal(eventLooksRelevant('#recycle/junk.mp3', false, base), false,
      'blocklist always ignored');
    assert.equal(eventLooksRelevant('.hidden.mp3', false, base), true,
      'dot files count while the flag is off');
    assert.equal(eventLooksRelevant('.hidden.mp3', false,
      { ...base, ignoreDotFiles: true }), false);
    assert.equal(eventLooksRelevant('.hiddendir', true,
      { ...base, ignoreDotFolders: true }), false,
      'dir events use the FOLDER rule for their own name');
    assert.equal(eventLooksRelevant('.hiddendir', true,
      { ...base, ignoreDotFiles: true, ignoreDotFolders: false }), true,
      'a dot DIR is not governed by the file flag');
    assert.equal(eventLooksRelevant('..WeirdAlbum', true, base), true);
    assert.equal(eventLooksRelevant('', true, base), true, 'library root');
  });

  test('collapseTargets: root absorbs, descendants fold, boundaries hold', () => {
    assert.deepEqual(collapseTargets(new Set(['a/b', '', 'c'])), ['']);
    assert.deepEqual(collapseTargets(new Set(['a/b/c', 'a/b', 'a/b/d'])), ['a/b']);
    assert.deepEqual(collapseTargets(new Set(['sub', 'subX'])), ['sub', 'subX'],
      "'sub' must not absorb 'subX'");
  });
});

describe('ScanCoalescer (mock timers)', () => {
  function makeCoalescer(t, { active = () => false, waitMs = 1000 } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const full = [];
    const sub = [];
    const c = new ScanCoalescer({
      waitMs, isScanActive: active,
      enqueueFull: (v) => full.push(v),
      enqueueSubtree: (v, s) => sub.push([v, s]),
    });
    return { c, full, sub };
  }

  test('debounce-until-quiet: every add re-arms the timer', (t) => {
    const { c, sub } = makeCoalescer(t);
    c.add('music', 'a');
    t.mock.timers.tick(900);
    c.add('music', 'b');          // re-arms — old deadline must NOT fire
    t.mock.timers.tick(900);
    assert.equal(sub.length, 0, 'still within the re-armed window');
    t.mock.timers.tick(100);
    assert.deepEqual(sub, [['music', 'a'], ['music', 'b']]);
  });

  test('an active scan re-arms at 3× instead of enqueueing', (t) => {
    let scanning = true;
    const { c, sub } = makeCoalescer(t, { active: () => scanning });
    c.add('music', 'a');
    t.mock.timers.tick(1000);     // fires into the active scan → back-off
    assert.equal(sub.length, 0);
    scanning = false;
    t.mock.timers.tick(2999);
    assert.equal(sub.length, 0, '3× back-off window still open');
    t.mock.timers.tick(1);
    assert.deepEqual(sub, [['music', 'a']]);
  });

  test('flush collapses targets and routes root to a full scan', (t) => {
    const { c, full, sub } = makeCoalescer(t);
    c.add('music', 'a/b');
    c.add('music', 'a/b/c');
    c.add('other', '');
    c.add('other', 'x');
    t.mock.timers.tick(1000);
    assert.deepEqual(sub, [['music', 'a/b']]);
    assert.deepEqual(full, ['other']);
  });

  test('stop() drops pending work and timers', (t) => {
    const { c, sub } = makeCoalescer(t);
    c.add('music', 'a');
    c.stop();
    t.mock.timers.tick(10_000);
    assert.equal(sub.length, 0);
  });
});

describe('chokidar round trip', () => {
  test('a created directory enqueues a subtree scan after the quiet window', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-watch-'));
    const enqueued = [];
    try {
      startLibraryWatchers({
        libraries: [{ name: 'watched', root_path: root, follow_symlinks: 0 }],
        waitSeconds: 1,
        isScanActive: () => false,
        enqueueFull: (v) => enqueued.push([v, '']),
        enqueueSubtree: (v, s) => enqueued.push([v, s]),
        getEventOpts: () => ({ supportedFiles: AUDIO }),
      });
      // chokidar needs a beat to install platform watchers before events count.
      await new Promise((r) => setTimeout(r, 1500));
      await fsp.mkdir(path.join(root, 'NewAlbum'));

      const deadline = Date.now() + 30_000;
      while (enqueued.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.deepEqual(enqueued[0], ['watched', 'NewAlbum'],
        'the new directory becomes a targeted subtree scan');
    } finally {
      stopLibraryWatchers();
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
