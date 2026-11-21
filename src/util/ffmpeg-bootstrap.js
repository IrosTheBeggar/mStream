/**
 * ffmpeg-bootstrap.js
 *
 * Downloads static ffmpeg + ffprobe binaries on first use, verified against
 * the PINNED manifest committed at bin/ffmpeg/manifest.json — the same trust
 * model as p2p-sidecar-bootstrap: {tag/path, sha256, size} per platform is
 * reviewed text, a download that doesn't hash to its pin is deleted and
 * refused (no retry-with-less-verification), and updates ship as a
 * manifest-bump PR (scripts/update-ffmpeg-manifest.mjs) instead of whatever
 * the upstream's rolling "latest" serves that week.
 *
 * One deliberate exception — a PRUNED pin. BtbN deletes dated autobuild
 * releases (their util/prunetags.sh keeps the 14 newest plus each month's
 * final build for 24 months), so a pin can vanish from under an mStream
 * build that is still being installed fresh: the 2026-08-19 pin 404'd on
 * 2026-09-02 for every new Linux and Windows install. A pinned asset that
 * answers 404/410 therefore falls back to the same-platform stable-branch
 * build from BtbN's rolling `latest` release, verified against THAT
 * release's checksums.sha256 — an integrity check, not a reviewed pin, and
 * logged as such. The install receipt records it as a fallback, so the
 * update check re-converges onto a reviewed pin as soon as a manifest with
 * a live one ships (and does not churn while the dead tag is still pinned).
 *
 * Why pins and not upstream's own checksum file (the pre-2026-08 design):
 * a rolling build means every refresh hands Windows users a brand-new
 * UNSIGNED binary hash with zero SmartScreen / Smart App Control cloud
 * reputation, and means we ship whatever upstream published minutes ago. A
 * stable pinned hash accrues reputation and gets reviewed like any other
 * dependency bump. Binaries it installed itself are refreshed when the pins
 * change; operator-supplied binaries in a custom ffmpegDirectory are never
 * overwritten or deleted. A custom directory mStream cannot use — it holds
 * binaries it did not install and cannot run, or it cannot be written — is
 * left exactly as it is, and the default data directory takes the install
 * instead (see ensureFfmpeg).
 *
 * Pinned sources (see the manifest):
 *   Linux x64, Linux arm64, Windows x64 — BtbN/FFmpeg-Builds dated autobuild
 *   release assets; macOS x64 / arm64 — ffmpeg.martin-riedl.de versioned
 *   download paths.
 *
 * Platforms with no manifest entry: logs a warning — user must provide
 * binaries manually (musl skips straight to the system-PATH rung by design).
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import { appRoot, dataRoot } from './esm-helpers.js';
import { writeJsonAtomic } from './atomic-json.js';

const binaryExt = process.platform === 'win32' ? '.exe' : '';
// dataRoot, not appRoot: ffmpeg is never shipped in the bundle, so this is a
// download target and must be writable (a translocated macOS .app is not).
// Kept identical to config's transcode.ffmpegDirectory default — the two are
// compared to distinguish our managed install from a user's custom directory.
const BUNDLED_FFMPEG_DIR = path.join(dataRoot, 'bin/ffmpeg');
const MIN_FFMPEG_MAJOR = 6;
// MSTREAM_FFMPEG_MIRROR replaces the download BASE for both sources — an
// internal mirror on an air-gapped host, or the unit tests' loopback server.
// The mirror serves a FLAT namespace: the BtbN archive under its pinned file
// name, the macOS binaries as ffmpeg.zip / ffprobe.zip. The sha256 pins are
// enforced regardless of where the bytes came from, so a mirror can never
// substitute contents; it is only trusted over https or loopback http.
const MIRROR = (process.env.MSTREAM_FFMPEG_MIRROR || '').replace(/\/+$/, '');
// martin-riedl is a vendor constant, not a supply-chain pin — the manifest
// pins the versioned PATH (+ sha256) under this host.
const MR_HOST = 'https://ffmpeg.martin-riedl.de';
// Download hardening: cap redirect chains and apply a socket-inactivity
// timeout so a stalled or looping endpoint can't hang the process forever.
const MAX_REDIRECTS = 5;
const HTTP_TIMEOUT_MS = 30000;

let _initPromise = null;
// Bumped by reset(): a resolution chain started before a reset is stale — it
// may still finish (its download is shared, see _installs), but it must not
// publish its outcome or touch the chain that superseded it.
let _generation = 0;
// The in-flight installs, by target dir: resolved dir -> promise.
// Deliberately NOT cleared by reset(). Before this, a soft reboot mid-download
// (reset() -> the re-served transcode.init() -> ensureFfmpeg()) started a
// second download+extract into the SAME .staging dir while the first was still
// extracting — each rm'ing the other's files, both racing to swap binaries in,
// and the archive fetched twice per reboot (three times in one CI boot.log).
// checkForUpdate() shares it, so a weekly check can't overlap a boot install.
// A map, not one slot: a chain can ask about two dirs in a row (the configured
// one, then the default dir standing in for it — see ensureFfmpeg), and the
// answer for the first must not forget an install still running in the second.
const _installs = new Map();
let _updateTimer = null;
let _bootTimer = null;

// Set by ensureFfmpeg() once the resolver picks a working binary.
// Source is 'bundled' (we manage it — whether in the default dir or a custom
// ffmpegDirectory) or 'system' (resolved via PATH as a literal command name).
let _resolvedFfmpegPath = null;
let _resolvedFfprobePath = null;
let _resolvedSource = null;

// ── Path helpers ────────────────────────────────────────────────────────────

export function getFfmpegDir() {
  return config.program.transcode?.ffmpegDirectory || BUNDLED_FFMPEG_DIR;
}

// The directory the update check answers for: where the resolved binaries
// actually live — the default directory when it stood in for a configured one
// mStream could not use (see ensureFfmpeg) — else the configured directory.
function activeFfmpegDir() {
  return (_resolvedSource === 'bundled' && _resolvedFfmpegPath)
    ? path.dirname(_resolvedFfmpegPath)
    : getFfmpegDir();
}

// Returns the resolved binary path, or null if ensureFfmpeg() hasn't run
// successfully. Callers MUST check for null and degrade — spawning a
// synthesized default path here used to mask "ffmpeg never resolved" failures
// behind a cryptic ENOENT at call time.
export function ffmpegBin() {
  return _resolvedFfmpegPath;
}

export function ffprobeBin() {
  return _resolvedFfprobePath;
}

// ── Runtime detection helpers ───────────────────────────────────────────────

// Detect musl libc (Alpine, Void musl, etc.) via the canonical Node-builtin
// check: on glibc systems process.report.getReport().header.glibcVersionRuntime
// is a version string; on musl it's undefined. Stable since Node v11.8.
function isMuslLinux() {
  if (process.platform !== 'linux') { return false; }
  try {
    const report = process.report.getReport();
    return !report.header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

// Probe the system PATH for ffmpeg + ffprobe. Uses probeVersion(), which
// does spawn(name, ['-version']) — bare command
// names get resolved via PATH by Node's child_process. Returns the bare names
// so later spawns will keep resolving via PATH (system PATH is stable enough
// that caching a bare name is fine).
async function findSystemBinaries() {
  const [ff, fp] = await Promise.all([
    probeVersion('ffmpeg'),
    probeVersion('ffprobe'),
  ]);
  if (ff.major >= MIN_FFMPEG_MAJOR && fp.major >= MIN_FFMPEG_MAJOR) {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ffmpegVersion: ff.versionLine };
  }
  return null;
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}


// ── Pinned release manifest ─────────────────────────────────────────────────

// The committed pin set. Lives under appRoot (shipped with the code, like
// bin/p2p-sidecar/manifest.json), while downloads land in getFfmpegDir()
// (dataRoot-based) — same split as the sidecar: pins travel with the code
// they were reviewed with, binaries live somewhere writable. Standalone
// bundles ship it too — scripts/build-bun.mjs stages it at bin/ffmpeg/
// (a Resources-backed symlink on macOS); a bundle without it has no pins
// and boots with ffmpeg permanently unavailable.
const MANIFEST_DIR = path.join(appRoot, 'bin', 'ffmpeg');

// Everything that goes into a URL is validated as a plain token first: the
// manifest is committed and reviewed, but these checks keep a bad merge or
// hand-edit from ever turning into a surprising request target.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const isSha256 = (s) => /^[0-9a-f]{64}$/.test(s || '');
const isSize = (n) => Number.isInteger(n) && n > 0;
// martin-riedl paths are multi-segment: token-validate each segment so no
// traversal, absolute path, or scheme smuggling survives.
function isSafeRelPath(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\\')) { return false; }
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && TOKEN_RE.test(seg));
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function readManifest(manifestDir) {
  const file = path.join(manifestDir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') { winston.warn(`[ffmpeg-bootstrap] could not read ${file}: ${err.message}`); }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    winston.warn(`[ffmpeg-bootstrap] ${file} is not valid JSON (${err.message}) — treating as absent`);
    return null;
  }
}

/**
 * The validated pin set for a platform, with download URLs derived from the
 * pins (never stored in the manifest), or null when the platform has no
 * pinned build / the entry is malformed (malformed warns — refuse loudly
 * rather than download something unverifiable).
 *
 *   btbn:        { source, tag, file, url, sha256, size }
 *   martinriedl: { source, files: { ffmpeg|ffprobe: { path, url, sha256, size } } }
 *
 * Exported for the unit tests: a pure function of (manifestDir, key), no
 * network, no config.
 */
