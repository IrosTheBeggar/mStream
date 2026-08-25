/**
 * p2p-sidecar-bootstrap.js
 *
 * Fetches the prebuilt p2p-sidecar binary (the iroh networking companion for
 * the music-discovery network) on first use, with SHA256 verification
 * against a manifest COMMITTED to this repo. The sidecar's source and its
 * releases live in their own repo — IrosTheBeggar/mstream-p2p-sidecar —
 * whose CI attaches the nine platform binaries to each versioned release;
 * nothing binary lives in git on either side (each CI refresh of the old
 * in-tree set added ~172 MB of undeltifiable blobs to history forever; the
 * committed manifest is the few-hundred-byte replacement).
 *
 * Trust model (same shape as ffmpeg-bootstrap.js, but stricter — we pin exact
 * hashes, not a live upstream checksum file):
 *   - bin/p2p-sidecar/manifest.json (and manifest-musl.json) are committed
 *     text, reviewed like any other tree change, and pin {repo, tag} plus
 *     {file, sha256, size} per platform. Updating them when a new sidecar
 *     release is published is a small text PR
 *     (scripts/update-p2p-sidecar-manifest.mjs assembles it from the
 *     release's manifest-fragment assets).
 *   - Published release assets in the sidecar repo are immutable by policy
 *     (fixes ship as a new version), and the sha256 pins make a swapped
 *     asset fail closed regardless.
 *   - A download that does not hash to the manifest's pin is deleted and
 *     refused — no fallback, no retry-with-less-verification.
 *   - The pin is law for every binary this module manages, WHOEVER put it
 *     there: a file at the managed path that does not hash to the manifest
 *     pin is replaced with the pinned build (or, if that can't be fetched,
 *     refused with the cause). One pinned sidecar everywhere — a binary
 *     that drifts from the manifest means different installs run different
 *     network behaviour, and a stale one can quietly reintroduce a fixed
 *     bug (the v1.0.1 connection leak being the motivating scar). The ONE
 *     deliberate override left is the dev cargo build at
 *     p2p-sidecar/target/release/ — src/state/discovery-p2p.js prefers it
 *     before this module is consulted — which also covers self-built
 *     binaries for platforms the manifest doesn't pin.
 *
 * The download transport (https-or-loopback policy, redirect cap, socket
 * timeout) is shared with ffmpeg-bootstrap. MSTREAM_SIDECAR_BASE overrides
 * the derived URL's BASE (the sha256 pins still apply) for air-gapped
 * mirrors and the unit tests' loopback server — the MSTREAM_FFMPEG_MIRROR
 * precedent.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import { appRoot, dataRoot } from './esm-helpers.js';
import { downloadToFile, computeFileChecksum } from './ffmpeg-bootstrap.js';

// Re-exported for discovery-p2p.js's read-only-root pin check (a bundle's
// staged binary can't be replaced in place, so acquire verifies it here).
export { computeFileChecksum };
import { writeJsonAtomic } from './atomic-json.js';

const FAMILY = 'p2p-sidecar';
// The one-shot identity probe must answer well inside this window — it does
// no network I/O (see --print-id in the build workflows), so a stall means a
// broken binary, not a slow relay.
const PROBE_TIMEOUT_MS = 15000;

// ── Platform key ─────────────────────────────────────────────────────────────

// Mirrors src/state/discovery-p2p.js's resolveSidecarBinary() naming exactly:
// the manifest is keyed by the full binary filename, so there is zero mapping
// logic to drift between the two modules.
export function sidecarKey(platform = process.platform, arch = process.arch) {
  const ext = platform === 'win32' ? '.exe' : '';
  const isMusl = platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
  const libcSuffix = isMusl ? '-musl' : '';
  return `${FAMILY}-${platform}-${arch}${libcSuffix}${ext}`;
}

// ── Paths ────────────────────────────────────────────────────────────────────

// Where the committed manifests live — next to where the binaries used to be.
export function defaultManifestDir() {
  return path.join(appRoot, 'bin', FAMILY);
}

// Download target. dataRoot, not appRoot: like ffmpeg, a fetched binary needs
// a WRITABLE home (a translocated macOS .app or a system-prefix install is
// not). For a plain git checkout or npm install the two are the same
// directory, so the fetched binary lands exactly where the CI-committed one
// used to sit — and where resolveSidecarBinary() already looks.
export function managedSidecarDir() {
  return path.join(dataRoot, 'bin', FAMILY);
}

export function managedSidecarPath() {
  return path.join(managedSidecarDir(), sidecarKey());
}

// ── Manifest ─────────────────────────────────────────────────────────────────

// musl builds are published by their own workflow into their own manifest
// (mirroring the old .source-tree / .source-tree-musl stamp split) so the two
// publishers never write the same file.
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
// or null when none is published. A valid document pins the sidecar repo and
// release tag at the top level and file/size/sha256 per platform; refuse
// malformed ones loudly rather than downloading something we can't verify.
export function manifestEntry({ manifestDir = defaultManifestDir(), key = sidecarKey() } = {}) {
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

// Can this platform's binary be fetched at all? The admin enable route uses
// this to keep its fast 503 for genuinely unfetchable platforms while letting
// fetchable ones proceed to the download inside start().
export function canAutoFetch(opts = {}) {
  return manifestEntry(opts) !== null;
}

// The one place a download URL is built from the pins. Exported so the unit
// tests can assert the exact shape without touching the network — callers
// only ever hand it a manifestEntry() result, i.e. already-validated tokens.
export function deriveAssetUrl({ repo, tag, file }) {
  return `https://github.com/${repo}/releases/download/${tag}/${file}`;
}

// ── Install receipt ──────────────────────────────────────────────────────────

// Records the sha256 of every binary THIS module installed, keyed by
// filename. PROVENANCE ONLY since pin enforcement landed: whether a file is
// current is decided by hashing it against the manifest pin, never by who
// installed it (a receipt says who put a file there, not what the file is
// now). Kept because "did the fetcher or a human install this" is still a
// useful forensic fact — image bakes write it, hand-copies don't.
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

// The staged binary must prove it executes BEFORE it replaces anything —
// same bar as ffmpeg-bootstrap's version probe. --print-id is the sidecar's
// one-shot CI mode: create a throwaway identity, print the derived endpoint
// id (64 hex chars), exit. No sockets, no network (the build workflows lean
// on the same property). Catches wrong-arch downloads, truncation the size
// check missed, and libc mismatches.
function probeSidecar(binPath, probeDataDir) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath, ['--print-id', '--data-dir', probeDataDir], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_err) {
      // Windows throws synchronously ("spawn UNKNOWN") for a corrupt image
      // instead of emitting the async 'error' event. See ffmpeg-bootstrap's
      // getFfmpegVersion for the long-form scar.
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
    child.on('close', () => finish(/^[0-9a-f]{64}$/.test(out.trim())));
    child.on('error', () => finish(false));
  });
}

// ── Ensure ───────────────────────────────────────────────────────────────────

// One in-flight ensure per install dir — a boot-path start() and an admin
// enable racing each other must share a single download, not fight over the
// staging file (the ffmpeg-bootstrap _install lesson).
let _ensure = null;

/**
 * Make sure a usable sidecar binary exists at the managed path.
 *
 *   - present + hashes to the manifest pin → returned as-is, whoever
 *     installed it (the hash IS the check; receipts are provenance only).
 *   - present + does NOT hash to the pin — stale receipted install,
 *     operator-placed build, bit rot alike → the pinned build is
 *     downloaded, verified, probed, and swapped in (rename-aside dance so
 *     a locked or failing swap can roll back). If the fetch fails, this
 *     throws rather than running the drifted binary: one pinned sidecar
 *     everywhere. The dev cargo build is the deliberate escape hatch,
 *     preferred by discovery-p2p.js before this module is consulted.
 *   - absent + manifest has an entry → downloaded, verified, probed,
 *     installed.
 *   - present-or-absent + no manifest entry for this platform → whatever
 *     exists is returned untouched (nothing to enforce against), else null
 *     (callers degrade with their own actionable error).
 *
 * Throws on download/verification/probe failures — the caller (discovery-p2p
 * start(), which the admin route and boot both funnel through) surfaces the
 * cause verbatim.
 */
