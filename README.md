# mStream Music

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

## Demo & Other Links

### [Check Out The Demo!](https://demo.mstream.io/)

#### [Discord Channel](https://discord.gg/AM896Rr)

#### [Website](https://mstream.io)

### Server Features
* Cross Platform. Works on Windows, OSX, Linux
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Runs on ARM board like the Raspberry Pi

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer
* Playlist Sharing
* Upload Files through the file explorer

![mStream Web App](/docs/designs/mstreamv4.png?raw=true)

## Installing mStream

* [Install From Source](docs/install.md) - Rolling release with the latest code, bugs included
* [Docker Instructions](https://github.com/linuxserver/docker-mstream) - Stable Releases
* [Binaries for Win/OSX/Linux](https://github.com/IrosTheBeggar/mStream/releases) - Stable Releases & Extra Features. It's built with Electron.  [Read more about it here](/docs/electron.md)
* [AWS Cloud using Terraform](https://gitlab.com/SiliconTao-Systems/nova)

## Quick Install from CLI

Dependencies: NodeJS v10+ or greater

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
npm install

# Boot mStream
node cli-boot-wrapper.js
```

To uninstall mStream run `rm -r mStream`

## Technical Details

* **Dependencies:** NodeJS v10 or greater

* **Supported File Formats:** flac, mp3, mp4, wav, ogg, opus, aac, m4a

## The Docs

[All the details about mStream are available in the docs folder](docs/)

## Credits

mStream is built on top some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The best metadata parser for NodeJS
* [LokiJS](https://github.com/techfort/LokiJS) - A native, in-memory, database written in JavaScript.  LokiJS is the reason mStream is so fast and easy to install
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
