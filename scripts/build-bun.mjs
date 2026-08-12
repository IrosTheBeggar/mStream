// Build (and optionally bundle) the mStream server as a Bun standalone binary.
//
// Usage: bun scripts/build-bun.mjs [--target=<key>] [--bundle]
//   key: win-x64 (default on Windows) | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
//        (no --target = build for the host platform)
//   --bundle: after building, stage webapp/ + the platform's bin/ sidecars next
//             to the binary and produce a dist/<name>.zip release archive.
//
// Windows icon + metadata flags are only applied for a win-x64 build running ON
// Windows — Bun can't set them when cross-compiling. Name/version/etc. come from
// package.json so they never drift.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync, chmodSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
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
//   - win-x64: baseline ✓ via a PRE-FETCHED runtime. Building the baseline
//     variant on the Windows runner makes Bun's internal download of the baseline
//     cross-runtime fail to extract ("Failed to extract executable ... download
//     may be incomplete"), so CI downloads that runtime itself and passes it via
//     BUN_COMPILE_EXEC_PATH -> --compile-executable-path (see build-bun.yml),
//     keeping the win-on-win .exe icon + native smoke.
//   - arm64 has no AVX2 concern (no baseline variant); Intel Macs are all
//     AVX2-capable, so darwin-x64 stays on the default.
//   - linux-{x64,arm64}-musl: standalone musl builds for Alpine/musl hosts (the
//     glibc binaries above can't exec on musl). No -musl-baseline variant exists,
//     so the musl x64 build requires AVX2.
const TARGETS = {
  'win-x64':          { bun: 'bun-windows-x64-baseline', out: 'mStream.exe',            win: true, plat: 'win32',  arch: 'x64',   ext: '.exe' },
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
// The discovery feature's ML runtimes CANNOT be bundled: onnxruntime-node's
// loader requires a per-(platform,arch) native binary that upstream doesn't
// ship for every target (darwin-x64 has none at all), and Bun folds
// process.platform/arch to the COMPILE TARGET's constants, so any target
// missing its binary fails the build at resolve time. External = left as a
// runtime import instead; in a standalone binary that import fails cleanly
// and the discovery worker reports the model runtime as unavailable (the
// dependencyMissing path in src/db/discovery-features-lib.js). Discovery in
// Bun bundles awaits a sidecar-staging strategy like iroh's below.
buildArgs.push('--external', '@huggingface/transformers', '--external', 'onnxruntime-node');
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
// Use a pre-fetched runtime instead of Bun's internal download when provided. CI
// sets this for the win-x64 baseline build, whose baseline cross-runtime Bun
// fails to download/extract on the Windows runner — see the pre-fetch step in
// build-bun.yml. Harmless (unset) everywhere else.
if (process.env.BUN_COMPILE_EXEC_PATH) {
  buildArgs.push(`--compile-executable-path=${process.env.BUN_COMPILE_EXEC_PATH}`);
}
buildArgs.push('cli-boot-wrapper.js', '--outfile', outPath);

console.log(`Building ${key} (${t.bun}) -> ${outPath}`);
const build = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: 'inherit' });
if (build.error) { console.error(build.error.message); }
if (build.status !== 0) { process.exit(build.status ?? 1); }

if (!doBundle) { process.exit(0); }

// ── Bundle: stage binary + webapp/ + the platform's bin/ sidecars, then zip.
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

// The server ships as `mstream-server` in EVERY bundle (1c rename): it is the
// sibling name the desktop launcher resolves, the terminal/headless entry, and
// one consistent name across platforms (the bundle dir already carries the
// arch). The launcher below — where this platform has one — takes over the
// user-facing name (mStream.exe / the .app executable / mstream-desktop).
const serverName = `mstream-server${t.ext}`;
stageExe(join(root, outPath), join(contentRoot, serverName));
cpSync(join(root, 'webapp'), join(contentRoot, 'webapp'), { recursive: true });  // the UI

