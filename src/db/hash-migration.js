/**
 * Hash migration for content-change rescans.
 *
 * When the scanner re-parses a file whose bytes changed (typical trigger:
 * an external ID3 tag editor), the file's MD5 changes. User-facing rows
 * that key on track_hash — user_metadata (stars, ratings, play counts),
 * user_bookmarks, user_play_queue (scalar + JSON array of hashes) — still
 * reference the old hash. This helper points them at the new one so the
 * user's state follows the file's new identity.
 *
 * Mirrored in rust-parser/src/main.rs#migrate_hash_references — the Rust
 * scanner inlines the same logic rather than cross-processing into JS.
 * Any behaviour change must be reflected in both places (and covered by
 * the unit test in test/hash-migration.test.mjs).
 */

/**
 * Migrate all user_* rows referring to oldHash over to newHash.
 *
 * @param {object} db  A node:sqlite DatabaseSync or any object exposing
 *                     `.prepare(sql)` returning something with `.run()` /
 *                     `.all()`.
 * @param {string} oldHash
 * @param {string} newHash
 * @param {object} [opts]
 * @param {boolean} [opts.schemeRekey=false] — true when the canonical hash
 *        changed because the HASHING SCHEME changed (the V59 generation
 *        re-key of unchanged bytes), false for a genuine content change
 *        (new bytes at the same path). USER state (stars/plays/bookmarks/
 *        queue) and lyrics follow in both cases — path-is-identity for
 *        user intent, deliberate long-standing behavior. CONTENT-DERIVED
 *        per-hash state (the AcoustID and BPM/key failure-cooldown
 *        ledgers) follows ONLY a scheme re-key: carrying it across a
 *        content change would suppress fingerprinting/analysis of audio
 *        that was never attempted. (One accepted blind spot: a file whose
 *        content ALSO changed while the server was down across the V59
 *        epoch re-parses as a scheme re-key — the old bytes are gone, so
 *        the two causes are indistinguishable for that one window.)
 * @returns {{metadata: number, bookmarks: number, queues: number}} counts of
 *          rows migrated per table.
 */
