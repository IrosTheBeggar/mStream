// The collection destination — where files the acquire plug-ins land: a
// collection copy from a paired peer (plugins/federation-copy.js) and a
// YouTube download (plugins/youtube.js). One per user, shared by every
// acquire plug-in, so it lives here rather than in any one of them (design
// card 10).
//
// A destination is a LIBRARY the user may upload to, a BASE FOLDER inside it
// ('' = the root) and a LAYOUT rendered from the song's tags by the torrent
// path-template engine ({{ARTIST}}/{{ALBUM}}, plus {{PEER}} for the server a
// copy came from — empty, so dropped, for anything else). Unset means the
// library default: the library's admin Path Template when one exists, else
// {{ARTIST}}/{{ALBUM}} at the root. The file keeps its name.
//
// Stored per user in user_settings (namespace below). In public mode the
// anonymous account keeps the one shared setting.

import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as settingsDb from '../db/user-settings.js';
import * as pathTemplate from '../torrent/path-template.js';
import WebError from '../util/web-error.js';

export const NAMESPACE = 'discovery:collection';
export const KEY = 'destination';
export const DEFAULT_LAYOUT = '{{ARTIST}}/{{ALBUM}}';
export const LAYOUT_VARS = Object.freeze([...pathTemplate.SUPPORTED_VARS, pathTemplate.EXTRA_VARS.PEER]);
const EXTRA_VARS = [pathTemplate.EXTRA_VARS.PEER];
const SAMPLE = Object.freeze({ ...pathTemplate.SAMPLE_METADATA, peer: "Sam's server" });

export const destinationSchema = Joi.object({
  vpath: Joi.string().min(1).max(200).required(),
  base: Joi.string().allow('').max(500).default(''),
  layout: Joi.string().min(1).max(500).required(),
});

// Putting a file into a library is an upload by another road: the server
// switch and the user's allow_upload both apply.
export function uploadsAllowed(user, { noUpload } = {}) {
  const serverOff = noUpload === undefined ? !!(config.program && config.program.noUpload) : noUpload;
  if (serverOff) { return false; }
  return !(user && (user.allow_upload === false || user.allow_upload === 0));
}

// The user an acquire job runs for, rebuilt from the id the job carries (the
// request that queued it is gone): what auth.js gives a request, the row
// plus vpaths. The anonymous sentinel (public mode) sees every library and
// uploads like the operator it is, unless the admin is locked.
export function userForJob(userId) {
  const anonId = db.getAnonymousUserId();
  if (userId != null && anonId != null && userId === anonId) {
    const sentinel = db.getAnonymousUser() || { id: anonId };
    const locked = !!(config.program && config.program.lockAdmin === true);
    return { ...sentinel, id: anonId, allow_upload: locked ? 0 : 1, admin: !locked, vpaths: db.getAllLibraries().map((l) => l.name) };
  }
  const row = db.getAllUsers().find((u) => u.id === userId);
  if (!row) { return null; }
  const libIds = db.getUserLibraryIds(row);
  return { ...row, admin: row.is_admin === 1, vpaths: db.getAllLibraries().filter((l) => libIds.includes(l.id)).map((l) => l.name) };
}

// The libraries this user may put files into, each with its admin Path
// Template (libraries.torrent_path_template — the template torrents use).
export function writableLibraries(user, { libraries, noUpload } = {}) {
  if (!user || !Array.isArray(user.vpaths) || !uploadsAllowed(user, { noUpload })) { return []; }
  const all = libraries || db.getAllLibraries();
  return all
    .filter((lib) => user.vpaths.includes(lib.name))
    .map((lib) => ({ vpath: lib.name, template: lib.torrent_path_template || null }));
}

export function validateLayout(layout) {
  return pathTemplate.validateForSave(layout, { extraVars: EXTRA_VARS, sampleMetadata: SAMPLE });
}

// A base folder is a relative path inside the library ('' = the root),
// under the same rules as a resolved template path, so nothing climbs out.
export function normalizeBase(base) {
  const raw = String(base == null ? '' : base).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
  if (raw === '') { return { valid: true, base: '' }; }
  const check = pathTemplate.validateResolvedPath(raw);
  if (!check.valid) { return { valid: false, error: check.error, message: check.message }; }
  return { valid: true, base: raw };
}

