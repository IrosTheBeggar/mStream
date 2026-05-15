/**
 * Subsonic REST API response envelope.
 *
 * Every method returns a <subsonic-response> wrapper. Clients pick the format
 * via `f`: `xml` (default), `json`, or `jsonp` (requires `callback=`).
 *
 * We build responses as plain JS objects and render them to the requested
 * format at send time. The object shape matches what goes inside the
 * <subsonic-response> element — the wrapper is added here.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

// Subsonic API version we advertise. 1.16.1 is the last version published by
// the original Subsonic project; OpenSubsonic extends this baseline.
export const API_VERSION = '1.16.1';
export const SERVER_TYPE = 'mstream';

// ── XML serialization ───────────────────────────────────────────────────────
// Rules (from the Subsonic/OpenSubsonic spec):
//   - Scalar object properties become XML attributes on the parent element.
//   - Nested object properties become child elements.
//   - Array properties become multiple child elements with the array key as
//     the tag (e.g. `{ child: [{…}, {…}] }` → `<child …/><child …/>`).
// Attributes are emitted in alphabetical order for deterministic output.

function xmlEscapeAttr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isScalar(v) {
  return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function renderXmlElement(tag, obj, depth = 1) {
  if (isScalar(obj)) {
    if (obj == null) { return `<${tag}/>`; }
    return `<${tag}>${xmlEscapeAttr(obj)}</${tag}>`;
  }
  const attrs = [];
  const children = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) { continue; }
    if (isScalar(v)) {
      attrs.push([k, v]);
    } else if (Array.isArray(v)) {
      for (const item of v) { children.push(renderXmlElement(k, item, depth + 1)); }
    } else if (typeof v === 'object') {
      children.push(renderXmlElement(k, v, depth + 1));
    }
  }
  attrs.sort(([a], [b]) => a.localeCompare(b));
  const attrStr = attrs.map(([k, v]) => ` ${k}="${xmlEscapeAttr(v)}"`).join('');
  if (children.length === 0) { return `<${tag}${attrStr}/>`; }
  const pad = '  '.repeat(depth);
  return `<${tag}${attrStr}>\n${pad}${children.join(`\n${pad}`)}\n${'  '.repeat(depth - 1)}</${tag}>`;
}

// ── Envelope construction ───────────────────────────────────────────────────

function envelope(status, body = {}) {
  return {
    status,
    version: API_VERSION,
    type: SERVER_TYPE,
    serverVersion: packageJson.version,
    openSubsonic: true,
    ...body,
  };
}

export function okBody(content = {}) { return envelope('ok', content); }

export function errorBody(code, message) {
  return envelope('failed', { error: { code, message } });
}

// ── Response helpers ────────────────────────────────────────────────────────

function renderResponse(envObj, format, callback) {
  if (format === 'json' || format === 'jsonp') {
    const body = JSON.stringify({ 'subsonic-response': envObj });
    if (format === 'jsonp') {
      // Subsonic spec requires JSONP support; callback name is client-provided
      // so we restrict it to a safe identifier pattern to prevent XSS.
      const safe = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/.test(callback || '') ? callback : 'callback';
      return { body: `${safe}(${body});`, contentType: 'application/javascript; charset=utf-8' };
    }
    return { body, contentType: 'application/json; charset=utf-8' };
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${renderXmlElement('subsonic-response', envObj, 1)}`;
  return { body: xml, contentType: 'application/xml; charset=utf-8' };
}

function pickFormat(req) {
  const raw = (req.query.f || 'xml').toLowerCase();
  if (raw === 'json' || raw === 'jsonp') { return raw; }
  return 'xml';
}

export function sendOk(req, res, content = {}) {
  const { body, contentType } = renderResponse(okBody(content), pickFormat(req), req.query.callback);
  res.status(200).set('Content-Type', contentType).send(body);
}

export function sendError(req, res, code, message) {
  const { body, contentType } = renderResponse(errorBody(code, message), pickFormat(req), req.query.callback);
  // Subsonic returns 200 even for errors; the code in the envelope is what
  // matters. Well-known codes:
  //   10 Missing required parameter
  //   20 Incompatible REST protocol version (client must upgrade)
  //   30 Incompatible REST protocol version (server must upgrade)
  //   40 Wrong username or password
  //   41 Token auth not supported
  //   50 User not authorized
  //   60 Trial period over
  //   70 Data not found
  res.status(200).set('Content-Type', contentType).send(body);
}

// ── Standard Subsonic error shortcuts ───────────────────────────────────────

export const SubErr = {
  MISSING_PARAM:   (req, res, param) => sendError(req, res, 10, `Required parameter is missing: ${param}`),
  CLIENT_TOO_OLD:  (req, res) => sendError(req, res, 20, 'Incompatible Subsonic REST protocol version. Client must upgrade.'),
  SERVER_TOO_OLD:  (req, res) => sendError(req, res, 30, 'Incompatible Subsonic REST protocol version. Server must upgrade.'),
  BAD_CREDENTIALS: (req, res) => sendError(req, res, 40, 'Wrong username or password.'),
  TOKEN_UNSUPPORTED: (req, res) => sendError(req, res, 41,
    'Token authentication requires a Subsonic-specific password. ' +
    'Set one in the mobile-clients panel of the mStream UI, ' +
    'or use plaintext password (p=) / apiKey instead.'),
  NOT_AUTHORIZED:  (req, res) => sendError(req, res, 50, 'User is not authorized for the given operation.'),
  NOT_FOUND:       (req, res, what = 'Requested data') => sendError(req, res, 70, `${what} not found.`),
  GENERIC:         (req, res, msg = 'A generic error occurred.') => sendError(req, res, 0, msg),
  // GENERIC_CODE: emit a specific Subsonic error code with a custom
  // message — for paths where we want a spec-defined code (e.g. 10
  // "missing parameter" with richer wording than SubErr.MISSING_PARAM)
  // without adding a new top-level shortcut.
  GENERIC_CODE:    (req, res, code, msg) => sendError(req, res, code, msg),
};
