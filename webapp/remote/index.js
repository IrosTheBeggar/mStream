const MSTREAMAPI = (() => {
  const mstreamModule = {};

  mstreamModule.listOfServers = [];
  mstreamModule.currentServer = {
    host: "",
    username: "",
    password: "",
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

  mstreamModule.fileExplorerArray = [
    { name: '/', position: 0 }
  ];

  async function getDirectoryContents() {
    // Construct the directory string
    var directoryString = "";
    for (var i = 0; i < mstreamModule.fileExplorerArray.length; i++) {
      // Ignore root directory
      if (mstreamModule.fileExplorerArray[i].name !== '/') {
        directoryString += mstreamModule.fileExplorerArray[i].name + "/";
      }
    }


    // Send out AJAX request to start building the DB
    const res = await axios({
      method: 'POST',
      url: `/api/v1/file-explorer`,
      headers: { 'x-access-token': remoteProperties.token },
      data: { directory: directoryString }
    });

    clearAndSetDataList('filebrowser');

    res.data.files.forEach(f => {
      mstreamModule.dataList.push({
        type: "file",
        path: res.data.path + f.name,
        name: f.name,
        artist: false,
        title: false
      });
    });

    res.data.directories.forEach(d => {
      mstreamModule.dataList.push({
        type: 'directory',
        path: res.data.path + d.name,
        name: d.name,
        artist: false,
        title: false
      });
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
    if (mstreamModule.dataList[mstreamModule.dataList.length - 1].name === '/') {
      return false;
    }

    mstreamModule.fileExplorerArray.pop();
    getDirectoryContents();
  }

  // Return an object that is assigned to Module
  return mstreamModule;
})();
