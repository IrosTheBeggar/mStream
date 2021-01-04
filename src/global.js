const path = require('path');

/*
  This file contains some global state management functions
*/

exports.setup = (config) => {
  exports.program = config;
}

exports.setConfigFile = (configFile) => {
  exports.configFile = configFile;
}

exports.getVPathInfo = (url, user) => {
  if (!this.program) { throw 'Not Configured'; }

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
  
  const baseDir = this.program.folders[vpath].root;
  return {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };
}

const killThese = [];

exports.addToKillQueue = (func) => {
  killThese.push(func);
}

process.on('exit', (code) => {
  // Kill them all
  killThese.forEach(func => {
    if (typeof func === 'function') {
      try {
        func();
      }catch (err) {
        console.log('Error: Failed to run kill function');
      }
    }
  });
});