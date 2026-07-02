import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import winston from 'winston';
import { appRoot } from '../util/esm-helpers.js';
import { getTransCodecs, getTransBitrates } from '../api/transcode.js';
import { CLIENT_TYPE, ENABLED_FOR } from '../torrent/constants.js';

const storageJoi = Joi.object({
  albumArtDirectory: Joi.string().default(path.join(appRoot, 'image-cache')),
  dbDirectory: Joi.string().default(path.join(appRoot, 'save/db')),
  logsDirectory: Joi.string().default(path.join(appRoot, 'save/logs')),
  syncConfigDirectory:  Joi.string().default(path.join(appRoot, 'save/sync')),
  waveformCacheDirectory: Joi.string().default(path.join(appRoot, 'waveform-cache')),
});

const scanOptions = Joi.object({
  skipImg: Joi.boolean().default(false),
  scanInterval: Joi.number().min(0).default(24),
  bootScanDelay: Joi.number().default(3),
  compressImage: Joi.boolean().default(true),
  // Tracks scanned per SQLite COMMIT — also gates how often the scanner
  // emits progress updates. Lower = more responsive UI + shorter
  // write-lock holds (concurrent API readers stall less); higher =
  // fewer commits, slightly more raw throughput. Soft-capped at 1000:
  // anything above that holds the write lock for ~10s+ at typical scan
  // rates and starves concurrent reads without buying meaningful speed.
  // We clamp + log rather than reject because a too-large value in the
  // config file would otherwise prevent server boot — better to nudge
  // the operator with a warning and keep running than to fail closed.
  scanCommitInterval: Joi.number().integer().min(1).default(25).custom((value) => {
    if (value > 1000) {
      winston.warn(`scanCommitInterval=${value} exceeds the 1000 cap; clamping to 1000. Higher values hold the SQLite write lock too long without measurable throughput gain.`);
      return 1000;
    }
    return value;
  }),
  // Number of worker threads the Rust scanner uses for parallel
  // file extraction. 0 (default) = auto: half the available CPU
  // cores, clamped to [1, 8]. The 8-thread cap protects against
  // monster-core boxes spinning up dozens of workers that mostly
  // idle on the single SQLite writer thread; explicit positive
  // values bypass the cap for operators who really want it to rip
  // (at the cost of higher peak memory — ~256 MB per worker for
  // large files). The Rust binary resolves the actual count; this
  // field just sets the policy. The JS fallback scanner
  // (src/db/scanner.mjs) ignores it — it stays single-threaded
  // because it's the slow-path for hosts without a Rust binary
  // anyway.
  scanThreads: Joi.number().integer().min(0).default(0),
  // Run the waveform enrichment pass after each scan. Waveform decode
  // no longer happens inside the scan itself — the scan finishes at
  // tag-parse speed and task-queue.js chains a separate read-only
  // `--waveform-scan` pass that generates the .bin for every track
  // missing one (see runWaveformTask). Default true keeps the end
  // state of the old behaviour (every track gets a cached waveform)
  // with a much faster time-to-browsable library. When false, the
  // pass never runs and the on-demand GET /api/v1/db/waveform
  // endpoint generates waveforms lazily via ffmpeg on first playback
  // (this is how .opus files have always worked, since symphonia 0.5
  // has no Opus decoder) — a few hundred ms of latency the first
  // time each track's waveform is requested.
  generateWaveforms: Joi.boolean().default(true),
  // Run the post-scan essentia BPM/key analysis pass (src/db/audio-analysis-
  // backfill.mjs): decode each tag-less track via ffmpeg and estimate tempo +
  // musical key, filling tracks.bpm / musical_key (bpm_source='essentia') for
  // the Auto-DJ continuity/harmonic-mixing waterfall. Default OFF — it pulls in
  // essentia.js (AGPL-3.0) and is CPU-heavy (a full decode + analysis per
  // track). Tag-sourced BPM/key (TBPM / TKEY etc.) is read during the scan
  // regardless of this flag and is never overwritten by the pass. The flag is
  // also still sent to the scanners so a stale prebuilt rust binary (pre-split)
  // honours its own no-op handling until CI rebuilds.
  analyzeBpm: Joi.boolean().default(false),
  // Tracks analysed per pass. Each holds the serial task slot while it decodes
  // + analyses (seconds per track), so the worker also caps wall-clock at its
  // runBudget and re-enqueues while a backlog remains — this just bounds one
  // batch. Mirrors autoAlbumArtPerRun.
  analyzeBpmPerRun: Joi.number().integer().min(1).max(10000).default(200),
  // Collect per-track music-discovery data (audio embeddings + external IDs
  // + filter metadata) into the SEPARATE discovery.db (src/db/discovery-db.js)
  // — deliberately isolated from mstream.db so the dataset stays a single
  // shareable/deletable file (see discovery-export.js). This flag currently
  // gates DB creation + the admin export surface; the post-scan embedding
  // worker that populates it lands next and reads this flag like analyzeBpm.
  // Default OFF: opt-in by design (a music library is identifying), and the
  // upcoming analysis pass is CPU-heavy.
  collectDiscoveryData: Joi.boolean().default(false),
  autoAlbumArt: Joi.boolean().default(true),
  // What the post-scan album-art downloader targets. 'missing' (default):
  // only albums with no cover at all — the fill-in-the-blanks pass.
  // 'all': every album; ones that already have a cover get the fetched
  // image ADDED to their gallery (album_art junction) without touching
  // the existing default — nothing is ever overwritten, and the V50
  // hash dedupe skips images the album already carries.
  autoAlbumArtMode: Joi.string().valid('missing', 'all').default('missing'),
  // When the downloader fetches a cover, also write it as cover.jpg into
  // each folder holding the album's tracks (existing covers and identical
  // content are never overwritten — hash-checked). Default false: this
  // writes into the user's library tree as a bulk automatic side effect,
  // distinct from the manual albumArtWriteToFolder below which only
  // fires on a user's deliberate set-art action.
  autoAlbumArtWriteToFolder: Joi.boolean().default(false),
  // Albums attempted per downloader run. Each run holds the serial task
  // slot for ~perRun seconds (one throttled service lookup per album), so
  // the cap bounds how long a queued scan/backup can wait; the task
  // re-enqueues itself while a backlog remains, yielding between batches.
  autoAlbumArtPerRun: Joi.number().integer().min(1).max(10000).default(100),
  albumArtWriteToFolder: Joi.boolean().default(false),
  albumArtWriteToFile: Joi.boolean().default(false),
  albumArtServices: Joi.array().items(
    Joi.string().valid('musicbrainz', 'itunes', 'deezer')
  ).default(['musicbrainz', 'itunes', 'deezer']),
  // Which source wins when a track has BOTH an embedded picture and a
  // folder image (cover.jpg etc.). 'metadata' (default) keeps the embedded
  // art — the long-standing behaviour; 'folder' lets the folder image win.
  // The other source is the fallback when the preferred one is absent.
  // Consumed by both scanners (rust-parser + src/db/scanner.mjs); flipping
  // it takes effect on the next scan of a file whose tags are re-read
  // (a force-rescan backfills existing TRACK rows; album-level covers are
  // fill-NULL-only — the scanner never overwrites an album's existing
  // cover, so album defaults keep their original election). config.json-
  // only for now — the admin UI toggle ships with the manual-art PR.
  albumArtPriority: Joi.string().valid('metadata', 'folder').default('metadata'),
});

