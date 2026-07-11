/**
 * Discovery-over-federation, caller side (phase 2), end-to-end over real
 * iroh: POST /api/v1/discovery/federation/similar.
 *
 * Server A (remote peer): federation + discovery ON ('test-fake'), one
 * 'shared' library whose tracks carry handcrafted 4-d vectors chosen to
 * exercise every caller-side filter at once:
 *   'Remote Hit'    by Nova     cos 0.9    → the novel result
 *   'Be Somebody'   by Icarus   cos 0.8    → artist+title B owns → dropped
 *   'Brand New Cut' by Vosto    cos 0.7    → novel, but Vosto is a B artist
 *                                            → dropped under newArtistsOnly
 *   'Dup Encode'    by Copycat  cos ≈0.999 → near-dup of the seed → dropped
 *
 * Server B (caller): federation + discovery ON, default fixture testlib,
 * its 'Be Somebody' seeded as the query vector's owner. B adds A TWICE
 * (two minted keys → two peer rows, same endpoint), so the cross-peer
 * dedupe is proven end-to-end: searched.peers = 2, every song once.
 *
 * Also pins: the ping `federationDiscovery` flag contract, the per-peer
 * use_discovery toggle round-trip, and the federation-disabled 403 (done
 * LAST — it flips B's live config off).
 *
 * Skips when @number0/iroh has no prebuilt binary here (both sides need it).
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

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// ── handcrafted vector space (4-d unit vectors; cosines vs SEED are exact) ──
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const SEED = vec(1, 0, 0, 0);                       // B's 'Be Somebody'
const REMOTE = [
  // [title, artist, vector, mbid, tags]
  ['Remote Hit', 'Nova', vec(0.9, 0.436, 0, 0), 'mbid-remote-hit', ['Test---StyleZ']],
  ['Be Somebody', 'Icarus', vec(0.8, 0.6, 0, 0), null, null],
  ['Brand New Cut', 'Vosto', vec(0.7, 0.714, 0, 0), null, null],
  ['Dup Encode', 'Copycat', vec(0.999, 0.0447, 0, 0), null, null],
];

const SEED_PATH = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';

let srvA, srvB, sharedDir;
const peerIds = [];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

// Both servers run PUBLIC mode (no users) — admin routes need no token.
async function api(srv, method, route, body) {
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const aggregate = (body) => api(srvB, 'POST', '/api/v1/discovery/federation/similar', body);

function seedDiscoveryDb(srv, rows) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const trackByTitle = (title) => mdb.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
  `).get(title);
  const ddb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'discovery.db'));
  try {
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)
    `);
    let seq = 0;
    for (const [title, v, mbid, tags] of rows) {
      const t = trackByTitle(title);
      assert.ok(t?.hash, `fixture track '${title}' must exist with a hash`);
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, mbid, t.artist, title, t.duration ?? 120,
        blob(v), tags ? JSON.stringify(tags) : null);
    }
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
}

describe('discovery federation aggregate (B queries A over iroh)', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedagg-'));
    let freq = 400;
    for (const [title, artist] of REMOTE) {
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `sine=frequency=${freq += 55}:duration=2`,
        '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${artist} Album`,
        '-ac', '1', path.join(sharedDir, `${title.replace(/\s/g, '_')}.mp3`),
      ]);
    }

    [srvA, srvB] = await Promise.all([
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { shared: sharedDir },
        extraConfig: {
          federation: { enabled: true },
          scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
        },
      }),
      startServer({
        dlnaMode: 'disabled',
        extraConfig: {
          federation: { enabled: true },
          scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
        },
      }),
    ]);

    seedDiscoveryDb(srvA, REMOTE.map(([title, , v, mbid, tags]) => [title, v, mbid, tags]));
    seedDiscoveryDb(srvB, [['Be Somebody', SEED, null, null]]);

    // Two keys on A → two peer rows on B (same endpoint) = the cross-peer
    // dedupe fixture. Public mode, so minting needs no token.
    for (const name of ['peer-one', 'peer-two']) {
      const mint = await api(srvA, 'POST', '/api/v1/admin/federation/keys', { name, vpaths: ['shared'] });
      assert.equal(mint.status, 200);
      assert.ok(mint.body.ticket, 'A must issue a ticket (endpoint up)');
      const added = await api(srvB, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket, name });
      assert.equal(added.status, 200);
      peerIds.push(added.body.id);
    }
  });

  after(async () => {
    await Promise.all([srvA?.stop(), srvB?.stop()]);
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  test('ping advertises federationDiscovery while an opted-in peer exists', async () => {
    const { status, body } = await api(srvB, 'GET', '/api/v1/ping');
    assert.equal(status, 200);
    assert.equal(body.federationDiscovery, true);
    assert.equal(body.discovery, true, 'sanity: local discovery flag rides the same ping');
  });

  test('aggregates, novelty-filters, and dedupes across both peer rows', async () => {
    const { status, body } = await aggregate({ filePath: SEED_PATH });
    assert.equal(status, 200);
    assert.deepEqual(body.query, { filePath: SEED_PATH, modelId: 'test-fake', newArtistsOnly: false });
    assert.deepEqual(body.searched, { peers: 2, unreachable: 0, mismatched: 0 });

    const titles = body.results.map((r) => r.title);
    assert.deepEqual(titles, ['Remote Hit', 'Brand New Cut'],
      'descending cosine; owned artist+title and the near-dup are gone; two peers, each song once');

    const hit = body.results[0];
    assert.ok(Math.abs(hit.similarity - 0.9) < 1e-3);
    assert.equal(hit.artist, 'Nova');
    assert.equal(hit.recordingMbid, 'mbid-remote-hit');
    assert.deepEqual(hit.genreTags, ['Test---StyleZ']);
    assert.ok(hit.filepath.startsWith('shared/'), 'the peer-side vpath path rides along for the future stream proxy');
    assert.ok(peerIds.includes(hit.peer.id), 'results carry which peer answered');
    assert.ok(Math.abs(body.results[1].similarity - 0.7) < 2e-3);
  });

  test('newArtistsOnly also drops known-artist tracks', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH, newArtistsOnly: true });
    assert.deepEqual(body.results.map((r) => r.title), ['Remote Hit'],
      "Vosto is a testlib artist B already knows; Nova isn't");
  });

  test('limit caps the merged ranking', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH, limit: 1 });
    assert.deepEqual(body.results.map((r) => r.title), ['Remote Hit']);
  });

  test('stream proxy pipes a peer track byte-exact, with range support', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH });
    const hit = body.results.find((r) => r.title === 'Remote Hit');
    assert.ok(hit, 'aggregate supplies the streamable filepath');
    const streamUrl = `${srvB.baseUrl}/api/v1/federation/peers/${hit.peer.id}/stream/${hit.filepath}`;

    const full = await fetch(streamUrl);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type') || '', /audio|octet/);
    const bytes = Buffer.from(await full.arrayBuffer());
    const original = fs.readFileSync(path.join(sharedDir, 'Remote_Hit.mp3'));
    assert.equal(bytes.length, original.length);
    assert.ok(bytes.equals(original), 'proxied bytes match the file on the peer');

    // Seeking = range passthrough in both directions.
    const part = await fetch(streamUrl, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.match(part.headers.get('content-range') || '', /^bytes 0-99\//);
    const partBytes = Buffer.from(await part.arrayBuffer());
    assert.equal(partBytes.length, 100);
    assert.ok(partBytes.equals(original.subarray(0, 100)));
  });

  test('stream proxy: unknown peer 404s locally; ungranted library relays the peer 404', async () => {
    const unknownPeer = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/424242/stream/shared/x.mp3`);
    assert.equal(unknownPeer.status, 404);

    // testlib is NOT granted to either key — the PEER's wall answers 404
    // (unknown-or-forbidden look identical there) and we relay it.
    const ungranted = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerIds[0]}/stream/testlib/01.mp3`);
    assert.equal(ungranted.status, 404);
  });

  test('use_discovery toggle round-trips: off → skipped + flag drops, on → back', async () => {
    for (const id of peerIds) {
      const r = await api(srvB, 'POST', `/api/v1/admin/federation/peers/${id}/discovery`, { enabled: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.use_discovery, 0);
    }
    const off = await aggregate({ filePath: SEED_PATH });
    assert.deepEqual(off.body.searched, { peers: 0, unreachable: 0, mismatched: 0 });
    assert.deepEqual(off.body.results, []);
    assert.equal((await api(srvB, 'GET', '/api/v1/ping')).body.federationDiscovery, false,
      'every peer opted out → the panel gets no flag, sends no probes');

    const back = await api(srvB, 'POST', `/api/v1/admin/federation/peers/${peerIds[0]}/discovery`, { enabled: true });
    assert.equal(back.body.use_discovery, 1);
    const on = await aggregate({ filePath: SEED_PATH });
    assert.deepEqual(on.body.searched, { peers: 1, unreachable: 0, mismatched: 0 });
    assert.deepEqual(on.body.results.map((r) => r.title), ['Remote Hit', 'Brand New Cut']);
  });

  test('unknown peer id on the toggle is 404', async () => {
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/federation/peers/424242/discovery', { enabled: true })).status, 404);
  });

  // LAST — flips B's live federation config off.
  test('federation disabled → aggregate and stream proxy both 403', async () => {
    const off = await api(srvB, 'POST', '/api/v1/admin/federation', { enabled: false });
    assert.equal(off.status, 200);
    const r = await aggregate({ filePath: SEED_PATH });
    assert.equal(r.status, 403);
    const s = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerIds[0]}/stream/shared/Remote_Hit.mp3`);
    assert.equal(s.status, 403);
  });
});
