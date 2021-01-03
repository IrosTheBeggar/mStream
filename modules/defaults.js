const fs = require('fs');
const path = require('path');
const Joi = require('joi');

exports.setup = function (config) {
  config.filesDbName = 'files.loki-v2.db';

  const storageJoi = Joi.object({
    albumArtDirectory: Joi.string().default(path.join(__dirname, '../image-cache')),
    dbDirectory: Joi.string().default(path.join(__dirname, '../save/db')),
    logsDirectory: Joi.string().default(path.join(__dirname, '../save/logs')),
    syncConfigDirectory:  Joi.string().default(path.join(__dirname, '../save/sync')),
  });

  const scanOptions = Joi.object({
    skipImg: Joi.boolean().default(false),
    scanInterval: Joi.number().default(24),
    saveInterval: Joi.number().default(250),
    pause: Joi.number().default(0),
    bootScanDelay: Joi.number().default(3),
    maxConcurrentTasks: Joi.number().integer().min(1).default(1)
  });

  const schema = Joi.object({
    autoboot: Joi.boolean().optional(),
    address: Joi.string().ip({ cidr: 'forbidden' }).default('0.0.0.0'),
    port: Joi.number().default(3000),
    newWebApp: Joi.boolean().default(false),
    supportedAudioFiles: Joi.object().pattern(
      Joi.string(), Joi.boolean()
    ).default({
      "mp3": true, "flac": true, "wav": true,
      "ogg": true, "aac": true, "m4a": true,
      "opus": true, "m3u": false
    }),
    scanOptions: scanOptions.default(scanOptions.validate({}).value),
    noUpload: Joi.boolean().optional(),
    adminPanel: Joi.boolean().default(true),
    writeLogs: Joi.boolean().default(false),
    storage: storageJoi.default(storageJoi.validate({}).value),
    webAppDirectory: Joi.string().default(path.join(__dirname, '../public')),
    ddns: Joi.object({
      iniFile: Joi.string().default(path.join(__dirname, `../frp/frps.ini`)),
      email: Joi.string().allow('').optional(),
      password: Joi.string().allow('').optional(),
      tested: Joi.boolean().optional(),
      token: Joi.string().optional(),
      url: Joi.string().optional(),
    }),
    transcode: Joi.object({
      enabled: Joi.boolean().default(false),
      ffmpegDirectory: Joi.string().default(path.join(__dirname, '../bin/ffmpeg')),
      defaultCodec: Joi.string().valid('mp3', 'opus', 'aac').default('opus'),
      defaultBitrate: Joi.string().valid('64k', '128k', '192k', '96k').default('96k')
    }).optional(),
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
    }).optional(),
    filesDbName: Joi.string(),
    configFile: Joi.string().optional()
  });

  const { error, value } = schema.validate(config, { allowUnknown: true });
  if (error) { throw new Error(error); }

  const program = value;
  // Verify paths are real
  for (let folder in program.folders) {
    if (!fs.statSync(program.folders[folder].root).isDirectory()) {
      throw new Error('Path does not exist: ' + program.folders[folder].root);
    }
  }

  // Setup Secret for JWT
  try {
    // If user entered a filepath
    if (fs.statSync(program.secret).isFile()) {
      program.secret = fs.readFileSync(program.secret, 'utf8');
    }
  } catch (error) {
    // If no secret was given, generate one
    if (!program.secret) {
      require('crypto').randomBytes(48, (err, buffer) => {
        program.secret = buffer.toString('base64');
      });
    }
  }

  return program;
}
