// The Discover page's server half: one call that turns the user's PLAY
// HISTORY into recommendations from three sources (docs/discovery-page-plan.md
// §2, §3.1).
//
//   POST /api/v1/discovery/taste        seeds + library / network / peers
//
// Nothing is remembered between calls: the seeds are a new random batch of
// the user's finished songs every time (a feature — the page shows other
// seeds on every open), and every call computes its answer.
//
// It is an aggregator over what already exists, not a new kind of query:
//   seeds    src/discovery/taste-queries.js (history → counters → random)
//   library  rankTracksMulti over the in-memory index ('max' mode, so a row
//            can say which seed it is "because of"), walked through the same
//            visibility probe as the per-song routes (api/discovery.js)
//   network  the p2p shelf walk (api/discovery-p2p.js searchPeers)
//   peers    the federation fan-out (api/discovery-federation.js)
// Network and peers are asked with ONE vector, the centroid of the seeds:
// the federation responder takes exactly one, and a p2p pass per seed would
// multiply the most expensive walk on the page.
//
// Gates, in the house style: a logged-in ACCOUNT (the stats routes' rule —
// a federation key or a guest token has no history to read; the public-mode
// sentinel has one and passes), never a jukebox session (prefix
// middleware), 403 'Discovery is disabled' while collection is off.
//
// Privacy: the peers fan-out sends every use_discovery peer the centroid of
// the seeds — a random batch of up to 12 songs this user finished in the
// chosen window (all time with window 0), plus any pins: one averaged
// vector, never names, paths or hashes (see the header of
// api/discovery-federation.js).

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import { localIdentitySets } from '../db/discovery-novelty.js';
import { recommendationKey, repairRecommendation, RECOMMENDATION_SOURCES } from '../discovery-plugins/index.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { toIso, toSqlite } from '../stats/time.js';
import {
  renderMetadataObj, toLiteMetadata, libraryFilter, enrichRows, renderMetadataByIds, albumItems, trackQuery,
} from './db.js';
import { requireIndex, resolveSeedTrack, resolveVisible, considerBudget } from './discovery.js';
import { searchPeers } from './discovery-p2p.js';
import { fanOutFederation, recordPeerStatus, loadFederationClient } from './discovery-federation.js';
import { refuseJukebox } from './discovery-plugin-jobs.js';
import { requireAccount } from '../util/require-account.js';
import * as peerDbs from '../state/discovery-peer-dbs.js';
import * as discoveryCatalog from '../state/discovery-catalog.js';
import { peerLabels, leadTile } from '../state/discovery-peer-view.js';
import * as taste from '../discovery/taste-queries.js';

const d = () => db.getDB();

const SOURCES = Object.freeze(['library', 'network', 'peers']);
const DAY_MS = 24 * 60 * 60 * 1000;
// p2p rows are fetched with headroom: the cross-peer recommendationKey
// dedupe runs after the walk, and two peers often hold the same song.
const NETWORK_HEADROOM = 2;
// Failed visibility probes each step of choosing seeds may spend
// (collectSeeds).
const VISIBLE_MISS_CAP = 2 * taste.SEED_CAP * taste.SEED_OVERFETCH;

// ── Validation ───────────────────────────────────────────────────────────

const limitSchema = Joi.object({
  seeds: Joi.number().integer().min(1).max(taste.LIMIT_CAPS.seeds).default(taste.LIMIT_DEFAULTS.seeds),
  tracks: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.tracks).default(taste.LIMIT_DEFAULTS.tracks),
  albums: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.albums).default(taste.LIMIT_DEFAULTS.albums),
  network: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.network).default(taste.LIMIT_DEFAULTS.network),
  // Per peer: the peers section is grouped by server.
  peers: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.peers).default(taste.LIMIT_DEFAULTS.peers),
}).default();

