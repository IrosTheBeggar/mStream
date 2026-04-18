import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import https from 'https';
import { nanoid } from 'nanoid';
import winston from 'winston';
import path from 'path';
import { spawn } from 'child_process';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import kill from 'tree-kill';
import * as killQueue from './kill-list.js';
import * as config from './config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

const parser = new XMLParser({ ignoreAttributes: false });
const binaryExt = process.platform === 'win32' ? '.exe' : '';
const DEFAULT_SYNCTHING_DIR = path.join(__dirname, '../../bin/syncthing');

// Download destination for the syncthing binary. Defaults to bin/syncthing/
// but can be overridden via config (e.g. Electron sets it to a writable path
// in userData since the app bundle is read-only on macOS).
function getSyncthingBinaryDir() {
  return config.program.federation?.syncthingBinaryDirectory || DEFAULT_SYNCTHING_DIR;
}

let spawnedProcess;
let xmlObj;          // Syncthing XML Config
let myId;            // Syncthing Device ID
const cacheObj = {}; // maps library name → syncthing folder ID
let uiAddress;

// Resolved once during ensureSyncthing(). Consumers read via syncthingBin().
// _resolvedSource is 'bundled' (downloaded + managed in getSyncthingBinaryDir())
// or 'system' (bare command name resolved via PATH).
let _resolvedSyncthingPath = null;
let _resolvedSource = null;

killQueue.addToKillQueue(
  () => {
    if (spawnedProcess) {
      kill(spawnedProcess.pid);
    }
  }
);

// ── Public API ──────────────────────────────────────────────────────────────

export function getXml() {
  return xmlObj;
}

export function getId() {
  return myId;
}

export function getUiAddress() {
  if (typeof uiAddress !== 'string') { throw new Error('Syncthing UI Address Not Set'); }
  return uiAddress;
}

export function getPathId(p) {
  return cacheObj[p];
}

function syncthingBin() {
  if (_resolvedSyncthingPath) return _resolvedSyncthingPath;
  return path.join(getSyncthingBinaryDir(), `syncthing${binaryExt}`);
}

// ── Binary resolution (mirrors ffmpeg-bootstrap.js) ─────────────────────────

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Platform → GitHub release asset mapping.
// Returns { asset, ext } or null for unsupported platforms.
function releaseAsset() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64')   return { asset: 'linux-amd64', ext: 'tar.gz' };
  if (platform === 'linux' && arch === 'arm64') return { asset: 'linux-arm64', ext: 'tar.gz' };
  if (platform === 'win32' && arch === 'x64')   return { asset: 'windows-amd64', ext: 'zip' };
  if (platform === 'darwin' && arch === 'x64')  return { asset: 'macos-amd64', ext: 'zip' };
  if (platform === 'darwin' && arch === 'arm64') return { asset: 'macos-arm64', ext: 'zip' };
  return null;
}

// Run `syncthing --version` (or bare command) and return the version line.
// Uses `--version` flag (not subcommand) which works identically in v1 and v2.
function getSyncthingVersion(binPath) {
  return new Promise(resolve => {
    const p = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => {
      const line = o.split('\n')[0] || '';
      const match = line.match(/syncthing v?(\d+)\.(\d+)/i);
      if (match) return resolve({ major: parseInt(match[1], 10), versionLine: line.trim() });
      resolve({ major: 0, versionLine: line.trim() });
    });
    p.on('error', () => resolve({ major: 0, versionLine: '' }));
  });
}

// Fetch latest release tag from GitHub API.
async function fetchLatestTag() {
  return new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/syncthing/syncthing/releases/latest', {
      headers: { 'User-Agent': 'mstream-syncthing-bootstrap/1.0', 'Accept': 'application/json' }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching latest release`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data.tag_name); // e.g. "v2.0.16"
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'mstream-syncthing-bootstrap/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', async () => {
          try { await fsp.rename(tmp, destPath); resolve(); }
          catch (e) { fsp.unlink(tmp).catch(() => {}); reject(e); }
        });
        out.on('error', e => { fsp.unlink(tmp).catch(() => {}); reject(e); });
      }).on('error', reject);
    };
    follow(url);
  });
}

function extractTarGz(tarPath, destDir, innerBinaryPath, destBinary) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', [
      '-xzf', tarPath, '-C', destDir, '--strip-components=1',
      innerBinaryPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.slice(-300)}`)));
    proc.on('error', reject);
  });
}

