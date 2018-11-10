const inquirer = require('inquirer');
inquirer.registerPrompt('directory', require('inquirer-select-directory'));
const colors = require('colors');
const fs = require('fs');
const path = require('path');
const Login = require('../login');

function initFile(filepath) {
  if (!filepath) {
    console.log(colors.yellow('No filepath given'));
    return;
  }

  // Check that path exists
  if (fs.existsSync(filepath)) {
    return inquirer
    .prompt([{
      message: "This file already exists. Do you want to overwrite it with an empty config?",
      type: "confirm",
      name: "confirm",
      default: false
    }])
    .then(answers => {
      if(answers.confirm === true) {
        fs.writeFileSync( filepath, JSON.stringify({}), 'utf8');
        return true;
      }
      return false;
    });
  }else {
    fs.writeFileSync( filepath, JSON.stringify({}), 'utf8');
    return Promise.resolve(true);
  }
}

exports.init = function(filepath) {
  return initFile(filepath);
}

exports.makeSecret = function(current, callback) {
  if (current.secret) {
    ask1();
  } else{
    ask2();
  }

  function ask1() {
    inquirer
    .prompt([{
      message: "You already have a secret. Would you like to make a new one?  All login sessions will no longer be valid",
      type: "confirm",
      name: "confirm"
    }])
    .then(answers => {
      if(answers.confirm === true) {
        ask2();  
      }
    });
  }

  function ask2() {
    inquirer
    .prompt([{
      message: "Would you like to auto-generate a secret",
      type: "confirm",
      name: "confirm"
    }])
    .then(answers => {
      if(answers.confirm === true) {
        require('crypto').randomBytes(48, function (err, buffer) {
          current.secret = buffer.toString('hex');
          callback(current);
        });
      } else {
        ask3();
      }
    });
  }


  function ask3() {
    inquirer
    .prompt([{
      message: "Enter your secret",
      type: "input",
      name: "secret",
      validate: answer => {
        if (answer.length < 1) {
          return 'You need to enter a secret';
        }
        return true;
      }
    }])
    .then(answers => {
      current.secret = answers.secret;
      callback(current);
    });
  }
}

exports.addKey = function(current, filepath, callback) {
  if (!filepath) {
    console.log(colors.yellow('No filepath given'));
    return;
  }

  // Turn relative paths into absolute paths
  if (!path.isAbsolute(filepath)){
    filepath = path.join(process.cwd(), filepath);
  }

  // Check that path exists
  if (!fs.existsSync(filepath)) {
    console.log(colors.yellow('Filepath does not exist!'));
    return;
  }

  if (!fs.statSync(filepath).isFile()) {
    console.log(colors.yellow('Supplied key is not a file'));
    return;
  }

  if (!current.ssl) {
    current.ssl = {};
  }

  current.ssl.key = filepath;
  callback(current);
}

exports.addCert = function(current, filepath, callback) {
  if (!filepath) {
    console.log(colors.yellow('No filepath given'));
    return;
  }

  // Turn relative paths into absolute paths
  if (!path.isAbsolute(filepath)){
    filepath = path.join(process.cwd(), filepath);
  }

  // Check that path exists
  if (!fs.existsSync(filepath)) {
    console.log(colors.yellow('Filepath does not exist!'));
    return;
  }

  if (!fs.statSync(filepath).isFile()) {
    console.log(colors.yellow('Supplied key is not a file'));
    return;
  }

  if (!current.ssl) {
    current.ssl = {};
  }

  current.ssl.cert = filepath;
  callback(current);
}

function editPort(port = 3000) {
  return inquirer
    .prompt([{
      message: "Port Number (1 - 65535):",
      type: "input",
      name: "port",
      default: port,
      validate: answer => {
        if (!Number.isInteger(Number(answer)) || Number(answer) < 1 || Number(answer) > 65535) {
          return 'Port must be a an integer between 1 and 65535!';
        }
        return true;
      }
    }])
    .then(answers => {
      return Number(answers.port);
    });
}

exports.editPort = function() {
  return editPort();
}

