import Joi from 'joi';
import path from 'path';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

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

export function pullMetaData(filepath, user) {
  const pathInfo = vpath.getVPathInfo(filepath, user);
  const result = db.getFileWithMetadata(pathInfo.relativePath, pathInfo.vpath, user.username);

  if (!result) {
    return { "filepath": filepath, "metadata": null };
  }

  return renderMetadataObj(result);
}

export function setup(mstream) {
  mstream.get('/api/v1/db/status', (req, res) => {
    let total = 0;
    for (const vpathItem of req.user.vpaths) {
      total += db.countFilesByVpath(vpathItem);
    }

    res.json({
      totalFileCount: total,
      locked: dbQueue.isScanning()
    });
  });

  mstream.post('/api/v1/db/metadata', (req, res) => {
    res.json(pullMetaData(req.body.filepath, req.user));
  });

  mstream.post('/api/v1/db/metadata/batch', (req, res) => {
    const returnThis = {};
    req.body.forEach(f => {
      console.log(f)
      returnThis[f] = pullMetaData(f, req.user);
    });

    res.json(returnThis);
  });

  // legacy enpoint, moved to POST
  mstream.get('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths, req.body.ignoreVPaths) });
  });

  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    const albums = db.getArtistAlbums(req.body.artist, req.user.vpaths, req.body.ignoreVPaths);
    res.json({ albums });
  });

  mstream.get('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths, req.body.ignoreVPaths) });
  });

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    const results = db.getAlbumSongs(
      req.body.album ? String(req.body.album) : null,
      req.user.vpaths,
      req.user.username,
      { ignoreVPaths: req.body.ignoreVPaths, artist: req.body.artist, year: req.body.year }
    );

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

    const results = db.searchFiles(searchCol, req.body.search, req.user.vpaths, req.body.ignoreVPaths);

    const returnThis = [];
    const store = {};
    for (const row of results) {
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

  // legacy endpoint, moved to POST
  mstream.get('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username, req.body.ignoreVPaths);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/rate-song', (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      rating: Joi.number().integer().min(0).max(10).allow(null).required()
    });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.filepath);
    const result = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!result) { throw new Error('File Not Found'); }

    const result2 = db.findUserMetadata(result.hash, req.user.username);
    if (!result2) {
      db.insertUserMetadata({
        user: req.user.username,
        hash: result.hash,
        rating: req.body.rating
      });
    } else {
      result2.rating = req.body.rating;
      db.updateUserMetadata(result2);
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

    const results = db.getRecentlyAdded(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
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

    const results = db.getRecentlyPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
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

    const results = db.getMostPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/random-songs', (req, res) => {
    // Ignore list
    let ignoreList = [];
    if (req.body.ignoreList && Array.isArray(req.body.ignoreList)) {
      ignoreList = req.body.ignoreList;
    }

    let ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && !req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }

    const results = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, {
      ignoreVPaths: req.body.ignoreVPaths,
      minRating: req.body.minRating
    });

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
    const playlist = String(req.body.playlistname);
    const returnThis = [];

    const results = db.loadPlaylistEntries(req.user.username, playlist);

    for (const row of results) {
      // Look up metadata
      let pathInfo;
      try {
        pathInfo = vpath.getVPathInfo(row.filepath, req.user);
      } catch (_err) { continue; }

      const result = db.getFileWithMetadata(pathInfo.relativePath, pathInfo.vpath, req.user.username);

      let metadata = {};
      if (result) {
        metadata = {
          "artist": result.artist ? result.artist : null,
          "hash": result.hash ? result.hash : null,
          "album": result.album ? result.album : null,
          "track": result.track ? result.track : null,
          "title": result.title ? result.title : null,
          "year": result.year ? result.year : null,
          "album-art": result.aaFile ? result.aaFile : null,
          "rating": result.rating ? result.rating : null,
          "replaygain-track-db": result['replaygain-track-db'] ? result['replaygain-track-db'] : null
        };
      }

      returnThis.push({ id: row.id, filepath: row.filepath, metadata: metadata });
    }

    res.json(returnThis);
  });
}
