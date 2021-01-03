const dbQueue = require('../db/task-queue');
const mstreamReadPublicDB = require('../../modules/db-read/database-public-loki');
const winston = require('winston');

exports.setup = (mstream) => {
  mstream.get('/api/v1/db/status', (req, res) => {
    try {
      res.json({
        totalFileCount: mstreamReadPublicDB.getNumberOfFiles(req.user.vpaths),
        locked: dbQueue.isScanning()
      });
    }catch(err) {
      res.status(500).json({});
    }
  });
}
