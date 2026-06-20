'use strict';

class WebError extends Error {
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name

    // A WebError is a deliberately-thrown, handled condition — almost always a
    // client error — not an unexpected crash. So when the code is omitted (or
    // outside the 4xx/5xx range) default to 400 Bad Request rather than 500;
    // callers that genuinely mean a server error pass 500 explicitly.
    if(!Number.isInteger(code) || code < 400 || code > 599) {
      code = 400;
    };
    this.status = code;
  }
}

export default WebError;