// Desktop tray launcher (rust-launcher/), CI-committed per platform like the
// rust-parser sidecars. Deliberately absent on linux-arm64 and the musl
// targets: those are headless-leaning (Pi servers, Alpine/NAS containers) and
// the gtk/appindicator cross-build isn't worth carrying until someone asks —
// their bundles stay server-only and the .desktop/plist writers below adapt.
const launcherSrc = {
  'win-x64':      'mstream-launcher-win32-x64.exe',
  'darwin-x64':   'mstream-launcher-darwin-x64',
  'darwin-arm64': 'mstream-launcher-darwin-arm64',
  'linux-x64':    'mstream-launcher-linux-x64',
}[key];
let launcherStaged = false;
if (launcherSrc) {
  const src = join(root, 'bin', 'rust-launcher', launcherSrc);
  if (existsSync(src)) {
    const face = t.plat === 'win32' ? 'mStream.exe' : (isMac ? 'mStream' : 'mstream-desktop');
    stageExe(src, join(contentRoot, face));
    launcherStaged = true;
  } else if (process.env.CI && !process.env.MSTREAM_ALLOW_MISSING_LAUNCHER) {
    // In CI a launcher-shipping target without its launcher is a broken
    // release, not a variant: the server-only self-heal below would ship a
    // bundle whose double-click face is the raw server — no tray, no
    // supervised lifecycle — and every job stays green (darwin-x64 has no
    // smoke step to catch it). The workflow's fallback-build step is
    // responsible for the binary existing; if it didn't, fail HERE, on
    // every leg, before a green build can say otherwise.
    console.error(`  FATAL: launcher-shipping target ${key} has no bin/rust-launcher/${launcherSrc} (set MSTREAM_ALLOW_MISSING_LAUNCHER=1 to build server-only on purpose)`);
    process.exit(1);
  } else {
    // Local/dev builds: server-only is a legitimate shape (launcher
    // binaries only exist on master or after a local cargo build).
    console.warn(`  launcher not found, bundle ships server-only: bin/rust-launcher/${launcherSrc}`);
  }
}

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

// Iroh remote-access tunnel: @number0/iroh ships as a NAPI-RS *native addon*
// (prebuilt .node), not a spawned exe like the rust sidecars. A Bun standalone
// binary can't resolve it from node_modules, so we stage the target's .node next
// to the binary and point the loader at it at runtime via
// NAPI_RS_NATIVE_LIBRARY_PATH (see src/state/iroh.js). Best-effort: a build that
// can't obtain the .node still ships — remote access just stays unavailable,
// exactly as on an unsupported platform.
stageIroh(t, contentRoot);

// App icon. Windows embeds it in the .exe at compile time (--windows-icon
// above). macOS and Linux can't embed an icon in a bare binary, so we package
// one the platform-native way: a .app bundle (macOS) or a .desktop + PNG (Linux).
if (isMac) {
  const resDir = join(stageDir, 'mStream.app', 'Contents', 'Resources');
  mkdirSync(resDir, { recursive: true });
  cpSync(join(root, 'build', 'mstream-logo-cut.icns'), join(resDir, 'mStream.icns'));
  // CFBundleExecutable = the launcher when staged (the menu-bar face), else
  // the server itself (cross-built legs before the launcher binaries land,
  // and any future launcher-less darwin variant).
  writeFileSync(join(stageDir, 'mStream.app', 'Contents', 'Info.plist'),
    macInfoPlist(pkg.version, launcherStaged ? 'mStream' : serverName));
} else if (t.plat === 'linux') {
  cpSync(join(root, 'build', 'icon.png'), join(stageDir, 'mStream.png'));
  writeFileSync(join(stageDir, 'mStream.desktop'),
    linuxDesktopEntry(launcherStaged ? 'mstream-desktop' : serverName, launcherStaged));
}