function extractZip(zipPath, destDir, innerBinaryName) {
  // Windows/macOS: use PowerShell (Windows) or unzip (macOS) to extract the single syncthing binary
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const script = `
        $zip = '${zipPath.replace(/'/g, "''")}';
        $dest = '${destDir.replace(/'/g, "''")}';
        Add-Type -Assembly System.IO.Compression.FileSystem;
        $archive = [IO.Compression.ZipFile]::OpenRead($zip);
        foreach ($entry in $archive.Entries) {
          if ($entry.Name -eq '${innerBinaryName}') {
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
  // macOS: use unzip with the internal path, then move it up
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-o', '-j', zipPath, `*/${innerBinaryName}`, '-d', destDir],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip failed (${code}): ${err.slice(-300)}`)));
    proc.on('error', reject);
  });
}

async function downloadAndInstall() {
  const info = releaseAsset();
  if (!info) {
    winston.warn(`[syncthing-bootstrap] No download for ${process.platform}/${process.arch}`);
    return false;
  }

  let tag;
  try {
    tag = await fetchLatestTag();
  } catch (e) {
    winston.warn(`[syncthing-bootstrap] Could not fetch latest tag: ${e.message}`);
    return false;
  }

  const binDir = getSyncthingBinaryDir();
  const filename = `syncthing-${info.asset}-${tag}.${info.ext}`;
  const url = `https://github.com/syncthing/syncthing/releases/download/${tag}/${filename}`;
  const innerDir = `syncthing-${info.asset}-${tag}`;
  const innerBinary = `syncthing${binaryExt}`;
  const destBinary = path.join(binDir, innerBinary);

  await fsp.mkdir(binDir, { recursive: true });

  winston.info(`[syncthing-bootstrap] Downloading syncthing ${tag} for ${info.asset}...`);

  try {
    const archivePath = path.join(binDir, filename);
    await downloadToFile(url, archivePath);

    if (info.ext === 'tar.gz') {
      // Linux: extract with tar, --strip-components=1 drops the syncthing-{platform}-{tag}/ prefix
      await extractTarGz(archivePath, binDir, `${innerDir}/${innerBinary}`, destBinary);
    } else {
      // Windows / macOS
      await extractZip(archivePath, binDir, innerBinary);
    }

    await fsp.chmod(destBinary, 0o755).catch(() => {});
    await fsp.unlink(archivePath).catch(() => {});

    await fsp.access(destBinary);
    const { versionLine } = await getSyncthingVersion(destBinary);
    winston.info(`[syncthing-bootstrap] syncthing ready: ${versionLine || destBinary}`);
    return true;
  } catch (e) {
    winston.error(`[syncthing-bootstrap] Download failed: ${e.message}`);
    return false;
  }
}

async function findSystemBinary() {
  const { major, versionLine } = await getSyncthingVersion('syncthing' + binaryExt);
  if (major > 0) {
    return { path: 'syncthing' + binaryExt, versionLine };
  }
  return null;
}

/**
 * Ensure the syncthing binary is present and runnable.
 *
 * Resolution chain (first hit wins):
 *   1. Existing binary in getSyncthingBinaryDir() that runs cleanly
 *   2. Download latest release from GitHub, extract, verify it runs
 *   3. Fallback: system `syncthing` on PATH
 *   4. Nothing works: log + leave resolved paths null
 */
