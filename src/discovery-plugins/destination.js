// The collection destination — where files the acquire plug-ins land: a
// collection copy from a paired peer (plugins/federation-copy.js) and a
// YouTube download (plugins/youtube.js). One per user, shared by every
// acquire plug-in, so it lives here rather than in any one of them (design
// card 10).
//
// A destination is a LIBRARY the user may upload to, a BASE FOLDER inside it
// ('' = the root) and a LAYOUT rendered from the song's tags by the torrent
// path-template engine ({{ALBUMARTIST}}/{{ALBUM}}, plus {{PEER}} for the server a
// copy came from and {{SERVERFOLDER}} for the folders the song sits in there
// — empty, so dropped, for anything else). Unset means the
// library default: the library's admin Path Template when one exists, else
// {{ALBUMARTIST}}/{{ALBUM}} at the root — the album's credit, which falls back
// to the song's artist, so a compilation lands in ONE folder ("Various
// Artists/…") and every other album exactly where {{ARTIST}}/{{ALBUM}} put it
// (2026-10-19). The credit is the file's tag, else the one the copy or the
// download knows for the album (tagsForLayout), so a song without the tag
// lands with its album too (2026-10-22). The file keeps its name.
//
// Stored per user in user_settings (namespace below). In public mode the
// anonymous account keeps the one shared setting. A job takes the effective
// destination with it when it is asked for (the job route pins it in the
// job's params; destinationForJob reads it back), so changing the setting
// moves only the jobs asked for after.

import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as settingsDb from '../db/user-settings.js';
import * as pathTemplate from '../torrent/path-template.js';
import WebError from '../util/web-error.js';

export const NAMESPACE = 'discovery:collection';
export const KEY = 'destination';
export const DEFAULT_LAYOUT = '{{ALBUMARTIST}}/{{ALBUM}}';
const EXTRA_VARS = [pathTemplate.EXTRA_VARS.PEER, pathTemplate.EXTRA_VARS.SERVERFOLDER];
export const LAYOUT_VARS = Object.freeze([...pathTemplate.SUPPORTED_VARS, ...EXTRA_VARS]);
// SERVERFOLDER's sample is two folders, as a song in a peer's library
// usually sits, so a layout of just {{SERVERFOLDER}} validates.
const SAMPLE = Object.freeze({ ...pathTemplate.SAMPLE_METADATA, peer: "Sam's server", serverfolder: 'Pink Floyd/The Dark Side of the Moon' });

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

// The sample is checked whole: renderTarget refuses a path past the cap,
// so a layout whose sample alone passes it would save and then fail every
// copy.
export function validateLayout(layout) {
  return pathTemplate.validateForSave(layout, { extraVars: EXTRA_VARS, sampleMetadata: SAMPLE, truncate: false });
}

// A base folder's folders as written, not yet checked: either separator,
// names trimmed, empty ones gone.
function baseFolders(base) {
  return String(base == null ? '' : base).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
}

// A base folder is a relative path inside the library ('' = the root),
// under the same rules as a resolved template path, so nothing climbs out.
export function normalizeBase(base) {
  const raw = baseFolders(base);
  if (raw === '') { return { valid: true, base: '' }; }
  const check = pathTemplate.validateResolvedPath(raw);
  if (!check.valid) { return { valid: false, error: check.error, message: check.message }; }
  return { valid: true, base: raw };
}

