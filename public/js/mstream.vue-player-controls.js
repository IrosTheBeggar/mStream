var VUEPLAYER = (function () {
  const mstreamModule = {};
  mstreamModule.playlists = [];

  var currentPopperSongIndex2;
  var currentPopperSongIndex;
  var currentPopperSong;

  var cpsi;
  var cps;

  // Hide rating popover on click
  $(document).mouseup(function (e) {
    if (!($(e.target).hasClass("pop-c"))) {
      $("#pop").css("visibility", "hidden");
      currentPopperSongIndex = false;
    }

    if (!($(e.target).hasClass("pop-d"))) {
      $("#pop-d").css("visibility", "hidden");
      cpsi = false;
    }
  });

  Vue.component('popper-playlist-item', {
    template: '<div class="pop-list-item" v-on:click="addToPlaylist($event)">&#8226; {{playlistName}}</div>',
    props: ['index', 'playlist'],
    methods: {
      addToPlaylist: function(event) { 
        MSTREAMAPI.addToPlaylist(this.playlist.name, cps.filepath, function(res, err) {
          if (err) {
            iziToast.error({
              title: 'Failed to add song',
              position: 'topCenter',
              timeout: 3500
            });
            return;
          }
          iziToast.success({
            title: 'Song Added!',
            position: 'topCenter',
            timeout: 3500
          });
        });
      }
    },
    computed: {
      playlistName: function () {
        return this.playlist.name;
      }
    }
  });

  // Template for playlist items
  Vue.component('playlist-item', {
    template: '\
      <div class="noselect playlist-item" v-bind:class="{ playing: (this.index === positionCache.val), playError: (this.songError && this.songError === true) }" >\
        <span class="drag-handle"><img src="/public/img/drag-handle.svg"></span><span v-on:click="goToSong($event)" class="song-area">{{ comtext }}</span>\
        <div class="song-button-box">\
          <span v-on:click="removeSong($event)" class="removeSong">X</span>\
          <span v-on:click="createPopper($event)" class="songDropdown pop-c">\
            {{ratingNumber}}<img class="star-small pop-c" src="/public/img/star.svg">\
          </span>\
          <span class="downloadPlaylistSong" v-on:click="downloadSong($event)">\
            <svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>\
          </span>\
          <span v-on:click="createPopper2($event)" class="popperMenu pop-d"><?xml version="1.0" encoding="iso-8859-1"?>\
            <?xml version="1.0" encoding="iso-8859-1"?><svg class="pop-d" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362" style="enable-background:new 0 0 292.362 292.362"><path class="pop-d" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>\
          </span>\
        </div>\
      </div>',

    props: ['index', 'song'],

    // We need the positionCache to track the currently playing song
    data: function () {
      return {
        positionCache: MSTREAMPLAYER.positionCache,
      }
    },

    // Methods used by playlist item events
    methods: {
      // Go to a song on item click
      goToSong: function (event) {
        MSTREAMPLAYER.goToSongAtPosition(this.index);
      },
      // Remove song
      removeSong: function (event) {
        MSTREAMPLAYER.removeSongAtPosition(this.index, false);
      },
      downloadSong: function (event) {
        $("#download-file").attr("href", "/media/" + this.song.filepath + "?token=" + MSTREAMAPI.currentServer.token);
        document.getElementById('download-file').click();
      },
      createPopper: function (event) {
        if (currentPopperSongIndex === this.index) {
          currentPopperSongIndex = false;
          $("#pop").css("visibility", "hidden");
          return;
        }
        var ref = event.target;
        currentPopperSongIndex = this.index;
        currentPopperSongIndex2 = this.index;

        currentPopperSong = this.song;

        $('.my-rating').starRating('setRating', this.song.metadata.rating / 2)

        const pop = document.getElementById('pop');
        new Popper(ref, pop, {
          placement: 'bowrgwr', // Putting jibberish here gives us the behavior we want.  It's not a bug, it's a feature
          onCreate: function (data) {
            $("#pop").css("visibility", "visible");
          },
          modifiers: {
            flip: {
              boundariesElement: 'scrollParent',
            },
            preventOverflow: {
              boundariesElement: 'scrollParent'
            }
          }
        });
      },
      createPopper2: function (event) {
        if (cpsi === this.index) {
          cpsi = false;
          $("#pop-d").css("visibility", "hidden");
          return;
        }
        var ref = event.target;
        cpsi = this.index;

        cps = this.song;
  
        const pop = document.getElementById('pop-d');
        new Popper(ref, pop, {
          placement: 'bowrgwr', // Putting jibberish here gives us the behavior we want.  It's not a bug, it's a feature
          onCreate: function (data) {
            $("#pop-d").css("visibility", "visible");
          },
          modifiers: {
            flip: {
              boundariesElement: 'scrollParent',
            },
            preventOverflow: {
              boundariesElement: 'scrollParent'
            }
          }
        });
      },
    },
    computed: {
      comtext: function () {
        var returnThis = this.song.filepath;

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

  // Code to update playlist
  new Vue({
    el: '#playlist',
    data: {
      playlist: MSTREAMPLAYER.playlist,
      playlists: mstreamModule.playlists
    },
    methods: {
      // checkMove is called when a drag-and-drop action happens
      checkMove: function (event) {
        $("#pop").css("visibility", "hidden");
        MSTREAMPLAYER.resetPositionCache();
      }
    }
  });


  var jukeStats = false
  if (typeof JUKEBOX !== 'undefined') {
    jukeStats = JUKEBOX.stats
  }

  new Vue({
    el: '#mstream-player',
    data: {
      playerStats: MSTREAMPLAYER.playerStats,
      playlist: MSTREAMPLAYER.playlist,
      positionCache: MSTREAMPLAYER.positionCache,
      met: MSTREAMPLAYER.playerStats.metadata,
      jukebox: jukeStats,
      curVol: 100, // Manage our own volume
      lastVol: 100,
      isViz: false
    },
    created: function () {
      if (typeof(Storage) !== "undefined") {
        this.curVol = localStorage.getItem("volume");
      }
      MSTREAMPLAYER.changeVolume(parseInt(this.curVol));
    },
    watch: {
      curVol: function () {
        if (typeof(Storage) !== "undefined") {
          localStorage.setItem("volume", this.curVol);
        }

        MSTREAMPLAYER.changeVolume(parseInt(this.curVol));
      }
    },
    computed: {
      imgsrc: function () {
        return "/public/img/" + (this.playerStats.playing ? 'pause' : 'play') + "-white.svg";
      },
      volumeSrc: function () {
        return "/public/img/" + (this.playerStats.volume !== 0 ? 'volume' : 'volume-mute') + ".svg";
      },
      widthcss: function () {
        if (this.playerStats.duration === 0) {
          return "width:0";
        }

        var percentage = 100 - ((this.playerStats.currentTime / this.playerStats.duration) * 100);
        return "width:calc(100% - " + percentage + "%)";
      },

      showTime: function () {
        if (this.playerStats.duration === 0) {
          return '';
        }

        var curr = this.playerStats.duration - this.playerStats.currentTime;
        var minutes = Math.floor(curr / 60);
        var secondsToCalc = Math.floor(curr % 60) + '';
        var currentText = minutes + ':' + (secondsToCalc.length < 2 ? '0' + secondsToCalc : secondsToCalc);

        return currentText;
      },

      currentSongText: function () {
        // Call these vars so updates change whenever they do
        var playerStats = this.playerStats;
        var titleX = this.met.title;

        var currentSong = MSTREAMPLAYER.getCurrentSong();

        if (currentSong === false) {
          return '\u00A0\u00A0\u00A0Welcome To mStream!\u00A0\u00A0\u00A0';
        }

        // Get current song straight from the source
        var returnText = '';
        if (playerStats.metadata && titleX) {
          returnText = titleX;
          if (playerStats.metadata.artist) {
            returnText = playerStats.metadata.artist + ' - ' + returnText;
          }
        } else {
          // Use filepath instead
          var filepathArray = currentSong.filepath.split("/");
          returnText = filepathArray[filepathArray.length - 1]
        }

        return '\u00A0\u00A0\u00A0' + returnText + '\u00A0\u00A0\u00A0';
      }
    },
    methods: {
      toggleRepeat: function () {
        MSTREAMPLAYER.toggleRepeat();
      },
      toggleShuffle: function () {
        MSTREAMPLAYER.toggleShuffle();
      },
      toggleAutoDJ: function () {
        MSTREAMPLAYER.toggleAutoDJ();
      },
      fadeOverlay: function () {
        if ($('#main-overlay').is(':visible')) {
          $('#main-overlay').fadeOut("slow");
          this.isViz = false;
        } else {
          this.isViz = true;
          $('#main-overlay').fadeIn("slow", function() {
            var isInit = VIZ.initPlayer();
            if(isInit === false) {
              VIZ.updateSize();
            }
          });
        }
      },
      toggleVolume: function () {
        if (this.playerStats.volume === 0) {
          MSTREAMPLAYER.changeVolume(this.lastVol);
          this.curVol = this.lastVol;
        } else {
          this.lastVol = this.curVol;
          MSTREAMPLAYER.changeVolume(0);
          this.curVol = 0;
        }
      }
    }
  });

  if (document.getElementById("meta-box")) {
    new Vue({
      el: '#meta-box',
      data: {
        meta: MSTREAMPLAYER.playerStats.metadata
      },
      computed: {
        albumArtPath: function () {
          if (!this.meta['album-art']) {
            return '/public/img/default.png';
          }
          return '/album-art/' + this.meta['album-art'] + '?token=' + MSTREAMAPI.currentServer.token;
        }
      }
    });
  }

  // Button Events
  document.getElementById("progress-bar").addEventListener("click", function (event) {
    var relativeClickPosition = event.clientX - this.getBoundingClientRect().left;
    var totalWidth = this.getBoundingClientRect().width;
    var percentage = (relativeClickPosition / totalWidth) * 100;
    // Set Player time
    MSTREAMPLAYER.seekByPercentage(percentage);
  });

  // Button Events
  document.getElementById("next-button").addEventListener("click", function () {
    MSTREAMPLAYER.nextSong();
  });
  document.getElementById("play-pause-button").addEventListener("click", function () {
    MSTREAMPLAYER.playPause();
  });
  document.getElementById("previous-button").addEventListener("click", function () {
    MSTREAMPLAYER.previousSong();
  });

  // This makes the title text scroll back and forth
  var scrollTimer;
  var scrollRight = true; //Track Scroll Direction
  var scrollPause = 0;
  function startTime(interval) {
    if (scrollTimer) { clearInterval(scrollTimer); }

    scrollTimer = setInterval(function () {
      if(scrollPause > 0) {
        scrollPause = scrollPause - 1;
        return;
      }

      // Get the max scroll distance
      var maxScrollLeft = document.getElementById('title-text').scrollWidth - document.getElementById('title-text').clientWidth;

      // Do the scroll
      if (scrollRight === true) {
        document.getElementById('title-text').scrollLeft = document.getElementById('title-text').scrollLeft + 1;
      } else {
        document.getElementById('title-text').scrollLeft = document.getElementById('title-text').scrollLeft - 1;
      }

      // Change the scroll direction if necessary
      // And set a pause
      if (document.getElementById('title-text').scrollLeft > (maxScrollLeft - 1)) {
        scrollRight = false;
        scrollPause = 50;
      }
      if (document.getElementById('title-text').scrollLeft === 0) {
        scrollRight = true;
        scrollPause = 50;
      }
    }, interval);
  }
  startTime(40);


  // Change spacebar behavior to Play/Pause
  window.addEventListener("keydown", function (event) {
    // Use default behavior if user is in a form
    var element = event.target.tagName.toLowerCase();
    if (element == 'input' || element == 'textarea') {
      return;
    }

    // Check the key
    switch (event.keyCode) {
      case 32: //SpaceBar
        event.preventDefault();
        MSTREAMPLAYER.playPause();
        break;
    }
    return false;
  }, false);


  $(".my-rating").starRating({
    starSize: 22,
    disableAfterRate: false,
    useGradient: false,
    hoverColor: '#26477b',
    activeColor: '#6684b2',
    ratedColor: '#6684b2',
    callback: function (currentRating, $el) {
      MSTREAMPLAYER.editSongMetadata('rating', parseInt(currentRating * 2), currentPopperSongIndex2);

      // make a server call here
      MSTREAMAPI.rateSong(currentPopperSong.filepath, parseInt(currentRating * 2), function (res, err) {
        if(err) {
          iziToast.error({
            title: 'Failed to set rating',
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }
      });
    }
  });

  return mstreamModule;
}());
