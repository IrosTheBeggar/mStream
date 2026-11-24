#!/usr/bin/env node
// Publishes a built repository tree (scripts/linux-repo/build.sh) to the
// Bunny storage zone behind the repository's CDN host.
//
//   BUNNY_STORAGE_ZONE=... BUNNY_STORAGE_PASSWORD=... \
//   [BUNNY_STORAGE_HOST=ny.storage.bunnycdn.com] \
//   [BUNNY_API_KEY=... REPO_URL=https://repo.mstream.io] \
//     node scripts/linux-repo/sync-bunny.mjs <tree-dir> [--dry-run]
//
// A repository is a few small POINTER files (apt's InRelease/Release, dnf's
// repomd.xml) naming everything else by hash. So the live repository stays
// consistent at every instant if a publish only ever goes in this order:
//
//   1. everything the new pointers will name - packages, by-hash indexes,
//      hash-named repodata. New names; nothing a client can see changes.
//   2. apt's fixed-name indexes (Packages*). Modern apt never reads them
//      (it fetches by hash); they exist for mirrors and old tools.
//   3. check that 1 + 2 are really there, THEN the pointers. A failure
//      before this point leaves the old repository fully intact; re-running
//      picks up where it stopped.
//   4. purge the CDN's copy of every fixed-name file that changed (Bunny
//      does not watch the storage origin for changes).
//   5. delete what neither this publish nor the PREVIOUS one named, and
//      record this publish's file list for the next run. The one-generation
//      grace is for clients (and CDN edges) still holding the old pointers:
//      what those name must outlive the switch.
//
// The storage zone must be dedicated to the repository: step 5 removes
// files it does not recognise once a previous publish is on record.
//
// `--dry-run` reads the zone and prints the plan without changing anything:
// it doubles as the check that the zone name, region host and password are
// right.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = '.sync-manifest.json';

// A tree without these is not something build.sh finished.
const REQUIRED = [
  'mstream.asc',
  'apt/dists/stable/InRelease',
  'apt/dists/stable/Release',
  'apt/dists/stable/Release.gpg',
  'rpm/mstream.repo',
  'rpm/repodata/repomd.xml',
  'rpm/repodata/repomd.xml.asc',
];

// Upload order of the pointers. Each detached signature goes right behind
// the file it signs: the two cannot move atomically, so the window in which
// they disagree is kept to one small request.
const POINTERS = [
  /^apt\/dists\/[^/]+\/Release$/,
  /^apt\/dists\/[^/]+\/Release\.gpg$/,
  /^apt\/dists\/[^/]+\/InRelease$/,
  /^rpm\/repodata\/repomd\.xml$/,
  /^rpm\/repodata\/repomd\.xml\.asc$/,
];

const pointerRank = (rel) => POINTERS.findIndex((re) => re.test(rel));

// What a path IS decides when it may be written and whether its name alone
// identifies its content:
//   pointer    the mutable roots of trust; written last
//   index      apt's fixed-name Packages*; mutable, written just before
//   named      fixed names whose content almost never changes (the key,
//              the .repo file)
//   immutable  everything else - the name carries a version or a hash
export function classify(rel) {
  if (pointerRank(rel) !== -1) { return 'pointer'; }
  if (/^apt\/dists\/.+\/Packages(\.gz|\.xz)?$/.test(rel) && !rel.includes('/by-hash/')) { return 'index'; }
  if (rel === 'mstream.asc' || rel === 'rpm/mstream.repo' || rel === 'rpm/repodata/repomd.xml.key') { return 'named'; }
  return 'immutable';
}

// Pure: what a publish does, from the three inventories.
//   local     [{ rel, size, sha256 }]            the built tree
//   remote    Map rel -> { size, checksum|null } the zone as listed
//   previous  Set of rel | null                  the last publish's file list
export function planSync(local, remote, previous) {
  const uploads = [];
  for (const file of local) {
    const kind = classify(file.rel);
    const there = remote.get(file.rel);
    // Bunny's listing documents no checksum field (it has carried one in
    // practice). Without it, a matching size settles it only for names
    // that pin their content; a fixed name is re-sent.
    const same = Boolean(there) && there.size === file.size
      && (there.checksum ? there.checksum === file.sha256 : kind === 'immutable');
    if (!same) { uploads.push({ ...file, kind }); }
  }
  const of = (kind) => uploads.filter((u) => u.kind === kind);
  const localSet = new Set(local.map((f) => f.rel));
  const stale = [...remote.keys()].filter((rel) => rel !== MANIFEST && !localSet.has(rel)).sort();
  return {
    early: [...of('immutable'), ...of('named')],
    index: of('index'),
    pointers: of('pointer').sort((a, b) => pointerRank(a.rel) - pointerRank(b.rel)),
    // A fixed name that changed, or any name that is being REPLACED: the
    // CDN may hold the old bytes under it.
    purge: uploads.filter((u) => u.kind !== 'immutable' || remote.has(u.rel)).map((u) => u.rel),
    // No record of a previous publish means no way to tell its files from
    // strangers: delete nothing.
    deletes: previous ? stale.filter((rel) => !previous.has(rel)) : [],
    retained: previous ? stale.filter((rel) => previous.has(rel)) : stale,
  };
}

