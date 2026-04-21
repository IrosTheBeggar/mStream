// Dropzone
const myDropzone = new Dropzone(document.body, {
  previewsContainer: false,
  clickable: false,
  url: '/api/v1/file-explorer/upload',
  maxFilesize: null
});

myDropzone.on("addedfile", (file) => {
  if (programState[0].state !== 'fileExplorer') {
    iziToast.error({
      title: t('toast.filesExplorerOnly'),
      position: 'topCenter',
      timeout: 3500
    });
    myDropzone.removeFile(file);
  } else if (fileExplorerArray.length < 1) {
    iziToast.error({
      title: t('toast.cannotUploadHere'),
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

myDropzone.on('sending', (file, xhr, formData) => {
  xhr.setRequestHeader('data-location', encodeURI(file.directory))
  xhr.setRequestHeader('x-access-token', MSTREAMAPI.currentServer.token)
});

myDropzone.on('totaluploadprogress', (percent, uploaded, size) => {
  document.getElementById('upload-progress-inner').style.width = percent + '%';
  if (percent === 100) {
    document.getElementById('upload-progress-inner').style.width = '0%';
  }
});

myDropzone.on('queuecomplete', (file, xhr, formData) => {
  var successCount = 0;
  for (var i = 0; i < myDropzone.files.length; i++) {
    if (myDropzone.files[i].status === 'success') {
      successCount += 1;
    }
  }

  if (successCount === myDropzone.files.length) {
    iziToast.success({
      title: t('toast.filesUploaded'),
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
      title: t('toast.uploadPartial', { success: successCount, total: myDropzone.files.length }),
      position: 'topCenter',
      timeout: 3500
    });

    if (programState[0].state === 'fileExplorer') {
      senddir();
    }
  }

  myDropzone.removeAllFiles()
});

myDropzone.on('error', (err, msg, xhr) => {
  var iziStuff = {
    title: t('toast.uploadFailed'),
    position: 'topCenter',
    timeout: 3500
  };

  if (msg.error) {
    iziStuff.message = msg.error;
  }

  iziToast.error(iziStuff);
});

////////////////////////////// Global Variables
// These vars track your position within the file explorer
var fileExplorerArray = [];
// Stores an array of searchable objects
var currentBrowsingList = [];
// This variable tracks the state of the explorer column
var programState = [];

let curFileTracker;

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
  return String(string).replace(/[&<>"'`=\/]/g, (s) => {
    return entityMap[s];
  });
}

function renderAlbum(id, artist, name, albumArtFile, year) {
  const artSrc = albumArtFile
    ? `${MSTREAMAPI.currentServer.host}album-art/${albumArtFile}?${VUEPLAYERCORE.altLayout.compressArt ? 'compress=l&' : ''}token=${MSTREAMAPI.currentServer.token}`
    : null;

  return `<div class="album-grid-card" ${year ? `data-year="${year}"` : ''} ${artist ? `data-artist="${artist}"` : ''} ${id ? `data-album="${id}"` : ''} onclick="getAlbumsOnClick(this);">
    <div class="album-grid-art">
      ${artSrc
        ? `<img loading="lazy" src="${artSrc}">`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#555"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`}
      <button class="album-grid-play" onclick="event.stopPropagation(); queueAlbum(this.closest('.album-grid-card'));" title="Add album to queue">
        <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>
    <div class="album-grid-info">
      <div class="album-grid-name">${name}</div>
      ${year ? `<div class="album-grid-year">${year}</div>` : ''}
    </div>
  </div>`;
}

function renderArtist(artist) {
  return `<li class="collection-item">
      <div data-artist="${artist}" class="artistz" onclick="getArtistz(this)">${artist}</div>
    </li>`;
}

function renderFileWithMetadataHtml(filepath, lokiId, metadata) {
  return `<li data-lokiid="${lokiId}" class="collection-item">
    <div data-file_location="${filepath}" class="filez flex" onclick="onFileClick(this);">
      <img class="album-art-box" loading="lazy" ${metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${metadata['album-art']}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : 'src="assets/img/default.png"'}>
      <div>
        <b><span>${(!metadata || !metadata.title) ? filepath.split("/").pop() : `${metadata.title}`}</span></b>
        ${metadata.artist ? `</b><br><span style="font-size:15px;">${metadata.artist}</span>` : ''}
      </div>
    </div>
    <div class="song-button-box">
      <span title="Play Now" onclick="playNow(this);" data-file_location="${filepath}" class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      <span data-lokiid="${lokiId}" class="removePlaylistSong" onclick="removePlaylistSong(this);">remove</span>
    </div>
  </li>`;
}

function createMusicFileHtml(fileLocation, title, aa, rating, subtitle) {
  return `<li class="collection-item">
    <div data-file_location="${fileLocation}" class="filez ${aa ? 'flex2' : ''}" onclick="onFileClick(this);">
      ${aa ? `<img loading="lazy" class="album-art-box" ${aa}>` : '<svg class="music-image" height="18" width="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>'} 
      <span>
        ${subtitle !== undefined ? `<b>` : ''}
        <span class="${aa ? '' : 'item-text'}">${rating ? `[${rating}] ` : ''}${title}</span>
        ${subtitle !== undefined ? `</b><br><span>${subtitle}</span>` : ''}
      </span>
    </div>
    <div class="song-button-box">
      <span title="Play Now" onclick="playNow(this);" data-file_location="${fileLocation}" class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      <span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${fileLocation}" class="fileAddToPlaylist">
        <svg class="pop-f" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-f" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
      </span>
    </div>
  </li>`;
}

function renderDirHtml(name) {
  return `<li class="collection-item">
    <div data-directory="${name}" class="dirz" onclick="handleDirClick(this);">
      <svg class="folder-image" viewBox="0 0 48 48" version="1.0" xmlns="http://www.w3.org/2000/svg"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
      <span class="item-text">${name}</span>
    </div>
    <div class="song-button-box">
      <span style="padding-top:1px;" title="Add All To Queue" class="songDropdown" onclick="recursiveAddDir(this);" data-directory="${name}">
        <svg xmlns="http://www.w3.org/2000/svg" height="10" width="10" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>
      </span>
      <span data-directory="${name}" title="Download Directory" class="downloadDir" onclick="recursiveFileDownload(this);">
        <svg width="13" height="13" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>
      </span>
    </div>
  </li>`
}

function createFileplaylistHtml(dataDirectory) {
  return `<li class="collection-item pointer">
    <div data-directory="${dataDirectory}" class="fileplaylistz" onclick="onFilePlaylistClick(this);">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="25" height="25"><path d="M14.5 8a2.495 2.495 0 0 0-2.5 2.5v45c0 1.385 1.115 2.5 2.5 2.5h35c1.385 0 2.5-1.115 2.5-2.5V23l-13.75-1.25L37 8Z" opacity=".2"/><path fill="#1e98d1" d="M14.5 7A2.495 2.495 0 0 0 12 9.5v45c0 1.385 1.115 2.5 2.5 2.5h35c1.385 0 2.5-1.115 2.5-2.5V22l-13.75-1.25L37 7z"/><path d="M37 8v12.5a2.5 2.5 0 0 0 2.5 2.5H52Z" opacity=".2"/><path fill="#67bbe9" d="M37 7v12.5a2.5 2.5 0 0 0 2.5 2.5H52L37 7z"/><path d="M14.5 7A2.495 2.495 0 0 0 12 9.5v1C12 9.115 13.115 8 14.5 8H37V7z" opacity=".2" fill="#fff"/><path d="M24.199 28A2.149 2.085 0 0 0 22 30.086v19.831a2.149 2.085 0 0 0 3.223 1.805l17.704-9.916a2.149 2.085 0 0 0 0-3.61L25.223 28.28a2.149 2.085 0 0 0-1.024-.28z" opacity=".2"/><path d="M24.199 27A2.149 2.085 0 0 0 22 29.086v19.831a2.149 2.085 0 0 0 3.223 1.805l17.704-9.916a2.149 2.085 0 0 0 0-3.61L25.223 27.28a2.149 2.085 0 0 0-1.024-.28z" fill="#fff"/></svg>
      <span class="item-text">${dataDirectory}</span>
    </div>
    <div class="song-button-box">
      <span title="Add All To Queue" class="addFileplaylist" onclick="addFilePlaylist(this);" data-directory="${dataDirectory}">
        <svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>
      </span>
      <span data-directory="${dataDirectory}" title="Download Playlist" class="downloadFileplaylist" onclick="downloadFileplaylist(this);">
        <svg width="12" height="12" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>
      </span>
    </div>
  </li>`;
}

function renderPlaylist(playlistName) {
  return `<li class="collection-item" data-playlistname="${encodeURIComponent(playlistName)}" class="playlist_row_container">
    <span data-playlistname="${encodeURIComponent(playlistName)}" class="playlistz" onclick="onPlaylistClick(this);">${escapeHtml(playlistName)}</span>
    <div class="song-button-box">
      <span data-playlistname="${encodeURIComponent(playlistName)}" class="deletePlaylist" onclick="deletePlaylist(this);">Delete</span>
    </div>
  </li>`;
}

function getLoadingSvg() {
  return '<svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>';
}

function setBrowserRootPanel(panelName, showBar) {
  if(showBar === false) {
    document.getElementById('directory_bar').style.display = 'none';
  }else {
    document.getElementById('directory_bar').style.display = '';
  }

  document.getElementById('localSearchBar').value = "";
  document.getElementById('directoryName').innerHTML = '';
  document.getElementById('local_search_btn').style.display = '';
  document.getElementById('upload_btn').classList.add('super-hide');
  document.getElementById('mkdir_btn').classList.add('super-hide');

  ([...document.getElementsByClassName('panel_one_name')]).forEach(el => {
    el.innerHTML = panelName;
  });

  currentBrowsingList = [];
}

///////////////// File Explorer
function loadFileExplorer() {
  setBrowserRootPanel(t('panel.fileExplorer'));
  programState = [{ state: 'fileExplorer' }];

  // Reset file explorer vars
  fileExplorerArray = [];
  //send this directory to be parsed and displayed
  senddir(true);
}

async function senddir(root) {
  if (isElectron() && !MSTREAMAPI.currentServer.host) { return; }

  // Construct the directory string
  const directoryString = root === true ? '~' : getFileExplorerPath();
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  try {
    const response = await MSTREAMAPI.dirparser(directoryString);
    document.getElementById('directoryName').innerHTML = response.path;

    if(root === true && response.path.length > 1) {
      fileExplorerArray.push(response.path.replaceAll('/', ''));
      programState.push({
        state: 'fileExplorer',
        previousScroll: 0,
        previousSearch: ''
      });
    }

    // Show upload and mkdir buttons only when inside a vpath (not at root)
    const uploadBtn = document.getElementById('upload_btn');
    const mkdirBtn = document.getElementById('mkdir_btn');
    if (fileExplorerArray.length > 0) {
      uploadBtn.classList.remove('super-hide');
      if (MSTREAMAPI.currentServer.noMkdir === true) {
        mkdirBtn.classList.add('super-hide');
      } else {
        mkdirBtn.classList.remove('super-hide');
      }
    } else {
      uploadBtn.classList.add('super-hide');
      mkdirBtn.classList.add('super-hide');
    }

    printdir(response);
  } catch(err) {
    boilerplateFailure(err);
  }
}

// function that will receive JSON array of a directory listing.  It will then make a list of the directory and tack on classes for functionality
function printdir(response) {
  currentBrowsingList = [];
  let filelist = '<ul class="collection">';

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
      filelist += createMusicFileHtml(file.path || response.path + file.name, title);
    }
  }

  filelist += '</ul>';

  // clear the list
  document.getElementById('localSearchBar').value = '';

  // Post the html to the filelist div
  document.getElementById('filelist').innerHTML = filelist;
}

function getFileExplorerPath() {
  return fileExplorerArray.join("/") + "/";
}

function getDirectoryString2(component) {
  var newString = getFileExplorerPath() + component.getAttribute("data-directory");
  if (newString.substring(0,1) !== '/') {
    newString = "/" + newString
  }

  return newString;
}

if (typeof(Storage) !== "undefined" && localStorage.getItem("token")) {
  MSTREAMAPI.currentServer.token = localStorage.getItem("token");
}

// Electron Desktop Player: hydrate token from OS-keychain-backed safeStorage
// if available. Mirrors the result into localStorage so downstream readers
// stay synchronous. No-op in browser contexts.
if (window.mstreamSafeToken) {
  window.mstreamSafeToken.hydrate().then(() => {
    if (typeof(Storage) !== "undefined" && localStorage.getItem("token")) {
      MSTREAMAPI.currentServer.token = localStorage.getItem("token");
    }
  });
}

function handleDirClick(el){
  fileExplorerArray.push(el.getAttribute('data-directory'));
  programState.push({
    state: 'fileExplorer',
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  });
  senddir();
}

function boilerplateFailure(err) {
  console.log(err);
  let msg = t('error.callFailed');
  // TODO: Check this
  if (err.responseJSON && err.responseJSON.error) {
    msg = err.responseJSON.error;
  }

  iziToast.error({
    title: msg,
    position: 'topCenter',
    timeout: 3500
  });
}

function onFileClick(el) {
  VUEPLAYERCORE.addSongWizard(el.getAttribute("data-file_location"), {}, true);
}

async function recursiveAddDir(el) {
  try {
    const directoryString = getDirectoryString2(el);
    const res = await MSTREAMAPI.recursiveScan(directoryString);
    addAllSongs(res);
  } catch(err) {
    boilerplateFailure(err);   
  }
}

async function onFilePlaylistClick(el) {
  try {
    fileExplorerArray.push(el.getAttribute("data-directory"));
    programState.push({
      state: 'fileExplorer',
      previousScroll: document.getElementById('filelist').scrollTop,
      previousSearch: document.getElementById('search_folders').value
    });
    const directoryString = getFileExplorerPath();
  
    document.getElementById('directoryName').innerHTML = '/' + directoryString.substring(0, directoryString.length - 1);
    document.getElementById('filelist').innerHTML = getLoadingSvg();  

    const response = await MSTREAMAPI.loadFileplaylist(directoryString);
    printdir(response);
  }catch(err) {
    boilerplateFailure(err);

  }
}

async function addFilePlaylist(el) {
  try {
    const res = await MSTREAMAPI.loadFileplaylist(getDirectoryString2(el));

    const translatedList = [];
    res.files.forEach(f => {
      translatedList.push(f.path)
    })

    addAllSongs(translatedList);
  }catch(err) {
     boilerplateFailure(err);
  }
}

function addAll() {
  ([...document.getElementsByClassName('filez')]).forEach(el => {
    VUEPLAYERCORE.addSongWizard(el.getAttribute("data-file_location"), {}, true);
  });
}

function addAllSongs(res) {
  for (var i = 0; i < res.length; i++) {
    VUEPLAYERCORE.addSongWizard(res[i], {}, true);
  }
}

async function queueAlbum(cardEl) {
  const album = cardEl.getAttribute('data-album') || null;
  const artist = cardEl.getAttribute('data-artist') || null;
  const year = cardEl.getAttribute('data-year') || null;

  try {
    const response = await MSTREAMAPI.albumSongs({
      album,
      artist,
      year,
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter(v => MSTREAMPLAYER.ignoreVPaths[v] === true)
    });

    response.forEach(song => {
      VUEPLAYERCORE.addSongWizard(song.filepath, song.metadata || {}, true);
    });

    iziToast.success({
      title: t('toast.albumQueued'),
      message: t('toast.albumQueuedMessage', { count: response.length }),
      position: 'topCenter',
      timeout: 2500
    });
  } catch(err) {
    boilerplateFailure(err);
  }
}

function playNow(el) {
  VUEPLAYERCORE.addSongWizard(el.getAttribute("data-file_location"), {}, true, MSTREAMPLAYER.positionCache.val + 1);
}

let startInterval = false;
async function init() {
  try {
    const response = await MSTREAMAPI.ping();
    MSTREAMAPI.currentServer.vpaths = response.vpaths;
    VUEPLAYERCORE.playlists.length = 0;
    document.getElementById('pop-f').innerHTML = `<div class="pop-f pop-playlist">${t('playlist.addToPlaylist')}</div>`;

    response.playlists.forEach(p => {
      VUEPLAYERCORE.playlists.push(p);
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${p.name}')">&#8226; ${p.name}</div>`;
      document.getElementById('live-playlist-select').innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });

    if (response.supportedAudioFiles) {
      const codecSelect = document.getElementById('ytdl_codec');
      codecSelect.innerHTML = '';
      Object.keys(response.supportedAudioFiles).forEach(format => {
        if (response.supportedAudioFiles[format] === true) {
          const option = document.createElement('option');
          option.value = format;
          option.textContent = format.toUpperCase();
          codecSelect.appendChild(option);
        }
      });
    }

    MSTREAMAPI.currentServer.noMkdir = response.noMkdir === true;

    if (response.transcode) {
      MSTREAMPLAYER.transcodeOptions.serverEnabled = true;
      MSTREAMPLAYER.transcodeOptions.defaultCodec = response.transcode.defaultCodec;
      MSTREAMPLAYER.transcodeOptions.defaultBitrate = response.transcode.defaultBitrate;
    }
  }catch (err) {
    if (isElectron()) {
      MSTREAMAPI.currentServer.host = '';
      MSTREAMAPI.currentServer.token = '';
      localStorage.removeItem('current-server');
      document.getElementById('filelist').innerHTML = '';
      openEditModal();
      return;
    }
  }

  // load user settings
  try {
    const ivp = JSON.parse(localStorage.getItem('ignoreVPaths'));
    if (Array.isArray(ivp) || !(ivp instanceof Object)) { throw 'bad!'; }
    MSTREAMPLAYER.ignoreVPaths = ivp;
  } catch (e) {}

  try {
    // forced to an array to assure we're not stuffing nul values in here
    MSTREAMPLAYER.minRating = JSON.parse(localStorage.getItem('minRating'))[0];
  } catch (e) {}

  try {
    if(localStorage.getItem('transcode') === 'true' && MSTREAMPLAYER.transcodeOptions.serverEnabled === true) {
      toggleTranscoding(undefined, true);
    }
    MSTREAMPLAYER.transcodeOptions.selectedCodec = localStorage.getItem('trans-codec-select');
    MSTREAMPLAYER.transcodeOptions.selectedBitrate = localStorage.getItem('trans-bitrate-select');
    // Drop any stale algorithm selection from previous versions.
    localStorage.removeItem('trans-algo-select');
  } catch (e) {}

  try{
    if (typeof serverAudioMode === 'undefined' || serverAudioMode !== true) {
      VUEPLAYERCORE.livePlaylist.name = localStorage.getItem('live-playlist-auto-start') ? localStorage.getItem('live-playlist-auto-start') : false;
    }

    if (VUEPLAYERCORE.livePlaylist.name) {
      // get current playlist
      const response = await MSTREAMAPI.loadPlaylist(VUEPLAYERCORE.livePlaylist.name);

      // set the queue to the current playlist
      MSTREAMPLAYER.clearPlaylist();
      response.forEach(value => {
        VUEPLAYERCORE.addSongWizard(value.filepath, value.metadata, false, undefined, false, true);
      });

      document.getElementById('set_live_playlist').classList.remove('green');
      document.getElementById('set_live_playlist').classList.add('blue');
      document.getElementById('set_live_playlist').value = 'Disable Live Playlist';
      document.getElementById('live-playlist-hide-these').hidden = true;
    }

  }catch(err) {}

  dbStatus();
}

