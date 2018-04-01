var MSTREAMPLAYER = (function () {
  let mstreamModule = {};

  // Playlist variables
  mstreamModule.positionCache = { val: -1 };
  // var currentSong;
  mstreamModule.playlist = [];

  mstreamModule.editSongMetadata = function (key, value, songIndex) {
    for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
      if (mstreamModule.playlist[i].filepath === mstreamModule.playlist[songIndex].filepath) {
        mstreamModule.positionCache.val = i;
        mstreamModule.playlist[i].metadata[key] = value;
      }
    }
  }

  mstreamModule.changeVolume = function (newVolume) {
    if (newVolume < 0 || newVolume > 100) {
      return;
    }
    mstreamModule.playerStats.volume = newVolume;

    AV.Player.volume = newVolume;
    Howler.volume(newVolume / 100)
  }

  // Scrobble function
  // This is a placeholder function that the API layer can take hgold of to implmenmt the scrobble call
  // This
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

    //  Handle shuffle
    if (mstreamModule.playerStats.shuffle === true) {
      var pos = Math.floor(Math.random() * (shuffleCache.length + 1));
      shuffleCache.splice(pos, 0, audioData);
    }

    return addSongToPlaylist(audioData);
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

    // Cache song if appropriate
    var oPlayer = getOtherPlayer();
    if (oPlayer.playerObject === false && mstreamModule.playlist[mstreamModule.positionCache.val + 1]) {
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () { setCachedSong(mstreamModule.positionCache.val + 1) }, 33000);
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
    if (!mstreamModule.playlist[position]) {
      return false;
    }

    clearEnd();

    mstreamModule.positionCache.val = position;
    return goToSong(mstreamModule.positionCache.val);
  }

  // TODO: Log Failures
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
      } else if (mstreamModule.playerStats.shouldLoop === true) { // Loop is loop is set
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
      // Lower positioncache by 1 if necessary
      mstreamModule.positionCache.val--;
    } else if (position === (mstreamModule.positionCache.val + 1)) {
      // setCachedSong(mstreamModule.positionCache.val + 1);
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () { setCachedSong(mstreamModule.positionCache.val + 1) }, 33000);
    }
  }

  mstreamModule.getCurrentSong = function () {
    var lPlayer = getCurrentPlayer();
    return lPlayer.songObject;
  }

  function goToPreviousSong() {
    // TODO: If random is set, go to previous song from cache
    if (mstreamModule.playerStats.shuffle === true) {
      // TODO: Check that there is a previous song to go back to
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
    if (mstreamModule.positionCache.val === 0 || mstreamModule.positionCache.val === -1) {
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

      // Load selected song
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

    var localPlayerObject = getCurrentPlayer();
    var otherPlayerObject = getOtherPlayer();

    // Stop the current song
    if (localPlayerObject.playerType === 'aurora') {
      localPlayerObject.playerObject.stop();
    } else if (localPlayerObject.playerType === 'howler') {
      localPlayerObject.playerObject.unload();
    }

    // Reset Duration
    mstreamModule.playerStats.duration = 0;
    mstreamModule.playerStats.currentTime = 0;

    // TODO: Handle situation where next song is same as current song

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
    // TODO: Handle instace where metadata is empty
    // mstreamModule.playerStats.metadata = curSong.metadata;
    if (curSong.metadata) {
      mstreamModule.resetCurrentMetadata();
    }


    // TODO: This is a mess, figure out a better way
    var newOtherPlayerObject = getOtherPlayer();
    newOtherPlayerObject.playerType = false;
    newOtherPlayerObject.playerObject = false;
    newOtherPlayerObject.songObject = false;

    // Cache next song
    // The timer prevents excessive cachign when the user starts button mashing
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () { setCachedSong(position + 1) }, 33000);

    // Scrobble song after 30 seconds
    clearTimeout(scrobbleTimer);
    scrobbleTimer = setTimeout(function () { mstreamModule.scrobble() }, 30000);
    return true;
  }


  mstreamModule.resetCurrentMetadata = function () {
    var lPlayer = getCurrentPlayer();
    var curSong = lPlayer.songObject;
    // TODO: Handle instace where metadata is empty
    // mstreamModule.playerStats.metadata = curSong.metadata;
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



  // ========================= Aurora Player ===============
  //  Shell for interacting with Aurora
  function AVPlayerPlay() {
    var localPlayer = getCurrentPlayer();

    if (localPlayer.playerObject.playing) {
      return;
    }
    localPlayer.playerObject.play();
    mstreamModule.playerStats.playing = true;

  }
  function AVPlayerPause() {
    var localPlayer = getCurrentPlayer();

    localPlayer.playerObject.pause();
    mstreamModule.playerStats.playing = false;

  }
  function AVPlayerPlayPause() {
    var localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.playing) {
      localPlayer.playerObject.pause();
      mstreamModule.playerStats.playing = false;
    } else {
      localPlayer.playerObject.play();
      mstreamModule.playerStats.playing = true;
    }
  }
  // ========================================================





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



  // ========================= Youtube Player ===============
  var YTPlayer;
  // TODO:
  // ========================================================


  function clearEnd() {
    var localPlayer = getCurrentPlayer();

    if (localPlayer.playerType === 'aurora') {
      localPlayer.playerObject.on("end", function () {
        return
      }, false);
    } else if (localPlayer.playerType === 'howler') {
      localPlayer.playerObject.off('end');
    }
  }



  // Player
  // Event: On Song end
  // Set Media
  // Play, pause, skip, etc
  mstreamModule.playPause = function () {
    var localPlayer = getCurrentPlayer();

    if (localPlayer.playerType === 'aurora') {
      return AVPlayerPlayPause();
    } else if (localPlayer.playerType === 'howler') {
      return howlPlayerPlayPause();
    }
  }


  mstreamModule.playerStats = {
    duration: 0,
    currentTime: 0,
    playing: false,
    repeat: false,
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

    if (song.url.indexOf('.flac') !== -1 && Howler.codecs('flac') === false) {
      // Set via aurora
      player.playerType = 'aurora';

      player.playerObject = AV.Player.fromURL(song.url);
      player.playerObject.on("end", function () {
        callMeOnStreamEnd();
      }, false);
      // Handle error event
      player.playerObject.on("error", function (e) {
        // TODO: GO TO NEXT SONG
      }, false);
      player.playerObject.on("metadata", function () {
        //  Move this to metadata ???
        if (play == true) {
          AVPlayerPlay();
        }
      }, false);

      player.playerObject.preload();

    } else {
      player.playerType = 'howler';

      player.playerObject = new Howl({
        src: [song.url],
        html5: true, // Force to HTML5.  Otherwise streaming will suck
        // onplay: function() {        },
        onload: function () {

        },
        onend: function () {
          callMeOnStreamEnd();
        },
        onpause: function () {
        },
        onstop: function () {
        },
        onplay: function () {
        }
      });

      if (play == true) {
        howlPlayerPlay();
      }
    }

    player.songObject = song;
  }



  function callMeOnStreamEnd() {
    mstreamModule.playerStats.playing = false;

    // Go to next song
    goToNextSong();
  }





  // NOTE: Seektime is in seconds
  mstreamModule.seek = function (seekTime) {
    var lPlayer = getCurrentPlayer();
    if (lPlayer.playerType === 'aurora') {
      // Do nothing, auroradoesn't support seeking right now
      return false;
    } else if (lPlayer.playerType === 'howler') {
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

    if (lPlayer.playerType === 'aurora') {
      // Do nothing, auroradoesn't support seeking
      return false;
    } else if (lPlayer.playerType === 'howler') {
      var seektime = (percentage * lPlayer.playerObject._duration) / 100;
      lPlayer.playerObject.seek(seektime)
    }

  }



  var timers = {};

  function startTime(interval) {
    if (timers.sliderUpdateInterval) { clearInterval(timers.sliderUpdateInterval); }


    timers.sliderUpdateInterval = setInterval(function () {
      var lPlayer = getCurrentPlayer();

      if (lPlayer.playerType === 'aurora') {
        mstreamModule.playerStats.duration = lPlayer.playerObject.duration / 1000;
        mstreamModule.playerStats.currentTime = lPlayer.playerObject.currentTime / 1000;
      } else if (lPlayer.playerType === 'howler') {
        mstreamModule.playerStats.currentTime = lPlayer.playerObject.seek();
        mstreamModule.playerStats.duration = lPlayer.playerObject._duration;

      } else {
        // NO PLAYER, set default values
        mstreamModule.playerStats.currentTime = 0;
        mstreamModule.playerStats.duration = 0;
      }

    }, interval);
  }
  startTime(100);

  function clearTimer() {
    clearInterval(timers.sliderUpdateInterval);
  }


  // Timer for caching.  Helps prevent excess cahing due to button mashing
  var cacheTimer;
  function setCachedSong(position) {

    console.log(' ATTEMPTING TO CACHE');
    if (!mstreamModule.playlist[position]) {
      console.log(' FAILED TO CACHE');
      return false;
    }

    var oPlayer = getOtherPlayer();
    setMedia(mstreamModule.playlist[position], oPlayer, false);
    console.log(' IT CACHED!!!!!!');
    console.log(mstreamModule.playlist[position]);

    return true;
  }


  // Loop
  mstreamModule.playerStats.shouldLoop = false;
  mstreamModule.setRepeat = function (newValue) {
    if (typeof (newValue) != "boolean") {
      return false;
    }
    mstreamModule.playerStats.shouldLoop = newValue;
    return newValue;
  }
  mstreamModule.toggleRepeat = function () {
    mstreamModule.playerStats.shouldLoop = !mstreamModule.playerStats.shouldLoop;
    return mstreamModule.playerStats.shouldLoop;
  }

  // Random Song
  mstreamModule.playerStats.shuffle = false;
  shuffleCache = []; // Cache the last 5 songs played to avoid repeats
  shufflePrevious = [];
  mstreamModule.setShuffle = function (newValue) {
    if (typeof (newValue) != "boolean") {
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

  // Return an object that is assigned to Module
  return mstreamModule;
}());
