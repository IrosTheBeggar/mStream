// "links" — the base plug-in. Where else this recording can be found, as
// URLs built from the recommendation alone: no network call, no credential,
// nothing to configure, so it is the one plug-in every install can have on.
//
// Two tiers, in the order a UI should show them:
//   canonical  the exact entity — MusicBrainz recording / release group /
//              ISRC pages, only when the recommendation carries that id;
//   search     the "artist title" phrase on catalogues people actually use
//              to listen or buy. Search pages, not deep links: a deep link
//              needs a catalogue lookup, which is what the preview plug-ins
//              are for.

import { CAPABILITIES, SCOPES } from '../registry.js';
import { searchPhrase } from '../recommendation.js';

const enc = encodeURIComponent;

export function buildLinks(rec) {
  const links = [];
  const add = (id, label, url, kind) => links.push({ id, label, url, kind });

  if (rec.recordingMbid) {
    add('musicbrainz-recording', 'MusicBrainz recording',
      `https://musicbrainz.org/recording/${enc(rec.recordingMbid)}`, 'canonical');
  }
  if (rec.releaseGroupMbid) {
    add('musicbrainz-release-group', 'MusicBrainz release group',
      `https://musicbrainz.org/release-group/${enc(rec.releaseGroupMbid)}`, 'canonical');
  }
  if (rec.isrc) {
    add('musicbrainz-isrc', 'MusicBrainz ISRC',
      `https://musicbrainz.org/isrc/${enc(rec.isrc)}`, 'canonical');
  }

  const q = searchPhrase(rec);
  if (q) {
    add('musicbrainz-search', 'Search MusicBrainz',
      `https://musicbrainz.org/search?type=recording&method=indexed&query=${enc(q)}`, 'search');
    add('deezer-search', 'Search Deezer', `https://www.deezer.com/search/${enc(q)}`, 'search');
    add('apple-music-search', 'Search Apple Music', `https://music.apple.com/search?term=${enc(q)}`, 'search');
    add('youtube-search', 'Search YouTube', `https://www.youtube.com/results?search_query=${enc(q)}`, 'search');
    add('bandcamp-search', 'Search Bandcamp', `https://bandcamp.com/search?q=${enc(q)}&item_type=t`, 'search');
    add('discogs-search', 'Search Discogs', `https://www.discogs.com/search/?q=${enc(q)}&type=all`, 'search');
  }
  return links;
}

export default Object.freeze({
  name: 'links',
  title: 'Open elsewhere',
  description: 'Links to the recording on MusicBrainz and to search pages on Deezer, Apple Music, YouTube, Bandcamp and Discogs. Built from the recommendation itself — no network calls, no credentials.',
  capabilities: [CAPABILITIES.LINKS],
  scope: SCOPES.SERVER,
  // Synchronous work behind the contract's Promise (no catalogue to wait on).
  resolve(rec) {
    return Promise.resolve({ links: buildLinks(rec) });
  },
});
