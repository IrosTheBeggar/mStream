/**
 * ffmpeg-bootstrap.js
 *
 * Auto-downloads static ffmpeg + ffprobe binaries on first use, with SHA256
 * checksum verification. Re-checks daily and auto-updates when a new version
 * is available from BtbN/FFmpeg-Builds on GitHub.
 *
 * Supported auto-download platforms:
 *   Linux x64, Linux arm64, Windows x64
 *
 * macOS / other: logs a warning — user must provide binaries manually.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import * as config from '../state/config.js';
import { getDirname } from './esm-helpers.js';

const __dirname = getDirname(import.meta.url);
const binaryExt = process.platform === 'win32' ? '.exe' : '';
const BUNDLED_FFMPEG_DIR = path.join(__dirname, '../../bin/ffmpeg');
const MIN_FFMPEG_MAJOR = 6;
const CHECKSUMS_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256';
// Download hardening: cap redirect chains and apply a socket-inactivity
// timeout so a stalled or looping endpoint can't hang the process forever.
const MAX_REDIRECTS = 5;
const HTTP_TIMEOUT_MS = 30000;

let _initPromise = null;
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

// Probe the system PATH for ffmpeg + ffprobe. Uses the existing
// getFfmpegVersion helper which does spawn(name, ['-version']) — bare command
// names get resolved via PATH by Node's child_process. Returns the bare names
// so later spawns will keep resolving via PATH (system PATH is stable enough
// that caching a bare name is fine).
async function findSystemBinaries() {
  const [ff, fp] = await Promise.all([
    getFfmpegVersion('ffmpeg'),
    getFfmpegVersion('ffprobe'),
  ]);
  if (ff.major >= MIN_FFMPEG_MAJOR && fp.major >= MIN_FFMPEG_MAJOR) {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ffmpegVersion: ff.versionLine };
  }
  return null;
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}


// ── Platform → asset mapping ────────────────────────────────────────────────

// BtbN assets (Linux, Windows) — used for download URL and checksum verification
function btbnAsset() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64')   return 'ffmpeg-master-latest-linux64-gpl.tar.xz';
  if (platform === 'linux' && arch === 'arm64') return 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz';
  if (platform === 'win32' && arch === 'x64')   return 'ffmpeg-master-latest-win64-gpl.zip';
  return null;
}

// Returns { url, asset, source } for the current platform, or null if unsupported.
function releaseInfo() {
  const asset = btbnAsset();
  if (asset) {
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`,
      asset,
      source: 'btbn'
    };
  }

  // macOS: martin-riedl.de provides static builds for Intel + Apple Silicon.
  // Each binary ships as a `.zip` with a sibling `.sha256`. The /redirect/
  // endpoint 307s to a versioned /download/ path, and the `.sha256` only
  // exists at that resolved path — so we follow the redirect at download time
  // and derive the checksum URL from the final location. `release` = tagged
  // stable build (vs `snapshot` = git master). Arch tokens are amd64/arm64.
  if (process.platform === 'darwin') {
    const macArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const base = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${macArch}/release`;
    return {
      url: `${base}/ffmpeg.zip`,
      ffprobeUrl: `${base}/ffprobe.zip`,
      asset: `ffmpeg-macos-${macArch}`,
      source: 'martin-riedl'
    };
  }

  return null;
}

// ── HTTP download with redirect following ───────────────────────────────────

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > MAX_REDIRECTS) { return reject(new Error(`Too many redirects for ${url}`)); }
      if (!u.startsWith('https:')) { return reject(new Error(`Refusing non-HTTPS URL: ${u}`)); }
      const req = https.get(u, { headers: { 'User-Agent': 'mstream-ffmpeg-bootstrap/2.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Location may be relative (martin-riedl) — resolve against `u`.
          return follow(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Timeout downloading ${u}`)));
    };
    follow(url);
  });
}

// Resolves with the final (post-redirect) URL so callers can derive sibling
// resources — e.g. a `.sha256` that only exists at the resolved download path.
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > MAX_REDIRECTS) { return reject(new Error(`Too many redirects for ${url}`)); }
      if (!u.startsWith('https:')) { return reject(new Error(`Refusing non-HTTPS URL: ${u}`)); }
      const req = https.get(u, { headers: { 'User-Agent': 'mstream-ffmpeg-bootstrap/2.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        const fail = e => { out.destroy(); fsp.unlink(tmp).catch(() => {}); reject(e); };
        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', async () => {
          try { await fsp.rename(tmp, destPath); resolve(u); }
          catch (e) { fsp.unlink(tmp).catch(() => {}); reject(e); }
        });
        res.pipe(out);
      });
      req.on('error', reject);
      req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Timeout downloading ${u}`)));
    };
    follow(url);
  });
}

// ── Checksum verification ───────────────────────────────────────────────────

async function fetchExpectedChecksum(assetName) {
  try {
    const buf = await downloadToBuffer(CHECKSUMS_URL);
    const lines = buf.toString('utf8').split('\n');
    for (const line of lines) {
      // Format: "sha256hash  filename"
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === assetName) {
        return parts[0];
      }
    }
  } catch (e) {
    winston.warn(`[ffmpeg-bootstrap] Could not fetch checksums: ${e.message}`);
  }
  return null;
}

function computeFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Extraction ──────────────────────────────────────────────────────────────

function extractTarXz(tarPath, destDir, asset) {
  const prefix = asset.replace(/\.tar\.xz$/, '');
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', [
      '-xJf', tarPath, '-C', destDir, '--strip-components=2',
      `${prefix}/bin/ffmpeg`, `${prefix}/bin/ffprobe`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.slice(-300)}`)));
    proc.on('error', reject);
  });
}

async function extractZip(zipPath, destDir, asset) {
  // Windows: use PowerShell to extract
  const prefix = asset.replace(/\.zip$/, '');
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

// Fetch + parse a single-line `<sha256>  <name>` checksum file. Returns the
// lowercased hex digest, or null on any failure (network, format, etc.).
async function fetchRemoteSha256(url) {
  try {
    const buf = await downloadToBuffer(url);
    const token = buf.toString('utf8').trim().split('\n')[0].trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
  } catch (e) {
    winston.warn(`[ffmpeg-bootstrap] Could not fetch checksum ${url}: ${e.message}`);
    return null;
  }
}

// macOS: download one binary's .zip, verify its sha256 (fetched from the
// resolved download URL — see downloadToFile's return value), extract, and
// chmod. Returns false on any failure so the caller refuses to install an
// unverified binary, matching the BtbN hard-fail policy.
async function installMacBinary(redirectUrl, dir, member, destBin) {
  const zipPath = path.join(dir, `${member}.zip`);
  let finalUrl;
  try {
    finalUrl = await downloadToFile(redirectUrl, zipPath);
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] ${member} download failed: ${e.message}`);
    return false;
  }
  const expected = await fetchRemoteSha256(`${finalUrl}.sha256`);
  if (!expected) {
    await fsp.unlink(zipPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] No checksum for ${member} (macOS) — refusing unverified binary`);
    return false;
  }
  const actual = await computeFileChecksum(zipPath);
  if (actual !== expected) {
    await fsp.unlink(zipPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] Checksum mismatch for ${member} (macOS)! Expected ${expected}, got ${actual}`);
    return false;
  }
  try {
    await extractZipUnix(zipPath, dir, member);
  } catch (e) {
    await fsp.unlink(zipPath).catch(() => {});
    winston.error(`[ffmpeg-bootstrap] ${member} extract failed: ${e.message}`);
    return false;
  }
  await fsp.chmod(destBin, 0o755).catch(() => {});
  await fsp.unlink(zipPath).catch(() => {});
  return true;
}

// ── Version check ───────────────────────────────────────────────────────────

function getFfmpegVersion(binPath) {
  return new Promise(resolve => {
    const p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => {
      const line = o.split('\n')[0] || '';
      const stable = line.match(/(?:ffmpeg|ffprobe) version (\d+)/);
      if (stable) return resolve({ major: parseInt(stable[1], 10), versionLine: line });
      if (/(?:ffmpeg|ffprobe) version N-\d+/.test(line)) return resolve({ major: 99, versionLine: line });
      resolve({ major: 0, versionLine: line });
    });
    p.on('error', () => resolve({ major: 0, versionLine: '' }));
  });
}

// ── Core download + verify ──────────────────────────────────────────────────

async function downloadAndInstall() {
  const info = releaseInfo();
  if (!info) {
    winston.warn(
      `[ffmpeg-bootstrap] No static build for ${process.platform}/${process.arch}. ` +
      `Place ffmpeg and ffprobe in ${getFfmpegDir()} manually.`
    );
    return false;
  }

  const dir = getFfmpegDir();
  await fsp.mkdir(dir, { recursive: true });

  // Use explicit bundled paths — NOT ffmpegBin()/ffprobeBin(), which may
  // return a cached resolved path from a previous resolution.
  const destFfmpeg = path.join(dir, `ffmpeg${binaryExt}`);
  const destFfprobe = path.join(dir, `ffprobe${binaryExt}`);

  winston.info(`[ffmpeg-bootstrap] Downloading ffmpeg for ${process.platform}/${process.arch}...`);

  try {
    let archiveChecksum = null;
    if (info.source === 'martin-riedl') {
      // macOS: per-binary .zip downloads, each sha256-verified before extract.
      if (!(await installMacBinary(info.url, dir, 'ffmpeg', destFfmpeg))) { return false; }
      if (!(await installMacBinary(info.ffprobeUrl, dir, 'ffprobe', destFfprobe))) { return false; }
    } else {
      // BtbN: archive download with checksum verification
      const archivePath = path.join(dir, info.asset);
      await downloadToFile(info.url, archivePath);

      // Verify checksum — hard-fail if we can't obtain the expected hash, so a
      // transient network blip or compromised CDN can't slip an unverified
      // binary through. Retry will happen on the next ensureFfmpeg() cycle.
      const expected = await fetchExpectedChecksum(info.asset);
      if (!expected) {
        await fsp.unlink(archivePath).catch(() => {});
        winston.error(`[ffmpeg-bootstrap] Could not fetch checksum for ${info.asset} — refusing to install unverified binary`);
        return false;
      }
      const actual = await computeFileChecksum(archivePath);
      if (actual !== expected) {
        await fsp.unlink(archivePath).catch(() => {});
        winston.error(`[ffmpeg-bootstrap] Checksum mismatch! Expected ${expected}, got ${actual}`);
        return false;
      }
      archiveChecksum = expected;
      winston.info(`[ffmpeg-bootstrap] Checksum verified`);

      // Extract
      if (info.asset.endsWith('.tar.xz')) {
        await extractTarXz(archivePath, dir, info.asset);
      } else if (info.asset.endsWith('.zip')) {
        await extractZip(archivePath, dir, info.asset);
      }

      await fsp.chmod(destFfmpeg, 0o755).catch(() => {});
      await fsp.chmod(destFfprobe, 0o755).catch(() => {});
      await fsp.unlink(archivePath).catch(() => {});
    }

    // Verify binaries exist
    await fsp.access(destFfmpeg);
    await fsp.access(destFfprobe);

    const { versionLine } = await getFfmpegVersion(destFfmpeg);
    // Also verify ffprobe executes — otherwise a corrupt or truncated extract
    // passes silently and fails later in waveform/DLNA time-seek paths.
    const probeCheck = await getFfmpegVersion(destFfprobe);
    if (probeCheck.major < MIN_FFMPEG_MAJOR) {
      winston.error(`[ffmpeg-bootstrap] ffprobe verification failed: ${probeCheck.versionLine || '(no output)'}`);
      return false;
    }

    // Persist the verified archive checksum so the daily update check has a
    // baseline to compare against. Without this the first post-boot check
    // finds no `.checksum`, assumes "out of date", and re-downloads the exact
    // build we just installed.
    if (archiveChecksum) {
      await fsp.writeFile(path.join(dir, '.checksum'), archiveChecksum, 'utf8').catch(() => {});
    }

    winston.info(`[ffmpeg-bootstrap] ffmpeg ready: ${versionLine || destFfmpeg}`);
    return true;
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] Download failed: ${e.message}`);
    return false;
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
 * Safe to call multiple times — dedupes via cached promise. On success sets
 * _resolvedFfmpegPath / _resolvedFfprobePath / _resolvedSource.
 */
