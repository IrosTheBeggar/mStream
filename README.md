# mStream Music

**The music server that's also a file manager.**
Drop a file in your folder, upload one through the web UI, or paste a YouTube link — it plays. No accounts to set up, no scan to wait for.

Main|Shared|Admin
---|---|---
![main](/docs/designs/mstreamv5.png?raw=true)|![shared](/docs/designs/shared.png?raw=true)|![admin](/docs/designs/admin.png?raw=true)

## Demo & Other Links

#### [Check Out The Demo!](https://demo.mstream.io/)

#### [Discord Channel](https://discord.gg/AM896Rr)

#### [Website](https://mstream.io)

## Why mStream?

Most self-hosted music servers — Navidrome, Jellyfin, Plex, Airsonic — scan your files into a database and show you *their* version of your library: virtual albums, hidden paths, files invisible until the next index run. Useful, but it means giving up the folder structure you built.

mStream's native API takes the opposite approach. The file browser **is** the music browser. The `/media/<library>/` route streams files directly from disk via `express.static` — no per-request database lookup. Add a file to a watched folder and it's available immediately, on the next page refresh. The same web UI lets you upload, mkdir, rename, and download from YouTube — no SFTP or Docker volume gymnastics required.

|                                  | mStream                 | Navidrome / Jellyfin / Plex |
|----------------------------------|-------------------------|------------------------------|
| User account required to start   | Optional (public mode)  | Required                     |
| Upload via web UI                | Yes (file explorer)     | No (Funkwhale has it)        |
| YouTube → library                | Yes (yt-dlp wrapper)    | No                           |
| New file appears in browser      | Immediately             | After scan                   |
| Folder hierarchy preserved       | Yes                     | Hidden behind virtual library |
| First-party desktop apps         | Server + Player         | Plex yes; FOSS servers no    |
| Open source                      | Yes (GPL-3.0)           | Plex no, others yes          |

**Public mode** is the "trusted local network" config: no user accounts required, every client gets full library access. It's the fastest path from `git clone` to playing music — point mStream at a folder, run it, browse, play. Add real users when you actually need them. For wider exposure, the admin API exposes `lockAdmin` to disable all writes server-wide, plus independent `noUpload` / `noMkdir` / `noFileModify` toggles for granular control.

**Polished on both ends.** mStream ships as two distinct desktop apps: **mStream Server**, a tray-resident server with auto-update and boot-on-startup, and **mStream Desktop Player**, a native window for the web UI on machines where you'd rather not have a browser tab open. For headless deployment, the [official LinuxServer.io Docker image](https://github.com/linuxserver/docker-mstream) and `npm install` from source are first-class alternatives.

**The Subsonic API caveat:** third-party Subsonic clients (DSub, Symfonium, Substreamer) require the index to be populated for metadata-driven features — that's a Subsonic protocol limitation, not an mStream limitation. The "drop and play" experience is in the native UI; Subsonic clients still need a scan first.

