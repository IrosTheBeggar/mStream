var MSTREAMAPI = (function () {
  let mstreamModule = {};

  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    token: "",
    vpaths: []
  }

  $.ajaxPrefilter(function (options) {
    options.beforeSend = function (xhr) {
      xhr.setRequestHeader('x-access-token', MSTREAMAPI.currentServer.token);
    }
  });

  function makeRequest(url, type, dataObject, callback) {
    var request = $.ajax({
      url: url,
      type: type,
      contentType: "application/json",
      dataType: "json",
      data: JSON.stringify(dataObject)
    });

    request.done(function (response) {
      callback(response, false);
    });

    request.fail(function (jqXHR, textStatus) {
      callback(textStatus, jqXHR);
    });
  }

  function makePOSTRequest(url, dataObject, callback) {
    makeRequest(url, "POST", dataObject, callback);
  }

  function makeGETRequest(url, dataObject, callback) {
    makeRequest(url, "GET", dataObject, callback);
  }

  mstreamModule.dirparser = function (directory, filetypes, callback) {
    makePOSTRequest('/dirparser', { dir: directory }, callback);
  }

  mstreamModule.loadFileplaylist = function (path, callback) {
    makePOSTRequest('/fileplaylist/load', { path }, callback);
  }

  mstreamModule.loadFileplaylistPaths = function (path, callback) {
    makePOSTRequest('/fileplaylist/loadpaths', { path }, callback);
  }

  mstreamModule.recursiveScan = function (directory, callback) {
    makePOSTRequest('/files/recursive-scan', { dir: directory }, callback);
  }

  mstreamModule.savePlaylist = function (title, songs, callback) {
    makePOSTRequest('/playlist/save', { title: title, songs: songs }, callback);
  }

  mstreamModule.deletePlaylist = function (playlistname, callback) {
    makePOSTRequest('/playlist/delete', { playlistname: playlistname }, callback);
  }

  mstreamModule.removePlaylistSong = function (lokiId, callback) {
    makePOSTRequest('/playlist/remove-song', { lokiid: lokiId }, callback);
  }

  mstreamModule.loadPlaylist = function (playlistname, callback) {
    makePOSTRequest('/playlist/load', { playlistname: playlistname }, callback);
  }

  mstreamModule.getAllPlaylists = function (callback) {
    makeGETRequest('/playlist/getall', false, callback);
  }

  mstreamModule.addToPlaylist = function (playlist, song, callback) {
    makePOSTRequest('/playlist/add-song', { playlist: playlist, song: song }, callback);
  }

  mstreamModule.search = function (postObject, callback) {
    makePOSTRequest('/db/search', postObject, callback);
  }

  mstreamModule.artists = function (callback) {
    makeGETRequest('/db/artists', false, callback);
  }

  mstreamModule.albums = function (callback) {
    makeGETRequest('/db/albums', false, callback);
  }

  mstreamModule.artistAlbums = function (artist, callback) {
    makePOSTRequest("/db/artists-albums", { artist: artist }, callback);
  }

  mstreamModule.albumSongs = function (album, artist, callback) {
    makePOSTRequest("/db/album-songs", { album: album, artist: artist }, callback);
  }

  mstreamModule.dbStatus = function (callback) {
    makeGETRequest("/db/status", false, callback);
  }

  mstreamModule.dbScan = function (callback) {
    makeGETRequest("/db/recursive-scan", false, callback);
  }

  mstreamModule.makeShared = function (playlist, shareTimeInDays, callback) {
    makePOSTRequest("/shared/make-shared", { time: shareTimeInDays, playlist: playlist }, callback);
  }

  mstreamModule.rateSong = function (filepath, rating, callback) {
    makePOSTRequest("/db/rate-song", { filepath: filepath, rating: rating }, callback);
  }

  mstreamModule.getRated = function (callback) {
    makeGETRequest("/db/get-rated", false, callback);
  }

  mstreamModule.getRecentlyAdded = function (limit, callback) {
    makePOSTRequest("/db/recent/added", { limit: limit }, callback);
  }

  mstreamModule.lookupMetadata = function (filepath, callback) {
    makePOSTRequest("/db/metadata", { filepath: filepath }, callback);
  }

  mstreamModule.getRandomSong = function (postObject, callback) {
    makePOSTRequest("/db/random-songs", postObject, callback);
  }

  mstreamModule.generateFederationInvite = function (postObject, callback) {
    makePOSTRequest("/federation/invite/generate", postObject, callback);
  }

  mstreamModule.acceptFederationInvite = function (postObject, callback) {
    makePOSTRequest("/federation/invite/accept", postObject, callback);
  }

  mstreamModule.getFederationStats = function ( callback) {
    makeGETRequest("/federation/stats", false, callback);
  }

  // Lastfm - Scrobble
  mstreamModule.scrobbleByMetadata = function (artist, album, trackName, callback) {
    makePOSTRequest("/lastfm/scrobble-by-metadata", { artist: artist, album: album, track: trackName }, callback);
  }

  // Lastfm - Now Playing
  mstreamModule.nowPlayingByMetadata = function (artist, album, trackName, duration, callback) {
    makePOSTRequest("/lastfm/nowplaying-by-metadata", { artist: artist, album: album, track: trackName, duration: duration }, callback);
  }

  // LOGIN
  mstreamModule.login = function (username, password, callback) {
    makePOSTRequest("/login", { username: username, password: password }, callback);
  }
  mstreamModule.updateCurrentServer = function (username, token, vpaths) {
    mstreamModule.currentServer.user = username;
    mstreamModule.currentServer.token = token;
    mstreamModule.currentServer.vpaths = vpaths;
  }

  mstreamModule.ping = function (callback) {
    makeGETRequest("/ping", false, callback);
  }


  // Special helper function
  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    bitrate: '128k',
    codec: 'mp3'
  };
  mstreamModule.addSongWizard = function (filepath, metadata, lookupMetadata) {
    // Escape filepath
    var rawFilepath = filepath;
    filepath = filepath.replace(/\%/g, "%25");
    filepath = filepath.replace(/\#/g, "%23");
    if (filepath.charAt(0) === '/') {
      filepath = filepath.substr(1);
    }

    var defaultPathString = '/media/';
    if (mstreamModule.transcodeOptions.serverEnabled && mstreamModule.transcodeOptions.frontendEnabled) {
      defaultPathString = '/transcode/';
    }

    var url = mstreamModule.currentServer.host + defaultPathString + filepath;
    if (mstreamModule.currentServer.token) {
      url = url + '?token=' + mstreamModule.currentServer.token;
    }

    var newSong = {
      url: url,
      filepath: filepath,
      metadata: metadata
    };

    MSTREAMPLAYER.addSong(newSong);

    // perform lookup
    if (lookupMetadata === true) {
      mstreamModule.lookupMetadata(rawFilepath, function (response, error) {
        if (error !== false || response.error || !response) {
          return;
        }

        if (response.metadata) {
          newSong.metadata = response.metadata;
          MSTREAMPLAYER.resetCurrentMetadata();
        }
      });
    }
  }

  return mstreamModule;
}());
