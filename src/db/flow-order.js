// Flow ordering — re-order a list of songs so each one flows into the next
// (POST /api/v1/db/flow, src/api/flow.js). Pure: no database, no Express, no
// config. The route resolves the songs and hands this module plain items;
// everything here is deterministic given those items and the options.
//
// Shape of the problem: an open path through the songs (a travelling-
// salesman path, optionally pinned at either end) over ONE symmetric cost
// per pair of neighbours. The cost mixes four terms, each scaled to 0–1:
//
//   sound   1 − cos of the discovery embeddings, scaled by twice the
//           request's own median pair distance (floor 0.02), capped at 1
//   tempo   |ln(b₂/b₁)| / ln(1 + 2·tol), half/double aware (+0.03 for an
//           octave match), capped at 1 — 0.5 at ±tol, 1 at ±2·tol
//   key     a Camelot-wheel table (keyCost below)
//   energy  |e₁ − e₂|, e = mean(aggressive, party, danceable, 1 − relaxed)
//
// weighted by a preset (smooth / dj) or the caller's weights, renormalised
// over the terms the request actually has, plus two flat penalties: the same
// artist twice in a row (+ARTIST_PENALTY, optional) and the same recording
// twice in a row (+SAME_RECORDING_PENALTY, twice the cost ceiling — the same
// file, the same canonical hash, cos ≥ nearDup or the same artist + title).
// Copies of one recording then touch only when it has more copies than one
// plus the other songs that can sit between them (a pinned start or end, or
// `after`, can't), and only as often as that forces — under an energy arc
// too (see arcs). That is exact for a finished solve over copies that share
// their analysis (the same file or audio hash); copies whose other terms
// differ (near duplicates, the same artist + title) follow in practice, and
// a 'budget' or 'deadline' stop can leave a pair the solver had no time to
// part. A term missing on one pair is filled with that term's mean
// over the pairs that have it (the sound fill is shrunk for songs that share
// an album or an artist, which usually do sound alike).
//
// Solver: small sub-problems (≤ EXACT_MAX movable songs, no seed) are solved
// exactly (Held–Karp). Larger ones get greedy nearest-neighbour construction
// (from the pinned start, else the best of MULTI_START starts) improved by
// 2-opt and Or-opt. Improvement stops on convergence ('complete'), on a
// DETERMINISTIC budget of move evaluations scaled to the path length
// ('budget'), or on a wall-clock safety net counted over the solver's own
// running time ('deadline'). Only a 'deadline' answer can differ between two
// identical requests. The solver yields to the event loop every SLICE_MS.
//
// Energy arcs (up / down / wave) cut the songs into ARC_BANDS energy bands,
// play the bands in the arc's order and order each band from the previous
// band's last song — 2-opt needs a symmetric cost, so the arc lives in the
// band order rather than in the edge cost. With copies in the list the bands
// are built around them (arcBands): to keep copies apart, songs on a short
// list can trade bands (not only the copies, and not only into a
// neighbouring band) and bands can merge — long lists with few copies barely
// change — and a
// recording that needs every other song between its copies is spread
// through the arc of the others.
//
// Determinism: movable songs are ranked by (rankKey, input index) before any
// node id is handed out, every tie goes to the lower node id and every
// comparison is strict. So with 'complete' or 'budget' the order depends only
// on the set of songs, the pins and the options — shuffled input, or a rerun
// over its own output, gives the same run.

import { CAMELOT_TO_KEYS } from './camelot.js';

// ── constants ───────────────────────────────────────────────────────────────

export const WEIGHT_PRESETS = Object.freeze({
  smooth: Object.freeze({ sound: 0.55, tempo: 0.20, key: 0.15, energy: 0.10 }),
  dj: Object.freeze({ sound: 0.35, tempo: 0.30, key: 0.25, energy: 0.10 }),
});
export const TERMS = Object.freeze(['sound', 'tempo', 'key', 'energy']);

// A light nudge, not a spacing rule. Measured 2026-11-02 on a 112-song,
// three-artist library and a synthetic 20 artists × 10 songs with
// artist-clustered sound: 0.10 thins same-artist neighbours (86 → 58 of 111
// and 162 → 104 of 199, against 41 and 9 in a shuffle), and the value that
// gets both down to a shuffle's level (0.30) raises the mean flow cost per
// transition by 22% and 35%. An artist's own songs sound alike; keeping them
// apart has to give up flow.
export const ARTIST_PENALTY = 0.10;
// No ordinary pair costs more than COST_CEILING: the weighted terms (≤ 1)
// plus the artist penalty. The same recording twice in a row pays twice
// that on top of its own terms, so it outweighs any two ordinary edges:
// moving one of two adjacent copies into any gap between two other songs
// (one Or-opt move) never costs more than it saves, and copies end up side
// by side only when nothing else is left to put between them.
export const COST_CEILING = 1 + ARTIST_PENALTY;
export const SAME_RECORDING_PENALTY = 2 * COST_CEILING;
// Same value as discovery-novelty.js's NEAR_DUP (a unit test pins the two
// together); restated so this module stays dependency-free.
export const SAME_RECORDING_COS = 0.99;
export const SOUND_MEDIAN_FLOOR = 0.02;
export const OCTAVE_PENALTY = 0.03;
export const EXACT_MAX = 12;
export const ARC_BANDS = 5;
export const MULTI_START = 16;
export const SEED_CHOICES = 3;
export const BUDGET_PER_N2 = 24;
export const BUDGET_FLOOR = 50_000;
export const DEADLINE_MS = 250;
export const SLICE_MS = 16;
export const CHECK_EVERY = 4096;
export const EPS = 1e-7;

export const WHY_CODES = Object.freeze([
  'soundClose', 'sameKey', 'relativeKey', 'adjacentKey', 'keyClash',
  'tempoMatch', 'halfTime', 'tempoJump', 'sameArtist', 'noData',
]);

const STATUS_RANK = { complete: 0, budget: 1, deadline: 2 };

const defaultNow = () => performance.now();
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

// ── keys ────────────────────────────────────────────────────────────────────

