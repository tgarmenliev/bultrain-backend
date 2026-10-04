'use strict';

/**
 * GET /api/route-shape/:trainNo — track geometry for the per-train map.
 * A missing shape is a normal 404 (the client draws straight lines), never an
 * error and never synthesised geometry.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-shape-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const polyline = require('../services/gtfs/polyline');
const routeShape = require('../services/gtfs/routeShape');
const ctrl = require('../controllers/routeShapeController');

// ── polyline6 ────────────────────────────────────────────────────────────────

test('polyline: Google’s reference vector (precision 5) and a precision-6 round trip', () => {
    const pts = [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }];
    assert.strictEqual(polyline.encode(pts, 5), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');

    const back = polyline.decode(polyline.encode(pts, 6), 6);
    back.forEach((p, i) => {
        assert.ok(Math.abs(p.lat - pts[i].lat) < 1e-6 && Math.abs(p.lon - pts[i].lon) < 1e-6);
    });
});

// ── geometry (pure) ──────────────────────────────────────────────────────────

// An east-west line at 42°N, 0.01° of longitude ≈ 826 m.
const line = (n, lon0 = 25.0, step = 0.01) => Array.from({ length: n }, (_, i) => ({ lat: 42.0, lon: lon0 + i * step }));

test('build: stops are placed along the line, in order, in metres', () => {
    const r = routeShape.build(line(41), [
        { stationId: 1, lat: 42.0, lon: 25.00 },
        { stationId: 2, lat: 42.0005, lon: 25.20 },   // ~55 m beside the track
        { stationId: 3, lat: 42.0, lon: 25.40 },
    ]);
    assert.strictEqual(r.stops.length, 3);
    assert.ok(Math.abs(r.totalMeters - 33040) < 200, `total ${r.totalMeters}`);
    assert.strictEqual(r.stops[0].distanceMeters, 0);
    assert.ok(Math.abs(r.stops[1].distanceMeters - 16520) < 100);
    assert.ok(Math.abs(r.stops[2].distanceMeters - r.totalMeters) < 5);
    assert.deepStrictEqual(r.stops.map(s => s.stationId), [1, 2, 3]);
});

test('build: a straight line collapses to its ends, and the polyline decodes back to it', () => {
    const r = routeShape.build(line(41), [{ stationId: 1, lat: 42, lon: 25 }, { stationId: 2, lat: 42, lon: 25.4 }]);
    const pts = polyline.decode(r.shape);
    assert.strictEqual(pts.length, 2, 'collinear points carry no information');
    assert.ok(Math.abs(pts[0].lon - 25.0) < 1e-6 && Math.abs(pts[1].lon - 25.4) < 1e-6);
});

test('build: a real bend survives simplification', () => {
    const bent = [...line(11), ...Array.from({ length: 10 }, (_, i) => ({ lat: 42.0 + (i + 1) * 0.01, lon: 25.1 }))];
    const pts = polyline.decode(routeShape.build(bent, []).shape);
    assert.ok(pts.some(p => Math.abs(p.lon - 25.1) < 1e-6 && Math.abs(p.lat - 42.0) < 1e-6), 'the corner is kept');
});

test('build: distances never go backwards', () => {
    const r = routeShape.build(line(41), [
        { stationId: 1, lat: 42, lon: 25.00 }, { stationId: 2, lat: 42, lon: 25.10 },
        { stationId: 3, lat: 42, lon: 25.10 },   // same spot as the previous stop
        { stationId: 4, lat: 42, lon: 25.30 },
    ]);
    const d = r.stops.map(s => s.distanceMeters);
    assert.deepStrictEqual(d, [...d].sort((a, b) => a - b));
});

test('build: a line that passes a station twice is resolved by the stops around it', () => {
    // out east to 25.2, then back west to 25.0 and on north — passes 25.1 twice.
    const loop = [
        ...line(21),                                                     // 25.00 → 25.20 at 42.000
        ...Array.from({ length: 5 }, (_, i) => ({ lat: 42.001 + i * 0.0005, lon: 25.2 })),
        ...Array.from({ length: 21 }, (_, i) => ({ lat: 42.004, lon: 25.2 - i * 0.01 })),   // back west at 42.004
    ];
    const r = routeShape.build(loop, [
        { stationId: 1, lat: 42.000, lon: 25.00 },
        { stationId: 2, lat: 42.000, lon: 25.15 },   // first pass
        { stationId: 3, lat: 42.004, lon: 25.15 },   // second pass (coming back)
        { stationId: 4, lat: 42.004, lon: 25.00 },
    ]);
    const d = Object.fromEntries(r.stops.map(s => [s.stationId, s.distanceMeters]));
    assert.ok(d[2] < d[3], 'the second pass is later along the track than the first');
    assert.ok(d[3] < d[4]);
});

test('build: a stop far from the track is left out, not pinned to the wrong place', () => {
    const r = routeShape.build(line(41), [
        { stationId: 1, lat: 42.0, lon: 25.00 },
        { stationId: 2, lat: 42.5, lon: 25.20 },     // ~55 km off
        { stationId: 3, lat: 42.0, lon: 25.40 },
    ]);
    assert.deepStrictEqual(r.stops.map(s => s.stationId), [1, 3]);
    assert.strictEqual(r.droppedStops, 1);
});

test('build: an unusable shape is null', () => {
    assert.strictEqual(routeShape.build([], []), null);
    assert.strictEqual(routeShape.build([{ lat: 1, lon: 1 }], []), null);
});

// ── endpoint ─────────────────────────────────────────────────────────────────

const DAY = '2026-10-04';

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(1, 'А', 'A', 42.0, 25.00);
    st.run(2, 'Б', 'B', 42.0, 25.20);
    st.run(3, 'В', 'C', 42.0, 25.40);

    const shapePt = db.prepare('INSERT INTO gtfs_shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence) VALUES (?, ?, ?, ?)');
    line(41).forEach((p, i) => shapePt.run('shape-rail', p.lat, p.lon, i + 1));
    line(3, 25.0, 0.2).forEach((p, i) => shapePt.run('shape-road', p.lat + 0.01, p.lon, i + 1));

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const gtrip = db.prepare('INSERT INTO gtfs_trips (trip_id, trip_short_name, shape_id) VALUES (?, ?, ?)');
    const day  = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');

    // 8613: a plain rail train with a shape.
    trip.run('8613-BV', '8613', 'БВ'); gtrip.run('8613-BV', '8613', 'shape-rail'); day.run('8613-BV', DAY);
    stop.run('8613-BV', 1, 1, null, '10:00'); stop.run('8613-BV', 2, 2, '10:30', '10:32'); stop.run('8613-BV', 3, 3, '11:00', null);

    // 7000: no shape at all.
    trip.run('7000-PV', '7000', 'ПВ'); gtrip.run('7000-PV', '7000', ''); day.run('7000-PV', DAY);
    stop.run('7000-PV', 1, 1, null, '10:00'); stop.run('7000-PV', 2, 2, '10:30', null);

    // 10202: a rail leg plus a replacement-bus leg, both with shapes — only the rail one counts.
    trip.run('10202-A', '10202', 'АВТ'); gtrip.run('10202-A', '10202', 'shape-road'); day.run('10202-A', DAY);
    stop.run('10202-A', 1, 2, null, '09:00'); stop.run('10202-A', 2, 3, '09:40', null);
    trip.run('10202-KPV', '10202', 'КПВ'); gtrip.run('10202-KPV', '10202', 'shape-rail'); day.run('10202-KPV', DAY);
    stop.run('10202-KPV', 1, 1, null, '08:00'); stop.run('10202-KPV', 2, 2, '08:50', null);

    // 8800: has a shape, but not on DAY.
    trip.run('8800-PV', '8800', 'ПВ'); gtrip.run('8800-PV', '8800', 'shape-rail'); day.run('8800-PV', '2026-10-05');
    stop.run('8800-PV', 1, 1, null, '10:00'); stop.run('8800-PV', 2, 3, '11:00', null);
    db.close();
}

function mockRes() {
    return {
        statusCode: 200, body: null, headers: {}, sent: null,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        type() { return this; },
        send(s) { this.sent = s; this.body = JSON.parse(s); return this; },
        end() { return this; },
    };
}
const get = (trainNo, query = { date: DAY }, headers = {}) => {
    const res = mockRes();
    ctrl.getRouteShape({ params: { trainNo }, query, headers }, res);
    return res;
};

test('endpoint: the contract', () => {
    const r = get('8613');
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(),
        ['distanceSource', 'encoding', 'serviceDate', 'shape', 'stops', 'totalMeters', 'trainNumber']);
    assert.strictEqual(r.body.trainNumber, '8613');
    assert.strictEqual(r.body.serviceDate, DAY);
    assert.strictEqual(r.body.encoding, 'polyline6');
    assert.strictEqual(r.body.distanceSource, 'computed');
    assert.strictEqual(typeof r.body.shape, 'string');
    assert.ok(Number.isInteger(r.body.totalMeters));
    assert.deepStrictEqual(r.body.stops.map(s => s.stationId), [1, 2, 3]);
    assert.ok(r.body.stops.every(s => Number.isInteger(s.distanceMeters)));
});

test('endpoint: 404 for no shape, unknown train, or a day the train does not run', () => {
    assert.strictEqual(get('7000').statusCode, 404, 'no shape is a normal answer');
    assert.strictEqual(get('123456').statusCode, 404);
    assert.strictEqual(get('8800').statusCode, 404, 'has a shape, but not on that date');
    assert.strictEqual(get('8800', { date: '2026-10-05' }).statusCode, 200);
    assert.strictEqual(get('../etc').statusCode, 404);
});

test('endpoint: a bad date is a 400, not a guess', () => {
    assert.strictEqual(get('8613', { date: '2026-02-30' }).statusCode, 400);
    assert.strictEqual(get('8613', { date: '04.10.2026' }).statusCode, 400);
});

test('endpoint: the replacement-bus leg is not the train’s track', () => {
    const r = get('10202');
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.stops.map(s => s.stationId), [1, 2], 'the rail leg’s stops only');
});

test('endpoint: ETag + long Cache-Control; If-None-Match → 304', () => {
    const first = get('8613');
    const etag = first.headers.ETag;
    assert.ok(etag);
    assert.match(first.headers['Cache-Control'], /max-age=3600/);
    assert.strictEqual(get('8613', { date: DAY }, { 'if-none-match': etag }).statusCode, 304);
    assert.strictEqual(get('8613', { date: DAY }, { 'if-none-match': '"other"' }).statusCode, 200);
});
