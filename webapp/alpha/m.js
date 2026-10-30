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
let popFInstance;   // the one live Popper on #pop-f (createPopper3)

///////////////////////// Federation: which server the app is pointed at
//
// `peerContext` is the server the app is showing — null for this one, set by
// the top-bar dropdown (see the server switcher further down). It is read
// AMBIENTLY by the render helpers and by browseApi() below, so one set of
// renderers and one set of browse calls serve both sides instead of a forked
// peer universe.
//
// Every row a peer view renders also carries `data-peer`, and the CLICK
// handlers read that attribute rather than the ambient context. Two
// reasons: the DB-search panel mixes local and peer hits in one list, where
// the ambient context is null and the attribute is the only truth; and a
// row clicked after an async re-render is guaranteed to act on the peer it
// was drawn for.
//
// Handlers that NAVIGATE (open an album, an artist, a folder) adopt the
// row's peer first, which is what lets a peer album opened from search go
// on browsing that peer. Handlers that merely QUEUE read the attribute and
// leave the context alone — playing a peer track from a mixed search list
// must not move the browser onto that peer.
let peerContext = null;

// Bumped whenever the app changes which server it points at (switchServer /
// adoptPeer). A panel loader captures it before its await and bails if it
// changed while the request was in flight, so a slow response from the old
// server can't overwrite the new panel or get its rows stamped with the new
// server's peer id.
let browseGeneration = 0;

// Same idea for the multi-server search fan-out: submitSearchForm bumps this,
// and a peer answer from a superseded run is dropped instead of appended to the
// current results. Re-submitting the SAME term would otherwise slip past the
// term-only peerResultSlot check and duplicate every peer block.
let searchGeneration = 0;
// id -> { id, name }. addFederationSongWizard wants a display name for the
// queue row and a row only carries the id. Filled by loadServerSwitcher()
// and by anything else that learns a peer's name (e.g. search attribution).
const knownPeers = new Map();

function rememberPeer(peer) {
  if (peer && peer.id !== undefined && peer.id !== null) {
    knownPeers.set(Number(peer.id), { id: Number(peer.id), name: peer.name || 'peer' });
  }
  return peer;
}

// Rendered into every row while a peer view is open.
function peerAttr(peer) {
  const p = peer === undefined ? peerContext : peer;
  return p ? ` data-peer="${escapeHtml(p.id)}"` : '';
}

// The peer a clicked row belongs to, or null when the row is local.
function peerOf(el) {
  const raw = el && el.getAttribute ? el.getAttribute('data-peer') : null;
  if (!raw) { return null; }
  const id = Number(raw);
  return knownPeers.get(id) || { id: id, name: 'peer' };
}

// Point the app at whatever server the clicked row came from — used by the
// handlers that NAVIGATE. A federated hit in a multi-server search result is
// the one place a row can disagree with the dropdown, and following it moves
// the whole app (dropdown, nav, read-only note) onto that server rather than
// leaving a half-switched UI. The queueing handlers use peerOf() instead and
// leave the context alone.
function adoptPeer(el) {
  const next = peerOf(el);
  const changed = (next ? next.id : null) !== (peerContext ? peerContext.id : null);
  peerContext = next;
  if (changed) { browseGeneration++; applyServerContext(); }
  return peerContext;
}

// One browse call, routed to the peer being browsed or to this server.
// The peer wrappers in api.js mirror the local names exactly, so the only
// difference at the call site is which server answers.
function browseApi(name, postObject) {
  if (peerContext) { return MSTREAMAPI.peer[name](peerContext.id, postObject); }
  return MSTREAMAPI[name](postObject);
}

// vpaths to hide, for a LOCAL call only. The Auto-DJ folder filter names
// vpaths in this library; a peer's namespace is its own, and the peer
// already scopes every answer to the libraries our key was granted.
function localIgnoreVPaths() {
  if (peerContext) { return undefined; }
  return Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
    return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
  });
}

// Album-art URL for the panel being rendered: this server's /album-art, or
// a peer's art through the proxy.
function artUrl(artFile, compress) {
  if (!artFile) { return null; }
  if (peerContext) { return MSTREAMAPI.peerArtUrl(peerContext.id, artFile, compress); }
  return `${MSTREAMAPI.currentServer.host}album-art/${escapeHtml(artFile)}?${compress ? `compress=${compress}&` : ''}token=${MSTREAMAPI.currentServer.token}`;
}

// The `aa` argument createMusicFileHtml expects: a full src attribute for
// the panel's server, or the bundled default cover.
function artImgAttr(artFile, compress) {
  const url = artUrl(artFile, compress);
  return url ? `src="${url}"` : 'src="assets/img/default.png"';
}

// Album-art URL for a specific SONG (queue row / now-playing card), which may
// be a peer track. Unlike artUrl(), the peer identity comes from the song
// itself (song.federation), not the ambient peerContext — a peer track can be
// playing while the app is pointed back at this server. The caller guards the
// no-art case (its two consumers differ: bundled default cover vs. null).
function songArtUrl(artFile, song, compress) {
  if (song && song.federation) {
    return MSTREAMAPI.peerArtUrl(song.federation.peerId, artFile, compress);
  }
  const token = (song && song.authToken) || MSTREAMAPI.currentServer.token;
  return `${MSTREAMAPI.currentServer.host}album-art/${artFile}?compress=${compress}&token=${token}`;
}

// Queue a row that may live on a peer. Peer tracks bypass addSongWizard
// entirely (see addFederationSongWizard) — transcode, waveform prefetch,
// live-playlist save and metadata lookup all resolve against the LOCAL
// library, and this path is in the peer's namespace.
function queueRow(peer, filepath, metadata, position) {
  const meta = metadata || {};
  const hasMeta = Object.keys(meta).length > 0;
  if (peer) {
    // autoPlayOff mirrors the local branch (!hasMeta): a peer row normally
    // carries metadata, so it should autoplay onto an empty queue just like a
    // local one. Hard-coding true left peer tracks loaded but paused.
    VUEPLAYERCORE.addFederationSongWizard(peer, filepath, meta, !hasMeta, position);
    return;
  }
  // lookupMetadata only when the row carried none — the same bargain
  // searchFileClick strikes, and what the browse panels have always done.
  VUEPLAYERCORE.addSongWizard(filepath, meta, !hasMeta, position);
}

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

// The artist line an album card shows and the `album_artist` it may send
// back to /db/album-songs, from one /db/albums (or artists-albums) item.
// `album_artist` is the group's single credit and null when the collapsed
// rows disagree; it is the ONLY value fit to send back — a joined display of
// several credits matches nothing and would open an empty album. The line
// falls back to the credits so a disagreeing card still says who is on it.
// A server without the fields (a peer on an older version) gives nulls and
// the card renders exactly as before.
function albumCredit(value) {
  const albumArtist = typeof value.album_artist === 'string' && value.album_artist ? value.album_artist : null;
  const artists = Array.isArray(value.artists) ? value.artists.filter((a) => typeof a === 'string' && a) : [];
  return { albumArtist, line: albumArtist || (artists.length ? artists.join(', ') : null) };
}

// `albumArtist` rides along as data-album-artist so getAlbumsOnClick and
// queueAlbum open exactly this card when two albums share a name; `artistLine`
// is display only. Both are optional — a panel that lacks them draws the
// pre-series card. `compilation` (the listing's) rides as data-compilation:
// a connected server's compilation keeps no Artist in its Keep a copy, whose
// ⋯ and state line a connected server's card adds (browseKeepCard).
function renderAlbum(id, artist, name, albumArtFile, year, albumArtist, artistLine, compilation) {
  const artSrc = artUrl(albumArtFile, VUEPLAYERCORE.altLayout.compressArt ? 'l' : undefined);
  const keep = browseKeepCard(id, albumArtist, albumArtFile, [name, artistLine, year]);

  return `<div class="album-grid-card"${peerAttr()} ${year ? `data-year="${escapeHtml(year)}"` : ''} ${artist ? `data-artist="${escapeHtml(artist)}"` : ''} ${albumArtist ? `data-album-artist="${escapeHtml(albumArtist)}"` : ''} ${id ? `data-album="${escapeHtml(id)}"` : ''}${compilation === true ? ' data-compilation="true"' : ''}${keep.attrs} onclick="getAlbumsOnClick(this);">
    <div class="album-grid-art">
      ${artSrc
        ? `<img loading="lazy" src="${artSrc}">`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#555"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`}
      <button class="album-grid-play" onclick="event.stopPropagation(); queueAlbum(this.closest('.album-grid-card'));" title="Add album to queue">
        <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>${keep.more}
    </div>
    <div class="album-grid-info">
      <div class="album-grid-name">${escapeHtml(name)}</div>
      ${artistLine ? `<div class="album-grid-artist">${escapeHtml(artistLine)}</div>` : ''}
      ${year ? `<div class="album-grid-year">${escapeHtml(year)}</div>` : ''}${keep.line}
    </div>
  </div>`;
}

function renderArtist(artist) {
  return `<li class="collection-item">
      <div data-artist="${escapeHtml(artist)}"${peerAttr()} class="artistz" onclick="getArtistz(this)">${escapeHtml(artist)}</div>
    </li>`;
}

// `source` — 'tag' | 'model', the one kind of genre the list shows — rides
// on the row so its songs are asked for the same way; null when the list
// shows both kinds, or the server does not tell them apart.
function renderGenre(genre, trackCount, source) {
  return `<li class="collection-item">
    <div data-genre="${escapeHtml(genre)}"${source ? ` data-genre-source="${escapeHtml(source)}"` : ''}${peerAttr()} class="artistz" onclick="getGenreSongsList(this)">
      ${escapeHtml(genre)} <span style="color:#888;font-size:13px;">(${escapeHtml(trackCount)})</span>
    </div>
  </li>`;
}

function renderFileWithMetadataHtml(filepath, lokiId, metadata) {
  return `<li data-lokiid="${lokiId}" class="collection-item">
    <div data-file_location="${escapeHtml(filepath)}" class="filez flex" onclick="onFileClick(this);">
      <img class="album-art-box" loading="lazy" ${metadata['album-art'] ? `src="${MSTREAMAPI.currentServer.host}album-art/${escapeHtml(metadata['album-art'])}?compress=s&token=${MSTREAMAPI.currentServer.token}"` : 'src="assets/img/default.png"'}>
      <div>
        <b><span>${escapeHtml((!metadata || !metadata.title) ? filepath.split("/").pop() : metadata.title)}</span></b>
        ${metadata.artist ? `</b><br><span style="font-size:15px;">${escapeHtml(metadata.artist)}</span>` : ''}
      </div>
    </div>
    <div class="song-button-box">
      <span title="Play Now" onclick="playNow(this);" data-file_location="${escapeHtml(filepath)}" class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      <span data-lokiid="${lokiId}" class="removePlaylistSong" onclick="removePlaylistSong(this);">remove</span>
    </div>
  </li>`;
}

// A connected server's row also carries Keep a copy's ⋯ in the ▾'s place
// (browseKeepSongTab: its ▾ could only say the track joins no playlist
// here), and on an album page the slot its copy's mark draws in.
function createMusicFileHtml(fileLocation, title, aa, rating, subtitle) {
  const keep = browseKeepSongTab(fileLocation, title);
  const mark = browseKeepSongMark(fileLocation);
  return `<li class="collection-item">
    <div data-file_location="${escapeHtml(fileLocation)}"${peerAttr()} class="filez ${aa ? 'flex2' : ''}" onclick="onFileClick(this);">
      ${aa ? `<img loading="lazy" class="album-art-box" ${aa}>` : '<svg class="music-image" height="18" width="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M9 37.5c-3.584 0-6.5-2.916-6.5-6.5s2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V5.429l25-3.846V29c0 3.584-2.916 6.5-6.5 6.5s-6.5-2.916-6.5-6.5 2.916-6.5 6.5-6.5a6.43 6.43 0 012.785.634l.715.34V11.023l-19 2.931V31c0 3.584-2.916 6.5-6.5 6.5z" fill="#8bb7f0"/><path d="M37 2.166V29c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V10.441l-1.152.178-18 2.776-.848.13V31c0 3.308-2.692 6-6 6s-6-2.692-6-6 2.692-6 6-6a5.93 5.93 0 012.57.586l1.43.68V5.858l24-3.692M38 1L12 5v19.683A6.962 6.962 0 009 24a7 7 0 107 7V14.383l18-2.776v11.076A6.962 6.962 0 0031 22a7 7 0 107 7V1z" fill="#4e7ab5"/></svg>'} 
      <span>
        ${subtitle !== undefined ? `<b>` : ''}
        <span class="${aa ? '' : 'item-text'}">${rating ? `[${rating}] ` : ''}${escapeHtml(title)}</span>
        ${subtitle !== undefined ? `</b><br><span style="font-size:15px;">${escapeHtml(subtitle)}</span>` : ''}${mark}
      </span>
    </div>
    <div class="song-button-box">
      <span title="Play Now" onclick="playNow(this);" data-file_location="${escapeHtml(fileLocation)}"${peerAttr()} class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      ${keep || `<span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${escapeHtml(fileLocation)}"${peerAttr()} class="fileAddToPlaylist">
        <svg class="pop-f" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-f" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
      </span>`}
    </div>
  </li>`;
}

// A connected server's folder row (below its library list) carries Keep a
// copy's ⋯ in the ↓'s place (its ↓ could only say the folder zips nowhere)
// and the slot its folder copy's mark draws in (browseKeepFolderRow).
function renderDirHtml(name) {
  const keep = browseKeepFolderRow(name);
  return `<li class="collection-item">
    <div data-directory="${escapeHtml(name)}"${peerAttr()} class="dirz" onclick="handleDirClick(this);">
      <svg class="folder-image" viewBox="0 0 48 48" version="1.0" xmlns="http://www.w3.org/2000/svg"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
      <span class="item-text">${escapeHtml(name)}</span>${keep.mark}
    </div>
    <div class="song-button-box">
      <span style="padding-top:1px;" title="Add All To Queue" class="songDropdown" onclick="recursiveAddDir(this);" data-directory="${escapeHtml(name)}"${peerAttr()}>
        <svg xmlns="http://www.w3.org/2000/svg" height="10" width="10" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>
      </span>
      ${keep.tab || `<span data-directory="${escapeHtml(name)}"${peerAttr()} title="Download Directory" class="downloadDir" onclick="recursiveFileDownload(this);">
        <svg width="13" height="13" viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg"><path d="M1803 960q0 53-37 90l-651 652q-39 37-91 37-53 0-90-37l-651-652q-38-36-38-90 0-53 38-91l74-75q39-37 91-37 53 0 90 37l294 294v-704q0-52 38-90t90-38h128q52 0 90 38t38 90v704l294-294q37-37 90-37 52 0 91 37l75 75q37 39 37 91z"/></svg>
      </span>`}
    </div>
  </li>`
}

function createFileplaylistHtml(dataDirectory) {
  return `<li class="collection-item pointer">
    <div data-directory="${escapeHtml(dataDirectory)}" class="fileplaylistz" onclick="onFilePlaylistClick(this);">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="25" height="25"><path d="M14.5 8a2.495 2.495 0 0 0-2.5 2.5v45c0 1.385 1.115 2.5 2.5 2.5h35c1.385 0 2.5-1.115 2.5-2.5V23l-13.75-1.25L37 8Z" opacity=".2"/><path fill="#1e98d1" d="M14.5 7A2.495 2.495 0 0 0 12 9.5v45c0 1.385 1.115 2.5 2.5 2.5h35c1.385 0 2.5-1.115 2.5-2.5V22l-13.75-1.25L37 7z"/><path d="M37 8v12.5a2.5 2.5 0 0 0 2.5 2.5H52Z" opacity=".2"/><path fill="#67bbe9" d="M37 7v12.5a2.5 2.5 0 0 0 2.5 2.5H52L37 7z"/><path d="M14.5 7A2.495 2.495 0 0 0 12 9.5v1C12 9.115 13.115 8 14.5 8H37V7z" opacity=".2" fill="#fff"/><path d="M24.199 28A2.149 2.085 0 0 0 22 30.086v19.831a2.149 2.085 0 0 0 3.223 1.805l17.704-9.916a2.149 2.085 0 0 0 0-3.61L25.223 28.28a2.149 2.085 0 0 0-1.024-.28z" opacity=".2"/><path d="M24.199 27A2.149 2.085 0 0 0 22 29.086v19.831a2.149 2.085 0 0 0 3.223 1.805l17.704-9.916a2.149 2.085 0 0 0 0-3.61L25.223 27.28a2.149 2.085 0 0 0-1.024-.28z" fill="#fff"/></svg>
      <span class="item-text">${escapeHtml(dataDirectory)}</span>
    </div>
    <div class="song-button-box">
      <span title="Add All To Queue" class="addFileplaylist" onclick="addFilePlaylist(this);" data-directory="${escapeHtml(dataDirectory)}">
        <svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" viewBox="0 0 1280 1276"><path d="M6760 12747 c-80 -5 -440 -10 -800 -11 -701 -2 -734 -4 -943 -57 -330 -84 -569 -281 -681 -563 -103 -256 -131 -705 -92 -1466 12 -241 16 -531 16 -1232 l0 -917 -1587 -4 c-1561 -3 -1590 -3 -1703 -24 -342 -62 -530 -149 -692 -322 -158 -167 -235 -377 -244 -666 -43 -1404 -42 -1813 7 -2355 21 -235 91 -400 233 -548 275 -287 730 -389 1591 -353 1225 51 2103 53 2330 7 l60 -12 6 -1489 c6 -1559 6 -1548 49 -1780 100 -535 405 -835 933 -921 88 -14 252 -17 1162 -24 591 -4 1099 -4 1148 1 159 16 312 56 422 112 118 59 259 181 333 290 118 170 195 415 227 722 18 173 21 593 6 860 -26 444 -32 678 -34 1432 l-2 811 54 7 c30 4 781 6 1670 5 1448 -2 1625 -1 1703 14 151 28 294 87 403 168 214 159 335 367 385 666 15 85 29 393 30 627 0 105 4 242 10 305 43 533 49 1047 15 1338 -44 386 -144 644 -325 835 -131 140 -278 220 -493 270 -92 21 -98 21 -1772 24 l-1680 3 3 1608 c2 1148 0 1635 -8 1706 -49 424 -255 701 -625 841 -243 91 -633 124 -1115 92z" transform="matrix(.1 0 0 -.1 0 1276)"/></svg>
      </span>
      <span data-directory="${escapeHtml(dataDirectory)}" title="Download Playlist" class="downloadFileplaylist" onclick="downloadFileplaylist(this);">
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
  // A connected server's page header goes (the panel's own answer draws
  // it again) — the page it tops held first, as it stands, in case the
  // panel's load fails (browseKeepBack).
  browseKeepReset(true);

  if(showBar === false) {
    document.getElementById('directory_bar').style.display = 'none';
  }else {
    document.getElementById('directory_bar').style.display = '';
  }

  // Discover's bar lives in the column's chrome: no other panel shows it.
  discoveryHideHead();

  document.getElementById('localSearchBar').value = "";
  document.getElementById('directoryName').innerHTML = '';
  document.getElementById('local_search_btn').style.display = '';
  document.getElementById('upload_btn').classList.add('super-hide');
  document.getElementById('mkdir_btn').classList.add('super-hide');
  // The Genres panel's switch; getAllGenres shows it when there's a choice.
  document.getElementById('genre_source')?.classList.add('super-hide');
  // The mood filters: Albums, Artists, Rated and Recently Added show them
  // again (showMoodFilters), with the panel closed — hidden by default on
  // every visit.
  hideMoodFilters();

  // Inside a peer view every panel says whose library it is showing.
  const label = peerContext ? `${escapeHtml(peerContext.name)} &middot; ${panelName}` : panelName;
  ([...document.getElementsByClassName('panel_one_name')]).forEach(el => {
    el.innerHTML = label;
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
  // Construct the directory string
  const directoryString = root === true ? '~' : getFileExplorerPath();
  browseKeepReset();
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  const gen = browseGeneration;
  try {
    // A connected server's rows draw their ways in from the gate: read
    // before the first draw, beside the listing.
    const gate = keepGateFor(peerContext);
    const response = peerContext
      ? await MSTREAMAPI.peer.dirparser(peerContext.id, directoryString)
      : await MSTREAMAPI.dirparser(directoryString);
    await gate;
    if (gen !== browseGeneration) { return; }
    document.getElementById('directoryName').innerHTML = escapeHtml(response.path);

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
    // Both are writes, and a federation key carries no write permission —
    // the peer's allowlist stops at reads, so never offer them there.
    if (fileExplorerArray.length > 0 && !peerContext) {
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
    // a connected server that stopped answering: the folder it was on
    browseKeepBack(gen);
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
    // .m3u playlists resolve against THIS library's paths and there is no peer
    // wrapper to load, queue, or download one — skip them on a peer rather than
    // render rows whose handlers would call local APIs with a peer path.
    if (file.type === 'm3u' && peerContext) { continue; }
    const filePath = file.path || response.path + file.name;
    const title = file.artist != null || file.title != null ? file.artist + ' - ' + file.title : file.name;
    currentBrowsingList.push({ type: file.type, name: file.name, path: filePath, title });
    if (file.type === 'm3u') {
      filelist += createFileplaylistHtml(file.name);
    } else {
      filelist += createMusicFileHtml(filePath, title);
    }
  }

  filelist += '</ul>';

  // clear the list
  document.getElementById('localSearchBar').value = '';

  // Post the html to the filelist div
  document.getElementById('filelist').innerHTML = filelist;
  browseKeepDrawn();

  // A connected server's folder: its header and its rows' marks.
  if (peerContext) { browseFolderPage(response); }
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
  adoptPeer(el);
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
    // iziToast renders title as HTML; msg can be a server error string.
    title: escapeHtml(msg),
    position: 'topCenter',
    timeout: 3500
  });
}

function onFileClick(el) {
  const peer = peerOf(el);
  // Sonic Path song-capture: an armed picker takes the next SINGLE row
  // click; bulk actions never come through here, so they queue normally.
  if (VUEPLAYERCORE.songCapture) {
    // A peer track can't seed a path — the arc is computed from embeddings
    // in the LOCAL index, and this filepath is in the peer's namespace.
    // Say so and leave the picker armed for a local row.
    if (peer) {
      iziToast.warning({ title: t('sonicPath.federatedTrack'), position: 'topCenter', timeout: 3000 });
      return;
    }
    const capture = VUEPLAYERCORE.songCapture;
    VUEPLAYERCORE.songCapture = null;
    capture({ filepath: el.getAttribute("data-file_location") });
    return;
  }
  queueRow(peer, el.getAttribute("data-file_location"));
}

// Metadata for the current DB-search results, keyed by (peer, raw filepath).
// The search API returns the lite metadata subset inline on track hits
// (toLiteMetadata: no composer / hash / stats), so the search-result handlers
// below enqueue with it directly and skip
// the per-click /api/v1/db/metadata round-trip that the shared
// onFileClick/playNow (used by the file browser, which has no inline
// metadata) still perform. Rebuilt on every search in submitSearchForm().
//
// The peer is part of the key because results from several servers share one
// list, and two libraries can easily hold the same "music/Artist/01.flac".
let searchResultMetadata = {};

function searchKey(peerId, filepath) {
  return `${peerId === undefined || peerId === null ? '' : peerId}:${filepath}`;
}

// Search-result variants of onFileClick / playNow: enqueue with the inline
// metadata when we have it (so the wizard skips the lookup), else fall back
// to a server lookup for safety. A row from a peer queues over the bridge.
function searchFileClick(el) {
  const peer = peerOf(el);
  const fp = el.getAttribute("data-file_location");
  queueRow(peer, fp, searchResultMetadata[searchKey(peer && peer.id, fp)]);
}

function searchPlayNow(el) {
  const peer = peerOf(el);
  const fp = el.getAttribute("data-file_location");
  queueRow(peer, fp, searchResultMetadata[searchKey(peer && peer.id, fp)], MSTREAMPLAYER.positionCache.val + 1);
}

