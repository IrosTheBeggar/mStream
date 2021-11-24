# mStream Music

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

Main|Shared|Admin
---|---|---
![main](/docs/designs/mstreamv5.png?raw=true)|![shared](/docs/designs/shared.png?raw=true)|![admin](/docs/designs/admin.png?raw=true)

## Demo & Other Links

### [Check Out The Demo!](https://demo.mstream.io/)

#### [Discord Channel](https://discord.gg/AM896Rr)

#### [Website](https://mstream.io)

### Server Features
* Cross Platform. Works on Windows, OSX, Linux, & FreeBSD
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Runs on ARM boards like the Raspberry Pi

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer
* Playlist Sharing
* Upload Files through the file explorer

## Installing mStream

* [Install From Source](docs/install.md)
* [Docker Instructions](https://github.com/linuxserver/docker-mstream)
* [Binaries for Win/OSX/Linux](https://mstream.io/server) - mStream binaries are compiled with Electron and have some extra features
  - Runs in background and starts mStream on boot
  - Automatic updates
  - Adds a tray icon to manage mStream
* [AWS Cloud using Terraform](https://gitlab.com/SiliconTao-Systems/nova)

## Quick Install from CLI

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
npm install --production

# Boot mStream
node cli-boot-wrapper.js
```

## Android App

[![mStream Android App](https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png)](https://play.google.com/store/apps/details?id=mstream.music&hl=en_US&gl=US)

[This App is Open Source. See the Source Code](https://github.com/IrosTheBeggar/mstream_music/releases)

## Technical Details

* **Dependencies:** NodeJS v10 or greater

* **Supported File Formats:** flac, mp3, mp4, wav, ogg, opus, aac, m4a

## Credits

mStream is built on top some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The best metadata parser for NodeJS
* [LokiJS](https://github.com/techfort/LokiJS) - A native, in-memory, database written in JavaScript.  LokiJS is the reason mStream is so fast and easy to install
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
