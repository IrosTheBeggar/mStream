const MSTREAMAPI = (() => {
  let mstreamModule = {};

  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    token: "",
    vpaths: []
  };
  
  async function req(type, url, dataObject) {
    const res = await fetch(url, {
      method: type,
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': MSTREAMAPI.currentServer.token
        // 'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: dataObject ? JSON.stringify(dataObject) : undefined
    });

    if (res.ok !== true) {
      throw new Error(res);
    }

    return await res.json();
  }

  mstreamModule.dirparser =  (directory) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/file-explorer', { directory: directory });
  }

  mstreamModule.loadFileplaylist =  (path) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/file-explorer/m3u', { path });
  }

  mstreamModule.recursiveScan =  (directory) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/file-explorer/recursive', { directory: directory });
  }

  mstreamModule.savePlaylist =  (title, songs) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/save', { title: title, songs: songs });
  }

  mstreamModule.newPlaylist =  (title) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/new', { title: title });
  }

  mstreamModule.deletePlaylist =  (playlistname) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/delete', { playlistname: playlistname });
  }

  mstreamModule.removePlaylistSong =  (lokiId) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/remove-song', { lokiid: lokiId });
  }

  mstreamModule.loadPlaylist =  (playlistname) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/load', { playlistname: playlistname });
  }

  mstreamModule.getAllPlaylists =  () => {
    return req('GET', mstreamModule.currentServer.host + 'api/v1/playlist/getall', false);
  }

  mstreamModule.addToPlaylist =  (playlist, song) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/add-song', { playlist: playlist, song: song });
  }

  mstreamModule.search =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/db/search', postObject);
  }

  mstreamModule.artists =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/db/artists', postObject);
  }

  mstreamModule.albums =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/db/albums', postObject);
  }

  mstreamModule.artistAlbums =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/artists-albums", postObject);
  }

  mstreamModule.albumSongs =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/album-songs", postObject);
  }

  mstreamModule.dbStatus =  () => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/db/status", false);
  }

  mstreamModule.makeShared =  (playlist, shareTimeInDays) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/share", { time: shareTimeInDays, playlist: playlist });
  }

  mstreamModule.rateSong =  (filepath, rating) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/rate-song", { filepath: filepath, rating: rating });
  }

  mstreamModule.getRated =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/rated", postObject);
  }

  mstreamModule.getRecentlyAdded =  (limit, ignoreVPaths) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/recent/added", { limit: limit, ignoreVPaths });
  }

  mstreamModule.getRecentlyPlayed =  (limit, ignoreVPaths) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/stats/recently-played", { limit: limit, ignoreVPaths });
  }

  mstreamModule.getMostPlayed =  (limit, ignoreVPaths) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/stats/most-played", { limit: limit, ignoreVPaths });
  }

  mstreamModule.lookupMetadata =  (filepath) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/metadata", { filepath: filepath });
  }

  mstreamModule.getRandomSong =  (postObject) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/db/random-songs", postObject);
  }

  // Scrobble
  mstreamModule.scrobbleByMetadata =  (artist, album, trackName) => {
    return req('POST', mstreamModule.currentServer.host +  "api/v1/lastfm/scrobble-by-metadata", { artist: artist, album: album, track: trackName });
  }

  mstreamModule.scrobbleByFilePath =  (filePath) => {
    return req('POST', mstreamModule.currentServer.host +  "api/v1/lastfm/scrobble-by-filepath", { filePath });
  }

  // LOGIN
  mstreamModule.login =  (username, password, url) => {
    return req('POST', url ? url + "api/v1/auth/login" : "api/v1/auth/login", { username: username, password: password });
  }

  mstreamModule.ping =  () => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/ping", false);
  }

  mstreamModule.logout = () => {
    localStorage.removeItem('token');
    Cookies.remove('x-access-token');
    document.location.assign(window.location.href + (window.location.href.slice(-1) === '/' ? '' : '/') + 'login');
  }

  return mstreamModule;
})();
