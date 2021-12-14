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
  return `<li class="collection-item">
    <div ${year ? `data-year="${year}"` : '' } ${artist ? `data-artist="${artist}"` : '' } ${id ? `data-album="${id}"` : '' } class="albumz flex" onclick="getAlbumsOnClick(this);">
      
        ${albumArtFile ? `<img class="album-art-box" loading="lazy" src="album-art/${albumArtFile}?token=${MSTREAMAPI.currentServer.token}">`: 
        '<svg xmlns="http://www.w3.org/2000/svg" class="album-art-box" fill="#AAA" viewBox="0 0 55.334 55.334"><g><circle cx="27.667" cy="27.667" r="3.618"></circle><path d="M27.667 0C12.387 0 0 12.387 0 27.667s12.387 27.667 27.667 27.667 27.667-12.387 27.667-27.667S42.947 0 27.667 0zM17.118 6.881a23.213 23.213 0 0111.214-2.509c.367.01.619.922.564 2.025l-.282 5.677c-.055 1.103-.289 1.986-.523 1.979a13.577 13.577 0 00-6.027 1.196c-1.007.455-2.212.184-2.774-.767l-2.896-4.897c-.562-.951-.261-2.203.724-2.704zm-1.132 10.414l-4.278-3.742c-.832-.727-.918-1.994-.119-2.756l.057-.053c.802-.76 2.059-.605 2.737.266l3.494 4.484c.679.871.837 1.889.391 2.314-.447.427-1.45.214-2.282-.513zm1.891 10.372c0-5.407 4.383-9.79 9.79-9.79s9.79 4.383 9.79 9.79-4.383 9.79-9.79 9.79-9.79-4.383-9.79-9.79zM38.17 48.476a23.21 23.21 0 01-11.244 2.484c-.409-.013-.692-.929-.632-2.032l.31-5.676c.061-1.103.322-1.981.586-1.972a13.596 13.596 0 005.656-1.01c1.022-.42 2.275-.144 2.877.782l3.101 4.77c.602.925.332 2.155-.654 2.654zm5.449-3.82c-.766.72-2.005.551-2.703-.305l-3.59-4.407c-.698-.856-.876-1.848-.435-2.255.442-.407 1.443-.179 2.274.549l4.28 3.744c.832.727.941 1.954.174 2.674z"></path></g></svg>'}
      
      <div>
        <span class="explorer-label-1"><b>${name}</b> ${year ? `<br>[${year}]` : ''}</span><br>
      </div>
    </div>
  </li>`;
}

