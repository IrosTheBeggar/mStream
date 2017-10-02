## mStream

mStream is a personal music streaming server written in NodeJS. The goal of mStream is to be the easiest music streaming server software available.

## Links

#### [See The Demo (no password required)](https://darncoyotes.mstream.io/)

#### [See The Demo (username: admin, password: abc123)](https://darncoyotes-secure.mstream.io/)

#### [mStream Download Page](http://mstream.io/mstream-express)


![mStream Website](/public/img/devices2.png?raw=true)


## Install mStream

mStream can be installed on Mac, Windows, and Linux with NPM.  

mStream is also available as a pre-compiled EXE for Windows.  This version of mStream was created so solve the problem of dealing with NPM on Windows.  Seriously, don't install mStream in Windows via NPM unless you know what you are doing. This pre-compiled version is called mStream Express and will work right out of the box and has no dependencies.  It has some additional features as well, such as adding a Tray Icon to manage your server.  

#### [Install with NPM:](docs/install.md)

#### [Install mStream Express for Windows](http://mstream.io/mstream-express)


## mStream Server Features
* Works on Mac/Windows/Linux
* Lightweight: uses less than 50MB of memory under normal load
* SSL Support + JSON Web Token Authentication for security
* Automatically scans library for metadata and album art
* Server uses a RESTful JSON API.  [It's documented and easy to write code against](docs/API.md)

## mStream Webapp Features
* Supports FLAC streaming on all browsers
* Responsive UI
* Song caching for gapless playback
* Jukebox Mode allows you to control the webapp from your phone
* Built in VueJS

## Android App

There is currently and mStream Android App under development.  All the core media player features work, but the UI could use some work.  It's not available on the App Store, [but you can get the latest version here](https://github.com/IrosTheBeggar/mstream-android-app/releases)

* Supports FLAC streaming
* Allows you to download files to your phone for offline playback
* Can connect to multiple servers
* [Open Source](https://github.com/IrosTheBeggar/mstream-android-app)

## Additional Reading

[All the details about mStream are available in the docs folder](docs/)

## Contributing

#### Like the project? [Consider sending us some money on Patreon](https://www.patreon.com/mstream)
