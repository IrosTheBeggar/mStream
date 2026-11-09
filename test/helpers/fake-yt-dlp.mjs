// A stand-in for yt-dlp, run under node when MSTREAM_YTDLP_BIN points here
// (src/util/yt-dlp.js resolveBinary). Driven by two environment variables:
//
//   MSTREAM_FAKE_YTDLP_SCRIPT   a JSON file:
//     { search:   { "<query substring>": [entries], "*": [entries] },
//       details:  { "<id>": entry },           an entry with `fail` refuses
//                                              its details call AND its
//                                              download with that text, as
//                                              YouTube refuses both
//       download: { fail: "message", exitCode: 1, slowMs: 400,
//                   partBytes: N, tooBig: true, extraStdout: ["line", …] },
//       probe:    { slowMs: 5000 } }           a video's --dump-json answers
//                                              that late (a hung lookup)
//   MSTREAM_FAKE_YTDLP_FIXTURE  the audio file a "download" copies into place
//
// Entries use yt-dlp's own JSON field names (id, title, duration, channel,
// uploader, artist, album, webpage_url, thumbnail, is_live, live_status).
// The script file is read on every invocation, so a test can rewrite it
// between cases.
//
// What it copies of the real binary's behaviour (2026.08.19, checked
// offline): the restricted file name (`title` with every run outside
// [A-Za-z0-9._-] made one `_`); a --dump-json under `-o` naming that file
// (`_filename`, with the source's extension); `--audio-format aac` landing
// as .m4a; a live entry skipped by `--match-filters !is_live` and
// `download.tooBig` refused by --max-filesize, each with exit 0 and no file
// — and a word about it on stdout ONLY when not quiet (`--print` implies
// --quiet unless `--no-quiet` is given too). `download.fail` may name the
// output path as `%(out)s`, as yt-dlp's and ffmpeg's own errors do.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VALUED = new Set(['-o', '-f', '--audio-format', '--ffmpeg-location', '--max-filesize', '--print', '--convert-thumbnails', '--match-filters']);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('-') && !VALUED.has(args[i - 1]));
const url = positional[positional.length - 1] || '';
// What a quiet run would not say.
const loud = has('--no-quiet') || !has('--print');

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
const restrictedTitle = (entry) => String(entry.title || 'Fake_Song').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

const s = script();

if (has('--version')) {
  process.stdout.write(`${s.version || '2026.02.04'}\n`);
  process.exit(0);
}

if (has('--dump-json')) {
  if (/^ytsearch\d*:/i.test(url)) {
    const q = url.replace(/^ytsearch\d*:/i, '').toLowerCase();
    const keys = Object.keys(s.search || {}).filter((k) => k !== '*');
    const key = keys.find((k) => q.includes(k.toLowerCase()));
    const rows = (key ? s.search[key] : (s.search || {})['*']) || [];
    for (const r of rows) { process.stdout.write(JSON.stringify(r) + '\n'); }
    process.exit(0);
  }
  const e = entryFor(s, idOf(url));
  // A lookup that hangs: blocked outright, so only a kill ends it early.
  const stall = Number((s.probe || {}).slowMs) || 0;
  if (stall > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall); }
  if (e.fail) {
    process.stderr.write(`ERROR: [youtube] ${e.id}: ${e.fail}\n`);
    process.exit(1);
  }
  // Under -o (and --restrict-filenames) the dump names the file a download
  // would write, with the source's extension, as the real dump does.
  const named = {};
  if (has('-o')) {
    const name = String(valueOf('-o')).replace('%(title)s', restrictedTitle(e)).replace('%(ext)s', 'webm');
    Object.assign(named, { ext: 'webm', _filename: name, filename: name });
  }
  process.stdout.write(JSON.stringify({ ...e, ...named }) + '\n');
  process.exit(0);
}

if (has('-x')) {
  const dl = s.download || {};
  const entry = entryFor(s, idOf(url));
  const fmt = valueOf('--audio-format') || 'mp3';
  const ext = ({ vorbis: 'ogg', aac: 'm4a' })[fmt] || fmt;
  const out = String(valueOf('-o') || '%(title)s.%(ext)s').replace('%(title)s', restrictedTitle(entry)).replace('%(ext)s', ext);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (entry.fail) {
    process.stderr.write(`ERROR: [youtube] ${entry.id}: ${entry.fail}\n`);
    process.exit(1);
  }
  if (valueOf('--match-filters') === '!is_live' && (entry.is_live === true || entry.live_status === 'is_live')) {
    if (loud) { process.stdout.write(`[download] ${entry.title} does not pass filter (!is_live), skipping ..\n`); }
    process.exit(0);
  }
  // Like the real thing: the thumbnail for --embed-thumbnail lands BEFORE the
  // media, whole, and is only removed once it has been embedded — so a
  // download that fails leaves it behind.
  const thumb = has('--embed-thumbnail') ? out.replace(/\.[^.]+$/, '.jpg') : null;
  (async () => {
    if (thumb) {
      fs.mkdirSync(path.dirname(thumb), { recursive: true });
      fs.writeFileSync(thumb, 'a thumbnail');
    }
    if (dl.tooBig) {
      if (loud) { process.stdout.write('[download] File is larger than max-filesize (16526 bytes > 1024 bytes). Aborting.\n'); }
      process.exit(0);
    }
    // `partBytes`: a fragment file of that size lands first, as a
    // fragmented fetch's do — for the size cap mStream enforces itself.
    if (dl.partBytes) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(`${out}.part-Frag1`, Buffer.alloc(Number(dl.partBytes)));
    }
    for (const p of [12.5, 43.2, 78.9, 100]) {
      process.stdout.write(`[download]  ${p}% of    5.10MiB at    1.20MiB/s ETA 00:03\n`);
      if (dl.slowMs) { await sleep(dl.slowMs); }
    }
    if (dl.fail) {
      process.stderr.write(`ERROR: ${String(dl.fail).split('%(out)s').join(out)}\n`);
      process.exit(dl.exitCode == null ? 1 : dl.exitCode);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(process.env.MSTREAM_FAKE_YTDLP_FIXTURE, out);
    if (thumb) { fs.rmSync(thumb, { force: true }); }   // "embedded"
    // Loud, the real binary names the source file it converted away: a
    // line with a path in it and no [tag], before the printed path.
    if (loud) { process.stdout.write(`Deleting original file ${out.replace(/\.[^.]+$/, '.webm')} (pass -k to keep)\n`); }
    if (has('--print')) { process.stdout.write(out + '\n'); }
    // Whatever a test wants said after the path (the capture must not take
    // it for the path).
    for (const line of dl.extraStdout || []) { process.stdout.write(`${line}\n`); }
    process.exit(0);
  })();
} else {
  process.stderr.write('fake yt-dlp: unrecognised invocation\n');
  process.exit(2);
}
