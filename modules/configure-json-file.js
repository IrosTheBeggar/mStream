const fs = require('graceful-fs');  // File System


exports.setup = function(args){
  // Open File
  try{
    var loadJson = JSON.parse(fs.readFileSync(args[args.length-1], 'utf8'));
  }catch(err){
    console.log('Failed to parse JSON file');
    return false;
  }

  // Check for validity
  if(!loadJson.filepath){
    loadJson.filepath = process.cwd();
  }

  if(!loadJson.databaseplugin){
    loadJson.databaseplugin = 'default';
  }else{
    var re = new RegExp("^(default|beets)$");
    if(!re.test(loadJson.databaseplugin)){
      console.log('Incorrect database plugin.  Please update and try again');
      return false;
    }
  }

  // Export JSON
  return loadJson;
}
