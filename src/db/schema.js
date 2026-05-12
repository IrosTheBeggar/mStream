// SQLite schema definitions and migration system for mStream.
// Uses PRAGMA user_version for tracking which migrations have been applied.
//
// ── TRIGGER SURVIVAL WARNING ──────────────────────────────────────────────
// V31 attaches AFTER triggers to `tracks`, `artists`, and `albums` to keep
// the FTS5 virtual tables (`fts_tracks`, `fts_artists`, `fts_albums`) in
// sync. Any future migration that does a `*_new` table-swap rebuild on
// `tracks`, `artists`, or `albums` (see V18's albums rebuild and V24's
// tracks rebuild for the pattern) MUST re-create the V31 triggers inside
// the same migration. `DROP TABLE` drops attached triggers; forgetting to
// re-create them silently breaks search on every upgrade past that
// migration. The trigger DDL lives in SCHEMA_V31 — grep there.
// ──────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 33;

export const SCHEMA_V1 = `
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    allow_upload INTEGER NOT NULL DEFAULT 1,
    allow_mkdir INTEGER NOT NULL DEFAULT 1,
    lastfm_user TEXT,
    lastfm_password TEXT
  );

  -- Libraries (vpaths)
  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'music'
  );

  -- User access to libraries
  CREATE TABLE IF NOT EXISTS user_libraries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
  );

  -- Artists
  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_name TEXT,
    mbz_artist_id TEXT
  );

  -- Albums
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year INTEGER,
    album_art_file TEXT,
    mbz_album_id TEXT,
    UNIQUE(name, artist_id, year)
  );

  -- Tracks (files)
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    title TEXT,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_number INTEGER,
    disc_number INTEGER,
    year INTEGER,
    duration REAL,
    bitrate INTEGER,
    format TEXT,
    file_size INTEGER,
    -- file_hash is a content MD5 of the raw file bytes (hex, lowercase).
    -- Changes on ANY byte change, including tag edits. Used for whole-file
    -- integrity (e.g. waveform cache — bytes change → re-render).
    --
    -- Companion column audio_hash (added in migration V14) hashes just the
    -- audio payload region, skipping tag metadata. It is the PREFERRED
    -- identity key for user-facing state (stars, ratings, play counts,
    -- bookmarks, play queue) because it is stable across tag edits,
    -- album-art changes, and ReplayGain rewrites. Populated by the
    -- scanner for mp3, flac, wav, ogg, opus, aac, m4a, m4b, and mp4 —
    -- every format mStream currently supports. Still NULL for rows
    -- written before migration V14 or for any file the format-specific
    -- extractor couldn't parse (corrupt/truncated); user_* tables fall
    -- back to file_hash via COALESCE in that case.
    --
    -- Both scanners (src/db/scanner.mjs and rust-parser/src/main.rs) must
    -- produce byte-identical hashes for the same input file — enforced
    -- by test/audio-hash-parity.test.mjs. Any change to the audio-region
    -- byte extraction must land simultaneously in both scanners and the
    -- golden fixtures.
    file_hash TEXT,
    album_art_file TEXT,
    genre TEXT,
    replaygain_track_db REAL,
    -- modified is mtime in epoch milliseconds — semantically an integer.
    -- Declared INTEGER so SQLite's column affinity stores it as INTEGER
    -- rather than coercing it to REAL on insert. The Rust scanner reads
    -- this column with strict typing (rusqlite refuses REAL→i64), so a
    -- REAL declaration broke load_existing_tracks() on the second scan
    -- of any populated library. V24 migrates pre-existing REAL-stored
    -- rows; fresh databases get INTEGER from V1.
    modified INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    scan_id TEXT,
    UNIQUE(filepath, library_id)
  );

  -- Per-user track metadata (ratings, play counts)
  CREATE TABLE IF NOT EXISTS user_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_hash TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played TEXT,
    rating INTEGER,
    UNIQUE(user_id, track_hash)
  );

  -- Playlists
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, user_id)
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    filepath TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  -- Shared playlists
  CREATE TABLE IF NOT EXISTS shared_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL UNIQUE,
    playlist_json TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires INTEGER,
    token TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_tracks_library ON tracks(library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(file_hash);
  CREATE INDEX IF NOT EXISTS idx_tracks_filepath ON tracks(filepath, library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_scan ON tracks(scan_id);
  CREATE INDEX IF NOT EXISTS idx_user_metadata_hash ON user_metadata(track_hash);
  CREATE INDEX IF NOT EXISTS idx_user_metadata_user ON user_metadata(user_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
  CREATE INDEX IF NOT EXISTS idx_shared_expires ON shared_playlists(expires);
  CREATE INDEX IF NOT EXISTS idx_user_libraries_user ON user_libraries(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_libraries_library ON user_libraries(library_id);
`;

export const SCHEMA_V2 = `
  -- Genres (many-to-many with tracks)
  CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS track_genres (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, genre_id)
  );

  CREATE INDEX IF NOT EXISTS idx_track_genres_track ON track_genres(track_id);
  CREATE INDEX IF NOT EXISTS idx_track_genres_genre ON track_genres(genre_id);
`;

export const SCHEMA_V3 = `
  ALTER TABLE users ADD COLUMN allow_file_modify INTEGER NOT NULL DEFAULT 1;
`;

export const SCHEMA_V4 = `
  ALTER TABLE users ADD COLUMN listenbrainz_token TEXT;

  CREATE TABLE IF NOT EXISTS smart_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filters_json TEXT NOT NULL DEFAULT '{}',
    sort TEXT NOT NULL DEFAULT 'artist',
    limit_n INTEGER NOT NULL DEFAULT 50,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, user_id)
  );
`;

export const SCHEMA_V5 = `
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );
`;

export const SCHEMA_V6 = `
  CREATE TABLE IF NOT EXISTS cue_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    label TEXT,
    color TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cue_points_file ON cue_points(filepath, library_id);
`;

export const SCHEMA_V7 = `
  CREATE TABLE IF NOT EXISTS play_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filepath TEXT NOT NULL,
    library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
    session_id TEXT,
    source TEXT,
    outcome TEXT,
    played_ms INTEGER DEFAULT 0,
    track_duration_ms INTEGER,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    pause_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_play_events_user ON play_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_play_events_started ON play_events(started_at);
  CREATE INDEX IF NOT EXISTS idx_play_events_session ON play_events(session_id);
`;

