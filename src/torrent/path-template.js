// Per-vpath path templates. An operator-supplied string like
//
//   {{ARTIST}}/{{ALBUM}} ({{YEAR}})
//
// renders to a relative destination path when the player adds a
// torrent. Resolution happens on both sides: the player UI renders
// a live preview as the operator edits the metadata fields, and the
// server re-validates the resolved path inside POST /torrent/add as
// defence-in-depth (an attacker editing the form bypass the client-
// side helper).
//
// This file owns the syntax + sanitisation rules. Both the admin
// validator (PUT /admin/torrent/path-templates/:vpath) and the
// player resolver consume the same exports here so the two stay in
// lockstep — a template that validates on save must resolve cleanly
// when applied, and vice-versa.
//
// Wire-format implications: the VARIABLE_NAMES are part of the
// public contract. Adding a name here is safe; renaming one breaks
// every existing template referencing the old name. The renderer
// is case-insensitive, but stored templates keep the operator's
// casing so the admin UI round-trips what they typed.

// ── Variable allowlist ───────────────────────────────────────────────
// The pipeline-extracted metadata names that templates can reference.
// Order is canonical: when we render the "available variables" help
// text in the admin UI, we iterate this array.
export const SUPPORTED_VARS = Object.freeze([
  'ARTIST',
  'ALBUM',
  'YEAR',
  'GENRE',
  'ALBUMARTIST',
]);

const _SUPPORTED_SET = new Set(SUPPORTED_VARS);

// Suggested template the admin UI offers as a "use suggested" preset
// when the operator hasn't typed anything yet. Conservative — works
// against any metadata that has at least artist + album. Matches the
// most common library layouts (Plex, Sonarr, foobar2000).
export const SUGGESTED_TEMPLATE = '{{ARTIST}}/{{ALBUM}} ({{YEAR}})';

// Sample metadata used by the admin UI's live preview AND by the
// server-side validator's sample-resolve step. Picked to exercise
// every variable, including ones that often come back empty in real
// metadata (GENRE / ALBUMARTIST). Mirroring the player's actual
// metadata shape so the same renderer code paths run.
export const SAMPLE_METADATA = Object.freeze({
  artist:      'Pink Floyd',
  album:       'The Dark Side of the Moon',
  year:        '1973',
  genre:       'Progressive Rock',
  albumartist: 'Pink Floyd',
});

const _MAX_TEMPLATE_LEN = 500;
const _MAX_RESOLVED_LEN = 500;
const _MAX_SEGMENT_LEN  = 200;

// Slug-sanitise a single substituted value. The same rules the
// existing _validateDirectoryName / _validateSubPath enforce on the
// final path: no separators, no traversal, no control chars, no
// drive letters. Path separators within a substituted value (e.g.
// an artist literally named "AC/DC") collapse to '-'; control chars
// and NUL get stripped; surrounding whitespace + dots trimmed.
export function sanitizeSegment(raw) {
  if (raw == null) { return ''; }
  let s = String(raw);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > _MAX_SEGMENT_LEN) { s = s.slice(0, _MAX_SEGMENT_LEN); }
  return s;
}

// Pull the {{VAR}} tokens out of a template string. Returns an
// ordered list of `{name, raw, start, end}` for each match. Names
// are upper-cased for lookup against SUPPORTED_VARS; raw is what
// the operator typed (used in error messages).
function _scanTokens(template) {
  const out = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    out.push({ name: m[1].toUpperCase(), raw: m[0], start: m.index, end: re.lastIndex });
  }
  return out;
}

/**
 * Validate that a template only uses known variables and has matching
 * braces. Returns `{ valid: true }` on success, otherwise
 * `{ valid: false, error, message }`. Cheap — pure string ops, no
 * sample-resolve. The caller is expected to follow up with a
 * sample-resolve (`resolveTemplate(template, SAMPLE_METADATA)`) and
 * validate the resolved path via `validateResolvedPath`.
 */
