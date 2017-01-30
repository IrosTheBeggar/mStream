var MSTREAMAPI = (function () {
  let mstreamModule = {};

  mstreamModule.listOfServers = [];

  mstreamModule.currentServer = {
    host:"",
    username:"",
    password:"", // TODO: Don't include this?
    token: false,
  }





  var dataList = [];

  // dataItem = {
    // type: '',
    // data:'',
    //
  //}





  var fileExplorerArray = {
    // This goes by the following pattern
    // path-segemnt: scroll pos

    // music: 70
    // folder: 20
    // ACDC: 0
    // Greatest Hits: 0
  };

  function getDirectoryContents(filepath){
    // Construct the directory string
    var directoryString = "";
    for (var i = 0; i < fileExplorerArray.length; i++) {
        directoryString += fileExplorerArray[i] + "/";
    }

    // If the scraper option is checked, then tell dirparer to use getID3
    $.post('dirparser', {dir: directoryString,  filetypes: filetypes}, function(response) {
      clearDatalist();

      var parsedResponse = $.parseJSON(dir);
      var path = parsedResponse.path;

      $.each(parsedResponse.contents, function() {

        dataList.push(
          {
            type: this.type,
            path: path + this.name,
            artist: false, // TODO:
            title: false // TODO:
          }
        );

      });
    });
  }





  // TODO Move this to a secondary module that's initiated when it's assured the MSTREAM module is looded
  mstreamModule.savePlaylist = function(saveThis){
    // TODO: Verify all data in saveThis

    if(saveThis.length == 0){
      return;
    }

    // Get playlist from MSTREAM
    // var playlist = MSTREAM.whatever

    // Get user entered title
    // var title = '';



    // Check for special characters
    if(/^[a-zA-Z0-9-_ ]*$/.test(title) == false) {
      // TODO: Warn User
      return false;
    }

    // loop through array and add each file to the playlist
    // $.each( playlistArray, function() {
    //     // TODO:
    // });



    $.ajax({
      type: "POST",
      url: "saveplaylist",
      data: {
        title:title,
        stuff:saveThis // TODO: Change this on server end
      },
    })
    .done(function( msg ) {

      if(msg == 1){
        // ???
      }
      if(msg == 0){
        // .. ???
      }

    });

    // TODO: error handeling
  }




  mstreamModule.getAllPlaylists = function(){
    var request = $.ajax({
      url: "getallplaylists",
      type: "GET"
    });

    request.done(function( msg ) {
      clearDatalist();
      var parsedResponse = $.parseJSON(msg);

      //parse through the json array and make an array of corresponding divs
      var playlists = [];
      $.each(parsedResponse, function() {
        dataList.push(
          {
            type: 'playlist',
            name: this.name
          }
        );
      });
    });

    request.fail(function( jqXHR, textStatus ) {
      // TODO:
    });
  }


  // TODO: Can thie be cahnged to a reset of the variable
  function clearDatalist(){
    while(dataList.length > 0){
      dataList.pop();
    }
  }





  mstreamModule.deletePlaylist = function(playlistNameString){
    // Send to server
  	var request = $.ajax({
  		url: "deleteplaylist",
  		type: "GET",
  		data: {playlistname: playlistNameString}
  	});

  	request.done(function( msg ) {
      // TODO: Update datalist
  	});

  	request.fail(function( jqXHR, textStatus ) {
  		// TODO:
  	});
  }






  mstreamModule.getPlaylistContents = function(playlistNameString){

    // Make an AJAX call to get the contents of the playlist
    $.ajax({
      type: "GET",
      url: "loadplaylist",
      data: {playlistname: playlistNameString},
      dataType: 'json',
    })
    .done(function( msg ) {
      // Add the playlist name to the modal

      // Clear the playlist

      // Append the playlist items to the playlist
      $.each( msg, function(i ,item) {

      });
    });
  }


















  mstreamModule.getSharedPlaylist = function(){
    // Get the URL parameters
    console.log(window.location.pathname);


    // Call the api with the the short token

    // Add songs to MSTREAM
  }



  // Return an object that is assigned to Module
  return mstreamModule;
}());