async function dbStatus() {
  try {
    const response = await MSTREAMAPI.dbStatus();
    // if not scanning
    if (!response.locked || response.locked === false) {
      clearInterval(startInterval);
      startInterval = false;
      document.getElementById('scan-status').innerHTML = '';
      document.getElementById('scan-status-files').innerHTML = '';

      return;
    }

    // Set Interval
    if (startInterval === false) {
      startInterval = setInterval(function () {
        dbStatus();
      }, 2000);
    }

    // Update status
    document.getElementById('scan-status').innerHTML = t('status.scanInProgress');
    document.getElementById('scan-status-files').innerHTML = t('status.filesInDB', { count: response.totalFileCount });
  }catch(err) {
    document.getElementById('scan-status').innerHTML = '';
    document.getElementById('scan-status-files').innerHTML = '';
    clearInterval(startInterval);
    startInterval = false;
  }
}

function createPopper3(el) {
  if (curFileTracker === el.getAttribute("data-file_location")) {
    curFileTracker = undefined;
    document.getElementById("pop-f").style.visibility = "hidden";
    return;
  }

  curFileTracker = el.getAttribute("data-file_location")
  Popper.createPopper(el, document.getElementById('pop-f'), {
    placement: 'bottom-end',
    onFirstUpdate: function (data) {
      document.getElementById("pop-f").style.visibility = "visible";
    },
    modifiers: [
      {
        name: 'flip',
        options: {
          boundariesElement: 'scrollParent',
        },
      },
      {
        name: 'preventOverflow',
        options: {
          boundariesElement: 'scrollParent',
        },
      },
    ]
  });
}

const myModal = new HystModal({});

function openShareModal() {
  myModal.open('#sharePlaylist');
}

function openSaveModal() {
  myModal.open('#savePlaylist');
}

