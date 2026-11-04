// The music map's mirror — keeps mstream.db's track_map (V81) in step with
// discovery.db's map_points, one generation (layout_id) at a time, and owns
// the serving pointer in track_map_meta.
//
// Positions are keyed by canonical audio hash in discovery.db (a moved file
// keeps its spot); the mirror carries tracks.id, so the map routes can apply
// libraryFilter and JOIN track_moods / user_metadata in one query. Every
// member of a near-duplicate group carries its dot's values in map_points,
// so each hash maps straight to its row — copies and near-duplicates share
// a dot, and there is no representative lookup to go stale on a re-key.
//
// Only the map worker (src/db/map-layout.mjs) calls this, so the server's
// event loop never pays for it. Singleton-free: handles come in as
// arguments (the worker opens its own), and the one import is the
// singleton-free track-hashes.js.
//
// Double buffer. A rebuild or refit writes a NEW generation while the old
// one serves: invisible, because routes filter track_map on the pointer, so
// its chunks do not move rev. The flip is one tiny transaction; the old
// generation's rows are then deleted in chunks. Place and mirror runs
// reconcile the SERVING generation in place, and every transaction of
// theirs that changes a row bumps rev in the same transaction — the map
// routes' ETag moves with the rows it describes. The pointer decides what
// "serving" means, inside each transaction, so a caller cannot get it
// wrong. Every write transaction holds at most `chunk` rows (2,000 by
// default): the server's synchronous writes wait on this lock with
// busy_timeout 5000 and a blocked event loop.
//
// Positional parameters and paged .all() reads only: under Bun the driver
// is the bun:sqlite shim (no iterate(), no named parameters).

import { tracksByCanonicalHash } from './track-hashes.js';

export const TRACK_MAP_CHUNK = 2000;
// Keyset page for the reads (points, existing rows).
const PAGE = 5000;

// A map coordinate as the mirror stores it and cols-v1 sends it: u16 =
// round(clamp(v, 0, 1) × 65535). Map units can sit up to 0.02 outside
// [0, 1] after a warm refit; the clamp pins those to the edge.
function toU16(v) {
  if (!Number.isFinite(v)) { return 0; }
  return Math.round(Math.min(1, Math.max(0, v)) * 65535);
}

function checkChunk(chunk) {
  if (!Number.isInteger(chunk) || chunk < 1) {
    throw new RangeError(`track_map chunk must be a positive integer, got ${chunk}`);
  }
}

function inTransaction(mainDb, fn) {
  mainDb.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    mainDb.exec('COMMIT');
    return out;
  } catch (err) {
    try { mainDb.exec('ROLLBACK'); } catch (_e) { /* not in a transaction */ }
    throw err;
  }
}

/**
 * The serving pointer, as stored: { active_layout, map_epoch, rev,
 * added_max } (active_layout null = no map). A missing row reads as the
 * empty pointer.
 */
export function readTrackMapPointer(mainDb) {
  const p = mainDb.prepare(
    'SELECT active_layout, map_epoch, rev, added_max FROM track_map_meta WHERE id = 1').get();
  if (!p) { return { active_layout: null, map_epoch: null, rev: 0, added_max: null }; }
  return { active_layout: p.active_layout, map_epoch: p.map_epoch, rev: p.rev, added_max: p.added_max };
}

/**
 * Whether `pointer` (readTrackMapPointer's shape) names a layout this
 * discovery.db can serve: its map_epoch equals discovery_meta.map_epoch —
 * a pointer from a deleted or replaced discovery.db, or from before a
 * map-table reset, never matches — and its layout is 'ready'.
 */
export function mapPointerValid(pointer, ddb) {
  if (!pointer || pointer.active_layout === null || pointer.active_layout === undefined
      || !pointer.map_epoch) {
    return false;
  }
  const epoch = ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'map_epoch'").get()?.value;
  if (!epoch || epoch !== pointer.map_epoch) { return false; }
  const layout = ddb.prepare('SELECT state FROM map_layouts WHERE id = ?').get(pointer.active_layout);
  return layout?.state === 'ready';
}

/** MAX(tracks.created_at) over one generation's tracks, or null when it is empty. */
export function generationAddedMax(mainDb, layoutId) {
  const row = mainDb.prepare(`
    SELECT MAX(t.created_at) AS added_max
      FROM track_map m JOIN tracks t ON t.id = m.track_id
     WHERE m.layout_id = ?
  `).get(layoutId);
  return row?.added_max ?? null;
}