export function validateTemplate(template) {
  if (typeof template !== 'string') {
    return { valid: false, error: 'invalid_type', message: 'Template must be a string' };
  }
  if (template.length === 0) {
    // Empty is allowed at the storage layer (means "no template"),
    // but a caller validating an explicit input usually wants to
    // reject this — let them check `.empty` and decide.
    return { valid: true, empty: true };
  }
  if (template.length > _MAX_TEMPLATE_LEN) {
    return { valid: false, error: 'template_too_long', message: `Template exceeds ${_MAX_TEMPLATE_LEN} characters` };
  }
  // Spurious braces (unbalanced or single-brace tokens) — easy to make,
  // confusing to debug. Reject loudly.
  const tokens = _scanTokens(template);
  // Strip the matched tokens and check what's left for stray braces.
  let stripped = template;
  for (const t of tokens) {
    stripped = stripped.replace(t.raw, '');
  }
  if (stripped.includes('{') || stripped.includes('}')) {
    return { valid: false, error: 'unbalanced_braces', message: 'Template has stray { or } — variables must use {{NAME}} (double braces)' };
  }
  for (const t of tokens) {
    if (!_SUPPORTED_SET.has(t.name)) {
      return {
        valid: false, error: 'unknown_variable',
        message: `Unknown variable ${t.raw}. Supported: ${SUPPORTED_VARS.map(v => '{{' + v + '}}').join(', ')}`,
      };
    }
  }
  // Path-separator characters are allowed in the literal text (that's
  // how operators define hierarchy). But null bytes / control chars
  // in the literals would survive substitution and reach the
  // resolved path's validator; catch them here for a clearer error.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(template)) {
    return { valid: false, error: 'invalid_chars', message: 'Template cannot contain control characters' };
  }
  // Leading / or \ would silently get stripped by the resolver's
  // split-filter-join pass — operators typing absolute paths almost
  // certainly meant something different, so reject explicitly with
  // a clear message rather than quietly transforming the path.
  if (template.startsWith('/') || template.startsWith('\\')) {
    return { valid: false, error: 'absolute_template', message: 'Template cannot start with / or \\ — paths are relative to the library root' };
  }
  return { valid: true };
}

/**
 * Resolve a template against a metadata object. Returns
 * `{ path, missingVars }`:
 *   - `path` is the rendered relative path string with empty segments
 *     dropped, segments slug-sanitised, and excess whitespace trimmed.
 *     May be an empty string when every variable is empty AND the
 *     template has no literal text — caller decides what to do.
 *   - `missingVars` is the subset of variables that resolved to empty
 *     (so the UI can render a warning like "year was empty — segment
 *     dropped"). De-duplicated.
 *
 * Pure / synchronous / no I/O. Safe to call from anywhere.
 *
 * Strategy: substitute the tokens, then walk the result by path
 * separator boundaries (/ or \), drop segments that came out empty
 * after sanitisation, and re-join with '/'. This way an empty
 * {{YEAR}} collapses `Artist - {{YEAR}}` to `Artist -` (which then
 * trims trailing whitespace) rather than producing `Artist - /Album`
 * with an awkward dangling separator.
 */
export function resolveTemplate(template, metadata) {
  if (!template || typeof template !== 'string') {
    return { path: '', missingVars: [] };
  }
  const meta = metadata || {};
  const lookup = {
    ARTIST:      sanitizeSegment(meta.artist),
    ALBUM:       sanitizeSegment(meta.album),
    YEAR:        sanitizeSegment(meta.year),
    GENRE:       sanitizeSegment(meta.genre),
    // ALBUMARTIST falls back to ARTIST when not provided — typical
    // library convention since compilation-album fields are rare.
    ALBUMARTIST: sanitizeSegment(meta.albumartist || meta.artist),
  };
  const missing = new Set();
  const substituted = template.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (raw, name) => {
      const key = name.toUpperCase();
      const v = lookup[key];
      if (v == null || v === '') {
        missing.add(key);
        return '';
      }
      return v;
    }
  );

  // Split by either separator (operators on Windows might paste \).
  // Trim each segment; drop empties; rejoin with '/' (POSIX-style;
  // the downstream daemon path is built with '/' too).
  const segments = substituted.split(/[/\\]+/).map(s => s.trim()).filter(s => s.length > 0);
  let path = segments.join('/');
  if (path.length > _MAX_RESOLVED_LEN) { path = path.slice(0, _MAX_RESOLVED_LEN); }
  return { path, missingVars: Array.from(missing) };
}

