// Album row merging for migrations (V70 fragment merge, V71 artist merge).
//
// mergeAlbumInto() folds `loserId` into `survivorId`: the same hops
// src/db/album-migration.js performs when a re-mint orphans a row, minus
// its unreferenced guard (the loser is emptied right here). Plain SQL over
// a db handle, no imports — schema.js hooks run this inside a migration's
// BEGIN IMMEDIATE, where only prepare/all/run/exec may be used (node:sqlite
// + the Bun driver shim).
//
// Moving tracks fires tracks_au_fts (album_id is in its column list) so
// fts_tracks.album_name follows, and — since V70 — tracks_au_agg, which
// flags the survivor for the aggregate refresh; callers back-fill the
// aggregate columns afterwards (backfillAlbumAggregates) so the API's
// year-range match is right before any scan runs.

// `copyTagName`: V71 adds album_artists.tag_name; the V70 hook runs before
// that column exists and passes false.
export function mergeAlbumInto(db, survivorId, loserId, { copyTagName = true } = {}) {
  if (survivorId === loserId) { return; }
  const tagName = copyTagName ? ', tag_name' : '';
  db.prepare('UPDATE tracks SET album_id = ? WHERE album_id = ?').run(survivorId, loserId);
  db.prepare(`
    INSERT INTO user_album_stars (user_id, album_id, starred_at)
    SELECT user_id, ?, starred_at FROM user_album_stars WHERE album_id = ?
    ON CONFLICT(user_id, album_id) DO UPDATE SET
      starred_at = MIN(user_album_stars.starred_at, excluded.starred_at)`).run(survivorId, loserId);
  db.prepare(`
    INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position${tagName})
    SELECT ?, artist_id, role, position${tagName} FROM album_artists WHERE album_id = ?`).run(survivorId, loserId);
  db.prepare(`
    INSERT OR IGNORE INTO album_art (album_id, art_id, source, picture_type, position)
    SELECT ?, art_id, source, picture_type, position FROM album_art WHERE album_id = ?`).run(survivorId, loserId);
  db.prepare(`
    INSERT OR IGNORE INTO album_art_lookups (album_id, last_attempt_at, outcome, attempts, fetched_hash)
    SELECT ?, last_attempt_at, outcome, attempts, fetched_hash
      FROM album_art_lookups WHERE album_id = ?`).run(survivorId, loserId);
  // Fill-NULL the survivor's default art / MBIDs from the loser. SET
  // expressions read the pre-update row, so the source test on
  // album_art_file is the survivor's current value.
  db.prepare(`
    UPDATE albums SET
      album_art_source     = CASE WHEN album_art_file IS NULL
                               THEN (SELECT album_art_source FROM albums WHERE id = ?1)
                               ELSE album_art_source END,
      album_art_file       = COALESCE(album_art_file, (SELECT album_art_file FROM albums WHERE id = ?1)),
      mbz_album_id         = COALESCE(mbz_album_id, (SELECT mbz_album_id FROM albums WHERE id = ?1)),
      mbz_release_group_id = COALESCE(mbz_release_group_id, (SELECT mbz_release_group_id FROM albums WHERE id = ?1))
    WHERE id = ?2`).run(loserId, survivorId);
  // CASCADE reaps the loser's (already copied) child rows; albums_ad_fts
  // drops its fts_albums entry.
  db.prepare('DELETE FROM albums WHERE id = ?').run(loserId);
}

// Recompute year_min / year_max / track_count / duration_total for every
// album (or only the flagged ones) in one GROUP BY pass and clear agg_dirty.
// year / compilation / album_artist are left alone: the scan-end refresh
// derives those from the tag_* consensus inputs. Trackless rows keep the
// column defaults (0 / NULL).
export function backfillAlbumAggregates(db, { onlyDirty = false } = {}) {
  const dirtyOnly = onlyDirty ? 'AND albums.agg_dirty = 1' : '';
  db.exec(`
    UPDATE albums SET
      year_min = s.ymin, year_max = s.ymax, track_count = s.n, duration_total = s.dur
    FROM (SELECT album_id, MIN(year) AS ymin, MAX(year) AS ymax, COUNT(*) AS n,
                 COALESCE(SUM(duration), 0) AS dur
            FROM tracks WHERE album_id IS NOT NULL GROUP BY album_id) AS s
    WHERE s.album_id = albums.id ${dirtyOnly};
    UPDATE albums SET agg_dirty = 0 ${onlyDirty ? 'WHERE agg_dirty = 1' : ''};`);
}
