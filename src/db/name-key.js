// Artist name normalisation (V71).
//
// `artists.name_key` is the scanner's find-or-create key for artists: two
// spellings that normalise to the same key are the same artist row. The
// display `name` is a scan-end consensus over the raw spellings on the
// artist's credits (src/db/artist-aggregate.js), so a library tagged
// "Beatles" on most tracks and "beatles" on a few shows "Beatles" — and
// the answer never depends on which file a parallel walk committed first.
//
// nameKey(s):
//   1. collapse every whitespace run to one space, trim;
//   2. fold Unicode quote and dash variants onto their ASCII forms
//      (’ ‘ ‚ ‛ ′ → '   “ ” „ ‟ ″ → "   ‐ ‑ ‒ – — ― − → -);
//   3. lowercase.
// Deliberately NOT folded: diacritics ("Beyoncé" ≠ "Beyonce" — different
// artists can differ only there), punctuation ("R.E.M." ≠ "REM"), "&" vs
// "and". Those are search concerns (see src/util/artist-normalize.js, the
// fuzzy Last.fm matcher), not identity.
//
// orderName(name, sortName): the sort key the artists index can order by
// when a client asks for `sort: 'order'` — the ARTISTSORT tag when the
// scanner saw one, else the display name, run through nameKey and then
// stripped of one leading article from IGNORED_ARTICLES ("The Beatles" →
// "beatles"). Never used for identity.
//
// Mirrored byte-for-byte in rust-parser/src/main.rs (name_key / order_name).
// Known engine gap, accepted: JS `\s` and `toLowerCase()` vs Rust
// `char::is_whitespace` and `to_lowercase()` agree on every script we have
// met; they can differ on U+FEFF and on a handful of locale-specific
// case mappings, which would only ever split an artist, never merge two.

const SINGLE_QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;
const DASHES = /[‐‑‒–—―−]/g;

export function nameKey(raw) {
  if (raw == null) { return ''; }
  return String(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase();
}

// Leading articles dropped by orderName. Navidrome's default list minus
// the one- and two-letter Portuguese/Spanish forms ("O", "A", "Os", "As"),
// which collide with English words far more often than they help.
export const IGNORED_ARTICLES = ['the', 'el', 'la', 'los', 'las', 'le', 'les'];

export function orderName(name, sortName = null) {
  // A blank sort tag is no sort tag (the Rust twin filters the same way).
  const key = nameKey(sortName && String(sortName).trim() ? sortName : name);
  for (const article of IGNORED_ARTICLES) {
    if (key.length > article.length + 1 && key.startsWith(article + ' ')) {
      return key.slice(article.length + 1);
    }
  }
  return key;
}