export function pinnedRelease({ manifestDir = MANIFEST_DIR, key = platformKey() } = {}) {
  const m = readManifest(manifestDir);
  const entry = m?.assets?.[key];
  if (!entry) { return null; }
  const refuse = (why) => {
    winston.warn(`[ffmpeg-bootstrap] manifest entry for ${key} is malformed (${why}) — refusing to fetch from it`);
    return null;
  };
  if (entry.source === 'btbn') {
    if (!REPO_RE.test(m.btbn?.repo || '') || !TOKEN_RE.test(m.btbn?.tag || '')) { return refuse('bad repo/tag'); }
    if (typeof entry.file !== 'string' || !TOKEN_RE.test(entry.file)) { return refuse('bad file'); }
    if (!isSha256(entry.sha256) || !isSize(entry.size)) { return refuse('bad sha256/size'); }
    const url = MIRROR
      ? `${MIRROR}/${entry.file}`
      : `https://github.com/${m.btbn.repo}/releases/download/${m.btbn.tag}/${entry.file}`;
    return { source: 'btbn', repo: m.btbn.repo, tag: m.btbn.tag, file: entry.file, url, sha256: entry.sha256, size: entry.size };
  }
  if (entry.source === 'martinriedl') {
    const files = {};
    for (const member of ['ffmpeg', 'ffprobe']) {
      const f = entry.files?.[member];
      if (!f || !isSafeRelPath(f.path) || !f.path.endsWith('.zip')) { return refuse(`bad ${member} path`); }
      if (!isSha256(f.sha256) || !isSize(f.size)) { return refuse(`bad ${member} sha256/size`); }
      // Mirror layout is flat (see MIRROR): the member name, not the
      // versioned upstream path.
      files[member] = { path: f.path, sha256: f.sha256, size: f.size, url: MIRROR ? `${MIRROR}/${member}.zip` : `${MR_HOST}/${f.path}` };
    }
    return { source: 'martinriedl', files };
  }
  return refuse(`unknown source '${entry.source}'`);
}

// The comparable pin identity recorded in the install receipt — refresh
// triggers when this differs from the current manifest's.
function pinsOf(release) {
  if (release.source === 'btbn') {
    return { source: 'btbn', tag: release.tag, file: release.file, sha256: release.sha256 };
  }
  return {
    source: 'martinriedl',
    files: {
      ffmpeg: { path: release.files.ffmpeg.path, sha256: release.files.ffmpeg.sha256 },
      ffprobe: { path: release.files.ffprobe.path, sha256: release.files.ffprobe.sha256 },
    },
  };
}

// ── Install receipt ──────────────────────────────────────────────────────────

// Records the pins THIS module installed from. Its absence for an existing
// install marks the binaries as the OPERATOR's (see checkForUpdate). The
// pre-manifest design wrote a `.checksum` baseline instead — still honored
// as a provenance marker, then replaced by a receipt on the first refresh.
const RECEIPT_FILE = '.fetched.json';
const LEGACY_CHECKSUM_FILE = '.checksum';

function readReceipt(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, RECEIPT_FILE), 'utf8'));
    return (parsed && typeof parsed === 'object' && parsed.pins) ? parsed : null;
  } catch (_err) {
    return null;
  }
}

// Whether the binaries in `dir` are mStream's to delete or replace. The
// default dir is always ours. Anywhere else, only an install marker (the
// receipt, or the pre-manifest `.checksum` baseline) says we put them there.
// Without one, a CUSTOM ffmpegDirectory holds the OPERATOR's binaries:
// possibly a custom or non-free build, possibly a distro's /usr/bin. mStream
// uses those as they are and never deletes or overwrites them, which is
// what docs/json_config.md and bin/ffmpeg/README.md promise. `defaultDir` is
// injectable alongside ensureFfmpeg()'s, for the unit tests.
async function isManagedDir(dir, defaultDir = BUNDLED_FFMPEG_DIR) {
  if (path.resolve(dir) === path.resolve(defaultDir)) { return true; }
  if (readReceipt(dir)) { return true; }
  try {
    return !!(await fsp.readFile(path.join(dir, LEGACY_CHECKSUM_FILE), 'utf8')).trim();
  } catch {
    return false;
  }
}

// `pins` defaults to the manifest's; a fallback install (see
// installLatestFallback) records its own identity instead.
async function writeReceipt(dir, release, pins = pinsOf(release)) {
  await writeJsonAtomic(path.join(dir, RECEIPT_FILE), {
    schema: 1,
    family: 'ffmpeg',
    pins,
    installedAt: new Date().toISOString(),
  });
}

