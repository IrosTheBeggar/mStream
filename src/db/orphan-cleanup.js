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

import fs from 'fs';
import path from 'path';

// Per-chunk row cap. Balances per-chunk lock duration (well under
// SQLite's 5s busy_timeout) against per-iteration overhead — each
// iteration re-runs the candidate-id subselect, which is the slow
// part on big libraries.
const ORPHAN_CHUNK_SIZE = 500;

// Between full chunks the writer lock is otherwise free for only
// microseconds — far too narrow for the server's busy handler, which
// polls densely for ~330ms and then only once per 100ms (see the
// WRITER_YIELD comment in rust-parser/src/main.rs). 10-20ms jittered
// gives a waiting API write a real window and can't phase-lock with
// the 100ms retry cadence. The sleep is synchronous (Atomics.wait is
// allowed on Node's main thread), which is why it is OPT-IN: fine in
// the scanner (a dedicated child process), but it would pointlessly
// block the event loop when the SERVER runs these helpers
// (admin.js removeDirectory) — there is nobody to yield to when the
// would-be beneficiary is the sleeping process itself.
const YIELD_MIN_MS = 10;
const YIELD_JITTER_MS = 11; // yield = 10..=20ms
function chunkYield() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
    YIELD_MIN_MS + Math.floor(Math.random() * YIELD_JITTER_MS));
}

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
//
// `expectedSchemaVersion` (when given) re-verifies PRAGMA user_version
// before every chunk, exactly like deleteStaleTracks below: the loop is
// an unbounded sequence of autocommit transactions with deliberate yields
// between them — the widest windows of the whole scan for a migration by
// another instance to land in. Throws the "schema-version guard:" error
// so the scanner's exit-3 mapping covers it.
function chunkedDelete(db, table, selectIdsSql,
  { yieldBetweenChunks = false, expectedSchemaVersion = null } = {}) {
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE id IN (${selectIdsSql} LIMIT ${ORPHAN_CHUNK_SIZE})`,
  );
  const versionStmt = expectedSchemaVersion !== null
    ? db.prepare('PRAGMA user_version')
    : null;
  while (true) {
    if (versionStmt) {
      const v = versionStmt.get().user_version;
      if (v !== expectedSchemaVersion) {
        throw new Error(
          `schema-version guard: DB schema changed mid-cleanup ` +
          `(V${expectedSchemaVersion} -> V${v}) — aborting orphan cleanup of ${table}`);
      }
    }
    const r = stmt.run();
    if (r.changes === 0) { break; }
    // A full chunk means more work likely remains — give a waiting
    // server write a real window before re-taking the lock. Partial
    // chunks fall through to the terminating zero-changes pass.
    if (yieldBetweenChunks && r.changes === ORPHAN_CHUNK_SIZE) { chunkYield(); }
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
// one big DELETE it holds the writer for the entire cascade (track_genres /
// track_artists) + the per-row FTS5 AFTER DELETE trigger — on a
// large-deletion scan (moved/renamed top folder, migration force-rescan,
// emptied library) that can run past the 5s busy_timeout and stall
// concurrent API writes from the main server. Same cooperate-with-writers
// pattern as chunkedDelete above; ORPHAN_CHUNK_SIZE (500) keeps each chunk
// well under busy_timeout. Returns the total rows deleted so the caller's
// scanComplete count stays accurate. Mirrors chunked_delete_stale_tracks
// in rust-parser/src/main.rs.
//
// `candidates` is an array of {id, filepath} rows the caller computed as
// (rows that existed when the scan started) − (rows the walk accounted
// for), sorted by id — the scanner's in-memory seen tracking replaced the
// old per-row `UPDATE tracks SET scan_id = ?` marker (one row rewrite per
// unchanged file, the dominant write cost of a no-op rescan), so "not
// seen" is no longer a DB predicate. Rows inserted mid-scan by other
// writers (ytdl downloads land with scan_id NULL) are not in the
// scan-start snapshot and can never be candidates. NOTE one deliberate
// delta from the old `scan_id != ?` predicate: a PRE-existing row with
// scan_id NULL (a ytdl download from before this scan) used to be
// unsweepable forever — NULL never matched `!=` — even after its file
// was deleted from disk. Such rows are ordinary candidates now and
// converge out of the index once verify-absence proves the file gone.
//
// `expectedSchemaVersion` (when given) re-arms the scanner's mid-scan
// schema guard on EVERY chunk: the sweep is not one atomic DELETE but a
// sequence of autocommit transactions, and a migration by another
// instance could land between chunks. The PRAGMA read is trivial next to
// a 500-row cascade delete. Throws a "schema-version guard:" error so
// the caller can map it to the guard exit code. Only called from the
// scanner process, so the inter-chunk yield is unconditional here.
//
// VERIFY-ABSENCE: a row is only deleted after a fresh filesystem check
// proves its file is really gone. An unseen row is NOT proof of
// deletion — a swallowed per-file error (decode crash, EBUSY lock)
// leaves a LIVE track unseen, and the pre-hardening sweep deleted it,
// cascading the user's album/artist stars away permanently.
//
// Presence is decided from the PARENT DIRECTORY LISTING, not a per-file
// stat: a stat error is NOT proof of absence (EACCES/EIO on a degraded
// mount must keep data — fail closed), stats are case-insensitive on
// Windows/macOS (a case-only rename would resurrect the old-casing row
// forever; the listing gives exact on-disk names), and one readdir per
// directory beats one network round-trip per gone file on CIFS/NFS.
//
// Outcomes per candidate:
//  - under a failed-walk prefix → SKIPPED untouched (that subtree was
//    invisible this scan; neither delete nor claim it was seen);
//  - exact-case name present as a regular file (or a symlink resolving
//    to one under followSymlinks) → KEPT untouched — a swallowed
//    per-file error left it unaccounted for; the next scan simply
//    re-examines it (no row marker needed: the candidate list lives in
//    the scanner's memory and dies with the scan);
//  - name absent / not a file / directory listing ENOENT → DELETED;
//  - listing unreadable for any other reason → SKIPPED untouched.
//
// The library root is re-verified every chunk: a mount that vanishes
// mid-sweep would otherwise make every listing read ENOENT and erase
// the library. Mirrors chunked_delete_stale_tracks in
// rust-parser/src/main.rs. With libraryRoot null (no caller does this
// today) the sweep degrades to deleting every candidate unverified.
export function deleteStaleTracks(db, candidates, expectedSchemaVersion = null,
  { libraryRoot = null, followSymlinks = false, failedWalkPrefixes = [],
    supportedFiles = null } = {}) {
  const versionStmt = db.prepare('PRAGMA user_version');
  const KIND_FILE = 1; const KIND_SYMLINK = 2; const KIND_OTHER = 3;
  const listings = new Map(); // relDir -> Map(name -> kind) | null (unreadable)
  const getListing = (relDir) => {
    if (listings.has(relDir)) { return listings.get(relDir); }
    let result;
    try {
      const m = new Map();
      for (const ent of fs.readdirSync(path.join(libraryRoot, relDir), { withFileTypes: true })) {
        m.set(ent.name,
          ent.isFile() ? KIND_FILE : ent.isSymbolicLink() ? KIND_SYMLINK : KIND_OTHER);
      }
      result = m;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        // The directory itself is gone — its files are provably gone
        // with it. But first rule out two unverifiable look-alikes:
        // (a) the whole mount vanished inside this chunk (root re-check
        // TOCTOU), (b) under followSymlinks, an ancestor that still
        // lstat's as a symlink whose target is unreachable — a down
        // mountpoint, not a deletion.
        result = new Map();
        try { if (!fs.statSync(libraryRoot).isDirectory()) { result = null; } }
        catch (_e) { result = null; }
        if (result !== null && followSymlinks) {
          let anc = libraryRoot;
          for (const seg of relDir.split('/').filter(Boolean)) {
            anc = path.join(anc, seg);
            let lst;
            try { lst = fs.lstatSync(anc); } catch (_e) { break; } // first missing — genuinely gone
            if (lst.isSymbolicLink()) {
              let resolvable = true;
              try { fs.statSync(anc); } catch (_e) { resolvable = false; }
              if (!resolvable) { result = null; break; } // down mountpoint
            }
          }
        }
      } else {
        result = null; // unreadable — fail closed
      }
    }
    listings.set(relDir, result);
    return result;
  };
  const isShielded = (rel) => failedWalkPrefixes.some(p =>
    p === '' || rel === p
    || (rel.length > p.length && rel.startsWith(p) && rel[p.length] === '/'));
  const rootAccessible = () => {
    try { return fs.statSync(libraryRoot).isDirectory(); } catch (_err) { return false; }
  };

  let total = 0;
  let skipped = 0;
  for (let offset = 0; offset < candidates.length; offset += ORPHAN_CHUNK_SIZE) {
    if (expectedSchemaVersion !== null) {
      const v = versionStmt.get().user_version;
      if (v !== expectedSchemaVersion) {
        throw new Error(
          `schema-version guard: DB schema changed mid-sweep ` +
          `(V${expectedSchemaVersion} -> V${v}) — aborting stale-track cleanup`);
      }
    }
    if (libraryRoot !== null && !rootAccessible()) {
      console.error(
        `Warning: library root became inaccessible mid-sweep (${libraryRoot}) — ` +
        `aborting stale-track cleanup after ${total} rows to avoid wiping the library`);
      break;
    }
    const chunk = candidates.slice(offset, offset + ORPHAN_CHUNK_SIZE);
    const fullChunk = chunk.length === ORPHAN_CHUNK_SIZE;

    let survivors = 0;
    const doomed = [];
    for (const c of chunk) {
      if (libraryRoot === null) { doomed.push(c); continue; } // delete unverified
      if (isShielded(c.filepath)) { skipped++; continue; }
      const i = c.filepath.lastIndexOf('/');
      const dirRel = i === -1 ? '' : c.filepath.slice(0, i);
      const name = i === -1 ? c.filepath : c.filepath.slice(i + 1);
      const listing = getListing(dirRel);
      if (listing === null) { skipped++; continue; }
      // Walk-faithful presence includes the EXTENSION filter: a file whose
      // extension left supportedFiles would never be indexed by the walk,
      // so its row converges out of the index instead of becoming an
      // immortal candidate warned about on every scan.
      if (supportedFiles !== null
          && !supportedFiles[name.split('.').pop().toLowerCase()]) {
        doomed.push(c);
        continue;
      }
      const kind = listing.get(name);
      if (kind === KIND_FILE) {
        survivors++;
      } else if (kind === KIND_SYMLINK && followSymlinks) {
        // Walk-faithful: a symlink the walk would follow counts as
        // present only if its target resolves to a regular file now.
        let present;
        try { present = fs.statSync(path.join(libraryRoot, c.filepath)).isFile(); }
        catch (err) {
          present = (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? false : null;
        }
        if (present === null) { skipped++; }
        else if (present) { survivors++; }
        else { doomed.push(c); }
      } else {
        // Exact-case name missing, a non-file, or a symlink the
        // no-follow walk would not index.
        doomed.push(c);
      }
    }
    if (survivors > 0) {
      // No row write needed to "keep" them — the candidate list is
      // in-memory and dies with this scan; the next scan just re-derives
      // it. Warn so a chronic swallowed-error subtree stays
      // operator-visible.
      console.error(
        `Warning: ${survivors} track(s) missed by this scan still exist on ` +
        'disk — keeping them; a swallowed per-file error likely occurred');
    }
    if (doomed.length > 0) {
      // Row-value guard (id AND filepath, both from the scan-start
      // snapshot): the absence check ran against the snapshot path, so a
      // row whose filepath were ever rewritten mid-scan by some future
      // rename/move API would fall out of the doomed set instead of
      // being deleted off a stale verdict. (No such writer exists today;
      // the old per-chunk re-SELECT was immune by construction — this
      // keeps the property.) AUTOINCREMENT already guarantees ids are
      // never reused, so the pair is stable evidence.
      const r = db.prepare(
        `DELETE FROM tracks WHERE (id, filepath) IN (VALUES ${
          doomed.map(() => '(?, ?)').join(',')})`,
      ).run(...doomed.flatMap(d => [d.id, d.filepath]));
      total += r.changes;
    }
    if (fullChunk) { chunkYield(); }
  }
  if (skipped > 0) {
    console.error(
      `Warning: ${skipped} stale-candidate row(s) left untouched because their ` +
      'subtree could not be verified this scan (walk errors or unreadable directories)');
  }
  return total;
}

// Run all three orphan DELETEs in sequence. Order matters: albums first,
// then artists (so artists referenced ONLY by orphaned albums become
// eligible for deletion via the artists-NOT-IN-albums clause), then
// genres (independent of the other two).
export function cleanupOrphans(db, { yieldBetweenChunks = false, expectedSchemaVersion = null } = {}) {
  chunkedDelete(db, 'albums',  ORPHAN_ALBUMS_SQL,  { yieldBetweenChunks, expectedSchemaVersion });
  chunkedDelete(db, 'artists', ORPHAN_ARTISTS_SQL, { yieldBetweenChunks, expectedSchemaVersion });
  chunkedDelete(db, 'genres',  ORPHAN_GENRES_SQL,  { yieldBetweenChunks, expectedSchemaVersion });
}