function openLivePlaylistModal() {
  myModal.open('#livePlaylist');
}

function openNewPlaylistModal() {
  myModal.open('#newPlaylist');
}

function openPlaybackModal() {
  myModal.open('#speedModal');
}

function switchUploadTab(tab) {
  const uploadTab = document.getElementById('tab_upload');
  const ytdlTab = document.getElementById('tab_ytdl');
  const uploadContent = document.getElementById('tab_content_upload');
  const ytdlContent = document.getElementById('tab_content_ytdl');

  if (tab === 'upload') {
    uploadTab.style.borderBottomColor = '#fff';
    ytdlTab.style.borderBottomColor = 'transparent';
    uploadContent.classList.remove('super-hide');
    ytdlContent.classList.add('super-hide');
  } else {
    ytdlTab.style.borderBottomColor = '#fff';
    uploadTab.style.borderBottomColor = 'transparent';
    ytdlContent.classList.remove('super-hide');
    uploadContent.classList.add('super-hide');
    document.getElementById('ytdl_url').focus();
  }
}

function handleFileUpload(files) {
  if (!files || files.length === 0) { return; }
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    file.directory = getFileExplorerPath();
    myDropzone.addFile(file);
  }
  document.getElementById('upload_file_input').value = '';
  myModal.close();
}

function openUploadModal() {
  document.getElementById('upload_filepath').textContent = getFileExplorerPath();

  // Reset upload tab
  document.getElementById('upload_file_input').value = '';

  // Reset ytdl tab
  if (!MSTREAMPLAYER.transcodeOptions.serverEnabled) {
    document.getElementById('ytdl_transcode_warning').classList.remove('super-hide');
    document.getElementById('ytdl_submit').disabled = true;
  } else {
    document.getElementById('ytdl_transcode_warning').classList.add('super-hide');
    document.getElementById('ytdl_submit').disabled = false;
  }
  document.getElementById('ytdl_meta_loading').classList.add('super-hide');
  document.getElementById('ytdl_metadata').classList.add('super-hide');
  document.getElementById('ytdl_meta_title').textContent = '';
  document.getElementById('ytdl_meta_artist').textContent = '';
  document.getElementById('ytdl_meta_album').textContent = '';
  document.getElementById('ytdl_meta_year').textContent = '';

  // Default to upload tab
  switchUploadTab('upload');
  myModal.open('#uploadModal');
}

function openMkdirModal() {
  document.getElementById('mkdir_filepath').textContent = getFileExplorerPath();
  document.getElementById('mkdir_name').value = '';
  myModal.open('#mkdirModal');
}

async function submitMkdir() {
  const folderName = document.getElementById('mkdir_name').value.trim();
  if (!folderName) { return; }

  const directory = getFileExplorerPath() + folderName;
  document.getElementById('mkdir_submit').disabled = true;

  try {
    await MSTREAMAPI.mkdir(directory);
    iziToast.success({
      title: t('toast.folderCreated'),
      position: 'topCenter',
      timeout: 3500
    });
    myModal.close();
    senddir();
  } catch (err) {
    iziToast.error({
      title: t('toast.folderCreateFailed'),
      position: 'topCenter',
      timeout: 3500
    });
  } finally {
    document.getElementById('mkdir_submit').disabled = false;
  }
}

function isYoutubeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com') || parsed.hostname === 'youtu.be';
  } catch (e) {
    return false;
  }
}

var ytdlMetaTimeout = null;
document.getElementById('ytdl_url').addEventListener('input', function() {
  clearTimeout(ytdlMetaTimeout);
  var url = this.value.trim();

  document.getElementById('ytdl_metadata').classList.add('super-hide');
  document.getElementById('ytdl_meta_loading').classList.add('super-hide');

  if (!isYoutubeUrl(url)) { return; }

  document.getElementById('ytdl_meta_loading').classList.remove('super-hide');

  ytdlMetaTimeout = setTimeout(async function() {
    try {
      var res = await MSTREAMAPI.ytdlMetadata(url);
      document.getElementById('ytdl_meta_loading').classList.add('super-hide');

      var meta = res.data || res;
      document.getElementById('ytdl_meta_title').textContent = meta.title || '';
      document.getElementById('ytdl_meta_artist').textContent = meta.artist || '';
      document.getElementById('ytdl_meta_album').textContent = meta.album || '';
      document.getElementById('ytdl_meta_year').textContent = meta.year || '';

      var thumb = document.getElementById('ytdl_meta_thumb');
      if (meta.thumbnail) {
        thumb.src = meta.thumbnail;
        thumb.style.display = '';
      } else {
        thumb.style.display = 'none';
      }

      document.getElementById('ytdl_metadata').classList.remove('super-hide');
    } catch(err) {
      document.getElementById('ytdl_meta_loading').classList.add('super-hide');
    }
  }, 500);
});

async function submitYtdl() {
  const url = document.getElementById('ytdl_url').value;
  const outputCodec = document.getElementById('ytdl_codec').value;
  const filepath = document.getElementById('upload_filepath').textContent;

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'youtube.com' && !parsed.hostname.endsWith('.youtube.com') && parsed.hostname !== 'youtu.be') {
      return iziToast.warning({ title: t('toast.youtubeUrlRequired'), position: 'topCenter', timeout: 3500 });
    }
  } catch (e) {
    return iziToast.warning({ title: t('toast.invalidUrl'), position: 'topCenter', timeout: 3500 });
  }

  // Collect user-edited metadata overrides
  const metadata = {};
  const metaTitle = document.getElementById('ytdl_meta_title').textContent.trim();
  const metaArtist = document.getElementById('ytdl_meta_artist').textContent.trim();
  const metaAlbum = document.getElementById('ytdl_meta_album').textContent.trim();
  const metaYear = document.getElementById('ytdl_meta_year').textContent.trim();
  if (metaTitle) { metadata.title = metaTitle; }
  if (metaArtist) { metadata.artist = metaArtist; }
  if (metaAlbum) { metadata.album = metaAlbum; }
  if (metaYear) { metadata.year = metaYear; }

  document.getElementById('ytdl_submit').disabled = true;

  try {
    await MSTREAMAPI.ytdl(url, outputCodec, filepath, metadata);
    myModal.close();
    document.getElementById('ytdl_url').value = '';
    document.getElementById('ytdl_metadata').classList.add('super-hide');
    iziToast.success({
      title: t('toast.downloadStarted'),
      position: 'topCenter',
      timeout: 3000
    });
    startYtdlPolling();
  } catch(err) {
    boilerplateFailure(err);
  } finally {
    document.getElementById('ytdl_submit').disabled = false;
  }
}

var ytdlPollInterval = null;
function startYtdlPolling() {
  if (ytdlPollInterval) { return; }
  updateYtdlIndicator();
  ytdlPollInterval = setInterval(updateYtdlIndicator, 3000);
}

async function updateYtdlIndicator() {
  try {
    var res = await MSTREAMAPI.ytdlDownloads();
    var downloads = (res.data || res).downloads || [];
    var active = downloads.filter(function(d) { return d.status === 'downloading'; });
    var completed = downloads.filter(function(d) { return d.status === 'complete'; });

    var indicator = document.getElementById('ytdl_download_indicator');
    var textEl = document.getElementById('ytdl_download_text');

    if (active.length > 0) {
      indicator.classList.remove('super-hide');
      textEl.textContent = active.length === 1 ? t('status.downloadingAudio') : t('status.downloadingFiles', { count: active.length });
    } else {
      indicator.classList.add('super-hide');

      // Stop polling when nothing is active
      clearInterval(ytdlPollInterval);
      ytdlPollInterval = null;
    }

    // Refresh the file list if a download completed in the current directory
    if (completed.length > 0 && programState[0].state === 'fileExplorer' && fileExplorerArray.length > 0) {
      var currentDir = getFileExplorerPath();
      for (var i = 0; i < completed.length; i++) {
        if (completed[i].directory === currentDir) {
          senddir();
          break;
        }
      }
    }
  } catch (e) {
    // silently ignore polling errors
  }
}

function openMetadataModal(metadata, fp) {
  if (metadata === null) {
    return iziToast.warning({
      title: t('toast.noMetadataFound'),
      position: 'topCenter',
      timeout: 3500
    });
  }

  document.getElementById('meta--title').innerHTML = metadata.title;
  document.getElementById('meta--album').innerHTML = metadata.album;
  document.getElementById('meta--artist').innerHTML = metadata.artist;
  document.getElementById('meta--year').innerHTML = metadata.year;
  document.getElementById('meta--disk').innerHTML = metadata.disk;
  document.getElementById('meta--track').innerHTML = metadata.track;
  document.getElementById('meta--rating').innerHTML = metadata.rating;
  document.getElementById('meta--rg').innerHTML = metadata['replaygain-track'];
  document.getElementById('meta--fp').innerHTML = fp;
  document.getElementById('meta--fp').href = 'media' + fp;
  document.getElementById('meta--aa').innerHTML = 'album-art/' + metadata['album-art'];
  if (metadata['album-art']) {
    document.getElementById('meta--aa').href = `album-art/${metadata['album-art']}`;
  } else {
    document.getElementById('meta--aa').href = '#';
  }
  
  myModal.open('#metadataModel');
}

function openAlbumArtModal(metadata, fp) {
  document.getElementById('aa-filepath').value = fp;
  document.getElementById('aa-artist').value = metadata.artist || '';
  document.getElementById('aa-album').value = metadata.album || '';
  document.getElementById('aa-results').innerHTML = '';
  document.getElementById('aa-search-status').innerHTML = t('albumArt.loadingAlbumArt');
  document.getElementById('aa-upload-input').value = '';
  document.getElementById('aa-write-folder').checked = false;
  document.getElementById('aa-write-file').checked = false;

  // Show song info
  document.getElementById('aa-info-title').innerText = metadata.title || fp.split('/').pop();
  document.getElementById('aa-info-artist').innerText = metadata.artist ? 'Artist: ' + metadata.artist : '';
  document.getElementById('aa-info-album').innerText = metadata.album ? 'Album: ' + metadata.album : '';
  document.getElementById('aa-info-filepath').innerText = fp;

  // Hide embed checkbox if ffmpeg not available or file modification not allowed
  const embedRow = document.getElementById('aa-embed-row');
  if (embedRow) {
    fetch(MSTREAMAPI.currentServer.host + 'api/v1/album-art/ffmpeg-status', {
      headers: { 'x-access-token': MSTREAMAPI.currentServer.token }
    }).then(r => r.json()).then(d => {
      embedRow.style.display = d.available ? '' : 'none';
    }).catch(() => { embedRow.style.display = 'none'; });
  }

  myModal.open('#albumArtModal');

  // Auto-search after modal opens
  if (metadata.artist || metadata.album) {
    searchAlbumArt();
  }
}

