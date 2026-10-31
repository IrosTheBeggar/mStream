/**
 * Hand-staged discovery-network state for integration tests and stages: peer
 * snapshot files in the exact export format, the shelf registry that lists
 * them, the gossip catalog, and the blobs the no-sidecar fake fetch serves.
 * Everything a server reads about the network, with no sidecar and no
 * network at all.
 *
 * Under a server's dbDirectory:
 *   discovery-peers/<hash16>.db    the shelf's snapshot files (the sidecar's
 *                                  export naming: the hash's first 16 hex)
 *   discovery-p2p/peer-dbs.json    the shelf registry (discovery-peer-dbs.js)
 *   discovery-p2p/catalog.json     the catalog (discovery-catalog.js)
 * And in a fake-fetch directory (MSTREAM_TEST_P2P_FAKE_FETCH_DIR, served by
 * src/state/discovery-p2p.js fetch()):
 *   <hash>.db                      the blob a download copies onto the shelf
 *   <hash>.delay-ms                holds the download open that many ms
 *   <hash>.fail                    rejects it like an unreachable provider
 *
 * Both JSON files load lazily on first use, and the shelf's first load
 * deletes every *.db its registry does not name. Stage BEFORE boot, into a
 * dbDirectory the server is pointed at with extraConfig.storage (every key:
 * the helper's spread replaces the object). Staging after boot works only
 * while nothing has read them yet.
 *
 * makeSnapshotFile / embeddingBlob were discovery-p2p.test.mjs's, writeShelf
 * discovery-taste.test.mjs's; stagePeers is the Peer Recommendations suite's
 * one-call shelf + catalog + blobs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The embedding model every discovery suite runs (scanOptions.discoveryModel).
export const TEST_MODEL = 'test-fake';

const SNAPSHOT_SEQ = 1;

// Serialize a vector as the little-endian float32 BLOB the schema stores.
export function embeddingBlob(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

// The same direction at length 1: cosine is a plain dot product only over
// unit vectors, and the walk's near-duplicate cut reads the dot as a cosine.
export function unit(vec) {
  const n = Math.hypot(...vec) || 1;
  return vec.map((x) => x / n);
}

// Build a synthetic peer snapshot file with the exact P0 export format
// (user_version marker, meta + tracks tables) — what fetchPeer() validates
// and the similarity search reads. Lets the whole N4a query path be tested
// without any network or sidecar.
//
// Default = the ORIGINAL layout (source schema v1/v2: no catalogue columns),
// which is what every peer that has not upgraded still publishes; the
// reader must keep accepting it. `catalogue: true` adds the V3 columns
// (album / year / isrc / release_group_mbid) the way a current exporter
// writes them — same format_version, appended columns. Vectors are stored
// as given (pass unit vectors).
export function makeSnapshotFile(filePath, { modelId = 'test-model', tracks = [], catalogue = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.rmSync(filePath, { force: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tracks (
      export_id TEXT NOT NULL, recording_mbid TEXT, acoustid_id TEXT,
      artist TEXT, title TEXT, duration REAL,
      model_id TEXT, model_version TEXT, embedding BLOB,
      bpm INTEGER, musical_key TEXT, danceability REAL,
      genre_tags TEXT, mood_tags TEXT${catalogue
    ? ', album TEXT, year INTEGER, isrc TEXT, release_group_mbid TEXT'
    : ''}
    );
  `);
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('format', 'mstream-discovery-snapshot');
  meta.run('format_version', '1');
  meta.run('source_schema_version', catalogue ? '3' : '2');
  meta.run('embedding_model_id', modelId);
  meta.run('embedding_model_version', '1');
  meta.run('row_count', String(tracks.length));
  const ins = catalogue
    ? db.prepare(`
        INSERT INTO tracks (export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding,
                            album, year, isrc, release_group_mbid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    : db.prepare(`
        INSERT INTO tracks (export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of tracks) {
    const base = [t.exportId || `anon:${t.title}`, t.mbid || null, t.artist, t.title,
      t.duration || 180, t.modelId || modelId, '1',
      t.vec ? embeddingBlob(t.vec) : null];
    if (catalogue) {
      ins.run(...base, t.album ?? null, t.year ?? null, t.isrc ?? null, t.releaseGroupMbid ?? null);
    } else {
      ins.run(...base);
    }
  }
  db.close();
  return filePath;
}

export const shelfDir = (dbDir) => path.join(dbDir, 'discovery-peers');
export const registryPath = (dbDir) => path.join(dbDir, 'discovery-p2p', 'peer-dbs.json');
export const catalogPath = (dbDir) => path.join(dbDir, 'discovery-p2p', 'catalog.json');

// The shelf registry, entries written as given: { endpointId, hash, path,
// snapshotSeq, modelId, rowCount, sizeBytes, name, fetchedAt, and
// optionally firstFetchedAt, pinned } (the server backfills the last two).
export function writeShelf(dbDir, entries) {
  fs.mkdirSync(path.dirname(registryPath(dbDir)), { recursive: true });
  fs.writeFileSync(registryPath(dbDir), JSON.stringify(entries, null, 2));
}

// The catalog, entries written as given: { from, firstSeenAt, updatedAt,
// payload: { name, hash, rowCount, modelId, snapshotSeq, size } }. A peer is
// online while now − updatedAt is under the online window
// (MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS widens it for a whole run).
export function writeCatalog(dbDir, entries) {
  fs.mkdirSync(path.dirname(catalogPath(dbDir)), { recursive: true });
  fs.writeFileSync(catalogPath(dbDir), JSON.stringify(entries, null, 2));
}

// A stand-in snapshot hash for a peer: 64 hex, stable per endpoint id.
export function hashOf(endpointId) {
  return crypto.createHash('sha256').update(`snapshot:${endpointId}`).digest('hex');
}

// What the fake fetch serves for `hash`: the blob (from `tracks`, current
// catalogue layout), and the optional delay and failure markers. Call it
// again to change a marker; `delayMs: 0` / `fail: false` remove one.
export function stageFakeBlob(fakeDir, hash, { tracks = null, modelId = TEST_MODEL, delayMs, fail } = {}) {
  fs.mkdirSync(fakeDir, { recursive: true });
  const blob = path.join(fakeDir, hash);
  if (tracks) {
    makeSnapshotFile(`${blob}.db`, { modelId, catalogue: true, tracks: unitTracks(tracks, modelId) });
  }
  if (delayMs !== undefined) {
    if (delayMs > 0) { fs.writeFileSync(`${blob}.delay-ms`, String(delayMs)); } else { fs.rmSync(`${blob}.delay-ms`, { force: true }); }
  }
  if (fail !== undefined) {
    if (fail) { fs.writeFileSync(`${blob}.fail`, ''); } else { fs.rmSync(`${blob}.fail`, { force: true }); }
  }
}

function unitTracks(tracks, modelId) {
  return tracks.map((t) => ({ modelId, ...t, vec: t.vec ? unit(t.vec) : null }));
}

const MB = 1024 * 1024;

/**
 * Stage a whole network in one call: the shelf (snapshot files + registry),
 * the catalog and the fake-fetch blobs. Returns { blockedPeers } for
 * config.discoveryP2p.blockedPeers. Each peer:
 *
 *   id          endpoint id (64 lower-case hex)
 *   name        announced name (also the name its snapshot was fetched under)
 *   modelId     announced embedding model (default TEST_MODEL)
 *   hash        snapshot hash (default hashOf(id))
 *   heardAgoMs  catalog updatedAt = now − this (default 0: online);
 *               null = not in the catalog
 *   size        announced bytes (default 1 MB) — admission and planRoom
 *               trust it; a landed snapshot's sizeBytes is its real size
 *   rowCount    announced rows (default the shelf or blob track count)
 *   blocked     listed in the returned blockedPeers
 *   shelf       held: { tracks, sizeBytes (default `size`), pinned,
 *               heldForMs (membership age, default 1 day) }
 *   blob        the fake fetch's copy: { tracks, delayMs, fail }; with no
 *               tracks only the markers are written (no blob = the fetch
 *               rejects "no provider", an offline peer)
 *
 * Tracks: { artist, title, album?, vec, ... } — vectors are normalized
 * here. A shelf snapshot carries the peer's modelId on every row.
 */