// ── HTTP download with redirect following ───────────────────────────────────

// Only https may leave the machine — a redirect chain must never downgrade a
// binary download to cleartext. Plain http is accepted for loopback alone (a
// same-host mirror, the test harness), where nothing can sit in the path.
function isAcceptedUrl(u) {
  if (u.startsWith('https:')) { return true; }
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function clientFor(u) {
  return u.startsWith('https:') ? https : http;
}

// Resolves with the final (post-redirect) URL so callers can derive sibling
// resources — e.g. a `.sha256` that only exists at the resolved download path.
// Exported: p2p-sidecar-bootstrap.js reuses this exact transport (same
// https-or-loopback policy, same timeout hardening) for its release-asset
// downloads. `maxBytes` (optional) aborts a response that grows past the
// expected size — a manifest-pinned download knows its size up front, so
// anything larger is wrong bytes and not worth the disk or the wait.
export function downloadToFile(url, destPath, { maxBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > MAX_REDIRECTS) { return reject(new Error(`Too many redirects for ${url}`)); }
      if (!isAcceptedUrl(u)) { return reject(new Error(`Refusing non-HTTPS URL: ${u}`)); }
      const req = clientFor(u).get(u, { headers: { 'User-Agent': 'mstream-ffmpeg-bootstrap/2.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          const httpErr = new Error(`HTTP ${res.statusCode} downloading ${u}`);
          httpErr.statusCode = res.statusCode; // lets a caller tell "gone" (404/410) from "failed"
          return reject(httpErr);
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        const fail = e => { out.destroy(); fsp.unlink(tmp).catch(() => {}); reject(e); };
        res.on('error', fail);
        out.on('error', fail);
        if (maxBytes !== null) {
          let received = 0;
          res.on('data', c => {
            received += c.length;
            if (received > maxBytes) {
              const tooBig = new Error(`Response exceeds expected ${maxBytes} bytes for ${u}`);
              res.destroy(tooBig);
              fail(tooBig);
            }
          });
        }
        out.on('finish', async () => {
          try { await fsp.rename(tmp, destPath); resolve(u); }
          catch (e) { fsp.unlink(tmp).catch(() => {}); reject(e); }
        });
        res.pipe(out);
      });
      req.on('error', reject);
      // See downloadToBuffer: Bun's destroy(err) emits no 'error', so the
      // rejection has to be explicit or a stalled mirror hangs the ffmpeg
      // install — and the boot scan chained behind it — forever.
      req.setTimeout(HTTP_TIMEOUT_MS, () => {
        const timedOut = new Error(`Timeout downloading ${u}`);
        req.destroy(timedOut);
        reject(timedOut);
      });
    };
    follow(url);
  });
}

// ── Checksum verification ───────────────────────────────────────────────────

// Exported for the same reason as downloadToFile — one hashing helper for
// every managed-binary download path.
export function computeFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Extraction ──────────────────────────────────────────────────────────────

// tar hands a .tar.xz to the xz tool, which minimal images lack (Debian 11
// slim: "xz: Cannot exec"): name the fix instead of the symptom. Pure.
// "xz" has to stand alone as a program name: every tar complaint about the
// archive carries its ".tar.xz" name too ("…-gpl.tar.xz: Cannot open: No
// such file or directory" is a missing archive, not a missing tool).
const XZ_TOOL_MISSING = /(?:^|[\s'"`(:/])xz(?=[\s'"`:]|$)[^\n]*(?:Cannot exec|not found|No such file)/im;
export function tarFailureHint(stderr) {
  return XZ_TOOL_MISSING.test(String(stderr))
    ? ' — unpacking .tar.xz needs the xz tool (debian/ubuntu: apt install xz-utils; fedora/rhel: dnf install xz; alpine: apk add xz)'
    : '';
}

// BtbN archives unpack into a directory named after the asset (sans
// .tar.xz) — for the dated builds and the rolling `latest` ones alike
// (ffmpeg-n9.0-latest-linux64-gpl-9.0/bin/ffmpeg, checked 2026-09-04).
function extractTarXz(tarPath, destDir, asset) {
  const prefix = asset.replace(/\.tar\.xz$/, '');
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', [
      '-xJf', tarPath, '-C', destDir, '--strip-components=2',
      `${prefix}/bin/ffmpeg`, `${prefix}/bin/ffprobe`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.slice(-300)}${tarFailureHint(err)}`)));
    proc.on('error', reject);
  });
}

function extractZip(zipPath, destDir) {
  // Windows: use PowerShell to extract ffmpeg.exe + ffprobe.exe by name.
  return new Promise((resolve, reject) => {
    const script = `
      $zip = '${zipPath.replace(/'/g, "''")}';
      $dest = '${destDir.replace(/'/g, "''")}';
      Add-Type -Assembly System.IO.Compression.FileSystem;
      $archive = [IO.Compression.ZipFile]::OpenRead($zip);
      foreach ($entry in $archive.Entries) {
        if ($entry.Name -eq 'ffmpeg.exe' -or $entry.Name -eq 'ffprobe.exe') {
          $outPath = Join-Path $dest $entry.Name;
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $outPath, $true);
        }
      }
      $archive.Dispose();
    `;
    const proc = spawn('powershell', ['-NoProfile', '-Command', script],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`zip extract failed (${code}): ${err.slice(-300)}`)));
    proc.on('error', reject);
  });
}

// macOS: extract a single member from a .zip using Info-ZIP `unzip` (present
// on every macOS). -o overwrite without prompting, -j flatten stored paths.
function extractZipUnix(zipPath, destDir, member) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-o', '-j', zipPath, member, '-d', destDir],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip failed (${code}): ${err.slice(-300)}`)));
    proc.on('error', reject);
  });
}

