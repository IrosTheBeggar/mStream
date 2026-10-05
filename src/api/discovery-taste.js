// The Discover page's server half: one call that turns the user's PLAY
// HISTORY into recommendations from three sources (docs/discovery-page-plan.md
// §2, §3.1–3.2).
//
//   POST /api/v1/discovery/taste        seeds + library / network / peers
//   GET  /api/v1/discovery/taste/prefs  the saved page prefs
//   PUT  /api/v1/discovery/taste/prefs  save them (validated like the POST)
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
// up to 12 of this user's recent songs — one averaged vector, never names,
// paths or hashes (see the header of api/discovery-federation.js).

import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import { localIdentitySets } from '../db/discovery-novelty.js';
import { recommendationKey, recommendationSchema, RECOMMENDATION_SOURCES } from '../discovery-plugins/index.js';
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
import * as taste from '../discovery/taste-queries.js';

const d = () => db.getDB();

const SOURCES = Object.freeze(['library', 'network', 'peers']);
const DAY_MS = 24 * 60 * 60 * 1000;
// p2p rows are fetched with headroom: the cross-peer recommendationKey
// dedupe runs after the walk, and two peers often hold the same song.
const NETWORK_HEADROOM = 2;

// ── Gates ────────────────────────────────────────────────────────────────

// The stats routes' requireAccount rule (api/stats.js): a federation key or
// a guest token builds a user with no id, or a federation-flagged one —
// neither has a play history of its own here.
function requireAccount(req) {
  if (!req.user?.id || req.user.federation) { throw new WebError('Forbidden', 403); }
}

// The prefs routes need no index (they read user_settings), but they belong
// to a feature that is off — same 403 as the taste route.
function requireDiscoveryOn() {
  if (config.program.scanOptions.collectDiscoveryData !== true) {
    throw new WebError('Discovery is disabled', 403);
  }
}

// ── Validation ───────────────────────────────────────────────────────────

const hashList = Joi.array().items(Joi.string().min(1).max(taste.HASH_MAX)).max(taste.EXCLUDE_CAP);

const limitSchema = Joi.object({
  seeds: Joi.number().integer().min(1).max(taste.LIMIT_CAPS.seeds).default(taste.LIMIT_DEFAULTS.seeds),
  tracks: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.tracks).default(taste.LIMIT_DEFAULTS.tracks),
  albums: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.albums).default(taste.LIMIT_DEFAULTS.albums),
  network: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.network).default(taste.LIMIT_DEFAULTS.network),
  // Per peer: the peers section is grouped by server.
  peers: Joi.number().integer().min(0).max(taste.LIMIT_CAPS.peers).default(taste.LIMIT_DEFAULTS.peers),
}).default();

// No Joi defaults for window / filter / staleDays: an absent key means "use
// the saved pref", which a schema default would make indistinguishable from
// the client choosing the default explicitly.
const tasteSchema = Joi.object({
  window: Joi.number().integer().valid(...taste.WINDOWS),
  pin: Joi.array().items(Joi.string().min(1).max(2048)).max(taste.PIN_CAP).default([]),
  exclude: hashList.default([]),
  remember: Joi.boolean().default(false),
  filter: Joi.string().valid(...taste.FILTERS),
  staleDays: Joi.number().integer().min(taste.STALE_DAYS_MIN).max(taste.STALE_DAYS_MAX),
  sources: Joi.array().items(Joi.string().valid(...SOURCES)).unique().default([...SOURCES]),
  limit: limitSchema,
  newArtistsOnly: Joi.boolean().default(false),
  ignoreVPaths: Joi.array().items(Joi.string().max(256)).max(100),
});

// PUT …/prefs: every key optional; null puts a pref back to its default;
// `exclude` is THE list (re-including a seed = sending the list without it).
const prefsSchema = Joi.object({
  window: Joi.number().integer().valid(...taste.WINDOWS).allow(null),
  filter: Joi.string().valid(...taste.FILTERS).allow(null),
  staleDays: Joi.number().integer().min(taste.STALE_DAYS_MIN).max(taste.STALE_DAYS_MAX).allow(null),
  exclude: hashList.allow(null),
});

