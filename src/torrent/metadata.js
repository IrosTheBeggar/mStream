// Server-authoritative metadata extraction for torrents. The Add
// Torrent panel's "Auto-detect" button calls into here via
// /api/v1/torrent/auto-detect. The module is structured as a
// tier-able pipeline — `extractMetadata` is the orchestrator that
// will accumulate strategies over time, falling through to the next
// tier when the current one's confidence is too low.
//
// Today's stub does Tier 1 only: name-string regex parsing. Future
// tiers (file-list heuristics, partial-byte tag fetching via
// @tokenizer/http, MusicBrainz lookup, AcoustID fingerprinting)
// will compose into the same pipeline. The route's response shape is
// already designed to support whichever method ultimately wins:
//
//   { ok, metadata: {artist, album, year}, confidence, method }
//
// The caller stays agnostic about which tier produced the result —
// it just renders `metadata` with a confidence-driven badge.

import { findField } from './bencode.js';

// ── Tier 1: name-string regex parse ──────────────────────────────────
//
// Real-world music release name conventions. Each pattern captures
// artist / album / year. Patterns are tried in order; the first hit
// wins. Patterns that capture year are "high confidence"; the bare
// "Artist - Album" pattern is "low confidence" because it can match
// non-music torrents too. Confidence is a hint for the route caller
// — the UI uses it to decide between a silent fill and a "best
// guess, please verify" warning.
//
// Coverage is ~70-80% of well-named music releases. The remaining
// 20-30% fall through to higher tiers (when implemented) or to
// manual entry.
const _NAME_PATTERNS = [
  // "Artist - Album (1973)"
  { re: /^(.+?)\s*-\s*(.+?)\s*\((\d{4})\)\s*$/,            map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
  // "Artist - Album [1973]"
  { re: /^(.+?)\s*-\s*(.+?)\s*\[(\d{4})\]\s*$/,            map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
  // "Artist - 1973 - Album"
  { re: /^(.+?)\s*-\s*(\d{4})\s*-\s*(.+?)\s*$/,            map: m => ({ artist: m[1], album: m[3], year: m[2], confidence: 'high' }) },
  // "Artist - Album - 1973"
  { re: /^(.+?)\s*-\s*(.+?)\s*-\s*(\d{4})\s*$/,            map: m => ({ artist: m[1], album: m[2], year: m[3], confidence: 'high' }) },
  // "Artist.Album.1973" — dot-separated
  { re: /^([^.]+)\.([^.]+(?:\.[^.\d][^.]*)*)\.(\d{4})\s*$/, map: m => ({ artist: m[1].replace(/\./g, ' '), album: m[2].replace(/\./g, ' '), year: m[3], confidence: 'high' }) },
  // Bare "Artist - Album"  — low confidence
  { re: /^(.+?)\s*-\s*(.+?)\s*$/,                           map: m => ({ artist: m[1], album: m[2], year: '', confidence: 'low' }) },
];

// Tags we strip BEFORE running patterns so they don't anchor the
// regex match (e.g. "[FLAC]" trailing a pattern would otherwise
// confuse the pattern's `\s*$` anchor).
const _STRIP_TAGS = /[\[(]\s*(FLAC|MP3|320|256|192|V0|V2|AAC|OGG|OPUS|ALAC|DSD|24[Bb]it|16[Bb]it|Lossless|Hi-?Res|WEB|CDRip|VINYL|LP|EP|SACD|Remaster(?:ed)?)[^\])]*[\])]/gi;

export function parseMusicTorrentName(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { artist: '', album: '', year: '', confidence: 'none' };
  }
  const cleaned = rawName
    .replace(_STRIP_TAGS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  for (const p of _NAME_PATTERNS) {
    const m = cleaned.match(p.re);
    if (m) {
      const r = p.map(m);
      return {
        artist:     (r.artist || '').trim(),
        album:      (r.album  || '').trim(),
        year:       (r.year   || '').trim(),
        confidence: r.confidence,
      };
    }
  }
  // Fallback: treat the whole name as the album.
  return { artist: '', album: cleaned, year: '', confidence: 'none' };
}