function deleteOneUser(current) {
  if (!current.users || (Object.keys(current.users).length === 0 && current.users.constructor === Object)) {
    throw new Error('No users found');
  }

  var users = [];
  Object.keys(current.users).forEach(key => {
    users.push({ name: key });
  });

  return inquirer
    .prompt([{
      message: "Choose Users To Be Deleted",
      type: "checkbox",
      name: "users",
      choices: users
    }])
    .then(answers => {
      if(!answers || !answers.users || answers.users.length < 1) {
        return;
      }

      answers.users.forEach(key => {
        delete current.users[key];
      });

      return;
    });
}

exports.deleteUser = function(current, callback) {
  if(!current.users || Object.keys(current.users).length === 0){
    console.log(colors.yellow('No users found'));
    return;
  }

  var users = [];
  Object.keys(current.users).forEach(key => {
    users.push({ name: key });
  });

  inquirer
    .prompt([{
      message: "Choose Users To Be Deleted",
      type: "checkbox",
      name: "users",
      choices: users
    }])
    .then(answers => {
      if(!answers || !answers.users || answers.users.length < 1) {
        return;
      }

      answers.users.forEach(key => {
        delete current.users[key];
      });

      callback(current);
    });
}

function editFolder(current) {
  if(!current.folders || Object.keys(current.folders).length === 0){
    throw new Error('No Folders');
  }

  var folders = [{ name: 'Go Back' , value: 'finished' }];
  Object.keys(current.folders).forEach(key => {
    var folder = current.folders[key];
    if (typeof folder === 'object') {
      folder = folder.root;
    }
    folders.push({ name: `${key}: ${folder}` , value: key })
  });

  // Display folder directories in checkbox panel
  return inquirer
    .prompt([{
      message: "Choose Folder to Edit",
      type: "list",
      name: "folders",
      choices: folders
    }])
    .then(answers => {
      console.log(answers)
    });
}

function deleteFolder(current) {
  if(!current.folders || Object.keys(current.folders).length === 0){
    throw new Error('No Folders');
  }

  var folders = [];
  Object.keys(current.folders).forEach(key => {
    var folder = current.folders[key];
    if (typeof folder === 'object') {
      folder = folder.root;
    }
    folders.push({name: `${key}: ${folder}`});
  });

  // Display folder directories in checkbox panel
  return inquirer
    .prompt([{
      message: "Choose Folders To Be Deleted",
      type: "checkbox",
      name: "folders",
      choices: folders
    }])
    .then(answers => {
      if(!answers || !answers.folders || answers.folders.length < 1) {
        console.log('No Folders Deleted');
        return;
      }

      var nameArray = [];
      answers.folders.forEach(key => {
        var name = key.split(':');
        delete current.folders[name[0]];
        nameArray.push(name[0]);
      });

      if(current.users) {
        Object.keys(current.users).forEach(user => {
          current.users[user].vpaths = current.users[user].vpaths.filter(e => {
            return !nameArray.includes(e);
          });
        });
      }
    });
}

exports.deleteFolder = function(current, callback) {
  if(!current.folders || Object.keys(current.folders).length === 0){
    console.log(colors.yellow('No folders found'));
    return;
  }

  var folders = [];
  Object.keys(current.folders).forEach(key => {
    var folder = current.folders[key];
    if (typeof folder === 'object') {
      folder = folder.root;
    }
    folders.push({name: `${key}: ${folder}`});
  });

  // Display folder directories in checkbox panel
  inquirer
    .prompt([{
      message: "Choose Folders To Be Deleted",
      type: "checkbox",
      name: "folders",
      choices: folders
    }])
    .then(answers => {
      if(!answers || !answers.folders || answers.folders.length < 1) {
        console.log('No Folders Deleted');
        return;
      }

      var nameArray = [];
      answers.folders.forEach(key => {
        var name = key.split(':');
        delete current.folders[name[0]];
        nameArray.push(name[0]);
      });

      Object.keys(current.users).forEach(user => {
        current.users[user].vpaths = current.users[user].vpaths.filter(e => {
          return !nameArray.includes(e);
        });
      });
      
      // Remove folders from users
      callback(current);
    });
}

