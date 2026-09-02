'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { abbrevFor, CATEGORY_EN } = require('../services/gtfs/categoryDisplay');

test('bg (or unset/unrecognized language) returns the category unchanged', () => {
    assert.strictEqual(abbrevFor('ПВ', 'bg'), 'ПВ');
    assert.strictEqual(abbrevFor('ПВ', undefined), 'ПВ');
    assert.strictEqual(abbrevFor('ПВ', 'fr'), 'ПВ');
});

test('en maps every known category to its abbreviation', () => {
    for (const [bg, en] of Object.entries(CATEGORY_EN)) {
        assert.strictEqual(abbrevFor(bg, 'en'), en);
    }
});

test('en falls back to the original category for an unknown one, rather than dropping it', () => {
    assert.strictEqual(abbrevFor('ХЗ', 'en'), 'ХЗ');
});
