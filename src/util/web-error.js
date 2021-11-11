'use strict';

class WebError extends Error {  
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name

    if(!Number.isInteger(code) || code < 400 || code > 599) {
      code = 500;
    };
    this.status = code;
  }
}

module.exports = WebError;