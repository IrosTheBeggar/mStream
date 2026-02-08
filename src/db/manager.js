import path from 'path';
import loki from 'lokijs';
import winston from 'winston';
import * as config from '../state/config.js';

const userDataDbName = 'user-data.loki-v1.db';
const filesDbName = 'files.loki-v3.db';
const shareDbName = 'shared.loki-v1.db';

// Loki Collections
let filesDB;
let userDataDb;
let shareDB;

let fileCollection;
let playlistCollection;
let userMetadataCollection;
let shareCollection;

// Timer for clearing shared playlists
let clearShared;

export function saveUserDB() {
  userDataDb.saveDatabase(err => {
    if (err) { winston.error('User DB Save Error', { stack: err }); }
  });
}

export function saveFilesDB() {
  filesDB.saveDatabase(err => {
    if (err) { winston.error('Files DB Save Error', { stack: err }); }
    winston.info('Metadata DB Saved')
  });
}

export function saveShareDB() {
  shareDB.saveDatabase(err => {
    if (err) { winston.error('Share DB Save Error', { stack: err }); }
  });
}

export function getFileDbName() {
  return filesDbName;
}

export function getFileCollection() {
  return fileCollection;
}

export function getPlaylistCollection() {
  return playlistCollection;
}

export function getUserMetadataCollection() {
  return userMetadataCollection;
}

export function getShareCollection() {
  return shareCollection;
}

export function initLoki() {
  shareDB = new loki(path.join(config.program.storage.dbDirectory, shareDbName));
  filesDB = new loki(path.join(config.program.storage.dbDirectory, filesDbName));
  userDataDb = new loki(path.join(config.program.storage.dbDirectory, userDataDbName));

  filesDB.loadDatabase({}, err => {
    if (err) {
      winston.error('Files DB Load Error', { stack: err });
      return;
    }

    // Get files collection
    fileCollection = filesDB.getCollection('files');
    if (!fileCollection) {
      fileCollection = filesDB.addCollection("files");
    }
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

  shareDB.loadDatabase({}, err => {
    shareCollection = shareDB.getCollection('playlists');
    if (shareCollection === null) {
      shareCollection = shareDB.addCollection("playlists");
    }
  });

  if (clearShared) {
    clearInterval(clearShared);
    clearShared = undefined;
  }

  if (config.program.db.clearSharedInterval) {
    clearShared = setInterval(() => {
      try {
        getShareCollection().findAndRemove({ 'expires': { '$lt': Math.floor(Date.now() / 1000) } });
        saveShareDB();
        winston.info('Successfully cleared shared playlists');
      }catch (err) {
        winston.error('Failed to clear expired saved playlists', { stack: err })
      }
    }, config.program.db.clearSharedInterval * 60 * 60 * 1000);
  }
}
