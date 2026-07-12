# Changelog

## 6.5.0 — Unreleased

This is the largest feature release in mStream's history: a full Subsonic
REST API + bundled Airsonic Refix client, three-mode DLNA/UPnP support,
real lyrics with LRCLib fallback, multi-artist/compilation handling,
inline waveform generation, CLI audio backends for server-side playback,
and a complete move off LokiJS onto SQLite. 41 commits, ~20k lines
added, 410-test integration suite.

### ⚠️ Breaking changes

Operators upgrading from 6.4.x should read this section before the
server starts — several defaults changed and some admin endpoints were
removed.

- **Database backend replaced.** LokiJS + JSON config is gone. mStream
  now uses SQLite (`save/db/mstream.db`) in WAL mode. A one-shot
  migration at first boot (`src/db/migrate-from-loki.js`) copies users,
  libraries, playlists, user metadata, and shared playlists into the
  new schema; **track metadata is re-scanned** (the scanner is much
  faster in 6.5).
- **`allow_server_audio` defaults to `0` for all non-admin users.**
  V17 (introduced mid-cycle on the `dlna` branch) originally defaulted
  to `1`; V23 in this release revokes the flag for every non-admin user
  on upgrade so operators opt users in explicitly via the admin panel.
  Admins always bypass the gate and are unaffected.
- **`followSymlinks` is now per-library, default off.** The JS scanner
  used to silently follow symlinks inside libraries (`statSync`
  follows by default); the Rust scanner never did. Both now skip
  symlinks by default. Operators who relied on intra-library symlinks
  can re-enable the flag per library in the admin panel. The global
  `scanOptions.followSymlinks` config key has been removed.
- **Deleted admin endpoints (waveforms):**
  - `POST /api/v1/admin/db/params/generate-waveforms`
  - `POST /api/v1/admin/db/params/waveform-concurrency`
  - `POST /api/v1/admin/db/generate-waveforms`
  
  Waveforms are now generated inline by the Rust scanner (per track,
  on first scan) or lazily on first playback via the on-demand
  `GET /api/v1/db/waveform` endpoint. The post-scan bulk generator
  is gone.
- **`scanOptions.generateWaveforms` / `scanOptions.waveformConcurrency`
  config keys removed.** Retained silently by `allowUnknown: true` on
  the Joi schema; have no effect.
- **Velvet & default UI JWT payloads gain `allow_server_audio`.** Any
  client doing strict schema validation on the user object will see
  the new field. Additive; no client needs to be updated.
- **`Song.genre` / `Album.genre` / `<upnp:genre>` are now single-genre
  primaries (V34).** Pre-V34, multi-genre tracks surfaced the literal
  flat string the user tagged (e.g. `"Rock, Pop"`) on every response.
  Post-V34 — with the legacy `tracks.genre` flat column dropped in
  favour of the canonical `track_genres` M2M — these fields return
  only the first genre in the original tag string (e.g. `"Rock"`).
  The Subsonic / DLNA specs both define these as single-string
  fields, so any client doing its own comma-split was already
  fragile; clients that just rendered the string as-is now show the
  first listed genre.

  For clients that need the full multi-genre list, V34 also ships
  the **OpenSubsonic `genres[]` extension** on Subsonic `Song` and
  `Album` responses — see "New features" below.

### ✨ New features

- **Enrichment scan status API.** `GET /api/v1/scan/status`
  (authenticated, not admin-only) reports every post-scan enrichment
  pass — waveforms, album-art download, lyrics backfill, BPM/key
  analysis, discovery embeddings, AcoustID identification — in one
  poll: enabled/disabled (with the reason), live queue state and
  worker progress, a summary of the last run, and durable
  done / remaining / outcome coverage counts scoped to the caller's
  libraries. See `docs/openapi.yaml`. Surfaced in two UIs: an
  **Enrichment Status card** on the admin Database page (per-pass
  state badge, live progress, last-run summary, coverage bars with
  outcome breakdowns), and a quiet blue chip in the main UI's top bar
  while a pass is running.
- **Subsonic REST API.** Phase-1 through Phase-3 handlers covering
  browsing (getArtists / getArtist / getAlbum / getAlbumList2 /
  getStarred2 / getPlaylists / getPlaylist / search2 / search3),
  user/API-key auth (tokens + `apiKey` query param), stars on
  tracks / albums / artists, bookmarks, cross-device play queue
  (savePlayQueue / getPlayQueue), real jukebox control backed by
  rust-server-audio, and share create/update/delete. See
  `docs/openapi.yaml` for the full method table.