export const SCHEMA_V8 = `
  CREATE TABLE IF NOT EXISTS scan_progress (
    scan_id TEXT PRIMARY KEY,
    library_id INTEGER,
    vpath TEXT,
    scanned INTEGER DEFAULT 0,
    expected INTEGER,
    current_file TEXT,
    started_at TEXT DEFAULT (datetime('now'))
  );
`;

export const SCHEMA_V9 = `
  -- Per-user API keys. Primary use case: Subsonic API authentication, where
  -- clients send \`apiKey=...\` instead of a username/password pair. Each user
  -- can have multiple keys (one per device/app).
  CREATE TABLE IF NOT EXISTS user_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_user_api_keys_key ON user_api_keys(key);
  CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);
`;

export const SCHEMA_V10 = `
  -- Subsonic star state. Decoupled from rating so a client can star a track
  -- without setting its rating (and vice versa). Populated by Subsonic
  -- star/unstar endpoints; exposed in getStarred2 + the \`starred\` field
  -- on song/album responses.
  ALTER TABLE user_metadata ADD COLUMN starred_at TEXT;
`;

export const SCHEMA_V11 = `
  -- Per-user star state for albums and artists. Subsonic's star/unstar
  -- endpoints accept songId, albumId, and artistId independently; these
  -- tables let us track the latter two directly rather than synthesizing
  -- from child-track stars (which was lossy — unstarring a track
  -- accidentally unstarred the album).
  CREATE TABLE IF NOT EXISTS user_album_stars (
    user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    starred_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, album_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_album_stars_user ON user_album_stars(user_id);

  CREATE TABLE IF NOT EXISTS user_artist_stars (
    user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    starred_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, artist_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_artist_stars_user ON user_artist_stars(user_id);
`;

export const SCHEMA_V12 = `
  -- Subsonic bookmarks: per-user, per-track position markers. Keyed on
  -- track_hash rather than track rowid so bookmarks survive a rescan that
  -- reshuffles ids — same pattern user_metadata uses.
  CREATE TABLE IF NOT EXISTS user_bookmarks (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_hash  TEXT    NOT NULL,
    position_ms INTEGER NOT NULL,
    comment     TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    changed_at  TEXT    DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, track_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_user_bookmarks_user ON user_bookmarks(user_id);
`;

export const SCHEMA_V13 = `
  -- OpenSubsonic getPlayQueue / savePlayQueue: one row per user storing
  -- their current across-device play queue. track_hashes_json is a JSON
  -- array of track_hashes in play order; reading requires mapping back to
  -- current track ids (same rescan-survival reason as bookmarks).
  CREATE TABLE IF NOT EXISTS user_play_queue (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_track_hash TEXT,
    position_ms        INTEGER,
    changed_at         TEXT    DEFAULT (datetime('now')),
    changed_by         TEXT,
    track_hashes_json  TEXT    NOT NULL
  );
`;

export const SCHEMA_V14 = `
  -- Dual-hash identity: audio_hash complements file_hash (see schema_v1
  -- comments on the tracks table). audio_hash hashes just the audio
  -- payload region, so it stays stable across tag edits. Populated by
  -- the scanner for MP3 + FLAC today; NULL for formats we don't parse
  -- yet — user_* tables fall back to file_hash in that case.
  ALTER TABLE tracks ADD COLUMN audio_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_tracks_audio_hash ON tracks(audio_hash);
`;

export const SCHEMA_V15 = `
  -- Playlist visibility flag, for Subsonic getPlaylists.public. 0 = owner
  -- only (default), 1 = visible to every authenticated user. mStream has
  -- no server-wide "public" concept beyond shared_playlists (link-based),
  -- so this is per-user opt-in.
  ALTER TABLE playlists ADD COLUMN public INTEGER NOT NULL DEFAULT 0;

  -- Subsonic share description: free-text label set by createShare and
  -- updateShare, displayed by clients in share-list views. Distinct from
  -- playlist_json (the shared-track list) so updateShare can rewrite one
  -- without the other.
  ALTER TABLE shared_playlists ADD COLUMN description TEXT;
`;

export const SCHEMA_V16 = `
  -- Additional audio-format fields populated by the scanner, exposed
  -- through the Subsonic song object (OpenSubsonic extended fields).
  -- Clients that render per-track "24/96 FLAC" style quality badges read
  -- these. NULL for rows written before V16; the next force-rescan
  -- populates them from the embedded audio properties.
  ALTER TABLE tracks ADD COLUMN sample_rate  INTEGER;
  ALTER TABLE tracks ADD COLUMN channels     INTEGER;
  ALTER TABLE tracks ADD COLUMN bit_depth    INTEGER;
`;

export const SCHEMA_V17 = `
  -- Per-user server-audio access flag. Gates /api/v1/server-playback/* and
  -- the /server-remote page; admins always bypass the gate (server-playback.js
  -- checks user.admin first). Defaults to 0 — operators must opt users in
  -- explicitly via the admin panel rather than inheriting blanket access on
  -- upgrade. V23 normalises any rows populated under the earlier (default=1)
  -- variant of this migration.
  ALTER TABLE users ADD COLUMN allow_server_audio INTEGER NOT NULL DEFAULT 0;
`;

