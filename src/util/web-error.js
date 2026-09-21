'use strict';

import { STATUS_CODES } from 'node:http';

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
//   a request the  Express said "no" before any route ran: a body
//   framework      express.json() could not parse or would not accept (broken
//   refused        JSON, over maxRequestSize, a charset or content-encoding it
//                  does not speak), or a URL whose percent-escapes do not
//                  decode. The same phantom-incident problem as above, and
//                  worse placed: the parsers sit AHEAD of the auth wall, so
//                  one `{"a": ` from anyone used to buy a 500 and an
//                  error-level stack. Its own 4xx, warn, no stack — and a
//                  FIXED message (`message` below), because the parser's own
//                  quotes the request back.
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
  const refused = frameworkRejection(error);
  if (refused) {
    return { kind: 'web', status: refused.status, level: 'warn', stack: false, message: refused.message };
  }
  return { kind: 'unhandled', status: 500, level: 'error', stack: true };
}

// What body-parser / raw-body call their 4xx errors (`error.type`), and what
// the client is told instead of the parser's own wording. Their two 5xx types
// (stream.encoding.set, stream.not.readable) mean OUR middleware order is
// broken — those stay crashes.
const REFUSED_BODY_MESSAGES = {
  'entity.parse.failed': 'Malformed request body',
  'entity.too.large': 'Request body too large',
  'parameters.too.many': 'Too many parameters in the request body',
  'querystring.parse.rangeError': 'Request body is nested too deeply',
  'charset.unsupported': 'Unsupported request charset',
  'encoding.unsupported': 'Unsupported request content-encoding',
  'request.size.invalid': 'Request body did not match its Content-Length',
  'request.aborted': 'Request aborted before the body arrived',
};

// Deliberately NARROW: only the two markers the framework itself leaves.
//   - http-errors, as body-parser uses it: a string `type`, expose=true, and
//     a 4xx status.
//   - the router's undecodable URL parameter: a URIError it stamps status 400.
// A bare `status` on some other error is NOT an instruction to answer with
// it — route code carries statuses that describe someone else's response
// (discovery-plugins/http.js providerError is one), and an escaped one of
// those is a bug that should look like a bug.
function frameworkRejection(error) {
  if (!error || typeof error !== 'object') { return null; }
  const status = error.status;
  if (!Number.isInteger(status) || status < 400 || status > 499) { return null; }

  if (error instanceof URIError) {
    return status === 400 ? { status, message: 'Malformed URL' } : null;
  }
  if (typeof error.type === 'string' && error.expose === true) {
    let message = (Object.hasOwn(REFUSED_BODY_MESSAGES, error.type) && REFUSED_BODY_MESSAGES[error.type])
      || STATUS_CODES[status] || 'Bad Request';
    // raw-body's own number (the configured maxRequestSize, in bytes) — the
    // one detail that tells an admin which setting the rejection came from.
    if (error.type === 'entity.too.large' && Number.isInteger(error.limit)) {
      message += ` (limit ${error.limit} bytes)`;
    }
    return { status, message };
  }
  return null;
}
