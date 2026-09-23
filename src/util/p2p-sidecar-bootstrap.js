/**
 * p2p-sidecar-bootstrap.js
 *
 * Fetches the prebuilt p2p-sidecar binary (the iroh networking companion for
 * the music-discovery network) on first use, with SHA256 verification
 * against a manifest COMMITTED to this repo. The sidecar's source and its
 * releases live in their own repo — IrosTheBeggar/mstream-p2p-sidecar —
 * whose CI attaches the nine platform binaries to each versioned release;
 * nothing binary lives in git on either side (each CI refresh of the old
 * in-tree set added ~172 MB of undeltifiable blobs to history forever; the
 * committed manifest is the few-hundred-byte replacement).
 *
 * The mechanics — token-validated pins, a derived URL, the size cap, the
 * hash check, the execution probe, the rename-aside swap, the receipt, the
 * single-flight ensure — are pinned-binary.js, shared with the player. What
 * is particular to the sidecar:
 *
 *   - Trust model: same shape as ffmpeg-bootstrap.js, but stricter — we pin
 *     exact hashes, not a live upstream checksum file.
 *     bin/p2p-sidecar/manifest.json (and manifest-musl.json: musl builds are
 *     published by their own workflow into their own manifest, mirroring the
 *     old .source-tree / .source-tree-musl stamp split, so the two publishers
 *     never write the same file) are committed text, reviewed like any other
 *     tree change. Updating them when a new sidecar release is published is a
 *     small text PR (scripts/update-p2p-sidecar-manifest.mjs assembles it
 *     from the release's manifest-fragment assets).
 *   - Published release assets in the sidecar repo are immutable by policy
 *     (fixes ship as a new version), and the sha256 pins make a swapped
 *     asset fail closed regardless.
 *   - ON-DISK POLICY 'pin-is-law'. The pin is law for every binary this
 *     module manages, WHOEVER put it there: a file at the managed path that
 *     does not hash to the manifest pin is replaced with the pinned build
 *     (or, if that can't be fetched, refused with the cause). One pinned
 *     sidecar everywhere — a binary that drifts from the manifest means
 *     different installs run different network behaviour, and a stale one
 *     can quietly reintroduce a fixed bug (the v1.0.1 connection leak being
 *     the motivating scar). The receipt is therefore PROVENANCE ONLY here:
 *     whether a file is current is decided by hashing it, never by who
 *     installed it — still a useful forensic fact (image bakes write it,
 *     hand-copies don't). The ONE deliberate override left is the dev cargo
 *     build at p2p-sidecar/target/release/ — src/state/discovery-p2p.js
 *     prefers it before this module is consulted — which also covers
 *     self-built binaries for platforms the manifest doesn't pin.
 *   - The probe: --print-id is the sidecar's one-shot CI mode — create a
 *     throwaway identity, print the derived endpoint id (64 hex chars),
 *     exit. No sockets, no network (the build workflows lean on the same
 *     property). It writes that identity somewhere, hence the scratch dir.
 *
 * MSTREAM_SIDECAR_BASE overrides the derived URL's BASE (the sha256 pins
 * still apply) for air-gapped mirrors and the unit tests' loopback server —
 * the MSTREAM_FFMPEG_MIRROR precedent.
 */

import { computeFileChecksum } from './ffmpeg-bootstrap.js';
import { createPinnedBinary, deriveAssetUrl } from './pinned-binary.js';

const sidecar = createPinnedBinary({
  family: 'p2p-sidecar',
  baseEnv: 'MSTREAM_SIDECAR_BASE',
  onDiskPolicy: 'pin-is-law',
  probe: {
    flag: '--print-id',
    args: (scratchDir) => ['--print-id', '--data-dir', scratchDir],
    accept: /^[0-9a-f]{64}$/,
    scratchDir: true,
  },
  noun: 'binary',
  unpublishedMeans: 'the discovery network stays unavailable until one is',
});

// Re-exported for discovery-p2p.js's read-only-root pin check (a bundle's
// staged binary can't be replaced in place, so acquire verifies it here).
export { computeFileChecksum };

// Mirrors src/state/discovery-p2p.js's resolveSidecarBinary() naming exactly:
// the manifest is keyed by the full binary filename, so there is zero mapping
// logic to drift between the two modules.
export const sidecarKey = sidecar.key;

// Where the committed manifests live — next to where the binaries used to be.
export const defaultManifestDir = sidecar.defaultManifestDir;

// Download target: the writable managed home. For a plain git checkout or npm
// install it is where the CI-committed binary used to sit — and where
// resolveSidecarBinary() already looks.
export const managedSidecarDir = sidecar.managedDir;
export const managedSidecarPath = sidecar.managedPath;

// The manifest entry for this platform — {repo, tag, file, sha256, size} — or
// null when none is published or the document is malformed.
export const manifestEntry = sidecar.manifestEntry;

// Can this platform's binary be fetched at all? The admin enable route uses
// this to keep its fast 503 for genuinely unfetchable platforms while letting
// fetchable ones proceed to the download inside start().
export const canAutoFetch = sidecar.canAutoFetch;

export { deriveAssetUrl };

/**
 * Make sure a usable sidecar binary exists at the managed path.
 *
 *   - present + hashes to the manifest pin → returned as-is, whoever
 *     installed it (the hash IS the check; receipts are provenance only).
 *   - present + does NOT hash to the pin — stale receipted install,
 *     operator-placed build, bit rot alike → the pinned build is
 *     downloaded, verified, probed, and swapped in. If the fetch fails, this
 *     throws rather than running the drifted binary: one pinned sidecar
 *     everywhere. The dev cargo build is the deliberate escape hatch,
 *     preferred by discovery-p2p.js before this module is consulted.
 *   - absent + manifest has an entry → downloaded, verified, probed,
 *     installed.
 *   - present-or-absent + no manifest entry for this platform → whatever
 *     exists is returned untouched (nothing to enforce against), else null
 *     (callers degrade with their own actionable error).
 *
 * Throws on download/verification/probe failures — the caller (discovery-p2p
 * start(), which the admin route and boot both funnel through) surfaces the
 * cause verbatim. `probe` is injectable for the unit tests; the Docker
 * end-to-end exercises the real one with real binaries through the server's
 * own spawn path.
 */
export const ensureSidecar = sidecar.ensure;

// Test hook: forget the in-flight ensure (mirrors ffmpeg-bootstrap.reset()).
export const reset = sidecar.reset;
