// What the clients draw for the P2P discovery network — the PURE half of
// GET /api/v1/discovery/p2p/peers and of the taste route's network-lead
// stamping. Everything arrives as an argument (the shelf registry, the
// catalog, the blocklist, seeder counts, Add states, the clock); nothing here
// touches disk, network, config or the sidecar.
//
//   peerLabels      endpointId -> display label over the whole universe
//                   (catalog ∪ shelf, minus blocked). The taste route labels
//                   its leads from the same map, so the peer strip and a
//                   lead's "● label" always agree
//   peerHue         a peer's colour, straight from its endpoint id
//   peerMonogram    the badge the web and phone strips draw for a peer
//   leadTile        { key, hue, letter }: the generated tile of a lead that
//                   has no album art (metadata-only snapshots never do)
//   buildPeerView   the whole peers-route body
//
// The server stamps all of it and clients draw it verbatim: three client
// implementations of the tile once disagreed on the key fold, the title
// fallback and the letter casing. The vectors every client is held to live
// in test/fixtures/peer-recs-tiles.json. A label can change under a client
// (a newly announced twin suffixes both), so clients key every state on
// endpointId, never on the label.

import { nameKey } from '../db/name-key.js';
import { modelCompatible, ONLINE_WINDOW_MS } from './discovery-peer-rotation.js';

// The announcement default (config.js discoveryP2p.serverName). Every server
// that kept it looks alike by name, so its label always carries the id.
const DEFAULT_NAME = 'mStream';

// Unheld catalog peers the route offers an admin at most. The public mesh
// can announce hundreds; the strip only needs the most useful few.
export const MAX_ADDABLE_ROWS = 24;

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
// The id suffix peerLabels appends; peerMonogram strips it again.
const ID_SUFFIX = / · [0-9a-f]{4,6}$/;

// Two names are the same peer name when they match case-insensitively after
// NFKC (fullwidth and compatibility forms, composed vs decomposed accents).
function nameFold(name) {
  return name.normalize('NFKC').toLowerCase();
}

// Upper-case one scalar only when the result is still one scalar: 'é' -> 'É',
// but 'ß' stays 'ß' (its upper case is 'SS').
function upperScalar(ch) {
  const upper = ch.toUpperCase();
  return [...upper].length === 1 ? upper : ch;
}

function compareIds(a, b) {
  if (a < b) { return -1; }
  return a > b ? 1 : 0;
}

// endpointId -> label for every peer in the universe: catalog ∪ shelf,
// minus blocked. A peer's name is its latest announced one, else the name
// its snapshot was fetched under, else none.
//
//   - the base is the trimmed name, or 'mStream' when there is none;
//   - ' · ' + 4 hex of the id is appended when the base is the default name
//     (any case), or when two or more peers in the universe share the base
//     (case-insensitive, NFKC) — every twin is suffixed, each keeping its own
//     spelling, including twins the caller is not shown;
//   - a suffixed label that still collides with another label (ids sharing
//     their first 4 hex, or a name spelled like a suffixed label) widens to
//     6 hex.
//
//   shelf      peer-dbs list() registry entries ({ endpointId, name, ... })
//   catalog    discovery-catalog list() entries ({ from, payload: { name } })
//   isBlocked  injected lookup (pure-testable)
export function peerLabels({ shelf = [], catalog = [], isBlocked = () => false } = {}) {
  const names = new Map();
  for (const entry of shelf) {
    if (!isBlocked(entry.endpointId)) { names.set(entry.endpointId, entry.name || ''); }
  }
  for (const entry of catalog) {
    if (!isBlocked(entry.from)) {
      names.set(entry.from, entry.payload?.name || names.get(entry.from) || '');
    }
  }

  const bases = new Map();
  const sharing = new Map();
  for (const [id, name] of names) {
    const base = name.trim() || DEFAULT_NAME;
    bases.set(id, base);
    const fold = nameFold(base);
    sharing.set(fold, (sharing.get(fold) || 0) + 1);
  }

  const labels = new Map();
  const suffixed = [];
  const defaultFold = nameFold(DEFAULT_NAME);
  for (const [id, base] of bases) {
    const fold = nameFold(base);
    if (fold === defaultFold || sharing.get(fold) > 1) {
      labels.set(id, `${base} · ${id.slice(0, 4)}`);
      suffixed.push(id);
    } else {
      labels.set(id, base);
    }
  }

  const taken = new Map();
  for (const label of labels.values()) {
    const fold = nameFold(label);
    taken.set(fold, (taken.get(fold) || 0) + 1);
  }
  for (const id of suffixed) {
    if (taken.get(nameFold(labels.get(id))) > 1) {
      labels.set(id, `${bases.get(id)} · ${id.slice(0, 6)}`);
    }
  }
  return labels;
}

