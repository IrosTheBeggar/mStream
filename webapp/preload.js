// Preload script for the Desktop Player.
// Exposes a narrow, IPC-backed API to the renderer via contextBridge.
// Renderer never touches Node or Electron directly — everything flows through
// the handlers registered in main/ipc-handlers.js.

const { contextBridge, ipcRenderer } = require('electron');

const progressListeners = new Set();
ipcRenderer.on('sync:progress', (_event, payload) => {
  for (const cb of progressListeners) {
    try { cb(payload); } catch { /* renderer callback errored; swallow */ }
  }
});

contextBridge.exposeInMainWorld('mstreamElectron', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('sync:pick-folder', defaultPath),

  getSyncConfig: () => ipcRenderer.invoke('sync:get-config'),
  setSyncConfig: (cfg) => ipcRenderer.invoke('sync:set-config', cfg),

  startSync: (opts) => ipcRenderer.invoke('sync:start', opts),
  stopSync: () => ipcRenderer.invoke('sync:stop'),
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncFiles: (opts) => ipcRenderer.invoke('sync:files', opts),

  onSyncProgress: (cb) => {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },

  safeStorage: {
    isAvailable: () => ipcRenderer.invoke('safe-storage:available'),
    get: (key) => ipcRenderer.invoke('safe-storage:get', key),
    set: (key, value) => ipcRenderer.invoke('safe-storage:set', key, value),
    remove: (key) => ipcRenderer.invoke('safe-storage:remove', key),
  },
});
