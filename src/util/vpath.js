import path from 'path';
import * as config from '../state/config.js';

export function getVPathInfo(url, user) {
  if (!config.program) { throw new Error('Not Configured'); }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Get vpath from url — always split on '/' (URLs are never OS-path-separated)
  const vpath = url.split('/').shift();
  // Verify user has access to this vpath
  if (user && !user.vpaths.includes(vpath)) {
    throw new Error(`User does not have access to path ${vpath}`);
  }

  const baseDir = config.program.folders[vpath].root;
  const result = {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };

  // Ensure the resolved path stays within the vpath root (CWE-22 / path traversal).
  // path.normalize() alone is insufficient on Windows with backslash tricks; an
  // explicit prefix check after path.join() is the safe approach.
  // Use a trailing separator so '/media/music-extra' can't pass a '/media/music' check.
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (result.fullPath !== baseDir && !result.fullPath.startsWith(normalizedBase)) {
    throw new Error(`Access to path not allowed: ${result.fullPath}`);
  }

  return result;
}
