/**
 * Shared resolver for DLNA `/media/<library>/<...path>` URLs.
 *
 * Both the separate-port media server (dlna-server.js) and the time-seek
 * middleware (time-seek.js) turn a request path into an absolute on-disk file
 * path. That logic is security-sensitive — it must keep the resolved path
 * inside the library root so a crafted `..` segment can't escape — so it lives
 * in one place rather than being copy-pasted (and drifting) between callers.
 */

import path from 'node:path';
import * as db from '../db/manager.js';

/**
 * Resolve an Express `req.path` of the form `/<library>/<...file>` to an
 * absolute on-disk path, enforcing that it stays within the library root.
 *
 * @param {string} reqPath  e.g. `/MyLibrary/Artist/Album/Song.mp3`
 * @returns {{ok: true, lib: object, resolved: string, fileParts: string[], relPath: string}
 *          | {ok: false, status: number}}
 *   On success `resolved` is guaranteed to sit within `lib.root_path`, and
 *   `relPath` is the library-relative, forward-slash path used as the DB key.
 *   On failure `status` is the HTTP status the caller should return:
 *     404 — path too short, or no library by that name
 *     400 — malformed percent-encoding in the URL
 *     403 — path-traversal attempt (resolved outside the library root)
 */
export function resolveLibraryMediaPath(reqPath) {
  const parts = reqPath.split('/').filter(Boolean);
  if (parts.length < 2) { return { ok: false, status: 404 }; }

  let libname, fileParts;
  try {
    libname = decodeURIComponent(parts[0]);
    fileParts = parts.slice(1).map(p => decodeURIComponent(p));
  } catch (_) {
    return { ok: false, status: 400 };
  }

  const lib = db.getAllLibraries().find(l => l.name === libname);
  if (!lib) { return { ok: false, status: 404 }; }

  const resolved = path.resolve(path.join(lib.root_path, ...fileParts));
  const rootResolved = path.resolve(lib.root_path);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return { ok: false, status: 403 };
  }

  return { ok: true, lib, resolved, fileParts, relPath: fileParts.join('/') };
}
