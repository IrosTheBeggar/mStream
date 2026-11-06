// POST /api/v1/discovery/local/mix — Instant Mix: about fifty songs of the
// caller's library that sound like one item of it (a song, an album, an
// artist, a playlist, or a list of songs), closest first, under Auto DJ's
// song filters. A list for the client to play, queue or save as a
// playlist: nothing plays, and nothing is recorded, here.
//
// Contract, in short:
//   • `from` names the item, exactly one kind. The filters are
//     random-songs' own keys with its own schemas (SONG_FILTER_KEYS,
//     api/random.js), applied through the same SQL (songFilterConditions),
//     plus `skipWords`, Auto DJ's keyword filter. The schema is strict: an
//     unknown key — Auto DJ's session keys included — is a 400.
//   • Every filter is a hard WHERE, never relaxed: a mix may come back
//     short, never padded with a song a filter excludes. Only the artist
//     cap gives (`relaxed: ['artistCap']`). Tempo and key arrive as the
//     absolute windows a client builds around the seed song.
//   • 200 for every empty answer: `notAnalyzed` when no member of the item
//     has a vector yet, `filteredOut` when the filters (not the ranking)
//     left nothing. 403 while discovery is off; a uniform 404 for an item
//     the caller cannot see, so the route cannot be used to probe.
//   • The item's sound is the item's: its members resolve under the
//     caller's access alone, never `ignoreVPaths`, which shapes only the
//     candidates. A song seed leads its mix when it passes the filters
//     itself; an album's, a playlist's or a list's own songs never come
//     back, an artist's do (inside the artist cap).
//   • The ranking is cached per item (rankCache), so a filter change on
//     the same item costs a probe, not a scoring pass.
//
// A read: it records nothing, and it is scoped by the caller's libraries,
// so a federation key may call it (federation-auth.js's allowlist). A key
// has no user id: `minRating` is skipped and the playlist kind is a 404.

import { createHash } from 'node:crypto';

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as sim from '../db/discovery-similarity.js';
import { NEAR_DUP } from '../db/discovery-novelty.js';
import { nameKey } from '../db/name-key.js';
import { requireIndex, resolveSeedTrack, considerBudget } from './discovery.js';
import { SONG_FILTER_KEYS, songFilterConditions, effectiveMinRating, checkDurationWindow, buildBpmKeyFilter } from './random.js';
import { parseMoods, applicableMoods } from './mood-filter.js';
import {
  trackQuery, enrichRows, renderMetadataObj, toLiteMetadata, libraryFilter, resolveFlowTracks, albumSongConditions,
} from './db.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const MIX_LIMIT_DEFAULT = 50;
const MIX_LIMIT_MAX = 200;
const MIX_SONGS_MAX = 500;
const SKIP_WORDS_MAX = 50;
// An item ranks against at most this many points: its largest groups.
const POINTS_MAX = 6;
// Hashes per probe statement — the Discover page's visibility chunk.
const PROBE_CHUNK = 400;
// The band: every song within this much of the limit-th one's similarity
// is about as close as the end of the list.
const BAND_DROP = 0.10;
// Rows of play order the artist spread works inside.
const SPREAD_BAND = 10;

const round4 = (x) => Math.round(x * 10000) / 10000;
const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

// ── Validation ───────────────────────────────────────────────────────────

// An album as the album-songs route takes it (db.js albumSongConditions);
// null reads as absent. The singles bucket (`album: null`) is not an item
// any client offers.
const albumIdentity = Joi.object({
  album: Joi.string().min(1).max(1000).required(),
  artist: Joi.string().min(1).max(1000).allow(null),
  album_artist: Joi.string().max(1000).allow('', null),
  year: Joi.number().integer().allow(null),
});

