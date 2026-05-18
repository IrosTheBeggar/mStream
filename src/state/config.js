import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import winston from 'winston';
import { getDirname } from '../util/esm-helpers.js';
import { getTransCodecs, getTransBitrates } from '../api/transcode.js';
import { CLIENT_TYPE, ENABLED_FOR } from '../torrent/constants.js';

const __dirname = getDirname(import.meta.url);

const storageJoi = Joi.object({
  albumArtDirectory: Joi.string().default(path.join(__dirname, '../../image-cache')),
  dbDirectory: Joi.string().default(path.join(__dirname, '../../save/db')),
  logsDirectory: Joi.string().default(path.join(__dirname, '../../save/logs')),
  syncConfigDirectory:  Joi.string().default(path.join(__dirname, '../../save/sync')),
  waveformCacheDirectory: Joi.string().default(path.join(__dirname, '../../waveform-cache')),
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
  // Generate waveform .bin files inline during scan. ~90% of scan
  // wall-time goes into the symphonia decode for these — disabling
  // it gives roughly a 10× scan speedup. Default true preserves the
  // current behaviour (scan-time waveforms = instant playback bar).
  // When false, task-queue.js sends an empty waveformCacheDir and
  // the Rust scanner skips the decode entirely; the on-demand GET
  // /api/v1/db/waveform endpoint still serves waveforms by
  // generating them via ffmpeg on first playback (this is how
  // .opus files have always worked, since symphonia 0.5 has no
  // Opus decoder). Trade-off: a few hundred ms of latency on the
  // first time each track's waveform is requested.
  generateWaveforms: Joi.boolean().default(true),
  autoAlbumArt: Joi.boolean().default(true),
  albumArtWriteToFolder: Joi.boolean().default(false),
  albumArtWriteToFile: Joi.boolean().default(false),
  albumArtServices: Joi.array().items(
    Joi.string().valid('musicbrainz', 'itunes', 'deezer')
  ).default(['musicbrainz', 'itunes', 'deezer']),
});

const dbOptions = Joi.object({
  clearSharedInterval: Joi.number().integer().min(0).default(24)
});

const transcodeOptions = Joi.object({
  ffmpegDirectory: Joi.string().default(path.join(__dirname, '../../bin/ffmpeg')),
  defaultCodec: Joi.string().valid(...getTransCodecs()).default('opus'),
  defaultBitrate: Joi.string().valid(...getTransBitrates()).default('96k')
});

const rpnOptions = Joi.object({
  iniFile: Joi.string().default(path.join(__dirname, `../../bin/rpn/frps.ini`)),
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

const dlnaOptions = Joi.object({
  mode: Joi.string().valid('disabled', 'same-port', 'separate-port').default('disabled'),
  name: Joi.string().default('mStream Music'),
  uuid: Joi.string().optional(),
  port: Joi.number().integer().min(1).max(65535).default(3011),
  browse: Joi.string().valid('flat', 'dirs', 'artist', 'album', 'genre').default('dirs'),
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

// External lyrics lookup via LRCLib (https://lrclib.net). Opt-in
// because it sends `{artist, title, duration}` for every cache-miss
// track over the public internet — operators who run mStream for
// privacy reasons want that off by default. When `lrclib=false` the
// cache table stays empty; handlers serve only embedded + sidecar
// lyrics (Phase 2 behaviour).
//
// TTLs are how long a cached row is considered fresh. After the TTL
// elapses, the next request re-enqueues a fetch (the stale row
// continues to be served in the meantime so we never regress from
// "had lyrics" to "empty" on a single network blip).
//   cacheTtlHitsMs   — successful fetches. 7 days: LRCLib corrections
//                      eventually propagate; long enough to be quiet.
//   cacheTtlMissesMs — "no lyrics found" responses. 1 day: new tracks
//                      get indexed on LRCLib over weeks, so a same-
//                      day re-check isn't useful.
//   cacheTtlErrorsMs — network/timeout/5xx. 1 hour: transient failures
//                      shouldn't burn a full day of no-retry.
//   concurrency      — in-flight fetches cap. LRCLib is generous but
//                      a fresh-scan burst shouldn't spam them.
const lyricsOptions = Joi.object({
  lrclib:           Joi.boolean().default(false),
  cacheTtlHitsMs:   Joi.number().integer().min(0).default(7 * 24 * 60 * 60 * 1000),
  cacheTtlMissesMs: Joi.number().integer().min(0).default(    24 * 60 * 60 * 1000),
  cacheTtlErrorsMs: Joi.number().integer().min(0).default(         60 * 60 * 1000),
  concurrency:      Joi.number().integer().min(1).max(16).default(2),
  // Per-call fetch timeout in ms. Read fresh on each fetch so admins
  // can tune without restarting. Raise if you're on a satellite
  // connection; lower if you want LRCLib failures to surface faster.
  fetchTimeoutMs:   Joi.number().integer().min(500).max(60000).default(8000),
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
  lockAdmin: Joi.boolean().default(false),
  storage: storageJoi.default(storageJoi.validate({}).value),
  // 'default'  — mStream's classic UI (webapp/alpha/)
  // 'velvet'   — mStream's alternative UI (webapp/velvet/)
  // 'subsonic' — bundled Airsonic Refix (webapp/subsonic/), a third-party
  //              Subsonic web client pointed at our own /rest/* endpoints.
  //              Users log in with their mStream username + password;
  //              every HTTP call from the UI speaks Subsonic.
  ui: Joi.string().valid('default', 'velvet', 'subsonic').default('default'),
  webAppDirectory: Joi.string().default(path.join(__dirname, '../../webapp')),
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
  db: dbOptions.default(dbOptions.validate({}).value),
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

  program = await schema.validateAsync(programData, { allowUnknown: true });

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
