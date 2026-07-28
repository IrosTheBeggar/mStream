// The novelty filter shared by every "music you DON'T have" surface —
// /api/v1/discovery/p2p/similar (fetched peer snapshots) and
// /api/v1/discovery/federation/similar (live queries to federated peers).
//
// It always runs on the CALLER's side: only this machine knows what this
// library holds, and shipping its identity sets to a peer would leak the
// library wholesale. The filter is a chain because no single identity
// signal covers every collection:
//   1. recording MBID match        exact, when both sides are tagged
//   2. normalized artist+title     the pragmatic fallback
//   3. near-duplicate similarity   cosine ≥ NEAR_DUP vs the QUERY track —
//                                  catches untagged re-encodes of it
// plus opt-in `newArtistsOnly`, which drops every artist the local library
// already knows — the "introduce me to someone new" mode.

import * as db from './manager.js';
import * as discoveryDb from './discovery-db.js';

export const NEAR_DUP = 0.99;

// "The Beatles" / "beatles" / "The  Beatles!" all collide — good enough for
// an exclusion filter (false positives here just hide a result, never rank
// a wrong one).
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The local library's identity sets. Built per request — two indexed scans
// over a 10k-track library are a few ms, and a live cache would need
// scanner invalidation hooks for marginal gain.
export function localIdentitySets() {
  const sets = { mbids: new Set(), artistTitles: new Set(), artists: new Set() };
  const rows = db.getDB().prepare(`
    SELECT a.name AS artist, t.title AS title
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
  `).all();
  for (const r of rows) {
    const artist = norm(r.artist);
    if (artist) { sets.artists.add(artist); }
    sets.artistTitles.add(`${artist} ${norm(r.title)}`);
  }
  // MBIDs live in discovery.db (populated by tagging/analysis passes).
  if (discoveryDb.openDiscoveryDbIfExists()) {
    const mbids = discoveryDb.getDiscoveryDb().prepare(
      'SELECT recording_mbid FROM discovery_tracks WHERE recording_mbid IS NOT NULL'
    ).all();
    for (const r of mbids) { sets.mbids.add(r.recording_mbid); }
  }
  return sets;
}

// One candidate through the chain. `similarityVsSeed` is the candidate's
// cosine vs the QUERY track (however the caller obtained it — a local dot
// product for p2p, the peer's reported similarity for federation).
export function isNovel(sets, { artist, title, recordingMbid, similarityVsSeed }, { newArtistsOnly = false } = {}) {
  if (similarityVsSeed >= NEAR_DUP) { return false; }   // same recording, different encode
  if (recordingMbid && sets.mbids.has(recordingMbid)) { return false; }
  const a = norm(artist);
  if (sets.artistTitles.has(`${a} ${norm(title)}`)) { return false; }
  if (newArtistsOnly && a && sets.artists.has(a)) { return false; }
  return true;
}
