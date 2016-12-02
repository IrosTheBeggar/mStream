// functions that store data into the SQLite DB
  // These functions will take in JSON arrays of song data and then save that dat to the DB
const sqlite3 = require('sqlite3').verbose();
var db;

exports.setup = function(dbPath){
  db = new sqlite3.Database(dbPath);
}

exports.getUserFiles = function(thisUser, callback){
  console.log(thisUser.username);
  db.all("SELECT path, file_modified_date FROM items WHERE user = ?;", thisUser.username, function(err, rows){
    // Format results
    var returnThis = rows;
    console.log(rows);

    // callback function
    callback(returnThis);
  });
}



exports.insertEntries = function(arrayOfSongs, username, callback){
  var sql2 = "insert into items (title,artist,year,album,path,format, track, disk, user, filesize, file_modified_date, file_created_date) values ";
  var sqlParser = [];

  while(arrayOfSongs.length > 0) {
    var song = arrayOfSongs.pop();

    var songTitle = null;
    var songYear = null;
    var songAlbum = null;
    var artistString = null;

    if(song.artist && song.artist.length > 0){
      artistString = '';
      for (var i = 0; i < song.artist.length; i++) {
        artistString += song.artist[i] + ', ';
      }
      artistString = artistString.slice(0, -2);
    }
    if(song.title && song.title.length > 0){
      songTitle = song.title;
    }
    if(song.year && song.year.length > 0){
      songYear = song.year;
    }
    if(song.album && song.album.length > 0){
      songAlbum = song.album;
    }

    // TODO: Update SQL
    sql2 += "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), ";
    sqlParser.push(songTitle);
    sqlParser.push(artistString);
    sqlParser.push(songYear);
    sqlParser.push(songAlbum);
    sqlParser.push(song.filePath);
    sqlParser.push(song.format);
    sqlParser.push(song.track.no);
    sqlParser.push(song.disk.no);
    sqlParser.push(username); // TODO: User
    sqlParser.push(song.filesize);
    sqlParser.push(song.modified);
    sqlParser.push(song.created);

  }

  sql2 = sql2.slice(0, -2);
  sql2 += ";";

  console.log(sql2);
  db.run(sql2, sqlParser,  function() {
    console.log('ITS DONE');
    callback();
  });
}
