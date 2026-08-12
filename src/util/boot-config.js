// Default-config resolution + first-run generation for the boot wrapper.
//
// One binary, two install profiles:
//
//   server profile  — source / npm / Docker runs. Config and data live next
//                     to the app (appRoot/save/..., appRoot/*-cache) exactly
//                     as they always have. Nothing here changes that.
//
//   desktop profile — the Bun standalone binary (the downloadable bundles).
//                     Config and data live in the per-OS user data home, and
//                     the first-run config enables Quick Connect — the
//                     standard connection setup for this install method.
//                     Writing next to the binary is a trap there: macOS app
//                     translocation runs a quarantined .app from a randomized
//                     read-only mount, and installer targets (Program Files)
//                     aren't user-writable.
//
// Existing standalone installs are grandfathered: a save/conf/default.json
// next to the binary keeps winning, so a pre-desktop-profile bundle upgraded
// in place keeps its config and library untouched. --portable forces that
// layout for new installs (USB sticks, one-folder deployments).

import { join, dirname } from 'path';
import { homedir as osHomedir } from 'os';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import { appRoot, dataRoot, isBunStandalone, userDataHome } from './esm-helpers.js';

// Per-OS user data home for the desktop profile: one root holds everything
// (config, db, caches, downloaded ffmpeg). The implementation lives in
// esm-helpers.js — the SAME directory backs dataRoot's read-only-app
// fallback there, so the two relocation paths can never diverge. Re-exported
// here because it is part of this module's contract (and its tests).
export { userDataHome };

// Where the default config lives when no -j/--json was given, and which
// profile that path represents. First match wins:
//   1. MSTREAM_CONFIG env override ('env') — used verbatim; no first-run
//      generation (a missing file gets config.setup()'s plain `{}`).
//   2. Non-standalone runs ('server') — writableRoot/save/conf/default.json.
//      writableRoot is dataRoot: identical to appRoot on every install that
//      can write next to the app (the norm), diverging to the user data dir
//      only when the app dir is read-only (a translocated macOS .app, a
//      root-owned global install) — see resolveDataRoot in esm-helpers.js.
//   3. --portable ('portable') — next-to-binary, by request (an unwritable
//      app dir then fails setup honestly rather than silently relocating
//      what the flag pinned in place).
//   4. An EXISTING appRoot/save/conf/default.json ('legacy') — pre-profile
//      bundles upgraded in place keep their data with zero migration.
//   5. Fresh standalone install ('desktop') — <userDataHome>/conf/default.json.
export function resolveDefaultConfig({
  portable = false,
  env = process.env,
  platform = process.platform,
  homedir = osHomedir,
  standalone = isBunStandalone,
  root = appRoot,
  writableRoot = dataRoot,
  exists = existsSync,
} = {}) {
  if (env.MSTREAM_CONFIG) { return { path: env.MSTREAM_CONFIG, profile: 'env' }; }
  const legacyPath = join(root, 'save/conf/default.json');
  if (!standalone) { return { path: join(writableRoot, 'save', 'conf', 'default.json'), profile: 'server' }; }
  if (portable) { return { path: legacyPath, profile: 'portable' }; }
  if (exists(legacyPath)) { return { path: legacyPath, profile: 'legacy' }; }
  const dataHome = userDataHome(platform, env, homedir);
  return { path: join(dataHome, 'conf', 'default.json'), profile: 'desktop', dataHome };
}

// First-run config contents for the desktop profile. Storage dirs move under
// the data home, mirroring the appRoot default names; modelCacheDirectory is
// deliberately absent (config.js derives it as a sibling of dbDirectory).
// transcode.ffmpegDirectory moves too — ffmpeg is DOWNLOADED into it on
// demand, which must not write into Program Files or a translocated .app.
//
// Quick Connect (the iroh tunnel + the pairing code in the web UI) is ON in
// the generated config. --quick-connect-off-by-default generates it disabled
// instead, for headless boxes that don't want a remote-access tunnel. Either
// way this only shapes the file CREATED ON FIRST RUN: an existing config —
// including one where the operator enabled Quick Connect by hand — is never
// modified, so the flag can sit permanently in a NAS unit file without
// fighting the operator. (The iroh secretKey/connectSecret are not written
// here; config.setup() generates and persists them for every config.)
export function desktopDefaultConfig(dataHome, { quickConnectOffByDefault = false } = {}) {
  const cfg = {
    storage: {
      dbDirectory: join(dataHome, 'db'),
      logsDirectory: join(dataHome, 'logs'),
      albumArtDirectory: join(dataHome, 'image-cache'),
      waveformCacheDirectory: join(dataHome, 'waveform-cache'),
    },
    transcode: { ffmpegDirectory: join(dataHome, 'ffmpeg') },
  };
  if (!quickConnectOffByDefault) {
    cfg.iroh = { enabled: true, shareCodePublic: true };
  }
  return cfg;
}

// Create the desktop-profile default config on first run. Never overwrites —
// an existing file means this is not a first run and its contents are the
// operator's ('wx' makes that race-free). Returns true when a file was
// created.
export async function ensureDesktopDefaultConfig(resolved, { quickConnectOffByDefault = false } = {}) {
  if (resolved.profile !== 'desktop') { return false; }
  await fs.mkdir(dirname(resolved.path), { recursive: true });
  const contents = JSON.stringify(desktopDefaultConfig(resolved.dataHome, { quickConnectOffByDefault }), null, 2);
  try {
    await fs.writeFile(resolved.path, contents, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') { return false; }
    throw err;
  }
}
