## Set Port
Use the `-p` command to set the port.  Will default to 3000 if not set

```shell
mstream -p 5050
```

## Set Music Directory
Use the `-m` command to set the music directory.  Will default to current working directory if not set

```shell
mstream -m /path/to/music
```

## SSL
All you need to do is set the cert and key file and mStream will do the rest

```shell
mstream -c /path/to/cert.pem -k /path/to/key.pem
```

## User System
mStream can have a single user and guest.  If the user is not set mStream will disable to the user system and anyone will be able to access the  server

```shell
# Set User
mstream -u [username] -x [password]

# Set user and guest
mstream -u [username] -x [password] -G [guest name] -X [guest password]
```

#### Login Secret

You can set your login secret key  with the `-s` command
```
mstream -s /path/to/secret/file
```

If not set mStream will generate a random string to use as the secret key on boot.  If rebooted, the secret key will be regenerated and any previous keys will no longer work

## Database Options

mStream automatically makes a SQLite DB file in the folder of the directory it is run from.  You can change the database path with the `-d` command

```shell
mstream -d /path/to/mstream.db
```


## Automatically setup port forwarding

mStream can try to automatically setup port forwarding via upnp.  Use the '-t' command to try to setup port forwarding.  
```
mstream  -t
```

Please note that not all routers will allow this.  Some routers may close this port after a period of time.

You can get around this by having mStream retry this on a regular interval

```
mstream -t -r [time in milliseconds]
mstream -t -r 100000
```
