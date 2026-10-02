// The mstream-player release's two binary families, as mStream sees them —
// shared by scripts/update-mstream-player-manifest.mjs (what gets pinned)
// and scripts/build-bun.mjs (what a bundle stages). Pure: no I/O, so the
// unit tests exercise it directly (test/unit/mstream-player-asset.test.mjs).
//
// One player tag publishes both families side by side:
//   - TERMINAL  mstream-player-<plat>-<arch>[.exe]          (every platform)
//   - DESKTOP   mstream-player-desktop-<plat>-<arch>-raw[.exe]  (no arm Linux; the
//               -raw suffix keeps the bare file from being taken for a package)
// The desktop binary is a strict CLI superset of the terminal one (every
// explicit argv means the same; `--port N` is still the server-audio
// engine) that additionally opens the GUI in its own window on an empty
// argv. mStream's BINARY BUNDLES ship the desktop one; every other install
// (npm, source checkout, Docker — the runtime fetch in
// src/util/mstream-player-bootstrap.js) keeps the terminal one, by looking
// up the terminal key only.
//
// The bundle stages whichever it took under the TERMINAL file name, so the
// launcher's lookup (rust-launcher/src/paths.rs), the server's resolver
// (src/state/server-audio.js) and the CI checks never see a second name.

// Every bare platform binary of either family. Deliberately excludes the
// release's packages (deb/rpm, the web tarball, the desktop .app.zip /
// .zip / .tar.gz) and the Windows launcher stub
// (mstream-player-desktop-launch-win32-x64-raw.exe): mStream neither stages nor
// fetches those.
export const BINARY_RE =
  /^mstream-player-(?:desktop-(?:darwin|linux|win32)-[a-z0-9]+-raw|(?:darwin|linux|win32)-[a-z0-9]+)(\.exe)?$/;

// 'desktop' | 'terminal' for a bare binary name, null for anything else.
export function assetFamily(name) {
  const s = String(name ?? '');
  if (!BINARY_RE.test(s)) { return null; }
  return s.startsWith('mstream-player-desktop-') ? 'desktop' : 'terminal';
}

// Both families' file names for one platform.
export function playerAssetNames({ plat, arch, ext = '' }) {
  return {
    terminal: `mstream-player-${plat}-${arch}${ext}`,
    desktop: `mstream-player-desktop-${plat}-${arch}-raw${ext}`,
  };
}

// Pick the pinned entry a bundle stages for one platform: the preferred
// family's entry when the manifest pins it, else the other family's, else
// null. Returns { key, entry, family, stagedName, note }:
//   key        — the manifest key (= the release asset's file name)
//   entry      — manifest.assets[key], untouched (the caller verifies it)
//   family     — 'desktop' | 'terminal'
//   stagedName — ALWAYS the terminal file name: the name the bundle writes
//   note       — one line saying which family was taken, and why
export function choosePlayerAsset(manifest, { plat, arch, ext = '', prefer = 'desktop' } = {}) {
  if (prefer !== 'desktop' && prefer !== 'terminal') {
    throw new Error(`choosePlayerAsset: prefer must be 'desktop' or 'terminal' (got ${prefer})`);
  }
  const names = playerAssetNames({ plat, arch, ext });
  const other = prefer === 'desktop' ? 'terminal' : 'desktop';
  const assets = manifest && typeof manifest.assets === 'object' && manifest.assets ? manifest.assets : {};
  const pinned = (k) => {
    const e = Object.hasOwn(assets, k) ? assets[k] : null;
    return e && typeof e === 'object' ? e : null;
  };
  for (const family of [prefer, other]) {
    const key = names[family];
    const entry = pinned(key);
    if (!entry) { continue; }
    const note = family === prefer
      ? `${family} family (${key})`
      : `${family} family (${key}) — no ${prefer} pin for ${plat}-${arch}`;
    return { key, entry, family, stagedName: names.terminal, note };
  }
  return null;
}

// Windows FileDescription for the staged player (Task Manager shows it as
// the process name; the desktop one also titles a window). Asserted only as
// non-empty by scripts/check-win-versioninfo.ps1, so either value passes.
export function playerFileDescription(family) {
  return family === 'desktop' ? 'mStream Player' : 'mStream Server Audio';
}

// The bundler's one line for what it staged.
export function stagedLine({ family, key, tag, stagedName, size }) {
  const from = key === stagedName ? key : `${key} as ${stagedName}`;
  return `staged mstream-player ${tag} (${family} family): ${from} -> bin/mstream-player/${stagedName} (${(size / 1048576).toFixed(1)} MB, sha verified)`;
}

// Why a tag must not be pinned as a release, or null when it may be. A
// SemVer pre-release tag carries a '-' (v0.10.0-rc.1); GitHub's own release
// object can also say prerelease: true. `release` is that object, or null
// when it could not be read (then only the tag name decides).
export function prereleaseReason(tag, release = null) {
  if (String(tag).includes('-')) { return `the tag '${tag}' carries a '-' (a pre-release version)`; }
  if (release && release.prerelease === true) { return `GitHub marks release '${tag}' as a pre-release`; }
  return null;
}
