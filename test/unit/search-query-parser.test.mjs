/**
 * Unit tests for the search query parser + FTS5 expression builder.
 *
 * These three exports are the building blocks PR3 (the /api/v1/db/search
 * route changes) and PR4 (Subsonic search) will consume. The route
 * decides between three algorithms — `basic` (LIKE only), `combo`
 * (FTS5 with per-category LIKE fallback), and `fts5` (strict, no
 * fallback) — and uses buildFtsExpression's null return as the signal
 * that combo should fall back / strict should return empty.
 *
 * Style: built-in node:test runner, node:assert/strict — matches the
 * rest of the project's test files.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSearchQuery,
  escapeFts,
  buildFtsExpression,
} from '../../src/util/search-query.js';

describe('parseSearchQuery', () => {
  test('splits positives and negatives on a typical query', () => {
    assert.deepEqual(
      parseSearchQuery('the dark side -live'),
      { positive: ['the', 'dark', 'side'], negative: ['live'] }
    );
  });

  test('drops tokens with no alphanumerics', () => {
    // & has no alnum; -- starts with `-` but slicing leaves "-" which
    // also has no alnum — both must be dropped, leaving empty arrays.
    assert.deepEqual(
      parseSearchQuery('& --'),
      { positive: [], negative: [] }
    );
  });

  test('does not honour quoted phrases (yet)', () => {
    // KNOWN LIMITATION: `"bar baz"` is split on whitespace into two
    // separate tokens. A future iteration should parse balanced quotes
    // as a single phrase term and emit it without the trailing `*`.
    // For now we document the behaviour explicitly so a future change
    // here is a visible test diff, not a silent regression.
    assert.deepEqual(
      parseSearchQuery('foo "bar baz" qux'),
      { positive: ['foo', '"bar', 'baz"', 'qux'], negative: [] }
    );
  });

  test('lone hyphen is dropped (not treated as empty negative)', () => {
    assert.deepEqual(
      parseSearchQuery('-'),
      { positive: [], negative: [] }
    );
  });

  test('lone double-quote is dropped', () => {
    assert.deepEqual(
      parseSearchQuery('"'),
      { positive: [], negative: [] }
    );
  });

  test('empty / whitespace-only input returns empty arrays', () => {
    assert.deepEqual(parseSearchQuery(''),    { positive: [], negative: [] });
    assert.deepEqual(parseSearchQuery('   '), { positive: [], negative: [] });
    assert.deepEqual(parseSearchQuery('\t '), { positive: [], negative: [] });
  });

  test('null / undefined input does not throw', () => {
    assert.deepEqual(parseSearchQuery(null),      { positive: [], negative: [] });
    assert.deepEqual(parseSearchQuery(undefined), { positive: [], negative: [] });
  });

  test('Unicode (Latin extended) terms pass through unmolested', () => {
    // The `é` is not [A-Za-z0-9] but the token contains `c`, `a`, `f`
    // which are — so the alnum gate lets it through and the term is
    // returned byte-identical to input.
    assert.deepEqual(
      parseSearchQuery('café'),
      { positive: ['café'], negative: [] }
    );
  });

  test('pure non-Latin tokens are currently dropped', () => {
    // KNOWN LIMITATION: the alnum gate is ASCII-only, matching velvet's
    // upstream behaviour. A pure CJK token has no [A-Za-z0-9] char so
    // gets filtered out. A future change can swap ALNUM_RE for a
    // Unicode-aware /\p{L}|\p{N}/u; that's out of scope for PR1.
    assert.deepEqual(
      parseSearchQuery('日本'),
      { positive: [], negative: [] }
    );
  });

  test('handles multiple negatives mixed with positives', () => {
    assert.deepEqual(
      parseSearchQuery('pink -wall floyd -live -demo'),
      { positive: ['pink', 'floyd'], negative: ['wall', 'live', 'demo'] }
    );
  });

  test('extra whitespace between tokens collapses cleanly', () => {
    assert.deepEqual(
      parseSearchQuery('  foo    bar  '),
      { positive: ['foo', 'bar'], negative: [] }
    );
  });
});

describe('escapeFts', () => {
  test('plain string passes through unchanged', () => {
    assert.equal(escapeFts('hello world'), 'hello world');
  });

  test('doubles internal double-quote characters', () => {
    // FTS5's only escape mechanism inside a "..." phrase literal is
    // doubling internal quote chars. Everything else stays literal.
    assert.equal(escapeFts('she said "hi"'), 'she said ""hi""');
  });

  test('empty string maps to empty string', () => {
    assert.equal(escapeFts(''), '');
  });

  test('coerces non-string input via String()', () => {
    assert.equal(escapeFts(42), '42');
    assert.equal(escapeFts(null), 'null');
  });

  test('Unicode characters survive unmodified', () => {
    assert.equal(escapeFts('café Sigur Rós'), 'café Sigur Rós');
  });

  test('mixed quotes and Unicode', () => {
    assert.equal(escapeFts('café "té"'), 'café ""té""');
  });
});

describe('buildFtsExpression', () => {
  test('single positive with column produces column-scoped phrase prefix', () => {
    assert.equal(
      buildFtsExpression({ column: 'title', positive: ['hello'], negative: [] }),
      '{title} : "hello"*'
    );
  });

  test('multi-positive all-words with column scopes each term and ANDs', () => {
    // This is the canonical multi-word case PR3 will use for the
    // /api/v1/db/search title category when parseSearchQuery yields
    // ≥2 positives. Each positive gets column-scoped; the NOT term
    // stays unscoped so it excludes rows that match anywhere.
    assert.equal(
      buildFtsExpression({
        column: 'title',
        positive: ['hello', 'world'],
        negative: ['live'],
        mode: 'all-words',
      }),
      '{title} : "hello"* AND {title} : "world"* NOT "live"'
    );
  });

  test('all-words without column produces unscoped AND-joined terms', () => {
    // The cross-field smart-search path (velvet's searchFilesAllWords
    // equivalent): every positive token must match SOME indexed column.
    assert.equal(
      buildFtsExpression({
        positive: ['chaka', 'khan', 'fate'],
        negative: [],
        mode: 'all-words',
      }),
      '"chaka"* AND "khan"* AND "fate"*'
    );
  });

  test('mode defaults to single for one positive, all-words for many', () => {
    assert.equal(
      buildFtsExpression({ column: 'title', positive: ['solo'] }),
      '{title} : "solo"*'
    );
    assert.equal(
      buildFtsExpression({ column: 'title', positive: ['one', 'two'] }),
      '{title} : "one"* AND {title} : "two"*'
    );
  });

  test('negatives appended as unscoped NOT "..." regardless of column', () => {
    assert.equal(
      buildFtsExpression({
        column: 'title',
        positive: ['pink'],
        negative: ['wall', 'live'],
      }),
      '{title} : "pink"* NOT "wall" NOT "live"'
    );
  });

  test('returns null on empty positive list', () => {
    assert.equal(buildFtsExpression({ column: 'title', positive: [] }), null);
  });

  test('returns null when positive is omitted entirely', () => {
    assert.equal(buildFtsExpression({ column: 'title' }), null);
    assert.equal(buildFtsExpression({}), null);
    assert.equal(buildFtsExpression(), null);
  });

  test('returns null when positive is not an array', () => {
    assert.equal(buildFtsExpression({ positive: 'hello' }), null);
    assert.equal(buildFtsExpression({ positive: null }), null);
  });

  test('returns null for a single sub-2-char positive token', () => {
    // FTS5 prefix matching on a single char would return half the
    // library and is slower than the LIKE fallback. Caller falls back.
    assert.equal(buildFtsExpression({ column: 'title', positive: ['a'] }), null);
    assert.equal(buildFtsExpression({ positive: ['x'] }), null);
  });

  test('multi-word query with one short token is still built', () => {
    // The 1-char rule only fires when there's a SINGLE positive. In a
    // multi-word query the other tokens carry signal; the noise word
    // is harmless inside an AND chain.
    assert.equal(
      buildFtsExpression({
        column: 'title',
        positive: ['a', 'foo'],
        mode: 'all-words',
      }),
      '{title} : "a"* AND {title} : "foo"*'
    );
  });

  test('escapes double-quote characters inside terms', () => {
    assert.equal(
      buildFtsExpression({
        column: 'title',
        positive: ['she said "hi"'],
      }),
      '{title} : "she said ""hi"""*'
    );
  });

  test('unknown mode returns null (no silent fallthrough)', () => {
    assert.equal(
      buildFtsExpression({ column: 'title', positive: ['x', 'y'], mode: 'foo' }),
      null
    );
  });

  test('explicit single mode with multiple positives uses only first term', () => {
    // Internal API contract: trust the caller. If they asked for
    // single, give them single — they may be iterating columns and
    // wanted just the first term per call.
    assert.equal(
      buildFtsExpression({
        column: 'title',
        positive: ['first', 'second', 'third'],
        mode: 'single',
      }),
      '{title} : "first"*'
    );
  });

  test('Unicode terms are wrapped, prefixed, and survive unchanged', () => {
    assert.equal(
      buildFtsExpression({ column: 'artist_name', positive: ['Sigur Rós'] }),
      '{artist_name} : "Sigur Rós"*'
    );
  });

  test('combined: parse → build round-trip on a realistic query', () => {
    // End-to-end sanity check: pipe parseSearchQuery's output directly
    // into buildFtsExpression — the way PR3's route handler will call
    // them — and assert the assembled FTS expression matches what
    // SQLite will see.
    const parsed = parseSearchQuery('the dark side -live');
    const expr = buildFtsExpression({
      column: 'title',
      positive: parsed.positive,
      negative: parsed.negative,
    });
    assert.equal(
      expr,
      '{title} : "the"* AND {title} : "dark"* AND {title} : "side"* NOT "live"'
    );
  });
});