const tasteSchema = Joi.object({
  window: Joi.number().integer().valid(...taste.WINDOWS).default(taste.DEFAULT_WINDOW),
  pin: Joi.array().items(Joi.string().min(1).max(2048)).max(taste.PIN_CAP).default([]),
  // Seed hashes to leave out of THIS call (a client passing over seeds it
  // has shown); never stored.
  exclude: Joi.array().items(Joi.string().min(1).max(taste.HASH_MAX)).max(taste.EXCLUDE_CAP).default([]),
  sources: Joi.array().items(Joi.string().valid(...SOURCES)).unique().default([...SOURCES]),
  limit: limitSchema,
  newArtistsOnly: Joi.boolean().default(false),
  ignoreVPaths: Joi.array().items(Joi.string().max(256)).max(100),
  // Generation 2, the Peer Recommendations page (both ignored without the
  // network source). networkPeers narrows the shelf walk to these peers
  // (a peer tab; absent = the whole shelf, [] is a 400): ids not on the
  // shelf match nothing. networkOnRandomSeed walks the shelf on a random
  // seed too, so a user with no finished songs still gets leads.
  networkPeers: Joi.array().items(Joi.string().hex().length(64).lowercase()).min(1).max(50).unique(),
  networkOnRandomSeed: Joi.boolean().default(false),
});

// ── Seeds ────────────────────────────────────────────────────────────────

const round4 = (x) => Math.round(x * 10000) / 10000;

function seedOut(s) {
  const rendered = renderMetadataObj(s.row);
  return {
    hash: s.hash,
    filepath: rendered.filepath,
    metadata: toLiteMetadata(rendered.metadata),
    outcome: s.outcome ?? null,
    lastPlayed: toIso(s.lastPlayed),
    plays: s.plays ?? null,
    pinned: s.pinned === true,
    analyzed: !!s.entry,
  };
}

