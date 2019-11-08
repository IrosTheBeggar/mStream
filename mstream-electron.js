const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const fe = require('path');
const os = require('os');
const mkdirp = require('make-dir');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require("electron-updater");

const mstreamAutoLaunch = new AutoLaunch({ name: 'mStream' });
const configFile = fe.join(app.getPath('userData'), 'save/server-config-v2.json');
let appIcon;
let trayTemplate;

if (!fs.existsSync(fe.join(app.getPath('userData'), 'image-cache'))) {
  mkdirp(fe.join(app.getPath('userData'), 'image-cache'));
}

if (!fs.existsSync(fe.join(app.getPath('userData'), 'save'))) {
  mkdirp(fe.join(app.getPath('userData'), 'save'));
}

if (!fs.existsSync(fe.join(app.getPath('userData'), 'save'))) {
  mkdirp(fe.join(app.getPath('userData'), 'logs'));
}

if (!fs.existsSync(fe.join(app.getPath('userData'), 'sync'))) {
  mkdirp(fe.join(app.getPath('userData'), 'sync'));
}

if (!fs.existsSync(fe.join(app.getPath('userData'), 'ffmpeg'))) {
  mkdirp(fe.join(app.getPath('userData'), 'ffmpeg'));
}

// Errors
process.on('uncaughtException', function (error) {
  // Handle Known Errors
  if (error.code === 'EADDRINUSE') {
    // Handle the error
    dialog.showErrorBox("Server Boot Error", "The port you selected is already in use.  Please choose another");
  } else if (error.code === 'BAD CERTS') {
    dialog.showErrorBox("Server Boot Error", "Failed to create HTTPS server.  Please check your certs and try again. " + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + error.message);
  }

  // Unknown Errors
  else {
    dialog.showErrorBox("Unknown Error", "Unknown Error with code: " + error.code + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + error.message);
    console.log(error);
    // TODO: Dump error details to a file
  }

  // Temporarily disable autoboot
  fs.writeFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({ disable: true }), 'utf8');

  // Reboot the app
  app.relaunch();
  app.quit();
});


// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createMainWindow);

// Quit if server hasn't been started
app.on('window-all-closed', function () {
  if (!server) {
    app.quit();
  }

  if (process.platform === 'darwin') {
    app.dock.hide()
  }
})

app.on('activate', function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createMainWindow();
  }
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
function createMainWindow() {
  if (server || mainWindow) {
    return;
  }

  let loadJson = false;
  try {
    if (fs.statSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json')).isFile()) {
      const loadJson9 = JSON.parse(fs.readFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), 'utf8'));
      if (loadJson9.disable === false && fs.statSync(configFile).isFile()) {
        loadJson = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      }
    }
  } catch(error){
    loadJson = false;
    console.log('Failed To Load JSON');
  }

  if (loadJson) {
    bootServer(loadJson);
    return;
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({ webPreferences: { nodeIntegration: true },  width: 850, height: 550, icon: fe.join(__dirname, '/electron/mstream-logo-cut.png') });
  mainWindow.setMenu(null);
  
  mainWindow.loadURL('file://' + __dirname + '/electron/index3.html');
  // Open the DevTools.
  // mainWindow.webContents.openDevTools();

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    mainWindow = null;
  });
}

// Boot Server Event
ipcMain.once('start-server', function (event, arg) {
  bootServer(arg);
});

var server;
function bootServer(program) {
  program.webAppDirectory = fe.join(__dirname, 'public');
  program.storage.albumArtDirectory = program.storage.albumArtDirectory ? program.storage.albumArtDirectory : fe.join(app.getPath('userData'), 'image-cache');
  program.storage.dbDirectory = program.storage.dbDirectory ? program.storage.dbDirectory : fe.join(app.getPath('userData'), 'save');
  program.ddns.iniFile = fe.join(app.getPath('userData'), 'save/frpc.ini');
  program.writeLogs = program.storage.logsDirectory ? true : false;
  program.configFile = configFile;

  // Auto Boot
  if (program.autoboot && program.autoboot === true) {
    mstreamAutoLaunch.enable();
    fs.writeFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({ disable: false }), 'utf8');
  }

  // Tray Template Object
  const protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';
  trayTemplate = [
    {
      label: 'mStream Server v' + app.getVersion(), click: function () {
        shell.openExternal('http://mstream.io/');
      }
    },
    {
      label: 'Check For Updates', click: function () {
        autoUpdater.checkForUpdatesAndNotify();
      }
    },
    { type: 'separator' },
    { label: 'Links', submenu: [
      {
        label: protocol + '://localhost:' + program.port, click: function () {
          shell.openExternal(protocol + '://localhost:' + program.port)
        }
      },
      {
        label: protocol + '://localhost:' + program.port + '/winamp', click: function () {
          shell.openExternal(protocol + '://localhost:' + program.port + '/winamp')
        }
      },
    ] },
    {
      label: 'Restart and Reconfigure', click: function () {
        fs.writeFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({ disable: true }), 'utf8');
        app.relaunch();
        app.isQuiting = true;
        app.quit();
      }
    },
    {
      label: 'Disable Autoboot', click: function () {
        mstreamAutoLaunch.disable();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit', click: function () {
        app.isQuiting = true;
        app.quit();
      }
    }
  ];

  // Check if Auto DNS is logged in
  if (program.ddns.tested === true) {
    trayTemplate[3].submenu.push({ type: 'separator' });
    trayTemplate[3].submenu.push({
      label: 'https://' + program.ddns.url, click: function () {
        shell.openExternal('https://' + program.ddns.url)
      }
    });
  }

  // Create Tray Icon
  appIcon = new Tray(process.platform === 'darwin' ? fe.join(__dirname, '/electron/images/icon.png') :  fe.join(__dirname, '/electron/mstream-logo-cut.png'));
  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate)); // Call this again if you modify the tray menu
  
  
  // TODO: Try booting server in forked thread instead.  Might give some speed improvements
  server = require('./mstream.js');
  server.serveIt(program);
}

autoUpdater.on('update-available', (info) => {
  if (!trayTemplate) { return; }

  trayTemplate[1] = {
    label: 'Update Ready: Quit And Install', click: function () {
      autoUpdater.quitAndInstall();
    }
  };

  trayTemplate[4] = {
    label: 'Restart and Reconfigure', click: function () {
      fs.writeFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({ disable: true }), 'utf8');
      app.isQuiting = true;
      autoUpdater.quitAndInstall();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
});