// Exported for the unit test's lock: every SONG_FILTER_KEYS key, with its
// schema, on both routes.
export const mixSchema = Joi.object({
  from: Joi.object({
    song: Joi.string().min(1).max(4096),
    // The playlist kind's own form, for a list that lives elsewhere (the
    // queue, a selection). Paths this caller cannot resolve are skipped.
    songs: Joi.array().items(Joi.string().min(1).max(4096)).min(1).max(MIX_SONGS_MAX),
    album: albumIdentity,
    artist: Joi.string().min(1).max(1000),
    playlist: Joi.string().min(1).max(1000),
  }).xor('song', 'songs', 'album', 'artist', 'playlist').required(),
  limit: Joi.number().integer().min(1).max(MIX_LIMIT_MAX).default(MIX_LIMIT_DEFAULT),
  // Generation 1 of server-info's `instantMix`: a key added to
  // SONG_FILTER_KEYS lands here too, and bumps it.
  ...SONG_FILTER_KEYS,
  // Auto DJ's keyword filter, applied here rather than by the client, so a
  // mix still fills: see skipWordsMatcher.
  skipWords: Joi.array().items(Joi.string().trim().min(1).max(100)).max(SKIP_WORDS_MAX),
}).custom(checkDurationWindow, 'duration window ordering');

// ── Pure pieces (exported for test/unit/discovery-mix.test.mjs) ──────────

// The most songs one artist gets before the cap has to give: 5 at 50.
export const mixCap = (limit) => Math.max(2, Math.ceil(limit / 10));

// Auto DJ's keyword filter (webapp/alpha/auto-dj.js songBlocked): a song
// is skipped when its title, artist, album or wire path holds one of the
// words, case-insensitively and with repeated characters folded on both
// sides ("acappella" and "acapella" both read "acapela"); a blank word
// matches nothing. `row` carries the probe's columns. Null for no words.
const fold = (s) => String(s || '').toLowerCase().replace(/(.)\1+/g, '$1');
export function skipWordsMatcher(words) {
  const folded = (Array.isArray(words) ? words : []).map(fold).filter((w) => w.trim());
  if (folded.length === 0) { return null; }
  return (row) => {
    const wirePath = `${row.library_name ?? ''}/${row.filepath ?? ''}`.replace(/\\/g, '/');
    const hay = fold([row.title, row.artist_name, row.album_name, wirePath].join(' '));
    return folded.some((w) => hay.includes(w));
  };
}

// Each point's share of a `limit`-song mix: round(limit × weight), the
// weights taken relative to their sum, then the rounding settled so the
// quotas add up to `limit` — a missing song to the largest remainder, an
// extra one off the smallest, ties in the earlier (heavier) point's favour.
export function quotasFor(weights, limit) {
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const exact = weights.map((w) => (limit * w) / total);
  const q = exact.map((x) => Math.round(x));
  const diff = limit - q.reduce((s, x) => s + x, 0);
  if (diff !== 0) {
    const sign = Math.sign(diff);
    const order = [...q.keys()]
      .filter((i) => sign > 0 || q[i] > 0)
      .sort((a, b) => sign * ((exact[b] - q[b]) - (exact[a] - q[a])) || sign * (a - b));
    for (let n = 0; n < Math.abs(diff); n++) { q[order[n % order.length]] += sign; }
  }
  return q;
}

