var MSTREAM = (function () {
  let mstreamModule = {};




  // Playlist variables
  mstreamModule.positionCache = {val:-1};
  var currentSong;
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
    // TODO: Check for filepath
    mstreamModule.playlist.push(song);

    if(mstreamModule.playlist.length === 1){
      mstreamModule.positionCache.val = 0;
      return goToSong(mstreamModule.positionCache.val);
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
    return goToNextSong(true);
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

  mstreamModule.removeSongAtPosition = function(position, sanityCheckFilepath = false){
    console.log(position);
    // Check that position is filled
    if (position > mstreamModule.playlist.length || position < 0) {
      return false;
    }
    // If sanityCheckFilepath, check that filepaths are the same
    if(sanityCheckFilepath && sanityCheckFilepath != mstreamModule.playlist[position].filepath){
      console.log('FAILED 2');
      return false;
    }

    // Remove song
    mstreamModule.playlist.splice(position, 1);

    console.log(mstreamModule.playlist.length);
    console.log(mstreamModule.playlist.length);
    console.log(mstreamModule.playlist.length);
    console.log(mstreamModule.playlist.length);
    console.log(mstreamModule.playlist.length);
    console.log(position);
    console.log(position);
    console.log(position);
    console.log(position);
    console.log(position);

    // Handle case where user removes current song and it's the last song in the playlist
    if(position === mstreamModule.positionCache.val && position === mstreamModule.playlist.length ){
      // TODO:
      clearEnd();
      MSTREAM.positionCache.val = -1;
    }else if(position === mstreamModule.positionCache.val){ // User removes currently playing song
      // Go to next song
      clearEnd();
      setMedia(mstreamModule.playlist[mstreamModule.positionCache.val].filepath, true);
    }else if( position < mstreamModule.positionCache.val){
      // Lower positioncache by 1 if necessary
      mstreamModule.positionCache.val--;
    }
  }
  mstreamModule.moveSong = function(){

  }
  mstreamModule.getCurrentSong = function(){
    return currentSong;
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

  function goToNextSong(clearEndToggle = false){

    // Check if the next song exists
    if(!mstreamModule.playlist[mstreamModule.positionCache.val + 1]){
      // If loop is set and no other song, go back to first song
      if(shouldLoop === true && mstreamModule.playlist.length > 0){
        mstreamModule.positionCache.val = 0;
        if(clearEndToggle){
          clearEnd();
        }
        return goToSong(mstreamModule.positionCache.val);
      }

      return false;
    }

    // TODO: If random is set, go to random song

    // Load up next song
    if(clearEndToggle){
      clearEnd();
    }
    mstreamModule.positionCache.val++;
    return goToSong(mstreamModule.positionCache.val);
  }

  function goToSong(position){
    if(!mstreamModule.playlist[position]){
      return false;
    }
    setMedia(mstreamModule.playlist[position].filepath, true);
    currentSong = mstreamModule.playlist[position];
    return currentSong;
  }


  mstreamModule.resetPositionCache = function(){
    var len;
    for(var i=0, len=mstreamModule.playlist.length; i < len; i++){
      // Check if this is the current song
      if(currentSong === mstreamModule.playlist[i]){
        mstreamModule.positionCache.val = i;
        return;
      }
    }

    // TODO: What happens if we get here???

  }



  // ========================= Aurora Player ===============
  //  Shell for interacting with Aurora
  var AVplayer;
  function AVPlayerPlay(){
    if(AVplayer.playing){
      return;
    }
    AVplayer.play();
  }
  function AVPlayerPause(){
    AVplayer.pause();
  }
  function AVPlayerPlayPause(){
    // TODO: Check that media is loaded
    if(AVplayer.playing){
      AVplayer.pause();
    }else{
      AVplayer.play();
    }
  }
  // ========================================================





  // ========================= Howler Player ===============
  var howlPlayer;
  function howlPlayerPlay(){
    howlPlayer.play();
  }
  function howlPlayerPause(){
    howlPlayer.pause();
  }
  function howlPlayerPlayPause(){
    // TODO: Check that media is loaded
    if(howlPlayer.playing()){
      howlPlayer.pause();
    }else{
      howlPlayer.play();
    }
  }
  // ========================================================



  // ========================= Youtube Player ===============
  var YTPlayer;
  // TODO:
  // ========================================================


  function clearEnd(){
    if(playerType === 'aurora' ){
      AVplayer.on("end", function() {
        return
      }, false);
    }else if(playerType === 'howler'){
      console.log()
      howlPlayer.off('end');
    }
  }



  // Player
    // Event: On Song end
    // Set Media
    // Play, pause, skip, etc
  mstreamModule.playPause = function(){
    if(playerType === 'aurora' ){
      return AVplayer.playing ? AVPlayerPause() : AVPlayerPlay();
    }else if(playerType === 'howler'){
      console.log(howlPlayer.playing());
      return howlPlayer.playing() ? howlPlayer.pause() : howlPlayer.play();
    }
  }
  mstreamModule.skip = function(){

  }
  mstreamModule.stop = function(){

  }

  mstreamModule.playerStats = {
    duration:0,
    currentTime:0,
    playing: false
  }
  // mstreamModule.duration;
  // mstreamModule.currentTime = function(){
  //
  // }
  // mstreamModule.playStatus = {};

  var playerType = false;
  function setMedia(filepath, play){
    // Stop the current song
    if(playerType === 'aurora' ){
      AVplayer.stop();
    }else if(playerType === 'howler'){
      howlPlayer.unload();
    }

    if(filepath.indexOf('.flac') !== -1  && Howler.codecs('flac') === false ){
      // Set via aurora
      playerType = 'aurora';

      console.log(filepath);

      AVplayer = AV.Player.fromURL(filepath);
      AVplayer.on("end", function() {
        callMeOnStreamEnd();
      }, false);
      // Handle error event
      AVplayer.on("error", function(e) {

      }, false);
      AVplayer.on("metadata", function() {
        mstreamModule.playerStats.duration = AVplayer.duration / 1000;
        mstreamModule.playerStats.currentTime = AVplayer.currentTime / 1000;
        mstreamModule.playerStats.playing = AVplayer.playing; // TODO: This doesn't work
      }, false);

      AVplayer.preload();

      // TODO: Move this to metadata ???
      if(play == true){
        AVPlayerPlay();
      }


      return;
    }else{
      // TODO: Set via howler
      playerType = 'howler';


      howlPlayer = new Howl({
        src: [filepath],
        html5: true, // Force to HTML5.  Otherwise streaming will suck
        // onplay: function() {        },
        onload: function() {
          console.log(howlPlayer.duration());
          console.log(howlPlayer._duration);
          console.log(howlPlayer.seek() || 0);
          console.log(howlPlayer);


          mstreamModule.playerStats.duration = howlPlayer._duration;
          mstreamModule.playerStats.currentTime = howlPlayer.seek();


          // TODO: Fire and Event

          console.log(howlPlayer);

        },
        onend: function() {
          callMeOnStreamEnd();
        },
        onpause: function() {
          mstreamModule.playerStats.playing = false;
        },
        onstop: function() {
          mstreamModule.playerStats.playing = false;
        },
        onplay: function(){
          mstreamModule.playerStats.playing = true;
        }
      });

      if(play == true){
        howlPlayerPlay();
      }
    }

  }

  // TODO: Testing Function
  mstreamModule.putSong = function(newValue){
    setMedia(newValue, true);
  }


  function callMeOnStreamEnd(){
    // TODO: Fire off external event
    mstreamModule.playerStats.playing= false;

    // Go to next song
    goToNextSong(false);
  }





// NOTE: Seektime is in seconds
mstreamModule.seek = function(seekTime){
  console.log('SEEK');

  if(playerType === 'aurora' ){
    // Do nothing, auroradoesn't support seeking right now
    return false;
  }else if(playerType === 'howler'){
    // Check that the seek number is less than the duration
    if(seekTime < 0 || seekTime > howlPlayer._duration){
      return false;
    }

    howlPlayer.seek(seektime)
  }

}

mstreamModule.seekByPercentage = function(percentage){
  if(percentage < 0 || percentage > 100){
    return false;
  }
  console.log('SEEK');

  if(playerType === 'aurora' ){
    // Do nothing, auroradoesn't support seeking right now
    return false;
  }else if(playerType === 'howler'){
    // TODO: Check that the seek number is less than the duration
    var seektime = (percentage * howlPlayer._duration)/ 100;
    howlPlayer.seek(seektime)
  }

}



  var timers;

  function startTime(interval = 100) {
    if (timers.sliderUpdateInterval) { clearInterval(timers.sliderUpdateInterval); }

    timers.sliderUpdateInterval = setInterval( function(){

      if(playerType === 'aurora' ){
        mstreamModule.playerStats.currentTime = AVplayer.currentTime / 1000;
        // mstreamModule.playerStats.timeLeft = (AVplayer.duration / 1000) - mstreamModule.playerStats.currentTime;
      }else if(playerType === 'howler'){
        mstreamModule.playerStats.currentTime = howlPlayer.seek();
        // mstreamModule.playerStats.timeLeft =  howlPlayer._duration - howlPlayer.seek();
      }else{
        // TODO: NO PLAYER, set default values
        mstreamModule.playerStats.currentTime = 0;
        mstreamModule.playerStats.duration = 0;
      }

    }, interval);
  }
  startTime(100);

  function clearTimer(){
    clearInterval(timers.sliderUpdateInterval);
  }






  // Return an object that is assigned to Module
  return mstreamModule;
}());
