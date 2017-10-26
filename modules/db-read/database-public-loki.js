const fe = require('path')
const crypto = require('crypto')

// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs')
var filesdb

// Loki Colections
var fileCollection = null;
var playlistColection

// vpath Cache
var userMemCache = {}

function updateUserMemCache(){
  // The lazy way, just blow it away and let mtream update it as necessary
  userMemCache = {}
  // TODO: Fill up cache
}

// TODO: Cache by vPath instead of by user
function getAllArtistsForUser(user){
  var artists = [];

  // Return the stored value if it exists
  if(userMemCache[user.username] && userMemCache[user.username].artists){
    return userMemCache[user.username].artists;
  }

  if(fileCollection !== null){
    for(let vpath of user.vpaths){
      var results = fileCollection.find({'vpath' : { '$eq' :  vpath}});
      for( let row of results){
        if(artists.indexOf(row.artist) === -1 && !( row.artist === undefined || row.artist === null)) {
          artists.push(row.artist)
        }
      }
    }

    if(!userMemCache[user.username]){
      userMemCache[user.username] = {}
    }

    userMemCache[user.username].artists = artists;

    artists.sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  return artists;
}

function getAllAlbumsForUser(user){
  // Return the stored value if it exists
  if(userMemCache[user.username] && userMemCache[user.username].albums){
    return userMemCache[user.username].albums;
  }

  var albums = [];
  if(fileCollection !== null){
    for(let vpath of user.vpaths){
      var results = fileCollection.find({'vpath' : { '$eq' :  vpath}});
      var store = [];

      for(let row of results){
        if(store.indexOf(row.album) === -1 && !( row.album === undefined || row.album === null)) {
          albums.push({name: row.album, album_art_file: row.albumArtFilename})
          store.push(row.album);
        }
      }
    }

    albums.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    if(!userMemCache[user.username]){
      userMemCache[user.username] = {}
    }

    userMemCache[user.username].albums = albums;
  }

  return albums;
}

function loadDB(){
  filesdb.loadDatabase({}, function(err) {
    if (err) {
      console.log("error : " + err);
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

exports.getNumberOfFiles = function(vpaths, callback){
  if(fileCollection === null){
    callback(0)
    return;
  }

  var total = 0;
  for(let vpath of vpaths){
    total += fileCollection.count({ 'vpath': vpath })
  }

  callback(total)
}

exports.setup = function (mstream, program){
  console.log(program)
  filesdb = new loki(program.database_plugin.dbPath)

  // Metadata lookup
  mstream.post('/db/metadata', function (req, res){
    if(fileCollection === null){
      res.json({"filepath":relativePath, "metadata":{}});
      return;
    }

    var pathInfo = program.getVPathInfo(req.body.filepath);
    if(pathInfo === false){
      res.status(500).json({ error: 'Could not find file' });
      return;
    }

    var result = fileCollection.findOne({'filepath': pathInfo.fullPath});
    if(!result){
      res.json({"filepath":pathInfo.relativePath, "metadata":{}});
      return;
    }
    res.json({
      "filepath":pathInfo.relativePath,
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


  // Save playlists
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
    for(let row of results){
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

    for(let row of results){
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
    res.json({error: 'search disabled'});
  });


  mstream.get('/db/artists', function (req, res) {
    var artists = {"artists": getAllArtistsForUser(req.user)};
    res.json(artists);
  });

  // TODO: Test with multiple folderss
  mstream.post('/db/artists-albums', function (req, res) {
    var albums = {"albums":[]};
    if(fileCollection !== null){
      var orClause;
      if(req.user.vpaths.length === 1){
        orClause = {'vpath' : { '$eq' :  req.user.vpaths[0]}}
      }else{
        orClause = { '$or': []}
        for(let vpath of req.user.vpaths){
          orClause['$or'].push({'vpath' : { '$eq' :  vpath}})
        }
      }

      console.log(req.body.artist)

      var results = fileCollection.chain().find({
        '$and': [
          orClause
          ,{
            'artist' :  { '$eq' :  String(req.body.artist)}
          }]
      }).simplesort('year', true).data();

      console.log(results)

      var store = [];
      for(let row of results){
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
    var albums = {"albums":getAllAlbumsForUser(req.user)};
    res.json(albums);
  });

  mstream.post('/db/album-songs', function (req, res) {
    var songs = [];
    if(fileCollection !== null){
      var orClause;
      if(req.user.vpaths.length === 1){
        orClause = {'vpath' : { '$eq' :  req.user.vpaths[0]}}
      }else{
        orClause = { '$or': []}
        for(let vpath of req.user.vpaths){
          orClause['$or'].push({'vpath' : { '$eq' :  vpath}})
        }
      }

      console.log(orClause)

      var results = fileCollection.chain().find({
        '$and': [
          orClause
          ,{
            'album' :  { '$eq' :  req.body.album}
          }]
      }).simplesort('track').data();

      for(let row of results){
        var relativePath = fe.relative(program.folders[row.vpath].root, row.filepath);
        relativePath = fe.join(row.vpath, relativePath)
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
