/**
 * webapp/alpha/ytdl-jobs.js — Add from YouTube's job tracker, on node. A
 * "tab" is a tracker over one Map-backed localStorage that fans the
 * `storage` event to the other tabs (as a browser does: never to the
 * writer), with one fake clock and one fake server speaking the contract of
 * src/api/ytdl.js, src/api/ytdl-jobs.js and src/api/discovery-downloads.js
 * (POST answers { id, fileName }, the list is the caller's own with
 * status / error / reason / filePath / downloadId, records filtered by
 * plugin and paged by `before`).
 *
 * What is pinned:
 * - storage: one list per server origin + account; storage that throws, or
 *   holds garbage, reads as empty and never throws; a state this build
 *   doesn't know loads as "not sure"; retention (20 per key, open jobs
 *   always, Needs a look 7 days);
 * - the add: the folder first when asked (once; an unreadable 2xx carries
 *   on), the POST once with ytdl-core's body; 200 → adding by the server's
 *   id; a 409 and every other refusal resolve with ytdl-core's problem and
 *   leave no row (unless `inline` says the surface has gone); no answer,
 *   the 30 s bound and a 504 → startUnsure, never re-POSTed;
 * - claim and settle: by id; startUnsure by link + folder, no earlier than
 *   5 s before the press, never an entry another job (or a dismissed row)
 *   holds, never while another add of the same link is still sending; 2 min
 *   then Not sure it started; complete → added, error → failed with the
 *   reason and words; gone → the record says added, else Not found (Not
 *   sure it finished past the server's day); a reload mid-POST; Check
 *   again; retry; dismiss;
 * - one poller: one visible tab reads, the others follow its writes; a
 *   hidden tab never reads; a dead or hidden leader is replaced; visible
 *   and online read once; backoff to a minute;
 * - the toast only in the tab that pressed Add, once; 'settled' in every tab;
 * - the pill's summary in the phone's order, markSeen, the hour running
 *   out; Already adding across tabs; the explorer strip's jobs;
 * - Added: the record (plugin=ytdl, paged) merged with this browser's
 *   jobs by record id;
 * - rows and toasts as labels; every key in KEYS is emitted here, every key
 *   emitted is in KEYS or ytdl-core's;
 * - fetchRequest throws as alpha/api.js req() does, which ytdl-core reads.
 *
 * webapp/ has no browser test harness and is eslint-ignored, so the module
 * is loaded as the CommonJS it is (createRequire), the way
 * webapp-ytdl-core.test.mjs loads ytdl-core.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const J = require('../../webapp/alpha/ytdl-jobs.js');
const Y = require('../../webapp/alpha/ytdl-core.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp/locales/en.json'), 'utf8'));

const T0 = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ORIGIN = 'http://music.local:3000';
const URL1 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const URL2 = 'https://www.youtube.com/watch?v=FGBhQbmPwH8';
const URL3 = 'https://www.youtube.com/watch?v=GwWwBYk8aE0';
const DIR = '/Music/Daft Punk/Discovery/';
const KEY = J.storageKeys({ origin: ORIGIN, user: 'alice' });

// Every label a row or a toast returned in this file (the KEYS check).
const EMITTED = new Set();
function note(l) { if (l && l.key) { EMITTED.add(l.key); } return l; }
const row = (job, ctx) => { const r = J.jobRow(job, ctx); if (r) { note(r.status); } return r; };
const toast = (job) => note(J.toastLabel(job));

// Lets promise chains and queued storage events run.
const settle = async (n = 40) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

function fakeClock(t0 = T0) {
  let t = t0;
  let seq = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { q.delete(id); },
    // Runs every timer due by now + ms, in order, letting each one's
    // promises settle before the next.
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const [id, x] of q) {
          if (x.at <= end && (!next || x.at < next.x.at || (x.at === next.x.at && id < next.id))) { next = { id, x }; }
        }
        if (!next) { break; }
        q.delete(next.id);
        t = next.x.at;
        next.x.fn();
      }
      t = end;
      await settle();
    },
    // The wall clock jumps (a manual change, an NTP step); a browser's
    // timers count elapsed time, so the ones out stay as far off as they were.
    jump(ms) {
      t += ms;
      for (const x of q.values()) { x.at += ms; }
    },
  };
}

function fakeBrowser() {
  const data = new Map();
  const wins = new Set();
  function target() {
    const ls = new Map();
    return {
      addEventListener(type, fn) { if (!ls.has(type)) { ls.set(type, new Set()); } ls.get(type).add(fn); },
      removeEventListener(type, fn) { if (ls.has(type)) { ls.get(type).delete(fn); } },
      dispatch(type, ev = {}) { for (const fn of [...(ls.get(type) || [])]) { fn(ev); } },
      count(type) { return ls.has(type) ? ls.get(type).size : 0; },
    };
  }
  function storageFor(win) {
    return {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => {
        const old = data.has(k) ? data.get(k) : null;
        const val = String(v);
        data.set(k, val);
        if (old === val) { return; }
        for (const w of wins) { if (w !== win) { setImmediate(() => w.dispatch('storage', { key: k, oldValue: old, newValue: val })); } }
      },
      removeItem: (k) => { data.delete(k); },
    };
  }
  return { data, wins, target, storageFor };
}

// What api.js req() throws.
const httpError = (status, body) => Object.assign(new Error(`failed: ${status}`), { status, body });
const netError = () => new TypeError('Failed to fetch');
const hang = (opts) => new Promise((_, reject) => {
  if (opts && opts.signal) { opts.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))); }
});
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fakeServer(clock) {
  const s = { jobs: [], records: [], calls: [], seq: 0, recordSeq: 56, skew: 0, onPost: null, onList: null, onMkdir: null, onRecords: null };
  const bareDir = (d) => d.replace(/^\/+|\/+$/g, '');
  s.start = (body, over = {}) => {
    const job = {
      id: `srv-${++s.seq}`, pid: 4000 + s.seq, url: body.url, directory: body.directory, outputCodec: body.outputCodec || 'mp3',
      status: 'downloading', startTime: clock.now() + s.skew, endTime: null, fileName: 'One_More_Time.mp3', filePath: null,
      downloadId: null, error: null, reason: null, ...over,
    };
    s.jobs.unshift(job);
    return job;
  };
  s.job = (id) => s.jobs.find((j) => j.id === id);
  s.record = (over = {}) => {
    const id = ++s.recordSeq;
    const filepath = over.filepath || `Music/Daft Punk/Discovery/Song_${id}.mp3`;
    const r = {
      id, plugin: 'ytdl', userId: 3, jobId: null, vpath: filepath.split('/')[0], filepath, relativePath: filepath.split('/').slice(1).join('/'),
      fileHash: null, origin: URL3, title: `Song ${id}`, artist: 'Daft Punk', album: 'Discovery', bytes: 8808038,
      downloadedAt: clock.now() + s.skew, removedAt: null, removedBy: null, present: true, trackId: 1000 + id, ...over,
    };
    s.records.unshift(r);
    return r;
  };
  s.complete = (id, over = {}) => {
    const j = s.job(id);
    const fileName = over.fileName || j.fileName;
    const filePath = `${bareDir(j.directory)}/${fileName}`;
    const rec = s.record({ origin: j.url, filepath: filePath, title: 'One More Time' });
    Object.assign(j, { status: 'complete', endTime: clock.now() + s.skew, fileName, filePath, downloadId: rec.id, ...over });
    return rec;
  };
  s.fail = (id, reason, error) => Object.assign(s.job(id), { status: 'error', endTime: clock.now() + s.skew, reason, error });
  s.restart = () => { s.jobs = []; };
  s.requestFor = (tab) => async (method, p, body, opts) => {
    s.calls.push({ tab, method, path: p, body, at: clock.now() });
    await null;
    if (method === 'POST' && p === 'api/v1/ytdl/') {
      if (s.onPost) { return s.onPost(body, opts); }
      const j = s.start(body);
      return { message: 'Download started', id: j.id, fileName: j.fileName };
    }
    if (method === 'GET' && p === 'api/v1/ytdl/downloads') {
      if (s.onList) { return s.onList(opts); }
      return { downloads: s.jobs.map((j) => ({ ...j })) };
    }
    if (method === 'POST' && p === 'api/v1/file-explorer/mkdir') {
      if (s.onMkdir) { return s.onMkdir(body, opts); }
      return {};
    }
    if (method === 'GET' && p.startsWith('api/v1/discovery/downloads?')) {
      if (s.onRecords) { return s.onRecords(p, opts); }
      const q = new URLSearchParams(p.split('?')[1]);
      const limit = Number(q.get('limit') || 100);
      const before = q.has('before') ? Number(q.get('before')) : null;
      const rows = s.records
        .filter((r) => (!q.get('plugin') || r.plugin === q.get('plugin')) && r.removedAt == null && (before == null || r.id < before))
        .sort((a, b) => b.downloadedAt - a.downloadedAt || b.id - a.id);
      return { downloads: rows.slice(0, limit).map((r) => ({ ...r })) };
    }
    throw httpError(404, null);
  };
  const count = (method, p, tab) => s.calls.filter((c) => c.method === method && c.path === p && (tab == null || c.tab === tab)).length;
  s.lists = (tab) => count('GET', 'api/v1/ytdl/downloads', tab);
  s.posts = (tab) => count('POST', 'api/v1/ytdl/', tab);
  s.mkdirs = () => s.calls.filter((c) => c.path === 'api/v1/file-explorer/mkdir');
  s.recordReads = () => s.calls.filter((c) => c.path.startsWith('api/v1/discovery/downloads'));
  return s;
}

// One browser: tabs over its storage, one clock, one server.
function world() {
  const clock = fakeClock();
  const browser = fakeBrowser();
  const server = fakeServer(clock);
  const tabs = [];
  function tab(name, opts = {}) {
    const win = browser.target();
    const doc = browser.target();
    browser.wins.add(win);
    const st = { visible: opts.visible !== false, online: opts.online !== false, dead: false };
    const toasts = [];
    const events = [];
    const base = opts.request || server.requestFor(name);
    const tracker = J.createTracker({
      scope: { origin: opts.origin || ORIGIN, user: opts.user || 'alice' },
      storage: 'storage' in opts ? opts.storage : browser.storageFor(win),
      now: clock.now,
      // A tab that crashed runs nothing more.
      timers: { setTimeout: (fn, ms) => clock.setTimeout(() => { if (!st.dead) { fn(); } }, ms), clearTimeout: (h) => clock.clearTimeout(h) },
      request: (...args) => (st.dead ? new Promise(() => {}) : base(...args)),
      tabId: opts.tabId || name,
      visible: () => st.visible,
      online: () => st.online,
      onToast: (job) => toasts.push(job),
    });
    tracker.attach(win, doc);
    tracker.subscribe((e) => events.push(e));
    const t = {
      name, tracker, win, doc, st, toasts, events,
      hide() { st.visible = false; doc.dispatch('visibilitychange'); },
      show() { st.visible = true; doc.dispatch('visibilitychange'); },
      goOnline() { st.online = true; win.dispatch('online'); },
      close() { tracker.stop(); browser.wins.delete(win); },
      crash() { st.dead = true; browser.wins.delete(win); },
      job(id) { return tracker.get(id); },
    };
    tabs.push(t);
    return t;
  }
  return {
    clock, browser, server, tab, tabs,
    seed(jobs, retired = []) { browser.data.set(KEY.jobs, JSON.stringify({ jobs, retired })); },
    stored() { return JSON.parse(browser.data.get(KEY.jobs)); },
    done() { for (const t of tabs) { if (!t.st.dead) { t.tracker.stop(); } } },
  };
}

const req = (over = {}) => ({
  url: URL1, directory: DIR, codec: 'mp3',
  metadata: { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', year: '2001' },
  title: 'One More Time', crumbs: ['Music', 'Daft Punk', 'Discovery'], cover: 'https://i.ytimg.com/vi/x/hq.jpg',
  ...over,
});

// A stored job, as the tracker writes them.
const stored = (over = {}) => ({
  id: `j-${Math.random().toString(36).slice(2)}`, serverId: null, claim: null, tab: 'other', url: URL1, directory: DIR, codec: 'mp3',
  metadata: {}, title: 'One More Time', crumbs: ['Music', 'Daft Punk', 'Discovery'], cover: null, mkdir: null, mkdirFolder: null,
  state: 'added', createdAt: T0 - MIN, sentAt: null, serverStart: null, endedAt: T0 - MIN, fileName: null, filePath: null,
  downloadId: null, bytes: null, trackId: null, failure: null, error: null, reason: null, hidden: false, seen: true, toast: 'done',
  ...over,
});

describe('storage', () => {
  test('one list per server origin and account; another tab of the same account shares it', async () => {
    const w = world();
    const a = w.tab('a');
    await a.tracker.add(req());
    const bob = w.tab('bob', { user: 'bob' });
    const other = w.tab('other', { origin: 'http://other.local' });
    const a2 = w.tab('a2');
    assert.equal(a.tracker.jobs().length, 1);
    assert.equal(a2.tracker.jobs().length, 1);
    assert.equal(bob.tracker.jobs().length, 0);
    assert.equal(other.tracker.jobs().length, 0);
    assert.deepEqual(KEY, {
      jobs: 'mstream-ytdl-jobs:http%3A%2F%2Fmusic.local%3A3000|alice',
      leader: 'mstream-ytdl-poll:http%3A%2F%2Fmusic.local%3A3000|alice',
    });
    assert.ok(w.browser.data.has(KEY.jobs));
    // A name with the separator in it can't pass for another account's.
    assert.notEqual(J.storageKeys({ origin: 'a|b', user: 'c' }).jobs, J.storageKeys({ origin: 'a', user: 'b|c' }).jobs);
    w.done();
  });

  test('storage that throws (blocked site data) or is missing: the tracker works from this page alone', async () => {
    for (const storage of [null, { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() {} }]) {
      const w = world();
      const a = w.tab('a', { storage });
      const out = await a.tracker.add(req());
      assert.equal(out.ok, true);
      assert.equal(a.tracker.status().stored, false);
      w.server.complete(out.job.serverId);
      await w.clock.advance(3000);
      assert.equal(a.job(out.job.id).state, 'added');
      assert.equal(a.toasts.length, 1);
      w.done();
    }
  });

  test('a write that fails (quota) keeps the list in this page from then on', async () => {
    const w = world();
    const store = w.browser.storageFor({});
    let full = false;
    const quota = { getItem: (k) => store.getItem(k), setItem: (k, v) => { if (full) { throw new Error('QuotaExceededError'); } store.setItem(k, v); }, removeItem: (k) => store.removeItem(k) };
    const a = w.tab('a', { storage: quota });
    await a.tracker.add(req());
    full = true;
    const out = await a.tracker.add(req({ url: URL2 }));
    assert.equal(out.ok, true);
    assert.equal(a.tracker.jobs().length, 2);
    assert.equal(a.tracker.status().stored, false);
    w.done();
  });

  test('a read of storage between another tab’s write and its storage event still takes the change in', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b', { visible: false });
    // No write after the add's first ones.
    w.server.onPost = (body, opts) => hang(opts);
    a.tracker.add(req());
    // b reads storage itself before the event reaches it.
    assert.equal(await b.tracker.checkAgain('no-such-job'), null);
    await settle();
    assert.equal(b.tracker.jobs().length, 1);
    assert.ok(b.events.some((e) => e.type === 'jobs'));
    w.done();
  });

  test('garbage reads as an empty list; a job with no id, link or folder is dropped; a state this build does not know reads not sure', () => {
    const w = world();
    w.browser.data.set(KEY.jobs, '{not json');
    assert.deepEqual(w.tab('a', { visible: false }).tracker.jobs(), []);
    w.browser.data.set(KEY.jobs, JSON.stringify([1, 2, 3]));
    assert.deepEqual(w.tab('b', { visible: false }).tracker.jobs(), []);
    w.seed([
      { id: 'x' }, null, 7, 'job', { id: 'y', url: URL1 }, { id: '', url: URL1, directory: DIR },
      { id: 'a', url: URL1, directory: DIR, state: 'teleporting', createdAt: T0 },
      { id: 'b', url: URL1, directory: DIR, state: 'beamed', serverId: 'srv-9', createdAt: T0 - 1 },
      { id: 'a', url: URL2, directory: DIR, state: 'added', createdAt: T0 - 2 },
    ]);
    const jobs = w.tab('c', { visible: false }).tracker.jobs();
    assert.deepEqual(jobs.map((j) => [j.id, j.state]), [['a', 'notSureStarted'], ['b', 'notSureFinished']]);
    assert.equal(jobs[0].codec, 'mp3');
    assert.deepEqual(jobs[0].metadata, {});
    // A copy: changing it changes nothing in the tracker.
    assert.throws(() => { 'use strict'; jobs[0].state = 'added'; });
    w.done();
  });

  test('retention: the last 20 per key, open jobs always, Needs a look rows for 7 days', () => {
    const w = world();
    const jobs = [];
    for (let i = 0; i < 3; i++) { jobs.push(stored({ id: `open-${i}`, state: 'adding', serverId: `srv-o${i}`, createdAt: T0 - (100 + i) * HOUR })); }
    for (let i = 0; i < 22; i++) { jobs.push(stored({ id: `added-${i}`, createdAt: T0 - i * MIN, endedAt: T0 - i * MIN })); }
    jobs.push(stored({ id: 'failed-8d', state: 'failed', createdAt: T0 - 8 * 24 * HOUR, endedAt: T0 - 8 * 24 * HOUR }));
    jobs.push(stored({ id: 'failed-6d', state: 'failed', createdAt: T0 - 6 * 24 * HOUR, endedAt: T0 - 6 * 24 * HOUR, seen: false }));
    jobs.push(stored({ id: 'notfound-8d', state: 'notFound', createdAt: T0 - 8 * 24 * HOUR, endedAt: T0 - 8 * 24 * HOUR }));
    w.seed(jobs);
    const a = w.tab('a', { visible: false });
    // Expired rows are out of Needs a look even before a write prunes them.
    assert.deepEqual(a.tracker.lists().needsLook.map((j) => j.id), ['failed-6d']);
    // Any write prunes.
    a.tracker.markSeen();
    const ids = a.tracker.jobs().map((j) => j.id);
    assert.equal(ids.length, 20);
    for (const id of ['open-0', 'open-1', 'open-2']) { assert.ok(ids.includes(id), id); }
    assert.ok(!ids.includes('failed-8d'));
    assert.ok(!ids.includes('notfound-8d'));
    // The oldest settled ones went first: the 6-day-old failure, then the
    // oldest added jobs.
    assert.ok(!ids.includes('failed-6d'));
    assert.deepEqual(ids.filter((id) => id.startsWith('added-')), Array.from({ length: 17 }, (_, i) => `added-${i}`));
    w.done();
  });

  test('tabIdOf keeps one id per tab in sessionStorage; a storage that throws still gets one', () => {
    const m = new Map();
    const session = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
    const id = J.tabIdOf(session);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(J.tabIdOf(session), id);
    assert.equal(m.get('mstream-ytdl-tab'), id);
    const id2 = J.tabIdOf({ getItem() { throw new Error('x'); } });
    assert.equal(typeof id2, 'string');
    assert.notEqual(id2, id);
    assert.equal(typeof J.tabIdOf(null), 'string');
  });
});

describe('the add', () => {
  test('the POST goes once with ytdl-core’s body; the job reads starting until the 200, then adding by the server’s id', async () => {
    const w = world();
    const a = w.tab('a');
    const answer = deferred();
    w.server.onPost = (body) => { const j = w.server.start(body); return answer.promise.then(() => ({ message: 'Download started', id: j.id, fileName: j.fileName })); };
    const metadata = { title: ' One More Time ', artist: 'Daft Punk', album: '', year: '20' };
    const p = a.tracker.add(req({ metadata }));
    await settle();
    assert.deepEqual(a.tracker.jobs().map((j) => j.state), ['starting']);
    assert.equal(a.tracker.summary().kind, 'adding');
    answer.resolve();
    const out = await p;
    assert.equal(out.ok, true);
    assert.equal(out.unsure, false);
    assert.equal(out.job.state, 'adding');
    assert.equal(out.job.serverId, 'srv-1');
    assert.equal(out.job.claim, 'post');
    assert.equal(out.job.fileName, 'One_More_Time.mp3');
    assert.equal(out.job.tab, 'a');
    const post = w.server.calls.find((c) => c.method === 'POST' && c.path === 'api/v1/ytdl/');
    assert.deepEqual(post.body, Y.addRequest({ url: URL1, directory: DIR, codec: 'mp3', fields: metadata }));
    assert.deepEqual(post.body, { directory: DIR, url: URL1, outputCodec: 'mp3', metadata: { title: 'One More Time', artist: 'Daft Punk' } });
    // The tags kept are the ones sent.
    assert.deepEqual(out.job.metadata, { title: 'One More Time', artist: 'Daft Punk' });
    await w.clock.advance(5 * MIN);
    assert.equal(w.server.posts(), 1);
    w.done();
  });

  test('a link or folder missing is refused here, nothing sent', async () => {
    const w = world();
    const a = w.tab('a');
    for (const bad of [req({ url: '' }), req({ directory: undefined }), null]) {
      const out = await a.tracker.add(bad);
      assert.equal(out.ok, false);
      assert.equal(out.failure.problem, 'badRequest');
    }
    assert.equal(w.server.calls.length, 0);
    assert.deepEqual(a.tracker.jobs(), []);
    w.done();
  });

  test('complete → added with the landed name, path and record id; the toast says where', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'adding');
    w.server.complete(out.job.serverId, { fileName: 'One_More_Time_2.mp3' });
    await w.clock.advance(3000);
    const j = a.job(out.job.id);
    assert.equal(j.state, 'added');
    assert.equal(j.fileName, 'One_More_Time_2.mp3');
    assert.equal(j.filePath, 'Music/Daft Punk/Discovery/One_More_Time_2.mp3');
    assert.equal(j.downloadId, 57);
    assert.equal(j.endedAt, w.clock.now());
    assert.equal(a.toasts.length, 1);
    assert.deepEqual(toast(a.toasts[0]), { key: 'ytdl.toast.added', params: { title: 'One More Time', path: '⁨Daft Punk⁩ › ⁨Discovery⁩' } });
    assert.deepEqual(a.events.filter((e) => e.type === 'settled').map((e) => [e.job.id, e.job.state]), [[out.job.id, 'added']]);
    // Settled: nothing is read any more.
    const reads = w.server.lists();
    await w.clock.advance(MIN);
    assert.equal(w.server.lists(), reads);
    w.done();
  });

  test('error → failed with the server’s reason and words, read by ytdl-core', async () => {
    const w = world();
    const a = w.tab('a');
    const one = await a.tracker.add(req());
    const two = await a.tracker.add(req({ url: URL2, title: 'Around the World' }));
    w.server.fail(one.job.serverId, 'too-long', 'the download took longer than 60 minutes and was stopped');
    w.server.fail(two.job.serverId, null, '[youtube] FGBhQbmPwH8: Sign in to confirm you’re not a bot.');
    await w.clock.advance(3000);
    const j1 = a.job(one.job.id);
    assert.equal(j1.state, 'failed');
    assert.equal(j1.reason, 'too-long');
    assert.equal(j1.error, 'the download took longer than 60 minutes and was stopped');
    assert.deepEqual([j1.failure.problem, j1.failure.phase], ['tooLong', 'download']);
    assert.deepEqual(row(j1, { formats: ['mp3', 'm4a'] }), { section: 'needsLook', tone: 'error', status: { key: 'ytdl.reason.tooLong' }, actions: ['retry', 'dismiss'] });
    const j2 = a.job(two.job.id);
    assert.equal(j2.reason, null);
    assert.deepEqual(row(j2).status, { key: 'ytdl.row.failedSaid', params: { text: '[youtube] FGBhQbmPwH8: Sign in to confirm you’re not a bot.' } });
    assert.deepEqual(a.toasts.map((j) => toast(j)), [
      { key: 'ytdl.toast.couldntAdd', params: { title: 'Around the World' } },
      { key: 'ytdl.toast.couldntAdd', params: { title: 'One More Time' } },
    ]);
    w.done();
  });

  test('a 409 resolves as the refusal to show where Add was pressed: no row, no toast, POSTed once', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = () => { throw httpError(409, { error: '“One_More_Time.mp3” is already in this folder, so nothing was added.', reason: 'exists', fileName: 'One_More_Time.mp3' }); };
    const out = await a.tracker.add(req());
    assert.equal(out.ok, false);
    assert.equal(out.unsure, false);
    assert.equal(out.job, null);
    assert.deepEqual([out.failure.problem, out.failure.detail, out.failure.reason], ['exists', 'One_More_Time.mp3', 'exists']);
    assert.deepEqual(note(Y.failureLabel(out.failure)), { key: 'ytdl.err.exists', params: { name: 'One_More_Time.mp3' } });
    assert.deepEqual(a.tracker.jobs(), []);
    assert.equal(a.tracker.isAddingTo(DIR, URL1), false);
    await w.clock.advance(5 * MIN);
    assert.equal(w.server.posts(), 1);
    assert.equal(a.toasts.length, 0);
    w.done();
  });

  test('every other refusal maps through ytdl-core and leaves no row', async () => {
    const cases = [
      [httpError(403, { error: 'Uploading Disabled' }), 'uploadsOff', null],
      [httpError(500, { error: 'FFmpeg is not available yet' }), 'ffmpegNotReady', null],
      [httpError(500, { error: 'yt-dlp is not installed' }), 'ytdlpMissing', null],
      [httpError(404, { error: "Library 'Music' not found" }), 'libraryGone', 'Music'],
      [httpError(404, { error: 'Folder not found' }), 'other', 'Folder not found'],
      [httpError(400, { error: '"outputCodec" must be one of [mp3, flac]' }), 'badFormat', null],
      [httpError(400, { error: '"url" is required' }), 'badRequest', null],
      [httpError(500, { error: 'Server Error' }), 'serverError', null],
    ];
    for (const [err, problem, detail] of cases) {
      const w = world();
      const a = w.tab('a');
      w.server.onPost = () => { throw err; };
      const out = await a.tracker.add(req());
      assert.deepEqual([out.ok, out.unsure, out.job, out.failure.problem, out.failure.detail], [false, false, null, problem, detail], problem);
      assert.deepEqual(a.tracker.jobs(), []);
      await w.clock.advance(MIN);
      assert.equal(w.server.posts(), 1);
      assert.equal(a.toasts.length, 0);
      w.done();
    }
  });

  test('when the surface no longer shows the link (inline answers false), a refusal is a Needs a look row and a toast', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = () => { throw httpError(500, { error: 'Server Error' }); };
    let showing = true;
    const p = a.tracker.add(req({ inline: () => showing }));
    showing = false;
    const out = await p;
    assert.equal(out.job.state, 'startFailed');
    assert.equal(out.failure.problem, 'serverError');
    const j = a.job(out.job.id);
    assert.deepEqual(row(j), { section: 'needsLook', tone: 'error', status: { key: 'ytdl.err.server' }, actions: ['retry', 'dismiss'] });
    assert.deepEqual(a.toasts.map((x) => toast(x)), [{ key: 'ytdl.toast.couldntAdd', params: { title: 'One More Time' } }]);
    assert.deepEqual(a.tracker.lists().needsLook.map((x) => x.id), [j.id]);
    w.done();
  });

  test('no answer, the 30 s bound and a proxy’s 504 are startUnsure — never POSTed again', async () => {
    for (const make of [() => { throw netError(); }, (body, opts) => hang(opts), () => { throw httpError(504, null); }]) {
      const w = world();
      const a = w.tab('a');
      w.server.onPost = make;
      const p = a.tracker.add(req());
      await w.clock.advance(J.POST_TIMEOUT_MS);
      const out = await p;
      assert.equal(out.ok, false);
      assert.equal(out.unsure, true);
      assert.equal(out.failure.problem, 'startUnsure');
      assert.equal(out.job.state, 'startUnsure');
      assert.deepEqual(row(out.job), { section: 'adding', tone: 'busy', status: { key: 'ytdl.row.startUnsure' }, actions: [] });
      await w.clock.advance(5 * MIN);
      assert.equal(w.server.posts(), 1);
      w.done();
    }
  });

  test('the folder is made first when asked, once: refused, failed and unreachable stop the add; an unreadable 2xx carries on', async () => {
    const w = world();
    const a = w.tab('a');
    const ok = await a.tracker.add(req({ mkdir: true, mkdirFolder: 'Discovery' }));
    assert.equal(ok.ok, true);
    assert.deepEqual(w.server.calls.slice(0, 2).map((c) => [c.method, c.path, c.body.directory]), [['POST', 'api/v1/file-explorer/mkdir', DIR], ['POST', 'api/v1/ytdl/', DIR]]);
    const parent = await a.tracker.add(req({ url: URL2, mkdir: '/Music/Daft Punk/' }));
    assert.equal(parent.ok, true);
    assert.equal(w.server.mkdirs()[1].body.directory, '/Music/Daft Punk/');
    w.done();

    const cases = [
      [() => { throw httpError(403, { error: 'Create Folder Disabled' }); }, true, 'mkdirOff', 'Discovery'],
      [() => { throw httpError(500, { error: 'EEXIST: file already exists' }); }, true, 'mkdirFailed', 'Discovery'],
      [() => { throw netError(); }, true, 'unreachable', null],
      [() => { throw netError(); }, false, 'offline', null],
      [() => { throw httpError(404, { error: "Library 'Music' not found" }); }, true, 'libraryGone', 'Music'],
    ];
    for (const [make, online, problem, detail] of cases) {
      const w2 = world();
      const b = w2.tab('b', { online });
      w2.server.onMkdir = make;
      const out = await b.tracker.add(req({ mkdir: true, mkdirFolder: 'Discovery' }));
      assert.deepEqual([out.ok, out.unsure, out.failure.problem, out.failure.detail], [false, false, problem, detail], problem);
      assert.equal(w2.server.posts(), 0);
      assert.equal(w2.server.mkdirs().length, 1);
      assert.deepEqual(b.tracker.jobs(), []);
      w2.done();
    }

    const w3 = world();
    const c = w3.tab('c');
    w3.server.onMkdir = () => { throw new SyntaxError('Unexpected end of JSON input'); };
    const out = await c.tracker.add(req({ mkdir: true }));
    assert.equal(out.ok, true);
    assert.equal(w3.server.posts(), 1);
    w3.done();
  });
});

describe('claiming an add the server never answered', () => {
  test('the entry for the same link and folder, started no earlier than 5 s before the press, is claimed', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.start({ url: URL1, directory: DIR }, { startTime: T0 - 6000 });          // srv-1: before the press
    w.server.start({ url: URL1, directory: '/Music/Inbox/' });                        // srv-2: another folder
    w.server.start({ url: URL2, directory: DIR });                                    // srv-3: another link
    // The POST reached the server; its answer was lost.
    w.server.onPost = (body) => { w.server.start(body); throw netError(); };          // srv-4
    const out = await a.tracker.add(req());
    assert.equal(out.unsure, true);
    await w.clock.advance(3000);
    const j = a.job(out.job.id);
    assert.deepEqual([j.state, j.serverId, j.claim], ['adding', 'srv-4', 'match']);
    w.server.complete('srv-4');
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'added');
    w.done();
  });

  test('an entry for the same link and folder from before the press is someone else’s: never claimed', async () => {
    const w = world();
    const a = w.tab('a');
    // An earlier add of the same song (the phone's, a minute ago), still
    // listed; this POST never reached the server.
    w.server.start({ url: URL1, directory: DIR }, { startTime: T0 - MIN, status: 'complete' });
    w.server.start({ url: URL1, directory: DIR }, { startTime: T0 - 6000 });
    w.server.onPost = () => { throw netError(); };
    const out = await a.tracker.add(req());
    await w.clock.advance(J.CLAIM_WINDOW_MS + 3000);
    const j = a.job(out.job.id);
    assert.deepEqual([j.state, j.serverId], ['notSureStarted', null]);
    w.done();
  });

  test('a server clock a few seconds behind still matches', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.skew = -4000;
    w.server.onPost = (body) => { w.server.start(body); throw netError(); };
    const out = await a.tracker.add(req());
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).serverId, 'srv-1');
    w.done();
  });

  test('an entry another job holds is never claimed, and neither is a dismissed row’s', async () => {
    const w = world();
    const a = w.tab('a');
    const first = await a.tracker.add(req());                                         // srv-1, held
    w.server.onPost = () => { throw netError(); };                                    // never reached it
    const second = await a.tracker.add(req());
    await w.clock.advance(J.CLAIM_WINDOW_MS + 3000);
    assert.equal(a.job(first.job.id).serverId, 'srv-1');
    assert.equal(a.job(second.job.id).state, 'notSureStarted');
    assert.equal(a.job(second.job.id).serverId, null);
    w.done();

    const w2 = world();
    const b = w2.tab('b');
    const gone = await b.tracker.add(req());
    w2.server.fail(gone.job.serverId, 'unavailable', '[youtube] dQw4w9WgXcQ: Video unavailable');
    await w2.clock.advance(3000);
    b.tracker.dismiss(gone.job.id);
    assert.equal(b.tracker.get(gone.job.id), null);
    assert.deepEqual(w2.stored().retired, ['srv-1']);
    w2.server.onPost = () => { throw netError(); };
    const again = await b.tracker.add(req());
    await w2.clock.advance(J.CLAIM_WINDOW_MS + 3000);
    assert.equal(b.job(again.job.id).state, 'notSureStarted');
    w2.done();
  });

  test('nothing within 2 minutes is Not sure it started (no toast, not a failure); Check again finds it, or says Not found', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = () => { throw netError(); };
    const out = await a.tracker.add(req());
    await w.clock.advance(J.CLAIM_WINDOW_MS - 3000);
    assert.equal(a.job(out.job.id).state, 'startUnsure');
    await w.clock.advance(6000);
    let j = a.job(out.job.id);
    assert.equal(j.state, 'notSureStarted');
    assert.deepEqual(row(j), { section: 'needsLook', tone: 'unsure', status: { key: 'ytdl.row.notSureStarted' }, actions: ['checkAgain', 'dismiss'] });
    assert.equal(a.toasts.length, 0);
    assert.equal(a.tracker.summary().failed, 0);
    // Settled: nothing is read any more.
    const reads = w.server.lists();
    await w.clock.advance(MIN);
    assert.equal(w.server.lists(), reads);

    // A list that can't be read leaves the row as it was.
    w.server.onList = () => { throw netError(); };
    const check = a.tracker.checkAgain(j);
    assert.equal(a.tracker.busy(j), true);
    assert.equal((await check).state, 'notSureStarted');
    assert.equal(a.tracker.busy(j), false);
    // So does a record that can't be read.
    w.server.onList = null;
    w.server.onRecords = () => { throw httpError(500, { error: 'Server Error' }); };
    assert.equal((await a.tracker.checkAgain(j)).state, 'notSureStarted');
    w.server.onRecords = null;
    // Both read and nothing anywhere: Not found on the server.
    j = await a.tracker.checkAgain(j);
    assert.equal(j.state, 'notFound');
    assert.deepEqual(row(j), { section: 'needsLook', tone: 'unsure', status: { key: 'ytdl.row.notFound' }, actions: ['addAgain', 'dismiss'] });
    w.done();
  });

  test('Check again finds the entry (back to Adding) or the record (Added)', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = () => { throw netError(); };
    const one = await a.tracker.add(req());
    const two = await a.tracker.add(req({ url: URL2 }));
    await w.clock.advance(J.CLAIM_WINDOW_MS + 3000);
    assert.equal(a.job(one.job.id).state, 'notSureStarted');
    // The server had them after all (a slow start, a lost answer).
    w.server.start({ url: URL1, directory: DIR }, { startTime: T0 + 1000 });
    w.server.record({ origin: URL2, filepath: 'Music/Daft Punk/Discovery/Around_the_World.mp3', downloadedAt: T0 + 2000 });
    const j1 = await a.tracker.checkAgain(one.job.id);
    assert.deepEqual([j1.state, j1.serverId, j1.claim], ['adding', 'srv-1', 'match']);
    const j2 = await a.tracker.checkAgain(two.job.id);
    assert.deepEqual([j2.state, j2.filePath, j2.downloadId], ['added', 'Music/Daft Punk/Discovery/Around_the_World.mp3', 57]);
    // An open row has nothing to check.
    assert.equal((await a.tracker.checkAgain(one.job.id)).state, 'adding');
    w.done();
  });

  test('while another add of the same link to the same folder is still sending, its entry is left to it', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    w.server.onPost = () => { throw netError(); };
    const lost = await b.tracker.add(req());                                          // never reached the server
    const answer = deferred();
    w.server.onPost = (body) => { const j = w.server.start(body); return answer.promise.then(() => ({ message: 'Download started', id: j.id, fileName: j.fileName })); };
    const p = a.tracker.add(req());
    await w.clock.advance(9000);
    assert.equal(b.job(lost.job.id).serverId, null);
    answer.resolve();
    const out = await p;
    assert.equal(out.job.serverId, 'srv-1');
    await w.clock.advance(J.CLAIM_WINDOW_MS);
    assert.equal(a.job(lost.job.id).state, 'notSureStarted');
    assert.equal(a.job(out.job.id).serverId, 'srv-1');
    w.done();
  });

  test('a 200 naming an entry another job took by its link and folder takes it back', async () => {
    const w = world();
    w.seed([stored({ id: 'wrong', state: 'adding', serverId: 'srv-1', claim: 'match', createdAt: T0 - 1000, sentAt: T0 - 1000, endedAt: null, seen: false, toast: null })]);
    const a = w.tab('a', { visible: false });
    const out = await a.tracker.add(req());
    assert.equal(out.job.serverId, 'srv-1');
    const wrong = a.job('wrong');
    assert.deepEqual([wrong.state, wrong.serverId, wrong.claim], ['startUnsure', null, null]);
    w.done();
  });

  test('a tab that reloads mid-POST looks for its add; another tab leaves it until it is a minute old', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = (body, opts) => { w.server.start(body); return hang(opts); };
    a.tracker.add(req());
    await settle();
    const b = w.tab('b');
    assert.equal(b.tracker.jobs()[0].state, 'starting');
    a.crash();
    const reloaded = w.tab('a-again', { tabId: 'a' });
    assert.equal(reloaded.tracker.jobs()[0].state, 'startUnsure');
    await w.clock.advance(3000);
    assert.deepEqual([b.tracker.jobs()[0].state, b.tracker.jobs()[0].serverId], ['adding', 'srv-1']);
    w.done();

    const w2 = world();
    const c = w2.tab('c');
    w2.server.onPost = (body, opts) => { w2.server.start(body); return hang(opts); };
    c.tracker.add(req());
    await settle();
    c.crash();
    const d = w2.tab('d');
    await w2.clock.advance(J.STARTING_STALE_MS - 6000);
    assert.equal(d.tracker.jobs()[0].state, 'starting');
    await w2.clock.advance(9000);
    assert.equal(d.tracker.jobs()[0].state, 'adding');
    assert.equal(d.tracker.jobs()[0].serverId, 'srv-1');
    w2.done();
  });
});

describe('an entry that is gone', () => {
  test('a server restart: Not found on the server — unless its record says it was added', async () => {
    const w = world();
    const a = w.tab('a');
    const lost = await a.tracker.add(req());
    const landed = await a.tracker.add(req({ url: URL2, title: 'Around the World' }));
    await w.clock.advance(3000);
    w.server.complete(landed.job.serverId);
    w.server.restart();
    await w.clock.advance(3000);
    const j1 = a.job(lost.job.id);
    assert.equal(j1.state, 'notFound');
    const j2 = a.job(landed.job.id);
    assert.deepEqual([j2.state, j2.downloadId, j2.filePath], ['added', 57, 'Music/Daft Punk/Discovery/One_More_Time.mp3']);
    // The record was asked for this link and folder only, ytdl's own.
    assert.ok(w.server.recordReads().every((c) => c.path.includes('plugin=ytdl')));
    assert.deepEqual(a.toasts.map((j) => j.id), [landed.job.id]);
    w.done();
  });

  test('a record that can’t be read leaves the job adding until it can', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    w.server.restart();
    w.server.onRecords = () => { throw netError(); };
    await w.clock.advance(9000);
    assert.equal(a.job(out.job.id).state, 'adding');
    w.server.onRecords = null;
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'notFound');
    w.done();
  });

  test('an open job older than the server’s day with no entry and no record: Not sure it finished', async () => {
    const w = world();
    w.seed([stored({ id: 'old', state: 'adding', serverId: 'srv-old', tab: 'a', createdAt: T0 - 25 * HOUR, sentAt: T0 - 25 * HOUR, endedAt: null, seen: false, toast: null })]);
    const a = w.tab('a');
    await w.clock.advance(1000);
    const j = a.job('old');
    assert.equal(j.state, 'notSureFinished');
    assert.deepEqual(row(j), { section: 'needsLook', tone: 'unsure', status: { key: 'ytdl.row.notSureFinished' }, actions: ['checkAgain', 'dismiss'] });
    assert.equal(a.toasts.length, 0);
    w.done();
  });
});

describe('one poller for every tab', () => {
  test('two visible tabs: one reads every 3 s, the other follows its writes', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    const out = await a.tracker.add(req());
    await w.clock.advance(30000);
    assert.equal(w.server.lists('a'), 11);
    assert.equal(w.server.lists('b'), 0);
    assert.equal(a.tracker.status().leader, true);
    assert.equal(b.tracker.status().leader, false);
    assert.equal(b.job(out.job.id).state, 'adding');
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    assert.equal(b.job(out.job.id).state, 'added');
    assert.deepEqual(b.events.filter((e) => e.type === 'settled').map((e) => e.job.state), ['added']);
    w.done();
  });

  test('a hidden tab never reads: the visible one takes over at once; with every tab hidden nothing is read; shown again, one read at once', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    await a.tracker.add(req());
    await w.clock.advance(3000);
    const before = w.server.lists('a');
    a.hide();
    await w.clock.advance(9000);
    assert.equal(w.server.lists('a'), before);
    assert.equal(w.server.lists('b'), 3);
    assert.equal(b.tracker.status().leader, true);
    b.hide();
    const total = w.server.lists();
    await w.clock.advance(10 * MIN);
    assert.equal(w.server.lists(), total);
    a.show();
    await settle();
    assert.equal(w.server.lists('a'), before + 1);
    assert.equal(w.server.lists(), total + 1);
    w.done();
  });

  test('a leader that went away without a word is replaced once its beat is stale', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    await a.tracker.add(req());
    await w.clock.advance(3000);
    a.crash();
    await w.clock.advance(J.LEADER_STALE_MS - 1000);
    assert.equal(w.server.lists('b'), 0);
    await w.clock.advance(4000);
    assert.equal(w.server.lists('b'), 1);
    assert.equal(b.tracker.status().leader, true);
    w.done();
  });

  test('a tab that closes hands over at once, keeping the beat', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    await a.tracker.add(req());
    assert.equal(w.server.lists('a'), 1);
    a.close();
    await settle();
    assert.equal(b.tracker.status().leader, true);
    assert.equal(w.server.lists('b'), 0);
    await w.clock.advance(3000);
    assert.equal(w.server.lists('b'), 1);
    assert.equal(w.server.lists('a'), 1);
    w.done();
  });

  test('backoff: 6, 12, 24, 48 s, then a minute; a good read goes back to 3 s; the rows read Waiting for connection', async () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(J.delayFor), [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    const out = await a.tracker.add(req());
    const at = [];
    w.server.onList = () => { at.push(w.clock.now() - T0); throw netError(); };
    await w.clock.advance(5 * MIN);
    assert.deepEqual(at.slice(0, 8), [3000, 9000, 21000, 45000, 93000, 153000, 213000, 273000]);
    assert.equal(a.tracker.status().waiting, true);
    assert.equal(b.tracker.status().waiting, true);
    assert.deepEqual(row(a.job(out.job.id), { waiting: true }).status, { key: 'ytdl.row.waiting' });
    assert.deepEqual(a.tracker.row(a.job(out.job.id)).status, { key: 'ytdl.row.waiting' });
    w.server.onList = null;
    await w.clock.advance(MIN);
    assert.equal(a.tracker.status().waiting, false);
    const n = w.server.lists();
    await w.clock.advance(9000);
    assert.equal(w.server.lists(), n + 3);
    w.done();
  });

  test('a refused read (401, 500) backs off too, but is not Waiting for connection', async () => {
    const w = world();
    const a = w.tab('a');
    await a.tracker.add(req());
    w.server.onList = () => { throw httpError(500, { error: 'Server Error' }); };
    await w.clock.advance(10000);
    assert.equal(a.tracker.status().waiting, false);
    assert.equal(w.server.lists(), 3);
    w.done();
  });

  test('back online: the leader reads at once; a follower does not', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    await a.tracker.add(req());
    w.server.onList = () => { throw netError(); };
    await w.clock.advance(50000);
    w.server.onList = null;
    const na = w.server.lists('a');
    b.goOnline();
    await settle();
    assert.equal(w.server.lists('b'), 0);
    assert.equal(w.server.lists('a'), na);
    a.goOnline();
    await settle();
    assert.equal(w.server.lists('a'), na + 1);
    assert.equal(a.tracker.status().waiting, false);
    w.done();
  });

  test('nothing open, nothing read; the listeners come off on stop', async () => {
    const w = world();
    const a = w.tab('a');
    await w.clock.advance(10 * MIN);
    assert.equal(w.server.lists(), 0);
    assert.equal(a.win.count('storage'), 1);
    assert.equal(a.doc.count('visibilitychange'), 1);
    a.tracker.stop();
    assert.equal(a.win.count('storage'), 0);
    assert.equal(a.win.count('online'), 0);
    assert.equal(a.doc.count('visibilitychange'), 0);
    w.done();
  });
});

describe('the toast', () => {
  test('only the tab that pressed Add toasts, once — every tab hears the settle', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    const c = w.tab('c');
    const out = await a.tracker.add(req());
    // b polls, not a.
    a.hide();
    await w.clock.advance(6000);
    assert.equal(b.tracker.status().leader, true);
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    assert.deepEqual(a.toasts.map((j) => [j.id, j.state]), [[out.job.id, 'added']]);
    assert.equal(b.toasts.length, 0);
    assert.equal(c.toasts.length, 0);
    for (const t of [a, b, c]) { assert.deepEqual(t.events.filter((e) => e.type === 'settled').map((e) => e.job.id), [out.job.id], t.name); }
    assert.equal(w.stored().jobs[0].toast, 'done');
    // A reload of that tab says nothing again.
    a.close();
    const again = w.tab('a2', { tabId: 'a' });
    assert.equal(again.toasts.length, 0);
    w.done();
  });

  test('a tab back from a reload toasts what settled while it loaded; an old one is dropped', () => {
    const w = world();
    w.seed([
      stored({ id: 'fresh', tab: 'a', toast: 'pending', seen: false, endedAt: T0 - 10000 }),
      stored({ id: 'stale', tab: 'a', toast: 'pending', seen: false, endedAt: T0 - 2 * MIN }),
      stored({ id: 'theirs', tab: 'z', toast: 'pending', seen: false, endedAt: T0 - 1000 }),
    ]);
    const a = w.tab('a', { visible: false });
    assert.deepEqual(a.toasts.map((j) => j.id), ['fresh']);
    assert.deepEqual(w.stored().jobs.map((j) => [j.id, j.toast]), [['fresh', 'done'], ['stale', 'done'], ['theirs', 'pending']]);
    w.done();
  });
});

describe('the pill, Already adding, the explorer strip', () => {
  test('summary: adding first, then failures not seen, then added in the last hour not seen', async () => {
    const w = world();
    const a = w.tab('a');
    const running = await a.tracker.add(req());
    const failing = await a.tracker.add(req({ url: URL2 }));
    const landing = await a.tracker.add(req({ url: URL3 }));
    w.server.fail(failing.job.serverId, 'live', 'it is a live stream, which is not downloaded');
    w.server.complete(landing.job.serverId);
    await w.clock.advance(3000);
    assert.deepEqual(a.tracker.summary(), { adding: 1, failed: 1, added: 1, kind: 'adding', count: 1, until: w.clock.now() + HOUR });
    // Hidden: the server keeps going, the pill doesn't count it.
    a.tracker.hide(running.job);
    assert.equal(a.tracker.summary().kind, 'failed');
    assert.equal(a.tracker.summary().count, 1);
    a.tracker.markSeen();
    assert.equal(a.tracker.summary().kind, null);
    assert.equal(a.tracker.summary().until, null);
    // Seen only once settled: an open job stays unseen. A hidden one that
    // lands counts for nothing (the phone's rule).
    assert.equal(a.job(running.job.id).seen, false);
    w.server.complete(running.job.serverId);
    await w.clock.advance(3000);
    assert.equal(a.tracker.summary().kind, null);
    const later = await a.tracker.add(req({ url: 'https://www.youtube.com/watch?v=HG7I9_Hd7sk' }));
    w.server.complete(later.job.serverId);
    await w.clock.advance(3000);
    assert.deepEqual([a.tracker.summary().kind, a.tracker.summary().count], ['added', 1]);
    const events = a.events.length;
    await w.clock.advance(HOUR - 1000);
    assert.equal(a.tracker.summary().kind, 'added');
    await w.clock.advance(1001);
    assert.equal(a.tracker.summary().kind, null);
    assert.ok(a.events.length > events, 'the hour running out is a change to redraw');
    w.done();
  });

  test('watch(): outcomes are seen as they land while this tab shows the panel', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    a.tracker.watch(true);
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).seen, true);
    assert.equal(a.tracker.summary().kind, null);
    w.done();
  });

  test('isAddingTo sees every tab’s open jobs, hidden ones too, in either path spelling', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    const out = await a.tracker.add(req());
    await settle();
    assert.equal(b.tracker.isAddingTo(DIR, URL1), true);
    assert.equal(b.tracker.isAddingTo('Music/Daft Punk/Discovery', URL1), true);
    assert.equal(b.tracker.isAddingTo(DIR), true);
    assert.equal(b.tracker.isAddingTo(DIR, URL2), false);
    assert.equal(b.tracker.isAddingTo('/Music/Daft Punk/', URL1), false);
    b.tracker.dismiss(out.job.id);
    await settle();
    assert.equal(a.job(out.job.id).hidden, true);
    assert.equal(a.tracker.isAddingTo(DIR, URL1), true);
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    assert.equal(b.tracker.isAddingTo(DIR, URL1), false);
    w.done();
  });

  test('jobsUnder: open jobs and unseen failures in the folder on screen or below it', async () => {
    const w = world();
    const a = w.tab('a');
    const here = await a.tracker.add(req());
    const below = await a.tracker.add(req({ url: URL2, directory: '/Music/Daft Punk/Discovery/Bonus/' }));
    const beside = await a.tracker.add(req({ url: URL3, directory: '/Music/Daft Punk/Discovery Live/' }));
    w.server.fail(below.job.serverId, 'too-big', 'the download passed the 500 MB size cap and was stopped');
    await w.clock.advance(3000);
    assert.deepEqual(a.tracker.jobsUnder('Music/Daft Punk/Discovery/').map((j) => j.id), [below.job.id, here.job.id]);
    assert.deepEqual(a.tracker.jobsUnder('/Music/').map((j) => j.id).sort(), [here.job.id, below.job.id, beside.job.id].sort());
    a.tracker.markSeen();
    assert.deepEqual(a.tracker.jobsUnder(DIR).map((j) => j.id), [here.job.id]);
    w.done();
  });

  test('lists: Adding and Needs a look, newest first, hidden rows out', async () => {
    const w = world();
    const a = w.tab('a');
    const one = await a.tracker.add(req());
    const two = await a.tracker.add(req({ url: URL2 }));
    w.server.fail(one.job.serverId, null, '');
    await w.clock.advance(3000);
    assert.deepEqual(a.tracker.lists().adding.map((j) => j.id), [two.job.id]);
    assert.deepEqual(a.tracker.lists().needsLook.map((j) => j.id), [one.job.id]);
    assert.deepEqual(row(a.job(one.job.id)).status, { key: 'ytdl.row.failedServer' });
    a.tracker.hide(two.job.id);
    assert.deepEqual(a.tracker.lists().adding, []);
    w.done();
  });
});

describe('retry and dismiss', () => {
  test('Try again is a new add in the row’s place; the old server id is never claimed again', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    w.server.fail(out.job.serverId, null, 'HTTP Error 403: Forbidden');
    await w.clock.advance(3000);
    const next = await a.tracker.retry(a.job(out.job.id));
    assert.equal(next.ok, true);
    assert.equal(next.job.serverId, 'srv-2');
    assert.equal(a.tracker.get(out.job.id), null);
    assert.deepEqual(a.tracker.jobs().map((j) => j.id), [next.job.id]);
    assert.deepEqual(w.stored().retired, ['srv-1']);
    assert.equal(w.server.posts(), 2);
    assert.deepEqual(w.server.calls.filter((c) => c.method === 'POST').map((c) => c.body), [
      Y.addRequest({ url: URL1, directory: DIR, codec: 'mp3', fields: req().metadata }),
      Y.addRequest({ url: URL1, directory: DIR, codec: 'mp3', fields: req().metadata }),
    ]);
    // A retry of an open row does nothing.
    assert.equal((await a.tracker.retry(next.job)).ok, false);
    assert.equal(w.server.posts(), 2);
    w.done();
  });

  test('Change format and retry sends the new format; Add again re-sends a Not found add', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    w.server.fail(out.job.serverId, 'exists', 'a file named One_More_Time.mp3 already exists in Music/Daft Punk/Discovery — nothing was replaced');
    await w.clock.advance(3000);
    const failed = a.job(out.job.id);
    assert.deepEqual(row(failed, { formats: ['mp3', 'm4a'] }), {
      section: 'needsLook', tone: 'error', status: { key: 'ytdl.reason.exists', params: { name: 'One_More_Time.mp3' } }, actions: ['changeFormat', 'dismiss'],
    });
    assert.deepEqual(row(failed, { formats: ['mp3'] }).actions, ['dismiss']);
    const next = await a.tracker.retry(failed, { codec: 'm4a' });
    assert.equal(w.server.calls.filter((c) => c.method === 'POST').pop().body.outputCodec, 'm4a');
    assert.equal(next.job.codec, 'm4a');
    w.server.restart();
    await w.clock.advance(3000);
    assert.equal(a.job(next.job.id).state, 'notFound');
    const again = await a.tracker.retry(next.job.id);
    assert.equal(again.ok, true);
    assert.equal(w.server.posts(), 3);
    w.done();
  });

  test('a retried start failure makes its folder again; a failed download’s retry does not', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onMkdir = () => { throw httpError(500, { error: 'EIO' }); };
    const out = await a.tracker.add(req({ mkdir: true, mkdirFolder: 'Discovery', inline: false }));
    assert.equal(out.job.state, 'startFailed');
    assert.deepEqual(row(out.job).actions, ['retry', 'chooseFolder', 'dismiss']);
    assert.deepEqual(row(out.job).status, { key: 'ytdl.err.mkdir', params: { folder: 'Discovery' } });
    w.server.onMkdir = null;
    const next = await a.tracker.retry(out.job);
    assert.equal(next.ok, true);
    assert.equal(w.server.mkdirs().length, 2);
    w.server.fail(next.job.serverId, null, 'boom');
    await w.clock.advance(3000);
    await a.tracker.retry(next.job.id);
    assert.equal(w.server.mkdirs().length, 2);
    w.done();
  });

  test('a retry the server refuses (a 409 included) stays a row: the user is looking at it', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    w.server.fail(out.job.serverId, null, 'boom');
    await w.clock.advance(3000);
    w.server.onPost = () => { throw httpError(409, { error: 'x', reason: 'exists', fileName: 'One_More_Time.m4a' }); };
    const next = await a.tracker.retry(out.job.id, { codec: 'm4a' });
    assert.equal(next.job.state, 'startFailed');
    assert.deepEqual(row(next.job).status, { key: 'ytdl.err.exists', params: { name: 'One_More_Time.m4a' } });
    w.server.onPost = () => { throw netError(); };
    const unsure = await a.tracker.retry(next.job.id);
    assert.equal(unsure.unsure, true);
    assert.deepEqual(row(unsure.job, { now: w.clock.now() }).status, { key: 'ytdl.row.startUnsure' });
    w.done();
  });

  test('dismiss: a settled row goes; an open one is hidden and still followed to the end', async () => {
    const w = world();
    const a = w.tab('a');
    const out = await a.tracker.add(req());
    a.tracker.dismiss(out.job.id);
    assert.equal(a.job(out.job.id).hidden, true);
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'added');
    a.tracker.dismiss(out.job);
    assert.equal(a.job(out.job.id), null);
    a.tracker.dismiss('nothing');
    w.done();
  });
});

describe('Added', () => {
  test('the record (plugin=ytdl) merged with this browser’s jobs by record id: one row per song, File missing kept', async () => {
    const w = world();
    const a = w.tab('a');
    w.clock.now();
    w.server.record({ title: 'Aerodynamic', filepath: 'Music/Daft Punk/Discovery/Aerodynamic.mp3', downloadedAt: T0 - 2 * HOUR });   // 57
    w.server.record({ title: 'Digital Love', filepath: 'Music/Daft Punk/Digital_Love.mp3', present: false, downloadedAt: T0 - HOUR });   // 58
    w.server.record({ plugin: 'youtube', title: 'Not ours', downloadedAt: T0 - HOUR });                                                // 59
    const out = await a.tracker.add(req());
    w.server.complete(out.job.serverId);                                                                                               // 60
    await w.clock.advance(3000);
    // A song whose record could not be written still shows, from the job.
    const lonely = await a.tracker.add(req({ url: URL2, title: 'Around the World' }));
    w.server.complete(lonely.job.serverId, { downloadId: null, fileName: 'Around_the_World.mp3' });
    w.server.records = w.server.records.filter((r) => r.origin !== URL2);
    await w.clock.advance(3000);
    const view = await a.tracker.loadAdded();
    assert.ok(w.server.recordReads().pop().path.startsWith('api/v1/discovery/downloads?plugin=ytdl&limit=20'));
    assert.deepEqual(view.rows.map((r) => [r.key, r.title, r.missing]), [
      [`job:${lonely.job.id}`, 'Around the World', false],
      ['record:60', 'One More Time', false],
      ['record:58', 'Digital Love', true],
      ['record:57', 'Aerodynamic', false],
    ]);
    const mine = view.rows[1];
    assert.deepEqual([mine.jobId, mine.cover, mine.filepath, mine.ext, mine.crumbs, mine.bytes, mine.trackId], [
      out.job.id, 'https://i.ytimg.com/vi/x/hq.jpg', 'Music/Daft Punk/Discovery/One_More_Time.mp3', 'mp3', ['Music', 'Daft Punk', 'Discovery'], 8808038, 1060,
    ]);
    assert.deepEqual([view.rows[0].filepath, view.rows[0].recordId, view.rows[0].present], ['Music/Daft Punk/Discovery/Around_the_World.mp3', null, true]);
    assert.equal(view.loaded, true);
    assert.equal(view.canShowEarlier, false);
    assert.deepEqual(a.tracker.addedView().rows.map((r) => r.key), view.rows.map((r) => r.key));
    w.done();
  });

  test('a song that lands after the read stands in, then its record takes over (the list re-reads on its own)', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    await b.tracker.loadAdded();
    const out = await a.tracker.add(req());
    w.server.complete(out.job.serverId);
    await w.clock.advance(3000);
    const keys = b.tracker.addedView().rows.map((r) => r.key);
    assert.deepEqual(keys, ['record:57']);
    assert.ok(b.events.some((e) => e.type === 'added'));
    w.done();
  });

  test('a job whose record a read went past without it (removed in Downloads) shows no row', async () => {
    const w = world();
    w.seed([stored({ id: 'gone', state: 'added', downloadId: 70, filePath: 'Music/x.mp3', endedAt: T0 - HOUR })]);
    w.server.record({ downloadedAt: T0 - 3 * HOUR });
    const a = w.tab('a', { visible: false });
    assert.deepEqual(a.tracker.addedView().rows.map((r) => r.key), ['job:gone']);
    const view = await a.tracker.loadAdded();
    assert.deepEqual(view.rows.map((r) => r.key), ['record:57']);
    w.done();
  });

  test('Show earlier pages with before = the last id until a short page; a failed read keeps the rows', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) { w.server.record({ downloadedAt: T0 - (10 - i) * MIN }); }   // 57..61, 61 newest
    const a = w.tab('a', { visible: false });
    let view = await a.tracker.loadAdded({ limit: 2 });
    assert.deepEqual(view.rows.map((r) => r.recordId), [61, 60]);
    assert.equal(view.canShowEarlier, true);
    view = await a.tracker.loadAdded({ limit: 2, before: view.cursor });
    assert.ok(w.server.recordReads().pop().path.endsWith('&before=60'));
    assert.deepEqual(view.rows.map((r) => r.recordId), [61, 60, 59, 58]);
    w.server.onRecords = () => { throw netError(); };
    view = await a.tracker.loadAdded({ limit: 2, before: view.cursor });
    assert.equal(view.failed, true);
    assert.deepEqual(view.rows.map((r) => r.recordId), [61, 60, 59, 58]);
    w.server.onRecords = null;
    view = await a.tracker.loadAdded({ limit: 2, before: view.cursor });
    assert.deepEqual(view.rows.map((r) => r.recordId), [61, 60, 59, 58, 57]);
    assert.equal(view.canShowEarlier, false);
    // Reading the first page again keeps what Show earlier brought below it.
    w.server.record({ downloadedAt: T0 });                                                   // 62
    view = await a.tracker.loadAdded({ limit: 2 });
    assert.deepEqual(view.rows.map((r) => r.recordId), [62, 61, 60, 59, 58, 57]);
    w.done();
  });
});

describe('rows and toasts', () => {
  const NOW = T0 + 10 * MIN;
  test('an Adding row: Starting…, the unsure start, minutes and the format', () => {
    assert.deepEqual(row({ state: 'starting', createdAt: NOW, codec: 'mp3' }, { now: NOW }), { section: 'adding', tone: 'busy', status: { key: 'discover.job.starting' }, actions: [] });
    assert.deepEqual(row({ state: 'adding', createdAt: NOW - 20000, codec: 'mp3' }, { now: NOW }).status, { key: 'ytdl.row.adding', params: { count: 1, format: 'MP3' } });
    assert.deepEqual(row({ state: 'adding', createdAt: NOW - 150000, codec: 'opus' }, { now: NOW }), {
      section: 'adding', tone: 'busy', status: { key: 'ytdl.row.adding', params: { count: 2, format: 'Opus' } }, actions: ['hide'],
    });
    assert.equal(EN['discover.job.starting'], 'Starting…');
  });

  test('a Needs a look row from a start failure reads as ytdl-core’s row line', () => {
    const f = (problem, detail) => ({ problem, detail: detail || null, reason: null, text: null, phase: 'start' });
    assert.deepEqual(row({ state: 'startFailed', failure: f('unreachable'), codec: 'mp3' }), { section: 'needsLook', tone: 'error', status: { key: 'ytdl.row.didntStart' }, actions: ['retry', 'dismiss'] });
    assert.deepEqual(row({ state: 'startFailed', failure: f('mkdirOff', 'Discovery') }).actions, ['topOfLibrary', 'chooseFolder', 'dismiss']);
    assert.deepEqual(row({ state: 'startFailed', failure: f('badFormat'), codec: 'opus' }).status, { key: 'ytdl.err.formatOff', params: { format: 'Opus' } });
    assert.deepEqual(row({ state: 'startFailed', failure: f('libraryGone', 'Music') }), { section: 'needsLook', tone: 'error', status: { key: 'ytdl.err.libraryGoneShort', params: { library: 'Music' } }, actions: ['dismiss'] });
    // A failed row with nothing stored about why.
    assert.deepEqual(row({ state: 'failed', failure: null }).status, { key: 'ytdl.row.failedServer' });
    assert.deepEqual(row({ state: 'added' }), { section: 'added', tone: 'ok', status: null, actions: [] });
    assert.equal(row({ state: 'nonsense' }), null);
    assert.equal(J.jobRow(null), null);
  });

  test('the toast’s path: the folders below the library, the library for its top, cut at the start past two', () => {
    const t = (over) => toast({ state: 'added', title: 'One More Time', directory: DIR, crumbs: [], ...over });
    assert.equal(t({ filePath: 'Music/One_More_Time.mp3' }).params.path, '⁨Music⁩');
    assert.equal(t({ filePath: 'Music/Daft Punk/One_More_Time.mp3' }).params.path, '⁨Daft Punk⁩');
    assert.equal(t({ filePath: 'Music/Electronic/Daft Punk/Discovery/One_More_Time.mp3' }).params.path, '… › ⁨Daft Punk⁩ › ⁨Discovery⁩');
    assert.equal(t({ crumbs: ['Music', 'Daft Punk', 'Homework'] }).params.path, '⁨Daft Punk⁩ › ⁨Homework⁩');
    assert.equal(t({ crumbs: [], directory: '/Music/' }).params.path, '⁨Music⁩');
    assert.equal(t({ title: '', fileName: 'One_More_Time.mp3' }).params.title, 'One_More_Time.mp3');
    assert.deepEqual(toast({ state: 'startFailed', title: 'Around the World' }), { key: 'ytdl.toast.couldntAdd', params: { title: 'Around the World' } });
    assert.equal(J.toastLabel({ state: 'notFound' }), null);
  });

  test('i18n: every key in KEYS is emitted by some case here, and every key emitted is in KEYS or ytdl-core’s', () => {
    for (const k of J.KEYS) { assert.ok(EMITTED.has(k), `${k} is in KEYS but no case returned it`); }
    const known = new Set([...J.KEYS, ...Y.KEYS]);
    for (const k of EMITTED) { assert.ok(known.has(k), `${k} was returned but is in neither KEYS`); }
    // The module's source names no key outside KEYS.
    const src = fs.readFileSync(path.join(ROOT, 'webapp/alpha/ytdl-jobs.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(/label\('([a-z][\w.]*)'/g)) { assert.ok(J.KEYS.includes(m[1]), m[1]); }
  });
});

describe('events', () => {
  test('subscribe → unsubscribe; a listener that throws doesn’t stop the others', async () => {
    const w = world();
    const a = w.tab('a');
    const seen = [];
    a.tracker.subscribe(() => { throw new Error('bug'); });
    const off = a.tracker.subscribe((e) => seen.push(e.type));
    await a.tracker.add(req());
    assert.ok(seen.includes('jobs'));
    off();
    const n = seen.length;
    a.tracker.markSeen();
    await a.tracker.add(req({ url: URL2 }));
    assert.equal(seen.length, n);
    assert.equal(typeof a.tracker.subscribe(null), 'function');
    w.done();
  });
});

describe('races, clocks and a page that stops', () => {
  test('a read that went out before a 200 was answered does not call that new job gone', async () => {
    const w = world();
    const a = w.tab('a');
    await a.tracker.add(req({ url: URL2 }));                                          // srv-1: something to poll
    // The next read leaves before the add reaches the server and lands after
    // its 200 (a slow answer, or another tab's add).
    const gate = deferred();
    w.server.onList = () => {
      w.server.onList = null;
      const snap = { downloads: w.server.jobs.map((j) => ({ ...j })) };
      return gate.promise.then(() => snap);
    };
    await w.clock.advance(3000);
    const out = await a.tracker.add(req());                                           // srv-2, not in that read
    gate.resolve();
    await settle();
    assert.equal(a.job(out.job.id).state, 'adding');
    assert.equal(w.server.recordReads().length, 0);
    await w.clock.advance(3000);
    assert.deepEqual([a.job(out.job.id).state, a.job(out.job.id).serverId], ['adding', 'srv-2']);
    // A read that leaves after the id was known still finds it gone.
    w.server.restart();
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'notFound');
    w.done();
  });

  test('a 200 that lands after its own job was claimed by link and folder wins over that claim', async () => {
    const w = world();
    const a = w.tab('a');
    const answer = deferred();
    w.server.onPost = (body) => { const j = w.server.start(body); return answer.promise.then(() => ({ message: 'Download started', id: j.id, fileName: j.fileName })); };
    const p = a.tracker.add(req());                                                   // srv-1, its answer held
    await w.clock.advance(1000);
    w.server.start({ url: URL1, directory: DIR });                                    // srv-2: the phone's, newer
    // A duplicated tab carries the same tab id: it takes the add for one a
    // reload cut off, and claims the newest entry for its link and folder.
    const dup = w.tab('dup', { tabId: 'a' });
    await settle();
    assert.deepEqual([dup.job(dup.tracker.jobs()[0].id).serverId, dup.tracker.jobs()[0].claim], ['srv-2', 'match']);
    answer.resolve();
    const out = await p;
    assert.equal(out.ok, true);
    assert.deepEqual([out.job.state, out.job.serverId, out.job.claim], ['adding', 'srv-1', 'post']);
    w.server.complete('srv-1');
    await w.clock.advance(3000);
    assert.equal(a.job(out.job.id).state, 'added');
    w.done();

    // The same, answered with a refusal: nothing of this add started, so the
    // phone's entry is not its row's (kept here: the surface has gone).
    const w2 = world();
    const b = w2.tab('b');
    const refuse = deferred();
    w2.server.onPost = () => refuse.promise;
    const p2 = b.tracker.add(req({ inline: false }));
    await w2.clock.advance(1000);
    w2.server.start({ url: URL1, directory: DIR });                                   // srv-1: the phone's
    const dup2 = w2.tab('dup', { tabId: 'b' });
    await settle();
    assert.equal(dup2.tracker.jobs()[0].serverId, 'srv-1');
    refuse.reject(httpError(409, { error: 'x', reason: 'exists', fileName: 'One_More_Time.mp3' }));
    const out2 = await p2;
    assert.deepEqual([out2.ok, out2.failure.problem], [false, 'exists']);
    const kept = b.job(out2.job.id);
    assert.deepEqual([kept.state, kept.serverId, kept.claim], ['startFailed', null, null]);
    w2.done();
  });

  test('a clock that jumps back an hour: the poll goes on, a lost POST still gives up, another tab’s cut-off add is still looked for', async () => {
    const w = world();
    const a = w.tab('a');
    await a.tracker.add(req());
    await w.clock.advance(3000);
    const n = w.server.lists();
    w.clock.jump(-HOUR);
    await w.clock.advance(9000);
    assert.ok(w.server.lists() >= n + 2, `${w.server.lists() - n} reads in 9 s after the jump`);
    w.done();

    const w2 = world();
    const b = w2.tab('b');
    w2.server.onPost = () => { throw netError(); };
    const lost = await b.tracker.add(req());
    w2.clock.jump(-HOUR);
    await w2.clock.advance(J.CLAIM_WINDOW_MS + 6000);
    assert.equal(b.job(lost.job.id).state, 'notSureStarted');
    w2.done();

    // Pressed in a tab that crashed, an hour "ahead" of the clock now.
    const w3 = world();
    w3.seed([stored({ id: 'cut', state: 'starting', tab: 'z', createdAt: T0 + HOUR, sentAt: T0 + HOUR, endedAt: null, seen: false, toast: null })]);
    const c = w3.tab('c');
    await w3.clock.advance(3000);
    assert.notEqual(c.job('cut').state, 'starting');
    w3.done();
  });

  test('a stopped tracker (sign-out) toasts and tells nothing more; the tab’s next tracker toasts what it left', async () => {
    const w = world();
    const a = w.tab('a');
    const answer = deferred();
    w.server.onPost = () => answer.promise;
    const p = a.tracker.add(req({ inline: false }));
    await settle();
    a.tracker.stop();
    const n = a.events.length;
    answer.reject(httpError(500, { error: 'Server Error' }));
    const out = await p;
    assert.equal(out.job.state, 'startFailed');
    assert.equal(a.toasts.length, 0);
    assert.equal(a.events.length, n);
    assert.equal(w.stored().jobs[0].toast, 'pending');
    const again = w.tab('a2', { tabId: 'a' });
    assert.deepEqual(again.toasts.map((j) => j.id), [out.job.id]);
    w.done();
  });

  test('watching: what landed while the tab was hidden is seen once it is shown again', async () => {
    const w = world();
    const a = w.tab('a');
    const b = w.tab('b');
    const out = await a.tracker.add(req());
    a.tracker.watch(true);
    a.hide();
    w.server.fail(out.job.serverId, 'live', 'it is a live stream, which is not downloaded');
    await w.clock.advance(6000);
    assert.ok(w.server.lists('b') >= 1);
    assert.equal(a.job(out.job.id).state, 'failed');
    assert.equal(a.tracker.summary().kind, 'failed');
    a.show();
    await settle();
    assert.equal(a.tracker.summary().kind, null);
    assert.equal(b.tracker.summary().kind, null);
    w.done();
  });

  test('storage that starts throwing on reads keeps what this page already had', async () => {
    const w = world();
    w.seed([stored({ id: 'old-1' }), stored({ id: 'old-2', createdAt: T0 - 2 * MIN })]);
    const real = w.browser.storageFor({});
    let broken = false;
    const flaky = {
      getItem: (k) => { if (broken) { throw new Error('SecurityError'); } return real.getItem(k); },
      setItem: (k, v) => { if (broken) { throw new Error('SecurityError'); } real.setItem(k, v); },
      removeItem: (k) => real.removeItem(k),
    };
    const a = w.tab('a', { storage: flaky, visible: false });
    assert.equal(a.tracker.jobs().length, 2);
    broken = true;
    const out = await a.tracker.add(req());
    assert.equal(out.ok, true);
    assert.deepEqual(a.tracker.jobs().map((j) => j.id).sort(), [out.job.id, 'old-1', 'old-2'].sort());
    assert.equal(a.tracker.status().stored, false);
    w.done();
  });

  test('an inline check that throws keeps the refusal as a row: the add still resolves', async () => {
    const w = world();
    const a = w.tab('a');
    w.server.onPost = () => { throw httpError(500, { error: 'Server Error' }); };
    const out = await a.tracker.add(req({ inline: () => { throw new Error('the surface is gone'); } }));
    assert.deepEqual([out.ok, out.unsure, out.failure.problem, out.job.state], [false, false, 'serverError', 'startFailed']);
    w.done();
  });
});

describe('fetchRequest', () => {
  test('throws as api.js req() does, so ytdl-core reads the same shapes', async () => {
    const calls = [];
    // A Response's json(): a promise of the body, or of a parse error.
    const body = (v) => () => Promise.resolve(v);
    const unparsable = (msg) => () => Promise.reject(new SyntaxError(msg));
    const fetchStub = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/refused')) { return Promise.resolve({ ok: false, status: 409, json: body({ error: 'x', reason: 'exists', fileName: 'a.mp3' }) }); }
      if (url.endsWith('/html')) { return Promise.resolve({ ok: false, status: 502, json: unparsable('Unexpected token <') }); }
      if (url.endsWith('/junk')) { return Promise.resolve({ ok: true, status: 200, json: unparsable('Unexpected end of JSON input') }); }
      if (url.endsWith('/down')) { return Promise.reject(new TypeError('Failed to fetch')); }
      return Promise.resolve({ ok: true, status: 200, json: body({ id: 'srv-1' }) });
    };
    let token = 'tok-1';
    const request = J.fetchRequest({ fetch: fetchStub, host: () => 'http://h/', token: () => token });
    const ctrl = new AbortController();
    assert.deepEqual(await request('POST', 'api/v1/ytdl/', { url: URL1 }, { signal: ctrl.signal }), { id: 'srv-1' });
    assert.equal(calls[0].url, 'http://h/api/v1/ytdl/');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', 'x-access-token': 'tok-1' });
    assert.equal(calls[0].init.body, JSON.stringify({ url: URL1 }));
    assert.equal(calls[0].init.signal, ctrl.signal);
    token = 'tok-2';
    await request('GET', 'api/v1/ytdl/downloads');
    assert.equal(calls[1].init.headers['x-access-token'], 'tok-2');
    assert.equal(calls[1].init.body, undefined);
    const errOf = (p) => p.then(() => null, (e) => e);
    const refused = await errOf(request('POST', 'refused', {}));
    assert.deepEqual([refused.status, refused.body], [409, { error: 'x', reason: 'exists', fileName: 'a.mp3' }]);
    assert.equal(Y.classifyAdd(refused).problem, 'exists');
    const html = await errOf(request('POST', 'html', {}));
    assert.deepEqual([html.status, html.body], [502, null]);
    assert.deepEqual([Y.classifyAdd(html).problem, Y.classifyAdd(html).detail], ['other', 'HTTP 502']);
    const junk = await errOf(request('POST', 'junk', {}));
    assert.equal(junk.name, 'SyntaxError');
    assert.equal(Y.classifyAdd(junk).problem, 'startUnsure');
    const down = await errOf(request('POST', 'down', {}));
    assert.equal(down.name, 'TypeError');
    assert.equal(Y.classifyAdd(down).problem, 'startUnsure');
  });
});