/**
 * Reconcile track_map generation `layoutId` with discovery.db's map_points
 * of that layout: one row per library track whose canonical hash has a
 * point, holding the point's (its dot's) values, and no row for any other
 * track — an exact mirror, unlike mood-sync's leave-alone rule.
 *
 *   1. read the points, keyset by id;
 *   2. tracksByCanonicalHash: hash → [track ids];
 *   3. read the generation's existing rows, keyset by track_id;
 *   4. diff (a merge over track ids): rows that differ or are missing are
 *      upserted, rows with no desired counterpart deleted;
 *   5. write in BEGIN IMMEDIATE transactions of at most `chunk` rows. A
 *      transaction that changed a row of the generation the pointer names
 *      also bumps rev. Inserts are FK-guarded (INSERT … SELECT … WHERE
 *      EXISTS): a track deleted meanwhile is skipped, never an abort.
 *
 * Nothing differs → nothing is written and rev does not move. `addedMax`
 * (MAX(tracks.created_at) over the generation) is read after the writes:
 * written to the pointer when this generation serves and it changed (in a
 * statement of its own — rev reads it directly, so it needs no bump), and
 * returned either way, for flipTrackMap when the generation is a new one.
 *
 * A `serving` option is not needed: track_map_meta decides, inside every
 * transaction.
 *
 * @param {DatabaseSync} mainDb    mstream.db (writes happen here)
 * @param {DatabaseSync} ddb       discovery.db (read-only use)
 * @param {number}       layoutId  the map_layouts id the generation mirrors
 * @param {object}       [opts]
 * @param {number}       [opts.chunk=2000]  rows per write transaction
 * @returns {{points: number, tracks: number, written: number, removed: number, addedMax: string|null}}
 */
export function reconcileTrackMap(mainDb, ddb, layoutId, { chunk = TRACK_MAP_CHUNK } = {}) {
  if (!Number.isInteger(layoutId)) {
    throw new TypeError(`reconcileTrackMap needs an integer layoutId, got ${layoutId}`);
  }
  checkChunk(chunk);
  const stats = { points: 0, tracks: 0, written: 0, removed: 0, addedMax: null };

  // 1–2. Desired rows: track id → [hash, dot, x, y, region0, region1, central0, central1].
  const tracksByHash = tracksByCanonicalHash(mainDb);
  const desired = new Map();
  // NOT INDEXED: a rowid range scan, sequential I/O and O(page) per page.
  // Left to itself the planner takes UNIQUE (layout_id, audio_hash) and
  // re-sorts the whole layout for every page.
  const pointPage = ddb.prepare(`
    SELECT id, audio_hash, dot, x, y, region0, region1, central0, central1
      FROM map_points NOT INDEXED
     WHERE layout_id = ? AND id > ?
     ORDER BY id
     LIMIT ${PAGE}
  `);
  for (let after = -1; ;) {
    const page = pointPage.all(layoutId, after);
    for (const p of page) {
      stats.points++;
      const ids = tracksByHash.get(p.audio_hash);
      if (!ids) { continue; }   // no library file for this hash (left the library)
      const row = [p.audio_hash, p.dot, toU16(p.x), toU16(p.y), p.region0, p.region1, p.central0, p.central1];
      for (const id of ids) { desired.set(id, row); }
    }
    if (page.length < PAGE) { break; }
    after = page[page.length - 1].id;
  }
  stats.tracks = desired.size;

  // 3–4. Merge the generation's existing rows (ascending track_id) against
  // the desired track ids (sorted the same way).
  const ids = Float64Array.from(desired.keys()).sort();
  const ops = [];   // [trackId, row] upserts; [trackId, null] deletes
  const existingPage = mainDb.prepare(`
    SELECT track_id, hash, dot, x, y, region0, region1, central0, central1
      FROM track_map
     WHERE layout_id = ? AND track_id > ?
     ORDER BY track_id
     LIMIT ${PAGE}
  `);
  let i = 0;
  for (let after = -1; ;) {
    const page = existingPage.all(layoutId, after);
    for (const e of page) {
      while (i < ids.length && ids[i] < e.track_id) { ops.push([ids[i], desired.get(ids[i])]); i++; }
      if (i < ids.length && ids[i] === e.track_id) {
        const d = desired.get(ids[i]);
        if (e.hash !== d[0] || e.dot !== d[1] || e.x !== d[2] || e.y !== d[3]
            || e.region0 !== d[4] || e.region1 !== d[5] || e.central0 !== d[6] || e.central1 !== d[7]) {
          ops.push([ids[i], d]);
        }
        i++;
      } else {
        ops.push([e.track_id, null]);
      }
    }
    if (page.length < PAGE) { break; }
    after = page[page.length - 1].track_id;
  }
  for (; i < ids.length; i++) { ops.push([ids[i], desired.get(ids[i])]); }

  // 5. Chunked writes.
  if (ops.length > 0) {
    const upsert = mainDb.prepare(`
      INSERT INTO track_map (layout_id, track_id, hash, dot, x, y, region0, region1, central0, central1)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM tracks WHERE id = ?)
      ON CONFLICT(layout_id, track_id) DO UPDATE SET
        hash = excluded.hash, dot = excluded.dot, x = excluded.x, y = excluded.y,
        region0 = excluded.region0, region1 = excluded.region1,
        central0 = excluded.central0, central1 = excluded.central1
    `);
    const del = mainDb.prepare('DELETE FROM track_map WHERE layout_id = ? AND track_id = ?');
    const bumpRev = mainDb.prepare('UPDATE track_map_meta SET rev = rev + 1 WHERE id = 1 AND active_layout = ?');
    for (let start = 0; start < ops.length; start += chunk) {
      const end = Math.min(ops.length, start + chunk);
      inTransaction(mainDb, () => {
        let changed = 0;
        for (let k = start; k < end; k++) {
          const [trackId, row] = ops[k];
          if (row) {
            const n = upsert.run(layoutId, trackId, ...row, trackId).changes;
            stats.written += n;
            changed += n;
          } else {
            const n = del.run(layoutId, trackId).changes;
            stats.removed += n;
            changed += n;
          }
        }
        if (changed > 0) { bumpRev.run(layoutId); }
      });
    }
  }

  stats.addedMax = generationAddedMax(mainDb, layoutId);
  const pointer = readTrackMapPointer(mainDb);
  if (pointer.active_layout === layoutId && pointer.added_max !== stats.addedMax) {
    mainDb.prepare('UPDATE track_map_meta SET added_max = ? WHERE id = 1 AND active_layout = ?')
      .run(stats.addedMax, layoutId);
  }
  return stats;
}

