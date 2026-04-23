/**
 * Bundled Subsonic UI (Airsonic Refix) integration test.
 *
 * When `config.ui === 'subsonic'` the server swaps its static dir to
 * `webapp/subsonic/` — a pre-built Airsonic Refix bundle that speaks to
 * our own /rest/* endpoints. This suite guards the wiring:
 *
 *   - `/` serves the Refix shell (not the mStream `/login` redirect)
 *   - `/servers`, `/albums/<id>`, and other history-mode SPA routes
 *     resolve to index.html without hitting the auth wall
 *   - `/env.js` is served so Refix picks up SERVER_URL="" (same origin)
 *   - `/rest/*` and `/api/v1/*` are NOT shadowed by the SPA fallback
 *   - unknown Subsonic methods still return a Subsonic error envelope,
 *     not a 200 HTML page (would otherwise confuse the client)
 *
 * Auth flow: Refix prompts the user for server URL + creds on first
 * load. It calls /rest/ping with plaintext/enc-hex creds, persists to
 * localStorage, then drives getArtists / getAlbumList2 / etc. We can't
 * exercise the actual login form headlessly here, but the endpoints
 * it'd call are covered by test/subsonic-client-flow.test.mjs.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const USER = { username: 'subui-admin', password: 'pw-subui-admin' };
let server;

before(async () => {
  server = await startServer({
    ui:          'subsonic',
    dlnaMode:    'disabled',
    subsonicMode:'same-port',
    users:       [{ ...USER, admin: true }],
  });
});

after(async () => { if (server) { await server.stop(); } });

async function head(path) {
  const r = await fetch(server.baseUrl + path);
  return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.text() };
}

describe('Bundled Subsonic UI (Airsonic Refix)', () => {
  test('GET / serves the Refix shell (not a /login redirect)', async () => {
    const r = await head('/');
    assert.equal(r.status, 200);
    assert.match(r.ct, /text\/html/);
    // The bundled index.html identifies itself as "Airsonic (refix)".
    assert.match(r.body, /<title>Airsonic \(refix\)<\/title>/);
  });

  test('GET /login serves the default login page (admin loop-break)', async () => {
    // Previously /login redirected to / on the theory that Refix owns
    // its own in-SPA login form. But that created a dead-end for the
    // admin flow: an unauthenticated /admin hit redirects to /login,
    // and /login → / landed the operator on the Refix shell with no
    // way back into /admin (Refix has no admin UI of its own). The
    // default /login + /admin trees are now mounted under ui=subsonic
    // so the auth round-trip can complete. Refix itself never
    // navigates to /login — it calls /rest/ping from inside the SPA —
    // so this change is invisible to the SPA flow.
    const r = await fetch(server.baseUrl + '/login', { redirect: 'follow' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /<title>Login<\/title>/);
  });

  test('GET /admin redirects unauth traffic to /login (admin loop-break)', async () => {
    // Same rationale as the /login test above. Without explicit mounts
    // of webapp/admin/ and webapp/login/ under ui=subsonic, the SPA
    // fallback would swallow /admin and serve the Refix shell.
    const r = await fetch(server.baseUrl + '/admin', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });

  test('GET /shared-assets/js/lib/vue2.js serves the core vendor bundle', async () => {
    // The admin + login + shared pages load vendor libs (Vue, axios,
    // iziToast, materialize) via absolute /shared-assets/ URLs. Under
    // ui=subsonic, the UI root mount serves webapp/subsonic/assets/
    // (Airsonic Refix's Vue 3 bundle) at /assets/ — a name collision
    // that would break the admin page if it still referenced
    // /assets/. /shared-assets/ is unambiguous: it points at
    // webapp/assets/ regardless of which UI is active.
    const r = await head('/shared-assets/js/lib/vue2.js');
    assert.equal(r.status, 200);
    assert.match(r.body, /Vue/);
  });

  test('GET /locales/en.json serves the core i18n dictionary', async () => {
    // Same rationale as /shared-assets — the admin + login pages set
    // <meta name="i18n-base" content="/"> so i18n.js fetches
    // /locales/<lang>.json, which must resolve to webapp/locales/
    // regardless of which UI root is active.
    const r = await head('/locales/en.json');
    assert.equal(r.status, 200);
    // en.json is a JSON object with at least one key.
    const parsed = JSON.parse(r.body);
    assert.equal(typeof parsed, 'object');
    assert.ok(Object.keys(parsed).length > 0);
  });

  test('GET /admin/index.html 200s (serves the default admin HTML)', async () => {
    // The gate at /admin (no slash) redirects unauth traffic to /login;
    // /admin/index.html is the direct request the login page eventually
    // sends the operator to after auth. Its Accept header claims HTML
    // so the SPA fallback mustn't swallow it.
    const r = await head('/admin/index.html');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>mStream Admin<\/title>/);
    // Crucial: the loaded HTML must reference /shared-assets/ for its
    // deps, not the old ../assets/ (which would resolve into Refix's
    // bundle under ui=subsonic and leave the page broken).
    assert.match(r.body, /\/shared-assets\//);
    assert.ok(!/\.\.\/assets\//.test(r.body),
      'admin HTML should no longer reference ../assets/ (would resolve into Refix bundle under ui=subsonic)');
  });

  test('GET /env.js serves the SERVER_URL config shim', async () => {
    const r = await head('/env.js');
    assert.equal(r.status, 200);
    assert.match(r.body, /SERVER_URL/);
    // Empty value = use current origin, which is what we want.
    assert.match(r.body, /SERVER_URL:\s*""/);
  });

  test('GET /manifest.webmanifest + /icon.svg served', async () => {
    const m = await head('/manifest.webmanifest');
    assert.equal(m.status, 200);
    const i = await head('/icon.svg');
    assert.equal(i.status, 200);
  });

  for (const spa of ['/servers', '/albums/xyz', '/artists/abc', '/playlists/42', '/search']) {
    test(`GET ${spa} (history-mode SPA route) returns the shell`, async () => {
      const r = await fetch(server.baseUrl + spa, { headers: { Accept: 'text/html' } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      const body = await r.text();
      assert.match(body, /id="app"/);  // Refix root element
    });
  }

  test('POST /rest/ping still reaches the Subsonic handler (not the SPA)', async () => {
    const url = new URL(server.baseUrl + '/rest/ping');
    url.searchParams.set('u', USER.username);
    url.searchParams.set('p', USER.password);
    url.searchParams.set('f', 'json');
    const r = await fetch(url);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'ok');
  });

  test('GET /rest/<unknown-method> still returns a Subsonic error envelope', async () => {
    const url = new URL(server.baseUrl + '/rest/notARealMethod');
    url.searchParams.set('u', USER.username);
    url.searchParams.set('p', USER.password);
    url.searchParams.set('f', 'json');
    const r = await fetch(url);
    const j = await r.json();
    // Spec code 70 ("not found") was chosen for unknown methods — the
    // important thing here is that the SPA fallback didn't swallow it.
    assert.equal(j['subsonic-response'].status, 'failed');
    assert.equal(j['subsonic-response'].error.code, 70);
  });

  test('GET /api/v1/db/status still 401s unauthenticated (SPA fallback skips /api/)', async () => {
    const r = await fetch(server.baseUrl + '/api/v1/db/status');
    // We just need to confirm the SPA fallback didn't hand back HTML —
    // 401 / 403 / 200 are all fine; the shape is JSON.
    assert.notEqual(r.status, 200);
    assert.ok(['401','403','404'].includes(String(r.status)),
      `expected 401/403/404, got ${r.status}`);
    assert.doesNotMatch(r.headers.get('content-type') || '', /text\/html/);
  });

  test('Non-HTML Accept header on a missing path falls through to normal 404', async () => {
    // Mirrors what an image loader or fetch('/some.json') does — the
    // fallback must not return text/html since the caller wouldn't
    // parse it. Refix relies on this for /rest/* error handling.
    const r = await fetch(server.baseUrl + '/does-not-exist.json', {
      headers: { Accept: 'application/json' },
    });
    assert.notEqual(r.status, 200);
    assert.doesNotMatch(r.headers.get('content-type') || '', /text\/html/);
  });
});

// ── Round-4: ui='subsonic' requires subsonic=same-port ───────────────────
//
// The bundled Refix SPA is configured (env.js SERVER_URL="") to talk
// to its own origin. If Subsonic is disabled or on a separate port,
// every /rest/* call from the SPA 404s silently. Config validation
// must auto-correct this at boot, and the admin endpoint that
// changes Subsonic mode must refuse to break it while ui=subsonic.

describe('ui=subsonic auto-enables same-port Subsonic', () => {
  test('GET /rest/ping still reaches the Subsonic handler (mode was auto-coerced)', async () => {
    // The harness set subsonicMode='same-port' so this is a green
    // path. The NEXT test covers the auto-coerce edge case.
    const r = await fetch(server.baseUrl + '/rest/ping?f=json&u=' + USER.username + '&p=' + USER.password);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'ok');
  });

  test('admin /api/v1/admin/subsonic/mode refuses to break the Refix UI', async () => {
    // Get an admin token.
    const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(USER),
    });
    const { token } = await login.json();

    // Try to flip Subsonic to 'disabled' while ui='subsonic'. Must
    // be rejected with a clear 403 so the operator doesn't silently
    // break their own UI.
    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ mode: 'disabled' }),
    });
    assert.ok([403, 400].includes(r.status),
      `expected 403 for ui-breaking mode change, got ${r.status}`);
    const body = await r.json();
    assert.match(body.error || '', /ui.*subsonic|Refix/i,
      `error message should mention the UI constraint, got: ${body.error}`);
  });
});

// A dedicated mini-harness that boots with subsonicMode='disabled'
// and verifies the config validator auto-flips it to same-port when
// ui='subsonic'. If we skipped that coercion the boot would succeed
// but the UI would be broken. Separate `describe` with its own server
// because we need a different config shape than the main harness.

import { startServer as startServer2 } from './helpers/server.mjs';

describe('ui=subsonic auto-coerces subsonic.mode at boot', () => {
  let coercedServer;
  before(async () => {
    coercedServer = await startServer2({
      ui:           'subsonic',
      dlnaMode:     'disabled',
      subsonicMode: 'disabled',      // intentionally broken — validator must fix this
      users:        [{ username: 'boot-coerce', password: 'pw-boot', admin: true }],
    });
  });
  after(async () => { if (coercedServer) { await coercedServer.stop(); } });

  test('/rest/ping works even though the config said mode=disabled', async () => {
    // If coercion worked, Subsonic is on same-port and ping answers.
    // If not, the URL 404s or the SPA fallback intercepts.
    const r = await fetch(`${coercedServer.baseUrl}/rest/ping?f=json&u=boot-coerce&p=pw-boot`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'ok');
  });
});
