## Install Electron Port

Installing the electron port will break the command line version of mStream.  

**Install Dev Dependencies**

The electron version has several different dependencies that need to be installed.  Running `npm install` will install them

**Rebuild Node Modules**

Some modules need to be rebuilt before electron can use them.  Rebuilding these modules means they will only work for electron. These modules will no longer work for the command line version of mStream.  Read more on Elctron Rebuild module here here: https://github.com/electron/electron-rebuild

```
# Windows
.\node_modules\.bin\electron-rebuild.cmd

# Linux/Mac
./node_modules/.bin/electron-rebuild
```


**Boot It**

To boot mStream with Electron you have to run the following command:

```
# windows
.\node_modules\.bin\electron .

# Mac/Linux
./node_modules/.bin/electron .
```

**Manually Rebuild SQLite, again**

The first time you boot your mStream server, you'll see an error like:


```
{ Error: Cannot find module 'C:\Users\paul\Documents\Code\mStream\node_modules\sqlite3\lib\binding\node-v53-win32-x64\node_sqlite3.node'
    at Function.Module._resolveFilename (module.js:470:15)
    at Function.Module._load (module.js:418:25)
    at Module.require (module.js:498:17)
    at require (internal/module.js:20:19)
    at Object.<anonymous> (C:\Users\paul\Documents\Code\mStream\node_modules\sqlite3\lib\sqlite3.js:4:15)
    at Object.<anonymous> (C:\Users\paul\Documents\Code\mStream\node_modules\sqlite3\lib\sqlite3.js:190:3)
    at Module._compile (module.js:571:32)
    at Object.Module._extensions..js (module.js:580:10)
    at Module.load (module.js:488:32)
    at tryModuleLoad (module.js:447:12) code: 'MODULE_NOT_FOUND' }
```

This is because there is some bug where Electron looks at the wrong sqlite module file when loading it from a forked thread.  Please note the path of this sqlite module can vary from system to system.  

To fix this first go to your sqlite3 folder in node_modules

```
# Go into your node_modules folder
cd node_modules/sqlite3/lib/binding
```

Next you'll have to look for a folder with the name `electron` in it.  Copy and paste this folder and its contents into the same directory.  Renames this folder to whatever name the error had.

After this you can reboot mStream.  If you no longer see the error, it means everything is working correctly.