// One spelling of a key, folded: ♯/♭ as #/b, trimmed, whitespace runs
// collapsed, lower-cased. Tags carry every convention there is.
function foldKey(s) {
  return String(s)
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Folded spelling → Camelot code, built once. A collision (two codes folding
// to one spelling) would make parsing ambiguous, so it fails at load.
const KEY_BY_NAME = (() => {
  const m = new Map();
  for (const [code, names] of Object.entries(CAMELOT_TO_KEYS)) {
    for (const name of [code, ...names]) {
      const f = foldKey(name);
      const had = m.get(f);
      if (had !== undefined && had !== code) {
        throw new Error(`flow-order: key spelling '${name}' folds onto both ${had} and ${code}`);
      }
      m.set(f, code);
    }
  }
  return m;
})();

/**
 * A stored key in any CAMELOT_TO_KEYS spelling ("8A", "A minor", "Am",
 * "A min", "B♭ minor", …) → its canonical Camelot code, or null. Open Key
 * notation (1m–12d) is not in the table and parses as unknown.
 */
export function parseKey(raw) {
  if (raw == null) { return null; }
  const f = foldKey(raw);
  if (!f) { return null; }
  return KEY_BY_NAME.get(f) ?? KEY_BY_NAME.get(f.replace(/ /g, '')) ?? null;
}

// Wheel distance 0–6 → cost, same letter (A↔A) and across (A↔B).
const KEY_SAME = [0, 0.10, 0.5, 0.8, 0.9, 0.6, 1.0];
const KEY_DIFF = [0.10, 0.35, 0.8, 0.9, 0.9, 0.9, 1.0];

// '8A' → 0..23: (number − 1)·2 + (B ? 1 : 0).
function keyIndex(code) {
  const num = parseInt(code, 10);
  return (num - 1) * 2 + (code.endsWith('B') ? 1 : 0);
}

function keyCostIdx(ia, ib) {
  let d = Math.abs((ia >> 1) - (ib >> 1));
  if (d > 6) { d = 12 - d; }
  return (ia & 1) === (ib & 1) ? KEY_SAME[d] : KEY_DIFF[d];
}

// 24×24, by keyIndex.
const KEY_TABLE = (() => {
  const t = new Float64Array(24 * 24);
  for (let a = 0; a < 24; a++) {
    for (let b = 0; b < 24; b++) { t[a * 24 + b] = keyCostIdx(a, b); }
  }
  return t;
})();

/** Cost between two Camelot codes (symmetric, 0–1). */
export function keyCost(a, b) {
  return KEY_TABLE[keyIndex(a) * 24 + keyIndex(b)];
}

function keyDistance(ia, ib) {
  const d = Math.abs((ia >> 1) - (ib >> 1));
  return d > 6 ? 12 - d : d;
}

// ── tempo ───────────────────────────────────────────────────────────────────

function validBpm(x) {
  return Number.isFinite(x) && x > 0 ? x : null;
}

// x = |ln b₂ − ln b₁|. Writes the octave flag into `out` when given (the hot
// loops pass none and read only the cost).
function tempoFromLog(x, invScale, halfDouble, out) {
  let octave = false;
  let raw = x;
  if (halfDouble) {
    const y = Math.abs(x - Math.LN2);
    if (y < x) { raw = y; octave = true; }
  }
  const cost = Math.min(1, raw * invScale + (octave ? OCTAVE_PENALTY : 0));
  if (out) { out.octave = octave; }
  return cost;
}

const tempoScale = (tolerance) => 1 / Math.log(1 + 2 * tolerance);

/**
 * Tempo cost between two BPMs: 0 for the same tempo, 0.5 at ±tolerance,
 * 1 at ±2·tolerance (capped). With halfDouble, a half/double-time match
 * costs its scaled distance + 0.03, so 70 vs 140 costs 0.03.
 */
export function tempoCost(b1, b2, { tolerance = 0.06, halfDouble = true } = {}) {
  const out = { octave: false };
  const cost = tempoFromLog(Math.abs(Math.log(b2) - Math.log(b1)), tempoScale(tolerance), halfDouble, out);
  return { cost, octave: out.octave };
}

// ── energy ──────────────────────────────────────────────────────────────────

/**
 * An energy proxy from the mood heads: the mean of whichever of
 * aggressive, party, danceable and (1 − relaxed) are present; null when
 * none are. Mood heads are confidences, not intensities — a proxy only.
 */
export function energyOf(m) {
  if (!m) { return null; }
  let sum = 0;
  let count = 0;
  for (const k of ['aggressive', 'party', 'danceable']) {
    if (Number.isFinite(m[k])) { sum += m[k]; count++; }
  }
  if (Number.isFinite(m.relaxed)) { sum += 1 - m.relaxed; count++; }
  return count ? sum / count : null;
}

// ── small utilities ─────────────────────────────────────────────────────────

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The lower median (index (count − 1) >> 1 in sorted order) of the first
 * `count` values, by iterative quickselect with a median-of-three pivot on
 * a copy. Null for no values; never mutates its input.
 */
export function medianOf(values, count = values.length) {
  if (!count) { return null; }
  const a = new Float64Array(count);
  for (let i = 0; i < count; i++) { a[i] = values[i]; }
  const k = (count - 1) >> 1;
  let lo = 0;
  let hi = count - 1;
  const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  while (hi > lo) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < a[lo]) { swap(lo, mid); }
    if (a[hi] < a[lo]) { swap(lo, hi); }
    if (a[hi] < a[mid]) { swap(mid, hi); }
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) { i++; }
      while (a[j] > pivot) { j--; }
      if (i <= j) { swap(i, j); i++; j--; }
    }
    if (k <= j) { hi = j; } else if (k >= i) { lo = i; } else { return a[k]; }
  }
  return a[k];
}

const hasVec = (n) => n.vec != null;
const hasBpm = (n) => n.bpm != null;
const hasKey = (n) => n.key != null;
const hasEnergy = (n) => n.energy != null;
const HAS = { sound: hasVec, tempo: hasBpm, key: hasKey, energy: hasEnergy };

/**
 * Which terms this set of nodes can use: a term is present when at least
 * two nodes carry it, and used when it is present and its weight is > 0.
 */
export function signalPresence(nodes, weights) {
  const out = {};
  for (const t of TERMS) {
    let c = 0;
    for (const n of nodes) {
      if (HAS[t](n)) { c++; if (c >= 2) { break; } }
    }
    out[t] = c >= 2 && (weights?.[t] ?? 0) > 0;
  }
  return out;
}

// ── the cost matrix ─────────────────────────────────────────────────────────

function makeSlicer(now, sliceMs, yieldFn) {
  let sliceStart = now();
  return async () => {
    if (now() - sliceStart >= sliceMs) {
      await yieldFn();
      sliceStart = now();
    }
  };
}

/**
 * The symmetric N×N cost matrix over `nodes` ({vec, bpm, key (Camelot
 * code), energy, artistId, albumId, hash, recKey}). Yields between rows once
 * a slice has run sliceMs. Returns the model every solver function reads.
 */
