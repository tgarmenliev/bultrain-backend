'use strict';

/**
 * materialize.js turns the raw GTFS tables into the trip / trip_stop / trip_date
 * the app is served from. Its category step broke on 2026-11-17, when the feed
 * changed routes.txt from five routes (one per category, route_short_name = the
 * code) to one route PER TRAIN (route_short_name = the train number, the code
 * inside route_id): every train's category became its own number, and the app
 * showed "30121 30121". These pin both shapes of the feed, and the guard that
 * refuses a feed whose categories cannot be read.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const Database = require('better-sqlite3');
const { materialize, categoryOf } = require('../services/gtfs/materialize');

function freshDb() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-materialize-')), 'test.sqlite');
    require('../database/migrate')(file);
    return file;
}

/** routes: [route_id, route_short_name]; one trip per route, with two stops. */
function loadFeed(file, routes) {
    const db = new Database(file);
    const route = db.prepare('INSERT INTO gtfs_routes (route_id, route_short_name) VALUES (?, ?)');
    const trip  = db.prepare('INSERT INTO gtfs_trips (route_id, service_id, trip_id, trip_short_name) VALUES (?, ?, ?, ?)');
    const stop  = db.prepare('INSERT INTO gtfs_stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES (?, ?, ?, ?, ?)');
    const cal   = db.prepare('INSERT INTO gtfs_calendar_dates (service_id, date, exception_type) VALUES (?, ?, 1)');
    db.prepare("INSERT OR IGNORE INTO station_map (gtfs_stop_id, station_id) VALUES ('S1', NULL), ('S2', NULL)").run();

    routes.forEach(([routeId, shortName, num]) => {
        route.run(routeId, shortName);
        const service = `${num}-X-20261117-20261212`;
        const tripId = `${num}-X-20261117`;
        trip.run(routeId, service, tripId, num);
        stop.run(tripId, '08:00:00', '08:00:00', 'S1', 1);
        stop.run(tripId, '09:00:00', '09:00:00', 'S2', 2);
        cal.run(service, '20261117');
    });
    db.close();
}

const categoriesOf = (file) => {
    const db = new Database(file, { readonly: true });
    const rows = db.prepare('SELECT train_number AS n, category AS c FROM trip ORDER BY train_number').all();
    db.close();
    return Object.fromEntries(rows.map(r => [r.n, r.c]));
};

// ── categoryOf ───────────────────────────────────────────────────────────────

test('the feed until 2026-11-16: the code is the route_short_name', () => {
    assert.strictEqual(categoryOf({ route_id: 'PV', route_short_name: 'PV' }), 'ПВ');
    assert.strictEqual(categoryOf({ route_id: 'x', route_short_name: 'KPV' }), 'КПВ');
    assert.strictEqual(categoryOf({ route_id: 'x', route_short_name: 'A' }), 'АВТ');
});

test('the feed from 2026-11-17: the code is inside route_id, whoever the operator is', () => {
    assert.strictEqual(categoryOf({ route_id: 'BDZ-PV_30121', route_short_name: '30121' }), 'ПВ');
    assert.strictEqual(categoryOf({ route_id: 'BDZ-KPV_10200', route_short_name: '10200' }), 'КПВ');
    assert.strictEqual(categoryOf({ route_id: 'BDZ-BV_1611', route_short_name: '1611' }), 'БВ');
    assert.strictEqual(categoryOf({ route_id: 'BDZ-MBV_1090', route_short_name: '1090' }), 'МБВ');
    assert.strictEqual(categoryOf({ route_id: 'BDZ-EV_201', route_short_name: '201' }), 'ЕВ');
    assert.strictEqual(categoryOf({ route_id: 'BDZ-A_10202', route_short_name: '10202' }), 'АВТ');
    assert.strictEqual(categoryOf({ route_id: 'IVKONI-KPV_19201', route_short_name: '19201' }), 'КПВ');
});

test('a category that cannot be read is null — never the train number', () => {
    assert.strictEqual(categoryOf({ route_id: 'BDZ-ZZ_30121', route_short_name: '30121' }), null);
    assert.strictEqual(categoryOf({ route_id: '30121', route_short_name: '30121' }), null);
    assert.strictEqual(categoryOf({ route_id: null, route_short_name: null }), null);
});

// ── end to end ───────────────────────────────────────────────────────────────

test('a feed with one route per train: every trip gets its category, not its number', () => {
    const file = freshDb();
    loadFeed(file, [
        ['BDZ-PV_30121', '30121', '30121'],
        ['BDZ-KPV_10200', '10200', '10200'],
        ['IVKONI-BV_4631', '4631', '4631'],
        ['BDZ-EV_201', '201', '201'],
        ['BDZ-A_10202', '10202', '10202'],
    ]);
    const r = materialize(file);
    assert.strictEqual(r.nUnknown, 0);
    assert.deepStrictEqual(categoriesOf(file), {
        30121: 'ПВ', 10200: 'КПВ', 4631: 'БВ', 201: 'ЕВ', 10202: 'АВТ',
    });
});

test('the old feed shape still materialises', () => {
    const file = freshDb();
    loadFeed(file, [['PV', 'PV', '30121'], ['A', 'A', '10202']]);
    materialize(file);
    assert.deepStrictEqual(categoriesOf(file), { 30121: 'ПВ', 10202: 'АВТ' });
});

test('a few unreadable routes are stored as ?? and reported, the rest is fine', () => {
    const file = freshDb();
    const routes = [];
    for (let i = 0; i < 99; i++) routes.push([`BDZ-PV_${1000 + i}`, String(1000 + i), String(1000 + i)]);
    routes.push(['BDZ-NEW_5000', '5000', '5000']);
    loadFeed(file, routes);

    const r = materialize(file);
    assert.strictEqual(r.nUnknown, 1);
    assert.deepStrictEqual(r.unknownRoutes, ['BDZ-NEW_5000']);
    assert.strictEqual(categoriesOf(file)[5000], '??');
    assert.strictEqual(categoriesOf(file)[1000], 'ПВ');
});

test('a feed whose categories mostly cannot be read is refused and the previous schedule stays', () => {
    const file = freshDb();
    loadFeed(file, [['BDZ-PV_30121', '30121', '30121']]);
    materialize(file);
    assert.deepStrictEqual(categoriesOf(file), { 30121: 'ПВ' });

    // tomorrow's feed changes shape again: nothing in it can be read
    const db = new Database(file);
    db.prepare('DELETE FROM gtfs_routes').run();
    db.prepare('DELETE FROM gtfs_trips').run();
    db.prepare('DELETE FROM gtfs_stop_times').run();
    db.prepare('DELETE FROM gtfs_calendar_dates').run();
    db.close();
    loadFeed(file, [['route-1', 'Линия 1', '30121'], ['route-2', 'Линия 2', '30122']]);

    assert.throws(() => materialize(file), /category cannot be read/);
    assert.deepStrictEqual(categoriesOf(file), { 30121: 'ПВ' }, 'the schedule that was serving is untouched');
});
