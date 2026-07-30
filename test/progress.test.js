'use strict';

/**
 * Unit tests for GPS-to-progress geometry. Uses a simple west→east line so the
 * expected answers are obvious by eye; the maths is the same at rail scale.
 */

const test   = require('node:test');
const assert = require('node:assert');
const progress = require('../services/realtime/progress');

// A straight line heading east along ~42.0°N: lon 25.00 → 25.40, five vertices.
const LINE_PTS = [
    { lat: 42.0, lon: 25.00 },
    { lat: 42.0, lon: 25.10 },
    { lat: 42.0, lon: 25.20 },
    { lat: 42.0, lon: 25.30 },
    { lat: 42.0, lon: 25.40 },
];
// Three stops: start, middle, end.
const STOPS = [
    { lat: 42.0, lon: 25.00 }, // A
    { lat: 42.0, lon: 25.20 }, // B
    { lat: 42.0, lon: 25.40 }, // C
];

const line = progress.prepareLine(LINE_PTS);

test('a point between B and C: B passed, C is next, progress > half', () => {
    const pos = { lat: 42.0, lon: 25.30 };
    const r = progress.locate(line, STOPS, pos);
    assert.strictEqual(r.lastPassedIndex, 1, 'B (index 1) is the last passed stop');
    assert.strictEqual(r.nextIndex, 2, 'C (index 2) is next');
    assert.ok(r.progress > 0.5 && r.progress < 1, `progress ${r.progress} should be past halfway`);
});

test('exactly at a stop counts it as passed (tolerance), next moves on', () => {
    const r = progress.locate(line, STOPS, { lat: 42.0, lon: 25.20 });
    assert.strictEqual(r.lastPassedIndex, 1, 'standing at B, B is passed');
    assert.strictEqual(r.nextIndex, 2);
});

test('before the first stop: nothing passed, first stop is next', () => {
    const r = progress.locate(line, STOPS, { lat: 42.0, lon: 25.00 });
    assert.strictEqual(r.lastPassedIndex, 0, 'at A, A itself is passed');
    // just west of A projects to the start → still treat A as next-ish
    const before = progress.locate(line, STOPS, { lat: 42.0, lon: 24.99 });
    assert.strictEqual(before.lastPassedIndex, 0, 'clamped to start; A is the reference');
    assert.ok(before.progress <= 0.02);
});

test('past the last stop: all passed, no next', () => {
    const r = progress.locate(line, STOPS, { lat: 42.0, lon: 25.40 });
    assert.strictEqual(r.lastPassedIndex, 2, 'C is passed');
    assert.strictEqual(r.nextIndex, null, 'nothing after the final stop');
    assert.ok(r.progress > 0.98);
});

test('a point off the line still projects; offset reflects the deviation', () => {
    const onLine  = progress.locate(line, STOPS, { lat: 42.0,  lon: 25.20 });
    const offLine = progress.locate(line, STOPS, { lat: 42.05, lon: 25.20 });
    assert.ok(offLine.offsetMeters > onLine.offsetMeters + 1000, 'off-line point has a larger offset');
    assert.strictEqual(offLine.lastPassedIndex, 1, 'still snaps to B along the route');
});

test('prepareLine rejects a degenerate line', () => {
    assert.throws(() => progress.prepareLine([{ lat: 42, lon: 25 }]));
});
