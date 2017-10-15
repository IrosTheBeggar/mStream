// TODO: ideally we would ru na loki server on a seperate thread so we don't block our server

const fe = require('path')
const crypto = require('crypto')

// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs')
var filesdb

// Loki Colections
var fileCollection
var playlistColection

// User Cache
var userMemCache = {}

function updateUserMemCache(){
  // The lazy way, just blow it away and let mtream update it as necessary
  userMemCache = {}

  // TODO: Fill up cache
}

function getAllArtistsForUser(user){
  // Return the stored value if it exists
  if(userMemCache[user] && userMemCache[user].artists){
    return userMemCache[user].artists;
  }

  var artists = [];
  if(fileCollection !== null){
    var results = fileCollection.find({'user' : { '$eq' :  user}});
    for(row of results){
      if(artists.indexOf(row.artist) === -1 && !( row.artist === undefined || row.artist === null)) {
        artists.push(row.artist)
      }
    }

    artists.sort(function (a, b) {
      return a.localeCompare(b);
    });

    if(!userMemCache[user]){
      userMemCache[user] = {}
    }

    userMemCache[user].artists = artists;
  }
  return artists;
}

function getAllAlbumsForUser(user){
  // Return the stored value if it exists
  if(userMemCache[user] && userMemCache[user].albums){
    return userMemCache[user].albums;
  }

  var albums = [];
  if(fileCollection !== null){
    var results = fileCollection.find({'user' : { '$eq' :  user}});
    var store = [];

    for(row of results){
      if(store.indexOf(row.album) === -1 && !( row.album === undefined || row.album === null)) {
        albums.push({name: row.album, album_art_file: row.albumArtFilename})
        store.push(row.album);
      }
    }

    albums.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    if(!userMemCache[user]){
      userMemCache[user] = {}
    }

    userMemCache[user].albums = albums;
  }
  return albums;
}

function loadDB(){
  filesdb.loadDatabase({}, function(err) {
    if (err) {
      console.log("error : " + err);
    }
    else {
      // console.log("database loaded XXX");
    }
    // Get files collection
    fileCollection = filesdb.getCollection('files')

    // Initialize playlsits collection
    playlistColection = filesdb.getCollection('playlists')
    if (playlistColection === null) {
      // first time run so add and configure collection with some arbitrary options
      playlistColection = filesdb.addCollection("playlists");
    }

    updateUserMemCache();
  });
}



exports.loadDB = function(){
  loadDB();
}

function getFileType(filename){
  return filename.split(".").pop()
}

exports.getNumberOfFiles = function(username, callback){
  if(fileCollection === null){
    callback(0)
    return;
  }
  var results = fileCollection.count({ 'user': username })

  callback(results)
}

exports.setup = function (mstream, dbSettings){
  filesdb = new loki(dbSettings.dbPath)

  // Metadata lookup
  mstream.post('/db/metadata', function (req, res){
    if(fileCollection === null){
      res.json({"filepath":relativePath, "metadata":{}});
      return;
    }
    var relativePath = req.body.filepath;
    var fullpath = fe.join(req.user.musicDir, relativePath);

    var result = fileCollection.findOne({'filepath': fullpath});
    if(!result){
      res.json({"filepath":relativePath, "metadata":{}});
      return;
    }
    res.json({
      "filepath":relativePath,
      "metadata":{
        "artist":result.artist,
        "hash": result.hash,
        "album":result.album,
        "track":result.track,
        "title":result.title,
        "year":result.year,
        "album-art":result.albumArtFilename
      }
    });
  });


  // Save playlist
  mstream.post('/playlist/save', function (req, res){
    var title = req.body.title;
    var songs = req.body.songs;

    // Delete existing playlist
    playlistColection.findAndRemove({
      '$and': [{
          'user' : { '$eq' :  req.user.username}
        },{
          'name' :  { '$eq' : title}
        }]
    });


    while(songs.length > 0) {
      var song = songs.shift();
      playlistColection.insert({
        name: title,
        filepath: fe.join(req.user.musicDir, song),
        user: req.user.username,
        hide: false
      });
    }

    res.json({success: true});

    // Save the DB
    filesdb.saveDatabase(function(err) {
      if (err) {
        console.log("error : " + err);
      }
      else {
        // console.log("database saved.");
      }
    });
  });

  // Get all playlists
  mstream.get('/playlist/getall', function (req, res){
    var playlists = [];

    var results = playlistColection.find({'user' : { '$eq' :  req.user.username}});
    var store = [];
    for(row of results){
      if(store.indexOf(row.name) === -1) {
        playlists.push({name: row.name});
        store.push(row.name)
      }
    }
    res.json(playlists);
  });

  // Load a playlist
  mstream.post('/playlist/load', function (req, res){
    var playlist = req.body.playlistname;
    var returnThis = [];

    var results = playlistColection.find({
      '$and': [{
          'user' : { '$eq' :  req.user.username}
        },{
          'name' :  { '$eq' :  playlist}
        }]
    });

    for(row of results){
      returnThis.push({filepath: fe.relative(req.user.musicDir, row.filepath), metadata:'' });
    }

    res.json(returnThis);
  });

  // Delete playlist
  mstream.post('/playlist/delete', function(req, res){
    var playlistname = req.body.playlistname;

    // Delete existing playlist
    playlistColection.findAndRemove({
      '$and': [{
          'user' : { '$eq' :  req.user.username}
        },{
          'name' :  { '$eq' : playlistname}
        }]
    });

    res.json({success: true});
  });

  // TODO: Re-implment search
  mstream.post('/db/search', function(req, res){
    res.json({error: 'search hdisabled  for lokiJS'});
  });


  mstream.get('/db/artists', function (req, res) {
    var artists = {"artists": getAllArtistsForUser(req.user.username)};
    res.json(artists);
  });

  mstream.post('/db/artists-albums', function (req, res) {
    var albums = {"albums":[]};
    if(fileCollection !== null){
      var results = fileCollection.chain().find({
        '$and': [{
            'user' : { '$eq' :  req.user.username}
          },{
            'artist' :  { '$eq' :  req.body.artist}
          }]
      }).simplesort('year', true).data();

      var store = [];
      for(row of results){
        if(store.indexOf(row.album) === -1) {
          albums.albums.push({
            name: row.album,
            album_art_file: row.albumArtFilename
          });
          store.push(row.album);
        }
      }
    }
    res.json(albums);
  });

  mstream.get('/db/albums', function (req, res) {
    var albums = {"albums":getAllAlbumsForUser(req.user.username)};
    res.json(albums);
  });

  mstream.post('/db/album-songs', function (req, res) {
    var songs = [];
    if(fileCollection !== null){
      var results = fileCollection.chain().find({
        '$and': [{
            'user' : { '$eq' :  req.user.username}
          },{
            'album' :  { '$eq' :  req.body.album}
          }]
      }).simplesort('track').data();

      for(row of results){
        var relativePath = fe.relative(req.user.musicDir, row.filepath);
        relativePath = relativePath.replace(/\\/g, '/');

        songs.push({
          "filepath": relativePath,
          "metadata": {
            "hash": row.hash,
            "artist": row.artist,
            "album": row.album,
            "track": row.track,
            "title": row.title,
            "year": row.year,
            "album-art": row.albumArtFilename,
            "filename":  fe.basename( row.filepath )
          }
        })
      }
    }
    res.json(songs);
  });

  // Load DB on boot
  loadDB();
}