export const SCHEMA_V18 = `
  -- ── Multi-artist / compilation support ────────────────────────────
  --
  -- Prior to V17, albums.artist_id was set to the FIRST-SCANNED TRACK's
  -- artist. Compilations where each track had a different ARTIST tag
  -- fragmented into N separate album rows (one per track-artist), and
  -- the ALBUMARTIST tag was ignored entirely. This migration:
  --
  --   1. Adds albums.album_artist (raw tag display string: e.g.
  --      "Brian Eno & David Byrne") and albums.compilation flag.
  --
  --   2. Changes the uniqueness contract from (name, artist_id, year)
  --      to (name, album_artist_id, year). SQLite can't DROP CONSTRAINT
  --      so we rebuild the table. album_artist_id is the semantic
  --      replacement for the old artist_id column — it stores the
  --      ALBUMARTIST-tag's FK, falling back to track artist for
  --      legacy single-artist rows.
  --
  --   3. Adds album_artists(album_id, artist_id, role, position) and
  --      track_artists(track_id, artist_id, role, position) — the
  --      M2M tables Subsonic getArtist/getArtists + OpenSubsonic
  --      artists[] unroll. role is a TEXT enum we can grow later
  --      (composer, conductor, remixer, …); 'main' for primary,
  --      'featured' for collab-secondary.
  --
  --   4. Seeds the canonical "Various Artists" row with MusicBrainz's
  --      well-known VA UUID so future MBID-aware features (AcoustID,
  --      LastFM bio) hit the right entity.
  --
  -- rescanRequired: true — the scanner must rebuild album_artists and
  -- track_artists from freshly-parsed tags, and the compilation-
  -- collapse step relies on stale-row cleanup at scan end.
  --
  -- user_album_stars references the old fragmented album_ids; the
  -- album-migration helper (src/db/album-migration.js, mirrored in
  -- rust-parser) remaps those during the rescan so stars survive.

  -- Step 1: albums column additions (cheap, no rebuild).
  ALTER TABLE albums ADD COLUMN album_artist TEXT;
  ALTER TABLE albums ADD COLUMN compilation  INTEGER NOT NULL DEFAULT 0;

  -- Step 2: table rebuild for the new UNIQUE. The existing albums row
  -- data is preserved verbatim — the scanner will fix up semantics on
  -- the next rescan. Foreign keys from tracks/user_album_stars to
  -- albums survive because we keep the same id values.
  CREATE TABLE albums_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year INTEGER,
    album_art_file TEXT,
    mbz_album_id TEXT,
    album_artist TEXT,
    compilation INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, artist_id, year)
  );
  INSERT INTO albums_new (id, name, artist_id, year, album_art_file, mbz_album_id, album_artist, compilation)
    SELECT id, name, artist_id, year, album_art_file, mbz_album_id, album_artist, compilation FROM albums;
  DROP TABLE albums;
  ALTER TABLE albums_new RENAME TO albums;
  CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);

  -- Step 3: M2M join tables. position preserves author/tag order so
  -- "Artist A feat. Artist B" stays in that order when emitted.
  CREATE TABLE IF NOT EXISTS album_artists (
    album_id   INTEGER NOT NULL REFERENCES albums(id)  ON DELETE CASCADE,
    artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL DEFAULT 'main',
    position   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, artist_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_album_artists_album  ON album_artists(album_id);
  CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON album_artists(artist_id);

  CREATE TABLE IF NOT EXISTS track_artists (
    track_id   INTEGER NOT NULL REFERENCES tracks(id)  ON DELETE CASCADE,
    artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL DEFAULT 'main',
    position   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (track_id, artist_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_track_artists_track  ON track_artists(track_id);
  CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id);

  -- Step 4: seed the canonical Various Artists row. MusicBrainz's
  -- well-known VA UUID. INSERT OR IGNORE so re-running the migration
  -- (or a V1 DB that already had a row named Various Artists) is safe.
  INSERT OR IGNORE INTO artists (name, mbz_artist_id)
    VALUES ('Various Artists', '89ad4ac3-39f7-470e-963a-56509c546377');
`;

export const SCHEMA_V19 = `
  -- ── Lyrics storage ────────────────────────────────────────────────
  --
  -- Up to V18 the Subsonic getLyrics / getLyricsBySongId endpoints were
  -- empty stubs. This migration gives the scanner four columns to park
  -- whatever lyrics it finds at scan time, so the handlers can serve
  -- them out without re-reading the audio file on every request.
  --
  --   lyrics_embedded       Plain-text unsynced lyrics from the tag
  --                         (ID3v2 USLT, Vorbis LYRICS, MP4 '©lyr',
  --                         APE Lyrics). NULL if no unsynced text.
  --   lyrics_synced_lrc     LRC-format text (line-timed karaoke
  --                         format). Populated from one of: ID3v2
  --                         SYLT rendered back to LRC, a sibling
  --                         <basename>.lrc sidecar, a multi-language
  --                         <basename>.<lang>.lrc sidecar (first
  --                         match wins; sidecars beat SYLT only when
  --                         the tag had nothing). NULL otherwise.
  --   lyrics_lang           ISO-639-1 language tag from USLT's 3-char
  --                         language field (truncated) or the sidecar
  --                         filename suffix. NULL when unknown — most
  --                         clients treat that as "native".
  --   lyrics_sidecar_mtime  ms-epoch mtime of the .lrc file we read,
  --                         or NULL when no sidecar was present. Used
  --                         by the next rescan to decide whether to
  --                         re-read: sidecar mtime drifted → pick up
  --                         the edit. Sidecars are the only lyrics
  --                         source the scanner can notice changing
  --                         independently of the audio file; embedded
  --                         tags ride along with file_hash.
  --
  -- rescanRequired: true — populate these columns from the existing
  -- library. Cheap: an extra fstat per track for the sidecar lookup,
  -- piggy-backed on the readdir the scanner already does for album
  -- art. No external fetches at scan time — that's Phase 3 / LRCLib.
  ALTER TABLE tracks ADD COLUMN lyrics_embedded      TEXT;
  ALTER TABLE tracks ADD COLUMN lyrics_synced_lrc    TEXT;
  ALTER TABLE tracks ADD COLUMN lyrics_lang          TEXT;
  ALTER TABLE tracks ADD COLUMN lyrics_sidecar_mtime INTEGER;
`;

export const SCHEMA_V21 = `
  -- ── Per-library followSymlinks flag ──────────────────────────────
  --
  -- 0 (default) = the scanner does NOT follow symlinks INSIDE this
  -- library. Symlink entries are skipped so scanned content stays
  -- strictly within the library's physical tree.
  --
  -- 1 = the scanner follows symlinks (a symlink entry is treated
  -- as the file/directory it points at). Opt-in per library via
  -- the admin panel because a symlink pointing at a huge directory
  -- outside the library (e.g. /home) would otherwise silently pull
  -- those files into mStream's index.
  --
  -- The library root itself is always followed (readdirSync
  -- operates on the target of a root-level symlink); this flag
  -- only governs nested entries.
  --
  -- Existing rows on pre-V21 databases get 0 on migrate, matching
  -- the Rust scanner's historical behaviour. Operators who relied
  -- on the old JS scanner's silent symlink-following must opt in
  -- per library after upgrading.
  --
  -- Not rescanRequired — the value is consulted at scan-task launch,
  -- so flipping it takes effect on the next scheduled (or manual)
  -- scan of that vpath without rewriting existing track rows.
  ALTER TABLE libraries ADD COLUMN follow_symlinks INTEGER NOT NULL DEFAULT 0;
`;