// Download one file and verify it against its manifest pin: size cap during
// transfer (wrong bytes aren't worth the disk or the wait), exact size after,
// sha256 last. Deletes the file on any miss. Returns { ok: true }, or
// { ok: false, gone } where `gone` marks an asset the upstream no longer
// serves at all (HTTP 404/410 — a pruned release): the ONE failure
// installInto() may answer with the rolling fallback. Every other miss —
// network, size, digest — is a plain refusal; the pin stays the authority.
async function downloadPinned(url, destPath, pin, label) {
  try {
    await downloadToFile(url, destPath, { maxBytes: pin.size });
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] ${label} download failed: ${e.message}`);
    return { ok: false, gone: e.statusCode === 404 || e.statusCode === 410 };
  }
  const { size } = await fsp.stat(destPath).catch(() => ({ size: -1 }));
  if (size !== pin.size) {
    await fsp.unlink(destPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] ${label} is ${size} bytes, manifest pins ${pin.size} — refusing`);
    return { ok: false, gone: false };
  }
  const actual = await computeFileChecksum(destPath);
  if (actual !== pin.sha256) {
    await fsp.unlink(destPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] ${label} does not match its committed pin! Expected ${pin.sha256}, got ${actual} — refusing (a modified or substituted upstream asset fails closed; see bin/ffmpeg/manifest.json)`);
    return { ok: false, gone: false };
  }
  return { ok: true };
}

// macOS: download one binary's .zip into the staging dir, verify against its
// manifest pin, extract, and chmod. Returns false on any failure so the
// caller refuses to install an unverified binary, matching the BtbN
// hard-fail policy. The caller execution-verifies and swaps the staged pair
// into place.
async function installMacBinary(pin, stagingDir, member) {
  const zipPath = path.join(stagingDir, `${member}.zip`);
  // martin-riedl keeps its versioned download paths, so a miss here is a
  // plain failure — no rolling fallback on this source.
  if (!(await downloadPinned(pin.url, zipPath, pin, `${member} (macOS)`)).ok) { return false; }
  try {
    await extractZipUnix(zipPath, stagingDir, member);
  } catch (e) {
    await fsp.unlink(zipPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] ${member} extract failed: ${e.message}`);
    return false;
  }
  await fsp.chmod(path.join(stagingDir, member), 0o755).catch(() => {});
  await fsp.unlink(zipPath).catch(() => {});
  return true;
}

// ── Pruned-pin fallback (BtbN only) ─────────────────────────────────────────

// No pin records a rolling asset's size, so cap it instead: the win64 zip is
// ~170 MB, anything past this is wrong bytes. The checksum listing is ~5 KB.
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024;
const CHECKSUMS_MAX_BYTES = 64 * 1024;

// BtbN asset names. Pinned: ffmpeg-N-<rev>-g<sha>-<plat>-gpl.<ext>. In the
// rolling `latest` release: ffmpeg-n<maj>.<min>-latest-<plat>-gpl-<maj>.<min>.<ext>
// (a release branch, updated in place) and ffmpeg-master-latest-<plat>-gpl.<ext>
// (the master snapshot). The -shared / -lgpl flavors never match these.
const PINNED_BTBN_RE = /^ffmpeg-N-[0-9]+-g[0-9a-f]+-(linux64|linuxarm64|win64)-gpl\.(tar\.xz|zip)$/;
const LATEST_STABLE_RE = /^ffmpeg-n([0-9]+)\.([0-9]+)-latest-(linux64|linuxarm64|win64)-gpl-([0-9]+)\.([0-9]+)\.(tar\.xz|zip)$/;
const LATEST_MASTER_RE = /^ffmpeg-master-latest-(linux64|linuxarm64|win64)-gpl\.(tar\.xz|zip)$/;

/**
 * Choose the `latest`-release asset that stands in for a pruned pin: the same
 * platform and flavor (plain static -gpl, same archive type) as the pin, the
 * newest release-BRANCH build BtbN lists (ffmpeg-n9.0-latest-…) over the
 * master snapshot, which is taken only when no branch build is listed.
 * `checksumsText` is that release's checksums.sha256 — every line's name is
 * token-validated before it can become a URL, every digest must be hex.
 * Returns { name, sha256, branch } or null. Pure; exported for the tests.
 */
export function pickLatestFallback(checksumsText, pinnedFile) {
  const pinned = PINNED_BTBN_RE.exec(pinnedFile || '');
  if (!pinned) { return null; }
  const [, plat, ext] = pinned;
  let stable = null;
  let master = null;
  for (const line of String(checksumsText || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) { continue; }
    const digest = parts[0].toLowerCase();
    const name = parts[1];
    if (!isSha256(digest) || !TOKEN_RE.test(name)) { continue; }
    const s = LATEST_STABLE_RE.exec(name);
    if (s) {
      if (s[3] !== plat || s[6] !== ext || s[1] !== s[4] || s[2] !== s[5]) { continue; }
      const version = [Number(s[1]), Number(s[2])];
      if (!stable || version[0] > stable.version[0] || (version[0] === stable.version[0] && version[1] > stable.version[1])) {
        stable = { name, sha256: digest, branch: `n${s[1]}.${s[2]}`, version };
      }
      continue;
    }
    const m = LATEST_MASTER_RE.exec(name);
    if (m && m[1] === plat && m[2] === ext && !master) {
      master = { name, sha256: digest, branch: 'master' };
    }
  }
  const pick = stable || master;
  return pick ? { name: pick.name, sha256: pick.sha256, branch: pick.branch } : null;
}

// Download the fallback archive into the staging dir, verified against the
// `latest` release's own checksums.sha256. BtbN replaces those assets in
// place once a day, so a download that straddles the swap hashes to neither
// listing: the listing is re-read and the download retried once; a second
// miss is refused like any other. Returns { file, sha256, branch } or null.
async function installLatestFallback(release, staging) {
  const base = MIRROR ? `${MIRROR}/latest` : `https://github.com/${release.repo}/releases/download/latest`;
  winston.warn(
    `[ffmpeg-bootstrap] ${release.file} is gone from BtbN release ${release.tag}: BtbN prunes dated autobuilds, ` +
    'and this mStream build\'s pin has aged out. Falling back to the rolling stable-branch build from BtbN\'s ' +
    '"latest" release, verified against that release\'s checksums.sha256 (an integrity check, not a reviewed ' +
    'pin). Update mStream to get a reviewed pin again.');
  const sumsPath = path.join(staging, 'checksums.sha256');
  for (let attempt = 1; attempt <= 2; attempt++) {
    let sums;
    try {
      await downloadToFile(`${base}/checksums.sha256`, sumsPath, { maxBytes: CHECKSUMS_MAX_BYTES });
      sums = await fsp.readFile(sumsPath, 'utf8');
    } catch (e) {
      winston.error(`[ffmpeg-bootstrap] could not read BtbN's latest checksums.sha256: ${e.message}`);
      return null;
    }
    const pick = pickLatestFallback(sums, release.file);
    if (!pick) {
      winston.error(`[ffmpeg-bootstrap] BtbN's latest release lists no build matching ${release.file} — nothing to fall back to`);
      return null;
    }
    const dest = path.join(staging, pick.name);
    try {
      await downloadToFile(`${base}/${pick.name}`, dest, { maxBytes: FALLBACK_MAX_BYTES });
    } catch (e) {
      winston.error(`[ffmpeg-bootstrap] ${pick.name} download failed: ${e.message}`);
      return null;
    }
    const actual = await computeFileChecksum(dest);
    if (actual === pick.sha256) {
      winston.info(`[ffmpeg-bootstrap] Checksum verified against BtbN's latest release (${pick.branch} branch): ${pick.name}`);
      return { file: pick.name, sha256: pick.sha256, branch: pick.branch };
    }
    await fsp.unlink(dest).catch(() => {});
    if (attempt === 1) {
      winston.warn(`[ffmpeg-bootstrap] ${pick.name} does not match BtbN's checksums.sha256 — retrying once, the rolling asset may have been replaced mid-download`);
    } else {
      winston.error(`[ffmpeg-bootstrap] ${pick.name} does not match BtbN's checksums.sha256 again (expected ${pick.sha256}, got ${actual}) — refusing`);
    }
  }
  return null;
}

