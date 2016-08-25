// /////////////////////////////   Database Management

// //  The Manage DB panel
// 	$('#manage_database').on('click', function(){
// 		// Hide the directory bar
// 		$('.directoryTitle').hide();
// 		// Change the panel name
// 		$('.panel_one_name').html('Database Management');
// 		//clear the list
// 		$('#filelist').empty();

// 		// Make an ajax request to get the current state of the db
// 		var request = $.ajax({
// 		  url: "db_scripts/check_db_status.php",
// 		  type: "GET",
// 		  dataType: "json"
// 		});

// 		request.done(function( msg ) {

// 			// If there is an error
// 			if(msg.error){
// 				$('#filelist').html('<p>The database returned the following error:</p><p>' + msg.error + '</p>');

// 				return;
// 			}

// 			// if the DB is locked
// 			if(msg.locked){
// 				//
// 				$('#filelist').html('<p>The database is currently being built</p><input type="button" value="Check Progress" class="button secondary small" id="check_db_progress" >');
// 				return;
// 			}

// 			// If the db is empty
// 			if(msg.status == 'The database has not been created yet'){
// 				$('#filelist').html('<p>The database has not been set up yet. Clicking the button will scan your library and create a database</p><input type="button" class="button secondary small" value="Build Database" id="build_database">');
// 				return;
// 			}

// 			// If you got this far the db is made and working
// 			$('#filelist').html('<p>Your DB currently stores ' + msg.file_count + ' files</p><input type="button" class="button secondary rounded small" value="Rebuild Database" id="build_database">');
// 		});

// 	});


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


