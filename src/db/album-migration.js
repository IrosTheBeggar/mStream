/**
 * User-star (and album-art-state) migration on album/artist id changes.
 *
 * When a rescan re-parses a track and its album_id or artist_id lands on
 * a DIFFERENT row (compilation collapse, year/ALBUMARTIST re-tag, artist
 * rename), the old row loses a reference. Once it loses its LAST
 * reference, the scan-end orphan sweep deletes it — and with
 * foreign_keys=ON the delete CASCADEs user_album_stars /
 * user_artist_stars (and album_art_lookups + album_art links) away
 * permanently. These helpers re-home that state from the dying row to
 * its heir before the sweep runs.
 *
 * THE UNREFERENCED GUARD: state moves only when the old row no longer
 * has any keep-reference (same predicates as the orphan sweep in
 * orphan-cleanup.js). One track moving off a 12-track album must NOT
 * steal the album's star — the album lives on. During a rename rescan
 * the guard naturally fires on the LAST track that flips; if the scan
 * dies before that, the sweep's own star keep-condition preserves the
 * old row as a ghost until a later scan finishes the job.
 *
 * Mirrored in rust-parser/src/main.rs (migrate_album_stars /
 * migrate_artist_stars / migrate_album_art_state). Any behavioural
 * change must land in both places simultaneously.
 */

import { VARIOUS_ARTISTS_MBZ_ID } from './orphan-cleanup.js';

// Keep-reference probes — MUST match the orphan sweep's keep-conditions
// (orphan-cleanup.js ORPHAN_ALBUMS_SQL / ORPHAN_ARTISTS_SQL, minus the
// star clauses: stars are exactly the state being re-homed).
function albumStillReferenced(db, albumId) {
  return !!db.prepare(
    'SELECT 1 FROM tracks WHERE album_id = ? LIMIT 1'
  ).get(albumId);
}

// Album references only count when the album itself is LIVE (has tracks
// or stars). During a rename rescan the old albums re-mint too (album
// identity includes artist_id), so the old artist stays "referenced" by
// its own dying, trackless album rows right up until the sweep — a
// plain albums/album_artists probe would block the re-home forever.
// Dying albums have already handed their stars to their heirs by the
// time this runs (migrateAlbumStars goes first), so a starred album
// here is a deliberate ghost and rightly keeps its artist.
function artistStillReferenced(db, artistId) {
  return !!db.prepare(`
    SELECT 1 WHERE EXISTS (SELECT 1 FROM tracks        WHERE artist_id = ?1)
              OR EXISTS (SELECT 1 FROM track_artists WHERE artist_id = ?1)
              OR EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = ?1
                   AND (EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)
                     OR EXISTS (SELECT 1 FROM user_album_stars s WHERE s.album_id = al.id)))
              OR EXISTS (SELECT 1 FROM album_artists aa WHERE aa.artist_id = ?1
                   AND (EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = aa.album_id)
                     OR EXISTS (SELECT 1 FROM user_album_stars s WHERE s.album_id = aa.album_id)))
  `).get(artistId);
}

/**
 * Re-map user_album_stars rows from one album id to another, when (and
 * only when) the old album has lost its last track. Idempotent. A user
 * who already starred the target keeps the earlier starred_at (union
 * semantics).
 *
 * @returns {number} count of rows migrated
 */
export function migrateAlbumStars(db, oldAlbumId, newAlbumId) {
  if (!Number.isFinite(oldAlbumId) || !Number.isFinite(newAlbumId)) { return 0; }
  if (oldAlbumId === newAlbumId) { return 0; }
  if (albumStillReferenced(db, oldAlbumId)) { return 0; }

  const stars = db.prepare(
    'SELECT user_id, starred_at FROM user_album_stars WHERE album_id = ?'
  ).all(oldAlbumId);

  if (!stars.length) { return 0; }

  const upsert = db.prepare(`
    INSERT INTO user_album_stars (user_id, album_id, starred_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, album_id) DO UPDATE SET
      starred_at = MIN(user_album_stars.starred_at, excluded.starred_at)
  `);
  const deleteOld = db.prepare(
    'DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?'
  );

  let migrated = 0;
  for (const s of stars) {
    upsert.run(s.user_id, newAlbumId, s.starred_at);
    deleteOld.run(s.user_id, oldAlbumId);
    migrated++;
  }
  return migrated;
}

