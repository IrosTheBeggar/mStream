const program = require('commander');
const fs = require('fs');
const colors = require('colors');

exports.setup = function (args) {
  program
    .version('4.0.0')
    // Server Config
    .option('-p, --port <port>', 'Select Port', /^\d+$/i)
    .option('-i, --userinterface <folder>', 'Specify folder name that will be served as the UI')
    .option('-s, --secret <secret>', 'Set the login secret key')
    .option('-I, --images <images>', 'Set the image folder')
    .option('-d, --dbpath <dbpath>', 'Set folder to save DB to')
    .option('-A, --logspath <logspath>', 'Set folder to save logs to')
    .option('-m, --musicdir <musicdir>', 'Set the music folder', process.cwd())
    .option('-N, --noupload', 'Disable Uploading')

    // SSL
    .option('-c, --cert <cert>', 'SSL Certificate File')
    .option('-k, --key <key>', 'SSL Key File')

    // User System
    .option('-u, --user <user>', 'Set Username')
    .option('-x, --password <password>', 'Set Password')

    // Port Forwarding
    .option('-t, --tunnel', 'Use nat-pmp to configure port forwarding')
    .option('-g, --gateway <gateway>', 'Manually set gateway IP for the tunnel option')
    .option('-r, --refresh <refresh>', 'Refresh rate', /^\d+$/i)

    // lastFM
    .option('-l, --luser <user>', 'Set LastFM Username')
    .option('-z, --lpass <password>', 'Set LastFM Password')

    // DB
    .option('-E, --scaninterval <scaninterval>', 'Specify Database Scan Interval (In Hours)', /^\d+$/i, 24)
    .option('-D, --saveinterval <saveinterval>', 'Specify Database Save Interval', /^\d+$/i, 250)
    .option('-S, --skipimg', 'While skip parsing album art if flagged')
    .option('-B, --bootdelay <bootdelay>', 'Specify Boot Scan  Pause (In Seconds)', /^\d+$/i, 3)    
    .option('-P, --dbpause <dbpause>', 'Specify File Scan Pause Interval (in Milliseconds)', /^\d+$/i, 0)

    // Logs
    .option('-L, --logs', 'Enable Write Logs To Disk')

    // JSON config
    .option('-j, --json <json>', 'Specify JSON Boot File')

    // Mod JSON Commands
    .option("--addkey <file>", "Add an SSL Key")
    .option("--addcert <file>", "Add an SSL Cert")
    .option("--wizard [file]", "Setup Wizard")

    .parse(args);

  // TODO: If no params are supplied, try to use default.json
  

  if (program['wizard']) {
    require('./config-inquirer').wizard(program.wizard);
    return false;
  }

  // Use JSON config
  if (program.json) {
    try {
      var loadJson = JSON.parse(fs.readFileSync(program.json, 'utf8'));
    } catch (error) {
      // This condition is hit only if the user entered a json file as an argument and the file did not exist or is invalid JSON
      console.log("ERROR: Failed to parse JSON file");
      return false;
    }

    if (program['addkey']) {
      require('./config-inquirer').addKey(loadJson, program.addkey, modJson => {
        fs.writeFileSync( program.json, JSON.stringify(modJson, null, 2), 'utf8');
        console.log(colors.green('SSL Key Added!'));
      });
      return false;
    }

    if (program['addcert']) {
      require('./config-inquirer').addCert(loadJson, program.addcert, modJson => {
        fs.writeFileSync( program.json, JSON.stringify(modJson, null, 2), 'utf8');
        console.log(colors.green('SSL Cert Added!'));
      });
      return false;
    }

    // No commands, continue
    require('./configure-json-file.js').setup(loadJson);
    loadJson.configFile = program.json;
    return loadJson;
  }

  let program3 = {
    port: Number(program.port),
    webAppDirectory: program.userinterface,
    storage: {}
  }

  if (program.secret) {
    program3.secret = program.secret;
  }

  program3.folders = {
    'media': { root: program.musicdir }
  }

  // User account
  if (program.user && program.password) {
    program3.users = {};
    program3.users[program.user] = {
      password: program.password,
      vpaths: ['media']
    }

    if (program.luser && program.lpass) {
      program3.users[program.user]['lastfm-user'] = program.luser;
      program3.users[program.user]['lastfm-password'] = program.lpass;
    }
  }

  // This adds lastFM support for systems without users
  if ( program.luser && program.lpass) {
    program3['lastfm-user'] = program.luser;
    program3['lastfm-password'] = program.lpass;  
  }

  program3.scanOptions = {
    scanInterval: Number(program.scaninterval),
    saveInterval: Number(program.saveinterval),
    pause: Number(program.dbpause),
    bootScanDelay: Number(program.bootdelay)
  }

  if (program.skipimg) {
    program3.scanOptions.skipImg = true;
  }

  // port forwarding
  if (program.tunnel) {
    program3.tunnel = {};

    if (program.refresh) {
      program3.tunnel.refreshInterval = Number(program.refresh);
    }
    if (program.gateway) {
      program3.tunnel.gateway = program.gateway;
    }
    if (program.protocol) {
      program3.tunnel.protocol = program.protocol;
    }
  }

  if (program.noupload) {
    program3.noUpload = true;
  }

  // SSL stuff
  if (program.key && program.cert) {
    program3.ssl = {};
    program3.ssl.key = program.key;
    program3.ssl.cert = program.cert;
  }

  // images
  if (program.images) {
    program3.storage.albumArtDirectory = program.images;
  }

  if (program.dbpath) {
    program3.storage.dbDirectory = program.dbpath;
  }

  if (program.logspath) {
    program3.storage.logsDirectory = program.logspath;
  }

  // Logs
  if (program.logs) {
    program3.writeLogs = true;
  }

  return program3;
}
