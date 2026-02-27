import path from 'path';
import loki from 'lokijs';
import winston from 'winston';
import escapeStringRegexp from 'escape-string-regexp';

const userDataDbName = 'user-data.loki-v1.db';
const filesDbName = 'files.loki-v3.db';
const shareDbName = 'shared.loki-v1.db';

let filesDB;
let userDataDb;
let shareDB;

let fileCollection;
let playlistCollection;
let userMetadataCollection;
let shareCollection;

export function init(dbDirectory) {
  return new Promise((resolve) => {
    shareDB = new loki(path.join(dbDirectory, shareDbName));
    filesDB = new loki(path.join(dbDirectory, filesDbName));
    userDataDb = new loki(path.join(dbDirectory, userDataDbName));

    let loaded = 0;
    const checkDone = () => { if (++loaded === 3) { resolve(); } };

    filesDB.loadDatabase({}, err => {
      if (err) {
        winston.error('Files DB Load Error', { stack: err });
      }
      fileCollection = filesDB.getCollection('files');
      if (!fileCollection) {
        fileCollection = filesDB.addCollection('files');
      }
      checkDone();
    });

    userDataDb.loadDatabase({}, err => {
      if (err) {
        winston.error('Playlists DB Load Error', { stack: err });
      }
      playlistCollection = userDataDb.getCollection('playlists');
      if (!playlistCollection) {
        playlistCollection = userDataDb.addCollection('playlists');
      }
      userMetadataCollection = userDataDb.getCollection('user-metadata');
      if (!userMetadataCollection) {
        userMetadataCollection = userDataDb.addCollection('user-metadata');
      }
      checkDone();
    });

    shareDB.loadDatabase({}, _err => {
      shareCollection = shareDB.getCollection('playlists');
      if (shareCollection === null) {
        shareCollection = shareDB.addCollection('playlists');
      }
      checkDone();
    });
  });
}

export function close() {}

// Save operations
export function saveFilesDB() {
  filesDB.saveDatabase(err => {
    if (err) { winston.error('Files DB Save Error', { stack: err }); }
    winston.info('Metadata DB Saved');
  });
}

export function saveUserDB() {
  userDataDb.saveDatabase(err => {
    if (err) { winston.error('User DB Save Error', { stack: err }); }
  });
}

export function saveShareDB() {
  shareDB.saveDatabase(err => {
    if (err) { winston.error('Share DB Save Error', { stack: err }); }
  });
}

// Helper: map $loki to id in returned objects
function mapId(obj) {
  if (!obj) { return obj; }
  const result = { ...obj, id: obj.$loki };
  return result;
}

// Helper for vpath OR clause
function renderOrClause(vpaths, ignoreVPaths) {
  if (vpaths.length === 1) {
    return { 'vpath': { '$eq': vpaths[0] } };
  }

  const returnThis = { '$or': [] };
  for (const vpathItem of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(vpathItem)) {
      continue;
    }
    returnThis['$or'].push({ 'vpath': { '$eq': vpathItem } });
  }
  return returnThis;
}

// File Operations
export function findFileByPath(filepath, vpath) {
  if (!fileCollection) { return null; }
  const result = fileCollection.findOne({ '$and': [{ 'filepath': filepath }, { 'vpath': vpath }] });
  return mapId(result);
}

export function updateFileScanId(file, scanId) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': file.filepath }, { 'vpath': file.vpath }] });
  if (dbFile) {
    dbFile.sID = scanId;
    fileCollection.update(dbFile);
  }
}

export function insertFile(fileData) {
  const result = fileCollection.insert(fileData);
  return mapId(result);
}

export function removeFileByPath(filepath, vpath) {
  fileCollection.findAndRemove({ '$and': [
    { 'filepath': { '$eq': filepath } },
    { 'vpath': { '$eq': vpath } }
  ]});
}

export function removeStaleFiles(vpath, scanId) {
  fileCollection.findAndRemove({ '$and': [
    { 'vpath': { '$eq': vpath } },
    { 'sID': { '$ne': scanId } }
  ]});
}