// The effective destination: the saved one while it still makes sense (the
// library is still the user's, the layout still validates), else the library
// default. null when there is nowhere to put a file.
export function destinationFor(user, saved, opts = {}) {
  const libs = writableLibraries(user, opts);
  if (libs.length === 0) { return null; }
  if (saved && typeof saved === 'object') {
    const lib = libs.find((l) => l.vpath === saved.vpath);
    const base = normalizeBase(saved.base);
    if (lib && base.valid && typeof saved.layout === 'string' && validateLayout(saved.layout).valid) {
      return { vpath: lib.vpath, base: base.base, layout: saved.layout, source: 'user' };
    }
  }
  const lib = libs[0];
  return { vpath: lib.vpath, base: '', layout: lib.template || DEFAULT_LAYOUT, source: 'default' };
}

// A destination a caller supplied (to save, or for one Keep…): the schema
// has passed; this is the meaning. Throws a 400 the client can show.
export function validateDestination(value, user) {
  const libs = writableLibraries(user);
  if (!libs.some((l) => l.vpath === value.vpath)) {
    throw new WebError(`destination: you cannot put files into library '${value.vpath}'`, 400);
  }
  const base = normalizeBase(value.base);
  if (!base.valid) { throw new WebError(`destination base folder: ${base.message}`, 400); }
  const layout = validateLayout(value.layout);
  if (!layout.valid) { throw new WebError(`destination layout: ${layout.message}`, 400); }
  return { vpath: value.vpath, base: base.base, layout: value.layout, source: 'request' };
}

function ownerId(user) {
  return user && Number.isInteger(user.id) && user.id > 0 ? user.id : null;
}

function savedFor(user) {
  const id = ownerId(user);
  return id === null ? null : (settingsDb.getUserSetting(id, NAMESPACE, KEY) || null);
}

export function getDestination(user) {
  return destinationFor(user, savedFor(user));
}

// What a client needs to draw the destination bar and the picker.
export function describeDestination(user) {
  const saved = savedFor(user);
  return {
    destination: destinationFor(user, saved),
    saved,
    libraries: writableLibraries(user),
    defaultLayout: DEFAULT_LAYOUT,
    variables: [...LAYOUT_VARS],
  };
}

// value = a schema-checked destination, or null to go back to the default.
export function saveDestination(user, value) {
  const id = ownerId(user);
  if (id === null) { throw new WebError('a destination needs a user account to be kept under', 403); }
  if (value === null) {
    settingsDb.deleteUserSetting(id, NAMESPACE, KEY);
    return;
  }
  validateDestination(value, user);
  settingsDb.setUserSetting(id, NAMESPACE, KEY, { vpath: value.vpath, base: value.base || '', layout: value.layout });
}

// A file name kept — minus anything a path must not carry.
export function safeFileName(filePath) {
  const base = String(filePath || '').split('/').filter(Boolean).pop() || '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  if (name === '' || name === '..') { name = 'track'; }
  return name;
}

// The tags a layout renders from: the file's own, the recommendation's
// where the file has none.
export function tagsForLayout(common, rec = {}) {
  const c = common || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    artist: (c.artist && String(c.artist)) || rec.artist || null,
    album: (c.album && String(c.album)) || rec.album || null,
    title: (c.title && String(c.title)) || rec.title || null,
    year: c.year || rec.year || null,
    genre: first(c.genre) ? String(first(c.genre)) : null,
    albumartist: c.albumartist ? String(c.albumartist) : null,
  };
}

// Where one song goes: base folder + rendered layout + file name, relative
// to the library root, forward slashes.
export function renderTarget({ destination, tags, peerName, fileName }) {
  const { path: rendered, missingVars } = pathTemplate.resolveTemplate(destination.layout, {
    artist: tags.artist, album: tags.album, year: tags.year, genre: tags.genre,
    albumartist: tags.albumartist, peer: peerName,
  });
  if (rendered) {
    const check = pathTemplate.validateResolvedPath(rendered);
    if (!check.valid) { throw new Error(`the layout rendered an unusable path: ${check.message}`); }
  }
  const relDir = [destination.base, rendered].filter(Boolean).join('/');
  return { relDir, relPath: relDir ? `${relDir}/${fileName}` : fileName, missingVars };
}
