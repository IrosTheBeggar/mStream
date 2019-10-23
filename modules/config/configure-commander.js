const program = require('commander');
const fs = require('fs');

exports.setup = function (args) {
  program
    .version('5.0.0')
    // Server Config
    .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
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

    // Transcoding
    .option('-t, --transcode', 'Enable Transcoding')
    .option('-f, --ffmpeg <ffmpeg>', 'ffmpeg directory')

    // JSON config
    .option('-j, --json <json>', 'Specify JSON Boot File')

    // Wizard
    .option("-w, --wizard [file]", "Setup Wizard")
    .parse(args);  
  
  if (program['wizard']) {
    require('./config-inquirer').wizard(program.wizard);
    return false;
  }

  // Use JSON config
  if (program.json) {
    try {
      var loadJson = JSON.parse(fs.readFileSync(program.json, 'utf8'));
      loadJson.configFile = program.json;
      return loadJson;
    } catch (error) {
      console.log("ERROR: Failed to parse JSON file");
      return false;
    }
  }

  let program3 = {
    folders: { media: { root: program.musicdir } },
    port: Number(program.port),
    storage: {}
  }

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
  } else if (program.luser && program.lpass) {
    program3['lastfm-user'] = program.luser;
    program3['lastfm-password'] = program.lpass;  
  }

  program3.scanOptions = {
    scanInterval: Number(program.scaninterval),
    saveInterval: Number(program.saveinterval),
    pause: Number(program.dbpause),
    bootScanDelay: Number(program.bootdelay)
  }

  // SSL stuff
  if (program.key && program.cert) {
    program3.ssl = {};
    program3.ssl.key = program.key;
    program3.ssl.cert = program.cert;
  }

  // transcode
  if (program.transcode) {
    program3.transcode = { enabled: true };
    if (program.ffmpeg) {
      program3.transcode.ffmpegDirectory = program.ffmpeg;
    }
  }

  if (program.userinterface) { program3.webAppDirectory = program.userinterface }
  if (program.secret) { program3.secret = program.secret; }
  if (program.skipimg) { program3.scanOptions.skipImg = true; }
  if (program.noupload) { program3.noUpload = true; }
  if (program.images) { program3.storage.albumArtDirectory = program.images; }
  if (program.dbpath) { program3.storage.dbDirectory = program.dbpath; }
  if (program.logspath) { program3.storage.logsDirectory = program.logspath; }
  if (program.logs) { program3.writeLogs = true; }
  return program3;
}
