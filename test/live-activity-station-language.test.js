'use strict';

/**
 * Real user report: an English-language app, journey armed between two real
 * stations, got a fully English Live Activity card — except the boarding and
 * destination station names, which stayed Bulgarian. Same root cause as the
 * earlier English schedule-search delay bug: boarding_station/
 * destination_station are stored Bulgarian on purpose (they have to match the
 * GTFS-RT feed, which only ever knows stations by that name — see
 * stationDisplay.js), and that internal value was leaking straight onto
 * passenger-facing text instead of being translated at the point of display.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-stationlang-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database      = require('better-sqlite3');
const stationDisplay = require('../services/gtfs/stationDisplay');
const contentState   = require('../services/liveactivity/contentState');
const armedStore     = require('../services/liveactivity/armedStore');
const apns           = require('../services/liveactivity/apns');
const testFeed       = require('../services/liveactivity/testFeed');
const armedWatcher   = require('../services/liveactivity/armedWatcher');

// Real station names/English names, exactly as they sit in production's
// stations table — inserted here since a freshly migrated DB has the schema
// but no GTFS-imported rows.
{
    const db = new Database(TMP);
    db.prepare('INSERT OR REPLACE INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)')
        .run(1, 'София', 'Sofia', 42.6979, 23.3217);
    db.prepare('INSERT OR REPLACE INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)')
        .run(2, 'Пловдив', 'Plovdiv', 42.1508, 24.7434);
    db.prepare('INSERT OR REPLACE INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)')
        .run(3, 'Бургас', 'Burgas', 42.4954, 27.4783);
    db.close();
}

// ── 1. stationDisplay.displayStationName — the resolver itself ──────────────

test('displayStationName translates only for language "en", and never invents anything', () => {
    assert.strictEqual(stationDisplay.displayStationName('София', 'en'), 'Sofia');
    assert.strictEqual(stationDisplay.displayStationName('София', 'bg'), 'София', 'bg stays bg');
    assert.strictEqual(stationDisplay.displayStationName('София', null), 'София', 'no language stays as given');
    assert.strictEqual(stationDisplay.displayStationName('София', undefined), 'София');
    assert.strictEqual(
        stationDisplay.displayStationName('Гара Която Не Съществува', 'en'),
        'Гара Която Не Съществува',
        'unknown station falls back to the original name — never fabricated',
    );
    assert.strictEqual(stationDisplay.displayStationName('', 'en'), '', 'empty name stays empty, not crash');
});

test('displayStationName tolerates spelling drift the same way contentState matching does', () => {
    assert.strictEqual(stationDisplay.displayStationName('софия', 'en'), 'Sofia', 'case-insensitive');
});

// ── 2. contentState.build() — the per-tick Live Activity card ───────────────

function makeTokenRow(over = {}) {
    return {
        token: 'a'.repeat(64),
        train_number: '2612',
        train_number_display: 'БВ 2612',
        boarding_station: 'София',
        destination_station: 'Пловдив',
        direction_station: 'Бургас',
        scheduled_departure: '2026-07-23T12:00:00.000Z',
        scheduled_arrival: '2026-07-23T14:00:00.000Z',
        current_leg_index: 0,
        is_current_bus: 0,
        is_next_transport_bus: 0,
        ...over,
    };
}

test('an English-language journey gets English station names on the card, not just English everything else', () => {
    const row = makeTokenRow({ app_language: 'en' });
    const { state } = contentState.build(row, null, new Date('2026-07-23T13:00:00Z'));

    assert.strictEqual(state.legOriginStation, 'Sofia');
    assert.strictEqual(state.legDestinationStation, 'Plovdiv');
    assert.strictEqual(state.directionStation, 'Burgas');
});

test('a Bulgarian-language (or language-less) journey keeps Bulgarian station names — no regression', () => {
    const rowBg = makeTokenRow({ app_language: 'bg' });
    const { state: stateBg } = contentState.build(rowBg, null, new Date('2026-07-23T13:00:00Z'));
    assert.strictEqual(stateBg.legOriginStation, 'София');
    assert.strictEqual(stateBg.legDestinationStation, 'Пловдив');
    assert.strictEqual(stateBg.directionStation, 'Бургас');

    const rowNone = makeTokenRow({ app_language: null });
    const { state: stateNone } = contentState.build(rowNone, null, new Date('2026-07-23T13:00:00Z'));
    assert.strictEqual(stateNone.legOriginStation, 'София');
    assert.strictEqual(stateNone.legDestinationStation, 'Пловдив');
});

test('directionStation falls back to the (translated) destination when no direction was given', () => {
    const row = makeTokenRow({ app_language: 'en', direction_station: null });
    const { state } = contentState.build(row, null, new Date('2026-07-23T13:00:00Z'));
    assert.strictEqual(state.directionStation, 'Plovdiv');
});

// ── 3. End to end through armedWatcher: the actual APNs payloads ────────────

const INSTALL = 'install-stationlang-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockApns() {
    const calls = [];
    const original = apns.send;
    apns.send = async (args) => { calls.push(args); return { outcome: 'ok', status: 200 }; };
    return { calls, restore: () => { apns.send = original; } };
}

function setCreatedAt(id, iso) {
    const db = new Database(TMP);
    db.prepare('UPDATE armed_journeys SET created_at = ? WHERE id = ?').run(iso, id);
    db.close();
}

test.afterEach(() => testFeed.clearAll());

test('push-to-start and the delay-alert both carry English station names for an English journey', async () => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('s'), kind: 'push_to_start', environment: 'sandbox' });
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'sandbox' });

    const journeyId = 'j-stationlang-en';
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: 'TEST-STATIONLANG-1', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        app_language: 'en',
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 80 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    const row0 = armedStore.listActive().find(r => r.journey_id === journeyId);
    // Clear of the arm-alert grace period so the delay alert fires in the
    // same tick as push-to-start — this test is about station-name language,
    // not about the arm-grace feature (covered separately).
    setCreatedAt(row0.id, new Date(Date.now() - 10 * 60000).toISOString());

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-STATIONLANG-1', { trip: { stops: [
        { station: 'София', arrivalTime: null, departureTime: nowSec + 20 * 60, arrivalDelay: null, departureDelay: 600 },
        { station: 'Пловдив', arrivalTime: nowSec + 80 * 60, departureTime: null, arrivalDelay: 600, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    const startCall = mock.calls.find(c => c.pushType === 'liveactivity');
    const alertCall = mock.calls.find(c => c.pushType === 'alert');
    assert.ok(startCall, 'push-to-start should have fired');
    assert.ok(alertCall, 'the delay alert should also have fired (grace already elapsed)');

    const startBody = JSON.parse(startCall.body);
    assert.strictEqual(startBody.aps.attributes.originStation, 'Sofia');
    assert.strictEqual(startBody.aps.attributes.destinationStation, 'Plovdiv');
    assert.strictEqual(startBody.aps.alert.body, 'Travelling to Plovdiv');

    const alertBody = JSON.parse(alertCall.body);
    assert.match(alertBody.aps.alert.body, /Plovdiv/, 'the delay-alert push must name the destination in English too');
    assert.doesNotMatch(alertBody.aps.alert.body, /Пловдив/, 'must not still carry the Bulgarian name');

    armedStore.disarm(INSTALL, journeyId, 0);
});

test('the same flow for a Bulgarian journey is unaffected — station names stay Bulgarian', async () => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('s'), kind: 'push_to_start', environment: 'sandbox' });
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'sandbox' });

    const journeyId = 'j-stationlang-bg';
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: 'TEST-STATIONLANG-2', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 80 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    const row0 = armedStore.listActive().find(r => r.journey_id === journeyId);
    setCreatedAt(row0.id, new Date(Date.now() - 10 * 60000).toISOString());

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-STATIONLANG-2', { trip: { stops: [
        { station: 'София', arrivalTime: null, departureTime: nowSec + 20 * 60, arrivalDelay: null, departureDelay: 600 },
        { station: 'Пловдив', arrivalTime: nowSec + 80 * 60, departureTime: null, arrivalDelay: 600, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    const startCall = mock.calls.find(c => c.pushType === 'liveactivity');
    const startBody = JSON.parse(startCall.body);
    assert.strictEqual(startBody.aps.attributes.originStation, 'София');
    assert.strictEqual(startBody.aps.attributes.destinationStation, 'Пловдив');
    assert.strictEqual(startBody.aps.alert.body, 'Пътуване към Пловдив');

    armedStore.disarm(INSTALL, journeyId, 0);
});
