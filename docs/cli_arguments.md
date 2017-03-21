## Automatically setup port forwarding

mStream can try to automatically open a port to the internet.  Use the '-t' command to try to setup port forwarding.  
```
mstream  -t
```

Please note that not all routers will allow this.  Some routers may close this port after a period of time.

You can get around this by having mStream retry this on a regular interval

```
mstream -t -r [time in milliseconds]
mstream -t -r 10000
```


## Set Port
```shell
mstream -p 5050
```

## User System
mStream can have a single user and guest.

```shell
# Set User
mstream -u [username] -x [password]

# Set user and guest
mstream -u [username] -x [password] -G [guest name] -X [guest password]
```


## Database Options
You can either use mStream's default database [or tap into BeetsDB.](https://github.com/beetbox/beets)

#### Beets DB

```shell
mstream -D beets -d /path/to/beets.db
```

When using Beets, mStream is put into a read only mode.  mStream will not be able to write to any tables that are managed by Beets.  Playlist functionality is not affected by this since playlists are stored in a separate table.


#### Built In DB

mStream can read metadata and write it's own database.  By default mStream will create a database in the folder it's launched in called 'mstreamdb.lite'.  You can manually set the database file with:

```shell
mstream -d /path/to/mstream.db
```
