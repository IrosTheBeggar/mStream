'use strict';
const Joi = require('joi');
const sanitize = require('sanitize-filename');

const joiValidate = (joiSchema, validateThis, throwErr) => {
  const { error, value } = joiSchema.validate(validateThis);

  if (error && throwErr !== false) {
    throw error;
  }

  return { error, value };
};

const sanitizeFilename = filename => {
  var sanitized = sanitize(filename);

  return sanitized;
};

module.exports = {
  joiValidate,
  sanitizeFilename,
};
