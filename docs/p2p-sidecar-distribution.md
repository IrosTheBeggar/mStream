# Sidecar binaries as release assets: design

**Status: implemented for p2p-sidecar (phase 1). rust-parser and
rust-server-audio are outlined at the bottom (phases 2/3), not built.**

## The problem

CI rebuilds prebuilt sidecar binaries on every source change and commits
them to `bin/`. Binaries don't delta-compress, so every refresh adds the
full set to git history *forever* — for every clone, fork, and CI checkout,
from now on:

| family | set size at tip | refresh commits on master | unique blob bytes in history |
| --- | --- | --- | --- |
| `bin/p2p-sidecar` | **172 MB** (9 iroh-linked binaries, ~20 MB each) | 15 | **1,118 MB** (measured 2026-08) |
| `bin/rust-parser` | 58 MB (9 binaries) | 92 | ~1,577 MB (July audit) |
| `bin/rust-server-audio` | 17 MB | 6 | ~17 MB+ |
| `bin/rust-launcher` | 4.4 MB | 13 | trivial — out of scope |

A separate git-filter-repo history rewrite is planned to purge the old
blobs; it is pointless until the model stops regrowing them. p2p-sidecar is
the worst per-refresh offender (172 MB/refresh, at 24 total refresh events
across both its workflows), so it goes first.

The npm story was worse than the git story: `bin/p2p-sidecar` had no
`.npmignore` entry, so **every `npm i mstream` shipped 179 MB (unpacked) of
sidecar binaries — 63% of the 284 MB unpacked tarball — for all nine
platforms, for a feature that is off by default.** After this change the
tarball drops to ~104 MB unpacked, and the one binary a server actually
needs (~20 MB) is fetched only when the operator turns the discovery
network on.

## The model

Generalizes the two fetch-with-pins precedents already in the tree:
`ffmpeg-bootstrap.js` (download-on-first-use into a writable dir, checksum
verify, operator binaries never touched) and `discovery-features-lib.js`
(assets on a dedicated project release — `discovery-models-1` — with
sha256 pins committed in code).

1. **Binaries live as GitHub RELEASE assets** on one rolling, machine-managed
   release: tag `p2p-sidecar-assets`, created as a **prerelease** so it can
   never become `releases/latest` (which install.sh resolves for server
   bundles). Release assets never expire; workflow artifacts do (90-day
   cap), which rules them out.
2. **Asset names are immutable by construction**:
   `<key>-<tree12>-<sha8>[.exe]`, where `tree12` = the `p2p-sidecar/`
   source-tree hash the set was built from and `sha8` = the binary's own
   sha256. Same name ⟹ same bytes, so the publish step *skips* an existing
   name and *never* replaces one — the store is append-only, and a manifest
   committed at any point in history keeps resolving to exactly the bytes
   it pins. (A rolling tag with *replaced* assets was rejected for exactly
   that reason: it breaks every older checkout's pins. Per-run version tags
   were rejected for tag sprawl; git-LFS for bandwidth quotas and fork
   breakage.)
3. **A committed text manifest is the source of truth**:
   `bin/p2p-sidecar/manifest.json` (glibc/darwin/win) and
   `manifest-musl.json` (Alpine/musl — its own file so the two workflows
   never write the same path, carrying forward the old
   `.source-tree`/`.source-tree-musl` split). Each entry pins
   `{file, sha256, size, url}` per platform key, plus `sourceTree`,
   `version` (crate), `builtFrom` (trigger sha) and `workflowRun` for the
   family. The manifests replace and strengthen the old ledger-only stamps:
   the same tree hash, **plus** per-binary pins that the server *verifies at
   fetch time* instead of a file nothing read. Committed by CI through the
   same hardened no-rebase/stand-down/retry loop as every binary family
   since #840/#844 — but now the payload is a few hundred bytes of JSON.