export function removeFilesByVpath(vpath) {
  fileCollection.findAndRemove({ 'vpath': { '$eq': vpath } });
}

export function countFilesByVpath(vpath) {
  if (!fileCollection) { return 0; }
  return fileCollection.count({ 'vpath': vpath });
}

// Metadata Queries
const mapFunDefault = (left, right) => {
  return {
    artist: left.artist,
    album: left.album,
    hash: left.hash,
    track: left.track,
    title: left.title,
    year: left.year,
    aaFile: left.aaFile,
    filepath: left.filepath,
    rating: right.rating,
    "replaygain-track-db": left.replaygainTrackDb,
    vpath: left.vpath
  };
};

const rightFunDefault = (rightData) => {
  return rightData.hash + '-' + rightData.user;
};

export function getFileWithMetadata(filepath, vpath, username) {
  if (!fileCollection) { return null; }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  const result = fileCollection.chain()
    .find({ '$and': [{ 'filepath': filepath }, { 'vpath': vpath }] }, true)
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();

  if (!result || !result[0]) { return null; }
  return result[0];
}

export function getArtists(vpaths, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const results = fileCollection.find(renderOrClause(vpaths, ignoreVPaths));
  const store = {};
  for (const row of results) {
    if (!store[row.artist] && !(row.artist === undefined || row.artist === null)) {
      store[row.artist] = true;
    }
  }

  return Object.keys(store).sort((a, b) => a.localeCompare(b));
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const results = fileCollection.chain().find({
    '$and': [
      renderOrClause(vpaths, ignoreVPaths),
      { 'artist': { '$eq': String(artist) } }
    ]
  }).simplesort('year', true).data();

  const albums = [];
  const store = {};
  for (const row of results) {
    if (row.album === null) {
      if (!store[row.album]) {
        albums.push({
          name: null,
          year: null,
          album_art_file: row.aaFile ? row.aaFile : null
        });
        store[row.album] = true;
      }
    } else if (!store[`${row.album}${row.year}`]) {
      albums.push({
        name: row.album,
        year: row.year,
        album_art_file: row.aaFile ? row.aaFile : null
      });
      store[`${row.album}${row.year}`] = true;
    }
  }

  return albums;
}

export function getAlbums(vpaths, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const results = fileCollection.find(renderOrClause(vpaths, ignoreVPaths));
  const albums = [];
  const store = {};
  for (const row of results) {
    if (store[`${row.album}${row.year}`] || (row.album === undefined || row.album === null)) {
      continue;
    }
    albums.push({ name: row.album, album_art_file: row.aaFile, year: row.year });
    store[`${row.album}${row.year}`] = true;
  }

  albums.sort((a, b) => a.name.localeCompare(b.name));
  return albums;
}

export function getAlbumSongs(album, vpaths, username, opts) {
  if (!fileCollection) { return []; }

  const searchClause = [
    renderOrClause(vpaths, opts.ignoreVPaths),
    { 'album': { '$eq': album } }
  ];

  if (opts.artist) {
    searchClause.push({ 'artist': { '$eq': opts.artist } });
  }

  if (opts.year) {
    searchClause.push({ 'year': { '$eq': Number(opts.year) } });
  }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  return fileCollection.chain().find({
    '$and': searchClause
  }).compoundsort(['disk', 'track', 'filepath'])
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const findThis = {
    '$and': [
      renderOrClause(vpaths, ignoreVPaths),
      { [searchCol]: { '$regex': [escapeStringRegexp(String(searchTerm)), 'i'] } }
    ]
  };

  return fileCollection.find(findThis);
}

