const { app, Tray, Menu, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mkdirp = require('make-dir');
const server = require('../src/server');
const { autoUpdater } = require("electron-updater");

let appIcon;
let trayTemplate;
let updateAlertFlag = false;

const configFile = path.join(app.getPath('userData'), 'save/server-config-v3.json');

if (!fs.existsSync(path.join(app.getPath('userData'), 'image-cache'))) {
  mkdirp(path.join(app.getPath('userData'), 'image-cache'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'save'))) {
  mkdirp(path.join(app.getPath('userData'), 'save'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'db'))) {
  mkdirp(path.join(app.getPath('userData'), 'db'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'logs'))) {
  mkdirp(path.join(app.getPath('userData'), 'logs'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'sync'))) {
  mkdirp(path.join(app.getPath('userData'), 'sync'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'ffmpeg'))) {
  mkdirp(path.join(app.getPath('userData'), 'ffmpeg'));
}

process.on('uncaughtException', (error) => {
  if (error.code === 'EADDRINUSE') {
    // Handle the error
    dialog.showErrorBox("Server Boot Error", "The port you selected is already in use.  Please choose another");
  } else if (error.code === 'BAD CERTS') {
    dialog.showErrorBox("Server Boot Error", "Failed to create HTTPS server.  Please check your certs and try again. " + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + error.message);
  } else {
    dialog.showErrorBox("Unknown Error", "Unknown Error with code: " + error.code + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + error.message);
    console.log(error);
  }

  app.quit();
});

app.whenReady().then(bootServer);

function bootServer() {
  let program;
  try {
    program = JSON.parse(fs.readFileSync(configFile));
  } catch (err) {
    fs.writeFileSync(configFile, JSON.stringify({}), 'utf8');
    program = JSON.parse(fs.readFileSync(configFile));
  }

  // write logs by default
  if (program.writeLogs === undefined) { program.writeLogs = true; }

  // Change default storage params
  if (!program.storage) { program.storage = {}; }
  if (program.storage.albumArtDirectory === undefined) {
    program.storage.albumArtDirectory =  path.join(app.getPath('userData'), 'image-cache');
  }
  if (program.storage.dbDirectory === undefined) {
    program.storage.dbDirectory =  path.join(app.getPath('userData'), 'db');
  }
  if (program.storage.logsDirectory === undefined) {
    program.storage.logsDirectory =  path.join(app.getPath('userData'), 'logs');
  }
  if (program.storage.syncConfigDirectory === undefined) {
    program.storage.syncConfigDirectory =  path.join(app.getPath('userData'), 'sync');
  }

  // Save modified config
  fs.writeFileSync(configFile, JSON.stringify(program, null, 2), 'utf8');

  // TODO: Select unused port
  if (!program.port) { program.port = 3000; }

  const protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';
  trayTemplate = [
    {
      label: `mStream Server v${app.getVersion()}`, click: () => {
        shell.openExternal('http://mstream.io/');
      }
    },
    {
      label: 'Check For Updates', click: () => {
        updateAlertFlag = true;
        autoUpdater.checkForUpdatesAndNotify();
      }
    },
    {
      label: 'Checking AutoBoot...',
    },
    { label: 'Links', submenu: [
      {
        label: `${protocol}://localhost:${program.port}`, click: () => {
          shell.openExternal(protocol + '://localhost:' + program.port)
        }
      },
      {
        label: `${protocol}://localhost:${program.port}/admin`, click: () => {
          shell.openExternal(`${protocol}://localhost:${program.port}/admin`)
        }
      },
    ] },
    { label: 'Debug', submenu: [
      {
        label: 'Open Server File Store', click: () => {
          shell.openPath(app.getPath('userData'));
        }
      },
    ] },
    { type: 'separator' },
    {
      label: 'Quit', click: function () {
        app.isQuiting = true;
        app.quit();
      }
    }
  ];

  appIcon = new Tray(process.platform === 'darwin' ? path.join(__dirname, 'tray-icon.png') : path.join(__dirname, 'tray-icon-osx.png'));
  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate)); // Call this again if you modify the tray menu

  getLoginAtBoot();

  server.serveIt(configFile);
}

let bootBol;
function getLoginAtBoot() {
  bootBol = app.getLoginItemSettings().openAtLogin;
  trayTemplate[2] = {
    label: `${bootBol === true ? 'Disable' : 'Enable'} Boot On Startup`, click: () => {
      toggleBootOnStart();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
}

function toggleBootOnStart() {
  if (typeof bootBol !== 'boolean') { return; }
  const args = { openAtLogin: !bootBol };
  if (process.platform === 'darwin') { args.openAsHidden = true; }
  app.setLoginItemSettings(args);

  bootBol = !bootBol;
  trayTemplate[2] = {
    label: `${bootBol === true ? 'Disable' : 'Enable'} Boot On Startup`, click: () => {
      toggleBootOnStart();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
}

autoUpdater.on('update-available', async (info) => {
  if (updateAlertFlag === true) {
    updateAlertFlag = false;
    const selected = await dialog.showMessageBox({
      buttons: ["Update Now!", "Later"],
      message: "An update is available!"
    });
    if (selected === 0) {
      autoUpdater.quitAndInstall();
    }
  }

  if (!trayTemplate) { return; }

  trayTemplate[1] = {
    label: 'Update Ready: Quit And Install', click: () => {
      autoUpdater.quitAndInstall();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
});

autoUpdater.on('update-not-available', (info) => {
  if (updateAlertFlag === true) {
    updateAlertFlag = false;
    dialog.showMessageBox({
      buttons: ["OK"],
      message: "No Update Available"
    });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  if (!trayTemplate) { return; }

  trayTemplate[1] = {
    label: `Downloading Update (${progressObj.percent}%)`, enabled: false
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
});

autoUpdater.on('update-downloaded', (info) => {
  if (!trayTemplate) { return; }

  trayTemplate[1] = {
    label: 'Update Ready: Quit And Install', click: () => {
      autoUpdater.quitAndInstall();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
});
