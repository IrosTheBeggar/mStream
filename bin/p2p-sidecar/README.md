# p2p-sidecar binaries

The p2p-sidecar (the iroh networking companion for the music-discovery
network) is **fetched on first use, not committed to git**. When the
discovery network is enabled and no binary is present, the server downloads
this platform's build from the project's GitHub release assets into this
directory, verifies its SHA256 against the committed manifest, and probes
that it executes before installing it (`src/util/p2p-sidecar-bootstrap.js`).

- `manifest.json` — glibc Linux, macOS, and Windows builds
- `manifest-musl.json` — statically-linked musl builds (Alpine / linuxserver.io Docker)

Both are written **only** by CI (`.github/workflows/build-p2p-sidecar.yml`
and `build-p2p-sidecar-musl.yml`): each entry pins the release asset's file
name, sha256, and size, plus the `p2p-sidecar/` source-tree hash the set was
built from. Asset names embed those hashes, so they are immutable — a
manifest from any point in history keeps resolving to exactly the bytes it
pins. Never edit the manifests by hand.

Binary naming convention: `p2p-sidecar-{platform}-{arch}[-musl][.exe]`,
matching Node's `process.platform` / `process.arch`, with `-musl` selected at
runtime on musl-libc hosts.

## Doing it yourself instead

The fetch never second-guesses a binary a human put here:

- **Dev builds win outright**: `npm run build-p2p-sidecar` — the server
  prefers `p2p-sidecar/target/release/` over anything in this directory.
- **Manual placement**: drop a `p2p-sidecar-{platform}-{arch}[-musl][.exe]`
  into this directory and it is used as-is (never auto-updated — only
  binaries the fetcher installed itself, recorded in `.fetched.json`, are
  refreshed when the manifest moves).
- **Pre-fetch for Docker images / air-gapped installs**:
  `npm run fetch-p2p-sidecar` downloads and verifies this platform's binary
  ahead of time.
- **Internal mirror**: set `MSTREAM_SIDECAR_BASE` to a URL serving the same
  asset files; the manifest's sha256 pins still apply (https required, plain
  http accepted for loopback only).
