mStream is an mp3 streaming server.   It's focus is on ease of installation

## Installation

Run the following commands:

```shell
npm install -g mstream
npm link mstream
mstream musicDirectory/
```

Make sure it's working by check checking out http://localhost:3000/

## Download Playlists

mStream now supports zipped playlist downloading without any configuration.  When you click the download button, a zipped directory of all the songs on the current playlist will be downloaded to your machine.

## Design

mStream features a responsive frontend that works on everything from desktops to smart phones

![Looking Good!](public/img/mstream-current.png)


## Options
```shell
-p, --port -> set port number
-t, --tunnel -> tunnel
-g, --gateway -> set gateway for tunnelling
-l, --login -> enable user login
-u, --user -> add user
-x, --password -> set Password
```

## User System

The current user system is a simple as it comes.  There is just one user that can be set via the command line.


```shell
mstream music/ -l -u [username] -x [password]

```

The user system is simple for a few reasons.  First, I wanted to have a user system that doesn't need database to work. Secondly, mStream is a personnal server and most users don't need anything more complex than this. 

Future versions of this login system will allower for multiple users and user permssions, such as limitting users from saving playlists.



## Access mStream via the internet
#### Please note that this feature is still experimental

mStream can try to automatically open a port to the internet.  Use the '-t' command to try tunnelling.  Additionally you can use the '-g' command to set the gateway IP manually.  If you don't include '-g', the program will use an extentension to try to figure it out

```
mstream [directory] -t 
mstream musicDirectory/ -t 

OR

mstream [directory] -t -g [gatewayIP]
mstream musicDirectory/ -t -g 192.168.1.1
```


## Database

mStream currently uses a SQLite database to a music library.  Use the /db/recursive-scan call to create the library.

The databases functions are still being fine tuned and may be changed in the future.


WARNING: using the /db/recursive-scan call is currently unreliable and can cause the app to crash.  The solution is to either move away from SQLite or to use a seperate script to create the database.  For now you're stuck with it as the only way to create the db


## Design

API Calls
* POST: /dirparser  - Get list of files and folders for a given directory
	* PARAM: dir - directory to scan
	* PARAM: filetypes - JSON array of filetypes to return
	* RETURN: JSON array of files and folders
* POST: /saveplaylist - saves a m3u playlist
	* PARAM: title - playlist name
	* PARAM: stuff - array of songs to save
* GET: /getallplaylists
	* RETURNS: JSON array of all playlists
* GET: /loadplaylist
	* PARAM: filename - playlsit filename
	* RETURN: JSON array of files in playlist
* POST: /download
	* PARAM: fileArray - JSON array of files to download
	* RETURN: Zipped directory of files
* GET: /db/recursive-scan - Scans all files and adds metadata to the DB
	* WARNING: This is an expensive operation and will make using webapp slow
	* RETURN: Message of successful kickoff
* POST: /db/search
	* PARAM: search - sring to search for
	* RETURN: JSON array of artists and albums that match search
* GET: /db/artists
	* RETURN: JSON array of all artists
* POST: /db/artists-albums - retunrs all albums for a given artist
	* PARAM: artist - name of artist
	* RETURN: JSON array of albums 
* GET: /db/albums
	* RETURN: JSON array of all albums
* POST: /db/album-songs - Find all songs for a given album
	* PARAM: album - name of album
	* RETURN: JSON array of all songs
* GET: /db/status
	* WIP


## TODO

- GET request to jump to playlist or directory
- Look into taglib for id3 info
- Add support for MySQL DB
- Recursive Directory Downloading
- SSL support
- Save scroll position
