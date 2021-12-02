const crypto = require('crypto');

const HASH_BYTES = 32;
const SALT_BYTES = 16;
const ITERATIONS = 15000;
const ENCODING = 'base64';
const ALGORITHM = 'sha512';

exports.hashPassword = password => {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(SALT_BYTES, (err, salt) => {
      if (err) { return reject('Failed to hash password'); }
      crypto.pbkdf2(password, salt.toString(ENCODING), ITERATIONS, HASH_BYTES, ALGORITHM, (err, hash) => {
        if (err) { return reject('Failed to hash password'); }
        resolve({ salt: salt.toString(ENCODING), hashPassword: hash.toString(ENCODING) });
      });
    });
  });
}

exports.authenticateUser = (password, salt, givenPassword) => {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(givenPassword, salt, ITERATIONS, HASH_BYTES, ALGORITHM, (err, verifyHash) => {
      if (err) { return reject('Unknown Authentication Error'); }
      if (verifyHash.toString(ENCODING) !== password) {
        return reject('Authentication Error: Passwords do not match');
      }
      resolve();
    });
  });
}