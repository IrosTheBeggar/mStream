// mStream discovery-export worker — child process forked by
// src/db/discovery-export.js (exportDiscoverySnapshot).
//
// Exists so the snapshot build's 100+ MB INSERT…SELECT of embedding blobs
// runs on THIS process's DatabaseSync connection instead of the server's —
// in the parent it was one synchronous statement that stalled the event
// loop for seconds (audit H3). All build logic stays in discovery-export.js
// (buildSnapshot); this file is only the process boundary.
//
// CLI input — single argv entry, JSON-encoded (built in discovery-export.js):
//   { dbPath, outDir }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'exportComplete', rowCount, sizeBytes }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 built (manifest.json in outDir is the result); 1 fatal.

import Joi from 'joi';
import winston from 'winston';
import { initDiscoveryDb, closeDiscoveryDb } from './discovery-db.js';
import { buildSnapshot } from './discovery-export.js';

// Same transport shape as the other forked workers: no configured
// transports in a child means a noisy winston meta-warning per call, so
// route warn+ to stderr (the parent forwards it) and drop info.
winston.configure({
  transports: [new winston.transports.Console({ level: 'warn', stderrLevels: ['error', 'warn'] })],
});

function emit(event) { console.log(JSON.stringify(event)); }

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  dbPath: Joi.string().required(),
  outDir: Joi.string().required(),
});

const { error: validationError, value: cfg } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

try {
  initDiscoveryDb(cfg.dbPath);
} catch (err) {
  emit({ event: 'error', message: `discovery DB open failed: ${err.message}` });
  process.exit(1);
}

buildSnapshot({ outDir: cfg.outDir })
  .then((manifest) => {
    emit({ event: 'exportComplete', rowCount: manifest.rowCount, sizeBytes: manifest.sizeBytes });
    closeDiscoveryDb();
    process.exit(0);
  })
  .catch((err) => {
    emit({ event: 'error', message: err?.message || String(err) });
    closeDiscoveryDb();
    process.exit(1);
  });
