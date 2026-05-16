/**
 * Tests for the random-songs Auto-DJ route (src/api/random.js).
 *
 * Two layers:
 *
 *   1. Unit tests for the pure helpers — Camelot expansion, BPM/key
 *      SQL fragment builder, and the post-fallback tier filter. These
 *      don't need a server, run in milliseconds, and lock the SQL
 *      shape in so a future refactor that breaks the tier semantics
 *      surfaces immediately.
 *
 *   2. Integration tests against a real booted mStream — exercises
 *      the Express handler, Joi validation, libraryFilter, the
 *      waterfall dispatch, and the JSON envelope. Uses the same
 *      pattern as test/search-route.test.mjs: public/no-users mode
 *      + direct DB seeding (no ffmpeg fixture dependency).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  CAMELOT_TO_KEYS,
  expandCamelotCodes,
  buildBpmKeyFilter,
  buildGenreFilter,
  applyTierFilter,
} from '../src/api/random.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// Unit tests — pure functions, no server.
// ─────────────────────────────────────────────────────────────────────

describe('CAMELOT_TO_KEYS map', () => {
  test('covers every Camelot code 1A..12B', () => {
    const codes = [];
    for (let i = 1; i <= 12; i++) {
      codes.push(`${i}A`, `${i}B`);
    }
    for (const c of codes) {
      assert.ok(CAMELOT_TO_KEYS[c], `missing Camelot code ${c}`);
      assert.ok(CAMELOT_TO_KEYS[c].length >= 2, `expansion for ${c} too small`);
      // The code itself must be in its expansion so a DB storing
      // "8A" verbatim still matches when the client sends "8A".
      assert.ok(CAMELOT_TO_KEYS[c].includes(c), `${c} not in its own expansion`);
    }
  });

  test('enharmonic codes include both sharp and flat spellings', () => {
    // 1A = Ab minor / G# minor. Both must be present.
    assert.ok(CAMELOT_TO_KEYS['1A'].includes('Ab minor'));
    assert.ok(CAMELOT_TO_KEYS['1A'].includes('G# minor'));
    // 2B = F# major / Gb major.
    assert.ok(CAMELOT_TO_KEYS['2B'].includes('F# major'));
    assert.ok(CAMELOT_TO_KEYS['2B'].includes('Gb major'));
  });

  test('object is frozen — accidental mutation throws in strict mode', () => {
    assert.ok(Object.isFrozen(CAMELOT_TO_KEYS));
    assert.throws(() => { CAMELOT_TO_KEYS['1A'] = ['mutated']; });
  });
});

describe('expandCamelotCodes', () => {
  test('returns empty array for empty/missing input', () => {
    assert.deepEqual(expandCamelotCodes(undefined), []);
    assert.deepEqual(expandCamelotCodes(null), []);
    assert.deepEqual(expandCamelotCodes([]), []);
  });

  test('unknown codes drop silently', () => {
    assert.deepEqual(expandCamelotCodes(['99X', 'foo']), []);
  });

  test('mixed known/unknown returns only known expansions', () => {
    const out = expandCamelotCodes(['8A', '99X', '8B']);
    // 8A=A minor variants, 8B=C major variants. Unknown 99X dropped.
    assert.ok(out.includes('A minor'));
    assert.ok(out.includes('C major'));
  });

  test('deduplicates across overlapping codes', () => {
    // No two Camelot codes share an expansion, but the dedup happens
    // anyway via the Set in the impl — make that contract observable
    // so a future refactor can't silently drop it.
    const out = expandCamelotCodes(['8A', '8A']);
    const counts = {};
    for (const k of out) { counts[k] = (counts[k] || 0) + 1; }
    for (const [k, n] of Object.entries(counts)) {
      assert.equal(n, 1, `${k} appeared ${n} times`);
    }
  });

  test('trims whitespace around codes', () => {
    const trimmed = expandCamelotCodes(['  8A  ']);
    const untrimmed = expandCamelotCodes(['8A']);
    assert.deepEqual(trimmed, untrimmed);
  });
});

describe('buildBpmKeyFilter', () => {
  test('empty opts → no clauses, no params', () => {
    assert.deepEqual(buildBpmKeyFilter({}), { clauses: [], params: [] });
  });

  test('bpmRanges single range → one OR clause + IS NOT NULL guard', () => {
    const { clauses, params } = buildBpmKeyFilter({ bpmRanges: [{ min: 120, max: 130 }] });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /t\.bpm IS NOT NULL/);
    assert.match(clauses[0], /\(t\.bpm >= \? AND t\.bpm <= \?\)/);
    assert.deepEqual(params, [120, 130]);
  });

  test('bpmRanges multiple ranges → OR-ed (octave equivalence)', () => {
    // Normal + half-tempo + double-tempo — exactly what velvet sends.
    const { clauses, params } = buildBpmKeyFilter({
      bpmRanges: [
        { min: 116, max: 132 },  // ±8 around 124
        { min: 58,  max: 66  },  // half tempo
        { min: 232, max: 264 },  // double tempo
      ],
    });
    assert.equal(clauses.length, 1);
    // Three OR-d ranges.
    const orCount = (clauses[0].match(/OR/g) || []).length;
    assert.equal(orCount, 2);
    assert.deepEqual(params, [116, 132, 58, 66, 232, 264]);
  });

  test('bpmRanges takes precedence over bpmMin/bpmMax/requireBpm', () => {
    // velvet's same fallback: when bpmRanges is set, the legacy
    // single-bound knobs are ignored — they exist only for clients
    // that don't speak the new ranges format.
    const { clauses, params } = buildBpmKeyFilter({
      bpmRanges: [{ min: 100, max: 110 }],
      bpmMin: 50,
      bpmMax: 60,
      requireBpm: true,
    });
    assert.equal(clauses.length, 1);
    assert.deepEqual(params, [100, 110]);
  });

  test('requireBpm alone → IS NOT NULL clause only', () => {
    const { clauses, params } = buildBpmKeyFilter({ requireBpm: true });
    assert.deepEqual(clauses, ['t.bpm IS NOT NULL']);
    assert.deepEqual(params, []);
  });

  test('bpmMin alone → IS NOT NULL + >= bound', () => {
    const { clauses, params } = buildBpmKeyFilter({ bpmMin: 120 });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], />= \?$/);
    assert.deepEqual(params, [120]);
  });

  test('musicalKeys expand via Camelot map → IN (?, ?, ...) clause', () => {
    const { clauses, params } = buildBpmKeyFilter({ musicalKeys: ['8A'] });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /t\.musical_key IS NOT NULL AND t\.musical_key IN \(/);
    // 8A → ['8A', 'A minor', 'Amin', 'Am']
    assert.ok(params.includes('A minor'));
    assert.ok(params.includes('8A'));
  });

  test('musicalKeys with only unknown codes → no clause', () => {
    // Unknown codes drop in expandCamelotCodes → no raw keys → no clause.
    const { clauses } = buildBpmKeyFilter({ musicalKeys: ['99X', 'fooBar'] });
    assert.deepEqual(clauses, []);
  });

  test('requireMusicalKey adds IS NOT NULL guard', () => {
    const { clauses } = buildBpmKeyFilter({ requireMusicalKey: true });
    assert.deepEqual(clauses, ['t.musical_key IS NOT NULL']);
  });

  test('bpmRanges + musicalKeys produces two independent clauses', () => {
    const { clauses, params } = buildBpmKeyFilter({
      bpmRanges: [{ min: 120, max: 130 }],
      musicalKeys: ['8A'],
    });
    assert.equal(clauses.length, 2);
    // bpmRanges params come first, then key params.
    assert.equal(params[0], 120);
    assert.equal(params[1], 130);
    assert.ok(params.slice(2).includes('A minor'));
  });
});

describe('applyTierFilter', () => {
  // Row helper — sparse fields only since classifyRow only reads bpm + musical_key.
  const r = (bpm, musical_key, id = 0) => ({ id, bpm, musical_key });

  test('no constraints → identity (returns rows unchanged)', () => {
    const rows = [r(120, 'Am'), r(null, null), r(80, 'C')];
    assert.deepEqual(applyTierFilter(rows, {}), rows);
  });

  test('BPM in range → Tier 0; out of range → Tier 2 (dropped if Tier 0 exists)', () => {
    const rows = [
      r(125, null, 1),   // Tier 0: BPM good, key NA
      r(80,  null, 2),   // Tier 2: BPM wrong, key NA
    ];
    const filtered = applyTierFilter(rows, {
      bpmRanges: [{ min: 120, max: 130 }],
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 1);
  });

  test('unknown BPM passes through as Tier 1 when no Tier 0 exists', () => {
    const rows = [
      r(80,  null, 1),    // Tier 2: BPM wrong
      r(null, null, 2),   // Tier 1: BPM unknown
    ];
    const filtered = applyTierFilter(rows, {
      bpmRanges: [{ min: 120, max: 130 }],
    });
    // No Tier 0 → fall back to Tier 1 (unknown BPM).
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 2);
  });

  test('all rows Tier 2 → return them (no Tier 0/1 to prefer)', () => {
    const rows = [
      r(80,  null, 1),
      r(200, null, 2),
    ];
    const filtered = applyTierFilter(rows, {
      bpmRanges: [{ min: 120, max: 130 }],
    });
    assert.equal(filtered.length, 2);
  });

  test('combined BPM+key: good BPM + good key = Tier 0', () => {
    const rows = [
      r(125, 'A minor', 1), // bpm good, key good → Tier 0
      r(125, 'Cmaj',    2), // bpm good, key wrong → Tier 2
      r(80,  'A minor', 3), // bpm wrong, key good → Tier 2 (one wrong sinks it)
    ];
    const filtered = applyTierFilter(rows, {
      bpmRanges:   [{ min: 120, max: 130 }],
      musicalKeys: ['8A'], // expands to A minor / Am / Amin / 8A
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 1);
  });

  test('one good + one unknown = both Tier 0/1, picks Tier 0', () => {
    // Per classifyRow: bpm=good and key=na → Tier 0. So if there's no
    // key constraint, a known-good BPM row is Tier 0 regardless of key.
    const rows = [
      r(125, 'whatever', 1), // BPM good, no key constraint → Tier 0
      r(null, 'whatever', 2), // BPM unknown → Tier 1
    ];
    const filtered = applyTierFilter(rows, {
      bpmRanges: [{ min: 120, max: 130 }],
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 1);
  });
});

describe('buildGenreFilter', () => {
  test('empty / undefined opts → no clauses', () => {
    assert.deepEqual(buildGenreFilter({}), { clauses: [], params: [] });
    assert.deepEqual(buildGenreFilter({ genres: [] }), { clauses: [], params: [] });
    assert.deepEqual(buildGenreFilter({ genres: undefined }), { clauses: [], params: [] });
    assert.deepEqual(buildGenreFilter({ genres: null }), { clauses: [], params: [] });
  });

  test('single-genre whitelist → one EXISTS clause, one ?', () => {
    const { clauses, params } = buildGenreFilter({ genres: ['Jazz'], mode: 'whitelist' });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /\bEXISTS\b/);
    assert.doesNotMatch(clauses[0], /\bNOT EXISTS\b/);
    assert.match(clauses[0], /IN \(\?\)/);
    assert.deepEqual(params, ['Jazz']);
  });

  test('multi-genre whitelist → one EXISTS clause with N ?s (single-EXISTS-multi-IN)', () => {
    const { clauses, params } = buildGenreFilter({ genres: ['Jazz', 'Funk', 'Hip Hop'], mode: 'whitelist' });
    // Single clause, NOT three — the IN list packs all names into one EXISTS subquery
    // so a track with multiple matching genres returns once (not once per match).
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /IN \(\?,\?,\?\)/);
    assert.deepEqual(params, ['Jazz', 'Funk', 'Hip Hop']);
  });

  test('single-genre blacklist → one NOT EXISTS clause', () => {
    const { clauses, params } = buildGenreFilter({ genres: ['Country'], mode: 'blacklist' });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /\bNOT EXISTS\b/);
    assert.deepEqual(params, ['Country']);
  });

  test('multi-genre blacklist → one NOT EXISTS clause with N ?s', () => {
    const { clauses, params } = buildGenreFilter({ genres: ['Country', 'Disco'], mode: 'blacklist' });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /\bNOT EXISTS\b/);
    assert.match(clauses[0], /IN \(\?,\?\)/);
    assert.deepEqual(params, ['Country', 'Disco']);
  });

  test('emitted SQL includes COLLATE NOCASE', () => {
    // Symmetric with getGenres in src/api/db.js which sorts COLLATE NOCASE —
    // both reader and filter need to agree on case-folding or a Jazz/jazz
    // library row split would surface as "matches in dropdown, doesn't match
    // in filter."
    const { clauses } = buildGenreFilter({ genres: ['Jazz'] });
    assert.match(clauses[0], /COLLATE NOCASE/i);
  });

  test('omitted mode defaults to whitelist (defence-in-depth for direct callers)', () => {
    // Joi adds the default at the route layer; the helper also defaults to
    // whitelist when called directly without `mode` so refactors that bypass
    // Joi (e.g. internal callers) don't silently flip to NOT EXISTS.
    const { clauses } = buildGenreFilter({ genres: ['Jazz'] });
    assert.match(clauses[0], /\bEXISTS\b/);
    assert.doesNotMatch(clauses[0], /\bNOT EXISTS\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Integration tests — booted server + seeded DB.
// ─────────────────────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`, { cause: lastErr });
}

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1', ui: 'default',
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0 },
  };
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// Seed a deterministic 8-track mix covering every BPM/key tier the
// route can land in, plus a track_genres distribution that covers the
// genre-filter cases (whitelist hit, blacklist hit, untagged → block
// under whitelist / allow under blacklist):
//
//   t1  bpm=124 key="A minor"    — Jazz + Funk          (multi-genre)
//   t2  bpm=125 key="Am"         — Jazz                 (single)
//   t3  bpm=128 key="C major"    — Hip Hop + Funk       (multi-genre)
//   t4  bpm=140 key="A minor"    — Rock                 (single)
//   t5  bpm=200 key="A minor"    — Rock + Metal         (multi-genre)
//   t6  bpm=null key="A minor"   — Electronic           (single)
//   t7  bpm=125 key=null         — Hip Hop              (single)
//   t8  bpm=null key=null        — (no genre rows)      — the "untagged" track
//
// The 6 distinct genres in the seed are picked so each genre points at
// 1-2 tracks, letting whitelist tests prove ANY-match semantics
// (e.g. ['Funk'] returns t1 OR t3 but never anything else).
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const lib1 = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Random Artist')").run().lastInsertRowid);
  const albId = Number(db.prepare(
    "INSERT INTO albums (name, artist_id, year) VALUES ('Random Album', ?, 2020)"
  ).run(aid).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id, bpm, musical_key, bpm_source)
    VALUES (?, ?, ?, ?, ?, 2020, 'flac', ?, ?, ?, 'seed', ?, ?, ?)
  `);
  let ts = 1700000000000;
  const rows = [
    ['t1.flac', 't1', 124,  'A minor', 'tag'],
    ['t2.flac', 't2', 125,  'Am',      'tag'],
    ['t3.flac', 't3', 128,  'C major', 'tag'],
    ['t4.flac', 't4', 140,  'A minor', 'tag'],
    ['t5.flac', 't5', 200,  'A minor', 'tag'],
    ['t6.flac', 't6', null, 'A minor', 'tag'],
    ['t7.flac', 't7', 125,  null,      'tag'],
    ['t8.flac', 't8', null, null,      null],
  ];
  const trackIds = {};
  for (let i = 0; i < rows.length; i++) {
    const [filepath, title, bpm, key, src] = rows[i];
    const res = insT.run(filepath, lib1, title, aid, albId, `h${i}`, `a${i}`, ts++, bpm, key, src);
    trackIds[title] = Number(res.lastInsertRowid);
  }

  // V35 plan — genre seeding. Insert into `genres` first, then
  // track_genres mappings. genres.name is UNIQUE so we can't dedup
  // by INSERT OR IGNORE without losing the id of the existing row;
  // we explicitly track the genre→id map.
  const insG = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const genreIds = {};
  for (const name of ['Jazz', 'Funk', 'Hip Hop', 'Rock', 'Metal', 'Electronic']) {
    genreIds[name] = Number(insG.run(name).lastInsertRowid);
  }
  const insTG = db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  const trackGenres = {
    t1: ['Jazz', 'Funk'],
    t2: ['Jazz'],
    t3: ['Hip Hop', 'Funk'],
    t4: ['Rock'],
    t5: ['Rock', 'Metal'],
    t6: ['Electronic'],
    t7: ['Hip Hop'],
    // t8 left genre-less on purpose — the "untagged track" branch
    // verifies whitelist BLOCKs / blacklist ALLOWs untagged rows.
  };
  for (const [title, gnames] of Object.entries(trackGenres)) {
    for (const gname of gnames) {
      insTG.run(trackIds[title], genreIds[gname]);
    }
  }

  db.close();
}

async function randomReq(baseUrl, body) {
  const r = await fetch(`${baseUrl}/api/v1/db/random-songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// Helper — pull the title back out of the response so tests don't
// have to dig through filepath strings.
function pickedTitle(resp) {
  return resp.body?.songs?.[0]?.metadata?.title || null;
}

describe('POST /api/v1/db/random-songs — BPM/key waterfall', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-random-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir);
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Simple mode — backwards compat ────────────────────────────────

  test('empty body → simple random pick, 8 candidates', async () => {
    // No BPM/key params → skips waterfall, picks from all 8 rows.
    const r = await randomReq(server.baseUrl, {});
    assert.equal(r.status, 200);
    assert.ok(r.body.songs.length === 1);
    assert.ok(typeof r.body.songs[0].metadata.title === 'string');
  });

  test('ignoreList round-trip works in simple mode', async () => {
    const r = await randomReq(server.baseUrl, { ignoreList: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignoreList.length, 1);
    assert.ok(r.body.ignoreList[0] >= 0);
  });

  // ── PR-E0: bpm + musical-key fields exposed in metadata response ──
  //
  // Field name is `musical-key` (kebab-case) on the wire to match
  // the existing convention (`album-art`, `play-count`, etc.). The
  // DB column underneath stays `musical_key` (snake_case, SQL
  // convention) — see renderMetadataObj in src/api/db.js for the
  // mapping.

  test('metadata response includes bpm and musical-key (PR-E0 client-side Auto-DJ needs these)', async () => {
    // The seed inserts t1=(bpm:124,key:"A minor"), t2=(bpm:125,key:"Am"),
    // … t8=(bpm:null,key:null). A no-filter pick can land on any row,
    // so the assertion is "the FIELDS exist on every row", not "the
    // values are non-null". Without these the webapp can't drive
    // BPM-continuity / harmonic-mixing toggles.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, {});
      assert.equal(r.status, 200);
      const meta = r.body.songs[0].metadata;
      assert.ok('bpm' in meta, 'metadata missing bpm field');
      assert.ok('musical-key' in meta, 'metadata missing musical-key field');
      // bpm: number-or-null. musical-key: string-or-null.
      assert.ok(meta.bpm === null || typeof meta.bpm === 'number',
        `bpm must be number|null, got ${typeof meta.bpm}`);
      assert.ok(meta['musical-key'] === null || typeof meta['musical-key'] === 'string',
        `musical-key must be string|null, got ${typeof meta['musical-key']}`);
    }
  });

  test('metadata response uses kebab-case (musical-key, not snake_case)', async () => {
    // Regression guard: every multi-word field on this object is
    // kebab-case (album-art, play-count, last-played, replaygain-track).
    // A future commit that adds `musical_key` back as a snake_case
    // duplicate or rename must surface as a loud test failure.
    const r = await randomReq(server.baseUrl, {});
    assert.equal(r.status, 200);
    const meta = r.body.songs[0].metadata;
    assert.ok(!('musical_key' in meta),
      'snake_case `musical_key` leaked onto wire — should be kebab-case `musical-key`');
  });

  test('metadata reflects DB row values for a BPM-tagged track (round-trip)', async () => {
    // Use the BPM/key seed to force a specific row: ranges [124,124]
    // and key 8A both narrow to t1 (bpm=124, key="A minor").
    const r = await randomReq(server.baseUrl, {
      bpmRanges: [{ min: 124, max: 124 }],
      musicalKeys: ['8A'],
    });
    assert.equal(r.status, 200);
    // t1 or t2 — both 124/125 with 8A-variant keys. The narrow range
    // pins to t1 (124, "A minor").
    const meta = r.body.songs[0].metadata;
    assert.equal(meta.bpm, 124);
    assert.equal(meta['musical-key'], 'A minor');
  });

  test('metadata.bpm and musical-key are null for an untagged track', async () => {
    // t8 has both columns NULL. Use an impossible BPM range so the
    // waterfall drops to step 10 (unrestricted random) — t8 is in
    // Tier 1 (both unknown, neither known-wrong) when the request's
    // bpmRanges + musicalKeys both classify as "unknown".
    const r = await randomReq(server.baseUrl, {
      bpmRanges: [{ min: 10, max: 20 }],
      musicalKeys: ['1A'],
    });
    assert.equal(r.status, 200);
    // The tier filter promotes t8 (null/null → Tier 1) when no Tier 0
    // exists. Confirm both columns are explicitly null (not undefined).
    const meta = r.body.songs[0].metadata;
    assert.equal(meta.bpm, null);
    assert.equal(meta['musical-key'], null);
  });

  // ── Joi validation ────────────────────────────────────────────────

  test('bpmRanges item missing min → 403', async () => {
    const r = await randomReq(server.baseUrl, { bpmRanges: [{ max: 130 }] });
    assert.equal(r.status, 403);
  });

  test('minRating > 10 → 403', async () => {
    const r = await randomReq(server.baseUrl, { minRating: 11 });
    assert.equal(r.status, 403);
  });

  test('minRating < 0 → 403', async () => {
    // 0 is accepted (alpha UI's "Disabled" rating option sends 0 by
    // default — see webapp/assets/js/mstream.player.js:71). Negative
    // values still rejected as semantically meaningless.
    const r = await randomReq(server.baseUrl, { minRating: -1 });
    assert.equal(r.status, 403);
  });

  test('minRating = 0 is accepted (legacy alpha-UI compat)', async () => {
    // Backwards-compat regression test: pre-V32 the route accepted
    // any minRating because the body branch `if (req.body.minRating && ...)`
    // skipped the filter when 0 (falsy). PR #586 must preserve that
    // — every default autoDJ() call from the current webapp sends
    // `minRating: 0` and would otherwise hit 403.
    const r = await randomReq(server.baseUrl, { minRating: 0 });
    // Status can be 200 (pick found) or 400 (scope empty) — what we
    // assert here is that Joi did NOT reject the payload.
    assert.notEqual(r.status, 403, 'minRating=0 must not be Joi-rejected');
  });

  test('ignorePercentage > 1 → 403', async () => {
    const r = await randomReq(server.baseUrl, { ignorePercentage: 1.5 });
    assert.equal(r.status, 403);
  });

  test('unknown body key → 403 (Joi default rejects unknown keys)', async () => {
    const r = await randomReq(server.baseUrl, { totallyMadeUp: 'whatever' });
    assert.equal(r.status, 403);
  });

  // ── Joi: array caps + bpmRange ordering (audit follow-up) ─────────

  test('bpmRanges item with min > max → 403', async () => {
    // Backwards range is the most common typo and would silently match
    // nothing — the custom Joi validator on bpmRangeItem now 403s it.
    const r = await randomReq(server.baseUrl, {
      bpmRanges: [{ min: 200, max: 50 }],
    });
    assert.equal(r.status, 403);
  });

  test('bpmRanges item with min === max → 200 (degenerate but valid)', async () => {
    // The validator is min <= max — equal bounds are a one-BPM exact
    // match. Useful for "play more songs at exactly 128 BPM".
    const r = await randomReq(server.baseUrl, {
      bpmRanges: [{ min: 128, max: 128 }],
    });
    // Not rejected at the Joi layer. May return 400 if no t.bpm=128
    // exists in the fixture (it doesn't — t1=124, t2=125, t3=128).
    assert.notEqual(r.status, 403);
  });

  test('artists array exceeds max=100 → 403', async () => {
    const longArtists = Array.from({ length: 101 }, (_, i) => `Artist${i}`);
    const r = await randomReq(server.baseUrl, { artists: longArtists });
    assert.equal(r.status, 403);
  });

  test('ignoreArtists array exceeds max=100 → 403', async () => {
    const longArtists = Array.from({ length: 101 }, (_, i) => `Artist${i}`);
    const r = await randomReq(server.baseUrl, { ignoreArtists: longArtists });
    assert.equal(r.status, 403);
  });

  test('ignoreList array exceeds max=500 → 403', async () => {
    const longList = Array.from({ length: 501 }, (_, i) => i);
    const r = await randomReq(server.baseUrl, { ignoreList: longList });
    assert.equal(r.status, 403);
  });

  test('musicalKeys array exceeds max=24 → 403', async () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `${(i % 12) + 1}A`);
    const r = await randomReq(server.baseUrl, { musicalKeys: tooMany });
    assert.equal(r.status, 403);
  });

  test('bpmRanges array exceeds max=16 → 403', async () => {
    const tooManyRanges = Array.from({ length: 17 }, (_, i) => ({
      min: 60 + i, max: 70 + i,
    }));
    const r = await randomReq(server.baseUrl, { bpmRanges: tooManyRanges });
    assert.equal(r.status, 403);
  });

  // ── Step 1: tight BPM + key ───────────────────────────────────────

  test('tight BPM range + 8A key → picks t1 or t2 only', async () => {
    // Range [120,130] + 8A (A minor variants). Only t1 + t2 qualify.
    // t3 has the right BPM but wrong key (C major). t4 is wide-only.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges: [{ min: 120, max: 130 }],
        musicalKeys: ['8A'],
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t1', 't2'].includes(title), `unexpected pick ${title} for tight BPM+key`);
    }
    // Across 20 picks we should have hit both eligible rows at least
    // once — exposes a hash-collision-style bug where only one is ever
    // selected. Two rows + random index → probability of all-one is
    // (1/2)^20 ≈ 1e-6.
    assert.ok(seen.size === 2 || seen.size === 1, `seen titles: ${[...seen].join(',')}`);
  });

  test('tight BPM only (no key) → picks any 120..130 row', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges: [{ min: 120, max: 130 }],
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // t1 (124, Am), t2 (125, Am), t3 (128, Cmaj), t7 (125, null) all qualify.
    // t4 (140) and t5 (200) are out of range; t6/t8 have null BPM so the
    // SQL filter (bpm IS NOT NULL) excludes them at step 1.
    for (const title of seen) {
      assert.ok(['t1', 't2', 't3', 't7'].includes(title), `unexpected pick ${title}`);
    }
  });

  // ── Step 2: wide BPM + key fallback ───────────────────────────────

  test('tight range = empty → falls through to bpmRangesWide', async () => {
    // Tight = [50,60] (no matches). Wide = [130,150]. Key = 8A.
    // t4 is the only row at 140 with A minor → must be the pick.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges:     [{ min: 50,  max: 60  }],
        bpmRangesWide: [{ min: 130, max: 150 }],
        musicalKeys:   ['8A'],
      });
      assert.equal(r.status, 200);
      assert.equal(pickedTitle(r), 't4');
    }
  });

  // ── Step 3: drop key fallback ─────────────────────────────────────

  test('tight BPM + key both empty → drops key, returns tight-BPM-only matches', async () => {
    // Use BPM range that hits t3 (128, Cmaj) with key=8A (no match for t3).
    // No wide range. So step1=empty, step2=skip, step3=BPM only.
    // Step3 hits t1,t2,t3,t7 (all 120..130). The tier filter then
    // promotes Tier 0 (bpm in range, key not-wrong): t1,t2,t3 (all
    // have a key) and t7 (key null → still Tier 0 since key=na for
    // the key dimension after we drop the key constraint... actually
    // wait — step3 drops the key constraint at SQL level but the
    // tier filter still uses the ORIGINAL musicalKeys to classify.
    // So t1,t2 are Tier 0 (BPM good, key good), t7 is Tier 0 (BPM
    // good, key NA after drop... no — the tier filter classifies
    // against the request's musicalKeys=['8A'], and t7.musical_key
    // is NULL, so keyStatus='unknown', bpmStatus='good' → Tier 0.
    // t3 has key='C major' = wrong → bpmStatus='good' but
    // keyStatus='wrong' → Tier 2. So picks: t1,t2,t7.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges:   [{ min: 120, max: 130 }],
        musicalKeys: ['1A'], // Ab minor — won't match any seeded row → step 1 empty
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Step 3 returns BPM-in-range rows. Tier filter then picks the
    // best class. Since 1A doesn't match any seeded key, every BPM-
    // in-range row that has a key set has keyStatus='wrong' (Tier 2);
    // only t7 has key=null → Tier 1. So expected pick is t7.
    assert.deepEqual([...seen], ['t7'], `seen=${[...seen]}`);
  });

  // ── Step 4: wide BPM only ─────────────────────────────────────────

  test('tight empty + wide empty for key → drops to wide BPM only', async () => {
    // Tight = [50,60] (no matches). Wide = [130,150]. Key = 1A (no
    // matches). Step1=empty, step2=empty (wide+1A → t4 has 8A not 1A),
    // step3=tight BPM only (50..60) → empty, step4=wide BPM only =
    // [130,150] → t4 (140, A minor). Tier filter on bpmRanges=[50..60]
    // → t4.bpm=140 is wrong → Tier 2. Single row in Tier 2 → returned.
    for (let i = 0; i < 3; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges:     [{ min: 50,  max: 60  }],
        bpmRangesWide: [{ min: 130, max: 150 }],
        musicalKeys:   ['1A'],
      });
      assert.equal(r.status, 200);
      assert.equal(pickedTitle(r), 't4');
    }
  });

  // ── Step 5: full random fallback ──────────────────────────────────

  test('all BPM/key constraints fail → falls through to unrestricted random', async () => {
    // BPM range that nothing hits. No wide. Key that nothing hits.
    // → All four early steps empty → step 5 returns all 8 seeded rows.
    // After tier filter (against the original bpmRanges + musicalKeys):
    //   • Tier 0 needs bpm in [10..20] AND key in 1A expansion → 0 rows
    //   • Tier 1 needs neither known-wrong → t8 (null/null) qualifies
    //   • Tier 2 has the rest
    // → Tier 1 has t8, so pick is t8.
    for (let i = 0; i < 3; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges:   [{ min: 10, max: 20 }],
        musicalKeys: ['1A'],
      });
      assert.equal(r.status, 200);
      assert.equal(pickedTitle(r), 't8');
    }
  });

  // ── Camelot expansion end-to-end ──────────────────────────────────

  test('musicalKeys=[8A] matches both "A minor" and "Am"', async () => {
    // Wide BPM enough to catch t1 (A minor) and t2 (Am). 8A expands
    // to both spellings.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges:   [{ min: 120, max: 130 }],
        musicalKeys: ['8A'],
      });
      seen.add(pickedTitle(r));
    }
    assert.ok(seen.has('t1'), 'A minor variant missed');
    assert.ok(seen.has('t2'), 'Am variant missed');
  });

  // ── Octave equivalence (multiple ranges OR-ed) ────────────────────

  test('bpmRanges with normal+half+double tempo OR-s in SQL', async () => {
    // Normal [120..130] catches t1,t2,t3,t7. Half [60..65] catches
    // nothing. Double [240..260] catches nothing. Result identical
    // to single-range [120..130] case → exercises the SQL OR fanout.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        bpmRanges: [
          { min: 120, max: 130 },
          { min: 60,  max: 65  },
          { min: 240, max: 260 },
        ],
      });
      seen.add(pickedTitle(r));
    }
    // Same eligible set as the tight-BPM-only test above.
    for (const title of seen) {
      assert.ok(['t1', 't2', 't3', 't7'].includes(title), `unexpected pick ${title}`);
    }
  });

  // ── minRating + BPM ────────────────────────────────────────────────

  test('minRating excludes rows below threshold (combined with BPM filter)', async () => {
    // Public mode → no per-user rating rows exist. minRating=1 would
    // demand um.rating >= 1, but there's no um row at all → filter
    // matches zero rows → 400. This locks in the LEFT JOIN semantics:
    // "no row means no rating" not "no row means infinite rating".
    const r = await randomReq(server.baseUrl, {
      bpmRanges: [{ min: 120, max: 130 }],
      minRating: 1,
    });
    assert.equal(r.status, 400);
  });

  // ── V35 plan — genre filter (whitelist) ───────────────────────────
  //
  // Genre distribution from seedDB:
  //   Jazz       → t1, t2
  //   Funk       → t1, t3
  //   Hip Hop    → t3, t7
  //   Rock       → t4, t5
  //   Metal      → t5
  //   Electronic → t6
  //   (none)     → t8
  //
  // Every assertion below is over multiple sample picks so a hash
  // bias that happens to surface one row first doesn't pass a test
  // it shouldn't.

  test('empty genres array → no filter applied (whitelist mode)', async () => {
    // Empty list is a no-op regardless of `genreMode` — same shape as
    // ignoreList:[] / artists:[]. Pool stays at all 8 rows.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { genres: [], genreMode: 'whitelist' });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Across 30 picks the random index should hit several distinct
    // rows; assert at least 3 different titles surface as a smoke
    // test that the filter genuinely isn't constraining the pool.
    assert.ok(seen.size >= 3, `expected >=3 distinct picks, saw ${[...seen].join(',')}`);
  });

  test('single-genre whitelist → only matching tracks across samples', async () => {
    // Funk → {t1, t3} only.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Funk'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t1', 't3'].includes(title), `unexpected pick ${title} for Funk whitelist`);
    }
  });

  test('multi-genre whitelist → ANY-match (Funk OR Metal)', async () => {
    // Funk → {t1, t3}; Metal → {t5}. ANY-match → {t1, t3, t5}.
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Funk', 'Metal'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t1', 't3', 't5'].includes(title), `unexpected pick ${title}`);
    }
  });

  test('track with BOTH whitelist genres counted once (single-EXISTS not multi-JOIN)', async () => {
    // t1 is tagged Jazz + Funk. Filter ['Jazz', 'Funk'] must not
    // double-count t1 in the candidate set. We can't observe row
    // count directly from a random pick, but a hash bias toward t1
    // would surface as t1 hitting noticeably more than half the time
    // across many samples — let's at least verify t1 isn't the ONLY
    // pick (t2 and t3 are also eligible).
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Jazz', 'Funk'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Eligible set: t1 (Jazz+Funk), t2 (Jazz), t3 (Hip Hop+Funk).
    // We need to actually see >1 distinct title across 40 picks or
    // we'd suspect double-counting. (1/3)^40 ≈ 10^-19 — vanishingly
    // unlikely if not bugged.
    assert.ok(seen.size >= 2, `t1 may be double-counted; only saw ${[...seen].join(',')}`);
    for (const title of seen) {
      assert.ok(['t1', 't2', 't3'].includes(title), `unexpected pick ${title}`);
    }
  });

  test('untagged track blocked under whitelist (Electronic-only whitelist → only t6)', async () => {
    // Electronic → {t6}. t8 has no genre rows → blocked under
    // whitelist. Every sample must be t6.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Electronic'] });
      assert.equal(r.status, 200);
      assert.equal(pickedTitle(r), 't6');
    }
  });

  test('whitelist-only (no BPM/key/artists) hits simple-mode AND applies filter', async () => {
    // No BPM/key/artists/cooldown → simple-mode shortcut at random.js:357
    // fires. If `genres` were plumbed through runWaterfallQuery (instead
    // of the base-conditions layer), simple-mode would bypass the filter
    // entirely. This test guards against that regression.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Hip Hop'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Hip Hop → {t3, t7}. NOT the full 8-row pool.
    for (const title of seen) {
      assert.ok(['t3', 't7'].includes(title), `simple-mode bypassed genre filter; pick=${title}`);
    }
  });

  test('whitelist composes AND with BPM filter', async () => {
    // Funk → {t1, t3}; BPM [120,130] → {t1, t2, t3, t7}.
    // Intersection: {t1, t3}.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        genres: ['Funk'],
        bpmRanges: [{ min: 120, max: 130 }],
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t1', 't3'].includes(title), `unexpected pick ${title} for Funk+BPM`);
    }
  });

  test('case-insensitive matching: "FUNK" / "funk" both match the "Funk" rows', async () => {
    // Regression for an early-implementation bug: `g.name IN (?) COLLATE
    // NOCASE` (collate after the IN paren) is treated by SQLite's parser
    // as something other than per-element case-folding. The filter must
    // place COLLATE NOCASE on the LEFT (`g.name COLLATE NOCASE IN (?)`)
    // to actually match case-insensitively against the row's name.
    // Without the fix this test returns 400 instead of a Funk track.
    for (const variant of ['FUNK', 'funk', 'fUnK']) {
      const seen = new Set();
      for (let i = 0; i < 15; i++) {
        const r = await randomReq(server.baseUrl, { genres: [variant] });
        assert.equal(r.status, 200, `variant=${variant} failed`);
        seen.add(pickedTitle(r));
      }
      for (const title of seen) {
        assert.ok(['t1', 't3'].includes(title), `variant=${variant}: unexpected pick ${title}`);
      }
    }
  });

  test('omitted genreMode defaults to whitelist (Joi .default)', async () => {
    // `genreMode` absent → Joi populates 'whitelist' before runRandomSongs
    // reads body.genreMode. So `{ genres: ['Rock'] }` and
    // `{ genres: ['Rock'], genreMode: 'whitelist' }` must produce the
    // same candidate set.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Rock'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Rock → {t4, t5}.
    for (const title of seen) {
      assert.ok(['t4', 't5'].includes(title), `unexpected pick ${title}; mode default failed`);
    }
  });

  // ── V35 plan — genre filter (blacklist) ───────────────────────────

  test('single-genre blacklist excludes tagged tracks', async () => {
    // Blacklist ['Rock'] → exclude t4, t5. Untagged t8 → allowed.
    // Remaining: {t1, t2, t3, t6, t7, t8} = 6 tracks.
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const r = await randomReq(server.baseUrl, { genres: ['Rock'], genreMode: 'blacklist' });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(!['t4', 't5'].includes(title), `Rock track ${title} should be blacklisted`);
      assert.ok(['t1', 't2', 't3', 't6', 't7', 't8'].includes(title));
    }
  });

  test('multi-genre blacklist excludes ANY-match', async () => {
    // Blacklist ['Jazz', 'Rock'] → exclude {t1, t2, t4, t5}.
    // Remaining: {t3, t6, t7, t8}.
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const r = await randomReq(server.baseUrl, {
        genres: ['Jazz', 'Rock'],
        genreMode: 'blacklist',
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t3', 't6', 't7', 't8'].includes(title), `unexpected blacklist pick ${title}`);
    }
  });

  test('untagged track ALLOWED under blacklist (regression for the inversion)', async () => {
    // Blacklist EVERY tagged genre → only t8 (untagged) remains.
    // Whitelist with the same input would 400.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, {
        genres: ['Jazz', 'Funk', 'Hip Hop', 'Rock', 'Metal', 'Electronic'],
        genreMode: 'blacklist',
      });
      assert.equal(r.status, 200);
      assert.equal(pickedTitle(r), 't8');
    }
  });

  test('blacklist-only hits simple-mode AND applies filter', async () => {
    // Mirror of the whitelist simple-mode regression — different
    // operator, same architectural guarantee.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        genres: ['Jazz', 'Funk', 'Hip Hop'],
        genreMode: 'blacklist',
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Blacklist ANY of Jazz/Funk/Hip Hop → excludes {t1, t2, t3, t7}.
    // Allowed: {t4, t5, t6, t8}.
    for (const title of seen) {
      assert.ok(['t4', 't5', 't6', 't8'].includes(title), `simple-mode bypassed blacklist; pick=${title}`);
    }
  });

  test('blacklist composes AND with BPM filter', async () => {
    // BPM [120,130] → {t1, t2, t3, t7}.
    // Blacklist Funk → exclude t1, t3. Remaining: {t2, t7}.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, {
        genres: ['Funk'],
        genreMode: 'blacklist',
        bpmRanges: [{ min: 120, max: 130 }],
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t2', 't7'].includes(title), `unexpected blacklist+BPM pick ${title}`);
    }
  });

  // ── V35 plan — genre filter validation ────────────────────────────

  test('genres array exceeds max=200 → 403', async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => `Genre${i}`);
    const r = await randomReq(server.baseUrl, { genres: tooMany });
    assert.equal(r.status, 403);
  });

  test('genres array with empty-string item → 403 (Joi min(1))', async () => {
    const r = await randomReq(server.baseUrl, { genres: ['Jazz', ''] });
    assert.equal(r.status, 403);
  });

  test('genres array with non-string element → 403', async () => {
    const r = await randomReq(server.baseUrl, { genres: ['Jazz', 42] });
    assert.equal(r.status, 403);
  });

  test('invalid genreMode → 403', async () => {
    // Joi `.valid('whitelist', 'blacklist')` rejects anything else.
    for (const invalid of ['allow', 'deny', 'block', 42, null]) {
      const r = await randomReq(server.baseUrl, { genres: ['Jazz'], genreMode: invalid });
      assert.equal(r.status, 403, `expected 403 for genreMode=${JSON.stringify(invalid)}, got ${r.status}`);
    }
  });

  // ── V35 plan — wire shape: metadata.genres is now populated ───────

  test('metadata response includes a genres array', async () => {
    // Smoke check that renderMetadataObj's new `genres` field surfaces
    // on the wire. Pick t1 specifically (Jazz+Funk) via a whitelist of
    // its genres so we can assert the array contents deterministically.
    const r = await randomReq(server.baseUrl, { genres: ['Electronic'] });
    assert.equal(r.status, 200);
    // Filter narrows to t6 only.
    assert.equal(pickedTitle(r), 't6');
    const genres = r.body.songs[0].metadata.genres;
    assert.ok(Array.isArray(genres), 'metadata.genres should be an array');
    assert.deepEqual([...genres].sort(), ['Electronic']);
  });

  test('metadata.genres is [] for untagged track', async () => {
    // Force a pick of t8 via the "blacklist everything" trick.
    const r = await randomReq(server.baseUrl, {
      genres: ['Jazz', 'Funk', 'Hip Hop', 'Rock', 'Metal', 'Electronic'],
      genreMode: 'blacklist',
    });
    assert.equal(r.status, 200);
    assert.equal(pickedTitle(r), 't8');
    assert.deepEqual(r.body.songs[0].metadata.genres, []);
  });
});
