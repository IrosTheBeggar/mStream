// Add from YouTube's job tracker: the adds this browser started on its
// server, kept across reloads and shared by every tab. It owns an add from
// the press — the folder it needs first, then the POST, sent once and never
// retried — and follows each job in GET /api/v1/ytdl/downloads until it
// settles: the toast in the tab that pressed Add, the sidenav pill's count,
// "Already adding to this folder", and the Added list (the server's record
// of what came in, merged with this browser's own finished jobs). Closing
// the panel or the window never cancels an add.
//
// A port of the phone's lib/singletons/ytdl_hub.dart (claim, settle,
// retention, the summary) for a browser, where it differs on purpose:
// - the server answers the POST with the job's id, so a job follows its
//   entry by id; only a POST with no answer (fetch's TypeError — a browser
//   can't tell refused from dropped —, our own 30 s bound, a proxy's 504)
//   is matched by link and folder, for 2 minutes, as 'startUnsure';
// - entries keep their error and reason for 24 hours, so a failure is read,
//   never guessed from the folder;
// - one poller for every tab: a leader beat in localStorage that a visible
//   tab renews and another takes over when it goes stale or hidden; the
//   others follow the leader's writes through the `storage` event. Nothing
//   polls while every tab is hidden.
// - an add the server refused (409 included) shows where it was pressed,
//   so it leaves no row unless the caller asks for one (`inline: false`).
//
// No DOM, no Vue, no globals read at load: storage, the clock, timers, the
// request, the tab's id and its visibility are injected (each has a browser
// default), so test/unit/webapp-ytdl-jobs.test.mjs drives two tabs on node
// over one fake storage. Same UMD shape as alpha/ytdl-core.js, whose rules
// (the request body, the failure tables) it uses.
//
// Text never leaves here as English: a row's status is a label ({ key,
// params }); the keys this module returns are in KEYS.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./ytdl-core.js')); }
  else { root.YTDLJOBS = factory(root.YTDLCORE); }
}(typeof self !== 'undefined' ? self : this, function (ytdlCore) {
  // index.html loads ytdl-core.js first; read late as well, like
  // ytdl-core.js reads DISCOVERJOBS.
  function core() {
    if (ytdlCore) { return ytdlCore; }
    if (typeof YTDLCORE !== 'undefined') { return YTDLCORE; }
    throw new Error('ytdl-jobs.js needs alpha/ytdl-core.js (window.YTDLCORE)');
  }

  // Every 3 s while a job is open and the leader tab is visible; a failed
  // read doubles it, up to a minute (the Discover job poll's backoff).
  const POLL_MS = 3000;
  const BACKOFF_CAP_MS = 60 * 1000;
  // The leader renews its beat this often; a beat older than the stale
  // bound is a tab that went away, and a visible tab takes over.
  const BEAT_MS = 3000;
  const LEADER_STALE_MS = 10 * 1000;
  // A POST that got no answer is looked for this long, by link and folder,
  // among entries the server started no earlier than the slack before the
  // press (the server's clock against this browser's: the slack covers a
  // little drift, not a wrong clock).
  const CLAIM_WINDOW_MS = 2 * 60 * 1000;
  const CLAIM_SLACK_MS = 5000;
  // Bounds: the POST (the server's name check alone may take 15 s), the
  // folder, and each read.
  const POST_TIMEOUT_MS = 30 * 1000;
  const MKDIR_TIMEOUT_MS = 15 * 1000;
  const READ_TIMEOUT_MS = 10 * 1000;
  // A job still 'starting' this long after the press belongs to a tab that
  // closed mid-add (its own bounds end well before): it is looked for.
  const STARTING_STALE_MS = 60 * 1000;
  // The server keeps a settled entry this long: an open job older than that
  // with no entry and no record may have finished unseen.
  const SERVER_KEEP_MS = 24 * 60 * 60 * 1000;
  // What this browser keeps per server and account: the last 20 jobs
  // (open ones always), Needs a look rows for 7 days, "Added n" for an hour.
  const KEEP_JOBS = 20;
  const KEEP_FAILED_MS = 7 * 24 * 60 * 60 * 1000;
  const ADDED_NEWS_MS = 60 * 60 * 1000;
  // A toast its tab only got to after this long (it was closed or reloading
  // when the job settled) is old news and is dropped.
  const TOAST_STALE_MS = 60 * 1000;
  // The download record is read 20 at a time, at most 5 pages for one job.
  const RECORD_PAGE = 20;
  const RECORD_PAGES = 5;
  // Server ids of dismissed and replaced rows: never claimed again.
  const RETIRED_CAP = 100;

  // starting        pressed: the folder or the POST is out
  // startUnsure     the POST got no answer: looked for 2 min
  // adding          the server has it (its id in `serverId`)
  // added           in the library
  // failed          the server's job ended in error (`failure`, `reason`, `error`)
  // startFailed     refused before it started, kept as a row (`failure`)
  // notSureStarted  2 min and no entry: Check again
  // notSureFinished open past the server's 24 h with no entry and no record
  // notFound        its entry is gone (a server restart) and no record: Add again
  const STATES = Object.freeze(['starting', 'startUnsure', 'adding', 'added', 'failed', 'startFailed', 'notSureStarted', 'notSureFinished', 'notFound']);
  const OPEN = Object.freeze(['starting', 'startUnsure', 'adding']);
  const NEEDS_LOOK = Object.freeze(['failed', 'startFailed', 'notSureStarted', 'notSureFinished', 'notFound']);
  // What the pill counts as failed: a "not sure" row is a guess, not a failure.
  const FAILURES = Object.freeze(['failed', 'startFailed']);
  // What toasts: the not-sure states say nothing, their rows ask for a look.
  const TOASTED = Object.freeze(['added', 'failed', 'startFailed']);

  const ADD_PATH = 'api/v1/ytdl/';
  const LIST_PATH = 'api/v1/ytdl/downloads';
  const MKDIR_PATH = 'api/v1/file-explorer/mkdir';
  const RECORDS_PATH = 'api/v1/discovery/downloads';
  const TAB_KEY = 'mstream-ytdl-tab';
  const SEP = ' › ';

  const KEYS = Object.freeze([
    'discover.job.starting', 'ytdl.row.startUnsure', 'ytdl.row.adding', 'ytdl.row.waiting',
    'ytdl.row.notSureStarted', 'ytdl.row.notSureFinished', 'ytdl.row.notFound',
    'ytdl.toast.added', 'ytdl.toast.couldntAdd',
  ]);

  function label(key, params) { return params ? { key, params } : { key }; }
  function str(v) { return v == null ? '' : String(v); }
  function strOrNull(v) { return typeof v === 'string' && v !== '' ? v : null; }
  function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function intOrNull(v) { return Number.isInteger(v) ? v : null; }
  function isOpen(j) { return OPEN.indexOf(j.state) !== -1; }
  function newestFirst(a, b) { return b.createdAt - a.createdAt; }
  // How long ago `at` was, either way: a wall clock set back must not stall
  // a bound for as long as it went back (a lost POST looked for for an
  // hour, another tab's cut-off add "Starting…" for an hour).
  function since(t, at) { return Math.abs(t - at); }

  // '/Music/Daft Punk/' and 'Music/Daft Punk' are one folder: compared
  // without the slashes at either end.
  function bare(p) { return str(p).replace(/^\/+|\/+$/g, ''); }
  function slashed(p) { const b = bare(p); return b === '' ? '/' : `/${b}/`; }
  function crumbsOf(p) { return str(p).split('/').filter(Boolean); }
  function folderOf(filepath) { const c = crumbsOf(filepath); c.pop(); return c.join('/'); }
  function nameOf(filepath) { const c = crumbsOf(filepath); return c.length ? c[c.length - 1] : ''; }
  function stemOf(name) { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; }
  function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
  }
  function isolate(s) { return `⁨${s}⁩`; }

  // A v4 UUID. crypto.randomUUID needs a secure context, and mStream on a
  // LAN is plain http more often than not.
  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') {
      try { return c.randomUUID(); } catch (_) { /* fall through */ }
    }
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') { c.getRandomValues(b); }
    else { for (let i = 0; i < 16; i++) { b[i] = Math.floor(Math.random() * 256); } }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ── keys and ids ───────────────────────────────────────────────────────

  // One list per server and account: one browser can sign in as two
  // people, and a tab can browse another server.
  function storageKeys(scope) {
    const s = scope || {};
    const id = `${encodeURIComponent(str(s.origin))}|${encodeURIComponent(str(s.user))}`;
    return { jobs: `mstream-ytdl-jobs:${id}`, leader: `mstream-ytdl-poll:${id}` };
  }

  // This tab's id, kept in sessionStorage so a reload is the same tab (its
  // add that was out reads as its own). A duplicated tab copies it; the
  // leader beat uses a per-page id, so only a toast can come twice then.
  function tabIdOf(storage) {
    let s = storage;
    if (s === undefined) {
      try { s = typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (_) { s = null; }
    }
    try {
      let id = s ? s.getItem(TAB_KEY) : null;
      if (!id) { id = uuid(); if (s) { s.setItem(TAB_KEY, id); } }
      return id;
    } catch (_) {
      return uuid();
    }
  }

  // `request(method, path, body, { signal })` → the parsed answer, throwing
  // as alpha/api.js req() does: `{ status, body }` for an answer that
  // isn't 2xx, fetch's own TypeError / AbortError without one, a
  // SyntaxError for a 2xx that won't parse. `host` and `token` may be
  // functions (read per call).
  function fetchRequest(opts) {
    const o = opts || {};
    const val = (v) => (typeof v === 'function' ? v() : v);
    const doFetch = typeof o.fetch === 'function' ? o.fetch : (...args) => fetch(...args);
    return async function request(method, path, body, ro) {
      const res = await doFetch(str(val(o.host)) + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-access-token': str(val(o.token)) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ro && ro.signal,
      });
      if (res.ok !== true) {
        const err = new Error(`${method} ${path} failed: ${res.status}`);
        err.status = res.status;
        err.body = await res.json().catch(() => null);
        throw err;
      }
      return await res.json();
    };
  }

  // ── what is stored ─────────────────────────────────────────────────────

  function failureIn(f) {
    if (!f || typeof f !== 'object' || typeof f.problem !== 'string') { return null; }
    return {
      problem: f.problem, detail: f.detail == null ? null : f.detail, reason: strOrNull(f.reason),
      text: typeof f.text === 'string' ? f.text : null, phase: strOrNull(f.phase) || 'start',
    };
  }

  function tagsIn(m) {
    const out = {};
    if (m && typeof m === 'object') {
      for (const k of ['title', 'artist', 'album', 'year']) { if (typeof m[k] === 'string' && m[k] !== '') { out[k] = m[k]; } }
    }
    return out;
  }

  // A stored job, or null for one nothing could be matched or shown for (no
  // id, link or folder). A state this build doesn't know (a newer one wrote
  // it) reads as a "not sure" state rather than vanishing or polling
  // forever: not sure it finished once the server had it, else started.
  function readJob(raw) {
    const r = raw;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id === '' || typeof r.url !== 'string' || typeof r.directory !== 'string') { return null; }
    const serverId = strOrNull(r.serverId);
    return {
      id: r.id, serverId, claim: r.claim === 'post' || r.claim === 'match' ? r.claim : null, tab: strOrNull(r.tab),
      url: r.url, directory: r.directory, codec: strOrNull(r.codec) || 'mp3', metadata: tagsIn(r.metadata),
      title: str(r.title), crumbs: Array.isArray(r.crumbs) ? r.crumbs.filter((c) => typeof c === 'string') : [],
      cover: strOrNull(r.cover), mkdir: strOrNull(r.mkdir), mkdirFolder: strOrNull(r.mkdirFolder),
      state: STATES.indexOf(r.state) !== -1 ? r.state : (serverId ? 'notSureFinished' : 'notSureStarted'),
      createdAt: numOrNull(r.createdAt) || 0, sentAt: numOrNull(r.sentAt), knownAt: serverId ? numOrNull(r.knownAt) : null,
      serverStart: numOrNull(r.serverStart), endedAt: numOrNull(r.endedAt),
      fileName: strOrNull(r.fileName), filePath: strOrNull(r.filePath), downloadId: intOrNull(r.downloadId),
      bytes: numOrNull(r.bytes), trackId: intOrNull(r.trackId),
      failure: failureIn(r.failure), error: strOrNull(r.error), reason: strOrNull(r.reason),
      hidden: r.hidden === true, seen: r.seen === true, toast: r.toast === 'pending' || r.toast === 'done' ? r.toast : null,
    };
  }

  // The stored list, newest first; anything unreadable is an empty list.
  function parseStore(raw) {
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    const jobs = [];
    const ids = new Set();
    if (data && Array.isArray(data.jobs)) {
      for (const r of data.jobs) {
        const j = readJob(r);
        if (j && !ids.has(j.id)) { ids.add(j.id); jobs.push(j); }
      }
    }
    jobs.sort(newestFirst);
    const retired = data && Array.isArray(data.retired) ? data.retired.filter((x) => typeof x === 'string') : [];
    return { jobs, retired };
  }

  // The leader beat: { inst (the page that polls), at (its last beat),
  // visible, fails (reads failed in a row), due (the next poll), waiting
  // (the last read had no connection) }.
  function parseLeader(raw) {
    let r = null;
    try { r = raw ? JSON.parse(raw) : null; } catch (_) { r = null; }
    if (!r || typeof r !== 'object' || typeof r.inst !== 'string' || numOrNull(r.at) == null) { return null; }
    return {
      inst: r.inst, at: r.at, visible: r.visible === true, fails: Number.isInteger(r.fails) && r.fails > 0 ? r.fails : 0,
      due: numOrNull(r.due) == null ? r.at : r.due, waiting: r.waiting === true,
    };
  }

  // A copy for the caller: changing it changes nothing here.
  function snapshot(j) {
    if (!j) { return null; }
    return Object.freeze(Object.assign({}, j, {
      metadata: Object.freeze(Object.assign({}, j.metadata)), crumbs: Object.freeze(j.crumbs.slice()),
      failure: j.failure ? Object.freeze(Object.assign({}, j.failure)) : null,
    }));
  }

  // A job entry the server sent (GET /ytdl/downloads), or not.
  function isEntry(e) {
    return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.url === 'string' && typeof e.directory === 'string';
  }

  // A download record (GET /discovery/downloads), or not.
  function isRecord(r) {
    return !!r && typeof r === 'object' && Number.isInteger(r.id) && typeof r.filepath === 'string';
  }

  function delayFor(fails) { return Math.min(BACKOFF_CAP_MS, POLL_MS * Math.pow(2, Math.min(fails, 6))); }

  // A read with no answer at all — offline, the server down, our bound —
  // as opposed to one the server refused: the rows read "Waiting for
  // connection".
  function noAnswer(err) {
    const e = err || {};
    return e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError' || e.timedOut === true || e.status === 0;
  }

  // ── rows and toasts ────────────────────────────────────────────────────

  // The folder a job's song sits in, library first: where it landed when
  // known, else the crumbs the add showed, else its directory.
  function folderCrumbs(j) {
    if (j.filePath) { return crumbsOf(folderOf(j.filePath)); }
    if (j.crumbs && j.crumbs.length) { return j.crumbs.slice(); }
    return crumbsOf(j.directory);
  }

  // A row in Adding or Needs a look, from a job:
  //   { section: 'adding' | 'needsLook' | 'added', tone: 'busy' | 'unsure' |
  //     'error' | 'ok', status: label | null, actions: [names] }
  // Actions, Dismiss last: 'hide' (an adding row's ⋯ → Hide from this
  // list), 'checkAgain', 'addAgain' (→ retry), and a failure's own from
  // ytdl-core failureActions ('retry', 'changeFormat', 'chooseFolder',
  // 'topOfLibrary', 'dismiss'). ctx: { now, waiting (the last read found no
  // connection), server (its name), formats (the menu's options) }.
  function jobRow(job, ctx) {
    const c = ctx || {};
    const j = job || {};
    const now = numOrNull(c.now) == null ? Date.now() : c.now;
    switch (j.state) {
      case 'starting':
      case 'startUnsure':
      case 'adding': {
        let status;
        if (c.waiting) { status = label('ytdl.row.waiting'); }
        else if (j.state === 'starting') { status = label('discover.job.starting'); }
        else if (j.state === 'startUnsure') { status = label('ytdl.row.startUnsure'); }
        else {
          const minutes = Math.max(1, Math.floor((now - (j.createdAt || now)) / 60000));
          status = label('ytdl.row.adding', { count: minutes, format: core().formatName(j.codec) });
        }
        // A row still starting has nothing on the server to hide yet.
        return { section: 'adding', tone: 'busy', status, actions: j.state === 'adding' ? ['hide'] : [] };
      }
      case 'notSureStarted': return { section: 'needsLook', tone: 'unsure', status: label('ytdl.row.notSureStarted'), actions: ['checkAgain', 'dismiss'] };
      case 'notSureFinished': return { section: 'needsLook', tone: 'unsure', status: label('ytdl.row.notSureFinished'), actions: ['checkAgain', 'dismiss'] };
      case 'notFound': return { section: 'needsLook', tone: 'unsure', status: label('ytdl.row.notFound'), actions: ['addAgain', 'dismiss'] };
      case 'failed':
      case 'startFailed': {
        const f = j.failure || { problem: 'unknown', detail: null, reason: null, text: null, phase: j.state === 'failed' ? 'download' : 'start' };
        return {
          section: 'needsLook', tone: 'error',
          status: core().failureLabel(f, { surface: 'row', server: c.server, codec: j.codec }),
          actions: core().failureActions(f, { formats: c.formats }),
        };
      }
      case 'added': return { section: 'added', tone: 'ok', status: null, actions: [] };
      default: return null;
    }
  }

  // The folders below the library, the library itself for its top folder,
  // cut at the start past two: "… › Daft Punk › Homework". Each crumb in an
  // isolate, so a right-to-left name keeps the › order.
  function toastPath(job) {
    const crumbs = folderCrumbs(job || {});
    if (!crumbs.length) { return ''; }
    const below = crumbs.slice(1);
    if (!below.length) { return isolate(crumbs[0]); }
    const shown = below.length > 2 ? below.slice(-2) : below;
    return (below.length > 2 ? `…${SEP}` : '') + shown.map(isolate).join(SEP);
  }

  // "Added “One More Time” to Daft Punk › Discovery" · "Couldn't add “…”";
  // null for a state that says nothing.
  function toastLabel(job) {
    const j = job || {};
    const title = str(j.title).trim() || str(j.fileName) || str(j.url);
    if (j.state === 'added') { return label('ytdl.toast.added', { title, path: toastPath(j) }); }
    if (j.state === 'failed' || j.state === 'startFailed') { return label('ytdl.toast.couldntAdd', { title }); }
    return null;
  }

  // ── the tracker ────────────────────────────────────────────────────────

  function defaultStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
  }
  function defaultVisible() {
    try { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; } catch (_) { return true; }
  }
  function defaultOnline() {
    try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch (_) { return true; }
  }
  function defaultRequest() {
    if (typeof MSTREAMAPI === 'undefined') { return fetchRequest({}); }
    return fetchRequest({ host: () => MSTREAMAPI.currentServer.host, token: () => MSTREAMAPI.currentServer.token });
  }

  // opts: {
  //   scope     { origin, user } — the server and account (storageKeys)
  //   storage   localStorage-shaped (default localStorage; null = this page only)
  //   now       () → ms (default Date.now)
  //   timers    { setTimeout, clearTimeout } (default the globals)
  //   request   (method, path, body, { signal }) → answer (default
  //             fetchRequest over MSTREAMAPI.currentServer)
  //   tabId     this tab (default a new one; pass tabIdOf() so a reload keeps it)
  //   visible   () → bool (default document.visibilityState)
  //   online    () → bool (default navigator.onLine)
  //   onToast   (job) → void: a job this tab started was added or failed
  // }
  // The page wires the browser to it with attach() (storage, online,
  // visibilitychange, pagehide).
  function createTracker(opts) {
    const o = opts || {};
    const keys = storageKeys(o.scope);
    const store = o.storage !== undefined ? o.storage : defaultStorage();
    const clock = typeof o.now === 'function' ? o.now : () => Date.now();
    const timers = o.timers && typeof o.timers.setTimeout === 'function' ? o.timers
      : { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    const request = typeof o.request === 'function' ? o.request : defaultRequest();
    const tab = strOrNull(o.tabId) || uuid();
    // This page: the leader beat's owner. A reload or a duplicated tab keeps
    // the tab id, never this.
    const inst = uuid();
    const visible = typeof o.visible === 'function' ? o.visible : defaultVisible;
    const online = typeof o.online === 'function' ? o.online : defaultOnline;
    const onToast = typeof o.onToast === 'function' ? o.onToast : null;

    // Without storage (or once it throws) the list lives in this page only.
    let storeOk = !!store;
    let memory = { jobs: [], retired: [] };
    let memLeader = null;
    let cur = null;
    // The stored text `cur` was read from (or written as): another tab's
    // write differs from it.
    let lastRaw = rawJobs();
    cur = parseStore(lastRaw);
    let known = new Map(cur.jobs.map((j) => [j.id, j.state]));
    const running = new Set();   // adds this page is sending
    const busy = new Set();      // rows whose Check again or retry runs here
    const listeners = new Set();
    let timer = null;
    let newsTimer = null;
    let polling = null;
    let stopped = false;
    let watching = false;
    let lastWaiting = false;
    let detach = null;
    const added = { records: [], cursor: null, end: false, loaded: false, loading: false, failed: false, readAt: null };
    let addedRead = null;

    // Storage stopped working: from now on this page alone, starting from
    // what it last knew (a read that throws mid-session must not empty it).
    function fallBack() {
      if (!storeOk) { return; }
      storeOk = false;
      if (cur) { memory = { jobs: cur.jobs, retired: cur.retired }; }
    }

    function rawJobs() {
      if (storeOk) {
        try { return store.getItem(keys.jobs); } catch (_) { fallBack(); }
      }
      return JSON.stringify(memory);
    }

    // A fresh copy of the list; `cur` moves only through sync().
    function read() { return parseStore(rawJobs()); }

    function write(data) {
      memory = { jobs: data.jobs, retired: data.retired };
      if (!storeOk) { return; }
      const raw = JSON.stringify(memory);
      try { store.setItem(keys.jobs, raw); lastRaw = raw; } catch (_) { storeOk = false; }
    }

    function readLeader() {
      if (!storeOk) { return memLeader; }
      try { return parseLeader(store.getItem(keys.leader)); } catch (_) { return memLeader; }
    }

    function writeLeader(rec) {
      memLeader = rec;
      if (!storeOk) { return; }
      try { store.setItem(keys.leader, JSON.stringify(rec)); } catch (_) { /* this page polls alone */ }
    }

    // A stopped tracker (signed out, another account) still writes what an
    // add it sent comes to, but tells no page of it.
    function emit(ev) {
      if (stopped) { return; }
      for (const fn of Array.from(listeners)) {
        try { fn(ev); } catch (_) { /* a listener's bug is its own */ }
      }
    }

    // Every change is read fresh from storage, made, pruned and written in
    // one go (another tab may have written since), then told. fn returns
    // false when it changed nothing (what it read is still taken in).
    function mutate(fn) {
      const data = read();
      if (fn(data) === false) { syncIfChanged(); return data; }
      prune(data, clock());
      write(data);
      sync(data);
      return data;
    }

    // NEEDS A LOOK rows go after 7 days; at most KEEP_JOBS stay, the oldest
    // settled ones dropped first. Open jobs always stay.
    function prune(data, t) {
      data.jobs.sort(newestFirst);
      data.jobs = data.jobs.filter((j) => isOpen(j) || NEEDS_LOOK.indexOf(j.state) === -1
        || t - (j.endedAt != null ? j.endedAt : j.createdAt) <= KEEP_FAILED_MS);
      let extra = data.jobs.length - KEEP_JOBS;
      for (let i = data.jobs.length - 1; i >= 0 && extra > 0; i--) {
        if (isOpen(data.jobs[i])) { continue; }
        retire(data, data.jobs[i]);
        data.jobs.splice(i, 1);
        extra--;
      }
      if (data.retired.length > RETIRED_CAP) { data.retired = data.retired.slice(-RETIRED_CAP); }
    }

    function retire(data, j) {
      if (j.serverId && data.retired.indexOf(j.serverId) === -1) { data.retired.push(j.serverId); }
    }

    // A settle is news here when this page saw the job open (or not yet
    // added) and now sees it settled: 'settled' for the explorer's re-list,
    // the Added list refreshed, this tab's toasts.
    function sync(data) {
      const before = known;
      cur = data;
      known = new Map(data.jobs.map((j) => [j.id, j.state]));
      const settled = [];
      for (const j of data.jobs) {
        const was = before.get(j.id);
        if (was == null || was === j.state) { continue; }
        if ((OPEN.indexOf(was) !== -1 && !isOpen(j)) || j.state === 'added') { settled.push(j); }
      }
      emit({ type: 'jobs' });
      for (const j of settled) { emit({ type: 'settled', job: snapshot(j) }); }
      if (watching && visible() && data.jobs.some((j) => !isOpen(j) && !j.seen)) { markSeen(); }
      deliverToasts(data);
      if (added.loaded && !stopped && settled.some((j) => j.state === 'added')) { loadAdded(); }
      scheduleNews();
    }

    // Toasts for this tab's jobs that settled, once: marked done in storage
    // before they fire. A stopped tracker leaves them pending, for the next
    // tracker in this tab (the same account signing in again) to show.
    function deliverToasts(data) {
      if (stopped || !data.jobs.some((j) => j.toast === 'pending' && j.tab === tab)) { return; }
      const t = clock();
      const fire = [];
      mutate((d) => {
        let changed = false;
        for (const j of d.jobs) {
          if (j.toast !== 'pending' || j.tab !== tab) { continue; }
          j.toast = 'done';
          changed = true;
          if (j.endedAt != null && t - j.endedAt <= TOAST_STALE_MS) { fire.push(snapshot(j)); }
        }
        return changed;
      });
      if (!onToast) { return; }
      for (const j of fire) {
        try { onToast(j); } catch (_) { /* the page's toast is its own */ }
      }
    }

    // Another tab wrote (the storage event fires only in the others).
    function syncIfChanged() {
      if (!storeOk) { return; }
      let raw;
      try { raw = store.getItem(keys.jobs); } catch (_) { return; }
      if (raw === lastRaw) { return; }
      lastRaw = raw;
      sync(parseStore(raw));
    }

    function find(id) { return read().jobs.find((j) => j.id === id) || null; }
    function idOf(ref) { return typeof ref === 'string' ? ref : (ref && ref.id) || null; }

    // Moves job `id` when it is still in one of `states` (another tab, a
    // dismiss or a late answer may have moved it meanwhile); the job after,
    // or null.
    function patch(id, states, fields) {
      let out = null;
      mutate((d) => {
        const j = d.jobs.find((x) => x.id === id);
        if (!j || (states && states.indexOf(j.state) === -1)) { return false; }
        Object.assign(j, fields);
        if (j.toast === 'pending' && !j.tab) { j.toast = null; }
        out = j;
      });
      return out;
    }

    // Several moves in one write, each held to the state (and the server
    // id) it was worked out from: Map id → { from, sid, fields }.
    function applyPatches(patches) {
      if (!patches.size) { return; }
      mutate((d) => {
        let changed = false;
        for (const j of d.jobs) {
          const p = patches.get(j.id);
          if (!p || j.state !== p.from || j.serverId !== p.sid) { continue; }
          Object.assign(j, p.fields);
          if (j.toast === 'pending' && !j.tab) { j.toast = null; }
          changed = true;
        }
        return changed;
      });
    }

    // [start] with an AbortSignal, failing as a timeout after [ms] (the
    // signal aborted too, so fetch lets go).
    function bounded(start, ms) {
      return new Promise((resolve, reject) => {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        let done = false;
        const h = timers.setTimeout(() => {
          if (done) { return; }
          done = true;
          try { if (ctrl) { ctrl.abort(); } } catch (_) { /* nothing to stop */ }
          const e = new Error(`no answer in ${ms} ms`);
          e.name = 'TimeoutError';
          e.timedOut = true;
          reject(e);
        }, ms);
        let p;
        try { p = Promise.resolve(start(ctrl ? ctrl.signal : undefined)); } catch (e) { p = Promise.reject(e); }
        p.then((v) => {
          if (done) { return; }
          done = true;
          timers.clearTimeout(h);
          resolve(v);
        }, (e) => {
          if (done) { return; }
          done = true;
          timers.clearTimeout(h);
          reject(e);
        });
      });
    }

    function getList() {
      return bounded((signal) => request('GET', LIST_PATH, null, { signal }), READ_TIMEOUT_MS).then((res) => {
        if (!res || !Array.isArray(res.downloads)) { throw new SyntaxError('no downloads in the answer'); }
        return res.downloads.filter(isEntry);
      });
    }

    // One page of this account's ytdl records, newest first.
    function recordsPage(limit, before) {
      const q = `?plugin=ytdl&limit=${limit}${before != null ? `&before=${encodeURIComponent(before)}` : ''}`;
      return bounded((signal) => request('GET', RECORDS_PATH + q, null, { signal }), READ_TIMEOUT_MS).then((res) => {
        if (!res || !Array.isArray(res.downloads)) { throw new SyntaxError('no downloads in the answer'); }
        return res.downloads.filter(isRecord);
      });
    }

    // ── an add ─────────────────────────────────────────────────────────

    function newJob(f, t) {
      return {
        id: uuid(), serverId: null, claim: null, tab,
        url: f.url, directory: f.directory, codec: f.codec || 'mp3', metadata: tagsIn(f.metadata),
        title: str(f.title), crumbs: Array.isArray(f.crumbs) ? f.crumbs.filter((c) => typeof c === 'string') : crumbsOf(f.directory),
        cover: strOrNull(f.cover), mkdir: strOrNull(f.mkdir), mkdirFolder: strOrNull(f.mkdirFolder),
        state: 'starting', createdAt: t, sentAt: null, knownAt: null, serverStart: null, endedAt: null,
        fileName: strOrNull(f.fileName), filePath: null, downloadId: null, bytes: null, trackId: null,
        failure: null, error: null, reason: null, hidden: false, seen: false, toast: null,
      };
    }

    // Add to library / Add here. req: { url (parseLink's), directory (as
    // POSTed: '/Music/Daft Punk/Discovery/'), codec, metadata ({ title,
    // artist, album, year } as typed: blanks and a bad year are left out),
    // title (what the row calls it), crumbs (the path shown), cover,
    // fileName (the predicted name), mkdir (a folder to make first,
    // recursively — true = the directory itself), mkdirFolder (the first new
    // folder's name, for "Couldn't make the folder “…”"), inline }.
    // Resolves { ok, unsure, failure, job }:
    //   ok      the server took it: `job` is 'adding'
    //   unsure  no answer: `job` is 'startUnsure', looked for 2 min
    //   else    `failure` (ytdl-core's) says why nothing started — a 409
    //           (problem 'exists') included. No row is left unless `inline`
    //           is false or a function answering false when the failure
    //           arrives (the surface no longer shows the link): then a
    //           'startFailed' row, and a toast.
    // Never rejects.
    function add(req) {
      const r = req || {};
      if (typeof r.url !== 'string' || r.url === '' || typeof r.directory !== 'string' || r.directory === '') {
        return Promise.resolve({ ok: false, unsure: false, failure: { problem: 'badRequest', detail: null, reason: null, text: null, phase: 'start' }, job: null });
      }
      const mkdir = r.mkdir === true ? r.directory : strOrNull(r.mkdir);
      // The tags kept are the ones sent (retries send them again).
      const body = core().addRequest({ url: r.url, directory: r.directory, codec: r.codec || 'mp3', fields: r.metadata });
      const job = newJob(Object.assign({}, r, { mkdir, metadata: body.metadata }), clock());
      mutate((d) => { d.jobs.unshift(job); });
      return run(job.id, r.inline);
    }

    function bodyOf(j) {
      return core().addRequest({ url: j.url, directory: j.directory, codec: j.codec, fields: j.metadata });
    }

    async function run(id, inline) {
      running.add(id);
      try {
        let job = find(id);
        if (!job) { return { ok: false, unsure: false, failure: null, job: null }; }
        if (job.mkdir) {
          try {
            await bounded((signal) => request('POST', MKDIR_PATH, { directory: job.mkdir }, { signal }), MKDIR_TIMEOUT_MS);
          } catch (err) {
            // Sent once, not retried here: it is recursive, so a Try again
            // makes it again.
            const f = core().mkdirFailure(err, { folder: job.mkdirFolder || undefined, directory: job.mkdir, online: online() });
            if (f) { return startFailed(id, f, inline); }
          }
        }
        // (A tab that took it for one that closed mid-add hands it back.)
        job = patch(id, ['starting', 'startUnsure'], { state: 'starting', sentAt: clock() });
        if (!job) { return { ok: false, unsure: false, failure: null, job: snapshot(find(id)) }; }
        let res;
        try {
          res = await bounded((signal) => request('POST', ADD_PATH, bodyOf(job), { signal }), POST_TIMEOUT_MS);
        } catch (err) {
          const f = core().classifyAdd(err, { directory: job.directory });
          if (f.problem !== 'startUnsure') { return startFailed(id, f, inline); }
          const j = patch(id, ['starting'], { state: 'startUnsure' }) || find(id);
          tick('add');
          return { ok: false, unsure: true, failure: f, job: snapshot(j) };
        }
        const serverId = res && typeof res.id === 'string' && res.id !== '' ? res.id : null;
        const fileName = res && typeof res.fileName === 'string' && res.fileName !== '' ? res.fileName : null;
        let out = null;
        mutate((d) => {
          const j = d.jobs.find((x) => x.id === id);
          // A late answer still names the job, after another tab took it
          // for one that closed mid-add (a duplicated tab carries this
          // tab's id) — and wins over the entry that tab claimed for it by
          // link and folder, which may be another add of the same song.
          const mine = !!j && (['starting', 'startUnsure', 'notSureStarted'].indexOf(j.state) !== -1
            || (j.state === 'adding' && j.claim === 'match' && !!serverId));
          if (!mine) { return false; }
          if (serverId) {
            // A job that took this entry by its link and folder took ours:
            // it looks again.
            for (const x of d.jobs) {
              if (x !== j && x.serverId === serverId && x.claim === 'match' && isOpen(x)) {
                Object.assign(x, { state: 'startUnsure', serverId: null, claim: null, serverStart: null, knownAt: null });
              }
            }
          }
          const moved = j.serverId !== serverId;
          Object.assign(j, {
            state: 'adding', serverId, claim: serverId ? 'post' : null, fileName: fileName || j.fileName, endedAt: null,
            knownAt: serverId ? clock() : null, serverStart: moved ? null : j.serverStart,
          });
          out = j;
        });
        tick('add');
        return { ok: true, unsure: false, failure: null, job: snapshot(out || find(id)) };
      } finally {
        running.delete(id);
      }
    }

    // Nothing started: the row goes, or stays as 'startFailed' when the
    // surface that sent it no longer shows it (or it came from a row).
    function startFailed(id, f, inline) {
      // A surface check that throws can't say the link is still shown: the
      // row is kept rather than the failure lost (and add() never rejects).
      let keep = inline === false;
      if (typeof inline === 'function') {
        try { keep = inline() === false; } catch (_) { keep = true; }
      }
      let kept = null;
      mutate((d) => {
        const i = d.jobs.findIndex((x) => x.id === id);
        // An entry claimed for it by link and folder meanwhile is someone
        // else's: the server just said this one never started.
        const x = i === -1 ? null : d.jobs[i];
        if (!x || !(['starting', 'startUnsure'].indexOf(x.state) !== -1 || (x.state === 'adding' && x.claim === 'match'))) { return false; }
        if (!keep) { d.jobs.splice(i, 1); return true; }
        Object.assign(x, {
          state: 'startFailed', serverId: null, claim: null, serverStart: null, knownAt: null,
          failure: f, endedAt: clock(), seen: false, toast: x.tab ? 'pending' : null,
        });
        kept = x;
        return true;
      });
      return { ok: false, unsure: false, failure: f, job: snapshot(kept) };
    }

    // Try again · Change format and retry ({ codec }) · Add again: a new
    // add of the same song in the row's place, sent once. A start failure
    // that had a folder made makes it again first. A failure leaves a row
    // (the user is looking at it). Resolves as add() does.
    function retry(ref, opts) {
      const id = idOf(ref);
      const old = id ? find(id) : null;
      if (!old || isOpen(old) || busy.has(id)) {
        return Promise.resolve({ ok: false, unsure: false, failure: null, job: snapshot(old) });
      }
      const codec = strOrNull(opts && opts.codec) || old.codec;
      const next = newJob({
        url: old.url, directory: old.directory, codec, metadata: old.metadata, title: old.title, crumbs: old.crumbs,
        cover: old.cover, fileName: old.fileName ? `${stemOf(old.fileName)}.${core().outputExtension(codec)}` : null,
        mkdir: old.state === 'startFailed' ? old.mkdir : null, mkdirFolder: old.mkdirFolder,
      }, clock());
      mutate((d) => {
        const i = d.jobs.findIndex((x) => x.id === id);
        if (i !== -1) { retire(d, d.jobs[i]); d.jobs.splice(i, 1); }
        d.jobs.unshift(next);
      });
      busy.add(next.id);
      return run(next.id, false).finally(() => {
        busy.delete(next.id);
        emit({ type: 'jobs' });
      });
    }

    // Dismiss: a settled row goes (its server id never claimed again); an
    // open one is hidden — the server keeps going, and it still counts as
    // "Already adding".
    function dismiss(ref) {
      const id = idOf(ref);
      mutate((d) => {
        const i = d.jobs.findIndex((x) => x.id === id);
        if (i === -1) { return false; }
        const j = d.jobs[i];
        if (isOpen(j)) {
          if (j.hidden) { return false; }
          j.hidden = true;
          return true;
        }
        retire(d, j);
        d.jobs.splice(i, 1);
        return true;
      });
    }

    // Hide from this list (an adding row's ⋯).
    function hide(ref) {
      const j = find(idOf(ref));
      if (j && isOpen(j)) { dismiss(j.id); }
    }

    // ── claim and settle ───────────────────────────────────────────────

    // Server ids some job holds, or a dismissed one held: never claimed by
    // link and folder.
    function heldIds(data, exceptId) {
      const held = new Set(data.retired);
      for (const j of data.jobs) { if (j.serverId && j.id !== exceptId) { held.add(j.serverId); } }
      return held;
    }

    // The newest entry for the job's link and folder that no job holds,
    // started no earlier than the slack before the press.
    function unclaimedFor(j, entries, held) {
      const floor = j.createdAt - CLAIM_SLACK_MS;
      let best = null;
      for (const e of entries) {
        if (e.url !== j.url || e.directory !== j.directory || held.has(e.id)) { continue; }
        const at = Number(e.startTime);
        if (!(at >= floor)) { continue; }
        if (!best || at > Number(best.startTime)) { best = e; }
      }
      return best;
    }

    // Another add of the same link into the same folder has its POST out:
    // an entry for them is as likely its own, so wait for its answer.
    function siblingSending(data, j) {
      return data.jobs.some((x) => x.id !== j.id && x.state === 'starting' && x.sentAt != null && x.url === j.url && x.directory === j.directory);
    }

    // What an entry's status makes of an adding job; null while it runs
    // with nothing new.
    function followFields(j, e, t) {
      if (e.status === 'complete') {
        return {
          state: 'added', serverStart: numOrNull(e.startTime), endedAt: t, fileName: strOrNull(e.fileName) || j.fileName,
          filePath: strOrNull(e.filePath), downloadId: intOrNull(e.downloadId), failure: null, error: null, reason: null,
          seen: false, toast: 'pending',
        };
      }
      if (e.status === 'error') {
        return {
          state: 'failed', serverStart: numOrNull(e.startTime), endedAt: t, fileName: strOrNull(e.fileName) || j.fileName,
          failure: core().entryFailure(e), error: strOrNull(e.error), reason: strOrNull(e.reason), seen: false, toast: 'pending',
        };
      }
      const fileName = strOrNull(e.fileName) || j.fileName;
      const serverStart = numOrNull(e.startTime);
      if (fileName === j.fileName && serverStart === j.serverStart) { return null; }
      return { fileName, serverStart };
    }

    function recordFields(r, t) {
      return {
        state: 'added', endedAt: t, filePath: r.filepath, fileName: nameOf(r.filepath), downloadId: r.id,
        bytes: numOrNull(r.bytes), trackId: intOrNull(r.trackId), failure: null, seen: false, toast: 'pending',
      };
    }

    function settledFields(state, t) {
      return { state, endedAt: t, seen: false, toast: TOASTED.indexOf(state) !== -1 ? 'pending' : null };
    }

    // The job's download record: by its id once the entry named it, else its
    // link as `origin`, in its folder (ignoring case — the record keeps the
    // disk's), written no earlier than the job started, and held by no
    // other job. Throws when the record can't be read.
    async function findRecord(j) {
      const taken = new Set();
      for (const x of cur.jobs) { if (x.id !== j.id && x.downloadId != null) { taken.add(x.downloadId); } }
      const bound = j.serverStart != null ? j.serverStart : j.createdAt - CLAIM_SLACK_MS;
      const folder = bare(j.directory).toLowerCase();
      let before = null;
      for (let i = 0; i < RECORD_PAGES; i++) {
        const page = await recordsPage(RECORD_PAGE, before);
        for (const r of page) {
          if (taken.has(r.id)) { continue; }
          if (j.downloadId != null ? r.id === j.downloadId
            : r.origin === j.url && folderOf(r.filepath).toLowerCase() === folder && Number(r.downloadedAt) >= bound) { return r; }
        }
        if (page.length < RECORD_PAGE) { return null; }
        const last = page[page.length - 1];
        if (Number(last.downloadedAt) < bound) { return null; }
        before = last.id;
      }
      return null;
    }

    // An adding job whose entry is gone: a server restart (running jobs die
    // with it), or the server's day passed. Its record says added; without
    // one it was not found — or, past the server's day, not sure it
    // finished. A record that can't be read leaves it for the next poll.
    async function settleVanished(j) {
      let r;
      try { r = await findRecord(j); } catch (_) { return; }
      const t = clock();
      const fields = r ? recordFields(r, t) : settledFields(t - j.createdAt > SERVER_KEEP_MS ? 'notSureFinished' : 'notFound', t);
      applyPatches(new Map([[j.id, { from: j.state, sid: j.serverId, fields }]]));
    }

    // The id came to be known (a 200, a claim) after a read went out: that
    // read may predate the entry — the server makes it just before its 200 —
    // so its absence there says nothing; the next read decides. A read is
    // bounded, so a gap well past its bound (twice it: a throttled timer can
    // run late) is a clock that moved, not this.
    function newerThanRead(j, readAt) {
      return readAt != null && j.knownAt != null && j.knownAt >= readAt && j.knownAt - readAt <= 2 * READ_TIMEOUT_MS;
    }

    // One read of GET /ytdl/downloads (sent at `readAt`) moves every open
    // job: those with an id follow their entry; the others, newest first,
    // take the newest entry for their link and folder that no job holds, or
    // give up after 2 min.
    async function apply(entries, readAt) {
      const t = clock();
      const data = read();
      const patches = new Map();
      const vanished = [];
      for (const j of data.jobs) {
        if (j.state !== 'adding' || !j.serverId) { continue; }
        const e = entries.find((x) => x.id === j.serverId);
        if (!e) { if (!newerThanRead(j, readAt)) { vanished.push(j); } continue; }
        const fields = followFields(j, e, t);
        if (fields) { patches.set(j.id, { from: j.state, sid: j.serverId, fields }); }
      }
      const held = heldIds(data);
      for (const j of data.jobs) {
        const looking = j.state === 'startUnsure' || (j.state === 'adding' && !j.serverId);
        if (!looking || siblingSending(data, j)) { continue; }
        const e = unclaimedFor(j, entries, held);
        if (e) {
          held.add(e.id);
          const claimed = { state: 'adding', serverId: e.id, claim: 'match', serverStart: numOrNull(e.startTime), knownAt: t };
          patches.set(j.id, { from: j.state, sid: j.serverId, fields: Object.assign(claimed, followFields(Object.assign({}, j, claimed), e, t)) });
        } else if (since(t, j.sentAt != null ? j.sentAt : j.createdAt) > CLAIM_WINDOW_MS) {
          if (j.state === 'startUnsure') { patches.set(j.id, { from: j.state, sid: j.serverId, fields: settledFields('notSureStarted', t) }); }
          else { vanished.push(j); }
        }
      }
      applyPatches(patches);
      for (const j of vanished) { await settleVanished(j); }
    }

    // Check again (Not sure it started / finished): the job list, then the
    // record. Found → Adding or Added; neither → Not found on the server.
    // A read that fails leaves the row as it was. Resolves the job after.
    async function checkAgain(ref) {
      const id = idOf(ref);
      const j0 = id ? find(id) : null;
      const can = ['startUnsure', 'notSureStarted', 'notSureFinished', 'notFound'];
      if (!j0 || busy.has(id) || can.indexOf(j0.state) === -1) { return snapshot(j0); }
      busy.add(id);
      emit({ type: 'jobs' });
      try {
        let entries;
        try { entries = await getList(); } catch (_) { return snapshot(find(id)); }
        const j = find(id);
        if (!j) { return null; }
        const t = clock();
        const e = j.serverId ? entries.find((x) => x.id === j.serverId) : unclaimedFor(j, entries, heldIds(read(), j.id));
        if (e) {
          const claimed = { state: 'adding', serverId: e.id, claim: j.serverId ? j.claim : 'match', serverStart: numOrNull(e.startTime), endedAt: null, knownAt: t };
          applyPatches(new Map([[j.id, { from: j.state, sid: j.serverId, fields: Object.assign(claimed, followFields(Object.assign({}, j, claimed), e, t)) }]]));
          tick('check');
          return snapshot(find(id));
        }
        let r;
        try { r = await findRecord(j); } catch (_) { return snapshot(find(id)); }
        const now = clock();
        if (r) { applyPatches(new Map([[j.id, { from: j.state, sid: j.serverId, fields: recordFields(r, now) }]])); }
        else if (j.state !== 'startUnsure') { applyPatches(new Map([[j.id, { from: j.state, sid: j.serverId, fields: settledFields('notFound', now) }]])); }
        return snapshot(find(id));
      } finally {
        busy.delete(id);
        emit({ type: 'jobs' });
      }
    }

    // ── one poller for every tab ───────────────────────────────────────

    function pollable() { return cur.jobs.some((j) => j.state === 'adding' || j.state === 'startUnsure'); }

    function isLeader() { const r = readLeader(); return !!r && r.inst === inst && r.visible; }

    // Lead unless another visible tab beat recently (forced: lead anyway —
    // the tab just shown, the online event in the leader). The beat keeps a
    // dead leader's backoff for a minute.
    function lead(force) {
      const t = clock();
      const r = readLeader();
      const mine = !!r && r.inst === inst;
      const live = !!r && !mine && r.visible && Math.abs(t - r.at) <= LEADER_STALE_MS;
      if (live && !force) { return null; }
      const keep = !!r && (mine || Math.abs(t - r.at) <= BACKOFF_CAP_MS);
      const fails = keep ? r.fails : 0;
      // A next read is never further off than its backoff: a wall clock set
      // back an hour would otherwise hold every read for that hour.
      const due = keep ? Math.min(r.due, t + delayFor(fails)) : t;
      const rec = { inst, at: t, visible: true, fails, due, waiting: !!r && r.waiting };
      writeLeader(rec);
      return rec;
    }

    // Hidden, closing, or nothing to poll: another visible tab may lead.
    function resign() {
      const r = readLeader();
      if (r && r.inst === inst && r.visible) { writeLeader(Object.assign({}, r, { visible: false })); }
    }

    function cancel() {
      if (timer != null) { timers.clearTimeout(timer); timer = null; }
    }

    function schedule(ms) {
      cancel();
      if (stopped) { return; }
      timer = timers.setTimeout(() => { timer = null; tick('beat'); }, Math.max(0, ms));
    }

    // A 'starting' job no page is sending: this tab's own from before a
    // reload, or another tab's well past its bounds — the POST may have
    // reached the server, so it is looked for.
    function reviveStale() {
      const t = clock();
      const stale = (j) => j.state === 'starting' && !running.has(j.id) && (j.tab === tab || since(t, j.createdAt) > STARTING_STALE_MS);
      if (!cur.jobs.some(stale)) { return; }
      mutate((d) => {
        let changed = false;
        for (const j of d.jobs) { if (stale(j)) { j.state = 'startUnsure'; changed = true; } }
        return changed;
      });
    }

    // When another tab's 'starting' job turns stale, if one is out.
    function staleAt() {
      let at = null;
      for (const j of cur.jobs) {
        if (j.state !== 'starting' || running.has(j.id)) { continue; }
        const t = j.createdAt + STARTING_STALE_MS + 1;
        if (at == null || t < at) { at = t; }
      }
      return at;
    }

    function tick(trigger) {
      if (stopped) { return; }
      cancel();
      syncIfChanged();
      reviveStale();
      if (!pollable() || !visible()) {
        resign();
        const at = visible() ? staleAt() : null;
        if (at != null) { schedule(at - clock()); }
        return;
      }
      const rec = lead(trigger === 'visible' || trigger === 'online');
      // A follower watches for the leader's beat to stop.
      if (!rec) { schedule(BEAT_MS); return; }
      // The beat goes on while a read is out.
      if (polling) { schedule(BEAT_MS); return; }
      const t = clock();
      if (trigger === 'visible' || trigger === 'online' || t >= rec.due) {
        polling = pollOnce().catch(() => {}).then(() => { polling = null; tick('poll'); });
        schedule(BEAT_MS);
        return;
      }
      schedule(Math.min(BEAT_MS, rec.due - t));
    }

    async function pollOnce() {
      let entries = null;
      let err = null;
      const readAt = clock();
      try { entries = await getList(); } catch (e) { err = e; }
      const t = clock();
      const r = readLeader();
      if (r && r.inst === inst) {
        const fails = entries ? 0 : r.fails + 1;
        writeLeader(Object.assign({}, r, { at: t, fails, due: t + delayFor(fails), waiting: !entries && noAnswer(err) }));
      }
      noteWaiting();
      if (entries) { await apply(entries, readAt); }
    }

    function noteWaiting() {
      const w = status().waiting;
      if (w === lastWaiting) { return; }
      lastWaiting = w;
      emit({ type: 'jobs' });
    }

    // ── the summary ────────────────────────────────────────────────────

    function fresh(j, t) { return t - (j.endedAt != null ? j.endedAt : j.createdAt) <= KEEP_FAILED_MS; }

    // The sidenav pill, the first count that isn't zero, in the phone's
    // order: adding · failures not seen yet · added in the last hour and
    // not seen. `until`: when the added count next drops by itself.
    function summary() {
      const t = clock();
      let adding = 0;
      let failed = 0;
      let done = 0;
      let until = null;
      for (const j of cur.jobs) {
        if (j.hidden) { continue; }
        if (isOpen(j)) { adding++; continue; }
        if (j.seen) { continue; }
        if (FAILURES.indexOf(j.state) !== -1 && fresh(j, t)) { failed++; }
        if (j.state === 'added' && j.endedAt != null && t - j.endedAt <= ADDED_NEWS_MS) {
          done++;
          const end = j.endedAt + ADDED_NEWS_MS;
          if (until == null || end < until) { until = end; }
        }
      }
      const kind = adding ? 'adding' : (failed ? 'failed' : (done ? 'added' : null));
      return { adding, failed, added: done, kind, count: kind === 'adding' ? adding : (kind === 'failed' ? failed : (kind === 'added' ? done : 0)), until };
    }

    // The pill drops "Added n" an hour on: a change to redraw.
    function scheduleNews() {
      if (newsTimer != null) { timers.clearTimeout(newsTimer); newsTimer = null; }
      if (stopped) { return; }
      const until = summary().until;
      if (until == null) { return; }
      newsTimer = timers.setTimeout(() => {
        newsTimer = null;
        emit({ type: 'jobs' });
        scheduleNews();
      }, Math.max(0, until - clock()) + 1);
    }

    // The panel showed every outcome so far: the pill's failed and added
    // counts clear.
    function markSeen() {
      mutate((d) => {
        let changed = false;
        for (const j of d.jobs) { if (!isOpen(j) && !j.seen) { j.seen = true; changed = true; } }
        return changed;
      });
    }

    // While this tab shows the panel, outcomes are seen as they land.
    function watch(on) {
      watching = !!on;
      if (watching) { markSeen(); }
    }

    // ── reading ────────────────────────────────────────────────────────

    function jobs() { return cur.jobs.map(snapshot); }
    function get(ref) { const id = idOf(ref); return snapshot(cur.jobs.find((j) => j.id === id) || null); }

    // Adding (open, not hidden) and Needs a look (not hidden, within 7
    // days), newest first.
    function lists() {
      const t = clock();
      return {
        adding: cur.jobs.filter((j) => isOpen(j) && !j.hidden).map(snapshot),
        needsLook: cur.jobs.filter((j) => !j.hidden && NEEDS_LOOK.indexOf(j.state) !== -1 && fresh(j, t)).map(snapshot),
      };
    }

    // "Already adding to this folder": an open job in any tab (hidden ones
    // too: the server keeps going) into `directory` — of the same link when
    // `url` is given.
    function isAddingTo(directory, url) {
      const dir = slashed(directory);
      return cur.jobs.some((j) => isOpen(j) && slashed(j.directory) === dir && (url == null || j.url === url));
    }

    // The explorer strip's jobs for the folder on screen: open ones and
    // failures not seen yet, in that folder or below it (not hidden).
    function jobsUnder(folderPath) {
      const base = slashed(folderPath).toLowerCase();
      return cur.jobs.filter((j) => !j.hidden && (isOpen(j) || (FAILURES.indexOf(j.state) !== -1 && !j.seen))
        && slashed(j.directory).toLowerCase().startsWith(base)).map(snapshot);
    }

    function status() {
      const r = readLeader();
      return { leader: !!r && r.inst === inst && r.visible, waiting: !!r && r.waiting, stored: storeOk };
    }

    // ── Added ──────────────────────────────────────────────────────────

    function recordRow(r, job) {
      const crumbs = crumbsOf(r.filepath);
      const name = crumbs.pop() || '';
      return {
        key: `record:${r.id}`, recordId: r.id, jobId: job ? job.id : null,
        title: str(r.title) || stemOf(name), artist: str(r.artist), album: str(r.album),
        filepath: r.filepath, fileName: name, crumbs, ext: extOf(name),
        bytes: numOrNull(r.bytes), at: numOrNull(r.downloadedAt), present: r.present === true, missing: r.present !== true,
        trackId: intOrNull(r.trackId), cover: job ? job.cover : null, url: strOrNull(r.origin) || (job ? job.url : null),
      };
    }

    function jobAddedRow(j) {
      const name = j.filePath ? nameOf(j.filePath) : str(j.fileName);
      return {
        key: `job:${j.id}`, recordId: j.downloadId, jobId: j.id,
        title: j.title || stemOf(name), artist: str(j.metadata.artist), album: str(j.metadata.album),
        filepath: j.filePath, fileName: name, crumbs: folderCrumbs(j), ext: name ? extOf(name) : core().outputExtension(j.codec),
        bytes: j.bytes, at: j.endedAt, present: j.filePath != null, missing: false,
        trackId: j.trackId, cover: j.cover, url: j.url,
      };
    }

    // The record's rows, each with the cover of the job it answers, and
    // this browser's added jobs no loaded record answers for yet (newer than
    // the last read, or with no record at all), one row per song. A job
    // whose record a read went past without it was removed; one older than
    // the loaded pages comes with Show earlier.
    function addedRows() {
      const byRecord = new Map();
      for (const j of cur.jobs) { if (j.state === 'added' && j.downloadId != null) { byRecord.set(j.downloadId, j); } }
      const ids = new Set(added.records.map((r) => r.id));
      const files = new Set(added.records.map((r) => r.filepath.toLowerCase()));
      const rows = added.records.map((r) => recordRow(r, byRecord.get(r.id)));
      for (const j of cur.jobs) {
        if (j.state !== 'added') { continue; }
        if (j.downloadId != null) {
          if (ids.has(j.downloadId)) { continue; }
          if (added.loaded) {
            const inRange = added.end || added.cursor == null || j.downloadId >= added.cursor;
            if (inRange && j.endedAt != null && added.readAt != null && j.endedAt < added.readAt) { continue; }
            if (!inRange) { continue; }
          }
        } else if (j.filePath && files.has(j.filePath.toLowerCase())) { continue; }
        rows.push(jobAddedRow(j));
      }
      rows.sort((a, b) => (b.at || 0) - (a.at || 0));
      return rows;
    }

    // rows: [{ key, recordId, jobId, title, artist, album, filepath
    // ('<vpath>/<path>', no leading slash; null = can't be played), fileName,
    // crumbs (the folder, library first), ext, bytes, at (ms), present,
    // missing ("File missing": the record's file is gone), trackId, cover,
    // url }].
    function addedView() {
      return {
        rows: addedRows(), loaded: added.loaded, loading: added.loading, failed: added.failed,
        canShowEarlier: added.loaded && !added.end, cursor: added.cursor,
      };
    }

    // The Added list: no `before` reads the newest page again (the pages
    // Show earlier brought stay below it); `before` = the view's cursor
    // reads the page after it. A read already out is shared. Resolves the
    // view; a failed read keeps what was there (`failed`). Never rejects.
    function loadAdded(opts) {
      if (addedRead) { return addedRead; }
      const ao = opts || {};
      const limit = Number.isInteger(ao.limit) && ao.limit > 0 ? Math.min(ao.limit, 500) : RECORD_PAGE;
      const before = ao.before != null ? ao.before : null;
      added.loading = true;
      emit({ type: 'added' });
      const readAt = clock();
      addedRead = (async () => {
        try {
          const page = await recordsPage(limit, before);
          const end = page.length < limit;
          const cut = page.length ? page[page.length - 1].id : null;
          if (before == null) {
            if (added.loaded && !end && cut != null && added.cursor != null && added.cursor < cut) {
              const ids = new Set(page.map((r) => r.id));
              added.records = page.concat(added.records.filter((r) => r.id < cut && !ids.has(r.id)));
            } else {
              added.records = page;
              added.cursor = cut;
              added.end = end;
            }
            added.readAt = readAt;
          } else {
            const have = new Set(added.records.map((r) => r.id));
            added.records = added.records.concat(page.filter((r) => !have.has(r.id)));
            if (cut != null) { added.cursor = cut; }
            added.end = end;
          }
          added.loaded = true;
          added.failed = false;
        } catch (_) {
          added.failed = true;
        }
        added.loading = false;
        addedRead = null;
        emit({ type: 'added' });
        return addedView();
      })();
      return addedRead;
    }

    // ── wiring ─────────────────────────────────────────────────────────

    function onStorage(e) {
      if (stopped) { return; }
      const key = e ? e.key : null;
      if (key != null && key !== keys.jobs && key !== keys.leader) { return; }
      noteWaiting();
      tick('storage');
    }

    // Shown again with the panel open: what landed meanwhile (another tab
    // read it, and this one, hidden, didn't count it as seen) is on screen.
    function onVisibility() {
      if (stopped) { return; }
      if (visible()) {
        tick('visible');
        if (watching) { markSeen(); }
        return;
      }
      cancel();
      resign();
    }

    // Back online: the leader reads at once; without one, the first tab
    // that ticks leads.
    function onOnline() {
      if (stopped) { return; }
      tick(isLeader() ? 'online' : 'storage');
    }

    // Listens to the page: storage (other tabs), online, visibilitychange,
    // pagehide (another tab leads at once). Returns detach.
    function attach(win, doc) {
      const w = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
      const d = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
      const onHide = () => { cancel(); resign(); };
      const onShow = () => onVisibility();
      if (w && typeof w.addEventListener === 'function') {
        w.addEventListener('storage', onStorage);
        w.addEventListener('online', onOnline);
        w.addEventListener('pagehide', onHide);
        w.addEventListener('pageshow', onShow);
      }
      if (d && typeof d.addEventListener === 'function') { d.addEventListener('visibilitychange', onVisibility); }
      const off = () => {
        if (w && typeof w.removeEventListener === 'function') {
          w.removeEventListener('storage', onStorage);
          w.removeEventListener('online', onOnline);
          w.removeEventListener('pagehide', onHide);
          w.removeEventListener('pageshow', onShow);
        }
        if (d && typeof d.removeEventListener === 'function') { d.removeEventListener('visibilitychange', onVisibility); }
        if (detach === off) { detach = null; }
      };
      if (detach) { detach(); }
      detach = off;
      return off;
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') { return () => {}; }
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }

    // The page is going (or its account): no more timers, another tab
    // leads, and nothing more is told or toasted here. An add still out
    // writes what it comes to.
    function stop() {
      if (stopped) { return; }
      cancel();
      if (newsTimer != null) { timers.clearTimeout(newsTimer); newsTimer = null; }
      resign();
      stopped = true;
      watching = false;
      if (detach) { detach(); }
    }

    // Start: a reload's toasts that came due while it loaded, its own add
    // that was out looked for, and a page with open jobs polls (or follows
    // the tab that does).
    deliverToasts(cur);
    tick('start');
    scheduleNews();

    return {
      tabId: tab, keys,
      jobs, get, lists, summary, isAddingTo, jobsUnder, status, busy: (ref) => busy.has(idOf(ref)),
      row: (job, ctx) => jobRow(job, Object.assign({ now: clock(), waiting: status().waiting }, ctx)),
      add, retry, dismiss, hide, checkAgain, markSeen, watch,
      loadAdded, addedView,
      subscribe, attach, stop,
      onStorage, onVisibility, onOnline,
      refresh: () => { syncIfChanged(); tick('storage'); },
    };
  }

  return {
    KEYS, STATES, OPEN, NEEDS_LOOK,
    POLL_MS, BACKOFF_CAP_MS, BEAT_MS, LEADER_STALE_MS, CLAIM_WINDOW_MS, CLAIM_SLACK_MS, POST_TIMEOUT_MS, MKDIR_TIMEOUT_MS,
    READ_TIMEOUT_MS, STARTING_STALE_MS, SERVER_KEEP_MS, KEEP_JOBS, KEEP_FAILED_MS, ADDED_NEWS_MS, TOAST_STALE_MS, RECORD_PAGE,
    storageKeys, tabIdOf, fetchRequest, createTracker, jobRow, toastLabel, delayFor, isolate,
  };
}));
