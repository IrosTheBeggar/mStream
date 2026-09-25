// The Discover job rows' pure half: what a plug-in job looks like as a row
// ("Get it", "Add to your collection", the downloads strip), where a
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
  const DEFAULT_LAYOUT = '{{ARTIST}}/{{ALBUM}}';
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
    if (job.state === 'cancelled') {
      return { ...row, state: 'cancelled', tag: 'discover.job.cancelled', icon: 'close', muted: true,
        sub: { key: copy ? 'discover.job.cancelledCopySub' : 'discover.job.cancelledSub' }, actions: ['start'] };
    }
    if (job.state !== 'done') { return row; }

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
    return { ...row, state: 'done', tag: 'discover.job.done', tagCls: 'ok', icon: 'check', iconCls: 'ok', sub: null, actions: [] };
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

  // A job's one-line title in the strip: "Title — Artist".
  function jobTitle(job) {
    const rec = (job && job.recommendation) || {};
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
    isLive, fmtBytes, jobRowState, jobsByPlugin,
    inTray, trayRows, traySummary, jobTitle, finishedSince,
    downloadRow, downloadsTotals, queueIndexesFor,
    hasLookup, fmtSeconds, lookupCard,
  };
}));
