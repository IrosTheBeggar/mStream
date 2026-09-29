// Peer sync — the pure half of "Add to your collection" on the browse
// panels (design set docs/designs/peer-sync, cards 02 + 03): while the app
// is pointed at a paired server, every row learns what this library has of
// it and one Add action, and a pressed row is its job. This module holds
// what needs no DOM: names into keys, a peer's album list into an artist
// index, the jobs list matched to rows, the slot's markup for a row's
// state, and a recommendation built from a row. m.js glues it to the
// lists (which are innerHTML strings, rebuilt on every navigation and
// filter — so a renderer asks for a slot's markup at render time and the
// filter reproduces it); vp.js feeds it the job list and polls faster
// while a copying row is on screen. Loaded after discover-jobs.js and
// before vp.js (index.html); a UMD, so test/unit/webapp-peer-sync.test.mjs
// requires it on node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.PEERSYNC = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COPY_PLUGIN = 'federation-copy';
  const SCOPES = ['song', 'album', 'artist', 'artist-missing', 'folder'];
  const KINDS = ['song', 'album', 'artist', 'folder'];

  // src/db/name-key.js, byte for byte: whitespace runs to one space, trim,
  // Unicode quotes and dashes to their ASCII forms, lowercase. The server
  // keys artists and compares albums with it (owned.js), so a row's
  // identity here agrees with what a job then does. Parity-tested.
  const SINGLE_QUOTES = /[‘’‚‛′]/g;
  const DOUBLE_QUOTES = /[“”„‟″]/g;
  const DASHES = /[‐‑‒–—―−]/g;
  function nameKey(raw) {
    if (raw == null) { return ''; }
    return String(raw)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(DASHES, '-')
      .toLowerCase();
  }

  // A path on a peer as one string, whatever the panel held: the File
  // Explorer's rows carry "/vpath/rel", album songs, search hits and the
  // recursive listing "vpath/rel". Case kept — a peer may tell two apart.
  function normalizePath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.').join('/');
  }

  // A row's identity — the same for the row and for the job that acts on
  // it. `ident`: a song's or folder's path; an album { album, albumArtist |
  // artist }; an artist's name. The artist scopes (artist, artist-missing)
  // both act on the artist row.
  function syncKey(kind, peerId, ident) {
    const pid = peerId == null ? '' : String(peerId);
    if (kind === 'song') { return 'song:' + pid + ':' + normalizePath(ident); }
    if (kind === 'folder') { return 'folder:' + pid + ':' + normalizePath(ident); }
    if (kind === 'album') {
      const o = (ident && typeof ident === 'object') ? ident : { album: ident };
      return 'album:' + pid + ':' + nameKey(o.albumArtist || o.artist) + '|' + nameKey(o.album || o.name);
    }
    if (kind === 'artist') {
      const name = (ident && typeof ident === 'object') ? (ident.artist || ident.name) : ident;
      return 'artist:' + pid + ':' + nameKey(name);
    }
    return null;
  }

  function jobScope(job) { return (job && job.params && job.params.scope) || 'song'; }

  // The key a copy job sits under, from what it was started with; null
  // for a job that is not a peer copy or names no peer.
  function jobKeyOf(job) {
    if (!job || job.plugin !== COPY_PLUGIN) { return null; }
    const rec = job.recommendation || {};
    const peerId = rec.peer && rec.peer.id;
    if (peerId == null) { return null; }
    const scope = jobScope(job);
    if (scope === 'song') { return rec.filepath ? syncKey('song', peerId, rec.filepath) : null; }
    if (scope === 'folder') { return rec.filepath ? syncKey('folder', peerId, rec.filepath) : null; }
    if (scope === 'album') { return rec.album ? syncKey('album', peerId, { album: rec.album, albumArtist: rec.albumArtist || rec.artist }) : null; }
    if (scope === 'artist' || scope === 'artist-missing') { return rec.artist ? syncKey('artist', peerId, rec.artist) : null; }
    return null;
  }

  function isLive(job) { return !!job && (job.state === 'queued' || job.state === 'running'); }

  // The newest copy job per row key. The list comes newest first; go by id.
  function matchJobs(jobs) {
    const out = new Map();
    for (const job of (Array.isArray(jobs) ? jobs : [])) {
      const k = jobKeyOf(job);
      if (!k) { continue; }
      const held = out.get(k);
      if (!held || (Number(job.id) || 0) > (Number(held.id) || 0)) { out.set(k, job); }
    }
    return out;
  }

  // A peer's album list (POST /db/albums, the list its Albums panel draws)
  // grouped by album artist: what an artist row can say once that list has
  // landed — how many albums, how many songs, and their names for the owned
  // lookup (card 02 ②). Albums without a credit belong to no artist row.
  function artistIndex(albums) {
    const out = new Map();
    for (const al of (Array.isArray(albums) ? albums : [])) {
      if (!al || !al.name || !al.album_artist) { continue; }
      const k = nameKey(al.album_artist);
      let e = out.get(k);
      if (!e) { e = { name: al.album_artist, albums: 0, songs: 0, names: [] }; out.set(k, e); }
      e.albums += 1;
      e.songs += Number(al.track_count) || 0;
      e.names.push(al.name);
    }
    return out;
  }

  // ── The slot ─────────────────────────────────────────────────────────
  // What the side of a row shows. Never a `<li`, never `data-file_location`
  // and never the class `filez` — the local filter splits rows on the
  // first and `addAll()` queues by the others.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const ICONS = {
    add: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2zm3 12v-2h-2v-2h2v-2h2v2h2v2h-2v2h-2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.5 5v5.25l4.5 2.67-.75 1.23L11 13V7h1.5z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  };

  // The one word per kind for an idle row ("Add", "Add album", …), and the
  // partial case ("Add the 2 you don't have" / "Add what you're missing").
  function addLabel(kind, facts, t) {
    if (facts && facts.owned === 'part') {
      const n = Number(facts.missing);
      return Number.isFinite(n) && n > 0 ? t('peers.sync.addMissing', { count: n }) : t('peers.sync.addMissingSome');
    }
    return t('peers.sync.add.' + (KINDS.indexOf(kind) === -1 ? 'song' : kind));
  }

  // The sub-line of a job row as words: a key, a text, or parts joined.
  function subText(sub, t) {
    if (!sub) { return ''; }
    if (Array.isArray(sub.parts)) { return sub.parts.map((p) => subText(p, t)).filter(Boolean).join(' · '); }
    if (sub.key) { return t(sub.key, sub.params); }
    return String(sub.text || '');
  }

  // `row` is DISCOVERJOBS.jobRowState(job) for the row's newest job, or
  // null; `facts` what the owned lookup said ({ owned: 'all' | 'part' |
  // 'none', missing, have, total } or null when nothing is known yet).
  // `t` translates. The markup carries no handlers: m.js delegates clicks
  // on `[data-sync-act]` and reads the row's own data-* attributes.
  function slotHtml({ kind, facts, row, t, filepath }) {
    const tt = typeof t === 'function' ? t : ((k) => k);
    if (row && row.state !== 'idle') {
      const tagCls = row.tagCls ? ' sync-tag-' + row.tagCls : '';
      const icon = row.icon === 'clock' ? ICONS.clock : (row.icon === 'warn' ? ICONS.warn : (row.icon === 'close' ? ICONS.close : (row.icon === 'check' ? ICONS.check : '')));
      const sub = subText(row.sub, tt);
      let html = '<span class="sync-job' + (row.muted ? ' sync-job-muted' : '') + '">';
      if (row.tag) { html += '<span class="sync-tag' + tagCls + '">' + icon + esc(tt(row.tag)) + '</span>'; }
      if (sub) { html += '<small class="sync-sub' + (row.errored ? ' sync-sub-err' : '') + '">' + esc(sub) + '</small>'; }
      if (row.progress !== null && row.progress !== undefined) {
        html += row.progress === 'indeterminate'
          ? '<span class="sync-progress sync-progress-indet"><i></i></span>'
          : '<span class="sync-progress"><i style="width:' + Math.max(0, Math.min(100, Number(row.progress) || 0)) + '%"></i></span>';
      }
      const actions = Array.isArray(row.actions) ? row.actions : [];
      if (actions.indexOf('play') !== -1 && (row.filepath || filepath)) {
        html += '<a href="javascript:void(0)" class="sync-link" data-sync-act="play" data-sync-file="' + esc(row.filepath || filepath) + '">' + esc(tt('discover.modal.play')) + '</a>';
      }
      if (actions.indexOf('cancel') !== -1) { html += '<a href="javascript:void(0)" class="sync-link sync-danger" data-sync-act="cancel">' + esc(tt('discover.modal.cancel')) + '</a>'; }
      if (actions.indexOf('retry') !== -1) { html += '<a href="javascript:void(0)" class="sync-link" data-sync-act="retry">' + esc(tt('discover.job.retry')) + '</a>'; }
      if (actions.indexOf('start') !== -1 && row.state === 'cancelled') { html += '<a href="javascript:void(0)" class="sync-link" data-sync-act="add">' + esc(tt('peers.sync.addRest')) + '</a>'; }
      html += '</span>';
      return html;
    }
    if (facts && facts.owned === 'all') {
      return '<span class="sync-tick">' + ICONS.check + esc(tt(kind === 'song' ? 'peers.sync.yours' : 'peers.sync.allYours')) + '</span>';
    }
    const part = !!(facts && facts.owned === 'part');
    return '<a href="javascript:void(0)" class="sync-act' + (part ? ' sync-show' : '') + '" data-sync-act="add">' + ICONS.add + esc(addLabel(kind, facts, tt)) + '</a>';
  }

  // The facts line under an artist row, from the peer's album index and
  // what the owned lookup said: "2 albums · 17 songs", "2 albums · you have
  // 1", or nothing until the album list has landed.
  function artistFacts(entry, owned, t) {
    const tt = typeof t === 'function' ? t : ((k) => k);
    const parts = [];
    if (entry) {
      parts.push(tt('peers.sync.albumCount', { count: entry.albums }));
      if (owned && owned.owned && owned.have > 0 && owned.have < entry.albums) { parts.push('<em>' + esc(tt('peers.sync.youHave', { count: owned.have })) + '</em>'); }
      else if (entry.songs > 0) { parts.push(tt('peers.sync.songCount', { count: entry.songs })); }
      return parts.map((p) => (p.startsWith('<em>') ? p : esc(p))).join(' · ');
    }
    if (owned && owned.owned) { return '<em>' + esc(tt('peers.sync.inCollection')) + '</em>'; }
    return '';
  }

  // What the owned lookup's artist answer means for a row, once the album
  // index is in: everything, part, or none of the peer's albums.
  function artistOwnership(entry, owned) {
    if (!owned) { return null; }
    if (!owned.owned) { return { owned: 'none', have: 0, missing: entry ? entry.albums : null, total: entry ? entry.albums : null }; }
    if (!entry) { return { owned: 'part', have: null, missing: null, total: null }; }   // has the artist; the numbers wait for the list
    const missing = Array.isArray(owned.missing) ? owned.missing.length : Math.max(0, entry.albums - (owned.have || 0));
    if (missing <= 0) { return { owned: 'all', have: entry.albums, missing: 0, total: entry.albums }; }
    return { owned: 'part', have: entry.albums - missing, missing, total: entry.albums };
  }

  // ── A recommendation from a row ──────────────────────────────────────
  // What the job route takes (its Joi): strings trimmed and bounded, a year
  // only within 1000–9999, a length only when it is a number, never an
  // ISRC (a bad one is a 400), the album's own credit when the row knows it.
  function buildRecommendation(kind, row, peer) {
    const r = row || {};
    const p = { id: peer && peer.id != null ? peer.id : null, name: (peer && peer.name) || null };
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 512) : null);
    const year = Number(r.year);
    const y = Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
    const dur = Number(r.duration);
    const d = Number.isFinite(dur) && dur >= 0 ? dur : null;
    const base = { source: 'federation', peer: p };
    if (kind === 'song') {
      return { ...base, filepath: normalizePath(r.filepath), title: str(r.title), artist: str(r.artist), album: str(r.album), albumArtist: str(r.albumArtist || r.album_artist), year: y, duration: d };
    }
    if (kind === 'album') {
      return { ...base, album: str(r.album || r.name), albumArtist: str(r.albumArtist || r.album_artist), artist: str(r.artist), year: y };
    }
    if (kind === 'artist') { return { ...base, artist: str(r.artist || r.name) }; }
    if (kind === 'folder') {
      const fp = normalizePath(r.filepath || r.path || r.directory);
      return { ...base, filepath: fp, title: fp.split('/').pop() || null };
    }
    return null;
  }

  // The scope a kind's Add asks for; the artist's is "what you're missing"
  // when the library has part of the artist, every album otherwise.
  function scopeFor(kind, facts) {
    if (kind === 'artist') { return facts && facts.owned === 'part' ? 'artist-missing' : 'artist'; }
    return kind;
  }

  // ── The live registry ────────────────────────────────────────────────
  // What the poller needs to know without the DOM: which row keys are on
  // screen (m.js says, on every render) and which of those have a live job
  // (fed by the job list). vp.js beats faster while any is.
  const state = { visible: new Set(), jobs: new Map(), live: new Set() };
  function setVisible(keys) { state.visible = new Set(Array.isArray(keys) ? keys : []); }
  function applyJobs(jobs) {
    state.jobs = matchJobs(jobs);
    state.live = new Set();
    for (const [k, job] of state.jobs) { if (isLive(job)) { state.live.add(k); } }
    return state.jobs;
  }
  function jobFor(key) { return state.jobs.get(key) || null; }
  function hasLiveVisible() { for (const k of state.visible) { if (state.live.has(k)) { return true; } } return false; }

  return {
    COPY_PLUGIN, SCOPES, KINDS,
    nameKey, normalizePath, syncKey, jobScope, jobKeyOf, isLive, matchJobs, artistIndex,
    esc, addLabel, subText, slotHtml, artistFacts, artistOwnership, buildRecommendation, scopeFor,
    setVisible, applyJobs, jobFor, hasLiveVisible,
  };
}));