export function getRatedSongs(vpaths, username, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  return userMetadataCollection.chain()
    .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
    .find({
      '$and': [
        renderOrClause(vpaths, ignoreVPaths),
        { 'rating': { '$gt': 0 } }
      ]
    }).simplesort('rating', true).data();
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  return fileCollection.chain().find({
    '$and': [
      renderOrClause(vpaths, ignoreVPaths),
      { 'ts': { '$gt': 0 } }
    ]
  }).simplesort('ts', true).limit(limit)
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      lastPlayed: left.lp,
      playCount: left.pc,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  return userMetadataCollection.chain()
    .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
    .find({
      '$and': [
        renderOrClause(vpaths, ignoreVPaths),
        { 'lastPlayed': { '$gt': 0 } }
      ]
    }).simplesort('lastPlayed', true).limit(limit).data();
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      lastPlayed: left.lp,
      playCount: left.pc,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  return userMetadataCollection.chain()
    .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
    .find({
      '$and': [
        renderOrClause(vpaths, ignoreVPaths),
        { 'playCount': { '$gt': 0 } }
      ]
    }).simplesort('playCount', true).limit(limit).data();
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  if (!fileCollection) { return []; }

  let orClause = { '$or': [] };
  for (const vpathItem of vpaths) {
    if (opts.ignoreVPaths && typeof opts.ignoreVPaths === 'object' && opts.ignoreVPaths.includes(vpathItem)) {
      continue;
    }
    orClause['$or'].push({ 'vpath': { '$eq': vpathItem } });
  }

  const minRating = Number(opts.minRating);
  if (minRating && typeof minRating === 'number' && minRating <= 10 && !minRating < 1) {
    orClause = { '$and': [
      orClause,
      { 'rating': { '$gte': opts.minRating } }
    ]};
  }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  return fileCollection.chain()
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .find(orClause)
    .data();
}

// User Metadata
export function findUserMetadata(hash, username) {
  if (!userMetadataCollection) { return null; }
  return userMetadataCollection.findOne({ '$and': [{ 'hash': hash }, { 'user': username }] });
}

export function insertUserMetadata(obj) {
  userMetadataCollection.insert(obj);
}

export function updateUserMetadata(obj) {
  userMetadataCollection.update(obj);
}

export function removeUserMetadataByUser(username) {
  userMetadataCollection.findAndRemove({ 'user': { '$eq': username } });
}

// Playlists
export function getUserPlaylists(username) {
  const playlists = [];
  const results = playlistCollection.find({ 'user': { '$eq': username }, 'filepath': { '$eq': null } });
  for (const row of results) {
    playlists.push({ name: row.name });
  }
  return playlists;
}

export function findPlaylist(username, playlistName) {
  return playlistCollection.findOne({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } }
    ]
  });
}

export function createPlaylistEntry(entry) {
  playlistCollection.insert(entry);
}

export function deletePlaylist(username, playlistName) {
  playlistCollection.findAndRemove({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } }
    ]
  });
}

export function getPlaylistEntryById(id) {
  return mapId(playlistCollection.get(id));
}

export function removePlaylistEntryById(id) {
  const result = playlistCollection.get(id);
  if (result) {
    playlistCollection.remove(result);
  }
}

export function loadPlaylistEntries(username, playlistName) {
  const results = playlistCollection.find({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } },
      { 'filepath': { '$ne': null } }
    ]
  });
  return results.map(r => mapId(r));
}

export function removePlaylistsByUser(username) {
  playlistCollection.findAndRemove({ 'user': { '$eq': username } });
}

// Shared Playlists
export function findSharedPlaylist(playlistId) {
  return shareCollection.findOne({ 'playlistId': playlistId });
}

export function insertSharedPlaylist(item) {
  shareCollection.insert(item);
}

export function getAllSharedPlaylists() {
  return shareCollection.find();
}

export function removeSharedPlaylistById(playlistId) {
  shareCollection.findAndRemove({ 'playlistId': { '$eq': playlistId } });
}

export function removeExpiredSharedPlaylists() {
  shareCollection.findAndRemove({ 'expires': { '$lt': Math.floor(Date.now() / 1000) } });
}

export function removeEternalSharedPlaylists() {
  shareCollection.findAndRemove({ 'expires': { '$eq': null } });
  shareCollection.findAndRemove({ 'expires': { '$exists': false } });
}

export function removeSharedPlaylistsByUser(username) {
  shareCollection.findAndRemove({ 'user': { '$eq': username } });
}
