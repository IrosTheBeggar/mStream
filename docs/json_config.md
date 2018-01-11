# JSON config

Using a JSON config with mStream allows for more advanced configurations.  This example contains all configurable params for reference purposes.  

```
{
  "port": 3030,
  "userinterface":"public",
  "secret": "b6j7j5e6u5g36ubn536uyn536unm5m67u5365vby435y54ymn",
  "database_plugin":{
    "dbPath":"/path/to/loki.db"
  },
  "albumArtDir": "/media/album-art",
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

All these params have default values. Technically, an empty objects would be valid.  It's the same as running `mstream` without any config otpions

```
# This is valid
{ }
```

#### `port`

Sets the port. Defaults to 3000 if not set

#### `userinterface`

Folder that contains the frontend for mStream.  Defaults to `public` if not set

#### `secret` 

Sets the secret key used for the login system.  If this is not set, mStream will generate a random secret key on boot and previous login sessions will be voided

#### `database_plugin` 

This option is a relic of the past when mStream also supported SQLite. Right now only the path can be set.  This defaults to the current working directory

```
  "database_plugin":{
    "dbPath":"/path/to/loki.db"
  },
```

#### `folders`

Folders are set by key value pairs.  The key is used later to give access to folders on a per user basis.  (more info in the users section)

There are two valid syntaxes for folders

```
  "folders": {
    "blues": "/media/music/blues",
    "rock": { "root": "/media/music/rock"}
  }
```

For now, these are identical.  In the future, mStream will be able to offer different frontend features based on the directory type.

#### `users`

A basic user example.  

```
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

```
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

```
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

```
{
  "folders": {
    "music": "/media/music",
    "audiobooks": "/media/books/audio"
  }
}
```

#### `ssl`

mStream comes with SSL support built in.  Jsut add your key and cert and the server wil ltake care of the rest

```
  "ssl": {
    "key": "/path/to/key.pem",
    "cert": "/path/to/cert.pem"
  }
```

#### Album Art

Sets the path where album art will be saved. Defaults to the `image-cache` folder in the mStream directory

```
  "albumArtDir": "/media/album-art"
```

#### LastFM Scrobbling

Each user can have their own lastFM credentails

```
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

```
{
  "folders": {
    "music": "/media/music",
    "audiobooks": "/media/books/audio"
  },
  "lastfm-user": "username",
  "lastfm-password": "password"
}
```

#### Port Forwarding

Set tunnel to true if you want mStream to try to auto configure port forwarding via uPNP

```
{
  "tunnel": true
}
```