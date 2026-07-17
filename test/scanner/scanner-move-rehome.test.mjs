/**
 * Move re-homing across the stale sweep.
 *
 * playlist_tracks ("<vpath>/<rel>"), cue_points and play_events
 * (rel + library_id) are path-keyed, and the sweep used to delete a
 * moved file's old row without touching them — a rename orphaned every
 * playlist entry pointing at it forever (stars/ratings survive via
 * audio_hash keying; path-keyed references did not). The sweep now
 * pairs each verified-gone candidate with a live row by content hash
 * (audio_hash first — survives tag edits — then file_hash), rewrites
 * those references BEFORE the DELETE, and preserves the dying row's
 * created_at so a mass rename doesn't flood "recently added".
 *
 * This file pins that behaviour on BOTH scanners:
 *   - rename / folder-rename re-homes all three tables + created_at;
 *   - a tag-edit + move in ONE pass still pairs (audio_hash tier —
 *     the case tag-identity scanners lose);
 *   - identical-content ties resolve deterministically (same library,
 *     then same basename, then lowest (library_id, filepath));
 *   - deleting one of two byte-identical copies re-points references
 *     at the survivor;
 *   - a genuine deletion (no twin) leaves references untouched — the
 *     sweep never guesses;
 *   - subtree scans never sweep, so they never re-home;
 *   - a cross-library move heals when the destination library was
 *     scanned first.
 *
 * Fixture gotcha exploited on purpose: makeAudio files with the SAME
 * duration have byte-identical (silence) audio streams and therefore
 * share an audio_hash; distinct durations give distinct content.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary
 * is unavailable.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from '../helpers/scanner-runner.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';
import { appendId3v23TextFrames } from '../helpers/id3.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

let rustBin;
let scratch;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-moverehome-'));
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

// Each scenario gets its own sandbox (library root, DB, art dir, and an
// engine-dispatched scan runner) so JS and Rust runs of the same
// scenario can't contaminate each other.
let sandboxSeq = 0;
async function makeSandbox(engine) {
  const root = path.join(scratch, `sb${sandboxSeq++}-${engine}`);
  const libRoot = path.join(root, 'lib');
  const artDir = path.join(root, 'art');
  const waveDir = path.join(root, 'wave');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let scanSeq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: artDir, waveformCacheDir: waveDir,
      scanId: `scan-${scanSeq++}`, overrides,
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  return { root, libRoot, artDir, dbPath, libraryId, vpath, scan };
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  try { return fn(db); } finally { db.close(); }
}

// Reference rows exactly as the API endpoints write them: playlists via
// "<vpath>/<rel>", cue_points / play_events via (rel, library_id).
let eventSeq = 0;
function seedRefs(dbPath, vpath, libraryId, rel) {
  withDb(dbPath, db => {
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                VALUES (1, 'mover', 'x', 'x')`).run();
    db.prepare(`INSERT OR IGNORE INTO playlists (id, name, user_id)
                VALUES (1, 'pl', 1)`).run();
    const pos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks').get().p;
    db.prepare(`INSERT INTO playlist_tracks (playlist_id, filepath, position)
                VALUES (1, ?, ?)`).run(`${vpath}/${rel}`, pos);
    db.prepare(`INSERT INTO cue_points (filepath, library_id, user_id, position, label)
                VALUES (?, ?, 1, 12.5, 'drop')`).run(rel, libraryId);
    db.prepare(`INSERT INTO play_events (event_id, user_id, filepath, library_id)
                VALUES (?, 1, ?, ?)`).run(`evt-${eventSeq++}`, rel, libraryId);
  });
}

const playlistPaths = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath FROM playlist_tracks ORDER BY id').all()
    .map(r => r.filepath));
const cueRows = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath, library_id FROM cue_points ORDER BY id').all()
    .map(r => ({ ...r })));
const eventRows = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath, library_id FROM play_events ORDER BY id').all()
    .map(r => ({ ...r })));
const trackPaths = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath FROM tracks ORDER BY filepath').all()
    .map(r => r.filepath));
const backdateTrack = (dbPath, rel, ts) => withDb(dbPath, db =>
  db.prepare('UPDATE tracks SET created_at = ? WHERE filepath = ?').run(ts, rel));
const trackCreatedAt = (dbPath, rel) => withDb(dbPath, db =>
  db.prepare('SELECT created_at FROM tracks WHERE filepath = ?').get(rel)?.created_at);

for (const engine of ['rust', 'js']) {
  const engineAvailable = () =>
    fs.existsSync(FFMPEG) && (engine === 'js' || !!rustBin);

  describe(`move re-homing (${engine} scanner)`, () => {
    test('rename in place re-homes playlist/cue/event refs and keeps created_at', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'a.mp3'), MP3,
        { artist: 'A', album: 'AL', title: 'T1' }, 1);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'a.mp3');
      backdateTrack(sb.dbPath, 'a.mp3', '2020-01-01 00:00:00');

      await fsp.rename(path.join(sb.libRoot, 'a.mp3'), path.join(sb.libRoot, 'b.mp3'));
      const { event } = await sb.scan();

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.strictEqual(event.movedRefsRehomed, 3,
        'one playlist row + one cue + one play event rewritten');
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['b.mp3']);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/b.mp3`]);
      assert.deepStrictEqual(cueRows(sb.dbPath),
        [{ filepath: 'b.mp3', library_id: sb.libraryId }]);
      assert.deepStrictEqual(eventRows(sb.dbPath),
        [{ filepath: 'b.mp3', library_id: sb.libraryId }]);
      assert.strictEqual(trackCreatedAt(sb.dbPath, 'b.mp3'), '2020-01-01 00:00:00',
        'moved file must not re-enter "recently added"');

      // A follow-up no-op rescan pays nothing and reports nothing.
      const { event: idle } = await sb.scan();
      assert.strictEqual(idle.staleEntriesRemoved, 0);
      assert.strictEqual(idle.movedTracksRehomed, 0);
      assert.strictEqual(idle.movedRefsRehomed, 0);
    });

    test('folder rename pairs every track via the same-basename tiebreak', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      // Same duration on purpose: identical silence ⇒ both files share
      // one audio_hash, so each old row sees BOTH new rows as targets
      // and only the basename tiebreak assigns them correctly.
      await makeAudio(path.join(sb.libRoot, 'X', '1.mp3'), MP3, { title: 'One' }, 1);
      await makeAudio(path.join(sb.libRoot, 'X', '2.mp3'), MP3, { title: 'Two' }, 1);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'X/1.mp3');
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'X/2.mp3');

      await fsp.rename(path.join(sb.libRoot, 'X'), path.join(sb.libRoot, 'Y'));
      const { event } = await sb.scan();

      assert.strictEqual(event.movedTracksRehomed, 2);
      assert.deepStrictEqual(playlistPaths(sb.dbPath),
        [`${sb.vpath}/Y/1.mp3`, `${sb.vpath}/Y/2.mp3`]);
      assert.deepStrictEqual(cueRows(sb.dbPath), [
        { filepath: 'Y/1.mp3', library_id: sb.libraryId },
        { filepath: 'Y/2.mp3', library_id: sb.libraryId },
      ]);
    });

    test('tag edit + move in one pass still pairs via audio_hash', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'c.mp3'), MP3,
        { artist: 'C', title: 'Old' }, 2);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'c.mp3');

      await fsp.rename(path.join(sb.libRoot, 'c.mp3'), path.join(sb.libRoot, 'd.mp3'));
      // Tag surgery changes file bytes (file_hash) but not audio bytes
      // (audio_hash) — the pairing tier tag-identity scanners lose.
      await appendId3v23TextFrames(path.join(sb.libRoot, 'd.mp3'), { TCON: 'Retagged' });
      const { event } = await sb.scan();

      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/d.mp3`]);
    });

    test('deleting one of two identical copies re-points refs at the survivor', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'dup1.mp3'), MP3, { title: 'Dup' }, 3);
      await fsp.copyFile(path.join(sb.libRoot, 'dup1.mp3'),
        path.join(sb.libRoot, 'dup2.mp3'));
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'dup1.mp3');

      await fsp.rm(path.join(sb.libRoot, 'dup1.mp3'));
      const { event } = await sb.scan();

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/dup2.mp3`]);
      assert.deepStrictEqual(cueRows(sb.dbPath),
        [{ filepath: 'dup2.mp3', library_id: sb.libraryId }]);
    });

    test('a genuine deletion never rewrites references', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'e.mp3'), MP3, { title: 'Gone' }, 4);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'e.mp3');

      await fsp.rm(path.join(sb.libRoot, 'e.mp3'));
      const { event } = await sb.scan();

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.strictEqual(event.movedTracksRehomed, 0);
      assert.strictEqual(event.movedRefsRehomed, 0);
      // Fail open: the dangling reference is the pre-existing behaviour;
      // the sweep must not guess a target that doesn't share content.
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/e.mp3`]);
    });

    test('subtree scans never sweep, so they never re-home', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'f.mp3'), MP3, { title: 'Root' }, 5);
      await makeAudio(path.join(sb.libRoot, 'sub', 'g.mp3'), MP3, { title: 'Sub' }, 6);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'f.mp3');

      await fsp.rm(path.join(sb.libRoot, 'f.mp3'));
      const { event } = await sb.scan({ subtree: 'sub' });

      assert.strictEqual(event.staleEntriesRemoved, 0);
      assert.strictEqual(event.movedTracksRehomed, 0);
      assert.ok(trackPaths(sb.dbPath).includes('f.mp3'),
        'rows outside the subtree are untouched');
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/f.mp3`]);
    });

    test('ignore-doomed rows also re-home: dot-hidden twin converges, refs follow the visible copy', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      // Byte-identical pair: one visible, one dot-hidden. With the
      // ignoreDotFiles flag OFF (default) both index; flipping it ON
      // dooms the dot row via the walk-faithful IGNORE predicate — its
      // file still exists on disk — and the pairing must then treat it
      // exactly like a move, re-pointing its references at the twin.
      // This pins the PR-756 × re-home interaction path.
      await makeAudio(path.join(sb.libRoot, 'visible.mp3'), MP3, { title: 'Twin' }, 8);
      await fsp.copyFile(path.join(sb.libRoot, 'visible.mp3'),
        path.join(sb.libRoot, '.hidden.mp3'));
      await sb.scan();
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['.hidden.mp3', 'visible.mp3']);
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, '.hidden.mp3');

      const { event } = await sb.scan({ ignoreDotFiles: true });

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['visible.mp3']);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/visible.mp3`]);
      assert.deepStrictEqual(cueRows(sb.dbPath),
        [{ filepath: 'visible.mp3', library_id: sb.libraryId }]);
      assert.deepStrictEqual(eventRows(sb.dbPath),
        [{ filepath: 'visible.mp3', library_id: sb.libraryId }]);
    });

    test('cross-library move heals when the destination was scanned first', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg or rust binary unavailable'); return; }
      const sb = await makeSandbox(engine);
      const lib2Root = path.join(sb.root, 'lib2');
      await fsp.mkdir(lib2Root, { recursive: true });
      const lib2Id = withDb(sb.dbPath, db => {
        db.prepare(`INSERT INTO libraries (name, root_path, type)
                    VALUES ('second', ?, 'music')`).run(lib2Root);
        return db.prepare(`SELECT id FROM libraries WHERE name = 'second'`).get().id;
      });
      const scanLib2 = (scanId) => {
        const config = buildScanConfig({
          dbPath: sb.dbPath, libraryId: lib2Id, vpath: 'second',
          directory: lib2Root, albumArtDirectory: sb.artDir,
          waveformCacheDir: path.join(sb.root, 'wave'), scanId,
        });
        return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
      };

      await makeAudio(path.join(sb.libRoot, 'h.mp3'), MP3, { title: 'Wanderer' }, 7);
      await sb.scan();
      seedRefs(sb.dbPath, sb.vpath, sb.libraryId, 'h.mp3');

      await fsp.rename(path.join(sb.libRoot, 'h.mp3'), path.join(lib2Root, 'h.mp3'));
      await scanLib2('xlib-1');                 // destination indexed first
      const { event } = await sb.scan();        // then the source library sweeps

      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), ['second/h.mp3']);
      assert.deepStrictEqual(cueRows(sb.dbPath),
        [{ filepath: 'h.mp3', library_id: lib2Id }]);
      assert.deepStrictEqual(eventRows(sb.dbPath),
        [{ filepath: 'h.mp3', library_id: lib2Id }]);
    });
  });
}