function addOneUser(current) {
  if (!current.folders || (Object.keys(current.folders).length === 0 && current.folders.constructor === Object)) {
    throw new Error('You need to add folders before adding a a user');
  }

  var paths = [];
  Object.keys(current.folders).forEach(key => {
    paths.push({ name: key });
  });

  if (paths.length === 1) {
    paths[0].checked = true;
  }

  var answers;
  return inquirer
    .prompt([{
      message: "Username:",
      type: "input",
      name: "username",
      validate: answer => {
        if (answer.length < 1) {
          return 'You need a username';
        }
        // Check that username doesn't already exist
        if (current.users && current.users[answer]) {
          return 'Username already exists';
        }
        return true;
      }
    },
    {
      message: "Password:",
      type: "password",
      name: "password",
      validate: answer => {
        if (answer.length < 1) {
          return 'You need a password';
        }
        return true;
      }
    },
    {
      type: 'checkbox',
      message: 'Select directories user has access to:',
      name: 'vpaths',
      choices: paths,
      validate: answer => {
        if (answer.length < 1) {
          return 'You must choose at least one folder.';
        }

        return true;
      }
    },
    {
      message: 'Add a LastFM account?',
      type: "confirm",
      name: "confirm",
      default: false,
      validate: answer => {
        if(answer.confirm === true) {
          return true;
        }
        return false;
      },
    }])
    .then(ans => {
      answers = ans;
      if(!answers.confirm) {
        return hashPassword(answers.password);
      } else {
        return inquirer.prompt([{
          message: 'LastFM Username',
          type: "input",
          name: "lastfmUser",
          validate: answer => {
            if (answer.length < 1) {
              return 'You need a username';
            }
            return true;
          }
        },
        {
          message: "LastFM Password:",
          type: "password",
          name: "lastfmPass",
          validate: answer => {
            if (answer.length < 1) {
              return 'You need a password';
            }
            return true;
          }
        }])
        .then(a2 => {
          answers.lastfmUser = a2.lastfmUser;
          answers.lastfmPass = a2.lastfmPass;
          return hashPassword(answers.password);
        });
      }
    })
    .then((hashObj) => {
      if(!current.users){
        current.users = {};
      }
      current.users[answers.username] = {
        vpaths: answers.vpaths,
        password: hashObj.hashPassword,
        salt: hashObj.salt
      };

      if (answers.lastfmUser && answers.lastfmUser) {
        current.users[answers.username]['lastfm-user'] = answers.lastfmUser;
        current.users[answers.username]['lastfm-password'] = answers.lastfmPass;
      }
    });
}

function hashPassword(password) {
  return  new Promise((resolve, reject) => {
    Login.hashPassword(password, (salt, hashedPassword, err) => {
      if (err) {
        // return callback(false, err);
        return reject('Failed to hash password');
      }
      resolve({salt, hashPassword: Buffer.from(hashedPassword).toString('hex')});
    });
  });
}

exports.addUser = function(current, callback) {
  if(!current.folders || Object.keys(current.folders).length === 0){
    console.log(colors.yellow('You need to add a folder before you can add a user'));
    console.log(`Use the ${colors.blue('--addpath')} command to add a folder`);
    return;
  }

  var paths = [];
  Object.keys(current.folders).forEach(key => {
    paths.push({ name: key });
  });

  if (paths.length === 1) {
    paths[0].checked = true;
  }

  inquirer
    .prompt([{
      message: "Username:",
      type: "input",
      name: "username",
      validate: answer => {
        if (answer.length < 1) {
          return 'You need a username';
        }
        // Check that username doesn't already exist
        if (current.users && current.users[answer]) {
          return 'Username already exists';
        }
        return true;
      }
    },
    {
      message: "Password:",
      type: "password",
      name: "password",
      validate: answer => {
        if (answer.length < 1) {
          return 'You need a password';
        }
        return true;
      }
    },
    {
      type: 'checkbox',
      message: 'Select directories user has access to:',
      name: 'vpaths',
      choices: paths,
      validate: answer => {
        if (answer.length < 1) {
          return 'You must choose at least one topping.';
        }

        return true;
      }
    }])
    .then(answers => {
      if(!current.users){
        current.users = {};
      }

      Login.hashPassword(answers.password, (salt, hashedPassword, err) => {
        if (err) {
          return callback(false, err);
        }
        current.users[answers.username] = {
          vpaths: answers.vpaths,
          password: Buffer.from(hashedPassword).toString('hex'),
          salt: salt
        };

        callback(current);
      });
    });
}

