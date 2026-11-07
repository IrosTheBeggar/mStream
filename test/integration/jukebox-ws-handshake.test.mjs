/**
 * The jukebox WebSocket handshake (src/api/remote.js verifyClient).
 *
 * With users configured a connection must carry a valid `?token=`, and
 * `?code=` may not name a session that is already connected; an accepted
 * connection's first message hands out a jukebox session token minted for
 * the token's user. Both parameters are read with the WHATWG URL API: under
 * Bun 1.4.4, url.parse() there printed Node's DEP0169 deprecation warning on
 * the first connection, so the server's stderr must stay free of it. (Node 24
 * stays quiet for this call only because node_modules/ws is on the stack,
 * which its DEP0169 check exempts — the bun leg is the one that would catch
 * a regression.)
 *
 * Runs under this Node, and under bun where installed: the shipped binaries
 * are Bun builds, and since Bun 1.4.4 `ws` runs on Bun's native WebSocket.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { startServer } from '../helpers/server.mjs';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';

const OWNER = { username: 'juke-owner', password: 'pw-juke-owner' };

// Resolves with the first message of an accepted connection, or with the
// HTTP status a refused handshake answered.
function connect(baseUrl, query = '') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/${query}`);
    ws.once('message', (m) => resolve({ ws, first: JSON.parse(String(m)) }));
    ws.once('error', (err) => {
      const m = /Unexpected server response: (\d+)/.exec(err.message);
      resolve({ status: m ? Number(m[1]) : err.message });
    });
  });
}

function scenario(execPath) {
  let server;
  let token;
  let stderr = '';
  const open = [];

  before(async () => {
    server = await startServer({ execPath, users: [OWNER], waitForScan: false });
    server.proc.stderr.on('data', (chunk) => { stderr += chunk; });
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    token = (await r.json()).token;
    assert.ok(token, 'login returned a token');
  });

  after(async () => {
    for (const ws of open) { ws.terminate(); }
    await server?.stop();
  });

  test('a connection without a token is refused', async () => {
    assert.equal((await connect(server.baseUrl)).status, 401);
  });

  test('a connection with a bad token is refused', async () => {
    assert.equal((await connect(server.baseUrl, '?token=not-a-jwt')).status, 401);
  });

  test('a valid token is accepted and gets a jukebox session token for its user', async () => {
    const a = await connect(server.baseUrl, `?token=${token}`);
    assert.ok(a.ws, `refused: ${a.status}`);
    open.push(a.ws);
    assert.match(a.first.code, /^[\w-]{8}$/);
    const session = jwt.decode(a.first.token);
    assert.equal(session.username, OWNER.username);
    assert.equal(session.jukebox, true);
  });

  test('?code= naming a connected session is refused; an unused code is not', async () => {
    const a = await connect(server.baseUrl, `?token=${token}`);
    assert.ok(a.ws, `refused: ${a.status}`);
    open.push(a.ws);
    assert.equal((await connect(server.baseUrl, `?token=${token}&code=${a.first.code}`)).status, 401);
    const b = await connect(server.baseUrl, `?token=${token}&code=unused-code`);
    assert.ok(b.ws, `refused: ${b.status}`);
    open.push(b.ws);
  });

  test('the handshake prints no DEP0169 url.parse() warning', () => {
    assert.doesNotMatch(stderr, /DEP0169/);
  });
}

describe('node', () => scenario(process.execPath));
describe('bun', { skip: noBun }, () => scenario(BUN_BIN));
