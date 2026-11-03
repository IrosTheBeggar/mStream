/**
 * webapp/alpha/ytdl-ui.js — Add from YouTube's panel and windows — and
 * their m.js / index.html / vp.js / api.js / spa.css / en.json wiring, on
 * node.
 *
 * What is pinned:
 * - what this browser remembers: library, layout and format per server
 *   origin + account; storage that throws or holds garbage reads as
 *   nothing; "Same as Discover" stores its base folded in;
 * - the draft (one link's card): a typed link is looked up 400 ms after
 *   typing stops, a paste at once; an older answer never overwrites a
 *   newer link's; "Still looking" after 8 s, then "Enter details yourself"
 *   lets Add go; our own 30 s bound reads as a timeout (Try again); an
 *   answer after the user typed is offered ("Use them"), and fills only
 *   the fields nobody edited; no connection reads offline or unreachable
 *   by the browser's network, and runs again when it is back; "yt-dlp
 *   missing" shows at once for the rest of the session — and the server
 *   is still asked;
 * - the card's lines in the boards' order and words: the source line and
 *   the clean-up chips (put back, Undo all), the channel check, SAVES TO
 *   crumbs with NEW pills from the new-folder check, the bracket trap,
 *   letters dropped, the clash warning ("Add anyway"), the can't-make-
 *   folders line (Save to … instead / Choose a folder…), an add's own
 *   failure inline (a 409 keeps Add off until the format changes), and why
 *   Add is off, said once; conversion off keeps the button, off; a folder
 *   listing that never answers holds the add 15 s at most;
 * - the add: it waits for the folder check, makes the folder only when one
 *   is new or unknown and the account may, sends what the card shows, and
 *   clears the card on the server's yes; a refusal re-pings when the
 *   server's facts may have changed (uploads, conversion, format,
 *   library), and a 400 naming the format forgets the remembered one;
 * - just this song: a choice for the card's video only, dropped by another
 *   video, the card cleared, or Save;
 * - rows, the pill, the lists: the tracker's rows as the WebLists board
 *   draws them (Check again alone on "Not sure it started", short reasons'
 *   buttons inline, no Hide), Adding minutes held to 1–60, the card's own
 *   starting row left out; the pill in the phone's order with its words;
 * - the Where window's form: what it opens on, Save and Use for this song
 *   off until something changes, Custom's error, a library's own layout
 *   kept when the library changes, Custom opening on the layout chosen;
 *   Choose a folder's start;
 * - m.js: the gate (uploads, conversion, a library, the route; a connected
 *   server), the entry revealed from init, the re-ping, the account's name,
 *   the panel's place among the others (never on a connected server), its
 *   Vue instance gone with the column, the title back after a language
 *   change;
 * - index.html: the entry after Add Torrent (local-only, hidden, the pill
 *   outside the label), the scripts' order, the windows' host; vp.js: the
 *   player's hotkeys skip the panel, the window helpers exported; api.js:
 *   the lookup takes a signal;
 * - what it retired: the Upload window's Youtube DL tab and its code (the
 *   window's two tabs still run, and every element m.js reaches at load
 *   is still in index.html), the old strip and its /downloads link, the
 *   codec select's rule, the old poller's list helper; the Downloads
 *   entry, where an added song is removed, shown by the plug-ins' flag or
 *   this gate; a failure toast reads the server's words (err.body.error,
 *   escaped) — Call Failed only without them;
 * - the browser half: start() wakes a panel up before it, a choice saved
 *   before the account is known is kept for it, Choose a folder from a
 *   row whose job went does nothing, a window gives the keyboard back to
 *   an opener on screen, an IME's Esc stays its own, Tab leaves a menu
 *   from its button, focus a redraw took away lands on what stands in for
 *   it, Enter adds, the strip shows before its words, the announcer;
 * - every key the three modules use is in en.json, and nothing under
 *   ytdl.* is unused; every label the draft returned fills its
 *   placeholders.
 *
 * webapp/ has no browser test harness and is eslint-ignored, so the module
 * is loaded as the CommonJS it is (createRequire), where its Vue half
 * stays off (no Vue on node) and the draft runs on injected timers and a
 * fake server — and once more as the page runs it, under a stub Vue and
 * DOM that record (browserHalf); m.js and vp.js functions are sliced from
 * source and run under new Function with stub globals, as the other
 * webapp tests do.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const U = require('../../webapp/alpha/ytdl-ui.js');
const Y = require('../../webapp/alpha/ytdl-core.js');
const J = require('../../webapp/alpha/ytdl-jobs.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const EN = JSON.parse(readSrc('webapp/locales/en.json'));
const M_SRC = readSrc('webapp/alpha/m.js');
const VP_SRC = readSrc('webapp/alpha/vp.js');
const UI_SRC = readSrc('webapp/alpha/ytdl-ui.js');
const HTML = readSrc('webapp/index.html');
const CSS = readSrc('webapp/alpha/spa.css');

const LINK = 'https://youtu.be/FGBhQbmPwH8';
const URL1 = 'https://www.youtube.com/watch?v=FGBhQbmPwH8';
const LINK2 = 'https://youtu.be/dQw4w9WgXcQ';
const ORIGIN = 'http://music.local:3000';
const MUSIC = {
  title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: '2001', thumbnail: 'https://i.ytimg.com/vi/FGBhQbmPwH8/hq.jpg',
  fileStem: 'One_More_Time', isLive: false, liveStatus: 'not_live', durationSec: 320, channel: 'Daft Punk',
};
const VIDEO = {
  title: 'Daft Punk - One More Time (Official Video)', artist: 'Daft Punk', album: null, year: '2009', thumbnail: null,
  fileStem: 'Daft_Punk_-_One_More_Time_Official_Video', isLive: false, liveStatus: 'not_live', durationSec: 320, channel: 'Daft Punk',
};

// Every label the draft's model returned here (the placeholder check).
const EMITTED = [];
function labelsIn(v, out) {
  if (!v || typeof v !== 'object') { return out; }
  if (typeof v.key === 'string' && /^ytdl\.|^discover\./.test(v.key)) { out.push(v); }
  for (const k of Object.keys(v)) { if (k !== 'target') { labelsIn(v[k], out); } }
  return out;
}
const model = (d) => { const m = d.model(); labelsIn(m, EMITTED); return m; };

const settle = async (n = 30) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { q.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { break; }
        q.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

// The lookup answers when the test says; listings from a map ("/Music/x/"
// → { dirs, files }), anything else a 404 as the server answers.
function fakeApi() {
  const calls = [];
  const dirs = new Map();
  const api = {
    calls, dirs,
    // a fetch that answers whatever the signal says (an older browser)
    ignoreAbort: false,
    metadata(url, opts) {
      let resolve;
      let reject;
      const p = new Promise((a, b) => { resolve = a; reject = b; });
      calls.push({ url, opts, resolve, reject });
      if (opts && opts.signal && !api.ignoreAbort) {
        opts.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); });
      }
      return p;
    },
    list(dir) {
      if (!dirs.has(dir)) { const e = new Error('nf'); e.status = 404; e.body = { error: 'Folder not found' }; return Promise.reject(e); }
      const d = dirs.get(dir);
      return Promise.resolve({ path: dir, directories: d.dirs.map((name) => ({ name })), files: d.files.map((name) => ({ type: 'mp3', name })) });
    },
  };
  return api;
}

const ALL_FORMATS = { mp3: true, flac: true, wav: true, ogg: true, aac: true, m4a: true, m4b: true, opus: true };

function makeDraft(o = {}) {
  const store = U.createStore();
  Object.assign(store.server, { ready: true, uploadsOff: false, convertOff: false, noMkdir: false, supported: ALL_FORMATS, vpaths: ['Music', 'Mixes'], name: 'Home server' }, o.server || {});
  if (o.saved) { store.saved = o.saved; }
  if (o.view) { store.view = o.view; }
  const api = fakeApi();
  api.dirs.set('/Music/', { dirs: ['Daft Punk'], files: [] });
  api.dirs.set('/Music/Daft Punk/', { dirs: ['Homework'], files: [] });
  const timers = fakeTimers();
  const adds = [];
  const rechecks = [];
  const prefs = [];
  const tracker = {
    open: [],
    isAddingTo(dir, url) { return this.open.some((j) => j.directory === dir && (!url || j.url === url)); },
    add(req) {
      adds.push(req);
      return Promise.resolve(o.outcome ? o.outcome(req) : { ok: true, unsure: false, failure: null, job: { id: `j${adds.length}`, state: 'adding' } });
    },
  };
  let online = true;
  const d = U.createDraft({
    store, api, timers,
    folder: o.folder, shown: o.shown,
    tracker: () => tracker,
    prefs: {
      setChoice: (c) => { prefs.push(['choice', c]); store.saved = Y.choiceToSave(c); },
      setFormat: (c) => { prefs.push(['format', c]); store.format = c; },
      clearFormat: () => { prefs.push(['clearFormat']); store.format = null; },
    },
    recheck: (p) => rechecks.push(p),
    online: () => online,
  });
  d.attach();
  return { d, store, api, timers, tracker, adds, rechecks, prefs, setOnline: (v) => { online = v; } };
}

// A link pasted, its lookup answered with `meta`, the folder check run.
async function found(env, meta, link = LINK) {
  env.d.setLink(link, { immediate: true });
  await settle();
  env.api.calls[env.api.calls.length - 1].resolve(meta);
  await settle();
  await env.timers.advance(U.CHECK_AFTER_MS);
}

describe('what this browser remembers', () => {
  function memStorage() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
  const alice = { origin: ORIGIN, user: 'alice' };

  test('one key per server origin and account, both parts encoded', () => {
    assert.deepEqual(U.prefKeys(alice), { where: 'mstream-ytdl-where:http%3A%2F%2Fmusic.local%3A3000|alice', format: 'mstream-ytdl-format:http%3A%2F%2Fmusic.local%3A3000|alice' });
    assert.notEqual(U.prefKeys(alice).where, U.prefKeys({ origin: ORIGIN, user: 'bob' }).where);
    assert.notEqual(U.prefKeys(alice).where, U.prefKeys({ origin: 'http://other:3000', user: 'alice' }).where);
    assert.equal(U.prefKeys({ origin: ORIGIN, user: 'a|b' }).where.endsWith('|a%7Cb'), true, 'a "|" in a name never splits the key');
  });

  test('a choice and a format round-trip; "Same as Discover" keeps its base in front', () => {
    const s = memStorage();
    assert.equal(U.writeChoice(s, alice, { library: 'Mixes', layout: '{{ALBUMARTIST}}', kind: 'artist', base: '' }), true);
    assert.equal(U.writeFormat(s, alice, 'opus'), true);
    assert.deepEqual(U.readPrefs(s, alice), { choice: { library: 'Mixes', layout: '{{ALBUMARTIST}}', kind: 'artist' }, format: 'opus' });
    U.writeChoice(s, alice, { library: 'Music', layout: '{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover', base: 'From Discover' });
    assert.deepEqual(U.readPrefs(s, alice).choice, { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' });
    assert.deepEqual(U.readPrefs(s, { origin: ORIGIN, user: 'bob' }), { choice: null, format: null }, 'another account has its own');
    U.writeFormat(s, alice, null);
    U.writeChoice(s, alice, null);
    assert.deepEqual(U.readPrefs(s, alice), { choice: null, format: null }, 'null forgets');
  });

  test('garbage, an old shape and a storage that throws read as nothing, never a throw', () => {
    const s = memStorage();
    const k = U.prefKeys(alice);
    for (const raw of ['{', '"x"', '[]', '{"library":3,"layout":""}', '{"layout":"{{ALBUM}}"}']) {
      s.m.set(k.where, raw);
      assert.equal(U.readPrefs(s, alice).choice, null, raw);
    }
    s.m.set(k.where, '{"library":"Music","layout":"{{ALBUM}}","kind":"weird"}');
    assert.deepEqual(U.readPrefs(s, alice).choice, { library: 'Music', layout: '{{ALBUM}}', kind: null }, 'an unknown kind reads by its layout');
    s.m.set(k.format, 'MP3 <b>');
    assert.equal(U.readPrefs(s, alice).format, null);
    const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } };
    assert.deepEqual(U.readPrefs(boom, alice), { choice: null, format: null });
    assert.equal(U.writeChoice(boom, alice, { library: 'Music', layout: '', kind: 'top' }), false);
    assert.equal(U.writeFormat(boom, alice, 'mp3'), false);
    assert.deepEqual(U.readPrefs(null, alice), { choice: null, format: null });
  });
});

describe('the draft: the link and its lookup', () => {
  test('a typed link is looked up 400 ms after typing stops; a paste at once', async () => {
    const e = makeDraft();
    e.d.setLink('https://youtu.be/FGBhQb');
    e.d.setLink(LINK);
    assert.equal(model(e.d).phase, 'reading', 'the card says it is reading while the field settles');
    await e.timers.advance(399);
    assert.equal(e.api.calls.length, 0);
    await e.timers.advance(1);
    assert.equal(e.api.calls.length, 1);
    assert.equal(e.api.calls[0].url, URL1, 'the canonical watch link, as the server keeps it');
    const p = makeDraft();
    p.d.setLink(LINK, { immediate: true });
    assert.equal(p.api.calls.length, 1);
  });

  test('an older answer never fills a newer link\'s card', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    e.d.setLink(LINK2, { immediate: true });
    assert.equal(e.api.calls[0].opts.signal.aborted, true, 'the first is called off');
    e.api.calls[0].resolve(MUSIC);
    await settle();
    assert.equal(e.d.s.lookup, 'loading');
    assert.equal(e.d.s.fields.title, '');
    e.api.calls[1].resolve(VIDEO);
    await settle();
    assert.equal(e.d.s.lookup, 'found');
    assert.equal(e.d.s.fields.title, 'One More Time', 'the second video\'s, cleaned');
    e.d.retryLookup();
    assert.equal(e.api.calls[1].opts.signal.aborted, false, 'answered: nothing to call off');
    e.d.retryLookup();
    assert.equal(e.api.calls[2].opts.signal.aborted, true, 'a Try again calls off the one still out');
    // an answer that comes anyway (a fetch that ignored its signal) is
    // dropped by its request id
    const f = makeDraft();
    f.api.ignoreAbort = true;
    f.d.setLink(LINK, { immediate: true });
    f.d.setLink(LINK2, { immediate: true });
    f.api.calls[0].resolve(VIDEO);
    await settle();
    assert.equal(f.d.s.lookup, 'loading');
    assert.equal(f.d.s.meta, null);
  });

  test('"Still looking" after 8 s; "Enter details yourself" opens the fields and Add stops waiting', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    await e.timers.advance(7999);
    assert.equal(model(e.d).phase, 'reading');
    await e.timers.advance(1);
    assert.equal(model(e.d).phase, 'slow');
    assert.equal(e.d.block(), 'lookingUp');
    e.d.enterManually();
    const m = model(e.d);
    assert.equal(m.phase, 'card');
    e.d.setField('title', 'One More Time');
    assert.equal(e.d.block(), 'none');
  });

  test('the 30 s bound aborts the request and reads as a timeout, with Try again', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    assert.ok(e.api.calls[0].opts.signal, 'the lookup carries a signal');
    await e.timers.advance(U.LOOKUP_BOUND_MS);
    assert.equal(e.api.calls[0].opts.signal.aborted, true);
    const m = model(e.d);
    assert.equal(m.phase, 'timedOut');
    assert.deepEqual(m.lookupLine.label, { key: 'ytdl.lookup.timedOut' });
    assert.equal(m.lookupLine.retry, true);
    e.d.retryLookup();
    assert.equal(e.api.calls.length, 2);
    assert.equal(model(e.d).phase, 'reading');
  });

  test('an answer after the user typed is offered; "Use them" fills only the fields nobody edited', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    await e.timers.advance(U.SLOW_AFTER_MS);
    e.d.enterManually();
    e.d.setField('title', 'One more time');
    e.api.calls[0].resolve(MUSIC);
    await settle();
    assert.equal(model(e.d).late, true);
    assert.equal(e.d.s.fields.album, '', 'nothing filled before Use them');
    e.d.useLate();
    assert.equal(model(e.d).late, false);
    assert.deepEqual({ ...e.d.s.fields }, { title: 'One more time', artist: 'Daft Punk', album: 'Discovery', year: '2001' });
    assert.deepEqual(model(e.d).source, { tone: 'ok', label: { key: 'ytdl.source.ytMusic' } });
  });

  test('no connection: offline or unreachable by the browser\'s network; it runs again when it is back', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    e.api.calls[0].reject(new TypeError('Failed to fetch'));
    await settle();
    let m = model(e.d);
    assert.equal(m.phase, 'unreachable');
    assert.deepEqual(m.lookupLine.label, { key: 'ytdl.server.unreachable', params: { server: 'Home server' } });
    assert.equal(m.lookupLine.retry, true);
    e.setOnline(false);
    e.d.retryLookup();
    e.api.calls[1].reject(new TypeError('Failed to fetch'));
    await settle();
    m = model(e.d);
    assert.equal(m.phase, 'offline');
    assert.equal(m.lookupLine.tone, 'muted');
    assert.equal(m.lookupLine.retry, false, 'offline: it runs again by itself');
    e.setOnline(true);
    e.d.onOnline();
    assert.equal(e.api.calls.length, 3);
    e.d.detach();
    e.api.calls[2].reject(new TypeError('Failed to fetch'));
    await settle();
    e.d.onOnline();
    assert.equal(e.api.calls.length, 3, 'not while the panel is closed');
    e.d.attach();
    assert.equal(e.api.calls.length, 4, 'the panel opened again: it asks again');
  });

  test('"yt-dlp missing" shows at once for the rest of the session, and the server is still asked', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    e.api.calls[0].reject(Object.assign(new Error('x'), { status: 500, body: { error: 'yt-dlp is not installed' } }));
    await settle();
    assert.equal(model(e.d).phase, 'ytdlpMissing');
    assert.equal(e.store.ytdlpMissing, true);
    assert.equal(e.d.block(), 'ytdlpMissing');
    e.d.setLink(LINK2, { immediate: true });
    assert.equal(model(e.d).phase, 'ytdlpMissing', 'at once');
    assert.equal(e.api.calls.length, 2, 'and asked');
    e.api.calls[1].resolve(MUSIC);
    await settle();
    assert.equal(model(e.d).phase, 'card');
    assert.equal(e.store.ytdlpMissing, false, 'set up since: forgotten');
  });

  test('a lookup that fails leaves the fields open to type in; Add stays on', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    e.api.calls[0].reject(Object.assign(new Error('x'), { status: 500, body: { error: 'Server Error' } }));
    await settle();
    const m = model(e.d);
    assert.equal(m.phase, 'card');
    assert.deepEqual(m.lookupLine.label, { key: 'ytdl.lookup.failed' });
    assert.equal(m.blankThumb, true);
    assert.equal(m.primary.disabled, false);
    assert.deepEqual(m.crumbs.map((c) => c.text), ['Music'], 'no tags: Artist / Album leaves the library\'s top');
  });

  test('not a YouTube link, a playlist: no card, the line under the field', () => {
    const e = makeDraft();
    e.d.setLink('https://vimeo.com/76979871');
    let m = model(e.d);
    assert.equal(m.phase, 'empty');
    assert.deepEqual(m.notes, [{ tone: 'err', label: { key: 'ytdl.link.notYoutube' } }]);
    e.d.setLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    m = model(e.d);
    assert.equal(m.phase, 'empty');
    assert.deepEqual(m.notes, [{ tone: 'err', label: { key: 'ytdl.link.playlist' } }]);
    assert.equal(e.api.calls.length, 0);
    e.d.setLink('https://youtube.com/watch?v=FGBhQbmPwH8&list=RDFGBhQbmPwH8');
    assert.deepEqual(model(e.d).notes, [{ tone: 'note', label: { key: 'ytdl.link.inPlaylist' } }]);
  });
});

describe('the draft: the card', () => {
  test('a cleaned title: the chips put a piece back, Undo all the video\'s own title; the source line gives way to the cleaned one', async () => {
    const e = makeDraft();
    await found(e, VIDEO);
    let m = model(e.d);
    assert.equal(e.d.s.fields.title, 'One More Time');
    assert.equal(e.d.s.fields.artist, 'Daft Punk');
    assert.equal(m.source, null, 'the split\'s own line gives way to "Cleaned from"');
    assert.deepEqual(m.cleaned, { key: 'ytdl.source.cleaned', params: { title: VIDEO.title } });
    assert.deepEqual(m.chips.map((c) => c.text), ['(Official Video)'], 'the noise only (the split is put back by Undo all)');
    e.d.setField('title', 'One More Time!');
    e.d.restore(m.chips[0].index);
    assert.equal(e.d.s.fields.title, 'One More Time (Official Video)', 'the edit gives way: the user asked for it');
    assert.equal(e.d.s.edited.title, false);
    m = model(e.d);
    assert.deepEqual(m.chips, []);
    assert.equal(m.canUndoAll, true);
    e.d.undoAll();
    m = model(e.d);
    assert.equal(e.d.s.fields.title, VIDEO.title);
    assert.equal(m.cleaned, null);
    assert.deepEqual(m.source, { tone: 'warn', label: { key: 'ytdl.source.channel' } }, 'the split undone: YouTube\'s artist — check it');
    assert.equal(m.artistWarn, true, 'the artist field wears the warning');
    e.d.setField('artist', 'Daft Punk & Friends');
    assert.equal(model(e.d).artistWarn, false, 'until the user typed in it');
  });

  test('the focused field\'s one help line; none without focus', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    assert.equal(model(e.d).help, null);
    e.d.setFocus('title');
    assert.deepEqual(model(e.d).help, { field: 'title', label: { key: 'ytdl.help.music' } });
    e.d.setField('year', '');
    e.d.setFocus('year');
    assert.deepEqual(model(e.d).help, { field: 'year', label: { key: 'ytdl.blank.year' } }, 'blank wins over Edited');
    e.d.setField('album', 'Disco');
    e.d.setFocus('album');
    assert.deepEqual(model(e.d).help.label, { key: 'ytdl.help.edited' });
    e.d.setFocus(null);
    assert.equal(model(e.d).help, null);
  });

  test('SAVES TO: the remembered layout under the remembered library, NEW on each folder that will be made', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    let m = model(e.d);
    assert.equal(m.target.directory, '/Music/Daft Punk/Discovery/');
    assert.deepEqual(m.crumbs, [{ text: 'Music', isNew: false, trap: false }, { text: 'Daft Punk', isNew: false, trap: false }, { text: 'Discovery', isNew: true, trap: false }]);
    const f = makeDraft({ saved: { library: 'Mixes', layout: '', kind: 'top' } });
    f.api.dirs.set('/Mixes/', { dirs: [], files: [] });
    await found(f, MUSIC);
    m = model(f.d);
    assert.equal(m.target.directory, '/Mixes/');
    assert.deepEqual(m.crumbs.map((c) => c.isNew), [false]);
  });

  test('a bracket trap: the folder in the warning tone and its line, with the field that fills it', async () => {
    const e = makeDraft({ saved: { library: 'Music', layout: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})', kind: 'custom' } });
    await found(e, MUSIC);
    e.d.setField('year', '');
    const m = model(e.d);
    assert.deepEqual(m.trap, { label: { key: 'ytdl.where.trap.year', params: { folder: 'Discovery ()' } }, link: { label: { key: 'ytdl.where.trap.addYear' }, focus: 'year' } });
    assert.equal(m.crumbs[2].trap, true);
    assert.equal(m.primary.disabled, false, 'a warning, not a block');
  });

  test('a clash: the warning with the file name, Change format, and "Add anyway"', async () => {
    const e = makeDraft();
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: ['ONE_MORE_TIME.mp3'] });
    await found(e, MUSIC);
    const m = model(e.d);
    assert.deepEqual(m.clash, { label: { key: 'ytdl.clash', params: { name: 'One_More_Time.mp3' } }, changeFormat: true });
    assert.deepEqual(m.primary.label, { key: 'ytdl.addAnyway' });
    assert.equal(m.primary.disabled, false, 'it costs nothing: the server refuses it before downloading');
    e.d.setFormat('opus');
    assert.equal(model(e.d).clash, null, 'another format makes another file');
    assert.deepEqual(model(e.d).primary.label, { key: 'ytdl.add' });
  });

  test('letters dropped: "about _.mp3 …" under the crumbs', async () => {
    const e = makeDraft();
    await found(e, { ...MUSIC, title: 'ワン・モア・タイム', artist: 'ダフト・パンク', album: null, fileStem: '_' });
    assert.deepEqual(model(e.d).letters, { key: 'ytdl.file.lettersDropped', params: { name: '_.mp3' } });
  });

  test('why Add is off, in the phone\'s order, said once; conversion off keeps the button, off (a lost right inside a flow)', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    assert.equal(model(e.d).reason, null);
    e.d.setField('year', '20011');
    assert.deepEqual(model(e.d).reason, { key: 'ytdl.yearInvalid' });
    e.tracker.open.push({ url: URL1, directory: '/Music/Daft Punk/Discovery/' });
    assert.deepEqual(model(e.d).reason, { key: 'ytdl.alreadyAdding' }, 'an open job of this link into this folder, any tab');
    e.store.server.uploadsOff = true;
    assert.deepEqual(model(e.d).reason, { key: 'ytdl.err.uploadsOff' });
    assert.equal(model(e.d).primary.disabled, true);
    e.store.server.convertOff = true;
    const m = model(e.d);
    assert.deepEqual(m.reason, { key: 'ytdl.err.ffmpeg' });
    assert.equal(m.primary.disabled, true);
    assert.ok(!('hidden' in m.primary), 'the button stays: focus on it never drops to the page');
    for (const name of ["Vue.component('yt-panel'", "Vue.component('yt-here'"]) {
      const at = UI_SRC.indexOf(name);
      const tpl = UI_SRC.slice(at, UI_SRC.indexOf('Vue.component(', at + 10));
      const add = tpl.match(/<button ref="add" type="button" class="dm-btn dm-btn-primary [^"]*"[^>]*>/);
      assert.ok(add, name);
      assert.ok(!/v-if/.test(add[0]), `${name}: the primary is always drawn`);
      assert.match(add[0], /:aria-describedby="m\.reason \? /, `${name}: the reason is the button's description`);
    }
  });

  test('can\'t make folders: the line, Save to … instead (just this song) and Choose a folder…; Add off until then', async () => {
    const e = makeDraft({ server: { noMkdir: true } });
    await found(e, MUSIC);
    let m = model(e.d);
    assert.deepEqual(m.noMkdir, { label: { key: 'ytdl.noMkdir.new', params: { folder: 'Discovery' } }, deepest: ['Music', 'Daft Punk'] });
    assert.equal(m.block, 'mkdirBlocked');
    assert.equal(m.primary.disabled, true);
    assert.equal(m.reason, null, 'its own line says it');
    assert.equal(U.chooseStart(e.d), '/Music/Daft Punk/', 'Choose a folder opens on the deepest folder there');
    e.d.saveToDeepest();
    await e.timers.advance(U.CHECK_AFTER_MS);
    m = model(e.d);
    assert.equal(m.target.directory, '/Music/Daft Punk/');
    assert.equal(m.noMkdir, null);
    assert.equal(m.primary.disabled, false);
    assert.equal(e.d.choice().kind, 'folder');
    e.d.setLink(LINK2, { immediate: true });
    assert.notEqual(e.d.choice().kind, 'folder', 'another video drops a just-this-song choice');
  });
});

describe('the draft: the add', () => {
  test('it waits for the folder check, makes the new folder first, sends what the card shows, and clears the card', async () => {
    const e = makeDraft();
    e.d.setLink(LINK, { immediate: true });
    e.api.calls[0].resolve(MUSIC);
    await settle();
    e.d.setFocus('title');
    // pressed before the 600 ms check ran: it runs at once
    const sent = await e.d.add();
    assert.equal(sent, true);
    assert.equal(e.adds.length, 1);
    const r = e.adds[0];
    assert.equal(r.url, URL1);
    assert.equal(r.directory, '/Music/Daft Punk/Discovery/');
    assert.equal(r.codec, 'mp3');
    assert.deepEqual(r.metadata, { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: '2001' });
    assert.equal(r.title, 'One More Time');
    assert.deepEqual(r.crumbs, ['Music', 'Daft Punk', 'Discovery']);
    assert.equal(r.cover, MUSIC.thumbnail);
    assert.equal(r.fileName, 'One_More_Time.mp3');
    assert.equal(r.mkdir, true, 'Discovery is new');
    assert.equal(r.mkdirFolder, 'Discovery');
    assert.equal(r.inline(), false, 'the card shows another link now (none)');
    assert.equal(e.d.s.link, '');
    assert.equal(model(e.d).phase, 'empty');
  });

  test('no folder to make: no mkdir; under noMkdir never one', async () => {
    const e = makeDraft();
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(e, MUSIC);
    await e.d.add();
    assert.equal(e.adds[0].mkdir, undefined);
  });

  test('"Adding…" while it starts; a second press does nothing', async () => {
    let release;
    const e = makeDraft({ outcome: () => new Promise((r) => { release = r; }) });
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(e, MUSIC);
    const p = e.d.add();
    await settle();
    let m = model(e.d);
    assert.deepEqual(m.primary.label, { key: 'ytdl.adding' });
    assert.equal(m.primary.busy, true);
    assert.equal(m.primary.disabled, true);
    e.tracker.open.push({ url: URL1, directory: '/Music/Daft Punk/Discovery/' });
    assert.equal(model(e.d).reason, null, 'its own job is no "Already adding"');
    assert.equal(await e.d.add(), false);
    assert.equal(e.adds.length, 1);
    release({ ok: true, unsure: false, failure: null, job: { id: 'j1', state: 'adding' } });
    assert.equal(await p, true);
    m = model(e.d);
    assert.equal(m.phase, 'empty');
  });

  test('a folder listing that never answers holds "Adding…" 15 s at most: the check counts as unknown', async () => {
    const lookedUp = async (o) => {
      const e = makeDraft(o);
      e.d.setLink(LINK, { immediate: true });
      await settle();
      e.api.calls[0].resolve(MUSIC);
      await settle();
      e.api.list = () => new Promise(() => {});
      return e;
    };
    const e = await lookedUp();
    const p = e.d.add();
    await settle();
    assert.equal(model(e.d).primary.busy, true);
    await e.timers.advance(U.CHECK_BOUND_MS - 1);
    assert.equal(e.adds.length, 0, 'still waiting');
    await e.timers.advance(1);
    assert.equal(await p, true);
    assert.equal(e.adds.length, 1);
    assert.equal(e.adds[0].mkdir, true, 'unknown: the folder is made first, as after a check that broke');
    // an account that can't make folders: refused in place — never stuck
    const n = await lookedUp({ server: { noMkdir: true } });
    const q = n.d.add();
    await n.timers.advance(U.CHECK_BOUND_MS);
    assert.equal(await q, false);
    const m = model(n.d);
    assert.equal(n.d.s.starting, false);
    assert.equal(m.primary.busy, false);
    assert.deepEqual(m.noMkdir.label, { key: 'ytdl.noMkdir.unchecked' });
    assert.equal(n.adds.length, 0);
    assert.equal(U.CHECK_BOUND_MS, 15000, 'the tracker\'s own folder-make bound');
    assert.equal(J.MKDIR_TIMEOUT_MS, U.CHECK_BOUND_MS);
  });

  test('a 409 shows inline with the name and keeps Add off until the format changes', async () => {
    const failure = Y.classifyAdd(Object.assign(new Error('x'), { status: 409, body: { error: '“One_More_Time.mp3” is already in this folder, so nothing was added.', reason: 'exists', fileName: 'One_More_Time.mp3' } }));
    const e = makeDraft({ outcome: (req) => (req.inline() ? { ok: false, unsure: false, failure, job: null } : { ok: false, unsure: false, failure, job: { id: 'x', state: 'startFailed' } }) });
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(e, MUSIC);
    assert.equal(await e.d.add(), false);
    let m = model(e.d);
    assert.deepEqual(m.failure, { label: { key: 'ytdl.err.exists', params: { name: 'One_More_Time.mp3' } }, changeFormat: true });
    assert.equal(m.clash, null, 'the refusal says it now');
    assert.equal(m.primary.disabled, true);
    assert.equal(await e.d.add(), false);
    assert.equal(e.adds.length, 1, 'refused the same way: not sent again');
    e.d.setFormat('flac');
    m = model(e.d);
    assert.equal(m.failure, null);
    assert.equal(m.primary.disabled, false);
    assert.deepEqual(e.prefs, [['format', 'flac']]);
    await e.d.add();
    assert.equal(model(e.d).primary.disabled, true, 'refused again');
    e.d.setField('album', 'Discovery (Deluxe)');
    assert.equal(model(e.d).failure, null, 'another folder may take it');
    assert.equal(model(e.d).primary.disabled, false);
  });

  test('uploads refused: the line once, Add off, the ping asked again', async () => {
    const failure = Y.classifyAdd(Object.assign(new Error('x'), { status: 403, body: { error: 'Uploading Disabled' } }));
    const e = makeDraft({ outcome: () => ({ ok: false, unsure: false, failure, job: null }) });
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(e, MUSIC);
    await e.d.add();
    const m = model(e.d);
    assert.deepEqual(m.failure.label, { key: 'ytdl.err.uploadsOff' });
    assert.equal(m.reason, null, 'said once');
    assert.equal(m.primary.disabled, true);
    assert.deepEqual(e.rechecks, ['uploadsOff']);
  });

  test('FFmpeg not ready re-pings; a format the server dropped is forgotten and re-pings', async () => {
    const ff = Y.classifyAdd(Object.assign(new Error('x'), { status: 500, body: { error: 'FFmpeg is not available yet' } }));
    const fmt = Y.classifyAdd(Object.assign(new Error('x'), { status: 400, body: { error: '"outputCodec" must be one of [mp3, flac]' } }));
    let next = ff;
    const e = makeDraft({ outcome: () => ({ ok: false, unsure: false, failure: next, job: null }) });
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    e.store.format = 'opus';
    await found(e, MUSIC);
    await e.d.add();
    assert.deepEqual(model(e.d).failure.label, { key: 'ytdl.err.ffmpeg' });
    assert.equal(model(e.d).primary.disabled, false, 'the ping may still say ready: Add stays');
    next = fmt;
    await e.d.add();
    assert.deepEqual(model(e.d).failure.label, { key: 'ytdl.err.formatOff', params: { format: 'Opus' } });
    assert.equal(e.store.format, null);
    assert.deepEqual(e.rechecks, ['ffmpegNotReady', 'badFormat']);
    assert.ok(e.prefs.some((p) => p[0] === 'clearFormat'));
  });

  test('a folder-make refused: noMkdir from then on, its line instead of the error', async () => {
    const f = { problem: 'mkdirOff', detail: 'Discovery', reason: null, text: null, phase: 'start' };
    const e = makeDraft({ outcome: () => ({ ok: false, unsure: false, failure: f, job: null }) });
    await found(e, MUSIC);
    await e.d.add();
    await settle();
    const m = model(e.d);
    assert.equal(e.store.mkdirRefused, true);
    assert.equal(m.failure, null);
    assert.deepEqual(m.noMkdir.label, { key: 'ytdl.noMkdir.new', params: { folder: 'Discovery' } });
  });

  test('a failure the tracker kept as a row (the card moved on) shows no inline line; no answer is a success to the card', async () => {
    const f = { problem: 'serverError', detail: null, reason: null, text: null, phase: 'start' };
    const e = makeDraft({ outcome: () => ({ ok: false, unsure: false, failure: f, job: { id: 'x', state: 'startFailed' } }) });
    e.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(e, MUSIC);
    await e.d.add();
    assert.equal(model(e.d).failure, null);
    const u = makeDraft({ outcome: () => ({ ok: false, unsure: true, failure: { problem: 'startUnsure' }, job: { id: 'y', state: 'startUnsure' } }) });
    u.api.dirs.set('/Music/Daft Punk/Discovery/', { dirs: [], files: [] });
    await found(u, MUSIC);
    assert.equal(await u.d.add(), true);
    assert.equal(model(u.d).phase, 'empty', 'looked for by the tracker: the card is free for the next link');
  });

  test('just this song: Use for this song holds for the video; the remembered one is no one-off; Save remembers', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    const top = { kind: 'top', library: 'Mixes', layout: '', base: '' };
    e.d.useForThisSong(top);
    assert.equal(e.d.target().directory, '/Mixes/');
    e.d.useForThisSong(e.d.remembered());
    assert.equal(e.d.s.just, null);
    e.d.useForThisSong(top);
    e.d.saveChoice({ kind: 'artist', library: 'Music', layout: '{{ALBUMARTIST}}', base: '' });
    assert.equal(e.d.s.just, null);
    assert.equal(e.d.target().directory, '/Music/Daft Punk/');
    assert.deepEqual(e.prefs[0], ['choice', { kind: 'artist', library: 'Music', layout: '{{ALBUMARTIST}}', base: '' }]);
    e.d.useForThisSong(top);
    e.d.clear();
    assert.equal(e.d.s.just, null, '✕ drops it');
  });
});

describe('rows, the pill, the lists', () => {
  const job = (state, extra) => ({ id: 'j1', state, url: URL1, directory: '/Music/Daft Punk/Discovery/', codec: 'mp3', title: 'One More Time', crumbs: ['Music', 'Daft Punk', 'Discovery'], createdAt: 1000, ...extra });

  test('Adding minutes are held to 1–60 whatever the clock did', () => {
    assert.deepEqual(U.clampAdding({ key: 'ytdl.row.adding', params: { count: 1440, format: 'MP3' } }), { key: 'ytdl.row.adding', params: { count: 60, format: 'MP3' } });
    assert.equal(U.clampAdding({ key: 'ytdl.row.adding', params: { count: -3, format: 'MP3' } }).params.count, 1);
    assert.equal(U.clampAdding({ key: 'ytdl.row.adding', params: { count: NaN, format: 'MP3' } }).params.count, 1);
    assert.equal(U.clampAdding({ key: 'ytdl.row.adding', params: { count: 2.7, format: 'MP3' } }).params.count, 2);
    const other = { key: 'ytdl.row.waiting' };
    assert.equal(U.clampAdding(other), other);
    const r = U.rowView(job('adding'), J.jobRow(job('adding'), { now: 25 * 60 * 60 * 1000 }));
    assert.deepEqual(r.status, { key: 'ytdl.row.adding', params: { count: 60, format: 'MP3' } });
  });

  test('the WebLists rows: status beside the bar or under the title, buttons inline for a short reason, no Hide', () => {
    const adding = U.rowView(job('adding'), J.jobRow(job('adding'), { now: 2 * 60 * 1000 }));
    assert.equal(adding.wide, true);
    assert.deepEqual(adding.actions, [], 'the board draws no control on an Adding row');
    const unsure = U.rowView(job('startUnsure'), J.jobRow(job('startUnsure'), {}));
    assert.equal(unsure.wide, false);
    assert.deepEqual(unsure.status, { key: 'ytdl.row.startUnsure' });
    const waiting = U.rowView(job('adding'), J.jobRow(job('adding'), { waiting: true }));
    assert.equal(waiting.wide, false, '"Waiting for connection" under the title');
    const nss = U.rowView(job('notSureStarted'), J.jobRow(job('notSureStarted'), {}));
    assert.deepEqual(nss.actions.map((a) => a.name), ['checkAgain'], 'Check again alone');
    assert.equal(nss.inline, true);
    assert.equal(nss.glyph, 'question');
    const nf = U.rowView(job('notFound'), J.jobRow(job('notFound'), {}));
    assert.deepEqual(nf.actions.map((a) => [a.name, a.label.key, a.quiet]), [['addAgain', 'ytdl.row.addAgain', false], ['dismiss', 'ytdl.row.dismiss', true]]);
    assert.equal(nf.inline, true);
    const failure = Y.entryFailure({ status: 'error', reason: 'exists', fileName: 'One_More_Time.mp3', error: 'a file named …' });
    const clash = U.rowView(job('failed', { failure }), J.jobRow(job('failed', { failure }), { formats: ['mp3', 'opus'] }));
    assert.deepEqual(clash.status, { key: 'ytdl.reason.exists', params: { name: 'One_More_Time.mp3' } });
    assert.deepEqual(clash.actions.map((a) => a.label.key), ['ytdl.row.changeFormatRetry', 'ytdl.row.dismiss']);
    assert.equal(clash.codec, 'mp3', 'the format it failed in: "Change format and retry" marks that one, not the card\'s');
    assert.equal(U.rowView(job('failed', { codec: 'opus' }), null).codec, 'opus');
    assert.equal(U.rowView(job('failed', { codec: '' }), null).codec, null);
    assert.match(UI_SRC, /<yt-format-menu v-if="a\.name === 'changeFormat'" :key="a\.name" :value="row\.codec \|\| codec" /);
    assert.equal(clash.inline, false, 'a long reason: the buttons on their own line');
    assert.equal(clash.glyph, 'alert');
    const nof = { problem: 'mkdirOff', detail: 'Discovery', reason: null, text: null, phase: 'start' };
    const sf = U.rowView(job('startFailed', { failure: nof }), J.jobRow(job('startFailed', { failure: nof }), {}));
    assert.deepEqual(sf.actions.map((a) => a.label.key), ['ytdl.where.preset.top', 'ytdl.noMkdir.choose', 'ytdl.row.dismiss']);
  });

  test('a row\'s title: the edited title, else the file name, else the link; crumbs where it landed once known', () => {
    assert.equal(U.rowView(job('adding', { title: '' , fileName: 'One_More_Time.mp3' }), null).title, 'One_More_Time.mp3');
    assert.equal(U.rowView(job('adding', { title: '' }), null).title, URL1);
    assert.deepEqual(U.rowView(job('failed', { filePath: 'Music/Daft Punk/Discovery/x.mp3' }), null).crumbs, ['Music', 'Daft Punk', 'Discovery']);
    assert.deepEqual(U.rowView(job('failed', { crumbs: [] }), null).crumbs, ['Music', 'Daft Punk', 'Discovery']);
  });

  test('the pill: adding, then unseen failures, then added — glyph and number, its words for a screen reader', () => {
    assert.equal(U.pillView({ kind: null, count: 0 }), null);
    assert.equal(U.pillView({ kind: 'adding', count: 0 }), null);
    assert.equal(U.pillView(null), null);
    assert.deepEqual(U.pillView({ kind: 'adding', count: 1 }), { kind: 'adding', count: 1, sr: { key: 'ytdl.pill.adding', params: { count: 1 } } });
    assert.equal(U.pillView({ kind: 'failed', count: 2 }).sr.key, 'ytdl.pill.needsLook');
    assert.equal(U.pillView({ kind: 'added', count: 2 }).sr.key, 'ytdl.pill.added');
  });

  test('the lists leave out the row of the add the card is starting', () => {
    const rows = [job('starting', { id: 'a' }), job('starting', { id: 'b', url: 'https://www.youtube.com/watch?v=other' }), job('adding', { id: 'c' })];
    const tr = {
      lists: () => ({ adding: rows, needsLook: [job('notFound', { id: 'd' })] }),
      row: (j, ctx) => J.jobRow(j, ctx),
      addedView: () => ({ rows: [], canShowEarlier: false }),
    };
    const v = U.listsView(tr, { now: 0, hold: `${URL1}\n/Music/Daft Punk/Discovery/` });
    assert.deepEqual(v.adding.map((r) => r.id), ['b', 'c']);
    assert.deepEqual(v.needsLook.map((r) => r.id), ['d']);
    assert.deepEqual(U.listsView(null, {}).adding, []);
  });

  test('an Added row\'s facts: the format by extension, the size, when', () => {
    globalThis.DISCOVERJOBS = require('../../webapp/alpha/discover-jobs.js');
    try {
      assert.deepEqual(U.addedFacts({ ext: 'mp3', bytes: 8.4 * 1024 * 1024, at: 1 }, () => '3 min ago'), ['MP3', '8.4 MB', '3 min ago']);
      assert.deepEqual(U.addedFacts({ ext: null, bytes: null, at: null }, () => 'x'), []);
    } finally { delete globalThis.DISCOVERJOBS; }
  });

  test('folders as text: each name in an isolate, so a right-to-left name keeps the › order; a row\'s cut at the start', () => {
    assert.equal(U.crumbLine(['Music', 'دافت بانك', 'ديسكفري']), '\u2068Music\u2069 › \u2068دافت بانك\u2069 › \u2068ديسكفري\u2069');
    assert.equal(U.crumbLine([]), '');
    assert.equal(U.crumbLine(null), '');
    for (const name of ["Vue.component('yt-job-row'", "Vue.component('yt-added-row'"]) {
      const at = UI_SRC.indexOf(name);
      const c = UI_SRC.slice(at, UI_SRC.indexOf('template:', at));
      assert.match(c, /crumbText: function \(\) \{ return crumbLine\(this\.row\.crumbs\); \}/, name);
    }
    assert.equal((UI_SRC.match(/<div class="ytp-rcrumbs"><span dir="ltr">\{\{ crumbText \}\}<\/span><\/div>/g) || []).length, 2);
    assert.equal((UI_SRC.match(/<span class="ytp-rcrumbs"><span dir="ltr">\{\{ crumbText \}\}<\/span><\/span>/g) || []).length, 2);
    for (const fn of ['deepestText', 'pathText']) { assert.match(UI_SRC, new RegExp(`${fn}: function \\(\\) \\{ return crumbLine\\(`), fn); }
    const block = CSS.slice(CSS.indexOf('/* ── Add from YouTube'), CSS.indexOf('/* ── The Discover page'));
    assert.match(block, /\n\.ytp-rcrumbs \{\n[^}]*text-overflow: ellipsis;\n {2}direction: rtl; text-align: left;\n\}/, 'the ellipsis on the left, the last folder kept');
    assert.match(block, /\n\.yt-crumb, \.ytw-tree-h b, \.ytw-tree-h span \{ unicode-bidi: isolate; \}/);
  });

  test('what a card\'s status region says: the lookup as it stands, and a right taken away under it', () => {
    assert.deepEqual(U.saidOf({ phase: 'reading' }), { phase: { key: 'ytdl.lookup.reading' }, lost: null });
    assert.deepEqual(U.saidOf({ phase: 'slow' }).phase, { key: 'ytdl.lookup.slow' });
    const line = { label: { key: 'ytdl.lookup.timedOut' } };
    assert.deepEqual(U.saidOf({ phase: 'timedOut', lookupLine: line }).phase, line.label);
    assert.deepEqual(U.saidOf({ phase: 'card', lookupLine: line, late: true }).phase, line.label);
    assert.deepEqual(U.saidOf({ phase: 'card', late: true }).phase, { key: 'ytdl.late.found' });
    assert.deepEqual(U.saidOf({ phase: 'card', block: 'convertOff', reason: { key: 'ytdl.err.ffmpeg' } }), { phase: null, lost: { key: 'ytdl.err.ffmpeg' } });
    assert.deepEqual(U.saidOf({ phase: 'card', block: 'uploadsOff', reason: { key: 'ytdl.err.uploadsOff' } }).lost, { key: 'ytdl.err.uploadsOff' });
    assert.equal(U.saidOf({ phase: 'card', block: 'yearInvalid', reason: { key: 'ytdl.yearInvalid' } }).lost, null, 'only a lost right: its other reasons are under the user\'s own hand');
    assert.equal(U.saidOf({ phase: 'card', block: 'uploadsOff', reason: null }).lost, null, 'the failure\'s own alert says it');
    assert.deepEqual(U.saidOf(null), { phase: null, lost: null });
    // one region on each surface, always there; the phases' own boxes are no live regions any more
    for (const name of ["Vue.component('yt-panel'", "Vue.component('yt-here'"]) {
      const at = UI_SRC.indexOf(name);
      const tpl = UI_SRC.slice(at, UI_SRC.indexOf('Vue.component(', at + 10));
      assert.match(tpl, /template: `<div class="(ytdl-panel|yth)" @focusin="noteFocus" @focusout="dropFocus">\n\s*<div class="dm-sr" role="status"><span>\{\{ tl\(said\.phase\) \}\}<\/span> <span>\{\{ tl\(said\.lost\) \}\}<\/span><\/div>/, name);
      assert.equal((tpl.match(/role="status"/g) || []).length, 1, name);
    }
  });

  test('a line split around its file name, so the name can be drawn in mono', () => {
    const tr = (key, p) => (key === 'k' ? `Something like “${p.name}” is here` : key);
    assert.deepEqual(U.splitAround(tr, { key: 'k', params: { name: 'One_More_Time.mp3' } }, 'name'), ['Something like “', 'One_More_Time.mp3', '” is here']);
    assert.deepEqual(U.splitAround(tr, { key: 'other' }, 'name'), ['other']);
    assert.deepEqual(U.splitAround((k, p) => `${p.name} and ${p.name}`, { key: 'k', params: { name: 'a$&b' } }, 'name'), ['', 'a$&b', ' and a$&b'], 'a second copy stays the value; $ patterns are text');
    assert.deepEqual(U.splitAround(tr, null, 'name'), ['']);
  });
});

describe('the Where window\'s form, Choose a folder', () => {
  const VIEW = {
    destination: { vpath: 'Music', base: 'From Discover', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'user' },
    libraries: [{ vpath: 'Music', template: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' }, { vpath: 'Mixes', template: null }],
  };
  const state = (e, form) => U.whereState(form, { view: e.store.view, saved: e.store.saved, draft: e.d });

  test('it opens on the choice in force; Save and Use for this song stay off until something changes', async () => {
    const e = makeDraft({ view: VIEW });
    await found(e, MUSIC);
    const form = U.whereOpen(e.d.choice(), e.d.remembered());
    assert.equal(form.kind, 'artistAlbum');
    assert.equal(form.library, 'Music');
    let w = state(e, form);
    assert.deepEqual(w.choices.map((c) => c.kind), ['artistAlbum', 'artist', 'top', 'discover', 'library', 'custom']);
    assert.equal(w.valid, true);
    assert.equal(w.canSave, false);
    assert.equal(w.canUse, false);
    w = state(e, U.wherePickLayout(form, 'top', VIEW, null));
    assert.equal(w.canSave, true);
    assert.equal(w.canUse, true);
    assert.equal(w.target.directory, '/Music/');
    e.d.useForThisSong(w.choice);
    w = state(e, U.whereOpen(e.d.choice(), e.d.remembered()));
    assert.equal(w.choice.kind, 'top', 'a one-off is what it opens on');
    assert.equal(w.canUse, false);
    assert.equal(w.canSave, true, 'Save makes the one-off stick');
  });

  test('a folder in force (Save to … instead) opens on the remembered choice', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    e.d.useFolder('/Music/Daft Punk/');
    assert.equal(U.whereOpen(e.d.choice(), e.d.remembered()).kind, 'artistAlbum');
  });

  test('Same as Discover locks the library; Custom opens on the layout chosen, with its base folded in', async () => {
    const e = makeDraft({ view: VIEW });
    await found(e, MUSIC);
    const form = U.wherePickLayout(U.whereOpen(e.d.choice(), e.d.remembered()), 'discover', VIEW, null);
    const w = state(e, form);
    assert.equal(w.lockedLibrary, 'Music');
    assert.equal(w.target.directory, '/Music/From Discover/Daft Punk/Discovery/');
    const custom = U.wherePickLayout(form, 'custom', VIEW, null);
    assert.equal(custom.custom, 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}');
    assert.equal(U.wherePickLayout({ ...form, custom: 'kept' }, 'custom', VIEW, null).custom, 'kept', 'what was typed stays');
  });

  test('a library\'s own layout leaving with it stays the layout, in Custom', async () => {
    const e = makeDraft({ view: VIEW });
    await found(e, MUSIC);
    const lib = U.wherePickLayout(U.whereOpen(e.d.choice(), e.d.remembered()), 'library', VIEW, null);
    assert.equal(state(e, lib).choice.layout, '{{ARTIST}}/{{ALBUM}} ({{YEAR}})');
    const moved = U.wherePickLibrary(lib, 'Mixes', VIEW, null);
    assert.deepEqual([moved.kind, moved.custom, moved.library], ['custom', '{{ARTIST}}/{{ALBUM}} ({{YEAR}})', 'Mixes']);
    assert.equal(state(e, moved).target.directory, '/Mixes/Daft Punk/Discovery (2001)/');
  });

  test('Custom: an unknown or never-filled variable, a bad character, or nothing typed: no Save, the error words', async () => {
    const e = makeDraft();
    await found(e, MUSIC);
    const base = U.wherePickLayout(U.whereOpen(e.d.choice(), e.d.remembered()), 'custom', null, null);
    let w = state(e, { ...base, custom: '{{ALBUMARTIST}}/{{TITLE}}' });
    assert.deepEqual(w.customError, { key: 'ytdl.where.err.unknownVar', params: { token: '{{TITLE}}', vars: 'ARTIST, ALBUMARTIST, ALBUM, YEAR' } });
    assert.equal(w.valid, false);
    assert.equal(w.canSave, false);
    assert.equal(w.canUse, false);
    w = state(e, { ...base, custom: '{{GENRE}}' });
    assert.equal(w.customError.key, 'ytdl.where.err.neverVar');
    w = state(e, { ...base, custom: 'Live: {{ALBUM}}' });
    assert.deepEqual(w.customError, { key: 'ytdl.where.err.badChar' });
    w = state(e, { ...base, custom: '  ' });
    assert.equal(w.valid, false);
    w = state(e, { ...base, custom: '{{ALBUMARTIST}}/Singles' });
    assert.equal(w.customError, null);
    assert.equal(w.target.directory, '/Music/Daft Punk/Singles/');
    assert.equal(w.canSave, true);
  });

  test('a library the server dropped since the view was read is neither the default nor a choice (the re-ping after "library gone")', () => {
    const e = makeDraft({ view: VIEW, saved: { library: 'Mixes', layout: '{{ALBUM}}', kind: 'custom' } });
    assert.equal(e.d.remembered().library, 'Mixes');
    e.store.server.vpaths = ['Music'];
    assert.equal(e.d.remembered().library, 'Music', 'the re-ping\'s libraries hold the view\'s');
    assert.deepEqual(U.librariesFor(VIEW, e.store.server), ['Music']);
    assert.deepEqual(U.librariesFor(VIEW, { ready: false, vpaths: [] }), ['Music', 'Mixes'], 'before the ping: the view as it is');
    assert.deepEqual(U.librariesFor(null, { ready: true, vpaths: ['Music', 'Mixes'] }), ['Music', 'Mixes'], 'before the view: the ping\'s');
    assert.deepEqual(U.librariesFor({ libraries: [{ vpath: 'Music' }, null, { vpath: 3 }] }, { ready: true, vpaths: ['Music', 'Mixes'] }), ['Music'], 'the view\'s writable ones only');
    assert.match(UI_SRC, /\n {6}libraries: function \(\) \{ return librariesFor\(store\.view, store\.server\); \},\n/, 'the window lists the same');
  });

  test('before the view answered, a remembered Same as Discover stands as it was kept', async () => {
    const e = makeDraft({ saved: { library: 'Music', layout: 'From Discover/{{ALBUMARTIST}}/{{ALBUM}}', kind: 'discover' } });
    await found(e, MUSIC);
    const form = U.whereOpen(e.d.choice(), e.d.remembered());
    assert.equal(form.kind, 'discover');
    const w = state(e, form);
    assert.equal(w.choice.kind, 'discover');
    assert.equal(w.target.directory, '/Music/From Discover/Daft Punk/Discovery/');
  });

  test('Choose a folder opens on the deepest folder that listed, else the folder in force, else the library', async () => {
    const e = makeDraft();
    assert.equal(U.chooseStart(e.d), '/Music/');
    await found(e, MUSIC);
    assert.equal(U.chooseStart(e.d), '/Music/Daft Punk/');
    e.d.s.check.deepest = null;
    e.d.useFolder('/Mixes/Old/');
    assert.equal(U.chooseStart(e.d), '/Mixes/Old/');
  });
});

// ── m.js ────────────────────────────────────────────────────────────────

function findFn(name) {
  const lines = M_SRC.split('\n');
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) { if (lines[i] === '}') { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of ${name}()`);
}
const YTDL_FNS = [...M_SRC.matchAll(/^(?:async )?function (ytdl\w*)\(/gm)].map((m) => m[1]);

function gateSandbox(server, opts = {}) {
  const el = (id) => ({ id, classes: new Set(['super-hide']), classList: { toggle(c, on) { if (on) { this.owner.classes.add(c); } else { this.owner.classes.delete(c); } }, owner: null } });
  const nav = el('nav-ytdl');
  nav.classList.owner = nav;
  const downloads = el('nav-discover-downloads');
  downloads.classList.owner = downloads;
  const calls = [];
  const filelist = { innerHTML: '', scrollTop: 40 };
  const doc = { getElementById: (id) => (id === 'nav-ytdl' ? nav : (id === 'nav-discover-downloads' ? downloads : (id === 'filelist' ? filelist : (id === 'ytdl-panel-mount' ? { id } : null)))) };
  const api = { currentServer: { token: '', ...server }, ping: () => Promise.resolve(opts.ping) };
  const ui = opts.noUi ? undefined : {
    setServer: (f) => calls.push(['setServer', f]),
    start: (o) => calls.push(['start', o]),
    mountPanel: (m, o) => calls.push(['mountPanel', m.id, o]),
    renderStrip: (f) => calls.push(['renderStrip', f]),
  };
  const body = `let peerContext = null; let programState = []; let currentBrowsingList = [1];
    ${YTDL_FNS.map(findFn).join('\n')}
    return { ${YTDL_FNS.join(', ')}, setPeer: (p) => { peerContext = p; }, state: () => programState, list: () => currentBrowsingList };`;
  const S = new Function('MSTREAMAPI', 'document', 'YTDLUI', 'location', 'atob', 'setBrowserRootPanel', 'switchServer', 't', body)(
    api, doc, ui, { origin: ORIGIN, host: 'music.local:3000' }, (s) => Buffer.from(s, 'base64').toString('binary'),
    (name, bar) => calls.push(['setBrowserRootPanel', name, bar]), (p) => calls.push(['switchServer', p]), (k) => `T:${k}`,
  );
  return { S, nav, downloads, calls, api, filelist };
}
const OK = { ytdl: 1, noUpload: false, transcode: true, vpaths: ['Music'], noMkdir: false, supportedAudioFiles: { mp3: true } };

describe('m.js: the gate, the panel, the wiring', () => {
  test('the gate: uploads on, conversion ready, a library, the route — known only once the ping answered', () => {
    assert.equal(gateSandbox(OK).S.ytdlServerAllows(), true);
    assert.equal(gateSandbox({}).S.ytdlServerAllows(), false, 'before the ping: hidden');
    for (const off of [{ noUpload: true }, { transcode: false }, { vpaths: [] }, { vpaths: undefined }, { ytdl: 0 }]) {
      assert.equal(gateSandbox({ ...OK, ...off }).S.ytdlServerAllows(), false, JSON.stringify(off));
    }
    const g = gateSandbox(OK);
    assert.equal(g.S.ytdlAllowed(), true);
    g.S.setPeer({ id: 2, name: 'Bob' });
    assert.equal(g.S.ytdlAllowed(), false, 'never on a connected server');
    assert.equal(g.S.ytdlServerAllows(), true, 'the sidenav entry is local-only: the body class hides it there');
  });

  test('the entry is shown or hidden by the gate, and the panel gets the facts', () => {
    const g = gateSandbox(OK);
    g.S.ytdlApplyGates();
    assert.equal(g.nav.classes.has('super-hide'), false);
    assert.deepEqual(g.calls[0], ['setServer', { uploadsOff: false, convertOff: false, noMkdir: false, supported: { mp3: true }, vpaths: ['Music'], name: 'music.local:3000' }]);
    assert.deepEqual(g.calls[1], ['renderStrip', null], 'the explorer\'s button and strip drawn again (no explorer here: no strip)');
    const h = gateSandbox({ ...OK, transcode: false });
    h.S.ytdlApplyGates();
    assert.equal(h.nav.classes.has('super-hide'), true, 'hidden, never greyed');
    assert.equal(h.calls[0][1].convertOff, true);
    const n = gateSandbox(OK, { noUi: true });
    n.S.ytdlApplyGates();
    assert.equal(n.nav.classes.has('super-hide'), false, 'an index.html without the module still gates');
  });

  test('the re-ping reads the facts again and applies the gate', async () => {
    const g = gateSandbox(OK, { ping: { vpaths: ['Music', 'Mixes'], noUpload: true, noMkdir: true, transcode: false, supportedAudioFiles: { flac: true } } });
    await g.S.ytdlRecheck();
    assert.equal(g.nav.classes.has('super-hide'), true);
    assert.deepEqual(g.calls[0][1], { uploadsOff: true, convertOff: true, noMkdir: true, supported: { flac: true }, vpaths: ['Music', 'Mixes'], name: 'music.local:3000' });
    const h = gateSandbox(OK);
    h.api.ping = () => Promise.reject(new TypeError('Failed to fetch'));
    await h.S.ytdlRecheck();
    assert.equal(h.calls.length, 0, 'no answer: nothing changes');
  });

  test('the Downloads entry, where an added song is removed: the plug-ins\' flag or this gate — YouTube\'s songs keep it with the plug-ins off', async () => {
    const cases = [
      [{ ...OK, discoveryPlugins: false }, false],
      [{ ...OK, discoveryPlugins: true }, false],
      [{ ...OK, transcode: false, discoveryPlugins: true }, false],
      [{ ...OK, transcode: false, discoveryPlugins: false }, true],
      [{ ...OK, ytdl: 0 }, true],
      [{}, true],
    ];
    for (const [server, hidden] of cases) {
      const g = gateSandbox(server);
      g.S.ytdlApplyGates();
      assert.equal(g.downloads.classes.has('super-hide'), hidden, JSON.stringify(server));
    }
    const r = gateSandbox({ ...OK, discoveryPlugins: false }, { ping: { vpaths: ['Music'], noUpload: true, transcode: { defaultCodec: 'opus' } } });
    r.S.ytdlApplyGates();
    assert.equal(r.downloads.classes.has('super-hide'), false);
    await r.S.ytdlRecheck();
    assert.equal(r.downloads.classes.has('super-hide'), true, 'the re-ping keeps it in step with the gate');
    // init keeps the flag and draws the entry where the old line was: after
    // every fact the gate reads, before the rest of the ping's flags.
    const init = findFn('init');
    assert.match(init, /\n {4}MSTREAMAPI\.currentServer\.discoveryPlugins = response\.discoveryPlugins === true;\n {4}ytdlDownloadsEntry\(\);\n/);
    assert.ok(init.indexOf('ytdlDownloadsEntry();') > init.indexOf('MSTREAMAPI.currentServer.ytdl = Number(response.ytdl) || 0;'));
    assert.ok(init.indexOf('ytdlDownloadsEntry();') < init.indexOf('applyDiscoveryPing(response);'));
    assert.ok(!init.includes('response.discoveryPlugins !== true'), 'the plug-ins\' flag alone no longer decides');
  });

  test('the account\'s name from the session token when /api did not say; the tracker starts for this server', () => {
    const payload = Buffer.from(JSON.stringify({ username: 'alice' })).toString('base64').replace(/=+$/, '');
    assert.equal(gateSandbox({ ...OK, token: `h.${payload}.s` }).S.ytdlTokenUser(), 'alice');
    for (const token of ['', 'nonsense', 'a.b.c', `h.${Buffer.from('[]').toString('base64')}.s`]) {
      assert.equal(gateSandbox({ ...OK, token }).S.ytdlTokenUser(), '', token);
    }
    const g = gateSandbox(OK);
    g.S.ytdlStart('alice');
    assert.deepEqual(g.calls, [['start', { origin: ORIGIN, user: 'alice' }]]);
    const old = gateSandbox({ ...OK, ytdl: 0 });
    old.S.ytdlStart('alice');
    assert.deepEqual(old.calls, [], 'a server without the route: no tracker');
  });

  test('the panel: its own state, the bar hidden, a Vue mount in #filelist; from a connected server, home first', () => {
    const g = gateSandbox(OK);
    g.S.ytdlPanel({ link: LINK });
    assert.deepEqual(g.S.state(), [{ state: 'addFromYoutube' }]);
    assert.deepEqual(g.calls[0], ['setBrowserRootPanel', 'T:panel.addFromYoutube', false]);
    assert.equal(g.filelist.innerHTML, '<div id="ytdl-panel-mount"></div>');
    assert.equal(g.filelist.scrollTop, 0);
    assert.deepEqual(g.calls[1], ['mountPanel', 'ytdl-panel-mount', { link: LINK }]);
    assert.deepEqual(g.S.list(), []);
    const p = gateSandbox(OK);
    p.S.setPeer({ id: 2, name: 'Bob' });
    p.S.ytdlPanel();
    assert.deepEqual(p.calls, [['switchServer', null]]);
    assert.deepEqual(p.S.state(), [{ state: 'addFromYoutube' }], 'switchServer draws it again');
  });

  test('a toast\'s Details from a connected server: the opts survive the switch home, and the panel opens at Needs a look', () => {
    const p = gateSandbox(OK);
    p.S.setPeer({ id: 2, name: 'Bob' });
    p.S.ytdlPanel({ needsLook: true });
    assert.deepEqual(p.calls, [['switchServer', null]]);
    assert.deepEqual(p.S.state(), [{ state: 'addFromYoutube', open: { needsLook: true } }]);
    // switchServer redraws the landing panel through PANELS_BY_STATE
    const entry = M_SRC.match(/\n {2}addFromYoutube: (\(\) => ytdlPanel\([^\n]*\)),\n/)[1];
    const drawn = [];
    const redraw = (state) => new Function('programState', 'ytdlPanel', `return ${entry};`)(state, (o) => drawn.push(o))();
    redraw(p.S.state());
    assert.deepEqual(drawn, [{ needsLook: true }]);
    redraw([{ state: 'addFromYoutube' }]);
    redraw([{ state: 'fileExplorer', open: { link: LINK } }]);
    assert.deepEqual(drawn.slice(1), [undefined, undefined], 'nothing carried otherwise');
    p.S.setPeer(null);
    p.S.ytdlPanel({ needsLook: true });
    assert.deepEqual(p.S.state(), [{ state: 'addFromYoutube' }], 'drawn here: no opts kept in the state');
    assert.deepEqual(p.calls.at(-1), ['mountPanel', 'ytdl-panel-mount', { needsLook: true }]);
  });

  test('init reads the facts the gate needs, reveals the entries, and starts the tracker with the account', () => {
    const init = findFn('init');
    assert.match(init, /MSTREAMAPI\.currentServer\.noUpload = response\.noUpload === true;/);
    assert.match(init, /MSTREAMAPI\.currentServer\.transcode = !!response\.transcode;/);
    assert.match(init, /MSTREAMAPI\.currentServer\.ytdl = Number\(response\.ytdl\) \|\| 0;/);
    assert.match(init, /\n {4}ytdlApplyGates\(\);\n {2}\}catch \(err\) \{/, 'last in the ping\'s try, after the transcode flag');
    assert.ok(init.indexOf('ytdlApplyGates();') > init.indexOf('MSTREAMPLAYER.transcodeOptions.serverEnabled = true;'));
    const info = init.slice(init.indexOf('MSTREAMAPI.serverInfo()'), init.indexOf('MSTREAMAPI.currentServer.discoveryPath'));
    assert.match(info, /MSTREAMAPI\.currentServer\.username = info && info\.user && typeof info\.user\.username === 'string' \? info\.user\.username : ytdlTokenUser\(\);\n\s*ytdlStart\(MSTREAMAPI\.currentServer\.username\);/);
    assert.match(info, /\.catch\(\(\) => \{[\s\S]*MSTREAMAPI\.currentServer\.username = ytdlTokenUser\(\);\n\s*ytdlStart\(MSTREAMAPI\.currentServer\.username\);/);
  });

  test('the panel goes with the column; it is a root panel, never a connected server\'s; its title comes back after a language change', () => {
    assert.match(findFn('setBrowserRootPanel'), /\n {2}if \(typeof YTDLUI !== 'undefined'\) \{ YTDLUI\.unmountPanel\(\); \}\n/);
    assert.match(M_SRC, /\n {2}addFromYoutube: \(\) => ytdlPanel\(programState\[0\] && programState\[0\]\.state === 'addFromYoutube' \? programState\[0\]\.open : undefined\),\n/);
    const peerCapable = M_SRC.slice(M_SRC.indexOf('const PEER_CAPABLE_STATES'), M_SRC.indexOf(']);', M_SRC.indexOf('const PEER_CAPABLE_STATES')));
    assert.ok(!peerCapable.includes('addFromYoutube'));
    const lang = M_SRC.slice(M_SRC.lastIndexOf('I18N.onChange(() => {'));
    assert.match(lang, /programState\[0\]\.state === 'addFromYoutube'\) \{\n\s*\(\[\.\.\.document\.getElementsByClassName\('panel_one_name'\)\]\)\.forEach\(\(el\) => \{ el\.textContent = t\('panel\.addFromYoutube'\); \}\);/);
    const section = M_SRC.slice(M_SRC.indexOf('///////////////// Add from YouTube'), M_SRC.indexOf('///////////////// Discover page'));
    assert.ok(section.includes('function ytdlPanel('), 'the m.js half sits in its own section');
  });
});

describe('the page\'s wiring', () => {
  test('index.html: the entry in SYSTEM right after Add Torrent, local-only and hidden until the ping; the pill beside the label', () => {
    const nav = HTML.match(/<div id="nav-ytdl" class="([^"]*)" onclick="changeView\(ytdlPanel, this\);" data-panel="addFromYoutube">([\s\S]*?)\n {4}<\/div>/);
    assert.ok(nav, 'the entry');
    for (const c of ['local-only', 'side-nav-item', 'super-hide']) { assert.ok(nav[1].split(' ').includes(c), c); }
    const torrent = HTML.indexOf('<span>Add Torrent</span>');
    const at = HTML.indexOf('id="nav-ytdl"');
    const dj = HTML.indexOf('data-i18n="nav.autoDJ"');
    assert.ok(torrent > 0 && at > torrent && dj > at);
    assert.match(nav[2], /<span data-i18n="nav\.addFromYoutube">Add from YouTube<\/span>\n\s*<span id="nav-ytdl-sr" class="dm-sr"><\/span>\n\s*<span id="nav-ytdl-pill" class="nav-ytdl-pill super-hide" aria-hidden="true"><\/span>/, 'the pill and its words are siblings of the label, never inside it');
    assert.match(nav[2], /<rect [^>]*fill="none"\/><path [^>]*fill="#DDD"\/>/, 'the outline icon: each shape names its own fill (#sidenav svg fills the rest white)');
  });

  test('index.html: the scripts in order — the rules and the tracker before vp.js, the panel after it; the windows\' host', () => {
    const order = ['alpha/discover-jobs.js', 'alpha/ytdl-core.js', 'alpha/ytdl-jobs.js', 'alpha/vp.js', 'alpha/ytdl-ui.js'].map((s) => HTML.indexOf(`<script src="${s}"></script>`));
    assert.ok(order.every((i) => i > 0), 'every script');
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    assert.ok(HTML.indexOf('<div id="ytdl-windows"></div>') > 0 && HTML.indexOf('<div id="ytdl-windows"></div>') < order[0]);
  });

  test('vp.js: the player\'s hotkeys skip the panel; the window helpers and closeDiscoverModal are exported', () => {
    const a = VP_SRC.indexOf('\n  function hotkeysSkip(');
    const skip = new Function(`${VP_SRC.slice(a, VP_SRC.indexOf('\n  }\n', a) + 4)}\nreturn hotkeysSkip;`)();
    const target = (inside) => ({ tagName: 'BUTTON', isContentEditable: false, closest: (sel) => (sel.split(/,\s*/).includes(inside) ? {} : null) });
    assert.equal(skip(target('.ytdl-panel')), true, 'Space presses a panel button, the arrows move between its radios');
    assert.equal(skip(target('.elsewhere')), false);
    assert.match(VP_SRC, /\n {2}mstreamModule\.dmTabbables = dmTabbables;\n {2}mstreamModule\.dmTrapTarget = dmTrapTarget;\n {2}mstreamModule\.closeDiscoverModal = \(\) => \{/);
  });

  test('api.js: the lookup passes its signal to req()', async () => {
    const src = readSrc('webapp/alpha/api.js');
    const seen = [];
    const fetchStub = (url, init) => { seen.push({ url, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
    const api = new Function('fetch', `${src}\nreturn MSTREAMAPI;`)(fetchStub);
    const ctl = new AbortController();
    await api.ytdlMetadata(URL1, { signal: ctl.signal });
    assert.equal(seen[0].url, `api/v1/ytdl/metadata?url=${encodeURIComponent(URL1)}`);
    assert.equal(seen[0].init.signal, ctl.signal);
  });

  test('spa.css: the panel declares the window\'s tokens and the page\'s orange ring; the native radios come back in the window; the pill\'s three colours', () => {
    const block = CSS.slice(CSS.indexOf('/* ── Add from YouTube'), CSS.indexOf('/* ── The Discover page'));
    assert.ok(block.length > 0, 'its own section, before the Discover page\'s');
    assert.match(block, /\n\.ytdl-panel \{\n {2}--win: #2d333b;[^}]*--src: #4fb8a8; --src-2: #5ec9b9;/);
    assert.match(block, /\n\.ytdl-panel :focus-visible \{ outline: 2px solid #fa832b; outline-offset: 2px; \}/);
    assert.match(block, /\n\.ytdl-panel button \{ -webkit-appearance: none; appearance: none; margin: 0; font-family: inherit; \}/);
    assert.match(block, /\.ytw \.ytw-opt \.ytw-radio \{\n {2}order: -1; position: static;[^}]*opacity: 1; pointer-events: auto;/);
    assert.match(block, /#sidenav \.nav-ytdl-pill svg \{[^}]*margin: 0; fill: none; \}/);
    assert.match(block, /#sidenav \.nav-ytdl-pill \{[^}]*border: 1px solid rgba\(79, 184, 168, \.55\);[^}]*color: #4fb8a8;/);
    assert.match(block, /\.nav-ytdl-pill\.is-failed \{ border-color: rgba\(245, 160, 91, \.55\); color: #f5a05b; \}/);
    assert.match(block, /\.nav-ytdl-pill\.is-added \{ border-color: rgba\(79, 194, 122, \.55\); color: #4fc27a; \}/);
    assert.match(block, /\.dmodal-shadow \.dmodal\.ytw \.ytw-custom-input:focus-visible \{ outline: none; \}/);
    assert.match(block, /@media \(hover: none\) \{\n {2}\.ytp-added \.yt-more \{ opacity: 1; \}/, 'the ⋯ stays up on a touch screen');
    assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.yt-bar i \{ animation: none;/);
    assert.ok(!/ytdl-panel[^{]*\{[^}]*border-left:\s*3px/.test(block), 'no left-border accent box');
  });

  test('spa.css below 600 px: the card as WebNarrow draws it, 40 px targets, the bar\'s button its neighbours\' size; the menus\' and the tree\'s keyboard rings', () => {
    const block = CSS.slice(CSS.indexOf('/* ── Add from YouTube'), CSS.indexOf('/* ── The Discover page'));
    const narrow = block.slice(block.indexOf('@media (max-width: 600px) {'));
    // Title beside the thumbnail; Artist, Album and a 120 px Year each a row
    assert.match(narrow, /\n {2}\.ytp-found \{ display: grid; grid-template-columns: 96px minmax\(0, 1fr\); gap: 10px 12px; align-items: end; \}/);
    assert.match(narrow, /\n {2}\.ytp-fields \{ display: contents; \}/);
    assert.match(narrow, /\n {2}\.ytp-field, \.ytp-help \{ grid-column: 1 \/ -1; \}\n {2}\.ytp-field\.ytp-f-title \{ grid-column: 2; \}\n {2}\.ytp-field\.ytp-year \{ width: 120px; \}/);
    assert.ok(!narrow.includes('grid-template-columns: minmax(0, 1fr) 120px'), 'no Album-and-Year row any more');
    assert.match(UI_SRC, /<div class="ytp-field ytp-wide ytp-f-title">/);
    assert.ok(!/#directory_bar > \.ytdl-bar-btn \{ width: 40px; height: 40px; \}/.test(block), 'the bar\'s icons all one size (WebNarrow draws 32)');
    assert.match(narrow, /\.ytw \.ytp-chip, \.ytw \.ytp-chip:focus \{ height: 40px; \}/, 'the window\'s Put back chips');
    assert.match(narrow, /\n {2}\.yt-menu \.yt-fmt-item, \.yt-menu \.yt-fmt-item:focus, \.yt-menu \.yt-more-item, \.yt-menu \.yt-more-item:focus \{ min-height: 40px; align-items: center; \}/);
    assert.match(narrow, /\n {2}\.ytdl-strip \.ytdl-strip-all, \.ytdl-strip \.ytdl-strip-all:focus \{ min-height: 40px; margin: 0 -8px; padding: 0 8px; \}/);
    // a ring, not the tint alone (1.4:1); the help line lighter on it
    assert.match(block, /\n\.ytdl-panel \.yt-menu \.yt-fmt-item:focus-visible, \.ytdl-panel \.yt-menu \.yt-more-item:focus-visible \{ box-shadow: inset 0 0 0 2px #fa832b; \}/);
    assert.match(block, /\n\.ytw \.yt-menu \.yt-fmt-item:focus-visible, \.ytw \.yt-menu \.yt-more-item:focus-visible \{ box-shadow: inset 0 0 0 2px var\(--t1\); \}/);
    assert.match(block, /\n\.yt-menu \.yt-fmt-item:hover \.yt-fmt-help, \.yt-menu \.yt-fmt-item:focus-visible \.yt-fmt-help \{ color: var\(--t3\); \}/);
    assert.match(block, /\n\.dmodal-shadow \.dmodal \.ytw-node:focus-visible \{ outline-offset: -2px; \}/, 'inside the tree\'s scroll box');
  });

  test('the panel is never a .dmodal (its box rules, Discover\'s focus fallback)', () => {
    const panel = UI_SRC.slice(UI_SRC.indexOf("Vue.component('yt-panel'"), UI_SRC.indexOf('// A Needs a look row\'s button'));
    assert.ok(!/class="[^"]*\bdmodal\b/.test(panel));
  });
});

describe('the explorer window\'s draft', () => {
  const HERE = '/Music/Daft Punk/';
  const texts = (crumbs) => crumbs.map((c) => (c.isNew ? `${c.text}+` : c.text));

  test('Right here: the folder on screen, "Add here", sent as it is — never a folder made, even for an account that can\'t make folders', async () => {
    const env = makeDraft({ folder: 'Music/Daft Punk/', server: { noMkdir: true } });
    assert.equal(env.d.folder, HERE, 'either spelling of the explorer\'s path');
    await found(env, MUSIC);
    const m = model(env.d);
    assert.equal(m.primary.label.key, 'ytdl.addHere');
    assert.deepEqual(texts(m.crumbs), ['Music', 'Daft Punk']);
    assert.equal(m.sub.open, false);
    assert.equal(m.block, 'none');
    assert.equal(m.noMkdir, null);
    assert.equal(await env.d.add(), true);
    assert.equal(env.adds[0].directory, HERE);
    assert.equal(env.adds[0].mkdir, undefined, 'no folder to make');
    assert.deepEqual(env.adds[0].crumbs, ['Music', 'Daft Punk']);
    assert.equal(env.d.s.link, '', 'the card clears for the next link');
  });

  test('the panel\'s draft has no folder and keeps "Add to library"', async () => {
    const env = makeDraft();
    assert.equal(env.d.folder, null);
    await found(env, MUSIC);
    const m = model(env.d);
    assert.equal(m.sub, null);
    assert.equal(m.primary.label.key, 'ytdl.add');
  });

  test('Sort into subfolders…: Album under the folder, the new folder marked NEW, "Add to library", the folder made first', async () => {
    const env = makeDraft({ folder: HERE });
    await found(env, MUSIC);
    env.d.openSub();
    let m = model(env.d);
    assert.equal(m.sub.open, true);
    assert.equal(m.sub.kind, 'here', 'opening the radios changes nothing yet');
    assert.equal(m.primary.label.key, 'ytdl.addHere');
    env.d.setSub('album');
    await env.timers.advance(U.CHECK_AFTER_MS);
    m = model(env.d);
    assert.deepEqual(texts(m.sub.crumbs), ['Music', 'Daft Punk', 'Discovery+']);
    assert.equal(m.primary.label.key, 'ytdl.add', 'with a subfolder the button reads Add to library');
    assert.equal(await env.d.add(), true);
    assert.equal(env.adds[0].directory, '/Music/Daft Punk/Discovery/');
    assert.equal(env.adds[0].mkdir, true);
    assert.equal(env.adds[0].mkdirFolder, 'Discovery');
    assert.equal(env.d.s.sub, 'here', 'the choice lasted one add');
    assert.equal(env.d.s.subOpen, false);
  });

  test('Artist / Album goes under the folder on screen too; an existing subfolder is not new', async () => {
    const env = makeDraft({ folder: HERE });
    env.api.dirs.set('/Music/Daft Punk/Daft Punk/', { dirs: [], files: [] });
    env.api.dirs.get(HERE).dirs.push('Daft Punk');
    await found(env, MUSIC);
    env.d.openSub();
    env.d.setSub('artistAlbum');
    await env.timers.advance(U.CHECK_AFTER_MS);
    const m = model(env.d);
    assert.equal(m.target.directory, '/Music/Daft Punk/Daft Punk/Discovery/');
    assert.deepEqual(texts(m.sub.crumbs), ['Music', 'Daft Punk', 'Daft Punk', 'Discovery+']);
  });

  test('Custom: left empty it names no folder (Add off, no line); a layout the checks refuse says so; one that works lands under the folder', async () => {
    const env = makeDraft({ folder: HERE });
    await found(env, MUSIC);
    env.d.openSub();
    env.d.setSub('custom');
    let m = model(env.d);
    assert.equal(m.block, 'invalidLayout');
    assert.equal(m.primary.disabled, true);
    assert.equal(m.reason, null, 'the field is the prompt, not "Fix the layout"');
    assert.equal(m.sub.error, null);
    assert.equal(m.sub.fix, false);
    assert.deepEqual(texts(m.sub.crumbs), ['Music', 'Daft Punk'], 'the folder itself, nothing under it yet');
    env.d.setSubCustom('{{TITLE}}');
    m = model(env.d);
    assert.equal(m.sub.error.key, 'ytdl.where.err.unknownVar');
    assert.equal(m.sub.fix, true);
    assert.equal(m.primary.disabled, true);
    assert.equal(m.reason, null, 'said once, under the field');
    env.d.setSubCustom('{{GENRE}}');
    assert.equal(model(env.d).sub.error.key, 'ytdl.where.err.neverVar');
    env.d.setSubCustom('{{ALBUM}} ({{YEAR}})');
    await env.timers.advance(U.CHECK_AFTER_MS);
    m = model(env.d);
    assert.equal(m.sub.error, null);
    assert.equal(m.block, 'none');
    assert.equal(m.target.directory, '/Music/Daft Punk/Discovery (2001)/');
    assert.deepEqual(texts(m.sub.crumbs), ['Music', 'Daft Punk', 'Discovery (2001)+']);
  });

  test('the choice lasts one window: opened again it starts at Right here, the link and the edits kept — not while its add is starting', async () => {
    const env = makeDraft({ folder: HERE });
    await found(env, MUSIC);
    env.d.openSub();
    env.d.setSub('custom');
    env.d.setSubCustom('{{ALBUM}}');
    env.d.setField('title', 'OMT');
    env.d.sheetOpened();
    assert.equal(env.d.s.sub, 'here');
    assert.equal(env.d.s.subCustom, '');
    assert.equal(env.d.s.subOpen, false);
    assert.equal(env.d.s.fields.title, 'OMT');
    assert.equal(env.d.s.url, URL1);
    const slow = makeDraft({ folder: HERE, outcome: () => new Promise(() => {}) });
    await found(slow, MUSIC);
    slow.d.openSub();
    slow.d.setSub('album');
    await slow.timers.advance(U.CHECK_AFTER_MS);
    slow.d.add();
    await settle();
    assert.equal(slow.d.s.starting, true);
    slow.d.sheetOpened();
    assert.equal(slow.d.s.sub, 'album', 'it goes where it was sent');
    assert.equal(model(slow.d).primary.label.key, 'ytdl.adding');
  });

  test('an account that can\'t make folders: a new subfolder is refused in place; "Save to … instead" is the folder on screen — Right here again', async () => {
    const env = makeDraft({ folder: HERE, server: { noMkdir: true } });
    await found(env, MUSIC);
    env.d.openSub();
    env.d.setSub('album');
    await env.timers.advance(U.CHECK_AFTER_MS);
    let m = model(env.d);
    assert.equal(m.block, 'mkdirBlocked');
    assert.equal(m.noMkdir.label.key, 'ytdl.noMkdir.new');
    assert.deepEqual(m.noMkdir.label.params, { folder: 'Discovery' });
    assert.deepEqual(m.noMkdir.deepest, ['Music', 'Daft Punk']);
    env.d.saveToDeepest();
    m = model(env.d);
    assert.equal(env.d.s.sub, 'here');
    assert.equal(env.d.s.just, null);
    assert.equal(m.sub.open, false);
    assert.equal(m.primary.label.key, 'ytdl.addHere');
    assert.equal(m.block, 'none');
  });

  test('a folder picked for this song (Choose a folder…): "Add to library" into it; a subfolder radio takes over again', async () => {
    const env = makeDraft({ folder: HERE, server: { noMkdir: true } });
    await found(env, MUSIC);
    env.d.useFolder('/Music/');
    let m = model(env.d);
    assert.deepEqual(texts(m.crumbs), ['Music']);
    assert.equal(m.primary.label.key, 'ytdl.add');
    assert.equal(m.sub.open, false);
    env.d.openSub();
    assert.equal(env.d.s.just, null, '"Sort into subfolders…" lets go of it');
    env.d.useFolder('/Music/');
    env.d.setSub('here');
    m = model(env.d);
    assert.equal(env.d.s.just, null);
    assert.equal(m.primary.label.key, 'ytdl.addHere');
  });

  test('a clash reads "Add anyway"; the server\'s 409 shows in the window, the link kept, Add off until the format changes', async () => {
    const refusal = Y.classifyAdd({ status: 409, body: { error: '“One_More_Time.mp3” is already in this folder, so nothing was added.', reason: 'exists', fileName: 'One_More_Time.mp3' } });
    const env = makeDraft({ folder: HERE, outcome: () => ({ ok: false, unsure: false, failure: refusal, job: null }) });
    env.api.dirs.set(HERE, { dirs: ['Homework'], files: ['One_More_Time.mp3'] });
    await found(env, MUSIC);
    let m = model(env.d);
    assert.equal(m.clash.label.key, 'ytdl.clash');
    assert.equal(m.primary.label.key, 'ytdl.addAnyway');
    assert.equal(await env.d.add(), false, 'the window stays');
    m = model(env.d);
    assert.equal(m.failure.label.key, 'ytdl.err.exists');
    assert.deepEqual(m.failure.label.params, { name: 'One_More_Time.mp3' });
    assert.equal(m.clash, null, 'said once');
    assert.equal(m.primary.disabled, true);
    assert.equal(env.d.s.link, LINK);
    env.d.setFormat('flac');
    assert.equal(model(env.d).failure, null);
  });

  test('Right here\'s name check reads the explorer\'s own rows when the folder won\'t list', async () => {
    const asked = [];
    const env = makeDraft({ folder: HERE, shown: (dir) => { asked.push(dir); return dir === HERE ? ['One_More_Time.mp3'] : null; } });
    env.api.dirs.delete(HERE);
    await found(env, MUSIC);
    assert.equal(model(env.d).clash.label.key, 'ytdl.clash');
    assert.deepEqual(asked, [HERE]);
  });
});

describe('the explorer: the strip, the re-list, a paste, the toasts', () => {
  const job = (o) => ({ id: 'j', url: URL1, directory: '/Music/Daft Punk/', title: 'One More Time', state: 'adding', ...o });

  test('the strip: only while an add into the folder runs — one by its title, more by a count; failures and hidden rows say nothing there', () => {
    assert.equal(U.stripView([]), null);
    assert.equal(U.stripView(null), null);
    assert.deepEqual(U.stripView([job()]), { key: 'ytdl.strip.adding', params: { title: 'One More Time' } });
    assert.deepEqual(U.stripView([job({ state: 'starting' }), job({ id: 'k', state: 'startUnsure' })]), { key: 'ytdl.strip.addingCount', params: { count: 2 } });
    assert.equal(U.stripView([job({ state: 'failed' }), job({ state: 'startFailed' }), job({ state: 'added' })]), null);
    assert.equal(U.stripView([job({ hidden: true })]), null);
    assert.deepEqual(U.stripView([job({ title: '  ', fileName: 'One_More_Time.mp3' })]).params, { title: 'One_More_Time.mp3' });
    assert.deepEqual(U.stripView([job({ title: '', fileName: null })]).params, { title: URL1 });
  });

  test('a settled job asks the folder on screen to list again when it went into it or below it (whole names, any case, either spelling)', () => {
    const here = '/Music/Daft Punk/';
    assert.equal(U.relistWanted(here, '/Music/Daft Punk/'), true);
    assert.equal(U.relistWanted('Music/Daft Punk/', 'Music/Daft Punk'), true);
    assert.equal(U.relistWanted(here, '/Music/Daft Punk/Discovery/'), true);
    assert.equal(U.relistWanted(here, '/music/daft punk/discovery/'), true);
    assert.equal(U.relistWanted(here, '/Music/'), false, 'a parent');
    assert.equal(U.relistWanted(here, '/Music/Daft Punk Live/'), false, 'a name that starts the same');
    assert.equal(U.relistWanted(here, '/Mixes/Daft Punk/'), false);
    assert.equal(U.relistWanted('/', '/Music/'), false, 'never at the root');
    assert.equal(U.relistWanted(here, null), false);
  });

  test('the re-list\'s diff: the names the new listing brought, ignoring case', () => {
    const before = [{ type: 'directory', name: 'Homework' }, { type: 'mp3', name: 'Aerodynamic.mp3' }];
    const after = { path: '/Music/Daft Punk/', directories: [{ name: 'Homework' }, { name: 'Discovery' }], files: [{ type: 'mp3', name: 'aerodynamic.mp3' }, { type: 'mp3', name: 'One_More_Time.mp3' }] };
    assert.deepEqual(U.newRows(before, after), ['Discovery', 'One_More_Time.mp3']);
    assert.deepEqual(U.newRows(after, after), []);
    assert.deepEqual(U.newRows(null, { directories: ['A'], files: [] }), ['A']);
    assert.deepEqual(U.listingNames(after), ['Homework', 'Discovery', 'aerodynamic.mp3', 'One_More_Time.mp3']);
  });

  test('the ring: the song\'s own row (named by the job, matched as the explorer writes it), or the subfolder it went into when that is new', () => {
    const folder = '/Music/Daft Punk/';
    const before = [{ type: 'directory', name: 'Homework' }];
    const after = {
      path: '/Music/Daft Punk/',
      directories: [{ name: 'Homework' }, { name: 'Discovery' }],
      files: [{ type: 'mp3', name: 'One_More_Time.mp3' }, { type: 'mp3', name: 'Other.mp3', path: '/Music/Daft Punk/Other.mp3' }],
    };
    const added = (o) => job({ state: 'added', ...o });
    // the record's filepath has no leading slash; the row's location has one
    assert.deepEqual(U.ringTarget({ folder, job: added({ filePath: 'Music/Daft Punk/One_More_Time.mp3' }), before, after }), { kind: 'file', value: '/Music/Daft Punk/One_More_Time.mp3' });
    assert.deepEqual(U.ringTarget({ folder, job: added({ filePath: 'music/daft punk/one_more_time.MP3' }), before, after }), { kind: 'file', value: '/Music/Daft Punk/One_More_Time.mp3' }, 'any case');
    assert.deepEqual(U.ringTarget({ folder, job: added({ filePath: null, fileName: 'Other.mp3' }), before, after }), { kind: 'file', value: '/Music/Daft Punk/Other.mp3' }, 'no landed path: the predicted name; the listing\'s own path');
    assert.equal(U.ringTarget({ folder, job: added({ filePath: 'Music/Daft Punk/Gone.mp3' }), before, after }), null, 'not listed: nothing ringed');
    assert.equal(U.ringTarget({ folder, job: added({ filePath: null, fileName: null }), before, after }), null);
    // into a subfolder: its row, while it is new
    const sub = added({ directory: '/Music/Daft Punk/Discovery/', filePath: 'Music/Daft Punk/Discovery/One_More_Time.mp3' });
    assert.deepEqual(U.ringTarget({ folder, job: sub, before, after }), { kind: 'dir', value: 'Discovery' });
    assert.deepEqual(U.ringTarget({ folder, job: added({ directory: '/Music/Daft Punk/discovery/2001/' }), before, after }), { kind: 'dir', value: 'Discovery' }, 'deeper: the folder on this level, as listed');
    assert.equal(U.ringTarget({ folder, job: added({ directory: '/Music/Daft Punk/Homework/' }), before, after }), null, 'a subfolder that was there already');
    assert.equal(U.ringTarget({ folder, job: added({ directory: '/Music/Daft Punk/Discovery/' }), before, after: { directories: [], files: [] } }), null);
    assert.equal(U.ringTarget({ folder, job: added({ directory: '/Music/Homework/' }), before, after }), null, 'another folder');
  });

  test('a paste\'s target that takes the text itself: inputs, textareas, selects, anything editable', () => {
    const node = (tag, o = {}) => ({ tagName: tag, isContentEditable: false, closest: () => null, ...o });
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) { assert.equal(U.isField(node(t)), true, t); }
    assert.equal(U.isField(node('DIV', { isContentEditable: true })), true);
    assert.equal(U.isField(node('SPAN', { closest: (sel) => (sel.startsWith('[contenteditable]') ? {} : null) })), true, 'inside an editable block');
    assert.equal(U.isField({ nodeType: 3, parentNode: node('TEXTAREA') }), true, 'a text node: its element');
    assert.equal(U.isField(node('BODY')), false);
    assert.equal(U.isField(node('BUTTON')), false);
    assert.equal(U.isField(null), false);
  });

  test('a paste: a YouTube link opens the window over a writable folder, the panel elsewhere; the one already up takes it; anything else is left alone', () => {
    const base = { text: LINK, field: false, blocked: false, allowed: true, folder: null, panel: false, win: null };
    const act = (o) => U.pasteAction({ ...base, ...o });
    assert.deepEqual(act({ folder: '/Music/Daft Punk/' }), { to: 'window', folder: '/Music/Daft Punk/', link: LINK });
    assert.deepEqual(act({}), { to: 'panel', link: LINK }, 'no folder on screen');
    assert.deepEqual(act({ panel: true, folder: null }), { to: 'panel', link: LINK }, 'the panel up: in place');
    assert.deepEqual(act({ win: { mode: 'here', folder: '/Music/Homework/' }, folder: '/Music/Daft Punk/' }), { to: 'window', folder: '/Music/Homework/', link: LINK }, 'the window up: in place');
    assert.equal(act({ win: { mode: 'where', folder: null } }), null, 'Where new songs land holds the keyboard');
    assert.deepEqual(act({ text: '  youtu.be/FGBhQbmPwH8\n' }), { to: 'panel', link: 'youtu.be/FGBhQbmPwH8' }, 'trimmed, as pasted');
    assert.deepEqual(act({ text: `Listen to this: ${LINK} !` }), { to: 'panel', link: URL1 }, 'more than the link: the link');
    assert.deepEqual(act({ text: 'https://www.youtube.com/playlist?list=PLx' }), { to: 'panel', link: 'https://www.youtube.com/playlist?list=PLx' }, 'a playlist: the card explains');
    for (const text of ['', 'hello', 'https://vimeo.com/123', 'https://youtube.com.evil.com/watch?v=FGBhQbmPwH8']) { assert.equal(act({ text }), null, text); }
    assert.equal(act({ field: true }), null, 'a field takes its own paste');
    assert.equal(act({ blocked: true }), null, 'another window or a modal is up');
    assert.equal(act({ allowed: false, folder: '/Music/Daft Punk/' }), null, 'a connected server, uploads off, no conversion');
  });

  test('the toasts: "Added “…” to …" (success), "Couldn\'t add “…”" with Details (warning); nothing for the other states', () => {
    const added = U.toastView(job({ state: 'added', crumbs: ['Music', 'Daft Punk', 'Discovery'], directory: '/Music/Daft Punk/Discovery/' }));
    assert.equal(added.tone, 'success');
    assert.equal(added.label.key, 'ytdl.toast.added');
    assert.equal(added.label.params.title, 'One More Time');
    assert.equal(added.details, null);
    for (const state of ['failed', 'startFailed']) {
      const v = U.toastView(job({ state, title: 'Around the World' }));
      assert.equal(v.tone, 'warning');
      assert.deepEqual(v.label, { key: 'ytdl.toast.couldntAdd', params: { title: 'Around the World' } });
      assert.deepEqual(v.details, { key: 'ytdl.toast.details' });
    }
    for (const state of ['starting', 'adding', 'notSureStarted', 'notFound']) { assert.equal(U.toastView(job({ state })), null, state); }
  });
});

// The explorer's m.js half under stub globals: the folder on screen, the
// bar's button and strip, the quiet re-list and its ring, the toasts, the
// paste.
function explorerSandbox(o = {}) {
  const calls = [];
  const timers = [];
  const node = (id, { classes: start, ...extra } = {}) => {
    const classes = new Set(start || []);
    return Object.assign({
      id, classes, style: { display: '' }, value: '', scrollTop: 0, attrs: {}, events: [],
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c), toggle: (c, on) => { if (on) { classes.add(c); } else { classes.delete(c); } },
      },
      dispatchEvent(e) { this.events.push(e.type); calls.push(['event', id, e.type]); },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    }, extra);
  };
  const els = {
    directory_bar: node('directory_bar'), ytdl_btn: node('ytdl_btn', { classes: ['super-hide'] }), filelist: node('filelist', { scrollTop: 120 }),
    localSearchBar: node('localSearchBar'), 'nav-ytdl': node('nav-ytdl'),
  };
  const tab = node('tab');
  let rows = [];
  const shades = o.shades || [];
  const doc = {
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '.m-tab.panel_one_name' ? tab : (o.active && sel === o.active ? {} : null)),
    querySelectorAll: (sel) => {
      if (sel === '.dmodal-shadow') { return shades; }
      return rows.filter((r) => sel.includes(r.el.cls)).map((r) => r.el);
    },
  };
  const row = (cls, attr, value) => {
    const li = node('li');
    const el = node('row', { cls, attrs: { [attr]: value }, closest: (s) => (s === 'li' ? li : null) });
    return { el, li };
  };
  const api = {
    currentServer: { ytdl: 1, noUpload: false, transcode: true, vpaths: ['Music'], ...(o.server || {}) },
    dirparser: (dir) => { calls.push(['dirparser', dir]); return o.listing ? o.listing(dir) : Promise.resolve({ path: `/${dir}`, directories: [], files: [] }); },
  };
  const ui = {
    ...U,
    renderStrip: (f) => calls.push(['renderStrip', f]),
    openHere: (f, opts) => calls.push(['openHere', f, opts.link, opts.opener && opts.opener.id]),
    windowOpen: () => o.win || null,
  };
  const izi = {
    success: (x) => calls.push(['toast.success', x]),
    warning: (x) => calls.push(['toast.warning', x]),
  };
  const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const t = (k, p) => {
    const v = EN[k];
    const s = typeof v === 'string' ? v : (v && (p && p.count === 1 ? v.one : v.other)) || k;
    return s.replace(/\{\{(\w+)\}\}/g, (_, n) => (p && n in p ? String(p[n]) : `{{${n}}}`));
  };
  const printdir = (res) => {
    calls.push(['printdir', res.path]);
    sb.list = [...res.directories.map((d) => ({ type: 'directory', name: d.name })), ...res.files.map((f) => ({ type: f.type, name: f.name }))];
    els.localSearchBar.value = '';
    els.filelist.scrollTop = 0;
    rows = [...res.directories.map((d) => row('.dirz', 'data-directory', d.name)), ...res.files.map((f) => row('.filez', 'data-file_location', f.path || res.path + f.name))];
  };
  const fns = ['ytdlServerAllows', 'ytdlAllowed', 'ytdlOpenPanel', 'ytdlExplorerFolder', 'ytdlRefreshExplorer', 'ytdlShownNames', 'ytdlOpenWindow',
    'ytdlSettled', 'ytdlRing', 'ytdlToast', 'ytdlOnPaste', 'getFileExplorerPath'];
  const body = `let peerContext = null; let programState = []; let fileExplorerArray = []; let currentBrowsingList = []; let browseGeneration = 0;
    ${fns.map(findFn).join('\n')}
    return { ${fns.join(', ')},
      set: (s) => { if ('peer' in s) { peerContext = s.peer; } if ('state' in s) { programState = s.state; } if ('dirs' in s) { fileExplorerArray = s.dirs; } if ('list' in s) { currentBrowsingList = s.list; } if ('gen' in s) { browseGeneration = s.gen; } },
      get list() { return currentBrowsingList; }, set list(v) { currentBrowsingList = v; } };`;
  const sb = new Function('MSTREAMAPI', 'document', 'YTDLUI', 'iziToast', 'escapeHtml', 't', 'printdir', 'changeView', 'toggleThing', 'ytdlPanel', 'myModal', 'setTimeout', 'Event', body)(
    api, doc, ui, izi, escapeHtml, t, printdir,
    (fn, el) => { calls.push(['changeView', el.id]); fn(); },
    (el, on) => calls.push(['toggleThing', el.id, on]),
    (opts) => calls.push(['ytdlPanel', opts]),
    { isOpened: !!o.modal },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    class { constructor(type) { this.type = type; } },
  );
  // the explorer in /Music/Daft Punk/ by default
  if (o.explorer !== false) {
    sb.set({ state: [{ state: 'fileExplorer' }, { state: 'fileExplorer' }, { state: 'fileExplorer' }], dirs: ['Music', 'Daft Punk'] });
  }
  return { S: sb, els, calls, timers, tab, api, setRows: (r) => { rows = r; }, rows: () => rows, row };
}

describe('m.js: the explorer\'s side', () => {
  test('the folder on screen: the explorer, its bar shown, a folder below the root, this server — the stale state other panels leave is not it', () => {
    const x = explorerSandbox();
    assert.equal(x.S.ytdlExplorerFolder(), '/Music/Daft Punk/');
    x.els.directory_bar.style.display = 'none';
    assert.equal(x.S.ytdlExplorerFolder(), null, 'Auto DJ & co. leave programState on the explorer but hide the bar');
    x.els.directory_bar.style.display = '';
    x.S.set({ dirs: [] });
    assert.equal(x.S.ytdlExplorerFolder(), null, 'the root');
    x.S.set({ dirs: ['Music'] });
    assert.equal(x.S.ytdlExplorerFolder(), '/Music/', 'a library\'s top');
    x.S.set({ peer: { id: 2, name: 'Bob' } });
    assert.equal(x.S.ytdlExplorerFolder(), null, 'a connected server');
    x.S.set({ peer: null, state: [{ state: 'allPlaylists' }] });
    assert.equal(x.S.ytdlExplorerFolder(), null, 'another panel (its bar shows)');
  });

  test('an open .m3u is a playlist on screen, no folder: no button, no strip, no window, no paste into it', () => {
    const x = explorerSandbox();
    x.S.set({ state: [{ state: 'fileExplorer' }, { state: 'fileExplorer' }, { state: 'fileExplorer' }, { state: 'fileExplorer', m3u: true }], dirs: ['Music', 'Daft Punk', 'list.m3u'] });
    assert.equal(x.S.ytdlExplorerFolder(), null);
    x.els.ytdl_btn.classes.delete('super-hide');
    x.S.ytdlRefreshExplorer();
    assert.equal(x.els.ytdl_btn.classes.has('super-hide'), true);
    assert.deepEqual(x.calls.pop(), ['renderStrip', null]);
    x.S.ytdlOpenWindow();
    x.S.ytdlOnPaste({ target: { tagName: 'BODY', closest: () => null }, clipboardData: { getData: () => LINK } });
    assert.ok(!x.calls.some((c) => c[0] === 'openHere'), 'never the playlist file as a folder');
    assert.deepEqual(x.calls.slice(-3), [['changeView', 'nav-ytdl'], ['ytdlPanel', { link: LINK }], ['toggleThing', 'tab', true]], 'a paste opens the panel instead');
    // back out of it (onBackButton pops the state): the folder again
    x.S.set({ state: [{ state: 'fileExplorer' }, { state: 'fileExplorer' }, { state: 'fileExplorer' }], dirs: ['Music', 'Daft Punk'] });
    assert.equal(x.S.ytdlExplorerFolder(), '/Music/Daft Punk/');
    const open = findFn('onFilePlaylistClick');
    assert.match(open, /programState\.push\(\{\n\s*state: 'fileExplorer',\n\s*m3u: true,/);
    assert.ok(open.indexOf('ytdlRefreshExplorer();') > open.indexOf('m3u: true') && open.indexOf('ytdlRefreshExplorer();') < open.indexOf('await MSTREAMAPI.loadFileplaylist'), 'the button goes before the playlist lists');
  });

  test('the bar\'s button shows only for a writable folder on screen, by the gate; the strip is drawn for the folder', () => {
    const x = explorerSandbox();
    x.S.ytdlRefreshExplorer();
    assert.equal(x.els.ytdl_btn.classes.has('super-hide'), false);
    assert.deepEqual(x.calls.pop(), ['renderStrip', '/Music/Daft Punk/']);
    for (const off of [{ noUpload: true }, { transcode: false }, { ytdl: 0 }, { vpaths: [] }]) {
      const y = explorerSandbox({ server: off });
      y.S.ytdlRefreshExplorer();
      assert.equal(y.els.ytdl_btn.classes.has('super-hide'), true, `hidden, never greyed: ${JSON.stringify(off)}`);
      assert.deepEqual(y.calls.pop(), ['renderStrip', '/Music/Daft Punk/'], 'the jobs still show');
    }
    const z = explorerSandbox();
    z.S.set({ dirs: [] });
    z.S.ytdlRefreshExplorer();
    assert.equal(z.els.ytdl_btn.classes.has('super-hide'), true, 'at the root');
    assert.deepEqual(z.calls.pop(), ['renderStrip', null]);
  });

  test('the button opens the window for the folder on screen, the keyboard back on it after; never past the gate', () => {
    const x = explorerSandbox();
    x.S.ytdlOpenWindow();
    assert.deepEqual(x.calls.pop(), ['openHere', '/Music/Daft Punk/', undefined, 'ytdl_btn']);
    const y = explorerSandbox({ server: { noUpload: true } });
    y.S.ytdlOpenWindow();
    assert.equal(y.calls.length, 0);
  });

  test('the explorer\'s own rows for the window\'s Right here — only while it shows that folder', () => {
    const x = explorerSandbox();
    x.S.set({ list: [{ type: 'directory', name: 'Homework' }, { type: 'mp3', name: 'One_More_Time.mp3' }] });
    assert.deepEqual(x.S.ytdlShownNames('/Music/Daft Punk/'), ['One_More_Time.mp3']);
    assert.deepEqual(x.S.ytdlShownNames('Music/Daft Punk'), ['One_More_Time.mp3']);
    assert.equal(x.S.ytdlShownNames('/Music/Homework/'), null);
  });

  test('a settled add lists the folder again quietly — the filter\'s words and the scroll kept — and rings the new row, fading after 2 s', async () => {
    const listing = { path: '/Music/Daft Punk/', directories: [{ name: 'Homework' }], files: [{ type: 'mp3', name: 'One_More_Time.mp3' }] };
    const x = explorerSandbox({ listing: () => Promise.resolve(listing) });
    x.S.set({ list: [{ type: 'directory', name: 'Homework' }] });
    x.els.localSearchBar.value = 'one';
    await x.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/', filePath: 'Music/Daft Punk/One_More_Time.mp3' });
    assert.deepEqual(x.calls.slice(0, 3), [['dirparser', 'Music/Daft Punk/'], ['printdir', '/Music/Daft Punk/'], ['event', 'localSearchBar', 'keyup']]);
    assert.equal(x.els.localSearchBar.value, 'one', 'the filter\'s words back, and the list filtered by them');
    assert.equal(x.els.filelist.scrollTop, 120, 'no jump to the top');
    assert.equal(x.calls.length, 3, 'no spinner, no other redraw');
    // the ring: the file's row, as the explorer wrote its location
    const [dir, file] = x.rows();
    assert.equal(file.el.getAttribute('data-file_location'), '/Music/Daft Punk/One_More_Time.mp3');
    assert.equal(file.li.classes.has('ytdl-new-row'), true);
    assert.equal(dir.li.classes.has('ytdl-new-row'), false);
    assert.equal(x.timers.length, 1);
    assert.equal(x.timers[0].ms, 2000);
  });

  test('the re-list keeps what was typed or scrolled while it listed, not what stood when it asked', async () => {
    let answer;
    const listing = { path: '/Music/Daft Punk/', directories: [], files: [{ type: 'mp3', name: 'One_More_Time.mp3' }] };
    const x = explorerSandbox({ listing: () => new Promise((r) => { answer = r; }) });
    const p = x.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/', filePath: 'Music/Daft Punk/One_More_Time.mp3' });
    x.els.localSearchBar.value = 'one m';
    x.els.filelist.scrollTop = 300;
    answer(listing);
    await p;
    assert.equal(x.els.localSearchBar.value, 'one m', 'typed during the round trip: kept');
    assert.deepEqual(x.calls.filter((c) => c[0] === 'event'), [['event', 'localSearchBar', 'keyup']], 'and the list filtered by it');
    assert.equal(x.els.filelist.scrollTop, 300);
    let again;
    const y = explorerSandbox({ listing: () => new Promise((r) => { again = r; }) });
    y.els.localSearchBar.value = 'one';
    const q = y.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/', filePath: 'Music/Daft Punk/One_More_Time.mp3' });
    y.els.localSearchBar.value = '';
    again(listing);
    await q;
    assert.equal(y.els.localSearchBar.value, '', 'cleared during it: stays cleared');
    assert.ok(!y.calls.some((c) => c[0] === 'event'), 'nothing to type back');
  });

  test('a song added into a new subfolder of the folder on screen rings that folder\'s row', async () => {
    const listing = { path: '/Music/Daft Punk/', directories: [{ name: 'Discovery' }, { name: 'Homework' }], files: [] };
    const x = explorerSandbox({ listing: () => Promise.resolve(listing) });
    x.S.set({ list: [{ type: 'directory', name: 'Homework' }] });
    await x.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/Discovery/', filePath: 'Music/Daft Punk/Discovery/One_More_Time.mp3' });
    const [discovery, homework] = x.rows();
    assert.equal(discovery.li.classes.has('ytdl-new-row'), true);
    assert.equal(homework.li.classes.has('ytdl-new-row'), false);
    assert.ok(!x.calls.some((c) => c[0] === 'event'), 'no filter: nothing to type back');
  });

  test('the ring itself: the row found by its location (with or without the leading slash), ringed, then faded and gone', () => {
    const x = explorerSandbox();
    const a = x.row('.filez', 'data-file_location', '/Music/Daft Punk/Aerodynamic.mp3');
    const b = x.row('.filez', 'data-file_location', '/Music/Daft Punk/One_More_Time.mp3');
    const d = x.row('.dirz', 'data-directory', 'Discovery');
    x.setRows([a, b, d]);
    x.S.ytdlRing({ kind: 'file', value: 'Music/Daft Punk/One_More_Time.mp3' });
    assert.equal(b.li.classes.has('ytdl-new-row'), true);
    assert.equal(a.li.classes.has('ytdl-new-row'), false);
    assert.equal(x.timers[0].ms, 2000);
    x.timers[0].fn();
    assert.equal(b.li.classes.has('is-fading'), true);
    x.timers[1].fn();
    assert.equal(b.li.classes.has('ytdl-new-row'), false);
    assert.equal(b.li.classes.has('is-fading'), false);
    x.S.ytdlRing({ kind: 'dir', value: 'Discovery' });
    assert.equal(d.li.classes.has('ytdl-new-row'), true);
    const before = x.timers.length;
    x.S.ytdlRing({ kind: 'file', value: 'Music/Daft Punk/Gone.mp3' });
    x.S.ytdlRing(null);
    assert.equal(x.timers.length, before, 'no row (filtered out, gone): nothing');
  });

  test('the re-list gives up for another folder, panel or server meanwhile; a failed or unrelated job rings nothing', async () => {
    let answer;
    const x = explorerSandbox({ listing: () => new Promise((r) => { answer = r; }) });
    const p = x.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/', filePath: 'Music/Daft Punk/One_More_Time.mp3' });
    x.S.set({ gen: 1 });
    answer({ path: '/Music/Daft Punk/', directories: [], files: [{ type: 'mp3', name: 'One_More_Time.mp3' }] });
    await p;
    assert.deepEqual(x.calls.map((c) => c[0]), ['dirparser'], 'another server since: nothing redrawn');
    const y = explorerSandbox();
    await y.S.ytdlSettled({ state: 'added', directory: '/Music/Homework/' });
    assert.equal(y.calls.length, 0, 'another folder: no listing asked');
    const z = explorerSandbox({ listing: () => Promise.resolve({ path: '/Music/Daft Punk/', directories: [], files: [] }) });
    await z.S.ytdlSettled({ state: 'failed', directory: '/Music/Daft Punk/' });
    assert.deepEqual(z.calls.map((c) => c[0]), ['dirparser', 'printdir'], 'a failure lists again (a folder may have been made) but rings nothing');
    assert.equal(z.timers.length, 0);
    const off = explorerSandbox({ explorer: false });
    await off.S.ytdlSettled({ state: 'added', directory: '/Music/Daft Punk/' });
    assert.equal(off.calls.length, 0, 'off the explorer');
  });

  test('the toasts: the house iziToast at the top, the words escaped; a failure\'s Details opens the panel at Needs a look', () => {
    const x = explorerSandbox();
    x.S.ytdlToast({ state: 'added', title: 'One <b>More</b> Time', crumbs: ['Music', 'Daft Punk'], directory: '/Music/Daft Punk/' });
    const [kind, ok] = x.calls.pop();
    assert.equal(kind, 'toast.success');
    assert.equal(ok.position, 'topCenter');
    assert.match(ok.title, /^Added “One &lt;b&gt;More&lt;\/b&gt; Time” to /);
    x.S.ytdlToast({ state: 'failed', title: 'Around the World' });
    const [wk, warn] = x.calls.pop();
    assert.equal(wk, 'toast.warning');
    assert.equal(warn.title, 'Couldn\'t add “Around the World”');
    assert.equal(warn.position, 'topCenter');
    const [[html, press]] = warn.buttons;
    assert.equal(html, '<button>Details</button>');
    const hidden = [];
    press({ hide: (...a) => hidden.push(a) }, 'toastEl');
    assert.equal(hidden.length, 1);
    assert.deepEqual(x.calls.slice(-3), [['changeView', 'nav-ytdl'], ['ytdlPanel', { needsLook: true }], ['toggleThing', 'tab', true]], 'on a phone the column comes forward');
    x.calls.length = 0;
    x.S.ytdlToast({ state: 'adding', title: 'x' });
    assert.equal(x.calls.length, 0, 'nothing for an open job');
  });

  test('a paste outside a field: the window over the folder on screen, the panel elsewhere; left alone in a field, under another window or a modal', () => {
    const paste = (text, target = { tagName: 'BODY', closest: () => null }) => ({ target, clipboardData: { getData: (type) => (type === 'text/plain' ? text : '') } });
    const x = explorerSandbox();
    x.S.ytdlOnPaste(paste(LINK));
    assert.deepEqual(x.calls.pop(), ['openHere', '/Music/Daft Punk/', LINK, 'ytdl_btn']);
    x.S.ytdlOnPaste(paste(LINK, { tagName: 'INPUT', closest: () => null }));
    x.S.ytdlOnPaste(paste('just words'));
    assert.equal(x.calls.length, 0);
    const off = explorerSandbox({ explorer: false });
    off.S.set({ state: [{ state: 'allAlbums' }] });
    off.S.ytdlOnPaste(paste(LINK));
    assert.deepEqual(off.calls, [['changeView', 'nav-ytdl'], ['ytdlPanel', { link: LINK }], ['toggleThing', 'tab', true]]);
    const modal = explorerSandbox({ modal: true });
    modal.S.ytdlOnPaste(paste(LINK));
    assert.equal(modal.calls.length, 0, 'a hystmodal is open');
    const qc = explorerSandbox({ active: '.hystmodal--active' });
    qc.S.ytdlOnPaste(paste(LINK));
    assert.equal(qc.calls.length, 0, 'another HystModal open (Quick Connect\'s own instance): its class says so');
    const discover = explorerSandbox({ shades: [{ closest: () => null }] });
    discover.S.ytdlOnPaste(paste(LINK));
    assert.equal(discover.calls.length, 0, 'the Discover window is open');
    const own = explorerSandbox({ shades: [{ closest: (s) => (s === '#ytdl-windows' ? {} : null) }], win: { mode: 'here', folder: '/Music/Homework/' } });
    own.S.ytdlOnPaste(paste(LINK));
    assert.deepEqual(own.calls.pop(), ['openHere', '/Music/Homework/', LINK, 'ytdl_btn'], 'the YouTube window up: the link goes into it');
    const peer = explorerSandbox();
    peer.S.set({ peer: { id: 2, name: 'Bob' } });
    peer.S.ytdlOnPaste(paste(LINK));
    assert.equal(peer.calls.length, 0, 'a connected server');
    assert.match(M_SRC, /\ndocument\.addEventListener\('paste', ytdlOnPaste\);\n/, 'listened to at load, on the document');
  });

  test('setBrowserRootPanel hides the button and the strip; senddir\'s write gate shows the button by the gate and draws the strip', () => {
    const root = findFn('setBrowserRootPanel');
    assert.match(root, /\n {2}document\.getElementById\('ytdl_btn'\)\?\.classList\.add\('super-hide'\);\n {2}document\.getElementById\('ytdl_strip'\)\?\.classList\.add\('super-hide'\);\n/);
    const send = findFn('senddir');
    const gate = send.slice(send.indexOf('if (fileExplorerArray.length > 0 && !peerContext) {'), send.indexOf('printdir(response);'));
    const [shown, hidden] = gate.split('\n    } else {');
    assert.match(shown, /document\.getElementById\('ytdl_btn'\)\?\.classList\.toggle\('super-hide', !\(typeof ytdlAllowed === 'function' && ytdlAllowed\(\)\)\);/);
    assert.match(hidden, /document\.getElementById\('ytdl_btn'\)\?\.classList\.add\('super-hide'\);/, 'at the root and on a connected server');
    assert.match(send, /printdir\(response\);\n\s*\/\/[^\n]*\n\s*if \(typeof ytdlRefreshExplorer === 'function'\) \{ ytdlRefreshExplorer\(\); \}/);
    assert.match(findFn('ytdlApplyGates'), /\n {2}ytdlRefreshExplorer\(\);\n\}$/, 'the ping answering last shows it too');
    assert.match(findFn('openFileExplorerAt'), /\n {2}return senddir\(\);\n\}$/, 'Show in folder waits for the listing, then rings the row');
  });
});

describe('the explorer\'s wiring', () => {
  test('index.html: the button right after Upload, before Add All To Queue — a real, labelled button, hidden until a folder allows it', () => {
    const up = HTML.indexOf('<svg id="upload_btn"');
    const at = HTML.indexOf('id="ytdl_btn"');
    const all = HTML.indexOf('onclick="addAll();"');
    assert.ok(up > 0 && at > up && all > at);
    const btn = HTML.match(/<button type="button" id="ytdl_btn" class="([^"]*)"([^>]*)>([\s\S]*?)<\/button>/);
    assert.ok(btn, 'a <button>, so the keyboard reaches it');
    assert.deepEqual(btn[1].split(' ').sort(), ['super-hide', 'ytdl-bar-btn']);
    assert.match(btn[2], /aria-label="Add from YouTube here" data-i18n="tooltip\.addFromYoutubeHere" data-i18n-attr="aria-label"/);
    assert.match(btn[2], /onclick="ytdlOpenWindow\(\);"/);
    assert.match(btn[3], /<title data-i18n="tooltip\.addFromYoutubeHere">Add from YouTube here<\/title>/, 'the tooltip');
    assert.ok(btn[3].includes('d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM9.5 16.5v-9l7 4.5-7 4.5z"'), 'the board\'s glyph');
    assert.equal(EN['tooltip.addFromYoutubeHere'], 'Add from YouTube here');
  });

  test('index.html: the strip in the old strip\'s slot — under the bar and the upload line, above the scroller; a status, teal, "See all" a button', () => {
    const bar = HTML.indexOf('<div id="directory_bar"');
    const line = HTML.indexOf('<div class="upload-progress-bar">');
    const at = HTML.indexOf('<div id="ytdl_strip"');
    const head = HTML.indexOf('<div id="browse-head"');
    const list = HTML.indexOf('<div id="filelist">');
    assert.ok(bar > 0 && line > bar && at > line && head > at && list > head);
    // Right after the upload line, where the old strip was: only its own
    // comment between them.
    const lineEnd = HTML.indexOf('</div>\n        </div>\n', line) + '</div>\n        </div>\n'.length;
    assert.match(HTML.slice(lineEnd, at), /^ {8}<!--[\s\S]*?-->\n {8}$/);
    const strip = HTML.slice(at, HTML.indexOf('</div>', at));
    assert.match(strip, /^<div id="ytdl_strip" class="ytdl-strip super-hide" role="status">/);
    assert.match(strip, /<span class="ytdl-strip-text"><\/span>/);
    assert.match(strip, /<span class="ytdl-strip-dot" aria-hidden="true">·<\/span>/);
    assert.match(strip, /<button type="button" class="ytdl-strip-all" data-i18n="ytdl\.strip\.seeAll" onclick="ytdlOpenPanel\(\);">See all<\/button>/);
  });

  test('spa.css: the bar button in its neighbours\' look, the strip teal with no box, the ring 2 px teal over the row', () => {
    const block = CSS.slice(CSS.indexOf('/* ── Add from YouTube'), CSS.indexOf('/* ── The Discover page'));
    assert.match(block, /#directory_bar > \.ytdl-bar-btn svg path \{ fill: #fff; transition: fill \.15s; \}/);
    assert.match(block, /#directory_bar > \.ytdl-bar-btn:hover svg path \{ fill: #999; \}/);
    assert.match(block, /#directory_bar > \.ytdl-bar-btn:focus-visible \{ outline: 2px solid #fa832b;/, 'the page\'s orange ring');
    const strip = block.match(/\n\.ytdl-strip \{([^}]*)\}/);
    assert.ok(strip);
    assert.match(strip[1], /min-height: 36px; padding: 0 14px 0 12px;/);
    assert.match(strip[1], /color: #4fb8a8;/);
    assert.ok(!/border-left|background/.test(strip[1]), 'no left-border box, no fill');
    assert.match(block, /#filelist \.collection-item\.ytdl-new-row::after \{\n {2}content: ''; position: absolute; inset: 0; z-index: 2; box-shadow: inset 0 0 0 2px #4fb8a8; pointer-events: none;/);
    assert.match(block, /#filelist \.collection-item\.ytdl-new-row\.is-fading::after \{ opacity: 0; \}/);
    assert.match(block, /\.dmodal-shadow \.dmodal\.ytw \.yth-input:focus-visible \{ outline: none; \}/, 'the link field shows the teal border only');
  });

  test('vp.js: the player\'s hotkeys skip the bar button and the strip (Space presses them)', () => {
    const a = VP_SRC.indexOf('\n  function hotkeysSkip(');
    const skip = new Function(`${VP_SRC.slice(a, VP_SRC.indexOf('\n  }\n', a) + 4)}\nreturn hotkeysSkip;`)();
    const target = (inside) => ({ tagName: 'BUTTON', isContentEditable: false, closest: (sel) => (sel.split(/,\s*/).includes(inside) ? {} : null) });
    assert.equal(skip(target('.ytdl-bar-btn')), true);
    assert.equal(skip(target('.ytdl-strip')), true);
  });

  test('the explorer window\'s words: the boards\', never "Download"', () => {
    assert.equal(EN['ytdl.into'], 'Into');
    assert.equal(EN['ytdl.sort.open'], 'Sort into subfolders…');
    assert.equal(EN['ytdl.sort.here'], 'Right here');
    assert.equal(EN['ytdl.addHere'], 'Add here');
    assert.equal(EN['ytdl.strip.adding'], 'Adding “{{title}}”…');
    assert.equal(EN['ytdl.strip.seeAll'], 'See all');
    assert.equal(EN['ytdl.toast.details'], 'Details');
    assert.deepEqual(Object.keys(EN['ytdl.strip.addingCount']).sort(), ['one', 'other']);
    for (const k of ['ytdl.into', 'ytdl.sort.open', 'ytdl.sort.customField', 'ytdl.strip.adding', 'ytdl.toast.details', 'tooltip.addFromYoutubeHere']) {
      assert.ok(!/download/i.test(EN[k]), k);
    }
    for (const f of Object.values(EN['ytdl.strip.addingCount'])) { assert.ok(!/download/i.test(f) && f.includes('{{count}}'), f); }
  });

  test('the window is a .dmodal over the page, its title the dialog\'s name; its fields are the house browser-default inputs', () => {
    const here = UI_SRC.slice(UI_SRC.indexOf("Vue.component('yt-here'"), UI_SRC.indexOf('  function ensureWindows'));
    assert.match(here, /<h2 id="ytw-title" class="dmodal-title">\{\{ tt\('panel\.addFromYoutube'\) \}\}<\/h2>/);
    const inputs = [...here.matchAll(/<input [^>]*>/g)].map((m) => m[0]);
    assert.ok(inputs.length >= 6);
    for (const i of inputs.filter((x) => !x.includes('type="radio"'))) { assert.match(i, /browser-default/, i); }
    assert.match(UI_SRC, /<yt-here v-else-if="store\.win\.mode === 'here' && draft" ref="here" :key="'h' \+ store\.win\.n" :d="draft"><\/yt-here>/);
  });
});

describe('what Add from YouTube retired', () => {
  const UPLOAD_MODAL = HTML.slice(HTML.indexOf('<div class="hystmodal" id="uploadModal"'), HTML.indexOf('<!-- Create Folder Modal -->'));

  test('index.html: the Upload window keeps Upload Files and Torrent; the Youtube DL tab, its form and the old strip with its /downloads link are gone', () => {
    assert.ok(UPLOAD_MODAL.length > 0);
    const tabs = [...UPLOAD_MODAL.matchAll(/<button id="(tab_\w+)" onclick="switchUploadTab\('(\w+)'\)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(tabs, [['tab_upload', 'upload'], ['tab_torrent', 'torrent']]);
    assert.deepEqual([...UPLOAD_MODAL.matchAll(/id="(tab_content_\w+)"/g)].map((m) => m[1]), ['tab_content_upload', 'tab_content_torrent']);
    for (const gone of ['tab_ytdl', 'ytdl_url', 'ytdl_codec', 'ytdl_metadata', 'ytdl_meta_', 'ytdl_submit', 'ytdl_transcode_warning', 'submitYtdl',
      'ytdl_download_indicator', 'ytdl_download_text', 'href="/downloads"', 'Youtube DL']) {
      assert.ok(!HTML.includes(gone), gone);
    }
  });

  test('m.js: the tab\'s code and the old poller went with the markup — every element it reaches at load is in index.html', () => {
    for (const gone of ['submitYtdl', 'isYoutubeUrl', 'ytdlMetaTimeout', 'startYtdlPolling', 'updateYtdlIndicator', 'ytdlPollInterval', 'MSTREAMAPI.ytdlDownloads(',
      "'ytdl_codec'", "'ytdl_url'", "'ytdl_meta_", "'ytdl_submit'", "'ytdl_transcode_warning'", "'ytdl_download_", "'tab_ytdl'", "'tab_content_ytdl'"]) {
      assert.ok(!M_SRC.includes(gone), gone);
    }
    // A listener added at load (column 0, outside any function) on an
    // element index.html lacks throws there, and nothing after it runs —
    // init() and the explorer included.
    const atLoad = [...M_SRC.matchAll(/^document\.getElementById\('([\w-]+)'\)\.addEventListener\(/gm)].map((m) => m[1]);
    assert.ok(atLoad.includes('torrent_directory'), 'the scan finds the torrent tab\'s');
    for (const id of atLoad) { assert.ok(HTML.includes(`id="${id}"`), `index.html has #${id}`); }
    assert.ok(!/ytdl_codec/.test(CSS), 'spa.css: the codec select\'s rule went too');
    assert.ok(!readSrc('webapp/alpha/api.js').includes('mstreamModule.ytdlDownloads'), 'api.js: the poller\'s list helper (the tracker reads the list itself)');
  });

  test('the Upload window\'s code runs on its two tabs, touching only elements the window has', () => {
    const ids = new Set([...UPLOAD_MODAL.matchAll(/ id="([\w-]+)"/g)].map((m) => m[1]));
    const els = new Map();
    const focused = [];
    const el = (id) => {
      if (!els.has(id)) {
        const classes = new Set(id.startsWith('tab_content_') && id !== 'tab_content_upload' ? ['super-hide'] : []);
        els.set(id, {
          id, classes, style: {}, dataset: { autofilled: 'true' }, value: 'x', textContent: 'x', checked: true,
          classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
          focus: () => focused.push(id),
        });
      }
      return els.get(id);
    };
    const doc = { getElementById: (id) => (ids.has(id) ? el(id) : null) };
    const opened = [];
    let preflights = 0;
    const S = new Function('document', 'getFileExplorerPath', 'myModal', 'runTorrentPreflight', `${findFn('switchUploadTab')}\n${findFn('openUploadModal')}\nreturn { switchUploadTab, openUploadModal };`)(
      doc, () => 'Music/Daft Punk/', { open: (s) => opened.push(s) }, () => { preflights++; },
    );
    S.openUploadModal();
    assert.deepEqual(opened, ['#uploadModal']);
    assert.equal(el('upload_filepath').textContent, 'Music/Daft Punk/');
    assert.equal(el('torrent_magnet').value, '');
    assert.equal(el('tab_upload').style.borderBottomColor, '#fff');
    assert.equal(el('tab_torrent').style.borderBottomColor, 'transparent');
    assert.equal(el('tab_content_upload').classes.has('super-hide'), false);
    assert.equal(el('tab_content_torrent').classes.has('super-hide'), true);
    S.switchUploadTab('torrent');
    assert.equal(el('tab_content_upload').classes.has('super-hide'), true);
    assert.equal(el('tab_content_torrent').classes.has('super-hide'), false);
    assert.deepEqual(focused, ['torrent_magnet']);
    assert.equal(preflights, 1);
  });

  test('a failure toast reads the server\'s words (req() puts its answer on err.body), escaped; no answer reads Call Failed', async () => {
    const sliceConst = (name) => { const a = M_SRC.indexOf(`\nconst ${name} = `) + 1; return M_SRC.slice(a, M_SRC.indexOf('\n};\n', a) + 3); };
    const toasts = [];
    const fail = new Function('t', 'iziToast', 'console', `${sliceConst('entityMap')}\n${findFn('escapeHtml')}\n${findFn('boilerplateFailure')}\nreturn boilerplateFailure;`)(
      (k) => `T:${k}`, { error: (o) => toasts.push(o) }, { log() {} },
    );
    // The real req(): a 409 whose body is the server's envelope.
    const answer = (status, body) => () => Promise.resolve({ ok: false, status, json: () => (body === undefined ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(body)) });
    const caught = async (fetchStub) => {
      const api = new Function('fetch', `${readSrc('webapp/alpha/api.js')}\nreturn MSTREAMAPI;`)(fetchStub);
      try { await api.dirparser('Music/'); } catch (err) { return err; }
      throw new Error('req() answered');
    };
    fail(await caught(answer(400, { error: '"directory" is required' })));
    assert.equal(toasts.pop().title, '&quot;directory&quot; is required');
    fail(await caught(answer(403, { error: '<b>Uploads</b> are off' })));
    assert.equal(toasts.pop().title, '&lt;b&gt;Uploads&lt;&#x2F;b&gt; are off', 'iziToast renders HTML: the words are escaped');
    fail(await caught(answer(502)));
    assert.equal(toasts.pop().title, 'T:error.callFailed', 'an answer that is not JSON');
    fail(await caught(() => Promise.reject(new TypeError('Failed to fetch'))));
    assert.equal(toasts.pop().title, 'T:error.callFailed', 'no answer at all');
    for (const err of [undefined, null, { body: { error: '' } }, { body: { error: { code: 1 } } }, { responseJSON: { error: 'jQuery\'s shape, set by nothing' } }]) {
      fail(err);
      assert.equal(toasts.pop().title, 'T:error.callFailed', JSON.stringify(err));
    }
    fail({ body: { error: 'Server Error' } });
    const last = toasts.pop();
    assert.deepEqual([last.title, last.position, last.timeout], ['Server Error', 'topCenter', 3500]);
  });

  test('every boilerplateFailure call passes the error it caught (a playlist that fails to open no longer throws in its catch)', () => {
    const calls = [...M_SRC.matchAll(/boilerplateFailure\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(calls.length > 20);
    assert.deepEqual([...new Set(calls)], ['err']);
    assert.match(findFn('onPlaylistClick'), /\}catch\(err\) \{\n[^\n]*\n {4}boilerplateFailure\(err\);\n {2}\}\n\}$/);
  });
});

// ── the browser half, under a stub Vue and DOM ─────────────────────────
// ytdl-ui.js run again as the page runs it (no module, Vue and document
// globals), with stubs that record: what only runs in a page — start(),
// the remembered choices before the account is known, the windows' keys
// and focus, the strip, the announcer, the focus a redraw took away.
class FakeEl {
  constructor(doc, tag, attrs = {}, kids = []) {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parent = null; this.root = false;
    this.textContent = ''; this.classes = new Set();
    this.classList = { add: (...c) => c.forEach((x) => this.classes.add(x)), remove: (...c) => c.forEach((x) => this.classes.delete(x)), contains: (c) => this.classes.has(c) };
    for (const k of kids) { this.append(k); }
  }
  append(k) { k.parent = this; this.children.push(k); return k; }
  appendChild(k) { return this.append(k); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  get isConnected() { let n = this; while (n.parent) { n = n.parent; } return n.root === true; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  getAttribute(n) { return this.hasAttribute(n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getClientRects() { return this.attrs.hidden === 'true' ? [] : [{}]; }
  matches(sel) {
    const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (m) { return this.hasAttribute(m[1]) && (m[2] === undefined || this.attrs[m[1]] === m[2]); }
    if (sel === 'button') { return this.tagName === 'BUTTON'; }
    if (sel === 'button:not([aria-disabled="true"])') { return this.tagName === 'BUTTON' && this.attrs['aria-disabled'] !== 'true'; }
    if (sel.startsWith('.')) { return (this.attrs.class || '').split(' ').includes(sel.slice(1)); }
    return false;
  }
  closest(sel) { for (let n = this; n; n = n.parent) { if (n.matches(sel)) { return n; } } return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) { out.push(c); } walk(c); }); walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() { this.doc.activeElement = this; this.focused = (this.focused || 0) + 1; }
}

function browserHalf(o = {}) {
  const comps = {};
  const ticks = [];
  const timers = [];
  const listeners = {};
  const saved = new Map();
  const trackers = [];
  const doc = {
    activeElement: null,
    getElementById: (id) => (o.els && o.els[id]) || null,
    querySelector: (sel) => (o.query ? o.query(sel) : null),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    createElement: (tag) => new FakeEl(doc, tag),
  };
  doc.body = new FakeEl(doc, 'body');
  doc.body.root = true;
  doc.documentElement = doc.body.parent;
  const el = (tag, attrs, kids) => new FakeEl(doc, tag, attrs, kids);
  function FakeVue(opts) { this.$options = opts; this.$refs = {}; this.$children = []; this.$el = opts.el; }
  FakeVue.observable = (x) => x;
  FakeVue.component = (name, def) => { comps[name] = def; };
  FakeVue.nextTick = (fn) => { ticks.push(fn); };
  FakeVue.prototype.$destroy = function () { this.destroyed = true; };
  const local = { getItem: (k) => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) };
  const tracker = (opts) => {
    const tr = {
      opts, log: [], jobs: new Map(), under: [],
      attach() { this.log.push(['attach']); }, subscribe(fn) { this.emit = fn; }, stop() { this.log.push(['stop']); },
      watch(on) { this.log.push(['watch', on]); }, loadAdded(x) { this.log.push(['loadAdded', x]); },
      summary: () => ({ kind: null, count: 0 }), get(id) { return this.jobs.get(id) || null; }, busy: () => false,
      add(req) { this.log.push(['add', req.directory]); return Promise.resolve({ ok: true }); }, dismiss(j) { this.log.push(['dismiss', j.id]); },
      jobsUnder() { return this.under; },
    };
    trackers.push(tr);
    return tr;
  };
  const root = { YTDLCORE: Y, YTDLJOBS: { ...J, tabIdOf: () => 'tab-1', createTracker: tracker } };
  const setT = (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; };
  const clearT = (id) => { const x = timers[id - 1]; if (x) { x.gone = true; } };
  const tr = (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k);
  const UI = new Function('Vue', 'document', 'window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 't', 'self', 'module',
    `${UI_SRC}\n;return this.YTDLUI;`).call(root, FakeVue, doc, { addEventListener() {} }, local, { onLine: true }, setT, clearT, () => 1, () => {}, tr, root, undefined);
  const runTimers = () => { for (const x of timers) { if (!x.gone && !x.ran) { x.ran = true; x.fn(); } } };
  const flushTicks = () => { while (ticks.length) { ticks.shift()(); } };
  // a component's definition as `this` (its mixins' methods first)
  const vmOf = (name, extra = {}) => {
    const def = comps[name];
    const vm = Object.assign({}, ...(def.mixins || []).map((m) => m.methods || {}), def.methods || {}, extra);
    for (const m of def.mixins || []) { if (m.created) { m.created.call(vm); } }
    return vm;
  };
  return { UI, comps, doc, el, saved, trackers, timers, runTimers, flushTicks, listeners, vmOf, tr };
}

describe('the browser half (stub Vue and DOM)', () => {
  const alice = { origin: ORIGIN, user: 'alice' };

  test('the panel up before the account was known: start() gives its rows the tracker — watched, Added listed, redrawn', () => {
    const b = browserHalf();
    b.UI.mountPanel({ id: 'ytdl-panel-mount' });
    const tick = b.UI.store.tick;
    b.UI.start(alice);
    const tr = b.trackers[0];
    assert.deepEqual(tr.log.filter((x) => x[0] !== 'attach'), [['watch', true], ['loadAdded', undefined]]);
    assert.ok(b.UI.store.tick > tick, 'the lists read the new tracker');
    const c = browserHalf();
    c.UI.start(alice);
    assert.deepEqual(c.trackers[0].log, [['attach']], 'no panel: nothing to watch for');
  });

  test('a choice saved before the account was known is kept for it, never under an empty scope', () => {
    const b = browserHalf();
    const d = b.UI.panelDraft();
    d.saveChoice({ kind: 'custom', library: 'Mixes', layout: '{{ALBUM}}', base: '' });
    d.setFormat('opus');
    assert.equal(b.saved.size, 0, 'nothing written under "|"');
    b.UI.start(alice);
    assert.deepEqual(U.readPrefs({ getItem: (k) => (b.saved.has(k) ? b.saved.get(k) : null) }, alice), { choice: { library: 'Mixes', layout: '{{ALBUM}}', kind: 'custom' }, format: 'opus' });
    assert.deepEqual(b.UI.store.saved, { library: 'Mixes', layout: '{{ALBUM}}', kind: 'custom' }, 'not overwritten by the empty read');
    assert.equal(b.UI.store.format, 'opus');
    b.UI.start({ origin: ORIGIN, user: 'bob' });
    assert.equal(b.UI.store.saved, null, 'another account reads its own');
    assert.equal(b.UI.store.format, null);
    const c = browserHalf();
    c.saved.set(U.prefKeys(alice).format, 'flac');
    c.UI.start(alice);
    assert.equal(c.UI.store.format, 'flac', 'nothing chosen before: the account\'s own');
  });

  test('Choose a folder… from a Needs a look row: its song added again there — nothing if the row went meanwhile, never the card\'s folder', () => {
    const b = browserHalf();
    b.UI.start(alice);
    const tr = b.trackers[0];
    const job = { id: 'j1', url: URL1, directory: '/Music/Daft Punk/Discovery/', codec: 'mp3', crumbs: ['Music', 'Daft Punk', 'Discovery'] };
    const card = b.UI.panelDraft();
    const pick = () => b.comps['yt-choose'].methods.use.call({ usable: true, crumbs: ['Music', 'Homework'], d: card });
    tr.jobs.set('j1', job);
    b.comps['yt-panel'].methods.rowAct.call({}, { id: 'j1' }, 'chooseFolder');
    assert.equal(b.UI.store.win.mode, 'choose');
    tr.jobs.delete('j1');
    pick();
    assert.equal(card.s.just, null, 'the card keeps its own choice');
    assert.ok(!tr.log.some((x) => x[0] === 'add'));
    assert.equal(b.UI.store.win, null, 'the window closes');
    tr.jobs.set('j1', job);
    b.comps['yt-panel'].methods.rowAct.call({}, { id: 'j1' }, 'chooseFolder');
    pick();
    assert.deepEqual(tr.log.filter((x) => x[0] === 'add' || x[0] === 'dismiss'), [['add', '/Music/Homework/'], ['dismiss', 'j1']]);
    b.UI.openWindow({ mode: 'choose', start: '/Music/' });
    pick();
    assert.equal(card.s.just.kind, 'folder', 'the card\'s own Choose a folder…: the folder for this song');
    assert.equal(card.s.just.base, 'Homework');
  });

  test('closing a window: the keyboard back on its opener while it is on screen, else the column\'s heading', () => {
    const head = new FakeEl(null, 'h5');
    const b = browserHalf({ query: (sel) => (sel === 'h5.panel_one_name' ? head : null) });
    head.doc = b.doc;
    head.parent = b.doc.body;
    const opener = b.el('button', { hidden: 'true' });
    b.doc.body.append(opener);
    opener.focus = () => { opener.got = true; };
    b.UI.openWindow({ mode: 'choose', start: '/Music/' }, opener);
    b.UI.closeWindow();
    b.flushTicks();
    assert.equal(opener.got, undefined, 'a re-ping hid the bar\'s button under the window');
    assert.equal(b.doc.activeElement, head);
    assert.equal(head.getAttribute('tabindex'), '-1');
    delete opener.attrs.hidden;
    b.UI.openWindow({ mode: 'choose', start: '/Music/' }, opener);
    b.UI.closeWindow();
    b.flushTicks();
    assert.equal(opener.got, true);
  });

  test('Esc closes the window — not an IME\'s Esc, which only drops the words it was making', () => {
    const b = browserHalf();
    b.UI.openWindow({ mode: 'choose', start: '/Music/' });
    const key = b.listeners.keydown[0];
    let prevented = 0;
    key({ key: 'Escape', isComposing: true, preventDefault: () => { prevented++; } });
    key({ key: 'Escape', keyCode: 229, preventDefault: () => { prevented++; } });
    assert.equal(b.UI.store.win.mode, 'choose');
    assert.equal(prevented, 0);
    key({ key: 'Escape', preventDefault: () => { prevented++; } });
    assert.equal(b.UI.store.win, null);
    assert.equal(prevented, 1);
  });

  test('Tab out of an open menu closes it from its button, so the browser\'s Tab (and a window\'s trap) start there', () => {
    const b = browserHalf();
    const menu = b.comps['yt-format-menu'].mixins[0].methods;
    const closed = [];
    let prevented = false;
    menu.onMenuKey.call({ items: () => [], closeMenu: (f) => closed.push(f) }, { key: 'Tab', preventDefault: () => { prevented = true; } });
    assert.deepEqual(closed, [true]);
    assert.equal(prevented, false, 'the browser\'s own move');
  });

  test('focus a redraw took away lands on what stands in for it: the row now in its place, the list\'s heading, the control it named', () => {
    const b = browserHalf();
    const { el, doc } = b;
    const btn = (attrs) => el('button', attrs);
    const try1 = btn();
    const row1 = el('li', { 'data-yt-row': '' }, [try1, btn({ class: 'dm-btn-quiet' })]);
    const try2 = btn({ 'aria-disabled': 'true' });
    const try2b = btn();
    const row2 = el('li', { 'data-yt-row': '' }, [try2, try2b]);
    const look = el('ul', { 'data-yt-list': 'look' }, [row1, row2]);
    const head = el('h3', { 'data-yt-head': 'look' });
    const chip = btn({ 'data-yt-row': '', 'data-yt-then': 'title' });
    const chips = el('div', { 'data-yt-list': 'chips' }, [chip]);
    const earlier = btn({ 'data-yt-then': 'earlier' });
    const a1 = el('li', { 'data-yt-row': '' }, [btn()]);
    const added = el('ul', { 'data-yt-list': 'added' }, [a1]);
    const useThem = btn({ 'data-yt-then': 'title' });
    const link = el('input');
    const title = el('input');
    const panel = el('div', {}, [link, useThem, chips, head, look, added, earlier, title]);
    doc.body.append(panel);
    const vm = b.vmOf('yt-panel', { $el: panel, $refs: { link, 'f-title': title } });
    const gone = (x) => { x.remove(); doc.activeElement = doc.body; vm.keepFocus(); };
    vm.noteFocus({ target: try1 });
    gone(row1);
    assert.equal(doc.activeElement, try2b, 'the next row\'s first button that is on');
    vm.noteFocus({ target: try2b });
    gone(row2);
    assert.equal(doc.activeElement, head, 'the last row gone: its list\'s heading');
    vm.noteFocus({ target: chip });
    gone(chips);
    assert.equal(doc.activeElement, title, 'the chips gone: the Title field');
    vm.noteFocus({ target: useThem });
    gone(useThem);
    assert.equal(doc.activeElement, title);
    vm.noteFocus({ target: earlier });
    const a2 = el('li', { 'data-yt-row': '' }, [btn()]);
    added.append(a2);
    gone(earlier);
    assert.equal(doc.activeElement, a2.children[0], 'Show earlier: the first row it brought');
    // a real blur, or focus moved on purpose: left alone
    vm.noteFocus({ target: link });
    doc.activeElement = doc.body;
    vm.dropFocus({ target: link });
    b.runTimers();
    assert.equal(vm.ytFocus, null);
    const other = el('button');
    doc.body.append(other);
    vm.noteFocus({ target: title });
    title.remove();
    other.focus();
    vm.keepFocus();
    assert.equal(doc.activeElement, other);
    // Enter: Add, never an IME's Enter
    let adds = 0;
    vm.add = () => { adds++; };
    vm.onEnter({ isComposing: true, preventDefault() {} });
    vm.onEnter({ keyCode: 229, preventDefault() {} });
    assert.equal(adds, 0);
    let prevented = false;
    vm.onEnter({ keyCode: 13, preventDefault: () => { prevented = true; } });
    assert.equal(adds, 1);
    assert.equal(prevented, true);
    for (const name of ["Vue.component('yt-panel'", "Vue.component('yt-here'"]) {
      const at = UI_SRC.indexOf(name);
      const tpl = UI_SRC.slice(at, UI_SRC.indexOf('Vue.component(', at + 10));
      assert.match(tpl, /mixins: \[focusKeep\]/, name);
      assert.match(tpl, /updated: function \(\) \{ this\.syncFields\(\); this\.keepFocus\(\); \}/, name);
      assert.equal((tpl.match(/@keydown\.enter="onEnter"/g) || []).length, 5, `${name}: the link and the four tag fields`);
      assert.match(tpl, /:aria-invalid="m\.block === 'yearInvalid' \? 'true' : null"/, name);
      for (const then of ['link', 'title']) { assert.ok(tpl.includes(`data-yt-then="${then}"`), `${name} ${then}`); }
      assert.match(tpl, /data-yt-then="add"[^>]*saveToDeepest/, `${name}: Save to … instead hands it to Add`);
    }
  });

  test('the strip shows first, then takes its words — a region shown with its words in it is often never read', () => {
    const words = new FakeEl(null, 'span');
    const strip = new FakeEl(null, 'div');
    strip.classes.add('super-hide');
    strip.querySelector = (sel) => (sel === '.ytdl-strip-text' ? words : null);
    const b = browserHalf({ els: { ytdl_strip: strip } });
    b.UI.start(alice);
    const tr = b.trackers[0];
    tr.under = [{ state: 'adding', title: 'One More Time' }];
    b.UI.renderStrip('/Music/');
    assert.equal(strip.classes.has('super-hide'), false);
    assert.equal(words.textContent, '', 'shown empty');
    b.UI.renderStrip('/Music/');
    b.runTimers();
    assert.equal(words.textContent, b.tr('ytdl.strip.adding', { title: 'One More Time' }), 'its words a moment later, once');
    tr.under = [{ state: 'adding', title: 'a' }, { state: 'starting', title: 'b' }];
    b.UI.renderStrip('/Music/');
    assert.equal(words.textContent, b.tr('ytdl.strip.addingCount', { count: 2 }), 'up already: at once');
    tr.under = [];
    b.UI.renderStrip('/Music/');
    assert.equal(strip.classes.has('super-hide'), true);
    assert.equal(words.textContent, '');
  });

  test('an add\'s result is said in the page\'s own status region (iziToast has none), the same words twice read twice', () => {
    const region = new FakeEl(null, 'div');
    region.textContent = 'Added “x”';
    const b = browserHalf({ els: { 'ytdl-announce': region } });
    b.UI.announce('Added “x”');
    assert.equal(region.textContent, '');
    b.runTimers();
    assert.equal(region.textContent, 'Added “x”');
    assert.match(HTML, /\n {2}<div id="ytdl-windows"><\/div>\n {2}<div id="ytdl-announce" class="dm-sr" role="status" aria-live="polite"><\/div>\n/, 'outside #filelist: it outlives the panel');
    assert.match(findFn('ytdlToast'), /const words = t\(v\.label\.key, v\.label\.params\);\n\s*const title = escapeHtml\(words\);\n[^\n]*\n\s*if \(typeof YTDLUI\.announce === 'function'\) \{ YTDLUI\.announce\(words\); \}/, 'the words unescaped, as text');
  });

  test('Custom takes the keyboard only when a pointer chose it: arrowed onto, the arrows go on through the radios', () => {
    const b = browserHalf();
    const focused = [];
    const custom = { focus: () => focused.push('custom') };
    const where = { form: { kind: 'artistAlbum', library: 'Music', custom: '' }, pointer: false, $refs: { custom }, $nextTick: (fn) => fn() };
    b.comps['yt-where'].methods.pickLayout.call(where, 'custom');
    assert.deepEqual(focused, [], 'an arrow key\'s change');
    assert.equal(where.form.kind, 'custom');
    where.pointer = true;
    b.comps['yt-where'].methods.pickLayout.call(where, 'custom');
    assert.deepEqual(focused, ['custom']);
    assert.equal(where.pointer, false);
    const here = { pointer: false, d: { setSub: () => {} }, $refs: { custom }, $nextTick: (fn) => fn() };
    b.comps['yt-here'].methods.pickSub.call(here, 'custom');
    assert.deepEqual(focused, ['custom']);
    here.pointer = true;
    b.comps['yt-here'].methods.pickSub.call(here, 'custom');
    assert.deepEqual(focused, ['custom', 'custom']);
    assert.equal((UI_SRC.match(/class="ytw-opt" :class="\{ 'is-on': [^}]*\}" @pointerdown="pointer = true">/g) || []).length, 2);
  });
});

describe('the strings', () => {
  test('every key the three modules use is in en.json; nothing under ytdl.* is unused', () => {
    const literal = [...new Set([...UI_SRC.matchAll(/'((?:ytdl|nav|panel)\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]))];
    const all = new Set([...Y.KEYS, ...J.KEYS, ...U.KEYS, ...literal]);
    for (const k of all) { assert.ok(k in EN, `en.json lacks ${k}`); }
    for (const k of literal) { assert.ok(U.KEYS.includes(k) || Y.KEYS.includes(k) || J.KEYS.includes(k), `${k} is used but not in a KEYS list`); }
    const unused = Object.keys(EN).filter((k) => k.startsWith('ytdl.') && !all.has(k));
    assert.deepEqual(unused, []);
  });

  test('the boards\' words', () => {
    assert.equal(EN['nav.addFromYoutube'], 'Add from YouTube');
    assert.equal(EN['ytdl.add'], 'Add to library');
    assert.equal(EN['ytdl.addAnyway'], 'Add anyway');
    assert.equal(EN['ytdl.clash'], 'Something like “{{name}}” looks to be in this folder already. If it is, the server won\'t add it.');
    assert.equal(EN['ytdl.err.exists'], '“{{name}}” is already in this folder, so nothing was added.');
    assert.equal(EN['ytdl.where.kept'], 'Kept in this browser');
    assert.equal(EN['ytdl.choose.empty'], 'No folders here.');
    // no words from the server (it always sends some): plain — the phone's
    // older-server hedge, with the limits decision 14 cut, has no web twin
    assert.equal(EN['ytdl.row.failedServer'], 'Failed · something went wrong on the server.');
    assert.ok(!('ytdl.row.failedUnknown' in EN));
    // Where new songs land before a title is known (a lookup that failed,
    // the fields open): the phone's sample line, never "“” lands at"
    assert.equal(EN['ytdl.where.landsAtSample'], 'A song lands at');
    assert.match(UI_SRC, /\{\{ title \? tt\('ytdl\.where\.landsAt', \{ title \}\) : tt\('ytdl\.where\.landsAtSample'\) \}\}/);
    // The verbs, the headings and the entry: "Add …", never "Download"
    // ("Download" already means save-to-this-computer in the webapp).
    const verbs = ['nav.addFromYoutube', 'panel.addFromYoutube', 'ytdl.add', 'ytdl.addHere', 'ytdl.addAnyway', 'ytdl.adding', 'ytdl.list.adding', 'ytdl.list.added',
      'ytdl.row.addAgain', 'ytdl.row.changeFormatRetry', 'ytdl.err.noRoute', 'ytdl.toast.added', 'ytdl.toast.couldntAdd', ...Object.values(U.ACTION_KEYS)];
    for (const k of verbs) { assert.ok(!/download/i.test(EN[k]), `never "Download": ${k} ${EN[k]}`); }
  });

  test('the pill\'s words are plurals with {{count}} in every form', () => {
    for (const k of ['ytdl.pill.adding', 'ytdl.pill.needsLook', 'ytdl.pill.added']) {
      assert.deepEqual(Object.keys(EN[k]).sort(), ['one', 'other']);
      for (const f of Object.values(EN[k])) { assert.ok(f.includes('{{count}}'), `${k}: ${f}`); }
    }
  });

  test('every label the draft returned has a param for each of its placeholders', () => {
    assert.ok(EMITTED.length > 50, 'the draft tests ran first');
    for (const l of EMITTED) {
      const v = EN[l.key];
      assert.ok(v !== undefined, l.key);
      const forms = typeof v === 'string' ? [v] : Object.values(v);
      for (const f of forms) {
        for (const m of f.matchAll(/\{\{(\w+)\}\}/g)) {
          assert.ok(l.params && Object.prototype.hasOwnProperty.call(l.params, m[1]), `${l.key} needs {{${m[1]}}}`);
        }
      }
    }
  });
});
