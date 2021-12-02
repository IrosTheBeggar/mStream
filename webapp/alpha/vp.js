const VUEPLAYERCORE = (() => {
  const mstreamModule = {};

  new Vue({
    el: '#playlist',
    data: {
      playlist: MSTREAMPLAYER.playlist,
      // playlists: mstreamModule.playlists,
      // showClear: showClearLink
    },
    methods: {
      checkMove: function (event) {
      },
      clearRating: function () {
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
        // document.getElementById("download-file").href = "/media/" + this.song.filepath + "?token=" + MSTREAMAPI.currentServer.token;
        // document.getElementById('download-file').click();
      },
      createPopper: function (event) {
        // if (currentPopperSongIndex === this.index) {
        //   currentPopperSongIndex = false;
        //   document.getElementById("pop").style.visibility = "hidden";
        //   return;
        // }
        // var ref = event.target;
        // currentPopperSongIndex = this.index;
        // currentPopperSongIndex2 = this.index;

        // currentPopperSong = this.song;

        // showClearLink.val = false;
        // if (typeof MSTREAMPLAYER.playlist[currentPopperSongIndex2].metadata.rating === 'number'){
        //   showClearLink.val = true
        // }

        // myRater.setRating(this.song.metadata.rating / 2);

        // const pop = document.getElementById('pop');
        // Popper.createPopper(ref, pop, {
        //   placement: 'bottom-end',
        //   onFirstUpdate: function (data) {
        //     document.getElementById("pop").style.visibility = "visible";
        //   },
        //   modifiers: [
        //     {
        //       name: 'flip',
        //       options: {
        //         boundariesElement: 'scrollParent',
        //       },
        //     },
        //     {
        //       name: 'preventOverflow',
        //       options: {
        //         boundariesElement: 'scrollParent',
        //       },
        //     },
        //   ]
        // });
      },
      createPopper2: function (event) {
        // if (cpsi === this.index) {
        //   cpsi = false;
        //   document.getElementById("pop-d").style.visibility = "hidden";
        //   return;
        // }
        // var ref = event.target;
        // cpsi = this.index;

        // cps = this.song;
  
        // const pop = document.getElementById('pop-d');
        // Popper.createPopper(ref, pop, {
        //   placement: 'bottom-end',
        //   onFirstUpdate: function (data) {
        //     document.getElementById("pop-d").style.visibility = "visible";
        //   },
        //   modifiers: [
        //     {
        //       name: 'flip',
        //       options: {
        //         boundariesElement: 'scrollParent',
        //       },
        //     },
        //     {
        //       name: 'preventOverflow',
        //       options: {
        //         boundariesElement: 'scrollParent',
        //       },
        //     },
        //   ]
        // });
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

  new Vue({
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

        const percentage = 100 - ((this.playerStats.currentTime / this.playerStats.duration) * 100);
        return `width:calc(100% - ${percentage}%)`;
      },
      volWidthCss: function () {
        return `width: ${this.playerStats.volume}%`;
      },
      albumArtPath: function () {
        if (!this.meta['album-art']) {
          return '../assets/img/default.png';
        }
        return `../album-art/${this.meta['album-art']}?token=${MSTREAMPLAYER.getCurrentSong().authToken}`;
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

  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    bitrate: '128k',
    codec: 'mp3'
  };

  mstreamModule.addSongWizard = async (filepath, metadata, lookupMetadata, position) => {
    // Escape filepath
    var rawFilepath = filepath;
    filepath = filepath.replace(/\%/g, "%25");
    filepath = filepath.replace(/\#/g, "%23");
    if (filepath.charAt(0) === '/') {
      filepath = filepath.substr(1);
    }

    var defaultPathString = 'media/';
    if (mstreamModule.transcodeOptions.serverEnabled && mstreamModule.transcodeOptions.frontendEnabled) {
      defaultPathString = 'transcode/';
    }

    var url = '../' + MSTREAMAPI.currentServer.host + defaultPathString + filepath;
    if (MSTREAMAPI.currentServer.token) {
      url = url + '?token=' + MSTREAMAPI.currentServer.token;
    }

    const newSong = {
      url: url,
      rawFilePath: rawFilepath,
      filepath: filepath,
      metadata: metadata
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