// Endpoint ids are ed25519 keys, so their leading bits are uniform.
export function peerHue(endpointId) {
  const n = parseInt(String(endpointId).slice(0, 6), 16);
  return Number.isNaN(n) ? 0 : n % 360;
}

// The badge for a peer label: its id suffix dropped, then
//   - two or more words: the first letter-or-number of words 1 and 2,
//     upper-cased ('Basement Hi-Fi' -> 'BH');
//   - one word: its first two letters-or-numbers as written
//     ('mStream · 3f9a' -> 'mS'), upper-cased when it has only one ('x' -> 'X');
//   - no word with a letter or number in it: '' (the client draws none).
// Words split on whitespace and keep only their \p{L}/\p{N} scalars.
export function peerMonogram(label) {
  const base = String(label ?? '').replace(ID_SUFFIX, '').trim() || DEFAULT_NAME;
  const words = base.split(/\s+/)
    .map((word) => [...word].filter((ch) => LETTER_OR_NUMBER.test(ch)))
    .filter((scalars) => scalars.length > 0);
  if (words.length === 0) { return ''; }
  if (words.length === 1) {
    const [scalars] = words;
    return scalars.length === 1 ? upperScalar(scalars[0]) : scalars[0] + scalars[1];
  }
  return upperScalar(words[0][0]) + upperScalar(words[1][0]);
}

const utf8 = new TextEncoder();

// FNV-1a, 32-bit, over the string's UTF-8 bytes. Exported for tests.
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// The generated tile of one lead.
//   key     nameKey(artist)|nameKey(album) when both are non-empty, else
//           whichever is, else nameKey(title). Every lead of one album
//           shares it, so art a preview earns for one spreads to the rest
//   hue     FNV-1a-32(key) % 360; clients derive the colours from it
//   letter  the first letter-or-number of the artist, else of the title,
//           else ''; upper-cased only when that stays one scalar ('ß' stays)
export function leadTile({ artist, album, title } = {}) {
  const artistKey = nameKey(artist);
  const albumKey = nameKey(album);
  const key = artistKey && albumKey
    ? `${artistKey}|${albumKey}`
    : (artistKey || albumKey || nameKey(title));
  return { key, hue: fnv1a32(key) % 360, letter: tileLetter(artist, title) };
}

function tileLetter(artist, title) {
  for (const text of [artist, title]) {
    const match = String(text ?? '').trim().match(LETTER_OR_NUMBER);
    if (match) { return upperScalar(match[0]); }
  }
  return '';
}

// An Add state as the wire carries it: the adder's bookkeeping (who pressed
// it) never leaves the server, and `at` is always an ISO string.
function wireAddState(add) {
  if (!add) { return null; }
  return {
    state: add.state,
    code: add.code ?? null,
    at: typeof add.at === 'number' ? new Date(add.at).toISOString() : (add.at ?? null),
  };
}

