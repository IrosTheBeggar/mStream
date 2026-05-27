// Chapter extraction: plaintext sidecar files (`chapters.txt`,
// `<book>.chapters.txt`, or any `.txt` next to a single-file audiobook).
//
// Format we accept — line-based, one chapter per line:
//   HH:MM:SS Chapter Title
//   H:MM:SS Chapter Title         (single-digit hours OK)
//   MM:SS Chapter Title           (no hours)
//   00:00:00.500 Chapter Title    (millis optional, after a dot)
// The separator between time and title can be whitespace, ` - `, or a tab.
// Blank lines and lines starting with `#` are ignored.
//
// Returns { title, start_ms, end_ms } array, or null on no usable entries.

import fs from 'fs';

const LINE_RE = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\s*[-\t ]+\s*(.+?)\s*$/;

export function parseTxtChaptersFile(filepath, totalDurationMs) {
  let text;
  try {
    text = fs.readFileSync(filepath, 'utf8');
  } catch (_err) {
    return null;
  }
  return parseTxtChaptersText(text, totalDurationMs);
}

export function parseTxtChaptersText(text, totalDurationMs) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { continue; }
    const m = LINE_RE.exec(line);
    if (!m) { continue; }
    const hours   = m[1] != null ? Number(m[1]) : 0;
    const minutes = Number(m[2]);
    const seconds = Number(m[3]);
    const millis  = m[4] != null ? Number(m[4].padEnd(3, '0').slice(0, 3)) : 0;
    if (minutes >= 60 || seconds >= 60) { continue; }
    const start_ms = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
    entries.push({ title: m[5], start_ms });
  }

  if (entries.length === 0) { return null; }

  entries.sort((a, b) => a.start_ms - b.start_ms);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i].start_ms;
    const end = i < entries.length - 1
      ? entries[i + 1].start_ms
      : (totalDurationMs ?? start + 1000);
    if (end <= start) { continue; }
    out.push({ title: entries[i].title, start_ms: start, end_ms: end });
  }
  return out.length > 0 ? out : null;
}
