var MSTREAMGEN = (function () {
  let mstreamModule = {};




  // TODO: Functions to change current server and save servers
  // Not needed until express port




  mstreamModule.currentProperties = {
    currentList: false
      // Can be anything in the title array
  }

  var currentListTypes = {
    'filebrowser': {displayName: 'File Browser'},
    'albums': {displayName: 'Albums'},
    'artists': {displayName: 'Artists'},
    'search': {displayName: 'Search'},
    'playlists': {displayname: 'Playlists'}
  };

  mstreamModule.dataList = [];
  // TODO: Modify prototype functions for dataList to verify all items
  // dataItem = {
    // type: '',
    // data:'',
  //}

  function clearAndSetDataList(type){
    if(!(type in currentListTypes) || type !== false){
      // TODO: Throw Error
    }

    mstreamModule.currentProperties.currentList = type;
    // Loop through and pop so Vue doesn't throw a fit
    while(mstreamModule.dataList.length > 0){
      mstreamModule.dataList.pop();
    }
  }

  mstreamModule.clearDataList = function(){
    clearAndSetDataList(false);
  }






  // TODO: TURN THIS INTO MAP
  mstreamModule.fileExplorerArray = [
    {name:'/', position:0}
  ];

  function getDirectoryContents(){
    // Construct the directory string
    var directoryString = "";
    for (var i = 0; i < mstreamModule.fileExplorerArray.length; i++) {
      // Ignore root directory
      if(mstreamModule.fileExplorerArray[i].name !== '/'){
        directoryString += mstreamModule.fileExplorerArray[i].name + "/";
      }
    }


    MSTREAMAPI.dirparser(directoryString, false, function(response, error){
      if(error !== false){
        boilerplateFailure(response, error);
      }

      clearAndSetDataList('filebrowser');
      $.each(response.contents, function() {
        mstreamModule.dataList.push(
          {
            type:  (this.type === 'directory' ? "directory" : "file"),
            metadata: {}, // TODO: Move all metadata to here
            path: response.path + this.name,
            name: this.name,
            artist: false, // TODO:
            title: false // TODO:
          }
        );

      });
    });
  }



  mstreamModule.getCurrentDirectoryContents = function(){
    getDirectoryContents();
  }

  mstreamModule.goToNextDirectory = function(folder, currentScrollPosition = 0){
    if(currentScrollPosition != 0 ){
      // TODO: Save Scroll Position
    }

    mstreamModule.fileExplorerArray.push({name:folder, position:0});
    getDirectoryContents();
  }

  mstreamModule.goBackDirectory = function(){
    // Make sure it's not the root directory
    // TODO: TEST THAT THIS ALL WORKS
    if(mstreamModule.dataList[mstreamModule.dataList.length-1].name === '/'){
      return false;
    }

    mstreamModule.fileExplorerArray.pop();
    getDirectoryContents();

    // TODO: Return Current Scroll Position
  }

  mstreamModule.getCurrentScrollPosition = function(){
    return mstreamModule.dataList[mstreamModule.dataList.length-1].position;
  }

  // TODO:
  mstreamModule.goToExactDirectory = function(directory){
    // Clear Out fileExplorerArray
      // loop and pop

    // Setup new fileExplorerArray
      // splice
      // loop

    getDirectoryContents();
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
      contentType: "application/json",
      dataType: "json",
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
      clearAndSetDataList('playlists');
      var parsedResponse = $.parseJSON(msg);

      //parse through the json array and make an array of corresponding divs
      var playlists = [];
      $.each(parsedResponse, function() {
        mstreamModule.dataList.push(
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








  mstreamModule.deletePlaylist = function(playlistNameString){

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






// TODO:
function boilerplateFailure(response, error){
  return;
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
