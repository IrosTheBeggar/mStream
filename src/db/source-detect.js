// V36: detect the `tracks.source` provenance label from a music-metadata
// parsed file's native tag namespace.
//
// Priority order (matches rust-parser/src/main.rs::detect_source_from_tag):
//   1. Explicit MSTREAM_SOURCE tag (written by src/api/ytdl.js when
//      this server downloaded the file, but also picks up files tagged
//      by external tooling that follows the same convention).
//   2. yt-dlp's embedded `purl` field — written automatically by
//      `--embed-metadata`. When the URL points at youtube.com /
//      youtu.be, infer 'ytdl'. Catches files downloaded via plain
//      `yt-dlp` on the command line outside mStream.
//   3. null — every other case. Includes manually-imported files and
//      providers we don't recognise.
//
// music-metadata exposes per-format tags under `parsed.native[tagType]`
// as an array of `{ id, value }`. Per-container ID forms we accept:
//   - ID3v2 (MP3, WAV)   id = 'TXXX:MSTREAM_SOURCE', value = 'ytdl'
//                        (some versions: id = 'TXXX',
//                         value = { description: 'MSTREAM_SOURCE',
//                                   text: ['ytdl'] | 'ytdl' })
//   - Vorbis comments    id = 'MSTREAM_SOURCE',       value = 'ytdl'
//     (FLAC, OGG, Opus)
//   - MP4 atoms          id = '----:com.apple.iTunes:MSTREAM_SOURCE',
//                        value = 'ytdl'
//
// Lives in its own module (rather than inline in scanner.mjs) so tests
// can import it directly — scanner.mjs is a child-process entry point
// and parses process.argv at module load, which makes `import` from
// tests crash on argv-shape mismatches.

// Match the host as its own URL component, not as a substring of some
// other domain. Preceded by ^, /, ., or : (so https://youtu.be matches
// and `mynotyoutube.com` does not); followed by /, :, ?, or end-of-string.
const YOUTUBE_HOST_RE = /(?:^|[/.:])(?:youtube\.com|youtu\.be)(?:[/:?]|$)/i;

function asString(v) {
  if (v == null) { return null; }
  if (typeof v === 'string') { return v; }
  if (typeof v === 'object') {
    if (Array.isArray(v.text)) { return v.text.join(''); }
    if (typeof v.text === 'string') { return v.text; }
    if (typeof v.value === 'string') { return v.value; }
  }
  return null;
}

function matchesMstreamSource(item) {
  if (!item || typeof item.id !== 'string') { return false; }
  const id = item.id;
  if (id === 'MSTREAM_SOURCE') { return true; }
  if (id === 'TXXX:MSTREAM_SOURCE') { return true; }
  if (id.endsWith(':MSTREAM_SOURCE')) { return true; }
  if (id === 'TXXX') {
    const desc = item.value && typeof item.value === 'object' ? item.value.description : null;
    return typeof desc === 'string' && desc.toUpperCase() === 'MSTREAM_SOURCE';
  }
  return false;
}

function matchesPurl(item) {
  if (!item || typeof item.id !== 'string') { return false; }
  const id = item.id.toUpperCase();
  if (id === 'PURL') { return true; }
  if (id === 'TXXX:PURL') { return true; }
  if (id.endsWith(':PURL')) { return true; }
  if (id === 'TXXX') {
    const desc = item.value && typeof item.value === 'object' ? item.value.description : null;
    return typeof desc === 'string' && desc.toUpperCase() === 'PURL';
  }
  return false;
}

export function detectSource(parsed) {
  const native = parsed?.native;
  if (!native || typeof native !== 'object') { return null; }
  let purlVal = null;
  for (const tagType of Object.keys(native)) {
    const items = native[tagType];
    if (!Array.isArray(items)) { continue; }
    for (const item of items) {
      if (matchesMstreamSource(item)) {
        const s = asString(item.value);
        if (s && s.trim()) { return s.trim(); }
      }
      if (purlVal == null && matchesPurl(item)) {
        const s = asString(item.value);
        if (s) { purlVal = s; }
      }
    }
  }
  if (purlVal && YOUTUBE_HOST_RE.test(purlVal)) { return 'ytdl'; }
  return null;
}
