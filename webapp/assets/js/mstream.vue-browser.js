var VUEBROWSER = (function () {
  let mstreamModule = {};

  new Vue({
    el: '#responsive-left-nav',
    data: {
      jukebox: JUKEBOX.stats
    }
  });
  
  new Vue({
    el: '#top-nav-bar',
    data: {
      player: MSTREAMPLAYER.playerStats
    },
    computed: {
      playbackRate: function() {
        var rate = Number(this.player.playbackRate);
        return rate.toFixed(2) + 'x'
      }
    },
    methods: {
      goForward: function(seconds) {
        MSTREAMPLAYER.goForwardSeek(seconds);
      },
      goBack: function(seconds) {
        MSTREAMPLAYER.goBackSeek(seconds);
      }
    }
  });

  return mstreamModule;
}());
