// Album aggregate refresh (V70).
//
// Since V70 an album row's year, year_min, year_max, track_count,
// duration_total, compilation and album_artist are DERIVED from its tracks
// rather than written by whichever track happened to reach the row first
// (or last). Three triggers on `tracks` (tracks_ai_agg / tracks_ad_agg /
// tracks_au_agg, SCHEMA_V70) flag a row `agg_dirty = 1` whenever one of its
// tracks is inserted, deleted, moved to another album, or has a consensus
// input change; refreshDirtyAlbums() recomputes the flagged rows. The
// scanners call it at scan end (after the orphan sweep, so reaped rows are
// not recomputed first); the server calls it right after the ytdl insert.
// The flag lives in the row, in the same transaction as the track write, so
// an interrupted scan leaves its work for the next one.
//
// Consensus rules (all order-independent, so a parallel walk cannot make
// two scans of one library disagree):
//   name          most common tracks.tag_album (tie → smallest, BINARY).
//                 Only MBID-keyed albums can differ from their key's name.
//   year          most common non-NULL track year (tie → earliest).
//   year_min/max  MIN / MAX track year.
//   compilation   any track flagged (MAX of tag_compilation).
//   album_artist  most common non-NULL tracks.tag_album_artist (tie →
//                 smallest, BINARY); NULL when no track carries one.
// A trackless row (a starred ghost the orphan sweep keeps) zeroes its counts
// and keeps its display fields.
//
// Mirrored in rust-parser/src/main.rs (refresh_dirty_albums). Keep the SQL
// and the tie-breaks byte-identical — the scanner-parity snapshot compares
// these columns across engines.

import { chunkYield } from './orphan-cleanup.js';

// Dirty ids per transaction. Each chunk is one BEGIN..COMMIT so the writer
// lock is released (and yielded, in the scanner) between batches.
const ALBUM_AGG_CHUNK = 200;

// One statement reads the current row and every consensus value; every
// scalar subquery seeks idx_tracks_album.
const CONSENSUS_SQL = `
  SELECT a.name, a.year, a.year_min, a.year_max, a.track_count, a.duration_total,
         a.compilation, a.album_artist,
         (SELECT COUNT(*)                            FROM tracks t WHERE t.album_id = a.id) AS n,
         (SELECT COALESCE(SUM(t.duration), 0)        FROM tracks t WHERE t.album_id = a.id) AS dur,
         (SELECT MIN(t.year)                         FROM tracks t WHERE t.album_id = a.id) AS ymin,
         (SELECT MAX(t.year)                         FROM tracks t WHERE t.album_id = a.id) AS ymax,
         (SELECT COALESCE(MAX(t.tag_compilation), 0) FROM tracks t WHERE t.album_id = a.id) AS comp,
         (SELECT t.year FROM tracks t WHERE t.album_id = a.id AND t.year IS NOT NULL
            GROUP BY t.year ORDER BY COUNT(*) DESC, t.year ASC LIMIT 1) AS mode_year,
         (SELECT t.tag_album FROM tracks t WHERE t.album_id = a.id AND t.tag_album IS NOT NULL
            GROUP BY t.tag_album ORDER BY COUNT(*) DESC, t.tag_album ASC LIMIT 1) AS mode_name,
         (SELECT t.tag_album_artist FROM tracks t WHERE t.album_id = a.id AND t.tag_album_artist IS NOT NULL
            GROUP BY t.tag_album_artist ORDER BY COUNT(*) DESC, t.tag_album_artist ASC LIMIT 1) AS mode_album_artist
    FROM albums a WHERE a.id = ?`;

function prepareStatements(db) {
  return {
    pick: db.prepare(`SELECT id FROM albums WHERE agg_dirty = 1 ORDER BY id LIMIT ${ALBUM_AGG_CHUNK}`),
    read: db.prepare(CONSENSUS_SQL),
    // The core write always runs (it is also what clears agg_dirty — a
    // separate "clear" would rewrite the row anyway). name has its own
    // statement because an UPDATE that lists `name` in its SET clause fires
    // the albums_au_fts fan-out into every fts_tracks row of the album,
    // changed or not — so it runs only when the name actually changes.
    writeCore: db.prepare(`UPDATE albums SET year = ?, year_min = ?, year_max = ?, track_count = ?,
                                             duration_total = ?, compilation = ?, album_artist = ?,
                                             agg_dirty = 0 WHERE id = ?`),
    writeName: db.prepare('UPDATE albums SET name = ? WHERE id = ?'),
  };
}

function refreshOne(s, id) {
  const r = s.read.get(id);
  if (!r) { return; }                     // deleted between pick and refresh
  if (r.n === 0) {
    s.writeCore.run(r.year, r.year_min, r.year_max, 0, 0, r.compilation, r.album_artist, id);
    return;
  }
  s.writeCore.run(r.mode_year ?? null, r.ymin ?? null, r.ymax ?? null, r.n, r.dur,
    r.comp ? 1 : 0, r.mode_album_artist ?? null, id);
  const name = r.mode_name ?? r.name;
  if (name !== r.name) { s.writeName.run(name, id); }
}

// Refresh every dirty album. Returns the number of albums refreshed.
//
// `expectedSchemaVersion` re-verifies PRAGMA user_version before every
// chunk (same guard as the orphan sweep: a migration by another instance
// landing between autocommit chunks must abort, not corrupt). Throws the
// "schema-version guard:" error the scanner maps to its exit code.
export function refreshDirtyAlbums(db, { yieldBetweenChunks = false, expectedSchemaVersion = null } = {}) {
  const s = prepareStatements(db);
  const versionStmt = expectedSchemaVersion !== null ? db.prepare('PRAGMA user_version') : null;
  let refreshed = 0;
  for (;;) {
    if (versionStmt) {
      const v = versionStmt.get().user_version;
      if (v !== expectedSchemaVersion) {
        throw new Error('schema-version guard: DB schema changed mid-refresh '
          + `(V${expectedSchemaVersion} -> V${v}) — aborting album aggregate refresh`);
      }
    }
    const ids = s.pick.all().map((r) => r.id);
    if (ids.length === 0) { break; }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) { refreshOne(s, id); }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_e) { /* already rolled back */ }
      throw err;
    }
    refreshed += ids.length;
    if (ids.length < ALBUM_AGG_CHUNK) { break; }
    if (yieldBetweenChunks) { chunkYield(); }
  }
  return refreshed;
}
