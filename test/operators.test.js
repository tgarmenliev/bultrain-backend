'use strict';

/**
 * Train operators. From 2026-12-13 "Ивкони Експрес" runs part of the network next to БДЖ — in the SAME
 * national feed (agency_id BDZ / IVKONI), and 143 of its 190 train numbers are БДЖ's until 12.12. So who
 * runs a train is a property of the TRIP, which is date-bound, and every place that tells a passenger
 * about a train says it the same way: `operator: { id, name, nameEn }`, absent when the schedule does
 * not say (never guessed). Plus the admin's view of how much of each operator the live feeds cover.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-operators-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database  = require('better-sqlite3');
const { describe } = require('../services/gtfs/operatorDisplay');
const { materialize } = require('../services/gtfs/materialize');
const { buildTrainInfo } = require('../services/gtfs/serving');
const tripMeta  = require('../services/realtime/tripMeta');
const cache     = require('../services/realtime/cache');
const coverage  = require('../services/realtime/operatorCoverage');
const rtController = require('../controllers/realtimeController');

// ── The words ────────────────────────────────────────────────────────────────

test('one shape for every operator, and an unknown one is still reported', () => {
    assert.deepStrictEqual(describe('IVKONI'), { id: 'IVKONI', name: 'Ивкони Експрес', nameEn: 'Ivkoni Express' });
    assert.deepStrictEqual(describe('BDZ'), { id: 'BDZ', name: 'БДЖ', nameEn: 'BDZ' });
    assert.deepStrictEqual(describe('NEWCO'), { id: 'NEWCO', name: 'NEWCO', nameEn: 'NEWCO' }, 'by its id, not dropped');
    assert.strictEqual(describe(null), null);
    assert.strictEqual(describe(''), null);
});

// ── The feed → the schedule ──────────────────────────────────────────────────

test('materialize records who runs each trip, from the route\'s agency_id', () => {
    const db = new Database(TMP);
    db.prepare("INSERT INTO gtfs_routes (route_id, agency_id, route_short_name) VALUES ('BDZ-KPV_19201','BDZ','19201'), ('IVKONI-KPV_19201','IVKONI','19201'), ('BDZ-PV_8000','','8000')").run();
    const trip = db.prepare('INSERT INTO gtfs_trips (route_id, service_id, trip_id, trip_short_name) VALUES (?, ?, ?, ?)');
    const stop = db.prepare('INSERT INTO gtfs_stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES (?, ?, ?, ?, ?)');
    const cal  = db.prepare('INSERT INTO gtfs_calendar_dates (service_id, date, exception_type) VALUES (?, ?, 1)');
    db.prepare("INSERT OR IGNORE INTO station_map (gtfs_stop_id, station_id) VALUES ('S1', NULL), ('S2', NULL)").run();
    // the same number, two operators, on two different dates: the hand-over
    for (const [route, id, svc, date] of [
        ['BDZ-KPV_19201', '19201-KPV-20261212', '19201-KPV-20261117-20261212', '20261212'],
        ['IVKONI-KPV_19201', '19201-KPV-20261213', '19201-KPV-20261213-20261217', '20261213'],
        ['BDZ-PV_8000', '8000-PV-20261212', '8000-PV-20261117-20261212', '20261212'],
    ]) {
        trip.run(route, svc, id, id.split('-')[0]);
        stop.run(id, '08:00:00', '08:00:00', 'S1', 1);
        stop.run(id, '09:00:00', '09:00:00', 'S2', 2);
        cal.run(svc, date);
    }
    db.close();

    materialize(TMP);

    const rd = new Database(TMP, { readonly: true });
    const op = (id) => rd.prepare('SELECT operator FROM trip WHERE trip_id = ?').get(id).operator;
    assert.strictEqual(op('19201-KPV-20261212'), 'BDZ');
    assert.strictEqual(op('19201-KPV-20261213'), 'IVKONI', 'the same number, a different operator from 13.12');
    assert.strictEqual(op('8000-PV-20261212'), null, 'a feed that does not say: nothing is claimed');
    rd.close();
});

// ── Train info: the operator on THAT date ────────────────────────────────────

test('train-info names the operator of the date asked for', () => {
    const db = new Database(TMP, { readonly: true });
    const ask = (no, date) => buildTrainInfo(db, { language: 'bg', trainNo: no, dateObj: new Date(`${date}T00:00:00`) });

    // stops that name no station are not listed, so give the fixture two
    const dbw = new Database(TMP);
    dbw.prepare("INSERT INTO stations (id, name, english_name) VALUES (9001, 'Алфа', 'Alfa'), (9002, 'Бета', 'Beta')").run();
    dbw.prepare("UPDATE trip_stop SET station_id = 9001 WHERE seq = 1").run();
    dbw.prepare("UPDATE trip_stop SET station_id = 9002 WHERE seq = 2").run();
    dbw.close();

    assert.deepStrictEqual(ask('19201', '2026-12-12').result.operator, { id: 'BDZ', name: 'БДЖ', nameEn: 'BDZ' });
    assert.deepStrictEqual(ask('19201', '2026-12-13').result.operator, { id: 'IVKONI', name: 'Ивкони Експрес', nameEn: 'Ivkoni Express' });
    assert.ok(!('operator' in ask('8000', '2026-12-12').result), 'no operator on record: the key is absent, not null');
    assert.strictEqual(ask('19201', '2026-12-12').result.trainType, 'Крайградски пътнически влак', 'the rest of the answer is unchanged');
    db.close();
});

// ── Realtime: the map and the train status ───────────────────────────────────

test('a vehicle on the map carries its operator', () => {
    const v = { tripId: '19201-KPV-20261213', lat: 42.1, lon: 24.7, positionTimestamp: Date.now() };
    const entry = rtController._buildVehicleEntry('19201', v, Date.now());
    assert.deepStrictEqual(entry.operator, { id: 'IVKONI', name: 'Ивкони Експрес', nameEn: 'Ivkoni Express' });

    const unknown = rtController._buildVehicleEntry('8000', { ...v, tripId: '8000-PV-20261212' }, Date.now());
    assert.strictEqual(unknown.operator, null, 'a trip with no operator on record');
    const nowhere = rtController._buildVehicleEntry('1', { ...v, tripId: 'not-a-trip' }, Date.now());
    assert.strictEqual(nowhere.operator, null, 'a trip the schedule does not know');
    assert.ok(tripMeta.get('19201-KPV-20261213').operator);
});

// ── Admin: how much of each operator the live feeds cover ────────────────────

test('coverage per operator: what is on the road, and how much of it the feeds see', () => {
    const db = new Database(TMP);
    // a service day in the schedule: 2026-12-14, 08:00–10:00, three БДЖ trains and two Ивкони ones
    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category, operator) VALUES (?, ?, ?, ?)');
    const day  = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const add = (num, operator) => {
        const id = `${num}-KPV-20261214`;
        trip.run(id, num, 'КПВ', operator); day.run(id, '2026-12-14');
        stop.run(id, 1, 9001, '08:00', '08:00'); stop.run(id, 2, 9002, '10:00', '10:00');
    };
    ['7001', '7002', '7003'].forEach(n => add(n, 'BDZ'));
    ['7101', '7102'].forEach(n => add(n, 'IVKONI'));
    add('7201', null);                                        // a trip that says nothing
    db.close();
    coverage._reset();

    // the feeds: БДЖ has 2 of its 3 with a delay and 3 with a position; Ивкони has nothing at all
    const soon = Math.floor(Date.now() / 1000) + 600;
    const run = (n) => [n, [{ tripId: `${n}-KPV-20261214`, stops: [{ station: 'X', arrivalTime: soon, departureTime: soon }] }]];
    cache.setTrips(new Map([run('7001'), run('7002')]), Date.now());
    cache.setVehicles(new Map([['7001', { tripId: 'x' }], ['7002', { tripId: 'x' }], ['7003', { tripId: 'x' }]]), Date.now());

    const nineAmSofia = Date.parse('2026-12-14T07:00:00Z');   // winter: UTC+2
    const rows = coverage.snapshot(nineAmSofia);
    const by = Object.fromEntries(rows.map(r => [r.id, r]));

    assert.deepStrictEqual(rows.map(r => r.id), ['BDZ', 'IVKONI', null], 'БДЖ first, a trip with no operator last');
    assert.deepStrictEqual([by.BDZ.running, by.BDZ.withDelay, by.BDZ.withPosition], [3, 2, 3]);
    assert.deepStrictEqual([by.IVKONI.running, by.IVKONI.withDelay, by.IVKONI.withPosition], [2, 0, 0],
        'the case this exists for: an operator running trains the feeds do not see');
    assert.strictEqual(by.IVKONI.name, 'Ивкони Експрес');
    assert.strictEqual(by[null].running, 1);

    // a time when nothing runs: an operator with trips in the schedule still has a row, at zero
    const midnight = coverage.snapshot(Date.parse('2026-12-14T00:00:00Z'));
    assert.ok(midnight.find(r => r.id === 'IVKONI'), 'listed even when idle');
    assert.strictEqual(midnight.find(r => r.id === 'IVKONI').running, 0);
    assert.ok(!midnight.find(r => r.id === null), 'the "unknown" row appears only when something runs');
});

test('the admin overview carries the operator block', () => {
    const ctrl = require('../controllers/adminGtfsController');
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
    ctrl.overview({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.operators));
    assert.ok(res.body.operators.every(o => 'running' in o && 'withDelay' in o && 'withPosition' in o && 'name' in o));
});
