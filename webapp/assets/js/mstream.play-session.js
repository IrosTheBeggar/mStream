// Play sessions for the Stats API v2 — what the web player reports.
//
// The player used to fire scrobble-by-filepath 30 seconds into a track, so
// every web play in the listening log was 30 seconds long and "stopped",
// and a peer's track never counted at all. This is the replacement: one
// session per song start, folded from the player's own signals (position
// ticks, pause and resume, the end of the stream, the user moving on), and
// posted to POST /api/v1/stats/plays once the play is over — the server
// decides whether it counts. The 30-second timer stays for a server without
// the Stats API; the player checks the ping's `stats` flag.
//
// Pure: no DOM, no player globals. Storage and the request are injected, so
// test/unit/webapp-play-session.test.mjs drives it on node — the same UMD
// shape as alpha/auto-dj.js. The rules mirror the mobile app's fold:
//   listened time   the sum of forward position deltas while playing; a
//                   jump of more than SEEK_JUMP_S per tick, or backwards, is
//                   a seek and adds nothing
//   pauses          counted on each pause
//   outcome         `completed` when the stream ended, or when the playhead
//                   got within END_SLACK_S of a known length before the user
//                   moved on; otherwise what the player says — `skipped`
//                   (moved on) or `stopped` (page closed, playback failed)
//   too short       a session with under MIN_POST_MS listened is dropped —
//                   a mis-click, a failed load — never posted
// The outbox keeps unsent plays in localStorage (OUTBOX_CAP, oldest out)
// and retries; ids are UUIDs, so a retry the server already saw comes back
// as a duplicate and is dropped. The in-flight session is checkpointed
// there too, so a crash or a closed tab still yields a `stopped` play on
// the next load.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.MSTREAMPLAYSESSION = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  const SEEK_JUMP_S = 3;
  const END_SLACK_S = 2;
  const MIN_POST_MS = 1000;
  const OUTBOX_CAP = 500;
  const BATCH_MAX = 200;
  const CLIENT_NAME = 'mstream-webapp';
  const KEYS = Object.freeze({
    outbox: 'mstream-stats-outbox',
    inflight: 'mstream-stats-inflight',
    instance: 'mstream-stats-instance',
    session: 'mstream-stats-session',
  });
  const OUTCOMES = ['completed', 'skipped', 'stopped'];

  // A v4 UUID. crypto.randomUUID needs a secure context, and mStream on a
  // LAN is plain http more often than not.
  function uuid() {
    const c = (typeof crypto !== 'undefined') ? crypto : null;
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

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  // ── The session ───────────────────────────────────────────────────────

  // One song start. `filePath` is the vpath-prefixed path (a peer's own path
  // for a peer track); `peerId` + `track` make it a peer play; `durationMs`
  // may arrive later (withDuration) once the element knows it.
  function createSession(init, now = Date.now()) {
    if (!init || !str(init.filePath)) { throw new TypeError('a session needs a filePath'); }
    return {
      id: str(init.id) || uuid(),
      filePath: init.filePath,
      peerId: Number.isInteger(init.peerId) && init.peerId > 0 ? init.peerId : null,
      track: init.track || null,
      durationMs: Number.isInteger(init.durationMs) && init.durationMs > 0 ? init.durationMs : null,
      source: str(init.source) || 'manual',
      sessionId: str(init.sessionId) || null,
      startedAt: Number.isFinite(init.startedAt) ? init.startedAt : now,
      playedMs: 0,
      pauseCount: 0,
      paused: false,
      lastPos: null,
      maxPos: 0,
      checkpointAt: null,
    };
  }

  // A position report (seconds). Only a forward step small enough to be
  // playback — not a seek — adds listened time, and only while playing.
  function tick(session, positionSec, playing = true) {
    if (!session || !Number.isFinite(positionSec) || positionSec < 0) { return session; }
    if (session.lastPos != null && playing && !session.paused) {
      const delta = positionSec - session.lastPos;
      if (delta > 0 && delta <= SEEK_JUMP_S) { session.playedMs += Math.round(delta * 1000); }
    }
    session.lastPos = positionSec;
    if (positionSec > session.maxPos) { session.maxPos = positionSec; }
    return session;
  }

  function pause(session) {
    if (session && !session.paused) { session.paused = true; session.pauseCount += 1; }
    return session;
  }

  function resume(session) {
    if (session) { session.paused = false; }
    return session;
  }

  function withDuration(session, durationMs) {
    if (session && session.durationMs == null && Number.isInteger(durationMs) && durationMs > 0) {
      session.durationMs = durationMs;
    }
    return session;
  }

  // The outcome the play is stored with. The player's word stands, except
  // that reaching the end of a known length is a completion however the
  // song was left — a skip during the fade-out is not a skip.
  function classify(session, requested) {
    if (requested === 'completed') { return 'completed'; }
    if (session.durationMs != null && session.maxPos * 1000 >= session.durationMs - END_SLACK_S * 1000) {
      return 'completed';
    }
    return OUTCOMES.includes(requested) ? requested : 'stopped';
  }

  // The play as the server takes it, or null when too short to post.
  function finish(session, requested, endedAt = Date.now()) {
    if (!session || !(session.playedMs >= MIN_POST_MS)) { return null; }
    const play = {
      id: session.id,
      filePath: session.filePath,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(Math.max(endedAt, session.startedAt)).toISOString(),
      playedMs: session.playedMs,
      outcome: classify(session, requested),
      source: session.source,
      pauseCount: session.pauseCount,
    };
    if (session.peerId != null) { play.peerId = session.peerId; play.track = session.track || {}; }
    if (session.durationMs != null) { play.durationMs = session.durationMs; }
    if (session.sessionId) { play.sessionId = session.sessionId; }
    return play;
  }

  // What a peer play carries, from the metadata object the player holds:
  // the strings, the length, the canonical hash (audio hash, else file
  // hash), the art file — only what is set.
  function snapshotOf(meta) {
    const m = meta || {};
    const out = {};
    const title = str(m.title);
    const artist = str(m.artist);
    const album = str(m.album);
    if (title) { out.title = title; }
    if (artist) { out.artist = artist; }
    if (album) { out.album = album; }
    const dur = Number(m.duration);
    if (Number.isFinite(dur) && dur > 0) { out.durationMs = Math.round(dur * 1000); }
    const hash = str(m['audio-hash']) || str(m.hash);
    if (hash) { out.hash = hash; }
    const art = str(m['album-art']);
    if (art) { out.artFile = art; }
    return out;
  }

  // One id per tab (sessionStorage), so two tabs of one user are two
  // players to the server's now-playing view.
  let tabId = null;
  function tabSessionId(storage) {
    if (tabId) { return tabId; }
    const s = storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    try {
      tabId = s && s.getItem(KEYS.session);
      if (!tabId) { tabId = uuid(); if (s) { s.setItem(KEYS.session, tabId); } }
    } catch (_) {
      tabId = uuid();
    }
    return tabId;
  }

  // ── The outbox ────────────────────────────────────────────────────────

  // `post(body, opts)` resolves the server's answer ({ accepted,
  // duplicates, rejected }) or throws with `status`. `storage` is a
  // localStorage-shaped object.
  function createOutbox({ storage, post, log, now } = {}) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const clock = typeof now === 'function' ? now : () => Date.now();
    const warn = (log && typeof log.warn === 'function') ? (m) => log.warn(m) : () => {};
    let inflight = null;

    function readList() {
      try {
        const raw = store ? store.getItem(KEYS.outbox) : null;
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (_) { return []; }
    }
    function writeList(list) {
      try { if (store) { store.setItem(KEYS.outbox, JSON.stringify(list)); } }
      catch (_) { /* quota — the play is lost, and nothing else can be done */ }
    }
    function instanceId() {
      try {
        let id = store ? store.getItem(KEYS.instance) : null;
        if (!id) { id = uuid(); if (store) { store.setItem(KEYS.instance, id); } }
        return id;
      } catch (_) { return null; }
    }

    const box = {
      // Queue a play (replacing one with the same id); oldest out past the cap.
      enqueue(play) {
        if (!play || !play.id) { return 0; }
        const list = readList().filter((p) => p && p.id !== play.id);
        list.push(play);
        while (list.length > OUTBOX_CAP) { list.shift(); }
        writeList(list);
        return list.length;
      },
      size() { return readList().length; },
      // Post what is queued, up to BATCH_MAX per call. Every id the server
      // names is settled — accepted, duplicate, or rejected (a rejection
      // means "drop it", by contract). A batch the server calls malformed
      // (400) is dropped too, so a bad play can never wedge the queue;
      // anything else — no network, 5xx, an expired token — stays for the
      // next try. Resolves true when nothing is left waiting. A flush in
      // progress is shared, never doubled.
      flush(opts = {}) {
        if (inflight) { return inflight; }
        const run = async () => {
          const list = readList();
          if (list.length === 0) { return true; }
          const batch = list.slice(0, BATCH_MAX);
          const client = { name: CLIENT_NAME };
          const inst = instanceId();
          if (inst) { client.instanceId = inst; }
          let r;
          try {
            r = await post({ client, plays: batch }, opts);
          } catch (err) {
            if (err && err.status === 400) {
              const ids = new Set(batch.map((p) => p.id));
              writeList(readList().filter((p) => !ids.has(p.id)));
              warn(`[stats] the server refused a batch of ${batch.length} play(s) as malformed; dropped`);
              return readList().length === 0;
            }
            return false;
          }
          const settled = new Set([
            ...(Array.isArray(r?.accepted) ? r.accepted : []),
            ...(Array.isArray(r?.duplicates) ? r.duplicates : []),
            ...(Array.isArray(r?.rejected) ? r.rejected.map((x) => x && x.id) : []),
          ]);
          const rest = readList().filter((p) => !settled.has(p.id));
          writeList(rest);
          return rest.length === 0;
        };
        // The clearing is a promise reaction, never synchronous — an empty
        // box resolves without ever yielding, and a `finally` inside `run`
        // would clear `inflight` BEFORE this assignment, leaving a settled
        // promise in place that every later flush would return unchanged.
        inflight = run().finally(() => { inflight = null; });
        return inflight;
      },
      // The in-flight session, so a crash still yields a play.
      checkpoint(session) {
        if (!session) { return; }
        try { if (store) { store.setItem(KEYS.inflight, JSON.stringify({ ...session, checkpointAt: clock() })); } }
        catch (_) { /* quota */ }
      },
      clearCheckpoint() {
        try { if (store) { store.removeItem(KEYS.inflight); } } catch (_) { /* nothing to clear */ }
      },
      // A session left behind by a closed tab or a crash: what had been
      // listened by the last checkpoint, as a `stopped` play. Queued and
      // returned, or null when there was none (or it was too short).
      recover() {
        let raw = null;
        try { raw = store ? store.getItem(KEYS.inflight) : null; } catch (_) { raw = null; }
        if (!raw) { return null; }
        box.clearCheckpoint();
        let session = null;
        try { session = JSON.parse(raw); } catch (_) { return null; }
        if (!session || !session.id || !session.filePath) { return null; }
        const play = finish(session, 'stopped', session.checkpointAt || clock());
        if (play) { box.enqueue(play); }
        return play;
      },
    };
    return box;
  }

  return {
    SEEK_JUMP_S, END_SLACK_S, MIN_POST_MS, OUTBOX_CAP, BATCH_MAX, CLIENT_NAME, KEYS,
    uuid, createSession, tick, pause, resume, withDuration, classify, finish, snapshotOf, tabSessionId, createOutbox,
  };
}));
