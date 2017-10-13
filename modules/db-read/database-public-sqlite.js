const sqlite3 = require('sqlite3').verbose();
const fe = require('path');
const crypto = require('crypto');

var db;


function getFileType(filename){
  return filename.split(".").pop();
}

exports.getNumberOfFiles = function(username, callback){
  db.get("SELECT Count(*) FROM items WHERE user = ?;", [username], function(err, row){
    if(err){
      console.log('SQL ERROR!');
      console.log(err);
    }
    callback(row['Count(*)']);
  });
}

exports.setup = function (mstream, dbSettings){
  db = new sqlite3.Database(dbSettings.dbPath);

  // Setup DB
  // TODO: Add the following cols
    // rating
  var itemsSql = "CREATE TABLE IF NOT EXISTS items (  \
      id INTEGER PRIMARY KEY AUTOINCREMENT,  \
      title varchar DEFAULT NULL,  \
      artist varchar DEFAULT NULL,  \
      year int DEFAULT NULL,  \
      album varchar  DEFAULT NULL,  \
      path TEXT NOT NULL, \
      format VARCHAR, \
      track INTEGER, \
      disk INTEGER, \
      user VARCHAR, \
      filesize INTEGER, \
      file_created_date INTEGER, \
      file_modified_date INTEGER, \
      hash VARCHAR, \
      album_art_file TEXT, \
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP \
    );";

  var playlistSql = "CREATE TABLE IF NOT EXISTS mstream_playlists (  \
      id INTEGER PRIMARY KEY AUTOINCREMENT,  \
      playlist_name varchar,  \
      filepath varchar, \
      hide int DEFAULT 0, \
      user VARCHAR, \
      created DATETIME DEFAULT CURRENT_TIMESTAMP \
    );";

  // Create tables
  db.run(itemsSql,  function() {});
  db.run(playlistSql,  function() {});


  // Metadata lookup
  mstream.post('/db/metadata', function (req, res){
    var relativePath = req.body.filepath;
    var fullpath = fe.join(req.user.musicDir, relativePath);

    // Find entry matching path
    db.get("SELECT * FROM items WHERE path = ?", [fullpath], function(err, row){
      if(err || !row){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      // Return metadata
      res.json({
        "filepath":relativePath,
        "metadata":{
          "artist":row.artist,
          "hash": row.hash,
          "album":row.album,
          "track":row.track,
          "title":row.title,
          "year":row.year,
          "album-art":row.album_art_file
        }
      });

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


  mstream.post('/db/search', function(req, res){
    var searchTerm = "%" + req.body.search + "%" ;

    var returnThis = {"albums":[], "artists":[]};

    // TODO: Combine SQL calls into one
    db.serialize(function() {

      var sqlAlbum = "SELECT DISTINCT album FROM items WHERE items.album LIKE ? AND user = ? ORDER BY album  COLLATE NOCASE ASC;";
      db.all(sqlAlbum, [searchTerm, req.user.username], function(err, rows) {
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


      var sqlArtist = "SELECT DISTINCT artist FROM items WHERE items.artist LIKE ? AND user = ? ORDER BY artist  COLLATE NOCASE ASC;";
      db.all(sqlArtist, [searchTerm, req.user.username], function(err, rows) {
        if(err){
          res.status(500).json({ error: 'DB Error' });
          return;
        }

        for (var i = 0; i < rows.length; i++) {
          if(rows[i].artist){
            returnThis.artists.push(rows[i].artist);
          }
        }

        res.json(returnThis);
      });
    });
  });

  mstream.get('/db/artists', function (req, res) {
    var artists = {"artists":[]};

    var sql = "SELECT DISTINCT artist FROM items WHERE user = ? ORDER BY artist  COLLATE NOCASE ASC;";
    db.all(sql, [req.user.username], function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      var returnArray = [];
      for (var i = 0; i < rows.length; i++) {
        if(rows[i].artist){
          artists.artists.push(rows[i].artist);
        }
      }

      res.json(artists);
    });
  });

  mstream.post('/db/artists-albums', function (req, res) {
    var albums = {"albums":[]};

    // TODO: Make a list of all songs without null albums and add them to the response
    var sql = "SELECT album, album_art_file FROM items WHERE artist = ? AND user = ? GROUP BY album ORDER BY album  COLLATE NOCASE ASC;";
    var searchTerms = [];
    searchTerms.push(req.body.artist);
    searchTerms.push(req.user.username);

    db.all(sql, searchTerms, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      for (let row of rows){
        if(row.album){
          albums.albums.push({
            name: row.album,
            album_art_file: row.album_art_file
          });
        }
      }

      res.json(albums);
    });
  });

  mstream.get('/db/albums', function (req, res) {
    var albums = {"albums":[]};

    // TODO: Seperate albums with same name by different artists
    var sql = "SELECT album, album_art_file FROM items WHERE user = ? GROUP BY album ORDER BY album COLLATE NOCASE ASC;";
    db.all(sql, req.user.username, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      for (var i = 0; i < rows.length; i++) {
        if(rows[i].album){
           albums.albums.push({
             name: rows[i].album,
             album_art_file: rows[i].album_art_file
           });
        }
      }

      res.json(albums);
    });
  });

  mstream.post('/db/album-songs', function (req, res) {
    var sql = "SELECT title, album_art_file, artist, album, hash, format, year, cast(path as TEXT), track FROM items WHERE album = ? AND user = ? ORDER BY track ASC;";
    var searchTerms = [];
    searchTerms.push(req.body.album);
    searchTerms.push(req.user.username);

    db.all(sql, searchTerms, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      var songs = [];
      // Format data for API
      for(var i in rows ){
        var path = String(rows[i]['cast(path as TEXT)']);
        var relativePath = fe.relative(req.user.musicDir, path);
        relativePath = relativePath.replace(/\\/g, '/');

        songs.push({
          "filepath": relativePath,
          "metadata": {
            "hash": rows[i].hash,
            "artist": rows[i].artist,
            "album": rows[i].album,
            "track": rows[i].track,
            "title": rows[i].title,
            "year": rows[i].year,
            "album-art": rows[i].album_art_file,
            "filename":  fe.basename( path )
          }
        })
      }

      res.json(songs);
    });
  });

}
