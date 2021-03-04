const { app, Tray, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const mkdirp = require('make-dir');
const server = require('../src/server');

let appIcon;
let trayTemplate;

const configFile = path.join(app.getPath('userData'), 'save/server-config-v3.json');

if (!fs.existsSync(path.join(app.getPath('userData'), 'image-cache'))) {
  mkdirp(path.join(app.getPath('userData'), 'image-cache'));
}

if (!fs.existsSync(path.join(app.getPath('userData'), 'save'))) {
  mkdirp(path.join(app.getPath('userData'), 'save'));
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

app.whenReady().then(bootServer);

function bootServer() {
  let program;
  try {
    program = JSON.parse(fs.readFileSync(configFile));
  } catch (err) {
    fs.writeFileSync(configFile, JSON.stringify({}), 'utf8');
    program = JSON.parse(fs.readFileSync(configFile));
  }

  const protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';
  trayTemplate = [
    {
      label: `mStream Server v${app.getVersion()}`, click: () => {
        shell.openExternal('http://mstream.io/');
      }
    },
    // {
    //   label: 'Check For Updates', click: function () {
    //     autoUpdater.checkForUpdatesAndNotify();
    //   }
    // },
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
    { type: 'separator' },
    {
      label: 'Restart Server', click: function () {
        app.isQuiting = true;
        app.quit();
      }
    },
    {
      label: 'Quit', click: function () {
        app.isQuiting = true;
        app.quit();
      }
    }
  ];

  appIcon = new Tray(process.platform === 'darwin' ? path.join(__dirname, 'tray-icon.png') : path.join(__dirname, 'tray-icon-osx.png'));
  appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate)); // Call this again if you modify the tray menu

  server.serveIt(configFile);
}