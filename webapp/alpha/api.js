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

  mstreamModule.savePlaylist =  (title, songs, live) => {
    const postData = { title: title, songs: songs };
    if (live !== undefined) {
      postData.live = live;
    }
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/save', postData);
  }

  mstreamModule.newPlaylist =  (title) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/new', { title: title });
  }

  mstreamModule.deletePlaylist =  (playlistname) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/delete', { playlistname: playlistname });
  }

  mstreamModule.renamePlaylist =  (oldName, newName) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/playlist/rename', { oldName: oldName, newName: newName });
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

  mstreamModule.genres = (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/db/genres', postObject || {});
  }

  mstreamModule.genreSongs = (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/db/genre-songs', postObject);
  }

  mstreamModule.searchAlbumArt = (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/album-art/search', postObject);
  }

  mstreamModule.setAlbumArtFromUrl = (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/album-art/set-from-url', postObject);
  }

  mstreamModule.uploadAlbumArt = (postObject) => {
    return req('POST', mstreamModule.currentServer.host + 'api/v1/album-art/upload', postObject);
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

  mstreamModule.mkdir = (directory) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/file-explorer/mkdir", { directory: directory });
  }

  mstreamModule.ytdl = (url, outputCodec, directory, metadata) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/ytdl/", { url: url, outputCodec: outputCodec, directory: directory, metadata: metadata });
  }

  mstreamModule.ytdlMetadata = (url) => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/ytdl/metadata?url=" + encodeURIComponent(url));
  }

  mstreamModule.ytdlDownloads = () => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/ytdl/downloads");
  }

  // ── Torrent ─────────────────────────────────────────────────────────
  // preflight is JSON; addTorrent is multipart so it can't use the
  // shared `req` helper (which JSON.stringifies the body).
  mstreamModule.torrentPreflight = (filepath) => {
    return req('GET', mstreamModule.currentServer.host +
      "api/v1/torrent/preflight?path=" + encodeURIComponent(filepath || ''));
  }

  // Per-vpath path templates for the user's accessible libraries.
  // Called once when the Add Torrent panel mounts; the resolved
  // template gets applied client-side as the operator edits metadata.
  mstreamModule.getTorrentPathTemplates = () => {
    return req('GET', mstreamModule.currentServer.host +
      "api/v1/torrent/path-templates");
  }

  mstreamModule.autoDetectTorrentMetadata = async (file, vpath) => {
    const fd = new FormData();
    fd.append('torrentFile', file);
    if (vpath) { fd.append('vpath', vpath); }
    const res = await fetch(mstreamModule.currentServer.host + "api/v1/torrent/auto-detect", {
      method: 'POST',
      headers: { 'x-access-token': mstreamModule.currentServer.token },
      body: fd,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    // The endpoint never 500s on "couldn't detect" — ok=false is a
    // normal response shape. Only treat HTTP-level failures (4xx/5xx
    // without a parseable body) as throws.
    if (!res.ok && (!body || body.ok === undefined)) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.response = { data: body || {} };
      throw err;
    }
    return body;
  }

  mstreamModule.addTorrent = async (formData) => {
    const res = await fetch(mstreamModule.currentServer.host + "api/v1/torrent/add", {
      method: 'POST',
      headers: { 'x-access-token': mstreamModule.currentServer.token },
      // No Content-Type — fetch sets multipart/form-data with the
      // correct boundary itself when body is a FormData instance.
      body: formData,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty / non-JSON */ }
    if (!res.ok) {
      const err = new Error(body?.message || body?.error || ('HTTP ' + res.status));
      err.status = res.status;
      err.response = { data: body || {} };
      throw err;
    }
    return body;
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

  // Server info (public endpoint — version + features). Used by the
  // mobile-clients panel to conditionally show Subsonic UI.
  mstreamModule.serverInfo = () => {
    return req('GET', mstreamModule.currentServer.host + "api/", false);
  }

  // ── Subsonic-specific password (V35) ────────────────────────────────
  mstreamModule.getSubsonicPasswordStatus = () => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/user/subsonic-password", false);
  }
  mstreamModule.setSubsonicPassword = (password) => {
    return req('PUT', mstreamModule.currentServer.host + "api/v1/user/subsonic-password", { password });
  }
  mstreamModule.clearSubsonicPassword = () => {
    return req('DELETE', mstreamModule.currentServer.host + "api/v1/user/subsonic-password", false);
  }

  // ── Subsonic API keys (current user) ────────────────────────────────
  mstreamModule.listSubsonicApiKeys = () => {
    return req('GET', mstreamModule.currentServer.host + "api/v1/user/api-keys", false);
  }
  mstreamModule.createSubsonicApiKey = (name) => {
    return req('POST', mstreamModule.currentServer.host + "api/v1/user/api-keys", { name });
  }
  mstreamModule.revokeSubsonicApiKey = (id) => {
    return req('DELETE', mstreamModule.currentServer.host + `api/v1/user/api-keys/${id}`, false);
  }

  mstreamModule.logout = () => {
    localStorage.removeItem('token');
    Cookies.remove('x-access-token');
    document.location.assign(window.location.href + (window.location.href.slice(-1) === '/' ? '' : '/') + 'login');
  }

  return mstreamModule;
})();
