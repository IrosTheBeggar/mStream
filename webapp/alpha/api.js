const MSTREAMAPI = (() => {
  let mstreamModule = {};

  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    token: "",
    vpaths: []
  }
  
  async function req(type, url, dataObject) {
    const res = await fetch('/' + url, {
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
    return req('POST', 'api/v1/file-explorer', { directory: directory });
  }

  mstreamModule.loadFileplaylist =  (path) => {
    return req('POST', 'api/v1/file-explorer/m3u', { path });
  }

  mstreamModule.recursiveScan =  (directory) => {
    return req('POST', 'api/v1/file-explorer/recursive', { directory: directory });
  }

  mstreamModule.savePlaylist =  (title, songs) => {
    return req('POST', 'api/v1/playlist/save', { title: title, songs: songs });
  }

  mstreamModule.newPlaylist =  (title) => {
    return req('POST', 'api/v1/playlist/new', { title: title });
  }

  mstreamModule.deletePlaylist =  (playlistname) => {
    return req('POST', 'api/v1/playlist/delete', { playlistname: playlistname });
  }

  mstreamModule.removePlaylistSong =  (lokiId) => {
    return req('POST', 'api/v1/playlist/remove-song', { lokiid: lokiId });
  }

  mstreamModule.loadPlaylist =  (playlistname) => {
    return req('POST', 'api/v1/playlist/load', { playlistname: playlistname });
  }

  mstreamModule.getAllPlaylists =  () => {
    return req('GET', 'api/v1/playlist/getall', false);
  }

  mstreamModule.addToPlaylist =  (playlist, song) => {
    return req('POST', 'api/v1/playlist/add-song', { playlist: playlist, song: song });
  }

  mstreamModule.search =  (postObject) => {
    return req('POST', 'api/v1/db/search', postObject);
  }

  mstreamModule.artists =  () => {
    return req('GET', 'api/v1/db/artists', false);
  }

  mstreamModule.albums =  () => {
    return req('GET', 'api/v1/db/albums', false);
  }

  mstreamModule.artistAlbums =  (artist) => {
    return req('POST', "api/v1/db/artists-albums", { artist: artist });
  }

  mstreamModule.albumSongs =  (album, artist, year) => {
    return req('POST', "api/v1/db/album-songs", { album, artist, year });
  }

  mstreamModule.dbStatus =  () => {
    return req('GET', "api/v1/db/status", false);
  }

  mstreamModule.makeShared =  (playlist, shareTimeInDays) => {
    return req('POST', "api/v1/share", { time: shareTimeInDays, playlist: playlist });
  }

  mstreamModule.rateSong =  (filepath, rating) => {
    return req('POST', "api/v1/db/rate-song", { filepath: filepath, rating: rating });
  }

  mstreamModule.getRated =  () => {
    return req('GET', "api/v1/db/rated", false);
  }

  mstreamModule.getRecentlyAdded =  (limit) => {
    return req('POST', "api/v1/db/recent/added", { limit: limit });
  }

  mstreamModule.lookupMetadata =  (filepath) => {
    return req('POST', "api/v1/db/metadata", { filepath: filepath });
  }

  mstreamModule.getRandomSong =  (postObject) => {
    return req('POST', "api/v1/db/random-songs", postObject);
  }

  // Scrobble
  mstreamModule.scrobbleByMetadata =  (artist, album, trackName) => {
    return req('POST', "api/v1/lastfm/scrobble-by-metadata", { artist: artist, album: album, track: trackName });
  }

  // LOGIN
  mstreamModule.login =  (username, password) => {
    return req('POST', "api/v1/auth/login", { username: username, password: password });
  }

  mstreamModule.ping =  () => {
    return req('GET', "api/v1/ping", false);
  }

  return mstreamModule;
})();