export async function ensureSyncthing() {
  const binDir = getSyncthingBinaryDir();
  const bundled = path.join(binDir, `syncthing${binaryExt}`);

  // ── Step 1: existing binary in bundled dir ──
  if (await pathExists(bundled)) {
    const { major, versionLine } = await getSyncthingVersion(bundled);
    if (major > 0) {
      _resolvedSyncthingPath = bundled;
      _resolvedSource = 'bundled';
      winston.info(`[syncthing-bootstrap] ${versionLine}`);
      return true;
    }
    // Old v1 binary that we can't run — delete it so we download fresh
    winston.warn('[syncthing-bootstrap] Existing binary failed version check, replacing...');
    await fsp.unlink(bundled).catch(() => {});
  }

  // ── Step 2: download + verify ──
  const downloaded = await downloadAndInstall();
  if (downloaded) {
    _resolvedSyncthingPath = bundled;
    _resolvedSource = 'bundled';
    return true;
  }

  // ── Step 3: system PATH fallback ──
  const sys = await findSystemBinary();
  if (sys) {
    _resolvedSyncthingPath = sys.path;
    _resolvedSource = 'system';
    winston.info(`[syncthing-bootstrap] Using system syncthing: ${sys.versionLine}`);
    return true;
  }

  // ── Step 4: nothing works ──
  winston.error(
    '[syncthing-bootstrap] No syncthing available. Install one with your package manager ' +
    `(e.g. 'apk add syncthing', 'apt install syncthing') or place a binary in ${binDir}`
  );
  return false;
}

// ── Setup / teardown ────────────────────────────────────────────────────────

// TODO: change this for server reboot
export async function setup() {
  if (config.program.federation.enabled === false) { return kill2(); }

  const ready = await ensureSyncthing();
  if (!ready) {
    winston.warn('Federation enabled but syncthing unavailable — skipping boot');
    return;
  }

  try {
    await getSyncthingId();
    loadConfig();
  } catch (_err) {
    // if we fail to get the ID, we might need to init
    try {
      await initSyncthingConfig();
      loadConfig();
      await getSyncthingId();
      removeFoldersFromConfig();
      firstTimeConfig();
      addFoldersToConfig();
      saveIt();
    } catch (err) {
      return winston.error('Failed To Boot Syncthing', { stack: err });
    }
  }

  bootProgram();
}

let preventRebootFlag = false;
export function kill2() {
  if (spawnedProcess) {
    preventRebootFlag = true;
    kill(spawnedProcess.pid);
    spawnedProcess = undefined;
    myId = undefined;
    xmlObj = undefined;
  }
  _resolvedSyncthingPath = null;
  _resolvedSource = null;
}

// ── Syncthing v2 subcommand invocations ────────────────────────────────────

function initSyncthingConfig() {
  return new Promise((resolve, reject) => {
    // v2: `syncthing generate --home=<dir>` (was `--generate=<dir>` in v1)
    const newProcess = spawn(syncthingBin(), ['generate', `--home=${config.program.storage.syncConfigDirectory}`], {});

    newProcess.stdout.on('data', (data) => {
      winston.info(`SYNCTHING: ${`${data}`.trim()}`);
    });

    newProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    newProcess.on('close', (code) => {
      if (code !== 0) {
        winston.error('Syncthing: Failed to setup new directory');
        return reject('Syncthing init failed');
      }
      resolve();
    });
  });
}

function getSyncthingId() {
  return new Promise((resolve, reject) => {
    // v2: `syncthing device-id --home <dir>` (was `--device-id` flag in v1)
    const newProcess = spawn(syncthingBin(), ['device-id', '--home', config.program.storage.syncConfigDirectory], {});

    newProcess.stdout.on('data', (data) => {
      myId = `${data}`.trim();
    });

    newProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    newProcess.on('close', (code) => {
      if (code !== 0) {
        winston.error('SyncThing: Failed to get device ID');
        return reject('Get Syncthing ID failed');
      }
      resolve();
    });
  });
}

