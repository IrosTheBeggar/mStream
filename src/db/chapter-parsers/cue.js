// Chapter extraction: .cue sidecar files.
// CUE sheets are an old CD-image-burning format that audiobook tagger
// communities co-opted for chapter markers. Each TRACK block has a
// TITLE (chapter name) and an INDEX 01 line in MM:SS:FF where FF is
// frames @ 75fps (1 frame = 13.33ms). We only care about INDEX 01
// (the actual track start); INDEX 00 marks pregap and is ignored.
//
// Returns the same { title, start_ms, end_ms } array shape as the
// embedded parser, or null if the CUE has no usable chapter entries.
//
// Spec reference: https://wiki.hydrogenaud.io/index.php?title=Cue_sheet
// We're forgiving: we tolerate lowercase keywords, mixed line endings,
// quoted-or-unquoted titles, and trailing whitespace. We intentionally
// do NOT parse PREGAP / FLAGS / REM lines — they don't affect chapter
// boundaries.

import fs from 'fs';

const TIME_RE = /^(\d+):(\d{1,2}):(\d{1,2})$/;

export function parseCueFile(filepath, totalDurationMs) {
  let text;
  try {
    text = fs.readFileSync(filepath, 'utf8');
  } catch (_err) {
    return null;
  }
  return parseCueText(text, totalDurationMs);
}

export function parseCueText(text, totalDurationMs) {
  const lines = text.split(/\r?\n/);
  const tracks = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { continue; }

    // TRACK NN AUDIO  → start a new track block
    const trackMatch = /^TRACK\s+\d+\s+\w+/i.exec(line);
    if (trackMatch) {
      if (current && current.start_ms != null) { tracks.push(current); }
      current = { title: null, start_ms: null };
      continue;
    }

    if (!current) { continue; }

    // TITLE "Foo bar"  or  TITLE Foo bar
    const titleMatch = /^TITLE\s+(.+)$/i.exec(line);
    if (titleMatch) {
      current.title = titleMatch[1].replace(/^"|"$/g, '').trim();
      continue;
    }

    // INDEX 01 MM:SS:FF  → chapter start (we ignore INDEX 00 pregap)
    const indexMatch = /^INDEX\s+0?1\s+(\S+)/i.exec(line);
    if (indexMatch) {
      const ms = parseCueTimestamp(indexMatch[1]);
      if (ms != null && current.start_ms == null) {
        current.start_ms = ms;
      }
    }
  }
  if (current && current.start_ms != null) { tracks.push(current); }

  if (tracks.length === 0) { return null; }

  // Compute end_ms from the next start (last chapter ends at total dur).
  tracks.sort((a, b) => a.start_ms - b.start_ms);
  const out = [];
  for (let i = 0; i < tracks.length; i++) {
    const start = tracks[i].start_ms;
    const end = i < tracks.length - 1
      ? tracks[i + 1].start_ms
      : (totalDurationMs ?? start + 1000);
    if (end <= start) { continue; }
    out.push({
      title: tracks[i].title || `Chapter ${i + 1}`,
      start_ms: start,
      end_ms: end,
    });
  }
  return out.length > 0 ? out : null;
}

// MM:SS:FF where FF is frames at 75 fps. (75 frames per second is the
// CD-audio sector rate; predates audiobooks entirely but the format
// stuck.) Larger minute values (audiobooks are long) are fine — the
// regex caps neither MM nor the result.
function parseCueTimestamp(token) {
  const m = TIME_RE.exec(token);
  if (!m) { return null; }
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  const frames  = Number(m[3]);
  if (seconds >= 60 || frames >= 75) { return null; }
  return Math.round((minutes * 60 + seconds) * 1000 + frames * (1000 / 75));
}
