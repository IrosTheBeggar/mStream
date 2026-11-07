/**
 * The genre routes' `source` filter (V79 track_genres.source): /db/genres
 * lists one provenance's genres — 'tag' (the files' own) or 'model' (the
 * discovery model's, src/db/genre-sync.js) — and always says how many
 * genres each has; /db/genre-songs keeps only the songs linked that way.
 *
 * The fixture library carries tag genres (Electronic ×5, Ambient ×3, one
 * untagged song). Model links are written straight into the DB after the
 * scan, the way the genre sync would:
 *   - 'Sketch 1' (untagged) → Ambient + Synthwave (a model-only genre)
 *   - 'Highway' (tagged Ambient) → Synthwave
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

let server;

async function post(route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

const counts = (genres) => Object.fromEntries(genres.map((g) => [g.name, g.track_count]));
const titles = (songs) => songs.map((s) => s.metadata.title).sort();

before(async () => {
  server = await startServer();
  const db = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
  try {
    const trackId = (title) => db.prepare('SELECT id FROM tracks WHERE title = ?').get(title).id;
    const ambient = db.prepare("SELECT id FROM genres WHERE name = 'Ambient'").get().id;
    const synthwave = Number(db.prepare("INSERT INTO genres (name, parent) VALUES ('Synthwave', 'Electronic')").run().lastInsertRowid);
    const link = db.prepare("INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'model')");
    link.run(trackId('Sketch 1'), ambient);
    link.run(trackId('Sketch 1'), synthwave);
    link.run(trackId('Highway'), synthwave);
  } finally {
    db.close();
  }
});

after(async () => {
  await server?.stop();
});

describe('/db/genres source filter', () => {
  test('no source: every link counts, and the answer says what each source has', async () => {
    const r = await post('/api/v1/db/genres', {});
    assert.equal(r.status, 200);
    assert.deepEqual(counts(r.body.genres), { Ambient: 4, Electronic: 5, Synthwave: 2 });
    assert.deepEqual(r.body.sources, { tag: 2, model: 2 });
  });

  test("'tag' lists the files' own genres with their tag counts", async () => {
    const r = await post('/api/v1/db/genres', { source: 'tag' });
    assert.deepEqual(counts(r.body.genres), { Ambient: 3, Electronic: 5 });
    assert.deepEqual(r.body.sources, { tag: 2, model: 2 }, 'the totals do not depend on the filter');
  });

  test("'model' lists the generated genres, in name order", async () => {
    const r = await post('/api/v1/db/genres', { source: 'model' });
    assert.deepEqual(r.body.genres, [
      { name: 'Ambient', track_count: 1 },
      { name: 'Synthwave', track_count: 2 },
    ]);
  });

  test('GET takes it from the query string', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/genres?source=model`);
    assert.equal(r.status, 200);
    assert.deepEqual(counts((await r.json()).genres), { Ambient: 1, Synthwave: 2 });
  });

  test('an unknown source is a bad request', async () => {
    const r = await post('/api/v1/db/genres', { source: 'guess' });
    assert.equal(r.status, 400);
  });

  test('fields it does not know are still ignored', async () => {
    const r = await post('/api/v1/db/genres', { somethingElse: true });
    assert.equal(r.status, 200);
  });
});

describe('/db/genre-songs source filter', () => {
  test('a genre with both kinds of link splits by source', async () => {
    const all = await post('/api/v1/db/genre-songs', { genre: 'Ambient' });
    const tag = await post('/api/v1/db/genre-songs', { genre: 'Ambient', source: 'tag' });
    const model = await post('/api/v1/db/genre-songs', { genre: 'Ambient', source: 'model' });
    assert.deepEqual(titles(all.body), ['Highway', 'Neon', 'Sketch 1', 'Static']);
    assert.deepEqual(titles(tag.body), ['Highway', 'Neon', 'Static']);
    assert.deepEqual(titles(model.body), ['Sketch 1']);
  });

  test('a model-only genre has no tag songs', async () => {
    const r = await post('/api/v1/db/genre-songs', { genre: 'synthwave', source: 'tag' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('paging still applies under a source', async () => {
    const r = await post('/api/v1/db/genre-songs', { genre: 'Ambient', source: 'tag', limit: 2, offset: 0 });
    assert.equal(r.body.length, 2);
  });

  test('an unknown source is a bad request', async () => {
    const r = await post('/api/v1/db/genre-songs', { genre: 'Ambient', source: 'guess' });
    assert.equal(r.status, 400);
  });
});
