/**
 * mstream-player-bootstrap.js
 *
 * Fetches the prebuilt mstream-player binary (the server-audio engine, née
 * rust-server-audio) on first use, with SHA256 verification against a
 * manifest COMMITTED to this repo. The player's source and releases live in
 * their own repo — IrosTheBeggar/mstream-terminal-player — whose CI attaches
 * the platform binaries to each versioned release; the in-tree crate this
 * replaces was a stale 0.1.0 fork of that living project.
 *
 * The mechanics — token-validated pins, a derived URL, the size cap, the
 * hash check, the execution probe, the rename-aside swap, the receipt, the
 * single-flight ensure — are pinned-binary.js, shared with the p2p sidecar.
 * What is particular to the player:
 *
 *   - bin/mstream-player/manifest.json is committed text, reviewed like any
 *     other tree change. Updating it when a new player release is published
 *     is a small text PR (scripts/update-mstream-player-manifest.mjs). One
 *     family, one publisher, one manifest — the player repo's single release
 *     workflow publishes every platform, so there is no musl-split file here
 *     (contrast bin/p2p-sidecar/). A -musl key still reads manifest-musl.json,
 *     so IF a musl family ever appears it slots in without code.
 *   - The upstream darwin binaries arrive Developer-ID-signed; the pins cover
 *     the signed bytes, so verification happens on exactly what the release
 *     ships.
 *   - ON-DISK POLICY 'receipt-gated'. Binaries the OPERATOR placed (anything
 *     without our install receipt) are never overwritten or second-guessed —
 *     the receipt's absence IS the marker that a human put the file there;
 *     only what this module installed itself is refreshed when the manifest
 *     moves on. A dev cargo build of the player repo wins before this module
 *     is consulted at all (see src/state/server-audio.js findRustBinary()).
 *   - The probe: `--version` is clap's built-in one-shot — print
 *     "mstream-player X.Y.Z" and exit, with no audio device, no sockets, no
 *     config. That matters: the engine opens the audio device eagerly in
 *     serve mode, so a /status-style probe would fail on every headless host
 *     that most needs the fetch path.
 *
 * There is no musl build of the player (server audio is opt-in and needs a
 * sound device — not an Alpine-container feature). On musl hosts the key
 * carries a -musl suffix, the manifest lookup finds nothing, and server
 * audio is simply unavailable there: the engine is the only backend.
 *
 * MSTREAM_PLAYER_BASE overrides the derived URL's BASE (sha256 pins still
 * apply) for air-gapped mirrors and the unit tests' loopback server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createPinnedBinary, deriveAssetUrl } from './pinned-binary.js';

const player = createPinnedBinary({
  family: 'mstream-player',
  baseEnv: 'MSTREAM_PLAYER_BASE',
  onDiskPolicy: 'receipt-gated',
  probe: {
    flag: '--version',
    args: () => ['--version'],
    accept: /^mstream-player \d+\.\d+\.\d+/,
    scratchDir: false,
  },
  noun: 'player',
  unpublishedMeans: 'server audio is unavailable here',
});

// The manifest is keyed by the full binary filename, so there is zero mapping
// logic to drift between this module and the resolver in server-audio.js.
export const playerKey = player.key;

// Where the committed manifest lives — next to where the binaries land.
export const defaultManifestDir = player.defaultManifestDir;

// Download target: the writable managed home. For a plain git checkout or npm
// install it is exactly where the resolver already looks.
export const managedPlayerDir = player.managedDir;
export const managedPlayerPath = player.managedPath;

// The manifest entry for this platform — {repo, tag, file, sha256, size} — or
// null when none is published or the document is malformed.
export const manifestEntry = player.manifestEntry;

// Can this platform's binary be fetched at all? Lets status surfaces report
// fetchability without triggering a download.
export const canAutoFetch = player.canAutoFetch;

export { deriveAssetUrl };

// A player binary that is ALREADY on this machine — the bundled copy next to
// the server (build-bun stages it into every non-musl bundle) or a previously
// fetched managed one — or null. Never downloads: this feeds boot-time
// messaging, which must not cost a network round-trip or imply consent to one.
export function installedPlayerPath({ bundledDir = defaultManifestDir(), installDir = managedPlayerDir(), key = playerKey() } = {}) {
  for (const dir of [bundledDir, installDir]) {
    const candidate = path.join(dir, key);
    if (fs.existsSync(candidate)) { return candidate; }
  }
  return null;
}

// The linux player links libasound at LOAD time (it is an audio engine
// first), so on a headless box without ALSA even `--version` dies with a
// loader error — an invitation must not greet a fresh install with that.
// Non-linux platforms link only ever-present system audio (CoreAudio /
// WASAPI), so they are always loadable.
export function playerLoadableHere() {
  if (process.platform !== 'linux') { return true; }
  try {
    return execSync('ldconfig -p', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .includes('libasound.so.2');
  } catch (_err) {
    return false; // no ldconfig ⇒ can't prove ALSA ⇒ don't print a command that may die
  }
}

/**
 * Make sure a usable player binary exists at the managed path.
 *
 *   - present + not installed by us (no receipt entry) → returned untouched
 *     (operator-supplied; theirs to manage).
 *   - present + ours + receipt matches the manifest pin → returned as-is.
 *   - present + ours + manifest moved on → the new build is downloaded,
 *     verified, probed, and swapped in.
 *   - absent + manifest has an entry → downloaded, verified, probed,
 *     installed.
 *   - absent + no manifest entry for this platform (musl hosts today) →
 *     null; server audio is unavailable there.
 *
 * Throws on download/verification/probe failures — the caller
 * (src/state/server-audio.js boot()) logs what that means and leaves
 * server audio off. `probe` is injectable for the unit tests.
 */
export const ensurePlayer = player.ensure;

// Test hook: forget the in-flight ensure (mirrors p2p-sidecar-bootstrap.reset()).
export const reset = player.reset;