export function ensureSidecar(opts = {}) {
  const installDir = opts.installDir || managedSidecarDir();
  if (_ensure && _ensure.dir === installDir) { return _ensure.promise; }
  const promise = ensureInto({ ...opts, installDir }).finally(() => {
    if (_ensure && _ensure.promise === promise) { _ensure = null; }
  });
  _ensure = { dir: installDir, promise };
  return promise;
}

// `probe` is injectable for the unit tests (their loopback server hands out
// fixture bytes that no OS will execute); production always uses the real
// --print-id probe, and the Docker end-to-end exercises it with real
// binaries through the server's own spawn path.
async function ensureInto({ manifestDir = defaultManifestDir(), installDir, key = sidecarKey(), probe = probeSidecar }) {
  const dest = path.join(installDir, key);
  const entry = manifestEntry({ manifestDir, key });
  const exists = fs.existsSync(dest);

  if (!entry) {
    if (exists) { return dest; } // no manifest coverage, but a binary is here — use it
    winston.warn(
      `[${FAMILY}] no prebuilt binary is published for this platform (${key}) — ` +
      `the discovery network stays unavailable until one is (bin/${FAMILY}/README.md has the manual options)`);
    return null;
  }

  if (exists) {
    const actual = await computeFileChecksum(dest);
    if (actual === entry.sha256) { return dest; }     // matches the pin: current, whoever installed it
    winston.info(`[${FAMILY}] ${key} on disk (${actual.slice(0, 12)}…) does not match the manifest pin `
      + `(${entry.sha256.slice(0, 12)}…) — replacing it with the pinned build`);
  }

  await fsp.mkdir(installDir, { recursive: true });
  const staged = path.join(installDir, `.staging-${key}`);
  await fsp.rm(staged, { force: true }).catch(() => {});

  // The URL is DERIVED from the validated pins — the manifest never carries
  // a raw URL. MSTREAM_SIDECAR_BASE swaps the base (mirror / test loopback);
  // the sha256 pin still gates what gets installed. Read lazily so tests and
  // mirrors don't depend on import order.
  const base = (process.env.MSTREAM_SIDECAR_BASE || '').replace(/\/+$/, '');
  const url = base ? `${base}/${entry.file}` : deriveAssetUrl(entry);

  winston.info(`[${FAMILY}] downloading ${entry.file} (${(entry.size / 1024 / 1024).toFixed(1)} MB) from ${base || `${entry.repo}@${entry.tag} release assets`}...`);
  try {
    await downloadToFile(url, staged, { maxBytes: entry.size });

    const actual = await computeFileChecksum(staged);
    if (actual !== entry.sha256) {
      throw new Error(`checksum mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual} — refusing the download`);
    }
    await fsp.chmod(staged, 0o755).catch(() => {});

    const probeDir = path.join(installDir, `.probe-${process.pid}`);
    let probed;
    try {
      probed = await probe(staged, probeDir);
    } finally {
      await fsp.rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!probed) {
      throw new Error(`downloaded ${entry.file} verified but failed its --print-id execution probe — wrong platform build or unsupported host`);
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

// Test hook: forget the in-flight ensure (mirrors ffmpeg-bootstrap.reset()).
export function reset() {
  _ensure = null;
}
