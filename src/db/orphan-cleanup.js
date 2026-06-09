// Chunked orphan cleanup for end-of-scan and post-vpath-delete cleanup.
//
// Two callers:
//   - src/db/scanner.mjs (and rust-parser/src/main.rs in Rust): runs at
//     the end of every scan, after the per-track loop's final COMMIT, to
//     remove albums / artists / genres that no track references anymore.
//   - src/util/admin.js removeDirectory: runs after the libraries DELETE
//     cascades through tracks, to remove the same kinds of orphans the
//     vpath's tracks were the last reference to.
//
// Both callers used to do this as one big DELETE per table. The artists
// query (4-way NOT IN against tracks / albums / track_artists /
// album_artists) can run past 5 seconds on libraries with hundreds of
// thousands of tracks and a long tail of one-track artists — long
// enough to bust SQLite's 5s busy_timeout for every concurrent API
// write that arrives during the cleanup. Chunking each DELETE in its
// own autocommit transaction releases the writer between batches so
// other processes / handlers can squeeze in.
//
// On small libraries this is one DELETE that handles everything plus
// one trivial no-op confirmation; on large libraries it's many small
// DELETEs that cooperate with concurrent writers instead of starving
// them.
//
// The Rust scanner has its own copy in rust-parser/src/main.rs because
// it's a separate process in a different language; the comments stay
// in lockstep with this file's design choices.

// Per-chunk row cap. Balances per-chunk lock duration (well under
// SQLite's 5s busy_timeout) against per-iteration overhead — each
// iteration re-runs the candidate-id subselect, which is the slow
// part on big libraries.
const ORPHAN_CHUNK_SIZE = 500;

// Repeatedly DELETE up to ORPHAN_CHUNK_SIZE rows from `table` whose
// ids match `selectIdsSql`, until no rows remain. SQLite's bundled
// build doesn't ship with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so the
// LIMIT goes on a subselect rather than the DELETE itself.
//
// Loop terminates when a chunk reports zero changes — the candidate
// query found no more orphans. Each `stmt.run()` is its own autocommit
// transaction (no surrounding BEGIN), which is exactly the property
// that lets concurrent writers in between iterations.
//
// `table` and `selectIdsSql` are interpolated into the SQL string —
// callers are responsible for passing trusted (non-user-input) values.
function chunkedDelete(db, table, selectIdsSql) {
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE id IN (${selectIdsSql} LIMIT ${ORPHAN_CHUNK_SIZE})`,
  );
  while (true) {
    const r = stmt.run();
    if (r.changes === 0) { break; }
  }
}

// Orphan-id queries. An artist is "kept" if ANY of:
//   - tracks.artist_id references it (primary track artist)
//   - albums.artist_id references it (primary album artist)
//   - track_artists M2M references it (featured artists, V18)
//   - album_artists M2M references it (co-credited album artists, V18)
// Missing the M2M checks would orphan featured / credited artists
// whose only reference is the V18 M2M row, and CASCADE on artist_id
// would then drop the M2M rows too — silently eating the second entry
// of a "Artist A feat. Artist B" split.
// NOT EXISTS (correlated) rather than NOT IN (… SELECT DISTINCT …): it's a
// per-row indexed probe against idx_tracks_artist / idx_albums_artist /
// idx_track_artists_artist / idx_album_artists_artist (and the album/genre
// equivalents) instead of materialising a DISTINCT set, so it's faster on
// large libraries and needs no IS-NOT-NULL guard (a NULL fk simply doesn't
// match the correlation). Semantically identical to the previous NOT IN.
// MUST stay in lockstep with rust-parser/src/main.rs's run_scan cleanup.
const ORPHAN_ALBUMS_SQL = 'SELECT id FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)';
const ORPHAN_ARTISTS_SQL = `SELECT id FROM artists
  WHERE NOT EXISTS (SELECT 1 FROM tracks        WHERE tracks.artist_id        = artists.id)
    AND NOT EXISTS (SELECT 1 FROM albums        WHERE albums.artist_id        = artists.id)
    AND NOT EXISTS (SELECT 1 FROM track_artists WHERE track_artists.artist_id = artists.id)
    AND NOT EXISTS (SELECT 1 FROM album_artists WHERE album_artists.artist_id = artists.id)`;
const ORPHAN_GENRES_SQL = 'SELECT id FROM genres WHERE NOT EXISTS (SELECT 1 FROM track_genres WHERE track_genres.genre_id = genres.id)';

// Delete tracks not seen in the just-finished scan (file removed on disk),
// CHUNKED so the single WAL writer lock is released between batches. Run as
// one `DELETE FROM tracks WHERE library_id=? AND scan_id!=?` it holds the
// writer for the entire cascade (track_genres / track_artists) + the per-row
// FTS5 AFTER DELETE trigger — on a large-deletion scan (moved/renamed top
// folder, migration force-rescan, emptied library) that can run past the 5s
// busy_timeout and stall concurrent API writes from the main server. Same
// cooperate-with-writers pattern as chunkedDelete above; ORPHAN_CHUNK_SIZE
// (500) keeps each chunk well under busy_timeout. Returns the total rows
// deleted so the caller's scanComplete count stays accurate. Mirrors
// chunked_delete_stale_tracks in rust-parser/src/main.rs.
export function deleteStaleTracks(db, libraryId, scanId) {
  const stmt = db.prepare(
    `DELETE FROM tracks WHERE id IN (
       SELECT id FROM tracks WHERE library_id = ? AND scan_id != ? LIMIT ${ORPHAN_CHUNK_SIZE}
     )`,
  );
  let total = 0;
  while (true) {
    const r = stmt.run(libraryId, scanId);
    total += r.changes;
    if (r.changes === 0) { break; }
  }
  return total;
}

// Run all three orphan DELETEs in sequence. Order matters: albums first,
// then artists (so artists referenced ONLY by orphaned albums become
// eligible for deletion via the artists-NOT-IN-albums clause), then
// genres (independent of the other two).
export function cleanupOrphans(db) {
  chunkedDelete(db, 'albums',  ORPHAN_ALBUMS_SQL);
  chunkedDelete(db, 'artists', ORPHAN_ARTISTS_SQL);
  chunkedDelete(db, 'genres',  ORPHAN_GENRES_SQL);
}