// "cos ≥ NEAR_DUP to any vector in this set?" — exact, but rarely at the
// price of a full dot: the product is summed in stages, and once the part
// summed plus the most the rest could add (the two vectors' remaining
// norms multiplied, Cauchy–Schwarz) is under NEAR_DUP, no later stage can
// lift it there. A pair that survives every stage gets the plain dot,
// whose answer is the verdict. On the demo library's embeddings 97% of
// pairs stop after the first sixteenth of the dimensions, which is what
// lets a thousand-song playlist check a walk's candidates in milliseconds
// (a full dot is ~1 µs at 1280-d).
export function nearDupSet() {
  const vecs = [];
  const tails = [];   // per vector: its norm past each stop
  let stops = null;
  const tailNorms = (v) => {
    const out = new Float64Array(stops.length);
    let s = 0;
    let k = v.length;
    for (let c = stops.length - 1; c >= 0; c--) {
      for (; k > stops[c]; k--) { s += v[k - 1] * v[k - 1]; }
      out[c] = Math.sqrt(s);
    }
    return out;
  };
  return {
    add(v) {
      if (!stops) {
        const n = v.length;
        stops = [n >> 4, n >> 3, n >> 2, n >> 1].filter((k, i, all) => k > 0 && all.indexOf(k) === i);
      }
      vecs.push(v);
      tails.push(tailNorms(v));
    },
    has(v) {
      if (vecs.length === 0) { return false; }
      const vt = tailNorms(v);
      for (let j = 0; j < vecs.length; j++) {
        const m = vecs[j];
        const mt = tails[j];
        let s = 0;
        let k = 0;
        let under = false;
        for (let c = 0; c < stops.length && !under; c++) {
          const end = stops[c];
          for (; k < end; k++) { s += v[k] * m[k]; }
          under = s + vt[c] * mt[c] < NEAR_DUP;
        }
        if (!under && sim.dot(v, m) >= NEAR_DUP) { return true; }
      }
      return false;
    },
  };
}

// The picks, from `eligible` ({ similarity, seedIndex, artistKey, vec },
// in rank order — the walk's survivors). `lead` (the song seed, when it
// passed the filters) is the first pick and counts toward its artist.
//
// One point: the band — the eligible songs within BAND_DROP of the
// limit-th one's similarity, at most 2 × limit, or every song when there
// are fewer than limit — then a ladder: (band, cap) → (band, 2 × cap) →
// (band, none) → (all, cap) → (all, 2 × cap) → (all, none). Each step takes
// songs in rank order, past those taken and those its cap holds back,
// until the mix is full; a song at cos ≥ NEAR_DUP to a pick (the same
// recording, which no name key caught) is dropped. A pick under a cap
// other than the first sets `relaxed`.
//
// Several points (`weights`, by point index): each point, heaviest first,
// takes its quota (quotasFor) through the same select over the songs it
// ranked best for (`seedIndex`), sharing the artist counts and the
// near-duplicate check, so an eclectic item keeps every corner — under the
// cap alone: a point's band is a fraction of the list's, and the songs of
// the artist a point is made of fill it, so a cap given there would hand
// the list to that artist. The select then fills what is left from all the
// songs not taken, and only that fill relaxes the cap.
export function selectMix(eligible, { limit, weights = null, lead = null }) {
  const cap = mixCap(limit);
  const picks = [];
  const perArtist = new Map();
  const near = nearDupSet();
  const taken = new Uint8Array(eligible.length);
  let relaxed = false;
  const count = (x) => perArtist.get(x.artistKey) || 0;
  const take = (x) => {
    picks.push(x);
    perArtist.set(x.artistKey, count(x) + 1);
    if (x.vec) { near.add(x.vec); }
  };
  if (lead) { take(lead); }

  const run = (pool, want, until, caps = [cap, 2 * cap, Infinity]) => {
    if (want <= 0 || picks.length >= until || pool.length === 0) { return; }
    let band = pool.length;
    if (pool.length >= want) {
      const floor = eligible[pool[want - 1]].similarity - BAND_DROP;
      let n = want;
      while (n < pool.length && eligible[pool[n]].similarity >= floor) { n++; }
      band = Math.min(2 * want, n);
    }
    const ladder = [...caps.map((max) => [band, max]), ...caps.map((max) => [pool.length, max])];
    for (const [size, max] of ladder) {
      for (let j = 0; j < size && picks.length < until; j++) {
        const i = pool[j];
        if (taken[i]) { continue; }
        const x = eligible[i];
        if (count(x) >= max) { continue; }
        taken[i] = 1;
        if (x.vec && near.has(x.vec)) { continue; }
        take(x);
        if (max !== cap) { relaxed = true; }
      }
    }
  };
  const left = () => {
    const pool = [];
    for (let i = 0; i < eligible.length; i++) { if (!taken[i]) { pool.push(i); } }
    return pool;
  };

  if (weights && weights.length > 1) {
    const quotas = quotasFor(weights, limit - picks.length);
    const heaviestFirst = [...weights.keys()].sort((a, b) => weights[b] - weights[a] || a - b);
    for (const p of heaviestFirst) {
      const pool = [];
      for (let i = 0; i < eligible.length; i++) { if (eligible[i].seedIndex === p) { pool.push(i); } }
      run(pool, quotas[p], picks.length + quotas[p], [cap]);
    }
    run(left(), limit - picks.length, limit);
  } else {
    run(left(), limit, limit);
  }
  return { picks, relaxed };
}

