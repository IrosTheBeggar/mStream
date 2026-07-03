const VUEPLAYERCORE = (() => {
  const mstreamModule = {};

  mstreamModule.livePlaylist = {
    name: false
  };

  mstreamModule.altLayout = {
    'moveMeta': false,
    'audioBookCtrls': false,
    'flipPlayer': false,
    'compressArt': false,
    'hideTopBar': false,
    'waveformBar': true
  };

  try {
    const altLayout = JSON.parse(localStorage.getItem('altLayout'));
    mstreamModule.altLayout.flipPlayer = typeof altLayout.flipPlayer === 'boolean' ? altLayout.flipPlayer : false;
    mstreamModule.altLayout.audioBookCtrls = typeof altLayout.audioBookCtrls === 'boolean' ? altLayout.audioBookCtrls : false;
    mstreamModule.altLayout.moveMeta = typeof altLayout.moveMeta === 'boolean' ? altLayout.moveMeta : false;
    mstreamModule.altLayout.compressArt = typeof altLayout.compressArt === 'boolean' ? altLayout.compressArt : false;
    mstreamModule.altLayout.hideTopBar = typeof altLayout.hideTopBar === 'boolean' ? altLayout.hideTopBar : false;
    mstreamModule.altLayout.waveformBar = typeof altLayout.waveformBar === 'boolean' ? altLayout.waveformBar : true;

    if (altLayout.flipPlayer === true) {
      document.getElementById('content').classList.add('col-rev');
      document.getElementById('flip-me').classList.add('col-rev');
    }

    // When the top bar is disabled, mark the body so CSS can:
    //   - hide #nav-bar
    //   - show the sidenav logo (its original spot)
    //   - show the sidenav bottom language picker
    //   - recompute #content / #sidenav heights
    if (altLayout.hideTopBar === true) {
      document.body.classList.add('top-bar-hidden');
    }
  } catch (e) {}

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
  };
  let discoverDebounce = null;
  let discoverReqId = 0;
  let discoverDirty = false;   // song changed while collapsed → refetch on expand

  const playlistVue = new Vue({
    el: '#playlist',
    data: {
      playlist: MSTREAMPLAYER.playlist,
      playlists: mstreamModule.playlists,
      showClear: showClearLink,
      altLayout: mstreamModule.altLayout,
      meta: MSTREAMPLAYER.playerStats.metadata,
      livePlaylist: mstreamModule.livePlaylist,
      discover: discoverState
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
        return MSTREAMAPI.currentServer.host + `album-art/${this.meta['album-art']}?compress=l&token=${MSTREAMPLAYER.getCurrentSong().authToken}`;
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
        getArtistz(el);
      },
      goToAlbum: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-album', this.meta.album);
        el.setAttribute('data-year', this.meta.year);
        getAlbumsOnClick(el);
      },
      checkMove: function (event) {
        document.getElementById("pop").style.visibility = "hidden";
        MSTREAMPLAYER.resetPositionCache();
        if (mstreamModule.livePlaylist.name) {
          const songs = [];
          for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
            songs.push(MSTREAMPLAYER.playlist[i].filepath);
          }
          MSTREAMAPI.savePlaylist(mstreamModule.livePlaylist.name,songs, true);
        }
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
        // Keep it lean: no discovery traffic while the panel is collapsed.
        // Remember there's something new to fetch for when it opens.
        if (this.discover.collapsed) {
          discoverDirty = true;
          return;
        }
        discoverDirty = false;
        const seedPath = song.rawFilePath.charAt(0) === '/' ? song.rawFilePath.substr(1) : song.rawFilePath;
        const reqId = ++discoverReqId;
        this.discover.loading = true;

        const [similar, artists] = await Promise.all([
          MSTREAMAPI.discoverySimilar(seedPath, 5),
          this.meta.artist ? MSTREAMAPI.discoverySimilarArtists(this.meta.artist, 3) : Promise.resolve(null),
        ]);
        if (reqId !== discoverReqId) { return; }   // a newer song superseded this refresh
        this.discover.loading = false;

        if (similar && similar.disabled) {
          // Server has the feature off — hide for the rest of the session.
          this.discover.disabled = true;
          this.discover.available = false;
          return;
        }
        if (!similar) { return; }   // transient failure: keep whatever is shown

        this.discover.notAnalyzed = similar.notAnalyzed === true;
        this.discover.seedTitle = (similar.seed && similar.seed.metadata && similar.seed.metadata.title)
          || (this.meta.title || '');
        this.discover.tracks = similar.results || [];
        this.discover.artists = (artists && !artists.disabled && !artists.notAnalyzed && artists.results) || [];
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
      <li v-on:click="goToSong($event)" class="noselect np-queue-item" v-bind:class="{ 'np-queue-active': (this.index === positionCache.val), playError: (this.songError && this.songError === true) }">
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

    // We need the positionCache to track the currently playing song
    data: function () {
      return {
        positionCache: MSTREAMPLAYER.positionCache
      }
    },

    // Methods used by playlist item events
    methods: {
      goToSong: function (event) {
        MSTREAMPLAYER.goToSongAtPosition(this.index);
      },
      removeSong: function (event) {
        MSTREAMPLAYER.removeSongAtPosition(this.index, false);
        if (mstreamModule.livePlaylist.name) {
          const songs = [];
          for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
            songs.push(MSTREAMPLAYER.playlist[i].filepath);
          }
          MSTREAMAPI.savePlaylist(mstreamModule.livePlaylist.name,songs, true);
        }
      },
      downloadSong: function (event) {
        const link = document.createElement("a");
        link.download = '';
        link.href = this.song.url;
        link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
      },
      createPopper: function (event) {
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
          return MSTREAMAPI.currentServer.host + 'album-art/' + this.song.metadata['album-art'] + '?compress=s&token=' + (this.song.authToken || MSTREAMAPI.currentServer.token);
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
        return MSTREAMAPI.currentServer.host + `album-art/${this.meta['album-art']}?compress=l&token=${MSTREAMPLAYER.getCurrentSong().authToken}`;
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
        getArtistz(el);
      },
      goToAlbum: function() {
        const el = document.createElement('DIV');
        el.setAttribute('data-album', this.meta.album);
        el.setAttribute('data-year', this.meta.year);
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

  // Change spacebar behavior to Play/Pause
  window.addEventListener("keydown", (event) => {
    // Use default behavior if user is in a form or editable element
    const element = event.target.tagName.toLowerCase();
    if (element === 'input' || element === 'textarea' || event.target.isContentEditable) {
      return;
    }

    // Check the key
    switch (event.key) {
      case " ": //SpaceBar
        event.preventDefault();
        MSTREAMPLAYER.playPause();
        break;
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
      if (mstreamModule.livePlaylist.name) {
        const songs = [];
        for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
          songs.push(MSTREAMPLAYER.playlist[i].filepath);
        }
        MSTREAMAPI.savePlaylist(mstreamModule.livePlaylist.name,songs, true);
      }
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
        MSTREAMPLAYER.resetCurrentMetadata();
      }
    }
  };

  mstreamModule.clearQueue = async() => {
    MSTREAMPLAYER.clearPlaylist();
    if (mstreamModule.livePlaylist.name) {
      const songs = [];
      for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
        songs.push(MSTREAMPLAYER.playlist[i].filepath);
      }
      MSTREAMAPI.savePlaylist(mstreamModule.livePlaylist.name,songs, true);
    }
  }

  // ── WAVEFORM ────────────────────────────────────────────────────────────────
  // Fetches waveform data from the server, caches in localStorage + memory,
  // and renders a two-pass canvas overlay on the progress bar.

  let _waveformData = null;   // Array of 0-255 bar heights (800 entries)
  let _waveformFp   = null;   // filepath of the currently loaded waveform
  let _waveformRaf  = null;   // requestAnimationFrame handle
  const _WF_LS_PREFIX = 'wf:';

  function _wfLsGet(filepath) {
    try {
      const raw = localStorage.getItem(_WF_LS_PREFIX + filepath);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch (_e) { return null; }
  }

  const _WF_LS_MAX = 500; // max cached waveforms in localStorage

  function _wfLsSet(filepath, data) {
    try {
      localStorage.setItem(_WF_LS_PREFIX + filepath, JSON.stringify(data));
    } catch (_e) {
      // Quota exceeded — evict oldest wf:* entries and retry once
      _wfLsEvict();
      try { localStorage.setItem(_WF_LS_PREFIX + filepath, JSON.stringify(data)); }
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

  function _setWaveformReady(val) {
    if (playerVue) playerVue.waveformReady = val;
  }

  async function _fetchWaveform(filepath) {
    // Skip radio/external streams and empty paths
    if (!filepath || /^https?:\/\//i.test(filepath)) {
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
      _drawWaveform();
      if (MSTREAMPLAYER.playerStats.playing) _startWaveformRaf();
      return;
    }

    // localStorage cache hit
    const cached = _wfLsGet(filepath);
    if (cached) {
      _waveformData = cached;
      _waveformFp   = filepath;
      _setWaveformReady(true);
      _drawWaveform();
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
        _drawWaveform();
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
  const _WF_PREFETCH_MAX = 2;
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
            _drawWaveform();
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

    // Pass 1: played region (left of splitX) — player accent
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, H);
    ctx.clip();
    ctx.fillStyle = '#657ee4';
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

  function _startWaveformRaf() {
    if (_waveformRaf) return;
    (function loop() {
      _drawWaveform();
      _waveformRaf = requestAnimationFrame(loop);
    }());
  }

  function _stopWaveformRaf() {
    if (_waveformRaf) { cancelAnimationFrame(_waveformRaf); _waveformRaf = null; }
    _drawWaveform(); // final redraw at resting position
  }

  // Redraw on window resize so the canvas doesn't appear stretched while paused
  window.addEventListener('resize', () => { if (_waveformData) _drawWaveform(); });

  mstreamModule.triggerWaveformFetch = _fetchWaveform;

  // Called by m.js init() with the ping response's `discovery` flag. This is
  // the ONLY thing that reveals the Discover panel — the webapp never probes
  // /api/v1/discovery/* to find out whether the feature exists.
  mstreamModule.setDiscoveryAvailable = (available) => {
    discoverState.available = available === true;
    if (discoverState.available) { playlistVue.refreshDiscover(); }
  };

  return mstreamModule;
})()
