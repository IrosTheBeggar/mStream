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
// with "this library already has that song" everywhere else.
export function recommendationKey(rec) {
  if (rec.recordingMbid) { return `mbid:${String(rec.recordingMbid).toLowerCase()}`; }
  const digest = crypto.createHash('sha1')
    .update(`${norm(rec.artist)}|${norm(rec.title)}|${norm(rec.album)}`)
    .digest('hex');
  return `text:${digest.slice(0, 32)}`;
}

// "Artist Title" as a search phrase — the lowest common denominator every
// catalogue search page accepts. Empty when neither is known.
export function searchPhrase(rec) {
  return [rec.artist, rec.title].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim();
}
