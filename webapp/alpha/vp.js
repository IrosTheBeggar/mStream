const VUEPLAYERCORE = (() => {
  const mstreamModule = {};

  mstreamModule.altLayout = {
    'moveMeta': false,
    'audioBookCtrls': false,
    'flipPlayer': false
  };

  try {
    const altLayout = JSON.parse(localStorage.getItem('altLayout'));
    mstreamModule.altLayout.flipPlayer = typeof altLayout.flipPlayer === 'boolean' ? altLayout.flipPlayer : false;
    mstreamModule.altLayout.audioBookCtrls = typeof altLayout.audioBookCtrls === 'boolean' ? altLayout.audioBookCtrls : false;
    mstreamModule.altLayout.moveMeta = typeof altLayout.moveMeta === 'boolean' ? altLayout.moveMeta : false;

    if (altLayout.flipPlayer === true) {
      document.getElementById('content').classList.add('col-rev');
      document.getElementById('flip-me').classList.add('col-rev');
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

  new Vue({
    el: '#playlist',
    data: {
      playlist: MSTREAMPLAYER.playlist,
      playlists: mstreamModule.playlists,
      showClear: showClearLink,
      altLayout: mstreamModule.altLayout,
      meta: MSTREAMPLAYER.playerStats.metadata
    },
    computed: {
      albumArtPath: function () {
        if (!this.meta['album-art']) {
          return 'assets/img/default.png';
        }
        return MSTREAMAPI.currentServer.host + `album-art/${this.meta['album-art']}?compress=l&token=${MSTREAMPLAYER.getCurrentSong().authToken}`;
      }
    },
    methods: {
      getSongInfo: function() {
        openMetadataModal(MSTREAMPLAYER.getCurrentSong().metadata, MSTREAMPLAYER.getCurrentSong().rawFilePath);
      },
      gsi2: function() {
        openMetadataModal(cps.metadata, cps.rawFilePath);
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
    },
  });

  // Template for playlist items
  Vue.component('playlist-item', {
    template: `
      <li class="noselect collection-item" v-bind:class="{ playing: (this.index === positionCache.val), playError: (this.songError && this.songError === true) }" >
        <div v-on:click="goToSong($event)" class="playlist-item">
          <span onclick="event.stopPropagation()" class="drag-handle">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="24" height="24"><path fill="#FFF" d="M4 7v2h24V7Zm0 8v2h24v-2Zm0 8v2h24v-2Z"/></svg>
          </span>
          <span class="song-area">{{ comtext }}</span>
          <div onclick="event.stopPropagation()" class="song-button-box">
            <span v-on:click="removeSong($event)" class="removeSong">
              <svg width="12" height="12" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" xml:space="preserve"><path d="M507.8 392 371.7 256l136-136c5.6-5.6 5.6-14.8 0-20.4L412.4 4.2c-5.6-5.6-14.8-5.6-20.4 0l-136 136-136-136c-5.4-5.4-15-5.4-20.4 0L4.3 99.5c-2.7 2.7-4.2 6.4-4.2 10.2s1.5 7.5 4.2 10.2l136 136L4.2 392c-2.7 2.7-4.2 6.4-4.2 10.2 0 3.8 1.5 7.5 4.2 10.2l95.3 95.3c2.7 2.7 6.4 4.2 10.2 4.2 3.8 0 7.5-1.5 10.2-4.2l136.1-136 136.1 136c2.8 2.8 6.5 4.2 10.2 4.2 3.7 0 7.4-1.4 10.2-4.2l95.3-95.3c5.6-5.6 5.6-14.7 0-20.4z"/></svg>
            </span>
            <span v-on:click="createPopper($event)" class="songDropdown pop-c">
              {{ratingNumber}}
              <svg class="pop-c" width="12" height="12" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 53.867 53.867"><path class="pop-c" d="m26.934 1.318 8.322 16.864 18.611 2.705L40.4 34.013l3.179 18.536-16.645-8.751-16.646 8.751 3.179-18.536L0 20.887l18.611-2.705z" fill="#efce4a"/></svg>
            </span>
            <span class="downloadPlaylistSong" v-on:click="downloadSong($event)">
              <svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>
            </span>
            <span v-on:click="createPopper2($event)" class="popperMenu pop-d">
              <svg class="pop-d" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-d" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
            </span>
          </div>
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

  new Vue({
    el: '#mstream-player',
    data: {
      playerStats: MSTREAMPLAYER.playerStats,
      playlist: MSTREAMPLAYER.playlist,
      positionCache: MSTREAMPLAYER.positionCache,
      meta: MSTREAMPLAYER.playerStats.metadata,
      lastVol: 100,
      replayGainToggle: false,
      altLayout: mstreamModule.altLayout
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
      }
    },
    methods: {
      getSongInfo: function() {
        openMetadataModal(MSTREAMPLAYER.getCurrentSong().metadata, MSTREAMPLAYER.getCurrentSong().rawFilePath);
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
    // Use default behavior if user is in a form
    const element = event.target.tagName.toLowerCase();
    if (element === 'input' || element === 'textarea') {
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

  mstreamModule.addSongWizard = async (filepath, metadata, lookupMetadata, position) => {
    // Escape filepath
    var rawFilepath = filepath;
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
    } else {
      MSTREAMPLAYER.addSong(newSong);
    }

    // perform lookup
    if (lookupMetadata === true) {
      const response = await MSTREAMAPI.lookupMetadata(rawFilepath);

      if (response.metadata) {
        newSong.metadata = response.metadata;
        MSTREAMPLAYER.resetCurrentMetadata();
      }
    }
  };

  return mstreamModule;
})()