export function migrateHashReferences(db, oldHash, newHash, { schemeRekey = false } = {}) {
  if (!oldHash || !newHash || oldHash === newHash) {
    return { metadata: 0, bookmarks: 0, queues: 0 };
  }

  // MERGE, not bare UPDATE: a user can hold rows under BOTH identities
  // (the pre-V52 scrobble-by-filepath bug keyed plays on file_hash while
  // star/rating paths keyed on audio_hash). A bare UPDATE then hits the
  // UNIQUE(user_id, track_hash) constraint and aborts the per-file scan
  // txn — and re-aborts on every rescan, since nothing ever clears the
  // collision. Same merge semantics as the V52 repair migration:
  // play_count sums, starred_at keeps the earliest, last_played the
  // latest, rating prefers the target row's.
  let metadata = 0;
  for (const o of db.prepare(
    'SELECT * FROM user_metadata WHERE track_hash = ?').all(oldHash)) {
    const n = db.prepare(
      'SELECT * FROM user_metadata WHERE user_id = ? AND track_hash = ?'
    ).get(o.user_id, newHash);
    if (!n) {
      db.prepare('UPDATE user_metadata SET track_hash = ? WHERE user_id = ? AND track_hash = ?')
        .run(newHash, o.user_id, oldHash);
    } else {
      const minNonNull = (a, b) => (a == null) ? b : (b == null) ? a : (a < b ? a : b);
      const maxNonNull = (a, b) => (a == null) ? b : (b == null) ? a : (a > b ? a : b);
      db.prepare(`UPDATE user_metadata SET play_count = ?, starred_at = ?,
                  last_played = ?, rating = ? WHERE user_id = ? AND track_hash = ?`)
        .run((n.play_count || 0) + (o.play_count || 0),
          minNonNull(n.starred_at, o.starred_at),
          maxNonNull(n.last_played, o.last_played),
          n.rating ?? o.rating,
          o.user_id, newHash);
      db.prepare('DELETE FROM user_metadata WHERE user_id = ? AND track_hash = ?')
        .run(o.user_id, oldHash);
    }
    metadata++;
  }

  // Bookmarks are a position, not an aggregate — most recently changed
  // row wins outright.
  let bookmarks = 0;
  for (const o of db.prepare(
    'SELECT * FROM user_bookmarks WHERE track_hash = ?').all(oldHash)) {
    const n = db.prepare(
      'SELECT * FROM user_bookmarks WHERE user_id = ? AND track_hash = ?'
    ).get(o.user_id, newHash);
    if (!n) {
      db.prepare('UPDATE user_bookmarks SET track_hash = ? WHERE user_id = ? AND track_hash = ?')
        .run(newHash, o.user_id, oldHash);
    } else {
      if ((o.changed_at || o.created_at || '') > (n.changed_at || n.created_at || '')) {
        db.prepare(`UPDATE user_bookmarks SET position_ms = ?, comment = ?, changed_at = ?
                    WHERE user_id = ? AND track_hash = ?`)
          .run(o.position_ms, o.comment, o.changed_at, o.user_id, newHash);
      }
      db.prepare('DELETE FROM user_bookmarks WHERE user_id = ? AND track_hash = ?')
        .run(o.user_id, oldHash);
    }
    bookmarks++;
  }

  // Canonical-hash-keyed sibling tables, one shared policy: the row
  // already AT the new identity wins (it is the fresher derivation); the
  // old-keyed row re-keys only when no canonical row exists.
  //   - lyrics_cache follows on EVERY canon change (long-standing
  //     behavior — lyrics ride with the path's user-facing identity);
  //   - acoustid_lookups (V56) and audio_analysis_lookups (V54) are
  //     failure-cooldown ledgers DERIVED FROM THE BYTES: they follow a
  //     scheme re-key (same bytes, new hash scheme) but must be LEFT
  //     BEHIND on a content change, or genuinely-new audio inherits a
  //     cooldown for attempts that never ran against it — the backfills'
  //     orphan sweeps then clear the stranded rows.
  const canonTables = schemeRekey
    ? ['lyrics_cache', 'acoustid_lookups', 'audio_analysis_lookups']
    : ['lyrics_cache'];
  for (const table of canonTables) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE audio_hash = ?`).get(newHash)) {
      db.prepare(`DELETE FROM ${table} WHERE audio_hash = ?`).run(oldHash);
    } else {
      db.prepare(`UPDATE ${table} SET audio_hash = ? WHERE audio_hash = ?`)
        .run(newHash, oldHash);
    }
  }

  // user_play_queue stores the queue as a JSON array plus a scalar
  // current_track_hash. Pull affected rows, swap occurrences in both
  // positions, write back. Quoting the hash with "…" in the instr()
  // filter avoids false-positive substring matches across MD5 hex values
  // (MD5s are 32-char; collisions as substrings are astronomically
  // unlikely but cheap to exclude).
  const rows = db.prepare(
    `SELECT user_id, current_track_hash, track_hashes_json
       FROM user_play_queue
      WHERE current_track_hash = ?
         OR instr(track_hashes_json, ?) > 0`
  ).all(oldHash, `"${oldHash}"`);

  let queuesUpdated = 0;
  const updateStmt = db.prepare(
    `UPDATE user_play_queue
        SET current_track_hash = ?, track_hashes_json = ?
      WHERE user_id = ?`
  );
  for (const row of rows) {
    let hashes;
    try { hashes = JSON.parse(row.track_hashes_json || '[]'); }
    catch { continue; }  // corrupt row — skip rather than block the scan
    if (!Array.isArray(hashes)) { continue; }
    const migrated = hashes.map(h => h === oldHash ? newHash : h);
    const newCurrent = row.current_track_hash === oldHash ? newHash : row.current_track_hash;
    updateStmt.run(newCurrent, JSON.stringify(migrated), row.user_id);
    queuesUpdated++;
  }

  return {
    metadata,
    bookmarks,
    queues: queuesUpdated,
  };
}