async function searchAlbumArt() {
  const artist = document.getElementById('aa-artist').value;
  const album = document.getElementById('aa-album').value;

  if (!artist && !album) {
    document.getElementById('aa-search-status').innerHTML = t('status.noArtistOrAlbumInfo');
    return;
  }

  document.getElementById('aa-search-status').innerHTML = t('status.searching');
  document.getElementById('aa-results').innerHTML = '';

  try {
    const res = await MSTREAMAPI.searchAlbumArt({ artist: artist || '', album: album || '' });

    if (!res.results || res.results.length === 0) {
      document.getElementById('aa-search-status').innerHTML = t('status.noAlbumArtFound');
      return;
    }

    document.getElementById('aa-search-status').innerHTML = t('status.albumArtResults', { count: res.results.length });

    let html = '';
    res.results.forEach((r, i) => {
      html += `<div style="cursor:pointer;text-align:center;width:130px;" onclick="selectAlbumArt('${r.url.replace(/'/g, "\\'")}')">
        <img src="${r.url}" style="width:120px;height:120px;object-fit:cover;border-radius:4px;border:2px solid transparent;"
             onerror="this.parentElement.style.display='none'" loading="lazy">
        <div style="font-size:11px;color:#aaa;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.label}</div>
      </div>`;
    });

    document.getElementById('aa-results').innerHTML = html;
  } catch (err) {
    document.getElementById('aa-search-status').innerHTML = t('status.searchFailed', { error: err.message || err });
  }
}

async function selectAlbumArt(url) {
  const filepath = document.getElementById('aa-filepath').value;
  const writeToFolder = document.getElementById('aa-write-folder').checked;
  const writeToFile = document.getElementById('aa-write-file').checked;

  try {
    await MSTREAMAPI.setAlbumArtFromUrl({ filepath, url, writeToFolder, writeToFile });
    iziToast.success({ title: t('toast.albumArtUpdated'), position: 'topCenter', timeout: 3500 });
    myModal.close();
  } catch (err) {
    iziToast.error({ title: t('toast.albumArtFailed'), position: 'topCenter', timeout: 3500 });
  }
}

async function uploadCustomAlbumArt() {
  const input = document.getElementById('aa-upload-input');
  if (!input.files || input.files.length === 0) {
    return iziToast.warning({ title: t('toast.selectImageFirst'), position: 'topCenter', timeout: 3500 });
  }

  const file = input.files[0];

  // Client-side validation
  if (file.size > 10 * 1024 * 1024) {
    return iziToast.error({ title: t('toast.imageTooLarge'), position: 'topCenter', timeout: 3500 });
  }

  const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    return iziToast.error({ title: t('toast.invalidImageFormat'), position: 'topCenter', timeout: 3500 });
  }

  const filepath = document.getElementById('aa-filepath').value;
  const writeToFolder = document.getElementById('aa-write-folder').checked;
  const writeToFile = document.getElementById('aa-write-file').checked;

  // Read file as base64
  const reader = new FileReader();
  reader.onload = async function () {
    const base64 = reader.result.split(',')[1]; // strip data:image/...;base64,
    try {
      await MSTREAMAPI.uploadAlbumArt({ filepath, image: base64, writeToFolder, writeToFile });
      iziToast.success({ title: t('toast.albumArtUpdated'), position: 'topCenter', timeout: 3500 });
      myModal.close();
    } catch (err) {
      iziToast.error({ title: t('toast.uploadFailed'), position: 'topCenter', timeout: 3500 });
    }
  };
  reader.readAsDataURL(file);
}

function openEditModal() {
  document.getElementById('server_address').value = MSTREAMAPI.currentServer.host;
  document.getElementById('server_username').value = MSTREAMAPI.currentServer.username;
  document.getElementById('server_password').value = '';
  myModal.open('#editServer');
}

async function addToPlaylistUI(playlist) {
  try {
    await MSTREAMAPI.addToPlaylist(playlist, curFileTracker);
    iziToast.success({
      title: t('toast.songAdded'),
      position: 'topCenter',
      timeout: 3500
    });
  }catch(err) {
    iziToast.error({
      title: t('toast.failedAddSong'),
      position: 'topCenter',
      timeout: 3500
    });
  }
}

/////////////// Download Playlist
function downloadPlaylist() {
  // Loop through array and add each file to the playlist
  const downloadFiles = [];
  for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
    downloadFiles.push(MSTREAMPLAYER.playlist[i].rawFilePath);
  }

  if (downloadFiles.length < 1) {
    return;
  }

  const fallback = () => {
    document.getElementById('downform').action = "api/v1/download/zip?token=" + MSTREAMAPI.currentServer.token;
    const input = document.createElement("INPUT");
    input.type = 'hidden';
    input.name = 'fileArray';
    input.value = JSON.stringify(downloadFiles);
    document.getElementById('downform').appendChild(input);
    document.getElementById('downform').submit();
    document.getElementById('downform').innerHTML = '';
  };

  if (window.mstreamDownloadOrSync && window.mstreamParseRawFilePath) {
    const parsed = downloadFiles
      .map(f => window.mstreamParseRawFilePath(f))
      .filter(Boolean);
    window.mstreamDownloadOrSync(parsed, fallback);
  } else {
    fallback();
  }
}

async function recursiveFileDownload(el) {
  const directoryString = getDirectoryString2(el);

  const fallback = () => {
    document.getElementById('downform').action = "api/v1/download/directory?token=" + MSTREAMAPI.currentServer.token;
    const input = document.createElement("INPUT");
    input.type = 'hidden';
    input.name = 'directory';
    input.value = directoryString;
    document.getElementById('downform').appendChild(input);
    document.getElementById('downform').submit();
    document.getElementById('downform').innerHTML = '';
  };

  const manual = window.mstreamIsManualMode ? await window.mstreamIsManualMode() : false;
  if (!manual) { return fallback(); }

  // Manual mode: enumerate audio files via the recursive file-explorer endpoint
  // (server already filters to supported audio types + respects vpath bounds)
  // and sync each to the local folder.
  try {
    const server = MSTREAMAPI.currentServer;
    const res = await fetch(server.host + 'api/v1/file-explorer/recursive', {
      method: 'POST',
      body: JSON.stringify({ directory: directoryString }),
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': server.token,
      },
    });
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    const paths = await res.json();

    const parsed = (paths || [])
      .map(p => window.mstreamParseRawFilePath(p))
      .filter(Boolean);

    if (parsed.length === 0) {
      iziToast.error({ title: 'No audio files in that folder', position: 'topCenter', timeout: 3000 });
      return;
    }
    window.mstreamDownloadOrSync(parsed, fallback);
  } catch (e) {
    iziToast.error({ title: 'Failed to list folder: ' + (e.message || e), position: 'topCenter', timeout: 3500 });
  }
}

async function downloadFileplaylist(el) {
  const m3uPath = getDirectoryString2(el);

  const fallback = () => {
    document.getElementById('downform').action = "api/v1/download/m3u?token=" + MSTREAMAPI.currentServer.token;
    const input = document.createElement("INPUT");
    input.type = 'hidden';
    input.name = 'path';
    input.value = m3uPath;
    document.getElementById('downform').appendChild(input);
    document.getElementById('downform').submit();
    document.getElementById('downform').innerHTML = '';
  };

  const manual = window.mstreamIsManualMode ? await window.mstreamIsManualMode() : false;
  if (!manual) { return fallback(); }

  // Manual mode: resolve the m3u into a file list via the existing
  // /file-explorer/m3u endpoint, then sync each track to the local folder.
  try {
    const server = MSTREAMAPI.currentServer;
    const body = new URLSearchParams({ path: m3uPath });
    const res = await fetch(server.host + 'api/v1/file-explorer/m3u', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-access-token': server.token,
      },
    });
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    const { files, skipped } = await res.json();

    const parsed = (files || [])
      .map(f => window.mstreamParseRawFilePath(f.path))
      .filter(Boolean);

    if (parsed.length === 0) {
      iziToast.error({ title: 'No syncable tracks in playlist', position: 'topCenter', timeout: 3000 });
      return;
    }
    if (skipped) {
      iziToast.info({ title: `Skipped ${skipped} entries outside library`, position: 'topCenter', timeout: 2500 });
    }
    window.mstreamDownloadOrSync(parsed, fallback);
  } catch (e) {
    iziToast.error({ title: 'Failed to read playlist: ' + (e.message || e), position: 'topCenter', timeout: 3500 });
  }
}

function onSearchButtonClick() {
  // Hide Filepath
  document.getElementById('search_folders').classList.toggle('super-hide');
  // Show Search Input
  document.getElementById('directoryName').classList.toggle('super-hide');

  if (!document.getElementById('search_folders').classList.contains('super-hide')) {
    document.getElementById("localSearchBar").focus();
  } else {
    document.getElementById('localSearchBar').value = '';
    document.getElementById('localSearchBar').dispatchEvent(new Event('change'));
  }
}

async function onBackButton() {
  if (programState.length < 2) {
    return;
  }

  const thisState = programState.pop();
  const backState = programState[programState.length - 1];

  if (backState.state === 'allPlaylists') {
    await getAllPlaylists(undefined);
  } else if (backState.state === 'allAlbums') {
    await getAllAlbums(undefined);
  } else if (backState.state === 'allArtists') {
    await getAllArtists(undefined);
  } else if (backState.state === 'artist') {
    await getArtistsAlbums(backState.name);
  } else if (backState.state === 'allGenres') {
    await getAllGenres(undefined);
  } else if (backState.state === 'genre') {
    await getGenreSongs(backState.name);
  } else if (backState.state === 'fileExplorer') {
    fileExplorerArray.pop();
    await senddir();
  } else if (backState.state === 'searchPanel') {
    setupSearchPanel(backState.searchTerm, undefined);
  }

  // Fill in Search Bar
  if (backState.state !== 'searchPanel' &&  thisState.previousSearch) {
    document.getElementById('localSearchBar').value = thisState.previousSearch;
    document.getElementById('localSearchBar').dispatchEvent(new Event('keyup'));
  }

  // Scroll to position
  if (thisState.previousScroll) {
    document.getElementById('filelist').scrollTop = thisState.previousScroll;
  }
}

