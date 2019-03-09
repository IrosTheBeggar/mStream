# Use The Wizard

Editing JSON by hand is tedious. All the json config options can be edited by using the cli wizard.  To use it:

```
mstream --wizard /path/to/config.json
```

# JSON config

Using a JSON config with mStream allows for more advanced configurations.  This example contains all configurable params for reference purposes.  

```json
{
  "port": 3030,
  "webAppDirectory": "public",
  "secret": "b6j7j5e6u5g36ubn536uyn536unm5m67u5365vby435y54ymn",
  "writeLogs": true,
  "noUpload": false,
  "scanOptions": {
    "skipImg": true,
    "scanInterval": 1.5,
    "pause": 50,
    "saveInterval": 500,
    "bootScanDelay": 15
  },
  "storage": {
    "albumArtDirectory": "/media/album-art",
    "dbDirectory": "/media/db",
    "logsDirectory": "/media/logs"
  },
  "folders": {
    "blues": "/media/music/blues",
    "rock": { "root": "/media/music/rock"}
  },
  "users": {
    "paul": {
      "password":"p@ssword",
      "vpaths": ["blues", "rock"]
    },
    "james": {
      "password":"qwerty",
      "vpaths": "rock",
      "lastfm-user": "username",
      "lastfm-password": "password"
    }
  },
  "ssl": {
    "key": "/path/to/key.pem",
    "cert": "/path/to/cert.pem"
  }
}
```

All these params have default values. Technically, an empty objects would be valid.  It's the same as running `mstream` without any config options

```
# This is valid
{ }
```

## Port

Sets the port. Defaults to 3000 if not set

## UI

Folder that contains the frontend for mStream.  Defaults to `public` if not set

## Secret 

Sets the secret key used for the login system.  If this is not set, mStream will generate a random secret key on boot and previous login sessions will be voided

## Scan Options

* `skipImg`: (boolean) whether to skip scanning for album art.  Speeds up the scan time
* `bootScanDelay`: delay between server boot and first file scan (in seconds)
* `scanInterval`: The interval which controls how often file system will be scanned for changes (in hours)
* `saveInterval`: interval which to refresh the DB on scan.  Defaults to 250.  Can be set to a higher number for large collections to avoid hogging the CPU thread
* `pause` (in milliseconds): During the scan, there is an optional pause that is aded between file parsing.   This can prevent mStream from hogging system resources during the initial scan

```json
{
  "scanOptions":{
    "skipImg": true,
    "scanInterval": 1.5,
    "pause": 50,
    "saveInterval": 500,
    "bootScanDelay": 15
  }
}
```


## Folders

Folders are set by key value pairs.  The key is used later to give access to folders on a per user basis.  (more info in the users section)

There are two valid syntaxes for folders

```json
  "folders": {
    "blues": "/media/music/blues",
    "rock": { "root": "/media/music/rock"}
  }
```

For now, these are identical.  In the future, mStream will be able to offer different frontend features based on the directory type.

## Users

A basic user example.  

```json
{
  "folders": {
    "media": "/media/music"
  },
  "users": {
    "paul": {
      "password":"p@ssword",
      "vpaths": "media"
    }
  }
}
```

A user with multiple folders

```json
{
  "folders": {
    "music": "/media/music",
    "audiobooks": "/media/books/audio"
  },
  "users": {
    "paul": {
      "password":"p@ssword",
      "vpaths": ["music", "audiobooks"]
    }
  }
}
```

Multiple users with multiple directories

```json
{
  "folders": {
    "jake-music": "/media/jake/music",
    "finn-music": "/media/finn/music",
    "audiobooks": "/media/books/audio"
  },
  "users": {
    "jake": {
      "password":"p@ssword",
      "vpaths": ["jake-music", "audiobooks"]
    },
    "finn": {
      "password":"p@ssword",
      "vpaths": ["finn-music", "audiobooks"]
    }
  }
}
```


If there is no users object, the login system will not be enabled and anyone will be abe to access the server.  All folders will be accessible

```json
{
  "folders": {
    "music": "/media/music",
    "audiobooks": "/media/books/audio"
  }
}
```

## SSL

mStream comes with SSL support built in.  Just add your key and cert and the server will take care of the rest

```json
  "ssl": {
    "key": "/path/to/key.pem",
    "cert": "/path/to/cert.pem"
  }
```

## Disable Uploading

```
  "noUpload": true
```

## LastFM Scrobbling

Each user can have their own lastFM credentials

```json
{
  "folders": {
    "jake-music": "/media/jake/music",
    "finn-music": "/media/finn/music",
    "audiobooks": "/media/books/audio"
  },
  "users": {
    "jake": {
      "password":"p@ssword",
      "vpaths": ["jake-music", "audiobooks"],
      "lastfm-user": "username",
      "lastfm-password": "password"
    },
    "finn": {
      "password":"p@ssword",
      "vpaths": ["finn-music", "audiobooks"],
      "lastfm-user": "username",
      "lastfm-password": "password"
    }
  }
}
```

If you want to use LastFM scrobbling without a user system, you can do the following

```json
{
  "folders": {
    "music": "/media/music",
    "audiobooks": "/media/books/audio"
  },
  "lastfm-user": "username",
  "lastfm-password": "password"
}
```

## Port Forwarding

Set tunnel to true if you want mStream to try to auto configure port forwarding via uPNP

```json
{
  "tunnel": true
}
```

## Storage

mStream will write, logs, DB files, and album art to the filesystem.  By default these will be written in the mStream project folder tothe `save` and `image-cache` folders.  Use the `storage` object to choose where to save these files

The `albumArtDirectory` will be publicly available 

```json
{
  "storage": {
    "albumArtDirectory": "/media/album-art",
    "dbDirectory": "/media/db",
    "logsDirectory": "/media/logs"
  }
}
```

## Logs

set `writeLogs` to `true` to enable writing logs to the filesystem

```
  "writeLogs": true,
```