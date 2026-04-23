// SQLite schema definitions and migration system for mStream.
// Uses PRAGMA user_version for tracking which migrations have been applied.

export const SCHEMA_VERSION = 26;

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
    modified REAL,
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

// ── V24: separate Subsonic password column on users ─────────────────────────
//
// Subsonic clients authenticate with `u/p` (plaintext) or token (md5(pw+salt)).
// mStream only stores PBKDF2 hashes, which rules out token auth entirely. For
// plaintext auth we currently check `users.password` by running the caller's
// plaintext through PBKDF2 and comparing. That works but forces users to use
// their mStream password inside Subsonic clients — painful when the mStream
// password is long / has odd chars that some clients mangle in query strings.
//
// V24 adds a nullable `subsonic_password` column. When set, Subsonic auth
// compares against it first (plaintext) before falling through to the PBKDF2
// check. Admin mints / clears it via POST /api/v1/admin/users/subsonic-password.
// Stored plaintext by necessity — Subsonic's `u/p` flow has no equivalent of
// TLS+hashed comparison at the protocol level. Document clearly in the admin
// UI and never log the value.
export const SCHEMA_V24 = `
  ALTER TABLE users ADD COLUMN subsonic_password TEXT;
`;

// ── V25: Internet radio stations ────────────────────────────────────────────
//
// Per-user list of streaming radio stations. Exposed via the Velvet sidebar
// and via Subsonic's getInternetRadioStations (+ create/update/delete) so both
// frontends see the same data. Ordering is per-user with an explicit index so
// drag-reorder is stable across sessions. No unique constraint on URL — users
// may legitimately want the same stream under multiple names (e.g. a "rock"
// and "chill" entry pointing at the same mixed-format stream).
export const SCHEMA_V25 = `
  CREATE TABLE IF NOT EXISTS radio_stations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    stream_url   TEXT NOT NULL,
    homepage_url TEXT,
    logo_url     TEXT,
    -- Velvet's editor surfaces genre / country as dedicated fields; keep
    -- them columns rather than stuffing into a JSON blob so Subsonic's
    -- (limited) CRUD shape can map cleanly too.
    genre        TEXT,
    country      TEXT,
    order_idx    INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_radio_stations_user ON radio_stations(user_id, order_idx);
`;

// ── V26: Podcasts ───────────────────────────────────────────────────────────
//
// Two tables: feeds (subscriptions) and episodes (individual enclosures).
// Per-user ownership keeps each user's subscription list isolated. Episodes
// are (feed_id, guid) unique — RSS GUIDs aren't guaranteed globally unique
// across feeds so we scope by feed. Downloaded episodes store their local
// path; episodes with NULL local_path are streamed directly from the
// enclosure URL. pub_date index supports the Subsonic getNewestPodcasts
// cross-feed ordering.
export const SCHEMA_V26 = `
  CREATE TABLE IF NOT EXISTS podcast_feeds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    title        TEXT,
    description  TEXT,
    image_url    TEXT,
    last_fetched DATETIME,
    created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_feeds_user_url
    ON podcast_feeds(user_id, url);

  CREATE TABLE IF NOT EXISTS podcast_episodes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id        INTEGER NOT NULL REFERENCES podcast_feeds(id) ON DELETE CASCADE,
    guid           TEXT,
    title          TEXT,
    description    TEXT,
    pub_date       DATETIME,
    enclosure_url  TEXT,
    enclosure_type TEXT,
    duration       INTEGER,
    downloaded     INTEGER NOT NULL DEFAULT 0,
    local_path     TEXT,
    created_at     DATETIME NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_episodes_feed_guid
    ON podcast_episodes(feed_id, guid);
  CREATE INDEX IF NOT EXISTS idx_podcast_episodes_pub_date
    ON podcast_episodes(pub_date DESC);
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
  // V24 adds subsonic_password column so admins can set a separate
  // password for Subsonic clients without repurposing the mStream
  // password. See SCHEMA_V24 comments.
  { version: 24, sql: SCHEMA_V24 },
  // V25 creates radio_stations to back both the Velvet sidebar and
  // Subsonic's getInternetRadioStations. See SCHEMA_V25 comments.
  { version: 25, sql: SCHEMA_V25 },
  // V26 creates podcast_feeds + podcast_episodes to back both the
  // Velvet podcasts page and Subsonic's getPodcasts /
  // getNewestPodcasts / downloadPodcastEpisode. See SCHEMA_V26.
  { version: 26, sql: SCHEMA_V26 },
];
