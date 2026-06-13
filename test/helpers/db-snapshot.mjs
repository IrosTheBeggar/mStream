/**
 * Canonical, id-free snapshot of scanner-produced DB state.
 *
 * Two scans of the same fixture library MUST produce deepEqual snapshots
 * regardless of (a) walk order vs. completion order and (b) thread count.
 * Rowids vary across runs whenever insert order isn't deterministic, so
 * the snapshot drops every `id` column and references rows by their
 * natural keys (filepath, artist name, album triple).
 *
 * What's included:
 *   - Tracks: every scanner-populated content column, joined to artist
 *     and album by name. Sorted by filepath.
 *   - Artists: name list, sorted.
 *   - Albums: (name, primary_artist_name, year, compilation, album_artist).
 *   - Genres + track_genres: by name + filepath, sorted.
 *   - track_artists / album_artists: flattened to (key, artist, role,
 *     position), sorted by (key, role, position). Position is critical
 *     — it preserves tag order, and a worker race that mis-orders the
 *     INSERTs would surface here.
 *
 * What's excluded:
 *   - id, scan_id, created_at — vary per run by design.
 *   - Tables not touched by the scanner (users, playlists, ...).
 *   - Waveform .bin file *contents* — large + already covered by
 *     waveform.test.mjs. The set of filenames IS captured separately
 *     by the parity test via fs.readdir.
 */

import { DatabaseSync } from 'node:sqlite';

export function snapshotDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      tracks: snapTracks(db),
      artists: snapArtists(db),
      albums: snapAlbums(db),
      genres: snapGenres(db),
      trackGenres: snapTrackGenres(db),
      trackArtists: snapTrackArtists(db),
      albumArtists: snapAlbumArtists(db),
      artFiles: snapArtFiles(db),
      trackArt: snapTrackArt(db),
      albumArt: snapAlbumArt(db),
    };
  } finally {
    db.close();
  }
}

function snapTracks(db) {
  // LEFT JOIN so a track without an artist/album still surfaces.
  // Order by filepath for stable comparison; SQLite's text comparison
  // is byte-wise, which matches what the scanner stores (rel_path is
  // forward-slash-normalised by the scanner before insert).
  const rows = db.prepare(`
    SELECT
      t.filepath, t.title, t.track_number, t.disc_number, t.year, t.duration,
      t.format, t.file_hash, t.audio_hash, t.album_art_file,
      -- V34: tracks.genre dropped — the canonical store is
      -- track_genres (snapped separately via snapTrackGenres below).
      t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
      t.lyrics_embedded, t.lyrics_synced_lrc, t.lyrics_lang,
      t.lyrics_sidecar_mtime,
      t.bpm, t.musical_key, t.bpm_source,
      t.modified,
      ar.name AS artist_name,
      al.name AS album_name, al.year AS album_year,
      al.compilation AS album_compilation, al.album_artist AS album_artist_display
    FROM tracks t
    LEFT JOIN artists ar ON ar.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    ORDER BY t.filepath
  `).all();
  return rows;
}

function snapArtists(db) {
  return db.prepare('SELECT name FROM artists ORDER BY name').all().map(r => r.name);
}

function snapAlbums(db) {
  // Two albums with the same (name, year) but different artists are
  // distinct rows — include the artist name in the natural key. Drop
  // album_art_file because tracks already carry it; including it here
  // would just double-count.
  return db.prepare(`
    SELECT al.name, al.year, al.compilation, al.album_artist,
           ar.name AS artist_name
    FROM albums al
    LEFT JOIN artists ar ON ar.id = al.artist_id
    ORDER BY al.name, ar.name, al.year
  `).all();
}

function snapGenres(db) {
  return db.prepare('SELECT name FROM genres ORDER BY name').all().map(r => r.name);
}

function snapTrackGenres(db) {
  return db.prepare(`
    SELECT t.filepath, g.name AS genre
    FROM track_genres tg
    JOIN tracks t ON t.id = tg.track_id
    JOIN genres g ON g.id = tg.genre_id
    ORDER BY t.filepath, g.name
  `).all();
}

function snapTrackArtists(db) {
  // Position is the load-bearing column here — a parallel scanner that
  // mis-orders M2M inserts would change position values. Sort by
  // (filepath, role, position) so the snapshot itself is order-stable
  // but a position-flip surfaces as a value diff.
  return db.prepare(`
    SELECT t.filepath, ar.name AS artist, ta.role, ta.position
    FROM track_artists ta
    JOIN tracks  t  ON t.id  = ta.track_id
    JOIN artists ar ON ar.id = ta.artist_id
    ORDER BY t.filepath, ta.role, ta.position
  `).all();
}

function snapAlbumArtists(db) {
  // Album natural key here is (name, primary_artist, year) — the same
  // shape used in the find_or_create_album cache key on the Rust side.
  return db.prepare(`
    SELECT al.name AS album, primary_ar.name AS album_primary_artist,
           al.year AS album_year, ar.name AS artist, aa.role, aa.position
    FROM album_artists aa
    JOIN albums  al         ON al.id        = aa.album_id
    LEFT JOIN artists primary_ar ON primary_ar.id = al.artist_id
    JOIN artists ar         ON ar.id        = aa.artist_id
    ORDER BY al.name, primary_ar.name, al.year, aa.role, aa.position
  `).all();
}

// ── V48 multi-art ───────────────────────────────────────────────────────────
// Art identity is content-derived (cache_file = md5 hash) or the vpath-relative
// rel_path — both stable across runs and thread counts. art_files is the set of
// distinct images; track_art keeps per-track `position` (deterministic — the
// per-track ingest order is fixed). album_art is treated as a SET: `position`
// is intentionally excluded because which album-mate links a shared image first
// can vary under parallelism, so only the membership is parity-stable.
function snapArtFiles(db) {
  // content_hash/byte_size (V50) are content-derived — identical bytes
  // must hash identically in both scanners, so they're parity-stable.
  return db.prepare(`
    SELECT kind, cache_file, rel_path, content_hash, byte_size
    FROM art_files
    ORDER BY kind, cache_file, rel_path
  `).all();
}

function snapTrackArt(db) {
  return db.prepare(`
    SELECT t.filepath, af.kind, af.cache_file, af.rel_path,
           ta.source, ta.picture_type, ta.position
    FROM track_art ta
    JOIN tracks t     ON t.id  = ta.track_id
    JOIN art_files af ON af.id = ta.art_id
    ORDER BY t.filepath, ta.position, af.kind, af.cache_file, af.rel_path
  `).all();
}

function snapAlbumArt(db) {
  return db.prepare(`
    SELECT al.name AS album, ar.name AS album_artist, al.year,
           af.kind, af.cache_file, af.rel_path, aa.source, aa.picture_type
    FROM album_art aa
    JOIN albums  al      ON al.id = aa.album_id
    LEFT JOIN artists ar ON ar.id = al.artist_id
    JOIN art_files af    ON af.id = aa.art_id
    ORDER BY al.name, ar.name, al.year, af.kind, af.cache_file, af.rel_path
  `).all();
}
