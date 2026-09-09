// Artist aggregate refresh (V71).
//
// Since V71 an artist row's display `name`, `order_name`, `track_count` and
// `album_count` are DERIVED from its credits. Every credit row carries the
// raw spelling it was tagged with (track_artists.tag_name /
// album_artists.tag_name), and triggers on those tables (SCHEMA_V71) flag
// the artist `agg_dirty = 1` whenever a credit is added, removed or has its
// spelling changed; the scanner's fill of `sort_name` flags it too.
// refreshDirtyArtists() recomputes the flagged rows. The scanners call it
// at scan end after the album refresh (album_count counts surviving
// albums); the server calls it after the ytdl insert.
//
// Consensus rules (order-independent — a parallel walk cannot make two
// scans of one library disagree):
//   name         most common tag_name across the artist's track AND album
//                credits (tie → smallest, BINARY). Every credit on the row
//                shares the row's name_key by construction, so the mode is
//                always a spelling of the same artist. The seeded Various
//                Artists row is never renamed: its fallback credits vote
//                with the canonical spelling, and a library that spells it
//                differently in its own tags must not rename the sentinel
//                every other feature keys on.
//   order_name   orderName(name, sort_name) — see src/db/name-key.js.
//   track_count  COUNT(DISTINCT track_id) over track_artists.
//   album_count  COUNT(DISTINCT album_id) over album_artists — the album
//                credits (ALBUMARTIST, or the fallback chain), not every
//                album the artist appears on.
//
// Mirrored in rust-parser/src/main.rs (refresh_dirty_artists). Keep the SQL
// and the tie-breaks byte-identical — the scanner-parity snapshot compares
// these columns across engines.

import { chunkYield, VARIOUS_ARTISTS_MBZ_ID } from './orphan-cleanup.js';
import { orderName } from './name-key.js';

const ARTIST_AGG_CHUNK = 200;

const CONSENSUS_SQL = `
  SELECT a.name, a.sort_name, a.mbz_artist_id,
         (SELECT COUNT(DISTINCT track_id) FROM track_artists WHERE artist_id = a.id) AS n_tracks,
         (SELECT COUNT(DISTINCT album_id) FROM album_artists WHERE artist_id = a.id) AS n_albums,
         (SELECT tag_name FROM (
            SELECT tag_name FROM track_artists WHERE artist_id = a.id AND tag_name IS NOT NULL
            UNION ALL
            SELECT tag_name FROM album_artists WHERE artist_id = a.id AND tag_name IS NOT NULL)
           GROUP BY tag_name ORDER BY COUNT(*) DESC, tag_name ASC LIMIT 1) AS mode_name
    FROM artists a WHERE a.id = ?`;

function prepareStatements(db) {
  return {
    pick: db.prepare(`SELECT id FROM artists WHERE agg_dirty = 1 ORDER BY id LIMIT ${ARTIST_AGG_CHUNK}`),
    read: db.prepare(CONSENSUS_SQL),
    // name has its own statement: an UPDATE listing `name` in its SET clause
    // fires the artists_au_fts fan-out into every fts_tracks row of the
    // artist, changed or not — so it runs only when the name changes.
    writeCore: db.prepare(`UPDATE artists SET order_name = ?, track_count = ?, album_count = ?,
                                              agg_dirty = 0 WHERE id = ?`),
    writeName: db.prepare('UPDATE artists SET name = ? WHERE id = ?'),
  };
}

function refreshOne(s, id) {
  const r = s.read.get(id);
  if (!r) { return; }                      // deleted between pick and refresh
  const pinned = r.mbz_artist_id === VARIOUS_ARTISTS_MBZ_ID;
  const name = (!pinned && r.mode_name) ? r.mode_name : r.name;
  s.writeCore.run(orderName(name, r.sort_name), r.n_tracks, r.n_albums, id);
  if (name !== r.name) { s.writeName.run(name, id); }
}

// Refresh every dirty artist. Returns the number of artists refreshed.
// Same schema-version guard + chunking contract as refreshDirtyAlbums.
export function refreshDirtyArtists(db, { yieldBetweenChunks = false, expectedSchemaVersion = null } = {}) {
  const s = prepareStatements(db);
  const versionStmt = expectedSchemaVersion !== null ? db.prepare('PRAGMA user_version') : null;
  let refreshed = 0;
  for (;;) {
    if (versionStmt) {
      const v = versionStmt.get().user_version;
      if (v !== expectedSchemaVersion) {
        throw new Error('schema-version guard: DB schema changed mid-refresh '
          + `(V${expectedSchemaVersion} -> V${v}) — aborting artist aggregate refresh`);
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
    if (ids.length < ARTIST_AGG_CHUNK) { break; }
    if (yieldBetweenChunks) { chunkYield(); }
  }
  return refreshed;
}
