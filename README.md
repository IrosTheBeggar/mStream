# mStream Music

**The easiest music streaming sever**

Main|Shared|Admin
---|---|---
![main](/docs/designs/mstreamv5.png?raw=true)|![shared](/docs/designs/shared.png?raw=true)|![admin](/docs/designs/admin.png?raw=true)

## Demo & Other Links

#### [Check Out The Demo!](https://demo.mstream.io/)

#### [Discord Channel](https://discord.gg/AM896Rr)

#### [Website](https://mstream.io)

## Notable Features

mStream has some unique features other server's don't have

#### Album Art Lookup

mStream automatically retrieves album art for your collection

#### Quick Sync - Zero Configuration Deployments

Enable Quick Sync in the Admin Panel to access mStream without setting up port forwarding, DNS, SSL, etc. Quick Sync is a free VPN-like service powered by [Iroh](https://iroh.computer)

NOTE: Quick Sync only works for mobile apps and the upcoming desktop app. The webapp will not work (it's the price of not having to setup DNS/SSL).

#### P2P Discovery

When enabled, this feature will automatically download music discovery data from other mStream servers.  With this data, mStream can show your songs that are not in your collection that are similar to what your are listening to.

Please note, this is discovery only. You will have to find these songs on your own.

#### Federation

You can federate with other servers. Federated servers have read access to eachother's data. With this, your p2p discovery feature can now stream discovered music.

#### Public mode

The demo site does not require you to sign in because mStream is publicly accessible by default.  This makes it easy to setup and gives you the option to keep it publicly available if you are just running it on a secured network. Once you add a user, the system becomes password protected.


## Installing mStream

#### Binaries

**NOTE:** as of v6.13, mStream no longer uses electron to build binaries.  The new binaries comes in two flavors: a minimal build that is just the server, or a batteries included build that comes with all the convenience features (auto update, run server on system boot, etc). The binaries are included on the release page, and the batteries included build will be released soon.

* [Binaries for Win/OSX/Linux](https://github.com/IrosTheBeggar/mStream/releases/latest)

#### Docker

* [Docker Instructions](https://github.com/linuxserver/docker-mstream)

#### Other

* [Install From Source](docs/install.md)
* [AWS Cloud using Terraform](https://gitlab.com/SiliconTao-Systems/nova)

### Docker Compose recipes

Drop-in `compose.yml` recipes for common deployments — see the [cookbook README](docs/docker-compose/) for the full index and per-recipe notes.

* [**default/**](docs/docker-compose/default/) — streaming-only, single linuxserver/mstream container
* [**with-mpd/**](docs/docker-compose/with-mpd/) — adds server-side audio playback via a sidecar MPD container
* [**with-transmission/**](docs/docker-compose/with-transmission/) — mStream + Transmission, with completed downloads served back into the library automatically (Transmission recommended over qBittorrent / Deluge)
* [**ssl-nginx/**](docs/docker-compose/ssl-nginx/) — mStream behind nginx with a Let's Encrypt wildcard cert (acme.sh + Cloudflare DNS-01)
* [**dev/**](docs/docker-compose/dev/) — runs mStream from this repo's source with `node --watch` for hot reload
* [**dev-everything/**](docs/docker-compose/dev-everything/) — `dev/` with DLNA, Subsonic, rust-server-audio, and ALSA passthrough preconfigured

## Mobile Apps

#### Official Android App

[<img src="/webapp/assets/img/play-store-logo.png" alt="mStream Android App" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)

The iOS app is currently in review. You can get early access to it here: https://testflight.apple.com/join/dX37YTzK

#### [Made by Niera Tech](https://mplayer.nieratech.com/)

[<img src="/webapp/assets/img/app-store-logo.png" alt="mStream iOS App" width="200" />](https://apps.apple.com/us/app/mstream-player/id1605378892) [<img src="/webapp/assets/img/play-store-logo.png" alt="mStream Android App" width="200" />](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US)


## Feature List

* Torrent Client Integration - Manage your torrents through mStream
* YT-DLP integration - Download youtube videos as audio files
* DLNA Support
* Automatic Backup Feature - Backup your music to any drive connected to your server
* Transcoding
* Subsonic API support
* Auto DJ - Automatically queue up songs
* Lyrics Support - includes being able to search by lyrics
* Jukebox Mode - Control your browser remotely
* Local server audio playback - Note, will not work on Docker

## Credits

mStream is built on top of some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The metadata parser used by the JS scanner fallback
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Audio tag reader powering the Rust scanner
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Pure-Rust audio decoder used to render waveform previews during a scan
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript
* [LRCLib](https://lrclib.net/) - Optional source for synced lyrics

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
