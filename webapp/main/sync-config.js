// Persists the Desktop Player's sync configuration as JSON in userData.
// Auth tokens are NOT stored here — they flow through safeStorage separately.
//
// Maintains an in-memory cache so sync-hot paths (URL interceptor) can read
// config without awaiting a file read on every request.

const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  serverUrl: '',
  method: 'basic',
  localFolder: '',
  vpaths: [],
  schedule: 0,
};

let cached = null;

function configPath() {
  return path.join(app.getPath('userData'), 'sync-config.json');
}

async function load() {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    cached = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    if (e.code !== 'ENOENT') { throw e; }
    cached = { ...DEFAULTS };
  }
  return cached;
}

async function save(cfg) {
  const merged = { ...DEFAULTS, ...cfg };
  await fsp.writeFile(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  cached = merged;
  return merged;
}

// Synchronous read of the last-known config. Returns null if load() hasn't
// been called yet. Safe to use in hot paths like webRequest handlers.
function peek() {
  return cached;
}

module.exports = { load, save, peek, DEFAULTS };
