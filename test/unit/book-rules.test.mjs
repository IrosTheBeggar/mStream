/**
 * The book rules (src/db/book-rules.js) — which files form one audiobook,
 * in what order they play, and which stored book a rescan's files belong to.
 *
 * The two "plan" suites are the tables in docs/audiobooks-plan.md: the 19
 * folder layouts of §6.3 and the 15 rescan scenarios of §7.4, one test per
 * row, in the plan's order. Four rows are known misses. They are asserted as
 * they are, so that changing one is a deliberate act, not a side effect.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHELF_MAX_FILES_PER_BOOK, albumTagKey, comparePaths, groupBooks, hasTagOrder,
  isDiscFolderName, matchBooks, orderFiles,
} from '../../src/db/book-rules.js';

// ── fixtures ─────────────────────────────────────────────────────────────

let hashes = 0;
const file = (path, album, track, disc) => ({
  path, album: album ?? null, track: track ?? null, disc: disc ?? null, hash: `h${++hashes}`,
});
const pad = (n) => String(n).padStart(2, '0');
// n files "01.mp3 … n.mp3" in dir, tracks 1 … n unless opts.noTrack.
const many = (dir, n, album, opts = {}) => Array.from({ length: n }, (_v, i) =>
  file(`${dir}/${pad(i + 1 + (opts.from ?? 0))}.mp3`, album, opts.noTrack ? null : i + 1, opts.disc));

// [path, groupKey, file count] per book: what a layout test compares.
const shape = (books) => books.map((b) => [b.path, b.groupKey, b.files.length]);
const paths = (files) => files.map((f) => f.path);

// A seeded shuffle, so "any input order" tests are repeatable.
function shuffled(list, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A library as the scanner would keep it between scans: scan(files) groups,
// matches against what the last scan left, and stores the answer.
function library(libraryId = 1) {
  let stored = [];
  let ids = 0;
  const newId = () => `b${++ids}`;
  return {
    scan(files) {
      const result = matchBooks(stored, groupBooks(files), { libraryId, newId });
      stored = [
        ...result.books.map((b) => ({
          id: b.id, libraryId, path: b.group.path, groupKey: b.group.groupKey,
          hashes: b.group.files.map((f) => f.hash), missing: false, mergedInto: null,
        })),
        ...result.missing.map((m) => ({ ...m.stored, missing: true, mergedInto: m.mergedInto })),
      ];
      return result;
    },
    // The live book at an address, or undefined.
    at(path, groupKey = '') {
      return stored.find((b) => !b.missing && b.path === path && b.groupKey === groupKey);
    },
    book(id) { return stored.find((b) => b.id === id); },
    live() { return stored.filter((b) => !b.missing); },
    get stored() { return stored; },
  };
}
const inFolder = (files, from, to) => files.map((f) => ({ ...f, path: f.path.replace(from, to) }));

// ── album tags ───────────────────────────────────────────────────────────

describe('albumTagKey', () => {
  test('no tag gives the empty key', () => {
    for (const none of [null, undefined, '', '   ', '\t\n']) {
      assert.equal(albumTagKey(none), '');
    }
  });

  test('bracketed parts and trailing disc or part markers are dropped', () => {
    const same = [
      'Title', 'title', '  Title  ', 'Title (Disc 1)', 'Title [CD2]', 'Title (Unabridged)',
      'Title - Part 2', 'Title, Pt. 2', 'Title: Disc 3', 'Title CD4', 'Title - Disc 1 of 3',
      'Title (Unabridged) [Disc 2]', 'Title - Part 2 - Disc 1', 'Title - (Disc 1)', '(Unabridged) Title',
      'Title; disk 12',
    ];
    for (const tag of same) {
      assert.equal(albumTagKey(tag), 'title', tag);
    }
  });

  test('the real nameKey runs first, so dash and quote variants agree', () => {
    assert.equal(albumTagKey('Saga – Part 3'), 'saga');          // en dash
    assert.equal(albumTagKey('Saga — Disc 1'), 'saga');          // em dash
    assert.equal(albumTagKey('The Hitchhiker’s Guide'), albumTagKey("The Hitchhiker's Guide"));
  });

  test('a tag that is nothing but a marker is still a tag', () => {
    assert.equal(albumTagKey('(Disc 1)'), '(disc 1)');
    assert.equal(albumTagKey('Part 1'), 'part 1');
    assert.equal(albumTagKey('[Unabridged]'), '[unabridged]');
  });

  test('spelled-out part numbers are not markers', () => {
    assert.notEqual(albumTagKey('Saga: Part One'), albumTagKey('Saga: Part Two'));
  });

  test('books and volumes are not markers: they name different books', () => {
    assert.notEqual(albumTagKey('Saga, Book 2'), albumTagKey('Saga, Book 3'));
    assert.notEqual(albumTagKey('Saga Volume 1'), albumTagKey('Saga Volume 2'));
    assert.notEqual(albumTagKey('Saga 1'), albumTagKey('Saga 2'));
  });

  test('a marker word inside a title is left alone', () => {
    assert.equal(albumTagKey('Catch-22'), 'catch-22');
    assert.equal(albumTagKey('ACDC 2'), 'acdc 2');
    assert.equal(albumTagKey('The Partner'), 'the partner');
    assert.equal(albumTagKey('Part 2 of the Story'), 'part 2 of the story');
    assert.equal(albumTagKey('Fahrenheit 451 (Unabridged)'), 'fahrenheit 451');
  });

  test('inner whitespace left by a removed bracket is collapsed', () => {
    assert.equal(albumTagKey('Title (Unabridged) Edition'), 'title edition');
  });
});

// ── paths ────────────────────────────────────────────────────────────────

describe('comparePaths', () => {
  const sorted = (list) => [...list].sort(comparePaths);

  test('digit runs compare by value', () => {
    assert.deepEqual(sorted(['A/10.mp3', 'A/2.mp3', 'A/1.mp3']), ['A/1.mp3', 'A/2.mp3', 'A/10.mp3']);
    assert.deepEqual(sorted(['T/CD10/01.mp3', 'T/CD2/01.mp3', 'T/CD1/01.mp3']),
      ['T/CD1/01.mp3', 'T/CD2/01.mp3', 'T/CD10/01.mp3']);
    assert.deepEqual(sorted(['Chapter 100.mp3', 'Chapter 99.mp3']), ['Chapter 99.mp3', 'Chapter 100.mp3']);
  });

  test('numbers longer than a double can hold still compare by value', () => {
    assert.ok(comparePaths('9007199254740993.mp3', '9007199254740992.mp3') > 0);
    assert.ok(comparePaths('100000000000000000000.mp3', '99999999999999999999.mp3') > 0);
  });

  test('case does not decide the order, except between otherwise equal names', () => {
    assert.deepEqual(sorted(['b.mp3', 'A.mp3', 'a2.mp3']), ['A.mp3', 'a2.mp3', 'b.mp3']);
    assert.deepEqual(sorted(['C.mp3', 'B.mp3', 'a.mp3']), ['a.mp3', 'B.mp3', 'C.mp3']);
    assert.ok(comparePaths('A.mp3', 'a.mp3') !== 0);
  });

  test('paths compare folder by folder: a folder sorts before the folders its name starts', () => {
    // Compared as whole strings by a collator, "A/B 2/…" lands before "A/B/…".
    assert.deepEqual(sorted(['A/B 2/01.mp3', 'A/B/01.mp3', 'A/B/02.mp3']),
      ['A/B/01.mp3', 'A/B/02.mp3', 'A/B 2/01.mp3']);
  });

  test('a file sorts before the longer names it starts; the extension only breaks ties', () => {
    // As whole names, "Title 2.mp3" would come first: a space sorts before a dot.
    assert.deepEqual(sorted(['B/Title 10.mp3', 'B/Title 2.mp3', 'B/Title.mp3']),
      ['B/Title.mp3', 'B/Title 2.mp3', 'B/Title 10.mp3']);
    assert.deepEqual(sorted(['B/Title.mp3', 'B/Title.m4b', 'B/Title 2.flac']),
      ['B/Title.m4b', 'B/Title.mp3', 'B/Title 2.flac']);
    // A leading dot is part of the name, and a dot in a folder name is not an extension.
    assert.deepEqual(sorted(['B/.b.mp3', 'B/.a.mp3']), ['B/.a.mp3', 'B/.b.mp3']);
    assert.deepEqual(sorted(['Vol. 2/x 2.mp3', 'Vol. 2/x.mp3', 'Vol. 1/x.mp3']),
      ['Vol. 1/x.mp3', 'Vol. 2/x.mp3', 'Vol. 2/x 2.mp3']);
  });

  test('a path with fewer folders comes first when everything shared is equal', () => {
    assert.ok(comparePaths('01', '01/x.mp3') < 0);
    assert.ok(comparePaths('', 'A') < 0);
  });

  test('the order is total and does not depend on where the sort started', () => {
    const list = [
      'A/1.mp3', 'A/01.mp3', 'A/001.mp3', 'a/1.mp3', 'A/1.MP3', 'A/10.mp3', 'A/2.mp3', 'A/x.mp3', 'A/X.mp3',
      'A/CD1/1.mp3', 'A/CD 1/1.mp3', 'A/cd1/1.mp3', 'B.mp3', '1.mp3', '01.mp3', 'A/x 1.mp3', 'A/x1.mp3',
      'A/x-1.mp3', 'Z/é.mp3', 'Z/e.mp3', 'Z/f.mp3',
    ];
    const want = sorted(list);
    for (let seed = 1; seed <= 25; seed++) {
      assert.deepEqual(sorted(shuffled(list, seed)), want, `seed ${seed}`);
    }
    for (const a of list) {
      for (const b of list) {
        const ab = Math.sign(comparePaths(a, b));
        assert.equal(ab + Math.sign(comparePaths(b, a)), 0, `${a} vs ${b}`);
        assert.equal(ab === 0, a === b, `${a} vs ${b}`);
      }
    }
  });
});

describe('isDiscFolderName', () => {
  test('a disc word followed by a number, and nothing else', () => {
    for (const yes of ['CD1', 'cd 2', 'Disc 3', 'DISK_04', 'disc-5', 'Part 6', 'Pt. 7', 'pt8', 'Disc.9', 'CD  10']) {
      assert.equal(isDiscFolderName(yes), true, yes);
    }
    for (const no of ['Disc', 'CD', 'Disc One', 'Disc 1 of 2', 'CD1 bonus', 'Volume 1', 'Vol 2', 'Book 1',
      'Chapter 1', '1', 'Part 1 - The Start', 'My CD1', 'Parts 1', 'Side 1', '']) {
      assert.equal(isDiscFolderName(no), false, no);
    }
  });
});

// ── file order ───────────────────────────────────────────────────────────

describe('orderFiles', () => {
  test('track tags decide when every file has one and none repeats', () => {
    const files = [file('B/zebra.mp3', 'B', 1), file('B/apple.mp3', 'B', 2), file('B/mango.mp3', 'B', 3)];
    assert.equal(hasTagOrder(files), true);
    assert.deepEqual(paths(orderFiles(shuffled(files, 7))), ['B/zebra.mp3', 'B/apple.mp3', 'B/mango.mp3']);
  });

  test('disc comes before track', () => {
    const files = [file('B/a.mp3', 'B', 1, 2), file('B/b.mp3', 'B', 9, 1), file('B/c.mp3', 'B', 2, 2), file('B/d.mp3', 'B', 1, 1)];
    assert.deepEqual(paths(orderFiles(files)), ['B/d.mp3', 'B/b.mp3', 'B/a.mp3', 'B/c.mp3']);
  });

  test('no disc tag counts as disc 1, and so does disc 0', () => {
    const files = [file('B/a.mp3', 'B', 1, 2), file('B/b.mp3', 'B', 2), file('B/c.mp3', 'B', 5, 0), file('B/d.mp3', 'B', 3, 1)];
    assert.deepEqual(paths(orderFiles(files)), ['B/b.mp3', 'B/d.mp3', 'B/c.mp3', 'B/a.mp3']);
    assert.equal(hasTagOrder([file('B/a.mp3', 'B', 1, 0), file('B/b.mp3', 'B', 1, 1)]), false);
  });

  test('track 0 is a track number', () => {
    const files = [file('B/z-intro.mp3', 'B', 0), file('B/a.mp3', 'B', 1)];
    assert.deepEqual(paths(orderFiles(files)), ['B/z-intro.mp3', 'B/a.mp3']);
  });

  test('one file without a track number sends the whole book to path order', () => {
    const files = [file('B/zebra.mp3', 'B', 1), file('B/apple.mp3', 'B', 2), file('B/mango.mp3', 'B')];
    assert.equal(hasTagOrder(files), false);
    assert.deepEqual(paths(orderFiles(files)), ['B/apple.mp3', 'B/mango.mp3', 'B/zebra.mp3']);
  });

  test('a disc and track used twice sends the whole book to path order', () => {
    const files = [file('B/zebra.mp3', 'B', 1), file('B/apple.mp3', 'B', 1), file('B/mango.mp3', 'B', 2)];
    assert.equal(hasTagOrder(files), false);
    assert.deepEqual(paths(orderFiles(files)), ['B/apple.mp3', 'B/mango.mp3', 'B/zebra.mp3']);
    // "disc 1" and "no disc tag" are the same disc.
    assert.equal(hasTagOrder([file('B/a.mp3', 'B', 1, 1), file('B/b.mp3', 'B', 1)]), false);
  });

  test('a track tag that is not a whole number does not count', () => {
    for (const bad of [1.5, -1, '3', NaN]) {
      assert.equal(hasTagOrder([file('B/a.mp3', 'B', bad), file('B/b.mp3', 'B', 2)]), false, String(bad));
    }
  });

  test('path order is natural, across disc folders', () => {
    const files = [...many('B/CD10', 2, 'B'), ...many('B/CD2', 2, 'B'), ...many('B/CD1', 2, 'B')];
    assert.deepEqual(paths(orderFiles(files)), [
      'B/CD1/01.mp3', 'B/CD1/02.mp3', 'B/CD2/01.mp3', 'B/CD2/02.mp3', 'B/CD10/01.mp3', 'B/CD10/02.mp3',
    ]);
  });

  test('the input is left as it was, and the files are the same objects', () => {
    const files = [file('B/2.mp3', 'B', 2), file('B/1.mp3', 'B', 1)];
    const before = [...files];
    const ordered = orderFiles(files);
    assert.deepEqual(files, before);
    assert.notEqual(ordered, files);
    assert.equal(ordered[0], files[1]);
    assert.deepEqual(orderFiles([]), []);
  });
});

// ── grouping: the plan's layouts (§6.3) ──────────────────────────────────

describe('groupBooks: the plan\'s layouts', () => {
  test('Author/Title/*.mp3: one book', () => {
    const books = groupBooks(many('Author/Title', 20, 'Title'));
    assert.deepEqual(shape(books), [['Author/Title', '', 20]]);
  });

  test('loose single-file books in an author folder: one book each', () => {
    const books = groupBooks([file('Author/Book A.m4b', 'Book A'), file('Author/Book B.m4b', 'Book B')]);
    assert.deepEqual(shape(books), [['Author/Book A.m4b', '', 1], ['Author/Book B.m4b', '', 1]]);
  });

  test('Author/Series/01 - Title/*.mp3: one book', () => {
    const books = groupBooks(many('Author/Series/01 - Title', 12, 'Title'));
    assert.deepEqual(shape(books), [['Author/Series/01 - Title', '', 12]]);
  });

  test('files at the library root, some untagged: one book each', () => {
    const books = groupBooks([
      file('One.m4b', 'One'), file('Two.m4b', 'Two'), file('untagged-a.mp3'), file('untagged-b.mp3'),
    ]);
    assert.deepEqual(shape(books), [
      ['One.m4b', '', 1], ['Two.m4b', '', 1], ['untagged-a.mp3', '', 1], ['untagged-b.mp3', '', 1],
    ]);
  });

  test('CD1 / CD2 subfolders, track numbers restart, no disc tags: one book, discs in order', () => {
    const books = groupBooks([...many('Author/Title/CD2', 10, 'Title'), ...many('Author/Title/CD1', 10, 'Title')]);
    assert.deepEqual(shape(books), [['Author/Title', '', 20]]);
    assert.equal(books[0].files[0].path, 'Author/Title/CD1/01.mp3');
    assert.equal(books[0].files[9].path, 'Author/Title/CD1/10.mp3');
    assert.equal(books[0].files[10].path, 'Author/Title/CD2/01.mp3');
  });

  test('a two-part .m4b beside another book: two books', () => {
    const books = groupBooks([
      file('Author/Long Book Part 1.m4b', 'Long Book'), file('Author/Long Book Part 2.m4b', 'Long Book'),
      file('Author/Other.m4b', 'Other'),
    ]);
    assert.deepEqual(shape(books), [['Author', 'long book', 2], ['Author/Other.m4b', '', 1]]);
  });

  test('one book with a tag typo in the middle: one book', () => {
    const files = many('Author/The Hobbit', 30, 'The Hobbit');
    files[10] = { ...files[10], album: 'The Hobit' };
    assert.deepEqual(shape(groupBooks(files)), [['Author/The Hobbit', '', 30]]);
  });

  test('album tags carrying "(Disc n)": one book', () => {
    const books = groupBooks([...many('A/T', 5, 'T (Disc 1)'), ...many('A/T', 5, 'T (Disc 2)', { from: 5 })]);
    assert.deepEqual(shape(books), [['A/T', '', 10]]);
    assert.deepEqual(paths(books[0].files), many('A/T', 10).map((f) => f.path));
  });

  test('a loose file plus a non-disc subfolder: two books', () => {
    const books = groupBooks([file('Author/Loose.m4b', 'Loose'), ...many('Author/Other Book', 8, 'Other Book')]);
    assert.deepEqual(shape(books), [['Author', '', 1], ['Author/Other Book', '', 8]]);
  });

  test('an untagged folder: one book', () => {
    const books = groupBooks(many('Author/Mystery', 15, null, { noTrack: true }));
    assert.deepEqual(shape(books), [['Author/Mystery', '', 15]]);
  });

  test('a book with differently tagged bonus tracks at the end: one book', () => {
    const books = groupBooks([
      ...many('A/Dune', 28, 'Dune'), file('A/Dune/29.mp3', 'Author Interview', 29), file('A/Dune/30.mp3', 'Author Interview', 30),
    ]);
    assert.deepEqual(shape(books), [['A/Dune', '', 30]]);
  });

  test('Part 1 / Part 2 subfolders: one book', () => {
    const books = groupBooks([...many('A/Epic/Part 1', 10, 'Epic'), ...many('A/Epic/Part 2', 10, 'Epic')]);
    assert.deepEqual(shape(books), [['A/Epic', '', 20]]);
    assert.equal(books[0].files[10].path, 'A/Epic/Part 2/01.mp3');
  });

  test('a series folder, one subfolder per book: two books', () => {
    const books = groupBooks([...many('A/Saga/Book 1 - Dawn', 9, 'Dawn'), ...many('A/Saga/Book 2 - Dusk', 9, 'Dusk')]);
    assert.deepEqual(shape(books), [['A/Saga/Book 1 - Dawn', '', 9], ['A/Saga/Book 2 - Dusk', '', 9]]);
  });

  test('series entries in bare "Volume n" folders: two books', () => {
    const books = groupBooks([...many('A/Saga/Volume 1', 9, 'Saga 1'), ...many('A/Saga/Volume 2', 9, 'Saga 2')]);
    assert.deepEqual(shape(books), [['A/Saga/Volume 1', '', 9], ['A/Saga/Volume 2', '', 9]]);
  });

  test('one book whose two halves are tagged differently: one book', () => {
    const books = groupBooks([...many('A/Book', 10, 'Book'), ...many('A/Book', 10, 'Book: A Novel', { from: 10 })]);
    assert.deepEqual(shape(books), [['A/Book', '', 20]]);
  });

  test('a three-file book whose album tags differ only by a part marker: one book', () => {
    const books = groupBooks([
      file('A/Saga/1.m4b', 'Saga (Part 1)'), file('A/Saga/2.m4b', 'Saga (Part 2)'), file('A/Saga/3.m4b', 'Saga - Part 3'),
    ]);
    assert.deepEqual(shape(books), [['A/Saga', '', 3]]);
  });

  test('KNOWN MISS, merged (wanted two): a chapter-per-file book sharing a folder with a loose book', () => {
    const books = groupBooks([...many('A', 12, 'Book A'), file('A/Book B.m4b', 'Book B')]);
    assert.deepEqual(shape(books), [['A', '', 13]]);
  });

  test('KNOWN MISS, merged (wanted five): untagged loose files in an author folder', () => {
    const books = groupBooks([1, 2, 3, 4, 5].map((n) => file(`A/Story ${n}.mp3`)));
    assert.deepEqual(shape(books), [['A', '', 5]]);
  });

  test('KNOWN MISS, split (wanted one): a three-file book whose files carry different album tags', () => {
    const books = groupBooks([
      file('A/Saga/1.m4b', 'Saga: Part One'), file('A/Saga/2.m4b', 'Saga: Part Two'), file('A/Saga/3.m4b', 'Saga: Part Three'),
    ]);
    assert.deepEqual(shape(books), [['A/Saga/1.m4b', '', 1], ['A/Saga/2.m4b', '', 1], ['A/Saga/3.m4b', '', 1]]);
  });
});

// ── grouping: the edges the plan's table does not list ───────────────────

describe('groupBooks: edges', () => {
  test('nothing in, nothing out', () => {
    assert.deepEqual(groupBooks([]), []);
  });

  test('a folder holding one file is a book addressed by the folder', () => {
    assert.deepEqual(shape(groupBooks([file('Author/Title/Title.m4b', 'Title')])), [['Author/Title', '', 1]]);
  });

  test('disc folders fold at any depth', () => {
    const books = groupBooks([
      file('A/T/CD1/Part 1/01.mp3', 'T'), file('A/T/CD1/Part 2/01.mp3', 'T'), file('A/T/CD2/01.mp3', 'T'), file('A/T/00.mp3', 'T'),
    ]);
    assert.deepEqual(shape(books), [['A/T', '', 4]]);
    assert.deepEqual(paths(books[0].files), ['A/T/00.mp3', 'A/T/CD1/Part 1/01.mp3', 'A/T/CD1/Part 2/01.mp3', 'A/T/CD2/01.mp3']);
  });

  test('a folder that only looks like a disc folder is a book of its own', () => {
    const books = groupBooks([...many('A/T/CD1 bonus', 2, 'T'), ...many('A/T/Disc One', 2, 'T'), ...many('A/T', 2, 'T')]);
    assert.deepEqual(shape(books), [['A/T', '', 2], ['A/T/CD1 bonus', '', 2], ['A/T/Disc One', '', 2]]);
  });

  test('disc folders directly under the library root form one book, tagged or not', () => {
    const untagged = groupBooks([...many('CD2', 3, null, { noTrack: true }), ...many('CD1', 3, null, { noTrack: true })]);
    assert.deepEqual(shape(untagged), [['', '', 6]]);
    assert.equal(untagged[0].files[0].path, 'CD1/01.mp3');
    assert.equal(untagged[0].files[3].path, 'CD2/01.mp3');

    // Two tags, two files each: in an ordinary folder this would be a shelf.
    const tagged = groupBooks([...many('Part 1', 2, 'Dawn'), ...many('Part 2', 2, 'Dusk')]);
    assert.deepEqual(shape(tagged), [['', '', 4]]);
  });

  test('loose root files stay apart from the root\'s disc folders, and no address repeats', () => {
    const books = groupBooks([
      ...many('CD1', 2, 'Epic'), ...many('CD2', 2, 'Epic'),
      file('epic-a.mp3', 'Epic'), file('epic-b.mp3', 'Epic'), file('Other.m4b', 'Other'), file('stray.mp3'),
      ...many('Author/Title', 2, 'Epic'),
    ]);
    assert.deepEqual(shape(books), [
      ['', '', 4], ['', 'epic', 2], ['Author/Title', '', 2], ['Other.m4b', '', 1], ['stray.mp3', '', 1],
    ]);
    const addresses = books.map((b) => JSON.stringify([b.path, b.groupKey]));
    assert.equal(new Set(addresses).size, addresses.length);
  });

  test('at the library root an album tag is a book however many files carry it', () => {
    const root = [...Array(12)].map((_v, i) => file(`${pad(i + 1)} chapter.mp3`, 'Long Book (Unabridged)', i + 1));
    const books = groupBooks([...root, file('Short.m4b', 'Short')]);
    assert.deepEqual(shape(books), [['', 'long book', 12], ['Short.m4b', '', 1]]);
  });

  test('at the library root the tag\'s files need not be next to each other', () => {
    const books = groupBooks([file('a.mp3', 'X'), file('b.mp3', 'Y'), file('c.mp3', 'X')]);
    assert.deepEqual(shape(books), [['', 'x', 2], ['b.mp3', '', 1]]);
    assert.deepEqual(paths(books[0].files), ['a.mp3', 'c.mp3']);
  });

  test(`a shelf allows ${SHELF_MAX_FILES_PER_BOOK} files per tag; one more makes the folder one book`, () => {
    const three = groupBooks([...many('Shelf', 3, 'Long'), file('Shelf/Other.m4b', 'Other')]);
    assert.deepEqual(shape(three), [['Shelf', 'long', 3], ['Shelf/Other.m4b', '', 1]]);
    const four = groupBooks([...many('Shelf', 4, 'Long'), file('Shelf/Other.m4b', 'Other')]);
    assert.deepEqual(shape(four), [['Shelf', '', 5]]);
  });

  test('tags that come back after another tag do not make a shelf', () => {
    const books = groupBooks([file('S/1.m4b', 'A'), file('S/2.m4b', 'B'), file('S/3.m4b', 'A')]);
    assert.deepEqual(shape(books), [['S', '', 3]]);
  });

  test('one untagged file among tagged loose books makes the folder one book', () => {
    const books = groupBooks([file('S/A.m4b', 'A'), file('S/B.m4b', 'B'), file('S/readme.mp3')]);
    assert.deepEqual(shape(books), [['S', '', 3]]);
  });

  test('loose files whose tags differ only by a marker are one book (the merge side)', () => {
    // Two different plays, by their titles. The rules cannot tell that from
    // one book in two parts; separate folders settle it.
    const books = groupBooks([file('Shakespeare/H4-1.m4b', 'Henry IV, Part 1'), file('Shakespeare/H4-2.m4b', 'Henry IV, Part 2')]);
    assert.deepEqual(shape(books), [['Shakespeare', '', 2]]);
  });

  test('a shelf is read in path order, not input order', () => {
    const shelf = [
      file('S/02 b.m4b', 'B'), file('S/10 c.m4b', 'C'), file('S/01 a.m4b', 'A'), file('S/03 b.m4b', 'B'),
    ];
    assert.deepEqual(shape(groupBooks(shelf)), [['S', 'b', 2], ['S/01 a.m4b', '', 1], ['S/10 c.m4b', '', 1]]);
  });

  test('each book\'s files are the caller\'s objects, in playing order', () => {
    const files = [file('A/T/02.mp3', 'T', 2), file('A/T/01.mp3', 'T', 1)];
    files[0].anything = { kept: true };
    const [book] = groupBooks(files);
    assert.equal(book.files[0], files[1]);
    assert.equal(book.files[1], files[0]);
    assert.deepEqual(book.files[1].anything, { kept: true });
  });

  test('the answer does not depend on the order of the input', () => {
    const files = [
      ...many('Author/Title/CD1', 6, 'Title'), ...many('Author/Title/CD2', 6, 'Title'),
      file('Author/Book A.m4b', 'Book A'), file('Author/Book B.m4b', 'Book B'), file('Author/Book B 2.m4b', 'Book B'),
      file('One.m4b', 'One'), file('x1.mp3', 'Root Book'), file('x2.mp3', 'Root Book'), file('stray.mp3'),
      ...many('Other/Saga/Volume 1', 4, 'Saga 1'), ...many('Other/Saga/Volume 2', 4, 'Saga 2'),
      ...many('Part 1', 2), ...many('Part 2', 2),
    ];
    const want = groupBooks(files);
    assert.deepEqual(shape(want), [
      ['', '', 4], ['', 'root book', 2], ['Author', 'book b', 2], ['Author/Book A.m4b', '', 1],
      ['Author/Title', '', 12], ['One.m4b', '', 1], ['Other/Saga/Volume 1', '', 4],
      ['Other/Saga/Volume 2', '', 4], ['stray.mp3', '', 1],
    ]);
    for (let seed = 1; seed <= 25; seed++) {
      assert.deepEqual(groupBooks(shuffled(files, seed)), want, `seed ${seed}`);
    }
  });
});

// ── identity: the plan's rescan scenarios (§7.4) ─────────────────────────

describe('matchBooks: the plan\'s rescan scenarios', () => {
  const title = () => many('Author/Title', 20, 'Title');

  test('rescan, nothing changed: same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    const again = lib.scan(files);
    assert.equal(lib.at('Author/Title').id, id);
    assert.equal(again.books[0].matchedBy, 'content');
    assert.deepEqual(again.missing, []);
  });

  test('folder renamed: same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan(inFolder(files, 'Author/Title', 'Author/Title (2020)'));
    assert.equal(lib.at('Author/Title (2020)').id, id);
    assert.equal(lib.stored.length, 1);
  });

  test('moved under another author: same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan(inFolder(files, 'Author/Title', 'Other Author/Series/Title'));
    assert.equal(lib.at('Other Author/Series/Title').id, id);
    assert.equal(lib.stored.length, 1);
  });

  test('a file added: same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan([...files, file('Author/Title/21.mp3', 'Title', 21)]);
    assert.equal(lib.at('Author/Title').id, id);
    assert.equal(lib.at('Author/Title').hashes.length, 21);
  });

  test('retagged in place: same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan(files.map((f) => ({ ...f, album: 'Title: Special Edition' })));
    assert.equal(lib.at('Author/Title').id, id);
  });

  test('re-encoded in place (every hash changes): same ID, by place', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    const result = lib.scan(files.map((f) => ({ ...f, hash: `re-${f.hash}` })));
    assert.equal(lib.at('Author/Title').id, id);
    assert.equal(result.books[0].matchedBy, 'place');
    assert.deepEqual(result.missing, []);
  });

  test('drive unmounted for one scan, then back: missing, then the same ID', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;

    const gone = lib.scan([]);
    assert.deepEqual(gone.books, []);
    assert.equal(gone.missing.length, 1);
    assert.equal(gone.missing[0].stored.id, id);
    assert.equal(gone.missing[0].mergedInto, null);
    assert.equal(lib.book(id).missing, true);

    const back = lib.scan(files);
    assert.equal(lib.at('Author/Title').id, id);
    assert.equal(back.books[0].stored.missing, true);     // the caller sees it was missing
    assert.deepEqual(back.missing, []);
  });

  test('copied, original kept: two books', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan([...files, ...inFolder(files, 'Author/Title', 'New/Title')]);
    assert.equal(lib.at('Author/Title').id, id);
    assert.notEqual(lib.at('New/Title').id, id);
    assert.equal(lib.live().length, 2);
  });

  test('copied first, original deleted in a later scan: the old ID points at the copy', () => {
    const lib = library();
    const files = title();
    const copy = inFolder(files, 'Author/Title', 'New/Title');
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    lib.scan([...files, ...copy]);
    const copyId = lib.at('New/Title').id;

    const result = lib.scan(copy);
    assert.equal(lib.at('New/Title').id, copyId);
    assert.deepEqual(result.missing.map((m) => [m.stored.id, m.mergedInto]), [[id, copyId]]);

    // …and it stays that way on the scans that follow.
    const later = lib.scan(copy);
    assert.equal(lib.at('New/Title').id, copyId);
    assert.deepEqual(later.missing.map((m) => [m.stored.id, m.mergedInto]), [[id, copyId]]);
  });

  test('a loose file renamed: same ID', () => {
    const lib = library();
    const shelf = [file('Author/Book A.m4b', 'Book A'), file('Author/Book B.m4b', 'Book B')];
    lib.scan(shelf);
    const idA = lib.at('Author/Book A.m4b').id;
    const idB = lib.at('Author/Book B.m4b').id;
    lib.scan([{ ...shelf[0], path: 'Author/Book A (Unabridged).m4b' }, shelf[1]]);
    assert.equal(lib.at('Author/Book A (Unabridged).m4b').id, idA);
    assert.equal(lib.at('Author/Book B.m4b').id, idB);
  });

  test('a loose file moved into its own folder: same ID', () => {
    const lib = library();
    const shelf = [file('Author/Book A.m4b', 'Book A'), file('Author/Book B.m4b', 'Book B')];
    lib.scan(shelf);
    const idA = lib.at('Author/Book A.m4b').id;
    const idB = lib.at('Author/Book B.m4b').id;
    lib.scan([{ ...shelf[0], path: 'Author/Book A/Book A.m4b' }, shelf[1]]);
    assert.equal(lib.at('Author/Book A').id, idA);
    // Book B is now alone in the folder, so its address changes too. Same ID.
    assert.equal(lib.at('Author').id, idB);
    assert.equal(lib.stored.length, 2);
  });

  test('numbered folders renumbered: IDs follow the content', () => {
    const lib = library();
    const dawn = many('S/Book 1', 10, 'Dawn');
    const dusk = many('S/Book 2', 10, 'Dusk');
    lib.scan([...dawn, ...dusk]);
    const idDawn = lib.at('S/Book 1').id;
    const idDusk = lib.at('S/Book 2').id;
    lib.scan([...inFolder(dawn, 'S/Book 1', 'S/Book 2'), ...inFolder(dusk, 'S/Book 2', 'S/Book 3')]);
    assert.equal(lib.at('S/Book 2').id, idDawn);
    assert.equal(lib.at('S/Book 3').id, idDusk);
    assert.equal(lib.stored.length, 2);
  });

  test('two books merged into one folder: the bigger keeps its ID; the other points at it', () => {
    const lib = library();
    const big = many('X/A', 10, 'A');
    const small = many('X/B', 4, 'A');
    lib.scan([...big, ...small]);
    const idBig = lib.at('X/A').id;
    const idSmall = lib.at('X/B').id;
    const result = lib.scan([...big, ...small.map((f, i) => ({ ...f, path: `X/A/${11 + i}.mp3` }))]);
    assert.equal(lib.at('X/A').id, idBig);
    assert.deepEqual(result.missing.map((m) => [m.stored.id, m.mergedInto]), [[idSmall, idBig]]);
  });

  test('a merged folder split: the ID stays with the larger part', () => {
    const lib = library();
    const chapters = many('A', 12, 'Book A');
    const loose = file('A/Book B.m4b', 'Book B');
    lib.scan([...chapters, loose]);
    const id = lib.at('A').id;
    lib.scan([...inFolder(chapters, 'A/', 'A/Book A/'), loose]);
    assert.equal(lib.at('A/Book A').id, id);
    assert.notEqual(lib.at('A').id, id);
    assert.equal(lib.stored.length, 2);
  });

  test('KNOWN MISS: moved and re-encoded in one step gets a new ID; the old book stays as missing', () => {
    const lib = library();
    const files = title();
    lib.scan(files);
    const id = lib.at('Author/Title').id;
    const result = lib.scan(files.map((f) => ({ ...f, path: f.path.replace('Author/Title', 'X/Title'), hash: `mr-${f.hash}` })));
    assert.notEqual(lib.at('X/Title').id, id);
    assert.equal(result.books[0].matchedBy, 'new');
    assert.deepEqual(result.missing.map((m) => [m.stored.id, m.mergedInto]), [[id, null]]);
  });
});

// ── identity: the edges ──────────────────────────────────────────────────

describe('matchBooks: edges', () => {
  const counter = () => { let n = 0; return () => `new${++n}`; };
  const group = (path, hashList, groupKey = '') => ({ path, groupKey, files: hashList.map((hash, i) => ({ path: `${path}/${i}.mp3`, hash })) });
  const book = (id, path, hashList, more = {}) => ({ id, libraryId: 1, path, groupKey: '', hashes: hashList, missing: false, mergedInto: null, ...more });
  const match = (stored, groups) => matchBooks(stored, groups, { libraryId: 1, newId: counter() });
  const ids = (result) => result.books.map((b) => b.id);
  const gone = (result) => result.missing.map((m) => [m.stored.id, m.mergedInto]);

  test('newId is required', () => {
    assert.throws(() => matchBooks([], []), TypeError);
    assert.throws(() => matchBooks([], [], { libraryId: 1 }), TypeError);
  });

  test('an empty library and an empty scan', () => {
    assert.deepEqual(match([], []), { books: [], missing: [] });
    const first = match([], [group('A', ['a1']), group('B', ['b1'])]);
    assert.deepEqual(ids(first), ['new1', 'new2']);
    assert.deepEqual(first.books.map((b) => [b.stored, b.matchedBy]), [[null, 'new'], [null, 'new']]);
  });

  test('books come back in group order, each with its group', () => {
    const groups = [group('A', ['a1']), group('B', ['b1']), group('C', ['c1'])];
    const result = match([book('idC', 'C', ['c1']), book('idA', 'A', ['a1'])], groups);
    assert.deepEqual(ids(result), ['idA', 'new1', 'idC']);
    result.books.forEach((b, i) => assert.equal(b.group, groups[i]));
  });

  test('half of the smaller side is enough; less is not', () => {
    // 2 of 4 shared: the same book, even at another address.
    const half = match([book('s', 'Old', ['a', 'b', 'c', 'd'])], [group('New', ['a', 'b', 'x', 'y'])]);
    assert.deepEqual(ids(half), ['s']);
    // 1 of 4 shared: a different book.
    const less = match([book('s', 'Old', ['a', 'b', 'c', 'd'])], [group('New', ['a', 'x', 'y', 'z'])]);
    assert.deepEqual(ids(less), ['new1']);
    assert.deepEqual(gone(less), [['s', null]]);
    // The smaller side counts: a one-file book is found inside a large folder.
    const lone = match([book('s', 'Old.m4b', ['a'])], [group('New', ['a', 'p', 'q', 'r', 't', 'u', 'v'])]);
    assert.deepEqual(ids(lone), ['s']);
  });

  test('a hash listed twice counts once, and a file with no hash is ignored', () => {
    const result = match([book('s', 'Old', ['a', 'a', 'a', 'b', null, ''])], [group('New', ['a', 'b', 'c', 'd', null, undefined])]);
    assert.deepEqual(ids(result), ['s']);
    assert.equal(result.books[0].matchedBy, 'content');
    // Two files that both lack a hash are not the same file.
    const blank = match([book('s', 'Old', [null, ''])], [group('New', [null, ''])]);
    assert.deepEqual(ids(blank), ['new1']);
    assert.deepEqual(gone(blank), [['s', null]]);
  });

  test('the same place beats another place when the content is equal', () => {
    const stored = [book('s', 'B', ['a', 'b'])];
    const result = match(stored, [group('A', ['a', 'b']), group('B', ['a', 'b'])]);
    assert.deepEqual(ids(result), ['new1', 's']);
  });

  test('more shared files beat the same place', () => {
    const stored = [book('s', 'A', ['a', 'b', 'c', 'd'])];
    const result = match(stored, [group('A', ['a', 'b']), group('Z', ['a', 'b', 'c'])]);
    assert.deepEqual(ids(result), ['new1', 's']);
  });

  test('on a tie a live book goes before a missing one, whatever the order', () => {
    const live = book('live', 'P1', ['a', 'b']);
    const missing = book('was', 'P0', ['a', 'b'], { missing: true });
    for (const stored of [[missing, live], [live, missing]]) {
      const result = match(stored, [group('Elsewhere', ['a', 'b'])]);
      assert.deepEqual(ids(result), ['live']);
      assert.deepEqual(gone(result), [['was', 'live']]);
    }
  });

  test('on a tie a missing book goes before one already merged into another', () => {
    const merged = book('merged', 'P0', ['a', 'b'], { missing: true, mergedInto: 'plain' });
    const plain = book('plain', 'P1', ['a', 'b'], { missing: true });
    for (const stored of [[merged, plain], [plain, merged]]) {
      const result = match(stored, [group('Back', ['a', 'b'])]);
      assert.deepEqual(ids(result), ['plain']);
      assert.deepEqual(gone(result), [['merged', 'plain']]);
    }
  });

  test('with nothing else to choose by, the book listed first wins', () => {
    const one = book('one', 'X/A', ['a1', 'a2']);
    const two = book('two', 'X/B', ['b1', 'b2']);
    const merged = [group('X/C', ['a1', 'a2', 'b1', 'b2'])];
    assert.deepEqual(ids(match([one, two], merged)), ['one']);
    assert.deepEqual(gone(match([one, two], merged)), [['two', 'one']]);
    assert.deepEqual(ids(match([two, one], merged)), ['two']);
  });

  test('a stored book takes one group, and a group one stored book', () => {
    const stored = [book('s1', 'A', ['a', 'b']), book('s2', 'B', ['a', 'b'])];
    const result = match(stored, [group('A', ['a', 'b']), group('B', ['a', 'b']), group('C', ['a', 'b'])]);
    assert.deepEqual(ids(result), ['s1', 's2', 'new1']);
    assert.deepEqual(result.missing, []);
  });

  test('the place rule needs the same library, path and group key', () => {
    const stored = [book('s', 'Author/Title', ['old1', 'old2'])];
    const reencoded = [group('Author/Title', ['new1', 'new2'])];
    assert.deepEqual(ids(match(stored, reencoded)), ['s']);

    const otherLibrary = matchBooks(stored, reencoded, { libraryId: 2, newId: counter() });
    assert.deepEqual(ids(otherLibrary), ['new1']);
    assert.deepEqual(gone(otherLibrary), [['s', null]]);

    const otherKey = match(stored, [group('Author/Title', ['new1', 'new2'], 'title')]);
    assert.deepEqual(ids(otherKey), ['new1']);

    const removedLibrary = match([{ ...stored[0], libraryId: null, missing: true }], reencoded);
    assert.deepEqual(ids(removedLibrary), ['new1']);
  });

  test('a book from a removed library gets its ID back by content', () => {
    const stored = [book('s', 'Author/Title', ['a', 'b', 'c'], { libraryId: null, missing: true })];
    const result = matchBooks(stored, [group('Title', ['a', 'b', 'c'])], { libraryId: 7, newId: counter() });
    assert.deepEqual(ids(result), ['s']);
    assert.equal(result.books[0].matchedBy, 'content');
  });

  test('the place rule does not take a group that content has claimed', () => {
    // "Dusk" moved into the folder "Dawn" was in; "Dawn" is gone.
    const stored = [book('dawn', 'S/Book 1', ['a1', 'a2']), book('dusk', 'S/Book 2', ['b1', 'b2'])];
    const result = match(stored, [group('S/Book 1', ['b1', 'b2'])]);
    assert.deepEqual(ids(result), ['dusk']);
    assert.deepEqual(gone(result), [['dawn', null]]);
  });

  test('a missing book is found again in place', () => {
    const stored = [book('s', 'Author/Title', ['old1', 'old2'], { missing: true })];
    const result = match(stored, [group('Author/Title', ['new1', 'new2'])]);
    assert.deepEqual(ids(result), ['s']);
    assert.equal(result.books[0].matchedBy, 'place');
  });

  test('when a live and a missing book share an address, the live one is found in place', () => {
    // 'was' lost its folder to 'now' on an earlier scan. Now 'now' is re-encoded.
    const was = book('was', 'S/Book 1', ['a1', 'a2'], { missing: true });
    const now = book('now', 'S/Book 1', ['b1', 'b2']);
    for (const stored of [[was, now], [now, was]]) {
      const result = match(stored, [group('S/Book 1', ['c1', 'c2'])]);
      assert.deepEqual(ids(result), ['now']);
      assert.deepEqual(gone(result), [['was', null]]);
    }
  });

  test('a book with no file rows is never reported as merged', () => {
    const stored = [book('live', 'A', ['a']), book('empty', 'Gone', [], { missing: true })];
    const result = match(stored, [group('A', ['a'])]);
    assert.deepEqual(gone(result), [['empty', null]]);
  });

  test('a gone book points at the live book holding the most of its files, if that is half or more', () => {
    const stored = [
      book('keepA', 'A', ['a1', 'x1', 'x2']), book('keepB', 'B', ['b1', 'x3']), book('keepC', 'C', ['c1', 'c2', 'c3', 'y1']),
      book('gone', 'Old', ['x1', 'x2', 'x3', 'x4']),
      book('thin', 'Old2', ['y1', 'y2', 'y3']),
    ];
    const result = match(stored, [group('A', ['a1', 'x1', 'x2']), group('B', ['b1', 'x3']), group('C', ['c1', 'c2', 'c3', 'y1'])]);
    assert.deepEqual(ids(result), ['keepA', 'keepB', 'keepC']);
    // 'gone': A holds 2 of 4 (half), B holds 1. 'thin': C holds 1 of 3.
    assert.deepEqual(gone(result), [['gone', 'keepA'], ['thin', null]]);

    // Two live books each hold half or more: the bigger share wins, not the first group.
    const two = match(
      [book('first', 'A', ['a1', 'x1', 'x2']), book('second', 'B', ['b1', 'x2', 'x3', 'x4']), book('gone', 'Old', ['x1', 'x2', 'x3', 'x4'])],
      [group('A', ['a1', 'x1', 'x2']), group('B', ['b1', 'x2', 'x3', 'x4'])],
    );
    assert.deepEqual(gone(two), [['gone', 'second']]);
  });

  test('a gone book keeps the pointer it had when nothing holds its files now', () => {
    const stored = [book('live', 'A', ['a']), book('old', 'Gone', ['z1', 'z2'], { missing: true, mergedInto: 'elsewhere' })];
    assert.deepEqual(gone(match(stored, [group('A', ['a'])])), [['old', 'elsewhere']]);
    assert.deepEqual(gone(match(stored, [])), [['live', null], ['old', 'elsewhere']]);
  });

  test('a merged book whose files get their own folder again is live again', () => {
    // 'small' was folded into 'big' on an earlier scan. Now it is split back out.
    const stored = [
      book('big', 'X/A', ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2']),
      book('small', 'X/B', ['b1', 'b2'], { missing: true, mergedInto: 'big' }),
    ];
    const result = match(stored, [group('X/A', ['a1', 'a2', 'a3', 'a4', 'a5']), group('X/B', ['b1', 'b2'])]);
    assert.deepEqual(ids(result), ['big', 'small']);
    assert.equal(result.books[1].stored.mergedInto, 'big');   // what it was; the caller clears it
    assert.deepEqual(result.missing, []);
  });

  test('missing books are reported in the order the stored books came in', () => {
    const stored = [book('z', 'Z', ['z']), book('a', 'A', ['a']), book('m', 'M', ['m'])];
    assert.deepEqual(gone(match(stored, [group('A', ['a'])])), [['z', null], ['m', null]]);
  });

  test('the answer does not depend on the order of the groups\' files', () => {
    const lib = library();
    const files = [
      ...many('Author/Title/CD1', 6, 'Title'), ...many('Author/Title/CD2', 6, 'Title'),
      file('Author/Book A.m4b', 'Book A'), file('Author/Book B.m4b', 'Book B'),
      ...many('Other/Saga/Volume 1', 4, 'Saga 1'), ...many('Other/Saga/Volume 2', 4, 'Saga 2'),
    ];
    lib.scan(files);
    const before = lib.live().map((b) => [b.path, b.groupKey, b.id]);
    for (let seed = 1; seed <= 10; seed++) {
      const result = lib.scan(shuffled(files, seed));
      assert.deepEqual(lib.live().map((b) => [b.path, b.groupKey, b.id]), before, `seed ${seed}`);
      assert.deepEqual(result.missing, []);
    }
  });

  test('ten thousand books match without comparing every pair of books', () => {
    // The content rule works from an index of hashes. Comparing every stored
    // book with every group is 100 million comparisons here, tens of seconds;
    // the index takes a fraction of one. The limit sits far from both.
    const stored = [];
    const groups = [];
    for (let b = 0; b < 10000; b++) {
      const hashList = Array.from({ length: 12 }, (_v, i) => `k${b}-${i}`);
      stored.push(book(`id${b}`, `Old/${b}`, hashList));
      groups.push(group(`New/${b}`, hashList));
    }
    const started = process.hrtime.bigint();
    const result = match(stored, groups);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.books.every((b, i) => b.id === `id${i}`), true);
    assert.deepEqual(result.missing, []);
    assert.ok(ms < 5000, `matching took ${ms.toFixed(0)} ms`);
  });
});
