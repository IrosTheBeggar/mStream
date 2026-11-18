// m.js's two toasts that show the server's own words for a failed transfer:
// the upload toast (Dropzone's 'error') and the download toast (the hidden
// #downframe an error response loads into). iziToast inserts a toast's
// message as markup, and the server's words can quote a path — 'Cannot read
// playlist "<folder>/<file>" (ENOENT)' — whose names are whatever the music
// came with, so both go in through escapeHtml.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M_SRC = readFileSync(new URL('../../webapp/alpha/m.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const escapeHtml = new Function(`${M_SRC.match(/\nconst entityMap = \{[\s\S]*?\n\};\n/)[0]}
${M_SRC.match(/\nfunction escapeHtml \(string\) \{[\s\S]*?\n\}\n/)[0]}
return escapeHtml;`)();

// A top-level statement of m.js: from `open` to the first `close` after it.
function mSlice(open, close) {
  const start = M_SRC.indexOf(open);
  assert.ok(start >= 0, `m.js no longer has ${JSON.stringify(open.trim())} — update this test`);
  const end = M_SRC.indexOf(close, start);
  assert.ok(end >= 0, `m.js: no end found for ${JSON.stringify(open.trim())} — update this test`);
  return M_SRC.slice(start, end + close.length);
}

const t = (key) => ({ 'toast.uploadFailed': 'Upload Failed', 'toast.downloadFailed': 'Download Failed' })[key] || key;
const MARKUP = '<img src=x onerror="alert(1)">';
const MARKUP_AS_TEXT = '&lt;img src&#x3D;x onerror&#x3D;&quot;alert(1)&quot;&gt;';

// Dropzone's 'error' handler, called with what Dropzone hands it: the file,
// the response body (parsed) or Dropzone's own string, and the xhr.
function uploadError(msg) {
  const toasts = [];
  const handlers = {};
  new Function('myDropzone', 'iziToast', 't', 'escapeHtml', mSlice("\nmyDropzone.on('error', ", '\n});\n'))(
    { on: (name, fn) => { handlers[name] = fn; } }, { error: (o) => toasts.push(o) }, t, escapeHtml);
  assert.equal(typeof handlers.error, 'function');
  handlers.error({}, msg, {});
  return toasts;
}

// watchDownloadErrors over a #downframe whose document holds `body` as its
// text: the toasts its load handler raises.
function downloadError(body) {
  const toasts = [];
  let onLoad = null;
  const frame = {
    contentDocument: { body: { textContent: body, innerHTML: body } },
    addEventListener: (name, fn) => { if (name === 'load') { onLoad = fn; } },
  };
  new Function('document', 'iziToast', 't', 'escapeHtml', mSlice('\n(function watchDownloadErrors() {', '\n})();\n'))(
    { getElementById: (id) => (id === 'downframe' ? frame : null) }, { error: (o) => toasts.push(o) }, t, escapeHtml);
  assert.equal(typeof onLoad, 'function');
  onLoad();
  return toasts;
}

describe('the upload-failed toast (m.js, Dropzone\'s error)', () => {
  test('the server\'s words reach the toast as text', () => {
    const toasts = uploadError({ error: `Library '${MARKUP}' not found` });
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, 'Upload Failed');
    assert.equal(toasts[0].message, `Library &#39;${MARKUP_AS_TEXT}&#39; not found`);
    assert.ok(!/[<>]/.test(toasts[0].message));
  });

  test('plain words read as they did', () => {
    assert.equal(uploadError({ error: 'Uploading Disabled' })[0].message, 'Uploading Disabled');
  });

  test('Dropzone\'s own refusal (a string, no server words): the title alone', () => {
    const toasts = uploadError('File is too big');
    assert.equal(toasts.length, 1);
    assert.equal('message' in toasts[0], false);
  });
});

describe('the download-failed toast (m.js watchDownloadErrors)', () => {
  test('the path the server quotes reaches the toast as text', () => {
    // what POST /api/v1/download/m3u answers for a playlist it cannot read
    const toasts = downloadError(JSON.stringify({ error: `Cannot read playlist "evil/${MARKUP}.m3u" (ENOENT)` }));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, 'Download Failed');
    assert.equal(toasts[0].message, `Cannot read playlist &quot;evil&#x2F;${MARKUP_AS_TEXT}.m3u&quot; (ENOENT)`);
    assert.ok(!/[<>]/.test(toasts[0].message));
  });

  test('a JSON viewer\'s rendering (not parseable): the words it shows, as text', () => {
    const toasts = downloadError('"error": "Cannot read directory <b>x</b> (EACCES)"');
    assert.equal(toasts[0].message, 'Cannot read directory &lt;b&gt;x&lt;&#x2F;b&gt; (EACCES)');
  });

  test('plain words read as they did', () => {
    assert.equal(downloadError('{"error":"Not A Directory"}')[0].message, 'Not A Directory');
  });

  test('an empty frame (the download streamed): no toast', () => {
    assert.equal(downloadError('').length, 0);
  });
});
