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
    // Add a collection to the database
    fileCollection = filesdb.getCollection('files')
    playlistColection = filesdb.getCollection('playlists')

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
        "album-art":row.albumArtFilename
      }
    });
  });


  // TODO: This needs to be tested to see if it works on extra large playlists (think thousands of entries)
  // TODO: Ban saving playlists that are > 10,000 items long
  mstream.post('/playlist/save', function (req, res){
    var title = req.body.title;
    var songs = req.body.songs;

    // Check if this playlist already exists
    db.all("SELECT id FROM mstream_playlists WHERE playlist_name = ? AND user = ?;", [title, req.user.username], function(err, rows) {
      db.serialize(function() {
        // We need to delete anys existing entries
        if(rows && rows.length > 0){
          db.run("DELETE FROM mstream_playlists WHERE playlist_name = ? AND user = ?;", [title, req.user.username]);
        }

        // Now we add the new entries
        var sql2 = "insert into mstream_playlists (playlist_name, filepath, user) values ";
        var sqlParser = [];

        while(songs.length > 0) {
          var song = songs.shift();

          sql2 += "(?, ?, ?), ";
          sqlParser.push(title);
          sqlParser.push( fe.join(req.user.musicDir, song)  );
          sqlParser.push( req.user.username );
        }

        sql2 = sql2.slice(0, -2);
        sql2 += ";";

        db.run(sql2, sqlParser, function(){
          res.json({success: true});
        });

      });
    });
  });


  // Attach API calls to functions
  mstream.get('/playlist/getall', function (req, res){
    // TODO: In V2 we need to change this to ignore hidden playlists
    // TODO: db.all("SELECT DISTINCT playlist_name FROM mstream_playlists WHERE hide=0;", function(err, rows){
    db.all("SELECT DISTINCT playlist_name FROM mstream_playlists WHERE user = ?", [req.user.username], function(err, rows){
      var playlists = [];

      // loop through files
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].playlist_name){
          playlists.push({name: rows[i].playlist_name});
        }
      }

      res.json(playlists);
    });
  });

  mstream.post('/playlist/load', function (req, res){
    var playlist = req.body.playlistname;

    db.all("SELECT * FROM mstream_playlists WHERE playlist_name = ? AND user = ? ORDER BY id  COLLATE NOCASE ASC", [playlist, req.user.username], function(err, rows){
      var returnThis = [];

      for (var i = 0; i < rows.length; i++) {

        // var tempName = rows[i].filepath.split('/').slice(-1)[0];
        var tempName = fe.basename(rows[i].filepath);
        var extension = getFileType(rows[i].filepath);
        var filepath = fe.relative(req.user.musicDir, rows[i].filepath);
        filepath = filepath.replace(/\\/g, '/');

        returnThis.push({filepath: filepath, metadata:'' });
      }

      res.json(returnThis);
    });
  });
  mstream.post('/playlist/delete', function(req, res){
    var playlistname = req.body.playlistname;

    // Handle a soft delete
    if(req.body.hide && parseInt(req.body.hide) == true ){
      db.run("UPDATE mstream_playlists SET hide = 1 WHERE playlist_name = ? AND user = ?;", [playlistname, req.user.username], function(){
        res.json({success: true});
      });
    }else{
      // Delete playlist from DB
      db.run("DELETE FROM mstream_playlists WHERE playlist_name = ? AND user = ?;", [playlistname, req.user.username], function(){
        res.json({success: true});
      });
    }
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
          console.log(arr[i])
          artists.artists.push(arr[i]);
        }
      }
      return;
    });

    // artists.artists = result;
    res.json(artists);
  });

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

      res.json(albums);
    }
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
        console.log(arr[i])
        if(store.indexOf(arr[i].name) === -1) {
          store.push(arr[i].name);
          ret.push(arr[i]);
        }
      }
      return ret;
    });

    console.log(result)

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
