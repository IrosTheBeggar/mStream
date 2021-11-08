'use strict';
require('joi');

const joiValidate = (joiSchema, validateThis, throwErr) => {
  const { error, value } = joiSchema.validate(validateThis);

  // Defaults to throwing an error
  if (error !== undefined && throwErr !== false) {
    throw error;
  }

  return { error, value };
}

module.exports = { joiValidate };