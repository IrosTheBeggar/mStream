import { app, Tray, Menu, shell, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import winston from 'winston';
import * as server from '../src/server.js';
import * as logger from '../src/logger.js';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let appIcon;
let trayTemplate;
let updateAlertFlag = false;

const configFile = path.join(app.getPath('userData'), 'save/server-config-v3.json');

if (!fs.existsSync(path.join(app.getPath('userData'), 'image-cache'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'image-cache'), { recursive: true });
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'save'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'save'), { recursive: true });
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'db'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'db'), { recursive: true });
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'logs'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'sync'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'sync'), { recursive: true });
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'ffmpeg'))) {
  fs.mkdirSync(path.join(app.getPath('userData'), 'ffmpeg'), { recursive: true });
}

let fatalHandled = false;
function handleFatalError(error) {
  // Boot/runtime failures used to only reach console.log here, which is
  // invisible in a packaged AppImage/NSIS build — so users saw the server fail
  // to start with nothing in the log file explaining why. Route the error
  // through winston FIRST so it lands in the on-disk log (file transport is
  // attached early in bootServer) and the admin live-log buffer, then surface
  // a dialog and quit. Guarded so a cascade during shutdown shows one dialog.
  if (fatalHandled) { return; }
  fatalHandled = true;

  const err = error instanceof Error ? error : new Error(String(error));
  try {
    winston.error('Fatal error — server did not finish booting', { stack: err });
  } catch (_logErr) { /* logging must never mask the original failure */ }

  if (err.code === 'EADDRINUSE') {
    dialog.showErrorBox("Server Boot Error", "The port you selected is already in use.  Please choose another");
  } else if (err.code === 'BAD CERTS') {
    dialog.showErrorBox("Server Boot Error", "Failed to create HTTPS server.  Please check your certs and try again. " + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + err.message);
  } else {
    dialog.showErrorBox("Unknown Error", "Unknown Error with code: " + err.code + os.EOL + os.EOL + os.EOL + "ERROR MESSAGE: " + err.message);
  }

  app.quit();
}

// serveIt() is async and its rejection would otherwise become an unhandled
// rejection; non-promise throws (e.g. the server's EADDRINUSE 'error' event with
// no listener) surface as uncaughtException. Capture both.
process.on('uncaughtException', handleFatalError);
process.on('unhandledRejection', handleFatalError);

app.whenReady().then(bootServer).catch(handleFatalError);

function bootServer() {
  let program;
  try {
    program = JSON.parse(fs.readFileSync(configFile));
  } catch (_err) {
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

  // Set ffmpeg directory for transcode
  if (!program.transcode) { program.transcode = {}; }
  if (program.transcode.ffmpegDirectory === undefined) {
    program.transcode.ffmpegDirectory = path.join(app.getPath('userData'), 'ffmpeg');
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

  appIcon = new Tray(path.join(__dirname, process.platform === 'darwin' ? 'tray-icon-osx.png' : 'tray-icon.png'));
  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate)); // Call this again if you modify the tray menu

  getLoginAtBoot();

  // Attach the on-disk logger BEFORE booting so any failure during boot —
  // config validation, port-in-use, bad certs, a throwing setup step — is
  // written to the log file. serveIt() attaches its own file logger after it
  // validates the config (server.js), but errors thrown before that point would
  // otherwise never reach disk. addFileLogger() resets any existing transport,
  // so serveIt re-pointing to the same directory is a no-op, not a duplicate.
  if (program.writeLogs) {
    try {
      logger.addFileLogger(program.storage.logsDirectory);
    } catch (_err) { /* fall back to console/live-buffer logging */ }
  }

  server.serveIt(configFile).catch(handleFatalError);
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

autoUpdater.on('update-available', async (_info) => {
  if (updateAlertFlag === true) {
    updateAlertFlag = false;
    const { response } = await dialog.showMessageBox({
      buttons: ["Update Now!", "Later"],
      message: "An update is available!"
    });
    if (response === 0) {
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

autoUpdater.on('update-not-available', (_info) => {
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

autoUpdater.on('update-downloaded', (_info) => {
  if (!trayTemplate) { return; }

  trayTemplate[1] = {
    label: 'Update Ready: Quit And Install', click: () => {
      autoUpdater.quitAndInstall();
    }
  };

  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
});