/**
 * The switch: one tiny transaction points track_map_meta at generation
 * `layoutId`, records `mapEpoch` (discovery_meta.map_epoch of the tables
 * that layout lives in) and the generation's added_max, and bumps rev.
 * `addedMax` comes from reconcileTrackMap's stats; omitted, it is read
 * here, before the transaction. Returns { rev } — the new revision.
 */
export function flipTrackMap(mainDb, { layoutId, mapEpoch, addedMax }) {
  if (!Number.isInteger(layoutId)) {
    throw new TypeError(`flipTrackMap needs an integer layoutId, got ${layoutId}`);
  }
  if (typeof mapEpoch !== 'string' || mapEpoch === '') {
    // A pointer with no epoch never validates: the map would silently never serve.
    throw new TypeError('flipTrackMap needs the map tables\' map_epoch');
  }
  const max = addedMax === undefined ? generationAddedMax(mainDb, layoutId) : addedMax;
  return inTransaction(mainDb, () => {
    mainDb.prepare(`
      INSERT INTO track_map_meta (id, active_layout, map_epoch, rev, added_max) VALUES (1, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        active_layout = excluded.active_layout, map_epoch = excluded.map_epoch,
        rev = rev + 1, added_max = excluded.added_max
    `).run(layoutId, mapEpoch, max);
    return { rev: mainDb.prepare('SELECT rev FROM track_map_meta WHERE id = 1').get().rev };
  });
}

/**
 * No map: the pointer goes NULL (layout, epoch, added_max) with a rev bump
 * — the `empty` mode, and recovery from a pointer that no longer validates.
 * A pointer that is already empty is left alone. Returns true when it
 * changed. The rows stay: deleteTrackMapGenerations removes them next.
 */
export function clearTrackMapPointer(mainDb) {
  const p = readTrackMapPointer(mainDb);
  if (p.active_layout === null && p.map_epoch === null && p.added_max === null) { return false; }
  mainDb.prepare(
    'UPDATE track_map_meta SET active_layout = NULL, map_epoch = NULL, added_max = NULL, rev = rev + 1 WHERE id = 1'
  ).run();
  return true;
}

/**
 * Delete every generation except `keep` and the one the pointer names (a
 * serving generation is never deleted from under its pointer — clear the
 * pointer first to delete everything), in BEGIN IMMEDIATE transactions of
 * at most `chunk` rows. These rows are invisible to every route, so rev
 * does not move. Returns the number of rows removed.
 */
export function deleteTrackMapGenerations(mainDb, { keep = null, chunk = TRACK_MAP_CHUNK } = {}) {
  checkChunk(chunk);
  const serving = readTrackMapPointer(mainDb).active_layout;
  const nextLayout = mainDb.prepare(
    'SELECT layout_id FROM track_map WHERE layout_id > ? ORDER BY layout_id LIMIT 1');
  const delChunk = mainDb.prepare(`
    DELETE FROM track_map
     WHERE layout_id = ?
       AND track_id IN (SELECT track_id FROM track_map WHERE layout_id = ? ORDER BY track_id LIMIT ?)
  `);
  let removed = 0;
  for (let row = nextLayout.get(Number.MIN_SAFE_INTEGER); row; row = nextLayout.get(row.layout_id)) {
    const layoutId = row.layout_id;
    if (layoutId === keep || layoutId === serving) { continue; }
    for (;;) {
      const n = inTransaction(mainDb, () => delChunk.run(layoutId, layoutId, chunk).changes);
      removed += n;
      if (n < chunk) { break; }
    }
  }
  return removed;
}