function loadConfig() {
  xmlObj = parser.parse(fs.readFileSync(path.join(config.program.storage.syncConfigDirectory, 'config.xml'), 'utf8'));

  // convert objects to arrays
  if (typeof xmlObj.configuration.folder === 'object' && !(xmlObj.configuration.folder instanceof Array)) {
    xmlObj.configuration.folder = [xmlObj.configuration.folder];
  } else if (typeof xmlObj.configuration.folder !== 'object') {
    xmlObj.configuration.folder = [];
  }

  // convert objects to arrays
  if (typeof xmlObj.configuration.device === 'object' && !(xmlObj.configuration.device instanceof Array)) {
    xmlObj.configuration.device = [xmlObj.configuration.device];
  } else if (typeof xmlObj.configuration.device !== 'object') {
    xmlObj.configuration.device = [];
  }

  // cache paths
  xmlObj.configuration.folder.forEach(folderObj => {
    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // get UI address
  uiAddress = xmlObj.configuration.gui.address;
}

function removeFoldersFromConfig() {
  // v1 created a "default" folder; v2 doesn't. Filter remains as defense-in-depth:
  // any folder whose label doesn't match a known library gets dropped.
  xmlObj.configuration.folder = xmlObj.configuration.folder.filter(folder => {
    return !!db.getLibraryByName(folder['@_label']);
  });
}

function firstTimeConfig() {
  // we need the API to come with the GUI
  xmlObj.configuration.gui['@_enabled'] = 'true';
  xmlObj.configuration.gui.theme = 'dark';
}

function addFoldersToConfig() {
  const xmlFolderMapper = {};
  xmlObj.configuration.folder.forEach(folderObj => {
    xmlFolderMapper[folderObj['@_label']] = true;
    const lib = db.getLibraryByName(folderObj['@_label']);
    if (lib) { folderObj['@_path'] = lib.root_path; }
    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // Create new folders
  db.getAllLibraries().forEach((lib) => {
    const key = lib.name;
    const value = { root: lib.root_path };
    if (!xmlFolderMapper[key]) {
      const newId = nanoid();
      cacheObj[key] = newId;

      // v2: weakHashThresholdPct removed (rolling hash detection dropped)
      xmlObj.configuration.folder.push({
        '@_id': newId,
        '@_label': key,
        '@_path': value.root,
        '@_type': 'sendreceive',
        '@_rescanIntervalS': '3600',
        '@_fsWatcherEnabled': 'true',
        '@_fsWatcherDelayS': '10',
        '@_ignorePerms': 'false',
        '@_autoNormalize': 'true',
        filesystemType: 'basic',
        device: {
          '@_id': myId,
          '@_introducedBy': ''
        },
        minDiskFree: { '#text': 1, '@_unit': '%' },
        versioning: '',
        copiers: 0,
        pullerMaxPendingKiB: 0,
        hashers: 0,
        order: 'random',
        ignoreDelete: false,
        scanProgressIntervalS: 0,
        pullerPauseS: 0,
        maxConflicts: -1,
        disableSparseFiles: false,
        disableTempIndexes: false,
        paused: false,
        markerName: '.stfolder',
        copyOwnershipFromParent: false,
        modTimeWindowS: 0
      });
    }
  });

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
  });
  builder.build(xmlObj);
}

export function addDevice(deviceId, directories) {
  if (deviceId.length !== 63) {
    throw new Error('Device ID Incorrect Length');
  }

  // Check if already added
  let flag1 = true;
  xmlObj.configuration.device.forEach(d => {
    if (d['@_id'] === deviceId) {
      flag1 = false;
    }
  });

  if (flag1) {
    xmlObj.configuration.device.push({
      '@_id': deviceId,
      '@_name': nanoid(),
      '@_compression': 'metadata',
      '@_introducer': 'false',
      '@_skipIntroductionRemovals': 'false',
      '@_introducedBy': '',
      address: 'dynamic',
      paused: false,
      autoAcceptFolders: false,
      maxSendKbps: 0,
      maxRecvKbps: 0,
      maxRequestKiB: 0
    });
  }

  // add device to directories
  xmlObj.configuration.folder.forEach(f => {
    let flag2 = true;
    if (directories[f['@_label']]) {
      if (typeof f.device === 'object' && !(f.device instanceof Array)) {
        f.device = [f.device];
      } else if (typeof f.device !== 'object') {
        f.device = [];
      }

      f.device.forEach(d => {
        if (d['@_id'] === deviceId) {
          flag2 = false;
        }
      });

      if (flag2) {
        f.device.push({
          '@_introducedBy': '',
          '@_id': deviceId
        });
      }
    }
  });

  saveIt();
  rebootSyncThing();
}

export function addFederatedDirectory(directoryName, directoryId, folderPath, deviceId, receiveOnly = true) {
  if (deviceId.length !== 63) {
    throw new Error('Device ID Incorrect Length');
  }

  let flag = true;
  xmlObj.configuration.folder.forEach(f => {
    if (f['@_id'] === directoryId || f['@_path'] === folderPath) {
      flag = false;
    }
  });

  if (!flag) {
    return;
  }

  // v2: weakHashThresholdPct removed
  // receiveOnly=true: this peer pulls only, doesn't push changes back (default for desktop sync)
  // receiveOnly=false: bidirectional sync
  xmlObj.configuration.folder.push({
    '@_id': directoryId,
    '@_label': directoryName,
    '@_path': folderPath,
    '@_type': receiveOnly ? 'receiveonly' : 'sendreceive',
    '@_rescanIntervalS': '3600',
    '@_fsWatcherEnabled': 'true',
    '@_fsWatcherDelayS': '10',
    '@_ignorePerms': 'false',
    '@_autoNormalize': 'true',
    filesystemType: 'basic',
    device: [{
      '@_id': myId,
      '@_introducedBy': ''
    },
    {
      '@_id': deviceId,
      '@_introducedBy': ''
    }],
    minDiskFree: { '#text': 1, '@_unit': '%' },
    versioning: '',
    copiers: 0,
    pullerMaxPendingKiB: 0,
    hashers: 0,
    order: 'random',
    ignoreDelete: false,
    scanProgressIntervalS: 0,
    pullerPauseS: 0,
    maxConflicts: -1,
    disableSparseFiles: false,
    disableTempIndexes: false,
    paused: false,
    markerName: '.stfolder',
    copyOwnershipFromParent: false,
    modTimeWindowS: 0
  });

  saveIt();
  rebootSyncThing();
}

function saveIt() {
  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
  });
  fs.writeFileSync(
    path.join(config.program.storage.syncConfigDirectory, 'config.xml'),
    builder.build(xmlObj),
    'utf8');
}

