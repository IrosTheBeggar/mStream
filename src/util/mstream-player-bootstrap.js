/**
 * mstream-player-bootstrap.js
 *
 * Fetches the prebuilt mstream-player binary (the server-audio engine, née
 * rust-server-audio) on first use, with SHA256 verification against a
 * manifest COMMITTED to this repo. The player's source and releases live in
 * their own repo — IrosTheBeggar/mstream-terminal-player — whose CI attaches
 * the platform binaries to each versioned release; the in-tree crate this
 * replaces was a stale 0.1.0 fork of that living project.
 *
 * Same trust model as p2p-sidecar-bootstrap.js (this is the third copy of
 * the pattern — ffmpeg, p2p-sidecar, now this; the generic core is a
 * candidate for extraction into a shared util):
 *   - bin/mstream-player/manifest.json is committed text, reviewed like any
 *     other tree change, and pins {repo, tag} plus {file, sha256, size} per
 *     platform. Updating it when a new player release is published is a
 *     small text PR (scripts/update-mstream-player-manifest.mjs).
 *   - A download that does not hash to the manifest's pin is deleted and
 *     refused — no fallback, no retry-with-less-verification. The upstream
 *     darwin binaries arrive Developer-ID-signed; the pins cover the signed
 *     bytes, so verification happens on exactly what the release ships.
 *   - Binaries the OPERATOR placed (anything without our install receipt)
 *     are never overwritten or second-guessed; a dev cargo build of the
 *     player repo wins before this module is consulted (see
 *     src/api/server-playback.js resolvePlayerBinary()).
 *
 * There is no musl build of the player (server audio is opt-in and needs a
 * sound device — not an Alpine-container feature). On musl hosts the key
 * carries a -musl suffix, the manifest lookup finds nothing, and callers
 * degrade to the CLI players exactly as musl bundles always have.
 *
 * MSTREAM_PLAYER_BASE overrides the derived URL's BASE (sha256 pins still
 * apply) for air-gapped mirrors and the unit tests' loopback server.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import winston from 'winston';
import { appRoot, dataRoot } from './esm-helpers.js';
import { downloadToFile, computeFileChecksum } from './ffmpeg-bootstrap.js';
import { writeJsonAtomic } from './atomic-json.js';

const FAMILY = 'mstream-player';
// The one-shot --version probe must answer well inside this window — it
// prints and exits before any audio-device or network work, so a stall
// means a broken binary, not a busy host.
const PROBE_TIMEOUT_MS = 15000;

// ── Platform key ─────────────────────────────────────────────────────────────

// The manifest is keyed by the full binary filename, so there is zero mapping
// logic to drift between this module and the resolver in server-playback.js.
// The -musl suffix is deliberate even though no musl build exists: it makes
// the manifest lookup miss on musl hosts (instead of fetching a glibc binary
// that cannot run there) and keeps the key shape identical to the sidecar's.
export function playerKey(platform = process.platform, arch = process.arch) {
  const ext = platform === 'win32' ? '.exe' : '';
  const isMusl = platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
  const libcSuffix = isMusl ? '-musl' : '';
  return `${FAMILY}-${platform}-${arch}${libcSuffix}${ext}`;
}

// ── Paths ────────────────────────────────────────────────────────────────────

// Where the committed manifest lives — next to where the binaries land.
export function defaultManifestDir() {
  return path.join(appRoot, 'bin', FAMILY);
}

// Download target. dataRoot, not appRoot: a fetched binary needs a WRITABLE
// home (a translocated macOS .app or a system-prefix install is not). For a
// plain git checkout or npm install the two are the same directory, so the
// fetched binary lands exactly where the resolver already looks.
export function managedPlayerDir() {
  return path.join(dataRoot, 'bin', FAMILY);
}

export function managedPlayerPath() {
  return path.join(managedPlayerDir(), playerKey());
}

// ── Manifest ─────────────────────────────────────────────────────────────────

// One family, one publisher, one manifest — the player repo's single release
// workflow publishes every platform, so there is no musl-split file here
// (contrast bin/p2p-sidecar/, where two workflows must never share a file).
// A -musl key still reads manifest-musl.json so that IF a musl family ever
// appears it slots in without touching this module.
function manifestFileFor(key) {
  return key.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
}

function readManifest(manifestDir, key) {
  const file = path.join(manifestDir, manifestFileFor(key));
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`[${FAMILY}] could not read ${file}: ${err.message}`);
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    winston.warn(`[${FAMILY}] ${file} is not valid JSON (${err.message}) — treating as absent`);
    return null;
  }
}

// Everything that goes into a URL is validated as a plain token first: the
// manifest is committed and reviewed, but these checks keep a bad merge or
// hand-edit from ever turning into a surprising request target.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;

// The manifest entry for this platform — {repo, tag, file, sha256, size} —
// or null when none is published. Refuse malformed documents loudly rather
// than downloading something we can't verify.
export function manifestEntry({ manifestDir = defaultManifestDir(), key = playerKey() } = {}) {
  const manifest = readManifest(manifestDir, key);
  const entry = manifest?.assets?.[key];
  if (!entry) { return null; }
  if (!REPO_RE.test(manifest.repo || '') || !TOKEN_RE.test(manifest.tag || '')
      || typeof entry.file !== 'string' || !TOKEN_RE.test(entry.file)
      || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')
      || !Number.isInteger(entry.size) || entry.size <= 0) {
    winston.warn(`[${FAMILY}] manifest entry for ${key} is malformed — refusing to fetch from it`);
    return null;
  }
  return { repo: manifest.repo, tag: manifest.tag, file: entry.file, sha256: entry.sha256, size: entry.size };
}

// Can this platform's binary be fetched at all? Lets status surfaces report
// fetchability without triggering a download.
export function canAutoFetch(opts = {}) {
  return manifestEntry(opts) !== null;
}

// A player binary that is ALREADY on this machine — the bundled copy next to
// the server (build-bun stages it into every non-musl bundle) or a previously
// fetched managed one — or null. Never downloads: this feeds boot-time
// messaging, which must not cost a network round-trip or imply consent to one.
export function installedPlayerPath({ bundledDir = defaultManifestDir(), installDir = managedPlayerDir(), key = playerKey() } = {}) {
  for (const dir of [bundledDir, installDir]) {
    const candidate = path.join(dir, key);
    if (fs.existsSync(candidate)) { return candidate; }
  }
  return null;
}

// The linux player links libasound at LOAD time (it is an audio engine
// first), so on a headless box without ALSA even `--version` dies with a
// loader error — an invitation must not greet a fresh install with that.
// Non-linux platforms link only ever-present system audio (CoreAudio /
// WASAPI), so they are always loadable.
export function playerLoadableHere() {
  if (process.platform !== 'linux') { return true; }
  try {
    return execSync('ldconfig -p', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .includes('libasound.so.2');
  } catch (_err) {
    return false; // no ldconfig ⇒ can't prove ALSA ⇒ don't print a command that may die
  }
}

// The one place a download URL is built from the pins. Exported so the
// bundler and the unit tests share the exact shape — callers only ever hand
// it a manifestEntry() result, i.e. already-validated tokens.
export function deriveAssetUrl({ repo, tag, file }) {
  return `https://github.com/${repo}/releases/download/${tag}/${file}`;
}

// ── Install receipt ──────────────────────────────────────────────────────────

// Records the sha256 of every binary THIS module installed, keyed by
// filename. Its absence for an existing file is the provenance marker that
// the OPERATOR put it there — those are never refreshed or replaced.
const RECEIPT_FILE = '.fetched.json';

function readReceipt(installDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(installDir, RECEIPT_FILE), 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_err) {
    return {};
  }
}

async function writeReceipt(installDir, key, sha256) {
  const receipt = readReceipt(installDir);
  receipt[key] = sha256;
  await writeJsonAtomic(path.join(installDir, RECEIPT_FILE), receipt);
}

// ── Execution probe ──────────────────────────────────────────────────────────

// The staged binary must prove it executes BEFORE it replaces anything.
// `--version` is clap's built-in one-shot: print "mstream-player X.Y.Z" and
// exit — no audio device, no sockets, no config. That matters: the engine
// opens the audio device eagerly in serve mode, so a /status-style probe
// would fail on every headless host that most needs the fetch path. Catches
// wrong-arch downloads, truncation the size check missed, libc mismatches.
function probePlayer(binPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_err) {
      // Windows throws synchronously ("spawn UNKNOWN") for a corrupt image
      // instead of emitting the async 'error' event.
      return resolve(false);
    }
    let out = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      finish(false);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => finish(/^mstream-player \d+\.\d+\.\d+/.test(out.trim())));
    child.on('error', () => finish(false));
  });
}

// ── Ensure ───────────────────────────────────────────────────────────────────

// One in-flight ensure per install dir — a boot-path acquire and an admin
// redetect racing each other must share a single download, not fight over
// the staging file.
let _ensure = null;

/**
 * Make sure a usable player binary exists at the managed path.
 *
 *   - present + not installed by us (no receipt entry) → returned untouched
 *     (operator-supplied; theirs to manage).
 *   - present + ours + receipt matches the manifest pin → returned as-is.
 *   - present + ours + manifest moved on → the new build is downloaded,
 *     verified, probed, and swapped in (rename-aside dance so a locked or
 *     failing swap can roll back).
 *   - absent + manifest has an entry → downloaded, verified, probed,
 *     installed.
 *   - absent + no manifest entry for this platform (musl hosts today) →
 *     null; callers degrade to the CLI players.
 *
 * Throws on download/verification/probe failures — the caller
 * (server-playback.js bootRustPlayer()) degrades to the CLI fallback and
 * logs the cause.
 */
