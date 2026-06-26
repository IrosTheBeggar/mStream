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
      <span data-playlistname="${encodeURIComponent(playlistName)}" class="renamePlaylist" onclick="renamePlaylist(this);">Rename</span>
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

  // Legacy MSTREAMPLAYER.minRating boot-time hydrate removed — no
  // consumer reads that global anymore. The Auto-DJ rating filter
  // now reads AUTODJ.state.djMinRating directly. The legacy
  // localStorage `minRating` key is migrated to the new namespace
  // by `_autoDjMigrateLegacyKeys()` on first panel render.

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
}

// Scan progress display moved to webapp/alpha/scan-progress.js — that
// poller hits /api/v1/scan/progress unconditionally on a 3s interval and
// renders rich per-vpath cards. The old dbStatus() polled /api/v1/db/status
// only after seeing locked=true once, so a scan triggered post-page-load
// never appeared. Removed entirely.

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
  const tabs = {
    upload:  { btn: document.getElementById('tab_upload'),  pane: document.getElementById('tab_content_upload'),  focus: null },
    ytdl:    { btn: document.getElementById('tab_ytdl'),    pane: document.getElementById('tab_content_ytdl'),    focus: 'ytdl_url' },
    torrent: { btn: document.getElementById('tab_torrent'), pane: document.getElementById('tab_content_torrent'), focus: 'torrent_magnet' },
  };
  Object.entries(tabs).forEach(([name, t]) => {
    const active = name === tab;
    t.btn.style.borderBottomColor = active ? '#fff' : 'transparent';
    t.pane.classList.toggle('super-hide', !active);
  });
  const focusId = tabs[tab]?.focus;
  if (focusId) { document.getElementById(focusId).focus(); }
  if (tab === 'torrent') { runTorrentPreflight(); }
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

  // Reset torrent tab
  document.getElementById('torrent_file_input').value = '';
  document.getElementById('torrent_magnet').value = '';
  document.getElementById('torrent_directory').value = '';
  document.getElementById('torrent_file_name').textContent = '';
  document.getElementById('torrent_destination_preview').textContent = '';
  document.getElementById('torrent_preflight_msg').classList.add('super-hide');
  document.getElementById('torrent_rename_root').checked = false;
  delete document.getElementById('torrent_directory').dataset.autofilled;

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

// Track manual edits to the torrent directory so a later file pick
// doesn't clobber the user's typing, and refresh the destination
// preview as they type.
document.getElementById('torrent_directory').addEventListener('input', function(e) {
  e.target.dataset.autofilled = 'false';
  updateTorrentDestPreview();
});

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

// ── Torrent tab ───────────────────────────────────────────────────────
// The destination of a torrent is built from THREE pieces:
//   - the vpath the player's file-explorer is currently in
//   - any sub-path under that vpath (also from getFileExplorerPath())
//   - the directory name the user types here (auto-filled from the
//     torrent's own `name` field when a .torrent is picked)
// The backend re-derives the vpath + subPath from the path string we
// send, so the client doesn't need to split — just forward
// getFileExplorerPath() verbatim and let the server resolve.

// Pull the suggested name out of a .torrent file's info dict. Looks
// for `4:info<dict>` then for `4:name<len>:<value>` inside that dict.
// Browser-side: only the name is needed (server recomputes the info
// hash). Returns '' on any parse error — the user can still type their
// own directory name.
function extractTorrentName(uint8Array) {
  try {
    // Find the info dict start. The .torrent's top dict has keys
    // like "announce", "created by", "info", etc. — when serialised
    // alphabetically (per BEP-3 spec) `info` is generally late in
    // the byte stream. We scan for the literal bytes `4:info` (which
    // marks the key "info") and parse the dict that follows.
    const bytes = uint8Array;
    let i = 0;
    while (i < bytes.length - 8) {
      // Search for "4:info" → bytes 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f
      if (bytes[i] === 0x34 && bytes[i+1] === 0x3a &&
          bytes[i+2] === 0x69 && bytes[i+3] === 0x6e &&
          bytes[i+4] === 0x66 && bytes[i+5] === 0x6f) {
        // Confirm what follows is a dict opener `d` (0x64)
        if (bytes[i+6] !== 0x64) { i++; continue; }
        // Search inside the info dict for "4:name" the same way
        for (let j = i + 7; j < bytes.length - 8; j++) {
          if (bytes[j] === 0x34 && bytes[j+1] === 0x3a &&
              bytes[j+2] === 0x6e && bytes[j+3] === 0x61 &&
              bytes[j+4] === 0x6d && bytes[j+5] === 0x65) {
            // After "4:name" comes <len>:<utf8>
            let k = j + 6;
            let lenStr = '';
            while (k < bytes.length && bytes[k] !== 0x3a) {
              lenStr += String.fromCharCode(bytes[k]);
              k++;
            }
            const len = parseInt(lenStr, 10);
            if (!isFinite(len) || len <= 0 || len > 1024) { return ''; }
            const start = k + 1;
            return new TextDecoder('utf-8').decode(bytes.slice(start, start + len));
          }
        }
        return '';
      }
      i++;
    }
    return '';
  } catch (e) { return ''; }
}

function extractMagnetDn(uri) {
  try {
    if (!uri || !uri.startsWith('magnet:?')) { return ''; }
    const params = new URLSearchParams(uri.slice('magnet:?'.length));
    return params.get('dn') || '';
  } catch (e) { return ''; }
}

async function handleTorrentFile(file) {
  if (!file) { return; }
  document.getElementById('torrent_file_name').textContent = file.name;
  // Mutual exclusion with the magnet input
  document.getElementById('torrent_magnet').value = '';
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = extractTorrentName(buf);
    if (name) {
      const input = document.getElementById('torrent_directory');
      if (!input.value || input.dataset.autofilled === 'true') {
        input.value = name;
        input.dataset.autofilled = 'true';
        updateTorrentDestPreview();
      }
    }
  } catch (e) { /* silent — user can still type their own */ }
}

function handleMagnetInput(uri) {
  // Mutual exclusion with the file input
  if (uri) {
    document.getElementById('torrent_file_input').value = '';
    document.getElementById('torrent_file_name').textContent = '';
  }
  const dn = extractMagnetDn(uri.trim());
  if (dn) {
    const input = document.getElementById('torrent_directory');
    if (!input.value || input.dataset.autofilled === 'true') {
      input.value = dn;
      input.dataset.autofilled = 'true';
      updateTorrentDestPreview();
    }
  }
}

function updateTorrentDestPreview() {
  const preview = document.getElementById('torrent_destination_preview');
  if (!preview) { return; }
  const dir = document.getElementById('torrent_directory').value.trim();
  const base = window.__torrentPreflightDaemonPath || '<daemon path>';
  preview.textContent = dir ? `Daemon will write to: ${base}/${dir}` : '';
}

async function runTorrentPreflight() {
  const msg = document.getElementById('torrent_preflight_msg');
  const form = document.getElementById('torrent_form');
  const submitBtn = document.getElementById('torrent_submit');
  // Reset visibility from any prior run so an earlier "feature
  // disabled" state doesn't persist after the operator fixes config.
  form.classList.remove('super-hide');
  try {
    const filepath = getFileExplorerPath();
    const res = await MSTREAMAPI.torrentPreflight(filepath);
    const data = res.data || res;
    window.__torrentPreflightData = data;
    window.__torrentPreflightDaemonPath = data.daemonPath;
    updateTorrentDestPreview();
    if (data.vpathConfirmed && data.userAllowed && data.active && !data.noUpload) {
      msg.classList.add('super-hide');
      submitBtn.disabled = false;
      submitBtn.value = `Download via ${data.displayName}`;
      return;
    }
    // Feature-level gates (client not configured, uploads disabled,
    // user not whitelisted) hide the form — there's nothing actionable
    // for the user here, so the inputs would just be misleading.
    // Vpath-level gates (unconfirmed mapping, no vpath in path) keep
    // the form visible so the operator can navigate to a different
    // vpath without closing the modal.
    const featureGated = !data.active || data.noUpload || !data.userAllowed;
    msg.textContent = data.reason || 'Torrent feature is not available';
    msg.classList.remove('super-hide');
    submitBtn.disabled = true;
    form.classList.toggle('super-hide', featureGated);
  } catch (e) {
    msg.textContent = 'Could not check torrent feature status';
    msg.classList.remove('super-hide');
    submitBtn.disabled = true;
    form.classList.add('super-hide');
  }
}

// ── Seed-check helpers ─────────────────────────────────────────────
//
// Pre-flight a .torrent against the user's library: if the files
// are already on disk we short-circuit /torrent/add and just
// register the torrent for seeding. This is the sidebar Add Torrent
// panel's flow — the upload modal stays "dumb" and calls /add
// directly. The helpers below are parameterised by status-element
// ID + accept-handler name so a future second smart-panel can plug
// in without duplicating the rendering code.
//
// Per-surface state is carried via window globals (so the inline
// onclick on the [Use this path] button can reach the accept
// handler without a closure):
//   __torrentPartialMatches      matches[] from the last response
//   __torrentSeedAbortController in-flight controller (single)
//   __torrentUserVpathCount      cached for the spinner label
// Sidebar-specific "the user accepted this suggestion" state lives
// on window.__addTorrentState.seedPicked.

function _clearSeedStatus(statusElId) {
  const el = document.getElementById(statusElId);
  if (el) {
    el.innerHTML = '';
    el.classList.add('super-hide');
  }
  if (window.__torrentSeedAbortController) {
    try { window.__torrentSeedAbortController.abort(); } catch { /* swallow */ }
    window.__torrentSeedAbortController = null;
  }
}


function _showSeedSpinner(statusElId) {
  const el = document.getElementById(statusElId);
  if (!el) { return; }
  // Show the library count so the user knows the scope of the check.
  // window.__torrentUserVpathCount is set when either panel mounts
  // (runTorrentPreflight for the modal; setupAddTorrentPanel's
  // template-fetch for the sidebar). Fallback when not yet set.
  const n = window.__torrentUserVpathCount;
  const target = (typeof n === 'number' && n > 0)
    ? (n === 1 ? `your library` : `your ${n} libraries`)
    : 'your library';
  el.innerHTML = `
    <span style="display:inline-block; vertical-align:middle;">⏳</span>
    <span style="margin-left:6px;">Checking ${target} for existing files</span>
    <span class="torrent-seed-dots" style="display:inline-block; width:18px; text-align:left;">…</span>`;
  el.classList.remove('super-hide');
}

// Split a server-provided relative path (forward-slash-joined,
// already stripped of the vpath root) into the (subPath,
// directoryName) pair the /torrent/add validator expects.
function _splitSeedRelativePath(relativePath) {
  const segments = (relativePath || '').split('/').filter(Boolean);
  if (segments.length === 0) { return { subPath: '', directoryName: '' }; }
  const directoryName = segments.pop();
  const subPath       = segments.join('/');
  return { subPath, directoryName };
}