export async function buildCostMatrix(nodes, {
  weights = WEIGHT_PRESETS.smooth,
  tempoTolerance = 0.06,
  halfDouble = true,
  artistGap = true,
  nearDup = SAME_RECORDING_COS,
  withTau = false,
  now = defaultNow,
  sliceMs = SLICE_MS,
  yieldFn = defaultYield,
} = {}) {
  const N = nodes.length;
  const slice = makeSlicer(now, sliceMs, yieldFn);
  const signals = signalPresence(nodes, weights);

  // Normalised weights over the used terms.
  let total = 0;
  for (const t of TERMS) { if (signals[t]) { total += weights[t]; } }
  const w = {};
  for (const t of TERMS) { w[t] = signals[t] && total > 0 ? weights[t] / total : 0; }

  // ── sound: 1 − cos over one contiguous buffer, upper triangle ──
  let dim = 0;
  for (const n of nodes) { if (n.vec) { dim = n.vec.length; break; } }
  const vecOk = new Uint8Array(N);
  const vb = new Float32Array(N * dim);
  for (let i = 0; i < N; i++) {
    const v = nodes[i].vec;
    if (v && v.length === dim && dim > 0) { vb.set(v, i * dim); vecOk[i] = 1; }
  }
  const soundRaw = new Float32Array(N * N).fill(NaN);
  const pairCount = (N * (N - 1)) / 2;
  const soundPairs = new Float64Array(pairCount);
  let sp = 0;
  for (let i = 0; i < N; i++) {
    if (vecOk[i]) {
      const oi = i * dim;
      for (let j = i + 1; j < N; j++) {
        if (!vecOk[j]) { continue; }
        const oj = j * dim;
        let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
        let k = 0;
        for (; k + 3 < dim; k += 4) {
          s0 += vb[oi + k] * vb[oj + k];
          s1 += vb[oi + k + 1] * vb[oj + k + 1];
          s2 += vb[oi + k + 2] * vb[oj + k + 2];
          s3 += vb[oi + k + 3] * vb[oj + k + 3];
        }
        for (; k < dim; k++) { s0 += vb[oi + k] * vb[oj + k]; }
        const r = Math.max(0, 1 - (s0 + s1 + s2 + s3));
        soundRaw[i * N + j] = r;
        soundRaw[j * N + i] = r;
        soundPairs[sp++] = soundRaw[i * N + j];
      }
    }
    await slice();
  }
  const median = Math.max(SOUND_MEDIAN_FLOOR, medianOf(soundPairs, sp) ?? 0);
  const soundScale = 1 / (2 * median);

  // ── per-node tempo / key / energy ──
  const lnBpm = new Float64Array(N);
  const keyIdx = new Int8Array(N);
  const energy = new Float64Array(N);
  const artist = new Array(N);
  const album = new Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    lnBpm[i] = n.bpm != null ? Math.log(n.bpm) : NaN;
    keyIdx[i] = n.key != null ? keyIndex(n.key) : -1;
    energy[i] = n.energy != null ? n.energy : NaN;
    artist[i] = n.artistId ?? null;
    album[i] = n.albumId ?? null;
  }
  const invTempo = tempoScale(tempoTolerance);

  // ── pass 1: per-term means over the pairs that have the term ──
  let sSum = 0; let sCnt = 0;
  let tSum = 0; let tCnt = 0;
  let kSum = 0; let kCnt = 0;
  let eSum = 0; let eCnt = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (w.sound > 0) {
        const r = soundRaw[i * N + j];
        if (r === r) { sSum += Math.min(1, r * soundScale); sCnt++; }
      }
      if (w.tempo > 0 && lnBpm[i] === lnBpm[i] && lnBpm[j] === lnBpm[j]) {
        tSum += tempoFromLog(Math.abs(lnBpm[j] - lnBpm[i]), invTempo, halfDouble); tCnt++;
      }
      if (w.key > 0 && keyIdx[i] >= 0 && keyIdx[j] >= 0) {
        kSum += KEY_TABLE[keyIdx[i] * 24 + keyIdx[j]]; kCnt++;
      }
      if (w.energy > 0 && energy[i] === energy[i] && energy[j] === energy[j]) {
        eSum += Math.abs(energy[i] - energy[j]); eCnt++;
      }
    }
  }
  const fill = {
    sound: sCnt ? sSum / sCnt : 0,
    tempo: tCnt ? tSum / tCnt : 0,
    key: kCnt ? kSum / kCnt : 0,
    energy: eCnt ? eSum / eCnt : 0,
  };

  // ── pass 2: the matrix ──
  const D = new Float32Array(N * N);
  const sameRecCut = 1 - nearDup;
  for (let i = 0; i < N; i++) {
    const ni = nodes[i];
    for (let j = i + 1; j < N; j++) {
      const nj = nodes[j];
      let c = 0;
      const r = soundRaw[i * N + j];
      if (w.sound > 0) {
        let s;
        if (r === r) {
          s = Math.min(1, r * soundScale);
        } else if (album[i] != null && album[i] === album[j]) {
          s = fill.sound * 0.6;
        } else if (artist[i] != null && artist[i] === artist[j]) {
          s = fill.sound * 0.8;
        } else {
          s = fill.sound;
        }
        c += w.sound * s;
      }
      if (w.tempo > 0) {
        c += w.tempo * (lnBpm[i] === lnBpm[i] && lnBpm[j] === lnBpm[j]
          ? tempoFromLog(Math.abs(lnBpm[j] - lnBpm[i]), invTempo, halfDouble)
          : fill.tempo);
      }
      if (w.key > 0) {
        c += w.key * (keyIdx[i] >= 0 && keyIdx[j] >= 0 ? KEY_TABLE[keyIdx[i] * 24 + keyIdx[j]] : fill.key);
      }
      if (w.energy > 0) {
        c += w.energy * (energy[i] === energy[i] && energy[j] === energy[j]
          ? Math.abs(energy[i] - energy[j])
          : fill.energy);
      }
      if (artistGap && artist[i] != null && artist[i] === artist[j]) { c += ARTIST_PENALTY; }
      if ((ni.hash != null && ni.hash === nj.hash)
        || (r === r && r <= sameRecCut)
        || (ni.recKey != null && ni.recKey === nj.recKey)) {
        c += SAME_RECORDING_PENALTY;
      }
      D[i * N + j] = c;
      D[j * N + i] = c;
    }
    await slice();
  }

  let tau = null;
  if (withTau) {
    const all = new Float64Array(pairCount);
    let p = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) { all[p++] = D[i * N + j]; }
    }
    tau = Math.max(1e-3, medianOf(all, p) ?? 0);
  }

  return {
    N, D, soundRaw, median, soundScale, tau, weights: w, signals, fill, nodes,
    lnBpm, keyIdx, energy, artist, album, invTempo,
    opts: { tempoTolerance, halfDouble, artistGap, nearDup },
  };
}

/** Everything known about one pair, for stats and explanations. */
export function pairTerms(model, a, b) {
  const { N, soundRaw, soundScale, lnBpm, keyIdx, energy, artist, nodes, opts } = model;
  const r = soundRaw[a * N + b];
  const out = {
    sound: null, soundRaw: null, tempo: null, key: null, keySame: null, keyD: null,
    energy: null, sameArtist: false, sameRecording: false,
  };
  if (r === r) { out.soundRaw = r; out.sound = Math.min(1, r * soundScale); }
  if (lnBpm[a] === lnBpm[a] && lnBpm[b] === lnBpm[b]) {
    const o = { octave: false };
    const cost = tempoFromLog(Math.abs(lnBpm[b] - lnBpm[a]), model.invTempo, opts.halfDouble, o);
    out.tempo = { cost, octave: o.octave };
  }
  if (keyIdx[a] >= 0 && keyIdx[b] >= 0) {
    out.key = KEY_TABLE[keyIdx[a] * 24 + keyIdx[b]];
    out.keySame = (keyIdx[a] & 1) === (keyIdx[b] & 1);
    out.keyD = keyDistance(keyIdx[a], keyIdx[b]);
  }
  if (energy[a] === energy[a] && energy[b] === energy[b]) { out.energy = Math.abs(energy[a] - energy[b]); }
  out.sameArtist = artist[a] != null && artist[a] === artist[b];
  const na = nodes[a];
  const nb = nodes[b];
  out.sameRecording = (na.hash != null && na.hash === nb.hash)
    || (r === r && r <= 1 - opts.nearDup)
    || (na.recKey != null && na.recKey === nb.recKey);
  return out;
}

// ── the clock ───────────────────────────────────────────────────────────────

/**
 * The solver's clock. check() counts the time since the last check as
 * running time (time spent yielded is never counted, so other requests
 * can't push an answer into 'deadline'), returns true once that reaches
 * deadlineMs, and otherwise yields when the current slice has run sliceMs.
 */
export function createClock({ now = defaultNow, deadlineMs = DEADLINE_MS, sliceMs = SLICE_MS, yieldFn = defaultYield } = {}) {
  let active = 0;
  let mark = now();
  let sliceStart = mark;
  return {
    get active() { return active; },
    async check() {
      const t = now();
      active += t - mark;
      mark = t;
      if (active >= deadlineMs) { return true; }
      if (t - sliceStart >= sliceMs) {
        await yieldFn();
        mark = now();
        sliceStart = mark;
      }
      return false;
    },
  };
}

// ── construction ────────────────────────────────────────────────────────────

function pathCost(D, N, path) {
  let c = 0;
  for (let i = 1; i < path.length; i++) { c += D[path[i - 1] * N + path[i]]; }
  return c;
}

