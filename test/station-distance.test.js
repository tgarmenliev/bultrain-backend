'use strict';

/**
 * The admin panel's distance calculator: track distance between two stations,
 * measured along the GTFS shape of a train that calls at both. Nothing is
 * guessed — two stations no train links are reported as such, with only the
 * straight-line figure for reference.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-distance-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const distance = require('../services/gtfs/stationDistance');
const ctrl     = require('../controllers/adminGtfsController');

const A = 1, B = 2, C = 3, D = 4, E = 5;

// An east-west line at 42°N; 0.01° of longitude ≈ 826 m, so 0.2° ≈ 16.5 km.
const lineShape = (lonFrom, lonTo) => {
    const pts = [];
    const n = Math.round(Math.abs(lonTo - lonFrom) / 0.01);
    const dir = lonTo >= lonFrom ? 1 : -1;
    for (let i = 0; i <= n; i++) pts.push([42.0, lonFrom + dir * i * 0.01]);
    return pts;
};

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(A, 'Алфа', 'Alfa', 42.0, 25.0);
    st.run(B, 'Бета', 'Beta', 42.0, 25.2);
    st.run(C, 'Гама', 'Gama', 42.0, 25.4);
    st.run(D, 'Делта', 'Delta', 43.0, 26.0);    // on no line with the others
    st.run(E, 'Епсилон', 'Epsilon', null, null);

    const shape = db.prepare('INSERT INTO gtfs_shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence) VALUES (?, ?, ?, ?)');
    const addShape = (id, pts) => pts.forEach(([la, lo], i) => shape.run(id, la, lo, i));
    addShape('S-AC', lineShape(25.0, 25.4));
    addShape('S-CA', lineShape(25.4, 25.0));
    // A longer variant between A and C: out to a point 5.5 km north of the middle and back.
    addShape('S-AC-DETOUR', [[42.0, 25.0], [42.05, 25.2], [42.0, 25.4]]);
    addShape('S-DE', [[43.0, 26.0], [43.0, 26.1]]);

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const gtrip = db.prepare('INSERT INTO gtfs_trips (trip_id, trip_short_name, shape_id) VALUES (?, ?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const addTrip = (id, num, cat, shapeId, stations) => {
        trip.run(id, num, cat);
        gtrip.run(id, num, shapeId);
        stations.forEach((s, i) => stop.run(id, i + 1, s, '10:00', '10:00'));
    };

    addTrip('T1', '1000', 'ПВ', 'S-AC', [A, B, C]);
    addTrip('T2', '1001', 'ПВ', 'S-CA', [C, B, A]);            // the way back, its own shape
    addTrip('T3', '1002', 'БВ', 'S-AC', [A, C]);               // same line again: must not skew anything
    addTrip('T4', '2000', 'ПВ', 'S-DE', [D, E]);
    addTrip('T5', '3000', 'АВТ', 'S-AC', [A, D]);              // a bus: road, never counted
}

const near = (actual, expected, tol, msg) =>
    assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} got ${actual}, expected ${expected} ±${tol}`);

test('along the line: the full length, then a part of it', () => {
    const ac = distance.between(A, C);
    assert.strictEqual(ac.found, true);
    near(ac.km, 33.0, 0.3, 'Алфа→Гама');
    near(distance.between(A, B).km, 16.5, 0.3, 'Алфа→Бета');
    near(distance.between(B, C).km, 16.5, 0.3, 'Бета→Гама');
});

test('the direction does not matter', () => {
    assert.strictEqual(distance.between(C, A).km, distance.between(A, C).km);
    assert.strictEqual(distance.between(B, A).km, distance.between(A, B).km);
});

test('the answer names both stations and carries the straight-line figure', () => {
    const r = distance.between(A, C);
    assert.deepStrictEqual(r.from, { id: A, name: 'Алфа' });
    assert.deepStrictEqual(r.to, { id: C, name: 'Гама' });
    near(r.airKm, 33.0, 0.3, 'on a straight track both are the same');
    assert.ok(r.exampleTrain);
});

test('a variant of the line: the headline is the median, the spread is visible', () => {
    // A and C are joined by the straight shape (~33.0 km, three trips collapse to one shape per direction)
    // and by the detour shape (~34.9 km) only when a train runs on it.
    const db = new Database(TMP);
    db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)').run('T6', '4000', 'ПВ');
    db.prepare('INSERT INTO gtfs_trips (trip_id, trip_short_name, shape_id) VALUES (?, ?, ?)').run('T6', '4000', 'S-AC-DETOUR');
    db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)').run('T6', 1, A, '09:00', '09:00');
    db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)').run('T6', 2, C, '10:00', '10:00');
    db.close();

    const r = distance.between(A, C);
    assert.strictEqual(r.shapes, 3, 'one measurement per distinct shape: A→C, C→A and the detour');
    near(r.minKm, 33.0, 0.3);
    near(r.maxKm, 34.9, 0.4);
    assert.ok(r.km >= r.minKm && r.km <= r.maxKm);
    assert.ok(r.maxKm > r.minKm);
});

test('stations no train links are reported as such, not guessed', () => {
    const r = distance.between(A, D);       // only a BUS links them
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.km, undefined);
    assert.ok(r.airKm > 100, 'the straight line is still given for reference');
});

test('a station with no coordinates has no straight-line figure and cannot be placed on a shape', () => {
    const r = distance.between(D, E);
    assert.strictEqual(r.found, false, 'Епсилон has no coordinates, so it cannot be placed on the shape');
    assert.strictEqual(r.airKm, null);
});

test('the same station is zero; an unknown one is null', () => {
    assert.strictEqual(distance.between(B, B).km, 0);
    assert.strictEqual(distance.between(A, 999), null);
});

test('stations are listed by name', () => {
    // migrations seed a few real stations of their own; only ours are compared
    const names = distance.listStations().map(s => s.name).filter(n => ['Алфа', 'Бета', 'Гама', 'Делта', 'Епсилон'].includes(n));
    assert.deepStrictEqual(names, ['Алфа', 'Бета', 'Гама', 'Делта', 'Епсилон']);
});

// ── the endpoint ─────────────────────────────────────────────────────────────

const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });

test('endpoint: ids in, distance out', () => {
    const res = mockRes();
    ctrl.distanceBetween({ query: { from: String(A), to: String(B) } }, res);
    assert.strictEqual(res.statusCode, 200);
    near(res.body.km, 16.5, 0.3);
});

test('endpoint: bad input is 400, an unknown station is 404', () => {
    let res = mockRes();
    ctrl.distanceBetween({ query: { from: 'abc', to: '1' } }, res);
    assert.strictEqual(res.statusCode, 400);

    res = mockRes();
    ctrl.distanceBetween({ query: { to: '1' } }, res);
    assert.strictEqual(res.statusCode, 400);

    res = mockRes();
    ctrl.distanceBetween({ query: { from: '1', to: '999' } }, res);
    assert.strictEqual(res.statusCode, 404);
});

test('endpoint: the station list', () => {
    const res = mockRes();
    ctrl.distanceStations({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.stations.length >= 5);
    assert.deepStrictEqual(Object.keys(res.body.stations[0]).sort(), ['englishName', 'id', 'name']);
});
