# mStream API

mStream uses a REST based API for everything.  

All calls to the API are done through GET and POST requests.  Make sure to set your `Content-Type` header to `application/json` when making a POST request

```
// jQuery Example

var request = $.ajax({
  url: "login",
  type: "POST",
  contentType: "application/json",
  dataType: "json",
  data: JSON.stringify(
    {
      username: "Bojack",
      password: "family"
    }
  )
});
```

## Streaming Files

To stream a file you need a three pieces  of information:
- The filepath - this is the relative filepath as it would show up on your disk
- The vPath - This is a virtual directory that's created on boot for security reasons.  It can be obtained through ['/ping'](API/ping.md) or ['/login'](API/login.md)
- The token - The user token (the token is only needed if user system is enable)

To stream a file create a URL with the following structure
```
http://yourserver.com/media/[your vPath]/path/to/song.mp3?token=XXXXXXXX
```


## File Explorer

[/dirparser](API/dirparser.md)

[/upload](API/upload.md)

## Playlists

[/playlist/getall](API/playlist_getall.md)

[/playlist/load](API/playlist_load.md)

[/playlist/save](API/playlist_save.md)

[/playlist/delete](API/playlist_delete.md)

## Metadata (Albums/Artists/Etc)

[/db/metadata](API/db_metadata.md)

[/db/search](API/db_search.md)

[/db/albums](API/db_albums.md)

[/db/artists](API/db_artists.md)

[/db/artists-albums](API/db_artists-albums.md)

[/db/album-songs](API/db_album-songs.md)

[/db/status](API/db_status.md)

[/db/recursive-scan](API/db_recursive-scan.md)

## JukeBox

[/jukebox/push-to-client](API/jukebox_push-to-client.md)

## Download

[/download](API/download.md)

## Share

[/shared/make-shared](API/shared_make-shared.md)

[/shared/get-token-and-playlist](API/shared_get-token-and-playlist.md)


## Login System & Authentication

mStream uses a token based authentication.  The token you get when logging in can be used to access the API endpoints and the music files.

Login Functions:

* [/login](API/login.md)
* [/ping](API/ping.md)
* /change-password - Coming Soon

Failure Endpoints:

* /access-denied

The security layer is written as a plugin.  If you don't set the username and password on boot the plugin won't load and your server will be accessible by to anyone.  All API endpoints require a token to access if the login system is enabled.  Tokens can be passed in through the GET or POST param token.  Tokens can also be put in the request header under 'x-access-token'

If you want your tokens to work between reboots you can set the `secret` flag when booting by using `mstream -s YOUR_SECERT_STRING_HERE`.  The secret key is used to sign the tokens. If you do not set the secret key mStream will generate a random key on boot

## Pages

These endpoints server various parts of the webapp

* /
* /remote
* /shared/playlist/[PLAYLIST ID]
