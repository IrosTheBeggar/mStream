## mStream

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

![mStream Webapp](/public/img/devices2.png?raw=true)

## Demo

#### [Demo 1 (no password required)](https://darncoyotes.mstream.io/)

#### [Demo 2 (username: admin, password: abc123)](https://darncoyotes-secure.mstream.io/)


## Install mStream Server

### Binaries for Win/OSX/Linux

This is the easiest way to install mStream.  They have no dependencies so you can just download and run them.  [Get them on our release page](https://github.com/IrosTheBeggar/mStream/releases).

These binaries come with some additional features:
* Adds tray icon for easy server management
* Auto boots server on startup
* Comes with a GUI for easy server configuration
* [No command line needed. This version can be booted through the GUI](https://www.youtube.com/watch?v=IzuxYTaixpU)

If you just want the core part of mStream, use one of the other methods.

### NPM

Get the latest stable release via NPM

```
npm install -g mstream
```

### Github + Node

If you want the latest code, use this method 

```shell
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
# Install without dev dependencies
npm install --only=production
sudo npm link
```

mStream is also available as a pre-compiled EXE for Windows.  This version is called mStream Express and [can be downloaded from the release page](https://github.com/IrosTheBeggar/mStream/releases)

## Running & Configuring mStream

mStream can be run with command `mstream`.  This will boot an mStream server on port 3000 and will use the current working directory as your music directory.  

### Configure with CLI Flags

The quickest way to setup mStream is to use command line flags.  [A full list of command line settings can be seen here.](docs/cli_arguments.md)  These config options should be enough for most users.  More advanced configurations can be made by using a JSON config file

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

### Configure mStream with a JSON file

mStream can also be booted using a JSON file using the `-j` flag.  Using a JSON config file allows for more advanced configuration options, such as multiple users and folders.

When booting with a JSON config file, all other flags will be ignored.

```
mstream -j /path/to/config.json
```

An example config is shown below.  [You can see the full set of config options here](docs/json_config.md)

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
