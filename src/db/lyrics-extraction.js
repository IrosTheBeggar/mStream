/**
 * Per-file lyrics extraction for the scanner.
 *
 * Produces the four values stored on the tracks row (see SCHEMA_V19):
 *   - lyricsEmbedded      plain text, unsynced
 *   - lyricsSyncedLrc     LRC-format text (line-timed)
 *   - lyricsLang          ISO-639-1 code or null
 *   - lyricsSidecarMtime  ms-epoch when the chosen source was a sidecar
 *
 * A byte-identical Rust mirror lives in rust-parser/src/main.rs
 * (see the extract_lyrics helper there). Any change to the sidecar
 * filename probe order or the LRC/USLT conversion rules MUST land in
 * both. Covered by the lyrics parity test.
 *
 * Sources tried, first hit wins:
 *   1. Embedded tag — music-metadata's `parsed.common.lyrics` array
 *      (normalised across ID3 USLT/SYLT, Vorbis LYRICS/SYNCEDLYRICS,
 *      MP4 ©lyr, APE Lyrics). Each entry may carry synced timings.
 *   2. Sidecar `.lrc` (preferred over `.txt` when both exist) in the
 *      same directory as the audio file. Multi-language siblings
 *      (`song.en.lrc`, `song.ja.lrc`) are checked in a fixed order.
 *   3. Sidecar `.txt` as plain text.
 *
 * Sidecar hits that overlap with an embedded source: we merge — embedded
 * wins for the language field, sidecar wins for synced content (tag
 * tools more often carry unsynced-only, while sidecar .lrc are
 * line-timed by convention).
 */

import fs from 'node:fs';
import path from 'node:path';

// Known sidecar language suffixes to probe in order. `''` covers the
// plain `<basename>.lrc` case. Order is priority — English first for
// parity with Navidrome's sidecar precedence.
const LANG_PROBE_ORDER = ['', 'en', 'eng', 'ja', 'jpn', 'zh', 'zho', 'ko', 'kor',
                          'de', 'deu', 'fr', 'fra', 'es', 'spa', 'it', 'ita',
                          'pt', 'por', 'ru', 'rus'];

// Normalise USLT-style 3-letter codes back to ISO-639-1 two-letter where
// we recognise them. Unknown values pass through so the client at least
// sees the tag's literal language.
const ISO_3_TO_2 = {
  eng: 'en', jpn: 'ja', zho: 'zh', kor: 'ko', deu: 'de', fra: 'fr',
  spa: 'es', ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', hin: 'hi',
};

function normaliseLang(raw) {
  if (!raw) { return null; }
  const s = String(raw).trim().toLowerCase();
  if (!s) { return null; }
  if (s.length === 2) { return s; }
  return ISO_3_TO_2[s] || s;
}

// Convert music-metadata's SYLT-shaped entry back to LRC text. Input
// format (mm 11.x): `{ syncText: [{ text, timestamp }, …], descriptor, language }`
// where `timestamp` is ms. Output: `[mm:ss.xx]text\n` per line.
function sylTtoLrc(syncText) {
  if (!Array.isArray(syncText) || !syncText.length) { return null; }
  const lines = [];
  for (const s of syncText) {
    if (!s || typeof s.text !== 'string') { continue; }
    const ts = Number.isFinite(s.timestamp) ? Math.max(0, s.timestamp) : 0;
    const minutes = Math.floor(ts / 60000);
    const seconds = Math.floor((ts % 60000) / 1000);
    const hundredths = Math.floor((ts % 1000) / 10);
    const stamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
    // SYLT entries are one-line-at-a-time; a `\n` inside would confuse
    // downstream parsers. Replace with a space.
    lines.push(stamp + s.text.replace(/\r?\n/g, ' '));
  }
  return lines.length ? lines.join('\n') : null;
}

// Quick "is this LRC?" heuristic. An LRC file has at least one
// `[mm:ss(.xx)]` timestamp; a plain-text file doesn't. We use this
// when the sidecar extension lied (e.g. `.txt` with embedded
// timestamps) or when we only saw the bytes without a filename hint.
export function looksLikeLrc(text) {
  if (!text) { return false; }
  return /^[ \t]*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m.test(text);
}

// Max sidecar size we're willing to read into memory + store in the
// DB column. Real-world .lrc files are under 10KB; this caps
// accidentally-dropped (or pathologically-crafted) multi-MB files
// from blowing up the scan + bloating SQLite. Oversized sidecars are
// treated as "no sidecar" with a warning log.
const SIDECAR_MAX_BYTES = 256 * 1024;  // 256 KB

