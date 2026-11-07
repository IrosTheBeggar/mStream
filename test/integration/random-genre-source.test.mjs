/**
 * random-songs' `genreSource` (V79 track_genres.source): the Auto DJ genre
 * filter matches only the files' own genres ('tag'), only the discovery
 * model's ('model'), or both (omitted) — the choice /db/genres and
 * /db/genre-songs already take.
 *
 * The fixture library carries tag genres (Electronic ×5, Ambient ×3, one
 * untagged song). Model links are written straight into the DB after the
 * scan, the way the genre sync would, crossing the tag lines:
 *   - 'Sketch 1' (untagged)          → Ambient
 *   - 'Rise'     (tagged Electronic) → Ambient
 *   - 'Highway'  (tagged Ambient)    → Synthwave (a model-only genre)
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

let server;

async function pick(body) {
  const r = await fetch(`${server.baseUrl}/api/v1/db/random-songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// Every title picked over n tries: a pool's members, never anything outside it.
async function picked(body, n = 30) {
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const r = await pick(body);
    assert.equal(r.status, 200, `pick ${i}: ${JSON.stringify(r.body)}`);
    seen.add(r.body.songs[0].metadata.title);
  }
  return seen;
}

function within(seen, pool) {
  for (const title of seen) assert.ok(pool.includes(title), `${title} is outside ${pool.join(', ')}`);
}

before(async () => {
  server = await startServer();
  const db = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
  try {
    const trackId = (title) => db.prepare('SELECT id FROM tracks WHERE title = ?').get(title).id;
    const ambient = db.prepare("SELECT id FROM genres WHERE name = 'Ambient'").get().id;
    const synthwave = Number(db.prepare("INSERT INTO genres (name, parent) VALUES ('Synthwave', 'Electronic')").run().lastInsertRowid);
    const link = db.prepare("INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'model')");
    link.run(trackId('Sketch 1'), ambient);
    link.run(trackId('Rise'), ambient);
    link.run(trackId('Highway'), synthwave);
  } finally {
    db.close();
  }
});

after(async () => {
  await server?.stop();
});

describe('random-songs genreSource, whitelist', () => {
  test('no source: a genre matches through either kind of link', async () => {
    within(await picked({ genres: ['Ambient'] }), ['Highway', 'Neon', 'Static', 'Sketch 1', 'Rise']);
  });

  test("'tag' plays only the songs whose files say so", async () => {
    within(await picked({ genres: ['Ambient'], genreSource: 'tag' }), ['Highway', 'Neon', 'Static']);
  });

  test("'model' plays only the songs the model put there", async () => {
    within(await picked({ genres: ['Ambient'], genreSource: 'model' }), ['Sketch 1', 'Rise']);
  });

  test('a model-only genre: the one song under model, nothing under tag', async () => {
    assert.deepEqual(await picked({ genres: ['Synthwave'], genreSource: 'model' }, 5), new Set(['Highway']));
    const r = await pick({ genres: ['Synthwave'], genreSource: 'tag' });
    assert.equal(r.status, 400);
  });

  test('names still match whatever their case', async () => {
    within(await picked({ genres: ['aMBIENT'], genreSource: 'model' }), ['Sketch 1', 'Rise']);
  });
});

describe('random-songs genreSource, blacklist', () => {
  test('it narrows what is skipped: skipping every tag genre leaves the untagged song', async () => {
    // Without a source, Sketch 1's model Ambient link skips it too, and
    // nothing is left.
    const all = await pick({ genres: ['Electronic', 'Ambient'], genreMode: 'blacklist' });
    assert.equal(all.status, 400);
    assert.deepEqual(
      await picked({ genres: ['Electronic', 'Ambient'], genreMode: 'blacklist', genreSource: 'tag' }, 5),
      new Set(['Sketch 1']),
    );
  });

  test("skipping the model's Ambient keeps the songs tagged Ambient", async () => {
    within(
      await picked({ genres: ['Ambient', 'Synthwave'], genreMode: 'blacklist', genreSource: 'model' }),
      ['Be Somebody', 'Orbit', 'Return', 'Descent', 'Neon', 'Static'],
    );
  });
});

describe('random-songs genreSource, validation', () => {
  test('an unknown source is a bad request', async () => {
    const r = await pick({ genres: ['Ambient'], genreSource: 'guess' });
    assert.equal(r.status, 400);
  });

  test('a source with no genres filters nothing', async () => {
    const seen = await picked({ genreSource: 'model' });
    assert.ok(seen.size >= 3, `expected the whole library, saw ${[...seen].join(', ')}`);
  });
});
