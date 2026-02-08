import child from 'child_process';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

let runningTask;

export function run() {
  if (runningTask !== undefined) {
    return false;
  }

  const jsonLoad = {
    albumArtDirectory: config.program.storage.albumArtDirectory,
  };

  const forkedScan = child.fork(path.join(__dirname, './image-compress-script.js'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`Image Compress Script Started`);
  runningTask = forkedScan;

  forkedScan.stdout.on('data', (data) => {
    winston.info(`Image Compress Message: ${data}`);
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`Image Compress Error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`Image compress script completed with code ${code}`);
    runningTask = undefined;
  });

  return true;
}