const archivePath = join(root, 'dist', `${bundleName}.zip`);
rmSync(archivePath, { force: true });
console.log(`Bundling -> dist/${bundleName}.zip`);
// Ship a .zip (double-click-extractable on every OS) instead of tar.gz. The
// catch: the staged unix binaries were chmod +x'd above, and that execute bit
// must survive the archive. Branch on the BUILD HOST — each target builds on its
// matching-OS CI runner, so the host's tooling matches the bundle's needs:
//   - unix host (linux/macOS runners): Info-ZIP `zip` records Unix file modes,
//     so `unzip` restores +x and the binaries stay runnable; -y keeps symlinks
//     (the .app). `zip` is preinstalled on the ubuntu/macOS runners.
//   - Windows host: bsdtar (`tar -a`, ships on Windows 10+) writes a standard
//     .zip from the extension; a Windows .exe carries no mode bit to lose.
let zip;
if (process.platform === 'win32') {
  // Two tar traps on Windows dev machines, both dodged here:
  //   - GNU tar (first on PATH under git-bash) reads an absolute C:\...
  //     path's drive colon as a remote hostname, so paths stay relative
  //     under an explicit cwd.
  //   - GNU tar cannot CREATE zips at all: `-a` with a suffix it doesn't
  //     know (.zip isn't in its table) silently writes an UNCOMPRESSED TAR
  //     named .zip and exits 0. So prefer System32's bsdtar by absolute
  //     path — it's what the CI runners resolve anyway — and only fall back
  //     to PATH lookup on exotic setups. The magic-byte check below catches
  //     whatever slips through either way.
  const sysTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarBin = existsSync(sysTar) ? sysTar : 'tar';
  zip = spawnSync(tarBin, ['-a', '-c', '-f', join('dist', `${bundleName}.zip`), '-C', join('dist', 'stage'), bundleName], { cwd: root, stdio: 'inherit' });
} else {
  zip = spawnSync('zip', ['-r', '-y', '-q', archivePath, bundleName], { cwd: stageRoot, stdio: 'inherit' });
}
if (zip.error) { console.error(zip.error.message); }
if (zip.status !== 0) { console.error('archive (zip) failed'); process.exit(zip.status ?? 1); }

// A release archive that isn't a real zip must fail the build, not ship:
// every zip starts with the PK\x03\x04 local-file-header magic (a tar in
// zip's clothing starts with the first filename instead).
{
  const fd = openSync(archivePath, 'r');
  const magic = Buffer.alloc(4);
  const n = readSync(fd, magic, 0, 4, 0);
  closeSync(fd);
  if (n !== 4 || !magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    console.error(`dist/${bundleName}.zip is not a zip archive (magic: ${magic.subarray(0, Math.max(n, 0)).toString('hex') || 'empty'}) — wrong tar on PATH?`);
    process.exit(1);
  }
}
console.log(`Done: dist/${bundleName}.zip`);

