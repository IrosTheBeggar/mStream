## mStream

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

![mStream Webapp](/public/img/devices2.png?raw=true)

## Demo

#### [Demo 1 (no password required)](https://darncoyotes.mstream.io/)

#### [Demo 2 (username: admin, password: abc123)](https://darncoyotes-secure.mstream.io/)


## Install mStream

The best way to install mStream is to pull the latest version with git and build that.  [The full instruction for a fresh Ubuntu install can be found here](docs/install.md).  The quick version is:

```shell
git clone https://github.com/IrosTheBeggar/mStream.git
cd mStream
# Install without dev dependencies
npm install --only=production
sudo npm link
```

mStrean is also available as a pre-compiled EXE for Windows.  This version is called mStream Express and [can be downloaded from the release page](https://github.com/IrosTheBeggar/mStream/releases)

## Running & Configuring mStream

mStream can be run with command `mstream`.  The quickest way to setup mStream is to use command line flags.  [A full list of command line settings can be seen here](docs/cli_arguments.md)

```shell
# change port (defaults to 3000)
mstream -p 4999

# setup user
# the login system will be disabled if this isn't set
mstream -u username -x password

# set music directory
# defaults to the current working directory
mstream -m /path/to/music

## lastFM Scrobbling
mstream -l username -z password
```

mStream can also be configured with a json file. This method allows you to use more advanced configuration options.  The config file can be used to setup multiple directories and users.  Run this with the command `mstream /path/to/config.json`

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

## Android/iPhone Apps

mStream is currently adding support for the subsonic API.  Once that's done mStream will be accessible by a number of mobile apps

## The Docs

[All the details about mStream are available in the docs folder](docs/)

## Contributing

#### Like the project? [Consider sending us some money on Patreon](https://www.patreon.com/mstream)
