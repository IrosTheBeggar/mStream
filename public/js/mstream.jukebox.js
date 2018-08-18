var JUKEBOX = (function () {
  let mstreamModule = {};

  mstreamModule.connection = false;

  // jukebox global variable
  mstreamModule.stats = {
    // connection: false,
    live: false,
    guestCode: false,
    adminCode: false,
    error: false,
    accessAddress: false
  };

  mstreamModule.createWebsocket = function(accessKey, callback){
    if(mstreamModule.stats.live ===true ){
      return false;
    }
    mstreamModule.stats.live = true;
    // if user is running mozilla then use it's built-in WebSocket
    window.WebSocket = window.WebSocket || window.MozWebSocket;

    // if browser doesn't support WebSocket, just show some notification and exit
    if (!window.WebSocket) {
      iziToast.error({
        title: 'Jukebox Not Started',
        message: 'WebSockets Are Not Supported!',
        position: 'topCenter',
        timeout: 3500
      });
      return;
    }

    // TODO: Check if websocket has already been created

    // open connection
    var l = window.location;
    var wsLink = ((l.protocol === "https:") ? "wss://" : "ws://") + l.host + l.pathname;
    mstreamModule.connection = new WebSocket(wsLink + 'jukebox/open-connection?token=' + accessKey);



    mstreamModule.connection.onopen = function () {
      callback();
    };

    mstreamModule.connection.onerror = function (error) {
      // TODO: Proper error handling
      console.log('CONNECTION ERROR!!!!!!!!!!!!');
    };

    // most important part - incoming messages
    mstreamModule.connection.onmessage = function (message) {
      // try to parse JSON message. Because we know that the server always returns
      // JSON this should work without any problem but we should make sure that
      // the message is not chunked or otherwise damaged.
      try {
        var json = JSON.parse(message.data);
      } catch (e) {
        return;
      }

      // Handle Code
      if(json.code){
        mstreamModule.stats.adminCode = json.code;
      }
      if(json.guestCode){
        mstreamModule.stats.guestCode = json.guestCode;
      }


      if(!json.command){
        return;
      }

      if(json.command === 'next'){
        MSTREAMPLAYER.nextSong();
        return;
      }
      if( json.command === 'playPause'){
        MSTREAMPLAYER.playPause();
      }
      if( json.command === 'previous'){
        MSTREAMPLAYER.previousSong();
        return;
      }
      if( json.command === 'addSong' && json.file){
        MSTREAMPLAYER.addSongWizard(json.file, {}, true);
      }
    };
  }

  return mstreamModule;
}());
