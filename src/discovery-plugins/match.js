// Matching a recommendation against a catalogue's search results.
//
// Every catalogue plug-in has the same problem: a search for "artist title"
// returns several candidates (remasters, live takes, karaoke covers, the
// right song by the wrong artist) and one of them — or none — is the
// recording the network recommended. The rules here are the ones the
// Soulseek batch downloaders converged on (title and artist must agree,
// length within a few seconds, album breaks ties), expressed as a score so
// each plug-in only has to map its API's rows to { artist, title, album,
// durationSec, isrc } and ask for the best one.
//
// Pure: no I/O, no config. Unit-tested against handcrafted candidates.

import { norm } from '../db/discovery-novelty.js';

// Length tolerance the downloaders use by default; beyond LENGTH_REJECT_SEC
// a candidate is a different recording no matter how the names look.
export const LENGTH_TOLERANCE_SEC = 3;
export const LENGTH_REJECT_SEC = 20;
// Below this the best candidate is "no match" rather than a wrong match —
// a preview of the wrong song is worse than no preview.
export const MIN_SCORE = 0.62;

const NOISE = /\s*[([][^)\]]*(remaster|remastered|live|edit|mix|version|feat\.?|featuring|mono|stereo|demo|radio|explicit|deluxe|bonus)[^)\]]*[)\]]\s*/gi;

// Bracketed edition noise — "(2019 Remaster)", "[Live]" — is dropped before
// any comparison: it is how catalogues label the same recording, not a
// different song.
export function stripNoise(s) {
  return typeof s === 'string' ? s.replace(NOISE, ' ') : '';
}

export function tokens(s) {
  return stripNoise(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// 1 = the same after normalisation; containment (one is a prefix/superset
// such as "Opening Night" for "Opening") scores high; otherwise token Jaccard.
export function textSimilarity(a, b) {
  const na = norm(stripNoise(a));
  const nb = norm(stripNoise(b));
  if (!na || !nb) { return 0; }
  if (na === nb) { return 1; }
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) { return 0; }
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  if (inter === Math.min(sa.size, sb.size)) { return 0.85; }   // one contains the other
  return inter / (sa.size + sb.size - inter);
}

// Score one candidate against the recommendation. Returns null for a hard
// reject (an ISRC that disagrees, a length that is not the same recording),
// else 0..1.
export function scoreCandidate(rec, cand) {
  if (rec.isrc && cand.isrc) {
    return String(rec.isrc).toUpperCase() === String(cand.isrc).toUpperCase() ? 1 : null;
  }
  if (rec.duration != null && cand.durationSec != null && Number.isFinite(cand.durationSec)) {
    if (Math.abs(rec.duration - cand.durationSec) > LENGTH_REJECT_SEC) { return null; }
  }
  const title = textSimilarity(rec.title, cand.title);
  const artist = textSimilarity(rec.artist, cand.artist);
  if (title === 0 || artist === 0) { return 0; }
  let score = 0.55 * title + 0.35 * artist;
  if (rec.album && cand.album) {
    score += 0.1 * textSimilarity(rec.album, cand.album);
  } else {
    score += 0.05;   // nothing to compare — don't punish an untagged recommendation
  }
  if (rec.duration != null && cand.durationSec != null && Number.isFinite(cand.durationSec)) {
    const delta = Math.abs(rec.duration - cand.durationSec);
    if (delta <= LENGTH_TOLERANCE_SEC) { score = Math.min(1, score + 0.08); }
    else { score -= 0.1 * ((delta - LENGTH_TOLERANCE_SEC) / (LENGTH_REJECT_SEC - LENGTH_TOLERANCE_SEC)); }
  }
  return Math.max(0, Math.min(1, score));
}

// The best candidate above MIN_SCORE, or null. Ties keep the catalogue's
// own order (it ranks by popularity, which is the tie-break we want).
export function pickBestMatch(rec, candidates, { minScore = MIN_SCORE } = {}) {
  let best = null;
  let bestScore = -1;
  for (const cand of candidates || []) {
    const s = scoreCandidate(rec, cand);
    if (s === null) { continue; }
    if (s > bestScore) { best = cand; bestScore = s; }
  }
  if (!best || bestScore < minScore) { return null; }
  return { candidate: best, score: Math.round(bestScore * 1000) / 1000 };
}
