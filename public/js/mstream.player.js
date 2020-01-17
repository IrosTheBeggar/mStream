var MSTREAMPLAYER = (function () {
  let mstreamModule = {};

  // Playlist variables
  mstreamModule.positionCache = { val: -1 };
  mstreamModule.playlist = [];
  var cacheTimeout = 30000;

  mstreamModule.editSongMetadata = function (key, value, songIndex) {
    for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
      if ((mstreamModule.playlist[i].metadata && mstreamModule.playlist[i].metadata.hash === mstreamModule.playlist[songIndex].metadata.hash) || mstreamModule.playlist[i].filepath === mstreamModule.playlist[songIndex].filepath) {
        mstreamModule.playlist[i].metadata[key] = value;
      }
    }
  }

  mstreamModule.changeVolume = function (newVolume) {
    if (isNaN(newVolume) || newVolume < 0 || newVolume > 100) {
      return;
    }
    mstreamModule.playerStats.volume = newVolume;

    var localPlayerObject = getCurrentPlayer();
    var otherPlayerObject = getOtherPlayer();

    if (localPlayerObject && localPlayerObject.playerObject) {
      localPlayerObject.playerObject.volume(newVolume / 100);
    }

    if (otherPlayerObject && otherPlayerObject.playerObject) {
      otherPlayerObject.playerObject.volume(newVolume / 100);
    }
  }

  // Scrobble function
  // This is a placeholder function that the API layer can take hold of to implement the scrobble call
  var scrobbleTimer;
  mstreamModule.scrobble = function () {
    return false;
  }

  // The audioData looks like this
  // var song = {
  //   "url":"vPath/path/to/song.mp3?token=xxx",
  //   "filepath": "path/to/song.mp3"
  // }
  mstreamModule.addSong = function (audioData) {
    if (!audioData.url || audioData.url == false) {
      return false;
    }

    audioData.error = false;

    //  Handle shuffle
    if (mstreamModule.playerStats.shuffle === true) {
      var pos = Math.floor(Math.random() * (shuffleCache.length + 1));
      shuffleCache.splice(pos, 0, audioData);
    }

    return addSongToPlaylist(audioData);
  }

  mstreamModule.getRandomSong = function (callback) {
    const params = {
      ignoreList: autoDjIgnoreArray,
      minRating: mstreamModule.minRating,
      ignoreVPaths: mstreamModule.ignoreVPaths
    };

    MSTREAMAPI.getRandomSong(params, function (res, err) {
      if (err) {
        callback(null, err);
        return;
      }
      // Get first song from array
      const firstSong = res.songs[0];
      autoDjIgnoreArray = res.ignoreList;
      callback(firstSong, null);
    });
  }

  function autoDJ() {
    // Call mStream API for random song
    mstreamModule.getRandomSong(function (res, err) {
      if (err) {
        mstreamModule.playerStats.autoDJ = false;
        iziToast.warning({
          title: 'Auto DJ Failed',
          message: err.responseJSON.error ? err.responseJSON.error  : '',
          position: 'topCenter',
          timeout: 3500
        });
        return;
      }

      // Add song to playlist
      MSTREAMAPI.addSongWizard(res.filepath, res.metadata);
    });
  }

  function addSongToPlaylist(song) {
    mstreamModule.playlist.push(song);

    // If this the first song in the list
    if (mstreamModule.playlist.length === 1) {
      mstreamModule.positionCache.val = 0;
      return goToSong(mstreamModule.positionCache.val);
    }

    // TODO: Check if we are at the end of the playlist and nothing is playing.
    // Start playing if this condition is met
    // if(mstreamModule.positionCache.val === mstreamModule.playlist.length - 2) {
    //   var localPlayer = getCurrentPlayer();
    //   if (localPlayer.playerType === 'howler' && !localPlayer.playerObject.playing()) {
    //     mstreamModule.positionCache.val = mstreamModule.playlist.length - 1;
    //     return goToSong(mstreamModule.positionCache.val);
    //   }
    // }

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

    if (mstreamModule.playerStats.autoDJ === true) {
      autoDJ();
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
    console.log('GO GO GOG O')
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

  mstreamModule.getCurrentSong = function () {
    var lPlayer = getCurrentPlayer();
    return lPlayer.songObject;
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


  function goToSong(position) {
    if (!mstreamModule.playlist[position]) {
      return false;
    }

    if (mstreamModule.playerStats.autoDJ === true && position === mstreamModule.playlist.length - 1) {
      autoDJ();
    }

    var localPlayerObject = getCurrentPlayer();
    var otherPlayerObject = getOtherPlayer();

    // Reset Duration
    mstreamModule.playerStats.duration = 0;
    mstreamModule.playerStats.currentTime = 0;

    // Stop the current song
    // TODO: Handle situation where next song is same as current song
    if (localPlayerObject.playerType === 'howler') {
      localPlayerObject.playerObject.unload();
    }

    // Song is cached
    if (otherPlayerObject.songObject === mstreamModule.playlist[position]) {
      // console.log('USING CACHED SONG');
      flipFlop();
      // Play
      mstreamModule.playPause();
    } else {
      // console.log('DID NOT USE CACHE');
      setMedia(mstreamModule.playlist[position], localPlayerObject, true);
    }

    var lPlayer = getCurrentPlayer();
    var curSong = lPlayer.songObject;
    if (curSong.metadata) {
      mstreamModule.resetCurrentMetadata();
    }

    // connect to visualizer
    if (VIZ) {
      var audioCtx =  VIZ.get();
      var analyser = audioCtx.createAnalyser();
      try {
        var source = audioCtx.createMediaElementSource(lPlayer.playerObject._sounds[0]._node);
        source.connect(analyser);
        source.connect(audioCtx.destination);
        VIZ.connect(analyser);
      } catch( err) {
        console.log(err)
      }
    }

    // TODO: This is a mess, figure out a better way
    var newOtherPlayerObject = getOtherPlayer();
    newOtherPlayerObject.playerType = false;
    newOtherPlayerObject.playerObject = false;
    newOtherPlayerObject.songObject = false;

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
    scrobbleTimer = setTimeout(function () { mstreamModule.scrobble() }, 30000);
    return true;
  }


  mstreamModule.resetCurrentMetadata = function () {
    var lPlayer = getCurrentPlayer();
    var curSong = lPlayer.songObject;
    if (curSong.metadata) {
      mstreamModule.playerStats.metadata.artist = curSong.metadata.artist;
      mstreamModule.playerStats.metadata.album = curSong.metadata.album;
      mstreamModule.playerStats.metadata.track = curSong.metadata.track;
      mstreamModule.playerStats.metadata.title = curSong.metadata.title;
      mstreamModule.playerStats.metadata.year = curSong.metadata.year;
      mstreamModule.playerStats.metadata['album-art'] = curSong.metadata['album-art'];
    }
  }


  mstreamModule.resetPositionCache = function () {
    var len;

    var lPlayer = getCurrentPlayer();
    var curSong = lPlayer.songObject;

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
    var localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = true;

    localPlayer.playerObject.play();
  }
  function howlPlayerPause() {
    var localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = false;

    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause() {
    var localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.playing()) {
      mstreamModule.playerStats.playing = false;
      localPlayer.playerObject.pause();
    } else {
      localPlayer.playerObject.play();
      mstreamModule.playerStats.playing = true;
    }
  }
  // ========================================================


  function clearEnd() {
    var localPlayer = getCurrentPlayer();
    if (localPlayer.playerType === 'howler') {
      localPlayer.playerObject.off('end');
    }
  }

  // Player
  // Event: On Song end
  // Set Media
  // Play, pause, skip, etc
  mstreamModule.playPause = function () {
    var localPlayer = getCurrentPlayer();

    if (localPlayer.playerType === 'howler') {
      return howlPlayerPlayPause();
    }
  }

  mstreamModule.changePlaybackRate = function (newRate) {
    newRate = Number(newRate);
    if (isNaN(newRate) || newRate > 10 || newRate < 0.1) {
      console.log('Bad New Rate');
      return;
    }

    mstreamModule.playerStats.playbackRate = newRate;

    var lPlayer = getCurrentPlayer();
    if (lPlayer && lPlayer.playerObject) {
      lPlayer.playerObject.rate(newRate);
    }

    var oPlayer = getOtherPlayer();
    if (oPlayer && oPlayer.playerObject) {
      oPlayer.playerObject.rate(newRate);
    }
  }

  mstreamModule.playerStats = {
    playbackRate: 1,
    duration: 0,
    currentTime: 0,
    playing: false,
    // repeat: false,
    shuffle: false,
    volume: 100,
    metadata: {
      "artist": false,
      "album": false,
      "track": false,
      "title": false,
      "year": false,
      "album-art": false,
      "filepath": false,
    }
  }

  var playerA = {
    playerType: false,
    playerObject: false,
    songObject: false
  }
  var playerB = {
    playerType: false,
    playerObject: false,
    songObject: false
  }

  var curP = 'A';

  function setMedia(song, player, play) {
    player.playerType = 'howler';
    
    player.playerObject = new Howl({
      src: [song.url],
      volume: mstreamModule.playerStats.volume/100,
      rate: mstreamModule.playerStats.playbackRate,
      html5: true, // Force to HTML5.  Otherwise streaming will suck
      // onplay: function() {        },
      onload: function () {
        // TODO: Force cache to start
      },
      onend: function () {
        callMeOnStreamEnd();
      },
      onpause: function () {
      },
      onstop: function () {
      },
      onplay: function () {
      },
      onplayerror: function() {
        console.log('PLAY ERROR');
        // TODO: need to differentiate between real errors and mobile bullshit
        // sound.once('unlock', function() {
        //   sound.play();
        // });
      },
      onloaderror: function() {
        // Mark Song As Error
        console.log('SONG ERROR')
        song.error = true;
        if (iziToast) {
          iziToast.error({
            title: 'Failed To Play Song',
            position: 'topCenter',
            timeout: 3500
          });
        }

        var currentPlayer = getCurrentPlayer();
        if (player === currentPlayer) {
          goToNextSong();
        }else {
          // Invalidate cache
          var newOtherPlayerObject = getOtherPlayer();
          newOtherPlayerObject.playerType = false;
          newOtherPlayerObject.playerObject = false;
          newOtherPlayerObject.songObject = false;
        }
      }
    });

    if (play == true) {
      howlPlayerPlay();
    }
    
    player.songObject = song;
  }


  function callMeOnStreamEnd() {
    mstreamModule.playerStats.playing = false;
    // Go to next song
    goToNextSong();
  }

  mstreamModule.goBackSeek = function(backBy) {
    var lPlayer = getCurrentPlayer();
    var seekTo = lPlayer.playerObject.seek() - backBy;
    if (seekTo < 0) {
      seekTo = 0;
    }

    lPlayer.playerObject.seek(seekTo);
  }

  mstreamModule.goForwardSeek = function(forwardBy) {
    var lPlayer = getCurrentPlayer();
    if (lPlayer.playerObject.seek() > (lPlayer.playerObject._duration - 5) ) {
      return;
    }

    var seekTo = lPlayer.playerObject.seek() + forwardBy;
    if (seekTo >  (lPlayer.playerObject._duration - 5)) {
      seekTo = lPlayer.playerObject._duration - 5;
    }

    lPlayer.playerObject.seek(seekTo);
  }

  // NOTE: Seektime is in seconds
  mstreamModule.seek = function (seekTime) {
    var lPlayer = getCurrentPlayer( );
    if (lPlayer.playerType === 'howler') {
      // Check that the seek number is less than the duration
      if (seekTime < 0 || seekTime > lPlayer.playerObject._duration) {
        return false;
      }
      lPlayer.playerObject.seek(seektime)
    }
  }

  mstreamModule.seekByPercentage = function (percentage) {
    if (percentage < 0 || percentage > 99) {
      return false;
    }

    var lPlayer = getCurrentPlayer();
    if (lPlayer.playerType === 'howler') {
      var seektime = (percentage * lPlayer.playerObject._duration) / 100;
      lPlayer.playerObject.seek(seektime);
    }
  }

  var timers = {};
  startTime(100);
  function startTime(interval) {
    if (timers.sliderUpdateInterval) { clearInterval(timers.sliderUpdateInterval); }

    timers.sliderUpdateInterval = setInterval(function () {
      var lPlayer = getCurrentPlayer();

      if (lPlayer.playerType === 'howler') {
        mstreamModule.playerStats.currentTime = lPlayer.playerObject.seek();
        mstreamModule.playerStats.duration = lPlayer.playerObject._duration;
      } else {
        // NO PLAYER, set default values
        mstreamModule.playerStats.currentTime = 0;
        mstreamModule.playerStats.duration = 0;
      }
    }, interval);
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
  mstreamModule.playerStats.shouldLoop = false;
  mstreamModule.setRepeat = function (newValue) {
    if (typeof (newValue) != "boolean") {
      return false;
    }
    if (mstreamModule.playerStats.autoDJ === true) {
      mstreamModule.playerStats.shouldLoop = false;
      return false;
    }
    mstreamModule.playerStats.shouldLoop = newValue;
    return newValue;
  }
  mstreamModule.toggleRepeat = function () {
    if (mstreamModule.playerStats.autoDJ === true) {
      mstreamModule.playerStats.shouldLoop = false;
      return false;
    }
    mstreamModule.playerStats.shouldLoop = !mstreamModule.playerStats.shouldLoop;
    return mstreamModule.playerStats.shouldLoop;
  }

  // Random Song
  mstreamModule.playerStats.shuffle = false;
  var shuffleCache = []; // Cache the last 5 songs played to avoid repeats
  var shufflePrevious = [];
  mstreamModule.setShuffle = function (newValue) {
    if (typeof (newValue) != "boolean") {
      return false;
    }
    if (mstreamModule.playerStats.autoDJ === true) {
      mstreamModule.playerStats.shuffle = false;
      return false;
    }

    if (newValue === true) {
      newShuffle();
    } else {
      turnShuffleOff();
    }

    mstreamModule.playerStats.shuffle = newValue;
    return true;
  }
  
  mstreamModule.toggleShuffle = function () {
    if (mstreamModule.playerStats.autoDJ === true) {
      mstreamModule.playerStats.shuffle = false;
      return false;
    }
    mstreamModule.playerStats.shuffle = !mstreamModule.playerStats.shuffle;
    if (mstreamModule.playerStats.shuffle === true) {
      newShuffle();
    } else {
      turnShuffleOff();
    }
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
  var autoDjIgnoreArray = [];
  mstreamModule.ignoreVPaths = {};
  mstreamModule.minRating = 0;

  mstreamModule.toggleAutoDJ = function () {
    mstreamModule.playerStats.autoDJ = !mstreamModule.playerStats.autoDJ;
    if (mstreamModule.playerStats.autoDJ === true) {
      // Turn off shuffle & loop
      mstreamModule.playerStats.shuffle = false;
      mstreamModule.playerStats.shouldLoop = false;

      // Add song if necessary
      if (mstreamModule.playlist.length === 0 || mstreamModule.positionCache.val === mstreamModule.playlist.length - 1) {
        autoDJ();
      }
    }

    return mstreamModule.playerStats.autoDJ;
  }

  // Return an object that is assigned to Module
  return mstreamModule;
}());
