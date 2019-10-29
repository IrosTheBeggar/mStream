var entityMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
};

function escapeHtml (string) {
  return String(string).replace(/[&<>"'`=\/]/g, function (s) {
    return entityMap[s];
  });
}

$(document).ready(function () {
  // Responsive active content
  $(document).on('click', '.activate-panel-1', function(event) {
    $('.activate-panel-1').addClass('active');
    $('.activate-panel-2').removeClass('active');

    $('#panel1').addClass('active');
    $('#panel2').removeClass('active');
  });

  $(document).on('click', '.activate-panel-2', function(event) {
    $('.activate-panel-2').addClass('active');
    $('.activate-panel-1').removeClass('active');

    $('#panel2').addClass('active');
    $('#panel1').removeClass('active');
  });

  $(document).on('click', '.hamburger-button', function(event) {
    $('.responsive-left-nav').toggleClass('hide-on-small');
  });

  // Modals
  $('#aboutModal').iziModal({
    title: 'Info',
    headerColor: '#5a5a6a',
    width: 475,
    focusInput: false,
    padding: 15
  });
  $(document).on('click', '.nav-logo', function (event) {
    event.preventDefault();
    $('#aboutModal').iziModal('open');
  });
  $('#aboutModal').iziModal('setTop', '10%');

  // Dropzone
  const myDropzone = new Dropzone(document.body, {
    previewsContainer: false,
    clickable: false,
    url: '/upload',
    maxFilesize: null
  });

  myDropzone.on("addedfile", function(file) {
    if (programState[0].state !== 'fileExplorer') {
      iziToast.error({
        title: 'Files can only be added to the file explorer',
        position: 'topCenter',
        timeout: 3500
      });
      myDropzone.removeFile(file);
    } else if (fileExplorerArray.length < 1) {
      iziToast.error({
        title: 'Cannot Upload File Here',
        position: 'topCenter',
        timeout: 3500
      });
      myDropzone.removeFile(file);
    } else {
      var directoryString = "";
      for (var i = 0; i < fileExplorerArray.length; i++) {
        directoryString += fileExplorerArray[i] + "/";
      }
      file.directory = directoryString + file.fullPath.substring(0, file.fullPath.indexOf(file.name));
    }
  });

  myDropzone.on('sending', function (file, xhr, formData) {
    xhr.setRequestHeader('data-location', file.directory)
    xhr.setRequestHeader('x-access-token', MSTREAMAPI.currentServer.token)
  });

  myDropzone.on('totaluploadprogress', function (percent, uploaded, size) {
    $('.upload-progress-inner').css('width', (percent) + '%');
    if (percent === 100) {
      $('.upload-progress-inner').css('width', '0%');
    }
  });

  myDropzone.on('queuecomplete', function (file, xhr, formData) {
    var successCount = 0;
    for (var i = 0; i < myDropzone.files.length; i++) {
      if (myDropzone.files[i].status === 'success') {
        successCount += 1;
      }
    }

    if (successCount === myDropzone.files.length) {
      iziToast.success({
        title: 'Files Uploaded',
        position: 'topCenter',
        timeout: 3500
      });
      if (programState[0].state === 'fileExplorer') {
        senddir(false, fileExplorerArray);
      }
    } else if (successCount === 0) {
      // do nothing
    } else {
      iziToast.warning({
        title: successCount + ' out of ' + myDropzone.files.length + ' were uploaded successfully',
        position: 'topCenter',
        timeout: 3500
      });

      if (programState[0].state === 'fileExplorer') {
        senddir(false, fileExplorerArray);
      }
    }

    myDropzone.removeAllFiles()
  });

  myDropzone.on('error', function (err, msg, xhr) {
    var iziStuff = {
      title: 'Upload Failed',
      position: 'topCenter',
      timeout: 3500
    };

    if (msg.error) {
      iziStuff.message = msg.error;
    }

    iziToast.error(iziStuff);
  });

  var programState = [];

  // Auto Focus
  Vue.directive('focus', {
    // When the bound element is inserted into the DOM...
    inserted: function (el) {
      // Focus the element
      el.focus()
    }
  });


  new Vue({
    el: '#login-overlay',
    data: {
      pending: false
    },
    methods: {
      submitCode: function (e) {
        // Get Code
        this.pending = true;
        var that = this;
        MSTREAMAPI.login($('#login-username').val(), $('#login-password').val(), function (response, error) {
          that.pending = false;
          if (error !== false) {
            // Alert the user
            iziToast.error({
              title: 'Login Failed',
              position: 'topCenter',
              timeout: 3500
            });
            return;
          }

          // Local Storage
          if (typeof(Storage) !== "undefined") {
            localStorage.setItem("token", response.token);
          }

          // Reset Iframe
          $('#webamp-iframe').attr('src', '/public/webamp/webamp.html?token=' + response.token);

          // Add the token the URL calls
          MSTREAMAPI.updateCurrentServer($('#login-username').val(), response.token, response.vpaths)

          loadFileExplorer();
          callOnStart();

          // Remove the overlay
          $('.login-overlay').fadeOut("slow");
        });
      }
    }
  });

  function testIt() {
    var token;
    if (typeof(Storage) !== "undefined") {
      token = localStorage.getItem("token");
    }

    if (token) {
      MSTREAMAPI.currentServer.token = token;
    }

    MSTREAMAPI.ping(function (response, error) {
      if (error !== false) {
        $('.login-overlay').fadeIn("slow");
        return;
      }
      // set vPath
      MSTREAMAPI.currentServer.vpaths = response.vpaths;

      //
      $('#webamp-iframe').attr('src', '/public/webamp/webamp.html?token=' + token);

      // Setup the file browser
      loadFileExplorer();
      callOnStart();
    });
  }

  testIt();
  var startInterval = false;

  function callOnStart() {
    MSTREAMAPI.dbStatus(function (response, error) {
      if (error) {
        $('.scan-status').html('');
        $('.scan-status-files').html('');
        clearInterval(startInterval);
        startInterval = false;
        return;
      }

      // if not scanning
      if (!response.locked || response.locked === false) {
        clearInterval(startInterval);
        startInterval = false;
        $('.scan-status').html('');
        $('.scan-status-files').html('');

        return;
      }

      // Set Interval
      if (startInterval === false) {
        startInterval = setInterval(function () {
          callOnStart();
        }, 2000);
      }

      // Update status
      $('.scan-status').html('Scan In Progress');
      $('.scan-status-files').html(response.totalFileCount + ' files in DB');
    });
  }


  ////////////////////////////// Global Variables
  // These vars track your position within the file explorer
  var fileExplorerArray = [];
  // Stores an array of searchable ojects
  var currentBrowsingList = [];

  ////////////////////////////////   Administrative stuff
  // when you click an mp3, add it to now playing
  $("#filelist").on('click', 'div.filez', function () {
    addSongWiz($(this).data("file_location"), {}, true);
  });

  // Handle panel stuff
  function resetPanel(panelName, className) {
    $('#filelist').empty();
    $('#directory_bar').show();

    $('#search_folders').val('');
    $('.directoryName').html('');

    $('#filelist').removeClass('scrollBoxHeight1');
    $('#filelist').removeClass('scrollBoxHeight2');

    $('#filelist').addClass(className);
    $('.panel_one_name').html(panelName);
  }

  function boilerplateFailure(response, error) {
    iziToast.error({
      title: 'Call Failed',
      position: 'topCenter',
      timeout: 3500
    });
  }

  /////////////////////////////////////// File Explorer
  function loadFileExplorer() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_file_explorer').addClass('selected');

    resetPanel('File Explorer', 'scrollBoxHeight1');
    programState = [{
      state: 'fileExplorer'
    }]
    $('#directory_bar').show();

    // Reset file explorer vars
    fileExplorerArray = [];

    if (MSTREAMAPI.currentServer.vpaths && MSTREAMAPI.currentServer.vpaths.length === 1) {
      fileExplorerArray.push(MSTREAMAPI.currentServer.vpaths[0]);
    }

    //send this directory to be parsed and displayed
    senddir(null, fileExplorerArray);
  }

  // Load up the file explorer
  $('.get_file_explorer').on('click', loadFileExplorer);

  // when you click on a directory, go to that directory
  $("#filelist").on('click', 'div.dirz', function () {
    //get the id of that class
    var nextDir = $(this).data("directory");
    var newArray = [];
    for (var i = 0; i < fileExplorerArray.length; i++) {
      newArray.push(fileExplorerArray[i]);
    }
    newArray.push(nextDir);

    senddir(false, newArray);
  });

  // when you click the back directory
  $(".backButton").on('click', function () {
    // Handle file Explorer
    if (programState[0].state === 'fileExplorer') {
      if (fileExplorerArray.length != 0) {
        // remove the last item in the array
        var newArray = [];
        for (var i = 0; i < fileExplorerArray.length - 1; i++) {
          newArray.push(fileExplorerArray[i]);
        }

        senddir(true, newArray);
      }
    } else {
      // Handle all other cases
      if (programState.length < 2) {
        return;
      }

      programState.pop();
      var backState = programState[programState.length - 1];

      if (backState.state === 'allPlaylists') {
        getAllPlaylists();
      } else if (backState.state === 'allAlbums') {
        getAllAlbums();
      } else if (backState.state === 'allArtists') {
        getAllArtists();
      } else if (backState.state === 'artist') {
        getArtistsAlbums(backState.name);
      }
    }
  });

  // send a new directory to be parsed.
  function senddir(scrollPosition, newArray) {
    // Construct the directory string
    var directoryString = "";
    for (var i = 0; i < newArray.length; i++) {
      directoryString += newArray[i] + "/";
    }

    $('.directoryName').html('/' + directoryString);
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');

    MSTREAMAPI.dirparser(directoryString, false, function (response, error) {
      if (error !== false) {
        boilerplateFailure(response, error);
        return;
      }

      fileExplorerArray = newArray;
      // Set any directory views
      // hand this data off to be printed on the page
      printdir(response);
    });
  }


  // function that will recieve JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
  function printdir(response) {
    currentBrowsingList = response.contents;

    // clear the list
    $('#search_folders').val('');

    //parse through the json array and make an array of corresponding divs
    var filelist = [];
    $.each(currentBrowsingList, function () {
      if (this.type == 'directory') {
        filelist.push('<div class="clear relative"><div data-directory="' + this.name + '" class="dirz"><img class="folder-image" src="/public/img/folder.svg"><span class="item-text">' + this.name + '</span></div><div class="song-button-box"><span title="Add All To Queue" class="recursiveAddDir" data-directory="' + this.name + '"><svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg></span><span data-directory="' + this.name + '" title="Download Directory" class="downloadDir"><svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg></span></div></div>');
      } else {
        if (this.artist != null || this.title != null) {
          filelist.push('<div data-file_location="' + response.path + this.name + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="item-text">' + this.artist + ' - ' + this.title + '</span></div>');
        } else {
          filelist.push('<div data-file_location="' + response.path + this.name + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="item-text">' + this.name + '</span></div>');
        }
      }
    });

    // Post the html to the filelist div
    $('#filelist').html(filelist);
  }

  // when you click 'add directory', add entire directory to the playlist
  $("#addall").on('click', function () {
    //make an array of all the mp3 files in the curent directory
    var elems = document.getElementsByClassName('filez');
    var arr = jQuery.makeArray(elems);

    //loop through array and add each file to the playlist
    $.each(arr, function () {
      addSongWiz($(this).data("file_location"), {}, true);
    });
  });


  // Search Files
  $('#search_folders').on('change keyup', function () {
    var searchVal = $(this).val();

    var path = "";		// Construct the directory string
    for (var i = 0; i < fileExplorerArray.length; i++) {
      path += fileExplorerArray[i] + "/";
    }

    var filelist = [];
    // This causes an error in the playlist display
    $.each(currentBrowsingList, function () {
      var lowerCase = this.name.toLowerCase();

      if (lowerCase.indexOf(searchVal.toLowerCase()) !== -1) {
        if (this.type === 'directory') {
          filelist.push('<div class="clear relative"><div data-directory="' + this.name + '" class="dirz"><img class="folder-image" src="/public/img/folder.svg"><span class="item-text">' + this.name + '</span></div><div data-directory="' + this.name + '" class="song-button-box"><span title="Add All To Queue" class="recursiveAddDir" data-directory="' + this.name + '"><svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg></span><span class="downloadDir"><svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg></span></div></div>');
        } else if (this.type === 'playlist') {
          filelist.push('<div data-playlistname="' + encodeURIComponent(this.name) + '" class="playlist_row_container"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="playlistz force-width">' + escapeHtml(this.name) + '</span><div class="song-button-box"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="deletePlaylist">Delete</span></div></div>');
        } else if (this.type === 'album') {
          if (this.album_art_file) {
            filelist.push('<div data-album="' + this.name + '" class="albumz"><img class="album-art-box"  data-original="/album-art/' + this.album_art_file + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + this.name + '</span></div>');
          } else {
            filelist.push('<div data-album="' + this.name + '" class="albumz"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + this.name + '</span></div>');
          }
        } else if (this.type === 'artist') {
          filelist.push('<div data-artist="' + this.name + '" class="artistz">' + this.name + ' </div>');
        } else {
          if (programState[programState.length - 1].state === 'playlist') {
            if (!this.metadata || !this.metadata.title) {
              filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + this.filepath + '</span></div>');
            } else if (this.metadata['album-art']) {
              filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="album-art-box"  data-original="/album-art/' + this.metadata['album-art'] + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + this.metadata.artist + ' - ' + this.metadata.title + '</span></div>');
            } else {
              filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + this.metadata.artist + ' - ' + this.metadata.title + '</span></div>');
            }
          } else {
            if (this.artist != null || this.title != null) {
              filelist.push('<div data-file_location="' + path + this.name + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="title">' + this.artist + ' - ' + this.title + '</span></div>');
            } else {
              filelist.push('<div data-file_location="' + path + this.name + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="title">' + this.name + '</span></div>');
            }
          }
        }
      }
    });

    // Post the html to the filelist div
    $('#filelist').html(filelist);
    ll.update();
  });

  $('#search-explorer').on('click', function () {
    // Hide Filepath
    $('#search_folders').toggleClass('hide');
    // Show Search Input
    $('.directoryName').toggleClass('hide');

    if (!$('#search_folders').hasClass('hide')) {
      $("#search_folders").focus();
    } else {
      $('#search_folders').val('');
      $("#search_folders").change();
    }
  });

  $("#filelist").on('click', '.downloadDir', function () {
    var directoryString = "/";
    for (var i = 0; i < fileExplorerArray.length; i++) {
      directoryString += fileExplorerArray[i] + "/";
    }

    directoryString += $(this).data("directory");

    // Use key if necessary
    $("#downform").attr("action", "/download-directory?token=" + MSTREAMAPI.currentServer.token);

    $('<input>').attr({
      type: 'hidden',
      name: 'directory',
      value: directoryString,
    }).appendTo('#downform');

    //submit form
    $('#downform').submit();
    // clear the form
    $('#downform').empty();
  });

  // Get all playlists
  $('.get_all_playlists').on('click', function () {
    getAllPlaylists();
  });

  function getAllPlaylists() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_all_playlists').addClass('selected');
    resetPanel('Playlists', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState = [{
      state: 'allPlaylists'
    }]

    MSTREAMAPI.getAllPlaylists(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      // loop through the json array and make an array of corresponding divs
      var playlists = [];
      $.each(response, function () {
        playlists.push('<div data-playlistname="' + encodeURIComponent(this.name) + '" class="playlist_row_container"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="playlistz force-width">' + escapeHtml(this.name) + '</span><div class="song-button-box"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="deletePlaylist">Delete</span></div></div>');
        this.type = 'playlist';
        currentBrowsingList.push(this);
      });
      // Add playlists to the left panel
      $('#filelist').html(playlists);
    });
  }

  $("#filelist").on('click', '.recursiveAddDir', function () {
    var directoryString = "/";
    for (var i = 0; i < fileExplorerArray.length; i++) {
      directoryString += fileExplorerArray[i] + "/";
    }

    directoryString += $(this).data("directory");
    MSTREAMAPI.recursiveScan(directoryString, false, function(res, err){
      for (var i = 0; i < res.length; i++) {
        MSTREAMAPI.addSongWizard(res[i], {}, true);
      }
    });
  });

  // delete playlist
  $("#filelist").on('click', '.deletePlaylist', function () {
    var playlistname = decodeURIComponent($(this).data('playlistname'));

    iziToast.question({
      timeout: 10000,
      close: false,
      overlayClose: true,
      overlay: true,
      displayMode: 'once',
      id: 'question',
      zindex: 99999,
      title: "Delete '" + playlistname + "'?",
      position: 'center',
      buttons: [
          ['<button><b>Delete</b></button>', function (instance, toast) {
            MSTREAMAPI.deletePlaylist(playlistname, function (response, error) {
              if (error !== false) {
                return boilerplateFailure(response, error);
              }
              $('div[data-playlistname="'+encodeURIComponent(playlistname)+'"]').remove();
            });
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }, true],
          ['<button>Go Back</button>', function (instance, toast) {
            instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          }],
      ]
    });
  });

  $("#filelist").on('click', '.removePlaylistSong', function () {
    var lokiId = $(this).data('lokiid');
    MSTREAMAPI.removePlaylistSong(lokiId, function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      $('div[data-lokiid="' + lokiId + '"]').remove();
    });
  });

  // load up a playlist
  $("#filelist").on('click', '.playlistz', function () {
    var playlistname = decodeURIComponent($(this).data('playlistname'));
    var name = $(this).html();
    $('.directoryName').html('Playlist: ' + name);
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    $('#search_folders').val('');
    currentBrowsingList = [];

    programState.push({
      state: 'playlist',
      name: playlistname
    })

    MSTREAMAPI.loadPlaylist(playlistname, function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      // Add the playlist name to the modal
      $('#playlist_name').val(name);

      //parse through the json array and make an array of corresponding divs
      var files = [];
      $.each(response, function (index, value) {
        if (!value.metadata || !value.metadata.title) {
          currentBrowsingList.push({ type: 'file', name: value.filepath, metadata: value.metadata });
          files.push('<div data-lokiid="'+value.lokiId+'" class="clear relative"><div data-lokiid="'+value.lokiId+'" data-file_location="' + value.filepath + '" class="filez left"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.filepath + '</span></div><div class="song-button-box"><span data-lokiid="'+value.lokiId+'" class="removePlaylistSong">remove</span></div></div>');
        } else if (value.metadata['album-art']) {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-lokiid="'+value.lokiId+'" class="clear relative"><div data-lokiid="'+value.lokiId+'" data-file_location="' + value.filepath + '" class="filez left"><img class="album-art-box"  data-original="/album-art/' + value.metadata['album-art'] + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div><div class="song-button-box"><span data-lokiid="'+value.lokiId+'" class="removePlaylistSong">remove</span></div></div>');
        } else {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-lokiid="'+value.lokiId+'" class="clear relative"><div data-lokiid="'+value.lokiId+'" data-file_location="' + value.filepath + '" class="filez left"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div><div class="song-button-box"><span data-lokiid="'+value.lokiId+'" class="removePlaylistSong">remove</span></div></div>');
        }
      });

      $('#filelist').html(files);
      // update linked list plugin
      ll.update();
    });
  });

  /////////////////////////////   Mobile Stuff
  $('.mobile-panel').on('click', function () {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.mobile-panel').addClass('selected');
    resetPanel('Mobile Apps', 'scrollBoxHeight2');
    $('#directory_bar').hide();

    $('#filelist').html("\
      <div class='mobile-links'>\
        <a target='_blank' href='https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1'><img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png'/></a>\
        <div class='mobile-placeholder'>&nbsp;</div>\
        <!-- <a href='https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1'><img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png'/></a> -->\
      </div>\
      <div class='app-text'>\
        The official mStream App is now available for Android.  Use it to sync and stream music from any mStream server.\
        <br><br>\
        An iOS version will be released soon.\
        <br><br>\
        <a target='_blank' href='/public/qr-tool.html'>Checkout the QR Code tool to help add your server to the app</a>\
      </div>\
    ");
  });

  /////////////////////////////   Database Management
  //  The Manage DB panel
  $('.db-panel').on('click', function () {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.db-panel').addClass('selected');
    resetPanel('Database', 'scrollBoxHeight2');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    $('#directory_bar').hide();
    currentBrowsingList = [];

    MSTREAMAPI.dbStatus(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      // If there is an error
      if (response.error) {
        $('#filelist').html('<p>The database returned the following error:</p><p>' + response.error + '</p>');
        return;
      }

      // if the DB is locked
      if (response.locked) {
        $('#filelist').html('<p class="scan-status">Scan In Progress</p><p class="scan-status-files">' + response.totalFileCount + ' files in DB</p>');
        return;
      }
      // If you got this far the db is made and working
      $('#filelist').html('<p>Your DB has ' + response.totalFileCount + ' files</p><input type="button" value="Build Database" id="build_database">');
    });
  });

  // Build the database
  $('body').on('click', '#build_database', function () {
    $(this).prop("disabled", true);

    MSTREAMAPI.dbScan(function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      $('#filelist').append('  <p class="scan-status">Scan In Progress</p><p class="scan-status-files"></p>');
      callOnStart();
      // Append the check db button so the user can start checking right away
      // $('#filelist').append('<input type="button" value="Check Progress" id="check_db_progress" >');
    });
  });

  // // Check DB build progress
  // $('body').on('click', '#check_db_progress', function(){
  //   MSTREAMAPI.dbStatus( function(response, error){
  //     if(error !== false){
  //       return boilerplateFailure(response, error);
  //     }
  // 		$( "#db_progress_report" ).remove();
  //
  // 		// if file_count is 0, report that the the build script is not done counting files
  // 		if(response.file_count == 0){
  // 			$('#filelist').append('<p id="db_progress_report">The create database script is still counting the files in the music collection.  This operation can take some time.  Try again in a bit</p>');
  // 			return;
  // 		}
  //
  // 		// Append new <p> tag with id of "db_progress_report"
  // 		$('#filelist').append('<p id="db_progress_report">Progress: '+ response.files_in_db +'/'+ response.file_count +'</p>');
  //   });
  // });


  ////////////////////////////////////  Sort by Albums
  //Load up album explorer
  $('.get_all_albums').on('click', function () {
    getAllAlbums();
  });

  function getAllAlbums() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_all_albums').addClass('selected');
    resetPanel('Albums', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState = [{
      state: 'allAlbums'
    }]

    MSTREAMAPI.albums(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      var albums = [];
      $.each(response.albums, function (index, value) {
        if (value.album_art_file) {
          currentBrowsingList.push({ type: 'album', name: value.name, 'album_art_file': value.album_art_file });

          albums.push('<div data-album="' + value.name + '" class="albumz"><img class="album-art-box"  data-original="/album-art/' + value.album_art_file + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + value.name + '</span></div>');
        } else {
          currentBrowsingList.push({ type: 'album', name: value.name });
          albums.push('<div data-album="' + value.name + '" class="albumz"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.name + '</span></div>');
        }
      });

      $('#filelist').html(albums);
      // update linked list plugin
      ll.update();
    });
  }

  // Load up album-songs
  $("#filelist").on('click', '.albumz', function () {
    var album = $(this).data('album');
    getAlbumSongs(album);
  });

  function getAlbumSongs(album) {
    $('#search_folders').val('');
    $('.directoryName').html('Album: ' + album);
    //clear the list
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState.push({
      state: 'album',
      name: album
    })

    MSTREAMAPI.albumSongs(album, function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      var filelist = [];
      $.each(response, function () {
        if (this.metadata.title) {
          currentBrowsingList.push({ type: 'file', name: this.metadata.title })
          filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="title">' + this.metadata.title + '</span></div>');
        }
        else {
          currentBrowsingList.push({ type: 'file', name: this.metadata.filename })
          filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="music-image" src="/public/img/music-note.svg"> <span class="title">' + this.metadata.filename + '</span></div>');
        }
      });

      $('#filelist').html(filelist);
    });
  }

  /////////////////////////////////////// Artists
  $('.get_all_artists').on('click', function () {
    getAllArtists();
  });

  function getAllArtists() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_all_artists').addClass('selected');
    resetPanel('Artists', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState = [{
      state: 'allArtists'
    }]

    MSTREAMAPI.artists(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      var artists = [];
      $.each(response.artists, function (index, value) {
        artists.push('<div data-artist="' + value + '" class="artistz">' + value + ' </div>');
        currentBrowsingList.push({ type: 'artist', name: value });
      });

      $('#filelist').html(artists);
    });
  }


  $("#filelist").on('click', '.artistz', function () {
    var artist = $(this).data('artist');
    programState.push({
      state: 'artist',
      name: artist
    })
    getArtistsAlbums(artist)
  });

  function getArtistsAlbums(artist) {
    resetPanel('Albums', 'scrollBoxHeight1');
    $('.directoryName').html('Artist: ' + artist);
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    $('#search_folders').val('');
    currentBrowsingList = [];

    MSTREAMAPI.artistAlbums(artist, function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      var albums = [];
      $.each(response.albums, function (index, value) {
        if (value.album_art_file) {
          albums.push('<div data-album="' + value.name + '" class="albumz"><img class="album-art-box"  data-original="/album-art/' + value.album_art_file + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + value.name + '</span></div>');
        } else {
          albums.push('<div data-album="' + value.name + '" class="albumz"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.name + '</span></div>');
        }
        currentBrowsingList.push({ type: 'album', name: value.name })
      });

      $('#filelist').html(albums);
      // update linked list plugin
      ll.update();
    });
  }

  $('.get_rated_songs').on('click', function () {
    getRatedSongs();
  });
  function getRatedSongs() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_rated_songs').addClass('selected');
    resetPanel('Starred', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    $('#search_folders').val('');
    currentBrowsingList = [];

    programState = [{
      state: 'allRated'
    }]

    MSTREAMAPI.getRated(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      var files = [];
      $.each(response, function (index, value) {
        var rating = (value.metadata.rating / 2);
        if (!Number.isInteger(rating)) {
          rating = rating.toFixed(1);
        }

        if (!value.metadata || !value.metadata.title) {
          currentBrowsingList.push({ type: 'file', name: value.filepath, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">[' + rating + '] ' + value.filepath + ']</span></div>');
        } else if (value.metadata['album-art']) {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box"  data-original="/album-art/' + value.metadata['album-art'] + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">[' + rating + '] ' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div>');
        } else {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">[' + rating + '] ' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div>');
        }
      });

      $('#filelist').html(files);
      // update linked list plugin
      ll.update();
    });
  }


  //////////////////////// Jukebox Mode
  function setupJukeboxPanel() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.jukebox_mode').addClass('selected');
    // Hide the directory bar
    resetPanel('Jukebox Mode', 'scrollBoxHeight2');
    currentBrowsingList = [];
    $('#directory_bar').hide();

    var newHtml;
    if (JUKEBOX.stats.live !== false && JUKEBOX.connection !== false) {
      newHtml = createJukeboxPanel();
    } else {
      newHtml = '\
        <p class="jukebox-panel">\
        <br><br>\
        <h3>Jukebox Mode allows you to control this page remotely<h3> <br><br>\
        <input value="Connect" type="button" class="jukebox_connect">\
        </p>\
        <img src="/public/img/loading.gif" class="hide jukebox-loading">';
    }

    // Add the content
    $('#filelist').html(newHtml);
  }

  // The jukebox panel
  $('.jukebox_mode').on('click', function () {
    setupJukeboxPanel();
  });

  $('body').on('click', '.remote-button', function () {
    setupJukeboxPanel();
  });

  // Setup Jukebox
  $('body').on('click', '.jukebox_connect', function () {
    $(this).prop("disabled", true);
    $(this).hide();
    $('.jukebox-loading').toggleClass('hide');

    JUKEBOX.createWebsocket(MSTREAMAPI.currentServer.token, false, function () {
      // Wait a while and display the status
      setTimeout(function () {
        setupJukeboxPanel();
      }, 1800);
    });
  });

  function createJukeboxPanel() {
    var returnHtml = '<div class="jukebox-panel autoselect">';

    if (JUKEBOX.stats.error !== false) {
      return returnHtml + 'An error occurred.  Please refresh the page and try again</p>';
    }

    if (JUKEBOX.stats.adminCode) {
      returnHtml += '<h1>Code: ' + JUKEBOX.stats.adminCode + '</h1>';
    }
    if (JUKEBOX.stats.guestCode) {
      returnHtml += '<h2>Guest Code: ' + JUKEBOX.stats.guestCode + '</h2>';
    }

    var adrs = window.location.protocol + '//' + window.location.host + '/remote';
    returnHtml += '<br><h4>Remote Jukebox Controls: <a target="_blank" href="' + adrs + '"> ' + adrs + '</a><h4>';

    return returnHtml + '</div>';
  }

   function addSongWiz(filepath, metadata, lookupMetadata) {
    // Escape filepath
    var rawFilepath = filepath;
    filepath = filepath.replace(/\%/g, "%25");
    filepath = filepath.replace(/\#/g, "%23");
    if (filepath.charAt(0) === '/') {
      filepath = filepath.substr(1);
    }

    var url = MSTREAMAPI.currentServer.host + '/media/' + filepath;
    if (MSTREAMAPI.currentServer.token) {
      url = url + '?token=' + MSTREAMAPI.currentServer.token;
    }

    var check = document.getElementById("webamp-iframe").contentWindow;
    check.webampCtrl.appendTracks([{ url: window.location.origin  + url }]);
  }

  // Setup jukebox if URL
  var uuid = null;
  var urlParams = new URLSearchParams(window.location.search);
  var queryParm = urlParams.get('code');

  myParam = uuid || queryParm || false;
  if(myParam) {
    JUKEBOX.createWebsocket(MSTREAMAPI.currentServer.token, myParam, function () {
      iziToast.success({
        title: 'Jukebox Connected',
        position: 'topCenter',
        message: 'Code: ' + myParam,
        timeout: 3500
      });
    });
    JUKEBOX.setAutoConnect(myParam);
  }
});
