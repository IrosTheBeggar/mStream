'use strict';
const Joi = require('joi');

// Function to validate input using Joi
const joiValidate = (joiSchema, validateThis, throwErr) => {
  const { error, value } = joiSchema.validate(validateThis);

  if (error && throwErr !== false) {
    throw error;
  }

  return { error, value };
};

// Function to sanitize filenames
const sanitizeFilename = filename => {
  const filenameSchema = Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9]{1,7}$/)
    .required();

  // Validate the filename using the schema
  const { error, value } = joiValidate(filenameSchema, filename);

  // If validation fails, throw an error or return a sanitized version
  if (error) {
    throw new Error('Invalid filename');
  }

  return value;
};

module.exports = {
  joiValidate,
  sanitizeFilename,
};
