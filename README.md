<p align="center"><b>Own Your Music</b></p>

<p align="center">
  <b>English</b> ·
  <a href="docs/readme/README.es.md">Español</a> ·
  <a href="docs/readme/README.zh.md">中文</a> ·
  <a href="docs/readme/README.fr.md">Français</a> ·
  <a href="docs/readme/README.de.md">Deutsch</a> ·
  <a href="docs/readme/README.pt.md">Português</a> ·
  <a href="docs/readme/README.ja.md">日本語</a> ·
  <a href="docs/readme/README.ru.md">Русский</a> ·
  <a href="docs/readme/README.it.md">Italiano</a> ·
  <a href="docs/readme/README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="docs/designs/readme-hero.png" alt="mStream web player and mobile app" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Try the live demo</b></a> ·
  <a href="https://discord.gg/AM896Rr">Join our Discord</a> ·
  <a href="https://mstream.io/"><b>Website</b></a>
</p>


## Install mStream Server

### Docker

[![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Test it out by running the following command.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[See this page for setting up mStream with docker compose](https://github.com/linuxserver/docker-mstream#usage)

### Binaries for Download

The binary builds come with some extra features not available in the docker version: 

* Automatic updates
* Server side audio playback
* A GUI for setup

The binaries can be downloaded at [mstream.io/server](https://mstream.io/server).

### CLI Scripts

These install the binary versions of mStream through the command line

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Mobile Clients

[<img src="webapp/assets/img/play-store-logo.png" alt="Get mStream on Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="webapp/assets/img/app-store-logo.png" alt="Get mStream on the App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

These apps are [open source](https://github.com/IrosTheBeggar/mstream_music). We offer the [APK files for sideloading](https://github.com/IrosTheBeggar/mstream_music/releases/latest). The APK builds offer some additional features that can't be released in the Play Store builds. These include: support for self-signed certificates, file backup features, and yt-dlp integration.

Also available: [mStream Player by Niera Tech](https://mplayer.nieratech.com/) for [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) and [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Desktop Client

| Platform | Download |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

The desktop app is [open source](https://github.com/IrosTheBeggar/mstream-terminal-player)

## MP3 Player

Coming Soon!


## Unique Features

* **Quick Connect over Iroh** - Connect your server and clients without setting up port-forwarding, SSL certs, DNS, etc.  
* **P2P Music Recommendations** - Built on the Iroh Gossip network protocol.  Get music recommendations from other mStream users.
* **Federation** - connect multiple mStream servers together
* **Auto DJ** - endless playlists that can pull in music from any server in a federated network. It uses the Discogs effNet deep learning local AI model to find tracks that sound similar.


## More Features

**Listen**

* The server is lightweight and will run on lower power systems like a Raspberry Pi
* Transcoding for slow connections
* Jukebox mode: control a browser's playback remotely
* DLNA support
* Automatic album art lookup
* Automatic backups to any drive connected to your server
* Torrent client integration and yt-dlp downloads

## Credits

mStream is built on top of some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The metadata parser used by the JS scanner fallback
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Audio tag reader powering the Rust scanner
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Pure-Rust audio decoder used to render waveform previews during a scan
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript
* [LRCLib](https://lrclib.net/) - Optional source for synced lyrics

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
