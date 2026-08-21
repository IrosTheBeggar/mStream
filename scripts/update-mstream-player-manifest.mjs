// Regenerate bin/mstream-player/manifest.json from a published
// mstream-terminal-player release — the whole "new player release" ritual on
// the mStream side is running this and opening the small text PR it produces.
//
// Usage:
//   node scripts/update-mstream-player-manifest.mjs <tag> [owner/repo]
//   e.g. node scripts/update-mstream-player-manifest.mjs v0.3.0
//
// The player repo's release CI publishes a complete manifest.json asset
// ({name, version, apiVersion, assets:[{file, sha256}]}) covering binaries
// AND packaging extras (deb/rpm/web). This script keeps only the bare
// platform binaries, then DOWNLOADS each one to verify its sha256 against
// the release manifest and to measure its byte size (the release manifest
// carries no sizes; the committed pin does, so the bundler and the runtime
// fetch can cap and cross-check downloads). Nothing is pinned unverified.
//
// The release must be PUBLISHED — draft assets have no public URLs, which is
// also why this can't point at an unreviewed draft by accident.
//
// MSTREAM_PLAYER_BASE swaps the download base too (same override the
// server's fetch honors) — for air-gapped mirrors and the smoke tests.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = 'IrosTheBeggar/mstream-terminal-player';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;
// The bare platform binaries; deliberately excludes the release's deb/rpm/web
// extras, which mStream neither stages nor fetches.
const BINARY_RE = /^mstream-player-(darwin|linux|win32)-[a-z0-9]+(\.exe)?$/;

const [tag, repo = DEFAULT_REPO] = process.argv.slice(2);
if (!tag || !TOKEN_RE.test(tag)) {
  console.error('usage: node scripts/update-mstream-player-manifest.mjs <tag> [owner/repo]');
  process.exit(1);
}
if (!REPO_RE.test(repo)) {
  console.error(`bad repo '${repo}' (want owner/name)`);
  process.exit(1);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mstream-player');
const base = (process.env.MSTREAM_PLAYER_BASE || '').replace(/\/+$/, '');
const assetUrl = (name) => (base
  ? `${base}/${name}`
  : `https://github.com/${repo}/releases/download/${tag}/${name}`);

async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url} — is the release published?`);
  }
  return res;
}

// Best-effort provenance for the reviewer: the commit the tag points at.
async function resolveBuiltFrom() {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${tag}`, {
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'follow',
    });
    if (!res.ok) { return null; }
    const body = await res.json();
    return /^[0-9a-f]{40}$/.test(body.sha || '') ? body.sha : null;
  } catch (_err) {
    return null;
  }
}

try {
  const release = await (await fetchOk(assetUrl('manifest.json'))).json();
  if (release.name !== 'mstream-player' || release.apiVersion !== 1) {
    throw new Error(`unexpected release manifest (name=${release.name}, apiVersion=${release.apiVersion})`);
  }
  const binaries = (release.assets || []).filter((a) => BINARY_RE.test(a.file || ''));
  if (binaries.length === 0) { throw new Error('no platform binaries in the release manifest'); }

  const assets = {};
  for (const a of binaries) {
    if (!/^[0-9a-f]{64}$/.test(a.sha256 || '')) { throw new Error(`malformed sha256 for ${a.file}`); }
    process.stdout.write(`verifying ${a.file}... `);
    const buf = Buffer.from(await (await fetchOk(assetUrl(a.file))).arrayBuffer());
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== a.sha256) {
      throw new Error(`sha256 mismatch for ${a.file}: release manifest says ${a.sha256}, asset hashes to ${actual}`);
    }
    assets[a.file] = { file: a.file, sha256: a.sha256, size: buf.length };
    console.log(`ok (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  const manifest = {
    family: 'mstream-player',
    schema: 2,
    repo,
    tag,
    // Provenance for the reviewer: the commit the tag points at, and the
    // release page the pins came from.
    builtFrom: await resolveBuiltFrom(),
    release: `https://github.com/${repo}/releases/tag/${tag}`,
    assets,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out}`);
  console.log(`pinned ${repo}@${tag}: ${Object.keys(assets).length} platform binaries (all downloaded and hash-verified)`);
  console.log('review the diff and open the manifest-update PR.');
} catch (err) {
  console.error(`update failed: ${err.message}`);
  process.exit(1);
}
