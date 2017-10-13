// functions that store data into the SQLite DB
  // These functions will take in JSON arrays of song data and then save that dat to the DB
var sqlite3;

try{
  sqlite3 = require('sqlite3').verbose();
}catch(e){
  console.log(e);
}
var db;

exports.setup = function(dbPath){
  try{
    db = new sqlite3.Database(dbPath);
  }catch(e){
    console.log(e);
  }
}

exports.getUserFiles = function(thisUser, callback){
  db.all("SELECT path, file_modified_date FROM items WHERE user = ?;", thisUser.username, function(err, rows){
    // Format results
    if(!rows){
      rows = [];
    }
    // callback function
    callback(rows);
  });
}

/**
 * @param arrayOfSongs
 * @param username
 * @return Promise
 */
exports.insertEntries = function(arrayOfSongs, username){
  var sql2 = "insert into items (title,artist,year,album,path,format, track, disk, user, filesize, file_modified_date, file_created_date, hash, album_art_file) values ";
  var sqlParser = [];

  while(arrayOfSongs.length > 0) {
    var song = arrayOfSongs.pop();

    var songTitle = null;
    var songYear = null;
    var songAlbum = null;
    var artistString = null;

    if(song.artist && song.artist.length > 0){
      artistString = song.artist;
    }
    if(song.title && song.title.length > 0){
      songTitle = song.title;
    }
    if(song.year){
      songYear = song.year;
    }
    if(song.album && song.album.length > 0){
      songAlbum = song.album;
    }

    sql2 += "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), ";
    sqlParser.push(songTitle);
    sqlParser.push(artistString);
    sqlParser.push(songYear);
    sqlParser.push(songAlbum);
    sqlParser.push(song.filePath);
    sqlParser.push(song.format);
    sqlParser.push(song.track.no);
    sqlParser.push(song.disk.no);
    sqlParser.push(username);
    sqlParser.push(song.filesize);
    sqlParser.push(song.modified);
    sqlParser.push(song.created);
    sqlParser.push(song.hash);
    sqlParser.push(song.albumArtFilename);
  }

  sql2 = sql2.slice(0, -2);
  sql2 += ";";

  return new Promise(function(resolve, reject) {
    db.run(sql2, sqlParser,  function(err) {
      if(err)
        reject(err);
      else
        resolve();
    });
  });
}



// TODO: Function that removes all files from the given DB
exports.purgeDB = function(){

}


exports.deleteFile = function(path, user, callback){
  let sql = "DELETE FROM items WHERE path = ? AND user = ?;";
  db.run(sql, [path, user],  function() {
    callback();
  });
}
