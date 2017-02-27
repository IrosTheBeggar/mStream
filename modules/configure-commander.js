exports.setup = function(args){
  const program = require('commander');
  program
    .version('2.5.0')
    .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
    .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
    .option('-g, --gateway <gateway>', 'Manually set gateway IP for the tunnel option')
    .option('-r, --refresh <refresh>', 'Refresh rate', /^\d+$/i)
    .option('-o, --protocol <protocol>', 'Protocol for tunneling', /^(upnp|natpnp)$/i, 'natpnp')
    .option('-u, --user <user>', 'Set Username')
    .option('-x, --password <password>', 'Set Password')
    .option('-e, --email <email>', 'Set User Email (optional)')
    .option('-G, --guest <guestname>', 'Set Guest Username')
    .option('-X, --guestpassword <guestpassword>', 'Set Guest Password')
    .option('-d, --database <path>', 'Specify Database Filepath', 'mstreamdb.lite')
    .option('-i, --userinterface <folder>', 'Specify folder name that will be served as the UI', 'public')
    .option('-s, --secret <secret>', 'Set the login secret key')
    .option('-D, --databaseplugin <databaseplugin>', '', /^(sqlite|beets)$/i, 'sqlite') // TODO: Add support for other DBs when ready
    .option('-c, --beetscommand <beetscommand>', 'Does not work right now')

    .parse(args);


  let program3 = {
    port:program.port,
    userinterface:program.userinterface,
  }

  if(program.secret){
    program3.secret = program.sectet;
  }
  if(program.salt){
    program3.salt = program.salt;
  }

  // User account
  if(program.user && program.password){
    program3.users = {};
    program3.users[program.user] = {
      password:program.password,
      musicDir:process.cwd()
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
    program3.musicDir = process.cwd();
  }

  // db plugins
  program3.database_plugin = {
    type:program.databaseplugin,
    dbPath:program.database
  };

  if(program.databaseplugin === 'beets' && program.beetscommand){
    program3.database_plugin.beetCommand = program.beetscommand;
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


  return program3;
}
