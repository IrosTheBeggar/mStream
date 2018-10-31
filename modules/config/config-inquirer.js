const inquirer = require('inquirer');
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
      return answers.port;
    });
}

exports.editPort = function() {
  return editPort();
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

// TODO: LastFM user
function addOneUser(current) {
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
    }])
    .then(ans => {
      answers = ans;
      return hashPassword(answers.password);
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
  inquirer.registerPrompt('directory', require('inquirer-select-directory'));
  return inquirer.prompt([{
    type: 'directory',
    name: 'from',
    message: 'Choose your music directory:',
    basePath: '.'
  }]).then((answers) => {
    return answers.from;
  });
}


async function doTheThing(filepath) {
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

  await initFile(filepath);
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

  console.clear();
  console.log();
  console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
  console.log(colors.magenta('User Configuration'));
  console.log();

  var addUser = false;
  if (!loadJson.users || typeof loadJson.users !== 'object') {
    loadJson.users = {};
  }
  if (Object.keys(loadJson.users).length === 0) {
    console.log('There are currently no users');
    console.log(colors.yellow('With no users, mStream will be publicly available and the login system will be disabled'));
    console.log();
  } else {
    printUsers(loadJson.users);
  }
  addUser = await confirmThis("Would you like to add a user?");
  
  while (addUser) {
    await addOneUser(loadJson);

    console.clear();
    console.log();
    console.log(colors.blue.bold('Welcome To The mStream Setup Wizard'));
    console.log(colors.magenta('User Configuration'));
    console.log();
    printUsers(loadJson.users);

    addUser = await confirmThis("Would you like to add a user?");
  }

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

  // Database Location

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
  console.log('Your config has the following users:');
  Object.entries(users).forEach(([key, value]) => {
    console.log(` * ${colors.green.bold.dim(key)}`);
  });
  console.log();
}