function namePathAlias(current) {
    return inquirer
    .prompt([{
      message: "Path Alias (no spaces or special characters):",
      type: "input",
      name: "name",
      validate: answer => {
        if (answer.length < 1) {
          return 'Cannot be empty';
        }
        // Verify inputs
        if (!/^([a-z0-9]{1,})$/.test(answer)) {
          return 'Name cannot have spaces or special characters';
        }

        // Check that name doesn't already exist
        var keyExists = false;
        if (current.folders) {
          Object.keys(current.folders).forEach(key => {
            if (key === answer){
              keyExists = true;
            }
          });
        }
        if (keyExists === true) {
          return 'This name already exists';
        }
        return true;
      }
    }])
    .then(answers => {
      return answers.name;
    });
}

exports.addPath = function(current, filepath, callback) {
  if(!filepath){
    console.log(colors.yellow('No path given'));
    console.log(`Please add the path after the  ${colors.blue('--addpath')} command`);
    return;
  }

  // Turn relative paths into absolute paths
  if (!path.isAbsolute(filepath)){
    filepath = path.join(process.cwd(), filepath);
  }

  // Check that path exists
  if (!fs.existsSync(filepath)) {
    console.log(colors.yellow('Path does not exist!'));
    return;
  }

  if (!fs.statSync(filepath).isDirectory()) {
    console.log(colors.yellow('Path is not a directory'));
    return;
  }

  // Check if the path has already been added
  var exists = false;
  if (current.folders) {
    Object.keys(current.folders).forEach(key => {
      if (typeof current.folders[key] === 'string' && current.folders[key] === filepath){
        exists = key;
      }
  
      if (typeof current.folders[key] === 'object' && current.folders[key].root && current.folders[key].root === filepath) {
        exists = key;
      }  
    });
  }

  if (exists) {
    console.log(colors.yellow(`Path has already been added to config under name ${exists}`));
    console.log('Duplicate paths are technically allowed, but they use up extra system resources while not adding any functionality.');
    console.log('If you REALLY want to do this, you can add it to your JSON file by hand');
    return;
  }

  // Ask user for path name
  inquirer
    .prompt([{
      message: "Path Alias (no spaces or special characters):",
      type: "input",
      name: "name",
      validate: answer => {
        if (answer.length < 1) {
          return 'Cannot be empty';
        }
        // Verify inputs
        if (!/^([a-z0-9]{1,})$/.test(answer)) {
          return 'Name cannot have spaces or special characters';
        }

        // Check that name doesn't already exist
        var keyExists = false;
        if (current.folders) {
          Object.keys(current.folders).forEach(key => {
            if (key === answer){
              keyExists = true;
            }
          });
        }
        if (keyExists === true) {
          return 'This name already exists';
        }
        return true;
      }
    }])
    .then(answers => {
      if (!current.folders) {
        current.folders = {};
      }

      current.folders[answers.name] = { root: filepath }
      callback(current);
    });
}

exports.wizard = function(filepath) {
  doTheThing(filepath);
}

function confirmThis(confirmText, defaults = false) {
  return inquirer
    .prompt([{
      message: confirmText,
      type: "confirm",
      name: "confirm",
      default: defaults
    }])
    .then(answers => {
      if(answers.confirm === true) {
        return true;
      }
      return false;
    });
}

function addNewFolder() {
  return inquirer.prompt([{
    type: 'directory',
    name: 'from',
    message: 'Choose your music directory:',
    basePath: require('os').homedir()
  }]).then((answers) => {
    return answers.from;
  });
}