const sha256Upper = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function readTree(root) {
  const files = [];
  async function walk(dir, prefix) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name);
      const rel = prefix + entry.name;
      if (entry.isDirectory()) { await walk(abs, `${rel}/`); continue; }
      const { size } = await stat(abs);
      files.push({ rel, abs, size, sha256: sha256Upper(await readFile(abs)) });
    }
  }
  await walk(root, '');
  return files;
}

// Run fn over items, a few at a time; the first failure stops new work and
// is the one reported.
async function pooled(items, width, fn) {
  const queue = items.slice();
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (!failure && queue.length) {
      try { await fn(queue.shift()); } catch (err) { failure = failure || err; }
    }
  }));
  if (failure) { throw failure; }
}

function client({ storageBase, zone, password, apiBase, apiKey, repoUrl, retryDelayMs, timeoutMs }) {
  const encode = (rel) => rel.split('/').map(encodeURIComponent).join('/');
  const storageUrl = (rel) => `${storageBase}/${encodeURIComponent(zone)}/${encode(rel)}`;

  async function once(method, url, { headers, body, accept }) {
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = new Error(`${method} ${url}: ${err.cause?.code || err.cause?.message || err.message}`);
      e.retryable = true;
      throw e;
    }
    if (accept.includes(res.status)) { return res; }
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const hint = res.status === 401
      ? ' (check the storage zone name, its password, and that BUNNY_STORAGE_HOST is the zone\'s own region)'
      : '';
    const e = new Error(`${method} ${url} -> HTTP ${res.status}${text ? `: ${text}` : ''}${hint}`);
    // 429 and 5xx are the server's trouble; anything else is ours and a
    // retry would only repeat it.
    e.retryable = res.status === 429 || res.status >= 500;
    throw e;
  }

  async function http(method, url, options) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(method, url, options);
      } catch (err) {
        if (!err.retryable || attempt === 4) { throw err; }
        await sleep(retryDelayMs * 3 ** (attempt - 1));
      }
    }
  }

  const auth = { AccessKey: password };

  async function listAll() {
    const found = new Map();
    const dirs = [''];
    while (dirs.length) {
      const dir = dirs.shift();
      // A directory that does not exist yet is simply empty.
      const res = await http('GET', storageUrl(dir), { headers: { ...auth, Accept: 'application/json' }, accept: [200, 404] });
      const entries = res.status === 404 ? [] : await res.json();
      if (!Array.isArray(entries)) { throw new Error(`listing /${dir} did not return a list`); }
      for (const entry of entries) {
        // The asked-for directory plus ObjectName - never the entry's own
        // Path, which is prefixed with the zone name.
        const rel = dir + entry.ObjectName;
        if (entry.IsDirectory) { dirs.push(`${rel}/`); continue; }
        found.set(rel, {
          size: entry.Length,
          checksum: typeof entry.Checksum === 'string' && entry.Checksum ? entry.Checksum.toUpperCase() : null,
        });
      }
    }
    return found;
  }

  // A Buffer, not a stream: fetch then sends Content-Length rather than
  // chunked encoding, which is how the documented upload (curl
  // --upload-file) arrives. The Checksum header has Bunny refuse a body
  // that did not arrive intact.
  async function put(rel, body) {
    await http('PUT', storageUrl(rel), {
      headers: { ...auth, Checksum: sha256Upper(body), 'Content-Type': 'application/octet-stream' },
      body,
      accept: [200, 201],
    });
  }

  return {
    listAll,
    put,
    async remove(rel) {
      await http('DELETE', storageUrl(rel), { headers: auth, accept: [200, 404] });
    },
    async readManifest() {
      const res = await http('GET', storageUrl(MANIFEST), { headers: auth, accept: [200, 404] });
      if (res.status === 404) { return null; }
      try {
        const files = JSON.parse(await res.text()).files;
        return Array.isArray(files) ? new Set(files) : null;
      } catch {
        // Unreadable is the same as absent: nothing gets deleted this run,
        // and this run writes a good one.
        return null;
      }
    },
    async purge(rel) {
      const target = encodeURIComponent(`${repoUrl}/${rel}`);
      await http('POST', `${apiBase}/purge?url=${target}&async=false`, { headers: { AccessKey: apiKey }, accept: [200] });
    },
  };
}

