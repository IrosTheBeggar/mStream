// Genre name canonicalisation using the MusicBrainz reference list.
//
// The DB problem this solves: pre-V35, the scanner did
//   SELECT id FROM genres WHERE name = ?
// which is case-sensitive AND punctuation-sensitive. A library with
// files tagged "Hip-Hop", "Hip Hop", and "hip-hop" would create three
// distinct rows in `genres`, three distinct dropdown entries in the
// Auto-DJ panel, and three distinct piles when the user wanted to
// filter for "Hip Hop tracks."
//
// V34 made every READ-side lookup `COLLATE NOCASE`, which fixed the
// case-difference subset (Jazz/jazz now resolve to one row at query
// time). But two rows still exist in `genres`, and punctuation
// variants (Hip-Hop vs Hip Hop) still don't merge.
//
// V35 closes both gaps by canonicalising at the WRITE side:
//   1. Normalise the input string (case, separators, ampersand).
//   2. Apply hand-curated display overrides (acronyms etc.) first.
//   3. Otherwise look up against the bundled MusicBrainz genre list
//      (2,141 entries, CC0 — see data/mb-genres.json).
//   4. If MB recognises it, return the Title Case form.
//   5. If unknown to MB, preserve the user's typing.
//
// All callers should go through findOrCreateGenre in manager.js,
// which calls canonicalGenreName before looking up / inserting.
//
// ── Updating the list ────────────────────────────────────────────
// Run `node scripts/refresh-mb-genres.js` to refresh
// data/mb-genres.json from the MB API. The list grows ~monthly;
// quarterly refreshes are plenty.

import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);
const MB_JSON_PATH = path.resolve(__dirname, '..', '..', 'data', 'mb-genres.json');

// Normalise a raw genre string for lookup. Lowercase, separators
// (hyphen / underscore) collapsed to spaces, `&` folded to " and ",
// whitespace collapsed, trimmed. Idempotent.
//
// Both the MB list (at load time) and scanner input (at lookup time)
// pass through this same function, so dupes collapse identically
// regardless of which side has hyphens / ampersands / mixed case.
//
// Examples:
//   "Hip-Hop"      → "hip hop"
//   "Hip Hop"      → "hip hop"
//   "K-Pop"        → "k pop"
//   "Drum & Bass"  → "drum and bass"
//   "R&B"          → "r and b"
//   "  RnB  "      → "rnb"
//
// Exported for tests + the V35 migration's use.
export function normaliseForLookup(s) {
  if (typeof s !== 'string') { return ''; }
  return s
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Title-case a normalised genre name for display. Capitalises the
// first letter of each whitespace- or hyphen-delimited word, leaves
// the rest as-is. Doesn't handle acronyms — those need to be in
// DISPLAY_OVERRIDES because naive title-case gives "Edm" / "Idm" /
// "R&b". The override layer is the safety net.
function titleCase(s) {
  return s.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Display-form overrides — keyed by the NORMALISED form (post-
// `normaliseForLookup`). Looked up BEFORE the MB set so we can
// override the display even for entries MB recognises (e.g. MB has
// "k-pop" which normalises to "k pop"; we want to display "K-Pop",
// not "K Pop"). May also include entries that aren't in MB if we
// have a strong opinion (e.g. "rnb" → "R&B" lets users who tag
// without the ampersand still land on the canonical R&B name).
//
// Hand-curated. To add an entry: pick a genre, work out its
// normalised key via `normaliseForLookup`, decide on a display
// form. Keep this list short — Title Case + MB lookup covers most
// of the surface; the override map is for cases where Title Case
// is visibly wrong.
const DISPLAY_OVERRIDES = new Map([
  ['edm',                'EDM'],
  ['idm',                'IDM'],
  ['ebm',                'EBM'],
  ['mpb',                'MPB'],
  ['r and b',            'R&B'],
  ['rnb',                'R&B'],
  ['k pop',              'K-Pop'],
  ['j pop',              'J-Pop'],
  ['j rock',             'J-Rock'],
  ['c pop',              'C-Pop'],
  ['lo fi',              'Lo-Fi'],
  ['nu metal',           'Nu Metal'],
  ['nu jazz',            'Nu Jazz'],
  ['uk garage',          'UK Garage'],
  ['uk drill',           'UK Drill'],
  ['uk hip hop',         'UK Hip Hop'],
  ['us power metal',     'US Power Metal'],
  ['g funk',             'G-Funk'],
  ['nu disco',           'Nu-Disco'],
  ['edm trap',           'EDM Trap'],
]);

// Loaded once at module init. The JSON is small (~40KB), parsed eagerly
// so the scanner's hot path never blocks on I/O.
//
// Each entry is run through `normaliseForLookup` so the Set holds the
// post-normalisation form. That way input → normalise → MB-set lookup
// converges regardless of separator style.
//
// Wrapped in try/catch so a missing data file (e.g. a half-checked-out
// repo, a Docker layer that didn't ship `data/`) doesn't crash boot —
// canonicalisation degrades to "preserve user input" and the system
// still works, just without dedup.
let MB_GENRES = new Set();
try {
  const raw = fs.readFileSync(MB_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.genres)) {
    MB_GENRES = new Set(parsed.genres.map(g => normaliseForLookup(String(g))));
  }
} catch (_) {
  // Don't import winston here — this module loads before logger is
  // configured. Silently degrade. The data file's presence is verified
  // by the test suite.
}

// Returns the canonical display form of a raw genre tag, or null
// for empty input.
//
// Examples (assuming MB has "hip hop", "edm", "drum and bass"):
//   "Hip-Hop"       → "Hip Hop"     (MB match, title-cased)
//   "HIP HOP"       → "Hip Hop"     (MB match, title-cased)
//   "hip hop"       → "Hip Hop"     (MB match, title-cased)
//   "EDM"           → "EDM"         (override)
//   "edm"           → "EDM"         (override)
//   "K-Pop"         → "K-Pop"       (override)
//   "k-pop"         → "K-Pop"       (override)
//   "Drum & Bass"   → "Drum and Bass" (MB match — "drum and bass" — title-cased)
//   "R&B"           → "R&B"         (override)
//   "RnB"           → "R&B"         (override)
//   "Vaporwave"     → "Vaporwave"   (MB match, title-cased)
//   "VaporTwitch"   → "VaporTwitch" (unknown → preserve user input)
//   "  "            → null         (empty)
//   null            → null
export function canonicalGenreName(rawTag) {
  if (rawTag == null) { return null; }
  const trimmed = String(rawTag).trim();
  if (!trimmed) { return null; }
  const normalised = normaliseForLookup(trimmed);
  if (!normalised) { return null; }

  // Override first — keyed on the normalised form, applies regardless
  // of whether MB also has the entry. Lets us provide a preferred
  // display form for things like "k-pop" (MB has it but we want
  // "K-Pop" not "K Pop") AND things MB doesn't have (e.g. "RnB" → "R&B").
  if (DISPLAY_OVERRIDES.has(normalised)) {
    return DISPLAY_OVERRIDES.get(normalised);
  }

  // Known to MB — title-case the normalised form for display.
  if (MB_GENRES.has(normalised)) {
    return titleCase(normalised);
  }

  // Unknown — return the user's input unchanged. Letting a typo or
  // niche genre go through with its original casing is better than
  // mangling it via title-case (which would still be wrong for
  // acronyms we haven't catalogued).
  return trimmed;
}

// Test-only export so tests can assert the bundle was loaded
// correctly without re-reading the JSON file.
export const _internals = {
  mbGenresSize: () => MB_GENRES.size,
  hasMbGenre: (s) => MB_GENRES.has(s),
};
