const fs = require('fs');  // File System
const fe = require('path');


exports.setup = function(args, rootDir){
  let loadJson;
  try{
    if(fe.extname(args[args.length-1]) === '.json'  &&  fs.statSync(args[args.length-1]).isFile()){
      loadJson = JSON.parse(fs.readFileSync(args[args.length-1], 'utf8'));
    }else{
      return require('./configure-commander.js').setup(args);
    }
  }catch(error){
    console.log(error);
    return {error:"Failed to parse JSON file"};
  }



  if(!loadJson.port){
    loadJson.port = 5050;
  }
  if(!isInt(loadJson.port) || loadJson.port < 0 || loadJson.port > 65535){
    return {error:"BAD PORT, WILL ABORT"};
  }

  // TODO: Add comprehensive DB checks
  if(!loadJson.database_plugin){
    return {error:"Please Configure DB"};
  }


  if(loadJson.userinterface){
    if(!fs.statSync( fe.join(rootDir, loadJson.userinterface) ).isDirectory()){
      return {error:"Could not find userinterface"};
    }
  }


  // Normalize for all OS
  // Make sure it's a directory
  // Loop through and makeure all user Dirs are real
  if(loadJson.users){
    for (let username in loadJson.users) {
      // TODO: Check usernames for forbidden chars

      // TODO: Make sure all music directories are unique
      // TODO: No subsets/super-sets/duplicates
      if(!loadJson.users[username].guestTo && !fs.statSync( loadJson.users[username].musicDir ).isDirectory()){
        return {error:loadJson.users[username].username +  " music directory could not be found"};
      }
    }
  }

  // TODO: Preform a full range of checks
  if(loadJson.tunnel){
    if(loadJson.tunnel.refreshInterval && !isInt(loadJson.tunnel.refreshInterval)){
      return {error:"Refresh interval must be an integer"};
    }
  }

  // Export JSON
  return loadJson;
}


function isInt(value) {
  if (isNaN(value)) {
    return false;
  }
  var x = parseFloat(value);
  return (x | 0) === x;
}

// TODO: This should sum up all errors before returing to user
