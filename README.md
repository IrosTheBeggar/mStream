# mStream

### [Check Out The Demo!](https://demo.mstream.io/)

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

### Server Features
* Works Cross Platform. Tested on Windows, OSX, Ubuntu, Arch, and Raspbian
* Dependency Free Installation
* Light on memory and CPU usage
* Tested on multi-terabyte libraries

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer
* Playlist Sharing
* Upload Files through the file explorer
* AutoDJ - Queues up random songs

![mStream Webapp](/public/img/devices2.png?raw=true)

## Install mStream Binaries for Win/OSX/Linux

* [Download the latest versions from our release page](https://github.com/IrosTheBeggar/mStream/releases)

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
npm install --only=production
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

## Android/iPhone Apps

mStream has an Android App in progress.  The app is currently in the alpha stage of development, but it works well enough for public use.  The app will be released to Google Play once it's no longer an alpha.  

[For now you can download it from the git repo](https://github.com/IrosTheBeggar/mstream-android-app/releases)

## The API

mStream uses a JSON based REST API.  [The API is documented here](docs/API.md)

## The Docs

[All the details about mStream are available in the docs folder](docs/)

## Contributing

#### Like the project? [Consider sending us some money on Patreon](https://www.patreon.com/mstream)

mStream is currently in need of a mobile developer to help with an app to sync music between devices.  If you're interested in helping, email me at paul@mstream.io