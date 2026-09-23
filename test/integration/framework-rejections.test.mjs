/**
 * Requests that Express itself refuses are 4xx rejections, not crashes.
 *
 * express.json() and the router say "no" before any route runs — a body that
 * is not JSON, a body over maxRequestSize, a charset or content-encoding the
 * parser does not speak, a URL whose percent-escapes do not decode. They say
 * it with their own error objects, which the terminal handler in
 * src/server.js did not recognise: every one of them was answered
 * `500 {"error":"Server Error"}` and logged as an error-level "Server error
 * on route …" with a stack. Found 2026-09-20 by the server-audio smoke round
 * (`{"position": ` sent to /server-playback/seek), then reproduced on
 * unrelated routes under both Node and the Bun bundle.
 *
 * It is worse placed than a wrong status code: the parsers sit AHEAD of the
 * auth wall, so anyone who can reach the port could fill the log with
 * error-level stacks — the "phantom incident" noise classifyError
 * (util/web-error.js) exists to keep out. So this boots WITH a user and sends
 * most requests with no credentials at all.
 *
 * Pinned here: the status, the fixed message (the parser's own quotes the
 * request back — never echoed, never logged), that a good request still
 * works, and that the log records rejections rather than crashes.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const MARKER = 'secret-marker-7f3a';

let server;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    waitForScan: false,
    users: [{ ...ADMIN, admin: true, vpaths: ['testlib'] }],
    extraConfig: { writeLogs: true, maxRequestSize: '1KB' },   // writeLogs: to assert HOW these are logged
  });
});

after(async () => { if (server) { await server.stop(); } });

async function post(route, rawBody, headers = {}) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: rawBody,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}

// fetch() normalises URLs, so a broken percent-escape has to go down a socket.
function rawGet(target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(server.port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (c) => { buf += c; });
    sock.on('error', reject);
    sock.on('close', () => {
      const [head, body = ''] = buf.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), text: body });
    });
  });
}

async function readLog() {
  const logDir = path.join(server.tmpDir, 'logs');
  let log = '';
  for (const f of await fs.readdir(logDir).catch(() => [])) { log += await fs.readFile(path.join(logDir, f), 'utf8'); }
  return log;
}

describe('a request body express.json() refuses — sent with NO credentials', () => {
  test('broken JSON → 400 with a fixed message that does not quote the body back', async () => {
    const r = await post('/api/v1/db/metadata', `{"filepath": ${MARKER}`);
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(r.body, { error: 'Malformed request body' });
  });

  test('the same on any route: it never gets as far as one', async () => {
    for (const route of ['/api/v1/server-playback/seek', '/api/v1/playlist/save', '/api/v1/auth/login', '/no/such/route']) {
      const r = await post(route, '{"position": ');
      assert.equal(r.status, 400, `${route}: ${r.text}`);
      assert.deepEqual(r.body, { error: 'Malformed request body' }, route);
    }
  });

  test('a bare JSON primitive (strict mode) → 400', async () => {
    const r = await post('/api/v1/db/metadata', '"just a string"');
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(r.body, { error: 'Malformed request body' });
  });

  test('a body over maxRequestSize → 413 that names the limit', async () => {
    const r = await post('/api/v1/db/metadata', JSON.stringify({ filepath: 'x'.repeat(5000) }));
    assert.equal(r.status, 413, r.text);
    assert.deepEqual(r.body, { error: 'Request body too large (limit 1024 bytes)' });
  });

  test('an unsupported charset or content-encoding → 415', async () => {
    const charset = await post('/api/v1/db/metadata', '{}', { 'Content-Type': 'application/json; charset=klingon' });
    assert.equal(charset.status, 415, charset.text);
    assert.deepEqual(charset.body, { error: 'Unsupported request charset' });

    const encoding = await post('/api/v1/db/metadata', '{}', { 'Content-Encoding': 'rot13' });
    assert.equal(encoding.status, 415, encoding.text);
    assert.deepEqual(encoding.body, { error: 'Unsupported request content-encoding' });
  });
});

describe('a URL the router cannot decode', () => {
  test('a broken percent-escape → 400, on a parameterised mount and on a plain path', async () => {
    for (const target of ['/media/%E0%A4%A/x.mp3', '/api/v1/%E0%A4%A']) {
      const r = await rawGet(target);
      assert.equal(r.status, 400, `${target}: ${r.text}`);
      assert.deepEqual(JSON.parse(r.text), { error: 'Malformed URL' }, target);
    }
  });
});

describe('what did NOT change', () => {
  test('a well-formed request still reaches the auth wall and the route', async () => {
    const anonymous = await post('/api/v1/db/metadata', JSON.stringify({ filepath: 'testlib/nope.mp3' }));
    assert.equal(anonymous.status, 401, anonymous.text);

    const login = await post('/api/v1/auth/login', JSON.stringify(ADMIN));
    assert.equal(login.status, 200, login.text);
    const signedIn = await post('/api/v1/db/metadata', JSON.stringify({ filepath: 'testlib/nope.mp3' }), { 'x-access-token': login.body.token });
    assert.equal(signedIn.status, 200, signedIn.text);
  });

  test('a signed-in caller with a broken body gets the same 400', async () => {
    const login = await post('/api/v1/auth/login', JSON.stringify(ADMIN));
    const r = await post('/api/v1/db/metadata', '{"filepath": ', { 'x-access-token': login.body.token });
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(r.body, { error: 'Malformed request body' });
  });
});

describe('the server log', () => {
  test('records rejections at warn — no crash lines, no stacks, none of the request body', async () => {
    const wanted = [
      /^Rejected POST \/api\/v1\/db\/metadata .* — 400: Malformed request body$/,
      /^Rejected POST \/api\/v1\/db\/metadata .* — 413: Request body too large \(limit 1024 bytes\)$/,
      /^Rejected POST \/api\/v1\/db\/metadata .* — 415: Unsupported request charset$/,
      /^Rejected GET \/media\/%E0%A4%A\/x\.mp3 .* — 400: Malformed URL$/,
    ];
    // The file transport writes one JSON object per line, and flushes asynchronously.
    const warned = (raw) => raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.level === 'warn').map((e) => e.message);
    const missing = (raw) => wanted.filter((re) => !warned(raw).some((m) => re.test(m)));
    let raw = '';
    for (let i = 0; i < 50; i++) {
      raw = await readLog();
      if (missing(raw).length === 0) { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(missing(raw).map(String), [], 'warn-level rejection lines missing from the log');
    assert.ok(!/"level":"error"/.test(raw), 'an error-level line was logged');
    assert.ok(!/Server error on route/.test(raw), 'a request was logged as a crash');
    assert.ok(!/SyntaxError|PayloadTooLargeError|UnsupportedMediaTypeError|URIError/.test(raw), 'a parser stack reached the log');
    assert.ok(!raw.includes(MARKER), 'the request body leaked into the log');
  });
});
