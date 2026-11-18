/**
 * The apt/dnf repository publish (scripts/linux-repo/sync-bunny.mjs), run
 * against a fake Bunny storage zone that speaks the documented API: PUT
 * with an optional SHA256 `Checksum` header (201), directory listings as
 * JSON arrays of { ObjectName, IsDirectory, Length, ... }, DELETE (200),
 * and the account API's POST /purge?url=.
 *
 * What must hold whatever happens mid-publish: the live repository - what a
 * client reaches through the pointer files (InRelease/Release, repomd.xml)
 * - is whole. So the pointers move last, only after everything they name is
 * confirmed in the zone; a failed publish leaves the previous one intact;
 * and the files the PREVIOUS pointers named outlive the switch by one
 * publish, for clients and CDN edges still holding those pointers.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, planSync, sync, MANIFEST } from '../../scripts/linux-repo/sync-bunny.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/linux-repo/sync-bunny.mjs', import.meta.url));
const sha = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

// ── A fake Bunny: one storage zone ("zone") and the purge endpoint. ─────────
function fakeBunny() {
  const state = {
    files: new Map(), // rel -> Buffer
    requests: [], // ['PUT'|'DELETE'|'GET'|'PURGE', rel-or-url]
    purged: [],
    omitChecksum: false,
    failPut: () => false,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fake');
    const send = (code, payload = { HttpCode: code }) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/purge') {
      if (req.method !== 'POST' || req.headers.accesskey !== 'account-key') { return send(401); }
      state.requests.push(['PURGE', url.searchParams.get('url')]);
      state.purged.push(url.searchParams.get('url'));
      return send(200);
    }

    if (req.headers.accesskey !== 'zone-password') { return send(401, { HttpCode: 401, Message: 'Unauthorized' }); }
    const parts = url.pathname.split('/').map(decodeURIComponent);
    if (parts[1] !== 'zone') { return send(404); }
    const rel = parts.slice(2).join('/');

    if (req.method === 'PUT') {
      state.requests.push(['PUT', rel]);
      if (state.failPut(rel)) { return send(500, { HttpCode: 500, Message: 'storage node down' }); }
      // Uploads arrive with a length, as curl --upload-file sends them.
      if (!req.headers['content-length']) { return send(411); }
      if (req.headers.checksum && req.headers.checksum !== sha(body)) { return send(400, { HttpCode: 400, Message: 'Checksum mismatch' }); }
      state.files.set(rel, body);
      return send(201, { HttpCode: 201, Message: 'File uploaded.' });
    }
    if (req.method === 'DELETE') {
      state.requests.push(['DELETE', rel]);
      return state.files.delete(rel) ? send(200) : send(404);
    }
    if (req.method === 'GET' && (rel === '' || rel.endsWith('/'))) {
      const entries = new Map();
      for (const [name, data] of state.files) {
        if (!name.startsWith(rel)) { continue; }
        const rest = name.slice(rel.length);
        const slash = rest.indexOf('/');
        if (slash !== -1) {
          entries.set(rest.slice(0, slash), { ObjectName: rest.slice(0, slash), IsDirectory: true, Length: 0, Path: `/zone/${rel}` });
        } else {
          const entry = { ObjectName: rest, IsDirectory: false, Length: data.length, Path: `/zone/${rel}` };
          if (!state.omitChecksum) { entry.Checksum = sha(data); }
          entries.set(rest, entry);
        }
      }
      return send(200, [...entries.values()]);
    }
    if (req.method === 'GET') {
      if (!state.files.has(rel)) { return send(404, { HttpCode: 404, Message: 'Object Not Found' }); }
      res.writeHead(200);
      return res.end(state.files.get(rel));
    }
    return send(405);
  });
  return { state, server };
}

// ── A miniature of what build.sh emits. Each generation has its own
// by-hash and repodata names; the pointers and fixed-name indexes change
// content in place. ───────────────────────────────────────────────────────────
async function makeTree(root, { gen, versions }) {
  const files = {
    'mstream.asc': 'PUBLIC KEY',
    'apt/dists/stable/Release': `Release gen ${gen}`,
    'apt/dists/stable/Release.gpg': `Release.gpg gen ${gen}`,
    'apt/dists/stable/InRelease': `InRelease gen ${gen}`,
    'apt/dists/stable/main/binary-amd64/Packages': `Packages gen ${gen}`,
    'apt/dists/stable/main/binary-amd64/Packages.xz': `Packages.xz gen ${gen}`,
    [`apt/dists/stable/main/binary-amd64/by-hash/SHA256/hash-of-gen-${gen}`]: `Packages gen ${gen}`,
    'rpm/mstream.repo': '[mstream]',
    'rpm/repodata/repomd.xml': `repomd gen ${gen}`,
    'rpm/repodata/repomd.xml.asc': `repomd.asc gen ${gen}`,
    'rpm/repodata/repomd.xml.key': 'PUBLIC KEY',
    [`rpm/repodata/gen${gen}-primary.xml.gz`]: `primary gen ${gen}`,
  };
  for (const v of versions) {
    files[`apt/pool/main/m/mstream/mstream_${v}_amd64.deb`] = `deb ${v}`;
    files[`rpm/packages/mstream-${v}-1.x86_64.rpm`] = `rpm ${v}`;
  }
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return Object.keys(files).sort();
}

describe('linux-repo sync: classify', () => {
  test('pointers, fixed-name indexes, fixed names, and everything else', () => {
    assert.equal(classify('apt/dists/stable/InRelease'), 'pointer');
    assert.equal(classify('apt/dists/stable/Release'), 'pointer');
    assert.equal(classify('apt/dists/stable/Release.gpg'), 'pointer');
    assert.equal(classify('rpm/repodata/repomd.xml'), 'pointer');
    assert.equal(classify('rpm/repodata/repomd.xml.asc'), 'pointer');
    assert.equal(classify('apt/dists/stable/main/binary-arm64/Packages.xz'), 'index');
    assert.equal(classify('apt/dists/stable/main/binary-arm64/Packages'), 'index');
    assert.equal(classify('mstream.asc'), 'named');
    assert.equal(classify('rpm/mstream.repo'), 'named');
    assert.equal(classify('rpm/repodata/repomd.xml.key'), 'named');
    // by-hash copies are content-addressed even though they sit under dists/
    assert.equal(classify('apt/dists/stable/main/binary-arm64/by-hash/SHA256/abc'), 'immutable');
    assert.equal(classify('apt/pool/main/m/mstream/mstream_6.33.1_amd64.deb'), 'immutable');
    assert.equal(classify('rpm/repodata/0123-primary.xml.gz'), 'immutable');
    assert.equal(classify('rpm/packages/mstream-6.33.1-1.x86_64.rpm'), 'immutable');
  });
});

describe('linux-repo sync: planSync', () => {
  const local = [
    { rel: 'apt/dists/stable/InRelease', size: 5, sha256: 'NEW' },
    { rel: 'apt/pool/main/m/mstream/mstream_2_amd64.deb', size: 9, sha256: 'DEB2' },
    { rel: 'mstream.asc', size: 3, sha256: 'KEY' },
  ];

  test('a listing without checksums: versioned names are trusted by size, fixed names are re-sent', () => {
    const remote = new Map([
      ['apt/pool/main/m/mstream/mstream_2_amd64.deb', { size: 9, checksum: null }],
      ['mstream.asc', { size: 3, checksum: null }],
    ]);
    const plan = planSync(local, remote, null);
    assert.deepEqual(plan.early.map((u) => u.rel), ['mstream.asc']);
    assert.deepEqual(plan.pointers.map((u) => u.rel), ['apt/dists/stable/InRelease']);
  });

  test('a package whose bytes differ under the same name is replaced and purged', () => {
    const remote = new Map([['apt/pool/main/m/mstream/mstream_2_amd64.deb', { size: 9, checksum: 'OTHER' }]]);
    const plan = planSync(local, remote, null);
    assert.ok(plan.early.some((u) => u.rel.endsWith('mstream_2_amd64.deb')));
    assert.ok(plan.purge.includes('apt/pool/main/m/mstream/mstream_2_amd64.deb'));
  });

  test('without a record of the previous publish nothing is deleted', () => {
    const remote = new Map([['stranger.txt', { size: 1, checksum: 'X' }]]);
    const plan = planSync(local, remote, null);
    assert.deepEqual(plan.deletes, []);
    assert.deepEqual(plan.retained, ['stranger.txt']);
  });

  test('the manifest itself is never a deletion candidate', () => {
    const remote = new Map([[MANIFEST, { size: 1, checksum: 'X' }], ['old.deb', { size: 1, checksum: 'X' }]]);
    const plan = planSync(local, remote, new Set());
    assert.deepEqual(plan.deletes, ['old.deb']);
  });
});

describe('linux-repo sync: publishing to a zone', () => {
  let bunny;
  let base;
  let scratch;

  before(async () => {
    bunny = fakeBunny();
    await new Promise((r) => { bunny.server.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${bunny.server.address().port}`;
  });
  after(async () => { await new Promise((r) => { bunny.server.close(r); }); });
  beforeEach(async () => {
    bunny.state.files.clear();
    bunny.state.requests.length = 0;
    bunny.state.purged.length = 0;
    bunny.state.omitChecksum = false;
    bunny.state.failPut = () => false;
    if (scratch) { await rm(scratch, { recursive: true, force: true }); }
    scratch = await mkdtemp(join(tmpdir(), 'linux-repo-sync-'));
  });
  after(async () => { if (scratch) { await rm(scratch, { recursive: true, force: true }); } });

  const run = (dir, extra = {}) => sync({
    dir, zone: 'zone', password: 'zone-password', storageBase: base, apiBase: base,
    log: () => {}, retryDelayMs: 1, ...extra,
  });
  const text = (rel) => bunny.state.files.get(rel)?.toString();
  const puts = () => bunny.state.requests.filter(([m]) => m === 'PUT').map(([, rel]) => rel);
  const publish = async (gen, versions, extra) => {
    const dir = join(scratch, `gen${gen}`);
    const rels = await makeTree(dir, { gen, versions });
    await run(dir, extra);
    return rels;
  };

  test('a first publish uploads the tree, pointers last, and records it', async () => {
    const rels = await publish(1, ['1.0.0']);
    assert.deepEqual([...bunny.state.files.keys()].sort(), [MANIFEST, ...rels].sort());

    const order = puts();
    const firstPointer = order.findIndex((rel) => classify(rel) === 'pointer');
    const lastOther = order.findLastIndex((rel) => rel !== MANIFEST && classify(rel) !== 'pointer');
    assert.ok(lastOther < firstPointer, 'a pointer was written before something it names');
    assert.equal(order.at(-1), MANIFEST);
    // Each detached signature directly follows the file it signs.
    assert.deepEqual(order.slice(firstPointer, -1), [
      'apt/dists/stable/Release', 'apt/dists/stable/Release.gpg', 'apt/dists/stable/InRelease',
      'rpm/repodata/repomd.xml', 'rpm/repodata/repomd.xml.asc',
    ]);
    assert.deepEqual(JSON.parse(text(MANIFEST)).files, rels);
    assert.equal(bunny.state.requests.filter(([m]) => m === 'DELETE').length, 0);
  });

  test('the next publish re-sends nothing unchanged and keeps what the old pointers name', async () => {
    await publish(1, ['1.0.0', '1.1.0']);
    bunny.state.requests.length = 0;
    await publish(2, ['1.1.0', '1.2.0']);

    const sent = puts();
    assert.ok(!sent.some((rel) => rel.includes('1.1.0')), 'an unchanged package was uploaded again');
    assert.ok(!sent.includes('mstream.asc'), 'the unchanged key was uploaded again');
    assert.ok(sent.some((rel) => rel.endsWith('mstream_1.2.0_amd64.deb')));
    assert.equal(text('apt/dists/stable/InRelease'), 'InRelease gen 2');

    // Generation 1's metadata AND its dropped package are still there: a
    // client holding gen 1's pointers can finish what it started.
    assert.equal(bunny.state.requests.filter(([m]) => m === 'DELETE').length, 0);
    assert.ok(bunny.state.files.has('apt/dists/stable/main/binary-amd64/by-hash/SHA256/hash-of-gen-1'));
    assert.ok(bunny.state.files.has('rpm/repodata/gen1-primary.xml.gz'));
    assert.ok(bunny.state.files.has('apt/pool/main/m/mstream/mstream_1.0.0_amd64.deb'));
  });

  test('the publish after that deletes exactly what two generations ago left behind', async () => {
    await publish(1, ['1.0.0', '1.1.0']);
    await publish(2, ['1.1.0', '1.2.0']);
    const rels3 = await publish(3, ['1.2.0', '1.3.0']);

    const names = [...bunny.state.files.keys()];
    assert.ok(!names.some((rel) => rel.includes('gen-1') || rel.includes('gen1-') || rel.includes('1.0.0')), 'generation 1 leftovers survived');
    // Generation 2's leftovers are the new grace set.
    assert.ok(names.includes('apt/dists/stable/main/binary-amd64/by-hash/SHA256/hash-of-gen-2'));
    assert.ok(names.includes('rpm/repodata/gen2-primary.xml.gz'));
    assert.ok(names.includes('rpm/packages/mstream-1.1.0-1.x86_64.rpm'));
    for (const rel of rels3) { assert.ok(names.includes(rel), `${rel} is missing`); }
  });

  test('a failed upload leaves the previous repository exactly as it was', async () => {
    await publish(1, ['1.0.0']);
    const before = new Map(bunny.state.files);
    bunny.state.failPut = (rel) => rel.endsWith('mstream_1.1.0_amd64.deb');

    await assert.rejects(publish(2, ['1.0.0', '1.1.0']), /HTTP 500/);

    // 4 tries at the failing file, and not one pointer or index moved.
    assert.equal(puts().filter((rel) => rel.endsWith('mstream_1.1.0_amd64.deb')).length, 4);
    for (const rel of ['apt/dists/stable/InRelease', 'apt/dists/stable/Release', 'rpm/repodata/repomd.xml', 'rpm/repodata/repomd.xml.asc',
      'apt/dists/stable/main/binary-amd64/Packages', MANIFEST]) {
      assert.deepEqual(bunny.state.files.get(rel), before.get(rel), `${rel} changed`);
    }

    // Re-running finishes the job.
    bunny.state.failPut = () => false;
    await run(join(scratch, 'gen2'));
    assert.equal(text('apt/dists/stable/InRelease'), 'InRelease gen 2');
    assert.ok(bunny.state.files.has('apt/pool/main/m/mstream/mstream_1.1.0_amd64.deb'));
  });

  test('with an API key, every fixed-name file that changed is purged from the CDN', async () => {
    await publish(1, ['1.0.0'], { apiKey: 'account-key', repoUrl: 'https://repo.example/' });
    bunny.state.purged.length = 0;
    bunny.state.requests.length = 0;
    await publish(2, ['1.0.0', '1.1.0'], { apiKey: 'account-key', repoUrl: 'https://repo.example/' });

    assert.deepEqual(bunny.state.purged.slice().sort(), [
      'https://repo.example/apt/dists/stable/InRelease',
      'https://repo.example/apt/dists/stable/Release',
      'https://repo.example/apt/dists/stable/Release.gpg',
      'https://repo.example/apt/dists/stable/main/binary-amd64/Packages',
      'https://repo.example/apt/dists/stable/main/binary-amd64/Packages.xz',
      'https://repo.example/rpm/repodata/repomd.xml',
      'https://repo.example/rpm/repodata/repomd.xml.asc',
    ]);
    // ...and only after the last pointer is in place.
    const lastPointer = bunny.state.requests.findLastIndex(([m, rel]) => m === 'PUT' && classify(rel) === 'pointer');
    const firstPurge = bunny.state.requests.findIndex(([m]) => m === 'PURGE');
    assert.ok(lastPointer !== -1 && lastPointer < firstPurge, 'the CDN was purged before the pointers were in place');
  });

  test('an API key without the public URL is refused before anything is sent', async () => {
    const dir = join(scratch, 'gen1');
    await makeTree(dir, { gen: 1, versions: ['1.0.0'] });
    await assert.rejects(run(dir, { apiKey: 'account-key' }), /REPO_URL is required/);
    assert.equal(bunny.state.requests.length, 0);
  });

  test('a dry run reads the zone and changes nothing', async () => {
    await publish(1, ['1.0.0']);
    const before = new Map(bunny.state.files);
    bunny.state.requests.length = 0;
    const dir = join(scratch, 'gen2');
    await makeTree(dir, { gen: 2, versions: ['1.0.0', '1.1.0'] });

    const { plan } = await run(dir, { dryRun: true });
    assert.ok(plan.pointers.length === 5 && plan.early.length > 0);
    assert.equal(bunny.state.requests.length, 0);
    assert.deepEqual(bunny.state.files, before);
  });

  test('a wrong password fails at once, with a hint, and is not retried', async () => {
    const dir = join(scratch, 'gen1');
    await makeTree(dir, { gen: 1, versions: ['1.0.0'] });
    await assert.rejects(run(dir, { password: 'nope' }), /HTTP 401.*BUNNY_STORAGE_HOST/);
    assert.equal(bunny.state.files.size, 0);
  });

  test('a zone whose listing carries no checksums still converges', async () => {
    bunny.state.omitChecksum = true;
    await publish(1, ['1.0.0']);
    bunny.state.requests.length = 0;
    await publish(2, ['1.0.0', '1.1.0']);
    const sent = puts();
    assert.ok(!sent.some((rel) => rel.includes('1.0.0')), 'an unchanged package was uploaded again');
    assert.ok(sent.includes('mstream.asc'), 'a fixed name cannot be proven unchanged without a checksum');
    assert.equal(text('rpm/repodata/repomd.xml'), 'repomd gen 2');
  });

  test('a directory that is not a built repository is refused', async () => {
    const dir = join(scratch, 'not-a-repo');
    await makeTree(dir, { gen: 1, versions: ['1.0.0'] });
    await rm(join(dir, 'rpm/repodata/repomd.xml.asc'));
    await assert.rejects(run(dir), /not a built repository: no rpm\/repodata\/repomd\.xml\.asc/);
    assert.equal(bunny.state.requests.length, 0);
  });

  // The workflow drives the script through its command line and environment.
  const cli = (args, env) => new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  const zoneEnv = () => ({
    BUNNY_STORAGE_HOST: base, BUNNY_STORAGE_ZONE: 'zone', BUNNY_STORAGE_PASSWORD: 'zone-password',
    BUNNY_API_KEY: '', REPO_URL: '',
  });

  test('command line: --dry-run plans, a plain run publishes', async () => {
    const dir = join(scratch, 'gen1');
    const rels = await makeTree(dir, { gen: 1, versions: ['1.0.0'] });

    const dry = await cli([dir, '--dry-run'], zoneEnv());
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would upload {2}apt\/dists\/stable\/InRelease/);
    assert.match(dry.stdout, /dry run: nothing was changed/);
    assert.equal(bunny.state.files.size, 0);

    const real = await cli([dir], zoneEnv());
    assert.equal(real.code, 0, real.stderr);
    assert.deepEqual([...bunny.state.files.keys()].sort(), [MANIFEST, ...rels].sort());
  });

  test('command line: missing settings and bad arguments exit 1 with the reason', async () => {
    const dir = join(scratch, 'gen1');
    await makeTree(dir, { gen: 1, versions: ['1.0.0'] });

    const noPassword = await cli([dir], { ...zoneEnv(), BUNNY_STORAGE_PASSWORD: '' });
    assert.equal(noPassword.code, 1);
    assert.match(noPassword.stderr, /storage zone name and its password are required/);

    const badFlag = await cli([dir, '--force'], zoneEnv());
    assert.equal(badFlag.code, 1);
    assert.match(badFlag.stderr, /usage: sync-bunny\.mjs/);
    assert.equal(bunny.state.requests.length, 0);
  });
});