export const SCHEMA_V22 = `
  -- ── Backfill stray NULLs in libraries.follow_symlinks ────────────
  --
  -- An earlier V21 variant (shipped only on this pre-release branch,
  -- never in a release) declared the column as plain \`INTEGER\` (no
  -- DEFAULT, nullable). Hosts that applied that variant have
  -- user_version = 21 and would skip the rewritten V21 on upgrade,
  -- leaving existing rows + any rows inserted before the code in
  -- src/util/admin.js started writing 0 explicitly with NULL values.
  --
  -- SQLite can't retroactively add a NOT NULL constraint without
  -- rebuilding the table, and it isn't worth the rebuild churn here:
  -- the reader (task-queue.js) treats NULL as false via \`=== 1\`, and
  -- every code path that writes the column now writes 0 or 1. A
  -- one-shot UPDATE to normalise the visible data is sufficient.
  --
  -- No-op on fresh databases (where V21 already wrote 0 into every
  -- row). Not rescanRequired.
  UPDATE libraries SET follow_symlinks = 0 WHERE follow_symlinks IS NULL;
`;

export const SCHEMA_V23 = `
  -- ── Revoke allow_server_audio from non-admin users ───────────────
  --
  -- V17's original variant defaulted allow_server_audio to 1 so
  -- existing users kept access on upgrade. That created a silent
  -- permissiveness regression for operators migrating from pre-V17
  -- mStream (or from the Loki-based stack, which never had this
  -- flag at all): every user — including guest / anonymous shared-
  -- link accounts — could reach /api/v1/server-playback/* without
  -- an explicit opt-in.
  --
  -- V17 now defaults to 0 going forward. This migration forces
  -- every non-admin user to 0 so branch-trackers, Loki-migrated
  -- hosts, and anyone upgrading across V17 converge on the same
  -- "admin approves per-user" posture. Admins are exempt — they
  -- bypass the gate anyway (see userCanUseServerAudio() in
  -- server-playback.js), so clearing their flag is harmless but
  -- leaving it intact keeps the "admins can everything" invariant
  -- visible at a glance in the users table.
  --
  -- Operators who WANT broad server-audio access can run one
  -- UPDATE after upgrading, or flip each user through the admin
  -- panel. The revocation is loud in the release notes.
  --
  -- Not rescanRequired.
  UPDATE users SET allow_server_audio = 0 WHERE is_admin = 0;
`;

export const SCHEMA_V20 = `
  -- ── LRCLib external-lookup cache ─────────────────────────────────
  --
  -- Opt-in (config.lyrics.lrclib = true). When a track has no local
  -- lyrics (no embedded tag, no .lrc/.txt sidecar) the handler
  -- consults this table; cache miss triggers an async fetch from
  -- lrclib.net. The fetch NEVER blocks the HTTP response — request
  -- returns an empty envelope immediately, cache warms for next call.
  --
  -- Keyed on audio_hash so a cache hit survives tag rewrites and
  -- ReplayGain updates (same stability story as user_metadata). Rows
  -- for tracks that get deleted stick around until the admin "purge"
  -- button runs — dangling rows cost ~2KB each and the next fetch
  -- for the same audio_hash reuses them. No FK here precisely to
  -- allow that reuse across library shuffles (a track leaves library
  -- A and reappears in library B with the same bytes: cache warm).
  --
  --   status = 'hit'   — fetched successfully, synced/plain populated
  --          = 'miss'  — LRCLib returned 404 or empty body
  --          = 'error' — network/timeout/parse failure; retry after
  --                      a short TTL so a blip doesn't stick
  --          = 'pending' — async fetch queued (never served; acts as
  --                        a dedup flag so concurrent requests for
  --                        the same track don't enqueue twice)
  --
  -- fetched_at is ms epoch. TTL logic lives in the handler
  -- (src/api/lyrics-lrclib.js) not here — the table just records
  -- "when" and the code decides "how stale".
  CREATE TABLE IF NOT EXISTS lyrics_cache (
    audio_hash  TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    synced_lrc  TEXT,
    plain       TEXT,
    lang        TEXT,
    source      TEXT,       -- 'lrclib' for now; room for future providers
    fetched_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lyrics_cache_status ON lyrics_cache(status);
  CREATE INDEX IF NOT EXISTS idx_lyrics_cache_fetched ON lyrics_cache(fetched_at);
`;

export const SCHEMA_V24 = `
  -- ── Re-type tracks.modified from REAL to INTEGER ─────────────────
  --
  -- tracks.modified holds an mtime as epoch milliseconds — semantically
  -- always an integer. SCHEMA_V1 declared the column REAL, which made
  -- SQLite's column affinity coerce every inserted i64 to a float on
  -- write. The JS scanner reads with loose typing and never noticed,
  -- but the Rust scanner reads through rusqlite's strict typing:
  --
  --     row.get::<_, i64>(2)?   →   "Invalid column type Real at index 2"
  --
  -- Symptom for end users: the FIRST scan of a fresh DB succeeds
  -- (load_existing_tracks() returns empty before insert), then EVERY
  -- subsequent scan fails before doing any work, leaving the library
  -- frozen at whatever the first scan happened to write. New files
  -- never appear; deletions are never reaped.
  --
  -- Fix: rebuild the table with 'modified INTEGER' and CAST existing
  -- values back to integer on copy. Tracks ids are preserved across
  -- the rebuild so the M2M tables (track_artists, track_genres) keep
  -- valid references — but DROP TABLE in SQLite DOES fire ON DELETE
  -- CASCADE when foreign_keys are enabled, so we have to back the M2M
  -- rows out into TEMP tables, empty the M2M tables, do the rebuild,
  -- then restore. (V18's albums rebuild didn't need this dance because
  -- album_artists/track_artists were created NEW in the same migration
  -- and had no preexisting rows to lose.)
  --
  -- Not rescanRequired: data is preserved, just re-typed.

  -- Snapshot M2M relations referencing tracks(id) before the rebuild.
  CREATE TEMP TABLE _v24_track_artists_backup AS SELECT * FROM track_artists;
  CREATE TEMP TABLE _v24_track_genres_backup  AS SELECT * FROM track_genres;

  -- Empty the M2M tables so the upcoming DROP TABLE tracks doesn't
  -- cascade-delete anything we still need (rows are already gone) and
  -- so the FK check on DROP TABLE has no inbound references to worry
  -- about. The TEMP backups above hold the data we'll restore.
  DELETE FROM track_artists;
  DELETE FROM track_genres;

  CREATE TABLE tracks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    title TEXT,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_number INTEGER,
    disc_number INTEGER,
    year INTEGER,
    duration REAL,
    bitrate INTEGER,
    format TEXT,
    file_size INTEGER,
    file_hash TEXT,
    album_art_file TEXT,
    genre TEXT,
    replaygain_track_db REAL,
    modified INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    scan_id TEXT,
    audio_hash TEXT,
    sample_rate INTEGER,
    channels INTEGER,
    bit_depth INTEGER,
    lyrics_embedded TEXT,
    lyrics_synced_lrc TEXT,
    lyrics_lang TEXT,
    lyrics_sidecar_mtime INTEGER,
    UNIQUE(filepath, library_id)
  );

  INSERT INTO tracks_new (
    id, filepath, library_id, title, artist_id, album_id, track_number,
    disc_number, year, duration, bitrate, format, file_size, file_hash,
    album_art_file, genre, replaygain_track_db, modified, created_at,
    scan_id, audio_hash, sample_rate, channels, bit_depth,
    lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime
  )
  SELECT
    id, filepath, library_id, title, artist_id, album_id, track_number,
    disc_number, year, duration, bitrate, format, file_size, file_hash,
    album_art_file, genre, replaygain_track_db, CAST(modified AS INTEGER), created_at,
    scan_id, audio_hash, sample_rate, channels, bit_depth,
    lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime
  FROM tracks;

  DROP TABLE tracks;
  ALTER TABLE tracks_new RENAME TO tracks;

  -- Restore the M2M rows. track_id values are preserved across the
  -- rebuild (we copied the ids verbatim), so FK checks pass.
  INSERT INTO track_artists SELECT * FROM _v24_track_artists_backup;
  INSERT INTO track_genres  SELECT * FROM _v24_track_genres_backup;

  DROP TABLE _v24_track_artists_backup;
  DROP TABLE _v24_track_genres_backup;

  CREATE INDEX IF NOT EXISTS idx_tracks_library    ON tracks(library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist     ON tracks(artist_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_album      ON tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_hash       ON tracks(file_hash);
  CREATE INDEX IF NOT EXISTS idx_tracks_filepath   ON tracks(filepath, library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_scan       ON tracks(scan_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_audio_hash ON tracks(audio_hash);
`;

