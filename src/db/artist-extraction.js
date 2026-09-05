/**
 * Per-file artist tag extraction for the scanner.
 *
 * Parses a music-metadata result into a structured {trackArtists,
 * albumArtists, roleCredits, isCompilation, displays} shape consumed by
 * src/db/scanner.mjs. A byte-identical Rust mirror lives in
 * rust-parser/src/main.rs (see extract_track / resolve_credits there). Any
 * change to the fallback rules, the delimiter list, the split rules or the
 * per-format tag keys MUST land in both.
 *
 * Tag alias sources are taken verbatim from Navidrome's `mappings.yaml`
 * so mStream's behaviour matches a widely-deployed reference. Split
 * delimiters are likewise Navidrome's defaults — the order matters
 * (longest / most-specific first) because we do a sequential replace.
 *
 * V72 split rules (Navidrome's, adopted whole):
 *   - a tag with TWO OR MORE values (Vorbis plural ARTIST, ID3v2.4
 *     null-separated, MP4 arrays) is honoured verbatim — its entries are
 *     never split again, so "Simon & Garfunkel; Art Garfunkel" as one of two
 *     values stays one artist;
 *   - a SINGLE value is split on the delimiter list, except for the names in
 *     `scanOptions.artistSplitExceptions` (exact spelling), which survive
 *     the split intact;
 *   - the display string is the tag as written: the single value verbatim,
 *     or the plural values joined with ", ".
 *
 * Which tag the values come from is decided the way lofty (the Rust
 * scanner) decides it — the container's PRIMARY tag, read from
 * music-metadata's `native` list rather than its merged `common` block
 * (creditValuesFromParsed): `common.artists` may come from the ARTISTS list
 * tag (Picard writes one), which lofty never reads, and for ID3v2 files
 * music-metadata pre-splits v2.3 TPE1/TCOM on "/", so the credit frames are
 * read raw from the file (src/db/id3-raw.js).
 */

import { nameKey } from './name-key.js';
import { PERFORMER_ROLES, CREDIT_ROLES, TRACK_ROLES } from './artist-roles.js';

export { PERFORMER_ROLES, CREDIT_ROLES, TRACK_ROLES };

// Delimiters used to split a single-valued ARTIST tag into multiple
// entries. Applied only to single values — multi-valued tags are honoured
// natively.
const ARTIST_DELIMITERS = [
  ' / ',
  ' feat. ',
  ' feat ',
  ' ft. ',
  ' ft ',
  '; ',
];

// The credit fields and the tag key each is read from, per primary tag
// format — the same keys lofty maps to ItemKey::TrackArtist / AlbumArtist /
// Composer / Conductor / Remixer / Lyricist (rust-parser reads those). Keys
// compare case-insensitively (Vorbis and APE keys are case-insensitive by
// spec). ID3v2 frame ids are what src/db/id3-raw.js returns.
export const CREDIT_FIELDS = ['trackArtists', 'albumArtists', ...CREDIT_ROLES];
const ID3_KEYS    = { trackArtists: ['TPE1'], albumArtists: ['TPE2'], composer: ['TCOM'], conductor: ['TPE3'], remixer: ['TPE4'], lyricist: ['TEXT'] };
const VORBIS_KEYS = { trackArtists: ['ARTIST'], albumArtists: ['ALBUMARTIST'], composer: ['COMPOSER'], conductor: ['CONDUCTOR'], remixer: ['REMIXER', 'MIXARTIST'], lyricist: ['LYRICIST'] };
const ILST_KEYS   = { trackArtists: ['©ART'], albumArtists: ['aART'], composer: ['©wrt'], conductor: ['----:com.apple.iTunes:CONDUCTOR'], remixer: ['----:com.apple.iTunes:REMIXER'], lyricist: ['----:com.apple.iTunes:LYRICIST'] };
const APE_KEYS    = { trackArtists: ['ARTIST'], albumArtists: ['ALBUM ARTIST', 'ALBUMARTIST'], composer: ['COMPOSER'], conductor: ['CONDUCTOR'], remixer: ['MIXARTIST'], lyricist: ['LYRICIST'] };
// music-metadata `common` keys per field (the view used when no primary tag
// is recognised).
const COMMON_KEYS = { trackArtists: ['artists', 'artist'], albumArtists: ['albumartists', 'albumartist'], composer: ['composer'], conductor: ['conductor'], remixer: ['remixer'], lyricist: ['lyricist'] };
// Fields music-metadata pre-splits on "/" in ID3v2.2 / v2.3 (FrameParser:
// TPE1 TCOM TEXT TOLY TOPE TSRC) — only these need re-joining in the
// degraded ID3 path.
const ID3_PRESPLIT_FIELDS = new Set(['trackArtists', 'composer', 'lyricist']);

// Roles beyond the performers with their ID3v2 frame, for reference / tests.
export const ROLE_TAGS = CREDIT_ROLES.map((role) => ({ role, frame: ID3_KEYS[role][0], common: role }));

