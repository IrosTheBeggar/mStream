// "itunes" — a 30-second preview from the iTunes Search API.
//
// No key required. The lookup is ISRC-first (`/lookup?isrc=` — not in the
// published parameter list but long-standing), then a song search on the
// "artist title" phrase, and every result goes through match.js. Apple's
// terms ask for the "Provided courtesy of iTunes" attribution next to a
// preview and a link back to the store; both travel in the result so a
// client can show them.
//
// Apple documents roughly 20 calls per minute; the limiter stays under it
// and answers 429 rather than getting the whole server blocked, and a
// per-recommendation cache keeps repeat menu opens free.

import * as config from '../../state/config.js';
import { CAPABILITIES, SCOPES } from '../registry.js';
import { searchPhrase, recommendationKey } from '../recommendation.js';
import { pickBestMatch } from '../match.js';
import { fetchJson, RateLimiter, TtlCache, providerError } from '../http.js';

export const ITUNES_BASE = process.env.MSTREAM_ITUNES_BASE || 'https://itunes.apple.com';
const PROVIDER = 'itunes';
const ATTRIBUTION = 'Provided courtesy of iTunes';
const limiter = new RateLimiter({ tokens: 18, perMs: 60_000 });
const cache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 500 });

function settings() {
  const s = config.program && config.program.discoveryPlugins && config.program.discoveryPlugins.itunes;
  return { enabled: !s || s.enabled === true, country: (s && s.country) || 'US' };
}

export function toCandidate(r) {
  if (!r || typeof r !== 'object') { return null; }
  if (r.wrapperType && r.wrapperType !== 'track') { return null; }
  if (r.kind && r.kind !== 'song') { return null; }
  return {
    id: r.trackId ?? null,
    title: typeof r.trackName === 'string' ? r.trackName : null,
    artist: typeof r.artistName === 'string' ? r.artistName : null,
    album: typeof r.collectionName === 'string' ? r.collectionName : null,
    durationSec: Number.isFinite(r.trackTimeMillis) ? r.trackTimeMillis / 1000 : null,
    isrc: null,   // the search API never returns it
    preview: typeof r.previewUrl === 'string' && /^https?:\/\//.test(r.previewUrl) ? r.previewUrl : null,
    link: typeof r.trackViewUrl === 'string' && /^https?:\/\//.test(r.trackViewUrl) ? r.trackViewUrl : null,
    artwork: typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : null,
  };
}

function take() {
  if (!limiter.take()) { throw providerError('iTunes lookups are rate-limited right now — try again in a minute', 429); }
}

function results(j) {
  if (!j || !Array.isArray(j.results)) { return []; }
  return j.results.map(toCandidate).filter(Boolean);
}

async function byIsrc(isrc, country) {
  take();
  const j = await fetchJson(`${ITUNES_BASE}/lookup?isrc=${encodeURIComponent(isrc)}&entity=song&country=${encodeURIComponent(country)}`);
  return results(j);
}

async function search(phrase, country) {
  take();
  const j = await fetchJson(`${ITUNES_BASE}/search?term=${encodeURIComponent(phrase)}&media=music&entity=song&limit=10&country=${encodeURIComponent(country)}`);
  return results(j);
}

// Pure selection over already-fetched candidates — unit-tested directly.
export function choose(rec, candidates, { exact = false } = {}) {
  let picked;
  if (exact) {
    // An ISRC lookup is authoritative: take the first playable result.
    picked = candidates.find((c) => c.preview) || null;
    if (picked) { picked = { candidate: picked, score: 1 }; }
  } else {
    picked = pickBestMatch(rec, candidates);
    if (picked && !picked.candidate.preview) { picked = null; }
  }
  if (!picked) { return null; }
  const c = picked.candidate;
  return {
    provider: PROVIDER, url: c.preview, seconds: 30,
    title: c.title, artist: c.artist, album: c.album, link: c.link, artwork: c.artwork,
    attribution: ATTRIBUTION, match: picked.score,
  };
}

export async function findPreview(rec) {
  const { country } = settings();
  const key = `${PROVIDER}:${country}:${recommendationKey(rec)}`;
  const hit = cache.get(key);
  if (hit !== undefined) { return hit; }

  let preview = null;
  if (rec.isrc) {
    preview = choose(rec, await byIsrc(rec.isrc, country), { exact: true });
  }
  if (!preview) {
    const phrase = searchPhrase(rec);
    if (phrase) { preview = choose(rec, await search(phrase, country)); }
  }
  cache.set(key, preview);
  return preview;
}

export default Object.freeze({
  name: PROVIDER,
  title: 'Preview on iTunes',
  description: 'A 30-second preview from the iTunes Search API, matched by ISRC when the recommendation carries one, else by artist, title, album and length. No key; sends the search to Apple only when a user asks for the preview. Results carry the "Provided courtesy of iTunes" attribution and a store link.',
  capabilities: [CAPABILITIES.PREVIEW],
  scope: SCOPES.SERVER,
  async resolve(rec) {
    if (!settings().enabled) { return { preview: null }; }
    return { preview: await findPreview(rec) };
  },
});
