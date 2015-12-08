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


## Access mStream via the internet

mStream can try to automatically open a port to the internet.  To do this you need to declare the port and proceed it with the command 'tunnel'

```shell
mstream [directory] [port] tunnel
mstream musicDirectory/ 8080 tunnel
```

Please note that this feature is still experimental