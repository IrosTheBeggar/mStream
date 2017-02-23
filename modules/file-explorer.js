exports.setup = function(mstream, program){

  const fs = require('fs');  // File System
  const fe = require('path');
  const slash = require('slash');



  // parse directories
  mstream.post('/dirparser', function (req, res) {
    var directories = [];
    var filesArray = [];

    // TODO: Make sure path is a sub-path of the user's music dir
    var path = fe.join(req.user.musicDir, req.body.dir);
    // Make sure it's a directory
    if(!fs.statSync( path).isDirectory()){
      res.status(500).json({ error: 'Not a directory' });
      return;
    }

    // Will only show these files.  Prevents people from snooping around
    // TODO: Move to global variable
    const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
    var fileTypesArray;
    if(req.body.filetypes){
      fileTypesArray = JSON.parse(req.body.filetypes);
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
        // TODO: Log This
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
            type:extension, // TODO: Should this be changed
            name:files[i]
          });
        }
      }
    }

    var returnPath = slash( fe.relative(req.user.musicDir, path) );
    if(returnPath.slice(-1) !== '/'){
      returnPath += '/';
    }

    // Send back combined list of directories and mp3s
    res.send(
      JSON.stringify({ path:returnPath, contents:filesArray.concat(directories)})
    );
  });



  function getFileType(filename){
    return filename.split(".").pop();
  }

}
