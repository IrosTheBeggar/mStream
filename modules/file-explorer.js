exports.setup = function(mstream, program){
  const fs = require('fs');  // File System
  const fe = require('path');
  const slash = require('slash');
  const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];


  // parse directories
  mstream.post('/dirparser', function (req, res) {
    var directories = [];
    var filesArray = [];

    var directory = '';
    if(req.body.dir){
      directory = req.body.dir;
    }

    // TODO: Make sure path is a sub-path of the user's music dir
    var path = fe.join(req.user.musicDir, directory);
    // Make sure it's a directory
    if(!fs.statSync( path).isDirectory()){
      res.status(500).json({ error: 'Not a directory' });
      return;
    }

    // Will only show these files.  Prevents people from snooping around
    var fileTypesArray;
    if(req.body.filetypes){
      fileTypesArray = req.body.filetypes;
    }else{
      fileTypesArray = masterFileTypesArray;
    }


    // get directory contents
    var files = fs.readdirSync( path);

    // loop through files
    for (let i=0; i < files.length; i++) {

      try{
        var stat = fs.statSync(fe.join(path, files[i]));
      }catch(error){
        // Bad file, ignore and continue
        continue;
      }

      // Handle Directories
    	if(stat.isDirectory()){
    		directories.push({
          type:"directory",
          name:files[i]
        });
    	}else{ // Handle Files
        var extension = getFileType(files[i]);
        if (fileTypesArray.indexOf(extension) > -1 && masterFileTypesArray.indexOf(extension) > -1) {
          filesArray.push({
            type:extension,
            name:files[i]
          });
        }
      }
    }

    var returnPath = fe.relative(req.user.musicDir, path) ;
    returnPath = returnPath.replace(/\\/g, '/');
    if(returnPath.slice(-1) !== '/'){
      returnPath += '/';
    }

    // Sort it becasue we can't rely on the OS returning it pre-sorted
    directories.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    filesArray.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    // Send back combined list of directories and mp3s
    res.json(
      { path:returnPath, contents:filesArray.concat(directories)}
    );
  });


  function getFileType(filename){
    return filename.split(".").pop();
  }

}
