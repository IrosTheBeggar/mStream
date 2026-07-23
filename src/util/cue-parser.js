// Minimal cue-sheet parser for chapter extraction.
//
// A .cue sidecar describes track boundaries inside one (or more) audio
// files — the standard sidecar for single-file CD/vinyl rips and DJ mixes.
// We only need the track map: FILE sections, and per TRACK the TITLE and
// the INDEX 01 start time (INDEX 00 is the pregap; INDEX 01 is where the
// track proper begins — fall back to 00 only when 01 is absent).
//
// Deliberately NOT a full grammar (REM, CATALOG, ISRC, FLAGS, PREGAP are
// skipped): cue files in the wild are hand-edited and sloppy, so we parse
// line-wise and tolerate anything we don't recognize.

/**
 * Parse a cue sheet's text into its FILE sections.
 *
 * @param {string} text raw cue file content
 * @returns {Array<{ file: string|null, tracks: Array<{ number: number,
 *   title: string|null, performer: string|null, startSec: number }> }>}
 *   One entry per FILE section, tracks in file order. Tracks without any
 *   INDEX are dropped. A cue with TRACKs before any FILE line yields a
 *   section with file=null (seen in sloppy hand-made sheets).
 */
export function parseCueSheet(text) {
  // Strip BOM; normalize newlines.
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);

  const files = [];
  let curFile = null;   // current FILE section
  let curTrack = null;  // current TRACK within it

  const ensureFile = () => {
    if (!curFile) {
      curFile = { file: null, tracks: [] };
      files.push(curFile);
    }
    return curFile;
  };

  // "05:31:66" (mm:ss:ff, ff = 1/75s frames) → seconds. Minutes may
  // exceed 99 for long mixes.
  const indexToSec = (mm, ss, ff) =>
    parseInt(mm, 10) * 60 + parseInt(ss, 10) + parseInt(ff, 10) / 75;

  // Value after a keyword: quoted ("...") or bare-to-end-of-line.
  const unquote = (s) => {
    s = s.trim();
    const m = s.match(/^"(.*)"$/);
    return m ? m[1] : s;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { continue; }

    let m;
    if ((m = line.match(/^FILE\s+(.+?)\s+\S+$/i)) || (m = line.match(/^FILE\s+(.+)$/i))) {
      // `FILE "name.flac" WAVE` — the trailing type token is optional in
      // the wild. Close the previous section.
      curFile = { file: unquote(m[1]), tracks: [] };
      files.push(curFile);
      curTrack = null;
    } else if ((m = line.match(/^TRACK\s+(\d+)\s+AUDIO/i))) {
      curTrack = { number: parseInt(m[1], 10), title: null, performer: null, startSec: null, _index00: null };
      ensureFile().tracks.push(curTrack);
    } else if ((m = line.match(/^TITLE\s+(.+)$/i))) {
      // TITLE before any TRACK is the album title — ignore it.
      if (curTrack) { curTrack.title = unquote(m[1]) || null; }
    } else if ((m = line.match(/^PERFORMER\s+(.+)$/i))) {
      if (curTrack) { curTrack.performer = unquote(m[1]) || null; }
    } else if ((m = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d\d?):(\d\d?)$/i))) {
      if (curTrack) {
        const sec = indexToSec(m[2], m[3], m[4]);
        if (parseInt(m[1], 10) === 0) { curTrack._index00 = sec; }
        else if (parseInt(m[1], 10) === 1) { curTrack.startSec = sec; }
        // higher indexes (sub-indexes) are ignored
      }
    }
    // anything else: REM, FLAGS, PREGAP, CATALOG, … — skipped
  }

  // Resolve start times (INDEX 01, else INDEX 00) and drop indexless tracks.
  for (const f of files) {
    f.tracks = f.tracks
      .map(t => {
        const startSec = t.startSec != null ? t.startSec : t._index00;
        return startSec != null
          ? { number: t.number, title: t.title, performer: t.performer, startSec }
          : null;
      })
      .filter(Boolean);
  }

  return files.filter(f => f.tracks.length > 0);
}

/**
 * Pick the track list that applies to a given audio file.
 *
 * Single-FILE cues apply regardless of the name they reference — EAC-era
 * sheets routinely say `FILE "album.wav"` while the actual rip is
 * album.flac; the sidecar basename pairing is the real binding. Multi-FILE
 * cues bind by (case-insensitive) referenced filename.
 *
 * @param {ReturnType<typeof parseCueSheet>} files parsed sections
 * @param {string} audioBasename e.g. "album.flac"
 * @returns {Array<{ number, title, performer, startSec }>} tracks, or []
 */
export function tracksForAudioFile(files, audioBasename) {
  if (files.length === 0) { return []; }
  if (files.length === 1) { return files[0].tracks; }
  const want = String(audioBasename).toLowerCase();
  for (const f of files) {
    if (f.file && f.file.toLowerCase() === want) { return f.tracks; }
  }
  return [];
}
