/**
 * pinned-binary.js
 *
 * The shared core of fetch-on-first-use for a prebuilt companion binary whose
 * source and releases live in their own repo: verify against a manifest
 * COMMITTED to this one, prove the download executes, swap it in.
 * p2p-sidecar-bootstrap.js and mstream-player-bootstrap.js are this module
 * configured twice; they were 352-line near-copies of each other until the
 * extraction, and each keeps its own header for what is particular to it.
 * (ffmpeg-bootstrap.js is the older, different shape — it trusts a live
 * upstream checksum file, not committed pins — and only lends its download
 * transport and its file hasher here.)
 *
 * What every family gets:
 *   - bin/<family>/manifest.json (manifest-musl.json for a -musl key) is
 *     committed text, reviewed like any other tree change, and pins
 *     {repo, tag} plus {file, sha256, size} per platform key. The key IS the
 *     binary's filename, so there is no mapping to drift.
 *   - Everything that goes into a URL is validated as a plain token first,
 *     and the URL is DERIVED from the pins; the manifest never carries one.
 *     <baseEnv> swaps the URL's base for an air-gapped mirror or a test's
 *     loopback server. The pin still gates what gets installed.
 *   - A download is capped at the pinned size, must hash to the pinned
 *     sha256, and must pass a real execution probe BEFORE it replaces
 *     anything. A miss is deleted and refused: no fallback, no
 *     retry-with-less-verification.
 *   - The swap is a rename-aside dance, so a locked or failing swap rolls
 *     back, and every install is recorded in a receipt (.fetched.json).
 *   - One in-flight ensure per install dir, so a boot path and an admin
 *     action racing each other share a single download instead of fighting
 *     over the staging file.
 *
 * What a family must DECIDE is what to do about a binary that is already at
 * the managed path — the one place the two users deliberately differ, which
 * is why it is a named policy and not a callback:
 *
 *   'pin-is-law'     The file is current only if it HASHES to the pin, whoever
 *                    put it there. Anything else — a stale install, an
 *                    operator's build, bit rot — is replaced with the pinned
 *                    build, and if that cannot be fetched the ensure throws
 *                    rather than hand back the drifted file. For a binary
 *                    whose behaviour must be identical on every install (the
 *                    sidecar speaks a network protocol to other servers).
 *
 *   'receipt-gated'  A file WITHOUT our install receipt is the operator's and
 *                    is returned untouched, never hashed, never replaced. A
 *                    file we installed is current while its receipt still
 *                    equals the pin, and is refreshed when the manifest moves
 *                    on. For a binary an operator may legitimately build or
 *                    place themselves (the player).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import { appRoot, dataRoot } from './esm-helpers.js';
import { downloadToFile, computeFileChecksum } from './ffmpeg-bootstrap.js';
import { writeJsonAtomic } from './atomic-json.js';

// A one-shot probe must answer well inside this window. Both families' probes
// do no network and no device I/O, so a stall means a broken binary, not a
// busy host.
const PROBE_TIMEOUT_MS = 15000;

// Everything that goes into a URL is validated as a plain token first: the
// manifest is committed and reviewed, but these checks keep a bad merge or
// hand-edit from ever turning into a surprising request target.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;

// Records the sha256 of every binary this module installed, keyed by
// filename. What it MEANS is the on-disk policy's business: provenance only
// under 'pin-is-law', the operator-vs-ours marker under 'receipt-gated'.
const RECEIPT_FILE = '.fetched.json';

// The one place a download URL is built from the pins. Exported so the
// bundler and the unit tests share the exact shape — callers only ever hand
// it a manifestEntry() result, i.e. already-validated tokens.
export function deriveAssetUrl({ repo, tag, file }) {
  return `https://github.com/${repo}/releases/download/${tag}/${file}`;
}

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

// Is the binary already at `dest` the one to use? → { keep: true }, or
// { keep: false, why } when the pinned build must replace it. See the header
// for what each policy is for.
const ON_DISK_POLICIES = {
  'pin-is-law': async ({ dest, key, entry }) => {
    const actual = await computeFileChecksum(dest);
    if (actual === entry.sha256) { return { keep: true }; }  // matches the pin: current, whoever installed it
    return {
      keep: false,
      why: `${key} on disk (${actual.slice(0, 12)}…) does not match the manifest pin `
        + `(${entry.sha256.slice(0, 12)}…) — replacing it with the pinned build`,
    };
  },
  'receipt-gated': ({ key, entry, installDir, noun }) => {
    const receipt = readReceipt(installDir);
    if (!(key in receipt)) { return { keep: true }; }               // operator-supplied: hands off
    if (receipt[key] === entry.sha256) { return { keep: true }; }   // ours and current
    return { keep: false, why: `a newer ${noun} build is pinned by the manifest — updating ${key}` };
  },
};

// Spawn `binPath` with `args` and accept it only if stdout matches. The
// staged binary must prove it executes before it replaces anything; this
// catches wrong-arch downloads, truncation the size check missed, and libc
// mismatches.
function runProbe(binPath, args, accept) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
    child.on('close', () => finish(accept.test(out.trim())));
    child.on('error', () => finish(false));
  });
}

/**
 * Configure one binary family.
 *
 *   family            directory under bin/, platform-key prefix, log tag
 *   baseEnv           env var that swaps the download URL's base
 *   onDiskPolicy      'pin-is-law' | 'receipt-gated' (see the header)
 *   probe             { flag, args(scratchDir), accept, scratchDir }
 *                       flag        names the probe in the failure message
 *                       args        the command line; gets a scratch dir when
 *                                   scratchDir is true
 *                       accept      RegExp the probe's stdout must match
 *                       scratchDir  the probe writes somewhere: hand it a
 *                                   throwaway directory and sweep it after
 *   noun              what the log lines call the artifact
 *   unpublishedMeans  what no build for this platform means to the operator
 */