export const SCHEMA_V25 = `
  -- ── Anonymous sentinel flag ──────────────────────────────────────
  --
  -- mStream supports a public read-only "no users configured" mode.
  -- Every per-user table (user_metadata, playlists, cue_points, …)
  -- has a NOT NULL FK on users(id), so anonymous traffic still needs
  -- *some* valid user_id to attribute writes to. Solution: keep one
  -- always-present sentinel row in users with this flag set to 1.
  -- src/db/manager.js inserts the sentinel after migrations run and
  -- pins anonymous req.user.id to its rowid in src/api/auth.js.
  --
  -- The flag (rather than a reserved username) is what identifies
  -- the sentinel — usernames have no validation, so a real admin
  -- could have already created a user with any name we'd otherwise
  -- pick. A flag column is uncollidable: existing rows default to
  -- 0 on migrate; only ensureAnonymousUser() ever writes 1.
  --
  -- getAllUsers() filters rows where is_anonymous_sentinel = 1 so
  -- admin panels and the auth empty-check ('no real users') don't
  -- see it. Login attempts against the sentinel always fail at the
  -- PBKDF2 stage — its stored hash is the literal '!', a value no
  -- PBKDF2 output can produce.
  --
  -- Not rescanRequired.
  ALTER TABLE users ADD COLUMN is_anonymous_sentinel INTEGER NOT NULL DEFAULT 0;
`;

// Numbered V28 (skipping 26 and 27) because some user databases were
// migrated to user_version=27 by experimental branches whose schema
// changes were never merged into main. Re-using 26 or 27 here would
// mean the new tables silently never get created on those databases
// (the runMigrations loop only applies migrations strictly greater
// than the current user_version). All backup tables use CREATE TABLE
// IF NOT EXISTS so the gap is harmless on fresh installs too.
export const SCHEMA_V28 = `
  -- ── Local backup destinations ────────────────────────────────────
  --
  -- Per-library mirror destinations on the same host. The backup
  -- module (src/backup/manager.js) walks each enabled destination,
  -- compares source vs dest by mtime+size, copies changed files via
  -- tmpfile→rename, and soft-deletes removed/replaced files into
  -- <dest_path>/.mstream-trash/<YYYY-MM-DD>/ so an accidental
  -- source-side rm has a retention window before it propagates.
  --
  -- trigger_type:
  --   'after-scan' — fires from task-queue.js:onScanClose() for the
  --                  matching library_id. The natural default since
  --                  the scanner already detects library changes.
  --   'daily'      — fires from a 5-minute manager tick when the
  --                  current local hour matches daily_at_hour AND
  --                  no successful run exists for today.
  --   'manual'     — only fires from POST /api/v1/backup/run.
  --
  -- retention_days: how long soft-deleted files stay in the trash
  --   folder before the daily sweep prunes them. 0 = hard prune
  --   (no trash folder is written; deletes are immediate).
  --
  -- UNIQUE(library_id, dest_path): catches accidental double-
  --   registration of the same library→path pair, which would
  --   otherwise cause two workers to fight over the same dest tree.
  CREATE TABLE IF NOT EXISTS backup_destinations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id      INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    dest_path       TEXT    NOT NULL,
    trigger_type    TEXT    NOT NULL DEFAULT 'after-scan',
    daily_at_hour   INTEGER,
    retention_days  INTEGER NOT NULL DEFAULT 30,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(library_id, dest_path)
  );
  CREATE INDEX IF NOT EXISTS idx_backup_dest_library ON backup_destinations(library_id);

  -- ── Backup run history ───────────────────────────────────────────
  --
  -- One row per backup run (whether attempted, skipped, or failed).
  -- Manager inserts a 'running' row at the start of each run and
  -- updates it to 'success'/'failed' on completion. On startup any
  -- rows still 'running' are flipped to 'failed' with an "interrupted"
  -- message — the worker can't recover from a server crash mid-run.
  --
  -- status:
  --   'running' — worker is alive (or was when the row was written)
  --   'success' — finished cleanly
  --   'failed'  — worker errored or exited non-zero; error_message set
  --   'skipped' — another run was already in flight for this dest;
  --               recorded so the user sees why the trigger didn't
  --               produce a backup
  --
  -- Counts are populated incrementally by the worker via stdout
  -- progress events and finalised on close.
  CREATE TABLE IF NOT EXISTS backup_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    destination_id   INTEGER NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
    started_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at      TEXT,
    status           TEXT    NOT NULL DEFAULT 'running',
    trigger_reason   TEXT,
    files_copied     INTEGER NOT NULL DEFAULT 0,
    files_unchanged  INTEGER NOT NULL DEFAULT 0,
    files_trashed    INTEGER NOT NULL DEFAULT 0,
    bytes_copied     INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_backup_hist_dest ON backup_history(destination_id, started_at DESC);
`;