// ── Atomic install swap ─────────────────────────────────────────────────────

// Move verified staged binaries into place as a pair. The live binaries may
// be mid-use by a transcode or scan — Windows forbids deleting or overwriting
// a running exe but allows renaming it (the lock is on the data, not the
// name), and on Linux a rename avoids the ETXTBSY / partially-written-file
// window an extract-over-the-live-binary would have. Each old binary is
// renamed aside, the staged one renamed in, and the `.old` removed
// best-effort (a still-locked `.old` is swept on the next swap). If any step
// fails, everything swapped so far is rolled back so ffmpeg/ffprobe never end
// up as a mismatched pair.
async function swapInBinaries(pairs) {
  const swapped = [];
  try {
    for (const { staged, dest } of pairs) {
      const aside = `${dest}.old`;
      await fsp.rm(aside, { force: true }).catch(() => {});
      let hadExisting = true;
      try {
        await fsp.rename(dest, aside);
      } catch (e) {
        if (e.code !== 'ENOENT') { throw e; }
        hadExisting = false; // first install — nothing to move aside
      }
      try {
        await fsp.rename(staged, dest);
      } catch (e) {
        if (hadExisting) { await fsp.rename(aside, dest).catch(() => {}); }
        throw e;
      }
      swapped.push({ dest, aside, hadExisting });
    }
  } catch (e) {
    for (const { dest, aside, hadExisting } of swapped.reverse()) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      if (hadExisting) { await fsp.rename(aside, dest).catch(() => {}); }
    }
    throw e;
  }
  for (const { aside } of swapped) {
    await fsp.rm(aside, { force: true }).catch(() => {});
  }
}

// ── Version check ───────────────────────────────────────────────────────────

// Bound the probe: a wedged binary (bad PATH entry, stalled network mount)
// would otherwise block the whole resolution chain forever — transcode's
// init() awaits ensureFfmpeg(), and its bounded retry is only scheduled
// after that returns.
//
// A probe that runs out of time has said NOTHING about the binary. A healthy
// build on a loaded box or a slow disk, or under a first-exec antivirus scan,
// can take longer than this and still answer correctly. So a timeout is
// reported as such (timedOut), retried once with a longer budget
// (probeVersion), and never read as "broken". That verdict deletes binaries
// (ensureFfmpeg step 1), and a slow probe used to delete a working install
// that way. The env knob exists for the unit tests, which fake a slow binary
// without sleeping through the real budgets.
const VERSION_PROBE_TIMEOUT_MS = Math.max(100, Number(process.env.MSTREAM_TEST_FFMPEG_PROBE_TIMEOUT_MS) || 10000);
const VERSION_PROBE_RETRY_TIMEOUT_MS = VERSION_PROBE_TIMEOUT_MS * 6;

// `error` (when the binary could not be run at all) is why — EACCES for a
// noexec mount or a missing exec bit, ENOENT — so a failed install
// verification can say more than "(no output)".
function getFfmpegVersion(binPath, timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let p;
    try {
      p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      // Windows throws SYNCHRONOUSLY ("spawn UNKNOWN") when the file is not a
      // valid executable image (e.g. a corrupt/truncated binary), instead of
      // emitting the async 'error' event other spawn failures use. Without
      // this guard the executor throw rejects the promise — violating the
      // "always resolves" contract — and a corrupt binary on disk would crash
      // resolution instead of triggering the unlink-and-refresh path.
      return resolve({ major: 0, versionLine: '', error: e.code || e.message });
    }
    let o = '';
    let timer = null;
    let settled = false;
    const finish = result => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      p.kill('SIGKILL');
      finish({ major: 0, versionLine: '', timedOut: true });
    }, timeoutMs);
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => {
      const line = o.split('\n')[0] || '';
      // Git/snapshot builds (BtbN, martin-riedl snapshot) print "version N-<n>"
      // with no semantic major — treat as newest. Checked first so the stable
      // matcher below doesn't trip on the leading N.
      if (/version\s+N-\d+/i.test(line)) { return finish({ major: 99, versionLine: line }); }
      // Stable/distro builds: "version 6.1.1", "version n7.0" (Arch),
      // "version 5.1.4-0+deb…" (Debian). Allow an optional 'n' prefix, match
      // case-insensitively, and don't require the program-name token.
      const m = line.match(/version\s+n?(\d+)/i);
      if (m) { return finish({ major: parseInt(m[1], 10), versionLine: line }); }
      finish({ major: 0, versionLine: line });
    });
    p.on('error', e => finish({ major: 0, versionLine: '', error: e.code || e.message }));
  });
}

// getFfmpegVersion() with one retry when the first attempt ran out of time
// (see VERSION_PROBE_TIMEOUT_MS). A second timeout still only means "did not
// answer": callers must leave that binary in place, never delete it.
async function probeVersion(binPath) {
  const first = await getFfmpegVersion(binPath);
  if (!first.timedOut) { return first; }
  winston.warn(`[ffmpeg-bootstrap] ${binPath} gave no version within ${VERSION_PROBE_TIMEOUT_MS / 1000}s, retrying with ${VERSION_PROBE_RETRY_TIMEOUT_MS / 1000}s`);
  return getFfmpegVersion(binPath, VERSION_PROBE_RETRY_TIMEOUT_MS);
}

// What a failed probe says, for the logs.
function probeVerdict(result) {
  if (result.timedOut) { return 'no answer to -version in time'; }
  return result.versionLine || (result.error ? `could not run it (${result.error})` : '(no output)');
}

// ── Core download + verify ──────────────────────────────────────────────────

// Single-flight per target dir (see _installs). A caller arriving while an
// install into the same dir is running — the re-served instance after a soft
// reboot, the post-boot update check, a retry — joins it instead of starting a
// competing one. A DIFFERENT dir (ffmpegDirectory changed by that reboot, or
// the default dir standing in for it) is a separate install with its own
// staging area, so the two never touch. Resolves like installInto().
function downloadAndInstall(dir) {
  const key = path.resolve(dir);
  const inFlight = _installs.get(key);
  if (inFlight) { return inFlight; }
  const promise = installInto(dir).finally(() => {
    if (_installs.get(key) === promise) { _installs.delete(key); }
  });
  _installs.set(key, promise);
  return promise;
}

