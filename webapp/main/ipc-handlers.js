// IPC handlers for the Desktop Player preload bridge.
// Registered once at startup; calls flow renderer → preload → ipcMain → here.

const fsp = require('fs/promises');
const path = require('path');
const { ipcMain, dialog, app, safeStorage, BrowserWindow } = require('electron');
const config = require('./sync-config');
const engine = require('./sync-engine');
const scheduler = require('./sync-scheduler');

// ── Folder picker ───────────────────────────────────────────────────────────

ipcMain.handle('sync:pick-folder', async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts = {
    properties: ['openDirectory', 'createDirectory'],
  };
  if (defaultPath) { opts.defaultPath = defaultPath; }
  const res = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled || res.filePaths.length === 0) { return null; }
  return res.filePaths[0];
});

// ── Sync config ─────────────────────────────────────────────────────────────

ipcMain.handle('sync:get-config', () => config.load());
ipcMain.handle('sync:set-config', async (_event, cfg) => {
  const saved = await config.save(cfg);
  // Pick up new schedule/method for the background refresher
  scheduler.reschedule();
  return saved;
});

// ── Sync engine ─────────────────────────────────────────────────────────────

ipcMain.handle('sync:start', async (event, opts) => {
  const cfg = await config.load();
  const finalOpts = {
    serverUrl: (opts && opts.serverUrl) || cfg.serverUrl,
    token: opts && opts.token,
    localFolder: (opts && opts.localFolder) || cfg.localFolder,
    vpaths: (opts && opts.vpaths) || cfg.vpaths,
    snapshotOnly: Boolean(opts && opts.snapshotOnly),
    onProgress: (status) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sync:progress', status);
      }
    },
  };
  // Fire and forget — progress/errors surface via events + getStatus()
  engine.start(finalOpts).catch(() => { /* state already captured */ });
  return engine.getStatus();
});

ipcMain.handle('sync:stop', () => {
  engine.stop();
  return engine.getStatus();
});

ipcMain.handle('sync:files', async (event, opts) => {
  const cfg = await config.load();
  const finalOpts = {
    serverUrl: (opts && opts.serverUrl) || cfg.serverUrl,
    token: opts && opts.token,
    localFolder: (opts && opts.localFolder) || cfg.localFolder,
    files: opts && opts.files,
    onProgress: (status) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sync:progress', status);
      }
    },
  };
  // Awaited — the renderer wants to know when the batch is done so it can
  // show a final toast. Errors propagate back through the IPC channel.
  await engine.syncFiles(finalOpts);
  return engine.getStatus();
});

ipcMain.handle('sync:status', () => engine.getStatus());

// ── safeStorage-backed key/value store ──────────────────────────────────────
// Tiny JSON-on-disk store encrypted with the OS keychain (via safeStorage).
// Used to persist the JWT with XSS-resistant at-rest encryption.

function storePath() {
  return path.join(app.getPath('userData'), 'safe-store.json');
}

async function loadStore() {
  try {
    const raw = await fsp.readFile(storePath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') { return {}; }
    throw e;
  }
}

async function saveStore(store) {
  await fsp.writeFile(storePath(), JSON.stringify(store), 'utf8');
}

ipcMain.handle('safe-storage:available', () => safeStorage.isEncryptionAvailable());

ipcMain.handle('safe-storage:get', async (_event, key) => {
  if (!safeStorage.isEncryptionAvailable()) { return null; }
  const store = await loadStore();
  if (!store[key]) { return null; }
  try {
    return safeStorage.decryptString(Buffer.from(store[key], 'base64'));
  } catch {
    return null;
  }
});

ipcMain.handle('safe-storage:set', async (_event, key, value) => {
  if (!safeStorage.isEncryptionAvailable()) { return false; }
  const store = await loadStore();
  store[key] = safeStorage.encryptString(String(value)).toString('base64');
  await saveStore(store);
  return true;
});

ipcMain.handle('safe-storage:remove', async (_event, key) => {
  const store = await loadStore();
  if (key in store) {
    delete store[key];
    await saveStore(store);
  }
  return true;
});