// One private-use character (U+E000 + i) stands in for the i-th protected
// (exception) name while the delimiters are applied, restored afterwards.
// A single non-digit character: an exception spelled "112" can never match
// inside another name's placeholder (the list is capped at 500, well inside
// the PUA). Same scheme in main.rs.
const placeholder = (i) => String.fromCodePoint(0xE000 + i);

// Split a single artist string on the Navidrome-default list, keeping every
// name in `exceptions` (exact spelling, in the configured order — put a
// longer name before one it contains) whole. Returns a clean array
// (trimmed, empties dropped).
export function splitArtistString(s, exceptions = []) {
  if (!s) { return []; }
  let text = String(s);
  const used = [];
  // A value with no delimiter cannot be mis-split — skip the exceptions
  // pass (up to 500 `includes` per credit otherwise).
  if (exceptions.length && ARTIST_DELIMITERS.some((d) => text.includes(d))) {
    for (const ex of exceptions) {
      if (!ex || !text.includes(ex)) { continue; }
      used.push(ex);
      text = text.split(ex).join(placeholder(used.length - 1));
    }
  }
  let parts = [text];
  for (const delim of ARTIST_DELIMITERS) {
    const next = [];
    for (const p of parts) {
      if (p.includes(delim)) {
        for (const piece of p.split(delim)) { next.push(piece); }
      } else {
        next.push(p);
      }
    }
    parts = next;
  }
  return parts.map((p) => {
    let out = p;
    for (let i = 0; i < used.length; i++) { out = out.split(placeholder(i)).join(used[i]); }
    return out.trim();
  }).filter(Boolean);
}

// Trim a raw tag value list (array or scalar) to its non-empty strings.
function creditValues(raw) {
  if (raw == null) { return []; }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => (v == null || typeof v === 'object' ? '' : String(v).trim())).filter(Boolean);
}

