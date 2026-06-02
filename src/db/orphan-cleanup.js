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
const ORPHAN_ALBUMS_SQL = 'SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)';
// V43 (audiobooks) reuses the `artists` table for book authors and series
// authors. Those references must ALSO keep an artist alive — otherwise a
// music scan's cleanup would try to delete an artist that's only an
// audiobook author, hitting the books/series FK (foreign_keys=ON) and
// aborting the scan, or (with ON DELETE SET NULL) silently stripping the
// book's authorship. The two trailing NOT-IN clauses prevent that.
// No table-exists guard is needed: cleanupOrphans only runs after the
// migration runner has brought the DB to the current SCHEMA_VERSION, so
// `books` and `series` always exist here. Keep in lockstep with the Rust
// copy in rust-parser/src/main.rs.
const ORPHAN_ARTISTS_SQL = `SELECT id FROM artists
  WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks         WHERE artist_id IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT artist_id FROM albums         WHERE artist_id IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT artist_id FROM track_artists)
    AND id NOT IN (SELECT DISTINCT artist_id FROM album_artists)
    AND id NOT IN (SELECT DISTINCT author_id FROM books          WHERE author_id IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT author_id FROM series         WHERE author_id IS NOT NULL)`;
const ORPHAN_GENRES_SQL = 'SELECT id FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM track_genres)';

// Run all three orphan DELETEs in sequence. Order matters: albums first,
// then artists (so artists referenced ONLY by orphaned albums become
// eligible for deletion via the artists-NOT-IN-albums clause), then
// genres (independent of the other two).
export function cleanupOrphans(db) {
  chunkedDelete(db, 'albums',  ORPHAN_ALBUMS_SQL);
  chunkedDelete(db, 'artists', ORPHAN_ARTISTS_SQL);
  chunkedDelete(db, 'genres',  ORPHAN_GENRES_SQL);
}
