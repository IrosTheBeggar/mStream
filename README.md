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

mStream has some unique features other server's don't have

**Filesystem based API** 

The mStream API is built to reflect your folder structure. This gives is some interesting features:
- You are able to browse and play music before the DB is built
- You can upload files and create directories
- YT-dlp support built in. Save music from youtube to wherever you want in your filesystem
- **Coming Soon** Torrent management

**Public mode** 

You might notice the demo site does not require you to sign in. mStream is publicly accessible by default.  This makes it easy to setup and gives you the option to keep it publiccly available if you are just running it locally. Once you add a user, the system becomes password protected.

**Multiple installation methods** 

mStream has three installation methods:
- A Docker image managed by linuxserver.io
- Executable installers (exe, dmg. appimage) for Win/Mac/Linux
- Install from source. Only one dependency (NodeJS)

**Supports additional protocols**

- Subsonic API
- DLNA/UPnP

### Server Features
* **Granular write permissions** — `lockAdmin` panic-button plus independent `noUpload` / `noMkdir` / `noFileModify` toggles. Tune live from the admin UI
* **Auto-DJ with BPM continuity, harmonic mixing, similar-artists, and genre filtering** 
* **Multi-user accounts** with per-library access control (when you need them)
* **On-the-fly transcoding** via ffmpeg
* **Server-side audio playback** for headless boxes (Rust audio engine + CLI fallback)
* **Multi-threaded Rust scanner** Fast and efficient file scanner
* **Light on memory and CPU**, tested on multi-terabyte libraries

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer ([Butterchurn](https://github.com/jberg/butterchurn))
* Playlist Sharing via signed links
* Upload, create, and rename files through the file explorer
* Synced + plain lyrics (embedded, sidecar `.lrc`, or [LRCLib](https://lrclib.net/) — opt-in)
* Waveform renderer
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

## Subsonic API Setup

**Subsonic is disabled by default.** Enable it via the admin panel's Subsonic page. Two modes are supported:

| Mode             | Behavior                                                                                                         |
|------------------|------------------------------------------------------------------------------------------------------------------|
| `disabled`       | Default. The `/rest/*` Subsonic endpoints aren't mounted. Clients get a 404.                                     |
| `same-port`      | Subsonic mounts on the main mStream port. One TCP port for everything — simplest for reverse proxies.            |
| `separate-port`  | Subsonic listens on its own port (default 3012). Useful if you want to firewall Subsonic separately, or terminate TLS differently per surface. |

### Authentication methods

mStream supports three Subsonic auth methods. Pick whichever your client supports:

| Method                                | What the client sends            | Setup            | Security note |
|---------------------------------------|----------------------------------|------------------|---------------|
| **API key** (OpenSubsonic extension)  | `apiKey=<opaque>`                | Mint via the mobile-clients panel; opaque token, revocable per-key. | **Best.** No password ever leaves the client. Scoped, revocable. |
| **Plaintext password** (`u/p`)        | `u=<user>&p=<plaintext>` or `p=enc:<hex>` | Works against your main mStream password OR an opt-in Subsonic-specific password (see below). | Sent in the clear unless you're behind HTTPS. |
| **Token auth** (`t/s`)                | `u=<user>&t=md5(pw+salt)&s=<salt>` | **Requires** an opt-in Subsonic-specific password. See below. | Avoids sending the plaintext over the wire, but requires recoverable server-side storage of the password. |

### Why a separate Subsonic password?

mStream stores your main account password as a **PBKDF2 hash**. This is secure, because it's impossible to derive the password from. However this makes it incompatible with Subsonic Token Auth (which is used by many clients). Subsonic Token Auth requires the server to *know* the plaintext password to verify the client's hash, but mStream stores hashed passwords that cannot be used to derive the plaintext password.

Since mStream security model is fundamentally incompatible with Subsonic Token Auth, the user can create a Subsonic only password that is stored AES-256-GCM encrypted with a server-side secret.

mStream's web UI exposes a panel for managing all Subsonic credentials. The panel only appears when Subsonic is enabled:

![Subsonic mobile panel](/docs/designs/subsonic-panel.png?raw=true)

From here you can:
- Set, change, or clear your Subsonic-specific password
- Mint and revoke API keys
- See last-used timestamps for each API key

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
