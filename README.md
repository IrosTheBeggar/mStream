mStream is an mp3 streaming server.   It's focus is on ease of installation

## Installation

Run the following commands:

```shell
npm install -g mstream
npm link mstream
mstream musicDirectory/
```

Make sure it's working by check checking out http://localhost:3000/

## User Interface

mStream features a responsive frontend that works on everything from desktops to smart phones

![Looking Good](public/img/mstream-current.png)


## Options
```shell
-p, --port -> set port number
-t, --tunnel -> tunnel
-g, --gateway -> set gateway for tunnelling
```


## Access mStream via the internet
#### Please note that this feature is still experimental

mStream can try to automatically open a port to the internet.  Use the '-t' command to try tunnelling.  Additionally you can use the '-g' command to set the gateway IP manually.  If you don't include '-g', the program will use an extentension to try to figure it out

```shell
mstream [directory] -t 
mstream musicDirectory/ -t 

OR

mstream [directory] -t -g [gatewayIP]
mstream musicDirectory/ -t -g 192.168.1.1
```


## TODO

- Password protection
- GET request to jump to directory
- ID3 tag detection
- Searchable database (Redis?)
- Recursive Directory Downloading
- SSL support
