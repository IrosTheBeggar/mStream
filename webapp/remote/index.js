const MSTREAMAPI = (() => {
  const mstreamModule = {};

  // TODO: Server Configs
  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    password: "", // TODO: Don't include this?
    token: "",
    vPath: ""
  }

  mstreamModule.currentProperties = {
    currentList: false
    // Can be anything in the title array
  }
  var currentListTypes = [
    'filebrowser',
    'albums',
    'artists',
    'search',
    'playlists'
  ];

  mstreamModule.dataList = [];


  function clearAndSetDataList(type) {
    if (!(type in currentListTypes) || type !== false) {
      // TODO: Throw Error
    }

    mstreamModule.currentProperties.currentList = type;

    while (mstreamModule.dataList.length > 0) {
      mstreamModule.dataList.pop();
    }
  }

  // TODO: TURN THIS INTO MAP
  mstreamModule.fileExplorerArray = [
    { name: '/', position: 0 }
  ];

  function getDirectoryContents() {
    // Construct the directory string
    var directoryString = "";
    for (var i = 0; i < mstreamModule.fileExplorerArray.length; i++) {
      // Ignore root directory
      if (mstreamModule.fileExplorerArray[i].name !== '/') {
        directoryString += mstreamModule.fileExplorerArray[i].name + "/";
      }
    }


    // Send out AJAX request to start building the DB
    var request = $.ajax({
      url: "/api/v1/file-explorer",
      type: "POST",
      contentType: "application/json",
      dataType: "json",
      data: JSON.stringify({
        directory: directoryString
      })
    });

    request.done(function (response) {
      clearAndSetDataList('filebrowser');

      var parsedResponse = response;
      var path = parsedResponse.path;

      $.each(parsedResponse.files, function () {
        mstreamModule.dataList.push(
          {
            type: "file",
            path: path + this.name,
            name: this.name,
            artist: false, // TODO:
            title: false // TODO:
          }
        );
      });

      $.each(parsedResponse.directories, function () {
        mstreamModule.dataList.push(
          {
            type: 'directory',
            path: path + this.name,
            name: this.name,
            artist: false, // TODO:
            title: false // TODO:
          }
        );
      });
    });

    // TODO: Print out the error instead of assuming
    request.fail(function (jqXHR, textStatus) {

    });
  }


  mstreamModule.getCurrentDirectoryContents = function () {
    getDirectoryContents();
  }

  mstreamModule.goToNextDirectory = function (folder, currentScrollPosition = 0) {
    if (currentScrollPosition != 0) {
      // TODO: Save Scroll Position
    }

    mstreamModule.fileExplorerArray.push({ name: folder, position: 0 });
    getDirectoryContents();

  }

  mstreamModule.goBackDirectory = function () {
    // Make sure it's not the root directory
    // TODO: TEST THAT THIS ALL WORKS
    if (mstreamModule.dataList[mstreamModule.dataList.length - 1].name === '/') {
      return false;
    }

    mstreamModule.fileExplorerArray.pop();
    getDirectoryContents();

    // TODO: Return Current Scroll Position
  }

  // Return an object that is assigned to Module
  return mstreamModule;
})();