### Server Features
* **Folder-faithful library** — files stream from `/media/<library>/` via `express.static`; no per-request database lookup, no scan required to play
* **Manage music from the music server** — upload, mkdir, rename via the file explorer; download from YouTube via `yt-dlp` integration. The web UI doubles as a file manager
* **Public mode** — run with no user accounts on a trusted network; configure libraries and start streaming in one command
* **Granular write permissions** — `lockAdmin` panic-button plus independent `noUpload` / `noMkdir` / `noFileModify` toggles. Tune live from the admin UI
* **Server runs as a desktop app** — Windows (NSIS) / macOS (DMG) / Linux (AppImage) installers with system tray, auto-update, boot-on-startup. Or use the [official LSIO Docker image](https://github.com/linuxserver/docker-mstream) for headless deployment
* **mStream Desktop Player** — the mStream UI delivered as a native desktop app on Windows / macOS / Linux instead of a browser tab. Requires a running mStream server (local or remote)
* **[Subsonic / OpenSubsonic API](https://opensubsonic.netlify.app/)** — works with DSub, play:Sub, Symfonium, Feishin, Supersonic, and other Subsonic clients
* **Full-text search** — SQLite FTS5 with BM25 ranking and unicode diacritic folding (e.g. `ros` matches `Sigur Rós`). Surfaced through both the webapp search panel and Subsonic `search3`. A per-request `algorithm` param on `/api/v1/db/search` exposes a `basic` LIKE escape hatch for queries that need infix matching
* **Auto-DJ with BPM continuity, harmonic mixing, and similar-artists** — `POST /api/v1/db/random-songs` accepts BPM windows (including octave-equivalent half/double tempo), Camelot key codes (`1A`..`12B`, expanded to every spelling the DB might contain), and library-resolved similar-artist names from `GET /api/v1/lastfm/similar-artists`. A multi-step fallback waterfall progressively relaxes constraints until at least one track matches, with a tier filter that prefers in-range picks over unknown-tag picks over known-wrong picks. The scanner extracts BPM/key from `TBPM`/`TKEY` (ID3v2) and `BPM`/`KEY`/`INITIALKEY` (Vorbis) tags at scan time
* **Multi-user accounts** with per-library access control (when you need them)
* **DLNA / UPnP** for casting to TVs and stereos
* **On-the-fly transcoding** via ffmpeg (opus, mp3, aac)
* **Server-side audio playback** for headless boxes (Rust audio engine + CLI fallback)
* **Multi-threaded Rust scanner** — file-level parallelism via rayon, cgroup-aware thread sizing (Docker / k8s CPU quotas honored), backpressured pipeline. Generates 800-bar waveform previews during scan. JS fallback for max compatibility
* **Cross platform** — Windows, OSX, Linux, FreeBSD, ARM
* **Light on memory and CPU**, tested on multi-terabyte libraries

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer ([Butterchurn](https://github.com/jberg/butterchurn))
* Playlist Sharing via signed links
* Upload, create, and rename files through the file explorer
* Synced + plain lyrics (embedded, sidecar `.lrc`, or [LRCLib](https://lrclib.net/) — opt-in)
* Waveform previews rendered at scan time
* Album art auto-fetch from MusicBrainz, iTunes, and Deezer
* Admin UI for server configuration

## Installing mStream

* [Docker Instructions](https://github.com/linuxserver/docker-mstream)
* [Binaries for Win/OSX/Linux](https://mstream.io/server)
* [Install From Source](docs/install.md)
* [AWS Cloud using Terraform](https://gitlab.com/SiliconTao-Systems/nova)

## Mobile Apps

[<img src="/webapp/assets/img/app-store-logo.png" alt="mStream iOS App" width="200" />](https://apps.apple.com/us/app/mstream-player/id1605378892)

[<img src="/webapp/assets/img/play-store-logo.png" alt="mStream Android App" width="200" />](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US)

[Made by Niera Tech](https://mplayer.nieratech.com/)

## Subsonic API

mStream serves the [Subsonic / OpenSubsonic API](https://opensubsonic.netlify.app/) so any third-party Subsonic client (Symfonium, DSub, substreamer, Sonixd, Feishin, Supersonic, …) can stream from your library.

### Enabling Subsonic

**Subsonic is disabled by default.** Enable it via the admin panel's Subsonic page (or in `config.json` under `subsonic.mode`). Two modes are supported:

| Mode             | Behavior                                                                                                         |
|------------------|------------------------------------------------------------------------------------------------------------------|
| `disabled`       | Default. The `/rest/*` Subsonic endpoints aren't mounted. Clients get a 404.                                     |
| `same-port`      | Subsonic mounts on the main mStream port. One TCP port for everything — simplest for reverse proxies.            |
| `separate-port`  | Subsonic listens on its own port (default 3012). Useful if you want to firewall Subsonic separately, or terminate TLS differently per surface. |

Once enabled, point your client at `http://your-server:<port>/rest`.

### Authentication methods

mStream supports three Subsonic auth methods. Pick whichever your client supports:

| Method                                | What the client sends            | Setup            | Security note |
|---------------------------------------|----------------------------------|------------------|---------------|
| **API key** (OpenSubsonic extension)  | `apiKey=<opaque>`                | Mint via the mobile-clients panel; opaque token, revocable per-key. | **Best.** No password ever leaves the client. Scoped, revocable. |
| **Plaintext password** (`u/p`)        | `u=<user>&p=<plaintext>` or `p=enc:<hex>` | Works against your main mStream password OR an opt-in Subsonic-specific password (see below). | Sent in the clear unless you're behind HTTPS. |
| **Token auth** (`t/s`)                | `u=<user>&t=md5(pw+salt)&s=<salt>` | **Requires** an opt-in Subsonic-specific password. See below. | Avoids sending the plaintext over the wire, but requires recoverable server-side storage of the password. |

### Why a separate Subsonic password?

mStream stores your main account password as a **PBKDF2 hash** — one-way, can't be reversed. That's the right thing for a server that gives users filesystem write access.

But the Subsonic protocol's token authentication requires the server to *know* the plaintext password to verify the client's hash. PBKDF2 hashes can't do that. So mStream gives you an **opt-in second password**, used only for Subsonic, stored AES-256-GCM encrypted with a server-side secret. You set it from the **mobile-clients panel** in the web UI.

**Trade-off**: this Subsonic-only password is recoverable on the server (the encryption key lives in `config.json`'s `subsonicSecret`). It's intentionally less secure than your main password — that's the whole point of keeping them separate. We recommend choosing a different value than your mStream login.

If you only use API-key clients (or your client supports the plaintext `u/p` mode), you don't need to set a Subsonic password at all.

### The mobile-clients panel

mStream's web UI exposes a panel for managing all Subsonic credentials:

![Subsonic mobile panel](/docs/designs/subsonic-panel.png?raw=true)

From here you can:
- Set, change, or clear your Subsonic-specific password
- Mint named API keys (the key string is shown once on creation — copy it into your client immediately)
- See last-used timestamps for each API key
- Revoke any API key

The panel only appears when Subsonic is enabled.

## Quick Install from CLI

Deploying an mStream server is simple.

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install dependencies and run
npm run-script wizard
```

## Technical Details

* **Dependencies:** NodeJS v22.5 or greater
* **Database:** SQLite (via `node:sqlite`) — no external DB server required
* **Scanner:** Pre-built Rust binary (Linux x64/arm/arm64 + musl, macOS x64/arm64, Windows x64); falls back to a pure-JS scanner when no binary matches the host
* **Supported File Formats:** flac, mp3, wav, ogg, opus, aac, m4a, m4b
* **APIs:** mStream `/api/v1` (REST, [OpenAPI spec](docs/openapi.yaml)) and Subsonic `/rest` (1.16.1 + OpenSubsonic extensions)

## Credits

mStream is built on top of some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The metadata parser used by the JS scanner fallback
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Audio tag reader powering the Rust scanner
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Pure-Rust audio decoder used to render waveform previews during a scan
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript
* [Syncthing](https://syncthing.net/) - Powers federation between mStream servers
* [LRCLib](https://lrclib.net/) - Optional source for synced lyrics

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
