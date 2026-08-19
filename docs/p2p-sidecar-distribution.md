# p2p-sidecar distribution: design

**Status: implemented. The sidecar's source and releases live in
[IrosTheBeggar/mstream-p2p-sidecar](https://github.com/IrosTheBeggar/mstream-p2p-sidecar);
mStream keeps only committed text manifests that pin a release, and fetches
on first use. rust-parser and rust-server-audio are outlined at the bottom
(later phases, not built).**

## The problem this solved

CI used to rebuild the nine prebuilt sidecar binaries on every source change
and commit them to `bin/p2p-sidecar/`. Binaries don't delta-compress, so
every refresh added the full ~172 MB set to git history *forever* — measured
at 1,118 MB of unique sidecar blobs already reachable in master's history.
The npm tarball was worse: `bin/p2p-sidecar` had no `.npmignore` entry, so
every `npm i mstream` shipped **179 MB unpacked (63% of the tarball) of
binaries for all nine platforms, for a feature that is off by default**.
After the move: the tarball drops from ~125 MB to ~47 MB compressed, git
history stops growing, and the one binary a server actually needs (~20 MB)
is fetched only when the discovery network is turned on.

## The model

1. **The crate lives in its own repo** —
   `IrosTheBeggar/mstream-p2p-sidecar` (extracted 2026-08-19 from mStream
   commit `61eca273…`, fresh history; the extraction commit records the
   exact tree). Its releases are normal `v*`-tagged releases: CI builds all
   nine platform binaries on a tag push, self-tests each (identity
   round-trip; qemu for ARM musl; real-run socket smoke on Linux), and
   attaches them to a **draft** release together with two manifest
   fragments (`manifest-fragment.json`, `manifest-fragment-musl.json`,
   `{file, sha256, size}` per binary). A maintainer publishes the draft.
   Published assets are immutable by policy — fixes ship as a new version.
   Versioning: `MAJOR.MINOR` mirrors the pinned iroh line, `PATCH` is the
   sidecar's own (iroh 1.0.x → sidecar v1.0.x).
2. **mStream commits only pins**: `bin/p2p-sidecar/manifest.json`
   (glibc/darwin/windows) and `manifest-musl.json` (Alpine/musl) pin
   `{repo, tag}` plus `{file, sha256, size}` per platform key. The download
   URL is *derived* from those pins (`github.com/<repo>/releases/download/
   <tag>/<file>`), never stored — and every component is validated as a
   plain token first, so a bad merge can't steer the request anywhere else.
3. **The server fetches on first use**
   (`src/util/p2p-sidecar-bootstrap.js`): when the discovery network starts
   (boot with `discoveryP2p.enabled`, or the admin enable route) and no
   binary is present, the platform's asset is downloaded into
   `dataRoot/bin/p2p-sidecar/` (same dir as the app for a plain checkout; a
   writable one when appRoot isn't — the ffmpeg-bootstrap precedent),
   sha256-verified against the manifest, size-capped in flight,
   execution-probed (`--print-id`), and atomically swapped in. A failed
   hash or probe deletes the download and the feature degrades with the
   cause in the log. `stop()` during the download window is handled by a
   start-generation gate so an aborted start can never orphan a sidecar.
4. **Humans always win.** Resolution order: nested-clone dev build
   (`p2p-sidecar/target/release/`, the directory is gitignored for exactly
   this) → operator-placed binary in `bin/p2p-sidecar/` → managed install.
   The fetcher records its own installs in `.fetched.json`; anything
   without a receipt entry is operator property, never refreshed or
   replaced. Receipted installs *are* refreshed when the manifest pins a
   newer release.
5. **Release bundles don't use any of this**: they ship the sidecar staged
   next to the server at bundle-build time (fetched from the same release
   assets, sha256-verified, and Authenticode-signed on Windows along with
   the rest of the bundle — which is what keeps Smart App Control happy).
   The runtime fetch exists for npm, source-checkout, and Docker installs.

### Trust model

- The committed manifest is the trust anchor: changing a pin requires a
  reviewed mStream commit; swapping bytes on the release side alone fails
  the sha256 check. Store assets are unsigned (deliberate — the
  signing-critical path is bundle-time signing in mStream).
- Transport hardening is shared with ffmpeg-bootstrap: https only (plain
  http for loopback alone), redirect cap, socket timeout, byte cap at the
  pinned size.
- `MSTREAM_SIDECAR_BASE` swaps the URL *base* (internal mirrors, tests);
  the pins still apply, so a lying mirror is refused.

## The release ritual (both repos)

1. In `mstream-p2p-sidecar`: land changes on `main`, then push a `vX.Y.Z`
   tag. CI attaches binaries + fragments to a **draft** release.
2. Review the draft (spot-check a binary, read the fragments), publish it.
3. In mStream: `node scripts/update-p2p-sidecar-manifest.mjs vX.Y.Z` —
   fetches the published release's fragments and regenerates both committed
   manifests. Open the small text PR; merging it is what rolls the fleet
   (servers refresh their receipted install on next discovery start;
   operator-placed binaries stay untouched).
4. Bundle builds pick the new pins up from the same manifests (Phase D
   staging).

## Docker / image-maintainer notes

- **Recommended for images (linuxserver.io-class): bake at build time** —
  `RUN npm run fetch-p2p-sidecar` in the Dockerfile downloads + verifies
  this platform's binary into the image, so containers have **zero runtime
  egress** for the sidecar.
- **Runtime fetch with a persistent volume also works**: the managed
  install lands under `dataRoot` (`bin/p2p-sidecar/` inside it), so a
  volume over the data root keeps the binary and its `.fetched.json`
  receipt across container recreations — one fetch total, not one per
  container, and a manifest bump refreshes exactly once. This is pinned by
  the acceptance test at `test/smoke/docker/p2p-sidecar-volume-smoke.sh`
  (fresh container → one fetch; recreate → zero fetches; manifest bump →
  exactly one refresh).
- **Air-gapped**: pre-fetch on a connected same-platform machine and carry
  `bin/p2p-sidecar/` across, point `MSTREAM_SIDECAR_BASE` at an internal
  mirror serving the same asset files, or hand-place a binary (never
  touched).

## Later phases (not built): rust-parser and rust-server-audio

Both families are still CI-committed binaries in this repo (~1.6 GB of
rust-parser history already), and both ARE staged into release bundles and
tag-asserted, so their moves touch the release path:

- Same shape: crate to its own repo (or stay in-tree with a
  binaries-to-release-assets move only — decide per family), versioned
  releases with fragments, committed pins here.
- `scripts/build-bun.mjs` fetches manifest-pinned assets at bundle time
  instead of copying `bin/` (the sidecar's Phase D staging is the
  template); Windows VersionInfo stamping is unaffected (it already stamps
  the staged copy).
- build-bun's tag asserts move from the `.source-tree` stamps to the
  manifests' pins — and gain a per-binary hash check the stamps never had.
- Runtime fallbacks (JS scanner, CLI players) already provide the
  degradation net for a fetch-on-first-use path for npm/source users.
- Sequence: let a few sidecar release cycles prove the ritual, then
  rust-parser (the whale), then rust-server-audio.
