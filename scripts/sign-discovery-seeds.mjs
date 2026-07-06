#!/usr/bin/env node
// Sign seeds/discovery-seeds.json with the maintainer's offline seed-list
// key. Rotating a seed is now: edit the file → run this → commit.
//
//   node scripts/sign-discovery-seeds.mjs --key C:/path/to/key.pem
//   MSTREAM_SEEDS_SIGNING_KEY=C:/path/to/key.pem node scripts/sign-discovery-seeds.mjs
//
// The seq counter auto-bumps on every signing (that's the rollback
// protection — clients reject a fetched list older than their cached one).
// --keep-seq re-signs without bumping, for the rare "re-sign identical
// content" case. The script self-verifies against the PUBLIC key baked into
// src/state/discovery-seeds-verify.js, so signing with the wrong key file
// fails here instead of silently breaking every client's fetch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signSeedList, verifySeedList } from '../src/state/discovery-seeds-verify.js';

const listPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seeds', 'discovery-seeds.json');

let keyPath = process.env.MSTREAM_SEEDS_SIGNING_KEY || null;
let keepSeq = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--key') { keyPath = args[++i]; }
  else if (args[i] === '--keep-seq') { keepSeq = true; }
  else { console.error(`unknown option: ${args[i]}`); process.exit(1); }
}
if (!keyPath) {
  console.error('no signing key: pass --key <pem-file> or set MSTREAM_SEEDS_SIGNING_KEY');
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const doc = JSON.parse(fs.readFileSync(listPath, 'utf8'));

if (!keepSeq) { doc.seq = (Number.isInteger(doc.seq) ? doc.seq : 0) + 1; }
doc.updated = new Date().toISOString().slice(0, 10);

const signed = signSeedList(doc, privateKeyPem);

// Self-check against the baked public key BEFORE writing anything. If the
// env test-override is set it would verify against the wrong root — refuse.
if (process.env.MSTREAM_TEST_SEEDS_PUBKEY) {
  console.error('refusing to sign with MSTREAM_TEST_SEEDS_PUBKEY set (would self-verify against the test key)');
  process.exit(1);
}
verifySeedList(signed);

// Stable field order so diffs stay reviewable.
const out = {
  version: signed.version,
  updated: signed.updated,
  _readme: signed._readme,
  seq: signed.seq,
  seeds: signed.seeds,
  signature: signed.signature,
};
fs.writeFileSync(listPath, JSON.stringify(out, null, 2) + '\n');
console.log(`signed ${path.relative(process.cwd(), listPath)}: seq ${signed.seq}, ${signed.seeds.length} seed(s)`);
console.log('self-verified against the baked public key — commit the file.');