// Play order: the lead first, then the picks by similarity, descending, in
// bands of SPREAD_BAND rows; inside a band each row is the first whose
// artist differs from the row before it, else the band's first.
export function orderMix(picks) {
  const out = picks.filter((p) => p.lead);
  const rest = picks.filter((p) => !p.lead).sort((a, b) => b.similarity - a.similarity);
  for (let i = 0; i < rest.length; i += SPREAD_BAND) {
    const band = rest.slice(i, i + SPREAD_BAND);
    while (band.length) {
      let j = 0;
      if (out.length) {
        const prev = out[out.length - 1].artistKey;
        j = Math.max(0, band.findIndex((p) => p.artistKey !== prev));
      }
      out.push(band.splice(j, 1)[0]);
    }
  }
  return out;
}

// ── Seeds ────────────────────────────────────────────────────────────────

// Library rows of track ids — the title and primary artist a member's
// name key is built from when the index has no entry for it.
function titleRows(d, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    for (const r of d.prepare(`
      SELECT t.id, t.title, a.name AS artist_name
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
       WHERE t.id IN (${placeholders(slice.length)})
    `).all(...slice)) { out.set(r.id, r); }
  }
  return out;
}

// The item → its members (every song of it the caller can see, once per
// canonical hash: { hash, entry, nameKey, group }) and how it ranks: the
// groups of analysed members whose centroids are its points (the largest
// first, at most POINTS_MAX), their quota weights, and what the ranking
// leaves out. `lead` is the song seed's row.
//
//   song      one point, its vector; its hash and name key are left out,
//             and rankTracksMulti's near-dup guard drops its re-encodes.
//   album     one point, the centroid; its songs are left out by hash,
//             name key and (on the walk) cos ≥ NEAR_DUP to any of them —
//             never by the guard, which would judge songs by the centroid.
//   artist    a point per album (NULL album = one group), equal weights;
//             nothing left out — its own songs stay in, capped — and no
//             near-dup guard, which would drop a one-song album's song
//             (that album's centroid IS the song).
//   playlist  a point per artist (the index's identity), weighted by the
//   songs     group's share of the analysed members; left out as album.
function resolveMixSeed(req, index, from) {
  const d = db.getDB();
  const uid = req.user?.id;
  let kind;
  let rows;   // { id, hash, title?, artist_name?, album_id? }, in item order
  let lead = null;

  if (from.song !== undefined) {
    kind = 'song';
    const row = resolveSeedTrack(req, from.song, 'discovery/local/mix');
    lead = row;
    rows = [{ id: row.id, hash: row.audio_hash || row.file_hash || null, title: row.title, artist_name: row.artist_name }];
  } else if (from.album !== undefined) {
    kind = 'album';
    const { conditions, params } = albumSongConditions(from.album, libraryFilter(req.user));
    rows = d.prepare(`
      ${trackQuery(uid, { includeGenres: false })}
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.id
    `).all(...(uid ? [uid] : []), ...params)
      .map((r) => ({ id: r.id, hash: r.audio_hash || r.file_hash || null, title: r.title, artist_name: r.artist_name }));
    if (!rows.length) { throw new WebError('Album not found', 404); }
  } else if (from.artist !== undefined) {
    kind = 'artist';
    const filter = libraryFilter(req.user);
    rows = d.prepare(`
      SELECT t.id, COALESCE(t.audio_hash, t.file_hash) AS hash, t.title, t.album_id, a.name AS artist_name
        FROM tracks t JOIN artists a ON a.id = t.artist_id
       WHERE a.name_key = ? AND ${filter.clause}
       ORDER BY t.id
    `).all(nameKey(from.artist), ...filter.params);
    if (!rows.length) { throw new WebError('Artist not found', 404); }
  } else {
    let paths;
    if (from.playlist !== undefined) {
      kind = 'playlist';
      // The caller's own playlist; a caller with no user id (a federation
      // key) has none, and another user's is the same 404.
      const pl = uid
        ? d.prepare('SELECT id FROM playlists WHERE name = ? AND user_id = ?').get(from.playlist, uid)
        : null;
      if (!pl) { throw new WebError('Playlist not found', 404); }
      paths = d.prepare('SELECT filepath FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
        .all(pl.id).map((r) => r.filepath);
    } else {
      kind = 'songs';
      paths = from.songs;
    }
    rows = resolveFlowTracks(paths, req.user).filter(Boolean);
    if (!rows.length) { throw new WebError(kind === 'playlist' ? 'Playlist not found' : 'Track not found', 404); }
  }

  // Once per canonical hash, in item order.
  const members = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.hash || seen.has(r.hash)) { continue; }
    seen.add(r.hash);
    members.push({ id: r.id, hash: r.hash, row: r, entry: index.byHash.get(r.hash) ?? null });
  }
  // Name keys: the index's rule, from the library row for a member it has
  // no entry for (another, analysed file of that song must not come back).
  // Groups: the point a member's vector joins (see the kinds above).
  const unnamed = members.filter((m) => !m.entry && m.row.title === undefined).map((m) => m.id);
  const named = unnamed.length ? titleRows(d, unnamed) : new Map();
  for (const m of members) {
    const lib = named.get(m.id) ?? m.row;
    m.nameKey = sim.entryNameKey(m.entry ?? { artist: lib.artist_name, title: lib.title });
    m.group = null;
    if (kind === 'artist') { m.group = m.row.album_id ?? null; }
    if (kind === 'playlist' || kind === 'songs') { m.group = m.entry?.artistKey ?? null; }
  }

  const byGroup = new Map();
  for (const m of members) {
    if (!m.entry) { continue; }
    if (!byGroup.has(m.group)) { byGroup.set(m.group, []); }
    byGroup.get(m.group).push(m.entry.vec);
  }
  // Largest first; Map order (first appearance) breaks ties.
  const groups = [...byGroup.values()]
    .map((vecs, i) => ({ vecs, i }))
    .sort((a, b) => b.vecs.length - a.vecs.length || a.i - b.i)
    .slice(0, POINTS_MAX)
    .map((g) => g.vecs);
  const analysed = groups.reduce((s, g) => s + g.length, 0);
  const weights = kind === 'artist' ? groups.map(() => 1) : groups.map((g) => g.length / (analysed || 1));

  const leavesOut = kind !== 'artist';
  return {
    kind,
    members,
    analyzed: members.filter((m) => m.entry).length,
    groups,
    weights,
    lead,
    exclude: leavesOut ? new Set(members.map((m) => m.hash)) : null,
    excludeNameKeys: leavesOut ? new Set(members.map((m) => m.nameKey).filter(Boolean)) : null,
    // The ranking's guard judges a song against the points. A song seed's
    // point is its own vector, so the guard drops its other recordings;
    // any other point is a centroid, which a song can sit right on without
    // being any member's recording (an album's most album-like song).
    nearDup: kind === 'song' ? NEAR_DUP : Infinity,
    // Several members: cos ≥ NEAR_DUP to any of them is checked on the
    // walk instead.
    checkMembers: kind === 'album' || kind === 'playlist' || kind === 'songs',
  };
}

