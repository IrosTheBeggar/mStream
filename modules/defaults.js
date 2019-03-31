// Sets up default values for 
const fs = require('fs');
const path = require('path');

exports.setup = function (program) {
  program.filesDbName = 'files.loki-v1.db'

  if (!program.storage) {
    program.storage = {};
  }
  // Album Art Directory
  if (!program.storage.albumArtDirectory) {
    program.storage.albumArtDirectory = path.join(__dirname, '../image-cache');
  }
  // DB Directory
  if (!program.storage.dbDirectory) {
    program.storage.dbDirectory = path.join(__dirname, '../save/db');
  }
  // Logs Directory
  if (!program.storage.logsDirectory) {
    program.storage.logsDirectory = path.join(__dirname, '../save/logs');
  }
  // Webapp
  if (!program.webAppDirectory) {
    program.webAppDirectory = path.join(__dirname, '../public')
  }
  // Port
  if (!program.port) {
    program.port = 3000;
  }

  if(program.ddns && !program.ddns.iniFile) {
    program.ddns.iniFile = path.join(__dirname, `../frp/frps.ini`);
  }

  // Setup Secret for JWT
  try {
    // If user entered a filepath
    if (fs.statSync(program.secret).isFile()) {
      program.secret = fs.readFileSync(program.secret, 'utf8');
    }
  } catch (error) {
    if (program.secret) {
      // just use secret as is
      program.secret = String(program.secret);
    } else {
      // If no secret was given, generate one
      require('crypto').randomBytes(48, (err, buffer) => {
        program.secret = buffer.toString('hex');
      });
    }
  }

  // This is a convenience function. It gets the vPath from any url string
  program.getVPathInfo = function (url) {
    // TODO: Verify user has access to this vpath

    // remove leading slashes
    if (url.charAt(0) === '/') {
      url = url.substr(1);
    }

    const fileArray = url.split('/');
    const vpath = fileArray.shift();

    // Make sure the path exists
    if (!program.folders[vpath]) {
      return false;
    }
    const baseDir = program.folders[vpath].root;
    let newPath = '';
    for (const dir of fileArray) {
      if (dir === '') {
        continue;
      }
      newPath += dir + '/';
    }

    // TODO: There's gotta be a better way to construct the relative path
    if (newPath.charAt(newPath.length - 1) === '/') {
      newPath = newPath.slice(0, - 1);
    }

    return {
      vpath: vpath,
      basePath: baseDir,
      relativePath: newPath,
      fullPath: path.join(baseDir, newPath)
    };
  }

  return program;
}