// Render the partial-match suggestion list into the target panel.
// acceptHandlerName is the window-global function (string) to invoke
// when the user clicks [Use this path]; it receives the row index.
function _renderPartialMatches(statusElId, matches, acceptHandlerName) {
  const el = document.getElementById(statusElId);
  if (!el || !Array.isArray(matches) || matches.length === 0) { return; }
  // Stash matches on window so the inline onclick handler can pull
  // its row by index.
  window.__torrentPartialMatches = matches;

  const rows = matches.map((m, idx) => {
    const displayPath = m.relativePath || '(library root)';
    const safeVpath   = escapeHtml(m.vpath || '');
    const safeDisplay = escapeHtml(displayPath);
    // Match-percentage doubles as a confidence cue: a 9/10 row is a
    // safe pick; a 1/10 row almost certainly means a track-name
    // collision with an unrelated album. Round to integer — fractional
    // % doesn't add signal at this granularity. Guard against
    // total=0 (shouldn't happen since the route only emits rows with
    // matched > 0, but the math would NaN if it did).
    const pct = m.total > 0
      ? Math.round((m.matched / m.total) * 100)
      : 0;
    return `
      <div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:0;">
          <div><b>${escapeHtml(String(m.matched))}/${escapeHtml(String(m.total))} (${pct}%)</b> files in
            <code style="color:#a5d6a7;">${safeVpath}</code> at
            <code style="color:#a5d6a7;">${safeDisplay}</code></div>
        </div>
        <button type="button" class="btn green" style="padding:6px 12px; font-size:0.85em;"
                onclick="${acceptHandlerName}(${idx})">Use this path</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div><b>Partial match found.</b> The daemon can resume from here — just download the missing files.</div>
    ${rows}`;
  el.classList.remove('super-hide');
}

// Sidebar Add Torrent panel's accept handler — fills the sidebar's
// vpath selector + path input (which the existing submit code reads),
// then collapses the suggestion to a confirmation line. The sidebar
// doesn't need an in-window "suggested seed" object because the
// vpath/path inputs themselves carry the choice forward; the
// `seedPicked` state flag tells the next submit to skip the seed-
// check and go straight to /torrent/add.
function _acceptPartialMatchSidebar(idx) {
  const matches = window.__torrentPartialMatches || [];
  const m = matches[idx];
  if (!m) { return; }

  // Update the vpath. The selector may be a <select> (multi-vpath
  // user) or a hidden <input> with a single value (single-vpath
  // user); set .value works on both.
  const vpathEl = document.getElementById('at_vpath');
  if (vpathEl) {
    vpathEl.value = m.vpath;
    // Fire the dropdown's onchange so the per-vpath template
    // recompute runs (it'd otherwise be stale).
    if (typeof onAddTorrentVpathChange === 'function') {
      onAddTorrentVpathChange();
    }
  }

  // Mark path as user-edited so recomputeAddTorrentPath() doesn't
  // immediately overwrite it from the metadata fields; mark the
  // seed choice as picked so the next submit skips the re-check.
  const state = window.__addTorrentState;
  if (state) {
    state.pathEdited = true;
    state.seedPicked = true;
  }
  const pathEl = document.getElementById('at_path');
  if (pathEl) {
    pathEl.value = m.relativePath || '';
    // Trigger the path preview update.
    if (typeof onAddTorrentPathEdit === 'function') {
      onAddTorrentPathEdit();
    }
  }

  const el = document.getElementById('at_seed_status');
  if (el) {
    el.innerHTML = `
      <div>Will add to <code style="color:#a5d6a7;">${escapeHtml(m.vpath)}</code>
        at <code style="color:#a5d6a7;">${escapeHtml(m.relativePath || '(library root)')}</code>.
        Click <b>Add Torrent</b> to fetch the ${escapeHtml(String(m.total - m.matched))} missing file(s).</div>`;
  }
}
window._acceptPartialMatchSidebar = _acceptPartialMatchSidebar;

// Modal submit — the "dumb" path. POST /torrent/add with the file/
// magnet + the file-explorer's vpath context, surface the daemon's
// own isDuplicate flag in the success toast, done. No seed-check
// here; that lives on the sidebar Add Torrent panel for the user
// who wants the smarter library-aware flow.
async function submitTorrent() {
  const data = window.__torrentPreflightData;
  if (!data || !data.vpathConfirmed) {
    return iziToast.warning({ title: 'Torrent feature not ready — see modal message', position: 'topCenter', timeout: 3500 });
  }
  const dir = document.getElementById('torrent_directory').value.trim();
  if (!dir) {
    return iziToast.warning({ title: 'Enter a directory name', position: 'topCenter', timeout: 3000 });
  }

  const fileEl   = document.getElementById('torrent_file_input');
  const magnetEl = document.getElementById('torrent_magnet');
  const hasFile  = fileEl.files.length > 0;
  const magnet   = magnetEl.value.trim();
  if (!hasFile && !magnet) {
    return iziToast.warning({ title: 'Pick a .torrent file or paste a magnet link', position: 'topCenter', timeout: 3500 });
  }

  const fd = new FormData();
  fd.append('vpath', data.vpath);
  if (data.subPath) { fd.append('subPath', data.subPath); }
  fd.append('directoryName', dir);
  if (document.getElementById('torrent_rename_root').checked) {
    fd.append('renameRoot', 'true');
  }
  if (hasFile) { fd.append('torrentFile', fileEl.files[0]); }
  else         { fd.append('magnet', magnet); }

  const submitBtn = document.getElementById('torrent_submit');
  submitBtn.disabled = true;
  try {
    const res  = await MSTREAMAPI.addTorrent(fd);
    const body = res.data || res;
    iziToast.success({
      title:   `${body.isDuplicate ? 'Already added: ' : 'Added: '}${body.name}`,
      message: body.downloadPath,
      position: 'topCenter',
      timeout: 4000,
    });
    // Surface a non-fatal warning when the rename-root post-add step
    // failed. The torrent IS downloading at the unrenamed location; we
    // just couldn't apply the cosmetic rename. Separate toast so it
    // doesn't overwrite the success message.
    if (body.renameWarning) {
      iziToast.warning({
        title:   'Rename failed',
        message: body.renameWarning,
        position: 'topCenter',
        timeout: 6000,
      });
    }
    myModal.close();
    fileEl.value = '';
    magnetEl.value = '';
    document.getElementById('torrent_directory').value = '';
    document.getElementById('torrent_file_name').textContent = '';
    delete document.getElementById('torrent_directory').dataset.autofilled;
  } catch (err) {
    const body = err.response?.data || {};
    iziToast.error({
      title:   body.message || body.error || err.message || 'Add failed',
      position: 'topCenter',
      timeout: 5000,
    });
  } finally {
    submitBtn.disabled = false;
  }
}

// ── Add Torrent panel ────────────────────────────────────────────────
// Sidebar-driven full-panel flow (distinct from the upload modal's
// Torrent tab). The modal version is the "I know what I'm doing"
// path: type a directory name, submit. This panel is the "automate
// the library filing" path: drop a .torrent file, mStream parses it,
// pre-fills artist/album/year + the destination path, and the user
// confirms or corrects before commit.
//
// v1 scope: name-string parsing only. We extract the torrent's `name`
// field client-side (no daemon round-trip, no server-side bencode
// call) and run a small regex set against it to derive metadata.
// The form fields are always editable — the parse is "best effort"
// and the operator has final say.
//
// Future iterations (research-noted in the design doc):
//   - Partial-byte tag fetching via @tokenizer/http for true ID3/
//     Vorbis-based metadata (works for ~95% of well-tagged audio)
//   - AcoustID fingerprinting as a post-download fallback
//   - File-list inspection for confidence signals (subdirectories
//     hinting at multi-disc / multi-album releases)
//   - Per-vpath layout templates (the {ARTIST}/{ALBUM}/{TORRENT_FILES}
//     plan from the earlier design discussion)

// ── Name parsing ─────────────────────────────────────────────────────
// Real-world music release name conventions. Each pattern captures
// artist / album / year. Patterns are tried in order; the first hit
// wins. Patterns that capture year are "high confidence"; the bare
// "Artist - Album" pattern is "low confidence" because it can match
// non-music torrents too. Confidence is a hint for the UI, not a
// gate — every field is editable.
//
// Coverage is ~70–80% of well-named music releases. The remaining
// 20–30% (deluxe-edition appendices, classical with composer +
// performer + conductor, foreign-language titles, scene-style bare
// hashes) fall through to manual entry. That's the intentional v1
// failure mode.
function parseMusicTorrentName(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { artist: '', album: '', year: '', confidence: 'none' };
  }
  // Strip format / quality tags first so they don't anchor patterns.
  // We keep the cleaned string aside; patterns then run against it.
  const cleaned = rawName
    .replace(/\[(FLAC|MP3|320|256|192|V0|V2|AAC|OGG|OPUS|ALAC|DSD|24[Bb]it|16[Bb]it|Lossless|Hi-?Res|WEB|CDRip|VINYL|LP|EP|SACD|Remaster(?:ed)?)[^\]]*\]/gi, '')
    .replace(/\((FLAC|MP3|320|256|192|V0|V2|AAC|OGG|OPUS|ALAC|DSD|24[Bb]it|16[Bb]it|Lossless|Hi-?Res|WEB|CDRip|VINYL|LP|EP|SACD|Remaster(?:ed)?)[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const patterns = [
    // Pattern 1: "Artist - Album (1973)"  — high confidence
    { re: /^(.+?)\s*-\s*(.+?)\s*\((\d{4})\)\s*$/,           map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
    // Pattern 2: "Artist - Album [1973]"
    { re: /^(.+?)\s*-\s*(.+?)\s*\[(\d{4})\]\s*$/,           map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
    // Pattern 3: "Artist - 1973 - Album"
    { re: /^(.+?)\s*-\s*(\d{4})\s*-\s*(.+?)\s*$/,           map: m => ({ artist: m[1], album: m[3], year: m[2], confidence: 'high' }) },
    // Pattern 4: "Artist - Album - 1973"
    { re: /^(.+?)\s*-\s*(.+?)\s*-\s*(\d{4})\s*$/,           map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
    // Pattern 5: "Artist.Album.1973" — dot-separated
    { re: /^([^.]+)\.([^.]+(?:\.[^.\d][^.]*)*)\.(\d{4})\s*$/, map: m => ({ artist: m[1].replace(/\./g, ' '), album: m[2].replace(/\./g, ' '), year: m[3], confidence: 'high' }) },
    // Pattern 6: bare "Artist - Album"  — low confidence (non-music
    // torrents like "Software - Cracked" also match)
    { re: /^(.+?)\s*-\s*(.+?)\s*$/,                          map: m => ({ artist: m[1], album: m[2], year: '', confidence: 'low' }) },
  ];

  for (const p of patterns) {
    const m = cleaned.match(p.re);
    if (m) {
      const r = p.map(m);
      return {
        artist:     (r.artist || '').trim(),
        album:      (r.album  || '').trim(),
        year:       (r.year   || '').trim(),
        confidence: r.confidence,
      };
    }
  }
  // Fallback: treat the whole name as the album with no artist/year.
  return { artist: '', album: cleaned, year: '', confidence: 'none' };
}

// Strip filesystem-illegal characters from a path segment so the
// composed destination path can't escape the vpath via clever artist
// names. The validator on the server side rejects '/', '\', '..', and
// control chars; we sanitise here primarily for usability — '/' in
// an artist name shouldn't silently turn into a subdirectory.
function sanitiseTorrentPathSegment(s) {
  return (s || '')
    .replace(/[\/\\:*?<>|"\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\.\s]+|[\.\s]+$/g, '')   // strip leading dots + whitespace
    .slice(0, 200);
}

// ── Panel renderer ───────────────────────────────────────────────────
function setupAddTorrentPanel() {
  setBrowserRootPanel('Add Torrent', false);
  programState = [{ state: 'addTorrent' }];

  const vpaths = MSTREAMAPI.currentServer.vpaths || [];
  const showVpathPicker = vpaths.length > 1;

  const newHtml = `
    <div class="add-torrent-panel" style="max-width:680px;padding:18px;color:#fff;">

      <!-- Feature-status banner — populated by the preflight call
           below. Hidden until preflight resolves; if the torrent
           feature is unavailable (no client configured, uploads
           disabled server-wide, user not whitelisted), this banner
           takes over and the form body is hidden. -->
      <div id="at_feature_status" class="super-hide" style="background:rgba(255,87,87,0.15);padding:12px;border-radius:4px;margin-bottom:14px;font-size:0.9em;color:#e57373"></div>

      <div id="at_body">

      <div style="margin-bottom:18px">
        <div style="font-size:0.85em;color:#fff;opacity:0.75;line-height:1.45;">
          Add a torrent to your library. Before downloading we check what's already on disk:
          <ul style="margin:6px 0 0 0;padding-left:20px;">
            <li style="display:list-item;list-style-type:disc;">If the files are already here, we set them up for seeding instead of re-downloading.</li>
            <li style="display:list-item;list-style-type:disc;">If the torrent is already in your client, we'll let you know.</li>
            <li style="display:list-item;list-style-type:disc;">For partial matches, we'll suggest where the existing files live so you can resume from there.</li>
          </ul>
          <div style="margin-top:10px;font-size:0.95em;color:#80cbc4;">
            On a phone? Use the mobile-friendly page at <a href="/torrent" target="_blank" style="color:#80cbc4;text-decoration:underline;">/torrent</a>.
          </div>
        </div>
      </div>

      <div class="at-step" style="margin-bottom:24px">
        <div style="font-weight:bold;margin-bottom:8px;opacity:0.85">1. Choose a .torrent file</div>
        <label class="btn green" style="display:inline-block;cursor:pointer">
          <span>Choose file</span>
          <input id="at_file" type="file" accept=".torrent,application/x-bittorrent" style="display:none"
                 onchange="onAddTorrentFile(this.files[0])">
        </label>
        <span id="at_file_name" style="margin-left:10px;opacity:0.7"></span>
      </div>

      <!-- Seed-check status panel — spinner during the pre-check,
           partial-match suggestion list when applicable, or hidden.
           This panel is the sidebar's smart-flow surface; the upload
           modal's torrent tab takes the simpler /add-direct path. -->
      <div id="at_seed_status" class="super-hide" style="padding:10px 12px;background:rgba(76,175,80,0.12);border:1px solid rgba(76,175,80,0.3);border-radius:4px;margin-bottom:18px;font-size:0.9em"></div>

      <div id="at_meta_section" class="at-step super-hide" style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-weight:bold;opacity:0.85">2. Detected metadata</div>
          <a id="at_autodetect_btn" class="btn-flat" style="color:#fff;font-size:0.85em;border:1px solid rgba(255,255,255,0.3);padding:4px 10px;border-radius:4px;cursor:pointer"
             onclick="onAutoDetectMetadata()">Auto-detect</a>
        </div>
        <div id="at_meta_warning" class="super-hide"
             style="background:rgba(255,193,7,0.15);padding:8px 12px;border-radius:4px;margin-bottom:10px;font-size:0.85em">
          Couldn't confidently parse artist/album from the torrent name. Please fill in the fields below.
        </div>
        <div style="display:grid;grid-template-columns:80px 1fr;gap:8px 12px;align-items:center">
          <label style="opacity:0.7">Artist</label>
          <input id="at_artist" type="text" oninput="onAddTorrentMetaEdit()" autocomplete="off" style="color:#fff">
          <label style="opacity:0.7">Album</label>
          <input id="at_album"  type="text" oninput="onAddTorrentMetaEdit()" autocomplete="off" style="color:#fff">
          <label style="opacity:0.7">Year</label>
          <input id="at_year"   type="text" oninput="onAddTorrentMetaEdit()" autocomplete="off" maxlength="4" style="color:#fff;max-width:120px">
        </div>
      </div>

      <div id="at_dest_section" class="at-step super-hide" style="margin-bottom:24px">
        <div style="font-weight:bold;margin-bottom:8px;opacity:0.85">3. Destination</div>
        ${showVpathPicker ? `
          <div style="margin-bottom:12px;display:grid;grid-template-columns:80px 1fr;gap:8px 12px;align-items:center">
            <label style="opacity:0.7">Library</label>
            <select id="at_vpath" class="browser-default" onchange="onAddTorrentVpathChange()" style="color:#fff;max-width:300px">
              ${vpaths.map(v => `<option value="${v}">${v}</option>`).join('')}
            </select>
          </div>
        ` : `<input type="hidden" id="at_vpath" value="${vpaths[0] || ''}">`}
        <div style="display:grid;grid-template-columns:80px 1fr;gap:8px 12px;align-items:center">
          <label style="opacity:0.7">Path</label>
          <input id="at_path" type="text" oninput="onAddTorrentPathEdit()" autocomplete="off" style="color:#fff"
                 placeholder="e.g. Artist Name/Album Title">
        </div>
        <!-- "Template applied" badge — shown when the selected vpath
             has a torrent_path_template (V41) configured AND the user
             hasn't manually edited the path. Hidden otherwise so it
             doesn't draw attention when there's no template. -->
        <p id="at_template_hint" class="super-hide" style="margin-top:6px;font-size:0.78em;color:#80cbc4">
          Path auto-built from the library's template — edit to override.
        </p>
        <!-- Discoverability hint when no template is configured. Static
             copy only — most users aren't admins so a deep-link isn't
             worth the complexity. Hidden once the operator manually
             edits the path (they've opted into freeform). -->
        <p id="at_template_discoverability" class="super-hide" style="margin-top:6px;font-size:0.78em;opacity:0.55">
          Tip: an admin can set a Path Template for this library so paths get auto-built from metadata.
        </p>
        <p style="margin-top:8px;font-size:0.78em;opacity:0.6">
          Files land at: <code id="at_path_preview" style="background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:3px"></code>
        </p>
      </div>

      <!-- Force-fresh-download escape hatch. Same semantics as the
           modal's checkbox: when ticked, submit skips the seed-
           existing pre-check entirely and goes straight to /add. -->
      <label id="at_force_download_label" class="super-hide" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:0.82em;opacity:0.65;cursor:pointer">
        <input id="at_force_download" type="checkbox" style="margin:0">
        Force fresh download (skip the library check)
      </label>
      <!-- Rename torrent's own root folder to match the destination
           path's last segment. Default ON in the smart sidebar flow:
           the user just typed out an Artist/Album path, almost
           certainly intending the album folder to BE the torrent's
           root. The modal's "dumb" tab defaults this OFF because the
           operator there is in raw-passthrough mode. -->
      <label id="at_rename_root_label" class="super-hide" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:0.82em;opacity:0.85;cursor:pointer">
        <input id="at_rename_root" type="checkbox" style="margin:0" checked>
        Rename the torrent's root folder to match the path
      </label>
      <button id="at_submit" class="btn green super-hide" onclick="submitAddTorrentPanel()" disabled>Add Torrent</button>
      <p id="at_status" style="margin-top:14px;font-size:0.9em"></p>

      ${vpaths.length === 0 ? `
        <div style="background:rgba(255,87,87,0.15);padding:12px;border-radius:4px;margin-top:14px;font-size:0.9em">
          You don't have access to any libraries. An admin needs to grant you a vpath first.
        </div>
      ` : ''}

      </div>
    </div>`;

  document.getElementById('filelist').innerHTML = newHtml;
  // Module-scoped state for this panel instance. Re-initialised every
  // time the panel mounts so prior state doesn't leak.
  window.__addTorrentState = {
    file:        null,
    parsedName:  null,
    metadata:    null,
    pathEdited:  false,   // sticky once the user types in the path field
    // Per-vpath path templates (V41). Populated async right after the
    // panel mounts. {<vpath>: {template: string|null}}.
    templates:   {},
  };
  // Feature-status preflight. Run with an empty path so we get back
  // the global gates (client active, server uploads, user whitelist)
  // without any vpath-specific noise. If any of those fail, the user
  // can't do anything from this panel — surface the reason and hide
  // the form rather than letting them fill it out and fail at submit.
  MSTREAMAPI.torrentPreflight('')
    .then(res => {
      const data = res.data || res;
      if (!data.active || data.noUpload || !data.userAllowed) {
        const banner = document.getElementById('at_feature_status');
        const body   = document.getElementById('at_body');
        if (banner && body) {
          banner.textContent = data.reason || 'Torrent feature is not available';
          banner.classList.remove('super-hide');
          body.classList.add('super-hide');
        }
      }
    })
    .catch(() => {
      const banner = document.getElementById('at_feature_status');
      const body   = document.getElementById('at_body');
      if (banner && body) {
        banner.textContent = 'Could not check torrent feature status';
        banner.classList.remove('super-hide');
        body.classList.add('super-hide');
      }
    });

  // Async-fetch the templates so recomputeAddTorrentPath() can apply
  // them as the operator edits metadata. Best-effort: a fetch failure
  // just means we fall back to the legacy hardcoded ARTIST/ALBUM
  // layout — no UI surfacing needed. Doubles as the source of
  // window.__torrentUserVpathCount (used by the spinner label).
  MSTREAMAPI.getTorrentPathTemplates()
    .then(r => {
      const t = r?.vpaths || {};
      window.__addTorrentState.templates = t;
      window.__torrentUserVpathCount     = Object.keys(t).length;
    })
    .catch(() => { /* leave templates empty; falls back to ARTIST/ALBUM */ });
}

// ── Handlers ─────────────────────────────────────────────────────────

async function onAddTorrentFile(file) {
  if (!file) { return; }
  const state = window.__addTorrentState;
  state.file = file;
  // A new file invalidates any in-flight seed-check + the previously
  // picked partial-match suggestion. _clearSeedStatus aborts the
  // controller so the prior response can't apply to this file.
  state.seedPicked = false;
  _clearSeedStatus('at_seed_status');
  document.getElementById('at_file_name').textContent = file.name;

  // Parse the torrent's name field client-side, then run the music-
  // name regex. We reuse the existing bencode `name` extractor from
  // the upload-modal flow — no daemon round-trip, no server call.
  const buf = new Uint8Array(await file.arrayBuffer());
  const torrentName = extractTorrentName(buf) || file.name.replace(/\.torrent$/i, '');
  state.parsedName = torrentName;
  state.metadata = parseMusicTorrentName(torrentName);
  state.pathEdited = false;

  // Populate the metadata fields. They're editable; the user can
  // override anything.
  document.getElementById('at_artist').value = state.metadata.artist;
  document.getElementById('at_album').value  = state.metadata.album;
  document.getElementById('at_year').value   = state.metadata.year;

  // Show the parse-confidence warning when the regex fell through to
  // a bare-name or no-match outcome.
  const warn = document.getElementById('at_meta_warning');
  if (state.metadata.confidence === 'low' || state.metadata.confidence === 'none') {
    warn.classList.remove('super-hide');
  } else {
    warn.classList.add('super-hide');
  }

  // Reveal the next two sections + the submit button + the
  // force-fresh-download checkbox.
  document.getElementById('at_meta_section').classList.remove('super-hide');
  document.getElementById('at_dest_section').classList.remove('super-hide');
  document.getElementById('at_submit').classList.remove('super-hide');
  document.getElementById('at_submit').disabled = false;
  const forceLabel = document.getElementById('at_force_download_label');
  if (forceLabel) { forceLabel.classList.remove('super-hide'); }
  const renameLabel = document.getElementById('at_rename_root_label');
  if (renameLabel) { renameLabel.classList.remove('super-hide'); }

  recomputeAddTorrentPath();
}

// Called by the metadata fields' input events. Recomputes the
// destination-path autofill from the (possibly edited) metadata,
// unless the user has manually edited the path field.
function onAddTorrentMetaEdit() {
  recomputeAddTorrentPath();
}

// Calls the server's /api/v1/torrent/auto-detect endpoint. Same
// .torrent bytes we already have client-side; the server runs its
// (currently name-parse-only) extraction pipeline and returns
// structured metadata + a confidence rating. Future tiers (partial-
// byte tag fetching, MusicBrainz lookup, AcoustID) layer in
// server-side; this handler doesn't change.
//
// Behaviour:
//   - high confidence → silently overwrite the fields + brief success toast
//   - low confidence  → overwrite + amber warning toast saying "verify"
//   - none / failure  → DON'T overwrite; surface an alert with the message
async function onAutoDetectMetadata() {
  const state = window.__addTorrentState;
  if (!state || !state.file) {
    iziToast.warning({ title: 'Pick a .torrent file first', position: 'topCenter', timeout: 3000 });
    return;
  }
  const btn = document.getElementById('at_autodetect_btn');
  const origLabel = btn.textContent;
  btn.textContent = 'Detecting…';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.5';
  try {
    // Pass the currently-selected vpath so the server can run Tier 3
    // (partial-byte tag fetch) — Tier 3 needs a verified vpath to
    // probe into. Without a vpath, Tier 3 is skipped and we get
    // just Tier 1+2 (name + file-list).
    const vpath = document.getElementById('at_vpath')?.value || '';
    const res = await MSTREAMAPI.autoDetectTorrentMetadata(state.file, vpath);
    if (!res || !res.ok) {
      iziToast.warning({
        title: 'Auto-detect: not enough metadata',
        message: res?.message || 'No reliable metadata could be extracted. Fill in the fields manually.',
        position: 'topCenter',
        timeout: 5000
      });
      return;
    }
    // Apply the server's view. This overrides whatever the
    // client-side parser had filled in — the server is the source of
    // truth for auto-detect.
    document.getElementById('at_artist').value = res.metadata.artist || '';
    document.getElementById('at_album').value  = res.metadata.album  || '';
    document.getElementById('at_year').value   = res.metadata.year   || '';
    // Re-derive the destination path from the fresh metadata. Clear
    // the user-edited flag so the path recomputes — if they want
    // their own path, they can edit again afterwards.
    state.pathEdited = false;
    recomputeAddTorrentPath();
    // Surface the confidence: silent on high, warning on low.
    if (res.confidence === 'high') {
      iziToast.success({
        title: 'Metadata detected',
        message: `Method: ${res.method}`,
        position: 'topCenter', timeout: 2500
      });
      document.getElementById('at_meta_warning').classList.add('super-hide');
    } else {
      iziToast.warning({
        title: 'Best-effort guess',
        message: 'Please verify the fields below.',
        position: 'topCenter', timeout: 4000
      });
      document.getElementById('at_meta_warning').classList.remove('super-hide');
    }
  } catch (err) {
    const body = err.response?.data || {};
    iziToast.error({
      title: 'Auto-detect failed',
      message: body.message || body.error || err.message || 'Server error',
      position: 'topCenter', timeout: 4000
    });
  } finally {
    btn.textContent = origLabel;
    btn.style.pointerEvents = '';
    btn.style.opacity = '';
  }
}

function onAddTorrentVpathChange() {
  updateAddTorrentPathPreview();
}

function onAddTorrentPathEdit() {
  window.__addTorrentState.pathEdited = true;
  updateAddTorrentPathPreview();
}

// Mirror of src/torrent/path-template.js sanitizeSegment — must
// stay in lockstep. Sub-segment slug-sanitisation used by the
// client-side template resolver.
function _atTemplateSanitize(s) {
  if (s == null) { return ''; }
  let v = String(s);
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
  v = v.replace(/\s+/g, ' ');
  v = v.replace(/^[.\s]+|[.\s]+$/g, '');
  if (v.length > 200) { v = v.slice(0, 200); }
  return v;
}

// Mirror of src/torrent/path-template.js resolveTemplate. Same
// substitution + sanitisation rules so the live UI preview matches
// what the server will accept. The server re-validates the final
// directoryName + subPath inside /torrent/add, so a divergence here
// surfaces as a save-time error rather than a security gap.
function _atResolveTemplate(template, metadata) {
  if (!template || typeof template !== 'string') { return ''; }
  const meta = metadata || {};
  const lookup = {
    ARTIST:      _atTemplateSanitize(meta.artist),
    ALBUM:       _atTemplateSanitize(meta.album),
    YEAR:        _atTemplateSanitize(meta.year),
    GENRE:       _atTemplateSanitize(meta.genre),
    ALBUMARTIST: _atTemplateSanitize(meta.albumartist || meta.artist),
  };
  const subst = template.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_m, name) => {
      const v = lookup[name.toUpperCase()];
      return v == null ? '' : v;
    }
  );
  const segs = subst.split(/[/\\]+/).map(s => s.trim()).filter(s => s.length > 0);
  return segs.join('/');
}

function recomputeAddTorrentPath() {
  const state = window.__addTorrentState;
  if (state.pathEdited) {
    // User has touched the path; respect their edit and only refresh
    // the preview string.
    updateAddTorrentPathPreview();
    return;
  }
  const artist = document.getElementById('at_artist').value;
  const album  = document.getElementById('at_album').value;
  const year   = document.getElementById('at_year').value;
  const vpath  = document.getElementById('at_vpath')?.value || '';
  const tmpl   = state.templates?.[vpath]?.template;

  let path = '';
  if (tmpl) {
    // V41 per-vpath template. The library has a configured layout
    // — apply it so the path matches the operator's schema.
    path = _atResolveTemplate(tmpl, { artist, album, year });
  } else {
    // Legacy fallback when no template is configured for this vpath.
    const a = _atTemplateSanitize(artist);
    const b = _atTemplateSanitize(album);
    if (a && b)      { path = `${a}/${b}`; }
    else if (b)      { path = b; }
    else if (a)      { path = a; }
  }
  document.getElementById('at_path').value = path;
  updateAddTorrentPathPreview();
}

function updateAddTorrentPathPreview() {
  const vpath = document.getElementById('at_vpath').value || '';
  const path  = (document.getElementById('at_path').value || '').replace(/\/+$/, '');
  const preview = document.getElementById('at_path_preview');
  if (!preview) { return; }
  preview.textContent = vpath
    ? `/${vpath}/${path}/<torrent contents>`
    : `<no library selected>/${path}`;

  // Toggle the template hint badges. "applied" shows when a template
  // exists AND the user hasn't manually overridden the path field.
  // "discoverability" shows when no template is configured AND the
  // user hasn't typed a path yet (so it disappears once they start
  // crafting their own path).
  const state = window.__addTorrentState || {};
  const tmpl  = state.templates?.[vpath]?.template;
  const appliedEl = document.getElementById('at_template_hint');
  const discEl    = document.getElementById('at_template_discoverability');
  if (appliedEl) {
    appliedEl.classList.toggle('super-hide', !(tmpl && !state.pathEdited));
  }
  if (discEl) {
    discEl.classList.toggle('super-hide', !(!tmpl && !state.pathEdited && !path));
  }
}

async function submitAddTorrentPanel() {
  const state = window.__addTorrentState;
  if (!state.file) {
    iziToast.warning({ title: 'Pick a .torrent file first', position: 'topCenter', timeout: 3000 });
    return;
  }
  const vpath = document.getElementById('at_vpath').value;
  if (!vpath) {
    iziToast.warning({ title: 'No library selected', position: 'topCenter', timeout: 3000 });
    return;
  }
  const rawPath = (document.getElementById('at_path').value || '').trim().replace(/\/+$/, '');
  if (!rawPath) {
    iziToast.warning({ title: 'Enter a path', position: 'topCenter', timeout: 3000 });
    return;
  }
  // The existing /api/v1/torrent/add endpoint expects directoryName
  // as a single segment + an optional subPath. Split here: everything
  // before the last `/` becomes subPath; the last segment becomes
  // directoryName. Single-segment input (no slashes) → subPath empty.
  const segments = rawPath.split('/').filter(Boolean);
  const directoryName = segments.pop();
  const subPath = segments.join('/');

  const submitBtn = document.getElementById('at_submit');
  const statusEl  = document.getElementById('at_status');
  const seedEl    = document.getElementById('at_seed_status');
  const forceDownload = document.getElementById('at_force_download')?.checked;

  submitBtn.disabled = true;
  statusEl.textContent = '';
  statusEl.style.color = '';

  try {
    // Step 1 — seed-existing pre-check. Skipped when the user
    // already accepted a partial-match suggestion (state.seedPicked
    // flag set by _acceptPartialMatchSidebar) OR when the force-
    // fresh-download checkbox is ticked. The check parallels the
    // modal's submitTorrent flow — same outcome enum, same UX.
    if (!state.seedPicked && !forceDownload) {
      _showSeedSpinner('at_seed_status');
      // Capture the file ref before the await so a mid-flight file
      // swap can't apply this outcome to the wrong torrent.
      const submittedFile = state.file;
      const seedFd = new FormData();
      seedFd.append('torrentFile', submittedFile);

      const ctrl = new AbortController();
      window.__torrentSeedAbortController = ctrl;

      let seedRes;
      try {
        seedRes = await MSTREAMAPI.seedExisting(seedFd, ctrl.signal);
      } catch (err) {
        if (err?.name === 'AbortError') { return; }
        console.warn('seed-existing check failed; falling through to /add', err);
        _clearSeedStatus('at_seed_status');
        seedRes = { outcome: 'no_match' };
      }

      if (state.file !== submittedFile) {
        _clearSeedStatus('at_seed_status');
        return;
      }
      window.__torrentSeedAbortController = null;

      switch (seedRes.outcome) {
        case 'seeded':
          _clearSeedStatus('at_seed_status');
          iziToast.success({
            title:   `Already in your library: ${seedRes.name}`,
            message: 'No download needed — the files were already here, and your torrent client is now sharing them.',
            position: 'topCenter',
            timeout: 5000,
          });
          _resetAddTorrentPanelForm();
          return;

        case 'already_in_daemon':
          _clearSeedStatus('at_seed_status');
          iziToast.info({
            title:   `Already added: ${seedRes.name || ''}`,
            message: 'This torrent is already in your torrent client. Nothing to do.',
            position: 'topCenter',
            timeout: 4500,
          });
          _resetAddTorrentPanelForm();
          return;

        case 'invalid_torrent':
          _clearSeedStatus('at_seed_status');
          iziToast.error({
            title:   'Invalid torrent file',
            message: seedRes.error || 'The file is malformed.',
            position: 'topCenter',
            timeout: 5000,
          });
          submitBtn.disabled = false;
          return;

        case 'daemon_error':
          _clearSeedStatus('at_seed_status');
          iziToast.error({
            title:   'Torrent client error',
            message: seedRes.error || 'Could not reach the torrent client.',
            position: 'topCenter',
            timeout: 5000,
          });
          submitBtn.disabled = false;
          return;

        case 'partial_match':
          // Render the suggestion list — clicking [Use this path] in
          // a row populates the vpath + path inputs; the user then
          // clicks Add Torrent again to proceed.
          _renderPartialMatches('at_seed_status', seedRes.matches || [], '_acceptPartialMatchSidebar');
          submitBtn.disabled = false;
          return;

        case 'no_match':
        default:
          _clearSeedStatus('at_seed_status');
          break;  // fall through to /torrent/add
      }
    }

    // Step 2 — /torrent/add. Either a no-match from the seed-check
    // or a user who explicitly accepted a suggestion / forced a
    // fresh download.
    const fd = new FormData();
    fd.append('vpath', vpath);
    if (subPath) { fd.append('subPath', subPath); }
    fd.append('directoryName', directoryName);
    if (document.getElementById('at_rename_root')?.checked) {
      fd.append('renameRoot', 'true');
    }
    fd.append('torrentFile', state.file);

    statusEl.textContent = 'Adding torrent…';
    const res = await MSTREAMAPI.addTorrent(fd);
    const body = res.data || res;
    statusEl.style.color = '#81c784';
    // Escape every interpolated value: body.name comes from a .torrent
    // info.name or magnet dn= (attacker-controlled), and body.downloadPath
    // includes the user's directoryName (also attacker-controlled when
    // self-XSS scenarios matter — e.g. an admin pastes a hostile magnet).
    statusEl.innerHTML = `✓ Added: <b>${escapeHtml(body.name)}</b><br>Files will land at: <code>${escapeHtml(body.downloadPath)}</code>`;
    iziToast.success({
      title: `${body.isDuplicate ? 'Already added: ' : 'Added: '}${body.name}`,
      position: 'topCenter', timeout: 3500,
    });
    // Non-fatal rename-root warning — separate toast so the success
    // message doesn't get overwritten.
    if (body.renameWarning) {
      iziToast.warning({
        title:   'Rename failed',
        message: body.renameWarning,
        position: 'topCenter',
        timeout: 6000,
      });
    }
    _resetAddTorrentPanelForm();
  } catch (err) {
    const errBody = err.response?.data || {};
    statusEl.style.color = '#e57373';
    statusEl.textContent = `Add failed: ${errBody.message || errBody.error || err.message || 'unknown error'}`;
    submitBtn.disabled = false;
    iziToast.error({
      title: errBody.message || errBody.error || err.message || 'Add failed',
      position: 'topCenter', timeout: 5000,
    });
  }
}

// Reset the sidebar Add Torrent panel back to its initial empty
// state — collapse step 2 + 3, clear all inputs, drop the staged file
// + suggestion. Leave the vpath selector intact since operators
// tend to add to the same library repeatedly.
function _resetAddTorrentPanelForm() {
  const state = window.__addTorrentState;
  document.getElementById('at_file').value = '';
  document.getElementById('at_file_name').textContent = '';
  document.getElementById('at_artist').value = '';
  document.getElementById('at_album').value  = '';
  document.getElementById('at_year').value   = '';
  document.getElementById('at_path').value   = '';
  document.getElementById('at_meta_section').classList.add('super-hide');
  document.getElementById('at_dest_section').classList.add('super-hide');
  document.getElementById('at_submit').classList.add('super-hide');
  const forceEl = document.getElementById('at_force_download');
  if (forceEl) { forceEl.checked = false; }
  const forceLabel = document.getElementById('at_force_download_label');
  if (forceLabel) { forceLabel.classList.add('super-hide'); }
  // Rename-root: re-hide the label and restore the default-on state
  // (it's the recommended action for the smart sidebar flow).
  const renameEl = document.getElementById('at_rename_root');
  if (renameEl) { renameEl.checked = true; }
  const renameLabel = document.getElementById('at_rename_root_label');
  if (renameLabel) { renameLabel.classList.add('super-hide'); }
  _clearSeedStatus('at_seed_status');
  if (state) {
    state.file = null;
    state.pathEdited = false;
    state.seedPicked = false;
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

  // Lyrics tag: shown only when the track has lyrics; clicking it swaps
  // the metadata modal for the lyrics modal (same flow as Change Album Art).
  const lyricsRow = document.getElementById('meta--lyrics-row');
  if (lyricsRow) {
    const hasLyrics = !!(metadata && metadata['has-lyrics']);
    lyricsRow.style.display = hasLyrics ? '' : 'none';
    const tag = document.getElementById('meta--lyrics-tag');
    if (tag) {
      tag.onclick = hasLyrics
        ? () => { myModal.close(); setTimeout(() => openLyricsModal(fp, metadata.title), 300); }
        : null;
    }
  }

  myModal.open('#metadataModel');
}

// Fetch + display the stored lyrics for a track (keyed off its filepath)
// in a modal. Uses the default-mStream lyrics API (GET /api/v1/lyrics).
// Synced LRC is shown as text (timestamps stripped); plain lyrics as-is.
function openLyricsModal(fp, title) {
  const titleEl = document.getElementById('lyrics-modal-title');
  if (titleEl) { titleEl.textContent = title || t('lyrics.modalTitle'); }
  const body = document.getElementById('lyrics-modal-body');
  body.textContent = t('lyrics.loading');
  myModal.open('#lyricsModal');

  fetch(MSTREAMAPI.currentServer.host + 'api/v1/lyrics?path=' + encodeURIComponent(String(fp).replace(/^\/+/, '')), {
    headers: { 'x-access-token': MSTREAMAPI.currentServer.token }
  }).then(r => {
    if (r.status === 404) { return null; }
    if (!r.ok) { throw new Error('lyrics fetch failed: ' + r.status); }
    return r.json();
  }).then(data => {
    body.textContent = lyricsToText(data) || t('lyrics.none');
  }).catch(() => {
    body.textContent = t('lyrics.error');
  });
}

// Collapse the lyrics API response to display text. Prefers synced (LRC,
// timestamps stripped) over plain. Returns '' when neither is present.
function lyricsToText(data) {
  if (!data) { return ''; }
  const pick = (c) => (c && Array.isArray(c.lyrics)) ? c.lyrics[c.default || 0] : null;
  const synced = pick(data.syncedLyrics);
  if (synced && synced.data) {
    return synced.data.split(/\r?\n/)
      // Strip only the LEADING timestamp/ID tags ([mm:ss.xx], [ar:…], [ti:…]),
      // not every bracketed token — so inline lyric brackets like "[Chorus]"
      // or "don't [stop]" survive in the displayed text.
      .map(line => line.replace(/^(?:\s*\[[^\]]*\])+/, '').trim())
      .filter(Boolean)
      .join('\n');
  }
  const plain = pick(data.lyrics);
  if (plain && plain.data) { return plain.data; }
  return '';
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

  if (downloadFiles < 1) {
    return;
  }

  // Use key if necessary
  document.getElementById('downform').action = "api/v1/download/zip?token=" + MSTREAMAPI.currentServer.token;
  
  let input = document.createElement("INPUT");
  input.type = 'hidden';
  input.name = 'fileArray';
  input.value = JSON.stringify(downloadFiles);
  document.getElementById('downform').appendChild(input);

  //submit form
  document.getElementById('downform').submit();
  // clear the form
  document.getElementById('downform').innerHTML = '';
}

function recursiveFileDownload(el) {
  const directoryString = getDirectoryString2(el);
  document.getElementById('downform').action = "api/v1/download/directory?token=" + MSTREAMAPI.currentServer.token;

  let input = document.createElement("INPUT");
  input.type = 'hidden';
  input.name = 'directory';
  input.value = directoryString;
  document.getElementById('downform').appendChild(input);

  //submit form
  document.getElementById('downform').submit();
  // clear the form
  document.getElementById('downform').innerHTML = '';
}

function downloadFileplaylist(el) {
  document.getElementById('downform').action = "api/v1/download/m3u?token=" + MSTREAMAPI.currentServer.token;
  
  const input = document.createElement("INPUT");
  input.type = 'hidden';
  input.name = 'path';
  input.value = getDirectoryString2(el);
  document.getElementById('downform').appendChild(input);

  //submit form
  document.getElementById('downform').submit();
  // clear the form
  document.getElementById('downform').innerHTML = '';
}

// Surface server-side bulk-download errors (e.g. the configured size limit →
// 413) to the user. The download functions above submit a hidden form
// targeting the #downframe iframe. A successful download streams back with
// Content-Disposition: attachment, so the browser saves it and never renders
// it in the iframe (no load event with content). An error response is JSON
// ({ error }) with no attachment header, so it loads INTO the iframe — catch
// that and toast the reason. Without this the download just silently failed.
(function watchDownloadErrors() {
  const frame = document.getElementById('downframe');
  if (!frame) { return; }
  frame.addEventListener('load', () => {
    let text = '';
    try {
      text = (frame.contentDocument && frame.contentDocument.body
        ? frame.contentDocument.body.textContent : '').trim();
    } catch (e) {
      return; // iframe not readable (shouldn't happen same-origin) — ignore
    }
    if (!text) { return; } // empty body → the download streamed fine

    // Pull the server's error message. Raw JSON parses directly; a browser
    // JSON viewer may pretty-print it, so fall back to a regex on the text.
    let message = '';
    try {
      message = JSON.parse(text).error || '';
    } catch (e) {
      const match = text.match(/"error"\s*:\s*"([^"]+)"/);
      if (match) { message = match[1]; }
    }

    const opts = { title: t('toast.downloadFailed'), position: 'topCenter', timeout: 5000 };
    if (message) { opts.message = message; }
    iziToast.error(opts);

    // Clear so stale error text can't be re-read on a later submit.
    try { frame.contentDocument.body.innerHTML = ''; } catch (e) { /* ignore */ }
  });
})();

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

function renamePlaylist(el) {
  const oldName = decodeURIComponent(el.getAttribute('data-playlistname'));

  iziToast.question({
    timeout: false,
    close: false,
    overlayClose: true,
    overlay: true,
    displayMode: 'once',
    id: 'rename-playlist-question',
    zindex: 99999,
    title: `Rename '${oldName}'`,
    position: 'center',
    inputs: [
      [`<input type="text" class="rename-playlist-input" value="${escapeHtml(oldName)}" maxlength="120">`, 'keyup', (instance, toast, input, e) => {
        // Commit on Enter, cancel on Escape.
        if (e.key === 'Enter') { toast.querySelector('.iziToast-buttons button.rename-ok').click(); }
        if (e.key === 'Escape') { instance.hide({ transitionOut: 'fadeOut' }, toast, 'button'); }
      }, true]
    ],
    onOpened: (instance, toast) => {
      // iziToast attaches mousedown/touchstart handlers to the toast for
      // drag-to-dismiss and calls preventDefault on them, which blocks the
      // input from receiving focus, positioning the cursor, or supporting
      // click-drag selection. Stop propagation before those handlers fire.
      const input = toast.querySelector('.rename-playlist-input');
      if (!input) { return; }
      const stop = (e) => e.stopPropagation();
      input.addEventListener('mousedown', stop);
      input.addEventListener('touchstart', stop, { passive: true });
      input.addEventListener('click', stop);
      // Pre-select the full name so the user can type to replace it.
      input.focus();
      input.select();
    },
    buttons: [
      ['<button class="rename-ok"><b>Rename</b></button>', async (instance, toast) => {
        const input = toast.querySelector('.rename-playlist-input');
        const newName = (input.value || '').trim();
        if (!newName || newName === oldName) {
          instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
          return;
        }
        try {
          await MSTREAMAPI.renamePlaylist(oldName, newName);
          // Update the row in-place so the user doesn't have to reload.
          const row = document.querySelector('li[data-playlistname="' + encodeURIComponent(oldName) + '"]');
          if (row) {
            const encoded = encodeURIComponent(newName);
            row.setAttribute('data-playlistname', encoded);
            row.querySelectorAll('[data-playlistname]').forEach(child => child.setAttribute('data-playlistname', encoded));
            const label = row.querySelector('.playlistz');
            if (label) { label.textContent = newName; }
          }
        } catch (err) {
          boilerplateFailure(err);
        }
        instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
      }, false],
      ['<button>Cancel</button>', (instance, toast) => {
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
async function getMobilePanel(){
  setBrowserRootPanel(t('panel.mobileApps'), false);

  // Probe whether Subsonic is enabled on this server. The panel always
  // shows the app-store links + QR shortcut; the Subsonic sections are
  // gated behind subsonic.mode !== 'disabled' (server-side config).
  let subsonicEnabled = false;
  try {
    const info = await MSTREAMAPI.serverInfo();
    subsonicEnabled = info?.features?.subsonic === true;
  } catch (_) { /* server too old or offline; just hide Subsonic UI */ }

  let html = `
    <div class="mobile-links pad-6">
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
    <!--
      QR-code tool link disabled — the current mobile apps don't support
      the QR-add-server flow it generates. Re-enable when the apps catch up.
    <div class="pad-6">
      <a target="_blank" href="/qr"><b>Checkout the QR Code tool to help add your server to the app</b></a>
    </div>
    -->`;

  if (subsonicEnabled) {
    const serverUrl = window.location.origin;
    const username = MSTREAMAPI.currentServer.username || '';
    html += `
      <hr>
      <div class="pad-6">
        <h4>Subsonic Access</h4>
        <p>Use any Subsonic-compatible client (Symfonium, DSub, substreamer, Sonixd, Feishin…) with these credentials.</p>
        <p>
          <b>Server URL:</b> <code id="subsonic-server-url">${serverUrl}</code><br>
          <b>Username:</b> <code>${username}</code>
        </p>

        <h5>Subsonic Password</h5>
        <p style="font-size: 0.9em; opacity: 0.85;">
          Many Subsonic clients require a separately-stored password (the protocol's "token authentication" mode).
          mStream protects your main password with strong one-way PBKDF2 hashing, which doesn't support that mode.
          Set a Subsonic-specific password here to enable those clients.
          <b>This password is stored in encrypted (recoverable) form on the server</b> — it's intentionally
          less secure than your main password. We recommend a different value than your mStream login.
        </p>
        <div id="subsonic-password-status" style="margin-bottom: 0.5em;"><i>Loading…</i></div>
        <div>
          <input type="password" id="subsonic-password-input" placeholder="New Subsonic password" style="max-width: 280px;"/>
          <button id="subsonic-password-set" onclick="setSubsonicPasswordFromForm()">Set / Update</button>
          <button id="subsonic-password-clear" onclick="clearSubsonicPasswordFromForm()" style="display:none">Clear</button>
        </div>

        <h5 style="margin-top: 1.5em;">API Keys</h5>
        <p style="font-size: 0.9em; opacity: 0.85;">
          Modern Subsonic clients can also authenticate with an API key — no password needed.
          The key is shown once at creation; copy it into your client immediately.
        </p>
        <div id="subsonic-api-keys-list" style="margin-bottom: 0.5em;"><i>Loading…</i></div>
        <div>
          <input type="text" id="subsonic-api-key-name" placeholder="Key name (e.g. iPhone Symfonium)" style="max-width: 280px;"/>
          <button onclick="createSubsonicApiKeyFromForm()">Generate</button>
        </div>
        <div id="subsonic-api-key-just-created" style="margin-top: 0.75em;"></div>
      </div>`;
  }

  document.getElementById('filelist').innerHTML = html;

  if (subsonicEnabled) {
    refreshSubsonicPasswordStatus();
    refreshSubsonicApiKeyList();
  }
}

// ── Subsonic password helpers (mobile panel) ─────────────────────────────────
async function refreshSubsonicPasswordStatus() {
  try {
    const { set } = await MSTREAMAPI.getSubsonicPasswordStatus();
    const status = document.getElementById('subsonic-password-status');
    const clearBtn = document.getElementById('subsonic-password-clear');
    if (set) {
      status.innerHTML = '<b style="color: #2e7d32;">Subsonic password is set.</b>';
      if (clearBtn) { clearBtn.style.display = 'inline-block'; }
    } else {
      status.innerHTML = '<i>No Subsonic password set. Token-auth clients will not work until you set one.</i>';
      if (clearBtn) { clearBtn.style.display = 'none'; }
    }
  } catch (err) {
    boilerplateFailure(err);
  }
}

async function setSubsonicPasswordFromForm() {
  const input = document.getElementById('subsonic-password-input');
  const password = input.value;
  if (!password) { return; }
  try {
    await MSTREAMAPI.setSubsonicPassword(password);
    input.value = '';
    await refreshSubsonicPasswordStatus();
  } catch (err) {
    boilerplateFailure(err);
  }
}

async function clearSubsonicPasswordFromForm() {
  if (!confirm('Clear the Subsonic password? Token-auth Subsonic clients will stop working until you set a new one.')) {
    return;
  }
  try {
    await MSTREAMAPI.clearSubsonicPassword();
    await refreshSubsonicPasswordStatus();
  } catch (err) {
    boilerplateFailure(err);
  }
}

// ── Subsonic API key helpers (mobile panel) ──────────────────────────────────
async function refreshSubsonicApiKeyList() {
  try {
    const keys = await MSTREAMAPI.listSubsonicApiKeys();
    const list = document.getElementById('subsonic-api-keys-list');
    if (!Array.isArray(keys) || keys.length === 0) {
      list.innerHTML = '<i>No API keys yet.</i>';
      return;
    }
    list.innerHTML = keys.map(k => `
      <div style="display: flex; align-items: center; gap: 1em; margin-bottom: 0.25em;">
        <code>${escapeHtml(k.name || '(unnamed)')}</code>
        <span style="font-size: 0.85em; opacity: 0.7;">
          ${k.last_used ? 'last used ' + new Date(k.last_used).toLocaleString() : 'never used'}
        </span>
        <button onclick="revokeSubsonicApiKey(${k.id})" style="margin-left: auto;">Revoke</button>
      </div>
    `).join('');
  } catch (err) {
    boilerplateFailure(err);
  }
}

async function createSubsonicApiKeyFromForm() {
  const input = document.getElementById('subsonic-api-key-name');
  const name = input.value.trim();
  if (!name) { return; }
  try {
    const { key } = await MSTREAMAPI.createSubsonicApiKey(name);
    input.value = '';
    document.getElementById('subsonic-api-key-just-created').innerHTML = `
      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 0.75em; border-radius: 4px;">
        <b>New API key (copy this — it won't be shown again):</b><br>
        <code style="word-break: break-all; user-select: all;">${escapeHtml(key)}</code>
      </div>`;
    await refreshSubsonicApiKeyList();
  } catch (err) {
    boilerplateFailure(err);
  }
}

async function revokeSubsonicApiKey(id) {
  if (!confirm('Revoke this API key? Any client using it will stop working immediately.')) { return; }
  try {
    await MSTREAMAPI.revokeSubsonicApiKey(id);
    await refreshSubsonicApiKeyList();
  } catch (err) {
    boilerplateFailure(err);
  }
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
//
// New panel UI (PR-E2 of the Auto-DJ port). Replaces the previous
// folder-checkbox + min-rating-select layout with the velvet-style
// toggle layout, plus three new toggles that the upcoming player
// rewrite will read from AUTODJ.state:
//
//   • Similar artists (Last.fm) — gated on the /lastfm/status probe
//     (disabled when no API key is configured server-side)
//   • BPM continuity + tolerance slider
//   • Harmonic mixing
//
// State lives in webapp/alpha/auto-dj.js (window.AUTODJ). Every
// toggle change mutates AUTODJ.state via setState(), which writes
// to the `mstream-dj-*` localStorage namespace immediately.
//
// BRIDGE: the existing autoDJ() implementation in
// webapp/assets/js/mstream.player.js still reads from the legacy
// globals MSTREAMPLAYER.ignoreVPaths / .minRating. The panel keeps
// those mirrors in sync so the player keeps working until its own
// rewrite ships in the next commit. The legacy `ignoreVPaths` +
// `minRating` localStorage keys also keep getting written so a tab
// reload mid-rollout doesn't lose state. The follow-up player
// commit will drop the legacy reads.

// Promise-cache for /lastfm/status. Two reasons for the indirection
// over a plain value cache:
//
//   1. Race avoidance — multiple panel renders in quick succession
//      used to spawn parallel fetches. Now they all await the same
//      in-flight promise.
//   2. Cheap TTL invalidation — admins might enable/disable Last.fm
//      while a panel is open. 5-minute TTL means the worst-case
//      stale window is short without making every render hit the
//      network.
//
// The actual HTTP request goes through MSTREAMAPI.lastfmStatus(),
// which uses the shared req() helper (centralised auth header +
// error handling + JSON parse). We only wrap it for caching.
const _LASTFM_STATUS_TTL_MS = 5 * 60 * 1000;
let _autoDjLastfmStatusEntry = null;  // { promise, ts } or null

function _fetchLastfmStatus() {
  const now = Date.now();
  if (_autoDjLastfmStatusEntry && (now - _autoDjLastfmStatusEntry.ts) < _LASTFM_STATUS_TTL_MS) {
    return _autoDjLastfmStatusEntry.promise;
  }
  const promise = MSTREAMAPI.lastfmStatus();
  _autoDjLastfmStatusEntry = { promise, ts: now };
  return promise;
}

// One-time migration of the pre-PR-E1 localStorage keys onto the
// new `mstream-dj-*` namespace. Idempotent — only fires when the
// new key is absent AND the legacy key is present. Doesn't delete
// the legacy keys (the player still reads them during the bridge
// period); the player commit will retire both reads + delete.
function _autoDjMigrateLegacyKeys() {
  // Legacy `minRating` (single-element array `[n]`) → new djMinRating.
  if (localStorage.getItem('mstream-dj-djMinRating') === null) {
    try {
      const raw = localStorage.getItem('minRating');
      if (raw) {
        const parsed = JSON.parse(raw);
        const val = Array.isArray(parsed) ? Number(parsed[0]) : Number(parsed);
        if (Number.isFinite(val)) {
          AUTODJ.setState({ djMinRating: Math.max(0, Math.min(10, val)) });
        }
      }
    } catch (_e) { /* malformed — fall back to default */ }
  }
  // Legacy `ignoreVPaths` (`{name: true}`) → new djVpaths (inverted: array of INCLUDED names).
  if (localStorage.getItem('mstream-dj-djVpaths') === null) {
    try {
      const raw = localStorage.getItem('ignoreVPaths');
      if (raw) {
        const ignored = JSON.parse(raw) || {};
        const allVpaths = (MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.vpaths) || [];
        // Empty djVpaths means "include all". Only persist a non-empty
        // selection when at least one vpath is explicitly excluded.
        const someExcluded = Object.values(ignored).some(v => v === true);
        if (someExcluded && allVpaths.length > 0) {
          AUTODJ.setState({
            djVpaths: allVpaths.filter(v => ignored[v] !== true),
          });
        }
      }
    } catch (_e) { /* malformed — fall back to default */ }
  }
}

// Convert AUTODJ.state.djVpaths → MSTREAMPLAYER.ignoreVPaths
// (the existing player.js still reads this shape).
function _syncVpathsToLegacy() {
  const allVpaths = (MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.vpaths) || [];
  const included = new Set(AUTODJ.state.djVpaths.length > 0 ? AUTODJ.state.djVpaths : allVpaths);
  MSTREAMPLAYER.ignoreVPaths = MSTREAMPLAYER.ignoreVPaths || {};
  for (const v of allVpaths) {
    MSTREAMPLAYER.ignoreVPaths[v] = !included.has(v);
  }
  localStorage.setItem('ignoreVPaths', JSON.stringify(MSTREAMPLAYER.ignoreVPaths));
}

// Note: there is intentionally NO `_syncMinRatingToLegacy()`. The
// rewritten autoDJ() in mstream.player.js reads djMinRating directly
// from AUTODJ.state, and no other code path reads MSTREAMPLAYER.minRating.
// The legacy `minRating` localStorage key is migrated once by
// `_autoDjMigrateLegacyKeys()` below and never written again — letting
// it go stale is fine since nothing reads the legacy key either.

// Listeners attached inside autoDjPanel get this signal; the previous
// render's controller is aborted at the top of each call so the old
// DOM's listeners are removed atomically before the new ones land.
// innerHTML re-render would eventually GC them, but a noisy click on
// Start/Stop fires repeated renders that overlap during the async
// fetches at the top of the function — explicit abort closes that
// window without leaning on the GC.
let _autoDjPanelAbortController = null;

async function autoDjPanel() {
  _autoDjPanelAbortController?.abort();
  _autoDjPanelAbortController = new AbortController();
  const _autoDjPanelSignal = _autoDjPanelAbortController.signal;

  setBrowserRootPanel(t('panel.autoDJ'), false);

  // First-render side-effect: pull legacy keys onto the new namespace.
  // Safe to call repeatedly — guarded against double-migrate.
  _autoDjMigrateLegacyKeys();

  const lastfm = await _fetchLastfmStatus();
  const lastfmAvailable = !!lastfm.serverEnabled;

  // Library genres list — feeds the suggestion dropdown in the genre
  // filter row. Cached for 5 min (see AUTODJ.getCachedGenresList);
  // a stale cache returns null so we re-fetch transparently. Network
  // / auth errors are non-blocking: the panel still renders, the
  // dropdown just shows the appropriate inline hint.
  let genresListLoadState = 'ready';   // 'ready' | 'auth' | 'error'
  let cachedGenresList = AUTODJ.getCachedGenresList();
  if (!cachedGenresList) {
    const res = await MSTREAMAPI.getGenres();
    if (res.status === 'ok') {
      AUTODJ.setCachedGenresList(res.value);
      cachedGenresList = AUTODJ.getCachedGenresList();
    } else {
      // 401 from the server when unauthenticated → soft-disable the
      // toggle and surface the auth hint. Any other error (5xx, 0 =
      // network) gets the generic "couldn't load" message.
      genresListLoadState = res.code === 401 ? 'auth' : 'error';
      cachedGenresList = [];
    }
  }
  const allVpaths = (MSTREAMAPI.currentServer && MSTREAMAPI.currentServer.vpaths) || [];
  // djVpaths default = empty means "all". For UI rendering, materialise
  // the actual inclusion set so each pill knows its state.
  const includedSet = new Set(
    AUTODJ.state.djVpaths.length > 0 ? AUTODJ.state.djVpaths : allVpaths,
  );

  const sourcesBlock = allVpaths.length > 1 ? `
    <div class="autodj-opt-row autodj-opt-col">
      <div>
        <div class="autodj-opt-label">${t('autoDJ.sectionSources')}</div>
        <div class="autodj-opt-hint">${t('autoDJ.sourcesHint')}</div>
      </div>
      <div class="dj-vpath-pills" id="dj-vpaths" role="group" aria-label="${escapeHtml(t('autoDJ.sectionSources'))}">
        ${allVpaths.map(v => `
          <button type="button" class="dj-vpath-pill${includedSet.has(v) ? ' on' : ''}" data-vpath="${escapeHtml(v)}" aria-pressed="${includedSet.has(v) ? 'true' : 'false'}">${escapeHtml(v)}</button>
        `).join('')}
      </div>
    </div>` : '';

  // Min-rating select: 0..10 in 0.5-star increments. Labels match
  // velvet's "★" visual vocabulary so the panel reads as a rating
  // chooser at a glance — backend stays continuous so half-star
  // ratings still work (e.g. ★ 3 catches 3, 3.5, 4, 4.5, 5).
  // 0 is rendered as "Any" via `autoDJ.ratingAny`.
  let ratingOptions = `<option value="0" ${AUTODJ.state.djMinRating === 0 ? 'selected' : ''}>${t('autoDJ.ratingAny')}</option>`;
  for (let i = 1; i <= 10; i++) {
    const stars = +(i / 2).toFixed(1); // 0.5, 1, 1.5, …, 5
    const label = `★ ${stars}`;
    ratingOptions += `<option value="${i}" ${AUTODJ.state.djMinRating === i ? 'selected' : ''}>${label}</option>`;
  }

  // Similar-artists toggle row. When no API key is configured the
  // toggle is rendered disabled with an explanatory hint so the
  // user understands WHY it's not available.
  //
  // a11y note: the `.toggle-sw` input is opacity:0 (the visible
  // affordance is the .toggle-sw-track sibling), so it needs an
  // explicit aria-labelledby pointing to the label div — screen
  // readers won't otherwise associate the description text with the
  // checkbox.
  const similarRow = `
    <div class="autodj-opt-row${lastfmAvailable ? '' : ' autodj-opt-disabled'}">
      <div>
        <div class="autodj-opt-label" id="dj-similar-label">${t('autoDJ.similarLabel')}</div>
        <div class="autodj-opt-hint">${lastfmAvailable ? t('autoDJ.similarHint') : '<em>' + t('autoDJ.similarHintNoKey') + '</em>'}</div>
      </div>
      <label class="toggle-sw">
        <input type="checkbox" id="dj-similar" aria-labelledby="dj-similar-label" ${AUTODJ.state.similar && lastfmAvailable ? 'checked' : ''} ${lastfmAvailable ? '' : 'disabled'}>
        <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
      </label>
    </div>`;

  const bpmContinuityRow = `
    <div class="autodj-opt-row">
      <div>
        <div class="autodj-opt-label" id="dj-bpm-cont-label">${t('autoDJ.bpmContinuityLabel')}</div>
        <div class="autodj-opt-hint">${t('autoDJ.bpmContinuityHint')}</div>
      </div>
      <label class="toggle-sw">
        <input type="checkbox" id="dj-bpm-cont" aria-labelledby="dj-bpm-cont-label" ${AUTODJ.state.bpmContinuity ? 'checked' : ''}>
        <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
      </label>
    </div>`;

  // BPM tolerance slider — hidden when BPM continuity is off so the
  // panel doesn't waste vertical space on an inert control.
  const bpmToleranceRow = `
    <div class="autodj-opt-row" id="dj-bpm-tol-row" style="${AUTODJ.state.bpmContinuity ? '' : 'display:none'}">
      <div>
        <div class="autodj-opt-label" id="dj-bpm-tol-label">${t('autoDJ.bpmToleranceLabel')}</div>
        <div class="autodj-opt-hint" id="dj-bpm-tol-val">${t('autoDJ.bpmToleranceValue', { n: AUTODJ.state.bpmTolerance })}</div>
      </div>
      <input type="range" id="dj-bpm-tol" class="autodj-slider" min="1" max="20" step="1" value="${AUTODJ.state.bpmTolerance}" aria-labelledby="dj-bpm-tol-label" aria-valuemin="1" aria-valuemax="20" aria-valuenow="${AUTODJ.state.bpmTolerance}">
    </div>`;

  const harmonicRow = `
    <div class="autodj-opt-row">
      <div>
        <div class="autodj-opt-label" id="dj-harmonic-label">${t('autoDJ.harmonicMixingLabel')}</div>
        <div class="autodj-opt-hint">${t('autoDJ.harmonicMixingHint')}</div>
      </div>
      <label class="toggle-sw">
        <input type="checkbox" id="dj-harmonic" aria-labelledby="dj-harmonic-label" ${AUTODJ.state.harmonicMixing ? 'checked' : ''}>
        <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
      </label>
    </div>`;

  // Keyword filter — full-width row (autodj-opt-col stacks the
  // toggle row above the tag chips + input field). The chip list
  // is rendered initially here; subsequent add/remove operations
  // call the inline `_renderFilterTags()` helper below to avoid
  // a full panel re-render (which would lose input focus + steal
  // the typed-but-not-yet-Enter'd word from the field).
  const filterTagsHtml = AUTODJ.state.djFilterWords.map(w => `
    <span class="dj-filter-tag" role="listitem">
      ${escapeHtml(w)}<button type="button" class="dj-filter-tag-rm" data-word="${escapeHtml(w)}" aria-label="${escapeHtml(t('autoDJ.keywordFilterTagRemove', { word: w }))}">×</button>
    </span>
  `).join('');
  const keywordFilterRow = `
    <div class="autodj-opt-row autodj-opt-col">
      <div class="dj-filter-head">
        <div>
          <div class="autodj-opt-label" id="dj-filter-label">${t('autoDJ.keywordFilterLabel')}</div>
          <div class="autodj-opt-hint">${t('autoDJ.keywordFilterHint')}</div>
        </div>
        <label class="toggle-sw">
          <input type="checkbox" id="dj-filter-on" aria-labelledby="dj-filter-label" ${AUTODJ.state.djFilterEnabled ? 'checked' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
      <div class="dj-filter-tags" id="dj-filter-tags" role="list" aria-label="${escapeHtml(t('autoDJ.keywordFilterTagsLabel'))}">${filterTagsHtml}</div>
      <input
        type="text"
        class="dj-filter-input"
        id="dj-filter-input"
        placeholder="${escapeHtml(t('autoDJ.keywordFilterPlaceholder'))}"
        ${AUTODJ.state.djFilterEnabled ? '' : 'disabled'}
        aria-label="${escapeHtml(t('autoDJ.keywordFilterInputLabel'))}">
    </div>`;

  // Genre filter row. Mirrors keywordFilterRow's outer shape (head with
  // label/hint/toggle + chip list + input). Differences:
  //   • A two-button segmented control between the head and the chip
  //     list selects whitelist vs blacklist mode (aria-pressed reflects
  //     the active mode).
  //   • The input has a sibling suggestion dropdown (.dj-genre-suggest)
  //     populated from the cached library-genres list. Free-text adds
  //     are allowed (Enter / comma commits whatever's typed, even if
  //     it's not in the dropdown) so the user can target a scanner-
  //     produced typo'd genre name.
  //
  // Empty-library / error states disable the toggle + mode buttons +
  // input. The hint text below the label swaps to the appropriate
  // explanation. genresListLoadState (auth / error / ready) and
  // cachedGenresList.length are the two inputs driving the state.
  const genreTagsHtml = AUTODJ.state.djGenres.map(g => `
    <span class="dj-filter-tag" role="listitem">
      ${escapeHtml(g)}<button type="button" class="dj-filter-tag-rm" data-genre="${escapeHtml(g)}" aria-label="${escapeHtml(t('autoDJ.genreTagRemove', { genre: g }))}">×</button>
    </span>
  `).join('');
  const genreFilterDisabled = (genresListLoadState !== 'ready') || (cachedGenresList.length === 0);
  const genreInputDisabled = genreFilterDisabled || !AUTODJ.state.djGenreEnabled;
  let genreHintKey = 'autoDJ.genreFilterHint';
  if (genresListLoadState === 'auth')         { genreHintKey = 'autoDJ.genreHintAuth'; }
  else if (genresListLoadState === 'error')   { genreHintKey = 'autoDJ.genreHintError'; }
  else if (cachedGenresList.length === 0)     { genreHintKey = 'autoDJ.genreHintEmpty'; }
  const genreMode = AUTODJ.state.djGenreMode;
  const genreFilterRow = `
    <div class="autodj-opt-row autodj-opt-col">
      <div class="dj-filter-head">
        <div>
          <div class="autodj-opt-label" id="dj-genre-label">${t('autoDJ.genreFilterLabel')}</div>
          <div class="autodj-opt-hint" id="dj-genre-hint">${t(genreHintKey)}</div>
        </div>
        <label class="toggle-sw">
          <input type="checkbox" id="dj-genre-on" aria-labelledby="dj-genre-label" ${AUTODJ.state.djGenreEnabled ? 'checked' : ''} ${genreFilterDisabled ? 'disabled' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
      <div class="dj-genre-mode" role="radiogroup" aria-label="${escapeHtml(t('autoDJ.genreModeLabel'))}">
        <button type="button" class="dj-genre-mode-btn" data-mode="whitelist" aria-pressed="${genreMode === 'whitelist'}" ${genreFilterDisabled ? 'disabled' : ''}>${t('autoDJ.genreModeWhitelist')}</button>
        <button type="button" class="dj-genre-mode-btn" data-mode="blacklist" aria-pressed="${genreMode === 'blacklist'}" ${genreFilterDisabled ? 'disabled' : ''}>${t('autoDJ.genreModeBlacklist')}</button>
      </div>
      <div class="dj-filter-tags" id="dj-genre-tags" role="list" aria-label="${escapeHtml(t('autoDJ.genreTagsLabel'))}">${genreTagsHtml}</div>
      <div class="dj-genre-combo">
        <input
          type="text"
          class="dj-filter-input"
          id="dj-genre-input"
          placeholder="${escapeHtml(t('autoDJ.genrePlaceholder'))}"
          ${genreInputDisabled ? 'disabled' : ''}
          autocomplete="off"
          aria-autocomplete="list"
          aria-controls="dj-genre-suggest"
          aria-label="${escapeHtml(t('autoDJ.genreInputLabel'))}">
        <div class="dj-genre-suggest" id="dj-genre-suggest" role="listbox" hidden></div>
      </div>
    </div>`;

  const html = `
    <div class="pad-6 autodj-root">
      <div class="autodj-hero">
        <h2>${t('panel.autoDJ')}</h2>
        <p class="autodj-hero-desc">${t('autoDJ.heroDescription')}</p>
      </div>

      <button type="button" class="autodj-toggle${MSTREAMPLAYER.playerStats.autoDJ ? ' on' : ''}" id="autodj-main-btn">
        ${MSTREAMPLAYER.playerStats.autoDJ ? t('autoDJ.btnStop') : t('autoDJ.btnStart')}
      </button>
      <div class="autodj-status${MSTREAMPLAYER.playerStats.autoDJ ? ' on' : ''}" id="autodj-status-msg">
        ${MSTREAMPLAYER.playerStats.autoDJ ? t('autoDJ.statusOn') : t('autoDJ.statusOff')}
      </div>

      <div class="autodj-opts">
        ${sourcesBlock}

        <div class="autodj-opt-row">
          <div class="autodj-opt-label">${t('autoDJ.minRating')}</div>
          <!-- .browser-default opts out of Materialize's select-replacement
               wrapper so we can style the native control directly. -->
          <select class="autodj-select browser-default" id="dj-min-rating">${ratingOptions}</select>
        </div>

        <h4 class="autodj-section-heading">${t('autoDJ.sectionContinuity')}</h4>
        ${similarRow}
        ${bpmContinuityRow}
        ${bpmToleranceRow}
        ${harmonicRow}

        <h4 class="autodj-section-heading">${t('autoDJ.sectionFilters')}</h4>
        ${keywordFilterRow}
        ${genreFilterRow}
      </div>
    </div>`;

  document.getElementById('filelist').innerHTML = html;

  // ── Wire event handlers (post-innerHTML attach) ─────────────────

  // Start/stop button — delegates to the existing player module.
  document.getElementById('autodj-main-btn').onclick = () => {
    MSTREAMPLAYER.toggleAutoDJ();
    // Re-render so the button label + status text flip immediately.
    autoDjPanel();
  };

  // Vpath pills — click to toggle inclusion.
  if (allVpaths.length > 1) {
    document.getElementById('dj-vpaths').addEventListener('click', (e) => {
      const btn = e.target.closest('.dj-vpath-pill');
      if (!btn) { return; }
      const vpath = btn.dataset.vpath;
      const current = new Set(AUTODJ.state.djVpaths.length > 0 ? AUTODJ.state.djVpaths : allVpaths);
      if (current.has(vpath)) {
        current.delete(vpath);
      } else {
        current.add(vpath);
      }
      // Disallow deselecting every vpath — matches the previous panel
      // behaviour. Re-add the just-removed one with a toast.
      if (current.size === 0) {
        current.add(vpath);
        iziToast.warning({
          title: t('toast.autoDJRequiresDir'),
          position: 'topCenter',
          timeout: 3500,
        });
        return;
      }
      // If every vpath is selected, persist as an empty array
      // (= "all"). Otherwise persist the explicit inclusion set.
      const next = current.size === allVpaths.length ? [] : [...current];
      AUTODJ.setState({ djVpaths: next });
      _syncVpathsToLegacy();
      // Visual update without full re-render — flip the class on
      // the clicked pill AND its aria-pressed attribute (screen
      // readers depend on the latter to announce the new state).
      btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', current.has(vpath) ? 'true' : 'false');
    }, { signal: _autoDjPanelSignal });
  }

  // Min-rating select.
  document.getElementById('dj-min-rating').onchange = (e) => {
    const val = Math.max(0, Math.min(10, parseInt(e.target.value, 10)));
    AUTODJ.setState({ djMinRating: val });
  };

  // Similar-artists toggle (no-op while disabled, but the event still
  // fires on label-click in some browsers).
  const simEl = document.getElementById('dj-similar');
  if (simEl && !simEl.disabled) {
    simEl.onchange = (e) => {
      AUTODJ.setState({ similar: !!e.target.checked });
    };
  }

  // BPM continuity toggle. Show/hide the tolerance row reactively.
  // Toggling OFF clears the rolling BPM history — re-enabling should
  // re-anchor on whatever's playing then, not on stale data from a
  // previous session segment.
  document.getElementById('dj-bpm-cont').onchange = (e) => {
    const on = !!e.target.checked;
    AUTODJ.setState({ bpmContinuity: on });
    if (!on) { AUTODJ.clearBpmHistory(); }
    document.getElementById('dj-bpm-tol-row').style.display = on ? '' : 'none';
  };

  // BPM tolerance slider — update the displayed value AND persist.
  // Sync aria-valuenow so screen readers announce the current
  // tolerance as the user drags.
  const tolEl = document.getElementById('dj-bpm-tol');
  tolEl.oninput = (e) => {
    const val = Math.max(1, Math.min(20, parseInt(e.target.value, 10)));
    AUTODJ.setState({ bpmTolerance: val });
    document.getElementById('dj-bpm-tol-val').textContent =
      t('autoDJ.bpmToleranceValue', { n: val });
    e.target.setAttribute('aria-valuenow', String(val));
  };

  // Harmonic mixing toggle. Same anchor-reset semantics as BPM
  // continuity: turning OFF clears the locked Camelot anchor so the
  // next ON-cycle re-locks on the current song.
  document.getElementById('dj-harmonic').onchange = (e) => {
    const on = !!e.target.checked;
    AUTODJ.setState({ harmonicMixing: on });
    if (!on) { AUTODJ.clearCamelotAnchor(); }
  };

  // ── Keyword filter ─────────────────────────────────────────────
  //
  // Re-renders ONLY the tag chip list so the user's typed-but-
  // unsubmitted input stays in the field. Full panel re-render
  // would also lose focus, which is jarring when the user is
  // adding multiple words in a row.
  const filterTagsEl = document.getElementById('dj-filter-tags');
  const filterInpEl  = document.getElementById('dj-filter-input');
  function _renderFilterTags() {
    const words = AUTODJ.getFilterWords();
    filterTagsEl.innerHTML = words.map(w => `
      <span class="dj-filter-tag" role="listitem">
        ${escapeHtml(w)}<button type="button" class="dj-filter-tag-rm" data-word="${escapeHtml(w)}" aria-label="${escapeHtml(t('autoDJ.keywordFilterTagRemove', { word: w }))}">×</button>
      </span>
    `).join('');
  }

  // Toggle controls just the filter on/off; the word list survives
  // toggling so the user can keep their list and flip the feature
  // on/off without rebuilding.
  document.getElementById('dj-filter-on').onchange = (e) => {
    const on = !!e.target.checked;
    AUTODJ.setState({ djFilterEnabled: on });
    filterInpEl.disabled = !on;
  };

  // Enter OR comma commits the typed word. Comma lets users paste a
  // CSV-shaped list and have each piece chip-ify as they go.
  filterInpEl.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ',') { return; }
    e.preventDefault();
    const raw = filterInpEl.value;
    const added = AUTODJ.addFilterWord(raw);
    if (added) {
      filterInpEl.value = '';
      _renderFilterTags();
    }
    // On dup / empty / cap-hit, leave the input alone so the user
    // can edit and retry. No toast — the silent no-op matches
    // velvet's behaviour and avoids spam on rapid-fire input.
  };

  // Event-delegation on the chip container so we don't have to re-
  // bind individual × buttons after each re-render.
  filterTagsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.dj-filter-tag-rm');
    if (!btn) { return; }
    AUTODJ.removeFilterWord(btn.dataset.word);
    _renderFilterTags();
  }, { signal: _autoDjPanelSignal });

  // ── Genre filter ───────────────────────────────────────────────
  //
  // Three pieces of state, three handlers + a fourth handler for the
  // suggestion dropdown:
  //
  //   • Toggle (#dj-genre-on)   — onchange flips djGenreEnabled, also
  //                               toggles input + suggestion enablement.
  //   • Mode buttons (.dj-genre-mode-btn) — click flips
  //                               aria-pressed on both buttons + writes
  //                               djGenreMode via AUTODJ.setGenreMode.
  //   • Input (#dj-genre-input) — input event filters the suggestion
  //                               dropdown; keydown handles Enter /
  //                               Comma / Esc / Arrow keys.
  //   • Chips (#dj-genre-tags)  — same event-delegated × pattern as
  //                               the keyword filter.
  const genreTagsEl  = document.getElementById('dj-genre-tags');
  const genreInpEl   = document.getElementById('dj-genre-input');
  const genreOnEl    = document.getElementById('dj-genre-on');
  const genreSuggEl  = document.getElementById('dj-genre-suggest');
  const genreModeBtns = document.querySelectorAll('.dj-genre-mode-btn');

  // Re-render the chip list only (same surgical-update rationale as
  // _renderFilterTags). Also reused after the suggestion dropdown's
  // "click to add" handler.
  function _renderGenreTags() {
    const gs = AUTODJ.getGenres();
    genreTagsEl.innerHTML = gs.map(g => `
      <span class="dj-filter-tag" role="listitem">
        ${escapeHtml(g)}<button type="button" class="dj-filter-tag-rm" data-genre="${escapeHtml(g)}" aria-label="${escapeHtml(t('autoDJ.genreTagRemove', { genre: g }))}">×</button>
      </span>
    `).join('');
  }

  // Render the suggestion dropdown. Filters the cached genres list
  // case-insensitively by the input's current value; excludes genres
  // already in the user's list; caps at 50 visible rows with a
  // "+N more" footer so the dropdown never grows unwieldy on huge
  // libraries.
  const SUGGEST_VISIBLE_LIMIT = 50;
  function _renderGenreSuggest() {
    if (!genreSuggEl || !genreInpEl) { return; }
    // Read live DOM state, not the closure variable. `genreInputDisabled`
    // was captured at panel-render time as `!djGenreEnabled` — when the
    // user later flipped the toggle ON, the toggle handler enabled the
    // input element but the closure stayed stale at `true`, so this
    // function early-returned and the dropdown never showed. Reading
    // `genreInpEl.disabled` reflects the live state the toggle handler
    // mutates, so a typed character after toggle-on now surfaces matches.
    if (genreInpEl.disabled) {
      genreSuggEl.setAttribute('hidden', '');
      return;
    }
    const q = String(genreInpEl.value || '').trim().toLowerCase();
    if (!q) {
      genreSuggEl.setAttribute('hidden', '');
      genreSuggEl.innerHTML = '';
      return;
    }
    const selected = new Set(AUTODJ.getGenres().map(g => g.toLowerCase()));
    const matches = cachedGenresList
      .filter(g => g.toLowerCase().includes(q) && !selected.has(g.toLowerCase()));
    if (matches.length === 0) {
      genreSuggEl.innerHTML = `<div class="dj-genre-suggest-empty">${t('autoDJ.genreNoMatchesHint')}</div>`;
      genreSuggEl.removeAttribute('hidden');
      return;
    }
    const visible = matches.slice(0, SUGGEST_VISIBLE_LIMIT);
    const extra   = matches.length - visible.length;
    genreSuggEl.innerHTML = visible.map((g, i) => `
      <div class="dj-genre-suggest-row" role="option" data-genre="${escapeHtml(g)}" id="dj-genre-suggest-row-${i}">${escapeHtml(g)}</div>
    `).join('') + (extra > 0
      ? `<div class="dj-genre-suggest-more">${t('autoDJ.genreMoreSuggestions', { n: extra })}</div>`
      : '');
    genreSuggEl.removeAttribute('hidden');
  }

  // Outer toggle: flips djGenreEnabled. The toggle itself may be
  // disabled (no library genres / auth error / load error) — in
  // those states this handler doesn't fire.
  if (genreOnEl) {
    genreOnEl.onchange = (e) => {
      const on = !!e.target.checked;
      AUTODJ.setState({ djGenreEnabled: on });
      // Input + suggestion enablement tracks the toggle.
      if (genreInpEl) {
        genreInpEl.disabled = !on;
      }
      if (!on && genreSuggEl) {
        genreSuggEl.setAttribute('hidden', '');
      }
    };
  }

  // Mode buttons: click flips djGenreMode and updates aria-pressed
  // on both buttons. Disabled state inherited from the disabled
  // attribute on the buttons themselves (set in markup).
  genreModeBtns.forEach((btn) => {
    btn.onclick = () => {
      if (btn.disabled) { return; }
      const mode = btn.dataset.mode;
      if (!AUTODJ.setGenreMode(mode)) { return; }
      genreModeBtns.forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
      });
    };
  });

  if (genreInpEl) {
    // Filter the dropdown on each keystroke.
    genreInpEl.oninput = () => { _renderGenreSuggest(); };

    // Enter / comma commit; Esc closes the dropdown; Tab / blur lets
    // the browser handle focus normally. Up/Down arrow navigation
    // through the dropdown isn't wired here — keeping the keyboard
    // surface minimal to match the keyword filter's UX. (Future
    // enhancement: aria-activedescendant + ↑/↓ if usability feedback
    // asks for it.)
    genreInpEl.onkeydown = (e) => {
      if (e.key === 'Escape') {
        if (genreSuggEl) { genreSuggEl.setAttribute('hidden', ''); }
        return;
      }
      if (e.key !== 'Enter' && e.key !== ',') { return; }
      e.preventDefault();
      const raw = genreInpEl.value;
      const added = AUTODJ.addGenre(raw);
      if (added) {
        genreInpEl.value = '';
        _renderGenreTags();
        _renderGenreSuggest();
      }
      // Silent no-op on dup / empty / cap-hit — same UX as keyword.
    };

    // Click on a suggestion row → add it.
    if (genreSuggEl) {
      genreSuggEl.addEventListener('mousedown', (e) => {
        // Use mousedown not click so the blur handler doesn't fire
        // first (the suggestion dropdown disappears on blur otherwise
        // and the click never lands).
        const row = e.target.closest('.dj-genre-suggest-row');
        if (!row) { return; }
        e.preventDefault();
        AUTODJ.addGenre(row.dataset.genre);
        genreInpEl.value = '';
        _renderGenreTags();
        _renderGenreSuggest();
        genreInpEl.focus();
      }, { signal: _autoDjPanelSignal });
      // Blur the input → hide the dropdown. 150ms grace lets the
      // mousedown handler above fire before the dropdown vanishes.
      genreInpEl.onblur = () => {
        setTimeout(() => { genreSuggEl.setAttribute('hidden', ''); }, 150);
      };
    }
  }

  // Chip remove — event-delegated, same pattern as keyword.
  genreTagsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.dj-filter-tag-rm');
    if (!btn) { return; }
    AUTODJ.removeGenre(btn.dataset.genre);
    _renderGenreTags();
  }, { signal: _autoDjPanelSignal });

  // Initial sync — the `ignoreVPaths` legacy global IS still read by
  // every browse/search panel in m.js, so we keep it in lockstep with
  // AUTODJ.state.djVpaths. (The minRating legacy global is dead — see
  // the comment block above _syncMinRatingToLegacy's removed position.)
  _syncVpathsToLegacy();
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
  const defaults = { albums: true, artists: true, files: false, titles: true, lyrics: true };
  try {
    const saved = JSON.parse(localStorage.getItem('mstream-search-toggles'));
    // Merge OVER defaults so a toggle added in a later release (e.g. `lyrics`)
    // inherits its default for existing users instead of being absent →
    // rendered unchecked, while their own saved choices still win.
    if (saved && typeof saved === 'object') { return { ...defaults, ...saved }; }
  } catch (_e) {}
  return defaults;
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
  },
  lyrics: {
    name: 'Lyrics',
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
      <label class="grow" for="search-in-lyrics">
        <input ${(searchToggles.lyrics === true ? 'checked' : '')} id="search-in-lyrics" class="filled-in" type="checkbox">
        <span>Lyrics</span>
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
    if (document.getElementById("search-in-lyrics") && document.getElementById("search-in-lyrics").checked === false) { postObject.noLyrics = true; }
    searchToggles.lyrics = document.getElementById("search-in-lyrics").checked;

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
          <div onclick="${searchMap[key].func}(this);" data-${searchMap[key].data}="${escapeHtml(value.filepath ? value.filepath : value.name)}" class="${searchMap[key].class} left">
            <b>${searchMap[key].name}:</b> ${escapeHtml(value.name)}${key === 'lyrics' && value.snippet ? `<br><small class="grey-text">…${escapeHtml(value.snippet)}…</small>` : ''}
          </div>
          ${
            key === 'files' || key === 'title' || key === 'lyrics' ? `<div class="song-button-box">
            <span title="Play Now" onclick="playNow(this);" data-file_location="${escapeHtml(value.filepath)}" class="songDropdown">
              <svg xmlns="http://www.w3.org/2000/svg" height="12" width="12" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
            </span>
            <span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${escapeHtml(value.filepath)}" class="fileAddToPlaylist">
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
