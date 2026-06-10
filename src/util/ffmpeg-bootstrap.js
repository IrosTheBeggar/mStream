/**
 * ffmpeg-bootstrap.js
 *
 * Auto-downloads static ffmpeg + ffprobe binaries on first use, with SHA256
 * checksum verification. Re-checks weekly and auto-updates when a new build
 * is available — but only for binaries it installed itself; operator-supplied
 * binaries in a custom ffmpegDirectory are never overwritten.
 *
 * Supported auto-download platforms:
 *   Linux x64, Linux arm64, Windows x64 (BtbN/FFmpeg-Builds)
 *   macOS x64 / arm64 (ffmpeg.martin-riedl.de)
 *
 * Other platforms: logs a warning — user must provide binaries manually.
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
// downloadToBuffer only ever fetches checksum manifests (a few KB) — cap the
// in-memory size so a misbehaving endpoint can't balloon process memory.
const MAX_BUFFER_BYTES = 1024 * 1024;

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
        let received = 0;
        res.on('data', c => {
          received += c.length;
          if (received > MAX_BUFFER_BYTES) {
            return res.destroy(new Error(`Response exceeds ${MAX_BUFFER_BYTES} bytes for ${u}`));
          }
          chunks.push(c);
        });
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

// macOS: download one binary's .zip into the staging dir, verify its sha256
// (fetched from the resolved download URL — see downloadToFile's return
// value), extract, and chmod. Returns false on any failure so the caller
// refuses to install an unverified binary, matching the BtbN hard-fail
// policy. The caller execution-verifies and swaps the staged pair into place.
async function installMacBinary(redirectUrl, stagingDir, member) {
  const zipPath = path.join(stagingDir, `${member}.zip`);
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
const VERSION_PROBE_TIMEOUT_MS = 10000;

function getFfmpegVersion(binPath) {
  return new Promise(resolve => {
    let p;
    try {
      p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Windows throws SYNCHRONOUSLY ("spawn UNKNOWN") when the file is not a
      // valid executable image (e.g. a corrupt/truncated binary), instead of
      // emitting the async 'error' event other spawn failures use. Without
      // this guard the executor throw rejects the promise — violating the
      // "always resolves" contract — and a corrupt binary on disk would crash
      // resolution instead of triggering the unlink-and-refresh path.
      return resolve({ major: 0, versionLine: '' });
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
      finish({ major: 0, versionLine: '' });
    }, VERSION_PROBE_TIMEOUT_MS);
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
    p.on('error', () => finish({ major: 0, versionLine: '' }));
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

  // Everything is downloaded, extracted, and verified in a staging dir, then
  // renamed into place as a pair. The live binaries stay untouched (and
  // spawnable) for the whole multi-minute download window, and a broken build
  // (glibc mismatch, truncated extract) is rejected before it ever replaces a
  // working install. Staging lives INSIDE getFfmpegDir() so the final rename
  // never crosses filesystems.
  const staging = path.join(dir, '.staging');
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(staging, { recursive: true });

  // Use explicit bundled paths — NOT ffmpegBin()/ffprobeBin(), which may
  // return a cached resolved path from a previous resolution.
  const destFfmpeg = path.join(dir, `ffmpeg${binaryExt}`);
  const destFfprobe = path.join(dir, `ffprobe${binaryExt}`);
  const stagedFfmpeg = path.join(staging, `ffmpeg${binaryExt}`);
  const stagedFfprobe = path.join(staging, `ffprobe${binaryExt}`);

  winston.info(`[ffmpeg-bootstrap] Downloading ffmpeg for ${process.platform}/${process.arch}...`);

  try {
    let archiveChecksum = null;
    if (info.source === 'martin-riedl') {
      // macOS: per-binary .zip downloads, each sha256-verified before extract.
      if (!(await installMacBinary(info.url, staging, 'ffmpeg'))) { return false; }
      if (!(await installMacBinary(info.ffprobeUrl, staging, 'ffprobe'))) { return false; }
    } else {
      // BtbN: archive download with checksum verification
      const archivePath = path.join(staging, info.asset);
      await downloadToFile(info.url, archivePath);

      // Verify checksum — hard-fail if we can't obtain the expected hash, so a
      // transient network blip or compromised CDN can't slip an unverified
      // binary through. Retry will happen on the next ensureFfmpeg() cycle.
      const expected = await fetchExpectedChecksum(info.asset);
      if (!expected) {
        winston.error(`[ffmpeg-bootstrap] Could not fetch checksum for ${info.asset} — refusing to install unverified binary`);
        return false;
      }
      const actual = await computeFileChecksum(archivePath);
      if (actual !== expected) {
        winston.error(`[ffmpeg-bootstrap] Checksum mismatch! Expected ${expected}, got ${actual}`);
        return false;
      }
      archiveChecksum = expected;
      winston.info(`[ffmpeg-bootstrap] Checksum verified`);

      // Extract
      if (info.asset.endsWith('.tar.xz')) {
        await extractTarXz(archivePath, staging, info.asset);
      } else if (info.asset.endsWith('.zip')) {
        await extractZip(archivePath, staging);
      }

      await fsp.chmod(stagedFfmpeg, 0o755).catch(() => {});
      await fsp.chmod(stagedFfprobe, 0o755).catch(() => {});
      await fsp.unlink(archivePath).catch(() => {});
    }

    // Verify BOTH staged binaries execute before touching the live pair —
    // this is the only execution check on the auto-update path, and it
    // catches glibc mismatches and corrupt/truncated extracts. A failure
    // here leaves the previous working install fully intact.
    const ffCheck = await getFfmpegVersion(stagedFfmpeg);
    if (ffCheck.major < MIN_FFMPEG_MAJOR) {
      winston.error(`[ffmpeg-bootstrap] ffmpeg verification failed: ${ffCheck.versionLine || '(no output)'}`);
      return false;
    }
    const probeCheck = await getFfmpegVersion(stagedFfprobe);
    if (probeCheck.major < MIN_FFMPEG_MAJOR) {
      winston.error(`[ffmpeg-bootstrap] ffprobe verification failed: ${probeCheck.versionLine || '(no output)'}`);
      return false;
    }

    await swapInBinaries([
      { staged: stagedFfmpeg, dest: destFfmpeg },
      { staged: stagedFfprobe, dest: destFfprobe },
    ]);

    // Persist the verified archive checksum so the weekly update check has a
    // baseline to compare against. Without this the first post-boot check
    // finds no `.checksum`, assumes "out of date", and re-downloads the exact
    // build we just installed. It also marks the install as ours — see the
    // provenance check in checkForUpdate().
    if (archiveChecksum) {
      await fsp.writeFile(path.join(dir, '.checksum'), archiveChecksum, 'utf8').catch(() => {});
    }

    winston.info(`[ffmpeg-bootstrap] ffmpeg ready: ${ffCheck.versionLine || destFfmpeg}`);
    return true;
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] Download failed: ${e.message}`);
    return false;
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
      // Probe ffprobe too — a corrupt or truncated ffprobe next to a healthy
      // ffmpeg would otherwise resolve here and fail later in the waveform /
      // Subsonic / DLNA paths. Every other resolution path checks both.
      const probe = await getFfmpegVersion(bundledFfprobe);
      if (major >= MIN_FFMPEG_MAJOR && probe.major >= MIN_FFMPEG_MAJOR) {
        _resolvedFfmpegPath = bundledFfmpeg;
        _resolvedFfprobePath = bundledFfprobe;
        _resolvedSource = 'bundled';
        winston.info(`[ffmpeg-bootstrap] ${versionLine}`);
        return { ffmpeg: _resolvedFfmpegPath, ffprobe: _resolvedFfprobePath, source: _resolvedSource };
      }
      winston.warn(`[ffmpeg-bootstrap] ffmpeg v${major || '?'} / ffprobe v${probe.major || '?'} in ${dir} is unusable, refreshing`);
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
      _initPromise = null; // don't cache failure — let a later call retry
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
    _initPromise = null; // don't cache failure — let a later call retry
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
 * No-ops when running off system binaries (managed by the OS package
 * manager, not us) and for operator-supplied binaries in a custom
 * ffmpegDirectory (no `.checksum` baseline — we didn't install them).
 */
