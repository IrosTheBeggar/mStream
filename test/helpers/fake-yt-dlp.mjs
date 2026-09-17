// A stand-in for yt-dlp, run under node when MSTREAM_YTDLP_BIN points here
// (src/util/yt-dlp.js resolveBinary). Driven by two environment variables:
//
//   MSTREAM_FAKE_YTDLP_SCRIPT   a JSON file:
//     { search:   { "<query substring>": [entries], "*": [entries] },
//       details:  { "<id>": entry },
//       download: { fail: "message", exitCode: 1, slowMs: 400 } }
//   MSTREAM_FAKE_YTDLP_FIXTURE  the audio file a "download" copies into place
//
// Entries use yt-dlp's own JSON field names (id, title, duration, channel,
// uploader, artist, album, webpage_url, thumbnail). The script file is read
// on every invocation, so a test can rewrite it between cases.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VALUED = new Set(['-o', '-f', '--audio-format', '--ffmpeg-location', '--max-filesize', '--print', '--convert-thumbnails']);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('-') && !VALUED.has(args[i - 1]));
const url = positional[positional.length - 1] || '';

function script() {
  const p = process.env.MSTREAM_FAKE_YTDLP_SCRIPT;
  if (!p) { return {}; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function idOf(u) {
  const m = /[?&]v=([^&]+)/.exec(u);
  return m ? m[1] : u.split('/').filter(Boolean).pop();
}
function allEntries(s) {
  return Object.values(s.search || {}).flat().concat(Object.values(s.details || {}));
}
function entryFor(s, id) {
  return (s.details || {})[id] || allEntries(s).find((e) => e && e.id === id) || { id, title: 'Unknown Upload', duration: 0 };
}

const s = script();

if (has('--dump-json')) {
  if (/^ytsearch\d*:/i.test(url)) {
    const q = url.replace(/^ytsearch\d*:/i, '').toLowerCase();
    const keys = Object.keys(s.search || {}).filter((k) => k !== '*');
    const key = keys.find((k) => q.includes(k.toLowerCase()));
    const rows = (key ? s.search[key] : (s.search || {})['*']) || [];
    for (const r of rows) { process.stdout.write(JSON.stringify(r) + '\n'); }
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(entryFor(s, idOf(url))) + '\n');
  process.exit(0);
}

if (has('-x')) {
  const dl = s.download || {};
  const entry = entryFor(s, idOf(url));
  const restricted = String(entry.title || 'Fake_Song').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const fmt = valueOf('--audio-format') || 'mp3';
  const ext = fmt === 'vorbis' ? 'ogg' : fmt;
  const out = String(valueOf('-o') || '%(title)s.%(ext)s').replace('%(title)s', restricted).replace('%(ext)s', ext);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (const p of [12.5, 43.2, 78.9, 100]) {
      process.stdout.write(`[download]  ${p}% of    5.10MiB at    1.20MiB/s ETA 00:03\n`);
      if (dl.slowMs) { await sleep(dl.slowMs); }
    }
    if (dl.fail) {
      process.stderr.write(`ERROR: ${dl.fail}\n`);
      process.exit(dl.exitCode == null ? 1 : dl.exitCode);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(process.env.MSTREAM_FAKE_YTDLP_FIXTURE, out);
    if (has('--print')) { process.stdout.write(out + '\n'); }
    process.exit(0);
  })();
} else {
  process.stderr.write('fake yt-dlp: unrecognised invocation\n');
  process.exit(2);
}