// ── The ranking, cached ──────────────────────────────────────────────────
//
// Ranked lists per item: a filter change re-asks the same item, and the
// scoring pass (one per point, ~25 ms each at 25k tracks) is the walk's
// cost. WeakMap on the index, the sonicPoolCache pattern (api/random.js):
// a rebuilt index drops its lists with it. An entry carries the ranking,
// the members' near-dup set, and the walk's verdicts against it, filled as
// walks reach them — filter-independent, so a re-ask reuses them. Entries
// are shared by reference; nothing but those verdicts is written.
const rankCache = new WeakMap();   // index -> Map<key, { ranked, memberDups, verdicts }>
const RANK_CACHE_MAX = 8;

// Everything the ranking depends on: the kind, the walk's budget, and each
// member's hash, point group and name key.
function rankKey(seed, limit) {
  const parts = seed.members.map((m) => `${m.hash}\u0000${m.group ?? ''}\u0000${m.nameKey ?? ''}`).sort();
  return `${seed.kind}:${limit}:${createHash('sha1').update(parts.join('\u0001')).digest('hex')}`;
}

async function rankedFor(index, seed, limit) {
  const key = rankKey(seed, limit);
  let perIndex = rankCache.get(index);
  if (!perIndex) { perIndex = new Map(); rankCache.set(index, perIndex); }
  const hit = perIndex.get(key);
  if (hit) {
    perIndex.delete(key); perIndex.set(key, hit);   // LRU touch
    return hit;
  }
  // dedupe:false — the ranking cannot see visibility, so the best file of
  // a song in a library this caller cannot open must not hide the one they
  // can; the walk dedupes what it accepts instead.
  const ranked = await sim.rankTracksMulti(index, seed.groups.map((vecs) => sim.centroidOf(vecs)), {
    exclude: seed.exclude,
    excludeNameKeys: seed.excludeNameKeys,
    nearDup: seed.nearDup,
    topK: considerBudget(limit),
    mode: 'max',
    dedupe: false,
  });
  let memberDups = null;
  if (seed.checkMembers) {
    memberDups = nearDupSet();
    for (const m of seed.members) { if (m.entry) { memberDups.add(m.entry.vec); } }
  }
  const entry = { ranked, memberDups, verdicts: memberDups ? new Uint8Array(ranked.length) : null };
  perIndex.set(key, entry);
  while (perIndex.size > RANK_CACHE_MAX) {
    perIndex.delete(perIndex.keys().next().value);
  }
  return entry;
}