export function stagePeers({ dbDir, fakeDir = null, peers, now = Date.now() }) {
  const iso = (ms) => new Date(ms).toISOString();
  const shelf = [];
  const catalog = [];
  const blockedPeers = [];
  for (const p of peers) {
    const modelId = p.modelId ?? TEST_MODEL;
    const hash = p.hash ?? hashOf(p.id);
    const size = p.size ?? MB;
    if (p.blocked) { blockedPeers.push(p.id); }
    if (p.shelf) {
      const file = makeSnapshotFile(path.join(shelfDir(dbDir), `${hash.slice(0, 16)}.db`), {
        modelId, catalogue: true, tracks: unitTracks(p.shelf.tracks || [], modelId),
      });
      const heldSince = iso(now - (p.shelf.heldForMs ?? 24 * 60 * 60 * 1000));
      shelf.push({
        endpointId: p.id, hash, path: file, snapshotSeq: SNAPSHOT_SEQ, modelId, modelVersion: '1',
        rowCount: (p.shelf.tracks || []).length, sizeBytes: p.shelf.sizeBytes ?? size, name: p.name,
        fetchedAt: heldSince, firstFetchedAt: heldSince, pinned: p.shelf.pinned === true,
      });
    }
    if (p.heardAgoMs !== null) {
      const updatedAt = iso(now - (p.heardAgoMs ?? 0));
      catalog.push({
        from: p.id, firstSeenAt: updatedAt, updatedAt,
        payload: {
          name: p.name, hash, modelId, snapshotSeq: SNAPSHOT_SEQ, size,
          rowCount: p.rowCount ?? (p.shelf?.tracks || p.blob?.tracks || []).length,
        },
      });
    }
    if (p.blob) {
      if (!fakeDir) { throw new Error(`stagePeers: peer ${p.id.slice(0, 12)}… has a blob but no fakeDir`); }
      stageFakeBlob(fakeDir, hash, { modelId, ...p.blob });
    }
  }
  writeShelf(dbDir, shelf);
  writeCatalog(dbDir, catalog);
  return { blockedPeers };
}
