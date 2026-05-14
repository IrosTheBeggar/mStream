// Genre name canonicalisation — Rust mirror of src/db/genre-canonical.js.
//
// Both scanners (Rust prebuilt + JS fallback) call this on every
// genre-tag string before looking up / inserting in the `genres` table.
// V35 onwards: case + punctuation dupes get collapsed at scan time
// (e.g. "Hip-Hop", "Hip Hop", "hip hop" all → "Hip Hop"), so the
// genres table holds one row per canonical concept rather than one per
// user typing.
//
// The MB list (data/mb-genres.json — CC0) is embedded at compile time
// via include_str! so the binary is self-contained. Refresh via
// `node scripts/refresh-mb-genres.js`, commit the updated JSON, then
// rebuild the Rust binary (CI handles the rebuild on push, matches the
// existing pattern for any rust-parser source change).
//
// If the embedded JSON ever fails to parse (shouldn't happen — the
// refresh script writes a stable schema, the test suite verifies the
// shape), we degrade to "preserve user input" and the system still
// works, just without the dedup benefit. That parity with the JS
// module's silent-degrade behaviour is intentional.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct MbGenresFile {
    genres: Vec<String>,
}

// JSON is baked into the binary at compile time. The path is relative
// to this source file: rust-parser/src/genre_canonical.rs → ../../data/mb-genres.json.
const MB_GENRES_JSON: &str = include_str!("../../data/mb-genres.json");

// Normalise a raw genre string for lookup. Mirrors the JS
// `normaliseForLookup` function exactly: lowercase, hyphen/underscore
// → space, `&` → " and ", whitespace collapsed, trimmed. Idempotent.
// Both the MB list (at load time) and scanner input (at lookup time)
// pass through this same function so dupes collapse identically.
fn normalise_for_lookup(s: &str) -> String {
    let lowercased: String = s.to_lowercase();
    // First pass: char replacements (`&` → " and ", `-` / `_` → space).
    let mut expanded = String::with_capacity(lowercased.len() + 8);
    for c in lowercased.chars() {
        match c {
            '&' => expanded.push_str(" and "),
            '-' | '_' => expanded.push(' '),
            other => expanded.push(other),
        }
    }
    // Second pass: collapse runs of whitespace + trim.
    let mut out = String::with_capacity(expanded.len());
    let mut prev_space = false;
    for c in expanded.chars() {
        if c.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn mb_genres() -> &'static HashSet<String> {
    static CELL: OnceLock<HashSet<String>> = OnceLock::new();
    CELL.get_or_init(|| match serde_json::from_str::<MbGenresFile>(MB_GENRES_JSON) {
        Ok(parsed) => parsed
            .genres
            .into_iter()
            .map(|g| normalise_for_lookup(&g))
            .collect(),
        // Silent degrade — same as the JS module. The test suite
        // verifies the file parses; if we ever hit this branch in
        // production we still produce correct (just non-deduped) data.
        Err(_) => HashSet::new(),
    })
}

// Display-form overrides for genres whose Title Case form would be
// wrong (acronyms, special spellings). Keyed by the NORMALISED form
// (post-`normalise_for_lookup`). Looked up BEFORE the MB set —
// applies even for entries MB recognises (MB has "k-pop" which
// normalises to "k pop"; we want display "K-Pop", not "K Pop").
//
// Must stay in lock-step with the JS module's DISPLAY_OVERRIDES —
// there's a parity test that verifies both sides produce the same
// output for a fixed input set.
fn display_overrides() -> &'static HashMap<&'static str, &'static str> {
    static CELL: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("edm", "EDM");
        m.insert("idm", "IDM");
        m.insert("ebm", "EBM");
        m.insert("mpb", "MPB");
        m.insert("r and b", "R&B");
        m.insert("rnb", "R&B");
        m.insert("k pop", "K-Pop");
        m.insert("j pop", "J-Pop");
        m.insert("j rock", "J-Rock");
        m.insert("c pop", "C-Pop");
        m.insert("lo fi", "Lo-Fi");
        m.insert("nu metal", "Nu Metal");
        m.insert("nu jazz", "Nu Jazz");
        m.insert("uk garage", "UK Garage");
        m.insert("uk drill", "UK Drill");
        m.insert("uk hip hop", "UK Hip Hop");
        m.insert("us power metal", "US Power Metal");
        m.insert("g funk", "G-Funk");
        m.insert("nu disco", "Nu-Disco");
        m.insert("edm trap", "EDM Trap");
        m
    })
}

