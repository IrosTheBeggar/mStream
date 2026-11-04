// Canonical-hash lookups shared by the mstream.db mirrors of discovery.db
// data — the model genres (genre-sync.js), the model moods (mood-sync.js)
// and the music map (map-sync.js). Singleton-free on purpose: the map
// worker (map-layout.mjs) imports it without the manager.js and config.js
// singletons genre-sync.js pulls in. It used to live in genre-sync.js,
// which re-exports it.
//
// The canonical hash is COALESCE(audio_hash, file_hash) — the key discovery
// rows, map points and user_metadata.track_hash all use.

// canonical hash → [track ids]: duplicate files share one canonical hash
// and all get the same data. One pass instead of per-row COALESCE lookups
// (which can't use the hash indexes).
export function tracksByCanonicalHash(mainDb) {
  const tracksByHash = new Map();
  for (const t of mainDb.prepare(
    'SELECT id, COALESCE(audio_hash, file_hash) AS h FROM tracks WHERE audio_hash IS NOT NULL OR file_hash IS NOT NULL'
  ).all()) {
    if (!tracksByHash.has(t.h)) { tracksByHash.set(t.h, []); }
    tracksByHash.get(t.h).push(t.id);
  }
  return tracksByHash;
}
