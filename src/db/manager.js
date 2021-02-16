const path = require('path');
const loki = require('lokijs');
const winston = require('winston');
const config = require('../state/config');

const userDataDbName = 'user-data.loki-v1.db';
const filesDbName = 'files.loki-v2.db';

// Loki Collections
let filesDB;
let userDataDb;

let fileCollection;
let playlistCollection;
let userMetadataCollection;

exports.saveUserDB = () => {
  userDataDb.saveDatabase(err => {
    if (err) { winston.error('User DB Save Error', { stack: err }); }
  });
}

exports.saveFilesDB = () => {
  filesDB.saveDatabase(err => {
    if (err) { winston.error('Files DB Save Error', { stack: err }); }
  });
}

exports.getFileDbName = () => {
  return filesDbName;
}

exports.getFileCollection = () => {
  return fileCollection;
}

exports.getPlaylistCollection = () => {
  return playlistCollection;
}

exports.getUserMetadataCollection = () => {
  return userMetadataCollection;
}

function loadDB() {
  filesDB.loadDatabase({}, err => {
    if (err) {
      winston.error('Files DB Load Error', { stack: err });
      return;
    }

    // Get files collection
    fileCollection = filesDB.getCollection('files');
  });

  userDataDb.loadDatabase({}, err => {
    if (err) {
      winston.error('Playlists DB Load Error', { stack: err });
      return;
    }

    // Initialize playlists collection
    playlistCollection = userDataDb.getCollection('playlists');
    if (!playlistCollection) {
      playlistCollection = userDataDb.addCollection("playlists");
    }

    // Initialize user metadata collection (for song ratings, playback stats, etc)
    userMetadataCollection = userDataDb.getCollection('user-metadata');
    if (!userMetadataCollection) {
      userMetadataCollection = userDataDb.addCollection("user-metadata");
    }
  });
}

exports.loadDB = () => {
  loadDB();
}

exports.initLoki = () => {
  filesDB = new loki(path.join(config.program.storage.dbDirectory, filesDbName));
  userDataDb = new loki(path.join(config.program.storage.dbDirectory, userDataDbName));
  loadDB();
}