async function recursiveAddDir(el) {
  const peer = adoptPeer(el);
  try {
    const directoryString = getDirectoryString2(el);
    const res = peer
      ? await MSTREAMAPI.peer.recursiveScan(peer.id, directoryString)
      : await MSTREAMAPI.recursiveScan(directoryString);
    res.forEach(fp => queueRow(peer, fp));
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
  
    document.getElementById('directoryName').innerHTML = escapeHtml('/' + directoryString.substring(0, directoryString.length - 1));
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

// filepath -> metadata for the file rows the open panel drew from a DB
// response: a playlist, genre, album, starred, recently played / added and
// most played all arrive with the same full metadata object
// /api/v1/db/metadata answers with, so Add All can queue them as they are
// instead of looking every row up again — a 5,000-track playlist was 5,000
// round-trips. Rows drawn without it (the file explorer, Downloads, a
// playlist entry whose file is gone) are left out and keep their lookup. So
// is DB search: it never fills currentBrowsingList, and its hits carry only
// the lite subset (no composer), which a lookup still completes.
// Keyed by path alone: each panel that fills currentBrowsingList shows a
// single server's library, so one path can't name two different tracks.
// Playlist entries keep the path under `filepath`, every other panel `path`.
function browsingListMetadata() {
  const byPath = new Map();
  currentBrowsingList.forEach(x => {
    const fp = x.path || x.filepath;
    if (x.type === 'file' && fp && x.metadata && Object.keys(x.metadata).length > 0) {
      byPath.set(fp, x.metadata);
    }
  });
  return byPath;
}

function addAll() {
  const known = browsingListMetadata();
  ([...document.getElementsByClassName('filez')]).forEach(el => {
    const fp = el.getAttribute("data-file_location");
    const meta = known.get(fp);
    // A copy per row, like the fresh object each lookup used to bring back:
    // the queue edits its entries' metadata in place (ratings), and that
    // must not reach back into the panel's list.
    queueRow(peerOf(el), fp, meta && { ...meta });
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
  const albumArtist = cardEl.getAttribute('data-album-artist') || null;
  const peer = adoptPeer(cardEl);

  try {
    const response = await browseApi('albumSongs', albumSongsBody(album, artist, year, albumArtist));

    response.forEach(song => {
      queueRow(peer, song.filepath, song.metadata || {});
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
  queueRow(peerOf(el), el.getAttribute("data-file_location"), undefined, MSTREAMPLAYER.positionCache.val + 1);
}

async function init() {
  try {
    const response = await MSTREAMAPI.ping();
    MSTREAMAPI.currentServer.vpaths = response.vpaths;
    VUEPLAYERCORE.playlists.length = 0;
    document.getElementById('pop-f').innerHTML = `<div class="pop-f pop-playlist">${t('playlist.addToPlaylist')}</div>`;

    response.playlists.forEach(p => {
      VUEPLAYERCORE.playlists.push(p);
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" data-playlist="${escapeHtml(p.name)}" onclick="addToPlaylistUI(this.getAttribute('data-playlist'))">&#8226; ${escapeHtml(p.name)}</div>`;
      document.getElementById('live-playlist-select').innerHTML += `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`;
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
    // The formats this server plays ({ mp3: true, … }): a connected
    // server's folder is counted, listed and played as a copy of it takes
    // its songs (the Keep a copy window's folder count).
    MSTREAMAPI.currentServer.supportedAudioFiles = response.supportedAudioFiles || null;

    // Discovery capability — consumed by the Discover panel (below) and
    // the Auto-DJ panel's sonic-similarity section.
    MSTREAMAPI.currentServer.discovery = response.discovery === true;
    // Stats API v2 — with it, the player reports complete plays instead of
    // the 30-second scrobble (assets/js/mstream.player.js), and posts what
    // an earlier page left behind.
    MSTREAMAPI.currentServer.stats = Number(response.stats) || 0;
    if (typeof MSTREAMPLAYER.statsInit === 'function') { MSTREAMPLAYER.statsInit(); }
    // The listening page (/stats) reads the same API; its nav entry follows the flag.
    document.getElementById('nav-stats').classList.toggle('super-hide', MSTREAMAPI.currentServer.stats < 2);
    VUEPLAYERCORE.setDiscoveryAvailable(response.discovery === true);
    VUEPLAYERCORE.setDiscoveryP2pAvailable(response.discoveryP2p === true);
    VUEPLAYERCORE.setFederationDiscoveryAvailable(response.federationDiscovery === true);
    // Discovery plug-ins (actions on a recommendation row) — the flag says
    // the server has at least one switched on; the list is fetched lazily.
    VUEPLAYERCORE.setDiscoveryPluginsAvailable(response.discoveryPlugins === true);
    // Admins get the "Invite <peer> to federate" row in the recommendation
    // modal. Identity lives on the layered /api/ endpoint (ping is a frozen
    // flat contract); a server without /api/ or a failed call = not admin,
    // and the row simply never shows.
    MSTREAMAPI.serverInfo()
      .then((info) => {
        const admin = !!(info && info.user && info.user.admin === true);
        MSTREAMAPI.currentServer.admin = admin;   // the Downloads panel's "All accounts"
        VUEPLAYERCORE.setAdmin(admin);
      })
      .catch(() => { MSTREAMAPI.currentServer.admin = false; VUEPLAYERCORE.setAdmin(false); });
    // Sonic Path is a standalone side-nav panel — reveal its nav entry
    // only when the server has the route (never probed).
    MSTREAMAPI.currentServer.discoveryPath = response.discoveryPath === true;
    document.getElementById('nav-sonic-path').classList.toggle('super-hide', response.discoveryPath !== true);
    // Downloads: what the discovery plug-ins brought in — the same flag as
    // the "Get it" rows, so the panel exists only where a download can.
    document.getElementById('nav-discover-downloads').classList.toggle('super-hide', response.discoveryPlugins !== true);
    // The Discover page (seeded by play history): its nav entry, its flags.
    applyDiscoveryPing(response);

    // Federation: is there another server to point this app at? The flag
    // means "federation is on AND at least one peer is paired" — no probing.
    MSTREAMAPI.currentServer.federationBrowse = response.federationBrowse === true;
    if (MSTREAMAPI.currentServer.federationBrowse) { loadServerSwitcher(); }

    if (response.transcode) {
      MSTREAMPLAYER.transcodeOptions.serverEnabled = true;
      MSTREAMPLAYER.transcodeOptions.defaultCodec = response.transcode.defaultCodec;
      MSTREAMPLAYER.transcodeOptions.defaultBitrate = response.transcode.defaultBitrate;
    }
  }catch (err) {
    console.error('init failed', err);
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
  // Playlists store paths against THIS library — a peer's path would save
  // as a row that resolves to nothing. Say so instead of opening a picker
  // whose every option fails on submit (the same bargain the rating popper
  // strikes on peer tracks in vp.js).
  if (peerOf(el)) {
    iziToast.info({ title: t('peers.noPlaylist'), position: 'topCenter', timeout: 2500 });
    return;
  }
  // One instance at a time. Every click used to stack a new Popper on the
  // same element without destroying the last; a stale instance whose
  // reference row had since been re-rendered away kept writing its own
  // position, and the menu landed at the screen's edge (seen on Discover,
  // whose rows re-render on every answer).
  if (popFInstance) { popFInstance.destroy(); popFInstance = undefined; }
  if (curFileTracker === el.getAttribute("data-file_location")) {
    curFileTracker = undefined;
    document.getElementById("pop-f").style.visibility = "hidden";
    return;
  }

  curFileTracker = el.getAttribute("data-file_location")
  popFInstance = Popper.createPopper(el, document.getElementById('pop-f'), {
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

// ---------------------------------------------------------------------------
// Keyboard Shortcuts modal (Layout > Keyboard Shortcuts). Bindings live in
// MSTREAMPLAYER.hotkeys (mstream.player.js) so the shared-playlist page picks
// them up too; this modal is just the editor. One combo maps to one action —
// assigning a combo that another action holds steals it (the other action
// goes unbound). percentSeek is the fixed 0-9 digit row: clear/restore only.
const HOTKEY_MODAL_ROWS = [
  ['playPause', 'hotkeys.action.playPause'],
  ['playPauseAlt', 'hotkeys.action.playPauseAlt'],
  ['seekBack', 'hotkeys.action.seekBack'],
  ['seekForward', 'hotkeys.action.seekForward'],
  ['bigSeekBack', 'hotkeys.action.bigSeekBack'],
  ['bigSeekForward', 'hotkeys.action.bigSeekForward'],
  ['prevTrack', 'hotkeys.action.prevTrack'],
  ['nextTrack', 'hotkeys.action.nextTrack'],
  ['percentSeek', 'hotkeys.action.percentSeek'],
  ['volumeUp', 'hotkeys.action.volumeUp'],
  ['volumeDown', 'hotkeys.action.volumeDown'],
  ['mute', 'hotkeys.action.mute'],
  ['shuffle', 'hotkeys.action.shuffle'],
  ['repeat', 'hotkeys.action.repeat'],
  ['speedUp', 'hotkeys.action.speedUp'],
  ['speedDown', 'hotkeys.action.speedDown'],
];

function formatHotkeyCombo(combo) {
  if (combo === null || combo === undefined) { return t('hotkeys.none'); }
  if (combo === '0-9') { return '0 – 9'; }
  const pretty = { ' ': t('hotkeys.space'), 'ArrowLeft': '←', 'ArrowRight': '→', 'ArrowUp': '↑', 'ArrowDown': '↓' };
  let ctrl = false;
  let key = combo;
  if (key.indexOf('ctrl+') === 0) { ctrl = true; key = key.slice(5); }
  key = pretty[key] !== undefined ? pretty[key] : (key.length === 1 ? key.toUpperCase() : key);
  return (ctrl ? 'Ctrl + ' : '') + key;
}

let hotkeyCaptureAction = null;
let hotkeyCaptureListener = null;

function renderHotkeysModal() {
  const cfg = MSTREAMPLAYER.hotkeys.getConfig();
  let rowsHtml = '';
  HOTKEY_MODAL_ROWS.forEach(([action, labelKey]) => {
    const combo = cfg.bindings[action];
    const keycap = hotkeyCaptureAction === action
      ? `<span class="hotkey-keycap capturing">${t('hotkeys.pressKey')}</span>`
      : `<span class="hotkey-keycap${combo === null ? ' unbound' : ''}">${escapeHtml(formatHotkeyCombo(combo))}</span>`;
    const changeLink = action === 'percentSeek' ? '' :
      `<a class="hotkey-btn" onclick="beginHotkeyCapture('${action}')">${t('hotkeys.change')}</a>`;
    const clearLink = combo === null
      ? `<a class="hotkey-btn" onclick="restoreHotkeyDefaultFor('${action}')">${t('hotkeys.restore')}</a>`
      : `<a class="hotkey-btn" onclick="clearHotkeyBinding('${action}')">${t('hotkeys.clear')}</a>`;
    rowsHtml += `
      <div class="hotkey-row">
        <div class="hotkey-label">${t(labelKey)}</div>
        ${keycap}
        ${changeLink}
        ${clearLink}
      </div>`;
  });

  document.getElementById('hotkeys-modal-content').innerHTML = `
    <div class="switch" style="margin: 12px 0;">
      <label>
        <input onchange="tglHotkeysEnabled(this);" type="checkbox" ${cfg.enabled ? 'checked' : ''}>
        <span class="lever"></span>
        ${t('hotkeys.enable')}
      </label>
    </div>
    <div class="${cfg.enabled ? '' : 'hotkeys-disabled'}">${rowsHtml}</div>
    <br>
    <a class="btn" onclick="restoreHotkeyDefaults()">${t('hotkeys.restoreDefaults')}</a>`;
}

function cancelHotkeyCapture() {
  if (hotkeyCaptureListener) {
    document.removeEventListener('keydown', hotkeyCaptureListener, true);
    hotkeyCaptureListener = null;
  }
  hotkeyCaptureAction = null;
}

function beginHotkeyCapture(action) {
  cancelHotkeyCapture();
  hotkeyCaptureAction = action;
  renderHotkeysModal();
  hotkeyCaptureListener = (event) => {
    // Modal closed mid-capture — disarm without touching bindings
    if (!document.getElementById('hotkeysModal').classList.contains('hystmodal--active')) {
      cancelHotkeyCapture();
      return;
    }
    // A modifier alone isn't a combo — keep waiting for the real key
    if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(event.key) !== -1) { return; }
    event.preventDefault();
    event.stopPropagation();
    const captured = hotkeyCaptureAction;
    cancelHotkeyCapture();
    // Escape cancels; alt/meta combos and shifted named keys can never match
    // in hotkeys.resolve, so refuse to store them
    const invalid = event.key === 'Escape' || event.altKey || event.metaKey ||
      (event.key.length > 1 && event.shiftKey);
    if (invalid) { renderHotkeysModal(); return; }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    assignHotkeyBinding(captured, (event.ctrlKey ? 'ctrl+' : '') + key);
  };
  document.addEventListener('keydown', hotkeyCaptureListener, true);
}

function assignHotkeyBinding(action, combo) {
  const cfg = MSTREAMPLAYER.hotkeys.getConfig();
  if (combo !== null) {
    Object.keys(cfg.bindings).forEach((other) => {
      if (other !== action && other !== 'percentSeek' && cfg.bindings[other] === combo) {
        cfg.bindings[other] = null;
      }
    });
  }
  cfg.bindings[action] = combo;
  MSTREAMPLAYER.hotkeys.saveConfig(cfg);
  renderHotkeysModal();
}

function clearHotkeyBinding(action) {
  assignHotkeyBinding(action, null);
}

function restoreHotkeyDefaultFor(action) {
  assignHotkeyBinding(action, MSTREAMPLAYER.hotkeys.defaults[action]);
}

function restoreHotkeyDefaults() {
  cancelHotkeyCapture();
  const cfg = MSTREAMPLAYER.hotkeys.getConfig();
  cfg.bindings = Object.assign({}, MSTREAMPLAYER.hotkeys.defaults);
  MSTREAMPLAYER.hotkeys.saveConfig(cfg);
  renderHotkeysModal();
}

function tglHotkeysEnabled(el) {
  const cfg = MSTREAMPLAYER.hotkeys.getConfig();
  cfg.enabled = el.checked;
  MSTREAMPLAYER.hotkeys.saveConfig(cfg);
  renderHotkeysModal();
}

function openHotkeysModal() {
  cancelHotkeyCapture();
  renderHotkeysModal();
  myModal.open('#hotkeysModal');
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
      // iziToast renders title/message as HTML — escape the torrent
      // name (attacker-controlled info.name / magnet dn=) and the
      // download path (carries the user-supplied directoryName).
      title:   `${body.isDuplicate ? 'Already added: ' : 'Added: '}${escapeHtml(body.name)}`,
      message: escapeHtml(body.downloadPath || ''),
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
        message: escapeHtml(body.renameWarning || ''),
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
      title:   escapeHtml(body.message || body.error || err.message || 'Add failed'),
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
        message: escapeHtml(res?.message || 'No reliable metadata could be extracted. Fill in the fields manually.'),
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
        message: `Method: ${escapeHtml(res.method)}`,
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
      message: escapeHtml(body.message || body.error || err.message || 'Server error'),
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
            title:   `Already in your library: ${escapeHtml(seedRes.name)}`,
            message: 'No download needed — the files were already here, and your torrent client is now sharing them.',
            position: 'topCenter',
            timeout: 5000,
          });
          _resetAddTorrentPanelForm();
          return;

        case 'already_in_daemon':
          _clearSeedStatus('at_seed_status');
          iziToast.info({
            title:   `Already added: ${escapeHtml(seedRes.name || '')}`,
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
            message: escapeHtml(seedRes.error || 'The file is malformed.'),
            position: 'topCenter',
            timeout: 5000,
          });
          submitBtn.disabled = false;
          return;

        case 'daemon_error':
          _clearSeedStatus('at_seed_status');
          iziToast.error({
            title:   'Torrent client error',
            message: escapeHtml(seedRes.error || 'Could not reach the torrent client.'),
            position: 'topCenter',
            timeout: 5000,
          });
          submitBtn.disabled = false;
          return;

        case 'match_unmapped':
          // Every file is on disk in seedRes.vpath, but that library's
          // daemon path mapping isn't usable — /add would bounce off
          // the same gate (412/409), so don't fall through to it.
          _clearSeedStatus('at_seed_status');
          iziToast.info({
            title:   'Found, but not seedable yet',
            message: `All files are already in your "${escapeHtml(seedRes.vpath)}" library, but the torrent client's path mapping for it isn't set up. Ask your admin to run auto-detect on the Torrent admin page, then retry.`,
            position: 'topCenter',
            timeout: 8000,
          });
          submitBtn.disabled = false;
          return;

        case 'pad_files_missing':
          // All real files present, but this hybrid torrent's padding
          // files aren't on disk and the active client can't seed
          // without them. Handing off would stall the daemon, so stop
          // here rather than fall through to /add.
          _clearSeedStatus('at_seed_status');
          iziToast.info({
            title:   'Found, but needs padding files',
            message: `All files are in your "${escapeHtml(seedRes.vpath)}" library, but this torrent needs its alignment (padding) files, which ${escapeHtml(seedRes.clientType)} can't recreate. It would re-download the boundary pieces. A qBittorrent/Deluge backend handles these automatically.`,
            position: 'topCenter',
            timeout: 9000,
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
      title: `${body.isDuplicate ? 'Already added: ' : 'Added: '}${escapeHtml(body.name)}`,
      position: 'topCenter', timeout: 3500,
    });
    // Non-fatal rename-root warning — separate toast so the success
    // message doesn't get overwritten.
    if (body.renameWarning) {
      iziToast.warning({
        title:   'Rename failed',
        message: escapeHtml(body.renameWarning || ''),
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
      title: escapeHtml(errBody.message || errBody.error || err.message || 'Add failed'),
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

  document.getElementById('meta--title').textContent = metadata.title;
  document.getElementById('meta--album').textContent = metadata.album;
  document.getElementById('meta--artist').textContent = metadata.artist;
  document.getElementById('meta--year').textContent = metadata.year;
  document.getElementById('meta--disk').textContent = metadata.disk;
  document.getElementById('meta--track').textContent = metadata.track;
  document.getElementById('meta--rating').textContent = metadata.rating;
  document.getElementById('meta--rg').textContent = metadata['replaygain-track'];
  document.getElementById('meta--fp').textContent = fp;
  document.getElementById('meta--fp').href = 'media' + fp;
  document.getElementById('meta--aa').textContent = 'album-art/' + metadata['album-art'];
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
      html += `<div style="cursor:pointer;text-align:center;width:130px;" data-url="${escapeHtml(r.url)}" onclick="selectAlbumArt(this.getAttribute('data-url'))">
        <img src="${escapeHtml(r.url)}" style="width:120px;height:120px;object-fit:cover;border-radius:4px;border:2px solid transparent;"
             onerror="this.parentElement.style.display='none'" loading="lazy">
        <div style="font-size:11px;color:#aaa;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.label)}</div>
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
  // A peer track's rawFilePath resolves only on the peer; posting it to our
  // local /download/zip would silently drop it, yielding a dishonest archive.
  // Refuse a mixed queue outright, as savePlaylist/submitShareForm do.
  if (refuseMixedQueue('download.cannotDownloadMixed')) { return; }

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
  // /api/v1/download/directory zips a path in THIS library. Downloading a
  // peer's folder would need a second proxy (and the peer's own consent);
  // until then, be honest rather than serve an empty archive.
  if (peerOf(el)) {
    iziToast.info({ title: t('peers.noDownload'), position: 'topCenter', timeout: 2500 });
    return;
  }
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
    await getGenreSongs(backState.name, backState.source);
  } else if (backState.state === 'fileExplorer') {
    fileExplorerArray.pop();
    await senddir();
  } else if (backState.state === 'searchPanel') {
    setupSearchPanel(backState.searchTerm, undefined);
  } else if (backState.state === 'album') {
    // An album page under the one left (its window's View artist): drawn
    // again from what it was opened with, its header and credit too.
    programState.pop();
    await getAlbumSongs(backState.name, backState.artist, backState.year, backState.albumArtist, backState);
  } else if (backState.state === 'discovery') {
    // An album opened from the Discover page: back to the page as it was.
    discoveryPanel({ keep: true });
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
      document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" data-playlist="${escapeHtml(p.name)}" onclick="addToPlaylistUI(this.getAttribute('data-playlist'))">&#8226; ${escapeHtml(p.name)}</div>`;
      document.getElementById('live-playlist-select').innerHTML += `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`;
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
    title: `Delete '${escapeHtml(playlistname)}'?`,
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
    title: `Rename '${escapeHtml(oldName)}'`,
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
    document.getElementById('directoryName').innerHTML = 'Playlist: ' + escapeHtml(playlistname);
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
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" data-playlist="${escapeHtml(title)}" onclick="addToPlaylistUI(this.getAttribute('data-playlist'))">&#8226; ${escapeHtml(title)}</div>`;
    document.getElementById('live-playlist-select').innerHTML += `<option value="${escapeHtml(title)}">${escapeHtml(title)}</option>`;
  
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
      // Seed the empty playlist from the current queue (federated tracks left
      // out — saveLiveQueue routes through localQueueFilepaths).
      VUEPLAYERCORE.saveLiveQueue();
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

// Tracks in the queue that live on a federated server. Playlists and shares
// both resolve paths against THIS library, so neither can carry one.
function federatedTracksInQueue() {
  return MSTREAMPLAYER.playlist.filter(song => song.federation);
}

// Refuse an action that would have to write federated paths, naming the
// count so the user can find them. Returns true when it refused.
function refuseMixedQueue(titleKey) {
  const mixed = federatedTracksInQueue();
  if (mixed.length === 0) { return false; }
  iziToast.warning({
    title: t(titleKey),
    message: t('playlist.federatedCount', { count: mixed.length }),
    position: 'topCenter',
    timeout: 5000
  });
  return true;
}

async function savePlaylist() {
  if (refuseMixedQueue('playlist.cannotSaveMixed')) { return; }
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
    document.getElementById('pop-f').innerHTML += `<div class="pop-list-item" data-playlist="${escapeHtml(title)}" onclick="addToPlaylistUI(this.getAttribute('data-playlist'))">&#8226; ${escapeHtml(title)}</div>`;
    document.getElementById('live-playlist-select').innerHTML += `<option value="${escapeHtml(title)}">${escapeHtml(title)}</option>`;
  }catch(err) {
    boilerplateFailure(err);
  } finally {
    document.getElementById('save_playlist').disabled = false;
  }
}

/////////////// Artists
// The /db/artists request the two layout preferences shape: "show
// album-only artists" widens the list with `include: ['albumArtists']` (the
// artists credited only on albums — Various Artists, a compilation's credit
// — join the track artists; on by default), and "ignore leading articles"
// asks for `sort: 'order'` ("The Beatles" files under B). Both are omitted
// when browsing a peer: a peer on an older version validates neither, and
// the peer already answers in its own order.
function artistsBody() {
  const body = { ignoreVPaths: localIgnoreVPaths() };
  if (peerContext) { return body; }
  if (VUEPLAYERCORE.altLayout.artistsShowAlbumOnly !== false) { body.include = ['albumArtists']; }
  if (VUEPLAYERCORE.altLayout.artistsIgnoreArticles === true) { body.sort = 'order'; }
  return body;
}

// The /db/album-songs request for a card: `album_artist` only when the card
// carries one (the group's single credit) — never null, so a server that
// predates the field, or a peer, sees the request it always did.
function albumSongsBody(album, artist, year, albumArtist) {
  const body = { album, artist, year, ignoreVPaths: localIgnoreVPaths() };
  if (albumArtist) { body.album_artist = albumArtist; }
  return body;
}

async function getAllArtists(opts) {
  // A mood-filter change asks again in place: the bar and its open panel stay.
  if (opts?.refresh) { currentBrowsingList = []; } else { setBrowserRootPanel(t('panel.artists')); }
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allArtists' }];

  const gen = browseGeneration;
  try {
    const moods = moodFilterBody('artists');
    const response = await browseApi('artists', { ...artistsBody(), ...(moods && { moods }) });
    if (gen !== browseGeneration) { return; }
    showMoodFilters('artists', response);

    // parse through the json array and make an array of corresponding divs
    let artists = '<ul class="collection">';
    response.artists.forEach(value => {
      artists += renderArtist(value);
      currentBrowsingList.push({ type: 'artist', name: value });
    });
    artists += '</ul>';

    document.getElementById('filelist').innerHTML = artists;
    browseKeepDrawn();
  }catch(err) {
    if (!browseKeepBack(gen)) { document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`; }
    boilerplateFailure(err);
  }
}

function getArtistz(el) {
  hideMoodFilters();
  adoptPeer(el);
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
  document.getElementById('directoryName').innerHTML = t('label.artist') + ' ' + escapeHtml(artist);
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  const gen = browseGeneration;
  try {
    const gate = keepGateFor(peerContext);
    const response = await browseApi('artistAlbums', { artist: artist, ignoreVPaths: localIgnoreVPaths() });
    await gate;
    if (gen !== browseGeneration) { return; }

    let albums = '<div class="album-grid">';
    response.albums.forEach(value => {
      const albumString = value.name ? value.name : 'SINGLES';
      const credit = albumCredit(value);
      const compilation = value.compilation === true;
      albums += renderAlbum(value.name, value.name === null ? artist : null, albumString, value.album_art_file, value.year, credit.albumArtist, credit.line, compilation);
      currentBrowsingList.push({ type: 'album', name: value.name, artist: artist, album_art_file: value.album_art_file, year: value.year,
        album_artist: credit.albumArtist, artist_line: credit.line, compilation });
    });
    albums += '</div>';

    document.getElementById('filelist').innerHTML = albums;
    browseKeepDrawn();
    // A connected server's artist: the header, and its cards' marks.
    if (peerContext) { browseArtistHead(artist, response); }
  }catch(err) {
    if (!browseKeepBack(gen)) { document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`; }
    boilerplateFailure(err);
  }
}

/////////////// Mood filters
// The browse lists' mood filters (Albums, Artists, Rated, Recently Added;
// the server half is src/api/mood-filter.js) — and Discover's, drawn in its
// own bar. One filter per page for the visit: a value per scale (`valence`,
// `energy`, `voice`) and a `tags` list, a group left out filtering nothing.
// The bar's #mood_filter_btn shows when the list's answer carries `moods`
// (this server, or the connected one being browsed, can filter) — or, for
// the song lists, on the ping's flag (songListMoods); its panel,
// #mood_filters, is hidden until the button opens it, and every other panel
// hides it again (setBrowserRootPanel) — so the panel's own visibility is
// its open state. The button is orange with a dot while a filter is set.
const MOODS = {
  scales: [
    ['valence', ['happy', 'neutral', 'sad'], 'moods.valenceGroup'],
    ['energy', ['relaxed', 'neutral', 'aggressive'], 'moods.energyGroup'],
    ['voice', ['instrumental', 'vocals'], 'moods.voiceGroup'],
  ],
  tags: ['acoustic', 'party', 'danceable'],
  filters: { albums: {}, artists: {}, rated: {}, recent: {}, discover: {} },
  list: null,   // the list the bar's button and panel belong to
};

// A page's filter in the server's wire form, or null when nothing filters.
function moodFilterBody(list) {
  const f = MOODS.filters[list] || {};
  const out = {};
  for (const [group] of MOODS.scales) {
    if (f[group]) { out[group] = f[group]; }
  }
  const tags = MOODS.tags.filter((tag) => (f.tags || []).includes(tag));
  if (tags.length) { out.tags = tags; }
  return Object.keys(out).length ? out : null;
}

// One pressed value per scale (pressed again, it lets go), any number of
// tags, and Clear while anything is set. The lists' buttons call their
// handlers; Discover's carry data-dp actions for its own dispatcher (and
// its focus restore after a redraw).
function moodPanelHtml(list) {
  const f = MOODS.filters[list] || {};
  const dp = list === 'discover';
  const on = (handler, act, v) => (dp ? `data-dp="${act}" data-v="${v}"` : `onclick="${handler}"`);
  const scale = ([group, values, label]) => `<div class="mood-seg" role="group" aria-label="${escapeHtml(t(label))}">${values.map((v) =>
    `<button type="button" class="mood-seg-btn" data-mood-group="${group}" data-mood-value="${v}" aria-pressed="${f[group] === v}" ${on(`pickMood('${group}', '${v}')`, 'mood', `${group}:${v}`)}>${escapeHtml(t(`moods.${v}`))}</button>`).join('')}</div>`;
  const tags = `<div class="mood-tags" role="group" aria-label="${escapeHtml(t('moods.tagsGroup'))}">${MOODS.tags.map((tag) =>
    `<button type="button" class="mood-chip" data-mood-tag="${tag}" aria-pressed="${(f.tags || []).includes(tag)}" ${on(`toggleMoodTag('${tag}')`, 'moodTag', tag)}>${escapeHtml(t(`moods.${tag}`))}</button>`).join('')}</div>`;
  return MOODS.scales.map(scale).join('') + tags
    + `<button type="button" class="mood-clear${moodFilterBody(list) ? '' : ' super-hide'}" ${on('clearMoodFilters()', 'moodClear', 'all')}>${escapeHtml(t('moods.clear'))}</button>`;
}

// After a list's answer: the button when the answer says the server can
// filter, the panel as this visit left it. An answer without `moods` (an
// older server, or one with no scores) filtered nothing: no filters shown.
function showMoodFilters(list, response) {
  const btn = document.getElementById('mood_filter_btn');
  const panel = document.getElementById('mood_filters');
  if (!btn || !panel) { return; }
  if (!response || !response.moods || typeof response.moods !== 'object') {
    hideMoodFilters();
    return;
  }
  // Another list's panel closes (a fresh visit's is closed already).
  if (MOODS.list !== list) {
    MOODS.list = list;
    panel.classList.add('super-hide');
    panel.innerHTML = '';
  }
  btn.classList.remove('super-hide');
  btn.classList.toggle('mood-on', moodFilterBody(list) !== null);
  btn.setAttribute('aria-expanded', String(!panel.classList.contains('super-hide')));
}

// The song lists (Rated, Recently Added) answer bare arrays, with no room
// for the browse lists' echo, so they go by the ping's `moodFilters`: this
// server's own lists only — a connected server's Recently Added has no
// filters. Returns what showMoodFilters reads off a browse list's answer.
function songListMoods() {
  return !peerContext && discoveryView.flags.moodFilters === true ? { moods: {} } : null;
}

function hideMoodFilters() {
  document.getElementById('mood_filter_btn')?.classList.add('super-hide');
  const panel = document.getElementById('mood_filters');
  if (panel) {
    panel.classList.add('super-hide');
    panel.innerHTML = '';
  }
}

function toggleMoodPanel() {
  const panel = document.getElementById('mood_filters');
  if (!MOODS.list || !panel) { return; }
  const open = panel.classList.contains('super-hide');
  panel.innerHTML = open ? moodPanelHtml(MOODS.list) : '';
  panel.classList.toggle('super-hide', !open);
  document.getElementById('mood_filter_btn')?.setAttribute('aria-expanded', String(open));
}

function pickMood(group, value) {
  const f = MOODS.filters[MOODS.list];
  if (!f) { return; }
  f[group] = f[group] === value ? undefined : value;
  moodFilterChanged();
}

function toggleMoodTag(tag) {
  const f = MOODS.filters[MOODS.list];
  if (!f) { return; }
  const tags = new Set(f.tags || []);
  if (tags.has(tag)) { tags.delete(tag); } else { tags.add(tag); }
  f.tags = [...tags];
  moodFilterChanged();
}

function clearMoodFilters() {
  if (!MOODS.filters[MOODS.list]) { return; }
  MOODS.filters[MOODS.list] = {};
  moodFilterChanged();
  // Clear hides itself: focus goes back to the button that opened the panel.
  document.getElementById('mood_filter_btn')?.focus();
}

// The pressed states change in place (a re-render would drop the focused
// button), then the list asks again with the new filter.
function moodFilterChanged() {
  const list = MOODS.list;
  const f = MOODS.filters[list] || {};
  const panel = document.getElementById('mood_filters');
  panel?.querySelectorAll('[data-mood-group]').forEach((b) => {
    b.setAttribute('aria-pressed', String(f[b.getAttribute('data-mood-group')] === b.getAttribute('data-mood-value')));
  });
  panel?.querySelectorAll('[data-mood-tag]').forEach((b) => {
    b.setAttribute('aria-pressed', String((f.tags || []).includes(b.getAttribute('data-mood-tag'))));
  });
  panel?.querySelector('.mood-clear')?.classList.toggle('super-hide', moodFilterBody(list) === null);
  document.getElementById('mood_filter_btn')?.classList.toggle('mood-on', moodFilterBody(list) !== null);
  // A newer ask wins: one still out for the old filter draws nothing.
  browseGeneration++;
  if (list === 'albums') { getAllAlbums({ refresh: true }); }
  else if (list === 'artists') { getAllArtists({ refresh: true }); }
  else if (list === 'rated') { getRatedSongs({ refresh: true }); }
  else if (list === 'recent') { redoRecentlyAdded(); }
}

// A mood button on Discover: the lists' rules (pickMood, toggleMoodTag,
// clearMoodFilters) on the page's own filter, then the page asks again.
function discoveryPickMood(act, val) {
  const f = MOODS.filters.discover;
  if (act === 'mood') {
    const [group, value] = String(val).split(':');
    if (!MOODS.scales.some(([g, values]) => g === group && values.includes(value))) { return; }
    f[group] = f[group] === value ? undefined : value;
  } else if (act === 'moodTag') {
    if (!MOODS.tags.includes(val)) { return; }
    const tags = new Set(f.tags || []);
    if (tags.has(val)) { tags.delete(val); } else { tags.add(val); }
    f.tags = [...tags];
  } else {
    MOODS.filters.discover = {};
  }
  redoDiscovery();
  // Clear hides itself: the keyboard goes back to the Filters button.
  if (act === 'moodClear') { discoveryRefocus('[data-dp="moods"]'); }
}

/////////////// Genres
// Which genres the panel lists: 'tag' — the files' own — 'model' — the
// discovery model's — or 'both' (the server's `source` filter, left off
// for both). Remembered across visits; this visit's pick comes first, as
// storage can be off (a private window). The switch is the browse bar's
// #genre_source, shown only when the server has both kinds.
let genreSourceChoice = null;

const GENRE_SOURCES = ['tag', 'model', 'both'];

function preferredGenreSource() {
  if (genreSourceChoice) { return genreSourceChoice; }
  try {
    const v = localStorage.getItem('genre-source');
    return GENRE_SOURCES.includes(v) ? v : null;
  } catch (_) { return null; }
}

function chooseGenreSource(source) {
  if (programState[0]?.state === 'allGenres' && programState[0].genreSource === source) { return; }
  genreSourceChoice = source;
  try { localStorage.setItem('genre-source', source); } catch (_) { /* storage off: this visit only */ }
  getAllGenres();
}

// Show the bar's switch with `active` pressed (setBrowserRootPanel hides it).
function showGenreSourceSwitch(active) {
  const bar = document.getElementById('genre_source');
  if (!bar) { return; }
  bar.classList.remove('super-hide');
  bar.querySelectorAll('button[data-source]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-source') === active));
  });
}

async function getAllGenres() {
  setBrowserRootPanel(t('panel.genres'));
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allGenres' }];

  const gen = browseGeneration;
  try {
    // The remembered kind; when the server has none of a single kind (an
    // untagged library, a server without the model) the other one. A
    // server that predates the filter ignores it and sends no `sources`:
    // every genre, no switch.
    let source = preferredGenreSource() || 'tag';
    const ask = (s) => browseApi('genres', s === 'both' ? {} : { source: s });
    let response = await ask(source);
    if (gen !== browseGeneration) { return; }
    const sources = response.sources;
    if (sources && source !== 'both' && !(sources[source] > 0)) {
      const other = source === 'tag' ? 'model' : 'tag';
      if (sources[other] > 0) {
        source = other;
        response = await ask(source);
      }
    }
    if (gen !== browseGeneration) { return; }

    programState[0].genreSource = source;
    if (sources && sources.tag > 0 && sources.model > 0) { showGenreSourceSwitch(source); }
    // What a row asks its songs with: the one kind listed, or nothing.
    const listSource = sources && source !== 'both' ? source : null;

    let html = '<ul class="collection">';
    response.genres.forEach(value => {
      html += renderGenre(value.name, value.track_count, listSource);
      currentBrowsingList.push({ type: 'genre', name: value.name, track_count: value.track_count, source: listSource });
    });
    html += '</ul>';

    document.getElementById('filelist').innerHTML = html;
    browseKeepDrawn();
  } catch(err) {
    // a connected server that stopped answering: the page it was on, and the toast
    if (browseKeepBack(gen)) { boilerplateFailure(err); return; }
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
  }
}

function getGenreSongsList(el) {
  adoptPeer(el);
  const genre = el.getAttribute('data-genre');
  const source = el.getAttribute('data-genre-source');
  programState.push({
    state: 'genre',
    name: genre,
    source,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  });
  getGenreSongs(genre, source);
}

// `source` narrows the songs to the list's kind of genre; absent, every
// song with the genre (and what a server without the filter answers).
async function getGenreSongs(genre, source) {
  setBrowserRootPanel(t('panel.songs'));
  document.getElementById('directoryName').innerHTML = t('label.genre') + ' ' + escapeHtml(genre);
  document.getElementById('filelist').innerHTML = getLoadingSvg();

  const gen = browseGeneration;
  try {
    const gate = keepGateFor(peerContext);
    const response = await browseApi('genreSongs', source ? { genre, source } : { genre });
    await gate;
    if (gen !== browseGeneration) { return; }

    let songs = '<ul class="collection">';
    response.forEach(song => {
      const title = song.metadata.title ? song.metadata.title : song.filepath.split('/').pop();
      const subtitle = song.metadata.artist ? song.metadata.artist : undefined;

      currentBrowsingList.push({ type: 'file', name: title, path: song.filepath, metadata: song.metadata, title, subtitle });
      songs += createMusicFileHtml(song.filepath, title, undefined, undefined, subtitle);
    });
    songs += '</ul>';

    document.getElementById('filelist').innerHTML = songs;
    browseKeepDrawn();
  } catch(err) {
    // a connected server that stopped answering: the page it was on, and the toast
    if (browseKeepBack(gen)) { boilerplateFailure(err); return; }
    document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`;
  }
}

/////////////// Albums
async function getAllAlbums(opts) {
  // A mood-filter change asks again in place: the bar and its open panel stay.
  if (opts?.refresh) { currentBrowsingList = []; } else { setBrowserRootPanel(t('panel.albums')); }
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  
  programState = [{ state: 'allAlbums' }];

  const gen = browseGeneration;
  try {
    const gate = keepGateFor(peerContext);
    const moods = moodFilterBody('albums');
    const response = await browseApi('albums', { ignoreVPaths: localIgnoreVPaths(), ...(moods && { moods }) });
    await gate;
    if (gen !== browseGeneration) { return; }
    showMoodFilters('albums', response);

    let albums = '<div class="album-grid">';
    response.albums.forEach(value => {
      const credit = albumCredit(value);
      const compilation = value.compilation === true;
      currentBrowsingList.push({
        type: 'album',
        name: value.name,
        'album_art_file': value.album_art_file,
        year: value.year,
        album_artist: credit.albumArtist,
        artist_line: credit.line,
        compilation
      });

      albums += renderAlbum(value.name, undefined, value.name, value.album_art_file, value.year, credit.albumArtist, credit.line, compilation);
    });
    albums += '</div>'

    document.getElementById('filelist').innerHTML = albums;
    browseKeepDrawn();
    // A connected server's cards: their copies' lines, asked as they come
    // near.
    if (peerContext) {
      browseKeepCards(response.albums);
      browseKeepObserve();
    }
  }catch (err) {
    if (!browseKeepBack(gen)) { document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`; }
    return boilerplateFailure(err);
  }
}

function getAlbumsOnClick(el) {
  hideMoodFilters();
  adoptPeer(el);
  getAlbumSongs(
    el.hasAttribute('data-album') ? el.getAttribute('data-album') : null,
    el.hasAttribute('data-artist') ? el.getAttribute('data-artist') : null,
    el.hasAttribute('data-year') ? el.getAttribute('data-year') : null,
    el.hasAttribute('data-album-artist') ? el.getAttribute('data-album-artist') : null,
    null, el.getAttribute('data-compilation') === 'true');
}

// The page keeps what it was opened with — the credit, the narrowing, the
// year, a card's word that it is a compilation — on its programState
// entry, so Back draws it again exactly (`entry`: that entry, put back as
// it was), credit included.
async function getAlbumSongs(album, artist, year, albumArtist, entry, compilation) {
  // The Discover page draws without the bar; an album opened from its
  // cards still needs the back button (onBackButton has its branch). Other
  // bar-less panels keep the bar hidden: they have no way back.
  const under = programState[programState.length - 1];
  if (under && under.state === 'discovery') {
    document.getElementById('directory_bar').style.display = '';
    discoveryHideHead();
  }
  browseKeepReset(true);
  document.getElementById('directoryName').innerHTML = 'Album: ' + escapeHtml(album);

  const page = entry || {
    state: 'album',
    name: album,
    artist,
    albumArtist,
    year,
    compilation: compilation === true,
    previousScroll: document.getElementById('filelist').scrollTop,
    previousSearch: document.getElementById('localSearchBar').value
  };
  programState.push(page);

  //clear the list
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  currentBrowsingList = [];

  document.getElementById('localSearchBar').value = '';

  const gen = browseGeneration;
  try {
    const gate = keepGateFor(peerContext);
    const response = await browseApi('albumSongs', albumSongsBody(album, artist, year, albumArtist));
    await gate;
    if (gen !== browseGeneration) { return; }

    //parse through the json array and make an array of corresponding divs
    let files = '<ul class="collection">';
    response.forEach(song => {
      const title = song.metadata.title ? song.metadata.title : song.metadata.filename;
      const subtitle = song.metadata.artist ? song.metadata.artist : undefined;

      currentBrowsingList.push({ type: 'file', name: title, path: song.filepath, metadata: song.metadata, title, subtitle });
      files += createMusicFileHtml(song.filepath, title, undefined, undefined, subtitle);
    });
    files += '</ul>';

    document.getElementById('filelist').innerHTML = files;
    browseKeepDrawn();
    // A connected server's album: the header that gives its credit back,
    // and its songs' marks.
    if (peerContext) { browseAlbumHead(response, { album, artist, year, albumArtist, compilation: page.compilation === true }); }
  }catch(err) {
    if (!browseKeepBack(gen)) { document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`; }
    boilerplateFailure(err);
  }
}

////////////// Rated Songs
async function getRatedSongs(opts) {
  // A mood-filter change asks again in place: the bar and its open panel stay.
  if (opts?.refresh) { currentBrowsingList = []; } else { setBrowserRootPanel(t('panel.starred')); }
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  programState = [{ state: 'allRated' }];

  const gen = browseGeneration;
  try {
    const can = songListMoods();
    const moods = can && moodFilterBody('rated');
    const response = await MSTREAMAPI.getRated({
      ignoreVPaths: Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }),
      ...(moods && { moods })
    });
    if (gen !== browseGeneration) { return; }
    showMoodFilters('rated', can);
    //parse through the json array and make an array of corresponding divs
    let files = '';
    response.forEach(value => {
      let rating = (value.metadata.rating / 2);
      if (!Number.isInteger(rating)) {
        rating = rating.toFixed(1);
      }

      const title = value.metadata.title ? value.metadata.title : value.filepath.split('/').pop();
      const aa = artImgAttr(value.metadata['album-art'], 's');
      const subtitle = value.metadata.artist ? value.metadata.artist : '';

      currentBrowsingList.push({
        type: 'file',
        name: value.metadata.artist ? value.metadata.artist + ' - ' + value.metadata.title : value.filepath,
        metadata: value.metadata,
        path: value.filepath,
        title, aa, rating, subtitle
      });

      files += createMusicFileHtml(value.filepath, title, aa, rating, subtitle);
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

  const gen = browseGeneration;
  try {
    const response = await MSTREAMAPI.getRecentlyPlayed(
      document.getElementById('recently-played-limit').value,
      Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }));
    if (gen !== browseGeneration) { return; }

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      const title = el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop();
      const aa = artImgAttr(el.metadata['album-art'], 's');
      const subtitle = el.metadata.artist ? el.metadata.artist : '';

      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop(),
        metadata: el.metadata,
        path: el.filepath,
        title, aa, subtitle
      });

      filelist += createMusicFileHtml(el.filepath, title, aa, undefined, subtitle);
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

  const gen = browseGeneration;
  try {
    const response = await MSTREAMAPI.getMostPlayed(
      document.getElementById('most-played-limit').value,
      Object.keys(MSTREAMPLAYER.ignoreVPaths).filter((vpath) => {
        return MSTREAMPLAYER.ignoreVPaths[vpath] === true;
      }));
    if (gen !== browseGeneration) { return; }

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      const title = el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop();
      const aa = artImgAttr(el.metadata['album-art'], 's');
      const subtitle = el.metadata.artist ? `${el.metadata.artist} [${el.metadata['play-count']} plays]` : `[${el.metadata['play-count']} plays]`;

      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop(),
        metadata: el.metadata,
        path: el.filepath,
        title, aa, subtitle
      });

      filelist += createMusicFileHtml(el.filepath, title, aa, undefined, subtitle);
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
  // asked again from the page itself (its limit): the page held as it is
  browseKeepHold(false);
  currentBrowsingList = [];
  programState = [{ state: 'recentlyAdded' }];

  const gen = browseGeneration;
  try {
    const limit = document.getElementById('recently-added-limit').value;
    const gate = keepGateFor(peerContext);
    const can = songListMoods();
    const moods = can && moodFilterBody('recent');
    const response = peerContext
      ? await MSTREAMAPI.peer.recentlyAdded(peerContext.id, limit)
      : await MSTREAMAPI.getRecentlyAdded(limit, localIgnoreVPaths(), moods);
    await gate;
    if (gen !== browseGeneration) { return; }
    showMoodFilters('recent', can);

    //parse through the json array and make an array of corresponding divs
    let filelist = '<ul class="collection">';
    response.forEach(el => {
      const title = el.metadata.title ? `${el.metadata.title}`: el.filepath.split("/").pop();
      const aa = artImgAttr(el.metadata['album-art'], 's');
      const subtitle = el.metadata.artist ? el.metadata.artist : '';

      currentBrowsingList.push({
        type: 'file',
        name: el.metadata.title ? el.metadata.artist + ' - ' + el.metadata.title : el.filepath.split("/").pop(),
        metadata: el.metadata,
        path: el.filepath,
        title, aa, subtitle
      });

      filelist += createMusicFileHtml(el.filepath, title, aa, undefined, subtitle);
    });

    filelist += '</ul>'
  
    document.getElementById('filelist').innerHTML = filelist;
    browseKeepDrawn();
  }catch(err) {
    if (!browseKeepBack(gen)) { document.getElementById('filelist').innerHTML = `<div>${t('error.serverCallFailed')}</div>`; }
    return boilerplateFailure(err);
  }
}

function submitRecentlyAdded() {
  if (event.keyCode === 13) {
    document.getElementById("recently-added-limit").blur();
  }
}

///////////////// Downloads (what the Discover plug-ins brought in)
// GET /api/v1/discovery/downloads: the caller's records — every account's
// for an admin who ticks "All accounts" — newest first, with "Show removed"
// adding the history. A present row is a library song: the usual file row
// (a click queues it, the arrow plays it now, the chevron adds it to a
// playlist) with its provenance underneath, plus "Show in library" and
// Remove. Remove deletes the file, its library row and any queue entry on
// it, and settles the record (DELETE /api/v1/discovery/downloads/:id). The
// pure parts — a record as a row, the totals, the queue indexes — live in
// alpha/discover-jobs.js with the Discover job rows.
const discoverDownloadsView = { all: false, removed: false, list: [], plugins: null };

function discoverDownloadsPanel() {
  setBrowserRootPanel(t('panel.downloads'), false);
  programState = [{ state: 'discoverDownloads' }];
  currentBrowsingList = [];
  document.getElementById('filelist').innerHTML = getLoadingSvg();
  redoDiscoverDownloads();
}

async function redoDiscoverDownloads() {
  const v = discoverDownloadsView;
  const gen = browseGeneration;
  try {
    const [res, plugins] = await Promise.all([
      MSTREAMAPI.discoveryDownloads({ all: v.all && MSTREAMAPI.currentServer.admin === true, removed: v.removed, limit: 200 }),
      // The plug-in list names each row's origin ("YouTube"); a server that
      // will not list it just leaves the plug-in's own name.
      v.plugins ? Promise.resolve(v.plugins) : MSTREAMAPI.discoveryPlugins().then((r) => (r && r.plugins) || []).catch(() => []),
    ]);
    if (gen !== browseGeneration || programState[0].state !== 'discoverDownloads') { return; }
    v.plugins = plugins;
    v.list = (res && res.downloads) || [];
  } catch (err) {
    if (gen !== browseGeneration || programState[0].state !== 'discoverDownloads') { return; }
    document.getElementById('filelist').innerHTML = `<div class="pad-6">${escapeHtml(t('downloads.loadFailed'))}</div>`;
    return boilerplateFailure(err);
  }
  renderDiscoverDownloads();
}

function discoverDownloadPluginTitle(name) {
  const p = (discoverDownloadsView.plugins || []).find((x) => x.name === name);
  if (p && p.title) { return p.title; }
  const key = 'downloads.plugin.' + name;
  const known = t(key);
  return known === key ? name : known;
}

function discoverDownloadsAgo(ts) {
  if (ts === null || ts === undefined) { return ''; }
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) { return t('downloads.ago.now'); }
  if (s < 3600) { return t('downloads.ago.min', { count: Math.floor(s / 60) }); }
  if (s < 86400) { return t('downloads.ago.hour', { count: Math.floor(s / 3600) }); }
  const d = Math.floor(s / 86400);
  if (d === 1) { return t('downloads.ago.yesterday'); }
  if (d < 14) { return t('downloads.ago.day', { count: d }); }
  return t('downloads.ago.week', { count: Math.floor(d / 7) });
}

function renderDiscoverDownloads() {
  const v = discoverDownloadsView;
  const rows = v.list.map((d) => DISCOVERJOBS.downloadRow(d));
  const totals = DISCOVERJOBS.downloadsTotals(v.list);
  const isAdmin = MSTREAMAPI.currentServer.admin === true;
  currentBrowsingList = [];

  let html = `<div class="browser-panel dl-panel">
    <p class="dl-lead">${escapeHtml(t('downloads.lead'))}</p>
    <div class="dl-bar">
      <span class="dl-totals">${totals.count > 0 ? escapeHtml(t('downloads.totals', { count: totals.count, size: DISCOVERJOBS.fmtBytes(totals.bytes) || '0 B' })) : ''}</span>
      <span class="grow"></span>
      ${isAdmin ? `<label class="dl-toggle"><input type="checkbox" class="filled-in" ${v.all ? 'checked' : ''} onchange="toggleDiscoverDownloadsAll(this);"><span>${escapeHtml(t('downloads.allAccounts'))}</span></label>` : ''}
      <label class="dl-toggle"><input type="checkbox" class="filled-in" ${v.removed ? 'checked' : ''} onchange="toggleDiscoverDownloadsRemoved(this);"><span>${escapeHtml(t('downloads.showRemoved'))}</span></label>
    </div>
  </div>`;
  if (rows.length === 0) {
    html += `<div class="pad-6 dl-empty">${escapeHtml(t(v.all ? 'downloads.emptyAll' : 'downloads.empty'))}</div>`;
  } else {
    html += '<ul class="collection">';
    for (const row of rows) {
      if (row.present) {
        currentBrowsingList.push({ type: 'file', name: row.artist ? `${row.artist} - ${row.title}` : row.title, path: row.filepath, title: row.title, subtitle: row.artist });
      }
      html += renderDiscoverDownloadRow(row);
    }
    html += '</ul>';
  }
  document.getElementById('filelist').innerHTML = html;
}

function renderDiscoverDownloadRow(row) {
  const facts = [discoverDownloadPluginTitle(row.plugin), row.size, discoverDownloadsAgo(row.at)];
  if (row.username) { facts.push(t('downloads.by', { user: row.username })); }
  if (row.state === 'missing') { facts.push(t('downloads.missing')); }
  if (row.state === 'removed') { facts.push(t('downloads.removed', { when: discoverDownloadsAgo(row.removedAt) })); }
  const where = row.crumbs.join(' / ');
  const body = `
      <svg class="music-image dl-ic" height="18" width="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      <span>
        <b><span>${escapeHtml(row.title)}</span></b>
        ${row.artist || row.album ? `<br><span style="font-size:15px;">${escapeHtml([row.artist, row.album].filter(Boolean).join(' · '))}</span>` : ''}
        <br><span class="dl-facts">${escapeHtml(facts.filter(Boolean).join(' · '))}</span>
        <br><span class="dl-where" title="${escapeHtml(where)}">${escapeHtml(where)}</span>
      </span>`;
  const actions = [];
  if (row.actions.indexOf('play') !== -1) {
    actions.push(`<span title="Play Now" onclick="playNow(this);" data-file_location="${escapeHtml(row.filepath)}" class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      <span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${escapeHtml(row.filepath)}" class="fileAddToPlaylist">
        <svg class="pop-f" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-f" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
      </span>`);
  }
  if (row.actions.indexOf('show') !== -1) {
    actions.push(`<span title="${escapeHtml(t('downloads.show'))}" onclick="showDiscoverDownloadInLibrary(this);" data-file_location="${escapeHtml(row.filepath)}" class="songDropdown dl-show">
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
      </span>`);
  }
  if (row.actions.indexOf('remove') !== -1) {
    actions.push(`<span class="dl-remove" onclick="removeDiscoverDownload(this);" data-dlid="${row.id}">${escapeHtml(t('downloads.remove'))}</span>`);
  }
  return `<li class="collection-item dl-item${row.present ? '' : ' dl-item-muted'}" data-dlid="${row.id}">
    ${row.present
      ? `<div data-file_location="${escapeHtml(row.filepath)}" class="filez flex2" onclick="onFileClick(this);">${body}</div>`
      : `<div class="flex2 dl-dead">${body}</div>`}
    <div class="song-button-box">${actions.join('')}</div>
  </li>`;
}

function toggleDiscoverDownloadsAll(el) {
  discoverDownloadsView.all = el.checked === true;
  redoDiscoverDownloads();
}

function toggleDiscoverDownloadsRemoved(el) {
  discoverDownloadsView.removed = el.checked === true;
  redoDiscoverDownloads();
}

// The file explorer, opened on the song's folder.
function showDiscoverDownloadInLibrary(el) {
  const parts = DISCOVERJOBS.pathCrumbs(el.getAttribute('data-file_location'));
  parts.pop();
  openFileExplorerAt(parts);
}

// The file explorer, opened on one of the library's folders ([library,
// folder, …]): a download's, or where a Discover copy landed (vp.js
// dmKeepShow, "Show in your library").
function openFileExplorerAt(parts) {
  if (!Array.isArray(parts) || parts.length === 0) { return; }
  // The folder is THIS library's. Opened while browsing a connected server
  // (the window's "Show in your library" on a copy kept from its pages), it
  // would be listed on that server: come home first — switchServer's move
  // without its landing panel, whose listing would race this one.
  if (peerContext) {
    peerContext = null;
    browseGeneration++;
    applyServerContext();
  }
  document.querySelectorAll('.side-nav-item').forEach((item) => item.classList.remove('select'));
  const nav = document.querySelector('.side-nav-item[data-panel="fileExplorer"]');
  if (nav) { nav.classList.add('select'); }
  setBrowserRootPanel(t('panel.fileExplorer'));
  programState = [{ state: 'fileExplorer' }];
  fileExplorerArray = [];
  for (const part of parts) {
    fileExplorerArray.push(part);
    programState.push({ state: 'fileExplorer', previousScroll: 0, previousSearch: '' });
  }
  senddir();
}

function removeDiscoverDownload(el) {
  const id = Number(el.getAttribute('data-dlid'));
  const record = discoverDownloadsView.list.find((d) => d.id === id);
  if (!record) { return; }
  const row = DISCOVERJOBS.downloadRow(record);
  iziToast.question({
    timeout: 20000,
    close: false,
    overlayClose: true,
    overlay: true,
    displayMode: 'once',
    id: 'remove-download-question',
    zindex: 99999,
    title: escapeHtml(t('downloads.removeAsk', { title: row.title })),
    message: escapeHtml(t(row.present ? 'downloads.removeAskSub' : 'downloads.removeSettle')),
    position: 'center',
    buttons: [
      [`<button><b>${escapeHtml(t('downloads.removeConfirm'))}</b></button>`, async (instance, toast) => {
        instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
        try {
          const removed = await MSTREAMAPI.discoveryDownloadRemove(id);
          if (removed && removed.kept === 'changed') {
            // The file at that path is no longer the download (something
            // replaced it): the record went to history, the file stays and
            // still plays, so the queue keeps it.
            iziToast.info({ title: escapeHtml(t('downloads.keptChanged')), message: escapeHtml(row.title), position: 'topCenter', timeout: 4000 });
          } else {
            // Queue entries on that path would 404 on their next play.
            for (const i of DISCOVERJOBS.queueIndexesFor(MSTREAMPLAYER.playlist, row.filepath)) {
              MSTREAMPLAYER.removeSongAtPosition(i, false);
            }
            iziToast.success({ title: escapeHtml(t('downloads.removedToast')), message: escapeHtml(row.title), position: 'topCenter', timeout: 2500 });
          }
        } catch (err) {
          const msg = err && err.status === 409
            ? t('downloads.inUse')
            : ((err && err.body && typeof err.body.error === 'string' && err.body.error) || t('downloads.removeFailed'));
          iziToast.error({ title: escapeHtml(msg), position: 'topCenter', timeout: 4000 });
        }
        if (programState[0].state === 'discoverDownloads') { redoDiscoverDownloads(); }
      }, true],
      [`<button>${escapeHtml(t('discover.modal.cancel'))}</button>`, (instance, toast) => {
        instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
      }],
    ],
  });
}

///////////////// Discover page
// The history-seeded Discover page (docs/discovery-page-plan.md §4.1): the
// songs this account finished lately seed what it shows — a new random
// batch of them on every ask (the route keeps nothing between calls, and
// neither does the page: every open and every tap asks). Two pages share
// the bar, the window and the visit's seeds (discoveryView.page):
//   'play'     Discover — songs you can play now: fresh albums and songs
//              from the library, and from connected (federated) servers,
//              playable through this server. Two parallel POSTs to
//              /api/v1/discovery/taste (library, peers), so the library
//              never waits on a connected server's deadline.
//   'explore'  the network (p2p leads), reached only through
//              discoveryPanel({ page: 'explore' }) until its nav row lands.
// Every request body, view model, label and state comes from the pure
// half, alpha/discovery-page.js (DISCOVERYPAGE); this part fetches, draws
// and wires. Network leads and the peer ⋯ open the Discover panel's own
// recommendation window (VUEPLAYERCORE.openDiscoverModal); the leads reuse
// its plug-in list and job poll for their badges.
//
// Row actions use data-dp attributes and ONE delegated handler per render
// (onDiscoveryClick), indexes into discoveryView.shown — never JSON in an
// onclick. Local-only: play history never leaves this server.
const discoveryView = {
  flags: { discovery: false, discoveryTaste: 0, discoveryP2p: false, federationDiscovery: false, discoveryPlugins: false },
  window: 30,         // the bar's window (localStorage: STORAGE_KEYS.window)
  newArtistsOnly: false, // the Explore page's toggle (the panel's shared key)
  off: null,          // after a 403: 'checking' (re-pinging) | 'server' | 'account'
  pins: [],           // this visit's pins (vpath form), now playing first
  moreFrom: null,     // { library, peers }: the first row the last "Show more" added
  lastRandom: false,  // the last library answer had a random seed: the next
                      // load draws no connected-server skeleton column
  nowPlaying: null,   // the song pinned when the page opened
  excluded: [],       // the seeds dropped this visit (hashes): sent as exclude
                      // on every call of the visit, never stored; "Use
                      // again" takes one out. Cleared on a fresh open.
  passed: [],         // the random picks "Another pick" passed over this
                      // visit (hashes): sent in exclude beside the drops,
                      // never drawn as dropped. Cleared on a fresh open, and
                      // when an answer has no pick left (then asked again).
  main: undefined,    // the library+network answer: undefined = none yet
  peers: undefined,   // the peers answer
  peersAsked: false,
  peersBody: null,    // the last peers call's body (pinned to the main
                      // answer's seeds): the column's Try again re-sends it
  pending: { main: false, peers: false },
  pendingGen: 0,      // the browseGeneration those requests belong to
  seq: 0,             // one per request; an answer for an older one is dropped
  page: 'play',       // 'play' (Discover) | 'explore' (the network)
  more: { library: 16, peers: 16 }, // rows each song column shows ("Show more")
  allSeeds: false,    // "Show all" opened (the dropped seeds show too)
  optionsOpen: false, // the bar's "More options" opened (the seed picker shows)
  moodsOpen: false,   // the bar's Filters opened (the mood filters show)
  plugins: null,      // VUEPLAYERCORE.ensureDiscoverPlugins' answer
  badgeRows: [],      // the rows looked up, with their job badges: the
                      // explore page's network leads, the play page's
                      // connected-server songs (never library rows)
  badges: new Map(),  // raw row → badge
  cardBadges: new Map(), // a connected album card's key → its badge
  badgeAsk: 0,        // one per lookup; an older lookup's answer is dropped
  unwatch: null,      // the job-list watch, while the page is up
  shown: { chips: [], excluded: [], tracks: [], allTracks: [], network: [], peers: [], allPeers: [], peerAlbums: [] },
};

// peers is per connected server, at the server's cap (25): enough for the
// column's first 16 rows plus a "Show more" (the default 12 is not).
const DPAGE_LIMITS = { albums: 12, tracks: 48, peers: 25 };

const DPAGE_ICONS = { play: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>', add: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><path fill="currentColor" d="M13 11h8v2h-8v8h-2v-8H3v-2h8V3h2v8z"/></svg>', refresh: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>', note: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>', open: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><path fill="currentColor" d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zm5 16H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/></svg>' };

// The ping's Discover page flags (init()). A server with the taste route
// says so with discoveryTaste >= 1 (an integer generation); the p2p and
// federation sections exist only where the ping advertises them.
function applyDiscoveryPing(response) {
  const r = response || {};
  MSTREAMAPI.currentServer.discoveryTaste = Number(r.discoveryTaste) || 0;
  discoveryView.flags = {
    discovery: r.discovery === true,
    discoveryTaste: MSTREAMAPI.currentServer.discoveryTaste,
    discoveryP2p: r.discoveryP2p === true,
    federationDiscovery: r.federationDiscovery === true,
    discoveryPlugins: r.discoveryPlugins === true,
    moodFilters: r.moodFilters === true,
  };
  discoverySetEntry(DISCOVERYPAGE.pageAvailable(discoveryView.flags));
}

// The nav entry and the now-playing panel's "Discover page →" link
// (spa.css body.has-discover-page) come and go together.
function discoverySetEntry(on) {
  const nav = document.getElementById('nav-discover');
  if (nav) { nav.classList.toggle('super-hide', !on); }
  document.body.classList.toggle('has-discover-page', !!on);
}

// A { key, params } label from DISCOVERYPAGE, in the current language.
function discoveryT(label) {
  return label && label.key ? t(label.key, label.params) : '';
}

// A job row's sub-line part ({key}|{text}|{parts}), the panel's dmText rule.
function discoveryText(part) {
  if (!part) { return ''; }
  if (Array.isArray(part.parts)) { return part.parts.map(discoveryText).filter(Boolean).join(' · '); }
  return part.key ? t(part.key, part.params) : String(part.text || '');
}

// The page is up (not an album opened from it, not another panel).
function discoveryOnScreen() {
  return programState.length === 1 && !!programState[0] && programState[0].state === 'discovery';
}

// The now-playing song as a pin (vpath form), or null: nothing plays, or
// it lives on a peer (its path is in the peer's namespace).
function discoveryNowPlayingPath() {
  const song = typeof MSTREAMPLAYER.getCurrentSong === 'function' ? MSTREAMPLAYER.getCurrentSong() : null;
  if (!song || !song.rawFilePath || song.federation) { return null; }
  return String(song.rawFilePath).replace(/^\/+/, '') || null;
}

// This browser's choices: the window and the shared "new artists only".
function discoveryLocalChoices() {
  const D = DISCOVERYPAGE;
  const out = { window: D.DEFAULT_WINDOW, newArtistsOnly: false };
  try {
    out.window = D.storedWindow(localStorage.getItem(D.STORAGE_KEYS.window));
    out.newArtistsOnly = localStorage.getItem(D.STORAGE_KEYS.newArtistsOnly) === 'true';
  } catch (_) { /* storage blocked: defaults */ }
  return out;
}

// One choice at a time ('window' | 'newArtistsOnly'): the second key is
// shared with the now-playing panel, which may have changed it since this
// visit read it — a window change must not write it back.
function discoverySaveLocalChoice(key) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const value = key === 'window' ? String(v.window) : String(v.newArtistsOnly === true);
  try {
    localStorage.setItem(D.STORAGE_KEYS[key], value);
  } catch (_) { /* storage blocked: this visit only */ }
}

// The "Discover page →" link under the now-playing panel's library list.
function openDiscoveryPage() {
  const nav = document.getElementById('nav-discover');
  if (!nav || nav.classList.contains('super-hide')) { return; }
  changeView(discoveryPanel, nav);
  // On a phone the page draws in the browser tab: bring it forward.
  const tab = document.querySelector('.m-tab.panel_one_name');
  if (tab && typeof toggleThing === 'function' && window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
    toggleThing(tab, true);
  }
}

// The nav click (a fresh visit: now playing is pinned, the window is read
// back, the visit's drops are gone) or a return to the page ({ keep: true }:
// from an album opened on it, from the song picker — the visit's pins and
// drops stay). Either way the page asks again; the answer on screen stays
// drawn (busy) until the new one lands.
// opts.page: 'play' (Discover, the default) | 'explore' (the network); a
// return keeps the page it left.
function discoveryPanel(opts) {
  const o = opts || {};
  const keep = !!o.keep;
  const v = discoveryView;
  const page = DISCOVERYPAGE.PAGES.indexOf(o.page) !== -1 ? o.page : (keep ? v.page : 'play');
  programState = [{ state: 'discovery' }];
  if (peerContext) {
    // Local-only: home first (switchServer draws this page again).
    if (!keep) { switchServer(null); return; }
    // Back from a connected server's album opened here: home, same visit.
    peerContext = null;
    browseGeneration++;
    fileExplorerArray = [];
    applyServerContext();
    highlightNavPanel('discovery');
  }
  setBrowserRootPanel(t('panel.discover'), false);
  currentBrowsingList = [];
  sonicPathHideBanner();
  if (VUEPLAYERCORE.songCapture && VUEPLAYERCORE.songCapture.dpage === true) { VUEPLAYERCORE.songCapture = null; }
  if (!keep) {
    const np = discoveryNowPlayingPath();
    const local = discoveryLocalChoices();
    v.window = local.window;
    v.newArtistsOnly = local.newArtistsOnly;
    v.off = null;
    v.nowPlaying = np;
    v.pins = np ? [np] : [];
    v.excluded = [];
    v.passed = [];
    v.allSeeds = false;
    v.optionsOpen = false;
    v.moodsOpen = false;
    v.more = { library: DISCOVERYPAGE.PAGE_SIZE, peers: DISCOVERYPAGE.PAGE_SIZE };
    // A failed or refused answer is not drawn again while the new one is
    // asked: the page's loading state instead.
    if (!v.main || v.main.disabled === true) { v.main = undefined; v.peers = undefined; }
  }
  // The other page's answer is not this one's (each asks its own sources).
  if (page !== v.page) {
    v.page = page;
    v.main = undefined;
    v.peers = undefined;
    v.badgeRows = [];
    v.badges = new Map();
    v.cardBadges = new Map();
    v.more = { library: DISCOVERYPAGE.PAGE_SIZE, peers: DISCOVERYPAGE.PAGE_SIZE };
  }
  // No answer yet: the page's own loading state (title row, skeletons).
  renderDiscovery();
  return redoDiscovery();
}

// Ask — always: the route draws a new random batch of seeds on every call,
// so every open and every tap is a new question. Built from the visit's
// state alone: the window, the pins, the dropped seeds (exclude) and, on
// the Explore page, "new artists only". The answer on screen stays drawn
// (busy) until the new one lands; an answer for an older ask is dropped.
async function redoDiscovery() {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const gen = browseGeneration;
  if (!D.pageAvailable(v.flags)) {
    if (discoveryOnScreen()) { renderDiscovery(); }
    return;
  }
  const reqs = D.buildRequests({
    page: v.page,
    window: v.window,
    pins: v.pins,
    exclude: v.excluded,
    passed: v.passed,
    newArtistsOnly: v.newArtistsOnly,
    ignoreVPaths: localIgnoreVPaths(),
    // the album strip's share and three pages of songs ("Show more"); the
    // same on both calls and both pages
    limits: DPAGE_LIMITS,
    flags: v.flags,
    moods: moodFilterBody('discover'),
  });
  if (!reqs.main) {
    if (discoveryOnScreen()) { renderDiscovery(); }
    return;
  }

  const seq = ++v.seq;
  const current = () => gen === browseGeneration && seq === v.seq;
  v.pending = { main: true, peers: !!reqs.peers };
  v.pendingGen = gen;
  v.more = { library: D.PAGE_SIZE, peers: D.PAGE_SIZE };
  // peersAsked stays the drawn pair's until the new main lands.
  if (!reqs.peers) { v.peers = undefined; v.peersAsked = false; v.peersBody = null; }
  // The old rows stay until the new ones land; the page says it is asking.
  if (discoveryOnScreen() && (v.main !== undefined || v.peers !== undefined)) { renderDiscovery(); }

  // The peers call goes out once the main answer lands, pinned to its
  // seeds (DISCOVERYPAGE.peersRequest): each call draws its own random
  // batch, and the connected-server column must be built from the one the
  // picker shows. Until then the old pair stays drawn (busy); when the new
  // main lands, the column is in flight (its skeleton), never the old one
  // under the new seeds.
  const res = await MSTREAMAPI.discoveryTaste(reqs.main).catch(() => null);
  if (!current()) { return; }
  // "Another pick" ran out: every song the random fallback could draw was
  // passed over this visit (the server answers no seed, notAnalyzed). Start
  // over — clear the passed picks and ask once more — instead of drawing a
  // false "scan pending" card. Once: the list is empty on the second ask.
  if (v.passed.length && D.noPickLeft(res)) {
    v.passed = [];
    return redoDiscovery();
  }
  v.main = res;
  v.pending.main = false;
  if (res && typeof res === 'object' && res.disabled !== true) { v.lastRandom = res.seedSource === 'random'; }
  if (res && res.disabled === true) { discoveryOff(); return; }
  const peersBody = D.peersRequest(reqs.peers, res);
  v.peersBody = peersBody || null;
  v.peers = undefined;
  // No peers call (a random seed, a failed answer): no column — the
  // server would have answered peers: null.
  v.peersAsked = !!peersBody;
  v.pending.peers = !!peersBody;
  if (discoveryOnScreen()) { renderDiscovery(); }
  if (peersBody) {
    const peersRes = await MSTREAMAPI.discoveryTaste(peersBody).catch(() => null);
    if (!current()) { return; }
    v.peers = peersRes;
    v.pending.peers = false;
    if (discoveryOnScreen()) { renderDiscovery(); }
  }
  await discoveryLoadBadges(seq);
}

// The connected-servers column's Try again: the last peers call again, as
// it was sent (the same pins — the batch the picker shows — window and
// limits), and nothing else. The library batch on screen, its "Show more"
// and the visit's pins and drops stay as they are; only that column (and
// its album strip) asks. While a whole ask is out it does nothing: that
// ask calls the connected servers itself once its answer lands, and a
// whole ask started meanwhile (seq) drops this answer.
async function redoDiscoveryPeers() {
  const v = discoveryView;
  const body = v.peersBody;
  if (!body || v.pending.main || v.pending.peers) { return; }
  const gen = browseGeneration;
  const seq = v.seq;
  v.pending.peers = true;
  v.peers = undefined;
  v.more = Object.assign({}, v.more, { peers: DISCOVERYPAGE.PAGE_SIZE });
  if (discoveryOnScreen()) { renderDiscovery(); }
  const res = await MSTREAMAPI.discoveryTaste(body).catch(() => null);
  if (gen !== browseGeneration || seq !== v.seq) { return; }
  v.peers = res;
  v.pending.peers = false;
  if (discoveryOnScreen()) { renderDiscovery(); }
  // the column's new rows: their copies, looked up as a whole ask's are
  await discoveryLoadBadges(seq);
}

// A 403. The entry goes with it (the nav and the panel's link), as the
// Sonic Path's does. The route says 403 both when discovery went off and
// to an account with no history here (a federation key, a guest, a
// jukebox): a fresh ping tells the two apart before the page names one.
async function discoveryOff() {
  const v = discoveryView;
  v.main = { disabled: true };
  v.pending = { main: false, peers: false };
  discoverySetEntry(false);
  if (v.off === 'checking') { return; }
  v.off = 'checking';
  if (discoveryOnScreen()) { renderDiscovery(); }
  let still = false;
  try {
    const r = await MSTREAMAPI.ping();
    still = !!r && r.discovery === true && Number(r.discoveryTaste) >= 1;
  } catch (_) { /* no answer: say off */ }
  v.off = still ? 'account' : 'server';
  if (discoveryOnScreen()) { renderDiscovery(); }
}

// The two answers as one (the peers call's section on the library answer).
// Its excluded[] rows are only the ones still in this visit's list: the
// answer held on screen after a fresh open (or a "Use again") must not
// offer back drops the visit no longer has.
function discoveryResponse() {
  const v = discoveryView;
  const res = DISCOVERYPAGE.mergeResponses(v.main, v.peers, v.peersAsked);
  if (!res || typeof res !== 'object' || !Array.isArray(res.excluded)) { return res; }
  const visit = new Set(v.excluded);
  const excluded = res.excluded.filter((e) => e && visit.has(e.hash));
  return excluded.length === res.excluded.length ? res : Object.assign({}, res, { excluded });
}

// What the user already did with a row: a network lead's download
// ("getting it · 64%") on the explore page; on the play page a connected
// server's copy — of the song, its album or its artist — on that server's
// song rows and album cards (a copy started from the window leaves its
// trace on the page). Library rows are never looked up: they are already
// yours. One batch lookup per 100 rows (every connected-server row, not
// only the ones "Show more" has drawn so far), then the strip's job poll
// keeps the badges current while the page is up. Only where plug-ins
// exist. Called once an answer's rows are drawn: a whole ask's, and the
// connected column's own Try again.
async function discoveryLoadBadges(seq) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  if (v.flags.discoveryPlugins !== true || seq !== v.seq) { return; }
  const gen = browseGeneration;
  const ask = ++v.badgeAsk;
  const live = () => gen === browseGeneration && seq === v.seq && ask === v.badgeAsk;
  const res = discoveryResponse();
  const rows = v.page === 'explore' ? D.networkRows(res).rows : D.peerSongRows(D.peerGroups(res));
  if (!rows.length) {
    v.badgeRows = [];
    discoveryIndexBadges();
    return;
  }
  if (!v.plugins) {
    v.plugins = await VUEPLAYERCORE.ensureDiscoverPlugins();
    if (!live()) { return; }
  }
  const results = [];
  for (const chunk of D.lookupChunks(rows)) {
    let got = [];
    try {
      const r = await MSTREAMAPI.discoveryJobLookupBatch(chunk);
      got = r && Array.isArray(r.results) ? r.results : [];
    } catch (_) { /* no badges for this chunk */ }
    if (!live()) { return; }
    for (let i = 0; i < chunk.length; i++) { results.push(got[i] || null); }
  }
  v.badgeRows = D.jobBadges(rows, { results }, DISCOVERJOBS);
  discoveryIndexBadges();
  discoveryWatchJobs();
  if (discoveryOnScreen()) { renderDiscovery(); }
}

// The badges by what draws them: a row's by its raw row, a connected
// album card's by its key — from the rows' own jobs (an album or artist
// copy of that server's; DISCOVERYPAGE.peerAlbumBadges), no request of
// their own.
function discoveryIndexBadges() {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  v.badges = new Map(v.badgeRows.map((r) => [r.raw, r.badge]));
  const cards = v.page === 'explore' ? [] : D.peerAlbums(D.peerGroups(discoveryResponse()));
  const badges = D.peerAlbumBadges(cards, v.badgeRows, DISCOVERJOBS);
  v.cardBadges = new Map();
  cards.forEach((c, i) => { if (badges[i]) { v.cardBadges.set(c.key, badges[i]); } });
}

// Keep the badges current while the page is up: merge the strip's latest
// job list now, then on each change of it. The watch ends with the first
// change after the page is left; a return re-attaches it. A tick redraws
// only the badges that changed, in place — a whole-page draw on the poll's
// beat would drop focus, the album strip's scroll and an open ⋯ popper.
function discoveryWatchJobs() {
  const v = discoveryView;
  if (v.flags.discoveryPlugins !== true || !v.badgeRows.length) { return; }
  discoveryMergeJobs(VUEPLAYERCORE.discoverJobs());
  if (!v.unwatch) {
    v.unwatch = VUEPLAYERCORE.watchDiscoverJobs((jobs) => {
      if (!programState[0] || programState[0].state !== 'discovery') {
        if (v.unwatch) { v.unwatch(); }
        v.unwatch = null;
        return;
      }
      const changed = discoveryMergeJobs(jobs);
      if ((changed.rows.length || changed.cards.length) && discoveryOnScreen()) { discoveryPatchBadges(changed); }
    });
  }
  // A job still moving: wake the strip's poll so the badge moves too.
  if (DISCOVERYPAGE.anyLiveBadge(v.badgeRows)) { VUEPLAYERCORE.refreshDiscoverJobs(); }
}

// Merge a job list onto the rows → what changed: the raw rows whose badge
// did, and the connected album cards' keys whose badge did (a badge that
// appeared or went away included).
function discoveryMergeJobs(jobs) {
  const v = discoveryView;
  const before = v.badges;
  const beforeCards = v.cardBadges;
  const sig = (b) => (b ? JSON.stringify([b.tag || '', b.tagCls || '', b.kind || '', b.sub || null, typeof b.progress === 'number' ? b.progress : null]) : '');
  v.badgeRows = DISCOVERYPAGE.jobBadges(v.badgeRows, { jobs }, DISCOVERJOBS);
  discoveryIndexBadges();
  const rows = v.badgeRows.filter((r) => sig(before.get(r.raw)) !== sig(r.badge)).map((r) => r.raw);
  const keys = new Set([...beforeCards.keys(), ...v.cardBadges.keys()]);
  const cards = [...keys].filter((k) => sig(beforeCards.get(k)) !== sig(v.cardBadges.get(k)));
  return { rows, cards };
}

// Redraw what changed in place — never the page (focus, the album strip's
// scroll and an open ⋯ popper survive the poll's beat): a row's badge and
// bar slots (data-bslot / data-pslot = 'n' + a network lead's index, 'p' +
// a connected-server song row's) and a connected album card's ('a' + its
// index). A row or card not drawn is skipped; a slot not found falls back
// to a whole-page draw.
function discoveryPatchBadges(changed) {
  const v = discoveryView;
  const root = document.getElementById('filelist');
  const writes = [];
  for (const raw of changed.rows || []) {
    const n = v.shown.network.findIndex((r) => r.raw === raw);
    if (n !== -1) { writes.push(['n' + n, discoveryLeadTag(v.shown.network[n]), discoveryProgressHtml(v.badges.get(raw) || null)]); }
    const p = v.shown.peers.findIndex((r) => r.raw === raw);
    if (p !== -1) {
      const b = v.badges.get(raw) || null;
      writes.push(['p' + p, discoveryBadgeHtml(b, true), discoveryThinBarHtml(b)]);
    }
  }
  for (const key of changed.cards || []) {
    const a = v.shown.peerAlbums.findIndex((c) => c.key === key);
    if (a === -1) { continue; }
    const b = v.cardBadges.get(key) || null;
    writes.push(['a' + a, discoveryCardBadgeHtml(b), discoveryThinBarHtml(b)]);
  }
  for (const [id, tag, bar] of writes) {
    const slot = root.querySelector(`[data-bslot="${id}"]`);
    const barSlot = root.querySelector(`[data-pslot="${id}"]`);
    if (!slot || !barSlot) { renderDiscovery(); return; }
    slot.innerHTML = tag;
    barSlot.innerHTML = bar;
  }
}

// The bar's host (#dpage-head, above the #filelist scroller): emptied and
// hidden when the page is left (another panel, an album opened from it) or
// draws no bar (off / unavailable).
function discoveryHideHead() {
  const head = document.getElementById('dpage-head');
  if (!head) { return; }
  head.classList.add('super-hide');
  head.innerHTML = '';
}

function renderDiscovery() {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const root = document.getElementById('filelist');
  const head = document.getElementById('dpage-head');
  const res = discoveryResponse();
  const page = v.page === 'explore' ? 'explore' : 'play';
  const st = D.stateOf(res, v.flags, { page });
  v.shown = { chips: [], excluded: [], tracks: [], allTracks: [], network: [], peers: [], allPeers: [], peerAlbums: [] };

  if (st.state === 'off') {
    // After a 403 the re-ping names the reason: the server switched it off,
    // or this account has no history here (the ping still has the page).
    const account = v.off === 'account' && D.pageAvailable(v.flags);
    const body = v.off === 'checking'
      ? escapeHtml(t('dpage.state.loading'))
      : `<b>${escapeHtml(t(account ? 'dpage.state.unavailable' : 'dpage.state.off'))}</b><br>${escapeHtml(t(account ? 'dpage.state.unavailableBody' : 'dpage.state.offBody'))}`;
    discoveryHideHead();
    root.innerHTML = `<div class="dpage dpage-off"><div class="dpage-hint">${body}</div></div>`;
    return;
  }
  // Dimmed while the library (main) call is out — the old answer held on
  // screen. Never for the connected servers' call alone: that waits up to
  // a peer's 4 s deadline after the library has landed, and the library it
  // would dim is already the new one. Their column and strip draw their
  // own skeletons (aria-busy) meanwhile.
  const busy = v.pending.main;
  const refocus = discoveryFocusedSelector();
  const cls = `dpage-page-${page}${busy ? ' dpage-busy' : ''}`;
  // The bar sits in the column's chrome (#dpage-head), out of the scroller.
  // The seed picker (and, on Explore, "new artists only") sit behind its
  // "More options", in the same host: a first-time user took the seed chips
  // for songs to play.
  let barHtml = discoveryHeadHtml(v.window);
  if (v.moodsOpen && page === 'play' && DISCOVERYPAGE.moodsAvailable(v.flags)) {
    barHtml += `<div class="mood-filters dpage-moods" id="dpage-moods" role="region" aria-label="${escapeHtml(t('moods.filters'))}">${moodPanelHtml('discover')}</div>`;
  }
  if (v.optionsOpen) { barHtml += discoveryOptionsHtml(st, res, page); }
  let html = `<div class="dpage ${cls}"${st.state === 'loading' ? ' aria-busy="true"' : ''}>`;
  // No host (an index.html older than this script): the bar heads the page
  // in the scroller, as it once did, rather than vanishing.
  if (!head) { html += barHtml; }

  if (st.state === 'failed') {
    html += discoveryCardHtml(t('dpage.state.failed'), '', [['retry', 'dpage.verb.tryAgain', true]]);
  } else {
    if (st.state === 'nothingFinished') {
      const dropped = st.reason && st.reason.key === 'dpage.state.allDropped';
      // Another pick: ask again with this pick passed over (v.passed).
      const acts = [['another', 'dpage.verb.anotherPick', true], ['pick', 'dpage.verb.chooseSong'], ['browse', 'dpage.verb.browseLibrary']];
      // Every seed dropped: the way back ("Use again") sits in the picker.
      if (dropped) { acts.splice(1, 0, ['editSeeds', 'dpage.seeds.edit']); }
      html += discoveryCardHtml(discoveryT(st.reason), t(dropped ? 'dpage.state.allDroppedBody' : 'dpage.state.nothingFinishedBody'), acts);
    } else if (st.state === 'scanPending') {
      const acts = [['retry', 'dpage.verb.checkAgain']];
      if (MSTREAMAPI.currentServer.admin === true) { acts.push(['admin', 'dpage.verb.adminEnrichment']); }
      html += discoveryCardHtml(discoveryT(st.reason), t('dpage.state.scanPendingBody'), acts, t('dpage.state.seedsListedAnyway'));
    }
    html += page === 'explore' ? discoveryExploreHtml(res, st) : discoveryPlayHtml(res, st);
  }
  html += '</div>';
  if (head) {
    // The open picker scrolls on its own (capped in the host) and is redrawn
    // with the host: keep its scroll across the draw.
    const prev = head.querySelector('.dpage-options');
    const keep = v.optionsOpen && prev ? prev.scrollTop : 0;
    head.innerHTML = `<div class="dpage dpage-chrome ${cls}">${barHtml}</div>`;
    head.classList.remove('super-hide');
    const opts = keep ? head.querySelector('.dpage-options') : null;
    if (opts) { opts.scrollTop = keep; }
  }
  root.innerHTML = html;
  for (const host of [head, root]) {
    const el = host && host.querySelector('.dpage');
    if (!el) { continue; }
    el.addEventListener('click', onDiscoveryClick);
    el.addEventListener('change', onDiscoveryChange);
    el.addEventListener('keydown', onDiscoveryKey);
  }
  // A whole-page draw replaces the control the keyboard was on: put it back.
  if (refocus) { discoveryRefocus(refocus, ...discoveryFocusFallbacks(refocus)); }
}

// The keyboard's control on the page (a data-dp control), as a selector the
// next draw can find again — or null.
function discoveryFocusedSelector() {
  const el = document.activeElement;
  if (!el || typeof el.closest !== 'function' || !el.closest('#dpage-head .dpage, #filelist .dpage')) { return null; }
  const act = el.getAttribute('data-dp');
  if (!act) { return null; }
  let sel = `[data-dp="${act}"]`;
  for (const a of ['data-v', 'data-i']) {
    const val = el.getAttribute(a);
    if (val != null) { sel += `[${a}="${val}"]`; }
  }
  return sel;
}

// The configuration bar: the window, "More options" and "New seeds" (⟳).
function discoveryHeadHtml(windowDays) {
  const opts = DISCOVERYPAGE.windowOptions(windowDays)
    .map((o) => `<option value="${escapeHtml(o.value)}"${o.selected ? ' selected' : ''}>${escapeHtml(discoveryT(o.label))}</option>`).join('');
  const open = discoveryView.optionsOpen === true;
  // The mood filters (moodPanelHtml), on the Discover page of a server
  // that takes them; orange with a dot while one is set.
  const moods = discoveryView.page !== 'explore' && DISCOVERYPAGE.moodsAvailable(discoveryView.flags)
    ? `<button type="button" class="mood-filter-btn dpage-moods-btn${moodFilterBody('discover') ? ' mood-on' : ''}" data-dp="moods" aria-expanded="${discoveryView.moodsOpen ? 'true' : 'false'}"${discoveryView.moodsOpen ? ' aria-controls="dpage-moods"' : ''} aria-label="${escapeHtml(t('moods.filters'))}" title="${escapeHtml(t('moods.filters'))}"><svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39A.998.998 0 0 0 18.95 4H5.04c-.83 0-1.3.95-.79 1.61z"/><circle class="mood-filter-dot" cx="20" cy="4" r="3.5"/></svg></button>`
    : '';
  return `<div class="dpage-bar">
    <span class="grow"></span>
    <label class="dpage-window"><span>${escapeHtml(t('dpage.basedOnLast'))}</span><select class="browser-default" data-dp-change="window">${opts}</select></label>
    <span class="dpage-bar-r">
      ${moods}<button type="button" class="dpage-bar-opt" data-dp="options" aria-expanded="${open ? 'true' : 'false'}"${open ? ' aria-controls="dpage-options"' : ''}>${escapeHtml(t(open ? 'dpage.bar.fewerOptions' : 'dpage.bar.moreOptions'))}<span class="dpage-bar-caret" aria-hidden="true">${open ? '&#9652;' : '&#9662;'}</span></button>
      <button type="button" class="dpage-icon-btn" data-dp="refresh" title="${escapeHtml(t('dpage.verb.newSeeds'))}" aria-label="${escapeHtml(t('dpage.verb.newSeeds'))}">${DPAGE_ICONS.refresh}</button>
    </span>
  </div>`;
}

// Under the bar while "More options" is open: on Explore its one checkbox
// ("new artists only"), then the seed picker — or one dim line while there
// is no answer to pick from.
function discoveryOptionsHtml(st, res, page) {
  const check = page === 'explore'
    ? `<div class="dpage-opt-row">${discoveryCheckHtml('newArtists', discoveryView.newArtistsOnly === true, t('dpage.network.newArtistsOnly'))}</div>`
    : '';
  // The body already says why (loading / failed): this line says only
  // what the picker is waiting for.
  const inner = st.state === 'loading' || st.state === 'failed'
    ? `<div class="dpage-hint">${escapeHtml(t('dpage.bar.seedsWait'))}</div>`
    : discoverySeedsHtml(res);
  return `<div class="dpage-options" id="dpage-options">${check}${inner}</div>`;
}

// A checkbox drawn as a button (materialize hides a bare <input>).
function discoveryCheckHtml(act, on, label) {
  return `<button type="button" class="dpage-tog dpage-check${on ? ' on' : ''}" role="checkbox" aria-checked="${on ? 'true' : 'false'}" data-dp="${act}"><i aria-hidden="true"></i>${escapeHtml(label)}</button>`;
}

// One of the states' cards: a title, a body, its buttons ([act, key, primary]).
function discoveryCardHtml(title, body, acts, note) {
  const buttons = acts.map(([act, key, pri, val]) =>
    `<button type="button" class="dpage-btn${pri ? ' pri' : ''}" data-dp="${escapeHtml(act)}"${val ? ` data-v="${escapeHtml(val)}"` : ''}>${escapeHtml(t(key))}</button>`).join('');
  return `<div class="dpage-card">
    <div class="dpage-card-t">${escapeHtml(title)}</div>
    ${body ? `<div class="dpage-card-s">${escapeHtml(body)}</div>` : ''}
    <div class="dpage-card-acts">${buttons}</div>
    ${note ? `<div class="dpage-card-note">${escapeHtml(note)}</div>` : ''}
  </div>`;
}

// "Based on what you finished": the batch the answer was built from (×
// drops a history seed for this visit, unpins a pin), "Show all" (and the
// dropped ones with Use again), "+ Now playing", "+ Add a song…".
function discoverySeedsHtml(res) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const sc = D.seedChips(res, { nowPlaying: v.nowPlaying });
  const chips = v.allSeeds ? [...sc.chips, ...sc.hidden] : sc.chips;
  v.shown.chips = chips;
  v.shown.excluded = sc.excluded;

  const chip = (c, i) => {
    const art = c.art ? `<img loading="lazy" ${artImgAttr(c.art, 's')} alt="">` : DPAGE_ICONS.note;
    const title = c.action === 'drop' ? t('dpage.seeds.drop') : (c.action === 'unpin' ? t('dpage.seeds.unpin') : '');
    return `<button type="button" class="dpage-chip${c.pinned ? ' dpage-chip-pin' : ''}${c.analyzed ? '' : ' dpage-chip-dim'}"${c.action ? ` data-dp="${c.action}" data-i="${i}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>
      <span class="dpage-chip-art">${art}</span><span class="dpage-chip-label">${escapeHtml(discoveryT(c.label))}</span>${c.tags.map((tg) => `<span class="dpage-chip-tag">${escapeHtml(discoveryT(tg))}</span>`).join('')}${c.action ? '<span class="dpage-chip-x" aria-hidden="true">&times;</span>' : ''}
    </button>`;
  };
  let html = `<section class="dpage-seeds">
    <div class="dpage-seeds-h"><span class="dpage-cap">${escapeHtml(t('dpage.seeds.title'))}</span></div>
    <div class="dpage-chips">${chips.map(chip).join('')}`;
  if (sc.overflow > 0 || sc.excluded.length) {
    const label = v.allSeeds ? t('dpage.seeds.showLess') : (sc.overflow > 0 ? discoveryT(sc.more) : t('dpage.seeds.edit'));
    html += `<button type="button" class="dpage-chip dpage-chip-more" data-dp="moreSeeds">${escapeHtml(label)}</button>`;
  }
  const np = discoveryNowPlayingPath();
  if (np && v.pins.indexOf(np) === -1 && res && res.seedSource !== 'random') {
    html += `<button type="button" class="dpage-chip dpage-chip-add" data-dp="addPlaying">${escapeHtml(t('dpage.seeds.addNowPlaying'))}</button>`;
  }
  html += `<button type="button" class="dpage-chip dpage-chip-add" data-dp="pick">${escapeHtml(t('dpage.seeds.add'))}</button></div>`;
  if (v.allSeeds && sc.excluded.length) {
    html += `<div class="dpage-chips dpage-dropped">${sc.excluded.map((e, i) =>
      `<button type="button" class="dpage-chip dpage-chip-dim" data-dp="restore" data-i="${i}" title="${escapeHtml(t('dpage.seeds.restore'))}"><span class="dpage-chip-art">${DPAGE_ICONS.note}</span><span class="dpage-chip-label">${escapeHtml(discoveryT(e.label))}</span><span class="dpage-chip-tag">${escapeHtml(discoveryT(e.tag))}</span><span class="dpage-chip-x" aria-hidden="true">+</span></button>`).join('')}</div>`;
  }
  return html + '</section>';
}

// A section's small label: letter-spaced caps after its source's dot.
function discoveryLabelHtml(text) {
  return text ? `<h3 class="dpage-label"><span class="dpage-dot" aria-hidden="true"></span>${escapeHtml(text)}</h3>` : '';
}

// Placeholders while a source is asked: album tiles, song rows.
function discoverySkelHtml(kind, n) {
  const one = kind === 'cards'
    ? '<div class="dpage-skel-card"><i></i><b></b><b></b></div>'
    : '<div class="dpage-skel-row"><i></i><span><b></b><b></b></span></div>';
  return one.repeat(n);
}

// ── Discover (play now): songs you can play now, from your library and
// from connected servers. Albums strips, then the songs in two columns
// (library | connected servers) side by side where the page is wide
// enough (the @container rule on .dpage in spa.css), stacked under it.
function discoveryPlayHtml(res, st) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const ls = st.sources.library;
  const ps = st.sources.peers;
  // A connected-server column, unless there is none, or the library answer
  // is still out and the last one had a random seed (the server asks no
  // connected server then): no two-column skeleton that re-flows to one.
  const mainOut = res === undefined || (res && res.partial === true);
  const fed = ps.status !== 'absent' && !(ps.status === 'loading' && mainOut && v.lastRandom === true);
  const lib = ls.status === 'ready' ? D.librarySections(res) : null;
  const pg = ps.status === 'ready' || ps.status === 'empty' ? D.peerGroups(res) : null;
  const labels = D.pageLabels(pg || []);
  let html = '';

  // 1. Albums from your library
  if (ls.status === 'loading') {
    html += discoveryStripHtml('library', t('dpage.albums.library'), discoverySkelHtml('cards', 4), true);
  } else if (lib && lib.albums.length) {
    // The year still rides on the card as data-year (getAlbumsOnClick and
    // queueAlbum narrow /db/album-songs by it: two "Greatest Hits" stay
    // apart); only its face line is dropped.
    const cards = lib.albums.slice(0, D.ALBUM_STRIP_MAX).map((a) =>
      `<div class="dpage-album"${a.because ? ` title="${escapeHtml(discoveryT(a.because))}"` : ''}>${renderAlbum(a.name, undefined, a.name || '', a.albumArtFile, a.year == null ? undefined : a.year, a.albumArtist, a.artistLine).replace(/\s*<div class="album-grid-year">[^<]*<\/div>/, '')}</div>`).join('');
    html += discoveryStripHtml('library', discoveryT(labels.libraryAlbums), cards);
  }

  // 2. Albums from connected servers (hidden without one, or without an
  // album-tagged playable row)
  if (fed && ps.status === 'loading') {
    html += discoveryStripHtml('peers', '', discoverySkelHtml('cards', 4), true);
  } else if (ps.status === 'ready') {
    const albums = D.peerAlbums(pg);
    v.shown.peerAlbums = albums;
    if (albums.length) {
      html += discoveryStripHtml('peers', discoveryT(labels.peerAlbums), albums.map(discoveryPeerAlbumHtml).join(''));
    }
  }

  // 3. The songs: library | connected servers, or the library alone over
  // both columns (column-major) when no server is connected.
  html += `<div class="dpage-songs${fed ? '' : ' dpage-songs-solo'}">`;
  html += discoveryLibrarySongsHtml(ls, lib, !fed);
  if (fed) { html += discoveryPeerSongsHtml(ps, pg, labels); }
  return html + '</div>';
}

function discoveryStripHtml(source, label, cards, skeleton) {
  return `<section class="dpage-strip dpage-src-${source}"${skeleton ? ' aria-busy="true"' : ''}>${discoveryLabelHtml(label)}<div class="album-grid dpage-albums">${cards}</div></section>`;
}

// The note glyph an album card draws without art (renderAlbum's own).
const DPAGE_NOTE_CARD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#555"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

// A connected server's cover that did not load: the proxy's 502 (the peer
// went offline after the taste answer, before this lazy image's fetch) or
// a 404 (the peer's cache was cleared). The note tile, as with no
// albumArt, not an empty broken-image box. Called from the <img>'s own
// onerror, so it is global like selectAlbumArt.
function discoveryPeerArtFailed(img) {
  const box = img && img.parentElement;
  if (!box) { return; }
  img.onerror = null;
  if (box.classList.contains('dpage-art')) {
    box.classList.add('dpage-art-ph');
    box.innerHTML = DPAGE_ICONS.note;
  } else {
    img.outerHTML = DPAGE_NOTE_CARD;
  }
}

// A connected server's album card: renderAlbum's face (art, title,
// artist) with the server's art through the proxy. data-peer names the
// server; the card opens the album in the peer-browse view, its play
// button queues the album through the federation stream, its ⋯ opens the
// recommendation window as the album (Listen, Keep a copy with Album
// chosen, Find elsewhere for the album) — never a one-click
// copy. The cover always
// asks for the peer's 'l' variant (its zl- file, at most 256 px a side:
// the size the library's cards use in compressed-art mode), whatever the
// layout setting — it crosses the proxy from the peer, and a full-size
// original can be megabytes for a 150 px card. A peer with no zl- file for
// that cover (compressImage off, no ffmpeg, a cover cached before it had
// thumbnails) sends its full-size original instead, as its /album-art/
// does for any missing variant.
function discoveryPeerAlbumHtml(a, i) {
  const src = a.art && a.peerId != null
    ? MSTREAMAPI.peerArtUrl(a.peerId, a.art, 'l')
    : null;
  // An album or artist copy of THIS server's (slots 'a' + i, patched in
  // place on the job poll): its word on a line kept under the artist line
  // on every card, badge or not (.dpage-cstate, a fixed height: a badge
  // that appears fills it, never grows the card or the strip), its thin
  // bar along the cover's foot.
  const badge = discoveryView.cardBadges.get(a.key) || null;
  // The card's narrowing, as renderAlbum's: data-album-artist = the album's
  // own credit when its rows carry one (the album whole: a compilation's
  // card), else data-artist = the track artist. The artist line is the
  // credit either way.
  const q = DISCOVERYPAGE.peerAlbumQuery(a);
  return `<div class="dpage-album" title="${escapeHtml(a.peerName || '')}"><div class="album-grid-card dpage-peer-card" data-peer="${escapeHtml(a.peerId)}" data-album="${escapeHtml(a.album)}"${q.artist ? ` data-artist="${escapeHtml(q.artist)}"` : ''}${q.album_artist ? ` data-album-artist="${escapeHtml(q.album_artist)}"` : ''} data-dp="peerAlbumOpen" data-i="${i}" tabindex="0" role="link" aria-label="${escapeHtml([a.album, a.artist].filter(Boolean).join(' · '))}">
    <div class="album-grid-art">
      ${src ? `<img loading="lazy" src="${escapeHtml(src)}" alt="" onerror="discoveryPeerArtFailed(this)">` : DPAGE_NOTE_CARD}
      <button type="button" class="album-grid-play" data-dp="peerAlbum" data-i="${i}" title="${escapeHtml(t('dpage.verb.queue'))}" aria-label="${escapeHtml(t('dpage.verb.queue'))}">
        <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button type="button" class="dpage-album-more" data-dp="peerAlbumMore" data-i="${i}" title="${escapeHtml(t('dpage.verb.albumMore'))}" aria-label="${escapeHtml(t('dpage.verb.albumMore'))}">⋯</button>
      <div class="dpage-slot" data-pslot="a${i}">${discoveryThinBarHtml(badge)}</div>
    </div>
    <div class="album-grid-info">
      <div class="album-grid-name">${escapeHtml(a.album)}</div>
      ${a.artist ? `<div class="album-grid-artist">${escapeHtml(a.artist)}</div>` : ''}
      <div class="dpage-cstate" data-bslot="a${i}">${discoveryCardBadgeHtml(badge)}</div>
    </div>
  </div></div>`;
}

// A song row's 40 px art tile: the library's art, a connected server's
// through the proxy, else the note glyph.
function discoveryArtHtml(srcAttr, peer) {
  return srcAttr
    ? `<span class="dpage-art"><img loading="lazy" ${srcAttr} alt=""${peer ? ' onerror="discoveryPeerArtFailed(this)"' : ''}></span>`
    : `<span class="dpage-art dpage-art-ph">${DPAGE_ICONS.note}</span>`;
}

// One song row: art, title, "Artist · Album", the hover verbs. `kind` is
// 'lib' (verbs play / queue / ⋯ add to playlist) or 'peer' (play now /
// queue through this server, ⋯ opens the peer window). A click on the
// row queues it, in both columns.
function discoverySongRowHtml(r, i, kind) {
  const peer = kind === 'peer';
  const src = peer
    ? (r.art && r.peerId != null ? `src="${escapeHtml(MSTREAMAPI.peerArtUrl(r.peerId, r.art, 's'))}"` : null)
    : (r.art ? artImgAttr(r.art, 's') : null);
  // "Because you finished … · Sam's server" where the row names its seed;
  // a connected server's rows usually match the seeds' centroid (no one
  // seed), so the server's name alone.
  const because = r.because ? discoveryT(r.because) : '';
  const tip = peer ? [because, r.peerName || ''].filter(Boolean).join(' · ') : because;
  const verb = (act, key, icon, extra) =>
    `<button type="button" class="dpage-vb" data-dp="${act}" data-i="${i}"${extra || ''} title="${escapeHtml(t(key))}" aria-label="${escapeHtml(t(key))}">${icon}</button>`;
  const verbs = peer
    ? verb('peerPlay', 'dpage.verb.playNow', DPAGE_ICONS.play) + verb('fedQueue', 'dpage.verb.queue', DPAGE_ICONS.add) + verb('peerMore', 'dpage.verb.more', '⋯')
    : verb('play', 'dpage.verb.playNow', DPAGE_ICONS.play) + verb('queue', 'dpage.verb.queue', DPAGE_ICONS.add) +
      verb('more', 'dpage.verb.addToPlaylist', '⋯', ` data-file_location="${escapeHtml(r.filepath)}"`);
  // A connected server's row carries its copy's badge ON its subtitle line,
  // after "Artist · Album" (which truncates first), and its thin bar pinned to
  // the row's bottom edge — slots 'p' + i, patched in place on the job poll.
  // Neither takes a line of its own, so a badge arriving on the poll's beat
  // never changes the row's height (the rows below never move). A library
  // row has neither.
  const badge = peer ? (discoveryView.badges.get(r.raw) || null) : null;
  const sub = peer
    ? `<div class="discover-row-sub dpage-subline"><span class="dpage-subtext">${escapeHtml(r.subtitle || '')}</span><div class="dpage-slot" data-bslot="p${i}">${discoveryBadgeHtml(badge, true)}</div></div><div class="dpage-slot" data-pslot="p${i}">${discoveryThinBarHtml(badge)}</div>`
    : `<div class="discover-row-sub">${escapeHtml(r.subtitle || '')}</div>`;
  return `<div class="discover-row dpage-row pointer" data-dp="${peer ? 'fedQueue' : 'queue'}" data-i="${i}"${tip ? ` title="${escapeHtml(tip)}"` : ''}>
    ${discoveryArtHtml(src, peer)}
    <div class="discover-row-info"><div class="discover-row-title">${escapeHtml(r.title)}</div>${sub}</div>
    <span class="dpage-verbs">${verbs}</span>
  </div>`;
}

function discoveryShowMoreHtml(source) {
  return `<button type="button" class="dpage-more" data-dp="showMore" data-v="${source}">${escapeHtml(t('dpage.showMore'))}</button>`;
}

// A column's one dim line, with its button (or Try again).
function discoveryColHintHtml(text, act, key) {
  const btn = act ? ` <button type="button" class="dpage-vb dpage-hint-btn" data-dp="${act}">${escapeHtml(t(key))}</button>` : '';
  return `<div class="dpage-hint">${escapeHtml(text)}${btn}</div>`;
}

// "Songs from your library". `solo` = no connected servers: the rows flow
// column-major over both columns (rows 1–8 left, 9–16 right) in blocks of
// DISCOVERYPAGE.PAGE_SIZE where the page is wide enough.
function discoveryLibrarySongsHtml(s, lib, solo) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  let body = '';
  let acts = '';
  if (s.status === 'loading') {
    body = `<div class="dpage-rows" aria-busy="true">${discoverySkelHtml('rows', 4)}</div>`;
  } else if (s.status === 'failed') {
    body = discoveryColHintHtml(discoveryT(s.reason), 'retry', 'dpage.verb.tryAgain');
  } else if (s.status === 'empty' || !lib || !lib.tracks.length) {
    body = discoveryColHintHtml(discoveryT(s.reason || { key: 'dpage.library.nothing' }));
  } else {
    const slice = D.pageSlice(lib.tracks, v.more.library);
    v.shown.tracks = slice.rows;
    v.shown.allTracks = lib.tracks;
    if (solo) {
      body = D.columnBlocks(slice.rows).map((b) =>
        `<div class="dpage-rows dpage-flow" style="--dpage-per:${b.perColumn}">${b.rows.map((x) => discoverySongRowHtml(x.row, x.i, 'lib')).join('')}</div>`).join('');
    } else {
      body = `<div class="dpage-rows">${slice.rows.map((r, i) => discoverySongRowHtml(r, i, 'lib')).join('')}</div>`;
    }
    if (slice.more) { body += discoveryShowMoreHtml('library'); }
    // The whole-list verbs sit under the header, ahead of the rows.
    acts = `<div class="dpage-acts">
      <a href="javascript:void(0)" class="dpage-acts-pri" data-dp="queueAll">${escapeHtml(discoveryT(lib.footer.queueAllLabel))}</a><span class="dpage-sep" aria-hidden="true">·</span>
      <a href="javascript:void(0)" data-dp="shuffle">${escapeHtml(t('dpage.verb.shuffle'))}</a><span class="dpage-sep" aria-hidden="true">·</span>
      <a href="javascript:void(0)" data-dp="save">${escapeHtml(t('dpage.verb.saveAsPlaylist'))}</a>
    </div>`;
  }
  return `<section class="dpage-col dpage-src-library" data-source="library">${discoveryLabelHtml(t('dpage.songs.library'))}${acts}${body}</section>`;
}

// "Songs from {name}" / "Songs from connected servers": ONE flat list of
// the rows a connected server can play now, best match first.
function discoveryPeerSongsHtml(s, pg, labels) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const label = labels.peerSongs ? discoveryT(labels.peerSongs) : t('dpage.songs.peerMany');
  let body = '';
  let acts = '';
  if (s.status === 'loading') {
    return `<section class="dpage-col dpage-src-peers" data-source="peers"><div class="dpage-rows" aria-busy="true">${discoverySkelHtml('rows', 4)}</div></section>`;
  }
  const rows = s.status === 'ready' ? D.peerSongRows(pg) : [];
  if (s.status === 'failed') {
    // Its own Try again (redoDiscoveryPeers): only this column asks again.
    body = discoveryColHintHtml(discoveryT(s.reason), 'peersRetry', 'dpage.verb.tryAgain');
  } else if (!rows.length) {
    body = discoveryColHintHtml(t('dpage.peers.quiet'));
  } else {
    const slice = D.pageSlice(rows, v.more.peers);
    v.shown.peers = slice.rows;
    v.shown.allPeers = rows;
    // a connected server's name for the queue row (addFederationSongWizard)
    for (const g of pg.groups) { if (g.id != null && !knownPeers.has(Number(g.id))) { rememberPeer({ id: g.id, name: g.name }); } }
    body = `<div class="dpage-rows">${slice.rows.map((r, i) => discoverySongRowHtml(r, i, 'peer')).join('')}</div>`;
    if (slice.more) { body += discoveryShowMoreHtml('peers'); }
    acts = `<div class="dpage-acts"><a href="javascript:void(0)" class="dpage-acts-pri" data-dp="peerQueueAll">${escapeHtml(t('dpage.verb.queueAll'))}</a></div>`;
  }
  return `<section class="dpage-col dpage-src-peers" data-source="peers">${discoveryLabelHtml(label)}${acts}${body}</section>`;
}

// ── Explore (the network): reached only through discoveryPanel({ page:
// 'explore' }) until its nav row lands.
function discoveryExploreHtml(res, st) {
  const s = st.sources.network;
  return !s || s.status === 'absent' ? '' : discoveryNetworkHtml(res, s);
}

function discoverySectionHtml(name, title, sub, body) {
  return `<section class="dpage-sec dpage-sec-${name}" data-source="${name}">
    <div class="dpage-sec-h"><span class="dpage-dot"></span><h3>${escapeHtml(title)}</h3><span class="dpage-sub">${escapeHtml(sub.filter(Boolean).join(' · '))}</span></div>
    ${body}
  </section>`;
}

// A section's body while it has nothing to draw: skeleton rows (asking),
// or its one dim line (empty / failed).
function discoveryEmptyHtml(s) {
  if (s.status === 'loading') {
    return `<div class="dpage-rows" aria-busy="true">${discoverySkelHtml('rows', 4)}</div>`;
  }
  const retry = s.status === 'failed' ? ` <a href="javascript:void(0)" data-dp="retry">${escapeHtml(t('dpage.verb.tryAgain'))}</a>` : '';
  return `<div class="dpage-hint">${escapeHtml(discoveryT(s.reason))}${retry}</div>`;
}

// A job badge: its word, what it acts on beyond the song ("album", "every
// album", "what you're missing") and — on the explore page — its sub-line
// ("getting it · 64%"); its bar while it moves. `plain` (the play page:
// connected-server rows and album cards) draws the word and the kind
// alone — "copying · album", "in your collection" — no percentage and no
// count: the numbers stay in the recommendation window.
function discoveryBadgeHtml(b, plain) {
  if (!b) { return ''; }
  const text = [b.tag ? t(b.tag) : '', b.kind ? t(b.kind) : '', plain ? '' : discoveryText(b.sub)].filter(Boolean).join(' · ');
  if (!text) { return ''; }
  const cls = b.tagCls === 'ok' ? 'ok' : (b.tagCls === 'err' ? 'err' : (b.muted ? 'dim' : 'src'));
  return `<span class="dpage-badge dpage-badge-${cls}">${escapeHtml(text)}</span>`;
}

function discoveryProgressHtml(b) {
  if (!b || typeof b.progress !== 'number') { return ''; }
  return `<div class="dpage-prog"><i style="width:${Math.max(0, Math.min(100, b.progress))}%"></i></div>`;
}

// A connected album card's badge: the row's word, without "album" — the
// card is the album (an artist copy still says "every album").
function discoveryCardBadgeHtml(b) {
  const own = b && b.kind === 'discover.tray.kindAlbum' ? Object.assign({}, b, { kind: null }) : b;
  return discoveryBadgeHtml(own, true);
}

// The play page's bar: the same thin line, drawn by a scale so no number
// reads as a percentage anywhere on the page; hidden from screen readers
// (the badge's word says it).
function discoveryThinBarHtml(b) {
  if (!b || typeof b.progress !== 'number') { return ''; }
  const f = Math.max(0, Math.min(100, b.progress)) / 100;
  return `<div class="dpage-prog dpage-prog-thin" aria-hidden="true"><i style="transform:scaleX(${Number(f.toFixed(3))})"></i></div>`;
}

// A lead's tag slot: its job badge, else the network's "new artist".
function discoveryLeadTag(r) {
  const badge = discoveryView.badges.get(r.raw) || null;
  if (badge) { return discoveryBadgeHtml(badge); }
  return r.newArtistLabel ? `<span class="dpage-tag dpage-new">${escapeHtml(discoveryT(r.newArtistLabel))}</span>` : '';
}

// What the recommendation window's match bar names: the seed this row was
// matched against (its seedHash), else the centroid of the seeds (peers).
function discoveryMatchOpts(row) {
  return row && row.matchSeed ? { seedTitle: row.matchSeed } : { seedPlain: t('dpage.match.recent') };
}

// "From the network": metadata-only leads; the row opens its window.
function discoveryNetworkHtml(res, s) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const net = D.networkRows(res);
  const sub = [t('dpage.network.sub'), net.line ? discoveryT(net.line) : ''];
  if (s.status !== 'ready') {
    return discoverySectionHtml('network', t('dpage.network.title'), sub, discoveryEmptyHtml(s));
  }
  const rows = net.rows;
  v.shown.network = rows;
  let body = '';
  const chips = v.plugins && v.plugins.available ? D.pluginChips(v.plugins.list, v.plugins.jobsAllowed) : [];
  if (chips.length) {
    body += `<div class="dpage-plugins"><span>${escapeHtml(t('dpage.network.pluginsOn'))}</span>${chips.map((c) =>
      `<span class="dpage-plugin"><b>${escapeHtml(t(c.key, c.params))}</b> · ${escapeHtml(c.title)}</span>`).join('')}</div>`;
  }
  body += '<div class="dpage-rows">';
  const open = escapeHtml(t('dpage.verb.openLead'));
  rows.forEach((r, i) => {
    const badge = v.badges.get(r.raw) || null;
    const rest = [r.album, r.year == null ? '' : String(r.year), r.onLabel ? discoveryT(r.onLabel) : ''].filter(Boolean).join(' · ');
    body += `<div class="discover-row dpage-row pointer" data-dp="lead" data-i="${i}"${r.because ? ` title="${escapeHtml(discoveryT(r.because))}"` : ''}>
      ${discoveryArtHtml(null)}
      <div class="discover-row-info"><div class="discover-row-title">${escapeHtml(r.title)}</div><div class="discover-row-sub">${escapeHtml(r.artist)}${rest ? `<span class="discover-row-tags">${r.artist ? ' · ' : ''}${escapeHtml(rest)}</span>` : ''}</div><div class="dpage-slot" data-pslot="n${i}">${discoveryProgressHtml(badge)}</div></div>
      <span class="dpage-slot" data-bslot="n${i}">${discoveryLeadTag(r)}</span>
      <span class="dpage-verbs"><button type="button" class="dpage-vb" data-dp="lead" data-i="${i}" title="${open}" aria-label="${open}">${DPAGE_ICONS.open}</button></span>
    </div>`;
  });
  body += `</div><div class="dpage-foot"><span class="dpage-foot-note">${escapeHtml(t('dpage.network.rowOpens'))}</span></div>`;
  return discoverySectionHtml('network', t('dpage.network.title'), sub, body);
}

function onDiscoveryChange(ev) {
  const el = ev.target;
  if (!el || el.getAttribute('data-dp-change') !== 'window') { return; }
  const v = discoveryView;
  const w = Number(el.value);
  if (DISCOVERYPAGE.WINDOWS.indexOf(w) === -1) { return; }
  v.window = w;
  discoverySaveLocalChoice('window');
  redoDiscovery();
}

// Enter on a connected album's card (a div with tabindex, role=link)
// opens it, as a click does; the card's own play button is a real button.
function onDiscoveryKey(ev) {
  const el = ev.target;
  if (ev.key !== 'Enter' || !el || !el.classList || !el.classList.contains('dpage-peer-card')) { return; }
  ev.preventDefault();
  discoveryAction('peerAlbumOpen', el);
}

function onDiscoveryClick(ev) {
  const el = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-dp]') : null;
  if (!el) { return; }
  discoveryAction(el.getAttribute('data-dp'), el);
}

// One row or page action. `el` carries data-i (an index into
// discoveryView.shown) or data-v (a value).
function discoveryAction(act, el) {
  const D = DISCOVERYPAGE;
  const v = discoveryView;
  const i = Number(el.getAttribute('data-i'));
  const val = el.getAttribute('data-v');
  const queued = () => iziToast.success({ title: t('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
  const track = v.shown.tracks[i];
  const lead = v.shown.network[i];
  const peerRow = v.shown.peers[i];
  const peerAlbum = v.shown.peerAlbums[i];
  if (act === 'play' && track) {
    VUEPLAYERCORE.addSongWizard(track.filepath, track.metadata || {}, false, MSTREAMPLAYER.positionCache.val + 1);
  } else if (act === 'queue' && track) {
    VUEPLAYERCORE.addSongWizard(track.filepath, track.metadata || {}, false, undefined, false, true);
    queued();
  } else if (act === 'more' && track) {
    createPopper3(el);
  } else if (act === 'queueAll' || act === 'shuffle') {
    discoveryQueueAll(act === 'shuffle');
  } else if (act === 'save') {
    if (!v.shown.allTracks.length) { return; }
    openSavePlaylistModal(() => v.shown.allTracks.map((r) => r.filepath));
  } else if (act === 'lead' && lead) {
    // the window gives the keyboard back to this control when it closes
    VUEPLAYERCORE.openDiscoverModal(lead.raw, 'p2p', Object.assign({}, discoveryMatchOpts(lead), { opener: el }));
  } else if (act === 'peerPlay' && peerRow && peerRow.playable) {
    // Play now, through this server's federation stream proxy.
    const raw = peerRow.raw;
    VUEPLAYERCORE.addFederationSongWizard(raw.peer || { id: peerRow.peerId, name: peerRow.peerName }, raw.filepath,
      DISCOVERYPAGE.fedQueueMeta(raw), false, MSTREAMPLAYER.positionCache.val + 1, true);
  } else if (act === 'fedQueue' && peerRow && peerRow.playable) {
    // The row itself, or its Add to queue: queued, as a library row is.
    VUEPLAYERCORE.queueDiscoverFed(peerRow.raw);
    queued();
  } else if (act === 'peerMore' && peerRow) {
    // ⋯ opens the connected server's window (Listen, Keep a copy, Find
    // elsewhere), which gives the keyboard back to the ⋯ when it closes.
    VUEPLAYERCORE.openDiscoverModal(peerRow.raw, 'federation', Object.assign({}, discoveryMatchOpts(peerRow), { opener: el }));
  } else if (act === 'peerAlbumMore' && peerAlbum && peerAlbum.raws.length) {
    // The card's ⋯: the same window, read as the album — its best row
    // (raws[0]) carries the album, its credit (albumArtist: a compilation's
    // Album copies it whole, under the key every row of it shares), its
    // artist and a file, so Album is the Keep card's choice. The card's
    // own click still opens peer browse.
    VUEPLAYERCORE.openDiscoverModal(peerAlbum.raws[0], 'federation', Object.assign({}, discoveryMatchOpts(peerAlbum), { focus: 'album', opener: el }));
  } else if (act === 'peerQueueAll') {
    if (!v.shown.allPeers.length) { return; }
    for (const r of v.shown.allPeers) { VUEPLAYERCORE.queueDiscoverFed(r.raw); }
    queued();
  } else if (act === 'peerAlbum' && peerAlbum) {
    discoveryQueuePeerAlbum(peerAlbum);
  } else if (act === 'peerAlbumOpen' && peerAlbum) {
    discoveryOpenPeerAlbum(peerAlbum);
  } else if (act === 'showMore') {
    if (val !== 'library' && val !== 'peers') { return; }
    const all = val === 'library' ? v.shown.allTracks : v.shown.allPeers;
    // where the keyboard goes when this was the last "Show more": the
    // first row it brought in (discoveryFocusFallbacks)
    v.moreFrom = Object.assign({}, v.moreFrom, { [val]: v.more[val] });
    v.more = Object.assign({}, v.more, { [val]: D.pageSlice(all, v.more[val]).next });
    renderDiscovery();
  } else if (act === 'newArtists') {
    v.newArtistsOnly = v.newArtistsOnly !== true;
    discoverySaveLocalChoice('newArtistsOnly');
    redoDiscovery();
  } else if (act === 'refresh') {
    // "New seeds": the same question again — the server draws a new random
    // batch; the answer on screen stays drawn (busy) until it lands.
    redoDiscovery();
  } else if (act === 'retry') {
    redoDiscovery();
  } else if (act === 'peersRetry') {
    redoDiscoveryPeers();
  } else if (act === 'drop') {
    const chip = v.shown.chips[i];
    if (!chip || !chip.hash) { return; }
    discoveryDropSeed(chip.hash);
  } else if (act === 'unpin') {
    const chip = v.shown.chips[i];
    if (!chip) { return; }
    const path = String(chip.filepath || '').replace(/^\/+/, '');
    v.pins = v.pins.filter((p) => p !== path);
    redoDiscovery();
  } else if (act === 'restore') {
    discoveryRestoreSeed(v.shown.excluded[i]);
  } else if (act === 'moods') {
    v.moodsOpen = !v.moodsOpen;
    renderDiscovery();
    discoveryRefocus('[data-dp="moods"]');
  } else if (act === 'mood' || act === 'moodTag' || act === 'moodClear') {
    discoveryPickMood(act, val);
  } else if (act === 'options') {
    v.optionsOpen = !v.optionsOpen;
    renderDiscovery();
    discoveryRefocus('[data-dp="options"]');
  } else if (act === 'editSeeds') {
    v.optionsOpen = true;
    v.allSeeds = true;
    renderDiscovery();
    discoveryRefocus('[data-dp="restore"]', '[data-dp="moreSeeds"]');
  } else if (act === 'moreSeeds') {
    v.allSeeds = !v.allSeeds;
    renderDiscovery();
    discoveryRefocus('[data-dp="moreSeeds"]');
  } else if (act === 'addPlaying') {
    const np = discoveryNowPlayingPath();
    if (!np) {
      iziToast.warning({ title: t('sonicPath.nothingPlaying'), position: 'topCenter', timeout: 2500 });
      return;
    }
    if (v.pins.indexOf(np) === -1) { v.pins.unshift(np); }
    v.nowPlaying = np;
    redoDiscovery();
  } else if (act === 'pick') {
    discoveryPick();
  } else if (act === 'another') {
    // The random fallback is drawn fresh per call: ask again with the picks
    // shown this visit (this one too) in exclude, so a new song comes back.
    const pick = DISCOVERYPAGE.randomPick(discoveryResponse());
    if (pick) { v.passed = DISCOVERYPAGE.passPick(v.passed, pick); }
    redoDiscovery();
  } else if (act === 'browse') {
    changeView(loadFileExplorer, document.querySelector('.side-nav-item[data-panel="fileExplorer"]') || document.querySelector('.side-nav-item'));
  } else if (act === 'admin') {
    window.open('./admin', '_blank');
  }
}

// A connected server's album card: opened in the peer-browse view (the
// app follows the card onto that server, as a federated search hit does;
// Back returns to this visit of the page). Listed as the album copy lists
// it (DISCOVERYPAGE.peerAlbumQuery): by the album's own credit when the
// card has one — a compilation whole — else by the track artist.
function discoveryOpenPeerAlbum(a) {
  if (a.peerId == null) { return; }
  const id = Number(a.peerId);
  if (!knownPeers.has(id)) { rememberPeer({ id, name: a.peerName }); }
  adoptPeer({ getAttribute: (n) => (n === 'data-peer' ? String(id) : null) });
  const q = DISCOVERYPAGE.peerAlbumQuery(a);
  getAlbumSongs(a.album, q.artist, null, q.album_artist || null);
}

// Its play button: the album queued through the federation stream proxy —
// the whole album as the server lists it (peerAlbumQuery, as the card's
// open), else the rows that matched. The app stays on this server.
async function discoveryQueuePeerAlbum(a) {
  if (a.peerId == null) { return; }
  const id = Number(a.peerId);
  const peer = knownPeers.get(id) || rememberPeer({ id, name: a.peerName || 'peer' });
  let songs = null;
  try {
    songs = await MSTREAMAPI.peer.albumSongs(id, DISCOVERYPAGE.peerAlbumQuery(a));
  } catch (_) { /* the matched rows instead */ }
  if (Array.isArray(songs) && songs.length) {
    for (const s of songs) { if (s && s.filepath) { queueRow(peer, s.filepath, s.metadata || {}); } }
  } else {
    for (const raw of a.raws) { VUEPLAYERCORE.queueDiscoverFed(raw); }
  }
  iziToast.success({ title: t('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
}

// A re-render replaces the page's markup: put the keyboard back on the
// control that asked for it (a disclosure toggle, the seeds' more/less).
// Where the keyboard goes when a draw removed its control (else it would
// drop to <body>): after the last "Show more", the first row it brought
// in; otherwise (a state card's button, a dropped chip …) More options.
function discoveryFocusFallbacks(sel) {
  const m = /^\[data-dp="showMore"\]\[data-v="(library|peers)"\]$/.exec(sel);
  const from = m && discoveryView.moreFrom ? discoveryView.moreFrom[m[1]] : undefined;
  const row = m && from != null ? [`[data-dp="${m[1] === 'library' ? 'play' : 'peerPlay'}"][data-i="${from}"]`] : [];
  return [...row, '[data-dp="options"]'];
}

function discoveryRefocus(...sels) {
  for (const sel of sels) {
    // the bar and the picker (#dpage-head), or the page under them
    const el = document.querySelector(`#dpage-head .dpage ${sel}`) || document.querySelector(`#filelist .dpage ${sel}`);
    if (el && typeof el.focus === 'function') { el.focus(); return; }
  }
}

// Drop a history seed for this visit (the next asks exclude it), with an
// Undo on the toast — the chip is one click, and the way back otherwise
// sits under Edit seeds.
function discoveryDropSeed(hash) {
  const v = discoveryView;
  v.excluded = DISCOVERYPAGE.dropSeed(v.excluded, hash);
  redoDiscovery();
  iziToast.show({
    title: escapeHtml(t('dpage.seeds.droppedToast')),
    position: 'topCenter',
    timeout: 5000,
    buttons: [[`<button>${escapeHtml(t('dpage.verb.undo'))}</button>`, (instance, toast) => {
      instance.hide({ transitionOut: 'fadeOut' }, toast, 'button');
      discoveryRestoreSeed({ hash });
    }, true]],
  });
}

// Bring a dropped seed back ("Use again", Undo): out of the visit's list,
// and ask again.
// Only a drop this visit still has: a toast's Undo outlives a fresh open
// (which forgot the drops) and the page itself (no off-screen ask).
function discoveryRestoreSeed(item) {
  const v = discoveryView;
  if (!item || !item.hash || v.excluded.indexOf(item.hash) === -1) { return; }
  v.excluded = DISCOVERYPAGE.restoreSeed(v.excluded, item.hash);
  if (discoveryOnScreen()) { redoDiscovery(); }
}

function discoveryQueueAll(shuffle) {
  const list = discoveryView.shown.allTracks.slice();
  if (!list.length) { return; }
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  for (const r of list) {
    VUEPLAYERCORE.addSongWizard(r.filepath, r.metadata || {}, false, undefined, false, true);
  }
  iziToast.success({ title: t('discover.modal.queued'), position: 'topCenter', timeout: 1800 });
}

// "+ Add a song…" / "Choose a song…": the Sonic Path's picker — the next
// single row click anywhere becomes a pin, then the page comes back.
function discoveryPick() {
  const back = () => changeView(() => discoveryPanel({ keep: true }), document.getElementById('nav-discover'));
  const capture = (song) => {
    sonicPathHideBanner();
    const path = String((song && song.filepath) || '').replace(/^\/+/, '');
    if (path && discoveryView.pins.indexOf(path) === -1) { discoveryView.pins.push(path); }
    back();
  };
  capture.dpage = true;
  VUEPLAYERCORE.songCapture = capture;
  showPickBanner(t('dpage.seeds.pickBanner'), back);
  changeView(loadFileExplorer, document.querySelector('.side-nav-item[data-panel="fileExplorer"]') || document.querySelector('.side-nav-item'));
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
    // Peer tracks stream through the federation proxy: there is no transcode
    // route on the peer, and their URL carries a 'media/' segment this replace
    // would corrupt into an un-allowlisted path. Leave them untouched.
    if (MSTREAMPLAYER.playlist[i].federation) { continue; }
    MSTREAMPLAYER.playlist[i].url = MSTREAMPLAYER.playlist[i].url.replace(a, b);
  }

  // re-enable checkbox
  if (el) { el.disabled = false; }
}

///////////////////////////// Mobile Stuff
async function getMobilePanel(){
  setBrowserRootPanel(t('panel.mobileApps'), false);

  const html = `
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

  document.getElementById('filelist').innerHTML = html;
}

//////////////////////////  Share playlists
async function submitShareForm() {
  // A share serves LOCAL paths to an anonymous visitor with no federation
  // key of their own — there is no way to hand a peer's track through it.
  if (refuseMixedQueue('share.cannotShareMixed')) { return; }
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
// ── Sonic Path panel ────────────────────────────────────────────────────
//
// A standalone view (side-nav, like Auto DJ) over POST
// /api/v1/discovery/local/path: pick a START and an END song, choose a
// length, and the server fills the journey between them. Song pickers use
// a CAPTURE flow — "pick from library" arms VUEPLAYERCORE.songCapture and
// drops the user into the file explorer with a banner; the next song they
// click anywhere (explorer, search, albums) lands in the field instead of
// the queue. "Use playing song" grabs the current track directly.
//
// UX mirrors the mobile app's path screen: preview first — seed rows
// accented, every row wearing the match meter vs its own waypoint — then
// Play (replaces the queue) or + Queue all.

const SONICPATH = {
  view: 'setup',    // 'setup' (pick songs + length) | 'results' (journey)
  start: null,      // { rawFilePath, title, artist, art }
  end: null,
  length: 14,       // server clamps 4..32
  rows: [],         // last built journey (seeds included)
  loading: false,
  notAnalyzedStart: false,
  notAnalyzedEnd: false,
  fetched: false,   // a build has completed (drives the empty-state hint)
};

// The body of a Start/End card. Empty → "Not set" + the two choose
// buttons; chosen → album art (or a placeholder tile), title/artist, and a
// clear ✕ that reverts the card — the choose buttons disappear so a filled
// card reads as a settled decision.
function sonicPathSongCard(side) {
  const s = SONICPATH[side];
  if (!s) {
    return `
      <div class="spath-song"><span class="spath-notset">${t('sonicPath.notSet')}</span></div>
      <div class="spath-field-buttons">
        <button type="button" class="spath-btn" data-spath-playing="${side}">${t('sonicPath.usePlaying')}</button>
        <button type="button" class="spath-btn" data-spath-pick="${side}">${t('sonicPath.pickSong')}</button>
      </div>`;
  }
  const art = s.art
    ? `<img class="spath-art" loading="lazy" src="${MSTREAMAPI.currentServer.host}album-art/${encodeURIComponent(s.art)}?compress=s&token=${MSTREAMAPI.currentServer.token}">`
    : `<div class="spath-art spath-art-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#777"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;
  return `
    <div class="spath-chosen">
      ${art}
      <div class="spath-chosen-info">
        <span class="spath-song-title">${escapeHtml(s.title)}</span>
        ${s.artist ? `<span class="spath-song-artist">${escapeHtml(s.artist)}</span>` : ''}
      </div>
      <span class="spath-clear pointer" data-spath-clear="${side}" title="${t('sonicPath.clear')}">&#10005;</span>
    </div>`;
}

function sonicPathBanner(side) {
  showPickBanner(t(side === 'start' ? 'sonicPath.pickBannerStart' : 'sonicPath.pickBannerEnd'),
    () => changeView(sonicPathPanel, document.getElementById('nav-sonic-path')));
}

// The song pickers' banner (Sonic Path, the Discover page's "+ Add a
// song…"): the next song click is captured; Cancel drops the capture and
// runs onCancel (back to the picker's panel).
function showPickBanner(text, onCancel) {
  let el = document.getElementById('spath-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'spath-banner';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${escapeHtml(text)}</span><span class="spath-banner-cancel pointer">${escapeHtml(t('sonicPath.cancelPick'))}</span>`;
  el.querySelector('.spath-banner-cancel').addEventListener('click', () => {
    VUEPLAYERCORE.songCapture = null;
    sonicPathHideBanner();
    onCancel();
  });
}

function sonicPathHideBanner() {
  document.getElementById('spath-banner')?.remove();
}

function sonicPathPick(side) {
  VUEPLAYERCORE.songCapture = async (song) => {
    sonicPathHideBanner();
    // Row clicks carry no inline metadata (the file browser passes none) —
    // resolve the real title/artist so the field doesn't read as a
    // filename. Lookup failure falls back to the filename.
    let meta = song.metadata || {};
    if (!meta.title) {
      try {
        const response = await MSTREAMAPI.lookupMetadata(song.filepath);
        if (response && response.metadata) { meta = response.metadata; }
      } catch (_err) { /* filename fallback below */ }
    }
    SONICPATH[side] = {
      rawFilePath: song.filepath,
      title: meta.title || song.filepath.split('/').pop(),
      artist: meta.artist || '',
      art: meta['album-art'] || null,
    };
    changeView(sonicPathPanel, document.getElementById('nav-sonic-path'));
  };
  sonicPathBanner(side);
  // Drop the user somewhere clickable; the capture works from ANY view
  // (search, albums…) — the explorer is just a sane starting point.
  changeView(loadFileExplorer, document.querySelector('.side-nav-item'));
}

async function sonicPathUsePlaying(side) {
  const song = MSTREAMPLAYER.getCurrentSong();
  if (!song || !song.rawFilePath) {
    iziToast.warning({ title: t('sonicPath.nothingPlaying'), position: 'topCenter', timeout: 2500 });
    return;
  }
  if (song.federation) {
    // Peer-namespace paths can't seed the local index.
    iziToast.warning({ title: t('sonicPath.federatedTrack'), position: 'topCenter', timeout: 3000 });
    return;
  }
  // A just-queued track's async metadata lookup may not have landed yet
  // (addSongWizard fills it in the background) — resolve it here the same
  // way the picker does, so the card never shows a bare filename.
  let meta = song.metadata || {};
  if (!meta.title) {
    try {
      const response = await MSTREAMAPI.lookupMetadata(song.rawFilePath);
      if (response && response.metadata) { meta = response.metadata; }
    } catch (_err) { /* filename fallback below */ }
  }
  SONICPATH[side] = {
    rawFilePath: song.rawFilePath,
    title: meta.title || song.rawFilePath.split('/').pop(),
    artist: meta.artist || '',
    art: meta['album-art'] || null,
  };
  sonicPathPanel();
}

async function sonicPathBuild() {
  if (!SONICPATH.start || !SONICPATH.end || SONICPATH.loading) { return; }
  SONICPATH.view = 'results';
  SONICPATH.loading = true;
  SONICPATH.rows = [];
  SONICPATH.notAnalyzedStart = false;
  SONICPATH.notAnalyzedEnd = false;
  sonicPathPanel();

  const strip = (v) => (v.charAt(0) === '/' ? v.substr(1) : v);
  const res = await MSTREAMAPI.discoveryPath(
    strip(SONICPATH.start.rawFilePath), strip(SONICPATH.end.rawFilePath), SONICPATH.length);

  SONICPATH.loading = false;
  SONICPATH.fetched = true;
  if (res && res.disabled) {
    // 403 — the flag was stale; retract the whole panel for the session.
    document.getElementById('nav-sonic-path').classList.add('super-hide');
    iziToast.error({ title: t('sonicPath.disabled'), position: 'topCenter', timeout: 3500 });
    return;
  }
  if (!res) {
    iziToast.error({ title: t('sonicPath.failed'), position: 'topCenter', timeout: 3000 });
    sonicPathPanel();
    return;
  }
  SONICPATH.notAnalyzedStart = !!(res.notAnalyzed && res.notAnalyzed.start);
  SONICPATH.notAnalyzedEnd = !!(res.notAnalyzed && res.notAnalyzed.end);
  SONICPATH.rows = res.results || [];
  sonicPathPanel();
}

function sonicPathPlay(replaceQueue) {
  if (!SONICPATH.rows.length) { return; }
  if (replaceQueue) { MSTREAMPLAYER.clearPlaylist(); }
  for (const row of SONICPATH.rows) {
    VUEPLAYERCORE.addSongWizard(row.filepath, row.metadata || {}, false, undefined, false, true);
  }
}

// The name-a-playlist modal (#savePlaylistModal) shared by the Sonic Path
// and the Discover page: `getPaths` answers the songs at submit time.
let savePlaylistModalPaths = null;
function openSavePlaylistModal(getPaths) {
  savePlaylistModalPaths = getPaths;
  document.getElementById('save_playlist_name').value = '';
  myModal.open('#savePlaylistModal');
}

async function savePlaylistFromModal() {
  const title = document.getElementById('save_playlist_name').value;
  const paths = typeof savePlaylistModalPaths === 'function' ? savePlaylistModalPaths() : [];
  if (!title || !paths.length) { return; }
  try {
    await MSTREAMAPI.savePlaylist(title, paths);
    myModal.close();
    iziToast.success({ title: t('sonicPath.playlistSaved'), message: escapeHtml(title), position: 'topCenter', timeout: 2500 });
  } catch (_err) {
    iziToast.error({ title: t('sonicPath.playlistSaveFailed'), position: 'topCenter', timeout: 3000 });
  }
}

// "Start over" — the panel's escape hatch back to a pristine setup view:
// fields cleared, length back to default, results dropped.
function sonicPathStartOver() {
  SONICPATH.view = 'setup';
  SONICPATH.start = null;
  SONICPATH.end = null;
  SONICPATH.length = 14;
  SONICPATH.rows = [];
  SONICPATH.loading = false;
  SONICPATH.notAnalyzedStart = false;
  SONICPATH.notAnalyzedEnd = false;
  SONICPATH.fetched = false;
  sonicPathPanel();
}

function sonicPathPanel() {
  setBrowserRootPanel(t('sonicPath.title'), false);
  sonicPathHideBanner();

  const tags = (row) => {
    if (!row.genreTags || !row.genreTags.length) { return ''; }
    const label = row.genreTags.slice(0, 2).map((x) => x.split('---').pop()).join(' · ');
    return ` &middot; ${escapeHtml(label)}`;
  };

  const lengthRow = (withRegen) => `
    <div class="spath-length-row">
      <span class="autodj-opt-label">${t('sonicPath.length')}</span>
      <input type="range" id="spath-length" min="4" max="32" step="1" value="${SONICPATH.length}">
      <span class="spath-length-value" id="spath-length-value">${SONICPATH.length}</span>
      ${withRegen ? `<button type="button" class="spath-btn" id="spath-regen" ${SONICPATH.loading ? 'disabled' : ''}>${t('sonicPath.regenerate')}</button>` : ''}
    </div>`;

  let html;
  if (SONICPATH.view === 'setup') {
    // ── Stage 1: pick the songs and a length ──
    const field = (side, labelKey) => `
      <div class="spath-field">
        <div class="autodj-opt-label">${t(labelKey)}</div>
        ${sonicPathSongCard(side)}
      </div>`;
    html = `
      <div class="spath-panel">
        <div class="spath-hint">${t('sonicPath.hint')}</div>
        <div class="spath-fields">
          ${field('start', 'sonicPath.startSong')}
          <div class="spath-arrow">&#8595;</div>
          ${field('end', 'sonicPath.endSong')}
        </div>
        ${lengthRow(false)}
        <button type="button" class="spath-btn spath-btn-primary spath-build" id="spath-build"
                ${SONICPATH.start && SONICPATH.end ? '' : 'disabled'}>${t('sonicPath.build')}</button>
      </div>`;
  } else {
    // ── Stage 2: the journey — setup cleared away, list + actions in its
    // place. The length slider stays so tweak → Regenerate is a tight
    // loop; Start over is the way back to stage 1.
    let results = '';
    if (SONICPATH.loading) {
      results = `<div class="discover-hint">${t('sonicPath.loading')}</div>`;
    } else if (SONICPATH.notAnalyzedStart) {
      results = `<div class="discover-hint">${t('sonicPath.startNotAnalyzed')}</div>`;
    } else if (SONICPATH.notAnalyzedEnd) {
      results = `<div class="discover-hint">${t('sonicPath.endNotAnalyzed')}</div>`;
    } else if (SONICPATH.rows.length) {
      const last = SONICPATH.rows.length - 1;
      results = `
        <div class="discover-rows spath-rows">
          ${SONICPATH.rows.map((row, i) => `
            <div class="discover-row pointer${i === 0 || i === last ? ' discover-path-seed' : ''}"
                 data-spath-row="${i}" title="${Math.round(row.similarity * 100)}% on-path — add to queue">
              ${row.metadata && row.metadata['album-art']
                ? `<img class="spath-row-art" loading="lazy" src="${MSTREAMAPI.currentServer.host}album-art/${encodeURIComponent(row.metadata['album-art'])}?compress=s&token=${MSTREAMAPI.currentServer.token}">`
                : `<div class="spath-row-art spath-art-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="#777"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`}
              <div class="discover-row-info">
                <div class="discover-row-title">${escapeHtml((row.metadata && row.metadata.title) || row.filepath.split('/').pop())}</div>
                <div class="discover-row-sub">${escapeHtml((row.metadata && row.metadata.artist) || '')}${tags(row)}</div>
              </div>
              <div class="discover-add"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M13 11h8v2h-8v8h-2v-8H3v-2h8V3h2v8z"/></svg></div>
            </div>`).join('')}
        </div>`;
    } else if (SONICPATH.fetched) {
      results = `<div class="discover-hint">${t('sonicPath.none')}</div>`;
    }

    const hasRows = !SONICPATH.loading && SONICPATH.rows.length > 0;
    html = `
      <div class="spath-panel">
        <div class="spath-context">${escapeHtml(SONICPATH.start?.title || '')} <span class="spath-arrow-inline">&#8594;</span> ${escapeHtml(SONICPATH.end?.title || '')}</div>
        <div class="spath-actions">
          ${hasRows ? `
            <button type="button" class="spath-btn spath-btn-primary" id="spath-play">${t('sonicPath.play')}</button>
            <button type="button" class="spath-btn" id="spath-queue">${t('discover.queueAll')}</button>
            <button type="button" class="spath-btn" id="spath-save">${t('sonicPath.saveAsPlaylist')}</button>` : ''}
          <button type="button" class="spath-btn spath-startover" id="spath-startover">${t('sonicPath.startOver')}</button>
        </div>
        ${lengthRow(true)}
        ${results}
      </div>`;
  }

  const root = document.getElementById('filelist');
  root.innerHTML = html;

  root.querySelectorAll('[data-spath-pick]').forEach((el) => {
    el.addEventListener('click', () => sonicPathPick(el.getAttribute('data-spath-pick')));
  });
  root.querySelectorAll('[data-spath-playing]').forEach((el) => {
    el.addEventListener('click', () => sonicPathUsePlaying(el.getAttribute('data-spath-playing')));
  });
  root.querySelectorAll('[data-spath-clear]').forEach((el) => {
    el.addEventListener('click', () => {
      SONICPATH[el.getAttribute('data-spath-clear')] = null;
      sonicPathPanel();
    });
  });
  const lengthEl = document.getElementById('spath-length');
  lengthEl.addEventListener('input', () => {
    SONICPATH.length = Number(lengthEl.value);
    document.getElementById('spath-length-value').textContent = lengthEl.value;
  });
  document.getElementById('spath-build')?.addEventListener('click', sonicPathBuild);
  document.getElementById('spath-regen')?.addEventListener('click', sonicPathBuild);
  document.getElementById('spath-startover')?.addEventListener('click', sonicPathStartOver);
  document.getElementById('spath-play')?.addEventListener('click', () => sonicPathPlay(true));
  document.getElementById('spath-queue')?.addEventListener('click', () => sonicPathPlay(false));
  document.getElementById('spath-save')?.addEventListener('click', () => {
    openSavePlaylistModal(() => SONICPATH.rows.map((row) => row.filepath));
  });
  root.querySelectorAll('[data-spath-row]').forEach((el) => {
    el.addEventListener('click', () => {
      const row = SONICPATH.rows[Number(el.getAttribute('data-spath-row'))];
      if (row) { VUEPLAYERCORE.addSongWizard(row.filepath, row.metadata || {}, false, undefined, false, true); }
    });
  });
}

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

  // ── Track-length window ────────────────────────────────────────
  //
  // Toggle + two bounds + an unknown-length switch. AUTODJ stores
  // SECONDS (wire units); the inputs are MINUTES because that's how
  // people think about track length, and the handlers convert at the
  // edge (Math.round(minutes * 60), so 0.5 → 30s).
  //
  // `step="any"` rather than a fixed grid: the conversion accepts any
  // decimal, so a grid would mark perfectly valid entries like 1.25 or
  // 0.1 as :invalid — asserting a constraint the code doesn't have,
  // and one that would start rendering as an error the moment anything
  // styles :invalid. The spinner arrows are hidden in CSS, so there is
  // no stepping affordance a grid would serve anyway.
  //
  // An empty / 0 field means "no bound on this side", so a user can
  // set only a floor or only a ceiling. Both empty is a no-op even
  // with the toggle on — same "toggled on but nothing entered yet"
  // grace the keyword and genre filters give.
  //
  // The unknown-length switch maps to the server's
  // allowUnknownDuration. Default off = tracks the scanner never read
  // a length from are excluded, which is the strict reading of the
  // window; on = they ride along. Worth surfacing because a partially
  // scanned library can otherwise lose far more of the pool than the
  // user expects.
  //
  // It reuses the panel-wide `.toggle-sw` switch (text left, control
  // right) rather than a native checkbox: every other on/off control
  // in this panel is that switch, and .toggle-sw already carries the
  // Materialize suppression a bare checkbox would need to re-solve.
  // Like the other .toggle-sw rows the caption is a sibling div, not
  // a wrapping <label>, so the input gets aria-labelledby.
  const _secToMin = (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) { return ''; }
    // Trim the float tail: 150s → 2.5, 120s → 2 (not 2.0).
    return String(Math.round((n / 60) * 100) / 100);
  };
  const durationOn = AUTODJ.state.djDurationEnabled;
  const durationFilterRow = `
    <div class="autodj-opt-row autodj-opt-col">
      <div class="dj-filter-head">
        <div>
          <div class="autodj-opt-label" id="dj-duration-label">${t('autoDJ.durationFilterLabel')}</div>
          <div class="autodj-opt-hint">${t('autoDJ.durationFilterHint')}</div>
        </div>
        <label class="toggle-sw">
          <input type="checkbox" id="dj-duration-on" aria-labelledby="dj-duration-label" ${durationOn ? 'checked' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
      <div class="dj-duration-inputs">
        <label class="dj-duration-field">
          <span class="dj-duration-field-label">${t('autoDJ.durationMinLabel')}</span>
          <input
            type="number"
            class="dj-filter-input dj-duration-num"
            id="dj-duration-min"
            min="0" max="1440" step="any"
            placeholder="${escapeHtml(t('autoDJ.durationNoLimit'))}"
            value="${escapeHtml(_secToMin(AUTODJ.state.djMinDuration))}"
            ${durationOn ? '' : 'disabled'}
            aria-label="${escapeHtml(t('autoDJ.durationMinInputLabel'))}">
        </label>
        <label class="dj-duration-field">
          <span class="dj-duration-field-label">${t('autoDJ.durationMaxLabel')}</span>
          <input
            type="number"
            class="dj-filter-input dj-duration-num"
            id="dj-duration-max"
            min="0" max="1440" step="any"
            placeholder="${escapeHtml(t('autoDJ.durationNoLimit'))}"
            value="${escapeHtml(_secToMin(AUTODJ.state.djMaxDuration))}"
            ${durationOn ? '' : 'disabled'}
            aria-label="${escapeHtml(t('autoDJ.durationMaxInputLabel'))}">
        </label>
      </div>
      <div class="dj-duration-unknown">
        <div>
          <div class="dj-duration-unknown-label" id="dj-duration-unknown-label">${t('autoDJ.durationUnknownLabel')}</div>
          <div class="autodj-opt-hint">${t('autoDJ.durationUnknownHint')}</div>
        </div>
        <label class="toggle-sw">
          <input type="checkbox" id="dj-duration-unknown" aria-labelledby="dj-duration-unknown-label" ${AUTODJ.state.djAllowUnknownDuration ? 'checked' : ''} ${durationOn ? '' : 'disabled'}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
    </div>`;

  // ── Sonic similarity (discovery embeddings) ─────────────────────
  //
  // Server capability comes from the ping response (same flag that
  // gates the Discover panel). When absent the section renders
  // disabled with an explanatory hint — same treatment as the
  // similar-artists row without a Last.fm key.
  //
  // The slider stores the RAW cosine threshold (0.30–0.90); the hint
  // translates it to a perceptual word + percentage so users don't
  // need to know what cosine similarity is.
  const discoveryAvailable = MSTREAMAPI.currentServer.discovery === true;
  const sonicOn = AUTODJ.state.sonicEnabled && discoveryAvailable;
  const sonicSeed = AUTODJ.getSonicSeed();
  const anchorMode = AUTODJ.state.sonicAnchorMode;
  function _sonicSimHint(cos) {
    const pct = Math.round(cos * 100);
    let word = t('autoDJ.sonicSimLockedIn');
    if (cos < 0.45)      { word = t('autoDJ.sonicSimAdventurous'); }
    else if (cos < 0.6)  { word = t('autoDJ.sonicSimBalanced'); }
    else if (cos < 0.75) { word = t('autoDJ.sonicSimFocused'); }
    return t('autoDJ.sonicSimValue', { word, pct });
  }
  const sonicSeedChip = sonicSeed ? `
    <span class="dj-filter-tag" role="listitem">
      ${escapeHtml(sonicSeed.title)}<button type="button" class="dj-filter-tag-rm" id="dj-sonic-seed-rm" aria-label="${escapeHtml(t('autoDJ.sonicSeedRemove'))}">×</button>
    </span>` : `<span class="autodj-opt-hint">${t('autoDJ.sonicSeedNone')}</span>`;
  const sonicBlock = `
    <h4 class="autodj-section-heading">${t('autoDJ.sectionSonic')}</h4>
    <div class="autodj-opt-row${discoveryAvailable ? '' : ' autodj-opt-disabled'}">
      <div>
        <div class="autodj-opt-label" id="dj-sonic-label">${t('autoDJ.sonicLabel')}</div>
        <div class="autodj-opt-hint">${discoveryAvailable ? t('autoDJ.sonicHint') : '<em>' + t('autoDJ.sonicHintNoDiscovery') + '</em>'}</div>
      </div>
      <label class="toggle-sw">
        <input type="checkbox" id="dj-sonic-on" aria-labelledby="dj-sonic-label" ${sonicOn ? 'checked' : ''} ${discoveryAvailable ? '' : 'disabled'}>
        <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
      </label>
    </div>
    <div id="dj-sonic-opts" style="${sonicOn ? '' : 'display:none'}">
      <div class="autodj-opt-row">
        <div>
          <div class="autodj-opt-label" id="dj-sonic-sim-label">${t('autoDJ.sonicSimilarityLabel')}</div>
          <div class="autodj-opt-hint" id="dj-sonic-sim-val">${_sonicSimHint(AUTODJ.state.sonicMinSimilarity)}</div>
        </div>
        <input type="range" id="dj-sonic-sim" class="autodj-slider" min="30" max="90" step="1" value="${Math.round(AUTODJ.state.sonicMinSimilarity * 100)}" aria-labelledby="dj-sonic-sim-label" aria-valuemin="30" aria-valuemax="90" aria-valuenow="${Math.round(AUTODJ.state.sonicMinSimilarity * 100)}">
      </div>
      <div class="autodj-opt-row">
        <div>
          <div class="autodj-opt-label">${t('autoDJ.sonicAnchorLabel')}</div>
          <div class="autodj-opt-hint" id="dj-sonic-anchor-hint">${t(anchorMode === 'locked' ? 'autoDJ.sonicAnchorLockedHint' : 'autoDJ.sonicAnchorRollingHint')}</div>
        </div>
        <div class="dj-genre-mode" role="radiogroup" aria-label="${escapeHtml(t('autoDJ.sonicAnchorLabel'))}">
          <button type="button" class="dj-genre-mode-btn dj-sonic-anchor-btn" data-anchor="rolling" aria-pressed="${anchorMode === 'rolling'}">${t('autoDJ.sonicAnchorRolling')}</button>
          <button type="button" class="dj-genre-mode-btn dj-sonic-anchor-btn" data-anchor="locked" aria-pressed="${anchorMode === 'locked'}">${t('autoDJ.sonicAnchorLocked')}</button>
        </div>
      </div>
      ${MSTREAMAPI.currentServer.federationBrowse === true ? `
      <div class="autodj-opt-row">
        <div>
          <div class="autodj-opt-label" id="dj-federated-label">${t('autoDJ.federatedLabel')}</div>
          <div class="autodj-opt-hint">${t('autoDJ.federatedHint')}</div>
        </div>
        <label class="toggle-sw">
          <input type="checkbox" id="dj-federated-on" aria-labelledby="dj-federated-label" ${AUTODJ.state.federatedEnabled ? 'checked' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>` : ''}
      <div class="autodj-opt-row autodj-opt-col">
        <div>
          <div class="autodj-opt-label">${t('autoDJ.sonicSeedLabel')}</div>
          <div class="autodj-opt-hint">${t('autoDJ.sonicSeedHint')}</div>
        </div>
        <div class="dj-filter-tags" id="dj-sonic-seed-tag" role="list" aria-label="${escapeHtml(t('autoDJ.sonicSeedLabel'))}">${sonicSeedChip}</div>
        <div class="dj-genre-combo">
          <input
            type="text"
            class="dj-filter-input"
            id="dj-sonic-seed-input"
            placeholder="${escapeHtml(t('autoDJ.sonicSeedPlaceholder'))}"
            autocomplete="off"
            aria-autocomplete="list"
            aria-controls="dj-sonic-seed-suggest"
            aria-label="${escapeHtml(t('autoDJ.sonicSeedLabel'))}">
          <div class="dj-genre-suggest" id="dj-sonic-seed-suggest" role="listbox" hidden></div>
        </div>
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

        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label" id="dj-limit-label">${t('autoDJ.limitLabel')}</div>
            <div class="autodj-opt-hint">${t('autoDJ.limitHint', { max: AUTODJ.LIMIT_MAX })}</div>
          </div>
          <input
            type="number"
            class="autodj-select browser-default dj-limit-num"
            id="dj-limit"
            min="1" max="${AUTODJ.LIMIT_MAX}" step="1" inputmode="numeric"
            value="${AUTODJ.state.djLimit}"
            aria-labelledby="dj-limit-label">
        </div>

        <h4 class="autodj-section-heading">${t('autoDJ.sectionContinuity')}</h4>
        ${similarRow}
        ${bpmContinuityRow}
        ${bpmToleranceRow}
        ${harmonicRow}

        ${sonicBlock}

        <h4 class="autodj-section-heading">${t('autoDJ.sectionFilters')}</h4>
        ${keywordFilterRow}
        ${genreFilterRow}
        ${durationFilterRow}
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

  // Songs per fetch. `change` (blur / Enter), not `input`, so "12" isn't
  // clamped the moment the user types "1". AUTODJ owns the integer +
  // range rule and hands back what it stored, which is written into the
  // field so it always shows what the next request will send.
  const limitEl = document.getElementById('dj-limit');
  limitEl.onchange = () => { limitEl.value = AUTODJ.setLimit(limitEl.value); };

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

  // ── Sonic similarity ───────────────────────────────────────────
  //
  // Toggle shows/hides the sub-options and clears the per-session
  // anchors on OFF (same semantics as BPM/harmonic: re-enabling
  // should re-anchor on whatever's playing then). The explicit seed
  // survives the toggle.
  const sonicOnEl = document.getElementById('dj-sonic-on');
  if (sonicOnEl && !sonicOnEl.disabled) {
    sonicOnEl.onchange = (e) => {
      const on = !!e.target.checked;
      AUTODJ.setState({ sonicEnabled: on });
      if (!on) { AUTODJ.clearSonicAnchors(); }
      document.getElementById('dj-sonic-opts').style.display = on ? '' : 'none';
    };
  }

  // Similarity slider — stores the raw cosine; hint shows the
  // perceptual word + percentage.
  const sonicSimEl = document.getElementById('dj-sonic-sim');
  if (sonicSimEl) {
    sonicSimEl.oninput = (e) => {
      const val = Math.max(30, Math.min(90, parseInt(e.target.value, 10))) / 100;
      AUTODJ.setState({ sonicMinSimilarity: val });
      document.getElementById('dj-sonic-sim-val').textContent = _sonicSimHint(val);
      e.target.setAttribute('aria-valuenow', String(Math.round(val * 100)));
    };
  }

  // Anchor mode segmented control. Switching modes drops the pinned
  // locked-anchor so 'locked' re-pins fresh on the next pick.
  document.querySelectorAll('.dj-sonic-anchor-btn').forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.anchor;
      AUTODJ.setState({ sonicAnchorMode: mode, sonicLockedAnchor: null });
      document.querySelectorAll('.dj-sonic-anchor-btn').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.anchor === mode ? 'true' : 'false');
      });
      document.getElementById('dj-sonic-anchor-hint').textContent =
        t(mode === 'locked' ? 'autoDJ.sonicAnchorLockedHint' : 'autoDJ.sonicAnchorRollingHint');
    };
  });

  // Federated session toggle — present only when the server advertises
  // federationBrowse (rendered inside the sonic block, so it is already
  // gated on sonic being on). A pure preference: the player decides per
  // pick whether a cross-server pick can actually run.
  const fedOnEl = document.getElementById('dj-federated-on');
  if (fedOnEl) {
    fedOnEl.onchange = (e) => { AUTODJ.setState({ federatedEnabled: !!e.target.checked }); };
  }

  // Seed picker — title search against /api/v1/db/search (titles
  // only), debounced; picking a result stores the seed and, if
  // Auto-DJ is already running against an empty queue (the "enabled
  // sonic on an empty queue" flow), kicks the stalled session into
  // its first pick.
  const sonicSeedTagEl = document.getElementById('dj-sonic-seed-tag');
  const sonicSeedInpEl = document.getElementById('dj-sonic-seed-input');
  const sonicSeedSugEl = document.getElementById('dj-sonic-seed-suggest');
  function _renderSonicSeedChip() {
    const seed = AUTODJ.getSonicSeed();
    sonicSeedTagEl.innerHTML = seed ? `
      <span class="dj-filter-tag" role="listitem">
        ${escapeHtml(seed.title)}<button type="button" class="dj-filter-tag-rm" id="dj-sonic-seed-rm" aria-label="${escapeHtml(t('autoDJ.sonicSeedRemove'))}">×</button>
      </span>` : `<span class="autodj-opt-hint">${t('autoDJ.sonicSeedNone')}</span>`;
  }
  // Chip remove — delegated so the re-rendered chip stays wired.
  if (sonicSeedTagEl) {
    sonicSeedTagEl.addEventListener('click', (e) => {
      if (e.target.closest('#dj-sonic-seed-rm')) {
        AUTODJ.clearSonicSeed();
        _renderSonicSeedChip();
      }
    }, { signal: _autoDjPanelSignal });
  }
  let _sonicSeedDebounce = null;
  if (sonicSeedInpEl) {
    sonicSeedInpEl.addEventListener('input', () => {
      clearTimeout(_sonicSeedDebounce);
      const q = sonicSeedInpEl.value.trim();
      if (q.length < 2) { sonicSeedSugEl.hidden = true; return; }
      _sonicSeedDebounce = setTimeout(async () => {
        let hits = [];
        try {
          const res = await MSTREAMAPI.search({
            search: q, noArtists: true, noAlbums: true, noFiles: true, noLyrics: true,
          });
          hits = (res.title || []).slice(0, 8);
        } catch (err) {
          console.error('sonic seed search failed', err);
        }
        if (hits.length === 0) { sonicSeedSugEl.hidden = true; return; }
        sonicSeedSugEl.innerHTML = hits.map(h => `
          <div class="dj-genre-suggest-row" role="option"
               data-filepath="${escapeHtml(h.filepath)}"
               data-title="${escapeHtml(h.name)}${h.metadata && h.metadata.artist ? escapeHtml(' — ' + h.metadata.artist) : ''}">
            ${escapeHtml(h.name)}${h.metadata && h.metadata.artist ? ` <small>${escapeHtml(h.metadata.artist)}</small>` : ''}
          </div>`).join('');
        sonicSeedSugEl.hidden = false;
      }, 300);
    }, { signal: _autoDjPanelSignal });
    sonicSeedInpEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { sonicSeedSugEl.hidden = true; }
    }, { signal: _autoDjPanelSignal });
  }
  if (sonicSeedSugEl) {
    sonicSeedSugEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dj-genre-suggest-row');
      if (!item) { return; }
      AUTODJ.setSonicSeed(item.dataset.filepath, item.dataset.title);
      _renderSonicSeedChip();
      sonicSeedInpEl.value = '';
      sonicSeedSugEl.hidden = true;
      // The "enabled Auto-DJ on an empty queue" flow ends here: the
      // seed just arrived, so nudge the stalled session into picking.
      MSTREAMPLAYER.autoDjKick();
    }, { signal: _autoDjPanelSignal });
  }

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

  // ── Track-length window ────────────────────────────────────────
  //
  // Four controls. The inputs are MINUTES and AUTODJ stores SECONDS,
  // so this layer converts and AUTODJ.setDurationBounds does the
  // clamping + backwards-window repair (it owns those rules so they
  // hold for any caller, not just this panel).
  const durOnEl      = document.getElementById('dj-duration-on');
  const durMinEl     = document.getElementById('dj-duration-min');
  const durMaxEl     = document.getElementById('dj-duration-max');
  const durUnknownEl = document.getElementById('dj-duration-unknown');

  // Minutes (as typed) → seconds. A blank field gives Number('') === 0,
  // which is exactly the "no bound on this side" sentinel; the guard
  // makes that intentional rather than incidental and also absorbs a
  // typed '-' or 'e'.
  function _minutesToSeconds(raw) {
    const mins = Number(raw);
    if (!Number.isFinite(mins) || mins <= 0) { return 0; }
    return Math.round(mins * 60);
  }

  // `edited` names the side the user just changed — setDurationBounds
  // keeps that one and pushes the other, so the repair never fights
  // the field being typed in. Persisted values are written back so the
  // inputs always show what the next request will actually send.
  function _commitDuration(edited) {
    const { min, max } = AUTODJ.setDurationBounds(
      _minutesToSeconds(durMinEl.value),
      _minutesToSeconds(durMaxEl.value),
      edited === 'max' ? 'max' : 'min',
    );
    durMinEl.value = _secToMin(min);
    durMaxEl.value = _secToMin(max);
  }

  // Toggle gates the three inputs. The bounds survive toggling so the
  // user can flip the feature off and back on without re-entering
  // them — same contract the keyword and genre filters give.
  durOnEl.onchange = (e) => {
    const on = !!e.target.checked;
    AUTODJ.setState({ djDurationEnabled: on });
    durMinEl.disabled = !on;
    durMaxEl.disabled = !on;
    durUnknownEl.disabled = !on;
  };

  // `change` (not `input`) so the commit fires on blur / Enter rather
  // than mid-typing — otherwise "12" would clamp-and-rewrite the
  // moment the user typed "1".
  durMinEl.onchange = () => { _commitDuration('min'); };
  durMaxEl.onchange = () => { _commitDuration('max'); };

  durUnknownEl.onchange = (e) => {
    AUTODJ.setState({ djAllowUnknownDuration: !!e.target.checked });
  };

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
        filelist += renderAlbum(x.name, x.name === null ? x.artist : null, albumString, x.album_art_file, x.year, x.album_artist, x.artist_line, x.compilation);
      } else if (x.type === 'artist') {
        filelist += renderArtist(x.name);
      } else if (x.type === 'genre') {
        filelist += renderGenre(x.name, x.track_count, x.source);
      } else {
        if (programState[programState.length - 1].state === 'playlist') {
          filelist += renderFileWithMetadataHtml(x.filepath, x.lokiId, x.metadata);
        } else if (x.type == "m3u") {
          filelist += createFileplaylistHtml(x.name);
        } else {
          // Replay the args the panel itself passed to createMusicFileHtml.
          // Deriving the path here (getFileExplorerPath() + x.name) only ever
          // held for the file explorer, and silently rewrote every DB-panel
          // row's data-file_location to a path that does not exist.
          filelist += createMusicFileHtml(x.path, x.title, x.aa, x.rating, x.subtitle);
        }
      }
    }
  });

  document.getElementById('filelist').innerHTML= filelist;
  // The rows drew their marks as known; the ones not looked up yet are
  // watched for again.
  browseKeepObserve();
}

//////////////////////// Search
const searchToggles = (() => {
  const defaults = { albums: true, artists: true, files: false, titles: true, lyrics: true, federated: false };
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
    func: 'searchFileClick'
  },
  title: {
    name: 'Song',
    class: 'filez',
    data: 'file_location',
    func: 'searchFileClick'
  },
  lyrics: {
    name: 'Lyrics',
    class: 'filez',
    data: 'file_location',
    func: 'searchFileClick'
  }
};

function setupSearchPanel(searchTerm) {
  setBrowserRootPanel(t('panel.searchDB'));
  document.getElementById('local_search_btn').style.display = 'none';
  programState = [{ state: 'searchPanel' }];

  let valString = '';
  // escapeHtml matters: searchTerm is the user's PREVIOUS query replayed
  // on back-navigation — a quote in it would otherwise break out of the
  // value attribute (broken input at best, self-XSS at worst).
  if (searchTerm) { valString = `value="${escapeHtml(searchTerm)}"`; }

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
    ${federatedSearchOffered() ? `<div class="flex">
      <label class="grow" for="search-federated">
        <input ${(searchToggles.federated === true ? 'checked' : '')} id="search-federated" class="filled-in" type="checkbox">
        <span>${escapeHtml(t('search.federated'))}</span>
      </label>
    </div>` : ''}
    <div id="search-results"></div>`;

  document.getElementById('search_folders').value = '';
  document.getElementById('search_folders').dispatchEvent(new Event('change'));
  browseKeepDrawn();

  if (searchTerm) {
    submitSearchForm();
  }
}

// The multi-server search is offered only while pointed at THIS server:
// asking a peer to search its peers is not something federation does (and
// the proxy is deliberately not chainable), so from a federated server the
// search box searches that server alone.
function federatedSearchOffered() {
  return MSTREAMAPI.currentServer.federationBrowse === true && !peerContext;
}

async function submitSearchForm() {
  // A new search supersedes any in-flight fan-out (and an out-of-order local
  // render) from a previous submit — see searchGeneration.
  const searchGen = ++searchGeneration;
  // what the results said before this search: a connected server that
  // stopped answering leaves them as they were (SPEC-fed §4.10)
  const shown = document.getElementById('search-results');
  const before = shown ? shown.innerHTML : '';
  try {
    document.getElementById('search-results').innerHTML += '<div class="loading-screen"><svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg></div>'

    const postObject = {
      search: document.getElementById('search-term').value,
      // Auto-DJ folder filter. localIgnoreVPaths() returns undefined on a peer
      // (those vpaths name OUR libraries, so a name collision would silently
      // empty the peer's results and leak our library names), so it's dropped.
      ignoreVPaths: localIgnoreVPaths()
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
    const fedBox = document.getElementById("search-federated");
    if (fedBox) { searchToggles.federated = fedBox.checked; }

    try { localStorage.setItem('mstream-search-toggles', JSON.stringify(searchToggles)); } catch (_e) {}

    // Searching a federated server searches THAT server (localIgnoreVPaths()
    // above already dropped the local folder filter for the peer case);
    // its song hits draw their ways in from the gate.
    const gate = keepGateFor(peerContext);
    const res = await browseApi('search', postObject);
    await gate;
    if (searchGen !== searchGeneration) { return; }

    if (programState[0].state === 'searchPanel') {
      programState[0].searchTerm = postObject.search;
    }

    // Reset the per-search metadata lookup the search-result handlers read.
    searchResultMetadata = {};

    // Only label the local block when there is something to tell it apart
    // FROM — a plain single-server search should not grow a header.
    const fanOut = federatedSearchOffered() && searchToggles.federated === true;
    // browseApi('search') fetched from peerContext (null = this server), so the
    // rows must carry that same peer or clicks queue peer paths as local.
    const localHtml = renderSearchResults(res, peerContext);
    const localHeader = (fanOut && localHtml) ? serverResultHeader(t('search.onThisServer')) : '';

    // Three slots: this server's results, a block per peer as each answers,
    // and an empty-state that any result — local or remote — hides.
    document.getElementById('search-results').innerHTML =
      `<div id="search-results-local">${localHeader}${localHtml}</div>` +
      '<div id="search-results-peers"></div>' +
      `<div id="search-results-empty" class="${localHtml ? 'super-hide' : ''}"><h5>${t('search.noResults')}</h5></div>`;

    // The same query, asked of every paired server. Fire-and-forget: this
    // server's results are already on screen, so a slow or dead peer costs
    // nothing but its own block.
    if (fanOut) { searchPeers(postObject, searchGen); }
  }catch(err) {
    if (peerContext && shown && searchGen === searchGeneration) { shown.innerHTML = before; }
    boilerplateFailure(err);
  }
}

// Render one search response as a collection. `peer` null = this server;
// otherwise every row carries the peer, so the queue handlers stream it
// over the federation bridge instead of resolving the path locally.
function renderSearchResults(res, peer) {
  let rows = '';
  Object.keys(res || {}).forEach((key) => {
    // A peer may run a different version and answer with a category this
    // build has no renderer for. Skip it rather than throw away the rest.
    if (!searchMap[key]) { return; }
    (res[key] || []).forEach((value) => {
      // Track-level hits (title/files/lyrics) carry the lite metadata object
      // inline — stash it so searchFileClick/searchPlayNow can enqueue
      // without a second metadata round-trip.
      if (value.filepath && value.metadata) {
        searchResultMetadata[searchKey(peer && peer.id, value.filepath)] = value.metadata;
      }
      rows += renderSearchRow(key, value, peer);
    });
  });
  return rows ? `<ul class="collection">${rows}</ul>` : '';
}

// An album hit keeps the credit and the year it was found under, so its page
// opens that album and gives its credit back. A connected server's song hit
// carries Keep a copy's ⋯ in the ▾'s place — keyed to the hit's own server
// (`peer`), never the one browsed: a federated search mixes servers. Artist
// and album hits get none: their page has the header.
function renderSearchRow(key, value, peer) {
  const attr = peerAttr(peer || null);
  const isTrack = key === 'files' || key === 'title' || key === 'lyrics';
  const album = key === 'albums'
    ? `${value.album_artist ? ` data-album-artist="${escapeHtml(value.album_artist)}"` : ''}${value.year ? ` data-year="${escapeHtml(value.year)}"` : ''}`
    : '';
  const keep = isTrack && peer && keepGateOpen('song')
    ? browseKeepTabHtml('browseKeepHit(this);', ` data-file_location="${escapeHtml(value.filepath)}"${attr} data-keep-key="${escapeHtml(browseKeepKey(peer, 'song', value.filepath))}"`,
      t('browse.keep.ofItem', { name: (value.metadata && value.metadata.title) || String(value.filepath).split('/').pop() }))
    : '';
  return `<li class="collection-item">
    <div onclick="${searchMap[key].func}(this);" data-${searchMap[key].data}="${escapeHtml(value.filepath ? value.filepath : value.name)}"${attr}${album} class="${searchMap[key].class} left">
      <b>${searchMap[key].name}:</b> ${escapeHtml(value.name)}${key === 'lyrics' && value.snippet ? `<br><small class="grey-text">${escapeHtml(value.snippet)}</small>` : ''}
    </div>
    ${isTrack ? `<div class="song-button-box">
      <span title="Play Now" onclick="searchPlayNow(this);" data-file_location="${escapeHtml(value.filepath)}"${attr} class="songDropdown">
        <svg xmlns="http://www.w3.org/2000/svg" height="12" width="12" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M15.5 5H11l5 7-5 7h4.5l5-7z"/><path d="M8.5 5H4l5 7-5 7h4.5l5-7z"/></svg>
      </span>
      ${keep || `<span title="Add To Playlist" onclick="createPopper3(this);" data-file_location="${escapeHtml(value.filepath)}"${attr} class="fileAddToPlaylist">
        <svg class="pop-f" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 292.362 292.362"><path class="pop-f" d="M286.935 69.377c-3.614-3.617-7.898-5.424-12.848-5.424H18.274c-4.952 0-9.233 1.807-12.85 5.424C1.807 72.998 0 77.279 0 82.228c0 4.948 1.807 9.229 5.424 12.847l127.907 127.907c3.621 3.617 7.902 5.428 12.85 5.428s9.233-1.811 12.847-5.428L286.935 95.074c3.613-3.617 5.427-7.898 5.427-12.847 0-4.948-1.814-9.229-5.427-12.85z"/></svg>
      </span>`}
    </div>` : ''}
  </li>`;
}

// Which server a result block came from. Every block gets one whenever the
// search spans more than one server, this one included — an unlabelled block
// next to labelled ones would be the ambiguous case.
function serverResultHeader(title, note) {
  return `<div class="search-server-header">
    ${escapeHtml(title)}${note ? ` <span class="search-server-note">&mdash; ${escapeHtml(note)}</span>` : ''}
  </div>`;
}

function peerSearchHeader(peer, note) {
  return serverResultHeader(t('peers.searchHeader', { name: peer.name }), note);
}

// Ask every paired server the query the user just ran, and append each
// answer under its own header. Never merged into one list: where a result
// lives decides whether it can be queued as a local file, added to a
// playlist, rated, or used as a Sonic Path seed — so the answer is always
// on screen next to the result.
async function searchPeers(postObject, searchGen) {
  // Fast bail before the peer lookup: the search panel is not on screen.
  if (!document.getElementById('search-results-peers')) { return; }

  // A peer's song hits draw Keep a copy's ⋯ from the gate: read again for
  // this search, beside the peer list, before the first block draws.
  const gate = keepGateFresh();
  let peers = [];
  try {
    peers = (await MSTREAMAPI.federationPeers()).peers || [];
    peers.forEach(rememberPeer);
    await gate;
  } catch (err) {
    console.warn('federation peers unavailable for search', err);
    return;
  }
  if (peers.length === 0) { return; }

  // ignoreVPaths names libraries in OUR config; a peer's namespace is its
  // own, and it already scopes every answer to what our key was granted.
  const body = { ...postObject };
  delete body.ignoreVPaths;
  const term = postObject.search;

  await Promise.all(peers.map(async (peer) => {
    let res;
    try {
      res = await MSTREAMAPI.peer.search(peer.id, body);
    } catch (err) {
      console.warn(`federation search failed on peer ${peer.id}`, err);
      if (searchGen !== searchGeneration) { return; }
      const failSlot = peerResultSlot(term);
      if (!failSlot) { return; }
      // An unreachable peer is a footnote on the results, not "no results" —
      // name the missing peer AND hide the empty-state, so "No Results Found"
      // never sits next to an "unreachable" note.
      const failEmpty = document.getElementById('search-results-empty');
      if (failEmpty) { failEmpty.classList.add('super-hide'); }
      failSlot.insertAdjacentHTML('beforeend', peerSearchHeader(peer, t('peers.unreachable')));
      return;
    }

    // The user may have moved on — a new query (searchGen), the same query
    // re-run, or a different panel.
    if (searchGen !== searchGeneration) { return; }
    const slot = peerResultSlot(term);
    if (!slot) { return; }
    const html = renderSearchResults(res, peer);
    if (!html) { return; }

    const empty = document.getElementById('search-results-empty');
    if (empty) { empty.classList.add('super-hide'); }
    slot.insertAdjacentHTML('beforeend', peerSearchHeader(peer) + html);
  }));
}

// Where a late-arriving peer answer should land, or null if it should be
// dropped. Looked up FRESH each time: submitSearchForm rebuilds the results
// DOM on every run, so a node captured before the fetch may already be
// detached — and re-running the same term would otherwise pass a
// value-only guard and append into nothing.
function peerResultSlot(term) {
  const input = document.getElementById('search-term');
  if (!input || input.value !== term) { return null; }
  return document.getElementById('search-results-peers');
}

///////////////////// Federation: the server switcher
//
// The app points at ONE server at a time. The top-bar dropdown chooses it;
// everything else — the nav, the panels, the queue handlers — follows from
// `peerContext`. There is no "peers" destination to visit: browsing a
// federated server IS the normal app, pointed somewhere else.
//
// A federated server is READ-ONLY (a federation key carries no write
// permission, and the peer's allowlist stops at reads) and answers only for
// its own library — none of our playlists, none of our per-user stats. Nav
// entries that depend on either are marked `.local-only` in index.html and
// hidden while a peer is selected, so the UI never offers something that
// cannot work. The left-nav note says why.
//
// The dropdown appears only when the ping's federationBrowse flag says
// there is somewhere else to go (federation on, at least one peer).

// Every top-level panel, keyed by the programState name it sets.
const PANELS_BY_STATE = {
  fileExplorer: () => loadFileExplorer(),
  allPlaylists: () => getAllPlaylists(),
  allAlbums: () => getAllAlbums(),
  allArtists: () => getAllArtists(),
  allGenres: () => getAllGenres(),
  recentlyAdded: () => getRecentlyAdded(),
  recentlyPlayed: () => getRecentlyPlayed(),
  mostPlayed: () => getMostPlayed(),
  allRated: () => getRatedSongs(),
  searchPanel: () => setupSearchPanel(),
  discoverDownloads: () => discoverDownloadsPanel(),
  discovery: () => discoveryPanel(),
};

// Which of those a federated server can actually answer: its library, and
// nothing that lives in our own user rows. Playlists and the three stats
// panels are ours alone; the rest map onto routes on the peer's allowlist.
const PEER_CAPABLE_STATES = new Set([
  'fileExplorer', 'allAlbums', 'allArtists', 'allGenres', 'recentlyAdded', 'searchPanel',
]);

// Fill the top-bar dropdown. Called once from init(), only when the ping
// advertised federationBrowse.
async function loadServerSwitcher() {
  const wrap = document.getElementById('server-select-wrap');
  const select = document.getElementById('server-select');
  if (!wrap || !select) { return; }

  let peers = [];
  try {
    peers = (await MSTREAMAPI.federationPeers()).peers || [];
  } catch (err) {
    // Federation off or the route unreachable: leave the dropdown hidden
    // and the app exactly as it was.
    console.warn('federation peers unavailable for the server switcher', err);
    return;
  }
  if (peers.length === 0) { return; }

  peers.forEach(rememberPeer);
  let html = `<option value="">${escapeHtml(t('server.thisServer'))}</option>`;
  peers.forEach(p => {
    html += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`;
  });
  select.innerHTML = html;
  wrap.classList.remove('super-hide');
}

function onServerChange(el) {
  switchServer(el.value === '' ? null : Number(el.value));
}

// Point the app at a server. `peerId` null = this one.
function switchServer(peerId) {
  const next = peerId === null
    ? null
    : (knownPeers.get(Number(peerId)) || { id: Number(peerId), name: 'peer' });
  if ((next ? next.id : null) === (peerContext ? peerContext.id : null)) { return; }

  peerContext = next;
  // Any browse load still in flight belongs to the old server; supersede it.
  browseGeneration++;
  applyServerContext();

  // Stay on the same panel when the new server can answer it; otherwise
  // fall back to the file explorer, which every server has.
  const previous = programState[0];
  const current = previous ? previous.state : 'fileExplorer';
  const keep = PANELS_BY_STATE[current] && (!peerContext || PEER_CAPABLE_STATES.has(current));
  const landing = keep ? current : 'fileExplorer';

  // The explorer's breadcrumb is a path in the OLD server's namespace.
  fileExplorerArray = [];
  highlightNavPanel(landing);

  // Carry a query across: switching servers with a search on screen means
  // "run that again over there", not "start over with an empty box".
  if (landing === 'searchPanel' && previous && previous.searchTerm) {
    setupSearchPanel(previous.searchTerm);
    return;
  }
  PANELS_BY_STATE[landing]();
}

// Move the sidebar's selected marker onto the entry that owns a panel, so a
// server switch that had to change panels doesn't leave the old one lit.
function highlightNavPanel(state) {
  const target = document.querySelector(`.side-nav-item[data-panel="${state}"]`);
  if (!target) { return; }
  document.querySelectorAll('.side-nav-item').forEach(el => el.classList.remove('select'));
  target.classList.add('select');
}

// Sync the chrome to `peerContext`: the dropdown's selection, the nav
// entries a federated server cannot serve, and the read-only note. Derives
// everything from the current context, so it is safe to call at any time.
function applyServerContext() {
  const select = document.getElementById('server-select');
  const want = peerContext ? String(peerContext.id) : '';
  if (select) {
    // loadServerSwitcher() builds the <option>s once at init, so a peer paired
    // later (adopted via a federated search hit) has none — then select.value =
    // id leaves selectedIndex -1 and the dropdown blank. Add the option first.
    if (peerContext && !Array.from(select.options).some(o => o.value === want)) {
      const opt = document.createElement('option');
      opt.value = want;
      opt.textContent = peerContext.name;
      select.appendChild(opt);
    }
    if (select.value !== want) { select.value = want; }
  }

  // One class does the whole job (see spa.css): it hides every .local-only
  // nav entry and reveals the read-only note. A body class rather than a
  // per-item toggle, so it composes with the flag gates that already hide
  // some entries (Sonic Path) instead of un-hiding them on the way back.
  document.body.classList.toggle('on-federated-server', !!peerContext);

  writeReadOnlyNote();
  // Each move onto a connected server reads Keep a copy's gate again (a
  // right may have gone since); its panels wait for the answer.
  if (peerContext) { keepGateRefresh(); }
}

// The side-nav's read-only note: whose library the app shows, and — while
// a copy can be kept from it (keepGate) — that one can: the copy changes
// this library, never theirs.
function writeReadOnlyNote() {
  const note = document.getElementById('nav-readonly-note');
  if (note && peerContext) {
    // Built as DOM nodes, never innerHTML — peerContext.name is peer-controlled.
    // The "back" link is the only way home when the top bar (and its switcher)
    // is hidden, since this note stays visible in the always-shown side-nav.
    note.textContent = t(keepGate.open ? 'server.readOnlyNoteKeep' : 'server.readOnlyNote', { name: peerContext.name });
    const back = document.createElement('a');
    back.className = 'nav-note-back';
    back.textContent = t('server.backToThisServer');
    back.onclick = () => switchServer(null);
    note.appendChild(document.createElement('br'));
    note.appendChild(back);
  }
}

///////////////////// Keep a copy, from browsing a connected server
//
// While the app browses a connected server, its pages lead into the
// Discover window's Keep a copy (VUEPLAYERCORE.openDiscoverModal, the
// window Discover's ⋯ opens) on what a copy can take:
//   - a header above the list (#browse-head, outside #filelist, so the
//     filter never redraws it) on a page whose subject is one thing — an
//     album, an artist, a folder below the library root — whose
//     "Keep a copy…" later carries the copy's state;
//   - a ⋯ on each song row, file row and folder row, in the slot of the
//     row's dead ▾ / ↓ (a peer's track joins no playlist here, its folder
//     zips nowhere), and in the corner of each album card;
//   - "Keep a copy…" in the ⋮ menu of a connected server's queue row.
// None of them is a menu: each opens the window on what it names.
//
// The gate (keepGate) decides whether any of it exists. It is read when the
// app moves onto a connected server and awaited by each peer panel before
// its first draw, so the renderers read it synchronously and nothing pops
// in after a page drew; a failing gate hides every way in, never greys one.
// A page's header keeps the gate it was drawn with: a read since shows at
// the next page, never pulling a button from under the pointer.
//
// What became of a copy shows on the page too (browseKeep): the header
// button's words, a line on album cards, marks on an album page's songs and
// on folder rows — this server's own jobs (the batch lookup, then the
// strip's job list as it polls), each mark its own scope only. A copy made
// before the gate closed still says what it is (only the ways in go); a
// server whose lookup refuses shows none.

// keepGate: `open` — the copy plug-in listed and on, this account allowed
// to start jobs, a place to put the files (the collection destination view
// names one; a jukebox session is refused all of it) — and `scopes`, the
// copy's scopes as the listing says (song · album · artist · artist-missing
// · folder): an entry shows only when its own is there. `marks` whether
// this server keeps plug-in jobs at all (ping's discoveryPlugins: its
// lookup is worth asking). Read again on each move onto a connected
// server, before this server's search draws a federated block, and
// whenever the window says a right went or the destination moved
// (keepGateRefresh). The window keeps no older listing than this: each
// read hands it over (VUEPLAYERCORE.takeDiscoverPlugins — its folder cap
// with it).
const keepGate = {
  ready: false,
  open: false,
  scopes: [],
  marks: false,
};
// The read in flight, and one number per read: an answer older than the
// last read asked is dropped.
let keepGatePending = null;
let keepGateAsk = 0;

// The gate from what this server said: ping's discoveryPlugins flag (`on`),
// the plug-in listing and the destination view (null: refused or not
// answered). Any part missing closes it.
function keepGateOf(on, listing, view) {
  const gate = { ready: true, open: false, scopes: [], marks: on === true };
  if (on !== true || !listing || typeof listing !== 'object') { return gate; }
  const copy = (Array.isArray(listing.plugins) ? listing.plugins : []).find((p) => p && p.name === DISCOVERJOBS.COPY_PLUGIN
    && p.enabled !== false && p.available !== false && Array.isArray(p.capabilities) && p.capabilities.indexOf('acquire') !== -1);
  if (!copy || !(listing.jobs && listing.jobs.allowed === true) || !(view && view.destination)) { return gate; }
  gate.scopes = (Array.isArray(copy.scopes) ? copy.scopes : []).filter((s) => typeof s === 'string');
  gate.open = gate.scopes.length > 0;
  return gate;
}

// One read: the listing itself (not the window's session copy of it — a
// right lost since must show) and the destination view, side by side. The
// listing goes to the window too, so a way in never opens on an older one.
async function keepGateRead() {
  const ask = ++keepGateAsk;
  const host = MSTREAMAPI.currentServer.host;
  const on = discoveryView.flags.discoveryPlugins === true;
  let listing = null;
  let view = null;
  if (on) {
    [listing, view] = await Promise.all([
      MSTREAMAPI.discoveryPlugins().catch(() => null),
      MSTREAMAPI.discoveryDestination().catch(() => null),
    ]);
  }
  if (ask !== keepGateAsk || host !== MSTREAMAPI.currentServer.host) { return keepGate; }
  Object.assign(keepGate, keepGateOf(on, listing, view));
  if (listing && typeof listing === 'object') { VUEPLAYERCORE.takeDiscoverPlugins(listing); }
  writeReadOnlyNote();
  return keepGate;
}

// Read the gate again: on a move onto a connected server, and from the
// window after a start answered 403 / 404 or its destination editor saved.
// What it finds shows at the next draw — a page already drawn keeps its
// entries, none pulled from under the pointer.
function keepGateRefresh() {
  const pending = keepGateRead().finally(() => { if (keepGatePending === pending) { keepGatePending = null; } });
  keepGatePending = pending;
  return pending;
}

// The gate as of the read in flight, else the one done; the first ask
// starts the session's read.
function keepGateWait() {
  if (keepGatePending) { return keepGatePending; }
  if (keepGate.ready) { return Promise.resolve(keepGate); }
  return keepGateRefresh();
}

// The gate read now — a read already out serves: what this server's
// search waits for before it draws a connected server's block (on this
// server nothing else reads it again, and a failed read must not close it
// for the session).
function keepGateFresh() {
  return keepGatePending || keepGateRefresh();
}

// What a panel awaits before its first draw: the gate on a connected
// server, nothing on this one.
function keepGateFor(peer) {
  return peer ? keepGateWait() : Promise.resolve(keepGate);
}

// Whether a way in exists for `scope` (song · album · artist · folder).
function keepGateOpen(scope) {
  return keepGate.ready && keepGate.open && keepGate.scopes.indexOf(scope) !== -1;
}

// The page's copy state: `visit` one per page drawn (an older page's
// answers are dropped), `head` the header's model (browseHeadView),
// `items` what the page marks, by key — { kind, rec, album, filepath,
// recKeys, jobs (slot → job) } — `asked` the keys looked up this visit,
// `pending` the ones the observer saw since the last ask, `observer` the
// albums grid's and folder rows' (only what scrolls near is asked),
// `unwatch` the job-list watch while the page holds marks. `drawn` and
// `held` keep a connected server's page while the next one loads
// (browseKeepHold).
const browseKeep = {
  visit: 0,
  head: null,
  items: new Map(),
  asked: new Set(),
  pending: new Set(),
  timer: null,
  observer: null,
  unwatch: null,
  drawn: null,
  held: null,
};
// The connected server's song whose queue ⋮ menu is open, and its ⋮.
let browseKeepQueued = null;

// A new page: the header goes, and the marks' lookups and watch with it —
// the page held first (browseKeepHold; `start`: the reset begins a page's
// load, as a panel's and an album's do).
function browseKeepReset(start) {
  browseKeepHold(start === true);
  browseKeep.visit++;
  browseKeep.head = null;
  browseKeep.items = new Map();
  browseKeep.asked = new Set();
  browseKeep.pending = new Set();
  if (browseKeep.timer) { clearTimeout(browseKeep.timer); browseKeep.timer = null; }
  if (browseKeep.observer) { browseKeep.observer.disconnect(); browseKeep.observer = null; }
  if (browseKeep.unwatch) { browseKeep.unwatch(); browseKeep.unwatch = null; }
  const head = document.getElementById('browse-head');
  if (head) { head.classList.add('super-hide'); head.innerHTML = ''; }
}

// ── A page held while the next one loads (SPEC-fed §4.10) ────────────────
// A connected server that stops answering fails the next page's load:
// the page it was on comes back as it was — its list, its header, its ⋯
// and marks, the bar's words, where Back goes — and only the toast says
// so. `drawn` is where a page stood once it drew (Back's states and the
// explorer's path: a press moves them before the next page loads); the
// page itself is held as it leaves, once a load.

// A page drew. On a connected server: where it stands; anywhere else
// nothing to hold.
function browseKeepDrawn() {
  browseKeep.held = null;
  browseKeep.drawn = peerContext
    ? { gen: browseGeneration, peer: peerContext.id, states: programState.map((s) => Object.assign({}, s)), dirs: fileExplorerArray.slice() }
    : null;
}

// Hold the page leaving: its list (the filter's words, the scroll), its
// header and marks, the panel's title and bar, as they stand — once per
// load (a second reset of the same load finds nothing drawn: the first
// one's hold stands). A load that starts (`start`) on no page drawn holds
// nothing: a page in between (one that holds nothing of the server's,
// as layout settings) is what a failure leaves up.
function browseKeepHold(start) {
  const d = browseKeep.drawn;
  browseKeep.drawn = null;
  if (!d || d.gen !== browseGeneration || !peerContext || peerContext.id !== d.peer) {
    if (start) { browseKeep.held = null; }
    return;
  }
  const el = (id) => document.getElementById(id);
  const head = el('browse-head');
  const title = document.getElementsByClassName('panel_one_name')[0];
  const value = (id) => (el(id) ? el(id).value : null);
  browseKeep.held = {
    drawn: d, visit: browseKeep.visit, head: browseKeep.head, items: browseKeep.items, asked: browseKeep.asked, list: currentBrowsingList,
    html: el('filelist').innerHTML, scroll: el('filelist').scrollTop, filter: el('localSearchBar').value,
    dir: el('directoryName').innerHTML, bar: el('directory_bar').style.display, title: title ? title.innerHTML : null,
    headHtml: head ? head.innerHTML : '', headShown: !!head && !head.classList.contains('super-hide'),
    // what the page's own fields hold (Recently Added's limit, the search's words)
    limit: value('recently-added-limit'), term: value('search-term'),
  };
}

// A connected server's page failed to load: the page it left back up, as
// held, its marks' lookups and watch picked up where they were. → true;
// false when there is none to give back (this server, another server
// since, a load over nothing held) — the caller says it failed in the list.
function browseKeepBack(gen) {
  const h = browseKeep.held;
  if (!h || gen !== browseGeneration || h.drawn.gen !== gen || !peerContext || peerContext.id !== h.drawn.peer) { return false; }
  browseKeep.held = null;
  browseKeep.drawn = h.drawn;
  programState = h.drawn.states.map((s) => Object.assign({}, s));
  fileExplorerArray = h.drawn.dirs.slice();
  currentBrowsingList = h.list;
  const el = (id) => document.getElementById(id);
  el('filelist').innerHTML = h.html;
  el('filelist').scrollTop = h.scroll;
  el('localSearchBar').value = h.filter;
  el('directoryName').innerHTML = h.dir;
  el('directory_bar').style.display = h.bar;
  if (h.title !== null) { [...document.getElementsByClassName('panel_one_name')].forEach((node) => { node.innerHTML = h.title; }); }
  if (h.limit !== null && el('recently-added-limit')) { el('recently-added-limit').value = h.limit; }
  if (h.term !== null && el('search-term')) { el('search-term').value = h.term; }
  const head = el('browse-head');
  if (head) {
    head.innerHTML = h.headHtml;
    if (h.headShown) { head.classList.remove('super-hide'); } else { head.classList.add('super-hide'); }
  }
  // the page's own lookups: one still out lands (its visit is the page's
  // again); one dropped meanwhile is asked again
  browseKeep.visit = h.visit;
  browseKeep.head = h.head;
  browseKeep.items = h.items;
  browseKeep.asked = new Set([...h.asked].filter((k) => h.items.has(k) && h.items.get(k).recKeys.length));
  browseKeep.pending = new Set();
  if (h.head && h.head.key && !browseKeep.asked.has(h.head.key)) { browseKeepAsk([h.head.key]); }
  browseKeepObserve();
  browseKeepWatch();
  return true;
}

// What a way in and its mark are found by: `{peerId}|{kind}|{what}` — a
// song's or a folder's path on the peer, an album's name and credit, an
// artist's name. The window's focus return finds a redrawn ⋯ or header
// button by it (data-keep-key), a poll the mark (data-keep-mark).
function browseKeepKey(peer, kind, ...what) {
  return [peer.id, kind].concat(what.map((w) => (w == null ? '' : String(w)))).join('|');
}

// A recommendation as the batch lookup takes it: the copy's own fields,
// each within what the route accepts (a peer's odd year or overlong tag
// must not refuse the whole batch). It is keyed as the window's start for
// the same thing: a song by artist · title · album, an album by its credit
// and name, an artist by name, a folder by its path.
function browseKeepRec(peer, fields) {
  const rec = { source: 'federation', peer: { id: peer.id, name: String(peer.name || 'peer').slice(0, 128) } };
  for (const k of ['artist', 'title', 'album', 'albumArtist']) {
    if (typeof fields[k] === 'string' && fields[k].trim()) { rec[k] = fields[k].trim().slice(0, 512); }
  }
  if (typeof fields.filepath === 'string' && fields.filepath) { rec.filepath = fields.filepath.slice(0, 2048); }
  const year = Number(fields.year);
  if (Number.isInteger(year) && year >= 1000 && year <= 9999) { rec.year = year; }
  const duration = Number(fields.duration);
  if (fields.duration != null && Number.isFinite(duration) && duration >= 0) { rec.duration = duration; }
  return rec;
}

// Put a thing on the page's marks.
function browseKeepAdd(key, item) {
  browseKeep.items.set(key, Object.assign({ recKeys: [], jobs: {} }, item));
}

// Ask this server what became of the things `keys` name — the batch
// lookup, 100 at a time — then draw their marks and follow the job list.
// Each is asked once a visit; a chunk the server refuses marks nothing.
async function browseKeepAsk(keys) {
  if (!keepGate.marks) { return; }
  const visit = browseKeep.visit;
  const want = keys.filter((k) => browseKeep.items.has(k) && !browseKeep.asked.has(k));
  if (!want.length) { return; }
  want.forEach((k) => browseKeep.asked.add(k));
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    let results = [];
    try {
      const r = await MSTREAMAPI.discoveryJobLookupBatch(chunk.map((k) => browseKeep.items.get(k).rec));
      results = r && Array.isArray(r.results) ? r.results : [];
    } catch (_) { /* no marks for this chunk */ }
    if (visit !== browseKeep.visit) { return; }
    chunk.forEach((k, at) => {
      const found = results[at];
      if (!found || typeof found !== 'object') { return; }
      const item = browseKeep.items.get(k);
      item.recKeys = [found.key].concat(Object.values(found.keys || {})).filter((x, n, all) => x && all.indexOf(x) === n);
      item.jobs = DISCOVERJOBS.jobsBySlot(found.jobs);
    });
  }
  browseKeepPaint();
  browseKeepWatch();
}

// The albums grid's cards and the folder rows are looked up as they come
// near (within 400 px of the list's view), 250 ms after the last one did.
// Each is watched by what its slot sits in (the card's text, the folder
// row), never the slot: a folder row's empty mark draws no box (spa.css),
// and a target with no box never comes near.
function browseKeepObserve() {
  const root = document.getElementById('filelist');
  if (!keepGate.marks || !root) { return; }
  const slots = [...root.querySelectorAll('[data-keep-mark]')].filter((el) => {
    const key = el.getAttribute('data-keep-mark');
    return browseKeep.items.has(key) && !browseKeep.asked.has(key);
  });
  if (!slots.length) { return; }
  if (typeof IntersectionObserver !== 'function') {
    browseKeepAsk(slots.map((el) => el.getAttribute('data-keep-mark')));
    return;
  }
  if (!browseKeep.observer) {
    const visit = browseKeep.visit;
    browseKeep.observer = new IntersectionObserver((entries, observer) => {
      if (visit !== browseKeep.visit) { return; }
      for (const e of entries) {
        if (!e.isIntersecting) { continue; }
        browseKeep.pending.add(e.target.keepMark);
        observer.unobserve(e.target);
      }
      if (!browseKeep.pending.size) { return; }
      if (browseKeep.timer) { clearTimeout(browseKeep.timer); }
      browseKeep.timer = setTimeout(() => {
        browseKeep.timer = null;
        const keys = [...browseKeep.pending];
        browseKeep.pending.clear();
        browseKeepAsk(keys);
      }, 250);
    }, { root, rootMargin: '400px 0px' });
  }
  slots.forEach((el) => {
    const at = el.parentElement || el;
    at.keepMark = el.getAttribute('data-keep-mark');
    browseKeep.observer.observe(at);
  });
}

// Keep the marks current while the page is up: the strip's job list merged
// now, then on each change of it (its poll; a job the window just started
// or cancelled). A mark still moving wakes the poll, which keeps beating
// while any job lives. The watch goes with the page (browseKeepReset).
function browseKeepWatch() {
  if (!keepGate.marks) { return; }
  if (!browseKeep.unwatch) {
    const visit = browseKeep.visit;
    browseKeep.unwatch = VUEPLAYERCORE.watchDiscoverJobs((jobs) => {
      if (visit === browseKeep.visit && browseKeepMerge(jobs)) { browseKeepPaint(); }
    });
  }
  if (browseKeepMerge(VUEPLAYERCORE.discoverJobs())) { browseKeepPaint(); }
  const live = [...browseKeep.items.keys()].some((key) => { const s = browseKeepShown(key); return !!(s && s.st.live); });
  if (live) { VUEPLAYERCORE.refreshDiscoverJobs(); }
}

// Merge a job list onto the things the lookup keyed — the list's job for a
// slot replacing the one held unless that one is newer (a higher id). →
// whether any was merged (the paint redraws only what changed).
function browseKeepMerge(jobs) {
  let changed = false;
  for (const item of browseKeep.items.values()) {
    if (!item.recKeys.length) { continue; }
    const mine = DISCOVERJOBS.jobsBySlot((jobs || []).filter((j) => j && item.recKeys.indexOf(j.key) !== -1));
    for (const slot of Object.keys(mine)) {
      const held = item.jobs[slot];
      if (held && Number(mine[slot].id) < Number(held.id)) { continue; }
      item.jobs = Object.assign({}, item.jobs, { [slot]: mine[slot] });
      changed = true;
    }
  }
  return changed;
}

// An album or artist job whose recommendation names a server other than
// `peerId` (DISCOVERYPAGE's otherPeerJob rule: their keys carry no server,
// so the lookup can hand back another connected server's copy of the same
// album). It never marks this server's cards or rows; while it runs the
// header says whose it is. A song job is the recording wherever it came
// from, and a folder's key names its server.
function browseKeepOtherPeer(job, peerId) {
  const scope = DISCOVERJOBS.jobScope(job);
  if (!job || scope === 'song' || scope === 'folder') { return null; }
  const peer = job.recommendation && job.recommendation.peer;
  if (!peer || peer.id == null || String(peer.id) === String(peerId)) { return null; }
  return { id: peer.id, name: peer.name || (job.result && job.result.peer && job.result.peer.name) || 'peer' };
}

// Did a finished many-song copy fail on this file (its `failed` list)?
function browseKeepFailedIn(job, filepath) {
  const songs = job && job.result && job.result.songs;
  const want = DISCOVERYPAGE.normalizePeerPath(filepath);
  return !!want && !!songs && Array.isArray(songs.failed)
    && songs.failed.some((f) => f && DISCOVERYPAGE.normalizePeerPath(f.from) === want);
}

// Which job a mark shows, by its own scope (this server's newest, read as
// the window reads the same thing: DISCOVERYPAGE.keepJobFor lets a
// finished wider copy speak for what it walked), and what it says
// (browseKeepState). → { st, job } | null.
//   song    an album page's row: its song job, or the page's album copy as
//           its lists name the file (copied, already yours, failed) —
//           newest wins; a running album copy names no row
//   album   a card (or the album page's header): its album copy, or a
//           finished artist copy of this server's as its walk saw the
//           album; the header alone says "Copying from" another server
//   artist  the artist page's header: its newest artist copy, every album
//           or only the missing
//   folder  a folder row or header: folder copies only
function browseKeepShown(key) {
  const item = browseKeep.items.get(key);
  if (!item) { return null; }
  const D = DISCOVERJOBS;
  const slot = (it, scope) => (it && it.jobs[D.jobSlot(D.COPY_PLUGIN, scope)]) || null;
  const peerId = item.rec.peer.id;
  const isHead = !!browseKeep.head && browseKeep.head.key === key;
  const head = browseKeep.head ? browseKeep.items.get(browseKeep.head.key) : null;
  const say = (job, other) => {
    const st = other ? { state: 'other', live: true, peer: other.name } : browseKeepState(job);
    return st ? { st, job } : null;
  };
  if (item.kind === 'folder') { return say(slot(item, 'folder')); }
  if (item.kind === 'artist') {
    const jobs = [slot(item, 'artist'), slot(item, 'artist-missing')].filter(Boolean).sort((a, b) => Number(b.id) - Number(a.id));
    const other = jobs.length ? browseKeepOtherPeer(jobs[0], peerId) : null;
    if (other && D.isLive(jobs[0])) { return say(jobs[0], other); }
    return say(jobs.find((j) => !browseKeepOtherPeer(j, peerId)) || null);
  }
  if (item.kind === 'album') {
    let own = slot(item, 'album');
    const other = own ? browseKeepOtherPeer(own, peerId) : null;
    if (other && isHead && D.isLive(own)) { return say(own, other); }
    if (other) { own = null; }
    const artistHead = browseKeep.head && browseKeep.head.kind === 'artist' ? head : null;
    const wider = [slot(item, 'artist'), slot(item, 'artist-missing'), slot(artistHead, 'artist'), slot(artistHead, 'artist-missing')]
      .filter((j) => j && !browseKeepOtherPeer(j, peerId));
    return say(DISCOVERYPAGE.keepJobFor('album', own, wider, { album: item.album }, D));
  }
  const own = slot(item, 'song');
  const albumHead = browseKeep.head && browseKeep.head.kind === 'album' ? head : null;
  let album = slot(albumHead, 'album');
  if (album && browseKeepOtherPeer(album, peerId)) { album = null; }
  if (album && album.state === 'done' && (!own || Number(album.id) > Number(own.id)) && browseKeepFailedIn(album, item.filepath)) {
    return { st: { state: 'failed' }, job: album };
  }
  return say(DISCOVERYPAGE.keepJobFor('song', own, album ? [album] : [], { album: item.album, filepath: item.filepath }, D));
}

// What a job says on the page, in the window's words: null for nothing to
// say (none, cancelled, nothing to copy). Done is not kept — a copy that
// copied nothing and failed is "Copy failed", "Already yours" only when
// every song it skipped was the library's own, and a refused copy offers
// nothing (the page never offers Retry: rows and tiles carry no actions).
function browseKeepState(job) {
  if (!job) { return null; }
  const row = DISCOVERJOBS.jobRowState(job, { plugin: DISCOVERJOBS.COPY_PLUGIN });
  const res = job.result && typeof job.result === 'object' ? job.result : {};
  switch (row.state) {
    case 'queued': return { state: 'queued', live: true };
    case 'running': {
      if (job.cancelRequested === true) { return { state: 'stopping', live: true }; }
      // 0 is no figure yet: the copy is still asking the peer
      const pct = Number.isFinite(job.progress) && job.progress > 0 ? Math.round(job.progress * 100) : null;
      return { state: 'copying', live: true, pct };
    }
    case 'copied':
    case 'copiedMany':
      return { state: 'kept' };
    case 'owned': {
      const skipped = res.songs && Array.isArray(res.songs.skipped) ? res.songs.skipped : [];
      return { state: skipped.some((x) => x && x.why === 'exists') ? 'skipped' : 'yours' };
    }
    case 'exists': return { state: 'skipped' };
    case 'stopped': return { state: res.stopped === 'refused' ? 'refused' : 'stopped' };
    case 'failed': return { state: 'failed' };
    default: return null;
  }
}

// A state's words. `form` 'card' (an album card's line) and 'folder' (a
// folder row's mark) read "Copying · 43%"; the header and a song row say
// "Copying" (the header puts its figure beside it).
function browseKeepWord(st, form) {
  switch (st.state) {
    case 'queued': return t('discover.keep.queued');
    case 'copying': return (form === 'card' || form === 'folder') && st.pct != null ? t('browse.keep.copyingPct', { pct: st.pct }) : t('discover.keep.copying');
    case 'stopping': return t('discover.keep.stopping');
    case 'other': return t('discover.keep.copyingFrom', { peer: st.peer });
    case 'kept': return t('discover.keep.kept');
    case 'yours': return t('discover.keep.yours');
    case 'skipped': return t('discover.keep.skipped');
    case 'stopped': return t('discover.keep.markStopped');
    case 'refused': return t('discover.keep.markRefused');
    case 'failed': return t('discover.keep.failed');
    default: return '';
  }
}

// The words a name reads them in ("Copying, 43%").
function browseKeepSpoken(st) {
  return st.state === 'copying' && st.pct != null ? `${browseKeepWord(st, 'head')}, ${st.pct}%` : browseKeepWord(st, 'head');
}

// The glyphs (24-unit box, stroked as the window's boards draw them).
const BROWSE_KEEP_ICONS = {
  keep: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6"/><path d="M9.5 14l2.5 2.5 2.5-2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
};

function browseKeepIcon(name, size) {
  return `<svg class="browse-keep-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${size < 14 ? 2.2 : 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BROWSE_KEEP_ICONS[name]}</svg>`;
}

// A state's glyph: a dot while it copies (gold; grey for another
// server's), a clock while it waits, a check once in, a warning otherwise.
function browseKeepGlyph(st, size) {
  if (st.state === 'copying' || st.state === 'stopping' || st.state === 'other') { return '<span class="browse-keep-dot" aria-hidden="true"></span>'; }
  if (st.state === 'queued') { return browseKeepIcon('clock', size); }
  return browseKeepIcon(st.state === 'kept' || st.state === 'yours' ? 'check' : 'warn', size);
}

// A mark in one of the page's forms: 'row' after an album page's song's
// artist ("Boukmanflow · In your collection"), 'card' an album card's line
// (its glyph 10), 'folder' after a folder row's name (the card's words,
// the row's glyph 12), 'plain' a header's when no button carries it.
function browseKeepMarkHtml(st, form) {
  if (!st) { return ''; }
  const size = form === 'card' ? 10 : (form === 'plain' ? 14 : 12);
  const mark = `<span class="browse-keep-st bk-${st.state}">${browseKeepGlyph(st, size)}<span class="browse-keep-w">${escapeHtml(browseKeepWord(st, form))}</span></span>`;
  return form === 'row' ? `<span class="browse-keep-sep" aria-hidden="true"> · </span>${mark}` : mark;
}

// A slot a mark draws in, as the renderers place it; the poll fills it in
// place (browseKeepPaint).
function browseKeepSlotHtml(key, form, tag) {
  const shown = browseKeepShown(key);
  return `<${tag} class="browse-keep-slot browse-keep-${form}" data-keep-mark="${escapeHtml(key)}" data-keep-form="${form}">${shown ? browseKeepMarkHtml(shown.st, form) : ''}</${tag}>`;
}

// An album card's name for a screen reader: its name, credit and year,
// then its copy's state.
function browseKeepCardLabel(key, base) {
  const shown = browseKeepShown(key);
  return shown ? `${base}, ${browseKeepSpoken(shown.st)}` : base;
}

// Draw every mark whose slot is on the page, and the header — in place:
// focus, the scroll and the pointer's target survive the poll's beat.
function browseKeepPaint() {
  const root = document.getElementById('filelist');
  if (root) {
    root.querySelectorAll('[data-keep-mark]').forEach((slot) => {
      const key = slot.getAttribute('data-keep-mark');
      const form = slot.getAttribute('data-keep-form');
      const shown = browseKeepShown(key);
      const html = shown ? browseKeepMarkHtml(shown.st, form) : '';
      if (slot.keepHtml !== html) { slot.innerHTML = html; slot.keepHtml = html; }
      const card = form === 'card' ? slot.closest('.album-grid-card') : null;
      if (card && card.hasAttribute('data-keep-label')) { card.setAttribute('aria-label', browseKeepCardLabel(key, card.getAttribute('data-keep-label'))); }
    });
  }
  browseHeadDraw();
}

// The row ⋯ (song, file and folder rows): a real button in the slot of the
// row's dead ▾ / ↓, its name saying what it keeps.
function browseKeepTabHtml(onclick, attrs, name) {
  const label = escapeHtml(name);
  return `<button type="button" class="browse-keep-tab" onclick="${onclick}"${attrs} title="${label}" aria-label="${label}" aria-haspopup="dialog"><svg width="12" height="4" viewBox="0 0 12 4" aria-hidden="true"><circle cx="1.2" cy="2" r="1.2" fill="currentColor"/><circle cx="6" cy="2" r="1.2" fill="currentColor"/><circle cx="10.8" cy="2" r="1.2" fill="currentColor"/></svg></button>`;
}

// A connected server's song or file row's ⋯ ('' for this server's rows, or
// while the gate is closed for a song: the ▾ comes back, with its toast).
function browseKeepSongTab(filepath, title) {
  if (!peerContext || !keepGateOpen('song')) { return ''; }
  const key = browseKeepKey(peerContext, 'song', filepath);
  return browseKeepTabHtml('browseKeepSong(this);', ` data-file_location="${escapeHtml(filepath)}"${peerAttr()} data-keep-key="${escapeHtml(key)}"`, t('browse.keep.ofItem', { name: title }));
}

// The page a row draws on is a connected server's album page.
function browseKeepAlbumPage() {
  const top = programState[programState.length - 1];
  return !!peerContext && !!top && top.state === 'album';
}

// The slot an album page's song row draws its mark in ('' anywhere else:
// genre, Recently Added, search and explorer rows show state only inside
// the window).
function browseKeepSongMark(filepath) {
  if (!keepGate.marks || !browseKeepAlbumPage()) { return ''; }
  return browseKeepSlotHtml(browseKeepKey(peerContext, 'song', filepath), 'row', 'span');
}

// A connected server's folder row: its ⋯ in the ↓'s place and the slot its
// folder copy's mark draws in. A library at a multi-library server's root
// gets neither. → { tab, mark }, both '' for this server's rows.
function browseKeepFolderRow(name) {
  if (!peerContext || fileExplorerArray.length === 0) { return { tab: '', mark: '' }; }
  const key = browseKeepKey(peerContext, 'folder', '/' + fileExplorerArray.concat(name).join('/'));
  return {
    tab: keepGateOpen('folder')
      ? browseKeepTabHtml('browseKeepFolder(this);', ` data-directory="${escapeHtml(name)}"${peerAttr()} data-keep-key="${escapeHtml(key)}"`, t('browse.keep.ofFolder', { name }))
      : '',
    mark: keepGate.marks ? browseKeepSlotHtml(key, 'folder', 'span') : '',
  };
}

// A connected server's album card: its ⋯ at the art's top-right (Discover's
// .dpage-album-more), only on a card that names its album and one credit
// (rule 1: never the singles card, never one whose credits disagree), and
// the line its copy's state draws on, which the card's name reads too.
// `label` = [name, credit line, year]. → { attrs, more, line }, all '' on
// this server's cards.
function browseKeepCard(album, albumArtist, artFile, label) {
  if (!peerContext || !album || !albumArtist) { return { attrs: '', more: '', line: '' }; }
  const key = browseKeepKey(peerContext, 'album', album, albumArtist);
  const base = label.filter((x) => x != null && x !== '').join(', ');
  const name = t('browse.keep.ofItem', { name: album });
  return {
    attrs: keepGate.marks ? ` role="group" title="${escapeHtml(album)}" aria-label="${escapeHtml(browseKeepCardLabel(key, base))}" data-keep-label="${escapeHtml(base)}"` : '',
    more: keepGateOpen('album')
      ? `<button type="button" class="dpage-album-more browse-keep-more" data-keep-key="${escapeHtml(key)}"${artFile ? ` data-art="${escapeHtml(artFile)}"` : ''} onclick="event.stopPropagation(); browseKeepAlbum(this);" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}" aria-haspopup="dialog">⋯</button>`
      : '',
    line: keepGate.marks ? browseKeepSlotHtml(key, 'card', 'div') : '',
  };
}

// The albums a page's cards stand for, put on its marks: those that name
// their album and one credit (an album copy needs both), keyed and looked
// up as the window's start would be (the credit as artist too, so the
// credit's own artist copies come back — not a compilation's).
function browseKeepCards(albums) {
  const keys = [];
  for (const a of albums || []) {
    const credit = a && a.name ? albumCredit(a).albumArtist : null;
    if (!credit) { continue; }
    const key = browseKeepKey(peerContext, 'album', a.name, credit);
    browseKeepAdd(key, { kind: 'album', album: a.name,
      rec: browseKeepRec(peerContext, { album: a.name, albumArtist: credit, artist: a.compilation === true || browseKeepVarious(credit) ? null : credit, year: a.year }) });
    keys.push(key);
  }
  return keys;
}

// ── The page header (#browse-head) ───────────────────────────────────────
// An album's, an artist's or a folder's, built by its panel from its own
// answer. Its tile, its title, what is known of it, and — while the gate
// passes for its scope — its action row: "Keep a copy…" carrying the
// copy's state, or the line that says why there is no button. With the
// gate closed only the album's header stays (it gives back the credit), and
// a header whose copy has a state says it in plain words.

// The header's view, or null for none: { sig (what a patch cannot change),
// kind, title, sub, tile, button: { cls, label, quiet (its name but the
// figure), inner, key } | null, plain, line, reserve (the album's row held
// while its credit resolves), live (the copy keeps going…), bar: { pct,
// label } | null }. The gate is the one the page drew with (h.gate).
function browseHeadView(h) {
  const shown = h.key ? browseKeepShown(h.key) : null;
  const st = shown ? shown.st : null;
  const gate = h.gate === true;
  if (!gate && h.kind !== 'album' && !st) { return null; }
  const name = h.kind === 'artist' ? h.artist : h.title;
  let button = null;
  let line = '';
  let reserve = false;
  if (gate) {
    let offer = h.kind === 'folder';
    if (h.kind === 'album') {
      reserve = h.credit === 'pending';
      offer = h.credit === 'known';
      if (h.credit === 'disagree') { line = t('browse.keep.noCredit'); }
    } else if (h.kind === 'artist') {
      offer = h.takes > 0;
      line = offer ? t('browse.keep.takes', { count: h.takes, artist: h.artist }) : t('browse.keep.noArtistCopy', { artist: h.artist });
    }
    if (offer) {
      const into = st && st.live && st.state !== 'other' ? browseKeepIntoPath(h, shown.job) : '';
      let label;
      if (!st) {
        label = h.kind === 'artist' ? t('browse.keep.ofArtist', { artist: name }) : t(h.kind === 'folder' ? 'browse.keep.ofFolder' : 'browse.keep.ofItem', { name });
      } else {
        label = into ? t('browse.keep.stateIntoAria', { name, state: browseKeepSpoken(st), path: into }) : t('browse.keep.stateAria', { name, state: browseKeepSpoken(st) });
      }
      // the words shrink (a long server's name) before the box leaves the
      // column; the figure never does
      const inner = !st
        ? `${browseKeepIcon('keep', 14)}<span class="browse-keep-w">${escapeHtml(t('browse.keep.button'))}</span>`
        : `${browseKeepGlyph(st, 14)}<span class="browse-keep-w">${escapeHtml(browseKeepWord(st, 'head'))}</span>${st.state === 'copying' && st.pct != null ? `<span class="browse-keep-pct">${st.pct}%</span>` : ''}`;
      button = { cls: 'browse-keep' + (st ? ` browse-keep-on bk-${st.state}` : ''), label, quiet: JSON.stringify([st ? st.state : '', into]), inner, key: h.key };
    }
  }
  const plain = !button && st ? browseKeepMarkHtml(st, 'plain') : '';
  const own = st && st.state !== 'other';
  const v = {
    kind: h.kind, title: h.title, sub: browseHeadSub(h), tile: browseHeadTile(h), button, plain, line, reserve,
    live: own && st.live ? t('browse.keep.keepsGoing', { peer: h.peer.name }) : '',
    bar: own && st.state === 'copying' ? { pct: st.pct, label: t('browse.keep.copyingOf', { name }) } : null,
  };
  v.sig = JSON.stringify([v.kind, v.title, v.sub, v.tile, !!button, !!plain, line, reserve]);
  return v;
}

// The line under the title, from the panel's own answer.
function browseHeadSub(h) {
  if (h.kind === 'artist') { return browseKeepCount('browse.head.albumsOn', h.albums, { peer: h.peer.name }); }
  if (h.kind === 'folder') {
    return [t('browse.head.folderOn', { peer: h.peer.name }),
      h.folders ? browseKeepCount('browse.head.folders', h.folders) : '',
      h.songs ? browseKeepCount('discover.modal.songCount', h.songs) : ''].filter(Boolean).join(' · ');
  }
  return [h.albumArtist || h.artists.join(', '), h.yearLine, h.count ? browseKeepCount('discover.modal.songCount', h.count) : '',
    h.duration > 0 ? DISCOVERJOBS.fmtSeconds(h.duration) : ''].filter(Boolean).join(' · ');
}

// A count in words, its digits as the app's language groups them ("1,240
// songs"): the plural form picked by the number first, as the window's
// dmCount does.
function browseKeepCount(key, count, params) {
  const n = Number(count) || 0;
  const text = t(key, Object.assign({ count: n }, params || {}));
  return n >= 1000 ? text.replace(String(n), DISCOVERJOBS.fmtCount(n)) : text;
}

// The tile: the album's cover through the peer's art proxy (the note when
// it has none, or it does not load), the artist's person, the explorer's
// folder.
function browseHeadTile(h) {
  if (h.kind === 'artist') {
    return '<svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5.9c1.16 0 2.1.94 2.1 2.1s-.94 2.1-2.1 2.1S9.9 9.16 9.9 8s.94-2.1 2.1-2.1m0 9c2.97 0 6.1 1.46 6.1 2.1v1.1H5.9V17c0-.64 3.13-2.1 6.1-2.1M12 4C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 9c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4z"/></svg>';
  }
  if (h.kind === 'folder') {
    return '<svg width="36" height="36" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>';
  }
  const note = '<svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
  const src = h.art ? artUrl(h.art, 's') : null;
  return src ? `${note}<img src="${escapeHtml(src)}" alt="" onerror="this.remove()">` : note;
}

function browseHeadHtml(v) {
  const b = v.button;
  const row = b
    ? `<button type="button" class="${b.cls}" data-keep-key="${escapeHtml(b.key)}" onclick="browseKeepHead(this);" title="${escapeHtml(b.label)}" aria-label="${escapeHtml(b.label)}" aria-haspopup="dialog" onblur="browseHeadDraw();">${b.inner}</button>`
    : (v.plain ? `<span class="browse-keep-plain">${v.plain}</span>` : '');
  const acts = row || v.line || v.reserve || v.live
    ? `<div class="browse-head-acts"><div class="browse-head-row">${row}${v.line ? `<span class="browse-head-line">${escapeHtml(v.line)}</span>` : ''}</div><div class="browse-head-live" data-head="live">${escapeHtml(v.live)}</div></div>`
    : '';
  return `<div class="browse-head browse-head-${v.kind}" data-sig="${escapeHtml(v.sig)}">
    <div class="browse-head-tile browse-head-tile-${v.kind}" aria-hidden="true">${v.tile}</div>
    <div class="browse-head-text"><h2 class="browse-head-title">${escapeHtml(v.title)}</h2>${v.sub ? `<div class="browse-head-sub">${escapeHtml(v.sub)}</div>` : ''}</div>
    ${acts}<div data-head="bar">${browseHeadBarHtml(v.bar)}</div>
  </div>`;
}

// The thin bar along the header's foot while its own copy copies.
function browseHeadBarHtml(bar) {
  if (!bar) { return ''; }
  const now = bar.pct != null ? ` aria-valuenow="${bar.pct}" aria-valuetext="${bar.pct}%"` : '';
  return `<div class="browse-head-bar" role="progressbar" aria-label="${escapeHtml(bar.label)}" aria-valuemin="0" aria-valuemax="100"${now}><i style="width:${bar.pct != null ? bar.pct : 0}%"></i></div>`;
}

// Draw the header from its model. A redraw that changes only the state
// patches the button in place, so the keyboard stays on it while its words
// change (no live region: the window announces). A screen reader speaks a
// focused control's new name: while the keyboard rests on the button, a
// figure that only moved changes its face, not its name — that waits for
// the next state, or for the keyboard to leave (its blur draws again).
function browseHeadDraw() {
  const root = document.getElementById('browse-head');
  if (!root) { return; }
  const v = browseKeep.head ? browseHeadView(browseKeep.head) : null;
  if (!v) {
    root.classList.add('super-hide');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('super-hide');
  const box = root.firstElementChild;
  if (!box || box.getAttribute('data-sig') !== v.sig) {
    root.innerHTML = browseHeadHtml(v);
    const drawn = v.button ? root.firstElementChild.querySelector('.browse-keep') : null;
    if (drawn) { drawn.keepQuiet = v.button.quiet; }
    return;
  }
  const btn = box.querySelector('.browse-keep');
  if (btn && v.button) {
    if (btn.className !== v.button.cls) { btn.className = v.button.cls; }
    const held = document.activeElement === btn && btn.keepQuiet === v.button.quiet;
    if (!held && btn.getAttribute('aria-label') !== v.button.label) { btn.setAttribute('aria-label', v.button.label); btn.setAttribute('title', v.button.label); }
    if (!held) { btn.keepQuiet = v.button.quiet; }
    if (btn.keepInner !== v.button.inner) { btn.innerHTML = v.button.inner; btn.keepInner = v.button.inner; }
  }
  const plain = box.querySelector('.browse-keep-plain');
  if (plain && plain.keepInner !== v.plain) { plain.innerHTML = v.plain; plain.keepInner = v.plain; }
  const live = box.querySelector('[data-head="live"]');
  if (live && live.textContent !== v.live) { live.textContent = v.live; }
  const bar = box.querySelector('[data-head="bar"]');
  const barHtml = browseHeadBarHtml(v.bar);
  if (bar && bar.keepInner !== barHtml) { bar.innerHTML = barHtml; bar.keepInner = barHtml; }
}

// Where a live copy is going, for the header button's name ("…, into
// copies/Boukmanflow/Borrowed Tapes"): the destination pinned on the job,
// drawn by its scope's rule. '' when it pinned none or the place does not
// render.
function browseKeepIntoPath(h, job) {
  const D = DISCOVERJOBS;
  const d = job && job.params && job.params.destination;
  if (!d || !d.vpath) { return ''; }
  const at = { vpath: d.vpath, base: d.base || '', layout: d.layout, peerName: h.peer.name };
  let target;
  if (h.kind === 'folder') {
    const st = D.scopeTags({ scope: 'folder', songs: null });
    target = D.scopeTarget(Object.assign(at, { scope: 'folder', landing: job.params.landing || null, folder: h.path, songs: null, tags: st.tags, slots: st.slots }));
  } else if (h.kind === 'artist') {
    const st = D.scopeTags({ scope: 'artist', tags: { artist: h.artist, albumartist: h.artist } });
    target = D.scopeTarget(Object.assign(at, { scope: 'artist', tags: st.tags, slots: st.slots }));
  } else {
    const st = D.scopeTags({ scope: 'album', tags: { artist: h.albumArtist, albumartist: h.albumArtist, album: h.album, year: h.year } });
    target = D.scopeTarget(Object.assign(at, { scope: 'album', tags: st.tags, slots: st.slots }));
  }
  return target && target.valid ? target.title : '';
}

// The album page's header (getAlbumSongs, on a connected server): its
// cover, its name, and what is known — the credit, the year, how many
// songs and how long. The credit is, in order: the one every song names (a
// peer that sends 'album-artist' — the album's own, where an opener may
// name its first artist in its place, as a search hit does), the opener's
// (a card's, Discover's View album), else the peer's own album list for
// the first song's artist — exactly one album of that name (and year) with
// one credit. Until that answers the action row is held, empty; the button
// appears when the credit resolves and never goes. Credits that disagree
// get the line instead; none found, nothing. A compilation — the card's or
// the list's word, a credit of Various Artists, or a credit none of its
// songs' artists is — copies whole and is nobody's artist copy: its window
// offers Album alone. The lookups wait for it: the album's own (only with a
// credit) and its songs' (the first 99).
async function browseAlbumHead(songs, opener) {
  const peer = peerContext;
  const visit = browseKeep.visit;
  const md = songs.map((s) => (s && s.metadata) || {});
  const years = md.map((m) => Number(m.year)).filter((y) => Number.isInteger(y) && y > 0);
  const lo = years.length ? Math.min(...years) : null;
  const hi = years.length ? Math.max(...years) : null;
  const year = opener.year && Number.isInteger(Number(opener.year)) ? Number(opener.year) : (lo !== null && lo === hi ? lo : null);
  const head = {
    kind: 'album', peer, key: null, title: opener.album || '', album: opener.album, year,
    yearLine: opener.year ? String(opener.year) : (lo === null ? '' : (lo === hi ? String(lo) : `${lo}–${hi}`)),
    count: songs.length, duration: md.reduce((sum, m) => sum + (Number.isFinite(Number(m.duration)) ? Number(m.duration) : 0), 0),
    artists: md.map((m) => m.artist).filter((a, i, all) => typeof a === 'string' && a && all.indexOf(a) === i),
    art: (md.find((m) => m['album-art']) || {})['album-art'] || null,
    credit: 'pending', albumArtist: null, compilation: false, gate: keepGateOpen('album'),
  };
  browseKeep.head = head;
  const own = md.map((m) => m['album-artist']);
  let found;
  if (own.length && own.every((c) => typeof c === 'string' && c && c === own[0])) {
    found = { state: 'known', name: own[0] };
  } else if (opener.albumArtist) {
    found = { state: 'known', name: opener.albumArtist };
  } else {
    browseHeadDraw();
    const first = md.find((m) => typeof m.artist === 'string' && m.artist);
    found = { state: 'unknown' };
    if (first) {
      try {
        const res = await MSTREAMAPI.peer.artistAlbums(peer.id, { artist: first.artist });
        found = browseAlbumMatch(res && res.albums, head.album, head.year);
      } catch (_) { /* the credit stays unknown */ }
    }
    if (visit !== browseKeep.visit) { return; }
  }
  head.credit = found.state;
  head.albumArtist = found.state === 'known' ? found.name : null;
  head.compilation = !!head.albumArtist && (opener.compilation === true || found.compilation === true || browseKeepVarious(head.albumArtist)
    || browseAlbumCompilation(head.albumArtist, head.artists));
  const keys = [];
  if (head.albumArtist) {
    head.key = browseKeepKey(peer, 'album', head.album, head.albumArtist);
    browseKeepAdd(head.key, { kind: 'album', album: head.album,
      rec: browseKeepRec(peer, { album: head.album, albumArtist: head.albumArtist, artist: head.compilation ? null : head.albumArtist, year: head.year }) });
    keys.push(head.key);
  }
  browseHeadDraw();
  // each song keyed as its row's ⋯ starts it (the same title: its file's
  // name where it has none)
  for (const song of songs.slice(0, 100 - keys.length)) {
    const tr = browseKeepSongTrack(peer, song.filepath, song.metadata, null);
    const key = browseKeepKey(peer, 'song', song.filepath);
    browseKeepAdd(key, { kind: 'song', album: tr.album, filepath: song.filepath,
      rec: browseKeepRec(peer, { filepath: song.filepath, artist: tr.artist, title: tr.title, album: tr.album, year: tr.year, duration: tr.duration }) });
    keys.push(key);
  }
  browseKeepAsk(keys);
}

// "Various Artists" is nobody's artist copy (rule 1): an album credited to
// it is a compilation whatever the peer's listing says — one whose files
// carry no compilation flag lists it as compilation: false.
function browseKeepVarious(credit) {
  return DISCOVERJOBS.nameKey(credit) === 'various artists';
}

// A compilation by its songs: a credit that is none of their own artists
// ("Various Artists" over Color Out, Boukmanflow and ALM), as the window
// reads one (dmKeepCompilation). Songs that name no artist say nothing.
function browseAlbumCompilation(credit, artists) {
  const key = DISCOVERJOBS.nameKey(credit);
  return !!key && artists.length > 0 && !artists.some((a) => DISCOVERJOBS.nameKey(a) === key);
}

// The peer's album list's word on an album page's credit: the albums of
// that name (as the copy folds names) whose years hold the page's year.
// One with one credit → known (and whether the list calls it a
// compilation); one whose credits disagree (album_artist null) →
// disagree; none or several → unknown.
function browseAlbumMatch(albums, album, year) {
  const want = DISCOVERJOBS.nameKey(album);
  const y = Number(year);
  const holds = (a) => {
    if (!Number.isInteger(y) || y <= 0) { return true; }
    const min = Number(a.year_min);
    const max = Number(a.year_max);
    if (Number.isFinite(min) && Number.isFinite(max) && a.year_min != null && a.year_max != null) { return y >= min && y <= max; }
    return a.year == null || Number(a.year) === y;
  };
  const hits = (Array.isArray(albums) ? albums : []).filter((a) => a && a.name != null && DISCOVERJOBS.nameKey(a.name) === want && holds(a));
  if (!want || hits.length !== 1) { return { state: 'unknown' }; }
  return typeof hits[0].album_artist === 'string' && hits[0].album_artist
    ? { state: 'known', name: hits[0].album_artist, compilation: hits[0].compilation === true }
    : { state: 'disagree' };
}

// The artist page's header (getArtistsAlbums, on a connected server): the
// albums the peer lists for them (named ones; the singles bucket is none),
// and what an artist copy takes — the plug-in's own rule (its credit, or
// theirs outside a compilation): the window says what is left out and how
// many the library lacks. Various Artists is nobody's artist copy (the
// server's own credit for a compilation): its page, and a page whose every
// album taken is a compilation, offers none — each album keeps its card's
// ⋯. Its cards' and its own copies are looked up at once.
function browseArtistHead(artist, listing) {
  const peer = peerContext;
  const albums = listing && Array.isArray(listing.albums) ? listing.albums : [];
  const named = albums.filter((a) => a && typeof a.name === 'string' && a.name.trim());
  const plan = DISCOVERJOBS.planArtistAlbums(listing, artist).plan;
  const compilations = new Set(named.filter((a) => a.compilation === true).map((a) => DISCOVERJOBS.nameKey(a.name)));
  const nobody = browseKeepVarious(artist) || plan.every((a) => compilations.has(DISCOVERJOBS.nameKey(a.name)));
  const head = {
    kind: 'artist', peer, artist, title: artist, albums: named.length,
    takes: nobody ? 0 : plan.length, key: browseKeepKey(peer, 'artist', artist), gate: keepGateOpen('artist'),
  };
  browseKeep.head = head;
  browseKeepAdd(head.key, { kind: 'artist', rec: browseKeepRec(peer, { artist }) });
  browseHeadDraw();
  browseKeepAsk([head.key].concat(browseKeepCards(named)));
}

// A connected server's explorer page (printdir): below the library root a
// header for the open folder — counted from this listing alone, never a
// recursive scan (the window counts, once, on open) — and the folder rows'
// marks, looked up as they come near. At the root of a multi-library
// server its rows are libraries: no marks.
function browseFolderPage(response) {
  const peer = peerContext;
  const dirs = fileExplorerArray.slice();
  if (dirs.length >= 2) {
    const path = '/' + dirs.join('/');
    const name = dirs[dirs.length - 1];
    browseKeep.head = {
      kind: 'folder', peer, path, title: name, key: browseKeepKey(peer, 'folder', path), gate: keepGateOpen('folder'),
      folders: (response.directories || []).length,
      songs: (response.files || []).filter((f) => f.type !== 'm3u').length,
    };
    browseKeepAdd(browseKeep.head.key, { kind: 'folder', rec: browseKeepRec(peer, { filepath: path, title: name }) });
    browseHeadDraw();
    browseKeepAsk([browseKeep.head.key]);
  }
  if (dirs.length > 0) {
    for (const dir of response.directories || []) {
      const path = '/' + dirs.concat(dir.name).join('/');
      browseKeepAdd(browseKeepKey(peer, 'folder', path), { kind: 'folder', rec: browseKeepRec(peer, { filepath: path, title: dir.name }) });
    }
  }
  browseKeepObserve();
}

// ── The doors ────────────────────────────────────────────────────────────
// Each opens the window on what it names: the connected server it sits on
// (the row's own data-peer — a federated search mixes servers — else the
// one browsed), with the choice that fits already chosen. The opener is
// where the keyboard goes back; it carries data-keep-key, so a redrawn one
// is found again.
function browseKeepOpen(track, opts) {
  return VUEPLAYERCORE.openDiscoverModal(track, 'federation', opts);
}

// A song as the window takes it, from its row's metadata. On its album's
// page the page's credit is its album's (so This song's strip offers Album
// by the same rule); elsewhere the window finds it — the song's own
// 'album-artist' as the peer's album list bears it out: the songs of an
// album split between two artists each name their own half's.
function browseKeepSongTrack(peer, filepath, md, credit) {
  const m = md || {};
  return {
    peer, filepath, title: m.title || String(filepath).split('/').pop(), artist: m.artist, album: m.album, year: m.year,
    duration: m.duration, albumArt: m['album-art'], albumArtist: credit || undefined,
  };
}

// A song row's or a file row's ⋯ (createMusicFileHtml): the song window,
// This song chosen. On an album page the page's word on the credit goes
// with it: its credit, or that its songs name different album artists —
// no Album there either. An explorer file row carries no tags — the window
// reads them — and adds its folder as a choice (not at the library root).
function browseKeepSong(el) {
  const peer = peerOf(el) || peerContext;
  const filepath = el.getAttribute('data-file_location');
  if (!peer || !filepath) { return; }
  const entry = currentBrowsingList.find((x) => x.path === filepath);
  if (entry && entry.metadata && Object.keys(entry.metadata).length) {
    const albumPage = browseKeepAlbumPage();
    const head = albumPage && browseKeep.head && browseKeep.head.kind === 'album' ? browseKeep.head : null;
    const opts = { from: 'browse', hide: albumPage ? ['viewAlbum'] : [], opener: el };
    if (head && head.credit === 'disagree') { opts.creditsDisagree = true; }
    browseKeepOpen(browseKeepSongTrack(peer, filepath, entry.metadata, head && head.credit === 'known' ? head.albumArtist : null), opts);
    return;
  }
  const top = programState[programState.length - 1];
  const opts = { from: 'browse', opener: el };
  if (top && top.state === 'fileExplorer' && fileExplorerArray.length >= 2) {
    opts.folder = { path: '/' + fileExplorerArray.join('/'), name: fileExplorerArray[fileExplorerArray.length - 1] };
  }
  browseKeepOpen({ peer, filepath, title: (entry && entry.name) || String(filepath).split('/').pop() }, opts);
}

// A search hit's ⋯ (renderSearchRow): the song window on the hit's own
// server — in a federated search the app stays where it is.
function browseKeepHit(el) {
  const peer = peerOf(el);
  const filepath = el.getAttribute('data-file_location');
  if (!peer || !filepath) { return; }
  browseKeepOpen(browseKeepSongTrack(peer, filepath, searchResultMetadata[searchKey(peer.id, filepath)], null), { from: 'browse', hide: [], opener: el });
}

// An album card's ⋯: album focus, Album chosen; the card's credit as its
// artist — none for a compilation, the listing's or one credited to
// Various Artists (its Artist choice would be "Various Artists"). "View
// artist" is hidden on that artist's own page only: a card there credited
// to someone else (a guest's album) leads on.
function browseKeepAlbum(el) {
  const card = el.closest('.album-grid-card');
  const peer = (card && peerOf(card)) || peerContext;
  if (!card || !peer) { return; }
  const credit = card.getAttribute('data-album-artist');
  const compilation = card.getAttribute('data-compilation') === 'true' || browseKeepVarious(credit);
  const year = Number(card.getAttribute('data-year'));
  const top = programState[programState.length - 1];
  const here = !compilation && !!top && top.state === 'artist' && DISCOVERJOBS.nameKey(top.name) === DISCOVERJOBS.nameKey(credit);
  browseKeepOpen({
    peer, album: card.getAttribute('data-album'), albumArtist: credit, artist: compilation ? null : credit,
    year: Number.isInteger(year) && year > 0 ? year : null, albumArt: el.getAttribute('data-art') || null, compilation,
  }, { focus: 'album', from: 'browse', hide: here ? ['viewArtist'] : [], opener: el });
}

// A folder row's ⋯: folder focus on that folder.
function browseKeepFolder(el) {
  const peer = peerOf(el) || peerContext;
  if (!peer) { return; }
  browseKeepOpen({ peer, filepath: getDirectoryString2(el), title: el.getAttribute('data-directory') },
    { focus: 'folder', scope: 'folder', from: 'browse', opener: el });
}

// The header's "Keep a copy…": the window on the page's subject, whatever
// state the button shows (it opens the copy). An album's credit is its
// artist — none for a compilation: one choice, Album, and no Artist row.
function browseKeepHead(el) {
  const h = browseKeep.head;
  if (!h) { return; }
  if (h.kind === 'album') {
    browseKeepOpen({ peer: h.peer, album: h.album, albumArtist: h.albumArtist, artist: h.compilation ? null : h.albumArtist,
      year: h.year, albumArt: h.art, compilation: h.compilation === true, filepath: null },
    { focus: 'album', from: 'browse', hide: ['viewAlbum'], opener: el });
  } else if (h.kind === 'artist') {
    browseKeepOpen({ peer: h.peer, artist: h.artist }, { focus: 'artist', from: 'browse', opener: el });
  } else {
    browseKeepOpen({ peer: h.peer, filepath: h.path, title: h.title }, { focus: 'folder', scope: 'folder', from: 'browse', opener: el });
  }
}

// The queue row's ⋮ menu (#pop-d) is vp.js's: its createPopper2 keeps the
// row's song to itself. A press on a ⋮ is seen here first, on its way down
// (capture), so the menu's "Keep a copy…" is there for a connected
// server's song while the gate passes for a song, and gone for this
// server's — before the menu shows. The song is the row's place in the
// queue. The ⋮ is the window's opener: its row binds data-keep-key to
// the song it shows ("{peerId}|queue|{file}", browseKeepKey's), so a row
// the queue gives to another song is not that one's.
function onQueueMoreCapture(e) {
  const more = e.target && typeof e.target.closest === 'function' ? e.target.closest('.np-queue-item .popperMenu') : null;
  if (!more) { return; }
  const row = more.closest('.np-queue-item');
  const rows = row && row.parentElement ? [...row.parentElement.children].filter((el) => el.classList.contains('np-queue-item')) : [];
  const song = MSTREAMPLAYER.playlist[rows.indexOf(row)] || null;
  browseKeepQueued = song && song.federation ? { song, more } : null;
  // played from Discover or a search, never browsed: the gate's first read
  if (browseKeepQueued && !keepGate.ready) { keepGateWait().then(browseKeepQueueEntry); }
  browseKeepQueueEntry();
}

// The ⋮ menu's "Keep a copy…": shown or not for the song it is open on.
function browseKeepQueueEntry() {
  const entry = document.getElementById('pop-d-keep');
  if (entry) { entry.style.display = browseKeepQueued && keepGateOpen('song') ? '' : 'none'; }
}

// "Keep a copy…" in the queue row's ⋮ menu: the song window on that song's
// own server, as a genre or Recently Added row opens it (This song; Album
// and Artist join once the window finds the credit). The menu has closed
// on the press (vp.js's mouseup); the keyboard goes back to the row's ⋮.
function browseKeepQueue() {
  const q = browseKeepQueued;
  if (!q || !q.song.federation || !keepGateOpen('song')) { return; }
  const f = q.song.federation;
  const peer = knownPeers.get(Number(f.peerId)) || { id: Number(f.peerId), name: f.peerName || 'peer' };
  browseKeepOpen(browseKeepSongTrack(peer, q.song.filepath, q.song.metadata, null), { from: 'browse', hide: [], opener: q.more });
}

// The page's two listeners: a queue ⋮'s press, seen on its way down; and
// the window's word that the gate may have changed — a start refused 403
// or 404, a destination saved — on which it is read again, to show at the
// next draw.
function browseKeepListen() {
  document.addEventListener('click', onQueueMoreCapture, true);
  VUEPLAYERCORE.watchKeepGate(() => { keepGateRefresh(); });
}
browseKeepListen();

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
      <div class="switch">
        <label>
          <input onchange="tglArtistsShowAlbumOnly();" type="checkbox" ${VUEPLAYERCORE.altLayout.artistsShowAlbumOnly !== false ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.artistsShowAlbumOnly')}
        </label>
      </div>
      <br>
      <div class="switch">
        <label>
          <input onchange="tglArtistsIgnoreArticles();" type="checkbox" ${VUEPLAYERCORE.altLayout.artistsIgnoreArticles === true ? 'checked' : ''}>
          <span class="lever"></span>
          ${t('layout.artistsIgnoreArticles')}
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
      <a class="btn" onclick="openHotkeysModal();">${t('hotkeys.configure')}</a>
      <br><br>
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

// The two artists-list preferences (see artistsBody). Persisted with the
// other layout preferences; the Artists panel reads them on its next load.
function tglArtistsShowAlbumOnly() {
  VUEPLAYERCORE.altLayout.artistsShowAlbumOnly = VUEPLAYERCORE.altLayout.artistsShowAlbumOnly === false;
  localStorage.setItem('altLayout', JSON.stringify(VUEPLAYERCORE.altLayout));
}

function tglArtistsIgnoreArticles() {
  VUEPLAYERCORE.altLayout.artistsIgnoreArticles = VUEPLAYERCORE.altLayout.artistsIgnoreArticles !== true;
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


init();
loadFileExplorer();
