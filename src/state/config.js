import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import winston from 'winston';
import { getDirname } from '../util/esm-helpers.js';
import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';

const __dirname = getDirname(import.meta.url);

const storageJoi = Joi.object({
  albumArtDirectory: Joi.string().default(path.join(__dirname, '../../image-cache')),
  dbDirectory: Joi.string().default(path.join(__dirname, '../../save/db')),
  logsDirectory: Joi.string().default(path.join(__dirname, '../../save/logs')),
  syncConfigDirectory:  Joi.string().default(path.join(__dirname, '../../save/sync')),
});

const scanOptions = Joi.object({
  skipImg: Joi.boolean().default(false),
  scanInterval: Joi.number().min(0).default(24),
  saveInterval: Joi.number().default(250),
  pause: Joi.number().min(0).default(0),
  bootScanDelay: Joi.number().default(3),
  maxConcurrentTasks: Joi.number().integer().min(1).default(1),
  compressImage: Joi.boolean().default(true)
});

const dbOptions = Joi.object({
  clearSharedInterval: Joi.number().integer().min(0).default(24)
});

const transcodeOptions = Joi.object({
  algorithm: Joi.string().valid(...getTransAlgos()).default('stream'),
  enabled: Joi.boolean().default(false),
  ffmpegDirectory: Joi.string().default(path.join(__dirname, '../../bin/ffmpeg')),
  defaultCodec: Joi.string().valid(...getTransCodecs()).default('opus'),
  defaultBitrate: Joi.string().valid(...getTransBitrates()).default('96k')
});

const rpnOptions = Joi.object({
  iniFile: Joi.string().default(path.join(__dirname, `../../bin/rpn/frps.ini`)),
  apiUrl: Joi.string().default('https://api.mstream.io'),
  email: Joi.string().allow('').optional(),
  password: Joi.string().allow('').optional(),
  token: Joi.string().optional(),
  url: Joi.string().optional()
});

const lastFMOptions = Joi.object({
  apiKey: Joi.string().default('25627de528b6603d6471cd331ac819e0'),
  apiSecret: Joi.string().default('a9df934fc504174d4cb68853d9feb143')
});

const federationOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  folder: Joi.string().optional(),
  federateUsersMode: Joi.boolean().default(false),
});

const schema = Joi.object({
  address: Joi.string().ip({ cidr: 'forbidden' }).default('::'),
  port: Joi.number().default(3000),
  supportedAudioFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).default({
    "mp3": true, "flac": true, "wav": true,
    "ogg": true, "aac": true, "m4a": true, "m4b": true,
    "opus": true, "m3u": false
  }),
  lastFM: lastFMOptions.default(lastFMOptions.validate({}).value),
  scanOptions: scanOptions.default(scanOptions.validate({}).value),
  noUpload: Joi.boolean().default(false),
  writeLogs: Joi.boolean().default(false),
  lockAdmin: Joi.boolean().default(false),
  storage: storageJoi.default(storageJoi.validate({}).value),
  webAppDirectory: Joi.string().default(path.join(__dirname, '../../webapp')),
  rpn: rpnOptions.default(rpnOptions.validate({}).value),
  transcode: transcodeOptions.default(transcodeOptions.validate({}).value),
  secret: Joi.string().optional(),
  maxRequestSize: Joi.string().pattern(/[0-9]+(KB|MB)/i).default('1MB'),
  db: dbOptions.default(dbOptions.validate({}).value),
  folders: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      root: Joi.string().required(),
      type: Joi.string().valid('music', 'audio-books').default('music'),
    })
  ).default({}),
  users: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      password: Joi.string().required(),
      admin: Joi.boolean().default(false),
      salt: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()),
      'lastfm-user': Joi.string().optional(),
      'lastfm-password': Joi.string().optional(),
    })
  ).default({}),
  ssl: Joi.object({
    key: Joi.string().allow('').optional(),
    cert: Joi.string().allow('').optional()
  }).optional(),
  federation: federationOptions.default(federationOptions.validate({}).value),
});

export let program;
export let configFile;

export function asyncRandom(numBytes) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(numBytes, (err, salt) => {
      if (err) { return reject('Failed to generate random bytes'); }
      resolve(salt.toString('base64'));
    });
  });
}

export async function setup(configFileArg) {
  // Create config if none exists
  try {
    await fs.access(configFileArg);
  } catch(err) {
    winston.info('Config File does not exist. Attempting to create file');
    await fs.writeFile(configFileArg, JSON.stringify({}), 'utf8');
  }

  const programData = JSON.parse(await fs.readFile(configFileArg, 'utf8'));
  configFile = configFileArg;

  // Verify paths are real
  for (let folder in programData.folders) {
    if (!(await fs.stat(programData.folders[folder].root)).isDirectory()) {
      throw new Error('Path does not exist: ' + programData.folders[folder].root);
    }
  }

  // Setup Secret for JWT
  if (!programData.secret) {
    winston.info('Config file does not have secret.  Generating a secret and saving');
    programData.secret = await asyncRandom(128);
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  program = await schema.validateAsync(programData, { allowUnknown: true });
}

export function getDefaults() {
  const { value, error } = schema.validate({});
  return value;
}

export async function testValidation(validateThis) {
  await schema.validateAsync(validateThis, { allowUnknown: true });
}

let isHttps = false;
export function getIsHttps() {
  return isHttps;
}

export function setIsHttps(isIt) {
  isHttps = isIt;
}
