# mStream Music

### [Check Out The Demo!](https://demo.mstream.io/)

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

## Discord

[Check out our Discord channel](https://discord.gg/AM896Rr)

### Server Features
* Works Cross Platform. Tested on Windows, OSX, Ubuntu, Arch, and Raspbian
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Runs on ARM board like the Raspberry Pi

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer
* Playlist Sharing
* Upload Files through the file explorer
* AutoDJ - Queues up random songs

### Mobile App Features
* [Available on Google Play](https://play.google.com/store/apps/details?id=mstream.music)
* Easily syncs music to your phone for offline playback
* Multi server support
* Coming soon to iOS

![mStream Web App](/docs/designs/mstreamv4.png?raw=true)

## Install mStream Binaries for Win/OSX/Linux

### [Download the latest versions from our release page](https://github.com/IrosTheBeggar/mStream/releases)

This is the easiest way to install mStream:

* Has no dependencies
* Auto boots server on startup
* Comes with GUI tools for server configuration and management

## Install mStream with Docker

[LinuxServer.io](https://www.linuxserver.io/) have produced a multiarch Alpine container for mStream for `x86-64`, `arm64` & `armhf` which is rebuilt automatically with any base image package updates or new releases of mStream and features persistent database and album images, and the possibility of advanced usage by editing `config.json` directly.

Simply pulling `linuxserver/mstream` should retrieve the correct image for your arch, but you can also pull specific arch images or mStream releases via tags.

See the readme for details on how to get up and running using docker or docker compose on either: 

* [Github](https://github.com/linuxserver/docker-mstream) *or*
* [Docker Hub](https://hub.docker.com/r/linuxserver/mstream)

## Install mStream From The Command Line

If you just want the core part of mStream without all the UI tools, you can install mStream from the NPM or Git repositories. 

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
npm install
sudo npm link 

# To update mStream just pull from git and reboot the server
git pull
```

You can also install mStream through npm with `npm install -g mstream`. This is not recommended since some OSes (like Ubuntu) require sudo to do this.

## Boot mStream

You can boot mstream with the command `mstream`

```shell
# Boot mStream
mstream
```

If that doesn't work (sometimes `npm link` fails on Windows), you can use the alternative command:

```shell
# Boot mStream
node cli-boot-wrapper.js
```

## mStream Config Files

By default, mStream uses the config file `save/conf/default.json`.  If you want to use a different config file, boot mStream with `-j` flag.

```shell
mstream -j /path/to/config.json
```

[The docs on mStream config files](docs/json_config.md)

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
