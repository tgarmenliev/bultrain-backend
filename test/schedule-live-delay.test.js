'use strict';

/**
 * The mobile side wants delayMinutes/hasLiveDelay per leg in the schedule
 * search response, today's date only, so it can decide whether a "save
 * journey" / alarm window past the scheduled time is warranted — without a
 * second round-trip to /api/realtime/train/:number per result.
 *
 * generateScheduleData spawns a worker thread for the actual pathfinding,
 * which is out of scope here (already covered elsewhere) — these tests hit
 * the enrichment logic directly with synthetic `trains` arrays, the same way
 * buildOptions would hand them off, so no worker/DB schedule fixtures needed.
 */

const test   = require('node:test');
const assert = require('node:assert');

const cache = require('../services/realtime/cache');

// generateScheduleData/withLiveDelay/isSofiaToday aren't exported (internal
// helpers) — require the module fresh and reach them via a tiny re-export
// shim would over-complicate this file for two pure functions; instead we
// drive the same code path through the one function that IS exported,
// generateScheduleData, but only for the parts that don't need the worker:
// this file tests the enrichment in isolation by monkey-patching cache and
// checking withLiveDelay's observable behaviour through a minimal reproduction
// of what buildOptions produces.
const scheduleController = require('../controllers/scheduleController');

test('a boarding station with a live TripUpdate reports its own delay, not a whole-trip headline', () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    cache.setTrips(new Map([['2612', [{ tripId: '2612-BV-x', stops: [
        { station: 'Пловдив', arrivalDelay: null, arrivalTime: null, departureDelay: 300, departureTime: soon },
        { station: 'Стара Загора', arrivalDelay: 60, arrivalTime: soon + 3600, departureDelay: 60, departureTime: soon + 3660 },
    ] }]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());

    const trains = [
        { from: 'Пловдив', to: 'Стара Загора', trainNumber: '2612' },
    ];
    const enriched = scheduleController.__test.withLiveDelay(trains);

    assert.strictEqual(enriched[0].hasLiveDelay, true);
    assert.strictEqual(enriched[0].delayMinutes, 5, 'the BOARDING station\'s own departure delay (300s), not the next stop\'s');
});

test('no TripUpdate for the train at all: hasLiveDelay false, delayMinutes null — never invented', () => {
    cache.setTrips(new Map(), Date.now());
    cache.setVehicles(new Map(), Date.now());

    const enriched = scheduleController.__test.withLiveDelay([{ from: 'Пловдив', to: 'Бургас', trainNumber: '9999' }]);
    assert.strictEqual(enriched[0].hasLiveDelay, false);
    assert.strictEqual(enriched[0].delayMinutes, null);
});

test('the train IS in the feed but this leg\'s boarding station is not one of its stops', () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    cache.setTrips(new Map([['2612', [{ tripId: '2612-BV-x', stops: [
        { station: 'Пловдив', arrivalDelay: null, arrivalTime: null, departureDelay: 0, departureTime: soon },
    ] }]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());

    const enriched = scheduleController.__test.withLiveDelay([{ from: 'Хасково', to: 'Бургас', trainNumber: '2612' }]);
    assert.strictEqual(enriched[0].hasLiveDelay, false, 'the feed exists but never mentions THIS boarding station');
});

test('an on-time boarding station reads as hasLiveDelay:true, delayMinutes:0 — not confused with "no data"', () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    cache.setTrips(new Map([['5000', [{ tripId: '5000-PV-x', stops: [
        { station: 'Варна', arrivalDelay: null, arrivalTime: null, departureDelay: 0, departureTime: soon },
    ] }]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());

    const enriched = scheduleController.__test.withLiveDelay([{ from: 'Варна', to: 'Русе', trainNumber: '5000' }]);
    assert.strictEqual(enriched[0].hasLiveDelay, true);
    assert.strictEqual(enriched[0].delayMinutes, 0);
});

test('isSofiaToday: matches Sofia\'s current date, not the process\'s local/UTC date', () => {
    const todaySofia = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
    assert.strictEqual(scheduleController.__test.isSofiaToday(todaySofia), true);
    assert.strictEqual(scheduleController.__test.isSofiaToday('2000-01-01'), false);
});

test('withLiveDelay does not mutate or drop the original leg fields', () => {
    cache.setTrips(new Map(), Date.now());
    cache.setVehicles(new Map(), Date.now());
    const original = { from: 'А', to: 'Б', trainNumber: '1', depart: '10:00', trainType: 'ПВ' };
    const [enriched] = scheduleController.__test.withLiveDelay([original]);
    assert.strictEqual(enriched.depart, '10:00');
    assert.strictEqual(enriched.trainType, 'ПВ');
});
