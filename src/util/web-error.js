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

// How the terminal error handler (src/server.js) treats one error: the HTTP
// status to answer with, the log level the event deserves, and whether the
// stack belongs in the log. Pure — this classification IS the severity
// policy, so it's pinned by unit tests (test/unit/web-error.test.mjs)
// instead of living implicitly in the handler.
//
//   WebError 4xx   a deliberately thrown, handled "no" to the client —
//                  routine traffic, logged as a rejection (warn). It used to
//                  be logged as error-level "Server error on route …", which
//                  manufactured phantom incidents: one credential-less
//                  client polling /api/v1/ping put ~100 "Server error" lines
//                  a day into a production log, and any real 500 drowned in
//                  them (mStream #880's investigation tripped over exactly
//                  that).
//   WebError 5xx   server-side trouble the throw site CHOSE — error level,
//                  but no stack: the message is the story, the trace is
//                  noise pointing at the throw statement.
//   anything else  a genuine unhandled crash: error level, stack attached,
//                  answered as a plain 500.
export function classifyError(error) {
  if (error instanceof WebError) {
    return {
      kind: 'web',
      status: error.status,
      level: error.status >= 500 ? 'error' : 'warn',
      stack: false,
    };
  }
  return { kind: 'unhandled', status: 500, level: 'error', stack: true };
}