export async function sync({
  dir, zone, password, storageBase = 'https://storage.bunnycdn.com',
  apiKey = '', apiBase = 'https://api.bunny.net', repoUrl = '',
  dryRun = false, log = console.log, retryDelayMs = 1000, timeoutMs = 15 * 60 * 1000,
}) {
  if (!zone || !password) { throw new Error('the storage zone name and its password are required'); }
  if (apiKey && !repoUrl) { throw new Error('REPO_URL is required with BUNNY_API_KEY: the purge names public URLs'); }
  repoUrl = repoUrl.replace(/\/+$/, '');

  const local = await readTree(dir);
  const localRels = new Set(local.map((f) => f.rel));
  for (const need of REQUIRED) {
    if (!localRels.has(need)) { throw new Error(`${dir} is not a built repository: no ${need}`); }
  }

  const api = client({ storageBase: storageBase.replace(/\/+$/, ''), zone, password, apiBase, apiKey, repoUrl, retryDelayMs, timeoutMs });
  const remote = await api.listAll();
  const previous = await api.readManifest();
  const plan = planSync(local, remote, previous);

  const uploads = [...plan.early, ...plan.index, ...plan.pointers];
  log(`zone holds ${remote.size} file(s); tree has ${local.length}: ${uploads.length} to upload `
    + `(${human(uploads.reduce((n, u) => n + u.size, 0))}), ${plan.deletes.length} to delete, `
    + `${plan.retained.length} kept from the previous publish`);
  if (!previous && remote.size) {
    log('no record of a previous publish in the zone: nothing is deleted this run');
  }
  if (!apiKey) {
    log('no BUNNY_API_KEY: the CDN cache is not purged - the pull zone must not cache the fixed-name files');
  }

  if (dryRun) {
    for (const u of uploads) { log(`would upload  ${u.rel} (${human(u.size)})`); }
    if (apiKey) { for (const rel of plan.purge) { log(`would purge   ${repoUrl}/${rel}`); } }
    for (const rel of plan.deletes) { log(`would delete  ${rel}`); }
    log('dry run: nothing was changed');
    return { plan, dryRun: true };
  }

  const upload = async (file) => {
    const body = await readFile(file.abs);
    if (sha256Upper(body) !== file.sha256) { throw new Error(`${file.rel} changed on disk during the sync`); }
    await api.put(file.rel, body);
    log(`uploaded ${file.rel} (${human(file.size)})`);
  };

  // 1 + 2: nothing a client reads through the pointers changes yet.
  await pooled(plan.early, 3, upload);
  for (const file of plan.index) { await upload(file); }

  // 3: the pointers move only once everything they name is confirmed in
  // the zone. The listing is re-read a few times before giving up on a
  // file, in case it lags the write.
  const expected = local.filter((f) => classify(f.rel) !== 'pointer');
  let missing = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const now = await api.listAll();
    missing = expected.filter((f) => {
      const there = now.get(f.rel);
      return !there || there.size !== f.size || (there.checksum && there.checksum !== f.sha256);
    });
    if (!missing.length) { break; }
    if (attempt < 3) { await sleep(retryDelayMs * 3); }
  }
  if (missing.length) {
    throw new Error(`the zone does not hold what was uploaded (${missing.slice(0, 5).map((f) => f.rel).join(', ')}`
      + `${missing.length > 5 ? ', ...' : ''}); the live repository was left on its previous version`);
  }
  for (const file of plan.pointers) { await upload(file); }

  // 4
  if (apiKey) {
    for (const rel of plan.purge) { await api.purge(rel); }
    log(`purged ${plan.purge.length} CDN path(s)`);
  }

  // 5
  for (const rel of plan.deletes) {
    await api.remove(rel);
    log(`deleted ${rel}`);
  }
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, publishedAt: new Date().toISOString(), files: [...localRels].sort() }, null, 1)}\n`);
  await api.put(MANIFEST, manifest);
  log('published');
  return { plan, dryRun: false };
}

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const [dir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--dry-run');
  if (!dir || unknown.length) {
    throw new Error('usage: sync-bunny.mjs <tree-dir> [--dry-run]');
  }
  const env = process.env;
  const host = env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';
  await sync({
    dir: resolve(dir),
    zone: env.BUNNY_STORAGE_ZONE,
    password: env.BUNNY_STORAGE_PASSWORD,
    storageBase: /^https?:\/\//.test(host) ? host : `https://${host}`,
    apiKey: env.BUNNY_API_KEY || '',
    repoUrl: env.REPO_URL || '',
    dryRun: flags.includes('--dry-run'),
    log: (line) => console.log(`linux-repo sync: ${line}`),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`linux-repo sync: ${err.message}`);
    process.exit(1);
  });
}
