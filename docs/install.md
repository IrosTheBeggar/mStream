# Standalone binary bundles (no Node.js required)

Pre-built, self-contained server bundles are attached to each
[GitHub release](https://github.com/IrosTheBeggar/mStream/releases) as
`mStream-<version>-<platform>.zip` (win-x64, linux-x64, linux-arm64,
linux-x64-musl, linux-arm64-musl, darwin-x64, darwin-arm64). They embed their own
runtime — no Node.js install.

A bundle is a **folder**, not a single file: the server binary plus `webapp/`
(the UI) and `bin/` (sidecar binaries). Keep them together and run the binary
**in place** — it creates its database, config, and caches next to the binary on
first run (under `save/`).

```shell
# Linux / macOS (Windows: just extract the .zip in Explorer)
unzip mStream-<version>-linux-x64.zip
cd mStream-<version>-linux-x64
./mStream-linux-x64
# then open http://localhost:3000
```

On first run it creates `save/conf/default.json`. Edit it to add your music and
restart, or pass your own config with `-j <path>`:

```json
{ "port": 3000, "folders": { "music": { "root": "/absolute/path/to/music" } } }
```

**Platform notes**

* **Windows** — run `mStream.exe`.
* **macOS** — the bundle is `mStream.app`. It is a *portable* app: run it where
  you extracted it (it writes its data inside the bundle). Do **not** move it
  into `/Applications` (app data can't be written there). To see logs, launch
  from a terminal: `./mStream.app/Contents/MacOS/mStream`.
* **Linux** — a `mStream.desktop` launcher and `mStream.png` icon are included
  for adding mStream to your application menu. Before using the launcher, replace
  the `%INSTALL_DIR%` placeholders in `mStream.desktop` with the absolute extract
  path (or run `desktop-file-install`). Running the binary directly needs no
  setup.
* **Alpine / musl Linux** — use the `*-musl` bundle (the glibc Linux build can't
  run on musl). Bun's musl binary needs the GNU C++ runtime: `apk add libstdc++`.
  For transcoding/waveforms also `apk add ffmpeg`.
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
