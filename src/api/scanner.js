const winston = require('winston');
const db = require('../db/manager');
const config = require('../state/config');

exports.setup = (mstream) => {
  mstream.post('/api/v1/scanner/get-file', async (req, res) => {
    try {
      const lol = { '$and': [
        { 'filepath': { '$eq': req.body.filepath } },
        { 'vpath': { '$eq': req.body.vpath } }
      ]};
      const dbFileInfo = db.getFileCollection().findOne(lol);

      if (!dbFileInfo) {
        return res.json({});
      } else if (req.body.modTime !== dbFileInfo.modified) {
        fileCollection.findAndRemove({ '$and': [
          { 'filepath': { '$eq': req.body.filepath } },
          { 'vpath': { '$eq': loadJson.vpath } }
        ]});
      } else {
        dbFileInfo.sID = req.body.scanId;
        db.getFileCollection().update(dbFileInfo);
      }

      res.json(dbFileInfo);
    } catch (err) {
      winston.error('Scanner API Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/scanner/finish-scan', async (req, res) => {
    try {
      db.getFileCollection().findAndRemove({ '$and': [
        { 'vpath': { '$eq': req.body.vpath } },
        { 'sID': { '$ne': req.body.scanId } }
      ]});

      db.saveFilesDB();

      res.json({});

    }catch (err) {
      winston.error('Scanner API Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  let saveCounter = 0;
  mstream.post('/api/v1/scanner/add-file', async (req, res) => {
    try {
      db.getFileCollection().insert(req.body);
      res.json({});

      saveCounter++;
      if(saveCounter > config.program.scanOptions.saveInterval) {
        saveCounter = 0;
        db.saveFilesDB();
      }
    }catch (err) {
      winston.error('Scanner API Error', { stack: err });
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });
}