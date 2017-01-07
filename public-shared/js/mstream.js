var MSTREAM = (function () {
  let mstreamModule = {};


  // Playlist variables
  var positionCache = -1;
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
      positionCache = 0;
      return goToSong(positionCache);
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
    positionCache = -1;
    return true;
  }

  mstreamModule.nextSong = function(){
    console.log('MSTREAM CLICKED IT QQQ');
    // Stop the current song
    return goToNextSong(true);
  }
  mstreamModule.previousSong = function(){
    return goToPreviousSong();
  }
  mstreamModule.goToSongAtPosition = function(position){
    positionCache = position;
    return goToSong(positionCache);
  }
  mstreamModule.removeSongAtPosition = function(position, sanityCheckFilepath){
    // Check that position is filled
      // If sanityCheckFilepath, check that filepaths are the same

    // Remove song

    // Shift the positionCache if necessary
      // If currently playing song is removed, shift the position cache down 1
  }
  mstreamModule.moveSong = function(){

  }
  mstreamModule.getCurrentSong = function(){
    return currentSong;
  }

  function goToPreviousSong(){
    // Make sure there is a previous song
    if(positionCache === 0 || positionCache === -1){
      return false;
    }

    // TODO: If random is set, go to previous song from cache

    // Set previous song and play
    clearEnd();
    positionCache--;
    return goToSong(positionCache);
  }

  function goToNextSong(clearEndToggle = false){
    console.log(positionCache);
    console.log('XXXXXXXXXXXXXXXXXXXXXXXXX');
    // Check if the next song exists
    if(!mstreamModule.playlist[positionCache + 1]){
      // If loop is set and no other song, go back to first song
      if(shouldLoop === true && mstreamModule.playlist.length > 0){
        positionCache = 0;
        if(clearEndToggle){
          clearEnd();
        }
        return goToSong(positionCache);
      }

      return false;
    }

    // TODO: If random is set, go to random song

    // Load up next song
    if(clearEndToggle){
      clearEnd();
    }
    positionCache++;
    return goToSong(positionCache);
  }

  function goToSong(position){
    console.log('RRRRRRRRRRRRRRRRRRRRRR');

    if(!mstreamModule.playlist[position]){
      return false;
    }
    setMedia(mstreamModule.playlist[position].filepath, true);
    currentSong = mstreamModule.playlist[position];
    return currentSong;
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
    // TODO: Need to check if this is already being played

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

  }
  mstreamModule.skip = function(){

  }
  mstreamModule.stop = function(){

  }

  var playerType = false;
  function setMedia(filepath, play){
    console.log('YYYYYYYYYYYYYYYYYYY');
    console.log(positionCache);

    // Stop the current song
    if(playerType === 'aurora' ){
      AVplayer.stop();
    }else if(playerType === 'howler'){
      howlPlayer.unload();
    }

    // TODO: Need a better check
    //if(filepath.indexOf('.flac') !== -1){
    if(filepath.indexOf('.flac') !== -1){
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

        },
        onend: function() {
          callMeOnStreamEnd();
        },
        onpause: function() {

        },
        onstop: function() {

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

    // Go to next song
    goToNextSong(false);
  }







  // Return an object that is assigned to Module
  return mstreamModule;
}());
