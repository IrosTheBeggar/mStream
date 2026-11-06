/*
 * Flow ordering, the client half — pure logic shared by the webapp's two
 * flow actions (m.js): "Add All In Flow Order" in the browse bar and the
 * Now Playing bar's Flow (remaining songs / whole queue).
 *
 * The server half is POST /api/v1/db/flow (src/api/flow.js): it takes 2–1000
 * vpath paths and answers with a permutation of their INDICES. A queue can
 * hold songs from several servers (federated peers), and each server orders
 * only its own, so this module:
 *   - groups the songs by server (the playing / last song's server first,
 *     then the larger groups),
 *   - calls each server once, in turn, through the caller's `call` — a peer
 *     through this server's browse proxy — and joins each run onto the one
 *     before it (the previous answer's `end` passed as the next `after`),
 *   - puts whatever could not be flowed at the tail, in list order: every
 *     run's unplaced and unanalysed songs, a chunk's overflow past 1000
 *     songs, a refusing peer's songs and unsendable paths,
 *   - and, once the answer lands, matches it back onto a queue that may
 *     have moved meanwhile (mergeAnswer).
 *
 * No DOM, no fetch, no player: UI-free like auto-dj.js, so the node unit
 * tests run it as is (test/unit/webapp-queue-flow.test.mjs).
 *
 * Browser: defines `window.QUEUEFLOW`.
 * Node (tests): exports the same namespace via CommonJS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUEUEFLOW = factory();
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // The route's caps (src/api/flow.js): songs per call and path length.
  const MAX_SONGS = 1000;
  const MAX_PATH = 4096;
  // Under the server's default 1 MB maxRequestSize, with room to spare.
  const MAX_BODY_BYTES = 900 * 1024;
  // What `after` accepts (the route's Joi schema).
  const BPM_MIN = 20;
  const BPM_MAX = 300;
  const KEY_MAX = 32;
  const MODEL_ID_MAX = 200;
  const VECTOR_MAX = 65536;
  // Per call. The peer proxy gives up at 15 s, and a busy server holds up to
  // four waiters at about a second each before it answers 429.
  const TIMEOUT_MS = 20000;

  function cleanBpm(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; }
    const n = Number(v);
    return Number.isFinite(n) && n >= BPM_MIN && n <= BPM_MAX ? n : null;
  }

  function cleanKey(v) {
    if (typeof v !== 'string') { return null; }
    const k = v.trim();
    return k.length >= 1 && k.length <= KEY_MAX ? k : null;
  }

  // One song to flow. `server` is null for this server, else the peer id;
  // `path` the RAW vpath (never the %-escaped queue `filepath`) without its
  // leading slash; `bpm`/`key` from the row's metadata, kept only where the
  // route's `after` would accept them.
  function item(server, path, meta) {
    let p = typeof path === 'string' ? path : '';
    if (p.charAt(0) === '/') { p = p.slice(1); }
    const m = meta && typeof meta === 'object' ? meta : {};
    return {
      server: server === null || server === undefined ? null : Number(server),
      path: p,
      bpm: cleanBpm(m.bpm),
      key: cleanKey(m['musical-key']),
    };
  }

  // The `after` a song makes for the run that follows it.
  function afterOf(it) {
    if (!it || (it.bpm == null && it.key == null)) { return null; }
    return { bpm: it.bpm, key: it.key };
  }

  function sendable(it) {
    return !!it && typeof it.path === 'string' && it.path.length >= 1 && it.path.length <= MAX_PATH;
  }

  function utf8Bytes(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) { n += 1; } else if (c < 0x800) { n += 2; } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length
        && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else { n += 3; }
    }
    return n;
  }

  // A path's share of the JSON body: its escaped string plus the comma.
  function jsonBytes(s) { return utf8Bytes(JSON.stringify(s)) + 1; }

  // A previous run's `end`, made safe for the next server's strict schema:
  // only the members `after` takes, each validated; null when nothing is left.
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
  function afterFromEnd(end) {
    if (!end || typeof end !== 'object') { return null; }
    const out = {};
    if (typeof end.vector === 'string' && typeof end.modelId === 'string'
      && end.vector.length > 0 && end.vector.length <= VECTOR_MAX && end.vector.length % 4 === 0 && BASE64.test(end.vector)
      && end.modelId.length > 0 && end.modelId.length <= MODEL_ID_MAX) {
      out.vector = end.vector;
      out.modelId = end.modelId;
    }
    const bpm = cleanBpm(end.bpm);
    if (bpm != null) { out.bpm = bpm; }
    const key = cleanKey(end.key);
    if (key != null) { out.key = key; }
    return Object.keys(out).length ? out : null;
  }

  // Items grouped by server in first-appearance order: the lead's server
  // first, then the rest by size (largest first; ties keep first appearance).
  function groupByServer(items, leadServer) {
    const byKey = new Map();
    const groups = [];
    items.forEach((it, i) => {
      const k = it.server === null ? 'local' : `p${it.server}`;
      let g = byKey.get(k);
      if (!g) { g = { server: it.server, ids: [], first: groups.length }; byKey.set(k, g); groups.push(g); }
      g.ids.push(i);
    });
    groups.sort((a, b) => {
      const la = leadServer !== undefined && a.server === leadServer ? 1 : 0;
      const lb = leadServer !== undefined && b.server === leadServer ? 1 : 0;
      if (la !== lb) { return lb - la; }
      if (a.ids.length !== b.ids.length) { return b.ids.length - a.ids.length; }
      return a.first - b.first;
    });
    return groups.map((g) => ({ server: g.server, ids: g.ids }));
  }

  // The leading ids that fit one call: at most `maxSongs`, and no more bytes
  // than the body budget left after `usedBytes`.
  function cutChunk(ids, items, maxSongs, usedBytes) {
    let bytes = usedBytes;
    let n = 0;
    while (n < ids.length && n < maxSongs) {
      const b = jsonBytes(items[ids[n]].path);
      if (bytes + b > MAX_BODY_BYTES) { break; }
      bytes += b;
      n++;
    }
    return { sent: ids.slice(0, n), rest: ids.slice(n) };
  }

  // An answer for `n` songs, or null when it isn't one: `order` must be a
  // permutation of 0..n−1 that starts with the pinned song when there is one.
  function readAnswer(a, n, pin) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.order) || a.order.length !== n) { return null; }
    const seen = new Uint8Array(n);
    for (const k of a.order) {
      if (!Number.isInteger(k) || k < 0 || k >= n || seen[k]) { return null; }
      seen[k] = 1;
    }
    if (pin && a.order[0] !== 0) { return null; }
    const unflowed = new Set();
    for (const list of [a.unplaced, a.unanalysed]) {
      if (!Array.isArray(list)) { continue; }
      for (const k of list) { if (Number.isInteger(k) && k >= 0 && k < n) { unflowed.add(k); } }
    }
    const signals = !!(a.signals && typeof a.signals === 'object'
      && Object.keys(a.signals).some((k) => a.signals[k] === true));
    return { order: a.order, unflowed, signals, end: a.end };
  }

  // Run `call` against a timer that aborts it.
  function callWithTimeout(call, server, body, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (ctrl) { ctrl.abort(); }
        const err = new Error('flow timed out');
        err.timeout = true;
        reject(err);
      }, timeoutMs);
    });
    const work = Promise.resolve().then(() => call(server, body, ctrl ? ctrl.signal : undefined));
    return Promise.race([work, timeout]).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    );
  }

  /**
   * Flow `items` (from item()), one call per server, joined into one order.
   * opts: lead — the song they follow (the playing song, or the queue's last
   *         one): pinned as `start` when its server's run comes first, else
   *         its BPM / key become the first run's `after`. Never in `order`.
   *       call(server, body, signal) → Promise<answer>, rejecting with
   *         `err.status` on an HTTP error.
   *       canFlow(server) → false skips the call; its songs go to the tail.
   *       timeoutMs — per call.
   * → { order (a permutation of the item indices, or null when failed),
   *     failed, error, calls (answers used), signals (any run had one),
   *     refused (peer ids that answered 403/404) }
   */
  async function flowRuns(items, opts) {
    const o = opts || {};
    const lead = o.lead || null;
    const call = o.call;
    const canFlow = typeof o.canFlow === 'function' ? o.canFlow : () => true;
    const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : TIMEOUT_MS;
    const out = { order: [], failed: false, error: null, calls: 0, signals: false, refused: [] };
    const tail = [];
    const fail = (error) => Object.assign(out, { order: null, failed: true, error: error || new Error('flow failed') });

    const groups = groupByServer(items, lead ? lead.server : undefined);
    let joinFrom = lead ? afterOf(lead) : null;

    for (let g = 0; g < groups.length; g++) {
      const server = groups[g].server;
      const more = g < groups.length - 1;
      if (!canFlow(server)) { tail.push(...groups[g].ids); continue; }
      const ok = [];
      for (const id of groups[g].ids) { (sendable(items[id]) ? ok : tail).push(id); }

      const pin = !!(lead && g === 0 && lead.server === server && sendable(lead));
      const base = { songs: [] };
      if (pin) { base.start = 0; } else if (joinFrom) { base.after = joinFrom; }
      if (more) { base.returnEnd = true; }
      const used = utf8Bytes(JSON.stringify(base)) + (pin ? jsonBytes(lead.path) : 0);
      const { sent, rest } = cutChunk(ok, items, MAX_SONGS - (pin ? 1 : 0), used);
      tail.push(...rest);

      // Nothing to choose between: the song is placed as it is.
      if (sent.length < 2) {
        for (const id of sent) { out.order.push(id); joinFrom = afterOf(items[id]) || joinFrom; }
        continue;
      }

      const body = Object.assign({}, base, {
        songs: (pin ? [lead.path] : []).concat(sent.map((id) => items[id].path)),
      });
      let raw;
      try {
        raw = await callWithTimeout(call, server, body, timeoutMs);
      } catch (err) {
        const status = err && err.status;
        if (server !== null && (status === 403 || status === 404)) {
          // A peer without the route (or gone): its songs wait at the tail.
          out.refused.push(server);
          tail.push(...sent);
          continue;
        }
        return fail(err);
      }
      const a = readAnswer(raw, body.songs.length, pin);
      if (!a) { return fail(new Error('malformed flow answer')); }

      let last = null;
      for (const k of a.order) {
        if (pin && k === 0) { continue; }
        const id = sent[k - (pin ? 1 : 0)];
        if (a.unflowed.has(k)) { tail.push(id); } else { out.order.push(id); last = id; }
      }
      out.calls++;
      out.signals = out.signals || a.signals;
      joinFrom = afterFromEnd(a.end) || (last !== null ? afterOf(items[last]) : null) || joinFrom;
    }

    tail.sort((x, y) => x - y);
    out.order = out.order.concat(tail);
    return out;
  }

  function currentOf(playlist, pos) {
    return Number.isInteger(pos) && pos >= 0 && pos < playlist.length ? playlist[pos] : null;
  }

  // What Flow reorders. 'remaining': the songs after the playing one;
  // 'whole': every song but the playing one (which then leads), the upcoming
  // ones first and the played ones after them, so a queue past the 999-song
  // cap flows what is still to come and its overflow keeps that order. With
  // nothing playing both are the whole queue, unpinned.
  function queueSubject(playlist, pos, mode) {
    const current = currentOf(playlist, pos);
    if (!current) { return { mode: 'whole', current: null, subject: playlist.slice() }; }
    if (mode === 'remaining') { return { mode: 'remaining', current, subject: playlist.slice(pos + 1) }; }
    return { mode: 'whole', current, subject: playlist.slice(pos + 1).concat(playlist.slice(0, pos)) };
  }

  /**
   * Match an answer back onto the queue as it is now. Rows are matched by
   * identity (each queue row is its own object, duplicate paths included).
   * `plan` is what queueSubject returned when the request went out, `flowed`
   * its subject in the answer's order. Rows removed meanwhile are skipped;
   * rows added meanwhile follow the flowed ones in queue order. Returns the
   * new row array (always a permutation of `live`), or null when the queue
   * moved in a way the answer no longer fits: the playing song changed in
   * whole mode, went backwards or left the queue in remaining mode.
   */
  function mergeAnswer(live, nowCurrent, plan, flowed) {
    if (new Set(live).size !== live.length) { return null; }
    const subject = new Set(plan.subject);
    let prefixEnd;   // live[0..prefixEnd) stays as it is
    if (plan.mode === 'remaining') {
      if (!plan.current || !nowCurrent) { return null; }
      if (nowCurrent !== plan.current && !subject.has(nowCurrent)) { return null; }
      prefixEnd = live.indexOf(nowCurrent) + 1;
      if (prefixEnd === 0) { return null; }
    } else if (plan.current) {
      const inLive = new Set(live);
      if (nowCurrent !== plan.current || !inLive.has(plan.current)) { return null; }
      const out = [plan.current];
      const done = new Set(out);
      for (const r of flowed) { if (!done.has(r) && inLive.has(r)) { out.push(r); done.add(r); } }
      for (const r of live) { if (!done.has(r)) { out.push(r); done.add(r); } }
      return out;
    } else {
      if (nowCurrent !== null) { return null; }
      prefixEnd = 0;
    }
    const out = live.slice(0, prefixEnd);
    const after = new Set(live.slice(prefixEnd));
    const done = new Set();
    for (const r of flowed) { if (after.has(r) && !done.has(r)) { out.push(r); done.add(r); } }
    for (let i = prefixEnd; i < live.length; i++) { if (!done.has(live[i])) { out.push(live[i]); } }
    return out;
  }

  function sameOrder(a, b) {
    if (!a || !b || a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
    return true;
  }

  return {
    MAX_SONGS,
    TIMEOUT_MS,
    item,
    afterOf,
    currentOf,
    queueSubject,
    flowRuns,
    mergeAnswer,
    sameOrder,
    _internals: {
      groupByServer, cutChunk, readAnswer, afterFromEnd, utf8Bytes, sendable, callWithTimeout,
      MAX_SONGS, MAX_PATH, MAX_BODY_BYTES, BPM_MIN, BPM_MAX, KEY_MAX, TIMEOUT_MS,
    },
  };
}));
