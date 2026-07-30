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
// Clears the vehicle cache too, so a test that seeds only trips has no stale
// position bleeding in from an earlier test.
function seed(num, stops) {
    const map = new Map([[num, [{ tripId: `${num}-BV-20260730`, stops }]]]);
    cache.setTrips(map, Date.now());
    cache.setVehicles(new Map(), Date.now());
}

// Inject a vehicle position with no TripUpdate — the "running but no delay
// data" case that NAP's two-feed split produces.
function seedVehicleOnly(num, position) {
    cache.setTrips(new Map(), Date.now());
    cache.setVehicles(new Map([[num, { tripId: `${num}-BV-20260730`, ...position }]]), Date.now());
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
    assert.strictEqual(res.body.hasLiveDelay, true, 'a TripUpdate means live delay data');
    assert.ok(Array.isArray(res.body.stops) && res.body.stops.length === 1, 'stops must be populated');
    assert.strictEqual(res.body.stops[0].arrivalDelayMin, 0, 'per-stop delay must be 0, not null');
});

test('a train with only a position (no TripUpdate) is 200, running, delay unknown', () => {
    seedVehicleOnly('28202', { lat: 42.5, lon: 25.6, bearing: 90 });
    const res = mockRes();
    controller.getTrain({ params: { trainNo: '28202' } }, res);

    assert.strictEqual(res.statusCode, 200, 'a train we can see moving must not 404');
    assert.strictEqual(res.body.hasLiveDelay, false, 'no TripUpdate ⇒ no live delay');
    assert.strictEqual(res.body.delayMinutes, null, 'delay is unknown, reported as null');
    assert.deepStrictEqual(res.body.stops, [], 'no stops without a TripUpdate');
    assert.deepStrictEqual(res.body.position, { lat: 42.5, lon: 25.6, bearing: 90 });
});

test('a train absent from BOTH feeds still 404s', () => {
    seed('2612', []);                              // trips fresh but empty for 9999
    cache.setVehicles(new Map(), Date.now());      // vehicles empty too
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

test('two trips sharing a number: both kept, the in-progress one is returned', () => {
    const now  = Math.floor(Date.now() / 1000);
    const past = now - 3600;
    const soon = now + 600;

    // Overnight run: one stop already passed, one still ahead → in progress.
    const overnight = { tripId: '16102-PV-20260729', stops: [
        { stationId: 1, station: 'Русе',   arrivalDelay: 120, arrivalTime: past, departureDelay: 120, departureTime: past + 60 },
        { stationId: 2, station: 'Горна',  arrivalDelay: 120, arrivalTime: soon, departureDelay: 120, departureTime: soon + 60 },
    ] };
    // Today's run of the same number: departs this evening → not yet started.
    const daytime = { tripId: '16102-PV-20260730', stops: [
        { stationId: 3, station: 'София',   arrivalDelay: 0, arrivalTime: now + 36000, departureDelay: 0, departureTime: now + 36060 },
    ] };

    cache.setTrips(new Map([['16102', [daytime, overnight]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());

    // getTrain must return the in-progress overnight run, not silently drop one.
    const picked = cache.getTrain('16102');
    assert.strictEqual(picked.tripId, '16102-PV-20260729', 'the mid-route run must win');
    assert.strictEqual(cache.getTrips('16102').length, 2, 'both runs must be retained');
});
