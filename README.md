# mStream

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

#### [Check Out The Demo!](https://darncoyotes.mstream.io/)

#### Server Features

* Works Cross Platform. Tested on Windows, OSX, Ubuntu, Arch, and Raspbian
* Dependency Free Installation
* Light on memory and CPU usage
* Tested on multi-terabyte libraries
* Bug Free. The issues page is all feature requests

#### WebApp Features

* Gapless Playback
* Milkdrop Visualizer (Thanks @jberg)
* Playlist Sharing
* Upload Files through the file explorer
* AutoDJ! Queues up random songs

![mStream Webapp](/public/img/devices2.png?raw=true)

## Install mStream Binaries for Win/OSX/Linux

This is the easiest way to install mStream.  They have no dependencies so you can just download and run them.  [Get them on our release page](https://github.com/IrosTheBeggar/mStream/releases).

These binaries come with some additional features:
* Adds tray icon for easy server management
* Auto boots server on startup
* Comes with a GUI for easy server configuration
* [No command line needed! Any user can install and run these](https://www.youtube.com/watch?v=IzuxYTaixpU)

## Install mStream From The Command Line

If you just want the core part of mStream without all the UI tools, you can install mStream from the NPM or Git repositories. 

```shell
# Install From NPM
npm install -g mstream
```

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
npm install --only=production
sudo npm link 
```

## Running & Configuring mStream

To test your installation, run the command `mstream`.  This will boot an mStream server on port 3000 and will use the current working directory as your music directory.  [Command line flags can be used to test different mStream configurations](docs/cli_arguments.md)

```shell
# change port (defaults to 3000)
mstream -p 4999

# setup user
# the login system will be disabled if these values are not set
mstream -u username -x password

# set music directory
# defaults to the current working directory if not set
mstream -m /path/to/music

## lastFM Scrobbling
mstream -l username -z password
```

## Configure mStream with a JSON file

* [JSON configuration docs page](docs/json_config.md)

mStream can also be booted using a JSON file using the `-j` flag.  Using a JSON config file allows for more advanced configuration options, such as multiple users and folders. When booting with a JSON config file, all other flags will be ignored. An example config with multiple users is shown below.

```
mstream -j /path/to/config.json
```

```json
{
  "port": 3030,
  "database_plugin":{
    "dbPath":"/path/to/mstream.db"
  },
  "folders": {
    "blues": "/path/to/blues",
    "metal": "/path/to/metal"
  },
  "users": {
    "dan": {
      "password":"qwerty",
      "vpaths": ["blues", "metal"]
    },
    "james": {
      "password":"password",
      "vpaths": ["blues"],
      "lastfm-user": "username",
      "lastfm-password": "password"
    }
  }
}
```

Editing a JSON config by hand is tedious.  There's a number of special flags that will launch a prompt to guide you through editing the config

```shell
# Set a blank config
mstream --init config.json
# Add Folder
mstream -j config.json --addpath /path/to/folder
# Add a User
mstream -j config.json --adduser
# Change the Port
mstream -j config.json --editport
# Generate a Secret
mstream -j config.json --makesecret
# Add SSL Key/Cert
mstream -j config.json --addkey <ssl key>
mstream -j config.json --addcert <ssl cert>

# Delete Users
mstream -j config.json --removeuser
# Remove Folders
mstream -j config.json --removepath
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
