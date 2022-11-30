var MSTREAMAPI = (function () {
  let mstreamModule = {};

  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    token: "",
    vpaths: []
  }

  // $.ajaxPrefilter(function (options) {
  //   options.beforeSend = function (xhr) {
  //     xhr.setRequestHeader('x-access-token', MSTREAMAPI.currentServer.token);
  //   }
  // });

  function makeRequest(url, type, dataObject, callback) {
    fetch(url, {
      method: type,
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': MSTREAMAPI.currentServer.token
        // 'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: dataObject ? JSON.stringify(dataObject) : undefined
    }).then(async res => {
      if (res.ok === true) {
        return callback(await res.json(), false);
      }
      callback(res, true);
    }).catch(err => {
      callback(null, err);
    })
    // var request = $.ajax({
    //   url: url,
    //   type: type,
    //   contentType: "application/json",
    //   dataType: "json",
    //   data: JSON.stringify(dataObject)
    // });

    // request.done(function (response) {
    //   callback(response, false);
    // });

    // request.fail(function (jqXHR, textStatus) {
    //   callback(textStatus, jqXHR);
    // });
  }

  function makePOSTRequest(url, dataObject, callback) {
    makeRequest(url, "POST", dataObject, callback);
  }

  function makeGETRequest(url, dataObject, callback) {
    makeRequest(url, "GET", dataObject, callback);
  }

  mstreamModule.dirparser = function (directory, callback) {
    makePOSTRequest('api/v1/file-explorer', { directory: directory }, callback);
  }

  mstreamModule.loadFileplaylist = function (path, callback) {
    makePOSTRequest('api/v1/file-explorer/m3u', { path }, callback);
  }

  mstreamModule.recursiveScan = function (directory, callback) {
    makePOSTRequest('api/v1/file-explorer/recursive', { directory: directory }, callback);
  }

  mstreamModule.savePlaylist = function (title, songs, callback) {
    makePOSTRequest('api/v1/playlist/save', { title: title, songs: songs }, callback);
  }

  mstreamModule.newPlaylist = function (title, callback) {
    makePOSTRequest('api/v1/playlist/new', { title: title }, callback);
  }

  mstreamModule.deletePlaylist = function (playlistname, callback) {
    makePOSTRequest('api/v1/playlist/delete', { playlistname: playlistname }, callback);
  }

  mstreamModule.removePlaylistSong = function (lokiId, callback) {
    makePOSTRequest('api/v1/playlist/remove-song', { lokiid: lokiId }, callback);
  }

  mstreamModule.loadPlaylist = function (playlistname, callback) {
    makePOSTRequest('api/v1/playlist/load', { playlistname: playlistname }, callback);
  }

  mstreamModule.getAllPlaylists = function (callback) {
    makeGETRequest('api/v1/playlist/getall', false, callback);
  }

  mstreamModule.addToPlaylist = function (playlist, song, callback) {
    makePOSTRequest('api/v1/playlist/add-song', { playlist: playlist, song: song }, callback);
  }

  mstreamModule.search = function (postObject, callback) {
    makePOSTRequest('api/v1/db/search', postObject, callback);
  }

  mstreamModule.artists = function (callback) {
    makeGETRequest('api/v1/db/artists', false, callback);
  }

  mstreamModule.albums = function (callback) {
    makeGETRequest('api/v1/db/albums', false, callback);
  }

  mstreamModule.artistAlbums = function (artist, callback) {
    makePOSTRequest("api/v1/db/artists-albums", { artist: artist }, callback);
  }

  mstreamModule.albumSongs = function (album, artist, year, callback) {
    makePOSTRequest("api/v1/db/album-songs", { album, artist, year }, callback);
  }

  mstreamModule.dbStatus = function (callback) {
    makeGETRequest("api/v1/db/status", false, callback);
  }

  mstreamModule.makeShared = function (playlist, shareTimeInDays, callback) {
    makePOSTRequest("api/v1/share", { time: shareTimeInDays, playlist: playlist }, callback);
  }

  mstreamModule.rateSong = function (filepath, rating, callback) {
    makePOSTRequest("api/v1/db/rate-song", { filepath: filepath, rating: rating }, callback);
  }

  mstreamModule.getRated = function (callback) {
    makeGETRequest("api/v1/db/rated", false, callback);
  }

  mstreamModule.getRecentlyAdded = function (limit, callback) {
    makePOSTRequest("api/v1/db/recent/added", { limit: limit }, callback);
  }

  mstreamModule.lookupMetadata = function (filepath, callback) {
    makePOSTRequest("api/v1/db/metadata", { filepath: filepath }, callback);
  }

  mstreamModule.getRandomSong = function (postObject, callback) {
    makePOSTRequest("api/v1/db/random-songs", postObject, callback);
  }

  // Scrobble
  mstreamModule.scrobbleByMetadata = function (artist, album, trackName, callback) {
    makePOSTRequest("api/v1/lastfm/scrobble-by-metadata", { artist: artist, album: album, track: trackName }, callback);
  }

  // LOGIN
  mstreamModule.login = function (username, password, callback) {
    makePOSTRequest("api/v1/auth/login", { username: username, password: password }, callback);
  }
  mstreamModule.updateCurrentServer = function (username, token, vpaths) {
    mstreamModule.currentServer.user = username;
    mstreamModule.currentServer.token = token;
    mstreamModule.currentServer.vpaths = vpaths;
  }

  mstreamModule.ping = function (callback) {
    makeGETRequest("api/v1/ping", false, callback);
  }


  // Special helper function
  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    bitrate: '128k',
    codec: 'mp3'
  };
  mstreamModule.addSongWizard = function (filepath, metadata, lookupMetadata, position) {
    // Escape filepath
    var rawFilepath = filepath;
    filepath = filepath.replace(/\%/g, "%25");
    filepath = filepath.replace(/\#/g, "%23");
    filepath = filepath.replace(/\?/g, "%3F");
    if (filepath.charAt(0) === '/') {
      filepath = filepath.substr(1);
    }

    var defaultPathString = 'media/';
    if (mstreamModule.transcodeOptions.serverEnabled && mstreamModule.transcodeOptions.frontendEnabled) {
      defaultPathString = 'transcode/';
    }

    var url = mstreamModule.currentServer.host + defaultPathString + filepath;
    if (mstreamModule.currentServer.token) {
      url = url + '?token=' + mstreamModule.currentServer.token;
    }

    const newSong = {
      url: url,
      rawFilePath: rawFilepath,
      filepath: filepath,
      metadata: metadata
    };

    if (position) {
      MSTREAMPLAYER.insertSongAt(newSong, position, true);
    } else {
      MSTREAMPLAYER.addSong(newSong);
    }

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
