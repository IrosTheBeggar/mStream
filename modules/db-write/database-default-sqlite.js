// functions that store data into the SQLite DB
  // These functions will take in JSON arrays of song data and then save that dat to the DB


exports.getUserFiles = function(user, callback){
  db.all("SELECT path, file_modified_date  FROM files WHERE user=? ;" [thisUser], function(err, rows){
    // Format results
    var returnThis;

    // callback function
    callback(returnThis);
  });
}



function insertEntries(){
  var sql2 = "insert into items (title,artist,year,album,path,format, track, disk) values ";
  var sqlParser = [];

  while(arrayOfSongs.length > 0) {
    var song = arrayOfSongs.pop();

    // console.log(song);


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


    sql2 += "(?, ?, ?, ?, ?, ?, ?, ?), ";
    sqlParser.push(songTitle);
    sqlParser.push(artistString);
    sqlParser.push(songYear);
    sqlParser.push(songAlbum);
    sqlParser.push(song.filePath);
    sqlParser.push(song.format);
    sqlParser.push(song.track.no);
    sqlParser.push(song.disk.no);

  }

  sql2 = sql2.slice(0, -2);
  sql2 += ";";

  console.log(sql2);
  dbCopy.run(sql2, sqlParser);
}

function prep(){
  dbCopy.serialize(function() {
    // These two queries will run sequentially.
    dbCopy.run("drop table if exists items;");
    dbCopy.run("CREATE TABLE items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
      // These queries will run in parallel and the second query will probably
      // fail because the table might not exist yet.
      console.log('TABLES CREATED');

      parse = parseAllFiles();
      parse.next();
    });
  });
}
