/**
 * Unit-ish tests for renderMetadataByIds (src/api/db.js) — the batched,
 * id-keyed metadata enrichment the /api/v1/db/search route uses to attach the
 * full canonical metadata object to track hits.
 *
 * Bootstraps a temp SQLite DB via the canonical config.setup + initDB path
 * (same harness as test/torrent/torrent-db-helpers.test.mjs), seeds a small
 * known fixture, then exercises the real exported function. Asserts the
 * contract the search route depends on:
 *   - returns a Map<id, { filepath, metadata }> for every resolvable id
 *   - de-dups repeated ids (a track can match several search categories)
 *   - is order-independent (it's a lookup map, so the `IN (...)` reshuffle
 *     can never disturb the caller's rank order)
 *   - resolves genres via the batched lookup (includeGenres:false path)
 *   - drops missing ids silently (no map entry)
 *   - honours the per-user user_metadata join (rating/play_count)
 *   - returns an empty map for empty / invalid input
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir, dbManager, renderMetadataByIds, toLiteMetadata, LITE_METADATA_FIELDS;
let t1, t2, t3, userId; // track ids + a seeded user

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-render-meta-'));
  fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory:         path.join(tmpDir, 'db'),
      albumArtDirectory:   path.join(tmpDir, 'art'),
      logsDirectory:       path.join(tmpDir, 'logs'),
    },
    port: 0,
  }, null, 2));

  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  ({ renderMetadataByIds, toLiteMetadata, LITE_METADATA_FIELDS } = await import('../../src/api/db.js'));

  const d = dbManager.getDB();
  const num = (r) => Number(r.lastInsertRowid);

  const lib1 = num(d.prepare(
    "INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('testlib', '/tmp/testlib', 'music', 0)"
  ).run());
  // getLibraryByName (used by renderMetadataObj) caches; refresh so the new
  // library is visible.
  dbManager.invalidateCache();

  const aPink  = num(d.prepare("INSERT INTO artists (name) VALUES ('Pink Floyd')").run());
  const aRadio = num(d.prepare("INSERT INTO artists (name) VALUES ('Radiohead')").run());
  const albWall = num(d.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('The Wall', ?, 1979)").run(aPink));
  const albOK   = num(d.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('OK Computer', ?, 1997)").run(aRadio));
  const gRock = num(d.prepare("INSERT INTO genres (name) VALUES ('Rock')").run());
  const gProg = num(d.prepare("INSERT INTO genres (name) VALUES ('Prog')").run());

  const insT = d.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format, file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, 'seed')`);
  let ts = 1700000000000;
  t1 = num(insT.run('pf/wall/01.flac', lib1, 'Comfortably Numb', aPink,  albWall, 1979, 'h1', 'a1', ts++)); // two genres
  t2 = num(insT.run('rh/ok/01.flac',   lib1, 'Karma Police',     aRadio, albOK,   1997, 'h2', 'a2', ts++)); // no genres
  t3 = num(insT.run('pf/wall/02.flac', lib1, 'Another Brick',    aPink,  albWall, 1979, 'h3', 'a3', ts++)); // one genre

  const insTG = d.prepare("INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)");
  insTG.run(t1, gRock); insTG.run(t1, gProg);
  insTG.run(t3, gRock);

  userId = num(d.prepare(`
    INSERT INTO users (username, password, salt, is_admin, is_anonymous_sentinel, allow_upload, allow_mkdir, allow_server_audio)
    VALUES ('tester', 'x', 'x', 0, 0, 1, 1, 1)`).run());
  // user_metadata joins on COALESCE(audio_hash, file_hash) == track_hash.
  d.prepare("INSERT INTO user_metadata (user_id, track_hash, rating, play_count) VALUES (?, 'a1', 5, 7)")
    .run(userId);
});

after(async () => {
  try { dbManager.getDB()?.close?.(); } catch { /* may not expose close */ }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  // config.setup pulls in modules with module-level timers (winston rotation,
  // etc.) that keep the loop alive; exit explicitly to keep the suite fast —
  // same pattern as the other DB-backed tests.
  setImmediate(() => process.exit(0));
});

