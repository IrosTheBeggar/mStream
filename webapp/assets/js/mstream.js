////////////////////////////// Global Variables
// These vars track your position within the file explorer
var fileExplorerArray = [];
// Stores an array of searchable objects
var currentBrowsingList = [];
// This variable tracks the state of the explorer column
var programState = [];

const entityMap = {
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

function renderDirHtml(name) {
  return `<div class="clear relative">
    <div data-directory="${name}" class="dirz" onclick="handleDirClick(this);">
      <svg class="folder-image" viewBox="0 0 48 48" version="1.0" xmlns="http://www.w3.org/2000/svg"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
      <span class="item-text">${name}</span>
    </div>
    <div class="song-button-box">
      <span title="Add All To Queue" class="recursiveAddDir" data-directory="${name}">
        <svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>
      </span>
      <span data-directory="${name}" title="Download Directory" class="downloadDir">
        <svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>
      </span>
    </div>
  </div>`
}

function createFileplaylistHtml(dataDirectory) {
  return '\
    <div class="clear relative">\
      <div data-directory="' + dataDirectory + '" class="fileplaylistz">\
        <svg class="fileplaylist-image" xmlns="http://www.w3.org/2000/svg" viewBox="24 0 303.188 303.188"><path fill="#e8e8e8" d="M219.821 0H32.842v303.188h237.504V50.525z"/><g fill="#333"><path d="M99.324 273.871l-9.813-34.557h-.295c.459 5.885.689 10.458.689 13.717v20.84H78.419v-47.979h17.262l10.009 34.065h.263l9.813-34.065h17.295v47.979h-11.913v-21.036c0-1.094.017-2.308.049-3.643.033-1.335.181-4.605.443-9.813h-.295l-9.681 34.491h-12.34v.001zM173.426 236.295c0 2.976-.908 5.529-2.724 7.663-1.816 2.133-4.441 3.681-7.876 4.644v.197c8.008 1.006 12.011 4.791 12.011 11.354 0 4.464-1.767 7.975-5.3 10.534-3.533 2.56-8.439 3.84-14.719 3.84-2.582 0-4.972-.186-7.171-.558-2.198-.372-4.577-1.05-7.138-2.034V261.17a28.545 28.545 0 006.416 2.379c2.177.515 4.185.771 6.023.771 2.844 0 4.917-.399 6.219-1.198 1.302-.799 1.952-2.051 1.952-3.758 0-1.313-.339-2.324-1.017-3.035-.679-.711-1.773-1.247-3.282-1.607-1.51-.361-3.479-.542-5.907-.542h-2.953v-9.747h3.018c6.586 0 9.879-1.684 9.879-5.054 0-1.269-.487-2.21-1.461-2.822s-2.28-.919-3.922-.919c-3.063 0-6.235 1.029-9.517 3.085l-5.382-8.664c2.537-1.75 5.136-2.997 7.794-3.741s5.704-1.115 9.14-1.115c4.966 0 8.86.984 11.683 2.953 2.823 1.969 4.234 4.682 4.234 8.139zM223.571 225.892v28.88c0 6.279-1.778 11.141-5.333 14.588-3.556 3.445-8.681 5.168-15.375 5.168-6.542 0-11.568-1.674-15.08-5.022-3.511-3.347-5.267-8.16-5.267-14.439v-29.175h13.028v28.157c0 3.393.635 5.854 1.903 7.385s3.14 2.297 5.612 2.297c2.647 0 4.566-.76 5.759-2.281 1.192-1.52 1.789-4.008 1.789-7.465v-28.093h12.964z"/></g><path fill="#004a94" d="M227.64 25.263H32.842V0h186.979z"/><path fill="#d1d3d3" d="M219.821 50.525h50.525L219.821 0z"/><circle cx="150.304" cy="122.143" r="59.401" fill="#004a94"/><path d="M130.903 91.176v47.938c-1.681-.198-3.551-.154-5.529.195-7.212 1.271-13.057 5.968-13.057 10.49s5.845 7.157 13.057 5.886c7.211-1.271 13.056-5.968 13.056-10.49v-38.703l32.749-5.775v31.295c-1.68-.199-3.549-.153-5.529.196-7.213 1.271-13.057 5.968-13.057 10.49 0 4.523 5.844 7.157 13.057 5.886 7.21-1.271 13.056-5.968 13.056-10.49V82.748l-47.803 8.428z" fill="#fff"/></svg>\
        <span class="item-text">' + dataDirectory + '</span>\
      </div>\
      <div class="song-button-box">\
        <span title="Add All To Queue" class="addFileplaylist" data-directory="' + dataDirectory + '">\
          <svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>\
        </span>\
        <span data-directory="' + dataDirectory + '" title="Download Playlist" class="downloadFileplaylist">\
          <svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>\
        </span>\
      </div>\
    </div>';
}

function createMusicfileHtml(fileLocation, title, titleClass) {
  return `<div data-file_location="${fileLocation}" class="filez">
      <svg class="music-image" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>
      <span class="${titleClass}">${title}</span>
    </div>`;
}

function getLoadingSvg() {
  return '<svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>';
}

function boilerplateFailure(res, err) {
  let msg = 'Call Failed';
  if (err.responseJSON && err.responseJSON.error) {
    msg = err.responseJSON.error;
  }

  iziToast.error({
    title: msg,
    position: 'topCenter',
    timeout: 3500
  });
}

// Handle panel stuff
function resetPanel(panelName, className) {
  document.getElementById('filelist').innerHTML = '';
  document.getElementById('directory_bar').style.display = '';

  document.getElementById("search_folders").value = "";
  document.getElementById('directoryName').innerHTML = '';

  document.getElementById('filelist').classList.remove('scrollBoxHeight1');
  document.getElementById('filelist').classList.remove('scrollBoxHeight2');

  document.getElementById('filelist').classList.add(className); // if you remove this semicolon mark, it will throw an error!
  ([...document.getElementsByClassName('panel_one_name')]).forEach(el => {
    el.innerHTML = panelName;
  });
}

function setBrowserRootPanel(selectedEl, panelText, scrollHeight) {
  if (selectedEl) {
    ([...document.querySelectorAll('ul.left-nav-menu li')]).forEach(el => {
      el.classList.remove('selected');
    });
    selectedEl.classList.add('selected');
  }
  resetPanel(panelText, scrollHeight);
  currentBrowsingList = [];
}


///////////////// File Explorer
function loadFileExplorer(el) {
  setBrowserRootPanel(el, 'File Explorer', 'scrollBoxHeight1');
  programState = [{ state: 'fileExplorer' }];

  // Reset file explorer vars
  fileExplorerArray = [];

  if (MSTREAMAPI.currentServer.vpaths && MSTREAMAPI.currentServer.vpaths.length === 1) {
    fileExplorerArray.push(MSTREAMAPI.currentServer.vpaths[0]);
    programState.push({
      state: 'fileExplorer',
      previousScroll: 0,
      previousSearch: ''
    });
  }

  //send this directory to be parsed and displayed
  senddir();
}

function senddir(previousState) {
  // Construct the directory string
  const directoryString = getFileExplorerPath();

  let displayString = directoryString;
  if (displayString.substring(0, 1) !== '/') {
    displayString = '/' + displayString;
  }

  document.getElementById('directoryName').innerHTML = displayString;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  MSTREAMAPI.dirparser(directoryString, function (response, error) {
    if (error !== false) {
      boilerplateFailure(response, error);
      return;
    }

    // Set any directory views
    // hand this data off to be printed on the page
    printdir(response, previousState);
  });
}

// function that will receive JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
function printdir(response, previousState) {
  currentBrowsingList = [];
  let filelist = '';

  // Some APIs only return a list of files
  if (response.directories) {
    for (const dir of response.directories) {
      currentBrowsingList.push({ type: 'directory', name: dir.name })
      filelist += renderDirHtml(dir.name);
    }
  }

  for (const file of response.files) {
    currentBrowsingList.push({ type: file.type, name: file.name })
    if (file.type === 'm3u') {
      filelist += createFileplaylistHtml(file.name);
    } else {
      const title = file.artist != null || file.title != null ? file.artist + ' - ' + file.title : file.name;
      filelist += createMusicfileHtml(file.path || response.path + file.name, title, "item-text");
    }
  }

  // clear the list
  document.getElementById('search_folders').value = '';

  // Post the html to the filelist div
  document.getElementById('filelist').innerHTML = filelist;

  if (previousState && previousState.previousScroll) {
    document.getElementById('filelist').scrollTop(previousState.previousScroll);
  }

  if (previousState && previousState.previousSearch) {
    document.getElementById('search_folders').value = previousState.previousSearch;
    document.getElementById('search_folders').dispatchEvent(new Event('change'));
  }
}

function getFileExplorerPath() {
  return fileExplorerArray.join("/") + "/";
}

function getDirectoryString(component) {
  var newString = getFileExplorerPath() + component.data("directory");
  if (newString.substring(0,1) !== '/') {
    newString = "/" + newString
  }

  return newString;
}

function addAllSongs(res) {
  for (var i = 0; i < res.length; i++) {
    MSTREAMAPI.addSongWizard(res[i], {}, true);
  }
}


function handleDirClick(el){
  fileExplorerArray.push(el.getAttribute('directory'));    
  programState.push({
    state: 'fileExplorer',
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('search_folders').value
  });
  senddir();
}

/////////////// Artists
function getAllArtists(previousState, el) {
  setBrowserRootPanel(el, 'Artists', 'scrollBoxHeight1');
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  programState = [{
    state: 'allArtists'
  }];

  MSTREAMAPI.artists(function (response, error) {
    if (error !== false) {
      document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
      return boilerplateFailure(response, error);
    }

    // parse through the json array and make an array of corresponding divs
    let artists = '';
    response.artists.forEach(value => {
      artists += '<div data-artist="' + value + '" class="artistz" onclick="getArtistz(this)">' + value + ' </div>';
      currentBrowsingList.push({ type: 'artist', name: value });
    });

    document.getElementById('filelist').innerHTML = artists;

    if (previousState && previousState.previousSearch) {
      document.getElementById('search_folders').value = previousState.previousSearch;
      document.getElementById('search_folders').dispatchEvent(new Event('change'));
    }

    if (previousState && previousState.previousScroll) {
      document.getElementById('filelist').scrollTop = previousState.previousScroll;
    }
  });
}

function getArtistz(el) {
  const artist = el.getAttribute('data-artist');
  programState.push({
    state: 'artist',
    name: artist,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('search_folders').value
  });

  getArtistsAlbums(artist)
}

function getArtistsAlbums(artist, previousState) {
  setBrowserRootPanel(false, 'Albums', 'scrollBoxHeight1');
  document.getElementById('directoryName').innerHTML = 'Artist: ' + artist;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  MSTREAMAPI.artistAlbums(artist, (response, error) => {
    if (error !== false) {
      document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
      return boilerplateFailure(response, error);
    }

    const albums = [];
    response.albums.forEach(value => {
      const albumString = value.name ? value.name : 'SINGLES';
      albums.push(`<div data-artist="${artist}" data-album="${value.name}" class="albumz">
          <img class="album-art-box" 
            ${value.album_art_file ? `data-original="album-art/${value.album_art_file}?token=${MSTREAMAPI.currentServer.token}"`: 'src="assets/img/default.png"'}
          >
          <span class="explorer-label-1">${albumString}</span>
        </div>`);

      currentBrowsingList.push({ type: 'album', name: value.name, artist: artist, album_art_file: value.album_art_file })
    });

    document.getElementById('filelist').innerHTML = albums;

    if (previousState && previousState.previousSearch) {
      document.getElementById('search_folders').value = previousState.previousSearch;
      document.getElementById('search_folders').dispatchEvent(new Event('change'));
    }

    if (previousState && previousState.previousScroll) {
      document.getElementById('filelist').scrollTop = previousState.previousScroll;
    }

    // update lazy load plugin
    ll.update();
  });
}

////////////// Rated Songs
function getRatedSongs(el) {
  setBrowserRootPanel(el, 'Starred', 'scrollBoxHeight1');
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  programState = [{
    state: 'allRated'
  }];

  MSTREAMAPI.getRated((response, error) => {
    if (error !== false) {
      document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
      return boilerplateFailure(response, error);
    }

    //parse through the json array and make an array of corresponding divs
    const files = [];
    response.forEach(value => {
      let rating = (value.metadata.rating / 2);
      if (!Number.isInteger(rating)) {
        rating = rating.toFixed(1);
      }

      currentBrowsingList.push({
        type: 'file',
        name: value.metadata.artist ? value.metadata.artist + ' - ' + value.metadata.title : value.filepath,
        metadata: value.metadata
      });

      files.push(`<div data-file_location="${value.filepath}" class="filez">
          <img class="album-art-box" 
            ${value.metadata['album-art'] ? `data-original="album-art/${value.metadata['album-art']}?token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"` }
          >
          <span class="explorer-label-1">[${rating}] ${value.metadata.artist ? `${value.metadata.artist} - ${value.metadata.title}` : value.filepath}</span>
        </div>`);
    });

    document.getElementById('filelist').innerHTML = files;
    ll.update();
  });
}

////////////// Jukebox
function setupJukeboxPanel(el) {
  setBrowserRootPanel(el, 'Jukebox Mode', 'scrollBoxHeight2');
  document.getElementById('directory_bar').style.display = 'none';

  let newHtml;
  if (JUKEBOX.stats.live !== false && JUKEBOX.connection !== false) {
    newHtml = createJukeboxPanel();
  } else {
    newHtml = `
      <p class="jukebox-panel">
        <br><br>
        <h3>Jukebox Mode allows you to control this page remotely<h3>
        <br><br>
        <input value="Connect" type="button" onclick="connectToJukeBox(this)">
      </p>`;
  }

  // Add the content
  document.getElementById('filelist').innerHTML = newHtml;
}

function createJukeboxPanel() {
  if (JUKEBOX.stats.error !== false) {
    return '<div class="jukebox-panel">An error occurred.  Please refresh the page and try again</div>';
  }

  const address = `${window.location.protocol}//${window.location.host}/remote/${JUKEBOX.stats.adminCode}`;
  return `<div class="jukebox-panel autoselect">
    <h1>Code: ${JUKEBOX.stats.adminCode}</h1>
    <br><h2><a target="_blank" href="${address}">${address}</a><h2>
    ${qrcodegen.QrCode.encodeText(address, qrcodegen.QrCode.Ecc.MEDIUM).toSvgString(2)}
    </div>`;
}

function connectToJukeBox(el) {
  el.disabled = true;
  el.style.display = 'none';

  document.getElementById('filelist').innerHTML += getLoadingSvg();

  JUKEBOX.createWebsocket(MSTREAMAPI.currentServer.token, false, () => {
    setupJukeboxPanel();
  });
}

///////////////// Auto DJ
function autoDjPanel(el) {
  setBrowserRootPanel(el, 'Auto DJ', 'scrollBoxHeight2');
  document.getElementById('directory_bar').style.display = 'none';

  let newHtml = '<br><p>Auto DJ randomly generates a playlist.  Click the \'DJ\' button on the bottom enable it</p><h3>Use Folders</h3><p>';
  for (let i = 0; i < MSTREAMAPI.currentServer.vpaths.length; i++) {
    let checkedString = '';
    if (!MSTREAMPLAYER.ignoreVPaths[MSTREAMAPI.currentServer.vpaths[i]]) {
      checkedString = 'checked';
    }
    newHtml += `<input ${checkedString} id="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}" type="checkbox" value="${MSTREAMAPI.currentServer.vpaths[i]}" name="autodj-folders">
      <label for="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}">${MSTREAMAPI.currentServer.vpaths[i]}</label><br>`;
  }

  newHtml += '</p><h3>Minimum Rating</h3>  <select id="autodj-ratings">';
  for (let i = 0; i < 11; i++) {
    newHtml += `<option ${(Number(MSTREAMPLAYER.minRating) === i) ? 'selected' : ''} value="${i}">${(i ===0) ? 'Disabled' : +(i/2).toFixed(1)}</option>`;
  }
  newHtml += '</select>';
  
  document.getElementById('filelist').innerHTML = newHtml;
}

///////////////// Transcode
function setupTranscodePanel(el){
  setBrowserRootPanel(el, 'Transcode', 'scrollBoxHeight2');
  document.getElementById('directory_bar').style.display = 'none';

  let newHtml = `<p><b>Transcoding is Experimental</b></p>
    <p>The song position and seeking does not work.  Also it might not work in every browser. Report and bugs to the
    <a target=\"_blank\"  href=\"https://github.com/IrosTheBeggar/mStream/issues/213\">ongoing github issue</a></p>`;

  if (!MSTREAMAPI.transcodeOptions.serverEnabled) {
    newHtml += '<p>Transcoding is disabled on this server</p>';
    document.getElementById('filelist').innerHTML = newHtml;
    return;
  }

  newHtml += `<p>Default Bitrate: ${MSTREAMAPI.transcodeOptions.bitrate}</p>
    <p>Default Codec: ${MSTREAMAPI.transcodeOptions.codec}</p>`;

  if (MSTREAMAPI.transcodeOptions.frontendEnabled) {
    newHtml += '<p><input id="enable_transcoding_locally" type="checkbox" name="transcode" checked><label for="enable_transcoding_locally">Enable Transcoding</label></p>';
  } else {
    newHtml += '<p><input id="enable_transcoding_locally" type="checkbox" value="transcode"><label for="enable_transcoding_locally">Enable Transcoding</label></p>';
  }

  document.getElementById('filelist').innerHTML = newHtml;
}

/////////////////////////////   Mobile Stuff
function getMobilePanel(el){
  setBrowserRootPanel(el, 'Mobile Apps', 'scrollBoxHeight2');
  document.getElementById('directory_bar').style.display = 'none';

  document.getElementById('filelist').innerHTML = 
    `<div class='mobile-links'>
      <a target='_blank' href='https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1'><img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png'/></a>
      <div class='mobile-placeholder'>&nbsp;</div>
    </div>
    <div class='app-text'>
      <a target='_blank' href='/qr'>Checkout the QR Code tool to help add your server to the app</a>
    </div>`;
}

/////////////////////// Back Button
function onBackButton() {
  if (programState.length < 2) {
    return;
  }

  const thisState = programState.pop();
  const backState = programState[programState.length - 1];

  if (backState.state === 'allPlaylists') {
    getAllPlaylists(thisState);
  } else if (backState.state === 'allAlbums') {
    getAllAlbums(thisState);
  } else if (backState.state === 'allArtists') {
    getAllArtists(thisState);
  } else if (backState.state === 'artist') {
    getArtistsAlbums(backState.name, thisState);
  } else if (backState.state === 'fileExplorer') {
    fileExplorerArray.pop();
    senddir(thisState);
  } else if (backState.state === 'searchPanel') {
    setupSearchPanel(backState.searchTerm);
  }
}

// Responsive active content
function activePanel1() {
  document.getElementById('activate-panel-1').classList.add('active');
  document.getElementById('activate-panel-2').classList.remove('active');

  document.getElementById('panel1').classList.add('active');
  document.getElementById('panel2').classList.remove('active');
}

function activePanel2() {
  document.getElementById('activate-panel-2').classList.add('active');
  document.getElementById('activate-panel-1').classList.remove('active');

  document.getElementById('panel2').classList.add('active');
  document.getElementById('panel1').classList.remove('active');
}

function toggleMenu() {
  document.getElementById('responsive-left-nav').classList.toggle('hide-on-small');
}

function openShareModal() {
  $('#sharePlaylist').iziModal('open');
}

function openSaveModal() {
  $('#savePlaylist').iziModal('open');
}

function openPlaybackModal() {
  $('#speedModal').iziModal('open');
}

function logout(){
  localStorage.removeItem('token');
  Cookies.remove('x-access-token');
  MSTREAMAPI.updateCurrentServer("", "", "");
  window.location.replace(`login`);
}

$(document).ready(function () {
  // Modals
  $("#sharePlaylist").iziModal({
    title: 'Share Playlist',
    headerColor: '#5a5a6a',
    focusInput: false,
    padding: 15
  });
  $('#savePlaylist').iziModal({
    title: 'Save Playlist',
    headerColor: '#5a5a6a',
    focusInput: false,
    width: 475
  });
  $('#speedModal').iziModal({
    title: 'Playback',
    headerColor: '#5a5a6a',
    width: 475,
    focusInput: false,
    padding: 15,
    afterRender: function() {
      new Vue({
        el: '#speed-bar',
        data: {
          curSpeed: 1
        },
        watch: {
          curSpeed: function () {
            MSTREAMPLAYER.changePlaybackRate(this.curSpeed);
          }
        },
      });
    }
  });

  $('#savePlaylist').iziModal('setTop', '12%');
  $('#sharePlaylist').iziModal('setTop', '12%');
  $('#speedModal').iziModal('setTop', '12%');

  // Dropzone
  const myDropzone = new Dropzone(document.body, {
    previewsContainer: false,
    clickable: false,
    url: '/api/v1/file-explorer/upload',
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
      if (file.fullPath) {
        file.directory = getFileExplorerPath() + file.fullPath.substring(0, file.fullPath.indexOf(file.name));
      } else {
        file.directory = getFileExplorerPath();
      }
    }
  });

  myDropzone.on('sending', function (file, xhr, formData) {
    xhr.setRequestHeader('data-location', encodeURI(file.directory))
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
        senddir();
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
        senddir();
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

  // Setup scrobbling
  MSTREAMPLAYER.scrobble = function () {
    if (MSTREAMPLAYER.playerStats.metadata.artist && MSTREAMPLAYER.playerStats.metadata.title) {
      MSTREAMAPI.scrobbleByMetadata(MSTREAMPLAYER.playerStats.metadata.artist, MSTREAMPLAYER.playerStats.metadata.album, MSTREAMPLAYER.playerStats.metadata.title, function (response, error) {

      });
    }
  }

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
        window.location.replace(`login`);
        return;
      }

      // set vPath
      MSTREAMAPI.currentServer.vpaths = response.vpaths;

      VUEPLAYER.playlists.length = 0;
      $.each(response.playlists, function () {
        VUEPLAYER.playlists.push(this);
      });

      if (response.transcode) {
        MSTREAMAPI.transcodeOptions.serverEnabled = true;
        MSTREAMAPI.transcodeOptions.codec = response.transcode.defaultCodec;
        MSTREAMAPI.transcodeOptions.bitrate = response.transcode.defaultBitrate;
      }

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

  ////////////////////////////////   Administrative stuff
  // when you click an mp3, add it to now playing
  $("#filelist").on('click', 'div.filez', function () {
    MSTREAMAPI.addSongWizard($(this).data("file_location"), {}, true);
  });

  /////////////////////////////////////// File Explorer
  // when you click on a playlist, go to that playlist
  $("#filelist").on('click', 'div.fileplaylistz', function () {
    fileExplorerArray.push($(this).data("directory"));
    programState.push({
      state: 'fileExplorer',
      previousScroll: document.getElementById('filelist').scrollTop,
      previousSearch: $('#search_folders').val()
    });
    var directoryString = getFileExplorerPath();

    $('.directoryName').html('/' + directoryString.substring(0, directoryString.length - 1));
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');

    MSTREAMAPI.loadFileplaylist(directoryString, function (response, error) {
      if (error !== false) {
        boilerplateFailure(response, error);
        return;
      }

      printdir(response);
    });
  });

  // when you click 'add directory', add entire directory to the playlist
  $("#addall").on('click', function () {
    //make an array of all the mp3 files in the current directory
    var elems = document.getElementsByClassName('filez');
    var arr = jQuery.makeArray(elems);

    //loop through array and add each file to the playlist
    $.each(arr, function () {
      MSTREAMAPI.addSongWizard($(this).data("file_location"), {}, true);
    });
  });


  // Search Files
  $('#search_folders').on('change keyup', function () {
    var searchVal = $(this).val();

    // Do nothing if we are in the search panel
    if (document.getElementById('db-search')) {
      return;
    }

    var filelist = [];
    // This causes an error in the playlist display
    $.each(currentBrowsingList, function () {
      var lowerCase = this.name !== null ? this.name.toLowerCase() : 'null';

      if (lowerCase.indexOf(searchVal.toLowerCase()) !== -1) {
        if (this.type === 'directory') {
          filelist.push(renderDirHtml(this.name));
        } else if (this.type === 'playlist') {
          filelist.push('<div data-playlistname="' + encodeURIComponent(this.name) + '" class="playlist_row_container"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="playlistz force-width">' + escapeHtml(this.name) + '</span><div class="song-button-box"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="deletePlaylist">Delete</span></div></div>');
        } else if (this.type === 'album') {
          var artistString = this.artist ? 'data-artist="' + this.artist + '"' : '';
          var albumString = this.name  ? this.name  : 'SINGLES';

          if (this.album_art_file) {
            filelist.push('<div ' + artistString + ' data-album="' + this.name + '" class="albumz"><img class="album-art-box"  data-original="album-art/' + this.album_art_file + '?token=' + MSTREAMAPI.currentServer.token + '"><span class="explorer-label-1">' + albumString + '</span></div>');
          } else {
            filelist.push('<div ' + artistString + ' data-album="' + this.name + '" class="albumz"><img class="album-art-box" src="assets/img/default.png"><span class="explorer-label-1">' + albumString + '</span></div>');
          }
        } else if (this.type === 'artist') {
          filelist.push('<div data-artist="' + this.name + '" class="artistz">' + this.name + ' </div>');
        } else {
          if (programState[programState.length - 1].state === 'playlist') {
            filelist.push(renderFileWithMetadataHtml(this.filepath, this.lokiId, this.metadata));
          } else if (this.type == "m3u") {
            filelist.push(createFileplaylistHtml(this.name));
          } else {
            const fileLocation = this.path || getFileExplorerPath() + this.name;
            const title = this.artist != null || this.title != null ? this.artist + ' - ' + this.title : this.name;
            filelist.push(createMusicfileHtml(fileLocation, title, "title"));
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
    $('.directoryName').toggleClass('super-hide');

    if (!$('#search_folders').hasClass('hide')) {
      $("#search_folders").focus();
    } else {
      $('#search_folders').val('');
      $("#search_folders").change();
    }
  });

  $("#filelist").on('click', '.recursiveAddDir', function () {
    var directoryString = getDirectoryString($(this));
    MSTREAMAPI.recursiveScan(directoryString, function(res, err) {
      if (err !== false) {
        return boilerplateFailure(res, err);        
      }
      addAllSongs(res);
    });
  });

  $("#filelist").on('click', '.addFileplaylist', function () {
    var playlistPath = getDirectoryString($(this));
    MSTREAMAPI.loadFileplaylist(playlistPath, function(res, err){
      if (err !== false) {
        return boilerplateFailure(res, err);        
      }

      const translatedList = [];
      res.files.forEach(f => {
        translatedList.push(f.path)
      })

      addAllSongs(translatedList);
    });
  });

  $("#filelist").on('click', '.downloadDir', function () {
    var directoryString = getDirectoryString($(this));

    // Use key if necessary
    $("#downform").attr("action", "/api/v1/download/directory?token=" + MSTREAMAPI.currentServer.token);

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

  $("#filelist").on('click', '.downloadFileplaylist', function () {
    var playlistPath = getDirectoryString($(this));

    // Use key if necessary
    $("#downform").attr("action", "/fileplaylist/download?token=" + MSTREAMAPI.currentServer.token);

    $('<input>').attr({
      type: 'hidden',
      name: 'path',
      value: playlistPath,
    }).appendTo('#downform');

    //submit form
    $('#downform').submit();
    // clear the form
    $('#downform').empty();
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
        $('#share_it').prop("disabled", false);
        return boilerplateFailure(response, error);
      }
      $('#share_it').prop("disabled", false);
      var adrs = window.location.protocol + '//' + window.location.host + '/shared/' + response.playlistId;
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
      $('#save_playlist').prop("disabled", false);

      if (error !== false) {
        return boilerplateFailure(response, error);
      }
      $('#savePlaylist').iziModal('close');
      iziToast.success({
        title: 'Playlist Saved',
        position: 'topCenter',
        timeout: 3000
      });

      if (programState[0].state === 'allPlaylists') {
        getAllPlaylists();
      }

      VUEPLAYER.playlists.push({ name: title, type: 'playlist'});
    });
  });

  // Get all playlists
  $('.get_all_playlists').on('click', function () {
    getAllPlaylists();
  });

  function getAllPlaylists(previousState) {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_all_playlists').addClass('selected');
    resetPanel('Playlists', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState = [{
      state: 'allPlaylists'
    }];

    MSTREAMAPI.getAllPlaylists(function (response, error) {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      VUEPLAYER.playlists.length = 0;

      // loop through the json array and make an array of corresponding divs
      var playlists = [];
      $.each(response, function () {
        playlists.push('<div data-playlistname="' + encodeURIComponent(this.name) + '" class="playlist_row_container"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="playlistz force-width">' + escapeHtml(this.name) + '</span><div class="song-button-box"><span data-playlistname="' + encodeURIComponent(this.name) + '" class="deletePlaylist">Delete</span></div></div>');
        this.type = 'playlist';
        currentBrowsingList.push(this);
        VUEPLAYER.playlists.push(this);
      });
      // Add playlists to the left panel
      $('#filelist').html(playlists);

      if (previousState && previousState.previousScroll) {
        $('#filelist').scrollTop(previousState.previousScroll);
      }
  
      if (previousState && previousState.previousSearch) {
        $('#search_folders').val(previousState.previousSearch).trigger('change');
      }
    });
  }

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
    const lokiId = $(this).data('lokiid');
    MSTREAMAPI.removePlaylistSong(lokiId, function (response, error) {
      if (error !== false) {
        return boilerplateFailure(response, error);
      }

      // remove from currentBrowsingList
      currentBrowsingList = currentBrowsingList.filter(item =>{
        return item.lokiId !== lokiId
      });

      $('div[data-lokiid="' + lokiId + '"]').remove();
    });
  });

  // load up a playlist
  $("#filelist").on('click', '.playlistz', function () {
    var playlistname = decodeURIComponent($(this).data('playlistname'));
    var name = $(this).html();
    $('.directoryName').html('Playlist: ' + name);
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState.push({
      state: 'playlist',
      name: playlistname,
      previousScroll: document.getElementById('filelist').scrollTop,
      previousSearch: $('#search_folders').val()
    });
    $('#search_folders').val('');


    MSTREAMAPI.loadPlaylist(playlistname, (response, error) => {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      // Add the playlist name to the modal
      $('#playlist_name').val(name);

      const files = [];
      response.forEach(value => {
        currentBrowsingList.push({
          type: 'file',
          name: (!value.metadata || !value.metadata.title) ? value.filepath : `${value.metadata.artist} - ${value.metadata.title}`,
          metadata: value.metadata,
          filepath: value.filepath,
          lokiId: value.lokiId
        });

        files.push(renderFileWithMetadataHtml(value.filepath, value.lokiId, value.metadata));
      });

      $('#filelist').html(files);
      // update lazy load plugin
      ll.update();
    });
  });

  function renderFileWithMetadataHtml(filepath, lokiId, metadata) {
    console.log(filepath)
    return `<div data-lokiid="${lokiId}" class="clear relative">
      <div data-lokiid="${lokiId}" data-file_location="${filepath}" class="filez left">
        <img class="album-art-box" ${metadata['album-art'] ? `data-original="/album-art/${metadata['album-art']}?token=${MSTREAMAPI.currentServer.token}"` : 'src="assets/img/default.png"'}>
        <span class="explorer-label-1">${(!metadata || !metadata.title) ? filepath : `${metadata.artist} - ${metadata.title}`}</span>
      </div>
      <div class="song-button-box">
        <span data-lokiid="${lokiId}" class="removePlaylistSong">remove</span>
      </div>
    </div>`;
  }

  /////////////// Download Playlist
  $('#downloadPlaylist').click(function () {
    // Loop through array and add each file to the playlist
    var downloadFiles = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      downloadFiles.push(MSTREAMPLAYER.playlist[i].filepath);
    }

    if (downloadFiles < 1) {
      return;
    }

    // Use key if necessary
    $("#downform").attr("action", "/api/v1/download/zip?token=" + MSTREAMAPI.currentServer.token);

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

  // Recent Songs
  $('.get_recent_songs').on('click', function () {
    getRecentlyAdded();
  });

  $('#libraryColumn').on('keydown', '#recently-added-limit', function(e) {
    if(e.keyCode===13){
      $( "#recently-added-limit" ).blur();
    }
  });

  $('#libraryColumn').on('focusout', '#recently-added-limit', function() {
    redoRecentlyAdded();
  });

  function getRecentlyAdded() {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_recent_songs').addClass('selected');
    resetPanel('Recently Added', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    $('.directoryName').html('Get last &nbsp;&nbsp;<input id="recently-added-limit" class="recently-added-input" type="number" min="1" step="1" value="100">&nbsp;&nbsp; songs');

    redoRecentlyAdded();
  }

  function redoRecentlyAdded() {
    currentBrowsingList = [];

    programState = [{
      state: 'recentlyAdded'
    }];

    MSTREAMAPI.getRecentlyAdded($('#recently-added-limit').val(), (response, error) => {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      const filelist = [];
      response.forEach(el => {
        currentBrowsingList.push({
          type: 'file',
          name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop()
        });

        filelist.push(`<div data-file_location="${el.filepath}" class="filez">
            <svg class="music-image" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>
            <span class="title">${el.metadata.title ? `${el.metadata.artist} - ${el.metadata.title}`: el.filepath.split("/").pop()}</span>
          </div>`);
      });

      $('#filelist').html(filelist);
    });
  }

  ////////////////////////////////////  Sort by Albums
  //Load up album explorer
  $('.get_all_albums').on('click', function () {
    getAllAlbums();
  });

  function getAllAlbums(previousState) {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.get_all_albums').addClass('selected');
    resetPanel('Albums', 'scrollBoxHeight1');
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState = [{
      state: 'allAlbums'
    }];

    MSTREAMAPI.albums((response, error) => {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      const albums = [];
      response.albums.forEach(value => {
        currentBrowsingList.push({
          type: 'album',
          name: value.name,
          'album_art_file': value.album_art_file
        });

        albums.push(`<div data-album="${value.name}" class="albumz">
            <img class="album-art-box" ${value.album_art_file ? `data-original="/album-art/${value.album_art_file}?token=${MSTREAMAPI.currentServer.token}"` : 'src="assets/img/default.png"'}>
            <span class="explorer-label-1">${value.name}</span>
          </div>`);
      });

      $('#filelist').html(albums);
      if (previousState && previousState.previousScroll) {
        $('#filelist').scrollTop(previousState.previousScroll);
      }
  
      if (previousState && previousState.previousSearch) {
        $('#search_folders').val(previousState.previousSearch).trigger('change');
      }

      // update lazy load plugin
      ll.update();
    });
  }

  // Load up album-songs
  $("#filelist").on('click', '.albumz', function () {
    var album = $(this).data('album');
    var artist = $(this).data('artist');

    getAlbumSongs(album, artist);
  });

  function getAlbumSongs(album, artist) {
    $('.directoryName').html('Album: ' + album);
    //clear the list
    $('#filelist').html('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');
    currentBrowsingList = [];

    programState.push({
      state: 'album',
      name: album,
      previousScroll: document.getElementById('filelist').scrollTop,
      previousSearch: $('#search_folders').val()
    });

    $('#search_folders').val('');

    MSTREAMAPI.albumSongs(album, artist, (response, error) => {
      if (error !== false) {
        $('#filelist').html('<div>Server call failed</div>');
        return boilerplateFailure(response, error);
      }

      //parse through the json array and make an array of corresponding divs
      const filelist = [];
      response.forEach(song => {
        currentBrowsingList.push({ type: 'file', name: song.metadata.title ? song.metadata.title : song.metadata.filename });
        filelist.push(`<div data-file_location="${song.filepath}" class="filez">
          <svg class="music-image" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>
          <span class="title">${song.metadata.title ? song.metadata.title : song.metadata.filename}</span>
        </div>`);
      });

      $('#filelist').html(filelist);
    });
  }

  //////////////////////// Search
  var searchToggles = {
    albums: true,
    artists: true,
    files: false,
    titles: true
  }

  $('.search_stuff').on('click', function () {
    setupSearchPanel();
  });

  function setupSearchPanel(searchTerm) {
    $('ul.left-nav-menu li').removeClass('selected');
    $('.search_stuff').addClass('selected');
    resetPanel('Search DB', 'scrollBoxHeight1');
    currentBrowsingList = [];
    $('#directory_bar').show();

    programState = [{
      state: 'searchPanel'
    }];

    var valString = '';
    if (searchTerm) { valString = 'value="' + searchTerm + '"'; }

    var newHtml = 
      '<div>\
        <form id="db-search" onsubmit="return false;">\
          <input ' + valString + ' id="search-term" required type="text" placeholder="Search Database">\
          <button type="submit" class="searchButton">\
            <svg fill="#DDD" viewBox="-150 -50 1224 1174" height="24px" width="24px" xmlns="http://www.w3.org/2000/svg"><path d="M960 832L710.875 582.875C746.438 524.812 768 457.156 768 384 768 171.969 596 0 384 0 171.969 0 0 171.969 0 384c0 212 171.969 384 384 384 73.156 0 140.812-21.562 198.875-57L832 960c17.5 17.5 46.5 17.375 64 0l64-64c17.5-17.5 17.5-46.5 0-64zM384 640c-141.375 0-256-114.625-256-256s114.625-256 256-256 256 114.625 256 256-114.625 256-256 256z"></path></svg>\
          </button>\
        </form>\
        <input ' + (searchToggles.artists === true ? 'checked' : '') + ' id="search-in-artists" type="checkbox"><label for="search-in-artists">Artists</label>\
        <input ' + (searchToggles.albums === true ? 'checked' : '') + ' id="search-in-albums" type="checkbox"><label for="search-in-albums">Albums</label><br>\
        <input ' + (searchToggles.titles === true ? 'checked' : '') + ' id="search-in-titles" type="checkbox"><label for="search-in-titles">Song Titles</label>\
        <input ' + (searchToggles.files === true ? 'checked' : '') + ' id="search-in-filepaths" type="checkbox"><label for="search-in-filepaths">File Paths</label>\
      </div>\
      <div id="search-results"></div>';

    $('#filelist').html(newHtml);
    $('#search_folders').val('').trigger('change');

    if (searchTerm) {
      // $('#search-term').val(searchTerm);
      $('#db-search').submit();
    }
  }

  const searchMap = {
    albums: {
      name: 'Album',
      class: 'albumz',
      data: 'album'
    },
    artists: {
      name: 'Artist',
      class: 'artistz',
      data: 'artist'
    },
    files: {
      name: 'File',
      class: 'filez',
      data: 'file_location'
    },
    title: {
      name: 'Song',
      class: 'filez',
      data: 'file_location'
    }
  };

  $('#filelist').on('submit', '#db-search', function (e) {
    $('#search-results').html('');
    $('#search-results').append('<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>');

    var postObject = { search: $('#search-term').val()};
    if (document.getElementById("search-in-artists") && document.getElementById("search-in-artists").checked === false) { postObject.noArtists = true; }
    searchToggles.artists = document.getElementById("search-in-artists").checked;
    if (document.getElementById("search-in-albums") && document.getElementById("search-in-albums").checked === false) { postObject.noAlbums = true; }
    searchToggles.albums = document.getElementById("search-in-albums").checked;
    if (document.getElementById("search-in-filepaths") && document.getElementById("search-in-filepaths").checked === false) { postObject.noFiles = true; }
    searchToggles.files = document.getElementById("search-in-filepaths").checked;
    if (document.getElementById("search-in-titles") && document.getElementById("search-in-titles").checked === false) { postObject.noTitles = true; }
    searchToggles.titles = document.getElementById("search-in-titles").checked;

    // Send AJAX Request
    MSTREAMAPI.search(postObject, function(res, error) {
      if (error !== false) {
        $('#search-results').html('<div>Server call failed</div>');
        return boilerplateFailure(res, error);
      }

      if (programState[0].state === 'searchPanel') {
        programState[0].searchTerm = postObject.search;
      }

      // Populate list
      var searchList = ['<div class="clear flatline"></div>'];
      Object.keys(res).forEach(function (key) {
        res[key].forEach(function (value, i) {
          // perform some operation on a value;
          if (value.filepath) {
            searchList.push(`<div data-${searchMap[key].data}="${value.filepath}" class="${searchMap[key].class}"><b>${searchMap[key].name}:</b> ${value.name}</div>`);
          } else {
            searchList.push(`<div data-${searchMap[key].data}="${value.name}" class="${searchMap[key].class}"><b>${searchMap[key].name}:</b> ${value.name}</div>`);
          }
        });
      });

      if (searchList.length < 2) {
        searchList.push('<h5>No Results Found</h5>');
      }

      $('#search-results').html(searchList);
    });
  });

  //////////////////////// Auto DJ
  $('#filelist').on('click', 'input[name="autodj-folders"]', function(){
    // Don't allow user to deselct all options
    if ($('input[name="autodj-folders"]:checked').length < 1) {
      $(this).prop('checked', true);
      iziToast.warning({
        title: 'Auto DJ requires a directory',
        position: 'topCenter',
        timeout: 3500
      });
      return;
    }

    if ($(this).is(':checked')) {
      MSTREAMPLAYER.ignoreVPaths[$(this).val()] = false;
    } else {
      MSTREAMPLAYER.ignoreVPaths[$(this).val()] = true;
    }
  });

  $('#filelist').on('change', '#autodj-ratings', function(){
    MSTREAMPLAYER.minRating = $(this).val();
  });

  //////////////////////// Transcode
  $('#filelist').on('change', '#enable_transcoding_locally', function(){
    var a = 'media/';
    var b = 'transcode/';

    // checkbox button while we convert the playlist
    $("#enable_transcoding_locally").attr("disabled", true);

    if (this.checked) {
      $('#ffmpeg-logo').css({ stroke: "#388E3C" });
      MSTREAMAPI.transcodeOptions.frontendEnabled = true;
    } else {
      $('#ffmpeg-logo').css({ stroke: "#DDD" });
      a = 'transcode/';
      b = 'media/';
      MSTREAMAPI.transcodeOptions.frontendEnabled = false;
    }

    // Convert playlist
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      MSTREAMPLAYER.playlist[i].url = MSTREAMPLAYER.playlist[i].url.replace(a, b);
    }

    // re-enable checkbox
    $("#enable_transcoding_locally").removeAttr("disabled");
  });

  // Setup jukebox if URL
  const myParam = window.location.pathname.split("/").pop()
    || new URLSearchParams(window.location.search).get('code')
    || false;
  if(myParam) {
    JUKEBOX.createWebsocket(MSTREAMAPI.currentServer.token, myParam, () => {
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