// One greedy walk over `movable` (ascending node ids) from `cur` (a pin, or
// −1 to start at `startAt`). Writes the movable order into out[off..].
function greedyWalk(model, movable, cur, startAt, rng, out, off) {
  const { D, N, tau } = model;
  const m = movable.length;
  const used = new Uint8Array(m);
  let pos = off;
  if (startAt >= 0) {
    used[startAt] = 1;
    cur = movable[startAt];
    out[pos++] = cur;
  }
  const bi = new Int32Array(SEED_CHOICES);
  const bd = new Float64Array(SEED_CHOICES);
  const wts = new Float64Array(SEED_CHOICES);
  while (pos < off + m) {
    if (!rng) {
      let best = -1;
      let bestD = Infinity;
      for (let x = 0; x < m; x++) {
        if (used[x]) { continue; }
        const d = D[cur * N + movable[x]];
        if (d < bestD) { bestD = d; best = x; }
      }
      used[best] = 1;
      cur = movable[best];
      out[pos++] = cur;
      continue;
    }
    // Seeded: the SEED_CHOICES cheapest (ties to the lower id), weighted
    // exp(−(d − dmin)/τ), one draw.
    let k = 0;
    for (let x = 0; x < m; x++) {
      if (used[x]) { continue; }
      const d = D[cur * N + movable[x]];
      if (k < SEED_CHOICES) {
        let p = k++;
        while (p > 0 && bd[p - 1] > d) { bd[p] = bd[p - 1]; bi[p] = bi[p - 1]; p--; }
        bd[p] = d; bi[p] = x;
      } else if (d < bd[k - 1]) {
        let p = k - 1;
        while (p > 0 && bd[p - 1] > d) { bd[p] = bd[p - 1]; bi[p] = bi[p - 1]; p--; }
        bd[p] = d; bi[p] = x;
      }
    }
    let sum = 0;
    for (let c = 0; c < k; c++) { wts[c] = Math.exp(-(bd[c] - bd[0]) / tau); sum += wts[c]; }
    const r = rng() * sum;
    let pick = k - 1;
    let acc = 0;
    for (let c = 0; c < k; c++) { acc += wts[c]; if (r < acc) { pick = c; break; } }
    const x = bi[pick];
    used[x] = 1;
    cur = movable[x];
    out[pos++] = cur;
  }
}

/**
 * Greedy nearest-neighbour path: [first?] + movable + [last?]. From a pinned
 * `first` there is one walk; without one, a walk from each of the
 * MULTI_START movable nodes with the highest mean cost (outliers make good
 * path ends), keeping the cheapest (edge to `last` included).
 */
export async function greedyPath(model, movable, first = -1, last = -1, rng = null, clock = null) {
  const { D, N } = model;
  const m = movable.length;
  const L = m + (first >= 0 ? 1 : 0) + (last >= 0 ? 1 : 0);
  const off = first >= 0 ? 1 : 0;
  const out = new Int32Array(L);
  if (first >= 0) { out[0] = first; }
  if (last >= 0) { out[L - 1] = last; }
  if (m === 0) { return out; }
  if (first >= 0) {
    greedyWalk(model, movable, first, -1, rng, out, off);
    return out;
  }

  // Rank the starts: mean cost to the other movable nodes, descending,
  // ties to the lower id.
  const mean = new Float64Array(m);
  for (let x = 0; x < m; x++) {
    let s = 0;
    const r = movable[x] * N;
    for (let y = 0; y < m; y++) { if (y !== x) { s += D[r + movable[y]]; } }
    mean[x] = m > 1 ? s / (m - 1) : 0;
  }
  const order = Array.from({ length: m }, (_, x) => x);
  order.sort((a, b) => (mean[b] - mean[a]) || (movable[a] - movable[b]));
  const starts = order.slice(0, Math.min(MULTI_START, m));

  const trial = new Int32Array(L);
  if (last >= 0) { trial[L - 1] = last; }
  let bestCost = Infinity;
  for (let s = 0; s < starts.length; s++) {
    if (s > 0 && clock) { await clock.check(); }
    greedyWalk(model, movable, -1, starts[s], rng, trial, 0);
    const c = pathCost(D, N, trial);
    if (c < bestCost) { bestCost = c; out.set(trial); }
  }
  return out;
}

// ── exact solve ─────────────────────────────────────────────────────────────

/**
 * Held–Karp over k ≤ ~12 movable nodes, optionally anchored to a pinned
 * `first` and/or `last`. Returns the movable nodes in their optimal order.
 * Loops run ascending and replace on strict < only, so ties resolve the
 * same way every time.
 */
export function solveExact(model, movable, first = -1, last = -1) {
  const { D, N } = model;
  const k = movable.length;
  if (k === 0) { return new Int32Array(0); }
  const FULL = 1 << k;
  const dp = new Float64Array(FULL * k).fill(Infinity);
  const par = new Int8Array(FULL * k).fill(-1);
  for (let j = 0; j < k; j++) {
    dp[(1 << j) * k + j] = first >= 0 ? D[first * N + movable[j]] : 0;
  }
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) { continue; }
      const cur = dp[mask * k + j];
      if (cur === Infinity) { continue; }
      const row = movable[j] * N;
      for (let t = 0; t < k; t++) {
        if (mask & (1 << t)) { continue; }
        const nm = mask | (1 << t);
        const v = cur + D[row + movable[t]];
        if (v < dp[nm * k + t]) { dp[nm * k + t] = v; par[nm * k + t] = j; }
      }
    }
  }
  let bestJ = -1;
  let best = Infinity;
  for (let j = 0; j < k; j++) {
    const v = dp[(FULL - 1) * k + j] + (last >= 0 ? D[movable[j] * N + last] : 0);
    if (v < best) { best = v; bestJ = j; }
  }
  const out = new Int32Array(k);
  let mask = FULL - 1;
  let j = bestJ;
  for (let pos = k - 1; pos >= 0; pos--) {
    out[pos] = movable[j];
    const pj = par[mask * k + j];
    mask ^= 1 << j;
    j = pj;
  }
  return out;
}

// ── improvement ─────────────────────────────────────────────────────────────

// The two move kernels are plain synchronous functions over a shared state
// (st), one row of candidate moves per call: the async driver below only
// awaits between rows, so the hot loops never sit inside a resumable frame.
// E[k] caches the cost of the path edge p[k]→p[k+1]; with it, and with every
// matrix read taken along a row that is fixed for the call, an evaluation
// touches two cached rows and one sequential array instead of three random
// rows of a matrix that does not fit in cache at n = 1000.

function refreshEdges(st, from, to) {
  const { D, N, p, E, L } = st;
  const a = Math.max(0, from);
  const b = Math.min(L - 2, to);
  for (let k = a; k <= b; k++) { E[k] = D[p[k] * N + p[k + 1]]; }
}

// 2-opt from position i: try reversing p[i..j] for every j in (i, hi].
function twoOptRow(st, i) {
  const { D, N, p, L, E, hi, maxEvals } = st;
  let evals = st.evals;
  const prev = i > 0 ? p[i - 1] : -1;
  const rowPrev = prev * N;
  let rowPi = p[i] * N;
  let base = prev >= 0 ? E[i - 1] : 0;          // c(prev, p[i])
  for (let j = i + 1; j <= hi; j++) {
    if (++evals > maxEvals) { st.evals = evals; st.budget = true; return; }
    const hasNext = j < L - 1;
    // c(prev, p[j]) + c(p[i], next) − c(prev, p[i]) − c(p[j], next)
    const delta = (prev >= 0 ? D[rowPrev + p[j]] : 0)
      + (hasNext ? D[rowPi + p[j + 1]] - E[j] : 0)
      - base;
    if (delta < -EPS) {
      for (let x = i, y = j; x < y; x++, y--) { const t = p[x]; p[x] = p[y]; p[y] = t; }
      for (let x = i, y = j - 1; x < y; x++, y--) { const t = E[x]; E[x] = E[y]; E[y] = t; }
      refreshEdges(st, i - 1, i - 1);
      refreshEdges(st, j, j);
      rowPi = p[i] * N;
      base = prev >= 0 ? E[i - 1] : 0;
      st.moved = true;
    }
  }
  st.evals = evals;
}

