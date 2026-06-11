// Opt-in HTTP response compression on Node's built-in zlib — no new
// dependency. The mode (none | gzip | brotli) comes from config and is
// read per request, so the admin toggle applies without a restart.
//
// Two rules carry the safety story:
//
//   1. Only text-ish content types are ever touched. Audio, video and
//      images pass through byte-for-byte, so playback and range/seek
//      requests cannot break.
//
//   2. Compressible bodies are buffered and compressed whole — never
//      piped through a zlib transform. express.static pipes its file
//      into res, and a transform in that path deadlocks on backpressure
//      (the pipe parks on 'drain' while the bytes sit in zlib's buffer).
//      Buffering also yields an exact compressed Content-Length.
//
// Bodies that outgrow MAX_BUFFER are sent plain — streamed from the
// overflow point when they arrive across many writes, or whole when one
// end() call delivers everything — so the compression machinery never
// multiplies a huge payload in RAM.

import zlib from 'zlib';
import * as config from '../state/config.js';

const COMPRESSIBLE_TYPES = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|wasm|xml|x-ndjson|(?:manifest|ld)\+json)|application\/[a-z0-9.+-]*\+(?:json|xml)|image\/svg\+xml)/i;

const MIN_BYTES = 256;               // below this, header overhead beats the savings
const MAX_BUFFER = 8 * 1024 * 1024;  // above this, stream plain instead of holding it in RAM

// Which coding to send, honoring both the operator ceiling (`mode`) and
// the client's Accept-Encoding. "gzip;q=0" is an explicit refusal, so a
// substring match is not enough — parse each entry's q-value, and let an
// explicit refusal beat a "*" wildcard.
function pickEncoding(acceptHeader, mode) {
  if (mode !== 'gzip' && mode !== 'brotli') { return null; }
  const accepted = new Set();
  const refused = new Set();
  for (const entry of String(acceptHeader || '').split(',')) {
    const [coding, ...params] = entry.split(';').map(s => s.trim().toLowerCase());
    if (!coding) { continue; }
    const q = params.find(p => p.startsWith('q='));
    (parseFloat(q ? q.slice(2) : '1') > 0 ? accepted : refused).add(coding);
  }
  const takes = (name) => !refused.has(name) && (accepted.has(name) || accepted.has('*'));
  if (mode === 'brotli' && takes('br')) { return 'br'; }
  if (takes('gzip')) { return 'gzip'; }
  return null;
}

// Would a body of this content-type/status be compressed? Shared between
// the real middleware and the HEAD header-parity branch.
function looksCompressible(res) {
  const status = res.statusCode;
  if (status === 204 || status === 206 || status === 304) { return false; }
  const prior = String(res.getHeader('Content-Encoding') || 'identity');
  if (prior.toLowerCase() !== 'identity') { return false; }
  if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') || ''))) { return false; }
  return COMPRESSIBLE_TYPES.test(String(res.getHeader('Content-Type') || ''));
}

function appendVary(res) {
  const vary = String(res.getHeader('Vary') || '');
  if (!/\baccept-encoding\b/i.test(vary)) {
    res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  }
}

function toBuffer(chunk, enc) {
  if (chunk == null) { return null; }
  if (Buffer.isBuffer(chunk)) { return chunk; }
  return Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
}

function afterEndError() {
  const err = new Error('write after end');
  err.code = 'ERR_STREAM_WRITE_AFTER_END';
  return err;
}

function compress(raw, encoding, cb) {
  if (encoding === 'br') {
    // Quality 5: near-gzip speed at a better ratio. The default (11) is
    // built for ahead-of-time compression and is far too slow here.
    zlib.brotliCompress(raw, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    } }, cb);
  } else {
    zlib.gzip(raw, { level: 6 }, cb);
  }
}

// HEAD carries no body to compress, but its headers must not promise
// what the matching GET won't deliver: the identity Content-Length is
// wrong whenever the GET would go out encoded. Drop it (omitting it on
// HEAD is conforming) and keep the Vary so caches treat both alike.
function headParity(res, next) {
  const endRaw = res.end.bind(res);
  res.end = function (chunk, enc, cb) {
    if (!res.headersSent && looksCompressible(res)) {
      res.removeHeader('Content-Length');
      appendVary(res);
    }
    return endRaw(chunk, enc, cb);
  };
  next();
}

