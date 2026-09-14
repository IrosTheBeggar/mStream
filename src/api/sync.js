// Library sync manifest — the server half of the app's local mirror and
// offline index (mstream_music: BACKUP_SYNC_PLAN.md / BACKUP_SYNC_IMPLEMENTATION.md §1).
//
// One paged, id-ordered listing of every track the caller can see, carrying
// both halves of what a mirror needs:
//   - identity for byte-exact sync: file size, mtime, file_hash / audio_hash
//     (+ the hash scheme generation), so a client can decide unchanged /
//     changed / renamed without touching the file;
//   - the lite metadata block + genres (the same `metadata` object every
//     list endpoint returns), so an offline library index never needs a
//     per-track /db/metadata round-trip.
//
// Change detection is a revision string over the caller's visible set,
// returned as `revision` and as the ETag. A client that sends it back as
// If-None-Match on its first page gets a 304 and does nothing — the common
// case for a periodic sync.
//
// Flag, never a probe: /api/v1/ping advertises `sync: true` on servers that
// have this route; older builds omit the key.

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as dbQueue from '../db/task-queue.js';
import { joiValidate } from '../util/validation.js';
import {
  libraryFilter, trackQuery, enrichRowsWithGenres, renderMetadataObj, toLiteMetadata,
} from './db.js';

export const MANIFEST_DEFAULT_LIMIT = 2000;
export const MANIFEST_MAX_LIMIT = 5000;

// Revision of the caller's visible library set: four cheap aggregates in one
// indexed pass. Row count (adds / deletes), max id (a delete + add that keeps
// the count — ids are AUTOINCREMENT, so a new row always raises it), max
// mtime (any file change), and the number of rows carrying album art (the
// art backfill sets album_art_file without touching mtime). Prefixed with the
// library ids so a scope change is its own revision. Deliberately NOT
// covering per-user state (ratings, play counts): that changes on every
// play and would make the 304 fast path nearly useless.
export function manifestRevision(d, filter) {
  const row = d.prepare(`
    SELECT COUNT(*) AS n, MAX(t.id) AS max_id, MAX(t.modified) AS max_modified,
           COUNT(t.album_art_file) AS with_art
      FROM tracks t
     WHERE ${filter.clause}
  `).get(...filter.params);
  return `${filter.params.join('.')}:${row.n}:${row.max_id ?? 0}:${row.max_modified ?? 0}:${row.with_art}`;
}

// One page: up to `limit` rows with id > cursor, ascending id. `next` is the
// last id on the page when more rows exist, else null — learned by fetching
// limit + 1 rows rather than paying a COUNT per page.
export function manifestPage(d, filter, userId,
  { cursor = 0, limit = MANIFEST_DEFAULT_LIMIT } = {}) {
  // trackQuery's user_metadata join binds the user id BEFORE the WHERE
  // params (same order recent/added uses).
  const userParams = userId ? [userId] : [];
  const rows = d.prepare(`
    ${trackQuery(userId, { includeGenres: false })}
    WHERE ${filter.clause} AND t.id > ?
    ORDER BY t.id
    LIMIT ?
  `).all(...userParams, ...filter.params, cursor, limit + 1);
  const more = rows.length > limit;
  if (more) { rows.length = limit; }
  enrichRowsWithGenres(d, rows);
  return {
    entries: rows.map(toManifestEntry),
    next: more ? rows[rows.length - 1].id : null,
  };
}

// The lite `{filepath, metadata}` row every list endpoint returns, plus the
// sync-only identity fields at the top level. Multi-word keys are kebab-case
// on the wire, matching renderMetadataObj.
function toManifestEntry(row) {
  const full = renderMetadataObj(row);
  return {
    filepath: full.filepath,
    metadata: toLiteMetadata(full.metadata),
    id: row.id,
    'file-size': row.file_size ?? null,
    modified: row.modified ?? null,
    hash: row.file_hash || null,
    'audio-hash': row.audio_hash || null,
    'hash-v': row.hash_v ?? null,
    format: row.format || null,
    'album-id': row.album_id ?? null,
    'artist-id': row.artist_id ?? null,
    'created-at': row.created_at || null,
  };
}

// If-None-Match may carry several entity tags, each optionally weak
// (`W/"…"`). Ours is strong; match on the tag value alone.
function matchesEtag(header, revision) {
  if (!header) { return false; }
  return header.split(',').some((tag) =>
    tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === revision);
}

export function setup(mstream) {
  const d = () => db.getDB();

  mstream.post('/api/v1/sync/manifest', (req, res) => {
    const schema = Joi.object({
      cursor: Joi.number().integer().min(0).optional(),
      limit: Joi.number().integer().min(1).max(MANIFEST_MAX_LIMIT).optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
    });
    const { value } = joiValidate(schema, req.body ?? {});

    const filter = libraryFilter(req.user, value.ignoreVPaths);
    const revision = manifestRevision(d(), filter);
    res.set('ETag', `"${revision}"`);
    // Only the first page asks "has anything changed?" — a cursor means the
    // client is mid-walk and must get its rows whatever the tag says.
    if (value.cursor === undefined && matchesEtag(req.get('If-None-Match'), revision)) {
      return res.status(304).end();
    }

    const page = manifestPage(d(), filter, req.user?.id,
      { cursor: value.cursor, limit: value.limit });
    res.json({
      revision,
      // Rows can be transiently absent mid-scan: a client must not read a
      // missing path as a deletion while this is true.
      scanning: dbQueue.isScanning(),
      next: page.next,
      entries: page.entries,
    });
  });
}
