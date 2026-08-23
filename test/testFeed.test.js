'use strict';

/**
 * testFeed.js exists specifically so a synthetic test train can never be
 * confused with — or corrupt data for — a real one. These tests are mostly
 * about that guarantee, not the data plumbing itself.
 */

const test   = require('node:test');
const assert = require('node:assert');

const testFeed = require('../services/liveactivity/testFeed');

test.afterEach(() => testFeed.clearAll());

test('isTestTrain: only the reserved prefix counts', () => {
    assert.strictEqual(testFeed.isTestTrain('TEST-LEG1'), true);
    assert.strictEqual(testFeed.isTestTrain('10112'), false, 'a real BDZ number is always plain digits');
    assert.strictEqual(testFeed.isTestTrain('90100'), false);
    assert.strictEqual(testFeed.isTestTrain(''), false);
    assert.strictEqual(testFeed.isTestTrain(undefined), false);
});

test('set: refuses any train number outside the reserved namespace', () => {
    assert.throws(() => testFeed.set('10112', { trip: { stops: [] } }), /refused/);
    assert.throws(() => testFeed.set('TEST', { trip: { stops: [] } }), /refused/, 'the prefix itself is not enough — must be "TEST-"');
});

test('set/getTrain/getVehicle: round-trips for a reserved number', () => {
    const trip = { stops: [{ station: 'Пловдив', arrivalTime: 100, departureTime: 200, arrivalDelay: 0, departureDelay: 0 }] };
    const vehicle = { lat: 42.1, lon: 24.7, bearing: 90 };
    testFeed.set('TEST-LEG1', { trip, vehicle });

    assert.deepStrictEqual(testFeed.getTrain('TEST-LEG1'), trip);
    assert.deepStrictEqual(testFeed.getVehicle('TEST-LEG1'), vehicle);
});

test('getTrain/getVehicle: null for a real number, even if somehow present as a key', () => {
    // Defense in depth: even if a real number ended up in the map by some bug
    // upstream, lookup for it must still read as "nothing here" — set() is not
    // the only line of defense.
    assert.strictEqual(testFeed.getTrain('10112'), null);
    assert.strictEqual(testFeed.getVehicle('10112'), null);
});

test('getTrain/getVehicle: null for a reserved number with nothing set yet', () => {
    assert.strictEqual(testFeed.getTrain('TEST-UNSET'), null);
    assert.strictEqual(testFeed.getVehicle('TEST-UNSET'), null);
});

test('clear: removes just the one number; clearAll wipes everything', () => {
    testFeed.set('TEST-LEG1', { trip: { stops: [] } });
    testFeed.set('TEST-LEG2', { trip: { stops: [] } });

    testFeed.clear('TEST-LEG1');
    assert.strictEqual(testFeed.getTrain('TEST-LEG1'), null);
    assert.notStrictEqual(testFeed.getTrain('TEST-LEG2'), null);

    testFeed.clearAll();
    assert.strictEqual(testFeed.getTrain('TEST-LEG2'), null);
});

test('list: reflects only currently-set reserved numbers', () => {
    assert.deepStrictEqual(testFeed.list(), []);
    testFeed.set('TEST-LEG1', { trip: { stops: [] } });
    testFeed.set('TEST-LEG2', { trip: { stops: [] } });
    assert.deepStrictEqual(testFeed.list().sort(), ['TEST-LEG1', 'TEST-LEG2']);
});
