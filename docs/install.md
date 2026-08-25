# Standalone binary bundles (no Node.js required)

Pre-built, self-contained server bundles are attached to each
[GitHub release](https://github.com/IrosTheBeggar/mStream/releases) as
`mStream-<version>-<platform>.zip` (win-x64, linux-x64, linux-arm64,
linux-x64-musl, linux-arm64-musl, darwin-x64, darwin-arm64). They embed their own
runtime — no Node.js install.

A bundle is a **folder**, not a single file: the desktop launcher, the server
binary (`mstream-server`), `webapp/` (the UI), and `bin/` (sidecar binaries).
Keep them together; the bundle itself can live anywhere.

## Install with one command

The install scripts pick the right bundle for your machine (OS, CPU, and on
Linux glibc-vs-musl), verify its sha256 against the release's `manifest.json`,
extract it into a versioned folder, and wire up a `mstream-server` command
plus an app-menu / Start Menu / `~/Applications` entry. Re-running upgrades in
place; your data is never inside the app folder, so it is never touched.

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

Where things land: the app folders under `~/.local/share/mstream/app/`
(Linux), `~/Library/Application Support/mStream/app/` (macOS), or
`%LOCALAPPDATA%\Programs\mStream\` (Windows), with `current` pointing at the
active version; the `mstream-server` command in `~/.local/bin` (Linux/macOS) or
via the user PATH (Windows). Optional knobs, all environment variables:
`MSTREAM_VERSION` (a tag; default latest — releases from v6.20.2 on carry the
`manifest.json` the script needs), `MSTREAM_INSTALL_DIR`, `MSTREAM_BIN_DIR`
(unix), `MSTREAM_NO_PATH` (Windows), `MSTREAM_NO_DESKTOP`, `MSTREAM_KEY` (unix:
force a bundle key when auto-detection is wrong), `MSTREAM_FORCE` (replace an
already-installed copy of the same version; the old one is moved aside), and
`MSTREAM_RELEASE_BASE` (a URL serving `manifest.json` + the zips, for internal
mirrors). Older versions are kept beside `current` for rollback — once mStream
is no longer running from one, delete it whenever you like.

Re-running to upgrade re-points the app-menu / Start Menu entry and the
login item at the new version, but never stops a running mStream: Quit it
from the tray icon and start it again to switch. A copy you extracted by hand
somewhere else (or run with `--portable`) is left untouched — the script only
manages its own folder.

## Automatic updates

mStream checks the release feed once a day (plus once shortly after boot)
and, by default, **updates itself**: new versions download in the
background, stage beside the running one behind `current`, and apply on
their own once the server is genuinely idle — nothing streaming, no scan
running, and a quiet stretch (about ten minutes) since the last request,
so a restart never lands under someone actively browsing. Under the tray
app the restart is seamless; a `.pkg` install downloads the verified
installer and waits for your click (Installer.app needs a human). The
admin panel's About page shows the state and holds the controls:

- `updates.mode` — `auto` (the default, described above), `stage`
  (download and stage only; applying takes a restart or a click — the
  previous default), or `notify` (report only, download nothing). A mode
  set in the config stays exactly as set — the default only fills the
  blank. On a headless install, `auto` applies by exiting with code 0 so
  the process supervisor's restart lands on the new version — but only
  when a supervisor that restarts on a clean exit is actually detectable:
  pm2, or systemd with `Restart=always`/`on-success` (the default
  `Restart=no` and `on-failure` don't restart an exit 0, so they don't
  count). For supervisors mStream can't see — a docker `--restart` policy,
  runit, your own wrapper loop — set `MSTREAM_SUPERVISED=1`. With nothing
  detected, `auto` behaves like `stage` and says so in the log and the
  admin panel: exiting would be an outage, not an apply.
- `updates.check` — set `false` and mStream never phones home; the admin
  panel's "check now" button still works on demand.

Auto became the default only once the whole recovery ladder was in place:
a release is sha256-verified and boot-probed **before** it can take over a
working install, and one that still crashes at first boot is rolled back
and held automatically — by the tray app on desktops, by the server binary
itself headless — until a newer release ships. A bad release followed by a
fixed one heals end to end with no operator action.

The check and the downloads honor `MSTREAM_RELEASE_BASE` for mirrors, verify
every download against the release's `manifest.json` sha256s, and only ever
stage into layouts the installer owns: package-manager installs (deb/rpm,
the macOS `.pkg`), Docker, npm, and hand-extracted copies are told about
updates but never touched. Before switching an install to a freshly
extracted version, the installers probe it twice: `-V` (does the binary
run here at all) and `--boot-probe` (would it actually *boot* — the new
build loads its module graph, runs your existing config through its
schema, and opens the database read-only, all without writing anything).
A version that fails either probe never takes over a working install: the
stage fails loudly and the next release retries.

If an applied update crashes before it ever serves, the desktop launcher's
**boot watchdog** rolls it back on its own: after a failed retry it
re-points `current` at the previous version (kept on disk for exactly this),
restores the `~/Applications` copy on macOS, relaunches, and records the
failed version in `update-hold.json` so the daily check doesn't re-stage it.
The admin panel shows the held version; the hold clears automatically the
moment a release newer than it ships (or by hand via the panel's
"clear hold & retry"). Headless installs have their own watchdog built into
the server binary itself: it counts boot attempts before any of the work
that can crash, and on the third failed boot of the version `current` is
committed to, it rolls `current` back, records the hold, and hands that
very invocation over to the previous version's binary — no supervisor
required (set `MSTREAM_BOOT_WATCHDOG=0` to disable it). The server-side
guards back both watchdogs up: a held version is never staged or applied,
and a `current` link left on one is re-pointed at the running version.

Rolling back? Re-run the installer with `MSTREAM_VERSION=<old tag>`, restart,
and then **skip the bad release** (the admin panel's skip link, or
`updates.skipVersion` in the config) — otherwise the next daily check
re-stages the very version you just backed out of. A staged version that
gets skipped is un-staged on the spot: `current` returns to the running
version. The skip clears itself the moment a newer release ships.

To uninstall, run the same one-liner with `MSTREAM_UNINSTALL=1` set: it
removes the app folders, the `mstream-server` command, the menu / Start Menu /
`~/Applications` entry, and the login item — and leaves your library, config,
and database in the data directory for you to keep or delete.

Prefer to do it by hand? Every release from v6.20.2 on also lists the zips
directly, with `manifest.json` holding their sha256s:

**Just double-click it.** The desktop face of the bundle — `mStream.exe` on
Windows, `mStream.app` on macOS, `mstream-desktop` on Linux — starts the
server in the background, puts an mStream icon in your tray / menu bar
(a status line — "Running · up 3h 12m", or Starting… / Stopped — then Open
mStream · Quick Connect · Start at login · View logs · Restart server · Quit),
and opens your browser at the player. Start-at-login is on by default; one
click in the tray menu turns it off.

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
  `mstream-server`. The tray app needs glibc ≥ 2.31 (Debian 11 / Ubuntu
  20.04 or newer); on older distros (e.g. RHEL/Rocky 8) run
  `mstream-server` directly — the server itself has a much lower floor.
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