export function ensurePlayer(opts = {}) {
  const installDir = opts.installDir || managedPlayerDir();
  if (_ensure && _ensure.dir === installDir) { return _ensure.promise; }
  const promise = ensureInto({ ...opts, installDir }).finally(() => {
    if (_ensure && _ensure.promise === promise) { _ensure = null; }
  });
  _ensure = { dir: installDir, promise };
  return promise;
}

// `probe` is injectable for the unit tests (their loopback server hands out
// fixture bytes that no OS will execute); production always uses the real
// --version probe.
async function ensureInto({ manifestDir = defaultManifestDir(), installDir, key = playerKey(), probe = probePlayer }) {
  const dest = path.join(installDir, key);
  const entry = manifestEntry({ manifestDir, key });
  const exists = fs.existsSync(dest);

  if (!entry) {
    if (exists) { return dest; } // no manifest coverage, but a binary is here — use it
    winston.warn(
      `[${FAMILY}] no prebuilt player is published for this platform (${key}) — ` +
      `server audio uses the CLI players instead (bin/${FAMILY}/README.md has the manual options)`);
    return null;
  }

  if (exists) {
    const receipt = readReceipt(installDir);
    if (!(key in receipt)) { return dest; }           // operator-supplied: hands off
    if (receipt[key] === entry.sha256) { return dest; } // ours and current
    winston.info(`[${FAMILY}] a newer player build is pinned by the manifest — updating ${key}`);
  }

  await fsp.mkdir(installDir, { recursive: true });
  const staged = path.join(installDir, `.staging-${key}`);
  await fsp.rm(staged, { force: true }).catch(() => {});

  // The URL is DERIVED from the validated pins — the manifest never carries
  // a raw URL. MSTREAM_PLAYER_BASE swaps the base (mirror / test loopback);
  // the sha256 pin still gates what gets installed. Read lazily so tests and
  // mirrors don't depend on import order.
  const base = (process.env.MSTREAM_PLAYER_BASE || '').replace(/\/+$/, '');
  const url = base ? `${base}/${entry.file}` : deriveAssetUrl(entry);

  winston.info(`[${FAMILY}] downloading ${entry.file} (${(entry.size / 1024 / 1024).toFixed(1)} MB) from ${base || `${entry.repo}@${entry.tag} release assets`}...`);
  try {
    await downloadToFile(url, staged, { maxBytes: entry.size });

    const actual = await computeFileChecksum(staged);
    if (actual !== entry.sha256) {
      throw new Error(`checksum mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual} — refusing the download`);
    }
    await fsp.chmod(staged, 0o755).catch(() => {});

    const probed = await probe(staged);
    if (!probed) {
      throw new Error(`downloaded ${entry.file} verified but failed its --version execution probe — wrong platform build or unsupported host`);
    }

    // Swap in: rename the old aside first (Windows allows renaming a
    // still-locked exe but not overwriting it), then the staged one in, then
    // sweep the aside. Roll the old one back if the swap-in fails.
    const aside = `${dest}.old`;
    await fsp.rm(aside, { force: true }).catch(() => {});
    let hadExisting = true;
    try {
      await fsp.rename(dest, aside);
    } catch (err) {
      if (err.code !== 'ENOENT') { throw err; }
      hadExisting = false;
    }
    try {
      await fsp.rename(staged, dest);
    } catch (err) {
      if (hadExisting) { await fsp.rename(aside, dest).catch(() => {}); }
      throw err;
    }
    await fsp.rm(aside, { force: true }).catch(() => {});

    await writeReceipt(installDir, key, entry.sha256);
    winston.info(`[${FAMILY}] checksum verified — installed ${key}`);
    return dest;
  } catch (err) {
    await fsp.rm(staged, { force: true }).catch(() => {});
    winston.error(`[${FAMILY}] fetch failed: ${err.message}`);
    throw err;
  }
}

// Test hook: forget the in-flight ensure (mirrors p2p-sidecar-bootstrap.reset()).
export function reset() {
  _ensure = null;
}
