# p2p-sidecar binaries

The p2p-sidecar (the iroh networking companion for the music-discovery
network) lives in its own repo —
[IrosTheBeggar/mstream-p2p-sidecar](https://github.com/IrosTheBeggar/mstream-p2p-sidecar)
— and is **fetched on first use, not committed to git**. When the discovery
network is enabled and no binary is present, the server downloads this
platform's build from the pinned sidecar release into this directory,
verifies its SHA256 against the committed manifest, and probes that it
executes before installing it (`src/util/p2p-sidecar-bootstrap.js`).

- `manifest.json` — pins the glibc Linux, macOS, and Windows builds
- `manifest-musl.json` — pins the statically-linked musl builds
  (Alpine / linuxserver.io Docker)

Each manifest pins `{repo, tag}` plus `{file, sha256, size}` per platform;
the download URL is derived from those pins, never stored. When a new
sidecar release is published, updating the pins is a small text PR:
`node scripts/update-p2p-sidecar-manifest.mjs <tag>` regenerates both files
from the release's `manifest-fragment*.json` assets. Never edit them by
hand.

Binary naming convention: `p2p-sidecar-{platform}-{arch}[-musl][.exe]`,
matching Node's `process.platform` / `process.arch`, with `-musl` selected
at runtime on musl-libc hosts.

Release bundles are different: they ship the sidecar staged next to the
server at build time (and signed on Windows), so bundle installs never hit
this fetch path. It exists for npm, source-checkout, and Docker installs.

## Doing it yourself instead

The fetch never second-guesses a binary a human put here:

- **Dev builds win outright**: clone the sidecar repo into this checkout as
  `p2p-sidecar/` (the directory is gitignored) and `cargo build --release`
  — the server prefers `p2p-sidecar/target/release/` over anything in this
  directory.
- **Manual placement**: drop a `p2p-sidecar-{platform}-{arch}[-musl][.exe]`
  into this directory and it is used as-is (never auto-updated — only
  binaries the fetcher installed itself, recorded in `.fetched.json`, are
  refreshed when the manifest moves).
- **Pre-fetch for Docker images / air-gapped installs**:
  `npm run fetch-p2p-sidecar` downloads and verifies this platform's binary
  ahead of time (zero runtime egress afterwards).
- **Internal mirror**: set `MSTREAM_SIDECAR_BASE` to a URL serving the same
  asset files; the manifest's sha256 pins still apply (https required, plain
  http accepted for loopback only).
