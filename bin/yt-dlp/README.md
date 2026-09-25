# yt-dlp

The YouTube plug-in ("Get it" from YouTube) and the Youtube DL route need
[yt-dlp](https://github.com/yt-dlp/yt-dlp). mStream **fetches it on first
use and keeps it current** (`src/util/yt-dlp-bootstrap.js`); nothing binary
lives in git.

Which copy runs, when `discoveryPlugins.youtube.binary` is left at its
default (`yt-dlp`):

1. **The one installed on this server**, found on PATH — while it is no
   more than 30 days behind the newest release mStream knows of. yt-dlp
   releases every few weeks and YouTube breaks the older ones about as
   often, so a copy a month behind is not a copy worth running.
2. **mStream's own copy** otherwise: the release pinned by the manifests
   here, downloaded into `bin/yt-dlp/` (under the data root, when that is
   not the app root), verified against the committed `sha256` pin, and
   probed with `--version` before it is installed. Then a check shortly
   after boot and every 24 hours moves it to yt-dlp's newest release,
   verified against that release's own `SHA2-256SUMS` — the same integrity
   check yt-dlp's built-in updater makes. A build that reports an older
   version than the installed one never replaces it.

Between two usable copies the newer one wins; the server's own on a tie.
The admin Discovery Plug-ins tab shows which copy answered and, for
mStream's own, when it was last checked.

- `manifest.json` — pins the Windows, macOS (universal) and glibc Linux
  standalone builds of ONE release: `{repo, tag}` plus `{file, sha256,
  size}` per platform key
- `manifest-musl.json` — the same release's musl Linux builds (Alpine /
  linuxserver.io Docker)

Platform keys follow `yt-dlp-{platform}-{arch}[-musl][.exe]` from Node's
`process.platform` / `process.arch`. 32-bit ARM Linux has no standalone
build upstream and is unpinned: install yt-dlp there yourself.

The pin is a **floor, not a ceiling**: it is what a fresh install gets
before its first check, and what a frozen install runs for good. The
monthly workflow (`update-yt-dlp-manifest.yml`, the 5th) re-pins the newest
release; by hand:

    node scripts/update-yt-dlp-manifest.mjs [tag] [--verify]

Never edit the manifests by hand. Old pins stay valid forever — release
assets are immutable — so a skipped month costs nothing.

## Doing it yourself instead

- **Your own yt-dlp**: set `discoveryPlugins.youtube.binary` in the config
  file to a command name or a full path; it is used as it is, never
  measured, never updated — a restart applies it. (Config-file only: the
  admin API never edits an executable path.)
- **Freeze mStream's copy**: `discoveryPlugins.youtube.autoUpdate: false`
  keeps whatever build is installed (air-gapped hosts, a release that
  regressed); the server's own copy is then measured against the pin alone.
- **Pre-fetch for Docker images / air-gapped installs**:
  `npm run fetch-yt-dlp` installs the pin and moves it to the newest
  release (`-- --pin-only` stops at the pin, for a reproducible bake).
- **Internal mirror**: `MSTREAM_YTDLP_BASE` serves the pinned asset under
  its release file name (`yt-dlp_linux`, `yt-dlp.exe`, …) and, for updates,
  `latest/SHA2-256SUMS` + `latest/<file>` (https required; plain http for
  loopback only). The pins still apply; a mirror without `latest/` simply
  never updates.
- **Manual placement**: a `yt-dlp-{platform}-{arch}[-musl][.exe]` you drop
  at the managed path yourself is used as is and never touched — only a copy
  the fetcher installed (recorded in `.fetched.json`) is verified and
  refreshed.

The tests never touch any of this: `MSTREAM_YTDLP_BIN` points them at a
stand-in script and outranks everything above.
