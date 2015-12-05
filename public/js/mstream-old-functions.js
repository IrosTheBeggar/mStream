///////////////////////////////   Database Management

///  The Manage DB panel
	// $('#manage_database').on('click', function(){
	// 	// Hide the directory bar
	// 	$('.directoryTitle').hide();
	// 	// Change the panel name
	// 	$('.panel_one_name').html('Database Management');
	// 	//clear the list
	// 	$('#filelist').empty();

	// 	// Make an ajax request to get the current state of the db
	// 	var request = $.ajax({
	// 	  url: "db_scripts/check_db_status.php",
	// 	  type: "GET",
	// 	  dataType: "json"
	// 	});

	// 	request.done(function( msg ) {

	// 		// If there is an error
	// 		if(msg.error){
	// 			$('#filelist').html('<p>The database returned the following error:</p><p>' + msg.error + '</p>');

	// 			return;
	// 		}

	// 		// if the DB is locked
	// 		if(msg.locked){
	// 			//
	// 			$('#filelist').html('<p>The database is currently being built</p><input type="button" value="Check Progress" class="button secondary small" id="check_db_progress" >');
	// 			return;
	// 		}

	// 		// If the db is empty
	// 		if(msg.status == 'The database has not been created yet'){
	// 			$('#filelist').html('<p>The database has not been set up yet. Clicking the button will scan your library and create a database</p><input type="button" class="button secondary small" value="Build Database" id="build_database">');
	// 			return;
	// 		}

	// 		// If you got this far the db is made and working
	// 		$('#filelist').html('<p>Your DB currently stores ' + msg.file_count + ' files</p><input type="button" class="button secondary rounded small" value="Rebuild Database" id="build_database">');
	// 	});

	// });


// 	// Build the database
// 	$('body').on('click', '#build_database', function(){
// 		$(this).prop("disabled", true);

// 		// Send out AJAX request to start building the DB
// 		$.ajax({
// 			url: "make_db.php",
// 			type: "GET",
// 		});

// 		// Append the check db button so the user can start checking right away
// 		$('#filelist').append('<input type="button" value="Check Progress" id="check_db_progress" >');
// 	});

// // Check DB build progress
// 	$('body').on('click', '#check_db_progress', function(){
// 		var request = $.ajax({
// 			url: "db_scripts/db_file_counts.php",
// 			type: "GET",
// 			dataType: "json"
// 		});

// 		request.done( function(msg){
// 			// remove a <p> tage with the id of "db_progress_report"
// 			$( "#db_progress_report" ).remove();

// 			// if file_count is 0, report that the the build script is not done counting files
// 			if(msg.file_count == 0){
// 				$('#filelist').append('<p id="db_progress_report">The create database script is still counting the files in the music collection.  This operation can take some time.  Try again in a bit</p>');
// 				return;
// 			}

// 			// Append new <p> tag with id of "db_progress_report"
// 			$('#filelist').append('<p id="db_progress_report">Progress: '+ msg.files_in_db +'/'+ msg.file_count +'</p>');
// 		});

// 	});




//////////////////////////////////////  Sort by Albums
	// Load up album explorer
	// $('#all_albums').on('click', function(){

	// 	$('.directoryTitle').hide();

	// 	var request = $.ajax({
	// 		url: "db_scripts/find_all_albums.php",
	// 		type: "GET"
	// 	});

	// 	request.done(function( msg ) {

	// 		var dirty = $.parseJSON(msg);

	// 		//clear the list
	// 		$('#filelist').empty();

	// 		//parse through the json array and make an array of corresponding divs
	// 		var albums = [];
	// 		$.each(dirty, function() {
	// 			albums.push('<div data-album="'+this.album+'" class="albumz">'+this.album+' ['+this.artist +']</div>');
	// 		});


	// 		$('#filelist').html(albums);
	// 		$('.panel_one_name').html('Albums');
	// 	});

	// 	request.fail(function( jqXHR, textStatus ) {
	// 		alert( "Request failed: " + textStatus );
	// 	});

	// });


	// // Load up album-songs
	// $("#filelist").on('click', '.albumz', function() {

	// 	var album = $(this).data('album');


	// 	// $('.directoryTitle').hide();

	// 	var request = $.ajax({
	// 		url: "db_scripts/find_all_albums-songs.php",
	// 		type: "POST",
	// 		data: { album : album },
	// 		// dataType: "html"
	// 	});

	// 	request.done(function( msg ) {

	// 		var dirty = $.parseJSON(msg);
	// 		console.log(dirty);


	// 		//clear the list
	// 		$('#filelist').empty();


	// 		//parse through the json array and make an array of corresponding divs
	// 		var filelist = [];
	// 		$.each(dirty, function() {
	// 			if(this.title==null){
	// 				filelist.push('<div data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">[MISSING TITLE]</span></div>');
	// 			}
	// 			else{
	// 				filelist.push('<div data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.title+'</span></div>');
	// 			}

	// 		});



	// 		$('#filelist').html(filelist);

	// 	});

	// 	request.fail(function( jqXHR, textStatus ) {
	// 		alert( "Request failed: " + textStatus );
	// 	});

	// });



///////////////////////////////////////// Artists
// // Load up album-songs
	// $("#filelist").on('click', '.artistz', function() {

	// 	var artist = $(this).data('artist');


	// 	// $('.directoryTitle').hide();

	// 	var request = $.ajax({
	// 		url: "db_scripts/find_all_artists-songs.php",
	// 		type: "POST",
	// 		data: { artist : artist },
	// 		// dataType: "html"
	// 	});

	// 	request.done(function( msg ) {

	// 		var dirty = $.parseJSON(msg);
	// 		console.log(dirty);


	// 		//clear the list
	// 		$('#filelist').empty();


	// 		//parse through the json array and make an array of corresponding divs
	// 		var filelist = [];
	// 		$.each(dirty, function() {
	// 			if(this.title==null){
	// 				filelist.push('<div data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">[MISSING TITLE]</span></div>');
	// 			}
	// 			else{
	// 				filelist.push('<div data-file_location="'+this.file_location+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.title+'</span></div>');
	// 			}
	// 		});


	// 		$('#filelist').html(filelist);
	// 	});

	// 	request.fail(function( jqXHR, textStatus ) {
	// 		alert( "Request failed: " + textStatus );
	// 	});

	// });


/////////////////////////////////////// Downloading Features

// Download Directory
// Downloads uses hidden iframe
	// $("#download").click(function() {
	// 	var dirz = encodeURIComponent( $('#currentdir').val() );
	// 	$('#downframe').attr('src', "zipdir.php?dir="+dirz);
	// });

// Download Playlist
// Submits form to hidden iframe
	// $('#downloadPlaylist').click(function(){
	// 	// encode entire playlist data into into array
	// 		var playlistElements = $('ul#playlist li');
	// 		var playlistArray = jQuery.makeArray(playlistElements);

	// 		var n = 0;
	// 	//loop through array and add each file to the playlist
	// 	$.each( playlistArray, function() {
	// 		$('<input>').attr({
	// 				type: 'hidden',
	// 				name: n,
	// 				value: $(this).data('songurl')
	// 		}).appendTo('#downform');
	// 		n++;
	// 	});

	// 	//submit form
	// 	$('#downform').submit();
	// 	// clear the form
	// 	$('#downform').empty();

	// });