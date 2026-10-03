/**
 * SQLite errors reach their route handlers intact on both runtimes — the
 * server-level half of test/db/sqlite-driver-errors.test.mjs.
 *
 * Under Bun the DB goes through the bun:sqlite adapter, which used to replace
 * SQLite errors with "TypeError: Attempted to assign to readonly property."
 * (constraint errors on Bun 1.3, every error on Bun 1.4). Two user-visible
 * results, both pinned here against the real server on each runtime:
 *
 *   - Search: a NUL inside a query token survives parseSearchQuery and makes
 *     the FTS5 MATCH throw "unterminated string". runCategory falls back to
 *     LIKE (combo) or returns nothing (strict fts5) only for an
 *     ERR_SQLITE_ERROR, so the masked error 500'd the whole search.
 *   - Adding a federation peer twice: the route maps the UNIQUE violation to
 *     a 400 by its message; the masked error was a 500.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';
import { buildFederationTicket } from '../../src/state/federation.js';

const post = (server, p, body) => fetch(`${server.baseUrl}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const search = async (server, query, algorithm) => {
  const r = await post(server, '/api/v1/db/search', { search: query, algorithm });
  return { status: r.status, body: await r.json() };
};
const titlesMatching = (body, re) => body.title.filter((t) => re.test(JSON.stringify(t)));

function suite(startOpts) {
  let server;
  before(async () => { server = await startServer({ dlnaMode: 'disabled', ...startOpts }); });
  after(async () => { await server?.stop(); });

  test('control: strict fts5 finds the fixture track "Highway"', async () => {
    const { status, body } = await search(server, 'Highway', 'fts5');
    assert.equal(status, 200);
    assert.equal(titlesMatching(body, /Highway/).length, 1);
  });

  test('combo falls back to LIKE when MATCH throws', async () => {
    const { status, body } = await search(server, 'Highway\u0000', 'combo');
    assert.equal(status, 200, JSON.stringify(body));
    // SQLite's LIKE ends the pattern at the NUL, so the fallback finds it.
    assert.equal(titlesMatching(body, /Highway/).length, 1);
  });

  test('strict fts5 returns no results when MATCH throws', async () => {
    const { status, body } = await search(server, 'Highway\u0000', 'fts5');
    assert.equal(status, 200, JSON.stringify(body));
    for (const k of ['artists', 'albums', 'title', 'files']) {
      assert.deepEqual(body[k], [], `${k} should be empty`);
    }
  });

  test('adding the same federation peer twice is a 400, not a 500', async () => {
    const ticket = buildFederationTicket({ endpointTicket: 'endpointfake', key: 'fedk_dup', serverName: 'Dup' });
    const first = await post(server, '/api/v1/admin/federation/peers', { ticket });
    assert.equal(first.status, 200, await first.text());
    const second = await post(server, '/api/v1/admin/federation/peers', { ticket });
    assert.equal(second.status, 400);
    assert.deepEqual(await second.json(), { error: 'This ticket is already added as a peer' });
  });
}

describe('node', () => suite({}));
describe('bun', { skip: noBun }, () => suite({ execPath: BUN_BIN }));