function renderFileWithMetadataHtml(filepath, lokiId, metadata) {
  return `<li data-lokiid="${lokiId}" class="collection-item">
    <div data-file_location="${filepath}" class="filez flex" onclick="onFileClick(this);">
      <img class="album-art-box" loading="lazy" ${metadata['album-art'] ? `src="album-art/${metadata['album-art']}?token=${MSTREAMAPI.currentServer.token}"` : 'src="assets/img/default.png"'}>
      <div>
        <b><span class="explorer-label-1">${(!metadata || !metadata.title) ? filepath.split("/").pop() : `${metadata.title}`}</span></b>
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
    <div data-file_location="${fileLocation}" class="filez flex" onclick="onFileClick(this);">
      ${aa ? `<img loading="lazy" class="album-art-box" ${aa}>` : '<svg class="music-image" height="18" width="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>'} 
      <div>
        ${subtitle ? `<b>` : ''}
        <span class="${aa ? 'explorer-label-1' : 'item-text'}">${rating ? `[${rating}] ` : ''}${title}</span>
        ${subtitle ? `</b><br><span>${subtitle}</span>` : ''}
      </div>
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
  return `<li class="collection-item">
    <div data-directory="${dataDirectory}" class="fileplaylistz" onclick="onFilePlaylistClick(this);">
      <svg class="fileplaylist-image" xmlns="http://www.w3.org/2000/svg" viewBox="24 0 303.188 303.188"><path fill="#e8e8e8" d="M219.821 0H32.842v303.188h237.504V50.525z"/><g fill="#333"><path d="M99.324 273.871l-9.813-34.557h-.295c.459 5.885.689 10.458.689 13.717v20.84H78.419v-47.979h17.262l10.009 34.065h.263l9.813-34.065h17.295v47.979h-11.913v-21.036c0-1.094.017-2.308.049-3.643.033-1.335.181-4.605.443-9.813h-.295l-9.681 34.491h-12.34v.001zM173.426 236.295c0 2.976-.908 5.529-2.724 7.663-1.816 2.133-4.441 3.681-7.876 4.644v.197c8.008 1.006 12.011 4.791 12.011 11.354 0 4.464-1.767 7.975-5.3 10.534-3.533 2.56-8.439 3.84-14.719 3.84-2.582 0-4.972-.186-7.171-.558-2.198-.372-4.577-1.05-7.138-2.034V261.17a28.545 28.545 0 006.416 2.379c2.177.515 4.185.771 6.023.771 2.844 0 4.917-.399 6.219-1.198 1.302-.799 1.952-2.051 1.952-3.758 0-1.313-.339-2.324-1.017-3.035-.679-.711-1.773-1.247-3.282-1.607-1.51-.361-3.479-.542-5.907-.542h-2.953v-9.747h3.018c6.586 0 9.879-1.684 9.879-5.054 0-1.269-.487-2.21-1.461-2.822s-2.28-.919-3.922-.919c-3.063 0-6.235 1.029-9.517 3.085l-5.382-8.664c2.537-1.75 5.136-2.997 7.794-3.741s5.704-1.115 9.14-1.115c4.966 0 8.86.984 11.683 2.953 2.823 1.969 4.234 4.682 4.234 8.139zM223.571 225.892v28.88c0 6.279-1.778 11.141-5.333 14.588-3.556 3.445-8.681 5.168-15.375 5.168-6.542 0-11.568-1.674-15.08-5.022-3.511-3.347-5.267-8.16-5.267-14.439v-29.175h13.028v28.157c0 3.393.635 5.854 1.903 7.385s3.14 2.297 5.612 2.297c2.647 0 4.566-.76 5.759-2.281 1.192-1.52 1.789-4.008 1.789-7.465v-28.093h12.964z"/></g><path fill="#004a94" d="M227.64 25.263H32.842V0h186.979z"/><path fill="#d1d3d3" d="M219.821 50.525h50.525L219.821 0z"/><circle cx="150.304" cy="122.143" r="59.401" fill="#004a94"/><path d="M130.903 91.176v47.938c-1.681-.198-3.551-.154-5.529.195-7.212 1.271-13.057 5.968-13.057 10.49s5.845 7.157 13.057 5.886c7.211-1.271 13.056-5.968 13.056-10.49v-38.703l32.749-5.775v31.295c-1.68-.199-3.549-.153-5.529.196-7.213 1.271-13.057 5.968-13.057 10.49 0 4.523 5.844 7.157 13.057 5.886 7.21-1.271 13.056-5.968 13.056-10.49V82.748l-47.803 8.428z" fill="#fff"/></svg>
      <span class="item-text">${dataDirectory}</span>
    </div>
    <div class="song-button-box">
      <span title="Add All To Queue" class="addFileplaylist" data-directory="${dataDirectory}">
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

  ([...document.getElementsByClassName('panel_one_name')]).forEach(el => {
    el.innerHTML = panelName;
  });

  currentBrowsingList = [];
}

///////////////// File Explorer
function loadFileExplorer() {
  setBrowserRootPanel('File Explorer');
  programState = [{ state: 'fileExplorer' }];

  // Reset file explorer vars
  fileExplorerArray = [];
  //send this directory to be parsed and displayed
  senddir(true);
}