// Stored prefs with the defaults applied — what the page should render.
function effectivePrefs(stored) {
  return {
    window: stored.window ?? taste.DEFAULT_WINDOW,
    filter: stored.filter ?? taste.DEFAULT_FILTER,
    staleDays: stored.staleDays ?? taste.DEFAULT_STALE_DAYS,
    exclude: stored.exclude || [],
  };
}

// ── Result cache ─────────────────────────────────────────────────────────
//
// The expensive half of an answer (library / network / peers) for 5
// minutes, ONE ENTRY PER SECTION: a peer that missed its deadline must not
// cost the library and the shelf walk their entries (the peers section is
// then simply not stored), and the client's two parallel calls
// (library+network, peers) share one key. Keyed first by the index OBJECT
// (a WeakMap: an index rebuild — new embeddings, a library change — drops
// every entry with the old index), then by everything that shapes a
// section: the caller and their cache generation (a stats reset bumps it),
// the resolved library scope (a revoked library grant moves no index
// counter, so it must move the key), every seed hash — un-analyzed pins
// included, their other files are kept out of the library — the ordered
// library seeds and the centroid's seed set, the exclusions, filter,
// staleDays, limits, newArtistsOnly, ignoreVPaths and the section name.
// A section is only looked up when it is EFFECTIVELY wanted (asked AND
// advertised right now), so a source an admin turns off is never served
// from the cache, and one turned on is computed. The seeds themselves are
// recomputed on every call (cheap, and they are what tells a client its
// history moved). Clients fetch on open or on a tap and never poll, so 96
// section entries (32 three-section answers) per index is plenty.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 96;
const resultCache = new WeakMap();
// uid → generation. Bumped by clearTasteCache; part of every key, so the
// old entries are unreachable at once and age out of the LRU.
const cacheGenerations = new Map();

