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
      onlyPeer: null,         // { id, name } while "more like this on <peer>" narrows the ask
    },
    // Discovery plug-ins: what this server lets a user DO with a network or
    // peer row (/api/v1/discovery/plugins). Same reveal contract — ping's
    // discoveryPlugins flag, never a probe; the list is fetched on the first
    // menu open. Without plug-ins a row click falls back to the copy.
    plugins: {
      available: false,
      list: null,             // null = not fetched yet
      jobsAllowed: false,     // the listing's jobs.allowed — may this account start jobs
    },
    // The collection destination — where "Add to your collection" copies and
    // kept downloads land (GET /api/v1/discovery/collection/destination).
    // Fetched with the first window that could use it. `view.destination`
    // null = nowhere to put a file (uploads off, no library): the copy row,
    // the bar and Keep… stay hidden rather than fail.
    dest: {
      loaded: false,
      view: null,
    },
    // The downloads strip under the panel: the caller's plug-in jobs that
    // still want them (live, waiting to be kept, failed). Shows only while
    // there are any.
    tray: {
      jobs: [],
      collapsed: (() => { try { return localStorage.getItem('discoverTrayCollapsed') === 'true'; } catch (_) { return false; } })(),
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
    // dropped. `view` is the peer rows' Federation | Plug-Ins selector.
    // links / previews / playing = the plug-in sections; peer / file /
    // album / artist = the facts a peer row's Federation view fetches;
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
      view: 'federation',     // 'federation' | 'plugins'
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
      jobs: {},
      jobBusy: {},
      jobErrors: {},
      picker: null,
    }, over || {});
  }
  let discoverDebounce = null;
  let discoverReqId = 0;
  let discoverDirty = false;   // song changed while collapsed → refetch on expand
  // The one 30-second preview clip playing from a row menu, and whether we
  // paused the main player to make room for it.
  let discoverPreviewAudio = null;
  let discoverPreviewPausedMain = false;
  // Recommendation modal bookkeeping: a generation counter that fences
  // async answers, the peer rows' last selector choice (remembered for the
  // session), and the Esc handler installed only while a window is open.
  let discoverModalGen = 0;
  let discoverModalView = 'federation';
  function onDiscoverModalKey(e) {
    if (e.key !== 'Escape') { return; }
    // Esc closes the innermost thing first: the folder tree, the
    // destination form, then the window.
    const picker = discoverState.modal.picker;
    if (picker && picker.browse) { picker.browse = null; return; }
    if (picker) { discoverState.modal.picker = null; return; }
    playlistVue.closeDiscoverModal();
  }
  // Plug-in jobs: the one in-flight fetch of the plug-in list (the window's
  // sections and the strip all wait on the same answer), the poll timer, and
  // whether the hidden-tab listener is installed. Polling runs only while a
  // job is live and the tab is visible.
  let discoverPluginsPromise = null;
  let discoverJobsTimer = null;
  let discoverJobsVisibilityHooked = false;
  let discoverJobsFailures = 0;   // consecutive failed polls — the beat slows while the server is away

  // Icons the job rows and the downloads strip share (24-unit box).
  const DM_ICONS = {
    download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    play: 'M8 5v14l11-7z',
    plus: 'M13 11h8v2h-8v8h-2v-8H3v-2h8V3h2v8z',
    retry: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    chevron: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
    up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  };
  Vue.component('dm-icon', {
    props: { name: String, size: { type: Number, default: 16 } },
    computed: { path: function () { return DM_ICONS[this.name] || ''; } },
    template: '<svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24"><path fill="currentColor" :d="path"/></svg>',
  });

  // One plug-in's row in the recommendation window — "Get it" and "Add to
  // your collection" are the same thing: the row IS its job. `row` comes
  // from DISCOVERJOBS.jobRowState; the buttons only say what was pressed.
  Vue.component('dm-job-row', {
    props: { title: String, idleSub: String, startLabel: String, startIcon: { type: String, default: 'download' }, hint: String, row: Object, busy: Boolean, canKeep: Boolean },
    methods: {
      tt: function (key, params) { return (typeof t === 'function') ? t(key, params) : key; },
      has: function (action) { return this.row.actions.indexOf(action) !== -1 && (action !== 'keep' || this.canKeep); },
      sub: function () {
        const part = this.row.sub;
        if (!part) { return this.idleSub || ''; }
        return part.key ? this.tt(part.key, part.params) : String(part.text || '');
      },
    },
    template: `
      <div class="dm-opt" :class="{ 'dm-opt-muted': row.muted, 'dm-opt-wrap': row.actions.length > 2 }">
        <div class="dm-opt-ic" :class="{ 'dm-opt-ic-on': row.iconCls === 'on', 'dm-opt-ic-ok': row.iconCls === 'ok', 'dm-opt-ic-err': row.iconCls === 'err' }"><dm-icon :name="row.icon"></dm-icon></div>
        <div class="dm-opt-body">
          <div class="dm-opt-title" :title="hint">{{ title }}<span v-if="row.tag" class="dm-tag" :class="{ 'dm-tag-ok': row.tagCls === 'ok', 'dm-tag-src': row.tagCls === 'src', 'dm-tag-err': row.tagCls === 'err' }">{{ tt(row.tag) }}</span></div>
          <div class="dm-opt-sub" :class="{ 'dm-opt-sub-err': row.errored }" :title="sub()">{{ sub() }}</div>
          <div v-if="row.progress !== null" class="dm-progress" :class="{ 'dm-progress-indet': row.progress === 'indeterminate' }" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="row.progress === 'indeterminate' ? null : row.progress"><i :style="row.progress === 'indeterminate' ? null : { width: row.progress + '%' }"></i></div>
        </div>
        <div class="dm-opt-act">
          <a v-if="has('play')" class="dm-btn dm-btn-sm dm-btn-primary" href="javascript:void(0)" v-on:click="$emit('play')"><dm-icon name="play" :size="14"></dm-icon>{{ tt('discover.modal.play') }}</a>
          <a v-if="has('queue')" class="dm-btn dm-btn-sm" href="javascript:void(0)" v-on:click="$emit('queue')"><dm-icon name="plus" :size="14"></dm-icon>{{ tt('discover.modal.queue') }}</a>
          <a v-if="has('keep')" class="dm-btn dm-btn-sm" href="javascript:void(0)" v-on:click="$emit('keep')"><dm-icon name="folder" :size="14"></dm-icon>{{ tt('discover.modal.keep') }}</a>
          <a v-if="has('start')" class="dm-btn dm-btn-sm dm-btn-primary" :class="{ 'is-disabled': busy }" href="javascript:void(0)" v-on:click="$emit('start')"><dm-icon :name="startIcon" :size="14"></dm-icon>{{ startLabel }}</a>
          <a v-if="has('retry')" class="dm-btn dm-btn-sm" :class="{ 'is-disabled': busy }" href="javascript:void(0)" v-on:click="$emit('start')"><dm-icon name="retry" :size="14"></dm-icon>{{ tt('discover.job.retry') }}</a>
          <a v-if="has('cancel')" class="dm-btn dm-btn-sm dm-btn-ghost" href="javascript:void(0)" v-on:click="$emit('cancel')">{{ tt('discover.modal.cancel') }}</a>
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
        this.discover.fed.onlyPeer = null;   // a fresh ask is every peer again
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
      // the queue + now-playing card render without any local lookup.
      queueDiscoverFed: function (ft) {
        mstreamModule.addFederationSongWizard(ft.peer, ft.filepath, {
          title: ft.title || '',
          artist: ft.artist || '',
          duration: ft.duration || null,
        }, true);
      },
      // ── Recommendation modal ───────────────────────────────────────────
      // One window for a network or peer row (docs/designs/discover-modal).
      // Translations inside v-if blocks: the data-i18n scan only sees nodes
      // present at load, so dynamic text goes through t() directly.
      tt: function (key, params) {
        return (typeof t === 'function') ? t(key, params) : key;
      },
      dmDuration: function (seconds) {
        const s = Math.round(Number(seconds) || 0);
        if (!s) { return ''; }
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      },
      dmPct: function (track) {
        return Math.round(((track && track.similarity) || 0) * 100);
      },
      // Header artwork: the peer's own art file for a peer row, else the
      // first preview provider that answered with artwork.
      dmArt: function () {
        const m = this.discover.modal;
        if (!m.open) { return null; }
        if (m.source === 'federation' && m.file && m.file.art && m.track.peer) {
          return MSTREAMAPI.peerArtUrl(m.track.peer.id, m.file.art, 's');
        }
        for (const name of Object.keys(m.previews || {})) {
          const p = m.previews[name] && m.previews[name].preview;
          if (p && p.artwork) { return p.artwork; }
        }
        return null;
      },
      // "<peer> online · last seen 2 min ago" from the peers listing —
      // as of the last contact, which is all the server knows.
      dmPeerStatus: function () {
        const p = this.discover.modal.peer;
        if (!p) { return ''; }
        const online = p.lastStatus === 'ok';
        const seen = p.lastSeen ? this.dmAgo(p.lastSeen) : this.tt('discover.modal.never');
        return `${p.name} ${this.tt(online ? 'discover.modal.online' : 'discover.modal.offline')} · ${this.tt('discover.modal.lastSeen')} ${seen}`;
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
      // server strips what it doesn't know.
      dmRecommendation: function () {
        const m = this.discover.modal;
        return { ...m.track, source: m.source, filepath: m.source === 'federation' ? m.track.filepath : null };
      },
      dmLive: function (gen) {
        return this.discover.modal.open && this.discover.modal.gen === gen;
      },
      // Open the window for one row. A network row with neither plug-ins
      // nor an admin's invite row keeps the old behaviour: copy the title.
      openDiscoverModal: async function (track, source) {
        if (source === 'p2p' && !this.discover.plugins.available && !this.discover.admin) { return this.copyDiscoverP2p(track); }
        this.stopDiscoverPreview();
        const gen = ++discoverModalGen;
        this.discover.modal = blankDiscoverModal({
          open: true, gen, source, track,
          view: (source === 'federation' && this.discover.plugins.available) ? discoverModalView : (source === 'federation' ? 'federation' : 'plugins'),
        });
        document.addEventListener('keydown', onDiscoverModalKey);
        this.$nextTick(() => { const el = this.$refs.dmodalClose; if (el && el.focus) { el.focus(); } });
        const jobs = [];
        if (this.discover.plugins.available) { jobs.push(this.dmLoadLinks(gen)); jobs.push(this.dmLoadJobs(gen)); }
        if (source === 'federation') { jobs.push(this.dmLoadPeerFacts(gen)); }
        if (source === 'p2p' && this.discover.admin) { jobs.push(this.dmLoadFederate(gen)); }
        await Promise.all(jobs);
      },
      closeDiscoverModal: function () {
        this.stopDiscoverPreview();
        document.removeEventListener('keydown', onDiscoverModalKey);
        discoverModalGen++;
        this.discover.modal = blankDiscoverModal({ gen: discoverModalGen });
        this.scheduleDiscoverJobsPoll();   // back to the strip's slower beat
      },
      // Peer rows: Federation | Plug-Ins. The choice is remembered for the
      // session; switching to Federation stops a preview clip.
      setDiscoverModalView: function (view) {
        this.discover.modal.view = view;
        discoverModalView = view;
        this.discover.modal.picker = null;   // the form belongs to the view it was opened in
        if (view === 'federation') { this.stopDiscoverPreview(); }
      },
      dmLoadLinks: async function (gen) {
        this.discover.modal.loading = true;
        try {
          await this.ensureDiscoverPlugins();
          if (!this.dmLive(gen)) { return; }
          const linksPlugin = this.discoverLinksPlugin();
          let links = [];
          if (linksPlugin) {
            const res = await MSTREAMAPI.discoveryPluginResolve(linksPlugin.name, this.dmRecommendation());
            if (!res || res.disabled) { throw new Error('resolve failed'); }
            links = (res.result && res.result.links) || [];
          }
          if (!this.dmLive(gen)) { return; }
          this.discover.modal.links = links;
          this.discover.modal.loading = false;
        } catch (_) {
          if (!this.dmLive(gen)) { return; }
          this.discover.modal.loading = false;
          this.discover.modal.error = true;
        }
      },
      // A peer row's Federation view: the peer's status from the peers
      // listing, the file's own facts (format, size, art) from its metadata
      // route, album and artist facts through the read proxy, and what of
      // that artist this library already holds. Every call is optional —
      // a missing answer leaves its line blank.
      dmLoadPeerFacts: async function (gen) {
        const track = this.discover.modal.track;
        const peerId = track.peer && track.peer.id;
        if (!peerId) { return; }
        const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
        const [peers, meta, albumSongs, peerAlbums, localAlbums] = await Promise.all([
          settle(MSTREAMAPI.federationPeers()),
          settle(MSTREAMAPI.peer.metadata(peerId, track.filepath)),
          track.album ? settle(MSTREAMAPI.peer.albumSongs(peerId, { album: track.album, artist: track.artist || null, year: track.year || null })) : Promise.resolve(null),
          track.artist ? settle(MSTREAMAPI.peer.artistAlbums(peerId, { artist: track.artist })) : Promise.resolve(null),
          track.artist ? settle(MSTREAMAPI.artistAlbums({ artist: track.artist })) : Promise.resolve(null),
        ]);
        if (!this.dmLive(gen)) { return; }
        const peer = peers && Array.isArray(peers.peers) ? peers.peers.find((p) => p.id === peerId) : null;
        this.discover.modal.peer = peer
          ? { name: peer.name || track.peer.name || 'peer', lastSeen: peer.lastSeen || null, lastStatus: peer.lastStatus || null }
          : null;
        const md = meta && typeof meta === 'object' ? (meta.metadata || meta) : null;
        this.discover.modal.file = md && typeof md === 'object' && !md.error
          ? { format: md.format || null, art: md['album-art'] || null, metadata: md }
          : null;
        const norm = (s) => String(s || '').trim().toLowerCase();
        const localList = localAlbums && Array.isArray(localAlbums.albums) ? localAlbums.albums : [];
        const songs = Array.isArray(albumSongs) ? albumSongs : null;
        this.discover.modal.album = track.album ? {
          songs,
          count: songs ? songs.length : null,
          seconds: songs ? songs.reduce((sum, s) => sum + ((s.metadata && Number(s.metadata.duration)) || 0), 0) : null,
          owned: localList.some((a) => norm(a.name) === norm(track.album)),
        } : null;
        const remote = peerAlbums && Array.isArray(peerAlbums.albums) ? peerAlbums.albums : null;
        const years = remote ? remote.map((a) => Number(a.year_min || a.year)).filter((y) => y > 0) : [];
        this.discover.modal.artist = track.artist ? {
          albums: remote ? remote.length : null,
          songs: remote ? remote.reduce((sum, a) => sum + (Number(a.track_count) || 0), 0) : null,
          yearMin: years.length ? Math.min(...years) : null,
          yearMax: remote ? Math.max(...remote.map((a) => Number(a.year_max || a.year) || 0), 0) || null : null,
          owned: localList.length,
        } : null;
      },
      // ── Federation view actions ────────────────────────────────────────
      dmSongMeta: function () {
        const m = this.discover.modal;
        const t = m.track;
        const base = { title: t.title || '', artist: t.artist || '', album: t.album || '', year: t.year || null, duration: t.duration || null };
        return (m.file && m.file.metadata) ? { ...base, ...m.file.metadata } : base;
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
      // View album / View artist open the peer's album or artist in the
      // browser panel, the way goToAlbum / goToArtist do for the playing
      // track: the element carries the peer so the panel resolves on that
      // server (adoptPeer).
      dmViewAlbum: function () {
        const m = this.discover.modal;
        const el = document.createElement('DIV');
        el.setAttribute('data-album', m.track.album);
        if (m.track.artist) { el.setAttribute('data-artist', m.track.artist); }
        if (m.track.year) { el.setAttribute('data-year', String(m.track.year)); }
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
      // Play album replaces the queue with the album; Add album appends it.
      dmQueueAlbum: async function (play) {
        const m = this.discover.modal;
        const gen = m.gen;
        let songs = m.album && m.album.songs;
        if (!songs) {
          try {
            songs = await MSTREAMAPI.peer.albumSongs(m.track.peer.id, { album: m.track.album, artist: m.track.artist || null, year: m.track.year || null });
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
        this.closeDiscoverModal();
        if (!play) { iziToast.success({ title: this.tt('discover.modal.albumQueued', { count: songs.length }), position: 'topCenter', timeout: 2000 }); }
      },
      // "More like this on <peer>": the same similar ask, narrowed to that
      // one paired server; the panel shows the narrowing as a chip.
      dmMoreLikeThisOnPeer: async function () {
        const m = this.discover.modal;
        const peer = m.track.peer;
        const seedPath = this.discover.seedPath;
        if (!seedPath || !peer) { return; }
        this.closeDiscoverModal();
        this.discover.fed.onlyPeer = { id: peer.id, name: peer.name || 'peer' };
        const reqId = ++discoverReqId;
        this.discover.loading = true;
        const fed = await MSTREAMAPI.discoveryFederationSimilar(seedPath, 5, this.discover.p2p.newArtistsOnly, peer.id);
        if (reqId !== discoverReqId) { return; }
        this.discover.loading = false;
        if (fed && !fed.disabled && Array.isArray(fed.results)) {
          this.discover.fed.tracks = fed.results;
          this.discover.fed.searchedPeers = (fed.searched && fed.searched.peers) || 0;
          this.discover.fed.unreachable = (fed.searched && fed.searched.unreachable) || 0;
          this.discover.fed.mismatched = (fed.searched && fed.searched.mismatched) || 0;
        }
      },
      clearDiscoverPeerFilter: function () {
        this.discover.fed.onlyPeer = null;
        this.refreshDiscover();
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
      // was playing.
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
      playDiscoverPreview: function (name, preview) {
        this.stopDiscoverPreview();
        if (typeof MSTREAMPLAYER !== 'undefined' && MSTREAMPLAYER.playerStats && MSTREAMPLAYER.playerStats.playing === true) {
          discoverPreviewPausedMain = true;
          MSTREAMPLAYER.playPause();
        }
        const audio = new Audio(preview.url);
        discoverPreviewAudio = audio;
        this.discover.modal.playing = name;
        const done = () => { if (discoverPreviewAudio === audio) { this.stopDiscoverPreview(); } };
        audio.addEventListener('ended', done);
        audio.addEventListener('error', done);
        audio.play().catch(done);
      },
      stopDiscoverPreview: function () {
        if (discoverPreviewAudio) {
          try { discoverPreviewAudio.pause(); } catch (_) { /* already gone */ }
          discoverPreviewAudio = null;
        }
        if (this.discover.modal) { this.discover.modal.playing = null; }
        if (discoverPreviewPausedMain) {
          discoverPreviewPausedMain = false;
          if (typeof MSTREAMPLAYER !== 'undefined' && MSTREAMPLAYER.playerStats && MSTREAMPLAYER.playerStats.playing !== true) {
            MSTREAMPLAYER.playPause();
          }
        }
      },

      // ── Plug-in jobs: Get it · Add to your collection · the strip ──────
      // A row IS its job (alpha/discover-jobs.js turns one into what the row
      // shows). Rows exist only for what would work: the plug-in listed (on,
      // and its probe passing), this account allowed to start jobs, and —
      // for a copy or Keep… — somewhere to put the file.
      ensureDiscoverPlugins: function () {
        if (this.discover.plugins.list) { return Promise.resolve(this.discover.plugins.list); }
        if (!discoverPluginsPromise) {
          const host = MSTREAMAPI.currentServer.host;
          const pending = MSTREAMAPI.discoveryPlugins().then((res) => {
            if (discoverPluginsPromise === pending) { discoverPluginsPromise = null; }
            if (host !== MSTREAMAPI.currentServer.host) { return []; }   // the app moved to another server meanwhile
            this.discover.plugins.list = (res && res.plugins) || [];
            this.discover.plugins.jobsAllowed = !!(res && res.jobs && res.jobs.allowed === true);
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
      // "Get it": every acquire plug-in but the peer copy, which belongs to
      // the Federation view. One { plugin, row } per plug-in.
      dmGetItRows: function () {
        return this.discoverAcquirePlugins()
          .filter((p) => p.name !== DISCOVERJOBS.COPY_PLUGIN)
          .map((plugin) => ({ plugin, row: this.dmJobRow(plugin.name) }));
      },
      // "Add to your collection": none or one.
      dmCopyRows: function () {
        if (this.discover.modal.source !== 'federation' || !this.dmHasDestination()) { return []; }
        return this.discoverAcquirePlugins()
          .filter((p) => p.name === DISCOVERJOBS.COPY_PLUGIN)
          .map((plugin) => ({ plugin, row: this.dmJobRow(plugin.name) }));
      },
      dmJobRow: function (name) {
        const m = this.discover.modal;
        const row = DISCOVERJOBS.jobRowState(m.jobs[name] || null, { plugin: name });
        const err = m.jobErrors[name];
        return err ? Object.assign({}, row, { sub: { text: err }, errored: true }) : row;
      },
      dmAnyJobLive: function () {
        const jobs = this.discover.modal.jobs;
        return Object.keys(jobs).some((n) => DISCOVERJOBS.isLive(jobs[n]));
      },
      // A row's line: an i18n key with params, or the server's own text.
      dmText: function (part) {
        if (!part) { return ''; }
        return part.key ? this.tt(part.key, part.params) : String(part.text || '');
      },
      dmErrorText: function (err) {
        const body = err && err.body;
        return (body && typeof body.error === 'string' && body.error) || this.tt('discover.job.requestFailed');
      },
      // What this account already did with the recommendation, and where
      // files go — both only when a row could use them.
      dmLoadJobs: async function (gen) {
        await this.ensureDiscoverPlugins();
        if (!this.dmLive(gen) || this.discoverAcquirePlugins().length === 0) { return; }
        const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
        const [found, dest] = await Promise.all([
          settle(MSTREAMAPI.discoveryJobLookup(this.dmRecommendation())),
          this.discover.dest.loaded ? Promise.resolve(null) : settle(MSTREAMAPI.discoveryDestination()),
        ]);
        if (dest) { this.discover.dest.view = dest; this.discover.dest.loaded = true; }
        if (!this.dmLive(gen)) { return; }
        if (found) {
          this.discover.modal.recKey = found.key || null;
          this.discover.modal.jobs = DISCOVERJOBS.jobsByPlugin(found.jobs);
        }
        this.scheduleDiscoverJobsPoll();
      },
      dmJobStart: async function (plugin) {
        const name = plugin.name;
        const gen = this.discover.modal.gen;
        if (this.discover.modal.jobBusy[name]) { return; }
        this.$set(this.discover.modal.jobBusy, name, true);
        this.$delete(this.discover.modal.jobErrors, name);
        try {
          const res = await MSTREAMAPI.discoveryJobStart(name, this.dmRecommendation());
          if (res && res.job) {
            this.noteDiscoverJob(res.job);
            if (this.dmLive(gen)) {
              this.$set(this.discover.modal.jobs, name, res.job);
              if (!this.discover.modal.recKey) { this.discover.modal.recKey = res.job.key || null; }
            }
          }
        } catch (err) {
          if (this.dmLive(gen)) { this.$set(this.discover.modal.jobErrors, name, this.dmErrorText(err)); }
        }
        if (this.dmLive(gen)) { this.$set(this.discover.modal.jobBusy, name, false); }
        this.scheduleDiscoverJobsPoll();
      },
      dmJobCancel: async function (plugin) {
        const job = this.discover.modal.jobs[plugin.name];
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

      // ── Collection destination: the bar and the picker ─────────────────
      // Where copies land for THIS song under the saved destination (the
      // bar), and under the one being typed (the picker's preview). The
      // server renders the real path from the file's own tags; this is the
      // same engine on what the window knows.
      dmLayoutTags: function () {
        const m = this.discover.modal;
        const t = m.track || {};
        const md = (m.picker && m.picker.mode === 'keep') ? null : (m.file && m.file.metadata);
        const g = md && Array.isArray(md.genres) ? md.genres[0] : null;
        return {
          artist: (md && (md['artist-display'] || md.artist)) || t.artist || null,
          album: (md && md.album) || t.album || null,
          year: (md && md.year) || t.year || null,
          genre: g || null,
          albumartist: null,
        };
      },
      dmLayoutFile: function () {
        const m = this.discover.modal;
        if (m.picker && m.picker.mode === 'keep') {
          const job = m.jobs[m.picker.plugin];
          const at = job && job.result && job.result.downloaded && job.result.downloaded.filepath;
          return at || 'track';
        }
        return (m.track && m.track.filepath) || 'track';
      },
      dmLayoutPeer: function () {
        const m = this.discover.modal;
        if (m.picker && m.picker.mode === 'keep') { return null; }   // a download has no peer; {{PEER}} drops out
        return (m.source === 'federation' && m.track && m.track.peer && m.track.peer.name) || null;
      },
      dmDestCrumbs: function () {
        const d = this.discover.dest.view && this.discover.dest.view.destination;
        if (!d) { return []; }
        const p = DISCOVERJOBS.previewTarget({ vpath: d.vpath, base: d.base, layout: d.layout, tags: this.dmLayoutTags(), peerName: this.dmLayoutPeer(), fileName: this.dmLayoutFile() });
        return DISCOVERJOBS.pathCrumbs(p.valid ? p.relDir : d.base);
      },
      dmOpenPicker: function (mode, plugin) {
        const d = this.discover.dest.view && this.discover.dest.view.destination;
        if (!d) { return; }
        this.discover.modal.picker = {
          mode, plugin: plugin ? plugin.name : null,
          vpath: d.vpath, base: d.base || '', layout: d.layout,
          remember: true, browse: null, saving: false, error: '',
        };
        // The form opens where the bar lives, above the rows; a Keep…
        // pressed further down the window brings it into view.
        this.$nextTick(() => {
          const el = this.$refs.dmPicker;
          if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
        });
      },
      // What an acquire plug-in searches for, as the idle row says it.
      dmSearchWords: function () {
        const t = this.discover.modal.track || {};
        return [t.artist, t.title].filter(Boolean).join(' ');
      },
      dmClosePicker: function () {
        this.discover.modal.picker = null;
      },
      dmPickerLibraries: function () {
        const v = this.discover.dest.view;
        return (v && v.libraries) || [];
      },
      dmPickerVars: function () {
        const v = this.discover.dest.view;
        return (v && v.variables) || DISCOVERJOBS.LAYOUT_VARS;
      },
      dmPickerPreview: function () {
        const k = this.discover.modal.picker;
        if (!k) { return null; }
        return DISCOVERJOBS.previewTarget({ vpath: k.vpath, base: k.base, layout: k.layout, tags: this.dmLayoutTags(), peerName: this.dmLayoutPeer(), fileName: this.dmLayoutFile() });
      },
      // The engine's refusal in words (the server's codes, one table).
      dmPickerProblem: function (preview) {
        if (!preview || preview.valid) { return ''; }
        if (preview.error === 'unknown_variable') {
          return this.tt('discover.modal.dest.errUnknownVar', { name: preview.variable || '', vars: this.dmPickerVars().join(', ') });
        }
        const known = ['empty_template', 'unbalanced_braces', 'absolute_template', 'traversal', 'empty_path'];
        return this.tt(known.indexOf(preview.error) !== -1 ? 'discover.modal.dest.err.' + preview.error : 'discover.modal.dest.errGeneric');
      },
      dmVarToken: function (name) {
        return '{' + '{' + name + '}' + '}';
      },
      // A variable chip drops {{VAR}} where the caret is.
      dmInsertVar: function (name) {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        const token = '{{' + name + '}}';
        const el = this.$refs.dmLayoutInput;
        const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : k.layout.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
        k.layout = k.layout.slice(0, at) + token + k.layout.slice(end);
        this.$nextTick(() => {
          if (!el || !el.focus) { return; }
          el.focus();
          try { el.setSelectionRange(at + token.length, at + token.length); } catch (_) { /* not a text input */ }
        });
      },
      // The "library template" chip: the chosen library's admin Path
      // Template, else the plain default.
      dmUseLibraryTemplate: function () {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        const lib = this.dmPickerLibraries().find((l) => l.vpath === k.vpath);
        const v = this.discover.dest.view;
        k.layout = (lib && lib.template) || (v && v.defaultLayout) || DISCOVERJOBS.DEFAULT_LAYOUT;
      },
      dmPickerLibraryChanged: function () {
        const k = this.discover.modal.picker;
        if (k && k.browse) { this.dmBrowseLoad(); }
      },
      // Browse…: the file explorer's own listing, folders only, one level at
      // a time. A folder that does not exist yet is fine — the first copy
      // creates it.
      dmBrowseToggle: function () {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        if (k.browse) { k.browse = null; return; }
        k.browse = { loading: false, dirs: [], missing: false, naming: false, newName: '' };
        this.dmBrowseLoad();
      },
      dmBrowseLoad: async function () {
        const k = this.discover.modal.picker;
        if (!k || !k.browse) { return; }
        const norm = DISCOVERJOBS.normalizeBase(k.base);
        const base = norm.valid ? norm.base : '';
        const asked = k.vpath + '/' + base;
        k.browse.loading = true;
        let dirs = [];
        let missing = false;
        try {
          const res = await MSTREAMAPI.dirparser('/' + k.vpath + (base ? '/' + base : ''));
          dirs = ((res && res.directories) || []).map((d) => d.name).filter(Boolean);
        } catch (_) { missing = true; }
        const now = this.discover.modal.picker;
        if (now !== k || !k.browse) { return; }
        const current = DISCOVERJOBS.normalizeBase(k.base);
        if (k.vpath + '/' + (current.valid ? current.base : '') !== asked) { return; }   // moved on meanwhile
        k.browse.loading = false;
        k.browse.dirs = dirs;
        k.browse.missing = missing;
      },
      dmBrowseCrumbs: function () {
        const k = this.discover.modal.picker;
        if (!k) { return []; }
        const norm = DISCOVERJOBS.normalizeBase(k.base);
        return [k.vpath].concat(DISCOVERJOBS.pathCrumbs(norm.valid ? norm.base : ''));
      },
      dmBrowseInto: function (name, fresh) {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        const norm = DISCOVERJOBS.normalizeBase(k.base);
        k.base = [norm.valid ? norm.base : '', DISCOVERJOBS.sanitizeSegment(name)].filter(Boolean).join('/');
        if (k.browse) { k.browse.naming = false; k.browse.newName = ''; }
        // A folder the user just named is known not to exist: nothing to list.
        if (fresh && k.browse) { k.browse.loading = false; k.browse.dirs = []; k.browse.missing = true; return; }
        this.dmBrowseLoad();
      },
      dmBrowseUp: function () {
        const k = this.discover.modal.picker;
        if (!k) { return; }
        const parts = this.dmBrowseCrumbs().slice(1);
        parts.pop();
        k.base = parts.join('/');
        this.dmBrowseLoad();
      },
      dmBrowseNewFolder: function () {
        const k = this.discover.modal.picker;
        if (!k || !k.browse) { return; }
        if (!k.browse.naming) {
          k.browse.naming = true;
          this.$nextTick(() => { const el = this.$refs.dmNewFolder; if (el && el.focus) { el.focus(); } });
          return;
        }
        const name = DISCOVERJOBS.sanitizeSegment(k.browse.newName);
        if (name) { this.dmBrowseInto(name, k.browse.dirs.indexOf(name) === -1); }
      },
      // Use this folder (remembered for the account) · Move here (Keep…,
      // remembered only when the box is ticked).
      dmPickerSubmit: async function () {
        const m = this.discover.modal;
        const k = m.picker;
        const gen = m.gen;
        const preview = this.dmPickerPreview();
        if (!k || k.saving || !preview || !preview.valid) { return; }
        const destination = { vpath: k.vpath, base: preview.base, layout: k.layout };
        k.saving = true;
        k.error = '';
        try {
          if (k.mode === 'save' || k.remember) {
            this.discover.dest.view = await MSTREAMAPI.discoverySaveDestination(destination);
            this.discover.dest.loaded = true;
          }
          if (k.mode === 'keep') {
            const job = m.jobs[k.plugin];
            const from = job && job.result && job.result.downloaded && job.result.downloaded.filepath;
            const res = await MSTREAMAPI.discoveryJobKeep(job.id, k.remember ? undefined : destination);
            if (res && res.job) {
              this.noteDiscoverJob(res.job);
              if (this.dmLive(gen)) { this.$set(this.discover.modal.jobs, k.plugin, res.job); }
              const to = res.job.result && res.job.result.kept && res.job.result.kept.filepath;
              if (from && to) { this.discoverFileMoved(from, to); }
              iziToast.success({ title: this.tt('discover.job.toastKept'), message: DISCOVERJOBS.pathCrumbs(to).join(' / '), position: 'topCenter', timeout: 3000 });
            }
          }
          if (this.dmLive(gen)) { this.discover.modal.picker = null; }
        } catch (err) {
          if (this.dmLive(gen) && this.discover.modal.picker === k) {
            k.saving = false;
            k.error = this.dmErrorText(err);
          }
        }
      },
      dmResetDestination: async function () {
        try {
          this.discover.dest.view = await MSTREAMAPI.discoverySaveDestination(null);
        } catch (err) {
          iziToast.error({ title: this.dmErrorText(err), position: 'topCenter', timeout: 3500 });
        }
      },
      // Keep… moved a file: queue entries on the old path follow it.
      discoverFileMoved: function (from, to) {
        const patched = DISCOVERJOBS.patchQueuePaths(MSTREAMPLAYER.playlist, from, to, (raw) => {
          let escaped = raw.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
          if (escaped.charAt(0) === '/') { escaped = escaped.substr(1); }
          const transcode = MSTREAMPLAYER.transcodeOptions.serverEnabled && MSTREAMPLAYER.transcodeOptions.frontendEnabled;
          let url = MSTREAMAPI.currentServer.host + (transcode ? 'transcode/' : 'media/') + escaped + '?';
          if (MSTREAMAPI.currentServer.token) { url += 'token=' + MSTREAMAPI.currentServer.token; }
          return { filepath: escaped, url };
        });
        if (patched > 0) { saveLiveQueue(); }
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
        if (m.open && m.recKey) {
          const mine = DISCOVERJOBS.jobsByPlugin(jobs.filter((j) => j.key === m.recKey));
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
        }
        for (const job of finished) {
          if (!(m.open && m.recKey && m.recKey === job.key)) { this.toastDiscoverJob(job); }
        }
        if (DISCOVERJOBS.trayRows(jobs).length > 0) { this.ensureDiscoverPlugins(); }
      },
      toastDiscoverJob: function (job) {
        const row = DISCOVERJOBS.jobRowState(job);
        const message = DISCOVERJOBS.jobTitle(job);
        if (row.state === 'failed') {
          iziToast.error({ title: this.tt('discover.job.toastFailed', { plugin: this.discoverPluginTitle(job.plugin) }), message: job.error || message, position: 'topCenter', timeout: 5000 });
        } else if (row.state === 'copied') {
          iziToast.success({ title: this.tt('discover.job.toastCopied'), message, position: 'topCenter', timeout: 3000 });
        } else if (row.state === 'ready') {
          iziToast.success({ title: this.tt('discover.job.toastDownloaded'), message, position: 'topCenter', timeout: 3000 });
        } else if (row.state === 'owned') {
          iziToast.info({ title: this.tt('discover.job.toastOwned'), message, position: 'topCenter', timeout: 3000 });
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
        const beat = this.dmAnyJobLive() ? 1500 : ((this.discover.tray.collapsed || this.discover.collapsed) ? 10000 : 4000);
        const delay = Math.min(60000, beat * Math.pow(2, Math.min(discoverJobsFailures, 6)));
        discoverJobsTimer = setTimeout(() => { discoverJobsTimer = null; this.refreshDiscoverJobs(); }, delay);
      },
      dtRows: function () {
        return DISCOVERJOBS.trayRows(this.discover.tray.jobs).map((job) => ({
          job, row: DISCOVERJOBS.jobRowState(job), title: DISCOVERJOBS.jobTitle(job), plugin: this.discoverPluginTitle(job.plugin),
        }));
      },
      dtSummary: function () {
        return DISCOVERJOBS.traySummary(this.discover.tray.jobs).parts.map((p) => this.tt(p.key, { count: p.count })).join(' · ');
      },
      dtClearable: function () {
        return DISCOVERJOBS.traySummary(this.discover.tray.jobs).clearable;
      },
      // "Discover downloads · 2 files · 28 MB": what is waiting to be kept.
      dtWaiting: function () {
        const ready = DISCOVERJOBS.trayRows(this.discover.tray.jobs).filter((j) => j.state === 'done');
        if (ready.length === 0) { return ''; }
        const bytes = ready.reduce((sum, j) => sum + (Number(j.result && j.result.downloaded && j.result.downloaded.bytes) || 0), 0);
        return [this.tt('discover.tray.waiting', { count: ready.length }), DISCOVERJOBS.fmtBytes(bytes)].filter(Boolean).join(' · ');
      },
      toggleDiscoverTray: function () {
        this.discover.tray.collapsed = !this.discover.tray.collapsed;
        try { localStorage.setItem('discoverTrayCollapsed', String(this.discover.tray.collapsed)); } catch (_) { /* private mode */ }
        this.scheduleDiscoverJobsPoll();
      },
      dtRetry: async function (job) {
        try {
          const res = await MSTREAMAPI.discoveryJobStart(job.plugin, job.recommendation);
          if (res && res.job) { this.noteDiscoverJob(res.job); }
        } catch (err) {
          iziToast.error({ title: this.dmErrorText(err), position: 'topCenter', timeout: 3500 });
        }
        this.scheduleDiscoverJobsPoll();
      },
      dtClear: async function () {
        try { await MSTREAMAPI.discoveryJobsClear(); } catch (_) { /* the refresh shows what is left */ }
        await this.refreshDiscoverJobs();
      },
      // A strip row opens the window its job came from; Keep… opens it on
      // the destination form.
      openDiscoverModalForJob: async function (job, keep) {
        const rec = job.recommendation || {};
        const source = rec.source === 'federation' ? 'federation' : 'p2p';
        await this.openDiscoverModal(Object.assign({}, rec, { peer: rec.peer || {} }), source);
        const m = this.discover.modal;
        if (!m.open) { return; }
        if (source === 'federation' && job.plugin !== DISCOVERJOBS.COPY_PLUGIN && this.discover.plugins.available) { m.view = 'plugins'; }
        if (keep && this.dmHasDestination() && m.jobs[job.plugin] && m.jobs[job.plugin].id === job.id) {
          this.dmOpenPicker('keep', { name: job.plugin });
        }
      },

      // ── "From the network" rows ────────────────────────────────────
      // Not playable (the track lives on someone else's server) — clicking
      // copies "Artist - Title" so the user can go find it.
      copyDiscoverP2p: async function (track) {
        const text = `${track.artist || ''} - ${track.title || ''}`.trim();
        try {
          await navigator.clipboard.writeText(text);
          iziToast.success({ title: t('discover.network.copied'), message: text, position: 'topCenter', timeout: 2500 });
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
          <span v-on:click="createPopper2($event)" class="np-queue-action popperMenu pop-d" title="More">
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

  window.addEventListener("keydown", (event) => {
    // Use default behavior if user is in a form or editable element
    const element = event.target.tagName.toLowerCase();
    if (element === 'input' || element === 'textarea' || element === 'select' || event.target.isContentEditable) {
      return;
    }

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
    // already. Callers that pass a real metadata object — search results
    // (the search API returns full metadata inline), album queue, playlist
    // load — skip this redundant /api/v1/db/metadata round-trip. The file
    // browser passes {} (it has no inline metadata) and still gets a lookup.
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
    discoverPluginsPromise = null;
    discoverState.dest = { loaded: false, view: null };
    discoverState.tray.jobs = [];
    if (discoverJobsTimer) { clearTimeout(discoverJobsTimer); discoverJobsTimer = null; }
    // The strip's one up-front request: this account's jobs (a download may
    // be waiting to be kept, or still running from an earlier visit).
    if (discoverState.plugins.available) { playlistVue.refreshDiscoverJobs(); }
    if (discoverPreviewAudio) {
      try { discoverPreviewAudio.pause(); } catch (_) { /* already gone */ }
      discoverPreviewAudio = null;
      discoverPreviewPausedMain = false;
    }
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

  return mstreamModule;
})()
