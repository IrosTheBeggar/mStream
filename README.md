## mStream

mStream is a personal music streaming server written in NodeJS. The goal of mStream is to be the easiest music streaming server software available.

## Links

#### [See The Demo (no password required)](https://darncoyotes.mstream.io/)

#### [See The Demo (username: admin, password: abc123)](https://darncoyotes-secure.mstream.io/)

#### [The Official Website](http://mstream.io/)

#### [mStream Express Download Page](http://mstream.io/mstream-express)


## mStream Server

* Works on Mac/Windows/Linux
* Lightweight: uses less than 50MB of memory under normal load
* Secure login system that uses JSON web tokens
* Built in SSL support
* Automatically scans library for metadata and album art
* Server uses a RESTful JSON API.  [It's documented and easy to write code against](docs/API.md)

mStream Server can be [installed with NPM by following these instructions](docs/install.md)

## mStream Express

Installing all the dependencies for mStream can be hassle for Windows users.  To solve this problem, Electron was used to compile the mStream Server into installable EXE for windows.  To be clear, mStream Express uses the same code as mStream Server, it's just packed as a one click installer.

[You can download the latest version of mStream Express here](http://mstream.io/mstream-express) or [here](https://github.com/IrosTheBeggar/mStream/releases)

mStream Express also comes packaged with some extra tools to make managing your server as simple as possible.  Here's a list of all the important features:

* No Dependencies!  
* Comes in an installable and Portable edition for windows
* Has a full set of server GUI management tools built in. No need to touch a command line!
* Autoboot: Can be configured to boot on startup
* Automatic Port Forwarding via uPNP protocol
* Now works on Linux. mStream Express has been tested and verified working on Ubuntu and Arch

## The WebApp

The webapp allows your to stream your music on any browser. it comes built into the server and has these features:

* Supports FLAC streaming on all browsers
* Responsive UI
* Song caching for gapless playback
* Jukebox Mode allows you to control the webapp from your phone

## Android App

There is currently and mStream Android App under development.  It lacks some features and the UI is clunky, but it works.  It's not available on the App Store, [but you can get the latest version here](https://github.com/IrosTheBeggar/mstream-android-app/releases)

* Supports FLAC streaming
* Allows you to download files to your phone for offline playback
* Can connect to multiple servers
* [Open Source](https://github.com/IrosTheBeggar/mstream-android-app)

## Additional Reading

[All the details about mStream are available in the docs folder](docs/)

## Contributing

Like the project? [Consider sending us some money on Patreon](https://www.patreon.com/mstream)