export function compression(req, res, next) {
  const mode = config.program?.compression?.mode || 'none';
  const encoding = pickEncoding(req.headers['accept-encoding'], mode);
  if (!encoding) { return next(); }
  if (req.method === 'HEAD') { return headParity(res, next); }

  const writeRaw = res.write.bind(res);
  const endRaw = res.end.bind(res);

  let decided = false;    // the first body write locks the choice below
  let buffering = false;  // chunks collect here instead of going to the socket
  let ended = false;      // our end() ran; the real end may still be inside zlib
  let chunks = [];
  let size = 0;

  // Headers are final by the first body write — the one moment we can
  // still choose between buffering this response and leaving it alone.
  // headersSent guards the writeHead()/flushHeaders() case: those bypass
  // these wrappers entirely, and touching headers later would throw.
  function decide() {
    if (decided) { return; }
    decided = true;
    if (res.headersSent || !looksCompressible(res)) { return; }
    // However this body ends up going out (compressed, too-small plain,
    // over-budget plain), the resource itself varies on Accept-Encoding.
    appendVary(res);
    buffering = true;
  }

  // The body outgrew MAX_BUFFER: replay what we hold and stream the rest
  // plain. Nothing has touched the socket while buffering, so the
  // handler's own Content-Length / Content-Type are still intact.
  function bailOut() {
    buffering = false;
    const held = chunks;
    chunks = [];
    for (const c of held) { writeRaw(c); }
  }

  function sendPlain(raw, cb) {
    // res.flushHeaders() mid-buffering pushes the headers out behind our
    // back — when that happened there is nothing left to set, and trying
    // would throw. Just deliver the bytes.
    if (!res.headersSent) { res.setHeader('Content-Length', raw.length); }
    if (raw.length > 0) { writeRaw(raw); }
    return endRaw(cb);
  }

  res.write = function (chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = null; }
    decide();
    if (ended) {
      // Native write-after-end semantics, minus the socket: the real end
      // may still be in flight inside zlib, so nothing may slip out.
      if (cb) { process.nextTick(cb, afterEndError()); }
      return false;
    }
    if (!buffering) { return writeRaw(chunk, enc, cb); }
    const buf = toBuffer(chunk, enc);
    if (buf) { chunks.push(buf); size += buf.length; }
    if (size > MAX_BUFFER) { bailOut(); }
    if (cb) { process.nextTick(cb); }
    return true; // buffered — there is no backpressure to signal
  };

  res.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = null; }
    else if (typeof enc === 'function') { cb = enc; enc = null; }
    decide();
    if (!buffering) { return endRaw(chunk, enc, cb); }
    if (ended) {
      // Second end(): the first response wins, like native. Without this,
      // an error handler firing after res.json() would splice its body
      // into the still-pending compressed response.
      if (cb) { process.nextTick(cb, afterEndError()); }
      return res;
    }
    ended = true;

    const tail = toBuffer(chunk, enc);
    if (tail) { chunks.push(tail); }
    const raw = Buffer.concat(chunks);
    chunks = [];

    // Too small to be worth the framing, or too big to be worth holding a
    // second and third copy in RAM — either way it goes out plain.
    if (raw.length < MIN_BYTES || raw.length > MAX_BUFFER) {
      return sendPlain(raw, cb);
    }

    // Everything past this point runs after an async hop, and the app may
    // mutate the response meanwhile — the classic respond-then-throw bug
    // has the error handler set statusCode=500 while our 200 sits in
    // zlib. Pin the status line now; restore it when the headers go out.
    const status = res.statusCode;
    const message = res.statusMessage;
    compress(raw, encoding, (err, out) => {
      if (res.destroyed || res.writableEnded) { return; } // client went away
      res.statusCode = status;
      res.statusMessage = message;
      // headersSent: a flushHeaders() during the zlib window already
      // committed identity headers — deliver plain rather than throw.
      if (res.headersSent || err || !out) { return sendPlain(raw, cb); }
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', out.length);
      writeRaw(out);
      endRaw(cb);
    });
    return res;
  };

  next();
}
