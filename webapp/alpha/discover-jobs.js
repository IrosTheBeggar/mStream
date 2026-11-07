// The Discover job rows' pure half: what a plug-in job looks like as a row
// ("Get it", Keep a copy, the downloads strip), where a
// download or a collection copy will land for the layout being typed (a
// variable each song files by its own tag drawn as a slot), what a copy of
// a connected server's folder takes and where it lands, which albums an
// artist copy takes and leaves out, what
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
  const LAYOUT_VARS = ['ARTIST', 'ALBUM', 'YEAR', 'GENRE', 'ALBUMARTIST', 'PEER', 'SERVERFOLDER'];
  // The server's default (src/discovery-plugins/destination.js): the album's
  // credit, falling back to the song's artist — a compilation stays together.
  const DEFAULT_LAYOUT = '{{ALBUMARTIST}}/{{ALBUM}}';
  // The editor's "Server / Artist / Album": each server's copies apart, by
  // the album's credit too.
  const PEER_LAYOUT = '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}';
  // The editor's "Same folders as the server": each song where it sits on
  // the server it came from.
  const SERVERFOLDER_LAYOUT = '{{SERVERFOLDER}}';
  const MAX_TEMPLATE_LEN = 500;
  const MAX_RESOLVED_LEN = 500;
  const MAX_SEGMENT_LEN = 200;
  const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  // The sample the server validates a layout against (SAMPLE_METADATA +
  // peer + server folder: two folders, so a layout of just
  // {{SERVERFOLDER}} validates).
  const SAMPLE_TAGS = { artist: 'Pink Floyd', album: 'The Dark Side of the Moon', year: '1973', genre: 'Progressive Rock', albumartist: 'Pink Floyd' };
  const SAMPLE_PEER = "Sam's server";
  const SAMPLE_SERVERFOLDER = 'Pink Floyd/The Dark Side of the Moon';

  function sanitizeSegment(raw) {
    if (raw == null) { return ''; }
    let s = String(raw);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
    // a "~" or a "$HOME" in a tag is a name, not a shell string: folded, as
    // the server folds it (validateResolvedPath refuses both in a path)
    s = s.replace(/\$\{HOME\}|\$HOME\b|~/g, '-');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > MAX_SEGMENT_LEN) { s = s.slice(0, MAX_SEGMENT_LEN); }
    return s;
  }

  // A value that is folders ({{SERVERFOLDER}}: "Boukmanflow/Borrowed
  // Tapes"): split on either separator, each made safe as sanitizeSegment
  // makes a tag, the ones that come out empty ('', '.', '..') dropped,
  // joined with '/' — it may add folders to the path, never climb out.
  function sanitizeFolders(raw) {
    if (raw == null) { return ''; }
    return String(raw).split(/[/\\]+/).map((s) => sanitizeSegment(s)).filter(Boolean).join('/');
  }

  // {{SERVERFOLDER}} of a song on a connected server (federation-copy
  // serverFolderOf): the folder its file sits in there (`filepath`, the
  // peer's path, its library first), the library's own name dropped —
  // where a folder copy mirrors it. Several folders, or '' for a song at
  // the library's root (and for no path: a download), which drops out.
  function serverFolderOf(filepath) {
    const segs = String(filepath == null ? '' : filepath).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
    return sanitizeFolders(segs.slice(1, -1).join('/'));
  }

  // `truncate: false` is resolveTemplate's: the path whole, never cut at
  // MAX_RESOLVED_LEN — what renderTarget files by, so previewTarget refuses
  // (path_too_long) the path the server refuses.
  function resolveLayout(layout, meta, { truncate = true } = {}) {
    if (!layout || typeof layout !== 'string') { return { path: '', missingVars: [] }; }
    const m = meta || {};
    const lookup = {
      ARTIST: sanitizeSegment(m.artist),
      ALBUM: sanitizeSegment(m.album),
      YEAR: sanitizeSegment(m.year),
      GENRE: sanitizeSegment(m.genre),
      ALBUMARTIST: sanitizeSegment(m.albumartist || m.artist),
      PEER: sanitizeSegment(m.peer),
      // several folders: inside literal text ("Copy of {{SERVERFOLDER}}")
      // the value's own folders follow the literal's
      SERVERFOLDER: sanitizeFolders(m.serverfolder),
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
    if (truncate && path.length > MAX_RESOLVED_LEN) { path = path.slice(0, MAX_RESOLVED_LEN); }
    return { path, missingVars: missing };
  }

  // { valid: true } or { valid: false, error, variable?, token? } — `error` is the
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
    // an unknown variable: its name, and the token as typed ("{{ Artst }}")
    for (const tok of tokens) {
      if (LAYOUT_VARS.indexOf(tok.name) === -1) { return { valid: false, error: 'unknown_variable', variable: tok.name, token: tok.raw }; }
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(layout)) { return { valid: false, error: 'invalid_chars' }; }
    if (layout.startsWith('/') || layout.startsWith('\\')) { return { valid: false, error: 'absolute_template' }; }
    const sample = resolveLayout(layout, { ...SAMPLE_TAGS, peer: SAMPLE_PEER, serverfolder: SAMPLE_SERVERFOLDER }).path;
    const check = validateResolvedPath(sample);
    return check.valid ? { valid: true } : check;
  }

  // A base folder's folders as the server reads them, not yet checked:
  // either separator, names trimmed, empty ones gone.
  function baseFolders(base) {
    return String(base == null ? '' : base).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
  }

  function normalizeBase(base) {
    const raw = baseFolders(base);
    if (raw === '') { return { valid: true, base: '' }; }
    const check = validateResolvedPath(raw);
    return check.valid ? { valid: true, base: raw } : { valid: false, error: check.error };
  }

  // `layout` with the base folder `base` in front of it. The editor keeps
  // no base folder of its own (the terminal does, on the one setting the
  // account has), so it holds a destination's as the start of the layout:
  // the server files a song at base folder / rendered layout, and so files
  // it at the same place from base '' and this layout — except where a
  // folder's name has a brace (bracedFolder: a layout reads it as a
  // variable, or refuses it), and past MAX_TEMPLATE_LEN, where the layout
  // is refused. A base normalizeBase refuses comes in front as read, for
  // validateLayout to name. No base folder: `layout` as it is. (The phone's
  // foldBase, lib/util/discover_jobs.dart.)
  function foldBase(base, layout) {
    const folders = baseFolders(base);
    return folders ? `${folders}/${layout}` : layout;
  }

  // The first of `base`'s folders a layout cannot hold as that folder: one
  // whose name has a brace ("{{PEER}}" files under the server's name).
  // null when there is none.
  function bracedFolder(base) {
    for (const folder of baseFolders(base).split('/')) {
      if (folder.indexOf('{') !== -1 || folder.indexOf('}') !== -1) { return folder; }
    }
    return null;
  }

  // A layout's leading folders that name no variable — where every copy
  // lands whatever its tags ("From friends/{{ARTIST}}" → "From friends",
  // trimmed, joined with '/') — and the rest of it as typed ("{{ARTIST}}").
  // → { folders, rest }
  function layoutLead(layout) {
    const parts = String(layout == null ? '' : layout).split(/([/\\]+)/);
    const folders = [];
    let i = 0;
    for (; i < parts.length; i += 2) {
      const seg = parts[i].trim();
      if (seg.indexOf('{') !== -1 || seg.indexOf('}') !== -1) { break; }
      if (seg) { folders.push(seg); }
    }
    return { folders: folders.join('/'), rest: parts.slice(i).join('') };
  }

  // `layout` starting in `folder` instead of its own leading folders (the
  // editor's folder list: "Start from an existing folder…"); '' leaves the
  // rest alone.
  function startLayoutAt(folder, layout) {
    return [baseFolders(folder), layoutLead(layout).rest].filter(Boolean).join('/');
  }

  function safeFileName(filePath) {
    const last = String(filePath || '').split('/').filter(Boolean).pop() || '';
    // eslint-disable-next-line no-control-regex
    let name = last.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
    if (name === '' || name === '..') { name = 'track'; }
    return name;
  }

  // Where one song lands: the library, the base folder, what the layout
  // rendered from the tags (`tags.serverfolder`: {{SERVERFOLDER}}, the
  // folders it sits in on the server — destination.js renderTarget's
  // serverFolder), the file. `error` is set (and `rendered` empty) when the
  // layout or the base folder would be refused; `missingVars` names the
  // variables this song has no value for — their segments drop out.
  function previewTarget({ vpath, base, layout, tags, peerName, fileName }) {
    const t = tags || {};
    const b = normalizeBase(base);
    const l = validateLayout(layout);
    const file = safeFileName(fileName);
    if (!b.valid) { return { valid: false, error: b.error, field: 'base', library: vpath || '', base: '', rendered: '', file, relPath: '', missingVars: [] }; }
    if (!l.valid) { return { valid: false, error: l.error, variable: l.variable || null, field: 'layout', library: vpath || '', base: b.base, rendered: '', file, relPath: '', missingVars: [] }; }
    const { path: rendered, missingVars } = resolveLayout(layout, {
      artist: t.artist, album: t.album, year: t.year, genre: t.genre, albumartist: t.albumartist, peer: peerName, serverfolder: t.serverfolder,
    }, { truncate: false });
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

  // ── what a copy of one scope files by ──────────────────────────────────
  // The server files every song of a copy by ITS OWN tags (destination.js
  // tagsForLayout + renderTarget, per song): {{ARTIST}}, {{YEAR}} and
  // {{GENRE}} are each song's, so the songs of one album can land in more
  // than one folder — a compilation's under each track artist. {{ALBUM}},
  // {{ALBUMARTIST}} (the album's credit) and {{PEER}} are the same for every
  // song of an album — not of a folder, whose songs may sit in albums of
  // different credits ({{ALBUMARTIST}} each song's album's). {{SERVERFOLDER}}
  // is each song's too: where its file sits on the server (federation-copy
  // serverFolderOf). Where this client cannot promise the one value every
  // song files under, the path draws a SLOT in its place ("‹artist›",
  // inside its folder's own text), never one folder that will not exist.
  const SLOT_VARS = ['ARTIST', 'YEAR', 'GENRE', 'SERVERFOLDER', 'ALBUMARTIST'];

  // A value every song shares: { agree, value } — the same folder name for
  // each (as sanitizeSegment writes it; none is a value too: the folder
  // drops out for all of them).
  function sharedTag(values) {
    const names = values.map((v) => sanitizeSegment(v));
    return names.every((n) => n === names[0]) ? { agree: true, value: values[0] == null ? null : values[0] } : { agree: false, value: null };
  }

  // The genre a song's copy files under, where a song's metadata (a
  // connected server's, its `genres`) tells it for certain: its one genre.
  // The library splits a genre tag on "," ";" and "/" into its genres
  // (src/db/scanner.mjs), the copy files by the tag as the file has it
  // (destination.js tagsForLayout: the first) — a "Hip-Hop/Rap" lists as
  // two and lands in "Hip-Hop-Rap" — so a song that lists more than one, or
  // none, is unknown. → the genre, or null
  function songGenre(md) {
    const genres = md && Array.isArray(md.genres) ? md.genres.filter((g) => typeof g === 'string' && g.trim()) : [];
    return genres.length === 1 ? genres[0] : null;
  }

  // One song of an album's listing (a connected server's album-songs, asked
  // as the album copy asks it) as the copy files it (federation-copy
  // listAlbumSongs + destination.js tagsForLayout): its artist tag as
  // written, else the listed artist, else the credit the listing was asked
  // by (`credit`); its own year — the copy has nothing to fall back to —
  // its genre as songGenre reads the genres the listing names for it, and
  // the folder its file sits in on the server (serverFolderOf).
  // → { artist, year, genre, serverfolder }
  function listedSongTags(song, credit) {
    const md = song && song.metadata && typeof song.metadata === 'object' ? song.metadata : {};
    return { artist: md['artist-display'] || md.artist || credit || null, year: md.year || null, genre: songGenre(md), serverfolder: serverFolderOf(song && song.filepath) };
  }

  // The tags a copy of `scope` renders the layout with, and the variables it
  // draws as slots (scopeTarget's `slots`). `tags` are the caller's (vp.js
  // dmScopeTags; `serverfolder` the row's own, serverFolderOf its path):
  //   song            the song's own; {{GENRE}} a slot unless the caller has
  //                   the song's genre (songGenre)
  //   album           {{ARTIST}} and {{YEAR}} the value every song of the
  //                   album agrees on (`songs`: the album's listing, each
  //                   song's tags as listedSongTags reads them), else a
  //                   slot; before the listing answers, the row's own —
  //                   unless the album is a compilation (`compilation`: its
  //                   credit is not the row's artist), then slots.
  //                   {{GENRE}} a slot unless every song's genre is known
  //                   and agrees (the listing names each song's genres —
  //                   listedSongTags). {{SERVERFOLDER}} the folder every
  //                   listed song sits in on the server, else a slot; before
  //                   the listing answers, the row's. {{ALBUMARTIST}} the
  //                   album's credit: its albumartist, else the row's
  //                   artist — never a slot
  //   artist,         the caller's (the artist as ARTIST and ALBUMARTIST,
  //   artist-missing  no album: scopeTarget cuts at the album's folder);
  //                   {{GENRE}} and {{SERVERFOLDER}} slots (the one missing
  //                   album scopeTarget names has a folder of its own there)
  //   folder          "By your layout": no tags of its own — `songs` are the
  //                   folder's (each as folderSongTags reads the peer's
  //                   metadata batch). {{ARTIST}}, {{YEAR}}, {{GENRE}} (known
  //                   for every song) and {{SERVERFOLDER}} the value every
  //                   song agrees on, else a slot; {{ALBUM}} the album every
  //                   song agrees on, else ALBUM among the slots — scopeTarget
  //                   draws "one folder per album" from the folder that names
  //                   it; {{ALBUMARTIST}} the songs' album credit when every
  //                   one names it and they agree; when none names one (a
  //                   peer before 2026-10-23) none: scopeTarget draws it as
  //                   {{ARTIST}} (each song's credit falls back to its
  //                   artist); else — credits that disagree, or only some
  //                   named — a slot: the copy files each song under its own
  //                   album's credit (federation-copy copyOne), the rest
  //                   under their artist. No songs (none read: past 100, no
  //                   answer): every one a slot, ALBUM too
  // → { tags, slots }
  function scopeTags({ scope, tags, songs, compilation }) {
    const t = Object.assign({}, tags || {});
    const slots = [];
    if (scope === 'album') {
      t.albumartist = t.albumartist || t.artist || null;
      const listed = Array.isArray(songs) && songs.length > 0 ? songs.map((x) => x || {}) : null;
      for (const key of ['artist', 'year']) {
        const shared = listed ? sharedTag(listed.map((x) => x[key])) : { agree: !compilation, value: t[key] };
        if (shared.agree) { t[key] = shared.value; } else { slots.push(key.toUpperCase()); }
      }
      const genres = listed ? listed.map((x) => x.genre) : [];
      const genre = listed && genres.every((g) => sanitizeSegment(g) !== '') ? sharedTag(genres) : { agree: false };
      if (genre.agree) { t.genre = genre.value; } else { slots.push('GENRE'); }
      // folders compared whole: "AC/DC" (two) is not "AC-DC" (one)
      const folders = (listed || [t]).map((x) => sanitizeFolders(x.serverfolder));
      if (folders.every((f) => f === folders[0])) { t.serverfolder = folders[0]; } else { slots.push('SERVERFOLDER'); }
    } else if (scope === 'artist' || scope === 'artist-missing') {
      t.genre = null;
      t.serverfolder = null;
      slots.push('GENRE', 'SERVERFOLDER');
    } else if (scope === 'folder') {
      const listed = Array.isArray(songs) && songs.length > 0 ? songs.map((x) => x || {}) : null;
      for (const key of ['artist', 'year', 'album']) {
        const shared = listed ? sharedTag(listed.map((x) => x[key])) : { agree: false };
        t[key] = shared.agree ? shared.value : null;
        if (!shared.agree) { slots.push(key.toUpperCase()); }
      }
      const known = (key) => listed && listed.every((x) => sanitizeSegment(x[key]) !== '');
      const genre = known('genre') ? sharedTag(listed.map((x) => x.genre)) : { agree: false };
      t.genre = genre.agree ? genre.value : null;
      if (!genre.agree) { slots.push('GENRE'); }
      // folders compared whole, as the album's
      const folders = (listed || []).map((x) => sanitizeFolders(x.serverfolder));
      const oneFolder = !!listed && folders.every((f) => f === folders[0]);
      t.serverfolder = oneFolder ? folders[0] : null;
      if (!oneFolder) { slots.push('SERVERFOLDER'); }
      const named = listed ? listed.filter((x) => sanitizeSegment(x.albumartist) !== '').length : 0;
      const credit = named && known('albumartist') ? sharedTag(listed.map((x) => x.albumartist)) : { agree: false };
      t.albumartist = credit.agree ? credit.value : null;
      if (named && !credit.agree) { slots.push('ALBUMARTIST'); }
    } else if (sanitizeSegment(t.genre) === '') {
      slots.push('GENRE');
    }
    return { tags: t, slots };
  }

  // ── where a copy of one scope lands ────────────────────────────────────
  // The path bar, the editor's preview and the "Into" line of a running
  // copy render the base folder and the layout with the tags of what the
  // scope copies — never the seed song's own folder for a wider scope. The
  // caller hands in the scope's tags and slots (scopeTags):
  //   song            the song's own; the file on a line of its own
  //   album           the album's: its credit as ALBUMARTIST, so a
  //                   compilation stays in one folder
  //   artist          the artist as ARTIST and ALBUMARTIST, no album: the
  //                   first folder that names an album ({{ALBUM}}, or
  //                   {{YEAR}} or {{SERVERFOLDER}} — each album has its
  //                   own) and every folder after it become one "one folder
  //                   per album" note; a layout that names no album adds
  //                   nothing (every album shares that folder)
  //   artist-missing  the same — or, when exactly one album is missing
  //                   (`oneAlbum`: its { name, year }), that album's folder
  //   folder          a folder from a connected server, by its `landing`
  //                   (folderTarget): "By your layout" ({ tags: true }) is
  //                   the layout with scopeTags' folder rule — ALBUM among
  //                   the slots cuts as the artist's does, and {{ALBUMARTIST}}
  //                   with no credit of the songs' own is drawn as {{ARTIST}}
  //                   is, its slot too (the engine's own fallback)
  // `slots` names the variables drawn as slots (SLOT_VARS; any other is
  // ignored): a folder that names one keeps its own text around it, and
  // never drops out. The answer is previewTarget's (valid, error, field,
  // variable, missingVars: the editor's checks — a slot is never "missing")
  // plus `crumbs` — the base folder's segments ({ text, kind: 'base' }),
  // what the layout rendered ({ text, kind: 'rendered' }; one with a slot
  // in it adds `parts`: [{ text } | { slot, key }], the caller translates
  // the key, and its `text` writes the slot as its {{VAR}}) and the note
  // ({ key, kind: 'note' }) — `slots`, the ones the path shows, in its
  // order; `file` for a song alone, and `title`, the plain path for a
  // tooltip.
  const ALBUM_FOLDER_RE = /\{\{\s*(album|year|serverfolder)\s*\}\}/i;
  // A slot rides through the engine as a mark no tag or layout carries (two
  // private-use characters, U+E000 and U+E001, around the variable's name):
  // sanitizeSegment and the path checks pass it untouched, and each folder
  // is read back into its text and its slots.
  const SLOT_OPEN = '\uE000';
  const SLOT_CLOSE = '\uE001';
  const SLOT_RE = /\uE000([A-Z]+)\uE001/g;
  const slotMark = (name) => SLOT_OPEN + name + SLOT_CLOSE;
  const slotToken = (path) => path.replace(SLOT_RE, (m, name) => '{{' + name + '}}');

  function renderedCrumb(folder) {
    if (folder.search(SLOT_RE) === -1) { return { text: folder, kind: 'rendered' }; }
    const parts = [];
    const literal = (text) => { const s = text.replace(/[\uE000\uE001]/g, ''); if (s) { parts.push({ text: s }); } };
    let at = 0;
    folder.replace(SLOT_RE, (m, name, i) => {
      literal(folder.slice(at, i));
      parts.push({ slot: name, key: 'discover.modal.dest.slot.' + name.toLowerCase() });
      at = i + m.length;
      return m;
    });
    literal(folder.slice(at));
    return { text: slotToken(folder), kind: 'rendered', parts };
  }

  function scopeTarget({ vpath, base, layout, scope, tags, peerName, fileName, oneAlbum, slots, landing, folder, songs }) {
    const s = JOB_SCOPES.indexOf(scope) !== -1 ? scope : 'song';
    if (s === 'folder' && landingMode(landing) !== 'tags') { return folderTarget({ vpath, base, layout, landing, folder, songs }); }
    const t = Object.assign({}, tags || {});
    const one = s === 'artist-missing' && oneAlbum && oneAlbum.name ? oneAlbum : null;
    if (one) { t.album = one.name; t.year = one.year || null; }
    const byAlbum = s === 'folder' && Array.isArray(slots) && slots.indexOf('ALBUM') !== -1;
    const wide = ((s === 'artist' || s === 'artist-missing') && !one) || byAlbum;
    const per = SLOT_VARS.filter((v) => Array.isArray(slots) && slots.indexOf(v) !== -1);
    const target = previewTarget({ vpath, base, layout, tags: t, peerName, fileName });
    const out = Object.assign({}, target, { scope: s, perAlbum: false, slots: [], crumbs: [], file: s === 'song' ? target.file : null, title: target.library });
    if (s === 'folder') { Object.assign(out, { landing: 'tags', files: null, straightIn: null }); }
    if (!target.valid) { return out; }
    let shown = String(layout);
    if (wide) {
      const folders = shown.split(/[/\\]+/);
      const at = folders.findIndex((f) => ALBUM_FOLDER_RE.test(f));
      if (at !== -1) { shown = folders.slice(0, at).join('/'); out.perAlbum = true; }
    }
    let marked = out.rendered;
    if (out.perAlbum || per.length) {
      // the album's credit stays the album's when its artist is a slot
      const meta = { artist: t.artist, genre: t.genre, albumartist: t.albumartist || t.artist, peer: peerName };
      if (!out.perAlbum) { meta.album = t.album; meta.year = t.year; meta.serverfolder = t.serverfolder; }
      for (const v of per) { meta[v.toLowerCase()] = slotMark(v); }
      const head = resolveLayout(shown, meta);
      marked = head.path;
      out.rendered = slotToken(marked);
      out.missingVars = head.missingVars;
      out.relDir = [out.base, out.rendered].filter(Boolean).join('/');
      out.relPath = out.perAlbum ? out.relDir : (out.relDir ? `${out.relDir}/${target.file}` : target.file);
    }
    out.crumbs = pathCrumbs(out.base).map((text) => ({ text, kind: 'base' }))
      .concat(pathCrumbs(marked).map(renderedCrumb));
    for (const c of out.crumbs) {
      for (const p of c.parts || []) { if (p.slot && out.slots.indexOf(p.slot) === -1) { out.slots.push(p.slot); } }
    }
    if (out.perAlbum) { out.crumbs.push({ key: 'discover.modal.dest.perAlbum', kind: 'note' }); }
    out.title = [out.library, out.base, out.rendered].filter(Boolean).join('/');
    // a folder has no one file; where the path is one folder, every song
    // lands in it: its files by name
    if (s === 'folder') { out.relPath = out.relDir; out.files = out.perAlbum || out.slots.length ? null : folderFiles(songs, { flat: true }); }
    return out;
  }

  // ── a folder from a connected server ───────────────────────────────────
  // federation-copy's folder half, mirrored: what a folder copy takes
  // (planFolder) and where it lands (landingFor), so the window counts,
  // lists and places the folder the way the copy will. Any change to the
  // rules there has to be made here too — the unit test holds the two
  // together.

  // src/discovery-plugins/recommendation.js normalizePeerPath: either
  // separator, names trimmed, the empty ones and '.' dropped.
  function normalizePeerPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.').join('/');
  }

  // A folder's path inside the peer's library: its first segment (the
  // library's own name) dropped, each folder made safe, the empty ones
  // gone — what a mirrored folder lands as (federation-copy
  // insidePeerLibrary; serverFolderOf is a song's: its file's folder).
  function insidePeerLibrary(folder) {
    return sanitizeFolders(normalizePeerPath(folder).split('/').slice(1).join('/'));
  }

  // src/db/scan-ignore.js isIgnoredRelPath (the scanner's defaults): a
  // path through a folder the scanner never walks — a recycle bin, a
  // snapshot, VCS or OS litter, a dot folder — or to a dot file. A dot
  // entry is ONE leading dot ("...Trilogy" is a name).
  const IGNORED_DIR_NAMES = ['$recycle.bin', '#recycle', '@recycle', '@recently-snapshot', '#snapshot', '.git', 'lost+found', '.stfolder', '.stversions', 'system volume information'];
  const isDotEntry = (name) => name.startsWith('.') && !name.startsWith('..');
  function isIgnoredRelPath(relPath) {
    const segs = relPath.split('/');
    return segs.some((seg, i) => seg !== '' && (i === segs.length - 1
      ? isDotEntry(seg)
      : IGNORED_DIR_NAMES.indexOf(seg.toLowerCase()) !== -1 || isDotEntry(seg)));
  }

  // destination.js isSupportedAudioFile, by the ping's supportedAudioFiles
  // ({ mp3: true, … }): the file's extension, any case.
  function isSupportedAudioFile(fileName, supported) {
    const ext = String(fileName || '').split('/').pop().split('.').slice(1).pop();
    return !!ext && !!supported && supported[ext.toLowerCase()] === true;
  }

  // What a folder copy takes (federation-copy planFolder): every file the
  // peer's recursive listing names under `folderPath` (its library first),
  // in path order, each with the folder it sits in relative to the pressed
  // one (`relDir`, each folder made safe), and what it leaves out, with
  // why — 'outside' (not under the folder, or climbing), 'ignored' (the
  // scanner's rules), 'unsupported' (a file this server does not play:
  // `supported` is the ping's supportedAudioFiles; without it every file
  // the listing names is taken). The window's count and its file list.
  // → { songs: [{ filepath, relDir }], skipped: [{ from, why }] }
  function planFolder(listing, folderPath, { supported = null } = {}) {
    const dir = normalizePeerPath(folderPath);
    const prefix = dir ? `${dir}/` : '';
    const songs = [];
    const skipped = [];
    const seen = new Set();
    for (const raw of (Array.isArray(listing) ? listing : [])) {
      if (typeof raw !== 'string') { continue; }
      const p = normalizePeerPath(raw);
      if (!p || seen.has(p)) { continue; }
      seen.add(p);
      if (prefix && !p.startsWith(prefix)) { skipped.push({ from: raw, why: 'outside' }); continue; }
      const rel = prefix ? p.slice(prefix.length) : p;
      const segs = rel.split('/');
      if (segs.some((x) => x === '..')) { skipped.push({ from: raw, why: 'outside' }); continue; }
      if (isIgnoredRelPath(rel)) { skipped.push({ from: raw, why: 'ignored' }); continue; }
      if (supported && !isSupportedAudioFile(segs[segs.length - 1], supported)) { skipped.push({ from: raw, why: 'unsupported' }); continue; }
      songs.push({ filepath: p, relDir: segs.slice(0, -1).map((x) => sanitizeSegment(x)).filter(Boolean).join('/') });
    }
    songs.sort((a, b) => a.filepath.localeCompare(b.filepath, undefined, { numeric: true, sensitivity: 'base' }));
    return { songs, skipped };
  }

  // A planned folder's numbers for the window's header ("9 songs · 3
  // subfolders"): its songs, and the subfolders that hold any — every
  // folder on a song's way down from the pressed one, counted once.
  function folderCounts(songs) {
    const list = Array.isArray(songs) ? songs.filter((x) => x && typeof x.filepath === 'string') : [];
    const folders = new Set();
    for (const song of list) {
      const segs = String(song.relDir || '').split('/').filter(Boolean);
      for (let i = 1; i <= segs.length; i++) { folders.add(segs.slice(0, i).join('/')); }
    }
    return { songs: list.length, subfolders: folders.size };
  }

  // One song of a folder (an entry of the peer's metadata batch:
  // { filepath, metadata }) as "By your layout" files it — listedSongTags'
  // artist, year, genre and folder on the server, plus its album and the
  // album's credit ('album-artist': the album's own, else its primary
  // artist — a server that sends it; none for a song in no album).
  // → { artist, year, genre, serverfolder, album, albumartist }
  function folderSongTags(song) {
    const md = song && song.metadata && typeof song.metadata === 'object' ? song.metadata : {};
    return Object.assign(listedSongTags(song, null), { album: md.album || null, albumartist: md['album-artist'] || null });
  }

  // A folder job's landing as the wire carries it (the window's choice, a
  // job's params.landing — destination.js validateLanding), by its mode:
  // none (as on the peer: 'mirror'), { vpath?, path } ('folder'), or
  // { tags: true } ('tags').
  function landingMode(landing) {
    if (landing && landing.tags === true) { return 'tags'; }
    if (landing && (typeof landing.path === 'string' || landing.vpath)) { return 'folder'; }
    return 'mirror';
  }

  // The other way: the landing a start sends for a mode — null for
  // 'mirror' (sent as none), { vpath, path } for 'folder' (`into`, the
  // chosen library and folder; '' the library's root), { tags: true }.
  function folderLanding(mode, into) {
    if (mode === 'tags') { return { tags: true }; }
    if (mode === 'folder') { return { vpath: (into && into.vpath) || null, path: (into && typeof into.path === 'string') ? into.path : '' }; }
    return null;
  }

  // "Into a folder…"'s first place: a new folder in the saved library
  // named as the pressed one, its name made safe as a mirror makes it
  // ("copies › Borrowed Tapes"), so the folder keeps its name unless the
  // user goes elsewhere. → { vpath, path }
  function folderIntoDefault(destination, folder) {
    return { vpath: (destination && destination.vpath) || null, path: sanitizeSegment(normalizePeerPath(folder).split('/').pop() || '') };
  }

  // At most FOLDER_FILE_LINES of a folder's songs (planFolder's, in path
  // order) as where each lands below the path drawn: its folder relative
  // to the pressed one first ("Harbour Lights/01 - Tide.mp3"), or — `flat`,
  // "By your layout", where every song files by the layout — its file
  // name alone; `more` the songs past those. null without songs.
  const FOLDER_FILE_LINES = 3;
  function folderFiles(songs, { flat = false } = {}) {
    if (!Array.isArray(songs)) { return null; }
    const list = songs.filter((x) => x && typeof x.filepath === 'string');
    const lines = list.slice(0, FOLDER_FILE_LINES).map((x) => (flat ? safeFileName(x.filepath) : [x.relDir, safeFileName(x.filepath)].filter(Boolean).join('/')));
    return { lines, more: list.length - lines.length };
  }

  // Where a folder copy lands as on the peer ('mirror') or into a folder
  // ('folder') — scopeTarget's, for a landing other than "By your layout"
  // (federation-copy landingFor):
  //   mirror  the destination's library, its base folder, the layout's
  //           leading folders that name no variable (layoutLead: "From
  //           friends/{{ALBUMARTIST}}/{{ALBUM}}" → "From friends"), then
  //           the folder's path inside the peer's library, the library's
  //           own name dropped — never through the rest of the layout
  //   folder  the chosen library (`landing.vpath`, else the destination's)
  //           and folder (`landing.path`, under the base folder's rules;
  //           '' its root): the pressed folder's files go straight in,
  //           its subfolders beneath — `straightIn` ({ key, params }) says
  //           so when that folder is not named as the pressed one
  // `folder` is the pressed folder's path on the peer, `songs` what the
  // copy takes (planFolder). → scopeTarget's answer — `field` 'base' or
  // 'landing' for a place the copy would refuse, the fixed folders as
  // crumbs of kind 'base', the peer's as 'rendered' — plus `landing` (the
  // mode), `files` (folderFiles: { lines, more }, or null) and `straightIn`.
  function folderTarget({ vpath, base, layout, landing, folder, songs }) {
    const mode = landingMode(landing);
    const out = {
      valid: true, error: null, field: null, variable: null, scope: 'folder', landing: mode, library: vpath || '', base: '', rendered: '',
      relDir: '', relPath: '', missingVars: [], perAlbum: false, slots: [], crumbs: [], file: null, title: vpath || '', files: null, straightIn: null,
    };
    let fixed;
    let peerPath = '';
    if (mode === 'folder') {
      out.library = landing.vpath || vpath || '';
      const chosen = normalizeBase(landing.path);
      if (!chosen.valid) { return Object.assign(out, { valid: false, error: chosen.error, field: 'landing', title: out.library }); }
      fixed = normalizePeerPath(chosen.base);
      const name = normalizePeerPath(folder).split('/').pop() || '';
      const into = fixed.split('/').pop() || '';
      if (sanitizeSegment(into).toLowerCase() !== sanitizeSegment(name).toLowerCase()) {
        out.straightIn = { key: 'discover.keep.landing.straightIn', params: { folder: into || out.library, name } };
      }
    } else {
      const b = normalizeBase(base);
      if (!b.valid) { return Object.assign(out, { valid: false, error: b.error, field: 'base' }); }
      out.base = b.base;
      fixed = [b.base, layoutLead(layout).folders].filter(Boolean).join('/');
      peerPath = insidePeerLibrary(folder);
    }
    const dir = [fixed, peerPath].filter(Boolean).join('/');
    if (dir) {
      const check = validateResolvedPath(dir);
      if (!check.valid) { return Object.assign(out, { valid: false, error: check.error, field: 'landing', straightIn: null }); }
    }
    out.rendered = out.base ? dir.slice(out.base.length + 1) : dir;
    out.relDir = dir;
    out.relPath = dir;
    out.crumbs = pathCrumbs(fixed).map((text) => ({ text, kind: 'base' })).concat(pathCrumbs(peerPath).map((text) => ({ text, kind: 'rendered' })));
    out.title = [out.library, dir].filter(Boolean).join('/');
    out.files = folderFiles(songs);
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
  // artist's albums, only the ones the library lacks, or a folder of a
  // connected server's (only from its file explorer). The window keeps
  // one job per plug-in AND scope, under a slot: the plug-in's name for a
  // song job (as it always was), "<plugin>@<scope>" for the others.
  const JOB_SCOPES = ['song', 'album', 'artist', 'artist-missing', 'folder'];

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
    if (scope === 'folder') { return 'discover.tray.kindFolder'; }
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

  // The most songs one folder copy takes on this server (the plug-in
  // listing's jobs.maxFolderSongs — the admin's discoveryJobs
  // .maxFolderSongs): a whole number, or null when the listing does not
  // say (an older server: no cap is known, and a job past it fails in the
  // server's own words).
  function maxFolderSongs(listing) {
    const jobs = listing && listing.jobs && typeof listing.jobs === 'object' ? listing.jobs : null;
    const n = jobs && jobs.maxFolderSongs != null ? Number(jobs.maxFolderSongs) : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  }

  // ── an artist copy's albums ────────────────────────────────────────────
  // src/db/name-key.js nameKey, mirrored: how the copy matches artist and
  // album names — whitespace runs collapsed, quote and dash variants
  // folded, lowercased.
  function nameKey(raw) {
    if (raw == null) { return ''; }
    return String(raw).replace(/\s+/g, ' ').trim()
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .toLowerCase();
  }

  // Which of the peer's albums an artist copy takes (federation-copy
  // planArtistAlbums, mirrored): the ones whose album artist IS the artist
  // — its credit, or one of its artists outside a compilation. An album
  // they merely appear on is left out ('appearance'); with `onlyMissing`,
  // so is one this library has by name (`localKeys`: a Set of nameKeys).
  // The singles bucket (no album name) is no album: `singles` says the
  // listing (the peer's artists-albums answer) has one — its songs stay
  // out too. A planned album carries its own credit (`albumArtist`, null
  // when its rows disagree).
  // → { plan: [{ name, year, trackCount, albumArtist }],
  //     skipped: [{ name, year, trackCount, why }], singles }
  function planArtistAlbums(listing, artist, { localKeys = new Set(), onlyMissing = false } = {}) {
    const key = nameKey(artist);
    const rows = Array.isArray(listing && listing.albums) ? listing.albums : [];
    const plan = [];
    const skipped = [];
    let singles = false;
    for (const al of rows) {
      if (!al || typeof al !== 'object') { continue; }
      if (al.name == null || (typeof al.name === 'string' && !al.name.trim())) { singles = true; continue; }
      if (typeof al.name !== 'string') { continue; }
      const year = al.year == null || !Number.isFinite(Number(al.year)) ? null : Number(al.year);
      const entry = { name: al.name, year, trackCount: Number.isFinite(Number(al.track_count)) && al.track_count !== null ? Number(al.track_count) : null };
      const credited = Array.isArray(al.artists) && al.artists.some((n) => nameKey(n) === key);
      const theirs = nameKey(al.album_artist) === key || (credited && al.compilation !== true);
      if (!theirs) { skipped.push(Object.assign({}, entry, { why: 'appearance' })); continue; }
      if (onlyMissing && localKeys.has(nameKey(al.name))) { skipped.push(Object.assign({}, entry, { why: 'owned' })); continue; }
      plan.push(Object.assign({}, entry, { albumArtist: typeof al.album_artist === 'string' && al.album_artist.trim() ? al.album_artist : null }));
    }
    return { plan, skipped, singles };
  }

  // The artist copy's "left out" line (the window's, under Artist): the
  // albums the listing names that the artist only appears on — one by
  // name, several counted — then, when the listing has a singles bucket,
  // that songs outside an album stay out too. `parts` for the caller to
  // translate and join with a space; `albums` their names. null when the
  // copy leaves nothing out, or the listing is unknown.
  // → { albums, singles, parts: [{ key, params? }] } | null
  function artistLeftOut(listing, artist) {
    if (!listing || !Array.isArray(listing.albums)) { return null; }
    const { skipped, singles } = planArtistAlbums(listing, artist);
    const guest = skipped.filter((a) => a.why === 'appearance');
    const parts = [];
    if (guest.length === 1) { parts.push({ key: 'discover.keep.leftOutOne', params: { album: guest[0].name, artist } }); }
    if (guest.length > 1) { parts.push({ key: 'discover.keep.leftOutMany', params: { count: guest.length, artist } }); }
    if (singles) { parts.push({ key: 'discover.keep.leftOutSingles' }); }
    return parts.length ? { albums: guest.map((a) => a.name), singles, parts } : null;
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
  // the artist's name for the artist scopes, the folder's for a folder (the
  // title the start sent, else its path's last folder).
  function jobTitle(job) {
    const rec = (job && job.recommendation) || {};
    const scope = jobScope(job);
    if (scope === 'album') {
      const credit = typeof rec.albumArtist === 'string' && rec.albumArtist.trim() ? rec.albumArtist : rec.artist;
      return [rec.album, credit].filter(Boolean).join(' — ') || '';
    }
    if (scope === 'artist' || scope === 'artist-missing') { return rec.artist || ''; }
    if (scope === 'folder') { return rec.title || normalizePeerPath(rec.filepath).split('/').pop() || ''; }
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

  // 1240 → "1,240": a count as the app's language groups its digits
  // (i18n.js's, I18N.getLanguage()) — else as the runtime's own does, when
  // there is no app around it (a test) or its language is not one the
  // runtime knows.
  function fmtCount(n) {
    const num = Number(n) || 0;
    try {
      const lang = typeof I18N !== 'undefined' && I18N && typeof I18N.getLanguage === 'function' ? I18N.getLanguage() : undefined;
      return num.toLocaleString(lang || undefined);
    } catch (_) {
      return num.toLocaleString();
    }
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
    LAYOUT_VARS, DEFAULT_LAYOUT, PEER_LAYOUT, SERVERFOLDER_LAYOUT, MAX_TEMPLATE_LEN, MAX_RESOLVED_LEN, SAMPLE_TAGS, SAMPLE_PEER, SAMPLE_SERVERFOLDER, COPY_PLUGIN, LOOKUP_CAPABILITY,
    sanitizeSegment, sanitizeFolders, serverFolderOf, resolveLayout, validateLayout, validateResolvedPath, normalizeBase, foldBase, bracedFolder, layoutLead, startLayoutAt,
    safeFileName, previewTarget, pathCrumbs,
    SLOT_VARS, songGenre, listedSongTags, scopeTags, scopeTarget, sameDestination, landedPath,
    FOLDER_FILE_LINES, normalizePeerPath, insidePeerLibrary, isSupportedAudioFile, planFolder, folderCounts, folderSongTags,
    landingMode, folderLanding, folderIntoDefault, folderFiles, folderTarget,
    isLive, fmtBytes, jobRowState, manyCounts, manyParts, jobsByPlugin, maxFolderSongs,
    nameKey, planArtistAlbums, artistLeftOut,
    JOB_SCOPES, jobScope, jobSlot, jobsBySlot, jobKind,
    inTray, trayRows, traySummary, jobTitle, finishedSince,
    downloadRow, downloadsTotals, queueIndexesFor,
    hasLookup, fmtCount, fmtSeconds, lookupCard,
  };
}));
