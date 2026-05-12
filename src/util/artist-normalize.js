// Artist-name normalization for fuzzy library lookups.
//
// Last.fm's `artist.getSimilar` returns names spelled exactly as they
// appear on Last.fm — usually the "official" form ("Sigur Rós", "M.I.A.").
// Local library files are tagged with whatever the user / tagger decided
// — sometimes ASCII-stripped ("Sigur Ros"), sometimes lowercase, sometimes
// ampersanded ("AC&DC" vs "AC/DC" vs "ACDC"). To match Last.fm output
// against the library we have to fold both sides through the same
// normalizer first.
//
// Velvet's normalizer (see src/db/sqlite-backend.js `_normArtist`) only
// did lowercase + `&` swap + whitespace collapse — no diacritic folding.
// We do diacritic folding too because the JS-side cost is trivial and
// "Beyoncé" vs "Beyonce" is a real, frequent miss without it.
//
// Pure function with no side effects — safe to import anywhere.
export function normalizeArtistName(name) {
  if (typeof name !== 'string') { return ''; }
  return name
    // NFD splits combining marks off their base characters so the
    // diacritic regex below can strip them ("é" → "e" + COMBINING-ACUTE).
    .normalize('NFD')
    // Strip every combining mark. \p{Diacritic} covers Latin, Greek,
    // Cyrillic, Hebrew, Arabic, Devanagari… everything we'd actually
    // encounter in music metadata.
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    // "M.C." / "AC/DC" / "Mr." style dots and slashes are inconsistent
    // between Last.fm and tagger output — strip them both.
    .replace(/[./]/g, '')
    // "Foo & Bar" vs "Foo and Bar" vs "Foo &Bar" — collapse the ampersand
    // family (with or without surrounding whitespace) onto " and ".
    // BUT only after lowercasing so we don't have to handle case
    // variants on the ampersand context.
    .replace(/\s*&\s*/g, ' and ')
    // Collapse runs of whitespace (tabs, double-spaces) to a single space.
    .replace(/\s+/g, ' ')
    .trim();
}
