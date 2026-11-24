// Book rules — which audio files form one audiobook, in what order they
// play, and which stored book a rescan's files belong to. Pure: no database,
// no disk, no config. The audiobook scanner walks a library, reads each
// file's tags and hash, and hands this module plain lists; everything here is
// deterministic given those lists, whatever order they arrive in.
// See docs/audiobooks-plan.md §6 (grouping, file order) and §7 (identity).
//
// A file is { path, album, track, disc, hash }:
//   path    library-relative, '/'-separated ("Author/Title/01.mp3")
//   album   the raw album tag, or null
//   track   the track number tag as an integer, or null
//   disc    the disc number tag as an integer, or null
//   hash    the file's audio hash (matchBooks only)
// Files are passed through untouched, so a caller can hang anything else on
// them (duration, chapters, the other tags).
//
// Grouping (groupBooks):
//   1. A folder is one book: the audio files directly in it.
//   2. Disc folders fold into the folder above them, at any depth. Directly
//      under the library root they form one book.
//   3. Loose files in the library root are never one book: each album tag is
//      a book, and each untagged file is a book of its own.
//   4. A shelf splits by album tag. A shelf is a folder holding several whole
//      books as loose files: every file tagged, two or more tags, each tag's
//      files one unbroken run in path order, no tag on more than
//      SHELF_MAX_FILES_PER_BOOK files.
// The rules are tuned so that a mistake is a merge, not a split. A merge is
// fixed by giving each book its own folder; a split inside one folder cannot
// be fixed by moving files.
//
// A book is addressed by (path, groupKey):
//   one folder, one book         (folder, '')        the root's disc folders: ('', '')
//   one of several in a folder   (folder, album key)
//   a lone file split out        (the file's path, '')
// No two books of one groupBooks call share an address.
//
// File order (orderFiles): disc and track tags when every file has a track
// number and no two files share a disc and track; else the natural order of
// the paths. "CD1/01.mp3 … CD2/01.mp3" with restarting track numbers and no
// disc tags therefore plays in path order.
//
// Identity (matchBooks): a book's id is assigned once and has to survive
// rescans, renames and moves, because offline devices hold it for weeks.
//   1. Content. A stored book and a group that share at least half of the
//      smaller side's files, by hash, are the same book. Pairs are taken
//      strongest first.
//   2. Place. A stored book with no content match keeps its id when a group
//      sits where it was and nothing has claimed that group (a book
//      re-encoded in place).
//   3. New. A group nothing claimed gets a new id.
//   4. Gone. A stored book nothing matched is reported missing, never
//      deleted. If a live book holds at least half of its files, it is
//      reported as merged into that book.
// Content comes before place on purpose: place first hands one book's id to
// another book's files when generically named folders ("Book 1", "Book 2")
// are renumbered.

import { nameKey } from './name-key.js';

// Three files per album tag is a judgment, not a measurement (plan §10).
export const SHELF_MAX_FILES_PER_BOOK = 3;

// ── paths ────────────────────────────────────────────────────────────────

const dirname = (p) => {
  const cut = p.lastIndexOf('/');
  return cut < 0 ? '' : p.slice(0, cut);
};
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

const CHUNKS = /\d+|\D+/g;
const isDigits = (s) => s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;

