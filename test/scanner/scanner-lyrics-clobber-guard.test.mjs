/**
 * Scanner clobber-guard for backfilled lyrics (the lyrics_source CASE in the
 * tracks UPSERT). Verifies that a rescan does NOT wipe provider-backfilled
 * lyrics, while still clearing local (embedded/sidecar) lyrics a user removed
 * and letting newly-found local lyrics win.
 *
 * The exact UPSERT SQL is extracted from src/db/scanner.mjs at runtime so this
 * test can't drift from the scanner. The Rust scanner carries a byte-identical
 * CASE (asserted in CI by the SQL-parity check + the shared schema), so
 * exercising the SQL here covers both scanners.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scannerSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src/db/scanner.mjs'), 'utf8');
const UPSERT_SQL = scannerSrc.match(/INSERT INTO tracks[\s\S]*?RETURNING id/)[0];

// The scanner's FULL column order (must stay in lock-step with the extracted
// SQL — a positional drift here silently binds values one column late:
// node:sqlite binds missing trailing anonymous params as NULL, so an
// omission only fails loudly when the column is NOT NULL, like hash_v).
// lyrics_source / lyrics_search_text are computed in JS by the scanner; here
// we bind them directly to set up the scenarios.
const COLS = [
  'filepath', 'library_id', 'title', 'artist_id', 'album_id', 'track_number',
  'disc_number', 'year', 'duration', 'format', 'file_hash', 'audio_hash',
  'album_art_file', 'album_art_source', 'replaygain_track_db', 'sample_rate',
  'channels', 'bit_depth', 'bitrate', 'file_size', 'track_total', 'disc_total',
  'lyrics_embedded', 'lyrics_synced_lrc', 'lyrics_lang', 'lyrics_sidecar_mtime',
  'lyrics_source', 'lyrics_search_text', 'bpm', 'musical_key', 'bpm_source',
  'modified', 'scan_id', 'source',
  'mbz_recording_id', 'mbz_release_track_id', 'isrc', 'mbz_id_source', 'hash_v',
];
// Columns with NOT NULL and no usable default — bound to a fixed value
// unless the scenario overrides them.
const REQUIRED = { library_id: 1, hash_v: 1 };

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', '/m')").run(); // id 1
  return db;
}
const upsert = (db, over) => db.prepare(UPSERT_SQL).get(...COLS.map((c) => (c in over ? over[c] : (c in REQUIRED ? REQUIRED[c] : null))));
const trackLyrics = (db, id) => db.prepare('SELECT lyrics_embedded AS emb, lyrics_synced_lrc AS syn, lyrics_source AS src, lyrics_search_text AS st FROM tracks WHERE id = ?').get(id);

test('rescan PRESERVES provider-backfilled lyrics (source not embedded/sidecar)', () => {
  const db = freshDb();
  const { id } = upsert(db, { filepath: 'a.flac', title: 'A', file_hash: 'h' }); // scanned, no lyrics
  // Simulates the real backfill writer, which since V59 writes the stripped
  // lyrics_search_text alongside the raw LRC (the FTS index reads only the
  // stripped copy).
  db.prepare("UPDATE tracks SET lyrics_synced_lrc = '[00:01.00]hi there', lyrics_search_text = 'hi there', lyrics_source = 'lrclib' WHERE id = ?").run(id);
  upsert(db, { filepath: 'a.flac', title: 'A', file_hash: 'h' }); // rescan: file still lyric-less
  const r = trackLyrics(db, id);
  assert.equal(r.syn, '[00:01.00]hi there'); // PRESERVED
  assert.equal(r.st, 'hi there');            // the search copy rides the same CASE
  assert.equal(r.src, 'lrclib');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fts_tracks WHERE fts_tracks MATCH 'there'").get().n, 1); // still searchable
  db.close();
});

test('rescan CLEARS embedded lyrics that were removed from the file', () => {
  const db = freshDb();
  const { id } = upsert(db, { filepath: 'b.flac', title: 'B', file_hash: 'h2', lyrics_embedded: 'tag lyrics', lyrics_source: 'embedded' });
  assert.equal(trackLyrics(db, id).emb, 'tag lyrics');
  upsert(db, { filepath: 'b.flac', title: 'B', file_hash: 'h2' }); // rescan: tag gone
  const r = trackLyrics(db, id);
  assert.equal(r.emb, null); // CLEARED — user removed it
  assert.equal(r.src, null);
  db.close();
});

test('rescan that finds NEW local lyrics overwrites a provider backfill', () => {
  const db = freshDb();
  const { id } = upsert(db, { filepath: 'c.flac', title: 'C', file_hash: 'h3' });
  db.prepare("UPDATE tracks SET lyrics_synced_lrc = '[00:01]provider', lyrics_search_text = 'provider', lyrics_source = 'lrclib' WHERE id = ?").run(id);
  upsert(db, { filepath: 'c.flac', title: 'C', file_hash: 'h3', lyrics_embedded: 'now embedded', lyrics_source: 'embedded' });
  const r = trackLyrics(db, id);
  assert.equal(r.emb, 'now embedded'); // local wins
  assert.equal(r.syn, null);           // provider synced replaced
  assert.equal(r.st, null);            // and its search copy with it
  assert.equal(r.src, 'embedded');
  db.close();
});
