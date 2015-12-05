$(document).ready(function(){


////////////////////////////// Initialization code

	// Setup jPlayer
	var jPlayer = $("#jquery_jplayer_1").jPlayer({
		ready: function () {
			// NOTHING!
		},
		swfPath: "jPlayer/jquery.jplayer/Jplayer.swf",
		supplied: "mp3",
		smoothPlayBar: true,
		keyEnabled: true,
		// audioFullScreen: true
	});

	// Setup the starting directory
	// this code sets up the file browser.  It runs once when the page loads and is never used again
	var startdir = '';
	// $.get("startdir", function(result){
		//startdir = result;

		//set a hidden input to the curent directory values
		$('#currentdir').val(startdir);
		//send this directory to be parsed and displayed
		senddir(startdir);

		$('.directoryName').html('/');

		$('#search_container').hide();

		$('.panel_one_name').html('File Explorer');

	// });


///////////////////////////////   Search Function
	// Setup the search interface
	$('#search_database').on('click', function(){
		$('.directoryTitle').hide();
		$('#search_container').show();

		$('#filelist').html('');

		$('.panel_one_name').html('Search');
	});

	// Auto Search
	$('#search_it').on('keyup', function(){
		if($(this).val().length>1){
			console.log('32');

			var request = $.ajax({
			  url: "db_scripts/search_db.php",
			  type: "POST",
			  data: { search : $(this).val() },
			  dataType: "html"
			});

			request.done(function( msg ) {
			  $("#filelist").html( msg );

			});

			request.fail(function( jqXHR, textStatus ) {
			  // alert( "Request failed: " + textStatus );
			});
		}
	});

/////////////////////////////   The Now Playing Column

	// Core playlist functionality.  When a song ends, go to the next song
	$("#jquery_jplayer_1").bind($.jPlayer.event.ended, function(event) { // Add a listener to report the time play began

  		// Should disable any features that can cause the playlist to change
  		// This will prevent some edge case logic errors

  		// Check for playlist item with label "current song"
  		if($('#playlist').find('li.current').length!=0){
  			var current = $('#playlist').find('li.current');

  			// if there is a next item on the list
  			if($('#playlist').find('li.current').next('li').length!=0){
  				var next = $('#playlist').find('li.current').next('li');
  				// get the url in that item
  				var song = next.data('songurl');
  				// Add label of "current song" to this item
					current.toggleClass('current');
  				next.toggleClass('current');


  				// Add that URL to jPlayer
  				$(this).jPlayer("setMedia", {
						mp3: song,
					});
					$(this).jPlayer("play");
  			}

  		}
		// If there is no current song but the playlist is not empty
		else if($('#playlist').find('li.current').length == 0 && $('#playlist li').length != 0){
			// Then select the first song and play that
			var first_on_playlist = $('ul#playlist li:first');
			first_on_playlist.toggleClass('current');

			var song = first_on_playlist.data('songurl');

			$(this).jPlayer("setMedia", {
				mp3: song,
			});
			$(this).jPlayer("play");
		}
	});


	// When an item in the playlist is clicked, start playing that song
	$('#playlist').on( 'click', 'li span', function() {
		var mp3 = $(this).parent().data('songurl');

		$('#playlist li').removeClass('current');
		$(this).parent().addClass('current');
		// Add that URL to jPlayer
		$('#jquery_jplayer_1').jPlayer("setMedia", {
			mp3: mp3,
		});
		$('#jquery_jplayer_1').jPlayer("play");
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



// Adds file to the now playing playlist
// There is no longer addfile1
	function addFile2(that){
		var filename = $(that).attr("id");
		var file_location = 'audiofiles/' + $(that).data("file_location");

		var title = $(that).find('span.title').html();
		// var directory=$('#currentdir').val();

		// The current var gets added to the class of the new playlist item
		var current = '';

		// this checks if jplayer is playing something
		// console.log($("#jquery_jplayer_1").data().jPlayer.status.paused);

		// if the playlist is empty and no media is currently playing
		if ($('#playlist li').length == 0 && $("#jquery_jplayer_1").data().jPlayer.status.paused == true){
			// Set this playlist item as the current one and que it in jplayer
			current = ' current';
			$('#jquery_jplayer_1').jPlayer("setMedia", {
				mp3: file_location,
			});
			// $('#jquery_jplayer_1').jPlayer("play");
		}


		$('ul#playlist').append(
			$('<li/>', {
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

// Load up the file explorer
	$('#file_explorer').on('click', function(){
		//set a hidden input to the curent directory values
		$('#currentdir').val(startdir);
		//send this directory to be parsed and displayed
		senddir(startdir);

		$('.directoryName').html('/');

		$('.directoryTitle').hide();
		$('#directory_bar').show();

		$('.panel_one_name').html('File Explorer');

	});

// when you click on a directory, go to that directory
	$("#filelist").on('click', 'div.dirz', function() {
		//get the html of that class
		var adddir = $(this).attr("id");
		var curdir = $('#currentdir').val();
		var location = curdir+adddir+'/';

		//update the hidden fileds with the new location
		$('#currentdir').val(location);
		$('.directoryName').html('/' + location.replace(startdir, ''));


		//pass this value along
		senddir(location);
	});

// when you click the back directory
	$(".backButton").on('click', function() {
		if($('#currentdir').val() != startdir){
			//get the html of that class
			var curdirshort=$('#currentdir').val();
			var location = curdirshort+'../';

			//break apart the directory into an array of strings.  This will be used to chop off the last directory
			var arrayOfStrings = curdirshort.split('/');

			var builddir='';

			//loop through an construct new currentDirectory variables
			for (var i=0; i < arrayOfStrings.length-2; i++){
				builddir=builddir+arrayOfStrings[i]+'/';
			}

			$('#currentdir').val(builddir);
			$('.directoryName').html('/' + builddir.replace(startdir, ''));


			senddir(location);
		}
	});




// send a new directory to be parsed.
	function senddir(dir){
		// If the scraper option is checked, then tell dirparer to use getID3
		var scrape = $('#scraper').is(":checked");
		$.post('dirparser', {dir: dir, scrape: scrape}, function(response) {
				// hand this data off to be printed on the page
				printdir(response);
		});
	}

// function that will recieve JSON from dirparser.php.  It will then make a list of the directory and tack on classes for functionality
	function printdir(dir){
		var dirty = $.parseJSON(dir);

		//clear the list
		$('#filelist').empty();

		//parse through the json array and make an array of corresponding divs
		var filelist = [];
		$.each(dirty, function() {
			if(this.type=='mp3'){
				if(this.artist!=null || this.title!=null){
					filelist.push('<div data-file_location="'+this.link+'" class="filez"><span class="pre-char">&#9836;</span> <span class="title">'+this.artist+' - '+this.title+'</span></div>');
				}
				else{
					filelist.push('<div data-file_location="'+this.link+'" class="filez"><span class="pre-char">&#9835;</span> <span class="title">'+this.filename+'</span></div>');
				}
			}
			if(this.type=='dir'){
				filelist.push('<div id="'+this.link+'" class="dirz">'+this.link+'</div>');
			}
		});

		//add a listing to go back
		if($('#currentdir').val() != startdir){
			// filelist.push('<div id=".." class="back">..</div>');
			$('.backButton').prop('disabled', false);
		}else{
			$('.backButton').prop('disabled', true);
		}

		$('#filelist').html(filelist);
	}




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
			console.log('do not do that');
			return false;
		}

		//loop through array and add each file to the playlist
		$.each( playlistArray, function() {

			stuff.push($(this).data('songurl'));

		});


		$.ajax({
			type: "POST",
			url: "savem3u.php",
			data: {
				title:title,
				stuff:stuff
			},
		})
			.done(function( msg ) {

				if(msg==1){
				}
				if(msg==0){

					// $('#playlist_list').append('<li><a data-filename="' + title + '.m3u">' + title + '</a></li>')
				}
				$('#save_playlist').prop("disabled",false);

				$('#close_save_playlist').trigger("click");
			});


	});



// Get all playlists
	$('#all_playlists').on('click', function(){

		// Hide the directory bar
		$('.directoryTitle').hide();
		// Change the panel name
		$('.panel_one_name').html('Playlists');
		//clear the list
		$('#filelist').empty();

		var request = $.ajax({
			url: "playlists/get_playlists.php",
			type: "GET"
		});

		request.done(function( msg ) {

			var dirty = $.parseJSON(msg);

			//parse through the json array and make an array of corresponding divs
			var playlists = [];
			$.each(dirty, function() {
				playlists.push('<div data-filename="'+this.file+'" class="playlistz">'+this.file+'</div>');
			});

			// Ad playlists to the left panel
			$('#filelist').html(playlists);

		});

		request.fail(function( jqXHR, textStatus ) {
			// alert( "Request failed: " + textStatus );

			$('#filelist').html('<p>Something went wrong</p>');
		});

	});




// load up a playlist
$("#filelist").on('click', '.playlistz', function() {
	var filename = $(this).data('filename');
		var name = $(this).html();

	// Make an AJAX call to get the contents of the playlist
	$.ajax({
		type: "POST",
		url: "playlists/playlist_parser.php",
		data: {filename: filename},
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
						'data-songurl': item.file,
							'class': 'dragable',
							html: '<span class="play1">'+item.name+'</span><a href="javascript:void(0)" class="closeit">X</a>'
				}));
		});


		$('#playlist').sortable();
		});
	});


});
