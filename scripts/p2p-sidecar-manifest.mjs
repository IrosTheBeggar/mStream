// Build the p2p-sidecar release manifest + immutable-named asset copies for
// ONE binary family (the glibc/darwin/win set, or the musl set) — invoked by
// .github/workflows/build-p2p-sidecar{,-musl}.yml's publish job, and by the
// local workflow simulation.
//
// The asset NAME is the provenance: <key>-<tree12>-<sha8>[.exe] embeds the
// p2p-sidecar/ source-tree hash the binary was built from and the first 8
// hex of its own sha256. Two assets can only share a name by sharing both,
// so "skip upload if the name already exists on the release" is exact
// dedupe, nothing is ever replaced in place, and a manifest committed at ANY
// point in history keeps resolving to exactly the bytes it pins.
//
// Usage:
//   node scripts/p2p-sidecar-manifest.mjs \
//     --tag p2p-sidecar-assets --repo owner/repo --tree <40-hex> \
//     --version <cargo version> --built-from <sha> --run-url <url> \
//     --staging <dir> --assets-dir <dir> --out <file> \
//     <binary-name>...
//
// Reads each <binary-name> from --staging, writes the renamed copy into
// --assets-dir, and the manifest JSON document to --out. Exits non-zero on
// any missing/empty input — the caller treats that as "this run did not
// produce a full set" (same contract as the old commit job's inventory).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opts = {};
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { opts[args[i].slice(2)] = args[++i]; } else { names.push(args[i]); }
}

const required = ['tag', 'repo', 'tree', 'version', 'built-from', 'run-url', 'staging', 'assets-dir', 'out'];
for (const k of required) {
  if (!opts[k]) { console.error(`p2p-sidecar-manifest: missing --${k}`); process.exit(1); }
}
if (!/^[0-9a-f]{40}$/.test(opts.tree)) {
  console.error(`p2p-sidecar-manifest: --tree must be a 40-hex git tree hash, got '${opts.tree}'`);
  process.exit(1);
}
if (names.length === 0) {
  console.error('p2p-sidecar-manifest: no binary names given');
  process.exit(1);
}

const tree12 = opts.tree.slice(0, 12);
fs.mkdirSync(opts['assets-dir'], { recursive: true });

const assets = {};
for (const name of names) {
  const src = path.join(opts.staging, name);
  let buf;
  try {
    buf = fs.readFileSync(src);
  } catch (err) {
    console.error(`p2p-sidecar-manifest: cannot read ${src}: ${err.message}`);
    process.exit(1);
  }
  if (buf.length === 0) {
    console.error(`p2p-sidecar-manifest: ${src} is empty`);
    process.exit(1);
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const stem = name.endsWith('.exe') ? name.slice(0, -4) : name;
  const ext = name.endsWith('.exe') ? '.exe' : '';
  const file = `${stem}-${tree12}-${sha256.slice(0, 8)}${ext}`;
  fs.copyFileSync(src, path.join(opts['assets-dir'], file));
  assets[name] = {
    file,
    sha256,
    size: buf.length,
    url: `https://github.com/${opts.repo}/releases/download/${opts.tag}/${file}`,
  };
}

const manifest = {
  family: 'p2p-sidecar',
  schema: 1,
  sourceTree: opts.tree,
  version: opts.version,
  builtFrom: opts['built-from'],
  workflowRun: opts['run-url'],
  assets,
};
fs.writeFileSync(opts.out, JSON.stringify(manifest, null, 2) + '\n');

console.log(`manifest pins ${names.length} assets (source tree ${tree12}):`);
for (const [key, a] of Object.entries(assets)) {
  console.log(`  ${key} -> ${a.file} (${a.size} bytes)`);
}
