// Desktop Player helper that routes download actions through the sync engine
// when the user has chosen "Basic - Manual Sync" mode. In any other mode
// (including browser contexts) it falls through to the original download
// behavior so nothing changes for those users.
//
// Usage at a call site:
//   const parsed = mstreamParseRawFilePath(song.rawFilePath);
//   const fallback = () => { /* existing download code */ };
//   if (window.mstreamDownloadOrSync && parsed) {
//     window.mstreamDownloadOrSync([parsed], fallback);
//   } else {
//     fallback();
//   }

(function () {
  // Split "<vpath>/<rest>" into { vpath, relPath }. rawFilePath uses forward
  // slashes on all platforms (the server normalizes in vpath.js).
  function parseRawFilePath(rawFilePath) {
    if (!rawFilePath || typeof rawFilePath !== 'string') { return null; }
    const normalized = rawFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const idx = normalized.indexOf('/');
    if (idx <= 0) { return null; }
    return { vpath: normalized.slice(0, idx), relPath: normalized.slice(idx + 1) };
  }

  function toast(kind, title, timeout) {
    if (typeof iziToast === 'undefined') { return; }
    iziToast[kind]({ title, position: 'topCenter', timeout: timeout || 2500 });
  }

  // Lightweight check for call sites that need to branch *before* doing work
  // (e.g. fetching an m3u body server-side). Returns false in browser contexts
  // and in any non-manual sync mode.
  async function isManualMode() {
    if (!window.mstreamElectron) { return false; }
    try {
      const cfg = await window.mstreamElectron.getSyncConfig();
      return !!(cfg && cfg.method === 'basic-manual');
    } catch { return false; }
  }

  async function downloadOrSync(fileList, fallbackFn) {
    const fallback = typeof fallbackFn === 'function' ? fallbackFn : () => {};

    // Not in Electron → always fall through
    if (!window.mstreamElectron) { return fallback(); }

    let cfg;
    try { cfg = await window.mstreamElectron.getSyncConfig(); }
    catch { return fallback(); }

    // Not in manual mode → server download as usual
    if (!cfg || cfg.method !== 'basic-manual') { return fallback(); }

    if (!cfg.localFolder) {
      toast('error', 'No sync folder configured — open Sync Library to set one', 4000);
      return;
    }

    const server = (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.currentServer) || {};
    if (!server.host || !server.token) {
      toast('error', 'Not logged in', 3000);
      return;
    }

    const cleanFiles = (fileList || []).filter(f => f && f.vpath && f.relPath);
    if (cleanFiles.length === 0) {
      toast('error', 'Nothing to sync', 2000);
      return;
    }

    toast('info', cleanFiles.length === 1
      ? 'Syncing file to local folder…'
      : `Syncing ${cleanFiles.length} files to local folder…`, 1800);

    try {
      await window.mstreamElectron.syncFiles({
        serverUrl: server.host,
        token: server.token,
        localFolder: cfg.localFolder,
        files: cleanFiles,
      });
      toast('success', cleanFiles.length === 1
        ? 'Saved to local folder'
        : `Synced ${cleanFiles.length} files`, 2500);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      toast('error', 'Sync failed: ' + msg, 4000);
    }
  }

  window.mstreamParseRawFilePath = parseRawFilePath;
  window.mstreamDownloadOrSync = downloadOrSync;
  window.mstreamIsManualMode = isManualMode;
})();