// The seed list for this call (plan §2.1–2.3, §2.8). Pins first — explicit
// choices, so they seed whatever the history says and override an
// exclusion — then the widening chain fills the remaining slots:
//   history (window → all time) → counters → [nothing analyzed?] → random.
// The history step is a random batch of the window's finished songs
// (taste-queries historySeeds), so each call seeds from another set.
// Every non-pin seed is ANALYZED and VISIBLE to this caller: a window full
// of songs the worker has not reached widens instead of seeding nothing.
// Only when the user has counted plays and NONE of them is analyzed does
// the answer list them un-analyzed (notAnalyzed: true) — the scan is
// pending, and a random song would misrepresent their taste.
function collectSeeds(req, index, body, ctx) {
  const { uid, filter, libIds, exclusions, windowDays } = ctx;
  const seeds = [];
  const have = new Set();
  let dropped = 0;

  for (const filePath of body.pin) {
    if (seeds.length >= body.limit.seeds) { break; }
    let row;
    try {
      row = resolveSeedTrack(req, filePath, 'discovery/taste');
    } catch (err) {
      // Unknown and forbidden paths are counted alike (no probing signal).
      if (err instanceof WebError && err.status === 404) { dropped++; continue; }
      throw err;
    }
    const hash = row.audio_hash || row.file_hash;
    if (!hash) { dropped++; continue; }
    if (have.has(hash)) { continue; }
    have.add(hash);
    seeds.push({
      hash, row, entry: index.byHash.get(hash) || null, pinned: true,
      outcome: null, lastPlayed: row.last_played ?? null, plays: row.play_count ?? 0,
    });
  }

  const out = { seeds, dropped, seedSource: seeds.length ? 'pinned' : null, window: windowDays, widenedFrom: null, fallback: false, notAnalyzed: false };
  const room = body.limit.seeds - seeds.length;
  if (room <= 0) { return out; }

  // resolveVisible rows met while accepting, so the winners render without
  // a second probe. Each probe is one synchronous query, and the random
  // draw reads every candidate in the window (no LIMIT), so the FAILED
  // probes are capped: a history mostly of songs since deleted stops
  // probing after VISIBLE_MISS_CAP misses (the bound the old newest-first
  // pages had) instead of probing every song it ever played. The cap is
  // per step (probe()) — the history draw and the counters walk, analyzed
  // then pending: one count for the whole call let a long-gone history
  // spend it in the first draw, and every later step then answered "not
  // visible" without asking, so a user with counted plays left got a random
  // seed. A counters walk asks only about songs its own chunked probe found
  // visible, so its cap goes unspent in practice. A call makes at most
  // 4 × VISIBLE_MISS_CAP failed probes (2 × in its history draws), plus one
  // per seed it takes.
  const rows = new Map();
  const probe = () => {
    let misses = 0;
    return (h) => {
      if (!rows.has(h)) {
        if (misses >= VISIBLE_MISS_CAP) { return false; }
        const row = resolveVisible(uid, filter, h, { withGenres: false }) || null;
        if (!row) { misses++; }
        rows.set(h, row);
      }
      return rows.get(h) !== null;
    };
  };
  const analyzedVisible = () => {
    const visible = probe();
    return (h) => index.byHash.has(h) && visible(h);
  };
  // The pending steps take only songs with no vector: every analyzed one
  // was the analyzed steps' to take.
  const pendingVisible = () => {
    const visible = probe();
    return (h) => !index.byHash.has(h) && visible(h);
  };
  const skip = new Set([...exclusions, ...have]);
  const opts = { libIds, exclude: skip, limit: room };
  const take = (list, source) => {
    for (const s of list) {
      seeds.push({
        hash: s.hash, row: rows.get(s.hash), entry: index.byHash.get(s.hash) || null, pinned: false,
        outcome: s.outcome, lastPlayed: s.lastPlayed, plays: s.plays,
      });
    }
    out.seedSource = source;
  };

  const hist = taste.historySeeds(d(), req.user, { ...opts, windowDays, accept: analyzedVisible() });
  out.window = hist.window;
  out.widenedFrom = hist.widenedFrom;
  if (hist.hashes.length) { take(hist.hashes, 'history'); return out; }

  const counters = taste.counterSeeds(d(), req.user, { ...opts, accept: analyzedVisible() });
  if (counters.hashes.length) { take(counters.hashes, 'counters'); return out; }

  // Pins alone still make a page: random only stands in for NO seeds.
  if (seeds.length) { return out; }

  // Counted plays exist, none analyzed yet: list them, flag the scan.
  const pending = taste.historySeeds(d(), req.user, { ...opts, windowDays, accept: pendingVisible() });
  if (pending.hashes.length) {
    // The listed seeds came from THIS pass's window (often the requested
    // one: the analyzed pass above widened only because nothing in it was
    // analyzed), so it is the one the answer reports.
    out.window = pending.window;
    out.widenedFrom = pending.widenedFrom;
  }
  const pendingSeeds = pending.hashes.length ? pending.hashes
    : taste.counterSeeds(d(), req.user, { ...opts, accept: pendingVisible() }).hashes;
  if (pendingSeeds.length) {
    take(pendingSeeds, pending.hashes.length ? 'history' : 'counters');
    out.notAnalyzed = true;
    return out;
  }

  // Nothing counted at all: one analyzed track from the caller's own
  // libraries, drawn fresh per call (taste-queries randomVisibleSeed) — a
  // client's "Another pick" re-asks with the picks it showed in `exclude`.
  out.seedSource = 'random';
  out.fallback = true;
  const pick = taste.randomVisibleSeed(d(), req.user, index, { libIds, exclude: exclusions });
  const row = pick ? resolveVisible(uid, filter, pick.hash, { withGenres: false }) : null;
  if (pick && row) {
    seeds.push({ hash: pick.hash, row, entry: pick.entry, pinned: false, outcome: null, lastPlayed: null, plays: null });
  } else {
    // No visible analyzed track anywhere: the scan has not reached this
    // user's libraries (or they are empty).
    out.notAnalyzed = true;
  }
  return out;
}

