const fs = require('fs');

exports.setup = function (loadJson) {
  var errorArray = [];

  if (!loadJson.scanOptions) {
    loadJson.scanOptions = {};
  }

  if (!loadJson.storage) {
    loadJson.storage = {};
  }

  if (loadJson.scanOptions.scanInterval === false) {
    loadJson.scanOptions.scanInterval = 0;
  }

  loadJson.scanOptions.scanInterval = Number(loadJson.scanOptions.scanInterval);
  if (typeof loadJson.scanOptions.scanInterval !== 'number' || isNaN(loadJson.scanOptions.scanInterval) || loadJson.scanOptions.scanInterval < 0) {
    loadJson.scanOptions.scanInterval = 24;
  }

  loadJson.scanOptions.saveInterval = Number(loadJson.scanOptions.saveInterval);
  if (typeof loadJson.scanOptions.saveInterval !== 'number' || isNaN(loadJson.scanOptions.saveInterval) || loadJson.scanOptions.saveInterval < 0) {
    loadJson.scanOptions.saveInterval = 250;
  }

  loadJson.scanOptions.pause = Number(loadJson.scanOptions.pause);
  if (typeof loadJson.scanOptions.pause !== 'number' || isNaN(loadJson.scanOptions.pause) || loadJson.scanOptions.pause < 0) {
    loadJson.scanOptions.pause = 0;
  }

  if (!loadJson.folders || typeof loadJson.folders !== 'object') {
    loadJson.folders = {
      'media': { root: process.cwd() }
    }
  }

  for (let folder in loadJson.folders) {
    if (typeof loadJson.folders[folder] === 'string') {
      let folderString = loadJson.folders[folder];
      loadJson.folders[folder] = {
        root: folderString
      };
    }

    // Verify path is real
    if (!loadJson.folders[folder].root || !fs.statSync(loadJson.folders[folder].root).isDirectory()) {
      errorArray.push(loadJson.folders[folder].root + ' is not a real path');
    }
  }

  if (loadJson.users && typeof loadJson.users !== 'object') {
    errorArray.push('Users need to be an object');
    loadJson.error = errorArray;
    return loadJson;
  }

  for (let user in loadJson.users) {
    if (typeof loadJson.users[user].vpaths === 'string') {
      loadJson.users[user].vpaths = [loadJson.users[user].vpaths];
    }
  }

  if (errorArray.length > 0) {
    loadJson.error = errorArray;
  }

  // Export JSON
  return loadJson;
}
