# Subsonic API — Phase 3 (shipped) + future work

> **⚠ Deprecated (2026-08):** the Subsonic API is deprecated and the surface
> is frozen — crash and security fixes only. The "future work" items below
> are historical record, not a roadmap. See
> [subsonic-deprecation.md](subsonic-deprecation.md).

> **Status:** Phase 3 landed. This document now doubles as a record of what
> shipped vs. what was intentionally deferred. Remaining items are in the
> "Deferred / out of scope" section at the bottom.

Phases 1 and 2 got mStream from zero to a Subsonic server that a real client
(DSub, play:Sub, Symfonium, Feishin, Supersonic, …) can connect to, browse,
stream, transcode on the fly, star, rate, scrobble, and manage playlists
against. That is the minimum viable Subsonic server.

Phase 3 closed the gap between "connects and works" and "feels complete" —
proper album/artist starring, user management, shares, bookmarks, device
play-queue sync, and a pile of discovery endpoints. Everything below that
isn't explicitly marked "deferred" is live in the tree.

Everything here targets Subsonic API 1.16.1 + the
[OpenSubsonic](https://opensubsonic.netlify.app/) superset.

---

## Observations from Phases 1 & 2 (design debts to settle early)

Before piling on new endpoints, Phase 3 should start by paying down two small
debts from earlier work. Both are cheap and make the rest of the phase easier:

1. **The album/artist star hack.** `star`/`unstar` currently take `albumId` /
   `artistId`, expand them to every child track, and flag `user_metadata.starred_at`
   on those tracks. That works well enough for a client that only asks for
   `starred2.song`, but it's wrong: unstarring a track also unstars the "album,"
   and `getStarred2.album` / `.artist` are hard-coded to empty arrays. Fix
   with two new tables (`user_album_stars`, `user_artist_stars`) — identical
   shape to `user_metadata`'s starred column, but keyed by album/artist id.
   Every downstream list endpoint (`getAlbumList2 type=starred`, etc.) already
   computes `starred_at` from the tracks table; switch those to the new tables
   in the same commit. Schema migration is trivial (two `CREATE TABLE`s, no
   data backfill needed).

2. **Declare OpenSubsonic support properly.** `sendOk` already emits
   `openSubsonic: true` on every response, but we never implemented
   `getOpenSubsonicExtensions`, so compliance checkers report us as a
   not-really-OpenSubsonic server. Add the endpoint and declare the actual
   extensions we support as we ship each Phase 3 slice. Zero schema work, just
   a manifest that grows commit by commit.

These two items are a half-day of work combined and should land first so the
rest of Phase 3 doesn't have to work around them.

---

## Tier 1 — high value, low-to-moderate effort

These are the endpoints that real Subsonic clients exercise on every session,
where "not implemented" results in visible breakage or missing features.

### 1.1 User-account endpoints

| Method           | Wraps mStream…                     | Notes |
|------------------|------------------------------------|-------|
| `getUser`        | `users` row lookup                 | Return the caller's user object (or admin-only for arbitrary `username`). Map mStream fields to Subsonic's (`adminRole`, `settingsRole`, `downloadRole`, `uploadRole`, `playlistRole`, `coverArtRole`, `commentRole`, `podcastRole`, `streamRole`, `jukeboxRole`, `shareRole`). |
| `getUsers`       | `/api/v1/admin/users` list          | Admin-only. One-line wrapper around the existing admin list. |
| `createUser`     | `/api/v1/admin/users` PUT           | Admin-only. Thin wrapper; delegate to the existing handler so password hashing, validation, and vpath checks stay in one place. |
| `updateUser`     | partial update on `users`           | Admin-only. |
| `deleteUser`     | `/api/v1/admin/users/:id` DELETE    | Admin-only. |
| `changePassword` | existing password-change path       | Self-service; admins can change anyone's. |

**Observation:** don't duplicate logic — call into `src/api/admin.js` /
`src/api/auth.js` from the Subsonic handlers. Phase 1/2 learned the hard way
that re-implementing validation in the Subsonic layer leaks bugs.

**Effort:** 1 day including tests.

### 1.2 Proper getStarred (v1) + album/artist starring

Once the star-debt fix above lands, add the v1 `getStarred` (flat) to
complement `getStarred2`. The payloads differ only in the shape of the artist
entries (flat artist rows vs. nested album/artist). Share the query; the only
difference is the key names in the emitted object.

**Effort:** half a day.

### 1.3 Similar & top songs (local-only)

| Method             | Local implementation |
|--------------------|----------------------|
| `getTopSongs`      | Order this artist's tracks by `COALESCE(um.play_count, 0) DESC, um.last_played DESC` within the user's libraries. |
| `getSimilarSongs`  | "Tracks by the same artist, then tracks on co-occurring albums (shared genre + year window)." No LastFM — we don't ship an external dep. |
| `getSimilarSongs2` | Same as above but scoped to `artistId`. |

**Observation:** DSub leans on `getSimilarSongs2` for its "Shuffle" feature.
Returning an empty array (what we'd do today via method-not-found) silently
breaks that UI. A mediocre local heuristic beats a missing endpoint.

**Effort:** 1 day including a small amount of tuning.

### 1.4 getNowPlaying

Subsonic clients display "who's listening to what" on the server. We already
track active streams for the transcoder-process map; hook into that to expose
per-user current track + seconds-elapsed.

**Observation from Phase 1:** `streamTranscoded` spawns an ffmpeg per request
but doesn't track a registry. Introduce `src/api/subsonic/now-playing.js` as a
small in-memory map `{ userId → { trackId, since } }`, populated from `stream`
and cleared on `req.on('close')`. This is also reusable for any future
"currently playing" admin-panel widget.

**Effort:** half a day.

### 1.5 Scan-status / startScan

Thin wrappers around the existing `/api/v1/db/status` and rescan endpoints.
Subsonic clients don't use these much, but Feishin's "scan library" button
expects them.

**Effort:** an hour.

### 1.6 Stream-handler polish

Three small upgrades to `stream`, informed by what actual clients send:

- **`estimateContentLength=true`** — emit a `Content-Length` derived from
  `(duration_seconds × bitrate / 8)` when transcoding. Required by some
  clients (Ultrasonic) for seek bars; currently absent because we stream from
  an unbounded pipe.
- **`timeOffset=N`** — seek the ffmpeg input with `-ss N`. Straightforward
  change; adds resume-from-position support.
- **HEAD requests** — several clients HEAD the stream URL to size the file
  before streaming. Right now we don't route HEAD, so it 404s. Wire
  `mstream.head('/rest/:method', handle)` and skip the ffmpeg spawn for HEAD
  on a transcoding path (return the estimate headers only).

**Effort:** half a day.

---

## Tier 2 — moderate value, moderate effort

Worth shipping but lower client impact than Tier 1.

### 2.1 Shares

Subsonic shares ↔ mStream's existing `shared_tracks` / shared-playlist
machinery. The Subsonic wrapper creates/deletes rows in those tables.

| Method        | Notes |
|---------------|-------|
| `getShares`   | List the caller's shares. Admin sees everyone's. |
| `createShare` | Takes `id` (repeatable) and optional `description`/`expires`. Creates one shared-playlist row per call. Return the server-visible share URL. |
| `updateShare` | Allow editing `description`/`expires`. |
| `deleteShare` | Trivial DELETE. |

**Observation:** mStream's share URLs currently point at the webapp
(`/shared/<token>`), which is not what Subsonic clients expect — they expect a
URL that a browser can open to stream the content. Either (a) add a
Subsonic-specific `/rest/shared/<token>` that renders a minimal player, or
(b) reuse the existing webapp URL and document the mismatch. Option (b) is
5 minutes of work; option (a) is a day.

**Effort:** half a day for (b), full day for (a).

**Shipped:** option (b). `createShare` now mints a proper JWT matching the
shape `/api/v1/share` produces, so the webapp share-viewer verifies
Subsonic-created shares (regression-tested — the initial Phase 3 cut stored
an empty token, which broke `jwt.verify`). Clients that expect an inline
stream URL will need to follow the webapp link in a browser.

### 2.2 Bookmarks

Position bookmarks for long-form content (audiobooks, DJ mixes). New table:

```sql
CREATE TABLE user_bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_hash TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  changed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, track_hash)
);
```

Endpoints: `getBookmarks`, `createBookmark`, `deleteBookmark`.

**Observation:** key by `track_hash` (not track id) so bookmarks survive
rescans that reshuffle rowids. This is the same pattern `user_metadata` uses.

**Effort:** half a day.

### 2.3 getPlayQueue / savePlayQueue

OpenSubsonic device-sync — a client saves its current queue on pause, another
device loads it to resume. New table:

```sql
CREATE TABLE user_play_queue (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_track_hash TEXT,
  position_ms INTEGER,
  changed_at TEXT DEFAULT (datetime('now')),
  changed_by TEXT,
  track_hashes_json TEXT NOT NULL -- JSON array of track_hashes in order
);
```

**Observation:** the existing `shared_playlists` table already stores a
playlist as a JSON array of entries — reuse that serialisation pattern. One
row per user (PK on user_id), no list table to manage.

**Effort:** half a day.

### 2.4 Artist/album info (stub, not LastFM)

`getArtistInfo`, `getArtistInfo2`, `getAlbumInfo`, `getAlbumInfo2` all return
a bio / similar-artist list / external URLs. We don't ship a LastFM
dependency and probably shouldn't — but clients treat "empty response" as
valid. Return:

- `biography`: empty string
- `musicBrainzId`: from `artists.mbz_artist_id` / `albums.mbz_album_id` if set
- `lastFmUrl`, `smallImageUrl`, `mediumImageUrl`, `largeImageUrl`: omit
- `similarArtist`: top 5 artists that share at least one genre with this one

**Effort:** a couple hours. Low payoff but removes a "method not found" from
every client session.

### 2.5 Avatar

`getAvatar` by username. We don't store avatars. Options:
- Return 404 always (current behaviour, honest).
- Generate a deterministic identicon (use `jimp`, which is already a dep).

The identicon path is nicer — a ~20-line `avatar.js` using jimp — and turns
client UI grey boxes into coloured ones. Purely cosmetic; very cheap.

**Effort:** 2 hours.

---

## Tier 3 — low value or misaligned with mStream

Include for completeness; recommend declining.

### 3.1 Internet radio

mStream has no radio-station concept. Endpoints `getInternetRadioStations`,
`createInternetRadioStation`, `updateInternetRadioStation`,
`deleteInternetRadioStation` would need a new `internet_radio_stations` table
from scratch plus admin UI for it. The feature is used by a small minority of
users and isn't core to what mStream does.

**Recommendation:** return `[]` from `getInternetRadioStations` (harmless,
silences client warnings), leave the admin endpoints unimplemented.

### 3.2 Podcasts

Similar story — mStream isn't a podcast manager. Full support would require a
podcast fetcher, episode schema, RSS parser, download scheduler. Large
feature, wrong product.

**Recommendation:** return `{ channels: [] }` from `getPodcasts`, reject
everything else with "not implemented." Document the boundary in the user
guide.

### 3.3 Jukebox

Requires a server-side audio output device. Doesn't fit mStream's "any device
is the player" model.

**Recommendation:** don't implement. Return error 30 ("trial period over" —
misuse, but it's what Airsonic-Advanced does to politely decline jukebox).

### 3.4 Chat

`getChatMessages`, `addChatMessage`. Essentially dead — no modern client
exposes it.

**Recommendation:** skip entirely.

### 3.5 Lyrics

`getLyrics`, `getLyricsBySongId` (OpenSubsonic). Lyrics are not currently
extracted by the scanner. Proper support requires:

1. Updating `src/scan/*` to read `USLT` (id3v2), `LYRICS` (Vorbis comment),
   `©lyr` (MP4), and `unsynced_lyrics` tags.
2. Adding a `lyrics` column to `tracks` (or a separate `track_lyrics` table
   if we want synced/unsynced variants).
3. A `rescanRequired: true` migration.

This is a full day of scanner work for a feature a minority of clients use.
Defer to a later phase if there's demand.

**Recommendation:** stub out `getLyricsBySongId` returning
`{ lyrics: { value: '' } }` so clients don't error. Mark as future work.

---

## Ordering

Recommend shipping Phase 3 in three commits rather than one:

- **Commit A — "Phase 3 foundations"**
  Star-table fix, OpenSubsonic extensions manifest, v1 `getStarred`,
  stream-handler polish (timeOffset + estimateContentLength + HEAD).
  The boring cleanup you want done before piling on endpoints.

- **Commit B — "Phase 3 user & discovery endpoints"**
  Tier 1.1 (user accounts), 1.3 (similar/top), 1.4 (now playing), 1.5 (scan),
  plus Tier 2.4 (info stubs) and 2.5 (avatar) because they're cheap and
  grouped with discovery work.

- **Commit C — "Phase 3 sync endpoints"**
  Tier 2.1 (shares), 2.2 (bookmarks), 2.3 (play queue). These all require
  schema migrations and are a natural trio.

Tier 3 should each land as their own "decline-with-stub" micro-commit if at
all, with a single line in the docstring explaining why we punt.

---

## Test plan

Follow the `subsonic.test.mjs` / `subsonic-modes.test.mjs` split:

- Extend `subsonic.test.mjs` with new `describe` blocks per endpoint group
  (user mgmt, similar/top, shares, bookmarks, play queue, info stubs, avatar).
- Every new endpoint gets: happy-path, bad-credentials, not-found, and
  permission-denied (where applicable) cases.
- For schema-adding endpoints (bookmarks, play queue, album/artist stars):
  add one test that exercises the migration path by inserting a row, querying
  it back, and validating the Subsonic envelope shape.
- Add OpenSubsonic extension declarations to `subsonic.test.mjs` alongside
  each feature they enable.

**Target coverage:** ~190 tests total after Phase 3 (currently 129). The
increase comes mostly from permission-matrix expansion on the admin endpoints.

---

## Deferred / out of scope for Phase 3

- **LastFM / ListenBrainz scrobble forwarding.** mStream's `scrobble` handler
  bumps local `play_count` only. Mirroring scrobbles to external services is
  a separate feature that should apply to the web UI and DLNA too, not be
  Subsonic-specific.
- **Multi-value artist/album artist.** Subsonic's `artists` array vs. string
  `artist` field is inconsistently supported by clients; waiting until
  mStream's own schema grows proper multi-artist support before exposing it.
- **Transcode-profile selection per user.** OpenSubsonic allows a client to
  ask "what formats will you transcode to" via `getOpenSubsonicExtensions`.
  We advertise the capability in Commit A, but per-user transcode policies
  belong to a later pass on the transcode subsystem as a whole.
- **Video.** mStream is audio-only. No endpoints to implement.