///////////////////// Playlists
async function getAllPlaylists() {
  setBrowserRootPanel(t('panel.playlists'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = `<input class="newPlaylistButton btn green" style="height:24px;" value="${t('label.newPlaylist')}" type="button" onclick="openNewPlaylistModal();">`;
  programState = [ {state: 'allPlaylists' }];

  try {
    const response = await MSTREAMAPI.getAllPlaylists();
    VUEPLAYERCORE.playlists.length = 0;
    document.getElementById('pop-f').innerHTML = `<div class="pop-f pop-playlist">${t('playlist.addToPlaylist')}</div>`;
    document.getElementById('live-playlist-select').innerHTML = `<option value="" disabled selected>${t('livePlaylist.selectPlaylist')}</option>`;

    // loop through the json array and make an array of corresponding divs
    let playlists = '<ul class="collection">';
    response.forEach(p => {
      playlists += renderPlaylist(p.name);
      const lol = { name: p.name, type: 'playlist' };
      currentBrowsingList.push(lol);
      VUEPLAYERCORE.playlists.push(lol);
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${p.name}')">&#8226; ${p.name}</div>`;
      document.getElementById('live-playlist-select').innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });
    playlists += '</ul>'

    document.getElementById('filelist').innerHTML = playlists;
  }catch (err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

function deletePlaylist(el) {
  const playlistname = decodeURIComponent(el.getAttribute('data-playlistname'));

  iziToast.question({
    timeout: 10000,
    close: false,
    overlayClose: true,
    overlay: true,
    displayMode: 'once',
    id: 'question',
    zindex: 99999,
    title: `Delete '${playlistname}'?`,
    position: 'center',
    buttons: [
        ['<button><b>Delete</b></button>', async (instance, toast) => {
          try {
            await MSTREAMAPI.deletePlaylist(playlistname)
            document.querySelector('li[data-playlistname="'+encodeURIComponent(playlistname)+'"]').remove();
          }catch(err) {
            boilerplateFailure(err);
          }
          instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
        }, true],
        ['<button>Go Back</button>', (instance, toast) => {
          instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
        }],
    ]
  });
}

async function onPlaylistClick(el) {
  try {
    const playlistname = decodeURIComponent(el.getAttribute('data-playlistname'));
    document.getElementById('directoryName').innerHTML = 'Playlist: ' + playlistname;
    document.getElementById('filelist').innerHTML = getLoadingSvg();
    currentBrowsingList = [];
    programState.push({
      state: 'playlist',
      name: playlistname,
      previousScroll: document.getElementById('filelist').scrollTop,
      previousSearch: document.getElementById('localSearchBar').value
    });
    document.getElementById('localSearchBar').value = '';
    const response = await MSTREAMAPI.loadPlaylist(playlistname);

    // Add the playlist name to the modal
    document.getElementById('playlist_name').value = playlistname;

    let files = '';
    response.forEach(value => {
      currentBrowsingList.push({
        type: 'file',
        name: (!value.metadata || !value.metadata.title) ? value.filepath : `${value.metadata.artist} - ${value.metadata.title}`,
        metadata: value.metadata,
        filepath: value.filepath,
        lokiId: value.lokiId
      });

      files += renderFileWithMetadataHtml(value.filepath, value.lokiId, value.metadata);
    });

    document.getElementById('filelist').innerHTML = files;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    boilerplateFailure(response, error);
  }
}

function removePlaylistSong(el) {
  try {
    const lokiId = el.getAttribute('data-lokiid');
    MSTREAMAPI.removePlaylistSong(lokiId);

    // remove from currentBrowsingList
    currentBrowsingList = currentBrowsingList.filter(item =>{
      return item.lokiId !== lokiId
    });

    document.querySelector(`li[data-lokiid="${lokiId}"]`).remove();
  }catch(err) {
    return boilerplateFailure(err);
  }
}

async function newPlaylist() {
  document.getElementById('new_playlist').disabled = true;
  try {
    const title = document.getElementById('new_playlist_name').value;
    await MSTREAMAPI.newPlaylist(title);
    myModal.close();
    iziToast.success({
      title: t('toast.playlistCreated'),
      position: 'topCenter',
      timeout: 3000
    });

    document.getElementById("newPlaylistForm").reset(); 
    VUEPLAYERCORE.playlists.push({ name: title, type: 'playlist'});
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${title}')">&#8226; ${title}</div>`;
    document.getElementById('live-playlist-select').innerHTML += `<option value="${title}">${title}</option>`;
  
    if (programState[0].state === 'allPlaylists') {
      getAllPlaylists();
    }
  }catch (err) {
    boilerplateFailure(err);
  }
  document.getElementById('new_playlist').disabled = false;
}

async function setLivePlaylist() {
  try{
    document.getElementById('set_live_playlist').disabled = true;

    if (VUEPLAYERCORE.livePlaylist.name !== false) {
      VUEPLAYERCORE.livePlaylist.name = false;
      document.getElementById('set_live_playlist').classList.remove('blue');
      document.getElementById('set_live_playlist').classList.add('green');
      document.getElementById('set_live_playlist').value = 'Enable Live Playlist';
      document.getElementById('live-playlist-hide-these').hidden = false;
      myModal.close();
      return;
    } 

    let livePlaylistName;

    if (document.getElementById('radio-use-existing').checked === true) {
      if (document.getElementById('live-playlist-select').value === "") {
        const err = new Error('No Playlist Selected');
        err.responseJSON = { error: 'No Playlist Selected' };
        throw err;
      }
      livePlaylistName = document.getElementById('live-playlist-select').value;
    } else {
      if (document.getElementById('new-live-playlist-name').value === "") {
        const err = new Error('Playlist Name Required');
        err.responseJSON = { error: 'Playlist Name Required' };
        throw err;
      }
      livePlaylistName = document.getElementById('new-live-playlist-name').value;
    }

    // check if checkbox is checked
    if(document.getElementById('persist_live_queue').checked === true) {
      localStorage.setItem('live-playlist-auto-start', livePlaylistName)
    } else {
      localStorage.removeItem('live-playlist-auto-start');
    }

    // set live var
    VUEPLAYERCORE.livePlaylist.name = livePlaylistName;

    // get current playlist
    const response = await MSTREAMAPI.loadPlaylist(VUEPLAYERCORE.livePlaylist.name);

    // set the queue to the current playlist
    if (response.length > 0) {
      MSTREAMPLAYER.clearPlaylist();
      response.forEach(value => {
        VUEPLAYERCORE.addSongWizard(value.filepath, value.metadata, false, undefined, false, true);
      });  
    } else {
      // save current queue
      const songs = [];
      for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
        songs.push(MSTREAMPLAYER.playlist[i].filepath);
      }
      MSTREAMAPI.savePlaylist(livePlaylistName, songs, true);
    }

    document.getElementById('set_live_playlist').classList.remove('green');
    document.getElementById('set_live_playlist').classList.add('blue');
    document.getElementById('set_live_playlist').value = 'Disable Live Playlist';
    document.getElementById('live-playlist-hide-these').hidden = true;

    // close modal
    myModal.close();
  } catch(err) {
    boilerplateFailure(err);
  } finally {
    document.getElementById('set_live_playlist').disabled = false;
  }
}

async function savePlaylist() {
  if (MSTREAMPLAYER.playlist.length == 0) {
    iziToast.warning({
      title: t('toast.noPlaylistToSave'),
      position: 'topCenter',
      timeout: 3500
    });
    return;
  }

  try {
    document.getElementById('save_playlist').disabled = true;
    const title = document.getElementById('playlist_name').value;
  
    //loop through array and add each file to the playlist
    const songs = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      songs.push(MSTREAMPLAYER.playlist[i].filepath);
    }

    MSTREAMAPI.savePlaylist(title,songs);

    myModal.close();
    iziToast.success({
      title: t('toast.playlistSaved'),
      position: 'topCenter',
      timeout: 3000
    });

    if (programState[0].state === 'allPlaylists') {
      getAllPlaylists();
    }

    VUEPLAYERCORE.playlists.push({ name: title, type: 'playlist'});
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${title}')">&#8226; ${title}</div>`;
    document.getElementById('live-playlist-select').innerHTML += `<option value="${title}">${title}</option>`;
  }catch(err) {
    boilerplateFailure(err);
  } finally {
    document.getElementById('save_playlist').disabled = false;
  }
}

/////////////// Artists
async function getAllArtists() {
  setBrowserRootPanel(t('panel.artists'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allArtists' }];

  try {
    const response = await MSTREAMAPI.artists({
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    });

    // parse through the json array and make an array of corresponding divs
    let artists = '<ul class="collection">';
    response.artists.forEach(value => {
      artists += renderArtist(value);
      currentBrowsingList.push({ type: 'artist', name: value });
    });
    artists += '</ul>';

    document.getElementById('filelist').innerHTML = artists;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    boilerplateFailure(err);
  }
}

function getArtistz(el) {
  const artist = el.getAttribute('data-artist');
  programState.push({
    state: 'artist',
    name: artist,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  });

  getArtistsAlbums(artist)
}

async function getArtistsAlbums(artist) {
  setBrowserRootPanel(t('panel.albums'));
  document.getElementById('directoryName').innerHTML = t('label.artist') + ' ' + artist;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  try {
    const response = await MSTREAMAPI.artistAlbums({
      artist: artist,
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    });

    let albums = '<div class="album-grid">';
    response.albums.forEach(value => {
      const albumString = value.name ? value.name : 'SINGLES';
      albums += renderAlbum(value.name, value.name === null ? artist : null, albumString, value.album_art_file, value.year);
      currentBrowsingList.push({ type: 'album', name: value.name, artist: artist, album_art_file: value.album_art_file })
    });
    albums += '</div>';

    document.getElementById('filelist').innerHTML = albums;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    boilerplateFailure(err);
  }
}

/////////////// Genres
async function getAllGenres() {
  setBrowserRootPanel(t('panel.genres'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allGenres' }];

  try {
    const response = await MSTREAMAPI.genres();

    let html = '<ul class="collection">';
    response.genres.forEach(value => {
      html += `<li class="collection-item">
        <div data-genre="${value.name.replace(/"/g, '&quot;')}" class="artistz" onclick="getGenreSongsList(this)">
          ${value.name} <span style="color:#888;font-size:13px;">(${value.track_count})</span>
        </div>
      </li>`;
      currentBrowsingList.push({ type: 'genre', name: value.name });
    });
    html += '</ul>';

    document.getElementById('filelist').innerHTML = html;
  } catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
  }
}

function getGenreSongsList(el) {
  const genre = el.getAttribute('data-genre');
  programState.push({
    state: 'genre',
    name: genre,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  });
  getGenreSongs(genre);
}

async function getGenreSongs(genre) {
  setBrowserRootPanel(t('panel.songs'));
  document.getElementById('directoryName').innerHTML = t('label.genre') + ' ' + genre;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  try {
    const response = await MSTREAMAPI.genreSongs({ genre: genre });

    let songs = '<ul class="collection">';
    response.forEach(song => {
      currentBrowsingList.push({ type: 'file', name: song.metadata.title ? song.metadata.title : song.filepath.split('/').pop() });
      songs += createMusicFileHtml(
        song.filepath,
        song.metadata.title ? song.metadata.title : song.filepath.split('/').pop(),
        undefined,
        undefined,
        song.metadata.artist ? song.metadata.artist : undefined
      );
    });
    songs += '</ul>';

    document.getElementById('filelist').innerHTML = songs;
  } catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
  }
}

/////////////// Albums
async function getAllAlbums() {
  setBrowserRootPanel(t('panel.albums'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  
  programState = [{ state: 'allAlbums' }];

  try {
    const response = await MSTREAMAPI.albums({
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    });

    let albums = '<div class="album-grid">';
    response.albums.forEach(value => {
      currentBrowsingList.push({
        type: 'album',
        name: value.name,
        'album_art_file': value.album_art_file
      });

      albums += renderAlbum(value.name, undefined, value.name, value.album_art_file, value.year);
    });
    albums += '</div>'

    document.getElementById('filelist').innerHTML = albums;
  }catch (err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

function getAlbumsOnClick(el) {
  getAlbumSongs(
    el.hasAttribute('data-album') ? el.getAttribute('data-album') : null,
    el.hasAttribute('data-artist') ? el.getAttribute('data-artist') : null,
    el.hasAttribute('data-year') ? el.getAttribute('data-year') : null);
}

async function getAlbumSongs(album, artist, year) {
  document.getElementById('directoryName').innerHTML = 'Album: ' + album;

  programState.push({
    state: 'album',
    name: album,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  });

  //clear the list
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  currentBrowsingList = [];

  document.getElementById('localSearchBar').value = '';

  try {
    const response = await MSTREAMAPI.albumSongs({
      album,
      artist,
      year,
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    });
  
    //parse through the json array and make an array of corresponding divs
    let files = '<ul class="collection">';
    response.forEach(song => {
      currentBrowsingList.push({ type: 'file', name: song.metadata.title ? song.metadata.title : song.metadata.filename });
      files += createMusicFileHtml(song.filepath, song.metadata.title ? song.metadata.title : song.metadata.filename, undefined, undefined, song.metadata.artist ? song.metadata.artist : undefined);
    });
    files += '</ul>';

    document.getElementById('filelist').innerHTML = files;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    boilerplateFailure(err);
  }
}

////////////// Rated Songs
async function getRatedSongs() {
  setBrowserRootPanel(t('panel.starred'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allRated' }];

  try {
    const response = await MSTREAMAPI.getRated({
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    });
    //parse through the json array and make an array of corresponding divs
    let files = '';
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

      files += createMusicFileHtml(value.filepath,
        value.metadata.title ? value.metadata.title : value.filepath.split('/').pop(), 
        value.metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${value.metadata['album-art']}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        rating,
        value.metadata.artist ? `<span style="font-size:15px;">${value.metadata.artist}</span>` : '');
    });

    document.getElementById('filelist').innerHTML = files;
  }catch (err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

///////////////// Recently Played
function getRecentlyPlayed() {
  setBrowserRootPanel(t('panel.recentlyPlayed'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = `Get last &nbsp;&nbsp;<input onkeydown="submitRecentlyPlayed();" onfocusout="redoRecentlyPlayed();" id="recently-played-limit" class="recently-added-input" type="number" min="1" step="1" value="100">&nbsp;&nbsp; ${t('label.getLastSongs', { count: 2 })}`;

  redoRecentlyPlayed();
}

async function redoRecentlyPlayed() {
  currentBrowsingList = [];
  programState = [{ state: 'recentlyPlayed'}];

  try {
    const response = await MSTREAMAPI.getRecentlyPlayed(
      document.getElementById('recently-played-limit').value,
      Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }));

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop()
      });

      filelist += createMusicFileHtml(el.filepath,
        el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop(),
        el.metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${el.metadata['album-art']}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        undefined,
        el.metadata.artist ? `<span style="font-size:15px;">${el.metadata.artist}</span>` : '');
    });

    filelist += '</ul>'
  
    document.getElementById('filelist').innerHTML = filelist;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

function submitRecentlyPlayed() {
  if (event.keyCode === 13) {
    document.getElementById("recently-played-limit").blur();
  }
}

///////////////// Most Played
function getMostPlayed() {
  setBrowserRootPanel(t('panel.mostPlayed'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = `Get last &nbsp;&nbsp;<input onkeydown="submitMostPlayed();" onfocusout="redoMostPlayed();" id="most-played-limit" class="recently-added-input" type="number" min="1" step="1" value="100">&nbsp;&nbsp; ${t('label.getLastSongs', { count: 2 })}`;

  redoMostPlayed();
}

async function redoMostPlayed() {
  currentBrowsingList = [];
  programState = [{ state: 'mostPlayed'}];

  try {
    const response = await MSTREAMAPI.getMostPlayed(
      document.getElementById('most-played-limit').value,
      Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }));

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop()
      });

      filelist += createMusicFileHtml(el.filepath,
        el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop(),
        el.metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${el.metadata['album-art']}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        undefined,
        el.metadata.artist ? `<span style="font-size:15px;">${el.metadata.artist} [${el.metadata['play-count']} plays]</span>` : `<span style="font-size:15px;">[${el.metadata['play-count']} plays]</span>`);
    });

    filelist += '</ul>'
  
    document.getElementById('filelist').innerHTML = filelist;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

function submitMostPlayed() {
  if (event.keyCode === 13) {
    document.getElementById("most-played-limit").blur();
  }
}

///////////////// Recently Added
function getRecentlyAdded() {
  setBrowserRootPanel(t('panel.recentlyAdded'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = `Get last &nbsp;&nbsp;<input onkeydown="submitRecentlyAdded();" onfocusout="redoRecentlyAdded();" id="recently-added-limit" class="recently-added-input" type="number" min="1" step="1" value="100">&nbsp;&nbsp; ${t('label.getLastSongs', { count: 2 })}`;

  redoRecentlyAdded();
}

async function redoRecentlyAdded() {
  currentBrowsingList = [];
  programState = [{ state: 'recentlyAdded'}];

  try {
    const response = await MSTREAMAPI.getRecentlyAdded(
      document.getElementById('recently-added-limit').value,
      Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }));

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop()
      });

      filelist += createMusicFileHtml(el.filepath,
        el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop(),
        el.metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${el.metadata['album-art']}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        undefined,
        el.metadata.artist ? `<span style="font-size:15px;">${el.metadata.artist}</span>` : '');
    });

    filelist += '</ul>'
  
    document.getElementById('filelist').innerHTML = filelist;
  }catch(err) {
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
    return boilerplateFailure(err);
  }
}

function submitRecentlyAdded() {
  if (event.keyCode === 13) {
    document.getElementById("recently-added-limit").blur();
  }
}

///////////////// Transcode
function setupTranscodePanel(){
  setBrowserRootPanel(t('panel.transcode'), false);

  if (!MSTREAMPLAYER.transcodeOptions.serverEnabled) {
    document.getElementById('filelist').innerHTML = '<div class="pad-6"><b>Transcoding is disabled on this server</b></div>';
    return;
  }

  document.getElementById('filelist').innerHTML = `
    <div class="browser-panel">
      <div>
        <label for="enable_transcoding_locally">
          <input type="checkbox" class="filled-in" onchange="toggleTranscoding(this);" id="enable_transcoding_locally" 
          name="transcode" ${MSTREAMPLAYER.transcodeOptions.frontendEnabled ? 'checked' : ''}/>
          <span>Enable Transcoding</span>
        </label>
      </div>
      <p>
        Default Codec:<br> <b>${MSTREAMPLAYER.transcodeOptions.defaultCodec} ${MSTREAMPLAYER.transcodeOptions.defaultBitrate}</b>
      </p>
      <form>
        <label for="trans-codec-select">Codec</label>
        <select onchange="changeTranscodeCodec();" class="browser-default trans-input" name="pets" id="trans-codec-select">
          <option value="">Default</option>
          <option value="opus">Opus OGG</option>
          <option value="mp3">mp3</option>
          <option value="aac">AAC</option>
        </select>
        <br>
        <label for="trans-bitrate-select">Bit Rate</label>
        <select onchange="changeTranscodeBitrate();" class="browser-default trans-input" name="pets" id="trans-bitrate-select">
          <option value="">Default</option>
          <option value="64k">64k</option>
          <option value="96k">96k</option>
          <option value="128k">128k</option>
          <option value="192k">192k</option>
        </select>
      </form>
    </div>`;

  document.getElementById('trans-codec-select').value = MSTREAMPLAYER.transcodeOptions.selectedCodec ? MSTREAMPLAYER.transcodeOptions.selectedCodec : "";
  document.getElementById('trans-bitrate-select').value = MSTREAMPLAYER.transcodeOptions.selectedBitrate ? MSTREAMPLAYER.transcodeOptions.selectedBitrate : "";
}

function changeTranscodeBitrate() {
  const value = document.getElementById("trans-bitrate-select").value;
  MSTREAMPLAYER.transcodeOptions.selectedBitrate = value ? value : null;
  value ? localStorage.setItem('trans-bitrate-select', value) : localStorage.removeItem('trans-bitrate-select');
}

function changeTranscodeCodec() {
  const value = document.getElementById("trans-codec-select").value;
  MSTREAMPLAYER.transcodeOptions.selectedCodec = value ? value : null;
  value ? localStorage.setItem('trans-codec-select', value) : localStorage.removeItem('trans-codec-select');
}

function toggleTranscoding(el, manual){
  // checkbox button while we convert the playlist
  if (el) { el.disabled = true; }

  const checked = manual || el.checked;

  const a = checked ? 'media/' : 'transcode/';
  const b = checked ? 'transcode/' : 'media/';

  document.getElementById("ffmpeg-logo").style.stroke = checked ? '#388E3C' : '#DDD';
  MSTREAMPLAYER.transcodeOptions.frontendEnabled  = checked ? true : false;

  localStorage.setItem('transcode', checked ? true : false);

  // Convert playlist
  for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
    MSTREAMPLAYER.playlist[i].url = MSTREAMPLAYER.playlist[i].url.replace(a, b);
  }

  // re-enable checkbox
  if (el) { el.disabled = false; }
}

///////////////////////////// Mobile Stuff
function getMobilePanel(){
  setBrowserRootPanel(t('panel.mobileApps'), false);

  document.getElementById('filelist').innerHTML = 
    `<div class="mobile-links pad-6">
      <a target="_blank" href="https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1">
        <img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png'/>
      </a>
    </div>
    <div class="mobile-links pad-6">
      <a target="_blank" href="https://apps.apple.com/us/app/mstream-player/id1605378892">
        <img alt='Get it on The App Store' src='assets/img/app-store-logo.png'/>
      </a>
    </div>
    <br>
    <div class="pad-6">
      <a target="_blank" href="/qr"><b>Checkout the QR Code tool to help add your server to the app</b></a>
    </div>`;
}

//////////////////////////  Share playlists
async function submitShareForm() {
  try {
    document.getElementById('share_it').disabled = true;
    const shareTimeInDays = document.getElementById('share_time').value;
  
    //loop through array and add each file to the playlist
    const stuff = [];
    for (let i = 0; i < MSTREAMPLAYER.playlist.length; i++) {
      stuff.push(MSTREAMPLAYER.playlist[i].filepath);
    }
  
    if (stuff.length == 0) {
      document.getElementById('share_it').disabled = false;
      return;
    }
    
    const response = await MSTREAMAPI.makeShared(stuff, shareTimeInDays);
    const adrs = window.location.protocol + '//' + window.location.host + '/shared/' + response.playlistId;
    document.getElementById('share-textarea').value = adrs;
  }catch (err) {
    boilerplateFailure(err);
  }

  document.getElementById('share_it').disabled = false;
}

///////////////// Auto DJ
function autoDjPanel() {
  setBrowserRootPanel(t('panel.autoDJ'), false);

  let newHtml = `<div class="pad-6"><p>${t('autoDJ.description')}</p>
    <h5>${t('autoDJ.useFolders')}</h5>`;
  for (let i = 0; i < MSTREAMAPI.currentServer.vpaths.length; i++) {
    let checkedString = '';
    if (!MSTREAMPLAYER.ignoreVPaths[MSTREAMAPI.currentServer.vpaths[i]]) {
      checkedString = 'checked';
    }
    newHtml += `
      <label for="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}">
        <input ${checkedString} id="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}" type="checkbox"
          value="${MSTREAMAPI.currentServer.vpaths[i]}" name="autodj-folders" onchange="onAutoDJFolderChange(this)">
        <span>${MSTREAMAPI.currentServer.vpaths[i]}</span>
      </label><br>`;
  }

  newHtml += `<h5>${t('autoDJ.minRating')}</h5> <select class="browser-default" onchange="updateAutoDJRatings(this)" id="autodj-ratings">`;
  for (let i = 0; i < 11; i++) {
    newHtml += `<option ${(Number(MSTREAMPLAYER.minRating) === i) ? 'selected' : ''} value="${i}">${(i ===0) ? t('label.disabled') : +(i/2).toFixed(1)}</option>`;
  }
  newHtml += '</select>';
  newHtml += `<br><p><input type="button" class="btn blue" value="${t('autoDJ.toggleButton')}" onclick="MSTREAMPLAYER.toggleAutoDJ();"></p></div>`
  
  document.getElementById('filelist').innerHTML = newHtml;
}

function onAutoDJFolderChange(el) {
  // Don't allow user to deselect all options
  if (document.querySelector('input[name=autodj-folders]:checked') === null) {
    el.checked = true;
    iziToast.warning({
      title: t('toast.autoDJRequiresDir'),
      position: 'topCenter',
      timeout: 3500
    });
    return;
  }

  if (el.checked) {
    MSTREAMPLAYER.ignoreVPaths[el.value] = false;
  } else {
    MSTREAMPLAYER.ignoreVPaths[el.value] = true;
  }

  localStorage.setItem('ignoreVPaths', JSON.stringify(MSTREAMPLAYER.ignoreVPaths));
}

function updateAutoDJRatings(el) {
  MSTREAMPLAYER.minRating = el.value;
  localStorage.setItem('minRating', JSON.stringify([MSTREAMPLAYER.minRating]));
}

////////////// Jukebox
function setupJukeboxPanel() {
  setBrowserRootPanel(t('panel.jukeboxMode'), false);

  let newHtml;
  if (JUKEBOX.stats.live !== false && JUKEBOX.connection !== false) {
    newHtml = createJukeboxPanel();
  } else {
    newHtml = `
      <div class="pad-6">
        <h5>${t('jukebox.title')}</h5>
        <p style="color:#aaa;">${t('jukebox.description')}</p>
        <input class="btn green" value="${t('jukebox.connect')}" type="button" onclick="connectToJukeBox(this)">
        <div style="margin-top:28px; padding-top:20px; border-top:1px solid #444;">
          <h5>${t('jukebox.serverAudio')}</h5>
          <p style="color:#aaa;">${t('jukebox.serverAudioDescription')}</p>
          <a class="btn blue" href="/server-remote" target="_blank">${t('jukebox.openServerAudio')}</a>
        </div>
      </div>`;
  }

  // Add the content
  document.getElementById('filelist').innerHTML = newHtml;
}

function createJukeboxPanel() {
  if (JUKEBOX.stats.error !== false) {
    return `<div class="pad-6">${t('error.genericError')}</div>`;
  }

  let address = '';
  if(MSTREAMAPI.currentServer.host) {
    address = `${MSTREAMAPI.currentServer.host}remote/${JUKEBOX.stats.adminCode}`;
  }else {
    address = `${window.location.protocol}//${window.location.host}/remote/${JUKEBOX.stats.adminCode}`;
  }

  // const address = `${window.location.protocol}//${window.location.host}/remote/${JUKEBOX.stats.adminCode}`;
  return `<div class="autoselect pad-6">
    <h4>Code: ${JUKEBOX.stats.adminCode}</h4>
    <h4><a target="_blank" href="${address}">${address}</a><h4>
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

//////////////////////// Local Search
function runLocalSearch(el) {
  // Do nothing if we are in the search panel
  if (document.getElementById('db-search')) {
    return;
  }

  const searchVal = el.value;
  let filelist = '';
  currentBrowsingList.forEach(x => {
    const lowerCase = x.name !== null ? x.name.toLowerCase() : 'null';
    if (lowerCase.indexOf(searchVal.toLowerCase()) !== -1) {
      if (x.type === 'directory') {
        filelist += renderDirHtml(x.name);
      } else if (x.type === 'playlist') {
        filelist += renderPlaylist(x.name);
      } else if (x.type === 'album') {
        const albumString = x.name  ? x.name  : 'SINGLES';
        filelist += renderAlbum(x.name, x.name === null ? x.artist : null, albumString, x.album_art_file);
      } else if (x.type === 'artist') {
        filelist += renderArtist(x.name);
      } else {
        if (programState[programState.length - 1].state === 'playlist') {
          filelist += renderFileWithMetadataHtml(x.filepath, x.lokiId, x.metadata);
        } else if (x.type == "m3u") {
          filelist += createFileplaylistHtml(x.name);
        } else {
          const fileLocation = x.path || getFileExplorerPath() + x.name;
          const title = x.artist != null || x.title != null ? x.artist + ' - ' + x.title : x.name;
          filelist += createMusicFileHtml(fileLocation, title);
        }
      }
    }
  });

  document.getElementById('filelist').innerHTML= filelist;
}

//////////////////////// Search
const searchToggles = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('mstream-search-toggles'));
    if (saved && typeof saved === 'object') { return saved; }
  } catch (_e) {}
  return { albums: true, artists: true, files: false, titles: true };
})();

const searchMap = {
  albums: {
    name: 'Album',
    class: 'albumz',
    data: 'album',
    func: 'getAlbumsOnClick'
  },
  artists: {
    name: 'Artist',
    class: 'artistz',
    data: 'artist',
    func: 'getArtistz'
  },
  files: {
    name: 'File',
    class: 'filez',
    data: 'file_location',
    func: 'onFileClick'
  },
  title: {
    name: 'Song',
    class: 'filez',
    data: 'file_location',
    func: 'onFileClick'
  }
};

function setupSearchPanel(searchTerm) {
  setBrowserRootPanel(t('panel.searchDB'));
  document.getElementById('local_search_btn').style.display = 'none';
  programState = [{ state: 'searchPanel' }];

  let valString = '';
  if (searchTerm) { valString = `value="${searchTerm}"`; }

  document.getElementById('filelist').innerHTML = 
    `<div>
      <form id="db-search" action="javascript:submitSearchForm()" class="flex">
        <input ${valString} id="search-term" required type="text" placeholder="Search Database">
        <!-- <button type="submit" class="searchButton">
          <svg fill="#DDD" viewBox="-150 -50 1224 1174" height="24px" width="24px" xmlns="http://www.w3.org/2000/svg"><path d="M960 832L710.875 582.875C746.438 524.812 768 457.156 768 384 768 171.969 596 0 384 0 171.969 0 0 171.969 0 384c0 212 171.969 384 384 384 73.156 0 140.812-21.562 198.875-57L832 960c17.5 17.5 46.5 17.375 64 0l64-64c17.5-17.5 17.5-46.5 0-64zM384 640c-141.375 0-256-114.625-256-256s114.625-256 256-256 256 114.625 256 256-114.625 256-256 256z"></path></svg>
        </button> -->
      </form>
    </div>
    <div class="flex">
      <label class="grow" for="search-in-artists">
        <input ${(searchToggles.artists === true ? 'checked' : '')} id="search-in-artists" class="filled-in" type="checkbox">
        <span>Artists</span>
      </label>
      <label class="grow" for="search-in-albums">
        <input ${(searchToggles.albums === true ? 'checked' : '')} id="search-in-albums" class="filled-in" type="checkbox">
        <span>Albums</span>
      </label>
      <label class="grow" for="search-in-titles">
        <input ${(searchToggles.titles === true ? 'checked' : '')} id="search-in-titles" class="filled-in" type="checkbox">
        <span>Song Titles</span>
      </label>
      <label class="grow" for="search-in-filepaths">
        <input ${(searchToggles.files === true ? 'checked' : '')} id="search-in-filepaths" class="filled-in" type="checkbox">
        <span>File Paths</span>
      </label>
    </div>
    <div id="search-results"></div>`;

  document.getElementById('search_folders').value = '';
  document.getElementById('search_folders').dispatchEvent(new Event('change'));

  if (searchTerm) {
    submitSearchForm();
  }
}

async function submitSearchForm() {
  try {
    document.getElementById('search-results').innerHTML += '<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>'

    const postObject = {
      search: document.getElementById('search-term').value,
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      })
    };
    
    if (document.getElementById("search-in-artists") && document.getElementById("search-in-artists").checked === false) { postObject.noArtists = true; }
    searchToggles.artists = document.getElementById("search-in-artists").checked;
    if (document.getElementById("search-in-albums") && document.getElementById("search-in-albums").checked === false) { postObject.noAlbums = true; }
    searchToggles.albums = document.getElementById("search-in-albums").checked;
    if (document.getElementById("search-in-filepaths") && document.getElementById("search-in-filepaths").checked === false) { postObject.noFiles = true; }
    searchToggles.files = document.getElementById("search-in-filepaths").checked;
    if (document.getElementById("search-in-titles") && document.getElementById("search-in-titles").checked === false) { postObject.noTitles = true; }
    searchToggles.titles = document.getElementById("search-in-titles").checked;

    try { localStorage.setItem('mstream-search-toggles', JSON.stringify(searchToggles)); } catch (_e) {}

    const res = await MSTREAMAPI.search(postObject);

    if (programState[0].state === 'searchPanel') {
      programState[0].searchTerm = postObject.search;
    }

    let noResultsFlag = true;

    // Populate list
    let searchList = '<ul class="collection">';
    Object.keys(res).forEach((key) => {
      res[key].forEach((value, i) => {
        noResultsFlag = false;

        // perform some operation on a value;
        searchList += `<li class="collection-item">
          <div onclick="${searchMap[key].func}(this);" data-${searchMap[key].data}="${value.filepath ? value.filepath : value.name}" class="${searchMap[key].class} left">
            <b>${searchMap[key].name}:</b> ${value.name}
          </div>
          ${
            key === 'files' || key === 'title' ? `<div class="song-button-box">
            <span title="Play Now" onclick="playNow(this);" data-file_location="${value.filepath}" class="songDropdown">
              <svg xmlns="http://www.w3.org/2000/svg" height="12" width="12" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
            </span>
            <span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${value.filepath}" class="fileAddToPlaylist">
              <svg class="pop-f" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-f" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
            </span>
          </div>` : ''
          }
        </li>`;
      });
    });

    searchList += '</ul>'
    
    if (noResultsFlag === true) {
      searchList = '<h5>No Results Found</h5>';
    }

    document.getElementById('search-results').innerHTML = searchList;
  }catch(err) {
    boilerplateFailure(err);
  }
}

///////////////// Config
function advancedConfig() {
  setBrowserRootPanel(t('panel.config'), false);

  let newHtml = `<div class="pad-6">
    <h5>${t('autoDJ.useFolders')}</h5>
    <p>${t('autoDJ.uncheckedHint')}</p>`;
  
  for (let i = 0; i < MSTREAMAPI.currentServer.vpaths.length; i++) {
    let checkedString = '';
    if (!MSTREAMPLAYER.ignoreVPaths[MSTREAMAPI.currentServer.vpaths[i]]) {
      checkedString = 'checked';
    }
    newHtml += `
      <label for="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}">
        <input ${checkedString} id="autodj-folder-${MSTREAMAPI.currentServer.vpaths[i]}" type="checkbox"
          value="${MSTREAMAPI.currentServer.vpaths[i]}" name="autodj-folders" onchange="onAutoDJFolderChange(this)">
        <span>${MSTREAMAPI.currentServer.vpaths[i]}</span>
      </label><br>`;
  }

  document.getElementById('filelist').innerHTML = newHtml;
}


////////////////// Layout
function setupLayoutPanel() {
  setBrowserRootPanel(t('panel.layout'), false);
  programState = [{ state: 'layout' }];

  const newHtml = `
    <div>
      <div class="switch">
        <label>
          <input onchange="tglBookCtrls(this);" type="checkbox" ${VUEPLAYERCORE.altLayout.audioBookCtrls === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.audioBookControls')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="flipPlayer(this);" type="checkbox" ${VUEPLAYERCORE.altLayout.flipPlayer === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.playerOnBottom')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="tglMoveMetadata(this);" type="checkbox" ${VUEPLAYERCORE.altLayout.moveMeta === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.metadataInQueue')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="tglCompressArt();" type="checkbox" ${VUEPLAYERCORE.altLayout.compressArt === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.compressAlbumArt')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="tglHideTopBar();" type="checkbox" ${VUEPLAYERCORE.altLayout.hideTopBar === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.hideTopBar')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="tglWaveformBar();" type="checkbox" ${VUEPLAYERCORE.altLayout.waveformBar === true ? 'checked' : ''}>
          <span class="lever"></span>
          Waveform Progress Bar
        </label>
      </div>
      <br>
      <!-- <div class="switch">
        <label>
          <input type="checkbox">
          <span class="lever"></span>
          Single Browser
        </label>
      </div>
      <br> -->
      <!-- <div class="switch">
        <label>
          <input type="checkbox">
          <span class="lever"></span>
          Light Mode
        </label>
      </div> -->
      <br>
      <label>${t('settings.language')}</label>
      <select class="browser-default" id="lang-select" onchange="changeLanguage(this.value)">
      </select>
    </div>`;

  // Add the content
  document.getElementById('filelist').innerHTML = newHtml;

  // Populate language selector
  fetch('locales/languages.json').then(r => r.json()).then(langs => {
    const sel = document.getElementById('lang-select');
    const cur = I18N.getLanguage();
    Object.entries(langs).forEach(([code, name]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name;
      if (code === cur) { opt.selected = true; }
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

async function changeLanguage(lang) {
  await I18N.loadLanguage(lang);
  setupLayoutPanel();
}

function tglMoveMetadata() {
  VUEPLAYERCORE.altLayout.moveMeta = !VUEPLAYERCORE.altLayout.moveMeta;
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function tglBookCtrls() {
  VUEPLAYERCORE.altLayout.audioBookCtrls = !VUEPLAYERCORE.altLayout.audioBookCtrls;
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function tglCompressArt() {
  VUEPLAYERCORE.altLayout.compressArt = !VUEPLAYERCORE.altLayout.compressArt;
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function flipPlayer() {
  VUEPLAYERCORE.altLayout.flipPlayer = !VUEPLAYERCORE.altLayout.flipPlayer;
  document.getElementById('content').classList.toggle('col-rev');
  document.getElementById('flip-me').classList.toggle('col-rev');

  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function tglHideTopBar() {
  VUEPLAYERCORE.altLayout.hideTopBar = !VUEPLAYERCORE.altLayout.hideTopBar;
  document.body.classList.toggle('top-bar-hidden', VUEPLAYERCORE.altLayout.hideTopBar);
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function tglWaveformBar() {
  VUEPLAYERCORE.altLayout.waveformBar = !VUEPLAYERCORE.altLayout.waveformBar;
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
  // If just enabled and a track is loaded but no waveform fetched yet, fetch now
  if (VUEPLAYERCORE.altLayout.waveformBar && MSTREAMPLAYER.playerStats.metadata.filepath) {
    VUEPLAYERCORE.triggerWaveformFetch(MSTREAMPLAYER.playerStats.metadata.filepath);
  }
}

// Re-render the Layout panel when the language changes externally (via the
// nav-bar dropdown, the sidenav-bottom dropdown, the admin panel, etc.).
// setupLayoutPanel builds its content via ${t(...)} interpolation at render
// time, so already-rendered switch labels go stale on language changes.
// translatePage() can't help because the template uses no data-i18n attributes.
//
// We use the existing `programState` panel-tracking stack to know which root
// panel is active — see the `programState = [{ state: '...' }]` lines in
// loadFileExplorer, getAllPlaylists, etc. setupLayoutPanel sets it to
// 'layout' so this listener can recognize when re-rendering is appropriate.
I18N.onChange(() => {
  if (programState[0] && programState[0].state === 'layout') {
    setupLayoutPanel();
  }
});


async function updateServer() {
  try {
    document.getElementById('save_server').disabled = true;

    let host = document.getElementById('server_address').value;
    if (host.slice(-1) !== '/') {
      host += '/';
    }

    const res = await MSTREAMAPI.login(document.getElementById('server_username').value,
      document.getElementById('server_password').value,
      host);

    MSTREAMAPI.currentServer.host = host;
    MSTREAMAPI.currentServer.username = document.getElementById('server_username').value;
    MSTREAMAPI.currentServer.token = res.token;
    if (window.mstreamSafeToken) { window.mstreamSafeToken.save(res.token); }

    myModal.close();

    init();
    loadFileExplorer();
    localStorage.setItem('current-server', JSON.stringify(MSTREAMAPI.currentServer)); 
    document.getElementById('server_password').value = '';
  }catch(err) {
    console.log(err)
    boilerplateFailure(err);
  }finally {
    document.getElementById('save_server').disabled = false;
  }
}

function isElectron() {
  return typeof navigator === 'object'
    && typeof navigator.userAgent === 'string'
    && navigator.userAgent.indexOf('Electron') >= 0;
}

function initElectron() {
  const navEl = document.getElementById('sidenav');

  // remove links
  navEl.removeChild( document.querySelector('#admin-side-link'));
  navEl.removeChild( document.querySelector('#logout-side-link'));

  // add link to edit server
  navEl.innerHTML += `<div class="side-nav-item my-waves" onclick="changeView(openEditModal, this);">
  <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#FFFFFF"><path d="M0 0h24v24H0z" fill="none"/><path d="M20.2 5.9l.8-.8C19.6 3.7 17.8 3 16 3s-3.6.7-5 2.1l.8.8C13 4.8 14.5 4.2 16 4.2s3 .6 4.2 1.7zm-.9.8c-.9-.9-2.1-1.4-3.3-1.4s-2.4.5-3.3 1.4l.8.8c.7-.7 1.6-1 2.5-1 .9 0 1.8.3 2.5 1l.8-.8zM19 13h-2V9h-2v4H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zM8 18H6v-2h2v2zm3.5 0h-2v-2h2v2zm3.5 0h-2v-2h2v2z"/></svg>
  <span>Edit Server</span>
  </div>`;

  // Desktop Player only: link to Sync Library modal (feature-gated on
  // preload API presence, so it's invisible if the preload didn't load).
  if (window.mstreamElectron) {
    navEl.innerHTML += `<div class="side-nav-item my-waves" onclick="changeView(openSyncLibraryModal, this);">
    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#FFFFFF"><path d="M0 0h24v24H0z" fill="none"/><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
    <span>Sync Library</span>
    </div>`;
  }

  try {
    const curServer = JSON.parse(localStorage.getItem("current-server"));
    console.log(curServer);
    if (curServer.host && curServer.token) {
      MSTREAMAPI.currentServer.host = curServer.host;
      MSTREAMAPI.currentServer.token = curServer.token;
      MSTREAMAPI.currentServer.username = curServer.username;
    }
  }catch(err) {}

  // check if server
  if (!MSTREAMAPI.currentServer.host) {
    openEditModal();
  }else {
    loadFileExplorer();
    init();
  }
    // if not edit server panel
}

if (isElectron()) {
  initElectron();
} else {
  init();
  loadFileExplorer();
}

// The sidenav dropdown must be populated AFTER initElectron()'s `innerHTML +=`
// runs (which re-serializes and re-parses the entire sidenav and would otherwise
// wipe dynamically-created child nodes). In non-Electron contexts this is a
// no-op because the sidenav is never mutated — we just populate normally.
if (typeof window.initSidenavLangDropdown === 'function') {
  window.initSidenavLangDropdown();
}
