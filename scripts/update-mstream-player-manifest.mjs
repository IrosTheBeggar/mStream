// Regenerate bin/mstream-player/manifest.json from a published
// mstream-terminal-player release — the whole "new player release" ritual on
// the mStream side is running this and opening the small text PR it produces.
//
// Usage:
//   node scripts/update-mstream-player-manifest.mjs <tag> [owner/repo] [--allow-prerelease] [--out <file>]
//   e.g. node scripts/update-mstream-player-manifest.mjs v0.3.0
//
//   --allow-prerelease  pin a pre-release anyway (see below); never for a
//                       manifest that is going to be committed
//   --out <file>        write the manifest there instead of
//                       bin/mstream-player/manifest.json (dry runs, diffs)
//
// The player repo's release CI publishes a complete manifest.json asset
// ({name, version, apiVersion, assets:[{file, sha256}]}) covering binaries
// AND packaging extras (deb/rpm/web, the desktop .app.zip/.zip/.tar.gz).
// This script keeps only the bare platform binaries — BOTH families, the
// terminal mstream-player-<plat>-<arch>[.exe] and the desktop
// mstream-player-desktop-<plat>-<arch>[.exe], each under its own file-name
// key (scripts/mstream-player-asset.mjs; bundles stage the desktop one, the
// runtime fetch reads the terminal one) — then DOWNLOADS each one to verify
// its sha256 against the release manifest and to measure its byte size (the
// release manifest carries no sizes; the committed pin does, so the bundler
// and the runtime fetch can cap and cross-check downloads). Nothing is
// pinned unverified.
//
// The release must be PUBLISHED — draft assets have no public URLs, which is
// also why this can't point at an unreviewed draft by accident. It must also
// not be a PRE-RELEASE: a tag carrying a '-' (v0.10.0-rc.1) or a release
// GitHub marks prerelease: true is refused with one line and a non-zero exit
// unless --allow-prerelease is given. (The tag is checked before anything is
// fetched; the GitHub flag is best effort — when the API can't be read, the
// tag name alone decides.)
//
// MSTREAM_PLAYER_BASE swaps the download base too (same override the
// server's fetch honors) — for air-gapped mirrors and the smoke tests.
// MSTREAM_PLAYER_API swaps the GitHub API base (default
// https://api.github.com) for the hermetic tests.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BINARY_RE, assetFamily, prereleaseReason } from './mstream-player-asset.mjs';

const DEFAULT_REPO = 'IrosTheBeggar/mstream-terminal-player';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const USAGE = 'usage: node scripts/update-mstream-player-manifest.mjs <tag> [owner/repo] [--allow-prerelease] [--out <file>]';

const positional = [];
let allowPrerelease = false;
let outFile = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-prerelease') { allowPrerelease = true; }
    else if (a === '--out') {
      // The value is the next word, never another option: `--out --flag`
      // would otherwise write a file called "--flag".
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { console.error(`--out needs a file\n${USAGE}`); process.exit(1); }
      outFile = argv[++i];
    }
    else if (a.startsWith('--out=')) { outFile = a.slice('--out='.length); }
    else if (a.startsWith('-')) { console.error(`unknown option '${a}'\n${USAGE}`); process.exit(1); }
    else { positional.push(a); }
  }
}
const [tag, repo = DEFAULT_REPO] = positional;
if (!tag || !TOKEN_RE.test(tag) || positional.length > 2 || outFile === '') {
  console.error(USAGE);
  process.exit(1);
}
if (!REPO_RE.test(repo)) {
  console.error(`bad repo '${repo}' (want owner/name)`);
  process.exit(1);
}
{
  const why = prereleaseReason(tag);
  if (why && !allowPrerelease) {
    console.error(`refusing to pin ${repo}@${tag}: ${why} — pass --allow-prerelease to pin it anyway`);
    process.exit(1);
  }
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mstream-player');
const base = (process.env.MSTREAM_PLAYER_BASE || '').replace(/\/+$/, '');
const apiBase = (process.env.MSTREAM_PLAYER_API || 'https://api.github.com').replace(/\/+$/, '');
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
    const res = await fetch(`${apiBase}/repos/${repo}/commits/${tag}`, {
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

// Best-effort: GitHub's release object, for its prerelease flag. null when
// it can't be read (offline mirror, rate limit) — the tag check above has
// already run, so a missing answer never blocks a plain release.
async function fetchReleaseObject() {
  try {
    const res = await fetch(`${apiBase}/repos/${repo}/releases/tags/${tag}`, {
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'follow',
    });
    if (!res.ok) { return null; }
    return await res.json();
  } catch (_err) {
    return null;
  }
}

try {
  const why = prereleaseReason(tag, await fetchReleaseObject());
  if (why) {
    if (!allowPrerelease) {
      console.error(`refusing to pin ${repo}@${tag}: ${why} — pass --allow-prerelease to pin it anyway`);
      process.exit(1);
    }
    console.warn(`WARNING: pinning a pre-release (--allow-prerelease): ${why}`);
  }
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
  const out = outFile ? path.resolve(outFile) : path.join(outDir, 'manifest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out}`);
  const desktop = Object.keys(assets).filter((k) => assetFamily(k) === 'desktop').length;
  console.log(`pinned ${repo}@${tag}: ${Object.keys(assets).length} platform binaries (${Object.keys(assets).length - desktop} terminal, ${desktop} desktop; all downloaded and hash-verified)`);
  console.log('review the diff and open the manifest-update PR.');
} catch (err) {
  console.error(`update failed: ${err.message}`);
  process.exit(1);
}
