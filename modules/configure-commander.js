exports.setup = function(args){
  const program = require('commander');
  program
    .version('3.0.7')
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
    .option('-e, --email <email>', 'Set User Email (optional)')
    .option('-G, --guestname <guestname>', 'Set Guest Username')
    .option('-X, --guestpassword <guestpassword>', 'Set Guest Password')

    // Port Forwarding
    .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
    .option('-g, --gateway <gateway>', 'Manually set gateway IP for the tunnel option')
    .option('-r, --refresh <refresh>', 'Refresh rate', /^\d+$/i)
    .option('-o, --protocol <protocol>', 'Protocol for tunneling', /^(upnp|natpmp)$/i, 'natpnp')

    // DB
    .option('-d, --database <path>', 'Specify Database Filepath', 'mstream.db')
    .option('-D, --databaseplugin <databaseplugin>', '', /^(sqlite|beets)$/i, 'sqlite') // TODO: Remove this

    .parse(args);


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

  // User account
  if(program.user && program.password){
    program3.users = {};
    program3.users[program.user] = {
      password:program.password,
      musicDir:program.musicdir
    };

    if(program.email){
      program3.users[program.user].email = program.email;
    }

    // Guest account
    if(program.guestname && program.guestpassword){
      program3.users[program.guestname] = {
        password:program.guestpassword,
        guestTo:program.user
      };
    }
  }else{
    console.log('USER SYSTEM NOT ENABLED!');
    // Store the musicDir to be used in setup
    program3.musicDir = program.musicdir;
  }

  // db plugins
  program3.database_plugin = {
    type:program.databaseplugin,
    dbPath:program.database
  };

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
