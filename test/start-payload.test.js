'use strict';

/**
 * The push-to-start payload. Every property of JourneyAttributes below is
 * non-optional in the app, so a missing or misnamed one fails the decode the
 * same silent way a missing content-state key does: Apple returns 200, the
 * device drops the start, and nothing is logged anywhere. These tests are the
 * only place that failure is visible.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-startpl-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

// Two real stations, so the distance is computed rather than stubbed.
const Database = require('better-sqlite3');
const db = new Database(TMP);
db.prepare('INSERT OR REPLACE INTO stations (id,name,english_name,lat,lon) VALUES (?,?,?,?,?)')
    .run(2, 'София', 'Sofia', 42.6293908, 23.3731599);
db.prepare('INSERT OR REPLACE INTO stations (id,name,english_name,lat,lon) VALUES (?,?,?,?,?)')
    .run(3, 'Пловдив', 'Plovdiv', 42.1341703, 24.7413839);
db.close();

const watcher       = require('../services/liveactivity/armedWatcher');
const stationCoords = require('../services/gtfs/stationCoords');

// Exactly the non-optional set the app declares.
const REQUIRED_ATTRIBUTES = [
    'journeyId', 'trainNumber', 'originStation', 'destinationStation',
    'totalDistanceKm', 'scheduledDeparture', 'scheduledArrival',
];

const row = {
    id: 1, journey_id: 'abc-123', leg_index: 0, state: 'armed',
    train_number: '2612',
    boarding_station: 'София', destination_station: 'Пловдив',
    direction_station: 'Бургас',
    scheduled_departure: '2026-08-21T11:30:00.000Z',
    scheduled_arrival:   '2026-08-21T13:45:00.000Z',
    is_current_bus: 0, next_transport_number: null,
    next_transport_departure: null, is_next_transport_bus: 0,
};
const state = { progressPercentage: 0, isDelayed: false, lastUpdated: 0, phase: 'preDeparture' };

test('the start payload carries every non-optional attribute, none null', () => {
    const body = watcher.buildStartBody(row, state, 1755082000);
    assert.ok(body, 'a resolvable journey produces a payload');
    const attrs = JSON.parse(body).aps.attributes;

    for (const key of REQUIRED_ATTRIBUTES) {
        assert.ok(key in attrs, `missing non-optional attribute: ${key}`);
        assert.notStrictEqual(attrs[key], null, `${key} must never be null`);
    }
    // The station field is originStation — boardingStation would decode to nothing.
    assert.ok(!('boardingStation' in attrs), 'boardingStation is the wrong name for this struct');
    assert.strictEqual(attrs.originStation, 'София');
    assert.strictEqual(attrs.journeyId, 'abc-123');
});

test('attributes-type matches the app struct', () => {
    const parsed = JSON.parse(watcher.buildStartBody(row, state, 1755082000));
    assert.strictEqual(parsed.aps['attributes-type'], 'JourneyAttributes');
    assert.strictEqual(parsed.aps.event, 'start');
});

test('totalDistanceKm is the straight line, matching how the app computes it', () => {
    const attrs = JSON.parse(watcher.buildStartBody(row, state, 1755082000)).aps.attributes;
    assert.strictEqual(typeof attrs.totalDistanceKm, 'number');
    // Sofia→Plovdiv great-circle is ~125 km; rail mileage (~156 km) would be wrong
    // here, because the app draws progress against a straight line.
    assert.ok(attrs.totalDistanceKm > 120 && attrs.totalDistanceKm < 130,
        `expected ~125 km straight line, got ${attrs.totalDistanceKm}`);
    assert.strictEqual(attrs.totalDistanceKm, stationCoords.distanceKm('София', 'Пловдив'));
});

test('an unresolvable station yields NO payload, so the caller refuses to start', () => {
    const body = watcher.buildStartBody({ ...row, destination_station: 'Несъществуваща гара' }, state, 1755082000);
    assert.strictEqual(body, null,
        'better a loud refusal than a start push with a guessed distance');
});

test('dates are ISO strings by default (correct only if those properties are String)', () => {
    const attrs = JSON.parse(watcher.buildStartBody(row, state, 1755082000)).aps.attributes;
    assert.strictEqual(attrs.scheduledDeparture, '2026-08-21T11:30:00.000Z');
    assert.strictEqual(attrs.scheduledArrival, '2026-08-21T13:45:00.000Z');
    // If the app's properties turn out to be Date, APNS_ATTRIBUTES_DATE_FORMAT
    // =swift switches these to 2001-epoch numbers without a code change.
});