const dbOptions = Joi.object({
  clearSharedInterval: Joi.number().integer().min(0).default(24),
  // SQLite synchronous mode for the main server connection. FULL (default)
  // fsyncs the WAL on every commit, so no user write (scrobble, rating,
  // playlist save) can be lost on a power cut. NORMAL skips the per-commit
  // fsync for faster writes and is still crash-safe under WAL (the DB never
  // corrupts), but a hard power loss can lose transactions committed since the
  // most recent WAL checkpoint. Runtime-changeable via the admin API/UI.
  synchronous: Joi.string().valid('FULL', 'NORMAL').default('FULL'),
  // SQLite page-cache size for the main server connection, in MEBIBYTES.
  // Applied as `PRAGMA cache_size = -(cacheSizeMb*1024)` — a negative cache_size
  // means "this many KiB of memory" rather than a page count. A larger cache
  // keeps more of the DB + its indexes resident, cutting disk reads under heavy
  // browse/search/stats load on big libraries, at the cost of that much process
  // RAM. 64 (MB) preserves the previously hard-coded value. Runtime-changeable
  // via the admin API/UI (per-connection PRAGMA, effective immediately). Capped
  // at 2048 MB as a fat-finger guard — a multi-GB page cache on a NAS box would
  // OOM long before it helped.
  cacheSizeMb: Joi.number().integer().min(1).max(2048).default(64)
});

// HTTP response compression for text-ish payloads (API JSON, HTML, JS, CSS,
// SVG/XML). `mode` selects the codec the server will use:
//   'none'   — compression disabled (default for now; opt in once validated).
//   'gzip'   — gzip only, even for clients that also advertise brotli (widest
//              compatibility, lowest CPU).
//   'brotli' — brotli for clients that advertise `br`, falling back to gzip for
//              clients that only do gzip (best ratio with broad reach).
// Audio/*, image/* (except SVG), video/* and range/seek (HTTP 206) responses
// are NEVER compressed regardless of mode, so playback + seeking are unaffected.
// The middleware reads this fresh on every request, so the admin API/UI can
// switch it live with no reboot.
const compressionOptions = Joi.object({
  mode: Joi.string().valid('none', 'gzip', 'brotli').default('none')
});

