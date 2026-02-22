import path from 'path';
import * as config from '../state/config.js';

export function getVPathInfo(url, user) {
  if (!config.program) { throw new Error('Not Configured'); }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Normalize the path to prevent users from using ../ to access files outside of their vpath
  url = path.normalize(url);

  // Get vpath from url
  const vpath = url.split(path.sep).shift();
  // Verify user has access to this vpath
  if (user && !user.vpaths.includes(vpath)) {
    throw new Error(`User does not have access to path ${vpath}`);
  }

  const baseDir = config.program.folders[vpath].root;
  return {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };
}