// Whether ranked song `i` is the same recording as a member (cached:
// 1 = no, 2 = yes).
function dupOfMember(rank, i) {
  if (!rank.memberDups) { return false; }
  if (rank.verdicts[i] === 0) {
    rank.verdicts[i] = rank.memberDups.has(rank.ranked[i].entry.vec) ? 2 : 1;
  }
  return rank.verdicts[i] === 2;
}

// ── The probe ────────────────────────────────────────────────────────────

// The rows behind `n` canonical hashes that pass every filter, lowest id
// first: `f` is songFilterConditions' answer, `m` buildBpmKeyFilter's, and
// the hashes bind twice after their params. Driven by the rowid IN-list,
// whose two legs are visibleTracksByHash's (src/discovery/taste-queries.js)
// — together exactly COALESCE(audio_hash, file_hash) — each pinned to its
// hash index with INDEXED BY: unpinned, the file_hash leg took
// idx_tracks_audio_hash (on `audio_hash IS NULL`) at 25k tracks, and a
// migration that dropped either index now fails loudly instead of
// scanning. The outer `tracks t NOT INDEXED` (rowid lookups only) and the
// LEFT JOINs (nothing ahead of t) keep that drive under a library clause:
// with either missing, the planner sought t through idx_tracks_library on
// (library_id, rowid), once per library in scope for every hash. Pinned by
// test/db/discovery-mix.test.mjs.
function probeSql(f, m, n) {
  const ph = placeholders(n);
  return `
    SELECT t.id, COALESCE(t.audio_hash, t.file_hash) AS hash, t.title, t.filepath, l.name AS library_name,
           a.name AS artist_name, a.name_key AS artist_key, al.name AS album_name
      FROM tracks t NOT INDEXED
      LEFT JOIN artists a ON a.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
      LEFT JOIN libraries l ON l.id = t.library_id${f.ratingJoin}
     WHERE ${[...f.baseConditions, ...m.clauses].join(' AND ')}
       AND t.id IN (
             SELECT id FROM tracks INDEXED BY idx_tracks_audio_hash WHERE audio_hash IN (${ph})
             UNION ALL
             SELECT id FROM tracks INDEXED BY idx_tracks_hash WHERE file_hash IN (${ph}) AND audio_hash IS NULL
           )
     ORDER BY t.id`;
}