// Or-opt for the segment p[i..i+len−1]: try every gap q outside it, in both
// orientations; apply the first improving move.
function orOptAt(st, len, i) {
  const { D, N, p, L, E, lo, hi, maxEvals, seg } = st;
  let evals = st.evals;
  const k = i + len - 1;
  const prev = i > 0 ? p[i - 1] : -1;
  const next = k < L - 1 ? p[k + 1] : -1;
  const s0 = p[i];
  const s1 = p[k];
  const r0 = s0 * N;
  const r1 = s1 * N;
  // c(prev, s0) + c(s1, next) − c(prev, next)
  const gain = (prev >= 0 ? E[i - 1] : 0) + (next >= 0 ? E[k] : 0)
    - (prev >= 0 && next >= 0 ? D[prev * N + next] : 0);
  const orients = len > 1 ? 2 : 1;
  for (let q = lo; q <= hi + 1; q++) {
    if (q >= i && q <= k + 1) { q = k + 1; continue; }
    const a = q > 0 ? p[q - 1] : -1;
    const b = q < L ? p[q] : -1;
    const ab = a >= 0 && b >= 0 ? E[q - 1] : 0;
    for (let rev = 0; rev < orients; rev++) {
      if (++evals > maxEvals) { st.evals = evals; st.budget = true; return; }
      // c(a, first) + c(last, b) − c(a, b), read along the segment's rows
      const add = rev === 0
        ? (a >= 0 ? D[r0 + a] : 0) + (b >= 0 ? D[r1 + b] : 0) - ab
        : (a >= 0 ? D[r1 + a] : 0) + (b >= 0 ? D[r0 + b] : 0) - ab;
      if (add - gain < -EPS) {
        for (let x = 0; x < len; x++) { seg[x] = rev ? p[k - x] : p[i + x]; }
        if (q < i) {
          p.copyWithin(q + len, q, i);
          for (let x = 0; x < len; x++) { p[q + x] = seg[x]; }
          refreshEdges(st, q - 1, k);
        } else {
          p.copyWithin(i, k + 1, q);
          for (let x = 0; x < len; x++) { p[q - len + x] = seg[x]; }
          refreshEdges(st, i - 1, q - 1);
        }
        st.evals = evals;
        st.moved = true;
        return;
      }
    }
  }
  st.evals = evals;
}

/**
 * 2-opt + Or-opt (runs of 1–3, both orientations) over `path`, in place.
 * Pinned ends stay put. Returns 'complete' (a round applied no move),
 * 'budget' (more than maxEvals move evaluations — deterministic) or
 * 'deadline' (the clock, checked every CHECK_EVERY evaluations at the next
 * row boundary).
 */
export async function improvePath(model, path, { pinFirst = false, pinLast = false, maxEvals = Infinity, clock = null } = {}) {
  const { D, N } = model;
  const L = path.length;
  const lo = pinFirst ? 1 : 0;
  const hi = pinLast ? L - 2 : L - 1;
  if (hi - lo < 1) { return 'complete'; }
  const st = {
    D, N, p: path, L, E: new Float64Array(L - 1), lo, hi, maxEvals,
    seg: new Int32Array(3), evals: 0, moved: false, budget: false,
  };
  refreshEdges(st, 0, L - 2);
  let nextCheck = CHECK_EVERY;
  const due = () => {
    if (!clock || st.evals < nextCheck) { return false; }
    nextCheck = st.evals + CHECK_EVERY;
    return true;
  };

  for (;;) {
    st.moved = false;
    for (let i = lo; i < hi; i++) {
      twoOptRow(st, i);
      if (st.budget) { return 'budget'; }
      if (due() && await clock.check()) { return 'deadline'; }
    }
    for (let len = 1; len <= 3; len++) {
      for (let i = lo; i + len - 1 <= hi; i++) {
        orOptAt(st, len, i);
        if (st.budget) { return 'budget'; }
        if (due() && await clock.check()) { return 'deadline'; }
      }
    }
    if (!st.moved) { return 'complete'; }
  }
}

/**
 * Order one run of movable nodes between optional pins. Returns the movable
 * nodes in order (pins stripped) and the solver status.
 */
export async function solveRun(model, movable, {
  first = -1, last = -1, rng = null, exactMax = EXACT_MAX, maxEvals, budgetScale = BUDGET_PER_N2, clock,
} = {}) {
  if (movable.length <= 1) { return { path: Int32Array.from(movable), status: 'complete' }; }
  if (!rng && movable.length <= exactMax) {
    return { path: solveExact(model, movable, first, last), status: 'complete' };
  }
  const clk = clock ?? createClock();
  const full = await greedyPath(model, movable, first, last, rng, clk);
  const L = full.length;
  const budget = maxEvals ?? Math.max(BUDGET_FLOOR, budgetScale * L * L);
  const status = await improvePath(model, full, { pinFirst: first >= 0, pinLast: last >= 0, maxEvals: budget, clock: clk });
  const from = first >= 0 ? 1 : 0;
  const to = last >= 0 ? L - 1 : L;
  return { path: full.slice(from, to), status };
}

// ── arcs ────────────────────────────────────────────────────────────────────
//
// An arc plays energy bands in its order and solves each band from the
// previous band's last song (the last band into a joining `end`). That first
// edge carries the same-recording penalty, so a band never opens with a copy
// of the song before it while it holds anything else — but copies of one
// recording share an energy, so a plain energy cut can hand one band nothing
// but copies, or nothing but copies of the song the band before it may end
// on. When the list holds copies, the bands are built for them, by the bound
// in copiesForced:
//
//  · One recording needs every other song between two of its copies (it
//    forces copies together, or only just doesn't): the bands are cut over
//    the OTHER songs and each gets as many of its copies as it has other
//    songs — one more in the first band unless the song before the run is a
//    copy, one fewer in a last band that runs into a copy as `end` — and the
//    spare copies go to the band of the recording's own energy. Every band
//    then ends on a copy, and the run has exactly the touching copies a
//    steady order has.
//  · Otherwise every band must be able to keep its copies apart whatever
//    song the band before it ends on. Copies near a band's energy edge trade
//    places with songs in other bands, the helpful trade across the smallest
//    energy gap first, until that holds; only when no trade helps are two
//    neighbouring bands merged
//    (one band is the steady solve, which always can).
//
// Same-recording groups are closed transitively (a closure only adds
// conflicts). The guarantee leans on each band's solve reaching its fewest
// touching copies, which holds for the exact solve and for a converged
// Or-opt with copies that share their analysis: moving one of two touching
// copies into a free gap always pays. Lists without copies keep the plain
// cut.

const ARC_PLAY = {
  up: (B) => Array.from({ length: B }, (_, b) => b),
  down: (B) => Array.from({ length: B }, (_, b) => B - 1 - b),
  wave: (B) => {
    const out = [];
    for (let b = 0; b < B; b += 2) { out.push(b); }
    for (let b = B - 1; b >= 0; b--) { if (b % 2 === 1) { out.push(b); } }
    return out;
  },
};

// A same-recording pair pays SAME_RECORDING_PENALTY on top of its terms and
// no ordinary pair costs more than COST_CEILING, so the midpoint tells them
// apart in the matrix.
const SAME_RECORDING_CUT = (COST_CEILING + SAME_RECORDING_PENALTY) / 2;