// Resolves { ok: true } once a verified pair is in place, else { ok: false }.
// `unwritable` on a failure marks the ONE kind a different directory can fix:
// `dir` cannot take an install at all (a read-only mount, another user's
// directory), found out before anything was fetched. Every other failure —
// no pin, the download, the pin check, the execution check — would end the
// same way anywhere, and ensureFfmpeg() does not try a second directory for it.
async function installInto(dir) {
  const release = pinnedRelease();
  if (!release) {
    winston.warn(
      `[ffmpeg-bootstrap] No pinned ffmpeg build for ${process.platform}/${process.arch} in bin/ffmpeg/manifest.json. ` +
      `Place ffmpeg and ffprobe in ${dir} manually (or update the manifest via scripts/update-ffmpeg-manifest.mjs).`
    );
    return { ok: false };
  }

  // Everything is downloaded, extracted, and verified in a staging dir, then
  // renamed into place as a pair. The live binaries stay untouched (and
  // spawnable) for the whole multi-minute download window, and a broken build
  // (glibc mismatch, truncated extract) is rejected before it ever replaces a
  // working install. Staging lives INSIDE the target dir so the final rename
  // never crosses filesystems. Only one install per dir runs in this process
  // (downloadAndInstall's single-flight), so the rm here can only ever hit a
  // previous run's leftovers, never a live one's.
  const staging = path.join(dir, '.staging');
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    // A plain mkdir: `dir` exists by now, and the recursive form reports a
    // read-only filesystem as ENOENT — "no such file or directory, mkdir
    // '/usr/bin/.staging'" is what a YunoHost operator was left to puzzle over.
    // A leftover the rm could not clear is reused, as it always was.
    await fsp.mkdir(staging).catch((e) => { if (e.code !== 'EEXIST') { throw e; } });
  } catch (e) {
    winston.warn(`[ffmpeg-bootstrap] Cannot install ffmpeg into ${dir}: ${e.message}`);
    return { ok: false, unwritable: true };
  }

  // Use explicit bundled paths — NOT ffmpegBin()/ffprobeBin(), which may
  // return a cached resolved path from a previous resolution.
  const destFfmpeg = path.join(dir, `ffmpeg${binaryExt}`);
  const destFfprobe = path.join(dir, `ffprobe${binaryExt}`);
  const stagedFfmpeg = path.join(staging, `ffmpeg${binaryExt}`);
  const stagedFfprobe = path.join(staging, `ffprobe${binaryExt}`);
  // Set when the rolling fallback stood in for a pruned pin: the receipt then
  // records the fallback's identity, not the manifest's (see checkForUpdate).
  let installedPins = null;

  winston.info(`[ffmpeg-bootstrap] Downloading ffmpeg for ${process.platform}/${process.arch}...${MIRROR ? ` (mirror: ${MIRROR})` : ''}`);

  try {
    if (release.source === 'martinriedl') {
      // macOS: per-binary .zip downloads, each verified against its pin.
      if (!(await installMacBinary(release.files.ffmpeg, staging, 'ffmpeg'))) { return { ok: false }; }
      if (!(await installMacBinary(release.files.ffprobe, staging, 'ffprobe'))) { return { ok: false }; }
    } else {
      // BtbN: one archive, verified against its pin before extraction.
      let archiveFile = release.file;
      let archivePath = path.join(staging, release.file);
      const pinned = await downloadPinned(release.url, archivePath, release, release.file);
      if (pinned.ok) {
        winston.info(`[ffmpeg-bootstrap] Checksum verified against the committed pin (${release.tag})`);
      } else if (pinned.gone) {
        // The pinned release was pruned upstream (module header): the rolling
        // stable-branch build beats a fresh install with no ffmpeg at all.
        const fallback = await installLatestFallback(release, staging);
        if (!fallback) { return { ok: false }; }
        archiveFile = fallback.file;
        archivePath = path.join(staging, fallback.file);
        installedPins = { source: 'btbn-latest', forTag: release.tag, file: fallback.file, sha256: fallback.sha256 };
      } else {
        return { ok: false };
      }

      // Extract
      if (archiveFile.endsWith('.tar.xz')) {
        await extractTarXz(archivePath, staging, archiveFile);
      } else if (archiveFile.endsWith('.zip')) {
        await extractZip(archivePath, staging);
      }

      await fsp.chmod(stagedFfmpeg, 0o755).catch(() => {});
      await fsp.chmod(stagedFfprobe, 0o755).catch(() => {});
      await fsp.unlink(archivePath).catch(() => {});
    }

    // Verify BOTH staged binaries execute before touching the live pair —
    // this is the only execution check on the auto-update path, and it
    // catches glibc mismatches and corrupt/truncated extracts. A failure
    // here leaves the previous working install fully intact. A staged build
    // that never answers counts as a failure too: an unverified build must not
    // replace the live pair. Only staging is discarded, never the live pair.
    const ffCheck = await probeVersion(stagedFfmpeg);
    if (ffCheck.major < MIN_FFMPEG_MAJOR) {
      winston.error(`[ffmpeg-bootstrap] ffmpeg verification failed: ${probeVerdict(ffCheck)}`);
      return { ok: false };
    }
    const probeCheck = await probeVersion(stagedFfprobe);
    if (probeCheck.major < MIN_FFMPEG_MAJOR) {
      winston.error(`[ffmpeg-bootstrap] ffprobe verification failed: ${probeVerdict(probeCheck)}`);
      return { ok: false };
    }

    await swapInBinaries([
      { staged: stagedFfmpeg, dest: destFfmpeg },
      { staged: stagedFfprobe, dest: destFfprobe },
    ]);

    // Persist the pins we installed from so the update check has a baseline
    // to compare against — without it the first post-boot check would treat
    // the install we just made as stale and re-download it. It also marks the
    // install as ours — see isManagedDir(). The
    // pre-manifest `.checksum` baseline is superseded (its absence alongside
    // a receipt must not read as "operator's"), so drop it.
    try {
      await writeReceipt(dir, release, installedPins || pinsOf(release));
      await fsp.rm(path.join(dir, LEGACY_CHECKSUM_FILE), { force: true }).catch(() => {});
    } catch (e) {
      winston.warn(`[ffmpeg-bootstrap] could not write install receipt: ${e.message}`);
    }

    winston.info(`[ffmpeg-bootstrap] ffmpeg ready: ${ffCheck.versionLine || destFfmpeg}`);
    return { ok: true };
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] Download failed: ${e.message}`);
    return { ok: false };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensure ffmpeg + ffprobe are available. Walks a resolution chain:
 *   1. Working binaries already on disk in getFfmpegDir() (default or user-configured)
 *   2. musl Linux? → skip download, go straight to system PATH fallback
 *   3. Download + verify the binary actually executes (catches glibc/musl mismatches
 *      the upfront musl check might have missed)
 *   4. System PATH fallback (spawn 'ffmpeg' / 'ffprobe' directly)
 *   5. Nothing works → log and leave _resolvedPaths null; consumers' existence
 *      checks gracefully degrade those features.
 *
 * Steps 1–3 run for the configured directory and then, only when that
 * directory cannot be used, once more for the default data directory standing
 * in for it. "Cannot be used" is one of two things: it holds binaries mStream
 * did not install and cannot run (too old, or half a pair) — never deleted
 * and never installed over, they are somebody else's — or it cannot take an
 * install (read-only, not ours to write). `defaultDir` is injectable for the
 * unit tests.
 *
 * Safe to call multiple times — dedupes via cached promise. On success sets
 * _resolvedFfmpegPath / _resolvedFfprobePath / _resolvedSource.
 *
 * Binaries are deleted or downloaded over only when they are definitely
 * broken AND mStream installed them (isManagedDir). A probe that times out
 * proves nothing (see VERSION_PROBE_TIMEOUT_MS): those binaries stay, nothing
 * is downloaded anywhere, and the chain falls through to the system PATH. An
 * operator's binaries in a custom ffmpegDirectory are never touched either;
 * when they cannot be used, the default directory stands in as described
 * above (on musl, which has nothing to install, it is the system PATH).
 *
 * A chain that a reset() overtakes (soft reboot mid-resolution) runs to its
 * end — its download is the shared single-flight one — but as a bystander: it
 * neither publishes its result nor clears the promise of the chain that
 * replaced it (that used to be possible, and turned one reboot into a THIRD
 * download).
 */
export async function ensureFfmpeg({ defaultDir = BUNDLED_FFMPEG_DIR } = {}) {
  if (_resolvedFfmpegPath) {
    return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
  }
  if (_initPromise) return _initPromise;

  const gen = _generation;
  const current = () => gen === _generation;
  // Publish a resolution — unless a reset() has made this chain stale, in
  // which case the caller still gets its answer but the module state stays
  // with the current chain.
  const resolved = (ffmpeg, ffprobe, source, line) => {
    if (current()) {
      _resolvedFfmpegPath = ffmpeg;
      _resolvedFfprobePath = ffprobe;
      _resolvedSource = source;
      winston.info(`[ffmpeg-bootstrap] ${line}`);
    }
    return { ffmpeg, ffprobe, source };
  };
  // Don't cache a failure — let a later call retry. Only OUR promise, though:
  // a stale chain must not wipe out its successor's.
  const failed = () => {
    if (current()) { _initPromise = null; }
    return null;
  };

  _initPromise = (async () => {
    const musl = isMuslLinux();
    // Where mStream's own binaries may live, in order: the configured
    // directory, then the default data directory standing in for it (see the
    // doc comment for when). YunoHost's package is both reasons at once —
    // ffmpegDirectory=/usr/bin, which holds Debian 12's ffmpeg 5 and is
    // read-only under the unit's ProtectSystem=full — and used to end right
    // here with no ffmpeg at all. musl has nothing to install, so there is no
    // stand-in for it either.
    const dirs = [getFfmpegDir()];
    if (!musl && path.resolve(defaultDir) !== path.resolve(dirs[0])) { dirs.push(defaultDir); }

    // The directory whose binaries were left exactly as they are, for the last
    // log line. `triedDownload` says a download was attempted after that all
    // the same (in the stand-in), so its failure is the news instead.
    let leftInPlace = null;
    let triedDownload = false;

    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const standIn = dirs[i + 1];
      const bundledFfmpeg = path.join(dir, `ffmpeg${binaryExt}`);
      const bundledFfprobe = path.join(dir, `ffprobe${binaryExt}`);
      const haveFfmpeg = await pathExists(bundledFfmpeg);
      const haveFfprobe = await pathExists(bundledFfprobe);

      // ── Step 1: Working binaries already on disk? ──────────────────────
      if (haveFfmpeg && haveFfprobe) {
        const ff = await probeVersion(bundledFfmpeg);
        // Probe ffprobe too — a corrupt or truncated ffprobe next to a healthy
        // ffmpeg would otherwise resolve here and fail later in the waveform /
        // DLNA paths. Every other resolution path checks both. Skipped when
        // ffmpeg gave no answer: nothing below would use the result.
        const fp = ff.timedOut ? null : await probeVersion(bundledFfprobe);
        if (ff.major >= MIN_FFMPEG_MAJOR && fp?.major >= MIN_FFMPEG_MAJOR) {
          return resolved(bundledFfmpeg, bundledFfprobe, 'bundled', ff.versionLine);
        }
        if (ff.timedOut || fp?.timedOut) {
          // Slow is not broken (see VERSION_PROBE_TIMEOUT_MS). Keep them, and
          // don't download over them; transcode's retry probes them again.
          // No stand-in either: nothing has shown this directory unusable, and
          // a second build fetched because a probe was slow helps nobody.
          winston.warn(`[ffmpeg-bootstrap] ${ff.timedOut ? 'ffmpeg' : 'ffprobe'} in ${dir} gave no version in time; leaving the binaries in place`);
          leftInPlace = dir;
          break;
        }
        if (await isManagedDir(dir, defaultDir)) {
          winston.warn(`[ffmpeg-bootstrap] ffmpeg v${ff.major || '?'} / ffprobe v${fp.major || '?'} in ${dir} is unusable, refreshing`);
          await fsp.unlink(bundledFfmpeg).catch(() => {});
          await fsp.unlink(bundledFfprobe).catch(() => {});
        } else {
          // The operator's binaries, or the distro's for /usr/bin: never
          // deleted, and nothing is downloaded into this directory, where the
          // swap would rename over them. The stand-in takes the install.
          const found =
            `ffmpeg v${ff.major || '?'} / ffprobe v${fp.major || '?'} in ${dir} is unusable ` +
            `(mStream needs ${MIN_FFMPEG_MAJOR} or newer). mStream did not install these, so it leaves them alone`;
          if (standIn) {
            winston.warn(`[ffmpeg-bootstrap] ${found} and uses its own build in ${standIn} instead.`);
          } else {
            winston.error(`[ffmpeg-bootstrap] ${found}: replace them, or empty the directory to let mStream download its own.`);
          }
          leftInPlace = dir;
          continue;
        }
      } else if ((haveFfmpeg || haveFfprobe) && !(await isManagedDir(dir, defaultDir))) {
        // Half of an operator's pair: a download would rename over that half.
        const [have, missing] = haveFfmpeg ? ['ffmpeg', 'ffprobe'] : ['ffprobe', 'ffmpeg'];
        const found = `${dir} has ${have} but no ${missing}, and mStream did not install it, so it will not download over it`;
        if (standIn) {
          winston.warn(`[ffmpeg-bootstrap] ${found}: it uses its own build in ${standIn} instead.`);
        } else {
          winston.error(`[ffmpeg-bootstrap] ${found}: add ${missing}, or empty the directory to let mStream download its own.`);
        }
        leftInPlace = dir;
        continue;
      }

      // ── Step 2: musl libc? Skip download, go straight to system fallback ─
      if (musl) { break; }

      // ── Step 3: Download into this directory, verify it executes ───────
      triedDownload = true;
      const install = await downloadAndInstall(dir);
      if (install.ok) {
        const ff = await probeVersion(bundledFfmpeg);
        if (ff.major >= MIN_FFMPEG_MAJOR) {
          return resolved(bundledFfmpeg, bundledFfprobe, 'bundled', ff.versionLine);
        }
        if (ff.timedOut) {
          // installInto() ran this very build in staging moments ago, so a slow
          // answer now is the machine, not the binary: keep it for the retry.
          winston.warn('[ffmpeg-bootstrap] Downloaded ffmpeg gave no version in time; keeping it, trying system fallback');
        } else {
          winston.warn(`[ffmpeg-bootstrap] Downloaded ffmpeg won't execute (likely libc mismatch), trying system fallback`);
          await fsp.unlink(bundledFfmpeg).catch(() => {});
          await fsp.unlink(bundledFfprobe).catch(() => {});
        }
        break;
      }
      // A directory that cannot take an install is the one failure a second
      // directory can fix; a download that failed would fail there as well.
      if (!install.unwritable) { break; }
      if (standIn) { winston.info(`[ffmpeg-bootstrap] Installing into ${standIn} instead`); }
    }

    // ── Step 4: System PATH fallback ─────────────────────────────────────
    if (musl) { winston.info('[ffmpeg-bootstrap] musl libc detected, skipping download'); }
    const sys = await findSystemBinaries();
    if (sys) {
      return resolved(sys.ffmpeg, sys.ffprobe, 'system', `Using system ffmpeg: ${sys.ffmpegVersion}`);
    }

    // ── Step 5: Nothing works ────────────────────────────────────────────
    winston.error(musl
      ? '[ffmpeg-bootstrap] No system ffmpeg found. Install with: apk add ffmpeg'
      : `[ffmpeg-bootstrap] No working ffmpeg found (${leftInPlace && !triedDownload ? `binaries in ${leftInPlace} left in place` : 'download failed'} and no system binary on PATH)`);
    return failed();
  })().catch(e => {
    winston.error(`[ffmpeg-bootstrap] ${e.message}`);
    return failed();
  });

  return _initPromise;
}

