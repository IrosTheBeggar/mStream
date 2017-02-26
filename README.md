## mStream
mStream is an music streaming server written in NodeJS.   It's focus is on ease of installation and FLAC streaming.  mStream will work right out of the box without any configuration.

#### Demo
Check it out: http://darncoyotes.mstream.io/

#### Main Features
* Supports FLAC streaming
* Built in DB using SQLite.  No need to run a separate DB
* Works on Mac, Linux and Windows
* [Integrates easily with Beets DB](https://github.com/beetbox/beets)
* Allows multiple users


## Installation

#### Dependencies
mStream has the following dependencies:
* NodeJS and NPM
* Python 2
* GCC and G++
* node-gyp

#### Install on Ubuntu
Install NodeJS
```shell
curl -sL https://deb.nodesource.com/setup_6.x | sudo -E bash -
sudo-apt-get update
sudo apt-get install -y nodejs
```

Install GCC and node-gyp
```shell
sudo apt-get install -y build-essential
sudo npm install -g node-gyp
```

Install mStream
```shell
sudo npm install -g mstream

cd /path/to/your/music
mstream
```

Make sure it's working by checking out http://localhost:3000/

#### Using Docker

Download the Dockerfile, or clone the repository, then run the following
commands:

```shell
docker build -t local/mstream .

docker run --rm -v /path/to/my/music:/music local/mstream
```

The ENTRYPOINT is `mstream`, so you can use the same option as if using the
default installation.

```shell
docker run --rm -v /path/to/my/music:/music local/mstream -l -u username -x password
```

## Usage

mStream can be configured by using a JSON config file or by using flags in the command line. JSON config files are more flexible but more difficult to use.

This readme will not cover JSON config usage.  See the examples folder to learn more.

#### Set Port
```shell
mstream -p 5050
```

## User System
mStream can have a single user and guest when being setup using the command line.

```shell
# Set User
mstream -u [username] -x [password]

# Set user and guest
mstream -u [username] -x [password] -G [guest name] -X [guest password]
```

Multiple users can be set using JSON config files

## Database Options
mStream uses sqlite by default.  You can either use mStream's default database [or tap into BeetsDB](https://github.com/beetbox/beets)

#### Beets DB

```shell
mstream -D beets -d /path/to/beets.db
```

When using Beets, mStream is put into a read only mode.  mStream will not be able to write to any tables that are managed by Beets.  Playlist functionality is not affected by this since playlists are stored in a separate table.


#### Built In DB

mStream can read metadata and write it's own database.  By default mstream will create a database in the folder it's launched in called 'mstreamdb.lite'.  You can manually set the databse file with:

```shell
mstream -d /path/to/mstream.db
```


## Automatically setup port forwarding

mStream can try to automatically open a port to the internet.  Use the '-t' command to try to setup port forwarding.  Additionally you can use the '-g' command to set the gateway IP manually.  If you don't include '-g', the program will use an extension to try to figure it out

```
mstream  -t

OR

mstream  -t -g [gatewayIP]
mstream musicDirectory/ -t -g 192.168.1.1
```

Please note that not all routers will allow this.  Some routers may close this port after a period of time.

You can get around this by having mStream retry this on a regular interval

```
mstream -t -r [time in milliseconds]
mstream -t -r 10000
```


## Known Issues
- Does not work on 32bit versions of Linux.  The sqlite3 library will not compile on 32bit Linux
- Only works on Node v4 or greater


## TODO
- Album Art
- Reset Password Functions
- Ability to store user credentials
- LokiJS cache layer
- SSL Support
