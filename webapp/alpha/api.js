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

  // Auto-DJ uses these. Both have fallback-on-error semantics — a
  // missing API key / network error / malformed response should NOT
  // crash the Auto-DJ flow, just degrade gracefully. The fallback
  // value is hardcoded here rather than passed in so callers don't
  // have to remember to pass it.

  mstreamModule.lastfmStatus = async () => {
    try {
      return await req('GET', mstreamModule.currentServer.host + 'api/v1/lastfm/status');
    } catch (_) {
      return { hasApiKey: false, serverEnabled: false, linkedUser: null };
    }
  };

  mstreamModule.lastfmSimilarArtists = async (artist) => {
    if (!artist) { return { artists: [] }; }
    try {
      const url = mstreamModule.currentServer.host
        + 'api/v1/lastfm/similar-artists?artist='
        + encodeURIComponent(artist);
      return await req('GET', url);
    } catch (_) {
      return { artists: [] };
    }
  };

  // POST /api/v1/db/genres → { genres: [{ name, track_count }] }.
  // Used by the Auto-DJ panel's genre filter dropdown. POST (not GET)
  // so callers can pass ignoreVPaths in the body to scope the count;
  // we don't use that here (the dropdown reflects the full library),
  // but matching the existing endpoint shape avoids a one-off wrapper.
  //
  // Returns the discriminated shape `{ status, value, error? }` so the
  // caller can render distinct error states (401 → "log in", 5xx →
  // "couldn't load") without re-checking error.message strings.
  mstreamModule.getGenres = async () => {
    try {
      const res = await fetch(mstreamModule.currentServer.host + 'api/v1/db/genres', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': mstreamModule.currentServer.token,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        return { status: 'error', value: null, code: res.status };
      }
      const body = await res.json();
      const names = Array.isArray(body?.genres) ? body.genres.map(g => g.name) : [];
      return { status: 'ok', value: names };
    } catch (_) {
      return { status: 'error', value: null, code: 0 };  // 0 = network/parse
    }
  };

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
