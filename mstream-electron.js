const {app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell} = require('electron');
const fs = require('fs');
const fe = require('path');
const os = require('os');
const publicIp = require('public-ip');
const semver = require('semver')
const superagent = require('superagent');

const currentVer = '0.6.0';
var apiKey;
const ddnsDomain = 'https://ddns.mstream.io';
let appIcon = null;
const mkdirp = require('mkdirp');


const AutoLaunch = require('auto-launch');
var mstreamAutoLaunch = new AutoLaunch({
    name: 'mStream'
});


if (!fs.existsSync(fe.join(app.getPath('userData'), 'image-cache'))){
    mkdirp(fe.join(app.getPath('userData'), 'image-cache'), function(){});
}

if (!fs.existsSync(fe.join(app.getPath('userData'), 'save'))){
    mkdirp(fe.join(app.getPath('userData'), 'save'), function(){});
}

// Errors
process.on('uncaughtException', function (error) {
  // Handle Known Errors
  if(error.code === 'EADDRINUSE'){
    // Handle the error
    dialog.showErrorBox("Server Boot Error", "The port you selected is already in use.  Please choose another");
  }else if(error.code === 'BAD CERTS'){
    dialog.showErrorBox("Server Boot Error", "Faield to create HTTPS server.  Plese check your certs and try again. "+os.EOL+os.EOL+os.EOL+"ERROR MESSAGE: " + error.message);
  }
  // Unknown Errors
  else{
    dialog.showErrorBox("Unknown Error", "Unknown Error with code: " + error.code +os.EOL+os.EOL+os.EOL+"ERROR MESSAGE: " + error.message);
    console.log(error);
    // TODO: Dump error details to a file
  }

  // Temporarily disable autoboot
  fs.writeFileSync( fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({disable:true}), 'utf8');

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
  if(!server){
    app.quit();
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

function createMainWindow () {
  if(server || mainWindow){
    // TODO: Should we diplay a stats window here?
    return;
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({width: 550 , height: 775, icon: fe.join(__dirname, '/electron/mstream-logo-cut.png') });

  // and load the index.html of the app.
  mainWindow.loadURL('file://' + __dirname + '/electron/index2.html');
  mainWindow.setMenu(null);

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });
}



let infoWindow;
function createInfoWindow(name){
  // Close current Info Window
  if(infoWindow){
    infoWindow.close();
  }

  // Create new Window
  infoWindow = new BrowserWindow({width: 600 , height: 400, icon: fe.join(__dirname, '/electron/mstream-logo-cut.png') });

  // and load the index.html of the app.
  infoWindow.loadURL('file://' + __dirname + '/electron/windows/' + name + '.html');
  infoWindow.setMenu(null);

  // Emitted when the window is closed.
  infoWindow.on('closed', function () {
    infoWindow = null;
  });
}

// TODO: Combine this function into the info window function
let learnMoreWindow;
function createLearnMoreWindow(){
  if(learnMoreWindow){
    return
  }
  learnMoreWindow = new BrowserWindow({width: 1050 , height: 950, icon: fe.join(__dirname, '/mstream-logo-cut.png') });

  // and load the index.html of the app.
  learnMoreWindow.loadURL('file://' + __dirname + '/electron/windows/managed-ddns-ssl-learn-more.html');
  learnMoreWindow.setMenu(null);

  // Emitted when the window is closed.
  learnMoreWindow.on('closed', function () {
    learnMoreWindow = null;
  });
}

ipcMain.on('port-forward-window', function(event, arg) {
  createInfoWindow('portforward');
});
ipcMain.on('auto-boot-window', function(event, arg) {
  createInfoWindow('autoboot');
});
ipcMain.on('managed-window', function(event, arg) {
  createLearnMoreWindow();
});


// Boot Server Event
ipcMain.once('start-server', function(event, arg) {
  bootServer(arg);
});

// Flush DNS Cache event
ipcMain.once('flush-dns-cache', function(event, arg) {
  flushDNSCache();
});

var server;
function bootServer(program2) {
  // TODO: Verify port and folder

  var program = {
    port: program2.port,
    userinterface: 'public',
    database_plugin: {
      dbPath: fe.join(app.getPath('userData'), 'save/mstreamXdb.lite')
    },
    musicDir: program2.filepath
  }

  // Generate Secret Key if there isn't one already
  try{
    if(fs.statSync(fe.join(app.getPath('userData'), 'save/secret.key')).isFile()){
      program.secret = fs.readFileSync(fe.join(app.getPath('userData'), 'save/secret.key'), 'utf8');
    }
  }catch(error){
    let buff = require('crypto').randomBytes(256).toString('hex');
    program.secret = buff;
    fs.writeFileSync( fe.join(app.getPath('userData'), 'save/secret.key'), buff, 'utf8');
  }

  if(program2.user){
    program.users = {};
    program.users[program2.user] = {};
    program.users[program2.user].password = program2.password;
    program.users[program2.user].musicDir = program2.filepath;

    // TODO: Auto generate UUID as well
    try{
      if(fs.statSync(fe.join(app.getPath('userData'), 'save/uuid.key')).isFile()){
        program.users[program2.user].vPath = fs.readFileSync(fe.join(app.getPath('userData'), 'save/uuid.key'), 'utf8');
      }
    }catch(error){
      let uuid = require('uuid/v4')();
      program.users[program2.user].vPath = uuid;
      fs.writeFileSync( fe.join(app.getPath('userData'), 'save/uuid.key'), uuid, 'utf8');
    }

  }

  if(program2.cert && program2.key){
    program.ssl = {};
    program.ssl.key = program2.key;
    program.ssl.cert = program2.cert;
  }

  if(program2.tunnel){
    program.tunnel = {}

    if(program2.interval && program2.refresh){
      program.tunnel.refreshInterval = program2.interval;
    }
    // if(program.gateway){
    //   program3.tunnel.gateway = program.gateway;
    // }
    if(program2.protocol){
      program.tunnel.protocol = program2.protocol;
    }

    program.albumArtDir =  fe.join(app.getPath('userData'), 'image-cache');
  }




  // Save config
  if((program2.saveconfig && program2.saveconfig == true) || (program2.autoboot && program2.autoboot === true)){
    fs.writeFileSync( fe.join(app.getPath('userData'), 'save/mstreaserver-config.json'), JSON.stringify(program2), 'utf8');
    fs.writeFileSync( fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({disable:false}), 'utf8');
  }

  // Tray Template Object
  var trayTemplate = [
    { label: 'mStrean Express v' + currentVer, click: function(){
      shell.openExternal('http://mstream.io/mstream-express');
    }},
    { label: 'Check for latest version', click: function(err, res){
      superagent.get('https://ddns.mstream.io/current-version/mstream-express').end(function(err, res){

        if (err || !res.ok) {
          console.log('Error checking for latest version');
        } else {

          if(semver.gt(res.text, currentVer)){
            trayTemplate[1].label = 'Download latest version v' + res.text;
            trayTemplate[1].click = function(){
              shell.openExternal('http://mstream.io/mstream-express');
            }
            appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
            shell.openExternal('http://mstream.io/mstream-express');

          }else{
            createInfoWindow('latest-ver');
          }
        }
      });
    }},
    {type: 'separator'},

    { label: 'Links', submenu: []},
    {type: 'separator'},

    { label: 'Disable Autoboot', click:  function(){
        // app.isQuiting = true;
        // app.quit();
        mstreamAutoLaunch.disable();
        try{
          if(  fs.statSync(fe.join(app.getPath('userData'), 'save/mstreaserver-config.json')).isFile()){
            var loadJson = JSON.parse(fs.readFileSync(fe.join(app.getPath('userData'), 'save/mstreaserver-config.json'), 'utf8'));
            loadJson.autoboot = false;
            fs.writeFileSync( fe.join(app.getPath('userData'), 'save/mstreaserver-config.json'), JSON.stringify(loadJson), 'utf8');

          }
        }catch(error){
          console.log('Failed To Load JSON');
          return;
        }

    } },
    { label: 'Restart and Reconfigure', click:  function(){

        fs.writeFileSync( fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({disable:true}), 'utf8');

        app.relaunch();
        app.isQuiting = true;
        app.quit();

    } },
    { label: 'Advanced Options', submenu: [
      { label: 'Flush DNS (exprimental)', click: function(){
          flushDNSCache();
      } }
    ] },
    {type: 'separator'},
    { label: 'Managed DDNS + SSL', submenu: [
      { label: 'Learn More', click: function(){
          createLearnMoreWindow();
      } },
      {type: 'separator'},
      { label: 'Restart Server To Sign Up', click: function(){
          fs.writeFileSync( fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({disable:true}), 'utf8');

          app.relaunch();
          app.isQuiting = true;
          app.quit();
      } },
    ] },
    {type: 'separator'},
    { label: 'Donate', click:  function(){
        shell.openExternal('https://www.patreon.com/mstream')
    } },
    {type: 'separator'},
    { label: 'Quit', click:  function(){
        app.isQuiting = true;
        app.quit();
    } }
  ]

  // Create Tray Icon
  appIcon = new Tray(fe.join(__dirname, '/electron/mstream-logo-cut.png'));
  var contextMenu = Menu.buildFromTemplate(trayTemplate);

  // TODO: Try booting server in forked thread instead.  Might give some speed improvements
  server = require('./mstream.js');
  server.logit = function(msg){
    // Push to Window
    // ipcMain.send('info', msg);
    if(mainWindow){
      mainWindow.webContents.send('info' , msg);
    }

    trayTemplate[3].submenu = [];

    // Update tray icon
    for (var property in server.addresses) {
      if (server.addresses.hasOwnProperty(property) && server.addresses[property]) {
        let add = server.addresses[property];

        trayTemplate[3].submenu.push({
          label: add, click:  function(){
            shell.openExternal(add)
          }
        })

        appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
      }
    }
  }

  // Boot Server
  server.serveit(program);

  // Call this again for Linux because we modified the context menu
  appIcon.setContextMenu(contextMenu);


  if(program2.autoboot && program2.autoboot === true){
    mstreamAutoLaunch.enable();
    mstreamAutoLaunch.isEnabled()
    .then(function(isEnabled){
      if(isEnabled){
        return;
      }
      mstreamAutoLaunch.enable();
    })
    .catch(function(err){
      // handle error
    });
  }
  // else{
  //   mstreamAutoLaunch.disable();
  // }


  // Automatically check for new versions every day
  checkForNewVer(trayTemplate);
  setInterval(function(){ checkForNewVer(trayTemplate); }, 43200000);


  // Check if the user is logged in
  var configFile = fe.join(app.getPath('userData'), 'save/mstream-api-token.json');
  try{
    if(  fs.statSync(configFile).isFile()){
      apiKey = fs.readFileSync(configFile, 'utf8');


      // Make sure key is valid and working
      superagent.get('https://ddns.mstream.io/login-status?token=' + apiKey).end(function(err, res){
        if (err || !res.ok) {
          console.log('Error checking login status');
          console.log(err);
          return;
        }

        // Update IP every minute
        setInterval(function(){ updateIP(); }, 60000);

        // trayTemplate[7].submenu.push({ label: 'Update IP', click: function(){
        //     updateIP();
        // }});

        trayTemplate[9].submenu = [
          { label: 'Force IP Update', click: function(){
            updateIP();
          }},
          {type: 'separator'},
          { label: 'Logout', click: function(){
            app.isQuiting = true;

            fs.writeFileSync( fe.join(app.getPath('userData'), 'save/mstream-api-token.json'), '', 'utf8');
            fs.writeFileSync( fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({disable:true}), 'utf8');
            app.relaunch();
            app.quit();
          }}
        ]

        try{
          var parsedRes = JSON.parse(res.text);
          // Add domain to list of domains
          var add = 'https://' + parsedRes.full_domain + ':' + program.port;
          trayTemplate[3].submenu.push({
            label: add, click:  function(){
              shell.openExternal(add)
            }
          })
        }catch(err){

        }

        // trayTemplate.push({ label: 'Logout', click: function(){
        //   fs.writeFileSync( fe.join(app.getPath('userData'), 'save/mstream-api-token.json'), '', 'utf8');
        //   app.relaunch();
        //   app.quit();
        // }})

        appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
      });
    }
  }catch(error){
    return;
  }


}

function checkForNewVer(trayTemplate){
  superagent.get('https://ddns.mstream.io/current-version/mstream-express').end(function(err, res){
    if (err || !res.ok) {
      console.log('Error checking for latest version');
    } else {

      if(semver.gt(res.text, currentVer)){
        trayTemplate[1].label = 'New Version Available: v' + res.text;
        trayTemplate[1].click = function(){
          shell.openExternal('http://mstream.io/mstream-express');
        }
        appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));

      }
    }
  });
}


// TODO: Experimental function to clean the users cache
function flushDNSCache(){
  if(process.platform === 'win32'){
    const ls = require('child_process').spawn('ipconfig.exe', ["\/flushdns"]);

    ls.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });

    ls.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`);
    });

    ls.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
    });
  }
}



// Function that updates IP
var currentIP;
function updateIP(){
  console.log('UPDATING IP')
  publicIp.v4().then(ip => {
    if(ip !== currentIP){
      superagent.post('https://ddns.mstream.io/update/ip')
        .set('x-access-token', apiKey)
        .set('Accept', 'application/json')
        .send({ ip: ip})
        .end(function(err, res){
          console.log('Update happened');

          if (err || !res.ok) {
            console.log('Update IP failed');
            console.log(err);

          }

        });

    }

    currentIP = ip;
  });
}