async function doTheThing(filepath) {
  // Use the default file if none is provided
  if (typeof filepath !== 'string') {
    filepath = path.join(__dirname, '../../save/default.json');
  }
  filepath = path.resolve(filepath);

  // Create file if it does not exist
  if (!fs.existsSync(filepath)) {
    try {
      fs.writeFileSync( filepath, JSON.stringify({},  null, 2), 'utf8');
    } catch (err) {
      console.log(colors.red('Failed to create a new file!'));
      console.log(colors.yellow('Check that you have the correct permissions'));
      console.log('Exiting Setup Wizard....');
      process.exit(1);
    }
  }

  // Load the file
  var loadJson;
  try {
    loadJson = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!loadJson.scanOptions) {
      loadJson.scanOptions = {};
    }
  } catch (error) {
    console.log();
    console.log("ERROR: Failed to parse JSON file");
    console.log();
    console.log('Exiting Setup Wizard...');
    console.log();
    process.exit(1);
  }
  
  await mainLoop(loadJson);
}

async function doTheThing2(filepath) {
  if (typeof filepath !== 'string') {
    filepath = path.join(__dirname, '../../save/default.json');
  }
  filepath = path.resolve(filepath);

  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.blue.yellow('You can run this wizard at any time to edit your config file'));
  console.log();
  console.log('You can read more on mStream configuration here:');
  console.log(colors.grey.bold.underline('https://irosthebeggar.github.io/mStream/docs/json_config.html'));
  console.log();
  console.log(`${colors.bold('Config File:')} ${colors.green(filepath)}`);

  if (!fs.existsSync(filepath)) {
    const didWrite = await confirmThis('Create this file to continue?', true);
    if (!didWrite) {
      console.clear();
      console.log();
      console.log('Exiting Setup Wizard...');
      console.log();
      process.exit();
    }
  }

  try {
    await initFile(filepath);
  } catch (err) {
    console.log();
    console.log(colors.red('Failed to save file'));
    console.log(colors.yellow('Check that you have write access to this directory'));
    console.log();
    process.exit(0);
  }

  try {
    var loadJson = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (error) {
    console.log();
    console.log("ERROR: Failed to parse JSON file");
    console.log();
    console.log('Exiting Setup Wizard...');
    console.log();
    process.exit();
  }

  // Choose Directory
  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('Directory Configuration'));
  console.log();
  if (loadJson.folders && typeof loadJson.folders === 'object') {
    printDirs(loadJson.folders);
  } else {
    loadJson.folders = {};
  }
  console.log(loadJson)

  var forceAdd = false;
  if (Object.keys(loadJson.folders).length === 0) {
    forceAdd = true;
  }
  if (!forceAdd) {
    forceAdd = await confirmThis("Would you like to add another directory?");
  }
  while (forceAdd) {
    const newDir = await addNewFolder();
    const folderAlias = await namePathAlias(loadJson);
    loadJson.folders[folderAlias] = { root: newDir };
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('Directory Configuration'));
    console.log();
    printDirs(loadJson.folders);
    forceAdd = await confirmThis("Would you like to add a new directory?");
  }

  // Users
  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('User Configuration'));
  console.log();
  var shouldAdd = false;
  if (!loadJson.users || typeof loadJson.users !== 'object') {
    loadJson.users = {};
  }
  if (Object.keys(loadJson.users).length === 0) {
    console.log('There are currently no users');
    console.log(colors.yellow('With no users, mStream will be publicly available and the login system will be disabled'));
    console.log();
    shouldAdd = true;
  } else {
    printUsers(loadJson.users);
  }
  while (await confirmThis("Would you like to add a user?", shouldAdd)) {
    shouldAdd = false;
    await addOneUser(loadJson);
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('User Configuration'));
    console.log();
    printUsers(loadJson.users);
  }

  // Port
  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('Set Port'));
  console.log();
  loadJson.port = await editPort(loadJson.port);

  // Secret
  if (!loadJson.secret) {
    loadJson.secret = await generateSecret();
  } else {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('Secret Generator'));
    console.log();
    console.log('The Secret Key is used to secure login sessions');
    console.log('Generating a new secret will force all users to sign in again');
    console.log();
    const shouldMakeNewSecret = await confirmThis("You already have a secret. Would you like to make a new one?");
    if (shouldMakeNewSecret) {
      loadJson.secret = await generateSecret();
    }
  }

  // await fileScanLoop(loadJson);

  // Save
  fs.writeFileSync( filepath, JSON.stringify(loadJson,  null, 2), 'utf8');
  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('Config Saved!'));
  console.log();
  console.log(colors.bold('You can start mStream by running the command:'));
  console.log(`mstream -j ${filepath}`);
  console.log();

  // Print a Help Text explaining basic usage things
}