// One name against another: digit runs by value, everything else by
// lowercased code unit. 0 when they differ only in case or leading zeros.
function compareNames(a, b) {
  const as = a.toLowerCase().match(CHUNKS) || [];
  const bs = b.toLowerCase().match(CHUNKS) || [];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    const xNum = isDigits(x);
    const yNum = isDigits(y);
    if (xNum && yNum) {
      const xv = x.replace(/^0+(?=\d)/, '');
      const yv = y.replace(/^0+(?=\d)/, '');
      if (xv.length !== yv.length) { return xv.length - yv.length; }
      if (xv !== yv) { return xv < yv ? -1 : 1; }
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

// A path as the names to compare, with the last name's extension set aside.
function splitPath(path) {
  const names = path.split('/');
  const last = names[names.length - 1];
  const dot = last.lastIndexOf('.');
  if (dot <= 0) { return { names, extension: '' }; }
  names[names.length - 1] = last.slice(0, dot);
  return { names, extension: last.slice(dot + 1) };
}

// Natural order of two library-relative paths, name by name: "CD2" sorts
// before "CD10", and a name before the longer names it starts, so folder
// "B" comes before "B 2" and "Title.mp3" before "Title 2.mp3". The file
// extension only settles what is left.
//
// Hand-rolled, not Intl.Collator: the order decides each file's place on the
// book timeline, and saved positions point into that timeline. A collator's
// answer depends on the ICU data the runtime ships (Node and the Bun build
// differ, and so do releases), and compared as whole strings it puts
// "A/B 2/…" before "A/B/…". This one is the same everywhere, and total:
// two different paths never compare equal.
export function comparePaths(a, b) {
  const x = splitPath(a);
  const y = splitPath(b);
  const n = Math.min(x.names.length, y.names.length);
  for (let i = 0; i < n; i++) {
    const c = compareNames(x.names[i], y.names[i]);
    if (c !== 0) { return c; }
  }
  if (x.names.length !== y.names.length) { return x.names.length - y.names.length; }
  return compareNames(x.extension, y.extension) || (a < b ? -1 : (a > b ? 1 : 0));
}

// "CD1", "Disc 2", "disk_03", "Part 4", "Pt. 5": the whole name, no more.
const DISC_FOLDER = /^(?:cd|dis[ck]|part|pt)[\s._-]*\d+$/i;

export function isDiscFolderName(name) {
  return DISC_FOLDER.test(name);
}

// ── album tags ───────────────────────────────────────────────────────────

const BRACKETED = /[([][^)\]]*[)\]]/g;
const TRAILING_MARKER = /[\s,:;-]+(?:cd|dis[ck]|part|pt\.?)\s*\d+(?:\s*of\s*\d+)?$/;
const EDGE_SEPARATORS = /^[\s,:;-]+|[\s,:;-]+$/g;

// The key two album tags are compared by: nameKey, with bracketed parts and
// trailing disc or part markers removed. "Title (Disc 1)", "Title - Part 2"
// and "Title (Unabridged)" all give "title". '' means no album tag.
// For comparison only. It is never shown, and it folds different editions
// of one title together on purpose (the merge side).
export function albumTagKey(album) {
  const plain = nameKey(album);
  if (!plain) { return ''; }
  let key = plain.replace(BRACKETED, ' ').replace(EDGE_SEPARATORS, '');
  for (;;) {
    const cut = key.replace(TRAILING_MARKER, '').replace(EDGE_SEPARATORS, '');
    if (cut === key) { break; }
    key = cut;
  }
  key = key.replace(/\s+/g, ' ');
  // A tag that is nothing but markers ("(Disc 1)") still counts as a tag.
  return key || plain;
}

// ── file order ───────────────────────────────────────────────────────────

// Track 0 is a real number here: an intro file is often tagged that way.
const isTrackNumber = (n) => Number.isInteger(n) && n >= 0;
// No disc tag means disc 1, as in the music index (src/db/track-order.js),
// and so does a disc tag of 0.
const discOf = (file) => (Number.isInteger(file.disc) && file.disc >= 1 ? file.disc : 1);

// Whether the tags give a complete order: a track number on every file, and
// no disc and track used twice.
export function hasTagOrder(files) {
  const seen = new Set();
  for (const file of files) {
    if (!isTrackNumber(file.track)) { return false; }
    const slot = `${discOf(file)}/${file.track}`;
    if (seen.has(slot)) { return false; }
    seen.add(slot);
  }
  return true;
}

