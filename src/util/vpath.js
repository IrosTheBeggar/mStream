const path = require('path');
const config = require('../state/config');
const winston = require('winston');

exports.getVPathInfo = (url, user) => {
  if (!config.program) { throw new Error('Not Configured'); }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Get vpath from url
  const vpath = url.split('/').shift();
  // Verify user has access to this vpath
  if (user && !user.vpaths.includes(vpath)) {
    throw new Error(`User does not have access to path ${vpath}`);
  }
  
  const baseDir = config.program.folders[vpath].root;
  const fullPath = path.join(baseDir, path.relative(vpath, url));

  // Do not allow browsing outside the directory
  if (fullPath.substring(0, baseDir.length) !== baseDir) {
    winston.warn(`user '${user.username}' attempted to access a directory they don't have access to: ${fullPath}`)
    throw new Error('Access to directory not allowed');
  }

  return {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: fullPath
  };
}