// Admin-surface access control. `mode` selects how the admin API + /admin
// page are reachable; the gate itself is an application-level req.ip check
// in src/util/admin-network.js, read live on every request (no reboot).
//   'all'       — reachable from anywhere (the historical lockAdmin=false).
//   'none'      — admin disabled entirely (the historical lockAdmin=true):
//                 405 on the admin API, /admin page disabled, public-mode
//                 write perms demoted. config.program.lockAdmin is DERIVED
//                 from this value in setup() so every existing reader of
//                 lockAdmin (auth.js, server.js, admin.js, federation.js)
//                 keeps working unchanged.
//   'localhost' — reachable only from loopback IPs (127.0.0.0/8 + ::1).
//   'whitelist' — reachable only from IPs/CIDRs in `whitelist`.
// `whitelist` accepts single IPs ('127.0.0.1') or CIDRs ('192.168.0.0/16');
// the default covers loopback + the RFC1918 private ranges (the common
// "LAN-only" intent). Only consulted when mode='whitelist'.
// Single adminAccess whitelist entry: a valid IP or CIDR, but a /0 range is
// rejected. '0.0.0.0/0' and '::/0' pass Joi's ip() check yet match every
// address, silently turning 'whitelist' mode into allow-all — an operator who
// genuinely wants that should set mode='all' explicitly. Exported so the admin
// API endpoint (src/api/admin.js) validates POSTed whitelists identically.
export const adminWhitelistEntry = Joi.string().ip({ cidr: 'optional' }).custom((value, helpers) => {
  const slash = value.indexOf('/');
  if (slash !== -1 && Number(value.slice(slash + 1)) === 0) {
    return helpers.message(`adminAccess whitelist entry '${value}' is a /0 (allow-all) range — use mode='all' instead`);
  }
  return value;
});

const adminAccessOptions = Joi.object({
  mode: Joi.string().valid('all', 'none', 'localhost', 'whitelist').default('all'),
  whitelist: Joi.array().items(adminWhitelistEntry).default([
    '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'
  ]),
});

const transcodeOptions = Joi.object({
  ffmpegDirectory: Joi.string().default(path.join(appRoot, 'bin/ffmpeg')),
  defaultCodec: Joi.string().valid(...getTransCodecs()).default('opus'),
  defaultBitrate: Joi.string().valid(...getTransBitrates()).default('96k'),
  // Auto-update the managed ffmpeg build (BtbN on Linux/Windows, martin-riedl
  // on macOS) on a weekly check. Default on so codec/security fixes land
  // without operator action. Set false to pin the current binary — useful when
  // a rolling upstream build regresses, or for air-gapped / reproducible
  // installs. No effect when running off system ffmpeg (managed by the OS).
  autoUpdate: Joi.boolean().default(true)
});

const rpnOptions = Joi.object({
  iniFile: Joi.string().default(path.join(appRoot, 'bin/rpn/frps.ini')),
  apiUrl: Joi.string().default('https://api.mstream.io'),
  email: Joi.string().allow('').optional(),
  password: Joi.string().allow('').optional(),
  token: Joi.string().optional(),
  url: Joi.string().optional()
});

const lastFMOptions = Joi.object({
  apiKey: Joi.string().default('25627de528b6603d6471cd331ac819e0'),
  apiSecret: Joi.string().default('a9df934fc504174d4cb68853d9feb143')
});

const discogsOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  allowArtUpdate: Joi.boolean().default(false),
  apiKey: Joi.string().allow('').default(''),
  apiSecret: Joi.string().allow('').default(''),
});

const federationOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  folder: Joi.string().optional(),
  federateUsersMode: Joi.boolean().default(false),
});

// Iroh P2P remote-access tunnel. When enabled, mStream binds an Iroh endpoint
// that proxies incoming QUIC connections to the local HTTP server, so a paired
// device can reach the server from anywhere by dialing its EndpointId — no
// port-forwarding/DDNS/reverse-proxy. Opt-in (default off).
//   secretKey     — base64 of 32 random bytes; the endpoint's identity. The
//                   EndpointId (and therefore every issued QR) is derived from
//                   it, so it's auto-generated once and persisted (like
//                   `secret`/`subsonicSecret`). Losing it changes the EndpointId
//                   and breaks every previously-issued QR/ticket.
//   connectSecret — base64 shared secret carried inside the QR. The tunnel only
//                   completes a connection after the client proves knowledge of
//                   it (constant-time handshake over the encrypted QUIC stream),
//                   so merely knowing the EndpointId is not enough to open the
//                   pipe. Rotatable from the admin panel (invalidates old QRs).
// Both are sensitive; they live in the config file in plaintext like the other
// secrets, and the admin surface that exposes the QR is admin-only.
const irohOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  secretKey: Joi.string().optional(),
  connectSecret: Joi.string().optional(),
  // Expose the pairing code on the NON-admin API (GET /api/v1/iroh/code) so the
  // web player can show it to ordinary users. The code carries the connect
  // secret, so this is OFF by default (the code stays admin-only); it's meant
  // for public/demo servers that WANT anyone to be able to test an Iroh
  // connection. Still sits behind the auth wall, so a private server with users
  // only exposes it to logged-in users.
  shareCodePublic: Joi.boolean().default(false),
});