4. **The server fetches on first use** (`src/util/p2p-sidecar-bootstrap.js`):
   when the discovery network starts (boot with `discoveryP2p.enabled`, or
   the admin enable route) and no binary is present, the platform's asset is
   downloaded into `dataRoot/bin/p2p-sidecar/` (the ffmpeg precedent — same
   dir as the app for a plain checkout, a writable dir when appRoot isn't),
   sha256-verified against the manifest, execution-probed (`--print-id`),
   and atomically swapped in. A failed hash or probe deletes the download
   and the feature degrades with the cause in the log — exactly the
   missing-binary degradation that already existed, now with a fetch in
   front of it.
5. **Humans always win.** Resolution order: local `cargo build` →
   operator-placed binary in `bin/p2p-sidecar/` → managed install. The
   fetcher records what *it* installed in `.fetched.json` (the receipt);
   a binary with no receipt entry is operator property and is never
   refreshed or replaced (ffmpeg's `.checksum` provenance rule). A managed
   install *is* refreshed when the manifest pins a newer build.

### Trust model

- The manifest is the trust anchor: committed to the repo, reviewed like
  code, served over git — an attacker must land a tree commit to change a
  pin; swapping bytes on the release side alone fails the sha256 check.
- Transport hardening is shared with ffmpeg-bootstrap: https only (plain
  http for loopback alone), redirect cap, socket timeout, and a byte cap at
  the manifest's pinned size.
- `MSTREAM_SIDECAR_BASE` swaps the URL *base* (internal mirrors, tests);
  the pins still apply, so a lying mirror is refused.

### Distribution stories

| install | behavior |
| --- | --- |
| git clone / npm install, feature off (default) | nothing fetched, ever |
| git clone / npm install, feature enabled | one ~20 MB verified download at first start; clear log lines (`downloading… / checksum verified — installed / ready`) |
| Docker image build | `RUN npm run fetch-p2p-sidecar` bakes the binary at build time |
| air-gapped | pre-fetch on a connected same-platform machine, or `MSTREAM_SIDECAR_BASE` mirror, or hand-place the binary (never touched) |
| upgrade path (old checkouts) | `git pull` deletes the tracked binaries; next start fetches. Old npm versions keep their bundled binaries — nothing breaks retroactively |
| Bun bundles | unchanged (never shipped the sidecar); the runtime fetch actually makes the feature *reachable* from bundles later, since the managed dir is dataRoot |

### First publish after merge (deliberate gap)

The PR ships the manifests as **empty stubs** — it cannot upload assets
itself (no release mutations from a PR). On merge, the workflow-file changes
self-trigger both build workflows on master; their publish jobs create the
release, upload the nine assets, and commit real manifests, all within one
CI cycle (~20 min). In that window a fresh checkout with the feature enabled
logs "no prebuilt binary is published for this platform" and degrades — the
same message any unfetchable platform gets. Nothing else regresses: the
release being *created by GITHUB_TOKEN* cannot trigger other workflows
(GitHub rule, already relied on by every bot-commit in this repo), and
`npm-publish.yml`/`deploy-demo.yml` carry a belt-and-braces tag guard
(`p2p-sidecar-*`, `discovery-models-*`) for the human-touches-the-release
case.

### Operational notes

- **Do not delete or replace assets** on `p2p-sidecar-assets`. If the store
  ever needs pruning, only assets referenced by no manifest in any ref
  anyone builds from are candidates — and even then, deleting breaks
  source-checkout fetches for exactly those historical commits.
- The old `.source-tree`/`.source-tree-musl` stamps are gone (nothing ever
  asserted them; the manifests carry the same tree hash, verified better).
  Nothing in build-bun's tag asserts covers p2p-sidecar — deliberately
  unchanged, since it is not staged into bundles.
- The musl workflow also picked up the pinned-and-hashed `cross` install and
  `--locked` that the glibc workflow already had (it was the last family
  still floating `releases/latest`).

## Phase 2/3 outline: rust-parser and rust-server-audio (not built)

Both families ARE staged into the release bundles by `scripts/build-bun.mjs`
and asserted by build-bun's tag builds, so their moves touch the release
path and deserve their own PRs after this model has survived contact with
production:

- **Same asset store pattern**: per-family rolling prerelease
  (`rust-parser-assets`, `rust-server-audio-assets`), immutable names,
  committed per-family manifests replacing `.source-tree{,-musl}`. The
  publish-job step body is the one proven here with different
  names/paths — worth extracting into a reusable composite action or shared
  script at that point (three copies is past the rule of three).
- **Bundle staging changes**: build-bun.mjs currently copies
  `bin/rust-parser/*` and `bin/rust-server-audio/*` from the checkout; it
  would instead FETCH the manifest-pinned assets at bundle time
  (sha256-verified, same fetch core as `p2p-sidecar-bootstrap.js` — the
  generic parts should be lifted into a shared util then). Windows
  VersionInfo stamping of staged sidecars is unaffected (it already stamps
  the STAGED copy, not bin/).
- **Tag asserts shift shape, not strength**: build-bun's tag build asserts
  today that the committed `.source-tree` stamps match the tag's trees; it
  would assert the committed *manifests'* `sourceTree` fields instead, and
  additionally that every asset it fetched hashed to its pin (an assert the
  stamp model never had). The stale-window failure mode (tag cut inside a
  rebuild window → red run with instructions) is preserved because the
  manifest commit carries the same freshness information the stamp did.
- **Runtime fallback**: the JS scanner fallback already covers a missing
  rust-parser at runtime, and server-audio degrades to CLI players — the
  same graceful-degradation net p2p-sidecar had, so a fetch-on-first-use
  for source/npm users is the same shape. rust-parser is the biggest
  history win (~1.6 GB already, 58 MB × every refresh, 92 refreshes so
  far).
- **Sequencing**: land after the first few p2p-sidecar publish cycles prove
  the append-only store + manifest commits behave; then rust-parser (the
  whale), then rust-server-audio (small, same mechanics).
