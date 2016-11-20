// function that takes in a json array of songs and saves them to the sqlite db
  // must contain the username and filepath for each song

// function that gets artist info and returns json array of albums
// function that searches db and returns json array of albums and artists
// function that takes ina playlsit name and searchs db for that playlist and returns a json array of songs for that playlist
// BASICALLY, all the functions we have no but de-couple them from the Express API calls


exports.setup = function(mstream){
  // Attach API calls to functions
  mstream.get('/getallplaylists', function (req, res){
    // Check user db settings
      // pull function name out of user settings
      // launch funtion
      // Example functions: saveViamysql, saveViaSqlite, saveViaLoki, saveToFile
  });
  mstream.get('/loadplaylist', function (req, res){
  });
  mstream.get('/deleteplaylist', function(req, res){
  });


  mstream.post('/db/search', function(req, res){
  });
  mstream.get('/db/artists', function (req, res) {
  });
  mstream.post('/db/artists-albums', function (req, res) {
  });
  mstream.get('/db/albums', function (req, res) {
  });
  mstream.post('/db/album-songs', function (req, res) {
  });
//================================================================================

}
