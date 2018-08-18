$(document).ready(function () {

  // Setup scrobbling
  MSTREAMPLAYER.scrobble = function () {
    if (MSTREAMPLAYER.playerStats.metadata.artist && MSTREAMPLAYER.playerStats.metadata.title) {
      MSTREAMAPI.scrobbleByMetadata(MSTREAMPLAYER.playerStats.metadata.artist, MSTREAMPLAYER.playerStats.metadata.album, MSTREAMPLAYER.playerStats.metadata.title, function (response, error) {

      });
    }
  }

  var programState = [];

  // Auto Focus
  Vue.directive('focus', {
    // When the bound element is inserted into the DOM...
    inserted: function (el) {
      // Focus the element
      el.focus()
    }
  });


  var loginPanel = new Vue({
    el: '#login-overlay',
    data: {
      needToLogin: false,
      error: false,
      errorMessage: 'Login Failed',
      pending: false
    },
    methods: {
      submitCode: function (e) {
        // Get Code
        this.pending = true;
        var that = this;
        MSTREAMAPI.login($('#login-username').val(), $('#login-password').val(), function (response, error) {
          if (error !== false) {
            // Alert the user
            that.pending = false;
            that.error = true;
            return;
          }

          // Eye-candy: change the error color and essage
          $('#login-alert').toggleClass('alert');
          $('#login-alert').toggleClass('success');
          that.errorMessage = "Welcome To mStream!";

          // Add the token to the cookies
          Cookies.set('token', response.token);

          // Add the token the URL calls
          MSTREAMAPI.updateCurrentServer($('#login-username').val(), response.token, response.vpaths)

          loadFileExplorer();
          callOnStart();


          // Remove the overlay
          $('.login-overlay').fadeOut("slow");
          that.pending = false;
          that.needToLogin = false;
        });
      }
    }
  });

  function testIt(token) {
    if (token) {
      MSTREAMAPI.currentServer.token = token;
    }

    MSTREAMAPI.ping(function (response, error) {
      if (error !== false) {
        loginPanel.needToLogin = true;
        $('.login-overlay').fadeIn("slow");
        return;
      }
      // set vPath
      MSTREAMAPI.currentServer.vpaths = response.vpaths;
      // Setup the file browser
      loadFileExplorer();
      callOnStart();
    });
  }

  // NOTE: There needs to be a split here
  // For the normal webap we just get the token
  // var token = Cookies.get('token');
  testIt(Cookies.get('token'));
  // For electron we need to pull it from wherever electron stores things

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
  var fileExplorerScrollPosition = [];
  // Stores an array of searchable ojects
  var currentBrowsingList = [];

  ////////////////////////////////   Administrative stuff
  // when you click an mp3, add it to the now playling playlist
  $("#filelist").on('click', 'div.filez', function () {
    MSTREAMPLAYER.addSongWizard($(this).data("file_location"), {}, true);
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

  // clear the playlist
  $("#clear").on('click', function () {
    MSTREAMPLAYER.clearPlaylist();
  });

  /////////////////////////////////////// File Explorer
  function loadFileExplorer() {
    resetPanel('File Explorer', 'scrollBoxHeight1');
    programState = [{
      state: 'fileExplorer'
    }]
    $('#directory_bar').show();

    // Reset file explorer vars
    fileExplorerArray = [];
    fileExplorerScrollPosition = [];

    if (MSTREAMAPI.currentServer.vpaths && MSTREAMAPI.currentServer.vpaths.length === 1) {
      fileExplorerArray.push(MSTREAMAPI.currentServer.vpaths[0]);
      fileExplorerScrollPosition.push(0);
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

    MSTREAMAPI.dirparser(directoryString, false, function (response, error) {
      if (error !== false) {
        boilerplateFailure(response, error);
        return;
      }

      fileExplorerArray = newArray;
      // Set any directory views
      $('.directoryName').html('/' + directoryString);
      // hand this data off to be printed on the page
      printdir(response);
      // Set scroll postion
      if (scrollPosition === false) {
        var sp = $('#filelist').scrollTop();
        fileExplorerScrollPosition.push(sp);
        $('#filelist').scrollTop(0);
      } else if (scrollPosition === true) {
        var sp = fileExplorerScrollPosition.pop();
        $('#filelist').scrollTop(sp);
      }
    });
  }


  // function that will recieve JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
  function printdir(response) {
    currentBrowsingList = response.contents;

    // clear the list
    $('#filelist').empty();
    $('#search_folders').val('');

    var searchObject = [];

    //parse through the json array and make an array of corresponding divs
    var filelist = [];
    $.each(currentBrowsingList, function () {
      if (this.type == 'directory') {
        filelist.push('<div data-directory="' + this.name + '" class="dirz"><img class="folder-image" src="public/img/folder.svg"><span class="item-text">' + this.name + '</span></div>');
      } else {
        if (this.artist != null || this.title != null) {
          filelist.push('<div data-file_location="' + response.path + this.name + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="item-text">' + this.artist + ' - ' + this.title + '</span></div>');
        } else {
          filelist.push('<div data-file_location="' + response.path + this.name + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="item-text">' + this.name + '</span></div>');
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
      MSTREAMPLAYER.addSongWizard($(this).data("file_location"), {}, true);
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
          filelist.push('<div data-directory="' + this.name + '" class="dirz"><img class="folder-image" src="public/img/folder.svg"><span class="item-text">' + this.name + '</span></div>');
        } else if (this.type === 'playlist') {
          filelist.push('<div data-playlistname="' + this.name + '" class="playlist_row_container"><span data-playlistname="' + this.name + '" class="playlistz force-width">' + this.name + '</span><span data-playlistname="' + this.name + '" class="deletePlaylist">x</span></div>');
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
              filelist.push('<div data-file_location="' + path + this.name + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="title">' + this.artist + ' - ' + this.title + '</span></div>');
            } else {
              filelist.push('<div data-file_location="' + path + this.name + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="title">' + this.name + '</span></div>');
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


  //////////////////////////////////////  Share playlists
  $('#share_playlist_form').on('submit', function (e) {
    e.preventDefault();

    $('#share_it').prop("disabled", true);
    var shareTimeInDays = $('#share_time').val();

    // Check for special characters
    if (/^[0-9]*$/.test(shareTimeInDays) == false) {
      console.log('don\'t do that');
      $('#share_it').prop("disabled", false);
      return false;
    }

    //loop through array and add each file to the playlist
    var stuff = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      //Do something
      stuff.push(MSTREAMPLAYER.playlist[i].filepath);
    }

    if (stuff.length == 0) {
      $('#share_it').prop("disabled", false);
      return;
    }

    MSTREAMAPI.makeShared(stuff, shareTimeInDays, function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      $('#share_it').prop("disabled", false);
      var adrs = window.location.protocol + '//' + window.location.host + '/shared/playlist/' + response.playlist_id;
      $('.share-textarea').val(adrs);
    });
  });


  //////////////////////////////////////  Save/Load playlists
  // Save a new playlist
  $('#save_playlist_form').on('submit', function (e) {
    e.preventDefault();

    // Check for special characters
    if (/^[a-zA-Z0-9-_ ]*$/.test(title) == false) {
      console.log('don\'t do that');
      return false;
    }

    if (MSTREAMPLAYER.playlist.length == 0) {
      iziToast.warning({
        title: 'No playlist to save!',
        position: 'topCenter',
        timeout: 3500
      });
      return;
    }

    $('#save_playlist').prop("disabled", true);
    var title = $('#playlist_name').val();

    //loop through array and add each file to the playlist
    var songs = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      songs.push(MSTREAMPLAYER.playlist[i].filepath);
    }

    MSTREAMAPI.savePlaylist(title, songs, function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      $('#save_playlist').prop("disabled", false);
      $('#close_save_playlist').trigger("click");
    });
  });

  // Get all playlists
  $('.get_all_playlists').on('click', function () {
    getAllPlaylists();
  });

  function getAllPlaylists() {
    resetPanel('Playlists', 'scrollBoxHeight1');
    programState = [{
      state: 'allPlaylists'
    }]

    MSTREAMAPI.getAllPlaylists(function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      currentBrowsingList = [];

      // loop through the json array and make an array of corresponding divs
      var playlists = [];
      $.each(response, function () {
        playlists.push('<div data-playlistname="' + this.name + '" class="playlist_row_container"><span data-playlistname="' + this.name + '" class="playlistz force-width">' + this.name + '</span><span data-playlistname="' + this.name + '" class="deletePlaylist">x</span></div>');
        this.type = 'playlist';
        currentBrowsingList.push(this);
      });

      // Add playlists to the left panel
      $('#filelist').html(playlists);
    });
  }

  // delete playlist
  $("#filelist").on('click', '.deletePlaylist', function () {
    // Get Playlist ID
    var playlistname = $(this).data('playlistname');
    var that = this;

    MSTREAMAPI.deletePlaylist(playlistname, function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      $(that).parent().remove();
    });
  });

  // load up a playlist
  $("#filelist").on('click', '.playlistz', function () {
    var playlistname = $(this).data('playlistname');
    var name = $(this).html();
    $('.directoryName').html('Playlist: ' + name);

    programState.push({
      state: 'playlist',
      name: name
    })

    MSTREAMAPI.loadPlaylist(playlistname, function (response, error) {
      $('#search_folders').val('');

      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      // Add the playlist name to the modal
      $('#playlist_name').val(name);


      currentBrowsingList = [];
      //parse through the json array and make an array of corresponding divs
      var files = [];
      $.each(response, function (index, value) {

        if (!value.metadata || !value.metadata.title) {
          currentBrowsingList.push({ type: 'file', name: value.filepath, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.filepath + '</span></div>');
        } else if (value.metadata['album-art']) {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box"  data-original="/album-art/' + value.metadata['album-art'] + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div>');
        } else {
          currentBrowsingList.push({ type: 'file', name: value.metadata.artist + ' - ' + value.metadata.title, metadata: value.metadata });
          files.push('<div data-file_location="' + value.filepath + '" class="filez"><img class="album-art-box" src="/public/img/default.png"><span class="explorer-label-1">' + value.metadata.artist + ' - ' + value.metadata.title + '</span></div>');
        }
      });

      $('#filelist').html(files);
      // update linked list plugin
      ll.update();
    });
  });

  /////////////// Download Playlist
  $('#downloadPlaylist').click(function () {
    // Loop through array and add each file to the playlist
    var downloadFiles = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      downloadFiles.push(MSTREAMPLAYER.playlist[i].filepath);
    }

    // Use key if necessary
    if (MSTREAMAPI.currentServer.token) {
      $("#downform").attr("action", "download?token=" + MSTREAMAPI.currentServer.token);
    }

    $('<input>').attr({
      type: 'hidden',
      name: 'fileArray',
      value: JSON.stringify(downloadFiles),
    }).appendTo('#downform');

    //submit form
    $('#downform').submit();
    // clear the form
    $('#downform').empty();
  });

  /////////////////////////////   Database Management
  //  The Manage DB panel
  $('#manage_database').on('click', function () {
    resetPanel('Database Management', 'scrollBoxHeight2');

    $('#directory_bar').hide();

    MSTREAMAPI.dbStatus(function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      currentBrowsingList = [];
      // If there is an error
      if (response.error) {
        $('#filelist').html('<p>The database returned the following error:</p><p>' + response.error + '</p>');
        return;
      }
      // Add Beets Msg
      if (response.dbType == 'beets' || response.dbType == 'beets-default') {
        $('#filelist').append('<h3><img style="height:40px;" src="img/database-icon.svg" >Powered by Beets DB</h3>');
      }
      // if the DB is locked
      if (response.locked) {

        $('#filelist').append('  <p class="scan-status">Scan In Progress</p><p class="scan-status-files">' + response.totalFileCount + ' files in DB</p>');

        //$('#filelist').append('<p>The database is currently being built.  Currently ' + response.totalFileCount + ' files are in the DB</p>');
        return;
      }
      // If you got this far the db is made and working
      $('#filelist').append('<p>Your DB has ' + response.totalFileCount + ' files</p><input type="button" class="button secondary rounded small" value="Build Database" id="build_database">');
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
    resetPanel('Albums', 'scrollBoxHeight1');

    programState = [{
      state: 'allAlbums'
    }]
    MSTREAMAPI.albums(function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      currentBrowsingList = [];
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
    programState.push({
      state: 'album',
      name: album
    })

    MSTREAMAPI.albumSongs(album, function (response, error) {
      $('#search_folders').val('');

      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      $('.directoryName').html('Album: ' + album);

      //clear the list
      $('#filelist').empty();
      currentBrowsingList = [];

      //parse through the json array and make an array of corresponding divs
      var filelist = [];
      $.each(response, function () {
        if (this.metadata.title) {
          currentBrowsingList.push({ type: 'file', name: this.metadata.title })
          filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="title">' + this.metadata.title + '</span></div>');
        }
        else {
          currentBrowsingList.push({ type: 'file', name: this.metadata.filename })
          filelist.push('<div data-file_location="' + this.filepath + '" class="filez"><img class="music-image" src="public/img/music-note.svg"> <span class="title">' + this.metadata.filename + '</span></div>');
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
    resetPanel('Artists', 'scrollBoxHeight1');
    programState = [{
      state: 'allArtists'
    }]

    MSTREAMAPI.artists(function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      currentBrowsingList = [];

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

    MSTREAMAPI.artistAlbums(artist, function (response, error) {
      $('#search_folders').val('');

      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      //clear the list
      currentBrowsingList = [];

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
    resetPanel('Starred', 'scrollBoxHeight1');
    programState = [{
      state: 'allRated'
    }]

    MSTREAMAPI.getRated(function (response, error) {
      $('#search_folders').val('');

      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      currentBrowsingList = [];
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
        <div class="jukebox_connect button"> CONNECT IT!</div>\
        </p>\
        <img src="public/img/loading.gif" class="hide jukebox-loading">';
    }

    // Add the content
    $('#filelist').html(newHtml);
  }

  // The jukebox panel
  $('#jukebox_mode').on('click', function () {
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

    JUKEBOX.createWebsocket(MSTREAMAPI.currentServer.token, function () {
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

  // invoke vueplayer
  VUEPLAYER();
});
