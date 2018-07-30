const fe = require('path');
const crypto = require('crypto');
// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs');
var filesdb;

// Loki Collections
var fileCollection = null;
var playlistColection;

// vpath Cache
var userMemCache = {};

function updateUserMemCache() {
  // The lazy way, just blow it away and let mtream update it as necessary
  userMemCache = {};
  // TODO: Fill up cache
}

// TODO: Cache by vPath instead of by user
function getAllArtistsForUser(user) {
  var artists = [];

  // Return the stored value if it exists
  if (userMemCache[user.username] && userMemCache[user.username].artists) {
    return userMemCache[user.username].artists;
  }

  if (fileCollection !== null) {
    for (let vpath of user.vpaths) {
      var results = fileCollection.find({ 'vpath': { '$eq': vpath } });
      for (let row of results) {
        if (artists.indexOf(row.artist) === -1 && !(row.artist === undefined || row.artist === null)) {
          artists.push(row.artist);
        }
      }
    }

    if (!userMemCache[user.username]) {
      userMemCache[user.username] = {};
    }

    userMemCache[user.username].artists = artists;

    artists.sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  return artists;
}

function getAllAlbumsForUser(user) {
  // Return the stored value if it exists
  if (userMemCache[user.username] && userMemCache[user.username].albums) {
    return userMemCache[user.username].albums;
  }

  var albums = [];
  if (fileCollection !== null) {
    for (let vpath of user.vpaths) {
      var results = fileCollection.find({ 'vpath': { '$eq': vpath } });
      var store = [];

      for (let row of results) {
        if (store.indexOf(row.album) === -1 && !(row.album === undefined || row.album === null)) {
          albums.push({ name: row.album, album_art_file: row.albumArtFilename });
          store.push(row.album);
        }
      }
    }

    albums.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    if (!userMemCache[user.username]) {
      userMemCache[user.username] = {};
    }

    userMemCache[user.username].albums = albums;
  }

  return albums;
}

function loadDB() {
  filesdb.loadDatabase({}, function (err) {
    if (err) {
      console.log("error : " + err);
    }

    // Get files collection
    fileCollection = filesdb.getCollection('files');

    // Initialize playlsits collection
    playlistColection = filesdb.getCollection('playlists');
    if (playlistColection === null) {
      // first time run so add and configure collection with some arbitrary options
      playlistColection = filesdb.addCollection("playlists");
    }

    updateUserMemCache();
  });
}

exports.loadDB = function () {
  loadDB();
}

exports.getNumberOfFiles = function (vpaths, callback) {
  if (fileCollection === null) {
    callback(0);
    return;
  }

  var total = 0;
  for (let vpath of vpaths) {
    total += fileCollection.count({ 'vpath': vpath })
  }

  callback(total);
}

exports.setup = function (mstream, program) {
  filesdb = new loki(program.database_plugin.dbPath)

  // Metadata lookup
  mstream.post('/db/metadata', function (req, res) {
    var pathInfo = program.getVPathInfo(req.body.filepath);
    if (pathInfo === false) {
      res.status(500).json({ error: 'Could not find file' });
      return;
    }

    if (fileCollection === null) {
      res.json({ "filepath": pathInfo.relativePath, "metadata": {} });
      return;
    }

    var result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
    if (!result) {
      res.json({ "filepath": pathInfo.relativePath, "metadata": {} });
      return;
    }
    res.json({
      "filepath": pathInfo.relativePath,
      "metadata": {
        "artist": result.artist ? result.artist : '',
        "hash": result.hash ? result.hash : '',
        "album": result.album ? result.album : '',
        "track": result.track ? result.track : '',
        "title": result.title ? result.title : '',
        "year": result.year ? result.year : '',
        "album-art": result.albumArtFilename ? result.albumArtFilename : '',
        "rating": result.rating ? result.rating : false
      }
    });
  });

  // Save playlists
  mstream.post('/playlist/save', function (req, res) {
    var title = req.body.title;
    var songs = req.body.songs;

    // Delete existing playlist
    playlistColection.findAndRemove({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': title }
      }]
    });


    while (songs.length > 0) {
      var song = songs.shift();
      playlistColection.insert({
        name: title,
        filepath: song,
        user: req.user.username,
        hide: false
      });
    }

    res.json({ success: true });

    // Save the DB
    filesdb.saveDatabase(function (err) {
      if (err) {
        console.log("error : " + err);
      }
    });
  });

  // Get all playlists
  mstream.get('/playlist/getall', function (req, res) {
    var playlists = [];

    var results = playlistColection.find({ 'user': { '$eq': req.user.username } });
    var store = [];
    for (let row of results) {
      if (store.indexOf(row.name) === -1) {
        playlists.push({ name: row.name });
        store.push(row.name);
      }
    }
    res.json(playlists);
  });

  // Load a playlist
  mstream.post('/playlist/load', function (req, res) {
    var playlist = req.body.playlistname;
    var returnThis = [];

    var results = playlistColection.find({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': playlist }
      }]
    });

    for (let row of results) {
      // Look up metadata
      var pathInfo = program.getVPathInfo(row.filepath);
      var metadata = {};

      if (fileCollection) {
        var result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
        if (result) {
          metadata = {
            "artist": result.artist ? result.artist : '',
            "hash": result.hash ? result.hash : '',
            "album": result.album ? result.album : '',
            "track": result.track ? result.track : '',
            "title": result.title ? result.title : '',
            "year": result.year ? result.year : '',
            "album-art": result.albumArtFilename ? result.albumArtFilename : '',
            "rating": result.rating ? result.rating : false
          };
        }
      }

      returnThis.push({ filepath: row.filepath, metadata: metadata });
    }

    res.json(returnThis);
  });

  // Delete playlist
  mstream.post('/playlist/delete', function (req, res) {
    var playlistname = req.body.playlistname;

    // Delete existing playlist
    playlistColection.findAndRemove({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': playlistname }
      }]
    });

    res.json({ success: true });
  });

  // TODO: Re-implment search
  mstream.post('/db/search', function (req, res) {
    res.json({ error: 'search disabled' });
  });


  mstream.get('/db/artists', function (req, res) {
    var artists = { "artists": getAllArtistsForUser(req.user) };
    res.json(artists);
  });


  mstream.post('/db/artists-albums', function (req, res) {
    var albums = { "albums": [] };
    if (fileCollection !== null) {
      var orClause;
      if (req.user.vpaths.length === 1) {
        orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
      } else {
        orClause = { '$or': [] }
        for (let vpath of req.user.vpaths) {
          orClause['$or'].push({ 'vpath': { '$eq': vpath } })
        }
      }

      var results = fileCollection.chain().find({
        '$and': [
          orClause
          , {
            'artist': { '$eq': String(req.body.artist) }
          }]
      }).simplesort('year', true).data();

      var store = [];
      for (let row of results) {
        if (store.indexOf(row.album) === -1) {
          albums.albums.push({
            name: row.album,
            album_art_file: row.albumArtFilename ? row.albumArtFilename : ''
          });
          store.push(row.album);
        }
      }
    }
    res.json(albums);
  });

  mstream.get('/db/albums', function (req, res) {
    var albums = { "albums": getAllAlbumsForUser(req.user) };
    res.json(albums);
  });

  mstream.post('/db/album-songs', function (req, res) {
    var songs = [];
    if (fileCollection !== null) {
      var orClause;
      if (req.user.vpaths.length === 1) {
        orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
      } else {
        orClause = { '$or': [] }
        for (let vpath of req.user.vpaths) {
          orClause['$or'].push({ 'vpath': { '$eq': vpath } })
        }
      }

      var results = fileCollection.chain().find({
        '$and': [
          orClause
          , {
            'album': { '$eq': String(req.body.album) }
          }]
      }).simplesort('track').data();

      for (let row of results) {
        var relativePath = fe.relative(program.folders[row.vpath].root, row.filepath);
        relativePath = fe.join(row.vpath, relativePath)
        relativePath = relativePath.replace(/\\/g, '/');

        songs.push({
          "filepath": relativePath,
          "metadata": {
            "artist": row.artist ? row.artist : '',
            "hash": row.hash ? row.hash : '',
            "album": row.album ? row.album : '',
            "track": row.track ? row.track : '',
            "title": row.title ? row.title : '',
            "year": row.year ? row.year : '',
            "album-art": row.albumArtFilename ? row.albumArtFilename : '',
            "filename": fe.basename(row.filepath),
            "rating": row.rating ? row.rating : false
          }
        });
      }
    }
    res.json(songs);
  });

  mstream.post('/db/rate-song', function (req, res) {
    if (!req.body.filepath || !req.body.rating || !Number.isInteger(req.body.rating) || req.body.rating < 0 || req.body.rating > 10) {
      res.status(500).json({ error: 'Bad input data' });
    }

    var rating = req.body.rating;
    var pathInfo = program.getVPathInfo(req.body.filepath);
    if (pathInfo === false) {
      res.status(500).json({ error: 'Could not find file' });
      return;
    }

    if (fileCollection === null) {
      res.status(500).json({ error: 'No DB' });
      return;
    }

    var result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
    if (!result) {
      res.status(500).json({ error: 'File not found in DB' });
      return;
    }

    result.rating = rating;
    fileCollection.update(result);
    res.json({ success: true });

    filesdb.saveDatabase(function (err) {
      if (err) {
        console.log("error : " + err);
      }
    });
  });

  mstream.get('/db/random-albums', function (req, res) {
    res.status(444).json({ error: 'Coming Soon!' });
  });

  mstream.post('/db/random-songs', function (req, res) {
    if (!fileCollection) {
      res.status(500).json({ error: 'File not found in DB' });
      return;
    };
    // Number of items (defaults to 1. That way the user can have a continuous stream of songs)
    // var amount = 1;
    // Ignore songs with star rating of 2 or under
    var ignoreRating = false;
    // Ignore list TODO: Should we do this on the frontend instead ??
    var ignoreList = [];
    if (req.body.ignoreList && Array.isArray(req.body.ignoreList)) {
      ignoreList = req.body.ignoreList;
    }

    var ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }


    // // Preference for recently played or not played recently
    // // Preference for starred songs

    var orClause;
    if (req.user.vpaths.length === 1 && ignoreRating == false) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }

      if (ignoreRating) {
        // Add Rating clause
      }
    }

    // Print list
    const results = fileCollection.find(orClause);
    const count = results.length;
    if (count === 0) {
      res.status(444).json({ error: 'No songs that match criterai' });
      return;
    }

    // if (amount > count) {
    //   amount = count;
    // }

    while (ignoreList.length > count * ignorePercentage) {
      ignoreList.shift();
    }


    var returnThis = { songs: [], ignoreList: [] };

    var randomNumber = Math.floor(Math.random() * count);
    var randomSong = results[randomNumber];
    while (ignoreList.indexOf(randomNumber) > -1) {
      randomNumber = Math.floor(Math.random() * count);
      randomSong = results[randomNumber];
    }

    var relativePath = fe.relative(program.folders[randomSong.vpath].root, randomSong.filepath);
    relativePath = fe.join(randomSong.vpath, relativePath)
    relativePath = relativePath.replace(/\\/g, '/');

    returnThis.songs.push({
      filepath: relativePath, metadata: {
        "artist": randomSong.artist ? randomSong.artist : '',
        "hash": randomSong.hash ? randomSong.hash : '',
        "album": randomSong.album ? randomSong.album : '',
        "track": randomSong.track ? randomSong.track : '',
        "title": randomSong.title ? randomSong.title : '',
        "year": randomSong.year ? randomSong.year : '',
        "album-art": randomSong.albumArtFilename ? randomSong.albumArtFilename : '',
        "rating": randomSong.rating ? randomSong.rating : false
      }
    });


    ignoreList.push(randomNumber);

    returnThis.ignoreList = ignoreList;

    res.json(returnThis);
  });

  mstream.get('/db/get-rated', function (req, res) {
    var songs = [];
    if (fileCollection == null) {
      res.json(songs);
      return;
    }

    var orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    var results = fileCollection.chain().find({
      '$and': [
        orClause
        , {
          'rating': { '$gt': 0 }
        }]
    }).simplesort('rating', true).data();

    for (let row of results) {
      var relativePath = fe.relative(program.folders[row.vpath].root, row.filepath);
      relativePath = fe.join(row.vpath, relativePath)
      relativePath = relativePath.replace(/\\/g, '/');

      songs.push({
        "filepath": relativePath,
        "metadata": {
          "artist": row.artist ? row.artist : '',
          "hash": row.hash ? row.hash : '',
          "album": row.album ? row.album : '',
          "track": row.track ? row.track : '',
          "title": row.title ? row.title : '',
          "year": row.year ? row.year : '',
          "album-art": row.albumArtFilename ? row.albumArtFilename : '',
          "filename": fe.basename(row.filepath),
          "rating": row.rating ? row.rating : false
        }
      });
    }
    res.json(songs);
  });

  // Load DB on boot
  loadDB();
}
