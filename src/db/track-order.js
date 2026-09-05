// Canonical "in album order" SQL sort for a set of tracks, shared by every
// listing that shows an album's tracks — the webapp album view
// (/api/v1/db/album-songs), genre songs and the DLNA content directory —
// so they can't drift apart.
//
// Lives in its own dependency-free module rather than in src/api/db.js
// because src/api/dlna.js needs it too, and db.js already reaches dlna.js
// through src/db/task-queue.js — importing it from there would close an
// import cycle.
//
// Assumes the tracks table is aliased `t`.
//
// The two guards exist because SQLite sorts NULL FIRST, so a plain
// `t.disc_number, t.track_number` hoists every untagged track ABOVE the
// tagged ones instead of leaving it at the end:
//
//   COALESCE(t.disc_number, 1)
//     A single-disc rip usually carries no TPOS / DISCNUMBER at all, so "no
//     disc tag" means disc 1, not disc zero. Without this, an album where
//     only SOME files carry a disc tag lists the untagged ones first; with
//     it they interleave with disc 1 by track number, and a real disc 2
//     still sorts after them.
//
//   t.track_number IS NULL
//     Sorts false(0) before true(1), so tracks with no track number fall to
//     the bottom of their disc rather than jumping to the top.
//
// Callers append their own last-resort tiebreak (filepath or title) for
// tracks that carry no numbering at all. That tiebreak is alphabetical —
// the best guess available with no numbers to go on, but a fallback, not
// the intended order. A whole album landing there is a symptom worth
// chasing: it usually means the scanner failed to read the track numbers
// (see parse_num_of in rust-parser/src/main.rs).
export const ALBUM_TRACK_ORDER =
  'COALESCE(t.disc_number, 1), t.track_number IS NULL, t.track_number';
