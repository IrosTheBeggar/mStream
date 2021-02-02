const fs = require("fs").promises;
const path = require('path');
const Joi = require('joi');
const winston = require('winston');

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
  maxConcurrentTasks: Joi.number().integer().min(1).default(1)
});

const transcodeOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  ffmpegDirectory: Joi.string().default(path.join(__dirname, '../../bin/ffmpeg')),
  defaultCodec: Joi.string().valid('mp3', 'opus', 'aac').default('opus'),
  defaultBitrate: Joi.string().valid('64k', '128k', '192k', '96k').default('96k')
});

const schema = Joi.object({
  address: Joi.string().ip({ cidr: 'forbidden' }).default('0.0.0.0'),
  port: Joi.number().default(3000),
  supportedAudioFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).default({
    "mp3": true, "flac": true, "wav": true,
    "ogg": true, "aac": true, "m4a": true,
    "opus": true, "m3u": false
  }),
  scanOptions: scanOptions.default(scanOptions.validate({}).value),
  noUpload: Joi.boolean().default(false),
  writeLogs: Joi.boolean().default(false),
  storage: storageJoi.default(storageJoi.validate({}).value),
  webAppDirectory: Joi.string().default(path.join(__dirname, '../../webapp')),
  ddns: Joi.object({
    iniFile: Joi.string().default(path.join(__dirname, `../../bin/rpn/frps.ini`)),
    email: Joi.string().allow('').optional(),
    password: Joi.string().allow('').optional(),
    tested: Joi.boolean().optional(),
    token: Joi.string().optional(),
    url: Joi.string().optional(),
  }),
  transcode: transcodeOptions.default(transcodeOptions.validate({}).value),
  secret: Joi.string().optional(),
  folders: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      root: Joi.string().required()
    })
  ).default({}),
  users: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      password: Joi.string().required(),
      guest: Joi.boolean().default(false),
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
  federation: Joi.object({
    folder: Joi.string().allow('').optional()
  }).optional()
});

exports.asyncRandom = (numBytes) => {
  return new Promise((resolve, reject) => {
    require('crypto').randomBytes(numBytes, (err, salt) => {
      if (err) { return reject('Failed to generate random bytes'); }
      resolve(salt.toString('base64'));
    });
  });
}

exports.setup = async configFile => {
  // Create config if none exists
  try {
    await fs.access(configFile);
  } catch(err) {
    winston.info('Config File does not exist. Attempting to create file');
    await fs.writeFile(configFile, JSON.stringify({}), 'utf8');
  }

  const program = JSON.parse(await fs.readFile(configFile, 'utf8'));
  exports.configFile = configFile;

  // Verify paths are real
  for (let folder in program.folders) {
    if (!(await fs.stat(program.folders[folder].root)).isDirectory()) {
      throw new Error('Path does not exist: ' + program.folders[folder].root);
    }
  }

  // Setup Secret for JWT
  if (!program.secret) {
    winston.info('Config file does not have secret.  Generating a secret and saving');
    program.secret = await this.asyncRandom(128);
    await fs.writeFile(configFile, JSON.stringify(program, null, 2), 'utf8');
  }

  exports.program = await schema.validateAsync(program, { allowUnknown: true });
}

exports.getDefaults = () => {
  const { value, error } = schema.validate({});
  return value;
}

exports.testValidation = async (validateThis) => {
  await schema.validateAsync(validateThis, { allowUnknown: true });
}