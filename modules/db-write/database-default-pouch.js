const PouchDB = require('pouchdb');


exports.setup = function(dbName){
  db = new PouchDB(dbName);
}

exports.getUserFiles = function(thisUser, callback){
  db.all("SELECT path, file_modified_date FROM items WHERE user = ?;", thisUser.username, function(err, rows){
    // Format results
    var returnThis = rows;

    // callback function
    callback(returnThis);
  });
}



exports.insertEntries = function(arrayOfSongs, username, callback){
  let bulkDocs = [];

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
    // sqlParser.push(songTitle);
    // sqlParser.push(artistString);
    // sqlParser.push(songYear);
    // sqlParser.push(songAlbum);
    // sqlParser.push(song.filePath);
    // sqlParser.push(song.format);
    // sqlParser.push(song.track.no);
    // sqlParser.push(song.disk.no);
    // sqlParser.push(username);
    // sqlParser.push(song.filesize);
    // sqlParser.push(song.modified);
    // sqlParser.push(song.created);

"insert into items (title,artist,year,album,path,format, track, disk, user, filesize, file_modified_date, file_created_date) values ";

    bulkDocs.push( {
      _id: song.filePath,
      title: songTitle,
      artist: artistString,
      year: songYear,
      album: songAlbum,
      path: song.filePath, // FIXME: Redundant data
      format:song.format,
      track:song.track.no,
      disk: song.disk.no,
      user:username,
      filesize:song.filesize,
      file_modified_date:song.modified,
      file_created_date:song.created,
    });

  }


  db.bulkDocs(bulkDocs,  function() {
    console.log('ITS DONE');
    callback();
  });
}
