$(document).ready(function(){


	// Check for key in cookies
		// if so, call the API with the token to make sure it's still valid
			// if that works, tbe plug it in and let it rip
		// if not, show login form

	// Handle log form being submitted
		// Call the login endpoint
			// Get and set the key, save key to cookies
	$('#login-form').on('submit', function(e){
		e.preventDefault();
		$("#login-submit").attr("disabled","disabled");

		var request = $.ajax({
			url: "login",
			type: "POST",
			data: {
				username:$('#login-username').val(),
				password:$('#login-password').val()
			},
		});

		request.done(function( msg ) {
			$('#login-alert').toggleClass('alert');
			$('#login-alert').toggleClass('success');
			$('#login-alert').text('Welcome To mStream!');


			// Get the key
			var parsedResponse = $.parseJSON(msg);
			var token = parsedResponse.token;

			// Add the token to the cookies
			Cookies.set('token', token);

			// Add the token the URL calls
			accessKey = token;
			virtualDirectory = parsedResponse.vPath;
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



	var accessKey = '';
	var virtualDirectory = '';
	$.ajaxPrefilter(function( options ) {
    options.beforeSend = function (xhr) {
      xhr.setRequestHeader('x-access-token', accessKey);
    }
	});




	// Determine if the user needs to log in
	function testIt(){
		var token = Cookies.get('token');
		if(token){
			accessKey = token;
		}


		var request = $.ajax({
			url: "ping",
			type: "GET"
		});

		request.done(function( msg ) {
			// Remove login screen
			// set virtualDirectory
			var decoded = msg;
			virtualDirectory = decoded.vPath;
		});

		request.fail(function( jqXHR, textStatus ) {
			// alert( "Request failed: " + textStatus );
			$('.login-overlay').fadeIn( "slow" );

		});

	}

	testIt();



	// TODO: This var nees to be appened to the beginning of any music fileapath
	// This var will either be the username or the value returned by the ping API call
	var vPath = '';


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

	// Core playlist functionality.  When a song ends, go to the next song

	// TODO: This is the ideal way to do things.  Doesn't work on firefox though
	//document.getElementById("audio").addEventListener("ended", function(){
	// Put this function in the global scope so it can be accessed by polymer
	window.goToNextSong = function goToNextSong(){
		// Should disable any features that can cause the playlist to change
		// This will prevent some edge case logic errors

		// Check for playlist item with label "current song"
		if($('#playlist').find('li.current').length!=0){

			// if there's no next item, return
			if($('#playlist').find('li.current').next('li').length===0){
				return;
			}

			var current = $('#playlist').find('li.current');
			var next = $('#playlist').find('li.current').next('li');

		// get the url in that item
		var song = next.data('songurl');
		var filetype = next.data('filetype');

		// Add label of "current song" to this item
		current.toggleClass('current');
		next.toggleClass('current');

		}
		// If there is no current song but the playlist is not empty
		else if($('#playlist').find('li.current').length == 0 && $('#playlist li').length != 0){
			// Then select the first song and play that
			var first_on_playlist = $('ul#playlist li:first');
			first_on_playlist.toggleClass('current');

			var song = first_on_playlist.data('songurl');
  			var filetype = next.data('filetype');
		}

  		// Add that URL to jPlayer
		jPlayerSetMedia(song, filetype);
		// TODO
		//$(this).jPlayer("play");
	}


	// When an item in the playlist is clicked, start playing that song
	$('#playlist').on( 'click', 'li span', function() {
		var songurl = $(this).parent().data('songurl');
		var filetype = $(this).parent().data('filetype');

		$('#playlist li').removeClass('current');
		$(this).parent().addClass('current');

		// Add that URL to jPlayer
		jPlayerSetMedia(songurl, filetype);
	});


// clear the playlist
	$("#clear").click(function() {
		$('#playlist').empty();
		$('#playlist_name').val('');
	});


// when you click an mp3, add it to the now playling playlist
	$("#filelist").on('click', 'div.filez', function() {
		addFile2(this);
	});


	function jPlayerSetMedia(fileLocation, filetype){
		if(virtualDirectory){
			fileLocation = virtualDirectory + '/' + fileLocation;
		}
		document.getElementById("mplayer").setAttribute("src", fileLocation);
		document.getElementById("mplayer").setAttribute("title", fileLocation.split('/').pop());
	}


// Adds file to the now playing playlist
// There is no longer addfile1
	function addFile2(that){
		var filename = $(that).attr("id");
		var file_location =  $(that).data("file_location");
		if(accessKey){
			file_location += '?token=' + accessKey;
		}
		var filetype = $(that).data("filetype");

		var title = $(that).find('span.title').html();

		// The current var gets added to the class of the new playlist item
		var current = '';

		// this checks if jplayer is playing something
		// console.log($("#jquery_jplayer_1").data().jPlayer.status.paused);

		// if the playlist is empty and no media is currently playing
		//if ($('#playlist li').length == 0 && $("#jquery_jplayer_1").data().jPlayer.status.paused == true){
		if ($('#playlist li').length == 0 ){ // TODO:

			// Set this playlist item as the current one and que it in jplayer
			current = ' current';
			jPlayerSetMedia(file_location, filetype);
			// $('#jquery_jplayer_1').jPlayer("play");
		}

		// Add html to the end of the playlist
		$('ul#playlist').append(
			$('<li/>', {
				'data-filetype': filetype,
				'data-songurl': file_location,
				'class': 'dragable' + current,
				html: '<span class="play1">'+title+'</span><a href="javascript:void(0)" class="closeit">X</a>'
			})
		);

		$('#playlist').sortable();

	}


	// when you click 'add directory', add entire directory to the playlist
	$("#addall").on('click', function() {
		//make an array of all the mp3 files in the curent directory
		var elems = document.getElementsByClassName('filez');
		var arr = jQuery.makeArray(elems);

		//loop through array and add each file to the playlist
		$.each( arr, function() {
			addFile2(this);
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


		// If the scraper option is checked, then tell dirparer to use getID3
		$.post('dirparser', {dir: directoryString,  filetypes: filetypes}, function(response) {
			// Set any directory views
			$('.directoryName').html('/' + directoryString);

			// hand this data off to be printed on the page
			printdir(response);

			// Set scroll postion
			$('.testScroll').scrollTop(scrollPosition);

		});
	}



// function that will recieve JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
	function printdir(dir){
		currentBrowsingList = [];

		var dirty = $.parseJSON(dir);

		var path = dirty.path;
		currentBrowsingList = dirty.contents;

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


//////////////////////////////////////  Save/Load playlists

// Save a new playlist
	$('#save_playlist_form').on('submit', function(e){
		e.preventDefault();

		$('#save_playlist').prop("disabled",true);

		var playlistElements = $('ul#playlist li');
		var playlistArray = jQuery.makeArray(playlistElements);

		var title = $('#playlist_name').val();

		var stuff = [];

		// Check for special characters
		if(/^[a-zA-Z0-9-_ ]*$/.test(title) == false) {
			console.log('don\'t do that');
			$('#save_playlist').prop("disabled",false);
			return false;
		}

		//loop through array and add each file to the playlist
		$.each( playlistArray, function() {
			stuff.push($(this).data('songurl'));
		});

		if(stuff.length == 0){
			$('#save_playlist').prop("disabled",false);
			return;
		}

		$.ajax({
			type: "POST",
			url: "saveplaylist",
			data: {
				title:title,
				stuff:stuff
			},
		})
		.done(function( msg ) {

			if(msg == 1){
				// ???
			}
			if(msg == 0){
				// $('#playlist_list').append('<li><a data-filename="' + title + '.m3u">' + title + '</a></li>')
			}

			$('#save_playlist').prop("disabled",false);
			$('#close_save_playlist').trigger("click");
		});
		// TODO: error handeling

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



		var request = $.ajax({
			url: "getallplaylists",
			type: "GET"
		});

		request.done(function( msg ) {
			var dirty = $.parseJSON(msg);

			//parse through the json array and make an array of corresponding divs
			var playlists = [];
			$.each(dirty, function() {
				// TODO: Append delete button
				playlists.push('<div data-playlistname="'+this.name+'" class="playlist_row_container"><span data-playlistname="'+this.name+'" class="playlistz force-width">'+this.name+'</span><span data-playlistname="'+this.name+'" class="deletePlaylist">x</span></div>');
			});

			// Ad playlists to the left panel
			$('#filelist').html(playlists);

		});

		request.fail(function( jqXHR, textStatus ) {
			// alert( "Request failed: " + textStatus );

			$('#filelist').html('<p>Something went wrong</p>');
		});

	});


$("#filelist").on('click', '.deletePlaylist', function(){
	// Get Playlist ID
	var playlistname = $(this).data('playlistname');


	// Send to server
	var request = $.ajax({
		url: "deleteplaylist",
		type: "GET",
		data: {playlistname: playlistname}
	});

	request.done(function( msg ) {

	});

	request.fail(function( jqXHR, textStatus ) {
		// TODO:
	});

	$(this).parent().remove();

});


// load up a playlist
$("#filelist").on('click', '.playlistz', function() {
	var playlistname = $(this).data('playlistname');
	var name = $(this).html();

	// Make an AJAX call to get the contents of the playlist
	$.ajax({
		type: "GET",
		url: "loadplaylist",
		data: {playlistname: playlistname},
		dataType: 'json',
	})
	.done(function( msg ) {
		// Add the playlist name to the modal
		$('#playlist_name').val(name);

		// Clear the playlist
		$('#playlist').empty();

		// Append the playlist items to the playlist
		$.each( msg, function(i ,item) {
			$('ul#playlist').append(
				$('<li/>', {
					'data-filetype': item.filetype, // TODO: Dirty hack, since jplayer doesn't really care about filetype
					'data-songurl': item.file,
					'class': 'dragable',
					html: '<span class="play1">'+item.name+'</span><a href="javascript:void(0)" class="closeit">X</a>'
				})
			);
		});


		$('#playlist').sortable();
	});
});


/////////////////////////////////////////
/////////////// DOWNLOADS ///////////////
/////////////////////////////////////////


	// Download a playlist
	$('#downloadPlaylist').click(function(){
		// encode entire playlist data into into array
		var playlistElements = $('ul#playlist li');
		var playlistArray = jQuery.makeArray(playlistElements);

		var downloadFiles = [];

		//loop through array and add each file to the playlist
		$.each( playlistArray, function() {
			downloadFiles.push($(this).data('songurl'));
		});

		var downloadJOSN = JSON.stringify(downloadFiles);

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

		// Make an ajax request to get the current state of the db
		var request = $.ajax({
		  url: "db/status",
		  type: "GET",
		  dataType: "json"
		});

		request.done(function( msg ) {

			// If there is an error
			if(msg.error){
				$('#filelist').html('<p>The database returned the following error:</p><p>' + msg.error + '</p>');
				return;
			}

			console.log(msg);

			// TODO: Add Beets Logo
			if(msg.dbType == 'beets' || msg.dbType == 'beets-default' ){
				$('#filelist').append('<h3><img style="height:40px;" src="img/database-icon.svg" >Powered by Beets DB</h3>');				
			}

			// if the DB is locked
			if(msg.locked){
				$('#filelist').append('<p>The database is currently being built.  Currently '+msg.totalFileCount+' files are in the DB</p><input type="button" value="Check Progress" class="button secondary small" id="check_db_progress" >');
				return;
			}

			// If you got this far the db is made and working
			$('#filelist').append('<p>Your DB has ' + msg.totalFileCount + ' files</p><input type="button" class="button secondary rounded small" value="Build Database" id="build_database">');
		});

		request.fail(function(msg){
			$('#filelist').html('<p>Error ' + msg.totalFileCount + ' files</p><input type="button" class="button secondary rounded small" value="Try Building DB Database" id="build_database">');
		});

	});


	// Build the database
	$('body').on('click', '#build_database', function(){
		$(this).prop("disabled", true);

		// Send out AJAX request to start building the DB
		var request = $.ajax({
			url: "db/recursive-scan",
			type: "GET",
		});

		request.done(function( msg ) {
			// Append the check db button so the user can start checking right away
			$('#filelist').append('<input type="button" value="Check Progress" id="check_db_progress" >');
		});

		// TODO: Print out the error instead of assuming
		request.fail(function( jqXHR, textStatus ) {
			$('#filelist').html("<p>Scan already in progress</p>");
		});
	});

// Check DB build progress
	$('body').on('click', '#check_db_progress', function(){
		var request = $.ajax({
			url: "db/status",
			type: "GET",
			dataType: "json"
		});

		request.done( function(msg){
			// remove a <p> tage with the id of "db_progress_report"
			$( "#db_progress_report" ).remove();

			// if file_count is 0, report that the the build script is not done counting files
			if(msg.file_count == 0){
				$('#filelist').append('<p id="db_progress_report">The create database script is still counting the files in the music collection.  This operation can take some time.  Try again in a bit</p>');
				return;
			}

			// Append new <p> tag with id of "db_progress_report"
			$('#filelist').append('<p id="db_progress_report">Progress: '+ msg.files_in_db +'/'+ msg.file_count +'</p>');
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


		var request = $.ajax({
			url: "db/albums",
			type: "GET"
		});

		request.done(function( msg ) {
			console.log(msg);
			var parsedAlbums = $.parseJSON(msg);
			// console.log(dirty);

			//clear the list
			$('#filelist').empty();

			//parse through the json array and make an array of corresponding divs
			var albums = [];
			$.each(parsedAlbums.albums, function(index, value) {
				albums.push('<div data-album="'+value+'" class="albumz">'+value+' </div>');
			});


			$('#filelist').html(albums);
			$('.panel_one_name').html('Albums');
		});

		request.fail(function( jqXHR, textStatus ) {
			$('#filelist').html("<p>Search Failed.  Your database may not be setup</p>");
		});

	});


	// Load up album-songs
	$("#filelist").on('click', '.albumz', function() {

		var album = $(this).data('album');

		var request = $.ajax({
			url: "db/album-songs",
			type: "POST",
			data: { album : album },
			// dataType: "html"
		});

		request.done(function( msg ) {
			var parsedMessage = $.parseJSON(msg);

			//clear the list
			$('#filelist').empty();

			//parse through the json array and make an array of corresponding divs
			var filelist = [];
			$.each(parsedMessage, function() {
				console.log(this);
				if(this.title==null){
					filelist.push('<div data-filetype="'+this.format+'" data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.filename+'</span></div>');
				}
				else{
					filelist.push('<div data-filetype="'+this.format+'" data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.title+'</span></div>');
				}

			});


			$('#filelist').html(filelist);

		});

		request.fail(function( jqXHR, textStatus ) {
			$('#filelist').html("<p>Search Failed.  Your database may not be setup</p>");
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


		var request = $.ajax({
			url: "db/artists",
			type: "GET"
		});

		request.done(function( msg ) {
			console.log(msg);
			var parsedArtists = $.parseJSON(msg);
			// console.log(dirty);

			//clear the list
			$('#filelist').empty();

			//parse through the json array and make an array of corresponding divs
			var artists = [];
			$.each(parsedArtists.artists, function(index,value) {
				artists.push('<div data-artist="'+value+'" class="artistz">'+value+' </div>');
			});


			$('#filelist').html(artists);
			$('.panel_one_name').html('Artists');
		});

		request.fail(function( jqXHR, textStatus ) {
			$('#filelist').html("<p>Search Failed.  Your database may not be setup</p>");
		});

	});

	$("#filelist").on('click', '.artistz', function() {

		var artist = $(this).data('artist');
		fileExplorerScrollPosition = [];



		// $('.directoryTitle').hide();

		var request = $.ajax({
			url: "db/artists-albums",
			type: "POST",
			data: { artist : artist },
		});

		request.done(function( msg ) {
			var parsedMessage = $.parseJSON(msg);


			//clear the list
			$('#filelist').empty();


			var albums = [];
			$.each(parsedMessage.albums, function(index, value) {
				albums.push('<div data-album="'+value+'" class="albumz">'+value+' </div>');
			});


			$('#filelist').html(albums);
			$('.panel_one_name').html('Artists->Albums');


		});

		request.fail(function( jqXHR, textStatus ) {
			$('#filelist').html("<p>Search Failed.  Your database may not be setup</p>");
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
		if($(this).val().length>1){

			var request = $.ajax({
			  url: "db/search",
			  type: "POST",
			  data: { search : $(this).val() },
			});

			request.done(function( msg ) {
			  var parsedMessage = $.parseJSON(msg);

			  var htmlString = '';

			  if(parsedMessage.artists.length > 0){
			  	htmlString += '<h2 class="search_subtitle"><strong>Artists</strong></h2>';
			  	$.each(parsedMessage.artists, function(index, value) {
					htmlString += '<div data-artist="'+value+'" class="artistz">'+value+' </div>';
				});
			  }

			  if(parsedMessage.albums.length > 0){
			  	htmlString += '<h2 class="search_subtitle"><strong>Albums</strong></h2>';
			  	$.each(parsedMessage.albums, function(index, value) {
					htmlString += '<div data-album="'+value+'" class="albumz">'+value+' </div>';
				});
			  }

			  $('#filelist').html(htmlString);


			});

			request.fail(function( jqXHR, textStatus ) {
				$('#filelist').html("<p>Search Failed.  Your database may not be setup</p>");

			});
		}
	});


});