export async function checkForUpdate() {
  if (_resolvedSource === 'system') return;
  // Operators can pin their current build (config: transcode.autoUpdate=false)
  // to avoid a rolling upstream build regressing a working install.
  if (config.program?.transcode?.autoUpdate === false) return;

  const info = releaseInfo();
  if (!info) return;

  const bin = path.join(getFfmpegDir(), `ffmpeg${binaryExt}`);
  try { await fsp.access(bin); } catch { return; } // no binary to update

  if (info.source === 'btbn') {
    // BtbN: compare checksums to detect new builds
    const checksumFile = path.join(getFfmpegDir(), '.checksum');
    let stored = null;
    try { stored = (await fsp.readFile(checksumFile, 'utf8')).trim(); } catch {}

    // `.checksum` is only ever written by our own installs, so it doubles as
    // a provenance marker. No baseline in a CUSTOM ffmpegDirectory means the
    // operator placed their own binaries there (possibly a custom or non-free
    // build) — overwriting those with BtbN GPL master would destroy them, so
    // hands off. The default dir is always ours; a missing baseline there is
    // just an install predating the marker, so update and let
    // downloadAndInstall() write one.
    if (!stored && path.resolve(getFfmpegDir()) !== path.resolve(BUNDLED_FFMPEG_DIR)) {
      winston.info('[ffmpeg-bootstrap] Binaries in custom ffmpegDirectory were not installed by mStream — skipping auto-update');
      return;
    }

    const expected = await fetchExpectedChecksum(info.asset);
    if (!expected) return;
    if (stored === expected) return; // already up to date

    winston.info(`[ffmpeg-bootstrap] New ffmpeg build available, updating...`);
    // The live binaries stay in place (and spawnable) for the whole download:
    // downloadAndInstall() stages + verifies the new build elsewhere and only
    // then rename-swaps it in, so _resolvedFfmpegPath remains valid for
    // concurrent transcode / DLNA seek / yt-dlp calls throughout. It also
    // persists the new `.checksum` baseline on success.
    await downloadAndInstall();
  } else {
    // macOS (martin-riedl): the `.sha256` lives at the resolved versioned URL,
    // not a stable path, so a cheap "is there a newer build" check isn't
    // available here. Fall back to a version-floor check — a tagged stable
    // release rarely needs refreshing mid-deployment.
    const { major } = await getFfmpegVersion(bin);
    if (major < MIN_FFMPEG_MAJOR) {
      winston.info(`[ffmpeg-bootstrap] ffmpeg outdated, updating...`);
      await downloadAndInstall();
    }
  }
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

  // Then weekly. BtbN publishes git-master builds ~daily, so a daily check
  // meant ~daily churn (and regression exposure); weekly is plenty current for
  // a media server and cuts that 7×. Operators wanting tighter currency or none
  // at all can still tune via transcode.autoUpdate.
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