async function rebootSyncThing() {
  try {
    const url = new URL(`https://${xmlObj.configuration.gui.address}/rest/system/restart`);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'X-API-Key': xmlObj.configuration.gui.apikey },
        rejectUnauthorized: false
      }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Syncthing restart returned ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.end();
    });
  } catch (err) {
    winston.error('Syncthing Reboot Failed', { stack: err });
  }
}

function bootProgram() {
  if (spawnedProcess) {
    winston.warn('Sync: SyncThing already setup');
    return;
  }

  try {
    // v2: `serve` is the default subcommand; being explicit is v2-idiomatic and future-proof
    spawnedProcess = spawn(syncthingBin(), ['serve', '--home', config.program.storage.syncConfigDirectory, '--no-browser'], {});

    spawnedProcess.stdout.on('data', (data) => {
      winston.info(`SYNCTHING: ${`${data}`.trim()}`);
    });

    spawnedProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    spawnedProcess.on('close', (_code) => {
      if (preventRebootFlag === false) {
        winston.info('Syncthing failed. Attempting to reboot');
        setTimeout(() => {
          winston.info('Sync: Rebooting SyncThing');
          spawnedProcess = undefined;
          bootProgram();
        }, 4000);
      } else {
        winston.info('Syncthing Turned Off');
        preventRebootFlag = false;
      }
    });

    winston.info('Sync: SyncThing Booted');
  } catch (err) {
    winston.error(`Failed to boot SyncThing`);
    winston.error(err.message);
    return;
  }
}
