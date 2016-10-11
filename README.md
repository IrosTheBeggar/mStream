## mStream
mStream is an music streaming server written in NodeJS.   It's focus is on ease of installation and FLAC streaming.  mStream will work right out of the box without any configuration.

### Live Demo
Check it out: http://darncoyotes.mstream.io/


### Main Features
* Supports FLAC streaming
* Built in SQLite DB.  No need to setup MySQL
* Works on Mac, Linux and Windows
* [Integrates easily with Beets DB](https://github.com/beetbox/beets)
* User system with one admin and one guest account


## Installation

### Windows Executable

There is work being done to port mStream to a Windows Executable.  Check out the prototype here:
https://drive.google.com/file/d/0B1oiqEsIbjFidk8tVjR0TmZIb0k/view?usp=sharing

### Default

mStream has the following dependencies:
* NodeJS and NPM
* Python 2
* GCC and G++

Once have all the dependencies you can install and setup mStream by doing the following

```shell
npm install -g node-gyp
npm install -g mstream

cd /path/to/your/music

mstream
```

Make sure it's working by checking out http://localhost:3000/


### Install on Ubuntu
Copy and paste the following commands:

```shell
curl -sL https://deb.nodesource.com/setup_6.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo apt-get install -y build-essential

sudo npm install -g node-gyp
```


### Using Docker

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

## Options

```shell
-p, --port           -> set port number
-l, --login          -> enable user login
-u, --user           -> add user
-x, --password       -> set Password
-G, --guest          -> set guest username
-X, --guestpassword  -> set guest password
-d, --database       -> set the database file
-t, --tunnel         -> tunnel
-g, --gateway        -> set gateway for tunnelling
-i, --userinterface  -> use an alternative UI.  Currently only the value 'jplayer' works
```



## User System

The current user system is a simple as it comes.  There are two users you can have, main and guest.  Guest users do not have any access to API functions that write to the file system.  Currently guest users cannot access the save-playlist, recursive-scan, or delete-playlist functions

```shell
mstream -l -u [username] -x [password]

```

The user system is simple for a few reasons.  First, I wanted to have a user system that doesn't need a database to work. Secondly, mStream is a personal server and most users don't need anything more complex than this.


## Database

mStream currently uses a SQLite database for a music library.  You have the option of using a beets DB or having a mStream create it's own DB.  

#### Beets DB
http://beets.io/

mStream can use your beets database without any configuration.  
```shell
mstream -d path/to/beets.db
```

Currently using beets is the recommended way to create a music database.


#### use mStream to build your DB

Use the /db/recursive-scan API call to kickoff a full scan of your library.  Currently this is the only way to add files to the library.  Version 2 of mStream will include new functions to update the library more efficiently


## Automatically setup port forwarding
#### Please note that this feature is still experimental

mStream can try to automatically open a port to the internet.  Use the '-t' command to try to setup port forwarding.  Additionally you can use the '-g' command to set the gateway IP manually.  If you don't include '-g', the program will use an extension to try to figure it out

```
mstream  -t

OR

mstream  -t -g [gatewayIP]
mstream musicDirectory/ -t -g 192.168.1.1
```

Please note that not all routers will allow this.  Some routers may close this port after a period of time.



## Known Issues
- Does not work on 32bit versions of Linux.  The sqlite3 library will not compile on 32bit Linux
- Only works on Node v4 or greater


## TODO
- GET request to jump to playlist or directory
- Look into taglib for id3 info
- SSL support
