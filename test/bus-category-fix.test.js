'use strict';

/**
 * End-to-end reproduction of the real incident: train 30122 runs as a train
 * as far as Волуяк, then a replacement bus onward to Драгоман. A passenger
 * boarding Антон (entirely on the train portion) must get "ПВ 30122" and
 * is_current_bus=false from BOTH /arm and /register — even when the CLIENT
 * itself sends the wrong category, proving the server no longer trusts it
 * blindly for a number that has a mixed train+bus split.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-buscat-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

function seedStation(db, id, name) {
    db.prepare('INSERT OR IGNORE INTO stations (id, name) VALUES (?, ?)').run(id, name);
}
function seedTrip(db, tripId, trainNumber, category, date, stops) {
    db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)').run(tripId, trainNumber, category);
    db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)').run(tripId, date);
    stops.forEach((s, i) => {
        seedStation(db, s.id, s.name);
        db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)')
            .run(tripId, i, s.id, s.arrive || null, s.depart || null);
    });
}

const DATE = new Date().toISOString().slice(0, 10); // today, so scheduled_departure resolves to it
const db = new Database(TMP);
seedTrip(db, '30122-PV-x', '30122', 'ПВ', DATE, [
    { id: 201, name: 'Антон', depart: '06:00' },
    { id: 202, name: 'Волуяк', arrive: '07:00', depart: '07:05' },
]);
seedTrip(db, '30122-A-x', '30122', 'АВТ', DATE, [
    { id: 202, name: 'Волуяк', arrive: '07:05', depart: '07:10' },
    { id: 203, name: 'Драгоман', arrive: '08:00' },
]);
db.close();

const armedCtrl = require('../controllers/armedJourneyController');
const laCtrl     = require('../controllers/liveActivityController');
const armedStore = require('../services/liveactivity/armedStore');
const laStore     = require('../services/liveactivity/store');

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}

const INSTALL = 'install-buscat-test01';

test('/arm resolves the TRAIN category for a boarding station on the train portion, ignoring a wrong client value', () => {
    const res = mockRes();
    armedCtrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-buscat-1', legIndex: 0,
        trainNumber: '30122',
        // Client sends the WRONG category — this is what actually happened.
        trainNumberDisplay: 'АВТ 30122', isCurrentTransportBus: true,
        boardingStation: 'Антон', destinationStation: 'Волуяк',
        scheduledDeparture: `${DATE}T03:00:00.000Z`, // ~06:00 Sofia time (summer, UTC+3)
        scheduledArrival:   `${DATE}T04:00:00.000Z`,
    } }, res);

    assert.strictEqual(res.statusCode, 200);
    const row = armedStore.listActive().find(r => r.journey_id === 'j-buscat-1');
    assert.strictEqual(row.train_number_display, 'ПВ 30122', 'corrected to the train leg\'s real category');
    assert.strictEqual(row.is_current_bus, 0, 'not a bus for this passenger');
});

test('/register applies the same correction for live_activity_tokens', () => {
    const res = mockRes();
    laCtrl.register({ body: {
        token: 'f'.repeat(64), environment: 'sandbox', journeyId: 'j-buscat-2', currentLegIndex: 0,
        trainNumber: '30122',
        trainNumberDisplay: 'АВТ 30122', isCurrentTransportBus: true,
        boardingStation: 'Антон', destinationStation: 'Волуяк',
        scheduledDeparture: `${DATE}T03:00:00.000Z`,
        scheduledArrival:   `${DATE}T04:00:00.000Z`,
    } }, res);

    assert.strictEqual(res.statusCode, 200);
    const row = laStore.getByToken('f'.repeat(64));
    assert.strictEqual(row.train_number_display, 'ПВ 30122');
    assert.strictEqual(row.is_current_bus, 0);
});

test('boarding AT the transfer point correctly resolves to bus, even via /arm', () => {
    const res = mockRes();
    armedCtrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-buscat-3', legIndex: 0,
        trainNumber: '30122', trainNumberDisplay: 'ПВ 30122', isCurrentTransportBus: false,
        boardingStation: 'Волуяк', destinationStation: 'Драгоман',
        scheduledDeparture: `${DATE}T04:05:00.000Z`,
        scheduledArrival:   `${DATE}T05:00:00.000Z`,
    } }, res);

    const row = armedStore.listActive().find(r => r.journey_id === 'j-buscat-3');
    assert.strictEqual(row.train_number_display, 'АВТ 30122');
    assert.strictEqual(row.is_current_bus, 1);
});

test('an unresolvable segment (no GTFS coverage) falls back to whatever the client sent', () => {
    const res = mockRes();
    armedCtrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-buscat-4', legIndex: 0,
        trainNumber: '99999', trainNumberDisplay: 'БВ 99999', isCurrentTransportBus: false,
        boardingStation: 'Никаквогара', destinationStation: 'Другагара',
        scheduledDeparture: new Date(Date.now() + 3600000).toISOString(),
        scheduledArrival:   new Date(Date.now() + 7200000).toISOString(),
    } }, res);

    const row = armedStore.listActive().find(r => r.journey_id === 'j-buscat-4');
    assert.strictEqual(row.train_number_display, 'БВ 99999', 'no crash, no silent data loss — client value preserved');
    assert.strictEqual(row.is_current_bus, 0);
});

test('/arm: appLanguage=en produces an English category abbreviation, not the Bulgarian one', () => {
    const res = mockRes();
    armedCtrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-buscat-5', legIndex: 0,
        trainNumber: '30122', appLanguage: 'en',
        boardingStation: 'Антон', destinationStation: 'Волуяк',
        scheduledDeparture: `${DATE}T03:00:00.000Z`,
        scheduledArrival:   `${DATE}T04:00:00.000Z`,
    } }, res);

    assert.strictEqual(res.statusCode, 200);
    const row = armedStore.listActive().find(r => r.journey_id === 'j-buscat-5');
    assert.strictEqual(row.train_number_display, 'PT 30122', 'ПВ -> PT for an English-language journey');
    assert.strictEqual(row.app_language, 'en', 'persisted for later ticks (delay-alert wording, attributes.appLanguage)');
});

test('an unrecognized appLanguage value is treated as unset, not an error', () => {
    const res = mockRes();
    armedCtrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-buscat-6', legIndex: 0,
        trainNumber: '30122', appLanguage: 'fr',
        boardingStation: 'Антон', destinationStation: 'Волуяк',
        scheduledDeparture: `${DATE}T03:00:00.000Z`,
        scheduledArrival:   `${DATE}T04:00:00.000Z`,
    } }, res);

    assert.strictEqual(res.statusCode, 200);
    const row = armedStore.listActive().find(r => r.journey_id === 'j-buscat-6');
    assert.strictEqual(row.train_number_display, 'ПВ 30122', 'falls back to Bulgarian, same as no field at all');
    assert.strictEqual(row.app_language, null);
});
