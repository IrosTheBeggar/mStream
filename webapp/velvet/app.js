'use strict';
// Feature detection — Web Animations API required for the dice throw
const _webAnimSupported = typeof Element.prototype.animate === 'function';
// ── STATE ─────────────────────────────────────────────────────
// Read once at startup — avoids 14 repeated localStorage.getItem calls inside
// the object literal (each call is a synchronous hash-map lookup + string copy).
const _u = localStorage.getItem('ms2_user') || '';
const S = {
  token:    localStorage.getItem('ms2_token') || '',
  username: _u,
  isAdmin:  false,
  discogsEnabled: false,
  radioEnabled: false,
  feedsEnabled: false,
  audiobooksEnabled: false,
  discogsAllowUpdate: false,
  allowId3Edit:   false,
  allowRadioRecording: false,   // per-user: can record radio streams
  allowYoutubeDownload: false,  // per-user: can download from YouTube
  recordingActive: false,       // is a recording currently in progress?
  recordingId: null,            // active recording id (from server)
  recordingElapsedSec: 0,       // elapsed seconds
  recordingMeta: null,          // { vpath, art, title } saved at record start
  _recordingTimer: null,        // setInterval handle
  lastfmEnabled: false,
  lastfmHasApiKey: false,
  listenbrainzEnabled: false,
  listenbrainzLinked: false,
  vpaths:   [],
  queue:    [],
  idx:      -1,
  shuffle:  false,
  repeat:   'off',   // 'off' | 'one' | 'all'
  autoDJ:   false,
  djIgnore: [],
  djMinRating: parseInt(localStorage.getItem('ms2_dj_min_rating_' + _u) || '0', 10),
  djVpaths: JSON.parse(localStorage.getItem('ms2_dj_vpaths_' + _u) || 'null') || [],
  _djPrefetching: false, // true while prefetch request is in-flight
  vpathMeta: {},     // keyed by vpath: { type, parentVpath, filepathPrefix }
  playlists:[],
  view:     'recent',
  backFn:   null,
  curSongs: [],      // songs in current view (for play-all / add-all)
  selectMode: false, // true when song-selection mode is active
  selectedIdxs: new Set(), // Set of curSongs indices chosen for ZIP
  ctxSong:  null,    // song target for context menu
  feDir:    '',      // file explorer current path
  feDirStack: [],    // navigation history stack
  audioContentReturn: null, // set when viewFiles is launched from Audio Content
  canUpload: true,   // false when server has noUpload=true
  supportedAudioFiles: {},  // populated from ping
  // Transcode
  transInfo:    null,  // { serverEnabled, defaultCodec, defaultBitrate }
  transEnabled: !!localStorage.getItem('ms2_trans_'          + _u),
  transCodec:   localStorage.getItem('ms2_trans_codec_'     + _u) || '',
  transBitrate: localStorage.getItem('ms2_trans_bitrate_'   + _u) || '',
  // Jukebox
  jukeWs:            null,
  jukeCode:          null,
  _jukePushInterval: null,
  // Playback
  crossfade: parseInt(localStorage.getItem('ms2_crossfade_' + _u) || '0'),
  sleepMins: 0,        // 0 = off; remaining minutes when active
  sleepEndsAt: 0,      // Date.now() ms timestamp when sleep fires
  // Playback quality
  rgEnabled: localStorage.getItem('ms2_rg_'       + _u) === '1',
  gapless:   localStorage.getItem('ms2_gapless_'  + _u) === '1',
  dynColor:  localStorage.getItem('ms2_dyn_color_' + _u) !== '0',  // default ON; stored as '0' when disabled
  barTop:    localStorage.getItem('ms2_bar_top_'   + _u) === '1',
  autoResume: localStorage.getItem('ms2_auto_resume_' + _u) === '1',  // default OFF — pause on page reload
  showGenres:  localStorage.getItem('ms2_show_genres_'  + _u) !== '0', // default ON
  showDecades: localStorage.getItem('ms2_show_decades_' + _u) !== '0', // default ON
  // Auto-DJ: similar-artists mode
  djSimilar: localStorage.getItem('ms2_dj_similar_' + _u) === '1',
  djDice:    localStorage.getItem('ms2_dj_dice_'    + _u) === '1',  // default OFF
  djArtistHistory: JSON.parse(localStorage.getItem('ms2_dj_artist_history_' + _u) || 'null') || [],  // rolling list of last N distinct artists
  // Auto-DJ keyword filter — default OFF; words stored as JSON array
  djFilterEnabled: localStorage.getItem('ms2_dj_filter_on_' + _u) === '1',
  djFilterWords:   JSON.parse(localStorage.getItem('ms2_dj_filter_words_' + _u) || 'null') || [],
  // Time display mode: false = elapsed|total (default), true = total|countdown
  timeFlipped: localStorage.getItem('ms2_time_flipped_' + _u) === '1',
  // Play source context — shown in "Now Playing" sub-label
  // { type: 'radio'|'podcast'|'playlist'|'smart-playlist', name: string } or null
  playSource: null,
};

let audioEl = document.getElementById('audio');
let scanTimer    = null;
let djTimer      = null;
let scrobbleTimer = null;
// ── Wrapped play tracking ────────────────────────────────────────────────────
const _wrappedSessionId = (() => {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
})();
let _wrappedEventId      = null;   // eventId from play-start; cleared on each new playAt
let _wrappedEndedNaturally = false; // true when _onAudioEnded fires — distinguishes end vs skip
let _wrappedRadioEventId  = null;   // eventId for active radio listening session
let _wrappedRadioStartMs  = 0;      // Date.now() when radio-start fired
let _wrappedPodcastEventId = null;  // eventId for active podcast episode
let _wrappedTrackStartOffset = 0;   // audioEl.currentTime when play-start fired (>0 when resumed mid-song)
let audioCtx     = null;   // shared Web Audio context (initialised by VIZ.open)
// Detect Web Audio API + 2D canvas support once at load time.
// Browsers without these (e.g. CleverShare) will have the VU column hidden.
const _webAudioSupported = (() => {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return false;
    const t = document.createElement('canvas');
    return !!(t.getContext && t.getContext('2d'));
  } catch (e) { return false; }
})();
// Polyfill canvas roundRect — available since Chrome 99 / Firefox 112 but missing on
// older embedded browsers (e.g. CleverShare). Without this every drawDial/drawKnob/
// drawPPM call throws a TypeError and canvases stay blank.
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    r = typeof r === 'number' ? [r,r,r,r] : (Array.isArray(r) ? r : [0,0,0,0]);
    while (r.length < 4) r = r.concat(r.slice(0, 4 - r.length));
    const [tl, tr, br, bl] = r;
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    this.arcTo(x + w, y,         x + w, y + tr,     tr);
    this.lineTo(x + w, y + h - br);
    this.arcTo(x + w, y + h,     x + w - br, y + h, br);
    this.lineTo(x + bl, y + h);
    this.arcTo(x,       y + h,   x, y + h - bl,     bl);
    this.lineTo(x, y + tl);
    this.arcTo(x,       y,       x + tl, y,          tl);
    this.closePath();
    return this;
  };
}
let _audioGain   = null;   // Web Audio gain node — set once in ensureAudio
let _pannerNode  = null;   // StereoPannerNode for L/R balance
let _sleepTimer  = null;   // setInterval handle for sleep countdown
let _xfadeEl     = null;   // second audio element used for crossfade
let _xfadeGainIv = null;   // setInterval handle for crossfade gain ramp
let _xfadeFired  = false;  // true once crossfade has started for the current track
let _xfadeStartVol = 0;    // audioEl.volume at the moment crossfade began
let _xfadeNextIdx  = -1;   // nextIdx stored for the ended-event handoff
let _xfadeWired  = false;  // true once _xfadeEl is connected to Web Audio
let _curElGain   = null;   // per-element GainNode for audioEl  — for scheduled swap
let _nextElGain  = null;   // per-element GainNode for _xfadeEl — for scheduled swap
let _gaplessTimer= null;   // setTimeout handle: starts xEl 80ms before end
let _msPosThrottle = 0;    // timestamp of last setPositionState call — throttled to 1 Hz
let _rgGainNode  = null;   // ReplayGain gain node — inserted before _audioGain
let _waveformData = null;  // decoded waveform array [0..255] for current track
let _waveformFp  = null;   // filepath matching _waveformData (avoids double-fetch)
let _cuePoints         = [];    // cue sheet track markers for the current file
let _cueMarkersRendered = false; // true once tick marks have been drawn for current file
let analyserL    = null;   // left-channel analyser
let analyserR    = null;   // right-channel analyser
let eqFilters    = [];     // 8 BiquadFilterNodes – built on first play

// ── HELPERS ──────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(sec) {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}
// Update both the player-bar and NP-modal time spans to reflect current
// playback position, honouring the timeFlipped display mode.
function _renderTimes() {
  if (S.queue[S.idx]?.isRadio) {
    const elapsed = _radioPlayStart ? Math.floor((Date.now() - _radioPlayStart) / 1000) : 0;
    document.getElementById('time-cur').textContent      = '0:00';
    document.getElementById('time-total').textContent    = fmt(elapsed);
    document.getElementById('np-time-cur').textContent   = '0:00';
    document.getElementById('np-time-total').textContent = fmt(elapsed);
    return;
  }
  if (!audioEl.duration) return;
  const cur   = audioEl.currentTime;
  const total = audioEl.duration;
  const lText = S.timeFlipped ? fmt(total)                      : fmt(cur);
  const rText = S.timeFlipped ? fmt(total - cur)               : fmt(total);
  document.getElementById('time-cur').textContent      = lText;
  document.getElementById('time-total').textContent    = rText;
  document.getElementById('np-time-cur').textContent   = lText;
  document.getElementById('np-time-total').textContent = rText;
}
function _toggleTimeFlipped(e) {
  e.stopPropagation();   // prevent click bubbling to the seek bar container
  S.timeFlipped = !S.timeFlipped;
  localStorage.setItem('ms2_time_flipped_' + S.username, S.timeFlipped ? '1' : '');
  _syncPrefs();
  _renderTimes();
}
function artUrl(f, size) {
  if (!f) return null;
  if (/^https?:\/\//i.test(f)) return `/api/v1/radio/art?url=${encodeURIComponent(f)}&token=${S.token}`;
  const sz = size || 's';
  return `/album-art/${encodeURIComponent(f)}?compress=${sz}&token=${S.token}`;
}
// Returns an img tag if art exists, otherwise the animated waveform placeholder
function artOrPlaceholder(f, size, extraClass) {
  const u = artUrl(f, size);
  const cls = extraClass ? ` ${extraClass}` : '';
  if (u) return `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`;
  return noArtHtml(cls);
}
function noArtHtml(extraClass) {
  return `<div class="no-art${extraClass||''}"><div class="no-art-wave"><span></span><span></span><span></span><span></span><span></span></div></div>`;
}
function encodeFp(fp) {
  // Encode each path segment so characters like # & ? don't break the URL,
  // while keeping / separators intact. express.static decodes them server-side.
  return String(fp).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
function mediaUrl(fp) {
  if (/^https?:\/\//i.test(fp)) return `/api/v1/radio/stream?url=${encodeURIComponent(fp)}&token=${S.token}`;
  const path = encodeFp(fp);
  if (S.transEnabled && S.transInfo?.serverEnabled) {
    const params = new URLSearchParams({ token: S.token });
    if (S.transCodec)   params.set('codec',   S.transCodec);
    if (S.transBitrate) params.set('bitrate', S.transBitrate);
    return `/transcode/${path}?${params}`;
  }
  return `/media/${path}?token=${S.token}`;
}
function dlUrl(fp) { return `/media/${encodeFp(fp)}?token=${S.token}`; }

// Download a list of songs as a ZIP file.
// If select mode is active with songs chosen, downloads only the selection.
// Shows a preparing indicator, triggers browser download, handles 413 size-limit error.
async function _zipDownload(songs, filename) {
  // Filter by active selection if any
  let toDownload = songs;
  if (S.selectMode && S.selectedIdxs && S.selectedIdxs.size > 0) {
    toDownload = [...S.selectedIdxs].sort((a, b) => a - b).map(i => S.curSongs[i]).filter(Boolean);
  }
  if (!toDownload || !toDownload.length) { toast('No songs to download'); return; }
  const zipBtn = document.getElementById('zip-dl-btn');
  const badge  = document.getElementById('zip-count-badge');
  if (zipBtn) { zipBtn.disabled = true; }
  if (badge)  { badge.textContent = ' …'; }
  toast('Preparing ZIP…');
  try {
    const resp = await fetch('/api/v1/download/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': S.token },
      body: JSON.stringify({
        fileArray: JSON.stringify(toDownload.map(s => s.filepath)),
        filename: filename || 'mstream-download',
      }),
    });
    if (resp.status === 413) {
      const j = await resp.json().catch(() => ({}));
      toast(`ZIP too large — server limit is ${j.maxMb || '?'} MB (increase in Admin → DB Settings)`);
      return;
    }
    if (!resp.ok) { toast('Download failed'); return; }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (filename || 'mstream-download') + '.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('ZIP downloaded');
  } catch (e) {
    toast('Download failed');
  } finally {
    if (zipBtn) { zipBtn.disabled = false; }
    _updateZipCount();
  }
}

function _updateZipCount() {
  const badge = document.getElementById('zip-count-badge');
  if (!badge) return;
  const n = (S.selectMode && S.selectedIdxs) ? S.selectedIdxs.size : 0;
  badge.textContent = n > 0 ? ` (${n})` : '';
}

function _exitSelectMode() {
  S.selectMode = false;
  S.selectedIdxs = new Set();
  document.querySelectorAll('.song-list.select-mode').forEach(l => l.classList.remove('select-mode'));
  document.querySelectorAll('.song-row.selected').forEach(r => r.classList.remove('selected'));
  const selBtn = document.getElementById('select-mode-btn');
  if (selBtn) selBtn.classList.remove('active');
  _updateZipCount();
}

function _toggleSelectMode() {
  if (S.selectMode) {
    _exitSelectMode();
  } else {
    S.selectMode = true;
    S.selectedIdxs = new Set();
    document.querySelectorAll('.song-list').forEach(l => l.classList.add('select-mode'));
    const selBtn = document.getElementById('select-mode-btn');
    if (selBtn) selBtn.classList.add('active');
    _updateZipCount();
  }
}

let _toastT;
function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'toast-error');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.add('hidden'), ms);
}
function toastError(msg, ms = 4000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('toast-error');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('toast-error'); }, ms);
}

let _similarStripT = null;
let _djSimilarFor = '';      // artist we searched Last.fm for
let _djSimilarArtists = [];  // artists Last.fm returned

function _showInfoStrip(badge, contentHtml, ms = 30000, center = false) {
  const strip = document.getElementById('dj-similar-strip');
  if (!strip) return;
  document.getElementById('dj-strip-badge').textContent = badge;
  document.getElementById('dj-strip-content').innerHTML = contentHtml;
  strip.classList.toggle('dj-strip-center', !!center);
  clearTimeout(_similarStripT);
  strip.classList.remove('dj-strip-out');
  // Reset and restart progress bar animation
  strip.style.setProperty('--strip-dur', ms > 0 ? `${ms}ms` : '0ms');
  strip.classList.remove('dj-strip-in');
  void strip.offsetWidth; // force reflow so animation restarts
  strip.classList.add('dj-strip-in');
  if (ms > 0) _similarStripT = setTimeout(() => _dismissInfoStrip(), ms);
}
function _dismissInfoStrip() {
  const strip = document.getElementById('dj-similar-strip');
  if (!strip) return;
  clearTimeout(_similarStripT);
  strip.classList.remove('dj-strip-in');
  strip.classList.add('dj-strip-out');
}
function _showDJStrip(song) {
  if (!S.autoDJ) return;
  if (!_djSimilarArtists.length) return;
  // Always use the currently-playing artist — _djSimilarFor may be stale
  // if the user manually changed songs between the pre-fetch and now.
  const _nowArtist = S.queue[S.idx]?.artist;
  if (!_nowArtist) return;
  _djSimilarFor = _nowArtist; // keep in sync so any later caller is also correct
  // Exclude the queued artist itself from the pills (it's already shown)
  const pills = _djSimilarArtists
    .filter(a => a.toLowerCase() !== (song.artist || '').toLowerCase())
    .slice(0, 10)
    .map(a => `<span class="dj-strip-pill">${esc(a)}</span>`).join('');
  const title = esc(song.title || song.filepath?.split('/').pop() || '');
  const played = title ? `${esc(song.artist || '?')} · ${title}` : esc(song.artist || '?');
  const html =
    `<span class="dj-strip-label">Similar to <strong>${esc(_djSimilarFor)}</strong></span>` +
    `<span class="dj-strip-sep">—</span>` +
    `<span class="dj-strip-label">We will play:</span>` +
    `<span class="dj-strip-queued">${played}</span>` +
    (pills ? `<span class="dj-strip-sep">—</span><span class="dj-strip-label">Other choices were:</span><span class="dj-strip-sep">&nbsp;</span><span class="dj-strip-pills">${pills}</span>` : '');
  _showInfoStrip('DJ', html, 30000); // stays until crossfade dismisses it
}

// ── QUEUE PERSISTENCE ───────────────────────────────────────
function _queueKey() { return `ms2_queue_${S.username}`; }
function _djKey(k)    { return `ms2_dj_${k}_${S.username || ''}`; }
function _uKey(k)     { return `ms2_${k}_${S.username || ''}`; }
function persistQueue() {
  if (!S.username) return;
  try {
    localStorage.setItem(_queueKey(), JSON.stringify({
      queue:   S.queue,
      idx:     S.idx,
      time:    audioEl.currentTime || 0,
      playing: !audioEl.paused,
      savedAt: Date.now(),
    }));
  } catch(_) {}
  // DB sync is intentionally NOT called here — this runs every 5 s from the
  // timeupdate timer. Use _syncQueueToDb() for structural changes only.
}
// Sync queue to DB: call only on meaningful structural changes (song change,
// add/remove/reorder, shuffle). NOT called from the 5-second position tick.
function _syncQueueToDb() {
  if (!S.token || !S.username) return;
  clearTimeout(_syncQueueTimer);
  _syncQueueTimer = setTimeout(() => {
    api('POST', 'api/v1/user/settings', { queue: {
      queue:   S.queue,
      idx:     S.idx,
      time:    audioEl.currentTime || 0,
      playing: !audioEl.paused,
      savedAt: Date.now(),
    }})
      .then(() => localStorage.setItem('ms2_settings_pushed_' + S.username, new Date().toISOString()))
      .catch(() => {});
  }, 2000);
}
function restoreQueue(silent = false) {
  const key = _queueKey();
  if (!key) return;
  let data;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch(_) { return; }
  if (!Array.isArray(data.queue) || !data.queue.length) return;

  // Restore core state — this must always succeed
  S.queue = data.queue;
  S.idx   = (typeof data.idx === 'number' && data.idx >= 0 && data.idx < data.queue.length)
            ? data.idx : 0;
  refreshQueueUI();
  if (!silent) {
    _showInfoStrip('✓',
      `<span class="dj-strip-label">Queue restored</span><span class="dj-strip-sep">·</span><span class="dj-strip-queued">${S.queue.length}</span><span class="dj-strip-title">&nbsp;song${S.queue.length !== 1 ? 's' : ''}</span>`,
      5000);
  }

  // Set up audio element — failures here must NOT break queue display
  try {
    const s = S.queue[S.idx];
    if (s) {
      // Radio streams are live — never preload on restore (no seek position to recover,
      // and opening the proxy connection only to tear it down when the user picks a
      // different track causes network/event-loop contention that produces audio cracks).
      if (!s.isRadio) {
        audioEl.src = mediaUrl(s.filepath);
        audioEl.load();
      }
      Player.updateBar();
      highlightRow();
      if (s.isRadio) { _startRadioNowPlaying(s); }
      if (!s.isRadio) {
        loadCuePoints(s.filepath);
        _fetchWaveform(s.filepath);
      }
      if (!s.isRadio && data.time > 1) {
        audioEl.addEventListener('loadedmetadata', () => {
          audioEl.currentTime = data.time;
          if (data.playing && S.autoResume) {
            if (!s.isPodcast) {
              _wrappedTrackStartOffset = data.time;
              _wrappedEndedNaturally = false;
              _wrappedEventId = null;
              api('POST', 'api/v1/wrapped/play-start', { filePath: s.filepath, sessionId: _wrappedSessionId, source: _wrappedSource() })
                .then(r => { _wrappedEventId = r?.eventId ?? null; }).catch(() => {});
            }
            audioEl.play().catch(() => {});
          }
        }, { once: true });
        // Update scrubber + time display once the seek lands
        audioEl.addEventListener('seeked', () => {
          _renderTimes();
          const pct = audioEl.duration > 0 ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
          const fill = document.getElementById('np-prog-fill');
          if (fill) fill.style.width = pct + '%';
          _drawWaveform();
        }, { once: true });
      } else if (!s.isRadio && data.playing && S.autoResume) {
        if (!s.isPodcast) {
          _wrappedTrackStartOffset = 0;
          _wrappedEndedNaturally = false;
          _wrappedEventId = null;
          api('POST', 'api/v1/wrapped/play-start', { filePath: s.filepath, sessionId: _wrappedSessionId, source: _wrappedSource() })
            .then(r => { _wrappedEventId = r?.eventId ?? null; }).catch(() => {});
        }
        audioEl.play().catch(() => {});
      }
    }
  } catch(e) { console.warn('restoreQueue audio setup failed:', e); }
  // Ensure icons always reflect reality after restore (src reassignment can
  // trigger spurious play events in some browsers before paused settles).
  syncPlayIcons();
}
// Throttled save of currentTime every 5 s while audio is playing
let _persistTimer = null;
// Navigation AbortController — cancelled every time the user switches view so
// a slow in-flight response from a previous page can never overwrite current content.
let _navAbort = null;
function _navCancel() {
  // Older browsers (CleverTouch) may not have AbortController — guard silently.
  if (typeof AbortController === 'undefined') return undefined;
  _navAbort?.abort();
  _navAbort = new AbortController();
  return _navAbort.signal;
}
// Home-view AbortController — aborted each time viewHome() re-runs so that
// accumulated body capture listeners from repeated visibility-change refreshes
// don't cause even-number-of-toggles cancellation in customize mode.
let _homeAC = null;
// Queue drag-and-drop state — module-scoped so _initQueueListeners (one-time) can close over it.
let _qDragSrc = null;

// ── API ───────────────────────────────────────────────────────
async function api(method, path, body, signal) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': S.token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // Only add signal when present — older browsers (CleverTouch) may reject
  // a fetch options object that contains an explicit signal:undefined key.
  if (signal) opts.signal = signal;
  const r = await fetch('/' + path, opts);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch (_) {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r.json();
}

// ── NORMALIZE SONG ────────────────────────────────────────────
function norm(s) {
  const m = s.metadata || s;
  return {
    title:      m.title    || null,
    artist:     m.artist   || null,
    album:      m.album    || null,
    year:       m.year     || null,
    track:      m.track    || null,
    disk:       m.disk     || null,
    genre:      m.genre    || null,
    replaygain: m['replaygain-track'] != null ? m['replaygain-track'] : (m['replaygain-track-db'] != null ? m['replaygain-track-db'] : null),
    'album-art': m['album-art'] || null,
    rating:     m.rating   || null,
    hash:       m.hash     || null,
    filepath:   s.filepath,
  };
}

// ── RATING HELPERS ────────────────────────────────────────────
function starsHtml(rating, cls) {
  const filled = Math.round((rating || 0) / 2);
  const c = cls || '';
  return Array.from({length:5}, (_,i) =>
    `<span class="${c}${i < filled ? ' s-on' : ' s-off'}">★</span>`
  ).join('');
}

const _rateTimers = new Map();
async function rateSong(filepath, rating) {
  if (!filepath || /^https?:\/\//i.test(filepath)) return;  // no rating for external streams
  clearTimeout(_rateTimers.get(filepath));
  _rateTimers.set(filepath, setTimeout(async () => {
    _rateTimers.delete(filepath);
    try {
      await api('POST', 'api/v1/db/rate-song', { filepath, rating });
      toast(rating ? `Rated ${Math.round(rating/2)} stars` : 'Rating removed');
    } catch(e) { toast('Rating failed'); }
  }, 400));
}

// ── ARTIST NORMALIZATION ──────────────────────────────────────
// Rules:
//   - Strip leading symbols/brackets/quotes/spaces
//   - Strip zero-padded track prefixes (0, 01, 09, 001 … always start with 0)
//   - Keep bare single/multi non-zero digits ("2 Brothers", "1 Alarma", "10cc")
// Three-pass approach so bracket-wrapped numbers like "(01) Name" are handled.
function normalizeArtist(name) {
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')               // pass 1: strip leading symbols/brackets
    .replace(/^0\d*[\s.,)\]]+/, '')   // pass 2: strip zero-padded number (0, 01, 09, 001…)
    .replace(noise, '')               // pass 3: strip any symbols now exposed
    .toLowerCase().trim();
}
// Same stripping logic but preserves original case — used for display, A-Z bucket, avatar letter.
function cleanArtistDisplay(name) {
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')
    .replace(/^0\d*[\s.,)\]]+/, '')
    .replace(noise, '')
    .trim();
}

// ── PLAYER ───────────────────────────────────────────────────
const Player = {
  setQueue(songs, start) {
    S.queue = [...songs];
    S.djIgnore = [];
    S.djArtistHistory = [];
    localStorage.removeItem(_djKey('artist_history'));
    _syncPrefs();
    this.playAt(start ?? 0);
  },
  playSingle(song) {
    S.queue = [song];
    S.djIgnore = [];
    S.djArtistHistory = [];
    localStorage.removeItem(_djKey('artist_history'));
    _syncPrefs();
    this.playAt(0);
  },
  // Add to queue; if nothing is playing yet, start immediately
  queueAndPlay(song) {
    if (!audioEl.src || audioEl.ended || S.queue.length === 0) {
      if (!song.isRadio && !song.isPodcast) _setPlaySource(null);
      this.playSingle(song);
    } else {
      this.addSong(song);
    }
  },
  addSong(song) {
    S.queue.push(song);
    toast('Added: ' + (song.title || song.filepath.split('/').pop()));
    refreshQueueUI();
    persistQueue();
    _syncQueueToDb();
  },
  addAll(songs) {
    S.queue.push(...songs);
    toast(`Added ${songs.length} songs to queue`);
    refreshQueueUI();
    persistQueue();
    _syncQueueToDb();
  },
  playNext(song) {
    const insertAt = S.idx + 1;
    S.queue.splice(insertAt, 0, song);
    toast('Playing next: ' + (song.title || song.filepath.split('/').pop()));
    refreshQueueUI();
    persistQueue();
    _syncQueueToDb();
  },
  playAt(idx) {
    if (idx < 0 || idx >= S.queue.length) return;
    // Wrapped: if a song was interrupted (not naturally ended), count it as a skip
    if (_wrappedEventId && !_wrappedEndedNaturally) {
      const eid = _wrappedEventId;
      _wrappedEventId = null;
      api('POST', 'api/v1/wrapped/play-skip', {
        eventId:  eid,
        playedMs: Math.max(0, Math.round(((audioEl.currentTime || 0) - _wrappedTrackStartOffset) * 1000)),
      }).catch(() => {});
    }
    S.idx = idx;
    _resetXfade();  // new track starting — arm crossfade for this track
    const s = S.queue[idx];
    audioEl.src = mediaUrl(s.filepath);
    audioEl.load();
    VIZ.initAudio();   // ensure AudioContext + analysers exist BEFORE play fires
    audioEl.play().catch(() => {});
    if (!s.isRadio) {
      loadCuePoints(s.filepath);
      _applyRGGain(s);
      _fetchWaveform(s.filepath);
    } else {
      _cuePoints = []; ['cue-markers','np-cue-markers'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
    }
    this.updateBar();
    highlightRow();
    refreshQueueUI();
    // Always log play after 30 s — independent of whether scrobbling is enabled
    clearTimeout(scrobbleTimer);
    (function(){ const el = document.getElementById('np-scrobble-status'); if (el) { el.textContent = ''; el.className = 'np-scrobble-status'; } })();
    if (!s.isRadio && !s.isPodcast) {
      api('POST', 'api/v1/db/stats/log-play', { filePath: s.filepath }).catch(() => {});
      // Wrapped: stop any active radio or podcast event, then log play-start
      if (_wrappedRadioEventId) {
        const eid = _wrappedRadioEventId; _wrappedRadioEventId = null;
        api('POST', 'api/v1/wrapped/radio-stop', { eventId: eid, listenedMs: Date.now() - _wrappedRadioStartMs }).catch(() => {});
      }
      if (_wrappedPodcastEventId) {
        const eid = _wrappedPodcastEventId; _wrappedPodcastEventId = null;
        api('POST', 'api/v1/wrapped/podcast-end', { eventId: eid, playedMs: Math.round((audioEl.currentTime || 0) * 1000), completed: false }).catch(() => {});
      }
      _wrappedEndedNaturally = false;
      _wrappedTrackStartOffset = 0;
      _wrappedEventId = null;
      api('POST', 'api/v1/wrapped/play-start', {
        filePath:  s.filepath,
        sessionId: _wrappedSessionId,
        source:    _wrappedSource(),
      }).then(r => { _wrappedEventId = r?.eventId ?? null; }).catch(() => {});
    } else if (s.isRadio) {
      // Wrapped: stop any active music/podcast event, then log radio-start
      if (_wrappedEventId) {
        const eid = _wrappedEventId; _wrappedEventId = null;
        api('POST', 'api/v1/wrapped/play-stop', { eventId: eid, playedMs: Math.max(0, Math.round(((audioEl.currentTime || 0) - _wrappedTrackStartOffset) * 1000)) }).catch(() => {});
      }
      if (_wrappedPodcastEventId) {
        const eid = _wrappedPodcastEventId; _wrappedPodcastEventId = null;
        api('POST', 'api/v1/wrapped/podcast-end', { eventId: eid, playedMs: Math.round((audioEl.currentTime || 0) * 1000), completed: false }).catch(() => {});
      }
      if (_wrappedRadioEventId) {
        const eid = _wrappedRadioEventId; _wrappedRadioEventId = null;
        api('POST', 'api/v1/wrapped/radio-stop', { eventId: eid, listenedMs: Date.now() - _wrappedRadioStartMs }).catch(() => {});
      }
      _wrappedRadioStartMs = Date.now();
      _wrappedRadioEventId = null;
      api('POST', 'api/v1/wrapped/radio-start', {
        stationName: s.title,
        stationId:   s._radioStationId ?? null,
        sessionId:   _wrappedSessionId,
      }).then(r => { _wrappedRadioEventId = r?.eventId ?? null; }).catch(() => {});
    } else if (s.isPodcast) {
      // Wrapped: stop any active music/radio event, then log podcast-start
      if (_wrappedEventId) {
        const eid = _wrappedEventId; _wrappedEventId = null;
        api('POST', 'api/v1/wrapped/play-stop', { eventId: eid, playedMs: Math.max(0, Math.round(((audioEl.currentTime || 0) - _wrappedTrackStartOffset) * 1000)) }).catch(() => {});
      }
      if (_wrappedRadioEventId) {
        const eid = _wrappedRadioEventId; _wrappedRadioEventId = null;
        api('POST', 'api/v1/wrapped/radio-stop', { eventId: eid, listenedMs: Date.now() - _wrappedRadioStartMs }).catch(() => {});
      }
      if (_wrappedPodcastEventId) {
        const eid = _wrappedPodcastEventId; _wrappedPodcastEventId = null;
        api('POST', 'api/v1/wrapped/podcast-end', { eventId: eid, playedMs: Math.round((audioEl.currentTime || 0) * 1000), completed: false }).catch(() => {});
      }
      if (s._episodeId && s._feedId) {
        _wrappedPodcastEventId = null;
        api('POST', 'api/v1/wrapped/podcast-start', {
          episodeId: s._episodeId,
          feedId:    s._feedId,
          sessionId: _wrappedSessionId,
        }).then(r => { _wrappedPodcastEventId = r?.eventId ?? null; }).catch(() => {});
      }
    }
    if ((S.lastfmEnabled || (S.listenbrainzEnabled && S.listenbrainzLinked)) && !s.isRadio && !s.isPodcast) {
      if (S.listenbrainzEnabled && S.listenbrainzLinked) {
        api('POST', 'api/v1/listenbrainz/playing-now', { filePath: s.filepath }).catch(() => {});
      }
      scrobbleTimer = setTimeout(async () => {
        const scrobbleEl = document.getElementById('np-scrobble-status');
        const msgs = [];
        if (S.lastfmEnabled) {
          try {
            await api('POST', 'api/v1/lastfm/scrobble-by-filepath', { filePath: s.filepath });
            msgs.push('Last.fm ✓');
          } catch (e) {
            msgs.push('Last.fm: ' + (e?.message || 'failed'));
          }
        }
        if (S.listenbrainzEnabled && S.listenbrainzLinked) {
          try {
            await api('POST', 'api/v1/listenbrainz/scrobble-by-filepath', { filePath: s.filepath });
            msgs.push('ListenBrainz ✓');
          } catch (e) {
            msgs.push('ListenBrainz: ' + (e?.message || 'failed'));
          }
        }
        if (scrobbleEl && msgs.length) {
          const ok = msgs.every(m => m.endsWith('✓'));
          scrobbleEl.textContent = msgs.join(' · ');
          scrobbleEl.className = 'np-scrobble-status ' + (ok ? 'np-scrobble-ok' : 'np-scrobble-err');
        }
      }, 30000);
    }
    persistQueue();
    _syncQueueToDb();
  },
  toggle() {
    // If nothing is loaded and nothing is queued — truly nothing to do
    if (!audioEl.src && !S.queue.length) return;
    // src is cleared on logout — if there's a queued track, reload it and play
    if (!audioEl.src) { this.playAt(S.idx); return; }
    // src is set: toggle play/pause regardless of queue state
    // (queue may have been cleared while a song was already loaded)
    if (audioEl.paused) {
      VIZ.initAudio();
      // If no wrapped event is active (e.g. after restoreQueue without autoResume), fire play-start now
      if (!_wrappedEventId && !_wrappedRadioEventId && !_wrappedPodcastEventId) {
        const _ts = S.queue[S.idx];
        if (_ts && !_ts.isRadio && !_ts.isPodcast) {
          _wrappedTrackStartOffset = audioEl.currentTime || 0;
          _wrappedEndedNaturally = false;
          api('POST', 'api/v1/wrapped/play-start', { filePath: _ts.filepath, sessionId: _wrappedSessionId, source: _wrappedSource() })
            .then(r => { _wrappedEventId = r?.eventId ?? null; }).catch(() => {});
        }
      }
      audioEl.play().catch(() => {});
    } else {
      if (_wrappedEventId) {
        api('POST', 'api/v1/wrapped/pause', { eventId: _wrappedEventId }).catch(() => {});
      }
      audioEl.pause();
    }
  },
  next() {
    if (!S.queue.length) return;
    if (_wrappedPodcastEventId) {
      const eid = _wrappedPodcastEventId; _wrappedPodcastEventId = null;
      api('POST', 'api/v1/wrapped/podcast-end', {
        eventId: eid, playedMs: Math.round((audioEl.currentTime || 0) * 1000), completed: false,
      }).catch(() => {});
    }
    if (_wrappedRadioEventId) {
      const eid = _wrappedRadioEventId; _wrappedRadioEventId = null;
      api('POST', 'api/v1/wrapped/radio-stop', {
        eventId: eid, listenedMs: Date.now() - _wrappedRadioStartMs,
      }).catch(() => {});
    }
    if (S.shuffle) {
      const next = Math.floor(Math.random() * S.queue.length);
      this.playAt(next);
    } else if (S.repeat === 'one') {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    } else if (S.idx < S.queue.length - 1) {
      this.playAt(S.idx + 1);
    } else if (S.repeat === 'all') {
      this.playAt(0);
    } else if (S.autoDJ && _isMusicSong(S.queue[S.idx])) {
      // If autoDJPrefetch already queued a song, just advance; otherwise fetch now
      if (S.queue.length > S.idx + 1) {
        this.playAt(S.idx + 1);
      } else {
        autoDJFetch();
      }
    }
  },
  prev() {
    if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
    if (S.idx > 0) this.playAt(S.idx - 1);
    else           audioEl.currentTime = 0;
  },
  updateBar() {
    const s = S.queue[S.idx];
    if (!s) return;
    // Reset progress bar immediately on song change
    const _fillEl  = document.getElementById('prog-fill');
    const _thumbEl = document.getElementById('prog-thumb');
    if (s.isRadio) {
      if (_fillEl)  _fillEl.style.width    = '100%';
      if (_thumbEl) { _thumbEl.style.display = 'none'; }
    } else {
      if (_fillEl)  _fillEl.style.width    = '0%';
      if (_thumbEl) { _thumbEl.style.display = ''; _thumbEl.style.left = '0%'; }
    }
    document.getElementById('player-title').textContent  = s.title  || s.filepath?.split('/').pop() || '—';
    document.getElementById('player-artist').textContent = s.artist || '';
    const albumYear = [s.album, s.year].filter(Boolean).join(' · ');
    const albumEl = document.getElementById('player-album');
    albumEl.textContent = albumYear;
    albumEl.classList.toggle('hidden', !albumYear);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ['player-title','player-artist','player-album'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('hidden')) return;
        el.classList.remove('marquee-scroll');
        el.style.removeProperty('--scroll-by');
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 10) {
          el.style.setProperty('--scroll-by', `-${overflow}px`);
          el.classList.add('marquee-scroll');
        }
      });
    }));
    const thumb = document.getElementById('player-art');
    let u = artUrl(s['album-art'], 'l');
    if (u && s['album-art-v']) u += `&_v=${encodeURIComponent(s['album-art-v'])}`;
    thumb.innerHTML = u
      ? `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`
      : noArtHtml();
    VU_NEEDLE.setArt(u || '');

    // On-demand art: if the file has no album-art yet (not scanned), ask the
    // server to extract it from the file's embedded tags and patch it in-place.
    if (!s['album-art'] && !s.isRadio && !s.isPodcast && s.filepath) {
      api('GET', `api/v1/files/art?fp=${encodeURIComponent(s.filepath)}`)
        .then(d => {
          if (!d.aaFile) return;
          // Only patch if this song is still the one playing
          if (S.queue[S.idx] !== s) return;
          s['album-art'] = d.aaFile;
          const nu = artUrl(d.aaFile, 'l');
          thumb.innerHTML = `<img src="${nu}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`;
          VU_NEEDLE.setArt(nu);
          _applyAlbumArtTheme(nu);
          _TabFav.setSong(s, !audioEl.paused);
          // Refresh queue panel art for this song
          document.querySelectorAll(`[data-qidx]`).forEach(el => {
            if (S.queue[parseInt(el.dataset.qidx)] === s) {
              const qi = el.querySelector('.q-art');
              if (qi) qi.innerHTML = `<img src="${artUrl(d.aaFile,'s')}" alt="" loading="lazy">`;
            }
          });
        })
        .catch(() => {});
    }
    // update player stars — always show 5 stars; yellow = rated, dim = unrated
    const starsEl = document.getElementById('player-stars');
    if (s.isRadio) {
      starsEl.innerHTML = '';
      starsEl.dataset.fp = '';
      starsEl.dataset.rating = '0';
    } else {
      starsEl.innerHTML = starsHtml(s.rating || 0, 'ps');
      starsEl.dataset.fp = s.filepath;
      starsEl.dataset.rating = s.rating || 0;
      _stopRadioNowPlaying();
      // Auto-stop any active recording when switching away from radio
      if (S.recordingActive) { _stopRecording(); }
    }
    // sync NP modal if open
    if (!document.getElementById('np-modal').classList.contains('hidden')) {
      renderNPModal();
    }
    // sync visualizer song info
    VIZ.songChanged();
    // Hide seek arrow on both progress bars — crossfade/song-change doesn't
    // trigger mouseleave so the arrow would stay frozen at the old position.
    document.dispatchEvent(new CustomEvent('mstream-song-change'));
    // Media Session API (OS lock-screen / notification controls)
    _updateMediaSession(s);
    // Dynamic album-art colour theming — for radio use station logo, not track art
    if (s.isRadio) { _applyAlbumArtTheme(s['album-art'] ? artUrl(s['album-art'], 'l') : null); }
    else { let _u = artUrl(s['album-art'], 'l'); if (_u && s['album-art-v']) _u += `&_v=${encodeURIComponent(s['album-art-v'])}`; _applyAlbumArtTheme(_u); }
    // Tab favicon + title
    _TabFav.setSong(s, !audioEl.paused);
    // Update record button visibility (only shown for radio + permission)
    _updateRecordBtn();
  },
};

// Returns the Wrapped source label for the currently playing context
function _wrappedSource() {
  if (S.autoDJ) return 'autodj';
  if (S.shuffle) return 'shuffle';
  if (S.playSource?.type === 'playlist') return 'playlist';
  if (S.playSource?.type === 'smart-playlist') return 'smart-playlist';
  return 'manual';
}

// \u2500\u2500 AUTO-DJ \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Returns true only for regular music songs (not radio, podcast, or audiobook vpath).
function _isMusicSong(s) {
  if (!s || s.isRadio || s.isPodcast) return false;
  const meta = S.vpathMeta || {};
  for (const v of S.vpaths) {
    if ((meta[v]?.type || 'music') !== 'audio-books') continue;
    // Standalone audiobook vpath: filepath starts with "{vpath}/"
    if (!meta[v].parentVpath && s.filepath?.startsWith(v + '/')) return false;
    // Child audiobook vpath: filepath starts with filepathPrefix
    if (meta[v].parentVpath && meta[v].filepathPrefix && s.filepath?.startsWith(meta[v].filepathPrefix)) return false;
  }
  return true;
}
// Returns vpaths of type 'music' only (excludes 'audio-books' vpaths).
function _musicVpaths() {
  const meta = S.vpathMeta || {};
  return S.vpaths.filter(v => (meta[v]?.type || 'music') !== 'audio-books');
}

// Returns {ignoreVPaths, excludeFilepathPrefixes} to strip audio-books content
// from any music DB query. Standalone audio-books → ignoreVPaths;
// child audio-books (files stored under a parent music vpath) → excludeFilepathPrefixes.
function _audioBookExclusions() {
  const meta = S.vpathMeta || {};
  const ignoreVPaths = [];
  const excludeFilepathPrefixes = [];
  for (const v of S.vpaths) {
    if ((meta[v]?.type || 'music') !== 'audio-books') continue;
    const parent = meta[v]?.parentVpath;
    if (parent) {
      const prefix = meta[v].filepathPrefix;
      if (prefix) excludeFilepathPrefixes.push({ vpath: parent, prefix });
    } else {
      ignoreVPaths.push(v);
    }
  }
  return { ignoreVPaths, excludeFilepathPrefixes };
}

// Returns { ignoreVPaths, excludeFilepathPrefixes } to restrict album views to
// only albumsOnly-flagged vpaths.  Returns {} when no vpath has the flag (no-op).
//
// Uses a WHITELIST approach (same pattern as Auto-DJ child-vpath optimisation):
// for parent vpaths that contain albumsOnly children, only include filepaths that
// start with one of the albumsOnly child's filepathPrefix — nothing else leaks through.
//   - ignoreVPaths:               drop entire root vpaths that have no albumsOnly content
//   - includeFilepathPrefixes:    whitelist — for parent vpaths, only show prefix-matched rows
function _albumsOnlyFilter() {
  const meta = S.vpathMeta || {};
  const allVpaths = S.vpaths || [];
  const hasAny = allVpaths.some(v => meta[v]?.albumsOnly);
  if (!hasAny) return {};

  const albumsOnlyVpaths = allVpaths.filter(v => meta[v]?.albumsOnly);

  // Root albumsOnly vpaths (no parentVpath) — include all files from these roots
  const keepRoots = new Set(albumsOnlyVpaths.filter(v => !meta[v]?.parentVpath));

  // Child albumsOnly vpaths — group by parent and collect their filepathPrefixes
  const prefixByParent = {}; // parentVpath -> [prefix, ...]
  for (const v of albumsOnlyVpaths) {
    if (!meta[v]?.parentVpath) continue;
    const p = meta[v].parentVpath;
    if (!prefixByParent[p]) prefixByParent[p] = [];
    if (meta[v].filepathPrefix) prefixByParent[p].push(meta[v].filepathPrefix);
  }

  // Query only: albumsOnly roots + parents of albumsOnly children
  const queryVpaths = new Set([...keepRoots, ...Object.keys(prefixByParent)]);

  // Ignore all root vpaths not in our query set
  const ignoreVPaths = allVpaths.filter(v => !meta[v]?.parentVpath && !queryVpaths.has(v));

  // Whitelist: for each parent vpath, only include rows matching one of the allowed prefixes
  const includeFilepathPrefixes = [];
  for (const [parent, prefixes] of Object.entries(prefixByParent)) {
    for (const prefix of prefixes) {
      includeFilepathPrefixes.push({ vpath: parent, prefix });
    }
  }

  const result = {};
  if (ignoreVPaths.length) result.ignoreVPaths = ignoreVPaths;
  if (includeFilepathPrefixes.length) result.includeFilepathPrefixes = includeFilepathPrefixes;
  return result;
}

// Returns true if a song should be EXCLUDED by the active keyword filter.
function _djSongBlocked(song) {
  if (!S.djFilterEnabled || !S.djFilterWords.length) return false;
  // Normalise: lowercase + collapse repeated characters (acappella == acapella)
  const norm = s => s.toLowerCase().replace(/(.)\1+/g, '$1');
  const haystack = norm([
    song.title    || '',
    song.artist   || '',
    song.album    || '',
    song.filepath || '',
  ].join(' '));
  return S.djFilterWords.some(w => w && haystack.includes(norm(w)));
}

// Shared helper — returns {ignoreList, songs} from the random-songs API
async function _djApiCall() {
  const selected = S.djVpaths.length > 0 ? S.djVpaths : S.vpaths;

  // Child-vpath optimisation: if every selected vpath is a child of the
  // same parent (stored under the parent vpath in the DB), use a
  // filepathPrefix filter on the parent instead of ignoreVPaths.
  const meta = S.vpathMeta || {};
  const abEx = _audioBookExclusions();
  const _epParam = abEx.excludeFilepathPrefixes.length > 0 ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {};
  const allChildSameParent =
    selected.length > 0 &&
    selected.every(v => meta[v]?.parentVpath) &&
    new Set(selected.map(v => meta[v].parentVpath)).size === 1;

  // Similar-artists mode: bias towards artists similar to the current track
  let artistFilter;
  if (S.djSimilar && S.queue[S.idx]?.artist) {
    const currentArtist = S.queue[S.idx].artist;
    try {
      const d = await api('GET', `api/v1/lastfm/similar-artists?artist=${encodeURIComponent(currentArtist)}`);
      if (d.artists && d.artists.length > 0) {
        artistFilter = d.artists;
        _djSimilarFor = currentArtist;
        _djSimilarArtists = artistFilter;
        console.log(`[Auto-DJ] Last.fm similar to "${currentArtist}":`, artistFilter);
      } else {
        console.warn(`[Auto-DJ] Last.fm returned no similar artists for "${currentArtist}" — playing random`);
        _djSimilarFor = currentArtist;
        _djSimilarArtists = [];
        _showInfoStrip('Auto-DJ', `Last.fm has no similar artists for <strong>${esc(currentArtist)}</strong> — playing random`, 8000);
      }
    } catch (_e) {
      console.error(`[Auto-DJ] Last.fm call failed for "${currentArtist}":`, _e);
      _djSimilarFor = currentArtist;
      _djSimilarArtists = [];
      _showInfoStrip('Auto-DJ', `Last.fm lookup failed for <strong>${esc(currentArtist)}</strong> — playing random`, 8000);
    }
  }

  if (allChildSameParent) {
    const parentVpath = meta[selected[0]].parentVpath;
    const filepathPrefix = selected.length === 1 ? meta[selected[0]].filepathPrefix : null;
    const ignoreVPaths = S.vpaths.filter(v => v !== parentVpath && !meta[v]?.parentVpath);
    try {
      return await api('POST', 'api/v1/db/random-songs', {
        ignoreList:    S.djIgnore,
        minRating:     S.djMinRating || undefined,
        ignoreVPaths:  ignoreVPaths.length > 0 ? ignoreVPaths : undefined,
        filepathPrefix: filepathPrefix || undefined,
        artists:       artistFilter,
        ignoreArtists: S.djArtistHistory.length > 0 ? S.djArtistHistory : undefined,
        ..._epParam,
      });
    } catch(e) {
      // artists filter returned no library matches — fall back to random
      if (artistFilter && e.status === 400) {
        console.warn('[Auto-DJ] No library songs for similar artists, falling back to random');
        _showInfoStrip('Auto-DJ', `No songs found in your library for Last.fm&apos;s suggestions — playing random`, 8000);
        return api('POST', 'api/v1/db/random-songs', {
          ignoreList:    S.djIgnore,
          minRating:     S.djMinRating || undefined,
          ignoreVPaths:  ignoreVPaths.length > 0 ? ignoreVPaths : undefined,
          filepathPrefix: filepathPrefix || undefined,
          ignoreArtists: S.djArtistHistory.length > 0 ? S.djArtistHistory : undefined,
          ..._epParam,
        });
      }
      throw e;
    }
  }

  try {
    return await api('POST', 'api/v1/db/random-songs', {
      ignoreList:   S.djIgnore,
      minRating:    S.djMinRating || undefined,
      ignoreVPaths: S.vpaths.filter(v => !selected.includes(v)).length > 0 ? S.vpaths.filter(v => !selected.includes(v)) : undefined,
      artists:      artistFilter,
      ignoreArtists: S.djArtistHistory.length > 0 ? S.djArtistHistory : undefined,
      ..._epParam,
    });
  } catch(e) {
    // artists filter returned no library matches — fall back to random
    if (artistFilter && e.status === 400) {
      console.warn('[Auto-DJ] No library songs for similar artists, falling back to random');
      _djSimilarArtists = [];  // prevent _showDJStrip from showing "similar to" for a random fallback
      _showInfoStrip('Auto-DJ', `No songs found in your library for Last.fm&apos;s suggestions — playing random`, 8000);
      const ignoreVPaths = S.vpaths.filter(v => !selected.includes(v));
      return api('POST', 'api/v1/db/random-songs', {
        ignoreList:   S.djIgnore,
        minRating:    S.djMinRating || undefined,
        ignoreVPaths: ignoreVPaths.length > 0 ? ignoreVPaths : undefined,
        ignoreArtists: S.djArtistHistory.length > 0 ? S.djArtistHistory : undefined,
        ..._epParam,
      });
    }
    throw e;
  }
}

// Pre-fetch: silently queue the next DJ song without playing it
const DJ_ARTIST_COOLDOWN = 15; // minimum songs between the same artist
function _djPushArtistHistory(artist) {
  if (!artist) return;
  // Remove any earlier occurrence of this artist, then push to end
  const norm = artist.trim().toLowerCase();
  S.djArtistHistory = S.djArtistHistory.filter(a => a.toLowerCase() !== norm);
  S.djArtistHistory.push(artist.trim());
  if (S.djArtistHistory.length > DJ_ARTIST_COOLDOWN) S.djArtistHistory.shift();
  localStorage.setItem(_djKey('artist_history'), JSON.stringify(S.djArtistHistory));
  _syncPrefs();
}

// Rolling queue cap — prune tracks that are already behind the cursor so the
// queue never grows without bound. Keeps 10 tracks of history behind the cursor.
// Critical on slow hardware (CleverTouch, single-CPU) where a large queue makes
// persistQueue() / JSON.stringify stutter during playback.
const DJ_QUEUE_CAP = 500;
function _pruneQueue() {
  if (S.queue.length < DJ_QUEUE_CAP || S.idx < 15) return;
  const prune = Math.min(S.idx - 10, S.queue.length - DJ_QUEUE_CAP + 1);
  if (prune > 0) {
    S.queue.splice(0, prune);
    S.idx = Math.max(0, S.idx - prune);
  }
}

async function autoDJPrefetch() {
  if (S._djPrefetching) return;          // already in-flight
  if (S.queue.length > S.idx + 1) return; // already pre-queued
  S._djPrefetching = true;
  try {
    let d, song, attempts = 0;
    do {
      d    = await _djApiCall();
      S.djIgnore = d.ignoreList;
      localStorage.setItem(_djKey('ignore'), JSON.stringify(S.djIgnore));
      song = norm(d.songs[0]);
      attempts++;
    } while (_djSongBlocked(song) && attempts < 10);
    _djPushArtistHistory(song.artist);
    // Only push if nothing was added while we were waiting (autoDJFetch race guard)
    if (S.queue.length <= S.idx + 1) {
      _pruneQueue();
      S.queue.push(song);
      refreshQueueUI();      // update queue panel FIRST so it's visible before strip appears
      _showDJStrip(song);
    }
  } catch(e) { console.error('Auto-DJ prefetch failed:', e); }
  finally { S._djPrefetching = false; }
}

// Full fetch + play: fallback when prefetch wasn't ready by the time the song ended.
// Shares the _djPrefetching flag with autoDJPrefetch — if prefetch is currently
// in-flight we wait for it instead of firing a second parallel API chain.
async function autoDJFetch() {
  // If prefetch is already running, wait up to 12 s for it to finish rather
  // than launching a duplicate set of API calls at the worst possible moment.
  if (S._djPrefetching) {
    let waited = 0;
    await new Promise(resolve => {
      const iv = setInterval(() => {
        waited += 200;
        if (!S._djPrefetching || waited >= 12000) { clearInterval(iv); resolve(); }
      }, 200);
    });
    // Prefetch succeeded and added the song — just play it
    if (S.queue.length > S.idx + 1) { Player.playAt(S.idx + 1); return; }
  }
  S._djPrefetching = true;
  try {
    let d, song, attempts = 0;
    do {
      d    = await _djApiCall();
      S.djIgnore = d.ignoreList;
      localStorage.setItem(_djKey('ignore'), JSON.stringify(S.djIgnore));
      song = norm(d.songs[0]);
      attempts++;
    } while (_djSongBlocked(song) && attempts < 10);
    _djPushArtistHistory(song.artist);
    _pruneQueue();
    S.queue.push(song);
    refreshQueueUI();      // update queue panel FIRST so it's visible before strip appears
    _showDJStrip(song);
    Player.playAt(S.queue.length - 1);
  } catch(e) {
    console.error('Auto-DJ fetch failed:', e);
    toast('Auto-DJ: could not load next song — check connection');
  } finally { S._djPrefetching = false; }
}

function setAutoDJ(on, skipAutoStart) {
  if (on && !_isMusicSong(S.queue[S.idx])) {
    toast('Auto-DJ only works with music — stop radio, podcasts or audiobooks first');
    return;
  }
  S.autoDJ = on;
  localStorage.setItem(_uKey('autodj'), on ? '1' : '');
  document.getElementById('dj-light').classList.toggle('dj-inactive', !on);
  _syncPrefs();
  _syncQueueLabel();
  // update autodj page if visible
  const btn = document.querySelector('.autodj-toggle');
  if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '⏹ Stop Auto-DJ' : '▶ Start Auto-DJ'; }
  const status = document.querySelector('.autodj-status');
  if (status) { status.classList.toggle('on', on); status.textContent = on ? 'Auto-DJ is ON — random songs will play continuously' : 'Auto-DJ is OFF'; }
  if (on && !skipAutoStart) {
    if (!audioEl.src || audioEl.ended || S.queue.length === 0) {
      // Nothing playing and nothing queued — fetch a new song and play it
      autoDJFetch();
    } else if (audioEl.paused) {
      // Song is queued/loaded but paused — just start playing
      VIZ.initAudio();
      audioEl.play().catch(() => {});
    }
    // If already playing, Auto-DJ will take over naturally at end of track
  }
}

// ── ON-DEMAND ART FETCH ───────────────────────────────────────────────────────
// For songs that have no album-art (not yet scanned), request extraction from
// the server and patch the art immediately in both the songs array and the DOM.
// songs   — array of song objects (queue or file-list)
// container — DOM element that holds the rendered rows (.q-art or .row-art divs)
// selector  — CSS selector for the art container within each row
// rowAttr   — data attribute on each row that holds the index into songs[]
function _fetchMissingArt(songs, container, selector, rowAttr) {
  if (!songs || !container) return;
  songs.forEach((s, i) => {
    if (s['album-art'] || s.isRadio || s.isPodcast || !s.filepath) return;
    api('GET', `api/v1/files/art?fp=${encodeURIComponent(s.filepath)}`)
      .then(d => {
        if (!d || !d.aaFile) return;
        s['album-art'] = d.aaFile;
        // Patch every matching row in this container
        container.querySelectorAll(`[${rowAttr}="${i}"]`).forEach(row => {
          const artDiv = row.querySelector(selector);
          if (!artDiv) return;
          const u = artUrl(d.aaFile, 's');
          artDiv.innerHTML = `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">`;
        });
        // Also patch the Now-Playing card if this is the current song
        if (S.queue[S.idx] === s) {
          const npArt = document.querySelector('.qp-np-art');
          if (npArt) npArt.innerHTML = `<img src="${artUrl(d.aaFile,'m')}" alt="" loading="lazy">`;
        }
      })
      .catch(() => {});
  });
}

// ── QUEUE UI ─────────────────────────────────────────────────
function refreshQueueUI() {
  const list   = document.getElementById('queue-list');
  const cnt    = document.getElementById('qp-count');
  const badge  = document.getElementById('queue-count');
  const npCard = document.getElementById('qp-np-card');

  // Player bar badge
  if (S.queue.length) {
    badge.textContent = String(S.queue.length);
    badge.classList.add('show');
  } else { badge.classList.remove('show'); }

  // "Up Next" count (songs after current)
  const upNext = S.idx >= 0 ? Math.max(0, S.queue.length - S.idx - 1) : S.queue.length;
  cnt.textContent = upNext ? `(${upNext})` : '';

  // Now Playing card
  const cur = S.queue[S.idx];
  if (cur) {
    npCard.innerHTML = `
      <div class="qp-np-track">
        <div class="qp-np-art">
          ${artOrPlaceholder(cur['album-art'], 'm', 'no-art-sm')}
        </div>
        <div class="qp-np-info">
          <div class="qp-np-title">${esc(cur.title || cur.filepath?.split('/').pop() || '—')}</div>
          <div class="qp-np-artist">${esc(cur.artist || '')}</div>
          ${cur.rating ? `<div class="qp-np-stars" style="margin-top:3px">${starsHtml(cur.rating)}</div>` : ''}
        </div>
      </div>`;
  } else {
    npCard.innerHTML = `<div class="qp-np-empty">Nothing playing yet — click any song to start</div>`;
  }

  // Queue items
  if (!S.queue.length) {
    list.innerHTML = `
      <div class="q-empty-state">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <p>Queue is empty.<br>Click <strong>+</strong> on any song to add it here.</p>
      </div>`;
    _syncQueueLabel();
    return;
  }

  list.innerHTML = S.queue.map((s, i) => {
    const isActive = i === S.idx;
    const prevLabel = i > 0 ? S.queue[i - 1]._discLabel : undefined;
    const sep = (s._discLabel && s._discLabel !== prevLabel)
      ? `<div class="q-disc-sep"><span>${esc(s._discLabel)}</span></div>`
      : '';
    return sep + `
      <div class="q-item${isActive ? ' q-active' : ''}" data-qi="${i}" draggable="true">
        <div class="q-drag-handle" title="Drag to reorder">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" opacity=".7">
            <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
            <circle cx="3" cy="7"   r="1.2"/><circle cx="7" cy="7"   r="1.2"/>
            <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
          </svg>
        </div>
        <div class="q-num">${isActive
          ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`
          : i + 1}
        </div>
        <div class="q-art">
          ${artOrPlaceholder(s['album-art'], 's', 'no-art-sm')}
        </div>
        <div class="q-info">
          <div class="q-title">${esc(s.title || s.filepath?.split('/').pop() || '?')}</div>
          <div class="q-artist">${esc(s.artist || '')}</div>
        </div>
        <button class="q-remove" data-qi="${i}" title="Remove from queue">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
  }).join('');

  const active = list.querySelector('.q-active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  _syncQueueLabel();

  // Fetch art for any queued songs not yet scanned
  _fetchMissingArt(S.queue, list, '.q-art', 'data-qi');
}

// ── One-time queue event-listener setup ──────────────────────────────────────
// MUST be called exactly once after the app boots. Delegated listeners work
// even when #queue-list innerHTML is replaced by refreshQueueUI().
function _initQueueListeners() {
  const list = document.getElementById('queue-list');
  if (!list) return;

  list.addEventListener('click', e => {
    const removeBtn = e.target.closest('.q-remove');
    if (removeBtn) {
      e.stopPropagation();
      const i = parseInt(removeBtn.dataset.qi);
      S.queue.splice(i, 1);
      if (S.idx >= i && S.idx > 0) S.idx--;
      persistQueue();
      _syncQueueToDb();
      refreshQueueUI();
      return;
    }
    const item = e.target.closest('.q-item');
    if (!item || e.target.closest('.q-drag-handle')) return;
    Player.playAt(parseInt(item.dataset.qi));
  });

  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.q-item');
    if (!item) return;
    _qDragSrc = parseInt(item.dataset.qi);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _qDragSrc);
    setTimeout(() => item.classList.add('q-dragging'), 0);
  });
  list.addEventListener('dragend', e => {
    const item = e.target.closest('.q-item');
    if (item) item.classList.remove('q-dragging');
    list.querySelectorAll('.q-drag-over').forEach(el => el.classList.remove('q-drag-over'));
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.q-item');
    if (!item || item.classList.contains('q-drag-over')) return;
    list.querySelectorAll('.q-drag-over').forEach(el => el.classList.remove('q-drag-over'));
    item.classList.add('q-drag-over');
  });
  list.addEventListener('dragleave', e => {
    const item = e.target.closest('.q-item');
    if (item && !item.contains(e.relatedTarget)) item.classList.remove('q-drag-over');
  });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const item = e.target.closest('.q-item');
    if (!item) return;
    const to = parseInt(item.dataset.qi);
    if (_qDragSrc === null || _qDragSrc === to) { _qDragSrc = null; return; }
    const from = _qDragSrc;
    _qDragSrc = null;

    const [moved] = S.queue.splice(from, 1);
    S.queue.splice(to, 0, moved);

    if      (S.idx === from)                  S.idx = to;
    else if (from < S.idx && to >= S.idx)     S.idx--;
    else if (from > S.idx && to <= S.idx)     S.idx++;

    persistQueue();
    _syncQueueToDb();
    refreshQueueUI();
  });
}

function toggleQueue() {
  const panel = document.getElementById('queue-panel');
  panel.classList.toggle('collapsed');
  document.getElementById('queue-btn').classList.toggle('active', !panel.classList.contains('collapsed'));
}

// ── HIGHLIGHT ────────────────────────────────────────────────
function highlightRow() {
  document.querySelectorAll('.song-row.playing').forEach(r => r.classList.remove('playing'));
  const cur = S.queue[S.idx];
  if (!cur) return;
  document.querySelectorAll('.song-row').forEach(r => {
    const i = parseInt(r.dataset.ci);
    if (!isNaN(i) && S.curSongs[i] && S.curSongs[i].filepath === cur.filepath) {
      r.classList.add('playing');
    }
  });
}

// ── VIEW HELPERS ──────────────────────────────────────────────
function setTitle(t)  { document.getElementById('content-title').textContent = t; }
function setBody(html) {
  const b = document.getElementById('content-body');
  b.classList.remove('browse-mode');
  b.innerHTML = html;
}
function setBack(fn) {
  S.backFn = fn;
  document.getElementById('back-btn').classList.toggle('hidden', !fn);
}
function setNavActive(view) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.pl-row').forEach(r => r.classList.remove('active'));
  _exitSelectMode();
  const zb = document.getElementById('zip-dl-btn');
  if (zb) { zb.classList.add('hidden'); zb.onclick = null; }
  const sb = document.getElementById('select-mode-btn');
  if (sb) { sb.classList.add('hidden'); sb.onclick = null; }
}
function setPlaylistActive(name) {
  document.querySelectorAll('.pl-row').forEach(r => {
    r.classList.toggle('active', r.dataset.pl === name);
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
}
function setSplActive(id) {
  document.querySelectorAll('.pl-row').forEach(r => {
    r.classList.toggle('active', r.dataset.splid !== undefined && parseInt(r.dataset.splid, 10) === id);
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  _exitSelectMode();
  const zb = document.getElementById('zip-dl-btn');
  if (zb) { zb.classList.add('hidden'); zb.onclick = null; }
  const sb = document.getElementById('select-mode-btn');
  if (sb) { sb.classList.add('hidden'); sb.onclick = null; }
}
// Set the "Now Playing" context label (radio / podcast / playlist / smart-playlist)
// Pass null to clear (generic library/queue play)
function _setPlaySource(type, name) {
  S.playSource = (type && name) ? { type, name } : null;
}

// ── SONG ROWS ────────────────────────────────────────────────
function renderSongRows(songs) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    return `<div class="song-row" data-ci="${i}">
      <div class="row-num">
        <div class="row-check"></div>
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        <div class="song-sub">${esc(artist)}${esc(album)}</div>
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

// Like renderSongRows but shows the file path under the subtitle — used in search results
function renderSongRowsWithPath(songs) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    // Show path without the filename at the end for ID3-matched songs,
    // or the full relative path for filename-matched songs
    const pathDir = s.filepath ? s.filepath.split('/').slice(0, -1).join('\\') : '';
    return `<div class="song-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        ${artist || album ? `<div class="song-sub">${esc(artist)}${esc(album)}</div>` : ''}
        ${pathDir ? `<div class="song-path" title="${esc(s.filepath)}">📁 ${esc(pathDir)}</div>` : ''}
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

// Lightweight text-only rows for search results — no album-art <img> tags.
// On slow browsers (CleverTouch) each image triggers a network round-trip +
// decode + layout reflow; 50 images in one innerHTML write stalls the CPU for
// 10-30 s and stops music playback. Plain text rows render ~10x faster.
function renderSearchRows(songs) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const pathDir = s.filepath ? s.filepath.split('/').slice(0, -1).join('\\') : '';
    return `<div class="song-row search-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="song-info search-row-info">
        <div class="song-title">${esc(title)}</div>
        ${artist || album ? `<div class="song-sub">${esc(artist)}${esc(album)}</div>` : ''}
        ${pathDir ? `<div class="song-path" title="${esc(s.filepath)}">📁 ${esc(pathDir)}</div>` : ''}
      </div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderMostPlayedRows(songs, maxPlays) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    const plays  = s._playCount || 0;
    const pct    = maxPlays > 0 ? Math.max(3, Math.round((plays / maxPlays) * 100)) : 0;
    return `<div class="song-row mp-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        <div class="song-sub">${esc(artist)}${esc(album)}</div>
      </div>
      <div class="mp-count-cell">
        <div class="mp-bar-track"><div class="mp-bar-fill" style="width:${pct}%"></div></div>
        <span class="mp-num">${plays}</span>
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function showMostPlayed(songs) {
  S.curSongs = songs;
  document.getElementById('play-all-btn').onclick = () => {
    if (songs.length) { _setPlaySource(null); Player.setQueue(songs, 0); toast(`Playing ${songs.length} songs`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (songs.length) { Player.addAll(songs); }
  };
  if (!songs.length) { setBody('<div class="empty-state">No songs found</div>'); return; }
  const maxPlays = Math.max(...songs.map(s => s._playCount || 0));
  const body = document.getElementById('content-body');
  body.innerHTML = `<div class="song-list">${renderMostPlayedRows(songs, maxPlays)}</div>`;
  attachSongListEvents(body, songs);
  highlightRow();
}

function attachSongListEvents(container, songs) {
  container.querySelectorAll('.song-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.add-btn') || e.target.closest('.ctx-btn') || e.target.closest('.row-stars')) return;
      const i = parseInt(row.dataset.ci);
      if (S.selectMode) {
        if (S.selectedIdxs.has(i)) { S.selectedIdxs.delete(i); row.classList.remove('selected'); }
        else { S.selectedIdxs.add(i); row.classList.add('selected'); }
        _updateZipCount();
        return;
      }
      if (songs[i]) Player.queueAndPlay(songs[i]);
    });
  });
  container.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.ci);
      if (songs[i]) Player.addSong(songs[i]);
    });
  });
  container.querySelectorAll('.ctx-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.ci);
      S.ctxSong = songs[i];
      showCtxMenu(e.clientX, e.clientY);
    });
  });
  container.querySelectorAll('.row-stars').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(el.dataset.ci);
      if (songs[i]) showRatePanel(e.clientX, e.clientY, songs[i]);
    });
  });
}

function showSongs(songs, title, zipFilename) {
  _exitSelectMode();
  S.curSongs = songs;
  document.getElementById('play-all-btn').onclick = () => {
    if (songs.length) { _setPlaySource(null); Player.setQueue(songs, 0); toast(`Playing ${songs.length} songs`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (songs.length) { Player.addAll(songs); }
  };
  const zipBtn = document.getElementById('zip-dl-btn');
  const selBtn = document.getElementById('select-mode-btn');
  if (zipFilename) {
    if (zipBtn) { zipBtn.classList.remove('hidden'); zipBtn.onclick = () => _zipDownload(songs, zipFilename); }
    if (selBtn) { selBtn.classList.remove('hidden'); selBtn.onclick = _toggleSelectMode; }
  } else {
    if (zipBtn) { zipBtn.classList.add('hidden'); zipBtn.onclick = null; }
    if (selBtn) { selBtn.classList.add('hidden'); selBtn.onclick = null; }
  }
  if (!songs.length) { setBody('<div class="empty-state">No songs found</div>'); return; }
  const body = document.getElementById('content-body');
  body.innerHTML = `<div class="song-list">${renderSongRows(songs)}</div>`;
  attachSongListEvents(body, songs);
  highlightRow();

  // Fetch art for unscanned files (e.g. fresh recordings/downloads)
  _fetchMissingArt(songs, body.querySelector('.song-list'), '.row-art', 'data-ci');
}

// ── CONTEXT MENU ─────────────────────────────────────────────
function showCtxMenu(x, y) {
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('hidden');
  // Show remove-from-playlist only when inside a playlist view
  const inPlaylist = typeof S.view === 'string' && S.view.startsWith('playlist:');
  menu.querySelector('.ctx-remove-pl').classList.toggle('hidden', !inPlaylist);
  // Show delete-recording only when song is from a recordings vpath with allowRecordDelete
  const song = S.ctxSong;
  const songVpath = song?.filepath?.split('/')[0];
  const canDelete = songVpath &&
    (S.vpathMeta?.[songVpath]?.type === 'recordings' || S.vpathMeta?.[songVpath]?.type === 'youtube') &&
    S.vpathMeta?.[songVpath]?.allowRecordDelete === true;
  menu.querySelector('.ctx-delete-rec').classList.toggle('hidden', !canDelete);
  menu.querySelector('.ctx-delete-rec-divider').classList.toggle('hidden', !canDelete);
  // Keep within viewport
  const mw = 180, mh = canDelete ? 230 : 200;
  const left = Math.min(x, window.innerWidth  - mw - 8);
  const top  = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}
function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
  hideRatePanel();
}

function showRatePanel(x, y, song) {
  const panel = document.getElementById('rate-panel');
  panel.classList.remove('hidden');
  panel.dataset.fp = song.filepath;
  const currentStars = Math.round((song.rating || 0) / 2);
  // highlight current rating
  panel.querySelectorAll('.rate-stars span').forEach((s, i) => {
    s.classList.toggle('lit', i < currentStars);
  });
  const pw = 180, ph = 80;
  const left = Math.min(x + 4, window.innerWidth  - pw - 8);
  const top  = Math.min(y, window.innerHeight - ph - 8);
  panel.style.left = left + 'px';
  panel.style.top  = top  + 'px';
}
function hideRatePanel() {
  document.getElementById('rate-panel').classList.add('hidden');
}

// ── NOW PLAYING MODAL ──────────────────────────────────────────
function renderNPModal() {
  const s = S.queue[S.idx];
  if (!s) return;
  const isRadio = !!s.isRadio;
  const u = artUrl(s['album-art'], 'l');
  // Blurred glow background
  const blurEl = document.getElementById('np-art-blur');
  if (blurEl) blurEl.style.backgroundImage = u ? `url(${u})` : '';
  // Square art
  document.getElementById('np-art').innerHTML = u
    ? `<img src="${u}" alt="" onerror="this.parentNode.innerHTML=noArtHtml()">`
    : noArtHtml();
  document.getElementById('np-title').textContent  = s.title  || s.filepath?.split('/').pop() || '—';
  document.getElementById('np-artist').textContent = s.artist || '';
  const sub = [s.album, s.year].filter(Boolean).join(' · ');
  const albumEl = document.getElementById('np-album');
  albumEl.textContent = sub;
  albumEl.classList.toggle('hidden', !sub);
  const filled = Math.round((s.rating || 0) / 2);
  document.querySelectorAll('#np-rate-stars span').forEach((star, i) => {
    star.classList.toggle('lit', i < filled);
  });
  document.getElementById('np-icon-play').classList.toggle('hidden', !audioEl.paused);
  document.getElementById('np-icon-pause').classList.toggle('hidden', audioEl.paused);
  if (s.isRadio) {
    document.getElementById('np-prog-fill').style.width = '100%';
  } else if (audioEl.duration) {
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    document.getElementById('np-prog-fill').style.width   = pct + '%';
    _renderTimes();
  }
  // Full metadata table
  function mv(val) {
    return val != null ? `<span class="np-meta-v">${esc(String(val))}</span>` : `<span class="np-meta-v dim">—</span>`;
  }
  const starStr = s.rating ? `${'\u2605'.repeat(Math.round(s.rating/2))}${'\u2606'.repeat(5-Math.round(s.rating/2))}` : null;
  const rgStr   = s.replaygain != null ? `${s.replaygain > 0 ? '+' : ''}${Number(s.replaygain).toFixed(2)} dB` : null;
  const rows = [
    ['Title',       s.title],
    ['Artist',      s.artist],
    ['Album',       s.album],
    ['Year',        s.year],
    ['Genre',       s.genre],
    ['Track',       s.track],
    ['Disc',        s.disk],
    ['Rating',      starStr],
    ['Replay Gain', rgStr],
  ];
  document.getElementById('np-meta').innerHTML = isRadio ? '' : rows.map(([k, v]) =>
    `<span class="np-meta-k">${k}</span>${mv(v)}`
  ).join('');
  // Filepath block
  const fpEl = document.getElementById('np-filepath');
  if (s.filepath && !isRadio) {
    const parts = s.filepath.split('/');
    const fname = parts.pop();
    const dirParts = parts.filter(Boolean);
    const dirHtml = dirParts.map(p => `<span class="np-fp-dir">${esc(p)}</span><span class="np-fp-sep">\\</span>`).join('');
    fpEl.innerHTML = `<span class="np-fp-label">File Path</span><div class="np-fp-path">${dirHtml}<span class="np-fp-file">${esc(fname)}</span></div>`;
    fpEl.classList.remove('hidden');
  } else {
    fpEl.innerHTML = '';
    fpEl.classList.add('hidden');
  }
  // Discogs cover-art section (admin only)
  const _dsEl = document.getElementById('np-discogs-section');
  if (_dsEl) {
    if (!isRadio && S.isAdmin && S.discogsEnabled && (!s['album-art'] || S.discogsAllowUpdate)) {
      _dsEl.classList.remove('hidden');
      // Reset if the song changed — don't keep stale search results
      if (_dsEl.dataset.songFp !== (s.filepath || '')) {
        _dsEl.dataset.songFp = s.filepath || '';
        const _ext = (s.filepath || '').split('.').pop().toLowerCase();
        const _wavLike = ['wav','aiff','aif','w64'].includes(_ext);
        const _btn = `<button class="np-discogs-btn" id="np-discogs-search-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search Album Art on Discogs</button>`;
        const _dzbtn = `<button class="np-discogs-btn" id="np-deezer-search-btn" style="margin-top:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search Album Art on Deezer</button>`;
        const _urlbtn = `<button class="np-discogs-btn" id="np-url-paste-btn" style="margin-top:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Paste Image URL</button>`;
        _dsEl.innerHTML = _wavLike
          ? _btn + _dzbtn + _urlbtn + `<span class="np-discogs-note" style="margin-top:5px;display:block">WAV files can\'t store embedded art — art will be saved to the database only.<br>It is lost on a DB reset or album-art cache delete.</span>`
          : _btn + _dzbtn + _urlbtn;
      }
    } else {
      _dsEl.classList.add('hidden');
    }
  }
}
function showNPModal() {
  if (!S.queue[S.idx]) return;
  renderNPModal();
  document.getElementById('np-modal').classList.remove('hidden');
}
function hideNPModal() {
  document.getElementById('np-modal').classList.add('hidden');
  const _npLeft = document.getElementById('np-left');
  if (_npLeft) {
    _npLeft.classList.remove('np-left--picking');
    _npLeft.scrollTop = 0;
  }
  // Force the Discogs section to re-render its initial button state on next open
  const _dsEl = document.getElementById('np-discogs-section');
  if (_dsEl) _dsEl.dataset.songFp = '';
}

// ── DEEZER ART IN NP MODAL ────────────────────────────────
async function _npDeezerSearch(song) {
  const dsEl   = document.getElementById('np-discogs-section');
  const npLeft = document.getElementById('np-left');
  if (!dsEl || !song) return;
  dsEl.innerHTML = `<span class="np-discogs-status">Searching Deezer…</span>`;
  npLeft?.classList.add('np-left--picking');
  try {
    const q = [song.artist, song.album].filter(Boolean).join(' ');
    const data = await api('GET', `api/v1/deezer/search?q=${encodeURIComponent(q)}`);
    const hits = (data.data || []).filter(h => h.cover_medium);
    if (!hits.length) {
      dsEl.innerHTML =
        `<span class="np-discogs-status">No results found on Deezer</span>` +
        `<button class="np-discogs-btn" id="np-deezer-search-btn" style="margin-top:8px">Try again</button>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:6px">← Back</button>`;
      return;
    }
    const thumbsHtml = hits.map(h =>
      `<img class="np-discogs-thumb np-deezer-thumb"
        src="${h.cover_medium}" alt=""
        title="${esc(h.title)}${h.artist?.name ? ' — ' + esc(h.artist.name) : ''}"
        data-cover-xl="${esc(h.cover_xl || h.cover_big || h.cover_medium)}"
        data-filepath="${esc(song.filepath || '')}">`
    ).join('');
    dsEl.innerHTML =
      `<div class="np-discogs-pick-header">` +
        `<span class="np-discogs-pick-title">Pick a cover (Deezer)</span>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn">← Cancel</button>` +
      `</div>` +
      `<div class="np-discogs-choices">${thumbsHtml}</div>` +
      `<span class="np-discogs-note">via Deezer</span>`;
    dsEl.dataset.songFp = song.filepath || '';
  } catch(e) {
    dsEl.innerHTML =
      `<span class="np-discogs-status">Deezer search failed</span>` +
      `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:6px">← Back</button>`;
  }
}

// ── DIRECT-URL ART IN NP MODAL ────────────────────────────
function _npUrlPaste(song) {
  const dsEl   = document.getElementById('np-discogs-section');
  const npLeft = document.getElementById('np-left');
  if (!dsEl || !song) return;
  npLeft?.classList.add('np-left--picking');
  dsEl.dataset.songFp = song.filepath || '';
  dsEl.innerHTML =
    `<div class="np-discogs-pick-header">` +
      `<span class="np-discogs-pick-title">Paste an image URL</span>` +
      `<button class="np-discogs-cancel" id="np-discogs-back-btn">← Cancel</button>` +
    `</div>` +
    `<div class="np-url-paste-row">` +
      `<input class="np-url-paste-inp" id="np-url-paste-inp" type="url" placeholder="https://…" autocomplete="off" spellcheck="false">` +
      `<button class="np-url-paste-go" id="np-url-paste-go-btn">Use</button>` +
    `</div>` +
    `<span id="np-url-paste-preview-wrap" class="np-url-paste-preview-wrap hidden">` +
      `<img id="np-url-paste-preview" class="np-url-paste-preview" alt="">` +
    `</span>` +
    `<span id="np-url-paste-status" class="np-discogs-status" style="display:none"></span>`;
  // Focus the input after the DOM updates
  requestAnimationFrame(() => {
    const inp = document.getElementById('np-url-paste-inp');
    if (inp) inp.focus();
  });
}

// ── DISCOGS ART IN NP MODAL ───────────────────────────────
async function _npDiscogsSearch(song) {
  const dsEl  = document.getElementById('np-discogs-section');
  const npLeft = document.getElementById('np-left');
  if (!dsEl || !song) return;
  dsEl.innerHTML = `<span class="np-discogs-status">Searching Discogs…</span>`;
  npLeft?.classList.add('np-left--picking');
  try {
    const params = new URLSearchParams();
    if (song.artist) params.set('artist', song.artist);
    if (song.title)  params.set('title',  song.title);
    if (song.album)  params.set('album',  song.album);
    if (song.year)   params.set('year',   String(song.year));
    // Always send filepath so the server can extract artist/title from the
    // directory name when tags are absent (e.g. untagged WAV files)
    if (song.filepath) params.set('filepath', song.filepath);
    // No metadata at all — fall back to the bare filename so the server's
    // filename parser (CamelCase / dash splitter) can extract artist + title
    if (!song.artist && !song.title && !song.album && song.filepath) {
      const bare = song.filepath.split('/').pop() || '';
      if (bare) params.set('title', bare);
    }
    const d = await api('GET', `api/v1/discogs/coverart?${params}`);
    if (!d.choices || !d.choices.length) {
      dsEl.innerHTML =
        `<span class="np-discogs-status">No results found</span>` +
        `<button class="np-discogs-btn" id="np-discogs-search-btn" style="margin-top:8px">Try again</button>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:6px">← Back</button>`;
      return;
    }
    const thumbsHtml = d.choices.map(c =>
      `<img class="np-discogs-thumb"
        src="${c.thumbB64}" alt=""
        title="${esc(c.releaseTitle)}${c.year ? ' (' + esc(c.year) + ')' : ''}"
        data-release-id="${c.releaseId}"
        data-filepath="${esc(song.filepath || '')}">`
    ).join('');
    dsEl.innerHTML =
      `<div class="np-discogs-pick-header">` +
        `<span class="np-discogs-pick-title">Pick a cover</span>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn">← Cancel</button>` +
      `</div>` +
      `<div class="np-discogs-choices">${thumbsHtml}</div>` +
      `<span class="np-discogs-note">via Discogs</span>`;
    dsEl.dataset.songFp = song.filepath || '';
  } catch(e) {
    const msg = e?.status === 404
      ? 'Discogs not enabled — configure in admin'
      : esc(e?.message || 'Search failed');
    dsEl.innerHTML =
      `<span class="np-discogs-status">${msg}</span>` +
      `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:6px">← Back</button>`;
  }
} 

// ── EQUALIZER CONFIG ──────────────────────────────────────────
const EQ_BANDS = [
  { freq:    60, type: 'lowshelf',  label: '60',   q: 1.0 },
  { freq:   100, type: 'peaking',   label: '100',  q: 1.8 },
  { freq:   200, type: 'peaking',   label: '200',  q: 1.4 },
  { freq:   500, type: 'peaking',   label: '500',  q: 1.8 },
  { freq:  1000, type: 'peaking',   label: '1k',   q: 1.4 },
  { freq:  3000, type: 'peaking',   label: '3k',   q: 1.4 },
  { freq: 10000, type: 'peaking',   label: '10k',  q: 1.4 },
  { freq: 14000, type: 'highshelf', label: '14k',  q: 1.0 },
];
const EQ_PRESETS = {
  'Flat':       [  0,  0,  0,  0,  0,  0,  0,  0],
  'Bass Boost': [  6,  5,  3,  0,  0,  0,  0,  0],
  'House':      [  6,  5,  2, -3, -1,  1,  2,  3],
  'Trance':     [  5,  4,  1, -4,  0,  4,  4,  5],
  'Disco':      [  4,  3, -1, -2,  1,  3,  3,  4],
  'Pop':        [  2,  1,  0, -1,  2,  3,  2,  3],
  'Classical':  [  0,  0,  0,  0,  0,  0, -1, -3],
  'Rock':       [  3,  3,  1, -2,  0,  1,  3,  2],
  'Vocal':      [ -2, -2,  0,  2,  4,  2,  0, -2],
};

// ── MINI SPECTRUM (player bar) ──────────────────────────────
const MINI_SPEC = (() => {
  let rafId    = null;
  let idleRaf  = null;
  let idlePhase = 0;
  const BARS    = 80;
  const HOLD_MS = 1200;  // peak tick hold time before falling
  const GRAVITY = 0.7;   // peak fall acceleration (units/s²) — gravity feel (#2)
  const REL_TAU = 0.30;  // bar release time constant in seconds (#1)

  // Ballistic bar levels [0-1], separate from raw FFT data (#1)
  const barL = new Float32Array(BARS);
  const barR = new Float32Array(BARS);
  // Peak state: val, ts of last hit, fall velocity (#2)
  const pkL = Array.from({length: BARS}, () => ({val:0, ts:0, vel:0}));
  const pkR = Array.from({length: BARS}, () => ({val:0, ts:0, vel:0}));

  // Horizontal colour palette: one gradient entry per frequency bin.
  // Rebuilt only when --primary / --accent change — cost is negligible.
  let _palKey = '';
  const _palBot = new Array(BARS).fill('');
  const _palTop = new Array(BARS).fill('');
  function _ensurePalette(colPri, colAcc, dark) {
    const k = colPri + '|' + colAcc + '|' + dark;
    if (k === _palKey) return;
    const pc = document.createElement('canvas');
    pc.width = BARS; pc.height = 1;
    const px = pc.getContext('2d', { willReadFrequently: true });
    const pg = px.createLinearGradient(0, 0, BARS, 0);
    pg.addColorStop(0, colPri);
    pg.addColorStop(1, colAcc);
    px.fillStyle = pg; px.fillRect(0, 0, BARS, 1);
    const d = px.getImageData(0, 0, BARS, 1).data;
    for (let i = 0; i < BARS; i++) {
      const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
      _palBot[i] = `rgba(${r},${g},${b},.92)`;
      if (dark) {
        // Dark mode: lighten top 50% toward white — glowing tip effect
        _palTop[i] = `rgba(${Math.round(r+(255-r)*.5)},${Math.round(g+(255-g)*.5)},${Math.round(b+(255-b)*.5)},.88)`;
      } else {
        // Light mode: darken top 40% toward black — stays vivid against light bg
        _palTop[i] = `rgba(${Math.round(r*.6)},${Math.round(g*.6)},${Math.round(b*.6)},1)`;
      }
    }
    _palKey = k;
  }

  let lastTs = 0;
  let _draining = false;  // true while bars fall to floor after pause/stop

  // Idle state: parked bars with ripple wave + breathing glow when stopped
  function drawIdle(ts = 0) {
    const canvas = document.getElementById('mini-spec');
    if (!canvas || canvas.classList.contains('hidden')) { idleRaf = null; return; }
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const cs2     = getComputedStyle(document.documentElement);
    const colIdle = cs2.getPropertyValue('--primary').trim();
    const isLight = document.documentElement.classList.contains('light');
    const dark    = !isLight;  // Velvet (no class) and Dark both use dark-bg rendering
    const GAP  = 1.5 * dpr;
    const cg   = 2 * dpr;
    const hw   = (W - cg) / 2;
    const barW = (hw - GAP * (BARS - 1)) / BARS;

    idlePhase += 0.018;
    const breath = 0.5 + 0.5 * Math.sin(idlePhase);  // 0..1 breathing cycle

    // Bars: gentle ripple wave — height 6..18px range riding the breath
    for (let side = 0; side < 2; side++) {
      const startX = side === 0 ? 0 : hw + cg;
      // mirror wave so it looks symmetric from centre
      for (let i = 0; i < BARS; i++) {
        const bi    = side === 0 ? (BARS - 1 - i) : i;  // symmetric from centre
        // slow sine ripple across bars + breathing modulation
        const wave  = 0.5 + 0.5 * Math.sin(bi * 0.18 + idlePhase * 0.7);
        const v     = 0.04 + 0.10 * wave * breath + 0.02 * Math.sin(bi * 0.35 - idlePhase);
        const barH  = Math.max(2 * dpr, v * H);
        const x     = startX + i * (barW + GAP);
        const alpha = 0.18 + 0.50 * wave * breath;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colIdle;
        ctx.fillRect(x, H - barH, barW, barH);
        ctx.globalAlpha = 1;
      }
    }

    // Floor line
    ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.12)';
    ctx.fillRect(0, H - dpr, W, dpr);

    // No full-canvas fill — bars breathe via alpha alone, background shows through
    idleRaf = requestAnimationFrame(drawIdle);
  }

  function draw(ts = 0) {
    const canvas = document.getElementById('mini-spec');
    if (!canvas) { rafId = null; return; }
    if (!_draining && (!audioCtx || !analyserL || !analyserR)) { rafId = requestAnimationFrame(draw); return; }
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0.016;
    lastTs = ts;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth  * dpr;
    const H   = canvas.clientHeight * dpr;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    const ctx      = canvas.getContext('2d');
    const GAP      = 1.5 * dpr;
    const cg       = 2 * dpr;
    const hw       = (W - cg) / 2;
    const barW     = (hw - GAP * (BARS - 1)) / BARS;
    const baseline = H;
    const relDecay = Math.exp(-dt / REL_TAU);  // frame-rate-independent release (#1)

    ctx.clearRect(0, 0, W, H);

    const cs     = getComputedStyle(document.documentElement);
    const colPri = cs.getPropertyValue('--primary').trim();
    const colAcc = cs.getPropertyValue('--accent').trim();
    const isLight = document.documentElement.classList.contains('light');
    const dark    = !isLight;  // Velvet (no class) and Dark both use dark-bg rendering
    _ensurePalette(colPri, colAcc, dark);

    // Subtle floor line anchoring bars (#5)
    ctx.fillStyle = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.10)';
    ctx.fillRect(0, H - dpr, W, dpr);

    const rawL = new Uint8Array(analyserL ? analyserL.frequencyBinCount : 128);
    const rawR = new Uint8Array(analyserR ? analyserR.frequencyBinCount : 128);
    // When draining (paused): feed silence so bars fall via ballistics
    if (!_draining && analyserL && analyserR) {
      analyserL.getByteFrequencyData(rawL);
      analyserR.getByteFrequencyData(rawR);
    }

    // Log scale from 40 Hz — better mid-range spread, less bass dominance (#6)
    const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
    function logBin(i, binCount) {
      const freq = Math.pow(2, Math.log2(40) + (Math.log2(20000) - Math.log2(40)) * i / BARS);
      return Math.min(Math.floor(freq / (sampleRate / 2) * binCount), binCount - 1);
    }

    function side(rawData, startX, reverse, bars, pk) {
      for (let i = 0; i < BARS; i++) {
        const bi  = reverse ? (BARS - 1 - i) : i;
        const raw = rawData[logBin(bi, rawData.length)] / 255;
        // Soft height compression — tanh-like: more headroom for peak ticks (#7)
        const v   = Math.pow(raw, 0.82);

        // Ballistics: instant attack, exponential release (#1)
        bars[i] = v > bars[i] ? v : bars[i] * relDecay + v * (1 - relDecay);
        if (bars[i] < 0.001) bars[i] = 0;

        const bv   = bars[i];
        const barH = Math.max(1, bv * baseline * 0.92);
        const x    = startX + i * (barW + GAP);
        const rMax = Math.min(barW * .4, 2.5 * dpr);
        const r    = barH > rMax * 2 ? rMax : 0;  // only round when bar is tall enough (#4)

        // Bar gradient — bottom colour varies by frequency position (horizontal),
        // top colour is a lightened version of the same hue (vertical).
        const grd = ctx.createLinearGradient(0, baseline, 0, baseline - barH);
        grd.addColorStop(0, _palBot[bi]);
        grd.addColorStop(1, _palTop[bi]);
        ctx.fillStyle = grd;
        ctx.beginPath();
        if (r > 0) ctx.roundRect(x, baseline - barH, barW, barH, [r, r, 0, 0]);
        else       ctx.rect(x, baseline - barH, barW, barH);
        ctx.fill();

        // Peak-hold tick with gravity-accelerated fall (#2)
        if (v >= pk[i].val) {
          pk[i].val = v; pk[i].ts = ts; pk[i].vel = 0;
        } else if (ts - pk[i].ts > HOLD_MS) {
          pk[i].vel += GRAVITY * dt;      // accelerate downward
          pk[i].val  = Math.max(0, pk[i].val - pk[i].vel * dt);
        }

        const ph = pk[i].val;
        if (ph > 0.015) {
          const py      = baseline - ph * baseline * 0.92;
          const tickA    = (Math.min(1, ph * 2) * 0.9).toFixed(2);
          ctx.globalAlpha = parseFloat(tickA);
          ctx.fillStyle  = _palTop[bi];
          ctx.fillRect(x, py - 1.5 * dpr, barW, 1.5 * dpr);
          ctx.globalAlpha = 1;
        }
      }
    }

    // L: treble left → bass at centre
    side(rawL, 0, true, barL, pkL);
    // R: bass at centre → treble right
    side(rawR, hw + cg, false, barR, pkR);

    // While draining: check if all bars + peaks settled → switch to idle
    if (_draining) {
      const settled = barL.every(v => v < 0.005) && barR.every(v => v < 0.005) &&
                      pkL.every(p => p.val < 0.01) && pkR.every(p => p.val < 0.01);
      if (settled) {
        rafId = null;
        _draining = false;
        _reset();
        if (!idleRaf) { idlePhase = 0; drawIdle(); }
        return;
      }
    }

    rafId = requestAnimationFrame(draw);
  }

  function _reset() {
    barL.fill(0); barR.fill(0);
    pkL.forEach(p => { p.val = 0; p.ts = 0; p.vel = 0; });
    pkR.forEach(p => { p.val = 0; p.ts = 0; p.vel = 0; });
    lastTs = 0;
  }

  return {
    start() {
      _draining = false;
      if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = null; }
      if (!rafId) draw();
    },
    stop() {
      if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = null; }
      // Let bars fall naturally to floor before switching to idle
      _draining = true;
      // Ensure draw loop is running (it may not be if audio context not ready)
      if (!rafId) {
        _reset();
        idlePhase = 0; drawIdle();
      }
    },
  };
})();

// ── VU NEEDLE METERS (player bar) ─────────────────────────────
const VU_NEEDLE = (() => {
  let rafId = null;
  let _mode = localStorage.getItem(_uKey('vu_mode')) || 'spec'; // 'spec' | 'needle' | 'ppm'

  // Per-channel ballistics state
  let vuL = -25, vuR = -25;
  let lastClipL = null, lastClipR = null;
  let lastTs    = null;
  let _vuDraining = false;  // true while needles fall to idle after pause

  // PPM (Peak Programme Meter) — fast attack, slow release, peak hold
  // valL/valR stored as raw dBFS (-40 silence … 0 full-scale)
  let ppmL = -40, ppmR = -40;
  let ppmPkL = -40, ppmPkR = -40;
  let ppmPkTsL = null, ppmPkTsR = null;
  const TAU_PPM_ATK  = 0.005;   // 5 ms attack (near-instant)
  const TAU_PPM_REL  = 1.500;   // 1.5 s release
  const PPM_HOLD_MS  = 2000;    // peak hold duration
  const PPM_FADE_MS  = 2000;    // peak fade after hold
  let ppmBrightness  = parseFloat(localStorage.getItem(_uKey('ppm_bright')) || '0.38');

  // Art-pulse — dedicated fast-attack / medium-release level (dBFS, used for drain threshold only)
  let artLvlL = -30, artLvlR = -30;
  const TAU_ART_ATK = 0.010;
  const TAU_ART_REL = 0.300;

  // Art bar state: per-frequency ballistic levels (same count as MINI_SPEC)
  let _artImg      = null;
  const _ART_NBARS = 80;
  const _ART_TAU   = 0.30;  // same release tau as MINI_SPEC
  let _artBarsL    = new Float32Array(_ART_NBARS);
  let _artBarsR    = new Float32Array(_ART_NBARS);
  const _ART_HOLD_MS = 1200;   // peak tick hold time before falling (same as MINI_SPEC)
  const _ART_GRAVITY = 0.7;    // peak fall acceleration (same as MINI_SPEC)
  let _artPkL      = Array.from({length: _ART_NBARS}, () => ({val:0, ts:0, vel:0}));
  let _artPkR      = Array.from({length: _ART_NBARS}, () => ({val:0, ts:0, vel:0}));

  function _buildArtCols() {
    _artBarsL.fill(0); _artBarsR.fill(0);
    _artPkL.forEach(p => { p.val=0; p.ts=0; p.vel=0; });
    _artPkR.forEach(p => { p.val=0; p.ts=0; p.vel=0; });
  }

  function _drawArt(dt, draining) {
    const canvas = document.getElementById('vu-art-canvas');
    if (!canvas) return;
    const now = performance.now();

    // Fetch FFT data — silence when draining
    const rawL = new Uint8Array(analyserL ? analyserL.frequencyBinCount : 128);
    const rawR = new Uint8Array(analyserR ? analyserR.frequencyBinCount : 128);
    if (!draining && analyserL && analyserR) {
      analyserL.getByteFrequencyData(rawL);
      analyserR.getByteFrequencyData(rawR);
    }

    // Log-frequency bin mapping — identical to MINI_SPEC
    const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
    function logBin(i, binCount) {
      const freq = Math.pow(2, Math.log2(40) + (Math.log2(20000) - Math.log2(40)) * i / _ART_NBARS);
      return Math.min(Math.floor(freq / (sampleRate / 2) * binCount), binCount - 1);
    }
    const relDecay = Math.exp(-dt / _ART_TAU);
    let anyActive = false;

    for (let i = 0; i < _ART_NBARS; i++) {
      // L side: reversed — bar 0 = treble (far left), bar NBARS-1 = bass (centre)
      const biL  = _ART_NBARS - 1 - i;
      const vL   = Math.pow(rawL[logBin(biL, rawL.length)] / 255, 0.82);
      _artBarsL[i] = vL > _artBarsL[i] ? vL : _artBarsL[i] * relDecay + vL * (1 - relDecay);
      if (_artBarsL[i] < 0.001) _artBarsL[i] = 0; else anyActive = true;

      // R side: normal — bar 0 = bass (centre), bar NBARS-1 = treble (far right)
      const vR   = Math.pow(rawR[logBin(i, rawR.length)] / 255, 0.82);
      _artBarsR[i] = vR > _artBarsR[i] ? vR : _artBarsR[i] * relDecay + vR * (1 - relDecay);
      if (_artBarsR[i] < 0.001) _artBarsR[i] = 0; else anyActive = true;

      // Peak hold — L (gravity-accelerated fall, same as MINI_SPEC)
      if (vL >= _artPkL[i].val) { _artPkL[i].val = vL; _artPkL[i].ts = now; _artPkL[i].vel = 0; }
      else if (now - _artPkL[i].ts > _ART_HOLD_MS) {
        _artPkL[i].vel += _ART_GRAVITY * dt;
        _artPkL[i].val  = Math.max(0, _artPkL[i].val - _artPkL[i].vel * dt);
      }
      if (_artPkL[i].val > 0.005) anyActive = true;

      // Peak hold — R
      if (vR >= _artPkR[i].val) { _artPkR[i].val = vR; _artPkR[i].ts = now; _artPkR[i].vel = 0; }
      else if (now - _artPkR[i].ts > _ART_HOLD_MS) {
        _artPkR[i].vel += _ART_GRAVITY * dt;
        _artPkR[i].val  = Math.max(0, _artPkR[i].val - _artPkR[i].vel * dt);
      }
      if (_artPkR[i].val > 0.005) anyActive = true;
    }

    // Hide canvas when fully silent — player background shows through cleanly
    if (!_artImg || !_artImg.complete || !_artImg.naturalWidth) {
      canvas.style.visibility = 'hidden'; canvas.style.pointerEvents = 'none'; return;
    }
    if (!anyActive) {
      canvas.style.visibility = 'hidden'; canvas.style.pointerEvents = 'none';
      const dpr2 = window.devicePixelRatio || 1;
      canvas.getContext('2d').clearRect(0, 0, Math.round(canvas.offsetWidth*dpr2), Math.round(canvas.offsetHeight*dpr2));
      return;
    }
    canvas.style.visibility = 'visible'; canvas.style.pointerEvents = 'auto';

    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (W < 4 || H < 4) return;
    const dpr = window.devicePixelRatio || 1;
    const CW  = Math.round(W * dpr), CH = Math.round(H * dpr);
    if (canvas.width !== CW || canvas.height !== CH) { canvas.width = CW; canvas.height = CH; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CW, CH);

    // Two-sided geometry — identical to MINI_SPEC
    const GAP  = 1.5 * dpr;
    const cg   = 2 * dpr;
    const hw   = (CW - cg) / 2;
    const barW = (hw - GAP * (_ART_NBARS - 1)) / _ART_NBARS;

    // Cover-crop source image to full canvas aspect ratio
    const iw = _artImg.naturalWidth, ih = _artImg.naturalHeight;
    const srcAspect = iw / ih, dstAspect = CW / CH;
    let sx, sy, srcW, srcH;
    if (srcAspect > dstAspect) {
      srcH = ih; srcW = Math.round(ih * dstAspect);
      sx = Math.round((iw - srcW) / 2); sy = 0;
    } else {
      srcW = iw; srcH = Math.round(iw / dstAspect);
      sx = 0; sy = Math.round((ih - srcH) / 2);
    }

    // Draw one side — image column position is proportional to destX across full canvas
    function drawSide(bars, pks, startX) {
      for (let i = 0; i < _ART_NBARS; i++) {
        const destX  = Math.round(startX + i * (barW + GAP));
        const destW  = Math.max(1, Math.round(barW));
        // Map screen position → source image column
        const srcX   = sx + Math.round(srcW * (startX + i * (barW + GAP)) / CW);
        const srcCW  = Math.max(1, Math.round(srcW * barW / CW));

        const bv = bars[i];
        if (bv >= 0.001) {
          const barH = Math.max(1, bv * CH * 0.92);
          const destY = CH - Math.round(barH);
          const srcY  = sy + Math.round(srcH * (1 - bv * 0.92));
          const srcCH = Math.max(1, srcH - Math.round(srcH * (1 - bv * 0.92)));
          ctx.drawImage(_artImg, srcX, srcY, srcCW, srcCH, destX, destY, destW, Math.round(barH));
        }

        // Peak tick — bright white line that falls with gravity (same feel as MINI_SPEC)
        const ph = pks[i].val;
        if (ph > 0.015) {
          const tickH = Math.max(1, Math.round(1.5 * dpr));
          const py    = Math.round(CH - ph * CH * 0.92) - tickH;
          ctx.globalAlpha = Math.min(0.92, ph * 1.8);
          ctx.fillStyle   = '#ffffff';
          ctx.fillRect(destX, py, destW, tickH);
          ctx.globalAlpha = 1;
        }
      }
    }

    drawSide(_artBarsL, _artPkL, 0);           // L: treble left → bass centre
    drawSide(_artBarsR, _artPkR, hw + cg);     // R: bass centre → treble right
  }

  let _bsAlpha       = 0;          // brightness-slider overlay opacity (0 = hidden)
  let _bsFadeTimer   = null;       // timeout id for auto-hide
  let _bsRaf         = null;       // rAF for smooth fade animation

  // Fade slider out smoothly over ~800 ms
  function _bsStartFade() {
    cancelAnimationFrame(_bsRaf);
    clearTimeout(_bsFadeTimer);
    _bsFadeTimer = setTimeout(() => {
      const step = () => {
        _bsAlpha = Math.max(0, _bsAlpha - 0.03);
        if (!rafId) _drawIdle();   // keep PPM canvas refreshing during fade
        if (_bsAlpha > 0) _bsRaf = requestAnimationFrame(step);
      };
      _bsRaf = requestAnimationFrame(step);
    }, 15000);
  }

  // Show slider and restart the 15 s idle timer
  function _bsWake() {
    cancelAnimationFrame(_bsRaf);
    _bsAlpha = 1;
    _bsStartFade();
  }

  let REF_LEVEL      = parseFloat(localStorage.getItem(_uKey('ref')) || '-13');   // dBFS that maps to 0 VU  (adjustable via knob)
  const PEAK_HOLD_MS = 1000;
  const PEAK_FADE_MS = 5000;
  const CLIP_VU      = 2.5;   // VU level that trips the peak lamp
  const TAU          = 0.300; // ballistic time constant (s ~300 ms)

  // Piecewise VU-level → needle angle table (degrees, 0 = straight up, +ve = clockwise)
  const ANGLE_TABLE = [
    [-25,-55],[-20,-50],[-10,-35],[-7,-27],
    [-5,-20],[-3,-10],[-2,-4],[-1,4],
    [0,12],[1,24],[2,38],[3,55],
  ];

  function vuToAngle(vu) {
    const v = Math.max(-25, Math.min(3, vu));
    for (let i = 1; i < ANGLE_TABLE.length; i++) {
      if (v <= ANGLE_TABLE[i][0]) {
        const t = (v - ANGLE_TABLE[i-1][0]) / (ANGLE_TABLE[i][0] - ANGLE_TABLE[i-1][0]);
        return ANGLE_TABLE[i-1][1] + t * (ANGLE_TABLE[i][1] - ANGLE_TABLE[i-1][1]);
      }
    }
    return ANGLE_TABLE[ANGLE_TABLE.length - 1][1];
  }

  function rmsToVU(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sq = 0;
    for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
    const rms = Math.sqrt(sq / buf.length);
    if (rms < 1e-10) return -Infinity;
    return 20 * Math.log10(rms) - REF_LEVEL;
  }

  // True-peak measurement for PPM ballistics — returns raw dBFS (no VU offset)
  function peakToDBFS(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > pk) pk = a; }
    if (pk < 1e-10) return -Infinity;
    return 20 * Math.log10(pk);  // dBFS: 0 = full scale
  }

  // Virtual canvas space: VW=200, VH=134 (face + 14px top glow headroom).
  // CX=100, CY=VH=134 — pivot at absolute bottom-centre of face (AKAI-style).
  // Needle tail (nTail) extends below y=134 → clipped by canvas edge naturally.
  // R=108: arc spans x≈12–188 (88% of VW) with ±55° sweep.
  // Top 14 virtual units of headroom ensure the peak lamp glow (radius=20) is
  // never clipped — lamp sits at y=24, glow top = y=4 (4 units clear of edge).
  // Non-uniform scale (sx=W/VW, sy=H/VH) fills canvas exactly — no gutters.
  const VW = 200, VH = 134;
  const CX = 100, CY = VH;  // pivot at bottom centre, y=134
  const R  = 108;            // arc radius — arc top at y=26, ends at y≈72

  const toRad = deg => (deg - 90) * Math.PI / 180;

  function drawDial(canvas, label, vu, peakIntensity) {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth  * dpr;
    const H   = canvas.clientHeight * dpr;
    if (W < 2 || H < 2) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');

    // Non-uniform scale: virtual face (VW×VH) maps exactly to canvas (W×H).
    // CY=VH=120 → pivot at bottom edge. Tail (nTail=10) exits below → clipped.
    const sx = W / VW;
    const sy = H / VH;
    const isLight = document.documentElement.classList.contains('light');
    const dark    = !isLight;  // Velvet (no class) and Dark both use dark-bg rendering

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(sx, sy);

    // ── No face fill — canvas is transparent, player bar bg shows through ──
    // Only a faint inner shadow ring gives the bezel a subtle depth without
    // creating a separate visible "layer" over the player background.
    ctx.strokeStyle = dark ? 'rgba(139,92,246,.10)' : 'rgba(0,0,0,.06)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.roundRect(0.25, 0.25, VW-0.5, VH-0.5, 7); ctx.stroke();

    // ── Arc band: green → yellow → red ──────────────────────────
    const aS = toRad(-55), aE = toRad(55);
    const ag = ctx.createLinearGradient(
      CX+Math.cos(aS)*R, CY+Math.sin(aS)*R,
      CX+Math.cos(aE)*R, CY+Math.sin(aE)*R
    );
    if (dark) {
      ag.addColorStop(0,'#22c55e'); ag.addColorStop(0.65,'#fbbf24'); ag.addColorStop(1,'#f87171');
    } else {
      ag.addColorStop(0,'#16a34a'); ag.addColorStop(0.65,'#d97706'); ag.addColorStop(1,'#dc2626');
    }
    ctx.strokeStyle = ag; ctx.lineWidth = 3; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(CX, CY, R, aS, aE); ctx.stroke();

    ctx.strokeStyle = dark ? 'rgba(139,92,246,.12)' : 'rgba(109,60,230,.18)';
    ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.arc(CX, CY, R-15, aS, aE); ctx.stroke();

    // ── Tick marks + labels ──────────────────────────────────────
    const mCol = dark ? '#8888b0' : '#555570';
    const pCol = dark ? '#f87171' : '#dc2626';
    const marks = [
      {vu:-20,main:true, txt:'20'},{vu:-10,main:true, txt:'10'},
      {vu: -7,main:false,txt:'7' },{vu: -5,main:false,txt:'5' },
      {vu: -3,main:false,txt:'3' },{vu: -2,main:true, txt:'2' },
      {vu:  0,main:true, txt:'0' },{vu:  1,main:false,txt:'1' },
      {vu:  2,main:false,txt:'2' },{vu:  3,main:true, txt:'3' },
    ];
    marks.forEach(m => {
      const rad  = toRad(vuToAngle(m.vu));
      const tLen = m.main ? 11 : 6;
      const oR = R - 6, iR = oR - tLen;
      ctx.strokeStyle = m.vu > 0 ? pCol : mCol;
      ctx.lineWidth   = m.main ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(CX+Math.cos(rad)*oR, CY+Math.sin(rad)*oR);
      ctx.lineTo(CX+Math.cos(rad)*iR, CY+Math.sin(rad)*iR);
      ctx.stroke();
      if (m.main) {
        const lR = iR - 9;
        ctx.fillStyle = m.vu > 0 ? pCol : mCol;
        ctx.font = 'bold 8px system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(m.txt, CX+Math.cos(rad)*lR, CY+Math.sin(rad)*lR);
      }
    });

    // ± signs — inward of arc ends so they stay in-canvas
    const sR = R - 5;
    ctx.font = 'bold 12px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = mCol;
    ctx.fillText('\u2212', CX+Math.cos(toRad(-57))*sR, CY+Math.sin(toRad(-57))*sR);
    ctx.fillStyle = pCol;
    ctx.fillText('+', CX+Math.cos(toRad(57))*sR, CY+Math.sin(toRad(57))*sR);

    // Brand text — colour tracks playback position like the waveform (primary→accent),
    // static purple when paused.
    ctx.font = '700 10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0.5px';
    if (!audioEl.paused && audioEl.duration > 0) {
      const cs     = getComputedStyle(document.documentElement);
      const colPri = cs.getPropertyValue('--primary').trim();
      const colAcc = cs.getPropertyValue('--accent').trim();
      const pct    = audioEl.currentTime / audioEl.duration;
      // Shift the primary→accent gradient so the colour at CX equals lerp(primary,accent,pct)
      // — identical to the waveform's played-region colour at this moment.
      const grad = ctx.createLinearGradient(CX - pct * VW, 0, CX + (1 - pct) * VW, 0);
      grad.addColorStop(0, colPri);
      grad.addColorStop(1, colAcc);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = dark ? 'rgba(180,150,255,.90)' : 'rgba(109,60,230,.75)';
    }
    ctx.fillText('AroundMyRoom', CX, VH - 48);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = dark ? 'rgba(139,92,246,.55)' : 'rgba(109,60,230,.45)';
    ctx.font = 'bold 10px system-ui,sans-serif';
    ctx.fillText('VU', CX, VH - 12);

    // Channel label — y=26 aligns with arc top (CY-R=134-108=26)
    ctx.fillStyle = dark ? 'rgba(139,92,246,.85)' : 'rgba(109,60,230,.70)';
    ctx.font = 'bold 13px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, label === 'L' ? 16 : VW-16, 26);

    // ── Peak lamp ────────────────────────────────────────────────
    // lampY=24: 14-unit top pad keeps glow (radius=20) fully within canvas.
    const lampX = CX, lampY = 24, lampRad = 5;
    if (peakIntensity > 0 && dark) {
      const glow = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, lampRad*4);
      glow.addColorStop(0, `rgba(255,60,60,${(0.3+peakIntensity*0.55).toFixed(2)})`);
      glow.addColorStop(1, 'rgba(255,60,60,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(lampX, lampY, lampRad*4, 0, 2*Math.PI); ctx.fill();
    }
    if (dark) {
      ctx.fillStyle = peakIntensity > 0
        ? `rgba(255,${Math.round(70-peakIntensity*50)},${Math.round(70-peakIntensity*50)},${(0.3+peakIntensity*0.7).toFixed(2)})`
        : '#16213e';
    } else {
      ctx.fillStyle = peakIntensity > 0
        ? `rgba(220,38,38,${(0.25+peakIntensity*0.75).toFixed(2)})`
        : '#c8c8dc';
    }
    ctx.beginPath(); ctx.arc(lampX, lampY, lampRad, 0, 2*Math.PI); ctx.fill();
    ctx.strokeStyle = dark ? '#2a3a5e' : 'rgba(0,0,0,.12)'; ctx.lineWidth = 0.75; ctx.stroke();

    // ── Needle — pivots at CY=VH=120 (bottom edge). Tail exits below canvas. ──
    const ang  = toRad(vuToAngle(vu));
    const nTip = R - 8, nTail = 10;
    ctx.save();
    ctx.shadowColor = dark ? 'rgba(0,0,0,.8)' : 'rgba(0,0,0,.3)';
    ctx.shadowBlur = 4; ctx.shadowOffsetX = 1.5; ctx.shadowOffsetY = 1.5;
    ctx.strokeStyle = dark ? '#f87171' : '#dc2626';
    ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(CX+Math.cos(ang+Math.PI)*nTail, CY+Math.sin(ang+Math.PI)*nTail);
    ctx.lineTo(CX+Math.cos(ang)*nTip,           CY+Math.sin(ang)*nTip);
    ctx.stroke();
    ctx.restore();

    // ── Pivot cap — at bottom centre (CY=VH), upper semicircle visible ──
    ctx.fillStyle = dark ? '#3a4e72' : '#9090a8';
    ctx.beginPath(); ctx.arc(CX, CY, 5, 0, 2*Math.PI); ctx.fill();
    ctx.strokeStyle = dark ? '#4a5e82' : '#b0b0c4';
    ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = dark ? '#c8c8e0' : '#e0e0f0';
    ctx.beginPath(); ctx.arc(CX, CY, 2, 0, 2*Math.PI); ctx.fill();

    ctx.restore();
  }


  // ── RTW 1206-style PPM (Peak Programme Meter) — horizontal ─────────────────
  // Two horizontal bar rows: L on top, R on bottom.
  // 44 segments spanning −40 to +3 dBFS (1 dB/seg), values in raw dBFS.
  // Transparent background — seamlessly matches the player bar.
  function drawPPM(canvas, valL, valR, pkValL, pkValR, pkFadeL, pkFadeR) {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth  * dpr;
    const H   = canvas.clientHeight * dpr;
    if (W < 2 || H < 2) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx  = canvas.getContext('2d');
    const isLight = document.documentElement.classList.contains('light');
    const dark    = !isLight;  // Velvet (no class) and Dark both use dark-bg rendering

    ctx.clearRect(0, 0, W, H);
    ctx.save();

    // Virtual space — extra height at bottom for the brightness slider
    const VW = 200, VH = 64;
    const sx = W / VW, sy = H / VH;
    ctx.scale(sx, sy);

    // Layout
    const LPAD   = 11;               // space for 'L'/'R' labels
    const BAR_X  = LPAD + 1;         // bars start x = 12
    const BAR_W  = VW - BAR_X - 2;   // available bar length ≈ 186 virt-px
    const ROW_H  = 13;               // height of each meter row
    const ROW_YL = 2;                // top of L row
    const ROW_YR = ROW_YL + ROW_H + 4; // top of R row
    const SCL_Y  = ROW_YR + ROW_H + 2; // baseline of scale labels

    // Brightness slider geometry
    const BS_Y   = SCL_Y + 8;        // top of brightness track
    const BS_H   = 2;                // track height (thin line)
    const BS_X   = BAR_X + 14;       // leave room for ☀ label
    const BS_W   = BAR_W - 14;       // track width

    // 44 segments: i=0 → −40 dBFS … i=43 → +3 dBFS
    const N      = 44;
    const MIN_DB = -40;
    const UNIT_W = BAR_W / N;        // ≈ 4.23 virt-px per segment
    const SEG_W  = UNIT_W * 0.82;    // 18% gap between segments

    // Colour zones (dBFS):  green ≤ −9  |  yellow −8..−2  |  red ≥ −1
    // Vivid fully-saturated LED colours — brightness is controlled purely via globalAlpha
    function segColor(i, lit) {
      const db = MIN_DB + i;
      if (db >= -1) return lit
        ? (dark ? '#ff5555' : '#cc2222')
        : (dark ? 'rgba(255,60,60,.12)'  : 'rgba(180,30,30,.07)');
      if (db >= -8) return lit
        ? (dark ? '#f5c842' : '#c08800')
        : (dark ? 'rgba(240,180,40,.12)' : 'rgba(180,120,0,.07)');
      return lit
        ? (dark ? '#2ee87a' : '#0aaa44')
        : (dark ? 'rgba(40,210,100,.12)' : 'rgba(10,150,50,.07)');
    }

    // Brightness: clamp so even the low end is always visible (0.22 floor)
    ctx.globalAlpha = 0.22 + ppmBrightness * 0.78;
    function drawRow(rowY, val, pkVal, pkFade) {
      const litCount = val <= MIN_DB ? -1 : Math.min(N - 1, Math.floor(val - MIN_DB));
      for (let i = 0; i < N; i++) {
        const x = BAR_X + i * UNIT_W;
        ctx.fillStyle = segColor(i, i <= litCount);
        ctx.beginPath(); ctx.roundRect(x, rowY, SEG_W, ROW_H, 0.6); ctx.fill();
      }
      // Peak hold — bright segment that fades after hold time
      if (pkFade > 0.01) {
        const pkIdx = Math.min(N - 1, Math.max(0, Math.round(pkVal - MIN_DB)));
        const a     = (pkFade * 0.92).toFixed(2);
        const db    = MIN_DB + pkIdx;
        ctx.fillStyle = db >= -1
          ? `rgba(255,120,120,${a})`
          : db >= -8 ? `rgba(245,210,80,${a})`
                     : `rgba(60,235,130,${a})`;
        ctx.beginPath(); ctx.roundRect(BAR_X + pkIdx * UNIT_W, rowY, SEG_W, ROW_H, 0.6); ctx.fill();
      }
    }
    drawRow(ROW_YL, valL, pkValL, pkFadeL);
    drawRow(ROW_YR, valR, pkValR, pkFadeR);
    ctx.globalAlpha = 1;

    // Channel labels
    ctx.fillStyle = dark ? 'rgba(180,150,255,.80)' : 'rgba(109,60,230,.65)';
    ctx.font = 'bold 8px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('L', LPAD / 2, ROW_YL + ROW_H / 2);
    ctx.fillText('R', LPAD / 2, ROW_YR + ROW_H / 2);

    // dB scale below both bars
    const scaleMarks = [-40, -30, -20, -10, -5, 0, 3];
    ctx.font = '5px system-ui,sans-serif';
    ctx.textBaseline = 'top';
    scaleMarks.forEach(db => {
      const cx = BAR_X + (db - MIN_DB) * UNIT_W + SEG_W / 2;
      const isRed = db >= -1, isYel = db >= -8;
      ctx.fillStyle = isRed ? (dark ? 'rgba(205,95,95,.48)'    : 'rgba(185,50,50,.42)')
                    : isYel ? (dark ? 'rgba(192,158,55,.50)'   : 'rgba(165,115,10,.44)')
                            : (dark ? 'rgba(170,185,200,.52)'  : 'rgba(60,60,80,.50)');
      ctx.fillRect(cx - 0.25, SCL_Y - 1.5, 0.5, 1.5);
      const lbl = db === 3 ? '+3' : String(db);
      ctx.textAlign = db <= -30 ? 'left' : db >= 3 ? 'right' : 'center';
      ctx.fillText(lbl, cx, SCL_Y);
    });

    // 'RTW' brand — left of brightness slider area
    ctx.fillStyle = dark ? 'rgba(139,92,246,.32)' : 'rgba(109,60,230,.22)';
    ctx.font = 'bold 4px system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('RTW', BAR_X, SCL_Y);

    // ── Brightness slider ─────────────────────────────────────────────
    // Drawn OUTSIDE the virtual scale transform so the track and thumb
    // are identical pixel-for-pixel to the vol/balance sliders.
    if (_bsAlpha > 0.004) {
      ctx.restore();   // pop the virtual scale — now in real canvas px

      const RW        = W;                          // actual canvas width
      const RH        = H;                          // actual canvas height
      // Convert virtual anchor points to actual px
      const rsx       = RW / VW;
      const rsy       = RH / VH;
      const R_BS_Y    = (BS_Y + BS_H / 2) * rsy + 3;   // +3px down
      const R_BS_X    = BS_X * rsx - 31;                // -31px left
      const R_BS_W    = BS_W * rsx;
      const TRACK_H   = 3;                          // matches .bal-slider height
      const THUMB_R   = 5.5;                        // matches .bal-slider thumb (11px ⌀)

      const accentLit  = dark ? 'rgba(139,92,246,.85)'  : 'rgba(109,60,230,.80)';
      const accentDim  = dark ? 'rgba(139,92,246,.18)'  : 'rgba(109,60,230,.14)';
      const thumbColor = dark ? '#c4b5fd' : '#6d28d9';   // --primary equivalent

      ctx.save();
      ctx.globalAlpha = _bsAlpha;

      // Sun icon
      ctx.fillStyle = dark ? 'rgba(190,185,210,.55)' : 'rgba(80,60,130,.50)';
      ctx.font = `${Math.round(9 * rsy)}px system-ui,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('☀', (BAR_X + 6) * rsx - 26, R_BS_Y);

      // Track — full background
      ctx.fillStyle = accentDim;
      ctx.beginPath();
      ctx.roundRect(R_BS_X, R_BS_Y - TRACK_H / 2, R_BS_W, TRACK_H, TRACK_H / 2);
      ctx.fill();

      // Track — filled portion
      const fillW = Math.max(TRACK_H, ppmBrightness * R_BS_W);
      ctx.fillStyle = accentLit;
      ctx.beginPath();
      ctx.roundRect(R_BS_X, R_BS_Y - TRACK_H / 2, fillW, TRACK_H, TRACK_H / 2);
      ctx.fill();

      // Thumb — perfect circle (no scale distortion)
      ctx.fillStyle = thumbColor;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur  = 3;
      ctx.beginPath();
      ctx.arc(R_BS_X + fillW, R_BS_Y, THUMB_R, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.restore();
      return;   // ctx.restore() already called above — skip the outer restore
    }

    ctx.restore();
  }

  // Brightness slider interaction for the PPM canvas
  function initPPMBrightness() {
    const canvas = document.getElementById('vu-ppm');
    if (!canvas) return;
    // These mirror the virtual layout in drawPPM (VH=64)
    const VH        = 64;
    const BS_VY     = 40;  // generous hit zone starting above BS_Y(42)
    const BS_VH     = 14;  // covers 40–54 in virt-px, catches the 2px-tall track
    const BAR_X_F   = 12 + 14;   // BS_X in virt-px (BAR_X + sun-icon space)
    const BAR_W_F   = 186 - 14;  // BS_W in virt-px

    let dragging = false;

    function normY(e) {
      const rect = canvas.getBoundingClientRect();
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return (clientY - rect.top) / rect.height;
    }
    function inSlider(e) {
      const ny = normY(e);
      return ny >= BS_VY / VH && ny <= (BS_VY + BS_VH) / VH;
    }
    function applyX(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const normX = ((clientX - rect.left) / rect.width * 200 - BAR_X_F) / BAR_W_F;
      ppmBrightness = Math.max(0.0, Math.min(1.0, normX));
      localStorage.setItem(_uKey('ppm_bright'), ppmBrightness.toFixed(3));
      _syncPrefs();
      if (!rafId) _drawIdle();
    }

    // Only block clicks in the slider zone from reaching the row toggle handler
    canvas.addEventListener('click', e => { if (inSlider(e)) e.stopPropagation(); });

    // Wake brightness slider on hover over the PPM canvas
    canvas.addEventListener('mousemove', e => {
      if (inSlider(e)) _bsWake();
    }, { passive: true });

    canvas.addEventListener('mousedown', e => {
      if (!inSlider(e)) return;
      _bsWake();   // reset 15s timer while actively dragging
      dragging = true; applyX(e); e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove',  e => { if (dragging) applyX(e); });
    window.addEventListener('mouseup',    () => { dragging = false; });

    canvas.addEventListener('touchstart', e => {
      if (!inSlider(e)) return;
      _bsWake();
      dragging = true; applyX(e); e.preventDefault(); e.stopPropagation();
    }, {passive: false});
    window.addEventListener('touchmove',  e => { if (dragging) applyX(e); }, {passive: false});
    window.addEventListener('touchend',   () => { dragging = false; });
  }

  function _drawIdle() {
    if (_mode === 'needle') {
      const cL = document.getElementById('vu-dial-L');
      const cR = document.getElementById('vu-dial-R');
      if (cL) drawDial(cL, 'L', -25, 0);
      if (cR) drawDial(cR, 'R', -25, 0);
    }
    if (_mode === 'ppm') {
      const cP = document.getElementById('vu-ppm');
      if (cP) drawPPM(cP, -40, -40, -40, -40, 0, 0);
    }
    if (_mode === 'art') {
      _buildArtCols();
      _drawArt(0.016, true);
    }
  }

  // ── Ref-level knob ──────────────────────────────────────────
  function drawKnob(canvas) {
    const dpr = window.devicePixelRatio || 1;
    // offsetWidth can be 0 on browsers that don't compute layout for visibility:hidden
    // elements; fall back to the CSS-declared 34 px so the knob always draws.
    const S   = Math.round((canvas.offsetWidth || 34) * dpr);
    if (S < 4) return;
    if (canvas.width !== S || canvas.height !== S) { canvas.width = S; canvas.height = S; }
    const ctx  = canvas.getContext('2d');
    const isLight = document.documentElement.classList.contains('light');
    const dark    = !isLight;  // Velvet (no class) and Dark both use dark-bg rendering
    const cx = S/2, cy = S/2;
    const outerR = S/2 - dpr;
    const capR   = outerR * 0.68;
    const arcR   = outerR - 2*dpr;

    ctx.clearRect(0, 0, S, S);

    // Outer bezel
    const rim = ctx.createRadialGradient(cx-outerR*.3, cy-outerR*.3, outerR*.1, cx, cy, outerR);
    if (dark) { rim.addColorStop(0,'#3a4e72'); rim.addColorStop(1,'#0d1526'); }
    else      { rim.addColorStop(0,'#d0d0e8'); rim.addColorStop(1,'#9090a8'); }
    ctx.fillStyle = rim;
    ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, 2*Math.PI); ctx.fill();

    // Inner cap
    const cap = ctx.createRadialGradient(cx-capR*.2, cy-capR*.3, capR*.05, cx, cy, capR);
    if (dark) { cap.addColorStop(0,'#2a3a5e'); cap.addColorStop(1,'#16213e'); }
    else      { cap.addColorStop(0,'#f0f0fa'); cap.addColorStop(1,'#c4c4d8'); }
    ctx.fillStyle = cap;
    ctx.beginPath(); ctx.arc(cx, cy, capR, 0, 2*Math.PI); ctx.fill();

    // Sweep arc track
    const sA = 3*Math.PI/4;         // 135° = 7:30 (CCW min = -20 dBFS)
    const eA = sA + 3*Math.PI/2;    // 135°+270° = 4:30 (CW max = -10 dBFS)
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.09)';
    ctx.lineWidth = 2.5*dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, arcR, sA, eA); ctx.stroke();

    // Sweep arc fill (current value)
    const t  = (-10 - REF_LEVEL) / 10;      // 0 = -10 dBFS (left), 1 = -20 dBFS (right=red)
    const vA = sA + t * 3*Math.PI/2;
    ctx.strokeStyle = dark ? '#8b5cf6' : '#6d3ce6';
    ctx.lineWidth = 2.5*dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, arcR, sA, vA); ctx.stroke();

    // Indicator dot on cap face
    const indR = capR * 0.57;
    ctx.fillStyle = dark ? '#8b5cf6' : '#6d3ce6';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(vA)*indR, cy + Math.sin(vA)*indR, 2.5*dpr, 0, 2*Math.PI);
    ctx.fill();
  }

  function initKnob() {
    const knob = document.getElementById('vu-ref-knob');
    if (!knob) return;
    drawKnob(knob);
    let dragging = false, startX = 0, startVal = REF_LEVEL;

    knob.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startVal = REF_LEVEL;
      e.preventDefault(); e.stopPropagation();
    });
    knob.addEventListener('click', e => e.stopPropagation());
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = (e.clientX - startX) / 15;  // right = lower REF_LEVEL (more red)
      REF_LEVEL = Math.min(-10, Math.max(-20, Math.round((startVal - delta) * 2) / 2));
      knob.title = `Drag left/right · peak ref: ${REF_LEVEL} dBFS`;
      localStorage.setItem(_uKey('ref'), REF_LEVEL);
      _syncPrefs();
      drawKnob(knob);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    knob.addEventListener('touchstart', e => {
      dragging = true; startX = e.touches[0].clientX; startVal = REF_LEVEL;
      e.preventDefault(); e.stopPropagation();
    }, {passive:false});
    window.addEventListener('touchmove', e => {
      if (!dragging) return;
      const delta = (e.touches[0].clientX - startX) / 15;
      REF_LEVEL = Math.min(-10, Math.max(-20, Math.round((startVal - delta) * 2) / 2));
      knob.title = `Drag left/right · peak ref: ${REF_LEVEL} dBFS`;
      localStorage.setItem(_uKey('ref'), REF_LEVEL);
      _syncPrefs();
      drawKnob(knob);
    }, {passive:false});
    window.addEventListener('touchend', () => { dragging = false; });

    // Redraw on theme toggle
    new MutationObserver(() => drawKnob(knob))
      .observe(document.documentElement, {attributes:true, attributeFilter:['class']});
  }

  function drawFrame(ts) {
    if (!rafId) return;
    if (!_vuDraining && (!audioCtx || !analyserL || !analyserR)) { rafId = requestAnimationFrame(drawFrame); return; }
    const dt    = lastTs !== null ? Math.min((ts - lastTs) / 1000, 0.1) : 0.016;
    lastTs      = ts;
    // When draining: target is silence (-25 VU) so needles fall via ballistics
    const rawL  = (_vuDraining || !analyserL) ? -Infinity : rmsToVU(analyserL);
    const rawR  = (_vuDraining || !analyserR) ? -Infinity : rmsToVU(analyserR);
    const tgtL  = isFinite(rawL) ? Math.max(-25, rawL) : -25;
    const tgtR  = isFinite(rawR) ? Math.max(-25, rawR) : -25;
    const alpha = 1 - Math.exp(-dt / TAU);
    vuL += alpha * (tgtL - vuL);
    vuR += alpha * (tgtR - vuR);
    if (!_vuDraining) {
      if (vuL >= CLIP_VU) lastClipL = ts;
      if (vuR >= CLIP_VU) lastClipR = ts;
    }
    function lampI(lc) {
      if (lc === null) return 0;
      const age = ts - lc;
      if (age <= PEAK_HOLD_MS) return 1;
      return Math.max(0, 1 - (age - PEAK_HOLD_MS) / PEAK_FADE_MS);
    }
    // PPM true-peak ballistics (fast attack, slow release) — values in dBFS
    const rawPkL   = (_vuDraining || !analyserL) ? -Infinity : peakToDBFS(analyserL);
    const rawPkR   = (_vuDraining || !analyserR) ? -Infinity : peakToDBFS(analyserR);
    const tgtPL    = isFinite(rawPkL) ? Math.max(-40, rawPkL) : -40;
    const tgtPR    = isFinite(rawPkR) ? Math.max(-40, rawPkR) : -40;
    const alphaAtk = 1 - Math.exp(-dt / TAU_PPM_ATK);
    const alphaRel = 1 - Math.exp(-dt / TAU_PPM_REL);
    ppmL = tgtPL > ppmL ? ppmL + alphaAtk * (tgtPL - ppmL) : ppmL + alphaRel * (tgtPL - ppmL);
    ppmR = tgtPR > ppmR ? ppmR + alphaAtk * (tgtPR - ppmR) : ppmR + alphaRel * (tgtPR - ppmR);
    if (!_vuDraining) {
      if (ppmL >= ppmPkL) { ppmPkL = ppmL; ppmPkTsL = ts; }
      if (ppmR >= ppmPkR) { ppmPkR = ppmR; ppmPkTsR = ts; }
    }
    function ppmLampI(lc) {
      if (lc === null) return 0;
      const age = ts - lc;
      if (age <= PPM_HOLD_MS) return 1;
      return Math.max(0, 1 - (age - PPM_HOLD_MS) / PPM_FADE_MS);
    }
    if (_mode === 'needle') {
      const cL = document.getElementById('vu-dial-L');
      const cR = document.getElementById('vu-dial-R');
      if (cL) drawDial(cL, 'L', vuL, lampI(lastClipL));
      if (cR) drawDial(cR, 'R', vuR, lampI(lastClipR));
    }
    if (_mode === 'ppm') {
      const cP = document.getElementById('vu-ppm');
      if (cP) drawPPM(cP, ppmL, ppmR, ppmPkL, ppmPkR, ppmLampI(ppmPkTsL), ppmLampI(ppmPkTsR));
    }
    // Art-pulse ballistics (always computed so mode switch is instant)
    {
      const rawArtL = (_vuDraining || !analyserL) ? -Infinity : peakToDBFS(analyserL);
      const rawArtR = (_vuDraining || !analyserR) ? -Infinity : peakToDBFS(analyserR);
      const tgtAL   = isFinite(rawArtL) ? Math.max(-30, rawArtL) : -30;
      const tgtAR   = isFinite(rawArtR) ? Math.max(-30, rawArtR) : -30;
      const aAtk    = 1 - Math.exp(-dt / TAU_ART_ATK);
      const aRel    = 1 - Math.exp(-dt / TAU_ART_REL);
      artLvlL = tgtAL > artLvlL ? artLvlL + aAtk * (tgtAL - artLvlL) : artLvlL + aRel * (tgtAL - artLvlL);
      artLvlR = tgtAR > artLvlR ? artLvlR + aAtk * (tgtAR - artLvlR) : artLvlR + aRel * (tgtAR - artLvlR);
    }
    if (_mode === 'art') _drawArt(dt, _vuDraining);
    // Once drained to near-minimum, switch to static idle frame
    const _drainThresh = _mode === 'ppm'  ? Math.max(ppmL,    ppmR)    > -39   :
                         _mode === 'art'  ? (_artBarsL.some(f => f > 0.005) || _artBarsR.some(f => f > 0.005) || _artPkL.some(p => p.val > 0.01) || _artPkR.some(p => p.val > 0.01)) :
                                            Math.max(vuL,     vuR)     > -24.5;
    if (_vuDraining && _drainThresh) { rafId = requestAnimationFrame(drawFrame); return; }
    if (_vuDraining) {
      rafId = null;
      _vuDraining = false;
      vuL = -25; vuR = -25;
      ppmL = -40; ppmR = -40;
      ppmPkL = -40; ppmPkR = -40;
      ppmPkTsL = null; ppmPkTsR = null;
      artLvlL = -30; artLvlR = -30;
      _buildArtCols();
      _drawArt(0.016, true);
      _drawIdle();
      return;
    }
    rafId = requestAnimationFrame(drawFrame);
  }

  function _start() {
    _vuDraining = false;
    if (!rafId) { lastTs = null; rafId = requestAnimationFrame(drawFrame); }
  }
  function _stop() {
    // Let ballistics bring needle down gracefully instead of snapping to idle
    _vuDraining = true;
    if (!rafId) { lastTs = null; rafId = requestAnimationFrame(drawFrame); }
  }
  function _applyMode(startIfPlaying) {
    _vuDraining = false;
    // Clear art canvas immediately when leaving art mode
    if (_mode !== 'art') {
      _buildArtCols();
      const ac = document.getElementById('vu-art-canvas');
      if (ac) {
        const dpr = window.devicePixelRatio || 1;
        ac.getContext('2d').clearRect(0, 0, Math.round(ac.offsetWidth*dpr), Math.round(ac.offsetHeight*dpr));
        ac.style.visibility = 'hidden';
        ac.style.pointerEvents = 'none';
      }
    }
    const wrap = document.getElementById('vu-needle-wrap');
    const spec = document.getElementById('mini-spec');
    const ppmW = document.getElementById('vu-ppm-wrap');
    const artW = document.getElementById('vu-art-wrap');
    if (wrap) wrap.classList.toggle('hidden', _mode !== 'needle');
    if (spec) spec.classList.toggle('hidden', _mode !== 'spec');
    if (ppmW) ppmW.classList.toggle('hidden', _mode !== 'ppm');
    if (artW) artW.classList.toggle('hidden', _mode !== 'art');
    document.body.classList.toggle('vu-needle-mode', _mode === 'needle');
    if (_mode === 'spec') { _stop(); if (startIfPlaying) MINI_SPEC.start(); }
    else                  { MINI_SPEC.stop(); if (startIfPlaying) _start(); else _drawIdle(); }
    localStorage.setItem(_uKey('vu_mode'), _mode);
    _syncPrefs();
  }

  return {
    get mode() { return _mode; },
    setArt(url) {
      if (!url) { _artImg = null; _buildArtCols(); _drawArt(0.016, true); return; }
      const img = new Image();
      img.onload  = () => { _artImg = img; _buildArtCols(); };
      img.onerror = () => { _artImg = null; };
      img.src = url;
    },
    start()  { if (_mode === 'spec') MINI_SPEC.start(); else _start(); },
    stop()   { if (_mode === 'spec') MINI_SPEC.stop();  else _stop();  },
    toggle() {
      const MODES = ['spec', 'needle', 'ppm', 'art'];
      _mode = MODES[(MODES.indexOf(_mode) + 1) % MODES.length];
      _applyMode(audioEl && !audioEl.paused);
    },
    init() {
      if (!_webAudioSupported) {
        const row = document.getElementById('vu-spec-row');
        if (row) row.style.display = 'none';
        console.warn('[mStream] Web Audio API not supported — VU meters hidden');
        return;
      }
      const row = document.getElementById('vu-spec-row');
      if (row) row.addEventListener('click', e => {
        // Toggle on dial, spectrum, PPM canvas (non-slider), or bare row background
        const id = e.target && e.target.id;
        if (id === 'vu-dial-L' || id === 'vu-dial-R' || id === 'mini-spec' ||
            id === 'vu-ppm'    || id === 'vu-ppm-wrap' ||
            id === 'vu-art-wrap' || id === 'vu-art-canvas' || e.target === row) this.toggle();
      });
      // Block clicks on center logo area from bubbling to the row toggle
      const center = document.querySelector('.vu-center-logo');
      if (center) center.addEventListener('click', e => e.stopPropagation());
      // Restore saved display state (no draw loop yet — wait for play event)
      const wrap = document.getElementById('vu-needle-wrap');
      const spec = document.getElementById('mini-spec');
      const ppmW = document.getElementById('vu-ppm-wrap');
      const artW = document.getElementById('vu-art-wrap');
      if (wrap) wrap.classList.toggle('hidden', _mode !== 'needle');
      if (spec) spec.classList.toggle('hidden', _mode !== 'spec');
      if (ppmW) ppmW.classList.toggle('hidden', _mode !== 'ppm');
      if (artW) artW.classList.toggle('hidden', _mode !== 'art');
      document.body.classList.toggle('vu-needle-mode', _mode === 'needle');
      if (_mode === 'needle' || _mode === 'ppm' || _mode === 'art') _drawIdle();
      else MINI_SPEC.stop();  // idle breathing on page load in spec mode
      initKnob();
      initPPMBrightness();
      _bsStartFade();   // start 15 s hide countdown immediately
    },
  };
})();

// ── BUTTERCHURN VISUALIZER + SPECTRUM ────────────────────────
const VIZ = (() => {
  let visualizer = null, analyserNode = null;
  // analyserL, analyserR, audioCtx are module-scope (shared with MINI_SPEC)
  let presets = {}, presetKeys = [], presetHistory = [], presetIndex = 0;
  let cycleTimer = null, frameId = null;
  const CYCLE_MS = 15000;

  // Top-level mode: 0 = Milkdrop/butterchurn, 1 = custom spectrum, 2 = AudioMotion
  let vizTopMode = 0;

  // Spectrum state
  let specFrameId = null;
  let peakL = [], peakVelL = [];  // peak state — left channel
  let peakR = [], peakVelR = [];  // peak state — right channel

  // AudioMotion state
  let amAnalyzer  = null;

  // Lyric mode state
  let lyricLines     = [];   // [{time, text}] parsed from server
  let lyricSynced    = false;
  let lyricActiveIdx = -1;
  let lyricActiveDiv = null; // DOM ref to currently active line
  let lyricRafId     = null; // rAF for 60fps fill sweep
  let amPresetIdx = 0;
  const AM_PRESETS = [
    { name: 'Mirror Peaks',  mode: 8,  gradient: 'prism',      reflexRatio: 0.35, mirror: 0,  channelLayout: 'dual-combined',  ledBars: false },
    { name: 'LED Dual',      mode: 3,  gradient: 'rainbow',    reflexRatio: 0,    mirror: 0,  channelLayout: 'dual-horizontal', ledBars: true  },
    { name: 'Radial',        mode: 5,  gradient: 'orangered',  reflexRatio: 0,    mirror: 0,  channelLayout: 'single',          ledBars: false, radial: true, spinSpeed: 1 },
    { name: 'Octave Reflex', mode: 1,  gradient: 'steelblue',  reflexRatio: 0.4,  mirror: 0,  channelLayout: 'single',          ledBars: false },
    { name: 'Velvet',        mode: 2,  gradient: 'velvet',     reflexRatio: 0.3,  mirror: -1, channelLayout: 'single',          ledBars: false },
    { name: 'Line Stereo',   mode: 10, gradient: 'prism',      reflexRatio: 0,    mirror: 0,  channelLayout: 'dual-vertical' },
  ];

  function ensureAudio() {
    if (!_webAudioSupported) return;
    if (audioCtx) { audioCtx.resume(); return; }
    try {
    audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
    // Resume immediately — browsers often start in 'suspended' state
    audioCtx.resume().catch(e => console.warn('AudioContext resume failed:', e));
    // Auto-resume if the browser suspends the context (energy-saving policy)
    // — without this a suspended context causes ~0.5 s silence mid-song.
    audioCtx.addEventListener('statechange', () => {
      if (audioCtx && audioCtx.state === 'suspended')
        audioCtx.resume().catch(e => console.warn('AudioContext statechange resume failed:', e));
    });
    // Main analyser for butterchurn
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.82;
    // Per-channel analysers for spectrum
    analyserL = audioCtx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.82;
    analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 2048;
    analyserR.smoothingTimeConstant = 0.82;
    _audioGain = audioCtx.createGain();
    _audioGain.gain.value = 1.25;
    const gain     = _audioGain;
    const splitter = audioCtx.createChannelSplitter(2);
    const src      = audioCtx.createMediaElementSource(audioEl);
    // Build 8-band EQ filter chain and apply saved settings
    const _savedGains   = JSON.parse(localStorage.getItem(_uKey('eq'))    || 'null') || Array(8).fill(0);
    const _savedEnabled = localStorage.getItem(_uKey('eq_on')) !== 'false';
    eqFilters = EQ_BANDS.map((b, i) => {
      const f = audioCtx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.type === 'peaking') f.Q.value = b.q;
      f.gain.value = _savedEnabled ? (_savedGains[i] || 0) : 0;
      return f;
    });
    // Wire: src → _curElGain → _rgGainNode → gain → eq[0..7] → analyserNode + splitter
    // _curElGain is a per-element gain used for sample-accurate gapless tap switching.
    _rgGainNode = audioCtx.createGain();
    _rgGainNode.gain.value = 1.0;
    _curElGain = audioCtx.createGain();
    _curElGain.gain.value = 1.0;
    src.connect(_curElGain);
    _curElGain.connect(_rgGainNode);
    _rgGainNode.connect(gain);
    let _node = gain;
    for (const f of eqFilters) { _node.connect(f); _node = f; }
    _pannerNode = audioCtx.createStereoPanner();
    _pannerNode.pan.value = parseFloat(localStorage.getItem(_uKey('balance')) || '0');
    // Butterchurn tap stays pre-pan (visualizer unaffected by balance)
    _node.connect(analyserNode);          // butterchurn tap (pre-pan)
    // VU/PPM analysers tap POST-panner so balance is reflected on the meters
    _node.connect(_pannerNode);
    _pannerNode.connect(audioCtx.destination);
    _pannerNode.connect(splitter);        // post-pan L+R tap
    splitter.connect(analyserL, 0);       // left  channel (balance-aware)
    splitter.connect(analyserR, 1);       // right channel (balance-aware)
    } catch (e) {
      console.warn('[mStream] AudioContext init failed — VU meters hidden:', e);
      audioCtx = null;
      const row = document.getElementById('vu-spec-row');
      if (row) row.style.display = 'none';
    }
  }

  function setPresetLabel() {
    const el = document.getElementById('viz-preset-name');
    if (!el) return;
    const n = presetKeys[presetIndex] || '';
    el.textContent = n.length > 65 ? n.substring(0, 65) + '\u2026' : n;
  }

  function loadPreset(blend) {
    if (!visualizer || !presetKeys.length) return;
    visualizer.loadPreset(presets[presetKeys[presetIndex]], blend ?? 5.7);
    setPresetLabel();
  }

  function startRender() {
    function frame() { frameId = requestAnimationFrame(frame); visualizer.render(); }
    frameId = requestAnimationFrame(frame);
  }

  function initViz(canvas) {
    if (!window.butterchurn) { toast('Visualizer loading\u2026 try again in a moment'); return; }
    presets = {};
    if (window.butterchurnPresets)      Object.assign(presets, butterchurnPresets.getPresets());
    if (window.butterchurnPresetsExtra) Object.assign(presets, butterchurnPresetsExtra.getPresets());
    presetKeys  = Object.keys(presets);
    presetIndex = Math.floor(Math.random() * presetKeys.length);
    canvas.width  = canvas.clientWidth  || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
    visualizer = butterchurn.default.createVisualizer(audioCtx, canvas, {
      width: canvas.width, height: canvas.height,
      pixelRatio: window.devicePixelRatio || 1, textureRatio: 1,
    });
    visualizer.connectAudio(analyserNode);
    loadPreset(0);
    startRender();
    cycleTimer = setInterval(() => {
      presetHistory.push(presetIndex);
      presetIndex = Math.floor(Math.random() * presetKeys.length);
      loadPreset(2.7);
    }, CYCLE_MS);
  }

  // ── SPECTRUM RENDERER — 7 modes, click canvas to cycle ────
  const SPEC_MODES = ['Bar Spectrum','Mirror Bars','Radial','Oscilloscope','Waterfall','VU Needles','Lissajous'];
  let specStyleIdx = parseInt(localStorage.getItem(_uKey('spec_style')) || '0') % SPEC_MODES.length;
  let specLabelAlpha = 0;         // fade-out alpha for mode label overlay
  let waterfallRows = null;       // pixel row buffer for waterfall mode
  let waterfallPos  = 0;

  function startSpectrum(canvas) {
    const ctx = canvas.getContext('2d');
    const BAR_COUNT = 96;
    const GAP = 2;
    const CENTRE_GAP = 3;

    // ---- shared peak arrays (reused across mode switches) ----
    function ensurePeaks(arr, vel, n) {
      while (arr.length < n) { arr.push(0); vel.push(0); }
      arr.length = n; vel.length = n;
    }
    ensurePeaks(peakL, peakVelL, BAR_COUNT);
    ensurePeaks(peakR, peakVelR, BAR_COUNT);

    const dataL  = new Uint8Array(analyserL.frequencyBinCount);
    const dataR  = new Uint8Array(analyserR.frequencyBinCount);
    const waveL  = new Uint8Array(analyserL.fftSize);
    const waveR  = new Uint8Array(analyserR.fftSize);

    function resizeCanvas() {
      const nw = canvas.clientWidth  * (window.devicePixelRatio || 1);
      const nh = canvas.clientHeight * (window.devicePixelRatio || 1);
      if (canvas.width !== nw || canvas.height !== nh) {
        canvas.width = nw; canvas.height = nh;
        waterfallRows = null; // reset waterfall on resize
      }
    }

    function lerp(a, b, t) { return a + (b - a) * t; }
    function barBin(i, total, binCount) {
      const freq = Math.pow(2, lerp(Math.log2(20), Math.log2(20000), i / total));
      return Math.min(Math.floor(freq / (audioCtx.sampleRate / 2) * binCount), binCount - 1);
    }
    function barHue(v) { return (1 - v) * 200; }

    // ── shared background ──
    function drawBg(W, H) {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#06060e'); bg.addColorStop(1, '#0d0d1a');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    }

    // ── shared channel label ──
    function drawLabels(W, H, dpr, y, lx, rx) {
      ctx.shadowBlur = 0;
      const fs = Math.max(18, 22 * dpr);
      ctx.font = `700 ${fs}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('L', lx, y); ctx.fillText('R', rx, y);
    }

    // ── shared bar-channel renderer ──
    function drawBarChannel(data, peaks, vels, px, pw, baseline, dpr, reverse) {
      const gap  = GAP * dpr;
      const barW = (pw - gap * (BAR_COUNT - 1)) / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i++) {
        const bi   = reverse ? (BAR_COUNT - 1 - i) : i;
        const v    = data[barBin(bi, BAR_COUNT, data.length)] / 255;
        const barH = v * baseline;
        const x    = px + i * (barW + gap);
        const hue  = barHue(v);
        const grd  = ctx.createLinearGradient(0, baseline, 0, baseline - barH);
        grd.addColorStop(0,   `hsla(${hue},100%,50%,.95)`);
        grd.addColorStop(0.6, `hsla(${hue+40},100%,62%,.9)`);
        grd.addColorStop(1,   `hsla(${hue+80},100%,78%,.85)`);
        ctx.shadowColor = `hsla(${hue},100%,58%,.55)`; ctx.shadowBlur = 10*dpr;
        ctx.fillStyle = grd;
        const r = Math.min(barW*.35, 4*dpr);
        ctx.beginPath(); ctx.roundRect(x, baseline-barH, barW, barH, [r,r,0,0]); ctx.fill();
        if (barH > peaks[i]) { peaks[i]=barH; vels[i]=0; }
        else { vels[i]+=0.35*dpr; peaks[i]-=vels[i]; if(peaks[i]<0)peaks[i]=0; }
        if (peaks[i]>2) {
          ctx.shadowBlur=6*dpr; ctx.fillStyle=`hsla(${hue+60},100%,90%,.95)`;
          ctx.fillRect(x, baseline-peaks[i]-3*dpr, barW, 2*dpr);
        }
        ctx.shadowBlur=0;
        const rg = ctx.createLinearGradient(0,baseline,0,baseline+barH*.4);
        rg.addColorStop(0,`hsla(${hue},100%,50%,.20)`); rg.addColorStop(1,`hsla(${hue},100%,50%,0)`);
        ctx.fillStyle=rg; ctx.beginPath(); ctx.roundRect(x,baseline,barW,barH*.4,[0,0,r,r]); ctx.fill();
      }
    }

    // ══ MODE 0 — Bar Spectrum ══════════════════════════════════
    function drawBarSpectrum(W, H, dpr) {
      drawBg(W, H);
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.03)'; ctx.lineWidth=1;
      for(let g=.25;g<1;g+=.25){ctx.beginPath();ctx.moveTo(0,H*g);ctx.lineTo(W,H*g);ctx.stroke();}
      const cg=CENTRE_GAP*dpr, hw=(W-cg)/2, bl=H*.85;
      drawBarChannel(dataL, peakL, peakVelL, 0,       hw, bl, dpr, false);
      ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.06)'; ctx.fillRect(hw,0,cg,H);
      drawBarChannel(dataR, peakR, peakVelR, hw+cg, hw, bl, dpr, true);
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,bl);ctx.lineTo(W,bl);ctx.stroke();
      drawLabels(W,H,dpr, bl+28*dpr, hw/2, hw+cg+hw/2);
    }

    // ══ MODE 1 — Mirror Bars ══════════════════════════════════
    function drawMirrorBars(W, H, dpr) {
      drawBg(W, H);
      const cg=CENTRE_GAP*dpr, hw=(W-cg)/2, cy=H/2;
      const gap=GAP*dpr, barW=(hw-gap*(BAR_COUNT-1))/BAR_COUNT;
      // draw both channels mirrored up+down
      [[dataL,0],[dataR,hw+cg]].forEach(([data,px],ci)=>{
        for(let i=0;i<BAR_COUNT;i++){
          const v=data[barBin(i,BAR_COUNT,data.length)]/255;
          const half=v*cy*.9;
          const x=px+i*(barW+gap);
          const hue=barHue(v);
          const grdU=ctx.createLinearGradient(0,cy,0,cy-half);
          grdU.addColorStop(0,`hsla(${hue},100%,50%,.9)`);
          grdU.addColorStop(1,`hsla(${hue+80},100%,78%,.85)`);
          ctx.shadowColor=`hsla(${hue},100%,55%,.5)`; ctx.shadowBlur=8*dpr;
          ctx.fillStyle=grdU; ctx.beginPath();
          ctx.roundRect(x,cy-half,barW,half,[Math.min(barW*.4,4*dpr),Math.min(barW*.4,4*dpr),0,0]);
          ctx.fill();
          const grdD=ctx.createLinearGradient(0,cy,0,cy+half);
          grdD.addColorStop(0,`hsla(${hue},100%,50%,.9)`);
          grdD.addColorStop(1,`hsla(${hue+80},100%,78%,.1)`);
          ctx.fillStyle=grdD; ctx.beginPath();
          ctx.roundRect(x,cy,barW,half,[0,0,Math.min(barW*.4,4*dpr),Math.min(barW*.4,4*dpr)]);
          ctx.fill();
        }
      });
      ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.06)'; ctx.fillRect(hw,0,cg,H);
      ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,cy);ctx.lineTo(W,cy);ctx.stroke();
      drawLabels(W,H,dpr, H*.92, hw/2, hw+cg+hw/2);
    }

    // ══ MODE 2 — Radial ═══════════════════════════════════════
    function drawRadial(W, H, dpr) {
      drawBg(W, H);
      const cx=W/2, cy=H/2, innerR=Math.min(W,H)*.12, outerMax=Math.min(W,H)*.47;
      const BARS=120;
      ctx.shadowBlur=0;
      // inner circle glow
      const cGrd=ctx.createRadialGradient(cx,cy,0,cx,cy,innerR);
      cGrd.addColorStop(0,'rgba(130,60,255,.35)'); cGrd.addColorStop(1,'rgba(130,60,255,0)');
      ctx.fillStyle=cGrd; ctx.beginPath(); ctx.arc(cx,cy,innerR,0,Math.PI*2); ctx.fill();
      // L = left half (π..2π), R = right half (0..π)
      [[dataL,Math.PI,2*Math.PI],[dataR,0,Math.PI]].forEach(([data,aStart,aEnd])=>{
        for(let i=0;i<BARS;i++){
          const v=data[barBin(i,BARS,data.length)]/255;
          const angle=lerp(aStart,aEnd,(i+.5)/BARS);
          const barLen=(outerMax-innerR)*v;
          const r1=innerR+2*dpr, r2=innerR+barLen;
          if(r2<=r1) continue;
          const hue=barHue(v);
          ctx.shadowColor=`hsla(${hue},100%,55%,.4)`; ctx.shadowBlur=8*dpr;
          ctx.strokeStyle=`hsla(${hue},100%,62%,.9)`; ctx.lineWidth=Math.max(2,W/600*dpr);
          ctx.beginPath();
          ctx.moveTo(cx+Math.cos(angle)*r1, cy+Math.sin(angle)*r1);
          ctx.lineTo(cx+Math.cos(angle)*r2, cy+Math.sin(angle)*r2);
          ctx.stroke();
        }
      });
      ctx.shadowBlur=0;
      // L / R labels
      const fs=Math.max(18,22*dpr);
      ctx.font=`700 ${fs}px system-ui,sans-serif`; ctx.textAlign='center';
      ctx.fillStyle='rgba(255,255,255,.45)';
      ctx.fillText('L',cx-innerR*1.8,cy); ctx.fillText('R',cx+innerR*1.8,cy);
    }

    // ══ MODE 3 — Oscilloscope ═════════════════════════════════
    function drawOscilloscope(W, H, dpr) {
      ctx.fillStyle='rgba(0,0,0,.88)'; ctx.fillRect(0,0,W,H);
      [[waveL,'#00ff88',H*.28],[waveR,'#00aaff',H*.72]].forEach(([wave,colour,midY])=>{
        ctx.shadowColor=colour; ctx.shadowBlur=14*dpr;
        ctx.strokeStyle=colour; ctx.lineWidth=1.5*dpr;
        ctx.beginPath();
        const sliceW=W/wave.length;
        for(let i=0;i<wave.length;i++){
          const x=i*sliceW;
          const y=midY+((wave[i]/128)-1)*H*.2;
          i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.stroke();
        // channel label
        ctx.shadowBlur=0; ctx.font=`700 ${Math.max(14,16*dpr)}px system-ui,sans-serif`;
        ctx.textAlign='left'; ctx.fillStyle=colour+'aa';
        ctx.fillText(colour==='#00ff88'?'L':'R', 12*dpr, midY-H*.22);
      });
    }

    // ══ MODE 4 — Waterfall / Spectrogram ═════════════════════
    function drawWaterfall(W, H, dpr) {
      const BINS=256;
      if (!waterfallRows || waterfallRows.width!==W) {
        waterfallRows=ctx.createImageData(W, H);
        waterfallPos=0;
      }
      // shift image down one row
      const rowBytes=W*4;
      waterfallRows.data.copyWithin(rowBytes, 0, W*H*4-rowBytes);
      // write new top row using average of L+R
      for(let x=0;x<W;x++){
        const i=Math.floor(x/W*BINS);
        const vL=dataL[Math.min(i,dataL.length-1)]/255;
        const vR=dataR[Math.min(i,dataR.length-1)]/255;
        const v=(vL+vR)/2;
        const hue=barHue(v)*1.1;
        // hsla→rgb inline (fast approximation)
        const l=0.1+v*0.55, s=1;
        const a=v>0.02?1:0;
        // simple hue→rgb
        function hsl2rgb(h,sl,ll){
          h=((h%360)+360)%360; const c=(1-Math.abs(2*ll-1))*sl;
          const x2=c*(1-Math.abs((h/60)%2-1)); const m=ll-c/2;
          let r=0,g=0,b=0;
          if(h<60){r=c;g=x2;}else if(h<120){r=x2;g=c;}
          else if(h<180){g=c;b=x2;}else if(h<240){g=x2;b=c;}
          else if(h<300){r=x2;b=c;}else{r=c;b=x2;}
          return[(r+m)*255,(g+m)*255,(b+m)*255];
        }
        const [r,g,b]=hsl2rgb(hue,s,l);
        const base=x*4;
        waterfallRows.data[base]=r; waterfallRows.data[base+1]=g;
        waterfallRows.data[base+2]=b; waterfallRows.data[base+3]=a*255;
      }
      ctx.clearRect(0,0,W,H);
      ctx.putImageData(waterfallRows,0,0);
      // time axis label
      ctx.shadowBlur=0; ctx.font=`${Math.max(11,13*dpr)}px system-ui,sans-serif`;
      ctx.textAlign='right'; ctx.fillStyle='rgba(255,255,255,.3)';
      ctx.fillText('L+R Spectrogram', W-10*dpr, H-10*dpr);
    }

    // ══ MODE 5 — Analog VU Needles ════════════════════════════
    function drawVUNeedles(W, H, dpr) {
      drawBg(W, H);
      const channels=[{data:dataL,label:'L',cx:W*.27},{data:dataR,label:'R',cx:W*.73}];
      const cy=H*.55, radius=Math.min(W*.22, H*.52);
      const arcStart=Math.PI*.75, arcEnd=Math.PI*2.25; // 135°..405° (270° sweep)
      channels.forEach(({data,label,cx})=>{
        // compute RMS-like level
        let sum=0; for(let i=0;i<data.length;i++) sum+=data[i]*data[i];
        const rms=Math.sqrt(sum/data.length)/255;
        // peak hold
        const key=label==='L'?'_vuPkL':'_vuPkR';
        const keyV=label==='L'?'_vuPkVL':'_vuPkVR';
        if(!startSpectrum[key]) startSpectrum[key]=0;
        if(!startSpectrum[keyV]) startSpectrum[keyV]=0;
        if(rms>startSpectrum[key]){startSpectrum[key]=rms;startSpectrum[keyV]=0;}
        else{startSpectrum[keyV]+=0.002; startSpectrum[key]-=startSpectrum[keyV]; if(startSpectrum[key]<0)startSpectrum[key]=0;}
        const pk=startSpectrum[key];

        // arc background
        ctx.shadowBlur=0;
        ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=18*dpr;
        ctx.lineCap='round';
        ctx.beginPath(); ctx.arc(cx,cy,radius,arcStart,arcEnd); ctx.stroke();

        // coloured arc fill
        const fillEnd=arcStart+(arcEnd-arcStart)*rms;
        const hue=barHue(rms);
        const arcGrd=ctx.createConicalGradient?null:null; // fallback: solid
        ctx.shadowColor=`hsla(${hue},100%,55%,.5)`; ctx.shadowBlur=16*dpr;
        ctx.strokeStyle=`hsla(${hue},100%,55%,.9)`; ctx.lineWidth=14*dpr;
        ctx.beginPath(); ctx.arc(cx,cy,radius,arcStart,fillEnd); ctx.stroke();

        // peak indicator tick
        const pkAngle=arcStart+(arcEnd-arcStart)*pk;
        ctx.shadowBlur=10*dpr; ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=3*dpr;
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(pkAngle)*(radius-10*dpr), cy+Math.sin(pkAngle)*(radius-10*dpr));
        ctx.lineTo(cx+Math.cos(pkAngle)*(radius+10*dpr), cy+Math.sin(pkAngle)*(radius+10*dpr));
        ctx.stroke();

        // needle
        const needleAngle=arcStart+(arcEnd-arcStart)*rms;
        ctx.shadowColor='rgba(255,200,50,.7)'; ctx.shadowBlur=12*dpr;
        ctx.strokeStyle='rgba(255,220,80,.95)'; ctx.lineWidth=2.5*dpr;
        ctx.lineCap='round';
        ctx.beginPath();
        ctx.moveTo(cx,cy);
        ctx.lineTo(cx+Math.cos(needleAngle)*radius*.92, cy+Math.sin(needleAngle)*radius*.92);
        ctx.stroke();

        // centre pivot dot
        ctx.shadowBlur=8*dpr; ctx.fillStyle='rgba(255,220,80,.9)';
        ctx.beginPath(); ctx.arc(cx,cy,6*dpr,0,Math.PI*2); ctx.fill();

        // db labels along arc
        ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.35)';
        ctx.font=`${Math.max(9,10*dpr)}px system-ui,sans-serif`; ctx.textAlign='center';
        ['-40','-20','-10','-6','-3','0','+3'].forEach((db,di,arr)=>{
          const t=di/(arr.length-1);
          const a=arcStart+(arcEnd-arcStart)*t;
          const lx=cx+Math.cos(a)*(radius+16*dpr), ly=cy+Math.sin(a)*(radius+16*dpr);
          ctx.fillText(db,lx,ly);
        });

        // channel label
        ctx.font=`700 ${Math.max(20,26*dpr)}px system-ui,sans-serif`;
        ctx.fillStyle='rgba(255,255,255,.5)'; ctx.textAlign='center';
        ctx.fillText(label, cx, cy+radius*.45);

        // dB value
        const db=rms>0?Math.max(-60,20*Math.log10(rms)):'-∞';
        ctx.font=`${Math.max(13,15*dpr)}px system-ui,sans-serif`;
        ctx.fillStyle='rgba(255,220,80,.7)';
        ctx.fillText(typeof db==='number'?db.toFixed(1)+' dB':db, cx, cy+radius*.62);
      });
    }

    // ══ MODE 6 — Lissajous / XY Phase Scope ══════════════════
    function drawLissajous(W, H, dpr) {
      ctx.fillStyle='rgba(0,0,0,.85)'; ctx.fillRect(0,0,W,H);
      const cx=W/2, cy=H/2, r=Math.min(W,H)*.42;
      // crosshair
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.07)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.stroke();
      ctx.beginPath();ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.stroke();
      // circle guide
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();

      const N=waveL.length;
      ctx.lineWidth=1.5*dpr;
      ctx.shadowColor='rgba(120,80,255,.6)'; ctx.shadowBlur=8*dpr;
      ctx.beginPath();
      for(let i=0;i<N;i++){
        const x=cx + ((waveL[i]-128)/128)*r;
        const y=cy - ((waveR[i]-128)/128)*r;
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      // colour by position using a gradient stroke
      const lGrd=ctx.createLinearGradient(cx-r,cy,cx+r,cy);
      lGrd.addColorStop(0,'rgba(0,200,255,.7)');
      lGrd.addColorStop(.5,'rgba(160,80,255,.8)');
      lGrd.addColorStop(1,'rgba(255,80,160,.7)');
      ctx.strokeStyle=lGrd; ctx.stroke();

      ctx.shadowBlur=0; ctx.font=`${Math.max(11,13*dpr)}px system-ui,sans-serif`;
      ctx.fillStyle='rgba(255,255,255,.3)'; ctx.textAlign='center';
      ctx.fillText('L → X   R → Y   Phase Correlation',cx,H-14*dpr);
    }

    // ── mode-name flash overlay ──────────────────────────────
    function drawModeLabel(W, H, dpr) {
      if (specLabelAlpha <= 0) return;
      ctx.shadowBlur=0;
      const fs=Math.max(22,28*dpr);
      ctx.font=`700 ${fs}px system-ui,sans-serif`;
      ctx.textAlign='center';
      ctx.fillStyle=`rgba(255,255,255,${specLabelAlpha.toFixed(2)})`;
      ctx.fillText(SPEC_MODES[specStyleIdx], W/2, H/2);
      specLabelAlpha=Math.max(0, specLabelAlpha-0.012);
    }

    // ── main render loop ────────────────────────────────────
    function drawFrame() {
      specFrameId = requestAnimationFrame(drawFrame);
      resizeCanvas();
      analyserL.getByteFrequencyData(dataL);
      analyserR.getByteFrequencyData(dataR);
      analyserL.getByteTimeDomainData(waveL);
      analyserR.getByteTimeDomainData(waveR);
      const W=canvas.width, H=canvas.height, dpr=window.devicePixelRatio||1;
      switch(specStyleIdx) {
        case 0: drawBarSpectrum(W,H,dpr); break;
        case 1: drawMirrorBars(W,H,dpr);  break;
        case 2: drawRadial(W,H,dpr);      break;
        case 3: drawOscilloscope(W,H,dpr);break;
        case 4: drawWaterfall(W,H,dpr);   break;
        case 5: drawVUNeedles(W,H,dpr);   break;
        case 6: drawLissajous(W,H,dpr);   break;
      }
      drawModeLabel(W,H,dpr);
    }

    // click anywhere on spectrum canvas to cycle modes
    canvas._specClick = () => {
      specStyleIdx = (specStyleIdx + 1) % SPEC_MODES.length;
      localStorage.setItem(_uKey('spec_style'), specStyleIdx);
      _syncPrefs();
      specLabelAlpha = 1.0;
      peakL.fill(0); peakVelL.fill(0);
      peakR.fill(0); peakVelR.fill(0);
      waterfallRows = null;
    };
    canvas.removeEventListener('click', canvas._specClick);
    canvas.addEventListener('click', canvas._specClick);

    drawFrame();
  }

  function stopSpectrum() {
    if (specFrameId) { cancelAnimationFrame(specFrameId); specFrameId = null; }
  }

  // ── AUDIOMOTION RENDERER ──────────────────────────────────
  function _applyAMPreset() {
    if (!amAnalyzer) return;
    const p = AM_PRESETS[amPresetIdx];
    amAnalyzer.mode          = p.mode;
    amAnalyzer.gradient      = p.gradient;
    amAnalyzer.reflexRatio   = p.reflexRatio ?? 0;
    amAnalyzer.mirror        = p.mirror ?? 0;
    amAnalyzer.channelLayout = p.channelLayout ?? 'single';
    amAnalyzer.radial        = p.radial   ?? false;
    amAnalyzer.spinSpeed     = p.spinSpeed ?? 0;
    amAnalyzer.ledBars       = p.ledBars  ?? false;
    amAnalyzer.lumiBars      = p.lumiBars ?? false;
    amAnalyzer.showScaleX    = false;
    amAnalyzer.showScaleY    = false;
    amAnalyzer.showPeaks     = true;
    amAnalyzer.showBgColor   = true;
    amAnalyzer.bgAlpha       = 0.7;
    // Update label
    const presetName = document.getElementById('viz-preset-name');
    if (presetName) presetName.textContent = 'AudioMotion: ' + p.name + ' \u00b7 click to cycle';
  }

  function startAudioMotion(container) {
    if (!window.AudioMotionAnalyzer) { toast('audioMotion not loaded yet'); return; }
    if (!audioCtx) { toast('Play a song first to initialise audio'); return; }
    if (!amAnalyzer) {
      amAnalyzer = new AudioMotionAnalyzer(container, {
        audioCtx,
        connectSpeakers: false,  // IMPORTANT: we already have our own audio routing
        fftSize:    8192,
        smoothing:  0.7,
        start:      false,
      });
      // Register a custom velvet-theme gradient
      amAnalyzer.registerGradient('velvet', {
        bgColor:    '#080810',
        colorStops: ['#9b59b6', '#6d3ce6', '#3498db', '#1abc9c', '#7bed9f'],
      });
      // Tap our existing main analyser node (same pre-panner tap as butterchurn)
      amAnalyzer.connectInput(analyserNode);
      // Click the container to cycle through AM presets
      container._amClick = () => {
        amPresetIdx = (amPresetIdx + 1) % AM_PRESETS.length;
        _applyAMPreset();
      };
      container.addEventListener('click', container._amClick);
    }
    _applyAMPreset();
    amAnalyzer.toggleAnalyzer(true);
  }

  function stopAudioMotion() {
    if (amAnalyzer) amAnalyzer.toggleAnalyzer(false);
  }

  // ── Lyric helpers ────────────────────────────────────────────
  async function fetchAndRenderLyrics() {
    const s = S.queue[S.idx];
    const linesEl = document.getElementById('vlm-lines');
    if (!linesEl) return;
    linesEl.innerHTML = '<div class="vlm-no-lyrics">Loading lyrics…</div>';
    lyricLines = []; lyricSynced = false; lyricActiveIdx = -1;

    // Update art panel
    const artEl     = document.getElementById('vlm-art');
    const artBlurEl = document.getElementById('vlm-art-blur');
    if (artEl && s) {
      const u = artUrl(s['album-art'], 'l');
      artEl.innerHTML = u
        ? `<img src="${u}" alt="" onerror="this.parentNode.innerHTML=''">` : '';
      if (artBlurEl) artBlurEl.style.backgroundImage = u ? `url('${u}')` : 'none';
    }

    if (!s) {
      linesEl.innerHTML = '<div class="vlm-no-lyrics">No track playing</div>';
      return;
    }

    const artist   = encodeURIComponent(s.artist  || '');
    const title    = encodeURIComponent(s.title   || s.filepath?.split('/').pop() || '');
    const duration = encodeURIComponent(Math.round(s.duration || 0));
    const filepath = encodeURIComponent(s.filepath || '');

    try {
      const r = await fetch(`/api/v1/lyrics?artist=${artist}&title=${title}&duration=${duration}&filepath=${filepath}`,
        { headers: { 'x-access-token': S.token } });
      const data = await r.json();

      if (data.notFound || !data.lines || !data.lines.length) {
        linesEl.innerHTML = '<div class="vlm-no-lyrics">No lyrics found</div>';
        return;
      }

      lyricLines  = data.lines;
      lyricSynced = !!data.synced;

      // Render all lines
      linesEl.innerHTML = '';
      lyricLines.forEach((ln, i) => {
        const div = document.createElement('div');
        div.className = 'vlm-line';
        div.dataset.i = i;
        div.textContent = ln.text || '';
        linesEl.appendChild(div);
      });

      // Reset scroll to top then immediately jump to current position
      // Capture start offset so crossfade mid-song loads start at the right position
      lyricActiveDiv = null;
      linesEl.scrollTop = 0;
      lyricActiveIdx = -1;
      lyricTick(audioEl.currentTime);
    } catch (_e) {
      linesEl.innerHTML = '<div class="vlm-no-lyrics">No lyrics found</div>';
    }
  }

  function lyricFillTick() {
    lyricRafId = requestAnimationFrame(lyricFillTick);
    if (!lyricSynced || !lyricLines.length) return;
    const linesEl = document.getElementById('vlm-lines');
    if (!linesEl) return;
    const divs = linesEl.querySelectorAll('.vlm-line');
    const now = audioEl.currentTime - 0.2;
    const active = lyricActiveIdx;

    divs.forEach((d, i) => {
      if (i === active) return; // CSS handles the active line
      const dist = i - active; // positive = upcoming, negative = past
      let alpha;
      if (dist > 0) {
        // Upcoming lines ramp: dist1=0.65→1.0 (real-time), dist2=0.52, dist3=0.42, dist4=0.34, dist5+=0.28 floor
        if (dist === 1 && lyricLines[i] && lyricLines[i].time != null) {
          const timeUntil = lyricLines[i].time - (audioEl.currentTime - 0.2);
          if (timeUntil > 0 && timeUntil < 2.5) {
            alpha = 0.35 + (1 - timeUntil / 2.5) * 0.65; // 0.35 → 1.0 (seamless into active)
          } else {
            alpha = 0.65;
          }
        } else {
          alpha = Math.max(0.28, 0.65 - (dist - 1) * 0.12);
        }
      } else {
        // Past lines: -1=0.65, -2=0.55, -3=0.46, -4=0.38, -5=0.31, -6+=0.28 floor
        alpha = Math.max(0.28, 0.65 + (dist + 1) * 0.10);
      }
      d.style.color = `rgba(255,255,255,${alpha.toFixed(2)})`;
    });
  }

  function startLyricRaf() { if (!lyricRafId) lyricFillTick(); }
  function stopLyricRaf() {
    if (lyricRafId) { cancelAnimationFrame(lyricRafId); lyricRafId = null; }
    lyricActiveDiv = null;
  }

  function lyricTick(currentTime) {
    if (vizTopMode !== 3 || !lyricSynced || !lyricLines.length) return;
    const linesEl = document.getElementById('vlm-lines');
    if (!linesEl) return;

    // -0.2 s: slightly early is better than late
    const t = currentTime - 0.2;

    // Find the last line whose time <= t
    let newIdx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time <= t) newIdx = i;
      else break;
    }
    if (newIdx === lyricActiveIdx) return;

    lyricActiveIdx = newIdx;

    const divs = linesEl.querySelectorAll('.vlm-line');
    divs.forEach((d, i) => {
      d.classList.toggle('vlm-active', i === newIdx);
      if (i === newIdx) d.style.color = ''; // CSS vlm-active takes over (rAF skips active line)
    });

    // Cache active div for rAF fill updates
    lyricActiveDiv = (newIdx >= 0 && divs[newIdx]) ? divs[newIdx] : null;

    if (newIdx < 0) {
      // Before first lyric line — scroll to top so first lines are visible
      linesEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (divs[newIdx]) {
      // Scroll active line to vertical centre of the container
      const top = divs[newIdx].offsetTop - (linesEl.clientHeight / 2) + (divs[newIdx].offsetHeight / 2);
      linesEl.scrollTo({ top, behavior: 'smooth' });
    }
  }

  // ── Split-flap (flipboard) mode ──────────────────────────────
  // ── Split-flap (flipboard) mode ──────────────────────────────
  // Self-contained board built from individual tile DOM nodes.
  // Each tile has: fixed top half, fixed bottom half, and two flap halves
  // that hinge on the centre line to animate character changes.
  const FLIP_CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,-!?\'/:()';
  const FLIP_COLS    = 22;   // characters per row
  const FLIP_ROWS    = 3;    // rows visible at once
  const FLIP_STAGGER = 28;   // ms between each tile in a row
  const FLIP_DUR     = 200;  // ms for one flip animation

  // Board state
  let _flipGrid   = [];     // FLIP_ROWS × FLIP_COLS DOM tile objects
  let _flipChars  = [];     // current displayed chars [row][col]
  let _flipActive = -1;     // which row is the "active" lyric (highlighted)
  let _flipRafId  = null;
  let _flipLyricActiveIdx = -1;  // mirrors lyricActiveIdx for flipboard

  function _flipChar(charStr) {
    // Normalise to a char in FLIP_CHARSET; uppercase only
    const c = (charStr || ' ').toUpperCase();
    return FLIP_CHARSET.includes(c) ? c : ' ';
  }

  function _createTile(initChar) {
    const c = _flipChar(initChar);
    const wrap = document.createElement('div');
    wrap.className = 'flip-tile';

    // Bottom half — always visible, pre-loaded with new char from first frame
    const bottomBg = document.createElement('div');
    bottomBg.className = 'ft-bottom-bg';
    const bottomInner = document.createElement('div');
    bottomInner.className = 'ft-inner';
    bottomInner.textContent = c;
    bottomBg.appendChild(bottomInner);

    // Top half backing — shows new char's top half, sits behind the flap
    const topBg = document.createElement('div');
    topBg.className = 'ft-top-bg';
    const topInner = document.createElement('div');
    topInner.className = 'ft-inner';
    topInner.textContent = c;
    topBg.appendChild(topInner);

    // Flap — covers top half, shows OLD char, drops 0°→90° on centre hinge
    const flap = document.createElement('div');
    flap.className = 'ft-flap';
    const flapInner = document.createElement('div');
    flapInner.className = 'ft-inner';
    flapInner.textContent = c;
    flap.appendChild(flapInner);

    wrap.appendChild(bottomBg);
    wrap.appendChild(topBg);
    wrap.appendChild(flap);

    return { el: wrap, bottomBg, topBg, flap, char: c, animating: false };
  }

  function _buildFlipBoard() {
    const container = document.getElementById('vlm-flip-board');
    if (!container) return;
    container.innerHTML = '';
    _flipGrid  = [];
    _flipChars = [];

    for (let r = 0; r < FLIP_ROWS; r++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'flip-row';
      const rowTiles = [];
      const rowChars = [];
      for (let c = 0; c < FLIP_COLS; c++) {
        const tile = _createTile(' ');
        rowEl.appendChild(tile.el);
        rowTiles.push(tile);
        rowChars.push(' ');
      }
      container.appendChild(rowEl);
      _flipGrid.push({ el: rowEl, tiles: rowTiles });
      _flipChars.push(rowChars);
    }
    _flipActive = -1;
    _flipLyricActiveIdx = -1;
  }

  function _flipTileTo(tile, newChar, delay) {
    const c = _flipChar(newChar);
    if (tile.char === c && !tile.animating) return;
    tile.char = c;

    setTimeout(() => {
      if (tile.animating) return;
      tile.animating = true;

      // Load new char on backing elements immediately.
      // bottom half is already visible (real boards pre-show next card's bottom).
      tile.bottomBg.querySelector('.ft-inner').textContent = c;
      tile.topBg.querySelector('.ft-inner').textContent    = c;

      // Animate flap (old char top half) falling: 0° → 90° around the centre hinge.
      // backface-visibility:hidden makes it invisible once it passes 90°,
      // cleanly revealing ft-top-bg (new char top) beneath.
      const startTime = performance.now();

      function animate(now) {
        const t = Math.min((now - startTime) / FLIP_DUR, 1);
        // ease-in quad — accelerates as the card falls, feels natural
        const ease = t * t;
        tile.flap.style.transform = `rotateX(${ease * 90}deg)`;
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          // Flap is edge-on/invisible at 90°. Snap text + angle back to rest.
          tile.flap.querySelector('.ft-inner').textContent = c;
          tile.flap.style.transition = 'none';
          tile.flap.style.transform  = 'rotateX(0deg)';
          requestAnimationFrame(() => {
            tile.flap.style.transition = '';
            tile.animating = false;
          });
        }
      }
      requestAnimationFrame(animate);
    }, delay);
  }

  function _flipDisplayLines(lines, activeRow) {
    // lines: array of strings, each up to FLIP_COLS chars
    // activeRow: which row index to highlight (-1 = none)
    for (let r = 0; r < FLIP_ROWS; r++) {
      const text  = (lines[r] || '').toUpperCase();
      const row   = _flipGrid[r];
      if (!row) continue;

      // Update active highlight
      row.el.classList.toggle('flip-row-active', r === activeRow);

      // Pad / centre text
      const pad   = Math.max(0, Math.floor((FLIP_COLS - text.length) / 2));
      const padded = (' '.repeat(pad) + text).padEnd(FLIP_COLS, ' ').slice(0, FLIP_COLS);

      padded.split('').forEach((ch, c) => {
        const want = _flipChar(ch);
        if (_flipChars[r][c] !== want) {
          _flipChars[r][c] = want;
          _flipTileTo(row.tiles[c], want, c * FLIP_STAGGER);
        }
      });
    }
    _flipActive = activeRow;
  }

  // Slice FLIP_ROWS lines centred around activeIdx
  function _flipGetWindow(lines, activeIdx) {
    if (!lines || !lines.length) return { window: ['', '', ''], rowInWindow: -1 };
    const total = lines.length;
    if (total <= FLIP_ROWS) {
      return {
        window: lines.map(l => l.text || '').concat(Array(FLIP_ROWS).fill('')).slice(0, FLIP_ROWS),
        rowInWindow: activeIdx >= 0 ? activeIdx : -1,
      };
    }
    // Centre the active line in the middle row
    const mid  = Math.floor(FLIP_ROWS / 2);
    let start  = Math.max(0, activeIdx - mid);
    let end    = start + FLIP_ROWS;
    if (end > total) { end = total; start = Math.max(0, end - FLIP_ROWS); }
    const slice = lines.slice(start, end).map(l => l.text || '');
    while (slice.length < FLIP_ROWS) slice.push('');
    return { window: slice, rowInWindow: activeIdx - start };
  }

  function flipboardTick(currentTime) {
    if (vizTopMode !== 4) return;
    if (!lyricLines.length) return;

    const t = currentTime - 0.2;
    let newIdx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time != null && lyricLines[i].time <= t) newIdx = i;
      else if (lyricLines[i].time != null) break;
    }

    if (newIdx === _flipLyricActiveIdx) return;
    _flipLyricActiveIdx = newIdx;

    const { window: win, rowInWindow } = _flipGetWindow(lyricLines, newIdx);
    _flipDisplayLines(win, rowInWindow);
  }

  async function fetchAndRenderFlipboard() {
    const container = document.getElementById('vlm-flip-board');
    if (!container) return;

    _buildFlipBoard();
    _flipLyricActiveIdx = -1;

    // Reuse the same lyric data already fetched (or fetch if not yet available)
    if (lyricLines.length > 0) {
      const { window: win, rowInWindow } = _flipGetWindow(lyricLines, lyricActiveIdx);
      _flipDisplayLines(win, rowInWindow);
      return;
    }

    // Need to fetch
    const s = S.queue[S.idx];
    if (!s) { _flipDisplayLines(['NO TRACK PLAYING', '', ''], -1); return; }

    _flipDisplayLines(['LOADING...', '', ''], -1);

    const artist   = encodeURIComponent(s.artist  || '');
    const title    = encodeURIComponent(s.title   || s.filepath?.split('/').pop() || '');
    const duration = encodeURIComponent(Math.round(s.duration || 0));
    const filepath = encodeURIComponent(s.filepath || '');

    try {
      const r = await fetch(
        `/api/v1/lyrics?artist=${artist}&title=${title}&duration=${duration}&filepath=${filepath}`,
        { headers: { 'x-access-token': S.token } }
      );
      const data = await r.json();
      if (data.notFound || !data.lines || !data.lines.length) {
        // Show song info instead
        _flipDisplayLines([
          (s.title || '').toUpperCase().slice(0, FLIP_COLS),
          (s.artist || '').toUpperCase().slice(0, FLIP_COLS),
          'NO LYRICS FOUND',
        ], -1);
        return;
      }
      // Share the parsed state with regular lyrics mode
      lyricLines  = data.lines;
      lyricSynced = !!data.synced;
      lyricActiveIdx = -1;
      const { window: win, rowInWindow } = _flipGetWindow(lyricLines, -1);
      _flipDisplayLines(win, rowInWindow);
    } catch (_e) {
      _flipDisplayLines(['ERROR LOADING', 'LYRICS', ''], -1);
    }
  }

  function applyMode() {
    const bcCanvas   = document.getElementById('viz-canvas');
    const spCanvas   = document.getElementById('spec-canvas');
    const amCont     = document.getElementById('am-container');
    const label      = document.getElementById('viz-mode-label');
    const modeBtn    = document.getElementById('viz-mode-btn');
    const prevBtn    = document.getElementById('viz-prev-btn');
    const nextBtn    = document.getElementById('viz-next-btn');
    const presetName = document.getElementById('viz-preset-name');

    const MODE_NAMES = ['Milkdrop', 'Spectrum', 'AudioMotion', 'Lyrics'];
    const nextMode   = (vizTopMode + 1) % MODE_NAMES.length;
    if (label)   label.textContent          = MODE_NAMES[vizTopMode];
    if (modeBtn) modeBtn.dataset.tip        = 'Switch to ' + MODE_NAMES[nextMode];

    // Stop all active renderers
    stopSpectrum();
    stopAudioMotion();
    stopLyricRaf();
    if (frameId) { cancelAnimationFrame(frameId); frameId = null; }

    // Hide all surfaces
    bcCanvas.classList.add('hidden');
    spCanvas.classList.add('hidden');
    if (amCont) amCont.classList.add('hidden');
    const lyricMode = document.getElementById('viz-lyric-mode');
    if (lyricMode) lyricMode.classList.add('hidden');

    if (vizTopMode === 0) {
      // ── Milkdrop / Butterchurn ──────────────────────
      bcCanvas.classList.remove('hidden');
      if (prevBtn)    prevBtn.style.visibility = '';
      if (nextBtn)    nextBtn.style.visibility = '';
      if (presetName) { presetName.style.visibility = ''; setPresetLabel(); }
      if (!visualizer) initViz(bcCanvas);
      else if (!frameId) startRender();

    } else if (vizTopMode === 1) {
      // ── Custom Spectrum (7 modes, click canvas to cycle) ──
      spCanvas.classList.remove('hidden');
      if (prevBtn)    prevBtn.style.visibility = 'hidden';
      if (nextBtn)    nextBtn.style.visibility = 'hidden';
      if (presetName) presetName.style.visibility = 'hidden';
      startSpectrum(spCanvas);

    } else if (vizTopMode === 2) {
      // ── AudioMotion Analyzer ─────────────────────────
      if (amCont) amCont.classList.remove('hidden');
      if (prevBtn)    prevBtn.style.visibility = 'hidden';
      if (nextBtn)    nextBtn.style.visibility = 'hidden';
      if (presetName) presetName.style.visibility = '';
      if (amCont) startAudioMotion(amCont);

    } else {
      // ── Lyric mode ────────────────────────────────────
      if (lyricMode) lyricMode.classList.remove('hidden');
      if (prevBtn)    prevBtn.style.visibility = 'hidden';
      if (nextBtn)    nextBtn.style.visibility = 'hidden';
      if (presetName) presetName.style.visibility = 'hidden';
      fetchAndRenderLyrics();
      startLyricRaf();
    }
  }

  function updateSongInfo() {
    const s = S.queue[S.idx];
    const t = document.getElementById('viz-song-title');
    const a = document.getElementById('viz-song-artist');
    if (t) t.textContent = s ? (s.title || s.filepath?.split('/').pop() || '') : '';
    if (a) a.textContent = s?.artist || '';
  }

  return {
    open() {
      ensureAudio();
      const overlay = document.getElementById('viz-overlay');
      overlay.classList.remove('hidden');
      document.getElementById('viz-open-btn').classList.add('active');
      updateSongInfo();
      if (vizTopMode === 0) {
        const canvas = document.getElementById('viz-canvas');
        if (!visualizer) {
          initViz(canvas);
        } else {
          canvas.width  = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
          visualizer.setRendererSize(canvas.width, canvas.height);
          if (!frameId) startRender();
        }
        applyMode();
      } else {
        applyMode();
      }
    },
    close() {
      document.getElementById('viz-overlay').classList.add('hidden');
      document.getElementById('viz-open-btn').classList.remove('active');
      document.getElementById('viz-open-btn').blur();
      if (frameId)    { cancelAnimationFrame(frameId);    frameId    = null; }
      if (specFrameId){ cancelAnimationFrame(specFrameId); specFrameId = null; }
      stopAudioMotion();
      stopLyricRaf();
      lyricLines = []; lyricActiveIdx = -1;
    },
    next()  {
      if (vizTopMode !== 0) return;
      presetHistory.push(presetIndex);
      presetIndex = Math.floor(Math.random() * presetKeys.length);
      loadPreset(2.7);
    },
    prev()  {
      if (vizTopMode !== 0) return;
      if (presetHistory.length) presetIndex = presetHistory.pop();
      else presetIndex = ((presetIndex - 1) + presetKeys.length) % presetKeys.length;
      loadPreset(2.7);
    },
    toggleMode() {
      vizTopMode = (vizTopMode + 1) % 4;
      applyMode();
    },
    lyricTick(t) {
      lyricTick(t);
    },
    songChanged() {
      updateSongInfo();
      const overlayHidden = document.getElementById('viz-overlay').classList.contains('hidden');
      if (!overlayHidden) {
        if (vizTopMode === 3) fetchAndRenderLyrics();
      }
    },
    initAudio()   { ensureAudio(); },
  };
})();

// ── MODALS ────────────────────────────────────────────────────
function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id)  { document.getElementById(id).classList.add('hidden'); }

function showConfirmModal(title, msg, onOk) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-msg').textContent   = msg;
  const okBtn = document.getElementById('confirm-modal-ok');
  const newOk = okBtn.cloneNode(true); // remove any previous listener
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener('click', () => { hideModal('confirm-modal'); onOk(); });
  showModal('confirm-modal');
}

// ── UPLOAD MODAL ──────────────────────────────────────────────
function openUploadModal(dir) {
  let pendingFiles = [];   // { file: File, status: 'waiting'|'uploading'|'done'|'error' }

  const destEl    = document.getElementById('upload-modal-dest');
  const dropZone  = document.getElementById('upload-drop-zone');
  const listEl    = document.getElementById('upload-file-list');
  const startBtn  = document.getElementById('upload-start-btn');

  destEl.textContent = `Destination: ${dir}`;
  pendingFiles = [];
  listEl.innerHTML = '';
  startBtn.disabled = true;
  startBtn.onclick = null;  // clear any previous listener without cloning

  function fmtSize(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderList() {
    listEl.innerHTML = pendingFiles.map((pf, i) => `
      <div class="upload-file-item" id="ufi-${i}">
        <div class="upload-file-row">
          <span class="upload-file-name" title="${esc(pf.file.name)}">${esc(pf.file.name)}</span>
          <span class="upload-file-size">${fmtSize(pf.file.size)}</span>
          ${pf.status === 'waiting'
            ? `<button class="upload-file-remove" data-idx="${i}" title="Remove">✕</button>`
            : `<span class="upload-file-status">${pf.status === 'done' ? '✓' : pf.status === 'error' ? '✗' : '…'}</span>`}
        </div>
        <div class="upload-progress"><div class="upload-progress-bar" id="upb-${i}" style="width:${pf.progress || 0}%"></div></div>
      </div>`).join('');
    listEl.querySelectorAll('.upload-file-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingFiles.splice(parseInt(btn.dataset.idx), 1);
        renderList();
      });
    });
    startBtn.disabled = pendingFiles.length === 0;
  }

  function addFiles(files) {
    const rejected = [];
    Array.from(files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (Object.keys(S.supportedAudioFiles).length > 0 && !S.supportedAudioFiles[ext]) {
        rejected.push(f.name);
        return;
      }
      if (!pendingFiles.some(p => p.file.name === f.name && p.file.size === f.size)) {
        pendingFiles.push({ file: f, status: 'waiting', progress: 0 });
      }
    });
    if (rejected.length > 0) {
      const names = rejected.slice(0, 2).join(', ') + (rejected.length > 2 ? ` +${rejected.length - 2} more` : '');
      toastError(`Not allowed: ${names}`);
    }
    renderList();
  }

  // Reset listeners by cloning the drop zone
  const newDrop  = dropZone.cloneNode(true);
  const newInput = newDrop.querySelector('#upload-file-input');
  dropZone.parentNode.replaceChild(newDrop, dropZone);

  // Set accept attribute from server's supported audio file list
  const _acceptExts = Object.entries(S.supportedAudioFiles).filter(([,v]) => v).map(([k]) => '.' + k).join(',');
  if (_acceptExts) newInput.setAttribute('accept', _acceptExts);

  newDrop.addEventListener('click', e => { if (!e.target.closest('label')) newInput.click(); });
  newInput.addEventListener('change', () => { addFiles(newInput.files); newInput.value = ''; });
  newDrop.addEventListener('dragover',  e => { e.preventDefault(); newDrop.classList.add('drag-over'); });
  newDrop.addEventListener('dragleave', ()=> { newDrop.classList.remove('drag-over'); });
  newDrop.addEventListener('drop', e => {
    e.preventDefault(); newDrop.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  startBtn.onclick = async () => {
    startBtn.disabled = true;
    let doneCount = 0, errorCount = 0;

    for (let i = 0; i < pendingFiles.length; i++) {
      const pf = pendingFiles[i];
      if (pf.status !== 'waiting') continue;
      pf.status = 'uploading';
      renderList();

      await new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            pf.progress = Math.round((e.loaded / e.total) * 100);
            const bar = document.getElementById(`upb-${i}`);
            if (bar) bar.style.width = pf.progress + '%';
          }
        };
        xhr.onload = () => {
          pf.progress = 100;
          if (xhr.status >= 200 && xhr.status < 300) {
            pf.status = 'done'; doneCount++;
          } else {
            pf.status = 'error'; errorCount++;
          }
          renderList(); resolve();
        };
        xhr.onerror = () => { pf.status = 'error'; errorCount++; renderList(); resolve(); };
        xhr.open('POST', '/api/v1/file-explorer/upload');
        xhr.setRequestHeader('x-access-token', S.token);
        xhr.setRequestHeader('data-location', encodeURI(dir));
        const fd = new FormData();
        fd.append('file', pf.file);
        xhr.send(fd);
      });
    }

    // All done
    const allDone = pendingFiles.every(p => p.status === 'done' || p.status === 'error');
    if (allDone) {
      setTimeout(() => {
        hideModal('upload-modal');
        if (doneCount > 0) {
          viewFiles(dir, false);
          toast(`${doneCount} file${doneCount !== 1 ? 's' : ''} uploaded`);
        }
        if (errorCount > 0) {
          toast(`${errorCount} file${errorCount !== 1 ? 's' : ''} failed to upload`);
        }
      }, 500);
    }
  };

  showModal('upload-modal');
}

function showSavePlaylistModal() {
  document.getElementById('pl-save-name').value = '';
  showModal('pl-save-modal');
  setTimeout(() => document.getElementById('pl-save-name').focus(), 50);
}
function showNewPlaylistModal() {
  document.getElementById('pl-new-name').value = '';
  showModal('pl-new-modal');
  setTimeout(() => document.getElementById('pl-new-name').focus(), 50);
}
function showDeletePlaylistModal(name) {
  document.getElementById('pl-del-msg').textContent = `"${name}" will be permanently removed. This cannot be undone.`;
  document.getElementById('pl-del-ok').dataset.pl = name;
  showModal('pl-del-modal');
}
function showRenamePlaylistModal(name) {
  document.getElementById('pl-rename-input').value = name;
  document.getElementById('pl-rename-ok').dataset.pl = name;
  showModal('pl-rename-modal');
  setTimeout(() => document.getElementById('pl-rename-input').select(), 50);
}
function showAddToPlaylistModal(song) {
  const list = document.getElementById('atp-list');
  if (!S.playlists.length) {
    list.innerHTML = `<div class="modal-empty">No playlists yet. Create one first.</div>`;
  } else {
    list.innerHTML = S.playlists.map(p =>
      `<div class="modal-pl-item" data-pl="${esc(p.name)}">
        <svg class="modal-pl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.name)}
      </div>`
    ).join('');
    list.querySelectorAll('.modal-pl-item').forEach(el => {
      el.addEventListener('click', async () => {
        hideModal('atp-modal');
        try {
          await api('POST', 'api/v1/playlist/add-song', { song: song.filepath, playlist: el.dataset.pl });
          toast(`Added to "${el.dataset.pl}"`);
        } catch(e) { toast('Failed to add to playlist'); }
      });
    });
  }
  showModal('atp-modal');
}

// ── SHARE PLAYLIST ───────────────────────────────────────────
function showSharePlaylistModal(songs) {
  const resultEl = document.getElementById('share-pl-result');
  const urlEl    = document.getElementById('share-pl-url');
  const okBtn    = document.getElementById('share-pl-ok');
  resultEl.classList.add('hidden');
  urlEl.value = '';
  document.getElementById('share-pl-expires').value = '';
  okBtn.disabled = false;
  okBtn.textContent = 'Create link';
  showModal('share-pl-modal');

  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.textContent = 'Creating…';
    try {
      const expires = document.getElementById('share-pl-expires').value;
      const body = { playlist: songs.map(s => s.filepath) };
      if (expires) body.time = parseInt(expires);
      const d = await api('POST', 'api/v1/share', body);
      const url = `${location.origin}/shared/${d.playlistId}`;
      urlEl.value = url;
      resultEl.classList.remove('hidden');
      okBtn.textContent = 'Create another';
      okBtn.disabled = false;
    } catch(e) {
      toast('Failed to create share link');
      okBtn.disabled = false;
      okBtn.textContent = 'Create link';
    }
  };

  document.getElementById('share-pl-copy').onclick = () => {
    const url = urlEl.value;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('share-pl-copy');
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Copied!`;
      setTimeout(() => { btn.innerHTML = orig; }, 1800);
    }).catch(() => { urlEl.select(); toast('Copy failed — select the URL manually'); });
  };
}

// ── PLAYLISTS ────────────────────────────────────────────────
async function loadPlaylists() {
  try {
    S.playlists = (await api('GET', 'api/v1/playlist/getall')) || [];
  } catch(_) { S.playlists = []; }
  renderPlaylistNav();
}

function renderPlaylistNav() {
  const nav = document.getElementById('playlist-nav');
  nav.innerHTML = S.playlists.map(p => `
    <div class="pl-row" data-pl="${esc(p.name)}">
      <button class="pl-row-btn" data-pl="${esc(p.name)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.name)}
      </button>
      <button class="pl-row-share" data-pl="${esc(p.name)}" title="Share">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
      <button class="pl-row-edit" data-pl="${esc(p.name)}" title="Rename">✎</button>
      <button class="pl-row-del" data-pl="${esc(p.name)}" title="Delete">×</button>
    </div>`).join('');

  nav.querySelectorAll('.pl-row-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlaylist(btn.dataset.pl));
  });
  nav.querySelectorAll('.pl-row-share').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = btn.dataset.pl;
      try {
        const d = await api('POST', 'api/v1/playlist/load', { playlistname: name });
        const songs = d.map(item => norm(item));
        showSharePlaylistModal(songs);
      } catch(_) { toast('Failed to load playlist'); }
    });
  });
  nav.querySelectorAll('.pl-row-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showRenamePlaylistModal(btn.dataset.pl);
    });
  });
  nav.querySelectorAll('.pl-row-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.dataset.pl;
      showDeletePlaylistModal(name);
    });
  });
}

async function openPlaylist(name) {
  setTitle(name);
  setBack(null);
  setPlaylistActive(name);
  S.view = 'playlist:' + name;
  setBody('<div class="loading-state"></div>');

  document.getElementById('play-all-btn').onclick = () => {
    if (S.curSongs.length) { _setPlaySource('playlist', name); Player.setQueue(S.curSongs, 0); toast(`Playing "${name}"`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (S.curSongs.length) { Player.addAll(S.curSongs); }
  };
  _exitSelectMode();
  const zipBtnPl = document.getElementById('zip-dl-btn');
  if (zipBtnPl) {
    zipBtnPl.classList.remove('hidden');
    zipBtnPl.onclick = () => _zipDownload(S.curSongs, name);
  }
  const selBtnPl = document.getElementById('select-mode-btn');
  if (selBtnPl) { selBtnPl.classList.remove('hidden'); selBtnPl.onclick = _toggleSelectMode; }

  try {
    const d = await api('POST', 'api/v1/playlist/load', { playlistname: name });
    const songs = d.map(item => ({ ...norm(item), _plid: item.id }));
    S.curSongs = songs;
    if (!songs.length) { setBody('<div class="empty-state">This playlist is empty</div>'); return; }
    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <button id="pl-save-cur-btn" class="btn-sm">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>
          Save current queue into "${esc(name)}"
        </button>
      </div>
      <div class="song-list">${renderSongRows(songs)}</div>`;
    document.getElementById('pl-save-cur-btn').onclick = async () => {
      if (!S.queue.length) { toast('Queue is empty'); return; }
      try {
        await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
        toast(`Saved ${S.queue.length} songs to "${name}"`);
        openPlaylist(name);
      } catch(e) { toast('Save failed'); }
    };
    attachSongListEvents(body, songs);
    highlightRow();
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── VIEWS ─────────────────────────────────────────────────────
async function viewSharedLinks() {
  setTitle('Shared Links'); setBack(null); setNavActive('shared-links'); S.view = 'shared-links';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  try {
    const items = await api('GET', 'api/v1/share/list');
    if (!items.length) {
      setBody(`<div class="empty-state">No shared links yet.<br>Use the share button in the queue panel to share your queue.</div>`);
      return;
    }
    const body = document.getElementById('content-body');
    body.innerHTML = `<div class="shared-links-list">${items.map(item => {
      const url = `${location.origin}/shared/${item.playlistId}`;
      const exp = item.expires ? new Date(item.expires * 1000).toLocaleDateString() : 'Never';
      const expired = item.expires && item.expires * 1000 < Date.now();
      return `<div class="shared-link-row${expired ? ' shared-expired' : ''}" data-id="${esc(item.playlistId)}">
        <div class="shared-link-info">
          <div class="shared-link-url">${esc(url)}</div>
          <div class="shared-link-meta">${item.songCount} song${item.songCount !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; Expires: ${exp}${expired ? ' <span class="shared-expired-tag">expired</span>' : ''}</div>
        </div>
        <div class="shared-link-actions">
          <button class="btn-ghost shared-copy-btn" data-url="${esc(url)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open
          </a>
          <button class="btn-ghost shared-del-btn" data-id="${esc(item.playlistId)}" style="color:var(--red)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M9,6V4h6v2"/></svg>
            Delete
          </button>
        </div>
      </div>`;
    }).join('')}</div>`;
    body.querySelectorAll('.shared-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.url).then(() => {
          const orig = btn.innerHTML;
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Copied!`;
          setTimeout(() => { btn.innerHTML = orig; }, 1800);
        }).catch(() => toast('Copy failed'));
      });
    });
    body.querySelectorAll('.shared-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        showModal('del-share-modal');
        const ok     = document.getElementById('del-share-ok');
        const cancel = document.getElementById('del-share-cancel');
        const cleanup = () => { ok.replaceWith(ok.cloneNode(true)); cancel.replaceWith(cancel.cloneNode(true)); };
        document.getElementById('del-share-ok').addEventListener('click', async () => {
          hideModal('del-share-modal'); cleanup();
          try {
            await api('DELETE', `api/v1/share/${id}`);
            viewSharedLinks();
          } catch(e) { toast('Delete failed'); }
        }, { once: true });
        document.getElementById('del-share-cancel').addEventListener('click', () => {
          hideModal('del-share-modal'); cleanup();
        }, { once: true });
      });
    });
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewRecent() {
  setTitle('Recently Added'); setBack(null); setNavActive('recent'); S.view = 'recent';
  const sig = _navCancel();
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/recent/added', {
      limit: 200,
      ...(abEx.ignoreVPaths.length ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    }, sig);
    showSongs(d.map(norm));
  } catch(e) { if (e.name === 'AbortError') return; setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewArtists() {
  setTitle('Artists'); setBack(null); setNavActive('artists'); S.view = 'artists';
  const sig = _navCancel();
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/artists', {
      ...(abEx.ignoreVPaths.length ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    }, sig);
    const rawArtists = d.artists || [];
    if (!rawArtists.length) { setBody('<div class="empty-state">No artists found</div>'); return; }
    S.curSongs = [];
    document.getElementById('play-all-btn').onclick = null;
    document.getElementById('add-all-btn').onclick  = null;

    // Group raw artist name variants by normalized key
    const groupMap = new Map();
    for (const a of rawArtists) {
      const key = normalizeArtist(a);
      const clean = cleanArtistDisplay(a);
      if (!groupMap.has(key)) {
        groupMap.set(key, { display: a, cleanDisplay: clean, variants: [a] });
      } else {
        const g = groupMap.get(key);
        g.variants.push(a);
        // Prefer a clean display that starts with a real letter
        if (!/^[a-zA-Z]/i.test(g.cleanDisplay) && /^[a-zA-Z]/i.test(clean)) {
          g.display = a;
          g.cleanDisplay = clean;
        }
      }
    }
    const groups = [...groupMap.values()];

    // Determine which A-Z / # buckets are populated using the CLEAN name
    const letterOf = g => {
      const ch = g.cleanDisplay.charAt(0).toUpperCase();
      return /[A-Z]/.test(ch) ? ch : '#';
    };
    const AZ_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
    const hasLetter = new Set(groups.map(letterOf));

    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div class="fe-filter-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="lib-filter" class="fe-filter-input" type="text" placeholder="Search artists…" autocomplete="off">
        <span id="lib-match-count" class="fe-match-count"></span>
        <button id="lib-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
      </div>
      <div class="az-strip" id="az-strip">${
        AZ_KEYS.map(l => `<button class="az-btn" data-letter="${l}"${hasLetter.has(l) ? '' : ' disabled'}>${l}</button>`).join('')
      }</div>
      <div class="artist-list">${
        groups.map((g, i) => {
          const letter = letterOf(g);
          const av = g.cleanDisplay.charAt(0).toUpperCase() || '?';
          return `<div class="artist-row" data-gi="${i}" data-letter="${letter}">
            <div class="artist-av">${esc(av)}</div>
            <div class="artist-name">${esc(g.cleanDisplay)}${g.variants.length > 1 ? `<span class="artist-var"> +${g.variants.length - 1}</span>` : ''}</div>
          </div>`;
        }).join('')
      }</div>`;

    const filterInput = body.querySelector('#lib-filter');
    const filterClear = body.querySelector('#lib-filter-clear');
    const matchCount  = body.querySelector('#lib-match-count');
    const azStrip     = body.querySelector('#az-strip');
    const allRows     = Array.from(body.querySelectorAll('.artist-row'));
    const rowNames    = groups.map(g => g.cleanDisplay.toLowerCase());

    function setActiveAZ(letter) {
      body.querySelectorAll('.az-btn').forEach(b => b.classList.toggle('active', b.dataset.letter === letter));
    }
    function applyFilter() {
      const q = filterInput.value.trim().toLowerCase();
      filterClear.classList.toggle('hidden', !q);
      azStrip.classList.toggle('az-hidden', !!q); // hide A-Z when typing
      if (q) { _activeLetter = null; setActiveAZ(null); }
      let visible = 0;
      allRows.forEach((row, i) => {
        const matches = !q || rowNames[i].includes(q);
        row.classList.toggle('fe-hidden', !matches);
        if (matches) visible++;
      });
      matchCount.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
    }

    // A-Z strip click: filter list to only artists starting with that letter
    // Clicking the active letter again clears the filter and shows all
    let _activeLetter = null;
    body.querySelectorAll('.az-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterInput.value = '';
        const letter = btn.dataset.letter;
        if (_activeLetter === letter) {
          // toggle off → show all
          _activeLetter = null;
          setActiveAZ(null);
          allRows.forEach(r => r.classList.remove('fe-hidden'));
          matchCount.textContent = '';
          azStrip.classList.remove('az-hidden');
          return;
        }
        _activeLetter = letter;
        setActiveAZ(letter);
        let visible = 0;
        allRows.forEach(row => {
          const matches = row.dataset.letter === letter;
          row.classList.toggle('fe-hidden', !matches);
          if (matches) visible++;
        });
        matchCount.textContent = `${visible} artist${visible !== 1 ? 's' : ''}`;
        // Scroll content-body back to top so results are visible
        body.scrollTop = 0;
      });
    });

    let _artTimer;
    filterInput.addEventListener('input', () => { clearTimeout(_artTimer); _artTimer = setTimeout(applyFilter, 150); });
    filterClear.addEventListener('click', () => { clearTimeout(_artTimer); _activeLetter = null; filterInput.value = ''; filterInput.focus(); applyFilter(); });
    allRows.forEach(row => {
      const g = groups[parseInt(row.dataset.gi)];
      if (g) row.addEventListener('click', () => viewArtistAlbums(g.display, g.variants));
    });
  } catch(e) { if (e.name === 'AbortError') return; setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewArtistAlbums(displayName, variantsOrBackFn, backFn) {
  // Overloaded: (name, variants[], backFn?) from artist list
  //             (name, backFn?)         from search / legacy callers
  let variants, back;
  if (Array.isArray(variantsOrBackFn)) {
    variants = variantsOrBackFn;
    back = backFn;
  } else {
    variants = [displayName];
    back = variantsOrBackFn;
  }
  setTitle(displayName); setBack(back || (() => viewArtists()));
  const sig = _navCancel();
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/artists-albums-multi', {
      artists: variants,
      ...(abEx.ignoreVPaths?.length                ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes?.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    }, sig);
    renderAlbumGrid(d.albums || [], displayName, variants);
  } catch(e) { if (e.name === 'AbortError') return; setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── ALBUM LIBRARY (Albums New) ────────────────────────────────────────────────
// A filesystem-based browsable album grid backed by /api/v1/albums/browse.

let _albLib = null;   // { albums: [], series: [], byId: {}, bySeriesId: {} }

function _albArtUrl(artFile, aaFile) {
  if (aaFile) return artUrl(aaFile, 's');
  if (artFile) return `/api/v1/albums/art-file?p=${encodeURIComponent(artFile)}&token=${S.token}`;
  return null;
}

function _albSongObj(track, album, discLabel, discIndex) {
  return {
    filepath    : track.filepath,
    title       : track.title   || null,
    artist      : track.artist  || album.artist || null,
    album       : album.displayName || null,
    year        : album.year    || null,
    track       : track.number  || null,
    disk        : discIndex     || null,
    'album-art' : track.aaFile  || null,
    hash        : null,
    rating      : null,
    genre       : null,
    replaygain  : null,
    _discLabel  : discLabel     || null,
  };
}

async function _loadAlbLib() {
  if (_albLib) return;
  const d = await api('GET', 'api/v1/albums/browse');
  const byId = {};
  const bySeriesId = {};
  for (const a of (d.albums || [])) {
    byId[a.id] = a;
    if (a.seriesId) {
      if (!bySeriesId[a.seriesId]) bySeriesId[a.seriesId] = [];
      bySeriesId[a.seriesId].push(a);
    }
  }
  _albLib = { albums: d.albums || [], series: d.series || [], byId, bySeriesId, error: d.error || null };
}

async function viewAlbumLibrary() {
  _albLib = null;  // always re-fetch on entry so config changes / server restarts are reflected
  setTitle('Albums'); setBack(null); setNavActive('album-library'); S.view = 'album-library';
  setBody('<div class="loading-state"></div>');
  try {
    await _loadAlbLib();
    const { albums, series } = _albLib;

    if (!albums.length && !series.length) {
      const msg = _albLib.error || 'No albums found.';
      document.getElementById('content-body').innerHTML =
        `<div class="empty-state" style="flex-direction:column;height:auto;padding:3em 1em;text-align:center;"><p>${esc(msg)}</p><p style="margin-top:.5em;font-size:.85em;opacity:.65;">Enable <strong>Albums Only</strong> on at least one folder in Admin \u2192 Directories to use the Album Library.</p></div>`;
      return;
    }

    // Collect top-level items: series cards + albums not belonging to a series
    const seriesIds     = new Set(series.map(s => s.id));
    const standaloneAlb = albums.filter(a => !a.seriesId);

    // Build combined list: series first (sorted), then standalone
    const seriesSorted     = [...series].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
    const standaloneSorted = [...standaloneAlb].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));

    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div class="fe-filter-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="allib-filter" class="fe-filter-input" type="text" placeholder="Search albums or series…" autocomplete="off">
        <span id="allib-count" class="fe-match-count"></span>
        <button id="allib-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
      </div>
      <div id="allib-grid" class="album-grid"></div>`;

    const filterInput = body.querySelector('#allib-filter');
    const filterClear = body.querySelector('#allib-clear');
    const countEl     = body.querySelector('#allib-count');
    const grid        = body.querySelector('#allib-grid');

    // Build card HTML for a series
    function seriesCard(s) {
      const art = _albArtUrl(s.artFile, s.aaFile);
      const count = (s.albumIds || []).length;
      return `<div class="album-card album-card--series" data-series-id="${esc(s.id)}">
        <div class="album-art" style="position:relative;">
          ${art ? `<img src="${esc(art)}" alt="${esc(s.displayName)}" loading="lazy" onerror="this.style.display='none'">` : noArtHtml()}
          <div class="alb-badges"><span class="alb-badge">${count} albums</span></div>
          <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div class="album-meta">
          <div class="album-name">${esc(s.displayName)}</div>
          <div class="album-year">&nbsp;</div>
        </div>
      </div>`;
    }

    // Build card HTML for a standalone album
    function albumCard(a) {
      const art = _albArtUrl(a.artFile, a.aaFile);
      const totalTracks = (a.discs || []).reduce((n, d) => n + d.tracks.length, 0);
      const multiDisc   = (a.discs || []).length > 1;
      return `<div class="album-card" data-album-id="${esc(a.id)}">
        <div class="album-art" style="position:relative;">
          ${art ? `<img src="${esc(art)}" alt="${esc(a.displayName)}" loading="lazy" onerror="this.style.display='none'">` : noArtHtml()}
          <div class="alb-badges">${multiDisc ? `<span class="alb-badge alb-badge--disc">${a.discs.length} discs</span>` : ''}</div>
          <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div class="album-meta">
          <div class="album-name">${esc(a.displayName)}</div>
          <div class="album-year">${a.year || '&nbsp;'}</div>
        </div>
      </div>`;
    }

    function render(filter) {
      const lc = (filter || '').toLowerCase().trim();
      let html = '';
      let count = 0;

      for (const s of seriesSorted) {
        if (lc && !s.displayName.toLowerCase().includes(lc)) continue;
        html += seriesCard(s);
        count++;
      }
      for (const a of standaloneSorted) {
        if (lc && !a.displayName.toLowerCase().includes(lc) && !(a.artist||'').toLowerCase().includes(lc)) continue;
        html += albumCard(a);
        count++;
      }
      grid.innerHTML = html || '<div class="empty-state">No albums found</div>';
      countEl.textContent = lc ? `${count} result${count !== 1 ? 's' : ''}` : '';
    }

    render('');

    // Filter input
    filterInput.addEventListener('input', () => {
      filterClear.classList.toggle('hidden', !filterInput.value);
      render(filterInput.value);
    });
    filterClear.addEventListener('click', () => {
      filterInput.value = '';
      filterClear.classList.add('hidden');
      render('');
    });

    // Click: series → drill-down; album → detail
    grid.addEventListener('click', e => {
      const seriesCard = e.target.closest('[data-series-id]');
      const albumCard  = e.target.closest('[data-album-id]');
      if (seriesCard) viewAlbumSeries(seriesCard.dataset.seriesId);
      else if (albumCard) viewAlbumDetail(albumCard.dataset.albumId, 0);
    });

  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewAlbumSeries(seriesId) {
  setTitle('…'); setBack(viewAlbumLibrary); setNavActive('album-library'); S.view = 'album-library';
  setBody('<div class="loading-state"></div>');
  try {
    await _loadAlbLib();
    const series   = _albLib.series.find(s => s.id === seriesId);
    if (!series) { setBody('<div class="empty-state">Series not found</div>'); return; }
    const albums   = (_albLib.bySeriesId[seriesId] || [])
      .slice().sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));

    setTitle(series.displayName);

    const body = document.getElementById('content-body');
    body.innerHTML = `<div id="allib-grid" class="album-grid"></div>`;
    const grid = body.querySelector('#allib-grid');

    grid.innerHTML = albums.map(a => {
      const art = _albArtUrl(a.artFile, a.aaFile);
      const multiDisc = (a.discs || []).length > 1;
      return `<div class="album-card" data-album-id="${esc(a.id)}">
        <div class="album-art" style="position:relative;">
          ${art ? `<img src="${esc(art)}" alt="${esc(a.displayName)}" loading="lazy" onerror="this.style.display='none'">` : noArtHtml()}
          <div class="alb-badges">${multiDisc ? `<span class="alb-badge alb-badge--disc">${a.discs.length} discs</span>` : ''}</div>
          <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div class="album-meta">
          <div class="album-name">${esc(a.displayName)}</div>
          <div class="album-year">${a.year || '&nbsp;'}</div>
        </div>
      </div>`;
    }).join('') || '<div class="empty-state">No albums in series</div>';

    grid.addEventListener('click', e => {
      const card = e.target.closest('[data-album-id]');
      if (card) viewAlbumDetail(card.dataset.albumId, 0);
    });

  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewAlbumDetail(albumId, activeDiscIdx) {
  setTitle('…'); setBack(null); setNavActive('album-library'); S.view = 'album-library';
  setBody('<div class="loading-state"></div>');
  try {
    await _loadAlbLib();
    const album = _albLib.byId[albumId];
    if (!album) { setBody('<div class="empty-state">Album not found</div>'); return; }

    setTitle(album.displayName);

    // Back: if belongs to a series → that series, else library
    const backFn = album.seriesId
      ? () => viewAlbumSeries(album.seriesId)
      : viewAlbumLibrary;
    setBack(backFn);

    const discs      = album.discs || [];
    const discIdx    = Math.max(0, Math.min(activeDiscIdx, discs.length - 1));
    const multiDisc  = discs.length > 1;
    const art        = _albArtUrl(album.artFile, album.aaFile);

    // Gather all tracks across all discs (for Play All)
    const discLabel  = disc => multiDisc ? (disc.label || ('Disc ' + disc.discIndex)) : null;
    const allSongs   = discs.flatMap(disc => disc.tracks.map(t => _albSongObj(t, album, discLabel(disc), disc.discIndex)));
    const discSongs  = discs[discIdx] ? discs[discIdx].tracks.map(t => _albSongObj(t, album, discLabel(discs[discIdx]), discs[discIdx].discIndex)) : [];

    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div class="alb-detail-header">
        ${art
          ? `<img class="alb-detail-art" src="${esc(art)}" alt="${esc(album.displayName)}" onerror="this.style.display='none'">`
          : `<div class="alb-detail-art" style="display:flex;align-items:center;justify-content:center;">${noArtHtml()}</div>`}
        <div style="min-width:0;flex:1;">
          <div class="alb-detail-title">${esc(album.displayName)}</div>
          <div class="alb-detail-sub">${album.artist ? esc(album.artist) + (album.year ? ' · ' + album.year : '') : (album.year || '')}</div>
          <div class="alb-detail-actions">
            <button id="albd-play-all" class="primary-btn">▶ Play All</button>
            <button id="albd-add-all" class="secondary-btn">+ Add to Queue</button>
          </div>
        </div>
      </div>
      ${multiDisc ? `
      <div class="disc-tabs" id="albd-disc-tabs" style="display:flex;gap:6px;padding:16px 0 8px;flex-wrap:wrap;">
        ${discs.map((d, i) => `<button class="disc-tab-btn${i === discIdx ? ' active' : ''}" data-disc="${i}">${esc(d.label || ('Disc ' + (i+1)))}</button>`).join('')}
      </div>` : ''}
      <div class="alb-play-hint">Clicking a track loads the full album into the queue and starts from that track${multiDisc ? ' — all discs are included' : ''}.</div>
      <div id="albd-tracklist" class="song-list"></div>`;

    // Render track list
    function renderTracks(dIdx) {
      const disc = discs[dIdx];
      if (!disc) return;
      const tl = body.querySelector('#albd-tracklist');
      tl.innerHTML = disc.tracks.length === 0
        ? '<div class="empty-state">No tracks found</div>'
        : disc.tracks.map((t, ti) => {
            const dur = t.duration ? fmt(t.duration) : '';
            return `<div class="alb-track-row" data-ti="${ti}" data-disc="${dIdx}">
              <span class="alb-track-num">${t.number || (ti + 1)}</span>
              <span class="alb-track-title">${esc(t.title || '?')}</span>
              ${t.artist && t.artist !== album.artist ? `<span class="alb-track-artist">${esc(t.artist)}</span>` : '<span></span>'}
              <span class="alb-track-dur">${dur}</span>
            </div>`;
          }).join('');
    }
    renderTracks(discIdx);

    // Play All
    body.querySelector('#albd-play-all').onclick = () => {
      if (!allSongs.length) return;
      Player.setQueue(allSongs, 0);
    };
    // Add All
    body.querySelector('#albd-add-all').onclick = () => {
      Player.addAll(allSongs);
    };

    // Disc tabs
    if (multiDisc) {
      body.querySelector('#albd-disc-tabs').addEventListener('click', e => {
        const btn = e.target.closest('.disc-tab-btn');
        if (!btn) return;
        const dIdx = parseInt(btn.dataset.disc, 10);
        body.querySelectorAll('.disc-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.disc == dIdx));
        renderTracks(dIdx);
      });
    }

    // Click row to play from that track
    body.querySelector('#albd-tracklist').addEventListener('click', e => {
      const row = e.target.closest('.alb-track-row');
      if (!row) return;
      const dIdx  = parseInt(row.dataset.disc, 10);
      const ti    = parseInt(row.dataset.ti,   10);
      const disc  = discs[dIdx];
      if (!disc) return;
      // Queue whole album from this track
      const songs = allSongs;
      // Find global index of this track
      let globalIdx = 0;
      for (let d = 0; d < dIdx; d++) globalIdx += discs[d].tracks.length;
      globalIdx += ti;
      Player.setQueue(songs, globalIdx);
    });

  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── END ALBUM LIBRARY ─────────────────────────────────────────────────────────

function renderAlbumGrid(albums, defaultArtist, artistVariants) {
  if (!albums.length) { setBody('<div class="empty-state">No albums found</div>'); return; }
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  const body = document.getElementById('content-body');

  // Pre-compute clean names for display / filtering / A-Z
  const albumsClean = albums.map(a => ({
    ...a,
    cleanName: a.name ? cleanArtistDisplay(a.name) : 'Singles',
  }));

  const letterOfAlbum = a => {
    const ch = a.cleanName.charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  };
  const AZ_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
  const hasLetter = new Set(albumsClean.map(letterOfAlbum));

  body.innerHTML = `
    <div class="fe-filter-row">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="lib-filter" class="fe-filter-input" type="text" placeholder="Search albums…" autocomplete="off">
      <span id="lib-match-count" class="fe-match-count"></span>
      <button id="lib-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
    </div>
    <div class="az-strip" id="az-strip">${
      AZ_KEYS.map(l => `<button class="az-btn" data-letter="${l}"${hasLetter.has(l) ? '' : ' disabled'}>${l}</button>`).join('')
    }</div>
    <div class="album-grid"></div>`;
  const filterInput = body.querySelector('#lib-filter');
  const filterClear = body.querySelector('#lib-filter-clear');
  const matchCount  = body.querySelector('#lib-match-count');
  const azStrip     = body.querySelector('#az-strip');
  const grid        = body.querySelector('.album-grid');

  // Lightweight data — no HTML pre-built; keeps memory lean for large libraries
  const cardData = albumsClean.map((a, i) => ({
    lc:     (a.cleanName || '').toLowerCase(),
    letter: letterOfAlbum(a),
    idx:    i,
  }));

  // Build HTML for a single card on demand
  function buildCard(i) {
    const a   = albumsClean[i];
    const name = a.cleanName;
    const art  = artUrl(a.album_art_file, 's');
    return `<div class="album-card" data-i="${i}">
      <div class="album-art">
        ${art
          ? `<img src="${art}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="no-art no-art-album"><div class="no-art-wave"><span></span><span></span><span></span><span></span><span></span></div><span class="no-art-label">no artwork</span></div>`}
        <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>
      <div class="album-meta">
        <div class="album-name">${esc(name)}</div>
        ${a.year ? `<div class="album-year">${a.year}</div>` : '<div class="album-year">&nbsp;</div>'}
      </div>
    </div>`;
  }

  // ── Virtual scroll ───────────────────────────────────────────
  // Only cards within the visible viewport + BUFS buffer rows are in the DOM.
  // Padding on the grid fakes the height of off-screen rows so the scrollbar
  // and scrollTop behave exactly as if every card were rendered.
  //
  //  paddingTop    = fRow * (rowH + GAP)
  //  paddingBottom = (numRows - lRow - 1) * (rowH + GAP)
  //
  const GAP  = 20;   // matches .album-grid gap: 20px
  const BUFS = 3;    // buffer rows above + below viewport
  let cols = 0, rowH = 0;
  let vData = cardData;          // current active data slice (full / filtered / AZ)
  let curFRow = -1, curLRow = -1;

  // Measure one probe card to get real column count and row height
  function measure() {
    const gw = grid.clientWidth;
    if (!gw) return false;
    const probe = document.createElement('div');
    probe.className = 'album-card';
    probe.style.cssText = 'visibility:hidden;pointer-events:none;position:relative;';
    probe.innerHTML = '<div class="album-art" style="aspect-ratio:1"></div>'
                    + '<div class="album-meta"><div class="album-name">X</div>'
                    + '<div class="album-year">&nbsp;</div></div>';
    grid.appendChild(probe);
    const pw = probe.offsetWidth;
    rowH = probe.offsetHeight;
    grid.removeChild(probe);
    cols = pw > 0 ? Math.max(1, Math.round((gw + GAP) / (pw + GAP))) : 1;
    return rowH > 0;
  }

  function renderWindow(force) {
    if (!cols || !rowH) { if (!measure()) return; }
    const nRows  = Math.ceil(vData.length / cols);
    const sTop   = body.scrollTop;
    const vH     = body.clientHeight;
    const fRow   = Math.max(0, Math.floor(sTop / (rowH + GAP)) - BUFS);
    const lRow   = Math.min(nRows - 1, Math.ceil((sTop + vH) / (rowH + GAP)) + BUFS);

    if (!force && fRow === curFRow && lRow === curLRow) return;
    curFRow = fRow; curLRow = lRow;

    grid.style.paddingTop    = `${fRow * (rowH + GAP)}px`;
    grid.style.paddingBottom = `${Math.max(0, nRows - lRow - 1) * (rowH + GAP)}px`;

    const fIdx = fRow * cols;
    const lIdx = Math.min(vData.length - 1, (lRow + 1) * cols - 1);
    const html = [];
    for (let i = fIdx; i <= lIdx; i++) html.push(buildCard(vData[i].idx));
    grid.innerHTML = html.join('');
  }

  // Scroll: render on every scroll tick (cheap — only string-builds ~40 cards)
  let _rafPending = false;
  body.addEventListener('scroll', () => {
    if (_rafPending || !grid.isConnected) return;
    _rafPending = true;
    requestAnimationFrame(() => { _rafPending = false; if (grid.isConnected) renderWindow(false); });
  });

  // Resize: re-measure column count + row height when the grid width changes
  let _roFrame = false;
  const ro = new ResizeObserver(() => {
    if (_roFrame || !grid.isConnected) return;
    _roFrame = true;
    requestAnimationFrame(() => {
      _roFrame = false;
      if (!grid.isConnected) { ro.disconnect(); return; }
      if (measure()) { curFRow = -1; curLRow = -1; renderWindow(true); }
    });
  });
  ro.observe(grid);

  // Delegated click — works regardless of which cards are in the DOM
  grid.addEventListener('click', e => {
    const card = e.target.closest('.album-card');
    if (!card) return;
    const album = albums[parseInt(card.dataset.i)];
    if (!album) return;
    const backFn = defaultArtist
      ? () => viewArtistAlbums(defaultArtist, artistVariants || [defaultArtist])
      : () => viewAlbumLibrary();
    viewAlbumSongs(album.name, album._rawArtist || defaultArtist, backFn, { skipAOFilter: true });
  });

  // Switch the active data set + reset scroll + redraw
  function setVData(data, label) {
    vData = data;
    curFRow = -1; curLRow = -1;
    grid.style.paddingTop = '0';
    grid.style.paddingBottom = '0';
    body.scrollTop = 0;
    matchCount.textContent = label || '';
    renderWindow(true);
  }

  let _albTimer, _activeLetter = null;
  function setActiveAZ(letter) {
    body.querySelectorAll('.az-btn').forEach(b => b.classList.toggle('active', b.dataset.letter === letter));
  }

  // A-Z strip
  body.querySelectorAll('.az-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterInput.value = '';
      azStrip.classList.remove('az-hidden');
      filterClear.classList.add('hidden');
      const letter = btn.dataset.letter;
      if (_activeLetter === letter) {
        _activeLetter = null;
        setActiveAZ(null);
        setVData(cardData, '');
        return;
      }
      _activeLetter = letter;
      setActiveAZ(letter);
      const subset = cardData.filter(c => c.letter === letter);
      setVData(subset, `${subset.length} album${subset.length !== 1 ? 's' : ''}`);
    });
  });

  filterInput.addEventListener('input', () => {
    clearTimeout(_albTimer);
    _albTimer = setTimeout(() => {
      const q = filterInput.value.trim().toLowerCase();
      _activeLetter = null;
      setActiveAZ(null);
      azStrip.classList.toggle('az-hidden', !!q);
      if (q) {
        const subset = cardData.filter(c => c.lc.includes(q));
        filterClear.classList.remove('hidden');
        setVData(subset, `${subset.length} result${subset.length !== 1 ? 's' : ''}`);
      } else {
        filterClear.classList.add('hidden');
        setVData(cardData, '');
      }
    }, 150);
  });

  filterClear.addEventListener('click', () => {
    clearTimeout(_albTimer);
    _activeLetter = null;
    setActiveAZ(null);
    filterInput.value = '';
    filterInput.focus();
    azStrip.classList.remove('az-hidden');
    filterClear.classList.add('hidden');
    setVData(cardData, '');
  });

  // Initial render — defer one frame so the grid has layout dimensions
  requestAnimationFrame(() => { if (grid.isConnected) renderWindow(true); });
}

async function viewAlbumSongs(albumName, artist, backFn, opts = {}) {
  setTitle(albumName || 'Singles');
  setBack(backFn || null);
  const sig = _navCancel();
  setBody('<div class="loading-state"></div>');
  try {
    const body = { album: albumName };
    if (artist) body.artist = artist;
    // skipAOFilter: when called from search, don't restrict to albumsOnly paths —
    // the search found the album across all vpaths, so the song view should match.
    if (!opts.skipAOFilter) {
      const aoF = _albumsOnlyFilter();
      if (aoF.ignoreVPaths?.length)             body.ignoreVPaths             = aoF.ignoreVPaths;
      if (aoF.includeFilepathPrefixes?.length)  body.includeFilepathPrefixes  = aoF.includeFilepathPrefixes;
    }
    const d = await api('POST', 'api/v1/db/album-songs', body, sig);
    showSongs(d.map(norm), null, albumName || 'album');
  } catch(e) { if (e.name === 'AbortError') return; setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function viewSearch() {
  setTitle('Search'); setBack(null); setNavActive('search'); S.view = 'search';
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  // Initialise vpath selection — all on by default, preserved across navigations.
  if (!S.searchVpaths) S.searchVpaths = [...S.vpaths];
  const body = document.getElementById('content-body');
  const pillsHtml = S.vpaths.length > 1
    ? `<div class="search-vpath-pills" id="search-vpaths">${
        S.vpaths.map(v => `<button class="dj-vpath-pill${S.searchVpaths.includes(v) ? ' on' : ''}" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')
      }</div>`
    : '';
  body.innerHTML = `
    <div class="search-wrap">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t3);flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input class="search-input" id="search-input" type="text" placeholder="Search artists, albums, songs…" autocomplete="off">
    </div>
    ${pillsHtml}
    <div id="search-results"></div>`;
  const input = document.getElementById('search-input');
  // Vpath pill toggles — only wired when there are multiple vpaths.
  if (S.vpaths.length > 1) {
    let _vpathSearchTimer;
    document.getElementById('search-vpaths').addEventListener('click', e => {
      const pill = e.target.closest('.dj-vpath-pill');
      if (!pill) return;
      const v = pill.dataset.vpath;
      if (S.searchVpaths.includes(v)) {
        // Keep at least one selected.
        if (S.searchVpaths.length > 1) S.searchVpaths = S.searchVpaths.filter(x => x !== v);
      } else {
        S.searchVpaths = [...S.searchVpaths, v];
      }
      document.getElementById('search-vpaths').querySelectorAll('.dj-vpath-pill').forEach(p => {
        p.classList.toggle('on', S.searchVpaths.includes(p.dataset.vpath));
      });
      const q = input.value.trim();
      if (q && q.length >= 2) {
        // Debounce: rapid vpath toggles queue up multiple synchronous SQLite
        // searches on the server, blocking its event loop. Wait 300 ms so
        // fast toggling collapses into a single request.
        clearTimeout(_vpathSearchTimer);
        _vpathSearchTimer = setTimeout(() => doSearch(q), 300);
      }
    });
  }
  // Restore previous query if returning from a drill-down (artist → back).
  // Do NOT auto-focus in this case — keyboard would cover the results and the
  // first touch to dismiss it would be "eaten", making the screen feel frozen.
  if (S.lastSearch) {
    input.value = S.lastSearch;
    doSearch(S.lastSearch);
  } else {
    // Fresh search view: open keyboard so the user can start typing immediately.
    input.focus();
  }
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    S.lastSearch = q;
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    // 600 ms debounce — touch keyboards deliver characters slowly; 320 ms fired
    // a new API call for almost every character typed on CleverTouch.
    // Also require at least 2 chars so single-letter noise doesn't hit the server.
    if (q.length < 2) return;
    timer = setTimeout(() => doSearch(q), 600);
  });
}

// AbortController for in-flight search requests — cancelled at network level
// the moment a newer search starts, preventing stale responses from consuming
// CPU on slow devices (CleverTouch) after results are no longer needed.
let _searchAbort = null;
let _searchGen = 0;
async function doSearch(q) {
  // Cancel any in-flight request immediately at network level
  if (_searchAbort) { _searchAbort.abort(); }
  _searchAbort = new AbortController();
  const { signal } = _searchAbort;
  const res = document.getElementById('search-results');
  if (!res) return;
  const gen = ++_searchGen;
  res.innerHTML = '<div class="loading-state"></div>';
  try {
    const meta = S.vpathMeta || {};
    const selectedVpaths = (S.searchVpaths && S.searchVpaths.length > 0) ? S.searchVpaths : S.vpaths;

    // Child-vpath optimisation: same logic as AutoDJ.
    // If the selected vpaths are all children of the same parent, use filepathPrefix
    // to filter within that parent's DB vpath instead of ignoreVPaths.
    const allChildSameParent =
      selectedVpaths.length > 0 &&
      selectedVpaths.every(v => meta[v]?.parentVpath) &&
      new Set(selectedVpaths.map(v => meta[v].parentVpath)).size === 1;

    let ignoreVPaths, filepathPrefix;
    if (allChildSameParent) {
      const parentVpath = meta[selectedVpaths[0]].parentVpath;
      ignoreVPaths = S.vpaths.filter(v => v !== parentVpath && !meta[v]?.parentVpath);
      filepathPrefix = selectedVpaths.length === 1 ? meta[selectedVpaths[0]].filepathPrefix : null;
    } else {
      ignoreVPaths = S.vpaths.filter(v => !selectedVpaths.includes(v));
      filepathPrefix = null;
    }

    const abEx = _audioBookExclusions();
    const finalIgnoreVPaths = abEx.ignoreVPaths.length
      ? [...new Set([...(ignoreVPaths || []), ...abEx.ignoreVPaths])]
      : ignoreVPaths;

    const d = await api('POST', 'api/v1/db/search', {
      search: q,
      ...(finalIgnoreVPaths && finalIgnoreVPaths.length > 0 ? { ignoreVPaths: finalIgnoreVPaths } : {}),
      ...(filepathPrefix ? { filepathPrefix } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    }, signal);
    // A newer search has already taken over — discard this stale response.
    if (gen !== _searchGen) return;
    let html = '';

    if (d.folders?.length) {
      html += `<div class="search-section"><h3>Folders (${d.folders.length})</h3><div class="artist-list">${
        d.folders.map(f => `<div class="artist-row" data-browse-path="${esc(f.browse_path)}">
          <div class="artist-av">📁</div>
          <div class="artist-name">${esc(f.folder_name)}</div>
        </div>`).join('')
      }</div></div>`;
    }
    if (d.artists?.length) {
      html += `<div class="search-section"><h3>Artists (${d.artists.length})</h3><div class="artist-list">${
        d.artists.map(a => `<div class="artist-row" data-artist-disp="${esc(a.name)}" data-artist-variants="${esc(JSON.stringify(a.variants))}">
          <div class="artist-av">${esc(a.name.charAt(0)).toUpperCase()}</div>
          <div class="artist-name">${esc(a.name)}</div>
        </div>`).join('')
      }</div></div>`;
    }
    if (d.albums?.length) {
      html += `<div class="search-section"><h3>Albums (${d.albums.length})</h3><div class="artist-list">${
        d.albums.map(a => {
          const au = artUrl(a.album_art_file, 's');
          return `<div class="artist-row" data-album="${esc(a.name)}">
            <div class="artist-av" style="border-radius:6px;overflow:hidden">
              ${au ? `<img src="${au}" style="width:38px;height:38px;object-fit:cover" loading="lazy" onerror="this.parentNode.innerHTML='♪'">` : '♪'}
            </div>
            <div class="artist-name">${esc(a.name)}</div>
          </div>`;
        }).join('')
      }</div></div>`;
    }
    // Songs matched by ID3 title
    const seenPaths = new Set();
    const titleSongs = (d.title || []).map(t => {
      seenPaths.add(t.filepath);
      return {
        title:      t.name.includes(' - ') ? t.name.split(' - ').slice(1).join(' - ') : t.name,
        artist:     t.name.includes(' - ') ? t.name.split(' - ')[0] : '',
        filepath:   t.filepath,
        'album-art': t.album_art_file || null,
      };
    });
    // Songs matched only by filename (no ID3 title hit) — deduplicate against above
    const fileSongs = (d.files || [])
      .filter(f => !seenPaths.has(f.filepath))
      .map(f => ({
        title:      f.filepath.split('/').pop().replace(/\.[^.]+$/, ''),
        artist:     '',
        filepath:   f.filepath,
        'album-art': f.album_art_file || null,
      }));
    const allSongs = [...titleSongs, ...fileSongs];
    // Cap at 50 songs — rendering 500+ rows at once causes OOM on CleverTouch.
    // If there are more, we show a hint to refine the search.
    const displaySongs = allSongs.slice(0, 50);
    const overflow = allSongs.length - displaySongs.length;
    if (displaySongs.length) {
      const overflowNote = overflow > 0
        ? `<div class="search-overflow-note">Showing 50 of ${allSongs.length} — refine your search to see more</div>`
        : '';
      // Text-only rows for search: no album-art <img> tags.
      // On CleverTouch, each img triggers a network fetch + decode + layout
      // reflow. 50 images saturates the CPU and stalls music playback.
      html += `<div class="search-section"><h3>Songs (${allSongs.length})</h3><div class="song-list">${renderSearchRows(displaySongs)}</div>${overflowNote}</div>`;
    }
    if (!html) html = `<div class="empty-state">No results for "${esc(q)}"</div>`;

    // Pause VU/spectrum RAF loop while we do the heavy innerHTML write.
    // On CleverTouch the 60 fps canvas loop competes with DOM parsing and
    // causes the 10-30 s freeze. We restart it immediately after.
    const wasPlaying = !audioEl.paused;
    if (wasPlaying) VU_NEEDLE.stop();
    res.innerHTML = html;
    if (wasPlaying) VU_NEEDLE.start();

    res.querySelectorAll('.artist-row[data-artist-disp]').forEach(r => {
      let vars; try { vars = JSON.parse(r.dataset.artistVariants); } catch { vars = [r.dataset.artistDisp]; }
      r.addEventListener('click', () => viewArtistAlbums(r.dataset.artistDisp, vars, () => viewSearch()));
    });
    res.querySelectorAll('.artist-row[data-browse-path]').forEach(r => r.addEventListener('click', () => {
      S.feSearchReturn = () => viewSearch();
      S.feDirStack = []; // start fresh stack so back goes to search, not a stale dir
      viewFiles(r.dataset.browsePath, false);
    }));
    res.querySelectorAll('.artist-row[data-album]').forEach(r => r.addEventListener('click', () => viewAlbumSongs(r.dataset.album, null, () => viewSearch(), { skipAOFilter: true })));
    attachSongListEvents(res, displaySongs);
    S.curSongs = displaySongs;
  } catch(e) {
    if (e.name === 'AbortError' || gen !== _searchGen) return; // cancelled — ignore silently
    res.innerHTML = `<div class="empty-state">Search failed: ${esc(e.message)}</div>`;
  }
}

async function viewRated() {
  setTitle('Starred'); setBack(null); setNavActive('rated'); S.view = 'rated';
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/rated', {
      ...(abEx.ignoreVPaths.length ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    });
    if (!d.length) { setBody('<div class="empty-state">No starred songs yet. Rate songs with ★</div>'); return; }
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewMostPlayed() {
  setTitle('Most Played'); setBack(null); setNavActive('most-played'); S.view = 'most-played';
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/stats/most-played', {
      limit: 100,
      ...(abEx.ignoreVPaths.length ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    });
    if (!d.length) { setBody('<div class="empty-state">No play history yet</div>'); return; }
    showMostPlayed(d.map(s => { const n = norm(s); n._playCount = s.metadata?.['play-count']; return n; }));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewPlayed() {
  setTitle('Recently Played'); setBack(null); setNavActive('played'); S.view = 'played';
  setBody('<div class="loading-state"></div>');
  try {
    const abEx = _audioBookExclusions();
    const d = await api('POST', 'api/v1/db/stats/recently-played', {
      limit: 100,
      ...(abEx.ignoreVPaths.length ? { ignoreVPaths: abEx.ignoreVPaths } : {}),
      ...(abEx.excludeFilepathPrefixes.length ? { excludeFilepathPrefixes: abEx.excludeFilepathPrefixes } : {}),
    });
    if (!d.length) { setBody('<div class="empty-state">No play history yet</div>'); return; }
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── HOME ──────────────────────────────────────────────────────

async function viewHome() {
  setTitle('Home'); setBack(null); setNavActive('home'); S.view = 'home';
  // Abort any previous home-view body listeners to prevent accumulation
  _homeAC?.abort();
  _homeAC = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  setBody('<div class="loading-state"></div>');

  const sig = _navCancel();
  const abEx = _audioBookExclusions();
  // compute how many cards fit in one row at current container width
  const _cw    = (document.getElementById('content-body')?.clientWidth || 800) - 32;
  const _limit = Math.max(4, Math.floor((_cw + 10) / 130)); // 120px card + 10px gap
  const base = {
    limit: _limit,
    ...(abEx.ignoreVPaths.length             ? { ignoreVPaths:             abEx.ignoreVPaths }             : {}),
    ...(abEx.excludeFilepathPrefixes.length  ? { excludeFilepathPrefixes:  abEx.excludeFilepathPrefixes }  : {}),
  };

  let recentlyPlayed = [], mostPlayed = [], radioStations = [], podcastFeeds = [];
  try {
    [recentlyPlayed, mostPlayed, radioStations, podcastFeeds] = await Promise.all([
      api('POST', 'api/v1/db/stats/recently-played', base, sig).catch(() => []),
      api('POST', 'api/v1/db/stats/most-played',     base, sig).catch(() => []),
      api('GET',  'api/v1/radio/stations',       undefined, sig).catch(() => []),
      api('GET',  'api/v1/podcast/feeds',         undefined, sig).catch(() => []),
    ]);
  } catch(e) { if (e.name === 'AbortError') return; }

  if (S.view !== 'home') return;

  recentlyPlayed = recentlyPlayed.map(norm);
  mostPlayed     = mostPlayed.map(s => { const n = norm(s); n._playCount = s.metadata?.['play-count']; return n; });
  if (podcastFeeds.length) _podcastFeeds = podcastFeeds;

  // ── "Because you listened to" shelves (requires Last.fm API key) ────────────
  let becauseShelves = [];  // [{ artist: string, songs: norm[] }]
  if (S.lastfmHasApiKey && mostPlayed.length) {
    // Build pool of up to 10 most-played unique artists, then pick 2 at random
    // so the shelves rotate on each Home visit instead of always showing the same pair.
    const artistPool = [...new Set(mostPlayed.map(s => s.artist).filter(Boolean))].slice(0, 10);
    // Fisher-Yates shuffle the pool, then take first 2
    for (let i = artistPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [artistPool[i], artistPool[j]] = [artistPool[j], artistPool[i]];
    }
    const topArtists = artistPool.slice(0, 2);
    const becauseData = await Promise.all(topArtists.map(async artist => {
      try {
        const sim = await api('GET', `api/v1/lastfm/similar-artists?artist=${encodeURIComponent(artist)}`, undefined, sig).catch(() => ({ artists: [] }));
        if (!sim.artists?.length) return null;
        const songs = await api('POST', 'api/v1/db/songs-by-artists', { artists: sim.artists.slice(0, 15), limit: _limit }, sig).catch(() => []);
        if (!songs.length) return null;
        return { artist, songs: songs.map(norm) };
      } catch(_) { return null; }
    }));
    becauseShelves = becauseData.filter(Boolean);
  }
  if (S.view !== 'home') return;

  // ── helpers ─────────────────────────────────────────────────

  // Art card — radio & podcast: 88×88 image on top, name + sub below
  function artCard(imgUrl, title, sub, attrs) {
    const artInner = imgUrl
      ? `<img src="${imgUrl}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`
      : noArtHtml();
    return `<div class="hc" ${attrs || ''}>
      <div class="hc-art">${artInner}</div>
      <div class="hc-info">
        <div class="hc-title">${esc(title)}</div>
        ${sub ? `<div class="hc-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
  }

  // Song card — same art-on-top layout
  function songCard(s, showCount) {
    const url = artUrl(s['album-art'], 's');
    const artInner = url
      ? `<img src="${url}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`
      : noArtHtml();
    const sub = showCount && s._playCount
      ? `${esc(s.artist || '')}${s.artist ? ' · ' : ''}${s._playCount}×`
      : esc(s.artist || '');
    return `<div class="hc home-song" data-fp="${esc(s.filepath)}">
      <div class="hc-art">${artInner}</div>
      <div class="hc-info">
        <div class="hc-title">${esc(s.title || s.filepath.split('/').pop())}</div>
        ${sub ? `<div class="hc-sub">${sub}</div>` : ''}
      </div>
    </div>`;
  }

  // Folder & playlist art cards — deterministic color per name, art-card layout
  function folderCard(label, attrs) {
    // viewBox crops to the folder with ~8px margin each side.
    // Path redesigned so body height = 52 units vs width = 76 units (ratio 1.46:1)
    // instead of the old 39-tall (ratio 1.95:1) which looked squashed.
    const art = `<svg viewBox="4 24 92 68" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" style="fill:var(--surface)"/>
      <path d="M12 46 H34 L42 32 H84 Q88 32 88 37 V80 Q88 84 84 84 H16 Q12 84 12 80 Z"
            style="fill:var(--raised);stroke:var(--accent)" stroke-width="1.8" stroke-linejoin="round"/>
      <line x1="20" y1="52" x2="65" y2="52" style="stroke:var(--t3)" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
      <line x1="20" y1="61" x2="60" y2="61" style="stroke:var(--t3)" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
      <line x1="20" y1="70" x2="50" y2="70" style="stroke:var(--t3)" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
      <circle cx="74" cy="67" r="13" style="fill:var(--surface);stroke:var(--primary)" stroke-width="2.2"/>
      <polygon points="70,61 70,73 82,67" style="fill:var(--primary)"/>
    </svg>`;
    return `<div class="hc" ${attrs || ''}>
      <div class="hc-art">${art}</div>
      <div class="hc-info"><div class="hc-title">${esc(label)}</div></div>
    </div>`;
  }

  function playlistCard(label, attrs) {
    const art = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" style="fill:var(--surface)"/>
      <line x1="12" y1="34" x2="80" y2="34" style="stroke:var(--t2)" stroke-width="4" stroke-linecap="round"/>
      <line x1="12" y1="50" x2="80" y2="50" style="stroke:var(--t2)" stroke-width="4" stroke-linecap="round"/>
      <line x1="12" y1="66" x2="54" y2="66" style="stroke:var(--t2)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="74" cy="67" r="14" style="fill:var(--surface);stroke:var(--primary)" stroke-width="2.2"/>
      <polygon points="70,61 70,73 83,67" style="fill:var(--primary)"/>
    </svg>`;
    return `<div class="hc" ${attrs || ''}>
      <div class="hc-art">${art}</div>
      <div class="hc-info"><div class="hc-title">${esc(label)}</div></div>
    </div>`;
  }

  const _GRIP_ICO = `<svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="6" r="1.5"/><circle cx="7.5" cy="6" r="1.5"/><circle cx="2.5" cy="10" r="1.5"/><circle cx="7.5" cy="10" r="1.5"/><circle cx="2.5" cy="14" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/></svg>`;
  function shelf(id, title, cards) {
    if (!cards) return '';
    return `<div class="home-shelf" data-shelf="${id}" draggable="true">
      <div class="home-shelf-header">
        <span class="home-grip" title="Drag to reorder">${_GRIP_ICO}</span>
        <span class="home-shelf-title">${title}</span>
      </div>
      <div class="home-row">${cards}</div>
    </div>`;
  }

  // ── five shelves ────────────────────────────────────────────

  // shelf order helpers (shared with drag-to-reorder)
  const _ORDER_KEY = `ms2_home_order_${S.username || ''}`;  
  function _savedOrder() { try { return JSON.parse(localStorage.getItem(_ORDER_KEY) || 'null'); } catch(_) { return null; } }
  function _saveOrder() {
    const v = document.getElementById('content-body')?.querySelector('.home-view');
    if (!v) return;
    const order = JSON.stringify([...v.querySelectorAll(':scope > .home-shelf')].map(s => s.dataset.shelf));
    localStorage.setItem(_ORDER_KEY, order);
    api('POST', 'api/v1/user/settings', { prefs: { home_order: order } }).catch(() => {});
  }

  // 1. Radio Stations
  const radioHtml    = radioStations.map(s =>
    artCard(s.img ? artUrl(s.img, 's') : null, s.name, s.genre ? s.genre.split(',')[0].trim() : '', `data-rsid="${esc(String(s.id))}" data-hid="rs:${esc(String(s.id))}"`)
  ).join('');
  const radioShelf   = shelf('radio', 'Radio Stations', radioHtml || null);

  // 2. Podcasts
  const podcastHtml  = podcastFeeds.map(f =>
    artCard(f.img ? artUrl(f.img, 's') : null, f.title || f.url, '', `data-pfid="${esc(String(f.id))}" data-hid="pf:${esc(String(f.id))}"`)
  ).join('');
  const podcastShelf = shelf('podcasts', 'Podcasts', podcastHtml || null);

  // 3. Playlists & Folders
  const vpathHtml    = S.vpaths.map(v    => folderCard(v,       `data-icid="${esc('vp:' + v)}" data-hid="ic:vp:${esc(v)}"`)   ).join('');
  const playlistHtml = S.playlists.map(p => folderCard(p.name,  `data-icid="${esc('pl:' + p.name)}" data-hid="ic:pl:${esc(p.name)}"`)  ).join('');
  const playlistShelf = shelf('playlists', 'Playlists & Folders', (vpathHtml + playlistHtml) || null);

  // 4 & 5. Song shelves
  const recentShelf = shelf('recent', 'Recently Played', recentlyPlayed.map(s => songCard(s, false)).join('') || null);
  const mostShelf   = shelf('most',   'Most Played',     mostPlayed.map(s => songCard(s, true)).join('')  || null);

  // 6. "Because you listened to …" shelves
  const becauseShelfEntries = becauseShelves.map(({ artist, songs }) => {
    const key   = `bec:${artist}`;
    const cards = songs.map(s => songCard(s, false)).join('');
    return [key, shelf(key, `Because you listened to ${esc(artist)}`, cards)];
  });
  const becauseSongsList = becauseShelves.flatMap(b => b.songs);

  // ── render (restore saved shelf order) ──────────────────────
  const _shelfMap  = { radio: radioShelf, podcasts: podcastShelf, playlists: playlistShelf, recent: recentShelf, most: mostShelf };
  becauseShelfEntries.forEach(([k, v]) => { _shelfMap[k] = v; });
  const _defOrder  = ['radio', 'podcasts', 'playlists', 'recent', 'most', ...becauseShelfEntries.map(([k]) => k)];
  const _order     = (_savedOrder() || _defOrder).filter(id => _shelfMap[id]);
  _defOrder.forEach(id => { if (!_order.includes(id)) _order.push(id); });
  const _orderedHtml = _order.map(id => _shelfMap[id] || '').join('');

  // Toolbar with Customize button sits ABOVE all shelves and is not inside any
  // shelf element, so drag-to-reorder cannot move it.
  const _toolbarHtml = `<div class="home-toolbar"><button class="home-customize-btn">Customize</button></div>`;
  setBody(`<div class="home-view">${_toolbarHtml}${_orderedHtml}</div>`);

  const body = document.getElementById('content-body');

  body.querySelectorAll('[data-rsid]').forEach(card => {
    card.addEventListener('click', () => {
      const s = radioStations.find(x => String(x.id) === card.dataset.rsid);
      if (s) { _radioStations = radioStations; _playRadio(s); }
    });
  });

  body.querySelectorAll('[data-pfid]').forEach(card => {
    card.addEventListener('click', () => {
      const f = podcastFeeds.find(x => String(x.id) === card.dataset.pfid);
      if (f) viewPodcastEpisodes(f);
    });
  });

  body.querySelectorAll('.home-song').forEach(card => {
    card.addEventListener('click', () => {
      const fp = card.dataset.fp;
      const s = recentlyPlayed.concat(mostPlayed).concat(becauseSongsList).find(x => x.filepath === fp);
      if (s) { _setPlaySource('home', 'Home'); Player.queueAndPlay(s); }
    });
  });

  body.querySelectorAll('[data-icid]').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.icid;
      if (id.startsWith('vp:'))      { S.feDirStack = []; viewFiles('/' + id.slice(3), false); }
      else if (id.startsWith('pl:')) openPlaylist(id.slice(3));
    });
  });

  // ── shelf drag-to-reorder ────────────────────────────────────
  // dragstart fires on the shelf element, not the grip child, so composedPath()
  // is useless — use a mousedown flag instead.
  let _dragSrc = null, _canDrag = false;
  body.querySelectorAll('.home-grip').forEach(grip => {
    grip.addEventListener('mousedown', () => { _canDrag = true; });
  });
  body.addEventListener('mouseup', () => { _canDrag = false; });
  body.querySelectorAll('.home-shelf').forEach(shelf => {
    shelf.addEventListener('dragstart', e => {
      if (!_canDrag) { e.preventDefault(); return; }
      _dragSrc = shelf;
      shelf.classList.add('hs-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    shelf.addEventListener('dragend', () => {
      _canDrag = false;
      _dragSrc = null;
      body.querySelectorAll('.home-shelf').forEach(s => s.classList.remove('hs-dragging', 'hs-over'));
      _saveOrder();
    });
    shelf.addEventListener('dragover', e => {
      if (!_dragSrc || _dragSrc === shelf) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.querySelectorAll('.home-shelf').forEach(s => s.classList.remove('hs-over'));
      shelf.classList.add('hs-over');
    });
    shelf.addEventListener('dragleave', e => {
      if (!shelf.contains(e.relatedTarget)) shelf.classList.remove('hs-over');
    });
    shelf.addEventListener('drop', e => {
      e.preventDefault();
      if (!_dragSrc || _dragSrc === shelf) return;
      const view = shelf.closest('.home-view');
      const all  = [...view.querySelectorAll(':scope > .home-shelf')];
      const si   = all.indexOf(_dragSrc);
      const di   = all.indexOf(shelf);
      if (si < di) view.insertBefore(_dragSrc, shelf.nextSibling);
      else         view.insertBefore(_dragSrc, shelf);
    });
  });

  // ── favorites / compact home ─────────────────────────────────
  const _HIDDEN_KEY = `ms2_home_hidden_${S.username || ''}`;  
  function _loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem(_HIDDEN_KEY) || '[]')); }
    catch(_) { return new Set(); }
  }
  function _saveHidden(s) {
    const v = JSON.stringify([...s]);
    localStorage.setItem(_HIDDEN_KEY, v);
    api('POST', 'api/v1/user/settings', { prefs: { home_hidden: v } }).catch(() => {});
  }

  function _applyVisibility() {
    const view = body.querySelector('.home-view');
    if (!view) return;
    const editing = view.classList.contains('home-editing');
    const hidden  = _loadHidden();
    body.querySelectorAll('[data-hid]').forEach(card => {
      card.classList.toggle('hc-hidden', hidden.has(card.dataset.hid));
    });
    body.querySelectorAll('.home-shelf').forEach(s => {
      const all = s.querySelectorAll('[data-hid]').length;
      if (all === 0) { s.classList.remove('hs-empty'); return; } // dynamic shelf (songs) — always visible
      const vis = s.querySelectorAll('[data-hid]:not(.hc-hidden)').length;
      s.classList.toggle('hs-empty', !editing && vis === 0);
    });
  }

  // Customize button is now rendered in the toolbar above shelves — no injection needed.

  _applyVisibility();

  const _custBtn = body.querySelector('.home-customize-btn');
  if (_custBtn) {
    _custBtn.addEventListener('click', () => {
      const view = body.querySelector('.home-view');
      const editing = !view.classList.contains('home-editing');
      view.classList.toggle('home-editing', editing);
      _custBtn.textContent = editing ? 'Done' : 'Customize';
      _custBtn.classList.toggle('active', editing);
      _applyVisibility();
    });
  }

  // In edit mode, intercept card clicks to toggle visibility instead of playing
  const _homeACOpts = _homeAC ? { capture: true, signal: _homeAC.signal } : { capture: true };
  body.addEventListener('click', e => {
    const view = body.querySelector('.home-view');
    if (!view || !view.classList.contains('home-editing')) return;
    const card = e.target.closest('[data-hid]');
    if (!card) return;
    e.stopPropagation();
    const hidden = _loadHidden();
    const hid = card.dataset.hid;
    if (hidden.has(hid)) hidden.delete(hid); else hidden.add(hid);
    _saveHidden(hidden);
    _applyVisibility();
  }, _homeACOpts);
}

// ── FILE EXPLORER ─────────────────────────────────────────────
async function viewFiles(dir, addToStack) {
  setNavActive('files'); S.view = 'files';
  if (addToStack && S.feDir !== dir) S.feDirStack.push(S.feDir);
  S.feDir = dir || '';
  const sig = _navCancel();
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/file-explorer', { directory: S.feDir, sort: true, pullMetadata: true }, sig);
    renderFileExplorer(d);
  } catch(e) { if (e.name === 'AbortError') return; setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function renderFileExplorer(d) {
  const curPath = d.path || '/';
  // Build breadcrumb — if inside Audio Content context, root crumb links back there
  const parts = curPath.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const _inAC = !!S.audioContentReturn;
  let crumbs = _inAC
    ? `<span class="fe-crumb" data-dir="__ac__">⌂ Audio Content</span>`
    : `<span class="fe-crumb" data-dir="">⌂ Root</span>`;
  let cumPath = '';
  parts.forEach(p => {
    crumbs += `<span class="fe-crumb-sep">/</span>`;
    cumPath += (cumPath ? '/' : '') + p;
    crumbs += `<span class="fe-crumb" data-dir="/${cumPath}">${esc(p)}</span>`;
  });

  const feVpath = parts[0] || '';
  const canDelete = feVpath &&
    (S.vpathMeta?.[feVpath]?.type === 'recordings' || S.vpathMeta?.[feVpath]?.type === 'youtube') &&
    S.vpathMeta?.[feVpath]?.allowRecordDelete === true;

  const dirs = (d.directories || []).map(dir => `
    <div class="fe-dir" data-dir="${esc(curPath + dir.name)}">
      <svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="fe-name">${esc(dir.name)}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t3);flex-shrink:0"><polyline points="9,18 15,12 9,6"/></svg>
    </div>`).join('');

  const files = (d.files || []).map(file => {
    const meta = file.metadata?.metadata;
    const fp   = file.metadata?.filepath;
    const title  = meta?.title  || file.name;
    const artist = meta?.artist || '';
    const artU   = artUrl(meta?.['album-art'], 's');
    const thumb  = artU
      ? `<img class="fe-thumb" src="${artU}" alt="" loading="lazy" onerror="this.outerHTML='<svg class=fe-icon width=16 height=16 viewBox=&quot;0 0 24 24&quot; fill=none stroke=currentColor stroke-width=2><path d=&quot;M9 18V5l12-2v13&quot;/><circle cx=6 cy=18 r=3/><circle cx=18 cy=16 r=3/></svg>'">`
      : `<svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    return `
      <div class="fe-file" data-fp="${esc(fp || '')}" data-name="${esc(file.name)}">
        ${thumb}
        <div class="fe-name">
          <div>${esc(title)}</div>
          ${artist ? `<div style="font-size:11px;color:var(--t2);margin-top:1px">${esc(artist)}</div>` : ''}
        </div>
        <span class="fe-sub">${esc(file.type?.toUpperCase() || '')}</span>
        <div class="fe-actions">
          <button class="fe-act fe-play-btn" title="Play">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <button class="fe-act fe-add-btn" title="Add to queue">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <a class="fe-act" href="${fp ? dlUrl(fp) : '#'}" download="${esc(file.name)}" title="Download" onclick="event.stopPropagation()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
          ${canDelete ? `<button class="fe-act fe-del-btn" title="Delete Recording" style="color:var(--red,#e05)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg>
          </button>` : ''}
        </div>
      </div>`;
  }).join('');

  // Back button logic — when inside an Audio Content context, back goes to Audio Content root
  const hasBack = S.feDirStack.length > 0;
  if (S.audioContentReturn) setNavActive('podcasts');
  const _backFromStack = () => { const prev = S.feDirStack.pop(); S.feDir = prev; viewFiles(prev, false); };
  const _backToAC = S.audioContentReturn
    ? () => { const fn = S.audioContentReturn; S.audioContentReturn = null; fn(); }
    : null;
  const _backToSearch = S.feSearchReturn
    ? () => { const fn = S.feSearchReturn; S.feSearchReturn = null; fn(); }
    : null;
  setBack(hasBack ? _backFromStack : (_backToAC || _backToSearch));
  setTitle(parts.length ? parts[parts.length - 1] : 'File Explorer');

  // Play all for directory
  const dirSongs = (d.files || [])
    .filter(f => f.metadata?.filepath)
    .map(f => norm(f.metadata));

  document.getElementById('play-all-btn').onclick = () => {
    if (dirSongs.length) { Player.setQueue(dirSongs, 0); toast(`Playing ${dirSongs.length} songs from this folder`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (dirSongs.length) { Player.addAll(dirSongs); }
  };
  S.curSongs = dirSongs;

  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="fe-breadcrumb">${crumbs}</div>
    <div class="fe-filter-row">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="fe-filter" class="fe-filter-input" type="text" placeholder="Filter folders and songs…" autocomplete="off">
      <span id="fe-match-count" class="fe-match-count"></span>
      <button id="fe-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
      ${S.canUpload && curPath !== '/' ? `<button id="fe-upload-btn" class="fe-upload-btn" title="Upload files here"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16,16 12,12 8,16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Upload</button>` : ''}
    </div>
    <div id="fe-grid" class="fe-grid">${dirs}${files}</div>`;

  // Live filter
  const filterInput  = body.querySelector('#fe-filter');
  const filterClear  = body.querySelector('#fe-filter-clear');
  const matchCount   = body.querySelector('#fe-match-count');
  const grid         = body.querySelector('#fe-grid');

  // Restore saved filter from previous navigation level
  if (S.feFilter) { filterInput.value = S.feFilter; }

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    filterClear.classList.toggle('hidden', !q);
    const rows = grid.querySelectorAll('.fe-dir, .fe-file');
    let visible = 0;
    rows.forEach(row => {
      const name = (row.dataset.dir || row.dataset.name || '').split('/').pop().toLowerCase();
      const artist = row.querySelector('[style*="color:var(--t2)"]')?.textContent?.toLowerCase() || '';
      const matches = !q || name.includes(q) || artist.includes(q);
      row.classList.toggle('fe-hidden', !matches);
      if (matches) visible++;
    });
    matchCount.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
  }

  filterInput.addEventListener('input', () => { S.feFilter = filterInput.value; applyFilter(); });
  filterClear.addEventListener('click', () => { filterInput.value = ''; S.feFilter = ''; filterInput.focus(); applyFilter(); });

  // Apply restored filter immediately if one exists
  if (S.feFilter) applyFilter();

  // Upload button
  body.querySelector('#fe-upload-btn')?.addEventListener('click', () => openUploadModal(curPath));

  // Breadcrumb navigation
  body.querySelectorAll('.fe-crumb').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.dir === '__ac__') {
        // Return to Audio Content root
        const fn = S.audioContentReturn;
        S.audioContentReturn = null;
        S.feDirStack = [];
        if (fn) fn(); else viewPodcasts();
      } else {
        S.feDirStack = [];
        viewFiles(el.dataset.dir || '', false);
      }
    });
  });
  // Navigate into directory — filter persists (saved in S.feFilter)
  body.querySelectorAll('.fe-dir').forEach(el => {
    el.addEventListener('click', () => viewFiles(el.dataset.dir, true));
  });
  // File actions
  body.querySelectorAll('.fe-file').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.fe-act')) return;
      const fp = el.dataset.fp;
      if (!fp) return;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.queueAndPlay(found);
    });
  });
  body.querySelectorAll('.fe-play-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fp = btn.closest('.fe-file').dataset.fp;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.playSingle(found);
    });
  });
  body.querySelectorAll('.fe-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fp = btn.closest('.fe-file').dataset.fp;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.addSong(found);
    });
  });
  body.querySelectorAll('.fe-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fileEl = btn.closest('.fe-file');
      const fp = fileEl.dataset.fp;
      const fname = fp.split('/').pop();
      showConfirmModal(
        'Delete recording?',
        `"${fname}" will be permanently deleted from the server. This cannot be undone.`,
        async () => {
          try {
            await api('DELETE', 'api/v1/files/recording', { filepath: fp });
            toast(`Deleted: ${fname}`);
            fileEl.remove();
            const idx = S.curSongs.findIndex(s => s.filepath === fp);
            if (idx !== -1) S.curSongs.splice(idx, 1);
            const qi = S.queue.findIndex(s => s.filepath === fp);
            if (qi !== -1) {
              S.queue.splice(qi, 1);
              if (S.idx > qi) S.idx--;
              else if (S.idx === qi) S.idx = Math.min(S.idx, S.queue.length - 1);
              persistQueue();
              refreshQueueUI();
            }
          } catch(_e) {
            toast('Failed to delete recording');
          }
        }
      );
    });
  });

  // On-demand art for files not yet scanned / no embedded art cached
  const _feMissing = dirSongs.filter(s => !s['album-art'] && !s.isRadio && !s.isPodcast && s.filepath);
  if (_feMissing.length) {
    _feMissing.forEach(s => {
      api('GET', `api/v1/files/art?fp=${encodeURIComponent(s.filepath)}`)
        .then(d => {
          if (!d?.aaFile) return;
          s['album-art'] = d.aaFile;
          const fileEl = body.querySelector(`.fe-file[data-fp="${CSS.escape(s.filepath)}"]`);
          if (!fileEl) return;
          const svgIcon = fileEl.querySelector('svg.fe-icon');
          if (!svgIcon) return;
          const img = document.createElement('img');
          img.className = 'fe-thumb';
          img.alt = '';
          img.loading = 'lazy';
          img.src = artUrl(d.aaFile, 's');
          img.onerror = function() { this.outerHTML = '<svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'; };
          svgIcon.replaceWith(img);
        })
        .catch(() => {});
    });
  }
}

// ── AUTO-DJ VIEW ──────────────────────────────────────────────
async function viewAutoDJ() {
  setTitle('Auto-DJ'); setBack(null); setNavActive('autodj'); S.view = 'autodj';
  S.curSongs = [];
  // Ensure vpaths are loaded (may be empty if checkSession had a hiccup)
  if (!S.vpaths.length) {
    try {
      const d = await api('GET', 'api/v1/db/status');
      if (d.vpaths && d.vpaths.length) {
        S.vpaths = d.vpaths;
        if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
      }
    } catch(_) {}
  }
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="autodj-panel">
      <div class="autodj-hero">
        <div class="autodj-icon">🎲</div>
        <h2>Auto-DJ</h2>
        <p>Automatically plays random songs from your library so you never run out of music. Adjust the settings below to tune your experience.</p>
      </div>
      <button class="autodj-toggle${S.autoDJ ? ' on' : ''}" id="autodj-main-btn">
        ${S.autoDJ ? '⏹ Stop Auto-DJ' : '▶ Start Auto-DJ'}
      </button>
      <div class="autodj-status${S.autoDJ ? ' on' : ''}" id="autodj-status-msg">
        ${S.autoDJ ? 'Auto-DJ is ON — random songs will play continuously' : 'Auto-DJ is OFF'}
      </div>
      <div class="autodj-opts">
        <h4>Settings</h4>
        ${S.vpaths.length > 1 ? `
        <div class="autodj-opt-row autodj-opt-col">
          <div>
            <div class="autodj-opt-label">Sources</div>
            <div class="autodj-opt-hint">Collections Auto-DJ draws from</div>
          </div>
          <div class="dj-vpath-pills" id="dj-vpaths">
            ${S.vpaths.map(v => `<button class="dj-vpath-pill${S.djVpaths.includes(v) ? ' on' : ''}" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')}
          </div>
        </div>` : ''}
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Minimum Rating</div>
            <div class="autodj-opt-hint">Only play songs with this rating or higher</div>
          </div>
          <select class="autodj-select" id="dj-min-rating">
            <option value="0" ${S.djMinRating===0?'selected':''}>Any</option>
            <option value="2" ${S.djMinRating===2?'selected':''}>★ (1 star)</option>
            <option value="4" ${S.djMinRating===4?'selected':''}>★★ (2 stars)</option>
            <option value="6" ${S.djMinRating===6?'selected':''}>★★★ (3 stars)</option>
            <option value="8" ${S.djMinRating===8?'selected':''}>★★★★ (4 stars)</option>
            <option value="10" ${S.djMinRating===10?'selected':''}>★★★★★ (5 stars)</option>
          </select>
        </div>
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Similar Artists Mode</div>
            <div class="autodj-opt-hint">Use Last.fm to bias AutoDJ towards artists similar to what's playing${S.lastfmHasApiKey ? '' : ' <em>(requires Last.fm API key — configure in Admin → Last.fm)</em>'}</div>
          </div>
          <label class="toggle-sw" ${S.lastfmHasApiKey ? '' : 'title="No Last.fm API key configured"'} style="${S.lastfmHasApiKey ? '' : 'opacity:.4;pointer-events:none;'}">
            <input type="checkbox" id="dj-similar" ${S.djSimilar && S.lastfmHasApiKey ? 'checked' : ''} ${S.lastfmHasApiKey ? '' : 'disabled'}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Crossfade Duration</div>
            <div class="autodj-opt-hint">Smoothly blend between tracks · 0 = disabled · max 12 s</div>
          </div>
          <div class="xf-ctrl">
            <input type="range" id="xf-slider-dj" class="xf-slider" min="0" max="12" step="1" value="${S.crossfade}">
            <span id="xf-val-dj" class="xf-val">${S.crossfade === 0 ? 'Off' : S.crossfade + 's'}</span>
          </div>
        </div>
${_webAnimSupported ? `
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Dice Roll on Crossfade</div>
            <div class="autodj-opt-hint">Throw a tumbling die each time Auto-DJ crossfades to a new track</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="dj-dice-toggle" ${S.djDice ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>` : ''}
        <div class="autodj-opt-row autodj-opt-col">
          <div class="autodj-filter-header">
            <div>
              <div class="autodj-opt-label">Keyword Filter</div>
              <div class="autodj-opt-hint">Skip songs whose title, artist, album or filename contains any of these words</div>
            </div>
            <label class="toggle-sw">
              <input type="checkbox" id="dj-filter-toggle" ${S.djFilterEnabled ? 'checked' : ''}>
              <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
            </label>
          </div>
          <div class="dj-filter-tags" id="dj-filter-tags">
            ${S.djFilterWords.map(w => `<span class="dj-filter-tag">${esc(w)}<button class="dj-filter-tag-rm" data-word="${esc(w)}" title="Remove">×</button></span>`).join('')}
            <input class="dj-filter-input" id="dj-filter-input" type="text" placeholder="Type word + Enter…" ${S.djFilterEnabled ? '' : 'disabled'}>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('autodj-main-btn').onclick = () => setAutoDJ(!S.autoDJ);
  document.getElementById('dj-min-rating').onchange = e => {
    S.djMinRating = parseInt(e.target.value);
    localStorage.setItem(_djKey('min_rating'), S.djMinRating);
    _syncPrefs();
  };
  document.getElementById('dj-similar').addEventListener('change', e => {
    S.djSimilar = e.target.checked;
    S.djSimilar
      ? localStorage.setItem(_uKey('dj_similar'), '1')
      : localStorage.removeItem(_uKey('dj_similar'));
    _syncPrefs();
    _syncQueueLabel();
    toast(S.djSimilar ? 'Similar Artists: On' : 'Similar Artists: Off');
  });
  const xfSliderDj = document.getElementById('xf-slider-dj');
  const xfValDj    = document.getElementById('xf-val-dj');
  xfSliderDj.addEventListener('input', () => {
    const v = parseInt(xfSliderDj.value);
    xfValDj.textContent = v === 0 ? 'Off' : v + 's';
    S.crossfade = v;
    localStorage.setItem(_uKey('crossfade'), v);
    const ps = document.getElementById('xf-slider');
    const pv = document.getElementById('xf-val');
    if (ps) { ps.value = v; pv.textContent = v === 0 ? 'Off' : v + 's'; }
    _syncPrefs();
    _syncQueueLabel();
  });
  if (_webAnimSupported) {
    document.getElementById('dj-dice-toggle').addEventListener('change', e => {
      S.djDice = e.target.checked;
      S.djDice
        ? localStorage.setItem(_uKey('dj_dice'), '1')
        : localStorage.removeItem(_uKey('dj_dice'));
      _syncPrefs();
      toast(S.djDice ? 'Dice Roll: On' : 'Dice Roll: Off');
    });
  }

  // ── Keyword Filter handlers ────────────────────────────────
  function _saveFilterWords() {
    localStorage.setItem('ms2_dj_filter_words_' + (S.username || ''), JSON.stringify(S.djFilterWords));
    _syncPrefs();
  }
  function _renderFilterTag(word) {
    const span = document.createElement('span');
    span.className = 'dj-filter-tag';
    span.innerHTML = `${esc(word)}<button class="dj-filter-tag-rm" data-word="${esc(word)}" title="Remove">×</button>`;
    return span;
  }
  document.getElementById('dj-filter-toggle').addEventListener('change', e => {
    S.djFilterEnabled = e.target.checked;
    S.djFilterEnabled
      ? localStorage.setItem('ms2_dj_filter_on_' + (S.username || ''), '1')
      : localStorage.removeItem('ms2_dj_filter_on_' + (S.username || ''));
    const inp = document.getElementById('dj-filter-input');
    if (inp) inp.disabled = !S.djFilterEnabled;
    _syncPrefs();
    toast(S.djFilterEnabled ? 'Keyword Filter: On' : 'Keyword Filter: Off');
  });
  const filterInp = document.getElementById('dj-filter-input');
  if (filterInp) {
    filterInp.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const word = filterInp.value.trim().toLowerCase();
      if (!word || S.djFilterWords.includes(word)) { filterInp.value = ''; return; }
      S.djFilterWords.push(word);
      _saveFilterWords();
      const container = document.getElementById('dj-filter-tags');
      container.insertBefore(_renderFilterTag(word), filterInp);
      filterInp.value = '';
    });
  }
  document.getElementById('dj-filter-tags').addEventListener('click', e => {
    const btn = e.target.closest('.dj-filter-tag-rm');
    if (!btn) return;
    const word = btn.dataset.word;
    S.djFilterWords = S.djFilterWords.filter(w => w !== word);
    _saveFilterWords();
    btn.closest('.dj-filter-tag').remove();
  });

  const pillsEl = document.getElementById('dj-vpaths');
  if (pillsEl) {
    pillsEl.addEventListener('click', e => {
      const pill = e.target.closest('.dj-vpath-pill');
      if (!pill) return;
      const v = pill.dataset.vpath;
      const idx = S.djVpaths.indexOf(v);
      if (idx === -1) {
        S.djVpaths.push(v);
        pill.classList.add('on');
      } else if (S.djVpaths.length > 1) {
        S.djVpaths.splice(idx, 1);
        pill.classList.remove('on');
      } else {
        toast('At least one source must be active');
        return;
      }
      localStorage.setItem(_djKey('vpaths'), JSON.stringify(S.djVpaths));
      S.djIgnore = []; // reset play history when sources change
      S.djArtistHistory = [];
      localStorage.removeItem(_djKey('ignore'));
      localStorage.removeItem(_djKey('artist_history'));
      _syncPrefs();
    });
  }
}

// ── GENRE VIEW ────────────────────────────────────────────────

/**
 * Lightweight virtual-scroll album grid.
 * Renders only the rows within the viewport (+ BUFS buffer rows).
 * @param {Array}    albums    - raw album objects from the API
 * @param {Function} buildCard - (album) => HTML string for one card
 * @param {Function} onClick   - (album, cardEl) => called on card click
 */
function _mountAlbumVScroll(albums, buildCard, onClick, containerEl) {
  const GAP = 20, BUFS = 3;
  let cols = 0, rowH = 0, fRow = -1, lRow = -1;

  const body = containerEl || document.getElementById('content-body');
  body.innerHTML = '<div class="album-grid" id="vgrid"></div>';
  const grid = document.getElementById('vgrid');

  function measure() {
    const gw = grid.clientWidth;
    if (!gw) return false;
    const probe = document.createElement('div');
    probe.className = 'album-card';
    probe.style.cssText = 'visibility:hidden;pointer-events:none;position:relative';
    probe.innerHTML = '<div class="album-art" style="aspect-ratio:1"></div>'
                    + '<div class="album-info"><div class="album-name">X</div></div>';
    grid.appendChild(probe);
    rowH = probe.offsetHeight;
    const pw = probe.offsetWidth;
    grid.removeChild(probe);
    cols = pw > 0 ? Math.max(1, Math.round((gw + GAP) / (pw + GAP))) : 1;
    return rowH > 0;
  }

  function render(force) {
    if (!cols || !rowH) { if (!measure()) return; }
    const nRows = Math.ceil(albums.length / cols);
    const sTop  = body.scrollTop;
    const vH    = body.clientHeight;
    const nF    = Math.max(0, Math.floor(sTop / (rowH + GAP)) - BUFS);
    const nL    = Math.min(nRows - 1, Math.ceil((sTop + vH) / (rowH + GAP)) + BUFS);
    if (!force && nF === fRow && nL === lRow) return;
    fRow = nF; lRow = nL;
    grid.style.paddingTop    = `${fRow * (rowH + GAP)}px`;
    grid.style.paddingBottom = `${Math.max(0, nRows - lRow - 1) * (rowH + GAP)}px`;
    const html = [];
    for (let i = fRow * cols; i <= Math.min(albums.length - 1, (lRow + 1) * cols - 1); i++) {
      html.push(buildCard(albums[i], i));
    }
    grid.innerHTML = html.join('');
  }

  let _rafA = false;
  body.addEventListener('scroll', () => {
    if (_rafA || !grid.isConnected) return;
    _rafA = true;
    requestAnimationFrame(() => { _rafA = false; if (grid.isConnected) render(false); });
  });
  const ro = new ResizeObserver(() => requestAnimationFrame(() => {
    if (!grid.isConnected) { ro.disconnect(); return; }
    if (measure()) { fRow = -1; lRow = -1; render(true); }
  }));
  ro.observe(grid);
  grid.addEventListener('click', e => {
    const card = e.target.closest('.album-card');
    if (card) onClick(albums[parseInt(card.dataset.i)], card);
  });

  render(true);
}

// Super-category buckets for genre grouping — first match wins
const GENRE_BUCKETS = [
  ['Rock',               /\b(rock|punk|metal|grunge|emo|hardcore|alternative|indie|shoegaze|post.rock|new.wave|prog(ressive)?|glam|gothic|psychedel|garage|britpop|surf|math.rock|noise.rock|skate)\b/i],
  ['Electronic',         /\b(electro(nic)?|techno|house|trance|drum.?n?.?bass|dnb|d&b|ambient|synth|rave|edm|idm|breakbeat|dubstep|chillout|chill(?!i)|deep.house|trip.hop|downtempo|jungle|acid|minimal(?! folk|ist)|dance(?!.pop)|club|industrial|dark.wave|ebm|vaporwave|lo.?fi|hardstyle|psytrance|psybient|dub(?!step)|gabber|neurofunk|liquid drum|deathstep)\b/i],
  ['Pop',                /\b(pop(?!.punk|.rock)|disco|bubblegum|teen.pop|j.?pop|k.?pop|c.?pop|city.pop)\b/i],
  ['Hip-Hop & R&B',      /\b(hip.?hop|rap|r&b|rnb|neo.?soul|urban|grime|trap|drill|afroswing)\b/i],
  ['Soul & Funk',        /\b(soul|funk|motown|rhythm.and.blues|boogie|northern.soul|groove(?! metal))\b/i],
  ['Jazz & Blues',       /\b(jazz|blues|swing|bebop|be.bop|fusion|bossa|latin.jazz|cool.jazz|dixieland|delta|smooth.jazz|acid.jazz|nu.jazz)\b/i],
  ['Classical',          /\b(classical|orchestral|opera|chamber|symphony|baroque|contempor|neoclassic|minimali(st)?|modern.classical)\b/i],
  ['Folk & Country',     /\b(folk|country|bluegrass|acoustic(?!.rock)|singer.?songwriter|americana|celtic|irish|western|cowboy|outlaw|appalachian)\b/i],
  ['World & Reggae',     /\b(world|reggae|latin(?!.jazz)|african|caribbean|cuban|salsa|bossa.nova|afrobeat|cumbia|flamenco|tango|polka|turkish|arabic|indian|bollywood|samba|merengue|calypso|afrobeats|dancehall)\b/i],
  ['Gospel & Christian', /\b(gospel|christian|worship|spiritual|hymn|ccm|praise|inspirational|devotional)\b/i],
];
function classifyGenre(name) {
  for (const [label, re] of GENRE_BUCKETS) { if (re.test(name)) return label; }
  return 'Other';
}

// Build genre sections HTML from server-provided groups (or fall back to GENRE_BUCKETS)
// genreGroups: [{name, genres:[{genre,cnt}]}] or null
// allGenres:   [{genre,cnt}]
function _buildGenreSections(genreGroups, allGenres) {
  let sectionList;
  if (genreGroups && genreGroups.length > 0) {
    sectionList = genreGroups;
  } else {
    // Fall back to GENRE_BUCKETS classifier
    const bucketOrder = [...GENRE_BUCKETS.map(([l]) => l), 'Other'];
    const grouped = {};
    for (const g of allGenres) {
      const cat = classifyGenre(g.genre);
      (grouped[cat] = grouped[cat] || []).push(g);
    }
    sectionList = bucketOrder.filter(cat => grouped[cat]).map(cat => ({ name: cat, genres: grouped[cat] }));
  }
  return sectionList.map(grp => {
    const chips = grp.genres.map(g =>
      `<button class="genre-chip" data-genre="${esc(g.genre)}">${esc(g.genre)}<span class="genre-cnt">${g.cnt}</span></button>`
    ).join('');
    return `<div class="genre-section"><button class="genre-section-head"><span class="genre-section-name">${esc(grp.name)}</span><span class="genre-section-count">${grp.genres.length}</span><svg class="genre-section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6,9 12,15 18,9"/></svg></button><div class="genre-grid">${chips}</div></div>`;
  }).join('');
}

async function viewGenres() {
  setTitle('Genres'); setBack(null); setNavActive('genres'); S.view = 'genres';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('GET', 'api/v1/db/genre-groups');
    const allGenres = d.genres || [];
    if (!allGenres.length) {
      setBody('<div class="info-panel"><h2>No Genres</h2><p class="info-hint">Your library has no genre tags. Tag your files to use this view.</p></div>');
      return;
    }
    setBody(`<div class="genre-sections">${_buildGenreSections(d.groups, allGenres)}</div>`);
    document.querySelectorAll('.genre-section-head').forEach(btn =>
      btn.addEventListener('click', () => btn.closest('.genre-section').classList.toggle('collapsed'))
    );
    document.querySelectorAll('.genre-chip').forEach(el =>
      el.addEventListener('click', () => viewGenreDetail(el.dataset.genre))
    );
  } catch(e) { setBody('<div class="info-panel"><p class="info-hint">Failed to load genres.</p></div>'); }
}

// ── DECADE VIEW ────────────────────────────────────────────────
async function viewDecades() {
  setTitle('Decades'); setBack(null); setNavActive('decades'); S.view = 'decades';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('GET', 'api/v1/db/decades');
    if (!d.decades || d.decades.length === 0) {
      setBody('<div class="info-panel"><h2>No Year Data</h2><p class="info-hint">Your library has no year tags. Tag your files to use this view.</p></div>');
      return;
    }
    const items = d.decades.map(row => {
      const label = row.decade ? `${row.decade}s` : 'Unknown';
      return `<button class="decade-card" data-decade="${row.decade}">${esc(label)}<span class="decade-stat">${row.cnt} tracks · ${row.albums} albums</span></button>`;
    }).join('');
    setBody(`<div class="decade-grid">${items}</div>`);
    document.querySelectorAll('.decade-card').forEach(el => {
      const dec = el.dataset.decade;
      const lbl = dec ? `${dec}s` : 'Unknown';
      el.addEventListener('click', () => viewDecadeDetail(parseInt(dec), lbl));
    });
  } catch(e) { setBody('<div class="info-panel"><p class="info-hint">Failed to load decades.</p></div>'); }
}

// ── SHARED: virtual song list with sort bar ─────────────────────────────────
function _mountSongVScroll(allSongs, container) {
  const BUFS = 8;
  let rowH = 0, fRow = -1, lRow = -1;
  let _sortKey = 'artist', _sortAsc = true;
  let _songs = allSongs.slice();

  container.classList.add('tracks-mode');
  container.innerHTML = `
    <div class="sort-bar">
      <span class="sort-bar-label">Sort</span>
      <button class="sort-pill active" data-key="artist">Artist <span class="sort-dir">↑</span></button>
      <button class="sort-pill" data-key="title">Title</button>
      <button class="sort-pill" data-key="album">Album</button>
      <button class="sort-pill" data-key="year">Year</button>
    </div>
    <div class="vslist-wrap"><div class="song-list"></div></div>`;

  const wrap    = container.querySelector('.vslist-wrap');
  const list    = wrap.querySelector('.song-list');
  const sortBar = container.querySelector('.sort-bar');

  function rowHtml(s, i) {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    return `<div class="song-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}</div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        <div class="song-sub">${esc(artist)}${esc(album)}</div>
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }

  function measure() {
    if (rowH) return;
    const probe = document.createElement('div');
    probe.className = 'song-row';
    probe.style.cssText = 'visibility:hidden;pointer-events:none';
    probe.innerHTML = '<div class="row-num"></div><div class="row-art"></div><div class="song-info"><div class="song-title">X</div><div class="song-sub">Y</div></div><div class="row-stars"></div><div class="row-actions"></div>';
    list.appendChild(probe);
    rowH = probe.offsetHeight || 68;
    list.removeChild(probe);
  }

  function render(force) {
    if (!rowH) measure();
    if (!rowH) return;
    const n = _songs.length;
    const sTop = wrap.scrollTop;
    const vH   = wrap.clientHeight || 500;
    const nF   = Math.max(0, Math.floor(sTop / rowH) - BUFS);
    const nL   = Math.min(n - 1, Math.ceil((sTop + vH) / rowH) + BUFS);
    if (!force && nF === fRow && nL === lRow) return;
    fRow = nF; lRow = nL;
    list.style.paddingTop    = `${fRow * rowH}px`;
    list.style.paddingBottom = `${Math.max(0, n - nL - 1) * rowH}px`;
    const html = [];
    for (let i = fRow; i <= nL; i++) html.push(rowHtml(_songs[i], i));
    list.innerHTML = html.join('');
    highlightRow();
  }

  // Event delegation — one listener handles all rows
  wrap.addEventListener('click', e => {
    const row = e.target.closest('.song-row');
    if (!row) return;
    const i = parseInt(row.dataset.ci);
    const s = _songs[i];
    if (!s) return;
    if      (e.target.closest('.add-btn'))      { e.stopPropagation(); Player.addSong(s); }
    else if (e.target.closest('.ctx-btn'))      { e.stopPropagation(); S.ctxSong = s; showCtxMenu(e.clientX, e.clientY); }
    else if (e.target.closest('.row-stars'))    { e.stopPropagation(); showRatePanel(e.clientX, e.clientY, s); }
    else                                          Player.queueAndPlay(s);
  });

  // Sort bar
  sortBar.addEventListener('click', e => {
    const pill = e.target.closest('.sort-pill');
    if (!pill) return;
    const key = pill.dataset.key;
    if (_sortKey === key) { _sortAsc = !_sortAsc; } else { _sortKey = key; _sortAsc = true; }
    _songs = allSongs.slice().sort((a, b) => {
      if (key === 'year') { const va = +a.year||0, vb = +b.year||0; return _sortAsc ? va - vb : vb - va; }
      const va = (a[key]||'').toString().toLowerCase();
      const vb = (b[key]||'').toString().toLowerCase();
      return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    sortBar.querySelectorAll('.sort-pill').forEach(p => {
      const active = p.dataset.key === _sortKey;
      p.classList.toggle('active', active);
      const lbl = p.dataset.key.charAt(0).toUpperCase() + p.dataset.key.slice(1);
      p.innerHTML = active ? `${lbl} <span class="sort-dir">${_sortAsc ? '↑' : '↓'}</span>` : lbl;
    });
    S.curSongs = _songs;
    const playBtn = document.getElementById('play-all-btn');
    const addBtn  = document.getElementById('add-all-btn');
    if (playBtn) playBtn.onclick = () => { if (_songs.length) { Player.setQueue(_songs, 0); toast(`Playing ${_songs.length} songs`); } };
    if (addBtn)  addBtn.onclick  = () => { if (_songs.length) { Player.addAll(_songs); } };
    fRow = -1; lRow = -1;
    wrap.scrollTop = 0;
    render(true);
  });

  let _rafS = false;
  wrap.addEventListener('scroll', () => {
    if (_rafS || !list.isConnected) return;
    _rafS = true;
    requestAnimationFrame(() => { _rafS = false; if (list.isConnected) render(false); });
  });
  const ro = new ResizeObserver(() => requestAnimationFrame(() => {
    if (!list.isConnected) { ro.disconnect(); return; }
    rowH = 0; fRow = -1; lRow = -1; render(true);
  }));
  ro.observe(wrap);

  S.curSongs = _songs;
  const playBtn = document.getElementById('play-all-btn');
  const addBtn  = document.getElementById('add-all-btn');
  if (playBtn) playBtn.onclick = () => { if (_songs.length) { Player.setQueue(_songs, 0); toast(`Playing ${_songs.length} songs`); } };
  if (addBtn)  addBtn.onclick  = () => { if (_songs.length) { Player.addAll(_songs); } };
  requestAnimationFrame(() => render(true));

  // Fetch art for unscanned files in the background; re-render each time a batch resolves
  const _missing = _songs.filter(s => !s['album-art'] && !s.isRadio && !s.isPodcast && s.filepath);
  if (_missing.length) {
    let _dirty = false;
    const _flushRender = () => { if (_dirty) { _dirty = false; fRow = -1; lRow = -1; render(true); } };
    _missing.forEach(s => {
      api('GET', `api/v1/files/art?fp=${encodeURIComponent(s.filepath)}`)
        .then(d => { if (d && d.aaFile) { s['album-art'] = d.aaFile; _dirty = true; } })
        .catch(() => {})
        .finally(_flushRender);
    });
  }
}

function _showSongsIn(songs, container) {
  _mountSongVScroll(songs, container);
}

// ── GENRE DETAIL VIEW (Albums + Tracks tabs) ─────────────────
async function viewGenreDetail(genre, defaultTab) {
  setTitle(genre); setBack(viewGenres); setNavActive('genres'); S.view = 'genres';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  let albums = [], songs = [];
  try {
    const [ar, sr] = await Promise.all([
      api('POST', 'api/v1/db/genre/albums', { genre }),
      api('POST', 'api/v1/db/genre/songs',  { genre })
    ]);
    albums = (ar && ar.albums) ? ar.albums : [];
    songs  = (sr || []).map(norm);
  } catch(e) {
    setBody('<div class="info-panel"><p class="info-hint">Failed to load.</p></div>'); return;
  }

  const tab = defaultTab || (albums.length > 0 ? 'albums' : 'tracks');

  function renderBrowse(activeTab, _fv) {
    _fv = _fv || '';
    const tA = activeTab === 'albums';
    const body = document.getElementById('content-body');
    body.classList.add('browse-mode');
    body.innerHTML = `
      <div class="browse-tabs">
        <div class="browse-tab-group">
          <button class="browse-tab${tA ? ' active' : ''}" data-tab="albums">Albums<span class="browse-cnt">${albums.length}</span></button>
          <button class="browse-tab${!tA ? ' active' : ''}" data-tab="tracks">Tracks<span class="browse-cnt">${songs.length}</span></button>
        </div>
        <div class="browse-filter-wrap">
          <input id="browse-filter" class="browse-filter-input" placeholder="Filter…" autocomplete="off" spellcheck="false">
          <button class="browse-filter-clear${_fv ? '' : ' hidden'}" id="browse-filter-clear" title="Clear">×</button>
        </div>
      </div>
      <div id="browse-content"></div>`;
    const bc   = document.getElementById('browse-content');
    const fInp = document.getElementById('browse-filter');
    const fClr = document.getElementById('browse-filter-clear');
    fInp.value = _fv;
    function applyContent() {
      const q = fInp.value.trim().toLowerCase();
      fClr.classList.toggle('hidden', !q);
      bc.innerHTML = '';
      bc.classList.remove('tracks-mode');
      if (tA) {
        const fa = q ? albums.filter(a => [(a.name||''),(a.artist||'')].some(v => v.toLowerCase().includes(q))) : albums;
        if (!fa.length) { bc.innerHTML = `<div class="info-panel"><p class="info-hint">${q ? `No albums match "${esc(q)}".` : 'No albums found — try Tracks.'}</p></div>`; return; }
        _mountAlbumVScroll(fa,
          (a, i) => {
            const u   = artUrl(a.album_art_file, 's');
            const art = u ? `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">` : noArtHtml();
            return `<div class="album-card" data-i="${i}">
              <div class="album-art">${art}<div class="play-ov"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></div></div>
              <div class="album-info"><div class="album-name">${esc(a.name)}</div><div class="album-meta">${esc(a.artist||'')}${a.year ? ' · ' + a.year : ''}</div></div>
            </div>`;
          },
          (a) => viewAlbumSongs(a.name, a.artist || undefined, () => viewGenreDetail(genre, 'albums')),
          bc
        );
      } else {
        const fs = q ? songs.filter(s => [(s.title||''),(s.artist||''),(s.album||'')].some(v => v.toLowerCase().includes(q))) : songs;
        if (!fs.length) { bc.innerHTML = `<div class="info-panel"><p class="info-hint">${q ? `No tracks match "${esc(q)}".` : 'No tracks found.'}</p></div>`; return; }
        _showSongsIn(fs, bc);
      }
    }
    body.querySelectorAll('.browse-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        renderBrowse(btn.dataset.tab, fInp.value);
      });
    });
    fInp.addEventListener('input', applyContent);
    fClr.addEventListener('click', () => { fInp.value = ''; fInp.dispatchEvent(new Event('input')); fInp.focus(); });
    applyContent();
  }

  renderBrowse(tab);
}

// ── DECADE DETAIL VIEW (Albums + Tracks tabs) ─────────────────
async function viewDecadeDetail(decade, label, defaultTab) {
  setTitle(label || `${decade}s`); setBack(viewDecades); setNavActive('decades'); S.view = 'decades';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  let albums = [], songs = [];
  try {
    const [ar, sr] = await Promise.all([
      api('POST', 'api/v1/db/decade/albums', { decade }),
      api('POST', 'api/v1/db/decade/songs',  { decade })
    ]);
    albums = (ar && ar.albums) ? ar.albums : [];
    songs  = (sr || []).map(norm);
  } catch(e) {
    setBody('<div class="info-panel"><p class="info-hint">Failed to load.</p></div>'); return;
  }

  const tab = defaultTab || (albums.length > 0 ? 'albums' : 'tracks');

  function renderBrowse(activeTab, _fv) {
    _fv = _fv || '';
    const tA = activeTab === 'albums';
    const body = document.getElementById('content-body');
    body.classList.add('browse-mode');
    body.innerHTML = `
      <div class="browse-tabs">
        <div class="browse-tab-group">
          <button class="browse-tab${tA ? ' active' : ''}" data-tab="albums">Albums<span class="browse-cnt">${albums.length}</span></button>
          <button class="browse-tab${!tA ? ' active' : ''}" data-tab="tracks">Tracks<span class="browse-cnt">${songs.length}</span></button>
        </div>
        <div class="browse-filter-wrap">
          <input id="browse-filter" class="browse-filter-input" placeholder="Filter…" autocomplete="off" spellcheck="false">
          <button class="browse-filter-clear${_fv ? '' : ' hidden'}" id="browse-filter-clear" title="Clear">×</button>
        </div>
      </div>
      <div id="browse-content"></div>`;
    const bc   = document.getElementById('browse-content');
    const fInp = document.getElementById('browse-filter');
    const fClr = document.getElementById('browse-filter-clear');
    fInp.value = _fv;
    function applyContent() {
      const q = fInp.value.trim().toLowerCase();
      fClr.classList.toggle('hidden', !q);
      bc.innerHTML = '';
      bc.classList.remove('tracks-mode');
      if (tA) {
        const fa = q ? albums.filter(a => [(a.name||''),(a.artist||'')].some(v => v.toLowerCase().includes(q))) : albums;
        if (!fa.length) { bc.innerHTML = `<div class="info-panel"><p class="info-hint">${q ? `No albums match "${esc(q)}".` : 'No albums found — try Tracks.'}</p></div>`; return; }
        _mountAlbumVScroll(fa,
          (a, i) => {
            const u   = artUrl(a.album_art_file, 's');
            const art = u ? `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">` : noArtHtml();
            return `<div class="album-card" data-i="${i}">
              <div class="album-art">${art}<div class="play-ov"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></div></div>
              <div class="album-info"><div class="album-name">${esc(a.name)}</div><div class="album-meta">${esc(a.artist||'')}${a.year ? ' · ' + a.year : ''}</div></div>
            </div>`;
          },
          (a) => viewAlbumSongs(a.name, a.artist || undefined, () => viewDecadeDetail(decade, label, 'albums')),
          bc
        );
      } else {
        const fs = q ? songs.filter(s => [(s.title||''),(s.artist||''),(s.album||'')].some(v => v.toLowerCase().includes(q))) : songs;
        if (!fs.length) { bc.innerHTML = `<div class="info-panel"><p class="info-hint">${q ? `No tracks match "${esc(q)}".` : 'No tracks found.'}</p></div>`; return; }
        _showSongsIn(fs, bc);
      }
    }
    body.querySelectorAll('.browse-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        renderBrowse(btn.dataset.tab, fInp.value);
      });
    });
    fInp.addEventListener('input', applyContent);
    fClr.addEventListener('click', () => { fInp.value = ''; fInp.dispatchEvent(new Event('input')); fInp.focus(); });
    applyContent();
  }

  renderBrowse(tab);
}


// ── SMART PLAYLIST ─────────────────────────────────────────────

function _splDefaultFilters() {
  return { genres: [], yearFrom: null, yearTo: null, minRating: 0, playedStatus: 'any', minPlayCount: 0, starred: false, artistSearch: '', selectedVpaths: [], freshPicks: false };
}

// State for the builder
let _splFilters = _splDefaultFilters();
let _splSort = 'random';
let _splLimit = 100;
let _splEditId = null;
let _splEditName = null;
let _splCountTimer = null;

async function loadSmartPlaylists() {
  try {
    S.smartPlaylists = (await api('GET', 'api/v1/smart-playlists')).playlists || [];
  } catch(_) { S.smartPlaylists = []; }
  _renderSmartPlaylistNav();
}

function _renderSmartPlaylistNav() {
  const nav = document.getElementById('smart-playlist-nav');
  if (!nav) return;
  const list = S.smartPlaylists || [];
  if (!list.length) { nav.innerHTML = '<div class="pl-empty-hint">No smart playlists yet</div>'; return; }
  nav.innerHTML = list.map(p => `
    <div class="pl-row" data-splid="${p.id}">
      <button class="pl-row-btn" data-splid="${p.id}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/></svg>
        ${p.filters?.freshPicks ? '<svg class="pl-fresh-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" title="Fresh Picks"><polyline points="17,1 21,5 17,9"/><path d="M3,11V9a4,4,0,0,1,4-4h14"/><polyline points="7,23 3,19 7,15"/><path d="M21,13v2a4,4,0,0,1-4,4H3"/></svg>' : ''}
        ${esc(p.name)}
      </button>
      <button class="pl-row-edit" data-splid="${p.id}" title="Edit">✎</button>
      <button class="pl-row-del" data-splid="${p.id}" title="Delete">×</button>
    </div>`).join('');

  nav.querySelectorAll('.pl-row-btn').forEach(btn => {
    btn.addEventListener('click', () => _runSavedSmartPlaylist(parseInt(btn.dataset.splid, 10)));
  });
  nav.querySelectorAll('.pl-row-edit').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.splid, 10);
      const pl = (S.smartPlaylists || []).find(p => p.id === id);
      if (!pl) return;
      _splFilters = pl.filters ? JSON.parse(JSON.stringify(pl.filters)) : _splDefaultFilters();
      if (!Array.isArray(_splFilters.selectedVpaths)) _splFilters.selectedVpaths = [];
      if (typeof _splFilters.freshPicks !== 'boolean') _splFilters.freshPicks = false;
      _splSort = pl.sort || 'random';
      _splLimit = pl.limit || 100;
      _splEditId = id;
      _splEditName = pl.name;
      viewSmartPlaylists();
    });
  });
  nav.querySelectorAll('.pl-row-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.splid, 10);
      const pl = (S.smartPlaylists || []).find(p => p.id === id);
      showConfirmModal(`Delete smart playlist "${pl?.name || id}"?`, 'This cannot be undone.', async () => {
        try {
          await api('DELETE', `api/v1/smart-playlists/${id}`);
          await loadSmartPlaylists();
          toast('Deleted');
        } catch(_) { toast('Failed to delete'); }
      });
    });
  });
}

async function _runSavedSmartPlaylist(id) {
  const pl = (S.smartPlaylists || []).find(p => p.id === id);
  if (!pl) return;
  setTitle(pl.name); setBack(null); S.view = 'smart-playlist:' + id; setSplActive(id);
  setBody('<div class="loading-state"></div>');
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  try {
    const effectiveSort = pl.filters?.freshPicks ? 'random' : pl.sort;
    const d = await api('POST', 'api/v1/smart-playlists/run', { filters: pl.filters, sort: effectiveSort, limit: pl.limit_n });
    _viewSmartPlaylistResults(d.songs, pl.name, id, pl.filters, pl.sort, pl.limit_n);
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function _viewSmartPlaylistResults(songs, name, splId, filters, sort, limitN) {
  const mapped = (songs || []).map(norm);
  S.curSongs = mapped;
  const title = name || 'Smart Playlist';
  setTitle(title);
  const _splTitle = name || 'Smart Playlist';
  document.getElementById('play-all-btn').onclick = () => {
    if (mapped.length) { _setPlaySource('smart-playlist', _splTitle); Player.setQueue(mapped, 0); toast(`Playing ${mapped.length} songs`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (mapped.length) { Player.addAll(mapped); }
  };

  const editBtn = `<button class="spl-edit-btn" id="spl-result-edit-btn">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    Edit filter</button>`;
  const reshuffleBtn = (filters?.freshPicks && splId)
    ? `<button class="spl-reshuffle-btn" id="spl-reshuffle-btn" title="Get a new random selection">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17,1 21,5 17,9"/><path d="M3,11V9a4,4,0,0,1,4-4h14"/><polyline points="7,23 3,19 7,15"/><path d="M21,13v2a4,4,0,0,1-4,4H3"/></svg>
        New picks</button>`
    : '';

  if (!mapped.length) {
    setBody(`<div class="empty-state"><p>No songs match this filter.</p>${editBtn}${reshuffleBtn}</div>`);
  } else {
    const body = document.getElementById('content-body');
    body.innerHTML = `<div class="spl-result-header">${editBtn}${reshuffleBtn}</div><div class="song-list">${renderSongRows(mapped)}</div>`;
    attachSongListEvents(body, mapped);
    highlightRow();
  }

  document.getElementById('spl-reshuffle-btn')?.addEventListener('click', () => _runSavedSmartPlaylist(splId));
  document.getElementById('spl-result-edit-btn')?.addEventListener('click', () => {
    _splFilters = filters ? JSON.parse(JSON.stringify(filters)) : _splDefaultFilters();
    if (!Array.isArray(_splFilters.selectedVpaths)) _splFilters.selectedVpaths = [];
    if (typeof _splFilters.freshPicks !== 'boolean') _splFilters.freshPicks = false;
    // Backward compat: old saved playlists may have ignoreVPaths instead of selectedVpaths
    if (_splFilters.ignoreVPaths && _splFilters.ignoreVPaths.length > 0 && _splFilters.selectedVpaths.length === 0) {
      _splFilters.selectedVpaths = _musicVpaths().filter(v => !_splFilters.ignoreVPaths.includes(v));
    }
    delete _splFilters.ignoreVPaths;
    _splSort = sort || 'random';
    _splLimit = limitN || 100;
    _splEditId = splId || null;
    _splEditName = name || null;
    viewSmartPlaylists();
  });
}

async function viewSmartPlaylists(editData) {
  if (editData) {
    _splFilters = editData.filters ? JSON.parse(JSON.stringify(editData.filters)) : _splFilters;
    _splSort    = editData.sort    || _splSort;
    _splLimit   = editData.limit   || _splLimit;
    _splEditId  = editData.id      || null;
    _splEditName = editData.name   || null;
  }
  if (!Array.isArray(_splFilters.selectedVpaths)) _splFilters.selectedVpaths = [];
  if (typeof _splFilters.freshPicks !== 'boolean') _splFilters.freshPicks = false;

  S.view = 'smart-playlists';
  setBack(null);
  setTitle(_splEditId ? `Edit: ${_splEditName}` : 'New Smart Playlist');
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  S.curSongs = [];

  // Load genres — use genre-groups endpoint (server groups or fallback)
  let genres = [];
  let _splGenreGroups = null;
  try {
    const gd = await api('GET', 'api/v1/db/genre-groups');
    genres = (gd.genres || []).map(g => g.genre || g);
    _splGenreGroups = gd.groups || null;
  } catch(_) {}

  const SORTS = [
    { v: 'artist',      l: 'Artist / Album' },
    { v: 'album',       l: 'Album' },
    { v: 'year_asc',    l: 'Year ↑' },
    { v: 'year_desc',   l: 'Year ↓' },
    { v: 'rating',      l: 'Top Rated' },
    { v: 'play_count',  l: 'Most Played' },
    { v: 'last_played', l: 'Recently Played' },
    { v: 'random',      l: 'Random' },
  ];
  const LIMITS = [25, 50, 100, 200, 500, 1000];
  const RATING_OPTS = [
    { db: 0,  label: 'Any' },
    { db: 2,  label: '★' },
    { db: 4,  label: '★★' },
    { db: 6,  label: '★★★' },
    { db: 8,  label: '★★★★' },
    { db: 10, label: '★★★★★' },
  ];

  const f = _splFilters;
  if (!Array.isArray(f.selectedVpaths)) f.selectedVpaths = [];
  // Build grouped genre picker — use server groups if available, else GENRE_BUCKETS
  let _splSectionList;
  if (_splGenreGroups && _splGenreGroups.length > 0) {
    _splSectionList = _splGenreGroups.map(grp => ({ name: grp.name, genres: grp.genres.map(g => g.genre || g) }));
    // Any genre from allGenres not in a group
    const assigned = new Set(_splSectionList.flatMap(g => g.genres));
    const other = genres.filter(g => !assigned.has(g));
    if (other.length) _splSectionList.push({ name: 'Other', genres: other });
  } else {
    const _splBucketOrder = [...GENRE_BUCKETS.map(([l]) => l), 'Other'];
    const _splGrouped = {};
    for (const g of genres) { const cat = classifyGenre(g); (_splGrouped[cat] = _splGrouped[cat] || []).push(g); }
    _splSectionList = _splBucketOrder.filter(cat => _splGrouped[cat]).map(cat => ({ name: cat, genres: _splGrouped[cat] }));
  }
  const genreGroupsHTML = !genres.length ? '<span class="spl-hint">No genres found</span>' :
    _splSectionList.map(grp => {
      const chips = grp.genres;
      const activeCount = chips.filter(g => f.genres.includes(g)).length;
      const allActive = chips.length > 0 && activeCount === chips.length;
      const chipsHTML = chips.map(g => `<button class="spl-genre-chip${f.genres.includes(g) ? ' active' : ''}" data-genre="${esc(g)}">${esc(g)}</button>`).join('');
      return `<div class="spl-genre-group${activeCount === 0 ? ' collapsed' : ''}"><div class="spl-genre-group-head"><button class="spl-genre-group-select${allActive ? ' all-active' : ''}" data-genres='${JSON.stringify(chips).replace(/'/g, "&#39;")}'><span class="spl-genre-group-name">${esc(grp.name)}</span>${activeCount ? `<span class="spl-genre-group-badge">${activeCount}</span>` : ''}<span class="spl-genre-group-total">${chips.length}</span></button><button class="spl-genre-group-chevron-btn"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6,9 12,15 18,9"/></svg></button></div><div class="spl-genre-group-chips">${chipsHTML}</div></div>`;
    }).join('');
  const ratingBtns = RATING_OPTS.map(o => `<button class="spl-rating-opt${f.minRating === o.db ? ' active' : ''}" data-db="${o.db}">${o.label}</button>`).join('');
  const statusPills = ['any','never','played','at-least'].map(s => `<button class="spl-status-pill${(s === 'at-least' ? (f.playedStatus === 'played' && f.minPlayCount > 0 ? ' active' : '') : f.playedStatus === s ? ' active' : '')}" data-status="${s}">${s === 'any' ? 'Any' : s === 'never' ? 'Never played' : s === 'played' ? 'Played' : 'At least…'}</button>`).join('');
  const sortOpts = SORTS.map(o => `<option value="${o.v}"${_splSort === o.v ? ' selected' : ''}>${o.l}</option>`).join('');
  const limitOpts = LIMITS.map(n => `<option value="${n}"${_splLimit === n ? ' selected' : ''}>${n} songs</option>`).join('');

  setBody(`
    <div class="spl-builder">
      <div class="spl-section">
        <div class="spl-section-title">Genres <span class="spl-hint">(select multiple, or none for all)</span></div>
        <input type="text" id="spl-genre-search" class="spl-text-inp" placeholder="Search genres… e.g. disco, house, indie" style="margin-bottom:8px">
        <div class="spl-genre-groups" id="spl-genre-groups-wrap">${genreGroupsHTML}</div>
      </div>

      ${_musicVpaths().length > 1 ? `<div class="spl-section">
        <div class="spl-section-title">Libraries <span class="spl-hint">(deselect to exclude)</span></div>
        <div class="spl-vpath-pills" id="spl-vpaths">${_musicVpaths().map(v => `<button class="dj-vpath-pill${f.selectedVpaths.length === 0 || f.selectedVpaths.includes(v) ? ' on' : ''}" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')}</div>
      </div>` : ''}

      <div class="spl-section spl-row-2">
        <div>
          <div class="spl-section-title">Year range</div>
          <div class="spl-year-row">
            <input type="number" id="spl-year-from" class="spl-year-inp" placeholder="From" min="1000" max="9999" value="${f.yearFrom || ''}">
            <span class="spl-year-sep">–</span>
            <input type="number" id="spl-year-to"   class="spl-year-inp" placeholder="To"   min="1000" max="9999" value="${f.yearTo   || ''}">
          </div>
        </div>
        <div>
          <div class="spl-section-title">Minimum rating</div>
          <div class="spl-rating-row">${ratingBtns}</div>
        </div>
      </div>

      <div class="spl-section">
        <div class="spl-section-title">Play status</div>
        <div class="spl-status-pills">
          ${statusPills}
          <input type="number" id="spl-min-pc" class="spl-minpc-inp${f.minPlayCount > 0 ? '' : ' hidden'}" min="1" max="99999" value="${f.minPlayCount || 5}" placeholder="times">
        </div>
      </div>

      <div class="spl-section spl-row-2">
        <div>
          <div class="spl-section-title">Artist search</div>
          <input type="text" id="spl-artist-search" class="spl-text-inp" placeholder="e.g. Beatles" value="${esc(f.artistSearch || '')}">
        </div>
        <div class="spl-starred-wrap">
          <label class="spl-starred-label">
            <input type="checkbox" id="spl-starred-cb"${f.starred ? ' checked' : ''}> Starred only
          </label>
        </div>
      </div>

      <div class="spl-section spl-row-2">
        <div>
          <div class="spl-section-title">Sort by</div>
          <select id="spl-sort" class="spl-select">${sortOpts}</select>
        </div>
        <div>
          <div class="spl-section-title">Max songs</div>
          <select id="spl-limit" class="spl-select">${limitOpts}</select>
        </div>
      </div>

      <div class="spl-section spl-fresh-picks-section">
        <label class="spl-fresh-picks-label">
          <input type="checkbox" id="spl-fresh-picks"${f.freshPicks ? ' checked' : ''}>
          <div class="spl-fresh-picks-text">
            <span class="spl-fresh-picks-name">Fresh Picks</span>
            <span class="spl-hint">Shuffle on every open — different songs each time</span>
          </div>
        </label>
      </div>

      <div class="spl-actions">
        <span class="spl-match-count" id="spl-match-count">…</span>
        <button class="spl-btn-run" id="spl-run-btn">▶ Preview</button>
        <button class="spl-btn-save" id="spl-save-btn">${_splEditId ? 'Update' : 'Save'}</button>
      </div>
    </div>
  `);

  _splScheduleCount();

  // Genre group: clicking the header row (name button or chevron) expands/collapses — does NOT auto-select
  document.querySelectorAll('.spl-genre-group-chevron-btn, .spl-genre-group-select').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.spl-genre-group').classList.toggle('collapsed'));
  });

  // Genre search filter
  document.getElementById('spl-genre-search')?.addEventListener('input', function() {
    const terms = this.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    document.querySelectorAll('#spl-genre-groups-wrap .spl-genre-chip').forEach(c => {
      c.style.display = (!terms.length || terms.some(t => c.dataset.genre.toLowerCase().includes(t))) ? '' : 'none';
    });
    document.querySelectorAll('#spl-genre-groups-wrap .spl-genre-group').forEach(grp => {
      const hasVisible = [...grp.querySelectorAll('.spl-genre-chip')].some(c => c.style.display !== 'none');
      grp.style.display = hasVisible ? '' : 'none';
      if (hasVisible && terms.length) grp.classList.remove('collapsed');
    });
  });
  // Genre chips toggle
  document.querySelectorAll('.spl-genre-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const g = chip.dataset.genre;
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        if (!_splFilters.genres.includes(g)) _splFilters.genres.push(g);
      } else {
        _splFilters.genres = _splFilters.genres.filter(x => x !== g);
      }
      // Update active-count badge on the group header
      const group = chip.closest('.spl-genre-group');
      if (group) {
        const selectBtn = group.querySelector('.spl-genre-group-select');
        const groupChips = selectBtn ? JSON.parse(selectBtn.dataset.genres || '[]') : [];
        const n = group.querySelectorAll('.spl-genre-chip.active').length;
        let badge = selectBtn ? selectBtn.querySelector('.spl-genre-group-badge') : null;
        if (n && !badge && selectBtn) {
          badge = document.createElement('span');
          badge.className = 'spl-genre-group-badge';
          selectBtn.querySelector('.spl-genre-group-name').after(badge);
        }
        if (badge) { if (n) badge.textContent = n; else badge.remove(); }
        if (selectBtn) {
          if (groupChips.length > 0 && groupChips.every(g => _splFilters.genres.includes(g))) selectBtn.classList.add('all-active');
          else selectBtn.classList.remove('all-active');
        }
      }
      _splScheduleCount();
    });
  });

  // Year range
  document.getElementById('spl-year-from').addEventListener('input', e => {
    _splFilters.yearFrom = e.target.value ? parseInt(e.target.value, 10) : null;
    _splScheduleCount();
  });
  document.getElementById('spl-year-to').addEventListener('input', e => {
    _splFilters.yearTo = e.target.value ? parseInt(e.target.value, 10) : null;
    _splScheduleCount();
  });

  // Rating buttons
  document.querySelectorAll('.spl-rating-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.spl-rating-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _splFilters.minRating = parseInt(btn.dataset.db, 10);
      _splScheduleCount();
    });
  });

  // Play status pills
  document.querySelectorAll('.spl-status-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.spl-status-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const s = pill.dataset.status;
      const inp = document.getElementById('spl-min-pc');
      if (s === 'at-least') {
        _splFilters.playedStatus = 'played';
        _splFilters.minPlayCount = parseInt(inp?.value || 5, 10);
        inp?.classList.remove('hidden');
      } else {
        _splFilters.playedStatus = s;
        _splFilters.minPlayCount = 0;
        inp?.classList.add('hidden');
      }
      _splScheduleCount();
    });
  });
  document.getElementById('spl-min-pc')?.addEventListener('input', e => {
    _splFilters.minPlayCount = parseInt(e.target.value, 10) || 1;
    _splScheduleCount();
  });

  // Artist search
  document.getElementById('spl-artist-search').addEventListener('input', e => {
    _splFilters.artistSearch = e.target.value;
    _splScheduleCount();
  });

  // Starred checkbox
  document.getElementById('spl-starred-cb').addEventListener('change', e => {
    _splFilters.starred = e.target.checked;
    _splScheduleCount();
  });

  // Sort / limit
  document.getElementById('spl-sort').addEventListener('change', e => { _splSort = e.target.value; });
  document.getElementById('spl-limit').addEventListener('change', e => { _splLimit = parseInt(e.target.value, 10); });

  // Fresh Picks toggle
  document.getElementById('spl-fresh-picks')?.addEventListener('change', e => {
    _splFilters.freshPicks = e.target.checked;
  });

  // Library (vpath) pills
  if (_musicVpaths().length > 1) {
    document.getElementById('spl-vpaths')?.addEventListener('click', e => {
      const btn = e.target.closest('.dj-vpath-pill');
      if (!btn) return;
      const v = btn.dataset.vpath;
      const mvps = _musicVpaths();
      // Normalise: empty selectedVpaths = all selected
      let sel = _splFilters.selectedVpaths.length === 0 ? [...mvps] : [..._splFilters.selectedVpaths];
      const idx = sel.indexOf(v);
      if (idx === -1) {
        sel.push(v);
      } else if (sel.length > 1) {
        sel.splice(idx, 1);
      } else {
        return; // prevent deselecting last
      }
      // If all selected, collapse back to empty (= all)
      _splFilters.selectedVpaths = sel.length === mvps.length ? [] : sel;
      // Re-render pills
      document.querySelectorAll('#spl-vpaths .dj-vpath-pill').forEach(p => {
        p.classList.toggle('on', _splFilters.selectedVpaths.length === 0 || _splFilters.selectedVpaths.includes(p.dataset.vpath));
      });
      _splScheduleCount();
    });
  }

  // Preview (run without saving) — honor freshPicks in preview too
  document.getElementById('spl-run-btn').addEventListener('click', async () => {
    const btn = document.getElementById('spl-run-btn');
    btn.disabled = true;
    try {
      const effectiveSort = _splFilters.freshPicks ? 'random' : _splSort;
      const d = await api('POST', 'api/v1/smart-playlists/run', { filters: _splFilters, sort: effectiveSort, limit: _splLimit });
      _viewSmartPlaylistResults(d.songs, _splEditName || 'Preview', _splEditId, _splFilters, _splSort, _splLimit);
    } catch(e) { toast('Error: ' + e.message); }
    finally { btn.disabled = false; }
  });

  // Save
  document.getElementById('spl-save-btn').addEventListener('click', async () => {
    if (_splEditId) {
      // Update existing
      try {
        await api('PUT', `api/v1/smart-playlists/${_splEditId}`, { name: _splEditName, filters: _splFilters, sort: _splSort, limit: _splLimit });
        await loadSmartPlaylists();
        toast(`"${_splEditName}" updated`);
        // Re-run to show results, honouring Fresh Picks
        const effectiveSort = _splFilters.freshPicks ? 'random' : _splSort;
        const d = await api('POST', 'api/v1/smart-playlists/run', { filters: _splFilters, sort: effectiveSort, limit: _splLimit });
        _viewSmartPlaylistResults(d.songs, _splEditName, _splEditId, _splFilters, _splSort, _splLimit);
      } catch(e) { toast('Error: ' + e.message); }
    } else {
      // Ask for name
      document.getElementById('spl-save-modal-title').textContent = 'Save Smart Playlist';
      document.getElementById('spl-save-name').value = '';
      showModal('spl-save-modal');
      setTimeout(() => document.getElementById('spl-save-name').focus(), 50);
    }
  });
}

function _splScheduleCount() {
  clearTimeout(_splCountTimer);
  _splCountTimer = setTimeout(async () => {
    const el = document.getElementById('spl-match-count');
    if (!el) return;
    el.textContent = '…';
    try {
      const d = await api('POST', 'api/v1/smart-playlists/count', { filters: _splFilters });
      if (document.getElementById('spl-match-count')) {
        document.getElementById('spl-match-count').textContent = `${d.count} song${d.count !== 1 ? 's' : ''} match`;
      }
    } catch(_) { if (document.getElementById('spl-match-count')) document.getElementById('spl-match-count').textContent = ''; }
  }, 500);
}


function viewTranscode() {
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const info = S.transInfo;
  if (!info || !info.serverEnabled) {
    setBody(`
      <div class="info-panel">
        <div class="info-panel-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 8.5h9l-9 9v11l20-20h11l-31 31h11l20-20v11l-9 9h9"/>
          </svg>
        </div>
        <h2>Transcoding</h2>
        <p class="info-hint">Transcoding is not enabled on this server. Ask your server admin to enable it in the config.</p>
      </div>`);
    return;
  }

  setBody(`
    <div class="settings-panel">
      <div class="settings-section-title">Transcode Settings</div>
      <p class="settings-desc">Stream audio converted on-the-fly to reduce bandwidth. Server default: <strong>${esc(info.defaultCodec || '—')} / ${esc(info.defaultBitrate || '—')}</strong>.</p>
      <div class="settings-row settings-row-toggle">
        <span class="settings-label">Enable Transcoding</span>
        <label class="toggle-sw">
          <input type="checkbox" id="tc-enable" ${S.transEnabled ? 'checked' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
      <div id="tc-opts" class="settings-opts${S.transEnabled ? '' : ' dimmed'}">
        <div class="settings-row">
          <label class="settings-label" for="tc-codec">Codec</label>
          <select class="settings-select" id="tc-codec">
            <option value="">Default (${esc(info.defaultCodec || 'server')})</option>
            <option value="opus" ${S.transCodec==='opus'?'selected':''}>Opus / OGG</option>
            <option value="mp3"  ${S.transCodec==='mp3' ?'selected':''}>MP3</option>
            <option value="aac"  ${S.transCodec==='aac' ?'selected':''}>AAC</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="tc-bitrate">Bitrate</label>
          <select class="settings-select" id="tc-bitrate">
            <option value="">Default (${esc(info.defaultBitrate || 'server')})</option>
            <option value="64k"  ${S.transBitrate==='64k' ?'selected':''}>64 kbps</option>
            <option value="96k"  ${S.transBitrate==='96k' ?'selected':''}>96 kbps</option>
            <option value="128k" ${S.transBitrate==='128k'?'selected':''}>128 kbps</option>
            <option value="192k" ${S.transBitrate==='192k'?'selected':''}>192 kbps</option>
          </select>
        </div>
      </div>
    </div>`);

  const optsEl = document.getElementById('tc-opts');
  document.getElementById('tc-enable').onchange = e => {
    S.transEnabled = e.target.checked;
    S.transEnabled ? localStorage.setItem(_uKey('trans'), '1') : localStorage.removeItem(_uKey('trans'));
    _syncPrefs();
    optsEl.classList.toggle('dimmed', !S.transEnabled);
    // Reload current song with new URL scheme
    if (S.queue[S.idx]) {
      const t = audioEl.currentTime, playing = !audioEl.paused;
      audioEl.src = mediaUrl(S.queue[S.idx].filepath);
      audioEl.currentTime = t;
      if (playing) audioEl.play().catch(() => {});
    }
    toast(S.transEnabled ? 'Transcoding enabled' : 'Transcoding disabled');
  };
  document.getElementById('tc-codec').onchange = e => {
    S.transCodec = e.target.value;
    e.target.value ? localStorage.setItem(_uKey('trans_codec'), e.target.value) : localStorage.removeItem(_uKey('trans_codec'));
    _syncPrefs();
  };
  document.getElementById('tc-bitrate').onchange = e => {
    S.transBitrate = e.target.value;
    e.target.value ? localStorage.setItem(_uKey('trans_bitrate'), e.target.value) : localStorage.removeItem(_uKey('trans_bitrate'));
    _syncPrefs();
  };
  // Clean up legacy algo key
  localStorage.removeItem(_uKey('trans_algo'));
}

// ── JUKEBOX ───────────────────────────────────────────────────
function viewJukebox() {
  setTitle('Jukebox'); setBack(null); setNavActive('jukebox'); S.view = 'jukebox';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  if (S.jukeCode && S.jukeWs && S.jukeWs.readyState === WebSocket.OPEN) {
    _renderJukeboxActive(S.jukeCode);
    return;
  }

  setBody(`
    <div class="info-panel">
      <div class="info-panel-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15.5 1h-8A2.5 2.5 0 0 0 5 3.5v17A2.5 2.5 0 0 0 7.5 23h8a2.5 2.5 0 0 0 2.5-2.5v-17A2.5 2.5 0 0 0 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/></svg>
      </div>
      <h2>Jukebox Mode</h2>
      <p class="info-hint">Control this player from another device on the same network. Click Connect to generate a shareable remote-control link.</p>
      <button class="btn-primary" id="juke-connect-btn">Connect</button>
    </div>`);

  document.getElementById('juke-connect-btn').onclick = _connectJukebox;
}

function _pushJukeboxState() {
  if (!S.jukeCode) return;
  const song = S.queue[S.idx] || null;
  const safeIdx = Math.max(0, S.idx || 0);
  fetch('/api/v1/jukebox/update-now-playing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: S.jukeCode, nowPlaying: {
      title: song?.title||null, artist: song?.artist||null, album: song?.album||null,
      albumArt: song?.['album-art']||null, filepath: song?.filepath||null,
      currentTime: audioEl.currentTime||0, duration: audioEl.duration||0, playing: !audioEl.paused,
    }}),
  }).catch(() => {});
  const tracks = S.queue.map(s => ({ title: s.title||null, artist: s.artist||null, album: s.album||null, 'album-art': s['album-art']||null, filepath: s.filepath }));
  fetch('/api/v1/jukebox/update-playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: S.jukeCode, tracks, idx: safeIdx }),
  }).catch(() => {});
}

function _connectJukebox() {
  const btn = document.getElementById('juke-connect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/?token=${S.token}`);

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      // Initial handshake — server sends back the code
      if (msg.code && !S.jukeCode) {
        S.jukeCode = msg.code;
        S.jukeWs = ws;
        if (S.view === 'jukebox') _renderJukeboxActive(msg.code);
        // Proactive push: send state immediately and every 4 s
        clearInterval(S._jukePushInterval);
        S._jukePushInterval = setInterval(_pushJukeboxState, 4000);
        _pushJukeboxState();
        audioEl.addEventListener('play',  _pushJukeboxState);
        audioEl.addEventListener('pause', _pushJukeboxState);
      }
      // Remote commands
      if (msg.command) {
        if      (msg.command === 'next')      Player.next();
        else if (msg.command === 'previous')  Player.prev();
        else if (msg.command === 'playPause') Player.toggle();
        else if (msg.command === 'addSong' && msg.file) {
          // Always fetch metadata so the filepath is resolved through the DB
          // (parent-vpath lookup). Child vpaths with spaces in their name
          // (e.g. "Unidisc 12-inch classics") produce 404s when used raw because
          // Express.static literal-space mounts don't match percent-encoded URLs.
          api('POST', 'api/v1/db/metadata', { filepath: msg.file })
            .then(meta => Player.addSong(norm(meta)))
            .catch(() => Player.addSong({ filepath: msg.file, title: msg.file.split('/').pop() }));
        }
        else if (msg.command === 'removeSong') {
          const idx = parseInt(msg.file, 10);
          if (!isNaN(idx) && idx >= 0 && idx < S.queue.length) {
            S.queue.splice(idx, 1);
            if (S.idx > idx) S.idx--;
            else if (S.idx === idx) S.idx = Math.min(S.idx, S.queue.length - 1);
            persistQueue();
            refreshQueueUI();
          }
        }
        else if (msg.command === 'goToSong') {
          const idx = parseInt(msg.file, 10);
          if (!isNaN(idx) && idx >= 0 && idx < S.queue.length) {
            Player.playAt(idx);
          }
        }
        else if (msg.command === 'getPlaylist') {
          const tracks = S.queue.map(s => ({ title: s.title||null, artist: s.artist||null, album: s.album||null, 'album-art': s['album-art']||null, filepath: s.filepath }));
          fetch('/api/v1/jukebox/update-playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: S.jukeCode, tracks, idx: Math.max(0, S.idx || 0) }),
          }).catch(() => {});
        }
        else if (msg.command === 'getNowPlaying') {
          const song = S.queue[S.idx] || null;
          fetch('/api/v1/jukebox/update-now-playing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: S.jukeCode, nowPlaying: {
              title: song?.title||null, artist: song?.artist||null, album: song?.album||null,
              albumArt: song?.['album-art']||null, filepath: song?.filepath||null,
              currentTime: audioEl.currentTime||0, duration: audioEl.duration||0, playing: !audioEl.paused,
            }}),
          }).catch(() => {});
        }
      }
    } catch(_) {}
  };

  ws.onerror = () => {
    toast('Jukebox connection failed');
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  };

  ws.onclose = () => {
    clearInterval(S._jukePushInterval);
    S._jukePushInterval = null;
    audioEl.removeEventListener('play',  _pushJukeboxState);
    audioEl.removeEventListener('pause', _pushJukeboxState);
    S.jukeCode = null; S.jukeWs = null;
    if (S.view === 'jukebox') viewJukebox();
  };
}

function _renderJukeboxActive(code) {
  const url = `${location.protocol}//${location.host}/remote/${code}`;

  // Generate QR code locally — no external service needed
  let qrSvg = '';
  try {
    const QRC = qrcodegen.QrCode;
    const qr  = QRC.encodeText(url, QRC.Ecc.MEDIUM);
    // toSvgString(border) returns a full <svg> string
    const raw = qr.toSvgString(2);
    // Keep black-on-white — QR scanners need high contrast; add a white
    // background so it looks correct in dark mode too.
    qrSvg = raw
      .replace('<svg ', '<svg width="180" height="180" style="border-radius:8px;background:#fff;padding:4px;box-sizing:content-box;" ');
  } catch(e) {
    qrSvg = `<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;background:var(--raised);border-radius:8px;color:var(--t3);font-size:12px">QR unavailable</div>`;
  }

  setBody(`
    <div class="jukebox-panel">
      <div class="jukebox-header">
        <div class="jukebox-live-dot"></div>
        <h2>Jukebox Active</h2>
      </div>
      <p class="jukebox-hint">Scan the QR code or share the link to control this player from another device.</p>
      ${qrSvg}
      <div class="jukebox-code-row">
        <span class="jukebox-code-label">Code</span>
        <strong class="jukebox-code-val">${esc(code)}</strong>
      </div>
      <div style="display:flex;align-items:center;gap:8px;max-width:100%">
        <a class="jukebox-url" href="${esc(url)}" target="_blank" rel="noopener" style="flex:1;min-width:0">${esc(url)}</a>
        <button class="btn-ghost" id="juke-copy-btn" style="flex-shrink:0;padding:6px 12px;font-size:12px">Copy</button>
      </div>
      <button class="btn-ghost jukebox-disc" id="juke-disc-btn">Disconnect</button>
    </div>`);

  document.getElementById('juke-copy-btn').onclick = () => {
    navigator.clipboard.writeText(url).then(() => toast('Link copied!')).catch(() => {
      // Fallback for insecure contexts
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Link copied!');
    });
  };

  document.getElementById('juke-disc-btn').onclick = () => {
    S.jukeWs?.close();
    S.jukeWs = null; S.jukeCode = null;
    viewJukebox();
  };
}

// ── APPS ──────────────────────────────────────────────────────
function viewApps() {
  setTitle('Mobile Apps'); setBack(null); setNavActive('apps'); S.view = 'apps';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  setBody(`
    <div class="apps-panel">
      <h2>Mobile Apps</h2>
      <p class="apps-desc">Listen to your music on the go with the official mStream apps.</p>
      <div class="apps-grid">
        <a class="app-card" href="https://play.google.com/store/apps/details?id=mstream.music" target="_blank" rel="noopener">
          <svg class="app-card-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3.18 23.76A1.51 1.51 0 0 1 2 22.36V1.64A1.51 1.51 0 0 1 3.18.24L13.6 12 3.18 23.76zM16.2 9.06l-2.58-2.58L5.8 1.68l8.37 4.83 2.03 2.55zm1.94 1.81L16.2 9.06 14.6 12l1.6 2.94 1.94-1.13a.97.97 0 0 0 0-1.94zM5.8 22.32l7.82-4.8-2.03-2.55-5.79 7.35z"/></svg>
          <div>
            <div class="app-card-title">Android</div>
            <div class="app-card-sub">Get it on Google Play</div>
          </div>
        </a>
        <a class="app-card" href="https://apps.apple.com/us/app/mstream-player/id1605378892" target="_blank" rel="noopener">
          <svg class="app-card-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
          <div>
            <div class="app-card-title">iOS</div>
            <div class="app-card-sub">Download on the App Store</div>
          </div>
        </a>
      </div>
      <div class="apps-qr-section">
        <h3>Add this server to the app</h3>
        <p>Use the QR code tool to quickly connect a mobile device to this server.</p>
        <a class="btn-primary" href="/qr" target="_blank" rel="noopener">Open QR Tool</a>
      </div>
    </div>`);
}

// ── PLAY HISTORY VIEW ────────────────────────────────────────
function viewPlayHistory() {
  setTitle('Play History'); setBack(null); setNavActive('play-history'); S.view = 'play-history';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🏆</div>
          <div>
            <div class="playback-section-title">Most Played</div>
            <div class="playback-section-desc">Reset all play-count statistics to zero. The Most Played list will be empty until songs are played again.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Play counts</div>
            <div class="playback-row-hint">Clears the play-count number on every song</div>
          </div>
          <button class="btn-danger" id="reset-play-counts-btn">Reset</button>
        </div>
      </div>
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🕐</div>
          <div>
            <div class="playback-section-title">Recently Played</div>
            <div class="playback-section-desc">Reset all last-played timestamps. The Recently Played list will be empty until songs are played again.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Last-played timestamps</div>
            <div class="playback-row-hint">Clears the date each song was last played</div>
          </div>
          <button class="btn-danger" id="reset-recently-played-btn">Reset</button>
        </div>
      </div>
    </div>`);

  document.getElementById('reset-play-counts-btn').addEventListener('click', () => {
    showConfirmModal(
      'Reset Most Played',
      'All play counts will be set to zero. This cannot be undone.',
      async () => {
        try {
          await api('POST', 'api/v1/db/stats/reset-play-counts', {});
          toast('\u2713 Most Played counts reset');
        } catch(e) { toast(`Error: ${esc(e.message)}`); }
      }
    );
  });

  document.getElementById('reset-recently-played-btn').addEventListener('click', () => {
    showConfirmModal(
      'Reset Recently Played',
      'All last-played timestamps will be cleared. This cannot be undone.',
      async () => {
        try {
          await api('POST', 'api/v1/db/stats/reset-recently-played', {});
          toast('\u2713 Recently Played history reset');
        } catch(e) { toast(`Error: ${esc(e.message)}`); }
      }
    );
  });
}

// ── YOUR STATS (Wrapped) VIEW ─────────────────────────────────────────────────
// Module-level state for the period picker so navigating away and back restores position
let _wrappedPeriod = 'monthly';
let _wrappedOffset = 0;

async function viewWrapped() {
  setTitle('Your Stats'); setBack(null); setNavActive('wrapped'); S.view = 'wrapped';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  _renderWrapped();
}

async function _renderWrapped() {
  if (S.view !== 'wrapped') return;

  setBody(`<div class="loading-state"></div>`);

  let stats, periods;
  try {
    [stats, periods] = await Promise.all([
      api('GET', `api/v1/user/wrapped?period=${_wrappedPeriod}&offset=${_wrappedOffset}`),
      api('GET', 'api/v1/user/wrapped/periods'),
    ]);
  } catch(e) {
    setBody(`<div class="empty-state"><p>Could not load stats.</p></div>`);
    return;
  }
  if (S.view !== 'wrapped') return;

  // ── Period picker ──────────────────────────────────────────────────────────
  const periods_list = ['weekly','monthly','quarterly','half-yearly','yearly'];
  const periodTabs = periods_list.map(p =>
    `<button class="wrapped-period-tab${_wrappedPeriod === p ? ' active' : ''}" data-p="${p}">${_wrappedPeriodLabel(p)}</button>`
  ).join('');

  const canPrev = _wrappedOffset < -35;   // arbitrary hard limit
  const canNext = _wrappedOffset < 0;

  // ── Helper renderers ───────────────────────────────────────────────────────
  const fmtMs = ms => {
    if (!ms) return '0 min';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const pct = v => `${Math.round(v * 100)}%`;

  // Top songs list
  const topSongsHtml = stats.top_songs.length
    ? stats.top_songs.map((s, i) => `
        <div class="wrapped-top-row">
          <span class="wrapped-rank">${i + 1}</span>
          ${s.aaFile ? `<img class="wrapped-thumb" src="${esc(artUrl(s.aaFile,'s'))}" alt="" loading="lazy">` : `<div class="wrapped-thumb wrapped-thumb-empty"></div>`}
          <div class="wrapped-top-info">
            <div class="wrapped-top-title">${esc(s.title || s.hash)}</div>
            <div class="wrapped-top-sub">${esc(s.artist || '—')}</div>
          </div>
          <span class="wrapped-top-count">${s.play_count}×</span>
        </div>`).join('')
    : '<div class="wrapped-empty-section">No data yet</div>';

  // Top artists list
  const topArtistsHtml = stats.top_artists.length
    ? stats.top_artists.map((a, i) => `
        <div class="wrapped-top-row">
          <span class="wrapped-rank">${i + 1}</span>
          <div class="wrapped-top-info">
            <div class="wrapped-top-title">${esc(a.artist)}</div>
            <div class="wrapped-top-sub">${fmtMs(a.total_played_ms)} listened</div>
          </div>
          <span class="wrapped-top-count">${a.play_count}×</span>
        </div>`).join('')
    : '<div class="wrapped-empty-section">No data yet</div>';

  // Heatmap — 24 rows × 7 columns (hours × weekdays)
  const heatmapMax = Math.max(1, ...stats.listening_by_hour);
  const dayLabels  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const timeLabels = ['0h','3h','6h','9h','12h','15h','18h','21h'];

  // Build a 24×7 grid from per-hour and per-weekday data (approximated)
  // We only have 1D data from the server, so we show two separate 1D bar charts
  const hourBars = stats.listening_by_hour.map((c, h) => {
    if (c === 0) return `<div class="hr-bar-cell" title="${h}:00 — no plays"><div class="hr-bar-fill bar-zero"></div></div>`;
    const pct = Math.max(6, Math.round(c / heatmapMax * 100));
    return `<div class="hr-bar-cell" title="${h}:00 — ${c} play${c !== 1 ? 's' : ''}"><div class="hr-bar-fill bar-val" style="--bar-h:${pct}%"></div></div>`;
  }).join('');

  const wdMax = Math.max(1, ...stats.listening_by_weekday);
  const wdBars = stats.listening_by_weekday.map((c, d) => {
    if (c === 0) return `<div class="hm-wd-cell"><div class="hm-wd-bar bar-zero"></div><div class="hm-wd-label">${dayLabels[d]}</div></div>`;
    const pct = Math.max(8, Math.round(c / wdMax * 100));
    return `<div class="hm-wd-cell"><div class="hm-wd-bar bar-val" style="--bar-h:${pct}%"></div><div class="hm-wd-label">${dayLabels[d]}</div></div>`;
  }).join('');

  // Top listening day
  const topDayHtml = stats.top_listening_day
    ? `<div class="wrapped-fact-item">📅 Best day: <b>${esc(stats.top_listening_day.date)}</b> — ${fmtMs(stats.top_listening_day.total_listening_ms)}</div>`
    : '';

  // Fun facts
  const ff = stats.fun_facts;
  const funFactsHtml = [
    ff.top_song_hours ? `<div class="wrapped-fact-item">🎵 Top song <b>${esc(ff.top_song_hours.song || '')}</b> — ${ff.top_song_hours.hours}h total</div>` : '',
    ff.most_loyal_song ? `<div class="wrapped-fact-item">💪 Always finish: <b>${esc(ff.most_loyal_song.title || '')}</b> by ${esc(ff.most_loyal_song.artist || '')}</div>` : '',
    ff.most_skipped_artist ? `<div class="wrapped-fact-item">⏭ Most skipped: <b>${esc(ff.most_skipped_artist.artist)}</b> (${pct(ff.most_skipped_artist.skip_rate)} skip rate)</div>` : '',
    ff.most_replayed_song ? `<div class="wrapped-fact-item">🔁 Most replayed: <b>${esc(ff.most_replayed_song.title || '')}</b> — ${ff.most_replayed_song.replay_count}× in a row</div>` : '',
    ff.earliest_play ? `<div class="wrapped-fact-item">⏰ Earliest play: <b>${esc(ff.earliest_play)}</b></div>` : '',
    topDayHtml,
    stats.new_discoveries > 0 ? `<div class="wrapped-fact-item">🔭 New discoveries: <b>${stats.new_discoveries}</b> songs heard for the first time</div>` : '',
  ].filter(Boolean).join('') || '<div class="wrapped-empty-section">Play more music to unlock fun facts</div>';

  const noData = stats.total_plays === 0 && stats.radio.total_sessions === 0 && stats.podcast.episodes_played === 0;

  setBody(`
    <div class="wrapped-view">

      <div class="wrapped-period-bar">
        <div class="wrapped-period-tabs">${periodTabs}</div>
        <div class="wrapped-nav-row">
          <button class="wrapped-nav-btn" id="wr-prev" ${canPrev ? '' : 'disabled'}>&#8592; Earlier</button>
          <span class="wrapped-period-label">${esc(stats.period_label || '')}</span>
          <button class="wrapped-nav-btn" id="wr-next" ${canNext ? '' : 'disabled'}>Later &#8594;</button>
        </div>
      </div>

      ${noData ? `<div class="empty-state"><p>No listening data for this period yet.<br>Start playing music and come back!</p></div>` : `

      <div class="wrapped-summary-strip">
        <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.total_plays.toLocaleString()}</span><span class="wrapped-stat-lbl">plays</span></div>
        <div class="wrapped-stat"><span class="wrapped-stat-val">${fmtMs(stats.total_listening_ms)}</span><span class="wrapped-stat-lbl">listened</span></div>
        <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.unique_songs.toLocaleString()}</span><span class="wrapped-stat-lbl">unique songs</span></div>
        <div class="wrapped-stat"><span class="wrapped-stat-val">${(stats.pause_count ?? 0).toLocaleString()}</span><span class="wrapped-stat-lbl">pauses</span></div>
        <div class="wrapped-stat"><span class="wrapped-stat-val">${pct(stats.skip_rate)}</span><span class="wrapped-stat-lbl">skip rate</span></div>
        <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.library_coverage_pct.toFixed(1)}%</span><span class="wrapped-stat-lbl">library covered</span></div>
      </div>

      <div class="wrapped-grid">

        <div class="wrapped-card">
          <div class="wrapped-card-hdr">Top Songs</div>
          <div class="wrapped-top-list">${topSongsHtml}</div>
        </div>

        <div class="wrapped-card">
          <div class="wrapped-card-hdr">Top Artists</div>
          <div class="wrapped-top-list">${topArtistsHtml}</div>
        </div>

        <div class="wrapped-card wrapped-card-wide">
          <div class="wrapped-card-hdr">Listening by Hour</div>
          <div class="wrapped-hour-chart">${hourBars}</div>
          <div class="wrapped-hour-labels">
            ${[0,3,6,9,12,15,18,21].map(h => `<span>${h}h</span>`).join('')}
          </div>
        </div>

        <div class="wrapped-card">
          <div class="wrapped-card-hdr">Listening by Day</div>
          <div class="wrapped-wd-chart">${wdBars}</div>
        </div>

        <div class="wrapped-card">
          <div class="wrapped-card-hdr">Your Personality</div>
          <div class="wrapped-personality">
            <div class="wrapped-personality-type">${esc(stats.personality.type)}</div>
            <div class="wrapped-personality-desc">${esc(stats.personality.desc)}</div>
          </div>
          <div class="wrapped-completion-row">
            <div class="wrapped-completion-label">Completion rate <b>${pct(stats.completion_rate)}</b></div>
            <div class="wrapped-bar-track"><div class="wrapped-bar-fill" style="width:${pct(stats.completion_rate)}"></div></div>
          </div>
          ${stats.longest_session ? `<div class="wrapped-session-stat">Longest session: <b>${fmtMs(stats.longest_session.ended_at - stats.longest_session.started_at)}</b> · ${stats.longest_session.total_tracks} tracks</div>` : ''}
          ${stats.avg_session_length_ms ? `<div class="wrapped-session-stat">Avg session: <b>${fmtMs(stats.avg_session_length_ms)}</b></div>` : ''}
        </div>

        <div class="wrapped-card">
          <div class="wrapped-card-hdr">Fun Facts</div>
          <div class="wrapped-facts-list">${funFactsHtml}</div>
        </div>

        ${stats.radio.total_sessions > 0 ? `
        <div class="wrapped-card">
          <div class="wrapped-card-hdr">📻 Radio</div>
          <div class="wrapped-summary-strip" style="margin-bottom:.75rem">
            <div class="wrapped-stat"><span class="wrapped-stat-val">${fmtMs(stats.radio.total_ms)}</span><span class="wrapped-stat-lbl">listened</span></div>
            <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.radio.total_sessions.toLocaleString()}</span><span class="wrapped-stat-lbl">sessions</span></div>
            ${stats.radio.top_stations.length ? `<div class="wrapped-stat"><span class="wrapped-stat-val wrapped-stat-val--sm">${esc(stats.radio.top_stations[0].station_name)}</span><span class="wrapped-stat-lbl">favourite</span></div>` : ''}
          </div>
          ${stats.radio.top_stations.length > 1 ? `
          <div class="wrapped-top-list">
            ${stats.radio.top_stations.map((st, i) => `
              <div class="wrapped-top-row">
                <span class="wrapped-rank">${i + 1}</span>
                <div class="wrapped-top-info">
                  <div class="wrapped-top-title">${esc(st.station_name)}</div>
                  <div class="wrapped-top-sub">${st.sessions} session${st.sessions !== 1 ? 's' : ''}</div>
                </div>
                <span class="wrapped-top-count">${fmtMs(st.total_ms)}</span>
              </div>`).join('')}
          </div>` : ''}
        </div>` : ''}

        ${stats.podcast.episodes_played > 0 ? `
        <div class="wrapped-card">
          <div class="wrapped-card-hdr">🎙️ Podcasts</div>
          <div class="wrapped-summary-strip" style="margin-bottom:.75rem">
            <div class="wrapped-stat"><span class="wrapped-stat-val">${fmtMs(stats.podcast.total_ms)}</span><span class="wrapped-stat-lbl">listened</span></div>
            <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.podcast.episodes_played.toLocaleString()}</span><span class="wrapped-stat-lbl">episodes</span></div>
            <div class="wrapped-stat"><span class="wrapped-stat-val">${stats.podcast.shows_heard}</span><span class="wrapped-stat-lbl">shows</span></div>
            ${stats.podcast.episodes_completed > 0 ? `<div class="wrapped-stat"><span class="wrapped-stat-val">${Math.round(stats.podcast.episodes_completed / stats.podcast.episodes_played * 100)}%</span><span class="wrapped-stat-lbl">completed</span></div>` : ''}
          </div>
          ${stats.podcast.top_shows.length ? `
          <div class="wrapped-top-list">
            ${stats.podcast.top_shows.map((sh, i) => `
              <div class="wrapped-top-row">
                <span class="wrapped-rank">${i + 1}</span>
                ${sh.feed_img ? `<img class="wrapped-thumb" src="${esc(artUrl(sh.feed_img,'s'))}" alt="" loading="lazy">` : `<div class="wrapped-thumb wrapped-thumb-empty"></div>`}
                <div class="wrapped-top-info">
                  <div class="wrapped-top-title">${esc(sh.feed_title || '(Unknown)')}</div>
                  <div class="wrapped-top-sub">${sh.episodes_played} ep${sh.episodes_played !== 1 ? 's' : ''}</div>
                </div>
                <span class="wrapped-top-count">${fmtMs(sh.total_ms)}</span>
              </div>`).join('')}
          </div>` : ''}
        </div>` : ''}

      </div>
    `}
    </div>
  `);

  // Period tab clicks
  document.querySelectorAll('.wrapped-period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _wrappedPeriod = btn.dataset.p;
      _wrappedOffset = 0;
      _renderWrapped();
    });
  });
  document.getElementById('wr-prev')?.addEventListener('click', () => { _wrappedOffset--; _renderWrapped(); });
  document.getElementById('wr-next')?.addEventListener('click', () => { _wrappedOffset++; _renderWrapped(); });
}

function _wrappedPeriodLabel(p) {
  return { weekly: 'Week', monthly: 'Month', quarterly: 'Quarter', 'half-yearly': 'Half-Year', yearly: 'Year' }[p] || p;
}

// ── PLAYBACK VIEW ─────────────────────────────────────────────
// ── LAST.FM VIEW ───────────────────────────────────────────
async function viewLastFM() {
  setTitle('Last.fm'); setBack(null); setNavActive('lastfm'); S.view = 'lastfm';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  // Fetch current linked account
  let linkedUser = null;
  try { const d = await api('GET', 'api/v1/lastfm/status'); linkedUser = d.linkedUser; } catch(_) {}

  setBody(`
    <div class="playback-panel">

      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🎵</div>
          <div>
            <div class="playback-section-title">Your Last.fm Account</div>
            <div class="playback-section-desc">Link your Last.fm profile to scrobble every track you play on this server to your Last.fm history. Your password is never stored — it is used once to obtain a session key from Last.fm, and only that key is saved.</div>
          </div>
        </div>

        <div id="lfm-connected" class="${linkedUser ? '' : 'hidden'}">
          <div class="playback-row">
            <div class="playback-row-label">
              <div class="playback-row-name">Connected as: <span id="lfm-current-user">${esc(linkedUser || '')}</span></div>
            </div>
            <button class="btn-danger" id="lfm-disconnect-btn">Disconnect</button>
          </div>
        </div>

        <div id="lfm-form" class="${linkedUser ? 'hidden' : ''}">
          <div class="playback-row">
            <label class="playback-row-label" for="lfm-username">
              <div class="playback-row-name">Username</div>
            </label>
            <input type="text" id="lfm-username" class="settings-input" style="max-width:220px" placeholder="Last.fm username" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore>
          </div>
          <div class="playback-row">
            <label class="playback-row-label" for="lfm-password">
              <div class="playback-row-name">Password</div>
            </label>
            <input type="password" id="lfm-password" class="settings-input" style="max-width:220px" placeholder="Last.fm password" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore>
          </div>
          <div class="playback-row" style="justify-content:flex-end">
            <button class="btn-primary" id="lfm-connect-btn">Connect</button>
          </div>
        </div>
      </div>


    </div>`);

  // Disconnect
  document.getElementById('lfm-disconnect-btn')?.addEventListener('click', async () => {
    try {
      await api('POST', 'api/v1/lastfm/disconnect', {});
      toast('Last.fm account disconnected');
      viewLastFM();
    } catch(e) { toast('Error: ' + e.message); }
  });

  // Connect
  document.getElementById('lfm-connect-btn')?.addEventListener('click', async () => {
    const btn  = document.getElementById('lfm-connect-btn');
    const user = document.getElementById('lfm-username').value.trim();
    const pass = document.getElementById('lfm-password').value;
    if (!user || !pass) { toast('Enter your Last.fm username and password'); return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await api('POST', 'api/v1/lastfm/connect', { lastfmUser: user, lastfmPassword: pass });
      toast('\u2713 Last.fm connected as ' + user);
      viewLastFM();
    } catch(e) {
      toast('Last.fm: ' + (e.message || 'Authentication failed'));
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });

  // Allow Enter key to submit the connect form
  ['lfm-username', 'lfm-password'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('lfm-connect-btn')?.click();
    });
  });

}

// ── LISTENBRAINZ ──────────────────────────────────────────────
async function viewListenBrainz() {
  setTitle('ListenBrainz'); setBack(null); setNavActive('listenbrainz'); S.view = 'listenbrainz';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  let linked = false;
  try { const d = await api('GET', 'api/v1/listenbrainz/status'); linked = d?.linked === true; } catch(_) {}

  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🎵</div>
          <div>
            <div class="playback-section-title">Your ListenBrainz Account</div>
            <div class="playback-section-desc">Link your ListenBrainz profile to scrobble every track you play on this server. Enter your ListenBrainz user token — you can find it at listenbrainz.org/profile.</div>
          </div>
        </div>

        <div id="lb-connected" class="${linked ? '' : 'hidden'}">
          <div class="playback-row">
            <div class="playback-row-label">
              <div class="playback-row-name">Token is saved and active.</div>
            </div>
            <button class="btn-danger" id="lb-disconnect-btn">Disconnect</button>
          </div>
        </div>

        <div id="lb-form" class="${linked ? 'hidden' : ''}">
          <div class="playback-row">
            <label class="playback-row-label" for="lb-token">
              <div class="playback-row-name">User Token</div>
            </label>
            <input type="password" id="lb-token" class="settings-input" style="max-width:340px" placeholder="ListenBrainz user token" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore>
          </div>
          <div class="playback-row" style="justify-content:flex-end">
            <button class="btn-primary" id="lb-connect-btn">Connect</button>
          </div>
        </div>
      </div>
    </div>`);

  document.getElementById('lb-disconnect-btn')?.addEventListener('click', async () => {
    try {
      await api('POST', 'api/v1/listenbrainz/disconnect', {});
      S.listenbrainzLinked = false;
      toast('ListenBrainz token removed');
      viewListenBrainz();
    } catch(e) { toast('Error: ' + e.message); }
  });

  document.getElementById('lb-connect-btn')?.addEventListener('click', async () => {
    const btn   = document.getElementById('lb-connect-btn');
    const token = document.getElementById('lb-token').value.trim();
    if (!token) { toast('Enter your ListenBrainz user token'); return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await api('POST', 'api/v1/listenbrainz/connect', { lbToken: token });
      S.listenbrainzLinked = true;
      toast('\u2713 ListenBrainz connected');
      viewListenBrainz();
    } catch(e) {
      toast('ListenBrainz: ' + (e.message || 'Token validation failed'));
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });

  document.getElementById('lb-token')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('lb-connect-btn')?.click();
  });
}

// ── SUBSONIC SETTINGS ─────────────────────────────────────────
async function viewSubsonic() {
  setTitle('Subsonic API'); setBack(null); setNavActive('subsonic'); S.view = 'subsonic';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>
          </div>
          <div>
            <div class="playback-section-title">Subsonic API Password</div>
            <div class="playback-section-desc">Set the password used by Subsonic-compatible apps (Ultrasonic, DSub, Symfonium, Tempo, Jamstash, etc.). This is separate from your mStream login password. Use HTTP token auth (MD5) in your app for best security.</div>
          </div>
        </div>

        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Server URL</div>
            <div class="playback-row-hint">Enter this in your Subsonic app</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="subsonic-server-url" style="font-family:monospace;font-size:.82rem;color:var(--t1);word-break:break-all;">${esc(location.origin)}</span>
            <button class="btn-ghost" id="copy-server-url-btn" style="padding:4px 10px;font-size:.75rem;flex-shrink:0;">Copy</button>
          </div>
        </div>

        <div class="playback-row">
          <label class="playback-row-label" for="subsonic-new-pw">
            <div class="playback-row-name">New Subsonic Password</div>
          </label>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="password" id="subsonic-new-pw" class="settings-input" style="max-width:220px" placeholder="New Subsonic password" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore>
            <button class="btn-primary" id="subsonic-save-pw-btn">Save</button>
          </div>
        </div>

        <div class="playback-row" style="background:var(--raised2,var(--raised));border-radius:8px;padding:.65rem .9rem;margin-top:.5rem;gap:1rem;flex-wrap:wrap;">
          <div class="playback-row-label">
            <div class="playback-row-name" style="font-size:.8rem;">App connection details</div>
            <div class="playback-row-hint" id="subsonic-username-hint">Username: <strong>${esc(S.username || 'mstream-user')}</strong>${S.username ? '' : ' <span style="font-size:.75rem;color:var(--t2);">(no-auth default)</span>'}</div>
            <div class="playback-row-hint">API path: <code style="font-size:.78rem;">/rest/</code></div>
            <div class="playback-row-hint" style="margin-top:.25rem;">Use <em>Token auth (MD5)</em> in your app when available — safer than plain-text mode.</div>
          </div>
        </div>
      </div>
    </div>`);

  document.getElementById('copy-server-url-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(location.origin).then(() => toast('Server URL copied!')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = location.origin; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Server URL copied!');
    });
  });

  document.getElementById('subsonic-save-pw-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('subsonic-save-pw-btn');
    const pw  = document.getElementById('subsonic-new-pw').value;
    if (!pw) { toast('Enter a new Subsonic password'); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('POST', 'api/v1/admin/users/subsonic-password', {
        username: S.username || '',
        password: pw
      });
      toast('\u2713 Subsonic password updated');
      document.getElementById('subsonic-new-pw').value = '';
    } catch(e) {
      toast('Error: ' + (e.message || 'Failed to update password'));
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  });

  document.getElementById('subsonic-new-pw')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('subsonic-save-pw-btn')?.click();
  });
}

// ── DISCOGS ADMIN SETTINGS ───────────────────────────────────
async function viewDiscogs() {
  setTitle('Discogs'); setBack(null); setNavActive('discogs'); S.view = 'discogs';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  let cfg = { enabled: false, apiKey: '', apiSecret: '' };
  try { cfg = await api('GET', 'api/v1/admin/discogs/config'); } catch (_) {}

  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
          </div>
          <div>
            <div class="playback-section-title">Discogs Album Art</div>
            <div class="playback-section-desc">When enabled, the Now Playing modal shows a <b>Fix Art</b> button for songs with missing or broken album art. It searches Discogs and offers up to <b>8 front-cover proposals</b> — picking one embeds the image permanently into the audio file (mp3, flac, ogg, m4a&hellip;). Only visible to admins. Enter your own key+secret from <strong>discogs.com/settings/developers</strong>, or leave blank to use the built-in keys.</div>
          </div>
        </div>

        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Enable Album Art Import</div>
            <div class="playback-row-hint">Show Discogs cover choices in the Auto-DJ strip</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="discogs-enabled" ${cfg.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="playback-row">
          <label class="playback-row-label" for="discogs-key">
            <div class="playback-row-name">API Key</div>
            <div class="playback-row-hint">Consumer Key from Discogs developer settings</div>
          </label>
          <input type="text" id="discogs-key" class="settings-input" style="max-width:280px"
            placeholder="Consumer Key (optional)" autocomplete="off"
            data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore
            value="${esc(cfg.apiKey || '')}">
        </div>

        <div class="playback-row">
          <label class="playback-row-label" for="discogs-secret">
            <div class="playback-row-name">API Secret</div>
            <div class="playback-row-hint">Consumer Secret from Discogs developer settings</div>
          </label>
          <input type="password" id="discogs-secret" class="settings-input" style="max-width:280px"
            placeholder="Consumer Secret (optional)" autocomplete="new-password"
            data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore
            value="${esc(cfg.apiSecret || '')}">
        </div>

        <div class="playback-row" style="justify-content:flex-end">
          <button class="btn-primary" id="discogs-save-btn">Save</button>
        </div>
      </div>
    </div>`);

  document.getElementById('discogs-save-btn').addEventListener('click', async () => {
    const btn       = document.getElementById('discogs-save-btn');
    const enabled   = document.getElementById('discogs-enabled').checked;
    const apiKey    = document.getElementById('discogs-key').value.trim();
    const apiSecret = document.getElementById('discogs-secret').value.trim();
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('POST', 'api/v1/admin/discogs/config', { enabled, apiKey, apiSecret });
      toast('\u2713 Discogs settings saved');
      viewDiscogs();
    } catch (e) {
      toast('Error: ' + e.message);
      btn.disabled = false; btn.textContent = 'Save';
    }
  });
}

// ── RADIO STREAMS ─────────────────────────────────────────────
let _radioStations = [];
let _radioFilter   = { genre: null, country: null };
let _podcastFeeds  = [];
let _radioNowPlayingTimer   = null;
let _radioNowPlayingStation = null;
let _radioPlayStart = 0;         // Date.now() when current radio stream started playing
let _radioDbLookupTimer = null;  // delayed DB-check after now-playing changes
let _radioNpLastText    = null;  // last seen now-playing string, to detect changes
let _radioSpectrumEnabled = false; // toggled by clicking the progress bar during radio

const _RADIO_ART_PLACEHOLDER = `<div style="width:48px;height:48px;background:var(--card);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/></svg></div>`;
function _radioImgErr(el) { el.outerHTML = _RADIO_ART_PLACEHOLDER; }

function _radioArtHtml(imgUrl) {
  const u = imgUrl ? artUrl(imgUrl, 's') : null;
  if (u) return `<img src="${u}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="_radioImgErr(this)">`;
  return _RADIO_ART_PLACEHOLDER;
}

function _stopRadioNowPlaying() {
  if (_radioNowPlayingTimer) { clearInterval(_radioNowPlayingTimer); _radioNowPlayingTimer = null; }
  if (_radioDbLookupTimer)  { clearTimeout(_radioDbLookupTimer);  _radioDbLookupTimer = null; }
  _radioNowPlayingStation = null;
  _radioNpLastText = null;
  const el = document.getElementById('player-radio-np');
  if (el) el.classList.add('hidden');
  const badge = document.getElementById('player-radio-db-badge');
  if (badge) badge.classList.add('hidden');
  const kbpsEl = document.getElementById('player-radio-kbps');
  if (kbpsEl) kbpsEl.classList.add('hidden');
  const npKbpsEl = document.getElementById('np-radio-kbps');
  if (npKbpsEl) { npKbpsEl.classList.add('hidden'); npKbpsEl.style.display = 'none'; }
}

// Build fuzzy search candidates from a raw ICY StreamTitle.
// Stations use "ARTIST - TITLE" or "TITLE - ARTIST" (either order).
// Strategy: split on first ' - ', then for each half generate:
//   1. The half minus any parenthetical text  (e.g. "GET DOWN (RADIO EDIT)" → "GET DOWN")
//   2. Content inside the first parentheses   (e.g. "BOTA (BADDEST OF THEM ALL)" → "BADDEST OF THEM ALL")
// All candidates are stripped to alphanumeric + spaces so special chars
// like & ( ) . never reach the FTS5 query parser.
function _buildRadioSearchCandidates(raw) {
  const clean = s => s.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const dashIdx = raw.indexOf(' - ');
  const parts = dashIdx > 0 ? [raw.slice(0, dashIdx), raw.slice(dashIdx + 3)] : [raw];
  const candidates = [];
  for (const part of parts) {
    const stripped = clean(part.replace(/\([^)]*\)/g, ''));
    if (stripped.length > 2) candidates.push(stripped);
    const m = part.match(/\(([^)]+)\)/);
    if (m) {
      const inside = clean(m[1]);
      if (inside.length > 2) candidates.push(inside);
    }
  }
  // deduplicate (case-insensitive), preserve order
  const seen = new Set();
  return candidates.filter(c => { const k = c.toLowerCase(); return seen.has(k) ? false : seen.add(k); });
}

async function _pollRadioNowPlaying(station) {
  const url = station._radioLinks?.[station._radioLinkIdx || 0];
  if (!url) return;
  try {
    const data = await api('GET', `api/v1/radio/nowplaying?url=${encodeURIComponent(url)}`);
    if (_radioNowPlayingStation !== station) return; // station changed
    const el = document.getElementById('player-radio-np');
    if (!el) return;
    if (data?.title) {
      const newText = data.artist ? `${data.artist} — ${data.title}` : data.title;
      const textEl = document.getElementById('player-radio-np-text');
      if (textEl) textEl.textContent = newText;
      el.classList.remove('hidden');
      // If the track changed: reset badge and schedule DB lookup
      if (newText !== _radioNpLastText) {
        _radioNpLastText = newText;
        const badge = document.getElementById('player-radio-db-badge');
        if (badge) badge.classList.add('hidden');
        if (_radioDbLookupTimer) { clearTimeout(_radioDbLookupTimer); _radioDbLookupTimer = null; }
        // Fuzzy library lookup: split on ' - ', try each half (and parenthetical
        // content) as independent searches so "ARTIST - TITLE", "TITLE - ARTIST",
        // abbreviations (BOTA vs B.O.T.A.), and version suffixes all resolve.
        const candidates = _buildRadioSearchCandidates((data.title || '').trim());
        if (candidates.length) {
          _radioDbLookupTimer = setTimeout(async () => { // 3 s delay
            try {
              let found = false;
              for (const q of candidates) {
                if (found) break;
                const res = await api('POST', 'api/v1/db/search', { search: q, noArtists: true, noAlbums: true, noFiles: true });
                if (res.title?.length > 0) found = true;
              }
              if (found && _radioNpLastText === newText) {
                const b = document.getElementById('player-radio-db-badge');
                if (b) b.classList.remove('hidden');
              }
            } catch(_) {}
          }, 3000);
        }
      }
    } else {
      el.classList.add('hidden');
    }
    const kbpsEl = document.getElementById('player-radio-kbps');
    const npKbpsEl = document.getElementById('np-radio-kbps');
    if (kbpsEl) {
      if (data?.bitrate) {
        kbpsEl.textContent = `${data.bitrate} kbps`;
        kbpsEl.classList.remove('hidden');
      } else {
        kbpsEl.classList.add('hidden');
      }
    }
    if (npKbpsEl) {
      if (data?.bitrate) {
        npKbpsEl.textContent = `${data.bitrate} kbps`;
        npKbpsEl.classList.remove('hidden');
        npKbpsEl.style.display = 'inline-block';
      } else {
        npKbpsEl.classList.add('hidden');
        npKbpsEl.style.display = 'none';
      }
    }
  } catch (_) {}
}

function _startRadioNowPlaying(station) {
  _stopRadioNowPlaying();
  _radioNowPlayingStation = station;
  _pollRadioNowPlaying(station);
  _radioNowPlayingTimer = setInterval(() => {
    if (_radioNowPlayingStation !== station) { _stopRadioNowPlaying(); return; }
    _pollRadioNowPlaying(station);
  }, 30000);
}

function _playRadio(station) {
  const links = [station.link_a, station.link_b, station.link_c].filter(Boolean);
  if (!links.length) { toast('No stream URL configured for this station'); return; }
  const song = {
    title: station.name,
    artist: station.genre || '',
    album: station.country || '',
    filepath: links[0],
    'album-art': station.img || null,
    isRadio: true,
    _radioLinks: links,
    _radioLinkIdx: 0,
    _radioStationId: station.id || null,
  };
  _setPlaySource('radio', station.name);
  _startRadioNowPlaying(song);
  Player.playSingle(song);
}

async function viewRadio() {
  setTitle('Radio Streams'); setBack(null); setNavActive('radio'); S.view = 'radio';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  try { _radioStations = await api('GET', 'api/v1/radio/stations'); } catch (_) { _radioStations = []; }

  _renderRadioView();
}

function _radioEditForm(station) {
  // returns HTML for add/edit form
  const s = station || {};
  const id = s.id || '';
  return `
    <div class="playback-section" id="radio-edit-form" data-id="${id}" style="margin:8px 0;border-radius:var(--r);border-color:var(--primary) !important;">
      <div class="playback-section-hdr">
        <div class="playback-section-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/></svg>
        </div>
        <div>
          <div class="playback-section-title">${id ? 'Edit Station' : 'Add Station'}</div>
        </div>
      </div>
      <div class="playback-row">
        <label class="playback-row-label" for="rs-name" style="min-width:130px"><div class="playback-row-name">Name <span style="color:var(--accent)">*</span></div></label>
        <input type="text" id="rs-name" class="settings-input" style="max-width:320px" placeholder="e.g. Radio Paradise" value="${esc(s.name||'')}">  
      </div>
      <div class="playback-row">
        <label class="playback-row-label" for="rs-genre" style="min-width:130px"><div class="playback-row-name">Genre</div><div class="playback-row-hint">Comma-separated, e.g. Top40, House</div></label>
        <input type="text" id="rs-genre" class="settings-input" style="max-width:320px" placeholder="e.g. Top40, House, Dance" value="${esc(s.genre||'')}">
      </div>
      <div class="playback-row">
        <label class="playback-row-label" for="rs-country" style="min-width:130px"><div class="playback-row-name">Country</div></label>
        <input type="text" id="rs-country" class="settings-input" style="max-width:320px" placeholder="e.g. US, Netherlands" value="${esc(s.country||'')}">  
      </div>
      <div class="playback-row">
        <label class="playback-row-label" for="rs-link-a" style="min-width:130px"><div class="playback-row-name">Stream URL A <span style="color:var(--accent)">*</span></div><div class="playback-row-hint">Primary stream (HTTP/HTTPS, no .m3u8)</div></label>
        <input type="url" id="rs-link-a" class="settings-input" style="max-width:400px" placeholder="https://…" value="${esc(s.link_a||'')}">
      </div>
      <div class="playback-row">
        <label class="playback-row-label" for="rs-img" style="min-width:130px"><div class="playback-row-name">Image URL</div><div class="playback-row-hint">Direct image link shown as album art</div></label>
        <input type="url" id="rs-img" class="settings-input" style="max-width:400px" placeholder="https://…" value="${esc(s.img||'')}">
      </div>
      <div class="playback-row" style="justify-content:flex-end;gap:.75rem">
        <button class="btn-flat" id="rs-cancel-btn">Cancel</button>
        <button class="btn-primary" id="rs-save-btn">${id ? 'Save Changes' : 'Add Station'}</button>
      </div>
    </div>`;
}

function _renderRadioView() {
  const body = document.getElementById('content-body');

  // compute available genres/countries from stations for filter pills
  // genre field is comma-separated: "Top40, House, Dance" → 3 separate tags
  const splitGenres = s => (s.genre || '').split(',').map(g => g.trim()).filter(Boolean);
  const genres   = [...new Set(_radioStations.flatMap(splitGenres))].sort();
  const countries = [...new Set(_radioStations.map(s => s.country).filter(Boolean))].sort();

  let filtered = _radioStations;
  if (_radioFilter.genre)   filtered = filtered.filter(s => splitGenres(s).includes(_radioFilter.genre));
  if (_radioFilter.country) filtered = filtered.filter(s => s.country === _radioFilter.country);

  const filterPills = (label, items, key) => {
    if (!items.length) return '';
    const pills = items.map(v =>
      `<button class="rs-pill${_radioFilter[key]===v?' rs-pill-active':''}" data-filter-key="${key}" data-filter-val="${esc(v)}">${esc(v)}</button>`
    ).join('');
    return `<div class="rs-filter-row"><span class="rs-filter-label">${label}</span>${pills}<button class="rs-pill rs-pill-clear${_radioFilter[key]?'':' hidden'}" data-filter-key="${key}" data-filter-val="">All</button></div>`;
  };

  const canReorder = !_radioFilter.genre && !_radioFilter.country;

  const stationRows = filtered.map(s => `
    <div class="rs-row" data-id="${s.id}">
      <div class="rs-drag-handle" title="Drag to reorder"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></div>
      <div class="rs-card-art">${_radioArtHtml(s.img)}</div>
      <div class="rs-info">
        <div class="rs-name">${esc(s.name)}</div>
        <div class="rs-meta">${[...splitGenres(s), s.country].filter(Boolean).map(v => `<span>${esc(v)}</span>`).join(' · ')}</div>
      </div>
      <div class="rs-actions">
        <button class="rs-play-btn ctrl-btn ctrl-sm" data-id="${s.id}" title="Play">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
        </button>
        <button class="rs-edit-btn ctrl-btn ctrl-sm" data-id="${s.id}" title="Edit">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="rs-delete-btn ctrl-btn ctrl-sm" data-id="${s.id}" title="Delete" style="color:var(--err,#f38ba8)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg>
        </button>
      </div>
    </div>`).join('') || '<div class="empty-state" style="margin-top:2rem">No stations yet — click Add Channel to get started</div>';

  body.innerHTML = `
    <div class="playback-panel">
      <div class="playback-section rs-full">
        <div class="playback-section-hdr" style="justify-content:space-between">
          <div style="display:flex;align-items:center;gap:1rem">
            <div class="playback-section-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/></svg>
            </div>
            <div class="playback-section-title">Channels</div>
          </div>
          <button class="btn-primary" id="rs-add-btn" style="white-space:nowrap">+ Add Channel</button>
        </div>
        ${filterPills('Genre', genres, 'genre')}
        ${filterPills('Country', countries, 'country')}
        <div id="rs-edit-area"></div>
        <div class="rs-list${canReorder ? ' rs-list--sortable' : ''}">${stationRows}</div>
        <div class="rs-queue-notice">Playing a radio stream clears the play queue</div>
      </div>
    </div>`;

  // Add Channel button
  body.querySelector('#rs-add-btn').addEventListener('click', () => {
    document.getElementById('rs-edit-area').innerHTML = _radioEditForm(null);
    _attachRadioFormHandlers();
    document.getElementById('rs-edit-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Filter pills
  body.querySelectorAll('.rs-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const key = pill.dataset.filterKey;
      const val = pill.dataset.filterVal || null;
      _radioFilter[key] = val;
      _renderRadioView();
    });
  });

  // Play buttons
  body.querySelectorAll('.rs-play-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = _radioStations.find(x => x.id == btn.dataset.id);
      if (s) _playRadio(s);
    });
  });

  // Edit buttons
  body.querySelectorAll('.rs-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = _radioStations.find(x => x.id == btn.dataset.id);
      if (!s) return;
      document.getElementById('rs-edit-area').innerHTML = _radioEditForm(s);
      _attachRadioFormHandlers();
      document.getElementById('rs-edit-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Drag-and-drop reorder (only when no filter is active)
  if (canReorder && filtered.length > 1) {
    const rsList = body.querySelector('.rs-list');
    let dragSrcId = null;
    rsList.querySelectorAll('.rs-row').forEach(row => {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', e => {
        dragSrcId = row.dataset.id;
        row.classList.add('rs-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('rs-dragging');
        rsList.querySelectorAll('.rs-row').forEach(r => r.classList.remove('rs-drag-over-left', 'rs-drag-over-right'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (row.dataset.id === dragSrcId) return;
        rsList.querySelectorAll('.rs-row').forEach(r => r.classList.remove('rs-drag-over-left', 'rs-drag-over-right'));
        const rect = row.getBoundingClientRect();
        row.classList.add(e.clientX < rect.left + rect.width / 2 ? 'rs-drag-over-left' : 'rs-drag-over-right');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('rs-drag-over-left', 'rs-drag-over-right');
      });
      row.addEventListener('drop', async e => {
        e.preventDefault();
        rsList.querySelectorAll('.rs-row').forEach(r => r.classList.remove('rs-drag-over-left', 'rs-drag-over-right'));
        if (row.dataset.id === dragSrcId) return;
        const srcRow = rsList.querySelector(`.rs-row[data-id="${dragSrcId}"]`);
        if (!srcRow) return;
        const rect = row.getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          rsList.insertBefore(srcRow, row);
        } else {
          rsList.insertBefore(srcRow, row.nextSibling);
        }
        const newIds = [...rsList.querySelectorAll('.rs-row')].map(r => parseInt(r.dataset.id, 10));
        const idToStation = Object.fromEntries(_radioStations.map(s => [s.id, s]));
        _radioStations = newIds.map(id => idToStation[id]).filter(Boolean);
        try {
          await api('PUT', 'api/v1/radio/stations/reorder', { ids: newIds });
        } catch (_) { toast('Failed to save order'); }
      });
    });
  }

  // Delete buttons
  body.querySelectorAll('.rs-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = _radioStations.find(x => x.id == btn.dataset.id);
      if (!s) return;
      if (!confirm(`Delete "${s.name}"?`)) return;
      try {
        await api('DELETE', `api/v1/radio/stations/${s.id}`);
        _radioStations = _radioStations.filter(x => x.id !== s.id);
        _renderRadioView();
      } catch (e) { toast('Delete failed: ' + e.message); }
    });
  });
}

function _attachRadioFormHandlers() {
  document.getElementById('rs-cancel-btn').addEventListener('click', () => {
    document.getElementById('rs-edit-area').innerHTML = '';
  });
  document.getElementById('rs-save-btn').addEventListener('click', async () => {
    const form = document.getElementById('radio-edit-form');
    const id   = form.dataset.id;
    const body = {
      name:    document.getElementById('rs-name').value.trim(),
      genre:   document.getElementById('rs-genre').value.trim() || null,
      country: document.getElementById('rs-country').value.trim() || null,
      link_a:  document.getElementById('rs-link-a').value.trim() || null,
      img:     document.getElementById('rs-img').value.trim() || null,
    };
    if (!body.name) { toast('Name is required'); return; }
    if (!body.link_a) { toast('Stream URL A is required'); return; }
    const btn = document.getElementById('rs-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (id) {
        await api('PUT', `api/v1/radio/stations/${id}`, body);
      } else {
        await api('POST', 'api/v1/radio/stations', body);
      }
      // Always reload from server — the server may have replaced img URL with
      // a locally cached filename, so we must not merge body.img directly.
      _radioStations = await api('GET', 'api/v1/radio/stations');
      document.getElementById('rs-edit-area').innerHTML = '';
      _renderRadioView();
    } catch (e) {
      toast('Save failed: ' + (e.message || 'unknown error'));
      btn.disabled = false; btn.textContent = id ? 'Save Changes' : 'Add Station';
    }
  });
}

// ── YOUTUBE DOWNLOAD VIEW ─────────────────────────────────────────────────────
function viewYoutube() {
  setTitle('YouTube Download'); setBack(null); setNavActive('youtube'); S.view = 'youtube';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  if (!S.allowYoutubeDownload) {
    setBody(`
      <div class="info-panel">
        <div class="info-panel-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        </div>
        <h2>YouTube Download</h2>
        <p class="info-hint">YouTube downloading is not enabled for your account. Ask your server admin to enable it.</p>
      </div>`);
    return;
  }

  const savedFormat = localStorage.getItem(_uKey('ytdl_format')) || 'opus';
  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></div>
          <div>
            <div class="playback-section-title">YouTube Download</div>
            <div class="playback-section-desc">Download audio from YouTube. Files are saved to your YouTube downloads folder and can be played immediately.</div>
          </div>
        </div>

        <div class="playback-row" style="flex-direction:column;align-items:stretch;gap:.5rem;">
          <div style="display:flex;gap:.6rem;align-items:center;">
            <input type="text" id="yt-url-input" class="settings-select" style="flex:1;font-family:monospace;font-size:.82rem;" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" spellcheck="false">
            <button id="yt-preview-btn" class="btn-sm btn-primary" style="white-space:nowrap;flex-shrink:0;">Preview</button>
          </div>
        </div>

        <div id="yt-preview-area" class="hidden" style="margin-top:.9rem;padding-bottom:1rem;">
          <div style="display:flex;gap:.9rem;align-items:flex-start;margin-bottom:.75rem;padding:0 18px;">
            <img id="yt-thumb" src="" alt="" style="width:auto;height:88px;object-fit:cover;border-radius:4px;flex-shrink:0;background:var(--raised);">
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem;">
              <div style="font-size:.78rem;color:var(--t2);margin-bottom:.1rem;">Edit tags before downloading:</div>
              <div style="display:flex;align-items:center;gap:.5rem;">
                <label class="playback-row-name" style="min-width:52px;font-size:.8rem;">Title</label>
                <input type="text" id="yt-title" class="settings-select" style="flex:1;" maxlength="200">
              </div>
              <div style="display:flex;align-items:center;gap:.5rem;">
                <label class="playback-row-name" style="min-width:52px;font-size:.8rem;">Artist</label>
                <input type="text" id="yt-artist" class="settings-select" style="flex:1;" maxlength="200">
              </div>
              <div style="display:flex;align-items:center;gap:.5rem;">
                <label class="playback-row-name" style="min-width:52px;font-size:.8rem;">Album</label>
                <input type="text" id="yt-album" class="settings-select" style="flex:1;" maxlength="200">
              </div>
            </div>
          </div>

          <div class="playback-row" style="margin-bottom:.6rem;">
            <div class="playback-row-label">
              <div class="playback-row-name">Format</div>
              <div class="playback-row-hint">Opus = native stream · MP3 = converted via ffmpeg</div>
            </div>
            <select id="yt-format" class="settings-select">
              <option value="opus" ${savedFormat === 'opus' ? 'selected' : ''}>Opus (original quality)</option>
              <option value="mp3"  ${savedFormat === 'mp3'  ? 'selected' : ''}>MP3 (universal, re-encoded)</option>
            </select>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:.6rem;align-items:center;padding:0 18px;">
            <span id="yt-status" style="flex:1;font-size:.83rem;color:var(--t2);"></span>
            <button id="yt-dl-btn" class="btn-sm btn-primary">Download</button>
          </div>
          <div id="yt-post-actions" class="hidden" style="display:flex;gap:.5rem;margin-top:.5rem;justify-content:flex-end;padding:0 18px;"></div>
        </div>

      </div>
    </div>`);

  const urlInput   = document.getElementById('yt-url-input');
  const previewBtn = document.getElementById('yt-preview-btn');
  const previewArea = document.getElementById('yt-preview-area');
  const statusEl   = document.getElementById('yt-status');
  let thumbUrl = null;

  previewBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { toast('Enter a YouTube URL'); return; }
    previewBtn.disabled = true;
    previewBtn.textContent = 'Loading…';
    statusEl.textContent = '';
    const actionsArea = document.getElementById('yt-post-actions');
    if (actionsArea) { actionsArea.classList.add('hidden'); actionsArea.innerHTML = ''; }
    try {
      const info = await api('GET', `api/v1/ytdl/info?url=${encodeURIComponent(url)}`);
      document.getElementById('yt-title').value  = info.title  || '';
      document.getElementById('yt-artist').value = info.artist || '';
      document.getElementById('yt-album').value  = info.album  || '';
      thumbUrl = info.thumb || null;
      const thumb = document.getElementById('yt-thumb');
      if (info.thumb) { thumb.src = info.thumb; thumb.style.display = ''; }
      else thumb.style.display = 'none';
      previewArea.classList.remove('hidden');
    } catch (err) {
      toast(err.message || 'Failed to fetch video info');
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview';
    }
  });

  // Save format preference on change
  document.getElementById('yt-format').addEventListener('change', e => {
    e.target.value === 'mp3'
      ? localStorage.setItem(_uKey('ytdl_format'), 'mp3')
      : localStorage.removeItem(_uKey('ytdl_format'));
  });

  document.getElementById('yt-dl-btn').addEventListener('click', async () => {
    const url    = urlInput.value.trim();
    const dlBtn  = document.getElementById('yt-dl-btn');
    const title  = document.getElementById('yt-title').value.trim();
    const artist = document.getElementById('yt-artist').value.trim();
    const album  = document.getElementById('yt-album').value.trim();
    dlBtn.disabled = true;
    dlBtn.textContent = 'Downloading…';
    statusEl.textContent = 'Downloading — this may take a moment…';
    try {
      const result = await api('POST', 'api/v1/ytdl/download', {
        url, title, artist, album,
        format: document.getElementById('yt-format').value,
      });
      statusEl.innerHTML =
        `<span style="color:var(--primary);">✓ Saved: ${esc(result.filePath)}</span>`;
      toast('Download complete');

      // Build a minimal song object and show inline play controls
      const song = {
        filepath: result.vpath + '/' + result.filePath,
        title:  title  || result.filePath,
        artist: artist || '',
        album:  album  || '',
        'album-art': thumbUrl || null,
      };
      const actionsArea = document.getElementById('yt-post-actions');
      if (actionsArea) {
        actionsArea.innerHTML =
          `<button id="yt-play-btn"  class="btn-sm btn-primary" style="flex-shrink:0;">▶ Play now</button>` +
          `<button id="yt-queue-btn" class="btn-sm btn-primary" style="flex-shrink:0;">+ Add to queue</button>`;
        actionsArea.classList.remove('hidden');
        document.getElementById('yt-play-btn').addEventListener('click', () => {
          Player.playSingle(song);
          toast('Playing: ' + esc(song.title));
        });
        document.getElementById('yt-queue-btn').addEventListener('click', () => {
          Player.queueAndPlay(song);
        });
      }
    } catch (err) {
      statusEl.textContent = `Error: ${esc(err.message || 'Download failed')}`;
      toast(err.message || 'Download failed');
    } finally {
      dlBtn.disabled = false;
      dlBtn.textContent = 'Download';
    }
  });
}

// ── AUDIO CONTENT VIEW (audio-books + recordings) ───────────────────────────
function viewPodcasts() {
  setTitle('Audio Content'); setBack(null); setNavActive('podcasts'); S.view = 'podcasts';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  const meta = S.vpathMeta || {};
  const abVpaths  = S.vpaths.filter(v => meta[v]?.type === 'audio-books');
  const recVpaths = S.vpaths.filter(v => meta[v]?.type === 'recordings' || meta[v]?.type === 'youtube');
  _renderPodcastsView(abVpaths, recVpaths);
}

function _renderPodcastsView(abVpaths, recVpaths = []) {
  if (abVpaths.length === 0 && recVpaths.length === 0) {
    setBody('<div class="empty-state">No audio content folders configured</div>');
    return;
  }
  const folderIcon = `<svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const chevron    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t3);flex-shrink:0"><polyline points="9,18 15,12 9,6"/></svg>`;
  const mkRow = v => `
    <div class="fe-dir" data-vpath="${esc(v)}" data-name="${esc(v)}">
      ${folderIcon}
      <span class="fe-name">${esc(v)}</span>
      ${chevron}
    </div>`;
  const allRows = [...abVpaths, ...recVpaths].map(mkRow).join('');

  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="fe-breadcrumb"><span class="fe-crumb" style="cursor:default">⌂ Audio Content</span></div>
    <div class="fe-filter-row">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="fe-filter" class="fe-filter-input" type="text" placeholder="Filter folders…" autocomplete="off">
      <span id="fe-match-count" class="fe-match-count"></span>
      <button id="fe-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
    </div>
    <div id="fe-grid" class="fe-grid">${allRows}</div>`;

  const filterInput = body.querySelector('#fe-filter');
  const filterClear = body.querySelector('#fe-filter-clear');
  const matchCount  = body.querySelector('#fe-match-count');
  const grid        = body.querySelector('#fe-grid');

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    filterClear.classList.toggle('hidden', !q);
    let visible = 0;
    grid.querySelectorAll('.fe-dir').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      const matches = !q || name.includes(q);
      row.classList.toggle('fe-hidden', !matches);
      if (matches) visible++;
    });
    matchCount.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
  }
  filterInput.addEventListener('input', applyFilter);
  filterClear.addEventListener('click', () => { filterInput.value = ''; filterInput.focus(); applyFilter(); });

  body.querySelectorAll('#fe-grid .fe-dir[data-vpath]').forEach(el => {
    el.addEventListener('click', async () => {
      S.feDirStack = [];
      S.audioContentReturn = viewPodcasts;
      await viewFiles('/' + el.dataset.vpath, false);
    });
  });
}

// ── PODCAST HELPERS ─────────────────────────────────
// Renders podcast cover art into a fixed-size container the same way
// _radioArtHtml does: explicit object-fit:cover so the whole box is filled.
function _pfArtHtml(img, size, w, h) {
  const u = img ? artUrl(img, size || 's') : null;
  const ws = w || '100%'; const hs = h || '100%';
  if (u) return `<img src="${u}" alt="" style="width:${ws};height:${hs};object-fit:cover;display:block" onerror="this.parentNode.innerHTML=noArtHtml()">` ;
  return noArtHtml();
}
function _fmtDuration(secs) {
  if (!secs || isNaN(secs)) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function _fmtPubDate(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}

async function viewPodcastFeeds() {
  setTitle('Feeds'); setBack(null); setNavActive('podcast-feeds'); S.view = 'podcast-feeds';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  try { _podcastFeeds = await api('GET', 'api/v1/podcast/feeds'); } catch (_) { _podcastFeeds = []; }
  _renderPodcastFeedsView();
}

function _renderPodcastFeedsView() {
  const body = document.getElementById('content-body');

  const pfPlaceholder = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;

  const feedCards = _podcastFeeds.map(f => {
    const vParam = f._v || f.last_fetched || '';
    const imgUrl = f.img ? artUrl(f.img, 's') + (vParam ? `&_v=${encodeURIComponent(vParam)}` : '') : null;
    const artHtml = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="" style="width:88px;height:88px;object-fit:cover;display:block" onerror="this.remove()">`
      : pfPlaceholder;
    return `<div class="pf-item" data-id="${f.id}">
      <div class="pf-feed-row">
        <div class="pf-handle pf-no-open" title="Drag to reorder"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></div>
        <div class="pf-art">${artHtml}</div>
        <div class="pf-info">
          <div class="pf-title">${esc(f.title || f.url)}</div>
          ${f.author ? `<div class="pf-author">${esc(f.author)}</div>` : ''}
          <div class="pf-stats">${f.episode_count ?? 0} episode${(f.episode_count ?? 0) !== 1 ? 's' : ''}${f.latest_pub_date ? ` · latest <span class="pf-latest-date">${_fmtPubDate(f.latest_pub_date)}</span>` : ''}${f.last_fetched ? ` · refreshed ${_fmtPubDate(f.last_fetched)}` : ''}</div>
          ${f.description ? `<div class="pf-desc">${esc(f.description)}</div>` : ''}
        </div>
        <div class="pf-btns pf-no-open">
          <button class="pf-edit-btn ctrl-btn ctrl-sm" data-id="${f.id}" title="Rename"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="pf-refresh-btn ctrl-btn ctrl-sm" data-id="${f.id}" title="Refresh feed"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
          <button class="pf-delete-btn ctrl-btn ctrl-sm" data-id="${f.id}" title="Unsubscribe" style="color:var(--err,#f38ba8)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg></button>
        </div>
      </div>
      <div class="pf-edit-panel" id="pf-edit-panel-${f.id}">
        <input type="text" class="settings-input pf-edit-name" data-id="${f.id}" value="${esc(f.title || '')}" style="flex:1;min-width:160px;max-width:320px" placeholder="Display name">
        <input type="url" class="settings-input pf-edit-url" data-id="${f.id}" value="${esc(f.url || '')}" style="flex:2;min-width:200px;max-width:480px" placeholder="RSS feed URL">
        <button class="btn-primary pf-edit-save" data-id="${f.id}" style="padding:.3rem .9rem;font-size:.82rem">Save</button>
        <button class="btn-flat pf-edit-cancel" data-id="${f.id}" style="padding:.3rem .7rem;font-size:.82rem">Cancel</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty-state" style="margin-top:1.5rem">No subscriptions yet — add an RSS feed URL above to get started</div>';

  body.innerHTML = `
    <div class="playback-panel">
      <div class="playback-section rs-full">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1" fill="currentColor"/></svg>
          </div>
          <div class="playback-section-title">Subscribe to Podcast</div>
        </div>
        <div class="playback-row" style="gap:.5rem;flex-wrap:wrap">
          <input type="url" id="pf-url-input" class="settings-input" style="flex:1;min-width:200px;max-width:480px" placeholder="Paste RSS feed URL…">
          <button class="btn-primary" id="pf-preview-btn">Preview</button>
        </div>
        <div id="pf-subscribe-error" style="color:var(--err,#f38ba8);font-size:.82rem;padding:.25rem .5rem;display:none"></div>
        <div id="pf-preview-panel" style="display:none;margin-top:.75rem;border-top:1px solid var(--border);padding-top:.75rem">
          <div style="display:flex;gap:.75rem;align-items:flex-start;margin-bottom:.75rem">
            <div id="pf-preview-art" style="min-width:64px;width:64px;height:64px;border-radius:6px;overflow:hidden;flex-shrink:0;background:var(--bg2)"></div>
            <div style="flex:1;min-width:0">
              <div id="pf-preview-title" style="font-weight:600;font-size:.95rem;margin-bottom:.2rem"></div>
              <div id="pf-preview-author" style="font-size:.82rem;color:var(--fg2);margin-bottom:.2rem"></div>
              <div id="pf-preview-count" style="font-size:.82rem;color:var(--fg2)"></div>
              <div id="pf-preview-desc" style="font-size:.82rem;color:var(--fg2);margin-top:.3rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden"></div>
            </div>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
            <input type="text" id="pf-name-input" class="settings-input" style="flex:1;min-width:160px;max-width:320px" placeholder="Custom name (optional — uses feed title by default)">
            <button class="btn-primary" id="pf-subscribe-btn">Subscribe</button>
            <button class="btn-flat" id="pf-cancel-preview-btn">Cancel</button>
          </div>
        </div>
      </div>
      <div class="playback-section rs-full">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="playback-section-title">My Feeds</div>
        </div>
        <div class="pf-list${_podcastFeeds.length > 1 ? ' pf-list--sortable' : ''}">${feedCards}</div>
      </div>
    </div>`;

  // Preview button
  body.querySelector('#pf-preview-btn').addEventListener('click', async () => {
    const url   = body.querySelector('#pf-url-input').value.trim();
    const errEl = body.querySelector('#pf-subscribe-error');
    if (!url) { errEl.textContent = 'Please enter a feed URL'; errEl.style.display = ''; return; }
    errEl.style.display = 'none';
    const btn = body.querySelector('#pf-preview-btn');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const p = await api('GET', `api/v1/podcast/preview?url=${encodeURIComponent(url)}`);
      const artEl = body.querySelector('#pf-preview-art');
      if (p.imgUrl) {
        artEl.innerHTML = `<img src="${esc(artUrl(p.imgUrl, 's'))}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()">`;
      }
      body.querySelector('#pf-preview-title').textContent  = p.title || '(Untitled)';
      body.querySelector('#pf-preview-author').textContent = p.author || '';
      body.querySelector('#pf-preview-count').textContent  = `${p.episodeCount} episode${p.episodeCount !== 1 ? 's' : ''}`;
      body.querySelector('#pf-preview-desc').textContent   = p.description || '';
      body.querySelector('#pf-preview-panel').style.display = '';
      body.querySelector('#pf-preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      errEl.textContent = e.message || 'Could not load feed';
      errEl.style.display = '';
    } finally {
      btn.disabled = false; btn.textContent = 'Preview';
    }
  });

  // Cancel preview
  body.querySelector('#pf-cancel-preview-btn').addEventListener('click', () => {
    body.querySelector('#pf-preview-panel').style.display = 'none';
    body.querySelector('#pf-url-input').value = '';
    body.querySelector('#pf-subscribe-error').style.display = 'none';
  });

  // Subscribe button
  body.querySelector('#pf-subscribe-btn').addEventListener('click', async () => {
    const url  = body.querySelector('#pf-url-input').value.trim();
    const name = body.querySelector('#pf-name-input').value.trim();
    const errEl = body.querySelector('#pf-subscribe-error');
    if (!url) return;
    errEl.style.display = 'none';
    const btn = body.querySelector('#pf-subscribe-btn');
    btn.disabled = true; btn.textContent = 'Subscribing…';
    try {
      const feed = await api('POST', 'api/v1/podcast/feeds', { url, name: name || null });
      _podcastFeeds.unshift(feed);
      S.feedsEnabled = true;
      _updateListenSection();
      _renderPodcastFeedsView();
    } catch (e) {
      errEl.textContent = e.message || 'Failed to subscribe';
      errEl.style.display = '';
      btn.disabled = false; btn.textContent = 'Subscribe';
    }
  });

  // Edit buttons — toggle inline edit panel
  body.querySelectorAll('.pf-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const panel = body.querySelector(`#pf-edit-panel-${id}`);
      if (!panel) return;
      const isOpen = panel.style.display === 'flex';
      body.querySelectorAll('.pf-edit-panel').forEach(p => { p.style.display = 'none'; });
      if (!isOpen) { panel.style.display = 'flex'; panel.querySelector('.pf-edit-name')?.focus(); }
    });
  });

  // Edit save
  body.querySelectorAll('.pf-edit-save').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id    = parseInt(btn.dataset.id, 10);
      const nameInput = body.querySelector(`.pf-edit-name[data-id="${id}"]`);
      const urlInput  = body.querySelector(`.pf-edit-url[data-id="${id}"]`);
      const title = nameInput?.value.trim();
      const url   = urlInput?.value.trim();
      if (!title) { toast('Name cannot be empty'); return; }
      if (!url)   { toast('RSS URL cannot be empty'); return; }
      try { new URL(url); } catch (_) { toast('Invalid RSS URL'); return; }
      btn.disabled = true;
      try {
        const updated = await api('PATCH', `api/v1/podcast/feeds/${id}`, { title, url });
        const idx = _podcastFeeds.findIndex(f => f.id === id);
        if (idx !== -1) _podcastFeeds[idx] = { ..._podcastFeeds[idx], ...updated };
        _renderPodcastFeedsView();
      } catch (err) {
        toast('Save failed: ' + (err.message || ''));
        btn.disabled = false;
      }
    });
  });

  // Edit cancel
  body.querySelectorAll('.pf-edit-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = body.querySelector(`#pf-edit-panel-${btn.dataset.id}`);
      if (panel) panel.style.display = 'none';
    });
  });

  // Refresh buttons
  body.querySelectorAll('.pf-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      btn.disabled = true;
      try {
        const updated = await api('POST', `api/v1/podcast/feeds/${id}/refresh`);
        const idx = _podcastFeeds.findIndex(f => f.id === id);
        if (idx !== -1) _podcastFeeds[idx] = { ...updated, _v: Date.now(), last_fetched: updated.last_fetched || new Date().toISOString() };
        _renderPodcastFeedsView();
        toast('Feed refreshed');
      } catch (e) {
        toast('Refresh failed: ' + (e.message || ''));
        btn.disabled = false;
      }
    });
  });

  // Delete buttons
  body.querySelectorAll('.pf-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const feed = _podcastFeeds.find(f => f.id === id);
      if (!feed) return;
      if (!confirm(`Unsubscribe from "${feed.title || feed.url}"?`)) return;
      try {
        await api('DELETE', `api/v1/podcast/feeds/${id}`);
        _podcastFeeds = _podcastFeeds.filter(f => f.id !== id);
        // feedsEnabled stays true — section must remain visible so user can re-add feeds
        _updateListenSection();
        _renderPodcastFeedsView();
      } catch (e) { toast('Delete failed: ' + (e.message || '')); }
    });
  });

  // Click feed row to open episodes
  body.querySelectorAll('.pf-item').forEach(item => {
    item.querySelector('.pf-feed-row').addEventListener('click', (e) => {
      if (e.target.closest('.pf-no-open')) return;
      const id = parseInt(item.dataset.id, 10);
      const feed = _podcastFeeds.find(f => f.id === id);
      if (feed) viewPodcastEpisodes(feed);
    });
  });

  // Drag-to-reorder
  if (_podcastFeeds.length > 1) {
    const pfList = body.querySelector('.pf-list');
    let dragSrcId = null;
    pfList.querySelectorAll('.pf-item').forEach(item => {
      const handle = item.querySelector('.pf-handle');
      if (handle) {
        handle.addEventListener('mousedown', () => { item.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup',   () => { item.setAttribute('draggable', 'false'); });
      }
      item.addEventListener('dragstart', e => {
        dragSrcId = item.dataset.id;
        item.classList.add('pf-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('pf-dragging');
        pfList.querySelectorAll('.pf-item').forEach(r => r.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom'));
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        if (item.dataset.id === dragSrcId) return;
        const rect = item.getBoundingClientRect();
        pfList.querySelectorAll('.pf-item').forEach(r => r.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom'));
        item.classList.add(e.clientY < rect.top + rect.height / 2 ? 'pf-drag-over-top' : 'pf-drag-over-bottom');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
      });
      item.addEventListener('drop', async e => {
        e.preventDefault();
        pfList.querySelectorAll('.pf-item').forEach(r => r.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom'));
        if (item.dataset.id === dragSrcId) return;
        const srcItem = pfList.querySelector(`.pf-item[data-id="${dragSrcId}"]`);
        if (!srcItem) return;
        const rect = item.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) pfList.insertBefore(srcItem, item);
        else item.after(srcItem);
        const newIds = [...pfList.querySelectorAll('.pf-item')].map(r => parseInt(r.dataset.id, 10));
        const idToFeed = Object.fromEntries(_podcastFeeds.map(f => [f.id, f]));
        _podcastFeeds = newIds.map(id => idToFeed[id]).filter(Boolean);
        try { await api('PUT', 'api/v1/podcast/feeds/reorder', { ids: newIds }); } catch (_) {}
      });
    });
  }
}

async function viewPodcastEpisodes(feed) {
  setTitle(feed.title || 'Episodes');
  setBack(() => viewPodcastFeeds());
  setNavActive('podcast-feeds');
  S.view = 'podcast-episodes';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  let episodes = [];
  try { episodes = await api('GET', `api/v1/podcast/episodes/${feed.id}`); } catch (_) { episodes = []; }

  const vParam = feed._v || feed.last_fetched || '';
  const feedImgUrl = feed.img ? artUrl(feed.img, 'l') + (vParam ? `&_v=${encodeURIComponent(vParam)}` : '') : null;
  const artHtml = feedImgUrl
    ? `<img src="${esc(feedImgUrl)}" alt="" style="width:96px;height:96px;object-fit:cover;display:block" onerror="this.remove()">`
    : `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.35"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
  const _saveSvgIdle     = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const _saveSvgSpinner  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="animation:spin .8s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg>`;
  const _saveSvgOk       = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const _saveSvgErr      = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const epRows = episodes.map((ep, i) => `
    <div class="pf-ep-row" data-id="${ep.id}" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--raised);transition:background .12s;cursor:default">
      <div style="min-width:1.6rem;font-size:.75rem;color:var(--t2);text-align:right;flex-shrink:0">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:.88rem;font-weight:600;color:var(--t1);line-height:1.35;word-break:break-word">${esc(ep.title)}</div>
        <div style="font-size:.75rem;color:var(--t2);margin-top:3px;display:flex;gap:.6rem;flex-wrap:wrap">
          ${ep.pub_date ? `<span>${_fmtPubDate(ep.pub_date)}</span>` : ''}
          ${ep.duration_secs ? `<span>${_fmtDuration(ep.duration_secs)}</span>` : ''}
        </div>
      </div>
      <button class="pf-ep-save-btn ctrl-btn ctrl-sm" data-id="${ep.id}" title="Save to library" style="flex-shrink:0">${_saveSvgIdle}</button>
      <button class="pf-ep-play-btn ctrl-btn ctrl-sm" data-id="${ep.id}" title="Play episode" style="flex-shrink:0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
      </button>
    </div>`).join('') || '<div class="empty-state" style="margin-top:2rem">No episodes found in this feed.</div>';

  setBody(`
    <div class="playback-panel">
      <div class="playback-section rs-full" style="display:flex;gap:1rem;align-items:flex-start">
        <div style="min-width:96px;width:96px;height:96px;border-radius:8px;overflow:hidden;flex-shrink:0;background:var(--bg2)">
          ${artHtml}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:1rem;margin-bottom:.25rem">${esc(feed.title || feed.url)}</div>
          ${feed.author ? `<div style="font-size:.82rem;color:var(--fg2);margin-bottom:.25rem">${esc(feed.author)}</div>` : ''}
          ${feed.description ? `<div style="font-size:.82rem;color:var(--fg2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(feed.description)}</div>` : ''}
        </div>
      </div>
      <div class="playback-section rs-full">
        <div class="playback-section-hdr" style="margin-bottom:.25rem">
          <div class="playback-section-title">Episodes (${episodes.length})</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;padding:4px 0">${epRows}</div>
      </div>
    </div>`);

  document.querySelectorAll('.pf-ep-play-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = episodes.find(e => e.id == btn.dataset.id);
      if (!ep) return;
      _setPlaySource('podcast', feed.title || feed.url);
      Player.playSingle({
        title:          ep.title,
        artist:         feed.author || feed.title,
        album:          feed.title,
        filepath:       ep.audio_url,
        'album-art':    feed.img || null,
        'album-art-v':  feed.last_fetched || '',
        isPodcast:      true,
        _episodeId:     ep.id,
        _feedId:        feed.id,
      });
    });
  });

  document.querySelectorAll('.pf-ep-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('saving')) return;
      const ep = episodes.find(e => e.id == btn.dataset.id);
      if (!ep) return;
      btn.classList.add('saving');
      btn.innerHTML = _saveSvgSpinner;
      btn.title = 'Saving…';
      try {
        const result = await api('POST', 'api/v1/podcast/episode/save', { feedId: feed.id, episodeId: ep.id });
        btn.classList.remove('saving');
        btn.classList.add('saved');
        btn.innerHTML = _saveSvgOk;
        btn.title = `Saved to ${result.savedTo}`;
        toast(`Saved: ${result.savedTo.split('/').pop()}`, 3500);
        // Reset to idle after 4 s so it can be saved again
        setTimeout(() => {
          btn.classList.remove('saved');
          btn.innerHTML = _saveSvgIdle;
          btn.title = 'Save to library';
        }, 4000);
      } catch (e) {
        btn.classList.remove('saving');
        btn.classList.add('error');
        btn.innerHTML = _saveSvgErr;
        btn.title = e.message || 'Save failed';
        toastError(e.message || 'Save failed');
        setTimeout(() => {
          btn.classList.remove('error');
          btn.innerHTML = _saveSvgIdle;
          btn.title = 'Save to library';
        }, 4000);
      }
    });
  });
}
function viewPlayback() {
  setTitle('Settings'); setBack(null); setNavActive('playback'); S.view = 'playback';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const xf = S.crossfade;
  const sleepActive = S.sleepMins > 0;
  const sleepRemaining = sleepActive ? Math.max(0, Math.ceil((S.sleepEndsAt - Date.now()) / 60000)) : 0;

  setBody(`
    <div class="playback-panel">

      <!-- ── CROSSFADE ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🎚️</div>
          <div>
            <div class="playback-section-title">Crossfade</div>
            <div class="playback-section-desc">Smoothly blend between tracks — the current song fades out while the next fades in.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Crossfade Duration</div>
            <div class="playback-row-hint">0 = disabled · max 12 seconds</div>
          </div>
          <div class="xf-ctrl">
            <input type="range" id="xf-slider" class="xf-slider" min="0" max="12" step="1" value="${xf}">
            <span id="xf-val" class="xf-val">${xf === 0 ? 'Off' : xf + 's'}</span>
          </div>
        </div>
      </div>

      <!-- ── SLEEP TIMER ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">😴</div>
          <div>
            <div class="playback-section-title">Sleep Timer</div>
            <div class="playback-section-desc">Playback fades out and stops automatically after the chosen time.</div>
          </div>
        </div>
        ${sleepActive ? `
        <div class="sleep-active-box" id="sleep-active-box">
          <div class="sleep-active-info">
            <span class="sleep-active-label">Timer active</span>
            <span class="sleep-active-remaining" id="sleep-view-remaining">${sleepRemaining} min remaining</span>
          </div>
          <button class="sleep-cancel-btn" id="sleep-cancel-btn">Cancel</button>
        </div>` : ''}
        <div class="sleep-presets" id="sleep-presets">
          <button class="sleep-preset" data-mins="15">15 min</button>
          <button class="sleep-preset" data-mins="30">30 min</button>
          <button class="sleep-preset" data-mins="60">60 min</button>
          <button class="sleep-preset" data-mins="90">90 min</button>
          <button class="sleep-preset" data-mins="-1">End of song</button>
        </div>
      </div>

      <!-- ── REPLAYGAIN ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🔊</div>
          <div>
            <div class="playback-section-title">ReplayGain Normalisation</div>
            <div class="playback-section-desc">Equalise perceived loudness across tracks using embedded ReplayGain values (requires tagged files).</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Loudness Normalisation</div>
            <div class="playback-row-hint">Applies the track's ReplayGain value as a gain adjustment</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="rg-enable" ${S.rgEnabled ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
      </div>

      <!-- ── GAPLESS PLAYBACK ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">▶▶</div>
          <div>
            <div class="playback-section-title">Gapless Playback</div>
            <div class="playback-section-desc">Pre-buffer the next track so it starts instantly with no silence. Works when Crossfade is set to 0.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Gapless Mode</div>
            <div class="playback-row-hint">Requires crossfade = 0; overridden by crossfade when > 0</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="gapless-enable" ${S.gapless ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
      </div>

      <!-- ── DYNAMIC COLOURS ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🎨</div>
          <div>
            <div class="playback-section-title">Dynamic Colours</div>
            <div class="playback-section-desc">Tints the interface with the dominant colour sampled from the current album art.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Dynamic Colours</div>
            <div class="playback-row-hint">Stored in this browser's local storage — setting is per-browser for now</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="dyn-color-enable" ${S.dynColor ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
      </div>

      <!-- ── AUTO-RESUME ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">▶️</div>
          <div>
            <div class="playback-section-title">Auto-Resume</div>
            <div class="playback-section-desc">When you reopen the browser or reload the page, automatically resume playing where you left off. When disabled, music is always paused on start.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Resume playback on reload</div>
            <div class="playback-row-hint">Stored in this browser — off by default</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="auto-resume-enable" ${S.autoResume ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
      </div>

      <!-- ── INTERFACE ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🖥️</div>
          <div>
            <div class="playback-section-title">Interface</div>
            <div class="playback-section-desc">Layout preferences for the player window.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Player bar position</div>
            <div class="playback-row-hint">Move the playback controls and DJ strip to the top or bottom of the window</div>
          </div>
          <div id="bar-pos-seg" class="playback-seg">
            <button class="playback-seg-btn ${!S.barTop ? 'active' : ''}" data-pos="bottom">Bottom</button>
            <button class="playback-seg-btn ${S.barTop  ? 'active' : ''}" data-pos="top">Top</button>
          </div>
        </div>
      </div>

      <!-- ── NAVIGATION ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🗂️</div>
          <div>
            <div class="playback-section-title">Navigation</div>
            <div class="playback-section-desc">Show or hide sections in the sidebar. Settings are synced across devices.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Genres</div>
            <div class="playback-row-hint">Browse your library by genre tag</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="show-genres-enable" ${S.showGenres ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Decades</div>
            <div class="playback-row-hint">Browse your library by release decade</div>
          </div>
          <label class="toggle-sw">
            <input type="checkbox" id="show-decades-enable" ${S.showDecades ? 'checked' : ''}>
            <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
          </label>
        </div>
      </div>

      ${S.allowYoutubeDownload ? `
      <!-- ── YOUTUBE DOWNLOAD ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></div>
          <div>
            <div class="playback-section-title">YouTube Download</div>
            <div class="playback-section-desc">Default audio format when downloading from YouTube. Saved to your recordings folder alongside radio recordings.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Download format</div>
            <div class="playback-row-hint">Opus = original stream, no re-encoding · MP3 = universal, requires ffmpeg</div>
          </div>
          <select class="settings-select" id="ytdl-format-sel">
            <option value="opus" ${(localStorage.getItem(_uKey('ytdl_format')) || 'opus') === 'opus' ? 'selected' : ''}>Opus (original quality)</option>
            <option value="mp3"  ${localStorage.getItem(_uKey('ytdl_format')) === 'mp3' ? 'selected' : ''}>MP3 (universal, re-encoded)</option>
          </select>
        </div>
      </div>` : ''}

    </div>`)

  // Crossfade slider
  const xfSlider = document.getElementById('xf-slider');
  const xfVal    = document.getElementById('xf-val');
  xfSlider.addEventListener('input', () => {
    const v = parseInt(xfSlider.value);
    xfVal.textContent = v === 0 ? 'Off' : v + 's';
    S.crossfade = v;
    localStorage.setItem(_uKey('crossfade'), v);
    const dj = document.getElementById('xf-slider-dj');
    const djv = document.getElementById('xf-val-dj');
    if (dj) { dj.value = v; djv.textContent = v === 0 ? 'Off' : v + 's'; }
    _syncPrefs();
    _syncQueueLabel();
  });

  // Sleep presets
  document.getElementById('sleep-presets').addEventListener('click', e => {
    const btn = e.target.closest('.sleep-preset');
    if (!btn) return;
    const mins = parseInt(btn.dataset.mins);
    setSleepTimer(mins);
    viewPlayback(); // re-render to show active box
  });
  const cancelBtn = document.getElementById('sleep-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { setSleepTimer(0); viewPlayback(); });

  // ReplayGain toggle
  document.getElementById('rg-enable').addEventListener('change', e => {
    S.rgEnabled = e.target.checked;
    S.rgEnabled ? localStorage.setItem(_uKey('rg'), '1') : localStorage.removeItem(_uKey('rg'));
    _syncPrefs();
    if (S.queue[S.idx]) _applyRGGain(S.queue[S.idx]);
    toast(S.rgEnabled ? 'Loudness normalisation: On' : 'Loudness normalisation: Off');
  });

  // Gapless toggle
  document.getElementById('gapless-enable').addEventListener('change', e => {
    S.gapless = e.target.checked;
    S.gapless ? localStorage.setItem(_uKey('gapless'), '1') : localStorage.removeItem(_uKey('gapless'));
    _syncPrefs();
    toast(S.gapless ? 'Gapless playback: On' : 'Gapless playback: Off');
  });

  // Auto-resume toggle
  document.getElementById('auto-resume-enable').addEventListener('change', e => {
    S.autoResume = e.target.checked;
    S.autoResume ? localStorage.setItem(_uKey('auto_resume'), '1') : localStorage.removeItem(_uKey('auto_resume'));
    _syncPrefs();
    toast(S.autoResume ? 'Auto-resume: On' : 'Auto-resume: Off — music will pause on reload');
  });

  // Bar position toggle
  document.getElementById('bar-pos-seg').addEventListener('click', e => {
    const btn = e.target.closest('.playback-seg-btn');
    if (!btn) return;
    S.barTop = btn.dataset.pos === 'top';
    S.barTop ? localStorage.setItem(_uKey('bar_top'), '1') : localStorage.removeItem(_uKey('bar_top'));
    _syncPrefs();
    applyBarPos(S.barTop);
    document.querySelectorAll('#bar-pos-seg .playback-seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.pos === (S.barTop ? 'top' : 'bottom')));
  });

  // Dynamic colours toggle
  document.getElementById('dyn-color-enable').addEventListener('change', e => {
    S.dynColor = e.target.checked;
    // Store '0' when OFF (default is ON — key absent means enabled)
    S.dynColor ? localStorage.removeItem(_uKey('dyn_color')) : localStorage.setItem(_uKey('dyn_color'), '0');
    _syncPrefs();
    if (S.dynColor) {
      _lastThemeUrl = null;  // force re-sample
      _applyAlbumArtTheme(S.queue[S.idx] ? artUrl(S.queue[S.idx]['album-art'], 'l') : null);
    } else {
      _resetAlbumArtTheme();
    }
    toast(S.dynColor ? 'Dynamic colours: On' : 'Dynamic colours: Off');
  });

  // Genres visibility
  document.getElementById('show-genres-enable').addEventListener('change', e => {
    S.showGenres = e.target.checked;
    S.showGenres ? localStorage.removeItem(_uKey('show_genres')) : localStorage.setItem(_uKey('show_genres'), '0');
    _applyNavVisibility();
    _syncPrefs();
    toast(S.showGenres ? 'Genres: visible' : 'Genres: hidden');
  });

  // Decades visibility
  document.getElementById('show-decades-enable').addEventListener('change', e => {
    S.showDecades = e.target.checked;
    S.showDecades ? localStorage.removeItem(_uKey('show_decades')) : localStorage.setItem(_uKey('show_decades'), '0');
    _applyNavVisibility();
    _syncPrefs();
    toast(S.showDecades ? 'Decades: visible' : 'Decades: hidden');
  });

  // YouTube download format preference
  const ytdlFmtSel = document.getElementById('ytdl-format-sel');
  if (ytdlFmtSel) {
    ytdlFmtSel.addEventListener('change', e => {
      e.target.value === 'mp3'
        ? localStorage.setItem(_uKey('ytdl_format'), 'mp3')
        : localStorage.removeItem(_uKey('ytdl_format'));
      _syncPrefs();
      toast(e.target.value === 'mp3' ? 'YouTube format: MP3' : 'YouTube format: Opus');
    });
  }
}

// ── SLEEP TIMER LOGIC ─────────────────────────────────────────
function setSleepTimer(mins) {
  // Cancel any existing timer
  clearInterval(_sleepTimer);
  _sleepTimer = null;
  S.sleepMins = 0;
  S.sleepEndsAt = 0;
  _updateSleepLight();

  if (mins === 0) { localStorage.removeItem(_uKey('sleep_ends')); return; }

  if (mins === -1) {
    // End of current song — trigger when 'ended' fires next
    S.sleepMins = -1;
    S.sleepEndsAt = -1;
    localStorage.setItem(_uKey('sleep_ends'), '-1');
    _showInfoStrip('', '<span class="dj-strip-label">💤 Sleep — will stop after this song</span>', 5000, true);
    _updateSleepLight();
    return;
  }

  S.sleepMins = mins;
  S.sleepEndsAt = Date.now() + mins * 60000;
  localStorage.setItem(_uKey('sleep_ends'), String(S.sleepEndsAt));
  _showInfoStrip('', `<span class="dj-strip-label">💤 Sleep timer set · <strong>${mins} min</strong></span>`, 5000, true);
  _updateSleepLight();

  _sleepTimer = setInterval(() => {
    const remaining = S.sleepEndsAt - Date.now();
    _updateSleepLight();
    // Update the playback view remaining label if visible
    const remEl = document.getElementById('sleep-view-remaining');
    if (remEl) remEl.textContent = Math.max(0, Math.ceil(remaining / 60000)) + ' min remaining';

    if (remaining <= 0) {
      clearInterval(_sleepTimer);
      _sleepTimer = null;
      S.sleepMins = 0;
      _updateSleepLight();
      _sleepFadeOut();
    }
  }, 15000); // update every 15 s
}

function _updateSleepLight() {
  const el = document.getElementById('sleep-light');
  const cd = document.getElementById('sleep-countdown');
  if (!el) return;
  if (S.sleepMins === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (S.sleepMins === -1) {
    cd.textContent = 'end of song';
  } else {
    const mins = Math.max(0, Math.ceil((S.sleepEndsAt - Date.now()) / 60000));
    cd.textContent = mins + 'm';
  }
}

function _sleepFadeOut() {
  // Fade volume to 0 over 10 seconds then pause
  const startVol = audioEl.volume;
  const steps = 40;
  const stepMs = 10000 / steps;
  const dec = startVol / steps;
  let step = 0;
  const iv = setInterval(() => {
    step++;
    audioEl.volume = Math.max(0, startVol - dec * step);
    if (step >= steps) {
      clearInterval(iv);
      audioEl.pause();
      audioEl.volume = startVol; // restore volume for next play
      _showInfoStrip('', '<span class="dj-strip-label">💤 Sleep — playback stopped</span>', 6000, true);
      S.sleepMins = 0;
      _updateSleepLight();
    }
  }, stepMs);
}

// ── RADIO RECORDING ───────────────────────────────────────────
function _recordingVpaths() {
  const meta = S.vpathMeta || {};
  return S.vpaths.filter(v => meta[v]?.type === 'recordings');
}

function _updateRecordBtn() {
  const btn     = document.getElementById('radio-rec-btn');
  const elapsed = document.getElementById('radio-rec-elapsed');
  if (!btn) return;
  const s = S.queue[S.idx];
  const isRadio = !!(s && s.isRadio);
  const canRecord = S.allowRadioRecording && _recordingVpaths().length > 0;
  const shouldShow = isRadio && canRecord;
  btn.classList.toggle('hidden', !shouldShow);
  if (elapsed) elapsed.classList.toggle('hidden', !shouldShow || !S.recordingActive);
  if (shouldShow) {
    btn.classList.toggle('recording', S.recordingActive);
    btn.title = S.recordingActive ? 'Stop recording' : 'Record this stream';
    const inner = btn.querySelector('.rec-icon circle:last-child');
    if (inner) inner.setAttribute('r', S.recordingActive ? '5' : '8');
  }
}

function _recElapsedStr(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function _recurLabel(recurrence, recurDays) {
  if (recurrence === 'daily')    return 'Daily';
  if (recurrence === 'weekdays') return 'Weekdays';
  if (recurrence === 'custom' && recurDays && recurDays.length) {
    const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return recurDays.map(d => names[d]).join(', ');
  }
  return recurrence;
}

function _recModalClose() {
  document.getElementById('radio-rec-modal').classList.add('hidden');
}

function _recModalSwitchTab(tab) {
  document.querySelectorAll('.rec-tab').forEach(btn => {
    btn.classList.toggle('rec-tab-active', btn.dataset.tab === tab);
  });
  document.getElementById('rec-panel-now').classList.toggle('rec-panel-hidden', tab !== 'now');
  document.getElementById('rec-panel-schedule').classList.toggle('rec-panel-hidden', tab !== 'schedule');
}

async function _loadScheduleList() {
  const wrap = document.getElementById('rec-sched-list-wrap');
  const list = document.getElementById('rec-sched-list');
  try {
    const schedules = await api('GET', 'api/v1/radio/schedules');
    if (!schedules.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    list.innerHTML = schedules.map(sc => {
      const when = sc.recurrence === 'once'
        ? `${sc.startDate || ''} ${sc.startTime}`
        : `${_recurLabel(sc.recurrence, sc.recurDays)} @ ${sc.startTime}`;
      const activeDot = sc.active ? `<span class="rec-sched-active-dot">&#9679;</span> ` : '';
      return `<div class="rec-sched-item">
        <div class="rec-sched-item-info">
          <span class="rec-sched-station">${activeDot}${esc(sc.stationName)}</span>
          <span class="rec-sched-when">${esc(when)} &bull; ${sc.durationMinutes} min &bull; ${esc(sc.vpath)}</span>
        </div>
        <div class="rec-sched-item-actions">
          <button class="btn-xs${sc.enabled ? ' btn-xs-on' : ''}" onclick="_recToggleSchedule('${esc(sc.id)}',${sc.enabled})">${sc.enabled ? 'On' : 'Off'}</button>
          <button class="btn-xs btn-xs-del" onclick="_recDeleteSchedule('${esc(sc.id)}')">&#x2715;</button>
        </div>
      </div>`;
    }).join('');
  } catch (_) {
    wrap.style.display = 'none';
  }
}

function _recToggleSchedule(id, currentlyEnabled) {
  api('PATCH', `api/v1/radio/schedules/${id}/enable`, { enabled: !currentlyEnabled })
    .then(() => _loadScheduleList()).catch(() => {});
}

function _recDeleteSchedule(id) {
  api('DELETE', `api/v1/radio/schedules/${id}`)
    .then(() => _loadScheduleList()).catch(() => {});
}

async function _saveSchedule(station, streamUrl) {
  const dtVal = document.getElementById('rec-sched-dt').value;
  if (!dtVal) { _showInfoStrip('', '<span style="color:var(--err)">Please set a start date and time</span>', 4000, true); return; }

  const [datePart, timePart] = dtVal.split('T');
  const startTime = (timePart || '').slice(0, 5);
  const recur     = document.getElementById('rec-sched-recur').value;
  let recurDays   = null;
  if (recur === 'custom') {
    recurDays = [...document.querySelectorAll('#rec-sched-days-wrap input[type=checkbox]:checked')]
      .map(cb => parseInt(cb.value, 10));
    if (!recurDays.length) { _showInfoStrip('', '<span style="color:var(--err)">Select at least one day</span>', 4000, true); return; }
  }

  const vpath = document.getElementById('rec-sched-vpath').value;
  const dur   = parseInt(document.getElementById('rec-sched-dur').value, 10) || 60;
  const rawDesc = (document.getElementById('rec-sched-desc').value || '').trim();
  const description = rawDesc.replace(/\s+/g, '_').replace(/[^\w-]/g, '').slice(0, 80) || null;

  try {
    await api('POST', 'api/v1/radio/schedules', {
      stationName:     station.title || station.artist || 'Radio',
      streamUrl,
      artFile:         station['album-art'] || null,
      vpath,
      startTime,
      startDate:       recur === 'once' ? datePart : null,
      durationMinutes: dur,
      recurrence:      recur,
      recurDays,
      description,
    });
    _showInfoStrip('', '<span>Recording scheduled &#10003;</span>', 3000, true);
    _loadScheduleList();
  } catch (e) {
    _showInfoStrip('', `<span style="color:var(--err)">Schedule failed: ${esc(e.message || '')}</span>`, 5000, true);
  }
}

function _initRecordingModal() {
  // Tab switching
  document.querySelectorAll('.rec-tab').forEach(btn => {
    btn.addEventListener('click', () => _recModalSwitchTab(btn.dataset.tab));
  });

  // Close / cancel buttons
  document.getElementById('radio-rec-modal-close').addEventListener('click', _recModalClose);
  document.getElementById('radio-rec-cancel').addEventListener('click', _recModalClose);
  document.getElementById('rec-sched-cancel').addEventListener('click', _recModalClose);

  // Start recording now
  document.getElementById('radio-rec-start').addEventListener('click', async () => {
    _recModalClose();
    const s = S.queue[S.idx];
    if (!s || !s.isRadio) return;
    const streamUrl = (s._radioLinks && s._radioLinks[s._radioLinkIdx || 0]) || s.filepath;
    const vpath = document.getElementById('radio-rec-vpath').value;
    if (!vpath) return;
    const rawDesc = (document.getElementById('radio-rec-desc').value || '').trim();
    const description = rawDesc.replace(/\s+/g, '_').replace(/[^\w-]/g, '').slice(0, 80) || null;
    try {
      const d = await api('POST', 'api/v1/radio/record/start', {
        url: streamUrl, vpath,
        stationName: s.title || s.artist || 'Radio',
        artFile: s['album-art'] || null,
        description,
      });
      S.recordingActive = true;
      S.recordingId = d.id;
      S.recordingElapsedSec = 0;
      S.recordingMeta = { vpath, art: s['album-art'] || null, title: s.title || s.artist || 'Radio' };
      S._recordingTimer = setInterval(() => {
        S.recordingElapsedSec++;
        const elEl = document.getElementById('radio-rec-elapsed');
        if (elEl) elEl.textContent = _recElapsedStr(S.recordingElapsedSec);
      }, 1000);
      _updateRecordBtn();
      _showInfoStrip('', `<span style="color:var(--err)">&#9679; Recording started &rarr; <em>${esc(d.filename || vpath)}</em></span>`, 5000, true);
    } catch (e) {
      _showInfoStrip('', `<span style="color:var(--err)">Recording failed: ${esc(e.message || '')}</span>`, 6000, true);
    }
  });

  // Save schedule
  document.getElementById('rec-sched-save').addEventListener('click', () => {
    const s = S.queue[S.idx];
    if (!s || !s.isRadio) return;
    const streamUrl = (s._radioLinks && s._radioLinks[s._radioLinkIdx || 0]) || s.filepath;
    _saveSchedule(s, streamUrl);
  });

  // Show/hide day checkboxes when recurrence changes
  document.getElementById('rec-sched-recur').addEventListener('change', e => {
    document.getElementById('rec-sched-days-wrap').classList.toggle('rec-panel-hidden', e.target.value !== 'custom');
  });
}

async function _startRecording() {
  const s = S.queue[S.idx];
  if (!s || !s.isRadio) return;
  // Get the raw stream URL (first link configured for this station)
  const streamUrl = (s._radioLinks && s._radioLinks[s._radioLinkIdx || 0]) || s.filepath || null;
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
    _showInfoStrip('', '<span style="color:var(--err)">No stream URL for this station</span>', 4000, true); return;
  }

  const vpaths = _recordingVpaths();
  if (vpaths.length === 0) { _showInfoStrip('', '<span style="color:var(--err)">No Recordings folder configured</span>', 4000, true); return; }

  // Populate both folder dropdowns
  const vpathOpts = vpaths.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  document.getElementById('radio-rec-vpath').innerHTML = vpathOpts;
  document.getElementById('rec-sched-vpath').innerHTML = vpathOpts;

  // Pre-fill datetime: current local time rounded up to nearest 5 min
  const dt = new Date();
  dt.setMinutes(Math.ceil(dt.getMinutes() / 5) * 5, 0, 0);
  const pad2 = n => String(n).padStart(2, '0');
  document.getElementById('rec-sched-dt').value =
    `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;

  // Clear description fields on every open
  document.getElementById('radio-rec-desc').value = '';
  document.getElementById('rec-sched-desc').value = '';

  // Show modal, activate "Record Now" tab
  _recModalSwitchTab('now');
  document.getElementById('radio-rec-modal').classList.remove('hidden');

  // Load schedule list in background
  _loadScheduleList();
}

async function _stopRecording() {
  if (!S.recordingId) return;
  clearInterval(S._recordingTimer);
  S._recordingTimer = null;
  const meta = S.recordingMeta || {};
  try {
    const d = await api('POST', 'api/v1/radio/record/stop', { id: S.recordingId });
    const dur = d.durationMs ? _recElapsedStr(Math.round(d.durationMs / 1000)) : '';
    const kb  = d.bytesWritten ? ` (${(d.bytesWritten / 1024).toFixed(0)} KB)` : '';
    _showInfoStrip('', `<span>&#9679; Recording saved — ${dur}${kb}</span>`, 6000, true);
  } catch (_) {}
  S.recordingActive = false;
  S.recordingId = null;
  S.recordingElapsedSec = 0;
  S.recordingMeta = null;
  const elEl = document.getElementById('radio-rec-elapsed');
  if (elEl) { elEl.textContent = ''; elEl.classList.add('hidden'); }
  _updateRecordBtn();
}

// ── REPLAYGAIN ────────────────────────────────────────────────
function _applyRGGain(s) {
  if (!_rgGainNode) return;
  if (S.rgEnabled && s && s.replaygain != null) {
    _rgGainNode.gain.value = Math.pow(10, Number(s.replaygain) / 20);
  } else {
    _rgGainNode.gain.value = 1.0;
  }
}

// ── WAVEFORM SCRUBBER ─────────────────────────────────────────
// ── WAVEFORM LOCALSTORAGE CACHE ───────────────────────────────
// Key prefix; value is a JSON array of 800 integers (0-255), ~2 KB each.
const _WF_LS_PREFIX = 'wf:';
function _wfLsGet(filepath) {
  try {
    const raw = localStorage.getItem(_WF_LS_PREFIX + filepath);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch (_e) { return null; }
}
function _wfLsSet(filepath, data) {
  try { localStorage.setItem(_WF_LS_PREFIX + filepath, JSON.stringify(data)); } catch (_e) {}
}

async function _fetchWaveform(filepath) {
  if (!filepath || /^https?:\/\//i.test(filepath)) { _waveformData = null; _waveformFp = null; _drawWaveform(); return; }
  if (_waveformFp === filepath) { _drawWaveform(); return; }   // in-memory cache

  // Check localStorage before going to the server
  const cached = _wfLsGet(filepath);
  if (cached) {
    _waveformData = cached;
    _waveformFp   = filepath;
    _drawWaveform();
    if (!audioEl.paused) _startWaveformRaf();
    return;
  }

  _waveformData = null;
  _waveformFp   = null;
  _drawWaveform();  // clear canvas while loading

  const wfStatus = document.getElementById('wf-status');
  if (wfStatus) { wfStatus.textContent = 'Generating waveform…'; wfStatus.classList.add('visible'); }

  try {
    const d = await api('GET', `api/v1/db/waveform?filepath=${encodeURIComponent(filepath)}`);
    if (d.waveform && d.waveform.length > 0) {
      _waveformData = d.waveform;
      _waveformFp   = filepath;
      _wfLsSet(filepath, d.waveform);   // persist for future page loads
      _drawWaveform();
      if (!audioEl.paused) _startWaveformRaf();
    }
  } catch(_e) { /* waveform unavailable — silent fail */ } finally {
    if (wfStatus) { wfStatus.textContent = ''; wfStatus.classList.remove('visible'); }
  }
}

function _drawWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  if (W <= 0 || H <= 0) return;
  // Only resize backing store when dimensions change — avoids clearing at 60 fps
  if (canvas.width !== W)  canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  // Toggle .wf-active so CSS hides the plain gradient fill while canvas is active
  const track = canvas.parentElement;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // ── Radio: live spectrum, logarithmic frequency scale (smooth, 0.82 TC) ──
  if (S.queue[S.idx]?.isRadio) {
    // Spectrum off — show flat line, never bleed previous song's waveform data through
    if (!analyserL || !_radioSpectrumEnabled) {
      if (track) track.classList.remove('wf-active');
      return;
    }
    if (track) track.classList.add('wf-active');
    const binCount = analyserL.frequencyBinCount; // fftSize/2 = 1024
    const freqData = new Uint8Array(binCount);
    analyserL.getByteFrequencyData(freqData);
    const midY   = H / 2;
    const cs     = getComputedStyle(document.documentElement);
    const colPri = cs.getPropertyValue('--primary').trim();
    const colAcc = cs.getPropertyValue('--accent').trim();
    const grad   = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, colPri);
    grad.addColorStop(1, colAcc);
    ctx.fillStyle = grad;
    // Log scale: map output bars to frequency bins logarithmically.
    // minBin=4 (~86 Hz at 44.1kHz/2048) — skips sub-bass noise/codec artifacts at DC/21/43/65 Hz.
    // maxBin=50% of bins → ~10.7 kHz, covers the full audible range for music.
    const minBin  = 4;
    const maxBin  = Math.floor(binCount * 0.5);
    const numBars = Math.min(W, 256); // cap bars so each is at least a few px wide
    const barW    = W / numBars;
    const drawW   = Math.max(1, barW > 2 ? barW - 1 : barW);
    for (let b = 0; b < numBars; b++) {
      // Logarithmic bin index for this bar (b=0 = bass, b=numBars-1 = treble)
      const bin  = Math.round(minBin * Math.pow(maxBin / minBin, b / (numBars - 1)));
      const val    = freqData[Math.min(bin, binCount - 1)];
      const x      = ((numBars - 1 - b) / numBars) * W;
      // Gentle taper: bass (b=0) → 0.6×, treble (b=max) → 1.0× via sqrt curve.
      // Compensates for naturally higher bass energy without crushing audible bass hits.
      const weight = 0.6 + 0.4 * Math.pow(b / (numBars - 1), 0.5);
      const barH   = Math.max(2, (val / 255) * weight * midY * 1.6);
      ctx.fillRect(x, midY - barH / 2, drawW, barH);
    }
    return;
  }

  if (track) track.classList.toggle('wf-active', !!(_waveformData && _waveformData.length));
  if (!_waveformData || _waveformData.length === 0) return;

  const data   = _waveformData;
  const pct    = audioEl.duration > 0 ? audioEl.currentTime / audioEl.duration : 0;
  const splitX = pct * W;
  const midY   = H / 2;
  const barW   = W / data.length;
  const drawW  = Math.max(1, barW > 2 ? barW - 1 : barW);

  // Read theme colours from CSS variables so the waveform respects light/dark mode
  const cs      = getComputedStyle(document.documentElement);
  const colPri  = cs.getPropertyValue('--primary').trim();   // e.g. #8b5cf6
  const colAcc  = cs.getPropertyValue('--accent').trim();    // e.g. #60a5fa
  // Gradient matches the progress-fill bar: --primary left → --accent right
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, colPri);
  grad.addColorStop(1, colAcc);

  // Pass 1 — played region: clip left of splitX, fill with gradient
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, H);
  ctx.clip();
  ctx.fillStyle = grad;
  for (let i = 0; i < data.length; i++) {
    const x    = (i / data.length) * W;
    const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
    ctx.fillRect(x, midY - barH / 2, drawW, barH);
  }
  ctx.restore();

  // Pass 2 — unplayed region: clip right of splitX, fill dim
  const html = document.documentElement;
  const unplayedAlpha = html.classList.contains('light')
    ? 'rgba(0,0,0,0.22)'
    : html.classList.contains('dark')
      ? 'rgba(255,255,255,0.28)'
      : 'rgba(255,255,255,0.35)';  // Velvet — navy bg needs stronger contrast
  ctx.save();
  ctx.beginPath();
  ctx.rect(splitX, 0, W - splitX, H);
  ctx.clip();
  ctx.fillStyle = unplayedAlpha;
  for (let i = 0; i < data.length; i++) {
    const x    = (i / data.length) * W;
    const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
    ctx.fillRect(x, midY - barH / 2, drawW, barH);
  }
  ctx.restore();
}

function _updateWaveformProgress() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas || !_waveformData) return;
  _drawWaveform();
}

// ── WAVEFORM RAF LOOP — drives smooth real-time split during playback ─────────
let _waveformRaf = null;
function _startWaveformRaf() {
  if (_waveformRaf) return;
  (function loop() {
    _drawWaveform();
    _waveformRaf = requestAnimationFrame(loop);
  }());
}
function _stopWaveformRaf() {
  if (_waveformRaf) { cancelAnimationFrame(_waveformRaf); _waveformRaf = null; }
  _drawWaveform(); // final redraw at resting position
}

// ── DYNAMIC ALBUM-ART COLOUR THEMING ─────────────────────────
let _lastThemeUrl = null;

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [h, s, l];
}

function _resetAlbumArtTheme() {
  document.documentElement.style.removeProperty('--primary');
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--primary-fg');
}

function _applyAlbumArtTheme(url) {
  if (!S.dynColor) { _resetAlbumArtTheme(); _lastThemeUrl = null; return; }
  if (!url) { _resetAlbumArtTheme(); _lastThemeUrl = null; return; }
  if (url === _lastThemeUrl) return;
  _lastThemeUrl = url;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      // 32×32 = 1024 pixels — enough detail to distinguish hues without heavy blur.
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, 32, 32);
      const px = cx.getImageData(0, 0, 32, 32).data;

      // Divide the hue wheel into 36 buckets (10° each).
      // Score each bucket by Σ s² — rewards colours that are both vibrant AND prevalent.
      const BUCKETS = 36;
      const score = new Float64Array(BUCKETS);
      const sumH  = new Float64Array(BUCKETS);
      const sumS  = new Float64Array(BUCKETS);
      const sumL  = new Float64Array(BUCKETS);
      const cnt   = new Int32Array(BUCKETS);

      for (let i = 0; i < px.length; i += 4) {
        const [h, s, l] = _rgbToHsl(px[i], px[i+1], px[i+2]);
        if (l > 0.88 || l < 0.08) continue;   // skip near-white / near-black
        if (s < 0.12) continue;                // skip near-grey
        const b = Math.min(Math.floor(h * BUCKETS), BUCKETS - 1);
        score[b] += s * s;   // s² rewards both frequency and vibrancy
        sumH[b]  += h;
        sumS[b]  += s;
        sumL[b]  += l;
        cnt[b]++;
      }

      // Pick the winning bucket
      let bestBucket = -1, bestScore = 0;
      for (let b = 0; b < BUCKETS; b++) {
        if (score[b] > bestScore) { bestScore = score[b]; bestBucket = b; }
      }

      // No vibrant pixels at all — colourless cover, fall back to defaults
      if (bestBucket < 0 || cnt[bestBucket] === 0) { _resetAlbumArtTheme(); return; }

      // Average H, S, L across all pixels in the winning bucket
      const n    = cnt[bestBucket];
      const avgH = sumH[bestBucket] / n;
      const avgS = sumS[bestBucket] / n;
      const avgL = sumL[bestBucket] / n;

      if (avgS < 0.18) { _resetAlbumArtTheme(); return; }

      // Clamp lightness/saturation so colours are readable at all times
      const l    = Math.min(Math.max(avgL, 0.42), 0.68);
      const s    = Math.min(Math.max(avgS, 0.45), 0.90);
      const hDeg = Math.round(avgH * 360);

      // Accent: rotate hue 35° and slightly shift lightness for contrast
      const aHDeg = (hDeg + 35) % 360;
      const aL    = Math.min(Math.max(l + (l < 0.55 ? 0.10 : -0.06), 0.42), 0.72);
      const primary = `hsl(${hDeg},${Math.round(s * 100)}%,${Math.round(l * 100)}%)`;
      const accent  = `hsl(${aHDeg},${Math.round(s * 100)}%,${Math.round(aL * 100)}%)`;

      // --primary-fg: forced into readable lightness range for text on card backgrounds
      // Dark mode card ~#1a1a26 → L≥0.65 | Light mode card ~#dcdcec → L≤0.40
      const isLight = document.documentElement.classList.contains('light');
      const fgL   = isLight ? Math.min(avgL, 0.40) : Math.max(avgL, 0.65);
      const fgS   = Math.min(Math.max(avgS, 0.55), 0.95);
      const primaryFg = `hsl(${hDeg},${Math.round(fgS * 100)}%,${Math.round(fgL * 100)}%)`;

      document.documentElement.style.setProperty('--primary', primary);
      document.documentElement.style.setProperty('--accent',  accent);
      document.documentElement.style.setProperty('--primary-fg', primaryFg);
      _updateBadgeFg();
    } catch(_e) {}
  };
  img.onerror = () => { _resetAlbumArtTheme(); };
  img.src = url;
}

// ── MEDIA SESSION API ─────────────────────────────────────────
function _updateMediaSession(s) {
  if (!('mediaSession' in navigator) || !s) return;
  try {
    const artwork = [];
    const u = artUrl(s['album-art'], 'l');
    if (u) artwork.push({ src: location.origin + u, sizes: '512x512', type: 'image/jpeg' });
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  s.title  || s.filepath?.split('/').pop() || '',
      artist: s.artist || '',
      album:  s.album  || '',
      artwork
    });
  } catch(_e) {}
}

// ── GAPLESS PLAYBACK ──────────────────────────────────────────
// Strategy: two Web Audio GainNodes, one per element. Both feed the same
// downstream graph (they sum). We schedule an instantaneous gain swap at
// the computed end-time using setValueAtTime — sample-accurate, no polling.
// 80ms before end we start the pre-buffered xEl playing at gain=0 so
// the audio pipeline is flowing when the scheduled swap fires at endAt.
function _startGapless(nextIdx) {
  if (_xfadeFired) return;
  _xfadeFired    = true;
  _xfadeNextIdx  = nextIdx;
  _xfadeStartVol = audioEl.volume;
  _syncQueueLabel();
  VIZ.initAudio();
  const xEl = _getOrCreateXfadeEl();
  _connectXfadeToAudio();  // creates _nextElGain at gain=0
  const next = S.queue[nextIdx];
  if (!next) { _xfadeFired = false; return; }
  xEl.preload = 'auto';
  xEl.src     = mediaUrl(next.filepath);
  xEl.load();
  xEl.volume  = audioEl.volume;

  // Schedule setTimeout to fire 80ms before the track ends.
  // At that moment: start xEl (pipeline flows at gain=0), then schedule
  // the instantaneous gain flip at endAt using the Web Audio clock.
  const WARMUP_MS = 80;
  const remaining = audioEl.duration > 0 ? audioEl.duration - audioEl.currentTime : 5;
  clearTimeout(_gaplessTimer);
  _gaplessTimer = setTimeout(() => {
    _gaplessTimer = null;
    if (!_xfadeFired || !_xfadeEl || !audioCtx || !_curElGain || !_nextElGain) return;
    const r = audioEl.duration - audioEl.currentTime;
    if (r <= 0) return;
    const endAt = audioCtx.currentTime + r;
    // Use a 20ms linear ramp instead of a hard cut.
    // 2ms is enough to kill high-frequency clicks but bass content (~50Hz =
    // 20ms/cycle) can still be mid-peak and cause a thump. 20ms covers one
    // full cycle of 50Hz so the waveform always passes through near-zero
    // before the gain reaches 0.  20ms is below the threshold of perception
    // as a deliberate fade — nobody hears it as a crossfade.
    const RAMP = 0.020;
    _curElGain.gain.cancelScheduledValues(audioCtx.currentTime);
    _curElGain.gain.setValueAtTime(1.0, audioCtx.currentTime);  // pin current
    _curElGain.gain.setValueAtTime(1.0, endAt);                 // hold until swap
    _curElGain.gain.linearRampToValueAtTime(0.0, endAt + RAMP);
    _nextElGain.gain.cancelScheduledValues(audioCtx.currentTime);
    _nextElGain.gain.setValueAtTime(0.0, audioCtx.currentTime); // pin current
    _nextElGain.gain.setValueAtTime(0.0, endAt);                // hold until swap
    _nextElGain.gain.linearRampToValueAtTime(1.0, endAt + RAMP);
    _xfadeEl.play().catch(() => {});  // flows at gain=0 until endAt
  }, Math.max(0, remaining * 1000 - WARMUP_MS));
}

// ── CROSSFADE LOGIC ───────────────────────────────────────────
// _xfadeEl is connected to the SAME Web Audio graph as audioEl (both go
// through _audioGain → EQ → analysers → destination).  It starts the next
// track at volume 0; the ramp brings _xfadeEl up and audioEl down.
// When audioEl fires 'ended', _doXfadeHandoff does a TRUE element swap:
//   audioEl = _xfadeEl  (already playing, no gap, no reload)
// Event listeners are detached from the old element and attached to the new one.

function _getOrCreateXfadeEl() {
  if (_xfadeEl) return _xfadeEl;
  _xfadeEl = document.createElement('audio');
  _xfadeEl.volume = 0;
  _xfadeEl.style.display = 'none';
  document.body.appendChild(_xfadeEl);
  _xfadeWired = false;
  return _xfadeEl;
}

function _connectXfadeToAudio() {
  if (_xfadeWired || !_audioGain || !_xfadeEl) return;
  try {
    const xSrc = audioCtx.createMediaElementSource(_xfadeEl);
    // Each element gets its own GainNode so we can schedule an instantaneous
    // volume swap on both at a computed Web Audio timestamp — sample-accurate.
    _nextElGain = audioCtx.createGain();
    _nextElGain.gain.value = 0;
    xSrc.connect(_nextElGain);
    _nextElGain.connect(_rgGainNode ?? _audioGain);
    _xfadeWired = true;
  } catch(e) { /* already connected or no audioCtx */ }
}

// ── VISUAL CROSSFADE (album art + track info) ────────────────
// Fades the incoming track's art and text in sync with the audio xfade so
// there is no hard visual switch — the album art crossfades like a dissolve
// and the title/artist text fades out then back in with the new values.

function _startArtXfade(nextIdx, durationMs) {
  const s = S.queue[nextIdx];
  if (!s) return;
  const dur = (durationMs / 1000).toFixed(2) + 's';

  // Helper: same double-rAF trick that makes the art overlay work perfectly.
  // 1) snapshot old content into an absolute overlay → fade it OUT (1 → 0)
  // 2) write new content into real elements at opacity:0 → fade them IN (0 → 1)
  // Both start at the exact same moment, same duration — a true dissolve.
  function _dissolveText(containerSel, ids, newValues) {
    const container = document.querySelector(containerSel);
    if (!container) return;

    // Remove any leftover overlay from a previous (interrupted) xfade
    container.querySelectorAll('.xf-text-out').forEach(e => e.remove());

    // Build outgoing overlay from current element content
    const outEl = document.createElement('div');
    outEl.className = 'xf-text-out';
    outEl.style.transition = `opacity ${dur} ease-in-out`;
    ids.forEach(id => {
      const real = document.getElementById(id);
      if (!real) return;
      const clone = real.cloneNode(true);
      clone.removeAttribute('id');
      outEl.appendChild(clone);
    });
    container.appendChild(outEl);

    // Write new values into real elements immediately, hold at opacity:0
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      const nv = newValues[i];
      if (nv !== null) {
        el.textContent = nv.text;
        el.classList.toggle('hidden', !!nv.hidden);
      }
      el.style.transition = 'none';
      el.style.opacity = '0';
    });

    // Force a synchronous reflow to commit opacity:0 before starting the
    // transitions. This works even when the tab is in the background —
    // unlike requestAnimationFrame which freezes completely when hidden.
    void container.offsetHeight;
    outEl.style.opacity = '0';
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.transition = `opacity ${dur} ease-in-out`;
      el.style.opacity = '1';
    });
    // Remove overlay after transition completes
    setTimeout(() => outEl.remove(), durationMs + 150);
  }

  // ── Player-bar album art overlay (unchanged — already perfect) ─────────────
  const artEl = document.getElementById('player-art');
  if (artEl) {
    artEl.querySelectorAll('.xf-art').forEach(e => e.remove());
    const u = artUrl(s['album-art'], 'l');
    const ov = document.createElement('div');
    ov.className = 'xf-art';
    ov.style.transition = `opacity ${dur} ease-in-out`;
    ov.innerHTML = u ? `<img src="${u}" alt="">` : noArtHtml();
    artEl.appendChild(ov);
    void ov.offsetHeight; // force reflow — works in background tabs
    ov.style.opacity = '1';
  }

  // ── Player-bar text dissolve ───────────────────────────────────────────────
  const albumYear = [s.album, s.year].filter(Boolean).join(' · ');
  _dissolveText('.player-info',
    ['player-title', 'player-artist', 'player-album'],
    [
      { text: s.title  || s.filepath?.split('/').pop() || '—', hidden: false },
      { text: s.artist || '',                                   hidden: false },
      { text: albumYear,                                        hidden: !albumYear },
    ]
  );

  // ── NP modal (if open) ────────────────────────────────────────────────────
  if (!document.getElementById('np-modal').classList.contains('hidden')) {
    const npArtEl = document.getElementById('np-art');
    if (npArtEl) {
      npArtEl.querySelectorAll('.xf-art').forEach(e => e.remove());
      const u = artUrl(s['album-art'], 'l');
      const ov = document.createElement('div');
      ov.className = 'xf-art';
      ov.style.transition = `opacity ${dur} ease-in-out`;
      ov.innerHTML = u ? `<img src="${u}" alt="">` : noArtHtml();
      npArtEl.appendChild(ov);
      void ov.offsetHeight; // force reflow — works in background tabs
      ov.style.opacity = '1';
    }
    const npSub = [s.album, s.year].filter(Boolean).join(' · ');
    _dissolveText('.np-info',
      ['np-title', 'np-artist', 'np-album'],
      [
        { text: s.title  || s.filepath?.split('/').pop() || '—', hidden: false },
        { text: s.artist || '',                                   hidden: false },
        { text: npSub,                                            hidden: !npSub },
      ]
    );
  }
}

function _cancelArtXfade() {
  document.querySelectorAll('.xf-art, .xf-text-out').forEach(e => e.remove());
  ['player-title','player-artist','player-album','np-title','np-artist','np-album'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = '';
    el.style.opacity = '';
  });
}

function _finishArtXfade() {
  // Art overlays: removed when updateBar() replaces #player-art innerHTML.
  // Text overlays (.xf-text-out): still fading out on their own — leave them,
  //   the setTimeout inside _dissolveText will remove them when done.
  // Real text elements: already show new content and are fading in (opacity
  //   transitioning 0→1). updateBar() will re-write the same text (no change).
  // Just schedule a cleanup so no inline opacity lingers after the animation.
  setTimeout(() => {
    ['player-title','player-artist','player-album','np-title','np-artist','np-album'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.transition = ''; el.style.opacity = ''; }
    });
  }, (S.crossfade * 1000) + 300);
}

// ── Auto-DJ dice throw ──────────────────────────────────────────────────────
// Throws a tumbling 3D die for the entire crossfade duration.
function _throwDjDice(xfSec) {
  if (!S.autoDJ || !S.djDice || !_webAnimSupported) return;
  const wrap = document.getElementById('dj-dice');
  if (!wrap) return;
  const cube = wrap.querySelector('.dj-dice-cube');
  if (!cube) return;

  // Cancel any in-flight animation
  try { if (wrap._djw) wrap._djw.cancel(); } catch(_){}
  try { if (cube._djc) cube._djc.cancel(); } catch(_){}
  (wrap._djTimers || []).forEach(t => clearTimeout(t));
  wrap._djTimers = [];

  // Total time = full crossfade, clamped 3-20 s
  const totalMs = Math.max(3000, Math.min((xfSec || S.crossfade) * 1000, 20000));

  // Random rotations — multiples of 90° so it lands on a face
  // Use many turns (10–16) so the initial spin looks forcefully thrown
  const signX = Math.random() > .5 ? 1 : -1;
  const signY = Math.random() > .5 ? 1 : -1;
  const rx = signX * (10 + Math.ceil(Math.random() * 6)) * 90;
  const ry = signY * (10 + Math.ceil(Math.random() * 6)) * 90;

  // Land 60–88 % of viewport width to the left
  const throwFrac = 0.60 + Math.random() * 0.28;
  const arcX = -Math.floor(window.innerWidth * throwFrac);
  // High arc
  const arcY = -(260 + Math.floor(Math.random() * 180));

  // ─ Phase timing ───────────
  // Flight is short — the die arrives fast like a real throw (25% of total)
  const flightMs = Math.floor(totalMs * 0.25);
  const b1Ms    = Math.floor(totalMs * 0.14);    // bounce 1 (big)
  const b2Ms    = Math.floor(totalMs * 0.09);    // bounce 2 (medium)
  const b3Ms    = Math.floor(totalMs * 0.06);    // bounce 3 (small)
  const b4Ms    = Math.floor(totalMs * 0.04);    // bounce 4 (tiny skitter)
  const restMs  = totalMs - flightMs - b1Ms - b2Ms - b3Ms - b4Ms; // rest + fade

  const tx = `${arcX}px`;

  // Pre-compute ALL bounce rotations as multiples of 90° so the die always
  // lands perfectly face-flat — never balancing on an edge or corner.
  const b1rx = rx   + signX * (2 + Math.floor(Math.random() * 2)) * 90;  // +180° or +270°
  const b1ry = ry   + signY * (2 + Math.floor(Math.random() * 2)) * 90;
  const b2rx = b1rx + signX * (1 + Math.floor(Math.random() * 2)) * 90;  // +90°  or +180°
  const b2ry = b1ry + signY * (1 + Math.floor(Math.random() * 2)) * 90;
  const b3rx = b2rx + signX * 90;   // still rolling (+90° — die is decelerating)
  const b3ry = b2ry + signY * 90;
  // b4: die is nearly settled — no more rotation, just a tiny positional bounce

  // ─ Flight arc — fast cubic-bezier to snap it to landing quickly ──────────
  wrap._djw = wrap.animate([
    { opacity: 0, transform: `translate(0px,30px) scale(.18)` },
    { opacity: 1, transform: `translate(${arcX * .22}px,${arcY}px) scale(1.35)`,        offset: .22 },
    { opacity: 1, transform: `translate(${arcX * .62}px,${arcY * .20}px) scale(1.14)`,  offset: .65 },
    { opacity: 1, transform: `translate(${tx},0px) scale(1.0)` },
  ], { duration: flightMs, easing: 'cubic-bezier(.18,.8,.4,1)', fill: 'forwards' });

  // Cube spin during flight — very front-heavy: 85% of rotation in first 15%,
  // then nearly stops — like a real throw losing angular momentum in mid-air.
  cube._djc = cube.animate([
    { transform: `rotateX(0deg) rotateY(0deg)` },
    { transform: `rotateX(${rx * .85}deg) rotateY(${ry * .85}deg)`, offset: .15 },
    { transform: `rotateX(${rx * .95}deg) rotateY(${ry * .95}deg)`, offset: .38 },
    { transform: `rotateX(${rx * .99}deg) rotateY(${ry * .99}deg)`, offset: .65 },
    { transform: `rotateX(${rx}deg)       rotateY(${ry}deg)` },
  ], { duration: flightMs, easing: 'linear', fill: 'forwards' });

  // ─ Bounce 1 – large ──────────
  wrap._djTimers.push(setTimeout(() => {
    wrap.animate([
      { transform: `translate(${tx},0px) scale(1.0)` },
      { transform: `translate(${tx},-78px) scale(1.14)`, offset: .45 },
      { transform: `translate(${tx},0px) scale(0.92)` },
    ], { duration: b1Ms, easing: 'cubic-bezier(.25,0,.55,1)', fill: 'forwards' });
    // ease-in-out: still spinning freely, not settling yet
    cube.animate([
      { transform: `rotateX(${rx}deg)   rotateY(${ry}deg)` },
      { transform: `rotateX(${b1rx}deg) rotateY(${b1ry}deg)` },
    ], { duration: b1Ms, easing: 'ease-in-out', fill: 'forwards' });
  }, flightMs));

  // ─ Bounce 2 – medium ────────
  wrap._djTimers.push(setTimeout(() => {
    wrap.animate([
      { transform: `translate(${tx},0px) scale(0.92)` },
      { transform: `translate(${tx},-38px) scale(1.06)`, offset: .45 },
      { transform: `translate(${tx},0px) scale(0.96)` },
    ], { duration: b2Ms, easing: 'cubic-bezier(.25,0,.55,1)', fill: 'forwards' });
    // ease-in-out: still visible spin, losing energy
    cube.animate([
      { transform: `rotateX(${b1rx}deg) rotateY(${b1ry}deg)` },
      { transform: `rotateX(${b2rx}deg) rotateY(${b2ry}deg)` },
    ], { duration: b2Ms, easing: 'ease-in-out', fill: 'forwards' });
  }, flightMs + b1Ms));

  // ─ Bounce 3 – small ─────────
  wrap._djTimers.push(setTimeout(() => {
    wrap.animate([
      { transform: `translate(${tx},0px) scale(0.96)` },
      { transform: `translate(${tx},-16px) scale(1.03)`, offset: .45 },
      { transform: `translate(${tx},0px) scale(0.98)` },
    ], { duration: b3Ms, easing: 'cubic-bezier(.25,0,.55,1)', fill: 'forwards' });
    // ease-out: decelerates into a face — the die is settling
    cube.animate([
      { transform: `rotateX(${b2rx}deg) rotateY(${b2ry}deg)` },
      { transform: `rotateX(${b3rx}deg) rotateY(${b3ry}deg)` },
    ], { duration: b3Ms, easing: 'ease-out', fill: 'forwards' });
  }, flightMs + b1Ms + b2Ms));

  // ─ Bounce 4 – tiny skitter — die is settled, no rotation ──
  wrap._djTimers.push(setTimeout(() => {
    wrap.animate([
      { transform: `translate(${tx},0px) scale(0.98)` },
      { transform: `translate(${tx},-5px) scale(1.01)`, offset: .45 },
      { transform: `translate(${tx},0px) scale(1.0)` },
    ], { duration: b4Ms, easing: 'cubic-bezier(.25,0,.55,1)', fill: 'forwards' });
    // Hold the face-flat final position — no extra rotation
    cube.animate([
      { transform: `rotateX(${b3rx}deg) rotateY(${b3ry}deg)` },
      { transform: `rotateX(${b3rx}deg) rotateY(${b3ry}deg)` },
    ], { duration: b4Ms, fill: 'forwards' });
  }, flightMs + b1Ms + b2Ms + b3Ms));

  // ─ Rest then fade out at end of crossfade ──────
  wrap._djTimers.push(setTimeout(() => {
    const fadeMs = Math.max(500, restMs);
    const out = wrap.animate([
      { opacity: 1, transform: `translate(${tx},0px) scale(1.0)` },
      { opacity: 0, transform: `translate(${tx},-18px) scale(.55)` },
    ], { duration: fadeMs, delay: Math.max(0, restMs - fadeMs), easing: 'ease-in', fill: 'forwards' });
    out.onfinish = () => {
      try { wrap._djw.cancel(); cube._djc.cancel(); } catch(_){}
    };
  }, flightMs + b1Ms + b2Ms + b3Ms + b4Ms));
}

function _startCrossfade(nextIdx) {
  if (_xfadeFired) return;
  _xfadeFired    = true;
  _throwDjDice(S.crossfade);    // toss the die for the full crossfade duration
  _dismissInfoStrip();          // clear DJ strip before crossfade visuals take over
  _xfadeNextIdx  = nextIdx;
  _xfadeStartVol = audioEl.volume;
  _syncQueueLabel();

  const xf     = S.crossfade;
  const steps  = Math.max(20, xf * 10);
  const stepMs = (xf * 1000) / steps;

  VIZ.initAudio();               // ensure audioCtx + _audioGain exist
  const xEl  = _getOrCreateXfadeEl();
  _connectXfadeToAudio();         // wire xfadeEl into the Web Audio graph
  const next = S.queue[nextIdx];
  if (!next) { _xfadeFired = false; return; }
  xEl.src = mediaUrl(next.filepath);
  xEl.play().catch(() => {});

  // Kick off the visual dissolve in parallel with the audio ramp
  _startArtXfade(nextIdx, xf * 1000);

  clearInterval(_xfadeGainIv);
  _xfadeGainIv = null;

  if (audioCtx && _curElGain && _nextElGain) {
    // ── Web Audio path: hardware-scheduled equal-power gain curves ───────────
    // Both elements play at full user volume; gain nodes handle the blend.
    // setValueCurveAtTime is sample-accurate — no audible stepping.
    xEl.volume = _xfadeStartVol;
    const N = 256; // curve resolution — 256 points is more than sufficient
    const curCurve = new Float32Array(N);
    const nxtCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      curCurve[i] = Math.cos(t * Math.PI / 2); // 1 → 0  (outgoing)
      nxtCurve[i] = Math.sin(t * Math.PI / 2); // 0 → 1  (incoming)
    }
    _curElGain.gain.cancelScheduledValues(audioCtx.currentTime);
    _nextElGain.gain.cancelScheduledValues(audioCtx.currentTime);
    _curElGain.gain.setValueAtTime(1, audioCtx.currentTime);
    _nextElGain.gain.setValueAtTime(0, audioCtx.currentTime);
    _curElGain.gain.setValueCurveAtTime(curCurve, audioCtx.currentTime, xf);
    _nextElGain.gain.setValueCurveAtTime(nxtCurve, audioCtx.currentTime, xf);
    // No interval needed — AudioContext handles everything on the audio thread.
  } else {
    // ── Fallback: setInterval ramp (no Web Audio, e.g. CleverTouch) ──────────
    xEl.volume = 0;
    let step = 0;
    _xfadeGainIv = setInterval(() => {
      step++;
      const pct = Math.min(step / steps, 1);
      audioEl.volume = Math.max(0, _xfadeStartVol * Math.cos(pct * Math.PI / 2));
      xEl.volume     = Math.min(_xfadeStartVol, _xfadeStartVol * Math.sin(pct * Math.PI / 2));
      if (step >= steps) { clearInterval(_xfadeGainIv); _xfadeGainIv = null; }
    }, stepMs);
  }
}

// Called exclusively from the 'ended' handler when _xfadeFired is true.
// _xfadeEl is already playing the next track through Web Audio.
// We do a true element swap: retire the old audioEl, promote _xfadeEl to
// be the new audioEl, reattach all event listeners — zero gap, no reload.
function _doXfadeHandoff(nextIdx) {
  clearInterval(_xfadeGainIv);
  _xfadeGainIv = null;

  const vol     = _xfadeStartVol;   // preserve whatever volume was set — including 0
  const newEl   = _xfadeEl;
  const oldEl   = audioEl;

  // Clear crossfade state
  _xfadeFired    = false;
  _xfadeNextIdx  = -1;
  _xfadeStartVol = 0;
  _xfadeWired    = false;
  _xfadeEl       = null;
  clearTimeout(_gaplessTimer);
  _gaplessTimer  = null;

  // Swap per-element gain nodes: incoming element now owns _curElGain.
  // Cancel any scheduled values and lock both gains into their final state.
  const oldCurGain = _curElGain;
  _curElGain  = _nextElGain;
  _nextElGain = null;
  if (_curElGain)  { _curElGain.gain.cancelScheduledValues(0);  _curElGain.gain.value  = 1; }
  if (oldCurGain)  { oldCurGain.gain.cancelScheduledValues(0);  oldCurGain.gain.value  = 0; }

  S.idx = nextIdx;
  const s = S.queue[nextIdx];

  // Detach all permanent listeners from the old element
  _detachAudioListeners(oldEl);
  // Silence + pause the old element (it's no longer 'audioEl')
  oldEl.volume = 0;
  oldEl.pause();
  // Don't clear oldEl.src — leave it for GC; removing src can cause a brief noise

  // Promote the new element
  audioEl = newEl;
  audioEl.volume = vol;

  // Re-attach all permanent listeners to the new element
  _attachAudioListeners(audioEl);
  // Both gapless and crossfade: xEl is already playing (started before handoff).
  if (audioEl.paused) audioEl.play().catch(() => {});
  VU_NEEDLE.start();
  syncPlayIcons();

  // Wrapped: the outgoing track completed naturally through crossfade/gapless.
  // _onAudioEnded returned early so play-end was never sent — do it now.
  if (_wrappedEventId) {
    const eid = _wrappedEventId;
    _wrappedEventId = null;
    api('POST', 'api/v1/wrapped/play-end', {
      eventId:  eid,
      playedMs: Math.max(0, Math.round(((oldEl.duration || 0) - _wrappedTrackStartOffset) * 1000)),
    }).catch(() => {});
  }

  if (!s) return;

  // Apply ReplayGain and load waveform for the incoming track
  _applyRGGain(s);
  _fetchWaveform(s.filepath);

  // Update UI / persistence (mirrors Player.playAt without touching audio)
  Player.updateBar();
  _finishArtXfade();
  highlightRow();
  refreshQueueUI();
  loadCuePoints(s.filepath);
  clearTimeout(scrobbleTimer);
  (function(){ const el = document.getElementById('np-scrobble-status'); if (el) { el.textContent = ''; el.className = 'np-scrobble-status'; } })();
  if (!s.isRadio && !s.isPodcast) {
    api('POST', 'api/v1/db/stats/log-play', { filePath: s.filepath }).catch(() => {});
    // Wrapped: start tracking the incoming crossfade track
    _wrappedEndedNaturally = false;
    _wrappedTrackStartOffset = 0;
    api('POST', 'api/v1/wrapped/play-start', {
      filePath:  s.filepath,
      sessionId: _wrappedSessionId,
      source:    _wrappedSource(),
    }).then(r => { _wrappedEventId = r?.eventId ?? null; }).catch(() => {});
  }
  if ((S.lastfmEnabled || (S.listenbrainzEnabled && S.listenbrainzLinked)) && !s.isRadio && !s.isPodcast) {
    if (S.listenbrainzEnabled && S.listenbrainzLinked) {
      api('POST', 'api/v1/listenbrainz/playing-now', { filePath: s.filepath }).catch(() => {});
    }
    scrobbleTimer = setTimeout(async () => {
      const scrobbleEl = document.getElementById('np-scrobble-status');
      const msgs = [];
      if (S.lastfmEnabled) {
        try {
          await api('POST', 'api/v1/lastfm/scrobble-by-filepath', { filePath: s.filepath });
          msgs.push('Last.fm ✓');
        } catch (e) { msgs.push('Last.fm: ' + (e?.message || 'failed')); }
      }
      if (S.listenbrainzEnabled && S.listenbrainzLinked) {
        try {
          await api('POST', 'api/v1/listenbrainz/scrobble-by-filepath', { filePath: s.filepath });
          msgs.push('ListenBrainz ✓');
        } catch (e) { msgs.push('ListenBrainz: ' + (e?.message || 'failed')); }
      }
      if (scrobbleEl && msgs.length) {
        const ok = msgs.every(m => m.endsWith('✓'));
        scrobbleEl.textContent = msgs.join(' · ');
        scrobbleEl.className = 'np-scrobble-status ' + (ok ? 'np-scrobble-ok' : 'np-scrobble-err');
      }
    }, 30000);
  }
  persistQueue();
  _syncQueueToDb();
}

function _resetXfade() {
  _cancelArtXfade();   // restore visuals if xfade is cancelled mid-dissolve
  const wasActive = _xfadeFired;
  const savedVol  = _xfadeStartVol;
  _xfadeFired    = false;
  _xfadeNextIdx  = -1;
  _xfadeStartVol = 0;
  _xfadeWired    = false;
  clearInterval(_xfadeGainIv);
  _xfadeGainIv = null;
  clearTimeout(_gaplessTimer);
  _gaplessTimer = null;
  if (_xfadeEl) { _xfadeEl.pause(); _xfadeEl.src = ''; _xfadeEl = null; }
  // Cancel any scheduled gain values and restore clean state
  if (_nextElGain) { _nextElGain.gain.cancelScheduledValues(0); _nextElGain.gain.value = 0; _nextElGain = null; }
  if (_curElGain)  { _curElGain.gain.cancelScheduledValues(0);  _curElGain.gain.value  = 1; }
  // Restore volume if the ramp was interrupted mid-way by a manual action
  if (wasActive && savedVol > 0) audioEl.volume = savedVol;
  // If we aborted a crossfade, re-sync the label back to Now Playing / Paused
  if (wasActive) _syncQueueLabel();
}

// ── SCAN STATUS ───────────────────────────────────────────────
function _scpTruncate(fp, max = 45) {
  if (!fp) return '';
  if (fp.length <= max) return fp;
  return '\u2026' + fp.slice(-(max - 1));
}

function _renderScanProgress(scans) {
  const wrap = document.getElementById('scan-progress-wrap');
  if (!wrap) return;
  if (!scans || scans.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = scans.map(sp => {
    const isCounting = sp.countingFound > 0 && sp.scanned === 0;
    const pctTxt   = isCounting ? 'Counting\u2026'
                   : sp.pct !== null ? `${sp.pct}%` : 'first scan';
    const bar      = isCounting || sp.pct === null
      ? `<div class="spc-fill-ind"></div>`
      : `<div class="spc-fill" style="width:${sp.pct}%"></div>`;
    const countTxt = isCounting
      ? `${sp.countingFound.toLocaleString()} files found\u2026`
      : sp.expected
        ? `${sp.scanned.toLocaleString()} / ${sp.expected.toLocaleString()}`
        : `${sp.scanned.toLocaleString()} files`;
    const fileTip  = sp.currentFile ? ` title="${sp.currentFile.replace(/"/g,'&quot;')}"` : '';
    return `<div class="spc-card"${fileTip}>
      <span class="spc-dot"></span>
      <span class="spc-vpath">${sp.vpath}</span>
      <div class="spc-track">${bar}</div>
      <span class="spc-pct">${pctTxt}</span>
      <span class="spc-count">${countTxt}</span>
    </div>`;
  }).join('');
}

async function pollScan() {
  try {
    const d = await api('GET', 'api/v1/db/status');
    // Populate S.vpaths from status if checkSession() didn't do it yet
    if (d.vpaths && d.vpaths.length && !S.vpaths.length) {
      S.vpaths = d.vpaths;
      if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
      else {
        S.djVpaths = S.djVpaths.filter(v => S.vpaths.includes(v));
        if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
      }
      if (S.view === 'autodj') viewAutoDJ();
    }
    if (S.isAdmin && d.locked) {
      try {
        const prog = await api('GET', 'api/v1/admin/db/scan/progress');
        _renderScanProgress(prog);
      } catch(_) {
        // fallback: plain badge text if progress endpoint fails
        _renderScanProgress([{ vpath: 'Scanning…', pct: null, scanned: d.totalFileCount || 0, expected: null, currentFile: null }]);
      }
      scanTimer = setTimeout(pollScan, 3000);
    } else {
      _renderScanProgress([]);
    }
  } catch(_) {}
}

// ── SERVER SETTINGS SYNC ─────────────────────────────────────
// Collects all user prefs currently in localStorage into one plain object.
// Values are the raw localStorage strings (null = key absent).
function _collectPrefs() {
  const u = S.username || '';
  return {
    theme:             localStorage.getItem('ms2_theme_'          + u),
    bar_top:           localStorage.getItem('ms2_bar_top_'        + u),
    auto_resume:       localStorage.getItem('ms2_auto_resume_'    + u),
    dyn_color:         localStorage.getItem('ms2_dyn_color_'      + u),
    time_flipped:      localStorage.getItem('ms2_time_flipped_'   + u),
    vol:               localStorage.getItem('ms2_vol_'            + u),
    balance:           localStorage.getItem('ms2_balance_'        + u),
    crossfade:         localStorage.getItem('ms2_crossfade_'      + u),
    gapless:           localStorage.getItem('ms2_gapless_'        + u),
    rg:                localStorage.getItem('ms2_rg_'             + u),
    eq:                localStorage.getItem('ms2_eq_'             + u),
    eq_on:             localStorage.getItem('ms2_eq_on_'          + u),
    trans:             localStorage.getItem('ms2_trans_'          + u),
    trans_bitrate:     localStorage.getItem('ms2_trans_bitrate_'  + u),
    trans_codec:       localStorage.getItem('ms2_trans_codec_'    + u),
    vu_mode:           localStorage.getItem('ms2_vu_mode_'        + u),
    ppm_bright:        localStorage.getItem('ms2_ppm_bright_'     + u),
    ref:               localStorage.getItem('ms2_ref_'            + u),
    spec_style:        localStorage.getItem('ms2_spec_style_'     + u),
    repeat:            localStorage.getItem('ms2_repeat_'         + u),
    autodj:            localStorage.getItem('ms2_autodj_'         + u),
    dj_similar:        localStorage.getItem('ms2_dj_similar_'     + u),
    dj_dice:           localStorage.getItem('ms2_dj_dice_'        + u),
    dj_min_rating:     localStorage.getItem('ms2_dj_min_rating_'  + u),
    dj_vpaths:         localStorage.getItem('ms2_dj_vpaths_'      + u),
    dj_filter_on:      localStorage.getItem('ms2_dj_filter_on_'   + u),
    dj_filter_words:   localStorage.getItem('ms2_dj_filter_words_'+ u),
    dj_ignore:         localStorage.getItem('ms2_dj_ignore_'      + u),
    dj_artist_history: localStorage.getItem('ms2_dj_artist_history_' + u),
    show_genres:  localStorage.getItem('ms2_show_genres_'  + u),
    show_decades: localStorage.getItem('ms2_show_decades_' + u),
    home_order:   localStorage.getItem('ms2_home_order_'   + u),
    home_hidden:  localStorage.getItem('ms2_home_hidden_'  + u),
    mute:         localStorage.getItem('ms2_mute_'          + u),
    shuffle:      localStorage.getItem('ms2_shuffle_'       + u),
  };
}

let _syncPrefsTimer = null;
function _syncPrefs() {
  if (!S.token || !S.username) return;
  clearTimeout(_syncPrefsTimer);
  _syncPrefsTimer = setTimeout(() => {
    api('POST', 'api/v1/user/settings', { prefs: _collectPrefs() })
      .then(() => localStorage.setItem('ms2_settings_pushed_' + S.username, new Date().toISOString()))
      .catch(() => {});
  }, 1500);
}

let _syncQueueTimer = null;
function _syncQueue() {
  // Kept for backwards-compat call sites; delegates to _syncQueueToDb.
  _syncQueueToDb();
}

async function _loadServerSettings() {
  if (!S.token) return;
  try {
    const data = await api('GET', 'api/v1/user/settings');
    localStorage.setItem('ms2_settings_pulled_' + S.username, new Date().toISOString());
    _applyServerSettings(data);
    // Push the full merged localStorage back to the DB so any prefs set in
    // previous sessions (before server sync was active) are not lost.
    api('POST', 'api/v1/user/settings', { prefs: _collectPrefs() })
      .then(() => localStorage.setItem('ms2_settings_pushed_' + S.username, new Date().toISOString()))
      .catch(() => {});
  } catch(_) {}
}

function _applyServerSettings(data) {
  const prefs = data?.prefs || {};
  const u     = S.username || '';
  const ls    = (k, v) => (v == null || v === '') ? localStorage.removeItem(k) : localStorage.setItem(k, v);

  if (prefs.theme         != null) { ls('ms2_theme_' + u, prefs.theme); applyTheme(prefs.theme, false); }
  if (prefs.bar_top       != null) { ls('ms2_bar_top_' + u, prefs.bar_top); S.barTop = prefs.bar_top === '1'; applyBarPos(S.barTop); }
  if (prefs.auto_resume   != null) { ls('ms2_auto_resume_' + u, prefs.auto_resume); S.autoResume = prefs.auto_resume === '1'; }
  if (prefs.dyn_color     != null) { ls('ms2_dyn_color_' + u, prefs.dyn_color); S.dynColor = prefs.dyn_color !== '0'; }
  if (prefs.time_flipped  != null) { ls('ms2_time_flipped_' + u, prefs.time_flipped); S.timeFlipped = prefs.time_flipped === '1'; }
  if (prefs.vol != null) {
    ls('ms2_vol_' + u, prefs.vol);
    // initVolume() is an IIFE that ran before login — apply directly
    const vv = parseInt(prefs.vol || '80', 10);
    audioEl.volume = vv / 100;
    const volEl = document.getElementById('volume');
    if (volEl) { volEl.value = vv; _setVolPct(vv); }
  }
  if (prefs.balance != null) {
    ls('ms2_balance_' + u, prefs.balance);
    // initBalance() is an IIFE that ran before login — apply directly
    const bv = parseFloat(prefs.balance || '0');
    if (_pannerNode) _pannerNode.pan.value = bv;
    const balEl = document.getElementById('balance');
    if (balEl) balEl.value = Math.round(bv * 100);
  }
  if (prefs.crossfade     != null) { ls('ms2_crossfade_' + u, prefs.crossfade); S.crossfade = parseInt(prefs.crossfade || '0'); }
  if (prefs.gapless       != null) { ls('ms2_gapless_' + u, prefs.gapless); S.gapless = prefs.gapless === '1'; }
  if (prefs.rg            != null) { ls('ms2_rg_' + u, prefs.rg); S.rgEnabled = prefs.rg === '1'; }
  if (prefs.eq            != null) ls('ms2_eq_' + u, prefs.eq);
  if (prefs.eq_on         != null) ls('ms2_eq_on_' + u, prefs.eq_on);
  if (prefs.trans         != null) { ls('ms2_trans_' + u, prefs.trans); S.transEnabled = !!prefs.trans; }
  if (prefs.trans_bitrate != null) { ls('ms2_trans_bitrate_' + u, prefs.trans_bitrate); S.transBitrate = prefs.trans_bitrate || ''; }
  if (prefs.trans_codec   != null) { ls('ms2_trans_codec_' + u, prefs.trans_codec); S.transCodec = prefs.trans_codec || ''; }
  if (prefs.vu_mode       != null) ls('ms2_vu_mode_' + u, prefs.vu_mode);
  if (prefs.ppm_bright    != null) ls('ms2_ppm_bright_' + u, prefs.ppm_bright);
  if (prefs.ref           != null) ls('ms2_ref_' + u, prefs.ref);
  if (prefs.spec_style    != null) ls('ms2_spec_style_' + u, prefs.spec_style);
  if (prefs.repeat != null) { ls('ms2_repeat_' + u, prefs.repeat); S.repeat = prefs.repeat || 'off'; _syncRepeatIcon(); }
  if (prefs.autodj        != null) ls('ms2_autodj_' + u, prefs.autodj);
  if (prefs.dj_similar    != null) { ls('ms2_dj_similar_' + u, prefs.dj_similar); S.djSimilar = prefs.dj_similar === '1'; }
  if (prefs.dj_dice       != null) { ls('ms2_dj_dice_' + u, prefs.dj_dice); S.djDice = prefs.dj_dice === '1'; }
  if (prefs.dj_min_rating != null) { ls('ms2_dj_min_rating_' + u, prefs.dj_min_rating); S.djMinRating = parseInt(prefs.dj_min_rating || '0'); }
  if (prefs.dj_vpaths     != null) {
    ls('ms2_dj_vpaths_' + u, prefs.dj_vpaths);
    try { const v = JSON.parse(prefs.dj_vpaths); if (Array.isArray(v) && v.length) S.djVpaths = v.filter(x => S.vpaths.includes(x)); } catch(_) {}
    if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
  }
  if (prefs.dj_filter_on  != null) { ls('ms2_dj_filter_on_' + u, prefs.dj_filter_on); S.djFilterEnabled = prefs.dj_filter_on === '1'; }
  if (prefs.dj_filter_words != null) {
    ls('ms2_dj_filter_words_' + u, prefs.dj_filter_words);
    try { S.djFilterWords = JSON.parse(prefs.dj_filter_words) || []; } catch(_) {}
  }
  if (prefs.dj_ignore     != null) {
    ls('ms2_dj_ignore_' + u, prefs.dj_ignore);
    try { S.djIgnore = JSON.parse(prefs.dj_ignore) || []; } catch(_) {}
  }
  if (prefs.dj_artist_history != null) {
    ls('ms2_dj_artist_history_' + u, prefs.dj_artist_history);
    try { S.djArtistHistory = JSON.parse(prefs.dj_artist_history) || []; } catch(_) {}
  }
  if (prefs.show_genres  != null) { ls('ms2_show_genres_'  + u, prefs.show_genres);  S.showGenres  = prefs.show_genres  !== '0'; }
  if (prefs.show_decades != null) { ls('ms2_show_decades_' + u, prefs.show_decades); S.showDecades = prefs.show_decades !== '0'; }
  // Home view layout — shelf order and hidden cards synced across devices
  if (prefs.home_order  != null) ls('ms2_home_order_'  + u, prefs.home_order);
  if (prefs.home_hidden != null) ls('ms2_home_hidden_' + u, prefs.home_hidden);
  if (prefs.shuffle != null) {
    ls('ms2_shuffle_' + u, prefs.shuffle);
    S.shuffle = prefs.shuffle === '1';
    document.getElementById('shuffle-btn')?.classList.toggle('active', S.shuffle);
  }
  if (prefs.mute != null) {
    ls('ms2_mute_' + u, prefs.mute);
    if (prefs.mute === '1') {
      _preMuteVol = audioEl.volume;
      audioEl.volume = 0;
      const volEl = document.getElementById('volume');
      if (volEl) { volEl.value = 0; _setVolPct(0); }
      document.getElementById('mute-btn')?.classList.add('muted');
      document.getElementById('vol-icon-on')?.classList.add('hidden');
      document.getElementById('vol-icon-off')?.classList.remove('hidden');
    }
  }
  _applyNavVisibility();
  // Queue: the DB is the source of truth — always restore from it on load.
  // This ensures any browser/device always picks up whatever was last playing.
  // Guard: never interrupt active playback — only restore when paused so that
  // a visibility-change triggered settings refresh doesn't reload the audio
  // element and pause a song that is currently playing.
  const queueKey = _queueKey();
  if (!audioEl.paused) {
    // Audio is playing — just keep localStorage up to date, don't call restoreQueue
    if (data?.queue && Array.isArray(data.queue.queue) && data.queue.queue.length && queueKey) {
      let localSavedAt = 0;
      try { const r = localStorage.getItem(queueKey); if (r) localSavedAt = JSON.parse(r)?.savedAt || 0; } catch(_) {}
      if ((data.queue.savedAt || 0) > localSavedAt) {
        try { localStorage.setItem(queueKey, JSON.stringify(data.queue)); } catch(_) {}
      }
    }
  } else if (data?.queue && Array.isArray(data.queue.queue) && data.queue.queue.length && queueKey) {
    // Always persist server queue to localStorage so restoreQueue() (called by
    // showApp on boot, or by the visibilitychange handler when server is newer)
    // always has fresh data.  Never call restoreQueue() directly from here —
    // the boot path calls it after checkSession returns; the visibility-change
    // handler calls it only after a savedAt comparison.
    try { localStorage.setItem(queueKey, JSON.stringify(data.queue)); } catch(_) {}
  }
}

// ── AUTH ──────────────────────────────────────────────────────
async function tryLogin(username, password) {
  const d = await api('POST', 'api/v1/auth/login', { username, password });
  S.token    = d.token;
  S.username = username;
  S.vpaths   = d.vpaths || [];
  // Only default to all vpaths if no saved selection exists
  const _savedDjVpaths = JSON.parse(localStorage.getItem(_djKey('vpaths')) || 'null');
  S.djVpaths = (_savedDjVpaths && _savedDjVpaths.length) ? _savedDjVpaths.filter(v => S.vpaths.includes(v)).concat() : [...S.vpaths];
  if (S.djVpaths.length === 0) S.djVpaths = [...S.vpaths];
  localStorage.setItem('ms2_token', d.token);
  localStorage.setItem('token', d.token);   // mirror for admin panel compatibility
  localStorage.setItem('ms2_user',  username);
  localStorage.removeItem('ms2_logged_out');
  // Detect admin role after login
  try {
    await api('GET', 'api/v1/admin/directories');
    S.isAdmin = true;
    try { const dc = await api('GET', 'api/v1/admin/discogs/config'); S.discogsEnabled = dc?.enabled === true; S.discogsAllowUpdate = dc?.allowArtUpdate === true; S.allowId3Edit = dc?.allowId3Edit === true; } catch(_) { S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
  } catch(_) { S.isAdmin = false; S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
  try { const ls = await api('GET', 'api/v1/lastfm/status'); S.lastfmEnabled = ls?.serverEnabled !== false; S.lastfmHasApiKey = ls?.hasApiKey === true; } catch(_) { S.lastfmEnabled = true; S.lastfmHasApiKey = false; }
  // If similar-artists was saved on but there's no API key, clear it so AutoDJ doesn't try to use it
  if (!S.lastfmHasApiKey && S.djSimilar) { S.djSimilar = false; localStorage.removeItem(_uKey('dj_similar')); }
  try { const lb = await api('GET', 'api/v1/listenbrainz/status'); S.listenbrainzEnabled = lb?.serverEnabled === true; S.listenbrainzLinked = lb?.linked === true; } catch(_) { S.listenbrainzEnabled = false; S.listenbrainzLinked = false; }
  try { const rd = await api('GET', 'api/v1/radio/enabled'); S.radioEnabled = rd?.enabled === true; } catch(_) { S.radioEnabled = false; }
  S.feedsEnabled = true; // Podcasts always available — user needs the section to add their first feed
  await _loadServerSettings();
}

async function checkSession() {
  if (S.token) {
    // Restore username from localStorage so queue key resolves correctly
    if (!S.username) S.username = localStorage.getItem('ms2_user') || '';
    try {
      const d = await api('GET', 'api/v1/db/status');
      S.vpaths = d.vpaths || [];
      // Restore saved djVpaths; filter out any vpaths no longer on this server,
      // then fall back to all if none remain valid.
      if (S.djVpaths.length === 0) {
        S.djVpaths = [...S.vpaths];
      } else {
        S.djVpaths = S.djVpaths.filter(v => S.vpaths.includes(v));
        if (S.djVpaths.length === 0) S.djVpaths = [...S.vpaths];
      }
      // detect admin by trying the admin endpoint
      try {
        await api('GET', 'api/v1/admin/directories');
        S.isAdmin = true;
        try { const dc = await api('GET', 'api/v1/admin/discogs/config'); S.discogsEnabled = dc?.enabled === true; S.discogsAllowUpdate = dc?.allowArtUpdate === true; S.allowId3Edit = dc?.allowId3Edit === true; } catch(_) { S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
      } catch(_) { S.isAdmin = false; S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
      const [ls, lb, rd] = await Promise.all([
        api('GET', 'api/v1/lastfm/status').catch(() => null),
        api('GET', 'api/v1/listenbrainz/status').catch(() => null),
        api('GET', 'api/v1/radio/enabled').catch(() => null),
      ]);
      S.lastfmEnabled       = ls?.serverEnabled !== false;
      S.lastfmHasApiKey     = ls?.hasApiKey === true;
      S.listenbrainzEnabled = lb?.serverEnabled === true;
      S.listenbrainzLinked  = lb?.linked === true;
      S.radioEnabled        = rd?.enabled === true;
      S.feedsEnabled = true; // Podcasts always available — user needs the section to add their first feed
      await _loadServerSettings();
      return true;
    } catch(e) {
      if (e.status === 401) { S.token = ''; localStorage.removeItem('ms2_token'); }
    }
  }
  // Fallback for genuine no-auth servers (no users configured at all).
  // Block it if the user explicitly logged out — they must re-enter credentials.
  if (localStorage.getItem('ms2_logged_out')) { return false; }
  try {
    const r = await fetch('/api/v1/db/status');
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      S.vpaths   = d.vpaths || [];
      if (S.djVpaths.length === 0) {
        S.djVpaths = [...S.vpaths];
      } else {
        S.djVpaths = S.djVpaths.filter(v => S.vpaths.includes(v));
        if (S.djVpaths.length === 0) S.djVpaths = [...S.vpaths];
      }
      // User authenticated via cookie (e.g. arrived from classic UI).
      // Extract the token from the cookie so WS connections and token-based
      // API calls work correctly — the cookie is NOT httpOnly so JS can read it.
      if (!S.token) {
        const m = document.cookie.match(/(?:^|;\s*)x-access-token=([^;]+)/);
        if (m) {
          S.token = decodeURIComponent(m[1]);
          // Also decode the username from the JWT payload (middle segment)
          try {
            const payload = JSON.parse(atob(S.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
            if (payload.username && !S.username) {
              S.username = payload.username;
              localStorage.setItem('ms2_user', S.username);
            }
          } catch(_) {}
          localStorage.setItem('ms2_token', S.token);
          localStorage.setItem('token', S.token);   // mirror for admin panel compatibility
        }
      }
      await _loadServerSettings();
      // On a no-auth server (no users configured), the server grants admin to
      // everyone — detect this so the admin button and scan button appear.
      try {
        await api('GET', 'api/v1/admin/directories');
        S.isAdmin = true;
        try { const dc = await api('GET', 'api/v1/admin/discogs/config'); S.discogsEnabled = dc?.enabled === true; S.discogsAllowUpdate = dc?.allowArtUpdate === true; S.allowId3Edit = dc?.allowId3Edit === true; } catch(_) { S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
      } catch(_) { S.isAdmin = false; S.discogsEnabled = false; S.discogsAllowUpdate = false; S.allowId3Edit = false; }
      const [ls2, lb2, rd2] = await Promise.all([
        api('GET', 'api/v1/lastfm/status').catch(() => null),
        api('GET', 'api/v1/listenbrainz/status').catch(() => null),
        api('GET', 'api/v1/radio/enabled').catch(() => null),
      ]);
      S.lastfmEnabled       = ls2?.serverEnabled !== false;
      S.lastfmHasApiKey     = ls2?.hasApiKey === true;
      S.listenbrainzEnabled = lb2?.serverEnabled === true;
      S.listenbrainzLinked  = lb2?.linked === true;
      S.radioEnabled        = rd2?.enabled === true;
      S.feedsEnabled = true; // Podcasts are always available — user needs section to add first feed
      return true;
    }
  } catch(_) {}
  return false;
}

let _adminWin = null;
function openAdminPanel() {
  if (_adminWin && !_adminWin.closed) {
    _adminWin.focus();
  } else {
    _adminWin = window.open('/admin', 'mstream-admin');
  }
}

function showApp() {
  // ── Boot overlay: show while queue/waveform restore is in progress ──────
  const _bootEl  = document.getElementById('boot-overlay');
  const _bootSt  = document.getElementById('boot-status');
  const _bootSkip = document.getElementById('boot-skip-btn');
  function _bootMsg(m) { if (_bootSt) _bootSt.textContent = m; }
  let _bootOnDismiss = null; // callback fired once after boot overlay fades
  function _bootDismiss() {
    if (!_bootEl || _bootEl.classList.contains('boot-fade')) return;
    _bootEl.classList.add('boot-fade');
    setTimeout(() => {
      _bootEl.classList.add('hidden');
      if (_bootOnDismiss) { _bootOnDismiss(); _bootOnDismiss = null; }
    }, 600);
  }
  if (_bootEl) _bootEl.classList.remove('hidden');
  _bootMsg('Loading your library…');
  // Skip button appears after 2.5 s for slow connections
  const _skipShowT = setTimeout(() => { if (_bootSkip) _bootSkip.classList.remove('hidden'); }, 2500);
  if (_bootSkip) _bootSkip.onclick = () => { clearTimeout(_skipShowT); _bootDismiss(); };
  // Hard timeout — always dismiss after 6 s no matter what
  const _bootHardT = setTimeout(() => _bootDismiss(), 6000);

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  if (S.isAdmin) {
    document.getElementById('scan-btn').classList.remove('hidden');
    document.getElementById('admin-panel-btn').classList.remove('hidden');
    if (S.discogsEnabled) document.getElementById('discogs-nav-btn').classList.remove('hidden');
  }
  if (S.lastfmEnabled) document.getElementById('lastfm-nav-btn').classList.remove('hidden');
  if (S.listenbrainzEnabled) document.getElementById('listenbrainz-nav-btn')?.classList.remove('hidden');
  if (S.radioEnabled) {
    document.getElementById('radio-nav-btn').classList.remove('hidden');
  }
  _updateListenSection();
  // Mark queue btn active (panel is visible by default)
  document.getElementById('queue-btn').classList.add('active');
  _initQueueListeners();
  loadPlaylists();
  loadSmartPlaylists();
  viewHome();
  refreshQueueUI();
  restoreQueue(/*silent=*/true);
  // Boot overlay dismiss — wait for audio seek (waveform position restored) or fall back.
  // Radio items are not preloaded on restore (no seek position) so skip the seeked wait.
  const _restoredSong = S.queue.length > 0 && S.idx >= 0 ? S.queue[S.idx] : null;
  if (S.queue.length) {
    _bootOnDismiss = () => _showInfoStrip('✓',
      `<span class="dj-strip-label">Queue restored</span><span class="dj-strip-sep">·</span><span class="dj-strip-queued">${S.queue.length}</span><span class="dj-strip-title">&nbsp;song${S.queue.length !== 1 ? 's' : ''}</span>`,
      5000);
  }
  if (_restoredSong && !_restoredSong.isRadio) {
    _bootMsg('Restoring your session\u2026');
    audioEl.addEventListener('seeked', function _onBootSeeked() {
      audioEl.removeEventListener('seeked', _onBootSeeked);
      clearTimeout(_bootHardT); clearTimeout(_skipShowT);
      _bootMsg('Ready!');
      setTimeout(_bootDismiss, 450);
    }, { once: true });
  } else {
    // No track to restore (or radio) — dismiss as soon as the library view is painted
    clearTimeout(_bootHardT); clearTimeout(_skipShowT);
    requestAnimationFrame(() => requestAnimationFrame(_bootDismiss));
  }
  // Restore Auto-DJ play history before re-enabling so the DJ doesn't re-play recent songs
  const _savedIgnore = JSON.parse(localStorage.getItem(_djKey('ignore')) || 'null');
  if (_savedIgnore) S.djIgnore = _savedIgnore;
  // Restore auto-DJ state from previous session
  if (localStorage.getItem(_uKey('autodj'))) { setAutoDJ(true, /*skipAutoStart=*/true); }
  // Guarantee a save on F5 / tab close
  window.addEventListener('beforeunload', () => {
    persistQueue(); // always update localStorage
    // Flush exact current position to DB synchronously via sendBeacon so an
    // immediate F5 restores to the right spot (not up to 15 s behind).
    if (S.token && S.username) {
      const payload = JSON.stringify({ queue: {
        queue:   S.queue,
        idx:     S.idx,
        time:    audioEl.currentTime || 0,
        playing: !audioEl.paused,
        savedAt: Date.now(),
      }});
      navigator.sendBeacon('/api/v1/user/settings?token=' + encodeURIComponent(S.token),
        new Blob([payload], { type: 'application/json' }));
      // Wrapped: fire play-stop + session-end on tab/window close
      if (_wrappedEventId) {
        const stopPayload = JSON.stringify({ eventId: _wrappedEventId, playedMs: Math.max(0, Math.round(((audioEl.currentTime || 0) - _wrappedTrackStartOffset) * 1000)) });
        navigator.sendBeacon('/api/v1/wrapped/play-stop?token=' + encodeURIComponent(S.token), new Blob([stopPayload], { type: 'application/json' }));
      }
      if (_wrappedRadioEventId) {
        const radioPayload = JSON.stringify({ eventId: _wrappedRadioEventId, listenedMs: Date.now() - _wrappedRadioStartMs });
        navigator.sendBeacon('/api/v1/wrapped/radio-stop?token=' + encodeURIComponent(S.token), new Blob([radioPayload], { type: 'application/json' }));
      }
      if (_wrappedPodcastEventId) {
        const podPayload = JSON.stringify({ eventId: _wrappedPodcastEventId, playedMs: Math.round((audioEl.currentTime || 0) * 1000), completed: false });
        navigator.sendBeacon('/api/v1/wrapped/podcast-end?token=' + encodeURIComponent(S.token), new Blob([podPayload], { type: 'application/json' }));
      }
      const sessPayload = JSON.stringify({ sessionId: _wrappedSessionId });
      navigator.sendBeacon('/api/v1/wrapped/session-end?token=' + encodeURIComponent(S.token), new Blob([sessPayload], { type: 'application/json' }));
    }
  });
  // Restore sleep timer if still running from a previous session
  const _savedSleepEnds = parseInt(localStorage.getItem(_uKey('sleep_ends')) || '0');
  if (_savedSleepEnds === -1) { setSleepTimer(-1); }
  else if (_savedSleepEnds > Date.now()) { setSleepTimer(Math.ceil((_savedSleepEnds - Date.now()) / 60000)); }
  pollScan();
  VU_NEEDLE.init();

  // Re-check feature flags when returning to this tab (e.g. after changing
  // settings in the admin panel which opens in a separate tab).
  // Initialise to now so any visibilitychange that fires during the boot
  // sequence (e.g. background tab becoming active) is suppressed for 30 s.
  let _lastVisRefresh = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - _lastVisRefresh < 30000) return;
    _lastVisRefresh = now;
    // Admin-only flags (Discogs)
    if (S.isAdmin) {
      try {
        const dc = await api('GET', 'api/v1/admin/discogs/config');
        const wasDiscogsEnabled = S.discogsEnabled;
        S.discogsEnabled    = dc?.enabled === true;
        S.discogsAllowUpdate = dc?.allowArtUpdate === true;
        S.allowId3Edit = dc?.allowId3Edit === true;
        const discogsBtn = document.getElementById('discogs-nav-btn');
        if (discogsBtn) {
          if (S.discogsEnabled) discogsBtn.classList.remove('hidden');
          else discogsBtn.classList.add('hidden');
        }
        if (wasDiscogsEnabled && !S.discogsEnabled) {
          document.getElementById('np-left')?.classList.remove('np-left--picking');
          const dsEl = document.getElementById('np-discogs-section');
          if (dsEl) { dsEl.classList.add('hidden'); dsEl.dataset.songFp = ''; }
        }
      } catch (_) {}
    }
    // All-user flag: Last.fm server enabled/disabled
    try {
      const ls = await api('GET', 'api/v1/lastfm/status');
      S.lastfmEnabled = ls?.serverEnabled !== false;
      S.lastfmHasApiKey = ls?.hasApiKey === true;
      const lastfmBtn = document.getElementById('lastfm-nav-btn');
      if (lastfmBtn) {
        if (S.lastfmEnabled) lastfmBtn.classList.remove('hidden');
        else lastfmBtn.classList.add('hidden');
      }
    } catch (_) {}
    // All-user flag: ListenBrainz server enabled/status
    try {
      const lb = await api('GET', 'api/v1/listenbrainz/status');
      S.listenbrainzEnabled = lb?.serverEnabled === true;
      S.listenbrainzLinked  = lb?.linked === true;
      const lbBtn = document.getElementById('listenbrainz-nav-btn');
      if (lbBtn) {
        if (S.listenbrainzEnabled) lbBtn.classList.remove('hidden');
        else lbBtn.classList.add('hidden');
      }
    } catch (_) {}
    // All-user flag: Radio enabled/disabled
    try {
      const rd = await api('GET', 'api/v1/radio/enabled');
      S.radioEnabled = rd?.enabled === true;
      const radioBtn = document.getElementById('radio-nav-btn');
      if (radioBtn) {
        if (S.radioEnabled) radioBtn.classList.remove('hidden');
        else radioBtn.classList.add('hidden');
      }
    } catch (_) {}

    // ── Queue + prefs sync from server ───────────────────────────────────────
    // Single GET fetches both queue and prefs. Apply prefs (home order/hidden
    // etc.) unconditionally; apply queue only when paused AND server copy is
    // newer (i.e. another device played songs while this tab was backgrounded).
    try {
      const settings = await api('GET', 'api/v1/user/settings');
      // Read localSavedAt BEFORE _applyServerSettings writes new data to
      // localStorage — otherwise the comparison below would always be equal.
      const _qk = _queueKey();
      let _localSavedAt = 0;
      if (_qk && settings?.queue?.queue?.length && audioEl.paused) {
        try { const _r = localStorage.getItem(_qk); if (_r) _localSavedAt = JSON.parse(_r)?.savedAt || 0; } catch (_) {}
      }
      if (settings?.prefs) _applyServerSettings(settings);
      if (audioEl.paused && settings?.queue?.queue?.length) {
        const srv = settings.queue;
        if ((srv.savedAt || 0) > _localSavedAt) {
          if (_qk) localStorage.setItem(_qk, JSON.stringify(srv));
          restoreQueue(true);
        }
      }
    } catch (_) {}

    // ── Home view refresh ─────────────────────────────────────────────────────
    // Re-fetch home shelves (recently played, most played, etc.) if the home
    // view is currently open so data from other devices shows up immediately.
    if (S.view === 'home') viewHome();
  });
  // Fetch ping to get transcode server info + vpath metadata
  api('GET', 'api/v1/ping').then(d => {
    if (d.transcode) {
      S.transInfo = {
        serverEnabled:    true,
        defaultCodec:     d.transcode.defaultCodec     || '',
        defaultBitrate:   d.transcode.defaultBitrate   || '',
      };
    } else {
      S.transInfo = { serverEnabled: false };
    }
    // Store vpath parent/child metadata for Auto-DJ child-vpath optimisation
    if (d.vpathMetaData) {
      S.vpathMeta = d.vpathMetaData;
      // Re-filter DJ vpath selection now that audio-books types are known
      const musicOnly = _musicVpaths();
      if (musicOnly.length < S.vpaths.length) {
        S.djVpaths = S.djVpaths.filter(v => musicOnly.includes(v));
        if (S.djVpaths.length === 0) S.djVpaths = [...musicOnly];
      }
      // Show podcasts section if this user has any audio-books or recordings vpaths
      const abVpaths  = S.vpaths.filter(v => S.vpathMeta[v]?.type === 'audio-books');
      const recVpaths = S.vpaths.filter(v => S.vpathMeta[v]?.type === 'recordings' || S.vpathMeta[v]?.type === 'youtube');
      S.audiobooksEnabled = abVpaths.length > 0 || recVpaths.length > 0;
      _updateListenSection();
    }
    // Upload capability
    S.canUpload = !d.noUpload;
    if (d.supportedAudioFiles) S.supportedAudioFiles = d.supportedAudioFiles;
    // Per-user permission to record radio streams
    S.allowRadioRecording = d.allowRadioRecording === true;
    _updateRecordBtn();
    // Per-user permission to download from YouTube
    S.allowYoutubeDownload = d.allowYoutubeDownload === true;
    const ytBtn = document.getElementById('youtube-nav-btn');
    if (ytBtn) ytBtn.classList.toggle('hidden', !S.allowYoutubeDownload);
    if (d.version) {
      const brand = document.querySelector('.sidebar-brand');
      if (brand) brand.title = `mStream Velvet v${d.version}`;
    }
    _updateListenSection();
  }).catch(() => { S.transInfo = { serverEnabled: false }; });

  // Register Media Session action handlers (OS lock-screen controls)
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play',         () => { VIZ.initAudio(); audioEl.play().catch(() => {}); });
      navigator.mediaSession.setActionHandler('pause',        () => audioEl.pause());
      navigator.mediaSession.setActionHandler('nexttrack',    () => Player.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => Player.prev());
      navigator.mediaSession.setActionHandler('seekto', (e) => {
        if (e.seekTime != null && audioEl.duration) audioEl.currentTime = e.seekTime;
      });
    } catch(_e) {}
  }
}
function showLogin() {
  document.getElementById('login-screen').style.display = '';
  document.getElementById('app').classList.add('hidden');
}

// ── EVENTS ────────────────────────────────────────────────────
// Login
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
  try {
    await tryLogin(document.getElementById('l-user').value.trim(), document.getElementById('l-pass').value);
    showApp();
  } catch(_) { err.textContent = 'Login failed. Check credentials.'; }
  finally    { btn.disabled = false; btn.textContent = 'Sign In'; }
});

// Sidebar nav
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v !== 'podcasts') S.audioContentReturn = null; // clear Audio Content context on any other nav
    if (v === 'home')        viewHome();
    else if (v === 'recent')      viewRecent();
    else if (v === 'artists') viewArtists();
    else if (v === 'album-library') viewAlbumLibrary();
    else if (v === 'search')  viewSearch();
    else if (v === 'rated')   viewRated();
    else if (v === 'most-played') viewMostPlayed();
    else if (v === 'played')  viewPlayed();
    else if (v === 'files')   { S.feDirStack = []; S.feFilter = ''; viewFiles('', false); }
    else if (v === 'autodj')  viewAutoDJ();
    else if (v === 'genres')        viewGenres();
    else if (v === 'decades')       viewDecades();
    else if (v === 'transcode') viewTranscode();
    else if (v === 'jukebox')   viewJukebox();
    else if (v === 'apps')      viewApps();
    else if (v === 'shared-links') viewSharedLinks();
    else if (v === 'playback')  viewPlayback();
    else if (v === 'play-history') viewPlayHistory();
    else if (v === 'lastfm')       viewLastFM();
    else if (v === 'listenbrainz') viewListenBrainz();
    else if (v === 'discogs')      viewDiscogs();
    else if (v === 'subsonic')     viewSubsonic();
    else if (v === 'radio')        viewRadio();
    else if (v === 'podcasts')        viewPodcasts();
    else if (v === 'podcast-feeds')  viewPodcastFeeds();
    else if (v === 'youtube')        viewYoutube();
    else if (v === 'wrapped')        viewWrapped();
    else if (v === 'smart-playlists') { _splEditId = null; _splEditName = null; _splFilters = { genres: [], yearFrom: null, yearTo: null, minRating: 0, playedStatus: 'any', minPlayCount: 0, starred: false, artistSearch: '' }; _splSort = 'random'; _splLimit = 100; viewSmartPlaylists(); }
  });
});

// DJ light in player bar — click to open / close the Auto-DJ settings view
document.getElementById('dj-light').addEventListener('click', () => {
  if (S.view === 'autodj') { S.backFn?.(); } else { viewAutoDJ(); }
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => S.backFn?.());

// Player controls
document.getElementById('play-btn').addEventListener('click', () => Player.toggle());
document.getElementById('next-btn').addEventListener('click', () => Player.next());
document.getElementById('prev-btn').addEventListener('click', () => Player.prev());

// Shuffle
function _shuffleStripHtml() {
  if (S.shuffle && S.autoDJ)
    return '<span class="dj-strip-label">Shuffle: <strong>On</strong> — but inactive, Auto-DJ is on</span>';
  return `<span class="dj-strip-label">Shuffle: <strong>${S.shuffle ? 'On' : 'Off'}</strong></span>`;
}
document.getElementById('shuffle-btn').addEventListener('click', () => {
  S.shuffle = !S.shuffle;
  document.getElementById('shuffle-btn').classList.toggle('active', S.shuffle);
  _showInfoStrip('', _shuffleStripHtml(), 3000, true);
  localStorage.setItem(_uKey('shuffle'), S.shuffle ? '1' : '0');
  _syncPrefs();
});

// Repeat
const _svgRepeatAll = `<svg id="repeat-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><polyline points="17,1 21,5 17,9"/><path d="M3 11V5H21"/><polyline points="7,23 3,19 7,15"/><path d="M21 13v6H3"/></svg>`;
const _svgRepeatOne = `<svg id="repeat-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><polyline points="17,1 21,5 17,9"/><path d="M3 11V5H21"/><polyline points="7,23 3,19 7,15"/><path d="M21 13v6H3"/><text x="12" y="14.5" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="700" stroke="none" fill="currentColor" font-family="system-ui,sans-serif">1</text></svg>`;
function _syncRepeatIcon() {
  const btn = document.getElementById('repeat-btn');
  if (!btn) return;
  btn.innerHTML = S.repeat === 'one' ? _svgRepeatOne : _svgRepeatAll;
  btn.classList.toggle('active', S.repeat !== 'off');
  btn.title = S.repeat === 'one' ? 'Repeat: One' : S.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off';
}

document.getElementById('repeat-btn').addEventListener('click', () => {
  const modes = ['off', 'all', 'one'];
  S.repeat = modes[(modes.indexOf(S.repeat) + 1) % modes.length];
  _syncRepeatIcon();
  localStorage.setItem(_uKey('repeat'), S.repeat);
  _syncPrefs();
  _showInfoStrip('', `<span class="dj-strip-label">Repeat: <strong>${S.repeat === 'one' ? 'One Song' : S.repeat === 'all' ? 'All' : 'Off'}</strong></span>`, 3000, true);
});

// Queue toggle (player bar button)
document.getElementById('queue-btn').addEventListener('click', toggleQueue);
// Sidebar clock
(function _initClock() {
  const el = document.getElementById('sidebar-clock');
  if (!el) return;
  function _tick() {
    const now = new Date();
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = days[now.getDay()];
    const date = String(now.getDate()).padStart(2, '0');
    const month = months[now.getMonth()];
    el.innerHTML = `<div class="sc-time">${hh}:${mm}</div><div class="sc-date">${day} ${date} ${month}</div>`;
    // schedule next tick at the start of the next minute
    const msToNext = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(_tick, msToNext);
  }
  _tick();
})();

// Live clock in recording modal — updates every second while page is open
(function _initRecModalClock() {
  const el = document.getElementById('rec-modal-clock');
  if (!el) return;
  function _fmt(d) {
    const p = n => String(n).padStart(2, '0');
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${days[d.getDay()]} ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  setInterval(() => { el.textContent = _fmt(new Date()); }, 1000);
  el.textContent = _fmt(new Date());
})();

// Scheduled recording indicator — polls every 15s, shows pill in player bar
(function _initSchedRecPoll() {
  const el = document.getElementById('sched-rec-indicator');
  if (!el) return;

  el.addEventListener('click', () => {
    // Open record modal on Schedule tab
    const s = S.queue[S.idx];
    if (s && s.isRadio) { _startRecording(); _recModalSwitchTab('schedule'); }
    else { _recModalSwitchTab('schedule'); document.getElementById('radio-rec-modal').classList.remove('hidden'); }
  });

  async function _pollSched() {
    if (!S.allowRadioRecording) { el.classList.add('hidden'); return; }
    try {
      const list = await api('GET', 'api/v1/radio/schedules/active');
      if (!list || !list.length) { el.classList.add('hidden'); return; }
      // Show first active scheduled recording (most common case is one)
      const rec = list[0];
      const elapsedSec = Math.floor((Date.now() - rec.startedAt) / 1000);
      const h = Math.floor(elapsedSec / 3600);
      const m = Math.floor((elapsedSec % 3600) / 60);
      const s = elapsedSec % 60;
      const pad = n => String(n).padStart(2, '0');
      const elapsed = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
      const extra = list.length > 1 ? ` +${list.length - 1}` : '';
      el.innerHTML = `<span class="sri-dot"></span><span class="sri-label">${esc(rec.stationName)} ${elapsed}${extra}</span>`;
      el.classList.remove('hidden');
    } catch (_) {
      el.classList.add('hidden');
    }
  }

  // First poll after 5s (let the page settle), then every 15s
  setTimeout(() => { _pollSched(); setInterval(_pollSched, 15000); }, 5000);
})();

// Radio record button
document.getElementById('radio-rec-btn').addEventListener('click', () => {
  if (S.recordingActive) { _stopRecording(); }
  else { _startRecording(); }
});
_initRecordingModal();
// Collapse button inside queue panel
document.getElementById('qp-reopen-tab').addEventListener('click', toggleQueue);
document.getElementById('qp-close-btn').addEventListener('click', () => {
  document.getElementById('queue-panel').classList.add('collapsed');
  document.getElementById('queue-btn').classList.remove('active');
});
// Save queue as playlist
document.getElementById('qp-share-btn').addEventListener('click', () => {
  if (!S.queue.length) { toast('Queue is empty'); return; }
  showSharePlaylistModal(S.queue);
});
document.getElementById('qp-save-btn').addEventListener('click', () => showSavePlaylistModal());
document.getElementById('qp-shuffle-btn').addEventListener('click', () => {
  if (!S.queue.length) return;
  // Fisher-Yates shuffle
  for (let i = S.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
  }
  S.idx = 0;
  refreshQueueUI();
  toast('Queue shuffled');
  persistQueue();
  _syncQueueToDb();
});
document.getElementById('qp-clear-btn').addEventListener('click', () => {
  S.queue = []; S.idx = -1;
  refreshQueueUI();
  toast('Queue cleared');
  persistQueue();
  _syncQueueToDb();
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  if (S.username) localStorage.removeItem(_queueKey());
  // Flush queue to localStorage NOW, before we clear S.username (persistQueue
  // guards on S.username so it must be called while it still has a value).
  persistQueue();
  // Full W3C reset: pause → remove src → load() wipes all internal play state
  // so no spurious 'play' event can fire when restoreQueue() assigns a new src.
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  VU_NEEDLE.stop();
  syncPlayIcons();  // guarantee ▶ icon before login screen appears
  S.token = ''; S.username = '';
  localStorage.removeItem('ms2_token'); localStorage.removeItem('ms2_user');
  // Expire the server-set cookie so a page refresh cannot re-authenticate
  document.cookie = 'x-access-token=; Max-Age=0; path=/; SameSite=Strict';
  localStorage.setItem('ms2_logged_out', '1');
  showLogin();
});

// Scan button (admin)
document.getElementById('scan-btn').addEventListener('click', async () => {
  try {
    await api('POST', 'api/v1/admin/db/scan/all', {});
    toast('Library scan started');
    pollScan();
  } catch(e) { toast('Scan failed: ' + e.message); }
});

// New playlist
document.getElementById('new-pl-btn').addEventListener('click', () => showNewPlaylistModal());
// New smart playlist
document.getElementById('new-spl-btn').addEventListener('click', () => {
  _splEditId = null; _splEditName = null;
  _splFilters = { genres: [], yearFrom: null, yearTo: null, minRating: 0, playedStatus: 'any', minPlayCount: 0, starred: false, artistSearch: '' };
  _splSort = 'random'; _splLimit = 100;
  viewSmartPlaylists();
});
document.getElementById('pl-new-cancel').addEventListener('click', () => hideModal('pl-new-modal'));
document.getElementById('pl-new-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-new-name').value.trim();
  if (!name) return;
  hideModal('pl-new-modal');
  try {
    await api('POST', 'api/v1/playlist/new', { title: name });
    await loadPlaylists();
    toast(`Playlist "${name}" created`);
  } catch(e) { toast('Failed to create playlist: ' + e.message); }
});

// Save playlist modal
document.getElementById('share-pl-cancel').addEventListener('click', () => hideModal('share-pl-modal'));
document.getElementById('pl-save-cancel').addEventListener('click', () => hideModal('pl-save-modal'));

// Save smart playlist modal
document.getElementById('spl-save-cancel').addEventListener('click', () => hideModal('spl-save-modal'));
async function _doSaveSmartPlaylist() {
  const name = document.getElementById('spl-save-name').value.trim();
  if (!name) return;
  hideModal('spl-save-modal');
  try {
    const r = await api('POST', 'api/v1/smart-playlists', { name, filters: _splFilters, sort: _splSort, limit: _splLimit });
    _splEditId = r.id;
    _splEditName = name;
    await loadSmartPlaylists();
    toast(`"${name}" saved`);
    const d = await api('POST', 'api/v1/smart-playlists/run', { filters: _splFilters, sort: _splSort, limit: _splLimit });
    _viewSmartPlaylistResults(d.songs, name, r.id, _splFilters, _splSort, _splLimit);
  } catch(e) { toast('Error: ' + e.message); }
}
document.getElementById('spl-save-ok').addEventListener('click', _doSaveSmartPlaylist);
document.getElementById('spl-save-name').addEventListener('keydown', e => { if (e.key === 'Enter') _doSaveSmartPlaylist(); });
document.getElementById('pl-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-save-name').value.trim();
  if (!name) return;
  hideModal('pl-save-modal');
  try {
    await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
    await loadPlaylists();
    toast(`Saved ${S.queue.length} songs to "${name}"`);
    openPlaylist(name);
  } catch(e) { toast('Failed to save playlist: ' + e.message); }
});

// Add to playlist modal cancel
document.getElementById('atp-cancel').addEventListener('click', () => hideModal('atp-modal'));
document.getElementById('pl-del-cancel').addEventListener('click', () => hideModal('pl-del-modal'));
document.getElementById('pl-rename-cancel').addEventListener('click', () => hideModal('pl-rename-modal'));
document.getElementById('confirm-modal-cancel').addEventListener('click', () => hideModal('confirm-modal'));
document.getElementById('upload-cancel-btn').addEventListener('click', () => hideModal('upload-modal'));
document.getElementById('pl-del-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-del-ok').dataset.pl;
  hideModal('pl-del-modal');
  try {
    await api('POST', 'api/v1/playlist/delete', { playlistname: name });
    await loadPlaylists();
    toast(`Deleted "${name}"`);
    if (S.view === 'playlist:' + name) viewRecent();
  } catch(e) { toast('Failed to delete playlist'); }
});
document.getElementById('pl-rename-ok').addEventListener('click', async () => {
  const oldName = document.getElementById('pl-rename-ok').dataset.pl;
  const newName = document.getElementById('pl-rename-input').value.trim();
  if (!newName || newName === oldName) { hideModal('pl-rename-modal'); return; }
  hideModal('pl-rename-modal');
  try {
    await api('POST', 'api/v1/playlist/rename', { oldName, newName });
    await loadPlaylists();
    toast(`Renamed to "${newName}"`);
    if (S.view === 'playlist:' + oldName) openPlaylist(newName);
  } catch(e) { toast(e.message || 'Failed to rename playlist'); }
});

// Context menu actions
document.getElementById('ctx-menu').querySelectorAll('.ctx-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const song   = S.ctxSong;
    hideCtxMenu();
    if (!song) return;
    if (action === 'add-queue')   { Player.addSong(song); }
    if (action === 'add-playlist'){ showAddToPlaylistModal(song); }
    if (action === 'play-next')   { Player.playNext(song); }
    if (action === 'remove-from-playlist') {
      if (!song._plid) { toast('Cannot remove: missing playlist entry ID'); return; }
      const plName = S.view.replace(/^playlist:/, '');
      try {
        await api('POST', 'api/v1/playlist/remove-song', { id: song._plid });
        toast('Removed from playlist');
        openPlaylist(plName);
      } catch(e) { toast('Failed to remove song'); }
    }
    if (action === 'download')    {
      const a = document.createElement('a');
      a.href = dlUrl(song.filepath);
      a.download = (song.title || song.filepath.split('/').pop());
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    if (action === 'rate')        { showRatePanel(0, 0, song); document.getElementById('rate-panel').style.left = '50%'; document.getElementById('rate-panel').style.top = '40%'; }
    if (action === 'delete-recording') {
      const fname = song.filepath.split('/').pop();
      showConfirmModal(
        'Delete recording?',
        `"${fname}" will be permanently deleted from the server. This cannot be undone.`,
        async () => {
          try {
            await api('DELETE', 'api/v1/files/recording', { filepath: song.filepath });
            toast(`Deleted: ${fname}`);
            // Remove from current view if present
            const idx = S.curSongs.findIndex(s => s.filepath === song.filepath);
            if (idx !== -1) {
              S.curSongs.splice(idx, 1);
              // Re-render current view body if we're in the file browser
              const body = document.getElementById('content-body');
              const rows = body.querySelectorAll('.song-row');
              rows.forEach(r => {
                if (r.querySelector('.song-title')?.textContent === (song.title || fname)) {
                  r.remove();
                }
              });
            }
            // Remove from queue if present
            const qi = S.queue.findIndex(s => s.filepath === song.filepath);
            if (qi !== -1) {
              S.queue.splice(qi, 1);
              if (S.idx > qi) S.idx--;
              else if (S.idx === qi) S.idx = Math.min(S.idx, S.queue.length - 1);
              persistQueue();
              refreshQueueUI();
            }
          } catch(e) {
            toast('Failed to delete recording');
          }
        }
      );
    }
  });
});

// Rate panel
document.getElementById('rate-stars').querySelectorAll('span').forEach((star, i) => {
  star.addEventListener('mouseenter', () => {
    document.querySelectorAll('#rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j <= i));
  });
  star.addEventListener('mouseleave', () => {
    const fp  = document.getElementById('rate-panel').dataset.fp;
    const song = S.ctxSong;
    const cur  = Math.round((song?.rating || 0) / 2);
    document.querySelectorAll('#rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j < cur));
  });
  star.addEventListener('click', async () => {
    const fp  = document.getElementById('rate-panel').dataset.fp;
    const val = parseInt(star.dataset.v);
    hideRatePanel();
    if (!fp) return;
    // Update rating on matching song in current view
    const song = S.curSongs.find(s => s.filepath === fp) || S.ctxSong;
    if (song) song.rating = val;
    // Re-render stars in the row
    document.querySelectorAll(`.row-stars[data-ci]`).forEach(el => {
      const ci = parseInt(el.dataset.ci);
      if (S.curSongs[ci]?.filepath === fp) el.innerHTML = starsHtml(val);
    });
    // Update player stars if this is the current song
    if (S.queue[S.idx]?.filepath === fp) {
      S.queue[S.idx].rating = val;
      Player.updateBar();
    }
    await rateSong(fp, val);
  });
});
document.getElementById('rate-clear').addEventListener('click', async () => {
  const fp = document.getElementById('rate-panel').dataset.fp;
  hideRatePanel();
  if (!fp) return;
  const song = S.curSongs.find(s => s.filepath === fp) || S.ctxSong;
  if (song) { delete song.rating; }
  document.querySelectorAll(`.row-stars[data-ci]`).forEach(el => {
    const ci = parseInt(el.dataset.ci);
    if (S.curSongs[ci]?.filepath === fp) el.innerHTML = starsHtml(0);
  });
  if (S.queue[S.idx]?.filepath === fp) { delete S.queue[S.idx].rating; Player.updateBar(); }
  await rateSong(fp, null);
});

// Player stars click (in player bar)
document.getElementById('player-stars').addEventListener('click', e => {
  const cur = S.queue[S.idx];
  if (!cur) return;
  const rect = document.getElementById('player-stars').getBoundingClientRect();
  showRatePanel(rect.left, rect.top - 80, cur);
  S.ctxSong = cur;
  document.getElementById('rate-panel').dataset.fp = cur.filepath;
});

// ── EQUALIZER ────────────────────────────────────────────────
const EQ = (() => {
  let gains   = JSON.parse(localStorage.getItem(_uKey('eq'))    || 'null') || Array(8).fill(0);
  let enabled = localStorage.getItem(_uKey('eq_on')) !== 'false';

  function save() {
    localStorage.setItem(_uKey('eq'), JSON.stringify(gains));
    localStorage.setItem(_uKey('eq_on'), enabled ? 'true' : 'false');
    _syncPrefs();
  }

  function applyToFilters() {
    if (!eqFilters.length) return;
    eqFilters.forEach((f, i) => { f.gain.value = enabled ? (gains[i] || 0) : 0; });
  }

  const dbLabel = v => (v > 0 ? '+' : '') + v;
  const dbColor = v => v > 0 ? 'var(--primary)' : v < 0 ? 'var(--accent)' : 'var(--t3)';

  function updateSliderUIs() {
    EQ_BANDS.forEach((_, i) => {
      const s = document.getElementById(`eq-s-${i}`);
      const l = document.getElementById(`eq-db-${i}`);
      if (s) s.value = gains[i];
      if (l) { l.textContent = dbLabel(gains[i]); l.style.color = dbColor(gains[i]); }
    });
    updateActivePreset();
  }

  function updateActivePreset() {
    document.querySelectorAll('.eq-preset-btn').forEach(btn => {
      const p = EQ_PRESETS[btn.dataset.preset];
      btn.classList.toggle('active', !!p && JSON.stringify(p) === JSON.stringify(gains));
    });
  }

  function updateBypassUI() {
    const track = document.getElementById('eq-bypass-track');
    const lbl   = document.getElementById('eq-bypass-text');
    if (track) track.classList.toggle('lit', enabled);
    if (lbl)   lbl.textContent = enabled ? 'On' : 'Off';
    document.getElementById('eq-btn')?.classList.toggle('eq-active', enabled && gains.some(g => g !== 0));
  }

  function renderSliders() {
    const wrap = document.getElementById('eq-sliders');
    if (!wrap) return;
    wrap.innerHTML = EQ_BANDS.map((b, i) => `
      <div class="eq-band">
        <span class="eq-db" id="eq-db-${i}" style="color:${dbColor(gains[i])}">${dbLabel(gains[i])}</span>
        <div class="eq-slider-wrap"><input type="range" class="eq-slider" id="eq-s-${i}"
          min="-12" max="12" step="0.5" value="${gains[i]}"></div>
        <span class="eq-freq">${esc(b.label)}</span>
      </div>`).join('');
    EQ_BANDS.forEach((_, i) => {
      document.getElementById(`eq-s-${i}`).addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        gains[i] = v;
        const l = document.getElementById(`eq-db-${i}`);
        if (l) { l.textContent = dbLabel(v); l.style.color = dbColor(v); }
        applyToFilters(); save(); updateActivePreset(); updateBypassUI();
      });
    });
    document.querySelectorAll('.eq-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = EQ_PRESETS[btn.dataset.preset];
        if (!p) return;
        gains = [...p];
        applyToFilters(); save(); updateSliderUIs(); updateBypassUI();
      });
    });
    updateActivePreset();
  }

  function open() {
    const panel = document.getElementById('eq-panel');
    panel.classList.remove('hidden');
    requestAnimationFrame(() => panel.classList.add('open'));
    renderSliders();
    updateBypassUI();
  }

  function close() {
    const panel = document.getElementById('eq-panel');
    panel.classList.remove('open');
    panel.addEventListener('transitionend', () => panel.classList.add('hidden'), { once: true });
  }

  function toggle() {
    const panel = document.getElementById('eq-panel');
    (panel.classList.contains('hidden') || !panel.classList.contains('open')) ? open() : close();
  }

  document.getElementById('eq-bypass-track').addEventListener('click', () => {
    enabled = !enabled;
    applyToFilters(); save(); updateBypassUI();
  });
  document.getElementById('eq-close-btn').addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('eq-panel');
      if (panel && !panel.classList.contains('hidden')) close();
    }
  });

  updateBypassUI();
  return { toggle, open, close, applyToFilters };
})();

// Close ctx / rate panel on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu') && !e.target.closest('.ctx-btn') && !e.target.closest('#rate-panel') && !e.target.closest('.row-stars') && !e.target.closest('#player-stars')) {
    hideCtxMenu();
  }
});

// Sync play/pause icon state from audioEl.paused — call this any time the
// icon may be stale (restore, logout, etc.) rather than relying on events.
function syncPlayIcons() {
  const playing = !audioEl.paused;
  document.getElementById('icon-play').classList.toggle('hidden',  playing);
  document.getElementById('icon-pause').classList.toggle('hidden', !playing);
  document.getElementById('np-icon-play').classList.toggle('hidden',  playing);
  document.getElementById('np-icon-pause').classList.toggle('hidden', !playing);
  _syncQueueLabel();
}

function _syncQueueLabel() {
  const label = document.getElementById('qp-np-label');
  if (!label) return;
  const hasSong = !!S.queue[S.idx];
  const playing = !audioEl.paused;
  let icon, text;
  if (_xfadeFired) {
    icon = '<svg width="12" height="10" viewBox="0 0 28 24" fill="currentColor"><polygon points="1,3 11,12 1,21" opacity=".55"/><polygon points="9,3 19,12 9,21" opacity=".78"/><polygon points="17,3 27,12 17,21"/></svg>';
    text = 'Crossfading…';
  } else if (!hasSong) {
    icon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>';
    text = 'Stopped';
  } else if (!playing) {
    icon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="4" height="16" rx="1.5"/><rect x="15" y="4" width="4" height="16" rx="1.5"/></svg>';
    text = 'Paused';
  } else {
    icon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
    text = 'Now Playing';
  }
  const cur = S.queue[S.idx];
  const djSub = (!cur?.isRadio && S.autoDJ)
    ? (S.djSimilar
      ? ` <span class="ql-sub-label">· Auto-DJ: Similar Songs${S.crossfade > 0 ? ' &amp; Crossfade' : ''}</span>`
      : ` <span class="ql-sub-label">· Auto-DJ${S.crossfade > 0 ? ' &amp; Crossfade' : ''}</span>`)
    : '';
  // Context sub-label — derived from current song flags or stored playSource
  let ctxSub = '';
  if (!djSub) {
    if (cur?.isRadio) {
      ctxSub = ` <span class="ql-sub-label">· Radio Stream</span>`;
    } else if (cur?.isPodcast) {
      const pname = S.playSource?.type === 'podcast' ? S.playSource.name : '';
      ctxSub = ` <span class="ql-sub-label">· Podcast${pname ? ': ' + esc(pname) : ''}</span>`;
    } else if (S.playSource?.type === 'playlist') {
      ctxSub = ` <span class="ql-sub-label">· Playlist: ${esc(S.playSource.name)}</span>`;
    } else if (S.playSource?.type === 'smart-playlist') {
      ctxSub = ` <span class="ql-sub-label">· Smart Playlist: ${esc(S.playSource.name)}</span>`;
    }
  }
  label.innerHTML = icon + ' ' + text + djSub + ctxSub;
}

// ── Tab favicon + dynamic title ──────────────────────────────────────────────
// Playing  → album art drawn to canvas once (no loop)
// Paused / idle → Velvet logo SVG (dark bg + purple m)
const _TabFav = (() => {
  let _icos = null, _song = null, _playing = false, _lastArtSrc = '';
  const _origHrefs = new Map();

  // Velvet idle/paused logo: dark rounded square + bold "m" in primary purple
  const _SVG_VELVET = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="72 33 76 89"><defs><linearGradient id="tfv-o" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c4b5fd"/><stop offset="100%" stop-color="#6d28d9" stop-opacity=".85"/></linearGradient><linearGradient id="tfv-i" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4c1d95"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><polygon fill="url(#tfv-o)" points="75,118.5 75,35.5 96,48.5 96,118.5"/><polygon fill="url(#tfv-i)" points="99,118.5 99,49.5 110.5,56.5 121,49.5 121,118.5"/><polygon fill="url(#tfv-o)" points="124,118.5 124,48.5 145,35.5 145,118.5"/></svg>`;

  function _svgHref(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }
  const _VELVET_HREF = _svgHref(_SVG_VELVET);

  function _init() {
    if (_icos) return;
    _icos = Array.from(document.querySelectorAll('link[rel*="icon"]'))
                 .filter(el => !el.rel.includes('apple'));
    _icos.forEach(el => _origHrefs.set(el, el.href));
  }

  function _setAll(href) { _icos.forEach(el => { el.href = href; }); }

  function _title() {
    if (!_song) { document.title = 'mStream Velvet'; return; }
    const a = _song.artist || '', t = _song.title || (_song.filepath || '').split('/').pop() || '';
    const mark = _playing ? '\u25B6' : '\u23F8';
    document.title = (a && t) ? `${mark} ${a} \u2014 ${t}` : `${mark} ${t || 'mStream Velvet'}`;
  }

  function _drawArt(src) {
    if (!src) { _setAll(_VELVET_HREF); return; }
    if (src === _lastArtSrc) return; // same art, already set
    _lastArtSrc = src;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 32;
    const ctx = cvs.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, 32, 32, 4); else ctx.rect(0, 0, 32, 32);
      ctx.clip();
      ctx.drawImage(img, 0, 0, 32, 32);
      ctx.restore();
      _setAll(cvs.toDataURL('image/png'));
    };
    img.onerror = () => { _setAll(_VELVET_HREF); };
    img.src = src;
  }

  return {
    setSong(song, playing) {
      _init(); _song = song;
      if (playing !== undefined) _playing = playing;
      _title();
      if (_playing && song) _drawArt(artUrl(song['album-art'], 's'));
      else _setAll(_VELVET_HREF);
    },
    play() {
      _init(); _playing = true; _title();
      if (_song) _drawArt(artUrl(_song['album-art'], 's'));
    },
    pause() { _init(); _playing = false; _lastArtSrc = ''; _title(); _setAll(_VELVET_HREF); },
    reset() { _init(); _song = null; _playing = false; _lastArtSrc = ''; document.title = 'mStream Velvet'; _setAll(_VELVET_HREF); },
  };
})();

// ── AUDIO EVENT HANDLERS (named so they can be moved to a swapped element) ──
function _onAudioPlay()  { syncPlayIcons(); VIZ.initAudio(); VU_NEEDLE.start(); _startWaveformRaf(); document.body.classList.add('audio-playing'); _TabFav.play(); _startPositionSync(); if (S.queue[S.idx]?.isRadio) { _radioPlayStart = Date.now(); } if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = 'playing'; } catch(_e) {} }
function _onAudioPause() { syncPlayIcons(); VU_NEEDLE.stop();  _stopWaveformRaf(); document.body.classList.remove('audio-playing'); _TabFav.pause(); _stopPositionSync(); if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = 'paused';  } catch(_e) {} }
function _onAudioEnded() {
  // Radio stream ended unexpectedly — try to reconnect on the same link
  const _curSong = S.queue[S.idx];
  if (_curSong?.isRadio) {
    setTimeout(() => {
      if (S.queue[S.idx]?.isRadio) {
        audioEl.src = _curSong._radioLinks[_curSong._radioLinkIdx || 0];
        audioEl.load(); audioEl.play().catch(() => {});
      }
    }, 3000);
    return;
  }
  if (S.sleepMins === -1) {
    S.sleepMins = 0;
    S.sleepEndsAt = 0;
    _updateSleepLight();
    _showInfoStrip('', '<span class="dj-strip-label">💤 Sleep — playback stopped</span>', 6000, true);
    return;
  }
  // Crossfade: _xfadeEl is already playing through Web Audio.
  // Swap it into the audioEl role — zero gap.
  if (_xfadeFired) {
    _doXfadeHandoff(_xfadeNextIdx);
    return;
  }
  _stopWaveformRaf();
  // Wrapped: fire play-end (natural completion)
  _wrappedEndedNaturally = true;
  if (_wrappedEventId) {
    const eid = _wrappedEventId;
    _wrappedEventId = null;
    api('POST', 'api/v1/wrapped/play-end', {
      eventId:  eid,
      playedMs: Math.max(0, Math.round(((audioEl.duration || 0) - _wrappedTrackStartOffset) * 1000)),
    }).catch(() => {});
  }
  if (_wrappedPodcastEventId) {
    const eid = _wrappedPodcastEventId; _wrappedPodcastEventId = null;
    api('POST', 'api/v1/wrapped/podcast-end', {
      eventId: eid, playedMs: Math.round((audioEl.duration || 0) * 1000), completed: true,
    }).catch(() => {});
  }
  Player.next();
}
// Tracks how many reload attempts have been made for a given src URL so we
// know when to give up and skip rather than loop forever.
const _mediaParseRetries = new Map();

function _onAudioError() {
  const err = audioEl.error;
  if (!err || !audioEl.src) return;
  console.warn(`Audio error code ${err.code}: ${err.message || '(no message)'}`);

  // Radio stream error — try next fallback link
  const _radioSong = S.queue[S.idx];
  if (_radioSong?.isRadio) {
    const nextIdx = (_radioSong._radioLinkIdx || 0) + 1;
    if (nextIdx < _radioSong._radioLinks.length) {
      _radioSong._radioLinkIdx = nextIdx;
      audioEl.src = mediaUrl(_radioSong._radioLinks[nextIdx]); // must go through proxy
      audioEl.load(); audioEl.play().catch(() => {});
      toast(`Radio: trying fallback link ${nextIdx + 1}…`);
    } else {
      toast(`⚠ Radio stream unavailable: ${_radioSong.title}`);
    }
    return;
  }

  // Code 2 = MEDIA_ERR_NETWORK — connection dropped mid-stream; reload.
  if (err.code === MediaError.MEDIA_ERR_NETWORK) {
    _reloadFromPosition(0);
    return;
  }

  // Code 3 = MEDIA_ERR_DECODE, Code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED
  // — the file exists but the browser can't parse it (corrupt, unsupported
  //   codec, bad PTS timestamps, ERR_CONTENT_LENGTH_MISMATCH, etc.).
  // Retry once: a reload often clears transient PTS / demuxer failures.
  if (err.code === MediaError.MEDIA_ERR_DECODE ||
      err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    const src = audioEl.src;
    const attempts = _mediaParseRetries.get(src) || 0;
    if (attempts < 1) {
      _mediaParseRetries.set(src, attempts + 1);
      console.warn(`Audio parse error — reload attempt ${attempts + 1}/1 for: ${src}`);
      _reloadFromPosition(0);
      return;
    }
    // Already retried — give up and skip.
    _mediaParseRetries.delete(src);
    const song = S.queue[S.idx];
    const name = song ? (song.title || song.filepath.split('/').pop()) : 'Unknown';
    toast(`⚠ Skipping unplayable file: ${name}`);
    Player.next();
    return;
  }
}
function _onAudioStalled() {
  clearTimeout(_netRecoveryTimer);
  _netRecoveryTimer = setTimeout(() => {
    if (audioEl.readyState < 3) {
      console.warn(`Stream stalled (readyState=${audioEl.readyState}) — recovering`);
      _reloadFromPosition(0);
    }
  }, 5000);
}
function _onAudioPlaying()  {
  clearTimeout(_netRecoveryTimer);
  // Only reset the parse-retry counter once we've played enough to know the
  // file is genuinely working. Playing briefly from position 0 while the
  // recovery logic seeks to the resume position would otherwise clear the
  // counter and turn a 1-retry limit into an infinite loop.
  const src = audioEl.src;
  const _clearRetryTimer = setTimeout(() => {
    if (audioEl.src === src && !audioEl.paused) _mediaParseRetries.delete(src);
  }, 3000);
  audioEl.addEventListener('pause',  () => clearTimeout(_clearRetryTimer), { once: true });
  audioEl.addEventListener('ended',  () => clearTimeout(_clearRetryTimer), { once: true });
  audioEl.addEventListener('error',  () => clearTimeout(_clearRetryTimer), { once: true });
}
function _onAudioCanPlay() { clearTimeout(_netRecoveryTimer); }

// ── CUE SHEET MARKERS ────────────────────────────────────────
async function loadCuePoints(filepath) {
  _cuePoints = [];
  _cueMarkersRendered = false;
  ['cue-markers','np-cue-markers'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  try {
    const fp = encodeURIComponent(filepath);
    const data = await api('GET', `api/v1/db/cuepoints?fp=${fp}`);
    _cuePoints = (data.cuepoints || []).filter(cp => cp.t > 0);
  } catch (_e) { _cuePoints = []; }
  renderCueMarkers();
}
function renderCueMarkers() {
  if (_cueMarkersRendered || !_cuePoints.length || !audioEl.duration) return;
  _cueMarkersRendered = true;
  const dur = audioEl.duration;
  const html = _cuePoints.map(cp => {
    const pct = (cp.t / dur) * 100;
    if (pct <= 0 || pct >= 100) return '';
    const label = cp.title ? `${cp.no}. ${cp.title}` : `Track ${cp.no}`;
    return `<span class="cue-tick" style="left:${pct.toFixed(2)}%" data-label="${esc(label)}"></span>`;
  }).join('');
  ['cue-markers','np-cue-markers'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.querySelectorAll('.cue-tick').forEach(tick => {
      tick.addEventListener('click', e => {
        e.stopPropagation();
        if (audioEl.duration) audioEl.currentTime = (parseFloat(tick.style.left) / 100) * audioEl.duration;
      });
    });
  });
}
function _onAudioTimeupdatePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; persistQueue(); }, 5000);
}
function _onAudioTimeupdateUI() {
  // Radio streams: duration is Infinity — show 0:00 left, elapsed right
  if (S.queue[S.idx]?.isRadio) {
    const elapsed = _radioPlayStart ? Math.floor((Date.now() - _radioPlayStart) / 1000) : 0;
    const elapsedFmt = fmt(elapsed);
    document.getElementById('time-cur').textContent   = '0:00';
    document.getElementById('time-total').textContent = elapsedFmt;
    document.getElementById('np-time-cur').textContent   = '0:00';
    document.getElementById('np-time-total').textContent = elapsedFmt;
    return;
  }
  if (!audioEl.duration || audioEl.duration === Infinity) return;
  // Media Session position state — throttled to 1 Hz
  if ('mediaSession' in navigator) {
    const _tNow = Date.now();
    if (_tNow - _msPosThrottle >= 1000) {
      _msPosThrottle = _tNow;
      try { navigator.mediaSession.setPositionState({ duration: audioEl.duration, playbackRate: audioEl.playbackRate, position: audioEl.currentTime }); } catch(_e) {}
    }
  }
  if (_cuePoints.length && !_cueMarkersRendered) renderCueMarkers();
  const _isLiveRadio = !!S.queue[S.idx]?.isRadio;
  const pct = _isLiveRadio ? 100 : (audioEl.currentTime / audioEl.duration) * 100;
  document.getElementById('prog-fill').style.width = pct + '%';
  const _progThumb = document.getElementById('prog-thumb');
  if (_progThumb) {
    _progThumb.style.display = _isLiveRadio ? 'none' : '';
    if (!_isLiveRadio) _progThumb.style.left = pct + '%';
  }
  _renderTimes();
  if (S.autoDJ && S.idx === S.queue.length - 1 && _isMusicSong(S.queue[S.idx]) &&
      (audioEl.duration - audioEl.currentTime) < Math.max(
        S.djSimilar ? 45 : 25,   // similar-artists = 2 serial API calls; need more runway
        S.crossfade + 15
      )) {
    autoDJPrefetch();
  }
  if (!document.getElementById('np-modal').classList.contains('hidden')) {
    document.getElementById('np-prog-fill').style.width  = pct + '%';
    _renderTimes();
  }
  VIZ.lyricTick(audioEl.currentTime);
  if (S.crossfade > 0 && !_xfadeFired) {
    if (!S.queue[S.idx]?.isRadio) {
      const remaining = audioEl.duration - audioEl.currentTime;
      if (remaining > 0 && remaining <= S.crossfade) {
        let nextIdx = -1;
        if (S.shuffle) {
          nextIdx = Math.floor(Math.random() * S.queue.length);
        } else if (S.repeat === 'one') {
          nextIdx = S.idx;
        } else if (S.idx < S.queue.length - 1) {
          nextIdx = S.idx + 1;
        } else if (S.repeat === 'all') {
          nextIdx = 0;
        } else if (S.autoDJ && S.queue.length > S.idx + 1) {
          nextIdx = S.idx + 1;
        }
        if (nextIdx !== -1) _startCrossfade(nextIdx);
      }
    }
  }
  // Gapless playback: pre-buffer next track ~8 s before end when crossfade is off.
  // We need the buffer window to be large enough so the browser has time to
  // fetch+decode the start of the next FLAC before audioEl fires 'ended'.
  if (S.gapless && S.crossfade === 0 && !_xfadeFired && audioEl.duration > 0 && !S.queue[S.idx]?.isRadio) {
    const remaining = audioEl.duration - audioEl.currentTime;
    if (remaining > 0 && remaining <= 8.0) {
      let nextIdx = -1;
      if (S.shuffle)                             nextIdx = Math.floor(Math.random() * S.queue.length);
      else if (S.repeat === 'one')               nextIdx = S.idx;
      else if (S.idx < S.queue.length - 1)       nextIdx = S.idx + 1;
      else if (S.repeat === 'all')               nextIdx = 0;
      else if (S.autoDJ && S.queue.length > S.idx + 1) nextIdx = S.idx + 1;
      if (nextIdx !== -1) _startGapless(nextIdx);
    }
  }
  // Gapless: scheduling is handled by _startGapless setTimeout + Web Audio
  // setValueAtTime — no polling needed here.
  // Waveform scrubber: update shaded fill to reflect playback position
  _updateWaveformProgress();
  _updateSleepLight();
}

function _attachAudioListeners(el) {
  el.addEventListener('play',        _onAudioPlay);
  el.addEventListener('pause',       _onAudioPause);
  el.addEventListener('ended',       _onAudioEnded);
  el.addEventListener('error',       _onAudioError);
  el.addEventListener('stalled',     _onAudioStalled);
  el.addEventListener('playing',     _onAudioPlaying);
  el.addEventListener('canplay',     _onAudioCanPlay);
  el.addEventListener('timeupdate',  _onAudioTimeupdatePersist);
  el.addEventListener('timeupdate',  _onAudioTimeupdateUI);
  el.addEventListener('seeked',      _onAudioSeeked);
}
function _detachAudioListeners(el) {
  el.removeEventListener('play',        _onAudioPlay);
  el.removeEventListener('pause',       _onAudioPause);
  el.removeEventListener('ended',       _onAudioEnded);
  el.removeEventListener('error',       _onAudioError);
  el.removeEventListener('stalled',     _onAudioStalled);
  el.removeEventListener('playing',     _onAudioPlaying);
  el.removeEventListener('canplay',     _onAudioCanPlay);
  el.removeEventListener('timeupdate',  _onAudioTimeupdatePersist);
  el.removeEventListener('timeupdate',  _onAudioTimeupdateUI);
  el.removeEventListener('seeked',      _onAudioSeeked);
}

// Sync queue position to DB on user-initiated seek (debounced 1s)
let _seekSyncTimer = null;
function _onAudioSeeked() {
  persistQueue(); // update localStorage immediately
  clearTimeout(_seekSyncTimer);
  _seekSyncTimer = setTimeout(() => _syncQueueToDb(), 1000);
}

// Periodic position-only DB sync every 60 s during playback — keeps the
// position reasonably fresh for cross-device resume without hammering the DB.
let _positionSyncInterval = null;
function _startPositionSync() {
  if (_positionSyncInterval) return;
  _positionSyncInterval = setInterval(() => {
    if (!audioEl.paused && S.token && S.username) {
      persistQueue();
      // Write position directly — skip the debounce so DB is always current
      api('POST', 'api/v1/user/settings', { queue: {
        queue:   S.queue,
        idx:     S.idx,
        time:    audioEl.currentTime || 0,
        playing: true,
        savedAt: Date.now(),
      }})
        .then(() => localStorage.setItem('ms2_settings_pushed_' + S.username, new Date().toISOString()))
        .catch(() => {});
    }
  }, 15000);
}
function _stopPositionSync() {
  clearInterval(_positionSyncInterval);
  _positionSyncInterval = null;
}

// Attach all permanent listeners to the initial audioEl
_attachAudioListeners(audioEl);

// ── NETWORK RECOVERY (proxy / firewall connection reset) ─────
// Reverse proxies (nginx, Caddy…) reset TCP connections mid-stream when
// their proxy_read_timeout or keepalive limits are hit.  The browser logs
// ERR_CONNECTION_RESET / 206 in the console, continues playing from its
// buffer, then silently pauses when the buffer is exhausted.
//
// Two events signal trouble:
//   • 'error'   – MEDIA_ERR_NETWORK (code 2) once the buffer runs dry
//   • 'stalled' – browser stopped receiving bytes (fires 3 s after the
//                 network goes quiet, BEFORE the buffer actually runs out)
//
// Recovery: capture currentTime, call load() to re-issue the HTTP request,
// then seek back and resume.  If the proxy resets that request too, we retry
// with exponential back-off (max 5 attempts, 1 → 2 → 4 → 8 → 16 s).

let _netRecoveryTimer = null;

function _reloadFromPosition(attempt) {
  attempt = attempt || 0;
  if (attempt > 5) {
    console.error('Recovery: gave up after 5 recovery attempts — skipping track');
    const song = S.queue[S.idx];
    const name = song ? (song.title || song.filepath.split('/').pop()) : 'Unknown';
    toast(`⚠ Skipping unreachable file: ${name}`);
    Player.next();
    return;
  }
  // On the very first attempt try to resume from the current position.
  // If that fails (e.g. 416 Range Not Satisfiable after a file rewrite where
  // the new file is smaller), fall back to the start immediately.
  // Starting from 0 is always safe and preferred over an infinite 416 loop.
  const resumeAt = attempt < 1 ? audioEl.currentTime : 0;
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
  console.warn(`Recovery attempt ${attempt + 1}/5 — resume from ${Math.round(resumeAt)}s in ${delay}ms`);
  clearTimeout(_netRecoveryTimer);
  _netRecoveryTimer = setTimeout(() => {
    audioEl.load(); // re-issues the HTTP GET through the proxy
    const onMeta = () => {
      if (resumeAt > 1) audioEl.currentTime = resumeAt;
      VIZ.initAudio();
      audioEl.play().catch(() => _reloadFromPosition(attempt + 1));
    };
    audioEl.addEventListener('loadedmetadata', onMeta, { once: true });
    // If loadedmetadata never fires (proxy keeps resetting), retry
    const retryTimer = setTimeout(() => {
      audioEl.removeEventListener('loadedmetadata', onMeta);
      _reloadFromPosition(attempt + 1);
    }, 12000);
    // Clean up retry timer once we're actually playing
    audioEl.addEventListener('playing', () => clearTimeout(retryTimer), { once: true });
  }, delay);
}

// (error, stalled, playing, canplay, timeupdate × 2 are all registered via _attachAudioListeners above)
// Seek arrow + time bubble on the player-bar progress track
// Arrow is a DOM element: CSS fixes its vertical position, JS only ever sets left.
(function initSeekPreview() {
  const track     = document.getElementById('prog-track');
  const container = track.closest('.player-progress');

  // Triangle arrow — vertical position set in CSS (bottom:7px), never touched by JS
  const arrow = document.createElement('div');
  arrow.className = 'seek-arrow';
  container.appendChild(arrow);

  // Time bubble
  const bubble = document.createElement('div');
  bubble.className = 'seek-preview';
  container.appendChild(bubble);

  function onMove(e) {
    const onCue = e.target.closest('.cue-tick');
    const tRect = track.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - tRect.left) / tRect.width));
    const xPx   = tRect.left - cRect.left + pct * tRect.width;
    // Only left is set — vertical is governed by CSS alone
    arrow.style.left = xPx + 'px';
    arrow.classList.toggle('sa-cue', !!onCue);
    arrow.classList.add('sa-show');
    if (onCue) { bubble.classList.remove('sp-show'); return; }
    bubble.style.left = xPx + 'px';
    if (audioEl.duration && isFinite(audioEl.duration)) { bubble.textContent = fmt(pct * audioEl.duration); bubble.classList.add('sp-show'); }
  }
  function onLeave() { arrow.classList.remove('sa-show'); bubble.classList.remove('sp-show'); }
  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseleave', onLeave);
  // Also hide when the song changes (crossfade doesn't trigger mouseleave)
  document.addEventListener('mstream-song-change', onLeave);
  container.addEventListener('click', e => {
    if (e.target.closest('.cue-tick')) return;
    if (S.queue[S.idx]?.isRadio) { _radioSpectrumEnabled = !_radioSpectrumEnabled; _drawWaveform(); return; }
    const r = track.getBoundingClientRect();
    if (audioEl.duration) audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audioEl.duration;
  });
}());
let _volSaveTimer = null;
document.getElementById('volume').addEventListener('input', e => {
  audioEl.volume = e.target.value / 100;
  _setVolPct(e.target.value);
  clearTimeout(_volSaveTimer);
  _volSaveTimer = setTimeout(() => { localStorage.setItem(_uKey('vol'), e.target.value); _syncPrefs(); }, 300);
});
(function initVolume() {
  const saved = parseInt(localStorage.getItem(_uKey('vol')) || '80', 10);
  audioEl.volume = saved / 100;
  const el = document.getElementById('volume');
  if (el) el.value = saved;
  _setVolPct(saved);
}());
function _setVolPct(val) {
  const el = document.getElementById('vol-pct');
  if (el) el.textContent = Math.round(val) + '%';
  // Drive the filled-track gradient and thumb glow via CSS custom properties
  const slider = document.getElementById('volume');
  if (slider) {
    slider.style.setProperty('--vol-pct',  val + '%');
  }
}

// ── Balance slider ───────────────────────────────────────────
(function initBalance() {
  const saved = parseFloat(localStorage.getItem(_uKey('balance')) || '0');
  const el    = document.getElementById('balance');
  if (el) el.value = Math.round(saved * 100);
})();
document.getElementById('balance').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  if (_pannerNode) _pannerNode.pan.value = v / 100;
  localStorage.setItem(_uKey('balance'), v / 100);
  _syncPrefs();
});
document.getElementById('balance').addEventListener('dblclick', () => {
  const el = document.getElementById('balance');
  el.value = 0;
  if (_pannerNode) _pannerNode.pan.value = 0;
  localStorage.removeItem(_uKey('balance'));
  _syncPrefs();
});
document.getElementById('bal-center-btn').addEventListener('click', () => {
  const el = document.getElementById('balance');
  el.value = 0;
  if (_pannerNode) _pannerNode.pan.value = 0;
  localStorage.removeItem(_uKey('balance'));
  _syncPrefs();
});

let _preMuteVol = parseFloat(localStorage.getItem(_uKey('vol')) || '80') / 100;
document.getElementById('mute-btn').addEventListener('click', () => {
  if (audioEl.volume > 0) {
    _preMuteVol = audioEl.volume;
    audioEl.volume = 0;
    document.getElementById('volume').value = 0;
    _setVolPct(0);
    document.getElementById('mute-btn').classList.add('muted');
    document.getElementById('vol-icon-on').classList.add('hidden');
    document.getElementById('vol-icon-off').classList.remove('hidden');
    localStorage.setItem(_uKey('mute'), '1');
    _syncPrefs();
  } else {
    audioEl.volume = _preMuteVol;
    document.getElementById('volume').value = Math.round(_preMuteVol * 100);
    _setVolPct(Math.round(_preMuteVol * 100));
    document.getElementById('mute-btn').classList.remove('muted');
    document.getElementById('vol-icon-on').classList.remove('hidden');
    document.getElementById('vol-icon-off').classList.add('hidden');
    localStorage.removeItem(_uKey('mute'));
    _syncPrefs();
  }
});
// Restore mute icon if user drags slider back up from 0
document.getElementById('volume').addEventListener('input', e => {
  if (parseFloat(e.target.value) > 0 && audioEl.volume === 0) {
    document.getElementById('mute-btn').classList.remove('muted');
    document.getElementById('vol-icon-on').classList.remove('hidden');
    document.getElementById('vol-icon-off').classList.add('hidden');
    localStorage.removeItem(_uKey('mute'));
  }
});

// NP Modal
document.getElementById('np-open-btn').addEventListener('click', e => {
  if (e.target.closest('#player-stars')) return;
  showNPModal();
});
document.getElementById('np-close-btn').addEventListener('click', hideNPModal);
document.getElementById('np-modal').addEventListener('click', e => {
  if (!e.target.closest('#np-box')) hideNPModal();
});
// Discogs art picker inside the NP modal left panel
document.getElementById('np-left').addEventListener('click', async e => {
  e.stopPropagation(); // prevent bubbling to np-modal overlay close handler
  // Cancel / back button
  if (e.target.closest('#np-discogs-back-btn')) {
    document.getElementById('np-left')?.classList.remove('np-left--picking');
    const dsElBack = document.getElementById('np-discogs-section');
    if (dsElBack) dsElBack.dataset.songFp = '';
    renderNPModal();
    return;
  }
  // Click on missing-art placeholder — auto-open search
  if (e.target.closest('#np-art') && !S.queue[S.idx]?.['album-art']) {
    _npDiscogsSearch(S.queue[S.idx]);
    return;
  }
  // Search button — Discogs
  if (e.target.closest('#np-discogs-search-btn')) {
    _npDiscogsSearch(S.queue[S.idx]);
    return;
  }
  // Search button — Deezer
  if (e.target.closest('#np-deezer-search-btn')) {
    _npDeezerSearch(S.queue[S.idx]);
    return;
  }
  // Paste URL button
  if (e.target.closest('#np-url-paste-btn')) {
    _npUrlPaste(S.queue[S.idx]);
    return;
  }
  // "Use" button — embed the pasted URL
  if (e.target.closest('#np-url-paste-go-btn')) {
    const inp = document.getElementById('np-url-paste-inp');
    const coverUrl = (inp?.value || '').trim();
    const song = S.queue[S.idx];
    const statusEl = document.getElementById('np-url-paste-status');
    if (!coverUrl || !song?.filepath) return;
    // Basic URL validation — must start with http(s)://
    if (!/^https?:\/\/.+/i.test(coverUrl)) {
      if (statusEl) { statusEl.textContent = 'Please enter a valid https:// URL'; statusEl.style.display = ''; }
      return;
    }
    const filepath = song.filepath;
    const dsEl   = document.getElementById('np-discogs-section');
    const npLeft = document.getElementById('np-left');
    const _cacheOnly = ['wav','aiff','aif','w64'].includes((filepath || '').split('.').pop().toLowerCase());
    const _label = _cacheOnly ? 'Saving art to database…' : 'Embedding cover art…';
    const _isCurrentSong = S.queue[S.idx]?.filepath === filepath;
    const _wasPlaying    = _isCurrentSong && !audioEl.paused;
    if (_isCurrentSong && _wasPlaying) audioEl.pause();
    if (dsEl) dsEl.innerHTML = `<div class="np-embed-spinner"></div><span class="np-embed-label">${_label}</span>`;
    npLeft?.classList.add('np-left--embedding');
    try {
      const result = await api('POST', 'api/v1/discogs/embed', { filepath, coverUrl });
      if (result?.aaFile) {
        S.queue.forEach(q => { if (q.filepath === filepath) q['album-art'] = result.aaFile; });
        _syncQueueToDb();
      }
      npLeft?.classList.remove('np-left--embedding');
      npLeft?.classList.remove('np-left--picking');
      if (dsEl) dsEl.dataset.songFp = '';
      renderNPModal();
      if (S.queue[S.idx]?.filepath === filepath) Player.updateBar();
      refreshQueueUI();
      if (_isCurrentSong) {
        clearTimeout(_netRecoveryTimer);
        toast('Album art saved — restarting from the beginning');
        audioEl.addEventListener('loadedmetadata', () => { if (_wasPlaying) audioEl.play().catch(() => {}); }, { once: true });
        audioEl.src = mediaUrl(filepath) + '&_t=' + Date.now();
        audioEl.load();
      }
    } catch(err) {
      npLeft?.classList.remove('np-left--embedding');
      if (_isCurrentSong && _wasPlaying) audioEl.play().catch(() => {});
      if (dsEl) dsEl.innerHTML =
        `<span class="np-discogs-status" style="color:rgba(255,100,100,.8)">Embed failed: ${esc(err?.message || 'error')}</span>` +
        `<button class="np-discogs-btn" id="np-url-paste-btn" style="margin-top:6px">Try again</button>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:4px">← Back</button>`;
    }
    return;
  }
  // Click a Deezer thumbnail — download cover_xl and embed via Discogs embed endpoint
  const deezerThumb = e.target.closest('.np-deezer-thumb');
  if (deezerThumb) {
    const coverUrl = deezerThumb.dataset.coverXl;
    const filepath = deezerThumb.dataset.filepath;
    if (!filepath || !coverUrl) return;
    deezerThumb.classList.add('selected');
    const dsEl   = document.getElementById('np-discogs-section');
    const npLeft = document.getElementById('np-left');
    const _cacheOnly = ['wav','aiff','aif','w64'].includes((filepath || '').split('.').pop().toLowerCase());
    const _label = _cacheOnly ? 'Saving art to database…' : 'Embedding cover art…';
    const _isCurrentSong = S.queue[S.idx]?.filepath === filepath;
    const _wasPlaying    = _isCurrentSong && !audioEl.paused;
    if (_isCurrentSong && _wasPlaying) audioEl.pause();
    if (dsEl) dsEl.innerHTML = `<div class="np-embed-spinner"></div><span class="np-embed-label">${_label}</span>`;
    npLeft?.classList.add('np-left--embedding');
    try {
      const result = await api('POST', 'api/v1/discogs/embed', { filepath, coverUrl });
      if (result?.aaFile) {
        S.queue.forEach(q => { if (q.filepath === filepath) q['album-art'] = result.aaFile; });
        _syncQueueToDb(); // persist new art into server queue so tab-sync restores it correctly
      }
      npLeft?.classList.remove('np-left--embedding');
      npLeft?.classList.remove('np-left--picking');
      if (dsEl) dsEl.dataset.songFp = '';
      renderNPModal();
      if (S.queue[S.idx]?.filepath === filepath) Player.updateBar();
      refreshQueueUI();
      if (_isCurrentSong) {
        clearTimeout(_netRecoveryTimer);
        toast('Album art saved — restarting from the beginning');
        audioEl.addEventListener('loadedmetadata', () => { if (_wasPlaying) audioEl.play().catch(() => {}); }, { once: true });
        audioEl.src = mediaUrl(filepath) + '&_t=' + Date.now();
        audioEl.load();
      }
    } catch(err) {
      npLeft?.classList.remove('np-left--embedding');
      if (_isCurrentSong && _wasPlaying) audioEl.play().catch(() => {});
      if (dsEl) dsEl.innerHTML =
        `<span class="np-discogs-status" style="color:rgba(255,100,100,.8)">Embed failed: ${esc(err?.message || 'error')}</span>` +
        `<button class="np-deezer-search-btn" id="np-deezer-search-btn" style="margin-top:6px">Try again</button>` +
        `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:4px">← Back</button>`;
      deezerThumb.classList.remove('selected');
    }
    return;
  }
  // Click a Discogs thumbnail to embed (not a Deezer thumb — those are handled above)
  const thumb = e.target.closest('.np-discogs-thumb');
  if (!thumb || thumb.classList.contains('np-deezer-thumb')) return;
  if (!thumb) return;
  const releaseId = Number(thumb.dataset.releaseId);
  const filepath  = thumb.dataset.filepath;
  if (!filepath || !releaseId) return;
  thumb.classList.add('selected');
  const dsEl    = document.getElementById('np-discogs-section');
  const npLeft  = document.getElementById('np-left');
  const _cacheOnly = ['wav','aiff','aif','w64'].includes((filepath || '').split('.').pop().toLowerCase());
  const _label  = _cacheOnly ? 'Saving art to database…' : 'Embedding cover art…';

  // Snapshot playback state and pause BEFORE the API call.
  // ffmpeg atomically replaces the file on disk; the browser must not be
  // streaming it at that moment or it will get a mid-stream disconnect.
  const _isCurrentSong = S.queue[S.idx]?.filepath === filepath;
  const _wasPlaying    = _isCurrentSong && !audioEl.paused;
  const _resumeAt      = _isCurrentSong ? audioEl.currentTime : 0;
  if (_isCurrentSong && _wasPlaying) audioEl.pause();

  // Show a full-panel spinner and block further interaction
  if (dsEl) dsEl.innerHTML =
    `<div class="np-embed-spinner"></div>` +
    `<span class="np-embed-label">${_label}</span>`;
  npLeft?.classList.add('np-left--embedding');
  try {
    const result = await api('POST', 'api/v1/discogs/embed', { filepath, releaseId });
    if (result?.aaFile) {
      S.queue.forEach(q => { if (q.filepath === filepath) q['album-art'] = result.aaFile; });
      _syncQueueToDb(); // persist new art into server queue so tab-sync restores it correctly
    }
    npLeft?.classList.remove('np-left--embedding');
    npLeft?.classList.remove('np-left--picking');
    // Force renderNPModal to reset the discogs section by clearing the cached fp
    if (dsEl) dsEl.dataset.songFp = '';
    // Re-render modal (shows new art + resets discogs section)
    renderNPModal();
    // Refresh player bar thumbnail + queue panel
    if (S.queue[S.idx]?.filepath === filepath) Player.updateBar();
    refreshQueueUI();
    // Reload the audio element so the browser re-fetches the new file instead
    // of continuing to decode the old stream. Reset currentTime first to clear
    // Always reload from position 0 — the file was atomically rewritten and
    // byte offsets shift, so seeking to the old currentTime triggers a range
    // request that may land mid-frame in the new file → PTS/demuxer errors.
    if (_isCurrentSong) {
      clearTimeout(_netRecoveryTimer); // prevent stall-recovery from interfering
      toast('Album art saved — restarting from the beginning');
      audioEl.addEventListener('loadedmetadata', () => {
        if (_wasPlaying) audioEl.play().catch(() => {});
      }, { once: true });
      // Re-assign src with a cache-buster so Chrome discards its stale internal
      // byte-range state. Merely calling load() is not enough — Chrome reuses
      // the last Range offset and gets a 416 on the rewritten (differently-sized) file.
      audioEl.src = mediaUrl(filepath) + '&_t=' + Date.now();
      audioEl.load();
    }
  } catch(err) {
    npLeft?.classList.remove('np-left--embedding');
    // Resume playback if we paused it — the file wasn't changed
    if (_isCurrentSong && _wasPlaying) audioEl.play().catch(() => {});
    if (dsEl) dsEl.innerHTML =
      `<span class="np-discogs-status" style="color:rgba(255,100,100,.8)">Embed failed: ${esc(err?.message || 'error')}</span>` +
      `<button class="np-discogs-btn" id="np-discogs-search-btn" style="margin-top:6px">Try again</button>` +
      `<button class="np-discogs-cancel" id="np-discogs-back-btn" style="margin-top:4px">← Back</button>`;
    thumb.classList.remove('selected');
  }
});
// Live image preview when the user types/pastes a URL in the URL-paste input
document.getElementById('np-left').addEventListener('input', e => {
  const inp = e.target.closest('#np-url-paste-inp');
  if (!inp) return;
  const url = inp.value.trim();
  const wrap   = document.getElementById('np-url-paste-preview-wrap');
  const imgEl  = document.getElementById('np-url-paste-preview');
  const statEl = document.getElementById('np-url-paste-status');
  if (!wrap || !imgEl) return;
  if (!url || !/^https?:\/\/.+/i.test(url)) {
    wrap.classList.add('hidden');
    if (statEl) statEl.style.display = 'none';
    return;
  }
  imgEl.onload  = () => { wrap.classList.remove('hidden'); if (statEl) statEl.style.display = 'none'; };
  imgEl.onerror = () => { wrap.classList.add('hidden');    if (statEl) { statEl.textContent = 'Could not load image from that URL'; statEl.style.display = ''; } };
  imgEl.src = url;
});
document.getElementById('np-play-btn').addEventListener('click', () => Player.toggle());
document.getElementById('np-prev-btn').addEventListener('click', () => Player.prev());
document.getElementById('np-next-btn').addEventListener('click', () => Player.next());
document.getElementById('np-prog-track').addEventListener('click', e => {
  // NP modal seek is now handled by the container click in initNpSeekPreview.
  // Keep this as a direct fallback for any programmatic calls.
});
// Seek arrow + time bubble on the NP-modal progress track
(function initNpSeekPreview() {
  const track     = document.getElementById('np-prog-track');
  const container = track.closest('.np-progress');

  const arrow = document.createElement('div');
  arrow.className = 'seek-arrow';
  container.appendChild(arrow);

  const bubble = document.createElement('div');
  bubble.className = 'seek-preview';
  container.appendChild(bubble);

  function onMove(e) {
    const onCue = e.target.closest('.cue-tick');
    const tRect = track.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - tRect.left) / tRect.width));
    const xPx   = tRect.left - cRect.left + pct * tRect.width;
    arrow.style.left = xPx + 'px';
    arrow.classList.toggle('sa-cue', !!onCue);
    arrow.classList.add('sa-show');
    if (onCue) { bubble.classList.remove('sp-show'); return; }
    bubble.style.left = xPx + 'px';
    if (audioEl.duration && isFinite(audioEl.duration)) { bubble.textContent = fmt(pct * audioEl.duration); bubble.classList.add('sp-show'); }
  }
  function onLeave() { arrow.classList.remove('sa-show'); bubble.classList.remove('sp-show'); }
  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseleave', onLeave);
  // Also hide when the song changes (crossfade doesn't trigger mouseleave)
  document.addEventListener('mstream-song-change', onLeave);
  container.addEventListener('click', e => {
    if (e.target.closest('.cue-tick')) return;
    if (S.queue[S.idx]?.isRadio) { _radioSpectrumEnabled = !_radioSpectrumEnabled; _drawWaveform(); return; }
    const r = track.getBoundingClientRect();
    if (audioEl.duration) audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audioEl.duration;
  });
}());
// Time display toggle — click either time span (player bar or NP modal) to flip
// between elapsed|total and total|countdown modes.
document.getElementById('time-cur').addEventListener('click',      _toggleTimeFlipped);
document.getElementById('time-total').addEventListener('click',    _toggleTimeFlipped);
document.getElementById('np-time-cur').addEventListener('click',   _toggleTimeFlipped);
document.getElementById('np-time-total').addEventListener('click', _toggleTimeFlipped);

document.getElementById('np-viz-btn').addEventListener('click', () => { hideNPModal(); VIZ.open(); });

// Visualizer
document.getElementById('viz-open-btn').addEventListener('click', () => VIZ.open());
document.getElementById('viz-close-btn').addEventListener('click', () => VIZ.close());
document.getElementById('viz-prev-btn').addEventListener('click', () => VIZ.prev());
document.getElementById('viz-next-btn').addEventListener('click', () => VIZ.next());
document.getElementById('viz-mode-btn').addEventListener('click', () => VIZ.toggleMode());
document.getElementById('eq-btn').addEventListener('click', () => EQ.toggle());
window.addEventListener('resize', () => {
  const overlay = document.getElementById('viz-overlay');
  if (overlay.classList.contains('hidden')) return;
  const canvas = document.getElementById('viz-canvas');
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
});
document.getElementById('np-rate-clear').addEventListener('click', async () => {
  const s = S.queue[S.idx];
  if (!s) return;
  delete s.rating;
  const ci = S.curSongs.findIndex(cs => cs.filepath === s.filepath);
  if (ci >= 0) {
    delete S.curSongs[ci].rating;
    document.querySelectorAll(`.row-stars[data-ci="${ci}"]`).forEach(el => { el.innerHTML = starsHtml(0); });
  }
  document.querySelectorAll('#np-rate-stars span').forEach(s2 => s2.classList.remove('lit'));
  Player.updateBar();
  await rateSong(s.filepath, null);
});

document.getElementById('np-rate-stars').querySelectorAll('span').forEach((star, i) => {
  star.addEventListener('mouseenter', () => {
    document.querySelectorAll('#np-rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j <= i));
  });
  star.addEventListener('mouseleave', () => {
    const cur = Math.round((S.queue[S.idx]?.rating || 0) / 2);
    document.querySelectorAll('#np-rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j < cur));
  });
  star.addEventListener('click', async () => {
    const s = S.queue[S.idx];
    if (!s) return;
    const val = parseInt(star.dataset.v);
    s.rating = val;
    // Update .lit immediately — don't wait for updateBar→renderNPModal chain
    document.querySelectorAll('#np-rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j <= i));
    const ci = S.curSongs.findIndex(cs => cs.filepath === s.filepath);
    if (ci >= 0) {
      S.curSongs[ci].rating = val;
      document.querySelectorAll(`.row-stars[data-ci="${ci}"]`).forEach(el => { el.innerHTML = starsHtml(val); });
    }
    Player.updateBar();
    await rateSong(s.filepath, val);
  });
});

// ── PLAYLIST MODAL WIRING ─────────────────────────────────────

// "New playlist" button in sidebar
document.getElementById('new-pl-btn').addEventListener('click', () => showNewPlaylistModal());

// "Save queue as playlist" button in queue panel
document.getElementById('qp-save-btn').addEventListener('click', () => {
  if (!S.queue.length) { toast('Queue is empty'); return; }
  showSavePlaylistModal();
});

// pl-new modal
document.getElementById('pl-new-cancel').addEventListener('click', () => hideModal('pl-new-modal'));
document.getElementById('pl-new-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-new-name').value.trim();
  if (!name) return;
  hideModal('pl-new-modal');
  try {
    await api('POST', 'api/v1/playlist/new', { title: name });
    await loadPlaylists();
    toast(`Playlist "${name}" created`);
    openPlaylist(name);
  } catch(e) { toast(e.message?.includes('Already Exists') ? `"${name}" already exists` : 'Failed to create playlist'); }
});
document.getElementById('pl-new-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pl-new-ok').click();
});

// pl-save modal (save current queue into a named playlist)
document.getElementById('pl-save-cancel').addEventListener('click', () => hideModal('pl-save-modal'));
document.getElementById('pl-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-save-name').value.trim();
  if (!name) return;
  hideModal('pl-save-modal');
  try {
    await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
    await loadPlaylists();
    toast(`Saved ${S.queue.length} songs to "${name}"`);
  } catch(e) { toast('Failed to save playlist'); }
});
document.getElementById('pl-save-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pl-save-ok').click();
});

// atp-cancel
document.getElementById('atp-cancel').addEventListener('click', () => hideModal('atp-modal'));

// ── BAR POSITION ─────────────────────────────────────────────
function applyBarPos(top) {
  document.documentElement.classList.toggle('bar-top', top);
}

function _updateListenSection() {
  const section = document.getElementById('podcasts-section');
  if (!section) return;
  const recVpaths = S.vpathMeta ? S.vpaths.filter(v => S.vpathMeta[v]?.type === 'recordings' || S.vpathMeta[v]?.type === 'youtube') : [];
  const show = S.radioEnabled || S.feedsEnabled || S.audiobooksEnabled || recVpaths.length > 0 || S.allowYoutubeDownload;
  section.classList.toggle('hidden', !show);
}

function _applyNavVisibility() {
  const gBtn = document.querySelector('.nav-btn[data-view="genres"]');
  const dBtn = document.querySelector('.nav-btn[data-view="decades"]');
  const rBtn = document.getElementById('radio-nav-btn');
  if (gBtn) gBtn.classList.toggle('hidden', !S.showGenres);
  if (dBtn) dBtn.classList.toggle('hidden', !S.showDecades);
  if (rBtn) rBtn.classList.toggle('hidden', !S.radioEnabled);
  _updateListenSection();
  if (!S.showGenres  && S.view === 'genres')  viewRecent();
  if (!S.showDecades && S.view === 'decades') viewRecent();
  if (!S.radioEnabled && S.view === 'radio')  viewRecent();
}

// ── THEME ─────────────────────────────────────────────────────
// theme: 'velvet' | 'dark' | 'light'
// persist=true  → user chose explicitly, save to localStorage
// persist=false → OS-driven, don't overwrite a future explicit choice
function applyTheme(theme, persist = true) {
  document.documentElement.classList.remove('dark', 'light');
  if (theme === 'dark')  document.documentElement.classList.add('dark');
  if (theme === 'light') document.documentElement.classList.add('light');
  document.querySelectorAll('.theme-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  if (persist) { localStorage.setItem(_uKey('theme'), theme); _syncPrefs(); }
  requestAnimationFrame(() => requestAnimationFrame(_updateBadgeFg));
  // Redraw waveform so unplayed-bar colour matches new theme immediately
  requestAnimationFrame(_drawWaveform);
}
function _updateBadgeFg() {
  const val = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  let r, g, b;
  const hex = val.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const rgb = val.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  const hsl = val.match(/hsla?\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%/);
  if (hex) { r = parseInt(hex[1],16); g = parseInt(hex[2],16); b = parseInt(hex[3],16); }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  else if (hsl) {
    const h = +hsl[1]/360, s = +hsl[2]/100, l = +hsl[3]/100;
    const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    const hue2rgb = (p,q,t) => { if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p; };
    r = Math.round(hue2rgb(p,q,h+1/3)*255); g = Math.round(hue2rgb(p,q,h)*255); b = Math.round(hue2rgb(p,q,h-1/3)*255);
  }
  if (r !== undefined) {
    const lin = c => { c/=255; return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4); };
    const L = 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
    document.documentElement.style.setProperty('--badge-fg', L > 0.35 ? '#111' : '#fff');
  }
}

// Follow OS colour scheme when the user hasn't stored an explicit preference
const _osDark = window.matchMedia('(prefers-color-scheme: dark)');
_osDark.addEventListener('change', e => {
  if (!localStorage.getItem(_uKey('theme'))) applyTheme(e.matches ? 'velvet' : 'light', false);
});

document.querySelectorAll('.theme-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

// ── EASTER EGG ──────────────────────────────────────────────
// Invisible 6×6 pixel at sidebar/content/player corner.
// Click → full LED spectrum appears above the player bar.
// Left channel: "AroundMyRoom" is baked into the bar segments —
// the word is revealed from bottom to top as audio level rises.
// At 100% all bars the full word is readable in the coloured segments.
window.EGG = (() => {
  const H           = 180;
  const BARS        = 90;
  const DECAY       = 0.84;
  const PEAK_HOLD   = 55;
  const PEAK_DECAY  = 0.92;

  // Offscreen text masks — rebuilt whenever channel pixel width changes
  // L channel: "AroundMyRoom" centred
  // R channel: "mStream" left-aligned
  let textMask  = null, textMaskW = 0, textMaskH = 0;
  let rMask     = null, rMaskW   = 0, rMaskH    = 0;

  let raf = null, active = false;
  // [0..BARS-1] = L,  [BARS..2*BARS-1] = R
  let smoothed  = new Float32Array(BARS * 2);
  let peaks     = new Float32Array(BARS * 2);
  let peakTimer = new Int32Array(BARS * 2);

  // Cached per-show values — avoids DOM/layout queries inside the hot draw() loop
  let _eggCanvas  = null;
  let _eggColLeft = 236, _eggColRight = 0;
  let _rawL = null, _rawR = null;  // reused typed arrays — no GC per frame

  function _cacheLayout() {
    _eggCanvas = document.getElementById('egg-canvas');
    const sideEl  = document.querySelector('.sidebar');
    const queueEl = document.getElementById('queue-panel');
    _eggColLeft  = sideEl  ? sideEl.getBoundingClientRect().right : 236;
    const qRect  = queueEl ? queueEl.getBoundingClientRect() : null;
    _eggColRight = (qRect && qRect.width > 20) ? qRect.left : window.innerWidth;
  }

  function barBin(i, totalBins) {
    const minF = 40, maxF = 18000, nyq = 22050;
    const freq = minF * Math.pow(maxF / minF, i / (BARS - 1));
    return Math.min(Math.round(freq / nyq * totalBins), totalBins - 1);
  }

  // Build an alpha mask from text onto a channel-sized offscreen canvas.
  // label   : text to render
  // align   : 'center' | 'left'
  // returns : { mask: Uint8Array, w, h }
  function buildMask(label, align, w, h) {
    const mc = document.createElement('canvas');
    mc.width = w; mc.height = h;
    const mx = mc.getContext('2d');
    mx.clearRect(0, 0, w, h);
    mx.textBaseline = 'middle';
    // Bold Arial/Helvetica: thick rectangular strokes, wide letterforms —
    // ideal for LED segment masks (not squished like Impact, not puffy like Arial Black)
    const face = '"Helvetica Neue","Arial","Liberation Sans",sans-serif';
    let fs = Math.floor(h * 0.72);
    mx.font = `900 ${fs}px ${face}`;
    const maxW = (align === 'left' || align === 'right') ? w * 0.96 : w * 0.94;
    while (mx.measureText(label).width > maxW && fs > 8) {
      fs--;
      mx.font = `900 ${fs}px ${face}`;
    }
    mx.textAlign = align;
    const drawX  = align === 'left'  ? w * 0.025
                 : align === 'right' ? w * 0.975
                 : w / 2;
    mx.fillStyle = '#ffffff';
    mx.fillText(label, drawX, h / 2);
    const id  = mx.getImageData(0, 0, w, h);
    const buf = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) buf[p] = id.data[p * 4 + 3];
    return { mask: buf, w, h };
  }

  function ensureMasks(lw, rw, h) {
    if (textMaskW !== lw || textMaskH !== h || !textMask) {
      const r = buildMask('AroundMyRoom', 'left', lw, h);
      textMask = r.mask; textMaskW = r.w; textMaskH = r.h;
    }
    if (rMaskW !== rw || rMaskH !== h || !rMask) {
      const r = buildMask('mStream', 'right', rw, h);
      rMask = r.mask; rMaskW = r.w; rMaskH = r.h;
    }
  }

  // Returns true when the given canvas point falls inside a letter stroke.
  // edgeX : left pixel edge of the channel in canvas space
  function sampleMask(mask, mW, mH, canvX, edgeX, segMidY) {
    if (!mask) return false;
    const px = Math.min(Math.max(Math.round(canvX - edgeX), 0), mW - 1);
    const py = Math.min(Math.max(Math.round(segMidY),       0), mH - 1);
    return mask[py * mW + px] > 55;
  }

  function draw() {
    if (!active) return;
    raf = requestAnimationFrame(draw);

    const cv = _eggCanvas;
    if (!cv) return;
    if (cv.width !== window.innerWidth) { cv.width = window.innerWidth; _cacheLayout(); }
    const W  = cv.width;
    const cx = cv.getContext('2d');
    cx.clearRect(0, 0, W, H);

    // Cached column bounds — recalculated on show() and resize, not every frame
    const colLeft  = _eggColLeft;
    const colRight = _eggColRight > 0 ? _eggColRight : W;
    const colW     = colRight - colLeft;
    if (colW < 20) return;

    cx.save();
    cx.beginPath();
    cx.rect(colLeft, 0, colW, H);
    cx.clip();

    // FFT data — reuse pre-allocated typed arrays to avoid GC pressure
    const fftSize = analyserL ? analyserL.frequencyBinCount : 1024;
    if (!_rawL || _rawL.length !== fftSize) { _rawL = new Uint8Array(fftSize); _rawR = new Uint8Array(fftSize); }
    if (analyserL) analyserL.getByteFrequencyData(_rawL);
    if (analyserR) analyserR.getByteFrequencyData(_rawR);
    const rawL = _rawL, rawR = _rawR;

    const SEG_H    = 2;
    const SEG_GAP  = 1;
    const SEG_STEP = SEG_H + SEG_GAP;
    const MAX_SEGS = Math.floor(H / SEG_STEP);
    const CG       = 10;
    const halfW    = (colW - CG) / 2;
    const bw       = halfW / BARS;
    const barW     = Math.max(Math.round(bw * 0.44), 2);

    // Ensure both masks match current channel pixel dimensions
    ensureMasks(Math.ceil(halfW), Math.ceil(halfW), H);

    // ── Draw one channel ─────────────────────────────────────
    // mask / mW / mH / maskEdge : text-mask params (pass null mask for none)
    function drawChannel(rawData, offset, startX, flip, mask, mW, mH, maskEdge) {
      for (let i = 0; i < BARS; i++) {
        const si = offset + i;
        const b0 = barBin(i,     fftSize);
        const b1 = barBin(i + 1, fftSize);
        let sum = 0, cnt = 0;
        for (let b = b0; b <= Math.min(b1, fftSize - 1); b++) { sum += rawData[b]; cnt++; }
        const raw = cnt ? sum / cnt / 255 : 0;

        smoothed[si] = Math.max(raw, smoothed[si] * DECAY);
        if (smoothed[si] >= peaks[si]) { peaks[si] = smoothed[si]; peakTimer[si] = PEAK_HOLD; }
        else if (peakTimer[si] > 0)    { peakTimer[si]--; }
        else                            { peaks[si] *= PEAK_DECAY; }

        const amp  = smoothed[si];
        const segs = Math.floor(Math.min(amp * 1.25, 1.0) * MAX_SEGS);
        if (segs < 1) continue;

        const col = flip ? (BARS - 1 - i) : i;
        const x   = startX + col * bw + (bw - barW) / 2;
        const xMid = x + barW * 0.5;   // horizontal centre of this bar column

        const topT    = segs / MAX_SEGS;
        const glowHue = topT < 0.55 ? 110 - topT * 100
                      : topT < 0.80 ? 10  - (topT - 0.55) / 0.25 * 5
                      : 5;

        for (let s = 0; s < segs; s++) {
          const segTop = H - (s + 1) * SEG_STEP + SEG_GAP;
          const segMid = segTop + SEG_H * 0.5;
          const t      = s / MAX_SEGS;
          const segHue = t < 0.55 ? 110 - t * 100
                       : t < 0.80 ? 10  - (t - 0.55) / 0.25 * 5
                       : 5;

          // Check whether this segment's pixel lands inside a letter stroke
          // shadowBlur is intentionally NOT set per-segment — it is extremely
          // expensive on every fillRect call and causes the browser to stall.
          // Glow is applied once per bar (below) on the topmost segment only.
          if (mask && sampleMask(mask, mW, mH, xMid, maskEdge, segMid)) {
            // ── Letter segment: cyan #00F5FF — max contrast on green/yellow/red ──
            cx.shadowBlur  = 0;
            cx.fillStyle   = `rgba(0,245,255,${0.80 + t * 0.20})`;
          } else {
            // ── Normal segment: green → yellow → red hue ──
            cx.shadowBlur  = 0;
            cx.fillStyle   = `hsla(${segHue},95%,${52 + t * 12}%,${0.65 + t * 0.35})`;
          }
          cx.fillRect(Math.round(x), segTop, barW, SEG_H);
        }

        // Glow on topmost active segment (once per bar, not per segment)
        if (segs >= 1) {
          const topSegTop = H - segs * SEG_STEP + SEG_GAP;
          cx.shadowColor = `hsla(${glowHue},90%,65%,0.55)`;
          cx.shadowBlur  = 4 + amp * 6;
          cx.fillStyle   = `hsla(${glowHue},95%,${52 + topT * 12}%,0.9)`;
          cx.fillRect(Math.round(x), topSegTop, barW, SEG_H);
          cx.shadowBlur  = 0;
        }

        // Peak hold segment
        if (peaks[si] > 0.04) {
          const ps   = Math.floor(Math.min(peaks[si] * 1.25, 1.0) * MAX_SEGS);
          const py   = H - ps * SEG_STEP - SEG_H;
          const pt   = ps / MAX_SEGS;
          const phue = pt < 0.55 ? 110 - pt * 100 : pt < 0.80 ? 10 : 5;
          cx.shadowBlur = 0;
          cx.fillStyle  = `hsla(${phue},100%,92%,0.95)`;
          cx.fillRect(Math.round(x), py, barW, SEG_H);
        }
      }
    }

    const rStart = colLeft + halfW + CG;
    // L: treble outer-left → bass at centre  | mStream mask
    drawChannel(_rawL, 0,    colLeft, true,  rMask,    rMaskW,    rMaskH,    colLeft);
    // R: bass at centre → treble outer-right | AroundMyRoom mask (left-aligned)
    drawChannel(_rawR, BARS, rStart,  false, textMask, textMaskW, textMaskH, rStart);

    cx.shadowBlur = 0;
    cx.restore();
  }

  function show() {
    smoothed.fill(0); peaks.fill(0); peakTimer.fill(0);
    textMaskW = 0; rMaskW = 0;  // force mask rebuild with fresh column dimensions
    _cacheLayout();  // snapshot sidebar/queue bounds once — not on every frame
    const cv = _eggCanvas;
    if (!cv) return;
    cv.style.transition = '';
    cv.style.opacity    = '1';
    cv.style.display    = 'block';
    cv.width  = window.innerWidth;
    cv.height = H;
    active = true;
    cancelAnimationFrame(raf);
    draw();
  }

  function hide() {
    active = false;
    cancelAnimationFrame(raf);
    if (_eggCanvas) _eggCanvas.style.display = 'none';
  }

  const _epx = document.getElementById('egg-pixel');
  if (_epx) _epx.addEventListener('click', () => { active ? hide() : show(); });

  // Click anywhere else on the page to dismiss
  document.addEventListener('click', e => {
    if (active && e.target !== document.getElementById('egg-pixel')) hide();
  });

  return { toggle() { active ? hide() : show(); } };
})();

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.target.isContentEditable) return;

  switch (e.code) {
    case 'Escape':
      hideNPModal(); hideCtxMenu(); VIZ.close();
      break;
    case 'Space':
      e.preventDefault(); Player.toggle();
      break;
    // ← → seek ±5s  (Shift+← → skip track)
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) { Player.next(); }
      else if (audioEl.duration) { audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 5); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) { Player.prev(); }
      else if (audioEl.duration) { audioEl.currentTime = Math.max(0, audioEl.currentTime - 5); }
      break;
    // ↑ ↓ volume ±5%
    case 'ArrowUp': {
      e.preventDefault();
      const vUp = Math.min(100, Math.round(audioEl.volume * 100) + 5);
      audioEl.volume = vUp / 100;
      const slUp = document.getElementById('volume');
      if (slUp) slUp.value = vUp;
      _setVolPct(vUp);
      break;
    }
    case 'ArrowDown': {
      e.preventDefault();
      const vDn = Math.max(0, Math.round(audioEl.volume * 100) - 5);
      audioEl.volume = vDn / 100;
      const slDn = document.getElementById('volume');
      if (slDn) slDn.value = vDn;
      _setVolPct(vDn);
      break;
    }
    case 'KeyM':
      document.getElementById('mute-btn')?.click();
      break;
    case 'KeyS':
      if (!e.ctrlKey && !e.metaKey) {
        S.shuffle = !S.shuffle;
        document.getElementById('shuffle-btn').classList.toggle('active', S.shuffle);
        _showInfoStrip('', _shuffleStripHtml(), 3000, true);
      }
      break;
  }
});

// ── SIDEBAR COLLAPSE ─────────────────────────────────────────
(function initSectionCollapse() {
  const KEY = 'ms2_nav_collapsed';
  const stored = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  document.querySelectorAll('.nav-section').forEach(section => {
    if (stored.has(section.dataset.section) || section.dataset.section === 'tools') section.classList.add('collapsed');
    section.querySelector('.nav-toggle').addEventListener('click', e => {
      if (e.target.closest('#new-pl-btn')) return;
      if (e.target.closest('#new-spl-btn')) return;
      section.classList.toggle('collapsed');
      const collapsed = [...document.querySelectorAll('.nav-section.collapsed')]
        .map(s => s.dataset.section);
      localStorage.setItem(KEY, JSON.stringify(collapsed));
    });
  });
}());

// ── LOGOUT BROADCAST ────────────────────────────────────────
// Stop playback and redirect to login if any other tab (e.g. admin) logs out.
try {
  const _logoutChannel = new BroadcastChannel('mstream');
  _logoutChannel.onmessage = e => {
    if (e.data?.type === 'logout') {
      audioEl.pause();
      persistQueue();   // save playing:false before token is wiped
      localStorage.removeItem('ms2_token');
      localStorage.removeItem('token');
      window.location.assign(window.location.origin + '/');
    }
  };
} catch(e) {}

// ── INIT ─────────────────────────────────────────────────────
(async () => {
  // Apply saved theme before anything renders (prevents flash).
  // If no explicit preference stored, honour the OS colour scheme.
  const _savedTheme = localStorage.getItem(_uKey('theme'));
  applyTheme(
    _savedTheme || (!window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'velvet'),
    !!_savedTheme   // only persist if the user had already made an explicit choice
  );
  applyBarPos(S.barTop);
  _applyNavVisibility();

  const ok = await checkSession();
  ok ? showApp() : showLogin();
})();

/* ── CUSTOM TOOLTIP ─────────────────────────────────────────── */
(function() {
  const tip = document.getElementById('tip-box');
  if (!tip) return;
  let hideT = null;
  let autoT = null;

  function convertTitles(root) {
    const els = root ? [root, ...root.querySelectorAll('[title]')] : document.querySelectorAll('[title]');
    els.forEach(el => {
      if (el.hasAttribute && el.hasAttribute('title')) {
        el.setAttribute('data-tip', el.getAttribute('title'));
        el.removeAttribute('title');
      }
    });
  }
  convertTitles();
  new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) convertTitles(n); }));
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    clearTimeout(hideT);
    tip.textContent = el.getAttribute('data-tip');
    const r = el.getBoundingClientRect();
    // Measure after setting text
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 8;
    if (x < 6) x = 6;
    if (x + tw > window.innerWidth - 6) x = window.innerWidth - tw - 6;
    if (y < 6) y = r.bottom + 8;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
    tip.classList.add('tip-show');
    clearTimeout(autoT);
    autoT = setTimeout(() => tip.classList.remove('tip-show'), 5000);
  });

  document.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    clearTimeout(autoT);
    hideT = setTimeout(() => tip.classList.remove('tip-show'), 80);
  });

  document.addEventListener('mousedown', () => { clearTimeout(autoT); tip.classList.remove('tip-show'); });
})();