export const SCHEMA_V30 = `
  -- Per-destination inter-file throttle (ms). After each file the worker
  -- copies (with bytes actually written), it sleeps this many ms before
  -- moving to the next entry. 0 = no throttle (default).
  --
  -- Picked over per-byte bandwidth limiting because:
  --   - It's a 1-line worker change vs. ~150 lines for a token-bucket
  --     streamed copy (which would also lose platform fast-copy
  --     syscalls like clonefile / copy_file_range / CopyFileEx).
  --   - For music libraries (mostly 5-50MB files copying in < 1s) a
  --     small inter-file delay gives streaming clients enough buffer-
  --     refill time to avoid playback skips during a backup.
  --
  -- The known weakness is single-huge-file copies (5GB audiobooks,
  -- multi-hour FLAC concert rips): those saturate I/O for the duration
  -- of the one copy, which a per-file delay can't help. If users with
  -- those workloads complain, that's the trigger to revisit and add
  -- proper bandwidth limiting on top.
  ALTER TABLE backup_destinations ADD COLUMN inter_file_delay_ms INTEGER NOT NULL DEFAULT 0;
`;

export const SCHEMA_V29 = `
  -- Per-destination exclude patterns. Stored as a JSON array of glob
  -- strings (e.g. '["Thumbs.db","*.tmp",".DS_Store"]'). Each pattern
  -- matches against the basename of any entry encountered during a
  -- merge-walk (file or directory) — case-insensitively, since
  -- Windows + macOS default filesystems are case-insensitive and
  -- "match what the user clearly meant" trumps Unix case-sensitivity
  -- for this knob.
  --
  -- NULL means "use the API-layer defaults" (Thumbs.db, desktop.ini,
  -- .DS_Store, ._*) — chosen to skip the OS detritus most music
  -- libraries pick up from being browsed by Windows Explorer or macOS
  -- Finder. An empty array '[]' means "exclude nothing" (everything
  -- gets backed up).
  --
  -- Filtering applies symmetrically on source AND dest sides during
  -- the merge-walk. Without that symmetry, removing a pattern from
  -- the source-side filter while leaving it on dest would have the
  -- worker treat any matching file already on dest as an orphan and
  -- trash it on the next run.
  ALTER TABLE backup_destinations ADD COLUMN exclude_globs TEXT;
`;

export const SCHEMA_V31 = `
  -- ── FTS5 search index (tracks / artists / albums) ────────────────────
  --
  -- Three regular FTS5 virtual tables (NO content= clause — they store
  -- their own copies of the indexed columns, which makes UPDATE-by-rowid
  -- a first-class operation in the triggers below). One per natural
  -- search target.
  --
  -- The 'unicode61 remove_diacritics 1' tokenizer is the standard
  -- choice for music search: café == cafe, case-insensitive, splits on
  -- whitespace + punctuation. It's the same tokenizer the velvet fork
  -- uses for its fts_files index, so user expectations port cleanly.
  --
  -- fts_tracks indexes denormalised join data (artist_name, album_name)
  -- so a single MATCH expression like '"chaka khan" AND "ain't nobody"'
  -- can hit one index instead of unioning three. The artist/album
  -- triggers below fan out a name change to every fts_tracks row that
  -- references that artist/album, so the denormalised copy never goes
  -- stale.
  --
  -- WHY REGULAR FTS5 INSTEAD OF EXTERNAL CONTENT:
  --   - Upstream's source data lives across three joined tables; FTS5
  --     external-content is single-table.
  --   - Regular FTS5 supports natural UPDATE statements in triggers,
  --     vs. contentless mode's awkward 'delete' protocol that requires
  --     supplying the exact OLD column values to invalidate doclist
  --     entries — error-prone when the source has changed since insert.
  --   - Disk overhead is ~30% over the indexed text, acceptable for a
  --     music library (~10–20 MB extra at 100k tracks).
  CREATE VIRTUAL TABLE fts_tracks USING fts5(
    title, artist_name, album_name, filepath,
    tokenize = 'unicode61 remove_diacritics 1'
  );
  CREATE VIRTUAL TABLE fts_artists USING fts5(
    name,
    tokenize = 'unicode61 remove_diacritics 1'
  );
  CREATE VIRTUAL TABLE fts_albums USING fts5(
    name,
    tokenize = 'unicode61 remove_diacritics 1'
  );

  -- ── Backfill ─────────────────────────────────────────────────────────
  --
  -- One-time INSERT…SELECT from the existing rows. LEFT JOINs cover
  -- tracks whose artist_id / album_id is NULL (set via FK ON DELETE
  -- SET NULL when the parent row was previously deleted) — those rows
  -- end up with NULL in fts_tracks.artist_name / album_name, which is
  -- exactly what the steady-state triggers also produce.
  --
  -- Not rescanRequired: nothing here is sourced from disk; we're
  -- denormalising existing DB rows.
  INSERT INTO fts_tracks(rowid, title, artist_name, album_name, filepath)
    SELECT t.id, t.title, a.name, al.name, t.filepath
    FROM tracks t
    LEFT JOIN artists a  ON a.id  = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id;
  INSERT INTO fts_artists(rowid, name) SELECT id, name FROM artists;
  INSERT INTO fts_albums(rowid, name)  SELECT id, name FROM albums;

  -- ── Triggers: tracks → fts_tracks ────────────────────────────────────
  --
  -- AFTER triggers (not BEFORE) so the parent row is committed before
  -- the FTS sync runs. Subqueries against artists/albums look up the
  -- name by the just-written FK, mirroring backfill's LEFT JOIN
  -- semantics: missing FK → NULL name.
  --
  -- tracks_au_fts watches a column allowlist (title, artist_id, album_id,
  -- filepath). Updates to other columns (e.g. play_count via cascading
  -- writes from user_metadata changes) don't trigger an FTS rewrite —
  -- pure no-op savings on hot paths.
  CREATE TRIGGER tracks_ai_fts AFTER INSERT ON tracks BEGIN
    INSERT INTO fts_tracks(rowid, title, artist_name, album_name, filepath)
    VALUES (
      NEW.id,
      NEW.title,
      (SELECT name FROM artists WHERE id = NEW.artist_id),
      (SELECT name FROM albums  WHERE id = NEW.album_id),
      NEW.filepath
    );
  END;

  CREATE TRIGGER tracks_ad_fts AFTER DELETE ON tracks BEGIN
    DELETE FROM fts_tracks WHERE rowid = OLD.id;
  END;

  CREATE TRIGGER tracks_au_fts AFTER UPDATE OF title, artist_id, album_id, filepath ON tracks BEGIN
    UPDATE fts_tracks
       SET title       = NEW.title,
           artist_name = (SELECT name FROM artists WHERE id = NEW.artist_id),
           album_name  = (SELECT name FROM albums  WHERE id = NEW.album_id),
           filepath    = NEW.filepath
     WHERE rowid = NEW.id;
  END;

  -- ── Triggers: artists → fts_artists + fan-out to fts_tracks ──────────
  --
  -- An UPDATE OF name on artists must propagate to every fts_tracks row
  -- whose tracks.artist_id matches — otherwise the denormalised
  -- artist_name column goes stale and a search for the new name misses
  -- those tracks.
  --
  -- DELETE on artists: tracks.artist_id is FK ON DELETE SET NULL. The
  -- cascading UPDATE on tracks fires tracks_au_fts (because artist_id
  -- is in its column allowlist) regardless of recursive_triggers —
  -- FK actions trigger AFTER UPDATE triggers on the child table as a
  -- standard part of foreign_keys=ON semantics, not as a recursion
  -- case. We still set PRAGMA recursive_triggers = ON in
  -- src/db/manager.js + scanner.mjs + rust-parser as defence-in-depth
  -- against any future trigger body whose write would itself fire
  -- another user trigger.
  CREATE TRIGGER artists_ai_fts AFTER INSERT ON artists BEGIN
    INSERT INTO fts_artists(rowid, name) VALUES (NEW.id, NEW.name);
  END;

  CREATE TRIGGER artists_ad_fts AFTER DELETE ON artists BEGIN
    DELETE FROM fts_artists WHERE rowid = OLD.id;
  END;

  CREATE TRIGGER artists_au_fts AFTER UPDATE OF name ON artists BEGIN
    UPDATE fts_artists SET name = NEW.name WHERE rowid = NEW.id;
    UPDATE fts_tracks SET artist_name = NEW.name
     WHERE rowid IN (SELECT id FROM tracks WHERE artist_id = NEW.id);
  END;

  -- ── Triggers: albums → fts_albums + fan-out to fts_tracks ────────────
  --
  -- Parallel design to artists triggers. UPDATE OF name fans out;
  -- DELETE relies on FK ON DELETE SET NULL on tracks.album_id +
  -- recursive_triggers to clear album_name in fts_tracks rows.
  CREATE TRIGGER albums_ai_fts AFTER INSERT ON albums BEGIN
    INSERT INTO fts_albums(rowid, name) VALUES (NEW.id, NEW.name);
  END;

  CREATE TRIGGER albums_ad_fts AFTER DELETE ON albums BEGIN
    DELETE FROM fts_albums WHERE rowid = OLD.id;
  END;

  CREATE TRIGGER albums_au_fts AFTER UPDATE OF name ON albums BEGIN
    UPDATE fts_albums SET name = NEW.name WHERE rowid = NEW.id;
    UPDATE fts_tracks SET album_name = NEW.name
     WHERE rowid IN (SELECT id FROM tracks WHERE album_id = NEW.id);
  END;
`;

