/**
 * V71 artist name normalisation — the identity key and the sort key.
 * rust-parser/src/main.rs mirrors both functions; the scanner-parity
 * snapshot compares their outputs across engines on real files.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, orderName, IGNORED_ARTICLES } from '../../src/db/name-key.js';

describe('nameKey', () => {
  test('folds case, surrounding and internal whitespace', () => {
    assert.equal(nameKey('Beatles'), 'beatles');
    assert.equal(nameKey('  The  Beatles \t'), 'the beatles');
    assert.equal(nameKey('BEATLES'), 'beatles');
  });

  test('folds Unicode quote and dash variants onto ASCII', () => {
    assert.equal(nameKey('Guns N’ Roses'), "guns n' roses");
    assert.equal(nameKey('Guns N‘ Roses'), "guns n' roses");
    assert.equal(nameKey('“Weird Al” Yankovic'), '"weird al" yankovic');
    assert.equal(nameKey('Sigur Rós – Live'), 'sigur rós - live');
    assert.equal(nameKey('A—B'), 'a-b');
    assert.equal(nameKey('x − y'), 'x - y');
  });

  test('does NOT fold diacritics, punctuation or ampersands (those separate real artists)', () => {
    assert.notEqual(nameKey('Beyoncé'), nameKey('Beyonce'));
    assert.notEqual(nameKey('R.E.M.'), nameKey('REM'));
    assert.notEqual(nameKey('Simon & Garfunkel'), nameKey('Simon and Garfunkel'));
    assert.notEqual(nameKey('AC/DC'), nameKey('ACDC'));
  });

  test('tolerates null / non-string input', () => {
    assert.equal(nameKey(null), '');
    assert.equal(nameKey(undefined), '');
    assert.equal(nameKey(42), '42');
  });
});

describe('orderName', () => {
  test('is the key of the sort tag when one exists', () => {
    assert.equal(orderName('The Beatles', 'Beatles, The'), 'beatles, the');
    assert.equal(orderName('Solo Artist', 'Artist, Solo'), 'artist, solo');
  });

  test('falls back to the name with one leading article dropped', () => {
    assert.equal(orderName('The Beatles'), 'beatles');
    assert.equal(orderName('The Beatles', null), 'beatles');
    assert.equal(orderName('The Beatles', ''), 'beatles');
    assert.equal(orderName('The Beatles', '   '), 'beatles', 'a blank sort tag is no sort tag');
    assert.equal(orderName('Los Lobos'), 'lobos');
    assert.equal(orderName('Les Rita Mitsouko'), 'rita mitsouko');
  });

  test('strips only a whole leading article, never a prefix or a second one', () => {
    assert.equal(orderName('Theatre of Tragedy'), 'theatre of tragedy');
    assert.equal(orderName('The'), 'the', 'a name that IS an article stays');
    assert.equal(orderName('The The'), 'the', 'only one article goes');
    assert.equal(orderName('Los Angeles Azules'), 'angeles azules');
  });

  test('the article list is the conservative one (no one-letter articles)', () => {
    assert.deepEqual(IGNORED_ARTICLES, ['the', 'el', 'la', 'los', 'las', 'le', 'les']);
    assert.equal(orderName('A Tribe Called Quest'), 'a tribe called quest');
    assert.equal(orderName('Os Mutantes'), 'os mutantes');
  });
});
