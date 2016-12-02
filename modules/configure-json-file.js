const fs = require('graceful-fs');  // File System


exports.setup = function(args){
  // Open File
  try{
    var loadJson = JSON.parse(fs.readFileSync(args[args.length-1], 'utf8'));
  }catch(err){
    console.log('Failed to parse JSON file');
    return false;
  }


  if(!loadJson.database_plugin){
    console.log('Please Configure DB');
    return false;
  }

  if(!loadJson.userinterface){
    loadJson.userinterface = "public";
  }

  // TODO; Preform a full range of checks

  // Export JSON
  return loadJson;
}