export function createPinnedBinary({ family, baseEnv, onDiskPolicy, probe: probeSpec, noun, unpublishedMeans }) {
  const isCurrent = ON_DISK_POLICIES[onDiskPolicy];
  if (!isCurrent) { throw new Error(`pinned-binary: unknown onDiskPolicy '${onDiskPolicy}' for ${family}`); }
  if (!family || !baseEnv || !noun || !unpublishedMeans
      || !probeSpec || typeof probeSpec.args !== 'function' || !(probeSpec.accept instanceof RegExp) || !probeSpec.flag) {
    throw new Error(`pinned-binary: incomplete configuration for ${family || 'an unnamed family'}`);
  }

  // ── Platform key ───────────────────────────────────────────────────────────

  // Keyed by the full binary filename. The -musl suffix is carried even by a
  // family that publishes no musl build: it makes the manifest lookup MISS on
  // a musl host instead of fetching a glibc binary that cannot run there.
  function key(platform = process.platform, arch = process.arch) {
    const ext = platform === 'win32' ? '.exe' : '';
    const isMusl = platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
    const libcSuffix = isMusl ? '-musl' : '';
    return `${family}-${platform}-${arch}${libcSuffix}${ext}`;
  }

  // ── Paths ──────────────────────────────────────────────────────────────────

  // Where the committed manifests live.
  function defaultManifestDir() {
    return path.join(appRoot, 'bin', family);
  }

  // Download target. dataRoot, not appRoot: a fetched binary needs a WRITABLE
  // home (a translocated macOS .app or a system-prefix install is not). For a
  // plain git checkout or npm install the two are the same directory.
  function managedDir() {
    return path.join(dataRoot, 'bin', family);
  }

  function managedPath() {
    return path.join(managedDir(), key());
  }

  // ── Manifest ───────────────────────────────────────────────────────────────

  // A -musl key reads its own file: where a family's musl builds come from a
  // separate workflow, the two publishers must never write the same manifest.
  function manifestFileFor(k) {
    return k.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
  }

  function readManifest(manifestDir, k) {
    const file = path.join(manifestDir, manifestFileFor(k));
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        winston.warn(`[${family}] could not read ${file}: ${err.message}`);
      }
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      winston.warn(`[${family}] ${file} is not valid JSON (${err.message}) — treating as absent`);
      return null;
    }
  }

  // The manifest entry for this platform — {repo, tag, file, sha256, size} —
  // or null when none is published. Refuse malformed documents loudly rather
  // than downloading something we can't verify.
  function manifestEntry({ manifestDir = defaultManifestDir(), key: k = key() } = {}) {
    const manifest = readManifest(manifestDir, k);
    const entry = manifest?.assets?.[k];
    if (!entry) { return null; }
    if (!REPO_RE.test(manifest.repo || '') || !TOKEN_RE.test(manifest.tag || '')
        || typeof entry.file !== 'string' || !TOKEN_RE.test(entry.file)
        || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')
        || !Number.isInteger(entry.size) || entry.size <= 0) {
      winston.warn(`[${family}] manifest entry for ${k} is malformed — refusing to fetch from it`);
      return null;
    }
    return { repo: manifest.repo, tag: manifest.tag, file: entry.file, sha256: entry.sha256, size: entry.size };
  }

  // Can this platform's binary be fetched at all? Lets status surfaces and
  // admin routes answer without triggering a download.
  function canAutoFetch(opts = {}) {
    return manifestEntry(opts) !== null;
  }

  // ── Ensure ─────────────────────────────────────────────────────────────────

  const realProbe = (binPath, scratchDir) => runProbe(binPath, probeSpec.args(scratchDir), probeSpec.accept);

  let inFlight = null;

  // Make sure a usable binary exists at the managed path; resolves with its
  // path, or null when no build is published for this platform and none is on
  // disk. Throws on download / verification / probe failures. What happens to
  // a binary that is already there is the family's onDiskPolicy.
  function ensure(opts = {}) {
    const installDir = opts.installDir || managedDir();
    if (inFlight && inFlight.dir === installDir) { return inFlight.promise; }
    const promise = ensureInto({ ...opts, installDir }).finally(() => {
      if (inFlight && inFlight.promise === promise) { inFlight = null; }
    });
    inFlight = { dir: installDir, promise };
    return promise;
  }

  // `probe` is injectable for the unit tests (their loopback server hands out
  // fixture bytes that no OS will execute); production always uses the real
  // execution probe.
  async function ensureInto({ manifestDir = defaultManifestDir(), installDir, key: k = key(), probe = realProbe }) {
    const dest = path.join(installDir, k);
    const entry = manifestEntry({ manifestDir, key: k });
    const exists = fs.existsSync(dest);

    if (!entry) {
      if (exists) { return dest; } // no manifest coverage, but a binary is here — use it
      winston.warn(
        `[${family}] no prebuilt ${noun} is published for this platform (${k}) — ` +
        `${unpublishedMeans} (bin/${family}/README.md has the manual options)`);
      return null;
    }

    if (exists) {
      const verdict = await isCurrent({ dest, key: k, entry, installDir, noun });
      if (verdict.keep) { return dest; }
      winston.info(`[${family}] ${verdict.why}`);
    }

    await fsp.mkdir(installDir, { recursive: true });
    const staged = path.join(installDir, `.staging-${k}`);
    await fsp.rm(staged, { force: true }).catch(() => {});

    // The URL is DERIVED from the validated pins — the manifest never carries
    // a raw URL. <baseEnv> swaps the base (mirror / test loopback); the sha256
    // pin still gates what gets installed. Read lazily so tests and mirrors
    // don't depend on import order.
    const base = (process.env[baseEnv] || '').replace(/\/+$/, '');
    const url = base ? `${base}/${entry.file}` : deriveAssetUrl(entry);

    winston.info(`[${family}] downloading ${entry.file} (${(entry.size / 1024 / 1024).toFixed(1)} MB) from ${base || `${entry.repo}@${entry.tag} release assets`}...`);
    try {
      await downloadToFile(url, staged, { maxBytes: entry.size });

      const actual = await computeFileChecksum(staged);
      if (actual !== entry.sha256) {
        throw new Error(`checksum mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual} — refusing the download`);
      }
      await fsp.chmod(staged, 0o755).catch(() => {});

      let probed;
      if (probeSpec.scratchDir) {
        const probeDir = path.join(installDir, `.probe-${process.pid}`);
        try {
          probed = await probe(staged, probeDir);
        } finally {
          await fsp.rm(probeDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        probed = await probe(staged);
      }
      if (!probed) {
        throw new Error(`downloaded ${entry.file} verified but failed its ${probeSpec.flag} execution probe — wrong platform build or unsupported host`);
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

      await writeReceipt(installDir, k, entry.sha256);
      winston.info(`[${family}] checksum verified — installed ${k}`);
      return dest;
    } catch (err) {
      await fsp.rm(staged, { force: true }).catch(() => {});
      winston.error(`[${family}] fetch failed: ${err.message}`);
      throw err;
    }
  }

  // Test hook: forget the in-flight ensure.
  function reset() {
    inFlight = null;
  }

  return { family, key, defaultManifestDir, managedDir, managedPath, manifestEntry, canAutoFetch, ensure, reset };
}