// ── Tier 2: file-list heuristics ─────────────────────────────────────
//
// Augments Tier 1 with confidence signals derived from the torrent's
// own file list. Doesn't produce primary metadata (artist/album/year)
// — only confirms or rejects Tier 1's read and adds supplementary
// fields (audioFileCount, releaseType, totalSize). The pipeline below
// composes the two:
//
//   T1 high  + T2 has-audio       → stays high (confirmed)
//   T1 high  + T2 no-audio        → demoted to 'none' (not music)
//   T1 low   + T2 track-numbered  → promoted to 'high' (file structure
//                                     confirms music despite weak name)
//   T1 low   + T2 has-audio       → stays low
//   T1 low   + T2 no-audio        → demoted to 'none'
//   T1 none  + any                → stays none (can't synthesise primary
//                                     fields from file list alone)

// Audio file extensions we treat as music. Conservative; the file
// list could include cover art (.jpg, .png), CUE files (.cue), log
// files (.log, .nfo), booklet PDFs (.pdf), or scans (.tif) — none of
// which we count toward the audio-file tally.
const _AUDIO_EXTS = new Set([
  'flac', 'mp3', 'm4a', 'm4b', 'opus', 'ogg', 'aac',
  'wav', 'wave', 'alac', 'ape', 'wv', 'dsf', 'dff', 'mka',
]);

function _extension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

// Match track-number prefixes: "01 - Title.flac", "1.Title.mp3",
// "001_Track.flac", "(01) Track.flac", "01-Title.flac". One to three
// digits at the start, followed by a non-digit separator.
const _TRACK_PREFIX_RE = /^[(\[]?\d{1,3}[)\]]?[\s\-_.]/;

// Match discy/disc-y subdirectory names: "CD1", "CD 1", "Disc 1",
// "Disc-2", "VOL. 3" etc.
const _DISC_DIR_RE = /^(cd|disc|vol)[\s\-_.]*\d{1,2}$/i;

// "199x" / "20xx" leading directory — strong signal for discography
// torrents arranged by year.
const _YEAR_DIR_RE = /^(?:19[5-9]\d|20[0-4]\d)([\s\-_.]|$)/;

/**
 * Walk a parsed info-dict structure and report music-shaped signals.
 *
 * `infoDict` is `findField(buf, 'info').value` — the bencode parser's
 * decoded form. For multi-file torrents `infoDict.files` is an array
 * of `{path: [components], length}`; for single-file torrents
 * `infoDict.name` is the filename and `infoDict.length` is its size.
 */
