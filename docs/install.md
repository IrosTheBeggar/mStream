# Standalone binary bundles (no Node.js required)

Pre-built, self-contained server bundles are attached to each
[GitHub release](https://github.com/IrosTheBeggar/mStream/releases) as
`mStream-<version>-<platform>.zip` (win-x64, linux-x64, linux-arm64,
linux-x64-musl, linux-arm64-musl, darwin-x64, darwin-arm64). They embed their own
runtime — no Node.js install.

A bundle is a **folder**, not a single file: the desktop launcher, the server
binary (`mstream-server`), `webapp/` (the UI), and `bin/` (sidecar binaries).
Keep them together; the bundle itself can live anywhere.

**Just double-click it.** The desktop face of the bundle — `mStream.exe` on
Windows, `mStream.app` on macOS, `mstream-desktop` on Linux — starts the
server in the background, puts an mStream icon in your tray / menu bar
(Open mStream · Quick Connect · Start at login · Restart server · Quit), and
opens your browser at the player. Start-at-login is on by default; one click
in the tray menu turns it off.

**Terminal users lose nothing.** The same desktop binary run from a terminal
behaves exactly like the server itself (same flags, output, and exit codes) —
or run `mstream-server` directly, which is also the right entry for headless
boxes and service managers:

```shell
# Linux / macOS (Windows: just extract the .zip in Explorer)
unzip mStream-<version>-linux-x64.zip
cd mStream-<version>-linux-x64
./mstream-server
# then open http://localhost:3000
```

**Where your data lives.** On first run the binary creates its config,
database, and caches in your user data directory:

| OS | Data directory |
|---|---|
| Windows | `%LOCALAPPDATA%\mStream` |
| macOS | `~/Library/Application Support/mStream` |
| Linux | `$XDG_DATA_HOME/mstream` (default `~/.local/share/mstream`) |

The config is `conf/default.json` in there. Edit it to add your music and
restart, or pass your own config with `-j <path>`:

```json
{ "port": 3000, "folders": { "music": { "root": "/absolute/path/to/music" } } }
```

Upgrading an older bundle that already has a `save/conf/default.json` next to
the binary? That config keeps being used — nothing moves. To get the same
next-to-binary layout on a fresh install (USB stick, one-folder deployments),
run with `--portable`.

**Quick Connect is on by default** in the config the binary generates: the web
UI shows a Quick Connect code/QR that the mStream apps can use to connect from
anywhere — no port forwarding. It's the standard connection setup for this
install method. For a headless box that shouldn't run a remote-access tunnel
by default, launch with `--quick-connect-off-by-default` (e.g. in a systemd
unit): the first-run config is then generated with it disabled. The flag only
shapes that generated default — it never changes an existing config, so
enabling Quick Connect yourself later always sticks, flag or no flag.

**Platform notes**

* **Windows** — double-click `mStream.exe` (the tray launcher). The server
  itself is `mstream-server.exe`, for terminals and services.
* **macOS** — the bundle is `mStream.app`; opening it puts mStream in the menu
  bar. Data lives in `~/Library/Application Support/mStream`, so the app can
  live anywhere, including `/Applications`. To see server logs in a terminal,
  run `./mStream.app/Contents/MacOS/mstream-server`. (Older installs that
  wrote data inside the bundle keep working in place — see the upgrade note
  above.)
* **Linux** — `mstream-desktop` is the tray app (needs a system-tray/
  StatusNotifier host; the server keeps running fine without one). A
  `mStream.desktop` entry and `mStream.png` icon are included for your app
  menu — replace the `%INSTALL_DIR%` placeholders with the absolute extract
  path (or run `desktop-file-install`). Headless boxes just run
  `mstream-server`.
* **linux-arm64 and musl bundles ship server-only** (no tray launcher): those
  targets are overwhelmingly headless (Pi servers, Alpine/NAS containers).
  Their entry point is `mstream-server`, exactly as before.
* **Alpine / musl Linux** — use the `*-musl` bundle (the glibc Linux build can't
  run on musl). Bun's musl binary needs the GNU C++ runtime: `apk add libstdc++`.
  For transcoding/waveforms also `apk add ffmpeg`.
  **Known limitation:** the discovery/recommendation embedding model runs on
  onnxruntime, which ships glibc-only binaries — it cannot load on musl (and
  Alpine's `gcompat` shim is not sufficient: onnxruntime needs fortified glibc
  symbols the shim doesn't implement). Everything else works, but
  recommendations/Discover/sonic Auto-DJ won't build their data on musl —
  including Alpine-based Docker images. Use a glibc system or a Debian/Ubuntu-
  based image for that feature; the server detects this case, logs one clear
  error, and disables the embedding pass instead of retrying it.
* The fast Rust library scanner needs glibc ≥ 2.34 on glibc systems; on older
  glibc it automatically falls back to a portable static build, so scanning stays
  fast. ffmpeg (transcoding/waveforms) is auto-downloaded on first use, or
  install it via your package manager.

---

# Install from source (Ubuntu)

**Dependencies**

* NodeJS and NPM
* git

[How to Install NodeJS](https://nodejs.org/en/download/package-manager/)

# Install mStream

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install dependencies and run
npm run-script wizard
```

# Running mStream as a Background Process

We will use [PM2](https://pm2.keymetrics.io/) to run mStream as a background process

```shell
# Install PM2
npm install -g pm2

# Run app
pm2 start cli-boot-wrapper.js --name mStream
```

[See the PM2 docs for more information](https://pm2.keymetrics.io/docs/usage/quick-start/)

# Updating mStream

To update mStream just pull the changes from git and reboot your server

```shell
git pull
npm install --only=prod
# Reboot mStream with PM2
pm2 restart all
```