export async function ensureFfmpeg() {
  if (_resolvedFfmpegPath) {
    return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
  }
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const dir = getFfmpegDir();
    const bundledFfmpeg = path.join(dir, `ffmpeg${binaryExt}`);
    const bundledFfprobe = path.join(dir, `ffprobe${binaryExt}`);

    // ── Step 1: Working binaries already on disk? ────────────────────────
    if (await pathExists(bundledFfmpeg) && await pathExists(bundledFfprobe)) {
      const { major, versionLine } = await getFfmpegVersion(bundledFfmpeg);
      if (major >= MIN_FFMPEG_MAJOR) {
        _resolvedFfmpegPath = bundledFfmpeg;
        _resolvedFfprobePath = bundledFfprobe;
        _resolvedSource = 'bundled';
        winston.info(`[ffmpeg-bootstrap] ${versionLine}`);
        return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
      }
      winston.warn(`[ffmpeg-bootstrap] ffmpeg v${major || '?'} in ${dir} is unusable, refreshing`);
      await fsp.unlink(bundledFfmpeg).catch(() => {});
      await fsp.unlink(bundledFfprobe).catch(() => {});
    }

    // ── Step 2: musl libc? Skip download, go straight to system fallback ─
    if (isMuslLinux()) {
      winston.info('[ffmpeg-bootstrap] musl libc detected, skipping download');
      const sys = await findSystemBinaries();
      if (sys) {
        _resolvedFfmpegPath = sys.ffmpeg;
        _resolvedFfprobePath = sys.ffprobe;
        _resolvedSource = 'system';
        winston.info(`[ffmpeg-bootstrap] Using system ffmpeg: ${sys.ffmpegVersion}`);
        return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
      }
      winston.error('[ffmpeg-bootstrap] No system ffmpeg found. Install with: apk add ffmpeg');
      return null;
    }

    // ── Step 3: Download to getFfmpegDir(), verify it executes ───────────
    const downloadOk = await downloadAndInstall();
    if (downloadOk) {
      const { major, versionLine } = await getFfmpegVersion(bundledFfmpeg);
      if (major >= MIN_FFMPEG_MAJOR) {
        _resolvedFfmpegPath = bundledFfmpeg;
        _resolvedFfprobePath = bundledFfprobe;
        _resolvedSource = 'bundled';
        winston.info(`[ffmpeg-bootstrap] ${versionLine}`);
        return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
      }
      winston.warn(`[ffmpeg-bootstrap] Downloaded ffmpeg won't execute (likely libc mismatch), trying system fallback`);
      await fsp.unlink(bundledFfmpeg).catch(() => {});
      await fsp.unlink(bundledFfprobe).catch(() => {});
    }

    // ── Step 4: System PATH fallback ─────────────────────────────────────
    const sys = await findSystemBinaries();
    if (sys) {
      _resolvedFfmpegPath = sys.ffmpeg;
      _resolvedFfprobePath = sys.ffprobe;
      _resolvedSource = 'system';
      winston.info(`[ffmpeg-bootstrap] Using system ffmpeg: ${sys.ffmpegVersion}`);
      return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
    }

    // ── Step 5: Nothing works ────────────────────────────────────────────
    winston.error('[ffmpeg-bootstrap] No working ffmpeg found (download failed and no system binary on PATH)');
    return null;
  })().catch(e => {
    winston.error(`[ffmpeg-bootstrap] ${e.message}`);
    _initPromise = null; // allow retry
    return null;
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
 */
export function reset() {
  _resolvedFfmpegPath = null;
  _resolvedFfprobePath = null;
  _resolvedSource = null;
  _initPromise = null;
  stopAutoUpdate();
}

/**
 * Check for updates and re-download if a newer version is available.
 * Compares the checksum of the current archive against the remote.
 * No-ops when running off system binaries — those are managed by the OS
 * package manager, not us.
 */
export async function checkForUpdate() {
  if (_resolvedSource === 'system') return;

  const info = releaseInfo();
  if (!info) return;

  const bin = path.join(getFfmpegDir(), `ffmpeg${binaryExt}`);
  try { await fsp.access(bin); } catch { return; } // no binary to update

  if (info.source === 'btbn') {
    // BtbN: compare checksums to detect new builds
    const checksumFile = path.join(getFfmpegDir(), '.checksum');
    const expected = await fetchExpectedChecksum(info.asset);
    if (!expected) return;

    let stored = null;
    try { stored = (await fsp.readFile(checksumFile, 'utf8')).trim(); } catch {}

    if (stored === expected) return; // already up to date

    winston.info(`[ffmpeg-bootstrap] New ffmpeg build available, updating...`);
    // Leave existing binaries in place; downloadAndInstall overwrites them on
    // success (tar/zip overwrite existing files; direct download uses .tmp +
    // rename). If we unlinked first, _resolvedFfmpegPath would point at a
    // deleted file during the multi-minute download window, making every
    // concurrent transcode / DLNA seek / yt-dlp call fail with ENOENT.
    _initPromise = null;

    // downloadAndInstall() persists the new `.checksum` baseline itself on
    // success, so there's nothing more to record here.
    await downloadAndInstall();
  } else {
    // macOS (martin-riedl): the `.sha256` lives at the resolved versioned URL,
    // not a stable path, so a cheap "is there a newer build" check isn't
    // available here. Fall back to a version-floor check — a tagged stable
    // release rarely needs refreshing mid-deployment.
    const { major } = await getFfmpegVersion(bin);
    if (major < MIN_FFMPEG_MAJOR) {
      winston.info(`[ffmpeg-bootstrap] ffmpeg outdated, updating...`);
      // See BtbN branch above — don't unlink before download.
      _initPromise = null;
      await downloadAndInstall();
    }
  }
}

/**
 * Start the daily update check timer.
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

  // Then every 24 hours
  _updateTimer = setInterval(() => {
    checkForUpdate().catch(e => {
      winston.warn(`[ffmpeg-bootstrap] Update check failed: ${e.message}`);
    });
  }, 24 * 60 * 60 * 1000);
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
