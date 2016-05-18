mStream is an mp3 streaming server.   It's focus is on ease of installation.  mStream will work right out of the box without any configuration


## Installation

Run the following commands:

```shell
npm install -g mstream
mstream musicDirectory/
```

Make sure it's working by checking out http://localhost:3000/


## Options

```shell
-p, --port       -> set port number
-l, --login      -> enable user login
-u, --user       -> add user
-x, --password   -> set Password
-d, --database   -> set the database file
-t, --tunnel     -> tunnel
-g, --gateway    -> set gateway for tunnelling
```


## Design

mStream features a responsive frontend that works on everything from desktops to smart phones

![Looking Good!](public/img/mstream-current.png)


## User System

The current user system is a simple as it comes.  There is just one user that can be set via the command line.


```shell
mstream music/ -l -u [username] -x [password]

```

The user system is simple for a few reasons.  First, I wanted to have a user system that doesn't need a database to work. Secondly, mStream is a personnal server and most users don't need anything more complex than this. 

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

Please note that not all routers will alow this.  Some routers may close this port after a period of time. 



## Database

mStream currently uses a SQLite database for a music library.  You have the option of using a beets DB or having a mstream create it's own DB.

#### Beets DB
http://beets.io/

mStream can use your beets database without any configuration.  
```shell
mstream musicDirectory/ -d path/to/beets.db
```

Currently using beets is the reccomended way to create a music database.

#### The Bad News

Currently there's not many libraries for scraping music information for node and most of them are unmaintaned.  The one I'm currently using is slow, but is being updated regularly.  However it will grind the service to a halt if you try to parse a large library.

If you're still interested in using mStream to build your DB, use the /db/recursive-scan call to do this.  Don't be surprised if you can't access your server while this is going on.

I will be experimenting with some other libraries in the near future.  In the meantine, I suggest you use beets for all your music DB needs.

#### More bad news
Node v6 currently does not play nice with the sqlite3 library.  You need to use Node v5 or earlier for the DB to work.  

The sqlite3 library is activetly mainted so this should be fixed soon



## Download Playlists

mStream now supports zipped playlist downloading without any configuration.  When you click the download button, a zipped directory of all the songs on the current playlist will be downloaded to your machine.



## API

mStream uses a JSON based API for all calls.

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
* GET: /db/recursive-scan - Scans all files and adds metadata to the DB
	* WARNING: This is an expensive operation and will make using webapp slow
	* RETURN: Message of successful kickoff
* GET: /db/status
	* WIP




## TODO

- GET request to jump to playlist or directory
- Look into taglib for id3 info
- Recursive Directory Downloading
- SSL support
- Save scroll position