// macOS .app Info.plist — points CFBundleIconFile at the staged mStream.icns
// and CFBundleExecutable at the bundle's face.
//
// LSUIElement is load-bearing twice over. Historically (#802): a faceless CLI
// server never checks in with the WindowServer, and without this key a Finder
// launch bounced into a permanent "Application Not Responding". Now: the
// bundle's executable is the tray LAUNCHER (rust-launcher/), a menu-bar app —
// which is exactly what LSUIElement declares (menu-bar presence, no Dock
// tile). The user-facing Quit that #802's fix had to defer lives in the
// launcher's tray menu. When execName is the server itself (launcher-less
// staging), the key still prevents the ANR class.
//
// The NSLocalNetwork/NSBonjour keys caption macOS 15+'s Local Network consent
// prompt, which fires on first launch because mDNS advertising
// (_mstream._tcp, src/discovery/mdns.js) is on by default — without them the
// prompt shows no explanation of why a music server wants LAN access.
function macInfoPlist(version, execName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>mStream</string>
  <key>CFBundleDisplayName</key><string>mStream Server</string>
  <key>CFBundleIdentifier</key><string>io.mstream.server</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>${execName}</string>
  <key>CFBundleIconFile</key><string>mStream.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>mStream advertises itself on your local network so players and speakers can find your music library, using Bonjour and — if you enable DLNA — SSDP.</string>
  <key>NSBonjourServices</key>
  <array>
    <string>_mstream._tcp</string>
    <string>_services._dns-sd._udp</string>
  </array>
</dict>
</plist>
`;
}

// Linux .desktop launcher: a bare ELF can't carry an icon, so this is how the
// PNG shows up in an app menu. Exec/Icon need absolute paths once installed —
// replace %INSTALL_DIR% with the extract location (or use desktop-file-install).
function linuxDesktopEntry(binName, isLauncher) {
  // Launcher bundles are a real desktop app (background server + tray) — no
  // terminal. Server-only bundles (no launcher for this target) keep the old
  // run-in-a-terminal behavior so the .desktop entry still does something
  // sensible.
  return `[Desktop Entry]
Type=Application
Name=mStream
Comment=Self-hosted music streaming server
Exec=%INSTALL_DIR%/${binName}
Icon=%INSTALL_DIR%/mStream.png
Terminal=${isLauncher ? 'false' : 'true'}
Categories=AudioVideo;Audio;Network;
`;
}

// NAPI-RS target triple for @number0/iroh's platform package / .node filename
// (e.g. win32-x64-msvc, linux-arm64-musl, darwin-arm64).
function napiTriple(target) {
  if (target.plat === 'win32') { return `win32-${target.arch}-msvc`; }
  if (target.plat === 'darwin') { return `darwin-${target.arch}`; }
  return `linux-${target.arch}-${target.musl ? 'musl' : 'gnu'}`; // linux
}

// Stage @number0/iroh's prebuilt .node for `target` into <contentRoot>/bin/iroh/.
// Native targets reuse the host-installed platform package (npm install picks
// the host triple); cross targets fetch the matching package from npm via
// `npm pack` (which ignores os/cpu, unlike `npm install`). Best-effort — warns
// and returns on any miss so the bundle still ships without remote access.
function stageIroh(target, dest) {
  const triple = napiTriple(target);
  const file = `iroh.${triple}.node`;
  const destDir = join(dest, 'bin', 'iroh');

  // 1) Host-matching prebuilt already installed by `npm ci` (native targets).
  const installed = join(root, 'node_modules', `@number0/iroh-${triple}`, file);
  if (existsSync(installed)) {
    mkdirSync(destDir, { recursive: true });
    cpSync(installed, join(destDir, file));
    console.log(`  iroh: staged ${file} (node_modules)`);
    return;
  }

  // 2) Cross target: fetch the platform package tarball and extract its .node.
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, 'node_modules', '@number0', 'iroh', 'package.json'), 'utf8')).version;
  } catch {
    console.warn('  iroh: @number0/iroh not installed — remote access unavailable in this bundle');
    return;
  }
  const tmp = join(root, 'dist', '.iroh-fetch');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const spec = `@number0/iroh-${triple}@${version}`;
  const pack = spawnSync(npm, ['pack', spec, '--pack-destination', tmp], { cwd: root, stdio: 'inherit' });
  if (pack.status !== 0) {
    console.warn(`  iroh: 'npm pack ${spec}' failed — remote access unavailable in this bundle`);
    return;
  }
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) { console.warn('  iroh: npm pack produced no tarball — remote access unavailable'); return; }
  // Relative path under cwd, not join(tmp, tgz): GNU tar (first on PATH in
  // git-bash dev shells) reads an absolute C:\...'s drive colon as a remote
  // host — this silently dropped iroh from every locally cross-built bundle.
  const untar = spawnSync('tar', ['-xzf', tgz], { cwd: tmp, stdio: 'inherit' });
  // npm tarballs put files under package/.
  const extracted = join(tmp, 'package', file);
  if (untar.status !== 0 || !existsSync(extracted)) {
    console.warn(`  iroh: could not extract ${file} from ${tgz} — remote access unavailable`);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(extracted, join(destDir, file));
  console.log(`  iroh: staged ${file} (fetched ${tgz})`);
}