function printConfig(loadJson) {
  console.log(loadJson);
}

async function mainLoop(loadJson) {
  var mainOpt = { select: true };
  while (mainOpt.select !== 'finished') {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('Main Menu'));
    console.log();

    // Print if specified
    if (mainOpt.select === 'current') {
      printConfig(loadJson);
      console.log();
    }

    mainOpt = await inquirer.prompt([{
      message: 'What would you like to do?',
      pageSize: 12,
      type: "list",
      name: "select",
      choices: [
        { name: 'See Current Config', value: 'current' },
        new inquirer.Separator(),
        { name: 'User Options', value: 'users' },
        { name: 'Folder Options', value: 'folders' },
        { name: 'File Scan Options', value: 'filescan' },
        { name: 'Server Options', value: 'server' },
        { name: 'SSL', value: 'ssl' },
        new inquirer.Separator(),
        { name: 'Exit And Save', value: 'finished' },
      ]
    }]).then(answers => {
      return answers;
    });

    switch (mainOpt.select) {
      case 'users':
        await userLoop(loadJson);
        break;
      case 'folders':
        await folderLoop(loadJson);
        break;
      case 'filescan':
        await fileScanLoop(loadJson);
        break; 
      case 'ssl':
        await sslLoop(loadJson);
        break; 
      case 'server':
        await serverLoop(loadJson);
        break;
      default:
        break;
    }
  }
}