// ── Library ──────────────────────────────────────────────────────────────

// §2.5, the library's one fixed rule: a song you haven't played lately —
// never played, or not since the cutoff (DEFAULT_STALE_DAYS ago). It also
// drops "tried and bounced" (skipped, never finished) and low-rated tracks
// (≤ 2 stars = 4 on the 0–10 scale; 0/null is unrated). An undated legacy
// counter is played at an unknown time, so it is never stale.
function notPlayedLately(row, cutoff) {
  const played = row.play_count > 0;
  if ((row.skip_count || 0) > 0 && !played) { return false; }
  if (row.rating > 0 && row.rating <= 4) { return false; }
  if (!played) { return true; }
  return row.last_played != null && row.last_played < cutoff;
}

// A seed's same-song key. An un-analyzed pin has no index entry, but its
// other, analyzed files must still not come back as "never played": the
// key is built from its library row by the index's own rule.
function seedNameKey(s) {
  if (s.entry) { return sim.entryNameKey(s.entry); }
  return s.row ? sim.entryNameKey({ artist: s.row.artist_name, title: s.row.title }) : null;
}

// Library rows read per walk step (see the accept loop): about a page of
// candidates — most walks accept `limit.tracks` (≤ 50) well inside it.
const ROW_CHUNK = 100;