// The music-discovery P2P layer (p2p-sidecar: iroh-blobs snapshot sharing
// now, the gossip catalog next phase). Distinct from `iroh` above — that's
// the remote-access tunnel with its own keypair; the sidecar keeps a
// separate identity at {dbDirectory}/discovery-p2p/identity.key so the two
// personas stay unlinkable. Default OFF: sharing a discovery snapshot
// publishes library metadata to whoever holds the ticket, so it's opt-in
// (and useless anyway until collectDiscoveryData has built a dataset).
const discoveryP2pOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  // Catalog-topic bootstrap: endpoint tickets (from a friend's status route —
  // dialable with zero external discovery) and/or bare endpoint ids (resolved
  // via n0 DNS). Empty = this server waits to BE bootstrapped (it still joins
  // the topic so peers holding OUR ticket can find the mesh through us).
  bootstrapPeers: Joi.array().items(Joi.string().min(16).max(4096)).default([]),
  // Display name carried in our signed catalog announcements. Pipe is
  // reserved as the announcement signing-string separator.
  serverName: Joi.string().max(64).pattern(/^[^|]*$/).default('mStream'),
});

const dlnaOptions = Joi.object({
  mode: Joi.string().valid('disabled', 'same-port', 'separate-port').default('disabled'),
  name: Joi.string().default('mStream Music'),
  uuid: Joi.string().optional(),
  port: Joi.number().integer().min(1).max(65535).default(3011),
  browse: Joi.string().valid('flat', 'dirs', 'artist', 'album', 'genre').default('dirs'),
  // The DLNA control surface is unauthenticated, but the smart containers
  // (Recently Played / Most Played / Favorites) and Playlists aggregate data
  // across ALL user accounts. Default true preserves the single-user/family
  // behaviour; set false on multi-user servers to hide those per-user surfaces
  // so anyone on the network can't read everyone's history, ratings, and lists.
  shareUserData: Joi.boolean().default(true),
});

const subsonicOptions = Joi.object({
  mode: Joi.string().valid('disabled', 'same-port', 'separate-port').default('disabled'),
  port: Joi.number().integer().min(1).max(65535).default(3012),
});

// Torrent client integration. v1 supports exactly two states for
// `client`:
//   'disabled'     — feature off; no UI surface, no routes, no DB writes.
//   'transmission' — talk to a Transmission daemon via RPC.
// Future clients (qBittorrent, Deluge, rTorrent) will extend the valid()
// list. `enabledFor` gates which users see the feature:
//   'all'       — every authenticated user can add torrents.
//   'whitelist' — only users with `users.allow_torrent = 1` can.
//
// `transmission` holds the saved RPC credentials for the Transmission
// backend. Empty `host` means "no credentials saved" (the admin UI
// shows the login form rather than the status card). Plaintext on
// purpose — matches the existing pattern for `lastFM`, `discogs`, and
// `rpn.password`; encrypting these would be inconsistent and would
// require a key-rotation story we don't have. Anyone who can read the
// config file can also read the .torrent files; threat-modelling the
// disk-at-rest case is the operator's job.
const transmissionCredsOptions = Joi.object({
  host:     Joi.string().allow('').default(''),
  port:     Joi.number().integer().min(1).max(65535).default(9091),
  username: Joi.string().allow('').default(''),
  password: Joi.string().allow('').default(''),
  rpcPath:  Joi.string().default('/transmission/rpc'),
  useHttps: Joi.boolean().default(false),
});

// qBittorrent WebAPI v2. The protocol mounts everywhere under
// /api/v2/<group>/<action>; the mount point itself isn't user-
// configurable in the same way Transmission's `rpcPath` is, so there
// is no `rpcPath` field here. Default port 8080 matches qBittorrent's
// out-of-box WebUI port.
//
// Both clients keep their credentials independently. Switching the
// `client` field between 'transmission' and 'qbittorrent' doesn't
// erase the other's saved creds — operators can toggle back and forth
// (e.g. during a migration) without re-entering passwords.
const qbittorrentCredsOptions = Joi.object({
  host:     Joi.string().allow('').default(''),
  port:     Joi.number().integer().min(1).max(65535).default(8080),
  username: Joi.string().allow('').default(''),
  password: Joi.string().allow('').default(''),
  useHttps: Joi.boolean().default(false),
});