async function serverLoop(loadJson) {
  var editUsers = { userList: true };
  var printErr;
  while (editUsers.userList !== 'finished') {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('Server Options'));
    console.log();

    if (printErr) {
      console.log(colors.red(printErr));
      console.log();
      printErr = null;
    }

    editUsers = await inquirer.prompt([{
      message: 'Choose your User Operation',
      type: "list",
      name: "userList",
      choices: [{ name: 'finished', value: 'finished' }, 
        new inquirer.Separator(),
        { name: 'Edit Port', value: 'editPort' },
        { name: 'Edit Security Secret', value: 'editSecret' },
        { name: 'Logs', value: 'logs' },
        { name: 'Change the Web App Folder', value: 'editUi' }
      ]
    }]).then(answers => {
      return answers;
    });

    switch (editUsers.userList) {
      case 'editPort':
        try {
          loadJson.port = await editPort(loadJson.port);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'editSecret':
        try {
          await addOneUser(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'editUi':
        try {
          await changeWebappFolder(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'logs':
        try {
        } catch (err) {
        }
        break;
      default:
        break;
    }
  }
}

function changeWebappFolder() {
  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('Server Options'));
  console.log();

  return inquirer.prompt([{
    type: 'directory',
    name: 'from',
    message: 'Choose Your Web App Folder:',
    basePath: path.join(__dirname, '../../public')
  }]).then((answers) => {
    return answers.from;
  });
}

async function folderLoop(loadJson) {
  if (!loadJson.folders) {
    loadJson.folders = {};
  }

  var editUsers = { userList: true };
  var printErr;
  while (editUsers.userList !== 'finished') {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('File Scan Options'));
    console.log();

    if (printErr) {
      console.log(colors.red(printErr));
      console.log();
      printErr = null;
    }

    printDirs(loadJson.folders);

    editUsers = await inquirer.prompt([{
      message: 'Choose your User Operation',
      type: "list",
      name: "userList",
      choices: [{ name: 'finished', value: 'finished' }, 
        new inquirer.Separator(),
        { name: 'Add A Folder', value: 'addFolder' },
        { name: 'Remove A Folder', value: 'deleteFolder' },
        { name: 'Edit A Folder', value: 'editFolder' }
      ]
    }]).then(answers => {
      return answers;
    });

    switch (editUsers.userList) {
      case 'addFolder':
        try {
          const newDir = await addNewFolder();
          const folderAlias = await namePathAlias(loadJson);
          loadJson.folders[folderAlias] = { root: newDir };
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'deleteFolder':
        try {
          await deleteFolder(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'editFolder':
        try {
          await editFolder(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      default:
        break;
    }
  }
}

async function userLoop(loadJson) {
  if (!loadJson.users || typeof loadJson.users !== 'object') {
    loadJson.users = {};
  }
  var editUsers = { userList: true };
  var printErr;
  while (editUsers.userList !== 'finished') {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('User Options'));
    console.log();

    if (printErr) {
      console.log(colors.red(printErr));
      console.log();
      printErr = null;
    }

    printUsers(loadJson.users);

    editUsers = await inquirer.prompt([{
      message: 'Choose your User Operation',
      type: "list",
      name: "userList",
      choices: [{ name: 'finished', value: 'finished' }, 
        new inquirer.Separator(),
        { name: 'Add A User', value: 'addUser' },
        { name: 'Remove A User', value: 'removeUser' },
        { name: 'Edit A User', value: 'editUser' },
        new inquirer.Separator(),
        { name: 'Add A Folder', value: 'addFolder' }
      ]
    }]).then(answers => {
      return answers;
    });

    switch (editUsers.userList) {
      case 'addFolder':
        try {
          if (!loadJson.folders || typeof loadJson.folders !== 'object') {
            loadJson.folders = {};
          }
          const newDir = await addNewFolder();
          const folderAlias = await namePathAlias(loadJson);
          loadJson.folders[folderAlias] = { root: newDir };
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'addUser':
        try {
          await addOneUser(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'removeUser':
        try {
          await deleteOneUser(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'editUser':
        await editUser(loadJson);
        break;
      default:
        break;
    }
  }
}

async function sslLoop(loadJson) {
  if (!loadJson.ssl || typeof loadJson.ssl !== 'object') {
    loadJson.ssl = {};
  }

  var editUsers = { userList: true };
  var printErr;
  while (editUsers.userList !== 'finished') {
    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('SSL Options'));
    console.log();

    if (printErr) {
      console.log(colors.red(printErr));
      console.log();
      printErr = null;
    }

    printUsers(loadJson.users);

    editUsers = await inquirer.prompt([{
      message: 'Choose your User Operation',
      type: "list",
      name: "userList",
      choices: [
        { name: 'finished', value: 'finished' }, 
        new inquirer.Separator(),
        { name: 'Add A User', value: 'addCert' },
        { name: 'Remove A User', value: 'addKey' }
      ]
    }]).then(answers => {
      return answers;
    });

    switch (editUsers.userList) {
      case 'addCert':
        try {
          await addOneUser(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      case 'addKey':
        try {
          await deleteOneUser(loadJson);
        } catch (err) {
          printErr = err.message;
        }
        break;
      default:
        break;
    }
  }
}

function editUser() {
  console.log('NOT IMPLEMTEND');
  return Promise.resolve();
}

async function fileScanLoop(loadJson) {
  // Scan Options
  if (!loadJson.scanOptions) {
    loadJson.scanOptions = {};
  }
  var editDb = { dbList: true };
  while (editDb.dbList !== 'finished') {
    switch (editDb.dbList) {
      case 'dbpause':
        loadJson.scanOptions.pause = await setScanPause();
        break;
      case 'interval':
        loadJson.scanOptions.scanInterval = await setScanInterval();
        break;
      case 'bootpause':
        loadJson.scanOptions.bootScanDelay = await setBootDelay();
        break;
      case 'saveinterval':
        loadJson.scanOptions.saveInterval = await setSaveInterval();
        break;
      case 'skipimg':
        const shouldSkip = await skipImg();
        if (shouldSkip) {
          loadJson.scanOptions.skipImg = true
        }
        break;
      default:
        break;
    }

    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('File Scan Options'));
    console.log();
    editDb = await inquirer.prompt([{
      message: 'Choose your DB Option',
      type: "list",
      name: "dbList",
      choices: [{ name: 'finished', value: 'finished' }, 
        new inquirer.Separator(),
        { name: 'Pause Between Files', value: 'dbpause' },
        { name: 'Scan Interval', value: 'interval' },
        { name: 'Boot Scan Pause', value: 'bootpause' },
        { name: 'Skip Image Scan', value: 'skipimg' },
        { name: 'Save Interval', value: 'saveinterval' }
      ]
    }]).then(answers => {
      return answers;
    });
  }
}

function skipImg() {
  console.log(colors.yellow('Skipping images while scanning will reduce the scan time and lower the memory usage during scan'));
  console.log();

  return inquirer
    .prompt([{
      message: 'Would you like to skip Album Art images when scanning?',
      type: "confirm",
      name: "confirm",
      default: false
    }])
    .then(answers => {
      if(answers.confirm === true) {
        return true;
      }
      return false;
    });
}

function setSaveInterval() {
  console.log(colors.yellow('Sets how often a DB update should happen during a file scan'));
  console.log('Large libraries (4TB+) can see some performance gains during scan by increasing this');
  console.log();

  return inquirer
  .prompt([{
    message: "Save DB every __ files: ",
    type: "input",
    name: "interval",
    default: 250,
    validate: answer => {
      if (!Number.isInteger(Number(answer)) || Number(answer) < 100) {
        return 'Save Interval must be a an integer greater than 100!';
      }
      return true;
    }
  }])
  .then(answers => {
    return Number(answers.interval);
  });
}

function setScanPause() {
  console.log(colors.yellow('Sets a pause interval between each file that is scanned (in milliseconds)'));
  console.log('Scanning large libraries can eat up disk and CPU resources on slower system');
  console.log('Setting a pause between files will increase the scan time but reduce system resource usage');
  console.log();

  return inquirer
  .prompt([{
    message: "Set pause (milliseconds): ",
    type: "input",
    name: "pause",
    default: 0,
    validate: answer => {
      if (!Number.isInteger(Number(answer)) || Number(answer) < 0) {
        return 'Pause cannot be less than 0';
      }
      return true;
    }
  }])
  .then(answers => {
    return Number(answers.pause);
  });
}

function setBootDelay() {
  console.log(colors.yellow('Sets a delay between server boot and the initial file scan (in seconds)'));
  console.log('Scanning large libraries can cause a spike in memory usage.  And booting the server causes a spike in memory usage');
  console.log('By adding a delay between boot and scan, you can reduce the max memory use');
  console.log();

  return inquirer
  .prompt([{
    message: "Set boot scan delay (seconds): ",
    type: "input",
    name: "delay",
    default: 0,
    validate: answer => {
      if (!Number.isInteger(Number(answer)) || Number(answer) < 0) {
        return 'Delay cannot be less than 0';
      }
      return true;
    }
  }])
  .then(answers => {
    return Number(answers.delay);
  });
}

function setScanInterval() {
  console.log(colors.yellow('Sets how often a scan should happen (in hours)'));
  console.log('Scans happen every 24 hours by default');
  console.log();

  return inquirer
    .prompt([{
      message: "Scan every __ hours: ",
      type: "input",
      name: "interval",
      default: 24,
      validate: answer => {
        if (!Number.isInteger(Number(answer)) || Number(answer) < 0) {
          return 'Scan Interval cannot be less than 0';
        }
        return true;
      }
    }])
    .then(answers => {
      return Number(answers.interval);
    });
}

function generateSecret() {
  return new Promise((resolve, reject) => {
    require('crypto').randomBytes(48, function (err, buffer) {
      if (err) {
        reject();
      }
      resolve(buffer.toString('hex'));
    });
  });
}

function printDirs(folders) {
  if (!folders || Object.keys(folders).length === 0) {
    console.log('There are currently no folders');
    console.log(colors.yellow('With no folders, mStream will use the current working directory'));
    console.log();
    return;
  }

  console.log('Your config has the following folders:');
  Object.entries(folders).forEach(([key, value]) => {
    var thisDir;
    if (typeof value === 'string' || value instanceof String) {
      thisDir = value;
    } else {
      thisDir = value.root;
    }
    console.log(`${colors.green.bold.dim(key)}: ${thisDir}`);
  });
  console.log();
}

function printUsers(users) {
  if (!users || Object.keys(users).length === 0) {
    console.log('There are currently no users');
    console.log(colors.yellow('With no users, mStream will be publicly available and the login system will be disabled'));
    console.log();
    return;
  }

  console.log('Your config has the following users:');
  Object.entries(users).forEach(([key, value]) => {
    console.log(` * ${colors.green.bold.dim(key)}`);
  });
  console.log();
}