// Dedup by identity key, first-seen spelling wins: "Guns N' Roses / Guns N’
// Roses" is one artist, and two credits for one artist id would otherwise
// land as main + featured rows ("X feat. X"). Mirrors resolve_credits.
function dedupByKey(names) {
  const seen = new Set();
  return names.filter((v) => {
    const key = nameKey(v);
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

// The V72 split rule: plural values verbatim, a single value delimiter-split.
export function resolveCredits(values, exceptions = []) {
  if (values.length >= 2) { return dedupByKey(values); }
  if (values.length === 1) { return dedupByKey(splitArtistString(values[0], exceptions)); }
  return [];
}

// The tag as written: the single value verbatim, plural values joined with
// ", " — after the same key-dedup the credit list gets, so two identical
// ARTIST comments read "Foo", not "Foo, Foo".
export function creditDisplay(values) {
  if (values.length >= 2) { return dedupByKey(values).join(', '); }
  return values[0] || '';
}

// Does lofty read this file's credits from an ID3v2 tag? MP3 / AAC / WAV /
// AIFF / DSF carry ID3v2 as the primary tag; FLAC and Ogg (Vorbis comments)
// and MP4 (ilst) do not, even when a stray ID3 header precedes the stream.
export function id3IsPrimary(parsed) {
  const tagTypes = parsed?.format?.tagTypes || [];
  const native = parsed?.native || {};
  return tagTypes.some((t) => String(t).startsWith('ID3v2')) && !native.vorbis && !native.iTunes;
}

function fromNative(entries, keys) {
  const out = {};
  for (const field of CREDIT_FIELDS) {
    const wanted = keys[field].map((k) => k.toUpperCase());
    out[field] = creditValues(entries
      .filter((e) => wanted.includes(String(e.id).toUpperCase()))
      .map((e) => e.value));
  }
  return out;
}

function fromCommon(common) {
  const out = {};
  for (const field of CREDIT_FIELDS) {
    const [arrayKey, scalarKey] = COMMON_KEYS[field];
    const arr = creditValues(common[arrayKey]);
    out[field] = arr.length ? arr : creditValues(scalarKey ? common[scalarKey] : null);
  }
  return out;
}

/**
 * The credit tag values of a parsed file, read from its PRIMARY tag the way
 * lofty reads them (see the header). Returns one string[] per CREDIT_FIELD,
 * or null when the format is not one we map — the caller then falls back to
 * music-metadata's `common` view.
 *
 * @param {object} parsed  music-metadata parseFile result ({format, native, common})
 * @param {object|null} rawId3  readId3TextFrames() result for an ID3-primary
 *   file (null when the frames could not be read → `degraded` view: the
 *   pre-split v2.2/v2.3 values re-joined with "/", flagged for the log)
 */
export function creditValuesFromParsed(parsed, rawId3 = null) {
  const native = parsed?.native || {};
  if (id3IsPrimary(parsed)) {
    if (rawId3) {
      const out = {};
      for (const field of CREDIT_FIELDS) { out[field] = creditValues(rawId3[ID3_KEYS[field][0]]); }
      return out;
    }
    // Degraded: music-metadata's view. Its v2.2/v2.3 arrays for TPE1 / TCOM /
    // TEXT are "/"-splits of ONE frame, not plural values — re-join them so
    // the plural rule does not promote "AC" and "DC" to two artists.
    const tagTypes = (parsed?.format?.tagTypes || []).map(String);
    const presplit = !tagTypes.includes('ID3v2.4');
    const out = fromCommon(parsed?.common || {});
    if (presplit) {
      for (const field of ID3_PRESPLIT_FIELDS) {
        if (out[field].length > 1) { out[field] = [out[field].join('/')]; }
      }
    }
    out.degraded = true;
    return out;
  }
  if (native.vorbis) { return fromNative(native.vorbis, VORBIS_KEYS); }
  if (native.iTunes) { return fromNative(native.iTunes, ILST_KEYS); }
  if (native.APEv2)  { return fromNative(native.APEv2, APE_KEYS); }
  return null;
}

/**
 * Extract structured artist info from a music-metadata result.
 *
 * @param {object} common  parsed.common from music-metadata.parseFile
 * @param {object} [opts]
 * @param {object|null} [opts.values]  creditValuesFromParsed() result — the
 *   primary tag's values; when null the `common` view is used
 * @param {string[]} [opts.splitExceptions]  names never split
 * @returns {{
 *   trackArtists:       string[],   // primary first, featured after
 *   albumArtists:       string[],   // ALBUMARTIST values or []
 *   roleCredits:        Object<string, string[]>,  // composer / conductor / remixer / lyricist
 *   isCompilation:      boolean,    // TCMP / cpil / compilation tag truthy
 *   trackArtistDisplay: string,     // the ARTIST tag as written ('' when none)
 *   albumArtistDisplay: string|null,// the ALBUMARTIST tag as written
 *   trackArtistSorts / albumArtistSorts / trackArtistMbids / albumArtistMbids
 * }}
 */
export function extractArtists(common, { values = null, splitExceptions = [] } = {}) {
  const v = values || fromCommon(common || {});
  const trackArtists = resolveCredits(v.trackArtists, splitExceptions);
  const albumArtists = resolveCredits(v.albumArtists, splitExceptions);

  const roleCredits = {};
  for (const role of CREDIT_ROLES) {
    const names = resolveCredits(v[role], splitExceptions);
    if (names.length) { roleCredits[role] = names; }
  }

  return {
    trackArtists,
    albumArtists,
    roleCredits,
    isCompilation:      !!common?.compilation,
    trackArtistDisplay: creditDisplay(v.trackArtists),
    albumArtistDisplay: creditDisplay(v.albumArtists) || null,
    // V71: per-artist sort names and MusicBrainz ids, index-aligned to the
    // name lists above (empty array = nothing to apply).
    trackArtistSorts: alignSort(common?.artistsort, trackArtists),
    albumArtistSorts: alignSort(common?.albumartistsort, albumArtists),
    trackArtistMbids: alignIds(common?.musicbrainz_artistid, trackArtists),
    albumArtistMbids: alignIds(common?.musicbrainz_albumartistid, albumArtists),
  };
}

// ARTISTSORT / ALBUMARTISTSORT are single-valued in music-metadata's common
// block, so a sort name can only be attributed with certainty when the tag
// names exactly ONE artist. The Rust scanner takes the first sort value
// under the same one-artist rule — keep both in lock-step.
function alignSort(sortRaw, names) {
  if (names.length !== 1 || sortRaw == null) { return []; }
  const s = String(Array.isArray(sortRaw) ? sortRaw[0] : sortRaw).trim();
  return s ? [s] : [];
}

// MUSICBRAINZ_ARTISTID / ALBUMARTISTID are multi-valued (one per artist, in
// artist order — Picard convention). In an ID3v2.3 TXXX frame Picard joins
// them with "/" (a UUID never contains one), so a joined value is split
// first. Applied only when the id count equals the name count, so nothing
// is ever attributed to the wrong artist. Same rule in rust-parser/src/main.rs.
function alignIds(idsRaw, names) {
  if (idsRaw == null || names.length === 0) { return []; }
  const ids = (Array.isArray(idsRaw) ? idsRaw : [idsRaw])
    .flatMap((v) => (v == null ? [] : String(v).split('/')))
    .map((v) => v.trim())
    .filter(Boolean);
  return ids.length === names.length ? ids : [];
}

/**
 * Pick the canonical album-artist id for an album, applying the
 * fallback rules:
 *
 *   1. ALBUMARTIST tag present        → use it (first value)
 *   2. COMPILATION flag set, no AA    → "Various Artists"
 *   3. neither                        → primary track artist
 *
 * This is the policy that populates `albums.artist_id`. The full
 * album_artists M2M list comes from the raw `albumArtists` array.
 *
 * @param {object} args
 * @param {number[]} args.albumArtistIds   artist ids from ALBUMARTIST, or []
 * @param {boolean}  args.isCompilation    COMPILATION tag truthy
 * @param {number|null} args.variousArtistsId  id of the seeded VA row
 * @param {number|null} args.primaryTrackArtistId  fallback id
 * @returns {number|null}
 */
export function chooseAlbumArtistId({
  albumArtistIds, isCompilation, variousArtistsId, primaryTrackArtistId,
}) {
  if (albumArtistIds && albumArtistIds.length) { return albumArtistIds[0]; }
  if (isCompilation && variousArtistsId)       { return variousArtistsId; }
  return primaryTrackArtistId;
}