// Deluge WebUI JSON-RPC. Unlike Transmission's Basic auth or
// qBittorrent's username+password, Deluge's WebUI auth is
// password-only (the daemon is single-user). Default port 8112 is
// Deluge's stock WebUI port.
const delugeCredsOptions = Joi.object({
  host:     Joi.string().allow('').default(''),
  port:     Joi.number().integer().min(1).max(65535).default(8112),
  password: Joi.string().allow('').default(''),
  useHttps: Joi.boolean().default(false),
});

const torrentOptions = Joi.object({
  // Pulled from CLIENT_TYPE / ENABLED_FOR — adding a new backend or
  // policy extends the validator automatically. Defaults stay
  // explicit (rather than CLIENT_TYPE.DISABLED) so the wire-format
  // expectations remain visible at the Joi-schema level.
  client:       Joi.string().valid(...Object.values(CLIENT_TYPE)).default(CLIENT_TYPE.DISABLED),
  enabledFor:   Joi.string().valid(...Object.values(ENABLED_FOR)).default(ENABLED_FOR.ALL),
  transmission: transmissionCredsOptions.default(transmissionCredsOptions.validate({}).value),
  qbittorrent:  qbittorrentCredsOptions.default(qbittorrentCredsOptions.validate({}).value),
  deluge:       delugeCredsOptions.default(delugeCredsOptions.validate({}).value),
});

// Lyrics config. Two historically-distinct paths share this block:
//
//   * Reactive LRCLib cache (DEPRECATED) — the original on-demand
//     fallback that fetched lyrics the first time a client asked for a
//     lyric-less track. Removed in favour of the proactive backfill
//     below; the `lrclib`, `concurrency`, and `fetchTimeoutMs` keys are
//     now INERT — kept only so existing config files still validate.
//   * Proactive backfill (active) — `backfill` + `providers`, a
//     post-scan pass that fills lyric-less tracks before anyone asks.
//
// The `lyrics_cache` table the reactive path created lives on as the
// backfill worker's cooldown/dedup ledger, so the `cacheTtl*Ms` keys
// are STILL live: they gate how long a cached row is treated as fresh
// by the read-only serving fallback (lyrics-cache.js#getCached).
//   cacheTtlHitsMs   — cached 'hit' freshness window (7 days default).
//   cacheTtlMissesMs — cached 'miss' freshness window (1 day default).
//   cacheTtlErrorsMs — cached 'error' freshness window (1 hour default).
const lyricsOptions = Joi.object({
  lrclib:           Joi.boolean().default(false),   // DEPRECATED/inert — reactive fetch removed; no auto-map to `backfill` (setup() warns instead)
  cacheTtlHitsMs:   Joi.number().integer().min(0).default(7 * 24 * 60 * 60 * 1000),
  cacheTtlMissesMs: Joi.number().integer().min(0).default(    24 * 60 * 60 * 1000),
  cacheTtlErrorsMs: Joi.number().integer().min(0).default(         60 * 60 * 1000),
  concurrency:      Joi.number().integer().min(1).max(16).default(2),   // DEPRECATED/inert
  fetchTimeoutMs:   Joi.number().integer().min(500).max(60000).default(8000),   // DEPRECATED/inert
  // When true, successful LRCLib fetches ALSO write a sibling
  // `<basename>.lrc` (or `.txt` for plain-only hits) next to the
  // audio file. Default off: the SQLite cache already serves lyrics
  // instantly, and operators running off read-only storage (cloud
  // shares, Docker volumes with ro mounts) can't write sidecars.
  //
  // Safety: never clobbers an existing `.lrc` / `.txt` sibling — user
  // curation always wins. Silently skipped if the audio file moved
  // or the parent dir isn't writable. A future scan picks up the
  // written sidecar and populates tracks.lyrics_synced_lrc naturally,
  // at which point the cache entry becomes redundant (still free to
  // serve either side).
  writeSidecar:     Joi.boolean().default(false),

  // ── Proactive backfill (separate from the reactive `lrclib` cache) ──
  // Master switch for the post-scan lyrics backfill pass that fills
  // lyric-less tracks before anyone asks. Off by default. `providers`
  // is the ordered list of sources to try (first usable hit wins):
  // LRCLib is the clean, no-auth default; NetEase and Kugou are
  // unofficial/reverse-engineered third-party APIs (better CJK/Asian
  // coverage) and are opt-in — leave them out unless you want them.
  backfill:  Joi.boolean().default(false),
  providers: Joi.array()
    .items(Joi.string().valid('lrclib', 'netease', 'kugou'))
    .min(1).default(['lrclib']),
  // Max tracks attempted per backfill pass before the worker yields the serial
  // task slot (the queue re-enqueues while it keeps hitting the cap). Mirrors
  // autoAlbumArtPerRun; read by runLyricsTask in task-queue.js. Without this
  // key the nested-object value was stripped by validation → locked at 100.
  backfillMaxPerRun: Joi.number().integer().min(1).max(10000).default(100),
});

