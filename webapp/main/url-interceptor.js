// Intercepts remote /media/<vpath>/<path> requests from the renderer and
// redirects them to file:// URLs when a synced local copy exists. Lets the
// existing webapp play offline without any renderer code changes.
//
// Wired into the default session's webRequest in webapp/index.js.

const fs = require('fs');
const path = require('path');
const config = require('./sync-config');

// Rewrite a local path into a file:// URL Electron/Chromium will load.
// Must start with `file:///` (three slashes — empty authority).
function toFileUrl(localPath) {
  const normalized = localPath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  return 'file:///' + encoded.replace(/^\//, '');
}

// Parse a /media/<vpath>/<path> URL into { vpath, relPath }. Returns null
// for URLs we shouldn't touch.
function parseMediaUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!parsed.pathname.startsWith('/media/')) { return null; }
  const rest = parsed.pathname.slice('/media/'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx < 0) { return null; }
  try {
    const vpath = decodeURIComponent(rest.slice(0, slashIdx));
    const relPath = rest.slice(slashIdx + 1)
      .split('/').map(decodeURIComponent).join('/');
    return { vpath, relPath };
  } catch {
    return null;
  }
}

function install(session) {
  session.webRequest.onBeforeRequest(
    { urls: ['*://*/media/*'] },
    (details, callback) => {
      const cfg = config.peek();
      if (!cfg || !cfg.localFolder || !Array.isArray(cfg.vpaths) || cfg.vpaths.length === 0) {
        return callback({});
      }

      const parsed = parseMediaUrl(details.url);
      if (!parsed || !cfg.vpaths.includes(parsed.vpath)) {
        return callback({});
      }

      const localPath = path.join(cfg.localFolder, parsed.vpath, parsed.relPath);
      fs.access(localPath, fs.constants.R_OK, (err) => {
        if (err) { return callback({}); }
        callback({ redirectURL: toFileUrl(localPath) });
      });
    }
  );
}

module.exports = { install };
