// Build (and optionally bundle) the mStream server as a Bun standalone binary.
//
// Usage: bun scripts/build-bun.mjs [--target=<key>] [--bundle]
//   key: win-x64 (default on Windows) | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
//        (no --target = build for the host platform)
//   --bundle: after building, stage webapp/ + the platform's bin/ sidecars next
//             to the binary and produce a dist/<name>.tar.gz release archive.
//
// Windows icon + metadata flags are only applied for a win-x64 build running ON
// Windows — Bun can't set them when cross-compiling. Name/version/etc. come from
// package.json so they never drift.
import { readFileSync, existsSync, rmSync, mkdirSync, cpSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// `syncthing` is the committed binary filename, or null where no matching-arch
// build is committed — we skip it rather than ship a wrong-arch binary.
const TARGETS = {
  'win-x64':      { bun: 'bun-windows-x64',  out: 'mStream.exe',          win: true, plat: 'win32',  arch: 'x64',   ext: '.exe', syncthing: 'syncthing.exe' },
  'linux-x64':    { bun: 'bun-linux-x64',    out: 'mStream-linux-x64',    plat: 'linux',  arch: 'x64',   ext: '', syncthing: 'syncthing-linux' },
  'linux-arm64':  { bun: 'bun-linux-arm64',  out: 'mStream-linux-arm64',  plat: 'linux',  arch: 'arm64', ext: '', syncthing: null },
  'darwin-x64':   { bun: 'bun-darwin-x64',   out: 'mStream-darwin-x64',   plat: 'darwin', arch: 'x64',   ext: '', syncthing: 'syncthing-osx' },
  'darwin-arm64': { bun: 'bun-darwin-arm64', out: 'mStream-darwin-arm64', plat: 'darwin', arch: 'arm64', ext: '', syncthing: null },
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
// --windows-version wants 4 numeric parts; strip any prerelease/build suffix.
const verParts = String(pkg.version).split('-')[0].split('.').map((n) => String(parseInt(n, 10) || 0));
while (verParts.length < 4) { verParts.push('0'); }
const winVersion = verParts.slice(0, 4).join('.');

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
buildArgs.push('cli-boot-wrapper.js', '--outfile', outPath);

console.log(`Building ${key} (${t.bun}) -> ${outPath}`);
const build = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: 'inherit' });
if (build.error) { console.error(build.error.message); }
if (build.status !== 0) { process.exit(build.status ?? 1); }

if (!doBundle) { process.exit(0); }

// ── Bundle: stage binary + webapp/ + the platform's bin/ sidecars, then tar.gz.
// A bare binary isn't runnable (the UI ships loose, sidecars are spawned), so a
// release is a folder, not a single file — same shape Electron shipped.
const isUnix = t.plat !== 'win32';
const bundleName = `mStream-${pkg.version}-${key}`;
const stageRoot = join(root, 'dist', 'stage');
const stageDir = join(stageRoot, bundleName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// Copy into the stage and, on unix targets, force the execute bit: committed
// sidecars (and a cross-built binary) can be mode 0644, and tar of a 0644 file
// ships a non-runnable binary. chmod here guarantees +x on a unix build host
// (the linux/macOS CI runners), regardless of the source mode.
function stageExe(src, dest) {
  cpSync(src, dest);
  if (isUnix) { try { chmodSync(dest, 0o755); } catch (_) { /* best-effort; no-op on Windows hosts */ } }
}

stageExe(join(root, outPath), join(stageDir, t.out));                          // the server binary
cpSync(join(root, 'webapp'), join(stageDir, 'webapp'), { recursive: true });   // the UI

// External binaries the server spawns, arch-specific. The Bun server binary
// itself is glibc-linked (bun-linux-x64), so the linux bundle is glibc-only and
// CANNOT run on musl/Alpine (the loader fails before anything starts) — that's
// why there's no musl rust-server-audio here, and no musl server target.
// BUT we DO ship the static -musl rust-parser on linux: it's a fully-static
// binary that runs on ANY libc, and the scanner self-heals to it when the
// shipped glibc rust-parser is too new for an older host glibc (needs
// GLIBC_2.34) — see tryMuslRetry() in src/db/task-queue.js. That keeps
// native-speed scanning + waveforms on older-glibc distros (RHEL/Rocky 8,
// Ubuntu 20.04, Amazon Linux 2, Debian 11) instead of the ~16x-slower JS
// fallback. Each entry is skipped gracefully if its binary isn't committed.
const sidecars = [
  ['rust-parser',       `rust-parser-${t.plat}-${t.arch}${t.ext}`],
  ['rust-server-audio', `rust-server-audio-${t.plat}-${t.arch}${t.ext}`],
];
if (t.plat === 'linux') {
  sidecars.push(['rust-parser', `rust-parser-${t.plat}-${t.arch}-musl`]);
}
if (t.syncthing) { sidecars.push(['syncthing', t.syncthing]); }
for (const [dir, file] of sidecars) {
  const src = join(root, 'bin', dir, file);
  if (existsSync(src)) {
    mkdirSync(join(stageDir, 'bin', dir), { recursive: true });
    stageExe(src, join(stageDir, 'bin', dir, file));
  } else {
    console.warn(`  sidecar not found, skipping: bin/${dir}/${file}`);
  }
}

const archivePath = join(root, 'dist', `${bundleName}.tar.gz`);
rmSync(archivePath, { force: true });
console.log(`Bundling -> dist/${bundleName}.tar.gz`);
// tar ships on all CI runners and Windows 10+; it preserves the staged file
// modes set above, so a glibc-mode-0644 sidecar still ships runnable.
const tar = spawnSync('tar', ['-czf', archivePath, '-C', stageRoot, bundleName], { stdio: 'inherit' });
if (tar.error) { console.error(tar.error.message); }
if (tar.status !== 0) { console.error('tar failed'); process.exit(tar.status ?? 1); }
console.log(`Done: dist/${bundleName}.tar.gz`);
