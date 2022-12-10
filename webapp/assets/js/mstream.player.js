const MSTREAMPLAYER = (() => {
  const mstreamModule = {};

  mstreamModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    defaultBitrate: null,
    defaultCodec: null,
    defaultAlgo: null,
    selectedBitrate: null,
    selectedCodec: null,
    selectedAlgo: null,
  };

  // Playlist variables
  mstreamModule.positionCache = { val: -1 };
  mstreamModule.playlist = [];
  const cacheTimeout = 30000;
  
  var currentReplayGainAmp = 1.0;

  mstreamModule.editSongMetadata = function (key, value, songIndex) {
    for (var i = 0, len = mstreamModule.playlist.length; i < len; i++) {
      if ((mstreamModule.playlist[i].metadata && mstreamModule.playlist[i].metadata.hash === mstreamModule.playlist[songIndex].metadata.hash) || mstreamModule.playlist[i].filepath === mstreamModule.playlist[songIndex].filepath) {
        mstreamModule.playlist[i].metadata[key] = value;
      }
    }
  }

  mstreamModule.changeVolume = (newVolume) => {
    if (isNaN(newVolume) || newVolume < 0 || newVolume > 100) {
      return;
    }
    mstreamModule.playerStats.volume = newVolume;

    const rgainAdjustedVolume = newVolume / 100 * currentReplayGainAmp;
    getCurrentPlayer().playerObject.volume = rgainAdjustedVolume;
    getOtherPlayer().playerObject.volume = rgainAdjustedVolume;
  }

  // Scrobble function
  // This is a placeholder function that the API layer can take hold of to implement the scrobble call
  let scrobbleTimer;
  mstreamModule.scrobble = () => {
    MSTREAMAPI.scrobbleByFilePath(
      mstreamModule.getCurrentSong().rawFilePath, 
      (response, error) => {});
  }

  // The audioData looks like this
  // var song = {
  //   "url":"vPath/path/to/song.mp3?token=xxx",
  //   "filepath": "path/to/song.mp3"
  // }
  mstreamModule.addSong = (audioData, forceAutoPlayOff) => {
    if (!audioData.url || audioData.url == false) {
      return false;
    }

    audioData.error = false;

    // Handle shuffle
    if (mstreamModule.playerStats.shuffle === true) {
      const pos = Math.floor(Math.random() * (shuffleCache.length + 1));
      shuffleCache.splice(pos, 0, audioData);
    }

    return addSongToPlaylist(audioData, forceAutoPlayOff);
  }

  async function autoDJ() {
    try {
      const params = {
        ignoreList: autoDjIgnoreArray,
        minRating: mstreamModule.minRating,
        ignoreVPaths: Object.keys(mstreamModule.ignoreVPaths).filter((vpath) => {
          return mstreamModule.ignoreVPaths[vpath] === true;
        })
      };
  
      const res = await MSTREAMAPI.getRandomSong(params);
      autoDjIgnoreArray = res.ignoreList;

      VUEPLAYERCORE.addSongWizard(res.songs[0].filepath, res.songs[0].metadata);

    }catch (err) {
      console.log(err);
      iziToast.warning({
        title: 'Auto DJ Failed',
        position: 'topCenter',
        timeout: 3500
      });
    }
  }

  function addSongToPlaylist(song, forceAutoPlayOff) {
    mstreamModule.playlist.push(song);

    // If this the first song in the list
    if (mstreamModule.playlist.length === 1) {
      mstreamModule.positionCache.val = 0;
      return goToSong(mstreamModule.positionCache.val, forceAutoPlayOff);
    }

    // TODO: Check if we are at the end of the playlist and nothing is playing.

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

  mstreamModule.insertSongAt = (song, position, playNow) => {
    if (!song.url || song.url == false) {
      return false;
    }

    song.error = false;

    mstreamModule.playlist.splice(position, 0, song);

    if (playNow) {
      mstreamModule.positionCache.val = position;
      goToSong(mstreamModule.positionCache.val);
    }

    // TODO: Check cache. Since we use this for play now only, the cache is usually preserved
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

  mstreamModule.getCurrentSong = () => {
    return getCurrentPlayer().songObject;
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


  function goToSong(position, forceAutoPlayOff) {
    if (!mstreamModule.playlist[position]) {
      return false;
    }

    if (mstreamModule.playerStats.autoDJ === true && position === mstreamModule.playlist.length - 1) {
      autoDJ();
    }

    // Reset Duration
    mstreamModule.playerStats.duration = 0;
    mstreamModule.playerStats.currentTime = 0;

    // Stop the current song
    getCurrentPlayer().playerObject.pause();
    getCurrentPlayer().playerObject.currentTime = 0;

    // Song is cached
    flipFlop();
    if (getCurrentPlayer().songObject === mstreamModule.playlist[position]) {
      // Play
      mstreamModule.playPause();
    } else {
      // console.log('DID NOT USE CACHE');
      setMedia(mstreamModule.playlist[position], getCurrentPlayer(), typeof forceAutoPlayOff !== 'undefined' ? !forceAutoPlayOff : true);
    }

    mstreamModule.resetCurrentMetadata();
    
    // connect to visualizer
    if (typeof VIZ !== 'undefined') {
      var audioCtx = VIZ.get();
      try {
        var audioNode = getCurrentPlayer().playerObject;
        if (!audioNode.previouslyConnectedViz) {
          var analyser = audioCtx.createAnalyser();
          var source = audioCtx.createMediaElementSource(audioNode);
          source.connect(analyser);
          source.connect(audioCtx.destination);
          VIZ.connect(analyser);
          audioNode.previouslyConnectedViz = true;
        }
      } catch( err) {
        console.log(err);
      }
    }

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
    scrobbleTimer = setTimeout(() => { mstreamModule.scrobble() }, 30000);
  }

  // Should be called whenever the "metadata" field of the current song is changed, or
  // the current song is changed.
  mstreamModule.resetCurrentMetadata = () => {
    const curSong = getCurrentPlayer().songObject;
    mstreamModule.playerStats.metadata.artist = curSong.metadata && curSong.metadata.artist ? curSong.metadata.artist : "";
    mstreamModule.playerStats.metadata.album = curSong.metadata && curSong.metadata.album  ? curSong.metadata.album : "";
    mstreamModule.playerStats.metadata.track = curSong.metadata && curSong.metadata.track ? curSong.metadata.track : "";
    mstreamModule.playerStats.metadata.title = curSong.metadata && curSong.metadata.title ? curSong.metadata.title : "";
    mstreamModule.playerStats.metadata.year = curSong.metadata && curSong.metadata.year ? curSong.metadata.year : "";
    mstreamModule.playerStats.metadata['album-art'] = curSong.metadata && curSong.metadata['album-art'] ? curSong.metadata['album-art'] : "";
    mstreamModule.playerStats.metadata['replaygain-track-db'] = curSong.metadata && curSong.metadata['replaygain-track-db'] ? curSong.metadata['replaygain-track-db'] : "";
    mstreamModule.playerStats.metadata.filepath = curSong.rawFilePath;

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: mstreamModule.playerStats.metadata.title,
        artist: mstreamModule.playerStats.metadata.artist,
        album: mstreamModule.playerStats.metadata.album,
        artwork: [] //TODO: Get album art working here
      });
    }
    
    let pageTitle = (mstreamModule.playerStats.metadata.title) ? 
    mstreamModule.playerStats.metadata.title + ' - ' + mstreamModule.playerStats.metadata.artist : // if metadata exists
        (mstreamModule.playerStats.metadata.filepath ? mstreamModule.playerStats.metadata.filepath.split('/').pop() : 'mStream Music');
    document.title = pageTitle; // set page title when song is playing
    
    mstreamModule.updateReplayGainFromSong(curSong);
  }

  // Update ReplayGain state from given song, if required.
  mstreamModule.updateReplayGainFromSong = function (song) {
    console.assert(song);
    var newRgAmpValue = undefined;

    if (mstreamModule.playerStats.replayGain) {
      if (song.metadata) {
        const rgainDb = song.metadata['replaygain-track-db'];
        if (rgainDb) {
          // Note: the music-metadata package has a similar calculation in its Utils class, and that's used to
          // calculate a returned 'ratio' value. However, the calculation used there is actually calculating the power
          // ratio and not the amplitude ratio as required. As power is amplitude squared, that results in a volume
          // reduction that's too small (i.e. 0.25**2 = 0.00625).
          newRgAmpValue = Math.pow(10, (rgainDb + mstreamModule.playerStats.replayGainPreGainDb) / 20)
        }
      }

      if (newRgAmpValue === undefined) {
        currentReplayGainAmp = 0.316; // -10 db for songs without ReplayGain info.
      } else {
        currentReplayGainAmp = newRgAmpValue;
      }
    } else {
      currentReplayGainAmp = 1.0;
    }
    
    mstreamModule.changeVolume(mstreamModule.playerStats.volume);
  }

  mstreamModule.resetPositionCache = function () {
    var len;

    const curSong = getCurrentPlayer().songObject;

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
    const localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = true;

    localPlayer.playerObject.play();
  }
  function howlPlayerPause() {
    const localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = false;

    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause() {
    const localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.paused === false) {
      mstreamModule.playerStats.playing = false;
      localPlayer.playerObject.pause();
      document.title = "mStream Music"
    } else {
      localPlayer.playerObject.play();
      
      let pageTitle = (mstreamModule.playerStats.metadata.title) ? 
        mstreamModule.playerStats.metadata.title + ' - ' + mstreamModule.playerStats.metadata.artist : // if metadata exists
        (mstreamModule.playerStats.metadata.filepath ? mstreamModule.playerStats.metadata.filepath.split('/').pop() : 'mStream Music');
      document.title = pageTitle; // set page title when song is playing
      
      mstreamModule.playerStats.playing = true;
    }
  }
  // ========================================================


  function clearEnd() {
    const localPlayer = getCurrentPlayer();
    localPlayer.playerObject.onended = () => {};
  }

  // Player
  // Event: On Song end
  // Set Media
  // Play, pause, skip, etc
  mstreamModule.playPause = () => {
    return howlPlayerPlayPause();
  }

  mstreamModule.changePlaybackRate = (newRate) => {
    newRate = Number(newRate);
    if (isNaN(newRate) || newRate > 10 || newRate < 0.1) {
      console.log('Bad New Rate');
      return;
    }

    mstreamModule.playerStats.playbackRate = newRate;

    const lPlayer = getCurrentPlayer();
    lPlayer.playerObject.playbackRate = newRate;
    
    const oPlayer = getOtherPlayer();
    oPlayer.playerObject.playbackRate = newRate;
  }

  mstreamModule.playerStats = {
    playbackRate: 1,
    duration: 0,
    currentTime: 0,
    playing: false,
    shouldLoop: false,
    shouldLoopOne: false,
    shuffle: false,
    volume: 100,
    metadata: {
      "artist": "",
      "album": "",
      "track": "",
      "title": "",
      "year": "",
      "album-art": "",
    },
    replayGain: false,
    replayGainPreGainDb: 0
  }

  function makeNewPlayer(playerObj) {
    playerObj.playerObject = new Audio();
    playerObj.playerObject.volume = mstreamModule.playerStats.volume/100;
    playerObj.playerObject.playbackRate =  mstreamModule.playerStats.playbackRate;

    playerObj.playerObject.addEventListener('error', err => {
      console.log(err)
      if (playerObj.songObject) { playerObj.songObject.error = true; }
      if (iziToast) {
        iziToast.error({
          title: 'Failed To Play Song',
          position: 'topCenter',
          timeout: 3500
        });
      }

      if (playerObj === getCurrentPlayer()) {
        goToNextSong();
      }else {
        // Invalidate cache
        const newOtherPlayerObject = getOtherPlayer();
        newOtherPlayerObject.songObject = false;
        playerObj.playerObject.onended = () => {};
      }
    });

    playerObj.playerObject.addEventListener('timeupdate', err => {
      mstreamModule.playerStats.currentTime = getCurrentPlayer().playerObject.currentTime;
      mstreamModule.playerStats.duration = getCurrentPlayer().playerObject.duration;
    });
  }

  const playerA = {
    playerObject: false,
    songObject: false
  }
  const playerB = {
    playerObject: false,
    songObject: false
  }

  makeNewPlayer(playerA);
  makeNewPlayer(playerB);

  var curP = 'A';

  function setMedia(song, player, play) {
    let url = song.url;
    if(mstreamModule.transcodeOptions.serverEnabled === true && mstreamModule.transcodeOptions.frontendEnabled === true) {
      if (mstreamModule.transcodeOptions.selectedBitrate !== null) {
        url += `&bitrate=${mstreamModule.transcodeOptions.selectedBitrate}`;
      }
      if (mstreamModule.transcodeOptions.selectedCodec !== null) {
        url += `&codec=${mstreamModule.transcodeOptions.selectedCodec}`;
      }
      if (mstreamModule.transcodeOptions.selectedAlgo !== null) {
        url += `&algo=${mstreamModule.transcodeOptions.selectedAlgo}`;
      }
    }

    player.playerObject.src = url;
    player.songObject = song;
    player.playerObject.load();
    player.playerObject.playbackRate = mstreamModule.playerStats.playbackRate;
    
    player.playerObject.onended = () => {
      callMeOnStreamEnd();
    }

    if (play == true) {
      howlPlayerPlay();
    }
  }

  function callMeOnStreamEnd() {
    mstreamModule.playerStats.playing = false;
    if (mstreamModule.playerStats.shouldLoopOne === true) {
      return goToSong(mstreamModule.positionCache.val);
    }
    // Go to next song
    goToNextSong();
  }

  mstreamModule.goBackSeek = (backBy) => {
    const lPlayer = getCurrentPlayer();
    var seekTo = lPlayer.playerObject.currentTime - backBy;
    if (seekTo < 0) {
      seekTo = 0;
    }

    lPlayer.playerObject.currentTime = seekTo;
  }

  mstreamModule.goForwardSeek = (forwardBy) => {
    const lPlayer = getCurrentPlayer();
    if (lPlayer.playerObject.currentTime > (lPlayer.playerObject.duration - 5) ) {
      return;
    }

    let seekTo = lPlayer.playerObject.currentTime + forwardBy;
    if (seekTo >  (lPlayer.playerObject.duration - 5)) {
      seekTo = lPlayer.playerObject.duration - 5;
    }

    lPlayer.playerObject.currentTime = seekTo;
  }

  // NOTE: Seektime is in seconds
  mstreamModule.seek = (seekTime) => {
    const lPlayer = getCurrentPlayer();
    // Check that the seek number is less than the duration
    if (seekTime < 0 || seekTime > lPlayer.playerObject.duration) {
      return false;
    }
    lPlayer.playerObject.currentTime = seektime;
  }

  mstreamModule.seekByPercentage = (percentage) => {
    if (percentage < 0 || percentage > 99) {
      return false;
    }

    const lPlayer = getCurrentPlayer();
    if (!lPlayer.songObject) { return; }
    const seektime = (percentage * lPlayer.playerObject.duration) / 100;
    lPlayer.playerObject.currentTime = seektime;
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
  mstreamModule.toggleRepeat = () => {
    if (mstreamModule.playerStats.autoDJ === true) { return; }

    if (mstreamModule.playerStats.shouldLoopOne === true) {
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = false;
    } else if (mstreamModule.playerStats.shouldLoop === true) {
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = true;
    } else {
      mstreamModule.playerStats.shouldLoop = true;
      mstreamModule.playerStats.shouldLoopOne = false;
    }
  }

  // Random Song
  var shuffleCache = []; // Cache the last 5 songs played to avoid repeats
  var shufflePrevious = [];
  mstreamModule.setShuffle = (newValue) => {
    if (typeof newValue !== "boolean") { return; }
    if (mstreamModule.playerStats.autoDJ === true) { return; }

    mstreamModule.playerStats.shuffle = newValue;
    mstreamModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
  }
  
  mstreamModule.toggleShuffle = () => {
    if (mstreamModule.playerStats.autoDJ === true) { return; }
    mstreamModule.playerStats.shuffle = !mstreamModule.playerStats.shuffle;
    mstreamModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
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

  mstreamModule.toggleAutoDJ = () => {
    mstreamModule.playerStats.autoDJ = !mstreamModule.playerStats.autoDJ;
    if (mstreamModule.playerStats.autoDJ === true) {
      // Turn off shuffle & loop
      mstreamModule.playerStats.shuffle = false;
      mstreamModule.playerStats.shouldLoop = false;
      mstreamModule.playerStats.shouldLoopOne = false;

      // Add song if necessary
      if (mstreamModule.playlist.length === 0 || mstreamModule.positionCache.val === mstreamModule.playlist.length - 1) {
        autoDJ();
      }
    }

    return mstreamModule.playerStats.autoDJ;
  }

  // ReplayGain
  mstreamModule.setReplayGainActive = (isActive) => {
    mstreamModule.playerStats.replayGain = isActive;
    if (getCurrentPlayer().songObject) {
      mstreamModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  mstreamModule.setReplayGainPreGainDb = (db) => {
    mstreamModule.playerStats.replayGainPreGainDb = db;
    if (getCurrentPlayer().songObject) {
      mstreamModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  // Setup Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function() { howlPlayerPlay(); });
    navigator.mediaSession.setActionHandler('pause', function() { howlPlayerPause(); });
    navigator.mediaSession.setActionHandler('stop', function() { howlPlayerPause(); });
    // navigator.mediaSession.setActionHandler('seekbackward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekforward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekto', function() { /* Code excerpted. */ });
    navigator.mediaSession.setActionHandler('previoustrack', function() { goToPreviousSong(); });
    navigator.mediaSession.setActionHandler('nexttrack', function() { goToNextSong() });
  }

  // Return an object that is assigned to Module
  return mstreamModule;
})();