/**
 * Returns the source of the currently-resolved ffmpeg binaries.
 * 'bundled' = downloaded/managed by us (in getFfmpegDir())
 * 'system'  = system ffmpeg on PATH
 * null      = not resolved yet (or nothing works)
 */
export function getResolvedSource() {
  return _resolvedSource;
}

/**
 * Reset all resolved state — used by transcode.reset() on soft reboot so that
 * a changed ffmpegDirectory is picked up by the next ensureFfmpeg() call.
 *
 * An install already in flight is left alone on purpose: the next
 * ensureFfmpeg() re-walks the chain and, if the target dir is unchanged, joins
 * that install rather than starting a competitor (see _installs). The chain
 * that was running is marked stale (see ensureFfmpeg) so it can't publish over
 * — or clear the promise of — the one the re-serve starts.
 */
export function reset() {
  _generation++;
  _resolvedFfmpegPath = null;
  _resolvedFfprobePath = null;
  _resolvedSource = null;
  _initPromise = null;
  stopAutoUpdate();
}

/**
 * Refresh the managed install when the COMMITTED pins have changed — a purely
 * LOCAL check (receipt on disk vs bin/ffmpeg/manifest.json), no network
 * unless a refresh is actually due. New builds arrive as manifest-bump PRs
 * (scripts/update-ffmpeg-manifest.mjs), land here via a code update, and the
 * next check converges the install onto them.
 *
 * No-ops when running off system binaries (managed by the OS package
 * manager, not us) and for operator-supplied binaries in a custom
 * ffmpegDirectory (no receipt — we didn't install them).
 */
