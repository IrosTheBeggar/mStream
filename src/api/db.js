const Joi = require('joi');
const path = require('path');
const escapeStringRegexp = require('escape-string-regexp');
const vpath = require('../util/vpath');
const dbQueue = require('../db/task-queue');
const db = require('../db/manager');
const { joiValidate } = require('../util/validation');
const WebError = require('../util/web-error');

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

function renderMetadataObj(row) {
  return {
    "filepath": path.join(row.vpath, row.filepath).replace(/\\/g, '/'),
    "metadata": {
      "artist": row.artist ? row.artist : null,
      "hash": row.hash ? row.hash : null,
      "album": row.album ? row.album : null,
      "track": row.track ? row.track : null,
      "disk": row.disk ? row.disk : null,
      "title": row.title ? row.title : null,
      "year": row.year ? row.year : null,
      "album-art": row.aaFile ? row.aaFile : null,
      "rating": row.rating ? row.rating : null,
      "play-count": row.playCount ? row.playCount : null,
      "last-played": row.lastPlayed ? row.lastPlayed : null,
      "replaygain-track": row.replaygainTrack ? row.replaygainTrack : null
    }
  };
}

function renderOrClause(vpaths, ignoreVPaths) {
  if (vpaths.length === 1) {
    return { 'vpath': { '$eq': vpaths[0] } };
  }

  const returnThis = { '$or': [] }
  for (let vpath of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(vpath)) {
      continue;
    }
    returnThis['$or'].push({ 'vpath': { '$eq': vpath } })
  }

  return returnThis;
}

