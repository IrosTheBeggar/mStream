This document covers all the stable configuration options for mStream.  To see all configuration options you can look at configure-commander.js file.  Any options not documented here are experimental and may not work.

Please note that all paths to folders and files must be absolute.  Relative paths will not work.  This is a compromise made early on to prevent bugs when running mStream on Windows.

## Set Port
Use the `-p` command to set the port.  Will default to 3000 if not set

```shell
mstream -p 5050
```

## Set Music Directory
Use the `-m` command to set the music directory.  This must be a full path.  Relative paths will not work!

Will default to current working directory if not set

```shell
mstream -m /path/to/music
```

## Album Art Directory
Use the `-I` command to set the album art directory.  All album art scraped from metadata will be stored here.  Make sure mStream has write access to this folder.

Defaults to the `image-cache` directory in the project if not set

```shell
mstream -I /path/to/album-art
```

## Choose Log Directory
Use `-d` to pick the folder to save all DB files too

```
mstream -d /path/to/db/
```

## SSL
All you need to do is set the cert and key file and mStream will do the rest

```shell
mstream -c /path/to/cert.pem -k /path/to/key.pem
```

## User System
mStream can have a single user and guest.  If the user is not set (default behavior), mStream will permit unrestricted access to the system.

```shell
# Set User
mstream -u [username] -x [password]

mstream -u admin -x password
```

## Transcoding

To enable transcoding, use the `-t` flag

```shell
# Use default config
mstream -t

# set the ffmpeg directory. FFmpeg will be downloaded here automatically if it does not exist
mstream -t -f ffmpeg /path/to/ffmpeg-folder
```

## Disable Upload
Disables to upload API endpoint

```
  mstream -N
```

## Login Secret

You can set your login secret key  with the `-s` command
```
mstream -s /path/to/secret/file
```

If not set mStream will generate a random string to use as the secret key on boot.  If rebooted, the secret key will be regenerated and any previous keys will no longer work

## LastFM Scrobbling

The webapp will automatically scrobble songs after 30 seconds of play.  Add you last FM credentials to take advantage of this feature

```
mstream -l username -z password
```

## Database Path

mStream automatically makes a DB file in the folder of the directory it is run from.  You can change the database path with the `-d` command

```shell
mstream -d /path/to/mstream.db
```

## DB Scan Interval

By default, mStream will scan all your files every 24 to update the DB. If you want to change that you can set the interval with `-E`.  The interval can only be set in hours.  Set this to 0 to turn off interval scanning

```
mstream -E 2
```

## DB Pause

During the file scan, there is an optional pause that is aded between file parsing.   This can prevent mStream from hogging system resources during the initial scan.  Set in milliseconds

```shell
# Pause for 50 milliseconds
mstream -P 50
```

## DB Save Interval

mStream uses an in-memory database called LokiJS.  While mStream is scanning for files, LokiJS is updated in batches to avoid hogging the CPU.  It typically updates after 250 new records, but can be set to a higher number to avoid spamming updates on really large collections

```shell
mstream -D 500
```

## DB Skip Image

Tell the scan to skip processing album art images during scan.  This will speed up the scan and prevent mStream from using disk space to cache album art.

```shell
mstream -S
```

## Choose the UI folder

mStream pulls serves the frontend files from the `public` folder by default.  You can change the frontend folder by using the `-i` command.  This is meant to be used for development to test help build a new frontend.  In the future mStream can also be given skins that can be changed by just downloading a folder and setting the path with this command.

```
mstream -i my-ui-folder
```

In order for UI folder to work, you will need three files:

* mstream.html
* remote.html
* shared.html

These files will be served by the `/`, `/remote`, and `/shared` endpoints respectively.

## Log to File
To write all logs to a file, use the `-L` flag.  If this is not set, logs will only be written to the console.  Defaults to the `/save/logs` in the root of ths project

```
mstream -L
```

## Choose Log Directory
Use `-A` to pick the folder to save all logs too

```
mstream -L -A /path/to/logs/
```