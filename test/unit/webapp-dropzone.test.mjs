/**
 * A file dropped on the page (m.js's Dropzone, on document.body): it is
 * uploaded into the explorer's folder, so it is taken only while the
 * column shows that folder (dropzoneOnExplorer), and an upload's end
 * redraws the folder only then.
 *
 * What is pinned:
 *   - a folder on screen takes the drop into its path (a dropped folder's
 *     own path under it), and its upload's end draws the folder again,
 *     every file sent or some;
 *   - the explorer's root list still says it cannot take one;
 *   - refused, with the file let go: a list that is not the explorer
 *     (Albums); a page opened over a folder (an album, from the
 *     now-playing card or the song window's View album); an open .m3u (a
 *     playlist's songs, in the explorer: "add to a folder"); a view that
 *     keeps the stack it found and hides the bar (Auto DJ, Transcode …),
 *     over a folder or over an open .m3u; a connected server's folder (the
 *     upload would land in this server's folder at the same path: "cannot
 *     upload here");
 *   - an upload that ends on one of those says so and draws no folder
 *     over it;
 *   - the check is dropzoneOnExplorer(), right after the Dropzone is made.
 *
 * m.js's own Dropzone block runs over a stub Dropzone that keeps its
 * handlers, as webapp-transfer-toasts.test.mjs runs its 'error' handler.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('webapp', 'alpha', 'm.js');
const EN = JSON.parse(read('webapp', 'locales', 'en.json'));
const BLOCK = SRC.slice(0, SRC.indexOf('////////////////////////////// Global Variables'));

const tEn = (k, p) => {
  let s = typeof EN[k] === 'string' ? EN[k] : k;
  for (const [n, v] of Object.entries(p || {})) { s = s.split(`{{${n}}}`).join(String(v)); }
  return s;
};

const FOLDER = { state: 'fileExplorer', previousScroll: 0, previousSearch: '' };
const ROOT_ENTRY = { state: 'fileExplorer' };
const SAM = { id: 7, name: 'Sam' };

// The page as a drop finds it: the Back stack, the explorer's path,
// whether the bar is up (a view that keeps the stack hides it), and the
// connected server browsed (peerContext), if any.
function makeZone({ stack, dirs = ['demo', 'Boukmanflow'], bar = '', peer = null }) {
  const on = {};
  const seen = { toasts: [], removed: [], drawn: 0 };
  const dz = { files: [], on: (type, fn) => { on[type] = fn; }, removeFile: (f) => seen.removed.push(f), removeAllFiles: () => { dz.files = []; } };
  const els = { directory_bar: { style: { display: bar } }, 'upload-progress-inner': { style: {} } };
  const toast = (kind) => (o) => seen.toasts.push([kind, o.title]);
  new Function('Dropzone', 'document', 'iziToast', 't', 'senddir', 'MSTREAMAPI', 'escapeHtml', 'peerContext', `
    'use strict';
    let programState = ${JSON.stringify(stack)};
    let fileExplorerArray = ${JSON.stringify(dirs)};
    function getFileExplorerPath() { return fileExplorerArray.join('/') + '/'; }
    ${BLOCK}
  `)(function Dropzone() { return dz; }, { body: {}, getElementById: (id) => els[id] || null },
    { error: toast('error'), success: toast('success'), warning: toast('warning') }, tEn,
    () => { seen.drawn++; }, { currentServer: { token: 'TOK' } }, (s) => s, peer);
  const drop = (file = { name: 'zz-drop.txt' }) => { on.addedfile(file); return file; };
  const end = (...statuses) => { dz.files = statuses.map((status) => ({ status })); on.queuecomplete(); };
  return { seen, drop, end };
}

describe('a file dropped on the page', () => {
  test('a folder on screen takes it, into its own path; the upload\'s end draws the folder again', () => {
    const zone = makeZone({ stack: [ROOT_ENTRY, FOLDER] });
    assert.equal(zone.drop().directory, 'demo/Boukmanflow/');
    assert.equal(zone.drop({ name: 'b.mp3', fullPath: 'Live/b.mp3' }).directory, 'demo/Boukmanflow/Live/', 'a dropped folder under it');
    assert.deepEqual(zone.seen.removed, []);
    zone.end('success', 'success');
    assert.deepEqual([zone.seen.toasts, zone.seen.drawn], [[['success', 'Files Uploaded']], 1]);
    zone.end('success', 'error');
    assert.deepEqual([zone.seen.toasts[1], zone.seen.drawn], [['warning', '1 out of 2 were uploaded successfully'], 2]);
    const deeper = makeZone({ stack: [ROOT_ENTRY, FOLDER, FOLDER], dirs: ['demo', 'Boukmanflow', 'Live'] });
    assert.equal(deeper.drop().directory, 'demo/Boukmanflow/Live/');
  });

  test('the explorer\'s root list: it cannot take one, as before', () => {
    const zone = makeZone({ stack: [ROOT_ENTRY], dirs: [] });
    const file = zone.drop();
    assert.equal(file.directory, undefined);
    assert.deepEqual([zone.seen.toasts, zone.seen.removed], [[['error', 'Cannot Upload File Here']], [file]]);
  });

  test('refused where the column shows no folder: the file let go, the toast says where files go', () => {
    const cases = [
      ['Albums', { stack: [{ state: 'allAlbums' }] }, EN['toast.filesExplorerOnly']],
      ['an album opened over the folder', { stack: [ROOT_ENTRY, FOLDER, { state: 'album', name: 'Stim Pack', previousScroll: 0, previousSearch: '' }] }, EN['toast.filesExplorerOnly']],
      ['an artist\'s albums over the folder', { stack: [ROOT_ENTRY, FOLDER, { state: 'artist', name: 'Boukmanflow' }] }, EN['toast.filesExplorerOnly']],
      ['an open .m3u', { stack: [ROOT_ENTRY, FOLDER, { state: 'fileExplorer', m3u: true, previousScroll: 0, previousSearch: '' }], dirs: ['demo', 'Boukmanflow', 'mix.m3u'] }, EN['toast.filesFolderOnly']],
      ['Auto DJ over the folder (the bar hidden)', { stack: [ROOT_ENTRY, FOLDER], bar: 'none' }, EN['toast.filesExplorerOnly']],
      ['Auto DJ over an open .m3u (the bar hidden)', { stack: [ROOT_ENTRY, FOLDER, { state: 'fileExplorer', m3u: true }], dirs: ['demo', 'Boukmanflow', 'mix.m3u'], bar: 'none' }, EN['toast.filesExplorerOnly']],
      ['a connected server\'s folder', { stack: [ROOT_ENTRY, FOLDER, FOLDER], dirs: ['music', 'Rock'], peer: SAM }, EN['toast.cannotUploadHere']],
    ];
    // every page checked, each one that went wrong named
    const wrong = cases.filter(([, page, says]) => {
      const zone = makeZone(page);
      const file = zone.drop();
      const toasts = JSON.stringify(zone.seen.toasts);
      return file.directory !== undefined || toasts !== JSON.stringify([['error', says]]) || zone.seen.removed.length !== 1 || zone.seen.removed[0] !== file;
    }).map(([where, page]) => {
      const zone = makeZone(page);
      const file = zone.drop();
      return `${where}: into ${file.directory}, toasts ${JSON.stringify(zone.seen.toasts)}`;
    });
    assert.deepEqual(wrong, [], 'each refused (no folder for it), the file let go, the toast its page\'s');
    assert.equal(EN['toast.filesFolderOnly'], 'Files can only be added to a folder', 'the .m3u\'s words (en.json)');
  });

  test('an upload that ends where the column shows no folder: said, and no folder drawn over the page', () => {
    for (const page of [
      { stack: [ROOT_ENTRY, FOLDER, { state: 'album', name: 'Stim Pack' }] },
      { stack: [ROOT_ENTRY, FOLDER, { state: 'fileExplorer', m3u: true }], dirs: ['demo', 'Boukmanflow', 'mix.m3u'] },
      { stack: [ROOT_ENTRY, FOLDER], bar: 'none' },
      { stack: [ROOT_ENTRY, FOLDER, FOLDER], dirs: ['music', 'Rock'], peer: SAM },
    ]) {
      const zone = makeZone(page);
      zone.end('success');
      zone.end('success', 'error');
      zone.end('error');
      assert.deepEqual([zone.seen.toasts, zone.seen.drawn],
        [[['success', 'Files Uploaded'], ['warning', '1 out of 2 were uploaded successfully']], 0], JSON.stringify(page));
    }
  });

  test('the check: dropzoneOnExplorer(), right after the Dropzone is made, and every handler asks it', () => {
    assert.match(BLOCK, /^\/\/ Dropzone\nconst myDropzone = new Dropzone\(document\.body, \{[^}]*\n\}\);\n\n(?:\/\/[^\n]*\n)*function dropzoneOnExplorer\(\) \{\n/);
    assert.equal((BLOCK.match(/dropzoneOnExplorer\(\)/g) || []).length, 4, 'defined once, asked by the drop and by both of the end\'s redraws');
    assert.ok(!/programState\[0\]\.state/.test(BLOCK.slice(BLOCK.indexOf('myDropzone.on('))), 'no handler reads the root alone');
  });
});