- **Bundled Airsonic Refix client** (`ui: 'subsonic'`). A third UI
  option alongside `default` and `velvet`. Auto-coerces
  `subsonic.mode` to `same-port` at boot so the SPA's built-in
  `/rest/*` endpoint resolution works.
- **DLNA / UPnP MediaServer (three modes).**
  `dlna.mode = disabled | same-port | separate-port`. Six layout
  views per library (folders / artists / album-artists / albums /
  genres / tracks), smart containers (recent / recently-played /
  most-played / favorites / shuffle / by-year), time-based seek,
  Samsung BASICVIEW compatibility, full GENA subscribe / renew /
  unsubscribe flow.
- **Real lyrics endpoints.** `GET /api/v1/lyrics` (Velvet-compatible
  shape) and the Subsonic `getLyrics` / `getLyricsBySongId` methods.
  Sources: embedded ID3v2 USLT + SYLT, Vorbis LYRICS, MP4 `©lyr`,
  APE Lyrics, sibling `.lrc` / `.txt` sidecars, multi-language
  `<name>.<lang>.lrc` sidecars.
- **LRCLib fallback (opt-in).** When `lyrics.lrclib: true`, cache
  misses trigger an async fetch from [lrclib.net](https://lrclib.net)
  keyed on `audio_hash`. Configurable TTLs for hits / misses /
  errors, concurrency cap, fetch timeout. Optional sidecar
  write-back so a successful fetch writes a sibling `.lrc` next to
  the audio file (never clobbers existing sidecars).
- **Multi-artist / compilation support.** V18 adds `album_artists` and
  `track_artists` M2M tables plus `albums.album_artist` display
  string and `albums.compilation` flag. "Various Artists" seeded
  with MusicBrainz's canonical UUID. `/api/v1/db/artists-albums`
  now returns every album an artist is credited on (primary,
  collab, or featured), not just those where they're the primary
  track artist.
- **Dual-hash identity (file_hash + audio_hash).** `audio_hash` (V14)
  hashes just the audio payload region, so tag rewrites and
  ReplayGain edits don't invalidate per-user state (stars, play
  counts, ratings, bookmarks, play queue). Populated by both
  scanners for mp3 / flac / wav / ogg / opus / aac / m4a / m4b.
  User tables fall back to `file_hash` via COALESCE for legacy
  rows. Byte-parity enforced by `test/audio-hash-parity.test.mjs`.
- **Inline waveform generation.** The Rust scanner writes
  `save/waveforms/<hash>.bin` (800-bar peaks) on first scan via
  symphonia. Atomic write (tmp + rename). On-demand endpoint
  `GET /api/v1/db/waveform` handles `.opus` and JS-fallback scans.
- **Server-side audio playback.** `/api/v1/server-playback/*` +
  `/server-remote` page, gated per user by the new
  `allow_server_audio` flag. Auto-detect and prefer MPD, falling
  back to MPV / VLC / MPlayer; `autoBootServerAudio` config flag
  opts into the native rust-server-audio binary.
- **Extended Subsonic / OpenSubsonic fields.** `sample_rate`,
  `channels`, `bit_depth` (V16) — clients that render "24/96
  FLAC" badges get them for free.
- **OpenSubsonic `genres[]` array on Song and Album responses
  (V34).** Co-exists with the legacy single-string `genre` field
  for back-compat. Each element is an `ItemGenre` object
  (`{ name: "Rock" }`); track-level ordering matches tag-string
  position (so `genres[0].name === genre`), album-level ordering
  is DISTINCT-by-first-seen across the album's tracks. Clients
  that read `genres[]` (Symfonium, play:Sub, Feishin, recent
  Subsonic Web UI builds) get the full multi-genre picture;
  clients that only read `genre` keep working unchanged.
- **Per-user API keys.** `user_api_keys` table (V9). mStream-native
  clients and Subsonic clients can authenticate with
  `apiKey=...` instead of username/password pairs.
- **Bundled DB migrations.** `PRAGMA user_version` gates V1 through
  V23, each wrapped in a single transaction. `rescanRequired`
  markers trigger a boot-time force-rescan for migrations that
  need new columns populated; the marker is kept on disk until
  all libraries finish so an interrupted rescan re-triggers on
  the next boot (rather than silently stranding the DB).
- **Integration test suite.** `node --test`-based, 410 tests
  covering DLNA (68 tests), Subsonic (several suites), lyrics,
  waveforms, hashes, admin endpoints, scanner parity, and the
  follow-symlinks flag. Uses bundled ffmpeg to generate fixtures
  on first run.
