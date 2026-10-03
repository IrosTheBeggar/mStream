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

  // ── Stats API v2: play sessions ──────────────────────────────────────
  //
  // Every song start opens a session (assets/js/mstream.play-session.js)
  // fed by the player's own signals — the timeupdate ticks, pause and
  // resume, the end of the stream, the user moving on — and the finished
  // play goes to POST /api/v1/stats/plays through an outbox that retries
  // and survives a closed tab. A peer track is reported as a peer play (its
  // id + a snapshot of the metadata). The 30-second scrobble-by-filepath
  // timer this replaced is gone: the page is served by the server it
  // reports to, and every server with this page has the Stats API. Server-
  // side playback (mstream.server-audio.js) keeps its own legacy scrobble.
  let playSession = null;
  // The queue song object the open session is for (title, art, the
  // `federation` marker): the Auto DJ's Skipped ring is fed from it.
  let playSessionSong = null;
  let statsOutbox = null;
  let statsRetryTimer = null;
  let lastCheckpointAt = 0;
  const CHECKPOINT_EVERY_MS = 5000;

  function statsEnabled() {
    return typeof MSTREAMPLAYSESSION !== 'undefined' && typeof MSTREAMAPI !== 'undefined';
  }
  function statsOutboxFor() {
    if (!statsOutbox) {
      statsOutbox = MSTREAMPLAYSESSION.createOutbox({
        post: (body, opts) => MSTREAMAPI.postPlays(body, opts),
        log: console,
      });
    }
    return statsOutbox;
  }
  // How the song got here: a DJ pick, the shuffle, or the user.
  function statsSourceOf(song) {
    if (mstreamModule.playerStats.autoDJ === true && song.metadata && song.metadata._djPicked === true) { return 'autodj'; }
    if (mstreamModule.playerStats.shuffle === true) { return 'shuffle'; }
    return 'manual';
  }
  function beginPlaySession(song) {
    endPlaySession('skipped');
    if (!statsEnabled() || !song || !song.rawFilePath) { return; }
    const meta = song.metadata || {};
    const peerId = song.federation && Number.isFinite(Number(song.federation.peerId))
      ? Number(song.federation.peerId) : null;
    const metaDur = Number(meta.duration);
    try {
      playSession = MSTREAMPLAYSESSION.createSession({
        filePath: song.rawFilePath,
        peerId,
        track: peerId != null ? MSTREAMPLAYSESSION.snapshotOf(meta) : null,
        durationMs: Number.isFinite(metaDur) && metaDur > 0 ? Math.round(metaDur * 1000) : null,
        source: statsSourceOf(song),
        sessionId: MSTREAMPLAYSESSION.tabSessionId(),
      });
    } catch (err) {
      console.warn('[stats] could not open a play session', err);
      return;
    }
    playSessionSong = song;
    lastCheckpointAt = Date.now();
    statsOutboxFor().checkpoint(playSession);
    const notice = { filePath: playSession.filePath, sessionId: playSession.sessionId };
    if (peerId != null) { notice.peerId = peerId; notice.track = playSession.track; }
    try { MSTREAMAPI.postNowPlaying(notice).catch(() => {}); } catch (_) { /* best-effort */ }
  }
  // Close the open session with the player's word on how it ended; the
  // fold may upgrade it to `completed` (the playhead reached the end).
  function endPlaySession(outcome, flushOpts) {
    if (!playSession) { return; }
    const session = playSession;
    const song = playSessionSong;
    playSession = null;
    playSessionSong = null;
    const box = statsOutboxFor();
    box.clearCheckpoint();
    const play = MSTREAMPLAYSESSION.finish(session, outcome);
    if (!play) { return; }
    _noteRingSkip(play, song);
    box.enqueue(play);
    box.flush(flushOpts || {}).catch(() => {});
  }
  // A play that ended as an early skip (heard a second or more, not long
  // enough to count) joins the Auto DJ's Skipped ring, whatever queued it:
  // Less like's Add song offers it. Then an open Add song step hears of it
  // ('skip'): the session ends at the end of goToSong, after the 'song'
  // event, and the ring is no part of the seeds view.
  function _noteRingSkip(play, song) {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.seeds || !play || !song) { return; }
    if (play.outcome !== 'skipped' || !(play.playedMs >= 1000)) { return; }
    if (AUTODJ.countsAsPlay(play.playedMs, play.durationMs)) { return; }
    if (AUTODJ.seeds.noteSkip(AUTODJ.seeds.factsFromSong(song))) { _emitAutoDj('skip'); }
  }
  function tickPlaySession() {
    if (!playSession) { return; }
    MSTREAMPLAYSESSION.tick(playSession, mstreamModule.playerStats.currentTime, mstreamModule.playerStats.playing === true);
    const dur = mstreamModule.playerStats.duration;
    if (Number.isFinite(dur) && dur > 0) { MSTREAMPLAYSESSION.withDuration(playSession, Math.round(dur * 1000)); }
    const now = Date.now();
    if (now - lastCheckpointAt >= CHECKPOINT_EVERY_MS) {
      lastCheckpointAt = now;
      statsOutboxFor().checkpoint(playSession);
    }
  }
  function pausePlaySession() { if (playSession) { MSTREAMPLAYSESSION.pause(playSession); } }
  function resumePlaySession() { if (playSession) { MSTREAMPLAYSESSION.resume(playSession); } }
  // Called by alpha/m.js once the ping has answered (the token and server
  // are settled by then): post what an earlier page left behind, then keep
  // retrying quietly.
  mstreamModule.statsInit = () => {
    if (!statsEnabled()) { return false; }
    const box = statsOutboxFor();
    box.recover();
    box.flush().catch(() => {});
    if (!statsRetryTimer) { statsRetryTimer = setInterval(() => { box.flush().catch(() => {}); }, 60000); }
    return true;
  };
  // A closing page: the play so far leaves as `stopped`, on a request that
  // outlives the page.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => { endPlaySession('stopped', { keepalive: true }); });
  }
  // For the console and the smoke tests.
  mstreamModule.stats = {
    enabled: statsEnabled,
    session: () => playSession,
    outbox: () => statsOutboxFor(),
  };

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

  // ── Auto DJ seeds: the player's half (AUTODJ.seeds, design E) ───────
  //
  // The queue's generation: bumped at every lane edge (Start, Stop, a
  // clear) and by a learned quick skip. A pick built under an older one is
  // discarded where it would queue, before any side effect, and asked
  // again (autoDJ() runs it once more, at most twice per call).
  let _djQueueGen = 0;
  // A learned quick skip's re-roll, owed until a pick lands: { stale }, the
  // DJ rows (by object identity) that were queued without its negative.
  let _rerollOwed = null;
  // Who hears of the Auto DJ: the panel and the Seeds drawer.
  const _autoDjListeners = new Set();
  // The seed rows whose metadata this page already looked up, by key.
  const _bareAsked = new Set();

  // Tell the listeners why the Auto DJ's picture changed: 'dj' (on/off),
  // 'song' (another song is current), 'queue' (rows added, removed or
  // cleared), 'skip' (the Skipped ring took a song). A throwing listener is
  // caught.
  function _emitAutoDj(reason) {
    for (const fn of Array.from(_autoDjListeners)) {
      try {
        fn(reason);
      } catch (err) {
        console.warn('[autodj] a listener failed', err);
      }
    }
  }
  mstreamModule.onAutoDj = (fn) => {
    if (typeof fn !== 'function') { return () => {}; }
    _autoDjListeners.add(fn);
    return () => { _autoDjListeners.delete(fn); };
  };

  // The current queue row: the row at the position, and only while it is
  // the song playing. After a clear the old song plays on but is no row of
  // the queue, so it is nobody's to blend, admit or skip.
  function _currentRow() {
    const pos = mstreamModule.positionCache ? mstreamModule.positionCache.val : -1;
    if (!Array.isArray(mstreamModule.playlist)) { return { row: null, pos }; }
    const row = mstreamModule.playlist[pos];
    const playing = mstreamModule.getCurrentSong && mstreamModule.getCurrentSong();
    return { row: row && row === playing ? row : null, pos };
  }

  // Sonic similarity in play for this server: switched on, discovery on,
  // and the scan not reported unfinished (unknown readiness reads ready).
  function _sonicOn() {
    return AUTODJ.state.sonicEnabled === true
      && MSTREAMAPI.currentServer.discovery === true
      && MSTREAMAPI.currentServer.discoveryReady !== false;
  }

  // Whether this server's random-songs takes `lessLike` now: sonic in play
  // and a picker generation of at least 1 (the ping's `autoDj`).
  function _wireTakesNegatives() {
    return _sonicOn() && Number(MSTREAMAPI.currentServer.autoDj) >= 1;
  }

  // The cross-server pick's gate (mStream #929).
  function _fanOutRoute() {
    return AUTODJ.state.sonicEnabled === true && AUTODJ.state.federatedEnabled === true
      && MSTREAMAPI.currentServer.discovery === true
      && MSTREAMAPI.currentServer.federationBrowse === true;
  }

  // Look up, once per page, the facts of the seed rows that still lack them
  // (a file-browser row whose lookup had not landed, the migrated seed).
  // This server's rows only; a failed lookup is left be.
  function _fillBareSeeds() {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.seeds) { return; }
    if (typeof MSTREAMAPI === 'undefined' || typeof MSTREAMAPI.lookupMetadata !== 'function') { return; }
    for (const r of AUTODJ.seeds.bareRows()) {
      if (r.owner !== null || _bareAsked.has(r.key)) { continue; }
      _bareAsked.add(r.key);
      Promise.resolve()
        .then(() => MSTREAMAPI.lookupMetadata(r.path))
        .then((res) => {
          const facts = res && res.metadata ? AUTODJ.seeds.factsFromMeta(r.path, res.metadata) : null;
          if (facts) { AUTODJ.seeds.fillFacts(r.key, facts); }
        })
        .catch(() => {});
    }
  }
  mstreamModule.fillBareSeeds = () => { _fillBareSeeds(); };

  // A pick starts: the seeds' lane bookkeeping before anything reads them
  // (the held-aside rows join at the lane's first pick, Drift blends the
  // current row in, Stay close admits its one song).
  function _seedsBeginPick() {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.seeds) { return; }
    const row = _currentRow().row;
    const meta = (row && row.metadata) || {};
    AUTODJ.seeds.beginPick({
      current: AUTODJ.seeds.factsFromSong(row),
      currentIsLanePick: meta._djPicked === true && meta._djLane === AUTODJ.seeds.laneId(),
      route: _fanOutRoute() ? 'fanout' : 'local',
      sonicOn: _sonicOn(),
    });
    _fillBareSeeds();
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

    // Songs per fetch (mStream #966). Only on the wire when it changes
    // anything: at the default of 1 the request stays byte-identical to
    // the pre-batch shape, and a server from before `limit` existed
    // (Joi, no unknown keys) never sees a field it would reject.
    const limit = autodjLoaded ? Number(AUTODJ.state.djLimit) : 1;
    if (Number.isInteger(limit) && limit > 1) { body.limit = limit; }

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
    // subquery the buildGenreFilter helper emits. Only sent while the
    // filter is on: the Genres drawer writes the flag with the list, so
    // that is exactly while genres are chosen (AUTODJ.genreFilterOn);
    // an empty list is a no-op server-side, but skipping the field
    // entirely keeps the payload tidy.
    if (autodjLoaded
        && AUTODJ.state.djGenreEnabled
        && Array.isArray(AUTODJ.state.djGenres)
        && AUTODJ.state.djGenres.length > 0) {
      body.genres = [...AUTODJ.state.djGenres];
      body.genreMode = AUTODJ.state.djGenreMode;
      // Which genre links the list matches (Generated 'model' | Tags 'tag'):
      // only while it is narrowed to one kind and this server is known to
      // take the key (6.32.2+, /api/'s version). Absent, every kind (Mixed).
      const kind = AUTODJ.genreSourceFor(MSTREAMAPI.currentServer);
      if (kind) { body.genreSource = kind; }
    }

    // Track-length window — server-applied as an always-on base
    // condition (src/api/random.js's buildDurationFilter). State holds
    // SECONDS with 0 meaning "no bound on this side", so each bound is
    // only put on the wire when it's a real constraint; sending a bare
    // 0 would be a no-op server-side but muddies the payload.
    //
    // allowUnknownDuration rides along only when a bound is actually
    // set — on its own it constrains nothing, and the server ignores
    // it in that case anyway.
    if (autodjLoaded && AUTODJ.state.djDurationEnabled) {
      const minDur = Number(AUTODJ.state.djMinDuration);
      const maxDur = Number(AUTODJ.state.djMaxDuration);
      const haveMin = Number.isFinite(minDur) && minDur > 0;
      const haveMax = Number.isFinite(maxDur) && maxDur > 0;
      if (haveMin) { body.minDuration = minDur; }
      if (haveMax) { body.maxDuration = maxDur; }
      if (haveMin || haveMax) {
        body.allowUnknownDuration = !!AUTODJ.state.djAllowUnknownDuration;
      }
    }

    // Mood filter — server-applied as an always-on base condition (the
    // filter is src/api/mood-filter.js). Gated on the ping's
    // `moodFilters` flag the way the sonic params gate on `discovery`:
    // the route's schema is strict, so a server without the filter would
    // 400 every pick. Only on the wire when something is set.
    if (autodjLoaded
        && AUTODJ.state.djMoodEnabled
        && MSTREAMAPI.currentServer.moodFilters === true) {
      const moods = AUTODJ.cleanMoods(AUTODJ.state.djMoods, AUTODJ.state.djMoodLevel);
      if (moods) { body.moods = moods; }
    }

    // Sonic similarity — constrain picks to the discovery-embedding
    // neighborhood of the session's seeds (PR #697 server API; the seeds
    // are AUTODJ.seeds, design E). Gated on the ping capability flag so
    // feature-off servers never receive the params (they would 403), and
    // on the scan: a server that reported `discoveryReady: false` would
    // refuse every seed with a 400, so its picks go plain until a reload.
    //   • similarTo + minSimilarity: this server's More like rows, at most
    //     eight (pins first past eight), else in Drift the current queue
    //     row. With none the pick goes without them (every other filter
    //     still applies); `opts.sonicOptional` no longer changes that.
    //   • lessLike: this server's Less like rows, the newest eight, beside
    //     (never inside) the sonic fields, only to a server whose picker
    //     takes them (`autoDj` >= 1). An empty list is an absent key.
    if (autodjLoaded && AUTODJ.seeds && _sonicOn()) {
      const current = AUTODJ.seeds.factsFromSong(_currentRow().row);
      const positives = AUTODJ.seeds.positives({ route: 'local', current });
      if (positives.length > 0) {
        body.similarTo = positives.map((p) => p.path);
        body.minSimilarity = AUTODJ.state.sonicMinSimilarity;
      }
      if (_wireTakesNegatives()) {
        const negatives = AUTODJ.seeds.negatives();
        if (negatives.length > 0) { body.lessLike = negatives; }
      }
    }

    return { body, refBpm, refNeighbours };
  }

  // Auto-DJ song-change side-effects. Invoked from
  // resetCurrentMetadata every time the playing song changes (or its
  // metadata is refreshed). Runs only when Auto-DJ is on.
  //
  // First the seeds (AUTODJ.seeds.onPlay), for EVERY song: a DJ pick of
  // this lane joins More like as it starts playing, before goToSong's
  // top-up builds the next body, once per playing row (a metadata refresh
  // of the same row is no new play, and a pick played again after another
  // song moves to the newest place). Whether sonic is on or off.
  //
  // Then continuity, in three branches:
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
  //     not the old session's. The seeds stay (resetAnchors is
  //     continuity only).
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
    if (AUTODJ.seeds) {
      AUTODJ.seeds.onPlay(AUTODJ.seeds.factsFromSong(curSong), {
        lanePick: djPicked && meta._djLane === AUTODJ.seeds.laneId(),
      });
      _fillBareSeeds();
    }
    if (djPicked) {
      if (AUTODJ.isFilepathCounted(filepath)) { return; }
      if (Number.isFinite(meta.bpm)) {
        AUTODJ.pushBpmHistory(meta.bpm);
      }
      // Lock anchor on the first DJ pick that has a key tag.
      if (!AUTODJ.getCamelotAnchor() && meta['musical-key']) {
        AUTODJ.setCamelotAnchor(meta['musical-key']);
      }
      AUTODJ.markFilepathCounted(filepath);
    } else {
      AUTODJ.resetAnchors();
    }
  }

  // Client-side post-fetch guard, shared by the single-server retry loop and
  // the federated pick. Velvet's `_djSongBlocked` — the server's tier
  // filter already prefers in-range rows, but in degraded fallback cases
  // (step 5, step 10) the candidate can still be off-target. Songs with NULL
  // bpm/key pass through (server already exhausted the tagged options).
  //
  // Keyword filter — independent of BPM/harmonic toggles. The server doesn't
  // know about user-supplied skip words (kept entirely client-side per
  // velvet's design), so this is the only place it gets applied.
  // Genre + track-length are defence-in-depth against the server's pick:
  // the server already enforces both, this catches a rescan changing the
  // row between the server's SELECT and our read. [kindSent]: the answer
  // was asked under one genre kind (`genreSource`). A song's
  // metadata.genres holds its links of both kinds, so such an answer is
  // not checked on genres again: under Skip it would drop a song the
  // server rightly kept (skipping the model's Rock keeps a song tagged
  // Rock).
  function _autoDjSongBlocked(metadata, refBpm, refNeighbours, kindSent) {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.songBlocked) { return false; }
    return AUTODJ.songBlocked(metadata, {
      bpmContinuity: AUTODJ.state.bpmContinuity,
      refBpm,
      bpmTolerance: AUTODJ.state.bpmTolerance,
      harmonicMixing: AUTODJ.state.harmonicMixing,
      refNeighbours,
      filterEnabled: AUTODJ.state.djFilterEnabled,
      filterWords: AUTODJ.state.djFilterWords,
      genreEnabled: AUTODJ.state.djGenreEnabled && !kindSent,
      genreMode: AUTODJ.state.djGenreMode,
      genres: AUTODJ.state.djGenres,
      durationEnabled: AUTODJ.state.djDurationEnabled,
      minDuration: AUTODJ.state.djMinDuration,
      maxDuration: AUTODJ.state.djMaxDuration,
      allowUnknownDuration: AUTODJ.state.djAllowUnknownDuration,
    });
  }

  // ── Cross-server session (mStream #929) ─────────────────────────────
  //
  // With "play from federated servers" on, a pick is chosen across this
  // server and every paired peer that shares its discovery model. The
  // seeds' vectors (the More like rows of any server, each row knowing its
  // owner) are read from the servers that OWN them (a path only names a
  // row where it lives), averaged client-side, and sent to each server as
  // `similarToVector`; the best reported cosine wins. Less like rides only
  // the local ask (`lessLike` paths of this server's songs): no peer is
  // sent negatives, and a local song its answer flags as like a skip ranks
  // after every clean song. Peer picks are queued through the federation
  // wizard, so they stream through the proxy and carry the `federation`
  // marker every degrade guard keys on.
  //
  // Anything that can't run this way — no eligible peer, no usable seed,
  // nobody answered — returns false, and the single-server loop runs
  // unchanged: switching this on can never leave the queue empty where it
  // would otherwise have filled.
  //
  // Peers, their model id and their version are learned through the browse
  // proxy (GET federation/health is allowlisted) and cached for a few
  // minutes; a peer that still answers a model-space 400 is dropped for the
  // session.
  let _fedPeersCache = null; // { at, peers: [{ id, name, modelId|null, version|null }] }
  const FED_PEERS_TTL_MS = 5 * 60 * 1000;

  async function _federatedPeers() {
    if (_fedPeersCache && Date.now() - _fedPeersCache.at < FED_PEERS_TTL_MS) {
      return _fedPeersCache.peers;
    }
    const listed = (await MSTREAMAPI.federationPeers()).peers || [];
    const peers = await Promise.all(listed
      // The admin's per-peer discovery opt-in — the same flag the Discover
      // aggregator honours.
      .filter(p => p.useDiscovery !== false)
      .map(async (p) => {
        try {
          const health = await MSTREAMAPI.peer.health(p.id);
          const modelId = health && health.discovery && health.discovery.modelId;
          // Its version (health's `server`) says whether it takes
          // random-songs' `genreSource` (AUTODJ.takesGenreSource).
          const version = health && typeof health.server === 'string' ? health.server : null;
          return { id: p.id, name: p.name, modelId: modelId || null, version };
        } catch (_e) {
          // Unreachable, or too old to answer: sits this session out.
          return { id: p.id, name: p.name, modelId: null, version: null };
        }
      }));
    _fedPeersCache = { at: Date.now(), peers };
    return peers;
  }

  // One federated pick. True when a song was queued.
  // A peer's random-songs, with one concession to age: a peer from before
  // batch picks (mStream #966) rejects `limit` outright — Joi, no unknown
  // keys — and would otherwise sit out every round while the setting is
  // above 1. Ask such a peer for one song instead, the way the app's
  // capability learner does, rather than dropping it from the session.
  function _askPeerRandomSongs(peer, body) {
    return MSTREAMAPI.peer.randomSongs(peer.id, body).catch((err) => {
      const msg = (err && err.body && err.body.error) || '';
      if (body.limit !== undefined && err && err.status === 400 && /"limit" is not allowed/i.test(msg)) {
        const single = { ...body };
        delete single.limit;
        return MSTREAMAPI.peer.randomSongs(peer.id, single);
      }
      throw err;
    });
  }

  async function _autoDjFederatedPick(signal, ctx) {
    // The queue generation and the lane this pick is built under (the moods
    // test calls this bare).
    const pickCtx = ctx || { gen: _djQueueGen, lane: AUTODJ.seeds.laneId() };
    // The seeds with their owners in one synchronous read, before anything
    // is awaited: More like's rows of any server (none set aside), else in
    // Drift the current queue row, on whichever server it lives.
    const curSong = mstreamModule.getCurrentSong && mstreamModule.getCurrentSong();
    const anchors = AUTODJ.seeds.positives({ route: 'fanout', current: AUTODJ.seeds.factsFromSong(_currentRow().row) });
    if (anchors.length === 0) { return false; }

    const peers = (await _federatedPeers()).filter(p => p.modelId && !AUTODJ.isPeerExcluded(p.id));
    if (peers.length === 0) { return false; }

    // Continuity, filters and our ignoreList; the local `similarTo` is
    // optional here (every anchor may live on a peer).
    const { body, refBpm, refNeighbours } = await _buildAutoDjBody({ ignoreList: AUTODJ.getIgnoreList(), sonicOptional: true });
    // Each peer's genre kind, read with the body (nothing the user does
    // runs between its genre block and here): so its ask, and whether its
    // answer is re-checked on genres, follow the filter the round went out
    // with, as the local ask's do — a Genres change made while the round is
    // out never marks an answer asked without a kind as asked under one,
    // and a kind never rides without genres.
    const peerKinds = new Map(peers.map((p) => [String(p.id), body.genres ? AUTODJ.genreSourceFor(p) : null]));

    // The anchors' vectors, each from its own server. The session's model
    // space is whatever answers first (the local server, when it holds an
    // anchor); vectors from another space are skipped, never averaged in.
    const byOwner = new Map();
    for (const a of anchors) {
      const key = a.peerId === null ? 'local' : String(a.peerId);
      if (!byOwner.has(key)) { byOwner.set(key, { peerId: a.peerId, paths: [] }); }
      byOwner.get(key).paths.push(a.path);
    }
    let modelId = null;
    let dim = null;
    const vectors = [];
    for (const { peerId, paths } of byOwner.values()) {
      let got = null;
      try {
        got = peerId === null
          ? await MSTREAMAPI.discoveryEmbeddings(paths.slice(0, 8))
          : await MSTREAMAPI.peer.discoveryEmbeddings(peerId, paths.slice(0, 8));
      } catch (_e) {
        got = null;
      }
      if (!got || got.disabled || !got.model || !Array.isArray(got.tracks)) { continue; }
      if (modelId === null) { modelId = got.model.id; dim = got.dim; }
      else if (got.model.id !== modelId || got.dim !== dim) { continue; }
      for (const trk of got.tracks) {
        const v = trk && trk.embedding ? AUTODJ.decodeWireVector(trk.embedding, dim) : null;
        if (v) { vectors.push(v); }
      }
    }
    const seed = modelId ? AUTODJ.meanUnitVector(vectors, dim) : null;
    if (!seed) { return false; }
    const vectorSeed = {
      similarToVector: AUTODJ.encodeWireVector(seed),
      similarToModelId: modelId,
      // The pool floor travels with the vector; the local body only
      // carries it when this server holds an anchor.
      minSimilarity: Number.isFinite(body.minSimilarity) ? body.minSimilarity : AUTODJ.state.sonicMinSimilarity,
    };

    // The same body everywhere, minus what only means something on this
    // server: the filepath seed (the vector replaces it), ignoreVPaths (OUR
    // library names), minRating (OUR user's stars) and lessLike (paths of
    // OUR songs, which the local ask alone carries back); each peer gets
    // its own ignoreList. `genres` and `genreMode` go to every server, the
    // genre kind (`genreSource`) only to each one known to take it: the
    // local ask when the body has it (this server's version), a peer by its
    // own version. Every server is asked at once — a session that
    // waited for each in turn would stall the queue on the slowest one.
    //
    // A server answers with random rows from its pool, so when every
    // answer is a repeat or blocked the ask is repeated a couple of times
    // with each server's own returned ignoreList fed back (the way the
    // single-server loop retries) before the pick is left to that loop —
    // otherwise a strict slider, whose pools are small, would keep turning
    // the session local-only. The fed-back lists stay transient: only the
    // cooldowns of servers whose songs get queued advance.
    //
    // Songs per fetch applies across all servers: every server is asked
    // for the whole batch (`limit` rides along in `shared`) and the best
    // `want` cosines overall are queued, so one server with the closest
    // matches can supply the entire batch.
    const { similarTo, ignoreVPaths, minRating, ignoreList, lessLike, genreSource, ...shared } = body;
    const localOnly = { ...(lessLike ? { lessLike } : {}), ...(genreSource ? { genreSource } : {}) };
    // A peer gets the genre kind only when its own version takes the key
    // (federation health's `server`): an older one would refuse the whole ask.
    const peerKind = (p) => peerKinds.get(String(p.id)) || null;
    const eligible = peers.filter(p => p.modelId === modelId);
    const retryLists = new Map([['local', ignoreList]]);
    for (const p of eligible) { retryLists.set(String(p.id), AUTODJ.getPeerIgnoreList(p.id)); }
    // The repeat guard also passes over the blended song the user
    // quick-skipped this lane (no ignoreList holds it).
    const recentKeys = AUTODJ.federatedRecentKeys(anchors, curSong, [AUTODJ.seeds.skippedBlendKey()]);
    const want = Number.isInteger(shared.limit) && shared.limit > 1 ? shared.limit : 1;
    const MAX_ASKS = 3;
    let chosen = [];
    for (let attempt = 0; attempt < MAX_ASKS && chosen.length === 0; attempt++) {
      const asks = [
        MSTREAMAPI.getRandomSong({ ...shared, ignoreVPaths, minRating, ignoreList: retryLists.get('local'), ...localOnly, ...vectorSeed }, { signal })
          .then(res => ({ peer: null, res }), err => ({ peer: null, err })),
        ...eligible.filter(p => !AUTODJ.isPeerExcluded(p.id)).map(p =>
          _askPeerRandomSongs(p, { ...shared, ignoreList: retryLists.get(String(p.id)), ...(peerKind(p) ? { genreSource: peerKind(p) } : {}), ...vectorSeed })
            .then(res => ({ peer: p, res }), err => ({ peer: p, err }))),
      ];
      const answers = await Promise.all(asks);
      if (signal && signal.aborted) { return false; }

      const scored = [];
      for (const a of answers) {
        if (a.err) {
          if (a.err.name === 'AbortError') { return false; }
          if (a.peer && a.err.status === 400 && /Sonic seed is from model/i.test((a.err.body && a.err.body.error) || '')) {
            AUTODJ.excludePeerForSession(a.peer.id);
          }
          continue;
        }
        // A mood-filtered ask: a server that answered without the echo
        // (no mood scores) picked unfiltered — its songs would play off
        // the mood, so they are not candidates. One older than the filter
        // refuses the key outright: an error, skipped above.
        if (shared.moods && !(a.res && a.res.moods)) { continue; }
        const songs = a.res && Array.isArray(a.res.songs) ? a.res.songs : [];
        if (songs.length === 0) { continue; }
        if (Array.isArray(a.res.ignoreList)) { retryLists.set(a.peer ? String(a.peer.id) : 'local', a.res.ignoreList); }
        // One cosine per song (`sonic.similarities`, aligned with `songs`);
        // a peer from before batches reports only the first song's value.
        // The local answer flags each song like a Less like row
        // (`lessLike.avoided`, aligned with `songs` too): it ranks last.
        const sims = a.res.sonic && Array.isArray(a.res.sonic.similarities) ? a.res.sonic.similarities : [];
        const avoided = a.peer === null && a.res.lessLike && Array.isArray(a.res.lessLike.avoided) ? a.res.lessLike.avoided : [];
        songs.forEach((song, i) => {
          let sim = -1;
          if (Number.isFinite(sims[i])) { sim = sims[i]; }
          else if (i === 0 && a.res.sonic && Number.isFinite(a.res.sonic.similarity)) { sim = a.res.sonic.similarity; }
          scored.push({
            peerId: a.peer ? a.peer.id : null,
            peer: a.peer,
            song,
            res: a.res,
            similarity: sim,
            // Not re-checked on genres when asked under a kind.
            blocked: _autoDjSongBlocked(song.metadata, refBpm, refNeighbours, a.peer ? !!peerKind(a.peer) : !!genreSource),
            avoided: avoided[i] === true,
          });
        });
      }
      // Nobody answered — asking again would not change that.
      if (scored.length === 0) { break; }
      chosen = AUTODJ.chooseFederatedPicks(scored, recentKeys, want);
    }
    if (chosen.length === 0) { return false; }

    // Only the ignoreLists of servers whose songs are being queued advance
    // — the others' answers were not played, nor were the songs a re-roll
    // left out ([landing]: the picks _landDjPicks is about to queue). A
    // contributing server's list also carries the ids of its songs that
    // lost to a better cosine elsewhere; the cooldown is soft variety and
    // they cycle back out. Run as the picks land, never for a pick
    // discarded as stale; each queued song's artist joins the cooldown as
    // it is added (_landDjPicks).
    const commit = (landing) => {
      const landed = new Set(landing.map((p) => (p.peer ? String(p.peer.id) : 'local')));
      const advanced = new Set();
      for (const pick of chosen) {
        const key = pick.peerId === null ? 'local' : String(pick.peerId);
        if (!landed.has(key) || advanced.has(key)) { continue; }
        advanced.add(key);
        if (pick.peerId === null) {
          AUTODJ.setIgnoreList(Array.isArray(pick.res.ignoreList) ? pick.res.ignoreList : []);
          autoDjIgnoreArray = AUTODJ.getIgnoreList();
        } else {
          AUTODJ.setPeerIgnoreList(pick.peerId, pick.res.ignoreList);
        }
      }
    };

    // Queue best first so the playlist order is the ranking.
    const landed = await _landDjPicks(chosen.map((pick) => ({
      filepath: pick.song.filepath,
      meta: { ...(pick.song.metadata || {}) },
      peer: pick.peerId === null ? null : pick.peer,
    })), pickCtx, commit);
    return landed === 'stale' ? 'stale' : true;
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
    const signal = _autoDjAbortController.signal;
    _autoDjInFlight = (async () => {
      try {
        // A pick discarded as stale (a lane edge or a learned quick skip
        // moved the queue's generation while it was out) is asked again,
        // at most twice per call, while the DJ is on.
        for (let run = 0; run < 3; run++) {
          const result = await _autoDjRunOnce(signal);
          if (result !== 'stale' || signal.aborted || mstreamModule.playerStats.autoDJ !== true) { break; }
        }
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
    const seedsLoaded = autodjLoaded && !!AUTODJ.seeds;
    // The queue generation and the lane this pick is built under, taken
    // before it reads the seeds: where it lands, a pick of an older
    // generation is discarded before any side effect and asked again.
    const ctx = { gen: _djQueueGen, lane: seedsLoaded ? AUTODJ.seeds.laneId() : 0 };
    _seedsBeginPick();
    let picked = null;
    let lastResponse = null;
    // ignoreList is FED BACK from the server across retries. Without
    // this, retry 2..N would send the same stale ignoreList that
    // retry 1 sent, and the server might re-pick the same blocked
    // song from the same SQL result set.
    let ignoreList = autodjLoaded ? AUTODJ.getIgnoreList() : [];
    const MAX_RETRIES = 5;

    // Cross-server session first (see _autoDjFederatedPick). It returns
    // false whenever it can't run this way, and the single-server loop
    // below then runs exactly as before.
    if (seedsLoaded && _fanOutRoute()) {
      const fed = await _autoDjFederatedPick(signal, ctx);
      if (fed === 'stale') { return 'stale'; }
      if (fed) {
        _showSimilarArtistsInfoStrip();
        return 'queued';
      }
    }

    // The blended song the user quick-skipped this lane: no ignoreList
    // holds it and it is no seed, so the answers pass over it.
    const skippedBlend = seedsLoaded ? AUTODJ.seeds.skippedBlendKey() : null;
    let healed = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { body, refBpm, refNeighbours } = await _buildAutoDjBody({ ignoreList });
      let res;
      try {
        res = await MSTREAMAPI.getRandomSong(body, { signal });
      } catch (err) {
        // A seed the server can't use (not analysed yet, or gone) refuses
        // the whole body and names no path. Once per pick, the rows at
        // fault leave the lane's requests (_healSonicSeeds) and the same
        // attempt goes again without them. Never for a pick a lane edge
        // or a learned skip made stale: an old lane's refusal is not the
        // new lane's rows' doing.
        if (err?.name !== 'AbortError' && body.similarTo && !healed && _isSeedRefusal(err)) {
          if (ctx.gen !== _djQueueGen) { return 'stale'; }
          healed = true;
          const changed = await _healSonicSeeds(body);
          if (ctx.gen !== _djQueueGen) { return 'stale'; }
          if (changed) {
            attempt--;
            continue;
          }
        }
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
        // The duration window is an always-on server filter, so an
        // over-narrow one 400s every pick for the rest of the session.
        // The generic "Auto DJ Failed" gives the user nothing to act
        // on; name the filter that's most likely at fault. Only when
        // no more specific story (sonic) already claimed the error.
        if (err?.name !== 'AbortError' && !err.djToast
            && (body.minDuration || body.maxDuration)) {
          err.djToast = {
            title: t('autoDJ.durationToastTitle'),
            message: t('autoDJ.durationNoMatch'),
          };
        }
        throw err;
      }
      lastResponse = res;
      // Server returns the updated ignoreList (input list + the
      // just-picked index). Carry it into the next iteration so a
      // blocked retry doesn't re-pick the same song.
      if (Array.isArray(res?.ignoreList)) { ignoreList = res.ignoreList; }

      const songs = Array.isArray(res.songs) ? res.songs : [];
      if (songs.length === 0) { break; }

      // Client-side post-fetch guard. Velvet's `_djSongBlocked` —
      // the server's tier ranking already prefers in-range rows, but
      // in degraded fallback cases (step 5, step 10) a candidate
      // can still be off-target. Retry-on-blocked closes the gap.
      // Songs with NULL bpm/key pass through (server already
      // exhausted the tagged options). An answer asked under a genre
      // kind is not re-checked on genres. A batch keeps whatever part
      // of it passes, never the quick-skipped blend; only an answer
      // blocked in full is retried.
      const accepted = songs.filter((s) => !_autoDjSongBlocked(s.metadata, refBpm, refNeighbours, !!body.genreSource)
        && !_isSkippedBlend(s, skippedBlend));
      if (accepted.length > 0) { picked = accepted; break; }
    }

    // If every retry was blocked, fall through with whatever the
    // last response was so the session doesn't stall completely.
    // The server's fallback chain is already exhausting all viable
    // alternatives; refusing here just means the DJ stops. Whole but
    // for the quick-skipped blend, while anything else is left.
    if (!picked && Array.isArray(lastResponse?.songs) && lastResponse.songs.length > 0) {
      const rest = lastResponse.songs.filter((s) => !_isSkippedBlend(s, skippedBlend));
      picked = rest.length > 0 ? rest : lastResponse.songs;
    }
    if (!picked) {
      throw new Error('no song in response');
    }

    // Mark as DJ picks so the song-change handler later knows to
    // push to BPM history (vs. resetting anchors on a manual pick).
    // `_djPicked` is the only metadata flag a song carries; the
    // "have we counted this song's BPM yet" state lives in AUTODJ
    // proper (state.djCountedFilepaths), not on the metadata.
    // _landDjPicks stamps this lane on each (`_djLane`).
    const queued = picked.map((song) => ({
      filepath: song.filepath,
      meta: { ...(song.metadata || {}), _djPicked: true },
      peer: null,
    }));

    // Persist the updated ignoreList as the pick lands, whatever part of it
    // a re-roll queues (the phone takes the answer's list the same way);
    // each queued song's artist joins the cooldown as it is added
    // (_landDjPicks), so a song left out leaves no artist trace. A pick
    // discarded as stale leaves no trace at all.
    const commit = () => {
      if (autodjLoaded) { AUTODJ.setIgnoreList(ignoreList); }
      // Legacy bridge — keep the old global in sync until everywhere
      // else has migrated off it.
      autoDjIgnoreArray = ignoreList;
    };

    // Await each so async failures inside addSongWizard surface through
    // the outer try/catch and trigger the iziToast warning instead of
    // becoming a silent unhandled rejection — and so the queue keeps
    // the server's order (best tier first).
    const landed = await _landDjPicks(queued, ctx, commit);

    // Similar-artists info strip — surface WHY this pick was made
    // when the user has similar mode on. Velvet does this with a
    // sticky 30s strip; alpha uses iziToast.info (8s) to match the
    // existing toast vocabulary. Only fires when we actually used
    // similar artists for this pick (cache populated AND non-empty).
    //
    // Truncated to first 5 candidates so the toast doesn't become a
    // wall of text — the rest are still in the cache for debugging
    // via the dev console but the user gets the gist.
    if (landed === 'queued') { _showSimilarArtistsInfoStrip(); }
    return landed;
  }

  // Where every pick lands: [picks] ([{ filepath, meta, peer | null }], best
  // first) under [ctx] ({ gen, lane }, taken as the pick began). A pick of
  // an older queue generation is discarded before any side effect
  // ('stale'; autoDJ() asks again). Otherwise a re-roll still owed drops
  // the stale DJ rows ahead (nearest first, at most as many as the pick
  // brought) and the pick queues one song per row dropped (the whole batch
  // when the playing row is now the last; nothing when nothing could go
  // and rows remain); [commit](the picks about to be queued) runs the
  // pick's ignoreList bookkeeping; then each song is queued, stamped with
  // the lane, and its artist joins the cooldown. A generation that moves
  // during an awaited add ends the batch (the rest were chosen for the old
  // queue) and makes the landing 'stale' too, so autoDJ() runs the pick
  // again for the new queue: a re-roll the move owes, or the lookahead a
  // Next onto the song just added needs. 'queued' or 'none'.
  async function _landDjPicks(picks, ctx, commit) {
    if (ctx.gen !== _djQueueGen) { return 'stale'; }
    let toQueue = picks;
    if (_rerollOwed) {
      const owed = _rerollOwed;
      _rerollOwed = null;
      const dropped = _dropRerolled(owed.stale, picks.length);
      const atEnd = mstreamModule.positionCache.val >= mstreamModule.playlist.length - 1;
      toQueue = atEnd ? picks : picks.slice(0, Math.min(dropped, picks.length));
    }
    if (typeof commit === 'function') { commit(toQueue); }
    let queued = 0;
    for (const pick of toQueue) {
      if (queued > 0 && ctx.gen !== _djQueueGen) { break; }
      const meta = { ...(pick.meta || {}), _djPicked: true, _djLane: ctx.lane };
      if (pick.peer) {
        VUEPLAYERCORE.addFederationSongWizard(pick.peer, pick.filepath, meta, false);
      } else {
        await VUEPLAYERCORE.addSongWizard(pick.filepath, meta);
      }
      queued++;
      if (typeof AUTODJ !== 'undefined' && meta.artist) { AUTODJ.pushArtistHistory(meta.artist); }
    }
    if (queued > 0 && ctx.gen !== _djQueueGen) { return 'stale'; }
    return queued > 0 ? 'queued' : 'none';
  }

  // The re-roll's drop: the rows of [stale] (by identity) still after the
  // playing row that are DJ picks, nearest first, at most [max]. A live
  // playlist is saved again after a drop. Returns how many went.
  function _dropRerolled(stale, max) {
    const named = Array.isArray(stale) ? stale : [];
    let dropped = 0;
    while (dropped < max) {
      let at = -1;
      for (let i = Math.max(0, mstreamModule.positionCache.val + 1); i < mstreamModule.playlist.length; i++) {
        const row = mstreamModule.playlist[i];
        if (named.includes(row) && row.metadata && row.metadata._djPicked === true) { at = i; break; }
      }
      if (at < 0) { break; }
      mstreamModule.removeSongAtPosition(at);
      dropped++;
    }
    if (dropped > 0 && typeof VUEPLAYERCORE !== 'undefined' && typeof VUEPLAYERCORE.saveLiveQueue === 'function') {
      VUEPLAYERCORE.saveLiveQueue();
    }
    return dropped;
  }

  // Whether [song], an answer of this server, is the blended song the user
  // quick-skipped this lane ([skippedKey], AUTODJ.seeds.skippedBlendKey()).
  function _isSkippedBlend(song, skippedKey) {
    if (!skippedKey || !song || typeof song.filepath !== 'string') { return false; }
    return AUTODJ.seeds.keyOf(null, song.filepath) === skippedKey;
  }

  // A single-server body refused for a seed it can't use: 400 "Sonic seed
  // track has not been analyzed yet", or the uniform 404 "Track not found".
  function _isSeedRefusal(err) {
    const msg = (err && err.body && err.body.error) || '';
    return (err && err.status === 400 && /seed track has not been analyzed/i.test(msg))
      || (err && err.status === 404 && /track not found/i.test(msg));
  }

  // Which of the More like paths a refused body carried ([body.similarTo])
  // made the server refuse it: the one path, when one was sent; else those
  // the embeddings route reports `notAnalyzed`; when that call fails (one
  // gone path costs the whole batch), each path probed alone, a path whose
  // probe fails or is `notAnalyzed` being at fault, but only when at least
  // one probe answered. The culprits leave the lane's requests
  // (AUTODJ.seeds.heal: an unpinned row is removed, and every culprit is
  // set aside, so neither a pinned row, nor the Drift fallback to the song
  // playing, sends it again). True when that changed anything.
  async function _healSonicSeeds(body) {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.seeds) { return false; }
    const sent = Array.isArray(body && body.similarTo) ? body.similarTo : [];
    if (sent.length === 0) { return false; }
    let culprits = [];
    if (sent.length === 1) {
      culprits = sent.slice();
    } else {
      const read = async (paths) => {
        try { return await MSTREAMAPI.discoveryEmbeddings(paths); } catch (_e) { return null; }
      };
      const answered = (r) => !!r && !r.disabled && Array.isArray(r.tracks);
      const all = await read(sent);
      if (answered(all)) {
        culprits = sent.filter((_p, i) => !!all.tracks[i] && all.tracks[i].notAnalyzed === true);
      } else {
        const probes = await Promise.all(sent.map((p) => read([p])));
        if (probes.some(answered)) {
          culprits = sent.filter((_p, i) => !answered(probes[i])
            || (!!probes[i].tracks[0] && probes[i].tracks[0].notAnalyzed === true));
        }
      }
    }
    if (culprits.length === 0) { return false; }
    return AUTODJ.seeds.heal(culprits.map((p) => AUTODJ.seeds.keyOf(null, p)));
  }

  // Text for an iziToast title or message, which iziToast inserts as
  // markup. This file also runs on the shared-playlist page, which has no
  // m.js (and so no escapeHtml).
  function _escapeToastText(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
    // the artist names are Last.fm's and the tags': escaped for the toast
    iziToast.info({
      title: t('autoDJ.similarInfoTitle'),
      message: _escapeToastText(extra > 0
        ? t('autoDJ.similarInfoBodyMore', { source: cache.sourceArtist, candidates: shown, extra })
        : t('autoDJ.similarInfoBody',     { source: cache.sourceArtist, candidates: shown })),
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
      const started = goToSong(mstreamModule.positionCache.val, forceAutoPlayOff);
      _emitAutoDj('queue');
      return started;
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

    _emitAutoDj('queue');
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

    _emitAutoDj('queue');
    // TODO: Check cache. Since we use this for play now only, the cache is usually preserved
  }

  mstreamModule.clearAndPlay = function (song) {
    // Clear playlist
    mstreamModule.playlist = [];
    return addSong(song);
  }

  // `opts.userClear === false` marks a clear that is not the user's: the
  // live playlist's load at boot. Every other clear is the user's (Clear
  // Playlist, a play that replaces the queue, turning on a live playlist).
  mstreamModule.clearPlaylist = function (opts) {
    const userClear = !(opts && opts.userClear === false);
    const hadRows = mstreamModule.playlist.length > 0;
    while (mstreamModule.playlist.length > 0) { mstreamModule.playlist.pop(); }
    mstreamModule.positionCache.val = -1;

    clearEnd();

    // Clear shuffle as well
    if (mstreamModule.playerStats.shuffle === true) {
      // Clear Shuffle Cache
      while (shuffleCache.length > 0) { shuffleCache.pop(); }
    }

    _seedsOnClear(userClear, hadRows);

    return true;
  }

  // A clear is a new queue for the seeds: a lane edge (with "Clear pins when
  // the queue is cleared" ticked, a user's clear of a queue that held a row
  // takes the pins too), a new queue generation (a pick out is discarded
  // where it lands and asked again in the new lane), no re-roll owed.
  //
  // clearPlaylist also drops the cascade — re-bootstrap with two songs so
  // the post-clear playback has the same lookahead as a fresh Auto-DJ start
  // (without this, the same one-song stall hits whenever the user clears
  // their playlist mid-session). After the caller is done, and only while
  // the queue is still empty: a play that replaces the queue adds its rows
  // right after the clear, and those start the new lane (its first row is
  // the blend), where an immediate bootstrap would pick from the song
  // being thrown away.
  function _seedsOnClear(userClear, hadRows) {
    if (typeof AUTODJ !== 'undefined' && AUTODJ.seeds) {
      AUTODJ.seeds.laneEdge({
        clearPins: AUTODJ.clearsPinsOnClear({
          userClear,
          queueHadRows: hadRows,
          setting: AUTODJ.state.clearPinsOnQueueClear === true,
        }),
      });
    }
    _djQueueGen++;
    _rerollOwed = null;
    _emitAutoDj('queue');
    if (mstreamModule.playerStats.autoDJ === true) {
      setTimeout(() => {
        if (mstreamModule.playerStats.autoDJ === true && mstreamModule.playlist.length === 0) {
          _autoDjQueueN(2);
        }
      }, 0);
    }
  }

  // The user's Next (the player bar, hotkeys, the jukebox, the media keys).
  // A quick skip of a DJ pick is judged before the move; a learned one owes
  // a re-roll of the DJ rows queued ahead without its negative.
  mstreamModule.nextSong = function () {
    const owed = _judgeQuickSkip();
    const r = goToNextSong();
    if (owed) {
      _rerollOwed = owed;
      autoDJ();
    }
    return r;
  }

  // The Next about to happen, judged before the move: a quick skip (heard
  // at least a second, short of a play, with a row to go to) of a DJ pick,
  // or of the lane's blended song while More like holds it unpinned, with
  // the DJ on in Drift. The song leaves More like unless the user pinned it
  // there; it is learned (joins Less like) with Learn from skips, sonic on,
  // a server that takes negatives, and only for this server's DJ pick. A
  // learned skip that changed what this server would be sent moves the
  // queue's generation; it owes a re-roll ({ stale }: the DJ rows strictly
  // after the row the Next lands on) when such rows exist, else null.
  //
  // Heard time is the open play session's (which leaves seeks and pauses
  // out) when it is this row's, else the player's position; the length is
  // the session's, else the player's, else the row's.
  function _judgeQuickSkip() {
    if (typeof AUTODJ === 'undefined' || !AUTODJ.seeds) { return null; }
    if (mstreamModule.playerStats.autoDJ !== true || AUTODJ.state.sonicAnchorMode === 'locked') { return null; }
    const { row, pos } = _currentRow();
    const facts = AUTODJ.seeds.factsFromSong(row);
    if (!row || !facts) { return null; }
    const meta = row.metadata || {};
    const djPick = meta._djPicked === true;
    const key = AUTODJ.seeds.keyOf(facts.owner, facts.path);
    const blendable = !djPick && AUTODJ.seeds.blendSkippable(key);
    const ms = (sec) => {
      const n = Number(sec);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
    };
    const session = playSession && playSession.filePath === row.rawFilePath ? playSession : null;
    const heardMs = session ? session.playedMs : Math.round((Number(mstreamModule.playerStats.currentTime) || 0) * 1000);
    const durationMs = (session && session.durationMs) || ms(mstreamModule.playerStats.duration) || ms(meta.duration);
    const hasNext = !!mstreamModule.playlist[pos + 1];
    if (!AUTODJ.isQuickSkip({ djPick: djPick || blendable, heardMs, durationMs, hasNext })) { return null; }
    const server = typeof MSTREAMAPI !== 'undefined' ? MSTREAMAPI.currentServer : null;
    const learn = djPick && AUTODJ.state.learnFromSkips === true && AUTODJ.state.sonicEnabled === true
      && AUTODJ.seeds.takesNegatives(server) && facts.owner === null;
    // A Less like row whose time just ran out goes first, so its going is
    // not taken for this skip's doing.
    AUTODJ.seeds.prune();
    const sentBefore = _negativesSent();
    AUTODJ.seeds.quickSkip(facts, { djPick, learn });
    if (_negativesSent() === sentBefore) { return null; }
    _djQueueGen++;
    const stale = mstreamModule.playlist.slice(pos + 2)
      .filter((r) => r && r.metadata && r.metadata._djPicked === true);
    return stale.length > 0 ? { stale } : null;
  }

  // The negatives this server would be sent now, as one comparable value
  // (order left out; '' while it takes none).
  function _negativesSent() {
    if (!_wireTakesNegatives()) { return ''; }
    return JSON.stringify(AUTODJ.seeds.negatives().slice().sort());
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
    _emitAutoDj('queue');
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

    // The starting song's side effects first (a DJ pick joins More like as
    // it starts playing), then the top-up, whose body reads them.
    mstreamModule.resetCurrentMetadata();
    _topUpIfLast(position);
    
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

    // Count the play: the complete play is reported once this song is over.
    beginPlaySession(mstreamModule.playlist[position]);
  }

  // The queue-end top-up: the song that just started at [position] is the
  // last row, so the DJ fetches the next one now.
  function _topUpIfLast(position) {
    if (mstreamModule.playerStats.autoDJ === true && position === mstreamModule.playlist.length - 1) {
      autoDJ();
    }
  }

  // Should be called whenever the "metadata" field of the current song is changed, or
  // the current song is changed.
  mstreamModule.resetCurrentMetadata = () => {
    const curSong = getCurrentPlayer().songObject;
    mstreamModule.playerStats.metadata.artist = curSong.metadata && curSong.metadata.artist ? curSong.metadata.artist : "";
    // V73 credits: the ARTIST tag as written ("A feat. B") for the card,
    // the composer line. The plain `artist` stays the primary artist —
    // it is what goToArtist navigates to.
    mstreamModule.playerStats.metadata['artist-display'] = curSong.metadata && curSong.metadata['artist-display'] ? curSong.metadata['artist-display'] : "";
    mstreamModule.playerStats.metadata.composer = curSong.metadata && curSong.metadata.composer ? curSong.metadata.composer : "";
    mstreamModule.playerStats.metadata.album = curSong.metadata && curSong.metadata.album  ? curSong.metadata.album : "";
    mstreamModule.playerStats.metadata.track = curSong.metadata && curSong.metadata.track ? curSong.metadata.track : "";
    mstreamModule.playerStats.metadata.title = curSong.metadata && curSong.metadata.title ? curSong.metadata.title : "";
    mstreamModule.playerStats.metadata.year = curSong.metadata && curSong.metadata.year ? curSong.metadata.year : "";
    mstreamModule.playerStats.metadata['album-art'] = curSong.metadata && curSong.metadata['album-art'] ? curSong.metadata['album-art'] : "";
    const rgainDb = replayGainDbOf(curSong.metadata);
    mstreamModule.playerStats.metadata['replaygain-track-db'] = rgainDb !== null ? rgainDb : "";
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
        artist: mstreamModule.playerStats.metadata['artist-display'] || mstreamModule.playerStats.metadata.artist,
        album: mstreamModule.playerStats.metadata.album,
        artwork: [] //TODO: Get album art working here
      });
    }
    
    let pageTitle = (mstreamModule.playerStats.metadata.title) ? 
    mstreamModule.playerStats.metadata.title + ' - ' + mstreamModule.playerStats.metadata.artist : // if metadata exists
        (mstreamModule.playerStats.metadata.filepath ? mstreamModule.playerStats.metadata.filepath.split('/').pop() : 'mStream Music');
    document.title = pageTitle; // set page title when song is playing
    
    mstreamModule.updateReplayGainFromSong(curSong);
    _emitAutoDj('song');
  }

  // A song's track gain in dB, or null when it carries none. The server
  // sends it as `replaygain-track` (renderMetadataObj); `replaygain-track-db`
  // is the pre-SQLite spelling a peer on an old mStream may still send.
  // 0 dB is a real gain (play as is), not a missing one.
  function replayGainDbOf(metadata) {
    if (!metadata) { return null; }
    const db = metadata['replaygain-track'] ?? metadata['replaygain-track-db'];
    return typeof db === 'number' && Number.isFinite(db) ? db : null;
  }

  // Update ReplayGain state from given song, if required.
  mstreamModule.updateReplayGainFromSong = function (song) {
    console.assert(song);
    var newRgAmpValue = undefined;

    if (mstreamModule.playerStats.replayGain) {
      if (song.metadata) {
        const rgainDb = replayGainDbOf(song.metadata);
        if (rgainDb !== null) {
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
    resumePlaySession();
    localPlayer.playerObject.play();
  }
  function howlPlayerPause() {
    const localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = false;
    pausePlaySession();
    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause() {
    const localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.paused === false) {
      mstreamModule.playerStats.playing = false;
      pausePlaySession();
      localPlayer.playerObject.pause();
      document.title = "mStream Music"
    } else {
      resumePlaySession();
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
    // EVERY field resetCurrentMetadata() writes must be declared here.
    // Vue 2 can only make properties reactive at observation time, so a
    // field that only ever appears via assignment gets no accessor and no
    // dependency tracking: watchers and computeds that read it never
    // invalidate. `musical-key` was missing, which froze the key shown on
    // the now-playing card at whatever the first keyed track of the
    // session was, for every track after it. `bpm` survived only because
    // it happens to be interpolated directly rather than through a
    // computed, and `replaygain-track-db` has no default-UI reader today
    // — both are declared anyway so the next reader doesn't inherit the
    // same silent breakage.
    metadata: {
      "artist": "",
      "artist-display": "",
      "composer": "",
      "album": "",
      "track": "",
      "title": "",
      "year": "",
      "album-art": "",
      "filepath": "",
      "has-lyrics": false,
      "has-synced-lyrics": false,
      "bpm": null,
      "musical-key": null,
      "replaygain-track-db": "",
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
        endPlaySession('stopped');
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
      mstreamModule.playerStats.currentTime = (cur.seekOffset || 0) + cur.playerObject.currentTime;
      tickPlaySession();

      // Duration: a chunked transcode stream has no usable audio.duration
      // (Infinity until fully buffered, and a seeked stream only spans the
      // remainder), so trust the track's metadata duration there. Direct files
      // report an exact audio.duration.
      const adur = cur.playerObject.duration;
      const metaDur = cur.songObject && cur.songObject.metadata ? Number(cur.songObject.metadata.duration) : NaN;
      if (isTranscoding()) {
        mstreamModule.playerStats.duration = (Number.isFinite(metaDur) && metaDur > 0)
          ? metaDur : (Number.isFinite(adur) ? adur : 0);
      } else {
        mstreamModule.playerStats.duration = (Number.isFinite(adur) && adur > 0)
          ? adur : (Number.isFinite(metaDur) ? metaDur : 0);
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
    player.seekOffset = 0; // a fresh song starts at the beginning
    player.playerObject.src = buildStreamUrl(song, 0);
    player.songObject = song;
    player.playerObject.load();
    player.playerObject.playbackRate = mstreamModule.playerStats.playbackRate;

    player.playerObject.onended = () => {
      callMeOnStreamEnd();
    }

    if (play == true) {
      howlPlayerPlay();
    }
  }

  function callMeOnStreamEnd() {
    mstreamModule.playerStats.playing = false;
    endPlaySession('completed');
    if (mstreamModule.playerStats.shouldLoopOne === true) {
      return goToSong(mstreamModule.positionCache.val);
    }
    // Go to next song
    goToNextSong();
  }

  // Seek to an absolute position (seconds). Direct /media files seek natively
  // (byte ranges); a transcoded stream isn't seekable in the browser, so we
  // re-request it from the server with ?offset= and reload — see transcodeSeek.
  function seekToAbsolute(targetSec) {
    const lPlayer = getCurrentPlayer();
    if (!lPlayer.songObject) { return; }
    const dur = mstreamModule.playerStats.duration;
    if (!(targetSec >= 0)) { targetSec = 0; }
    if (Number.isFinite(dur) && dur > 0 && targetSec > dur) { targetSec = dur; }

    if (isTranscoding()) {
      transcodeSeek(targetSec);
    } else {
      lPlayer.seekOffset = 0;
      lPlayer.playerObject.currentTime = targetSec;
    }
  }

  // Server-side seek for transcoded playback: reload the stream from `-ss
  // targetSec`, remember the offset so the playhead reads correctly, and
  // resume playback if it was playing.
  function transcodeSeek(targetSec) {
    const lPlayer = getCurrentPlayer();
    const wasPlaying = mstreamModule.playerStats.playing === true;
    lPlayer.seekOffset = targetSec;
    lPlayer.playerObject.src = buildStreamUrl(lPlayer.songObject, targetSec);
    lPlayer.playerObject.load();
    lPlayer.playerObject.playbackRate = mstreamModule.playerStats.playbackRate;
    mstreamModule.playerStats.currentTime = targetSec; // reflect immediately
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

  // Queue Auto-DJ fetches until at least N songs have been added. The
  // autoDJ() function is guarded against re-entrancy (a second call
  // while the first is in flight returns the same in-flight promise),
  // so each fetch is awaited before the next — calling autoDJ() twice
  // in a row collapses to a single fetch. One fetch adds up to
  // AUTODJ.state.djLimit songs: at the default of 1 that is two fetches
  // here, at any larger setting a single fetch already covers the runway.
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
    const start = mstreamModule.playlist.length;
    while (mstreamModule.playlist.length - start < n) {
      if (mstreamModule.playerStats.autoDJ !== true) { return; }
      const before = mstreamModule.playlist.length;
      try {
        await autoDJ();
      } catch (_) { /* autoDJ already toasts; don't stack errors */ }
      // A fetch that added nothing failed (autoDJ toasted why) — the
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

      _seedsOnToggle(true);

      // Bootstrap two songs when the playlist is empty OR we're
      // already sitting on the last track (the user toggled Auto-DJ
      // ON mid-playback at the queue tail). Without two on start
      // the cascade can't begin — see _autoDjQueueN's comment block.
      if (mstreamModule.playlist.length === 0 || mstreamModule.positionCache.val === mstreamModule.playlist.length - 1) {
        _autoDjQueueN(2);
      }
    } else {
      _seedsOnToggle(false);
      // Cancel an in-flight pick so its response doesn't land back
      // into AUTODJ.state after the user turned the feature off.
      _autoDjAbortController?.abort();
    }

    return mstreamModule.playerStats.autoDJ;
  }

  // Start and Stop are lane edges for the seeds: the DJ's unpinned picks
  // start over (the user's pins stay; Stay close keeps every row), a pick
  // out is discarded where it lands, and a re-roll still owed is settled.
  // Rows the user adds while the DJ is off are held aside until the lane's
  // first pick. The panel hears of it ('dj').
  function _seedsOnToggle(on) {
    if (typeof AUTODJ !== 'undefined' && AUTODJ.seeds) {
      AUTODJ.seeds.setArmed(on === true);
      AUTODJ.seeds.laneEdge({});
    }
    _djQueueGen++;
    _rerollOwed = null;
    _emitAutoDj('dj');
  }

  // Nudge a stalled Auto-DJ session into picking. Used by the Seeds
  // drawer after a song joins More like: when the user enabled Auto-DJ
  // on an empty queue and the bootstrap pick failed (a filter nothing
  // matched, a server hiccup), nothing re-triggers it — so the drawer
  // calls this right after a seed is added.
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

  // Player hotkeys — the central keymap shared by the main UI and the
  // shared-playlist page. Bindings persist in localStorage ('playerHotkeys')
  // as { enabled, bindings: { action: combo|null } } and are merged over the
  // defaults on load, so new actions pick up their default key automatically
  // and unknown/stale actions are dropped. A combo is event.key (lowercased
  // for single characters) with an optional 'ctrl+' prefix, e.g. 'm',
  // 'ctrl+ArrowRight', '<'. A null binding means the action is unbound.
  // percentSeek is special: it covers the digit row 0-9 and is stored as the
  // sentinel '0-9' (any truthy value enables it, null disables it).
  const HOTKEY_STORAGE_KEY = 'playerHotkeys';
  const hotkeyDefaults = {
    playPause: ' ',
    playPauseAlt: 'k',
    seekBack: 'ArrowLeft',
    seekForward: 'ArrowRight',
    bigSeekBack: 'j',
    bigSeekForward: 'l',
    prevTrack: 'ctrl+ArrowLeft',
    nextTrack: 'ctrl+ArrowRight',
    volumeUp: 'ArrowUp',
    volumeDown: 'ArrowDown',
    mute: 'm',
    shuffle: 's',
    repeat: 'r',
    speedDown: '<',
    speedUp: '>',
    percentSeek: '0-9',
  };

  function sanitizeHotkeyConfig(raw) {
    const cfg = { enabled: true, bindings: Object.assign({}, hotkeyDefaults) };
    if (raw && typeof raw === 'object') {
      if (raw.enabled === false) { cfg.enabled = false; }
      if (raw.bindings && typeof raw.bindings === 'object') {
        Object.keys(hotkeyDefaults).forEach((action) => {
          const val = raw.bindings[action];
          if (val === null || typeof val === 'string') { cfg.bindings[action] = val; }
        });
      }
    }
    return cfg;
  }

  let hotkeyConfig = (() => {
    try {
      return sanitizeHotkeyConfig(JSON.parse(localStorage.getItem(HOTKEY_STORAGE_KEY)));
    } catch (err) {
      return sanitizeHotkeyConfig(null);
    }
  })();

  mstreamModule.hotkeys = {
    defaults: Object.assign({}, hotkeyDefaults),
    getConfig: () => ({
      enabled: hotkeyConfig.enabled,
      bindings: Object.assign({}, hotkeyConfig.bindings),
    }),
    saveConfig: (newCfg) => {
      hotkeyConfig = sanitizeHotkeyConfig(newCfg);
      try {
        localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(hotkeyConfig));
      } catch (err) { /* storage unavailable — config still applies for this session */ }
    },
    // Map a keydown event to a bound action name, or null if the key is
    // unclaimed. Alt/Meta combos are never claimed (browser/OS shortcuts,
    // e.g. Alt+Left = back). Shift is inherent to typing printable
    // characters ('<' is Shift+comma) so it is ignored for single-char
    // combos, but shifted named keys (Shift+ArrowRight etc.) stay free
    // for text selection.
    resolve: (event) => {
      if (!hotkeyConfig.enabled) { return null; }
      if (event.altKey || event.metaKey) { return null; }
      if (event.key.length > 1 && event.shiftKey) { return null; }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const combo = (event.ctrlKey ? 'ctrl+' : '') + key;
      const bindings = hotkeyConfig.bindings;
      const match = Object.keys(bindings).find(
        (action) => action !== 'percentSeek' && bindings[action] === combo
      );
      if (match) { return match; }
      if (bindings.percentSeek && !event.ctrlKey && /^[0-9]$/.test(event.key)) {
        return 'percentSeek';
      }
      return null;
    },
  };

  // Setup Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function() { howlPlayerPlay(); });
    navigator.mediaSession.setActionHandler('pause', function() { howlPlayerPause(); });
    navigator.mediaSession.setActionHandler('stop', function() { howlPlayerPause(); });
    // navigator.mediaSession.setActionHandler('seekbackward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekforward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekto', function() { /* Code excerpted. */ });
    navigator.mediaSession.setActionHandler('previoustrack', function() { goToPreviousSong(); });
    // The media key is the user's Next: a quick skip is judged on it too.
    navigator.mediaSession.setActionHandler('nexttrack', function() { mstreamModule.nextSong(); });
  }

  // Return an object that is assigned to Module
  return mstreamModule;
})();
