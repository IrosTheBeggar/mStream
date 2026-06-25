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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// `bun:` is the Bun --compile target. Bun's default x64 build requires AVX2
// (~2013+ CPUs) and aborts with "illegal instruction" on older/virtualized hosts
// that lack it — a bad failure for a self-hosted server, so x64 should use the
// `-baseline` variant where we can.
//   - linux-x64: baseline ✓ (built on ubuntu, where the cross-runtime extracts
//     fine).
//   - win-x64: stays on the DEFAULT (AVX2-required). Building the baseline
//     variant on the Windows runner makes Bun download a baseline cross-runtime
//     that consistently fails to extract there ("Failed to extract executable
//     ... download may be incomplete"), and building Windows on Windows is what
//     lets us embed the .exe icon. Getting Windows baseline would mean
//     cross-building from Linux (losing the native icon/smoke) or pre-fetching
//     the runtime via --compile-executable-path — deferred.
//   - arm64 has no AVX2 concern (no baseline variant); Intel Macs are all
//     AVX2-capable, so darwin-x64 stays on the default.
//   - linux-{x64,arm64}-musl: standalone musl builds for Alpine/musl hosts (the
//     glibc binaries above can't exec on musl). No -musl-baseline variant exists,
//     so the musl x64 build requires AVX2.
const TARGETS = {
  'win-x64':          { bun: 'bun-windows-x64',        out: 'mStream.exe',              win: true, plat: 'win32',  arch: 'x64',   ext: '.exe' },
  'linux-x64':        { bun: 'bun-linux-x64-baseline', out: 'mStream-linux-x64',        plat: 'linux',  arch: 'x64',   ext: '' },
  'linux-arm64':      { bun: 'bun-linux-arm64',        out: 'mStream-linux-arm64',      plat: 'linux',  arch: 'arm64', ext: '' },
  'linux-x64-musl':   { bun: 'bun-linux-x64-musl',     out: 'mStream-linux-x64-musl',   plat: 'linux',  arch: 'x64',   ext: '', musl: true },
  'linux-arm64-musl': { bun: 'bun-linux-arm64-musl',   out: 'mStream-linux-arm64-musl', plat: 'linux',  arch: 'arm64', ext: '', musl: true },
  'darwin-x64':       { bun: 'bun-darwin-x64',         out: 'mStream-darwin-x64',       plat: 'darwin', arch: 'x64',   ext: '' },
  'darwin-arm64':     { bun: 'bun-darwin-arm64',       out: 'mStream-darwin-arm64',     plat: 'darwin', arch: 'arm64', ext: '' },
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
    '--windows-title=mStream Server',
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

// macOS gets a .app bundle so Finder/Dock show the icon; its assets (webapp/,
// bin/) live next to the binary inside Contents/MacOS so appRoot
// (= dirname(process.execPath)) still resolves them. It's a portable .app —
// run it in place (it writes its db/config next to the binary, like the bare
// builds). Other platforms stage flat in the bundle dir.
const isMac = t.plat === 'darwin';
const contentRoot = isMac ? join(stageDir, 'mStream.app', 'Contents', 'MacOS') : stageDir;
mkdirSync(contentRoot, { recursive: true });

stageExe(join(root, outPath), join(contentRoot, isMac ? 'mStream' : t.out));     // the server binary
cpSync(join(root, 'webapp'), join(contentRoot, 'webapp'), { recursive: true });  // the UI

// External binaries the server spawns, arch- and libc-specific. A musl bundle
// stages the -musl sidecar variants (the primary parser on Alpine). A glibc
// bundle stages the glibc variants AND additionally the static -musl rust-parser
// as a universal fallback — it's fully static and runs on ANY libc, and the
// scanner self-heals to it when the shipped glibc parser is too new for an older
// host glibc (needs GLIBC_2.34; see tryMuslRetry() in src/db/task-queue.js),
// keeping native-speed scanning on older-glibc distros (RHEL/Rocky 8, Ubuntu
// 20.04, Amazon Linux 2, Debian 11) instead of the ~16x-slower JS fallback.
// rust-server-audio has no musl build, so musl bundles ship without it
// (server-audio is opt-in). Each entry is skipped gracefully if not committed.
const libc = t.musl ? '-musl' : '';
const sidecars = [
  ['rust-parser',       `rust-parser-${t.plat}-${t.arch}${libc}${t.ext}`],
  ['rust-server-audio', `rust-server-audio-${t.plat}-${t.arch}${libc}${t.ext}`],
];
if (t.plat === 'linux' && !t.musl) {
  sidecars.push(['rust-parser', `rust-parser-${t.plat}-${t.arch}-musl`]);
}
for (const [dir, file] of sidecars) {
  const src = join(root, 'bin', dir, file);
  if (existsSync(src)) {
    mkdirSync(join(contentRoot, 'bin', dir), { recursive: true });
    stageExe(src, join(contentRoot, 'bin', dir, file));
  } else {
    console.warn(`  sidecar not found, skipping: bin/${dir}/${file}`);
  }
}

// App icon. Windows embeds it in the .exe at compile time (--windows-icon
// above). macOS and Linux can't embed an icon in a bare binary, so we package
// one the platform-native way: a .app bundle (macOS) or a .desktop + PNG (Linux).
if (isMac) {
  const resDir = join(stageDir, 'mStream.app', 'Contents', 'Resources');
  mkdirSync(resDir, { recursive: true });
  cpSync(join(root, 'build', 'mstream-logo-cut.icns'), join(resDir, 'mStream.icns'));
  writeFileSync(join(stageDir, 'mStream.app', 'Contents', 'Info.plist'), macInfoPlist(pkg.version));
} else if (t.plat === 'linux') {
  cpSync(join(root, 'build', 'icon.png'), join(stageDir, 'mStream.png'));
  writeFileSync(join(stageDir, 'mStream.desktop'), linuxDesktopEntry(t.out));
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

// macOS .app Info.plist — points CFBundleIconFile at the staged mStream.icns
// and CFBundleExecutable at the inner binary.
function macInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>mStream</string>
  <key>CFBundleDisplayName</key><string>mStream Server</string>
  <key>CFBundleIdentifier</key><string>io.mstream.server</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>mStream</string>
  <key>CFBundleIconFile</key><string>mStream.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`;
}

// Linux .desktop launcher: a bare ELF can't carry an icon, so this is how the
// PNG shows up in an app menu. Exec/Icon need absolute paths once installed —
// replace %INSTALL_DIR% with the extract location (or use desktop-file-install).
function linuxDesktopEntry(binName) {
  return `[Desktop Entry]
Type=Application
Name=mStream
Comment=Self-hosted music streaming server
Exec=%INSTALL_DIR%/${binName}
Icon=%INSTALL_DIR%/mStream.png
Terminal=true
Categories=AudioVideo;Audio;Network;
`;
}
