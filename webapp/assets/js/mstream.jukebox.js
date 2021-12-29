var JUKEBOX = (function () {
  let mstreamModule = {};

  mstreamModule.connection = false;

  // jukebox global variable
  mstreamModule.stats = {
    // connection: false,
    live: false,
    adminCode: false,
    error: false,
    accessAddress: false
  };

  mstreamModule.createWebsocket = function(accessKey, code, callback){
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
    let wsLink = '';
    if (MSTREAMAPI.currentServer.host) {
      wsLink = MSTREAMAPI.currentServer.host;
      wsLink = wsLink.replace('https://', 'wss://');
      wsLink = wsLink.replace('http://', 'ws://');
      wsLink += '?';
    }else {
      wsLink = ((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + '?';
    }

    if (accessKey) {
      wsLink = wsLink + 'token=' + accessKey;
      if (code) {
        wsLink = wsLink + '&';
      }
    } 
    if (code) {
      wsLink = wsLink + 'code=' + code;
    }
    mstreamModule.connection = new WebSocket(wsLink);

    mstreamModule.connection.onclose = function (event) {
      iziToast.warning({
        title: 'Jukebox Connection Closed',
        position: 'topCenter',
        timeout: 3500
      });
      mstreamModule.stats.live = false;
      mstreamModule.stats.adminCode = false;
      mstreamModule.stats.error = false;
      mstreamModule.stats.accessAddress = false;

      mstreamModule.connection = false;
    };

    mstreamModule.connection.onerror = function (error) {
      iziToast.error({
        title: 'Jukebox Connection Error',
        position: 'topCenter',
        timeout: 3500
      });
      console.log('Jukebox Connection Error!')
      console.log(error);
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
        callback();
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
        VUEPLAYERCORE.addSongWizard(json.file, {}, true);
      }
    };
  }

  mstreamModule.autoConnect = false;
  mstreamModule.setAutoConnect = function(code) {
    if (mstreamModule.autoConnect) {
      return;
    }

    mstreamModule.autoConnect = setInterval(function() {
      if (mstreamModule.connection) {
        return;
      }

      mstreamModule.createWebsocket(MSTREAMAPI.currentServer.token, code, function() {
        iziToast.success({
          title: 'Jukebox Connected',
          position: 'topCenter',
          timeout: 3500
        });
      });
    }, 5000);
  }

  return mstreamModule;
}());
