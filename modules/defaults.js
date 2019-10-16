const fs = require('fs');
const path = require('path');
const Joi = require('@hapi/joi');

exports.setup = function (program) {
  program.filesDbName = 'files.loki-v1.db'
  const schema = Joi.object({
    port: Joi.number().default(3000),
    scanOptions: Joi.object({
      skipImg: Joi.boolean().default(false),
      scanInterval: Joi.number().default(24),
      saveInterval: Joi.number().default(250),
      pause: Joi.number().default(0),
      bootScanDelay: Joi.number().default(3)
    }).default({skipImg: false, scanInterval: 24, saveInterval: 250, pause: 0, bootScanDelay: 3}),
    noUpload: Joi.boolean().optional(),
    storage: Joi.object({
      albumArtDirectory: Joi.string().default(path.join(__dirname, '../image-cache')),
      dbDirectory: Joi.string().default(path.join(__dirname, '../save/db')),
      logsDirectory: Joi.string().default(path.join(__dirname, '../save/logs')),
      syncConfigDirectory:  Joi.string().default(path.join(__dirname, '../save/sync')),
    }).default({ albumArtDirectory: path.join(__dirname, '../image-cache'), dbDirectory: path.join(__dirname, '../save/db'), logsDirectory: path.join(__dirname, '../save/logs'), syncConfigDirectory: path.join(__dirname, '../save/sync'), }),
    webAppDirectory: Joi.string().default(path.join(__dirname, '../public')),
    ddns: Joi.object({
      iniFile: Joi.string().default(path.join(__dirname, `../frp/frps.ini`)),
      email: Joi.string().optional(),
      password: Joi.string().optional()
    }),
    secret: Joi.string().optional(),
    folders: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        root: Joi.string().required()
      })
    ).min(1),
    users: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        password: Joi.string(),
        salt: Joi.string().optional(),
        vpaths: Joi.array().items(Joi.string()),
        'lastfm-user': Joi.string().optional(),
        'lastfm-password': Joi.string().optional(),
      })
    ).optional(),
    ssl: Joi.object({
      key: Joi.string(),
      cert: Joi.string(),
    }).optional(),
    federation: Joi.object({
      folder: Joi.string()
    }).optional(),
    'lastfm-user': Joi.string().optional(),
    'lastfm-password': Joi.string().optional(),
    filesDbName: Joi.string(),
    configFile: Joi.string().optional()
  });

  const { error, value } = schema.validate(program);
  if (error) {
    throw new Error(error);
  }
  program = value;

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
  program.getVPathInfo = function (url) {
    // TODO: Verify user has access to this vpath

    // remove leading slashes
    if (url.charAt(0) === '/') {
      url = url.substr(1);
    }

    const fileArray = url.split('/');
    const vpath = fileArray.shift();

    // Make sure the path exists
    if (!program.folders[vpath]) {
      return false;
    }
    const baseDir = program.folders[vpath].root;
    let newPath = '';
    for (const dir of fileArray) {
      if (dir === '') {
        continue;
      }
      newPath += dir + '/';
    }

    // TODO: There's gotta be a better way to construct the relative path
    if (newPath.charAt(newPath.length - 1) === '/') {
      newPath = newPath.slice(0, - 1);
    }

    return {
      vpath: vpath,
      basePath: baseDir,
      relativePath: newPath,
      fullPath: path.join(baseDir, newPath)
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