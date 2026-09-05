/**
 * LRC (line-timed karaoke) → plain search text.
 *
 * The LRC format is minimal and widely supported:
 *
 *   [ar:Artist Name]          ← metadata (ignored)
 *   [ti:Track Title]
 *   [al:Album]
 *   [length:mm:ss]
 *   [offset:+500]             ← global ms shift
 *
 *   [00:12.34]First line       ← timestamp + text
 *   [00:15.00][00:45.00]Chorus ← multiple timestamps share one text
 *   [01:30.250]Higher precision OK
 *
 *   [00:17.00]                ← empty line = instrumental break
 *
 * mStream stores lyrics VERBATIM (tracks.lyrics_synced_lrc; /api/v1/lyrics
 * hands the raw LRC to the client), so the only server-side parsing left is
 * the search rendition: lrcToSearchText derives tracks.lyrics_search_text
 * (V59) so the FTS index sees words, not timestamps. The structured
 * `{time_ms, text}` parser that used to live here served the Subsonic
 * lyrics endpoints and went with them.
 *
 * Lives in src/util/ because it has no DB or HTTP dependency. Consumers:
 *   - src/db/scanner.mjs                (at track upsert)
 *   - src/db/lyrics-backfill.mjs        (at commit)
 *   - src/db/schema.js                  (the V59 backfill)
 *   - rust-parser/src/main.rs           (MIRRORS lrcToSearchText — the two
 *                                        scanners must stay byte-identical)
 *
 * The three writers derive tracks.lyrics_search_text from the same rules so
 * search matches what the endpoint serves.
 */

// Match an LRC timestamp anchored to the start of a candidate position:
//   [mm:ss]       [mm:ss.xx]   [mm:ss.xxx]
// Group 1: minutes (1+ digits). Group 2: seconds (1–2 digits).
// Group 3: fractional digits (optional, 1–3 digits).
const TIMESTAMP_RE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

// Recognised metadata tags — stripped so they don't surface as "lyric lines".
const META_TAG_RE = /^\[(ar|ti|al|au|by|re|ve|length|offset|lang|tool):[^\]]*\]$/i;

// Enhanced-LRC ("A2" / Walaoke extension) word-level stamps embedded in a
// line's BODY: `[00:12.00]<00:12.00>word <00:12.50>word`. Karaoke clients
// may want them; the search rendition must drop them or their digits become
// FTS tokens.
const INLINE_TIMESTAMP_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

/**
 * Reduce LRC (or LRC-ish) text to its plain lyric words for indexing —
 * the rendition stored in tracks.lyrics_search_text (V59) and fed to
 * fts_tracks.lyrics + the search route's LIKE fallback.
 *
 * fts5's unicode61 tokenizer treats the DIGITS inside `[mm:ss.xx]`
 * stamps as real tokens (only the brackets/colons tokenise away), so
 * indexing raw LRC makes any 2-digit query match nearly every synced
 * track via its timestamps. This strips, per line:
 *   - metadata tag lines  ([ar:], [ti:], [offset:+500], …)
 *   - leading `[mm:ss(.xx)]` stamp(s) (multi-stamp lines included)
 *   - inline `<mm:ss.xx>` word-level stamps (enhanced LRC)
 * and keeps everything else VERBATIM in line order — a multi-stamp line
 * is kept ONCE and lines are never re-sorted by time, so term frequency
 * and snippet() line order stay faithful to the text.
 *
 * Returns null (not '') when nothing survives, matching the NULL
 * convention of the other tracks.lyrics_* columns.
 *
 * MIRRORED in rust-parser/src/main.rs (lrc_to_search_text). The two
 * scanners must produce byte-identical values for the same input
 * (scanner-parity.test.mjs deep-compares full DB snapshots), so any
 * behavioural change here must land in both places simultaneously.
 */
export function lrcToSearchText(lrc) {
  if (!lrc || typeof lrc !== 'string') { return null; }
  const text = lrc.charCodeAt(0) === 0xFEFF ? lrc.slice(1) : lrc;
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) { continue; }
    if (META_TAG_RE.test(line)) { continue; }
    // Peel leading timestamp(s). trimStart between peels so the odd
    // "[00:01.00] [00:02.00]text" spacing doesn't stop the loop.
    for (;;) {
      const m = line.match(TIMESTAMP_RE);
      if (!m) { break; }
      line = line.slice(m[0].length).trimStart();
    }
    line = line
      .replace(INLINE_TIMESTAMP_RE, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (line) { out.push(line); }
  }
  return out.length ? out.join('\n') : null;
}
