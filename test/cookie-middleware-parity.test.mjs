// Behaviour tests for the inline cookie middleware in src/server.js.
// We can't import the middleware directly (it's defined inline inside
// serveIt), so we re-implement the parser as a pure function here. The
// test cases lock in the behaviour we audited against cookie-parser
// 1.4.7 for the cases mStream cares about. Any change to the inline
// middleware should be mirrored in `parseInline` below.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

function parseInline(header) {
  const cookies = Object.create(null);
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in cookies) continue;
    let v = part.slice(eq + 1).trim();
    if (v.length >= 2 && v.charCodeAt(0) === 0x22 && v.charCodeAt(v.length - 1) === 0x22) {
      v = v.slice(1, -1);
    }
    if (v.indexOf('%') !== -1) {
      try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    }
    cookies[k] = v;
  }
  return cookies;
}

// Each case is [header, expected]. Expected values match cookie-parser
// 1.4.7's output for the same input, audited against its source on
// 2026-04-28.
const cases = [
  ['empty header',                undefined,                                              {}],
  ['empty string',                '',                                                     {}],
  ['single cookie',               'x-access-token=eyJhbGciOiJIUzI1NiJ9.payload.sig',      { 'x-access-token': 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }],
  ['JWT with == padding',         'token=abc.def.ghi==',                                  { token: 'abc.def.ghi==' }],
  ['multiple cookies',            'a=1; b=2; c=3',                                        { a: '1', b: '2', c: '3' }],
  ['extra whitespace + tabs',     '  a = 1 ;\tb=2 ; c =3',                                { a: '1', b: '2', c: '3' }],
  ['leading semicolon',           ';a=1;b=2',                                             { a: '1', b: '2' }],
  ['trailing semicolon',          'a=1;b=2;',                                             { a: '1', b: '2' }],
  ['duplicate key (first wins)',  'a=first; a=second',                                    { a: 'first' }],
  ['quoted value',                'a="hello"',                                            { a: 'hello' }],
  ['quoted with spaces',          'a="hello world"',                                      { a: 'hello world' }],
  ['percent-encoded value',       'a=hello%20world',                                      { a: 'hello world' }],
  ['no equals',                   'foo',                                                  {}],
  ['empty value',                 'a=',                                                   { a: '' }],
  ['equals in value',             'a=b=c=d',                                              { a: 'b=c=d' }],
  ['plus sign not decoded',       'a=b+c',                                                { a: 'b+c' }],
  ['dotted cookie name',          'a.b.c=value',                                          { 'a.b.c': 'value' }],
  ['real JWT cookie',             'x-access-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InBhdWwiLCJpYXQiOjE3NzczNzc4ODd9.OyNpSiWYHaEPUSIaPfnGbyDM_dB_OKerrUndYJmJU2I',
                                  { 'x-access-token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InBhdWwiLCJpYXQiOjE3NzczNzc4ODd9.OyNpSiWYHaEPUSIaPfnGbyDM_dB_OKerrUndYJmJU2I' }],
  ['empty-name part is skipped', '=orphan;a=1',                                           { a: '1' }],
];

test('inline cookie middleware: parser cases', async (t) => {
  for (const [label, header, expected] of cases) {
    await t.test(label, () => {
      const got = parseInline(header);
      const gotKeys = Object.keys(got).sort();
      const expectedKeys = Object.keys(expected).sort();
      assert.deepEqual(gotKeys, expectedKeys,
        `key set: got=${JSON.stringify(gotKeys)} expected=${JSON.stringify(expectedKeys)}`);
      for (const k of gotKeys) {
        assert.equal(got[k], expected[k],
          `value for "${k}": got=${JSON.stringify(got[k])} expected=${JSON.stringify(expected[k])}`);
      }
    });
  }
});

test('malformed percent-encoding falls back to raw value', () => {
  // %E0%A4%A is an incomplete UTF-8 sequence; decodeURIComponent throws
  // URIError. cookie-parser swallows the error and returns the raw
  // value. Our middleware does the same.
  const got = parseInline('a=%E0%A4%A');
  assert.equal(got.a, '%E0%A4%A');
});

test('null-prototype object: Object.prototype keys not inherited', () => {
  const cookies = parseInline('a=1');
  assert.equal(Object.getPrototypeOf(cookies), null);
  // 'toString' is on Object.prototype but not on a null-proto object,
  // so it is NOT considered "in cookies" until explicitly set.
  assert.equal('toString' in cookies, false);
});

test('cookie name colliding with Object.prototype gets stored normally', () => {
  // With a plain `{}`, parsing `toString=foo` would have hit the
  // `k in cookies` guard and silently dropped the cookie because
  // 'toString' is inherited. Object.create(null) prevents that.
  const cookies = parseInline('toString=foo');
  assert.equal(cookies.toString, 'foo');
});

test('JWT base64url chars survive round-trip', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1IjoicCJ9.A_B-C.signature==';
  const cookies = parseInline(`x-access-token=${jwt}`);
  assert.equal(cookies['x-access-token'], jwt);
});
