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
//
// An album asked for by itself (an album and its credit, no title — an album
// card's row; recommendation.js albumPhrase) gets the release's links
// instead: the release group's page when the row carries its MBID — a
// recording or an ISRC the row may carry names one song of it, not the
// album — and the "credit album" phrase on each catalogue, in its album
// search where it has one (Apple Music and YouTube have none). The ids and
// labels are the song's; only the URLs differ.

import { CAPABILITIES, SCOPES } from '../registry.js';
import { searchPhrase, albumPhrase } from '../recommendation.js';

const enc = encodeURIComponent;

function releaseGroupLink(rec, add) {
  if (rec.releaseGroupMbid) {
    add('musicbrainz-release-group', 'MusicBrainz release group',
      `https://musicbrainz.org/release-group/${enc(rec.releaseGroupMbid)}`, 'canonical');
  }
}

function albumLinks(rec, q, add) {
  releaseGroupLink(rec, add);
  add('musicbrainz-search', 'Search MusicBrainz',
    `https://musicbrainz.org/search?type=release&method=indexed&query=${enc(q)}`, 'search');
  add('deezer-search', 'Search Deezer', `https://www.deezer.com/search/${enc(q)}/album`, 'search');
  add('apple-music-search', 'Search Apple Music', `https://music.apple.com/search?term=${enc(q)}`, 'search');
  add('youtube-search', 'Search YouTube', `https://www.youtube.com/results?search_query=${enc(q)}`, 'search');
  add('bandcamp-search', 'Search Bandcamp', `https://bandcamp.com/search?q=${enc(q)}&item_type=a`, 'search');
  add('discogs-search', 'Search Discogs', `https://www.discogs.com/search/?q=${enc(q)}&type=release`, 'search');
}

export function buildLinks(rec) {
  const links = [];
  const add = (id, label, url, kind) => links.push({ id, label, url, kind });

  const album = albumPhrase(rec);
  if (album) {
    albumLinks(rec, album, add);
    return links;
  }

  if (rec.recordingMbid) {
    add('musicbrainz-recording', 'MusicBrainz recording',
      `https://musicbrainz.org/recording/${enc(rec.recordingMbid)}`, 'canonical');
  }
  releaseGroupLink(rec, add);
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
  description: 'Links to the recording (or, for an album, the release) on MusicBrainz and to search pages on Deezer, Apple Music, YouTube, Bandcamp and Discogs. Built from the recommendation itself — no network calls, no credentials.',
  capabilities: [CAPABILITIES.LINKS],
  scope: SCOPES.SERVER,
  // Synchronous work behind the contract's Promise (no catalogue to wait on).
  resolve(rec) {
    return Promise.resolve({ links: buildLinks(rec) });
  },
});