describe('renderMetadataByIds', () => {
  test('resolves every id to the canonical { filepath, metadata } wrapper', () => {
    const map = renderMetadataByIds([t1, t2, t3]);
    assert.equal(map.size, 3);

    const w1 = map.get(t1);
    assert.equal(w1.filepath, 'testlib/pf/wall/01.flac');
    assert.equal(w1.metadata.title, 'Comfortably Numb');
    assert.equal(w1.metadata.artist, 'Pink Floyd');
    assert.equal(w1.metadata.album, 'The Wall');
    assert.equal(w1.metadata.year, 1979);
    assert.equal(w1.metadata.format, 'flac');
    assert.equal(w1.metadata.hash, 'h1');
    assert.equal(w1.metadata['audio-hash'], 'a1');

    assert.equal(map.get(t2).metadata.title, 'Karma Police');
    assert.equal(map.get(t3).metadata.title, 'Another Brick');
  });

  test('genres resolve via the batched lookup (includeGenres:false path)', () => {
    const map = renderMetadataByIds([t1, t2, t3]);
    // t1 has two genres — assert membership (GROUP_CONCAT order isn't a
    // guaranteed contract) and count.
    const g1 = map.get(t1).metadata.genres;
    assert.ok(Array.isArray(g1));
    assert.equal(g1.length, 2);
    assert.deepEqual([...g1].sort(), ['Prog', 'Rock']);
    // t2 has no genres → always an empty array, never undefined.
    assert.deepEqual(map.get(t2).metadata.genres, []);
    // t3 has exactly one.
    assert.deepEqual(map.get(t3).metadata.genres, ['Rock']);
  });

  test('de-dups repeated ids (same track across multiple search categories)', () => {
    const map = renderMetadataByIds([t1, t1, t1]);
    assert.equal(map.size, 1);
    assert.equal(map.get(t1).metadata.title, 'Comfortably Numb');
  });

  test('is order-independent — keyed by id, not input position', () => {
    const a = renderMetadataByIds([t1, t2, t3]);
    const b = renderMetadataByIds([t3, t1, t2]);
    for (const id of [t1, t2, t3]) {
      assert.equal(a.get(id).metadata.title, b.get(id).metadata.title);
    }
    assert.equal(b.get(t1).metadata.title, 'Comfortably Numb');
  });

  test('missing ids are dropped silently (absent from the map)', () => {
    const map = renderMetadataByIds([t1, 999999]);
    assert.equal(map.size, 1);
    assert.ok(map.has(t1));
    assert.equal(map.has(999999), false);
  });

  test('honours the per-user user_metadata join', () => {
    const withUser = renderMetadataByIds([t1], { id: userId });
    assert.equal(withUser.get(t1).metadata.rating, 5);
    assert.equal(withUser.get(t1).metadata['play-count'], 7);
    // No user → no per-user fields.
    const noUser = renderMetadataByIds([t1]);
    assert.equal(noUser.get(t1).metadata.rating, null);
    assert.equal(noUser.get(t1).metadata['play-count'], null);
  });

  test('empty / invalid input returns an empty map', () => {
    assert.equal(renderMetadataByIds([]).size, 0);
    assert.equal(renderMetadataByIds(null).size, 0);
    assert.equal(renderMetadataByIds(undefined).size, 0);
  });
});

describe('toLiteMetadata', () => {
  test('projects a full metadata object to exactly the lite field set', () => {
    const full = renderMetadataByIds([t1], { id: userId }).get(t1).metadata;
    const lite = toLiteMetadata(full);
    // Exactly LITE_METADATA_FIELDS — no more, no fewer.
    assert.deepEqual(Object.keys(lite).sort(), [...LITE_METADATA_FIELDS].sort());
    // Values are picked verbatim (arrays/numbers/null preserved).
    assert.equal(lite.title, full.title);
    assert.equal(lite.rating, full.rating);
    assert.equal(lite.bpm, full.bpm);
    assert.deepEqual(lite.genres, full.genres);
    // Heavy/detail-only fields are dropped.
    for (const dropped of ['hash', 'audio-hash', 'format', 'bitrate', 'file-size',
      'play-count', 'last-played', 'created-at', 'modified', 'source', 'bpm-source',
      'track-total', 'disc-total', 'sample-rate', 'channels', 'bit-depth']) {
      assert.ok(!(dropped in lite), `lite must not include ${dropped}`);
    }
  });

  test('lite is a strict subset of the full object (same keys + values)', () => {
    const full = renderMetadataByIds([t1], { id: userId }).get(t1).metadata;
    const lite = toLiteMetadata(full);
    for (const key of LITE_METADATA_FIELDS) {
      assert.ok(key in full, `full object should contain lite key ${key}`);
      assert.deepEqual(lite[key], full[key]);
    }
  });

  test('null / undefined input returns null', () => {
    assert.equal(toLiteMetadata(null), null);
    assert.equal(toLiteMetadata(undefined), null);
  });
});
