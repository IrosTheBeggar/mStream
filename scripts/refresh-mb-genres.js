#!/usr/bin/env node
// Refresh `data/mb-genres.json` from the MusicBrainz API.
//
// mStream uses the MB genre list as a reference for canonicalising
// user-tagged genre strings at scan time (see src/db/manager.js's
// canonicalGenreName function). The list is bundled into the repo
// rather than fetched at runtime — MB rate-limits at 1 req/sec and
// our scanner reads thousands of files, so live lookups would be
// too slow + add a network dependency.
//
// Run this periodically (e.g. quarterly) to pick up new entries
// that the MB community has added since the last refresh, then
// commit the updated JSON. No DB migration needed — the file is
// loaded into memory at boot.
//
// ── USAGE ─────────────────────────────────────────────────────────
//   node scripts/refresh-mb-genres.js
//
// Writes to `data/mb-genres.json` at repo root. Diff the result
// before committing — a sudden 1000-entry surge probably means MB
// changed their endpoint, not that the genre universe grew that
// much overnight.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'mb-genres.json');
const URL = 'https://musicbrainz.org/ws/2/genre/all?fmt=txt';

// Required by MB's API terms — they ask for a meaningful UA so they
// can contact abusers / debug rate-limit issues. Don't impersonate
// a browser; identify ourselves as mStream.
const USER_AGENT = 'mStream-refresh-mb-genres/1.0 ( https://github.com/IrosTheBeggar/mStream )';

async function main() {
  process.stderr.write(`Fetching ${URL}\n`);
  const res = await fetch(URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`MusicBrainz returned ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 1000) {
    // Sanity check — MB had 2,141 entries at the last refresh
    // (May 2026). If the API ever returns a dramatically shorter
    // list, something's wrong (endpoint changed, partial response,
    // anti-bot block). Bail loudly rather than silently overwriting
    // the bundled file with garbage.
    throw new Error(
      `MusicBrainz returned only ${lines.length} entries — looks wrong, refusing to overwrite. ` +
      `Check the API manually: ${URL}`
    );
  }

  const out = {
    source: URL,
    license: 'CC0 — public domain dedication (https://musicbrainz.org/doc/About/Data_License)',
    fetched: new Date().toISOString().slice(0, 10),
    count: lines.length,
    genres: lines,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`Wrote ${lines.length} genres to ${path.relative(REPO_ROOT, OUT_PATH)}\n`);
  process.stderr.write(`Diff the result before committing. Date: ${out.fetched}\n`);
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
