'use strict';

/**
 * Regression tests for the realtime train endpoint.
 *
 * The one that matters here: a train running exactly on time (feed delay 0)
 * must NOT be treated like a train with no data. `0` is falsy in JS, so any
 * truthiness guard on a delay silently drops on-time trains — this pins that
 * they survive ingestion's shape all the way to a 200 with delayMinutes: 0.
 */

const test   = require('node:test');
const assert = require('node:assert');

const cache      = require('../services/realtime/cache');
const controller = require('../controllers/realtimeController');

// Minimal Express res double: records the status and the JSON body.
function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(obj)   { this.body = obj; return this; },
    };
}

// Inject a trip into the cache with a feed timestamp of "now" so it reads fresh.
function seed(num, stops) {
    const map = new Map([[num, { tripId: `${num}-BV-20260730`, stops }]]);
    cache.setTrips(map, Date.now());
}

test('an on-time train (delay 0) returns 200 with delayMinutes: 0 and stops', () => {
    const soon = Math.floor(Date.now() / 1000) + 600; // 10 min ahead → "upcoming"
    seed('2612', [
        {
            stationId: 42, station: 'Пловдив',
            arrivalDelay: 0, arrivalTime: soon,
            departureDelay: 0, departureTime: soon + 60,
        },
    ]);

    const res = mockRes();
    controller.getTrain({ params: { trainNo: '2612' } }, res);

    assert.strictEqual(res.statusCode, 200, 'on-time train must not 404');
    assert.strictEqual(res.body.delayMinutes, 0, 'headline delay must be 0, not null');
    assert.ok(Array.isArray(res.body.stops) && res.body.stops.length === 1, 'stops must be populated');
    assert.strictEqual(res.body.stops[0].arrivalDelayMin, 0, 'per-stop delay must be 0, not null');
});

test('a genuinely absent train still 404s', () => {
    seed('2612', []); // fresh feed, but this number not in it
    const res = mockRes();
    controller.getTrain({ params: { trainNo: '9999' } }, res);
    assert.strictEqual(res.statusCode, 404);
});

test('a delayed train reports its delay (control case)', () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    seed('8611', [
        { stationId: 7, station: 'Мездра', arrivalDelay: 360, arrivalTime: soon, departureDelay: 360, departureTime: soon + 60 },
    ]);
    const res = mockRes();
    controller.getTrain({ params: { trainNo: '8611' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.delayMinutes, 6);
});
