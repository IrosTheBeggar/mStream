// Regenerate bin/p2p-sidecar/manifest.json + manifest-musl.json from a
// published mstream-p2p-sidecar release — the whole "new sidecar release"
// ritual on the mStream side is running this and opening the small text PR
// it produces (docs/p2p-sidecar-distribution.md documents the flow).
//
// Usage:
//   node scripts/update-p2p-sidecar-manifest.mjs <tag> [owner/repo]
//   e.g. node scripts/update-p2p-sidecar-manifest.mjs v1.0.1
//
// Reads the release's manifest-fragment.json / manifest-fragment-musl.json
// assets (uploaded by the sidecar repo's CI as each family's completion
// marker), sanity-checks them, and writes the two committed manifests. The
// release must be PUBLISHED — draft assets have no public URLs, which is
// also why this can't point at an unreviewed draft by accident.
//
// MSTREAM_SIDECAR_BASE swaps the fragment URL base too (same override the
// server's fetch honors) — for air-gapped mirrors and the smoke tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = 'IrosTheBeggar/mstream-p2p-sidecar';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;

const [tag, repo = DEFAULT_REPO] = process.argv.slice(2);
if (!tag || !TOKEN_RE.test(tag)) {
  console.error('usage: node scripts/update-p2p-sidecar-manifest.mjs <tag> [owner/repo]');
  process.exit(1);
}
if (!REPO_RE.test(repo)) {
  console.error(`bad repo '${repo}' (want owner/name)`);
  process.exit(1);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'p2p-sidecar');

async function fetchFragment(name) {
  const base = (process.env.MSTREAM_SIDECAR_BASE || '').replace(/\/+$/, '');
  const url = base
    ? `${base}/${name}`
    : `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url} — is the release published, with its ${name} uploaded?`);
  }
  return res.json();
}

function validateFragment(frag, name) {
  if (frag.family !== 'p2p-sidecar' || frag.schema !== 2 || frag.tag !== tag) {
    throw new Error(`${name}: unexpected family/schema/tag (${frag.family}/${frag.schema}/${frag.tag})`);
  }
  const keys = Object.keys(frag.assets || {});
  if (keys.length === 0) { throw new Error(`${name}: no assets`); }
  for (const [key, a] of Object.entries(frag.assets)) {
    if (!TOKEN_RE.test(key) || a.file !== key || !/^[0-9a-f]{64}$/.test(a.sha256 || '')
        || !Number.isInteger(a.size) || a.size <= 0) {
      throw new Error(`${name}: malformed entry for ${key}`);
    }
  }
  return keys;
}

function writeManifest(fileName, frag) {
  const manifest = {
    family: 'p2p-sidecar',
    schema: 2,
    repo,
    tag,
    // Provenance carried over from the fragment for the reviewer's benefit.
    builtFrom: frag.builtFrom,
    workflowRun: frag.workflowRun,
    assets: frag.assets,
  };
  const out = path.join(outDir, fileName);
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

try {
  const [glibc, musl] = await Promise.all([
    fetchFragment('manifest-fragment.json'),
    fetchFragment('manifest-fragment-musl.json'),
  ]);
  const gKeys = validateFragment(glibc, 'manifest-fragment.json');
  const mKeys = validateFragment(musl, 'manifest-fragment-musl.json');
  writeManifest('manifest.json', glibc);
  writeManifest('manifest-musl.json', musl);
  console.log(`pinned ${repo}@${tag}: ${gKeys.length} glibc/darwin/win + ${mKeys.length} musl assets`);
  console.log('review the diff and open the manifest-update PR.');
} catch (err) {
  console.error(`update failed: ${err.message}`);
  process.exit(1);
}
