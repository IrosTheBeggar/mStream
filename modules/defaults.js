const fs = require('fs');
const path = require('path');
const Joi = require('@hapi/joi');

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
    bootScanDelay: Joi.number().default(3)
  });

  const schema = Joi.object({
    autoboot: Joi.boolean().optional(),
    port: Joi.number().default(3000),
    scanOptions: scanOptions.default(scanOptions.validate({}).value),
    noUpload: Joi.boolean().optional(),
    writeLogs: Joi.boolean().optional(),
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
      ffmpegDirectory: Joi.string().default(path.join(__dirname, '../ffmpeg')),
      defaultCodec: Joi.string().valid('mp3', 'opus', 'aac').default('opus'),
      defaultBitrate: Joi.string().valid('64k', '128k', '192k', '96k').default('96k')
    }).optional(),
    secret: Joi.string().allow('').optional(),
    folders: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        root: Joi.string().required()
      })
    ).min(0),
    users: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        password: Joi.string(),
        guest: Joi.boolean().optional(),
        salt: Joi.any(),
        vpaths: Joi.array().items(Joi.string()),
        'lastfm-user': Joi.string().allow('').optional(),
        'lastfm-password': Joi.string().allow('').optional(),
      })
    ).optional(),
    ssl: Joi.object({
      key: Joi.string().allow('').optional(),
      cert: Joi.string().allow('').optional()
    }).optional(),
    federation: Joi.object({
      folder: Joi.string().allow('').optional()
    }).optional(),
    'lastfm-user': Joi.string().allow('').optional(),
    'lastfm-password': Joi.string().allow('').optional(),
    filesDbName: Joi.string(),
    configFile: Joi.string().optional()
  });

  const { error, value } = schema.validate(config, { allowUnknown: true });
  if (error) {
    throw new Error(error);
  }

  const program = value;
  // Verify paths are real
  for (let folder in program.folders) {
    try {
      if (!fs.statSync(program.folders[folder].root).isDirectory()) {
        throw new Error('Path does not exist: ' + program.folders[folder].root);
      }
    } catch(err) {
      throw new Error(err);
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
        program.secret = buffer.toString('hex');
      });
    }
  }

  // This is a convenience function. It gets the vPath from any url string
  program.getVPathInfo = function (url, user) {
    // remove leading slashes
    if (url.charAt(0) === '/') {
      url = url.substr(1);
    }

    // Get vpath from url
    const vpath = url.split('/').shift();
    // Verify user has access to this vpath
    if (user && !user.vpaths.includes(vpath)) {
      return false;
    }

    // Make sure the path exists
    if (!program.folders[vpath]) {
      return false;
    }

    const baseDir = program.folders[vpath].root;
    return {
      vpath: vpath,
      basePath: baseDir,
      relativePath: path.relative(vpath, url),
      fullPath: path.join(baseDir, path.relative(vpath, url))
    };
  }

  // Handle Exit Process
  program.killThese = [];
  process.on('exit', (code) => {
    // Kill them all
    program.killThese.forEach(func => {
      if (typeof func === 'function') {
        try {
          func();
        }catch (err) {
          console.log('Error: Failed to run kill function');
        }
      }
    });
  });

  return program;
}