- **Auto-DJ with BPM continuity, harmonic mixing, and similar
  artists.** `POST /api/v1/db/random-songs` accepts new body
  fields:
    - `bpmRanges` / `bpmRangesWide` — `[{min, max}, ...]` BPM
      windows OR-ed in SQL. Clients send three (normal, half-tempo,
      double-tempo) for octave-equivalent continuity.
    - `musicalKeys` — Camelot codes (`1A`..`12B`). Server expands
      each to every spelling the DB might contain (`8A` matches
      `"A minor"`, `"Am"`, `"Amin"`, or raw `"8A"`).
    - `requireBpm` / `requireMusicalKey` — exclude rows with NULL
      tags.
    - `artists` / `ignoreArtists` — canonical library names (use
      with `GET /api/v1/lastfm/similar-artists`). V18-widened so a
      cooldown on "Foo" also drops "Foo feat. Bar" and tracks on
      Foo-credited compilations.

  Behind the route, a 5-or-10-step fallback waterfall progressively
  relaxes constraints until at least one track matches; a tier
  filter then prefers in-range picks over unknown-tag picks over
  known-wrong picks. Empty body still hits the pre-V32 simple-pick
  path so existing clients are unaffected.

  `GET /api/v1/lastfm/similar-artists` upgraded to intersect Last.fm
  results with the local library via fuzzy matching (case-folded,
  diacritic-stripped, `&`↔`and` swap, dots/slashes stripped).
  Returns canonical library names. 24h LRU cache per artist (500
  entries; 5min TTL on transient upstream failures).

  See `docs/openapi.yaml` for the full body schema and waterfall
  contract.
- **Scanner-time BPM + musical-key detection via stratum-dsp.** The
  Rust scanner now runs algorithmic analysis on every supported
  audio file during the existing symphonia decode pass, populating
  `tracks.bpm` / `tracks.musical_key` / `tracks.bpm_source =
  'stratum'` for files that don't already carry tag-sourced values.
  Unlocks the Auto-DJ harmonic / BPM-continuity filters above on
  libraries the user hasn't manually tagged.

  Skip gates: tag-sourced tracks are never overwritten (`bpm_source
  = 'tag'` wins); audiobook / spoken-word / podcast genres are
  filtered by keyword on the track's genre string; durations outside
  `[30s, ~30min]` are skipped (too-short = unreliable; too-long =
  audiobook territory). Per-track CPU cost ~200ms–1s on top of the
  decode; rayon parallelises across files. Memory bounded at ~52 MB
  of retained mono samples per active worker.

  New config flag: `scanOptions.analyzeBpm` (default `true`).
  Toggleable via `POST /api/v1/admin/db/params/analyze-bpm` and the
  admin panel's "Analyse BPM + key during scan" row. Rust-only
  feature — the JS fallback scanner accepts the flag but doesn't
  run analysis (stratum-dsp is a Rust crate). Backfill on existing
  libraries: trigger a force-rescan from the admin panel.

  Pure-Rust dependency, pinned `=1.0.0`, MIT/Apache. See
  `rust-parser/Cargo.toml` for the integration rationale.

### 🔧 Improvements

- **Rust scanner is the default.** Prebuilt binaries under
  `bin/rust-parser/` for every supported platform/arch; JS
  scanner remains as a fallback. Rust builds from source
  automatically if no prebuilt binary is found.
- **`follow_symlinks` per library.** Safer default (off) across
  both scanners, configurable per vpath in the admin UI.
- **Hash migration helper.** When a track's `audio_hash` or
  `file_hash` changes mid-rescan, `src/db/hash-migration.js`
  remaps `user_metadata`, `user_bookmarks`, and
  `user_play_queue` references so stars / ratings / bookmarks /
  queue position survive tag rewrites.
- **Album-stars migration helper.** `src/db/album-migration.js`
  remaps `user_album_stars` when V18's compilation-collapse
  step merges previously-fragmented album rows into one.
- **Shared playlist token expiration.** `shared_playlists.expires`
  + `description` columns (V15) used by Subsonic createShare /
  updateShare.
- **Persistent DLNA UUID.** Stored in config.json on first boot so
  renderers recognize the server across restarts.
- **Waveform cache relocated.** Now `save/waveforms/` so Docker
  users who only mount `save/` keep the cache across restarts.
- **busy_timeout=5000 on every SQLite connection.** Prevents
  "database is locked" errors when the scanner and HTTP
  handlers both try to write.

### 🐛 Bug fixes

- The main UI's top-bar scan progress cards now actually appear on
  locally-served sessions. The widget required a truthy
  `currentServer.host` before polling, but host is the empty string
  whenever the webapp is served by the same mStream instance it talks
  to (the normal setup) — so the cards only ever showed for
  configured-remote servers.
