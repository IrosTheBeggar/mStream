// Add from YouTube's screens: the sidenav entry's state pill, the panel in
// the left column (the link field, the card a lookup fills, where the song
// lands, the format and the add; then this browser's Adding and Needs a
// look rows and the server's Added record), and its windows — "Where new
// songs land" and "Choose a folder", one window at a time, the second
// replacing the first. The rules are alpha/ytdl-core.js's, the jobs
// alpha/ytdl-jobs.js's; m.js opens the panel (ytdlPanel) and feeds this
// file the server's facts (setServer) and the account (start).
//
// Two halves in one file. The first has no DOM and no Vue: the remembered
// choices' storage, the rows' and the pill's reading of the tracker, and
// the draft — the card's state and everything it does (the 400 ms lookup
// with its request ids, the 8 s "Still looking", the 30 s bound and the
// late answer; the tags and their clean-up; where the song lands and its
// new-folder check; the add) — with its timers, requests and store
// injected, so test/unit/webapp-ytdl-ui.test.mjs drives it on node. The
// second registers the Vue 2 components (vp.js's house: string templates,
// tt() for every word, props in and events out) and mounts them: one Vue
// instance for the panel, made and destroyed with it, and one root for
// the windows.
//
// A port of the phone's lib/screens/ytdl/ytdl_draft.dart, ytdl_lists.dart,
// ytdl_where_sheet.dart and ytdl_choose_folder_sheet.dart for a wide
// column — where it differs on purpose the comment says so: the four tag
// fields are always open, a field's source shows only while it has
// focus, and the boards cut what the phone said twice (the limits line,
// "Sent as …", the format menu's header and footer, "Just this song").

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./ytdl-core.js'), require('./ytdl-jobs.js')); }
  else { root.YTDLUI = factory(root.YTDLCORE, root.YTDLJOBS); }
}(typeof self !== 'undefined' ? self : this, function (ytdlCore, ytdlJobs) {
  // index.html loads both first; read late as well, like ytdl-jobs.js.
  function core() {
    if (ytdlCore) { return ytdlCore; }
    if (typeof YTDLCORE !== 'undefined') { return YTDLCORE; }
    throw new Error('ytdl-ui.js needs alpha/ytdl-core.js (window.YTDLCORE)');
  }
  function jobs() {
    if (ytdlJobs) { return ytdlJobs; }
    if (typeof YTDLJOBS !== 'undefined') { return YTDLJOBS; }
    throw new Error('ytdl-ui.js needs alpha/ytdl-jobs.js (window.YTDLJOBS)');
  }

  function label(key, params) { return params ? { key, params } : { key }; }
  function str(v) { return v == null ? '' : String(v); }
  function crumbsOf(p) { return str(p).split('/').filter(Boolean); }
  function dirOf(crumbs) { return crumbs.length ? `/${crumbs.join('/')}/` : '/'; }
  // Folder names joined as text ("Music › Daft Punk"), each in a Unicode
  // isolate (the tracker's), so a right-to-left name keeps the › order.
  function crumbLine(crumbs) { return (Array.isArray(crumbs) ? crumbs : []).map((c) => jobs().isolate(str(c))).join(' › '); }

  // A lookup starts this long after typing stops (a paste looks up at
  // once); it reads as slow after 8 s, when "Enter details yourself" lets
  // Add go without it, and gives up at 30 s. The new-folder check runs
  // 600 ms after the path settles, and past 15 s (a listing that never
  // answered) counts as unknown — the add waits on it, as the tracker's
  // folder-make waits 15 s.
  const LOOKUP_DEBOUNCE_MS = 400;
  const SLOW_AFTER_MS = 8000;
  const LOOKUP_BOUND_MS = 30 * 1000;
  const CHECK_AFTER_MS = 600;
  const CHECK_BOUND_MS = 15 * 1000;
  // The server stops a download at 60 minutes: an Adding row never says
  // more, whatever this browser's clock did meanwhile.
  const MAX_ADDING_MINUTES = 60;

  // ── what this browser remembers ────────────────────────────────────────
  // Library, layout and format, per server and account (spec decision 7):
  // localStorage under the tracker's own scope, { origin, user }. Never the
  // account's Discover destination, which this feature never writes.

  function prefKeys(scope) {
    const s = scope || {};
    const tail = `${encodeURIComponent(str(s.origin))}|${encodeURIComponent(str(s.user))}`;
    return { where: `mstream-ytdl-where:${tail}`, format: `mstream-ytdl-format:${tail}` };
  }

  // A remembered destination as stored ({ library, layout, kind }), or null
  // for anything else — a hand-edited or older value reads as none.
  function readChoice(raw) {
    let v = raw;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_) { return null; }
    }
    if (!v || typeof v !== 'object' || typeof v.library !== 'string' || typeof v.layout !== 'string') { return null; }
    const kind = core().LAYOUT_KINDS.indexOf(v.kind) !== -1 ? v.kind : null;
    return { library: v.library, layout: v.layout, kind };
  }

  // → { choice, format }: what `storage` holds for `scope` (nulls when it
  // holds nothing, garbage, or throws).
  function readPrefs(storage, scope) {
    const keys = prefKeys(scope);
    const out = { choice: null, format: null };
    if (!storage) { return out; }
    try { out.choice = readChoice(storage.getItem(keys.where)); } catch (_) { out.choice = null; }
    try {
      const f = storage.getItem(keys.format);
      out.format = typeof f === 'string' && /^[a-z0-9]{1,16}$/.test(f) ? f : null;
    } catch (_) { out.format = null; }
    return out;
  }

  // Keep a choice (null forgets it) / a format (null forgets it). → true
  // when storage took it.
  function writeChoice(storage, scope, choice) {
    if (!storage) { return false; }
    const key = prefKeys(scope).where;
    try {
      if (choice == null) { storage.removeItem(key); return true; }
      const c = core().choiceToSave(choice);
      storage.setItem(key, JSON.stringify({ library: c.library, layout: c.layout, kind: c.kind }));
      return true;
    } catch (_) { return false; }
  }
  function writeFormat(storage, scope, codec) {
    if (!storage) { return false; }
    const key = prefKeys(scope).format;
    try {
      if (codec == null || codec === '') { storage.removeItem(key); } else { storage.setItem(key, String(codec)); }
      return true;
    } catch (_) { return false; }
  }

  // ── rows, the pill, small readings ─────────────────────────────────────

  // A button's words for a row action (literal keys: the locale test finds
  // every one).
  const ACTION_KEYS = {
    retry: 'ytdl.retry',
    addAgain: 'ytdl.row.addAgain',
    checkAgain: 'ytdl.row.checkAgain',
    changeFormat: 'ytdl.row.changeFormatRetry',
    chooseFolder: 'ytdl.noMkdir.choose',
    topOfLibrary: 'ytdl.where.preset.top',
    dismiss: 'ytdl.row.dismiss',
  };

  // "Adding · 2 min · MP3": the minutes held to 1–60, so a clock set back
  // or forward meanwhile can't make it read 0 or 1440.
  function clampAdding(status) {
    if (!status || status.key !== 'ytdl.row.adding' || !status.params) { return status; }
    const n = Number(status.params.count);
    const count = Number.isFinite(n) ? Math.min(MAX_ADDING_MINUTES, Math.max(1, Math.floor(n))) : 1;
    return label(status.key, Object.assign({}, status.params, { count }));
  }

  // An Adding or Needs a look row, from a tracker job and the tracker's
  // row for it →
  //   { id, title, crumbs, cover, codec, section, tone, glyph, status,
  //     wide, inline, actions: [{ name, label, quiet }] }
  // `wide`: the status sits at the right with the bar (Adding · 2 min ·
  // MP3, Starting…); otherwise it goes under the title (the server hasn't
  // answered, waiting for a connection). `inline`: a short reason's
  // buttons beside it (Check again; Add again · Dismiss), a long one's on
  // their own line (the WebLists board). Hide from this list is the
  // phone's ⋮ on an Adding row: the board draws no control there, so it
  // has none here.
  function rowView(job, row) {
    const j = job || {};
    const r = row || { section: 'needsLook', tone: 'error', status: null, actions: [] };
    const title = str(j.title).trim() || str(j.fileName) || str(j.url);
    const crumbs = j.filePath ? crumbsOf(j.filePath).slice(0, -1) : (Array.isArray(j.crumbs) && j.crumbs.length ? j.crumbs.slice() : crumbsOf(j.directory));
    const status = clampAdding(r.status);
    const waiting = !!status && status.key === 'ytdl.row.waiting';
    let names = (r.actions || []).filter((a) => a !== 'hide');
    // The board's "Not sure it started" offers Check again alone: it turns
    // into "Not found on the server" (Add again · Dismiss) once both reads
    // answered.
    if (j.state === 'notSureStarted') { names = names.filter((a) => a !== 'dismiss'); }
    return {
      id: j.id,
      title,
      crumbs,
      cover: typeof j.cover === 'string' && j.cover ? j.cover : null,
      // the format it was asked in: "Change format and retry" marks it
      codec: typeof j.codec === 'string' && j.codec ? j.codec : null,
      state: j.state,
      section: r.section,
      tone: r.tone,
      glyph: r.tone === 'unsure' ? 'question' : 'alert',
      status,
      wide: r.section === 'adding' && !waiting && (j.state === 'adding' || j.state === 'starting'),
      inline: j.state === 'notSureStarted' || j.state === 'notFound',
      actions: names.map((name) => ({ name, label: label(ACTION_KEYS[name] || 'ytdl.row.dismiss'), quiet: name === 'dismiss' })),
    };
  }

  // "MP3 · 8.4 MB · 3 min ago" for an Added row: the format by the file's
  // extension (the record carries no codec), the size, when → parts, empty
  // ones out. `ago` is m.js's discoverDownloadsAgo (passed in).
  function addedFacts(row, ago) {
    const r = row || {};
    const parts = [];
    if (r.ext) { parts.push(core().formatName(r.ext)); }
    const bytes = typeof DISCOVERJOBS !== 'undefined' && DISCOVERJOBS.fmtBytes ? DISCOVERJOBS.fmtBytes(r.bytes) : '';
    if (bytes) { parts.push(bytes); }
    const when = typeof ago === 'function' && r.at != null ? ago(r.at) : '';
    if (when) { parts.push(when); }
    return parts;
  }

  // The sidenav pill for the tracker's summary → { kind, count, sr } or
  // null: ↓ teal while adding, ! warn while one needs a look, ✓ ok for an
  // hour after (the phone's order); `sr` is the words read in its place.
  const PILL_KEYS = { adding: 'ytdl.pill.adding', failed: 'ytdl.pill.needsLook', added: 'ytdl.pill.added' };
  function pillView(summary) {
    const s = summary || {};
    if (!PILL_KEYS[s.kind] || !(s.count > 0)) { return null; }
    return { kind: s.kind, count: s.count, sr: label(PILL_KEYS[s.kind], { count: s.count }) };
  }

  // A translated line split around one param's value, so the value can be
  // drawn on its own (a file name in mono): → [before, value, after], or
  // [text] when the value isn't in it. `translate` is t().
  const MARK = '\u0000';
  function splitAround(translate, l, param) {
    if (!l) { return ['']; }
    const params = l.params || {};
    if (!Object.prototype.hasOwnProperty.call(params, param)) { return [translate(l.key, l.params)]; }
    const value = str(params[param]);
    const text = translate(l.key, Object.assign({}, params, { [param]: MARK }));
    const at = text.indexOf(MARK);
    if (at === -1) { return [text]; }
    return [text.slice(0, at), value, text.slice(at + MARK.length).split(MARK).join(value)];
  }

  // The libraries a song can go into: the destination view's (the writable
  // ones) held to the ping's, so a library the server dropped since the
  // view was read (a "library gone" refusal re-pings) is neither the
  // remembered default nor a choice; the ping's alone before the view
  // answered.
  function librariesFor(view, server) {
    const vpaths = server && Array.isArray(server.vpaths) ? server.vpaths : [];
    if (!view) { return vpaths.slice(); }
    const libs = (Array.isArray(view.libraries) ? view.libraries : []).map((l) => l && l.vpath).filter((x) => typeof x === 'string');
    return server && server.ready ? libs.filter((v) => vpaths.indexOf(v) !== -1) : libs;
  }

  // What a card's status region says → { phase, lost } labels or nulls:
  // the lookup as it stands (Reading…, Still looking, its failure, a late
  // answer), and a right the server took away under the open card
  // (uploads, conversion: a re-ping) — one region, always there, its words
  // changing (a region put in with its words is often never read).
  function saidOf(m) {
    const v = m || {};
    let phase = null;
    if (v.phase === 'reading') { phase = label('ytdl.lookup.reading'); }
    else if (v.phase === 'slow') { phase = label('ytdl.lookup.slow'); }
    else if (v.lookupLine) { phase = v.lookupLine.label; }
    else if (v.late) { phase = label('ytdl.late.found'); }
    const lost = (v.block === 'uploadsOff' || v.block === 'convertOff') && v.reason ? v.reason : null;
    return { phase, lost };
  }

  // ── the draft: one link's card ─────────────────────────────────────────
  // The store is what every surface reads (in the browser a Vue.observable):
  //   server  { ready, uploadsOff, convertOff, noMkdir, supported (the
  //           ping's supportedAudioFiles), vpaths, name }
  //   view    GET /discovery/collection/destination, or null (read only)
  //   saved   the remembered destination ({ library, layout, kind }) | null
  //   format  the remembered codec | null
  //   ytdlpMissing  a lookup said so this session (shown at once after)
  //   mkdirRefused  a folder-make was refused this session (noMkdir from then)
  //   tick    bumped when the tracker changed (its getters aren't reactive)
  //   now     the minute clock the rows read
  //   lang    bumped on a language change
  //   win     the open window ({ mode: 'where' | 'choose' }) | null
  function createStore() {
    return {
      server: { ready: false, uploadsOff: false, convertOff: false, noMkdir: false, supported: null, vpaths: [], name: '' },
      view: null,
      saved: null,
      format: null,
      ytdlpMissing: false,
      mkdirRefused: false,
      tick: 0,
      now: Date.now(),
      lang: 0,
      win: null,
    };
  }

  // env: {
  //   store     createStore()'s (observable in the browser)
  //   api       { metadata(url, { signal }) → answer, list(directory) → listing }
  //   tracker   () → the job tracker (YTDLJOBS.createTracker) or null
  //   prefs     { setChoice(choice), setFormat(codec), clearFormat() }
  //   recheck   (problem) → the server's facts asked again (m.js re-pings)
  //   online    () → navigator.onLine
  //   timers    { setTimeout, clearTimeout }
  //   observe   (object) → the reactive version of it (Vue.observable)
  //   folder    the explorer window's: the folder on screen it adds into
  //             ('Music/Daft Punk/' or '/Music/Daft Punk/'); none = the
  //             panel's draft
  //   shown     (dir) → the file names the explorer lists for `dir`, or
  //             null (the window's Right here, when the folder won't list)
  // }
  //
  // The window's draft (the phone's folder sheet): the song goes into the
  // folder — "Add here", sent as it is, never a folder made — or into
  // subfolders under it ("Sort into subfolders…": Album, Artist / Album or
  // Custom, then "Add to library", folders made as the panel makes them).
  // The choice lasts one window (sheetOpened) and is never remembered.
  function createDraft(env) {
    const e = env || {};
    const store = e.store || createStore();
    const C = core();
    const timers = e.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    const isOnline = typeof e.online === 'function' ? e.online : () => true;
    const observe = typeof e.observe === 'function' ? e.observe : (o) => o;
    const tracker = () => (typeof e.tracker === 'function' ? e.tracker() : null);
    const folder = e.folder && crumbsOf(e.folder).length ? dirOf(crumbsOf(e.folder)) : null;
    const shown = folder && typeof e.shown === 'function' ? e.shown : undefined;

    const s = observe({
      link: '',          // the field as typed
      url: null,         // the card's video (parseLink's url), null = no card
      lookup: 'idle',    // idle | loading | slow | found | failed | timedOut | ytdlpMissing | offline | unreachable
      lookupFailure: null,
      meta: null,        // readMetadata's answer
      guess: C.GUESS_NONE,
      late: null,        // an answer that came after the user typed
      manual: false,     // "Enter details yourself"
      fields: { title: '', artist: '', album: '', year: '' },
      edited: { title: false, artist: false, album: false, year: false },
      restored: [],      // fragment indexes put back
      swapped: false,
      stripRestored: false,
      focused: null,     // the field with focus (its help line shows)
      just: null,        // a choice for this song only
      justFor: null,     // the video it belongs to
      check: { state: 'idle', dir: null, newSegments: [], deepest: null, files: null },
      starting: false,   // this card's add is out ("Adding…")
      startingKey: null, // url + folder of that add: its row stays out of Adding meanwhile
      addFailure: null,  // shown inline above the footer
      failedCodec: null,
      uploadsRefused: false,
      sub: 'here',       // the window's subfolders: a FOLDER_SORTS kind
      subCustom: '',     // …Custom's layout as typed
      subOpen: false,    // "Sort into subfolders…" pressed: the radios show
    });

    let disposed = false;
    let attached = false;
    let lookupRid = 0;
    let lookupTimer = null;
    let slowTimer = null;
    let boundTimer = null;
    let lookupCtl = null;
    let checkRid = 0;
    let checkTimer = null;
    let checking = null;
    let parsedFor = null;
    let parsed = null;
    const LATE = {};

    function parse() {
      if (parsedFor !== s.link) { parsedFor = s.link; parsed = C.parseLink(s.link); }
      return parsed;
    }

    function clearLookupTimers() {
      if (lookupTimer) { timers.clearTimeout(lookupTimer); lookupTimer = null; }
      if (slowTimer) { timers.clearTimeout(slowTimer); slowTimer = null; }
      if (boundTimer) { timers.clearTimeout(boundTimer); boundTimer = null; }
    }

    // A lookup no card wants any more is called off (its answer would be
    // dropped by its request id anyway).
    function abortLookup() {
      if (lookupCtl) { try { lookupCtl.abort(); } catch (_) { /* gone */ } lookupCtl = null; }
    }

    // ── link ──

    // The field changed (`immediate`: a paste — look up at once). Another
    // video, or none, starts the card again; a just-this-song choice made
    // before any link is the first video's, and another video drops it.
    function setLink(text, opts) {
      if (disposed) { return; }
      const immediate = !!(opts && opts.immediate);
      const value = str(text);
      const changed = value !== s.link;
      s.link = value;
      const p = parse();
      const url = p.kind === 'video' ? p.url : null;
      if (url !== s.url) {
        resetCard();
        s.url = url;
        if (s.just && url) {
          if (s.justFor == null) { s.justFor = url; }
          else if (s.justFor !== url) { s.just = null; s.justFor = null; }
        }
        if (url) {
          if (immediate) { startLookup(false); }
          else { lookupTimer = timers.setTimeout(() => { lookupTimer = null; startLookup(false); }, LOOKUP_DEBOUNCE_MS); }
        }
      } else if (immediate && url && (lookupTimer || noConnection())) {
        // A paste looks up at once — and pasting the link of a lookup that
        // found no connection asks again.
        startLookup(false);
      } else if (!changed && !immediate) {
        return;
      }
      afterChange();
    }

    // ✕ "Clear link": the whole draft goes — the link, the lookup, the
    // edits, a just-this-song choice.
    function clear() {
      s.link = '';
      s.url = null;
      resetCard();
      s.just = null;
      s.justFor = null;
      dropFailure();
      afterChange();
    }

    function noConnection() { return s.lookup === 'offline' || s.lookup === 'unreachable'; }

    // ── lookup ──

    function startLookup(force) {
      clearLookupTimers();
      abortLookup();
      const url = s.url;
      if (!url || disposed) { return; }
      const rid = ++lookupRid;
      s.lookupFailure = null;
      // "yt-dlp missing" learnt this session shows at once — and the server
      // is still asked: the board offers no Try again there, and an admin
      // may have set it up since.
      if (store.ytdlpMissing && !force) {
        s.lookup = 'ytdlpMissing';
        s.lookupFailure = { problem: 'ytdlpMissing', detail: null, reason: null, text: null, phase: 'lookup' };
      } else {
        s.lookup = 'loading';
        slowTimer = timers.setTimeout(() => {
          slowTimer = null;
          if (rid === lookupRid && s.lookup === 'loading') { s.lookup = 'slow'; }
        }, SLOW_AFTER_MS);
      }
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      lookupCtl = ctl;
      let timedOut = false;
      boundTimer = timers.setTimeout(() => {
        boundTimer = null;
        timedOut = true;
        if (ctl) { ctl.abort(); }
      }, LOOKUP_BOUND_MS);
      afterChange();
      let answer;
      try {
        answer = Promise.resolve(e.api.metadata(url, { signal: ctl ? ctl.signal : undefined }));
      } catch (err) {
        answer = Promise.reject(err);
      }
      answer.then((a) => {
        if (disposed || rid !== lookupRid) { return; }
        clearLookupTimers();
        lookupCtl = null;
        store.ytdlpMissing = false;
        s.meta = C.readMetadata(a);
        s.lookup = 'found';
        const g = C.guess(s.meta);
        if (anyEdited()) { s.late = g; } else { useGuess(g); }
        afterChange();
      }, (err) => {
        if (disposed || rid !== lookupRid) { return; }
        clearLookupTimers();
        lookupCtl = null;
        // Our own bound reads as a timeout, whatever the abort threw.
        const f = C.classifyLookup(timedOut ? { name: 'AbortError', timedOut: true } : err, { online: isOnline() });
        s.lookupFailure = f;
        const st = C.lookupStateOf(f);
        s.lookup = st;
        if (st === 'ytdlpMissing') { store.ytdlpMissing = true; }
        afterChange();
      });
    }

    // "Try again": the lookup once more (after "yt-dlp missing" too).
    function retryLookup() { startLookup(true); }

    // "Enter details yourself": Add stops waiting for the lookup.
    function enterManually() {
      if (s.manual) { return; }
      s.manual = true;
      afterChange();
    }

    // "Use them": the late answer fills only the fields nobody edited.
    function useLate() {
      const g = s.late;
      if (!g) { return; }
      s.late = null;
      useGuess(g);
      afterChange();
    }

    // ── tags ──

    function anyEdited() { return C.FIELDS.some((f) => s.edited[f]); }

    function guessState() { return { restored: s.restored.slice(), swapped: s.swapped, stripRestored: s.stripRestored }; }

    function guessPair() { return C.guessFields(s.guess, guessState()); }

    function fill(f, value) { s.fields[f] = value; }
    function fillUnedited(f, value) { if (!s.edited[f]) { fill(f, value); } }

    function useGuess(g) {
      s.guess = g;
      s.restored = [];
      s.swapped = false;
      s.stripRestored = false;
      const pair = guessPair();
      fillUnedited('title', pair.title);
      fillUnedited('artist', pair.artist);
      fillUnedited('album', g.album);
      fillUnedited('year', g.year);
    }

    // Typed in a tag field.
    function setField(f, value) {
      if (disposed || C.FIELDS.indexOf(f) === -1) { return; }
      const v = str(value);
      if (s.fields[f] === v) { return; }
      s.fields[f] = v;
      s.edited[f] = true;
      afterChange();
    }

    function setFocus(f) {
      s.focused = C.FIELDS.indexOf(f) !== -1 ? f : null;
    }

    // A change to the guess's restores; a field whose guessed value moved
    // takes the new one (an edit there gives way: the user asked for it).
    function changeGuess(change) {
      const before = guessPair();
      change();
      const after = guessPair();
      if (after.title !== before.title) { fill('title', after.title); s.edited.title = false; }
      if (after.artist !== before.artist) { fill('artist', after.artist); s.edited.artist = false; }
      afterChange();
    }

    // A put-back chip: the fragment goes back into the title.
    function restore(index) {
      const g = s.guess;
      if (!(index >= 0 && index < g.fragments.length) || s.restored.indexOf(index) !== -1) { return; }
      changeGuess(() => {
        if (g.fragments[index].kind === 'split') { s.swapped = false; }
        s.restored = s.restored.concat([index]);
      });
    }

    // "Undo all": the video's own title back.
    function undoAll() {
      const g = s.guess;
      if (!(g.cleaned && s.restored.length < g.fragments.length)) { return; }
      changeGuess(() => {
        s.swapped = false;
        s.restored = g.fragments.map((_, i) => i);
      });
    }

    function tags() { return C.tagsOf(s.fields); }

    // The title field, else the video's own title.
    function displayTitle() {
      const t = s.fields.title.trim();
      return t || (s.meta && s.meta.title) || '';
    }

    // ── where it lands ──

    // The remembered choice: this browser's for the server and account,
    // read against the libraries there are (librariesFor).
    function remembered() {
      return C.rememberedChoice({ view: store.view, saved: store.saved, libraries: librariesFor(store.view, store.server) });
    }

    // The panel: the remembered choice unless a just-this-song one is set.
    // The window: the folder on screen with its subfolders under it.
    function choice() {
      if (s.just) { return s.just; }
      return folder ? folderChoice(folder, subLayout()) : remembered();
    }

    // A folder choice: '/Music/Daft Punk/' — "Save to … instead", "Choose
    // a folder…", the window's folder — with `layout` under it (none).
    function folderChoice(directory, layout) {
      const crumbs = crumbsOf(directory);
      return { kind: 'folder', library: crumbs[0] || '', base: crumbs.slice(1).join('/'), layout: str(layout) };
    }

    function targetFor(c) {
      if (c && c.kind === 'folder') {
        return C.folderTarget({ currentPath: dirOf([c.library].concat(crumbsOf(c.base))), layout: c.layout || '', tags: tags() });
      }
      return C.choiceTarget(c, tags());
    }

    // The window's Custom names no folder until something usable is typed:
    // left empty it is not Right here, and a layout the checks refuse (an
    // unknown variable, GENRE, a ":") goes nowhere.
    function subRefused() {
      if (!folder || s.just || s.sub !== 'custom') { return false; }
      return s.subCustom.trim() === '' || !C.layoutCheck(s.subCustom).valid;
    }

    function target() {
      const t = targetFor(choice());
      return subRefused() ? Object.assign({}, t, { valid: false, directory: '' }) : t;
    }

    // ── the window's folder ──

    function subLayout() {
      if (s.sub === 'custom') { return s.subCustom; }
      const f = C.FOLDER_SORTS.find((x) => x.kind === s.sub);
      return f ? str(f.layout) : '';
    }

    // "Right here": the folder the explorer shows, sent unchanged — no
    // folder to make, so an account that can't make folders adds there too.
    function rightHere() { return !!folder && !s.just && s.sub === 'here'; }

    // A subfolder radio: it takes over from a folder picked for this song.
    function setSub(kind) {
      if (!folder || !C.FOLDER_SORTS.some((x) => x.kind === kind)) { return; }
      if (kind === s.sub && !s.just) { return; }
      s.sub = kind;
      s.just = null;
      s.justFor = null;
      dropFailure();
      afterChange();
    }

    function setSubCustom(text) {
      const v = str(text);
      if (!folder || v === s.subCustom) { return; }
      s.subCustom = v;
      dropFailure();
      afterChange();
    }

    // "Sort into subfolders…": the radios open in place of the folder line.
    function openSub() {
      if (!folder) { return; }
      s.subOpen = true;
      if (s.just) { s.just = null; s.justFor = null; dropFailure(); afterChange(); }
    }

    // The window opened again: its subfolders start at Right here (they
    // last one window); the link, the lookup and the edits stay. Not while
    // the last window's add is starting: it goes where it was sent.
    function sheetOpened() {
      if (!folder || s.starting) { return; }
      const was = s.sub !== 'here' || s.subCustom !== '';
      s.sub = 'here';
      s.subCustom = '';
      s.subOpen = false;
      if (was) { dropFailure(); afterChange(); }
    }

    function sameChoice(a, b) {
      if (!a || !b) { return false; }
      return a.kind === b.kind && a.library === b.library && str(a.layout) === str(b.layout) && str(a.base) === str(b.base);
    }

    // "Use for this song": the choice holds for the card's video only. The
    // remembered one is no one-off: it drops a one-off in force instead.
    // (In the window the folder on screen is what a one-off gives way to:
    // picking it again is Right here.)
    function useForThisSong(c) {
      if (!c) { return; }
      if (folder && sameChoice(c, folderChoice(folder, ''))) { s.just = null; s.justFor = null; s.sub = 'here'; }
      else if (!folder && sameChoice(c, remembered())) { s.just = null; s.justFor = null; }
      else { s.just = Object.assign({}, c); s.justFor = s.url; }
      dropFailure();
      afterChange();
    }

    // "Save": remembered for the server and account; a one-off goes.
    function saveChoice(c) {
      if (!c) { return; }
      if (e.prefs && typeof e.prefs.setChoice === 'function') { e.prefs.setChoice(c); }
      s.just = null;
      s.justFor = null;
      dropFailure();
      afterChange();
    }

    // A folder for this song (the window folds its radios away).
    function useFolder(directory) {
      s.subOpen = false;
      useForThisSong(folderChoice(directory));
    }

    // "Save to Music › Daft Punk instead": the deepest folder that listed.
    function saveToDeepest() {
      if (s.check.deepest) { useFolder(s.check.deepest); }
    }

    // ── the new-folder check ──

    function resetCheck(dir) {
      s.check = { state: dir ? 'checking' : 'idle', dir: dir || null, newSegments: [], deepest: null, files: null };
    }

    function scheduleCheck() {
      const t = target();
      const dir = s.url && t.valid ? t.directory : null;
      if (dir === s.check.dir) { return; }
      // A 409 was about the folder it named: another folder may take it.
      if (refused()) { dropFailure(); }
      const rid = ++checkRid;
      if (checkTimer) { timers.clearTimeout(checkTimer); checkTimer = null; }
      checking = null;
      resetCheck(dir);
      if (!dir) { return; }
      checkTimer = timers.setTimeout(() => {
        checkTimer = null;
        checking = runCheck(rid, t);
      }, CHECK_AFTER_MS);
    }

    // A check that broke — or found no answer in CHECK_BOUND_MS — checked
    // nothing: unknown (made first when the account may, refused under
    // noMkdir), never a hang.
    function runCheck(rid, t) {
      const list = (dir) => e.api.list(dir);
      const unknown = () => {
        if (disposed || rid !== checkRid) { return; }
        s.check = { state: 'unknown', dir: t.directory, newSegments: [], deepest: null, files: null };
      };
      let bound = null;
      const late = new Promise((resolve) => { bound = timers.setTimeout(() => { bound = null; resolve(LATE); }, CHECK_BOUND_MS); });
      const done = () => { if (bound) { timers.clearTimeout(bound); bound = null; } };
      const found = C.checkFolders({ target: t, list, stale: () => disposed || rid !== checkRid, shown });
      return Promise.race([found, late]).then((f) => {
        done();
        if (f === LATE) { unknown(); return; }
        if (!f || disposed || rid !== checkRid) { return; }
        s.check = { state: f.state, dir: t.directory, newSegments: f.newSegments.slice(), deepest: f.deepest, files: f.files };
      }, () => { done(); unknown(); });
    }

    // The check for the path now, at once (the add waits for it).
    function checkNow() {
      if (checking) { return checking; }
      if (checkTimer) { timers.clearTimeout(checkTimer); checkTimer = null; }
      const t = target();
      checking = runCheck(checkRid, t);
      return checking;
    }

    function checkedFor(directory) {
      return s.check.dir === directory && (s.check.state === 'known' || s.check.state === 'unknown');
    }

    // Until the check answered for the target as it is now — a lookup
    // answer or a tag typed during "Adding…" moves it, and the add never
    // posts into a path it did not check. False when it kept moving.
    async function awaitCheck() {
      for (let i = 0; i < 4; i++) {
        const t = target();
        if (!t.valid) { return false; }
        if (checkedFor(t.directory)) { return true; }
        if (s.check.dir !== t.directory) { scheduleCheck(); }
        await checkNow();
        if (disposed) { return false; }
      }
      const t = target();
      return t.valid && checkedFor(t.directory);
    }

    // After a folder-make ran (it may have made some, whatever its answer):
    // the path listed again, what it found standing until a listing answers.
    function recheck() {
      const t = target();
      if (!s.url || !t.valid || s.check.dir !== t.directory) { return; }
      const rid = checkRid;
      C.checkFolders({ target: t, list: (dir) => e.api.list(dir), stale: () => disposed || rid !== checkRid, shown }).then((found) => {
        if (!found || found.state !== 'known' || disposed || rid !== checkRid) { return; }
        s.check = { state: found.state, dir: t.directory, newSegments: found.newSegments.slice(), deepest: found.deepest, files: found.files };
      }, () => {});
    }

    function mayNotMkdir() { return store.server.noMkdir === true || store.mkdirRefused === true; }

    // (never the window's Right here: the folder on screen needs none made)
    function mkdirBlocked() {
      return mayNotMkdir() && !rightHere() && s.check.dir === target().directory && (s.check.newSegments.length > 0 || s.check.state === 'unknown');
    }

    // ── format ──

    function formats() { return C.formatOptions(store.server.supported); }
    function format() { return C.effectiveFormat(store.format, store.server.supported); }

    function setFormat(codec) {
      if (e.prefs && typeof e.prefs.setFormat === 'function') { e.prefs.setFormat(codec); }
      dropFailure();
      afterChange();
    }

    // ── add ──

    function dropFailure() { s.addFailure = null; s.failedCodec = null; }

    function alreadyAdding(t) {
      const tr = tracker();
      void store.tick;
      return !!(s.url && t.valid && tr && tr.isAddingTo(t.directory, s.url));
    }

    function block() {
      const t = target();
      return C.addBlock({
        convertOff: store.server.convertOff === true,
        link: parse(),
        lookup: s.lookup === 'idle' && s.url ? 'loading' : s.lookup,
        manual: s.manual,
        uploadsOff: store.server.uploadsOff === true || s.uploadsRefused,
        starting: s.starting,
        alreadyAdding: alreadyAdding(t),
        targetValid: t.valid,
        year: s.fields.year,
        mkdirBlocked: mkdirBlocked(),
      });
    }

    // A 409 stands until the format or the folder changes: the same add
    // would be refused the same way.
    function refused() { return !!s.addFailure && s.addFailure.problem === 'exists'; }

    // Add to library. Waits for the new-folder check, then the tracker
    // makes the folder (one new or unknown, and the account may make
    // folders) and posts the add. True when the server took it (or may
    // have: an add with no answer is looked for) — the card clears for the
    // next link; the remembered choice stays. A failure shows inline while
    // the panel shows this link, else it is a Needs a look row and a toast.
    async function add() {
      if (disposed || s.starting || block() !== 'none' || refused()) { return false; }
      const tr = tracker();
      if (!tr) { return false; }
      s.starting = true;
      dropFailure();
      const checked = await awaitCheck();
      if (disposed) { return false; }
      s.starting = false;
      const t0 = target();
      const here = rightHere();
      if (block() !== 'none' || (!checked && !here && mayNotMkdir()) || !t0.valid) { afterChange(); return false; }
      const url = s.url;
      const t = t0;
      const codec = format();
      const fresh = s.check.newSegments;
      const makeFolder = !here && !mayNotMkdir() && (fresh.length > 0 || s.check.state === 'unknown' || !checked);
      const firstNew = fresh.length ? Math.min.apply(null, fresh) : null;
      const meta = s.meta;
      s.starting = true;
      s.startingKey = `${url}\n${t.directory}`;
      const outcome = await tr.add({
        url,
        directory: t.directory,
        codec,
        metadata: { title: s.fields.title, artist: s.fields.artist, album: s.fields.album, year: s.fields.year },
        title: displayTitle(),
        crumbs: t.crumbs,
        cover: meta && meta.thumbnail ? meta.thumbnail : undefined,
        fileName: meta && meta.fileStem ? C.fileNameFor(meta.fileStem, codec) : undefined,
        mkdir: makeFolder ? true : undefined,
        mkdirFolder: makeFolder && firstNew != null && firstNew < t.segments.length ? t.segments[firstNew] : undefined,
        inline: () => attached && !disposed && s.url === url,
      });
      s.starting = false;
      s.startingKey = null;
      if (disposed) { return !!(outcome && (outcome.ok || outcome.unsure)); }
      if (outcome && (outcome.ok || outcome.unsure)) {
        if (s.url === url) { resetAfterSend(); }
        else {
          if (s.justFor === url) { s.just = null; s.justFor = null; }
          afterChange();
        }
        return true;
      }
      const f = outcome ? outcome.failure : null;
      if (f) {
        if (f.problem === 'uploadsOff') { s.uploadsRefused = true; }
        if (f.problem === 'mkdirOff') { store.mkdirRefused = true; }
        if (f.problem === 'badFormat' && e.prefs && typeof e.prefs.clearFormat === 'function') { e.prefs.clearFormat(); }
        // The phone re-pings on these: the entries hide when the server
        // says so, and this card stays with Add off (spec §8).
        if (['uploadsOff', 'ffmpegNotReady', 'badFormat', 'libraryGone'].indexOf(f.problem) !== -1 && typeof e.recheck === 'function') {
          try { e.recheck(f.problem); } catch (_) { /* the card says it anyway */ }
        }
      }
      // The folder-make ran: the folders may be there now.
      if (makeFolder) { recheck(); }
      if (f && !(outcome && outcome.job) && s.url === url) {
        s.addFailure = f;
        s.failedCodec = codec;
      }
      afterChange();
      return false;
    }

    function resetAfterSend() {
      s.link = '';
      s.url = null;
      resetCard();
      s.just = null;
      s.justFor = null;
      s.sub = 'here';
      s.subCustom = '';
      s.subOpen = false;
      afterChange();
    }

    // Everything that belongs to one video.
    function resetCard() {
      clearLookupTimers();
      abortLookup();
      lookupRid++;
      s.lookup = 'idle';
      s.lookupFailure = null;
      s.meta = null;
      s.guess = C.GUESS_NONE;
      s.late = null;
      s.manual = false;
      s.restored = [];
      s.swapped = false;
      s.stripRestored = false;
      for (const f of C.FIELDS) { s.fields[f] = ''; s.edited[f] = false; }
      dropFailure();
    }

    // Something changed: a path that moved is checked again (600 ms after
    // it settles).
    function afterChange() {
      if (disposed) { return; }
      scheduleCheck();
    }

    // ── what the panel draws ──
    // Everything the card shows for the state as it is, in the boards'
    // terms (WebPanelStates) → see the returned object. Pure over the
    // draft and the store.
    function model() {
      void store.tick;
      void store.lang;
      const server = store.server;
      const link = parse();
      const video = link.kind === 'video';
      const t = target();
      const codec = format();
      const opts = formats();
      const g = s.guess;
      const gs = guessState();
      const lookup = s.lookup === 'idle' && s.url ? 'loading' : s.lookup;
      const failedLookup = ['failed', 'timedOut', 'ytdlpMissing', 'offline', 'unreachable'].indexOf(lookup) !== -1;

      let phase = 'empty';
      if (video) {
        if (s.manual || lookup === 'found' || lookup === 'failed') { phase = 'card'; }
        else if (lookup === 'slow') { phase = 'slow'; }
        else if (lookup === 'loading') { phase = 'reading'; }
        else { phase = lookup; }
      }

      const shown = new Set();
      const lookupLine = video && failedLookup && s.lookupFailure ? {
        label: C.failureLabel(s.lookupFailure, { surface: 'lookup', server: server.name }),
        tone: lookup === 'offline' ? 'muted' : 'warn',
        retry: lookup === 'timedOut' || lookup === 'unreachable',
      } : null;
      if (lookupLine) { shown.add(lookupLine.label.key); }

      const gv = C.guessView(g, gs, s.edited.artist);
      const source = C.sourceLine(g, gs);
      const cleaned = gv.cleaned ? C.cleanedLabel(g) : null;
      const showSource = !!source && !(cleaned && source.tone !== 'warn');

      const fresh = s.check.dir === t.directory && s.check.state === 'known' ? s.check.newSegments : [];
      const crumbs = C.crumbItems(t, fresh);
      const listed = s.check.dir === t.directory && s.check.state === 'known' && s.check.newSegments.length === 0 ? s.check.files : null;
      const nc = s.meta ? C.nameCheck({ title: s.meta.title, fileStem: s.meta.fileStem, codec, files: listed }) : null;

      const b = block();
      let noMkdir = null;
      if (mkdirBlocked()) {
        const first = fresh.length ? t.segments[Math.min.apply(null, fresh)] : null;
        noMkdir = {
          label: first != null ? label('ytdl.noMkdir.new', { folder: first }) : label('ytdl.noMkdir.unchecked'),
          deepest: s.check.deepest ? crumbsOf(s.check.deepest) : null,
        };
        shown.add(noMkdir.label.key);
      }

      let failure = null;
      if (s.addFailure && s.addFailure.problem !== 'mkdirOff') {
        const p = s.addFailure.problem;
        failure = {
          label: C.failureLabel(s.addFailure, { surface: 'panel', server: server.name, codec: s.failedCodec }),
          changeFormat: (p === 'exists' || p === 'badFormat') && opts.length > 1,
        };
        shown.add(failure.label.key);
      }
      const clash = !failure && nc && nc.line && nc.line.tone === 'warn' ? { label: nc.line.label, changeFormat: opts.length > 1 } : null;
      const letters = nc && nc.line && nc.line.tone === 'note' ? nc.line.label : null;

      // The window's subfolders: the radios and Custom's own line (which
      // says what "Fix the layout" would).
      let sub = null;
      if (folder) {
        const typed = s.sub === 'custom' && s.subCustom.trim() !== '';
        const error = typed ? C.layoutProblem(C.layoutCheck(s.subCustom)) : null;
        sub = {
          open: s.subOpen && !s.just,
          kind: s.sub,
          custom: s.subCustom,
          error,
          // Custom left empty: the folder itself, nothing under it yet
          crumbs: subRefused() && !typed ? C.crumbItems(C.folderTarget({ currentPath: folder, layout: '', tags: tags() }), []) : crumbs,
          fix: typed && !t.valid,
        };
      }

      let reason = C.blockLabel(b, { server: server.name });
      if (reason && shown.has(reason.key)) { reason = null; }
      if (reason && b === 'invalidLayout' && subRefused()) { reason = null; }

      const help = s.focused ? {
        field: s.focused,
        label: C.fieldHelp(s.focused, { guess: g, state: gs, edited: C.FIELDS.filter((f) => s.edited[f]), value: s.fields[s.focused], lookupAlbum: s.meta && s.meta.album }),
      } : null;

      return {
        phase,
        notes: C.linkNotes(link, s.meta),
        lookupLine,
        late: !!s.late,
        thumb: s.meta && s.meta.thumbnail ? s.meta.thumbnail : null,
        blankThumb: !s.meta,
        source: showSource ? source : null,
        artistWarn: !!source && source.tone === 'warn' && !s.edited.artist,
        cleaned,
        chips: gv.chips.filter((c) => c.kind === 'noise'),
        canUndoAll: gv.canUndoAll,
        help,
        crumbs,
        trap: t.valid && t.trap ? C.trapLabel(t.trap) : null,
        letters,
        noMkdir,
        failure,
        clash,
        reason,
        block: b,
        formats: opts,
        format: codec,
        sub,
        primary: {
          // the window's Right here reads "Add here"; into subfolders (or a
          // folder picked for this song) "Add to library", as the panel
          label: C.addButtonLabel({ surface: rightHere() ? 'window' : 'panel', clash: !!clash, starting: s.starting }),
          // conversion off too: the button stays, off, the reason over it
          // (a lost right inside a flow, spec §2)
          disabled: s.starting || b !== 'none' || refused(),
          busy: s.starting,
        },
        target: t,
      };
    }

    // The panel shows this draft: its failures show inline. A lookup that
    // found no connection runs again when it comes back.
    function attach() {
      attached = true;
      if (noConnection()) { retryLookup(); }
    }
    function detach() { attached = false; }
    function onOnline() { if (attached && noConnection()) { retryLookup(); } }

    function dispose() {
      disposed = true;
      clearLookupTimers();
      abortLookup();
      if (checkTimer) { timers.clearTimeout(checkTimer); checkTimer = null; }
    }

    return {
      s, store,
      setLink, clear, retryLookup, enterManually, useLate,
      setField, setFocus, restore, undoAll,
      tags, displayTitle, choice, remembered, targetFor, target, folderChoice, sameChoice,
      useForThisSong, saveChoice, useFolder, saveToDeepest, mayNotMkdir,
      folder, rightHere, setSub, setSubCustom, openSub, sheetOpened,
      formats, format, setFormat,
      add, block, model, afterChange, checkNow,
      attach, detach, onOnline, dispose,
      get attached() { return attached; },
    };
  }

  // ── the lists, the windows' forms ──────────────────────────────────────

  // The panel's Adding and Needs a look rows and the Added view, from the
  // tracker → { adding, needsLook, added }. ctx: { now, server, formats,
  // hold } — `hold` is the url + folder of the add the card is starting:
  // its row stays out of Adding while the card's own "Adding…" says it.
  function listsView(tr, ctx) {
    const c = ctx || {};
    if (!tr) { return { adding: [], needsLook: [], added: { rows: [], loaded: false, loading: false, failed: false, canShowEarlier: false, cursor: null } }; }
    const rowCtx = { now: c.now, server: c.server, formats: c.formats };
    const l = tr.lists();
    const adding = l.adding.filter((j) => !(c.hold && j.state === 'starting' && `${j.url}\n${j.directory}` === c.hold));
    return {
      adding: adding.map((j) => rowView(j, tr.row(j, rowCtx))),
      needsLook: l.needsLook.map((j) => rowView(j, tr.row(j, rowCtx))),
      added: tr.addedView(),
    };
  }

  // Where "Choose a folder" opens for the card: the deepest folder on the
  // song's path that listed, else the folder the choice in force names,
  // else its library.
  function chooseStart(d) {
    if (d.s.check.deepest) { return d.s.check.deepest; }
    const c = d.choice();
    return c.kind === 'folder' ? dirOf([c.library].concat(crumbsOf(c.base))) : dirOf([c.library].filter(Boolean));
  }

  // "Where new songs land" as a form: { opening, kind, library, custom }.
  // It opens on the choice in force (a just-this-song one too), unless that
  // is a folder ("Save to … instead", "Choose a folder…"), which no layout
  // names: the remembered one then.
  function whereOpen(current, remembered) {
    const open = current && current.kind !== 'folder' ? current : remembered;
    return {
      opening: open,
      kind: open.kind,
      library: open.kind === 'discover' ? remembered.library : open.library,
      custom: open.kind === 'custom' ? str(open.layout) : '',
    };
  }

  // The choice the form holds. Same as Discover and Library layout before
  // the destination view answered: the remembered copy it opened on.
  function whereChoice(form, view, saved) {
    const choices = core().layoutChoices({ view, library: form.library, saved });
    const c = choices.find((x) => x.kind === form.kind);
    if (c && c.kind !== 'custom') { return { kind: c.kind, library: c.library, layout: c.layout, base: c.base }; }
    const o = form.opening || {};
    if (!c && form.kind === o.kind && form.kind !== 'custom' && !view) {
      return { kind: o.kind, library: o.library, layout: str(o.layout), base: str(o.base) };
    }
    return { kind: 'custom', library: form.library, layout: form.custom, base: '' };
  }

  // Everything the window shows for the form → { choices, choice,
  // customError, target, valid, canSave, canUse, lockedLibrary }.
  // ctx: { view, saved, draft } — Save is a change from what this browser
  // remembers (or makes a one-off stick); Use for this song a change from
  // what the card has now (the phone's canSave / canUse).
  function whereState(form, ctx) {
    const c = ctx || {};
    const d = c.draft;
    const choices = core().layoutChoices({ view: c.view, library: form.library, saved: c.saved });
    const choice = whereChoice(form, c.view, c.saved);
    const check = form.kind === 'custom' && form.custom !== '' ? core().layoutCheck(form.custom) : null;
    const target = d.targetFor(choice);
    const empty = form.kind === 'custom' && form.custom.trim() === '';
    const valid = !empty && (!check || check.valid) && target.valid;
    const d0 = core().discoverPreset(c.view);
    return {
      choices,
      choice,
      customError: check ? core().layoutProblem(check) : null,
      target,
      valid,
      canSave: valid && (!d.sameChoice(choice, d.remembered()) || !!d.s.just),
      canUse: valid && !d.sameChoice(choice, d.choice()),
      lockedLibrary: form.kind === 'discover' && d0 ? d0.vpath : null,
    };
  }

  // A library picked: a library's own layout leaving with it stays the
  // layout, in Custom's field (the Discover editor does the same).
  function wherePickLibrary(form, vpath, view, saved) {
    const before = core().libraryTemplate(view, form.library, saved);
    const next = Object.assign({}, form, { library: vpath });
    if (form.kind === 'library' && core().libraryTemplate(view, vpath, saved) == null && before != null) {
      next.kind = 'custom';
      next.custom = before;
    }
    return next;
  }

  // A layout picked: Custom opens holding the layout chosen until now when
  // nothing was typed in it.
  function wherePickLayout(form, kind, view, saved) {
    const next = Object.assign({}, form, { kind });
    if (kind === 'custom' && form.custom === '') {
      const was = whereChoice(form, view, saved);
      if (str(was.layout) !== '') { next.custom = was.kind === 'discover' ? core().choiceToSave(was).layout : was.layout; }
    }
    return next;
  }

  // ── the explorer: its strip, the re-list, a paste, the toasts ──────────

  // '/Music/Daft Punk/', 'Music/Daft Punk' → '/music/daft punk/': folders
  // compare as the tracker's jobsUnder does, by whole names, ignoring case.
  function folderKey(p) { return dirOf(crumbsOf(p)).toLowerCase(); }

  function titleOf(job) {
    const j = job || {};
    return str(j.title).trim() || str(j.fileName) || str(j.url);
  }

  // The strip under the explorer bar, for the jobs into the folder on
  // screen or below it (the tracker's jobsUnder): only while one runs —
  // "Adding “One More Time”…", "Adding 2 songs…" → label, or null. A
  // failure there is the toast's and the panel's to say (WebWindow: "Only
  // while a job into this folder runs").
  function stripView(list) {
    const open = (Array.isArray(list) ? list : []).filter((j) => j && !j.hidden && jobs().OPEN.indexOf(j.state) !== -1);
    if (!open.length) { return null; }
    return open.length === 1 ? label('ytdl.strip.adding', { title: titleOf(open[0]) }) : label('ytdl.strip.addingCount', { count: open.length });
  }

  // A settled job asks the folder on screen to list again when the song
  // went into it or below it.
  function relistWanted(shownFolder, directory) {
    if (!crumbsOf(shownFolder).length || directory == null) { return false; }
    return folderKey(directory).startsWith(folderKey(shownFolder));
  }

  // A listing's row names (directories, then files) — or the explorer's
  // currentBrowsingList as it stood ({ name } rows).
  function listingNames(listing) {
    const l = listing || {};
    const name = (x) => (typeof x === 'string' ? x : x && typeof x.name === 'string' ? x.name : null);
    if (Array.isArray(l)) { return l.map(name).filter((n) => n != null); }
    return [].concat(Array.isArray(l.directories) ? l.directories : [], Array.isArray(l.files) ? l.files : []).map(name).filter((n) => n != null);
  }

  // What the re-list brought: the names in `after` that `before` lacked
  // (ignoring case, as the folder check does).
  function newRows(before, after) {
    const had = new Set(listingNames(before).map((n) => n.toLowerCase()));
    return listingNames(after).filter((n) => !had.has(n.toLowerCase()));
  }

  // The row the re-list rings for an added job (the phone's _rowFor), in
  // the explorer's own words so the page finds it by equality:
  //   { kind: 'file', value }  value = the row's data-file_location (the
  //     listing's file.path, else its path + name) — the song's own file,
  //     named by the job (filePath, else its predicted name);
  //   { kind: 'dir', value }   value = the row's data-directory — the
  //     subfolder it went into, only when the re-list brought it;
  //   null: nothing listed matches (nothing is ringed).
  // ctx: { folder (on screen), job, before (the rows listed before), after
  // (the new listing) }.
  function ringTarget(ctx) {
    const c = ctx || {};
    const job = c.job || {};
    const after = c.after || {};
    const here = crumbsOf(c.folder);
    const there = crumbsOf(job.directory);
    if (!here.length || !relistWanted(c.folder, job.directory)) { return null; }
    if (there.length > here.length) {
      const name = there[here.length];
      if (newRows(c.before, { directories: [name] }).length === 0) { return null; }
      const dir = listingNames({ directories: after.directories }).find((n) => n.toLowerCase() === name.toLowerCase());
      return dir ? { kind: 'dir', value: dir } : null;
    }
    const key = (p) => crumbsOf(p).join('/').toLowerCase();
    const wanted = key(job.filePath ? job.filePath : (job.fileName ? `${here.join('/')}/${job.fileName}` : ''));
    if (!wanted) { return null; }
    for (const f of Array.isArray(after.files) ? after.files : []) {
      if (!f || typeof f.name !== 'string') { continue; }
      const value = f.path || str(after.path) + f.name;
      if (key(value) === wanted) { return { kind: 'file', value }; }
    }
    return null;
  }

  // A paste's target takes the text itself: an input, a textarea, a
  // select, or anything editable.
  function isField(target) {
    let el = target;
    if (el && el.nodeType === 3) { el = el.parentNode; }
    if (!el || typeof el.tagName !== 'string') { return false; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true) { return true; }
    return typeof el.closest === 'function' && el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
  }

  // What a paste outside a field does (decision 5) → null (left alone), or
  // { to: 'window', folder, link } / { to: 'panel', link }: a YouTube link
  // (a video — or a playlist, which the card then explains) opens Add from
  // YouTube with it filled in: the window over a writable explorer folder,
  // the panel anywhere else; the window or the panel already up takes it
  // in place. ctx: { text, field (isField), blocked (another window or a
  // modal is up), allowed (the gate, on this server), folder (the writable
  // folder on screen, else null), panel (the panel shows), win (the
  // YouTube window open: { mode, folder }, else null) }. The field gets
  // the pasted words as they are — the link alone when they hold more.
  function pasteAction(ctx) {
    const c = ctx || {};
    if (c.field || c.blocked || !c.allowed) { return null; }
    const text = str(c.text).trim();
    const link = core().parseLink(text);
    if (link.kind !== 'video' && link.kind !== 'playlist') { return null; }
    const fill = /\s/.test(text) && link.url ? link.url : text;
    const w = c.win;
    if (w) { return w.mode === 'here' && w.folder ? { to: 'window', folder: w.folder, link: fill } : null; }
    if (c.panel) { return { to: 'panel', link: fill }; }
    if (c.folder) { return { to: 'window', folder: c.folder, link: fill }; }
    return { to: 'panel', link: fill };
  }

  // The toast for an add this tab started (the tracker's onToast) →
  // { tone: 'success' | 'warning', label, details: the button's words or
  // null }, or null: "Added “One More Time” to Daft Punk › Discovery";
  // "Couldn't add “Around the World”" with Details (the panel).
  function toastView(job) {
    const l = jobs().toastLabel(job);
    if (!l) { return null; }
    const ok = !!job && job.state === 'added';
    return { tone: ok ? 'success' : 'warning', label: l, details: ok ? null : label('ytdl.toast.details') };
  }

  // Every key this file uses itself (the locale test holds en.json to it;
  // ytdl-core's and ytdl-jobs' own are in their KEYS).
  const KEYS = Object.freeze([
    'nav.addFromYoutube', 'panel.addFromYoutube',
    'ytdl.close', 'ytdl.retry',
    'ytdl.link.label', 'ytdl.link.placeholder', 'ytdl.link.clear',
    'ytdl.lookup.reading', 'ytdl.lookup.readingAria', 'ytdl.lookup.slow', 'ytdl.lookup.enterYourself',
    'ytdl.late.found', 'ytdl.late.useThem', 'ytdl.late.editsStay',
    'ytdl.field.title', 'ytdl.field.artist', 'ytdl.field.album', 'ytdl.field.year',
    'ytdl.putBack', 'ytdl.undoAll', 'ytdl.savesTo', 'ytdl.newTag', 'ytdl.change',
    'ytdl.format.label', 'ytdl.format.aria',
    'ytdl.noMkdir.saveInstead', 'ytdl.noMkdir.choose',
    'ytdl.list.adding', 'ytdl.list.addingNote', 'ytdl.list.needsLook', 'ytdl.list.added', 'ytdl.list.showEarlier',
    'ytdl.row.addingAria', 'ytdl.row.startingAria', 'ytdl.row.changeFormatRetry', 'ytdl.row.checkAgain', 'ytdl.row.addAgain',
    'ytdl.row.dismiss', 'ytdl.row.fileMissing', 'ytdl.row.more', 'ytdl.row.addToQueue', 'ytdl.row.showInFolder',
    'ytdl.pill.adding', 'ytdl.pill.needsLook', 'ytdl.pill.added',
    'ytdl.where.title', 'ytdl.where.landsAt', 'ytdl.where.landsAtSample', 'ytdl.where.library', 'ytdl.where.layout', 'ytdl.where.customField',
    'ytdl.where.insert', 'ytdl.where.insertArtist', 'ytdl.where.insertAlbumArtist', 'ytdl.where.insertAlbum', 'ytdl.where.insertYear',
    'ytdl.where.used', 'ytdl.where.kept', 'ytdl.where.useOnce', 'ytdl.where.save', 'ytdl.where.noMkdir',
    'ytdl.choose.title', 'ytdl.choose.sub', 'ytdl.choose.group', 'ytdl.choose.up', 'ytdl.choose.empty', 'ytdl.choose.failed',
    'ytdl.choose.loading', 'ytdl.choose.use',
    'ytdl.into', 'ytdl.sort.open', 'ytdl.sort.customField',
    'ytdl.strip.adding', 'ytdl.strip.addingCount', 'ytdl.strip.seeAll', 'ytdl.toast.details',
  ]);

  const pure = {
    KEYS, ACTION_KEYS, PILL_KEYS,
    LOOKUP_DEBOUNCE_MS, SLOW_AFTER_MS, LOOKUP_BOUND_MS, CHECK_AFTER_MS, CHECK_BOUND_MS, MAX_ADDING_MINUTES,
    prefKeys, readPrefs, writeChoice, writeFormat,
    clampAdding, rowView, addedFacts, pillView, splitAround, crumbLine, librariesFor, saidOf,
    createStore, createDraft,
    listsView, chooseStart, whereOpen, whereChoice, whereState, wherePickLibrary, wherePickLayout,
    stripView, relistWanted, listingNames, newRows, ringTarget, isField, pasteAction, toastView,
  };

  // ── the browser ────────────────────────────────────────────────────────
  // Nothing below runs on node (no Vue there): the tests take `pure`.
  if (typeof Vue === 'undefined' || typeof document === 'undefined') { return pure; }

  const store = Vue.observable(createStore());
  let tracker = null;
  let scope = null;
  let panelDraft = null;
  let panelVm = null;
  let winVm = null;
  let winOpener = null;
  let winJob = null;
  let clockTimer = null;
  let viewAsked = false;
  const drafts = new Set();

  function tt(key, params) {
    void store.lang;
    return (typeof t === 'function') ? t(key, params) : key;
  }
  function tl(l) { return l ? tt(l.key, l.params) : ''; }
  function safeStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
  }

  // A choice made before the account is known (the panel opened while
  // /api was still answering) is held here, never under an empty scope,
  // and kept for the account once start() knows it.
  let unscoped = { choice: false, format: false };
  const prefs = {
    setChoice(c) {
      if (scope) { writeChoice(safeStorage(), scope, c); } else { unscoped.choice = true; }
      const saved = core().choiceToSave(c);
      store.saved = { library: saved.library, layout: saved.layout, kind: saved.kind };
      touch();
    },
    setFormat(codec) {
      if (scope) { writeFormat(safeStorage(), scope, codec); } else { unscoped.format = true; }
      store.format = codec || null;
      touch();
    },
    clearFormat() {
      if (scope) { writeFormat(safeStorage(), scope, null); } else { unscoped.format = true; }
      store.format = null;
      touch();
    },
  };

  // The store moved under the drafts (the server's facts, the view, a
  // remembered choice): each checks its path again.
  function touch() { drafts.forEach((d) => d.afterChange()); }

  // A draft wired to this page: the panel's, or (`folder`) the explorer
  // window's for that folder — which reads the explorer's own rows when
  // the folder won't list (m.js ytdlShownNames).
  function newDraft(folder) {
    const d = createDraft({
      store,
      api: {
        metadata: (url, o) => MSTREAMAPI.ytdlMetadata(url, o),
        list: (dir) => MSTREAMAPI.dirparser(dir),
      },
      tracker: () => tracker,
      prefs,
      recheck: (problem) => { if (typeof ytdlRecheck === 'function') { ytdlRecheck(problem); } },
      online: () => (typeof navigator === 'undefined' || navigator.onLine !== false),
      observe: (o) => Vue.observable(o),
      folder: folder || null,
      shown: (dir) => (typeof ytdlShownNames === 'function' ? ytdlShownNames(dir) : null),
    });
    drafts.add(d);
    return d;
  }

  // The explorer window's drafts, one per folder for the session (the
  // phone's): leaving a folder and coming back finds the link, the lookup
  // and the edits as they were. The oldest idle ones go past a dozen.
  const FOLDER_DRAFTS_KEPT = 12;
  const folderDrafts = new Map();
  function getFolderDraft(folder) {
    const key = dirOf(crumbsOf(folder));
    let d = folderDrafts.get(key);
    if (d) { folderDrafts.delete(key); folderDrafts.set(key, d); return d; }
    d = newDraft(key);
    folderDrafts.set(key, d);
    for (const [k, old] of folderDrafts) {
      if (folderDrafts.size <= FOLDER_DRAFTS_KEPT) { break; }
      if (old === d || old.attached || old.s.starting) { continue; }
      old.dispose();
      drafts.delete(old);
      folderDrafts.delete(k);
    }
    return d;
  }

  // "Same as Discover" and "Library layout": the account's destination
  // view, read once per session, best effort (never written).
  function askView() {
    if (viewAsked || typeof MSTREAMAPI === 'undefined' || typeof MSTREAMAPI.discoveryDestination !== 'function') { return; }
    viewAsked = true;
    Promise.resolve(MSTREAMAPI.discoveryDestination()).then((v) => {
      if (v && typeof v === 'object') { store.view = v; touch(); }
    }).catch(() => { viewAsked = false; });
  }

  // ── the pill ──

  const PILL_GLYPHS = {
    adding: '<path d="M12 5v13"/><path d="M6.5 12.5 12 18l5.5-5.5"/>',
    failed: '<path d="M12 4.5v9.5"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
    added: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  function renderPill() {
    const pill = document.getElementById('nav-ytdl-pill');
    const sr = document.getElementById('nav-ytdl-sr');
    if (!pill || !sr) { return; }
    const v = tracker ? pillView(tracker.summary()) : null;
    if (!v) {
      pill.classList.add('super-hide');
      pill.innerHTML = '';
      sr.textContent = '';
      return;
    }
    pill.className = `nav-ytdl-pill is-${v.kind}`;
    pill.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PILL_GLYPHS[v.kind]}</svg>${v.count}`;
    sr.textContent = tl(v.sr);
  }

  // ── icons ──
  // The boards' stroke icons (24-unit, currentColor): [stroke width, inner].
  const ICONS = {
    close: [2, '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'],
    check: [2.2, '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
    warn: [2, '<path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>'],
    err: [2, '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>'],
    info: [2, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5h.01"/>'],
    wand: [1.9, '<path d="M4 20 15 9"/><path d="M13.5 7.5l3 3"/><path d="M18.5 3v3"/><path d="M17 4.5h3"/><path d="M20 11v2.5"/><path d="M18.75 12.25h2.5"/><path d="M8.5 3.5v2.5"/><path d="M7.25 4.75h2.5"/>'],
    undo: [2, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'],
    offline: [2, '<path d="M3 3l18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2.5 8.8a15 15 0 0 1 4-2.6"/><path d="M10.7 5c4-.4 8.1.9 11.3 3.8"/><path d="M16.9 11.3a10 10 0 0 1 2.2 1.7"/><path d="M5 13a10 10 0 0 1 5.2-2.8"/><path d="M12 20h.01"/>'],
    down: [2.2, '<path d="M6 9l6 6 6-6"/>'],
    up: [2, '<path d="M6 15l6-6 6 6"/>'],
    right: [2, '<path d="M9 6l6 6-6 6"/>'],
    question: [2, '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.4a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.1-2.5 3.7"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor" stroke="none"/>'],
    alert: [2, '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.6" r="1.1" fill="currentColor" stroke="none"/>'],
    more: [2, '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'],
    folder: [2, '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'],
  };
  Vue.component('yt-icon', {
    props: { name: { type: String, required: true }, size: { type: Number, default: 16 } },
    computed: {
      sw: function () { return (ICONS[this.name] || ICONS.close)[0]; },
      inner: function () { return (ICONS[this.name] || ICONS.close)[1]; },
    },
    template: '<svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="sw" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="yt-ic" v-html="inner"></svg>',
  });

  // A translated line with one param drawn on its own — a file name in
  // mono ("Something like “One_More_Time.mp3” looks to be …").
  Vue.component('yt-text', {
    props: { label: { type: Object, default: null }, param: { type: String, default: 'name' } },
    computed: { parts: function () { return splitAround(tt, this.label, this.param); } },
    template: '<span><template v-if="parts.length === 3">{{ parts[0] }}<span class="yt-mono">{{ parts[1] }}</span>{{ parts[2] }}</template><template v-else>{{ parts[0] }}</template></span>',
  });

  // Crumbs: Music › Daft Punk › Discovery NEW — the library first; a folder
  // that will be made wears NEW; a bracket trap's folder the warning tone.
  Vue.component('yt-crumbs', {
    props: { items: { type: Array, default: () => [] } },
    methods: { tt },
    template: `<span class="yt-crumbs"><template v-for="(c, i) in items"><span v-if="i > 0" :key="'s' + i" class="yt-sep" aria-hidden="true">›</span><span v-if="i > 0" :key="'r' + i" class="dm-sr">/</span><span :key="'c' + i" class="yt-crumb" :class="{ 'is-trap': c.trap }">{{ c.text }}<span v-if="c.isNew" class="dm-tag yt-new">{{ tt('ytdl.newTag') }}</span></span></template></span>`,
  });

  // A menu's keyboard (the format menu, a row's ⋯): Up / Down / Home / End
  // move between its items, Esc closes it and gives the button the focus
  // back, Tab closes it from the button (the browser's Tab then moves on
  // from there — its item is gone before a window's trap looks); a press
  // outside closes it.
  const menuMixin = {
    data: function () { return { open: false, flip: false }; },
    beforeDestroy: function () { this.unhookOutside(); },
    methods: {
      tt,
      items: function () { return this.$refs.menu ? Array.from(this.$refs.menu.querySelectorAll('[role^="menuitem"]')) : []; },
      openMenu: function (focusAt) {
        if (this.open) { return; }
        this.open = true;
        this.flip = false;
        this.$nextTick(() => {
          // Off the column's scroller (or the screen) its way: the other way.
          const menu = this.$refs.menu;
          if (menu && typeof menu.getBoundingClientRect === 'function') {
            const r = menu.getBoundingClientRect();
            const box = this.$el.closest('#filelist, .dmodal-shadow');
            const b = box && typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : null;
            const top = b ? Math.max(0, b.top) : 0;
            const bottom = Math.min(b ? b.bottom : Infinity, window.innerHeight || document.documentElement.clientHeight || Infinity);
            if (r.top < top || r.bottom > bottom) { this.flip = true; }
          }
          const list = this.items();
          if (!list.length) { return; }
          let at = typeof focusAt === 'number' ? focusAt : list.findIndex((el) => el.getAttribute('aria-checked') === 'true');
          if (at < 0) { at = focusAt === -1 ? list.length - 1 : 0; }
          list[Math.min(at, list.length - 1)].focus();
        });
        this.hookOutside();
      },
      closeMenu: function (focusButton) {
        if (!this.open) { return; }
        this.open = false;
        this.unhookOutside();
        if (focusButton && this.$refs.btn) { this.$refs.btn.focus(); }
      },
      toggle: function () { if (this.open) { this.closeMenu(true); } else { this.openMenu(); } },
      onMenuKey: function (e) {
        const list = this.items();
        const at = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
          if (list[next]) { list[next].focus(); }
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const el = e.key === 'Home' ? list[0] : list[list.length - 1];
          if (el) { el.focus(); }
        } else if (e.key === 'Escape') {
          // The menu, not the window under it.
          e.preventDefault();
          e.stopPropagation();
          this.closeMenu(true);
        } else if (e.key === 'Tab') {
          this.closeMenu(true);
        }
      },
      hookOutside: function () {
        if (this.outside) { return; }
        this.outside = (e) => { if (this.$el && !this.$el.contains(e.target)) { this.closeMenu(false); } };
        document.addEventListener('mousedown', this.outside, true);
        document.addEventListener('touchstart', this.outside, true);
      },
      unhookOutside: function () {
        if (!this.outside) { return; }
        document.removeEventListener('mousedown', this.outside, true);
        document.removeEventListener('touchstart', this.outside, true);
        this.outside = null;
      },
    },
  };

  // The format menu: "MP3 ▾" at the card's foot (opens upward), or a row's
  // "Change format and retry". Names and one help line; the menu's
  // header and footer are the phone's, cut here (decision 14).
  Vue.component('yt-format-menu', {
    mixins: [menuMixin],
    props: {
      value: { type: String, default: 'mp3' },
      options: { type: Array, default: () => [] },
      text: { type: Object, default: null },        // a row's trigger words
      up: { type: Boolean, default: false },
      disabled: { type: Boolean, default: false },
    },
    methods: {
      name: function (c) { return core().formatName(c); },
      help: function (c) { return tl(core().formatHelp(c)); },
      onButton: function () { if (!this.disabled) { this.toggle(); } },
      pick: function (c) {
        this.closeMenu(true);
        this.$emit('pick', c);
      },
    },
    template: `<div class="yt-fmt" :class="{ 'is-open': open }">
      <button ref="btn" type="button" class="dm-btn" :class="text ? 'yt-btn-sm' : 'yt-fmt-btn'" aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'"
        :aria-label="text ? null : tt('ytdl.format.aria', { format: name(value) })" :aria-disabled="disabled ? 'true' : null"
        @click="onButton" @keydown.down.prevent="openMenu()" @keydown.up.prevent="openMenu(-1)">
        <template v-if="text">{{ tt(text.key, text.params) }}</template>
        <template v-else>{{ name(value) }}<yt-icon name="down" :size="12"></yt-icon></template>
      </button>
      <div v-if="open" ref="menu" role="menu" class="yt-menu yt-fmt-menu" :class="(up !== flip) ? 'is-up' : 'is-down'" :aria-label="tt('ytdl.format.label')" @keydown="onMenuKey">
        <button v-for="c in options" :key="c" type="button" role="menuitemradio" :aria-checked="c === value ? 'true' : 'false'" class="yt-fmt-item" @click="pick(c)">
          <span class="yt-fmt-check"><yt-icon v-if="c === value" name="check" :size="14"></yt-icon></span>
          <span class="yt-fmt-text"><span class="yt-fmt-name">{{ name(c) }}</span><span v-if="help(c)" class="yt-fmt-help">{{ help(c) }}</span></span>
        </button>
      </div>
    </div>`,
  });

  // An Added row's ⋯: Add to queue · Show in folder.
  Vue.component('yt-more-menu', {
    mixins: [menuMixin],
    props: { title: { type: String, default: '' } },
    methods: {
      act: function (what) {
        this.closeMenu(what === 'queue');
        this.$emit(what);
      },
    },
    template: `<div class="yt-more" :class="{ 'is-open': open }">
      <button ref="btn" type="button" class="yt-more-btn" :aria-label="tt('ytdl.row.more', { title })" :title="tt('ytdl.row.more', { title })" aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'"
        @click="toggle" @keydown.down.prevent="openMenu(0)" @keydown.up.prevent="openMenu(-1)"><yt-icon name="more" :size="16"></yt-icon></button>
      <div v-if="open" ref="menu" role="menu" class="yt-menu yt-more-menu" :class="flip ? 'is-up' : 'is-down'" :aria-label="tt('ytdl.row.more', { title })" @keydown="onMenuKey">
        <button type="button" role="menuitem" class="yt-more-item" @click="act('queue')">{{ tt('ytdl.row.addToQueue') }}</button>
        <button type="button" role="menuitem" class="yt-more-item" @click="act('show')">{{ tt('ytdl.row.showInFolder') }}</button>
      </div>
    </div>`,
  });

  // An Adding or Needs a look row (rowView).
  Vue.component('yt-job-row', {
    props: { row: { type: Object, required: true }, busy: { type: Boolean, default: false }, formats: { type: Array, default: () => [] }, codec: { type: String, default: 'mp3' } },
    computed: {
      crumbText: function () { return crumbLine(this.row.crumbs); },
      thumbStyle: function () { return this.row.cover ? { backgroundImage: `url("${String(this.row.cover).replace(/["\\]/g, '')}")` } : null; },
      barLabel: function () { return tt(this.row.state === 'adding' ? 'ytdl.row.addingAria' : 'ytdl.row.startingAria', { title: this.row.title }); },
    },
    methods: {
      tt,
      act: function (name) { if (!this.busy) { this.$emit('act', name); } },
    },
    template: `<li v-if="row.section === 'adding'" class="ytp-row" :class="{ 'ytp-row-top': !row.wide }" data-yt-row>
        <div class="ytp-rthumb" aria-hidden="true" :style="thumbStyle"><template v-if="!row.cover"><i></i><b></b></template></div>
        <div class="ytp-rbody">
          <div class="ytp-rtitle">{{ row.title }}</div>
          <div class="ytp-rcrumbs"><span dir="ltr">{{ crumbText }}</span></div>
          <div v-if="!row.wide && row.status" class="ytp-rstatus">{{ tt(row.status.key, row.status.params) }}</div>
        </div>
        <div v-if="row.wide" class="ytp-rside">
          <span class="ytp-rstate">{{ row.status ? tt(row.status.key, row.status.params) : '' }}</span>
          <div class="yt-bar yt-bar-3" role="progressbar" :aria-label="barLabel"><i></i></div>
        </div>
        <div v-else class="ytp-rside ytp-rside-bar">
          <div class="yt-bar yt-bar-3" role="progressbar" :aria-label="barLabel"><i></i></div>
        </div>
      </li>
      <li v-else class="ytp-look" :class="{ 'ytp-look-inline': row.inline }" data-yt-row>
        <span class="ytp-look-ic" :class="'is-' + row.tone" aria-hidden="true"><yt-icon :name="row.glyph" :size="16"></yt-icon></span>
        <div class="ytp-rbody">
          <div class="ytp-rtitle">{{ row.title }}</div>
          <div class="ytp-rcrumbs"><span dir="ltr">{{ crumbText }}</span></div>
          <div v-if="row.status" class="ytp-rstatus"><yt-text :label="row.status"></yt-text></div>
        </div>
        <div v-if="row.actions.length" class="ytp-look-acts">
          <template v-for="a in row.actions">
            <yt-format-menu v-if="a.name === 'changeFormat'" :key="a.name" :value="row.codec || codec" :options="formats" :text="a.label" :disabled="busy" @pick="$emit('act', 'changeFormat', $event)"></yt-format-menu>
            <button v-else :key="a.name" type="button" class="dm-btn yt-btn-sm" :class="{ 'dm-btn-quiet': a.quiet, 'is-busy': busy && !a.quiet }" :aria-disabled="busy ? 'true' : null" :aria-haspopup="a.name === 'chooseFolder' ? 'dialog' : null" @click="act(a.name)">{{ tt(a.label.key, a.label.params) }}</button>
          </template>
        </div>
      </li>`,
  });

  // An Added row: a whole-row press plays it; ⋯ queues it or shows its
  // folder. A file the scanner no longer finds is a dim row, no button.
  Vue.component('yt-added-row', {
    props: { row: { type: Object, required: true } },
    computed: {
      playable: function () { return !!this.row.filepath && !this.row.missing; },
      crumbText: function () { return crumbLine(this.row.crumbs); },
      facts: function () {
        void store.now;
        if (!this.playable) { return tt('ytdl.row.fileMissing'); }
        return addedFacts(this.row, typeof discoverDownloadsAgo === 'function' ? discoverDownloadsAgo : null).join(' · ');
      },
      title: function () { return str(this.row.title).trim() || str(this.row.fileName); },
    },
    methods: {
      tt,
      play: function () {
        if (typeof queueRow !== 'function' || typeof MSTREAMPLAYER === 'undefined') { return; }
        queueRow(null, this.row.filepath, undefined, MSTREAMPLAYER.positionCache.val + 1);
      },
      queue: function () { if (typeof queueRow === 'function') { queueRow(null, this.row.filepath); } },
      // Show in folder: the folder listed, the song's row ringed there
      // (m.js ytdlRing), as after an add into the folder on screen.
      show: function () {
        if (typeof openFileExplorerAt !== 'function') { return; }
        const filepath = this.row.filepath;
        Promise.resolve(openFileExplorerAt(crumbsOf(filepath).slice(0, -1))).then(() => {
          if (typeof ytdlRing === 'function') { ytdlRing({ kind: 'file', value: filepath }); }
        }, () => {});
      },
    },
    template: `<li class="ytp-added" :class="{ 'is-missing': !playable }" data-yt-row>
      <button v-if="playable" type="button" class="ytp-added-btn" @click="play">
        <span class="ytp-added-ic" aria-hidden="true"><yt-icon name="check" :size="16"></yt-icon></span>
        <span class="ytp-rbody"><span class="ytp-rtitle">{{ title }}</span><span class="ytp-rcrumbs"><span dir="ltr">{{ crumbText }}</span></span></span>
        <span class="ytp-added-facts">{{ facts }}</span>
      </button>
      <div v-else class="ytp-added-btn">
        <span class="ytp-added-ic" aria-hidden="true"><yt-icon name="check" :size="16"></yt-icon></span>
        <span class="ytp-rbody"><span class="ytp-rtitle">{{ title }}</span><span class="ytp-rcrumbs"><span dir="ltr">{{ crumbText }}</span></span></span>
        <span class="ytp-added-facts">{{ facts }}</span>
      </div>
      <yt-more-menu v-if="playable" :title="title" @queue="queue" @show="show"></yt-more-menu>
    </li>`,
  });

  // ── focus that loses its control ──
  // A press that takes its own control away — a line that goes (Use them,
  // Try again, Save to … instead), a chip put back, a row that moves on or
  // goes — would drop the keyboard on the page (and a window's trap would
  // send it to Close). Once the surface redrew, it lands on the control
  // standing in for it: the one the control named (data-yt-then: 'title',
  // 'link', 'add'; 'earlier' — the first row Show earlier brought), or for
  // a row (data-yt-row in a data-yt-list) the row now in its place, else
  // its list's heading (data-yt-head). A real blur (a press elsewhere, Tab
  // out) is not put back.
  function rowsIn(rootEl, list) {
    const box = rootEl && rootEl.querySelector(`[data-yt-list="${list}"]`);
    return box ? Array.from(box.children).filter((x) => x.hasAttribute('data-yt-row')) : [];
  }
  function firstControl(row) {
    if (!row) { return null; }
    if (row.tagName === 'BUTTON') { return row; }
    return row.querySelector('button:not([aria-disabled="true"])') || row.querySelector('button');
  }
  const focusKeep = {
    created: function () { this.ytFocus = null; },
    methods: {
      noteFocus: function (e) {
        const el = e.target;
        if (!el || typeof el.closest !== 'function') { return; }
        const row = el.closest('[data-yt-row]');
        const box = row ? row.closest('[data-yt-list]') : null;
        const then = el.getAttribute('data-yt-then') || (row && row.getAttribute('data-yt-then')) || null;
        this.ytFocus = {
          el,
          then,
          list: box ? box.getAttribute('data-yt-list') : null,
          at: box ? rowsIn(this.$el, box.getAttribute('data-yt-list')).indexOf(row) : -1,
          count: then === 'earlier' ? rowsIn(this.$el, 'added').length : 0,
        };
      },
      dropFocus: function (e) {
        const el = e.target;
        setTimeout(() => {
          const f = this.ytFocus;
          if (f && f.el === el && el.isConnected && document.activeElement !== el) { this.ytFocus = null; }
        }, 0);
      },
      keepFocus: function () {
        const f = this.ytFocus;
        if (!f || !f.el || f.el.isConnected) { return; }
        this.ytFocus = null;
        const a = document.activeElement;
        if (a && a !== document.body && a !== document.documentElement) { return; }
        const to = this.focusFor(f);
        if (to && typeof to.focus === 'function') { to.focus(); }
      },
      focusFor: function (f) {
        if (f.then === 'earlier') {
          const rows = rowsIn(this.$el, 'added');
          const ctl = firstControl(rows[f.count] || rows[rows.length - 1]);
          if (ctl) { return ctl; }
        } else if (f.list) {
          const rows = rowsIn(this.$el, f.list);
          const ctl = firstControl(rows[Math.min(f.at, rows.length - 1)]);
          if (ctl) { return ctl; }
          const head = this.$el.querySelector(`[data-yt-head="${f.list}"]`);
          if (head) { return head; }
        }
        const ref = { title: 'f-title', add: 'add' }[f.then] || 'link';
        const el = this.$refs[ref];
        return (Array.isArray(el) ? el[0] : el) || this.$refs.link || null;
      },
      // Enter in the link or a tag field: Add, when it's on (an IME's
      // Enter only picks its words)
      onEnter: function (e) {
        if (e.isComposing || e.keyCode === 229) { return; }
        e.preventDefault();
        this.add();
      },
    },
  };

  // ── the panel ──

  Vue.component('yt-panel', {
    mixins: [focusKeep],
    // focus: 'needsLook' (a toast's Details) — Needs a look in view, not
    // the link field
    props: { d: { type: Object, required: true }, focus: { type: String, default: null } },
    data: function () { return { store }; },
    computed: {
      m: function () { return this.d.model(); },
      said: function () { return saidOf(this.m); },
      linkText: {
        get: function () { return this.d.s.link; },
        set: function (v) { this.d.setLink(v); },
      },
      lists: function () {
        void store.tick;
        return listsView(tracker, { now: store.now, server: store.server.name, formats: this.d.formats(), hold: this.d.s.startingKey });
      },
    },
    mounted: function () {
      this.d.attach();
      if (tracker) { tracker.watch(true); tracker.loadAdded(); }
      askView();
      this.$nextTick(() => (this.focus === 'needsLook' ? this.showNeedsLook() : this.focusLink()));
    },
    beforeDestroy: function () {
      this.d.detach();
      this.d.setFocus(null);
      if (tracker) { tracker.watch(false); }
    },
    // Vue leaves a focused field's value alone: a value the draft set
    // meanwhile (a lookup answering into an untouched field) is written
    // here. Focus a redraw took away is put back (focusKeep).
    updated: function () { this.syncFields(); this.keepFocus(); },
    methods: {
      tt,
      tl,
      id: function (part) { return `ytp-${part}`; },
      syncFields: function () {
        const pairs = [['link', this.d.s.link]].concat(core().FIELDS.map((f) => [`f-${f}`, this.d.s.fields[f]]));
        for (const [ref, value] of pairs) {
          const el = this.$refs[ref];
          if (el && !el.composing && el.value !== value && document.activeElement === el) { el.value = value; }
        }
      },
      fieldValue: function (f) { return this.d.s.fields[f]; },
      onField: function (f, e) { this.d.setField(f, e.target.value); },
      focusLink: function () {
        const el = this.$refs.link;
        if (el && typeof el.focus === 'function') { el.focus({ preventScroll: true }); }
      },
      showNeedsLook: function () {
        const h = document.getElementById(this.id('look'));
        if (!h) { this.focusLink(); return; }
        if (typeof h.scrollIntoView === 'function') { h.scrollIntoView({ block: 'start' }); }
        h.focus({ preventScroll: true });
      },
      focusField: function (f) {
        this.$nextTick(() => {
          const el = this.$refs['f-' + f];
          const input = Array.isArray(el) ? el[0] : el;
          if (input && typeof input.focus === 'function') { input.focus(); }
        });
      },
      onPaste: function (e) {
        // The pasted text lands first; then the lookup starts at once.
        const el = e.target;
        setTimeout(() => { if (el) { this.d.setLink(el.value, { immediate: true }); } }, 0);
      },
      clearLink: function () {
        this.d.clear();
        this.$nextTick(() => this.focusLink());
      },
      enterYourself: function () {
        this.d.enterManually();
        this.focusField('title');
      },
      thumbStyle: function () { return this.m.thumb ? { backgroundImage: `url("${String(this.m.thumb).replace(/["\\]/g, '')}")` } : null; },
      helpFor: function (f) { return this.m.help && this.m.help.field === f && this.m.help.label ? this.m.help : null; },
      helpAfter: function (f) {
        // The help line sits under the focused field's row: Album and Year
        // share one.
        const h = this.m.help;
        if (!h || !h.label) { return false; }
        if (f === 'year') { return h.field === 'album' || h.field === 'year'; }
        return h.field === f;
      },
      describedBy: function (f) {
        // the Year field: why Add is off too, when that is the year
        const ids = [this.helpFor(f) ? this.id('help') : null, f === 'year' && this.m.block === 'yearInvalid' && this.m.reason ? this.id('reason') : null].filter(Boolean);
        return ids.length ? ids.join(' ') : null;
      },
      changeFormat: function () {
        const fm = this.$refs.format;
        if (fm && typeof fm.openMenu === 'function') { fm.openMenu(); }
      },
      openWhere: function (e) { openWindow({ mode: 'where' }, e && e.currentTarget); },
      openChoose: function (e) { openWindow({ mode: 'choose', start: chooseStart(this.d) }, e && e.currentTarget); },
      trapLink: function (focus) { this.focusField(focus === 'year' ? 'year' : 'album'); },
      deepestText: function () { return crumbLine(this.m.noMkdir && this.m.noMkdir.deepest); },
      add: function () {
        if (this.m.primary.disabled) { return; }
        this.d.add().then((sent) => {
          if (sent) { this.$nextTick(() => this.focusLink()); }
        });
      },
      rowAct: function (row, name, codec) { rowAction(row, name, codec); },
      busyRow: function (row) { return !!tracker && tracker.busy(row.id); },
      showEarlier: function () {
        const v = this.lists.added;
        if (tracker && v.canShowEarlier) { tracker.loadAdded({ before: v.cursor }); }
      },
    },
    template: `<div class="ytdl-panel" @focusin="noteFocus" @focusout="dropFocus">
      <div class="dm-sr" role="status"><span>{{ tl(said.phase) }}</span> <span>{{ tl(said.lost) }}</span></div>
      <div class="ytp-linkbox">
        <div class="ytp-link">
          <label class="dm-sr" :for="id('link')">{{ tt('ytdl.link.label') }}</label>
          <input :id="id('link')" ref="link" v-model="linkText" type="url" class="ytp-input ytp-link-input browser-default" :class="{ 'has-clear': !!d.s.link }"
            :placeholder="tt('ytdl.link.placeholder')" autocomplete="off" spellcheck="false" @paste="onPaste" @keydown.enter="onEnter">
          <button v-if="d.s.link" type="button" class="ytp-clear" :aria-label="tt('ytdl.link.clear')" :title="tt('ytdl.link.clear')" @click="clearLink"><yt-icon name="close" :size="14"></yt-icon></button>
        </div>
        <div v-for="(n, i) in m.notes" :key="'n' + i" class="ytp-note" :class="'is-' + n.tone">
          <span v-if="n.tone !== 'note'" class="ytp-note-ic"><yt-icon :name="n.tone === 'err' ? 'err' : 'warn'" :size="14"></yt-icon></span>
          <span class="ytp-note-text">{{ tl(n.label) }}</span>
        </div>
      </div>

      <div v-if="m.phase === 'reading'" class="ytp-card ytp-card-wait">
        <div class="ytp-reading">{{ tt('ytdl.lookup.reading') }}</div>
        <div class="yt-bar" role="progressbar" :aria-label="tt('ytdl.lookup.readingAria')"><i></i></div>
      </div>
      <div v-else-if="m.phase === 'slow'" class="ytp-card ytp-card-slow">
        <div class="ytp-slow"><span class="ytp-slow-text">{{ tt('ytdl.lookup.slow') }}</span><button type="button" class="dm-link" @click="enterYourself">{{ tt('ytdl.lookup.enterYourself') }}</button></div>
        <div class="yt-bar" role="progressbar" :aria-label="tt('ytdl.lookup.readingAria')"><i></i></div>
      </div>
      <div v-else-if="m.phase !== 'empty' && m.phase !== 'card'" class="ytp-card">
        <div class="ytp-line" :class="m.lookupLine && m.lookupLine.tone === 'muted' ? 'is-muted' : 'is-warn'">
          <span class="ytp-line-ic"><yt-icon :name="m.lookupLine && m.lookupLine.tone === 'muted' ? 'offline' : 'warn'" :size="16"></yt-icon></span>
          <div class="ytp-line-body"><div class="ytp-line-text">{{ m.lookupLine ? tl(m.lookupLine.label) : '' }}</div></div>
        </div>
        <div v-if="m.lookupLine && m.lookupLine.retry" class="ytp-retry"><button type="button" class="dm-btn" data-yt-then="link" @click="d.retryLookup()">{{ tt('ytdl.retry') }}</button></div>
      </div>

      <div v-else-if="m.phase === 'card'" class="ytp-card">
        <div v-if="m.late" class="ytp-late">
          <span class="ytp-late-ic"><yt-icon name="info" :size="16"></yt-icon></span>
          <div class="ytp-late-body"><span class="ytp-late-text">{{ tt('ytdl.late.found') }}</span><button type="button" class="dm-link" data-yt-then="title" @click="d.useLate()">{{ tt('ytdl.late.useThem') }}</button><span class="ytp-late-note">{{ tt('ytdl.late.editsStay') }}</span></div>
        </div>
        <div v-if="m.lookupLine" class="ytp-line" :class="m.lookupLine.tone === 'muted' ? 'is-muted' : 'is-warn'">
          <span class="ytp-line-ic"><yt-icon :name="m.lookupLine.tone === 'muted' ? 'offline' : 'warn'" :size="16"></yt-icon></span>
          <div class="ytp-line-body">
            <div class="ytp-line-text">{{ tl(m.lookupLine.label) }}</div>
            <div v-if="m.lookupLine.retry" class="ytp-line-links"><button type="button" class="dm-link" data-yt-then="link" @click="d.retryLookup()">{{ tt('ytdl.retry') }}</button></div>
          </div>
        </div>
        <div class="ytp-found">
          <div class="ytp-thumb" :class="{ 'is-blank': m.blankThumb, 'has-img': !!m.thumb }" aria-hidden="true" :style="thumbStyle()"><template v-if="!m.blankThumb && !m.thumb"><i></i><b></b></template></div>
          <div class="ytp-fields">
            <div class="ytp-field ytp-wide ytp-f-title">
              <label class="ytp-label" :for="id('title')">{{ tt('ytdl.field.title') }}</label>
              <input :id="id('title')" ref="f-title" type="text" class="ytp-input browser-default" :value="fieldValue('title')" autocomplete="off" :aria-describedby="describedBy('title')"
                @input="onField('title', $event)" @focus="d.setFocus('title')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
            </div>
            <div v-if="helpAfter('title')" :id="id('help')" class="ytp-help">{{ tl(m.help.label) }}</div>
            <div class="ytp-field ytp-wide">
              <label class="ytp-label" :for="id('artist')">{{ tt('ytdl.field.artist') }}</label>
              <input :id="id('artist')" ref="f-artist" type="text" class="ytp-input browser-default" :class="{ 'is-warn': m.artistWarn }" :value="fieldValue('artist')" autocomplete="off" :aria-describedby="describedBy('artist')"
                @input="onField('artist', $event)" @focus="d.setFocus('artist')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
            </div>
            <div v-if="helpAfter('artist')" :id="id('help')" class="ytp-help">{{ tl(m.help.label) }}</div>
            <div class="ytp-field">
              <label class="ytp-label" :for="id('album')">{{ tt('ytdl.field.album') }}</label>
              <input :id="id('album')" ref="f-album" type="text" class="ytp-input browser-default" :value="fieldValue('album')" autocomplete="off" :aria-describedby="describedBy('album')"
                @input="onField('album', $event)" @focus="d.setFocus('album')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
            </div>
            <div class="ytp-field ytp-year">
              <label class="ytp-label" :for="id('year')">{{ tt('ytdl.field.year') }}</label>
              <input :id="id('year')" ref="f-year" type="text" inputmode="numeric" class="ytp-input browser-default" :value="fieldValue('year')" autocomplete="off" :aria-describedby="describedBy('year')"
                :aria-invalid="m.block === 'yearInvalid' ? 'true' : null" @input="onField('year', $event)" @focus="d.setFocus('year')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
            </div>
            <div v-if="helpAfter('year')" :id="id('help')" class="ytp-help">{{ tl(m.help.label) }}</div>
          </div>
        </div>
        <div v-if="m.source" class="ytp-source" :class="'is-' + m.source.tone">
          <span class="ytp-source-ic"><yt-icon :name="m.source.tone === 'ok' ? 'check' : (m.source.tone === 'warn' ? 'warn' : 'wand')" :size="14"></yt-icon></span>
          <span>{{ tl(m.source.label) }}</span>
        </div>
        <div v-if="m.cleaned" class="ytp-cleaned">
          <div class="ytp-source is-auto"><span class="ytp-source-ic"><yt-icon name="wand" :size="14"></yt-icon></span><span>{{ tl(m.cleaned) }}</span></div>
          <div class="ytp-chips" data-yt-list="chips">
            <button v-for="c in m.chips" :key="'c' + c.index" type="button" class="ytp-chip" data-yt-row data-yt-then="title" :aria-label="tt('ytdl.putBack', { fragment: c.text })" @click="d.restore(c.index)"><span class="ytp-chip-ic"><yt-icon name="undo" :size="13"></yt-icon></span>{{ c.text }}</button>
            <button v-if="m.canUndoAll" type="button" class="dm-link" data-yt-row data-yt-then="title" @click="d.undoAll()">{{ tt('ytdl.undoAll') }}</button>
          </div>
        </div>
        <div class="ytp-div" aria-hidden="true"></div>
        <div class="ytp-saves">
          <span class="ytp-label ytp-saves-label">{{ tt('ytdl.savesTo') }}</span>
          <yt-crumbs class="ytp-saves-path" :items="m.crumbs"></yt-crumbs>
          <button type="button" class="dm-link ytp-change" aria-haspopup="dialog" @click="openWhere">{{ tt('ytdl.change') }}</button>
          <div v-if="m.letters" class="ytp-letters"><yt-text :label="m.letters"></yt-text></div>
        </div>
        <div v-if="m.trap" class="ytp-line is-warn">
          <span class="ytp-line-ic"><yt-icon name="warn" :size="16"></yt-icon></span>
          <div class="ytp-line-body">
            <div class="ytp-line-text">{{ tl(m.trap.label) }}</div>
            <div v-if="m.trap.link" class="ytp-line-links"><button type="button" class="dm-link" @click="trapLink(m.trap.link.focus)">{{ tl(m.trap.link.label) }}</button></div>
          </div>
        </div>
        <div v-if="m.noMkdir" class="ytp-line is-warn">
          <span class="ytp-line-ic"><yt-icon name="warn" :size="16"></yt-icon></span>
          <div class="ytp-line-body">
            <div class="ytp-line-text">{{ tl(m.noMkdir.label) }}</div>
            <div class="ytp-line-links">
              <template v-if="m.noMkdir.deepest"><button type="button" class="dm-link" data-yt-then="add" @click="d.saveToDeepest()">{{ tt('ytdl.noMkdir.saveInstead', { path: deepestText() }) }}</button><span class="ytp-dot" aria-hidden="true">·</span></template>
              <button type="button" class="dm-link" aria-haspopup="dialog" @click="openChoose">{{ tt('ytdl.noMkdir.choose') }}</button>
            </div>
          </div>
        </div>
        <div v-if="m.failure" class="ytp-line is-err" role="alert">
          <span class="ytp-line-ic"><yt-icon name="err" :size="16"></yt-icon></span>
          <div class="ytp-line-body">
            <div class="ytp-line-text"><yt-text :label="m.failure.label"></yt-text></div>
            <div v-if="m.failure.changeFormat" class="ytp-line-links"><button type="button" class="dm-link" aria-haspopup="menu" @click="changeFormat">{{ tt('ytdl.changeFormat') }}</button></div>
          </div>
        </div>
        <div v-else-if="m.clash" class="ytp-line is-warn">
          <span class="ytp-line-ic"><yt-icon name="warn" :size="16"></yt-icon></span>
          <div class="ytp-line-body">
            <div class="ytp-line-text"><yt-text :label="m.clash.label"></yt-text></div>
            <div v-if="m.clash.changeFormat" class="ytp-line-links"><button type="button" class="dm-link" aria-haspopup="menu" @click="changeFormat">{{ tt('ytdl.changeFormat') }}</button></div>
          </div>
        </div>
        <div v-if="m.reason" :id="id('reason')" class="ytp-reason">{{ tl(m.reason) }}</div>
        <div class="ytp-foot">
          <yt-format-menu ref="format" :value="m.format" :options="m.formats" :up="true" @pick="d.setFormat($event)"></yt-format-menu>
          <button ref="add" type="button" class="dm-btn dm-btn-primary ytp-add" :class="{ 'is-busy': m.primary.busy }" :aria-disabled="m.primary.disabled ? 'true' : null"
            :aria-describedby="m.reason ? id('reason') : null" @click="add">{{ tl(m.primary.label) }}</button>
        </div>
      </div>

      <section v-if="lists.adding.length" class="ytp-sec" :aria-labelledby="id('adding')">
        <div class="ytp-sec-h"><h3 :id="id('adding')" class="ytp-label" tabindex="-1" data-yt-head="adding">{{ tt('ytdl.list.adding') }}</h3><span class="ytp-hint">{{ tt('ytdl.list.addingNote') }}</span></div>
        <ul class="ytp-rows" data-yt-list="adding"><yt-job-row v-for="r in lists.adding" :key="r.id" :row="r"></yt-job-row></ul>
      </section>
      <section v-if="lists.needsLook.length" class="ytp-sec" :aria-labelledby="id('look')">
        <div class="ytp-sec-h"><h3 :id="id('look')" class="ytp-label" tabindex="-1" data-yt-head="look">{{ tt('ytdl.list.needsLook') }}</h3></div>
        <ul class="ytp-rows" data-yt-list="look"><yt-job-row v-for="r in lists.needsLook" :key="r.id" :row="r" :busy="busyRow(r)" :formats="m.formats" :codec="m.format" @act="(name, codec) => rowAct(r, name, codec)"></yt-job-row></ul>
      </section>
      <section v-if="lists.added.rows.length" class="ytp-sec" :aria-labelledby="id('added')">
        <div class="ytp-sec-h"><h3 :id="id('added')" class="ytp-label" tabindex="-1" data-yt-head="added">{{ tt('ytdl.list.added') }}</h3></div>
        <ul class="ytp-rows" data-yt-list="added"><yt-added-row v-for="r in lists.added.rows" :key="r.key" :row="r"></yt-added-row></ul>
        <div v-if="lists.added.canShowEarlier" class="ytp-earlier"><button type="button" class="dm-btn dm-btn-quiet" data-yt-then="earlier" :class="{ 'is-busy': lists.added.loading }" :aria-disabled="lists.added.loading ? 'true' : null" @click="showEarlier">{{ tt('ytdl.list.showEarlier') }}</button></div>
      </section>
    </div>`,
  });

  // A Needs a look row's button. Try again / Add again / Change format and
  // retry start a new add in its place; Choose a folder… and Top of the
  // library add it again into another folder, then the row goes.
  function rowAction(row, name, codec) {
    const tr = tracker;
    if (!tr || tr.busy(row.id)) { return; }
    const job = tr.get(row.id);
    if (!job) { return; }
    if (name === 'retry' || name === 'addAgain') { tr.retry(job); }
    else if (name === 'changeFormat') { if (codec && codec !== job.codec) { tr.retry(job, { codec }); } }
    else if (name === 'checkAgain') { tr.checkAgain(job); }
    else if (name === 'dismiss') { tr.dismiss(job); }
    else if (name === 'topOfLibrary') {
      const lib = (job.crumbs && job.crumbs[0]) || crumbsOf(job.directory)[0];
      if (lib) { addInto(job, `/${lib}/`); }
    } else if (name === 'chooseFolder') {
      winJob = job.id;
      openWindow({ mode: 'choose', start: job.mkdir || job.directory }, document.activeElement);
    }
  }

  // The row's song added again into `directory` (no folder to make: the
  // folder is there), then the row goes.
  function addInto(job, directory) {
    const tr = tracker;
    if (!tr) { return; }
    const crumbs = crumbsOf(directory);
    tr.add({
      url: job.url, directory, codec: job.codec, metadata: job.metadata, title: job.title, crumbs,
      cover: job.cover || undefined, inline: false,
    });
    tr.dismiss(job);
  }

  // ── the windows ──
  // One .dmodal at a time over the page (the house sheet below 600 px);
  // Choose a folder replaces Where new songs land, never stacks. Tab stays
  // inside (vp.js's own trap), Esc closes, the opener gets the focus back.

  Vue.component('yt-where', {
    props: { d: { type: Object, required: true } },
    data: function () {
      return {
        form: whereOpen(this.d.choice(), this.d.remembered()),
        check: { dir: null, newSegments: [] },
        checkTimer: null,
        pointer: false,
      };
    },
    computed: {
      libraries: function () { return librariesFor(store.view, store.server); },
      w: function () { return whereState(this.form, { view: store.view, saved: store.saved, draft: this.d }); },
      choices: function () { return this.w.choices; },
      kind: function () { return this.form.kind; },
      library: function () { return this.form.library; },
      custom: {
        get: function () { return this.form.custom; },
        set: function (v) { this.form = Object.assign({}, this.form, { custom: str(v) }); },
      },
      customError: function () { return this.w.customError; },
      target: function () { return this.w.target; },
      valid: function () { return this.w.valid; },
      crumbs: function () {
        const fresh = this.check.dir === this.target.directory ? this.check.newSegments : [];
        return core().crumbItems(this.target, fresh);
      },
      trap: function () { return this.valid && this.target.trap ? core().trapLabel(this.target.trap) : null; },
      canSave: function () { return this.w.canSave; },
      canUse: function () { return this.w.canUse; },
      lockedLibrary: function () { return this.w.lockedLibrary; },
      title: function () { return this.d.displayTitle(); },
      vars: function () {
        const layout = this.form.custom;
        return core().YTDL_VARS.map((name) => ({
          name,
          key: ({ ARTIST: 'ytdl.where.insertArtist', ALBUMARTIST: 'ytdl.where.insertAlbumArtist', ALBUM: 'ytdl.where.insertAlbum', YEAR: 'ytdl.where.insertYear' })[name],
          used: new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i').test(layout),
        }));
      },
    },
    watch: {
      'target.directory': function () { this.scheduleCheck(); },
      valid: function () { this.scheduleCheck(); },
    },
    mounted: function () {
      this.scheduleCheck();
      this.$nextTick(() => {
        const on = this.$el.querySelector('input[name="ytw-lay"]:checked') || this.$el.querySelector('input[name="ytw-lay"]');
        if (on) { on.focus(); }
      });
    },
    beforeDestroy: function () { if (this.checkTimer) { clearTimeout(this.checkTimer); } },
    methods: {
      tt,
      tl,
      scheduleCheck: function () {
        const t = this.target;
        const dir = this.valid && t.segments.length ? t.directory : null;
        if (dir === this.check.dir) { return; }
        if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }
        this.check = { dir, newSegments: [] };
        if (!dir) { return; }
        // A path the card has checked already is taken from it.
        const dc = this.d.s.check;
        if (dc.dir === dir && dc.state === 'known') { this.check = { dir, newSegments: dc.newSegments.slice() }; return; }
        this.checkTimer = setTimeout(() => {
          this.checkTimer = null;
          core().checkFolders({ target: t, list: (x) => MSTREAMAPI.dirparser(x), stale: () => this.check.dir !== dir || this._isDestroyed }).then((found) => {
            if (!found || this.check.dir !== dir || this._isDestroyed) { return; }
            this.check = { dir, newSegments: found.newSegments.slice() };
          });
        }, CHECK_AFTER_MS);
      },
      pickLibrary: function (vpath) { this.form = wherePickLibrary(this.form, vpath, store.view, store.saved); },
      // Custom chosen with a pointer: its field takes the keyboard. Arrowed
      // onto, it doesn't — the arrows keep moving through the radios (the
      // field is the next Tab stop), as the Discover editor's Custom does.
      pickLayout: function (kind) {
        const pointer = this.pointer;
        this.pointer = false;
        this.form = wherePickLayout(this.form, kind, store.view, store.saved);
        if (kind === 'custom' && pointer) { this.$nextTick(() => { if (this.$refs.custom) { this.$refs.custom.focus(); } }); }
      },
      insertVar: function (name) {
        const el = this.$refs.custom;
        const token = `{{${name}}}`;
        const value = this.custom;
        const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : value.length;
        this.custom = value.slice(0, start) + token + value.slice(end);
        const caret = start + token.length;
        this.$nextTick(() => {
          if (!el) { return; }
          el.focus();
          try { el.setSelectionRange(caret, caret); } catch (_) { /* a field that takes no caret */ }
        });
      },
      apply: function (c) {
        if (this.d.sameChoice(c, this.d.remembered())) { this.d.useForThisSong(this.d.remembered()); }
        else if (!this.d.sameChoice(c, this.d.choice())) { this.d.useForThisSong(c); }
      },
      useOnce: function () {
        if (!this.canUse) { return; }
        this.apply(this.w.choice);
        closeWindow();
      },
      save: function () {
        if (!this.canSave) { return; }
        this.d.saveChoice(this.w.choice);
        closeWindow();
      },
      // A bracket warning's link: the window closes, the choice holds for
      // this song, and the card's field that fills the folder takes focus.
      fillTag: function (focus) {
        this.apply(this.w.choice);
        closeWindow({ focusField: focus === 'year' ? 'year' : 'album' });
      },
    },
    template: `<div class="ytw-where">
      <div class="ytw-head"><h2 id="ytw-title" class="dmodal-title">{{ tt('ytdl.where.title') }}</h2></div>
      <div class="ytw-body">
        <div class="ytw-preview" aria-live="polite">
          <span class="ytw-preview-ic" :class="valid ? 'is-src' : 'is-warn'"><yt-icon :name="valid ? 'folder' : 'warn'" :size="14"></yt-icon></span>
          <div class="ytw-preview-text">
            <template v-if="valid">
              <div class="ytw-lands">{{ title ? tt('ytdl.where.landsAt', { title }) : tt('ytdl.where.landsAtSample') }}</div>
              <div class="ytw-path"><yt-crumbs :items="crumbs"></yt-crumbs></div>
            </template>
            <div v-else class="ytw-fix">{{ tt('ytdl.where.fixLayout') }}</div>
          </div>
        </div>
        <div v-if="trap" class="ytw-line is-warn">
          <span class="ytw-line-ic"><yt-icon name="warn" :size="15"></yt-icon></span>
          <div class="ytw-line-text">{{ tl(trap.label) }}<div v-if="trap.link" class="ytw-line-links"><button type="button" class="dm-link" @click="fillTag(trap.link.focus)">{{ tl(trap.link.label) }}</button></div></div>
        </div>
        <div v-if="d.mayNotMkdir()" class="ytw-line is-note">
          <span class="ytw-line-ic"><yt-icon name="info" :size="15"></yt-icon></span>
          <div class="ytw-line-text">{{ tt('ytdl.where.noMkdir') }}</div>
        </div>
        <div v-if="libraries.length >= 2" class="ytw-group">
          <div id="ytw-lib-l" class="ytw-label">{{ tt('ytdl.where.library') }}</div>
          <div role="radiogroup" aria-labelledby="ytw-lib-l" class="ytw-libs">
            <label v-for="(lib, i) in libraries" :key="lib" :for="'ytw-lib-' + i" class="ytw-opt" :class="{ 'is-on': (lockedLibrary || library) === lib, 'is-off': lockedLibrary && lockedLibrary !== lib }">
              <span class="ytw-opt-label">{{ lib }}</span>
              <input :id="'ytw-lib-' + i" type="radio" name="ytw-lib" class="ytw-radio" :value="lib" :checked="(lockedLibrary || library) === lib" :disabled="!!lockedLibrary && lockedLibrary !== lib" @change="pickLibrary(lib)">
            </label>
          </div>
        </div>
        <div class="ytw-group">
          <div id="ytw-lay-l" class="ytw-label">{{ tt('ytdl.where.layout') }}</div>
          <div role="radiogroup" aria-labelledby="ytw-lay-l" class="ytw-lays">
            <label v-for="(c, i) in choices" :key="c.kind" :for="'ytw-lay-' + i" class="ytw-opt" :class="{ 'is-on': kind === c.kind }" @pointerdown="pointer = true">
              <span class="ytw-opt-label">{{ tl(c.label) }}</span>
              <input :id="'ytw-lay-' + i" type="radio" name="ytw-lay" class="ytw-radio" :value="c.kind" :checked="kind === c.kind" @change="pickLayout(c.kind)">
            </label>
          </div>
          <div v-if="kind === 'custom'" class="ytw-custom">
            <label class="dm-sr" for="ytw-custom">{{ tt('ytdl.where.customField') }}</label>
            <input id="ytw-custom" ref="custom" v-model="custom" type="text" class="dm-input ytw-custom-input browser-default" :class="{ 'is-err': !!customError }" spellcheck="false" autocomplete="off"
              :aria-invalid="customError ? 'true' : null" :aria-describedby="customError ? 'ytw-custom-err' : null">
            <div v-if="customError" id="ytw-custom-err" class="ytw-err" role="alert"><span class="ytw-err-ic"><yt-icon name="err" :size="12"></yt-icon></span><span>{{ tl(customError) }}</span></div>
            <div role="group" class="ytw-vars" :aria-label="tt('ytdl.where.insert')">
              <button v-for="v in vars" :key="v.name" type="button" class="ytw-var" :aria-label="v.used ? tt('ytdl.where.used', { name: tt(v.key) }) : null" @click="insertVar(v.name)"><span v-if="v.used" class="ytw-var-ic"><yt-icon name="check" :size="12"></yt-icon></span>{{ tt(v.key) }}</button>
            </div>
          </div>
        </div>
        <div class="ytw-foot">
          <span class="ytw-kept">{{ tt('ytdl.where.kept') }}</span>
          <button type="button" class="dm-btn" :aria-disabled="canUse ? null : 'true'" @click="useOnce">{{ tt('ytdl.where.useOnce') }}</button>
          <button type="button" class="dm-btn dm-btn-primary" :aria-disabled="canSave ? null : 'true'" @click="save">{{ tt('ytdl.where.save') }}</button>
        </div>
      </div>
    </div>`,
  });

  // Choose a folder: the folders that are there, one listing at a time,
  // for this song (the card) or a row's add again.
  Vue.component('yt-choose', {
    props: { d: { type: Object, default: null }, start: { type: String, default: '/' } },
    data: function () {
      return { crumbs: crumbsOf(this.start), dirs: [], loading: false, failed: false, rid: 0 };
    },
    computed: {
      parent: function () { return this.crumbs.length > 1 ? this.crumbs[this.crumbs.length - 2] : null; },
      pathText: function () { return crumbLine(this.crumbs); },
      showSub: function () { return store.server.noMkdir === true || store.mkdirRefused === true; },
      usable: function () { return !this.loading && !this.failed && this.crumbs.length > 0; },
    },
    mounted: function () { this.load(true); },
    methods: {
      tt,
      load: function (first) {
        const rid = ++this.rid;
        this.loading = true;
        this.failed = false;
        Promise.resolve(MSTREAMAPI.dirparser(dirOf(this.crumbs))).then((res) => {
          if (rid !== this.rid || this._isDestroyed) { return; }
          this.dirs = (res && Array.isArray(res.directories) ? res.directories : []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter((x) => typeof x === 'string');
          this.loading = false;
          if (first) { this.$nextTick(() => this.focusFirst()); }
        }).catch(() => {
          if (rid !== this.rid || this._isDestroyed) { return; }
          // A folder that won't list opens its parent (the path may name a
          // folder that was never made).
          if (first && this.crumbs.length > 1) { this.crumbs.pop(); this.load(true); return; }
          this.dirs = [];
          this.loading = false;
          this.failed = true;
        });
      },
      focusFirst: function () {
        const el = this.$el.querySelector('.ytw-node') || this.$el.querySelector('.ytw-use');
        if (el) { el.focus(); }
      },
      up: function () {
        if (this.crumbs.length <= 1) { return; }
        this.crumbs.pop();
        this.load(false);
        this.$nextTick(() => this.focusFirst());
      },
      into: function (name) {
        this.crumbs.push(name);
        this.load(false);
        this.$nextTick(() => this.focusFirst());
      },
      // For a row (winJob): its song added again there — nothing, if the
      // row went meanwhile (another tab dismissed it); never the card's.
      use: function () {
        if (!this.usable) { return; }
        const dir = dirOf(this.crumbs);
        if (winJob != null) {
          const job = tracker ? tracker.get(winJob) : null;
          if (job) { addInto(job, dir); }
        } else if (this.d) { this.d.useFolder(dir); }
        closeWindow();
      },
    },
    template: `<div class="ytw-choose">
      <div class="ytw-head"><h2 id="ytw-title" class="dmodal-title">{{ tt('ytdl.choose.title') }}</h2><div v-if="showSub" class="ytw-sub">{{ tt('ytdl.choose.sub') }}</div></div>
      <div class="ytw-body">
        <div class="ytw-tree" role="group" :aria-label="tt('ytdl.choose.group', { path: pathText })">
          <div class="ytw-tree-h"><template v-for="(c, i) in crumbs"><b v-if="i === 0" :key="'c' + i">{{ c }}</b><span v-else :key="'c' + i"><i aria-hidden="true">›</i>{{ c }}</span></template></div>
          <button v-if="parent" type="button" class="ytw-node ytw-node-up" @click="up"><span class="ytw-node-ic"><yt-icon name="up" :size="14"></yt-icon></span>{{ tt('ytdl.choose.up', { folder: parent }) }}</button>
          <div v-if="loading" class="ytw-tree-wait"><div class="yt-bar yt-bar-3" role="progressbar" :aria-label="tt('ytdl.choose.loading')"><i></i></div></div>
          <div v-else-if="failed" class="ytw-tree-empty">{{ tt('ytdl.choose.failed') }}</div>
          <template v-else>
            <button v-for="dir in dirs" :key="dir" type="button" class="ytw-node" @click="into(dir)">
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false" class="ytw-folder"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
              <span class="ytw-node-name">{{ dir }}</span><span class="ytw-node-go"><yt-icon name="right" :size="14"></yt-icon></span>
            </button>
            <div v-if="!dirs.length" class="ytw-tree-empty">{{ tt('ytdl.choose.empty') }}</div>
          </template>
        </div>
        <div class="ytw-foot ytw-foot-end"><button type="button" class="dm-btn dm-btn-primary ytw-use" :aria-disabled="usable ? null : 'true'" @click="use">{{ tt('ytdl.choose.use') }}</button></div>
      </div>
    </div>`,
  });

  // "Add from YouTube here" (WebWindow, Main frame 2): the explorer's
  // window for the folder on screen — the link, the found card's
  // thumbnail and 2 × 2 fields, then INTO: the folder, and "Sort into
  // subfolders…" opening the radios in place (never a second window);
  // the format and the add at its foot. "Adding…" until the server
  // answers; it closes once the job started, and a refusal (the 409 too)
  // shows inside while it stays.
  Vue.component('yt-here', {
    mixins: [focusKeep],
    props: { d: { type: Object, required: true } },
    data: function () { return { pointer: false }; },
    computed: {
      m: function () { return this.d.model(); },
      said: function () { return saidOf(this.m); },
      linkText: {
        get: function () { return this.d.s.link; },
        set: function (v) { this.d.setLink(v); },
      },
      sorts: function () { return core().FOLDER_SORTS; },
      vars: function () {
        const layout = this.d.s.subCustom;
        return core().YTDL_VARS.map((name) => ({
          name,
          key: ({ ARTIST: 'ytdl.where.insertArtist', ALBUMARTIST: 'ytdl.where.insertAlbumArtist', ALBUM: 'ytdl.where.insertAlbum', YEAR: 'ytdl.where.insertYear' })[name],
          used: new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i').test(layout),
        }));
      },
    },
    mounted: function () {
      this.d.attach();
      this.$nextTick(() => this.focusLink());
    },
    beforeDestroy: function () {
      this.d.detach();
      this.d.setFocus(null);
    },
    updated: function () { this.syncFields(); this.keepFocus(); },
    methods: {
      tt,
      tl,
      // (the panel's: a value the draft set into a focused field)
      syncFields: function () {
        const pairs = [['link', this.d.s.link], ['custom', this.d.s.subCustom]].concat(core().FIELDS.map((f) => [`f-${f}`, this.d.s.fields[f]]));
        for (const [ref, value] of pairs) {
          const el = this.$refs[ref];
          if (el && !el.composing && el.value !== value && document.activeElement === el) { el.value = value; }
        }
      },
      fieldValue: function (f) { return this.d.s.fields[f]; },
      onField: function (f, e) { this.d.setField(f, e.target.value); },
      focusLink: function () {
        const el = this.$refs.link;
        if (el && typeof el.focus === 'function') { el.focus(); }
      },
      focusField: function (f) {
        this.$nextTick(() => {
          const el = this.$refs['f-' + f];
          if (el && typeof el.focus === 'function') { el.focus(); }
        });
      },
      onPaste: function (e) {
        const el = e.target;
        setTimeout(() => { if (el) { this.d.setLink(el.value, { immediate: true }); } }, 0);
      },
      clearLink: function () {
        this.d.clear();
        this.$nextTick(() => this.focusLink());
      },
      enterYourself: function () {
        this.d.enterManually();
        this.focusField('title');
      },
      thumbStyle: function () { return this.m.thumb ? { backgroundImage: `url("${String(this.m.thumb).replace(/["\\]/g, '')}")` } : null; },
      describedBy: function (f) {
        const ids = [this.m.help && this.m.help.field === f && this.m.help.label ? 'yth-help' : null, f === 'year' && this.m.block === 'yearInvalid' && this.m.reason ? 'yth-reason' : null].filter(Boolean);
        return ids.length ? ids.join(' ') : null;
      },
      // "Sort into subfolders…": the radios, the checked one takes focus
      openSub: function () {
        this.d.openSub();
        this.$nextTick(() => {
          const on = this.$el.querySelector('input[name="yth-sub"]:checked') || this.$el.querySelector('input[name="yth-sub"]');
          if (on) { on.focus(); }
        });
      },
      // (Custom's field takes the keyboard on a pointer's pick only: yt-where)
      pickSub: function (kind) {
        const pointer = this.pointer;
        this.pointer = false;
        this.d.setSub(kind);
        if (kind === 'custom' && pointer) { this.$nextTick(() => { if (this.$refs.custom) { this.$refs.custom.focus(); } }); }
      },
      insertVar: function (name) {
        const el = this.$refs.custom;
        const token = `{{${name}}}`;
        const value = this.d.s.subCustom;
        const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : value.length;
        this.d.setSubCustom(value.slice(0, start) + token + value.slice(end));
        const caret = start + token.length;
        this.$nextTick(() => {
          if (!el) { return; }
          el.focus();
          try { el.setSelectionRange(caret, caret); } catch (_) { /* a field that takes no caret */ }
        });
      },
      changeFormat: function () {
        const fm = this.$refs.format;
        if (fm && typeof fm.openMenu === 'function') { fm.openMenu(); }
      },
      trapLink: function (focus) { this.focusField(focus === 'year' ? 'year' : 'album'); },
      deepestText: function () { return crumbLine(this.m.noMkdir && this.m.noMkdir.deepest); },
      saveToDeepest: function () {
        this.d.saveToDeepest();
        this.$nextTick(() => this.focusAdd());
      },
      // Choose a folder… takes this window's place; it comes back after.
      openChoose: function (e) {
        openWindow({ mode: 'choose', start: chooseStart(this.d), folder: this.d.folder, back: 'here' }, e && e.currentTarget);
      },
      focusAdd: function () { if (this.$refs.add) { this.$refs.add.focus(); } },
      // Add here / Add to library: the window closes once the server took
      // the job (or may have: it is looked for) — the strip takes over.
      add: function () {
        if (this.m.primary.disabled) { return; }
        const folder = this.d.folder;
        this.d.add().then((sent) => {
          if (sent && store.win && store.win.mode === 'here' && store.win.folder === folder) { closeWindow(); }
        });
      },
    },
    template: `<div class="yth" @focusin="noteFocus" @focusout="dropFocus">
      <div class="dm-sr" role="status"><span>{{ tl(said.phase) }}</span> <span>{{ tl(said.lost) }}</span></div>
      <div class="ytw-head"><h2 id="ytw-title" class="dmodal-title">{{ tt('panel.addFromYoutube') }}</h2></div>
      <div class="yth-body">
        <div class="yth-linkbox">
          <div class="yth-link">
            <label class="dm-sr" for="yth-link">{{ tt('ytdl.link.label') }}</label>
            <input id="yth-link" ref="link" v-model="linkText" type="text" inputmode="url" class="dm-input yth-input yth-link-input browser-default" :class="{ 'has-clear': !!d.s.link }"
              :placeholder="tt('ytdl.link.placeholder')" autocomplete="off" spellcheck="false" @paste="onPaste" @keydown.enter="onEnter">
            <button v-if="d.s.link" type="button" class="yth-clear" :aria-label="tt('ytdl.link.clear')" :title="tt('ytdl.link.clear')" @click="clearLink"><yt-icon name="close" :size="14"></yt-icon></button>
          </div>
          <div v-for="(n, i) in m.notes" :key="'n' + i" class="ytp-note" :class="'is-' + n.tone">
            <span v-if="n.tone !== 'note'" class="ytp-note-ic"><yt-icon :name="n.tone === 'err' ? 'err' : 'warn'" :size="14"></yt-icon></span>
            <span class="ytp-note-text">{{ tl(n.label) }}</span>
          </div>
        </div>

        <div v-if="m.phase === 'reading'" class="yth-wait">
          <div class="ytp-reading">{{ tt('ytdl.lookup.reading') }}</div>
          <div class="yt-bar" role="progressbar" :aria-label="tt('ytdl.lookup.readingAria')"><i></i></div>
        </div>
        <div v-else-if="m.phase === 'slow'" class="yth-wait">
          <div class="ytp-slow"><span class="ytp-slow-text">{{ tt('ytdl.lookup.slow') }}</span><button type="button" class="dm-link" @click="enterYourself">{{ tt('ytdl.lookup.enterYourself') }}</button></div>
          <div class="yt-bar" role="progressbar" :aria-label="tt('ytdl.lookup.readingAria')"><i></i></div>
        </div>
        <div v-else-if="m.phase !== 'empty' && m.phase !== 'card'" class="yth-wait">
          <div class="ytp-line" :class="m.lookupLine && m.lookupLine.tone === 'muted' ? 'is-muted' : 'is-warn'">
            <span class="ytp-line-ic"><yt-icon :name="m.lookupLine && m.lookupLine.tone === 'muted' ? 'offline' : 'warn'" :size="16"></yt-icon></span>
            <div class="ytp-line-body"><div class="ytp-line-text">{{ m.lookupLine ? tl(m.lookupLine.label) : '' }}</div></div>
          </div>
          <div v-if="m.lookupLine && m.lookupLine.retry" class="ytp-retry"><button type="button" class="dm-btn" data-yt-then="link" @click="d.retryLookup()">{{ tt('ytdl.retry') }}</button></div>
        </div>

        <template v-else-if="m.phase === 'card'">
          <div v-if="m.late" class="ytp-late">
            <span class="ytp-late-ic"><yt-icon name="info" :size="16"></yt-icon></span>
            <div class="ytp-late-body"><span class="ytp-late-text">{{ tt('ytdl.late.found') }}</span><button type="button" class="dm-link" data-yt-then="title" @click="d.useLate()">{{ tt('ytdl.late.useThem') }}</button><span class="ytp-late-note">{{ tt('ytdl.late.editsStay') }}</span></div>
          </div>
          <div v-if="m.lookupLine" class="ytp-line" :class="m.lookupLine.tone === 'muted' ? 'is-muted' : 'is-warn'">
            <span class="ytp-line-ic"><yt-icon :name="m.lookupLine.tone === 'muted' ? 'offline' : 'warn'" :size="16"></yt-icon></span>
            <div class="ytp-line-body">
              <div class="ytp-line-text">{{ tl(m.lookupLine.label) }}</div>
              <div v-if="m.lookupLine.retry" class="ytp-line-links"><button type="button" class="dm-link" data-yt-then="link" @click="d.retryLookup()">{{ tt('ytdl.retry') }}</button></div>
            </div>
          </div>
          <div class="yth-found">
            <div class="ytp-thumb yth-thumb" :class="{ 'is-blank': m.blankThumb, 'has-img': !!m.thumb }" aria-hidden="true" :style="thumbStyle()"><template v-if="!m.blankThumb && !m.thumb"><i></i><b></b></template></div>
            <div class="yth-fields">
              <div class="yth-field yth-f-title">
                <label class="ytw-label" for="yth-f-title">{{ tt('ytdl.field.title') }}</label>
                <input id="yth-f-title" ref="f-title" type="text" class="dm-input yth-input browser-default" :value="fieldValue('title')" autocomplete="off" :aria-describedby="describedBy('title')"
                  @input="onField('title', $event)" @focus="d.setFocus('title')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
              </div>
              <div class="yth-field yth-f-artist">
                <label class="ytw-label" for="yth-f-artist">{{ tt('ytdl.field.artist') }}</label>
                <input id="yth-f-artist" ref="f-artist" type="text" class="dm-input yth-input browser-default" :class="{ 'is-warn': m.artistWarn }" :value="fieldValue('artist')" autocomplete="off" :aria-describedby="describedBy('artist')"
                  @input="onField('artist', $event)" @focus="d.setFocus('artist')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
              </div>
              <div class="yth-field yth-f-album">
                <label class="ytw-label" for="yth-f-album">{{ tt('ytdl.field.album') }}</label>
                <input id="yth-f-album" ref="f-album" type="text" class="dm-input yth-input browser-default" :value="fieldValue('album')" autocomplete="off" :aria-describedby="describedBy('album')"
                  @input="onField('album', $event)" @focus="d.setFocus('album')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
              </div>
              <div class="yth-field yth-f-year">
                <label class="ytw-label" for="yth-f-year">{{ tt('ytdl.field.year') }}</label>
                <input id="yth-f-year" ref="f-year" type="text" inputmode="numeric" class="dm-input yth-input browser-default" :value="fieldValue('year')" autocomplete="off" :aria-describedby="describedBy('year')"
                  :aria-invalid="m.block === 'yearInvalid' ? 'true' : null" @input="onField('year', $event)" @focus="d.setFocus('year')" @blur="d.setFocus(null)" @keydown.enter="onEnter">
              </div>
            </div>
          </div>
          <div v-if="m.help && m.help.label" id="yth-help" class="ytp-help">{{ tl(m.help.label) }}</div>
          <div v-if="m.source" class="ytp-source" :class="'is-' + m.source.tone">
            <span class="ytp-source-ic"><yt-icon :name="m.source.tone === 'ok' ? 'check' : (m.source.tone === 'warn' ? 'warn' : 'wand')" :size="14"></yt-icon></span>
            <span>{{ tl(m.source.label) }}</span>
          </div>
          <div v-if="m.cleaned" class="ytp-cleaned">
            <div class="ytp-source is-auto"><span class="ytp-source-ic"><yt-icon name="wand" :size="14"></yt-icon></span><span>{{ tl(m.cleaned) }}</span></div>
            <div class="ytp-chips" data-yt-list="chips">
              <button v-for="c in m.chips" :key="'c' + c.index" type="button" class="ytp-chip" data-yt-row data-yt-then="title" :aria-label="tt('ytdl.putBack', { fragment: c.text })" @click="d.restore(c.index)"><span class="ytp-chip-ic"><yt-icon name="undo" :size="13"></yt-icon></span>{{ c.text }}</button>
              <button v-if="m.canUndoAll" type="button" class="dm-link" data-yt-row data-yt-then="title" @click="d.undoAll()">{{ tt('ytdl.undoAll') }}</button>
            </div>
          </div>
        </template>
      </div>

      <section v-if="m.phase === 'card'" class="yth-into" aria-labelledby="yth-into">
        <div v-if="!m.sub.open" class="yth-into-row">
          <h3 id="yth-into" class="ytw-label">{{ tt('ytdl.into') }}</h3>
          <yt-crumbs class="yth-crumbs" :items="m.crumbs"></yt-crumbs>
          <button type="button" class="dm-link yth-sort" aria-expanded="false" @click="openSub">{{ tt('ytdl.sort.open') }}</button>
        </div>
        <template v-else>
          <div class="yth-into-row"><h3 id="yth-into" class="ytw-label">{{ tt('ytdl.into') }}</h3></div>
          <div role="radiogroup" aria-labelledby="yth-into" class="ytw-lays">
            <label v-for="(o, i) in sorts" :key="o.kind" :for="'yth-sub-' + i" class="ytw-opt" :class="{ 'is-on': m.sub.kind === o.kind }" @pointerdown="pointer = true">
              <span class="ytw-opt-label">{{ tl(o.label) }}</span>
              <input :id="'yth-sub-' + i" type="radio" name="yth-sub" class="ytw-radio" :value="o.kind" :checked="m.sub.kind === o.kind" @change="pickSub(o.kind)">
            </label>
          </div>
          <div v-if="m.sub.kind === 'custom'" class="ytw-custom">
            <label class="dm-sr" for="yth-custom">{{ tt('ytdl.sort.customField') }}</label>
            <input id="yth-custom" ref="custom" type="text" class="dm-input ytw-custom-input browser-default" :class="{ 'is-err': !!m.sub.error }" :value="m.sub.custom" spellcheck="false" autocomplete="off"
              :aria-invalid="m.sub.error ? 'true' : null" :aria-describedby="m.sub.error ? 'yth-custom-err' : null" @input="d.setSubCustom($event.target.value)">
            <div v-if="m.sub.error" id="yth-custom-err" class="ytw-err" role="alert"><span class="ytw-err-ic"><yt-icon name="err" :size="12"></yt-icon></span><span>{{ tl(m.sub.error) }}</span></div>
            <div role="group" class="ytw-vars" :aria-label="tt('ytdl.where.insert')">
              <button v-for="v in vars" :key="v.name" type="button" class="ytw-var" :aria-label="v.used ? tt('ytdl.where.used', { name: tt(v.key) }) : null" @click="insertVar(v.name)"><span v-if="v.used" class="ytw-var-ic"><yt-icon name="check" :size="12"></yt-icon></span>{{ tt(v.key) }}</button>
            </div>
          </div>
          <div class="ytw-preview" aria-live="polite">
            <span class="ytw-preview-ic" :class="m.sub.fix ? 'is-warn' : 'is-src'"><yt-icon :name="m.sub.fix ? 'warn' : 'folder'" :size="14"></yt-icon></span>
            <div class="ytw-preview-text">
              <div v-if="m.sub.fix" class="ytw-fix">{{ tt('ytdl.where.fixLayout') }}</div>
              <div v-else class="yth-path"><yt-crumbs :items="m.sub.crumbs"></yt-crumbs></div>
            </div>
          </div>
        </template>
        <div v-if="m.letters" class="yth-letters"><yt-text :label="m.letters"></yt-text></div>
        <div v-if="m.trap" class="ytw-line is-warn">
          <span class="ytw-line-ic"><yt-icon name="warn" :size="15"></yt-icon></span>
          <div class="ytw-line-text">{{ tl(m.trap.label) }}<div v-if="m.trap.link" class="ytw-line-links"><button type="button" class="dm-link" @click="trapLink(m.trap.link.focus)">{{ tl(m.trap.link.label) }}</button></div></div>
        </div>
        <div v-if="m.noMkdir" class="ytw-line is-warn">
          <span class="ytw-line-ic"><yt-icon name="warn" :size="15"></yt-icon></span>
          <div class="ytw-line-text">{{ tl(m.noMkdir.label) }}
            <div class="ytw-line-links">
              <template v-if="m.noMkdir.deepest"><button type="button" class="dm-link" data-yt-then="add" @click="saveToDeepest">{{ tt('ytdl.noMkdir.saveInstead', { path: deepestText() }) }}</button><span class="ytp-dot" aria-hidden="true">·</span></template>
              <button type="button" class="dm-link" aria-haspopup="dialog" @click="openChoose">{{ tt('ytdl.noMkdir.choose') }}</button>
            </div>
          </div>
        </div>
        <div v-if="m.failure" class="ytw-line is-err" role="alert">
          <span class="ytw-line-ic"><yt-icon name="err" :size="15"></yt-icon></span>
          <div class="ytw-line-text"><yt-text :label="m.failure.label"></yt-text><div v-if="m.failure.changeFormat" class="ytw-line-links"><button type="button" class="dm-link" aria-haspopup="menu" @click="changeFormat">{{ tt('ytdl.changeFormat') }}</button></div></div>
        </div>
        <div v-else-if="m.clash" class="ytw-line is-warn">
          <span class="ytw-line-ic"><yt-icon name="warn" :size="15"></yt-icon></span>
          <div class="ytw-line-text"><yt-text :label="m.clash.label"></yt-text><div v-if="m.clash.changeFormat" class="ytw-line-links"><button type="button" class="dm-link" aria-haspopup="menu" @click="changeFormat">{{ tt('ytdl.changeFormat') }}</button></div></div>
        </div>
        <div v-if="m.reason" id="yth-reason" class="ytp-reason">{{ tl(m.reason) }}</div>
        <div class="yth-foot">
          <yt-format-menu ref="format" :value="m.format" :options="m.formats" :up="true" @pick="d.setFormat($event)"></yt-format-menu>
          <button ref="add" type="button" class="dm-btn dm-btn-primary yth-add" :class="{ 'is-busy': m.primary.busy }" :aria-disabled="m.primary.disabled ? 'true' : null"
            :aria-describedby="m.reason ? 'yth-reason' : null" @click="add">{{ tl(m.primary.label) }}</button>
        </div>
      </section>
    </div>`,
  });

  function ensureWindows() {
    if (winVm) { return winVm; }
    let el = document.getElementById('ytdl-windows');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ytdl-windows';
      document.body.appendChild(el);
    }
    winVm = new Vue({
      el,
      data: { store, downOnShade: false },
      // the explorer window's folder draft, else the panel's
      computed: { draft: function () { const w = store.win; return w && w.folder ? getFolderDraft(w.folder) : panelDraft; } },
      methods: {
        tt,
        close: () => closeWindow(),
        // A press outside the window closes it — one that began outside:
        // a drag out of a field (selecting its text) is no press outside.
        shadeDown: function (e) { this.downOnShade = e.target === e.currentTarget; },
        shadeClick: function (e) {
          const outside = this.downOnShade && e.target === e.currentTarget;
          this.downOnShade = false;
          if (outside) { closeWindow(); }
        },
      },
      template: `<div id="ytdl-windows"><div v-if="store.win" class="dmodal-shadow" @mousedown="shadeDown" @click="shadeClick">
        <div ref="win" class="dmodal ytw" :class="'ytw-' + store.win.mode" role="dialog" aria-modal="true" aria-labelledby="ytw-title" tabindex="-1">
          <button type="button" class="dmodal-close" :aria-label="tt('ytdl.close')" :title="tt('ytdl.close')" @click="close"><yt-icon name="close" :size="16"></yt-icon></button>
          <yt-where v-if="store.win.mode === 'where' && draft" :key="'w' + store.win.n" :d="draft"></yt-where>
          <yt-choose v-else-if="store.win.mode === 'choose'" :key="'c' + store.win.n" :d="draft" :start="store.win.start"></yt-choose>
          <yt-here v-else-if="store.win.mode === 'here' && draft" ref="here" :key="'h' + store.win.n" :d="draft"></yt-here>
        </div>
      </div></div>`,
    });
    return winVm;
  }

  function vpHelper(name) {
    return typeof VUEPLAYERCORE !== 'undefined' && typeof VUEPLAYERCORE[name] === 'function' ? VUEPLAYERCORE[name] : null;
  }

  function onWindowKey(e) {
    // an IME's keys (its Esc drops the words it was making) are its own
    if (!store.win || !winVm || e.isComposing || e.keyCode === 229) { return; }
    const box = winVm.$refs.win;
    if (e.key === 'Tab') {
      const tabbables = vpHelper('dmTabbables');
      const trap = vpHelper('dmTrapTarget');
      if (!box || !tabbables || !trap) { return; }
      const to = trap(tabbables(box), document.activeElement, e.shiftKey);
      if (to) { e.preventDefault(); to.focus(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeWindow();
    }
  }

  let winSeq = 0;
  // Open a window: { mode: 'where' }, { mode: 'choose', start } or the
  // explorer's { mode: 'here', folder } (openHere). One at a time: a
  // Discover window goes first, and Choose a folder takes the place of
  // the window it was asked from — of the explorer's ({ folder, back:
  // 'here' }) until it is done, when that one comes back.
  function openWindow(opts, opener) {
    const o = opts || {};
    if (o.mode !== 'where' && o.mode !== 'choose' && o.mode !== 'here') { return; }
    const closeDiscover = vpHelper('closeDiscoverModal');
    if (closeDiscover) { closeDiscover(); }
    if (o.mode === 'where' && !panelDraft) { return; }
    if (o.mode === 'here' && !o.folder) { return; }
    if (o.mode === 'where' || o.mode === 'here') { winJob = null; }
    ensureWindows();
    if (!store.win) {
      winOpener = opener && typeof opener.focus === 'function' ? opener : document.activeElement;
      document.addEventListener('keydown', onWindowKey);
    }
    store.win = { mode: o.mode, start: str(o.start) || '/', folder: o.folder || null, back: o.back || null, n: ++winSeq };
  }

  // Close the open window; the keyboard goes back where it came from — or
  // to the card's field a bracket warning asked for, or the link field.
  // Choose a folder asked from the explorer's window gives that window
  // back instead (its pick applied, or as it was).
  function closeWindow(opts) {
    if (!store.win) { return; }
    const w = store.win;
    if (w.mode === 'choose' && w.back === 'here' && w.folder) {
      store.win = { mode: 'here', start: '/', folder: w.folder, back: null, n: ++winSeq };
      return;
    }
    store.win = null;
    winJob = null;
    document.removeEventListener('keydown', onWindowKey);
    const opener = winOpener;
    winOpener = null;
    const field = opts && opts.focusField;
    Vue.nextTick(() => {
      if (field && panelVm && panelVm.$children[0]) { panelVm.$children[0].focusField(field); return; }
      // (one on screen: a re-ping under the window may have hidden the
      // bar's button — then the panel's link field, else the column's
      // heading, as Discover's window falls back)
      if (opener && opener.isConnected && typeof opener.focus === 'function' && onScreen(opener)) { opener.focus(); return; }
      if (panelVm && panelVm.$children[0]) { panelVm.$children[0].focusLink(); return; }
      const head = ['h5.panel_one_name', '.m-tab.panel_one_name'].map((sel) => document.querySelector(sel)).find(onScreen);
      if (!head) { return; }
      if (!head.hasAttribute('tabindex')) { head.setAttribute('tabindex', '-1'); }
      head.focus({ preventScroll: true });
    });
  }
  function onScreen(el) { return !!el && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0); }

  // ── the panel's instance ──

  function getPanelDraft() {
    if (!panelDraft) { panelDraft = newDraft(); }
    return panelDraft;
  }

  // The panel into `el` (m.js ytdlPanel), its draft the session's: leaving
  // and coming back keeps the link, the lookup and the edits. opts.link: a
  // link to fill in and look up at once; opts.needsLook: open at Needs a
  // look (a toast's Details).
  function mountPanel(el, opts) {
    unmountPanel();
    if (!el) { return null; }
    const d = getPanelDraft();
    if (opts && typeof opts.link === 'string' && opts.link) { d.setLink(opts.link, { immediate: true }); }
    const focus = opts && opts.needsLook ? 'needsLook' : null;
    panelVm = new Vue({ el, render: (h) => h('yt-panel', { props: { d, focus } }) });
    startClock();
    return panelVm;
  }

  // Another panel takes the column (m.js setBrowserRootPanel): no watcher
  // outlives this one. A window over it stays (it is over the page).
  function unmountPanel() {
    if (!panelVm) { return; }
    const vm = panelVm;
    panelVm = null;
    try { vm.$destroy(); } catch (_) { /* gone already */ }
    if (vm.$el && vm.$el.parentNode) { vm.$el.parentNode.removeChild(vm.$el); }
    stopClock();
  }

  function startClock() {
    if (clockTimer) { return; }
    store.now = Date.now();
    clockTimer = setInterval(() => { store.now = Date.now(); }, 30 * 1000);
  }
  function stopClock() {
    if (!clockTimer) { return; }
    clearInterval(clockTimer);
    clockTimer = null;
  }

  // ── the explorer ──

  // The explorer window for `folder` (m.js ytdlOpenWindow: the bar's
  // button, a pasted link), its draft at Right here; opts.link is filled
  // in and looked up at once, opts.opener gets the keyboard back. The
  // window open for that folder already takes the link in place.
  function openHere(folder, opts) {
    const o = opts || {};
    const key = dirOf(crumbsOf(folder));
    if (key === '/') { return; }
    const d = getFolderDraft(key);
    const open = !!store.win && store.win.mode === 'here' && store.win.folder === key;
    if (!open) { d.sheetOpened(); }
    if (typeof o.link === 'string' && o.link) { d.setLink(o.link, { immediate: true }); }
    if (open) {
      const here = winVm && winVm.$refs.here;
      if (here) { here.focusLink(); }
      return;
    }
    openWindow({ mode: 'here', folder: key }, o.opener);
  }

  // The open window, for a paste: { mode, folder } or null.
  function windowOpen() {
    return store.win ? { mode: store.win.mode, folder: store.win.folder || null } : null;
  }

  // The strip under the explorer bar (m.js ytdlRefreshExplorer, with the
  // folder on screen, or null off the explorer): "Adding “One More
  // Time”… · See all" while an add of this browser's into it runs. Its
  // words change only when they do: it is a status region.
  // A strip coming up shows first, empty, and takes its words a frame
  // later: a region that appears with its words already in it is often
  // never read.
  let stripText = null;
  let stripFrame = null;
  function renderStrip(folder) {
    const el = document.getElementById('ytdl_strip');
    if (!el) { return; }
    const v = folder && tracker ? stripView(tracker.jobsUnder(folder)) : null;
    const words = el.querySelector('.ytdl-strip-text');
    if (!v) {
      if (stripFrame) { clearTimeout(stripFrame); stripFrame = null; }
      el.classList.add('super-hide');
      if (words) { words.textContent = ''; }
      stripText = null;
      return;
    }
    const text = tl(v);
    el.classList.remove('super-hide');
    if (stripText == null || stripFrame) {
      stripText = text;
      if (stripFrame) { clearTimeout(stripFrame); }
      stripFrame = setTimeout(() => { stripFrame = null; if (words) { words.textContent = stripText; } }, 50);
      return;
    }
    if (words && text !== stripText) { words.textContent = text; }
    stripText = text;
  }

  // Words for a screen reader outside the panel and the windows (an add's
  // result: m.js ytdlToast — iziToast has no live region), into the page's
  // own status region. Emptied first, so the same words twice are read
  // twice.
  let announceTimer = null;
  function announce(text) {
    const el = document.getElementById('ytdl-announce');
    if (!el) { return; }
    el.textContent = '';
    if (announceTimer) { clearTimeout(announceTimer); }
    announceTimer = setTimeout(() => { announceTimer = null; el.textContent = str(text); }, 50);
  }

  // The explorer's entries and strip, drawn again by m.js for what the
  // column shows now.
  function explorerChanged() {
    if (typeof ytdlRefreshExplorer === 'function') { ytdlRefreshExplorer(); }
  }

  // ── wiring (m.js calls these) ──

  // The server's facts, from the ping (init) and every re-ping:
  // { uploadsOff, convertOff, noMkdir, supported, vpaths, name }. An open
  // panel keeps showing: a lost right is a line and Add off (spec §8).
  function setServer(facts) {
    const f = facts || {};
    store.server = {
      ready: true,
      uploadsOff: f.uploadsOff === true,
      convertOff: f.convertOff === true,
      noMkdir: f.noMkdir === true,
      supported: f.supported || null,
      vpaths: Array.isArray(f.vpaths) ? f.vpaths.slice() : [],
      name: str(f.name),
    };
    touch();
  }

  // The account is known (m.js, after /api answered): this browser's jobs
  // for it, its remembered choices, the pill. Again for another account: the
  // old tracker stops first.
  function start(opts) {
    const o = opts || {};
    const next = { origin: str(o.origin), user: str(o.user) };
    if (tracker && scope && scope.origin === next.origin && scope.user === next.user) { return tracker; }
    if (tracker) { try { tracker.stop(); } catch (_) { /* stopped */ } tracker = null; }
    const first = !scope;
    scope = next;
    const p = readPrefs(safeStorage(), scope);
    if (first && unscoped.choice) { writeChoice(safeStorage(), scope, store.saved); } else { store.saved = p.choice; }
    if (first && unscoped.format) { writeFormat(safeStorage(), scope, store.format); } else { store.format = p.format; }
    unscoped = { choice: false, format: false };
    tracker = jobs().createTracker({
      scope,
      tabId: jobs().tabIdOf(),
      onToast: (job) => { if (typeof ytdlToast === 'function') { ytdlToast(job); } },
    });
    tracker.attach();
    tracker.subscribe((ev) => {
      store.tick += 1;
      if (ev && ev.type === 'jobs') { renderPill(); explorerChanged(); }
      // in every tab: the folder on screen lists again, the new row ringed
      if (ev && ev.type === 'settled' && typeof ytdlSettled === 'function') { ytdlSettled(ev.job); }
    });
    // A panel up already (opened before the account was known): its rows
    // read the new tracker, which watches for it and lists Added.
    store.tick += 1;
    if (panelVm) { tracker.watch(true); tracker.loadAdded(); }
    renderPill();
    explorerChanged();
    touch();
    return tracker;
  }

  if (typeof I18N !== 'undefined' && typeof I18N.onChange === 'function') {
    I18N.onChange(() => { store.lang += 1; renderPill(); explorerChanged(); });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => drafts.forEach((d) => d.onOnline()));
  }

  return Object.assign({}, pure, {
    store,
    start, setServer, mountPanel, unmountPanel, openWindow, closeWindow, renderPill,
    openHere, windowOpen, renderStrip, announce,
    tracker: () => tracker,
    panelDraft: getPanelDraft,
    folderDraft: getFolderDraft,
    // a draft wired to this page's server, tracker and memory (one per
    // surface: the explorer window's own)
    newDraft,
  });
}));
