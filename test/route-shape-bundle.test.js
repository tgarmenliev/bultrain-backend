'use strict';

/**
 * GET /api/route-shapes — every shape of a service day in one download.
 *
 * The requirement that matters: for any train and date, the bundle and
 * GET /api/route-shape/:trainNo agree exactly (same polyline, totalMeters, stops,
 * distanceMeters). If they ever differ the dot and the line differ. The test
 * compares them for EVERY train in the fixture, not a sample.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const zlib   = require('node:zlib');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-bundle-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database   = require('better-sqlite3');
const routeShape = require('../services/gtfs/routeShape');
const bundles    = require('../services/gtfs/routeShapeBundle');
const ctrl       = require('../controllers/routeShapesController');

const DAY  = '2026-10-04';
const YDAY = '2026-10-03';

const line = (n, lat = 42.0, lon0 = 25.0, step = 0.01) =>
    Array.from({ length: n }, (_, i) => ({ lat, lon: lon0 + i * step }));
const bend = () => [...line(11), ...Array.from({ length: 10 }, (_, i) => ({ lat: 42.0 + (i + 1) * 0.01, lon: 25.1 }))];

const db = new Database(TMP);
{
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(1, 'А', 'A', 42.0, 25.00);
    st.run(2, 'Б', 'B', 42.0, 25.20);
    st.run(3, 'В', 'C', 42.0, 25.40);
    st.run(4, 'Г', 'D', 42.1, 25.10);
    st.run(5, 'Д', 'E', 42.0, 25.05);

    const pt = db.prepare('INSERT INTO gtfs_shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence) VALUES (?, ?, ?, ?)');
    line(41).forEach((p, i) => pt.run('shape-east', p.lat, p.lon, i + 1));
    bend().forEach((p, i) => pt.run('shape-bend', p.lat, p.lon, i + 1));
    line(3, 42.01, 25.0, 0.2).forEach((p, i) => pt.run('shape-road', p.lat, p.lon, i + 1));
    pt.run('shape-broken', 42, 25, 1);                      // one point: unusable

    const trip  = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const gtrip = db.prepare('INSERT INTO gtfs_trips (trip_id, trip_short_name, shape_id) VALUES (?, ?, ?)');
    const date  = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop  = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const add = (id, num, cat, shape, days, stops) => {
        trip.run(id, num, cat); gtrip.run(id, num, shape);
        days.forEach(d => date.run(id, d));
        stops.forEach((sid, i) => stop.run(id, i + 1, sid, '10:00', '10:01'));
    };

    // two trains share one shape; a third has its own; one is on a different day only
    add('1000-BV', '1000', 'БВ', 'shape-east', [DAY, YDAY], [1, 2, 3]);
    add('1001-PV', '1001', 'ПВ', 'shape-east', [DAY], [1, 5, 2, 3]);
    add('2000-PV', '2000', 'ПВ', 'shape-bend', [DAY], [1, 2, 4]);
    add('3000-PV', '3000', 'ПВ', '',            [DAY], [1, 2]);          // no shape at all
    add('4000-PV', '4000', 'ПВ', 'shape-broken', [DAY], [1, 2]);          // unusable shape
    add('5000-A',  '5000', 'АВТ', 'shape-road', [DAY], [1, 2]);           // replacement bus
    // a rail leg plus a bus leg under one number: only the rail leg
    add('6000-A',  '6000', 'АВТ', 'shape-road', [DAY], [2, 3]);
    add('6000-KPV', '6000', 'КПВ', 'shape-east', [DAY], [1, 2]);
    add('7000-PV', '7000', 'ПВ', 'shape-east', ['2026-10-05'], [1, 3]);
}

const decode = (b) => JSON.parse(zlib.gunzipSync(b.gzip).toString());

// ── the bundle ───────────────────────────────────────────────────────────────

test('bundle: deduplicated shapes, one entry per train that has a usable shape', async () => {
    bundles._reset();
    const b = await bundles.bundleFor(DAY);
    const body = decode(b);

    assert.deepStrictEqual(Object.keys(body).sort(), ['serviceDate', 'shapes', 'trains', 'version']);
    assert.strictEqual(body.serviceDate, DAY);
    assert.deepStrictEqual(Object.keys(body.trains).sort(), ['1000', '1001', '2000', '6000']);
    assert.strictEqual(body.trains['1000'].shapeId, body.trains['1001'].shapeId, 'trains on one route share a shape');
    assert.deepStrictEqual(Object.keys(body.shapes).sort(), ['shape-bend', 'shape-east'], 'only shapes someone uses');
    assert.strictEqual(b.shapesCount, 2);
    assert.strictEqual(b.trainsCount, 4);
    for (const s of Object.values(body.shapes)) {
        assert.strictEqual(s.encoding, 'polyline6');
        assert.strictEqual(typeof s.shape, 'string');
        assert.ok(Number.isInteger(s.totalMeters));
    }
});

test('bundle: no shape, an unusable shape and a bus are simply absent', async () => {
    const trains = decode(await bundles.bundleFor(DAY)).trains;
    assert.ok(!('3000' in trains), 'no shape');
    assert.ok(!('4000' in trains), 'a one-point shape is unusable');
    assert.ok(!('5000' in trains), 'a replacement bus is not a train');
    assert.strictEqual(trains['6000'].stops.length, 2, 'the rail leg of a chained number');
});

test('bundle == per-train endpoint, for EVERY train of the day', async () => {
    const body = decode(await bundles.bundleFor(DAY));
    for (const [num, t] of Object.entries(body.trains)) {
        const single = routeShape.forTrain(num, DAY);
        assert.ok(single, `${num} has a per-train answer`);
        const shape = body.shapes[t.shapeId];
        assert.strictEqual(shape.shape, single.shape, `${num} polyline`);
        assert.strictEqual(shape.totalMeters, single.totalMeters, `${num} totalMeters`);
        assert.deepStrictEqual(t.stops, single.stops, `${num} stops`);
    }
    // and the other way round: nothing the per-train endpoint serves is missing from the bundle
    for (const num of ['1000', '1001', '2000', '3000', '4000', '5000', '6000']) {
        assert.strictEqual(routeShape.forTrain(num, DAY) !== null, num in body.trains, `${num} presence`);
    }
});

test('bundle: distances never decrease and never exceed the shape', async () => {
    const body = decode(await bundles.bundleFor(DAY));
    for (const [num, t] of Object.entries(body.trains)) {
        const d = t.stops.map(s => s.distanceMeters);
        assert.deepStrictEqual(d, [...d].sort((a, b) => a - b), `${num} non-decreasing`);
        assert.ok(d.every(x => x <= body.shapes[t.shapeId].totalMeters + 1), `${num} within the shape`);
    }
});

test('bundle: version is stable for the same content and differs between days', async () => {
    bundles._reset(); routeShape._reset();
    const a = await bundles.bundleFor(DAY);
    bundles._reset(); routeShape._reset();
    const b = await bundles.bundleFor(DAY);
    assert.strictEqual(a.version, b.version, 'rebuilt, same content, same version');
    const y = await bundles.bundleFor(YDAY);
    assert.notStrictEqual(y.version, a.version);
});

test('bundle: yesterday is a valid day; a day with no trains is null', async () => {
    const y = decode(await bundles.bundleFor(YDAY));
    assert.deepStrictEqual(Object.keys(y.trains), ['1000']);
    assert.strictEqual(await bundles.bundleFor('2030-01-01'), null);
});

test('bundle: concurrent requests share one build, and a new feed import rebuilds', async () => {
    bundles._reset();
    const [a, b] = await Promise.all([bundles.bundleFor(DAY), bundles.bundleFor(DAY)]);
    assert.strictEqual(a, b, 'the same packed object');
    assert.strictEqual(await bundles.bundleFor(DAY), a, 'cached');

    db.prepare("INSERT INTO gtfs_import (file_id, filename, imported_at, status) VALUES ('f', 'f.zip', datetime('now'), 'ok')").run();
    const after = await bundles.bundleFor(DAY);
    assert.notStrictEqual(after, a, 'a new import invalidates the cached bundle');
    assert.strictEqual(after.version, a.version, 'same content, so the same version — clients keep their copy');
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

function mockRes() {
    return {
        statusCode: 200, headers: {}, body: null,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        end(b) { if (b !== undefined) this.body = b; return this; },
    };
}
const get = async (handler, query = { date: DAY }, headers = {}) => {
    const res = mockRes();
    await handler({ query, headers }, res);
    return res;
};

test('http: gzip or identity, ETag = version, long private cache', async () => {
    const gz = await get(ctrl.getBundle, { date: DAY }, { 'accept-encoding': 'gzip' });
    assert.strictEqual(gz.statusCode, 200);
    assert.strictEqual(gz.headers['Content-Encoding'], 'gzip');
    const body = JSON.parse(zlib.gunzipSync(gz.body).toString());
    assert.strictEqual(gz.headers.ETag, `"${body.version}"`);
    assert.match(gz.headers['Cache-Control'], /^private, max-age=3600$/);
    assert.match(gz.headers.Vary, /Accept-Encoding/);

    const plain = await get(ctrl.getBundle, { date: DAY }, {});
    assert.strictEqual(plain.headers['Content-Encoding'], undefined);
    assert.deepStrictEqual(JSON.parse(plain.body.toString()), body);
});

test('http: If-None-Match → 304, with the same ETag', async () => {
    const first = await get(ctrl.getBundle, { date: DAY }, { 'accept-encoding': 'gzip' });
    const again = await get(ctrl.getBundle, { date: DAY }, { 'if-none-match': first.headers.ETag });
    assert.strictEqual(again.statusCode, 304);
    assert.strictEqual(again.headers.ETag, first.headers.ETag);
    const other = await get(ctrl.getBundle, { date: DAY }, { 'if-none-match': '"nope"' });
    assert.strictEqual(other.statusCode, 200);
});

test('http: /version is {version, serviceDate} and shares the bundle’s ETag', async () => {
    const full = await get(ctrl.getBundle, { date: DAY }, { 'accept-encoding': 'gzip' });
    const v = await get(ctrl.getVersion, { date: DAY });
    assert.strictEqual(v.statusCode, 200);
    assert.deepStrictEqual(Object.keys(v.body).sort(), ['serviceDate', 'version']);
    assert.strictEqual(v.headers.ETag, full.headers.ETag);
    assert.strictEqual(v.body.serviceDate, DAY);
    assert.strictEqual((await get(ctrl.getVersion, { date: DAY }, { 'if-none-match': v.headers.ETag })).statusCode, 304);
});

test('http: date handling — default today, yesterday ok, junk 400, empty day 404', async () => {
    assert.strictEqual((await get(ctrl.getBundle, { date: YDAY }, {})).statusCode, 200);
    assert.strictEqual((await get(ctrl.getBundle, { date: '2026-02-30' }, {})).statusCode, 400);
    assert.strictEqual((await get(ctrl.getBundle, { date: 'yesterday' }, {})).statusCode, 400);
    assert.strictEqual((await get(ctrl.getBundle, { date: '2030-01-01' }, {})).statusCode, 404);
    assert.strictEqual((await get(ctrl.getVersion, { date: '2030-01-01' }, {})).statusCode, 404);
    // no date means today in Sofia — whatever today is, it must answer exactly as the explicit date does
    const today = require('../services/gtfs/adminView').sofiaToday();
    const implicit = await get(ctrl.getBundle, {}, { 'accept-encoding': 'gzip' });
    const explicit = await get(ctrl.getBundle, { date: today }, { 'accept-encoding': 'gzip' });
    assert.strictEqual(implicit.statusCode, explicit.statusCode);
    assert.strictEqual(implicit.headers.ETag, explicit.headers.ETag);
});
