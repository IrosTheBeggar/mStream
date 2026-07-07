// Model-genre sync — feeds the discovery model's style predictions
// (discovery_tracks.genre_tags, e.g. "Electronic---Synthwave") into the real
// genre tables as track_genres rows with source='model' (V57), so genre
// browse / filtering / Auto-DJ genre mode work on untagged libraries.
//
// Shape of the reconcile (deliberately a FULL pass, not incremental): both
// scanners wipe a track's track_genres rows on every re-parse
// (deleteTrackGenres → re-insert from tags), taking any model rows with
// them — so the sync must be able to heal from nothing at any time. It is
// idempotent and cheap (one read per table + set-diffs in memory; writes
// only for actual deltas inside a single transaction), and the task-queue
// triggers it exactly where the data can have moved: after a discovery
// embedding batch lands, and after a scan batch that changed the DB.
//
// Hierarchy: each "Genre---Style" tag links BOTH levels — the style row
// ("Synthwave", genres.parent='Electronic') and the parent row
// ("Electronic", parent NULL) — so the flat genre page stays rich while
// the parent column gives the browse UI its two-level structure. Genre
// rows are reused case-insensitively (the V34 case-folded vocabulary
// convention); a reused row's parent is backfilled only when NULL, never
// overwritten (a style name that appears under two taxonomy parents keeps
// its first-seen parent rather than churning).
//
// Provenance rules: 'tag' wins — the sync only INSERT OR IGNOREs, so a
// link the scanner owns is never re-labelled 'model'; and it only ever
// DELETEs rows it owns (source='model'). Tracks whose canonical hash has
// no row under the ACTIVE model are left untouched (mid model-migration
// their links would otherwise flap: removed now, re-added after re-embed).

import winston from 'winston';
import * as config from '../state/config.js';
import * as db from './manager.js';
import * as discoveryDb from './discovery-db.js';

// Parse one genre_tags JSON payload into [{ name, parent }] entries —
// both hierarchy levels, deduped, junk-hardened (the format is also
// network-facing via peer snapshots, so never trust it blindly).
export function parseGenreTags(json) {
  let tags;
  try {
    tags = JSON.parse(json);
  } catch (_e) {
    return null;   // malformed → caller skips the row
  }
  if (!Array.isArray(tags)) { return null; }

  const out = new Map();   // lower(name) → { name, parent }
  for (const raw of tags) {
    if (typeof raw !== 'string') { continue; }
    const sep = raw.indexOf('---');
    const parent = sep > 0 ? raw.slice(0, sep).trim() : null;
    const style = (sep >= 0 ? raw.slice(sep + 3) : raw).trim();
    if (style) {
      const key = style.toLowerCase();
      if (!out.has(key)) { out.set(key, { name: style, parent: parent || null }); }
    }
    if (parent) {
      const key = parent.toLowerCase();
      if (!out.has(key)) { out.set(key, { name: parent, parent: null }); }
    }
  }
  return [...out.values()];
}

/**
 * The reconcile core — injectable handles so tests can drive raw
 * DatabaseSync instances without booting the managers.
 *
 * @param {DatabaseSync} mainDb   mstream.db (writes happen here)
 * @param {DatabaseSync} ddb      discovery.db (read-only use)
 * @param {string}       modelId  active model pin — only its rows sync
 * @returns stats { rows, tracks, linksAdded, linksRemoved, genresCreated }
 */
