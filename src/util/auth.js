const crypto = require('crypto');

const hashConfig = {
  hashBytes: 32,
  saltBytes: 16,
  iterations: 15000
};

exports.hashPassword = password => {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(hashConfig.saltBytes, (err, salt) => {
      if (err) { return reject('Failed to hash password'); }
      crypto.pbkdf2(password, salt.toString('base64'), hashConfig.iterations, hashConfig.hashBytes, 'sha512', (err, hash) => {
        if (err) { return reject('Failed to hash password'); }
        resolve({ salt: salt.toString('base64'), hashPassword: hash.toString('base64') });
      });
    });
  });
}

exports.authenticateUser = (password, salt, givenPassword) => {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(givenPassword, salt, hashConfig.iterations, hashConfig.hashBytes, 'sha512', (err, verifyHash) => {
      if (err) { reject('Unknown Authentication Error'); }
      if (verifyHash.toString('base64') !== password) {
        return reject('Authentication Error: Passwords do not match');
      }
      resolve();
    });
  });
}