// "federation-play" — full-length playback of a PAIRED peer's recommendation
// through this server's federation stream proxy
// (GET /api/v1/federation/peers/:id/stream/<vpath-path>, src/api/federation-stream.js).
//
// A federation recommendation already names the peer and the track's path in
// the peer's own vpath namespace; the proxy route already streams it under
// this server's normal user auth. This plug-in only joins the two so every
// client (the webapp, the mobile app, anything on the plug-in API) gets a
// playable URL the same way it gets links and previews — no federation
// knowledge required client-side. The URL is server-relative and carries
// no token: a client appends the same `?token=` its /media URLs use.
//
// Nothing leaves the federation, so it defaults ON; it answers null (not an
// error) for anything it cannot play: a network (p2p) row, a peer this
// server is not paired with, or federation switched off.

import * as config from '../../state/config.js';
import * as fedDb from '../../db/federation.js';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { RECOMMENDATION_SOURCES } from '../recommendation.js';

export function streamPath(peerId, filepath) {
  const segments = String(filepath).split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  return `/api/v1/federation/peers/${peerId}/stream/${segments.map(encodeURIComponent).join('/')}`;
}

export function playFor(rec, { federationEnabled, getPeer }) {
  if (rec.source !== RECOMMENDATION_SOURCES.FEDERATION) { return null; }
  if (federationEnabled !== true) { return null; }
  if (typeof rec.filepath !== 'string' || !rec.filepath.trim()) { return null; }
  const id = rec.peer && rec.peer.id != null ? Number(rec.peer.id) : NaN;
  if (!Number.isInteger(id) || id <= 0) { return null; }
  const peer = getPeer(id);
  if (!peer) { return null; }
  return {
    kind: 'stream',
    url: streamPath(id, rec.filepath),
    peer: { id, name: peer.name },
    title: rec.title, artist: rec.artist, album: rec.album, duration: rec.duration,
  };
}

export default Object.freeze({
  name: 'federation-play',
  title: 'Play from peer',
  description: 'Plays a paired server\'s recommendation through this server\'s federation stream proxy. Nothing leaves the federation; answers null for network rows or peers this server is not paired with.',
  capabilities: [CAPABILITIES.PLAY],
  scope: SCOPES.SERVER,
  resolve(rec) {
    const play = playFor(rec, {
      federationEnabled: !!(config.program && config.program.federation && config.program.federation.enabled === true),
      getPeer: (id) => fedDb.getFederationPeerById(id),
    });
    return Promise.resolve({ play });
  },
});