export function reconcileModelGenres(mainDb, ddb, modelId) {
  const stats = { rows: 0, tracks: 0, linksAdded: 0, linksRemoved: 0, genresCreated: 0 };

  const discRows = ddb.prepare(`
    SELECT audio_hash, genre_tags FROM discovery_tracks
    WHERE embedding IS NOT NULL AND model_id = ? AND genre_tags IS NOT NULL
  `).all(modelId);
  if (discRows.length === 0) { return stats; }

  // hash → [track ids]: duplicate files share one canonical hash and all
  // get the same links. One pass instead of per-row COALESCE lookups
  // (which can't use the hash indexes).
  const tracksByHash = new Map();
  for (const t of mainDb.prepare(
    'SELECT id, COALESCE(audio_hash, file_hash) AS h FROM tracks WHERE audio_hash IS NOT NULL OR file_hash IS NOT NULL'
  ).all()) {
    if (!tracksByHash.has(t.h)) { tracksByHash.set(t.h, []); }
    tracksByHash.get(t.h).push(t.id);
  }

  // Case-insensitive genre vocabulary (V34 convention).
  const genreByLc = new Map();
  for (const g of mainDb.prepare('SELECT id, name, parent FROM genres').all()) {
    genreByLc.set(g.name.toLowerCase(), g);
  }

  // The links this sync owns.
  const modelLinks = new Map();   // track_id → Set(genre_id)
  for (const l of mainDb.prepare(
    "SELECT track_id, genre_id FROM track_genres WHERE source = 'model'"
  ).all()) {
    if (!modelLinks.has(l.track_id)) { modelLinks.set(l.track_id, new Set()); }
    modelLinks.get(l.track_id).add(l.genre_id);
  }

  const insGenre = mainDb.prepare('INSERT INTO genres (name, parent) VALUES (?, ?)');
  const setParent = mainDb.prepare('UPDATE genres SET parent = ? WHERE id = ? AND parent IS NULL');
  const insLink = mainDb.prepare(
    "INSERT OR IGNORE INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'model')"
  );
  const delLink = mainDb.prepare(
    "DELETE FROM track_genres WHERE track_id = ? AND genre_id = ? AND source = 'model'"
  );

  const ensureGenre = (entry) => {
    const key = entry.name.toLowerCase();
    let row = genreByLc.get(key);
    if (!row) {
      const res = insGenre.run(entry.name, entry.parent);
      row = { id: Number(res.lastInsertRowid), name: entry.name, parent: entry.parent };
      genreByLc.set(key, row);
      stats.genresCreated++;
    } else if (entry.parent && row.parent == null) {
      setParent.run(entry.parent, row.id);
      row.parent = entry.parent;
    }
    return row.id;
  };

  mainDb.exec('BEGIN IMMEDIATE');
  try {
    for (const dr of discRows) {
      const trackIds = tracksByHash.get(dr.audio_hash);
      if (!trackIds) { continue; }   // no library file for this hash (removed track)
      const entries = parseGenreTags(dr.genre_tags);
      if (entries === null) { continue; }   // malformed payload — leave links as-is
      stats.rows++;

      const desired = new Set(entries.map(ensureGenre));
      for (const trackId of trackIds) {
        stats.tracks++;
        const existing = modelLinks.get(trackId) || new Set();
        for (const gid of desired) {
          if (existing.has(gid)) { continue; }
          // OR IGNORE: a 'tag' link for the same pair blocks the insert —
          // tag wins, changes tells us whether the row actually landed.
          stats.linksAdded += insLink.run(trackId, gid).changes;
        }
        for (const gid of existing) {
          if (desired.has(gid)) { continue; }
          stats.linksRemoved += delLink.run(trackId, gid).changes;
        }
      }
    }
    mainDb.exec('COMMIT');
  } catch (err) {
    mainDb.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

/**
 * Production entry point — config-gated, resolves the managed handles.
 * Returns the reconcile stats, or null when the feature (or a store) is
 * unavailable. Callers wrap in try/catch and log; this never throws for
 * "feature off" states.
 */
export function syncModelGenres() {
  const scanOpts = config.program?.scanOptions;
  if (scanOpts?.collectDiscoveryData !== true || scanOpts?.modelGenres !== true) { return null; }
  const mainDb = db.getDB();
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!mainDb || !ddb) { return null; }

  const started = Date.now();
  const stats = reconcileModelGenres(mainDb, ddb, scanOpts.discoveryModel);
  if (stats.linksAdded || stats.linksRemoved || stats.genresCreated) {
    winston.info(
      `model-genre sync: +${stats.linksAdded}/-${stats.linksRemoved} links, `
      + `${stats.genresCreated} new genres across ${stats.tracks} tracks (${Date.now() - started} ms)`);
  }
  return stats;
}