async function librarySection(req, index, ctx) {
  const { uid, libIds, libSeeds, allSeeds, exclusions, limit } = ctx;
  const out = { tracks: [], albums: [], capped: false };
  if (libSeeds.length === 0 || (limit.tracks === 0 && limit.albums === 0)) { return out; }

  const cutoff = toSqlite(new Date(Date.now() - taste.DEFAULT_STALE_DAYS * DAY_MS));
  const budget = considerBudget(Math.max(limit.tracks, limit.albums));
  // Seed songs never come back, by hash or by any other file of the song.
  // dedupe:false — the ranking cannot see visibility, so the best file of a
  // song in a library this user cannot open must not hide the one they can;
  // the walk below dedupes what it accepts instead.
  const ranked = await sim.rankTracksMulti(index, libSeeds.map((s) => s.entry.vec), {
    exclude: new Set([...allSeeds.map((s) => s.hash), ...exclusions]),
    excludeNameKeys: new Set(allSeeds.map(seedNameKey).filter(Boolean)),
    topK: budget,
    mode: 'max',
    dedupe: false,
  });

  // The walk pool: every ranked candidate this caller can see, best first,
  // with its album id (index entries carry none). One chunked probe, not a
  // probe per row — the album pass needs the whole pool.
  const vis = taste.visibleTracksByHash(d(), ranked.map((r) => r.entry.hash), libIds);
  const pool = [];
  for (const r of ranked) {
    const t = vis.get(r.entry.hash);
    if (t) { pool.push({ ...r, trackId: t.id, albumId: t.albumId }); }
  }
  const seedHashOf = (i) => (i == null ? null : libSeeds[i]?.hash ?? null);

  // Albums before songs (§2.6): every card the pool touches, ranked by its
  // best track, kept when this user has not played it, or not since the
  // cutoff. The cards' songs leave the tracks list.
  const inAlbums = new Set();   // track ids listed under a returned album
  if (limit.albums > 0 && pool.length) {
    const bestByAlbum = new Map();
    for (const p of pool) {
      if (p.albumId != null && !bestByAlbum.has(p.albumId)) { bestByAlbum.set(p.albumId, p); }
    }
    const cardRows = taste.albumCardRows(d(), req.user, [...bestByAlbum.keys()], { libIds });
    const scored = cardRows.map((row) => {
      let best = null;
      for (const id of row.albumIds) {
        const p = bestByAlbum.get(id);
        if (p && (!best || p.similarity > best.similarity)) { best = p; }
      }
      return { row, best };
    }).filter((c) => c.best).sort((a, b) => b.best.similarity - a.best.similarity);
    const facts = taste.albumCards(d(), req.user, scored.map((c) => c.row), { libIds, staleCutoff: cutoff });
    const keep = [];
    for (const [i, c] of scored.entries()) {
      const f = facts[i];
      if (!f.unplayed && !f.stale) { continue; }
      keep.push({ ...c, facts: f });
      if (keep.length >= limit.albums) { break; }
    }
    if (keep.length) {
      const items = albumItems(d(), keep.map((c) => c.row));
      const members = keep.map((c) => {
        const ids = new Set(c.row.albumIds);
        return pool.filter((p) => ids.has(p.albumId));
      });
      const paths = renderMetadataByIds(members.flat().map((p) => p.trackId), req.user);
      for (const [i, c] of keep.entries()) {
        for (const p of members[i]) { inAlbums.add(p.trackId); }
        out.albums.push({
          ...items[i],
          similarity: round4(c.best.similarity),
          seedHash: seedHashOf(c.best.seedIndex),
          scopedTracks: c.facts.scopedTracks,
          playedTracks: c.facts.playedTracks,
          lastPlayed: toIso(c.facts.lastPlayed),
          tracks: members[i].map((p) => paths.get(p.trackId)?.filepath).filter(Boolean),
        });
      }
    }
  }

  // Songs. One file per song: the first VISIBLE file met (the walk is
  // descending) claims the song's name key whether or not it passes the
  // rule — play counts key by hash, so an alternate file of a song the
  // user just played would otherwise read as "never played".
  const seenKeys = new Set();
  for (const p of pool) {
    if (!inAlbums.has(p.trackId)) { continue; }
    const key = sim.entryNameKey(p.entry);
    if (key) { seenKeys.add(key); }
  }
  // The pool is already visibility-probed (with track ids), so the rows the
  // rule needs are read BY ID, a chunk at a time as the walk advances —
  // not one resolveVisible per candidate: a heavy listener rejects most
  // near neighbours and the walk can cross the whole budget.
  const rowsById = new Map();
  let fetchedTo = 0;
  const fetchRows = (from) => {
    fetchedTo = Math.min(pool.length, from + ROW_CHUNK);
    const ids = [];
    for (let j = from; j < fetchedTo; j++) {
      if (!inAlbums.has(pool[j].trackId)) { ids.push(pool[j].trackId); }
    }
    if (ids.length === 0) { return; }
    const rows = d().prepare(`${trackQuery(uid, { includeGenres: false })}
      WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...(uid ? [uid] : []), ...ids);
    for (const row of rows) { rowsById.set(row.id, row); }
  };
  const accepted = [];
  for (let i = 0; i < pool.length && accepted.length < limit.tracks; i++) {
    const p = pool[i];
    if (inAlbums.has(p.trackId)) { continue; }
    const key = sim.entryNameKey(p.entry);
    if (key && seenKeys.has(key)) { continue; }
    if (i >= fetchedTo) { fetchRows(i); }
    // Gone between the probe and now (a rescan): skip, like a failed probe.
    const row = rowsById.get(p.trackId);
    if (!row) { continue; }
    if (key) { seenKeys.add(key); }
    if (!notPlayedLately(row, cutoff)) { continue; }
    accepted.push({ p, row });
  }
  // Ranked to the budget and still short: say so, so a client can tell
  // "the pool ran dry" from "we stopped looking" (the similar routes' flag).
  out.capped = accepted.length < limit.tracks && ranked.length >= budget;

  enrichRows(d(), accepted.map((a) => a.row));
  for (const { p, row } of accepted) {
    const rendered = renderMetadataObj(row);
    out.tracks.push({
      filepath: rendered.filepath,
      similarity: round4(p.similarity),
      seedHash: seedHashOf(p.seedIndex),
      metadata: toLiteMetadata(rendered.metadata),
      genreTags: p.entry.genreTags ?? null,
      playCount: row.play_count || 0,
      lastPlayed: toIso(row.last_played),
    });
  }
  return out;
}

// ── Network (p2p shelf) ──────────────────────────────────────────────────

// The network section with no rows, and why (`reason`), so a client names
// the empty state instead of guessing it from the counts:
//   null            rows came back, or none were asked for (limit 0)
//   'scan-pending'  no seed has a vector yet (the route's early answer)
//   'error'         the walk failed; the next call walks again
//   'empty-shelf'   no peer snapshot on the shelf
//   'not-on-shelf'  none of the networkPeers asked for is on the shelf
//   'no-compatible' every shelf peer is in another model space
//   'nothing-new'   peers were searched, nothing new to this library
function emptyNetwork(reason) {
  return { results: [], searched: { peers: 0, tracks: 0 }, reason };
}

function networkReason(found, results, filtered) {
  if (results.length > 0) { return null; }
  if (found.held === 0) { return filtered ? 'not-on-shelf' : 'empty-shelf'; }
  return found.searched.peers === 0 ? 'no-compatible' : 'nothing-new';
}

async function networkSection(index, centroid, ctx) {
  const { seeds, limit, newArtistsOnly, networkPeers } = ctx;
  if (limit.network === 0) { return emptyNetwork(null); }
  let found, results;
  try {
    found = await searchPeers(centroid, index.modelId, {
      peers: networkPeers, excludeSets: localIdentitySets(), newArtistsOnly, limit: limit.network,
      headroom: NETWORK_HEADROOM, seedVecs: seeds.map((s) => s.entry.vec),
    });
    // Labels read the catalog (peers' own announcements): inside the try, so
    // whatever trips there costs this section, never the whole answer.
    results = stampNetworkRows(found.results, seeds, limit.network, shelfLabels());
  } catch (err) {
    // Answered as an empty section; the next call walks again.
    winston.warn(`discovery taste: p2p shelf search failed: ${err.message}`);
    return emptyNetwork('error');
  }
  return { results, searched: found.searched, reason: networkReason(found, results, networkPeers != null) };
}

// The peers route's labels (GET /api/v1/discovery/p2p/peers): one map over
// the same universe (catalog ∪ shelf, minus blocked), so a lead's
// "● <label>" reads exactly as its peer's strip item does.
function shelfLabels() {
  return peerLabels({ shelf: peerDbs.list(), catalog: discoveryCatalog.list(), isBlocked: peerDbs.isBlocked });
}

// Peer rows are untrusted (a public-network snapshot, a federated server's
// answer) and every stamped row is promised to be ready to send: clients
// forward it unchanged to resolve / jobs / lookup, and the batch lookup
// validates its array as one unit, so one row the recommendation schema
// would refuse turns the client's whole lookup into a 400.
//
// A bad CATALOGUE fact is nulled, not the row dropped (2026-10-19): an ISRC
// as a raw tag spells it ('US-RC1-76-07839' — the scanner stores ISRCs
// unnormalised), a year outside 1000–9999, an over-long MBID or album name
// (recommendation.js repairRecommendation, NULLABLE_FACTS), so the song
// still shows. A row the schema refuses in what it IS — a 600-char title,
// a number for an artist, a path past 2048 — is dropped, as before.
// genreTags, albumArt and similarity are no schema fields (stripped as
// unknown, so they never fail it); on a federation row the fan-out's merge
// has bounded them already (discovery-federation.js peerSimilarity,
// peerTags, peerArtName) and repaired the row the same way as here.
// The row ready to send (itself, or a copy with bad facts nulled), or null.
// Exported for tests.
export function sendableRow(row) {
  const { row: out, nulled, error } = repairRecommendation(row);
  if (!out) {
    winston.debug(`discovery taste: dropped a peer row that is not a valid recommendation: ${error}`);
  } else if (nulled.length) {
    winston.debug(`discovery taste: nulled ${nulled.join(', ')} on a peer row: ${error}`);
  }
  return out;
}

// Shelf rows → ready-to-send recommendations: `source` stamped, `seedHash`
// = the seed the row sits closest to (searchPeers' seedIndex, dropped from
// the wire), and one row per recommendationKey — two peers holding one song
// show it once, the better match winning (the rows arrive best first).
// After the schema check, two display facts no plug-in reads: `peer.label`
// (from `labels`, endpointId -> label; the peer's name when the map lacks
// it) and the generated tile a client draws for a lead with no art
// (discovery-peer-view.js leadTile). The schema keeps unknown peer keys and
// strips unknown top-level ones, so the row still forwards unchanged.
// Exported for tests: the integration servers run without a p2p shelf.
export function stampNetworkRows(rows, seeds, limit, labels = new Map()) {
  const seen = new Set();
  const results = [];
  for (const { seedIndex, ...row } of rows) {
    if (results.length >= limit) { break; }
    const rec = sendableRow({
      ...row,
      source: RECOMMENDATION_SOURCES.P2P,
      seedHash: seedIndex == null ? null : seeds[seedIndex]?.hash ?? null,
    });
    if (!rec) { continue; }
    const key = recommendationKey(rec);
    if (seen.has(key)) { continue; }
    seen.add(key);
    if (rec.peer) {
      rec.peer = { ...rec.peer, label: labels.get(rec.peer.endpointId) ?? rec.peer.name ?? '' };
    }
    rec.tile = leadTile(rec);
    results.push(rec);
  }
  return results;
}

// ── Peers (federation) ───────────────────────────────────────────────────

// The fan-out's per-peer groups with every row stamped as a federation
// recommendation (the stream proxy plays its peer-side `filepath`). The
// fan-out asks with the centroid, so no row is "because of" one seed.
// Exported for tests, like stampNetworkRows.
export function peersSection(fan) {
  return {
    peers: fan.peers.map((g) => ({
      ...g,
      results: g.results
        .map((r) => sendableRow({ ...r, source: RECOMMENDATION_SOURCES.FEDERATION, seedHash: null }))
        .filter(Boolean),
    })),
    searched: fan.searched,
  };
}

// The caller's federationDiscovery flag (server-info buildClientBootPayload):
// federation on and at least one peer that takes similarity queries.
// collectDiscoveryData is already known on here (requireIndex passed).
function federationDiscoveryOn() {
  return config.program.federation.enabled === true
    && fedDb.getFederationPeers().some((p) => p.use_discovery === 1);
}

// ── Routes ───────────────────────────────────────────────────────────────

export function setup(mstream) {
  mstream.use('/api/v1/discovery/taste', refuseJukebox);

  mstream.post('/api/v1/discovery/taste', async (req, res) => {
    requireAccount(req);
    const { value: body } = joiValidate(tasteSchema, req.body || {});
    const index = requireIndex();
    const uid = req.user.id;
    const exclusions = [...new Set(body.exclude)];

    const filter = libraryFilter(req.user, body.ignoreVPaths);
    const libIds = taste.tasteScope(req.user, body.ignoreVPaths);
    const picked = collectSeeds(req, index, body, { uid, filter, libIds, exclusions: new Set(exclusions), windowDays: body.window });
    const { seeds } = picked;

    // Seeds render through one batched enrichment (pins already carry it).
    enrichRows(d(), seeds.filter((s) => !s.pinned).map((s) => s.row));

    // The hashes this call left out that resolve to a track this caller can
    // see — so a client can offer them back within the visit.
    const exVis = taste.visibleTracksByHash(d(), exclusions, libIds);
    const exRendered = renderMetadataByIds([...exVis.values()].map((t) => t.id), req.user);
    const excluded = [];
    for (const hash of exclusions) {
      const r = exRendered.get(exVis.get(hash)?.id);
      if (r) { excluded.push({ hash, filepath: r.filepath, metadata: toLiteMetadata(r.metadata) }); }
    }

    const analyzed = seeds.filter((s) => s.entry);
    const random = picked.seedSource === 'random';
    // Pins first, then up to LIBRARY_SEED_CAP history seeds — each one more
    // index pass (§2.4). Pins come first so a tie names the pin.
    const libSeeds = [
      ...analyzed.filter((s) => s.pinned),
      ...analyzed.filter((s) => !s.pinned).slice(0, taste.LIBRARY_SEED_CAP),
    ];
    const want = new Set(body.sources);
    // A random seed is no taste, so by default nothing walks for it — but
    // the shelf walk never leaves this machine, and the Peer
    // Recommendations page asks for leads off the single random pick
    // (networkOnRandomSeed; its vector is the centroid, so every lead's
    // seedHash is the pick). The federation fan-out sends the centroid to
    // other servers: never for a random seed.
    const wantNetwork = want.has('network') && config.program.discoveryP2p.enabled === true
      && (!random || body.networkOnRandomSeed === true);
    const wantPeers = want.has('peers') && federationDiscoveryOn() && !random;

    const response = {
      window: picked.window,
      widenedFrom: picked.widenedFrom,
      seedSource: picked.seedSource,
      fallback: picked.fallback,
      seeds: seeds.map(seedOut),
      excluded,
      dropped: picked.dropped,
      // Scan pending: no seed has a vector yet (or, for a random seed, the
      // caller can see no analyzed track at all).
      notAnalyzed: picked.notAnalyzed || (seeds.length > 0 && analyzed.length === 0),
      model: { id: index.modelId, version: index.modelVersion },
      library: null,
      network: null,
      peers: null,
    };
    // No analyzed seed (the scan is pending): nothing to rank or send. The
    // sections the caller asked for come back EMPTY, never null and never
    // errors — null means "not available here" (plan §3.1), and a client
    // must not hide an advertised source while a scan runs.
    if (analyzed.length === 0) {
      if (want.has('library')) { response.library = { tracks: [], albums: [], capped: false }; }
      if (wantNetwork) { response.network = emptyNetwork(body.limit.network === 0 ? null : 'scan-pending'); }
      if (wantPeers) { response.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } }; }
      return res.json(response);
    }

    const centroid = (wantNetwork || wantPeers) ? sim.centroidOf(analyzed.map((s) => s.entry.vec)) : null;
    const ctx = {
      uid, filter, libIds, libSeeds, allSeeds: seeds, exclusions,
      limit: body.limit, newArtistsOnly: body.newArtistsOnly, seeds: analyzed,
      networkPeers: body.networkPeers ?? null,
    };

    // Federation first (§3.1): its requests are in flight while the
    // library ranks and the shelf walks, and it is awaited last — a peer
    // may take its whole 4 s deadline. The client module is loaded BEFORE
    // the fan-out starts (a cold dynamic import would otherwise park the
    // dial behind the synchronous library pass), and one macrotask yield
    // after it lets the dials and request bytes go out before that pass.
    // The noop catch only keeps an early failure from being reported as
    // unhandled before we await it.
    let fed = null;
    if (wantPeers && body.limit.peers > 0) {
      await loadFederationClient();
      fed = fanOutFederation(centroid, index.modelId, {
        limit: body.limit.peers, newArtistsOnly: body.newArtistsOnly, onPeerStatus: recordPeerStatus,
      });
      fed.catch(() => {});
      await new Promise(setImmediate);
    }

    try {
      if (want.has('library')) { response.library = await librarySection(req, index, ctx); }
      if (wantNetwork) { response.network = await networkSection(index, centroid, ctx); }
    } finally {
      // Settle the fan-out even when the library pass threw: its result is
      // dropped, but the bookkeeping (status writes) still happens.
      if (fed) {
        try {
          response.peers = peersSection(await fed);
        } catch (err) {
          winston.warn(`discovery taste: federation fan-out failed: ${err.message}`);
          response.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } };
        }
      } else if (wantPeers) {
        response.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } };
      }
    }
    res.json(response);
  });
}