export async function checkForUpdate() {
  if (_resolvedSource === 'system') return;
  // Operators can freeze their current build (config: transcode.autoUpdate=false)
  // so even a pin change shipped by an update won't touch a working install.
  if (config.program?.transcode?.autoUpdate === false) return;

  const release = pinnedRelease();
  if (!release) return;

  // The binaries in use, wherever they are — the default dir when it stood in
  // for an unusable ffmpegDirectory, not that directory itself.
  const dir = activeFfmpegDir();
  const bin = path.join(dir, `ffmpeg${binaryExt}`);
  try { await fsp.access(bin); } catch { return; } // no binary to update

  // Receipts are only ever written by our own installs, so they double as a
  // provenance marker (see isManagedDir). No marker in a CUSTOM
  // ffmpegDirectory means the operator placed their own binaries there, and
  // overwriting those would destroy them, so hands off. The default dir is
  // always ours; a missing marker there is just an install predating the
  // markers, so refresh and let downloadAndInstall() write a receipt.
  if (!(await isManagedDir(dir))) {
    winston.info('[ffmpeg-bootstrap] Binaries in custom ffmpegDirectory were not installed by mStream — skipping auto-update');
    return;
  }
  const receipt = readReceipt(dir);

  // Up to date = the receipt records exactly the current pins. Legacy
  // installs (a `.checksum` baseline, or a default-dir install with no
  // marker at all) never match and converge onto the pinned build once.
  if (receipt && JSON.stringify(receipt.pins) === JSON.stringify(pinsOf(release))) return;
  // A fallback install (the pinned asset had been pruned upstream — see
  // installLatestFallback) is as current as it can be while the manifest
  // still pins that same dead tag: trying again would only re-fetch the
  // rolling build. It converges the moment a manifest with a new tag ships.
  if (receipt?.pins?.source === 'btbn-latest' && release.source === 'btbn' && receipt.pins.forTag === release.tag) return;

  winston.info('[ffmpeg-bootstrap] Manifest pins changed — refreshing the managed ffmpeg install...');
  // The live binaries stay in place (and spawnable) for the whole download:
  // downloadAndInstall() stages + verifies the new build elsewhere and only
  // then rename-swaps it in, so _resolvedFfmpegPath remains valid for
  // concurrent transcode / DLNA seek / yt-dlp calls throughout. It also
  // persists the new receipt on success.
  await downloadAndInstall(dir);
}

/**
 * Start the periodic update check timer (weekly, after a short post-boot check).
 */
export function startAutoUpdate() {
  // Idempotent: re-entry (e.g. the admin "download ffmpeg" endpoint re-runs
  // init() -> startAutoUpdate()) must NOT stack a second interval and orphan
  // the first — stopAutoUpdate() only knows the latest handle.
  if (_updateTimer) { return; }

  // Check shortly after boot (after the initial ensure settles)
  _bootTimer = setTimeout(() => {
    _bootTimer = null;
    checkForUpdate().catch(e => {
      winston.warn(`[ffmpeg-bootstrap] Update check failed: ${e.message}`);
    });
  }, 30000); // 30 seconds after boot
  if (_bootTimer.unref) { _bootTimer.unref(); }

  // Then weekly. The check is a LOCAL receipt-vs-manifest compare (near
  // free); the interval only matters for a long-running server whose code —
  // and thus manifest — was updated on disk without a restart (git pull, npm
  // update). Operators can freeze entirely via transcode.autoUpdate.
  _updateTimer = setInterval(() => {
    checkForUpdate().catch(e => {
      winston.warn(`[ffmpeg-bootstrap] Update check failed: ${e.message}`);
    });
  }, 7 * 24 * 60 * 60 * 1000);
  if (_updateTimer.unref) { _updateTimer.unref(); }
}

/**
 * Stop the auto-update timer.
 */
export function stopAutoUpdate() {
  if (_bootTimer) {
    clearTimeout(_bootTimer);
    _bootTimer = null;
  }
  if (_updateTimer) {
    clearInterval(_updateTimer);
    _updateTimer = null;
  }
}