export const SCHEMA_V32 = `
  -- ── BPM & musical key on tracks ──────────────────────────────────────
  --
  -- Three nullable columns sourced from embedded tags at scan time:
  --
  --   bpm           INTEGER   — TBPM (ID3v2) / BPM (Vorbis) / tmpo (MP4)
  --                             Range-validated to 20–300; out-of-range
  --                             or unparseable values land as NULL.
  --   musical_key   TEXT      — TKEY (ID3v2) / INITIALKEY (Vorbis)
  --                             Trimmed, capped at 12 chars. Stored
  --                             verbatim — no Camelot normalisation here.
  --                             The Auto-DJ side translates Camelot
  --                             codes ↔ raw key names per the velvet map.
  --   bpm_source    TEXT      — Provenance label. 'tag' when sourced
  --                             from the file's embedded tag during a
  --                             scan; reserved for future audio-analysis
  --                             integrations (e.g. Essentia, AcousticBrainz)
  --                             that would write a different label. NULL
  --                             when no BPM/key data was found.
  --
  -- NOT rescanRequired. Empty columns are valid — they just mean the
  -- DB has no BPM/key data for those rows. The Auto-DJ fallback chain
  -- gracefully degrades when these are NULL. Forcing a full rescan of
  -- multi-terabyte libraries on every upgrade isn't worth it for a
  -- nice-to-have feature; users who want immediate population can
  -- trigger an admin rescan via the admin panel.
  --
  -- Foundation for the Auto-DJ port from the velvet fork (PR plan
  -- step A). A subsequent PR will wire these columns into
  -- POST /api/v1/db/random-songs filters; no API consumer should
  -- depend on these columns until that ships.
  ALTER TABLE tracks ADD COLUMN bpm         INTEGER;
  ALTER TABLE tracks ADD COLUMN musical_key TEXT;
  ALTER TABLE tracks ADD COLUMN bpm_source  TEXT;
`;

export const SCHEMA_V33 = `
  -- ── Indexes for the Auto-DJ BPM/key waterfall ──────────────────────
  --
  -- POST /api/v1/db/random-songs runs up to ten queries per pick
  -- when the user enables BPM-continuity / harmonic-mixing. Each of
  -- those queries is a WHERE-clause variant of
  --   ... AND t.bpm IS NOT NULL AND (t.bpm >= ? AND t.bpm <= ?)
  -- or its musical_key sibling. Without these indexes every step is a
  -- full table scan over the tracks table — fine at 10k tracks
  -- (~5ms), real pain at 100k+ tracks (~50-200ms × the waterfall
  -- depth).
  --
  -- Non-rescanRequired. Pure read-side optimisation. Empty libraries
  -- get empty indexes; SQLite handles that as a no-op.
  --
  -- The indexes only cover the column; we don't include library_id
  -- because the query always also filters via libraryFilter() and
  -- SQLite picks the most-selective single-column index for the
  -- WHERE — combining them into a composite gains nothing here and
  -- doubles the index storage.
  CREATE INDEX IF NOT EXISTS idx_tracks_bpm         ON tracks(bpm);
  CREATE INDEX IF NOT EXISTS idx_tracks_musical_key ON tracks(musical_key);
`;

