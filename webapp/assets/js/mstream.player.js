const MSTREAMPLAYER = (() => {
  const mstreamModule = {};

  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    defaultBitrate: null,
    defaultCodec: null,
    selectedBitrate: null,
    selectedCodec: null,
  };

  // Playlist variables
  mstreamModule.positionCache = { val: -1 };
  mstreamModule.playlist = [];
  const cacheTimeout = 30000;
  
  var currentReplayGainAmp = 1.0;

  mstreamModule.editSongMetadata = function (key, value, songIndex) {
    const target = mstreamModule.playlist[songIndex];
    if (!target) { return; }
    const targetHash = target.metadata ? target.metadata.hash : undefined;
    for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
      const cur = mstreamModule.playlist[i];
      if (!cur.metadata) { continue; }
      // Match the same song by hash when BOTH carry one, else by filepath.
      // The `targetHash != null` guard matters because search hits carry the
      // LITE metadata object (no `hash`); without it two hashless songs would
      // collide on `undefined === undefined` and a single rating edit would
      // smear across every hashless queue entry. filepath is always present
      // and uniquely identifies a queue entry.
      const hashMatch = targetHash != null && cur.metadata.hash === targetHash;
      if (hashMatch || cur.filepath === target.filepath) {
        cur.metadata[key] = value;
      }
    }
  }

  mstreamModule.changeVolume = (newVolume) => {
    if (isNaN(newVolume) || newVolume < 0 || newVolume > 100) {
      return;
    }
    mstreamModule.playerStats.volume = newVolume;

    const rgainAdjustedVolume = newVolume / 100 * currentReplayGainAmp;
    getCurrentPlayer().playerObject.volume = rgainAdjustedVolume;
    getOtherPlayer().playerObject.volume = rgainAdjustedVolume;
  }

  // Scrobble function
  // This is a placeholder function that the API layer can take hold of to implement the scrobble call
  let scrobbleTimer;
  mstreamModule.scrobble = () => {
    MSTREAMAPI.scrobbleByFilePath(
      mstreamModule.getCurrentSong().rawFilePath, 
      (response, error) => {});
  }

  // The audioData looks like this
  // var song = {
  //   "url":"vPath/path/to/song.mp3?token=xxx",
  //   "filepath": "path/to/song.mp3"
  // }
  mstreamModule.addSong = (audioData, forceAutoPlayOff) => {
    if (!audioData.url || audioData.url == false) {
      return false;
    }

    audioData.error = false;

    // Handle shuffle
    if (mstreamModule.playerStats.shuffle === true) {
      const pos = Math.floor(Math.random() * (shuffleCache.length + 1));
      shuffleCache.splice(pos, 0, audioData);
    }

    return addSongToPlaylist(audioData, forceAutoPlayOff);
  }

  // Per-DJ-pick session cache for Last.fm similar-artists lookups.
  // Auto-DJ may retry up to N times against the same source artist
  // when blocked songs come back; this cache prevents hammering the
  // server-side /api/v1/lastfm/similar-artists endpoint with
  // identical queries inside a single pick attempt. Reset on every
  // pick attempt start (one cache per "what song are we looking
  // for similar artists to" decision).
  let _autoDjSimilarCache = { sourceArtist: null, artists: null };

  async function _fetchSimilarArtists(sourceArtist) {
    if (!sourceArtist) { return []; }
    if (_autoDjSimilarCache.sourceArtist === sourceArtist) {
      return _autoDjSimilarCache.artists || [];
    }
    // MSTREAMAPI.lastfmSimilarArtists() centralises the auth header,
    // JSON parse, and fallback-on-error semantics. Returns
    // `{ artists: [] }` on any failure.
    const data = await MSTREAMAPI.lastfmSimilarArtists(sourceArtist);
    const artists = Array.isArray(data?.artists) ? data.artists : [];
    _autoDjSimilarCache = { sourceArtist, artists };
    return artists;
  }

  // Build the /api/v1/db/random-songs body from AUTODJ state + the
  // currently-playing song (for the BPM anchor + source artist).
  // Lifts the velvet shape verbatim: bpmRanges + bpmRangesWide for
  // octave-equivalent BPM continuity, musicalKeys + requireMusicalKey
  // for harmonic mixing, artists for similar-artist priority.
  //
  // Returns `{ body, refBpm, refNeighbours }` — the latter two are
  // re-used by songBlocked when validating the server's pick.
  async function _buildAutoDjBody(opts) {
    // Single AUTODJ-presence check — bail with a minimal body if the
    // module didn't load (404, CSP block, etc.). Using
    // `typeof AUTODJ !== 'undefined'` consistently: bare-identifier
    // access on an undeclared global throws ReferenceError, while
    // `typeof` is the only undeclared-safe probe.
    const autodjLoaded = typeof AUTODJ !== 'undefined';
    const allVpaths = (MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.vpaths) || [];
    const djVpaths = (autodjLoaded && AUTODJ.state.djVpaths) || [];
    // djVpaths empty means "all" — invert into ignoreVPaths.
    const ignoreVPaths = djVpaths.length === 0
      ? []
      : allVpaths.filter(v => !djVpaths.includes(v));

    // opts.ignoreList lets the retry loop pass the SERVER's updated
    // ignoreList back in — without it, each retry would send the
    // same stale list and the server could re-pick the same blocked
    // song. Falls back to the persisted state when no override is
    // passed (the typical first-call case).
    const ignoreList = (opts && Array.isArray(opts.ignoreList))
      ? opts.ignoreList
      : (autodjLoaded ? AUTODJ.getIgnoreList() : []);

    const body = {
      ignoreList,
      minRating: (autodjLoaded && AUTODJ.state.djMinRating) || 0,
      ignoreVPaths,
    };

    // Current song's metadata — used for BPM anchor / Camelot anchor /
    // similar-artist source. May be undefined on the very first DJ
    // pick of a session.
    //
    // curBpm: don't use `Number(cur.bpm)` — `Number(null)` returns 0,
    // which Number.isFinite considers truthy and would silently pin
    // the anchor at zero. Explicit isFinite check on the raw value
    // routes null/undefined into the `requireBpm: true` fallback.
    const cur = mstreamModule.playerStats?.metadata || {};
    const curBpm = Number.isFinite(cur.bpm) ? cur.bpm : null;
    const curKey = cur['musical-key'];

    // BPM continuity — anchor priority:
    //   1. Rolling history average (set after at least one DJ pick)
    //   2. Currently-playing song's BPM (first pick of a session)
    let refBpm = null;
    if (autodjLoaded && AUTODJ.state.bpmContinuity) {
      const histAnchor = AUTODJ.getBpmAnchor();
      refBpm = Number.isFinite(histAnchor) ? histAnchor
             : Number.isFinite(curBpm) ? curBpm
             : null;
      if (Number.isFinite(refBpm)) {
        const tol = AUTODJ.state.bpmTolerance || 8;
        body.bpmRanges = AUTODJ.buildBpmRanges(refBpm, tol) || [];
        // Wide range: tol + 2 in each direction, used by the server
        // waterfall step 2 / 4 fallbacks if the tight range is empty.
        body.bpmRangesWide = AUTODJ.buildBpmRanges(refBpm, tol + 2) || [];
      } else {
        // No anchor yet — request the server still prefer rows with
        // BPM data so the pool stays tagged-first. The server's
        // tier filter handles the actual fallback to untagged rows.
        body.requireBpm = true;
      }
    }

    // Harmonic mixing — Camelot anchor lock semantics. First DJ pick
    // with a key sets the anchor; subsequent picks use the locked
    // anchor's neighbours (the relative + adjacent slots on the
    // wheel) so the session doesn't gradually wander off-key.
    let refNeighbours = null;
    if (autodjLoaded && AUTODJ.state.harmonicMixing) {
      let anchor = AUTODJ.getCamelotAnchor();
      if (!anchor && curKey) {
        // First call of the session — lock the anchor on whatever's
        // playing right now.
        AUTODJ.setCamelotAnchor(curKey);
        anchor = AUTODJ.getCamelotAnchor();
      }
      if (anchor) {
        const neighbours = AUTODJ.camelotNeighbours(anchor);
        refNeighbours = neighbours;
        body.musicalKeys = [...neighbours];
      }
      // Always require the column non-null when harmonic mixing is
      // on. Untagged rows can't be wheel-aligned anyway.
      body.requireMusicalKey = true;
    }

    // Similar artists — Last.fm proxy lookup, cached per source
    // artist for this pick attempt.
    if (autodjLoaded && AUTODJ.state.similar && cur.artist) {
      const similar = await _fetchSimilarArtists(cur.artist);
      if (similar.length > 0) { body.artists = similar; }
    }

    // Artist cooldown — exclude the last-N recently-played artists.
    if (autodjLoaded && AUTODJ.state.djArtistHistory.length > 0) {
      body.ignoreArtists = [...AUTODJ.state.djArtistHistory];
    }

    // Genre filter — server-applied via the EXISTS / NOT EXISTS
    // subquery the buildGenreFilter helper emits. Only sent when the
    // toggle is on AND the user has selected at least one genre;
    // empty list is a no-op server-side, but skipping the field
    // entirely keeps the payload tidy.
    if (autodjLoaded
        && AUTODJ.state.djGenreEnabled
        && Array.isArray(AUTODJ.state.djGenres)
        && AUTODJ.state.djGenres.length > 0) {
      body.genres = [...AUTODJ.state.djGenres];
      body.genreMode = AUTODJ.state.djGenreMode;
    }

    // Sonic similarity — constrain picks to the discovery-embedding
    // neighborhood of the session anchor (PR #697 server API). Gated on
    // the ping capability flag so feature-off servers never receive the
    // params (they would 403). Which paths land in `similarTo` is the
    // anchor policy (rolling history vs locked seed) — AUTODJ owns it.
    if (autodjLoaded
        && AUTODJ.state.sonicEnabled
        && MSTREAMAPI.currentServer.discovery === true) {
      const curSong = mstreamModule.getCurrentSong && mstreamModule.getCurrentSong();
      const sonic = AUTODJ.buildSonicParams(curSong ? curSong.rawFilePath : null);
      if (sonic) {
        body.similarTo = sonic.similarTo;
        body.minSimilarity = sonic.minSimilarity;
      } else {
        // No resolvable anchor: empty queue and no explicit seed. The
        // pick can't honor the "within the similarity range" promise —
        // fail loud with a pointer at the seed picker rather than
        // silently picking out-of-range.
        const err = new Error('sonic seed required');
        err.djToast = {
          title: t('autoDJ.sonicSeedNeededTitle'),
          message: t('autoDJ.sonicSeedNeeded'),
        };
        throw err;
      }
    }

    return { body, refBpm, refNeighbours };
  }

  // Auto-DJ song-change side-effects. Invoked from
  // resetCurrentMetadata every time the playing song changes (or its
  // metadata is refreshed). Runs only when Auto-DJ is on.
  //
  // Three branches:
  //   • DJ-picked && not-yet-counted → push BPM into rolling
  //     history, lock the Camelot anchor if absent, mark this
  //     filepath as counted so back-navigation to the same song
  //     doesn't double-count.
  //   • DJ-picked && already-counted → user navigated BACK to a song
  //     Auto-DJ already counted. No-op — re-pushing would pollute
  //     the rolling BPM history (the user's intent is "play this
  //     again", not "anchor on this again").
  //   • Not DJ-picked → song the user added manually (clicked a
  //     queue entry, started a fresh queue). Reset BPM history +
  //     Camelot anchor so the next DJ pick gates off this new lane,
  //     not the old session's.
  //
  // The first DJ-on song of any session always lands on the manual
  // branch (no _djPicked flag yet) which is fine — resetAnchors on
  // a clean session is a no-op.
  //
  // Counted state lives in AUTODJ.state.djCountedFilepaths (persisted
  // + ring-buffer capped) rather than on the song's metadata object,
  // so the flag survives a fresh fetch of the same row and doesn't
  // leak into scrobble payloads / DOM bindings.
  function _updateAutoDjAnchorsOnSongChange(curSong) {
    if (typeof AUTODJ === 'undefined') { return; }
    if (mstreamModule.playerStats.autoDJ !== true) { return; }
    const meta = curSong.metadata || {};
    const filepath = curSong.rawFilePath;
    const djPicked = meta._djPicked === true;
    if (djPicked) {
      if (AUTODJ.isFilepathCounted(filepath)) { return; }
      if (Number.isFinite(meta.bpm)) {
        AUTODJ.pushBpmHistory(meta.bpm);
      }
      // Lock anchor on the first DJ pick that has a key tag.
      if (!AUTODJ.getCamelotAnchor() && meta['musical-key']) {
        AUTODJ.setCamelotAnchor(meta['musical-key']);
      }
      // Rolling sonic anchor — each DJ pick joins the last-N window the
      // next request's `similarTo` centroid averages over.
      if (AUTODJ.state.sonicEnabled) {
        AUTODJ.pushSonicHistory(filepath);
      }
      AUTODJ.markFilepathCounted(filepath);
    } else {
      AUTODJ.resetAnchors();
    }
  }

  // Re-entrancy guard — multiple triggers (song-end, removeSong,
  // clearPlaylist, toggleAutoDJ) can fire autoDJ() in quick
  // succession. Without this, parallel invocations race on the
  // shared AUTODJ state (artist cooldown, ignoreList, BPM history)
  // AND end up queuing multiple DJ picks back-to-back. The guard
  // makes autoDJ() effectively single-shot: while one call is in
  // flight, subsequent calls return the same promise.
  let _autoDjInFlight = null;

  // Abort signal for the current Auto-DJ fetch. toggleAutoDJ(off)
  // aborts it so the in-flight /random-songs response doesn't land
  // back into stale state after the user has turned the feature off.
  let _autoDjAbortController = null;

  async function autoDJ() {
    if (_autoDjInFlight) { return _autoDjInFlight; }
    _autoDjAbortController = new AbortController();
    _autoDjInFlight = (async () => {
      try {
        await _autoDjRunOnce(_autoDjAbortController.signal);
      } catch (err) {
        // AbortError surfaces here when toggleAutoDJ aborts mid-fetch;
        // suppress the toast in that case — it's an intended teardown,
        // not a failure.
        if (err?.name !== 'AbortError') {
          // Errors that know their own user-facing story (sonic seed
          // missing / out-of-range) carry a djToast; everything else
          // gets the generic failure.
          iziToast.warning({
            title: err?.djToast?.title || 'Auto DJ Failed',
            message: err?.djToast?.message || '',
            position: 'topCenter',
            timeout: err?.djToast ? 6000 : 3500
          });
        }
      } finally {
        _autoDjInFlight = null;
        _autoDjAbortController = null;
      }
    })();
    return _autoDjInFlight;
  }

  async function _autoDjRunOnce(signal) {
    // Snapshot the source artist so the cache hit-check in
    // _fetchSimilarArtists works correctly across this pick attempt.
    _autoDjSimilarCache = { sourceArtist: null, artists: null };

    const autodjLoaded = typeof AUTODJ !== 'undefined';
    let picked = null;
    let lastResponse = null;
    // ignoreList is FED BACK from the server across retries. Without
    // this, retry 2..N would send the same stale ignoreList that
    // retry 1 sent, and the server might re-pick the same blocked
    // song from the same SQL result set.
    let ignoreList = autodjLoaded ? AUTODJ.getIgnoreList() : [];
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { body, refBpm, refNeighbours } = await _buildAutoDjBody({ ignoreList });
      let res;
      try {
        res = await MSTREAMAPI.getRandomSong(body, { signal });
      } catch (err) {
        // Sonic-mode failures have specific, actionable stories — map
        // the server's distinct 400s onto them so the user knows
        // whether to loosen the slider or pick another seed. req()
        // attaches status + parsed body to thrown errors.
        if (err?.name !== 'AbortError' && body.similarTo) {
          const serverMsg = err?.body?.error || '';
          if (/similarity range/i.test(serverMsg)) {
            err.djToast = { title: t('autoDJ.sonicToastTitle'), message: t('autoDJ.sonicNoMatch') };
          } else if (/analyzed/i.test(serverMsg)) {
            err.djToast = { title: t('autoDJ.sonicToastTitle'), message: t('autoDJ.sonicSeedUnanalyzed') };
          }
        }
        throw err;
      }
      lastResponse = res;
      // Server returns the updated ignoreList (input list + the
      // just-picked index). Carry it into the next iteration so a
      // blocked retry doesn't re-pick the same song.
      if (Array.isArray(res?.ignoreList)) { ignoreList = res.ignoreList; }

      const song = res.songs && res.songs[0];
      if (!song) { break; }

      // Client-side post-fetch guard. Velvet's `_djSongBlocked` —
      // the server's tier filter already prefers in-range rows, but
      // in degraded fallback cases (step 5, step 10) the candidate
      // can still be off-target. Retry-on-blocked closes the gap.
      // Songs with NULL bpm/key pass through (server already
      // exhausted the tagged options).
      const blocked = (autodjLoaded && AUTODJ.songBlocked)
        ? AUTODJ.songBlocked(song.metadata, {
            bpmContinuity: AUTODJ.state.bpmContinuity,
            refBpm,
            bpmTolerance: AUTODJ.state.bpmTolerance,
            harmonicMixing: AUTODJ.state.harmonicMixing,
            refNeighbours,
            // Keyword filter — independent of BPM/harmonic toggles.
            // Server doesn't know about user-supplied skip words
            // (kept entirely client-side per velvet's design), so
            // the retry loop is the only place this gets applied.
            filterEnabled: AUTODJ.state.djFilterEnabled,
            filterWords: AUTODJ.state.djFilterWords,
            // Genre filter — defence-in-depth check against the
            // server's pick. Server already filters via EXISTS /
            // NOT EXISTS, so a survivor of the server filter
            // should never block here under normal operation. The
            // rare case this handles: a server-returned row whose
            // track_genres rows were modified by a rescan between
            // the server SELECT and the client receiving metadata.
            genreEnabled: AUTODJ.state.djGenreEnabled,
            genreMode: AUTODJ.state.djGenreMode,
            genres: AUTODJ.state.djGenres,
          })
        : false;
      if (!blocked) { picked = song; break; }
    }

    // If every retry was blocked, fall through with whatever the
    // last response was so the session doesn't stall completely.
    // The server's fallback chain is already exhausting all viable
    // alternatives; refusing here just means the DJ stops.
    if (!picked && lastResponse?.songs?.[0]) {
      picked = lastResponse.songs[0];
    }
    if (!picked) {
      throw new Error('no song in response');
    }

    // Mark as a DJ pick so the song-change handler later knows to
    // push to BPM history (vs. resetting anchors on a manual pick).
    // `_djPicked` is the only metadata flag the song carries; the
    // "have we counted this song's BPM yet" state lives in AUTODJ
    // proper (state.djCountedFilepaths), not on the metadata.
    const meta = { ...(picked.metadata || {}), _djPicked: true };

    // Persist updated ignoreList + push picked artist to cooldown.
    if (autodjLoaded) {
      AUTODJ.setIgnoreList(ignoreList);
      if (meta.artist) { AUTODJ.pushArtistHistory(meta.artist); }
    }
    // Legacy bridge — keep the old global in sync until everywhere
    // else has migrated off it.
    autoDjIgnoreArray = ignoreList;

    // Similar-artists info strip — surface WHY this pick was made
    // when the user has similar mode on. Velvet does this with a
    // sticky 30s strip; alpha uses iziToast.info (8s) to match the
    // existing toast vocabulary. Only fires when we actually used
    // similar artists for this pick (cache populated AND non-empty).
    //
    // Truncated to first 5 candidates so the toast doesn't become a
    // wall of text — the rest are still in the cache for debugging
    // via the dev console but the user gets the gist.
    _showSimilarArtistsInfoStrip();

    // Await so async failures inside addSongWizard surface through
    // the outer try/catch and trigger the iziToast warning instead
    // of becoming a silent unhandled rejection.
    await VUEPLAYERCORE.addSongWizard(picked.filepath, meta);
  }

  // Info strip helper — fires an iziToast.info if similar-mode is on
  // AND the pick attempt actually queried Last.fm AND got results.
  // No-ops in every other case (similar off, no source artist, cache
  // empty, iziToast missing). Keeps the call site clean.
  function _showSimilarArtistsInfoStrip() {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.state.similar) { return; }
    if (typeof iziToast === 'undefined') { return; }
    const cache = _autoDjSimilarCache;
    if (!cache || !cache.sourceArtist) { return; }
    const candidates = Array.isArray(cache.artists) ? cache.artists : [];
    if (candidates.length === 0) { return; }
    const SHOW = 5;
    const shown = candidates.slice(0, SHOW).join(', ');
    const extra = candidates.length > SHOW ? candidates.length - SHOW : 0;
    iziToast.info({
      title: t('autoDJ.similarInfoTitle'),
      message: extra > 0
        ? t('autoDJ.similarInfoBodyMore', { source: cache.sourceArtist, candidates: shown, extra })
        : t('autoDJ.similarInfoBody',     { source: cache.sourceArtist, candidates: shown }),
      position: 'topCenter',
      timeout: 8000,
      close: true,
    });
  }

  function addSongToPlaylist(song, forceAutoPlayOff) {
    mstreamModule.playlist.push(song);

    // If this the first song in the list
    if (mstreamModule.playlist.length === 1) {
      mstreamModule.positionCache.val = 0;
      return goToSong(mstreamModule.positionCache.val, forceAutoPlayOff);
    }

    // TODO: Check if we are at the end of the playlist and nothing is playing.

    // Cache song if appropriate
    if ((!cacheTimer) && mstreamModule.playlist.length > mstreamModule.positionCache.val + 1 && mstreamModule.positionCache.val === mstreamModule.playlist.length -2) {
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () { 
        setCachedSong(mstreamModule.positionCache.val + 1); 
        cacheTimer = undefined;
      }, cacheTimeout);
    }

    return true;
  }

  mstreamModule.insertSongAt = (song, position, playNow) => {
    if (!song.url || song.url == false) {
      return false;
    }

    song.error = false;

    mstreamModule.playlist.splice(position, 0, song);

    if (playNow) {
      mstreamModule.positionCache.val = position;
      goToSong(mstreamModule.positionCache.val);
    }

    // TODO: Check cache. Since we use this for play now only, the cache is usually preserved
  }

  mstreamModule.clearAndPlay = function (song) {
    // Clear playlist
    mstreamModule.playlist = [];
    return addSong(song);
  }

  mstreamModule.clearPlaylist = function () {
    while (mstreamModule.playlist.length > 0) { mstreamModule.playlist.pop(); }
    mstreamModule.positionCache.val = -1;

    clearEnd();

    // Clear shuffle as well
    if (mstreamModule.playerStats.shuffle === true) {
      // Clear Shuffle Cache
      while (shuffleCache.length > 0) { shuffleCache.pop(); }
    }

    // clearPlaylist also drops the cascade — re-bootstrap with two
    // songs so the post-clear playback has the same lookahead as a
    // fresh Auto-DJ start. (Without this, the same one-song stall
    // hits whenever the user clears their playlist mid-session.)
    if (mstreamModule.playerStats.autoDJ === true) {
      _autoDjQueueN(2);
    }

    return true;
  }

  mstreamModule.nextSong = function () {
    // Stop the current song
    return goToNextSong();
  }

  mstreamModule.previousSong = function () {
    return goToPreviousSong();
  }

  mstreamModule.goToSongAtPosition = function (position) {
    if (!mstreamModule.playlist[position]) {
      return false;
    }

    clearEnd();

    mstreamModule.positionCache.val = position;
    return goToSong(mstreamModule.positionCache.val);
  }

  mstreamModule.removeSongAtPosition = function (position, sanityCheckUrl) {
    // Check that position is filled
    if (position > mstreamModule.playlist.length || position < 0) {
      return false;
    }
    // If sanityCheckUrl, check that url are the same
    if (sanityCheckUrl && sanityCheckUrl != mstreamModule.playlist[position].url) {
      return false;
    }

    var removedSong = mstreamModule.playlist[position];

    // Remove song
    mstreamModule.playlist.splice(position, 1);

    if (mstreamModule.playerStats.shuffle === true) {
      //  Remove song from shuffle Cache
      for (var i = 0, len = shuffleCache.length; i < len; i++) {
        // Check if this is the current song
        if (removedSong === shuffleCache[i]) {
          shuffleCache.splice(i, 1);
        }
      }
      for (var i = 0, len = shufflePrevious.length; i < len; i++) {
        // Check if this is the current song
        if (removedSong === shufflePrevious[i]) {
          shufflePrevious.splice(i, 1);
        }
      }
    }

    // Handle case where user removes current song and it's the last song in the playlist
    if (position === mstreamModule.positionCache.val && position === mstreamModule.playlist.length) {
      clearEnd();
      // Go to random song if random is set
      if (mstreamModule.playerStats.shuffle === true) {
        goToNextSong();
      } else if (mstreamModule.playerStats.shouldLoop === true) { // loop is set
        mstreamModule.positionCache.val = 0;
        goToSong(mstreamModule.positionCache.val);
      } else { // Reset to start is nothing is set
        mstreamModule.positionCache.val = -1;
      }
    } else if (position === mstreamModule.positionCache.val) { // User removes currently playing song
      // Go to next song
      clearEnd();

      // If random is set, go to random song
      if (mstreamModule.playerStats.shuffle === true) {
        goToNextSong();
      } else {
        goToSong(mstreamModule.positionCache.val);
      }

    } else if (position < mstreamModule.positionCache.val) {
      // Lower position cache by 1 if necessary
      mstreamModule.positionCache.val--;
    } else if (position === (mstreamModule.positionCache.val + 1)) {
      if(mstreamModule.positionCache.val === (mstreamModule.playlist.length - 1) && mstreamModule.playerStats.autoDJ === true) {
          autoDJ();
      }

      // If the next song is removed, reset cache
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () {
        cacheTimer = undefined;
        if(mstreamModule.playerStats.shuffle === true) {
          // TODO: This doesn't actually get triggered if remove the next shuffle song
          // if(shuffleCache[0]) {
          //   for (var i = 0; i < mstreamModule.playlist.length; i++) {
          //     if(mstreamModule.playlist[i] === shuffleCache[shuffleCache.length - 1]) {
          //       setCachedSong(i);
          //       break;
          //     }
          //   }
          // }
        } else if (mstreamModule.playerStats.shouldLoop === true) {
          if (mstreamModule.positionCache.val === (mstreamModule.playlist.length - 1)) {
            setCachedSong(0);
          }  else {
            setCachedSong(mstreamModule.positionCache.val + 1);
          }
        } else {
          setCachedSong(mstreamModule.positionCache.val + 1);
        }
  
      }, cacheTimeout);
    }
  }

  mstreamModule.getCurrentSong = () => {
    return getCurrentPlayer().songObject;
  }

  function goToPreviousSong() {
    // If random is set, go to previous song from cache
    if (mstreamModule.playerStats.shuffle === true) {
      // Check that there is a previous song to go back to
      if (shufflePrevious.length <= 1) {
        return;
      }

      // Pop a song and go to the last song
      var nextSong = shufflePrevious.pop();
      shuffleCache.push(nextSong);

      var currentSong = shufflePrevious[shufflePrevious.length - 1];

      // Reset position cache
      for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
        // Check if this is the current song
        if (currentSong === mstreamModule.playlist[i]) {
          mstreamModule.positionCache.val = i;
        }
      }
      clearEnd();

      goToSong(mstreamModule.positionCache.val);
      return;
    }

    // Make sure there is a previous song
    if (mstreamModule.positionCache.val < 1) {
      return false;
    }

    // Set previous song and play
    clearEnd();
    mstreamModule.positionCache.val--;
    return goToSong(mstreamModule.positionCache.val);
  }

  function goToNextSong() {
    // If random is set, go to random song
    if (mstreamModule.playerStats.shuffle === true) {
      // Chose a random value
      var nextSong = shuffleCache.pop();

      // Prevent same song from playing twice after a re-shuffle
      if (nextSong === mstreamModule.getCurrentSong()) {
        console.log('DUPEEEEE');
        shuffleCache.unshift(nextSong);
        nextSong = shuffleCache.pop();
      }

      if (shuffleCache.length === 0) {
        newShuffle();
      }

      // Reset position cache
      for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
        // Check if this is the current song
        if (nextSong === mstreamModule.playlist[i]) {
          mstreamModule.positionCache.val = i;
        }
      }
      clearEnd();

      goToSong(mstreamModule.positionCache.val);

      // Remove duplicates from shuffle previous
      for (var i = 0, len = shufflePrevious.length; i < len; i++) {
        // Check if this is the current song
        if (nextSong === shufflePrevious[i]) {
          shufflePrevious.splice(i, 1);
        }
      }

      shufflePrevious.push(nextSong);
      return;
    }

    // Check if the next song exists
    if (!mstreamModule.playlist[mstreamModule.positionCache.val + 1]) {
      // If loop is set and no other song, go back to first song
      if (mstreamModule.playerStats.shouldLoop === true && mstreamModule.playlist.length > 0) {
        mstreamModule.positionCache.val = 0;
        clearEnd();

        return goToSong(mstreamModule.positionCache.val);
      }
      // Self-healing fallback: Auto-DJ is on but we've run out of
      // queued songs. The bootstrap in toggleAutoDJ + clearPlaylist
      // and the line-732 lookahead trigger in goToSong are supposed
      // to keep at least one song ahead at all times, but a network
      // hiccup or a failed pick (no matches for the current filter)
      // can leave the playlist dry. Without this branch the session
      // hangs silently — the song ends, onended fires goToNextSong,
      // playlist[pos+1] is undefined → we return false and nothing
      // happens. Re-fire Auto-DJ; the in-line .then advances when
      // the pick lands.
      if (mstreamModule.playerStats.autoDJ === true) {
        autoDJ().then(() => {
          if (mstreamModule.playlist[mstreamModule.positionCache.val + 1]) {
            mstreamModule.positionCache.val++;
            clearEnd();
            goToSong(mstreamModule.positionCache.val);
          }
          // If autoDJ() failed to add a song (toast already shown),
          // the session stays paused at end-of-playlist. The user can
          // toggle Auto-DJ off/on to retry, or adjust filters and
          // toggle again. Better than blocking on a retry loop.
        });
        return true;
      }
      return false;
    }

    // Load up next song
    mstreamModule.positionCache.val++;
    clearEnd();
    return goToSong(mstreamModule.positionCache.val);
  }


  function getCurrentPlayer() {
    if (curP === 'A') {
      return playerA;
    } else if (curP === 'B') {
      return playerB;
    }

    return false;
  }

  function getOtherPlayer() {
    if (curP === 'A') {
      return playerB;
    } else if (curP === 'B') {
      return playerA;
    }

    return false;
  }

  function flipFlop() {
    if (curP === 'A') {
      curP = 'B';
    } else if (curP === 'B') {
      curP = 'A';
    }

    return curP;
  }


  function goToSong(position, forceAutoPlayOff) {
    if (!mstreamModule.playlist[position]) {
      return false;
    }

    if (mstreamModule.playerStats.autoDJ === true && position === mstreamModule.playlist.length - 1) {
      autoDJ();
    }

    // Reset Duration
    mstreamModule.playerStats.duration = 0;
    mstreamModule.playerStats.currentTime = 0;

    // Stop the current song
    getCurrentPlayer().playerObject.pause();
    getCurrentPlayer().playerObject.currentTime = 0;

    // Song is cached
    flipFlop();
    if (getCurrentPlayer().songObject === mstreamModule.playlist[position]) {
      // Play
      mstreamModule.playPause();
    } else {
      // console.log('DID NOT USE CACHE');
      setMedia(mstreamModule.playlist[position], getCurrentPlayer(), typeof forceAutoPlayOff !== 'undefined' ? !forceAutoPlayOff : true);
    }

    mstreamModule.resetCurrentMetadata();
    
    // connect to visualizer
    if (typeof VIZ !== 'undefined') {
      var audioCtx = VIZ.get();
      try {
        var audioNode = getCurrentPlayer().playerObject;
        if (!audioNode.previouslyConnectedViz) {
          var analyser = audioCtx.createAnalyser();
          var source = audioCtx.createMediaElementSource(audioNode);
          source.connect(analyser);
          source.connect(audioCtx.destination);
          VIZ.connect(analyser);
          audioNode.previouslyConnectedViz = true;
        }
      } catch( err) {
        console.log(err);
      }
    }

    // Cache next song
    // The timer prevents excessive caching when the user starts button mashing
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      cacheTimer = undefined;
      if(mstreamModule.playerStats.shuffle === true) {
        if(shuffleCache[0]) {
          for (var i = 0; i < mstreamModule.playlist.length; i++) {
            if(mstreamModule.playlist[i] === shuffleCache[shuffleCache.length - 1]) {
              setCachedSong(i);
              break;
            }
          }
        }
      } else if (mstreamModule.playerStats.shouldLoop === true) {
        if (position === (mstreamModule.playlist.length - 1)) {
          setCachedSong(0);
        }  else {
          setCachedSong(position + 1);
        }
      } else {
        setCachedSong(position + 1);
      }

    }, cacheTimeout);

    // Scrobble song after 30 seconds
    clearTimeout(scrobbleTimer);
    scrobbleTimer = setTimeout(() => { mstreamModule.scrobble() }, 30000);
  }

  // Should be called whenever the "metadata" field of the current song is changed, or
  // the current song is changed.
  mstreamModule.resetCurrentMetadata = () => {
    const curSong = getCurrentPlayer().songObject;
    mstreamModule.playerStats.metadata.artist = curSong.metadata && curSong.metadata.artist ? curSong.metadata.artist : "";
    mstreamModule.playerStats.metadata.album = curSong.metadata && curSong.metadata.album  ? curSong.metadata.album : "";
    mstreamModule.playerStats.metadata.track = curSong.metadata && curSong.metadata.track ? curSong.metadata.track : "";
    mstreamModule.playerStats.metadata.title = curSong.metadata && curSong.metadata.title ? curSong.metadata.title : "";
    mstreamModule.playerStats.metadata.year = curSong.metadata && curSong.metadata.year ? curSong.metadata.year : "";
    mstreamModule.playerStats.metadata['album-art'] = curSong.metadata && curSong.metadata['album-art'] ? curSong.metadata['album-art'] : "";
    mstreamModule.playerStats.metadata['replaygain-track-db'] = curSong.metadata && curSong.metadata['replaygain-track-db'] ? curSong.metadata['replaygain-track-db'] : "";
    // V32 columns — used by the now-playing pill display + Auto-DJ
    // BPM continuity / harmonic-mixing anchor management.
    mstreamModule.playerStats.metadata.bpm = curSong.metadata && Number.isFinite(curSong.metadata.bpm) ? curSong.metadata.bpm : null;
    mstreamModule.playerStats.metadata['musical-key'] = curSong.metadata && curSong.metadata['musical-key'] ? curSong.metadata['musical-key'] : null;
    // Lyrics availability — drives the now-playing "Lyrics" tag. Copied here
    // (like bpm / musical-key above) so it tracks song changes; the metadata
    // API supplies these flags (renderMetadataObj's has-lyrics / has-synced-lyrics).
    mstreamModule.playerStats.metadata['has-lyrics'] = !!(curSong.metadata && curSong.metadata['has-lyrics']);
    mstreamModule.playerStats.metadata['has-synced-lyrics'] = !!(curSong.metadata && curSong.metadata['has-synced-lyrics']);
    mstreamModule.playerStats.metadata.filepath = curSong.rawFilePath;

    // Auto-DJ song-change side-effects — pulled into a helper so the
    // metadata-reset flow stays focused on rendering the now-playing
    // pill. See _updateAutoDjAnchorsOnSongChange for branching logic.
    _updateAutoDjAnchorsOnSongChange(curSong);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: mstreamModule.playerStats.metadata.title,
        artist: mstreamModule.playerStats.metadata.artist,
        album: mstreamModule.playerStats.metadata.album,
        artwork: [] //TODO: Get album art working here
      });
    }
    
    let pageTitle = (mstreamModule.playerStats.metadata.title) ? 
    mstreamModule.playerStats.metadata.title + ' - ' + mstreamModule.playerStats.metadata.artist : // if metadata exists
        (mstreamModule.playerStats.metadata.filepath ? mstreamModule.playerStats.metadata.filepath.split('/').pop() : 'mStream Music');
    document.title = pageTitle; // set page title when song is playing
    
    mstreamModule.updateReplayGainFromSong(curSong);
  }

  // Update ReplayGain state from given song, if required.
  mstreamModule.updateReplayGainFromSong = function (song) {
    console.assert(song);
    var newRgAmpValue = undefined;

    if (mstreamModule.playerStats.replayGain) {
      if (song.metadata) {
        const rgainDb = song.metadata['replaygain-track-db'];
        if (rgainDb) {
          // Note: the music-metadata package has a similar calculation in its Utils class, and that's used to
          // calculate a returned 'ratio' value. However, the calculation used there is actually calculating the power
          // ratio and not the amplitude ratio as required. As power is amplitude squared, that results in a volume
          // reduction that's too small (i.e. 0.25**2 = 0.00625).
          newRgAmpValue = Math.pow(10, (rgainDb + mstreamModule.playerStats.replayGainPreGainDb) / 20)
        }
      }

      if (newRgAmpValue === undefined) {
        currentReplayGainAmp = 0.316; // -10 db for songs without ReplayGain info.
      } else {
        currentReplayGainAmp = newRgAmpValue;
      }
    } else {
      currentReplayGainAmp = 1.0;
    }
    
    mstreamModule.changeVolume(mstreamModule.playerStats.volume);
  }

  mstreamModule.resetPositionCache = function () {
    var len;

    const curSong = getCurrentPlayer().songObject;

    for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
      // Check if this is the current song
      if (curSong === mstreamModule.playlist[i]) {
        mstreamModule.positionCache.val = i;
        return;
      }
    }

    // No song found, reset
    mstreamModule.positionCache.val = -1;
  }

  // ========================= Howler Player ===============
  function howlPlayerPlay() {
    const localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = true;

    localPlayer.playerObject.play();
  }
  function howlPlayerPause() {
    const localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = false;

    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause() {
    const localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.paused === false) {
      mstreamModule.playerStats.playing = false;
      localPlayer.playerObject.pause();
      document.title = "mStream Music"
    } else {
      localPlayer.playerObject.play();
      
      let pageTitle = (mstreamModule.playerStats.metadata.title) ? 
        mstreamModule.playerStats.metadata.title + ' - ' + mstreamModule.playerStats.metadata.artist : // if metadata exists
        (mstreamModule.playerStats.metadata.filepath ? mstreamModule.playerStats.metadata.filepath.split('/').pop() : 'mStream Music');
      document.title = pageTitle; // set page title when song is playing
      
      mstreamModule.playerStats.playing = true;
    }
  }
  // ========================================================


  function clearEnd() {
    const localPlayer = getCurrentPlayer();
    localPlayer.playerObject.onended = () => {};
  }

  // Player
  // Event: On Song end
  // Set Media
  // Play, pause, skip, etc
  mstreamModule.playPause = () => {
    return howlPlayerPlayPause();
  }

  mstreamModule.changePlaybackRate = (newRate) => {
    newRate = Number(newRate);
    if (isNaN(newRate) || newRate > 10 || newRate < 0.1) {
      console.log('Bad New Rate');
      return;
    }

    mstreamModule.playerStats.playbackRate = newRate;

    const lPlayer = getCurrentPlayer();
    lPlayer.playerObject.playbackRate = newRate;
    
    const oPlayer = getOtherPlayer();
    oPlayer.playerObject.playbackRate = newRate;
  }

  mstreamModule.playerStats = {
    playbackRate: 1,
    duration: 0,
    currentTime: 0,
    playing: false,
    shouldLoop: false,
    shouldLoopOne: false,
    shuffle: false,
    volume: 100,
    metadata: {
      "artist": "",
      "album": "",
      "track": "",
      "title": "",
      "year": "",
      "album-art": "",
      "filepath": "",
      "has-lyrics": false,
      "has-synced-lyrics": false,
    },
    replayGain: false,
    replayGainPreGainDb: 0
  }

  function makeNewPlayer(playerObj) {
    playerObj.playerObject = new Audio();
    playerObj.playerObject.volume = mstreamModule.playerStats.volume/100;
    playerObj.playerObject.playbackRate =  mstreamModule.playerStats.playbackRate;

    playerObj.playerObject.addEventListener('error', err => {
      console.log(err)
      if (playerObj.songObject) { playerObj.songObject.error = true; }
      if (iziToast) {
        iziToast.error({
          title: 'Failed To Play Song',
          position: 'topCenter',
          timeout: 3500
        });
      }

      if (playerObj === getCurrentPlayer()) {
        goToNextSong();
      }else {
        // Invalidate cache
        const newOtherPlayerObject = getOtherPlayer();
        newOtherPlayerObject.songObject = false;
        playerObj.playerObject.onended = () => {};
      }
    });

    playerObj.playerObject.addEventListener('timeupdate', () => {
      const cur = getCurrentPlayer();
      // Virtual playhead: a server-side seek reloads the stream from `-ss
      // offset`, so the element's own currentTime restarts at 0. Add the
      // offset back to report the true position.
      const absTime = (cur.seekOffset || 0) + cur.playerObject.currentTime;
      mstreamModule.playerStats.currentTime = absTime;

      // Duration: a chunked transcode stream has no usable audio.duration
      // (Infinity until fully buffered, and a seeked stream only spans the
      // remainder), so trust the track's metadata duration there. Direct files
      // report an exact audio.duration.
      const adur = cur.playerObject.duration;
      const metaDur = cur.songObject && cur.songObject.metadata ? Number(cur.songObject.metadata.duration) : NaN;
      let fullDur;
      if (isTranscoding()) {
        fullDur = (Number.isFinite(metaDur) && metaDur > 0)
          ? metaDur : (Number.isFinite(adur) ? adur : 0);
      } else {
        fullDur = (Number.isFinite(adur) && adur > 0)
          ? adur : (Number.isFinite(metaDur) ? metaDur : 0);
      }
      mstreamModule.playerStats.duration = fullDur;

      // CHAPTER presentation: a chapter entry reports time/duration
      // relative to its slice, and advances the queue at its boundary.
      const ch = cur.songObject && cur.songObject.chapter;
      if (ch) {
        // Transcode note: for a chapter entry, metadata.duration is the
        // CHAPTER length (set at expansion), so the transcode fullDur is
        // already slice-scoped; the end-of-file for `end == null` then
        // comes from the element's natural 'ended'.
        const chEnd = (ch.end != null)
          ? ch.end
          : (!isTranscoding() && Number.isFinite(adur) && adur > 0 ? adur : null);
        mstreamModule.playerStats.currentTime = Math.max(0, absTime - ch.start);
        if (isTranscoding()) {
          // fullDur is metadata.duration = chapter length already
        } else if (chEnd != null && chEnd > ch.start) {
          mstreamModule.playerStats.duration = chEnd - ch.start;
        }

        // Boundary handling — only the live player's own events advance
        // the queue (the idle pre-cache element fires a timeupdate when
        // its pending chapter seek lands).
        if (playerObj === cur && !cur.chapterEnded
            && ch.end != null && absTime >= ch.end) {
          const pos = mstreamModule.positionCache.val;
          const next = mstreamModule.playlist[pos + 1];
          const seamless = mstreamModule.playerStats.shuffle !== true
            && mstreamModule.playerStats.shouldLoopOne !== true
            && next && next.chapter && next.url === cur.songObject.url
            && Math.abs(next.chapter.start - ch.end) < 0.01;
          if (seamless) {
            // Same file, contiguous slice: keep the element playing
            // straight through the boundary (true gapless — essential
            // for continuous mixes) and just advance the queue pointer.
            mstreamModule.positionCache.val = pos + 1;
            cur.songObject = next;
            mstreamModule.resetCurrentMetadata();
            clearTimeout(scrobbleTimer);
            scrobbleTimer = setTimeout(() => { mstreamModule.scrobble() }, 30000);
          } else {
            cur.chapterEnded = true;
            callMeOnStreamEnd();
          }
        }
      }
    });
  }

  const playerA = {
    playerObject: false,
    songObject: false
  }
  const playerB = {
    playerObject: false,
    songObject: false
  }

  makeNewPlayer(playerA);
  makeNewPlayer(playerB);

  var curP = 'A';

  // True when playback goes through the server transcoder (a chunked stream
  // that is NOT byte-range seekable) rather than a direct /media file.
  function isTranscoding() {
    return mstreamModule.transcodeOptions.serverEnabled === true
      && mstreamModule.transcodeOptions.frontendEnabled === true;
  }

  // Build the stream URL for a song: transcode bitrate/codec plus an optional
  // server-side seek offset (seconds). song.url already ends with `?token=…`
  // (or just `?`), so every extra param is appended with `&`.
  function buildStreamUrl(song, offsetSec = 0) {
    let url = song.url;
    if (isTranscoding()) {
      if (mstreamModule.transcodeOptions.selectedBitrate !== null) {
        url += `&bitrate=${mstreamModule.transcodeOptions.selectedBitrate}`;
      }
      if (mstreamModule.transcodeOptions.selectedCodec !== null) {
        url += `&codec=${mstreamModule.transcodeOptions.selectedCodec}`;
      }
      // Only the transcode route understands ?offset= (re-encode from -ss).
      if (offsetSec > 0) { url += `&offset=${offsetSec}`; }
    }
    return url;
  }

  function setMedia(song, player, play) {
    // CHAPTER entries (queue rows expanded from a .cue sheet) play a
    // [start, end) slice of their file. Transcoded streams start at the
    // slice via the server's `-ss` (?offset=); direct files seek the
    // element once its metadata arrives (seeking before loadedmetadata
    // is unreliable across browsers).
    const startAt = (song.chapter && song.chapter.start > 0) ? song.chapter.start : 0;
    player.chapterEnded = false;
    if (player._pendingChapterSeek) {
      player.playerObject.removeEventListener('loadedmetadata', player._pendingChapterSeek);
      player._pendingChapterSeek = null;
    }

    if (startAt > 0 && isTranscoding()) {
      player.seekOffset = startAt;
      player.playerObject.src = buildStreamUrl(song, startAt);
    } else {
      player.seekOffset = 0;
      player.playerObject.src = buildStreamUrl(song, 0);
    }
    player.songObject = song;
    player.playerObject.load();
    player.playerObject.playbackRate = mstreamModule.playerStats.playbackRate;

    if (startAt > 0 && !isTranscoding()) {
      const el = player.playerObject;
      player._pendingChapterSeek = () => {
        player._pendingChapterSeek = null;
        try { el.currentTime = startAt; } catch (_err) { /* not seekable */ }
      };
      el.addEventListener('loadedmetadata', player._pendingChapterSeek, { once: true });
    }

    player.playerObject.onended = () => {
      callMeOnStreamEnd();
    }

    if (play == true) {
      howlPlayerPlay();
    }
  }

  function callMeOnStreamEnd() {
    mstreamModule.playerStats.playing = false;
    if (mstreamModule.playerStats.shouldLoopOne === true) {
      return goToSong(mstreamModule.positionCache.val);
    }
    // Go to next song
    goToNextSong();
  }

  // Seek to a PRESENTED position (seconds). For a chapter entry the
  // presented timeline is the slice, so the target maps to
  // chapter.start + target before touching the stream. Direct /media
  // files seek natively (byte ranges); a transcoded stream isn't
  // seekable in the browser, so we re-request it from the server with
  // ?offset= and reload — see transcodeSeek.
  function seekToAbsolute(targetSec) {
    const lPlayer = getCurrentPlayer();
    if (!lPlayer.songObject) { return; }
    const dur = mstreamModule.playerStats.duration;
    if (!(targetSec >= 0)) { targetSec = 0; }
    if (Number.isFinite(dur) && dur > 0 && targetSec > dur) { targetSec = dur; }

    const ch = lPlayer.songObject.chapter;
    const streamTarget = ch ? ch.start + targetSec : targetSec;

    if (isTranscoding()) {
      transcodeSeek(streamTarget);
    } else {
      lPlayer.seekOffset = 0;
      lPlayer.playerObject.currentTime = streamTarget;
    }
  }

  // Server-side seek for transcoded playback: reload the stream from `-ss
  // targetSec` (a FILE-absolute position), remember the offset so the
  // playhead reads correctly, and resume playback if it was playing.
  function transcodeSeek(targetSec) {
    const lPlayer = getCurrentPlayer();
    const wasPlaying = mstreamModule.playerStats.playing === true;
    lPlayer.seekOffset = targetSec;
    lPlayer.playerObject.src = buildStreamUrl(lPlayer.songObject, targetSec);
    lPlayer.playerObject.load();
    lPlayer.playerObject.playbackRate = mstreamModule.playerStats.playbackRate;
    // Reflect immediately, in presented (chapter-relative) time.
    const ch = lPlayer.songObject.chapter;
    mstreamModule.playerStats.currentTime = ch ? Math.max(0, targetSec - ch.start) : targetSec;
    if (wasPlaying) { lPlayer.playerObject.play(); }
  }

  mstreamModule.goBackSeek = (backBy) => {
    seekToAbsolute(mstreamModule.playerStats.currentTime - backBy);
  }

  mstreamModule.goForwardSeek = (forwardBy) => {
    seekToAbsolute(mstreamModule.playerStats.currentTime + forwardBy);
  }

  // NOTE: seekTime is in seconds
  mstreamModule.seek = (seekTime) => {
    seekToAbsolute(seekTime);
  }

  mstreamModule.seekByPercentage = (percentage) => {
    if (percentage < 0 || percentage > 99) { return false; }
    const dur = mstreamModule.playerStats.duration;
    if (!Number.isFinite(dur) || dur <= 0) { return false; }
    seekToAbsolute((percentage * dur) / 100);
  }

  // Timer for caching.  Helps prevent excess caching due to button mashing
  var cacheTimer;
  function setCachedSong(position) {
    // console.log(' ATTEMPTING TO CACHE');
    if (!mstreamModule.playlist[position]) {
      //console.log(' FAILED TO CACHE');
      return false;
    }

    // console.log(mstreamModule.playlist[position])

    var oPlayer = getOtherPlayer();
    setMedia(mstreamModule.playlist[position], oPlayer, false);
    // console.log(' IT CACHED!!!!!!');
    return true;
  }


  // Loop
  mstreamModule.toggleRepeat = () => {
    if (mstreamModule.playerStats.autoDJ === true) { return; }

    if (mstreamModule.playerStats.shouldLoopOne === true) {
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = false;
    } else if (mstreamModule.playerStats.shouldLoop === true) {
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = true;
    } else {
      mstreamModule.playerStats.shouldLoop = true;
      mstreamModule.playerStats.shouldLoopOne = false;
    }
  }

  // Random Song
  var shuffleCache = []; // Cache the last 5 songs played to avoid repeats
  var shufflePrevious = [];
  mstreamModule.setShuffle = (newValue) => {
    if (typeof newValue !== "boolean") { return; }
    if (mstreamModule.playerStats.autoDJ === true) { return; }

    mstreamModule.playerStats.shuffle = newValue;
    mstreamModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
  }
  
  mstreamModule.toggleShuffle = () => {
    if (mstreamModule.playerStats.autoDJ === true) { return; }
    mstreamModule.playerStats.shuffle = !mstreamModule.playerStats.shuffle;
    mstreamModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
    return mstreamModule.playerStats.shuffle;
  }

  function newShuffle() {
    shuffleCache = shuffle(mstreamModule.playlist.slice(0));
  }

  function turnShuffleOff() {
    shufflePrevious = [];
    shuffleCache = [];
  }

  function shuffle(array) {
    var currentIndex = array.length
      , temporaryValue
      , randomIndex
      ;

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {
      // Pick a remaining element...
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex -= 1;

      // And swap it with the current element.
      temporaryValue = array[currentIndex];
      array[currentIndex] = array[randomIndex];
      array[randomIndex] = temporaryValue;
    }

    return array;
  }

  // AutoDJ
  mstreamModule.playerStats.autoDJ = false;
  // `autoDjIgnoreArray` kept as a legacy mirror for any external
  // consumer that read it; the real ignoreList lives in
  // AUTODJ.state.djIgnoreList and round-trips with the server.
  var autoDjIgnoreArray = [];
  // ignoreVPaths is the global "which libraries to include" pref —
  // still consumed by browse / search panels across m.js. The Auto-DJ
  // panel keeps it in lockstep with AUTODJ.state.djVpaths via
  // _syncVpathsToLegacy().
  mstreamModule.ignoreVPaths = {};
  // (No mstreamModule.minRating init — the legacy global is dead;
  // the rewritten autoDJ() reads djMinRating from AUTODJ.state.)

  // Queue N Auto-DJ picks sequentially. The autoDJ() function is
  // guarded against re-entrancy (a second call while the first is
  // in flight returns the same in-flight promise), so we must await
  // each pick before requesting the next — calling autoDJ() twice in
  // a row collapses to a single pick.
  //
  // Used on STARTUP paths (toggleAutoDJ, clearPlaylist) to bootstrap
  // a 2-deep lookahead. The downstream "queue one ahead" triggers in
  // goToSong (line 732) and changePosition (line 563) keep that
  // lookahead going thereafter. Without a 2-deep bootstrap, an empty-
  // playlist start adds one song; when it ends, goToNextSong's check
  // for playlist[pos+1] is undefined → returns false BEFORE any
  // goToSong runs → the line-732 trigger never fires → session
  // stalls. Two-on-start gives the cascade its first runway.
  //
  // Re-checks `mstreamModule.playerStats.autoDJ` between picks so a
  // user toggling Auto-DJ off mid-bootstrap aborts cleanly.
  async function _autoDjQueueN(n) {
    for (let i = 0; i < n; i++) {
      if (mstreamModule.playerStats.autoDJ !== true) { return; }
      const before = mstreamModule.playlist.length;
      try {
        await autoDJ();
      } catch (_) { /* autoDJ already toasts; don't stack errors */ }
      // A pick that added nothing failed (autoDJ toasted why) — the
      // next bootstrap attempt would fail the same way; stop instead
      // of stacking a duplicate toast + duplicate server round-trip.
      if (mstreamModule.playlist.length === before) { return; }
    }
  }

  mstreamModule.toggleAutoDJ = () => {
    mstreamModule.playerStats.autoDJ = !mstreamModule.playerStats.autoDJ;
    if (mstreamModule.playerStats.autoDJ === true) {
      // Turn off shuffle & loop
      mstreamModule.playerStats.shuffle = false;
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = false;

      // Bootstrap two songs when the playlist is empty OR we're
      // already sitting on the last track (the user toggled Auto-DJ
      // ON mid-playback at the queue tail). Without two on start
      // the cascade can't begin — see _autoDjQueueN's comment block.
      if (mstreamModule.playlist.length === 0 || mstreamModule.positionCache.val === mstreamModule.playlist.length - 1) {
        _autoDjQueueN(2);
      }
    } else {
      // Cancel an in-flight pick so its response doesn't land back
      // into AUTODJ.state after the user turned the feature off.
      _autoDjAbortController?.abort();
    }

    return mstreamModule.playerStats.autoDJ;
  }

  // Nudge a stalled Auto-DJ session into picking. Used by the DJ
  // panel's sonic seed picker: when the user enabled Auto-DJ on an
  // empty queue with sonic mode on but no seed, the bootstrap pick
  // fails (with a "pick a seed" toast) and nothing re-triggers it —
  // so the panel calls this right after a seed is chosen.
  mstreamModule.autoDjKick = () => {
    if (mstreamModule.playerStats.autoDJ !== true) { return; }
    if (mstreamModule.playlist.length > 0) { return; }
    _autoDjQueueN(2);
  }

  // ReplayGain
  mstreamModule.setReplayGainActive = (isActive) => {
    mstreamModule.playerStats.replayGain = isActive;
    if (getCurrentPlayer().songObject) {
      mstreamModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  mstreamModule.setReplayGainPreGainDb = (db) => {
    mstreamModule.playerStats.replayGainPreGainDb = db;
    if (getCurrentPlayer().songObject) {
      mstreamModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  // Setup Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function() { howlPlayerPlay(); });
    navigator.mediaSession.setActionHandler('pause', function() { howlPlayerPause(); });
    navigator.mediaSession.setActionHandler('stop', function() { howlPlayerPause(); });
    // navigator.mediaSession.setActionHandler('seekbackward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekforward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekto', function() { /* Code excerpted. */ });
    navigator.mediaSession.setActionHandler('previoustrack', function() { goToPreviousSong(); });
    navigator.mediaSession.setActionHandler('nexttrack', function() { goToNextSong() });
  }

  // Return an object that is assigned to Module
  return mstreamModule;
})();
