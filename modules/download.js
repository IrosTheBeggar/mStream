exports.setup = function(mstream, program){
  const archiver = require('archiver');  // Zip Compression
  const fe = require('path');


  // Download a zip file of music
  mstream.post('/download',  function (req, res){
    var archive = archiver('zip');

    archive.on('error', function(err) {
      console.log(err.message);
      res.status(500).json({error: err.message});
    });

    archive.on('end', function() {
      // TODO: add logging
    });

    //set the archive name
    // TODO: Rename this
    res.attachment('zipped-playlist.zip');

    //streaming magic
    archive.pipe(res);

    var fileArray;


    // Get the POSTed files
    if(req.allowedFiles){
      fileArray = allowedFiles;
    }else{
      fileArray = JSON.parse(req.body.fileArray);
    }

    for(var i in fileArray) {
      // TODO:  Confirm each item in posted data is a real file
      var fileString = fileArray[i];

      // TODO: Add file by ataching user's musicdir to the relative directory supplied
      archive.file(fe.join( req.user.musicDir, fileString), { name: fe.basename(fileString) });
    }

    archive.finalize();
  });
}
