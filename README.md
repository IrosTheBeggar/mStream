# mStream

[![Downloads](https://img.shields.io/npm/dt/mstream.svg?style=for-the-badge)](https://github.com/IrosTheBeggar/mStream/releases)

### [Check Out The Demo!](https://demo.mstream.io/)

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

### Server Features
* Works Cross Platform. Tested on Windows, OSX, Ubuntu, Arch, and Raspbian
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Get the [latest stable binaries] from the release page. Or get the latest and greatest code by [installing and configuring the CLI version](#install-mstream-from-the-command-line)

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

![mStream Webapp](/public/img/designs/mstreamv4.png?raw=true)

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

## Quick Start

* [Command line flags can be used to test different mStream configurations](docs/cli_arguments.md)

To test your installation, run the command `mstream`.  This will boot an mStream server on port 3000 and will use the current working directory as your music directory.  

```shell
# the login system will be disabled if these values are not set
mstream -u username -x password
# set music directory
mstream -m /path/to/music
```

## Configure mStream with a JSON file

* [JSON configuration docs page](docs/json_config.md)

mStream can also be booted using a JSON file using the `-j` flag.  Using a JSON config file allows for advanced configuration options, such as multiple users and folders. When booting with a JSON config file, all other flags will be ignored.

```shell
mstream -j /path/to/config.json
```

Editing a JSON config by hand is tedious, so mStream comes with an interactive bash program to edit the config file.

```shell
# Brings up an interactive shell program to edit all things in the config
mstream --wizard /path/to/config.json
```

## The Docs

[All the details about mStream are available in the docs folder](docs/)

## Contributing

#### Like the project? [Consider sending us some money on Patreon](https://www.patreon.com/mstream)

mStream is currently in need of a mobile developer to help with an app to sync music between devices.  If you're interested in helping, email me at paul@mstream.io

## Project Breakdown

mStream is technically several different projects, each in their own stage of development.

* Server Core [v4] - The actually server code
* Server CLI Tools [v1] - These tools let you boot and configure the server core through the command prompt.
* Server Express Framework [v0.12] - The Express Framework compiles the server core to a binary that can be booted an configured entirely though a GUI. No command line needed and it runs on OSX, Windows, and Linux.
* WebApp [v4] - The webApp has been built in parallel with the server
* Mobile App [v0.5] - An Android App build in flutter.  An iOS version will be coming soon.  [Get The Code](https://github.com/IrosTheBeggar/mstream-flutter)