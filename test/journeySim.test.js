'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const testFeed = require('../services/liveactivity/testFeed');

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}

test.afterEach(() => { testFeed.clearAll(); delete process.env.ENABLE_JOURNEY_SIM; });

test('every handler 404s when ENABLE_JOURNEY_SIM is not "on" — same pattern as test-push', () => {
    delete process.env.ENABLE_JOURNEY_SIM;
    const ctrl = require('../controllers/journeySimController');

    let res = mockRes();
    ctrl.setTrain({ body: { trainNumber: 'TEST-LEG1', stops: [{ station: 'Пловдив' }] } }, res);
    assert.strictEqual(res.statusCode, 404);

    res = mockRes();
    ctrl.clearTrain({ params: { trainNumber: 'TEST-LEG1' } }, res);
    assert.strictEqual(res.statusCode, 404);

    res = mockRes();
    ctrl.listTrains({}, res);
    assert.strictEqual(res.statusCode, 404);
});

test('setTrain: refuses a real-looking train number even with the flag on', () => {
    process.env.ENABLE_JOURNEY_SIM = 'on';
    const ctrl = require('../controllers/journeySimController');

    const res = mockRes();
    ctrl.setTrain({ body: { trainNumber: '10112', stops: [{ station: 'Пловдив' }] } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(testFeed.getTrain('10112'), null, 'nothing was stored for the real number');
});

test('setTrain: accepts a reserved number, converts offsets to absolute times', () => {
    process.env.ENABLE_JOURNEY_SIM = 'on';
    const ctrl = require('../controllers/journeySimController');

    const before = Math.floor(Date.now() / 1000);
    const res = mockRes();
    ctrl.setTrain({
        body: {
            trainNumber: 'TEST-LEG1',
            stops: [{ station: 'Пловдив', departureInSec: 120, delayMin: 5 }],
        },
    }, res);
    assert.strictEqual(res.statusCode, 200);

    const trip = testFeed.getTrain('TEST-LEG1');
    assert.strictEqual(trip.stops[0].station, 'Пловдив');
    assert.ok(trip.stops[0].departureTime >= before + 120);
    assert.strictEqual(trip.stops[0].departureDelay, 300);
});

test('clearTrain: removes just that number', () => {
    process.env.ENABLE_JOURNEY_SIM = 'on';
    const ctrl = require('../controllers/journeySimController');

    testFeed.set('TEST-LEG1', { trip: { stops: [] } });
    const res = mockRes();
    ctrl.clearTrain({ params: { trainNumber: 'TEST-LEG1' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(testFeed.getTrain('TEST-LEG1'), null);
});