const schema = Joi.object({
  address: Joi.string().ip({ cidr: 'forbidden' }).default('::'),
  port: Joi.number().default(3000),
  supportedAudioFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).default({
    "mp3": true, "flac": true, "wav": true,
    "ogg": true, "aac": true, "m4a": true, "m4b": true,
    "opus": true, "m3u": false
  }),
  lastFM: lastFMOptions.default(lastFMOptions.validate({}).value),
  discogs: discogsOptions.default(discogsOptions.validate({}).value),
  scanOptions: scanOptions.default(scanOptions.validate({}).value),
  noUpload: Joi.boolean().default(false),
  noMkdir: Joi.boolean().default(false),
  noFileModify: Joi.boolean().default(false),
  writeLogs: Joi.boolean().default(false),
  // Number of recent log lines kept in an in-memory ring buffer that
  // backs the admin panel's live-log viewer (GET /api/v1/admin/logs/recent).
  // Independent of `writeLogs`: the buffer is always populated so the live
  // view works even when on-disk logging is off. 0 disables it entirely.
  // Memory is bounded — each entry's text is capped at ~4 KB, so the
  // absolute worst case is roughly `logBufferSize × 4 KB` (≈2 MB at the
  // 500 default), though typical entries are ~200 B → ~100 KB. Capped at
  // 10000 so a fat-fingered config can't eat hundreds of MB.
  logBufferSize: Joi.number().integer().min(0).max(10000).default(500),
  // Legacy boolean kept in the schema so old config files still parse.
  // It is OVERWRITTEN by a value derived from adminAccess.mode in setup()
  // (lockAdmin = adminAccess.mode === 'none'); existing readers of
  // config.program.lockAdmin keep behaving correctly with no change.
  lockAdmin: Joi.boolean().default(false),
  adminAccess: adminAccessOptions.default(adminAccessOptions.validate({}).value),
  storage: storageJoi.default(storageJoi.validate({}).value),
  // 'default'  — mStream's classic UI (webapp/alpha/)
  // 'velvet'   — mStream's alternative UI (webapp/velvet/)
  // 'subsonic' — bundled Airsonic Refix (webapp/subsonic/), a third-party
  //              Subsonic web client pointed at our own /rest/* endpoints.
  //              Users log in with their mStream username + password;
  //              every HTTP call from the UI speaks Subsonic.
  ui: Joi.string().valid('default', 'velvet', 'subsonic').default('default'),
  webAppDirectory: Joi.string().default(path.join(appRoot, 'webapp')),
  rpn: rpnOptions.default(rpnOptions.validate({}).value),
  transcode: transcodeOptions.default(transcodeOptions.validate({}).value),
  lyrics: lyricsOptions.default(lyricsOptions.validate({}).value),
  secret: Joi.string().optional(),
  // Separate secret used to derive the AES-256-GCM key for the
  // Subsonic-specific password column added in V35. Kept distinct from
  // `secret` (which signs JWTs) so the two can rotate independently —
  // rotating the JWT secret invalidates active sessions; rotating the
  // Subsonic secret invalidates all stored Subsonic passwords (users
  // would have to re-set them via the mobile-clients panel).
  // Auto-generated on first boot like `secret`, persisted to the
  // config file.
  subsonicSecret: Joi.string().optional(),
  maxRequestSize: Joi.string().pattern(/[0-9]+(KB|MB)/i).default('1MB'),
  // Cap on the total uncompressed size of a bulk zip download
  // (/api/v1/download/*). The source files are summed before any bytes are
  // streamed, so an over-limit request gets a clean 413 instead of a
  // truncated archive. '0' (default) means unlimited — kept as the default
  // for now so an upgrade doesn't silently start blocking large downloads;
  // switching the default to a finite cap (e.g. 1GB) is planned for the next
  // major. Otherwise a size string: a whole or decimal number + KB|MB|GB
  // (1024-based, case-insensitive), e.g. '500MB', '1.5GB'. Read live per
  // request, so the admin API/UI can change it with no reboot. Does NOT apply
  // to single-file playback/streaming (/media, transcode) — only the zip
  // bundlers.
  downloadSizeLimit: Joi.string().pattern(/^(0|[0-9]+(\.[0-9]+)?(KB|MB|GB))$/i).default('0'),
  db: dbOptions.default(dbOptions.validate({}).value),
  compression: compressionOptions.default(compressionOptions.validate({}).value),
  folders: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      root: Joi.string().required(),
      type: Joi.string().valid('music', 'audio-books').default('music'),
    })
  ).default({}),
  users: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      password: Joi.string().required(),
      admin: Joi.boolean().default(false),
      salt: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()),
      allowMkdir: Joi.boolean().default(true),
      allowUpload: Joi.boolean().default(true),
      'lastfm-user': Joi.string().optional(),
      'lastfm-password': Joi.string().optional(),
    })
  ).default({}),
  ssl: Joi.object({
    key: Joi.string().allow('').optional(),
    cert: Joi.string().allow('').optional()
  }).optional(),
  federation: federationOptions.default(federationOptions.validate({}).value),
  iroh: irohOptions.default(irohOptions.validate({}).value),
  discoveryP2p: discoveryP2pOptions.default(discoveryP2pOptions.validate({}).value),
  dlna: dlnaOptions.default(dlnaOptions.validate({}).value),
  subsonic: subsonicOptions.default(subsonicOptions.validate({}).value),
  torrent: torrentOptions.default(torrentOptions.validate({}).value),
  autoBootServerAudio: Joi.boolean().default(false),
  rustPlayerPort: Joi.number().integer().min(1).max(65535).default(3333),
  // true  - trust X-Forwarded-For header for client IP address
  // false - default behavior
  trustProxy: Joi.boolean().default(false),
});