// hash → the lowest-id row that passes the filters and the skip words.
function passingRows(d, f, m, hashes, skip) {
  const out = new Map();
  if (hashes.length === 0) { return out; }
  const rows = d.prepare(probeSql(f, m, hashes.length)).all(...f.baseParams, ...m.params, ...hashes, ...hashes);
  for (const row of rows) {
    if (!out.has(row.hash) && !(skip && skip(row))) { out.set(row.hash, row); }
  }
  return out;
}

const NO_BPM_KEY = Object.freeze({ clauses: [], params: [] });

// ── The walk ─────────────────────────────────────────────────────────────

// The ranking in probe chunks: one row per hash (the lowest id that passes
// `f`, `m` and the skip words), the first song per name key, the item's own
// recordings out. A song a filter refuses claims nothing, so another file
// of it may still come; one that is a member's recording claims its key.
// The walk ends at `target` eligible songs once every point holds what it
// is `owed` (by point index) of the songs it ranks best for; past the
// target, a song of a point that holds its share only claims its key.
function walkRanking(d, rank, f, m, skip, { target, owed = [] }) {
  const { ranked } = rank;
  const left = [...owed];
  let owing = left.filter((n) => n > 0).length;
  const eligible = [];
  const claimed = new Set();
  let done = false;
  for (let c = 0; c < ranked.length && !done; c += PROBE_CHUNK) {
    const slice = ranked.slice(c, c + PROBE_CHUNK);
    const rows = passingRows(d, f, m, slice.map((r) => r.entry.hash), skip);
    for (let j = 0; j < slice.length && !done; j++) {
      const { entry, similarity, seedIndex } = slice[j];
      const row = rows.get(entry.hash);
      if (!row) { continue; }
      const key = sim.entryNameKey(entry);
      if (key) {
        if (claimed.has(key)) { continue; }
        claimed.add(key);
      }
      if (eligible.length >= target && !(left[seedIndex] > 0)) { continue; }
      if (dupOfMember(rank, c + j)) { continue; }
      eligible.push({ entry, vec: entry.vec, similarity, seedIndex, row, artistKey: row.artist_key ?? null });
      if (left[seedIndex] > 0 && --left[seedIndex] === 0) { owing--; }
      done = eligible.length >= target && owing === 0;
    }
  }
  return eligible;
}

