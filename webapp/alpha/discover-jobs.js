// The Discover job rows' pure half: what a plug-in job looks like as a row
// ("Get it", Keep a copy, the downloads strip), where a
// download or a collection copy will land for the layout being typed, what
// a download record looks like as a row (the Downloads view, the admin's
// Downloads tab), and what has to leave the queue when a download is
// removed. No DOM, no Vue, no fetch — vp.js and m.js wire it to the app;
// the unit test (test/unit/webapp-discover-jobs.test.mjs) drives it on node
// and holds the layout half to the server's engine. Same UMD shape as
// alpha/auto-dj.js.
//
// Text never leaves here as English: a row carries i18n KEYS with their
// params ({ key, params }) and the caller translates. Server text (a job's
// status line, its error) travels as { text }.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DISCOVERJOBS = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  // ── the layout engine, mirrored ────────────────────────────────────────
  // src/torrent/path-template.js + src/discovery-plugins/destination.js.
  // The server renders the real path and has the last word; this renders the
  // same thing as the user types so the picker's preview never lies. Any
  // change to the rules there has to be made here too — the unit test fails
  // when the two disagree.
  const LAYOUT_VARS = ['ARTIST', 'ALBUM', 'YEAR', 'GENRE', 'ALBUMARTIST', 'PEER'];
  // The server's default (src/discovery-plugins/destination.js): the album's
  // credit, falling back to the song's artist — a compilation stays together.
  const DEFAULT_LAYOUT = '{{ALBUMARTIST}}/{{ALBUM}}';
  const MAX_TEMPLATE_LEN = 500;
  const MAX_RESOLVED_LEN = 500;
  const MAX_SEGMENT_LEN = 200;
  const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  // The sample the server validates a layout against (SAMPLE_METADATA + peer).
  const SAMPLE_TAGS = { artist: 'Pink Floyd', album: 'The Dark Side of the Moon', year: '1973', genre: 'Progressive Rock', albumartist: 'Pink Floyd' };
  const SAMPLE_PEER = "Sam's server";

  function sanitizeSegment(raw) {
    if (raw == null) { return ''; }
    let s = String(raw);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > MAX_SEGMENT_LEN) { s = s.slice(0, MAX_SEGMENT_LEN); }
    return s;
  }

  function resolveLayout(layout, meta) {
    if (!layout || typeof layout !== 'string') { return { path: '', missingVars: [] }; }
    const m = meta || {};
    const lookup = {
      ARTIST: sanitizeSegment(m.artist),
      ALBUM: sanitizeSegment(m.album),
      YEAR: sanitizeSegment(m.year),
      GENRE: sanitizeSegment(m.genre),
      ALBUMARTIST: sanitizeSegment(m.albumartist || m.artist),
      PEER: sanitizeSegment(m.peer),
    };
    const missing = [];
    const substituted = layout.replace(TOKEN_RE, (raw, name) => {
      const key = name.toUpperCase();
      const v = lookup[key];
      if (v == null || v === '') {
        if (missing.indexOf(key) === -1) { missing.push(key); }
        return '';
      }
      return v;
    });
    const segments = substituted.split(/[/\\]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    let path = segments.join('/');
    if (path.length > MAX_RESOLVED_LEN) { path = path.slice(0, MAX_RESOLVED_LEN); }
    return { path, missingVars: missing };
  }

  // { valid: true } or { valid: false, error, variable? } — `error` is the
  // server's code, so one translation table serves both.
  function validateResolvedPath(path) {
    if (typeof path !== 'string') { return { valid: false, error: 'invalid_type' }; }
    if (path.length === 0) { return { valid: false, error: 'empty_path' }; }
    if (path.length > MAX_RESOLVED_LEN) { return { valid: false, error: 'path_too_long' }; }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(path)) { return { valid: false, error: 'invalid_chars' }; }
    if (path.startsWith('/') || path.startsWith('\\')) { return { valid: false, error: 'absolute_path' }; }
    if (/^[a-zA-Z]:/.test(path)) { return { valid: false, error: 'drive_letter' }; }
    if (path.includes('~') || /\$HOME\b/.test(path) || /\$\{HOME\}/.test(path)) { return { valid: false, error: 'home_string' }; }
    for (const seg of path.split(/[/\\]/)) {
      if (seg === '..') { return { valid: false, error: 'traversal' }; }
      if (/^[a-zA-Z]:/.test(seg)) { return { valid: false, error: 'drive_letter_segment' }; }
    }
    return { valid: true };
  }

  function validateLayout(layout) {
    if (typeof layout !== 'string') { return { valid: false, error: 'invalid_type' }; }
    if (layout.length === 0) { return { valid: false, error: 'empty_template' }; }
    if (layout.length > MAX_TEMPLATE_LEN) { return { valid: false, error: 'template_too_long' }; }
    const tokens = [];
    let stripped = layout;
    layout.replace(TOKEN_RE, (raw, name) => { tokens.push({ raw, name: name.toUpperCase() }); return raw; });
    for (const tok of tokens) { stripped = stripped.replace(tok.raw, ''); }
    if (stripped.includes('{') || stripped.includes('}')) { return { valid: false, error: 'unbalanced_braces' }; }
    for (const tok of tokens) {
      if (LAYOUT_VARS.indexOf(tok.name) === -1) { return { valid: false, error: 'unknown_variable', variable: tok.name }; }
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(layout)) { return { valid: false, error: 'invalid_chars' }; }
    if (layout.startsWith('/') || layout.startsWith('\\')) { return { valid: false, error: 'absolute_template' }; }
    const sample = resolveLayout(layout, { ...SAMPLE_TAGS, peer: SAMPLE_PEER }).path;
    const check = validateResolvedPath(sample);
    return check.valid ? { valid: true } : check;
  }

  function normalizeBase(base) {
    const raw = String(base == null ? '' : base).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
    if (raw === '') { return { valid: true, base: '' }; }
    const check = validateResolvedPath(raw);
    return check.valid ? { valid: true, base: raw } : { valid: false, error: check.error };
  }

  function safeFileName(filePath) {
    const last = String(filePath || '').split('/').filter(Boolean).pop() || '';
    // eslint-disable-next-line no-control-regex
    let name = last.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
    if (name === '' || name === '..') { name = 'track'; }
    return name;
  }

  // Where one song lands: the library, the base folder, what the layout
  // rendered from the tags, the file. `error` is set (and `rendered` empty)
  // when the layout or the base folder would be refused; `missingVars` names
  // the variables this song has no value for — their segments drop out.
  function previewTarget({ vpath, base, layout, tags, peerName, fileName }) {
    const t = tags || {};
    const b = normalizeBase(base);
    const l = validateLayout(layout);
    const file = safeFileName(fileName);
    if (!b.valid) { return { valid: false, error: b.error, field: 'base', library: vpath || '', base: '', rendered: '', file, relPath: '', missingVars: [] }; }
    if (!l.valid) { return { valid: false, error: l.error, variable: l.variable || null, field: 'layout', library: vpath || '', base: b.base, rendered: '', file, relPath: '', missingVars: [] }; }
    const { path: rendered, missingVars } = resolveLayout(layout, {
      artist: t.artist, album: t.album, year: t.year, genre: t.genre, albumartist: t.albumartist, peer: peerName,
    });
    if (rendered) {
      const check = validateResolvedPath(rendered);
      if (!check.valid) { return { valid: false, error: check.error, field: 'layout', library: vpath || '', base: b.base, rendered: '', file, relPath: '', missingVars }; }
    }
    const relDir = [b.base, rendered].filter(Boolean).join('/');
    return { valid: true, error: null, field: null, library: vpath || '', base: b.base, rendered, file, relDir, relPath: relDir ? `${relDir}/${file}` : file, missingVars };
  }

  // "music/A/B/c.mp3" → ['music', 'A', 'B', 'c.mp3'], for a breadcrumb.
  function pathCrumbs(filepath) {
    return String(filepath || '').split('/').filter(Boolean);
  }

  // ── where a copy of one scope lands ────────────────────────────────────
  // The path bar, the editor's preview and the "Into" line of a running
  // copy render the base folder and the layout with the tags of what the
  // scope copies — never the seed song's own folder for a wider scope. The
  // caller hands in the scope's tags (vp.js dmScopeTags):
  //   song            the song's own; the file on a line of its own
  //   album           the album's: its credit as ALBUMARTIST, so a
  //                   compilation stays in one folder
  //   artist          the artist as ARTIST and ALBUMARTIST, no album: the
  //                   first folder that names an album ({{ALBUM}}, or
  //                   {{YEAR}} — each album has its own) and every folder
  //                   after it become one "one folder per album" note; a
  //                   layout that names no album adds nothing (every album
  //                   shares that folder)
  //   artist-missing  the same — or, when exactly one album is missing
  //                   (`oneAlbum`: its { name, year }), that album's folder
  // The answer is previewTarget's (valid, error, field, variable,
  // missingVars: the editor's checks) plus `crumbs` — the base folder's
  // segments ({ text, kind: 'base' }), what the layout rendered
  // ({ text, kind: 'rendered' }) and the note ({ key, kind: 'note' }: the
  // caller translates it) — `file` for a song alone, and `title`, the plain
  // path for a tooltip.
  const ALBUM_FOLDER_RE = /\{\{\s*(album|year)\s*\}\}/i;

  function scopeTarget({ vpath, base, layout, scope, tags, peerName, fileName, oneAlbum }) {
    const s = JOB_SCOPES.indexOf(scope) !== -1 ? scope : 'song';
    const t = Object.assign({}, tags || {});
    const one = s === 'artist-missing' && oneAlbum && oneAlbum.name ? oneAlbum : null;
    if (one) { t.album = one.name; t.year = one.year || null; }
    const wide = (s === 'artist' || s === 'artist-missing') && !one;
    const target = previewTarget({ vpath, base, layout, tags: t, peerName, fileName });
    const out = Object.assign({}, target, { scope: s, perAlbum: false, crumbs: [], file: s === 'song' ? target.file : null, title: target.library });
    if (!target.valid) { return out; }
    if (wide) {
      const folders = String(layout).split(/[/\\]+/);
      const at = folders.findIndex((f) => ALBUM_FOLDER_RE.test(f));
      if (at !== -1) {
        const head = resolveLayout(folders.slice(0, at).join('/'), { artist: t.artist, genre: t.genre, albumartist: t.albumartist, peer: peerName });
        out.rendered = head.path;
        out.missingVars = head.missingVars;
        out.perAlbum = true;
        out.relDir = [out.base, out.rendered].filter(Boolean).join('/');
        out.relPath = out.relDir;
      }
    }
    out.crumbs = pathCrumbs(out.base).map((text) => ({ text, kind: 'base' }))
      .concat(pathCrumbs(out.rendered).map((text) => ({ text, kind: 'rendered' })));
    if (out.perAlbum) { out.crumbs.push({ key: 'discover.modal.dest.perAlbum', kind: 'note' }); }
    out.title = [out.library, out.base, out.rendered].filter(Boolean).join('/');
    return out;
  }

  // Whether two destinations put files in the same place — the jobs route's
  // own test for a start's "destination_changed" (destination.js
  // sameDestination): the library, the base folder as normalizeBase reads
  // it, the layout character for character. `source` is not compared; null
  // matches only null.
  function sameDestination(a, b) {
    if (!a || !b) { return !a && !b; }
    const x = normalizeBase(a.base);
    const y = normalizeBase(b.base);
    return a.vpath === b.vpath && x.valid && y.valid && x.base === y.base && a.layout === b.layout;
  }

  // Where a finished copy's files are (the "In" line of its states): the
  // folder they share — the copied ones; when nothing was copied and
  // nothing failed or stopped it, the ones it found already in the library
  // (already yours, or a file at the target) — as { vpath, dirs, file },
  // `file` for one song's. null when nothing landed (failed, cancelled
  // before a song, refused, nothing to copy) or the files share no library.
  // { vpath: null } when songs were copied but the result lists none (the
  // counts say so — an older server): the caller renders the destination
  // the job ran with instead.
  function landedPath(result) {
    const r = result && typeof result === 'object' ? result : null;
    if (!r) { return null; }
    const oneFile = (fp) => {
      const c = pathCrumbs(fp);
      return c.length >= 2 ? { vpath: c[0], dirs: c.slice(1, -1), file: c[c.length - 1] } : null;
    };
    if (r.copied && r.copied.filepath) { return oneFile(r.copied.filepath); }
    if (r.skipped === 'owned') { return r.existing && r.existing.filepath ? oneFile(r.existing.filepath) : null; }
    if (r.skipped === 'exists') { return r.filepath ? oneFile(r.filepath) : null; }
    const many = (r.songs && typeof r.songs.total === 'number') || (r.counts && typeof r.counts.total === 'number');
    if (!many) { return null; }
    const n = manyCounts(r);
    const s = r.songs || {};
    let found;
    if (n.copied > 0) {
      found = (Array.isArray(s.copied) ? s.copied : []).map((x) => x && x.filepath);
    } else if (!r.stopped && n.failed === 0 && n.albumsFailed === 0 && n.skipped > 0) {
      found = (Array.isArray(s.skipped) ? s.skipped : []).map((x) => x && x.at);
    } else {
      return null;
    }
    const lists = found.filter((p) => typeof p === 'string').map(pathCrumbs).filter((c) => c.length >= 2);
    if (!lists.length) { return n.copied > 0 ? { vpath: null, dirs: [], file: null } : null; }
    // the folders every file sits under (its file name left out)
    let shared = lists[0].length - 1;
    for (const c of lists) {
      shared = Math.min(shared, c.length - 1);
      for (let i = 0; i < shared; i++) { if (c[i] !== lists[0][i]) { shared = i; break; } }
    }
    return shared >= 1 ? { vpath: lists[0][0], dirs: lists[0].slice(1, shared), file: null } : null;
  }

  // ── a job as a row ─────────────────────────────────────────────────────
  // The copy plug-in's rows read differently from a download's ("copying" /
  // "in your collection" against "downloading" / "done · saved to …");
  // everything else is the job's state and the shape of its result. Both
  // land in the collection destination, so nothing waits to be kept and
  // nothing expires: a finished row is a library song.
  const COPY_PLUGIN = 'federation-copy';
  const LIVE_STATES = ['queued', 'running'];

  function isLive(job) { return !!job && LIVE_STATES.indexOf(job.state) !== -1; }

  function fmtBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) { return ''; }
    if (b < 1024) { return `${b} B`; }
    if (b < 1024 * 1024) { return `${Math.round(b / 1024)} KB`; }
    const mb = b / (1024 * 1024);
    if (mb < 1024) { return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`; }
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  // What one plug-in's row shows for the job the caller last ran with it
  // (null = never asked). `actions` are names the window maps to buttons:
  //   start · cancel · retry · play · queue
  function jobRowState(job, { plugin } = {}) {
    const copy = (plugin || (job && job.plugin)) === COPY_PLUGIN;
    const row = {
      state: 'idle', tag: null, tagCls: '', icon: copy ? 'folder' : 'download', iconCls: '', muted: false,
      progress: null, sub: null, actions: ['start'], filepath: null, live: false,
    };
    if (!job) { return row; }
    row.live = isLive(job);

    if (job.state === 'queued') {
      return { ...row, state: 'queued', tag: 'discover.job.queued', icon: 'clock', sub: { key: 'discover.job.queuedSub' }, actions: ['cancel'] };
    }
    if (job.state === 'running') {
      const stopping = job.cancelRequested === true;
      const pct = Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
      const text = job.statusText ? String(job.statusText) : '';
      return {
        ...row, state: 'running', tag: stopping ? 'discover.job.stopping' : (copy ? 'discover.job.copying' : 'discover.job.downloading'),
        tagCls: 'src', iconCls: 'on',
        progress: pct === null ? 'indeterminate' : pct,
        // A status line that already carries a percentage ("43% of …") says enough.
        sub: text ? { text: (pct === null || text.indexOf('%') !== -1) ? text : `${text} · ${pct}%` } : (pct === null ? { key: 'discover.job.starting' } : { text: `${pct}%` }),
        actions: stopping ? [] : ['cancel'],
      };
    }
    if (job.state === 'failed') {
      return { ...row, state: 'failed', tag: 'discover.job.failed', tagCls: 'err', icon: 'warn', iconCls: 'err',
        sub: job.error ? { text: String(job.error) } : { key: 'discover.job.failedSub' }, actions: ['retry'] };
    }
    // An album's or an artist's copy: every song accounted for (songs.total,
    // or the whole numbers in counts).
    const res = job.result;
    const many = (res && ((res.songs && typeof res.songs.total === 'number') || (res.counts && typeof res.counts.total === 'number'))) ? res : null;
    if (job.state === 'cancelled') {
      if (many) {
        return { ...row, state: 'cancelled', tag: 'discover.job.cancelled', icon: 'close', muted: true,
          sub: { parts: [{ key: 'discover.job.cancelledMany' }, ...manyParts(many)] }, actions: ['start'] };
      }
      return { ...row, state: 'cancelled', tag: 'discover.job.cancelled', icon: 'close', muted: true,
        sub: { key: copy ? 'discover.job.cancelledCopySub' : 'discover.job.cancelledSub' }, actions: ['start'] };
    }
    if (job.state !== 'done') { return row; }

    // A many-song job ends 'done' however it went — "done" is not "kept".
    // What it says comes from result.stopped and result.counts:
    //   stopped (quota · busy · peer · refused)  stopped, with the reason
    //   copied > 0                               in your collection
    //   nothing copied, something failed         failed (Retry)
    //   nothing copied, all already here         already yours
    //   nothing at all                           nothing to copy (an artist
    //                                            who only appears on the
    //                                            peer's albums says so)
    if (many) {
      const peer = (many.peer && many.peer.name) || '';
      const n = manyCounts(many);
      const why = STOPPED_WHY[many.stopped];
      // The peer's transfer limit or the peer going away ended it: what
      // landed is in, and starting again takes only the gaps. A peer that
      // refuses copies refuses them again — no Retry.
      if (why) {
        return { ...row, state: 'stopped', tag: 'discover.job.stopped', tagCls: 'err', icon: 'warn', iconCls: 'err',
          sub: { parts: [{ key: why, params: { peer } }, ...manyParts(many)] },
          actions: many.stopped === 'refused' ? [] : ['retry'] };
      }
      // Startable again: the copy is idempotent, so a second run takes only
      // what the library lacks by then (a song removed, one the peer added).
      if (n.copied > 0) {
        return { ...row, state: 'copiedMany', tag: 'discover.job.inCollection', tagCls: 'ok', icon: 'check', iconCls: 'ok',
          sub: { parts: manyParts(many) }, actions: ['start'] };
      }
      if (n.failed > 0 || n.albumsFailed > 0) {
        return { ...row, state: 'failed', tag: 'discover.job.failed', tagCls: 'err', icon: 'warn', iconCls: 'err',
          sub: { parts: manyParts(many) }, actions: ['retry'] };
      }
      if (n.skipped > 0 || n.albumsOwned > 0) {
        return { ...row, state: 'owned', tag: 'discover.job.owned', tagCls: 'ok', icon: 'check', iconCls: 'ok',
          sub: { parts: manyParts(many) }, actions: ['start'] };
      }
      const parts = n.albumsAppearance > 0
        ? [{ key: 'discover.job.onlyAppearances', params: { count: n.albumsAppearance } }]
        : [{ key: 'discover.job.nothingToCopy' }, ...manyParts(many)];
      return { ...row, state: 'nothing', tag: 'discover.job.nothing', icon: 'folder', muted: true,
        sub: { parts }, actions: ['start'] };
    }

    const r = job.result || {};
    // A download that landed in the collection.
    const at = (r.downloaded && r.downloaded.filepath) || null;
    if (at) {
      return { ...row, state: 'downloaded', tag: 'discover.job.done', tagCls: 'ok', icon: 'check', iconCls: 'ok',
        sub: { key: 'discover.job.savedTo', params: { path: pathCrumbs(at).join(' / ') } }, actions: ['play', 'queue'], filepath: at };
    }
    if (r.copied && r.copied.filepath) {
      return { ...row, state: 'copied', tag: 'discover.job.inCollection', tagCls: 'ok', icon: 'check', iconCls: 'ok',
        sub: { text: pathCrumbs(r.copied.filepath).join(' / ') }, actions: ['play', 'queue'], filepath: r.copied.filepath };
    }
    if (r.skipped === 'owned') {
      const at = r.existing && r.existing.filepath;
      return { ...row, state: 'owned', tag: 'discover.job.owned', tagCls: 'ok', icon: 'check', iconCls: 'ok',
        sub: at ? { text: pathCrumbs(at).join(' / ') } : { key: 'discover.job.ownedSub' },
        actions: at ? ['play', 'queue'] : [], filepath: at || null };
    }
    if (r.skipped === 'exists') {
      return { ...row, state: 'exists', tag: 'discover.job.skipped', icon: 'warn',
        sub: { key: 'discover.job.existsSub', params: { path: pathCrumbs(r.filepath).join(' / ') } }, actions: ['retry'] };
    }
    // A song the peer would not hand over (it refuses this server's key):
    // stopped as a many-song copy is, with no Retry — it would refuse again.
    if (r.stopped === 'refused') {
      return { ...row, state: 'stopped', tag: 'discover.job.stopped', tagCls: 'err', icon: 'warn', iconCls: 'err',
        sub: { key: STOPPED_WHY.refused, params: { peer: (r.peer && r.peer.name) || '' } }, actions: [] };
    }
    return { ...row, state: 'done', tag: 'discover.job.done', tagCls: 'ok', icon: 'check', iconCls: 'ok', sub: null, actions: [] };
  }

  // Why a many-song job stopped early, as its sub-line's first part.
  const STOPPED_WHY = { quota: 'discover.job.stoppedQuota', busy: 'discover.job.stoppedBusy', peer: 'discover.job.stoppedPeer', refused: 'discover.job.stoppedRefused' };

  // A many-song result's numbers. Songs from result.counts — the whole
  // numbers: its per-song lists stop at 500 entries (federation-copy's
  // RESULT_LIST_CAP) — else the lists (an older server sends no counts).
  // Albums from an artist job's walk: copied from (no error), whose
  // listing failed, and left out — already here ('owned', artist-missing)
  // or only a guest spot ('appearance').
  function manyCounts(many) {
    const s = many.songs || {};
    const c = many.counts && typeof many.counts === 'object' ? many.counts : null;
    const num = (k) => {
      const v = c ? Number(c[k]) : NaN;
      return Number.isFinite(v) && v >= 0 ? v : (Array.isArray(s[k]) ? s[k].length : 0);
    };
    const albums = (Array.isArray(many.albums) ? many.albums : []).filter((a) => a && typeof a === 'object');
    const left = (Array.isArray(many.skippedAlbums) ? many.skippedAlbums : []).filter((a) => a && typeof a === 'object');
    return {
      copied: num('copied'), skipped: num('skipped'), failed: num('failed'),
      albums: albums.filter((a) => !a.error).length,
      albumsFailed: albums.filter((a) => a.error).length,
      albumsLeftOut: left.length,
      albumsOwned: left.filter((a) => a.why === 'owned').length,
      albumsAppearance: left.filter((a) => a.why === 'appearance').length,
    };
  }

  // The counts of a many-song result as the parts of a sub-line (the
  // caller translates each and joins them): the albums an artist job
  // walked, songs copied, already yours, failed, albums whose listing
  // failed, albums left out — zeroes left out (empty when nothing happened
  // at all: the caller says why). The Keep card puts its states in its own
  // words from these and manyCounts (vp.js dmKeepView).
  function manyParts(many) {
    const n = manyCounts(many);
    const parts = [];
    const add = (key, count) => { if (count) { parts.push({ key, params: { count } }); } };
    add('discover.job.albumsCount', n.albums);
    add('discover.job.copiedCount', n.copied);
    add('discover.job.ownedCount', n.skipped);
    add('discover.job.failedCount', n.failed);
    add('discover.job.albumsFailed', n.albumsFailed);
    add('discover.job.albumsLeftOut', n.albumsLeftOut);
    return parts;
  }

  // ── scopes ───────────────────────────────────────────────────────────────
  // What a job acts on (the server's JOB_SCOPES): the song, its album, its
  // artist's albums, or only the ones the library lacks. The window keeps
  // one job per plug-in AND scope, under a slot: the plug-in's name for a
  // song job (as it always was), "<plugin>@<scope>" for the others.
  const JOB_SCOPES = ['song', 'album', 'artist', 'artist-missing'];

  function jobScope(job) {
    return (job && job.params && job.params.scope) || 'song';
  }

  function jobSlot(plugin, scope) {
    return (!scope || scope === 'song') ? plugin : plugin + '@' + scope;
  }

  // A lookup answer (the newest job per plug-in and scope) by slot.
  function jobsBySlot(jobs) {
    const out = {};
    for (const job of (Array.isArray(jobs) ? jobs : [])) {
      if (!job || !job.plugin) { continue; }
      const slot = jobSlot(job.plugin, jobScope(job));
      if (!out[slot]) { out[slot] = job; }
    }
    return out;
  }

  // The strip's word for what a job acts on beyond a song: an i18n key, or null.
  function jobKind(job) {
    const scope = jobScope(job);
    if (scope === 'album') { return 'discover.tray.kindAlbum'; }
    if (scope === 'artist') { return 'discover.tray.kindArtist'; }
    if (scope === 'artist-missing') { return 'discover.tray.kindMissing'; }
    return null;
  }

  // Index a lookup answer (newest job per plug-in) by plug-in name.
  // A lookup answer holds the newest job per plug-in AND scope; a row asks
  // for its own scope — the song rows by default (a job with no scope in
  // its params), the album and artist rows for theirs.
  function jobsByPlugin(jobs, scope = 'song') {
    const out = {};
    for (const job of (Array.isArray(jobs) ? jobs : [])) {
      if (!job || !job.plugin || out[job.plugin]) { continue; }
      const jobScope = (job.params && job.params.scope) || 'song';
      if (jobScope === scope) { out[job.plugin] = job; }
    }
    return out;
  }

  // ── the downloads strip ────────────────────────────────────────────────
  // It holds what still wants the user: live jobs and failures. A finished
  // download or copy is settled — it is a library song, listed by the
  // Downloads view — and a cancelled job is over; both leave the strip by
  // themselves ("Clear finished" drops their rows on the server).
  function trayRank(job) {
    if (job.state === 'running') { return 0; }
    if (job.state === 'queued') { return 1; }
    return 2;
  }

  function inTray(job) {
    return !!job && (isLive(job) || job.state === 'failed');
  }

  function trayRows(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    // A failure the user already retried is old news: a newer job for the
    // same plug-in and recommendation (whatever became of it) supersedes it.
    const newest = {};
    for (const job of list) {
      const k = job ? `${job.plugin}|${job.key}` : '';
      if (job && (newest[k] === undefined || job.id > newest[k])) { newest[k] = job.id; }
    }
    const superseded = (job) => job.state === 'failed' && job.key != null && newest[`${job.plugin}|${job.key}`] > job.id;
    return list.filter((job) => inTray(job) && !superseded(job)).sort((a, b) => {
      const byRank = trayRank(a) - trayRank(b);
      if (byRank !== 0) { return byRank; }
      return (b.createdAt || 0) - (a.createdAt || 0) || (b.id || 0) - (a.id || 0);
    });
  }

  // "2 running · 1 failed" as counted parts, in that order, zeroes left
  // out. `live` tells the poller whether to keep its short interval.
  function traySummary(jobs) {
    const rows = trayRows(jobs);
    const count = { running: 0, failed: 0 };
    for (const job of rows) {
      if (isLive(job)) { count.running += 1; } else { count.failed += 1; }
    }
    const parts = [];
    if (count.running) { parts.push({ key: 'discover.tray.running', count: count.running }); }
    if (count.failed) { parts.push({ key: 'discover.tray.failed', count: count.failed }); }
    return { total: rows.length, live: count.running > 0, clearable: count.failed > 0, ...count, parts };
  }

  // A job's one-line title in the strip: "Title — Artist" for a song,
  // "Album — Artist" for an album — the album's own credit when the
  // recommendation carries one (a compilation's "Various Artists": the
  // copy took it whole, every track artist on it), else the track artist —
  // the artist's name for the artist scopes.
  function jobTitle(job) {
    const rec = (job && job.recommendation) || {};
    const scope = jobScope(job);
    if (scope === 'album') {
      const credit = typeof rec.albumArtist === 'string' && rec.albumArtist.trim() ? rec.albumArtist : rec.artist;
      return [rec.album, credit].filter(Boolean).join(' — ') || '';
    }
    if (scope === 'artist' || scope === 'artist-missing') { return rec.artist || ''; }
    return [rec.title, rec.artist].filter(Boolean).join(' — ') || '';
  }

  // What changed between two polls, for the toasts: only a job this client
  // SAW live and now sees finished is news (a page load is not).
  function finishedSince(before, after) {
    const was = {};
    for (const job of (Array.isArray(before) ? before : [])) { if (isLive(job)) { was[job.id] = true; } }
    return (Array.isArray(after) ? after : []).filter((job) => was[job.id] && !isLive(job));
  }

  // ── a download as a row ────────────────────────────────────────────────
  // A record from GET /api/v1/discovery/downloads (the Downloads view and
  // the admin's Downloads tab): what a plug-in brought in, where it is, and
  // whether the file is still there — `present` follows the library row, so
  // a file a scan lost, or one deleted by hand, shows as missing while its
  // record stays; a removed record is history.
  //   present  → play · queue · show · remove
  //   missing  → remove (settles the record)
  //   removed  → nothing
  function downloadRow(record) {
    const d = record || {};
    const crumbs = pathCrumbs(d.filepath);
    const removed = d.removedAt != null;
    const present = !removed && d.present === true;
    return {
      id: d.id, state: removed ? 'removed' : (present ? 'present' : 'missing'),
      title: d.title || crumbs[crumbs.length - 1] || '', artist: d.artist || '', album: d.album || '',
      plugin: d.plugin || '', filepath: d.filepath || '', crumbs, present, removed,
      bytes: Number(d.bytes) || 0, size: fmtBytes(d.bytes), at: d.downloadedAt == null ? null : Number(d.downloadedAt),
      removedAt: d.removedAt == null ? null : Number(d.removedAt), username: d.username || null,
      actions: removed ? [] : (present ? ['play', 'queue', 'show', 'remove'] : ['remove']),
    };
  }

  // "12 songs · 118 MB": the live records of a list (removed ones are history).
  function downloadsTotals(records) {
    const live = (Array.isArray(records) ? records : []).filter((d) => d && d.removedAt == null);
    return { count: live.length, bytes: live.reduce((sum, d) => sum + (Number(d.bytes) || 0), 0) };
  }

  // ── the queue after a removal ──────────────────────────────────────────
  // Remove deletes a file; queue entries that point at it would 404 on
  // their next play. Their indexes, highest first, so the caller can drop
  // them one by one; peer tracks are never ours.
  function queueIndexesFor(playlist, filepath) {
    const out = [];
    (Array.isArray(playlist) ? playlist : []).forEach((song, i) => {
      if (song && !song.federation && song.rawFilePath === filepath) { out.push(i); }
    });
    return out.reverse();
  }

  // ── the lookup card ────────────────────────────────────────────────────
  // What "Get it" would fetch, before anything is fetched: an acquire
  // plug-in's lookup answer (candidates best first, the score bar, or
  // `owned`) as the row shows it. `lookup` is the window's state for the
  // plug-in (vp.js dmLookup):
  //   { status: 'idle' | 'loading' | 'ready' | 'none' | 'owned' | 'error',
  //     query, minScore, candidates, chosen (a url), owned, error }
  const LOOKUP_CAPABILITY = 'lookup';

  function hasLookup(plugin) {
    return !!plugin && Array.isArray(plugin.capabilities) && plugin.capabilities.indexOf(LOOKUP_CAPABILITY) !== -1;
  }

  // 253 → "4:13"; 3725 → "1:02:05"; '' for an unknown length.
  function fmtSeconds(sec) {
    if (sec == null || sec === '') { return ''; }
    const s = Math.round(Number(sec));
    if (!Number.isFinite(s) || s < 0) { return ''; }
    const two = (n) => (n < 10 ? '0' + n : String(n));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
  }

  function lookupItem(c, minScore) {
    const score = Number(c.score) || 0;
    return {
      url: c.url, title: c.title || '', channel: c.channel || '', length: fmtSeconds(c.durationSec),
      thumbnail: c.thumbnail || null, topic: c.topic === true,
      scorePct: Math.round(score * 100), loose: score < (Number(minScore) || 0),
    };
  }

  // The row's view of a lookup: the candidate shown (the chosen one, else
  // the best) and the others to pick from.
  function lookupCard(lookup) {
    const l = lookup || { status: 'idle' };
    const candidates = Array.isArray(l.candidates) ? l.candidates : [];
    const shown = candidates.find((c) => c.url === l.chosen) || candidates[0] || null;
    const state = l.status === 'ready' && !shown ? 'none' : (l.status || 'idle');
    return {
      state,
      query: l.query || '',
      card: shown ? lookupItem(shown, l.minScore) : null,
      others: shown ? candidates.filter((c) => c !== shown).map((c) => lookupItem(c, l.minScore)) : [],
      owned: l.owned || null,
      error: l.error || '',
    };
  }

  return {
    LAYOUT_VARS, DEFAULT_LAYOUT, SAMPLE_TAGS, SAMPLE_PEER, COPY_PLUGIN, LOOKUP_CAPABILITY,
    sanitizeSegment, resolveLayout, validateLayout, validateResolvedPath, normalizeBase, safeFileName, previewTarget, pathCrumbs,
    scopeTarget, sameDestination, landedPath,
    isLive, fmtBytes, jobRowState, manyCounts, manyParts, jobsByPlugin,
    JOB_SCOPES, jobScope, jobSlot, jobsBySlot, jobKind,
    inTray, trayRows, traySummary, jobTitle, finishedSince,
    downloadRow, downloadsTotals, queueIndexesFor,
    hasLookup, fmtSeconds, lookupCard,
  };
}));
