# mStream

[![Downloads](https://img.shields.io/npm/dt/mstream.svg?style=for-the-badge)](https://github.com/IrosTheBeggar/mStream/releases)

### [Check Out The Demo!](https://demo.mstream.io/)

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

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

![mStream Web App](/public/img/designs/mstreamv4.png?raw=true)

## Install mStream Binaries for Win/OSX/Linux

### [Download the latest versions from our release page](https://github.com/IrosTheBeggar/mStream/releases)

This is the easiest way to install mStream.  They have no dependencies so you can just download and run them.  These releases come with an additional set of UI tools and features:

* Adds tray icon for easy server management
* Auto boots server on startup
* Comes with a GUI tools for server configuration
* [No command line needed! Any user can install and run these](https://www.youtube.com/watch?v=IzuxYTaixpU)

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

mStream can be configured with a JSON file that is loaded on boot. You can use the built in wizard to manage this file or read the docs on wo to edit it by hand.

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

## The Docs

[All the details about mStream are available in the docs folder](docs/)
