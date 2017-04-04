$(document).ready(function(){

  function setupJukeboxPanel(){
    // Hide the directory bar
    $('.directoryTitle').hide();
    // Change the panel name
    $('.panel_one_name').html('Jukebox Mode');
    // clear the list
    $('#filelist').empty();
    $('#filelist').removeClass('scrollBoxHeight1');
    $('#filelist').removeClass('scrollBoxHeight2');
    $('#filelist').addClass('scrollBoxHeight2');

    // TODO: Check if connection has been established
      // setup correct html
    var newHtml = '';
    if(JUKEBOX.stats.live !== false && JUKEBOX.connection !== false){
      newHtml = createJukeboxPanel();

    }else{
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
	$('#jukebox_mode').on('click', function(){
    setupJukeboxPanel();
	});


	// Setup Jukebox
	$('body').on('click', '.jukebox_connect', function(){
		$(this).prop("disabled", true);
    $(this).hide();
    $('.jukebox-loading').toggleClass('hide');

    JUKEBOX.createWebsocket( MSTREAMAPI.currentServer.token, function(){
      // Wait a while and display the status
      setTimeout(function(){
        // TODO: Check that status has changed

        setupJukeboxPanel();
      },1800);
    });
	});


  function createJukeboxPanel(){
    var returnHtml = '<p class="jukebox-panel">';

    if(JUKEBOX.stats.error !== false){
      // TODO: WARN THE USER
      returnHtml = '';
      return returnHtml;
    }

    if(JUKEBOX.stats.adminCode){
      returnHtml += '<h1>Code: ' + JUKEBOX.stats.adminCode + '</h1>';
    }

    if(JUKEBOX.stats.guestCode){
      returnHtml += '<h2>Guest Code: ' + JUKEBOX.stats.guestCode + '</h2>';
    }

    var adrs =  window.location.protocol + '//' + window.location.host + '/remote';
    returnHtml += '<br><h4>Remote Jukebox Controls: <a target="_blank" href="' + adrs + '"> ' + adrs + '</a><h4>';

    returnHtml += '</p>';
    return returnHtml;
  }




  // Handle login form
	$('#login-form').on('submit', function(e){
		e.preventDefault();
		$("#login-submit").attr("disabled","disabled");

    // MSTREAMAPI.login( $('#login-username').val(), $('#login-password').val(), function(response){
    // });


		var request = $.ajax({
			url: "login",
			type: "POST",
      contentType: "application/json",
      dataType: "json",
			data: JSON.stringify(
        {
          username: $('#login-username').val(),
          password: $('#login-password').val()
        }
      )
		});

		request.done(function( msg ) {
			$('#login-alert').toggleClass('alert');
			$('#login-alert').toggleClass('success');
			$('#login-alert').text('Welcome To mStream!');

			// Get the key
			var parsedResponse = msg;
			var token = parsedResponse.token;

			// Add the token to the cookies
			Cookies.set('token', token);

			// Add the token the URL calls
			MSTREAMAPI.currentServer.token = token;
			MSTREAMAPI.currentServer.vPath = parsedResponse.vPath;
			loadFileExplorer();

			// Remove the overlay
			$('.login-overlay').fadeOut( "slow" );
			$("#login-submit").attr("disabled",false);
		});

		request.fail(function( jqXHR, textStatus ) {
			// Alert the user
			$("#login-submit").attr("disabled",false);
			$('#login-alert').removeClass('super-hide');
		});
	});



	$.ajaxPrefilter(function( options ) {
    options.beforeSend = function (xhr) {
      xhr.setRequestHeader('x-access-token', MSTREAMAPI.currentServer.token);
    }
	});




	// Determine if the user needs to log in
	function testIt(){
		var token = Cookies.get('token');

		if(token){
			 MSTREAMAPI.currentServer.token = token;
		}


		var request = $.ajax({
			url: "ping",
			type: "GET"
		});

		request.done(function( msg ) {
			// Remove login screen
			// set vPath
			var decoded = msg;
			MSTREAMAPI.currentServer.vPath = decoded.vPath;
		});

		request.fail(function( jqXHR, textStatus ) {
			// alert( "Request failed: " + textStatus );
			$('.login-overlay').fadeIn( "slow" );

		});

	}

	testIt();





////////////////////////////// Initialization code

	// Supported file types
	var filetypes = '["mp3","ogg","wav","m4a","flac"]';

	// These vars track your position within the file explorer
	var fileExplorerArray = [];
	var fileExplorerScrollPosition = [];

	// Setup the filebrowser
	loadFileExplorer();

	// TODO: This will store an array of searchable ojects
	var currentBrowsingList = [];

/////////////////////////////   The Now Playing Column






// clear the playlist
	$("#clear").click(function() {
    MSTREAM.clearPlaylist();
	});


// when you click an mp3, add it to the now playling playlist
	$("#filelist").on('click', 'div.filez', function() {
		MSTREAM.addSongWizard($(this).data("file_location"));
	});




// Adds file to the now playing playlist
// There is no longer addfile1
	// function addFile2(file_location){
  //   var raw_location = file_location;
  //
  //   if(MSTREAMAPI.currentServer.vPath){
  //     file_location = MSTREAMAPI.currentServer.vPath + '/' + file_location;
  //   }
  //
  //   if( MSTREAMAPI.currentServer.token){
  //     file_location = file_location + '?token=' +  MSTREAMAPI.currentServer.token;
  //   }
  //
  //   MSTREAM.addSong({
  //     url: file_location,
  //     filepath: raw_location
  //   });
	// }


	// when you click 'add directory', add entire directory to the playlist
	$("#addall").on('click', function() {
		//make an array of all the mp3 files in the curent directory
		var elems = document.getElementsByClassName('filez');
		var arr = jQuery.makeArray(elems);

		//loop through array and add each file to the playlist
		$.each( arr, function() {
			MSTREAM.addSongWizard($(this).data("file_location"));
		});
	});


	// Remove item from Now Playling playlist
	$('body').on('click', 'a.closeit', function(e){
		$(this).parent().remove();
	});






///////////////////////////////////////// File Explorer

	function loadFileExplorer(){

		$('.directoryTitle').hide();
		$('#directory_bar').show();

		$('.panel_one_name').html('File Explorer');

		// Reset file explorer vars
		fileExplorerArray = [];
		fileExplorerScrollPosition = [];

		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight1');

		//send this directory to be parsed and displayed
		senddir(0);

	}

// Load up the file explorer
	$('.get_file_explorer').on('click', loadFileExplorer);

// when you click on a directory, go to that directory
	$("#filelist").on('click', 'div.dirz', function() {
		//get the id of that class
		var nextDir = $(this).attr("id");
		fileExplorerArray.push(nextDir);

		// Save the scroll position
		var scrollPosition = $('.testScroll').scrollTop();
		fileExplorerScrollPosition.push(scrollPosition);

		//pass this value along
		senddir(0);
	});

// when you click the back directory
	$(".backButton").on('click', function() {
		if(fileExplorerArray.length != 0){
			// remove the last item in the array
			fileExplorerArray.pop();
			// Get the scroll postion
			var scrollPosition = fileExplorerScrollPosition.pop();

			senddir(scrollPosition);
		}
	});




// send a new directory to be parsed.
	function senddir(scrollPosition){
		// Construct the directory string
		var directoryString = "";
		for (var i = 0; i < fileExplorerArray.length; i++) {
		    directoryString += fileExplorerArray[i] + "/";
		}

    MSTREAMAPI.dirparser(directoryString, false, function(response){
      // TODO: Check for failure

    	// Set any directory views
			$('.directoryName').html('/' + directoryString);
			// hand this data off to be printed on the page
			printdir(response);
			// Set scroll postion
			$('.testScroll').scrollTop(scrollPosition);
    });
	}



// function that will recieve JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
	function printdir(response){
		currentBrowsingList = [];

		var path = response.path;
		currentBrowsingList = response.contents;

		//clear the list
		$('#filelist').empty();
		$('#search_folders').val('');

		// TODO: create an object of everything that the user can easily sort through
		var searchObject = [];

		//parse through the json array and make an array of corresponding divs
		var filelist = [];
		$.each(currentBrowsingList, function() {
			if(this.type=='directory'){
				filelist.push('<div id="'+this.name+'" class="dirz">'+this.name+'</div>');
			}else{
				if(this.artist!=null || this.title!=null){
					filelist.push('<div data-filetype="'+this.type+'" data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.artist+' - '+this.title+'</span></div>');
				}else{
					filelist.push('<div data-filetype="'+this.type+'"  data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.name+'</span></div>');
				}
			}
		});

		// Post the html to the filelist div
		$('#filelist').html(filelist);
	}


// Search Files
$('#search_folders').on('keyup', function(){
	var searchVal = $(this).val();

	var path = "";		// Construct the directory string
	for (var i = 0; i < fileExplorerArray.length; i++) {
		path += fileExplorerArray[i] + "/";
	}

	var filelist = [];


	if($(this).val().length>1){

		$.each(currentBrowsingList, function() {
			var lowerCase = this.name.toLowerCase();

			if (lowerCase.indexOf( searchVal.toLowerCase() ) !== -1) {
				if(this.type=='directory'){
					filelist.push('<div id="'+this.name+'" class="dirz">'+this.name+'</div>');
				}else{
					if(this.artist!=null || this.title!=null){
						filelist.push('<div data-filetype="'+this.type+'" data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.artist+' - '+this.title+'</span></div>');
					}else{
						filelist.push('<div data-filetype="'+this.type+'"  data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.name+'</span></div>');
					}
				}
			}
		});

	}else{

		$.each(currentBrowsingList, function() {
			if(this.type=='directory'){
				filelist.push('<div id="'+this.name+'" class="dirz">'+this.name+'</div>');
			}else{
				if(this.artist!=null || this.title!=null){
					filelist.push('<div data-filetype="'+this.type+'" data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.artist+' - '+this.title+'</span></div>');
				}else{
					filelist.push('<div data-filetype="'+this.type+'"  data-file_location="'+path+this.name+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.name+'</span></div>');
				}
			}
		});

	}

	// Post the html to the filelist div
	$('#filelist').html(filelist);
});


$('#search-explorer').on('click', function(){
	// Hide Filepath
	$('#search_folders').toggleClass( 'hide' );
	// Show Search Input
	$('.directoryName').toggleClass( 'hide' );

	if(!$('#search_folders').hasClass('hide')){
		$( "#search_folders" ).focus();
	}
});


//////////////////////////////////////  Share playlists

// Save a new playlist
	$('#share_playlist_form').on('submit', function(e){
		e.preventDefault();

		$('#share_it').prop("disabled",true);
    var shareTimeInDays = $('#share_time').val();

		// Check for special characters
		if(/^[0-9]*$/.test(shareTimeInDays) == false) {
			console.log('don\'t do that');
			$('#share_it').prop("disabled",false);
			return false;
		}

		//loop through array and add each file to the playlist
    var stuff = [];
    for (let i = 0; i < MSTREAM.playlist.length; i++) {
      //Do something
      stuff.push(MSTREAM.playlist[i].filepath);
    }

		if(stuff.length == 0){
			$('#share_it').prop("disabled",false);
			return;
		}

    MSTREAMAPI.makeShared(stuff, shareTimeInDays, function(response){
      $('#share_it').prop("disabled",false);
      var l = window.location;
      var adrs =  l.protocol + '//' + l.host + '/shared/playlist/' + response.id;
      $('.share-textarea').val(adrs);
    });
	});


//////////////////////////////////////  Save/Load playlists

// Save a new playlist
	$('#save_playlist_form').on('submit', function(e){
		e.preventDefault();

    // Check for special characters
    if(/^[a-zA-Z0-9-_ ]*$/.test(title) == false) {
      console.log('don\'t do that');
      return false;
    }

    if(MSTREAM.playlist.length == 0){
      return;
    }

		$('#save_playlist').prop("disabled",true);
		var title = $('#playlist_name').val();

		//loop through array and add each file to the playlist
    var songs = [];
    for (let i = 0; i < MSTREAM.playlist.length; i++) {
      //Do something
      songs.push(MSTREAM.playlist[i].filepath);
    }

    MSTREAMAPI.savePlaylist(title, songs, function(response){
      // TODO: Check for failure
      $('#save_playlist').prop("disabled",false);
  		$('#close_save_playlist').trigger("click");
    });
	});



// Get all playlists
	$('.get_all_playlists').on('click', function(){
		// Hide the directory bar
		$('.directoryTitle').hide();
		// Change the panel name
		$('.panel_one_name').html('Playlists');
		//clear the list
		$('#filelist').empty();

		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight2');

		fileExplorerScrollPosition = [];

    MSTREAMAPI.getAllPlaylists( function(response){
  		//parse through the json array and make an array of corresponding divs
  		var playlists = [];
  		$.each(response, function() {
  			// TODO: Append delete button
  			playlists.push('<div data-playlistname="'+this.name+'" class="playlist_row_container"><span data-playlistname="'+this.name+'" class="playlistz force-width">'+this.name+'</span><span data-playlistname="'+this.name+'" class="deletePlaylist">x</span></div>');
  		});

  		// Add playlists to the left panel
  		$('#filelist').html(playlists);
    });
	});


$("#filelist").on('click', '.deletePlaylist', function(){
	// Get Playlist ID
	var playlistname = $(this).data('playlistname');
  var that = this;

  MSTREAMAPI.deletePlaylist(playlistname, function(response){
    $(that).parent().remove();
  });
});


// load up a playlist
$("#filelist").on('click', '.playlistz', function() {
	var playlistname = $(this).data('playlistname');
	var name = $(this).html();

  MSTREAMAPI.loadPlaylist(playlistname, function(response){
    console.log(response);
  	// Add the playlist name to the modal
		$('#playlist_name').val(name);

		// Clear the playlist
    MSTREAM.clearPlaylist();

		// Append the playlist items to the playlist
		$.each( response, function(i ,item) {
      MSTREAM.addSongWizard(item.filepath);
		});
  });
});


/////////////////////////////////////////
/////////////// DOWNLOADS ///////////////
/////////////////////////////////////////


	// Download a playlist
	$('#downloadPlaylist').click(function(){
		//loop through array and add each file to the playlist
    var downloadFiles = [];
    for (let i = 0; i < MSTREAM.playlist.length; i++) {
      downloadFiles.push(MSTREAM.playlist[i].filepath);
    }

		var downloadJOSN = JSON.stringify(downloadFiles);

    // Use key is necessary
    if( MSTREAMAPI.currentServer.token){
      $("#downform").attr("action", "download?token=" +  MSTREAMAPI.currentServer.token);
    }


		$('<input>').attr({
			type: 'hidden',
			name: 'fileArray',
			value: downloadJOSN,
		}).appendTo('#downform');

		//submit form
		$('#downform').submit();
		// clear the form
		$('#downform').empty();
	});



/////////////////////////////   Database Management

//  The Manage DB panel
	$('#manage_database').on('click', function(){
		// Hide the directory bar
		$('.directoryTitle').hide();
		// Change the panel name
		$('.panel_one_name').html('Database Management');
		//clear the list
		$('#filelist').empty();

		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight2');

    MSTREAMAPI.dbStatus( function(response){
  		// If there is an error
  		if(response.error){
  			$('#filelist').html('<p>The database returned the following error:</p><p>' + response.error + '</p>');
  			return;
  		}

  		// Add Beets Msg
  		if(response.dbType == 'beets' || response.dbType == 'beets-default' ){
  			$('#filelist').append('<h3><img style="height:40px;" src="img/database-icon.svg" >Powered by Beets DB</h3>');
  		}

  		// if the DB is locked
  		if(response.locked){
  			$('#filelist').append('<p>The database is currently being built.  Currently ' + response.totalFileCount + ' files are in the DB</p><input type="button" value="Check Progress" class="button secondary small" id="check_db_progress" >');
  			return;
  		}

  		// If you got this far the db is made and working
  		$('#filelist').append('<p>Your DB has ' + response.totalFileCount + ' files</p><input type="button" class="button secondary rounded small" value="Build Database" id="build_database">');
    });
	});


	// Build the database
	$('body').on('click', '#build_database', function(){
		$(this).prop("disabled", true);

    MSTREAMAPI.dbScan( function(response){
      // Append the check db button so the user can start checking right away
			$('#filelist').append('<input type="button" value="Check Progress" id="check_db_progress" >');
    });
	});

// Check DB build progress
	$('body').on('click', '#check_db_progress', function(){
    MSTREAMAPI.dbStatus( function(response){
      // remove a <p> tage with the id of "db_progress_report"
			$( "#db_progress_report" ).remove();

			// if file_count is 0, report that the the build script is not done counting files
			if(response.file_count == 0){
				$('#filelist').append('<p id="db_progress_report">The create database script is still counting the files in the music collection.  This operation can take some time.  Try again in a bit</p>');
				return;
			}

			// Append new <p> tag with id of "db_progress_report"
			$('#filelist').append('<p id="db_progress_report">Progress: '+ response.files_in_db +'/'+ response.file_count +'</p>');
    });
	});




////////////////////////////////////  Sort by Albums
//Load up album explorer
	$('.get_all_albums').on('click', function(){

		$('.directoryTitle').hide();
		fileExplorerScrollPosition = [];

		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight2');

    MSTREAMAPI.albums( function(response){
			//clear the list
			$('#filelist').empty();

			//parse through the json array and make an array of corresponding divs
			var albums = [];
			$.each(response.albums, function(index, value) {
				albums.push('<div data-album="'+value+'" class="albumz">'+value+' </div>');
			});

			$('#filelist').html(albums);
			$('.panel_one_name').html('Albums');
    });
	});


	// Load up album-songs
	$("#filelist").on('click', '.albumz', function() {
		var album = $(this).data('album');

    MSTREAMAPI.albumSongs(album, function(response){
      //clear the list
      $('#filelist').empty();

      //parse through the json array and make an array of corresponding divs
      var filelist = [];
      $.each(response, function() {
        if(this.title==null){
          filelist.push('<div data-file_location="'+this.filepath+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.filename+'</span></div>');
        }
        else{
          filelist.push('<div data-file_location="'+this.filepath+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.title+'</span></div>');
        }
      });

      $('#filelist').html(filelist);
    });
	});



/////////////////////////////////////// Artists
// Load up album-songs

	$('.get_all_artists').on('click', function(){

		$('.directoryTitle').hide();
		fileExplorerScrollPosition = [];
		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight2');

    MSTREAMAPI.artists( function(response){
      //clear the list
      $('#filelist').empty();

      //parse through the json array and make an array of corresponding divs
      var artists = [];
      $.each(response.artists, function(index,value) {
        artists.push('<div data-artist="'+value+'" class="artistz">'+value+' </div>');
      });


      $('#filelist').html(artists);
      $('.panel_one_name').html('Artists');
    });

	});



	$("#filelist").on('click', '.artistz', function() {
		var artist = $(this).data('artist');
		fileExplorerScrollPosition = [];

    MSTREAMAPI.artistAlbums(artist, function(response){
      //clear the list
    	$('#filelist').empty();

    	var albums = [];
    	$.each(response.albums, function(index, value) {
    		albums.push('<div data-album="'+value+'" class="albumz">'+value+' </div>');
    	});

    	$('#filelist').html(albums);
    	$('.panel_one_name').html('Artists->Albums');
    });
	});



/////////////////////////////   Search Function
	// Setup the search interface
	$('#search_database').on('click', function(){
		$('.directoryTitle').hide();
		$('#search_container').show();

		$('#filelist').html('');


		$('#filelist').removeClass('scrollBoxHeight1');
		$('#filelist').removeClass('scrollBoxHeight2');
		$('#filelist').addClass('scrollBoxHeight1');

		$('.panel_one_name').html('Search');
	});

	// Auto Search
	$('#search_it').on('keyup', function(){
    // TODO: Put this on some kind of time delay.  That way rapid keystrokes won't spam the server
		if($(this).val().length>1){
      MSTREAMAPI.search($(this).val(), function(response){
			  var htmlString = '';

			  if(response.artists.length > 0){
			  	htmlString += '<h2 class="search_subtitle"><strong>Artists</strong></h2>';
			  	$.each(response.artists, function(index, value) {
  					htmlString += '<div data-artist="'+value+'" class="artistz">'+value+' </div>';
  				});
			  }

			  if(response.albums.length > 0){
			  	htmlString += '<h2 class="search_subtitle"><strong>Albums</strong></h2>';
			  	$.each(response.albums, function(index, value) {
  					htmlString += '<div data-album="'+value+'" class="albumz">'+value+' </div>';
  				});
			  }

			  $('#filelist').html(htmlString);
      });
		}
	});

});
