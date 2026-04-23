# DLNA — future improvements

A living list of known limitations and ideas for the DLNA / UPnP subsystem
(`src/api/dlna.js`, `src/dlna/*`). None of these block the release — they are
sorted roughly by impact and/or ease of implementation.

## Deferred / known gotchas

- **Bundled Rust scanner binary predates the JSON `scanComplete` event.** When
  the Rust scanner runs, `anyScansChanged` stays false and
  `dlnaApi.bumpSystemUpdateID()` never fires. Fix = CI rebuilds the rust-parser
  binaries from the current source. The JS fallback scanner emits the JSON
  event correctly.
- **Same-port DLNA + authenticated mStream is broken by design.** `/media/*`
  sits behind the auth wall in same-port mode but DLNA renderers can't pass a
  token. Only same-port + public (no-users) mode works. Admin UI already
  recommends separate-port; consider adding a warning banner if users exist
  AND mode is same-port.
- **`getLocalIp()` picks the first non-internal IPv4.** On multi-homed hosts
  (VPN, Docker bridge, WSL, multiple NICs) it may advertise the wrong IP.
  Consider making it configurable via `dlna.advertiseIp`. Per-interface
  multicast membership is already done.

## Protocol compliance

- **Add DLNA's `DMS-1.51` / `DMS-1.52` version declaration** (currently
  `DMS-1.50`). Gives access to newer DLNA conformance features.
- **Emit `<upnp:storageMedium>` / `<upnp:writeStatus>`** on containers (optional
  but helpful for strict renderers).
- **Send a re-announce with a higher `BOOTID.UPNP.ORG`** when the device
  description changes (e.g. library added/removed). Currently `BOOT_ID` is
  set once at module load.
- **Support `ContainerUpdateIDs` at per-container granularity**, not just
  the global `SystemUpdateID`. Lets smart clients invalidate only the
  changed container instead of re-browsing from the root.
- **NOTIFY retry over the full callback URL list.** UPnP says try URLs in
  order on failure; we fire at the first and forget.

## Missing containers / metadata

- **`upnp:composer` view.** Classical/jazz users want to browse by composer.
- **`upnp:rating` sort + display.** We already track per-user ratings in
  `user_metadata` — surface them on track items and as a sort key.
- **`X_SetBookmark` action** for resume-playback from any renderer.
  Especially useful for audiobooks. (Audio-book libraries already advertise
  `object.container.album.audioBook`, which is the prerequisite.)
- **Additional `<res>` variants per track** for transcoding fallback. Emit a
  second resource (MP3 at 192k) alongside the native one so picky renderers
  fall back instead of skipping exotic codecs.

## Smart containers

- **Recently Played / Most Played / Favorites aggregate across all users**
  since DLNA has no auth context. Consider a `dlna.defaultUser` setting that
  scopes smart-container queries to one user's history.
- **Smart-container query results lack caching.** Each Browse re-runs the
  aggregate join. Add a short-TTL (e.g. 30s) in-memory cache keyed on
  SystemUpdateID.
- **Per-container toggle.** Some users won't want Favorites (never used),
  others won't want Shuffle. Add `dlna.smartContainers` config array.
- **"By Decade"** derived from `years` — natural grouping for older libraries.
- **"Genres × Year" / "Artists × Year"** — useful pivots.

## Format / time-seek quality

- **Codec-copy for AAC / Opus.** MP3 and FLAC already use `-c:a copy`;
  AAC and Opus still transcode to MP3 because their container options
  (MP4 fragmentation for AAC, Ogg page boundaries for Opus) aren't worth
  untangling for the renderer support they'd unlock.
- **Configurable fallback bitrate** (currently hard-coded 192k MP3).
- **Rate-limit ffmpeg spawns** per client IP so a buggy renderer can't
  thrash the server.

## Admin UX

- **Show the live SSDP advertisement** (LOCATION URL, SERVER string, BOOTID)
  on the admin DLNA page. Helps diagnose discovery issues without a
  network-capture tool.
- **Show active GENA subscribers count** and recent SystemUpdateID.
- **Warning banner** when `dlna.mode = 'same-port'` and users are configured
  (media streaming will fail for DLNA clients).
- **"Test from this server" button** that simulates an M-SEARCH and shows the
  response — confirms the server is advertising correctly before the user
  debugs VLC / TV issues.
- **Per-library DLNA visibility toggle.** Users with multiple libraries may
  want to expose only a subset over DLNA.

## Security / robustness

- **Optional IP allow-list** for DLNA (`dlna.allowIp: ['192.168.1.0/24']`).
  Matches what some commercial servers offer.
- **Subscribers cap is global.** Consider per-IP cap so one client can't
  exhaust the pool alone.

## Test coverage gaps

- **No fixture that exercises compilation albums** (Various Artists where
  track-level and album-level artists diverge). The Album Artists view's
  main value prop is untested end-to-end.
- **No fixture for lossless audio** (FLAC, ALAC, WAV) — all current fixtures
  are MP3. Time-seek and protocolInfo branches for other MIME types are
  code-covered but not behaviourally exercised.
- **No test for large-library pagination.** The 10k `MAX_BROWSE_COUNT` cap
  has no test verifying clamping behaviour.
- **Time-seek test doesn't verify the actual offset.** It asserts the
  response is 200 with audio/mpeg bytes but doesn't decode the stream to
  confirm ffmpeg actually seeked. Could sanity-check response duration.
- **No test for the subscriber cap** (MAX_SUBSCRIBERS = 256). Verified
  manually during audit; should be automated.
- **No test for mode switching at runtime** (disabled → separate-port →
  same-port via admin API).
- **No cross-platform CI.** All integration tests currently assume Windows
  paths; verify on Linux/macOS CI (the bundled ffmpeg path differs by
  platform — covered in `fixtures.mjs` but untested).

## Code cleanup

- **Album-Artist BrowseMetadata uses inline XML** instead of a helper like
  `artistContainer`. Refactor into `albumArtistContainer(libId, artist,
  parent)` for consistency.
- **`dc:date` uses `YYYY-01-01`** — month/day invented. Some display UIs
  show "Jan 1" literally. Could emit bare `YYYY` if the client supports it
  (UPnP spec allows), or probe client via user-agent.
- **`SMART_TRACK_COLS` is duplicated as a template string.** Could be a
  helper function `smartTrackSelect(extraCols)`.

## Larger protocol work

- **OpenHome service support.** Linn's open alternative to UPnP with
  proper server-side playlist management and gapless playback. Bolt-on
  alongside existing DLNA; supported by BubbleUPnP, Kazoo, Linn.
- **`X_GetFeatureList` extensions** for LG-specific views and/or additional
  Samsung features (`samsung.com_AUDIOVIEW`, etc.).
