// Model-mood sync — mirrors the discovery model's mood/character scores
// (discovery_tracks.mood_scores, written by the embedding worker's mood
// heads) into mstream.db's track_moods (V80), one row per track, so filters
// can JOIN them like any library table.
//
// Built on genre-sync.js and run at its triggers (task-queue calls both): a
// FULL idempotent reconcile — one read per side, an in-memory diff, writes
// only for rows that differ, in one transaction (and none at all when
// nothing does). Simpler than the genre links: nothing else writes
// track_moods, so the table is a plain mirror, with no provenance and no
// tag precedence. For every track sharing a canonical hash:
//   • active-model row with scores     → the track's row holds them
//   • active-model row without scores  → the track has no row (moods were
//     off when the row was written)
//   • no active-model row              → left alone, as with the genre
//     links: mid model-migration, or audio not analysed yet
// A deleted track takes its row along (ON DELETE CASCADE); turning
// scanOptions.analyzeMoods off empties the table.

import winston from 'winston';
import * as config from '../state/config.js';
import * as db from './manager.js';
import * as discoveryDb from './discovery-db.js';
import { tracksByCanonicalHash } from './genre-sync.js';

// track_moods' score columns — the effnet spec's head keys
// (discovery-features-lib.js). Keys a payload carries beyond these are
// ignored; a missing one is NULL.
export const MOOD_COLUMNS = ['danceable', 'happy', 'sad', 'relaxed', 'aggressive', 'party', 'acoustic', 'instrumental'];

// One mood_scores JSON payload → scores in MOOD_COLUMNS order, or null when
// it is malformed (never trust it blindly: it is written by a child
// process and survives model and version changes).
export function parseMoodScores(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (_e) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { return null; }
  return MOOD_COLUMNS.map((k) => (Number.isFinite(obj[k]) ? obj[k] : null));
}

/**
 * The reconcile core — injectable handles, like reconcileModelGenres.
 *
 * @param {DatabaseSync} mainDb   mstream.db (writes happen here)
 * @param {DatabaseSync} ddb      discovery.db (read-only use)
 * @param {string}       modelId  active model pin — only its rows sync
 * @returns stats { rows, tracks, written, removed }
 */
export function reconcileModelMoods(mainDb, ddb, modelId) {
  const stats = { rows: 0, tracks: 0, written: 0, removed: 0 };

  const discRows = ddb.prepare(`
    SELECT audio_hash, mood_scores FROM discovery_tracks
    WHERE embedding IS NOT NULL AND model_id = ?
  `).all(modelId);
  if (discRows.length === 0) { return stats; }

  const tracksByHash = tracksByCanonicalHash(mainDb);
  const existing = new Map();   // track_id → scores in MOOD_COLUMNS order
  for (const r of mainDb.prepare(`SELECT track_id, ${MOOD_COLUMNS.join(', ')} FROM track_moods`).all()) {
    existing.set(r.track_id, MOOD_COLUMNS.map((k) => r[k]));
  }

  const writes = [];
  const deletes = [];
  for (const dr of discRows) {
    const trackIds = tracksByHash.get(dr.audio_hash);
    if (!trackIds) { continue; }   // no library file for this hash (removed track)
    let desired = null;
    if (dr.mood_scores !== null) {
      desired = parseMoodScores(dr.mood_scores);
      if (desired === null) { continue; }   // malformed payload — leave rows as-is
    }
    stats.rows++;
    for (const trackId of trackIds) {
      stats.tracks++;
      const have = existing.get(trackId);
      if (desired === null) {
        if (have) { deletes.push(trackId); }
      } else if (!have || have.some((v, i) => v !== desired[i])) {
        writes.push([trackId, ...desired]);
      }
    }
  }
  if (writes.length === 0 && deletes.length === 0) { return stats; }

  const upsert = mainDb.prepare(`
    INSERT INTO track_moods (track_id, ${MOOD_COLUMNS.join(', ')})
    VALUES (?, ${MOOD_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(track_id) DO UPDATE SET ${MOOD_COLUMNS.map((k) => `${k} = excluded.${k}`).join(', ')}
  `);
  const del = mainDb.prepare('DELETE FROM track_moods WHERE track_id = ?');

  mainDb.exec('BEGIN IMMEDIATE');
  try {
    for (const w of writes) { stats.written += upsert.run(...w).changes; }
    for (const id of deletes) { stats.removed += del.run(id).changes; }
    mainDb.exec('COMMIT');
  } catch (err) {
    mainDb.exec('ROLLBACK');
    throw err;
  }
  return stats;
}

/** Empty track_moods — analyzeMoods turned off. Returns the count. */
export function removeModelMoods(mainDb) {
  if (!mainDb.prepare('SELECT 1 FROM track_moods LIMIT 1').get()) { return 0; }
  return mainDb.prepare('DELETE FROM track_moods').run().changes;
}

/**
 * Production entry point — config-gated, resolves the managed handles.
 * Returns the reconcile stats, or null when the feature (or a store) is
 * unavailable. Callers wrap in try/catch and log.
 */
export function syncModelMoods() {
  const scanOpts = config.program?.scanOptions;
  if (scanOpts?.analyzeMoods === false) {
    const mainDb = db.getDB();
    if (!mainDb) { return null; }
    const removed = removeModelMoods(mainDb);
    if (removed) { winston.info(`model-mood sync: analyzeMoods is off — removed ${removed} rows`); }
    return { rows: 0, tracks: 0, written: 0, removed };
  }
  if (scanOpts?.collectDiscoveryData !== true) { return null; }
  const mainDb = db.getDB();
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!mainDb || !ddb) { return null; }

  const started = Date.now();
  const stats = reconcileModelMoods(mainDb, ddb, scanOpts.discoveryModel);
  if (stats.written || stats.removed) {
    winston.info(
      `model-mood sync: ${stats.written} written, ${stats.removed} removed `
      + `across ${stats.tracks} tracks (${Date.now() - started} ms)`);
  }
  return stats;
}
