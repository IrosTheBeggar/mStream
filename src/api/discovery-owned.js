// What this library already has, asked for a list at a time — the batched
// owned lookup the peer browse draws its marks from (design set
// docs/designs/peer-sync, card 02 "Where each number comes from"): songs by
// hash or by tags, albums by name (and the album's own credit when the
// asker knows it), artists by name with which of their albums the library
// holds. Every answer is the server's own rule — the copy plug-in's
// (src/discovery-plugins/owned.js), scoped to the libraries the caller may
// see — so a mark on a row and a skip in a job can never disagree.
//
//   POST /api/v1/discovery/owned
//   { songs?:   [{ filepath?, hash?, audioHash?, artist?, title?, album?, track?, disk?, duration? }],
//     albums?:  [{ album, artist?, albumArtist? }],
//     artists?: [{ name, albums?: [name] }] }          each arm at most OWNED_BATCH_MAX; at least one arm
//   → { songs:   [ { vpath, filepath, by: 'hash' | 'audio-hash' | 'tags' } | null ],   one per song asked, in order
//       albums:  [ boolean ],
//       artists: [ { owned, have, missing: [name] } ] }
//
// A song answers by hash when the asker has one (a peer's full metadata
// carries it), else by tags — artist, title and album all three, told apart
// from a same-titled track by track, disc and length. An album with a
// credit is compared as the artist scopes compare (the artist by its
// normalised key, the album by normalised name); one without, by name
// alone. An artist is owned when a track of theirs, or an album credited
// to them, sits in the caller's libraries; `have` and `missing` are about
// the album names the asker sent (a peer's list of the artist's albums).
//
// A jukebox session is refused, like every discovery route that speaks for
// the account. A federation key never reaches it: the route is not on the
// read allowlist (api/federation-auth.js), and a peer's library is not a
// thing this server has.

import Joi from 'joi';
import * as db from '../db/manager.js';
import { ownedTrack, ownedAlbum, ownedArtist, libraryIdsFor } from '../discovery-plugins/owned.js';
import { refuseJukebox } from './discovery-plugin-jobs.js';
import { joiValidate } from '../util/validation.js';

// One list's worth: a panel's rows, a peer's album names for one artist.
// The body limit (maxRequestSize, 1 MB by default) is the other bound.
export const OWNED_BATCH_MAX = 500;

const text = (max) => Joi.string().trim().max(max).allow(null, '').empty('').default(null);
// Numbers as a peer's metadata carries them: a number, or its string.
const num = () => Joi.alternatives().try(Joi.number(), Joi.string().trim().max(32)).allow(null, '').empty('').default(null);

// Unknown keys are stripped, not refused: a client passes a listing's row
// straight through, and a newer client must not break an older server.
const songSchema = Joi.object({
  filepath: text(2048),
  hash: text(128),
  audioHash: text(128),
  artist: text(512),
  title: text(512),
  album: text(512),
  track: num(),
  disk: num(),
  duration: num(),
}).options({ stripUnknown: true });

const albumSchema = Joi.object({
  album: Joi.string().trim().max(512).required(),
  artist: text(512),
  albumArtist: text(512),
}).options({ stripUnknown: true });

const artistSchema = Joi.object({
  name: Joi.string().trim().max(512).required(),
  albums: Joi.array().items(Joi.string().trim().max(512).allow('')).max(OWNED_BATCH_MAX).default([]),
}).options({ stripUnknown: true });

// No defaults on the arms: a default would satisfy the "at least one arm"
// rule by itself, and an empty body must be a 400, not an empty answer.
export const ownedBodySchema = Joi.object({
  songs: Joi.array().items(songSchema).max(OWNED_BATCH_MAX),
  albums: Joi.array().items(albumSchema).max(OWNED_BATCH_MAX),
  artists: Joi.array().items(artistSchema).max(OWNED_BATCH_MAX),
}).or('songs', 'albums', 'artists');

export function setup(mstream) {
  mstream.use('/api/v1/discovery/owned', refuseJukebox);

  mstream.post('/api/v1/discovery/owned', (req, res) => {
    const { value } = joiValidate(ownedBodySchema, req.body || {});
    const database = db.getDB();
    const libraryIds = libraryIdsFor(req.user);
    const opts = { database, libraryIds };
    res.json({
      songs: (value.songs || []).map((s) => ownedTrack({ ...s, libraryIds }, database)),
      albums: (value.albums || []).map((a) => ownedAlbum(a, opts)),
      artists: (value.artists || []).map((a) => ownedArtist(a.name, { ...opts, albums: a.albums })),
    });
  });
}