/**
 * Artist twin of migrateAlbumStars: re-map user_artist_stars when the
 * old artist has lost its last reference (track / album / either M2M).
 * Fires from two call sites: a track's artist_id flip (artist re-tag)
 * and an album's artist_id flip (ALBUMARTIST re-tag, where no track-
 * level flip ever happens).
 *
 * @returns {number} count of rows migrated
 */
export function migrateArtistStars(db, oldArtistId, newArtistId) {
  if (!Number.isFinite(oldArtistId) || !Number.isFinite(newArtistId)) { return 0; }
  if (oldArtistId === newArtistId) { return 0; }
  // Various Artists is sweep-exempt — its stars are never in danger, so
  // they must never walk onto a specific artist (an ALBUMARTIST re-tag
  // or compilation un-flag re-mints VA-owned albums; without this, that
  // hop would claim the user's VA star for the new album's artist).
  const oldMbz = db.prepare(
    'SELECT mbz_artist_id FROM artists WHERE id = ?'
  ).get(oldArtistId)?.mbz_artist_id;
  if (oldMbz === VARIOUS_ARTISTS_MBZ_ID) { return 0; }
  if (artistStillReferenced(db, oldArtistId)) { return 0; }

  const stars = db.prepare(
    'SELECT user_id, starred_at FROM user_artist_stars WHERE artist_id = ?'
  ).all(oldArtistId);

  if (!stars.length) { return 0; }

  const upsert = db.prepare(`
    INSERT INTO user_artist_stars (user_id, artist_id, starred_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, artist_id) DO UPDATE SET
      starred_at = MIN(user_artist_stars.starred_at, excluded.starred_at)
  `);
  const deleteOld = db.prepare(
    'DELETE FROM user_artist_stars WHERE user_id = ? AND artist_id = ?'
  );

  let migrated = 0;
  for (const s of stars) {
    upsert.run(s.user_id, newArtistId, s.starred_at);
    deleteOld.run(s.user_id, oldArtistId);
    migrated++;
  }
  return migrated;
}

/**
 * Carry album-art state across an album re-mint, under the same
 * unreferenced guard as the stars. Without this, the sweep's CASCADE
 * destroys the V51 lookup row (the downloader's negative cache — its
 * loss forces re-downloads and re-burns notfound cooldowns) and any
 * service/manual gallery links the downloader or a user added.
 *
 *  - album_art junction rows are COPIED (OR IGNORE — the heir may
 *    already carry the same image from its own tracks' parses).
 *  - album_art_lookups MOVES unless the heir already has its own row
 *    (album_id is the PK; the heir's own attempt history wins).
 *  - the legacy default pointer is carried fill-NULL-only and only for
 *    non-scanner sources: scanner art re-derives from the heir's own
 *    parses, and a non-NULL heir default must never be overwritten.
 */
export function migrateAlbumArtState(db, oldAlbumId, newAlbumId) {
  if (!Number.isFinite(oldAlbumId) || !Number.isFinite(newAlbumId)) { return; }
  if (oldAlbumId === newAlbumId) { return; }
  if (albumStillReferenced(db, oldAlbumId)) { return; }

  db.prepare(`
    INSERT OR IGNORE INTO album_art (album_id, art_id, source, picture_type, position)
    SELECT ?, art_id, source, picture_type, position FROM album_art WHERE album_id = ?
  `).run(newAlbumId, oldAlbumId);

  db.prepare(`
    INSERT OR IGNORE INTO album_art_lookups (album_id, last_attempt_at, outcome, attempts, fetched_hash)
    SELECT ?, last_attempt_at, outcome, attempts, fetched_hash
      FROM album_art_lookups WHERE album_id = ?
  `).run(newAlbumId, oldAlbumId);
  db.prepare('DELETE FROM album_art_lookups WHERE album_id = ?').run(oldAlbumId);

  db.prepare(`
    UPDATE albums SET
      album_art_file   = (SELECT album_art_file   FROM albums WHERE id = ?1),
      album_art_source = (SELECT album_art_source FROM albums WHERE id = ?1)
    WHERE id = ?2
      AND album_art_file IS NULL
      AND (SELECT album_art_file FROM albums WHERE id = ?1) IS NOT NULL
      AND (SELECT album_art_source FROM albums WHERE id = ?1)
          NOT IN ('embedded', 'folder')
  `).run(oldAlbumId, newAlbumId);
}