function cacheKey(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

// Forget this user's cached Discover answers: the stats routes call it when
// the listening data the library section was built from is reset or
// deleted (play counts and last-played times are on every row).
export function clearTasteCache(uid) {
  if (uid == null) { return; }
  cacheGenerations.set(uid, (cacheGenerations.get(uid) || 0) + 1);
}

// Which computed sections may be stored. A failed source (a p2p walk that
// threw, a fan-out that failed) and a fan-out with an unreachable peer —
// which may answer the next tap — are not worth pinning for 5 minutes.
// Exported for tests: the integration servers have no flaky peers.
export function cacheableSections(sections) {
  const out = {};
  for (const [name, value] of Object.entries(sections)) {
    if (!value || value.failed) { continue; }
    if (name === 'peers' && value.searched?.unreachable > 0) { continue; }
    out[name] = value;
  }
  return out;
}

function cacheGet(index, key, now = Date.now()) {
  const m = resultCache.get(index);
  const hit = m?.get(key);
  if (!hit) { return null; }
  if (now - hit.at > CACHE_TTL_MS) { m.delete(key); return null; }
  return hit.value;
}

function cacheSet(index, key, value, now = Date.now()) {
  let m = resultCache.get(index);
  if (!m) { m = new Map(); resultCache.set(index, m); }
  m.delete(key);            // re-insert = most recent
  m.set(key, { at: now, value });
  while (m.size > CACHE_MAX) { m.delete(m.keys().next().value); }
}

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
  // a second probe.
  const rows = new Map();
  const visible = (h) => {
    if (!rows.has(h)) { rows.set(h, resolveVisible(uid, filter, h, { withGenres: false }) || null); }
    return rows.get(h) !== null;
  };
  const analyzedVisible = (h) => index.byHash.has(h) && visible(h);
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

  const hist = taste.historySeeds(d(), req.user, { ...opts, windowDays, accept: analyzedVisible });
  out.window = hist.window;
  out.widenedFrom = hist.widenedFrom;
  if (hist.hashes.length) { take(hist.hashes, 'history'); return out; }

  const counters = taste.counterSeeds(d(), req.user, { ...opts, accept: analyzedVisible });
  if (counters.hashes.length) { take(counters.hashes, 'counters'); return out; }

  // Pins alone still make a page: random only stands in for NO seeds.
  if (seeds.length) { return out; }

  // Counted plays exist, none analyzed yet: list them, flag the scan.
  const pending = taste.historySeeds(d(), req.user, { ...opts, windowDays, accept: visible });
  if (pending.hashes.length) {
    // The listed seeds came from THIS pass's window (often the requested
    // one: the analyzed pass above widened only because nothing in it was
    // analyzed), so it is the one the answer reports.
    out.window = pending.window;
    out.widenedFrom = pending.widenedFrom;
  }
  const pendingSeeds = pending.hashes.length ? pending.hashes
    : taste.counterSeeds(d(), req.user, { ...opts, accept: visible }).hashes;
  if (pendingSeeds.length) {
    take(pendingSeeds, pending.hashes.length ? 'history' : 'counters');
    out.notAnalyzed = true;
    return out;
  }

  // Nothing counted at all: one analyzed track from the caller's own
  // libraries, the same one all day (taste-queries randomVisibleSeed).
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

// §2.5: does a library candidate pass the page's filter? `fresh` = never
// played or not since the cutoff; `unplayed` = never. Both drop "tried and
// bounced" (skipped, never finished) and low-rated tracks (≤ 2 stars = 4 on
// the 0–10 scale; 0/null is unrated). An undated legacy counter is played
// at an unknown time, so it is never stale.
function passesFilter(row, filter, cutoff) {
  if (filter === 'all') { return true; }
  const played = row.play_count > 0;
  if ((row.skip_count || 0) > 0 && !played) { return false; }
  if (row.rating > 0 && row.rating <= 4) { return false; }
  if (!played) { return true; }
  return filter === 'fresh' && row.last_played != null && row.last_played < cutoff;
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
  const { uid, libIds, libSeeds, allSeeds, exclusions, filterName, staleDays, limit } = ctx;
  const out = { filter: filterName, tracks: [], albums: [], capped: false };
  if (libSeeds.length === 0 || (limit.tracks === 0 && limit.albums === 0)) { return out; }

  const cutoff = toSqlite(new Date(Date.now() - staleDays * DAY_MS));
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
  // best track, kept when this user has not played it (or, under fresh, not
  // since the cutoff). The cards' songs leave the tracks list.
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
      const ok = filterName === 'all' || f.unplayed || (filterName === 'fresh' && f.stale);
      if (!ok) { continue; }
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
  // filter — play counts key by hash, so an alternate file of a song the
  // user just played would otherwise read as "never played".
  const seenKeys = new Set();
  for (const p of pool) {
    if (!inAlbums.has(p.trackId)) { continue; }
    const key = sim.entryNameKey(p.entry);
    if (key) { seenKeys.add(key); }
  }
  // The pool is already visibility-probed (with track ids), so the rows the
  // filter needs are read BY ID, a chunk at a time as the walk advances —
  // not one resolveVisible per candidate: under `unplayed` a heavy listener
  // rejects most near neighbours and the walk can cross the whole budget.
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
    if (!passesFilter(row, filterName, cutoff)) { continue; }
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

async function networkSection(index, centroid, ctx) {
  const { seeds, limit, newArtistsOnly } = ctx;
  if (limit.network === 0) { return { results: [], searched: { peers: 0, tracks: 0 } }; }
  let found;
  try {
    found = await searchPeers(centroid, index.modelId, {
      excludeSets: localIdentitySets(), newArtistsOnly, limit: limit.network,
      headroom: NETWORK_HEADROOM, seedVecs: seeds.map((s) => s.entry.vec),
    });
  } catch (err) {
    // Answered as an empty section, but flagged so it is never cached: the
    // next tap retries the walk (the flag is stripped before responding).
    winston.warn(`discovery taste: p2p shelf search failed: ${err.message}`);
    return { results: [], searched: { peers: 0, tracks: 0 }, failed: true };
  }
  return { results: stampNetworkRows(found.results, seeds, limit.network), searched: found.searched };
}

// Peer rows are untrusted (a public-network snapshot, a federated server's
// answer) and every stamped row is promised to be ready to send: clients
// forward it unchanged to resolve / jobs / lookup, and the batch lookup
// validates its array as one unit. A row the recommendation schema would
// refuse — a 600-char title, a number for an artist — would turn the
// client's whole lookup into a 400, so it never leaves here.
function sendable(row) {
  const { error } = recommendationSchema.validate(row);
  if (error) {
    winston.debug(`discovery taste: dropped a peer row that is not a valid recommendation: ${error.message}`);
    return false;
  }
  return true;
}

// Shelf rows → ready-to-send recommendations: `source` stamped, `seedHash`
// = the seed the row sits closest to (searchPeers' seedIndex, dropped from
// the wire), and one row per recommendationKey — two peers holding one song
// show it once, the better match winning (the rows arrive best first).
// Exported for tests: the integration servers run without a p2p shelf.
export function stampNetworkRows(rows, seeds, limit) {
  const seen = new Set();
  const results = [];
  for (const { seedIndex, ...row } of rows) {
    if (results.length >= limit) { break; }
    const rec = {
      ...row,
      source: RECOMMENDATION_SOURCES.P2P,
      seedHash: seedIndex == null ? null : seeds[seedIndex]?.hash ?? null,
    };
    if (!sendable(rec)) { continue; }
    const key = recommendationKey(rec);
    if (seen.has(key)) { continue; }
    seen.add(key);
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
        .map((r) => ({ ...r, source: RECOMMENDATION_SOURCES.FEDERATION, seedHash: null }))
        .filter(sendable),
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
    // The public-mode sentinel is ONE account shared by every visitor:
    // nothing it sends is remembered, or one visitor's choices would be
    // the next one's page.
    const persist = !db.isPublicMode(req.user);

    if (body.remember && persist) {
      taste.setTastePrefs(d(), uid, {
        window: body.window, filter: body.filter, staleDays: body.staleDays,
        exclude: body.exclude.length ? body.exclude : undefined,
      });
    }
    const saved = taste.getTastePrefs(d(), uid);
    const prefs = effectivePrefs(saved);
    const windowDays = body.window ?? prefs.window;
    const filterName = body.filter ?? prefs.filter;
    const staleDays = body.staleDays ?? prefs.staleDays;
    // Saved exclusions always apply (every client of this account agrees);
    // the request's join them for this call, and stay when `remember`.
    const exclusions = [...new Set([...saved.exclude, ...body.exclude])];

    const filter = libraryFilter(req.user, body.ignoreVPaths);
    const libIds = taste.tasteScope(req.user, body.ignoreVPaths);
    const picked = collectSeeds(req, index, body, { uid, filter, libIds, exclusions: new Set(exclusions), windowDays });
    const { seeds } = picked;

    // Seeds render through one batched enrichment (pins already carry it).
    enrichRows(d(), seeds.filter((s) => !s.pinned).map((s) => s.row));

    // Exclusions the seeds sheet can show (and re-include): the ones that
    // still resolve to a track this caller can see.
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
    const wantNetwork = want.has('network') && config.program.discoveryP2p.enabled === true && !random;
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
      if (want.has('library')) { response.library = { filter: filterName, tracks: [], albums: [], capped: false }; }
      if (wantNetwork) { response.network = { results: [], searched: { peers: 0, tracks: 0 } }; }
      if (wantPeers) { response.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } }; }
      return res.json(response);
    }

    const baseKey = [
      uid, cacheGenerations.get(uid) || 0, libIds == null ? null : [...libIds].sort((a, b) => a - b),
      seeds.map((s) => s.hash).sort(), libSeeds.map((s) => s.hash), analyzed.map((s) => s.hash).sort(),
      [...exclusions].sort(), filterName, staleDays, body.limit, body.newArtistsOnly,
      [...(body.ignoreVPaths || [])].sort(),
    ];
    const keyOf = (section) => cacheKey([...baseKey, section]);
    const wanted = { library: want.has('library'), network: wantNetwork, peers: wantPeers };
    const sections = { library: null, network: null, peers: null };
    const missing = new Set();
    for (const name of Object.keys(sections)) {
      if (!wanted[name]) { continue; }
      sections[name] = cacheGet(index, keyOf(name));
      if (!sections[name]) { missing.add(name); }
    }
    if (missing.size === 0) { return res.json({ ...response, ...sections }); }

    const centroid = (missing.has('network') || missing.has('peers'))
      ? sim.centroidOf(analyzed.map((s) => s.entry.vec)) : null;
    const ctx = {
      uid, filter, libIds, libSeeds, allSeeds: seeds, exclusions, filterName, staleDays,
      limit: body.limit, newArtistsOnly: body.newArtistsOnly, seeds: analyzed,
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
    if (missing.has('peers') && body.limit.peers > 0) {
      await loadFederationClient();
      fed = fanOutFederation(centroid, index.modelId, {
        limit: body.limit.peers, newArtistsOnly: body.newArtistsOnly, onPeerStatus: recordPeerStatus,
      });
      fed.catch(() => {});
      await new Promise(setImmediate);
    }

    const computed = {};
    try {
      if (missing.has('library')) { computed.library = await librarySection(req, index, ctx); }
      if (missing.has('network')) { computed.network = await networkSection(index, centroid, ctx); }
    } finally {
      // Settle the fan-out even when the library pass threw: its result is
      // dropped, but the bookkeeping (status writes) still happens.
      if (fed) {
        try {
          computed.peers = peersSection(await fed);
        } catch (err) {
          winston.warn(`discovery taste: federation fan-out failed: ${err.message}`);
          computed.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 }, failed: true };
        }
      } else if (missing.has('peers')) {
        computed.peers = { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } };
      }
    }

    for (const [name, value] of Object.entries(cacheableSections(computed))) {
      cacheSet(index, keyOf(name), value);
    }
    for (const [name, value] of Object.entries(computed)) {
      // The failure flag is bookkeeping for the cache, not part of the
      // shape (a failed section was never stored, so this mutates no entry).
      if (value.failed) { delete value.failed; }
      sections[name] = value;
    }
    res.json({ ...response, ...sections });
  });

  mstream.get('/api/v1/discovery/taste/prefs', (req, res) => {
    requireAccount(req);
    requireDiscoveryOn();
    res.json({
      ...effectivePrefs(taste.getTastePrefs(d(), req.user.id)),
      persisted: !db.isPublicMode(req.user),
    });
  });

  mstream.put('/api/v1/discovery/taste/prefs', (req, res) => {
    requireAccount(req);
    requireDiscoveryOn();
    const { value } = joiValidate(prefsSchema, req.body || {});
    if (db.isPublicMode(req.user)) {
      // The shared public-mode account never persists (see the POST): the
      // answer is what the page would use for this visit, nothing stored.
      const stored = taste.getTastePrefs(d(), req.user.id);
      const merged = { ...stored };
      for (const k of ['window', 'filter', 'staleDays', 'exclude']) {
        if (value[k] !== undefined) { merged[k] = value[k]; }
      }
      return res.json({ ...effectivePrefs(merged), persisted: false });
    }
    const merged = taste.setTastePrefs(d(), req.user.id, value, { replaceExclude: true });
    res.json({ ...effectivePrefs(merged), persisted: true });
  });
}
