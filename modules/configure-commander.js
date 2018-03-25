exports.setup = function(args){
  const program = require('commander');
  const fs = require('fs');

  program
    .version('3.3.2')
    // Server Config
    .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
    .option('-i, --userinterface <folder>', 'Specify folder name that will be served as the UI', 'public')
    .option('-s, --secret <secret>', 'Set the login secret key')
    .option('-I, --images <images>', 'Set the image folder')
    .option('-m, --musicdir <musicdir>', 'Set the music folder', process.cwd())

    // SSL
    .option('-c, --cert <cert>', 'SSL Certificate File')
    .option('-k, --key <key>', 'SSL Key File')

    // User System
    .option('-u, --user <user>', 'Set Username')
    .option('-x, --password <password>', 'Set Password')

    // Port Forwarding
    .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
    .option('-g, --gateway <gateway>', 'Manually set gateway IP for the tunnel option')
    .option('-r, --refresh <refresh>', 'Refresh rate', /^\d+$/i)
    .option('-o, --protocol <protocol>', 'Protocol for tunneling', /^(upnp|natpmp)$/i, 'natpnp')

    // lastFM
    .option('-l, --luser <user>', 'Set LastFM Username')
    .option('-z, --lpass <password>', 'Set LastFM Password')

    // DB
    .option('-d, --database <path>', 'Specify Database Filepath', 'mstream.db')

    // JSON config
    .option('-j, --json <json>', 'Specify JSON Boot File')

    .parse(args);

  // Use JSON config
  if(program.json){
    try{
      let loadJson = JSON.parse(fs.readFileSync(program.json, 'utf8'));
      return require('./configure-json-file.js').setup(loadJson, __dirname);
    }catch(error){
      // This condition is hit only if the user entered a json file as an argument and the file did not exist or is invalid JSON
      console.log("ERROR: Failed to parse JSON file");
      process.exit(1);
      return;
    }
  }


  let program3 = {
    port:program.port,
    userinterface:program.userinterface,
  }

  if(program.secret){
    program3.secret = program.secret;
  }
  if(program.salt){
    program3.salt = program.salt;
  }

  program3.folders = {
    'media': {root: program.musicdir}
  }

  // User account
  if(program.user && program.password){
    program3.users = {};
    program3.users[program.user] = {
      password: program.password,
      vpaths: ['media']
    }

    if(program.luser && program.lpass){
      program3.users[program.user]['lastfm-user'] = program.luser;
      program3.users[program.user]['lastfm-password'] = program.lpass;
    }
  }

  // This adds lastFM support for systems without users
  program3['lastfm-user'] = program.luser;
  program3['lastfm-password'] = program.lpass;

  // db plugins
  program3.database_plugin = {
    dbPath:program.database
  }

  // port forwarding
  if(program.tunnel){
    program3.tunnel = {};

    if(program.refresh){
      program3.tunnel.refreshInterval = program.refresh;
    }
    if(program.gateway){
      program3.tunnel.gateway = program.gateway;
    }
    if(program.protocol){
      program3.tunnel.protocol = program.protocol;
    }
  }

  // SSL stuff
  if(program.key && program.cert){
    program3.ssl = {};
    program3.ssl.key = program.key;
    program3.ssl.cert = program.cert;
  }

  // images
  if(program.images){
    program3.albumArtDir = program.images;
  }

  return program3;
}