/**
 * Defence-in-depth check on a resolved path. The template + variable
 * sanitisation should already prevent every disallowed character, but
 * the resolved path goes through one more pass to catch anything the
 * substitution might have produced (e.g. a literal in the template
 * containing `..` between two empty-variable drops).
 *
 * Returns `{ valid: true }` or `{ valid: false, error, message }`.
 * The error codes match what /torrent/add returns so the UI's existing
 * error rendering handles them uniformly.
 */
export function validateResolvedPath(path) {
  if (typeof path !== 'string') {
    return { valid: false, error: 'invalid_type', message: 'Resolved path must be a string' };
  }
  if (path.length === 0) {
    return { valid: false, error: 'empty_path', message: 'Template resolved to an empty path. Check that the variables you used have values, or add literal text.' };
  }
  if (path.length > _MAX_RESOLVED_LEN) {
    return { valid: false, error: 'path_too_long', message: `Resolved path exceeds ${_MAX_RESOLVED_LEN} characters` };
  }
  // Same rules as _validateSubPath / _validateDirectoryName — keep
  // them in sync. eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) {
    return { valid: false, error: 'invalid_chars', message: 'Resolved path cannot contain control characters' };
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    return { valid: false, error: 'absolute_path', message: 'Resolved path cannot start with / or \\' };
  }
  if (/^[a-zA-Z]:/.test(path)) {
    return { valid: false, error: 'drive_letter', message: 'Resolved path cannot start with a drive letter' };
  }
  // No tilde/home-expansion strings. We never shell out, but
  // ~ + $HOME in a path are easy to typo into a template and the
  // operator's intent is almost certainly NOT to write a literal
  // tilde directory at the root of their library.
  if (path.includes('~') || /\$HOME\b/.test(path) || /\$\{HOME\}/.test(path)) {
    return { valid: false, error: 'home_string', message: 'Resolved path cannot contain ~ or $HOME (no shell-style expansion)' };
  }
  const segs = path.split(/[/\\]/);
  for (const seg of segs) {
    if (seg === '..') {
      return { valid: false, error: 'traversal', message: 'Resolved path cannot contain .. segments' };
    }
    if (/^[a-zA-Z]:/.test(seg)) {
      return { valid: false, error: 'drive_letter_segment', message: 'Resolved path segments cannot start with a drive letter' };
    }
  }
  return { valid: true };
}

/**
 * One-shot validate-and-resolve. Used by the admin PUT endpoint to
 * confirm a template:
 *   - parses cleanly (validateTemplate)
 *   - non-empty (operator-supplied templates can't be blank)
 *   - resolves to a safe non-empty path under SAMPLE_METADATA
 *
 * Returns `{ valid: true, sample: <resolved path> }` on success or
 * `{ valid: false, error, message }` otherwise.
 */
export function validateForSave(template) {
  const synt = validateTemplate(template);
  if (!synt.valid) { return synt; }
  if (synt.empty) {
    return { valid: false, error: 'empty_template', message: 'Template is required. Leave the field blank in the UI to remove the template.' };
  }
  const { path: sample } = resolveTemplate(template, SAMPLE_METADATA);
  const pathCheck = validateResolvedPath(sample);
  if (!pathCheck.valid) { return pathCheck; }
  return { valid: true, sample };
}
