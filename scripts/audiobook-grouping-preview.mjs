#!/usr/bin/env node
/**
 * Shows how the book rules (src/db/book-rules.js) would group a folder of
 * audiobooks, before the audiobook scanner exists. It walks the folder,
 * reads each audio file's album, track and disc tags, runs the rules and
 * prints the books they form, with the places where a rule made a judgment
 * listed first. See docs/audiobooks-plan.md §6 and §12 (S1).
 *
 * Read-only: no database, no hashing, nothing written. It reads tags only,
 * so it shows grouping and file order, not identity across rescans.
 *
 * The walk follows the scanners' defaults: the always-ignored folders of
 * src/db/scan-ignore.js are skipped, dot entries are read (pass
 * --ignore-dot to skip them, as the two scan options do), and symlinks are
 * not followed. Tags are read with music-metadata directly, without the
 * JavaScript scanner's ID3v2 repair step.
 *
 * Usage:
 *   node scripts/audiobook-grouping-preview.mjs <folder>            # summary + judgments
 *   node scripts/audiobook-grouping-preview.mjs <folder> --books    # … + every book
 *   node scripts/audiobook-grouping-preview.mjs <folder> --files    # … + every file, in playing order
 *   node scripts/audiobook-grouping-preview.mjs <folder> --json     # everything, as JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { isIgnoredDirName, isDotEntry } from '../src/db/scan-ignore.js';
import { albumTagKey, groupBooks, hasTagOrder } from '../src/db/book-rules.js';

// The audio types the server scans by default (supportedAudioFiles, src/state/config.js).
const AUDIO = new Set(['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'm4b', 'opus']);
const LIST_LIMIT = 40;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [folder] = args.filter((a) => !a.startsWith('--'));
const known = ['--books', '--files', '--json', '--ignore-dot', '--help'];
const unknown = [...flags].filter((f) => !known.includes(f));
if (!folder || flags.has('--help') || unknown.length) {
  if (unknown.length) { console.error(`Unknown option: ${unknown.join(', ')}`); }
  console.error('Usage: node scripts/audiobook-grouping-preview.mjs <folder> [--books] [--files] [--json] [--ignore-dot]');
  process.exit(flags.has('--help') ? 0 : 1);
}
const root = path.resolve(folder);

function walk() {
  const audio = [];
  const stats = { folders: 0, otherFiles: 0, unreadableFolders: [] };
  const ignoreDot = flags.has('--ignore-dot');
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      if (rel === '') { console.error(`Cannot read ${root}: ${err.message}`); process.exit(1); }
      stats.unreadableFolders.push(`${rel} (${err.code || err.message})`);
      continue;
    }
    stats.folders++;
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isIgnoredDirName(entry.name) && !(ignoreDot && isDotEntry(entry.name))) { pending.push(child); }
      } else if (entry.isFile()) {
        const isAudio = AUDIO.has(path.extname(entry.name).slice(1).toLowerCase());
        if (isAudio && !(ignoreDot && isDotEntry(entry.name))) { audio.push(child); } else { stats.otherFiles++; }
      }
    }
  }
  return { audio, stats };
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const whole = (v) => (Number.isInteger(v) ? v : null);

async function readTags(relPaths) {
  const files = new Array(relPaths.length);
  const unreadable = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= relPaths.length) { return; }
      let common = {};
      try {
        common = (await parseFile(path.join(root, relPaths[i]), { duration: false, skipCovers: true })).common;
      } catch (err) {
        unreadable.push(`${relPaths[i]} (${err.message})`);
      }
      files[i] = { path: relPaths[i], album: text(common.album), track: whole(common.track?.no), disc: whole(common.disk?.no) };
      if (++done % 500 === 0) { console.error(`  read ${done} of ${relPaths.length} files`); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { files, unreadable };
}

// ── describe each book ───────────────────────────────────────────────────

const { audio, stats } = walk();
const { files, unreadable } = await readTags(audio);
const filePaths = new Set(audio);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const tally = (values) => {
  const counts = new Map();
  for (const v of values) { counts.set(v, (counts.get(v) || 0) + 1); }
  return [...counts].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
};

const books = groupBooks(files).map((book) => {
  // 'tag': one of several books in a folder, told apart by album tag.
  // 'file': a lone file split out the same way. 'folder': the whole folder.
  const kind = book.groupKey ? 'tag' : (filePaths.has(book.path) ? 'file' : 'folder');
  const albumTags = tally(book.files.map((f) => f.album).filter(Boolean));
  const tracked = book.files.filter((f) => f.track !== null).length;
  let order = null;
  if (book.files.length > 1) {
    order = hasTagOrder(book.files) ? 'tags'
      : (tracked === 0 ? 'path, no track tags'
        : (tracked < book.files.length ? 'path, track tags incomplete' : 'path, track tags repeat'));
  }
  const name = book.path === '' ? '(library root)' : baseOf(book.path);
  return {
    path: book.path,
    groupKey: book.groupKey,
    kind,
    container: kind === 'file' ? dirOf(book.path) : book.path,
    title: albumTags.length ? albumTags[0][0] : (kind === 'file' ? name.replace(/\.[^.]+$/, '') : name),
    fileCount: book.files.length,
    order,
    albumTags,
    albumKeys: new Set(book.files.map((f) => albumTagKey(f.album)).filter(Boolean)).size,
    files: book.files.map((f) => f.path),
  };
});

const multi = books.filter((b) => b.fileCount > 1);
const merged = books.filter((b) => b.kind === 'folder' && b.albumKeys > 1).sort((a, b) => b.fileCount - a.fileCount);
const untagged = books.filter((b) => b.kind === 'folder' && b.fileCount > 1 && b.albumKeys === 0)
  .sort((a, b) => b.fileCount - a.fileCount);
const splitFolders = new Map();
for (const b of books.filter((x) => x.kind !== 'folder')) {
  if (!splitFolders.has(b.container)) { splitFolders.set(b.container, []); }
  splitFolders.get(b.container).push(b);
}
const pathOrdered = multi.filter((b) => b.order !== 'tags' && b.order !== 'path, no track tags');
const rootDiscs = books.find((b) => b.kind === 'folder' && b.path === '');

if (flags.has('--json')) {
  console.log(JSON.stringify({
    root,
    folders: stats.folders,
    audioFiles: audio.length,
    otherFiles: stats.otherFiles,
    unreadableFolders: stats.unreadableFolders,
    unreadableTags: unreadable,
    books: books.map(({ albumKeys: _n, ...b }) => b),
  }, null, 2));
  process.exit(0);
}

// ── print ────────────────────────────────────────────────────────────────

const show = (p) => (p === '' ? '(library root)' : p);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tags = (b) => b.albumTags.map(([tag, n]) => `"${tag}" ×${n}`).join(', ');
function section(title, rows, line) {
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, LIST_LIMIT)) { console.log(`  ${line(row)}`); }
  if (rows.length > LIST_LIMIT) { console.log(`  … and ${rows.length - LIST_LIMIT} more (--json has all of them)`); }
}

console.log(`Audiobook grouping preview: ${root}`);
console.log(`  ${plural(stats.folders, 'folder')}, ${plural(audio.length, 'audio file')}, ${plural(stats.otherFiles, 'other file')} skipped`);
console.log(`  ${plural(books.length, 'book')}: ${books.filter((b) => b.kind === 'folder').length} whole folders, `
  + `${books.filter((b) => b.kind === 'tag').length} split out by album tag, ${books.filter((b) => b.kind === 'file').length} lone files`);
console.log(`  file order in the ${plural(multi.length, 'book')} of two or more files: `
  + `${multi.filter((b) => b.order === 'tags').length} by tags, ${multi.filter((b) => b.order !== 'tags').length} by path`);
if (stats.unreadableFolders.length) { section('FOLDERS THAT COULD NOT BE LISTED', stats.unreadableFolders, (r) => r); }
if (unreadable.length) { section('FILES WHOSE TAGS COULD NOT BE READ (treated as untagged)', unreadable, (r) => r); }

console.log('\nWhere a rule made a judgment:');
if (rootDiscs) { console.log(`\nDisc folders directly under the library root were read as one book of ${plural(rootDiscs.fileCount, 'file')}.`); }
section('MERGED: one folder, several album tags, kept as one book', merged,
  (b) => `${show(b.path)}: ${plural(b.fileCount, 'file')}; ${tags(b)}`);
section('UNTAGGED: no album tag on any file, the folder kept as one book', untagged,
  (b) => `${show(b.path)}: ${plural(b.fileCount, 'file')}`);
section('SPLIT: one folder read as several books, by album tag', [...splitFolders],
  ([dir, list]) => `${show(dir)}: ${plural(list.reduce((n, b) => n + b.fileCount, 0), 'file')} → ${plural(list.length, 'book')}`
    + ` (${list.slice(0, 6).map((b) => `"${b.title}"`).join(', ')}${list.length > 6 ? ', …' : ''})`);
section('ORDER: path order used although some files carry track tags', pathOrdered,
  (b) => `${show(b.path)}${b.groupKey ? ` #${b.groupKey}` : ''}: ${plural(b.fileCount, 'file')}; ${b.order}`);

if (flags.has('--books') || flags.has('--files')) {
  console.log(`\nBOOKS (${books.length})`);
  for (const b of books) {
    console.log(`  [${b.kind}] ${show(b.path)}${b.groupKey ? ` #${b.groupKey}` : ''}: "${b.title}", ${plural(b.fileCount, 'file')}${b.order ? `, ${b.order}` : ''}`);
    if (flags.has('--files')) { for (const f of b.files) { console.log(`      ${f}`); } }
  }
} else {
  console.log('\nPass --books to list every book, --files to list their files in playing order.');
}
