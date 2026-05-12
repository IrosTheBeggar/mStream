// Search query parser and FTS5 expression builder.
//
// Two-phase pipeline consumed by the search route (PR3) and the
// Subsonic search handlers (PR4):
//
//   1. parseSearchQuery splits raw user input into positive and
//      negative term lists, honouring the leading `-` exclusion
//      convention.
//   2. buildFtsExpression converts those term lists into a
//      syntactically valid FTS5 MATCH expression, or returns null
//      when the query is uninteresting for FTS (no alnum tokens
//      survived parsing, the single remaining term is too short to
//      prefix-match meaningfully, an unknown mode was requested).
//      A null return tells the route's `combo` algorithm to fall
//      back to LIKE for that category, and tells `fts5` strict
//      mode to return an empty result for that category.
//
// Not supported on purpose (test file documents each):
//   - Quoted phrases (`"foo bar"`). Tokens split on whitespace.
//   - Wildcards in user input. We always append our own trailing `*`.
//   - Field selectors in user input (`title:foo`). The route picks
//     the column; the user types content.

const ALNUM_RE = /[a-zA-Z0-9]/;

/**
 * Split raw user input into { positive, negative } term arrays.
 *
 * Tokens without any ASCII alnum char are dropped — the FTS5
 * unicode61 tokenizer would strip them to empty, which then
 * triggers a `fts5: syntax error` at prepare time. We filter at
 * the JS layer so the route never builds a malformed expression.
 *
 * A leading `-` flips a token to the negative list, provided the
 * remainder still has at least one alnum char (so `--` and `-`
 * alone are correctly dropped, not treated as empty negatives).
 *
 * Returns empty arrays — never null — so callers can destructure
 * without guards.
 */
export function parseSearchQuery(raw) {
  const positive = [];
  const negative = [];
  if (raw == null) return { positive, negative };

  const parts = String(raw).trim().split(/\s+/);
  for (const t of parts) {
    if (!t) continue;
    if (!ALNUM_RE.test(t)) continue;
    if (t.startsWith('-') && t.length > 1) {
      const neg = t.slice(1);
      if (ALNUM_RE.test(neg)) negative.push(neg);
    } else {
      positive.push(t);
    }
  }

  return { positive, negative };
}

/**
 * Escape a raw term for embedding inside an FTS5 double-quoted phrase.
 * FTS5's only string-literal escape mechanism is doubling internal
 * double-quote characters; everything else (parens, operators,
 * Unicode, punctuation) is safe inside a `"..."` phrase.
 */
export function escapeFts(term) {
  return String(term).replace(/"/g, '""');
}

/**
 * Build an FTS5 MATCH expression string, or null when the route
 * should fall back (LIKE in combo mode, empty in strict mode).
 *
 * Inputs:
 *   column   - optional FTS5 column name. When given, each
 *              positive term is wrapped as `{column} : "term"*`.
 *              Negatives are always unscoped — they exclude rows
 *              that match the term anywhere, which is what users
 *              expect from `-word`.
 *   positive - required array of positive terms.
 *   negative - optional array of negative terms (default []).
 *   mode     - 'single' or 'all-words'. Optional; inferred from
 *              positive.length when omitted (1 → 'single',
 *              2+ → 'all-words'). Unknown values return null —
 *              the route doesn't get to silently fall through on
 *              a typo.
 *
 * Returns null when:
 *   - positive is missing / not an array / empty
 *   - exactly one positive token is shorter than 2 chars (FTS5
 *     prefix matching on a single char is noise; LIKE is fine)
 *   - mode is given but isn't one of the supported values
 *
 * Single-char terms inside a multi-word query are kept — a query
 * like "a foo bar" still carries useful signal in the longer
 * tokens, so we don't punish the user for the noise word.
 */
export function buildFtsExpression({ column, positive, negative, mode } = {}) {
  if (!Array.isArray(positive) || positive.length === 0) return null;
  if (positive.length === 1 && positive[0].length < 2) return null;

  const resolvedMode = mode || (positive.length === 1 ? 'single' : 'all-words');
  if (resolvedMode !== 'single' && resolvedMode !== 'all-words') return null;

  const NEG = Array.isArray(negative) ? negative : [];

  const scoped = (term) =>
    column ? `{${column}} : "${escapeFts(term)}"*` : `"${escapeFts(term)}"*`;

  let expr;
  if (resolvedMode === 'single') {
    // Even if the caller asked for 'single' with multiple positives,
    // respect their explicit choice and use only the first term —
    // matches "do what I said, not what I meant" for an internal API.
    expr = scoped(positive[0]);
  } else {
    expr = positive.map(scoped).join(' AND ');
  }

  for (const n of NEG) {
    expr += ` NOT "${escapeFts(n)}"`;
  }

  return expr;
}
