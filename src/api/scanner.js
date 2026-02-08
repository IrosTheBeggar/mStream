import * as db from '../db/manager.js';
import * as config from '../state/config.js';

export function setup(mstream) {
  mstream.all('/api/v1/scanner/{*path}', (req, res, next) => {
    if (req.scanApproved !== true) { return res.status(403).json({ error: 'Access Denied' }); }
    next();
  });

  mstream.post('/api/v1/scanner/get-file', (req, res) => {
    const dbFileInfo = db.findFileByPath(req.body.filepath, req.body.vpath);

    // return empty response if nothing was found
    if (!dbFileInfo) {
      return res.json({});
    }
    // if the file was edited, remove it from the DB
    else if (req.body.modTime !== dbFileInfo.modified) {
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json({});
    }
    // update the record with the new scan ID
    else {
      db.updateFileScanId(dbFileInfo, req.body.scanId);
    }

    res.json(dbFileInfo);
  });

  mstream.post('/api/v1/scanner/finish-scan', (req, res) => {
    db.removeStaleFiles(req.body.vpath, req.body.scanId);
    db.saveFilesDB();
    res.json({});
  });

  let saveCounter = 0;
  mstream.post('/api/v1/scanner/add-file', (req, res) => {
    db.insertFile(req.body);
    res.json({});

    saveCounter++;
    if(saveCounter > config.program.scanOptions.saveInterval) {
      saveCounter = 0;
      db.saveFilesDB();
    }
  });
}
