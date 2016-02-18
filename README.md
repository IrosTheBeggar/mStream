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


## TODO

- GET request to jump to playlist or directory
- ID3 tag detection
- Searchable database (Redis?)
- Recursive Directory Downloading
- SSL support
- Save scroll position