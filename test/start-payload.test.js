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

test('totalDistanceKm matches what the client computes from the same file', () => {
    const attrs = JSON.parse(watcher.buildStartBody(row, state, 1755082000)).aps.attributes;
    assert.strictEqual(typeof attrs.totalDistanceKm, 'number');
    // The iOS side measured Sofia→Plovdiv from its bundled stations.json:
    // 133.118 km haversine (133.360 via CLLocation's geodesic). We read the same
    // file, so we must land on the same number — the stations TABLE would give
    // ~125 km, because reconcile-coords has moved its София row ~9 km.
    assert.strictEqual(attrs.totalDistanceKm, 133.1,
        'must agree with the client, which draws progress against this number');
    assert.strictEqual(attrs.totalDistanceKm, stationCoords.distanceKm('София', 'Пловдив'));
});

test('the card is named with the display number, not the bare feed number', () => {
    const withDisplay = { ...row, train_number_display: 'БВ 3637' };
    const parsed = JSON.parse(watcher.buildStartBody(withDisplay, state, 1755082000));
    assert.strictEqual(parsed.aps.attributes.trainNumber, 'БВ 3637',
        'the passenger reads the category, the feed matches on the bare number');
    assert.strictEqual(parsed.aps.alert.title, 'БВ 3637');
});

test('without a display number the bare one still reads as a train', () => {
    const parsed = JSON.parse(watcher.buildStartBody(row, state, 1755082000));
    assert.strictEqual(parsed.aps.attributes.trainNumber, 'Влак 2612',
        'an older client that sends no display form must not produce a stray number');
});

test('coordinates come from stations.json, not the drifted stations table', () => {
    const sofia = stationCoords.find('София');
    assert.ok(Math.abs(sofia.lat - 42.7121794) < 1e-6, 'Sofia Central, as the app has it');
    assert.ok(Math.abs(sofia.lon - 23.3211294) < 1e-6);
});

test('an unresolvable station yields NO payload, so the caller refuses to start', () => {
    const body = watcher.buildStartBody({ ...row, destination_station: 'Несъществуваща гара' }, state, 1755082000);
    assert.strictEqual(body, null,
        'better a loud refusal than a start push with a guessed distance');
});

test('the date attributes use the 2001 reference date, as numbers', () => {
    const attrs = JSON.parse(watcher.buildStartBody(row, state, 1755082000)).aps.attributes;
    // Same rule as the content-state dates, and for the same reason: these are
    // Date properties decoded without a custom strategy. An ISO string here
    // fails as silently as a missing key.
    assert.strictEqual(typeof attrs.scheduledDeparture, 'number');
    assert.strictEqual(typeof attrs.scheduledArrival, 'number');
    assert.strictEqual(attrs.scheduledDeparture,
        Math.floor(Date.parse('2026-08-21T11:30:00.000Z') / 1000) - 978307200);
    assert.ok(attrs.scheduledArrival > attrs.scheduledDeparture);
});
