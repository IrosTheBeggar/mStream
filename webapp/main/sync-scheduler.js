// Background scheduler for automatic snapshot refresh.
//
// Runs in the Electron main process. Reads the sync config on demand and
// triggers snapshot-only refreshes on the interval the user picked in the
// "Check for updates" dropdown. Only active for `basic-manual` mode; `basic`
// mode would re-download every track on each tick, which we don't want to
// do without explicit user action.
//
// Token is read from safeStorage at each tick — if the user isn't logged in
// (no token saved), the tick is a no-op.

const { safeStorage } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const config = require('./sync-config');
const engine = require('./sync-engine');

let timer = null;

async function readToken() {
  if (!safeStorage.isEncryptionAvailable()) { return null; }
  try {
    const storePath = path.join(app.getPath('userData'), 'safe-store.json');
    const raw = await fsp.readFile(storePath, 'utf8');
    const store = JSON.parse(raw);
    if (!store.token) { return null; }
    return safeStorage.decryptString(Buffer.from(store.token, 'base64'));
  } catch {
    return null;
  }
}

async function tick() {
  const cfg = config.peek() || await config.load();
  if (cfg.method !== 'basic-manual') { return; }
  if (!cfg.serverUrl || !cfg.localFolder) { return; }

  const token = await readToken();
  if (!token) { return; }

  try {
    await engine.start({
      serverUrl: cfg.serverUrl,
      token,
      localFolder: cfg.localFolder,
      vpaths: [],
      snapshotOnly: true,
    });
  } catch (err) {
    // Engine already captured state; log but don't crash the scheduler
    console.warn('[sync-scheduler] snapshot refresh failed:', err.message);
  }
}

function start() {
  stop();
  const cfg = config.peek();
  if (!cfg || cfg.method !== 'basic-manual') { return; }
  const minutes = Number(cfg.schedule) || 0;
  if (minutes <= 0) { return; }

  const intervalMs = minutes * 60 * 1000;
  timer = setInterval(tick, intervalMs);
  // Unref so the scheduler never blocks process exit
  if (timer.unref) { timer.unref(); }

  // Kick an initial refresh shortly after boot (5s grace) so users get fresh
  // data without waiting a full interval.
  setTimeout(tick, 5000).unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Call after config changes to pick up new schedule/method
function reschedule() {
  start();
}

module.exports = { start, stop, reschedule, tick };