export function analyseFileList(infoDict) {
  const files = [];
  if (Array.isArray(infoDict.files)) {
    for (const f of infoDict.files) {
      const segs = (f.path || []).map(b => Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
      files.push({ path: segs, length: f.length || 0 });
    }
  } else if (typeof infoDict.length === 'number') {
    const name = infoDict.name ? Buffer.from(infoDict.name).toString('utf8') : '';
    files.push({ path: [name], length: infoDict.length });
  }

  let audioFileCount = 0;
  let totalSize = 0;
  let trackPrefixed = 0;
  const topDirs = new Set();
  let allUnderOneDir = true;
  let firstTopDir = null;
  let hasDiscDirs = false;
  let hasYearDirs = false;
  let smallestAudio = null;        // {pathIndex, length, path}

  files.forEach((f, idx) => {
    totalSize += f.length;
    const filename = f.path[f.path.length - 1] || '';
    const ext = _extension(filename);
    const isAudio = _AUDIO_EXTS.has(ext);
    if (isAudio) {
      audioFileCount += 1;
      if (_TRACK_PREFIX_RE.test(filename)) { trackPrefixed += 1; }
      if (!smallestAudio || f.length < smallestAudio.length) {
        smallestAudio = { pathIndex: idx, length: f.length, path: f.path.slice() };
      }
    }
    // Top-level directory inspection. Multi-file torrents always
    // wrap in a single top-level dir (`info.name`), but the file's
    // own first segment is the daemon-side first segment after the
    // top-level wrapper. Single-file torrents have no subdirs.
    if (f.path.length > 1) {
      const first = f.path[0];
      topDirs.add(first);
      if (firstTopDir === null) { firstTopDir = first; }
      else if (first !== firstTopDir) { allUnderOneDir = false; }
      if (_DISC_DIR_RE.test(first)) { hasDiscDirs = true; }
      if (_YEAR_DIR_RE.test(first)) { hasYearDirs = true; }
    }
  });

  // Classify the shape.
  let releaseType = 'unknown';
  if (audioFileCount === 0) {
    releaseType = 'no-audio';
  } else if (audioFileCount === 1) {
    releaseType = 'single';
  } else if (hasYearDirs && topDirs.size > 1) {
    releaseType = 'discography';
  } else if (hasDiscDirs) {
    releaseType = 'multi-disc';
  } else if (allUnderOneDir || topDirs.size === 0) {
    releaseType = 'album';
  } else {
    releaseType = 'compilation';
  }

  return {
    fileCount:     files.length,
    audioFileCount,
    totalSize,
    trackPrefixedCount: trackPrefixed,
    hasTrackNumberPrefixes: audioFileCount >= 2 && trackPrefixed >= Math.max(2, Math.floor(audioFileCount * 0.6)),
    releaseType,
    smallestAudio,
  };
}

// Compose Tier 1's confidence with Tier 2's signals. Pure function —
// no side effects, easy to unit-test if/when we add tests.
function _composeTier12Confidence(t1, t2) {
  // No audio in the torrent — it's not music, full stop. Even if
  // Tier 1 parsed cleanly off the name, we have hard evidence this
  // isn't a music release.
  if (t2.audioFileCount === 0) {
    return { confidence: 'none', reason: 'no audio files in torrent' };
  }
  // Tier 1 found nothing usable — file list alone can't synthesise
  // artist/album/year, so we can't bootstrap to anything better than
  // 'none'.
  if (t1.confidence === 'none') {
    return { confidence: 'none', reason: 'name-parse failed and file list lacks track-tag signal' };
  }
  // Tier 1 was bare "Artist - Album" but file structure confirms a
  // tracked album → promote.
  if (t1.confidence === 'low' && t2.hasTrackNumberPrefixes) {
    return { confidence: 'high', reason: 'file list confirms album structure' };
  }
  // Tier 1 confident, Tier 2 doesn't disagree → stay high.
  if (t1.confidence === 'high') {
    return { confidence: 'high', reason: 'name-parse confident' };
  }
  return { confidence: t1.confidence };
}

// ── Pipeline orchestrator ────────────────────────────────────────────
//
// Composes the tier list. Today: Tier 1 (name-parse) + Tier 2 (file-
// list heuristics). Tier 3 (partial-byte tag fetching) is invoked
// separately by the route handler because it requires daemon access
// and is a separate async lifecycle.
//
// Returns:
//   { metadata: {artist, album, year},
//     confidence: 'high' | 'low' | 'none',
//     method:     identifier of which tier produced the result,
//     sourceName: the raw torrent name (Tier 1 input),
//     fileShape:  { fileCount, audioFileCount, totalSize, releaseType,
//                   hasTrackNumberPrefixes, smallestAudio? } }
//
// Throws only on bad input (e.g. unparseable bencode). The "no
// metadata found" case is a normal return with `confidence: 'none'`.
export function extractMetadata(metainfoBuffer) {
  const info = findField(metainfoBuffer, 'info');
  if (!info.found) {
    throw new Error('torrent has no info dict');
  }

  // Tier 1: parse the torrent's `name` field.
  const rawName = info.value.name ? Buffer.from(info.value.name).toString('utf8') : '';
  const t1 = parseMusicTorrentName(rawName);

  // Tier 2: walk the file list for music-shape signals.
  const t2 = analyseFileList(info.value);
  const composed = _composeTier12Confidence(t1, t2);

  return {
    metadata: {
      artist: t1.artist,
      album:  t1.album,
      year:   t1.year,
    },
    confidence: composed.confidence,
    method:     'name-parse+file-list',
    sourceName: rawName,
    fileShape: {
      fileCount:              t2.fileCount,
      audioFileCount:         t2.audioFileCount,
      totalSize:              t2.totalSize,
      releaseType:            t2.releaseType,
      hasTrackNumberPrefixes: t2.hasTrackNumberPrefixes,
      // smallestAudio carries the file path Tier 3 will target. The
      // route exposes the existence (boolean) but not the path
      // itself in the response — it's an internal handoff.
      hasAudio:               t2.audioFileCount > 0,
    },
    // Internal-only — consumed by Tier 3 if it runs. Stripped from
    // the API response by the route handler.
    _smallestAudio: t2.smallestAudio,
    _composeReason: composed.reason,
  };
}