// 2K − L − 1 + f for one group (see copiesForced): > 0 forces that many
// touching pairs, 0 means only an order with the group at every other
// place keeps them apart.
function groupSlack(c, m, pre, post) {
  const K = c + (pre === true ? 1 : 0) + (post === true ? 1 : 0);
  const L = m + (pre === null ? 0 : 1) + (post === null ? 0 : 1);
  const f = (pre === false ? 1 : 0) + (post === false ? 1 : 0);
  return 2 * K - L - 1 + f;
}

/**
 * The fewest touching pairs from one group that any order of a run can
 * have. The run is `m` songs, `c` of them from the group; `pre` / `post`
 * say whether the song fixed before / after the run is from the group
 * (true), another song (false) or absent (null). With K group members among
 * the L songs and f fixed ends that are other songs it is
 * max(0, 2K − L − 1 + f); a run's fewest touching copies is the largest of
 * these over its groups (only one group can force any).
 */
export function copiesForced(c, m, pre = null, post = null) {
  return Math.max(0, groupSlack(c, m, pre, post));
}

// Same-recording groups among `ids`: union-find over the penalised pairs.
// grp[id] is the group's lowest node id (−1 outside `ids`); size[g] counts
// its members.
function recordingGroups(model, ids) {
  const { D, N } = model;
  const root = new Int32Array(N).fill(-1);
  for (const id of ids) { root[id] = id; }
  const find = (x) => {
    let r = x;
    while (root[r] !== r) { r = root[r]; }
    for (let y = x; root[y] !== r;) { const up = root[y]; root[y] = r; y = up; }
    return r;
  };
  for (let a = 0; a < ids.length; a++) {
    const row = ids[a] * N;
    for (let b = a + 1; b < ids.length; b++) {
      if (D[row + ids[b]] > SAME_RECORDING_CUT) {
        const ra = find(ids[a]);
        const rb = find(ids[b]);
        if (ra < rb) { root[rb] = ra; } else if (rb < ra) { root[ra] = rb; }
      }
    }
  }
  const grp = new Int32Array(N).fill(-1);
  const size = new Int32Array(N);
  for (const id of ids) { grp[id] = find(id); size[grp[id]]++; }
  return { grp, size };
}

// `list` (energy order) cut into B equal bands, in energy order.
function energyCut(list, B) {
  const out = [];
  for (let b = 0; b < B; b++) {
    out.push(list.slice(Math.floor((b * list.length) / B), Math.floor(((b + 1) * list.length) / B)));
  }
  return out;
}

// One recording (`inR`) needs every other song between two of its copies:
// bands over the other songs, each topped up with copies (see above).
// Returns the bands in play order.
function bandsAroundOne(sorted, e, inR, play, bands, preR, postR) {
  const rs = sorted.filter(inR);
  const others = sorted.filter((id) => !inR(id));
  if (!others.length) { return [rs]; }
  const B = Math.min(bands, others.length);
  const cut = energyCut(others, B);
  const order = play(B);
  const need = cut.map((band) => band.length);
  if (preR !== true) { need[order[0]]++; }
  if (postR === true) { need[order[B - 1]]--; }
  // The spare copies go to the band holding the recording's (median) energy.
  const eR = e(rs[(rs.length - 1) >> 1]);
  let below = 0;
  while (below < others.length - 1 && e(others[below]) < eR) { below++; }
  let home = 0;
  while (Math.floor(((home + 1) * others.length) / B) <= below) { home++; }
  need[home] += rs.length - need.reduce((s, x) => s + x, 0);
  let k = 0;
  for (let b = 0; b < B; b++) {
    for (let j = 0; j < need[b]; j++) { cut[b].push(rs[k++]); }
  }
  return order.map((b) => cut[b]);
}

// No recording needs that: start from the plain energy cut, then trade
// copies with songs in other bands (smallest energy gap first) until every
// band can keep its copies apart whatever the band before it ends on,
// merging neighbouring bands only when no trade helps. Returns the bands in
// play order.
function bandsApart(sorted, e, play, bands, grp, size, prev, end, N) {
  let cur = (() => {
    const cut = energyCut(sorted, Math.min(bands, sorted.length));
    return play(cut.length).map((b) => cut[b]);
  })();
  const multi = (g) => size[g] > 1;
  let where;
  let cnt;                       // per band: group → members (groups of 2+)
  const index = () => {
    where = new Int32Array(N).fill(-1);
    cnt = cur.map(() => new Map());
    cur.forEach((band, p) => {
      for (const id of band) {
        where[id] = p;
        if (multi(grp[id])) { cnt[p].set(grp[id], (cnt[p].get(grp[id]) ?? 0) + 1); }
      }
    });
  };
  // Touching pairs group g forces in band p at worst: the previous band may
  // end on any of its songs.
  const forced = (p, g) => {
    const c = cnt[p].get(g) ?? 0;
    if (!c) { return 0; }
    let pre;
    if (p > 0) { pre = (cnt[p - 1].get(g) ?? 0) > 0; } else { pre = prev < 0 ? null : grp[prev] === g; }
    const post = p === cur.length - 1 && end >= 0 ? grp[end] === g : null;
    return copiesForced(c, cur[p].length, pre, post);
  };
  const excess = (p) => {
    let s = 0;
    for (const g of cnt[p].keys()) { s += forced(p, g); }
    return s;
  };
  const total = () => {
    let s = 0;
    for (let p = 0; p < cur.length; p++) { s += excess(p); }
    return s;
  };
  const move = (id, from, to) => {
    const g = grp[id];
    if (!multi(g)) { return; }
    cnt[from].set(g, cnt[from].get(g) - 1);
    cnt[to].set(g, (cnt[to].get(g) ?? 0) + 1);
  };
  // Change in total if x and y traded bands: only their groups, in their
  // bands and the bands right after, can change.
  const swapDelta = (x, y) => {
    const bx = where[x];
    const by = where[y];
    const gx = grp[x];
    const gy = multi(grp[y]) ? grp[y] : -1;
    const sum = () => {
      let s = 0;
      const add = (p) => {
        if (p >= cur.length) { return; }
        s += forced(p, gx);
        if (gy >= 0) { s += forced(p, gy); }
      };
      add(bx);
      add(bx + 1);
      if (by !== bx + 1) { add(by); }
      if (by + 1 !== bx) { add(by + 1); }
      return s;
    };
    const before = sum();
    move(x, bx, by);
    move(y, by, bx);
    const after = sum();
    move(x, by, bx);
    move(y, bx, by);
    return after - before;
  };
  const pos = new Int32Array(N);
  sorted.forEach((id, k) => { pos[id] = k; });
  // The nearest-energy song y whose trade with x lowers the total, or null.
  const nearestSwap = (x) => {
    const ex = e(x);
    let lo = pos[x] - 1;
    let hi = pos[x] + 1;
    while (lo >= 0 || hi < sorted.length) {
      const dl = lo >= 0 ? ex - e(sorted[lo]) : Infinity;
      const dh = hi < sorted.length ? e(sorted[hi]) - ex : Infinity;
      const y = dl <= dh ? sorted[lo--] : sorted[hi++];
      if (where[y] === where[x] || grp[y] === grp[x]) { continue; }
      if (swapDelta(x, y) < 0) { return y; }
    }
    return null;
  };

  index();
  while (total() > 0 && cur.length > 1) {
    let p = 0;
    while (excess(p) === 0) { p++; }
    const bad = new Set([...cnt[p].keys()].filter((g) => forced(p, g) > 0));
    // Candidates: each offending group's song nearest its band's energy
    // edge, in band p and in the band before it. Whether a trade helps
    // depends only on the two songs' bands and groups, so one candidate per
    // band and group says it all. Of the trades that help, the one across
    // the smallest energy gap is made (ties to the candidate nearest an edge,
    // then the lower node id): on a short list the first candidate's trade
    // can pull a song far across the arc when another's is near.
    const reps = new Map();
    for (const q of p > 0 ? [p - 1, p] : [p]) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const id of cur[q]) { lo = Math.min(lo, e(id)); hi = Math.max(hi, e(id)); }
      for (const id of cur[q]) {
        if (!bad.has(grp[id])) { continue; }
        const d = Math.min(e(id) - lo, hi - e(id));
        const had = reps.get(`${q}|${grp[id]}`);
        if (!had || d < had[0] || (d === had[0] && id < had[1])) { reps.set(`${q}|${grp[id]}`, [d, id]); }
      }
    }
    let x = -1;
    let y = null;
    let gap = Infinity;
    for (const [, r] of [...reps.values()].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))) {
      const s = nearestSwap(r);
      if (s != null && Math.abs(e(r) - e(s)) < gap) { gap = Math.abs(e(r) - e(s)); x = r; y = s; }
    }
    if (y != null) {
      const bx = where[x];
      const by = where[y];
      cur[bx][cur[bx].indexOf(x)] = y;
      cur[by][cur[by].indexOf(y)] = x;
      where[x] = by;
      where[y] = bx;
      move(x, bx, by);
      move(y, by, bx);
      continue;
    }
    // No swap helps: merge band p with the neighbour that leaves less.
    let pick = null;
    let pickTotal = Infinity;
    const was = cur;
    for (const q of [p - 1, p]) {
      if (q < 0 || q + 1 >= was.length) { continue; }
      cur = [...was.slice(0, q), [...was[q], ...was[q + 1]], ...was.slice(q + 2)];
      index();
      const t = total();
      if (t < pickTotal) { pickTotal = t; pick = cur; }
    }
    cur = pick;
    index();
  }
  return cur;
}