// A book's files in playing order. Returns a new array.
export function orderFiles(files) {
  if (hasTagOrder(files)) {
    return [...files].sort((a, b) => (discOf(a) - discOf(b)) || (a.track - b.track));
  }
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

// ── grouping ─────────────────────────────────────────────────────────────

// The folder a file's book lives in: its own folder, or the first folder
// above it that is not a disc folder ('' = the library root).
function bookFolderOf(path) {
  let dir = dirname(path);
  while (dir !== '' && isDiscFolderName(basename(dir))) { dir = dirname(dir); }
  return dir;
}

// `files` in path order. Every file tagged, two or more tags, each tag one
// unbroken run, no tag on more than SHELF_MAX_FILES_PER_BOOK files.
function isShelf(files) {
  const counts = new Map();
  let previous = null;
  for (const file of files) {
    const key = albumTagKey(file.album);
    if (!key) { return false; }
    if (key !== previous) {
      if (counts.has(key)) { return false; }
      counts.set(key, 0);
      previous = key;
    }
    const n = counts.get(key) + 1;
    if (n > SHELF_MAX_FILES_PER_BOOK) { return false; }
    counts.set(key, n);
  }
  return counts.size >= 2;
}

// One book per album tag; an untagged file is a book of its own. A book of
// one file is addressed by the file, so the other books beside it can come
// and go without moving it.
function splitByAlbumTag(dir, files, add) {
  const byKey = new Map();
  for (const file of files) {
    const key = albumTagKey(file.album);
    if (!key) { add(file.path, '', [file]); continue; }
    if (!byKey.has(key)) { byKey.set(key, []); }
    byKey.get(key).push(file);
  }
  for (const [key, group] of byKey) {
    if (group.length === 1) { add(group[0].path, '', group); } else { add(dir, key, group); }
  }
}

// files → [{ path, groupKey, files }], the books these files form. Each
// book's `files` are the caller's own objects in playing order. Books come
// back ordered by address, so the result does not depend on the order of
// the input.
export function groupBooks(files) {
  const loose = [];             // directly in the library root
  const folders = new Map();    // book folder → its files
  for (const file of files) {
    if (dirname(file.path) === '') { loose.push(file); continue; }
    const dir = bookFolderOf(file.path);
    if (!folders.has(dir)) { folders.set(dir, []); }
    folders.get(dir).push(file);
  }

  const books = [];
  const add = (path, groupKey, members) => books.push({ path, groupKey, files: orderFiles(members) });
  const byPath = (a, b) => comparePaths(a.path, b.path);

  splitByAlbumTag('', loose.sort(byPath), add);
  for (const [dir, members] of folders) {
    members.sort(byPath);
    // dir '' here is the root seen through its disc folders: always one
    // book, which also keeps ('', album key) for the loose files above.
    if (dir !== '' && isShelf(members)) { splitByAlbumTag(dir, members, add); } else { add(dir, '', members); }
  }

  return books.sort((a, b) => comparePaths(a.path, b.path)
    || (a.groupKey < b.groupKey ? -1 : (a.groupKey > b.groupKey ? 1 : 0)));
}

// ── identity ─────────────────────────────────────────────────────────────

const hashSet = (hashes) => {
  const set = new Set();
  for (const hash of hashes || []) { if (hash != null && hash !== '') { set.add(hash); } }
  return set;
};
const placeKey = (path, groupKey) => JSON.stringify([path, groupKey]);
// On a tie a live book keeps its files before a missing one gets them back,
// and a missing one before a book already merged into another.
const standing = (book) => (book.missing ? (book.mergedInto ? 2 : 1) : 0);

// Matches the groups a scan found to the books already stored.
//
//   stored   [{ id, libraryId, path, groupKey, hashes, missing, mergedInto }]
//            The books to match against: this library's, live and missing,
//            and missing books from anywhere else (a removed library's
//            books come back this way). `hashes` is every hash in the
//            book's file rows. List them oldest first: when two stored
//            books have an equal claim to a group, the earlier one wins.
//   groups   groupBooks' result for this library; each file carries `hash`.
//   options  libraryId — the library being scanned (the place rule only
//            holds inside one library);
//            newId — returns a fresh id for a book never seen before.
//
// Returns
//   books    one per group, in group order: { id, group, stored, matchedBy }.
//            `stored` is the book the id came from, or null for a new one;
//            matchedBy is 'content', 'place' or 'new'. A stored book that
//            shows up here is live again, whatever it was before.
//   missing  one per stored book nothing matched, in `stored` order:
//            { stored, mergedInto }. mergedInto is the id of the live book
//            holding the most of its files, when that is at least half;
//            else whatever it pointed at before; else null.
//
// Nothing is deleted and nothing is written; the caller applies the answer.
export function matchBooks(stored, groups, { libraryId = null, newId } = {}) {
  if (typeof newId !== 'function') { throw new TypeError('matchBooks: options.newId must be a function'); }

  const groupHashes = groups.map((group) => hashSet(group.files.map((file) => file.hash)));
  const groupsByHash = new Map();
  groupHashes.forEach((hashes, gi) => {
    for (const hash of hashes) {
      if (!groupsByHash.has(hash)) { groupsByHash.set(hash, []); }
      groupsByHash.get(hash).push(gi);
    }
  });

  const inThisLibrary = (book) => (book.libraryId ?? null) === (libraryId ?? null);
  const samePlace = (book, group) => inThisLibrary(book)
    && book.path === group.path && book.groupKey === group.groupKey;

  // Files each stored book shares with each group: shared[si] is gi → count.
  const storedSizes = [];
  const shared = stored.map((book, si) => {
    const hashes = hashSet(book.hashes);
    storedSizes[si] = hashes.size;
    const counts = new Map();
    for (const hash of hashes) {
      for (const gi of groupsByHash.get(hash) || []) { counts.set(gi, (counts.get(gi) || 0) + 1); }
    }
    return counts;
  });

  // 1. Content, strongest pair first: most shared files, then same place,
  //    then the stored book's standing, then the order the books came in.
  const pairs = [];
  shared.forEach((counts, si) => {
    for (const [gi, n] of counts) {
      if (n * 2 >= Math.min(storedSizes[si], groupHashes[gi].size)) {
        pairs.push({ si, gi, n, same: samePlace(stored[si], groups[gi]) ? 1 : 0, standing: standing(stored[si]) });
      }
    }
  });
  pairs.sort((a, b) => (b.n - a.n) || (b.same - a.same) || (a.standing - b.standing)
    || (a.si - b.si) || (a.gi - b.gi));

  const claims = new Array(groups.length).fill(null);   // gi → { si, by }
  const matched = new Set();                            // stored indexes
  for (const { si, gi } of pairs) {
    if (claims[gi] === null && !matched.has(si)) {
      claims[gi] = { si, by: 'content' };
      matched.add(si);
    }
  }

  // 2. Place, for the stored books content did not find.
  const groupAt = new Map();
  groups.forEach((group, gi) => groupAt.set(placeKey(group.path, group.groupKey), gi));
  const leftover = stored.map((_book, si) => si).filter((si) => !matched.has(si))
    .sort((a, b) => (standing(stored[a]) - standing(stored[b])) || (a - b));
  for (const si of leftover) {
    const book = stored[si];
    if (!inThisLibrary(book)) { continue; }
    const gi = groupAt.get(placeKey(book.path, book.groupKey));
    if (gi !== undefined && claims[gi] === null) {
      claims[gi] = { si, by: 'place' };
      matched.add(si);
    }
  }

  // 3. New.
  const books = groups.map((group, gi) => {
    const claim = claims[gi];
    return claim
      ? { id: stored[claim.si].id, group, stored: stored[claim.si], matchedBy: claim.by }
      : { id: newId(), group, stored: null, matchedBy: 'new' };
  });

  // 4. Gone. A live book holding at least half of a gone book's files is
  //    where that book went (copied first, the original deleted later).
  const missing = [];
  stored.forEach((book, si) => {
    if (matched.has(si)) { return; }
    let heir = null;
    for (const [gi, n] of shared[si]) {
      if (n * 2 < storedSizes[si]) { continue; }
      if (heir === null || n > heir.n || (n === heir.n && gi < heir.gi)) { heir = { gi, n }; }
    }
    missing.push({ stored: book, mergedInto: heir ? books[heir.gi].id : (book.mergedInto ?? null) });
  });

  return { books, missing };
}
