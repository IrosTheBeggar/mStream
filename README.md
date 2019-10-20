# mStream

### [Check Out The Demo!](https://demo.mstream.io/)

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

### Server Features
* Works Cross Platform. Tested on Windows, OSX, Ubuntu, Arch, and Raspbian
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Runs on ARM board like the Raspberry Pi
* Federation

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

![mStream Web App](/public/img/designs/mstreamv4.png?raw=true)

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

## Configuring and Booting

mStream can be configured with a JSON file that is loaded on boot. You can use the built in wizard to manage this file or [read the docs on how to edit it by hand.](docs/json_config.md)

```shell
# Brings up an interactive shell program to edit all things in the config
mstream --wizard /path/to/config.json

# Boot mStream with the config file
mstream -j /path/to/config.json
```

## Quick Test Configurations

[Command line flags can be used to test different mStream configurations](docs/cli_arguments.md)

```shell
# the login system will be disabled if these values are not set
mstream -u username -x password
# set music directory
mstream -m /path/to/music
```

## Federation

mStream now supports Federation. Powered by [SyncThing](https://syncthing.net/).

Federation lets you share directories with other mStream servers.  To federate a directory from a another server, you just need an invite token from that server.  To generate an invite you have two options:

Public Invitation - A public invite token can be used by any device (before it expires).  Your mStream server needs to be available on a public domain name during the invitation process.

Private Invitation - Every mStream server comes with a Federation ID.  You can generate a private invite if you have the Federation ID of the server you want to invite.  This method does not require your server to be publicly available.

The Federation process one-way.  If you invite someone else, changes they make on their server will not be pushed to your server.  But changes you make will be pushed to to all servers you have invited.

To use Federation you need to boot mStream with a config file.  This is because the Federation process will modify this file to manage directories and permissions.  You just need to add the following to the config file: 

```
federation: {
    "folder": "/Users/username/federation"
}
```

Without this, Federation will be disabled.

## Contributing

Interested in getting in contact?  [Check out our Discord channel](https://discordapp.com/channels/614134709248589845/614134709248589847)

## The Docs

[All the details about mStream are available in the docs folder](docs/)

## Credits

mStream is is built on top some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The best metadata parser for NodeJS
* [LokiJS](https://github.com/techfort/LokiJS) - A native, in-memory, database written in JavaScript.  LokiJS is the reason mStream is so fast and easy to install
* [Audioplayers](https://github.com/luanpotter/audioplayers) - Cross platform audio library for Android and iOS that powers the mobile apps
* [Howler](https://github.com/goldfire/howler.js) - An audio library that powers the WebApp
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript
* [WebAmp](https://github.com/captbaritone/webamp) - A WinAmp clone that works in the browser


And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!