// The peers-route body: `{ canAdd, shelf: { held, searchable, running }, peers }`.
//
//   shelf          peer-dbs list() registry entries ({ endpointId, name,
//                  modelId, rowCount, pinned, ... })
//   catalog        discovery-catalog list() entries ({ from, updatedAt,
//                  payload: { name, hash, rowCount, modelId, ... } })
//   localModel     active embedding model id, or null when none established
//                  (no compatibility signal; everyone passes)
//   now / onlineWindowMs   a peer is online when its last announcement is
//                  younger than the window
//   isBlocked / seederCountOf (snapshot hash -> live holders) /
//   addStateOf (endpointId -> { state, code, at } | null)   injected lookups
//   canAdd         caller-scoped, computed by the route (admin, not
//                  lockAdmin, inside the admin IP gate)
//   running        whether the p2p stack is up (reported, not used here)
//
// Rows, each { endpointId, name, label, monogram, hue, online, onShelf,
// pinned, rowCount, add }:
//   - shelf rows: every held snapshot that is not blocked and is searchable
//     in the local model space (a held incompatible snapshot gives no leads,
//     so it is hidden; `held` still counts it), ordered online first, then
//     by label, then by id;
//   - addable rows, only when canAdd: catalog peers not held, not blocked,
//     model-compatible, and online or carrying an Add state (a row being
//     added does not vanish when its peer drops), ordered by seeders, then
//     library size, then id, at most MAX_ADDABLE_ROWS of them.
// An Add state never reorders a row, so a pressed row does not jump; when
// the cap bites, rows carrying a state are kept first, for the same reason.
// Members get no addable rows and `add: null` everywhere.
export function buildPeerView({
  shelf = [], catalog = [], localModel = null,
  now = Date.now(), onlineWindowMs = ONLINE_WINDOW_MS,
  isBlocked = () => false, seederCountOf = () => 0, addStateOf = () => null,
  canAdd = false, running = false,
} = {}) {
  const labels = peerLabels({ shelf, catalog, isBlocked });
  const catalogById = new Map(catalog.map((entry) => [entry.from, entry]));
  const isOnline = (id) => {
    const entry = catalogById.get(id);
    return Boolean(entry) && now - Date.parse(entry.updatedAt) < onlineWindowMs;
  };
  // Each peer's Add state is read once per build: states expire on read, so
  // a second read could keep a row for its state and then draw it without.
  const addStates = new Map();
  const addOf = (id) => {
    if (canAdd !== true) { return null; }
    if (!addStates.has(id)) { addStates.set(id, wireAddState(addStateOf(id))); }
    return addStates.get(id);
  };
  const row = (id, name, { onShelf, pinned, rowCount }) => {
    const label = labels.get(id);
    return {
      endpointId: id,
      name,
      label,
      monogram: peerMonogram(label),
      hue: peerHue(id),
      online: isOnline(id),
      onShelf,
      pinned,
      rowCount,
      add: addOf(id),
    };
  };

  const unblocked = shelf.filter((entry) => !isBlocked(entry.endpointId));
  const shelfRows = unblocked
    .filter((entry) => modelCompatible(entry, localModel))
    .map((entry) => row(
      entry.endpointId,
      catalogById.get(entry.endpointId)?.payload?.name || entry.name || '',
      { onShelf: true, pinned: entry.pinned === true, rowCount: entry.rowCount || 0 },
    ))
    .sort((a, b) => (Number(b.online) - Number(a.online))
      || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
      || compareIds(a.endpointId, b.endpointId));

  let addableRows = [];
  if (canAdd === true) {
    const held = new Set(shelf.map((entry) => entry.endpointId));
    const hasState = (entry) => addOf(entry.from) !== null;
    const candidates = catalog.filter((entry) => !held.has(entry.from)
      && !isBlocked(entry.from)
      && modelCompatible(entry.payload, localModel)
      && (isOnline(entry.from) || hasState(entry)));
    const seeders = new Map(candidates.map((entry) => [entry.from, seederCountOf(entry.payload.hash || '')]));
    candidates.sort((a, b) => (seeders.get(b.from) - seeders.get(a.from))
      || ((b.payload.rowCount || 0) - (a.payload.rowCount || 0))
      || compareIds(a.from, b.from));
    const kept = new Set([
      ...candidates.filter(hasState),
      ...candidates.filter((entry) => !hasState(entry)),
    ].slice(0, MAX_ADDABLE_ROWS));
    addableRows = candidates
      .filter((entry) => kept.has(entry))
      .map((entry) => row(entry.from, entry.payload.name || '', {
        onShelf: false, pinned: false, rowCount: entry.payload.rowCount || 0,
      }));
  }

  return {
    canAdd: canAdd === true,
    shelf: { held: unblocked.length, searchable: shelfRows.length, running: running === true },
    peers: [...shelfRows, ...addableRows],
  };
}