async function senddir(root) {
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
  let msg = 'Call Failed';
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

function playNow(el) {
  VUEPLAYERCORE.addSongWizard(el.getAttribute("data-file_location"), {}, true, MSTREAMPLAYER.positionCache.val + 1);
}

async function init() {
  try {
    const response = await MSTREAMAPI.ping();
    MSTREAMAPI.currentServer.vpaths = response.vpaths;
    VUEPLAYERCORE.playlists.length = 0;
    document.getElementById('pop-f').innerHTML = '<div class="pop-f pop-playlist">Add To Playlist:</div>';

    response.playlists.forEach(p => {
      VUEPLAYERCORE.playlists.push(p);
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${p.name}')">&#8226; ${p.name}</div>`;
    });

    if (response.transcode) {
      MSTREAMPLAYER.transcodeOptions.serverEnabled = true;
      MSTREAMPLAYER.transcodeOptions.defaultCodec = response.transcode.defaultCodec;
      MSTREAMPLAYER.transcodeOptions.defaultBitrate = response.transcode.defaultBitrate;
      MSTREAMPLAYER.transcodeOptions.defaultAlgo = response.transcode.defaultAlgorithm;      
    }
  }catch (err) {
    // window.location.href = 'login';
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
    MSTREAMPLAYER.transcodeOptions.selectedAlgo = localStorage.getItem('trans-algo-select');
  } catch (e) {}

  // try {
  //   const response = await MSTREAMAPI.dbStatus();
  //   // if not scanning
  //   if (!response.locked || response.locked === false) {
  //     clearInterval(startInterval);
  //     startInterval = false;
  //     document.getElementById('scan-status').innerHTML = '';
  //     document.getElementById('scan-status-files').innerHTML = '';

  //     return;
  //   }

  //   // Set Interval
  //   if (startInterval === false) {
  //     startInterval = setInterval(function () {
  //       callOnStart();
  //     }, 2000);
  //   }

  //   // Update status
  //   document.getElementById('scan-status').innerHTML = 'Scan In Progress';
  //   document.getElementById('scan-status-files').innerHTML = response.totalFileCount + ' files in DB';
  // }catch(err) {
  //   document.getElementById('scan-status').innerHTML = '';
  //   document.getElementById('scan-status-files').innerHTML = '';
  //   clearInterval(startInterval);
  //   startInterval = false;
  // }
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

function openNewPlaylistModal() {
  myModal.open('#newPlaylist');
}

function openPlaybackModal() {
  myModal.open('#speedModal');
}

async function addToPlaylistUI(playlist) {
  try {
    await MSTREAMAPI.addToPlaylist(playlist, curFileTracker);
    iziToast.success({
      title: 'Song Added!',
      position: 'topCenter',
      timeout: 3500
    });
  }catch(err) {
    iziToast.error({
      title: 'Failed to add song',
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
  setBrowserRootPanel('Albums');
  document.getElementById('directoryName').innerHTML = 'Artist: ' + artist;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  try {
    const response = await MSTREAMAPI.artistAlbums(artist);
    let albums = '';
    response.albums.forEach(value => {
      const albumString = value.name ? value.name : 'SINGLES';
      // 'value.name === null ? artist : null' is some clever shit that only passes in artist info when the album is null
      // This is so we get the singles for this artist
      // If the album is specified, we don't want to limit by artist
      albums += renderAlbum(value.name, value.name === null ? artist : null, albumString, value.album_art_file, value.year);
      currentBrowsingList.push({ type: 'album', name: value.name, artist: artist, album_art_file: value.album_art_file })
    });

    document.getElementById('filelist').innerHTML = albums;
  }catch (err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
    return boilerplateFailure(err);
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
  setBrowserRootPanel('Playlists');
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = '<input class="newPlaylistButton btn green" style="height:24px;" value="New Playlist" type="button" onclick="openNewPlaylistModal();">';
  programState = [ {state: 'allPlaylists' }];

  try {
    const response = await MSTREAMAPI.getAllPlaylists();
    VUEPLAYERCORE.playlists.length = 0;
    document.getElementById('pop-f').innerHTML = '<div class="pop-f pop-playlist">Add To Playlist:</div>';

    // loop through the json array and make an array of corresponding divs
    let playlists = '<ul class="collection">';
    response.forEach(p => {
      playlists += renderPlaylist(p.name);
      const lol = { name: p.name, type: 'playlist' };
      currentBrowsingList.push(lol);
      VUEPLAYERCORE.playlists.push(lol);
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${p.name}')">&#8226; ${p.name}</div>`;
    });
    playlists += '</ul>'

    document.getElementById('filelist').innerHTML = playlists;
  }catch (err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
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
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
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
      title: 'Playlist Created',
      position: 'topCenter',
      timeout: 3000
    });

    document.getElementById("newPlaylistForm").reset(); 
    VUEPLAYERCORE.playlists.push({ name: title, type: 'playlist'});
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${title}')">&#8226; ${title}</div>`;
  
    if (programState[0].state === 'allPlaylists') {
      getAllPlaylists();
    }
  }catch (err) {
    boilerplateFailure(err);
  }
  document.getElementById('new_playlist').disabled = false;
}

async function savePlaylist() {
  if (MSTREAMPLAYER.playlist.length == 0) {
    iziToast.warning({
      title: 'No playlist to save!',
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
      title: 'Playlist Saved',
      position: 'topCenter',
      timeout: 3000
    });

    if (programState[0].state === 'allPlaylists') {
      getAllPlaylists();
    }

    VUEPLAYERCORE.playlists.push({ name: title, type: 'playlist'});
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" onclick="addToPlaylistUI('${title}')">&#8226; ${title}</div>`;
  }catch(err) {
    boilerplateFailure(err);
  }
}

/////////////// Artists
async function getAllArtists() {
  setBrowserRootPanel('Artists');
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allArtists' }];

  try {
    const response = await MSTREAMAPI.artists();
    // parse through the json array and make an array of corresponding divs
    let artists = '<ul class="collection">';
    response.artists.forEach(value => {
      artists += `<li data-artist="${value}" class="artistz collection-item" onclick="getArtistz(this)">${value}</li>`;
      currentBrowsingList.push({ type: 'artist', name: value });
    });
    artists += '</ul>';

    document.getElementById('filelist').innerHTML = artists;
  }catch(err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
    boilerplateFailure(response, error);
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
  setBrowserRootPanel('Albums');
  document.getElementById('directoryName').innerHTML = 'Artist: ' + artist;
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  try {
    const response = await MSTREAMAPI.artistAlbums(artist);
    let albums = '<ul>';
    response.albums.forEach(value => {
      const albumString = value.name ? value.name : 'SINGLES';
      // 'value.name === null ? artist : null' is some clever shit that only passes in artist info when the album is null
      // This is so we get the singles for this artist
      // If the album is specified, we don't want to limit by artist
      albums += renderAlbum(value.name, value.name === null ? artist : null, albumString, value.album_art_file, value.year);
      currentBrowsingList.push({ type: 'album', name: value.name, artist: artist, album_art_file: value.album_art_file })
    });
    albums += '</ul>';

    document.getElementById('filelist').innerHTML = albums;
  }catch(err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
    boilerplateFailure(response, error);
  }
}

/////////////// Albums
async function getAllAlbums() {
  setBrowserRootPanel('Albums');
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  
  programState = [{ state: 'allAlbums' }];

  try {
    const response = await MSTREAMAPI.albums();
    //parse through the json array and make an array of corresponding divs
    let albums = '<ul class="collection">';
    response.albums.forEach(value => {
      currentBrowsingList.push({
        type: 'album',
        name: value.name,
        'album_art_file': value.album_art_file
      });

      albums += renderAlbum(value.name, undefined, value.name, value.album_art_file, value.year);
    });
    albums += '</ul>'

    document.getElementById('filelist').innerHTML = albums;
  }catch (err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
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
    const response = await MSTREAMAPI.albumSongs(album, artist, year)
    //parse through the json array and make an array of corresponding divs
    let files = '<ul class="collection">';
    response.forEach(song => {
      currentBrowsingList.push({ type: 'file', name: song.metadata.title ? song.metadata.title : song.metadata.filename });
      files += createMusicFileHtml(song.filepath, song.metadata.title ? song.metadata.title : song.metadata.filename, undefined, undefined, song.metadata.artist ? song.metadata.artist : undefined);
    });
    files += '</ul>';

    document.getElementById('filelist').innerHTML = files;
  }catch(err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
    boilerplateFailure(err);
  }
}

////////////// Rated Songs
async function getRatedSongs() {
  setBrowserRootPanel('Starred');
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allRated' }];

  try {
    const response = await MSTREAMAPI.getRated();
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
        value.metadata.title ? value.metadata.title : value.filepath, 
        value.metadata['album-art'] ? `src="album-art/${value.metadata['album-art']}?token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        rating,
        value.metadata.artist ? `<span style="font-size:15px;">${value.metadata.artist}</span>` : undefined);
    });

    document.getElementById('filelist').innerHTML = files;
  }catch (err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
    return boilerplateFailure(err);
  }
}

///////////////// Recently Added
function getRecentlyAdded() {
  setBrowserRootPanel('Recently Added');
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  document.getElementById('directoryName').innerHTML = 'Get last &nbsp;&nbsp;<input onkeydown="submitRecentlyAdded();" onfocusout="redoRecentlyAdded();" id="recently-added-limit" class="recently-added-input" type="number" min="1" step="1" value="100">&nbsp;&nbsp; songs';

  redoRecentlyAdded();
}

async function redoRecentlyAdded() {
  currentBrowsingList = [];
  programState = [{ state: 'recentlyAdded'}];

  try {
    const response = await MSTREAMAPI.getRecentlyAdded(document.getElementById('recently-added-limit').value);
    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop()
      });

      filelist += createMusicFileHtml(el.filepath,
        el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop(),
        el.metadata['album-art'] ? `src="album-art/${el.metadata['album-art']}?token=${MSTREAMAPI.currentServer.token}"` : `src="assets/img/default.png"`, 
        undefined,
        el.metadata.artist ? `<span style="font-size:15px;">${el.metadata.artist}</span>` : undefined);
    });

    filelist += '</ul>'
  
    document.getElementById('filelist').innerHTML = filelist;
  }catch(err) {
    document.getElementById('filelist').innerHTML = '<div>Server call failed</div>';
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
  setBrowserRootPanel('Transcode', false);

  if (!MSTREAMPLAYER.transcodeOptions.serverEnabled) {
    document.getElementById('filelist').innerHTML = '<p><b>Transcoding is disabled on this server</b></p>';
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
        Default Codec:<br> <b>${MSTREAMPLAYER.transcodeOptions.defaultCodec} ${MSTREAMPLAYER.transcodeOptions.defaultBitrate} ${MSTREAMPLAYER.transcodeOptions.defaultAlgo}</b>
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
        <br>
        <label for="trans-algo-select">Algorithm</label>
        <select onchange="changeTranscodeAlgo();" class="browser-default trans-input" name="pets" id="trans-algo-select">
          <option value="">Default</option>
          <option value="buffer">Buffer</option>
          <option value="stream">Stream</option>
        </select>
      </form>
    </div>`;

  document.getElementById('trans-codec-select').value = MSTREAMPLAYER.transcodeOptions.selectedCodec ? MSTREAMPLAYER.transcodeOptions.selectedCodec : "";
  document.getElementById('trans-bitrate-select').value = MSTREAMPLAYER.transcodeOptions.selectedBitrate ? MSTREAMPLAYER.transcodeOptions.selectedBitrate : "";
  document.getElementById('trans-algo-select').value = MSTREAMPLAYER.transcodeOptions.selectedAlgo ? MSTREAMPLAYER.transcodeOptions.selectedAlgo : "";
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

function changeTranscodeAlgo() {
  const value = document.getElementById("trans-algo-select").value;
  MSTREAMPLAYER.transcodeOptions.selectedAlgo = value ? value : null;
  value ? localStorage.setItem('trans-algo-select', value) : localStorage.removeItem('trans-algo-select');
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
  setBrowserRootPanel('Mobile Apps', false);

  document.getElementById('filelist').innerHTML = 
    `<div class='mobile-links'>
      <a target='_blank' href='https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1'><img alt='Get it on Google Play' src='https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png'/></a>
      <div class='mobile-placeholder'>&nbsp;</div>
    </div>
    <div class='app-text'>
      <a target='_blank' href='/qr'>Checkout the QR Code tool to help add your server to the app</a>
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
  setBrowserRootPanel('Auto DJ', false);

  let newHtml = '<br><p>Auto DJ randomly generates a playlist.  Click the \'DJ\' button on the bottom enable it</p><h3>Use Folders</h3><p>';
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

  newHtml += '</p><h3>Minimum Rating</h3> <select class="browser-default" onchange="updateAutoDJRatings(this)" id="autodj-ratings">';
  for (let i = 0; i < 11; i++) {
    newHtml += `<option ${(Number(MSTREAMPLAYER.minRating) === i) ? 'selected' : ''} value="${i}">${(i ===0) ? 'Disabled' : +(i/2).toFixed(1)}</option>`;
  }
  newHtml += '</select>';
  newHtml += '<br><br><br><p><input type="button" value="Toggle Auto DJ" onclick="MSTREAMPLAYER.toggleAutoDJ();"></p>'
  
  document.getElementById('filelist').innerHTML = newHtml;
}

function onAutoDJFolderChange(el) {
  // Don't allow user to deselect all options
  if (document.querySelector('input[name=autodj-folders]:checked') === null) {
    el.checked = true;
    iziToast.warning({
      title: 'Auto DJ requires a directory',
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
  setBrowserRootPanel('Jukebox Mode', false);

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
        filelist += `<div data-artist="${x.name}" class="artistz" onclick="getArtistz(this)">${x.name}</div>`;
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
const searchToggles = {
  albums: true,
  artists: true,
  files: false,
  titles: true
}

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
  setBrowserRootPanel('Search DB');
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

    var postObject = { search: document.getElementById('search-term').value};
    if (document.getElementById("search-in-artists") && document.getElementById("search-in-artists").checked === false) { postObject.noArtists = true; }
    searchToggles.artists = document.getElementById("search-in-artists").checked;
    if (document.getElementById("search-in-albums") && document.getElementById("search-in-albums").checked === false) { postObject.noAlbums = true; }
    searchToggles.albums = document.getElementById("search-in-albums").checked;
    if (document.getElementById("search-in-filepaths") && document.getElementById("search-in-filepaths").checked === false) { postObject.noFiles = true; }
    searchToggles.files = document.getElementById("search-in-filepaths").checked;
    if (document.getElementById("search-in-titles") && document.getElementById("search-in-titles").checked === false) { postObject.noTitles = true; }
    searchToggles.titles = document.getElementById("search-in-titles").checked;

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

loadFileExplorer();
init();