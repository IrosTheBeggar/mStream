// Album identity key (V70).
//
// `albums.album_key` is the scanner's find-or-create key — the ONLY thing
// that decides whether two tracks land on the same album row:
//
//   mbid:<MusicBrainz release id>          the track carries MUSICBRAINZ_ALBUMID
//   name:<album name>|<album-artist id>    otherwise (id part empty when the
//                                          fallback chain produced no artist)
//
// Year is deliberately NOT part of the key. Pre-V70 the key was
// UNIQUE(name, artist_id, year) with year = each track's own recording
// year, so a compilation tagged with per-track original years fragmented
// into one album row per year — and the API's DISTINCT(name, year, art)
// collapse could not rejoin them. The album's year / year_min / year_max
// are aggregates over its tracks now (src/db/album-aggregate.js).
//
// The album name is used EXACTLY as tagged — no case folding, no trimming.
// A normalised key would make the row's display name depend on which track
// the parallel scanner happened to commit first ("Abbey road" vs "Abbey
// Road"), breaking the scanner's determinism contract. Name normalisation
// belongs to the artist-identity PR, which brings a deterministic display
// rule with it.
//
// Three writers build this string and MUST stay byte-identical:
//   - this function (JS scanner + manager.findOrCreateAlbum for ytdl),
//   - rust-parser/src/main.rs album_key(),
//   - the V70 migration's SQL copy: 'name:' || name || '|' || COALESCE(artist_id, '').
export function albumKey({ name, artistId = null, mbzAlbumId = null }) {
  if (mbzAlbumId) { return `mbid:${mbzAlbumId}`; }
  return `name:${name}|${artistId == null ? '' : artistId}`;
}
