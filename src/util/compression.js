// Response compression middleware (brotli + gzip) built on Node's built-in
// zlib — no third-party dependency, so nothing extra to bundle for the Electron
// build.
//
// Operator-configured via config.compression.mode, read FRESH on every request
// so the admin panel can switch it live with no reboot:
//   'none'   — disabled (default for now); the middleware is a passthrough.
//   'gzip'   — gzip only, even for clients that also advertise brotli.
//   'brotli' — brotli for clients that advertise `br`, else gzip as a fallback.
//
// Strategy: BUFFER the response body and compress it once in res.end, then send
// it with an accurate Content-Length. This deliberately avoids streaming the
// body through a zlib transform — wrapping res.write/res.end around a transform
// deadlocks on piped responses (express.static) because the pipe waits on the
// socket's `drain` while the bytes sit in the zlib buffer. Buffering sidesteps
// all of that and lets us set the real (compressed) Content-Length.
//
// Compression is gated by Content-Type: only text-ish payloads (JSON, HTML, JS,
// CSS, XML, SVG) are buffered+compressed. Audio/*, image/* (except SVG),
// video/* and application/octet-stream are NEVER touched — they stream straight
// through unchanged, so audio playback and HTTP range/seek requests keep
// working (the one thing that must not break). Already-encoded, 204/304/206,
// `no-transform`, HEAD and tiny bodies are skipped too.

import zlib from 'zlib';
import * as config from '../state/config.js';

const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|wasm|xml|x-ndjson|(?:manifest|ld)\+json)|application\/[a-z0-9.+-]*\+(?:json|xml)|image\/svg\+xml)/i;

// Below this, the header + framing overhead isn't worth it.
const MIN_BYTES = 256;

// Pick the wire encoding from what the client accepts AND the operator-
// configured ceiling `mode`. Returns 'br', 'gzip', or null (don't compress).
//   'none' / anything-unexpected → null
//   'gzip'   → gzip if the client accepts it, else null (never br)
//   'brotli' → br if the client accepts it, else gzip if it accepts that, else null
function chooseEncoding(accept, mode) {
  if (mode !== 'gzip' && mode !== 'brotli') { return null; }
  const a = String(accept || '');
  const acceptsBr = /(?:^|,)\s*br(?:\s*;|\s*,|\s*$)/i.test(a);
  const acceptsGzip = /(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(a);
  if (mode === 'brotli' && acceptsBr) { return 'br'; }
  if (acceptsGzip) { return 'gzip'; }
  return null;
}

function asBuffer(chunk, enc) {
  if (chunk == null) { return null; }
  if (Buffer.isBuffer(chunk)) { return chunk; }
  return Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
}

export function compression(req, res, next) {
  // Read the configured mode fresh each request so the admin toggle takes
  // effect with no reboot. Defaults to 'none' (off) until an operator opts in.
  const mode = config.program?.compression?.mode || 'none';
  const encoding = chooseEncoding(req.headers['accept-encoding'], mode);
  // Compression off, no usable encoding, or a HEAD (no body) — nothing to do.
  if (!encoding || req.method === 'HEAD') { return next(); }

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  let decided = false;
  let compressing = false;
  let chunks = null;

  // Decide once, on the first write/end (Content-Type is set by then), whether
  // this response is a compressible text payload.
  function decide() {
    if (decided) { return; }
    decided = true;
    const type = String(res.getHeader('Content-Type') || '');
    const already = res.getHeader('Content-Encoding');
    const cacheControl = String(res.getHeader('Cache-Control') || '');
    if (
      res.statusCode === 204 || res.statusCode === 304 || res.statusCode === 206 ||
      (already && String(already).toLowerCase() !== 'identity') ||
      /\bno-transform\b/i.test(cacheControl) ||
      !COMPRESSIBLE.test(type)
    ) {
      return; // passthrough
    }
    compressing = true;
    chunks = [];
  }

  res.write = function (chunk, enc, cb) {
    decide();
    if (!compressing) { return origWrite(chunk, enc, cb); }
    const buf = asBuffer(chunk, enc);
    if (buf) { chunks.push(buf); }
    if (typeof enc === 'function') { enc(); } else if (typeof cb === 'function') { cb(); }
    return true; // we've buffered it — never apply backpressure to the producer
  };

  res.end = function (chunk, enc, cb) {
    decide();
    if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = null; }
    else if (typeof enc === 'function') { cb = enc; enc = null; }

    if (!compressing) { return origEnd(chunk, enc, cb); }

    const tail = asBuffer(chunk, enc);
    if (tail) { chunks.push(tail); }
    const raw = Buffer.concat(chunks);

    // Send uncompressed when too small to be worth it.
    if (raw.length < MIN_BYTES) {
      res.setHeader('Content-Length', raw.length);
      origWrite(raw);
      return origEnd(cb);
    }

    const finish = (out) => {
      if (res.destroyed || res.writableEnded) { return; }
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      res.setHeader('Content-Length', out.length);
      const vary = res.getHeader('Vary');
      if (!vary) { res.setHeader('Vary', 'Accept-Encoding'); }
      else if (!/\baccept-encoding\b/i.test(String(vary))) { res.setHeader('Vary', `${vary}, Accept-Encoding`); }
      origWrite(out);
      origEnd(cb);
    };

    const cbCompress = (err, out) => {
      // On any zlib failure, fall back to sending the body uncompressed.
      if (err || !out) {
        if (!res.destroyed && !res.writableEnded) { res.setHeader('Content-Length', raw.length); origWrite(raw); origEnd(cb); }
        return;
      }
      finish(out);
    };

    if (encoding === 'br') {
      // Quality 5: near-gzip speed, better ratio (default 11 is too slow for
      // on-the-fly compression).
      zlib.brotliCompress(raw, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      } }, cbCompress);
    } else {
      zlib.gzip(raw, { level: 6 }, cbCompress);
    }
    return res;
  };

  next();
}
