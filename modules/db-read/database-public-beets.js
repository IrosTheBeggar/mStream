const sqlite3 = require('sqlite3').verbose();
const slash = require('slash');
const fe = require('path');
const crypto = require('crypto');

var db;

// function that takes in a json array of songs and saves them to the sqlite db
  // must contain the username and filepath for each song

// function that gets artist info and returns json array of albums
// function that searches db and returns json array of albums and artists
// function that takes ina playlist name and searchs db for that playlist and returns a json array of songs for that playlist
// BASICALLY, all the functions we have no but de-couple them from the Express API calls


// TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO:
// TODO: Pass in user music dir and compare it to the path using LIKE
// This way If the user is set to use a sub folder of the DB folder, we can ignore all folders above what the user has permission for


function getFileType(filename){
  return filename.split(".").pop();
}

exports.getNumberOfFiles = function(username, callback){
  db.get("SELECT Count(*) FROM items;", function(err, row){
    callback(row['Count(*)']);
  });
}


exports.setup = function(mstream, dbSettings){
  db = new sqlite3.Database(dbSettings.dbPath);


  // Create a playlist table
  db.run("CREATE TABLE IF NOT EXISTS mstream_playlists (  id INTEGER PRIMARY KEY AUTOINCREMENT,  playlist_name varchar,  filepath varchar, hide int DEFAULT 0, user VARCHAR, created datetime default current_timestamp);",  function() {
  });



  // TODO: This needs to be tested to see if it works on extra large playlists (think thousands of entries)
  // TODO: Ban saving playlists that are > 10,000 items long
  mstream.post('/playlist/save', function (req, res){
    var title = req.parsedJSON.title;
    var songs = req.parsedJSON.stuff;

    // Check if this playlist already exists
    db.all("SELECT id FROM mstream_playlists WHERE playlist_name = ?", [title], function(err, rows) {

      db.serialize(function() {

        // We need to delete anys existing entries
        if(rows && rows.length > 0){
          db.run("DELETE FROM mstream_playlists WHERE playlist_name = ?;", [title]);
        }

        // Now we add the new entries
        var sql2 = "insert into mstream_playlists (playlist_name, filepath) values ";
        var sqlParser = [];

        while(songs.length > 0) {
          var song = songs.shift();

          sql2 += "(?, ?), ";
          sqlParser.push(title);
          // TODO: We need to strip out the vPath
          // We need to allow pre-set vPaths in the config file
          // Then strip out the vPath here
          sqlParser.push( fe.join(req.user.musicDir, song)  );

        }

        sql2 = sql2.slice(0, -2);
        sql2 += ";";

        db.run(sql2, sqlParser, function(){
          res.send("{success: true}");
        });

      });
    });
  });


  // Attach API calls to functions
  mstream.get('/playlist/getall', function (req, res){
    // TODO: In V2 we need to change this to ignore hidden playlists
    // TODO: db.all("SELECT DISTINCT playlist_name FROM mstream_playlists WHERE hide=0;", function(err, rows){
    db.all("SELECT DISTINCT playlist_name FROM mstream_playlists", function(err, rows){
      var playlists = [];

      // loop through files
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].playlist_name){
          playlists.push({name: rows[i].playlist_name});
        }
      }

      res.send(JSON.stringify(playlists));
    });
  });
  mstream.get('/playlist/load', function (req, res){
    var playlist = req.query.playlistname;

    db.all("SELECT * FROM mstream_playlists WHERE playlist_name = ? ORDER BY id  COLLATE NOCASE ASC", [playlist], function(err, rows){
      var returnThis = [];

      for (var i = 0; i < rows.length; i++) {
        var filepath = slash(fe.relative(req.user.musicDir, rows[i].filepath));
        returnThis.push({filepath: filepath, metadata:'' });
      }

      res.send(JSON.stringify(returnThis));
    });
  });
  mstream.post('/playlist/delete', function(req, res){
    var playlistname = req.parsedJSON.playlistname;

    // Handle a soft delete
    if(req.parsedJSON.hide && parseInt(req.parsedJSON.hide) == true ){
      db.run("UPDATE mstream_playlists SET hide = 1 WHERE playlist_name = ?;", [playlistname], function(){
        res.send('{success: true}');

      });
    }else{ // Permentaly delete

      // Delete playlist from DB
      db.run("DELETE FROM mstream_playlists WHERE playlist_name = ?;", [playlistname], function(){
        res.send('{success: true}');

      });
    }
  });


  mstream.post('/db/search', function(req, res){
    var searchTerm = "%" + req.parsedJSON.search + "%" ;

    var returnThis = {"albums":[], "artists":[]};

    // TODO: Combine SQL calls into one
    db.serialize(function() {

      var sqlAlbum = "SELECT DISTINCT album FROM items WHERE items.album LIKE ? ORDER BY album  COLLATE NOCASE ASC;";
      db.all(sqlAlbum, [searchTerm], function(err, rows) {
        if(err){
          res.status(500).json({ error: 'DB Error' });
          return;
        }

        for (var i = 0; i < rows.length; i++) {
          if(rows[i].album){
            returnThis.albums.push(rows[i].album);
          }
        }
      });


      var sqlArtist = "SELECT DISTINCT artist FROM items WHERE items.artist LIKE ? ORDER BY artist  COLLATE NOCASE ASC;";
      db.all(sqlArtist, [searchTerm], function(err, rows) {
        if(err){
          res.status(500).json({ error: 'DB Error' });
          return;
        }

        for (var i = 0; i < rows.length; i++) {
          if(rows[i].artist){
            returnThis.artists.push(rows[i].artist);
          }
        }

        res.send(JSON.stringify(returnThis));
      });
    });
  });

  mstream.get('/db/artists', function (req, res) {
    var artists = {"artists":[]};

    var sql = "SELECT DISTINCT artist FROM items ORDER BY artist  COLLATE NOCASE ASC;";
    db.all(sql, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      var returnArray = [];
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].artist){
          // rows.splice(i, 1);
          artists.artists.push(rows[i].artist);
        }
      }

      res.send(JSON.stringify(artists));
    });
  });

  mstream.post('/db/artists-albums', function (req, res) {
    var albums = {"albums":[]};

    // TODO: Make a list of all songs without null albums and add them to the response
    var sql = "SELECT DISTINCT album FROM items WHERE artist = ? ORDER BY album  COLLATE NOCASE ASC;";
    db.all(sql, [req.body.artist], function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      var returnArray = [];
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].album){
          albums.albums.push(rows[i].album);
        }
      }

      res.send(JSON.stringify(albums));
    });
  });

  mstream.get('/db/albums', function (req, res) {
    var albums = {"albums":[]};

    var sql = "SELECT DISTINCT album FROM items ORDER BY album COLLATE NOCASE ASC;";
    db.all(sql, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      var returnArray = [];
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].album){
           albums.albums.push(rows[i].album);
        }
      }

      res.send(JSON.stringify(albums));
    });
  });

  mstream.post('/db/album-songs', function (req, res) {
    var sql = "SELECT title, artist, album, format, year, cast(path as TEXT), track FROM items WHERE album = ? ORDER BY track ASC;";
    db.all(sql, [req.body.album], function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      // Format data for API
      for(var i in rows ){
        var path = String(rows[i]['cast(path as TEXT)']);

        rows[i].format = rows[i].format.toLowerCase();  // make sure the format is lowecase
        rows[i].file_location = slash(fe.relative(req.user.musicDir, path)); // Get the local file location
        rows[i].filename = fe.basename( path );  // Ge the filname
      }

      res.send(JSON.stringify(rows));
    });
  });

}
