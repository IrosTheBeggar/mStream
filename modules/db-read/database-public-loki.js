const fe = require('path');
const loki = require('lokijs');
const winston = require('winston');

// Loki Collections
var filesdb;
var fileCollection;
var playlistCollection;

function getAllArtistsForUser(user) {
  var artists = [];

  if (fileCollection) {
    for (let vpath of user.vpaths) {
      var results = fileCollection.find({ 'vpath': { '$eq': vpath } });
      for (let row of results) {
        if (artists.indexOf(row.artist) === -1 && !(row.artist === undefined || row.artist === null)) {
          artists.push(row.artist);
        }
      }
    }

    artists.sort((a, b) => {
      return a.localeCompare(b);
    });
  }

  return artists;
}

function getAllAlbumsForUser(user) {
  var albums = [];
  if (fileCollection) {
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
  }

  return albums;
}

function loadDB() {
  filesdb.loadDatabase({}, err => {
    if (err) {
      winston.error(`DB Load Error : ${err}`);
      return;
    }

    // Get files collection
    fileCollection = filesdb.getCollection('files');

    // Initialize playlsits collection
    playlistCollection = filesdb.getCollection('playlists');
    if (!playlistCollection) {
      // first time run so add and configure collection with some arbitrary options
      playlistCollection = filesdb.addCollection("playlists");
    }
  });
}

exports.loadDB = function () {
  loadDB();
}

exports.getNumberOfFiles = function (vpaths, callback) {
  if (!fileCollection) {
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
  filesdb = new loki(program.database_plugin.dbPath);

  // Used to determine the user has a working login token
  mstream.get('/ping', (req, res) => {
    const playlists = getPlaylists(req.user.username);
    res.json({
      vpaths: req.user.vpaths,
      playlists: playlists
    });
  });

  // Metadata lookup
  mstream.post('/db/metadata', (req, res) => {
    const pathInfo = program.getVPathInfo(req.body.filepath);
    if (pathInfo === false) {
      res.status(500).json({ error: 'Could not find file' });
      return;
    }

    if (!fileCollection) {
      res.json({ "filepath": pathInfo.relativePath, "metadata": {} });
      return;
    }

    const result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
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

  mstream.post('/playlist/add-song', (req, res) => {
    if(!req.body.song || !req.body.playlist) {
      return res.status(500).json({ error: 'Missing Params' });
    }

    if(!playlistCollection) {
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    playlistCollection.insert({
      name: req.body.playlist,
      filepath: req.body.song,
      user: req.user.username,
      hide: false
    });

    res.json({ success: true });
    filesdb.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  mstream.post('/playlist/remove-song', (req, res) => {
    if (!req.body.lokiid){
      return res.status(500).json({ error: 'Missing Params' });
    }

    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    playlistCollection.findAndRemove({ '$loki': req.body.lokiid });
    res.json({ success: true });
    filesdb.saveDatabase(err => {
      if (err) {
        winston.error(`BB Save Error : ${err}`)
      }
  });
 });

  // Save playlists
  mstream.post('/playlist/save', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    const title = req.body.title;
    const songs = req.body.songs;

    // Delete existing playlist
    playlistCollection.findAndRemove({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': title }
      }]
    });


    while (songs.length > 0) {
      const song = songs.shift();
      playlistCollection.insert({
        name: title,
        filepath: song,
        user: req.user.username,
        hide: false
      });
    }

    res.json({ success: true });
    filesdb.saveDatabase(err =>  {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  // Get all playlists
  mstream.get('/playlist/getall', (req, res) => {
    res.json(getPlaylists(req.user.username));
  });

  function getPlaylists(username) {
    const playlists = [];

    const results = playlistCollection.find({ 'user': { '$eq': username } });
    const store = [];
    for (let row of results) {
      if (store.indexOf(row.name) === -1) {
        playlists.push({ name: row.name });
        store.push(row.name);
      }
    }
    return playlists;
  } 

  // Load a playlist
  mstream.post('/playlist/load', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    const playlist = req.body.playlistname;
    const returnThis = [];

    const results = playlistCollection.find({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': playlist }
      }]
    });

    for (let row of results) {
      // Look up metadata
      const pathInfo = program.getVPathInfo(row.filepath);
      var metadata = {};

      if (fileCollection) {
        const result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
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

      returnThis.push({ lokiId: row['$loki'], filepath: row.filepath, metadata: metadata });
    }

    res.json(returnThis);
  });

  // Delete playlist
  mstream.post('/playlist/delete', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }
    
    const playlistname = req.body.playlistname;

    // Delete existing playlist
    playlistCollection.findAndRemove({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': playlistname }
      }]
    });

    res.json({ success: true });
  });

  mstream.get('/db/artists', (req, res) => {
    var artists = { "artists": getAllArtistsForUser(req.user) };
    res.json(artists);
  });

  mstream.post('/db/artists-albums', (req, res) => {
    var albums = { "albums": [] };
    if (fileCollection) {
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

  mstream.get('/db/albums', (req, res) => {
    var albums = { "albums": getAllAlbumsForUser(req.user) };
    res.json(albums);
  });

  // TODO: validate input, allow to search albums by LokiID
  mstream.post('/db/album-songs', (req, res) => {
    var songs = [];
    if (fileCollection) {
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

  mstream.post('/db/rate-song', (req, res) => {
    if (!req.body.filepath || !req.body.rating || !Number.isInteger(req.body.rating) || req.body.rating < 0 || req.body.rating > 10) {
      res.status(500).json({ error: 'Bad input data' });
    }

    const rating = req.body.rating;
    const pathInfo = program.getVPathInfo(req.body.filepath);
    if (pathInfo === false) {
      res.status(500).json({ error: 'Could not find file' });
      return;
    }

    if (!fileCollection) {
      res.status(500).json({ error: 'No DB' });
      return;
    }

    const result = fileCollection.findOne({ 'filepath': pathInfo.fullPath });
    if (!result) {
      res.status(500).json({ error: 'File not found in DB' });
      return;
    }

    result.rating = rating;
    fileCollection.update(result);
    res.json({ success: true });

    filesdb.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  mstream.get('/db/random-albums', function (req, res) {
    res.status(444).json({ error: 'Coming Soon!' });
  });

  mstream.post('/db/random-songs', (req, res) => {
    if (!fileCollection) {
      res.status(500).json({ error: 'File not found in DB' });
      return;
    };
    // Number of items (defaults to 1. That way the user can have a continuous stream of songs)
    // var amount = 1;
    // Ignore songs with star rating of 2 or under
    var ignoreRating = false;
    // Ignore list
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

  mstream.get('/db/get-rated', (req, res) => {
    var songs = [];
    if (!fileCollection) {
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
