// TODO: This style looks up things synchronously from lokijs
// ideally we would ru na loki server on a seperate thread so we don't block our server

const fe = require('path')
const crypto = require('crypto')

// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs')
const filesdb = new loki('files.db')

var fileCollection
var playlistColection



function loadDB(){
  filesdb.loadDatabase({}, function(err) {
    if (err) {
      console.log("error : " + err);
    }
    else {
      console.log("database loaded XXX");
    }
    // Get files collection
    fileCollection = filesdb.getCollection('files')

    // Initialize playlsits collection
    playlistColection = filesdb.getCollection('playlists')
    if (playlistColection === null) {
      // first time run so add and configure collection with some arbitrary options
      playlistColection = filesdb.addCollection("playlists");
    }
  });
}

// Load DB on boot
loadDB();

exports.loadDB = function(){
  loadDB();
}

function getFileType(filename){
  return filename.split(".").pop()
}

exports.getNumberOfFiles = function(username, callback){
  var results = fileCollection.count({ 'user': username })
  callback(results)
}

exports.setup = function (mstream, dbSettings){
  // Metadata lookup
  mstream.post('/db/metadata', function (req, res){
    var relativePath = req.body.filepath;
    var fullpath = fe.join(req.user.musicDir, relativePath);

    var result = fileCollection.findOne({'filepath': fullpath});
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

    filesdb.saveDatabase(function(err) {
      if (err) {
        console.log("error : " + err);
      }
      else {
        console.log("database saved.");
      }
    });


  });

  // Get all playlists
  mstream.get('/playlist/getall', function (req, res){
    var playlists = [];

    var result = playlistColection.mapReduce(function(obj) {
      return obj.name;
    }, function(arr) {
      var store = [];
      for(var i = 0; i <  arr.length; i++) {
        if(store.indexOf(arr[i]) === -1) {
          playlists.push({name: arr[i]});
          store.push(arr[i])
        }
      }
      return;
    });

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

    console.log(results)

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
  });

  // TODO: Re-implment search
  mstream.post('/db/search', function(req, res){
    res.json({error: 'search hdisabled  for lokiJS'});
  });

  mstream.get('/db/artists', function (req, res) {
    var artists = {"artists":[]};
    var result = fileCollection.mapReduce(function(obj) {
    	return obj.artist;
    }, function(arr) {
      for(var i = 0; i <  arr.length; i++) {
        if(artists.artists.indexOf(arr[i]) === -1) {
          artists.artists.push(arr[i]);
        }
      }
      return;
    });

    res.json(artists);
  });

  // TODO: NOT WORKING
  mstream.post('/db/artists-albums', function (req, res) {
    var albums = {"albums":[]};
    var results = fileCollection.find({
      '$and': [{
          'user' : { '$eq' :  req.user.username}
        },{
          'artist' :  { '$eq' :  req.body.artist}
        }]
    });

    for(row of results){
      albums.albums.push({
        name: row.album,
        album_art_file: row.albumArtFilename
      });
    }

    res.json(albums);
  });

  mstream.get('/db/albums', function (req, res) {
    var albums = {"albums":[]};

    var result = fileCollection.mapReduce(function(obj) {
    	return {'name': obj.album, 'album_art_file': obj.albumArtFilename};
    }, function(arr) {
    	var ret = [];
      var len = arr.length;
      var store = [];
      for(var i = 0; i < len; i++) {
        if(store.indexOf(arr[i].name) === -1) {
          store.push(arr[i].name);
          ret.push(arr[i]);
        }
      }
      return ret;
    });

    albums.albums = result;
    res.json(albums);
  });

  mstream.post('/db/album-songs', function (req, res) {
    var results = fileCollection.find({
      '$and': [{
          'user' : { '$eq' :  req.user.username}
        },{
          'album' :  { '$eq' :  req.body.album}
        }]
    });
    var songs = [];

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
    res.json(songs);
  });

}
