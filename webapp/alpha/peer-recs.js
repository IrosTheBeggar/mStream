// The Peer Recommendations page's pure helpers (docs/peer-recommendations-plan.md
// §4.1 W2, the shared spec in §5): the peer strip as items (All, the shelf
// peers, an admin's addable peers and their Add states), how often the strip
// polls GET /api/v1/discovery/p2p/peers, what an Add's answer means for the
// strip, when an Add has landed (the re-ask rule R4), which plug-in previews
// and how long a 429 waits, when a preview's artwork may stand in for a
// lead's tile, the lead key, the next lead Preview all plays, the Copy and
// Copy list text, the window's peer line, and the tile and circle colours.
// No DOM, no Vue, no fetch, no storage — m.js (the page) and vp.js (the
// clip, the window) wire it to the app; the unit test
// (test/unit/webapp-peer-recs.test.mjs) drives it on node and holds it to
// the server's own answers. Same UMD shape as alpha/discovery-page.js.
//
// What the server stamps is drawn verbatim and never computed here: a
// lead's tile ({ key, hue, letter }), a peer's label, monogram and hue, and
// a preview's attribution. Every state is keyed on endpointId, never on a
// label (a newly announced twin can change one).
//
// Text never leaves here as English: labels are i18n KEYS with their params
// ({ key, params }) and the caller translates. Peer labels and lead titles
// travel as plain strings and must still go through escapeHtml when drawn.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.PEERRECS = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  // ── constants ──────────────────────────────────────────────────────────
  // R6: the strip polls every 15 s, every 3 s while a row it shows is being
  // added or one of this page's own Adds is still out.
  const POLL_MS = 15000;
  const POLL_FAST_MS = 3000;
  // §5.5: the wait before the one retry of a preview's 429 — the providers'
  // own limiters (deezer 40 calls / 5 s, itunes 18 / min, server-wide).
  const RETRY_MS = Object.freeze({ deezer: 5000, itunes: 60000 });
  const RETRY_DEFAULT_MS = 5000;
  // The plug-in capability that plays a 30 s clip.
  const PREVIEW_CAPABILITY = 'preview';
  // Endpoint ids are ed25519 keys as 64 lower-case hex; anything else never
  // reaches a data-v attribute or a request (the page checks a clicked
  // item's data-v with isEndpointId before it selects or Adds).
  const ENDPOINT_ID = /^[0-9a-f]{64}$/;
  const isEndpointId = (v) => typeof v === 'string' && ENDPOINT_ID.test(v);

  // ── small helpers ──────────────────────────────────────────────────────
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');
  const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const lbl = (key, params) => ({ key, params: params || {} });

  // A raw lead from a view row ({ raw }, discovery-page.js networkRows) or
  // the raw lead itself.
  const leadOf = (row) => (isObj(row) && isObj(row.raw) ? row.raw : row);

  // Membership in a Set, an array or an object's own keys.
  function has(set, key) {
    if (set instanceof Set) { return set.has(key); }
    if (Array.isArray(set)) { return set.indexOf(key) !== -1; }
    return isObj(set) && Object.prototype.hasOwnProperty.call(set, key);
  }
  function keysOf(set) {
    if (set instanceof Set || Array.isArray(set)) { return Array.from(set); }
    return isObj(set) ? Object.keys(set) : [];
  }

  // src/db/name-key.js, mirrored byte for byte (the unit test holds it to
  // the server's): the fold the server built every tile key with, so a
  // preview's album and artist compare the way the tiles were spread.
  function nameKey(raw) {
    if (raw == null) { return ''; }
    return String(raw).replace(/\s+/g, ' ').trim()
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/[‐‑‒–—―−]/g, '-')
      .toLowerCase();
  }

  // ── colours ────────────────────────────────────────────────────────────
  // A server-stamped hue (a lead's tile.hue, a peer row's hue) as an integer
  // 0–359; anything else is 0. Safe in an inline style.
  function hueOf(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) { return 0; }
    return ((Math.round(v) % 360) + 360) % 360;
  }

  // The colours drawn from one hue (§5.1, the web board):
  //   field / ink       a generated tile's background and letter
  //   circle            a shelf peer's strip circle while online (its
  //                     monogram is drawn dark on it)
  //   circleDim / inkDim  the same peer offline, dimmed
  //   circleAdding      an addable peer's circle while it is being added
  function tileColours(hue) {
    const h = hueOf(hue);
    return {
      hue: h,
      field: `hsl(${h}, 22%, 24%)`,
      ink: `hsl(${h}, 30%, 72%)`,
      circle: `hsl(${h}, 55%, 74%)`,
      circleDim: `hsl(${h}, 18%, 30%)`,
      inkDim: `hsl(${h}, 25%, 82%)`,
      circleAdding: `hsla(${h}, 55%, 74%, .35)`,
    };
  }

  // ── the peer strip ─────────────────────────────────────────────────────
  // A peers-route row's label, verbatim; its name only if a server ever
  // sent none.
  const labelOf = (row) => (hasText(row.label) ? row.label : str(row.name).trim());

  // The local Add states the strip draws before the server has said so (a
  // press, or an answer that stored nothing): 'adding' from the press until
  // the next poll, 'failed' ("Try again") after a 400 / 5xx / no answer,
  // 'noRoom' after a 200 failed no-room.
  const LOCAL_STATES = ['adding', 'failed', 'noRoom'];

  // A local entry stands until a poll SENT after it answers. `entry.poll` is
  // how many polls the page had sent when the entry was set (stamp it at the
  // press and again when the POST answers); `poll` is the number the answer's
  // own poll was sent as. Without `poll` every entry stands.
  function localStands(entry, poll) {
    if (!isObj(entry) || LOCAL_STATES.indexOf(entry.state) === -1) { return false; }
    return !(Number.isInteger(poll) && Number.isInteger(entry.poll) && poll > entry.poll);
  }

  // An addable row's state, from the server's Add state (§5.6):
  //   none          '+'           act 'add'
  //   adding        'Adding…'     inert
  //   done          'Adding…'     inert — it lands as a shelf row on the
  //                               next poll
  //   failed no-room 'No room'    inert (the server clears it when the
  //                               shelf or a pin changes)
  //   failed, any other code  'Try again'  act 'add'
  function serverAddState(add) {
    if (!isObj(add)) { return null; }
    if (add.state === 'adding' || add.state === 'done') { return 'adding'; }
    if (add.state === 'failed') { return add.code === 'no-room' ? 'noRoom' : 'failed'; }
    return null;
  }

  const ADD_TEXT = { adding: 'peerRecs.adding', failed: 'peerRecs.tryAgain', noRoom: 'peerRecs.noRoom' };
  const ADD_ARIA = { adding: 'peerRecs.a11y.adding', failed: 'peerRecs.a11y.failed', noRoom: 'peerRecs.a11y.noRoom' };

  // GET /api/v1/discovery/p2p/peers as the strip draws it.
  //   answer    the route's body ({ canAdd, shelf, peers }); null while the
  //             first poll is out (the strip is All alone)
  //   selected  the selected peer's endpointId; null = All
  //   local     { [endpointId]: { state, poll } }, the page's own Add
  //             states (localStands)
  //   poll      the number the answer's poll was sent as
  // → { items, selected, fallback, local }
  //   items     All, then the shelf peers in the server's order (online
  //             first), then — only when canAdd — the addable peers in the
  //             server's order:
  //             { kind: 'all' | 'peer' | 'add', id, label, monogram, hue,
  //               online, selected, state, act, text, aria }
  //               state  null | 'adding' | 'failed' | 'noRoom' (add items)
  //               act    'tab' (select), 'add' (POST the Add) or null (inert)
  //               text   the state's visible label key ('All' on All)
  //               aria   an add item's aria-label key with { name }; a peer
  //                      item's aria-label is its label
  //   selected  the selection to keep: null when the selected peer left the
  //             shelf (fallback: true — R5, select All and re-ask)
  //   local     the entries that still stand, for the caller to keep
  function stripItems(answer, opts) {
    const o = isObj(opts) ? opts : {};
    const want = o.selected == null ? null : o.selected;
    const local = isObj(o.local) ? o.local : {};
    const all = (on) => ({
      kind: 'all', id: null, label: '', monogram: '', hue: 0, online: false,
      selected: on, state: null, act: 'tab', text: lbl('peerRecs.all'), aria: null,
    });
    if (!isObj(answer)) {
      return { items: [all(want === null)], selected: want, fallback: false, local: Object.assign({}, local) };
    }

    const seen = new Set();
    const shelf = [];
    const addable = [];
    for (const row of arr(answer.peers)) {
      if (!isObj(row) || !isEndpointId(row.endpointId)) { continue; }
      if (seen.has(row.endpointId)) { continue; }
      seen.add(row.endpointId);
      if (row.onShelf === true) { shelf.push(row); }
      else if (answer.canAdd === true) { addable.push(row); }
    }

    const fallback = want !== null && !shelf.some((row) => row.endpointId === want);
    const selected = fallback ? null : want;
    const kept = {};
    const base = (row, kind) => ({
      kind,
      id: row.endpointId,
      label: labelOf(row),
      monogram: str(row.monogram),
      hue: hueOf(row.hue),
      online: row.online === true,
    });

    const items = [all(selected === null)];
    for (const row of shelf) {
      items.push(Object.assign(base(row, 'peer'), {
        selected: row.endpointId === selected, state: null, act: 'tab', text: null, aria: null,
      }));
    }
    for (const row of addable) {
      const mine = local[row.endpointId];
      let state;
      if (localStands(mine, o.poll)) {
        kept[row.endpointId] = mine;
        state = mine.state;
      } else {
        state = serverAddState(row.add);
      }
      const item = base(row, 'add');
      items.push(Object.assign(item, {
        selected: false,
        state,
        act: state === null || state === 'failed' ? 'add' : null,
        text: state ? lbl(ADD_TEXT[state]) : null,
        aria: lbl(state ? ADD_ARIA[state] : 'peerRecs.a11y.add', { name: item.label }),
      }));
    }
    return { items, selected, fallback, local: kept };
  }

  // R6: the wait before the next poll. `items` = stripItems(...).items;
  // `posting` = this page's own Add POSTs still out (a count or a boolean).
  function pollDelay(items, posting) {
    if (posting === true || (typeof posting === 'number' && posting > 0)) { return POLL_FAST_MS; }
    return arr(items).some((item) => isObj(item) && item.state === 'adding') ? POLL_FAST_MS : POLL_MS;
  }

  // ── Add ────────────────────────────────────────────────────────────────
  // What POST /api/v1/admin/discovery/p2p/peer-dbs/add's answer means for
  // the strip (§5.6 "Answer handling"). `status` 0 = no answer (a transport
  // failure); `body` = the parsed JSON or null. Only codes are read; the
  // server's words are never drawn.
  // → { outcome, local, pollNow }
  //   outcome  'adding' | 'landed' | 'noRoom' | 'failed' | 'gone' | 'notAllowed'
  //   local    the local state to set until the next poll ('adding' |
  //            'failed' | 'noRoom'), or null = drop the local state
  //   pollNow  poll at once rather than on the cadence
  //
  //   202                     adding    the server keeps 'adding' until it
  //                                     lands or fails
  //   200 done                landed    already on the shelf: drawn as
  //                                     "Adding…" until the poll it asks for
  //                                     shows the shelf row, and landed()
  //                                     on that poll re-asks (R4)
  //   200 failed no-room      noRoom    inert
  //   200 failed, other code  failed    "Try again"
  //   404 / 409               gone      the peer left the catalog, or is
  //                                     blocked / incompatible: the row goes
  //   403 / 405               notAllowed  not an admin here (any more), or
  //                                     p2p off: canAdd comes back false
  //   400 / 5xx / 0 / other   failed    "Try again", the server stored nothing
  function addOutcome(status, body) {
    const b = isObj(body) ? body : {};
    if (status === 202) { return { outcome: 'adding', local: 'adding', pollNow: false }; }
    if (status === 200 && b.state === 'done') { return { outcome: 'landed', local: 'adding', pollNow: true }; }
    if (status === 200 && b.state === 'adding') { return { outcome: 'adding', local: 'adding', pollNow: false }; }
    if (status === 200 && b.state === 'failed' && b.code === 'no-room') {
      return { outcome: 'noRoom', local: 'noRoom', pollNow: false };
    }
    if (status === 404 || status === 409) { return { outcome: 'gone', local: null, pollNow: true }; }
    if (status === 403 || status === 405) { return { outcome: 'notAllowed', local: null, pollNow: true }; }
    return { outcome: 'failed', local: 'failed', pollNow: false };
  }

  // A peers-route row by endpointId.
  function rowsById(answer) {
    const out = new Map();
    if (!isObj(answer)) { return out; }
    for (const row of arr(answer.peers)) {
      if (isObj(row) && typeof row.endpointId === 'string' && !out.has(row.endpointId)) { out.set(row.endpointId, row); }
    }
    return out;
  }
  const isHeld = (row) => isObj(row) && (row.onShelf === true || (isObj(row.add) && row.add.state === 'done'));
  const isFailed = (row) => isObj(row) && isObj(row.add) && row.add.state === 'failed';
  const searchableOf = (answer) => (isObj(answer) && isObj(answer.shelf)
    && Number.isInteger(answer.shelf.searchable) ? answer.shelf.searchable : 0);

  // R4, between two peers answers (`prev` the one the strip was drawn from,
  // null before the first; `next` the new one):
  //   - an id this page POSTed (`posted`: a Set, an array or an object's
  //     keys) is now on the shelf, or its Add state is done, and was not in
  //     `prev`;
  //   - or the page shows "No peers yet" (`showingNoPeers`) and
  //     shelf.searchable went from 0 to more.
  // Then the current tab is re-asked, pinned to the batch. An Add by
  // another client or a rotation swap only changes the strip.
  // → { reask, ids, failed }
  //   ids     the posted ids that landed (the caller stops tracking them)
  //   failed  the posted ids whose Add has just failed (the same)
  function landed(prev, next, posted, showingNoPeers) {
    const out = { reask: false, ids: [], failed: [] };
    if (!isObj(next)) { return out; }
    const before = rowsById(prev);
    const after = rowsById(next);
    for (const id of keysOf(posted)) {
      const was = before.get(id);
      const now = after.get(id);
      if (isHeld(now) && !isHeld(was)) { out.ids.push(id); }
      else if (isFailed(now) && !isFailed(was)) { out.failed.push(id); }
    }
    const grew = searchableOf(prev) === 0 && searchableOf(next) > 0;
    out.reask = out.ids.length > 0 || (showingNoPeers === true && grew);
    return out;
  }

  // ── preview ────────────────────────────────────────────────────────────
  // The one plug-in that previews (§2 item 12): the first in the listing's
  // order (GET /api/v1/discovery/plugins `plugins`) whose capabilities
  // include 'preview'. There is no second: a miss is "No preview". → that
  // listing entry, or null.
  function previewProvider(list) {
    for (const p of arr(list)) {
      if (isObj(p) && hasText(p.name) && arr(p.capabilities).indexOf(PREVIEW_CAPABILITY) !== -1) { return p; }
    }
    return null;
  }

  // §5.5: how long a 429 waits before its one retry.
  function retryDelayMs(name) {
    return Object.prototype.hasOwnProperty.call(RETRY_MS, name) ? RETRY_MS[name] : RETRY_DEFAULT_MS;
  }

  function isHttps(url) {
    if (!hasText(url)) { return false; }
    try { return new URL(url).protocol === 'https:'; } catch (_) { return false; }
  }

  // §2 item 10: a resolved preview's artwork stands in for the tile of
  // every row sharing the lead's tile.key only when it is https and the
  // preview found the lead's own album — nameKey-equal album (the lead's
  // non-empty) AND artist. Otherwise nothing changes, anywhere.
  function artMatches(raw, preview) {
    const lead = leadOf(raw);
    if (!isObj(lead) || !isObj(preview) || !isHttps(preview.artwork)) { return false; }
    const album = nameKey(lead.album);
    return album !== '' && nameKey(preview.album) === album && nameKey(preview.artist) === nameKey(lead.artist);
  }

  // §5.3: one lead, across answers and tabs — the live clip, the visit's
  // "No preview" set, the window it is open in. The peer's endpointId and
  // the snapshot's exportId; without an exportId, the folded artist, title
  // and album. (Earned art is keyed on tile.key, not on this.)
  function leadKey(raw) {
    const lead = leadOf(raw);
    if (!isObj(lead)) { return ''; }
    const id = isObj(lead.peer) ? str(lead.peer.endpointId) : '';
    const exportId = lead.exportId;
    if ((typeof exportId === 'string' && exportId !== '') || (typeof exportId === 'number' && Number.isFinite(exportId))) {
      return id + '\u0000' + String(exportId);
    }
    return id + '\u0000' + [nameKey(lead.artist), nameKey(lead.title), nameKey(lead.album)].join('|');
  }

  // Preview all's next lead: the first row after `index` (-1 = from the
  // top) whose lead key is not in `skip` (the visit's "No preview" keys: a
  // Set, an array or an object's keys). → its index, or -1 = the end.
  function nextIndex(list, index, skip) {
    const rows = arr(list);
    const from = Number.isInteger(index) && index >= 0 ? index + 1 : 0;
    for (let i = from; i < rows.length; i++) {
      const lead = leadOf(rows[i]);
      if (isObj(lead) && !has(skip, leadKey(lead))) { return i; }
    }
    return -1;
  }

  // ── copy ───────────────────────────────────────────────────────────────
  // §5.7: "Artist - Title", or the title alone when there is no artist.
  function copyText(raw) {
    const lead = leadOf(raw);
    if (!isObj(lead)) { return ''; }
    const artist = str(lead.artist).trim();
    const title = str(lead.title).trim();
    if (!artist) { return title; }
    return title ? `${artist} - ${title}` : artist;
  }

  // Copy list: the tab's leads in list order, one line each, no trailing
  // newline.
  function copyListText(list) {
    return arr(list).map(copyText).filter((line) => line !== '').join('\n');
  }

  // ── the window's peer line ─────────────────────────────────────────────
  // "● label" under a lead's title: the label the server stamped on the
  // lead (else the strip's for that endpointId, else the peer's name), and
  // the dot only when the last peers answer has that endpointId online.
  // → { endpointId, label, online }, or null when there is nothing to name.
  function peerLine(raw, peersAnswer) {
    const lead = leadOf(raw);
    const peer = isObj(lead) && isObj(lead.peer) ? lead.peer : null;
    if (!peer) { return null; }
    const id = str(peer.endpointId);
    const row = id ? rowsById(peersAnswer).get(id) : undefined;
    const label = hasText(peer.label) ? peer.label
      : (isObj(row) && hasText(row.label) ? row.label : str(peer.name).trim());
    if (!label) { return null; }
    return { endpointId: id, label, online: isObj(row) && row.online === true };
  }

  return {
    POLL_MS, POLL_FAST_MS, RETRY_MS, RETRY_DEFAULT_MS, PREVIEW_CAPABILITY,
    nameKey, hueOf, tileColours, isEndpointId,
    stripItems, pollDelay, addOutcome, landed,
    previewProvider, retryDelayMs, artMatches, leadKey, nextIndex,
    copyText, copyListText, peerLine,
  };
}));
