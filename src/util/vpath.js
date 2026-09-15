import path from 'path';
import * as db from '../db/manager.js';
import WebError from './web-error.js';

export function getVPathInfo(url, user) {
  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Normalize the path to prevent users from using ../ to access files outside of their vpath
  url = path.normalize(url);

  // Get vpath from url
  const vpathName = url.split(path.sep).shift();

  // The two rejections below are the CALLER's path, not a server fault, so
  // they are WebErrors: the terminal handler answers with status + message
  // and logs a warn-level rejection. As plain Errors they surfaced as an
  // unhandled 500 "Server Error" (error level, stack) on every route that
  // resolves a virtual path without its own try/catch — file-explorer,
  // download, album art, scrobbling, ytdl, …. Both are 404, not 403, on
  // purpose: the access check runs first, so a signed-in caller gets the
  // same answer for a library they lack and for one that does not exist,
  // and cannot tell the two apart — the choice the /media/:vpath gate in
  // server.js and the transcode/discovery routes already make. Message
  // texts are unchanged: torrent.js surfaces err.message to its UI. The
  // path-escape throw further down stays a plain Error — path.normalize
  // makes it unreachable, so if it ever fires it IS a bug worth a stack.
  if (user && user.vpaths && !user.vpaths.includes(vpathName)) {
    throw new WebError(`User does not have access to path ${vpathName}`, 404);
  }

  const library = db.getLibraryByName(vpathName);
  if (!library) {
    throw new WebError(`Library '${vpathName}' not found`, 404);
  }

  const baseDir = library.root_path;
  const relPath = path.relative(vpathName, url).replace(/\\/g, '/');
  const fullPath = path.join(baseDir, relPath);

  // Final safety check — resolved path must stay within the library root.
  // path.normalize above should prevent this, but defense-in-depth.
  const resolvedFull = path.resolve(fullPath);
  const resolvedBase = path.resolve(baseDir);
  if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path escapes library root');
  }

  return {
    vpath: vpathName,
    basePath: baseDir,
    relativePath: relPath,
    fullPath: fullPath
  };
}