- Scanner no longer pre-DELETEs the old tracks row before
  re-parsing. `INSERT OR REPLACE` + CASCADE handles the swap
  atomically, so a parse failure (malformed tags, I/O error)
  no longer orphans `user_metadata` / stars / bookmarks keyed
  on the track's hash.
- `.rescan-pending` marker survives interrupted boot rescans.
  Previously the marker was unlinked at boot; a crash mid-rescan
  left the DB on pre-rescan row shapes with no way to notice.
- Subsonic `search2` response envelope name corrected.
- Subsonic `getInfo` cover endpoints return the right entity.
- **JS fallback scanner no longer crashes on multi-value genre
  tags.** `setTrackGenres` called `.split()` directly on whatever
  `music-metadata` returned for `common.genre`, but the library
  wraps every GENRE tag in an array (even single-value ones). The
  call threw `genreStr.split is not a function` on every file —
  the track row still inserted as a non-fatal warning but the
  `track_genres` M2M rows were silently dropped, leaving anyone on
  the JS scanner with a half-populated genre table. Fixed by
  normalising at the function boundary; both scanners now produce
  identical `track_genres` rows from the same input.
- LRCLib cache correctness + HTTP hardening from the round-2/3
  lyrics audits.
- Airsonic Refix SPA auth flow fixed for direct deep-links
  (client-side routing fallback now preserves token).
- Windows shebangs preserved via `.gitattributes` (pin `.sh`
  files to LF on checkout).

### 📊 Schema migrations

| Version | What | rescanRequired |
|---|---|---|
| V9 | `user_api_keys` table (Subsonic auth) | no |
| V10 | `user_metadata.starred_at` | no |
| V11 | `user_album_stars`, `user_artist_stars` | no |
| V12 | `user_bookmarks` | no |
| V13 | `user_play_queue` (cross-device play queue) | no |
| V14 | `tracks.audio_hash` dual-hash identity | **yes** |
| V15 | `playlists.public`, `shared_playlists.description` | no |
| V16 | `tracks.sample_rate / channels / bit_depth` | **yes** |
| V17 | `users.allow_server_audio` (default 0 as of V23) | no |
| V18 | `album_artists` / `track_artists` M2M + compilation | **yes** |
| V19 | Lyrics columns on `tracks` | **yes** |
| V20 | `lyrics_cache` (LRCLib fallback) | no |
| V21 | `libraries.follow_symlinks` per-library | no |
| V22 | Backfill NULL `follow_symlinks` rows | no |
| V23 | Revoke `allow_server_audio` for non-admin users | no |
| V32 | `tracks.bpm` / `musical_key` / `bpm_source` columns (Auto-DJ) | no |
| V33 | Indexes on `tracks.bpm` and `tracks.musical_key` (Auto-DJ waterfall hot path) | no |
| V34 | Drop legacy `tracks.genre` flat column — canonical store is the `track_genres + genres` M2M (since V2). Procedural migration with a drift precheck that aborts the column drop if the flat and M2M aren't already in sync. Forward-only — recovery via `rm save/db/mstream.db && restart` (track metadata is derived from on-disk tags) or restore-from-backup. | no |

Every migration runs inside a single transaction and is gated by
`PRAGMA user_version`, so partial-failure rollback and repeated
boot recovery are safe.

### 🙏 Upgrade checklist for operators

1. **Back up `save/`.** Specifically `save/db/mstream.db` if you've
   already booted on a 6.5 prerelease, or your `config.json` +
   loki `.db` files if you're coming from 6.4.
2. **First boot on 6.5 auto-migrates.** Loki → SQLite on first
   start; expect one force-rescan afterwards (V14, V16, V18, V19
   all need fresh track rows).
3. **Grant server-audio explicitly.** Every non-admin user loses
   `/api/v1/server-playback/*` access on upgrade. Re-grant per
   user in the admin panel if needed.
4. **Re-enable `followSymlinks` per library if you used it.** The
   old JS scanner silently followed symlinks; the new default is
   off. Flip the per-library toggle in Admin → Directories.
5. **Update admin tooling.** The three waveform endpoints listed
   under "Breaking changes" are gone; no replacement (waveforms
   now generate inline).
6. **Pick a UI.** `ui: 'default' | 'velvet' | 'subsonic'` in
   `config.json`. Default UI is unchanged; Velvet gets lyrics +
   extended metadata; Subsonic serves the bundled Airsonic
   Refix SPA against mStream's own `/rest/*` endpoints.