// Inverse of V31 — used by scripts/rollback-v31.js for the rare case
// where an admin wants to roll back without bringing the code along.
// Not part of the MIGRATIONS array (the migration runner is one-way
// up-only by design).
//
// BOOMERANG CAVEAT: running this on a database that's still attached
// to a v31-aware codebase will reverse on the next boot, because the
// migration runner will detect user_version = 30 and re-apply V31.
// Pair the rollback with a code revert to a pre-V31 image. See
// docs/migration-rollback.md for the operator runbook.
//
// Idempotent — `IF EXISTS` on every drop so partial state from a
// half-applied V31 (or a second rollback) doesn't error.
export const SCHEMA_V31_DOWN = `
  DROP TRIGGER IF EXISTS tracks_ai_fts;
  DROP TRIGGER IF EXISTS tracks_au_fts;
  DROP TRIGGER IF EXISTS tracks_ad_fts;
  DROP TRIGGER IF EXISTS artists_ai_fts;
  DROP TRIGGER IF EXISTS artists_au_fts;
  DROP TRIGGER IF EXISTS artists_ad_fts;
  DROP TRIGGER IF EXISTS albums_ai_fts;
  DROP TRIGGER IF EXISTS albums_au_fts;
  DROP TRIGGER IF EXISTS albums_ad_fts;
  DROP TABLE IF EXISTS fts_tracks;
  DROP TABLE IF EXISTS fts_artists;
  DROP TABLE IF EXISTS fts_albums;
  PRAGMA user_version = 30;
`;

// rescanRequired: true — marks migrations that change the tracks table schema
// and need a force rescan to populate new fields. When applied, a marker file
// is written so the next boot triggers rescanAll() instead of scanAll().
export const MIGRATIONS = [
  { version: 1,  sql: SCHEMA_V1  },
  { version: 2,  sql: SCHEMA_V2  },
  { version: 3,  sql: SCHEMA_V3  },
  { version: 4,  sql: SCHEMA_V4  },
  { version: 5,  sql: SCHEMA_V5  },
  { version: 6,  sql: SCHEMA_V6  },
  { version: 7,  sql: SCHEMA_V7  },
  { version: 8,  sql: SCHEMA_V8  },
  { version: 9,  sql: SCHEMA_V9  },
  { version: 10, sql: SCHEMA_V10 },
  { version: 11, sql: SCHEMA_V11 },
  { version: 12, sql: SCHEMA_V12 },
  { version: 13, sql: SCHEMA_V13 },
  { version: 14, sql: SCHEMA_V14, rescanRequired: true },
  { version: 15, sql: SCHEMA_V15 },
  { version: 16, sql: SCHEMA_V16, rescanRequired: true },
  { version: 17, sql: SCHEMA_V17 },
  { version: 18, sql: SCHEMA_V18, rescanRequired: true },
  { version: 19, sql: SCHEMA_V19, rescanRequired: true },
  // V20 adds the lyrics_cache table for the LRCLib fallback. Starts
  // empty; no rescan needed. Cache warms lazily per-track on first
  // /rest/getLyricsBySongId or /api/v1/lyrics hit against a track
  // with no embedded/sidecar lyrics.
  { version: 20, sql: SCHEMA_V20 },
  // V21 adds per-library `follow_symlinks` flag. NOT NULL DEFAULT 0
  // — existing libraries default to "don't follow" (matching the
  // Rust scanner's historical behaviour). Operators toggle it per
  // library via the admin panel. No rescan required; the value is
  // consulted at scan-task launch.
  { version: 21, sql: SCHEMA_V21 },
  // V22 backfills any NULL follow_symlinks rows left behind by an
  // earlier nullable V21 variant that only ever existed on this
  // branch. See SCHEMA_V22 comments — no-op on fresh databases.
  { version: 22, sql: SCHEMA_V22 },
  // V23 revokes allow_server_audio for all non-admin users. V17's
  // default flipped from 1 to 0 in this release; V23 normalises
  // existing rows so branch-trackers / Loki-migrated hosts don't
  // silently keep blanket access. See SCHEMA_V23 comments.
  { version: 23, sql: SCHEMA_V23 },
  // V24 retypes tracks.modified from REAL → INTEGER. Long-standing
  // schema/scanner mismatch: the Rust scanner reads modified as i64
  // through rusqlite's strict typing, and a REAL column made every
  // subsequent scan blow up after the first one populated rows.
  // Fresh databases land at INTEGER via SCHEMA_V1; existing rows are
  // CAST during a tracks-table rebuild. See SCHEMA_V24 comments.
  { version: 24, sql: SCHEMA_V24 },
  // V25 adds users.is_anonymous_sentinel — flag for the always-
  // present sentinel row that backs no-users public mode. The flag
  // is what identifies the sentinel (not its username), so an
  // admin who happens to have already created a user with our
  // canonical name can't accidentally collide with the sentinel
  // semantics. See SCHEMA_V25 comments.
  { version: 25, sql: SCHEMA_V25 },
  // V28 adds backup_destinations + backup_history for per-library
  // local mirrors managed by src/backup/. No rescan required;
  // both tables start empty and are populated only when an admin
  // configures a destination via POST /api/v1/backup/destinations.
  // Numbered 28 (not 26) to clear unmerged-experimental-branch
  // user_version bumps in the wild; see SCHEMA_V28 comment.
  { version: 28, sql: SCHEMA_V28 },
  // V29 adds backup_destinations.exclude_globs for the per-destination
  // glob-pattern filter. Existing rows get NULL (which the API treats
  // as "use the default pattern list").
  { version: 29, sql: SCHEMA_V29 },
  // V30 adds backup_destinations.inter_file_delay_ms — a simple per-file
  // throttle the worker applies between successful copies. Defaults to
  // 0 (no throttle). See SCHEMA_V30 comments for the design trade-off
  // vs. true bandwidth limiting.
  { version: 30, sql: SCHEMA_V30 },
  // V31 adds FTS5 search: fts_tracks (with denormalised artist/album
  // names) + fts_artists + fts_albums, plus nine AFTER triggers that
  // keep them in sync with the source tables. Backfill from existing
  // rows runs inside the same migration transaction. Not rescanRequired.
  // See SCHEMA_V31 comments for the trigger-survival warning that
  // applies to any future tracks/artists/albums table rebuild.
  { version: 31, sql: SCHEMA_V31 },
  // V32 adds tracks.bpm / musical_key / bpm_source. Nullable, no
  // rescan required — empty columns are valid. Foundation for the
  // Auto-DJ velvet port; see SCHEMA_V32 comments.
  { version: 32, sql: SCHEMA_V32 },
  // V33 adds indexes on tracks.bpm and tracks.musical_key so the
  // Auto-DJ BPM/key fallback waterfall doesn't full-scan the tracks
  // table on every step. Pure read-side optimisation, no schema
  // shape change. See SCHEMA_V33 for the rationale.
  { version: 33, sql: SCHEMA_V33 },
];
