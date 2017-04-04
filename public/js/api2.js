  //  TODO: MOVE THIS ALL TO PROMISES


var MSTREAMAPI = (function () {
  let mstreamModule = {};



  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host:"",
    username:"",
    token: "",
    vPath: ""
  }


  // TODO: Special functions for handling multipel servers
    // Add Server
    // Delete Server
    // Select Server
    // Edit Server
    // Test Sever
    // Login server and save credentials




  function makeRequest(url, type, dataObject, callback){
    var request = $.ajax({
      url: url,
      type: type,
      contentType: "application/json",
      dataType: "json",
      data: JSON.stringify(dataObject)
    });

    request.done(function( response ) {
      callback(response);
    });

    // TODO: AHandle errors
    request.fail(function( jqXHR, textStatus ) {
      callback(false);
    });
  }


  function makePOSTRequest(url, dataObject, callback){
    makeRequest(url, "POST", dataObject, callback);
  }

  function makeGETRequest(url, dataObject, callback){
    makeRequest(url, "GET", dataObject, callback);
  }



  mstreamModule.dirparser = function(directory, filetypes, callback){
    makePOSTRequest('/dirparser', {dir: directory}, callback);
  }

  mstreamModule.savePlaylist = function(title, songs, callback){
    makePOSTRequest('/playlist/save', { title: title, songs: songs }, callback);
  }

  mstreamModule.deletePlaylist = function(playlistname, callback){
    makePOSTRequest('/playlist/delete', {playlistname: playlistname}, callback);
  }

  mstreamModule.loadPlaylist = function(playlistname, callback){
    makePOSTRequest('/playlist/load', {playlistname: playlistname}, callback);
  }

  mstreamModule.getAllPlaylists = function(callback){
    makeGETRequest('/playlist/getall', false, callback);
  }

  mstreamModule.search = function(searchTerm, callback){
    makePOSTRequest('/db/search', {search: searchTerm}, callback);
  }

  mstreamModule.artists = function(callback){
    makeGETRequest('/db/artists', false, callback);
  }

  mstreamModule.albums = function(callback){
    makeGETRequest('/db/albums', false, callback);
  }

  mstreamModule.artistAlbums = function(artist, callback){
    makePOSTRequest("/db/artists-albums", {artist: artist}, callback);
  }

  mstreamModule.albumSongs = function(album, callback){
    makePOSTRequest("/db/album-songs", {album: album}, callback);
  }

  mstreamModule.dbStatus = function(callback){
    makeGETRequest("/db/status", false, callback);
  }

  mstreamModule.dbScan = function(callback){
    makeGETRequest("/db/recursive-scan", false, callback);
  }

  mstreamModule.makeShared = function(playlist, shareTimeInDays, callback){
    makePOSTRequest("/shared/make-shared", { time: shareTimeInDays, playlist: playlist}, callback);
  }


  // LOGIN
  mstreamModule.login = function(username, password, callback){
    makePOSTRequest("/login", { time: shareTimeInDays, playlist: playlist}, callback);
  }




  // Special helper function
  // TODO: handle metadata
  MSTREAM.addSongWizard = function(filepath){
    var url = mstreamModule.currentServer.host + filepath;

    if(mstreamModule.currentServer.vPath){
      url = mstreamModule.currentServer.vPath + '/' + url;
    }

    if(mstreamModule.currentServer.token){
      url = url + '?token=' + mstreamModule.currentServer.token;
    }

    MSTREAM.addSong({
      url: url,
      filepath: filepath
    });
  }



  return mstreamModule;
}());
