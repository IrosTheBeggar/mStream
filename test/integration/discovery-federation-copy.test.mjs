/**
 * "Add to your collection" end to end over real iroh: the federation-copy
 * plug-in (src/discovery-plugins/plugins/federation-copy.js), the caller's
 * collection destination (src/discovery-plugins/destination.js) through its
 * own routes, and the job that copies a paired peer's file into this library.
 *
 *   Server A (the peer): federation ON, one 'shared' library of three
 *                        ffmpeg-made, tagged mp3s.
 *   Server B (the copier): federation ON, the default fixture library
 *                          'testlib' plus an empty, per-run 'collection'
 *                          library that every copy is pointed at — the
 *                          fixture library is the repo's shared folder and
 *                          must never receive a file. Pairs with A as
 *                          'copier'. Public mode, so the settings belong to
 *                          the shared anonymous account and admin routes
 *                          need no token.
 *
 * Proves: the default destination and its rules, the destination round
 * trip and its refusals, a copy landing at base + rendered layout + the
 * peer's file name with a playable row (source = federation-copy), the
 * owned skip, the never-overwrite skip, the p2p refusal, the uploads-off
 * refusal, a queued copy landing where the destination was when it was
 * asked for, and {{ALBUMARTIST}} for a file with no albumartist tag: the
 * album's credit the copy knows (a featured song, an untagged compilation,
 * an artist's album, else the artist it was asked by), never over a tag the
 * file has. Skips when @number0/iroh has no prebuilt binary here.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { appendId3TextFrames } from '../helpers/id3.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const PLUGIN = 'federation-copy';
const DEST = '/api/v1/discovery/collection/destination';
const JOBS = `/api/v1/discovery/plugins/${PLUGIN}/jobs`;

// [file, title, artist, album, year, albumArtist?, compilation?]
const REMOTE = [
  ['Remote_Hit.mp3', 'Remote Hit', 'Nova', 'Night Ferry', '2019'],
  ['Second_Song.mp3', 'Second Song', 'Nova', 'Night Ferry', '2019'],
  ['Third_Song.mp3', 'Third Song', 'Vosto', 'Solo', ''],
  // The artist scopes: a second Nova album, and a compilation Nova merely appears on.
  ['Fourth_Song.mp3', 'Fourth Song', 'Nova', 'Second Wind', '2021'],
  ['Comp_Track.mp3', 'Comp Track', 'Nova', 'Various Hits', '2020', 'Various Artists'],
  // The folder scope: a small tree with a recycle bin and a dot folder in
  // it, and two more folders for the landing choices. Their own artist, so
  // the artist cases above keep their counts.
  ['Tree/T1.mp3', 'Tree One', 'Treeband', 'Live Tapes', '2015'],
  ['Tree/Disc 1/T2.mp3', 'Tree Two', 'Treeband', 'Live Tapes', '2015'],
  ['Tree/#recycle/Old.mp3', 'Old Take', 'Treeband', 'Live Tapes', '2015'],
  ['Tree/.hidden/Hid.mp3', 'Hidden Take', 'Treeband', 'Live Tapes', '2015'],
  ['Tree2/U1.mp3', 'Tree2 One', 'Treeband', 'Live Tapes', '2015'],
  ['Tree3/V1.mp3', 'Tree3 One', 'Treeband', 'Live Tapes', '2015'],
  // The pinned destination: a song of its own artist, copied once.
  ['Pinned_Song.mp3', 'Pinned Song', 'Pinza', 'Holding Pattern', '2022'],
  // The album's credit for a file with no albumartist tag: an album with
  // two featured songs, a compilation flagged as one but with no
  // albumartist, a file that names its own, and an artist's album with a
  // featured song. Their own artists, so the cases above keep their counts.
  ['Borrowed_1.mp3', 'Open Reel', 'Boukmanflow', 'Borrowed Tapes', '2018'],
  ['Borrowed_2.mp3', 'Second Reel', 'Boukmanflow feat. Ola', 'Borrowed Tapes', '2018'],
  ['Borrowed_3.mp3', 'Last Reel', 'Boukmanflow feat. Mika', 'Borrowed Tapes', '2018'],
  ['Swap_1.mp3', 'Swap One', 'Ana Vey', 'Tape Swap', '2017', null, true],
  ['Swap_2.mp3', 'Swap Two', 'Ben Lusk', 'Tape Swap', '2017', null, true],
  ['Own_Words.mp3', 'Own Words', 'Rhea Lind', 'Own Words', '2016', 'The Tide Collective'],
  ['Bus_1.mp3', 'First Stop', 'Mika Strand', 'Night Bus', '2014'],
  ['Bus_2.mp3', 'Last Stop', 'Mika Strand feat. Ola', 'Night Bus', '2014'],
  // An album asked for from a row with no credit (a peer on an older
  // server), and an album two artists share untagged, which the peer
  // credits to neither (album_artist null).
  ['Older_1.mp3', 'Old One', 'Kaya Moss', 'Old Peer', '2013'],
  ['Older_2.mp3', 'Old Two', 'Kaya Moss feat. Ola', 'Old Peer', '2013'],
  ['Split_1.mp3', 'Split One', 'Lio Brandt', 'Split Reel', '2012'],
  ['Split_2.mp3', 'Split Two', 'Lio Brandt feat. Ola', 'Split Reel', '2012'],
  ['Split_3.mp3', 'Split Three', 'Sefa Rowe', 'Split Reel', '2012'],
];

let srvA, srvB, sharedDir, collectionDir, peerId;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

async function api(srv, method, route, body) {
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// What a job pins (params.destination) when the 'collection' library's
// destination is in force with this base and layout.
const pinnedTo = (base, layout = '{{ARTIST}}/{{ALBUM}}') => ({ vpath: 'collection', base, layout, source: 'user' });

const rec = (file, over = {}) => {
  const row = REMOTE.find((r) => r[0] === file);
  return { source: 'federation', filepath: `shared/${file}`, peer: { id: peerId, name: 'copier' }, title: row[1], artist: row[2], album: row[3], ...over };
};

async function untilFinished(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(srvB, 'GET', `/api/v1/discovery/plugin-jobs/${id}`);
    const job = body && body.job;
    if (job && ['done', 'failed', 'cancelled'].includes(job.state)) { return job; }
    if (Date.now() > deadline) { throw new Error(`job ${id} never finished (last: ${job && job.state} · ${job && job.statusText})`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function bRow(sql, ...args) {
  const mdb = new DatabaseSync(path.join(srvB.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try { return mdb.prepare(sql).get(...args); } finally { mdb.close(); }
}

describe('discovery federation-copy (B copies from A over iroh)', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedcopy-'));
    let freq = 400;
    for (const [file, title, artist, album, year, albumArtist, compilation] of REMOTE) {
      fs.mkdirSync(path.dirname(path.join(sharedDir, file)), { recursive: true });
      const meta = ['-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${album}`];
      if (year) { meta.push('-metadata', `date=${year}`); }
      if (albumArtist) { meta.push('-metadata', `album_artist=${albumArtist}`); }
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `sine=frequency=${freq += 55}:duration=2`,
        ...meta, '-ac', '1', path.join(sharedDir, file),
      ]);
      // ffmpeg writes "compilation" into a TXXX frame no scanner reads: the
      // real TCMP frame goes in after.
      if (compilation) { await appendId3TextFrames(path.join(sharedDir, file), { TCMP: '1' }); }
    }

    collectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedcopy-dest-'));
    [srvA, srvB] = await Promise.all([
      startServer({ dlnaMode: 'disabled', extraFolders: { shared: sharedDir }, extraConfig: { federation: { enabled: true } } }),
      // The test-only noop-acquire plug-in fills the runner, so a copy can be
      // held queued (the pinned destination case).
      startServer({
        dlnaMode: 'disabled', extraFolders: { collection: collectionDir },
        env: { MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN: '1' },
        extraConfig: { federation: { enabled: true }, discoveryPlugins: { 'noop-acquire': { enabled: true } } },
      }),
    ]);

    const mint = await api(srvA, 'POST', '/api/v1/admin/federation/keys', { name: 'copier', vpaths: ['shared'] });
    assert.equal(mint.status, 200);
    assert.ok(mint.body.ticket, 'A must issue a ticket (endpoint up)');
    const added = await api(srvB, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket, name: 'copier' });
    assert.equal(added.status, 200);
    peerId = added.body.id;

    // Readiness: the iroh endpoint boots asynchronously; wait until A
    // answers a proxied metadata read (the copy's own first call) so the
    // tests below probe a reachable peer, not the dial.
    const ready = Date.now() + 60_000;
    for (;;) {
      const r = await api(srvB, 'POST', `/api/v1/federation/peers/${peerId}/api/api/v1/db/metadata`, { filepath: 'shared/Remote_Hit.mp3' });
      if (r.status === 200 && r.body && r.body.metadata && r.body.metadata.hash) { break; }
      if (Date.now() > ready) { throw new Error(`peer never became reachable (last ${r.status})`); }
      await new Promise((res) => setTimeout(res, 500));
    }
  });

  after(async () => {
    await Promise.all([srvA && srvA.stop(), srvB && srvB.stop()]);
    for (const dir of [sharedDir, collectionDir]) {
      if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('the plug-in is listed as an acquire plug-in; the destination is not its setting', async () => {
    const r = await api(srvB, 'GET', '/api/v1/discovery/plugins');
    assert.equal(r.status, 200);
    const p = r.body.plugins.find((x) => x.name === PLUGIN);
    assert.ok(p, 'federation-copy is on by default');
    assert.deepEqual(p.capabilities, ['acquire']);
    assert.deepEqual(p.scopes, ['song', 'album', 'artist', 'artist-missing', 'folder']);
    assert.deepEqual(p.settings, []);
    assert.equal((await api(srvB, 'GET', `/api/v1/discovery/plugins/${PLUGIN}/settings`)).status, 400, 'no plug-in settings of its own');
  });

  test('the default destination: the first library, {{ALBUMARTIST}}/{{ALBUM}} at its root', async () => {
    const r = await api(srvB, 'GET', DEST);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, null);
    assert.deepEqual([...r.body.libraries].sort((a, b) => a.vpath.localeCompare(b.vpath)),
      [{ vpath: 'collection', template: null }, { vpath: 'testlib', template: null }]);
    assert.deepEqual(r.body.destination, { vpath: r.body.libraries[0].vpath, base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'default' });
    assert.equal(r.body.defaultLayout, '{{ALBUMARTIST}}/{{ALBUM}}');
    assert.ok(r.body.variables.includes('PEER'));
  });

  test('storing a destination: refusals, the round trip, and the reset', async () => {
    const put = (value) => api(srvB, 'PUT', DEST, { destination: value });
    assert.equal((await put({ vpath: 'nope', base: '', layout: '{{ARTIST}}' })).status, 400, 'a library the caller cannot write to');
    assert.equal((await put({ vpath: 'collection', base: '', layout: '{{TRACK}}' })).status, 400, 'an unknown variable');
    assert.equal((await put({ vpath: 'collection', base: '../up', layout: '{{ARTIST}}' })).status, 400, 'a base folder that climbs out');
    assert.equal((await put({ vpath: 'collection' })).status, 400, 'the schema: layout is required');
    assert.equal((await api(srvB, 'PUT', DEST, {})).status, 400, 'a destination (or null) is required');

    const ok = await put({ vpath: 'collection', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.destination, { vpath: 'collection', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}', source: 'user' });
    assert.deepEqual(ok.body.saved, { vpath: 'collection', base: 'From peers/', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' });
    const again = await api(srvB, 'GET', DEST);
    assert.equal(again.body.destination.source, 'user');

    const reset = await put(null);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.destination.source, 'default');
    assert.equal(reset.body.saved, null);

    // The custom destination for the copies below — always the per-run
    // 'collection' library, never the shared fixture folder.
    assert.equal((await put({ vpath: 'collection', base: 'From peers', layout: '{{PEER}}/{{ARTIST}}/{{ALBUM}}' })).status, 200);
  });

  test('a copy lands at base + layout + the peer\'s file name, with a playable row', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3') });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.skipped, undefined, JSON.stringify(result));
    assert.equal(result.copied.filepath, 'collection/From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    assert.equal(result.copied.vpath, 'collection');
    assert.ok(result.copied.trackId > 0);
    assert.ok(result.copied.bytes > 1000);
    assert.equal(result.copied.title, 'Remote Hit');
    assert.equal(result.copied.artist, 'Nova');
    assert.equal(result.copied.album, 'Night Ferry');
    assert.deepEqual(result.missingVars, []);
    assert.deepEqual(result.peer, { id: peerId, name: 'copier' });
    assert.equal(result.destination.source, 'user');

    const onDisk = path.join(collectionDir, 'From peers', 'copier', 'Nova', 'Night Ferry', 'Remote_Hit.mp3');
    assert.ok(fs.existsSync(onDisk), `file must exist at ${onDisk}`);
    assert.equal(fs.statSync(onDisk).size, fs.statSync(path.join(sharedDir, 'Remote_Hit.mp3')).size, 'byte for byte');
    assert.ok(!fs.readdirSync(path.join(collectionDir, 'From peers')).some((f) => f.endsWith('.part')), 'no .part left behind');

    const row = bRow('SELECT source, title, file_hash, hash_v, duration FROM tracks WHERE filepath = ?', 'From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    assert.ok(row, 'a tracks row exists at the forward-slash path');
    assert.equal(row.source, PLUGIN);
    assert.equal(row.title, 'Remote Hit');
    assert.ok(row.file_hash);
    assert.ok(row.duration > 0, `a copied song has its length at once, not after a rescan (duration ${row.duration})`);

    const meta = await api(srvB, 'POST', '/api/v1/db/metadata', { filepath: result.copied.filepath });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.metadata.title, 'Remote Hit');
    assert.equal(meta.body.metadata.album, 'Night Ferry');
  });

  test('the same song again is skipped as owned — by hash, before any byte moves', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3') });
    assert.equal(started.status, 202, 'the earlier job is finished, so this is a new one');
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.skipped, 'owned');
    assert.equal(job.result.existing.by, 'hash');
    assert.equal(job.result.existing.filepath, 'collection/From peers/copier/Nova/Night Ferry/Remote_Hit.mp3');
    // Owned by tags too: a different peer path, the same artist + album + title.
    const byTags = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3', { filepath: 'shared/does-not-matter.mp3' }) });
    const job2 = await untilFinished(byTags.body.job.id);
    assert.equal(job2.state, 'done', `job error: ${job2.error}`);
    assert.equal(job2.result.skipped, 'owned');
    assert.equal(job2.result.existing.by, 'tags');
  });

  test('a file already at the target path is never overwritten', async () => {
    const target = path.join(collectionDir, 'From peers', 'copier', 'Nova', 'Night Ferry', 'Second_Song.mp3');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not audio');
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Second_Song.mp3') });
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.skipped, 'exists', JSON.stringify(job.result));
    assert.equal(job.result.filepath, 'collection/From peers/copier/Nova/Night Ferry/Second_Song.mp3');
    assert.equal(fs.readFileSync(target, 'utf8'), 'not audio', 'untouched');
    assert.equal(bRow('SELECT id FROM tracks WHERE filepath = ?', 'From peers/copier/Nova/Night Ferry/Second_Song.mp3'), undefined, 'no row for the placeholder');
  });

  test('an album copy takes every song the library lacks, skips the ones it has, and files them under the destination', async () => {
    assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: 'Albums', layout: '{{ARTIST}}/{{ALBUM}}' } })).status, 200);
    // Asked for through one of its songs; the job is the album's.
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Second_Song.mp3'), scope: 'album' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.deepEqual(started.body.job.params, { scope: 'album', destination: pinnedTo('Albums') });
    assert.match(started.body.job.key, /^album:/);
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.scope, 'album');
    assert.deepEqual(result.album, { name: 'Night Ferry', artist: 'Nova', albumArtist: null, year: null }, 'no album credit sent: narrowed by the track artist');
    assert.equal(result.songs.total, 2);
    assert.equal(result.stopped, null);
    assert.deepEqual(result.songs.failed, []);
    // Remote Hit is in the library from the earlier copy: skipped by hash. Second Song lands.
    assert.deepEqual(result.songs.skipped, [{ from: 'shared/Remote_Hit.mp3', why: 'owned', at: 'collection/From peers/copier/Nova/Night Ferry/Remote_Hit.mp3' }]);
    assert.equal(result.songs.copied.length, 1);
    const [second] = result.songs.copied;
    assert.equal(second.from, 'shared/Second_Song.mp3');
    assert.equal(second.filepath, 'collection/Albums/Nova/Night Ferry/Second_Song.mp3');
    assert.deepEqual([second.title, second.artist, second.album], ['Second Song', 'Nova', 'Night Ferry']);
    assert.ok(second.trackId > 0 && second.bytes > 1000);
    assert.equal(result.bytes, second.bytes);
    assert.deepEqual(result.missingVars, []);
    assert.deepEqual(result.peer, { id: peerId, name: 'copier' });
    assert.ok(fs.existsSync(path.join(collectionDir, 'Albums', 'Nova', 'Night Ferry', 'Second_Song.mp3')));
    assert.ok(!fs.readdirSync(path.join(collectionDir, 'Albums')).some((f) => f.endsWith('.part')), 'no .part left behind');
    assert.equal(bRow('SELECT source FROM tracks WHERE filepath = ?', 'Albums/Nova/Night Ferry/Second_Song.mp3').source, PLUGIN);
    assert.equal(bRow('SELECT COUNT(*) AS n FROM plugin_downloads WHERE job_id = ?', job.id).n, 1, 'one provenance row per song the album copied');
    // The same album again: nothing left to copy, nothing failed.
    const again = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3'), scope: 'album' });
    assert.equal(again.status, 202, 'the earlier album job is finished, so this is a new one');
    const rerun = await untilFinished(again.body.job.id);
    assert.equal(rerun.state, 'done', `job error: ${rerun.error}`);
    assert.deepEqual([rerun.result.songs.copied.length, rerun.result.songs.skipped.length, rerun.result.songs.failed.length], [0, 2, 0]);
    assert.ok(rerun.result.songs.skipped.every((s) => s.why === 'owned'));
    // A song copy of the same recommendation is its own job, and the lookup shows both.
    const look = await api(srvB, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Remote_Hit.mp3') });
    assert.equal(look.status, 200);
    assert.equal(look.body.keys.album, again.body.job.key);
    assert.ok(look.body.jobs.some((j) => j.id === again.body.job.id), 'the album job is in the lookup');
    // An album the peer does not have fails with the reason.
    const none = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3', { album: 'Ghost Album' }), scope: 'album' });
    const failed = await untilFinished(none.body.job.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /no songs for/);
  });

  test('what you\'re missing: the artist\'s albums the library lacks, minus what the artist only appears on', async () => {
    // B has Night Ferry (the album copy above). The peer lists Second Wind
    // (Nova's) and Various Hits (a compilation Nova is on) besides it.
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3'), scope: 'artist-missing' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.deepEqual(started.body.job.params, { scope: 'artist-missing', destination: pinnedTo('Albums') });
    assert.match(started.body.job.key, /^artist-missing:/);
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.scope, 'artist-missing');
    assert.deepEqual(result.artist, { name: 'Nova' });
    assert.deepEqual(result.skippedAlbums.map((a) => [a.name, a.why]).sort(), [['Night Ferry', 'owned'], ['Various Hits', 'appearance']]);
    assert.deepEqual(result.albums.map((a) => [a.name, a.year, a.songs.total, a.songs.copied.length, a.stopped]), [['Second Wind', 2021, 1, 1, null]]);
    assert.deepEqual([result.songs.total, result.songs.copied.length, result.songs.skipped.length, result.songs.failed.length, result.stopped], [1, 1, 0, 0, null]);
    assert.equal(result.songs.copied[0].album, 'Second Wind');
    assert.equal(result.songs.copied[0].filepath, 'collection/Albums/Nova/Second Wind/Fourth_Song.mp3');
    assert.equal(result.bytes, result.songs.copied[0].bytes);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Albums', 'Nova', 'Second Wind', 'Fourth_Song.mp3')));
    assert.ok(!fs.existsSync(path.join(collectionDir, 'Albums', 'Various Artists')), 'the compilation was not pulled');
    assert.equal(bRow('SELECT COUNT(*) AS n FROM plugin_downloads WHERE job_id = ?', job.id).n, 1);
  });

  test('every album of the artist: album by album, the songs the library has skipped one by one', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Second_Song.mp3'), scope: 'artist' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.match(started.body.job.key, /^artist:/);
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.scope, 'artist');
    assert.deepEqual(result.albums.map((a) => [a.name, a.songs.total, a.songs.copied.length, a.songs.skipped.length]).sort(), [['Night Ferry', 2, 0, 2], ['Second Wind', 1, 0, 1]]);
    assert.deepEqual(result.skippedAlbums.map((a) => [a.name, a.why]), [['Various Hits', 'appearance']]);
    assert.deepEqual([result.songs.total, result.songs.copied.length, result.songs.skipped.length, result.songs.failed.length, result.stopped, result.bytes], [3, 0, 3, 0, null, 0]);
    assert.ok(result.songs.skipped.every((s) => s.why === 'owned' && s.album));
    // The lookup holds one job per scope.
    const look = await api(srvB, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: rec('Second_Song.mp3') });
    const byScope = Object.fromEntries((look.body.jobs || []).map((j) => [(j.params && j.params.scope) || 'song', j.id]));
    assert.equal(byScope.artist, job.id);
    assert.ok(byScope['artist-missing'] > 0 && byScope.album > 0, JSON.stringify(byScope));
    // An artist the peer does not know fails with the reason.
    const none = await api(srvB, 'POST', JOBS, { recommendation: rec('Remote_Hit.mp3', { artist: 'Nobody Here' }), scope: 'artist' });
    const failed = await untilFinished(none.body.job.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /lists no albums/);
  });

  // {{ALBUMARTIST}} of a file with no albumartist tag — common on peers — is
  // the album's credit the copy knows, never the file's own artist, so a
  // featured song or an untagged compilation lands with its album (found
  // 2026-10-22: "Boukmanflow feat. Ola/Borrowed Tapes").
  const peerAlbum = async (artist, name) => {
    const r = await api(srvB, 'POST', `/api/v1/federation/peers/${peerId}/api/api/v1/db/artists-albums`, { artist });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.albums.find((a) => a.name === name);
  };
  const credits = (...segs) => path.join(collectionDir, 'Credits', ...segs);

  test('a song copy of a featured track files under the row\'s album credit, with its album', async () => {
    assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: 'Credits', layout: '{{ALBUMARTIST}}/{{ALBUM}}' } })).status, 200);
    // The credit a connected server's row carries: the album's primary artist.
    const credit = (await peerAlbum('Boukmanflow', 'Borrowed Tapes')).album_artist;
    assert.equal(credit, 'Boukmanflow');
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Borrowed_3.mp3', { albumArtist: credit }) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.copied.filepath, 'collection/Credits/Boukmanflow/Borrowed Tapes/Borrowed_3.mp3', JSON.stringify(job.result));
    assert.equal(job.result.copied.artist, 'Boukmanflow feat. Mika', 'the song keeps its own artist');
    assert.deepEqual(job.result.missingVars, []);
    assert.ok(fs.existsSync(credits('Boukmanflow', 'Borrowed Tapes', 'Borrowed_3.mp3')));
    assert.deepEqual(fs.readdirSync(credits()), ['Boukmanflow'], 'no folder of the featured credit');
  });

  test('an album copy: a featured track whose file has no albumartist tag lands with the rest of the album, under the credit', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Borrowed_2.mp3', { albumArtist: 'Boukmanflow' }), scope: 'album' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.deepEqual(result.album, { name: 'Borrowed Tapes', artist: 'Boukmanflow feat. Ola', albumArtist: 'Boukmanflow', year: null });
    assert.deepEqual([result.songs.total, result.songs.failed.length, result.stopped], [3, 0, null], JSON.stringify(result.songs.failed));
    assert.deepEqual(result.songs.skipped, [{ from: 'shared/Borrowed_3.mp3', why: 'owned', at: 'collection/Credits/Boukmanflow/Borrowed Tapes/Borrowed_3.mp3' }]);
    assert.deepEqual(result.songs.copied.map((s) => [s.from, s.filepath, s.artist]).sort(), [
      ['shared/Borrowed_1.mp3', 'collection/Credits/Boukmanflow/Borrowed Tapes/Borrowed_1.mp3', 'Boukmanflow'],
      ['shared/Borrowed_2.mp3', 'collection/Credits/Boukmanflow/Borrowed Tapes/Borrowed_2.mp3', 'Boukmanflow feat. Ola'],
    ]);
    assert.deepEqual(fs.readdirSync(credits()), ['Boukmanflow'], 'one folder for the album');
    assert.deepEqual(fs.readdirSync(credits('Boukmanflow', 'Borrowed Tapes')).sort(), ['Borrowed_1.mp3', 'Borrowed_2.mp3', 'Borrowed_3.mp3']);
  });

  test('a compilation whose files have no albumartist tag lands in one folder, under its credit', async () => {
    // Flagged as a compilation, no albumartist: the peer credits it to "Various Artists".
    const listed = await peerAlbum('Ana Vey', 'Tape Swap');
    assert.deepEqual([listed.album_artist, listed.compilation], ['Various Artists', true]);
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Swap_1.mp3', { albumArtist: listed.album_artist }), scope: 'album' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.deepEqual([result.songs.total, result.songs.skipped.length, result.songs.failed.length], [2, 0, 0], JSON.stringify(result.songs));
    assert.deepEqual(result.songs.copied.map((s) => [s.filepath, s.artist]).sort(), [
      ['collection/Credits/Various Artists/Tape Swap/Swap_1.mp3', 'Ana Vey'],
      ['collection/Credits/Various Artists/Tape Swap/Swap_2.mp3', 'Ben Lusk'],
    ]);
    assert.ok(!fs.existsSync(credits('Ana Vey')) && !fs.existsSync(credits('Ben Lusk')), 'not one folder per track artist');
  });

  test('an album copy from a row with no credit (a peer on an older server) files under the artist it was listed by', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Older_1.mp3'), scope: 'album' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.deepEqual(result.album, { name: 'Old Peer', artist: 'Kaya Moss', albumArtist: null, year: null }, 'narrowed by the track artist');
    assert.deepEqual([result.songs.total, result.songs.skipped.length, result.songs.failed.length], [2, 0, 0], JSON.stringify(result.songs));
    assert.deepEqual(result.songs.copied.map((s) => [s.filepath, s.artist]).sort(), [
      ['collection/Credits/Kaya Moss/Old Peer/Older_1.mp3', 'Kaya Moss'],
      ['collection/Credits/Kaya Moss/Old Peer/Older_2.mp3', 'Kaya Moss feat. Ola'],
    ]);
    assert.ok(!fs.existsSync(credits('Kaya Moss feat. Ola')), 'no folder of the featured credit');
  });

  test('a file that names its own album artist keeps it, whatever credit the row carries', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Own_Words.mp3', { albumArtist: 'Rhea Lind' }) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.copied.filepath, 'collection/Credits/The Tide Collective/Own Words/Own_Words.mp3', JSON.stringify(job.result));
    assert.ok(!fs.existsSync(credits('Rhea Lind')));
  });

  test('an artist copy files each album\'s untagged songs under the album\'s own credit, as the peer spells it', async () => {
    // Asked by the artist as another spelling has it: the album is the
    // peer's, and so is the folder its featured song lands in.
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Bus_1.mp3', { artist: 'MIKA STRAND' }), scope: 'artist' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.deepEqual(result.albums.map((a) => [a.name, a.songs.total, a.songs.copied.length]), [['Night Bus', 2, 2]], JSON.stringify(result));
    assert.deepEqual(result.songs.copied.map((s) => s.filepath).sort(), [
      'collection/Credits/Mika Strand/Night Bus/Bus_1.mp3',
      'collection/Credits/Mika Strand/Night Bus/Bus_2.mp3',
    ]);
  });

  test('an artist copy files an album the peer credits to no one under the artist it was asked by', async () => {
    // Two artists' songs, no albumartist tag: the peer's one card has no credit.
    const listed = await peerAlbum('Lio Brandt', 'Split Reel');
    assert.deepEqual([listed.album_artist, listed.compilation], [null, false]);
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Split_1.mp3'), scope: 'artist' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.deepEqual(result.albums.map((a) => [a.name, a.songs.total, a.songs.copied.length]), [['Split Reel', 2, 2]], JSON.stringify(result));
    assert.deepEqual(result.songs.copied.map((s) => [s.filepath, s.artist]).sort(), [
      ['collection/Credits/Lio Brandt/Split Reel/Split_1.mp3', 'Lio Brandt'],
      ['collection/Credits/Lio Brandt/Split Reel/Split_2.mp3', 'Lio Brandt feat. Ola'],
    ]);
    assert.ok(!fs.existsSync(credits('Lio Brandt feat. Ola')), 'no folder of the featured credit');
  });

  test('a folder copy: the peer\'s tree lands as it is there, under the base; recycle bins and dot entries stay out; a rerun skips it all', async () => {
    assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: 'Mirror', layout: '{{ARTIST}}/{{ALBUM}}' } })).status, 200);
    const folder = { source: 'federation', peer: { id: peerId, name: 'copier' }, filepath: '/shared/Tree/', title: 'Tree' };
    const started = await api(srvB, 'POST', JOBS, { recommendation: folder, scope: 'folder' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.match(started.body.job.key, /^folder:/);
    assert.deepEqual(started.body.job.params, { scope: 'folder', destination: pinnedTo('Mirror') });
    assert.equal(started.body.job.recommendation.filepath, '/shared/Tree/', 'kept as sent; the key and the copy read it the same');
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    const { result } = job;
    assert.equal(result.scope, 'folder');
    assert.deepEqual(result.folder, { path: 'shared/Tree', name: 'Tree', landed: 'collection/Mirror/Tree' });
    assert.equal(result.layout, 'mirror');
    assert.deepEqual(result.counts, { total: 2, copied: 2, skipped: 0, failed: 0 });
    assert.equal(result.stopped, null);
    assert.deepEqual(result.songs.copied.map((s) => [s.from, s.filepath]), [
      ['shared/Tree/Disc 1/T2.mp3', 'collection/Mirror/Tree/Disc 1/T2.mp3'],
      ['shared/Tree/T1.mp3', 'collection/Mirror/Tree/T1.mp3'],
    ], 'the peer\'s library name dropped, the folder\'s own layout kept under the base');
    assert.deepEqual(result.skippedFiles.map((s) => [s.from, s.why]).sort(), [
      ['shared/Tree/#recycle/Old.mp3', 'ignored'],
      ['shared/Tree/.hidden/Hid.mp3', 'ignored'],
    ], 'the scanner\'s ignore rules apply to the peer\'s listing too');
    assert.deepEqual(result.missingVars, []);
    assert.deepEqual(result.peer, { id: peerId, name: 'copier' });
    assert.ok(fs.existsSync(path.join(collectionDir, 'Mirror', 'Tree', 'Disc 1', 'T2.mp3')));
    assert.ok(fs.existsSync(path.join(collectionDir, 'Mirror', 'Tree', 'T1.mp3')));
    assert.ok(!fs.existsSync(path.join(collectionDir, 'Mirror', 'Tree', '#recycle')), 'the recycle bin was not mirrored');
    assert.equal(bRow('SELECT source FROM tracks WHERE filepath = ?', 'Mirror/Tree/Disc 1/T2.mp3').source, PLUGIN);
    assert.equal(bRow('SELECT COUNT(*) AS n FROM plugin_downloads WHERE job_id = ?', job.id).n, 2, 'one provenance row per song');
    // Again: everything owned, nothing copied; the lookup names the folder's key whatever the spelling.
    const again = await api(srvB, 'POST', JOBS, { recommendation: { ...folder, filepath: 'shared/Tree' }, scope: 'folder' });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    const rerun = await untilFinished(again.body.job.id);
    assert.equal(rerun.state, 'done', `job error: ${rerun.error}`);
    assert.deepEqual(rerun.result.counts, { total: 2, copied: 0, skipped: 2, failed: 0 });
    assert.ok(rerun.result.songs.skipped.every((s) => s.why === 'owned'));
    const look = await api(srvB, 'POST', '/api/v1/discovery/plugin-jobs/lookup', { recommendation: folder });
    assert.equal(look.status, 200);
    assert.equal(look.body.keys.folder, again.body.job.key, 'the slashed spelling is the same folder');
    assert.ok(look.body.jobs.some((j) => j.id === again.body.job.id), 'the folder job is in the lookup');
  });

  test('a folder copy can be given a place — a chosen folder, or the layout like any other copy — and is refused for what it cannot take', async () => {
    const peer = { id: peerId, name: 'copier' };
    // A chosen folder: the pressed folder's own files go there.
    const chosen = await api(srvB, 'POST', JOBS, { recommendation: { source: 'federation', peer, filepath: 'shared/Tree2', title: 'Tree2' }, scope: 'folder', landing: { path: 'Chosen/Place/' } });
    assert.equal(chosen.status, 202, JSON.stringify(chosen.body));
    assert.deepEqual(chosen.body.job.params, { scope: 'folder', landing: { vpath: null, path: 'Chosen/Place' }, destination: pinnedTo('Mirror') });
    const c = await untilFinished(chosen.body.job.id);
    assert.equal(c.state, 'done', `job error: ${c.error}`);
    assert.equal(c.result.layout, 'folder');
    assert.deepEqual(c.result.folder, { path: 'shared/Tree2', name: 'Tree2', landed: 'collection/Chosen/Place' });
    assert.deepEqual(c.result.songs.copied.map((s) => s.filepath), ['collection/Chosen/Place/U1.mp3']);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Chosen', 'Place', 'U1.mp3')));
    // By tags: filed by the destination's layout, no folder of its own.
    const byTags = await api(srvB, 'POST', JOBS, { recommendation: { source: 'federation', peer, filepath: 'shared/Tree3', title: 'Tree3' }, scope: 'folder', landing: { tags: true } });
    assert.equal(byTags.status, 202, JSON.stringify(byTags.body));
    assert.deepEqual(byTags.body.job.params, { scope: 'folder', landing: { tags: true }, destination: pinnedTo('Mirror') });
    const t = await untilFinished(byTags.body.job.id);
    assert.equal(t.state, 'done', `job error: ${t.error}`);
    assert.equal(t.result.layout, 'tags');
    assert.equal(t.result.folder.landed, null);
    assert.deepEqual(t.result.songs.copied.map((s) => s.filepath), ['collection/Mirror/Treeband/Live Tapes/V1.mp3']);
    // Refused at the door: a landing on a song job, a library the caller cannot write to, a path that climbs out, a folder job without its folder.
    const ask = (body) => api(srvB, 'POST', JOBS, body);
    assert.equal((await ask({ recommendation: rec('Third_Song.mp3'), landing: { path: 'x' } })).status, 400, 'a landing applies to a folder job only');
    assert.equal((await ask({ recommendation: { source: 'federation', peer, filepath: 'shared/Tree2' }, scope: 'folder', landing: { vpath: 'nope', path: '' } })).status, 400);
    assert.equal((await ask({ recommendation: { source: 'federation', peer, filepath: 'shared/Tree2' }, scope: 'folder', landing: { path: '../out' } })).status, 400);
    const noFolder = await ask({ recommendation: { source: 'federation', peer }, scope: 'folder' });
    assert.equal(noFolder.status, 400);
    assert.match(noFolder.body.error, /needs the recommendation's filepath/);
    // A folder the peer does not have fails with the reason.
    const ghost = await untilFinished((await ask({ recommendation: { source: 'federation', peer, filepath: 'shared/Ghost' }, scope: 'folder' })).body.job.id);
    assert.equal(ghost.state, 'failed');
    assert.match(ghost.error, /no longer has this file|no songs under|answered http/);
    // The admin's cap: a folder with more songs than allowed is refused with the count.
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/discovery-jobs', { maxFolderSongs: 1 })).status, 200);
    const capped = await untilFinished((await ask({ recommendation: { source: 'federation', peer, filepath: 'shared/Tree' }, scope: 'folder' })).body.job.id);
    assert.equal(capped.state, 'failed');
    assert.match(capped.error, /holds 2 songs — add its folders one at a time \(the limit is 1;/);
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/discovery-jobs', { maxFolderSongs: 1000 })).status, 200);
  });

  test('a network (p2p) recommendation cannot be copied', async () => {
    const started = await api(srvB, 'POST', JOBS, { recommendation: { source: 'p2p', artist: 'Nova', title: 'Elsewhere' } });
    assert.equal(started.status, 202);
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /paired peer/);
  });

  test('uploads off for the account: no destination, and a copy refuses', async () => {
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/noupload', { noUpload: true })).status, 200);
    try {
      const view = await api(srvB, 'GET', DEST);
      assert.equal(view.status, 200);
      assert.equal(view.body.destination, null);
      assert.deepEqual(view.body.libraries, []);
      // A copy is an upload: refused at the request, before a job exists
      // (the run re-checks the account too, for rights that change later).
      const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Third_Song.mp3') });
      assert.equal(started.status, 403, JSON.stringify(started.body));
      assert.match(started.body.error, /Uploading Disabled/);
    } finally {
      assert.equal((await api(srvB, 'POST', '/api/v1/admin/config/noupload', { noUpload: false })).status, 200);
    }
  });

  test('a copy at the library root with an empty tag reports the dropped variable', async () => {
    assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: '', layout: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' } })).status, 200);
    const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Third_Song.mp3') });
    const job = await untilFinished(started.body.job.id);
    assert.equal(job.state, 'done', `job error: ${job.error}`);
    assert.equal(job.result.copied.filepath, 'collection/Vosto/Solo ()/Third_Song.mp3', JSON.stringify(job.result));
    assert.deepEqual(job.result.missingVars, ['YEAR']);
    assert.ok(fs.existsSync(path.join(collectionDir, 'Vosto', 'Solo ()', 'Third_Song.mp3')));
  });

  test('the peer can switch copies off for this server\'s key: a song copy and an album stop with refused (nothing copied, no failure to retry), playback goes on', async () => {
    const keyId = (await api(srvA, 'GET', '/api/v1/admin/federation/keys')).body[0].id;
    const setCopies = (allowCopies) => api(srvA, 'POST', `/api/v1/admin/federation/keys/${keyId}/limits`, { streamKbps: 0, dailyMb: 0, maxStreams: 0, allowCopies });
    assert.equal((await setCopies(false)).status, 200);
    try {
      // A song B does not have (the compilation track the artist scopes left out).
      const song = await api(srvB, 'POST', JOBS, { recommendation: rec('Comp_Track.mp3') });
      const refused = await untilFinished(song.body.job.id);
      assert.equal(refused.state, 'done', `job error: ${refused.error}`);
      assert.equal(refused.result.stopped, 'refused', JSON.stringify(refused.result));
      assert.equal(refused.result.peer.id, peerId);
      assert.equal(refused.result.copied, undefined, 'nothing copied');
      const album = await api(srvB, 'POST', JOBS, { recommendation: rec('Comp_Track.mp3'), scope: 'album' });
      const stopped = await untilFinished(album.body.job.id);
      assert.equal(stopped.state, 'done', `job error: ${stopped.error}`);
      assert.equal(stopped.result.stopped, 'refused');
      assert.deepEqual([stopped.result.songs.copied.length, stopped.result.songs.failed.length], [0, 1]);
      assert.match(stopped.result.songs.failed[0].error, /does not allow copies/);
      // Playback through the stream proxy is untouched.
      const stream = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/stream/shared/Comp_Track.mp3`);
      assert.equal(stream.status, 200);
      await stream.arrayBuffer();
    } finally {
      assert.equal((await setCopies(true)).status, 200);
    }
    const again = await api(srvB, 'POST', JOBS, { recommendation: rec('Comp_Track.mp3') });
    const copied = await untilFinished(again.body.job.id);
    assert.equal(copied.state, 'done', `job error: ${copied.error}`);
    assert.ok(copied.result.copied && copied.result.copied.filepath, 'switched back on, the copy lands');
  });

  test('a copy lands where the destination was when it was asked for, though it changed while the copy waited its turn', async () => {
    const pinned = { vpath: 'collection', base: 'Pinned', layout: '{{ARTIST}}/{{ALBUM}}' };
    assert.equal((await api(srvB, 'PUT', DEST, { destination: pinned })).status, 200);
    const shown = (await api(srvB, 'GET', DEST)).body.destination;
    assert.deepEqual(shown, pinnedTo('Pinned'));
    // Two slow test jobs fill the runner (discoveryJobs.maxConcurrent, 2),
    // so the copy is held queued behind them.
    const fillers = [];
    try {
      for (const title of ['slow filler one', 'slow filler two']) {
        const r = await api(srvB, 'POST', '/api/v1/discovery/plugins/noop-acquire/jobs', { recommendation: { artist: 'Filler', title } });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        fillers.push(r.body.job.id);
      }
      const deadline = Date.now() + 10_000;
      while ((await Promise.all(fillers.map((id) => api(srvB, 'GET', `/api/v1/discovery/plugin-jobs/${id}`)))).some((r) => r.body.job.state !== 'running')) {
        if (Date.now() > deadline) { throw new Error('the filler jobs never ran'); }
        await new Promise((r) => setTimeout(r, 50));
      }
      const started = await api(srvB, 'POST', JOBS, { recommendation: rec('Pinned_Song.mp3'), destination: shown });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.deepEqual(started.body.job.params, { destination: shown });
      assert.equal((await api(srvB, 'GET', `/api/v1/discovery/plugin-jobs/${started.body.job.id}`)).body.job.state, 'queued', 'held behind the fillers');

      // The destination moves before the copy runs.
      assert.equal((await api(srvB, 'PUT', DEST, { destination: { vpath: 'collection', base: 'Moved', layout: '{{ALBUM}}' } })).status, 200);
      for (const id of fillers) { await api(srvB, 'POST', `/api/v1/discovery/plugin-jobs/${id}/cancel`); }
      const job = await untilFinished(started.body.job.id);
      assert.equal(job.state, 'done', `job error: ${job.error}`);
      assert.equal(job.result.copied.filepath, 'collection/Pinned/Pinza/Holding Pattern/Pinned_Song.mp3', JSON.stringify(job.result));
      assert.deepEqual(job.result.destination, shown);
      assert.ok(fs.existsSync(path.join(collectionDir, 'Pinned', 'Pinza', 'Holding Pattern', 'Pinned_Song.mp3')));
      assert.ok(!fs.existsSync(path.join(collectionDir, 'Moved')), 'nothing where the destination moved to');
    } finally {
      for (const id of fillers) { await api(srvB, 'POST', `/api/v1/discovery/plugin-jobs/${id}/cancel`); }
    }
  });

  test('the shared fixture library never received a file', () => {
    // 'Vosto' is a real fixture artist; only the folders a stray copy would
    // create are checked.
    const fixtureRoot = bRow("SELECT root_path FROM libraries WHERE name = 'testlib'").root_path;
    assert.ok(!fs.existsSync(path.join(fixtureRoot, 'From peers')), 'no "From peers" in the fixture library');
    assert.ok(!fs.existsSync(path.join(fixtureRoot, 'Vosto', 'Solo ()')), 'no "Solo ()" album in the fixture library');
  });
});
