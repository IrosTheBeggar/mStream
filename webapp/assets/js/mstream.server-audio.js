// Server Audio Player — replaces mstream.player.js when served from /server-remote.
// Implements the MSTREAMPLAYER interface by proxying all commands to the
// server-playback API (which forwards to the Rust audio binary).
//
// When serverAudioMode is not set, this file defines a no-op MSTREAMPLAYER
// so the script tag can exist in index.html without breaking normal mode
// (since in normal mode, mstream.player.js is loaded instead).

var MSTREAMPLAYER = (function () {
  if (typeof serverAudioMode === 'undefined' || serverAudioMode !== true) {
    // Normal mode — mstream.player.js already defined MSTREAMPLAYER.
    // Return the existing one if present, otherwise a stub.
    if (typeof MSTREAMPLAYER !== 'undefined') { return MSTREAMPLAYER; }
    return {};
  }

  // ── Server Audio Mode Implementation ──────────────────────────────────

  var mstreamModule = {};
  var pollTimer = null;

  // ── API helpers ───────────────────────────────────────────────────────

  function getToken() {
    if (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.token) {
      return MSTREAMAPI.currentServer.token;
    }
    try {
      var cookies = document.cookie.split(';');
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf('x-access-token=') === 0) { return c.substring(15); }
      }
    } catch (_e) {}
    return '';
  }

  function apiPost(path, data) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': getToken() },
      body: JSON.stringify(data || {})
    }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  }

  function apiGet(path) {
    return fetch(path, {
      headers: { 'x-access-token': getToken() }
    }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  }

  // ── State ─────────────────────────────────────────────────────────────

  mstreamModule.playlist = [];

  mstreamModule.positionCache = { val: -1 };

  mstreamModule.playerStats = {
    playbackRate: 1,
    duration: 0,
    currentTime: 0,
    playing: false,
    shouldLoop: false,
    shouldLoopOne: false,
    shuffle: false,
    volume: 100,
    autoDJ: false,
    replayGain: false,
    replayGainPreGainDb: 0,
    metadata: {
      artist: '',
      album: '',
      track: '',
      title: '',
      year: '',
      'album-art': '',
      'replaygain-track-db': '',
      filepath: ''
    }
  };

  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false
  };

  mstreamModule.minRating = 0;
  mstreamModule.ignoreVPaths = {};

  // ── Core playback ─────────────────────────────────────────────────────

  function isOpusFile(filepath) {
    return filepath && filepath.toLowerCase().endsWith('.opus');
  }

  // Track opus rejections so resetCurrentMetadata doesn't re-trigger the toast
  var lastOpusRejection = 0;

  mstreamModule.addSong = function (audioData, forceAutoPlayOff) {
    if (!audioData.url && !audioData.filepath && !audioData.rawFilePath) { return false; }

    var filepath = audioData.rawFilePath || audioData.filepath || '';
    if (isOpusFile(filepath)) {
      var now = Date.now();
      if (now - lastOpusRejection > 3000) {
        lastOpusRejection = now;
        if (typeof iziToast !== 'undefined') {
          iziToast.warning({
            title: 'Opus Not Supported',
            message: 'Opus files are not supported by the server audio player',
            position: 'topCenter',
            timeout: 3500
          });
        }
      }
      return false;
    }

    audioData.error = false;
    mstreamModule.playlist.push(audioData);

    // Send to server queue
    if (filepath.charAt(0) === '/') { filepath = filepath.substr(1); }
    apiPost('/api/v1/server-playback/queue/add', { file: filepath });

    // If first song, set position
    if (mstreamModule.playlist.length === 1) {
      mstreamModule.positionCache.val = 0;
      syncStatus();
    }
    return true;
  };

  mstreamModule.insertSongAt = function (song, position, playNow) {
    if (!song.url && !song.filepath && !song.rawFilePath) { return false; }

    var filepath = song.rawFilePath || song.filepath || '';
    if (isOpusFile(filepath)) {
      if (typeof iziToast !== 'undefined') {
        iziToast.warning({
          title: 'Opus Not Supported',
          message: 'Opus files are not supported by the server audio player',
          position: 'topCenter',
          timeout: 3500
        });
      }
      return false;
    }

    song.error = false;
    mstreamModule.playlist.splice(position, 0, song);

    if (filepath.charAt(0) === '/') { filepath = filepath.substr(1); }
    // TODO: proper insert. For now add to end and play-index
    apiPost('/api/v1/server-playback/queue/add', { file: filepath });

    if (playNow) {
      mstreamModule.positionCache.val = position;
      apiPost('/api/v1/server-playback/queue/play-index', { index: position });
      syncStatus();
    }
  };

  mstreamModule.clearAndPlay = function (song) {
    mstreamModule.clearPlaylist();
    mstreamModule.addSong(song);
  };

  mstreamModule.clearPlaylist = function () {
    while (mstreamModule.playlist.length > 0) { mstreamModule.playlist.pop(); }
    mstreamModule.positionCache.val = -1;
    apiPost('/api/v1/server-playback/queue/clear');
    return true;
  };

  mstreamModule.nextSong = function () {
    apiPost('/api/v1/server-playback/next').then(function () { syncStatus(); });
  };

  mstreamModule.previousSong = function () {
    apiPost('/api/v1/server-playback/previous').then(function () { syncStatus(); });
  };

  mstreamModule.goToSongAtPosition = function (position) {
    if (!mstreamModule.playlist[position]) { return false; }
    mstreamModule.positionCache.val = position;
    apiPost('/api/v1/server-playback/queue/play-index', { index: position }).then(function () { syncStatus(); });
  };

  mstreamModule.removeSongAtPosition = function (position, sanityCheckUrl) {
    if (position >= mstreamModule.playlist.length || position < 0) { return false; }
    if (sanityCheckUrl && sanityCheckUrl != mstreamModule.playlist[position].url) { return false; }

    mstreamModule.playlist.splice(position, 1);
    apiPost('/api/v1/server-playback/queue/remove', { index: position });

    // Adjust positionCache
    if (mstreamModule.playlist.length === 0) {
      mstreamModule.positionCache.val = -1;
    } else if (position < mstreamModule.positionCache.val) {
      mstreamModule.positionCache.val--;
    } else if (position === mstreamModule.positionCache.val) {
      if (mstreamModule.positionCache.val >= mstreamModule.playlist.length) {
        mstreamModule.positionCache.val = mstreamModule.playlist.length - 1;
      }
      syncStatus();
    }
  };

  mstreamModule.playPause = function () {
    if (mstreamModule.playerStats.playing) {
      apiPost('/api/v1/server-playback/pause').then(function () {
        mstreamModule.playerStats.playing = false;
      });
    } else {
      apiPost('/api/v1/server-playback/resume').then(function () {
        mstreamModule.playerStats.playing = true;
      });
    }
  };

  // The volume belongs to the engine: it is the room's volume, shared by
  // every remote. While the webapp boots it restores "my last volume" from
  // localStorage (vp.js created()) — right for a browser player, wrong here,
  // where it made merely OPENING the remote on another device yank the room
  // to whatever that device last used. Until the first status sync has told
  // this page what the engine's volume is, there is nothing of the user's to
  // send.
  var engineVolumeKnown = false;

  mstreamModule.changeVolume = function (newVolume) {
    if (isNaN(newVolume) || newVolume < 0 || newVolume > 100) { return; }
    if (!engineVolumeKnown) { return; }
    mstreamModule.playerStats.volume = newVolume;
    apiPost('/api/v1/server-playback/volume', { volume: newVolume / 100 });
  };

  mstreamModule.seekByPercentage = function (percentage) {
    if (percentage < 0 || percentage > 99) { return false; }
    var seekSeconds = (percentage * mstreamModule.playerStats.duration) / 100;
    mstreamModule.playerStats.currentTime = seekSeconds;
    apiPost('/api/v1/server-playback/seek', { position: seekSeconds });
  };

  mstreamModule.goBackSeek = function (backBy) {
    var newPos = Math.max(0, mstreamModule.playerStats.currentTime - backBy);
    mstreamModule.playerStats.currentTime = newPos;
    apiPost('/api/v1/server-playback/seek', { position: newPos });
  };

  mstreamModule.goForwardSeek = function (forwardBy) {
    var newPos = Math.min(mstreamModule.playerStats.duration, mstreamModule.playerStats.currentTime + forwardBy);
    mstreamModule.playerStats.currentTime = newPos;
    apiPost('/api/v1/server-playback/seek', { position: newPos });
  };

  mstreamModule.changePlaybackRate = function () {}; // Not supported server-side

  mstreamModule.toggleRepeat = function () {
    apiPost('/api/v1/server-playback/loop').then(function (data) {
      if (!data) { return; }
      var mode = data.loop_mode || 'none';
      mstreamModule.playerStats.shouldLoop = (mode === 'all');
      mstreamModule.playerStats.shouldLoopOne = (mode === 'one');
    });
  };

  mstreamModule.toggleShuffle = function () {
    mstreamModule.playerStats.shuffle = !mstreamModule.playerStats.shuffle;
    apiPost('/api/v1/server-playback/shuffle', { value: mstreamModule.playerStats.shuffle });
  };

  mstreamModule.toggleAutoDJ = function () {
    // Not supported in server audio mode
  };

  mstreamModule.getCurrentSong = function () {
    if (mstreamModule.positionCache.val >= 0 && mstreamModule.positionCache.val < mstreamModule.playlist.length) {
      return mstreamModule.playlist[mstreamModule.positionCache.val];
    }
    return { url: '', filepath: '', rawFilePath: '', metadata: {}, authToken: getToken() };
  };

  mstreamModule.resetCurrentMetadata = function () {
    var curSong = mstreamModule.getCurrentSong();
    if (!curSong) { return; }
    var meta = curSong.metadata || {};
    mstreamModule.playerStats.metadata.artist = meta.artist || '';
    mstreamModule.playerStats.metadata['artist-display'] = meta['artist-display'] || '';
    mstreamModule.playerStats.metadata.composer = meta.composer || '';
    mstreamModule.playerStats.metadata.album = meta.album || '';
    mstreamModule.playerStats.metadata.track = meta.track || '';
    mstreamModule.playerStats.metadata.title = meta.title || '';
    mstreamModule.playerStats.metadata.year = meta.year || '';
    mstreamModule.playerStats.metadata['album-art'] = meta['album-art'] || '';
    mstreamModule.playerStats.metadata['replaygain-track-db'] = meta['replaygain-track-db'] || '';
    mstreamModule.playerStats.metadata.filepath = curSong.rawFilePath || curSong.filepath || '';
  };

  mstreamModule.resetPositionCache = function () {
    // Used by drag-drop reorder — just accept the new order
  };

  mstreamModule.editSongMetadata = function (key, value, songIndex) {
    if (mstreamModule.playlist[songIndex] && mstreamModule.playlist[songIndex].metadata) {
      mstreamModule.playlist[songIndex].metadata[key] = value;
    }
  };

  mstreamModule.scrobble = function () {
    // Let normal scrobble logic handle this if MSTREAMAPI is available
    if (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.scrobbleByFilePath) {
      var song = mstreamModule.getCurrentSong();
      if (song.rawFilePath) {
        MSTREAMAPI.scrobbleByFilePath(song.rawFilePath, function () {});
      }
    }
  };

  // Replay gain stubs (server handles audio processing)
  mstreamModule.setReplayGainActive = function (val) {
    mstreamModule.playerStats.replayGain = val;
  };
  mstreamModule.setReplayGainPreGainDb = function (val) {
    mstreamModule.playerStats.replayGainPreGainDb = val;
  };
  mstreamModule.updateReplayGainFromSong = function () {};

  // ── Status polling ────────────────────────────────────────────────────

  function syncStatus() {
    apiGet('/api/v1/server-playback/status').then(function (data) {
      if (!data || data.error) { return; }

      mstreamModule.playerStats.playing = data.playing || false;
      mstreamModule.playerStats.currentTime = data.position || 0;
      mstreamModule.playerStats.duration = data.duration || 0;

      if (typeof data.volume === 'number') {
        mstreamModule.playerStats.volume = Math.round(data.volume * 100);
        engineVolumeKnown = true;
      }

      if (typeof data.shuffle === 'boolean') {
        mstreamModule.playerStats.shuffle = data.shuffle;
      }

      if (data.loop_mode) {
        mstreamModule.playerStats.shouldLoop = (data.loop_mode === 'all');
        mstreamModule.playerStats.shouldLoopOne = (data.loop_mode === 'one');
      }

      // Update position cache from server queue index
      if (typeof data.queue_index === 'number') {
        mstreamModule.positionCache.val = data.queue_index;
      }

      // Always re-read metadata from the playlist entry.
      // addSongWizard updates song.metadata in-place asynchronously,
      // so we need to pick up changes on every tick.
      mstreamModule.resetCurrentMetadata();
    });
  }

  function startPolling() {
    if (pollTimer) { return; }
    pollTimer = setInterval(syncStatus, 500);
  }

  // ── Load existing queue from Rust on page load ────────────────────────
  //
  // The engine outlives the page, so a reload rebuilds the list from the
  // engine's queue. Nothing here waits for a login token. This page is only
  // served to a session the server already accepted, and the webapp's
  // deferred scripts have put the API token in place by DOMContentLoaded —
  // getToken() finds it, falls back to the login cookie, and sends nothing
  // on a server with no users, where there is no token AT ALL. Waiting for
  // one is what used to leave the list empty there forever while the engine
  // kept playing.
  //
  // What can really happen is a transient miss (an engine mid-restart
  // answers 503, a dropped request): retry a few times, then say so once.

  var QUEUE_LOAD_ATTEMPTS = 5;
  var QUEUE_LOAD_RETRY_MS = 1000;

  function restoreQueue(data) {
    if (!data || !Array.isArray(data.queue) || data.queue.length === 0) { return; }

    // The engine's queue is the truth. A retry can land after something was
    // queued from this page, and that song is already in the engine's list —
    // so rebuild rather than append. splice, not a new array: Vue watches
    // this one.
    mstreamModule.playlist.splice(0, mstreamModule.playlist.length);

    // Build local playlist from the Rust queue (vpaths from proxy)
    data.queue.forEach(function (filepath) {
      mstreamModule.playlist.push({
        url: '',
        rawFilePath: filepath,
        filepath: filepath,
        metadata: {},
        authToken: getToken(),
        error: false
      });
    });

    mstreamModule.positionCache.val = typeof data.current_index === 'number' ? data.current_index : 0;

    // Look up metadata for each song
    if (typeof MSTREAMAPI !== 'undefined' && MSTREAMAPI.lookupMetadata) {
      mstreamModule.playlist.forEach(function (song) {
        MSTREAMAPI.lookupMetadata(song.rawFilePath).then(function (response) {
          if (response && response.metadata) {
            song.metadata = response.metadata;
          }
        }).catch(function () {});
      });
    }

    // Sync status to get current position/playing state
    syncStatus();
  }

  function loadExistingQueue(attempt) {
    attempt = attempt || 1;
    // Not apiGet(): it folds every failure into {}, which reads as "the
    // queue is empty" — and an empty queue is not retried.
    fetch('/api/v1/server-playback/queue', {
      headers: { 'x-access-token': getToken() }
    }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }).then(restoreQueue).catch(function (err) {
      if (attempt >= QUEUE_LOAD_ATTEMPTS) {
        console.warn('[mStream] Could not load the server audio queue: ' + (err && err.message ? err.message : err));
        return;
      }
      setTimeout(function () { loadExistingQueue(attempt + 1); }, QUEUE_LOAD_RETRY_MS);
    });
  }

  // ── Hide irrelevant UI elements ───────────────────────────────────────
  // Use CSS injection so elements are hidden immediately, even if Vue
  // components mount after DOMContentLoaded. This is the one place that
  // hides UI for server-audio mode: the /server-remote handler only swaps
  // scripts and replaces the visualizer button with a badge.

  var hideCSS = document.createElement('style');
  hideCSS.textContent =
    // Sidebar items
    '[onclick*="setupJukeboxPanel"],' +
    '[onclick*="autoDjPanel"],' +
    '[onclick*="setupTranscodePanel"]' +
    '{ display: none !important; }' +
    // Visualizer overlay
    '#main-overlay { display: none !important; }' +
    // Replay Gain button
    '.rpg { display: none !important; }' +
    // Playback rate button
    '[onclick*="openPlaybackModal"] { display: none !important; }' +
    // Live Playlist button and modal
    '[onclick*="openLivePlaylistModal"] { display: none !important; }' +
    '#livePlaylist { display: none !important; }';
  document.head.appendChild(hideCSS);

  // Stub out the visualizer
  window.VIZ = {
    toggleDom: function () {},
    connect: function () {},
    get: function () { return null; }
  };

  // Start polling when DOM is ready. The webapp's deferred scripts
  // (alpha/api.js, alpha/m.js) have run by DOMContentLoaded, so MSTREAMAPI
  // and its token are in place for the queue restore.
  function init() {
    startPolling();
    syncStatus();   // adopt the engine's state now, not at the first 500 ms tick
    loadExistingQueue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

  console.log('[mStream] Server Audio Mode — player commands routed to server');

  return mstreamModule;
}());