// Title-case a normalised genre name. Capitalise the first letter of
// each whitespace- or hyphen-delimited word. Mirrors the JS version.
fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut capitalise_next = true;
    for c in s.chars() {
        if c.is_whitespace() || c == '-' {
            out.push(c);
            capitalise_next = true;
        } else if capitalise_next {
            out.extend(c.to_uppercase());
            capitalise_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Returns the canonical display form of a raw genre tag.
/// - `None` if input is empty / whitespace-only.
/// - `Some(override)` if the normalised form has a display override.
/// - `Some(title_case)` if MB recognises the normalised form.
/// - `Some(trimmed)` if MB doesn't recognise it, preserving user's casing.
///
/// Mirrors `canonicalGenreName` in src/db/genre-canonical.js — parity
/// is required because both scanners write to the same genres table.
pub fn canonical_genre_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalised = normalise_for_lookup(trimmed);
    if normalised.is_empty() {
        return None;
    }

    // Override map first — applies regardless of MB presence.
    if let Some(display) = display_overrides().get(normalised.as_str()) {
        return Some((*display).to_string());
    }

    // MB known — title-case for display.
    if mb_genres().contains(&normalised) {
        return Some(title_case(&normalised));
    }

    // Unknown — preserve user's casing.
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_handles_basic_cases() {
        assert_eq!(normalise_for_lookup("Hip-Hop"), "hip hop");
        assert_eq!(normalise_for_lookup("  Hip   Hop  "), "hip hop");
        assert_eq!(normalise_for_lookup("Drum & Bass"), "drum and bass");
        assert_eq!(normalise_for_lookup("R&B"), "r and b");
        assert_eq!(normalise_for_lookup("K-Pop"), "k pop");
    }

    #[test]
    fn title_case_capitalises_word_boundaries() {
        assert_eq!(title_case("hip hop"), "Hip Hop");
        assert_eq!(title_case("lo-fi"), "Lo-Fi");
        assert_eq!(title_case("drum and bass"), "Drum And Bass");
    }

    #[test]
    fn canonical_matches_mb_entries() {
        // Depend on bundled mb-genres.json being parsed correctly.
        assert_eq!(canonical_genre_name("Jazz"), Some("Jazz".to_string()));
        assert_eq!(canonical_genre_name("JAZZ"), Some("Jazz".to_string()));
        assert_eq!(canonical_genre_name("Hip-Hop"), Some("Hip Hop".to_string()));
        assert_eq!(canonical_genre_name("hip hop"), Some("Hip Hop".to_string()));
    }

    #[test]
    fn canonical_applies_acronym_overrides() {
        assert_eq!(canonical_genre_name("edm"), Some("EDM".to_string()));
        assert_eq!(canonical_genre_name("EDM"), Some("EDM".to_string()));
        assert_eq!(canonical_genre_name("k-pop"), Some("K-Pop".to_string()));
        assert_eq!(canonical_genre_name("K Pop"), Some("K-Pop".to_string()));
        assert_eq!(canonical_genre_name("R&B"), Some("R&B".to_string()));
        assert_eq!(canonical_genre_name("RnB"), Some("R&B".to_string()));
    }

    #[test]
    fn canonical_preserves_unknown_genres() {
        // Made-up genre — should pass through with user's casing intact.
        let unknown = "VaporTwitch";
        assert_eq!(canonical_genre_name(unknown), Some(unknown.to_string()));
    }

    #[test]
    fn canonical_handles_empty_input() {
        assert_eq!(canonical_genre_name(""), None);
        assert_eq!(canonical_genre_name("   "), None);
    }
}