async function runMix(req, body, echo) {
  const index = requireIndex();
  const seed = resolveMixSeed(req, index, body.from);
  const d = db.getDB();
  const limit = body.limit;
  const finish = (fields) => ({
    model: { id: index.modelId, version: index.modelVersion },
    seed: { kind: seed.kind, members: seed.members.length, analyzed: seed.analyzed },
    ...fields,
    ...(echo && { moods: echo }),
  });

  if (seed.groups.length === 0) {
    return finish({ notAnalyzed: true, songs: [], short: true, capped: false, relaxed: [], floor: null, filteredOut: false });
  }

  const f = songFilterConditions(req, body, { minRating: effectiveMinRating(req, body) });
  const m = buildBpmKeyFilter(body);
  const skip = skipWordsMatcher(body.skipWords);
  const rank = await rankedFor(index, seed, limit);
  const { ranked } = rank;

  // Enough eligible songs to decide the band and the ladder ends the walk:
  // 2 × limit + 64, and for an item of several points, twice each point's
  // quota among the songs it ranks best for. Ranked by best point, a tight
  // corner's neighbours can fill the target before a looser corner's first
  // song comes, and that corner's quota would go to the others.
  const eligible = walkRanking(d, rank, f, m, skip, {
    target: 2 * limit + 64,
    owed: seed.weights.length > 1 ? quotasFor(seed.weights, limit).map((q) => 2 * q) : [],
  });

  // The song seed (its kind's one member) leads when one of its files
  // passes the same probe — its own file first — so every row keeps the
  // filters' promise.
  let lead = null;
  if (seed.lead) {
    const hash = seed.members[0].hash;
    const rows = d.prepare(probeSql(f, m, 1)).all(...f.baseParams, ...m.params, hash, hash)
      .filter((r) => !(skip && skip(r)));
    const row = rows.find((r) => r.id === seed.lead.id) ?? rows[0];
    if (row) {
      const entry = seed.members[0].entry;
      lead = { entry, vec: entry.vec, similarity: 1, seedIndex: 0, row, artistKey: row.artist_key ?? null, lead: true };
    }
  }

  const { picks, relaxed } = selectMix(eligible, { limit, weights: seed.weights, lead });
  const ordered = orderMix(picks);

  // Hydrate the picks: the probe carried only what the walk reads. A song
  // deleted since its probe drops out.
  const uid = req.user?.id;
  const full = new Map();
  if (ordered.length) {
    const ids = ordered.map((p) => p.row.id);
    const hydrated = d.prepare(`${trackQuery(uid, { includeGenres: false })} WHERE t.id IN (${placeholders(ids.length)})`)
      .all(...(uid ? [uid] : []), ...ids);
    for (const row of enrichRows(d, hydrated)) { full.set(row.id, row); }
  }
  const songs = [];
  let floor = null;
  for (const p of ordered) {
    const row = full.get(p.row.id);
    if (!row) { continue; }
    const rendered = renderMetadataObj(row);
    songs.push({
      filepath: rendered.filepath,
      similarity: p.lead ? 1 : round4(p.similarity),
      metadata: toLiteMetadata(rendered.metadata),
      genreTags: p.entry?.genreTags ?? null,
    });
    if (!p.lead) { floor = floor === null ? p.similarity : Math.min(floor, p.similarity); }
  }

  // No song beyond the seed came through the walk (a seed that fills a
  // one-song mix alone is a full list): say whether the filters did it —
  // whether the same walk with no filter at all (the caller's libraries
  // and the m3u rule alone) finds a song: a member's own recording is not
  // one — or nothing is similar yet.
  const filteredOut = eligible.length === 0 && ranked.length > 0
    && walkRanking(d, rank, songFilterConditions(req, {}), NO_BPM_KEY, null, { target: 1 }).length > 0;

  const short = songs.length < limit;
  return finish({
    notAnalyzed: false,
    songs,
    short,
    // Short because the walk stopped at the budget, with more of the
    // library past it — not because the pool ran dry.
    capped: short && ranked.length >= considerBudget(limit),
    relaxed: relaxed ? ['artistCap'] : [],
    floor: floor === null ? null : Math.round(floor * 100) / 100,
    filteredOut,
  });
}

export function setup(mstream) {
  mstream.post('/api/v1/discovery/local/mix', async (req, res) => {
    const { value: body } = joiValidate(mixSchema, req.body ?? {});
    // Parsed strictly (a 400 on a bad group) before any work; applied, and
    // echoed, only while this server has scores to filter by.
    const { moods, echo } = applicableMoods(parseMoods(body.moods));
    res.json(await runMix(req, { ...body, moods }, echo));
  });
}
