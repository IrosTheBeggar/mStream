## mStream API

mStream uses a REST based API for everything.  

All calls to the API are done through GET and POST requests.  To send POST requests add your JSON to the json field

#### Pages

These pages server various parts of the webapp

* `/`
* `/remote`
* `/shared/[PLAYLIST ID]`

#### Login System s& Authentication

mStream uses a token based authentication.  The token you get when logging in can be used to access the API endpoints and the music files.

Login Functions
* [`/login`](API/login.md)
* `/change-password` - Coming Soon

Failure Endpoints
* `/login-failed`
* `/access-denied`
* `/guest-access-denied`

All API endpoints past this point requires a token to access if the login system is enabled.  Tokens can be passed in through the GET or POST param token.  Tokens can also be put in the request header under 'x-access-token'

If you want your tokens to work between reboots you can set the `secret` flag when booting by using `mstream -s YOUR_SECERT_STRING_HERE`.  The secret key is used to sign the tokens. If you do not set the secret key mStream will generate a random key on boot

The security layer is written as a plugin.  If you don't set the username and password on boot the plugin won't load and your stream server will be accessible by to anyone.

#### Streaming Files

To stream a file you need a three pieces  of information:
- The filepath - this is the filepath as it would show up on your disk.  It's the relative filepath to the music directory  you supply
- The vPath - This is a virtual directory that's created on boot for security reasons.  
- The token - The user token (if user system is enabled)

The vPath can be obtained through [`/ping`](API/ping.md)

To call a stream a file create a URL with the following structure
```
http://yourserver.com/vPath/filepath/song.mp3?token=XXXXXXXX
```


#### File Explorer

[/dirparser](API/dirparser.md)

#### Playlists

[/playlist/getall](API/playlist_getall.md)

[/playlist/load](API/playlist_load.md)

[/playlist/save](API/playlist_save.md)

[/playlist/delete](API/playlist_delete.md)

#### Database Read (Albums/Artists/Etc)

[/db/albums](API/db_albums.md)

[/db/artists](API/db_artists.md)

More Coming Soon!

#### JukeBox

#### Download

#### Shared

#### Database Write
