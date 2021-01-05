const path = require('path');
const globals = require('../global');

exports.getVPathInfo = (url, user) => {
  if (!globals.program) { throw 'Not Configured'; }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Get vpath from url
  const vpath = url.split('/').shift();
  // Verify user has access to this vpath
  if (user && !user.vpaths.includes(vpath)) {
    return false;
  }
  
  const baseDir = globals.program.folders[vpath].root;
  return {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };
}