// Read a file if it exists; return `{ text, mtimeMs }` or null.
// Used by both sidecar probes — any file I/O error short-circuits to
// "no sidecar" rather than escalating; the track just has no lyrics.
function readIfExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) { return null; }
    if (stat.size > SIDECAR_MAX_BYTES) {
      // We don't have winston here (this runs inside the scanner
      // subprocess for the JS path; the Rust path has its own) — log
      // to stderr which the scan log pipeline already captures.
      // eslint-disable-next-line no-console
      console.error(`Warning: ignoring oversized lyrics sidecar (${stat.size} bytes, max ${SIDECAR_MAX_BYTES}): ${filePath}`);
      return null;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    // Strip BOM — Windows LRC editors love to add one and it breaks
    // the first-line timestamp parse.
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    // Math.trunc: stat.mtimeMs is fractional on NTFS/ext4. Stored raw it
    // lands in the INTEGER-affinity lyrics_sidecar_mtime column as REAL,
    // which the Rust scanner's typed read used to reject — one fractional
    // row aborted every subsequent Rust scan of the library. Whole ms
    // also matches what Rust stores (as_millis), so the drift comparison
    // agrees across scanners. Same truncation in both probes below.
    return { text: clean, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch (_) {
    return null;
  }
}

/**
 * Cheap sidecar-mtime probe used to decide whether to re-read a file
 * whose audio mtime is unchanged. Returns the newest mtimeMs across any
 * `<basename>.lrc` / `<basename>.<lang>.lrc` / `<basename>.txt` sibling,
 * or null if no sidecar exists.
 *
 * This uncached form does ~22 statSync calls per track regardless of
 * whether any sidecar exists (the full LANG_PROBE_ORDER plus the `.txt`
 * probe). The scanner hot path — which probes EVERY file on EVERY scan —
 * uses {@link sidecarMtimeCached} instead, amortising this to one
 * readdirSync per directory. This standalone version is retained for
 * one-off callers and for behavioural reference.
 *
 * @param {string} absPath  absolute filesystem path to the audio file
 * @returns {number|null}   newest sidecar mtimeMs, or null
 */
export function sidecarMtime(absPath) {
  const dir  = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  let newest = null;
  for (const suffix of LANG_PROBE_ORDER) {
    const name = suffix ? `${base}.${suffix}.lrc` : `${base}.lrc`;
    try {
      const st = fs.statSync(path.join(dir, name));
      const m = Math.trunc(st.mtimeMs); // whole ms — see readIfExists
      if (st.isFile() && (newest == null || m > newest)) {
        newest = m;
      }
    } catch (_) { /* no such file — expected */ }
  }
  // `.txt` sidecar matters too for the "no embedded lyrics at all" case.
  try {
    const st = fs.statSync(path.join(dir, `${base}.txt`));
    const m = Math.trunc(st.mtimeMs); // whole ms — see readIfExists
    if (st.isFile() && (newest == null || m > newest)) {
      newest = m;
    }
  } catch (_) { /* expected */ }
  return newest;
}

// Read a directory's filename listing once and cache it. Names are
// lowercased and a "does this dir contain any .lrc/.txt?" flag is
// precomputed, mirroring the Rust scanner's DirListing. An unreadable
// directory caches as empty (no sidecars) so we don't retry it per file.
function getDirListing(dir, cache) {
  const hit = cache.get(dir);
  if (hit) { return hit; }
  const names = new Set();
  let hasSidecars = false;
  try {
    for (const name of fs.readdirSync(dir)) {
      const lc = name.toLowerCase();
      if (!hasSidecars && (lc.endsWith('.lrc') || lc.endsWith('.txt'))) { hasSidecars = true; }
      names.add(lc);
    }
  } catch (_) { /* unreadable → empty listing */ }
  const listing = { names, hasSidecars };
  cache.set(dir, listing);
  return listing;
}

/**
 * Cache-backed equivalent of {@link sidecarMtime} for the scanner hot
 * path. Behaviourally identical — same candidate filenames, same
 * statSync to read each existing candidate's mtime, same "newest wins"
 * semantics — but it reads each directory once (readdirSync) instead of
 * issuing ~22 statSync calls per file. Directories with no `.lrc`/`.txt`
 * (the common case) cost zero statSync per file; others stat only the
 * candidate names that actually exist. Mirrors the Rust scanner's
 * sidecar_mtime_cached + DirListing.
 *
 * @param {string} absPath  absolute filesystem path to the audio file
 * @param {Map<string, {names: Set<string>, hasSidecars: boolean}>} cache
 *        per-directory listing cache, owned by the caller for one scan
 * @returns {number|null}   newest sidecar mtimeMs, or null
 */
export function sidecarMtimeCached(absPath, cache) {
  const dir  = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const listing = getDirListing(dir, cache);
  // Fast exit: no sidecars in this directory at all (the common case).
  if (!listing.hasSidecars) { return null; }

  let newest = null;
  // Stat only candidates the listing says exist. We compare lowercase
  // (the listing is lowercased) but stat the original-case name, so a
  // case-sensitive filesystem still agrees with the uncached probe.
  const consider = (name) => {
    if (!listing.names.has(name.toLowerCase())) { return; }
    try {
      const st = fs.statSync(path.join(dir, name));
      const m = Math.trunc(st.mtimeMs); // whole ms — see readIfExists
      if (st.isFile() && (newest == null || m > newest)) { newest = m; }
    } catch (_) { /* listed but vanished — treat as absent */ }
  };
  for (const suffix of LANG_PROBE_ORDER) {
    consider(suffix ? `${base}.${suffix}.lrc` : `${base}.lrc`);
  }
  consider(`${base}.txt`);
  return newest;
}

/**
 * Extract lyrics for a single track.
 *
 * @param {object} common   music-metadata `parsed.common`
 * @param {string} absPath  absolute filesystem path to the audio file
 * @returns {{
 *   lyricsEmbedded:      string|null,
 *   lyricsSyncedLrc:     string|null,
 *   lyricsLang:          string|null,
 *   lyricsSidecarMtime:  number|null,
 * }}
 */
export function extractLyrics(common, absPath) {
  let plain = null;
  let synced = null;
  let lang = null;
  let sidecarMtime = null;

  // ── Pass 1: embedded tags ────────────────────────────────────────
  //
  // music-metadata normalises every tag variant into `common.lyrics`:
  //   - legacy shape: `['plain text', 'plain text 2']` (strings)
  //   - modern shape: `[{text, descriptor, language, syncText?}, …]`
  //
  // We accept both; clients just want the text.
  if (Array.isArray(common?.lyrics)) {
    for (const entry of common.lyrics) {
      if (typeof entry === 'string') {
        plain = plain || entry;
        continue;
      }
      if (!entry || typeof entry !== 'object') { continue; }
      // Synced first — SYLT wins over USLT when both are present in
      // the same file (karaoke clients prefer line-timed).
      if (!synced && entry.syncText) {
        synced = sylTtoLrc(entry.syncText);
      }
      // Unsynced text.
      if (!plain && typeof entry.text === 'string' && entry.text.trim()) {
        // Some taggers stuff LRC-formatted content into the USLT
        // payload — keep it on the synced slot if it looks timed.
        if (!synced && looksLikeLrc(entry.text)) {
          synced = entry.text;
        } else {
          plain = entry.text;
        }
      }
      if (!lang && entry.language) {
        lang = normaliseLang(entry.language);
      }
    }
  }

  // ── Pass 2: sidecar files ────────────────────────────────────────
  //
  // Only probe when we haven't already got a synced version — tags
  // that carry synced lyrics are more trustworthy (moved with the
  // file, survives library shuffling). A sidecar with plain text
  // adds nothing we don't already have.
  const dir  = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));

  if (!synced) {
    for (const suffix of LANG_PROBE_ORDER) {
      const name = suffix ? `${base}.${suffix}.lrc` : `${base}.lrc`;
      const hit = readIfExists(path.join(dir, name));
      if (!hit) { continue; }
      synced = hit.text;
      sidecarMtime = hit.mtimeMs;
      // Infer language from the suffix (only if we don't already
      // have one from the embedded tag).
      if (!lang && suffix) {
        lang = normaliseLang(suffix);
      }
      break;
    }
  }

  // Plain `.txt` sidecar. Only consulted when we have NO lyrics at
  // all (synced OR plain) — a sidecar `.txt` supplementing an
  // existing tag would be noise.
  if (!synced && !plain) {
    const hit = readIfExists(path.join(dir, `${base}.txt`));
    if (hit) {
      // A `.txt` with LRC timestamps is actually synced; promote it.
      if (looksLikeLrc(hit.text)) {
        synced = hit.text;
      } else {
        plain = hit.text;
      }
      sidecarMtime = hit.mtimeMs;
    }
  }

  return {
    lyricsEmbedded:     plain  && plain.trim()  ? plain  : null,
    lyricsSyncedLrc:    synced && synced.trim() ? synced : null,
    lyricsLang:         lang,
    lyricsSidecarMtime: sidecarMtime,
  };
}
