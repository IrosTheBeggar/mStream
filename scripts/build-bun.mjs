// Build (and optionally bundle) the mStream server as a Bun standalone binary.
//
// Usage: bun scripts/build-bun.mjs [--target=<key>] [--bundle]
//   key: win-x64 (default on Windows) | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
//        (no --target = build for the host platform)
//   --bundle: after building, stage webapp/ + the platform's bin/ sidecars next
//             to the binary and produce a dist/<name>.tar.gz release archive.
//
// Windows icon + metadata flags are only applied for a win-x64 build running ON
// Windows — Bun can't set them when cross-compiling (they depend on Win APIs).
// Name/version/etc. are read from package.json so they never drift.
import { readFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const TARGETS = {
  'win-x64':      { bun: 'bun-windows-x64',  out: 'mStream.exe',          win: true, plat: 'win32',  arch: 'x64',   ext: '.exe', syncthing: 'syncthing.exe' },
  'linux-x64':    { bun: 'bun-linux-x64',    out: 'mStream-linux-x64',    plat: 'linux',  arch: 'x64',   ext: '', syncthing: 'syncthing-linux' },
  'linux-arm64':  { bun: 'bun-linux-arm64',  out: 'mStream-linux-arm64',  plat: 'linux',  arch: 'arm64', ext: '', syncthing: 'syncthing-linux' },
  'darwin-x64':   { bun: 'bun-darwin-x64',   out: 'mStream-darwin-x64',   plat: 'darwin', arch: 'x64',   ext: '', syncthing: 'syncthing-osx' },
  'darwin-arm64': { bun: 'bun-darwin-arm64', out: 'mStream-darwin-arm64', plat: 'darwin', arch: 'arm64', ext: '', syncthing: 'syncthing-osx' },
};

function hostKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') { return 'win-x64'; }
  if (process.platform === 'darwin') { return `darwin-${arch}`; }
  return `linux-${arch}`;
}

const argv = process.argv.slice(2);
const targetArg = argv.find((a) => a.startsWith('--target='));
const doBundle = argv.includes('--bundle');
const key = targetArg ? targetArg.split('=')[1] : hostKey();
const t = TARGETS[key];
if (!t) {
  console.error(`Unknown target '${key}'. Valid: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const outPath = join('dist', t.out);
const winVersion = `${pkg.version}.0.0.0`.split('.').slice(0, 4).join('.');

const buildArgs = ['build', '--compile', `--target=${t.bun}`];
if (t.win && process.platform === 'win32') {
  buildArgs.push(
    '--windows-icon=build/mstream-logo-cut.ico',
    `--windows-title=${pkg.build?.productName ?? pkg.name}`,
    `--windows-publisher=${pkg.author?.name ?? ''}`,
    `--windows-version=${winVersion}`,
    `--windows-description=${pkg.description ?? ''}`,
    `--windows-copyright=${pkg.author?.name ?? ''} (${pkg.license ?? ''})`,
  );
} else if (t.win) {
  console.warn('NOTE: building for Windows from a non-Windows host - icon/metadata skipped (Bun limitation).');
}
buildArgs.push('bun-entry.js', '--outfile', outPath);

console.log(`Building ${key} (${t.bun}) -> ${outPath}`);
// process.execPath is the bun executable when run via `bun ...`, so this is
// `bun build ...` with no shell-quoting concerns.
const build = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: 'inherit' });
if (build.status !== 0) { process.exit(build.status ?? 1); }

if (!doBundle) { process.exit(0); }

// ── Bundle: stage binary + webapp/ + the platform's bin/ sidecars, then tar.gz.
// A bare binary isn't runnable (the UI ships loose, sidecars are spawned), so a
// release is a folder, not a single file — same shape Electron shipped.
const bundleName = `mStream-${pkg.version}-${key}`;
const stageRoot = join(root, 'dist', 'stage');
const stageDir = join(stageRoot, bundleName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(join(root, outPath), join(stageDir, t.out));                       // the server binary
cpSync(join(root, 'webapp'), join(stageDir, 'webapp'), { recursive: true }); // the UI

// Per-platform external binaries the server spawns. Copy each if present; the
// arch-specific ones (rust-parser, rust-server-audio) or a missing syncthing
// arch are skipped gracefully — the scanner has a JS fallback and the rest are
// optional features.
const sidecars = [
  ['rust-parser',       `rust-parser-${t.plat}-${t.arch}${t.ext}`],
  ['rust-server-audio', `rust-server-audio-${t.plat}-${t.arch}${t.ext}`],
  ['syncthing',         t.syncthing],
];
for (const [dir, file] of sidecars) {
  const src = join(root, 'bin', dir, file);
  if (existsSync(src)) {
    mkdirSync(join(stageDir, 'bin', dir), { recursive: true });
    cpSync(src, join(stageDir, 'bin', dir, file));
  } else {
    console.warn(`  sidecar not found, skipping: bin/${dir}/${file}`);
  }
}

const archivePath = join(root, 'dist', `${bundleName}.tar.gz`);
rmSync(archivePath, { force: true });
console.log(`Bundling -> dist/${bundleName}.tar.gz`);
// tar ships on all CI runners and Windows 10+; -czf preserves unix exec bits on
// native (per-OS) runners, which is where releases are built.
const tar = spawnSync('tar', ['-czf', archivePath, '-C', stageRoot, bundleName], { stdio: 'inherit' });
if (tar.status !== 0) { console.error('tar failed'); process.exit(tar.status ?? 1); }
console.log(`Done: dist/${bundleName}.tar.gz`);
