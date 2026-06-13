/**
 * Tests for PR D — `artists` and `ignoreArtists` body params on
 * POST /api/v1/db/random-songs.
 *
 * The waterfall has two halves: a similar-artists-prioritised chain
 * that fires when `artists` is set, and the non-similar chain from
 * PR B. We cover:
 *
 *   • SQL helper buildArtistFilter — clause shape, V18-widening
 *     parameter binding, NOT-IN cooldown semantics.
 *   • Integration: server picks only similar artists when scope is
 *     available; falls through to non-similar when not; respects
 *     cooldown; recovers from over-eager cooldown via the drop-
 *     cooldown step; widens through album_artists / track_artists
 *     so featured / collaborator picks land.
 *
 * Seed library has primary-artist tracks, plus one track that's
 * primary=other-artist but features the "scope" artist via
 * track_artists, plus one album credited to the scope artist via
 * album_artists. The widening tests exercise both M2M tables.
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

import { buildArtistFilter } from '../src/api/random.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// Unit tests — buildArtistFilter SQL shape.
// ─────────────────────────────────────────────────────────────────────

describe('buildArtistFilter', () => {
  test('empty opts → no clauses, no params', () => {
    assert.deepEqual(buildArtistFilter({}), { clauses: [], params: [] });
  });

  test('empty arrays → no clauses', () => {
    assert.deepEqual(buildArtistFilter({ artists: [], ignoreArtists: [] }), { clauses: [], params: [] });
  });

  test('artists clause references three M2M tables (V18 widening)', () => {
    const { clauses, params } = buildArtistFilter({ artists: ['Foo'] });
    assert.equal(clauses.length, 1);
    // All three widening paths must appear:
    //   • t.artist_id IN (...)  — primary track artist
    //   • track_artists          — featured / collaborator
    //   • album_artists          — album-credited
    assert.match(clauses[0], /t\.artist_id IN \(/);
    assert.match(clauses[0], /track_artists/);
    assert.match(clauses[0], /album_artists/);
    // The names are bound three times — once per widening path. With
    // a single input we expect three params (the same name repeated).
    assert.equal(params.length, 3);
    assert.ok(params.every(p => p === 'Foo'));
  });

  test('multiple artists bind correctly across all three placeholders sets', () => {
    const { params } = buildArtistFilter({ artists: ['Foo', 'Bar'] });
    // 2 names × 3 widening paths = 6 params, in (Foo, Bar, Foo, Bar, Foo, Bar) order.
    assert.equal(params.length, 6);
    assert.deepEqual(params, ['Foo', 'Bar', 'Foo', 'Bar', 'Foo', 'Bar']);
  });

  test('ignoreArtists builds a symmetric NOT-IN clause', () => {
    const { clauses, params } = buildArtistFilter({ ignoreArtists: ['Foo'] });
    assert.equal(clauses.length, 1);
    assert.match(clauses[0], /NOT IN/);
    // Same three-way widening on the cooldown side so a Bar cooldown
    // also drops "Foo feat. Bar". Three placeholders for one name.
    assert.equal(params.length, 3);
  });

  test('artists + ignoreArtists produces two independent clauses', () => {
    const { clauses, params } = buildArtistFilter({
      artists: ['Foo'],
      ignoreArtists: ['Bar'],
    });
    assert.equal(clauses.length, 2);
    // Three params per clause, in order.
    assert.deepEqual(params.slice(0, 3), ['Foo', 'Foo', 'Foo']);
    assert.deepEqual(params.slice(3, 6), ['Bar', 'Bar', 'Bar']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Integration tests — booted server.
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
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
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

// Seed library:
//
//   Albums:
//     albFooSolo   credited to Foo  → contains t1 (artist=Foo)
//     albCollab    credited to Foo (album_artists row) → contains t2 (artist=Baz),
//                                                          via album_artists widening
//     albBaz       credited to Baz  → contains t3 (artist=Baz)
//     albCool      credited to Cool → contains t4 (artist=Cool feat. Foo via track_artists)
//     albIgnore    credited to Ignored → contains t5 (artist=Ignored)
//
//   t1  primary=Foo,    album=albFooSolo
//   t2  primary=Baz,    album=albCollab    + album_artists row (Foo)  ← widens to Foo
//   t3  primary=Baz,    album=albBaz
//   t4  primary=Cool,   album=albCool      + track_artists row (Foo) ← widens to Foo
//   t5  primary=Ignored, album=albIgnore
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const lib1 = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;

  const aFoo     = Number(db.prepare("INSERT INTO artists (name) VALUES ('Foo')").run().lastInsertRowid);
  const aBaz     = Number(db.prepare("INSERT INTO artists (name) VALUES ('Baz')").run().lastInsertRowid);
  const aCool    = Number(db.prepare("INSERT INTO artists (name) VALUES ('Cool')").run().lastInsertRowid);
  const aIgnore  = Number(db.prepare("INSERT INTO artists (name) VALUES ('Ignored')").run().lastInsertRowid);

  const albFooSolo = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('FooSolo', ?, 2020)").run(aFoo).lastInsertRowid);
  const albCollab  = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Collab',  ?, 2020)").run(aFoo).lastInsertRowid);
  const albBaz     = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('BazSolo', ?, 2020)").run(aBaz).lastInsertRowid);
  const albCool    = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('CoolSolo',?, 2020)").run(aCool).lastInsertRowid);
  const albIgnore  = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('IgnoreSolo',?,2020)").run(aIgnore).lastInsertRowid);

  // V18 — album_artists: Foo is credited on albCollab (widening test row).
  db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 0)").run(albCollab, aFoo);
  // V18 — also seed an album_artists row for each primary-artist album
  // so the COALESCE/EXISTS join semantics in the cooldown clause have
  // something to evaluate against (matches scanner.mjs's behaviour of
  // always populating album_artists).
  db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 0)").run(albFooSolo, aFoo);
  db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 0)").run(albBaz, aBaz);
  db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 0)").run(albCool, aCool);
  db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 0)").run(albIgnore, aIgnore);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, 2020, 'flac', ?, ?, ?, 'seed')
  `);
  let ts = 1700000000000;
  const t1 = Number(insT.run('foo/t1.flac',     lib1, 't1', aFoo,    albFooSolo, 'h1', 'a1', ts++).lastInsertRowid);
  const t2 = Number(insT.run('collab/t2.flac',  lib1, 't2', aBaz,    albCollab,  'h2', 'a2', ts++).lastInsertRowid);
  const t3 = Number(insT.run('baz/t3.flac',     lib1, 't3', aBaz,    albBaz,     'h3', 'a3', ts++).lastInsertRowid);
  const t4 = Number(insT.run('cool/t4.flac',    lib1, 't4', aCool,   albCool,    'h4', 'a4', ts++).lastInsertRowid);
  const t5 = Number(insT.run('ignore/t5.flac',  lib1, 't5', aIgnore, albIgnore,  'h5', 'a5', ts).lastInsertRowid);

  // V17 — track_artists: every track has a primary `main` row. t4 also
  // gets a `featured` row for Foo so the V18 widening lights up.
  const tA = db.prepare("INSERT INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)");
  tA.run(t1, aFoo,    'main',     0);
  tA.run(t2, aBaz,    'main',     0);
  tA.run(t3, aBaz,    'main',     0);
  tA.run(t4, aCool,   'main',     0);
  tA.run(t4, aFoo,    'featured', 1);  // widening row
  tA.run(t5, aIgnore, 'main',     0);

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

function pickedTitle(resp) {
  return resp.body?.songs?.[0]?.metadata?.title || null;
}

describe('POST /api/v1/db/random-songs — similar-artists waterfall (PR D)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-djsim-'));
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

  // ── Similar-artists widening (V18 paths) ──────────────────────────

  test('artists=[Foo] picks t1, t2, or t4 (primary + album_artists + track_artists widening)', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { artists: ['Foo'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // Eligible:
    //   t1 — primary=Foo
    //   t2 — album_artists has Foo (via albCollab)
    //   t4 — track_artists has Foo as 'featured'
    // Not eligible: t3 (Baz, no Foo credit), t5 (Ignored).
    for (const title of seen) {
      assert.ok(['t1', 't2', 't4'].includes(title), `unexpected pick ${title} — widening regression`);
    }
    // We should see at least t1 — 33% chance per pick × 30 picks → effectively certain.
    assert.ok(seen.has('t1'), `t1 (primary widening) never picked`);
  });

  test('artists=[Foo, Baz] picks any Foo-or-Baz-credited track', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { artists: ['Foo', 'Baz'] });
      seen.add(pickedTitle(r));
    }
    // Foo widens to t1+t2+t4. Baz primary on t2+t3. Union: t1,t2,t3,t4.
    for (const title of seen) {
      assert.ok(['t1', 't2', 't3', 't4'].includes(title), `unexpected pick ${title}`);
    }
  });

  test('artists=[Unknown] (no library matches) → falls through to unrestricted', async () => {
    // No library track has primary/credit/featured matching "Unknown".
    // Steps 1-5 are all empty → 5b skipped (no ignoreArtists) → 6-9
    // gates check BPM/key, both absent so all skipped → step 10
    // (unrestricted) returns SOMETHING from the 5-track scope.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, { artists: ['Unknown Band'] });
      assert.equal(r.status, 200);
      // Could be any of the 5 tracks.
      const pick = pickedTitle(r);
      assert.ok(['t1','t2','t3','t4','t5'].includes(pick), `unexpected pick ${pick}`);
    }
  });

  // ── ignoreArtists cooldown (symmetric widening) ───────────────────

  test('ignoreArtists=[Foo] excludes t1 (primary) AND t2 (album cred) AND t4 (track cred)', async () => {
    // Without Foo, the eligible pool is t3 (Baz) and t5 (Ignored).
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { ignoreArtists: ['Foo'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t3', 't5'].includes(title), `cooldown leak: ${title} should have been excluded`);
    }
  });

  test('artists=[Foo] + ignoreArtists=[Cool] excludes t4 from Foo-similar pool', async () => {
    // Foo-similar pool is {t1,t2,t4}. Cool cooldown drops t4 (primary=Cool).
    // Expected: only t1 or t2.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, { artists: ['Foo'], ignoreArtists: ['Cool'] });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    for (const title of seen) {
      assert.ok(['t1', 't2'].includes(title), `unexpected pick ${title}`);
    }
  });

  // ── 5b: drop-cooldown fallback ────────────────────────────────────

  test('ignoreArtists nukes entire similar pool → drops cooldown and recovers', async () => {
    // Foo-similar pool = {t1, t2, t4}.
    // Cooldown = [Foo, Baz, Cool] → t1 (Foo primary), t2 (Baz primary
    // AND album-credits Foo), t4 (Cool primary AND track-credits Foo)
    // are all excluded by the cooldown clause. So step 5 (similar-only,
    // keep cooldown) → empty.
    // Step 5b drops the cooldown → similar widens back to t1+t2+t4.
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await randomReq(server.baseUrl, {
        artists: ['Foo'],
        ignoreArtists: ['Foo', 'Baz', 'Cool'],
      });
      assert.equal(r.status, 200);
      seen.add(pickedTitle(r));
    }
    // 5b recovers the similar-pool, so picks are Foo-similar again.
    for (const title of seen) {
      assert.ok(['t1', 't2', 't4'].includes(title), `5b didn't recover similar pool: ${title}`);
    }
  });

  // ── Falls through to non-similar chain ────────────────────────────

  test('similar artists not in library + BPM/key absent → step 10 random', async () => {
    // Repeated to make sure the chain consistently produces a pick
    // when only the unrestricted step fires.
    for (let i = 0; i < 5; i++) {
      const r = await randomReq(server.baseUrl, { artists: ['Imaginary Band'] });
      assert.equal(r.status, 200);
      assert.ok(pickedTitle(r));
    }
  });

  // ── Joi validation ────────────────────────────────────────────────

  test('artists must be array of strings — number entry → 403', async () => {
    const r = await randomReq(server.baseUrl, { artists: [42] });
    assert.equal(r.status, 403);
  });

  test('ignoreArtists must be array of strings — object entry → 403', async () => {
    const r = await randomReq(server.baseUrl, { ignoreArtists: [{ name: 'Foo' }] });
    assert.equal(r.status, 403);
  });

  test('empty artists array is treated as "no filter" — picks from all 5 rows', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await randomReq(server.baseUrl, { artists: [] });
      seen.add(pickedTitle(r));
    }
    // Empty array → hasArtists=false → simple-mode picks across all 5.
    // We should see multiple distinct titles, not just one.
    assert.ok(seen.size >= 2, `empty artists treated as filter? seen=${[...seen].join(',')}`);
  });
});