/**
 * Cut the movable nodes into min(bands, m) equal energy bands (a missing
 * energy counts as the lower median of the present ones) and return them in
 * the arc's play order, each band sorted by node id. With copies of one
 * recording among them (model.D, `prev` = the node fixed before the run,
 * `end` = the node joining after it, −1 for none), the bands are built so the
 * banded solve keeps copies as far apart as a steady order would (see
 * above).
 */
export function arcBands(model, movable, arc, bands = ARC_BANDS, { prev = -1, end = -1 } = {}) {
  const m = movable.length;
  const play = ARC_PLAY[arc];
  if (!play || m === 0) { return [Int32Array.from(movable)]; }
  const present = [];
  for (const id of movable) {
    const e = model.energy[id];
    if (e === e) { present.push(e); }
  }
  const fillE = medianOf(present) ?? 0;
  const e = (id) => (model.energy[id] === model.energy[id] ? model.energy[id] : fillE);
  const sorted = Array.from(movable).sort((a, b) => (e(a) - e(b)) || (a - b));
  const finish = (cut) => cut.map((band) => Int32Array.from(band).sort());
  const plain = () => {
    const cut = energyCut(sorted, Math.min(bands, m));
    return finish(play(cut.length).map((b) => cut[b]));
  };
  if (!model.D) { return plain(); }

  const { grp, size } = recordingGroups(model, [...movable, ...[prev, end].filter((x) => x >= 0)]);
  const count = new Map();
  for (const id of movable) {
    if (size[grp[id]] > 1) { count.set(grp[id], (count.get(grp[id]) ?? 0) + 1); }
  }
  if (!count.size) { return plain(); }
  const side = (pin, g) => (pin < 0 ? null : grp[pin] === g);
  let R = -1;
  let worst = -Infinity;
  for (const [g, c] of count) {
    const s = groupSlack(c, m, side(prev, g), side(end, g));
    if (s > worst || (s === worst && g < R)) { worst = s; R = g; }
  }
  if (worst >= 0) {
    return finish(bandsAroundOne(sorted, e, (id) => grp[id] === R, play, bands, side(prev, R), side(end, R)));
  }
  return finish(bandsApart(sorted, e, play, bands, grp, size, prev, end, model.N));
}

// ── reporting ───────────────────────────────────────────────────────────────

const round = (x, places) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

/**
 * Quality numbers over one path of real nodes: transitions, mean cost, mean
 * raw sound distance (1 − cos), tempo-OK and key-OK shares (percent, over
 * the pairs that have the data), key clashes, same-artist neighbours and the
 * worst single transition. Means and shares are null without data.
 */
export function pathStats(model, nodePath) {
  const { D, N } = model;
  const transitions = Math.max(0, nodePath.length - 1);
  let cost = 0; let worst = null;
  let sSum = 0; let sCnt = 0;
  let tOk = 0; let tCnt = 0;
  let kOk = 0; let kCnt = 0; let clash = 0;
  let repeats = 0;
  for (let i = 1; i < nodePath.length; i++) {
    const a = nodePath[i - 1];
    const b = nodePath[i];
    const d = D[a * N + b];
    cost += d;
    if (worst === null || d > worst) { worst = d; }
    const t = pairTerms(model, a, b);
    if (t.soundRaw != null) { sSum += t.soundRaw; sCnt++; }
    if (t.tempo) {
      tCnt++;
      if (t.tempo.cost - (t.tempo.octave ? OCTAVE_PENALTY : 0) <= 0.5 + 1e-9) { tOk++; }
    }
    if (t.key != null) {
      kCnt++;
      if (t.key <= 0.10 + 1e-9) { kOk++; }
      if (t.key >= 0.6 - 1e-9) { clash++; }
    }
    if (t.sameArtist) { repeats++; }
  }
  return {
    transitions,
    meanCost: transitions ? round(cost / transitions, 4) : null,
    meanSound: sCnt ? round(sSum / sCnt, 4) : null,
    tempoOk: tCnt ? round((100 * tOk) / tCnt, 1) : null,
    keyOk: kCnt ? round((100 * kOk) / kCnt, 1) : null,
    keyClash: clash,
    artistRepeats: repeats,
    worst: worst === null ? null : round(worst, 4),
  };
}

/** Why one transition works (or doesn't), as WHY_CODES in their fixed order. */
export function transitionWhy(model, a, b) {
  const t = pairTerms(model, a, b);
  const why = new Set();
  if (t.sound != null && t.sound <= 0.25) { why.add('soundClose'); }
  if (t.key != null) {
    if (t.keyD === 0 && t.keySame) { why.add('sameKey'); }
    if (t.keyD === 0 && !t.keySame) { why.add('relativeKey'); }
    if (t.keyD === 1) { why.add('adjacentKey'); }
    if (t.key >= 0.6 - 1e-9) { why.add('keyClash'); }
  }
  if (t.tempo) {
    if (!t.tempo.octave && t.tempo.cost <= 0.5 + 1e-9) { why.add('tempoMatch'); }
    if (t.tempo.octave && t.tempo.cost <= 0.5 + OCTAVE_PENALTY + 1e-9) { why.add('halfTime'); }
    if (t.tempo.cost >= 1) { why.add('tempoJump'); }
  }
  if (t.sameArtist) { why.add('sameArtist'); }
  if (t.sound == null && !t.tempo && t.key == null) { why.add('noData'); }
  return WHY_CODES.filter((c) => why.has(c));
}

// ── the whole request ───────────────────────────────────────────────────────

const worse = (a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a);