exports.setup = (mstream) => {
  mstream.get('/api/v1/db/status', (req, res) => {
    let total = 0;
    if (db.getFileCollection()) {
      for (const vpath of req.user.vpaths) {
        total += db.getFileCollection().count({ 'vpath': vpath })
      }
    }

    res.json({
      totalFileCount: total,
      locked: dbQueue.isScanning()
    });
  });

  mstream.post('/api/v1/db/metadata', (req, res) => {
    res.json(this.pullMetaData(req.body.filepath, req.user));
  });

  mstream.post('/api/v1/db/metadata/batch', (req, res) => {
    const returnThis = {};
    req.body.forEach(f => {
      console.log(f)
      returnThis[f] = this.pullMetaData(f, req.user);
    });

    res.json(returnThis);
  });

  exports.pullMetaData = (filepath, user) => {
    const pathInfo = vpath.getVPathInfo(filepath, user);
    if (!db.getFileCollection()) { return { "filepath": filepath, "metadata": null }; }

    const leftFun = (leftData) => {
      return leftData.hash + '-' + user.username;
    };

    const result = db.getFileCollection().chain().find({ '$and': [{'filepath': pathInfo.relativePath}, {'vpath': pathInfo.vpath}] }, true)
      .eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

    if (!result || !result[0]) {
      return { "filepath": filepath, "metadata": null };
    }

    return renderMetadataObj(result[0]);
  }

  // legacy enpoint, moved to POST
  mstream.get('/api/v1/db/artists', (req, res) => {
    const artists = getArtists(req);
    res.json(artists);
  });

  mstream.post('/api/v1/db/artists', (req, res) => {
    const artists = getArtists(req);
    res.json(artists);
  });

  function getArtists(req) {
    const artists = { "artists": [] };
    if (!db.getFileCollection()) { res.json(artists); }
    
    const results = db.getFileCollection().find(renderOrClause(req.user.vpaths, req.body.ignoreVPaths));
    const store = {};
    for (let row of results) {
      if (!store[row.artist] && !(row.artist === undefined || row.artist === null)) {
        store[row.artist] = true;
      }
    }

    artists.artists = Object.keys(store).sort((a, b) => {
      return a.localeCompare(b);
    });

    return artists;
  }
    
  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    const albums = { "albums": [] };
    if (!db.getFileCollection()) { return res.json(albums); }

    const results = db.getFileCollection().chain().find({
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths),
        {'artist': { '$eq': String(req.body.artist) }}
      ]
    }).simplesort('year', true).data();

    const store = {};
    for (let row of results) {
      if (row.album === null) {
        if (!store[row.album]) {
          albums.albums.push({
            name: null,
            year: null,
            album_art_file: row.aaFile ? row.aaFile : null
          });
          store[row.album] = true;
        }
      } else if (!store[`${row.album}${row.year}`]) {
        albums.albums.push({
          name: row.album,
          year: row.year,
          album_art_file: row.aaFile ? row.aaFile : null
        });
        store[`${row.album}${row.year}`] = true;
      }
    }

    res.json(albums);
  });

  mstream.get('/api/v1/db/albums', (req, res) => {
    const albums = getAlbums(req);
    res.json(albums);
  });

  mstream.post('/api/v1/db/albums', (req, res) => {
    const albums = getAlbums(req);
    res.json(albums);
  });

  function getAlbums(req) {
    const albums = { "albums": [] };
    if (!db.getFileCollection()) { return res.json(albums); }

    const results = db.getFileCollection().find(renderOrClause(req.user.vpaths, req.body.ignoreVPaths));
    const store = {};
    for (let row of results) {
      if (store[`${row.album}${row.year}`] || (row.album === undefined || row.album === null)) {
        continue;
      }
      
      albums.albums.push({ name: row.album, album_art_file: row.aaFile, year: row.year });
      store[`${row.album}${row.year}`] = true;
    }

    albums.albums.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

    return albums;
  }

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    if (!db.getFileCollection()) { throw new Error('DB Not Working'); }

    const searchClause = [
      renderOrClause(req.user.vpaths, req.body.ignoreVPaths),
      {'album': { '$eq': req.body.album ? String(req.body.album) : null }}
    ];

    if (req.body.artist) {
      searchClause.push({ 'artist': { '$eq': req.body.artist }});
    }

    if (req.body.year) {
      searchClause.push({ 'year': { '$eq': Number(req.body.year) }});
    }

    const leftFun = (leftData) => {
      return leftData.hash + '-' + req.user.username;
    };

    const results = db.getFileCollection().chain().find({
      '$and': searchClause
    }).compoundsort(['disk','track','filepath']).eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/search', (req, res) => {
    const schema = Joi.object({
      search: Joi.string().required(),
      noArtists: Joi.boolean().optional(),
      noAlbums: Joi.boolean().optional(),
      noTitles: Joi.boolean().optional(),
      noFiles: Joi.boolean().optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    // Get user inputs
    const artists = req.body.noArtists === true ? [] : searchByX(req, 'artist');
    const albums = req.body.noAlbums === true ? [] : searchByX(req, 'album');
    const files = req.body.noFiles === true ? [] : searchByX(req, 'filepath');
    const title = req.body.noTitles === true ? [] : searchByX(req, 'title', 'filepath');
    res.json({artists, albums, files, title });
  });

  function searchByX(req, searchCol, resCol) {
    if (!resCol) {
      resCol = searchCol;
    }

    const returnThis = [];
    if (!db.getFileCollection()) { return returnThis; }

    const findThis = {
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths),
        {[searchCol]: {'$regex': [escapeStringRegexp(String(req.body.search)), 'i']}}
      ]
    };
    const results = db.getFileCollection().find(findThis);

    const store = {};
    for (let row of results) {
      if (!store[row[resCol]]) {
        let name = row[resCol];
        let filepath = false;

        if (searchCol === 'filepath') {
          name = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
          filepath = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        } else if (searchCol === 'title') {
          name = `${row.artist} - ${row.title}`;
          filepath = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        }

        returnThis.push({
          name: name,
          album_art_file: row.aaFile ? row.aaFile : null,
          filepath
        });
        store[row[resCol]] = true;
      }
    }

    return returnThis;
  }

  mstream.get('/api/v1/db/rated', (req, res) => {
    const songs = getRatedSongs(req);
    res.json(songs);
  });

  mstream.post('/api/v1/db/rated', (req, res) => {
    const songs = getRatedSongs(req);
    res.json(songs);
  });

  function getRatedSongs(req) {
    if (!db.getFileCollection()) { throw new Error('DB Not Ready'); }

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
      return rightData.hash + '-' + req.user.username;
    };

    const results = db.getUserMetadataCollection().chain().eqJoin(db.getFileCollection().chain(), leftFun, rightFun, mapFun).find({
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths), 
        { 'rating': { '$gt': 0 } }
      ]
    }).simplesort('rating', true).data();

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }

    return songs;
  }

  mstream.post('/api/v1/db/rate-song', (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      rating: Joi.number().integer().min(0).max(10).allow(null).required()
    });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.filepath);
    if (!db.getUserMetadataCollection() || !db.getFileDbName()) { throw new Error('No DB'); }

    const result = db.getFileCollection().findOne({ '$and':[{ 'filepath': pathInfo.relativePath}, { 'vpath': pathInfo.vpath }] });
    if (!result) { throw new Error('File Not Found'); }

    const result2 = db.getUserMetadataCollection().findOne({ '$and':[{ 'hash': result.hash}, { 'user': req.user.username }] });
    if (!result2) {
      db.getUserMetadataCollection().insert({
        user: req.user.username,
        hash: result.hash,
        rating: req.body.rating
      });
    } else {
      result2.rating = req.body.rating;
      db.getUserMetadataCollection().update(result2);
    }

    res.json({});
    db.saveUserDB();
  });

  mstream.post('/api/v1/db/recent/added', (req, res) => {
    const schema = Joi.object({ 
      limit: Joi.number().integer().min(1).required(), 
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    if (!db.getFileCollection()) { throw new Error('DB Not Ready'); }

    const leftFun = (leftData) => {
      return leftData.hash + '-' + req.user.username;
    };

    const results = db.getFileCollection().chain().find({
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths), 
        { 'ts': { '$gt': 0 } }
      ]
    }).simplesort('ts', true).limit(req.body.limit).eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }

    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/recently-played', (req, res) => {
    const schema = Joi.object({ 
      limit: Joi.number().integer().min(1).required(), 
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    if (!db.getFileCollection()) { throw new Error('DB Not Ready'); }

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
      return rightData.hash + '-' + req.user.username;
    };

    const results = db.getUserMetadataCollection().chain().eqJoin(db.getFileCollection().chain(), leftFun, rightFun, mapFun).find({
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths), 
        { 'lastPlayed': { '$gt': 0 } }
      ]
    }).simplesort('lastPlayed', true).data();

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }

    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/most-played', (req, res) => {
    const schema = Joi.object({ 
      limit: Joi.number().integer().min(1).required(), 
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    if (!db.getFileCollection()) { throw new Error('DB Not Ready'); }

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
      return rightData.hash + '-' + req.user.username;
    };

    const results = db.getUserMetadataCollection().chain().eqJoin(db.getFileCollection().chain(), leftFun, rightFun, mapFun).find({
      '$and': [
        renderOrClause(req.user.vpaths, req.body.ignoreVPaths), 
        { 'playCount': { '$gt': 0 } }
      ]
    }).simplesort('playCount', true).data();

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }

    res.json(songs);
  });

  mstream.post('/api/v1/db/random-songs', (req, res) => {
    if (!db.getFileDbName()) { throw new Error('No DB'); };

    // Ignore list
    let ignoreList = [];
    if (req.body.ignoreList && Array.isArray(req.body.ignoreList)) {
      ignoreList = req.body.ignoreList;
    }

    let ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && !req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }

    let orClause = { '$or': [] };
    for (let vpath of req.user.vpaths) {
      if (req.body.ignoreVPaths && typeof req.body.ignoreVPaths === 'object' && req.body.ignoreVPaths.includes(vpath)) {
        continue;
      }
      orClause['$or'].push({ 'vpath': { '$eq': vpath } });
    }

    let minRating = Number(req.body.minRating);
    // Add Rating clause
    if (minRating && typeof minRating === 'number' && minRating <= 10 && !minRating < 1) {
      orClause = {'$and': [
        orClause,
        { 'rating': { '$gte': req.body.minRating } }
      ]};
    }

    const leftFun = (leftData) => {
      return leftData.hash + '-' + req.user.username;
    };

    const results = db.getFileCollection().chain().eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).find(orClause).data();

    const count = results.length;
    if (count === 0) { throw new WebError('No songs that match criteria', 400); }
    while (ignoreList.length > count * ignorePercentage) {
      ignoreList.shift();
    }

    const returnThis = { songs: [], ignoreList: [] };
    let randomNumber = Math.floor(Math.random() * count);
    while (ignoreList.indexOf(randomNumber) > -1) {
      randomNumber = Math.floor(Math.random() * count);
    }

    const randomSong = results[randomNumber];
    returnThis.songs.push(renderMetadataObj(randomSong));
    ignoreList.push(randomNumber);
    returnThis.ignoreList = ignoreList;

    res.json(returnThis);
  });

  mstream.post('/api/v1/playlist/load', (req, res) => {
    if (!db.getPlaylistCollection()){ throw new Error('No DB'); }
    if (!db.getFileDbName()){ throw new Error('No DB'); }

    const playlist = String(req.body.playlistname);
    const returnThis = [];

    const results = db.getPlaylistCollection().find({
      '$and': [
        { 'user': { '$eq': req.user.username }},
        { 'name': { '$eq': playlist }},
        { 'filepath': { '$ne': null }},
      ]
    });

    const leftFun = (leftData) => {
      return leftData.hash + '-' + req.user.username;
    };

    for (const row of results) {
      // Look up metadata
      try{
        var pathInfo = vpath.getVPathInfo(row.filepath, req.user);
      } catch(err) { continue; }
      
      const result = db.getFileCollection().chain().find({ '$and': [{'filepath': pathInfo.relativePath}, { 'vpath': pathInfo.vpath }] }, true)
        .eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

      let metadata = {};
      if (result && result[0]) {
        metadata = {
          "artist": result[0].artist ? result[0].artist : null,
          "hash": result[0].hash ? result[0].hash : null,
          "album": result[0].album ? result[0].album : null,
          "track": result[0].track ? result[0].track : null,
          "title": result[0].title ? result[0].title : null,
          "year": result[0].year ? result[0].year : null,
          "album-art": result[0].aaFile ? result[0].aaFile : null,
          "rating": result[0].rating ? result[0].rating : null,
          "replaygain-track-db": result[0]['replaygain-track-db'] ? result[0]['replaygain-track-db'] : null
        };
      }

      returnThis.push({ lokiId: row['$loki'], filepath: row.filepath, metadata: metadata });
    }

    res.json(returnThis);
  });

  // mstream.post('/api/v1/db/song-position', (req, res) => {

  // });
}
