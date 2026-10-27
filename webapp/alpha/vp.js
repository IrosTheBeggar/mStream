const VUEPLAYERCORE = (() => {
  const mstreamModule = {};

  // A playlist lives on THIS server and stores paths in ITS namespace, so a
  // federated track can never be saved into one. Every live-playlist re-save
  // rebuilds from the whole queue, which may hold peer tracks — drop them,
  // and say so once so the user knows the saved playlist is not exactly what
  // is on screen. Once per page load on purpose: this fires on every drag,
  // remove and insert, and a toast per drag would be noise.
  let warnedMixedQueue = false;
  function localQueueFilepaths() {
    const all = MSTREAMPLAYER.playlist;
    const local = all.filter(song => !song.federation);
    if (local.length !== all.length && !warnedMixedQueue) {
      warnedMixedQueue = true;
      iziToast.info({ title: t('playlist.federatedSkipped'), position: 'topCenter', timeout: 4000 });
    }
    return local.map(song => song.filepath);
  }
  // m.js starts and clears live playlists too, and every one of those paths
  // re-saves the whole queue — they all have to go through the same filter.
  mstreamModule.localQueueFilepaths = localQueueFilepaths;

  // Re-persist the live playlist to the local-only tracks now queued. THE one
  // place every queue mutation re-saves, so a new mutation site can't forget
  // the federation filter the way the live-playlist START once did.
  function saveLiveQueue() {
    if (mstreamModule.livePlaylist.name) {
      MSTREAMAPI.savePlaylist(mstreamModule.livePlaylist.name, localQueueFilepaths(), true);
    }
  }
  mstreamModule.saveLiveQueue = saveLiveQueue;

  mstreamModule.livePlaylist = {
    name: false
  };

  mstreamModule.altLayout = {
    'moveMeta': true,
    'audioBookCtrls': false,
    'flipPlayer': true,
    'compressArt': false,
    'hideTopBar': false,
    'waveformBar': true,
    // Artists panel: album-only credits (Various Artists) listed; leading
    // articles honoured in the sort.
    'artistsShowAlbumOnly': true,
    'artistsIgnoreArticles': false
  };

  try {
    const altLayout = JSON.parse(localStorage.getItem('altLayout'));
    mstreamModule.altLayout.flipPlayer = typeof altLayout.flipPlayer === 'boolean' ? altLayout.flipPlayer : true;
    mstreamModule.altLayout.audioBookCtrls = typeof altLayout.audioBookCtrls === 'boolean' ? altLayout.audioBookCtrls : false;
    mstreamModule.altLayout.moveMeta = typeof altLayout.moveMeta === 'boolean' ? altLayout.moveMeta : true;
    mstreamModule.altLayout.compressArt = typeof altLayout.compressArt === 'boolean' ? altLayout.compressArt : false;
    mstreamModule.altLayout.hideTopBar = typeof altLayout.hideTopBar === 'boolean' ? altLayout.hideTopBar : false;
    mstreamModule.altLayout.waveformBar = typeof altLayout.waveformBar === 'boolean' ? altLayout.waveformBar : true;
    mstreamModule.altLayout.artistsShowAlbumOnly = typeof altLayout.artistsShowAlbumOnly === 'boolean' ? altLayout.artistsShowAlbumOnly : true;
    mstreamModule.altLayout.artistsIgnoreArticles = typeof altLayout.artistsIgnoreArticles === 'boolean' ? altLayout.artistsIgnoreArticles : false;

    // When the top bar is disabled, mark the body so CSS can:
    //   - hide #nav-bar
    //   - show the sidenav logo (its original spot)
    //   - show the sidenav bottom language picker
    //   - recompute #content / #sidenav heights
    if (altLayout.hideTopBar === true) {
      document.body.classList.add('top-bar-hidden');
    }
  } catch (e) {}

  // Apply the resolved player position. This runs outside the try/catch above so
  // it also fires on a fresh browser with no stored altLayout, where flipPlayer
  // now defaults to true.
  if (mstreamModule.altLayout.flipPlayer === true) {
    document.getElementById('content').classList.add('col-rev');
    document.getElementById('flip-me').classList.add('col-rev');
  }

  const replayGainPreGainSettings = [
    -15.0,
    -10.0,
    -6.0,
    0.0
  ];
  var replayGainInfoTimeout;

  // Hide rating popover on click
  document.onmouseup = (e) => {
    if(!e.target.classList.contains('pop-c')){
      document.getElementById("pop").style.visibility = "hidden";
      currentPopperSongIndex = false;
    }

    if(!e.target.classList.contains('pop-d')){
      document.getElementById("pop-d").style.visibility = "hidden";
      cpsi = false;
    }

    if(!e.target.classList.contains('pop-f')){
      document.getElementById("pop-f").style.visibility = "hidden";
    }
  }

  new Vue({
    el: '#speed-modal',
    data: {
      stats: MSTREAMPLAYER.playerStats
    },
    computed: {
      widthcss: function () {
        const percentage = ((this.stats.playbackRate / 3.75) * 100) - 6.75;
        return `width:calc(${percentage}%)`;
      },
    },
    methods: {
      changeSpeed: function() {
        const rect = this.$refs.progressWrapper.getBoundingClientRect();
        const x = event.clientX - rect.left; //x position within the element.
        const percentage = x / rect.width;
        MSTREAMPLAYER.changePlaybackRate(percentage * 3.75 + 0.25);
      },
      changeSpeed2: function(speed) {
        MSTREAMPLAYER.changePlaybackRate(speed);
      }
    }
  });

  // star rating popper
  var currentPopperSongIndex2;
  var currentPopperSongIndex;
  var currentPopperSong;
  const showClearLink = { val: false };

  // add to playlist popper
  mstreamModule.playlists = [];
  var cpsi;
  var cps;

  // Discover panel state (model-powered similar tracks/artists for the
  // current song — /api/v1/discovery/*). `available` comes from the ping
  // response (see setDiscoveryAvailable below), so servers without the
  // discovery feature never render the panel and the webapp never probes
  // /api/v1/discovery/*. Collapsed by default; while collapsed NO discovery
  // requests are sent — song changes just mark the panel dirty and the
  // fetch happens on expand.
  const discoverState = {
    available: false,
    disabled: false,          // server said 403 — stop asking
    loading: false,
    notAnalyzed: false,
    collapsed: (() => { try { return localStorage.getItem('discoverCollapsed') !== 'false'; } catch (_) { return true; } })(),
    seedTitle: '',
    // Which source the panel shows — 'library' | 'network' | 'peers' — one
    // at a time (docs/designs/discover-panel, alternate A). Remembered;
    // discoverSource() falls back to the library when the choice is gone.
    source: (() => { try { const v = localStorage.getItem('discoverSource'); return ['library', 'network', 'peers'].indexOf(v) !== -1 ? v : 'library'; } catch (_) { return 'library'; } })(),
    tracks: [],
    artists: [],
    // "From the network" (discovery P2P): similar tracks on OTHER servers'
    // fetched snapshots. Metadata-only — these rows aren't playable; they're
    // leads. Same reveal contract as `available`: the ping response's
    // discoveryP2p flag, never a probe.
    p2p: {
      available: false,
      disabled: false,        // server said 403 — stop asking
      tracks: [],
      searchedPeers: null,    // null = never fetched; 0 = network still warming up
      newArtistsOnly: (() => { try { return localStorage.getItem('discoverNewArtistsOnly') === 'true'; } catch (_) { return false; } })(),
    },
    // Peer Recommendations' clip (m.js, the page): the one lead's 30-second
    // preview the page's rows and band and the window's Preview section all
    // read (clipStart and the rest of the clip* methods, blankDiscoverClip).
    clip: blankDiscoverClip(),
    // "From your peers" (discovery over federation): live similarity answers
    // from the servers this one is PAIRED with. Same reveal contract — the
    // ping response's federationDiscovery flag, never a probe. Leads for now
    // (playable once the federation stream proxy lands). Shares the p2p
    // section's newArtistsOnly toggle: one semantic, one knob.
    fed: {
      available: false,
      disabled: false,        // server said 403 — stop asking
      tracks: [],
      searchedPeers: null,    // null = never fetched; 0 = nobody answered
      unreachable: 0,         // peers that timed out/failed on the last ask
      mismatched: 0,          // peers on a different embedding model
    },
    // Discovery plug-ins: what this server lets a user DO with a network or
    // peer row (/api/v1/discovery/plugins). Same reveal contract — ping's
    // discoveryPlugins flag, never a probe; the list is fetched on the first
    // menu open. Without plug-ins a row click falls back to the copy.
    plugins: {
      available: false,
      list: null,             // null = not fetched yet
      jobsAllowed: false,     // the listing's jobs.allowed — may this account start jobs
      // the listing's jobs.maxFolderSongs — the most songs one folder copy
      // takes here; null = not said (an older server: no cap is known)
      maxFolderSongs: null,
    },
    // The collection destination — where Keep a copy copies and "Get it"
    // downloads land (GET /api/v1/discovery/collection/destination).
    // Read again with every window that could use it — another tab or client
    // may have saved one since — the last one known drawn meanwhile
    // (dmLoadDestination). `view.destination` null = nowhere to put a file
    // (uploads off, no library): the acquire rows and the bar stay hidden
    // rather than fail. `saves` counts the editor's saves that answered: a
    // read sent before one answers with the place from before it.
    dest: {
      view: null,
      saves: 0,
    },
    // The downloads strip under the panel: the caller's plug-in jobs that
    // still want them (live, failed). Shows only while there are any; what
    // landed is listed by the Downloads panel (m.js).
    tray: {
      jobs: [],
      // Folded to one line unless the user opened it: the line says what
      // is running and how it is doing.
      collapsed: (() => { try { return localStorage.getItem('discoverTrayCollapsed') !== 'false'; } catch (_) { return true; } })(),
    },
    // Whether this user is an admin (/api/'s `user.admin`): the
    // recommendation modal shows its "Invite <peer> to federate" row to
    // admins only.
    admin: false,
    // The seed path of the current Discover fetch — what "more like this on
    // <peer>" re-asks with.
    seedPath: '',
    // The one open recommendation modal (a network or peer row). `gen`
    // fences async answers: a reply for a closed or replaced window is
    // dropped. links / previews / playing = the plug-in sections; peer /
    // file / album / artist = the facts a peer row's window fetches;
    // federate = the admin's invite row on a network row; recKey / jobs /
    // jobBusy / jobErrors = the acquire rows (plug-in name → the caller's
    // newest job for this recommendation); picker = the collection
    // destination form, open in place.
    modal: blankDiscoverModal(),
  };
  function blankDiscoverModal(over) {
    return Object.assign({
      open: false,
      gen: 0,
      source: null,           // 'p2p' | 'federation'
      track: null,
      // What the match bar names (dmMatchSeed): a seed title (quoted) or a
      // plain phrase, from the Discover page; null = the panel's own seed
      matchSeed: null,
      matchPlain: null,
      // 'album' = the window reads as the row's album (a Discover album
      // card's ⋯, a connected server's album page or card, or an album job
      // reopened from the strip): the album is the title, Listen plays the
      // album, Keep offers Album and Artist with Album chosen. 'artist' = a
      // connected server's artist page: the artist is the title, no Listen
      // and no Find elsewhere, Keep offers Artist alone. 'folder' = a folder
      // of its file explorer: the folder is the title, Listen plays it, Keep
      // offers Folder alone, with where it lands. null = the song.
      focus: null,
      // Where the window was opened from: 'browse' = a connected server's
      // own pages (m.js), whose songs may come without tags or an album
      // credit (dmLoadPeerFacts reads them); 'peerRecs' = a lead of the
      // Peer Recommendations page (its tile, its peer line, one Preview
      // control, Get it… chips, its own Copy row: dmPeerRecs); null =
      // Discover, the now-playing panel, the strip.
      from: null,
      // From Peer Recommendations: the lead's tile as the server stamped it
      // ({ key, hue, letter }: dmTileOf) — the header until a preview earns
      // the album's art — and its peer line ({ label, online }: the dot).
      tile: null,
      peerLine: null,
      // The fact links the page behind the window already is ('viewAlbum',
      // 'viewArtist'): hidden (dmHidden).
      hide: [],
      // A song of a file explorer's: the folder it sits in, { path, name }
      // (the peer's path, library first) — Keep's Folder choice. null
      // elsewhere, and for a song at its library's root.
      folder: null,
      // A song from an album page whose songs name different album artists
      // (the page's own word): no Album — whatever its tags or the peer's
      // album list would say.
      creditsDisagree: false,
      // The folder copy's count (dmLoadFolderScan): { state: 'counting' |
      // 'done' | 'failed', songs, subfolders, paths } — paths what the copy
      // takes, in path order (DISCOVERJOBS.planFolder). null = not asked.
      folderScan: null,
      // The folder's songs' tags, read once for "By your layout"
      // (dmLoadFolderTags): { state: 'loading' | 'done' | 'failed' |
      // 'skipped' (past FOLDER_TAGS_MAX songs), songs } — songs as
      // DISCOVERJOBS.folderSongTags reads them. null = not asked.
      folderTags: null,
      loading: false,
      links: [],
      error: false,
      previews: {},
      playing: null,
      peer: null,
      file: null,
      album: null,
      artist: null,
      federate: null,
      recKey: null,
      // every scope's key for the recommendation (the lookup's `keys`), so a
      // poll can tell which jobs are this window's
      recKeys: null,
      jobs: {},
      jobBusy: {},
      jobErrors: {},
      // slot → a start the server refused, as it put it: { status (0 = no
      // answer), error } — what the Keep card's lines tell apart
      jobRefusals: {},
      // plug-in name → its lookup (what "Get it" would fetch): see dmLookup.
      lookups: {},
      // The destination editor, open in place of the path bar: { vpath,
      // layout, custom, text, before, from, browse, saving, error, reset,
      // download } (dmOpenPicker).
      picker: null,
      // Whether this window's own read of the destination answered (the
      // bar draws the last one known until it does), and whether a read
      // since found none — a right lost while the window was open.
      destRead: false,
      destLost: false,
      // Keep a copy's card in a connected server's window: which scope the
      // one Add acts on (song · album · artist · folder), and whether an
      // artist copy takes only the albums the library lacks. A folder's
      // `landing`: 'mirror' (as on the peer) · 'folder' (into the folder
      // `into`, { vpath, path }: null = the first place, a new folder named
      // as the pressed one — dmFolderInto) · 'tags' (by the layout); `tree`
      // the folder list "Into a folder…" shows, { loading, dirs, failed,
      // naming, newName, braced } (dmIntoLoad).
      keep: { scope: 'song', onlyMissing: true, landing: 'mirror', into: null, tree: null },
    }, over || {});
  }
  // "By your layout" reads a folder's tags only up to this many songs
  // (one metadata batch); past it every tag variable is a slot.
  const FOLDER_TAGS_MAX = 100;
  // An attribute value inside a [name="…"] selector.
  function dmAttrValue(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }
  // An artist or album name as the server compares them (src/db/name-key.js
  // nameKey): whitespace runs collapsed, quote and dash variants folded,
  // lowercased — so the window's "albums you don't have" is the copy's.
  function dmNameKey(raw) {
    if (raw == null) { return ''; }
    return String(raw).replace(/\s+/g, ' ').trim()
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .toLowerCase();
  }
  // A line that opens a sentence (a server's "asking Stage Peer B about
  // the file" under a headline): its first letter capitalised.
  function dmCapital(text) {
    const s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }
  let discoverDebounce = null;
  let discoverReqId = 0;
  let discoverDirty = false;   // song changed while collapsed → refetch on expand

  // ── The aside player (docs/peer-recommendations-plan.md §2 items 13–14) ──
  // The one 30-second clip that plays beside the main player: the window's
  // preview tiles (owner 'window') and Peer Recommendations' clip (owner
  // 'clip', discoverState.clip) share ONE reused <audio> element — Safari
  // lets an element that played after a press play again without one, so
  // Preview all can chain — so only one clip ever plays. Every claim takes
  // a new token: the element's events reach only the owner whose claim
  // loaded it, through its handlers ({ time, ended, error, stopped }). The
  // main player is paused when a session's first clip starts (only if it
  // was playing), stays paused across hand-offs (the next clip, another
  // owner), and plays again once, when the session ends; the user starting
  // it ends the clip, and nothing resumes it for that clip later.
  //   el              the element (asideEl), made on the first clip
  //   owner / on      who holds the aside, and its handlers
  //   token / loaded  the current claim, and the claim whose clip the
  //                   element holds (null = none)
  //   pausedMain      this session paused the main player: it resumes it
  //   mainWasPlaying  the main player played when the session was claimed
  //                   (a session asked while it was paused ends if the user
  //                   starts it before the clip does)
  const aside = { el: null, owner: null, on: null, token: 0, loaded: null, pausedMain: false, mainWasPlaying: false };
  // The main player's stats; null where there is none.
  function asideMainStats() {
    return (typeof MSTREAMPLAYER !== 'undefined' && MSTREAMPLAYER.playerStats) ? MSTREAMPLAYER.playerStats : null;
  }
  // The element, made once. Its events go to the owner whose clip it holds.
  function asideEl() {
    if (aside.el) { return aside.el; }
    const el = new Audio();
    el.preload = 'auto';
    const holder = () => (aside.loaded !== null && aside.loaded === aside.token ? aside.on : null);
    el.addEventListener('timeupdate', () => { const on = holder(); if (on && on.time) { on.time(el.currentTime || 0); } });
    el.addEventListener('ended', () => { const on = holder(); if (on && on.ended) { on.ended(); } });
    el.addEventListener('error', () => { const on = holder(); if (on && on.error) { on.error(); } });
    aside.el = el;
    return el;
  }
  // `owner` takes the aside — a clip still being asked for holds it too,
  // so the user starting the main player meanwhile ends it. Whatever
  // played stops; a different owner hears stopped('preempted'); the main
  // player stays as it is. → the claim's token.
  function asideClaim(owner, on) {
    const before = aside.owner;
    const told = aside.on;
    if (!before && !aside.pausedMain) {
      const s = asideMainStats();
      aside.mainWasPlaying = !!(s && s.playing === true);
    }
    aside.token += 1;
    aside.owner = owner;
    aside.on = on || null;
    if (aside.loaded !== null && aside.el) { try { aside.el.pause(); } catch (_) { /* already gone */ } }
    aside.loaded = null;
    if (before && before !== owner && told && told.stopped) { told.stopped('preempted'); }
    return aside.token;
  }
  // play() on the element for a claim; a refusal reaches the owner's
  // error handler (an AbortError is this aside's own pause or swap).
  function asideStart(el, token) {
    let p = null;
    try { p = el.play(); } catch (err) { p = Promise.reject(err); }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (aside.token !== token || aside.loaded !== token || (err && err.name === 'AbortError')) { return; }
        if (aside.on && aside.on.error) { aside.on.error(); }
      });
    }
  }
  // Play `url` for `owner`: a new claim, then the main player paused if it
  // plays (this session resumes it), then the one element. → the token.
  function asidePlay(owner, url, on) {
    const token = asideClaim(owner, on);
    const s = asideMainStats();
    if (s && s.playing === true) {
      aside.pausedMain = true;
      MSTREAMPLAYER.playPause();
    }
    const el = asideEl();
    aside.loaded = token;
    el.src = url;
    asideStart(el, token);
    return token;
  }
  // Pause and resume `owner`'s clip in place; the main player stays
  // paused. → whether it holds a clip to pause or resume.
  function asidePause(owner) {
    if (aside.owner !== owner || aside.loaded === null || aside.loaded !== aside.token || !aside.el) { return false; }
    try { aside.el.pause(); } catch (_) { /* already gone */ }
    return true;
  }
  function asideResume(owner) {
    if (aside.owner !== owner || aside.loaded === null || aside.loaded !== aside.token || !aside.el) { return false; }
    asideStart(aside.el, aside.token);
    return true;
  }
  // `owner` lets go: its clip stops and the session ends — the main player
  // plays again if the session paused it and it is still paused, unless
  // `resume` is false (a server switch, the user's own play). → whether it
  // held the aside.
  function asideStop(owner, resume) {
    if (!owner || aside.owner !== owner) { return false; }
    aside.token += 1;
    aside.owner = null;
    aside.on = null;
    if (aside.loaded !== null && aside.el) { try { aside.el.pause(); } catch (_) { /* already gone */ } }
    aside.loaded = null;
    const paused = aside.pausedMain;
    aside.pausedMain = false;
    const s = asideMainStats();
    if (paused && resume !== false && s && s.playing !== true) { MSTREAMPLAYER.playPause(); }
    return true;
  }
  // The main player's playing flag changed (playerVue's watcher, its first
  // line). The user starting it while a clip holds the aside — a session
  // that paused it, or one asked while it was paused — ends the clip, and
  // it is never resumed for that clip. The aside's own pause and resume
  // land here too and change nothing: the session they belong to has
  // already let go (or never paused it).
  function asideMainPlaying(on) {
    if (on !== true || !aside.owner || (!aside.pausedMain && aside.mainWasPlaying)) { return; }
    const told = aside.on;
    asideStop(aside.owner, false);
    if (told && told.stopped) { told.stopped('main'); }
  }

  // Peer Recommendations' clip (discoverState.clip; the clip* methods). A
  // fresh one: nothing asked yet this visit.
  //   key      PEERRECS.leadKey of the lead it is about
  //   raw      that lead, as the taste route sent it; tile its tile
  //   status   idle | resolving | waiting (a 429's wait) | playing | paused
  //            | none (no preview, for the visit) | failed (this press only)
  //   preview  the resolve's preview while it is the clip's
  //   at / seconds  where it is, and how long it is
  //   gen      fences every answer, retry and audio event
  //   art      tile key → the artwork a preview earned (§2 item 10)
  //   results  lead key → { status: 'ready' | 'none', preview }: what the
  //            visit's resolves answered (at most CLIP_RESULTS_MAX)
  function blankDiscoverClip() {
    return { key: null, raw: null, tile: null, status: 'idle', preview: null, at: 0, seconds: 30, gen: 0, art: {}, results: {} };
  }
  // The clip's statuses that hold the aside.
  const CLIP_LIVE = ['resolving', 'waiting', 'playing', 'paused'];
  // A press made while a resolve is out waits for it, then this long more;
  // a newer press takes its place meanwhile (plan §5.5).
  const CLIP_QUEUE_MS = 300;
  const CLIP_RESULTS_MAX = 200;
  // The one resolve in flight (a press's or Preview all's look ahead), the
  // press queued behind it ({ gen, attempt }) and its wait.
  const clipNet = { flight: false, queued: null, timer: null };
  // A 429's wait before its one retry.
  let clipRetryTimer = null;
  // Who hears the clip's events (mstreamModule.watchClip).
  const clipWatchers = [];
  // A preview a clip can play: one with a URL.
  function clipPreviewOf(p) {
    return p && typeof p === 'object' && typeof p.url === 'string' && p.url !== '' ? p : null;
  }
  // A lead's tile as the server stamped it — { key, hue, letter } with a
  // number for the hue — else null. Never computed here.
  function dmTileOf(v) {
    if (!v || typeof v !== 'object' || typeof v.hue !== 'number' || !Number.isFinite(v.hue)) { return null; }
    return { key: typeof v.key === 'string' ? v.key : '', hue: v.hue, letter: typeof v.letter === 'string' ? v.letter : '' };
  }
  // The window's peer line from the page's (PEERRECS.peerLine: { label,
  // online }), else the label the lead carries, with no dot.
  function dmPeerLineOf(line, track) {
    if (line && typeof line.label === 'string' && line.label.trim() !== '') { return { label: line.label, online: line.online === true }; }
    const p = track && track.peer;
    const label = p && typeof p.label === 'string' && p.label.trim() !== '' ? p.label : (p && typeof p.name === 'string' ? p.name.trim() : '');
    return label ? { label, online: false } : null;
  }
  // Recommendation modal bookkeeping: a generation counter that fences
  // async answers, the control the keyboard goes back to on close
  // (dmOpenerOf), and the key handler installed only while a window is open.
  let discoverModalGen = 0;
  let discoverModalOpener = null;
  // Keep a copy presses still waiting on the server (Add, Retry, Cancel…):
  // a poll that lands meanwhile leaves the keyboard to the press, which
  // hands it to the button now in the pressed one's place (dmKeepHold).
  let discoverKeepPresses = 0;
  // Who reads the ways-in gate again when the window learns it changed
  // (mstreamModule.watchKeepGate, dmKeepGateChanged).
  const discoverGateWatchers = [];
  function onDiscoverModalKey(e) {
    if (e.key === 'Tab') {
      // aria-modal holds the keyboard: Tab from the window's last control
      // wraps to Close, Shift+Tab from Close to the last
      const to = dmTrapTarget(dmTabbables(playlistVue.$refs.dmodal), document.activeElement, e.shiftKey);
      if (to) { e.preventDefault(); to.focus(); }
      return;
    }
    if (e.key !== 'Escape') { return; }
    // Esc closes the innermost thing first: the folder tree, the
    // destination form, a new folder being named under "Into a folder…",
    // then the window. Through their own methods, which say where the
    // keyboard goes next; if it fell out, Close takes it.
    const picker = discoverState.modal.picker;
    if (picker && picker.browse) { playlistVue.dmBrowseToggle(); playlistVue.dmHoldFocus(); return; }
    if (picker) { playlistVue.dmClosePicker(); playlistVue.dmHoldFocus(); return; }
    // (the name field only while it is on screen: under "Into a folder…",
    // the landings shown)
    const tree = discoverState.modal.keep && discoverState.modal.keep.tree;
    if (tree && tree.naming && discoverState.modal.keep.landing === 'folder' && playlistVue.dmLandShown()) { playlistVue.dmIntoNaming(false); playlistVue.dmHoldFocus(); return; }
    playlistVue.closeDiscoverModal();
  }
  // The window's controls in tab order (nothing in it sets a positive
  // tabindex, so that is DOM order): what a rendered control a Tab can
  // reach. A radio group is one stop — its checked radio, else its first.
  function dmTabbables(root) {
    if (!root || typeof root.querySelectorAll !== 'function') { return []; }
    const all = Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]'));
    return all.filter((el) => {
      if (el.disabled || el.type === 'hidden' || el.getAttribute('tabindex') === '-1') { return false; }
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) { return false; }   // not rendered
      if (el.type === 'radio' && el.name) {
        const group = all.filter((r) => r.type === 'radio' && r.name === el.name);
        const on = group.find((r) => r.checked);
        return el === (on || group[0]);
      }
      return true;
    });
  }
  // Where a Tab goes when the browser's own move would leave the window:
  // past either end it wraps; from outside it (focus fell to <body> when a
  // control went away) it lands on the first control, or Shift+Tab on the
  // last. null = the browser's own move, inside the window.
  function dmTrapTarget(list, active, back) {
    if (!list.length) { return null; }
    const at = list.indexOf(active);
    if (at === -1) { return back ? list[list.length - 1] : list[0]; }
    if (back && at === 0) { return list[list.length - 1]; }
    if (!back && at === list.length - 1) { return list[0]; }
    return null;
  }
  // The control a window was opened from — a Discover row's ⋯, an album
  // card's ⋯, a now-playing peer row, a Downloads strip row, a connected
  // server's page header button or row ⋯, a queue row's ⋮ — where the
  // keyboard goes back on close. For one of the Discover page's data-dp
  // controls also a selector that finds it again after the page redrew;
  // for a browse or queue control its data-keep-key (`key`: m.js draws
  // "{peerId}|{kind}|{what}", a queue row's ⋮ "{peerId}|queue|{file}").
  // Nothing for <body> (nothing had focus) or a control inside the window.
  function dmOpenerOf(el) {
    if (!el || typeof el.focus !== 'function' || typeof el.getAttribute !== 'function') { return null; }
    if (/^(body|html)$/i.test(el.tagName || '')) { return null; }
    if (typeof el.closest === 'function' && el.closest('.dmodal-shadow')) { return null; }
    const act = el.getAttribute('data-dp');
    let sel = null;
    if (act) {
      sel = `[data-dp="${act}"]`;
      for (const a of ['data-v', 'data-i']) {
        const val = el.getAttribute(a);
        if (val != null) { sel += `[${a}="${val}"]`; }
      }
    }
    return { el, sel, key: el.getAttribute('data-keep-key') || null };
  }
  // Focus back on the opener; on the control in its place when the page
  // redrew it (a button first: a lead's row and its ⋯ carry the same
  // data-dp, the row first in the page); when it is gone, on the Discover
  // page's first heading. A browse or queue control is found again by its
  // key — the filter and a poll redraw rows, and a queue row the list
  // reuses for another song carries another key — in the page's header,
  // its list or the queue; gone, a queue row's ⋮ hands over to the queue,
  // a page's control to the header's Keep a copy… button, else the panel's
  // title (the phone's tab where the title is hidden): never <body>. A row
  // or a heading is no control: it takes focus as tabindex -1, out of the
  // tab order. → the element focused, or null.
  function dmFocusBack(opener, doc) {
    const key = (opener && opener.key) || null;
    let el = opener && opener.el && opener.el.isConnected !== false ? opener.el : null;
    if (el && key && typeof el.getAttribute === 'function' && el.getAttribute('data-keep-key') !== key) { el = null; }
    if (!el && opener && opener.sel) {
      for (const at of ['#dpage-head .dpage', '#filelist .dpage']) {
        el = doc.querySelector(`${at} button${opener.sel}`) || doc.querySelector(`${at} ${opener.sel}`);
        if (el) { break; }
      }
    }
    if (!el && key) {
      const sel = `[data-keep-key="${dmAttrValue(key)}"]`;
      for (const at of ['#browse-head', '#filelist', '#playlist']) {
        el = doc.querySelector(`${at} ${sel}`);
        if (el) { break; }
      }
      const shown = (x) => !!x && (typeof x.getClientRects !== 'function' || x.getClientRects().length > 0);
      const fallback = key.split('|')[1] === 'queue' ? ['#playlist ul.collection'] : ['#browse-head .browse-keep', 'h5.panel_one_name', '.m-tab.panel_one_name'];
      for (const at of el ? [] : fallback) {
        const found = doc.querySelector(at);
        if (shown(found)) { el = found; break; }
      }
    }
    if (!el) { el = doc.querySelector('#filelist .dpage h3'); }
    if (!el || typeof el.focus !== 'function') { return null; }
    if (!/^(a|button|input|select|textarea)$/i.test(el.tagName || '') && !el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '-1'); }
    el.focus({ preventScroll: true });
    return el;
  }
  // Whether the links plug-in heard an album phrase as the album: its
  // release searches name the album. A server whose plug-in only takes a
  // song searched the credit alone, and has nothing for the album.
  function dmLinksNameAlbum(links, album) {
    const want = String(album || '').trim().toLowerCase();
    if (!want || !Array.isArray(links)) { return false; }
    return links.some((l) => {
      const url = String((l && l.url) || '');
      let text = url;
      try { text = decodeURIComponent(url); } catch (_) { /* a stray %: as written */ }
      return text.toLowerCase().indexOf(want) !== -1;
    });
  }
  // Plug-in jobs: the one in-flight fetch of the plug-in list (the window's
  // sections and the strip all wait on the same answer), the poll timer, and
  // whether the hidden-tab listener is installed. Polling runs only while a
  // job is live and the tab is visible.
  let discoverPluginsPromise = null;
  let discoverJobsTimer = null;
  let discoverJobsVisibilityHooked = false;
  let discoverJobsFailures = 0;   // consecutive failed polls — the beat slows while the server is away
  // Peer Recommendations' window follows its own live jobs by id
  // (dmPeerJobsPoll); the strip's list keeps its slower beat meanwhile.
  let discoverPeerJobsTimer = null;

  // Icons the job rows and the downloads strip share (24-unit box).
  const DM_ICONS = {
    download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    plus: 'M13 11h8v2h-8v8h-2v-8H3v-2h8V3h2v8z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    retry: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
    down: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    open: 'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h12c1.1 0 2-.9 2-2v-7h-2v7H5V7h7V5H5z',
    person: 'M12 5.9c1.16 0 2.1.94 2.1 2.1s-.94 2.1-2.1 2.1S9.9 9.16 9.9 8s.94-2.1 2.1-2.1m0 9c2.97 0 6.1 1.46 6.1 2.1v1.1H5.9V17c0-.64 3.13-2.1 6.1-2.1M12 4C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 9c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4z',
  };
  Vue.component('dm-icon', {
    props: { name: String, size: { type: Number, default: 16 } },
    computed: { path: function () { return DM_ICONS[this.name] || ''; } },
    template: '<svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24"><path fill="currentColor" :d="path"/></svg>',
  });

  // One plug-in's row under "Get it" in the recommendation window: the row
  // IS its job. `row` comes from DISCOVERJOBS.jobRowState; the buttons only
  // say what was pressed.
  Vue.component('dm-job-row', {
    props: { title: String, idleSub: String, startLabel: String, startIcon: { type: String, default: 'download' }, hint: String, row: Object, busy: Boolean },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
      has: function (action) { return this.row.actions.indexOf(action) !== -1; },
      sub: function () {
        const part = this.row.sub;
        if (!part) { return this.idleSub || ''; }
        if (Array.isArray(part.parts)) { return part.parts.map((p) => (p.key ? this.tt(p.key, p.params) : String(p.text || ''))).filter(Boolean).join(' · '); }
        return part.key ? this.tt(part.key, part.params) : String(part.text || '');
      },
    },
    template: `
      <div class="dm-opt" :class="{ 'dm-opt-muted': row.muted, 'dm-opt-wrap': row.actions.length > 2 }">
        <div class="dm-opt-ic" :class="{ 'dm-opt-ic-on': row.iconCls === 'on', 'dm-opt-ic-ok': row.iconCls === 'ok', 'dm-opt-ic-err': row.iconCls === 'err' }"><dm-icon :name="row.icon"></dm-icon></div>
        <div class="dm-opt-body">
          <div class="dm-opt-title" :title="hint">{{ title }}<span v-if="row.tag" class="dm-tag" :class="{ 'dm-tag-ok': row.tagCls === 'ok', 'dm-tag-src': row.tagCls === 'src', 'dm-tag-err': row.tagCls === 'err' }">{{ tt(row.tag) }}</span></div>
          <div class="dm-opt-sub" :class="{ 'dm-opt-sub-err': row.errored }" :title="sub()">{{ sub() }}</div>
          <div v-if="row.progress !== null" class="dm-progress" :class="{ 'dm-progress-indet': row.progress === 'indeterminate' }" role="progressbar" :aria-label="title" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="row.progress === 'indeterminate' ? null : row.progress"><i :style="row.progress === 'indeterminate' ? null : { width: row.progress + '%' }"></i></div>
        </div>
        <div class="dm-opt-act">
          <button v-if="has('play')" type="button" class="dm-btn dm-btn-primary" v-on:click="$emit('play')"><dm-icon name="play" :size="14"></dm-icon>{{ tt('discover.modal.play') }}</button>
          <button v-if="has('queue')" type="button" class="dm-btn" v-on:click="$emit('queue')"><dm-icon name="plus" :size="14"></dm-icon>{{ tt('discover.modal.queue') }}</button>
          <button v-if="has('start')" type="button" class="dm-btn dm-btn-primary" :class="{ 'is-busy': busy }" :aria-disabled="busy ? 'true' : null" v-on:click="$emit('start')"><dm-icon :name="startIcon" :size="14"></dm-icon>{{ startLabel }}</button>
          <button v-if="has('retry')" type="button" class="dm-btn" :class="{ 'is-busy': busy }" :aria-disabled="busy ? 'true' : null" v-on:click="$emit('start')"><dm-icon name="retry" :size="14"></dm-icon>{{ tt('discover.job.retry') }}</button>
          <button v-if="has('cancel')" type="button" class="dm-btn dm-btn-ghost" v-on:click="$emit('cancel')">{{ tt('discover.modal.cancel') }}</button>
        </div>
      </div>`,
  });

  // The lookup card: what an acquire plug-in with a lookup ("Get it" from
  // YouTube) WOULD fetch, before anything is. Idle it offers the lookup and
  // the plain download; once the plug-in answered it shows the best upload
  // (thumbnail, title, channel, length, score) with "Download this", a link
  // out and the other candidates to pick from. `lookup` is the window's
  // state for the plug-in (vp.js dmLookup); the card is
  // DISCOVERJOBS.lookupCard of it. Once a job exists the job row takes over.
  Vue.component('dm-lookup-row', {
    props: { plugin: Object, lookup: Object, query: String, busy: Boolean, error: String },
    data: function () { return { othersOpen: false }; },
    computed: {
      card: function () { return DISCOVERJOBS.lookupCard(this.lookup); },
      state: function () { return this.card.state; },
      meta: function () { return this.card.card ? [this.card.card.channel, this.card.card.length, this.plugin.title].filter(Boolean).join(' · ') : ''; },
    },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
      choose: function (url) { this.othersOpen = false; this.$emit('choose', url); },
      tag: function (item) { return this.tt(item.loose ? 'discover.lookup.loose' : 'discover.lookup.match', { pct: item.scorePct }); },
    },
    template: `
      <div class="dm-opt" :class="{ 'dm-opt-wrap': state === 'ready', 'dm-opt-muted': state === 'none' }">
        <div v-if="state === 'ready' && card.card.thumbnail" class="dm-thumb" :style="{ backgroundImage: 'url(' + card.card.thumbnail + ')' }"></div>
        <div v-else class="dm-opt-ic" :class="{ 'dm-opt-ic-ok': state === 'owned', 'dm-opt-ic-err': state === 'error' }"><dm-icon :name="state === 'owned' ? 'check' : (state === 'error' ? 'warn' : (state === 'loading' ? 'search' : 'download'))"></dm-icon></div>
        <div class="dm-opt-body">
          <template v-if="state === 'ready'">
            <div class="dm-opt-title" :title="card.card.title">{{ card.card.title }}<span class="dm-tag" :class="card.card.loose ? 'dm-tag-err' : 'dm-tag-ok'">{{ tag(card.card) }}</span></div>
            <div class="dm-opt-sub" :class="{ 'dm-opt-sub-err': !!error }" :title="error || meta">{{ error || meta }}</div>
          </template>
          <template v-else-if="state === 'loading'">
            <div class="dm-opt-title">{{ plugin.title }}<span class="dm-tag dm-tag-src">{{ tt('discover.lookup.searching') }}</span></div>
            <div class="dm-opt-sub">{{ tt('discover.lookup.searchingSub', { plugin: plugin.title, query: query }) }}</div>
            <div class="dm-progress dm-progress-indet" role="progressbar" :aria-label="plugin.title"><i></i></div>
          </template>
          <template v-else-if="state === 'owned'">
            <div class="dm-opt-title">{{ plugin.title }}<span class="dm-tag dm-tag-ok">{{ tt('discover.job.owned') }}</span></div>
            <div class="dm-opt-sub">{{ tt('discover.job.ownedSub') }}</div>
          </template>
          <template v-else-if="state === 'none'">
            <div class="dm-opt-title">{{ plugin.title }}</div>
            <div class="dm-opt-sub">{{ tt('discover.lookup.none', { plugin: plugin.title, query: query }) }}</div>
          </template>
          <template v-else-if="state === 'error'">
            <div class="dm-opt-title">{{ plugin.title }}<span class="dm-tag dm-tag-err">{{ tt('discover.job.failed') }}</span></div>
            <div class="dm-opt-sub dm-opt-sub-err" :title="card.error">{{ card.error || tt('discover.lookup.failed') }}</div>
          </template>
          <template v-else>
            <div class="dm-opt-title" :title="plugin.description">{{ plugin.title }}</div>
            <div class="dm-opt-sub" :class="{ 'dm-opt-sub-err': !!error }" :title="error || ''">{{ error || tt('discover.lookup.idleSub', { query: query }) }}</div>
          </template>
        </div>
        <div class="dm-opt-act">
          <template v-if="state === 'ready'">
            <a class="dm-btn dm-btn-ghost dm-btn-icon" :href="card.card.url" target="_blank" rel="noopener" :title="tt('discover.lookup.open', { plugin: plugin.title })" :aria-label="tt('discover.lookup.open', { plugin: plugin.title })"><dm-icon name="open" :size="14"></dm-icon></a>
            <button v-if="card.others.length" type="button" class="dm-btn dm-btn-ghost" :aria-expanded="othersOpen ? 'true' : 'false'" v-on:click="othersOpen = !othersOpen">{{ tt('discover.lookup.others', { count: card.others.length }) }}<dm-icon :name="othersOpen ? 'up' : 'down'" :size="14"></dm-icon></button>
            <button type="button" class="dm-btn dm-btn-primary" :class="{ 'is-busy': busy }" :aria-disabled="busy ? 'true' : null" v-on:click="$emit('download', card.card.url)"><dm-icon name="download" :size="14"></dm-icon>{{ tt('discover.lookup.downloadThis') }}</button>
          </template>
          <template v-else-if="state === 'owned'">
            <button v-if="card.owned && card.owned.filepath" type="button" class="dm-btn dm-btn-primary" v-on:click="$emit('play', card.owned.filepath)"><dm-icon name="play" :size="14"></dm-icon>{{ tt('discover.modal.play') }}</button>
            <button v-if="card.owned && card.owned.filepath" type="button" class="dm-btn" v-on:click="$emit('queue', card.owned.filepath)"><dm-icon name="plus" :size="14"></dm-icon>{{ tt('discover.modal.queue') }}</button>
          </template>
          <template v-else-if="state === 'none' || state === 'error'">
            <button type="button" class="dm-btn" v-on:click="$emit('lookup')"><dm-icon name="retry" :size="14"></dm-icon>{{ tt('discover.lookup.again') }}</button>
          </template>
          <template v-else-if="state !== 'loading'">
            <button type="button" class="dm-btn dm-btn-primary" v-on:click="$emit('lookup')"><dm-icon name="search" :size="14"></dm-icon>{{ tt('discover.lookup.find') }}</button>
            <button type="button" class="dm-btn" :class="{ 'is-busy': busy }" :aria-disabled="busy ? 'true' : null" v-on:click="$emit('download', null)"><dm-icon name="download" :size="14"></dm-icon>{{ tt('discover.modal.download') }}</button>
          </template>
        </div>
        <div v-if="state === 'ready' && othersOpen" class="dm-others">
          <div v-for="o in card.others" :key="o.url" class="dm-other" role="button" tabindex="0" v-on:click="choose(o.url)" v-on:keydown.enter.prevent="choose(o.url)" v-on:keydown.space.prevent="choose(o.url)">
            <div class="dm-thumb dm-thumb-sm" :style="o.thumbnail ? { backgroundImage: 'url(' + o.thumbnail + ')' } : null"></div>
            <div class="dm-other-t"><b :title="o.title">{{ o.title }}</b><small>{{ [o.channel, o.length].filter(Boolean).join(' · ') }} · {{ tag(o) }}</small></div>
          </div>
        </div>
      </div>`,
  });

  // A path as the window draws it — the bar's "Files go to", a copy's
  // "Into" and "In" lines, the editor's preview: the library in bold, its
  // folders after it with "›" between them (each separator travels with
  // the folder after it, so a long path breaks between folders first, then
  // inside one), and a song's file on a line of its own. Never cut short.
  // `path` is dmDestPath's answer (or a dmJobPath's `path`); `prefix` the
  // words before it, `suffix` any after; `variant` the look: 'bar' (the
  // idle path bar), 'state' (inside a copy's states), 'preview' (the
  // editor's: what the layout renders in the source colour, the file the
  // path's last crumb, as the phone draws it); `file` false leaves the
  // file out. The "›" is drawn, not read: a screen reader hears a "/"
  // between the folders instead. A folder with a slot in it (a variable
  // each song files by its own tag: "‹artist›") draws the slot quiet, as
  // the "one folder per album" note is, inside the folder's own text; the
  // path's one note under it (`slotNote`) says why.
  Vue.component('dm-dest-path', {
    props: { path: Object, prefix: String, suffix: String, variant: { type: String, default: 'state' }, file: { type: Boolean, default: true } },
    template: `
      <div class="dm-dest-path" :class="'dm-dest-path-' + variant">
        <div class="dm-dest-crumbs" :title="path.title"><span v-if="prefix" class="dm-dest-pre">{{ prefix }} </span><b>{{ path.library }}</b><span v-for="(c, i) in path.crumbs" :key="i" class="dm-dest-crumb" :class="'dm-dest-crumb-' + c.kind"><i aria-hidden="true">&rsaquo;</i><span class="dm-sr">/</span><template v-if="c.parts"><span v-for="(p, j) in c.parts" :key="j" :class="{ 'dm-dest-slot': p.slot }">{{ p.text }}</span></template><template v-else>{{ c.text }}</template></span><span v-if="file && path.file && variant === 'preview'" class="dm-dest-crumb dm-dest-crumb-file"><i aria-hidden="true">&rsaquo;</i><span class="dm-sr">/</span>{{ path.file }}</span><template v-if="suffix">{{ suffix }}</template></div>
        <div v-if="file && path.file && variant !== 'preview'" class="dm-dest-file">{{ path.file }}</div>
        <div v-if="path.slotNote" class="dm-dest-slots">{{ path.slotNote }}</div>
      </div>`,
  });

  // A folder copy's files under where it lands (SPEC-fed §6.5.4): at most
  // DISCOVERJOBS.FOLDER_FILE_LINES of them, in path order — a song in a
  // subfolder with its folder first — then how many more; never the whole
  // folder. `files` is a folder path's { lines, more } (scopeTarget).
  Vue.component('dm-land-files', {
    props: { files: Object },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
    },
    template: `
      <div class="dm-land-files">
        <div v-for="(line, i) in files.lines" :key="i" class="dm-land-file">{{ line }}</div>
        <div v-if="files.more > 0" class="dm-land-more">{{ tt('discover.keep.moreFiles', { count: files.more }) }}</div>
      </div>`,
  });

  // The collection destination — where "Keep a copy" copies and "Get it"
  // downloads land ("Where files land"). Idle it is the path bar: where a
  // copy of the chosen scope would land under the saved destination
  // (dmDestPath), a song's file, whose choice it is — saved for the
  // account or the library's default — and Change…. Change… turns it into
  // the editor in place, which takes the card's action row's place too
  // (one primary at a time) and saves nothing until Save. The editor is
  // the phone's destination sheet in the window's look: a header (the
  // title, whose choice is in force, what it is for, Cancel), where this
  // item would land, the library chips, the layouts as one radio group —
  // under it "Start from an existing folder…" (the library's folder list:
  // a folder chosen there starts Custom's layout), then Custom's field,
  // its variables and how a layout reads — then Use the library default
  // and Save. The folder list sits above Custom's field, so a folder
  // chosen from a preset brings the field in under the list, never over
  // the row just pressed. No base folder field: a Custom layout's own
  // folders do its work (dmPickerFill). `scope` = the scope the path is
  // drawn for; by default the Keep card's choice, else the song (Get it).
  // `download` = the path is a download's (Get it's bar): it comes from no
  // server, so {{PEER}} and {{SERVERFOLDER}} drop out of it, as youtube.js
  // renders it — on a connected server's row too — and the editor says
  // files, not copies: the one setting is Get it's too. A file line only
  // where the window copies the song (its file keeps its name). State and
  // behaviour stay on the playlist Vue (discover.dest,
  // discover.modal.picker and the dm* methods); this only puts them where
  // the rows are. The parent shows it only when a row could put a file
  // somewhere — never locked.
  Vue.component('dm-dest', {
    props: { scope: String, download: Boolean },
    // `pointer`: the Custom row was pressed with a pointer (chooseCustom,
    // pressCustom)
    data: function () { return { pointer: false }; },
    computed: {
      picker: function () { return this.$root.discover.modal.picker; },
      dest: function () { const v = this.$root.discover.dest.view; return (v && v.destination) || null; },
      shown: function () { return this.scope || this.$root.dmKeepScope() || 'song'; },
      from: function () { return this.download ? { peer: null, filepath: null } : null; },
      path: function () { return this.$root.dmDestPath(this.shown, null, this.from); },
      fileLine: function () { return this.shown === 'song' && this.$root.dmKeepChoices().length > 0; },
      preview: function () { return this.$root.dmPickerPreview(this.shown, this.from); },
      // the account's own place is in force ("yours"), else the library's default
      mine: function () { return !!this.dest && this.dest.source === 'user'; },
      libraries: function () { return this.$root.dmPickerChips(); },
      presets: function () { return this.$root.dmPickerPresets(); },
      problem: function () { return this.$root.dmPickerCustomProblem(); },
      // why the preview draws no path ({ text, warn }), else null
      unseen: function () { return this.$root.dmPickerUnseen(this.preview, this.shown); },
      folders: function () { return this.picker && this.picker.browse ? this.$root.dmBrowseCrumbs() : []; },
      naming: function () { const k = this.picker; return !!(k && k.browse && k.browse.naming); },
    },
    watch: {
      picker: function (k, was) { if (k && !was) { this.opened(); } },
      // "New folder…" turns into a name field: put the caret in it.
      naming: function (on) {
        if (!on) { return; }
        this.$nextTick(() => { const el = this.$refs.newFolder; if (el && el.focus) { el.focus(); } });
      },
    },
    // A state's own Change… (Skipped) shows the editor where the state was:
    // this mounts with it open.
    mounted: function () { if (this.picker) { this.opened(); } },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
      // The editor opens in view, the keyboard on its first field: the
      // chosen library's chip.
      opened: function () {
        this.$nextTick(() => {
          const el = this.$refs.form;
          if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
          const first = el && el.querySelector ? el.querySelector('.dm-dest-chip[aria-pressed="true"]') : null;
          if (first && first.focus) { first.focus(); }
        });
      },
      // Custom chosen with a pointer: its field takes the keyboard, as the
      // phone's does. Chosen with the arrow keys, the keyboard stays in the
      // radio group — the field comes after it in Tab order.
      chooseCustom: function () {
        const pointer = this.pointer;
        this.pointer = false;
        this.$root.dmPickerChooseCustom();
        if (!pointer) { return; }
        this.$nextTick(() => { const el = this.$refs.custom; if (el && el.focus) { el.focus(); } });
      },
      // Custom pressed again with a pointer while it is chosen: a chosen
      // radio fires no change, so its field takes the keyboard here, as the
      // phone's does. (The click comes before the change of a radio not yet
      // chosen: Custom is not chosen then, and chooseCustom does it.)
      pressCustom: function () {
        if (!this.pointer || !this.picker || !this.picker.custom) { return; }
        this.pointer = false;
        this.$nextTick(() => { const el = this.$refs.custom; if (el && el.focus) { el.focus(); } });
      },
    },
    template: `
      <div v-if="picker" class="dm-dest-ed" ref="form" role="group" aria-labelledby="dm-dest-h">
        <div class="dm-dest-ed-h">
          <div class="dm-dest-ed-titles">
            <div class="dm-dest-ed-line"><div id="dm-dest-h" class="dm-dest-ed-title">{{ tt(download ? 'discover.modal.dest.headingFiles' : 'discover.modal.dest.heading') }}</div><span class="dm-dest-tag"><dm-icon v-if="mine" name="person" :size="12"></dm-icon>{{ tt(mine ? 'discover.modal.dest.tagYours' : 'discover.modal.dest.tagDefault') }}</span></div>
            <div class="dm-dest-ed-sub">{{ tt(download ? 'discover.modal.dest.subFiles' : 'discover.modal.dest.sub') }}</div>
          </div>
          <button type="button" class="dm-btn dm-btn-quiet dm-btn-icon" :aria-label="tt('discover.modal.cancel')" :title="tt('discover.modal.cancel')" v-on:click="$root.dmClosePicker()"><dm-icon name="close" :size="16"></dm-icon></button>
        </div>
        <div class="dm-dest-preview">
          <dm-icon :name="unseen && unseen.warn ? 'warn' : 'folder'" :size="14" :class="{ 'dm-c-warn': unseen && unseen.warn }"></dm-icon>
          <div v-if="unseen" class="dm-dest-preview-note">{{ unseen.text }}</div>
          <div v-else class="dm-dest-preview-body">
            <div class="dm-dest-lands">{{ $root.dmPickerLandsAt(shown) }}</div>
            <dm-dest-path :path="preview" variant="preview"></dm-dest-path>
            <div v-if="preview.missingVars.length" class="dm-dest-slots">{{ $root.dmPickerMissing(preview, from) }}</div>
          </div>
        </div>
        <div class="dm-dest-field">
          <div id="dm-dest-lib-l" class="dm-dest-label">{{ tt('discover.modal.dest.library') }}</div>
          <div class="dm-dest-chips" role="group" aria-labelledby="dm-dest-lib-l">
            <button v-for="lib in libraries" :key="lib" type="button" class="dm-dest-chip" :class="{ 'dm-on': lib === picker.vpath }" :aria-pressed="lib === picker.vpath ? 'true' : 'false'" :aria-disabled="picker.saving ? 'true' : null" :title="lib" v-on:click="$root.dmPickerLibrary(lib)"><dm-icon v-if="lib === picker.vpath" name="check" :size="14"></dm-icon><span class="dm-dest-chip-name">{{ lib }}</span></button>
          </div>
        </div>
        <div class="dm-dest-field">
          <div id="dm-dest-layout-l" class="dm-dest-label">{{ tt('discover.modal.dest.layout') }}</div>
          <div class="dm-dest-opts" role="radiogroup" aria-labelledby="dm-dest-layout-l" v-on:keydown="pointer = false">
            <label v-for="p in presets" :key="p.layout" class="dm-dest-opt" :class="{ 'dm-on': !picker.custom && picker.layout === p.layout }">
              <span class="dm-dest-opt-text"><span class="dm-dest-opt-label">{{ tt(p.key) }}</span><span class="dm-dest-opt-sub dm-dest-mono" aria-hidden="true">{{ p.layout }}</span></span>
              <input type="radio" name="dm-dest-layout" class="dm-dest-radio" :checked="!picker.custom && picker.layout === p.layout" :disabled="picker.saving" v-on:change="$root.dmPickerChoose(p.layout)">
            </label>
            <label class="dm-dest-opt" :class="{ 'dm-on': picker.custom }" v-on:pointerdown="pointer = true">
              <span class="dm-dest-opt-text"><span class="dm-dest-opt-label">{{ tt('discover.modal.dest.preset.custom') }}</span><span id="dm-dest-custom-sub" class="dm-dest-opt-sub" aria-hidden="true">{{ tt('discover.modal.dest.customSub') }}</span></span>
              <input type="radio" name="dm-dest-layout" class="dm-dest-radio" :checked="picker.custom" :disabled="picker.saving" aria-describedby="dm-dest-custom-sub" v-on:click="pressCustom()" v-on:change="chooseCustom()">
            </label>
          </div>
          <div v-if="picker.error && !picker.custom" id="dm-dest-save-err" class="dm-dest-err" role="alert"><dm-icon name="warn" :size="12"></dm-icon><span>{{ picker.error }}</span></div>
          <div class="dm-dest-folders">
            <button type="button" class="dm-btn dm-btn-quiet" data-dm-browse :aria-expanded="picker.browse ? 'true' : 'false'" :aria-disabled="picker.saving && !picker.browse ? 'true' : null" v-on:click="$root.dmBrowseToggle()"><dm-icon name="folder" :size="14"></dm-icon>{{ tt(picker.browse ? 'discover.modal.dest.hideFolders' : 'discover.modal.dest.startFrom') }}</button>
            <div v-if="picker.browse" class="dm-dest-tree" role="group" :aria-label="tt('discover.modal.dest.foldersIn', { library: picker.vpath })">
              <div class="dm-dest-tree-h"><b>{{ folders[0] }}</b><span v-for="(c, i) in folders.slice(1)" :key="i" class="dm-dest-crumb"><i aria-hidden="true">&rsaquo;</i>{{ c }}</span><template v-if="!picker.browse.loading && !picker.browse.failed && picker.browse.dirs.length > 0"><i aria-hidden="true">&middot;</i><span>{{ tt('discover.modal.dest.folderCount', { count: picker.browse.dirs.length }) }}</span></template></div>
              <button v-if="folders.length > 1" type="button" class="dm-dest-node" :aria-disabled="picker.saving ? 'true' : null" v-on:click="$root.dmBrowseUp()"><dm-icon name="up" :size="14"></dm-icon>{{ tt('discover.modal.dest.up', { name: folders[folders.length - 2] }) }}</button>
              <div v-if="picker.browse.loading" class="dm-dest-tree-note">{{ tt('discover.modal.lookingUp') }}</div>
              <template v-else>
                <div v-if="!picker.browse.failed && picker.browse.dirs.length === 0" class="dm-dest-tree-note">{{ tt('discover.modal.dest.noFolders') }}</div>
                <button v-for="d in picker.browse.dirs" :key="d" type="button" class="dm-dest-node" :aria-pressed="$root.dmBrowseIsBase(d) ? 'true' : 'false'" :aria-disabled="picker.saving ? 'true' : null" v-on:click="$root.dmBrowseInto(d)"><dm-icon name="folder" :size="14"></dm-icon>{{ d }}</button>
              </template>
              <button v-if="!picker.browse.naming" type="button" class="dm-dest-node dm-dest-node-new" :aria-disabled="picker.saving ? 'true' : null" v-on:click="$root.dmBrowseNewFolder()"><dm-icon name="plus" :size="14"></dm-icon>{{ tt('discover.modal.dest.newFolder') }}</button>
              <div v-else class="dm-dest-naming">
                <dm-icon name="plus" :size="14"></dm-icon>
                <input class="dm-input browser-default" type="text" maxlength="200" ref="newFolder" v-model="picker.browse.newName" v-on:keydown.enter.prevent="$root.dmBrowseNewFolder()" :disabled="picker.saving" :placeholder="tt('discover.modal.dest.newFolderName')" :aria-label="tt('discover.modal.dest.newFolderName')">
                <button type="button" class="dm-btn" :aria-disabled="picker.saving ? 'true' : null" v-on:click="$root.dmBrowseNewFolder()">{{ tt('discover.modal.dest.newFolderAdd') }}</button>
              </div>
              <div v-if="picker.browse.braced" class="dm-dest-tree-note dm-dest-tree-warn" role="alert">{{ tt('discover.modal.dest.folderBraces', { folder: picker.browse.braced }) }}</div>
            </div>
            <div v-if="$root.dmBrowseMissing()" class="dm-dest-missing">{{ tt('discover.modal.dest.willCreate') }}</div>
          </div>
          <div v-if="picker.custom" class="dm-dest-custom">
            <input id="dm-dest-custom" ref="custom" class="dm-input dm-dest-mono browser-default" type="text" maxlength="500" spellcheck="false" autocomplete="off" v-model="picker.text" v-on:input="$root.dmPickerTyped()" :disabled="picker.saving" :placeholder="tt('discover.modal.dest.customHint', { example: $root.dmVarToken('ARTIST') + '/' + $root.dmVarToken('ALBUM') })" :aria-label="tt('discover.modal.dest.customField')" :class="{ 'is-warn': !!problem && !picker.error, 'is-err': !!picker.error }" :aria-invalid="problem || picker.error ? 'true' : null" :aria-describedby="picker.error ? 'dm-dest-save-err dm-dest-custom-h' : problem ? 'dm-dest-custom-w dm-dest-custom-h' : 'dm-dest-custom-h'">
            <div v-if="picker.error" id="dm-dest-save-err" class="dm-dest-err" role="alert"><dm-icon name="warn" :size="12"></dm-icon><span>{{ picker.error }}</span></div>
            <div v-else-if="problem" id="dm-dest-custom-w" class="dm-dest-warn"><dm-icon name="warn" :size="12"></dm-icon><span>{{ problem }}</span></div>
            <div class="dm-dest-vars">
              <button v-for="v in $root.dmPickerVars()" :key="v" type="button" class="dm-dest-var" :aria-label="$root.dmPickerVarLabel(v)" :aria-disabled="picker.saving || !$root.dmPickerVarFits(v) ? 'true' : null" v-on:click="$root.dmInsertVar(v, $refs.custom)">{{ $root.dmVarToken(v) }}</button>
            </div>
            <div id="dm-dest-custom-h" class="dm-dest-hint">{{ tt('discover.modal.dest.customHelp') }}</div>
          </div>
        </div>
        <div class="dm-dest-ed-foot">
          <button v-if="mine || !$root.dmPickerIsDefault()" type="button" class="dm-btn dm-btn-quiet" :aria-disabled="picker.saving ? 'true' : null" v-on:click="$root.dmPickerUseDefault()">{{ tt('discover.modal.dest.useDefault') }}</button>
          <button type="button" class="dm-btn dm-btn-primary" :class="{ 'is-busy': picker.saving }" :aria-disabled="$root.dmPickerCanSave() ? null : 'true'" :aria-describedby="picker.error ? 'dm-dest-save-err' : null" v-on:click="$root.dmPickerSubmit()"><dm-icon v-if="!picker.saving" name="check" :size="14"></dm-icon>{{ tt(picker.saving ? 'discover.modal.dest.saving' : 'discover.modal.dest.save') }}</button>
        </div>
      </div>
      <div v-else-if="dest && path" class="dm-dest">
        <div class="dm-dest-line">
          <dm-icon name="folder" :size="14"></dm-icon>
          <dm-dest-path :path="path" :prefix="tt('discover.modal.dest.goTo')" variant="bar" :file="fileLine"></dm-dest-path>
        </div>
        <dm-land-files v-if="path.files" :files="path.files"></dm-land-files>
        <div class="dm-dest-foot">
          <span class="dm-dest-source">{{ tt(dest.source === 'user' ? 'discover.modal.dest.savedFor' : 'discover.modal.dest.libraryDefault') }}</span>
          <span class="dm-dest-acts">
            <button type="button" class="dm-btn dm-btn-ghost" data-dm-change v-on:click="$root.dmOpenPicker(download)">{{ tt('discover.modal.dest.change') }}</button>
          </span>
        </div>
      </div>`,
  });

  // Keep a copy's card under its choices (SPEC §6.6–§6.7, §8.1): the
  // body — the path bar (idle, or a refused start: Change… there), the
  // editor in its place while it is open, else the outcome block (a 14 px
  // headline coloured by what happened, the % beside it, the sub and
  // muted lines, the bar, where the files go or went) — then a refused
  // start's line, then the action row, the primary last (none while the
  // editor is open: one primary at a time; a refused start's line goes
  // with it). A folder (SPEC-fed §6.5.4): the path bar only "By your
  // layout" — as on the peer and into a folder draw their own place under
  // the landings (index.html) — and a folder past the cap holds its line
  // alone. `view` is the playlist Vue's dmKeepView; a button only names
  // its action (dmKeepAct, data-dm-act). What changed is said by the
  // section's one live region, there before the card first changes
  // (index.html, dmKeepAnnounce) — nothing in here is a live region. The
  // bar is named by the headline.
  Vue.component('dm-keep-body', {
    props: { view: Object },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
      btnClass: function (a) {
        return { 'dm-btn-primary': a.kind === 'primary', 'dm-btn-ghost': a.kind === 'ghost', 'is-busy': a.busy };
      },
    },
    template: `
      <div class="dm-keep-body">
        <dm-dest v-if="view.bar || $root.dmDestEditing()" :scope="view.scope"></dm-dest>
        <div v-else-if="view.kind === 'cap'" class="dm-keep-cap"><dm-icon name="info" :size="16"></dm-icon><span>{{ view.line }}</span></div>
        <div v-else-if="view.kind === 'state'" class="dm-out">
          <div class="dm-out-tile" :class="'dm-out-tile-' + view.tile.tint" aria-hidden="true"><dm-icon :name="view.tile.icon" :size="16"></dm-icon></div>
          <div class="dm-out-text">
            <div class="dm-out-head">
              <div id="dm-out-h" class="dm-out-headline" :class="'dm-tone-' + view.tone">{{ view.headline }}</div>
              <span v-if="view.pct !== null" class="dm-out-pct" :class="{ 'dm-out-pct-other': !!view.other }">{{ view.pct }}%</span>
            </div>
            <div v-if="view.sub" class="dm-out-sub">{{ view.sub }}</div>
            <div v-if="view.muted" class="dm-out-muted">{{ view.muted }}</div>
            <div v-if="view.progress !== null" class="dm-progress" :class="{ 'dm-progress-indet': view.progress === 'indeterminate', 'dm-progress-other': !!view.other }"
                 role="progressbar" aria-labelledby="dm-out-h" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="view.progress === 'indeterminate' ? null : view.progress" :aria-valuetext="view.progressText || null"><i :style="view.progress === 'indeterminate' ? null : { width: view.progress + '%' }"></i></div>
            <dm-dest-path v-if="view.path" variant="state" :prefix="view.path.prefix" :path="view.path.path"></dm-dest-path>
            <dm-dest-path v-if="view.retryPath" variant="state" :prefix="view.retryPath.prefix" :suffix="view.retryPath.suffix" :path="view.retryPath.path" :file="false"></dm-dest-path>
          </div>
        </div>
        <div v-if="view.line && view.kind !== 'cap' && !$root.dmDestEditing()" class="dm-keep-line"><dm-icon name="info" :size="14"></dm-icon><span>{{ view.line }}</span></div>
        <div v-if="view.actions.length && !$root.dmDestEditing()" class="dm-keep-acts">
          <button v-for="a in view.actions" :key="a.id" type="button" class="dm-btn" :class="btnClass(a)" :aria-disabled="a.busy || a.disabled ? 'true' : null" :data-dm-act="a.id" :data-dm-change="a.id === 'change' ? '' : null" v-on:click="$root.dmKeepAct(a.id)"><dm-icon v-if="a.icon" :name="a.icon" :size="14"></dm-icon>{{ a.label }}</button>
        </div>
      </div>`,
  });

  const playlistVue = new Vue({
    el: '#playlist',
    data: {
      playlist: MSTREAMPLAYER.playlist,
      playlists: mstreamModule.playlists,
      showClear: showClearLink,
      altLayout: mstreamModule.altLayout,
      meta: MSTREAMPLAYER.playerStats.metadata,
      livePlaylist: mstreamModule.livePlaylist,
      discover: discoverState,
      // Owned here rather than in each playlist-item so that one shared
      // value has one subscriber instead of one per queue row — see the
      // note on the playlist-item component.
      positionCache: MSTREAMPLAYER.positionCache
    },
    watch: {
      // Refresh the Discover panel when the playing song changes.
      // resetCurrentMetadata rebuilds metadata field-by-field on the same
      // object, so watching the filepath field is reliable. Debounced so
      // skipping through the queue doesn't burst requests; immediate so a
      // restored session populates on load.
      'meta.filepath': {
        immediate: true,
        handler: function () {
          if (discoverDebounce) { clearTimeout(discoverDebounce); }
          discoverDebounce = setTimeout(() => { this.refreshDiscover(); }, 500);
        },
      },
    },
    computed: {
      albumArtPath: function () {
        if (!this.meta['album-art']) {
          return 'assets/img/default.png';
        }
        // The playing track may live on a peer while the app is pointed home;
        // songArtUrl branches on the song's own federation, not peerContext.
        return songArtUrl(this.meta['album-art'], MSTREAMPLAYER.getCurrentSong(), 'l');
      },
      // "A minor (8A)" / "8A" / "A minor" depending on what's
      // resolvable from the raw key tag. AUTODJ.toCamelot accepts
      // either a raw name or an already-Camelot code; null when
      // neither parse path succeeds (rare — the value still
      // renders as a fallback bare string).
      djKeyLabel: function () {
        const raw = this.meta['musical-key'];
        if (!raw) { return ''; }
        const code = (typeof AUTODJ !== 'undefined') ? AUTODJ.toCamelot(raw) : null;
        // Show "<raw> (<code>)" when the code differs from the raw
        // text — i.e. when the tag is a key NAME and we resolved it
        // to a Camelot code. If the raw IS the code already, just
        // show the code; if no resolution, show the raw verbatim.
        if (code && code !== String(raw).trim()) { return `${raw} (${code})`; }
        return code || String(raw);
      },
    },
    methods: {
      getSongInfo: function() {
        openMetadataModal(MSTREAMPLAYER.getCurrentSong().metadata, MSTREAMPLAYER.getCurrentSong().rawFilePath);
      },
      // The moveMeta "small" now-playing card lives in this (#playlist)
      // instance's template, so its lyrics chip binds to openLyrics here.
      // Without this method Vue's render for #playlist throws on the
      // chip's v-on:click, aborting the whole card render (stale metadata,
      // no chip). Mirror of the #mstream-player instance's openLyrics.
      openLyrics: function() {
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song) { openLyricsModal(song.rawFilePath, this.meta && this.meta.title); }
      },
      gsi2: function() {
        openMetadataModal(cps.metadata, cps.rawFilePath);
      },
      downloadSong2: function() {
        if (cps && cps.url) {
          const link = document.createElement('a');
          link.download = '';
          link.href = cps.url;
          link.click();
        }
        document.getElementById("pop-d").style.visibility = "hidden";
      },
      goToArtist: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-artist', this.meta.artist);
        // The now-playing track may be a peer's; carry its peer so getArtistz's
        // adoptPeer looks the artist up on the right server, not the local one.
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song && song.federation) { el.setAttribute('data-peer', song.federation.peerId); }
        getArtistz(el);
      },
      goToAlbum: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-album', this.meta.album);
        el.setAttribute('data-year', this.meta.year);
        // Carry the playing track's peer (if any) so the album resolves on that
        // server; without it adoptPeer flips the app home and finds nothing.
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song && song.federation) { el.setAttribute('data-peer', song.federation.peerId); }
        getAlbumsOnClick(el);
      },
      checkMove: function (event) {
        document.getElementById("pop").style.visibility = "hidden";
        MSTREAMPLAYER.resetPositionCache();
        saveLiveQueue();
      },
      clearRating: async function () {
        try {
          await MSTREAMAPI.rateSong(currentPopperSong.rawFilePath, null);
          MSTREAMPLAYER.editSongMetadata('rating', null, currentPopperSongIndex2);
        } catch(err) {
          iziToast.error({
            title: 'Failed to set rating',
            position: 'topCenter',
            timeout: 3500
          });
        }
      },
      // ── Discover panel ─────────────────────────────────────────────
      refreshDiscover: async function () {
        if (!this.discover.available || this.discover.disabled) { return; }
        const song = MSTREAMPLAYER.getCurrentSong();
        if (!song || !song.rawFilePath) {
          this.discover.tracks = [];
          this.discover.artists = [];
          this.discover.seedTitle = '';
          return;
        }
        // A federated track is playing: its path lives in the PEER's vpath
        // namespace, so local seed resolution can't work. Clear rather than
        // show the previous song's results as if they belonged here.
        if (song.federation) {
          this.discover.tracks = [];
          this.discover.artists = [];
          this.discover.p2p.tracks = [];
          this.discover.fed.tracks = [];
          this.discover.notAnalyzed = false;
          this.discover.seedTitle = (song.metadata && song.metadata.title) || '';
          return;
        }
        // Keep it lean: no discovery traffic while the panel is collapsed.
        // Remember there's something new to fetch for when it opens.
        if (this.discover.collapsed) {
          discoverDirty = true;
          return;
        }
        discoverDirty = false;
        const seedPath = song.rawFilePath.charAt(0) === '/' ? song.rawFilePath.substr(1) : song.rawFilePath;
        this.discover.seedPath = seedPath;
        const reqId = ++discoverReqId;
        this.discover.loading = true;

        const wantP2p = this.discover.p2p.available && !this.discover.p2p.disabled;
        const wantFed = this.discover.fed.available && !this.discover.fed.disabled;
        const [similar, artists, p2p, fed] = await Promise.all([
          MSTREAMAPI.discoverySimilar(seedPath, 5),
          this.meta.artist ? MSTREAMAPI.discoverySimilarArtists(this.meta.artist, 3) : Promise.resolve(null),
          wantP2p ? MSTREAMAPI.discoveryP2pSimilar(seedPath, 5, this.discover.p2p.newArtistsOnly) : Promise.resolve(null),
          wantFed ? MSTREAMAPI.discoveryFederationSimilar(seedPath, 5, this.discover.p2p.newArtistsOnly) : Promise.resolve(null),
        ]);
        if (reqId !== discoverReqId) { return; }   // a newer song superseded this refresh
        this.discover.loading = false;

        if (similar && similar.disabled) {
          // Server has the feature off — hide for the rest of the session.
          this.discover.disabled = true;
          this.discover.available = false;
          return;
        }
        if (similar) {
          this.discover.notAnalyzed = similar.notAnalyzed === true;
          this.discover.seedTitle = (similar.seed && similar.seed.metadata && similar.seed.metadata.title)
            || (this.meta.title || '');
          this.discover.tracks = similar.results || [];
          this.discover.artists = (artists && !artists.disabled && !artists.notAnalyzed && artists.results) || [];
        }
        // else: transient local failure — keep whatever is shown.

        if (wantP2p) {
          if (p2p && p2p.disabled) {
            // 403 — the operator turned the network off; stop asking.
            this.discover.p2p.disabled = true;
          } else if (p2p) {
            this.discover.p2p.tracks = p2p.results || [];
            this.discover.p2p.searchedPeers = (p2p.searched && p2p.searched.peers) || 0;
          } else {
            // null = transient failure OR this track has no embedding yet
            // (a 404 — the local section's notAnalyzed hint covers that
            // state for the same seed track). Show nothing rather than
            // stale rows from the previous song.
            this.discover.p2p.tracks = [];
          }
        }

        if (wantFed) {
          if (fed && fed.disabled) {
            // 403 — federation turned off; stop asking for the session.
            this.discover.fed.disabled = true;
          } else if (fed) {
            this.discover.fed.tracks = fed.results || [];
            this.discover.fed.searchedPeers = (fed.searched && fed.searched.peers) || 0;
            this.discover.fed.unreachable = (fed.searched && fed.searched.unreachable) || 0;
            this.discover.fed.mismatched = (fed.searched && fed.searched.mismatched) || 0;
          } else {
            // Same null semantics as the p2p leg above.
            this.discover.fed.tracks = [];
          }
        }
      },
      // ── "From your peers" rows ─────────────────────────────────────
      // Playable since phase 4: the row queues through the federation
      // stream proxy. Lite metadata comes straight off the fed result so
      // the queue + now-playing card render without any local lookup —
      // its cover included (DISCOVERYPAGE.fedQueueMeta).
      queueDiscoverFed: function (ft) {
        mstreamModule.addFederationSongWizard(ft.peer, ft.filepath, DISCOVERYPAGE.fedQueueMeta(ft), true);
      },
      // ── Recommendation modal ───────────────────────────────────────────
      // One window for a network or peer row.
      // Translations inside v-if blocks: the data-i18n scan only sees nodes
      // present at load, so dynamic text goes through t() directly.
      tt: function (key, params) {
        return (typeof t === 'function') ? t(key, params) : key;
      },
      // The match's "to …": the seed the opener named (in curly quotes), a
      // phrase it named, else the panel's own now-playing seed.
      dmMatchSeed: function () {
        const m = this.discover.modal;
        if (m.matchPlain) { return m.matchPlain; }
        return '\u201C' + (m.matchSeed || this.discover.seedTitle || '') + '\u201D';
      },
      // Album focus: the window reads as the row's album.
      dmAlbumFocus: function () {
        return this.discover.modal.focus === 'album';
      },
      // Artist focus (a connected server's artist page) and folder focus
      // (a folder of its file explorer).
      dmArtistFocus: function () {
        return this.discover.modal.focus === 'artist';
      },
      dmFolderFocus: function () {
        return this.discover.modal.focus === 'folder';
      },
      // A fact link the page behind the window already is: View album from
      // its album page, View artist from its artist page.
      dmHidden: function (link) {
        return (this.discover.modal.hide || []).indexOf(link) !== -1;
      },
      // Listen: there for a song, an album and a folder — an artist's page
      // is behind the window.
      dmListenShown: function () {
        return !this.dmArtistFocus();
      },
      // The header's first line: the song's title, or the album's, the
      // artist's or the folder's name.
      dmHeadTitle: function () {
        const tr = this.discover.modal.track || {};
        if (this.dmAlbumFocus()) { return tr.album || ''; }
        if (this.dmArtistFocus()) { return tr.artist || ''; }
        if (this.dmFolderFocus()) { return (this.dmFolder() || {}).name || ''; }
        return tr.title || '(untitled)';
      },
      // The header's second line: artist · album · year · length; for the
      // album, its credit · year · how many songs (once the peer said) —
      // the album's own credit when the row carries one ('Various Artists'
      // on a compilation, whose Album copies it whole), else the artist;
      // for an artist, how many albums the peer lists them on ("Artist · 4
      // albums on Stage Peer B"); for a folder, where it is on the peer
      // ("Folder · music › Boukmanflow › Borrowed Tapes"). From Peer
      // Recommendations: "Artist · Album" alone.
      dmSubtitle: function () {
        const m = this.discover.modal;
        const tr = m.track || {};
        if (this.dmPeerRecs()) { return [tr.artist, tr.album].filter(Boolean).join(' · '); }
        if (this.dmAlbumFocus()) {
          const a = m.album;
          return [DISCOVERYPAGE.albumCreditOf(tr), tr.year, a && a.count !== null ? this.tt('discover.modal.songCount', { count: a.count }) : ''].filter(Boolean).join(' · ');
        }
        if (this.dmArtistFocus()) {
          const named = m.artist && m.artist.named;
          if (named == null) { return this.tt('discover.modal.artist'); }
          return this.tt('discover.modal.artistSub', { albums: this.tt('discover.modal.albumCount', { count: named }), peer: (m.peer && m.peer.name) || (tr.peer && tr.peer.name) || '' });
        }
        if (this.dmFolderFocus()) {
          const f = this.dmFolder();
          return f ? this.tt('discover.modal.folderSub', { path: DISCOVERJOBS.normalizePeerPath(f.path).split('/').join(' › ') }) : '';
        }
        return [tr.artist, tr.album, tr.year, tr.duration ? this.dmDuration(tr.duration) : ''].filter(Boolean).join(' · ');
      },
      // A count in words, its number as the reader's locale writes it
      // ("1,240 songs"): the plural form by the number, the digits
      // grouped after.
      dmCount: function (key, count, params) {
        const n = Number(count) || 0;
        const text = this.tt(key, Object.assign({}, params || {}, { count: n }));
        return n >= 1000 ? text.replace(String(n), DISCOVERJOBS.fmtCount(n)) : text;
      },
      dmDuration: function (seconds) {
        const s = Math.round(Number(seconds) || 0);
        if (!s) { return ''; }
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      },
      dmPct: function (track) {
        return Math.round(((track && track.similarity) || 0) * 100);
      },
      // Header artwork: the peer's own art file for a peer row (its
      // metadata read's, else the row's own albumArt — drawn before that
      // read answers), else the first preview provider that answered
      // with artwork. From Peer Recommendations: only the art a preview
      // earned for the lead's tile key this visit (clip.art, plan §2
      // item 10) — drawn as an <img> without a referrer — else its tile.
      dmArt: function () {
        const m = this.discover.modal;
        if (!m.open) { return null; }
        if (this.dmPeerRecs()) { return (m.tile && m.tile.key && this.discover.clip.art[m.tile.key]) || null; }
        const peerArt = m.source === 'federation' && m.track && m.track.peer
          ? ((m.file && m.file.art) || DISCOVERYPAGE.fedQueueMeta(m.track)['album-art'] || null)
          : null;
        if (peerArt) {
          return MSTREAMAPI.peerArtUrl(m.track.peer.id, peerArt, 's');
        }
        for (const name of Object.keys(m.previews || {})) {
          const p = m.previews[name] && m.previews[name].preview;
          if (p && p.artwork) { return p.artwork; }
        }
        return null;
      },
      // Opened from the Peer Recommendations page.
      dmPeerRecs: function () {
        return this.discover.modal.from === 'peerRecs';
      },
      // The page's header without earned art: the server's tile, its
      // letter on its hue's colours (PEERRECS.tileColours). → { letter,
      // field, ink } or null.
      dmTile: function () {
        const m = this.discover.modal;
        if (!m.open || !this.dmPeerRecs() || !m.tile || this.dmArt()) { return null; }
        const c = PEERRECS.tileColours(m.tile.hue);
        return { letter: m.tile.letter, field: c.field, ink: c.ink };
      },
      // The header's inline style: a cover as its background, or a tile's
      // colours (the page's earned art is an <img>, never a background).
      dmArtStyle: function () {
        const art = this.dmArt();
        if (art && !this.dmPeerRecs()) { return { backgroundImage: 'url(' + art + ')' }; }
        const tile = this.dmTile();
        return tile ? { background: tile.field, color: tile.ink } : null;
      },
      // The header's one meta line, its parts joined by "·": a connected
      // server's status, the song's format (an album has many: none), and
      // how close the match is — "93% match to your recent listening".
      // A network row has no server of its own to ask: its ISRC, the match.
      // { kind: 'status', dot, text } | { kind: 'isrc' | 'text', text }. A
      // server not answering has its last seen as a part of its own, so the
      // template's hidden "·" goes between them. From Peer Recommendations:
      // the peer line alone — its label as the server stamped it, the dot
      // only while the strip's last answer has the peer online.
      dmMetaParts: function () {
        const m = this.discover.modal;
        const tr = m.track || {};
        if (this.dmPeerRecs()) {
          const p = m.peerLine;
          return p && p.label ? [{ kind: 'status', dot: p.online ? 'ok' : 'none', text: p.label }] : [];
        }
        const parts = [];
        if (m.source === 'federation') {
          const status = this.dmPeerStatus();
          if (status) { parts.push({ kind: 'status', dot: status.dot, text: status.text }); }
          if (status && status.seen) { parts.push({ kind: 'text', text: status.seen }); }
          if (!m.focus && m.file && m.file.format) { parts.push({ kind: 'text', text: m.file.format }); }
          // a folder's size, once counted: "3 songs · no subfolders"
          if (this.dmFolderFocus()) { this.dmFolderCountParts().forEach((text) => parts.push({ kind: 'text', text })); }
        } else if (tr.isrc) {
          parts.push({ kind: 'isrc', text: tr.isrc });
        }
        if (tr.similarity != null) {
          parts.push({ kind: 'text', text: this.tt('discover.modal.matchLine', { pct: this.dmPct(tr), seed: this.dmMatchSeed() }) });
        }
        return parts;
      },
      // The connected server's status, its dot and its words from the same
      // answer: "<peer> online" (ok) when one of this window's own reads
      // came back — a folder's count among them; "<peer> not answering"
      // (off) when none did, with `seen` "last seen 4 min ago" — the
      // admin's last health check, all the server knows — when the peers
      // listing names it. Before the reads answer: the name alone and a grey
      // dot (wait), so the line holds its height. → { dot, text, seen } or
      // null.
      dmPeerStatus: function () {
        const m = this.discover.modal;
        const p = m.peer;
        if (!p) {
          const name = m.source === 'federation' && m.track && m.track.peer ? m.track.peer.name : '';
          return name ? { dot: 'wait', text: name } : null;
        }
        const scanned = !!(m.folderScan && m.folderScan.state === 'done');
        if (p.answered === true || scanned) { return { dot: 'ok', text: `${p.name} ${this.tt('discover.modal.online')}` }; }
        // a folder still being counted: not "not answering" yet
        if (m.folderScan && m.folderScan.state === 'counting') { return { dot: 'wait', text: p.name }; }
        const words = `${p.name} ${this.tt('discover.modal.offline')}`;
        if (!p.listed) { return { dot: 'off', text: words }; }
        const seen = p.lastSeen ? this.dmAgo(p.lastSeen) : this.tt('discover.modal.never');
        return { dot: 'off', text: words, seen: `${this.tt('discover.modal.lastSeen')} ${seen}` };
      },
      dmAgo: function (stamp) {
        // SQLite's datetime('now') is UTC without a zone marker.
        const iso = String(stamp).replace(' ', 'T');
        const t0 = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
        if (!Number.isFinite(t0)) { return String(stamp); }
        const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
        if (s < 60) { return this.tt('discover.modal.justNow'); }
        const when = s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
        return this.tt('discover.modal.ago', { when });
      },
      discoverLinksPlugin: function () {
        return (this.discover.plugins.list || []).find((p) => (p.capabilities || []).indexOf('links') !== -1) || null;
      },
      // The preview plug-ins the server has on — one row each.
      discoverPreviewPlugins: function () {
        return (this.discover.plugins.list || []).filter((p) => (p.capabilities || []).indexOf('preview') !== -1);
      },
      discoverPreviewState: function (name) {
        return (this.discover.modal.previews && this.discover.modal.previews[name]) || { status: 'idle', preview: null };
      },
      // The row as the similar route returned it, plus provenance; the
      // server strips what it doesn't know. In folder focus, the folder's.
      dmRecommendation: function () {
        const m = this.discover.modal;
        if (this.dmFolderFocus()) { return this.dmFolderRecommendation(); }
        return { ...m.track, source: m.source, filepath: m.source === 'federation' ? m.track.filepath : null };
      },
      // A folder copy's recommendation (SPEC-fed §6.5.5): the folder's path
      // on the peer, library first, and its name — what the strip names the
      // job by. null without a folder.
      dmFolderRecommendation: function () {
        const m = this.discover.modal;
        const f = this.dmFolder();
        if (!f || !m.track) { return null; }
        return { source: 'federation', peer: m.track.peer, filepath: DISCOVERJOBS.normalizePeerPath(f.path), title: f.name };
      },
      // The folder Keep's Folder choice copies: the window's own in folder
      // focus, a file row's folder in its song's window. → { path, name }
      // (the peer's path, library first) or null.
      dmFolder: function () {
        const m = this.discover.modal;
        const tr = m.track || {};
        if (m.focus !== 'folder') { return m.folder || null; }
        const path = typeof tr.filepath === 'string' ? tr.filepath : '';
        return path ? { path, name: tr.title || DISCOVERJOBS.normalizePeerPath(path).split('/').pop() || '' } : null;
      },
      dmLive: function (gen) {
        return this.discover.modal.open && this.discover.modal.gen === gen;
      },
      // Open the window for one row (VUEPLAYERCORE.openDiscoverModal is the
      // way in from m.js). A network row with neither plug-ins nor an
      // admin's invite row keeps the old behaviour: copy the title.
      //   track  the row: a taste row (Discover, the now-playing panel), a
      //          job's recommendation (the strip), or what a connected
      //          server's page names (SPEC-fed §6.1) — always its `peer`
      //          ({ id, name }: the row's own server)
      //   opts:
      //   { seedTitle } the seed the row was matched against, or
      //   { seedPlain } a phrase for the seeds' centroid (the match line;
      //     a browsed item has no similarity, so none)
      //   { focus } what the window reads as — 'album' (needs track.album:
      //     an album card's ⋯, an album page's header), 'artist' (needs
      //     track.artist: an artist page's header — no Listen, no Find
      //     elsewhere, Keep offers Artist alone, "only the albums you don't
      //     have" ticked), 'folder' (needs track.filepath, the folder's path
      //     on the peer, library first, and track.title its name: the file
      //     explorer's folder header or a folder row's ⋯ — Listen plays the
      //     folder, Keep offers Folder alone with where it lands); none =
      //     the song (needs track.filepath)
      //   { scope } the Keep card's choice to start on (song · album ·
      //     artist · artist-missing — a reopened job's own; 'folder' comes
      //     with focus 'folder')
      //   { from: 'browse' } opened from a connected server's own pages:
      //     a song's Album choice needs a credit the window knows
      //     (track.albumArtist: the album page's, the song's own
      //     'album-artist', else found in the peer's album listing — never
      //     one track's artist), its tags are read when the row has none
      //     (an explorer file row: track.title its file name), and Artist
      //     says what an artist copy leaves out. An album's track there: {
      //     album, albumArtist, year, albumArt, compilation, artist } —
      //     artist the credit, null for a compilation (left out: the credit
      //     unless `compilation`)
      //   { hide } the fact links the page behind it already is:
      //     ['viewAlbum'] from an album page, ['viewArtist'] from an artist
      //     page
      //   { folder: { path, name } } a song's folder, from an explorer file
      //     row (with from 'browse'): Keep's Folder choice, after Artist.
      //     Left out for a song at its library's root
      //   { creditsDisagree: true } a song of an album page whose songs
      //     name different album artists (with from 'browse'): no Album
      //   { opener } the control it was opened from, where the keyboard
      //     goes back on close (else whatever had focus); a browse or queue
      //     control's data-keep-key finds it again after a redraw
      //     (dmFocusBack)
      //   { from: 'peerRecs' } a network lead of the Peer Recommendations
      //     page (plan §2 item 15) — it opens with the plug-ins off too
      //     (Copy has its own row); with { peer } its peer line
      //     (PEERRECS.peerLine: { label, online }) and { tile } its tile
      //     (else the lead's own). No invite row; nothing plays until its
      //     Preview is pressed, and a clip the page plays goes on.
      openDiscoverModal: async function (track, source, opts) {
        const o = opts || {};
        const page = source === 'p2p' && o.from === 'peerRecs';
        if (source === 'p2p' && !page && !this.discover.plugins.available && !this.discover.admin) { return this.copyDiscoverP2p(track); }
        this.stopDiscoverPreview();
        const gen = ++discoverModalGen;
        const peerRow = source === 'federation';
        const t = track || {};
        const needs = { album: !!t.album, artist: !!t.artist, folder: typeof t.filepath === 'string' && t.filepath !== '' };
        const focus = peerRow && needs[o.focus] === true ? o.focus : null;
        const scope = focus === 'album' || focus === 'folder' ? focus
          : focus === 'artist' ? (o.scope === 'artist' ? 'artist' : 'artist-missing')
            : (['album', 'artist', 'artist-missing'].indexOf(o.scope) !== -1 ? o.scope : 'song');
        const browse = peerRow && o.from === 'browse';
        // a browsed album names its credit: the Artist choice is that credit,
        // unless the album is a compilation ("Various Artists" is nobody's
        // artist copy)
        const shown = browse && focus === 'album' && !('artist' in t) ? Object.assign({}, t, { artist: t.compilation === true ? null : (t.albumArtist || null) }) : track;
        // a file row's folder below its library (the library is no folder)
        const dir = browse && !focus && o.folder && typeof o.folder.path === 'string' ? DISCOVERJOBS.normalizePeerPath(o.folder.path) : '';
        const folder = dir.indexOf('/') !== -1 ? { path: o.folder.path, name: (typeof o.folder.name === 'string' && o.folder.name) || dir.split('/').pop() } : null;
        // a file row's song has no tags yet: Find elsewhere asks once they
        // are read (dmLoadPeerFacts)
        const linksAfterTags = browse && !focus && !t.artist;
        // a window that replaces an open one goes back where that came from
        if (!this.discover.modal.open || !discoverModalOpener) { discoverModalOpener = dmOpenerOf(o.opener || document.activeElement); }
        this.discover.modal = blankDiscoverModal({
          open: true, gen, source, track: shown, focus, from: browse ? 'browse' : (page ? 'peerRecs' : null), folder, creditsDisagree: browse && !focus && o.creditsDisagree === true,
          tile: page ? dmTileOf(o.tile) || dmTileOf(t.tile) : null,
          peerLine: page ? dmPeerLineOf(o.peer, t) : null,
          hide: Array.isArray(o.hide) ? o.hide.filter((h) => h === 'viewAlbum' || h === 'viewArtist') : [],
          matchSeed: typeof o.seedTitle === 'string' && o.seedTitle ? o.seedTitle : null,
          matchPlain: typeof o.seedPlain === 'string' && o.seedPlain ? o.seedPlain : null,
          loading: linksAfterTags && this.discover.plugins.available,
          // artist-missing is the Artist choice with "only the albums you
          // don't have" ticked; a plain artist job leaves it unticked
          keep: { scope: scope === 'artist-missing' ? 'artist' : scope, onlyMissing: scope !== 'artist', landing: 'mirror', into: null, tree: null },
        });
        document.addEventListener('keydown', onDiscoverModalKey);
        this.$nextTick(() => { const el = this.$refs.dmodalClose; if (el && el.focus) { el.focus(); } });
        const jobs = [];
        // an artist's and a folder's windows have no Find elsewhere
        const links = focus !== 'artist' && focus !== 'folder' && !linksAfterTags;
        if (this.discover.plugins.available) { if (links) { jobs.push(this.dmLoadLinks(gen)); } jobs.push(this.dmLoadJobs(gen)); }
        if (source === 'federation') { jobs.push(this.dmLoadPeerFacts(gen)); }
        if (focus === 'folder') { jobs.push(this.dmLoadFolderScan(gen)); }
        if (source === 'p2p' && this.discover.admin && !page) { jobs.push(this.dmLoadFederate(gen)); }
        await Promise.all(jobs);
      },
      closeDiscoverModal: function () {
        this.stopDiscoverPreview();
        if (discoverPeerJobsTimer) { clearTimeout(discoverPeerJobsTimer); discoverPeerJobsTimer = null; }
        document.removeEventListener('keydown', onDiscoverModalKey);
        discoverModalGen++;
        this.discover.modal = blankDiscoverModal({ gen: discoverModalGen });
        this.scheduleDiscoverJobsPoll();   // back to the strip's slower beat
        // the keyboard back on the control that opened the window, once
        // the window is gone from the page
        const opener = discoverModalOpener;
        discoverModalOpener = null;
        if (opener) { this.$nextTick(() => { dmFocusBack(opener, document); }); }
      },
      // After a control the keyboard was on went away (the folder tree or
      // the editor closed, a section redrew): if focus fell out of the
      // window, Close takes it — never <body>. A move the change made
      // itself (in its own $nextTick, queued first) stands.
      dmHoldFocus: function () {
        this.$nextTick(() => {
          const root = this.$refs.dmodal;
          const at = document.activeElement;
          if (!root || (at && at !== document.body && root.contains(at))) { return; }
          const close = this.$refs.dmodalClose;
          if (close && close.focus) { close.focus(); }
        });
      },
      // What Find elsewhere asks the links plug-in about: the row — or, in
      // album focus, the album itself: its credit and its name, no title
      // (the plug-in answers with the release's searches, "Boukmanflow
      // Borrowed Tapes"; a compilation's under "Various Artists"). Nothing
      // that names one song rides along: no title, file, ISRC or recording.
      dmLinksRecommendation: function () {
        const m = this.discover.modal;
        if (!this.dmAlbumFocus()) { return this.dmRecommendation(); }
        const tr = m.track || {};
        const rec = { source: m.source, peer: tr.peer || null, album: tr.album, artist: DISCOVERYPAGE.albumCreditOf(tr) };
        if (tr.albumArtist) { rec.albumArtist = tr.albumArtist; }
        if (tr.releaseGroupMbid) { rec.releaseGroupMbid = tr.releaseGroupMbid; }
        return rec;
      },
      dmLoadLinks: async function (gen) {
        this.discover.modal.loading = true;
        try {
          await this.ensureDiscoverPlugins();
          if (!this.dmLive(gen)) { return; }
          const linksPlugin = this.discoverLinksPlugin();
          let links = [];
          if (linksPlugin) {
            const res = await MSTREAMAPI.discoveryPluginResolve(linksPlugin.name, this.dmLinksRecommendation());
            if (!res || res.disabled) { throw new Error('resolve failed'); }
            links = (res.result && res.result.links) || [];
          }
          if (!this.dmLive(gen)) { return; }
          // a server whose plug-in only searches songs heard the credit
          // alone: nothing it found is the album's
          if (this.dmAlbumFocus() && !dmLinksNameAlbum(links, this.discover.modal.track.album)) { links = []; }
          this.discover.modal.links = links;
          this.discover.modal.loading = false;
        } catch (_) {
          if (!this.dmLive(gen)) { return; }
          this.discover.modal.loading = false;
          this.discover.modal.error = true;
        }
        // album focus: Find elsewhere goes when the answer names no album —
        // with Copy title, which the keyboard may have been on
        this.dmHoldFocus();
      },
      // Find elsewhere closes every window. In album focus it needs the
      // links plug-in's answer for the album itself: while it is asked, when
      // it failed (Copy title still works), or with links that name it —
      // absent where the server has no links plug-in, or one that only
      // searches songs (dmLoadLinks). An artist's and a folder's windows
      // have none: the plug-in has no phrase for either. From Peer
      // Recommendations it is the links alone, once they are there (Copy
      // is a row of its own; no note while they are asked, or failed).
      dmFindVisible: function () {
        const m = this.discover.modal;
        if (this.dmPeerRecs()) { return !m.loading && !m.error && m.links.length > 0; }
        if (this.dmArtistFocus() || this.dmFolderFocus()) { return false; }
        return !this.dmAlbumFocus() || m.loading || m.error || m.links.length > 0;
      },
      // The links of one tier: 'canonical' (the exact page: recording,
      // release group, ISRC — they lead) or 'search' (every other).
      dmLinks: function (tier) {
        return (this.discover.modal.links || []).filter((l) => (l.kind === 'canonical') === (tier === 'canonical'));
      },
      // A search chip names the catalogue alone — "MusicBrainz" after the
      // row's "Search" — and keeps the plug-in's full label as its name.
      dmChipLabel: function (link) {
        const label = String((link && link.label) || '');
        return /^search\s+/i.test(label) ? label.replace(/^search\s+/i, '') : label;
      },
      // Copy title: "Artist - Title" — or, in album focus, "Credit - Album".
      // Peer Recommendations' Copy says "Copied" (plan §5.7).
      dmCopyTitle: function () {
        const tr = this.discover.modal.track || {};
        if (this.dmAlbumFocus()) { return this.copyDiscoverP2p({ artist: DISCOVERYPAGE.albumCreditOf(tr) || '', title: tr.album || '' }); }
        return this.copyDiscoverP2p(tr, this.dmPeerRecs() ? 'peerRecs.copied' : undefined);
      },
      // A peer row's window: the peer's status from the peers
      // listing, the file's own facts (format, size, art) from its metadata
      // route, album and artist facts through the read proxy, and what of
      // that artist this library already holds. Every call is optional —
      // a missing answer leaves its line blank. The album's songs are
      // listed as the album copy lists them (DISCOVERYPAGE.peerAlbumQuery:
      // by the album's own credit when the row carries one — a
      // compilation whole — else by the track artist), so its count is
      // what Album copies, and each song's own artist, year and genres in
      // it are what the album's path draws by (dmScopeTags: one folder only
      // where every song agrees); the artist's facts stay the track
      // artist's. An artist's window reads no file and no album; a folder's
      // only the peers listing (its count is dmLoadFolderScan's). A song
      // opened from a connected server's pages reads in turn
      // (dmLoadBrowsedFacts).
      dmLoadPeerFacts: async function (gen) {
        const m = this.discover.modal;
        const track = m.track;
        const peerId = track.peer && track.peer.id;
        if (!peerId) { return; }
        if (m.from === 'browse' && !m.focus) { return this.dmLoadBrowsedFacts(gen); }
        const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
        const [peers, meta, albumSongs, peerAlbums, localAlbums] = await Promise.all([
          settle(MSTREAMAPI.federationPeers()),
          track.filepath && m.focus !== 'folder' ? settle(MSTREAMAPI.peer.metadata(peerId, track.filepath)) : Promise.resolve(null),
          track.album ? settle(MSTREAMAPI.peer.albumSongs(peerId, this.dmAlbumQuery())) : Promise.resolve(null),
          track.artist ? settle(MSTREAMAPI.peer.artistAlbums(peerId, { artist: track.artist })) : Promise.resolve(null),
          track.artist ? settle(MSTREAMAPI.artistAlbums({ artist: track.artist })) : Promise.resolve(null),
        ]);
        if (!this.dmLive(gen)) { return; }
        this.dmTakePeerFacts({ peers, meta, albumSongs, peerAlbums, localAlbums });
      },
      // A song from a connected server's pages (SPEC-fed §6.1, §6.3): the
      // row may name no tags (an explorer file row: its file name) and no
      // album credit (a genre, Recently Added or search row). So in turn:
      // the file's metadata — merged into the song (dmMergeFileTags: the
      // header, Album and Artist appear once known; Find elsewhere asks
      // then) — the artist's album listings, the album's credit found in
      // the peer's (dmCreditFrom), then the album as that credit lists it.
      // A row that named its artist starts the artist's listings with the
      // file's read. Once the song reads otherwise than it opened, what
      // this account did with it is looked up again: the keys are its tags'.
      dmLoadBrowsedFacts: async function (gen) {
        const m = this.discover.modal;
        const opened = m.track;
        const peerId = opened.peer.id;
        const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
        const listings = (artist) => Promise.all([
          settle(MSTREAMAPI.peer.artistAlbums(peerId, { artist })),
          settle(MSTREAMAPI.artistAlbums({ artist })),
        ]);
        const early = opened.artist ? listings(opened.artist) : null;
        const [peers, meta] = await Promise.all([
          settle(MSTREAMAPI.federationPeers()),
          opened.filepath ? settle(MSTREAMAPI.peer.metadata(peerId, opened.filepath)) : Promise.resolve(null),
        ]);
        if (!this.dmLive(gen)) { return; }
        this.dmTakePeerFacts({ peers, meta });
        this.dmMergeFileTags();
        const links = !opened.artist && this.discover.plugins.available ? this.dmLoadLinks(gen) : null;
        const tagged = m.track;
        const [peerAlbums, localAlbums] = early ? await early : (tagged.artist ? await listings(tagged.artist) : [null, null]);
        if (!this.dmLive(gen)) { return; }
        this.dmCreditFrom(peerAlbums && Array.isArray(peerAlbums.albums) ? peerAlbums.albums : null);
        const albumSongs = m.track.album ? await settle(MSTREAMAPI.peer.albumSongs(peerId, this.dmAlbumQuery())) : null;
        if (!this.dmLive(gen)) { return; }
        this.dmTakePeerFacts({ peers, meta, albumSongs, peerAlbums, localAlbums });
        const jobs = m.track !== opened && this.discover.plugins.available ? this.dmLoadJobs(gen) : null;
        await Promise.all([links, jobs]);
      },
      // What the reads said, into the window: the peer's status (`peers`,
      // and whether a read of its own answered), the file's facts (`meta`),
      // the album's (`albumSongs`) and the artist's (`peerAlbums`, this
      // library's `localAlbums`); a read not made is null.
      dmTakePeerFacts: function ({ peers, meta, albumSongs = null, peerAlbums = null, localAlbums = null }) {
        const track = this.discover.modal.track;
        const peerId = track.peer.id;
        const peer = peers && Array.isArray(peers.peers) ? peers.peers.find((p) => p.id === peerId) : null;
        // The listing's last_seen is the admin's last health check; the three
        // proxied reads above are this very minute. One that answered means
        // the peer is up now, whatever the listing remembers.
        const answered = [meta, albumSongs, peerAlbums].some((v) => v !== null && !(v && v.error));
        // `listed`: the peers listing named it, so its last seen is known
        this.discover.modal.peer = {
          name: (peer && peer.name) || track.peer.name || 'peer',
          lastSeen: (peer && peer.lastSeen) || null,
          listed: !!peer,
          answered,
        };
        const md = meta && typeof meta === 'object' ? (meta.metadata || meta) : null;
        this.discover.modal.file = md && typeof md === 'object' && !md.error
          ? { format: md.format || null, art: md['album-art'] || null, metadata: md }
          : null;
        const localList = localAlbums && Array.isArray(localAlbums.albums) ? localAlbums.albums : null;
        const songs = Array.isArray(albumSongs) ? albumSongs : null;
        this.discover.modal.album = track.album ? {
          songs,
          count: songs ? songs.length : null,
          seconds: songs ? songs.reduce((sum, s) => sum + ((s.metadata && Number(s.metadata.duration)) || 0), 0) : null,
          owned: (localList || []).some((a) => dmNameKey(a.name) === dmNameKey(track.album)),
        } : null;
        const remote = peerAlbums && Array.isArray(peerAlbums.albums) ? peerAlbums.albums : null;
        // the listing names the albums they only appear on too (V17): the
        // counts are of the albums an artist copy takes
        const mine = this.dmArtistOwnership(track.artist, remote, localList);
        this.discover.modal.artist = track.artist ? {
          // the albums that are the artist's own and their songs — what
          // every album copies, and what Listen and the counts say (never
          // an album they only appear on) — the peer's albums the library
          // has (by name), the artist's own albums there it lacks, and how
          // many albums of the artist's the library holds at all — null
          // while a listing did not answer
          theirs: mine.theirs,
          theirSongs: mine.theirSongs,
          owned: mine.owned,
          missing: mine.missing,
          missingOne: mine.missingOne,
          local: localList ? localList.length : null,
          // every album the peer lists them on, theirs or not (the artist
          // window's "4 albums on Stage Peer B"), and the listing itself
          // (what an artist copy leaves out: dmKeepLeftOut)
          named: remote ? remote.filter((al) => al && typeof al.name === 'string' && al.name.trim()).length : null,
          listing: remote,
        } : null;
      },
      // A browsed song's file read answered: its tags into the song where
      // the row named none — the title the tags' over a file row's file
      // name — so the header, Album and Artist read as the song. Its
      // album's credit is dmCreditFrom's, once the peer's album list can
      // bear it out. The song is a new object: what read the old one sees
      // it changed.
      dmMergeFileTags: function () {
        const m = this.discover.modal;
        const md = m.file && m.file.metadata;
        if (!md) { return; }
        const t = m.track;
        const tagged = Object.assign({}, t, {
          title: md.title || t.title,
          artist: t.artist || md.artist || undefined,
          album: t.album || md.album || undefined,
          year: t.year || md.year || undefined,
          duration: t.duration || md.duration || undefined,
          albumArt: t.albumArt || md['album-art'] || undefined,
        });
        if (['title', 'artist', 'album', 'year', 'duration', 'albumArt'].some((k) => (tagged[k] || null) !== (t[k] || null))) { m.track = tagged; }
      },
      // The album's credit, when the song's window knows none (the page
      // behind it named none): the song's own 'album-artist' (its file
      // read, a server since S2), as the peer's album listing for the
      // song's artist bears it out (SPEC-fed §4.2 step 3) — the one album
      // of the song's album's name (as names compare) whose years hold the
      // song's year. One with a credit of its own gives it; one whose songs
      // name different album artists leaves the credit out, whatever the
      // song names (each half of a split album names its own artist: an
      // album copy by it would take that half). None or several matching,
      // or no listing, the song's own stands; without one the credit stays
      // unknown — and Album out (never one track's artist: a compilation
      // would copy a third of itself). An album page that said its songs
      // disagree gives none (creditsDisagree).
      dmCreditFrom: function (remote) {
        const m = this.discover.modal;
        const t = m.track;
        if (!t.album || m.creditsDisagree || (typeof t.albumArtist === 'string' && t.albumArtist.trim())) { return; }
        const md = m.file && m.file.metadata;
        let credit = md && typeof md['album-artist'] === 'string' && md['album-artist'].trim() ? md['album-artist'] : null;
        if (Array.isArray(remote)) {
          const year = Number(t.year) || null;
          const holds = (al) => {
            const lo = Number(al.year_min || al.year) || null;
            const hi = Number(al.year_max || al.year) || null;
            return !year || ((!lo || year >= lo) && (!hi || year <= hi));
          };
          const hits = remote.filter((al) => al && typeof al.name === 'string' && dmNameKey(al.name) === dmNameKey(t.album) && holds(al));
          if (hits.length === 1) { credit = typeof hits[0].album_artist === 'string' && hits[0].album_artist.trim() ? hits[0].album_artist : null; }
        }
        if (credit) { m.track = Object.assign({}, t, { albumArtist: credit }); }
      },
      // "What you're missing" by NAME, as the copy itself reckons it
      // (federation-copy's planArtistAlbums over owned.js ownedAlbumKeys),
      // not by comparing counts — a library with three of an artist's
      // albums still lacks the peer's fourth. `remote` is the peer's
      // artists-albums listing for the artist, `local` this library's.
      //   theirs   the peer's albums that are the artist's own (album
      //            artist, or a credit outside a compilation — an album they
      //            only appear on is never copied): what "every album"
      //            copies; theirSongs their songs. From the peer's listing
      //            alone — known when this library's did not answer
      //   owned    the peer's albums whose name the library has
      //   missing  the artist's own albums whose name the library lacks:
      //            what "Only the albums you don't have" copies
      //   missingOne  that album when it is the one ({ name, year }: the
      //            destination's path names it), else null
      // All null when the peer's listing is unknown; all but theirs and
      // theirSongs when this library's is.
      dmArtistOwnership: function (artist, remote, local) {
        if (!Array.isArray(remote)) { return { theirs: null, theirSongs: null, owned: null, missing: null, missingOne: null }; }
        const who = dmNameKey(artist);
        const named = remote.filter((al) => al && typeof al.name === 'string' && al.name.trim());
        const isTheirs = (al) => dmNameKey(al.album_artist) === who
          || (al.compilation !== true && Array.isArray(al.artists) && al.artists.some((n) => dmNameKey(n) === who));
        const own = named.filter(isTheirs);
        const theirs = { theirs: own.length, theirSongs: own.reduce((sum, al) => sum + (Number(al.track_count) || 0), 0) };
        if (!Array.isArray(local)) { return Object.assign(theirs, { owned: null, missing: null, missingOne: null }); }
        const here = new Set(local.map((al) => dmNameKey(al && al.name)).filter(Boolean));
        const lacking = own.filter((al) => !here.has(dmNameKey(al.name)));
        return Object.assign(theirs, {
          owned: named.filter((al) => here.has(dmNameKey(al.name))).length,
          missing: lacking.length,
          missingOne: lacking.length === 1 ? { name: lacking[0].name, year: Number(lacking[0].year || lacking[0].year_min) || null } : null,
        });
      },
      // ── Listen's actions ───────────────────────────────────────────────
      // The song the window queues: the row's own lite metadata — its
      // cover (albumArt) included, as dmArt draws it — under the peer
      // metadata read's once that answers (its own cover first). Without the row's cover a Play
      // now pressed before the read answered (or after it failed) queued
      // the song with the default cover while the header showed the real one.
      dmSongMeta: function () {
        const m = this.discover.modal;
        const t = m.track;
        const base = { title: t.title || '', artist: t.artist || '', album: t.album || '', year: t.year || null, duration: t.duration || null };
        const out = (m.file && m.file.metadata) ? { ...base, ...m.file.metadata } : base;
        const rowArt = m.source === 'federation' ? DISCOVERYPAGE.fedQueueMeta(t)['album-art'] : null;
        if (rowArt && !out['album-art']) { out['album-art'] = rowArt; }
        return out;
      },
      dmPlayNow: function () {
        const m = this.discover.modal;
        mstreamModule.addFederationSongWizard(m.track.peer, m.track.filepath, this.dmSongMeta(), false, MSTREAMPLAYER.positionCache.val + 1, true);
        this.closeDiscoverModal();
      },
      dmQueueNext: function () {
        const m = this.discover.modal;
        mstreamModule.addFederationSongWizard(m.track.peer, m.track.filepath, this.dmSongMeta(), true, MSTREAMPLAYER.positionCache.val + 1, false);
        iziToast.success({ title: this.tt('discover.modal.queuedNext'), position: 'topCenter', timeout: 1800 });
      },
      dmAddToQueue: function () {
        const m = this.discover.modal;
        mstreamModule.addFederationSongWizard(m.track.peer, m.track.filepath, this.dmSongMeta(), true);
        iziToast.success({ title: this.tt('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
      },
      // The peer's album-songs body for the row's album (dmLoadPeerFacts,
      // Play / Add album): DISCOVERYPAGE.peerAlbumQuery, with the row's year.
      dmAlbumQuery: function () {
        const tr = this.discover.modal.track || {};
        return Object.assign(DISCOVERYPAGE.peerAlbumQuery(tr), { year: tr.year || null });
      },
      // View album / View artist open the peer's album or artist in the
      // browser panel, the way goToAlbum / goToArtist do for the playing
      // track: the element carries the peer so the panel resolves on that
      // server (adoptPeer). The album as dmAlbumQuery lists it: by its own
      // credit (data-album-artist) when the row carries one.
      dmViewAlbum: function () {
        const m = this.discover.modal;
        const q = this.dmAlbumQuery();
        const el = document.createElement('DIV');
        el.setAttribute('data-album', m.track.album);
        if (q.artist) { el.setAttribute('data-artist', q.artist); }
        if (q.album_artist) { el.setAttribute('data-album-artist', q.album_artist); }
        if (m.track.year) { el.setAttribute('data-year', String(m.track.year)); }
        // a compilation card's: its page keeps no Artist in its own window
        if (m.track.compilation === true) { el.setAttribute('data-compilation', 'true'); }
        el.setAttribute('data-peer', m.track.peer.id);
        this.closeDiscoverModal();
        getAlbumsOnClick(el);
      },
      dmViewArtist: function () {
        const m = this.discover.modal;
        const el = document.createElement('DIV');
        el.setAttribute('data-artist', m.track.artist);
        el.setAttribute('data-peer', m.track.peer.id);
        this.closeDiscoverModal();
        getArtistz(el);
      },
      // Play album replaces the queue with the album and closes the window;
      // Add to queue appends it and says so — the window stays, the keyboard
      // where it was (SPEC §5).
      dmQueueAlbum: async function (play) {
        const m = this.discover.modal;
        const gen = m.gen;
        let songs = m.album && m.album.songs;
        if (!songs) {
          try {
            songs = await MSTREAMAPI.peer.albumSongs(m.track.peer.id, this.dmAlbumQuery());
          } catch (_) { songs = null; }
          if (!this.dmLive(gen)) { return; }
        }
        if (!Array.isArray(songs) || songs.length === 0) {
          iziToast.warning({ title: this.tt('discover.modal.albumEmpty'), position: 'topCenter', timeout: 2500 });
          return;
        }
        if (play) { mstreamModule.clearQueue(); }
        songs.forEach((s, i) => {
          mstreamModule.addFederationSongWizard(m.track.peer, s.filepath, s.metadata || {}, !(play && i === 0));
        });
        if (play) { this.closeDiscoverModal(); return; }
        iziToast.success({ title: this.tt('discover.modal.albumQueued', { count: songs.length }), position: 'topCenter', timeout: 2000 });
      },
      // ── A folder's window (SPEC-fed §6.5) ──────────────────────────────
      // The count: one recursive listing of the folder on the peer, when
      // the window opens on the folder or its Folder choice is first
      // chosen — never on a page view — planned as the copy plans it
      // (DISCOVERJOBS.planFolder over the ping's supported formats: the
      // server may still leave out a hidden or ignored file, and its result
      // says so). A failed or unanswered listing is "Couldn't count its
      // songs", and nothing asks again. Once counted, "By your layout"
      // reads the songs' tags if it is the landing chosen.
      dmLoadFolderScan: async function (gen) {
        const m = this.discover.modal;
        const f = this.dmFolder();
        if (!f || m.folderScan || !m.track.peer) { return; }
        const scan = { state: 'counting', songs: null, subfolders: null, paths: null };
        m.folderScan = scan;
        let listing = null;
        try { listing = await MSTREAMAPI.peer.recursiveScan(m.track.peer.id, f.path); } catch (_) { listing = null; }
        if (!this.dmLive(gen) || m.folderScan !== scan) { return; }
        if (!Array.isArray(listing)) {
          m.folderScan = { state: 'failed', songs: null, subfolders: null, paths: null };
          return;
        }
        const supported = (MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.supportedAudioFiles) || null;
        const plan = DISCOVERJOBS.planFolder(listing, f.path, { supported });
        const n = DISCOVERJOBS.folderCounts(plan.songs);
        m.folderScan = { state: 'done', songs: n.songs, subfolders: n.subfolders, paths: plan.songs };
        // past the cap the card holds its line alone: the landings and Add
        // the keyboard may have reached meanwhile are gone
        this.dmHoldFocus();
        if (m.keep.landing === 'tags') { await this.dmLoadFolderTags(gen); }
      },
      // "By your layout"'s tags: each song's, read once — the first time
      // that landing is chosen, once the folder is counted — in one
      // metadata batch, and only for a folder of FOLDER_TAGS_MAX songs or
      // fewer. Past that, or with no answer, the window has no tags: every
      // tag variable is a slot.
      dmLoadFolderTags: async function (gen) {
        const m = this.discover.modal;
        const scan = m.folderScan;
        if (m.folderTags || !scan || scan.state !== 'done' || !m.track.peer) { return; }
        if (scan.songs === 0 || scan.songs > FOLDER_TAGS_MAX) { m.folderTags = { state: 'skipped', songs: null }; return; }
        const read = { state: 'loading', songs: null };
        m.folderTags = read;
        let res = null;
        try { res = await MSTREAMAPI.peer.metadataBatch(m.track.peer.id, scan.paths.map((p) => p.filepath)); } catch (_) { res = null; }
        if (!this.dmLive(gen) || m.folderTags !== read) { return; }
        m.folderTags = res && typeof res === 'object'
          ? { state: 'done', songs: scan.paths.map((p) => DISCOVERJOBS.folderSongTags(res[p.filepath] || { filepath: p.filepath, metadata: null })) }
          : { state: 'failed', songs: null };
      },
      // Whether the folder is counted: Listen plays and queues what the
      // copy takes, and waits for it (aria-disabled until then).
      dmFolderReady: function () {
        const scan = this.discover.modal.folderScan;
        return !!(scan && scan.state === 'done' && scan.paths && scan.paths.length);
      },
      // The meta line's count: "Counting…", "3 songs · no subfolders",
      // "Couldn't count its songs". → its parts.
      dmFolderCountParts: function () {
        const scan = this.discover.modal.folderScan;
        if (!scan || scan.state === 'counting') { return [this.tt('discover.modal.counting')]; }
        if (scan.state === 'failed') { return [this.tt('discover.modal.countFailed')]; }
        return [
          this.dmCount('discover.modal.songCount', scan.songs),
          scan.subfolders ? this.dmCount('discover.modal.subfolders', scan.subfolders) : this.tt('discover.modal.noSubfolders'),
        ];
      },
      // The play row's second line: how many songs, blank until counted.
      dmFolderPlaySub: function () {
        const scan = this.discover.modal.folderScan;
        return scan && scan.state === 'done' ? this.dmCount('discover.modal.songCount', scan.songs) : '';
      },
      // Play folder plays its first song in place of the queue, the rest
      // after it, and closes the window (as Play album does); Add to queue
      // appends them all and says so. In path order, as counted — nothing
      // before the count.
      dmQueueFolder: function (play) {
        const m = this.discover.modal;
        if (!this.dmFolderReady()) { return; }
        if (play) { mstreamModule.clearQueue(); }
        m.folderScan.paths.forEach((song, i) => {
          mstreamModule.addFederationSongWizard(m.track.peer, song.filepath, {}, !(play && i === 0));
        });
        if (play) { this.closeDiscoverModal(); return; }
        iziToast.success({ title: this.tt('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
      },
      // ── Federate row (network rows, admins) ────────────────────────────
      // Paired already (the peers listing exposes each peer's endpoint id)
      // → say so; an outbound request in flight → "sent"; else the invite.
      // Both lookups are admin routes: a 403 (not an admin, or a locked
      // admin API) hides the row rather than explaining it.
      dmLoadFederate: async function (gen) {
        const m = this.discover.modal;
        const endpointId = m.track.peer && m.track.peer.endpointId;
        if (!endpointId) { return; }
        this.discover.modal.federate = { visible: true, state: 'checking', peerName: m.track.peer.name || '', message: '', form: false, error: '' };
        try {
          const [peers, reqs] = await Promise.all([MSTREAMAPI.federationPeers(), MSTREAMAPI.federationRequests()]);
          if (!this.dmLive(gen)) { return; }
          const paired = peers && Array.isArray(peers.peers) ? peers.peers.find((p) => p.endpointId === endpointId) : null;
          if (paired) {
            this.discover.modal.federate.peerName = paired.name || this.discover.modal.federate.peerName;
            this.discover.modal.federate.state = 'paired';
            return;
          }
          const rows = reqs && Array.isArray(reqs.requests) ? reqs.requests : [];
          const mine = rows.filter((r) => r.peer_endpoint_id === endpointId);
          if (mine.some((r) => r.state === 'completed')) { this.discover.modal.federate.state = 'paired'; return; }
          const active = mine.some((r) => r.direction === 'out' && ['pending-delivery', 'delivered', 'accepted', 'granting'].indexOf(r.state) !== -1);
          this.discover.modal.federate.state = active ? 'sent' : 'idle';
        } catch (_) {
          if (!this.dmLive(gen)) { return; }
          this.discover.modal.federate.visible = false;
        }
      },
      dmInviteForm: function (show) {
        if (this.discover.modal.federate) { this.discover.modal.federate.form = show; }
      },
      dmSendInvite: async function () {
        const m = this.discover.modal;
        const f = m.federate;
        const gen = m.gen;
        if (!f || f.state === 'sending') { return; }
        f.state = 'sending';
        f.error = '';
        try {
          await MSTREAMAPI.composeFederationRequest(m.track.peer.endpointId, MSTREAMAPI.currentServer.vpaths || [], f.message);
          if (!this.dmLive(gen)) { return; }
          f.state = 'sent';
          f.form = false;
        } catch (err) {
          if (!this.dmLive(gen)) { return; }
          f.state = 'failed';
          f.error = (err && err.message) ? String(err.message) : '';
        }
      },
      // ── Previews ───────────────────────────────────────────────────────
      // Ask one provider for its 30-second clip and play it. Nothing is sent
      // to a catalogue until the user presses this. A second press stops it.
      // The main player is paused for the clip and resumed afterwards if it
      // was playing (the aside player, owner 'window').
      toggleDiscoverPreview: async function (plugin) {
        const name = plugin.name;
        if (this.discover.modal.playing === name) { this.stopDiscoverPreview(); return; }
        const state = this.discoverPreviewState(name);
        if (state.status === 'ready' && state.preview) { this.playDiscoverPreview(name, state.preview); return; }
        if (state.status === 'loading') { return; }
        const gen = this.discover.modal.gen;
        this.$set(this.discover.modal.previews, name, { status: 'loading', preview: null });
        const res = await MSTREAMAPI.discoveryPluginResolve(name, this.dmRecommendation());
        if (!this.dmLive(gen)) { return; }   // window closed or replaced meanwhile
        if (!res || res.disabled || !res.result) {
          this.$set(this.discover.modal.previews, name, { status: 'error', preview: null });
          return;
        }
        const preview = res.result.preview || null;
        this.$set(this.discover.modal.previews, name, { status: preview ? 'ready' : 'none', preview });
        if (preview) { this.playDiscoverPreview(name, preview); }
      },
      // One tile's clip in place of whatever the aside played (a tile's,
      // the page's clip): the main player stays paused across the swap.
      playDiscoverPreview: function (name, preview) {
        this.discover.modal.playing = name;
        const done = () => { this.stopDiscoverPreview(); };
        asidePlay('window', preview.url, {
          ended: done,
          error: done,
          // the page's clip took the aside, or the user started the main player
          stopped: () => { if (this.discover.modal) { this.discover.modal.playing = null; } },
        });
      },
      // Stops the window's own tile clip only: a clip the Peer
      // Recommendations page plays goes on under the window.
      stopDiscoverPreview: function () {
        asideStop('window');
        if (this.discover.modal) { this.discover.modal.playing = null; }
      },

      // ── The window's Preview, from Peer Recommendations ────────────────
      // One control bound to the page's clip (discover.clip): it shows the
      // clip only while the clip is this window's lead (by its lead key),
      // else what the visit's resolves answered for the lead.
      // The preview plug-in (PEERRECS.previewProvider): none = no section.
      dmClipProvider: function () {
        return this.clipProvider();
      },
      // The lead's clip as the window draws it: { status, preview, at,
      // seconds } — the live clip's when it is this lead, else idle with
      // the visit's answer for it (a preview resolved earlier, or none).
      dmClipOf: function () {
        const c = this.discover.clip;
        const key = PEERRECS.leadKey(this.discover.modal.track);
        if (key && c.key === key) { return { status: c.status, preview: c.preview, at: c.at, seconds: c.seconds }; }
        const r = key ? c.results[key] : null;
        if (r && r.status === 'none') { return { status: 'none', preview: null, at: 0, seconds: 30 }; }
        return { status: 'idle', preview: r && r.preview ? r.preview : null, at: 0, seconds: 30 };
      },
      dmClipOn: function () {
        return this.dmClipOf().status === 'playing';
      },
      // Being asked for, or waiting out a 429.
      dmClipBusy: function () {
        const s = this.dmClipOf().status;
        return s === 'resolving' || s === 'waiting';
      },
      // "No preview": 'none' for the visit (the control goes quiet), or
      // 'failed' for that press only (the next press asks again); '' else.
      dmClipNone: function () {
        const s = this.dmClipOf().status;
        return s === 'none' || s === 'failed' ? s : '';
      },
      // The attribution, once a resolve answered: the server's words
      // verbatim ("Preview from Deezer"), linked only to an https page.
      // → { text, link } or null.
      dmClipPreview: function () {
        const p = this.dmClipOf().preview;
        if (!p || typeof p.attribution !== 'string' || !p.attribution) { return null; }
        let link = null;
        try { link = typeof p.link === 'string' && new URL(p.link).protocol === 'https:' ? p.link : null; } catch (_) { link = null; }
        return { text: p.attribution, link };
      },
      // ['0:12', '0:30']: where the clip is, and its length.
      dmClipClock: function () {
        const c = this.dmClipOf();
        return [this.dmDuration(c.at) || '0:00', this.dmDuration(c.seconds) || '0:30'];
      },
      dmClipPct: function () {
        const c = this.dmClipOf();
        return c.seconds > 0 ? Math.max(0, Math.min(100, Math.round((c.at / c.seconds) * 100))) : 0;
      },
      // The control: the page's own play icon (clipToggle) on this lead.
      dmClipToggle: function () {
        const m = this.discover.modal;
        if (!m.track || this.dmClipNone() === 'none') { return; }
        this.clipToggle(m.track, { tile: m.tile });
      },

      // ── Peer Recommendations' clip (discover.clip) ─────────────────────
      // One lead's 30-second preview at a time, on the aside player (owner
      // 'clip'). The page's rows and band (m.js) and the window's Preview
      // section draw this one state; mstreamModule.watchClip hears its
      // events. Pacing (plan §5.5): a resolve only on a press (Preview all
      // is one), one in flight, a newer press takes a queued one's place; a
      // 429 waits PEERRECS.retryDelayMs and is asked once more, then it is
      // "No preview" for that press only (failed); preview: null is "No
      // preview" for the visit (none). A 403 is the feature switched off.
      // Everything async is fenced by clip.gen.
      clipProvider: function () {
        if (!this.discover.plugins.available) { return null; }
        return PEERRECS.previewProvider(this.discover.plugins.list);
      },
      // The play icon: this lead's clip — paused or resumed when it already
      // is the clip, dropped when it is still being asked for, else asked.
      clipToggle: function (raw, opts) {
        const c = this.discover.clip;
        const key = PEERRECS.leadKey(raw);
        if (key && c.key === key) {
          if (c.status === 'playing') { return Promise.resolve(this.clipPause()); }
          if (c.status === 'paused') { return Promise.resolve(this.clipResume()); }
          if (c.status === 'resolving' || c.status === 'waiting') { return Promise.resolve(this.clipStop('user')); }
        }
        return this.clipStart(raw, opts);
      },
      // A new clip for `raw` (opts.tile: its tile, else the lead's): the
      // one before it stops at once — the main player stays paused across
      // the hand-off — and this one plays from the visit's answers, or once
      // its resolve answers. Preview all's next lead is a clipStart made
      // inside the 'ended' / 'none' event: a session that no listener
      // carries on ends there (clipEnd).
      clipStart: async function (raw, opts) {
        const c = this.discover.clip;
        const key = PEERRECS.leadKey(raw);
        if (!key) { return; }
        c.gen += 1;
        const gen = c.gen;
        this.clipHalt();
        Object.assign(c, { key, raw, tile: dmTileOf((opts || {}).tile) || dmTileOf(raw.tile), status: 'resolving', preview: null, at: 0, seconds: 30 });
        asideClaim('clip', this.clipHandlers(gen));
        this.clipEmit('resolving');
        if (this.discover.plugins.available) { await this.ensureDiscoverPlugins(); }
        if (c.gen !== gen) { return; }
        const hit = c.results[key];
        if (hit && hit.status === 'ready') { return this.clipPlay(gen, hit.preview); }
        if (hit || !this.clipProvider()) { return this.clipSettle(gen, 'none'); }
        this.clipAsk(gen, 0);
      },
      // The aside's handlers for one clip: each acts only while it is
      // still the clip (gen).
      clipHandlers: function (gen) {
        const c = this.discover.clip;
        const mine = () => c.gen === gen;
        return {
          time: (seconds) => {
            if (!mine() || c.status !== 'playing') { return; }
            const at = Math.round((Number(seconds) || 0) * 4) / 4;
            if (at !== c.at) { c.at = at; this.clipEmit('time'); }
          },
          ended: () => {
            if (!mine() || c.status !== 'playing') { return; }
            c.status = 'idle';
            c.at = 0;
            this.clipEmit('ended');
            this.clipEnd(gen);
          },
          error: () => { if (mine() && CLIP_LIVE.indexOf(c.status) !== -1) { this.clipSettle(gen, 'failed'); } },
          // the aside let go: the window's tile took it ('preempted'), or
          // the user started the main player ('main')
          stopped: (why) => {
            if (!mine()) { return; }
            c.gen += 1;
            this.clipHalt();
            c.status = 'idle';
            c.at = 0;
            this.clipEmit('stopped', { why });
          },
        };
      },
      // One resolve in flight: a press made meanwhile waits for it (and
      // CLIP_QUEUE_MS more), a newer one taking its place.
      clipAsk: function (gen, attempt) {
        if (clipNet.flight || clipNet.timer) {
          clipNet.queued = { gen, attempt };
          this.clipPump();
          return;
        }
        this.clipSend(gen, attempt);
      },
      clipPump: function () {
        if (clipNet.flight || clipNet.timer || !clipNet.queued) { return; }
        clipNet.timer = setTimeout(() => {
          clipNet.timer = null;
          const q = clipNet.queued;
          clipNet.queued = null;
          if (q && q.gen === this.discover.clip.gen) { this.clipSend(q.gen, q.attempt); } else { this.clipPump(); }
        }, CLIP_QUEUE_MS);
      },
      // Ask the preview plug-in about the clip's lead. What answers 200 is
      // kept for the visit (a stale answer too); the rest is the clip's
      // only while it is still the clip.
      clipSend: async function (gen, attempt) {
        const c = this.discover.clip;
        const provider = this.clipProvider();
        if (c.gen !== gen) { this.clipPump(); return; }
        const hit = c.results[c.key];
        if (hit || !provider) {
          if (hit && hit.status === 'ready') { this.clipPlay(gen, hit.preview); } else { this.clipSettle(gen, 'none'); }
          this.clipPump();
          return;
        }
        const key = c.key;
        const results = c.results;
        clipNet.flight = true;
        let res = null;
        try { res = await MSTREAMAPI.discoveryPreview(provider.name, c.raw); } catch (_) { res = null; }
        clipNet.flight = false;
        const status = res ? res.status : 0;
        const body = res ? res.body : null;
        const answered = status === 200 && !!body && !!body.result && typeof body.result === 'object';
        const preview = answered ? clipPreviewOf(body.result.preview) : null;
        if (answered) { this.clipRemember(results, key, preview ? { status: 'ready', preview } : { status: 'none', preview: null }); }
        if (c.gen === gen) {
          if (answered) {
            if (preview) { this.clipPlay(gen, preview); } else { this.clipSettle(gen, 'none'); }
          } else if (status === 403) {
            this.clipReset();
            this.clipEmit('off');
          } else if (status === 429 && attempt === 0) {
            const ms = PEERRECS.retryDelayMs(provider.name);
            c.status = 'waiting';
            this.clipEmit('waiting', { ms });
            clipRetryTimer = setTimeout(() => { clipRetryTimer = null; if (c.gen === gen) { this.clipAsk(gen, 1); } }, ms);
          } else {
            // a second 429, no answer, any other: this press only
            this.clipSettle(gen, 'failed');
          }
        }
        this.clipPump();
      },
      // The clip plays `preview`; a preview of the lead's own album and
      // artist earns the art of every row with its tile key.
      clipPlay: function (gen, preview) {
        const c = this.discover.clip;
        c.preview = preview;
        c.seconds = Number(preview.seconds) > 0 ? Number(preview.seconds) : 30;
        c.at = 0;
        c.status = 'playing';
        const tileKey = c.tile && c.tile.key;
        if (tileKey && PEERRECS.artMatches(c.raw, preview) && c.art[tileKey] !== preview.artwork) {
          this.$set(c.art, tileKey, preview.artwork);
          this.clipEmit('art', { tileKey, url: preview.artwork });
        }
        asidePlay('clip', preview.url, this.clipHandlers(gen));
        this.clipEmit('playing');
      },
      // No clip for this press: 'none' (the lead has no preview) or
      // 'failed' (this press only).
      clipSettle: function (gen, status) {
        const c = this.discover.clip;
        c.status = status;
        c.preview = null;
        c.at = 0;
        this.clipEmit(status);
        this.clipEnd(gen);
      },
      // After an event that ends a clip: a listener that started the next
      // one carried the session on; else it ends here, and the main player
      // plays again if the session paused it.
      clipEnd: function (gen) {
        if (this.discover.clip.gen === gen) { asideStop('clip'); }
      },
      // The 429 wait and the queued press, dropped.
      clipHalt: function () {
        if (clipRetryTimer) { clearTimeout(clipRetryTimer); clipRetryTimer = null; }
        clipNet.queued = null;
      },
      // Preview all's one look ahead (m.js: the next lead, once the live
      // clip is past 20 s): its answer goes into the visit's, nothing
      // plays. Never while a resolve is out or queued, never for a lead
      // already answered, never retried. → whether it asked.
      clipPrefetch: async function (raw) {
        const c = this.discover.clip;
        const key = PEERRECS.leadKey(raw);
        const provider = this.clipProvider();
        if (!key || !provider || c.results[key] || clipNet.flight || clipNet.timer || clipNet.queued) { return false; }
        const results = c.results;
        clipNet.flight = true;
        let res = null;
        try { res = await MSTREAMAPI.discoveryPreview(provider.name, raw); } catch (_) { res = null; }
        clipNet.flight = false;
        if (res && res.status === 200 && res.body && res.body.result && typeof res.body.result === 'object') {
          const preview = clipPreviewOf(res.body.result.preview);
          this.clipRemember(results, key, preview ? { status: 'ready', preview } : { status: 'none', preview: null });
        }
        this.clipPump();
        return true;
      },
      clipPause: function () {
        const c = this.discover.clip;
        if (c.status !== 'playing' || !asidePause('clip')) { return false; }
        c.status = 'paused';
        this.clipEmit('paused');
        return true;
      },
      clipResume: function () {
        const c = this.discover.clip;
        if (c.status !== 'paused' || !asideResume('clip')) { return false; }
        c.status = 'playing';
        this.clipEmit('playing');
        return true;
      },
      // The band's ✕, the page left, a press on a clip still asked for: the
      // session ends, and the main player plays again if it paused it.
      // → whether a clip was live.
      clipStop: function (why) {
        const c = this.discover.clip;
        c.gen += 1;
        this.clipHalt();
        asideStop('clip');
        if (CLIP_LIVE.indexOf(c.status) === -1) { return false; }
        c.status = 'idle';
        c.at = 0;
        this.clipEmit('stopped', { why: why || 'user' });
        return true;
      },
      // A fresh visit (the page opened anew, plug-ins switched, a 403): the
      // clip stops and the visit's answers and earned art are forgotten.
      clipReset: function () {
        const c = this.discover.clip;
        this.clipStop('reset');
        Object.assign(c, { key: null, raw: null, tile: null, status: 'idle', preview: null, at: 0, seconds: 30, art: {}, results: {} });
        this.clipEmit('reset');
      },
      // An answer kept for the visit, the oldest dropped past
      // CLIP_RESULTS_MAX. `results` is the map the ask began with: a visit
      // reset since leaves the new one alone.
      clipRemember: function (results, key, entry) {
        const keys = Object.keys(results);
        if (!(key in results) && keys.length >= CLIP_RESULTS_MAX) { this.$delete(results, keys[0]); }
        this.$set(results, key, entry);
      },
      // A plain snapshot for the page: { key, raw, tile, status, preview,
      // at, seconds, live }.
      clipState: function () {
        const c = this.discover.clip;
        return { key: c.key, raw: c.raw, tile: c.tile, status: c.status, preview: c.preview, at: c.at, seconds: c.seconds, live: CLIP_LIVE.indexOf(c.status) !== -1 };
      },
      // { type, key, state: clipState(), …extra } to every watcher.
      clipEmit: function (type, extra) {
        const ev = Object.assign({ type, key: this.discover.clip.key, state: this.clipState() }, extra || {});
        clipWatchers.slice().forEach((fn) => { try { fn(ev); } catch (_) { /* a watcher's own trouble */ } });
      },

      // ── Plug-in jobs: Get it · Keep a copy · the strip ─────────────────
      // A row IS its job (alpha/discover-jobs.js turns one into what the row
      // shows). Rows exist only for what would work: the plug-in listed (on,
      // and its probe passing), this account allowed to start jobs, and
      // somewhere to put the file — a download lands in the collection
      // destination exactly like a copy.
      ensureDiscoverPlugins: function () {
        if (this.discover.plugins.list) { return Promise.resolve(this.discover.plugins.list); }
        if (!discoverPluginsPromise) {
          const host = MSTREAMAPI.currentServer.host;
          const pending = MSTREAMAPI.discoveryPlugins().then((res) => {
            // a fresher listing came in meanwhile (mstreamModule.takeDiscoverPlugins): it stands
            if (discoverPluginsPromise !== pending) { return this.discover.plugins.list || []; }
            discoverPluginsPromise = null;
            if (host !== MSTREAMAPI.currentServer.host) { return []; }   // the app moved to another server meanwhile
            this.discover.plugins.list = (res && res.plugins) || [];
            this.discover.plugins.jobsAllowed = !!(res && res.jobs && res.jobs.allowed === true);
            this.discover.plugins.maxFolderSongs = DISCOVERJOBS.maxFolderSongs(res);
            return this.discover.plugins.list;
          });
          discoverPluginsPromise = pending;
        }
        return discoverPluginsPromise;
      },
      discoverAcquirePlugins: function () {
        if (!this.discover.plugins.jobsAllowed) { return []; }
        return (this.discover.plugins.list || []).filter((p) => (p.capabilities || []).indexOf('acquire') !== -1);
      },
      discoverPluginTitle: function (name) {
        const p = (this.discover.plugins.list || []).find((x) => x.name === name);
        return (p && p.title) || name;
      },
      dmHasDestination: function () {
        const v = this.discover.dest.view;
        return !!(v && v.destination);
      },
      // "Get it": every acquire plug-in but the peer copy, which is Keep a
      // copy's. One { plugin, row } per plug-in; none without a destination
      // to land in, and none in album, artist or folder focus (a download is
      // one song's; those windows never start a song job). A connected
      // server's window offers them only in Keep a copy's place — the
      // copy's gate failed: while Keep shows, the exact file is one press
      // away. A download this song already has a job for still shows there,
      // in whatever state (a strip row reopens the window on it): only the
      // offers go.
      dmGetItRows: function () {
        if (!this.dmHasDestination() || this.discover.modal.focus) { return []; }
        const keep = this.discover.modal.source === 'federation' && this.dmKeepChoices().length > 0;
        return this.discoverAcquirePlugins()
          .filter((p) => p.name !== DISCOVERJOBS.COPY_PLUGIN && (!keep || !!this.discover.modal.jobs[p.name]))
          .map((plugin) => ({ plugin, row: this.dmJobRow(plugin.name) }));
      },
      // Get it's own path bar: where a download lands — not while Keep a
      // copy shows its bar (the same destination, and one editor at a time).
      dmGetItBar: function () {
        if (!this.dmGetItRows().length) { return false; }
        return !(this.discover.modal.source === 'federation' && this.dmKeepChoices().length > 0);
      },
      // "You can close this window — it keeps going" under Get it: while one
      // of its own downloads is live (Keep a copy says it of its copies).
      dmGetItLive: function () {
        return this.dmGetItRows().some((gr) => gr.row.live);
      },
      // The admin's invite row — the first option under "Get it" on a
      // network row (dmLoadFederate decides whether there is one).
      dmFederateVisible: function () {
        const f = this.discover.modal.federate;
        return !!(f && f.visible);
      },
      // Keep a copy's song: the copy plug-in's row, none or one.
      dmCopyRows: function () {
        if (this.discover.modal.source !== 'federation' || !this.dmHasDestination()) { return []; }
        return this.discoverAcquirePlugins()
          .filter((p) => p.name === DISCOVERJOBS.COPY_PLUGIN)
          .map((plugin) => ({ plugin, row: this.dmJobRow(plugin.name) }));
      },
      // A row's job: the plug-in's for the song, or the one for a scope.
      // Album and artist jobs are keyed without the peer, so the lookup can
      // hand back another connected server's copy of the same album: while
      // it runs it shows here as "from <that server>" (a second Add would
      // only return it); once it ended it is not this server's copy, and
      // the card is idle again. A song job is the recording, wherever it
      // came from — it stays, named by its server. The album's and the
      // song's row may instead read a wider copy of this server's that
      // settled them since (dmWiderJob).
      dmJobRow: function (name, scope) {
        const m = this.discover.modal;
        const { job, other } = this.dmShownJob(name, scope);
        let row = DISCOVERJOBS.jobRowState(job, { plugin: name });
        if (job && other) {
          const rest = !row.sub ? [] : (Array.isArray(row.sub.parts) ? row.sub.parts : [row.sub]);
          row = Object.assign({}, row, { sub: { parts: [{ key: 'discover.job.fromPeer', params: { peer: other.name } }, ...rest] } });
        }
        const err = m.jobErrors[DISCOVERJOBS.jobSlot(name, scope)];
        return err ? Object.assign({}, row, { sub: { text: err }, errored: true }) : row;
      },
      // The job a row shows, by those rules: { job, other, borrowed } —
      // `other` the server it copied from when that is not this row's
      // ({ id, name }), `borrowed` the scope of the wider copy whose view
      // of the album or the song it is (dmWiderJob), else null.
      dmShownJob: function (name, scope) {
        const m = this.discover.modal;
        let job = m.jobs[DISCOVERJOBS.jobSlot(name, scope)] || null;
        let other = this.dmJobOtherPeer(job);
        if (other && scope && scope !== 'song' && !DISCOVERJOBS.isLive(job)) { job = null; other = null; }
        const shown = this.dmWiderJob(name, scope, job);
        // a wider copy's view is this server's own copy, by construction
        if (shown !== job) { return { job: shown, other: null, borrowed: DISCOVERJOBS.jobScope(shown) }; }
        return { job, other, borrowed: null };
      },
      // The server a job copied from when it is not this peer row's own
      // ({ id, name }), else null.
      dmJobOtherPeer: function (job) {
        const m = this.discover.modal;
        const mine = m.source === 'federation' && m.track && m.track.peer ? m.track.peer.id : null;
        const theirs = job && job.recommendation && job.recommendation.peer;
        if (mine == null || !theirs || theirs.id == null || String(theirs.id) === String(mine)) { return null; }
        const name = theirs.name || (job.result && job.result.peer && job.result.peer.name) || 'peer';
        return { id: theirs.id, name };
      },
      // The Album choice and This song (the copy plug-in's album and song
      // rows on a connected server's row) read their own job — unless a
      // FINISHED wider copy of THIS server's settled them since: an artist
      // or only-missing copy, as its walk saw the row's album; for the
      // song, those or the album copy, only where their lists name the
      // song's file on the peer. The newest such wins over an older own
      // job; a live own job, or one newer than all of them, is the
      // choice's (DISCOVERYPAGE.keepJobFor). Another server's wider copy
      // never speaks here, nor does a live one (its own choice shows it).
      dmWiderJob: function (name, scope, own) {
        const m = this.discover.modal;
        const s = scope || 'song';
        if (name !== DISCOVERJOBS.COPY_PLUGIN || m.source !== 'federation' || !m.track || (s !== 'song' && s !== 'album')) { return own; }
        const wider = (s === 'album' ? ['artist', 'artist-missing'] : ['album', 'artist', 'artist-missing'])
          .map((w) => m.jobs[DISCOVERJOBS.jobSlot(name, w)])
          .filter((j) => j && !this.dmJobOtherPeer(j));
        return DISCOVERYPAGE.keepJobFor(s, own, wider, { album: m.track.album, filepath: m.track.filepath }, DISCOVERJOBS);
      },
      // Keep a copy's Album and Artist choices in a connected server's
      // window: the copy plug-in when it runs the scope, with a destination and the fact
      // the scope needs — the same conditions as the song row. An album
      // copy needs a credit too — the album's own (albumArtist: a
      // compilation is listed by it, whole) or the track artist: the peer
      // narrows the album's songs by it, and without one every album of
      // that name comes back, whoever made it (the jobs route's 400,
      // recommendation.js scopeMissing). The artist copies need the artist.
      // Opened from a connected server's pages, a song names its album's
      // credit or not at all (SPEC-fed §6.1): Album waits for the credit —
      // never the track artist in its place. The folder copy needs a folder
      // (an explorer's: dmFolder) — never on Discover.
      dmScopeRows: function (scope) {
        const m = this.discover.modal;
        if (m.source !== 'federation' || !this.dmHasDestination() || !m.track) { return []; }
        const credit = m.from === 'browse' ? (typeof m.track.albumArtist === 'string' ? m.track.albumArtist.trim() : '') : DISCOVERYPAGE.albumCreditOf(m.track);
        const has = scope === 'album' ? !!(m.track.album && credit) : (scope === 'folder' ? !!this.dmFolder() : !!m.track.artist);
        if (!has) { return []; }
        return this.discoverAcquirePlugins()
          .filter((p) => p.name === DISCOVERJOBS.COPY_PLUGIN && Array.isArray(p.scopes) && p.scopes.indexOf(scope) !== -1)
          .map((plugin) => ({ plugin, slot: DISCOVERJOBS.jobSlot(plugin.name, scope), row: this.dmJobRow(plugin.name, scope) }));
      },
      // "Only the albums you don't have" has nothing to add when, by name,
      // the library has every album of the artist's the peer lists — unless
      // such a copy still wants the user (dmMissingHeld: a job reopened
      // from the strip shows itself, its failure and its Retry).
      dmMissingRows: function () {
        const a = this.discover.modal.artist;
        const rows = this.dmScopeRows('artist-missing');
        if (a && a.missing === 0 && !this.dmMissingHeld(rows)) { return []; }
        return rows;
      },
      // An only-missing copy that still wants the user — running or
      // queued, failed, stopped early, or a start the server refused —
      // keeps its choice offered whatever the facts say now: the strip
      // holds the live and failed ones, and a failure (the peer gone, its
      // listing unanswered; nothing left missing by name) is what most
      // often defeats the facts.
      dmMissingHeld: function (rows) {
        return rows.some((r) => r.row.live || r.row.state === 'failed' || r.row.state === 'stopped' || r.row.errored === true);
      },
      // ── A connected server's window: Listen, then Keep a copy ─────────
      // The album's and the artist's fact rows under the play row: what the
      // peer reported — "2019 · 3 songs · 0:29", "3 albums · 9 songs" (the
      // artist's own albums, what every album copies; never one they only
      // appear on). Whether the library has any of it is said once, in
      // Keep a copy.
      dmAlbumFacts: function () {
        const m = this.discover.modal;
        const a = m.album;
        return [
          m.track.year || '',
          a && a.count !== null ? this.tt('discover.modal.songCount', { count: a.count }) : '',
          a && a.count !== null && a.seconds ? this.dmDuration(a.seconds) : '',
        ].filter(Boolean).join(' · ');
      },
      dmArtistFacts: function () {
        const a = this.discover.modal.artist;
        if (!a || a.theirs === null) { return ''; }
        return [
          this.tt('discover.modal.albumCount', { count: a.theirs }),
          a.theirSongs !== null ? this.tt('discover.modal.songCount', { count: a.theirSongs }) : '',
        ].filter(Boolean).join(' · ');
      },
      // Album focus: the play row's second line — "3 songs · 0:29" (the
      // header names the rest). Blank until the peer listed the album.
      dmAlbumPlaySub: function () {
        const a = this.discover.modal.album;
        if (!a || a.count === null) { return ''; }
        return [
          this.tt('discover.modal.songCount', { count: a.count }),
          a.seconds ? this.dmDuration(a.seconds) : '',
        ].filter(Boolean).join(' · ');
      },
      // The Keep card's choices: one per scope the copy plug-in runs for
      // this row (the same conditions as the rows they replace), each with
      // the size of what it would copy — "0:08 · mp3", "3 songs" ("Whole
      // compilation · 3 songs": a compilation copies whole, under its
      // credit), "Boukmanflow · 3 albums" (the song's own artist, on a
      // compilation too) — blank until the peer said. `aria` is the radio's
      // name: what the choice copies ("Every album by Boukmanflow, 3
      // albums"). The album's window has no "This song": it reads as the
      // album, and one of its songs is not; nor have an artist's and a
      // folder's (their one choice is theirs). Last, a file row's song's
      // folder (SPEC-fed §6.3): "Folder", its name until it is counted, then
      // how many songs ("Folder: Borrowed Tapes, 3 songs"). The section's
      // gate.
      dmKeepChoices: function () {
        const m = this.discover.modal;
        const tr = m.track;
        if (!tr) { return []; }
        const out = [];
        if (!m.focus && this.dmCopyRows().length) {
          const bits = [tr.duration ? this.dmDuration(tr.duration) : '', m.file && m.file.format ? m.file.format : ''];
          out.push({ scope: 'song', label: this.tt('discover.modal.song'), sub: bits.filter(Boolean).join(' · '),
            aria: this.tt('discover.keep.songAria', { title: tr.title || '' }) });
        }
        if (this.dmScopeRows('album').length) {
          const a = m.album;
          const count = a && a.count !== null ? this.tt('discover.modal.songCount', { count: a.count }) : '';
          const whole = this.dmKeepCompilation();
          const what = whole ? this.tt('discover.keep.compilationAria', { album: tr.album, credit: tr.albumArtist }) : this.tt('discover.keep.albumAria', { album: tr.album });
          out.push({ scope: 'album', label: this.tt('discover.modal.album'), sub: count && whole ? `${this.tt('discover.keep.wholeCompilation')} · ${count}` : count,
            aria: [what, count].filter(Boolean).join(', ') });
        }
        if (this.dmScopeRows('artist').length) {
          const a = m.artist;
          const count = a && a.theirs !== null ? this.tt('discover.modal.albumCount', { count: a.theirs }) : '';
          out.push({ scope: 'artist', label: this.tt('discover.modal.artist'), sub: count ? `${tr.artist} · ${count}` : '',
            aria: [this.tt('discover.keep.artistAria', { artist: tr.artist }), count].filter(Boolean).join(', ') });
        }
        if (this.dmScopeRows('folder').length) {
          const f = this.dmFolder();
          const scan = m.folderScan;
          const n = scan && scan.state === 'done' ? scan.songs : null;
          out.push({ scope: 'folder', label: this.tt('discover.keep.folder'), sub: n !== null ? this.dmCount('discover.modal.songCount', n) : f.name,
            aria: n !== null ? this.dmCount('discover.keep.folderAriaCount', n, { name: f.name }) : this.tt('discover.keep.folderAria', { name: f.name }) });
        }
        return out;
      },
      // A compilation: the row's album has a credit of its own that is not
      // the song's artist ("Various Artists") — Album copies it whole.
      dmKeepCompilation: function () {
        const tr = this.discover.modal.track || {};
        return typeof tr.albumArtist === 'string' && tr.albumArtist.trim() !== '' && dmNameKey(tr.albumArtist) !== dmNameKey(tr.artist);
      },
      // A choice in the strip. Folder, chosen the first time, counts the
      // folder (and reads its tags under "By your layout").
      dmKeepChoose: function (scope) {
        const m = this.discover.modal;
        m.keep.scope = scope;
        // a new folder being named goes with the landings that showed it
        if (scope !== 'folder' && m.keep.tree) { Object.assign(m.keep.tree, { naming: false, newName: '' }); }
        if (scope === 'folder') {
          if (!m.folderScan) { this.dmLoadFolderScan(m.gen); } else if (m.keep.landing === 'tags') { this.dmLoadFolderTags(m.gen); }
        }
      },
      // The chosen scope — the first offered one when the choice is gone.
      dmKeepChosen: function () {
        const choices = this.dmKeepChoices();
        const want = this.discover.modal.keep.scope;
        return choices.some((c) => c.scope === want) ? want : (choices.length ? choices[0].scope : null);
      },
      // "Only the albums you don't have": offered with the artist choice
      // when the library already holds some of the artist's albums, the
      // peer has one of theirs it lacks (by name), and the plug-in runs
      // that scope. With none of theirs here, every album is missing
      // anyway. A copy of that scope that still wants the user
      // (dmMissingHeld) keeps it offered.
      dmKeepMissingChoice: function () {
        if (this.dmKeepChosen() !== 'artist') { return false; }
        const a = this.discover.modal.artist;
        const rows = this.dmMissingRows();
        if (this.dmMissingHeld(rows)) { return true; }
        return !!(a && a.theirs !== null && a.local > 0 && a.missing > 0 && rows.length);
      },
      dmKeepMissingCount: function () {
        const a = this.discover.modal.artist;
        return a && a.missing != null ? a.missing : 0;
      },
      // The checkbox's words: "Only the 2 albums you don't have", or with
      // no count when it is unknown or none (a held job keeps the choice).
      dmKeepMissingLabel: function () {
        const n = this.dmKeepMissingCount();
        return n > 0 ? this.tt('discover.modal.onlyMissing', { count: n }) : this.tt('discover.modal.onlyMissingNoCount');
      },
      // The job scope the card acts on: the choice — under Artist, the
      // checkbox's: only the albums the library lacks when ticked, every
      // album when not. With no checkbox because nothing is missing by name
      // now, an only-missing copy newer than any plain artist copy is still
      // the Artist choice's record: the card shows it, it is not forgotten.
      // A checkbox hidden for another reason (the listings not answered,
      // none of the artist's albums here) leaves the Artist choice every
      // album's, its Add with it.
      dmKeepScope: function () {
        const chosen = this.dmKeepChosen();
        if (chosen !== 'artist') { return chosen; }
        if (this.dmKeepMissingChoice()) { return this.discover.modal.keep.onlyMissing ? 'artist-missing' : 'artist'; }
        const a = this.discover.modal.artist;
        const none = !!(a && a.missing === 0);
        return none && this.dmKeepArtistNewest() === 'artist-missing' && this.dmScopeRows('artist-missing').length ? 'artist-missing' : 'artist';
      },
      // The newer of THIS server's artist copies — 'artist' (every album)
      // or 'artist-missing', the one made later — null for neither.
      // Another server's is not this server's record.
      dmKeepArtistNewest: function () {
        const m = this.discover.modal;
        let best = null;
        for (const scope of ['artist', 'artist-missing']) {
          const job = m.jobs[DISCOVERJOBS.jobSlot(DISCOVERJOBS.COPY_PLUGIN, scope)];
          if (job && !this.dmJobOtherPeer(job) && (!best || Number(job.id) > Number(best.job.id))) { best = { scope, job }; }
        }
        return best ? best.scope : null;
      },
      // The scope the Artist segment speaks for: that newer copy, else
      // another server's live only-missing one, else every album's.
      dmKeepArtistSays: function () {
        const theirs = this.discover.modal.jobs[DISCOVERJOBS.jobSlot(DISCOVERJOBS.COPY_PLUGIN, 'artist-missing')];
        return this.dmKeepArtistNewest() || (DISCOVERJOBS.isLive(theirs) ? 'artist-missing' : 'artist');
      },
      // The card's job for a scope (the card's own unless given): { plugin,
      // scope (none for the song), slot, row, job, other, borrowed } — the
      // row DISCOVERJOBS.jobRowState makes of it and the job it reads
      // (dmShownJob). null when the scope is not offered.
      dmKeepRow: function (scope) {
        const s = scope || this.dmKeepScope();
        if (!s) { return null; }
        const rows = s === 'song' ? this.dmCopyRows() : this.dmScopeRows(s);
        if (!rows.length) { return null; }
        const r = rows[0];
        const shown = this.dmShownJob(r.plugin.name, s === 'song' ? undefined : s);
        return { plugin: r.plugin, scope: s === 'song' ? undefined : s, slot: r.slot || r.plugin.name, row: r.row, job: shown.job, other: shown.other, borrowed: shown.borrowed };
      },
      // The primary's words, idle, by scope — a count only where it is
      // known, and no promise the copy may not keep: "Add this song"; "Add
      // album · 3 songs" ("Add the songs you lack" when the library has the
      // album by name — the copy decides by file — "Add album" before the
      // peer said); "Add 3 albums" ("Add every album"); only the missing
      // ones, "Add 1 album" ("Add the missing albums"); a folder, "Add
      // folder · 3 songs" ("Add folder" while it is counted, or when it
      // could not be — Add never waits on the count).
      dmKeepStartLabel: function (scope) {
        const s = scope || this.dmKeepScope();
        const m = this.discover.modal;
        if (s === 'folder') {
          const scan = m.folderScan;
          return scan && scan.state === 'done' && scan.songs ? this.dmCount('discover.keep.addFolder', scan.songs) : this.tt('discover.keep.addFolderUncounted');
        }
        if (s === 'album') {
          const a = m.album;
          if (a && a.owned) { return this.tt('discover.keep.addLacking'); }
          return a && a.count ? this.tt('discover.keep.addAlbum', { count: a.count }) : this.tt('discover.keep.addAlbumUncounted');
        }
        if (s === 'artist') {
          const a = m.artist;
          return a && a.theirs ? this.tt('discover.keep.addAlbums', { count: a.theirs }) : this.tt('discover.keep.addEvery');
        }
        if (s === 'artist-missing') {
          const n = this.dmKeepMissingCount();
          return n ? this.tt('discover.keep.addAlbums', { count: n }) : this.tt('discover.keep.addMissing');
        }
        return this.tt('discover.keep.addSong');
      },
      // Add — and Retry, Add again, Try again: a copy of `scope` (the
      // card's own unless given), sent with the destination the window
      // shows (dmJobStart). A folder lands where the landings say — or,
      // for a Retry or an Add again of `job`, where that copy was asked to
      // (its params.landing: none = as on the peer). Once the server
      // answered, the keyboard goes to the button now in the pressed one's
      // place (dmKeepHold).
      dmKeepStart: async function (scope, job) {
        const k = this.dmKeepRow(scope);
        if (!k) { return; }
        discoverKeepPresses += 1;
        try {
          if (k.scope === 'folder') {
            const landing = job ? ((job.params && job.params.landing) || null) : this.dmFolderLandingSent();
            await this.dmJobStart(k.plugin, null, k.scope, landing);
            // the copy under way: the landings go, a new folder being named
            // there with them
            const m = this.discover.modal;
            if (m.keep.tree && m.jobs[k.slot]) { Object.assign(m.keep.tree, { naming: false, newName: '' }); }
          } else if (k.scope) { await this.dmJobStart(k.plugin, null, k.scope); } else { await this.dmJobStart(k.plugin); }
        } finally { discoverKeepPresses -= 1; }
        this.dmKeepHold();
      },
      // ── Keep a copy: what the card says (SPEC §6–§8) ───────────────────
      // One scope's state in the window's words — the card's own scope
      // unless given (a segment's marker reads the others). What became of
      // the job is DISCOVERJOBS.jobRowState's to say (the strip and the
      // admin's Downloads read it too); this is how the card puts it:
      //   kind      'idle' (the path bar and Add) · 'state' (a job: the
      //             outcome block) · 'refused' (a start the server did not
      //             take: the bar, `line`, Try again) · 'lost' (a right gone
      //             while the window was open: `line`, alone in the card) ·
      //             'cap' (a folder past the songs one copy takes here:
      //             `line`, alone in the card)
      //   state     idle · queued · copying · stopping · kept · yours ·
      //             skipped · stopped · refused · failed · cancelled ·
      //             nothing · done · refusedStart · lost · cap
      //   bar       whether the path bar draws under the choices (idle, a
      //             refused start) — a folder's only "By your layout": as on
      //             the peer and into a folder draw their own place
      //   landing   a folder's: the one chosen while idle, the job's own
      //             once there is one ('mirror' · 'folder' · 'tags')
      //   tile      { icon, tint: gold · ok · warn · err · grey }
      //   headline  with its tone (n · ok · warn · err) and the % beside it
      //   sub, muted, progress (a %, 'indeterminate' or null) and
      //   progressText (what the bar says aloud), path (dmJobPath: Into
      //   while it runs, In once it landed), retryPath ({ prefix, path }:
      //   where Retry or Add again adds now the saved place moved — or, for
      //   a folder copy into a folder of its own, where it adds: its
      //   `suffix` the words after it), files (what Play your copy plays),
      //   folder (where Show in your library opens: [library, folder…])
      //   actions   [{ id, kind: primary · secondary · ghost, label, icon,
      //             busy, disabled }], left to right — the primary last;
      //             `disabled` a folder's Add where it cannot land
      //   status    what the headline says as a live region: the headline
      //             while it runs (the % is the bar's), headline and sub
      //             once it is over
      // `other` = another server's copy ({ id, name }): drawn grey, never
      // this window's done; `borrowed` = the scope of a wider copy of this
      // server's that speaks for the album or the song. null when the scope
      // is not offered.
      dmKeepView: function (scope) {
        const m = this.discover.modal;
        const tt = (key, params) => this.tt(key, params);
        const v = {
          scope: null, slot: null, kind: 'state', state: 'idle', job: null, other: null, borrowed: null, live: false, bar: false, landing: null,
          tile: null, headline: '', tone: 'n', pct: null, sub: '', muted: '', progress: null, progressText: '',
          path: null, retryPath: null, line: '', files: [], folder: null, actions: [], status: '',
        };
        const lost = this.dmKeepLost();
        if (lost) { return Object.assign(v, { kind: 'lost', state: 'lost', line: tt('discover.keep.lost.' + lost) }); }
        const k = this.dmKeepRow(scope);
        if (!k) { return null; }
        const s = k.scope || 'song';
        const job = k.job;
        const other = k.other;
        const busy = m.jobBusy[k.slot] === true;
        const here = (m.track && m.track.peer && m.track.peer.name) || 'peer';
        // a start in flight dims the button that asked for it ("Adding…")
        const act = (id, kind, label, icon) => ({ id, kind, label, icon: icon || null, busy: busy && ['add', 'retry', 'addAgain', 'tryAgain'].indexOf(id) !== -1 });
        // a folder's Add waits for a place it can land in (a name the
        // folder list refuses, a path too long): dimmed, never gone
        const folder = s === 'folder';
        const add = () => Object.assign(act('add', 'primary', busy ? tt('discover.keep.adding') : this.dmKeepStartLabel(s), 'folder'),
          folder && !busy ? { disabled: !this.dmFolderPlaceOk() } : {});
        // idle, the landings say where a folder goes; with a job, the job's
        // own landing does (a second Add of a live copy only returns it)
        const landing = folder ? (job ? DISCOVERJOBS.landingMode(job.params && job.params.landing) : m.keep.landing) : null;
        Object.assign(v, { scope: s, slot: k.slot, job, other, borrowed: k.borrowed, live: !!k.row.live, landing, bar: !folder || landing === 'tags' });

        // A start the server refused (SPEC §8.1): the choices and the bar
        // stay; the line says why, and Try again takes Add's place — Add
        // itself when the destination moved (the bar already shows where).
        const refusal = m.jobRefusals[k.slot];
        if (refusal && !v.live) {
          const moved = refusal.error === 'destination_changed';
          const why = moved ? 'discover.modal.dest.changed'
            : (refusal.status === 429 ? 'discover.keep.tooMany' : (refusal.status === 409 ? 'discover.keep.someoneElse' : 'discover.job.requestFailed'));
          return Object.assign(v, { kind: 'refused', state: 'refusedStart', line: tt(why),
            actions: [moved ? add() : act('tryAgain', 'ghost', tt('discover.keep.tryAgain'), 'retry')] });
        }
        if (!job) {
          // a folder past the cap (SPEC-fed §6.5.4): its line alone — no
          // landings, no place, no Add
          const cap = folder ? this.dmFolderCap() : null;
          if (cap) { return Object.assign(v, { kind: 'cap', state: 'cap', bar: false, line: cap }); }
          return Object.assign(v, { kind: 'idle', actions: [add()] });
        }
        v.bar = false;

        // Queued, copying, stopping: where it is going (Into), Cancel. The
        // server's line under the headline, its % beside it; another
        // server's copy grey, and its own Cancel.
        if (DISCOVERJOBS.isLive(job)) {
          // 0 is no figure yet: the copy's first word is its "asking … about
          // the file", before a byte moved (S4: no %, the bar sweeps)
          const pct = Number.isFinite(job.progress) && job.progress > 0 ? Math.round(job.progress * 100) : null;
          const line = this.dmKeepLine(job.statusText);
          const queued = job.state === 'queued';
          const stopping = !queued && job.cancelRequested === true;
          Object.assign(v, {
            state: queued ? 'queued' : (stopping ? 'stopping' : 'copying'),
            tile: { icon: queued ? 'clock' : 'download', tint: queued || other ? 'grey' : 'gold' },
            path: this.dmJobPath(job),
          });
          if (queued) {
            v.headline = other ? tt('discover.keep.queuedFrom', { peer: other.name }) : tt('discover.keep.queued');
            v.sub = tt('discover.job.queuedSub');
          } else if (stopping) {
            v.headline = tt('discover.keep.stopping');
            v.sub = other ? [tt('discover.keep.theirCopy', { peer: other.name }), line].filter(Boolean).join(' · ') : dmCapital(line);
            v.progress = pct;   // frozen where the cancel found it
          } else {
            v.headline = other ? tt('discover.keep.copyingFrom', { peer: other.name }) : tt('discover.keep.copying');
            v.pct = pct;
            v.sub = line ? dmCapital(line) : (pct === null ? tt('discover.job.starting') : '');
            v.progress = pct === null ? 'indeterminate' : pct;
          }
          if (pct !== null && v.progress !== null) { v.progressText = [`${pct}%`, line].filter(Boolean).join(', '); }
          // another server's album or artist copy holds this server's Add
          // until it ends (a song's is the recording: it stays once it did)
          if (other && s !== 'song' && !stopping) { v.muted = tt('discover.keep.addReturns', { peer: here }); }
          if (!stopping) { v.actions = [other ? act('cancelOther', 'ghost', tt('discover.keep.cancelOther')) : act('cancel', 'ghost', tt('discover.modal.cancel'))]; }
          v.status = v.headline;
          return v;
        }

        // Over: what landed (In), and what can be done with it — never Add
        // again beside a result; Retry only with something left to take.
        const res = (job.result && typeof job.result === 'object') ? job.result : {};
        const many = (res.songs && typeof res.songs.total === 'number') || (res.counts && typeof res.counts.total === 'number');
        const n = many ? DISCOVERJOBS.manyCounts(res) : null;
        const peer = (res.peer && res.peer.name) || (other && other.name) || here;
        const words = (list) => list.filter(Boolean).join(' · ');
        const parts = (leave) => DISCOVERJOBS.manyParts(res).filter((p) => (leave || []).indexOf(p.key) === -1).map((p) => tt(p.key, p.params));
        const landed = this.dmJobLanded(job);
        // whose copy this is when it is not the choice's own: the wider
        // copy that settled it — or, said only of what it copied, the
        // only-missing copy the Artist choice keeps once the checkbox went
        // (R9)
        const whose = k.borrowed ? this.dmKeepWhose(k.borrowed, job) : '';
        const record = !k.borrowed && s === 'artist-missing' && this.dmKeepChosen() === 'artist' && !this.dmKeepMissingChoice() ? tt('discover.keep.missingRecord') : '';
        Object.assign(v, { path: this.dmJobPath(job), folder: landed && landed.vpath ? [landed.vpath].concat(landed.dirs) : null, files: this.dmKeepFiles(res, n) });
        const play = (kind) => (v.files.length ? act('play', kind, tt('discover.keep.play'), 'play') : null);
        const queue = () => (v.files.length ? act('queue', 'secondary', tt('discover.modal.queue'), 'plus') : null);
        const show = () => (v.folder ? act('show', 'ghost', tt('discover.keep.show'), 'folder') : null);
        const retry = () => act('retry', 'primary', tt('discover.job.retry'), 'retry');
        const wide = s === 'artist' || s === 'artist-missing';
        // A file already sits where this one would go (S11): nothing was
        // overwritten, and nothing here is known to be the song — no Play. A
        // Retry would skip it again, until the saved place is somewhere else.
        const skipped = () => {
          const moved = this.dmDestMoved(job);
          Object.assign(v, { state: 'skipped', tile: { icon: 'warn', tint: 'warn' }, headline: tt('discover.keep.skipped'), tone: 'warn',
            sub: words([tt('discover.keep.exists'), whose]), muted: moved ? tt('discover.modal.dest.movedSince') : '', files: [] });
          v.actions = [act('change', 'ghost', tt('discover.modal.dest.change')), moved ? retry() : null];
        };
        switch (k.row.state) {
          case 'copied':
          case 'copiedMany': {
            const gaps = !!n && (n.failed > 0 || n.albumsFailed > 0);
            Object.assign(v, { state: 'kept', tile: { icon: 'check', tint: 'ok' }, headline: tt('discover.keep.kept'), tone: 'ok' });
            v.sub = n ? words(parts().concat(whose || record)) : dmCapital(words([other ? tt('discover.keep.copiedFrom', { peer: other.name }) : '', whose]));
            if (gaps) { v.muted = tt('discover.keep.gaps'); }
            // a folder's files the copy left out — not music this server
            // plays, or hidden (its gaps say more: they win)
            const outFiles = folder && Array.isArray(res.skippedFiles) ? res.skippedFiles.length : 0;
            if (!gaps && outFiles) { v.muted = this.dmCount('discover.keep.filesLeftOut', outFiles); }
            // an artist's copy is many albums: no Play, its folder to show
            if (s === 'song') { v.actions = [queue(), play('primary')]; } else if (wide) { v.actions = [show(), gaps ? retry() : null]; } else { v.actions = gaps ? [play('secondary'), retry()] : [show(), play('primary')]; }
            break;
          }
          case 'owned': {
            // "Already yours" only when every skip was a song the library
            // has (rule 4): an album or a walk whose skips include a file
            // that merely sat at its place reads as Skipped, as one song does
            const at = n && res.songs && Array.isArray(res.songs.skipped) ? res.songs.skipped : [];
            if (at.some((x) => x && x.why === 'exists')) { skipped(); break; }
            Object.assign(v, { state: 'yours', tile: { icon: 'check', tint: 'grey' }, headline: tt('discover.keep.yours') });
            v.sub = n ? words([tt('discover.keep.haveItAll')].concat(parts(), whose)) : words([tt('discover.keep.ownedSong'), whose]);
            // an artist's (R7): nothing copied, so no path and nothing to do
            if (s === 'song') { v.actions = [queue(), play('primary')]; } else if (wide) { v.path = null; } else { v.actions = [show(), play('primary')]; }
            break;
          }
          case 'exists':
            skipped();
            break;
          case 'stopped':
            Object.assign(v, { tile: { icon: 'warn', tint: 'warn' }, tone: 'warn' });
            if (res.stopped === 'refused') {
              // the peer refuses this server's key: it would again — no
              // Retry, no Add (a song's result has no counts: nothing came)
              Object.assign(v, { state: 'refused', headline: tt('discover.keep.refused', { peer }), sub: tt('discover.job.stoppedRefused', { peer }),
                muted: n && n.copied ? tt('discover.keep.refusedSome', { count: n.copied, peer }) : tt('discover.keep.refusedNone', { peer }) });
            } else {
              // what an album's or a folder's copy left behind ("2 not
              // copied": its failures with the songs it never reached); a
              // walk of many albums knows only what it reached
              const total = res.counts && typeof res.counts.total === 'number' ? res.counts.total : (Number(res.songs && res.songs.total) || 0);
              const left = s === 'album' || folder ? Math.max(0, total - n.copied - n.skipped) : 0;
              const tail = { quota: 'discover.keep.tryLater', busy: 'discover.keep.tryMoment' }[res.stopped];
              Object.assign(v, { state: 'stopped', headline: tt('discover.keep.stopped.' + res.stopped, { peer }), muted: tt('discover.keep.gaps'),
                sub: words(parts(['discover.job.failedCount']).concat(left ? tt('discover.keep.notCopied', { count: left }) : '', tail ? tt(tail) : '')) });
              v.actions = [retry()];
            }
            break;
          case 'failed':
            Object.assign(v, { state: 'failed', tile: { icon: 'warn', tint: 'err' }, headline: tt('discover.keep.failed'), tone: 'err' });
            // the server's words when the job threw — or a many-song copy's
            // counts: copied 0 with failures is a failure, whatever else it
            // found
            if (job.state === 'failed' || !n) {
              v.sub = job.error ? String(job.error) : tt('discover.job.failedSub');
            } else {
              v.sub = words([tt('discover.keep.nothingCopied')].concat(parts(['discover.job.copiedCount'])));
            }
            // a folder past the server's cap (F15: a server that does not
            // say its cap up front): a Retry would fail the same way — the
            // server's words name the limit
            v.actions = folder && this.dmFolderCapFailed(job) ? [] : [retry()];
            break;
          case 'cancelled':
            Object.assign(v, { state: 'cancelled', tile: { icon: 'close', tint: 'grey' }, headline: tt('discover.keep.cancelled') });
            v.sub = n && n.copied
              ? words(parts(['discover.job.failedCount', 'discover.job.albumsFailed', 'discover.job.albumsLeftOut']).concat(tt('discover.keep.restStay', { peer })))
              : tt('discover.keep.nothingCopied');
            v.actions = [act('addAgain', 'primary', tt('discover.keep.addAgain'), 'folder')];
            break;
          case 'nothing':
            Object.assign(v, { state: 'nothing', tile: { icon: 'folder', tint: 'grey' }, headline: tt('discover.keep.nothing'), sub: this.dmText(k.row.sub) });
            break;
          default:
            // a finished job whose result the window cannot read
            Object.assign(v, { state: 'done', tile: { icon: 'check', tint: 'grey' }, headline: tt('discover.keep.done') });
        }
        v.actions = v.actions.filter(Boolean);
        // Another server's song is the recording, shown in any state (rule
        // 3): every state names where it came from, as "Copied from" does —
        // a Retry or an Add again here asks this window's server. A refusal
        // names it in its headline.
        if (other && s === 'song' && v.state !== 'kept' && v.state !== 'refused') { v.sub = words([tt('discover.keep.fromPeer', { peer: other.name }), v.sub]); }
        // Retry and Add again land at the saved place now: when that is not
        // where this copy went, the card says where — Skipped says it in its
        // muted line already (S11b). A folder's land by its own landing: one
        // into a folder of its own says where, always (the landings are not
        // there to say it), and its In line goes when it names the same
        // place; one as on the peer or by the layout, once the saved place
        // moved, where it lands now.
        const again = v.actions.find((a) => a.id === 'retry' || a.id === 'addAgain');
        const own = folder && landing === 'folder';
        const now = again && v.state !== 'skipped' && (own || this.dmDestMoved(job))
          ? this.dmDestPath(s, null, null, folder ? (job.params && job.params.landing) || null : undefined) : null;
        if (now && own && v.path && v.path.path.title === now.title) { v.path = null; }
        if (now) {
          v.retryPath = { prefix: tt(again.id === 'retry' ? 'discover.modal.dest.retryAddsTo' : 'discover.modal.dest.addAgainAddsTo'), path: now, suffix: own ? '' : tt('discover.modal.dest.savedNow') };
          // one note on a card: an In line drawn from the place the copy ran
          // with (its result named no files) says its slots with the Retry
          // line's, under the last path
          const ran = v.path && v.path.path;
          if (ran && ran.slotNote && now.slotNote) {
            const slots = ran.slots.concat(now.slots.filter((x) => ran.slots.indexOf(x) === -1));
            v.path = Object.assign({}, v.path, { path: Object.assign({}, ran, { slotNote: '' }) });
            v.retryPath.path = Object.assign({}, now, { slotNote: this.dmSlotNote(s, slots) });
          }
        }
        v.status = v.sub ? `${v.headline}, ${v.sub}` : v.headline;
        return v;
      },
      // A running copy's line from the server, as the card's sub: its
      // percentage left out (the figure sits beside the headline, and on
      // the bar).
      dmKeepLine: function (text) {
        return String(text || '').split(' · ').filter((p) => !/^\s*\d+(?:\.\d+)?\s*%\s*$/.test(p)).join(' · ').trim();
      },
      // What Play your copy plays, in the library: the song's file, or an
      // album's as its lists name them — the copied ones; with none copied,
      // what the copy found already here. The lists stop at 500 entries:
      // what is listed plays.
      dmKeepFiles: function (res, n) {
        if (res.copied && res.copied.filepath) { return [res.copied.filepath]; }
        if (res.skipped === 'owned') { return res.existing && res.existing.filepath ? [res.existing.filepath] : []; }
        if (!n) { return []; }
        const songs = res.songs || {};
        const list = n.copied > 0 ? songs.copied : songs.skipped;
        return (Array.isArray(list) ? list : []).map((x) => x && (n.copied > 0 ? x.filepath : x.at)).filter((p) => typeof p === 'string' && p !== '');
      },
      // The wider copy of this server's that settled the album or the song,
      // in the sub: "with your album copy", "with your copy of every album
      // by Boukmanflow", "with your copy of Boukmanflow's missing albums".
      dmKeepWhose: function (scope, job) {
        const tr = this.discover.modal.track || {};
        const artist = (job && job.recommendation && job.recommendation.artist) || tr.artist || '';
        if (scope === 'album') { return this.tt('discover.keep.withAlbum'); }
        return this.tt(scope === 'artist-missing' ? 'discover.keep.withMissing' : 'discover.keep.withArtist', { artist });
      },
      // A segment's marker (SPEC §6.3), for a scope with a state that is not
      // the one chosen: { glyph: clock · dot · check · warn, tone, word,
      // wordTone } — the tones the window's colour tokens (t3 · src · other
      // · ok · warn · errt). null for none: idle, cancelled, nothing to copy,
      // done, a refused start. Another server's live copy reads "Copying
      // from <peer>" queued or not — only the block's headline tells them
      // apart.
      dmKeepMarker: function (view) {
        const v = view;
        if (!v) { return null; }
        const mark = (glyph, tone, word, wordTone) => ({ glyph, tone, word, wordTone: wordTone || tone });
        switch (v.state) {
          case 'queued': return v.other ? mark('dot', 'other', this.tt('discover.keep.copyingFrom', { peer: v.other.name }), 't3') : mark('clock', 't3', v.headline);
          case 'copying': return v.other ? mark('dot', 'other', v.headline, 't3') : mark('dot', 'src', v.pct === null ? v.headline : `${v.headline} · ${v.pct}%`);
          case 'stopping': return mark('dot', v.other ? 'other' : 'src', v.headline, 't3');
          case 'kept': return mark('check', 'ok', v.headline);
          case 'yours': return mark('check', 't3', v.headline);
          case 'skipped': return mark('warn', 'warn', v.headline);
          case 'stopped': return mark('warn', 'warn', this.tt('discover.keep.markStopped'));
          case 'refused': return mark('warn', 'warn', this.tt('discover.keep.markRefused'));
          case 'failed': return mark('warn', 'errt', v.headline);
          default: return null;
        }
      },
      // The choice strip: each choice with what its segment says now. The
      // chosen one keeps its plain sub (the card below says its state,
      // once); another with a state shows its marker and the state's word
      // in the sub's place, and its radio's name says it too ("Album:
      // Borrowed Tapes, 3 songs, in your collection"). The Artist segment
      // speaks for the newer of this server's artist copies.
      dmKeepSegments: function () {
        const chosen = this.dmKeepChosen();
        return this.dmKeepChoices().map((c) => {
          const on = c.scope === chosen;
          const view = on ? null : this.dmKeepView(c.scope === 'artist' ? this.dmKeepArtistSays() : c.scope);
          const marker = this.dmKeepMarker(view);
          const said = marker ? (marker.word.charAt(0).toLowerCase() + marker.word.slice(1)).replace(' · ', ', ').replace('…', '') : '';
          return Object.assign({}, c, { on, marker, live: !!(view && view.live), sub: marker ? marker.word : c.sub, aria: said ? `${c.aria}, ${said}` : c.aria });
        });
      },
      // Keep a copy shows when the copy's gate passed (dmKeepChoices) — and
      // keeps its place, as one plain line, when a right went while open.
      dmKeepShown: function () {
        return this.dmKeepChoices().length > 0 || this.dmKeepLost() !== '';
      },
      // Under Artist, what an artist copy leaves out (SPEC-fed §6.4), by the
      // copy's own rule (DISCOVERJOBS.artistLeftOut over the peer's listing
      // the window read): "Leaves out Night Market Sampler: Boukmanflow
      // only appears on it." — several counted — and "Songs outside an
      // album stay out too." for a listing with songs in no album. From a
      // connected server's pages and in an artist's window only (Discover's
      // windows say what they always said). '' for nothing left out.
      dmKeepLeftOut: function () {
        const m = this.discover.modal;
        if ((m.from !== 'browse' && !this.dmArtistFocus()) || this.dmKeepChosen() !== 'artist' || !m.artist || !m.artist.listing) { return ''; }
        const out = DISCOVERJOBS.artistLeftOut({ albums: m.artist.listing }, m.track.artist);
        return out ? out.parts.map((p) => this.tt(p.key, p.params)).join(' ') : '';
      },
      // ── Keep a copy: where a folder lands (SPEC-fed §6.5.4) ────────────
      // The landings, idle under the Folder choice — a copy (live or over)
      // shows its own, in its state: one folder, one job (G20). Not past
      // the cap, not while the card is a right lost.
      dmLandShown: function () {
        const v = this.dmKeepView();
        return !!v && v.scope === 'folder' && (v.kind === 'idle' || v.kind === 'refused');
      },
      // The three, each { mode, label, sub, on }: as on the peer (the
      // first: its own folders, as they are there), into a folder (one
      // picked for this copy only), by the layout (each song by its tags).
      dmLandings: function () {
        const m = this.discover.modal;
        const peer = (m.peer && m.peer.name) || (m.track && m.track.peer && m.track.peer.name) || '';
        return [
          { mode: 'mirror', label: this.tt('discover.keep.landing.mirror', { peer }), sub: this.tt('discover.keep.landing.mirrorSub') },
          { mode: 'folder', label: this.tt('discover.keep.landing.folder'), sub: this.tt('discover.keep.landing.folderSub') },
          { mode: 'tags', label: this.tt('discover.keep.landing.tags'), sub: this.tt('discover.keep.landing.tagsSub') },
        ].map((l) => Object.assign(l, { on: l.mode === m.keep.landing }));
      },
      // A landing chosen: into a folder lists its first place's folders,
      // by the layout reads the songs' tags (once); the destination editor
      // is the layout's, and goes with it. When the switch took the
      // control the keyboard was on, the landings take it.
      dmLandChoose: function (mode) {
        const m = this.discover.modal;
        if (['mirror', 'folder', 'tags'].indexOf(mode) === -1) { return; }
        m.keep.landing = mode;
        if (mode !== 'tags' && m.picker) { m.picker = null; }
        // a new folder being named goes with "Into a folder…"
        if (mode !== 'folder' && m.keep.tree) { Object.assign(m.keep.tree, { naming: false, newName: '' }); }
        if (mode === 'folder' && !m.keep.tree) {
          m.keep.into = this.dmFolderInto();
          m.keep.tree = { loading: false, dirs: [], failed: false, naming: false, newName: '', braced: '' };
          this.dmIntoLoad();
        }
        if (mode === 'tags') { this.dmLoadFolderTags(m.gen); }
        this.dmLandHold();
      },
      dmLandHold: function () {
        this.$nextTick(() => {
          const root = this.$refs.dmodal;
          const at = document.activeElement;
          if (!root || typeof root.querySelector !== 'function' || (at && at !== document.body && root.contains(at))) { return; }
          const radio = root.querySelector('.dm-land-radio:checked');
          if (radio && radio.focus) { radio.focus(); }
        });
      },
      // The landing a start sends (DISCOVERJOBS.folderLanding): none as on
      // the peer, { vpath, path } into a folder, { tags: true }.
      dmFolderLandingSent: function () {
        const m = this.discover.modal;
        return DISCOVERJOBS.folderLanding(m.keep.landing, m.keep.landing === 'folder' ? this.dmFolderInto() : null);
      },
      // "Into a folder…"'s place: the one chosen, else the first — a new
      // folder named as the pressed one in the saved library ("copies ›
      // Borrowed Tapes"), so the folder keeps its name unless the user goes
      // elsewhere. → { vpath, path }
      dmFolderInto: function () {
        const m = this.discover.modal;
        if (m.keep.into) { return m.keep.into; }
        const v = this.discover.dest.view;
        const f = this.dmFolder();
        return DISCOVERJOBS.folderIntoDefault((v && v.destination) || null, f ? f.path : '');
      },
      // Whether the chosen landing has a place the copy can take: a folder
      // name a layout would read as a variable is refused here as the
      // editor refuses it (the place's own — a name being typed is not the
      // place yet), and so is a path the server would not place.
      dmFolderPlaceOk: function () {
        const m = this.discover.modal;
        if (m.keep.landing === 'folder' && DISCOVERJOBS.bracedFolder(this.dmFolderInto().path) !== null) { return false; }
        const p = this.dmDestPath('folder');
        return !!p && p.valid !== false;
      },
      // The cap line (SPEC-fed §6.5.4): once counted, a folder of more songs
      // than one copy takes here (the plug-in listing's maxFolderSongs; an
      // older server says none, and its job's failure says it). '' else.
      dmFolderCap: function () {
        const scan = this.discover.modal.folderScan;
        const cap = this.discover.plugins.maxFolderSongs;
        const f = this.dmFolder();
        if (!f || !cap || !scan || scan.state !== 'done' || scan.songs <= cap) { return ''; }
        return this.tt('discover.keep.folderCap', { name: f.name, count: DISCOVERJOBS.fmtCount(scan.songs), cap: DISCOVERJOBS.fmtCount(cap) });
      },
      // A folder copy that failed for the cap (the server's words name the
      // limit): starting it again would fail the same way.
      dmFolderCapFailed: function (job) {
        return !!job && job.state === 'failed' && /\(the limit is \d+/.test(String(job.error || ''));
      },
      // Where a finished copy's files are (the In line, Show in your
      // library): a folder copy's landing as its result names it, once a
      // song landed there — else, as for every copy, the folder its files
      // share (DISCOVERJOBS.landedPath: by the layout, or all already
      // yours, elsewhere). → { vpath, dirs, file } or null
      dmJobLanded: function (job) {
        const res = (job && job.result && typeof job.result === 'object') ? job.result : null;
        const at = res && res.folder && typeof res.folder.landed === 'string' ? DISCOVERJOBS.pathCrumbs(res.folder.landed) : [];
        const copied = res && (res.songs || res.counts) ? DISCOVERJOBS.manyCounts(res).copied : 0;
        if (DISCOVERJOBS.jobScope(job) === 'folder' && at.length && copied > 0) { return { vpath: at[0], dirs: at.slice(1), file: null }; }
        return DISCOVERJOBS.landedPath(res);
      },
      // ── "Into a folder…": the libraries and this server's folders ──────
      // The chosen place's folders, one level (the file explorer's own
      // listing): a row goes in and chooses it, Up chooses the folder
      // above, "New folder…" names one under it (nothing is made on disk:
      // the first file makes it). A place not there yet lists nothing and
      // says so. A name with a brace is refused as the editor refuses it.
      // A place not known to be there (`there`: a listed row, the folder
      // above one that is) is looked for in the folder above first — the
      // first place is meant not to exist yet, and listing it would only
      // be refused (a 404 the browser logs as an error).
      dmIntoLoad: async function (there) {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        const into = this.dmFolderInto();
        if (!tree || !into.vpath) { return; }
        const asked = `${into.vpath}/${into.path}`;
        tree.loading = true;
        let dirs = [];
        let failed = false;
        const listing = async (path) => {
          const res = await MSTREAMAPI.dirparser('/' + into.vpath + (path ? '/' + path : ''));
          return ((res && res.directories) || []).map((d) => d.name).filter(Boolean);
        };
        try {
          const crumbs = DISCOVERJOBS.pathCrumbs(into.path);
          const found = there === true || !crumbs.length || (await listing(crumbs.slice(0, -1).join('/'))).indexOf(crumbs[crumbs.length - 1]) !== -1;
          if (found) { dirs = await listing(into.path); } else { failed = true; }
        } catch (_) { failed = true; }
        const now = this.dmFolderInto();
        if (this.discover.modal !== m || m.keep.tree !== tree || `${now.vpath}/${now.path}` !== asked) { return; }   // moved on meanwhile
        tree.loading = false;
        tree.dirs = dirs;
        tree.failed = failed;
      },
      // The list's head: the chosen place as crumbs, the library first.
      dmIntoCrumbs: function () {
        const into = this.dmFolderInto();
        return [into.vpath || ''].concat(DISCOVERJOBS.pathCrumbs(into.path));
      },
      // The libraries the account may add files to (the destination view's),
      // each its own chip; the chosen one when the server no longer lists it.
      dmIntoLibraries: function () {
        const names = this.dmPickerLibraries().map((l) => l.vpath);
        const into = this.dmFolderInto();
        return into.vpath && names.indexOf(into.vpath) === -1 ? names.concat(into.vpath) : names;
      },
      // A library chip: the list moves into it, the place the first one
      // there — the pressed folder's name at its root.
      dmIntoLibrary: function (vpath) {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        if (!tree) { return; }
        const f = this.dmFolder();
        m.keep.into = DISCOVERJOBS.folderIntoDefault({ vpath }, f ? f.path : '');
        Object.assign(tree, { naming: false, newName: '', braced: '' });
        this.dmIntoLoad();
      },
      dmIntoInto: function (name, fresh) {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        if (!tree) { return; }
        const folder = DISCOVERJOBS.sanitizeSegment(name);
        if (DISCOVERJOBS.bracedFolder(folder) !== null) { tree.braced = folder; return; }
        const into = this.dmFolderInto();
        m.keep.into = { vpath: into.vpath, path: [into.path, folder].filter(Boolean).join('/') };
        Object.assign(tree, { naming: false, newName: '', braced: '' });
        this.dmDestFocus('tree');
        // a folder the user just named is known not to exist: nothing to
        // list; one listed is there
        if (fresh) { Object.assign(tree, { loading: false, dirs: [], failed: true }); return; }
        this.dmIntoLoad(true);
      },
      dmIntoUp: function () {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        if (!tree) { return; }
        const into = this.dmFolderInto();
        const parts = DISCOVERJOBS.pathCrumbs(into.path);
        parts.pop();
        // the folder above one that is there is there too
        const there = !tree.loading && !tree.failed;
        m.keep.into = { vpath: into.vpath, path: parts.join('/') };
        tree.braced = '';
        this.dmDestFocus('tree');
        this.dmIntoLoad(there);
      },
      // "New folder…": a name field, the pressed folder's name in it, all of
      // it selected; Add (or Enter) goes into it. A name with a brace keeps
      // Add dimmed, and says why.
      dmIntoNewFolder: function () {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        if (!tree) { return; }
        if (!tree.naming) {
          const f = this.dmFolder();
          Object.assign(tree, { naming: true, newName: f ? f.name : '', braced: '' });
          this.$nextTick(() => {
            const el = this.$refs.dmIntoName;
            if (el && el.focus) { el.focus(); if (el.select) { el.select(); } }
          });
          return;
        }
        const name = DISCOVERJOBS.sanitizeSegment(tree.newName);
        if (!name || DISCOVERJOBS.bracedFolder(name) !== null) { return; }
        this.dmIntoInto(name, tree.dirs.indexOf(name) === -1);
      },
      // Esc in the name field: no new folder; the keyboard back on "New
      // folder…".
      dmIntoNaming: function (on) {
        const tree = this.discover.modal.keep.tree;
        if (!tree || on) { return; }
        Object.assign(tree, { naming: false, newName: '' });
        this.$nextTick(() => {
          const win = this.$refs.dmodal;
          const el = win && typeof win.querySelector === 'function' ? win.querySelector('[data-dm-newfolder]') : null;
          if (el && el.focus) { el.focus(); }
        });
      },
      // The folder name with a brace in it the list says so of: one being
      // typed, one pressed, else the chosen place's own (the first place
      // keeps the pressed folder's name as it is). null for none.
      dmIntoBraced: function () {
        const m = this.discover.modal;
        const tree = m.keep.tree;
        if (tree && tree.naming) { return DISCOVERJOBS.bracedFolder(DISCOVERJOBS.sanitizeSegment(tree.newName)); }
        if (tree && tree.braced) { return tree.braced; }
        return DISCOVERJOBS.bracedFolder(this.dmFolderInto().path);
      },
      // The chosen place does not exist yet (its listing found nothing
      // there): the first file creates it. Never the library itself.
      dmIntoMissing: function () {
        const tree = this.discover.modal.keep.tree;
        return !!(tree && !tree.loading && tree.failed && this.dmFolderInto().path);
      },
      // The foot of the mirror's place: "Its path inside "music" on Stage
      // Peer B" — the peer's library, the folder's first segment.
      dmMirrorFoot: function () {
        const m = this.discover.modal;
        const f = this.dmFolder();
        const library = f ? DISCOVERJOBS.normalizePeerPath(f.path).split('/')[0] : '';
        const peer = (m.peer && m.peer.name) || (m.track && m.track.peer && m.track.peer.name) || '';
        return this.tt('discover.keep.landing.mirrorFoot', { library, peer });
      },
      // "Its files go straight into From Sam, with no "Borrowed Tapes"
      // folder of their own." — into a folder not named as the pressed one.
      dmIntoStraight: function () {
        const p = this.dmDestPath('folder');
        return p && p.straightIn ? this.tt(p.straightIn.key, p.straightIn.params) : '';
      },
      // What Keep a copy's one live region says (SPEC §7.5). The region is
      // in the section from the moment it shows, before anything happened,
      // so the first change is heard too (a region that comes in with its
      // words is not read): a state's status — its headline while it runs
      // (never the %: that is the bar's), headline and sub once it is over
      // — a refused start's line, a lost right's line; nothing idle.
      dmKeepAnnounce: function () {
        const v = this.dmKeepView();
        if (!v) { return ''; }
        return v.kind === 'state' ? v.status : (v.line || '');
      },
      // "You can close this window — it keeps going": while a copy the card
      // or one of its segments shows is queued, copying or stopping.
      dmKeepHint: function () {
        const v = this.dmKeepView();
        return !!(v && v.live) || this.dmKeepSegments().some((seg) => seg.live);
      },
      // A right lost while the window was open (SPEC §8.2) — at open the
      // section is not there at all: 'upload' (the account may no longer
      // add files: the jobs route's 403 "Uploading Disabled", or the
      // destination read again found none), 'jobs' (another 403: it may
      // not start jobs), 'off' (404: the copy plug-in is gone); '' for none.
      dmKeepLost: function () {
        const m = this.discover.modal;
        if (m.source !== 'federation') { return ''; }
        const copy = DISCOVERJOBS.COPY_PLUGIN;
        for (const slot of Object.keys(m.jobRefusals || {})) {
          const r = m.jobRefusals[slot];
          if (!r || (slot !== copy && slot.indexOf(copy + '@') !== 0)) { continue; }
          if (r.status === 404) { return 'off'; }
          if (r.status === 403) { return r.error === 'Uploading Disabled' ? 'upload' : 'jobs'; }
        }
        return m.destLost && this.discoverAcquirePlugins().some((p) => p.name === copy) ? 'upload' : '';
      },
      // A Keep card's button, by its action's id (dmKeepView). A dimmed one
      // (a start in flight, a folder's Add with nowhere to land) does
      // nothing. Retry and Add again start the copy again as it was asked
      // for (a folder: where that one was to land).
      dmKeepAct: function (id) {
        const v = this.dmKeepView();
        const a = v && v.actions.find((x) => x.id === id);
        if (!a || a.busy || a.disabled) { return; }
        if (id === 'add' || id === 'tryAgain') { return this.dmKeepStart(v.scope); }
        if (id === 'retry' || id === 'addAgain') { return this.dmKeepStart(v.scope, v.job); }
        if (id === 'cancel' || id === 'cancelOther') { return this.dmKeepCancel(v.job); }
        if (id === 'play') { return this.dmKeepPlay(v); }
        if (id === 'queue') { return this.queueDiscoverFile(v.files[0]); }
        if (id === 'show') { return this.dmKeepShow(v); }
        if (id === 'change') { this.dmOpenPicker(); }
      },
      // Cancel — this server's copy, or another's ("Cancel that copy").
      dmKeepCancel: async function (job) {
        if (!job) { return; }
        discoverKeepPresses += 1;
        try { await this.cancelDiscoverJob(job); } finally { discoverKeepPresses -= 1; }
        this.dmKeepHold();
      },
      // Play your copy: the song next, now (as Play now does); an album's
      // files in place of the queue, the first one playing (as Play album
      // does). The window closes, as theirs do.
      dmKeepPlay: function (v) {
        if (!v.files.length) { return; }
        if (v.scope === 'song') {
          this.playDiscoverFile(v.files[0]);
        } else {
          mstreamModule.clearQueue();
          v.files.forEach((filepath, i) => { mstreamModule.addSongWizard(filepath, {}, true, undefined, false, i > 0); });
        }
        this.closeDiscoverModal();
      },
      // Show in your library: the file explorer (m.js), open on the folder
      // the copy's files share. The window closes, as View album's does.
      dmKeepShow: function (v) {
        if (!v.folder || typeof openFileExplorerAt !== 'function') { return; }
        this.closeDiscoverModal();
        openFileExplorerAt(v.folder);
      },
      // After a Keep action or a poll changed the card under the keyboard:
      // if focus fell out of the window (the button pressed went with its
      // state — Add → Cancel, Cancel → Add again), it goes to the button now
      // in its place — the card's rightmost action, else its Change…, else
      // the chosen segment — else to Close. Never <body>. `polled`: no one
      // pressed anything (a poll moved the card — another server's copy
      // started, a copy ended): the keyboard goes somewhere harmless, never
      // to a button that cancels a copy or plays and closes the window —
      // Change…, the chosen segment, the card's first other action, Close.
      dmKeepHold: function (polled) {
        this.$nextTick(() => {
          const root = this.$refs.dmodal;
          if (!root || typeof root.querySelector !== 'function') { return; }
          const at = document.activeElement;
          if (at && at !== document.body && root.contains(at)) { return; }
          const order = polled
            ? ['.dm-keep [data-dm-change]', '.dm-seg-input:checked', '.dm-land-radio:checked', '.dm-keep-acts .dm-btn:not([data-dm-act="cancel"]):not([data-dm-act="cancelOther"]):not([data-dm-act="play"])']
            : ['.dm-keep-acts .dm-btn:last-child', '.dm-keep [data-dm-change]', '.dm-seg-input:checked', '.dm-land-radio:checked'];
          for (const sel of order) {
            const el = root.querySelector(sel);
            if (el && typeof el.focus === 'function') { el.focus(); return; }
          }
          const close = this.$refs.dmodalClose;
          if (close && close.focus) { close.focus(); }
        });
      },
      dmAnyJobLive: function () {
        const jobs = this.discover.modal.jobs;
        return Object.keys(jobs).some((n) => DISCOVERJOBS.isLive(jobs[n]));
      },
      // A row's line: an i18n key with params, the server's own text, or
      // several of those joined (a many-song result's counts).
      dmText: function (part) {
        if (!part) { return ''; }
        if (Array.isArray(part.parts)) { return part.parts.map((p) => this.dmText(p)).filter(Boolean).join(' · '); }
        return part.key ? this.tt(part.key, part.params) : String(part.text || '');
      },
      dmErrorText: function (err) {
        const body = err && err.body;
        return (body && typeof body.error === 'string' && body.error) || this.tt('discover.job.requestFailed');
      },
      // What this account already did with the recommendation, and where
      // files go — both only when a row could use them; the destination
      // read again with every window (dmLoadDestination). A file row's song
      // asks for its folder too: a folder copy is keyed by the folder (the
      // song's own lookup names a folder key of the song's file, G27 — never
      // a folder). An answer for the song as it read before its tags came
      // (dmLoadBrowsedFacts asks again) is not this window's. Peer
      // Recommendations' window asks with the one-row batch lookup (plan
      // §3.6), then follows its live jobs by id (dmPeerJobsPoll).
      dmLoadJobs: async function (gen) {
        await this.ensureDiscoverPlugins();
        if (!this.dmLive(gen) || this.discoverAcquirePlugins().length === 0) { return; }
        const m = this.discover.modal;
        const track = m.track;
        const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
        const folderRec = !m.focus && m.folder ? this.dmFolderRecommendation() : null;
        const page = m.from === 'peerRecs';
        const [found, foundFolder] = await Promise.all([
          page ? settle(Promise.resolve(MSTREAMAPI.discoveryJobLookupBatch([this.dmRecommendation()])).then((r) => (r && Array.isArray(r.results) && r.results[0]) || null))
            : settle(MSTREAMAPI.discoveryJobLookup(this.dmRecommendation())),
          folderRec ? settle(MSTREAMAPI.discoveryJobLookup(folderRec)) : Promise.resolve(null),
          this.dmLoadDestination(gen),
        ]);
        if (!this.dmLive(gen) || m.track !== track) { return; }
        if (found) {
          m.recKey = found.key || null;
          m.recKeys = found.keys || null;
          m.jobs = DISCOVERJOBS.jobsBySlot(found.jobs);
        }
        if (folderRec) {
          const slot = DISCOVERJOBS.jobSlot(DISCOVERJOBS.COPY_PLUGIN, 'folder');
          const keys = (foundFolder && foundFolder.keys) || {};
          m.recKeys = Object.assign({}, m.recKeys || {}, { folder: keys.folder || null });
          const jobs = Object.assign({}, m.jobs);
          delete jobs[slot];
          const own = foundFolder ? DISCOVERJOBS.jobsBySlot(foundFolder.jobs)[slot] : null;
          if (own) { jobs[slot] = own; }
          m.jobs = jobs;
        }
        this.scheduleDiscoverJobsPoll();
        if (page) { this.dmPeerJobsPoll(gen); }
      },
      // Peer Recommendations' Get it…: one chip per plug-in dmGetItRows
      // offers (an acquire plug-in other than the peer copy, an account
      // that may start jobs, a destination), titled by the plug-in alone.
      // A press starts the server's best match at once (no lookup card, no
      // bar); its job shows on the chip. → [{ plugin, state: idle | busy |
      // live | done | failed, icon, aria, press }]. A start refused because
      // the destination moved (409 destination_changed) is idle again: the
      // destination was read anew (dmDestRefused).
      dmGetItChips: function () {
        const m = this.discover.modal;
        return this.dmGetItRows().map(({ plugin, row }) => {
          const slot = DISCOVERJOBS.jobSlot(plugin.name);
          const refused = m.jobRefusals[slot];
          const moved = !!(refused && refused.status === 409 && refused.error === 'destination_changed');
          let state = 'idle';
          if (m.jobBusy[slot]) { state = 'busy'; }
          else if (row.live) { state = 'live'; }
          else if (m.jobErrors[slot] && !moved) { state = 'failed'; }
          else if (['downloaded', 'copied', 'copiedMany', 'owned', 'done'].indexOf(row.state) !== -1) { state = 'done'; }
          else if (['failed', 'stopped', 'exists'].indexOf(row.state) !== -1) { state = 'failed'; }
          const icon = state === 'live' ? row.icon : (state === 'done' ? 'check' : (state === 'failed' ? 'warn' : 'download'));
          const word = state === 'live' || state === 'done' ? this.tt(row.tag) : (state === 'failed' ? this.tt('discover.job.failed') : '');
          return { plugin, state, icon, aria: word ? `${plugin.title}: ${word}` : plugin.title, press: state === 'idle' || state === 'failed' };
        });
      },
      dmGetIt: async function (chip) {
        if (!chip || !chip.press) { return; }
        const gen = this.discover.modal.gen;
        await this.dmJobStart(chip.plugin, null);
        this.dmPeerJobsPoll(gen);
      },
      // Peer Recommendations' window follows its own live jobs by id, every
      // 1.5 s while it is open (plan §3.6); paused while the tab is hidden.
      dmPeerJobsPoll: function (gen) {
        if (discoverPeerJobsTimer) { clearTimeout(discoverPeerJobsTimer); discoverPeerJobsTimer = null; }
        const m = this.discover.modal;
        if (!this.dmLive(gen) || !this.dmPeerRecs() || !this.dmAnyJobLive()) { return; }
        discoverPeerJobsTimer = setTimeout(async () => {
          discoverPeerJobsTimer = null;
          if (!document.hidden) {
            for (const slot of Object.keys(m.jobs)) {
              const held = m.jobs[slot];
              if (!DISCOVERJOBS.isLive(held)) { continue; }
              let one = null;
              try { one = await MSTREAMAPI.discoveryJob(held.id); } catch (_) { one = null; }
              if (!this.dmLive(gen)) { return; }
              if (one && one.job && m.jobs[slot] === held) { this.$set(m.jobs, slot, one.job); }
            }
          }
          this.dmPeerJobsPoll(gen);
        }, 1500);
      },
      // `choice` = { url } picked from the plug-in's lookup; null = the plain
      // download (the plug-in searches); undefined (a Retry) = whatever the
      // lookup chose, if it did. `scope` = album | artist | artist-missing |
      // folder for the rows that act on more than the song; a folder's is
      // the folder's own recommendation, sent with where it lands
      // (`landing`, the wire shape: none = as on the peer). The start sends the
      // destination the window shows (dmDestShown): the job is pinned to
      // it, or — when it is no longer the saved one — refused with nothing
      // started, and the window reads the destination again and says so
      // (dmDestRefused) — under Get it, in words for its Download, not
      // Keep's Add. A refusal is kept as the server put it (jobRefusals: its
      // status, 0 = no answer, and its error) beside the line the window
      // shows (jobErrors).
      dmJobStart: async function (plugin, choice, scope, landing) {
        const name = plugin.name;
        const slot = DISCOVERJOBS.jobSlot(name, scope);
        const gen = this.discover.modal.gen;
        if (this.discover.modal.jobBusy[slot]) { return; }
        if (choice === undefined) {
          const l = this.discover.modal.lookups[name];
          choice = (l && l.status === 'ready' && l.chosen) ? { url: l.chosen } : null;
        }
        this.$set(this.discover.modal.jobBusy, slot, true);
        this.$delete(this.discover.modal.jobErrors, slot);
        this.$delete(this.discover.modal.jobRefusals, slot);
        try {
          const rec = scope === 'folder' ? this.dmFolderRecommendation() : this.dmRecommendation();
          const res = await MSTREAMAPI.discoveryJobStart(name, rec, choice || undefined, scope, this.dmDestShown(), scope === 'folder' ? landing || null : undefined);
          if (res && res.job) {
            this.noteDiscoverJob(res.job);
            if (this.dmLive(gen)) {
              this.$set(this.discover.modal.jobs, slot, res.job);
              if (!this.discover.modal.recKey && !scope) { this.discover.modal.recKey = res.job.key || null; }
              this.discover.modal.recKeys = Object.assign({}, this.discover.modal.recKeys || {}, { [scope || 'song']: res.job.key });
            }
          }
        } catch (err) {
          if (this.dmLive(gen)) {
            const body = err && err.body;
            this.$set(this.discover.modal.jobRefusals, slot, { status: Number(err && err.status) || 0, error: (body && typeof body.error === 'string') ? body.error : '' });
            // a right gone (403) or the plug-in gone (404): the pages' ways
            // in read their gate again (watchKeepGate)
            if (err && (err.status === 403 || err.status === 404)) { this.dmKeepGateChanged(); }
            const moved = this.dmDestRefused(err, gen) ? (name === DISCOVERJOBS.COPY_PLUGIN ? 'discover.modal.dest.changed' : 'discover.modal.dest.changedTryAgain') : '';
            this.$set(this.discover.modal.jobErrors, slot, moved ? this.tt(moved) : this.dmErrorText(err));
          }
        }
        if (this.dmLive(gen)) { this.$set(this.discover.modal.jobBusy, slot, false); }
        this.scheduleDiscoverJobsPoll();
      },
      // ── The lookup card ("what would Get it fetch?") ───────────────────
      // A plug-in with a lookup shows the card until a job exists for it.
      dmLookupRow: function (gr) {
        return DISCOVERJOBS.hasLookup(gr.plugin) && gr.row.state === 'idle';
      },
      dmLookupState: function (name) {
        return this.discover.modal.lookups[name] || { status: 'idle', query: this.dmSearchWords(), candidates: [], chosen: null, owned: null, error: '' };
      },
      // Ask the plug-in what it would fetch. Nothing is asked until the user
      // presses (a search is a request to YouTube from this server).
      dmLookup: async function (plugin) {
        const name = plugin.name;
        const gen = this.discover.modal.gen;
        const current = this.discover.modal.lookups[name];
        if (current && current.status === 'loading') { return; }
        const blank = { status: 'loading', query: this.dmSearchWords(), minScore: null, candidates: [], chosen: null, owned: null, error: '' };
        this.$set(this.discover.modal.lookups, name, blank);
        let res = null;
        try { res = await MSTREAMAPI.discoveryPluginResolve(name, this.dmRecommendation()); } catch (_) { res = null; }
        if (!this.dmLive(gen)) { return; }
        const answer = res && !res.disabled && res.result && res.result.lookup;
        if (!answer) {
          this.$set(this.discover.modal.lookups, name, { ...blank, status: 'error', error: (res && typeof res.error === 'string') ? res.error : '' });
          return;
        }
        const candidates = Array.isArray(answer.candidates) ? answer.candidates.filter((c) => c && c.url) : [];
        this.$set(this.discover.modal.lookups, name, {
          status: answer.owned ? 'owned' : (candidates.length ? 'ready' : 'none'),
          query: answer.query || this.dmSearchWords(), minScore: answer.minScore, candidates,
          chosen: candidates.length ? candidates[0].url : null, owned: answer.owned || null, error: '',
        });
      },
      dmLookupChoose: function (plugin, url) {
        const l = this.discover.modal.lookups[plugin.name];
        if (l && l.candidates.some((c) => c.url === url)) { l.chosen = url; }
      },
      dmJobCancel: async function (plugin, scope) {
        const job = this.discover.modal.jobs[DISCOVERJOBS.jobSlot(plugin.name, scope)];
        if (job) { await this.cancelDiscoverJob(job); }
      },
      dmJobPlay: function (plugin) {
        const row = this.dmJobRow(plugin.name);
        if (!row.filepath) { return; }
        this.playDiscoverFile(row.filepath);
        this.closeDiscoverModal();
      },
      dmJobQueue: function (plugin) {
        const row = this.dmJobRow(plugin.name);
        if (row.filepath) { this.queueDiscoverFile(row.filepath); }
      },
      // A finished download or copy is a library song: the wizard looks its
      // metadata up like any file-browser add.
      playDiscoverFile: function (filepath) {
        mstreamModule.addSongWizard(filepath, {}, true, MSTREAMPLAYER.positionCache.val + 1);
      },
      queueDiscoverFile: function (filepath) {
        mstreamModule.addSongWizard(filepath, {}, true, undefined, false, true);
        iziToast.success({ title: this.tt('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
      },
      cancelDiscoverJob: async function (job) {
        try {
          const res = await MSTREAMAPI.discoveryJobCancel(job.id);
          if (res && res.job) { this.noteDiscoverJob(res.job); }
        } catch (_) { /* 409: it finished first — the refresh below shows how */ }
        await this.refreshDiscoverJobs();
      },

      // ── Collection destination: the bar, the paths and the editor ──────
      // Where a copy or a download lands under the saved destination (the
      // bar, and a running copy's "Into" line), under the one being typed
      // (the editor's preview), and where a finished copy's files are (its
      // "In" line). The server renders the real path from each file's own
      // tags; this is the same engine (DISCOVERJOBS.scopeTarget) on what the
      // window knows, by the scope's rules — and where a variable is each
      // song's own and the window does not know the one value every song
      // files under, a slot ("‹artist›"), never a folder that will not exist.
      dmLayoutTags: function () {
        const m = this.discover.modal;
        const t = m.track || {};
        const md = m.file && m.file.metadata;
        return {
          artist: (md && (md['artist-display'] || md.artist)) || t.artist || null,
          album: (md && md.album) || t.album || null,
          year: (md && md.year) || t.year || null,
          // the one genre the peer's metadata names; two or more are a tag
          // the library split ("Hip-Hop/Rap"), filed as written: unknown
          genre: DISCOVERJOBS.songGenre(md),
          // the album's credit (a connected server's row names it): the
          // server renders {{ALBUMARTIST}} from the file's own tag, else the
          // album's credit the job knows (destination.js tagsForLayout), so
          // a compilation previews "Various Artists/…", where it lands
          albumartist: (md && (md['album-artist'] || md.albumartist)) || t.albumArtist || null,
          // {{SERVERFOLDER}}: the folder the song sits in on its server, its
          // library's name dropped (federation-copy serverFolderOf); a row
          // that is not a connected server's has none, so it drops out (a
          // download's path drops it on any row: dmScopeTags' `from`)
          serverfolder: m.source === 'federation' ? DISCOVERJOBS.serverFolderOf(t.filepath) : null,
        };
      },
      // The tags a scope's copy renders the layout with, and the variables
      // it draws as slots (DISCOVERJOBS.scopeTags): the song's own for the
      // song ({{GENRE}} a slot until the peer's metadata names its one
      // genre); for its album the song's, the album's credit as ALBUMARTIST
      // (DISCOVERYPAGE.albumCreditOf: a compilation's "Various Artists",
      // else the row's artist — never a featured song's "feat." credit), and
      // {{ARTIST}}, {{YEAR}}, {{GENRE}} and {{SERVERFOLDER}} what every
      // song of the album's listing agrees on (dmLoadPeerFacts: each song's
      // own artist, year, genres and path), else slots — before the listing
      // answers, {{ARTIST}} and {{YEAR}} slots for a compilation only,
      // {{GENRE}} a slot, {{SERVERFOLDER}} the row's own folder. For the
      // artist scopes the track artist as ARTIST and ALBUMARTIST — never a
      // compilation's credit — no album, year or server folder: each album
      // has its own (scopeTarget's "one folder per album"), and {{GENRE}} a
      // slot.
      // (The server files a song without the tag under its album's credit
      // as the peer spells it, else this artist: only another spelling or
      // a joint credit, "Nova & Vosto", lands apart from this preview.)
      // `from` = where the files come from when it is not this row's
      // server (dmDestPath's): {{SERVERFOLDER}} then comes from the song's
      // path there, `from.filepath` — none for a download, which drops it.
      // This window lists only this row's server's songs, so another
      // server's album draws its ‹server folder› slot.
      // → { tags, slots }
      dmScopeTags: function (scope, from) {
        const m = this.discover.modal;
        // a folder's, "By your layout": its songs' own, as read (none past
        // FOLDER_TAGS_MAX songs, or unread: every tag variable a slot)
        if (scope === 'folder') {
          const read = m.folderTags;
          return DISCOVERJOBS.scopeTags({ scope, songs: read && read.state === 'done' ? read.songs : null });
        }
        const tags = this.dmLayoutTags();
        if (scope === 'artist' || scope === 'artist-missing') {
          const artist = (m.track && m.track.artist) || tags.artist;
          return DISCOVERJOBS.scopeTags({ scope, tags: { artist, albumartist: artist, album: null, year: null, genre: null, serverfolder: null } });
        }
        if (scope !== 'album') {
          const own = from ? Object.assign({}, tags, { serverfolder: DISCOVERJOBS.serverFolderOf(from.filepath) }) : tags;
          return DISCOVERJOBS.scopeTags({ scope: 'song', tags: own });
        }
        const listed = m.album && Array.isArray(m.album.songs) ? m.album.songs : null;
        const credit = DISCOVERYPAGE.albumCreditOf(m.track);
        const st = DISCOVERJOBS.scopeTags({
          scope, tags: Object.assign({}, tags, { albumartist: tags.albumartist || credit }), compilation: this.dmKeepCompilation(),
          songs: listed ? listed.map((song) => DISCOVERJOBS.listedSongTags(song, credit)) : null,
        });
        if (from && st.slots.indexOf('SERVERFOLDER') === -1) { st.slots.push('SERVERFOLDER'); }
        return st;
      },
      // The album "Only the albums you don't have" copies when it is the one
      // ({ name, year }, from dmArtistOwnership): the path names it. null
      // for none, several, or a listing that did not answer.
      dmMissingAlbum: function () {
        const a = this.discover.modal.artist;
        return a && a.missing === 1 && a.missingOne ? a.missingOne : null;
      },
      dmLayoutFile: function () {
        const m = this.discover.modal;
        return (m.track && m.track.filepath) || 'track';
      },
      // A network row's download has no peer: {{PEER}} drops out of its path.
      dmLayoutPeer: function () {
        const m = this.discover.modal;
        return (m.source === 'federation' && m.track && m.track.peer && m.track.peer.name) || null;
      },
      // Where a copy of `scope` lands — the path bar's "Files go to", a
      // running copy's "Into": `destination` = the saved one unless given
      // (the one pinned on a job, the one it ran with); `from` = where the
      // files come from when it is not this row's server: { peer, filepath }
      // — the {{PEER}} it renders and the song's path there, its
      // {{SERVERFOLDER}} and its file (another server's copy: dmJobPath),
      // or both null for a download (Get it's bar), from no server: both
      // variables drop out. null without a destination.
      // → { library, crumbs: [{ text, kind, parts? }], file,
      // title, slotNote } for dm-dest-path (kind 'base' · 'rendered' ·
      // 'note', the note in words; `parts` a folder's text and its slots,
      // each { text, slot }, in words; `file` a song's alone; `slotNote` the
      // one line under a path with a slot in it, else ''), with the
      // engine's checks besides (valid, error, field, variable, missingVars;
      // `base`, the base folder as normalised; `slots`). A layout the engine
      // refuses draws the base folder. A folder lands by `landing` (the wire
      // shape: a job's params.landing; undefined = the one the landings
      // chose, dmFolderLandingSent): as on the peer — the library, the base
      // folder, the layout's leading folders that name no variable, then
      // the folder's own path inside the peer's library (server work S3) —
      // into a folder, or by the layout; its path also says `files`, the
      // first few of what lands there (DISCOVERJOBS.scopeTarget).
      dmDestPath: function (scope, destination, from, landing) {
        const v = this.discover.dest.view;
        const d = destination || (v && v.destination) || null;
        return d ? this.dmDestPathOf(d, scope, from, landing) : null;
      },
      dmDestPathOf: function (d, scope, from, landing) {
        const s = scope || 'song';
        const { tags, slots } = this.dmScopeTags(s, from);
        const f = s === 'folder' ? this.dmFolder() : null;
        const scan = this.discover.modal.folderScan;
        const p = DISCOVERJOBS.scopeTarget({
          vpath: d.vpath, base: d.base, layout: d.layout, scope: s, tags, slots,
          peerName: from ? from.peer : this.dmLayoutPeer(), fileName: (from && from.filepath) || this.dmLayoutFile(),
          oneAlbum: s === 'artist-missing' ? this.dmMissingAlbum() : null,
          landing: s === 'folder' ? (landing === undefined ? this.dmFolderLandingSent() : landing) : undefined,
          folder: f ? f.path : undefined,
          songs: s === 'folder' && scan && scan.state === 'done' ? scan.paths : null,
        });
        const crumbs = (p.valid ? p.crumbs : DISCOVERJOBS.pathCrumbs(DISCOVERJOBS.normalizeBase(d.base).base).map((text) => ({ text, kind: 'base' }))).map((c) => {
          if (c.key) { return { text: this.tt(c.key), kind: c.kind }; }
          if (!c.parts) { return c; }
          const parts = c.parts.map((x) => (x.slot ? { text: this.tt(x.key), slot: true } : { text: x.text, slot: false }));
          return { text: parts.map((x) => x.text).join(''), kind: c.kind, parts };
        });
        // into a folder: the library chosen for it, not the destination's
        const library = (s === 'folder' && p.library) || d.vpath;
        return Object.assign({}, p, {
          library,
          crumbs,
          title: [library].concat(crumbs.filter((c) => c.kind !== 'note').map((c) => c.text)).join('/'),
          slotNote: this.dmSlotNote(s, p.valid ? p.slots : []),
        });
      },
      // "‹artist›, ‹genre› come from each song's own tags…": the one note
      // under a path with slots in it (`slots`: the ones it shows, in its
      // order) — a song's own words for a song. A ‹server folder› comes
      // from where each song sits on the server, said after the tags' words
      // ("‹artist› comes from each song's own tags and ‹server folder› from
      // where it sits on the server, …"). '' with none.
      dmSlotNote: function (scope, slots) {
        const say = (vars) => vars.map((v) => this.tt('discover.modal.dest.slot.' + v.toLowerCase())).join(', ');
        const tags = (slots || []).filter((v) => v !== 'SERVERFOLDER');
        const server = (slots || []).indexOf('SERVERFOLDER') !== -1 ? say(['SERVERFOLDER']) : '';
        if (!tags.length) { return server ? this.tt('discover.modal.dest.slotNoteServer', { slot: server }) : ''; }
        const note = scope === 'song' && !server ? 'discover.modal.dest.slotNoteSong'
          : 'discover.modal.dest.slotNote' + (tags.indexOf('GENRE') !== -1 ? 'Genre' : '') + (server ? 'AndServer' : '');
        return this.tt(note, { slots: say(tags), slot: server, count: tags.length });
      },
      // The path line inside a copy's states, or null: "Into" while the job
      // is queued or running — the destination pinned on it at start
      // (params.destination; a job from before the pin: the saved one now;
      // one pinned to nowhere — null, there was nowhere to put a file —
      // goes nowhere, and says nothing), by the job's scope — and "In"
      // once it ended: where its files are
      // (DISCOVERJOBS.landedPath), else, when its result lists none, the
      // destination it ran with, drawn the same way. Nothing landed (failed,
      // cancelled before a song, refused, nothing to copy): null. Another
      // server's copy (dmJobOtherPeer) is drawn from its own recommendation:
      // that server's name, and its song's folder and file there. A folder
      // copy lands by its own landing (params.landing, whatever the
      // landings now say: G20), and once it did, where its result says
      // (dmJobLanded).
      // → { kind: 'into' | 'in', prefix: the words, path: as dmDestPath's }.
      dmJobPath: function (job) {
        if (!job) { return null; }
        const scope = DISCOVERJOBS.jobScope(job);
        const rec = job.recommendation || {};
        const from = this.dmJobOtherPeer(job) ? { peer: (rec.peer && rec.peer.name) || null, filepath: rec.filepath || null } : null;
        const line = (kind, path) => (path ? { kind, prefix: this.tt('discover.modal.dest.' + kind), path } : null);
        const landing = scope === 'folder' ? (job.params && job.params.landing) || null : undefined;
        if (DISCOVERJOBS.isLive(job)) {
          const pinned = job.params && typeof job.params === 'object' && 'destination' in job.params;
          if (pinned && !job.params.destination) { return null; }
          return line('into', this.dmDestPath(scope, pinned ? job.params.destination : null, from, landing));
        }
        const landed = this.dmJobLanded(job);
        if (!landed) { return null; }
        if (!landed.vpath) { return line('in', job.result.destination ? this.dmDestPath(scope, job.result.destination, from, landing) : null); }
        return line('in', {
          library: landed.vpath, crumbs: landed.dirs.map((text) => ({ text, kind: 'landed' })), file: landed.file,
          title: [landed.vpath].concat(landed.dirs).join('/'),
        });
      },
      // Whether the saved destination is no longer the one a job ran with
      // (its result's, else the one pinned on it): a Skipped copy's Retry
      // would land somewhere new, and a Retry or Add again says where.
      dmDestMoved: function (job) {
        const ran = (job && job.result && job.result.destination) || (job && job.params && job.params.destination) || null;
        const now = this.discover.dest.view && this.discover.dest.view.destination;
        return !!(ran && now) && !DISCOVERJOBS.sameDestination(ran, now);
      },
      // The destination the window shows, as a start sends it (the jobs
      // route refuses one that is no longer in force); undefined = none
      // shown, nothing to check.
      dmDestShown: function () {
        const d = this.discover.dest.view && this.discover.dest.view.destination;
        return d ? { vpath: d.vpath, base: d.base || '', layout: d.layout } : undefined;
      },
      // The destination view, read again with every window that could use
      // it, and after a start refused for a changed one: the bar draws the
      // last one known meanwhile and takes the answer when it comes — no
      // spinner; a failed read keeps what is drawn. A read that finds no
      // destination any more after this window had one is a right lost
      // while it was open (destLost: the Keep card's plain line), not one
      // it opened without.
      dmLoadDestination: async function (gen) {
        const host = MSTREAMAPI.currentServer.host;
        const saves = this.discover.dest.saves;
        let view = null;
        try { view = await MSTREAMAPI.discoveryDestination(); } catch (_) { view = null; }
        if (!view || host !== MSTREAMAPI.currentServer.host) { return; }   // nothing new, or the app moved to another server meanwhile
        if (this.discover.dest.saves !== saves) { return; }   // a save answered meanwhile: its view is newer than this one
        const had = this.dmHasDestination();
        this.discover.dest.view = view;
        if (!this.dmLive(gen)) { return; }
        const m = this.discover.modal;
        if (m.destRead && had && !view.destination) { m.destLost = true; this.dmHoldFocus(); }
        m.destRead = true;
      },
      // A start the jobs route refused with 409 "destination_changed": the
      // saved destination is no longer the one the window showed (another
      // tab or client saved one since). Nothing was started; the bar
      // redraws at once from the answer's own destination and the whole view
      // is read again. One that says there is nowhere now, after the user
      // pressed Add on the place the bar showed, is a right lost while the
      // window was open — even before the window's own read answered (the
      // bar draws the last one known until then). → whether it was that
      // refusal.
      dmDestRefused: function (err, gen) {
        const body = err && err.status === 409 ? err.body : null;
        if (!body || body.error !== 'destination_changed') { return false; }
        const v = this.discover.dest.view;
        if (v && 'destination' in body) {
          if (!body.destination && v.destination) { this.discover.modal.destLost = true; this.dmHoldFocus(); }
          this.discover.dest.view = Object.assign({}, v, { destination: body.destination || null });
        }
        this.dmLoadDestination(gen);
        return true;
      },
      // Change…: the editor, on the saved destination — and the
      // destination read again (another tab or device may have saved one
      // since): its answer is taken while nothing was edited
      // (dmPickerSync). The editor's state: `vpath` the library chosen,
      // `layout` the preset chosen, `custom` Custom chosen (its field's
      // `text` is the layout then; what was typed stays there while a
      // preset is chosen), `before` Custom's text before a library's own
      // layout moved into it, `from` the destination it opened on; `reset`
      // = "Use the library default" was pressed (Save then goes back to the
      // default); `download` = opened from Get it's bar (the saved toast
      // says files, not copies).
      dmOpenPicker: function (download) {
        const m = this.discover.modal;
        const d = this.discover.dest.view && this.discover.dest.view.destination;
        if (!d) { return; }
        const k = { vpath: '', layout: '', custom: false, text: '', before: null, from: null, browse: null, saving: false, error: '', reset: false, download: !!download };
        this.dmPickerFill(k, d);
        m.picker = k;
        // The editor opens in the bar's place; dm-dest scrolls it into view
        // and puts the keyboard on its first field.
        const gen = m.gen;
        this.dmLoadDestination(gen).then(() => { if (this.dmLive(gen) && m.picker === k) { this.dmPickerSync(); } });
      },
      // The editor takes a destination. A base folder set elsewhere (the
      // terminal keeps one) comes in front of the layout
      // (DISCOVERJOBS.foldBase: the files land in the same place) and is
      // saved as part of it; a layout that is none of the presets opens in
      // Custom's field, and so does one with a base folder in front —
      // never a preset, even when the whole of it reads as one.
      dmPickerFill: function (k, d) {
        const layout = DISCOVERJOBS.foldBase(d.base, d.layout);
        k.from = { vpath: d.vpath, base: d.base || '', layout: d.layout };
        k.vpath = d.vpath;
        k.layout = layout;
        k.custom = layout !== d.layout || !this.dmPickerIsPreset(d.vpath, layout);
        if (k.custom) { k.text = layout; }
      },
      // The destination read again while the editor is open: taken when it
      // moved and nothing was edited (an edit is kept: Save or Cancel
      // settles it). None any more: nothing to edit.
      dmPickerSync: function () {
        const m = this.discover.modal;
        const k = m.picker;
        const d = this.discover.dest.view && this.discover.dest.view.destination;
        if (!k || k.saving) { return; }
        if (!d) { m.picker = null; this.dmHoldFocus(); return; }
        const f = k.from;
        if (f.vpath === d.vpath && f.base === (d.base || '') && f.layout === d.layout) { return; }
        if (this.dmPickerDirty()) { return; }
        this.dmPickerFill(k, d);
      },
      // Whether the editor is open — it takes the place of the card's
      // action row while it is.
      dmDestEditing: function () {
        return !!this.discover.modal.picker;
      },
      // What an acquire plug-in searches for, as the idle row says it.
      dmSearchWords: function () {
        const t = this.discover.modal.track || {};
        return [t.artist, t.title].filter(Boolean).join(' ');
      },
      // Cancel (and Esc): nothing saved; the keyboard back on Change….
      dmClosePicker: function () {
        this.discover.modal.picker = null;
        this.dmDestFocus('change');
      },
      // Where the keyboard goes when the editor changed under it, so focus
      // never drops to <body>: 'change' — Change…, the bar's or a state's
      // own (any control carrying data-dm-change); 'browse' — the folders
      // toggle; 'first' — the editor's first field, the chosen library's
      // chip; 'tree' — the folder list's first row, only when the row
      // pressed went away.
      dmDestFocus: function (what) {
        this.$nextTick(() => {
          const win = this.$refs.dmodal || (typeof document.querySelector === 'function' ? document.querySelector('.dmodal') : null);
          if (!win) { return; }
          const now = document.activeElement;
          if (what === 'tree' && now && now !== document.body && win.contains(now)) { return; }
          const el = win.querySelector({ change: '[data-dm-change]', browse: '[data-dm-browse]', first: '.dm-dest-chip[aria-pressed="true"]', tree: '.dm-dest-tree button' }[what] || null);
          if (el && el.focus) { el.focus(); }
        });
      },
      dmPickerLibraries: function () {
        const v = this.discover.dest.view;
        return (v && v.libraries) || [];
      },
      // The library chips: every library the account may add files to, and
      // the chosen one when the server no longer lists it.
      dmPickerChips: function () {
        const k = this.discover.modal.picker;
        const names = this.dmPickerLibraries().map((l) => l.vpath);
        return k && names.indexOf(k.vpath) === -1 ? names.concat(k.vpath) : names;
      },
      dmPickerVars: function () {
        const v = this.discover.dest.view;
        return (v && v.variables) || DISCOVERJOBS.LAYOUT_VARS;
      },
      // A variable button's name for a screen reader ("Insert artist"),
      // with the name it shows when the words do not already say it
      // ("Insert album artist, ALBUMARTIST"): Voice Control finds a button
      // by what it shows. One the server adds later reads by its own name.
      dmPickerVarLabel: function (name) {
        const words = DISCOVERJOBS.LAYOUT_VARS.indexOf(name) !== -1
          ? this.tt('discover.modal.dest.insert.' + name.toLowerCase())
          : this.tt('discover.modal.dest.insertVar', { name });
        return words.toLowerCase().indexOf(name.toLowerCase()) !== -1 ? words : `${words}, ${name}`;
      },
      // The layouts offered for `vpath`'s library (the chosen one by
      // default), in order: Artist / Album (the server's default, by the
      // album's credit), Server / Artist / Album, Same folders as the
      // server (where the server lists {{SERVERFOLDER}}: an older one would
      // refuse it), then the library's own Path Template when it has one
      // that is none of them. Any other layout is Custom's.
      // → [{ key, layout }]
      dmPickerPresets: function (vpath) {
        const v = this.discover.dest.view;
        const k = this.discover.modal.picker;
        const lib = vpath || (k && k.vpath);
        const artistAlbum = v && typeof v.defaultLayout === 'string' && v.defaultLayout.trim() ? v.defaultLayout : DISCOVERJOBS.DEFAULT_LAYOUT;
        const own = this.dmPickerLibraries().find((l) => l.vpath === lib);
        const template = own && typeof own.template === 'string' && own.template.trim() ? own.template : null;
        const fixed = [artistAlbum, DISCOVERJOBS.PEER_LAYOUT, DISCOVERJOBS.SERVERFOLDER_LAYOUT];
        const out = [{ key: 'discover.modal.dest.preset.artistAlbum', layout: artistAlbum }];
        if (artistAlbum !== DISCOVERJOBS.PEER_LAYOUT) { out.push({ key: 'discover.modal.dest.preset.server', layout: DISCOVERJOBS.PEER_LAYOUT }); }
        if (artistAlbum !== DISCOVERJOBS.SERVERFOLDER_LAYOUT && this.dmPickerVars().indexOf('SERVERFOLDER') !== -1) {
          out.push({ key: 'discover.modal.dest.preset.serverFolders', layout: DISCOVERJOBS.SERVERFOLDER_LAYOUT });
        }
        if (template && fixed.indexOf(template) === -1) { out.push({ key: 'discover.modal.dest.preset.library', layout: template }); }
        return out;
      },
      dmPickerIsPreset: function (vpath, layout) {
        return this.dmPickerPresets(vpath).some((p) => p.layout === layout);
      },
      // The layout the editor holds: Custom's text while Custom is chosen,
      // else the chosen preset. It is saved with no base folder.
      dmPickerLayout: function () {
        const k = this.discover.modal.picker;
        return !k ? '' : (k.custom ? k.text : k.layout);
      },
      // Custom's field holds the layout as the editor opened it.
      dmPickerAsOpened: function () {
        const k = this.discover.modal.picker;
        return !!(k && k.from && k.custom) && k.text === DISCOVERJOBS.foldBase(k.from.base, k.from.layout);
      },
      // The folder of a base folder set elsewhere that Custom's field still
      // holds as it opened, when its name has a brace: a layout reads it as
      // a variable or refuses it, so saved as it is, the files would land
      // elsewhere. null when there is none.
      dmPickerHeldBraces: function () {
        const k = this.discover.modal.picker;
        return this.dmPickerAsOpened() ? DISCOVERJOBS.bracedFolder(k.from.base) : null;
      },
      // Whether the editor holds anything to save: another library or
      // layout than the one it opened on (a base folder set elsewhere,
      // folded into the layout as it opened, is no edit; a preset of the
      // same text over one whose name a layout reads as a variable is — the
      // server's name, not that folder), or "Use the library default"
      // pressed over a place saved for the account.
      dmPickerDirty: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.from) { return false; }
        const v = this.discover.dest.view;
        const saved = !!(v && v.destination && v.destination.source === 'user');
        return k.vpath !== k.from.vpath || this.dmPickerLayout() !== DISCOVERJOBS.foldBase(k.from.base, k.from.layout)
          || (!k.custom && DISCOVERJOBS.bracedFolder(k.from.base) !== null)
          || (k.reset && saved && this.dmPickerIsDefault());
      },
      // Save is on: something to save, a layout the server takes (Custom's
      // text empty or refused, or still holding a folder a layout cannot,
      // holds it), nothing out.
      dmPickerCanSave: function () {
        const k = this.discover.modal.picker;
        if (!k || k.saving || !this.dmPickerDirty()) { return false; }
        return DISCOVERJOBS.validateLayout(this.dmPickerLayout()).valid && !(k.custom && this.dmPickerHeldBraces());
      },
      // Custom's field: the validator's words as typed (none while it is
      // empty: the preview asks for a path), or the folder it still holds
      // as it opened that a layout reads as a variable. '' when it is fine.
      dmPickerCustomProblem: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.custom || !k.text) { return ''; }
        const check = DISCOVERJOBS.validateLayout(k.text);
        if (!check.valid) { return this.dmPickerProblem(check); }
        const held = this.dmPickerHeldBraces();
        return held ? this.tt('discover.modal.dest.errBaseBraces', { folder: held }) : '';
      },
      // A layout radio: a preset. What Custom's field holds stays in it.
      dmPickerChoose: function (layout) {
        const k = this.discover.modal.picker;
        if (!k || k.saving) { return; }
        k.layout = layout;
        k.custom = false;
        k.error = '';
      },
      // The Custom radio: its field, empty until something is typed (or
      // what was typed before).
      dmPickerChooseCustom: function () {
        const k = this.discover.modal.picker;
        if (!k || k.saving) { return; }
        k.custom = true;
        k.error = '';
      },
      // Custom's field typed in: a refusal under the layout goes.
      dmPickerTyped: function () {
        const k = this.discover.modal.picker;
        if (k) { k.error = ''; }
      },
      // A library chip. A library's own layout (its Path Template) that
      // leaves with it stays the layout, in Custom's field; back in that
      // library with it untouched, its preset again and Custom's field as
      // it was (never over a base folder a layout reads as a variable).
      dmPickerLibrary: function (vpath) {
        const k = this.discover.modal.picker;
        if (!k || k.saving) { return; }
        const layout = k.layout;
        k.vpath = vpath;
        if (!k.custom && !this.dmPickerIsPreset(vpath, layout)) {
          k.before = k.text;
          k.custom = true;
          k.text = layout;
        } else if (k.custom && k.text === layout && !this.dmPickerHeldBraces() && this.dmPickerIsPreset(vpath, layout)) {
          k.custom = false;
          k.text = k.before === null ? k.text : k.before;
          k.before = null;
        }
        k.error = '';
        if (k.browse) { this.dmBrowseAnchor(); }
      },
      // The editor's preview: the layout the editor holds, by the scope the
      // window has chosen (dmDestPath's answer; `from` as there: Get it's
      // editor draws a download), with no base folder — but the layout as
      // it opened is drawn as the server holds it, its base folder and
      // all, so a folder set elsewhere reads as the bar reads it, whatever
      // a layout would make of its name.
      dmPickerPreview: function (scope, from) {
        const k = this.discover.modal.picker;
        if (!k) { return null; }
        const opened = this.dmPickerAsOpened() ? k.from : null;
        return this.dmDestPathOf({ vpath: k.vpath, base: opened ? opened.base : '', layout: opened ? opened.layout : this.dmPickerLayout() }, scope, from);
      },
      // Why the preview draws no path, or null: Custom's field is empty, the
      // layout would be refused, or this item's path is longer than the
      // server takes (no fault of the layout's: Save takes it) — the song's,
      // in the phone's words, when the preview draws the song (`scope`).
      // → { text, warn }
      dmPickerUnseen: function (preview, scope) {
        const k = this.discover.modal.picker;
        if (k && k.custom && !k.text) { return { text: this.tt('discover.modal.dest.customEmpty'), warn: false }; }
        if (!preview || preview.valid) { return null; }
        if (preview.error !== 'path_too_long') { return { text: this.tt('discover.modal.dest.fixLayout'), warn: true }; }
        const key = (scope || 'song') === 'song' ? 'discover.modal.dest.tooLongSong' : 'discover.modal.dest.tooLong';
        return { text: this.tt(key, { max: DISCOVERJOBS.MAX_RESOLVED_LEN }), warn: true };
      },
      // The preview's first line, what lands there: the song by its title,
      // the album, every album of the artist, the albums the library lacks
      // (the one it lacks by name), or the folder.
      dmPickerLandsAt: function (scope) {
        const t = this.discover.modal.track || {};
        if (scope === 'folder') { return this.tt('discover.modal.dest.landsAt', { title: (this.dmFolder() || {}).name || '' }); }
        if (scope === 'album') { return this.tt('discover.modal.dest.landsAt', { title: t.album || '' }); }
        if (scope === 'artist') { return this.tt('discover.modal.dest.landsAtArtist', { artist: t.artist || '' }); }
        if (scope === 'artist-missing') {
          const one = this.dmMissingAlbum();
          return one ? this.tt('discover.modal.dest.landsAt', { title: one.name }) : this.tt('discover.modal.dest.landsAtMissing');
        }
        return this.tt('discover.modal.dest.landsAt', { title: t.title || DISCOVERJOBS.safeFileName(this.dmLayoutFile()) });
      },
      // The preview's note for a variable with no value for this item: it
      // is left out of the path, named in its braces as the phone names it
      // ("No value for this song, so left out of the path: {{YEAR}}").
      // {{PEER}} and {{SERVERFOLDER}} are not tags but the server a song
      // comes from: a download (`from` with no path) comes from none, and a
      // song at the top of its server's library sits in no folder there —
      // the tags' words are for tags.
      dmPickerMissing: function (preview, from) {
        const vars = (preview && preview.missingVars) || [];
        const words = { vars: vars.map((v) => this.dmVarToken(v)).join(', ') };
        if (from && !from.filepath && vars.length && vars.every((v) => v === 'PEER' || v === 'SERVERFOLDER')) {
          return this.tt('discover.modal.dest.missingDownload', words);
        }
        if (vars.length === 1 && vars[0] === 'SERVERFOLDER') { return this.tt('discover.modal.dest.missingServer', words); }
        return this.tt('discover.modal.dest.missing', words);
      },
      // The validator's refusal in words (the server's codes, one table); an
      // unknown variable named as it was typed ("{{ Artst }}"), in its braces.
      dmPickerProblem: function (check) {
        if (!check || check.valid) { return ''; }
        if (check.error === 'unknown_variable') {
          const name = check.token || (check.variable ? this.dmVarToken(check.variable) : '');
          return this.tt('discover.modal.dest.errUnknownVar', { name, vars: this.dmPickerVars().join(', ') });
        }
        const code = { absolute_path: 'absolute_template', drive_letter_segment: 'drive_letter' }[check.error] || check.error;
        const known = ['unbalanced_braces', 'absolute_template', 'traversal', 'empty_path', 'home_string', 'drive_letter', 'template_too_long', 'invalid_chars'];
        return known.indexOf(code) !== -1
          ? this.tt('discover.modal.dest.err.' + code, { example: this.dmVarToken('ARTIST'), max: DISCOVERJOBS.MAX_TEMPLATE_LEN })
          : this.tt('discover.modal.dest.errGeneric');
      },
      dmVarToken: function (name) {
        return '{' + '{' + name + '}' + '}';
      },
      // A variable button has room left for its token in Custom's field
      // (the field's own limit sees only the keyboard).
      dmPickerVarFits: function (name) {
        const k = this.discover.modal.picker;
        return !!k && k.text.length + this.dmVarToken(name).length <= DISCOVERJOBS.MAX_TEMPLATE_LEN;
      },
      // A variable button drops {{VAR}} where the caret is in Custom's
      // field, over the selection (`input` is the field, handed over by
      // the dm-dest editor), the caret after it.
      dmInsertVar: function (name, input) {
        const k = this.discover.modal.picker;
        if (!k || k.saving || !this.dmPickerVarFits(name)) { return; }
        const token = this.dmVarToken(name);
        const el = input || null;
        const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : k.text.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
        k.text = k.text.slice(0, at) + token + k.text.slice(end);
        k.error = '';
        this.$nextTick(() => {
          if (!el || !el.focus) { return; }
          el.focus();
          try { el.setSelectionRange(at + token.length, at + token.length); } catch (_) { /* not a text input */ }
        });
      },
      // The library default — what the account has with nothing saved
      // (destination.js destinationFor): the first library it may write
      // to, at its root, under that library's Path Template or the server's
      // default layout. null without a library.
      dmDestDefault: function () {
        const v = this.discover.dest.view;
        const lib = v && Array.isArray(v.libraries) ? v.libraries[0] : null;
        return lib ? { vpath: lib.vpath, base: '', layout: lib.template || v.defaultLayout || DISCOVERJOBS.DEFAULT_LAYOUT } : null;
      },
      // Whether the editor says the library default ("Use the library
      // default" is offered while it does not, and while the account's own
      // place is in force — one equal to the default included: Save then
      // goes back to following the library).
      dmPickerIsDefault: function () {
        const k = this.discover.modal.picker;
        const d = this.dmDestDefault();
        return !!(k && d) && DISCOVERJOBS.sameDestination({ vpath: k.vpath, base: '', layout: this.dmPickerLayout() }, d);
      },
      // "Use the library default": refills the editor, nothing more —
      // nothing is saved until Save. The button may go with the difference,
      // so the keyboard moves to the first field.
      dmPickerUseDefault: function () {
        const k = this.discover.modal.picker;
        const d = this.dmDestDefault();
        if (!k || !d || k.saving) { return; }
        k.vpath = d.vpath;
        k.layout = d.layout;
        k.custom = !this.dmPickerIsPreset(d.vpath, d.layout);
        if (k.custom) { k.text = d.layout; }
        k.reset = true;
        k.error = '';
        if (k.browse) { this.dmBrowseAnchor(); }
        this.dmDestFocus('first');
      },
      // The folder the layout starts in whatever the tags — Custom's
      // leading folders that name no variable, normalised ('' for a
      // preset, for none, or for one that would be refused): the folder
      // list's chosen folder.
      dmPickerBase: function () {
        const k = this.discover.modal.picker;
        const norm = DISCOVERJOBS.normalizeBase(k && k.custom ? DISCOVERJOBS.layoutLead(k.text).folders : '');
        return norm.valid ? norm.base : '';
      },
      // A folder chosen in the list starts Custom's layout: in place of the
      // folders it starts with — or, from a preset, in front of it (the
      // folder and that layout, as foldBase holds a base folder). Custom
      // is chosen. The library root from a preset changes nothing; nothing
      // changes while a save is out.
      dmPickerStartAt: function (folder) {
        const k = this.discover.modal.picker;
        if (!k || k.saving || (!k.custom && !folder)) { return; }
        k.text = k.custom ? DISCOVERJOBS.startLayoutAt(folder, k.text) : DISCOVERJOBS.foldBase(folder, k.layout);
        k.custom = true;
        k.error = '';
      },
      // "Start from an existing folder…": the file explorer's own listing,
      // folders only, one level at a time. `dir` is the folder listed: the
      // chosen folder's parent when the list opens, so it shows pressed
      // among its neighbours; a row chooses its folder (dmPickerStartAt)
      // and lists what is in it; Up chooses the folder above. A folder that
      // does not exist yet is fine — the first copy creates it — and the
      // list says so. One whose name has a brace cannot start a layout (a
      // layout reads it as a variable, or refuses it): pressed, the list
      // says so (`braced`) and nothing changes. While a save is out the
      // list only closes.
      dmBrowseToggle: function () {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        if (k.browse) { k.browse = null; this.dmDestFocus('browse'); return; }
        if (k.saving) { return; }
        k.browse = { dir: '', loading: false, dirs: [], failed: false, naming: false, newName: '', braced: '' };
        this.dmBrowseAnchor();
      },
      // List the chosen folder's parent (the library root for none).
      dmBrowseAnchor: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.browse) { return; }
        k.browse.dir = DISCOVERJOBS.pathCrumbs(this.dmPickerBase()).slice(0, -1).join('/');
        this.dmBrowseLoad();
      },
      dmBrowseLoad: async function () {
        const k = this.discover.modal.picker;
        const b = k && k.browse;
        if (!b) { return; }
        const asked = k.vpath + '/' + b.dir;
        b.loading = true;
        let dirs = [];
        let failed = false;
        try {
          const res = await MSTREAMAPI.dirparser('/' + k.vpath + (b.dir ? '/' + b.dir : ''));
          dirs = ((res && res.directories) || []).map((d) => d.name).filter(Boolean);
        } catch (_) { failed = true; }
        if (this.discover.modal.picker !== k || k.browse !== b || k.vpath + '/' + b.dir !== asked) { return; }   // moved on meanwhile
        b.loading = false;
        b.dirs = dirs;
        b.failed = failed;
      },
      // The listed folder as crumbs, the library first.
      dmBrowseCrumbs: function () {
        const k = this.discover.modal.picker;
        if (!k) { return []; }
        return [k.vpath].concat(DISCOVERJOBS.pathCrumbs(k.browse ? k.browse.dir : this.dmPickerBase()));
      },
      // A listed folder that is the one the layout starts in (pressed).
      dmBrowseIsBase: function (name) {
        const k = this.discover.modal.picker;
        if (!k || !k.browse) { return false; }
        return [k.browse.dir, name].filter(Boolean).join('/') === this.dmPickerBase();
      },
      // The folder the layout starts in does not exist yet: the listed
      // folder is not there itself, or it is that folder's parent and holds
      // no folder of its name.
      dmBrowseMissing: function () {
        const k = this.discover.modal.picker;
        const b = k && k.browse;
        if (!b || b.loading) { return false; }
        if (b.failed) { return true; }
        const segs = DISCOVERJOBS.pathCrumbs(this.dmPickerBase());
        return segs.length > 0 && segs.slice(0, -1).join('/') === b.dir && b.dirs.indexOf(segs[segs.length - 1]) === -1;
      },
      dmBrowseInto: function (name, fresh) {
        const k = this.discover.modal.picker;
        if (!k || !k.browse || k.saving) { return; }
        const folder = DISCOVERJOBS.sanitizeSegment(name);
        if (DISCOVERJOBS.bracedFolder(folder) !== null) { k.browse.braced = folder; return; }
        k.browse.braced = '';
        const into = [k.browse.dir, folder].filter(Boolean).join('/');
        this.dmPickerStartAt(into);
        k.browse.dir = into;
        k.browse.naming = false;
        k.browse.newName = '';
        this.dmDestFocus('tree');
        // A folder the user just named is known not to exist: nothing to list.
        if (fresh) { k.browse.loading = false; k.browse.dirs = []; k.browse.failed = true; return; }
        this.dmBrowseLoad();
      },
      dmBrowseUp: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.browse || k.saving) { return; }
        k.browse.braced = '';
        const parts = DISCOVERJOBS.pathCrumbs(k.browse.dir);
        parts.pop();
        k.browse.dir = parts.join('/');
        this.dmPickerStartAt(k.browse.dir);
        this.dmDestFocus('tree');
        this.dmBrowseLoad();
      },
      dmBrowseNewFolder: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.browse || k.saving) { return; }
        if (!k.browse.naming) {
          k.browse.naming = true;   // dm-dest puts the caret in the name field
          return;
        }
        const name = DISCOVERJOBS.sanitizeSegment(k.browse.newName);
        if (name) { this.dmBrowseInto(name, k.browse.dirs.indexOf(name) === -1); }
      },
      // Save: kept for the account, so every copy and download from now on
      // lands under it — the layout with no base folder (one set elsewhere
      // went into the layout; a preset chosen over it leaves it behind) —
      // or, after "Use the library default", back to the default itself
      // (the account then follows the library's template). The editor
      // closes on the new path, a toast says where copies (Get it's: files)
      // land and the keyboard goes back to Change…; a refusal keeps it open
      // with the server's words under the layout. A read of the place sent
      // before the answer is dropped (dmLoadDestination): it would draw the
      // place from before the save.
      dmPickerSubmit: async function () {
        const m = this.discover.modal;
        const k = m.picker;
        const gen = m.gen;
        if (!k || !this.dmPickerCanSave()) { return; }
        const destination = k.reset && this.dmPickerIsDefault() ? null : { vpath: k.vpath, base: '', layout: this.dmPickerLayout() };
        k.saving = true;
        k.error = '';
        try {
          const view = await MSTREAMAPI.discoverySaveDestination(destination);
          this.discover.dest.view = view;
          this.discover.dest.saves += 1;
          this.dmKeepGateChanged();
          if (this.dmLive(gen) && m.picker === k) {
            m.picker = null;
            this.dmDestFocus('change');
            const d = view && view.destination;
            if (d) { iziToast.success({ title: this.tt(k.download ? 'discover.modal.dest.savedFiles' : 'discover.modal.dest.saved', { path: this.dmDestLanding(d) }), position: 'topCenter', timeout: 3000 }); }
          }
        } catch (err) {
          if (this.dmLive(gen) && m.picker === k) {
            k.saving = false;
            k.error = this.dmErrorText(err);
          }
        }
      },
      // Where every copy lands whatever its tags, for the saved toast: the
      // library, a base folder, and the layout's own leading folders that
      // name no variable ("copies › From friends").
      dmDestLanding: function (d) {
        return [d.vpath].concat(DISCOVERJOBS.pathCrumbs(DISCOVERJOBS.normalizeBase(d.base).base), DISCOVERJOBS.pathCrumbs(DISCOVERJOBS.layoutLead(d.layout).folders)).join(' › ');
      },

      // ── The downloads strip ────────────────────────────────────────────
      // One list (GET plugin-jobs) feeds the strip and the open window's
      // rows. Polled only while a job is live and the tab is visible: fast
      // with a live row in an open window, slower for the strip alone.
      noteDiscoverJob: function (job) {
        const jobs = this.discover.tray.jobs.filter((j) => j.id !== job.id);
        jobs.unshift(job);
        this.discover.tray.jobs = jobs;
      },
      discoverJobsLive: function () {
        return this.dmAnyJobLive() || DISCOVERJOBS.traySummary(this.discover.tray.jobs).live;
      },
      refreshDiscoverJobs: async function () {
        if (!this.discover.plugins.available) { return; }
        let res = null;
        try { res = await MSTREAMAPI.discoveryJobs(); } catch (_) { res = null; }
        if (res && Array.isArray(res.jobs)) {
          discoverJobsFailures = 0;
          await this.applyDiscoverJobs(res.jobs);
        } else {
          discoverJobsFailures += 1;
        }
        this.scheduleDiscoverJobsPoll();
      },
      applyDiscoverJobs: async function (jobs) {
        const finished = DISCOVERJOBS.finishedSince(this.discover.tray.jobs, jobs);
        this.discover.tray.jobs = jobs;
        const m = this.discover.modal;
        const keys = Object.values(m.recKeys || {}).concat(m.recKey ? [m.recKey] : []);
        if (m.open && keys.length) {
          const mine = DISCOVERJOBS.jobsBySlot(jobs.filter((j) => keys.indexOf(j.key) !== -1));
          for (const name of Object.keys(mine)) {
            const held = m.jobs[name];
            if (!held || mine[name].id >= held.id) { this.$set(m.jobs, name, mine[name]); }
          }
          // A live row whose job is not in the caller's list (an admin handed
          // another account's job): follow it by id.
          for (const name of Object.keys(m.jobs)) {
            const held = m.jobs[name];
            if (!DISCOVERJOBS.isLive(held) || jobs.some((j) => j.id === held.id)) { continue; }
            try {
              const one = await MSTREAMAPI.discoveryJob(held.id);
              if (one && one.job && this.discover.modal === m) { this.$set(m.jobs, name, one.job); }
            } catch (_) { this.$delete(m.jobs, name); }
          }
          // a state that ended took its button with it (Cancel, once the
          // copy is in): the keyboard stays in the card, on nothing it
          // did not choose — unless a press is still out: its own hand-off
          if (this.discover.modal === m) { this.dmKeepHold(discoverKeepPresses === 0); }
        }
        for (const job of finished) {
          if (!(m.open && keys.indexOf(job.key) !== -1)) { this.toastDiscoverJob(job); }
        }
        if (DISCOVERJOBS.trayRows(jobs).length > 0) { this.ensureDiscoverPlugins(); }
      },
      toastDiscoverJob: function (job) {
        const row = DISCOVERJOBS.jobRowState(job);
        const message = DISCOVERJOBS.jobTitle(job);
        if (row.state === 'failed') {
          // a song's failure carries the server's words; an album's or an
          // artist's ends 'done' with no error: its title and its counts
          iziToast.error({ title: this.tt('discover.job.toastFailed', { plugin: this.discoverPluginTitle(job.plugin) }), message: job.error || [message, this.dmText(row.sub)].filter(Boolean).join(' · '), position: 'topCenter', timeout: 5000 });
        } else if (row.state === 'copied') {
          iziToast.success({ title: this.tt('discover.job.toastCopied'), message, position: 'topCenter', timeout: 3000 });
        } else if (row.state === 'copiedMany') {
          iziToast.success({ title: this.tt('discover.job.toastCopiedMany'), message: [message, this.dmText(row.sub)].filter(Boolean).join(' · '), position: 'topCenter', timeout: 3500 });
        } else if (row.state === 'stopped') {
          iziToast.warning({ title: this.tt('discover.job.toastStopped'), message: [message, this.dmText(row.sub)].filter(Boolean).join(' · '), position: 'topCenter', timeout: 4500 });
        } else if (row.state === 'downloaded') {
          const where = row.filepath ? DISCOVERJOBS.pathCrumbs(row.filepath).join(' / ') : '';
          iziToast.success({ title: this.tt('discover.job.toastDownloaded'), message: [message, where].filter(Boolean).join(' · '), position: 'topCenter', timeout: 4000 });
        } else if (row.state === 'owned') {
          iziToast.info({ title: this.tt('discover.job.toastOwned'), message, position: 'topCenter', timeout: 3000 });
        } else if (row.state === 'nothing') {
          // an album or artist copy that found nothing to take (an artist
          // who only guests on that server's albums, an empty listing)
          iziToast.info({ title: this.tt('discover.job.toastNothing'), message: [message, this.dmText(row.sub)].filter(Boolean).join(' · '), position: 'topCenter', timeout: 3500 });
        }
      },
      scheduleDiscoverJobsPoll: function () {
        if (discoverJobsTimer) { clearTimeout(discoverJobsTimer); discoverJobsTimer = null; }
        if (!this.discover.plugins.available || !this.discoverJobsLive()) { return; }
        if (!discoverJobsVisibilityHooked) {
          discoverJobsVisibilityHooked = true;
          document.addEventListener('visibilitychange', () => {
            if (!document.hidden && playlistVue.discoverJobsLive()) { playlistVue.refreshDiscoverJobs(); }
          });
        }
        if (document.hidden) { return; }   // the listener picks it up when the tab is back
        // (Peer Recommendations' window follows its own jobs: dmPeerJobsPoll)
        const fast = this.dmAnyJobLive() && this.discover.modal.from !== 'peerRecs';
        const beat = fast ? 1500 : ((this.discover.tray.collapsed || this.discover.collapsed) ? 10000 : 4000);
        const delay = Math.min(60000, beat * Math.pow(2, Math.min(discoverJobsFailures, 6)));
        discoverJobsTimer = setTimeout(() => { discoverJobsTimer = null; this.refreshDiscoverJobs(); }, delay);
      },
      dtRows: function () {
        return DISCOVERJOBS.trayRows(this.discover.tray.jobs).map((job) => ({
          job, row: DISCOVERJOBS.jobRowState(job), title: DISCOVERJOBS.jobTitle(job), kind: DISCOVERJOBS.jobKind(job), plugin: this.discoverPluginTitle(job.plugin),
        }));
      },
      dtSummary: function () {
        return DISCOVERJOBS.traySummary(this.discover.tray.jobs).parts.map((p) => this.tt(p.key, { count: p.count })).join(' · ');
      },
      dtClearable: function () {
        return DISCOVERJOBS.traySummary(this.discover.tray.jobs).clearable;
      },
      // The folded strip's one line: the running job and how it is doing,
      // then how many failed; the plain summary when nothing runs.
      dtStripLine: function () {
        const rows = this.dtRows();
        const live = rows.find((r) => r.row.live);
        const failed = rows.filter((r) => r.row.state === 'failed' || r.row.state === 'stopped').length;
        const bits = [];
        if (live) { bits.push([live.title, this.dmText(live.row.sub)].filter(Boolean).join(' · ')); }
        if (failed) { bits.push(this.tt('discover.tray.failed', { count: failed })); }
        return bits.length ? bits.join(' · ') : this.dtSummary();
      },
      // "All downloads": the Downloads panel (m.js) — everything that landed.
      openDiscoverDownloads: function () {
        if (typeof changeView !== 'function' || typeof discoverDownloadsPanel !== 'function') { return; }
        changeView(discoverDownloadsPanel, document.getElementById('nav-discover-downloads'));
      },
      toggleDiscoverTray: function () {
        this.discover.tray.collapsed = !this.discover.tray.collapsed;
        try { localStorage.setItem('discoverTrayCollapsed', String(this.discover.tray.collapsed)); } catch (_) { /* private mode */ }
        this.scheduleDiscoverJobsPoll();
      },
      // Again, as it was started: the same scope, the same chosen upload,
      // the same landing (a folder's), and the place it ran with — its pin,
      // else where its result says it landed, else the place known now. The
      // strip shows no place, so a Retry goes where the copy went, and the
      // server refuses it (409 destination_changed) once that is no longer
      // where files land: the toast sends the user to the window, which
      // shows the new place.
      dtRetry: async function (job) {
        const params = job.params || {};
        const view = this.discover.dest.view;
        const ran = params.destination || (job.result && job.result.destination) || (view && view.destination) || undefined;
        try {
          const res = await MSTREAMAPI.discoveryJobStart(job.plugin, job.recommendation, params.choice, DISCOVERJOBS.jobScope(job), ran, params.landing);
          if (res && res.job) { this.noteDiscoverJob(res.job); }
        } catch (err) {
          const moved = !!(err && err.status === 409 && err.body && err.body.error === 'destination_changed');
          if (moved) { this.dmLoadDestination(); }
          // a right gone (403) or the copy plug-in gone (404): the pages'
          // ways in read their gate again, as after the window's own start
          if (err && (err.status === 403 || err.status === 404)) { this.dmKeepGateChanged(); }
          iziToast.error({ title: moved ? this.tt('discover.tray.destChanged') : this.dmErrorText(err), position: 'topCenter', timeout: 3500 });
        }
        this.scheduleDiscoverJobsPoll();
      },
      dtClear: async function () {
        try { await MSTREAMAPI.discoveryJobsClear(); } catch (_) { /* the refresh shows what is left */ }
        await this.refreshDiscoverJobs();
      },
      // A strip row opens the window its job came from, on that job: a
      // copy on the Keep card at the job's own scope (an album's as the
      // album; artist-missing = Artist, only the missing ticked; a folder's
      // as the folder, its own landing in its state — G17; an artist's from
      // an artist page, which names no song, as the artist); another
      // plug-in's download on the song, its row under Get it — in a
      // connected server's window too, where Get it shows only the jobs it
      // has (dmGetItRows). `opener` = the row, where the keyboard goes back
      // on close.
      openDiscoverModalForJob: async function (job, opener) {
        const rec = job.recommendation || {};
        const source = rec.source === 'federation' ? 'federation' : 'p2p';
        const scope = DISCOVERJOBS.jobScope(job);
        const opts = { scope, opener: opener || null };
        const copy = source === 'federation' && job.plugin === DISCOVERJOBS.COPY_PLUGIN;
        if (copy && (scope === 'album' || scope === 'folder')) { opts.focus = scope; }
        if (copy && (scope === 'artist' || scope === 'artist-missing') && !rec.filepath) { opts.focus = 'artist'; }
        await this.openDiscoverModal(Object.assign({}, rec, { peer: rec.peer || {} }), source, opts);
      },
      // The window learned the gate may have changed (a destination saved,
      // a start refused for a right or a plug-in gone): whoever watches it
      // (m.js's ways in, mstreamModule.watchKeepGate) reads it again.
      dmKeepGateChanged: function () {
        discoverGateWatchers.slice().forEach((fn) => { try { fn(); } catch (_) { /* a watcher's own trouble */ } });
      },

      // ── "From the network" rows ────────────────────────────────────
      // Not playable (the track lives on someone else's server) — clicking
      // copies "Artist - Title" so the user can go find it: the title alone
      // when there is no artist (PEERRECS.copyText's rule, plan §2 item
      // 19). `copied` = the toast's own key, its one word (Peer
      // Recommendations' window: 'peerRecs.copied').
      copyDiscoverP2p: async function (track, copied) {
        const artist = String(track.artist || '').trim();
        const title = String(track.title || '').trim();
        const text = artist && title ? `${artist} - ${title}` : (title || artist);
        try {
          await navigator.clipboard.writeText(text);
          if (copied) {
            iziToast.success({ title: t(copied), position: 'topCenter', timeout: 2500 });
          } else {
            iziToast.success({ title: t('discover.network.copied'), message: text, position: 'topCenter', timeout: 2500 });
          }
        } catch (_) {
          iziToast.info({ title: text, position: 'topCenter', timeout: 3500 });
        }
      },
      discoverP2pMbUrl: function (track) {
        return track.recordingMbid ? `https://musicbrainz.org/recording/${track.recordingMbid}` : null;
      },
      toggleDiscoverNewArtists: function () {
        this.discover.p2p.newArtistsOnly = !this.discover.p2p.newArtistsOnly;
        try { localStorage.setItem('discoverNewArtistsOnly', String(this.discover.p2p.newArtistsOnly)); } catch (_) { /* private mode */ }
        this.refreshDiscover();
      },
      toggleDiscover: function () {
        this.discover.collapsed = !this.discover.collapsed;
        try { localStorage.setItem('discoverCollapsed', String(this.discover.collapsed)); } catch (_) { /* private mode */ }
        // Opening with stale (or no) content → fetch for the current song.
        if (!this.discover.collapsed && discoverDirty) { this.refreshDiscover(); }
      },
      // ── One source at a time ────────────────────────────────────────
      // The sources this server has, in the switch's order, each with its
      // count for the seed. `label` is an i18n key.
      discoverSources: function () {
        const d = this.discover;
        const out = [{ key: 'library', label: 'discover.source.library', count: d.tracks.length }];
        if (d.p2p.available && !d.p2p.disabled) { out.push({ key: 'network', label: 'discover.source.network', count: d.p2p.tracks.length }); }
        if (d.fed.available && !d.fed.disabled) { out.push({ key: 'peers', label: 'discover.source.peers', count: d.fed.tracks.length }); }
        return out;
      },
      // The chosen source — the library when the choice is gone (a feature
      // switched off since it was remembered).
      discoverSource: function () {
        const want = this.discover.source;
        return this.discoverSources().some((s) => s.key === want) ? want : 'library';
      },
      setDiscoverSource: function (key) {
        this.discover.source = key;
        try { localStorage.setItem('discoverSource', key); } catch (_) { /* private mode */ }
      },
      // The line above a remote list: who answered.
      discoverNetworkLine: function () {
        const n = this.discover.p2p.searchedPeers;
        if (this.discover.loading || n === null) { return this.tt('discover.modal.lookingUp'); }
        return n === 1 ? this.tt('discover.network.searchedOne') : this.tt('discover.network.searched', { count: n });
      },
      discoverPeersLine: function () {
        const f = this.discover.fed;
        if (this.discover.loading || f.searchedPeers === null) { return this.tt('discover.modal.lookingUp'); }
        const bits = [f.searchedPeers === 1 ? this.tt('discover.peers.answeredOne') : this.tt('discover.peers.answered', { count: f.searchedPeers })];
        if (f.unreachable > 0) { bits.push(this.tt('discover.peers.unreachableCount', { count: f.unreachable })); }
        return bits.join(' · ');
      },
      queueAllDiscoverFed: function () {
        for (const ft of this.discover.fed.tracks) { this.queueDiscoverFed(ft); }
      },
      queueDiscoverTrack: function (t) {
        mstreamModule.addSongWizard(t.filepath, t.metadata || {}, false, undefined, false, true);
      },
      queueAllDiscover: function () {
        for (const t of this.discover.tracks) { this.queueDiscoverTrack(t); }
      },
      queueArtistEntryPoints: function (a) {
        for (const e of (a.entryPoints || [])) {
          mstreamModule.addSongWizard(e.filepath, e.metadata || {}, false, undefined, false, true);
        }
      },
      goToDiscoverArtist: function (a) {
        const el = document.createElement('DIV');
        el.setAttribute('data-artist', a.artist);
        getArtistz(el);
      },
      // "Electronic---Synthwave" → "Synthwave"; join the first two with a
      // dot so the row reads: Vosto · Synthwave · Chillwave
      discoverTags: function (tags) {
        if (!tags || !tags.length) { return ''; }
        return tags.slice(0, 2).map((t) => t.split('---').pop()).join(' · ');
      },
      discoverArtistTag: function (a) {
        if (!a.genreTags || !a.genreTags.length) { return ''; }
        return a.genreTags[0].split('---').pop();
      },
    },
  });

  // Template for playlist items
  Vue.component('playlist-item', {
    template: `
      <li v-on:click="goToSong($event)" class="noselect np-queue-item" v-bind:class="{ playError: (this.songError && this.songError === true) }">
        <span onclick="event.stopPropagation()" class="drag-handle">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#666" d="M4 7v2h24V7Zm0 8v2h24v-2Zm0 8v2h24v-2Z"/></svg>
        </span>
        <img v-if="albumArt" class="np-queue-art" loading="lazy" :src="albumArt">
        <div v-else class="np-queue-art-placeholder">
          <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 24 24" fill="#555"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <div class="np-queue-info">
          <div class="np-queue-title">{{ songTitle }}</div>
          <div class="np-queue-artist" v-if="songArtist">{{ songArtist }}</div>
        </div>
        <div onclick="event.stopPropagation()" class="np-queue-actions">
          <span v-on:click="createPopper($event)" class="np-queue-action pop-c" title="Rate">
            {{ratingNumber}}
            <svg class="pop-c" width="14" height="14" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 53.867 53.867"><path class="pop-c" d="m26.934 1.318 8.322 16.864 18.611 2.705L40.4 34.013l3.179 18.536-16.645-8.751-16.646 8.751 3.179-18.536L0 20.887l18.611-2.705z" fill="#efce4a"/></svg>
          </span>
          <span v-on:click="createPopper2($event)" class="np-queue-action popperMenu pop-d" title="More" :data-keep-key="song.federation ? song.federation.peerId + '|queue|' + song.filepath : null">
            <svg class="pop-d" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path class="pop-d" fill="#aaa" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
          </span>
          <span v-on:click="removeSong($event)" class="np-queue-action np-queue-remove" title="Remove">
            <svg width="10" height="10" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </span>
        </div>
      </li>`,

    props: ['index', 'song'],

    // positionCache deliberately does NOT live here. It is a single shared
    // object, so putting it in per-row data made every row in the queue a
    // reactive subscriber to a value that changes once per track change —
    // advancing a track re-rendered the whole list. The active-row class is
    // now bound by the parent (#playlist) on the v-for in index.html, which
    // re-renders one row instead of N. Measured with the bundled Vue 2.7.16:
    // 500 rows 69.3ms -> 5.1ms per track change, 2000 rows 353ms -> 34.5ms.
    data: function () {
      return {};
    },

    // Methods used by playlist item events
    methods: {
      goToSong: function (event) {
        MSTREAMPLAYER.goToSongAtPosition(this.index);
      },
      removeSong: function (event) {
        MSTREAMPLAYER.removeSongAtPosition(this.index, false);
        saveLiveQueue();
      },
      downloadSong: function (event) {
        const link = document.createElement("a");
        link.download = '';
        link.href = this.song.url;
        link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
      },
      createPopper: function (event) {
        // Peer tracks can't be rated: ratings live in user_metadata keyed by
        // LOCAL track hashes, so the server would just 404 the remote path.
        // Say so up front instead of opening a rater that fails on submit.
        if (this.song.federation) {
          iziToast.info({ title: t('discover.peers.noRating'), position: 'topCenter', timeout: 2500 });
          return;
        }
        if (currentPopperSongIndex === this.index) {
          currentPopperSongIndex = false;
          document.getElementById("pop").style.visibility = "hidden";
          return;
        }
        var ref = event.target;
        currentPopperSongIndex = this.index;
        currentPopperSongIndex2 = this.index;

        currentPopperSong = this.song;

        showClearLink.val = false;
        if (typeof MSTREAMPLAYER.playlist[currentPopperSongIndex2].metadata.rating === 'number'){
          showClearLink.val = true
        }

        myRater.setRating(this.song.metadata.rating / 2);

        const pop = document.getElementById('pop');
        Popper.createPopper(ref, pop, {
          placement: 'bottom-end',
          onFirstUpdate: function (data) {
            document.getElementById("pop").style.visibility = "visible";
          },
          modifiers: [
            {
              name: 'flip',
              options: {
                boundariesElement: 'scrollParent',
              },
            },
            {
              name: 'preventOverflow',
              options: {
                boundariesElement: 'scrollParent',
              },
            },
          ]
        });
      },
      createPopper2: function (event) {
        if (cpsi === this.index) {
          cpsi = false;
          document.getElementById("pop-d").style.visibility = "hidden";
          return;
        }
        var ref = event.target;
        cpsi = this.index;

        cps = this.song;
  
        const pop = document.getElementById('pop-d');
        Popper.createPopper(ref, pop, {
          placement: 'bottom-end',
          onFirstUpdate: function (data) {
            document.getElementById("pop-d").style.visibility = "visible";
          },
          modifiers: [
            {
              name: 'flip',
              options: {
                boundariesElement: 'scrollParent',
              },
            },
            {
              name: 'preventOverflow',
              options: {
                boundariesElement: 'scrollParent',
              },
            },
          ]
        });
      },
    },
    computed: {
      comtext: function () {
        let returnThis = this.song.filepath.split('/').pop();
        if (this.song.metadata.title) {
          returnThis = this.song.metadata.title;
          if (this.song.metadata.artist) {
            returnThis = this.song.metadata.artist + ' - ' + returnThis;
          }
        }
        return returnThis;
      },
      songTitle: function () {
        return this.song.metadata.title || this.song.filepath.split('/').pop();
      },
      songArtist: function () {
        return this.song.metadata.artist || '';
      },
      albumArt: function () {
        if (this.song.metadata && this.song.metadata['album-art']) {
          return songArtUrl(this.song.metadata['album-art'], this.song, 's');
        }
        return null;
      },
      songError: function () {
        return this.song.error;
      },
      ratingNumber: function () {
        if (!this.song.metadata.rating) {
          return '';
        }
        var returnThis = this.song.metadata.rating / 2;
        if (!Number.isInteger(returnThis)) {
          returnThis = returnThis.toFixed(1);
        }

        return returnThis;
      }
    }
  });

  Vue.component('popper-playlist-item', {
    template: '<div class="pop-list-item" v-on:click="addToPlaylist($event)">&#8226; {{playlistName}}</div>',
    props: ['index', 'playlist'],
    methods: {
      addToPlaylist: async function(event) { 
        // Same rule as the browse rows' add-to-playlist button (m.js): a
        // peer path would save as a row that resolves to nothing here.
        if (cps && cps.federation) {
          iziToast.info({ title: t('peers.noPlaylist'), position: 'topCenter', timeout: 2500 });
          return;
        }
        try {
          await MSTREAMAPI.addToPlaylist(this.playlist.name, cps.filepath);
          iziToast.success({
            title: 'Song Added!',
            position: 'topCenter',
            timeout: 3500
          }); 
        }catch(err) {
          iziToast.error({
            title: 'Failed to add song',
            position: 'topCenter',
            timeout: 3500
          });
        }
      }
    },
    computed: {
      playlistName: function () {
        return this.playlist.name;
      }
    }
  });

  const playerVue = new Vue({
    el: '#mstream-player',
    data: {
      playerStats: MSTREAMPLAYER.playerStats,
      playlist: MSTREAMPLAYER.playlist,
      positionCache: MSTREAMPLAYER.positionCache,
      meta: MSTREAMPLAYER.playerStats.metadata,
      lastVol: 100,
      replayGainToggle: false,
      altLayout: mstreamModule.altLayout,
      waveformReady: false
    },
    watch: {
      'meta.filepath': function(newPath) {
        this.waveformReady = false;
        if (this.altLayout.waveformBar) {
          _fetchWaveform(newPath);
        }
      },
      'playerStats.playing': function(isPlaying) {
        // the user starting the main player ends a preview clip (the aside player)
        asideMainPlaying(isPlaying);
        if (!this.altLayout.waveformBar) return;
        if (isPlaying) {
          // If waveform not loaded yet (e.g. first play after page load), fetch it
          if (!_waveformData && this.meta.filepath) {
            _fetchWaveform(this.meta.filepath);
          } else if (_waveformData) {
            _startWaveformRaf();
          }
        } else {
          if (_waveformData) _stopWaveformRaf();
        }
      },
      // Seeking while PAUSED moves the playhead with no rAF loop running,
      // and nothing else repaints the canvas, so the orange played/unplayed
      // split used to freeze in place while the time label moved — the bar
      // disagreed with the clock until playback resumed. Guarded on the
      // loop being idle, so during playback this watcher costs a comparison
      // and nothing else (the loop already owns repainting then).
      'playerStats.currentTime': function () {
        if (_waveformRaf) { return; }
        if (!this.altLayout.waveformBar || !_waveformData) { return; }
        _wfInvalidate();
        _drawWaveform();
      }
    },
    created: function () {
      if (typeof(Storage) !== "undefined") {
        const localVol = localStorage.getItem("volume");
        if (localVol !== null && !isNaN(localVol)) {
          MSTREAMPLAYER.changeVolume(parseInt(localVol));
        }
        MSTREAMPLAYER.setReplayGainActive(localStorage.getItem("replayGain") == "true");

        const rgPregain = Number(localStorage.getItem("replayGainPreGainDb"));
        MSTREAMPLAYER.setReplayGainPreGainDb(rgPregain === NaN ? 0 : rgPregain);
      }
    },
    computed: {
      playbackRate: function() {
        const rate = Number(this.playerStats.playbackRate);
        return rate.toFixed(2) + 'x'
      },
      currentTime: function() {
        if (!this.playerStats.duration) { return ''; }

        const minutes = Math.floor(this.playerStats.currentTime / 60);
        const secondsToCalc = Math.floor(this.playerStats.currentTime % 60) + '';
        const currentText = minutes + ':' + (secondsToCalc.length < 2 ? '0' + secondsToCalc : secondsToCalc);
        return currentText;
      },
      durationTime: function() {
        if (!this.playerStats.duration) { return '0:00'; }

        const minutes = Math.floor(this.playerStats.duration / 60);
        const secondsToCalc = Math.floor(this.playerStats.duration % 60) + '';
        const currentText = minutes + ':' + (secondsToCalc.length < 2 ? '0' + secondsToCalc : secondsToCalc);
        return currentText;
      },
      widthcss: function () {
        if (this.playerStats.duration === 0) {
          return "width:0";
        }

        const percentage = (this.playerStats.currentTime / this.playerStats.duration) * 100;
        return `width:${percentage}%`;
      },
      volWidthCss: function () {
        return `width: ${this.playerStats.volume}%`;
      },
      albumArtPath: function () {
        if (!this.meta['album-art']) {
          return 'assets/img/default.png';
        }
        // The playing track may live on a peer while the app is pointed home;
        // songArtUrl branches on the song's own federation, not peerContext.
        return songArtUrl(this.meta['album-art'], MSTREAMPLAYER.getCurrentSong(), 'l');
      },
      // Mirrors the queue-item Vue's djKeyLabel — both Vue instances
      // bind `meta` to MSTREAMPLAYER.playerStats.metadata. See the
      // earlier computed for the full doc comment.
      djKeyLabel: function () {
        const raw = this.meta['musical-key'];
        if (!raw) { return ''; }
        const code = (typeof AUTODJ !== 'undefined') ? AUTODJ.toCamelot(raw) : null;
        if (code && code !== String(raw).trim()) { return `${raw} (${code})`; }
        return code || String(raw);
      },
    },
    methods: {
      getSongInfo: function() {
        openMetadataModal(MSTREAMPLAYER.getCurrentSong().metadata, MSTREAMPLAYER.getCurrentSong().rawFilePath);
      },
      openLyrics: function() {
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song) { openLyricsModal(song.rawFilePath, this.meta && this.meta.title); }
      },
      changeVol: function(event) {
        const rect = this.$refs.volumeWrapper.getBoundingClientRect();
        const x = event.clientX - rect.left; //x position within the element.
        let percentage = (x / rect.width) * 100;
        if (percentage > 100) { percentage = 100; } // It's possible to 'drag' the progress bar to get over 100 percent
        if (percentage < 0) { percentage = 0; } // It's possible to 'drag' the progress bar to get over 100 percent
        MSTREAMPLAYER.changeVolume(percentage);
        if (typeof(Storage) !== "undefined") {
          localStorage.setItem("volume", percentage);
        }
      },
      seekTo: function(event) {
        const rect = this.$refs.progressWrapper.getBoundingClientRect();
        const x = event.clientX - rect.left; //x position within the element.
        const percentage = (x / rect.width) * 100;
        MSTREAMPLAYER.seekByPercentage(percentage);
      },
      playPause: function() {
        MSTREAMPLAYER.playPause();
      },
      previousSong: function() {
        MSTREAMPLAYER.previousSong();
      },
      nextSong: function() {
        MSTREAMPLAYER.nextSong();
      },
      toggleRepeat: function () {
        MSTREAMPLAYER.toggleRepeat();
      },
      toggleShuffle: function () {
        MSTREAMPLAYER.toggleShuffle();
      },
      toggleAutoDJ: function () {
        MSTREAMPLAYER.toggleAutoDJ();
      },
      goToArtist: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-artist', this.meta.artist);
        // The now-playing track may be a peer's; carry its peer so getArtistz's
        // adoptPeer looks the artist up on the right server, not the local one.
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song && song.federation) { el.setAttribute('data-peer', song.federation.peerId); }
        getArtistz(el);
      },
      goToAlbum: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-album', this.meta.album);
        el.setAttribute('data-year', this.meta.year);
        // Carry the playing track's peer (if any) so the album resolves on that
        // server; without it adoptPeer flips the app home and finds nothing.
        const song = MSTREAMPLAYER.getCurrentSong();
        if (song && song.federation) { el.setAttribute('data-peer', song.federation.peerId); }
        getAlbumsOnClick(el);
      },
      goForward: function(seconds) {
        MSTREAMPLAYER.goForwardSeek(seconds);
      },
      goBack: function(seconds) {
        MSTREAMPLAYER.goBackSeek(seconds);
      },
      fadeOverlay: function () {
        VIZ.toggleDom();
      },
      toggleMute: function () {
        if (this.playerStats.volume === 0) {
          MSTREAMPLAYER.changeVolume(this.lastVol);
        } else {
          this.lastVol = this.playerStats.volume;
          MSTREAMPLAYER.changeVolume(0);
        }
      },
      toggleReplayGain: function () {
        // With a series of clicks, allow the user to first activate ReplayGain, then progress through a list of
        // settings for the desired level of pre-gain, and then finally disable ReplayGain again.
        if (replayGainInfoTimeout) { clearTimeout(replayGainInfoTimeout); }
        
        if (!this.playerStats.replayGain) {
          MSTREAMPLAYER.setReplayGainPreGainDb(replayGainPreGainSettings[0]);
          MSTREAMPLAYER.setReplayGainActive(true);
        } else {
          const settingsIdx = replayGainPreGainSettings.indexOf(this.playerStats.replayGainPreGainDb);
          if (settingsIdx == -1 || settingsIdx >= replayGainPreGainSettings.length - 1) {
            MSTREAMPLAYER.setReplayGainActive(false);
            this.replayGainToggle = false;
          } else {
            MSTREAMPLAYER.setReplayGainPreGainDb(replayGainPreGainSettings[settingsIdx + 1]);
          }
        }

        if (this.playerStats.replayGain) {
          this.replayGainToggle = true;

          replayGainInfoTimeout = setTimeout(() => {
            this.replayGainToggle = false;
          }, 1000);
        }
        
        if (typeof(Storage) !== "undefined") {
          localStorage.setItem("replayGain", this.playerStats.replayGain);
          localStorage.setItem("replayGainPreGainDb", this.playerStats.replayGainPreGainDb);
        }
      },
    }
  });

  // Player hotkeys — bindings come from MSTREAMPLAYER.hotkeys, configurable
  // under Layout > Keyboard Shortcuts (persisted in localStorage).
  function hotkeyAdjustVolume(delta) {
    let newVol = Math.round(MSTREAMPLAYER.playerStats.volume) + delta;
    if (newVol > 100) { newVol = 100; }
    if (newVol < 0) { newVol = 0; }
    MSTREAMPLAYER.changeVolume(newVol);
    if (typeof(Storage) !== "undefined") {
      localStorage.setItem("volume", newVol);
    }
  }

  function hotkeyStepPlaybackRate(delta) {
    // Same range as the speed modal (0.25x - 4x)
    let newRate = Math.round((MSTREAMPLAYER.playerStats.playbackRate + delta) * 100) / 100;
    if (newRate > 4) { newRate = 4; }
    if (newRate < 0.25) { newRate = 0.25; }
    MSTREAMPLAYER.changePlaybackRate(newRate);
  }

  // Keys the player's hotkeys leave alone: one typed into a form or an
  // editable element, any key in the recommendation window — there Space
  // and Enter press its buttons, the arrows move through a radio group, and
  // nothing should seek, skip or pause behind it — and a key on a connected
  // server's page control that opens the window (its header's Keep a
  // copy…, a row's or a card's ⋯): Space presses it, as Enter does.
  function hotkeysSkip(target) {
    // the recommendation window holds the keyboard while it is open, even
    // when focus fell out of it for a moment (a control it was on went away)
    if (typeof document !== 'undefined' && document.querySelector('.dmodal-shadow')) { return true; }
    if (!target || typeof target.tagName !== 'string') { return false; }
    const element = target.tagName.toLowerCase();
    if (element === 'input' || element === 'textarea' || element === 'select' || target.isContentEditable) { return true; }
    return typeof target.closest === 'function' && target.closest('.dmodal-shadow, .browse-keep, .browse-keep-tab, .browse-keep-more') !== null;
  }

  window.addEventListener("keydown", (event) => {
    // Use default behavior if user is in a form, an editable element or the
    // recommendation window
    if (hotkeysSkip(event.target)) { return; }

    const action = MSTREAMPLAYER.hotkeys.resolve(event);
    if (!action) { return; }
    event.preventDefault();

    switch (action) {
      case 'playPause':
      case 'playPauseAlt':
        MSTREAMPLAYER.playPause();
        break;
      case 'seekBack': MSTREAMPLAYER.goBackSeek(5); break;
      case 'seekForward': MSTREAMPLAYER.goForwardSeek(5); break;
      case 'bigSeekBack': MSTREAMPLAYER.goBackSeek(30); break;
      case 'bigSeekForward': MSTREAMPLAYER.goForwardSeek(30); break;
      case 'prevTrack': MSTREAMPLAYER.previousSong(); break;
      case 'nextTrack': MSTREAMPLAYER.nextSong(); break;
      case 'volumeUp': hotkeyAdjustVolume(5); break;
      case 'volumeDown': hotkeyAdjustVolume(-5); break;
      case 'mute': playerVue.toggleMute(); break;
      case 'shuffle': MSTREAMPLAYER.toggleShuffle(); break;
      case 'repeat': MSTREAMPLAYER.toggleRepeat(); break;
      case 'speedUp': hotkeyStepPlaybackRate(0.25); break;
      case 'speedDown': hotkeyStepPlaybackRate(-0.25); break;
      case 'percentSeek': MSTREAMPLAYER.seekByPercentage(parseInt(event.key, 10) * 10); break;
    }
  }, false);

  const myRater = raterJs({
    element: document.querySelector(".my-rating"),
    step: .5,
    starSize: 22,
    rateCallback: async (rating, done) => {
      try {
        await MSTREAMAPI.rateSong(currentPopperSong.rawFilePath, parseInt(rating * 2));
        MSTREAMPLAYER.editSongMetadata('rating', parseInt(rating * 2), currentPopperSongIndex2);
      }catch(err) {
        iziToast.error({
          title: 'Failed to set rating',
          position: 'topCenter',
          timeout: 3500
        });
      }
      done();
    }
  });

  // Song-capture slot (the Sonic Path panel's pickers). Consumed by
  // onFileClick (m.js) — the SINGLE-row click dispatch — so any browsing
  // view can feed a picker while bulk actions (Add All To Queue, recursive
  // adds) go straight to addSongWizard and never trip an armed picker.
  // One-shot: the consumer clears it on first capture / cancel.
  mstreamModule.songCapture = null;

  mstreamModule.addSongWizard = async (filepath, metadata, lookupMetadata, position, livePlaylist, autoPlayOff) => {
    // Escape filepath
    const rawFilepath = filepath;
    filepath = filepath.replace(/\%/g, "%25");
    filepath = filepath.replace(/\#/g, "%23");
    filepath = filepath.replace(/\?/g, "%3F");
    if (filepath.charAt(0) === '/') {
      filepath = filepath.substr(1);
    }

    let defaultPathString = 'media/';
    if (MSTREAMPLAYER.transcodeOptions.serverEnabled && MSTREAMPLAYER.transcodeOptions.frontendEnabled) {
      defaultPathString = 'transcode/';
    }

    let url = MSTREAMAPI.currentServer.host + defaultPathString + filepath + '?';
    if (MSTREAMAPI.currentServer.token) {
      url = url + 'token=' + MSTREAMAPI.currentServer.token;
    }

    const newSong = {
      url: url,
      rawFilePath: rawFilepath,
      filepath: filepath,
      metadata: metadata,
      authToken: MSTREAMAPI.currentServer.token
    };

    if (position) {
      MSTREAMPLAYER.insertSongAt(newSong, position, true);
      saveLiveQueue();
    } else {
      MSTREAMPLAYER.addSong(newSong, autoPlayOff);
      if (mstreamModule.livePlaylist.name && livePlaylist !== false) {
        await MSTREAMAPI.addToPlaylist(mstreamModule.livePlaylist.name, newSong.filepath);
      }
    }

    // Warm the waveform cache in the background so the moment this track
    // starts playing, the waveform renders from localStorage instead of
    // a fresh HTTP round-trip (~100-500ms lag otherwise). Concurrency-
    // capped inside _prefetchWaveform so adding a full album doesn't
    // hammer the server. Only runs when the setting is actually on —
    // otherwise the waveform would never render and the fetch is wasted.
    if (mstreamModule.altLayout.waveformBar) {
      mstreamModule.prefetchWaveform(rawFilepath);
    }

    // Perform a metadata lookup ONLY when we weren't handed usable metadata
    // already. Callers that pass a real metadata object — a single search
    // hit (the search API returns lite metadata inline), album queue,
    // playlist load, Add All on a DB panel — skip this redundant
    // /api/v1/db/metadata round-trip. The file browser passes {} (it has no
    // inline metadata) and still gets a lookup.
    const hasMetadata = metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0;
    if (lookupMetadata === true && !hasMetadata) {
      const response = await MSTREAMAPI.lookupMetadata(rawFilepath);

      if (response.metadata) {
        newSong.metadata = response.metadata;
        // Only refresh the now-playing card when the track we just
        // enriched IS the one playing. resetCurrentMetadata() reads
        // getCurrentPlayer().songObject, so calling it for some other
        // queued track re-rendered the same values it already had — but
        // it also runs _updateAutoDjAnchorsOnSongChange(), and the
        // playing song is not flagged _djPicked, so that took the
        // "manual pick" branch and called AUTODJ.resetAnchors(): six
        // localStorage writes wiping bpmHistory, the Camelot anchor and
        // the sonic seed. Queueing one track from the file browser threw
        // away the Auto-DJ session. Identity compare is safe — the
        // engine's add/insert/setMedia paths all preserve the object.
        if (MSTREAMPLAYER.getCurrentSong() === newSong) {
          MSTREAMPLAYER.resetCurrentMetadata();
        }
      }
    }
  };

  // Queue a track that lives on a FEDERATED PEER. It plays through this
  // server's stream proxy (/api/v1/federation/peers/:id/stream/…), so the
  // browser needs nothing but its normal token. Deliberately NOT routed
  // through addSongWizard: no transcode rerouting, no waveform prefetch,
  // no live-playlist save, no metadata lookup — every one of those
  // resolves paths against the LOCAL library, and this path lives in the
  // peer's vpath namespace. The `federation` marker on the song object is
  // what the degrade guards key on (waveform skip, Discover clear).
  // `position` (added for the peer-browse panels) inserts and plays, the
  // way addSongWizard's own position argument does — without it a peer row
  // could only ever be appended, so "Play Now" did nothing on peer tracks.
  // `playNow` (default true, the historical behaviour) matters only with a
  // position: false inserts there without jumping to it — the modal's
  // "Queue next".
  mstreamModule.addFederationSongWizard = (peer, remotePath, metadata, autoPlayOff, position, playNow = true) => {
    let escaped = remotePath.replace(/\%/g, '%25').replace(/\#/g, '%23').replace(/\?/g, '%3F');
    if (escaped.charAt(0) === '/') { escaped = escaped.substr(1); }
    let url = `${MSTREAMAPI.currentServer.host}api/v1/federation/peers/${peer.id}/stream/${escaped}?`;
    if (MSTREAMAPI.currentServer.token) { url += 'token=' + MSTREAMAPI.currentServer.token; }
    const newSong = {
      url: url,
      rawFilePath: remotePath,
      filepath: remotePath,
      metadata: metadata || {},
      authToken: MSTREAMAPI.currentServer.token,
      federation: { peerId: peer.id, peerName: peer.name || 'peer' },
    };

    // position 0 is a real insert index (Play Now onto an empty queue); a bare
    // `if (position)` treated it as "no position" and fell through to a paused
    // append.
    if (position !== undefined) {
      MSTREAMPLAYER.insertSongAt(newSong, position, playNow !== false);
      return;
    }
    MSTREAMPLAYER.addSong(newSong, autoPlayOff);
  };

  mstreamModule.clearQueue = async() => {
    MSTREAMPLAYER.clearPlaylist();
    saveLiveQueue();
  }

  // ── WAVEFORM ────────────────────────────────────────────────────────────────
  // Fetches waveform data from the server, caches in localStorage + memory,
  // and renders a two-pass canvas overlay on the progress bar.

  let _waveformData = null;   // Array of 0-255 bar heights (800 entries)
  let _waveformFp   = null;   // filepath of the currently loaded waveform
  let _waveformRaf  = null;   // requestAnimationFrame handle
  // Bumped alongside the server's cache generation (CACHE_EXT in
  // src/db/waveform-lib.js). Waveforms are stored per filepath with no
  // version in the value, so without a new prefix a browser would keep
  // rendering bars from the old decoder forever — the server-side fix
  // would simply never reach anyone who had already played the track.
  // Entries under the previous prefix are purged on first load.
  const _WF_LS_PREFIX = 'wf2:';
  const _WF_LS_OLD_PREFIXES = ['wf:'];

  (function _wfLsPurgeOldGenerations() {
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && _WF_LS_OLD_PREFIXES.some(p => k.startsWith(p))) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    } catch (_e) { /* private mode / quota — the new prefix still wins */ }
  }());

  // Bars are stored base64, not as a JSON number array. Each bar is one
  // byte, so JSON spends ~3.4 characters ("128,") on what base64 says in
  // 1.34 — and localStorage holds UTF-16, which doubles whatever we write.
  // Measured on an 800-bar waveform: 5474 bytes as JSON, 2166 as base64.
  // At the 500-entry cap that is ~2.7 MB against ~1.1 MB, i.e. the
  // difference between sitting comfortably inside a ~5 MB origin budget
  // and living permanently in the eviction path, re-fetching what was
  // just dropped. Decoding is ~16x cheaper too (31.5 us -> 1.9 us), and
  // hands the renderer a Uint8Array instead of 800 boxed numbers.
  //
  // NOT compressed on the wire and NOT changed server-side: this is purely
  // how the browser holds its own copy. The endpoint still returns JSON,
  // which the compression middleware already handles well.
  function _wfB64Encode(data) {
    // Chunked rather than String.fromCharCode(...data): spreading is fine
    // at 800 entries but throws RangeError once arrays get large, and this
    // is the one place the array length is not ours to assume.
    let s = '';
    for (let i = 0; i < data.length; i += 4096) {
      s += String.fromCharCode.apply(null,
        Array.prototype.slice.call(data, i, i + 4096));
    }
    return btoa(s);
  }

  function _wfB64Decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  }

  function _wfLsGet(filepath) {
    try {
      const raw = localStorage.getItem(_WF_LS_PREFIX + filepath);
      if (!raw) return null;
      // Entries written before this encoding are still perfectly valid
      // bars, so they are read rather than discarded — a '[' can't start
      // base64, which makes the two formats trivially distinguishable.
      // Re-write on hit so a warm cache migrates as tracks get played
      // instead of staying oversized forever.
      if (raw[0] === '[') {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length === 0) { return null; }
        const bytes = Uint8Array.from(arr, (v) => v & 255);
        _wfLsSet(filepath, bytes);
        return bytes;
      }
      const bytes = _wfB64Decode(raw);
      return bytes.length > 0 ? bytes : null;
    } catch (_e) { return null; }
  }

  const _WF_LS_MAX = 500; // max cached waveforms in localStorage

  function _wfLsSet(filepath, data) {
    let encoded;
    try { encoded = _wfB64Encode(data); }
    catch (_e) { return; }   // unencodable input is not worth a quota retry
    try {
      localStorage.setItem(_WF_LS_PREFIX + filepath, encoded);
    } catch (_e) {
      // Quota exceeded — evict oldest wf:* entries and retry once
      _wfLsEvict();
      try { localStorage.setItem(_WF_LS_PREFIX + filepath, encoded); }
      catch (_e2) { /* still full — give up */ }
    }
  }

  function _wfLsEvict() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_WF_LS_PREFIX)) keys.push(k);
    }
    if (keys.length <= _WF_LS_MAX) return;
    // Remove oldest half — localStorage has no insertion-order guarantee,
    // so just remove an arbitrary batch to free space
    const toRemove = keys.slice(0, Math.floor(keys.length / 2));
    for (const k of toRemove) localStorage.removeItem(k);
  }

  // Cleared whenever anything the canvas depends on changes, so the rAF
  // loop's skip check below can never hold a stale "already drawn" belief.
  let _wfLastSplitPx = -1;
  function _wfInvalidate() { _wfLastSplitPx = -1; }

  function _setWaveformReady(val) {
    // Every path that swaps or clears the bar data calls through here, which
    // makes this the one place that has to invalidate the frame cache.
    _wfInvalidate();
    if (playerVue) playerVue.waveformReady = val;
  }

  // Draw once Vue has flushed. The four "waveform is ready" call sites used
  // to draw synchronously, but `wf-active` — the class that un-hides the
  // canvas — is applied by Vue on the next tick. So the canvas was still
  // display:none, offsetWidth was 0, and _drawWaveform bailed at its size
  // guard without painting. Since spa.css hides the plain .determinate bar
  // as soon as wf-active lands, the common "queue a track with autoplay
  // off" path showed an entirely blank progress bar until the user pressed
  // play. Only the ready=true sites need this; the ready=false ones draw to
  // clear a canvas that is still visible, and must stay synchronous.
  function _drawWaveformSoon() {
    if (typeof Vue !== 'undefined' && Vue.nextTick) { Vue.nextTick(_drawWaveform); }
    else { _drawWaveform(); }
  }

  async function _fetchWaveform(filepath) {
    // Skip radio/external streams, federated tracks, and empty paths — a
    // peer's filepath means nothing to the local waveform API (it resolves
    // against OUR libraries), so treat it like an external stream.
    const cur = MSTREAMPLAYER.getCurrentSong();
    if (!filepath || /^https?:\/\//i.test(filepath) || (cur && cur.federation)) {
      _waveformData = null;
      _waveformFp = null;
      _setWaveformReady(false);
      _stopWaveformRaf();
      _drawWaveform();
      return;
    }

    // In-memory cache hit
    if (_waveformFp === filepath && _waveformData) {
      _setWaveformReady(true);
      _drawWaveformSoon();
      if (MSTREAMPLAYER.playerStats.playing) _startWaveformRaf();
      return;
    }

    // localStorage cache hit
    const cached = _wfLsGet(filepath);
    if (cached) {
      _waveformData = cached;
      _waveformFp   = filepath;
      _setWaveformReady(true);
      _drawWaveformSoon();
      if (MSTREAMPLAYER.playerStats.playing) _startWaveformRaf();
      return;
    }

    // Clear while loading
    _waveformData = null;
    _waveformFp   = null;
    _setWaveformReady(false);
    _stopWaveformRaf();
    _drawWaveform();

    try {
      const url = MSTREAMAPI.currentServer.host +
        'api/v1/db/waveform?filepath=' + encodeURIComponent(filepath) +
        '&token=' + MSTREAMAPI.currentServer.token;
      const res = await fetch(url);
      if (!res.ok) return;
      const d = await res.json();
      // Guard against track having changed during async fetch
      if (MSTREAMPLAYER.playerStats.metadata.filepath !== filepath) return;
      if (d.waveform && d.waveform.length > 0) {
        _waveformData = d.waveform;
        _waveformFp   = filepath;
        _wfLsSet(filepath, d.waveform);
        _setWaveformReady(true);
        _drawWaveformSoon();
        if (MSTREAMPLAYER.playerStats.playing) _startWaveformRaf();
      }
    } catch (_e) { /* waveform unavailable — plain bar stays */ }
  }

  // ── WAVEFORM PREFETCH ──────────────────────────────────────────────────────
  // Called from addSongWizard when a track is added to the queue. Loads the
  // waveform into localStorage eagerly so the moment the track starts
  // playing, `_fetchWaveform` hits the cache and renders instantly —
  // eliminates the visible lag where the plain progress bar shows for
  // ~100-500ms before swapping to the waveform.
  //
  // Concurrency-capped so "Add All To Queue" on a 52-track album doesn't
  // fire 52 parallel HTTP requests at the server. Silently ignores:
  //   - radio/http(s) streams (no waveform on the server side)
  //   - anything already in-memory or already in localStorage
  //   - duplicate enqueues (dedup'd by filepath)
  // Deliberately 1, not 2. The server allows MAX_CONCURRENT_FFMPEG = 2
  // concurrent decodes (src/api/waveform.js), so a prefetch cap of 2 let
  // background warm-up hold BOTH slots — on a cold cache the waveform for
  // the track actually playing then queued behind album prefetches
  // (measured: 0.6-1.2s for mp3, 7.4s for flac, versus 0-1ms at a cap of
  // 1). Warm-up throughput barely moves (8 tracks: 6.2s -> 7.7s), and
  // nobody is watching the prefetch.
  const _WF_PREFETCH_MAX = 1;
  const _wfPrefetchQueue = [];
  const _wfPrefetchSeen = new Set(); // filepaths already queued/done this session
  let _wfPrefetchActive = 0;

  async function _prefetchWaveform(filepath) {
    if (!filepath || /^https?:\/\//i.test(filepath)) { return; }
    if (_wfPrefetchSeen.has(filepath)) { return; }
    if (_waveformFp === filepath && _waveformData) { return; }  // in memory
    if (_wfLsGet(filepath)) { return; }                          // localStorage
    _wfPrefetchSeen.add(filepath);
    _wfPrefetchQueue.push(filepath);
    _drainWfPrefetch();
  }

  function _drainWfPrefetch() {
    while (_wfPrefetchActive < _WF_PREFETCH_MAX && _wfPrefetchQueue.length) {
      const filepath = _wfPrefetchQueue.shift();
      _wfPrefetchActive++;
      (async () => {
        try {
          // Re-check localStorage under the lock — the currently-playing
          // track's own fetch may have filled the cache while we were
          // waiting in the concurrency queue.
          if (_wfLsGet(filepath)) { return; }
          const url = MSTREAMAPI.currentServer.host +
            'api/v1/db/waveform?filepath=' + encodeURIComponent(filepath) +
            '&token=' + MSTREAMAPI.currentServer.token;
          const res = await fetch(url);
          if (!res.ok) { return; }
          const d = await res.json();
          if (!d.waveform || d.waveform.length === 0) { return; }
          _wfLsSet(filepath, d.waveform);
          // If the operator hit Play while we were prefetching, fold this
          // data straight into the live render instead of waiting for the
          // currentSong watcher to re-fetch.
          const liveFp = MSTREAMPLAYER.playerStats.metadata.filepath;
          if (liveFp === filepath && !_waveformData) {
            _waveformData = d.waveform;
            _waveformFp   = filepath;
            _setWaveformReady(true);
            _drawWaveformSoon();
            if (MSTREAMPLAYER.playerStats.playing) { _startWaveformRaf(); }
          }
        } catch (_e) { /* swallow — best-effort */ }
        finally {
          _wfPrefetchActive--;
          _drainWfPrefetch();
        }
      })();
    }
  }

  // Exposed so the queue-add path can trigger prefetch.
  mstreamModule.prefetchWaveform = _prefetchWaveform;

  function _drawWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    if (W <= 0 || H <= 0) return;

    if (canvas.width !== W)  canvas.width  = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    if (!_waveformData || _waveformData.length === 0) return;

    const data   = _waveformData;
    const pct    = MSTREAMPLAYER.playerStats.duration > 0
      ? MSTREAMPLAYER.playerStats.currentTime / MSTREAMPLAYER.playerStats.duration
      : 0;
    const splitX = pct * W;
    const midY   = H / 2;
    const barW   = W / data.length;
    const drawW  = Math.max(1, barW > 2 ? barW - 1 : barW);

    // Pass 1: played region (left of splitX) — orange
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, H);
    ctx.clip();
    ctx.fillStyle = '#fa832b';
    for (let i = 0; i < data.length; i++) {
      const x    = (i / data.length) * W;
      const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
      ctx.fillRect(x, midY - barH / 2, drawW, barH);
    }
    ctx.restore();

    // Pass 2: unplayed region (right of splitX) — dim
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, W - splitX, H);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < data.length; i++) {
      const x    = (i / data.length) * W;
      const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
      ctx.fillRect(x, midY - barH / 2, drawW, barH);
    }
    ctx.restore();
  }

  // The only thing that moves between frames is the playhead, and
  // playerStats.currentTime is written from the audio element's timeupdate
  // event, which fires ~4 times a second. At 60 fps that means the vast
  // majority of frames redraw a bitmap identical to the one already on
  // screen — pixel-diffed at 97.4%. Each of those redraws is 1600
  // fillRects across two clipped passes, so the loop was burning a few
  // percent of a core continuously, for the whole of playback, to produce
  // no visible change.
  //
  // Skipping is keyed on the split position rounded to a whole pixel,
  // which is the only per-frame input to the drawing. The guard lives HERE
  // rather than inside _drawWaveform deliberately: several callers rely on
  // that function to CLEAR the canvas on track change, and short-circuiting
  // it would leave the previous song's waveform on screen.
  function _startWaveformRaf() {
    if (_waveformRaf) return;
    (function loop() {
      const canvas = document.getElementById('waveform-canvas');
      const w = canvas ? canvas.offsetWidth : 0;
      const dur = MSTREAMPLAYER.playerStats.duration;
      const pct = dur > 0 ? MSTREAMPLAYER.playerStats.currentTime / dur : 0;
      const splitPx = Math.round(pct * w);
      if (splitPx !== _wfLastSplitPx) {
        _wfLastSplitPx = splitPx;
        _drawWaveform();
      }
      _waveformRaf = requestAnimationFrame(loop);
    }());
  }

  function _stopWaveformRaf() {
    if (_waveformRaf) { cancelAnimationFrame(_waveformRaf); _waveformRaf = null; }
    _wfInvalidate();
    _drawWaveform(); // final redraw at resting position
  }

  // Redraw on window resize so the canvas doesn't appear stretched while paused
  window.addEventListener('resize', () => {
    _wfInvalidate();   // width changed, so the cached split pixel means nothing
    if (_waveformData) _drawWaveform();
  });

  mstreamModule.triggerWaveformFetch = _fetchWaveform;

  // Called by m.js init() with the ping response's `discovery` flag. This is
  // the ONLY thing that reveals the Discover panel — the webapp never probes
  // /api/v1/discovery/* to find out whether the feature exists.
  mstreamModule.setDiscoveryAvailable = (available) => {
    discoverState.available = available === true;
    if (discoverState.available) { playlistVue.refreshDiscover(); }
  };

  // Ping's discoveryP2p flag — reveals the "From the network" section inside
  // the Discover panel. Independent of `available`: a server can run the
  // network without local analysis (rare) or vice versa (common).
  mstreamModule.setDiscoveryP2pAvailable = (available) => {
    discoverState.p2p.available = available === true;
  };

  // Ping's discoveryPlugins flag — the network/peer rows get an action menu
  // instead of the bare copy. The plug-in list is fetched on first use and
  // forgotten on a flag change (a server switch), never probed up front.
  mstreamModule.setDiscoveryPluginsAvailable = (available) => {
    discoverState.plugins.available = available === true;
    discoverState.plugins.list = null;
    discoverState.plugins.jobsAllowed = false;
    discoverState.plugins.maxFolderSongs = null;
    discoverPluginsPromise = null;
    discoverState.dest = { view: null };
    discoverState.tray.jobs = [];
    if (discoverJobsTimer) { clearTimeout(discoverJobsTimer); discoverJobsTimer = null; }
    // The strip's one up-front request: this account's jobs (one may still
    // be running, or have failed, since an earlier visit).
    if (discoverState.plugins.available) { playlistVue.refreshDiscoverJobs(); }
    // A window's tile and Peer Recommendations' clip stop where they are
    // (the main player is not resumed for them), and the visit's previews
    // and earned art are forgotten.
    asideStop('window', false);
    asideStop('clip', false);
    playlistVue.clipReset();
    discoverState.menu = { key: null, loading: false, links: [], error: false, previews: {}, playing: null };
  };

  // Ping's federationDiscovery flag — reveals the "From your peers" section.
  // True only when federation is on, local embeddings exist, and at least
  // one paired peer is opted into discovery queries.
  mstreamModule.setFederationDiscoveryAvailable = (available) => {
    discoverState.fed.available = available === true;
  };

  // Admins see the "Invite <peer> to federate" row in the recommendation
  // modal (/api/'s `user.admin`; a server without /api/ = false).
  mstreamModule.setAdmin = (admin) => {
    discoverState.admin = admin === true;
  };

  // ── The Discover page (m.js discoveryPanel) ─────────────────────────────
  // The page draws in #browser but reuses this panel's recommendation
  // window, plug-in list and job poll; playlistVue is private to this file,
  // so these thin wrappers are the page's only way in. The behaviour is the
  // panel's own (and so are its flags: no plug-ins → a network row copies
  // its title, as the panel's rows do).

  // Open the window for one network ('p2p') or peers ('federation') row —
  // the row exactly as the taste route returned it, or what a connected
  // server's page names. opts: what its match bar names — { seedTitle }
  // (the row's seed) or { seedPlain } (a phrase: the row was matched
  // against the seeds' centroid) — and, from a connected server's pages,
  // { focus, scope, from: 'browse', hide, folder, opener }: every option
  // is said at playlistVue.openDiscoverModal.
  mstreamModule.openDiscoverModal = (track, source, opts) => {
    if (!track || typeof track !== 'object' || (source !== 'p2p' && source !== 'federation')) { return Promise.resolve(); }
    return playlistVue.openDiscoverModal(track, source, opts);
  };

  // The plug-in list, whether this account may start jobs and the most
  // songs one folder copy takes here (the listing's jobs.maxFolderSongs;
  // null = an older server, which does not say) — the one fetch the
  // panel's window shares. → { available, list, jobsAllowed,
  // maxFolderSongs }; without the discoveryPlugins flag nothing is fetched.
  mstreamModule.ensureDiscoverPlugins = () => {
    const none = { available: false, list: [], jobsAllowed: false, maxFolderSongs: null };
    if (!discoverState.plugins.available) { return Promise.resolve(none); }
    return Promise.resolve(playlistVue.ensureDiscoverPlugins())
      .then((list) => ({ available: true, list: Array.isArray(list) ? list : [], jobsAllowed: discoverState.plugins.jobsAllowed === true, maxFolderSongs: discoverState.plugins.maxFolderSongs }))
      .catch(() => ({ available: true, list: [], jobsAllowed: false, maxFolderSongs: null }));
  };

  // Queue one peers row through the federation stream proxy (the panel's
  // own verb: lite metadata off the row, no local lookup).
  mstreamModule.queueDiscoverFed = (ft) => {
    if (!ft || !ft.peer || ft.peer.id == null || !ft.filepath) { return; }
    playlistVue.queueDiscoverFed(ft);
  };

  // Re-read this account's plug-in jobs now (the strip's poll — it keeps
  // beating by itself only while a job is live). → the fresh list.
  mstreamModule.refreshDiscoverJobs = () => {
    if (!discoverState.plugins.available) { return Promise.resolve([]); }
    return Promise.resolve(playlistVue.refreshDiscoverJobs()).then(() => discoverState.tray.jobs.slice());
  };

  // The account's jobs as of the last poll, newest first — what the page
  // merges onto its rows by recommendation key (DISCOVERYPAGE.jobBadges).
  mstreamModule.discoverJobs = () => discoverState.tray.jobs.slice();

  // The same, for one row: its keys (the batch lookup's `key` + `keys`)
  // → { slot: job }, one per plug-in and scope (DISCOVERJOBS.jobsBySlot).
  mstreamModule.discoverJobsBySlot = (keys) => {
    const jobs = discoverState.tray.jobs;
    return DISCOVERJOBS.jobsBySlot(Array.isArray(keys) ? jobs.filter((j) => keys.indexOf(j.key) !== -1) : jobs);
  };

  // Call fn(jobs) whenever the job list changes (a poll, or a job the
  // window just started). → the unwatch function; the page calls it when
  // it is left.
  mstreamModule.watchDiscoverJobs = (fn) => {
    if (typeof fn !== 'function') { return () => {}; }
    return playlistVue.$watch(() => discoverState.tray.jobs, (jobs) => fn(jobs.slice()));
  };

  // The plug-in listing as m.js's ways in just read it (keepGateRead): the
  // window's own copy becomes it — the list, whether this account may start
  // jobs, the folder cap — so a window opened from a way in never holds an
  // older listing than the page that offered it (a copy plug-in switched
  // on or off, a right granted or taken since the window last asked).
  mstreamModule.takeDiscoverPlugins = (listing) => {
    if (!discoverState.plugins.available || !listing || typeof listing !== 'object') { return; }
    discoverState.plugins.list = Array.isArray(listing.plugins) ? listing.plugins : [];
    discoverState.plugins.jobsAllowed = !!(listing.jobs && listing.jobs.allowed === true);
    discoverState.plugins.maxFolderSongs = DISCOVERJOBS.maxFolderSongs(listing);
    discoverPluginsPromise = null;
  };

  // Call fn() when the window learned that Keep a copy's gate may have
  // changed (SPEC-fed §3): a destination saved in its editor, a start
  // refused with 403 (a right gone) or 404 (the copy plug-in gone) — the
  // pages read their gate cache again then. → the unwatch function.
  mstreamModule.watchKeepGate = (fn) => {
    if (typeof fn !== 'function') { return () => {}; }
    discoverGateWatchers.push(fn);
    return () => { const at = discoverGateWatchers.indexOf(fn); if (at !== -1) { discoverGateWatchers.splice(at, 1); } };
  };

  // ── Peer Recommendations' clip (m.js, the page) ──────────────────────────
  // The page's play icons, its band and Preview all drive the one clip the
  // window's Preview section shows too (playlistVue.clipStart and the rest:
  // every rule is said there). A lead is the raw taste lead, as the page's
  // rows hold it (DISCOVERYPAGE.networkRows' raw); opts.tile = its tile.
  mstreamModule.clipToggle = (raw, opts) => {
    if (!raw || typeof raw !== 'object') { return Promise.resolve(); }
    return Promise.resolve(playlistVue.clipToggle(raw, opts));
  };
  mstreamModule.clipStart = (raw, opts) => {
    if (!raw || typeof raw !== 'object') { return Promise.resolve(); }
    return playlistVue.clipStart(raw, opts);
  };
  // → whether it asked (false: a resolve out or queued, the lead answered
  // already, no preview plug-in).
  mstreamModule.clipPrefetch = (raw) => {
    if (!raw || typeof raw !== 'object') { return Promise.resolve(false); }
    return playlistVue.clipPrefetch(raw);
  };
  mstreamModule.clipPause = () => playlistVue.clipPause();
  mstreamModule.clipResume = () => playlistVue.clipResume();
  mstreamModule.clipStop = (why) => playlistVue.clipStop(why);
  mstreamModule.clipReset = () => playlistVue.clipReset();
  // { key, raw, tile, status, preview, at, seconds, live }
  mstreamModule.clipState = () => playlistVue.clipState();
  // The artwork a preview earned for a tile key this visit, else null.
  mstreamModule.clipArt = (tileKey) => (typeof tileKey === 'string' && discoverState.clip.art[tileKey]) || null;
  // What the visit's resolves answered for a lead: { status: 'ready' |
  // 'none', preview }, else null (never asked, or only failed).
  mstreamModule.clipResult = (raw) => {
    const r = raw && typeof raw === 'object' ? discoverState.clip.results[PEERRECS.leadKey(raw)] : null;
    return r ? { status: r.status, preview: r.preview } : null;
  };
  // Call fn(event) on every clip event: { type, key, state, …extra } —
  // resolving · waiting { ms } · playing · paused · time · art { tileKey,
  // url } · ended · none · failed · stopped { why: user | preempted | main
  // | reset | … } · reset · off. → the unwatch function.
  mstreamModule.watchClip = (fn) => {
    if (typeof fn !== 'function') { return () => {}; }
    clipWatchers.push(fn);
    return () => { const at = clipWatchers.indexOf(fn); if (at !== -1) { clipWatchers.splice(at, 1); } };
  };

  return mstreamModule;
})()
