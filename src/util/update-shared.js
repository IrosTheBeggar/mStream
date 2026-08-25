// Pure, dependency-light pieces of the release-update contract, shared by
// the actors that speak it:
//
//   src/util/update-check.js   - the server-side checker/stager (re-exports
//                                these, so its public API is unchanged)
//   src/util/boot-watchdog.js  - the pre-boot headless rollback guard,
//                                which must import nothing heavy: it runs
//                                BEFORE the crash-prone boot phase it
//                                exists to guard
//   rust-launcher/src/rollback.rs mirrors compareVersions/parseBundleName
//                                and the hold-file schema in Rust (the
//                                desktop boot watchdog); a behavioural
//                                change here must change there too.
//
// Keep this module to node builtins + atomic-json (itself fs/path only).
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { writeJsonAtomic } from './atomic-json.js';

export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// Strict numeric-triple compare. Returns <0, 0, >0 — or null when either
// side is not a plain X.Y.Z (prerelease-shaped strings are refused on
// purpose: releases are always bare triples, so anything else in a manifest
// is not a version to act on).
export function compareVersions(a, b) {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) { return null; }
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) { return d; }
  }
  return 0;
}

// mStream-<version>-<key>[.zip] -> { version, key }, or null.
export function parseBundleName(name) {
  const m = /^mStream-(\d+\.\d+\.\d+)-((?:darwin|linux|win)-[a-z0-9]+(?:-musl)?)(?:\.zip)?$/.exec(name);
  return m ? { version: m[1], key: m[2] } : null;
}

// ── update-hold.json: boot-failure holds ────────────────────────────────────
// Written when a watchdog rolls a crash-at-boot update back; read to keep
// that version from being staged or applied again; entries drop once a
// version >= them boots. Three writers, never concurrent: the launcher's
// watchdog and the headless boot guard write only while no server runs, and
// the server prunes/clears only about itself while it IS the one running.

export const HOLD_FILE = 'update-hold.json';
export const MAX_HELD = 8;

// Tolerant read: the file is our own, but absent / newer-schema / mangled
// must all read as "nothing held", never as a crash.
export function readHoldEntries(dataHome) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataHome, HOLD_FILE), 'utf8'));
    if (!doc || !Array.isArray(doc.held)) { return []; }
    return doc.held
      .filter((h) => h && typeof h.version === 'string' && VERSION_RE.test(h.version))
      .slice(0, MAX_HELD);
  } catch {
    return [];
  }
}

// Append `version` (dedupe; oldest entries give way past the cap). Atomic —
// a torn hold file would read as "nothing held" and re-open the re-stage
// loop the hold exists to close.
export async function appendHold(dataHome, version, reason) {
  const held = readHoldEntries(dataHome);
  if (!held.some((h) => h.version === version)) {
    held.push({ version, at: new Date().toISOString(), reason });
  }
  while (held.length > MAX_HELD) { held.shift(); }
  await fsp.mkdir(dataHome, { recursive: true });
  await writeJsonAtomic(path.join(dataHome, HOLD_FILE), { schema: 1, held });
}
