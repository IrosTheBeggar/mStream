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
 *   - the check is dropzoneOnExplorer(), right after the Dropzone is made;
 *   - the bar's Upload and Create Folder, which write into that folder
 *     too, show only while it is on screen: a page opened over it (an
 *     album from the now-playing card, an open .m3u) hides them, their
 *     windows stay shut, and a Create Folder window left open makes
 *     nothing in the folder under it and closes, saying so; back on the
 *     folder they show again and open on it, a pick going into it; as
 *     before, neither at the root list, Create Folder off by the
 *     server's switch, and neither on a connected server's folder or
 *     under a view that hides the bar.
 *
 * m.js's own Dropzone block runs over a stub Dropzone that keeps its
 * handlers, as webapp-transfer-toasts.test.mjs runs its 'error' handler.
 * For the bar, the column's own code runs with it (makeColumn): the
 * explorer's listing, the pages opened over a folder, Back, the bar's
 * refresh and the two windows, over a server stub that answers at once.
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

// m.js's top-level functions as they stand (webapp-ytdl-ui.test.mjs's
// findFn).
function findFn(name) {
  const lines = SRC.split('\n');
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) { if (lines[i] === '}') { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of ${name}()`);
}

const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setImmediate(r)); } };
const IN_FOLDER = ['demo', 'ALM', 'Free Instrumentals Vol.1'];
const elWith = (attrs) => ({ getAttribute: (n) => (n in attrs ? attrs[n] : null), hasAttribute: (n) => n in attrs });
// the now-playing card's album link (vp.js goToAlbum), an .m3u's row
const nowPlayingAlbum = () => elWith({ 'data-album': 'Free Instrumentals Vol.1', 'data-year': '2014' });
const m3uRow = () => elWith({ 'data-directory': 'mix.m3u' });

// The bar's ways into the folder, hidden until a folder shows them
// (index.html), and every element the column's code below reaches.
const WAYS_IN = ['upload_btn', 'mkdir_btn', 'ytdl_btn', 'ytdl_strip'];
const COLUMN_IDS = ['directory_bar', 'directoryName', 'filelist', 'localSearchBar', 'search_folders', 'upload-progress-inner',
  'upload_filepath', 'upload_file_input', 'torrent_file_input', 'torrent_magnet', 'torrent_directory', 'torrent_file_name',
  'torrent_destination_preview', 'torrent_preflight_msg', 'torrent_rename_root', 'mkdir_filepath', 'mkdir_name', 'mkdir_submit', ...WAYS_IN];
const COLUMN_FNS = ['getFileExplorerPath', 'senddir', 'handleDirClick', 'onFilePlaylistClick', 'getAlbumsOnClick', 'getAlbumSongs', 'getArtistz',
  'onBackButton', 'ytdlServerAllows', 'ytdlAllowed', 'ytdlExplorerFolder', 'ytdlRefreshExplorer',
  'openUploadModal', 'handleFileUpload', 'openMkdirModal', 'submitMkdir'];
const LIBRARIES = { path: '/', directories: [{ name: 'demo' }, { name: 'other' }], files: [] };

// The column on m.js's own code: the Dropzone block, the explorer's
// listing (senddir), the pages a folder can have opened over it, Back,
// the bar's refresh (ytdlRefreshExplorer: the ping, a job's change and
// every listing call it too) and the Upload and Create Folder windows. It
// starts on `dirs` (this server's, or `peer`'s), the bar up; the server
// answers at once, and what is asked of it is kept in order (`asked`: a
// folder's listing, an .m3u's songs, an album's, an artist's page, a new
// folder), every window opened (`opened`).
function makeColumn({ dirs = IN_FOLDER, peer = null, server = {} } = {}) {
  const asked = [];
  const opened = [];
  const seen = { toasts: [], removed: [], closed: 0 };
  const node = () => {
    const classes = new Set();
    return {
      classes, style: { display: '' }, value: '', textContent: '', innerHTML: '', scrollTop: 0, dataset: {},
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c), toggle: (c, on) => { if (on) { classes.add(c); } else { classes.delete(c); } },
      },
      dispatchEvent() {},
    };
  };
  const els = Object.fromEntries(COLUMN_IDS.map((id) => [id, node()]));
  WAYS_IN.forEach((id) => els[id].classes.add('super-hide'));
  const listing = (dir) => (dir === '~' ? LIBRARIES : { path: `/${dir}`, directories: [], files: [] });
  const dz = { files: [], on: (type, fn) => { dz.handlers[type] = fn; }, handlers: {} };
  // as Dropzone's own addFile: the file is taken, then 'addedfile'
  dz.addFile = (file) => { dz.files.push(file); dz.handlers.addedfile(file); };
  dz.removeFile = (file) => { seen.removed.push(file); };
  dz.removeAllFiles = () => { dz.files = []; };
  const toast = (kind) => (o) => seen.toasts.push([kind, o.title]);
  const noop = () => {};
  const globals = {
    Dropzone: function Dropzone() { return dz; },
    document: { body: {}, getElementById: (id) => els[id] || null },
    iziToast: { error: toast('error'), success: toast('success'), warning: toast('warning') },
    t: tEn,
    escapeHtml: (s) => String(s),
    MSTREAMAPI: {
      currentServer: { token: 'TOK', ytdl: 1, noUpload: false, transcode: true, vpaths: ['demo', 'other'], noMkdir: false, ...server },
      dirparser: (dir) => { asked.push(['folder', dir]); return Promise.resolve(listing(dir)); },
      loadFileplaylist: (dir) => { asked.push(['m3u', dir]); return Promise.resolve({ files: [], skipped: 0 }); },
      mkdir: (dir) => { asked.push(['mkdir', dir]); return Promise.resolve({}); },
      peer: { dirparser: (id, dir) => { asked.push(['folder', dir]); return Promise.resolve(listing(dir)); } },
    },
    browseApi: (name) => { asked.push([name]); return Promise.resolve([]); },
    // the artist's page draws the column's chrome again
    // (setBrowserRootPanel): the bar's ways in go
    getArtistsAlbums: (name) => { asked.push(['artist', name]); WAYS_IN.forEach((id) => els[id].classes.add('super-hide')); return Promise.resolve(); },
    myModal: { open: (id) => { opened.push(id); }, close: () => { seen.closed++; } },
    // a call that failed is the test's own failure
    boilerplateFailure: (err) => { throw err; },
    // a new list starts at its top
    printdir: () => { els.filelist.scrollTop = 0; },
    getLoadingSvg: () => 'LOADING',
    switchUploadTab: noop, browseKeepReset: noop, browseKeepDrawn: noop, browseKeepBack: () => false, keepGateFor: () => Promise.resolve(),
    discoveryHideHead: noop, hideMoodFilters: noop, albumSongsBody: () => ({}), createMusicFileHtml: () => '', browseAlbumHead: noop,
    YTDLUI: { renderStrip: noop },
    Event: class { constructor(type) { this.type = type; } },
  };
  const S = new Function(...Object.keys(globals), `
    'use strict';
    let peerContext = ${JSON.stringify(peer)};
    let programState = ${JSON.stringify([ROOT_ENTRY, ...dirs.map(() => FOLDER)])};
    let fileExplorerArray = ${JSON.stringify(dirs)};
    let currentBrowsingList = [];
    let browseGeneration = 0;
    // every row here is the page's own server's
    function adoptPeer() { return peerContext; }
    ${BLOCK}
    ${COLUMN_FNS.map(findFn).join('\n')}
    return {
      ${COLUMN_FNS.join(', ')},
      dirs: () => fileExplorerArray.slice(),
      state: () => programState.map((s) => s.state + (s.m3u === true ? ' .m3u' : '')),
    };
  `)(...Object.values(globals));
  // the bar's Upload and Create Folder that show; the column's last list
  const shown = () => ['upload_btn', 'mkdir_btn'].filter((id) => !els[id].classes.has('super-hide'));
  const listed = () => asked.filter(([kind]) => kind === 'folder' || kind === 'm3u').pop();
  return { S, els, asked, opened, seen, shown, listed };
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

describe('the bar\'s Upload and Create Folder', () => {
  test('a page opened over the folder hides them, their windows stay shut, and Create Folder\'s left open makes nothing in the folder under it and closes; back on the folder they show again and open on it', async () => {
    const pages = [
      ['an album from the now-playing card', (c) => c.S.getAlbumsOnClick(nowPlayingAlbum())],
      ['an open .m3u', (c) => c.S.onFilePlaylistClick(m3uRow())],
    ];
    for (const [page, open] of pages) {
      for (const [server, ways] of [[{}, ['upload_btn', 'mkdir_btn']], [{ noMkdir: true }, ['upload_btn']]]) {
        const where = `${page}${server.noMkdir ? ', Create Folder switched off' : ''}`;
        const c = makeColumn({ server });
        await c.S.senddir();
        assert.deepEqual(c.shown(), ways, `${where}: the folder on screen`);
        await open(c);
        await settle();
        assert.deepEqual(c.shown(), [], `${where}: over it, neither`);
        c.asked.length = 0;
        c.S.openUploadModal();
        c.S.openMkdirModal();
        assert.deepEqual(c.opened, [], `${where}: neither window opens`);
        // Create Folder's window left open from the folder (a toast's
        // Details takes the column from under it): its Create
        c.els.mkdir_name.value = 'Live';
        await c.S.submitMkdir();
        assert.deepEqual([c.asked, c.seen.closed, c.seen.toasts], [[], 1, [['error', EN['toast.folderCreateFailed']]]],
          `${where}: Create makes no folder in the folder under it nor draws one over the page, and its window closes, saying so`);
        c.seen.toasts.length = 0;

        await c.S.onBackButton();
        assert.deepEqual(c.shown(), ways, `${where}: back on the folder, they show again`);
        if (server.noMkdir) { continue; }
        const [, folder] = c.listed();
        c.S.openUploadModal();
        assert.deepEqual([c.opened.pop(), c.els.upload_filepath.textContent], ['#uploadModal', folder], `${where}: Upload opens on the folder on screen`);
        const pick = { name: 'zz-pick.mp3' };
        c.S.handleFileUpload([pick]);
        assert.deepEqual([pick.directory, c.seen.removed, c.seen.toasts], [folder, [], []], `${where}: its pick goes into that folder`);
        c.S.openMkdirModal();
        assert.deepEqual([c.opened.pop(), c.els.mkdir_filepath.textContent], ['#mkdirModal', folder], `${where}: Create Folder too`);
        c.asked.length = 0;
        c.els.mkdir_name.value = 'Live';
        await c.S.submitMkdir();
        assert.deepEqual(c.asked, [['mkdir', `${folder}Live`], ['folder', folder]], `${where}: made in it, and the folder listed again`);
      }
    }
  });

  test('as before: neither at the root list, on a connected server\'s folder (a page over it, Back to it) or under a view that hides the bar', async () => {
    const root = makeColumn({ dirs: [] });
    await root.S.senddir(true);
    assert.deepEqual([root.listed(), root.shown()], [['folder', '~'], []], 'the root list: the libraries');

    const sam = makeColumn({ dirs: ['music', 'Rock'], peer: SAM });
    const writes = () => WAYS_IN.slice(0, 3).filter((id) => !sam.els[id].classes.has('super-hide'));
    await sam.S.senddir();
    assert.deepEqual([sam.listed(), writes()], [['folder', 'music/Rock/'], []], 'a connected server\'s folder takes no writes: no Upload, Create Folder or Add from YouTube here');
    sam.S.getAlbumsOnClick(nowPlayingAlbum());
    await settle();
    assert.deepEqual(writes(), [], 'an album over it');
    await sam.S.onBackButton();
    assert.deepEqual(writes(), [], 'back on its folder');

    // Auto DJ, Transcode and the like keep the stack and hide the bar,
    // its buttons with it (setBrowserRootPanel(…, false)); the ping or a
    // job's change refreshes the bar meanwhile.
    const dj = makeColumn();
    await dj.S.senddir();
    dj.els.directory_bar.style.display = 'none';
    WAYS_IN.forEach((id) => dj.els[id].classes.add('super-hide'));
    dj.S.ytdlRefreshExplorer();
    assert.deepEqual(dj.shown(), [], 'a view that hides the bar');
  });
});