/**
 * Order a list. `items[i]` is null (could not be resolved: unplaced) or
 * { rankKey, vec, bpm, key (raw tag), energy, artistId, albumId, hash,
 * recKey }. Returns { order (a permutation of 0..n−1), unplaced,
 * unanalysed, signals, arc, solver, stats, transitions?, endIndex }.
 *
 * Layout: [start] + the ordered run + unanalysed (input order) + unplaced
 * (input order) + [end]. `start` is always first and `end` always last,
 * whatever their class; a pin joins the solve only when it is placed, and
 * `end` only when nothing sits between it and the run (a tail of
 * unanalysed or unplaced songs leaves the run's last song free). Transitions
 * and stats cover exactly the neighbouring pairs of `order` that are both
 * placed; `endIndex` is the last placed song of `order`.
 */
export async function solveFlow(items, {
  start = null, end = null, after = null, weights = WEIGHT_PRESETS.smooth, arc = 'steady',
  tempoTolerance = 0.06, halfDouble = true, artistGap = true, seed = null, explain = false,
  nearDup = SAME_RECORDING_COS, exactMax = EXACT_MAX, maxEvals, budgetScale = BUDGET_PER_N2,
  deadlineMs = DEADLINE_MS, sliceMs = SLICE_MS, now = defaultNow, yieldFn = defaultYield,
} = {}) {
  const n = items.length;

  // One vector width per request (the route hands out vectors from one
  // index; anything else is dropped rather than mixed).
  let dim = 0;
  for (const it of items) { if (it?.vec?.length) { dim = it.vec.length; break; } }
  if (!dim && after?.vec?.length) { dim = after.vec.length; }
  const vecOf = (v) => (v && v.length && v.length === dim ? v : null);

  // ── classify ──
  const cls = new Int8Array(n);        // 0 placed, 1 unanalysed, 2 unplaced
  const feats = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it == null) { cls[i] = 2; continue; }
    const f = {
      index: i,
      rankKey: String(it.rankKey ?? ''),
      vec: vecOf(it.vec),
      bpm: validBpm(it.bpm),
      key: parseKey(it.key),
      energy: Number.isFinite(it.energy) ? it.energy : null,
      artistId: it.artistId ?? null,
      albumId: it.albumId ?? null,
      hash: it.hash ?? null,
      recKey: it.recKey ?? null,
    };
    feats[i] = f;
    cls[i] = f.vec || f.bpm != null || f.key != null ? 0 : 1;
  }
  const unplaced = [];
  const unanalysed = [];
  for (let i = 0; i < n; i++) {
    if (cls[i] === 2) { unplaced.push(i); } else if (cls[i] === 1) { unanalysed.push(i); }
  }
  const isPin = (i) => i === start || i === end;
  const placed = [];
  for (let i = 0; i < n; i++) { if (cls[i] === 0) { placed.push(i); } }

  // ── nodes: movable (ranked), then the placed pins, then `after` ──
  const movableIdx = placed.filter((i) => !isPin(i));
  movableIdx.sort((a, b) => {
    const ka = feats[a].rankKey;
    const kb = feats[b].rankKey;
    if (ka < kb) { return -1; }
    if (ka > kb) { return 1; }
    return a - b;
  });
  const nodes = movableIdx.map((i) => feats[i]);
  const M = nodes.length;
  let startNode = -1;
  let endNode = -1;
  let afterNode = -1;
  if (start != null && cls[start] === 0) { startNode = nodes.length; nodes.push(feats[start]); }
  if (end != null && cls[end] === 0) { endNode = nodes.length; nodes.push(feats[end]); }
  if (after) {
    const a = {
      index: -1, rankKey: '', vec: vecOf(after.vec), bpm: validBpm(after.bpm), key: parseKey(after.key),
      energy: null, artistId: null, albumId: null, hash: null, recKey: null,
    };
    if (a.vec || a.bpm != null || a.key != null) { afterNode = nodes.length; nodes.push(a); }
  }

  const tail = (list) => list.filter((i) => !isPin(i));
  const tailIdx = [...tail(unanalysed), ...tail(unplaced)];
  // A placed `end` neighbours the run only when no tail sits between them;
  // otherwise that edge never plays and must not steer the solve or the stats.
  const endJoins = endNode >= 0 && tailIdx.length === 0;
  const lastPlaced = (seq) => {
    for (let k = seq.length - 1; k >= 0; k--) { if (cls[seq[k]] === 0) { return seq[k]; } }
    return null;
  };
  const signalsUsed = signalPresence(nodes, weights);

  // ── nothing to order by: input order, pins honoured ──
  if (placed.length < 2 || !TERMS.some((t) => signalsUsed[t])) {
    const order = [];
    if (start != null) { order.push(start); }
    for (let i = 0; i < n; i++) { if (!isPin(i)) { order.push(i); } }
    if (end != null) { order.push(end); }
    const result = {
      order, unplaced, unanalysed,
      signals: { sound: false, tempo: false, key: false, energy: false },
      arc: 'steady', solver: 'complete', stats: null, endIndex: lastPlaced(order),
    };
    if (explain) { result.transitions = []; }
    return result;
  }

  const model = await buildCostMatrix(nodes, {
    weights, tempoTolerance, halfDouble, artistGap, nearDup, withTau: seed != null, now, sliceMs, yieldFn,
  });
  const rng = seed != null ? mulberry32(seed) : null;
  const clock = createClock({ now, deadlineMs, sliceMs, yieldFn });

  const movable = Int32Array.from({ length: M }, (_, x) => x);
  let withEnergy = 0;
  for (let x = 0; x < M; x++) { if (nodes[x].energy != null) { withEnergy++; } }
  const arcApplies = arc !== 'steady' && withEnergy >= 2;
  const preRun = startNode >= 0 ? startNode : afterNode;
  const bands = arcApplies
    ? arcBands(model, movable, arc, ARC_BANDS, { prev: preRun, end: endJoins ? endNode : -1 })
    : [movable];

  let solver = 'complete';
  const runNodes = [];
  let prev = preRun;
  let lastBand = -1;
  for (let b = 0; b < bands.length; b++) { if (bands[b].length) { lastBand = b; } }
  for (let b = 0; b < bands.length; b++) {
    if (!bands[b].length) { continue; }
    const { path, status } = await solveRun(model, bands[b], {
      first: prev, last: b === lastBand && endJoins ? endNode : -1, rng, exactMax, maxEvals, budgetScale, clock,
    });
    solver = worse(solver, status);
    for (const id of path) { runNodes.push(id); }
    prev = path[path.length - 1];
  }

  const fullRun = [];
  if (startNode >= 0) { fullRun.push(startNode); }
  for (const id of runNodes) { fullRun.push(id); }
  if (endJoins) { fullRun.push(endNode); }

  const order = [];
  if (start != null) { order.push(start); }
  for (const id of runNodes) { order.push(nodes[id].index); }
  for (const i of tailIdx) { order.push(i); }
  if (end != null) { order.push(end); }

  const before = fullRun.slice().sort((a, b) => nodes[a].index - nodes[b].index);
  const result = {
    order, unplaced, unanalysed,
    signals: { ...model.signals },
    arc: arcApplies ? arc : 'steady',
    solver,
    stats: { before: pathStats(model, before), after: pathStats(model, fullRun) },
    endIndex: lastPlaced(order),
  };
  if (explain) {
    result.transitions = [];
    for (let k = 1; k < fullRun.length; k++) {
      const a = fullRun[k - 1];
      const b = fullRun[k];
      result.transitions.push({
        from: nodes[a].index, to: nodes[b].index,
        cost: round(model.D[a * model.N + b], 4),
        why: transitionWhy(model, a, b),
      });
    }
  }
  return result;
}
