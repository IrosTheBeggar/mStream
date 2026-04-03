/**
 * ffmpeg-bootstrap.js
 *
 * Auto-downloads static ffmpeg + ffprobe binaries into bin/ffmpeg/ on first use.
 * Mirrors the yt-dlp auto-download pattern so mStream is fully self-contained
 * (no system ffmpeg dependency, works inside Docker or minimal Linux installs).
 *
 * Source: BtbN/FFmpeg-Builds GPL static builds (GitHub Releases)
 *   https://github.com/BtbN/FFmpeg-Builds
 *
 * Supported platforms for auto-download:
 *   Linux x64  → ffmpeg-master-latest-linux64-gpl.tar.xz
 *   Linux arm64 → ffmpeg-master-latest-linuxarm64-gpl.tar.xz
 *
 * All other platforms (macOS, Windows, armv7): log a warning and continue —
 * the user must provide the binaries manually via config.ffmpegDirectory.
 *
 * Calling ensureFfmpeg() is safe to call from multiple places simultaneously —
 * the download promise is cached so it only runs once.
 */

import fsp from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import winston from 'winston';
import * as config from '../state/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binaryExt = process.platform === 'win32' ? '.exe' : '';

// Default bundled directory — same location as before, so existing installs
// that already have binaries here continue to work without any migration.
export const BUNDLED_FFMPEG_DIR = path.join(__dirname, '../../bin/ffmpeg');

// Returns the configured ffmpeg directory, falling back to the bundled dir.
export function getFfmpegDir() {
  return config.program.transcode?.ffmpegDirectory || BUNDLED_FFMPEG_DIR;
}

// Full path to the ffmpeg executable.
export function ffmpegBin() {
  return path.join(getFfmpegDir(), `ffmpeg${binaryExt}`);
}

// Full path to the ffprobe executable.
export function ffprobeBin() {
  return path.join(getFfmpegDir(), `ffprobe${binaryExt}`);
}

// Map platform + arch to a BtbN release asset name.
// Returns null when no pre-built static binary is available for this platform.
function _releaseAsset() {
  const { platform, arch } = process;
  if (platform === 'linux') {
    if (arch === 'x64')   return 'ffmpeg-master-latest-linux64-gpl.tar.xz';
    if (arch === 'arm64') return 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz';
  }
  // Windows and macOS are not covered by BtbN static builds that work here.
  // Windows users: place ffmpeg.exe + ffprobe.exe in bin/ffmpeg/.
  // macOS users: brew install ffmpeg or set ffmpegDirectory in config.
  return null;
}

// Download a URL following HTTP redirects, writing the result to destPath.
function _downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'mstream-ffmpeg-installer/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} while downloading ffmpeg from ${u}`));
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', async () => {
          try {
            await fsp.rename(tmp, destPath);
            resolve();
          } catch (e) {
            fsp.unlink(tmp).catch(() => {});
            reject(e);
          }
        });
        out.on('error', e => { fsp.unlink(tmp).catch(() => {}); reject(e); });
      });
      req.on('error', reject);
    };
    follow(url);
  });
}

