const VUEPLAYERCORE = (() => {
  const mstreamModule = {};

  const playerVue = new Vue({
    el: '#mstream-player',
    data: {
      playerStats: MSTREAMPLAYER.playerStats,
      playlist: MSTREAMPLAYER.playlist,
      positionCache: MSTREAMPLAYER.positionCache,
      meta: MSTREAMPLAYER.playerStats.metadata,
      lastVol: 100,
    },
    computed: {
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

        const percentage = ((this.playerStats.currentTime / this.playerStats.duration) * 100);
        return `width:${percentage}%`;
      },
      volWidthCss: function () {
        return `width: ${this.playerStats.volume}%`;
      },
      albumArtPath: function () {
        if (!this.meta['album-art']) {
          return '../assets/img/default.png';
        }
        return `../album-art/${this.meta['album-art']}?compress=l&token=${MSTREAMPLAYER.getCurrentSong().authToken}`;
      }
    },
    methods: {
      changeVol: function(event) {
        const rect = this.$refs.volumeWrapper.getBoundingClientRect();
        const x = event.clientX - rect.left; //x position within the element.
        let percentage = (x / rect.width) * 100;
        if (percentage > 100) { percentage = 100; } // It's possible to 'drag' the progress bar to get over 100 percent
        MSTREAMPLAYER.changeVolume(percentage);
      },
      seekTo: function(event) {
        const rect = this.$refs.progressWrapper.getBoundingClientRect();
        const x = event.clientX - rect.left; //x position within the element.
        const percentage = (x / rect.width) * 100;
        MSTREAMPLAYER.seekByPercentage(percentage);
      },
      downloadPlaylist: function() {
        const link = document.createElement("a");
        link.download = '';
        link.href = `../api/v1/download/shared?token=${sharedPlaylist.token}`;
        link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
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
      toggleMute: function () {
        if (this.playerStats.volume === 0) {
          MSTREAMPLAYER.changeVolume(this.lastVol);
        } else {
          this.lastVol = this.playerStats.volume;
          MSTREAMPLAYER.changeVolume(0);
        }
      }
    }
  });

  Vue.component('playlist-item', {
    // We need the positionCache to track the currently playing song
    data: function () {
      return {
        positionCache: MSTREAMPLAYER.positionCache,
      }
    },
    template: `
      <li v-on:click="goToSong($event)" class="pointer collection-item" v-bind:class="{ playing: (this.index === positionCache.val), playError: (this.songError && this.songError === true) }" >
        <div class="playlist-text">{{ comtext }}</div>
        <a v-on:click.stop="downloadSong($event)" class="secondary-content">
          <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24"><path d="M0 0h24v24H0z" fill="none"/><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/></svg>
        </a>
      </li>`,
    props: ['index', 'song'],
    methods: {
      goToSong: function () {
        MSTREAMPLAYER.goToSongAtPosition(this.index);
      },
      // removeSong: function (event) {
      //   MSTREAMPLAYER.removeSongAtPosition(this.index, false);
      // },
      downloadSong: function () {
        const link = document.createElement("a");
        link.download = '';
        link.href = this.song.url;
        link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
      }
    },
    computed: {
      comtext: function () {
        let returnThis = this.song.metadata.title ? this.song.metadata.title : this.song.filepath.split('/').pop();
        if (this.song.metadata.artist) {
          returnThis = this.song.metadata.artist + ' - ' + returnThis;
        }

        return returnThis;
      },
      songError: function () {
        return this.song.error;
      }
    }
  });

  // Player hotkeys — bindings come from MSTREAMPLAYER.hotkeys (shared with
  // the main UI; configurable there under Layout > Keyboard Shortcuts).
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
    // Same range as the main UI's speed modal (0.25x - 4x)
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

  return mstreamModule;
})()