export let program;
export let configFile;

export function asyncRandom(numBytes) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(numBytes, (err, salt) => {
      if (err) { return reject('Failed to generate random bytes'); }
      resolve(salt.toString('base64'));
    });
  });
}

export async function setup(configFileArg) {
  // Create config if none exists
  try {
    await fs.access(configFileArg);
  } catch (_err) {
    winston.info('Config File does not exist. Attempting to create file');
    // The default config lives at appRoot/save/conf/default.json, and a freshly
    // extracted standalone bundle has no save/conf/ yet — writeFile won't create
    // parent dirs, so create them before the first write (else a bare/default
    // boot dies with ENOENT, misreported as "Failed to validate config file").
    await fs.mkdir(path.dirname(configFileArg), { recursive: true });
    await fs.writeFile(configFileArg, JSON.stringify({}), 'utf8');
  }

  const programData = JSON.parse(await fs.readFile(configFileArg, 'utf8'));
  configFile = configFileArg;

  // Verify paths are real
  for (const folder in programData.folders) {
    if (!(await fs.stat(programData.folders[folder].root)).isDirectory()) {
      throw new Error('Path does not exist: ' + programData.folders[folder].root);
    }
  }

  // Setup Secret for JWT
  if (!programData.secret) {
    winston.info('Config file does not have secret.  Generating a secret and saving');
    programData.secret = await asyncRandom(128);
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  // Setup the separate Subsonic-password secret. Kept independent of
  // `secret` so a JWT-secret rotation doesn't accidentally invalidate
  // every user's Subsonic password (HKDF derives the AES key from this
  // secret; rotating it makes existing ciphertexts unreadable).
  if (!programData.subsonicSecret) {
    winston.info('Config file does not have subsonicSecret.  Generating a secret and saving');
    programData.subsonicSecret = await asyncRandom(128);
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  // Iroh tunnel identity (secretKey -> stable EndpointId) and the pipe secret
  // (connectSecret). Generated once and persisted up-front — same generate-and-
  // persist precedent as secret/subsonicSecret/dlna.uuid — so the EndpointId and
  // any issued QR stay stable across reboots, and so enabling the feature later
  // from the admin panel doesn't need a key-generation round-trip. secretKey is
  // base64 of exactly 32 bytes (the size Iroh's SecretKey expects).
  if (!programData.iroh) { programData.iroh = {}; }
  if (!programData.iroh.secretKey || !programData.iroh.connectSecret) {
    winston.info('Config file missing iroh secrets. Generating and saving');
    if (!programData.iroh.secretKey) { programData.iroh.secretKey = await asyncRandom(32); }
    if (!programData.iroh.connectSecret) { programData.iroh.connectSecret = await asyncRandom(32); }
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  // Back-compat migration for the lockAdmin -> adminAccess rename. A config
  // file that predates adminAccess and had lockAdmin=true meant "admin
  // disabled", which is now adminAccess.mode='none'. Coerce + persist before
  // validation so the upgrade is sticky (matches the secret/subsonicSecret/
  // dlna.uuid generate-and-persist precedents in this function). A pre-existing
  // adminAccess always wins; a missing/false lockAdmin needs no migration
  // (adminAccess defaults to mode='all', which is the lockAdmin=false meaning).
  if (programData.adminAccess === undefined && programData.lockAdmin === true) {
    winston.info("Migrating legacy lockAdmin=true to adminAccess.mode='none' and saving");
    programData.adminAccess = { mode: 'none' };
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  // The reactive `lyrics.lrclib` switch was removed (replaced by the proactive
  // `lyrics.backfill` pass). An operator who had reactive lyrics ON (lrclib=true)
  // but never set the new `backfill` key would otherwise silently lose all lyrics
  // fetching on upgrade. We deliberately do NOT auto-enable backfill: it runs a
  // background pass that queries EXTERNAL providers, so turning it on is an
  // explicit opt-in (matches the feature's default-off design + the plan's
  // deferral of an auto-mapping). Instead, warn once — the notice stops as soon
  // as the operator sets `lyrics.backfill` either way. Read the RAW programData
  // (pre-Joi-defaults) so `undefined` reliably means "never set".
  if (programData.lyrics && programData.lyrics.lrclib === true
      && programData.lyrics.backfill === undefined) {
    winston.warn('[config] lyrics.lrclib no longer does anything — the reactive '
      + 'LRCLib fetch was removed. To keep fetching lyrics, set lyrics.backfill=true '
      + '(a post-scan pass that queries external providers); set lyrics.backfill=false '
      + 'to silence this notice.');
  }

  program = await schema.validateAsync(programData, { allowUnknown: true });

  // Derive the legacy lockAdmin flag from adminAccess.mode. Every existing
  // reader of config.program.lockAdmin (auth.js, server.js page guards,
  // admin.js guard, federation.js) keeps behaving correctly off this value;
  // only mode='none' fully disables the admin surface, the other three modes
  // are application-level IP gates layered on top via util/admin-network.js.
  program.lockAdmin = (program.adminAccess.mode === 'none');

  // The IP-based modes gate on req.ip. With trustProxy=true, req.ip is taken
  // from X-Forwarded-For, which a client can forge unless a TRUSTED reverse
  // proxy overwrites it. Warn the operator so a localhost/whitelist gate
  // isn't mistaken for airtight when it's actually trusting a spoofable header.
  if ((program.adminAccess.mode === 'localhost' || program.adminAccess.mode === 'whitelist') && program.trustProxy === true) {
    winston.warn(
      `[config] adminAccess.mode='${program.adminAccess.mode}' with trustProxy=true: the admin IP gate ` +
      `trusts X-Forwarded-For, which clients can spoof unless a trusted reverse proxy overwrites it. ` +
      `Ensure your proxy strips/sets X-Forwarded-For, or the gate can be bypassed.`
    );
  }

  // Enforce the `ui=subsonic` <-> Subsonic same-port constraint: the
  // bundled Airsonic Refix SPA is configured to talk to the SAME origin
  // it was served from (env.js SERVER_URL=""). If Subsonic is disabled
  // or on a separate port, the SPA loads fine but every /rest/* call
  // 404s and the user sees a "no server" splash with no indication why.
  // Auto-coerce to same-port + log a loud warning so the operator sees
  // what we did.
  if (program.ui === 'subsonic') {
    if (program.subsonic.mode !== 'same-port') {
      winston.warn(
        `[config] ui='subsonic' requires subsonic.mode='same-port' (had '${program.subsonic.mode}'); ` +
        `forcing same-port so the bundled Refix client can reach the /rest/* API it was built against. ` +
        `Set ui='default' or ui='velvet' if you need Subsonic disabled/separate-port.`
      );
      program.subsonic.mode = 'same-port';
    }
  }

  // Persist a stable DLNA UUID so renderers recognise the server across reboots
  if (!program.dlna.uuid) {
    program.dlna.uuid = crypto.randomUUID();
    const rawConfig = JSON.parse(await fs.readFile(configFileArg, 'utf8'));
    if (!rawConfig.dlna) { rawConfig.dlna = {}; }
    rawConfig.dlna.uuid = program.dlna.uuid;
    await fs.writeFile(configFileArg, JSON.stringify(rawConfig, null, 2), 'utf8');
  }

  // Ensure the writable storage directories exist before anything opens them.
  // Nothing else creates them, so a fresh run with
  // default (or freshly-pointed) paths would fail when SQLite tries to open
  // <dbDirectory>/mstream.db in a directory that doesn't exist (SQLITE_CANTOPEN),
  // or when the logger/caches first write. mkdir recursive is idempotent, so
  // this is a no-op when Electron (or a prior run) already created them.
  for (const dir of [
    program.storage.dbDirectory,
    program.storage.albumArtDirectory,
    program.storage.logsDirectory,
    program.storage.syncConfigDirectory,
    program.storage.waveformCacheDirectory,
    program.transcode.ffmpegDirectory,
  ]) {
    if (dir) { await fs.mkdir(dir, { recursive: true }); }
  }
}

export function getDefaults() {
  const { value } = schema.validate({});
  return value;
}

export async function testValidation(validateThis) {
  await schema.validateAsync(validateThis, { allowUnknown: true });
}

let isHttps = false;
export function getIsHttps() {
  return isHttps;
}

export function setIsHttps(isIt) {
  isHttps = isIt;
}
