var MSTREAM = (function () {
  let mstreamModule = {};




  // Playlist variables
  mstreamModule.positionCache = {val:-1};
  // var currentSong;
  mstreamModule.playlist = [];


  // Loop
  var shouldLoop = false;
  mstreamModule.setLoop = function(newValue){
    if(typeof(newValue) != "boolean"){
      return false;
    }
    shouldLoop = newValue;
    return true;
  }

  // Random Song
  var randomSong = false;
  randomSongCache = []; // Cache the last 5 songs played to avoid repeats
  mstreamModule.setRandom = function(newValue){
    if(typeof(newValue) != "boolean"){
      return false;
    }
    randomSong = newValue;
    return true;
  }

  // var song = {
  //   "filepath":"path/to/song",
  //   "artist":"CCC",
  //   "album":"GGG",
  //   "name":" song name"
  //   "album-art":"path/to/art"
  // }
  // Playlists
    // Playlist object
      // Function: Add songs to bottom
      // Function: Add songs to top
      // Function: clear Playlist
      // function: clearAndAdd - wrapper function that clear playlsit and then adds new songs
      // function: goToNextSong
      // function: goToPreviousSong
      // function: goToSongWithID
    // Settings:
      // Song end bahviour: random, next,
      // Playlist end behavior: go to beginning, do nothing



  mstreamModule.addSong = function(filepath, metadata = null){
    var song = {
      filepath:filepath,
    }

    return addSongToPlaylist(song);
  }

  function addSongToPlaylist(song){
    mstreamModule.playlist.push(song);

    // If this the first song in the list
    if(mstreamModule.playlist.length === 1){
      mstreamModule.positionCache.val = 0;
      return goToSong(mstreamModule.positionCache.val);
    }

    // TODO: Check if we are at the end of the playlist and nothing is playing.
      // Start playing if this condition is met

    // Cache song if appropriate
    var oPlayer = getOtherPlayer();
    if(oPlayer.playerObject === false  &&  mstreamModule.playlist[mstreamModule.positionCache.val + 1]){
      setCachedSong(mstreamModule.positionCache.val + 1);
    }

    return true;
  }



  mstreamModule.clearAndPlay = function(song){
    // Clear playlist
    mstreamModule.playlist = [];

    return addSong(song);
  }

  mstreamModule.clearPlaylist = function(){
    mstreamModule.playlist = [];
    mstreamModule.positionCache.val = -1;
    return true;
  }

  mstreamModule.nextSong = function(){
    // Stop the current song
    clearEnd();
    return goToNextSong();
  }
  mstreamModule.previousSong = function(){
    return goToPreviousSong();
  }


  mstreamModule.goToSongAtPosition = function(position){
    if(position > mstreamModule.playlist.length || position < 0){
      return false;
    }

    clearEnd();

    mstreamModule.positionCache.val = position;
    return goToSong(mstreamModule.positionCache.val);
  }

  // TODO: Log Failures
  mstreamModule.removeSongAtPosition = function(position, sanityCheckFilepath = false){
    // Check that position is filled
    if (position > mstreamModule.playlist.length || position < 0) {
      return false;
    }
    // If sanityCheckFilepath, check that filepaths are the same
    if(sanityCheckFilepath && sanityCheckFilepath != mstreamModule.playlist[position].filepath){
      return false;
    }

    // Remove song
    mstreamModule.playlist.splice(position, 1);

    // Handle case where user removes current song and it's the last song in the playlist
    if(position === mstreamModule.positionCache.val && position === mstreamModule.playlist.length ){
      clearEnd();
      mstreamModule.positionCache.val = -1;
    }else if(position === mstreamModule.positionCache.val){ // User removes currently playing song
      // Go to next song
      clearEnd();
      goToSong(mstreamModule.positionCache.val);

    }else if( position < mstreamModule.positionCache.val){
      // Lower positioncache by 1 if necessary
      mstreamModule.positionCache.val--;
    }else if( position === (mstreamModule.positionCache.val + 1) ){
      setCachedSong(mstreamModule.positionCache.val + 1);
    }
  }

  mstreamModule.getCurrentSong = function(){
    var lPlayer = getCurrentPlayer();
    return lPlayer.songObject;
  }

  function goToPreviousSong(){
    // Make sure there is a previous song
    if(mstreamModule.positionCache.val === 0 || mstreamModule.positionCache.val === -1){
      return false;
    }

    // TODO: If random is set, go to previous song from cache

    // Set previous song and play
    clearEnd();
    mstreamModule.positionCache.val--;
    return goToSong(mstreamModule.positionCache.val);
  }

  function goToNextSong(){

    // Check if the next song exists
    if(!mstreamModule.playlist[mstreamModule.positionCache.val + 1]){
      // If loop is set and no other song, go back to first song
      if(shouldLoop === true && mstreamModule.playlist.length > 0){
        mstreamModule.positionCache.val = 0;

        return goToSong(mstreamModule.positionCache.val);
      }

      return false;
    }

    // TODO: If random is set, go to random song

    // Load up next song
    mstreamModule.positionCache.val++;
    return goToSong(mstreamModule.positionCache.val);
  }


  function getCurrentPlayer(){
    if(curP === 'A'){
      return playerA;
    }else if(curP === 'B'){
      return playerB;
    }

    return false;
  }

  function getOtherPlayer(){
    if(curP === 'A'){
      return playerB;
    }else if(curP === 'B'){
      return playerA;
    }

    return false;
  }

  function flipFlop(){
    if(curP === 'A'){
      curP = 'B';
    }else if(curP === 'B'){
      curP = 'A';
    }

    return curP;
  }


  function goToSong(position){
    if(!mstreamModule.playlist[position]){
      return false;
    }

    var localPlayerObject = getCurrentPlayer();
    var otherPlayerObject = getOtherPlayer();

    // Stop the current song
    if(localPlayerObject.playerType === 'aurora' ){
      localPlayerObject.playerObject.stop();
    }else if(localPlayerObject.playerType === 'howler'){
      localPlayerObject.playerObject.unload();
    }

    // Reset Duration
    mstreamModule.playerStats.duration = 0;
    mstreamModule.playerStats.currentTime = 0;


    // Song is cached
    if(otherPlayerObject.songObject === mstreamModule.playlist[position]){
      console.log('USING CACHED SONG');
      flipFlop();
      // Play
      mstreamModule.playPause();

    }else{
      console.log('DID NOT USE CACHE');

      console.log(otherPlayerObject.songObject);
      console.log(mstreamModule.playlist[position]);

      setMedia(mstreamModule.playlist[position], localPlayerObject, true);
    }

    // TODO: This is a mess, figure out a better way
    var newOtherPlayerObject = getOtherPlayer();
    newOtherPlayerObject.playerType = false;
    newOtherPlayerObject.playerObject =  false;
    newOtherPlayerObject.songObject= false;

    // Cache next song
    // The timer prevents excessive cachign when the user starts button mashing
    // setCachedSong(position + 1);
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function(){ setCachedSong(position + 1) } , 3000);


    return true;
  }


  // TODO: Handle cached song stuff
  mstreamModule.resetPositionCache = function(){
    var len;

    var lPlayer =  getCurrentPlayer();
    var curSong = lPlayer.songObject;

    for(var i=0, len=mstreamModule.playlist.length; i < len; i++){
      // Check if this is the current song
      if(curSong === mstreamModule.playlist[i]){
        mstreamModule.positionCache.val = i;
        return;
      }
    }

    // TODO: What happens if we get here???

  }



  // ========================= Aurora Player ===============
  //  Shell for interacting with Aurora
  function AVPlayerPlay(){
    var localPlayer = getCurrentPlayer();

    if(localPlayer.playerObject.playing){
      return;
    }
    localPlayer.playerObject.play();
    mstreamModule.playerStats.playing = true;

  }
  function AVPlayerPause(){
    var localPlayer = getCurrentPlayer();

    localPlayer.playerObject.pause();
    mstreamModule.playerStats.playing = false;

  }
  function AVPlayerPlayPause(){
    var localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if(localPlayer.playerObject.playing){
      localPlayer.playerObject.pause();
      mstreamModule.playerStats.playing = false;
    }else{
      localPlayer.playerObject.play();
      mstreamModule.playerStats.playing = true;
    }
  }
  // ========================================================





  // ========================= Howler Player ===============
  function howlPlayerPlay(){
    var localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = true;

    localPlayer.playerObject.play();
  }
  function howlPlayerPause(){
    var localPlayer = getCurrentPlayer();
    mstreamModule.playerStats.playing = false;

    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause(){
    var localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if(localPlayer.playerObject.playing()){
      mstreamModule.playerStats.playing = false;
      localPlayer.playerObject.pause();
    }else{
      localPlayer.playerObject.play();
      mstreamModule.playerStats.playing = true;

    }
  }
  // ========================================================



  // ========================= Youtube Player ===============
  var YTPlayer;
  // TODO:
  // ========================================================


  function clearEnd(){
    var localPlayer = getCurrentPlayer();

    if(localPlayer.playerType === 'aurora' ){
      localPlayer.playerObject.on("end", function() {
        return
      }, false);
    }else if(localPlayer.playerType === 'howler'){
      localPlayer.playerObject.off('end');
    }
  }



  // Player
    // Event: On Song end
    // Set Media
    // Play, pause, skip, etc
  mstreamModule.playPause = function(){
    var localPlayer = getCurrentPlayer();

    if(localPlayer.playerType === 'aurora' ){
      return AVPlayerPlayPause();
    }else if(localPlayer.playerType === 'howler'){
      return howlPlayerPlayPause();
    }
  }


  mstreamModule.playerStats = {
    duration:0,
    currentTime:0,
    playing: false
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

  // var playerType = false;
  function setMedia(song, player, play){
    // // Stop the current song
    // if(player.playerType === 'aurora' ){
    //   player.playerObject.stop();
    // }else if(player.playerType === 'howler'){
    //   player.playerObject.unload();
    // }

    if(song.filepath.indexOf('.flac') !== -1  && Howler.codecs('flac') === false ){
      // Set via aurora
      player.playerType = 'aurora';


      player.playerObject = AV.Player.fromURL(song.filepath);
      player.playerObject.on("end", function() {
        callMeOnStreamEnd();
      }, false);
      // Handle error event
      player.playerObject.on("error", function(e) {
        // TODO: GO TO NEXT SONG
      }, false);
      player.playerObject.on("metadata", function() {
        //  Move this to metadata ???
        if(play == true){
          AVPlayerPlay();
        }
      }, false);

      player.playerObject.preload();




    }else{
      player.playerType = 'howler';

      player.playerObject = new Howl({
        src: [song.filepath],
        html5: true, // Force to HTML5.  Otherwise streaming will suck
        // onplay: function() {        },
        onload: function() {

        },
        onend: function() {
          callMeOnStreamEnd();
        },
        onpause: function() {
        },
        onstop: function() {
        },
        onplay: function(){
        }
      });

      if(play == true){
        howlPlayerPlay();
      }
    }

    player.songObject = song;


  }



  function callMeOnStreamEnd(){
    mstreamModule.playerStats.playing= false;

    // Go to next song
    goToNextSong();
  }





// NOTE: Seektime is in seconds
mstreamModule.seek = function(seekTime){
  var lPlayer = getCurrentPlayer();
  if(lPlayer.playerType === 'aurora' ){
    // Do nothing, auroradoesn't support seeking right now
    return false;
  }else if(lPlayer.playerType === 'howler'){
    // Check that the seek number is less than the duration
    if(seekTime < 0 || seekTime > lPlayer.playerObject._duration){
      return false;
    }

    lPlayer.playerObject.seek(seektime)
  }

}

mstreamModule.seekByPercentage = function(percentage){
  if(percentage < 0 || percentage > 99){
    return false;
  }
  var lPlayer = getCurrentPlayer();

  if(lPlayer.playerType === 'aurora' ){
    // Do nothing, auroradoesn't support seeking
    return false;
  }else if(lPlayer.playerType === 'howler'){
    var seektime = (percentage * lPlayer.playerObject._duration)/ 100;
    lPlayer.playerObject.seek(seektime)
  }

}



  var timers = {};

  function startTime(interval = 100) {
    if (timers.sliderUpdateInterval) { clearInterval(timers.sliderUpdateInterval); }


    timers.sliderUpdateInterval = setInterval( function(){
      var lPlayer = getCurrentPlayer();

      if(lPlayer.playerType === 'aurora' ){
        mstreamModule.playerStats.duration = lPlayer.playerObject.duration / 1000;
        mstreamModule.playerStats.currentTime = lPlayer.playerObject.currentTime / 1000;
      }else if(lPlayer.playerType === 'howler'){
        mstreamModule.playerStats.currentTime =  lPlayer.playerObject.seek();
        mstreamModule.playerStats.duration = lPlayer.playerObject._duration;

      }else{
        // NO PLAYER, set default values
        mstreamModule.playerStats.currentTime = 0;
        mstreamModule.playerStats.duration = 0;
      }

    }, interval);
  }
  startTime(100);

  function clearTimer(){
    clearInterval(timers.sliderUpdateInterval);
  }


  // Timer for caching.  Helps prevent excess cahing due to button mashing
  var cacheTimer;
  function setCachedSong(position){

    console.log(' ATTEMPTING TO CACHE');
    if(!mstreamModule.playlist[mstreamModule.positionCache.val + 1]){
      console.log(' FAILED TO CACHE');
      return false;
    }

    var oPlayer = getOtherPlayer();
    setMedia(mstreamModule.playlist[position], oPlayer, false);
    console.log(' IT CACHED!!!!!!');
    console.log(mstreamModule.playlist[position]);

    return true;
  }


  // Return an object that is assigned to Module
  return mstreamModule;
}());