// A layout's leading folders that name no variable — where every copy
// filed by the layout lands whatever its tags ("From friends/{{ALBUMARTIST}}"
// → "From friends"), trimmed as the layout renders them, '' when the layout
// starts with a variable. A folder copy as it is on the peer lands under
// them too (plugins/federation-copy.js landingFor), so a layout that keeps
// copies in a folder of their own keeps that one there as well. Not checked
// here: a validated layout's are a prefix of its sample path, and the
// mirror checks the whole of its path. (The clients' previews copy it:
// webapp discover-jobs.js layoutLead.)
export function layoutLead(layout) {
  const folders = [];
  for (const seg of String(layout == null ? '' : layout).split(/[/\\]+/)) {
    if (seg.includes('{') || seg.includes('}')) { break; }
    folders.push(seg);
  }
  return baseFolders(folders.join('/'));
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

// A destination a caller supplied to save: the schema has passed; this is
// the meaning. Throws a 400 the client can show.
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

// Whether a destination a client showed is the one in force (the job
// route's check, so files never land somewhere the client did not show):
// the same library, the same base folder as normalizeBase reads it ('From
// peers/' is 'From peers') and the same layout, character for character.
// `source` is not compared. null matches only null.
export function sameDestination(shown, effective) {
  if (!shown || !effective) { return !shown && !effective; }
  const a = normalizeBase(shown.base);
  const b = normalizeBase(effective.base);
  return shown.vpath === effective.vpath && a.valid && b.valid && a.base === b.base && shown.layout === effective.layout;
}

// The same check for what a job's own place reads of the destination
// (`landing` is validateLanding's): a folder job given a library and a
// folder of its own reads none of it, so whatever was shown passes (the
// one in force is still pinned with the job); one given only a folder
// reads the library, so only the library is compared; every other job —
// a folder as it is on the peer (the base and the layout's leading
// folders), one filed by tags, a song, an album, an artist — reads all of
// it (sameDestination).
export function sameDestinationFor(shown, effective, landing) {
  if (landing && landing.tags !== true && typeof landing.path === 'string') {
    if (landing.vpath) { return true; }
    return (shown ? shown.vpath : null) === (effective ? effective.vpath : null);
  }
  return sameDestination(shown, effective);
}

// Where a FOLDER job lands, as the caller chose it (the job route's
// `landing`, kept in the job's params): a library the caller may write to
// (absent = the destination's, pinned with the job) and a folder inside
// it under the base folder's rules, or `tags: true` for the layout like any
// other copy. Null when the choice is empty — the folder then lands as it
// is on the peer (plugins/federation-copy.js landingFor). Throws a 400.
export function validateLanding(value, user) {
  if (!value || typeof value !== 'object') { return null; }
  if (value.tags === true) { return { tags: true }; }
  if (typeof value.path !== 'string' && !value.vpath) { return null; }
  const vpath = value.vpath || null;
  if (vpath && !writableLibraries(user).some((l) => l.vpath === vpath)) {
    throw new WebError(`landing: you cannot put files into library '${vpath}'`, 400);
  }
  const dir = normalizeBase(value.path);
  if (!dir.valid) { throw new WebError(`landing folder: ${dir.message}`, 400); }
  return { vpath, path: dir.base };
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

// Where a job's files go: the destination pinned in its params when it was
// asked for (the job route pins the effective one), so a queued job never
// moves when the account's destination changes before it runs. The pin is
// held to the account's rights as they are now: a library the account can
// no longer write to, or a base or layout that no longer validates, fails
// the job (throws) rather than sending it somewhere else. A job asked for
// when there was nowhere (pinned null) has nowhere still, whatever library
// the account was given since. A job queued before jobs were pinned (no
// params.destination) takes the account's effective destination, as it
// always did — null when there is nowhere.
export function destinationForJob(user, params, opts = {}) {
  if (params && params.destination === null) { return null; }
  const pinned = params && params.destination;
  if (!pinned || typeof pinned !== 'object') { return destinationFor(user, savedFor(user), opts); }
  if (!writableLibraries(user, opts).some((l) => l.vpath === pinned.vpath)) {
    throw new Error(`the account may no longer put files into library '${pinned.vpath}', where this job was asked to land`);
  }
  const base = normalizeBase(pinned.base);
  if (!base.valid) { throw new Error(`the destination's base folder no longer validates: ${base.message}`); }
  const layout = validateLayout(pinned.layout);
  if (!layout.valid) { throw new Error(`the destination's layout no longer validates: ${layout.message}`); }
  return { vpath: pinned.vpath, base: base.base, layout: pinned.layout, source: pinned.source || 'user' };
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

// Only audio goes into a library: a plug-in files nothing whose extension
// the server does not list under supportedAudioFiles (a peer's listing, or
// a download, may name anything — an .html in a library is served from
// this origin as a page). `supported` is the config map unless a test
// passes its own.
export function isSupportedAudioFile(fileName, supported) {
  const map = supported || (config.program && config.program.supportedAudioFiles) || {};
  const ext = String(fileName || '').split('/').pop().split('.').slice(1).pop();
  return !!ext && map[ext.toLowerCase()] === true;
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
// where the file has none. {{ALBUMARTIST}} is the file's albumartist tag,
// else the album's credit the caller knows (`rec.albumArtist`: a row's, the
// credit an album copy listed the album by, an artist copy's album's own,
// the peer's for a folder's song filed by tags),
// else none — and the path template then takes the file's artist. A file
// without the tag (common on peers) so lands with its album: a featured
// song ("X feat. Y") and an untagged compilation's songs, each by its own
// artist, under the album's one credit (2026-10-22).
export function tagsForLayout(common, rec = {}) {
  const c = common || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    artist: (c.artist && String(c.artist)) || rec.artist || null,
    album: (c.album && String(c.album)) || rec.album || null,
    title: (c.title && String(c.title)) || rec.title || null,
    year: c.year || rec.year || null,
    genre: first(c.genre) ? String(first(c.genre)) : null,
    albumartist: (c.albumartist && String(c.albumartist)) || rec.albumArtist || null,
  };
}

// Where one song goes: base folder + rendered layout + file name, relative
// to the library root, forward slashes. `serverFolder` is {{SERVERFOLDER}}:
// the folders the song sits in on the server it came from (a copy's
// federation-copy.js serverFolderOf; none for a download). Rendered whole,
// never cut: a path past the engine's cap is refused (path_too_long), as a
// folder copy's mirror of the same folders is, rather than filed under a
// name cut mid-folder that a second song could share.
export function renderTarget({ destination, tags, peerName, serverFolder = null, fileName }) {
  const { path: rendered, missingVars } = pathTemplate.resolveTemplate(destination.layout, {
    artist: tags.artist, album: tags.album, year: tags.year, genre: tags.genre,
    albumartist: tags.albumartist, peer: peerName, serverfolder: serverFolder,
  }, { truncate: false });
  if (rendered) {
    const check = pathTemplate.validateResolvedPath(rendered);
    if (!check.valid) { throw new Error(`the layout rendered an unusable path: ${check.message}`); }
  }
  const relDir = [destination.base, rendered].filter(Boolean).join('/');
  return { relDir, relPath: relDir ? `${relDir}/${fileName}` : fileName, missingVars };
}