// Extract ffmpeg and ffprobe from a .tar.xz archive using system tar.
// Uses explicit paths derived from the asset name (no --wildcards) so this
// works with both GNU tar (bare-metal) and BusyBox tar (Alpine / Docker).
//   ffmpeg-master-latest-linux64-gpl/bin/ffmpeg  →  destDir/ffmpeg
//   ffmpeg-master-latest-linux64-gpl/bin/ffprobe →  destDir/ffprobe
function _extractTarXz(tarPath, destDir, asset) {
  // Derive the top-level directory name inside the archive from the asset name.
  // e.g. "ffmpeg-master-latest-linux64-gpl.tar.xz" → "ffmpeg-master-latest-linux64-gpl"
  const prefix = asset.replace(/\.tar\.xz$/, '');
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', [
      '-xJf', tarPath,
      '-C', destDir,
      '--strip-components=2',
      `${prefix}/bin/ffmpeg`,
      `${prefix}/bin/ffprobe`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errOut = '';
    proc.stderr.on('data', d => { errOut += d; });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed (code ${code}): ${errOut.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// Binaries older than this major version are considered stale and replaced.
// 4.4.1 (2022 johnvansickle) is well below this; Debian Bookworm 5.1 passes.
const MIN_FFMPEG_MAJOR = 6;

// Run `ffmpeg -version` and return { major, versionLine }.
// Returns { major: 0, versionLine: '' } on any failure.
// Handles both stable releases ("ffmpeg version 7.1.1") and BtbN git snapshot
// builds ("ffmpeg version N-123777-g53537f6cf5-20260331").  Git snapshot
// builds always have a major version > 6 so we treat them as major = 99.
function _getFfmpegVersion(binPath) {
  return new Promise(resolve => {
    const p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => {
      const line = o.split('\n')[0] || '';
      // Stable release: "ffmpeg version 7.1.1 ..."
      const stableMatch = line.match(/ffmpeg version (\d+)/);
      if (stableMatch) {
        return resolve({ major: parseInt(stableMatch[1], 10), versionLine: line });
      }
      // BtbN git snapshot: "ffmpeg version N-123777-g<hash>-<date> ..."
      // These are always cutting-edge builds, always valid.
      if (/ffmpeg version N-\d+/.test(line)) {
        return resolve({ major: 99, versionLine: line });
      }
      resolve({ major: 0, versionLine: line });
    });
    p.on('error', () => resolve({ major: 0, versionLine: '' }));
  });
}

let _ffmpegReady = null;

/**
 * Ensure that ffmpeg and ffprobe are present and recent in the configured
 * directory.  Downloads them on first call if missing or outdated (major
 * version < MIN_FFMPEG_MAJOR).  Always logs the current version at startup.
 *
 * Returns the ffmpeg directory path once ready.  Never throws — logs warnings
 * on failure so the caller can decide how to handle a missing binary.
 */
export async function ensureFfmpeg() {
  if (_ffmpegReady) return _ffmpegReady;
  _ffmpegReady = (async () => {
    const dir   = getFfmpegDir();
    const dest  = path.join(dir, `ffmpeg${binaryExt}`);
    const probe = path.join(dir, `ffprobe${binaryExt}`);

    // Check presence
    let ffmpegPresent = false;
    let ffprobePresent = false;
    try { await fsp.access(dest);  ffmpegPresent  = true; } catch {}
    try { await fsp.access(probe); ffprobePresent = true; } catch {}

    if (ffmpegPresent && ffprobePresent) {
      // Always log the version so it appears in the startup log.
      const { major, versionLine } = await _getFfmpegVersion(dest);
      if (major >= MIN_FFMPEG_MAJOR) {
        winston.info(`[ffmpeg-bootstrap] ${versionLine || `ffmpeg v${major} found`}`);
        return dir;
      }
      // Stale binary (e.g. 4.4.1 from 2022 johnvansickle) — replace it.
      winston.warn(
        `[ffmpeg-bootstrap] ffmpeg v${major || '?'} is outdated (minimum v${MIN_FFMPEG_MAJOR}) — ` +
        `replacing with latest static build…`
      );
      await fsp.unlink(dest).catch(() => {});
      await fsp.unlink(probe).catch(() => {});
      ffmpegPresent = false;
      ffprobePresent = false;
    }

    const asset = _releaseAsset();
    if (!asset) {
      winston.warn(
        `[ffmpeg-bootstrap] No static build available for ${process.platform}/${process.arch}. ` +
        `Place ffmpeg and ffprobe in ${dir} or set ffmpegDirectory in your config.`
      );
      return dir;
    }

    // Use the stable "latest" tag URL, not the /releases/latest/download/ convenience
    // redirect — the latter can land on a brand-new timestamped release whose assets
    // are still uploading, causing a 404.  The "latest" tag is what BtbN maintains as
    // their stable pointer.
    const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`;
    winston.info(`[ffmpeg-bootstrap] Downloading ${asset} — this may take a minute…`);

    await fsp.mkdir(dir, { recursive: true });
    const tarPath = path.join(dir, asset);

    try {
      await _downloadFile(url, tarPath);
      await _extractTarXz(tarPath, dir, asset);
      // Make both executables
      await fsp.chmod(dest, 0o755).catch(() => {});
      await fsp.chmod(probe, 0o755).catch(() => {});
      await fsp.unlink(tarPath).catch(() => {});

      // Verify extraction actually produced the binaries
      await fsp.access(dest);
      await fsp.access(probe);

      const { versionLine } = await _getFfmpegVersion(dest);
      winston.info(`[ffmpeg-bootstrap] ffmpeg ready: ${versionLine || dest}`);
    } catch (e) {
      await fsp.unlink(tarPath).catch(() => {});
      // Reset so next call can retry
      _ffmpegReady = null;
      throw e;
    }

    return dir;
  })().catch(e => {
    winston.error(`[ffmpeg-bootstrap] Failed to download ffmpeg: ${e.message}`);
    _ffmpegReady = null; // allow retry on next call
    return getFfmpegDir(); // return dir anyway — caller checks binary existence
  });
  return _ffmpegReady;
}
