const path = require('path');
const config = require('../state/config');

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
  return {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };
}
