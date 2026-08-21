# mstream-player binaries

The server-audio engine (formerly the in-tree `rust-server-audio` crate)
lives in its own repo —
[IrosTheBeggar/mstream-terminal-player](https://github.com/IrosTheBeggar/mstream-terminal-player)
— and is **fetched on first use, not committed to git**. It is one binary
with two faces: an interactive terminal player, and the headless jukebox
engine mStream spawns (`mstream-player --port N`, the legacy
rust-server-audio contract). When `autoBootServerAudio` is enabled and no
binary is present, the server downloads this platform's build from the
pinned release into this directory, verifies its SHA256 against the
committed manifest, and probes that it executes (`--version`) before
installing it (`src/util/mstream-player-bootstrap.js`).

- `manifest.json` — pins the glibc Linux, macOS, and Windows builds

The manifest pins `{repo, tag}` plus `{file, sha256, size}` per platform;
the download URL is derived from those pins, never stored. When a new
player release is published, updating the pins is a small text PR:
`node scripts/update-mstream-player-manifest.mjs <tag>` regenerates the
file from the release's own `manifest.json` asset, downloading and
re-hashing every binary before pinning it. Never edit it by hand.

Binary naming convention: `mstream-player-{platform}-{arch}[.exe]`,
matching Node's `process.platform` / `process.arch`. There is no musl
build (server audio needs a sound device — not an Alpine-container
feature); on musl hosts server audio uses the CLI players (MPD, mpv, …)
exactly as before.

Release bundles are different: they ship the player staged next to the
server at build time (and VersionInfo-stamped on Windows), so bundle
installs never hit this fetch path. It exists for npm, source-checkout,
and Docker installs.

## Doing it yourself instead

The fetch never second-guesses a binary a human put here:

- **Dev builds win outright**: clone the player repo into this checkout as
  `mstream-terminal-player/` (the directory is gitignored) and
  `cargo build --release` — the server prefers
  `mstream-terminal-player/target/release/` over anything in this
  directory.
- **Manual placement**: drop a `mstream-player-{platform}-{arch}[.exe]`
  into this directory and it is used as-is (never auto-updated — only
  binaries the fetcher installed itself, recorded in `.fetched.json`, are
  refreshed when the manifest moves).
- **Pre-fetch for Docker images / air-gapped installs**:
  `npm run fetch-mstream-player` downloads and verifies this platform's
  binary ahead of time (zero runtime egress afterwards).
- **Internal mirror**: set `MSTREAM_PLAYER_BASE` to a URL serving the same
  asset files; the manifest's sha256 pins still apply (https required,
  plain http accepted for loopback only).
