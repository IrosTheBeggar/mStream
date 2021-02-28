const winston = require('winston');
const Joi = require('joi');
const path = require('path');
const vpath = require('../util/vpath');
const dbQueue = require('../db/task-queue');
const db = require('../db/manager');

getNumberOfFiles = (vpaths) => {
  if (!db.getFileCollection()) { return 0; }

  let total = 0;
  for (const vpath of vpaths) {
    total += db.getFileCollection().count({ 'vpath': vpath })
  }

  return total;
}

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
      "title": row.title ? row.title : null,
      "year": row.year ? row.year : null,
      "album-art": row.aaFile ? row.aaFile : null,
      "rating": row.rating ? row.rating : null,
      "replaygain-track": row.replaygainTrack ? row.replaygainTrack : null
    }
  };
}

function renderOrClause(vpaths) {
  if (vpaths.length === 1) {
    return { 'vpath': { '$eq': vpaths[0] } };
  }

  const returnThis = { '$or': [] }
  for (let vpath of vpaths) {
    returnThis['$or'].push({ 'vpath': { '$eq': vpath } })
  }

  return returnThis;
}

exports.setup = (mstream) => {
  mstream.get('/api/v1/db/status', (req, res) => {
    try {
      res.json({
        totalFileCount: getNumberOfFiles(req.user.vpaths),
        locked: dbQueue.isScanning()
      });
    }catch(err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({});
    }
  });

  mstream.post('/api/v1/db/metadata', (req, res) => {
    try {
      const pathInfo = vpath.getVPathInfo(req.body.filepath, req.user);
      if (!pathInfo) { throw 'File Not Found' }
      if (!db.getFileCollection()) { return res.json({ "filepath": req.body.filepath, "metadata": {} }); }

      const leftFun = (leftData) => {
        return leftData.hash + '-' + req.user.username;
      };

      const result = db.getFileCollection().chain().find({ '$and': [{'filepath': pathInfo.relativePath}, {'vpath': pathInfo.vpath}] }, true)
        .eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

      if (!result || !result[0]) {
        return res.json({ "filepath": req.body.filepath, "metadata": {} });
      }

      res.json(renderMetadataObj(result[0]));
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.get('/api/v1/db/artists', (req, res) => {
    try {
      const artists = { "artists": [] };
      if (!db.getFileCollection()) { res.json(artists); }
      
      const results = db.getFileCollection().find(renderOrClause(req.user.vpaths));
      const store = {};
      for (let row of results) {
        if (!store[row.artist] && !(row.artist === undefined || row.artist === null)) {
          store[row.artist] = true;
        }
      }

      artists.artists = Object.keys(store).sort((a, b) => {
        return a.localeCompare(b);
      });
  
      res.json(artists);
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
    
  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    try {
      const albums = { "albums": [] };
      if (!db.getFileCollection()) { return res.json(albums); }

      const results = db.getFileCollection().chain().find({
        '$and': [
          renderOrClause(req.user.vpaths),
          {'artist': { '$eq': String(req.body.artist) }}
        ]
      }).simplesort('year', true).data();

      const store = {};
      for (let row of results) {
        if (!store[row.album]) {
          albums.albums.push({
            name: row.album,
            album_art_file: row.aaFile ? row.aaFile : null
          });
          store[row.album] = true;
        }
      }

      res.json(albums);
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.get('/api/v1/db/albums', (req, res) => {
    try {
      const albums = { "albums": [] };
      if (!db.getFileCollection()) { return res.json(albums); }

      const results = db.getFileCollection().find(renderOrClause(req.user.vpaths));
      const store = {};
      for (let row of results) {
        if (!store[row.album] && !(row.album === undefined || row.album === null)) {
          albums.albums.push({ name: row.album, album_art_file: row.aaFile });
          store[row.album] = true;
        }
      }

      albums.albums.sort((a, b) => {
        return a.name.localeCompare(b.name);
      });
  
      res.json(albums);
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    try {
      if (!db.getFileCollection()) { throw 'DB Not Working'; }

      let artistClause;
      if (req.body.artist) {
        artistClause = {'artist': { '$eq': req.body.artist }};
      }

      const leftFun = (leftData) => {
        return leftData.hash + '-' + req.user.username;
      };
  
      const album = req.body.album ? String(req.body.album) : null;
      const results = db.getFileCollection().chain().find({
        '$and': [
          renderOrClause(req.user.vpaths),
          {'album': { '$eq': album }},
          artistClause
        ]
      }).compoundsort(['disk','track','filepath']).eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();

      const songs = [];
      for (const row of results) {
        songs.push(renderMetadataObj(row));
      }
      res.json(songs);
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/db/search', async (req, res) => {
    try {
      const schema = Joi.object({
        search: Joi.string().required(),
        noArtists: Joi.boolean().optional(),
        noAlbums: Joi.boolean().optional(),
        noTitles: Joi.boolean().optional(),
        noFiles: Joi.boolean().optional(),
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      // Get user inputs
      const artists = req.body.noArtists === true ? [] : searchByX(req, 'artist');
      const albums = req.body.noAlbums === true ? [] : searchByX(req, 'album');
      const files = req.body.noFiles === true ? [] : searchByX(req, 'filepath');
      const title = req.body.noTitles === true ? [] : searchByX(req, 'title', 'filepath');
      res.json({artists, albums, files, title });
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  function searchByX(req, searchCol, resCol) {
    if (!resCol) {
      resCol = searchCol;
    }

    const returnThis = [];
    if (!db.getFileCollection()) { return returnThis; }

    const findThis = {
      '$and': [
        renderOrClause(req.user.vpaths),
        {[searchCol]: {'$regex': [String(req.body.search), 'i']}}
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
    try {
      if (!db.getFileCollection()) { throw 'DB Not Ready'; }

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
          renderOrClause(req.user.vpaths), 
          { 'rating': { '$gt': 0 } }
        ]
      }).simplesort('rating', true).data();
  
      const songs = [];
      for (const row of results) {
        songs.push(renderMetadataObj(row));
      }
      res.json(songs);
    } catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/db/rate-song', async (req, res) => {
    try {
      const schema = Joi.object({
        filepath: Joi.string().required(),
        rating: Joi.number().integer().min(0).max(10).allow(null).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try{
      const pathInfo = vpath.getVPathInfo(req.body.filepath);
      if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }
      if (!db.getUserMetadataCollection() || !db.getFileDbName()) { throw 'No DB' }
  
      const result = db.getFileCollection().findOne({ '$and':[{ 'filepath': pathInfo.relativePath}, { 'vpath': pathInfo.vpath }] });
      if (!result) { throw 'File Not Found' }

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
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/db/recent/added', async (req, res) => {
    try {
      const schema = Joi.object({ limit: Joi.number().integer().min(1).required() });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      if (!db.getFileCollection()) { throw 'DB Not Ready'; }

      const leftFun = (leftData) => {
        return leftData.hash + '-' + req.user.username;
      };
  
      const results = db.getFileCollection().chain().find({
        '$and': [
          renderOrClause(req.user.vpaths), 
          { 'ts': { '$gt': 0 } }
        ]
      }).simplesort('ts', true).limit(req.body.limit).eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).data();
  
      const songs = [];
      for (const row of results) {
        songs.push(renderMetadataObj(row));
      }

      res.json(songs);
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/db/random-songs', (req, res) => {
    try {
      if (!db.getFileDbName()) { throw 'No DB'; };

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
        if (req.body.ignoreVPaths && typeof req.body.ignoreVPaths === 'object' && req.body.ignoreVPaths[vpath] === true) {
          continue;
        }
        orClause['$or'].push({ 'vpath': { '$eq': vpath } });
      }

      const leftFun = (leftData) => {
        return leftData.hash + '-' + req.user.username;
      };

      const results = db.getFileCollection().chain().eqJoin(db.getUserMetadataCollection().chain(), leftFun, rightFunDefault, mapFunDefault).find(orClause).data();

      const count = results.length;
      if (count === 0) { throw 'No songs that match criteria'; }
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
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/playlist/load', (req, res) => {
    try {
      if (!db.getPlaylistCollection()){ throw 'No DB'; }
      if (!db.getFileDbName()){ throw 'No DB'; }
  
      const playlist = String(req.body.playlistname);
      const returnThis = [];
  
      const results = db.getPlaylistCollection().find({
        '$and': [{
          'user': { '$eq': req.user.username }
        }, {
          'name': { '$eq': playlist }
        }]
      });
  
      for (const row of results) {
        // Look up metadata
        const pathInfo = vpath.getVPathInfo(row.filepath, req.user);
        if (!pathInfo) { continue; }
  
  
        const leftFun = (leftData) => {
          return leftData.hash + '-' + req.user.username;
        };
        
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
    }catch (err) {
      winston.error('Db Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
}
