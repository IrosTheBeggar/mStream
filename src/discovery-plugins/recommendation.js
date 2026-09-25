// The recommendation object every discovery plug-in receives.
//
// A recommendation is "a recording this server does NOT have, described well
// enough to find somewhere else". It is built from what the similar routes
// return today (src/api/discovery-p2p.js, src/api/discovery-federation.js):
// the catalogue facts a peer's snapshot carries (artist / title / album /
// year / isrc / release-group MBID / recording MBID / duration — discovery.db
// V3) plus provenance (which peer, which route). Plug-ins never see anything
// else, so a plug-in written against this shape works for every source.
//
// Two rules keep this the contract rather than a convenience:
//   * every field is optional and NULL when unknown — a plug-in must degrade
//     (an ISRC-only lookup falls back to artist+title, and so on);
//   * `recommendationKey()` is the identity for anything that persists a
//     recommendation (wishlist, jobs): the recording MBID when there is one,
//     else a text key over artist|title|album — the same normalisation the
//     novelty chain uses, so "the same song from two peers" collapses.

import crypto from 'node:crypto';
import Joi from 'joi';
import { norm } from '../db/discovery-novelty.js';

export const RECOMMENDATION_SOURCES = Object.freeze({
  P2P: 'p2p',               // /api/v1/discovery/p2p/similar (fetched peer snapshots)
  FEDERATION: 'federation', // /api/v1/discovery/federation/similar (paired peers, live)
  LOCAL: 'local',           // a local track handed to a plug-in on purpose
});

const text = (max) => Joi.string().trim().max(max).allow(null, '').empty('').default(null);

// Peer provenance as the two routes emit it: p2p rows carry endpointId,
// federation rows carry the numeric peer id. Both optional.
const peerSchema = Joi.object({
  endpointId: text(128),
  id: Joi.alternatives().try(Joi.number().integer(), Joi.string().max(128)).allow(null).default(null),
  name: text(128),
}).unknown(true).allow(null).default(null);

// Unknown keys (similarity, genreTags, exportId variants a client may forward
// verbatim) are stripped, not rejected — clients pass the row straight
// through, and a stricter server must not break an older client.
export const recommendationSchema = Joi.object({
  artist: text(512),
  title: text(512),
  album: text(512),
  year: Joi.number().integer().min(1000).max(9999).allow(null).default(null),
  isrc: Joi.string().trim().uppercase().pattern(/^[A-Z0-9]{12}$/).allow(null, '').empty('').default(null),
  releaseGroupMbid: text(64),
  recordingMbid: text(64),
  duration: Joi.number().min(0).allow(null).default(null),
  exportId: text(256),
  // The PEER's vpath-form path (federation rows) — the handle a stream
  // proxy or a "play from peer" plug-in needs. Never a local path.
  filepath: text(2048),
  source: Joi.string().valid(...Object.values(RECOMMENDATION_SOURCES)).default(RECOMMENDATION_SOURCES.P2P),
  peer: peerSchema,
}).options({ stripUnknown: true });

// Validate + normalise a client-supplied recommendation. Throws the Joi
// error (routes map it to a 400 through joiValidate); pure callers get a
// ready object with every field present.
export function normalizeRecommendation(input) {
  const { error, value } = recommendationSchema.validate(input ?? {});
  if (error) { throw error; }
  return value;
}

// Identity for persistence + dedupe. MBID-first: two rips of one recording
// share it. The text fallback uses the novelty chain's norm() so it agrees
// with "this library already has that song" everywhere else — norm() keeps
// letters of every script, so a Cyrillic or CJK song has a key of its own.
// A recommendation whose fields normalise to nothing at all (symbols only)
// falls back to the raw text rather than sharing one empty key.
function textKey(...parts) {
  const normed = parts.map(norm);
  if (normed.some(Boolean)) { return normed.join('|'); }
  return parts.map((p) => String(p || '').trim().toLowerCase()).join('|');
}

export function recommendationKey(rec) {
  if (rec.recordingMbid) { return `mbid:${String(rec.recordingMbid).toLowerCase()}`; }
  const digest = crypto.createHash('sha1')
    .update(textKey(rec.artist, rec.title, rec.album))
    .digest('hex');
  return `text:${digest.slice(0, 32)}`;
}

// "Artist Title" as a search phrase — the lowest common denominator every
// catalogue search page accepts. Empty when neither is known.
export function searchPhrase(rec) {
  return [rec.artist, rec.title].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim();
}

// ── Job scopes ───────────────────────────────────────────────────────────
// What a job acts on: the one song (the default), the song's whole album,
// every album of its artist, or only the artist's albums the library lacks.
// A plug-in declares the scopes it runs (registry `scopes`, ['song'] unless
// it says otherwise); the job start route keeps a wider scope in the job's
// `params` and hands it to run() as ctx.params.scope.
export const JOB_SCOPES = Object.freeze({
  SONG: 'song',
  ALBUM: 'album',
  ARTIST: 'artist',
  ARTIST_MISSING: 'artist-missing',
});

// What a scope needs from the recommendation: an album job the album's
// name, the artist jobs the artist's. The missing field's name, or null
// when the scope can run on this recommendation.
export function scopeMissing(rec, scope) {
  const has = (v) => typeof v === 'string' && v.trim().length > 0;
  if (scope === JOB_SCOPES.ALBUM) { return has(rec && rec.album) ? null : 'album'; }
  if (scope === JOB_SCOPES.ARTIST || scope === JOB_SCOPES.ARTIST_MISSING) { return has(rec && rec.artist) ? null : 'artist'; }
  return null;
}

// The identity a job dedupes on, per scope. A song job keys as the
// recommendation does; an album job on artist + album, so two songs of one
// album ask for the same album job; the artist scopes on the artist. The
// scope names the key's prefix, so a song copy and an album copy of the
// same song are two live jobs, never one deduped against the other.
export function jobKey(rec, scope = JOB_SCOPES.SONG) {
  if (!scope || scope === JOB_SCOPES.SONG) { return recommendationKey(rec); }
  const digest = (parts) => crypto.createHash('sha1').update(textKey(...parts)).digest('hex').slice(0, 32);
  if (scope === JOB_SCOPES.ALBUM) { return `album:${digest([rec.artist, rec.album])}`; }
  return `${scope}:${digest([rec.artist])}`;
}

// Every key a recommendation's jobs may sit under — one per scope its
// fields allow. What the lookup route asks the table for.
export function jobKeysFor(rec) {
  const out = {};
  for (const scope of Object.values(JOB_SCOPES)) {
    if (scopeMissing(rec, scope) === null) { out[scope] = jobKey(rec, scope); }
  }
  return out;
}
