import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export function getDirname(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

// Root directory holding the app's shipped assets — webapp/, bin/, and the
// default save/ and *-cache/ locations.
//
// Under Node and Electron (asar:false) this module lives on disk at
// <root>/src/util/esm-helpers.js, so the root is two levels up. Under a Bun
// `bun build --compile` standalone binary the source modules live in a virtual
// filesystem (e.g. B:\~BUN\root) with no on-disk presence, so we anchor to the
// directory containing the executable — that's where webapp/ and bin/ ship
// next to it.
const selfPath = fileURLToPath(import.meta.url);
// Bun `--compile` standalone binaries place every source module under a
// synthetic root — "/$bunfs/…" on posix, "B:\~BUN\…" on Windows — that is not
// the real install dir, and fs.existsSync() returns true for these phantom
// paths, so a "does my file exist on disk" check can't distinguish them. Match
// the synthetic-root marker instead and anchor to the executable's directory,
// where webapp/ and bin/ are shipped alongside it.
export const isBunStandalone = /[\\/](~BUN|\$bunfs)[\\/]/.test(selfPath);
export const appRoot = isBunStandalone
  ? dirname(process.execPath)
  : join(dirname(selfPath), '..', '..');
