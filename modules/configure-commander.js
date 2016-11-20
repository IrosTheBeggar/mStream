exports.setup = function(args){

  // Setup Command Line Interface
  var program = require('commander');
  program
    .version('1.21.0')
    .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
    .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
    .option('-g, --gateip <gateip>', 'Manually set gateway IP for the tunnel option')
    .option('-u, --user <user>', 'Set Username')
    .option('-x, --password <password>', 'Set Password')
    .option('-e, --email <email>', 'Set User Email (optional)')
    .option('-G, --guest <guestname>', 'Set Guest Username')
    .option('-X, --guestpassword <guestpassword>', 'Set Guest Password')
    // .option('-k, --key <key>', 'Add SSL Key')
    // .option('-c, --cert <cert>', 'Add SSL Certificate')
    .option('-d, --database <path>', 'Specify Database Filepath', 'mstreamdb.lite')
    .option('-b, --beetspath <folder>', 'Specify Folder where Beets DB should import music from.  This also overides the normal DB functions with functions that integrate with beets DB')
    .option('-b, --databaseplugin <folder>', '', /^(default|beets)$/i, 'default')
    .option('-i, --userinterface <folder>', 'Specify folder name that will be served as the UI', 'public')
    .option('-f, --filepath <folder>', 'Set the path of your music directory', process.cwd())
    .option('-s, --secret <secret>', 'Set the login secret key')
    .parse(args);

    return program;
}
