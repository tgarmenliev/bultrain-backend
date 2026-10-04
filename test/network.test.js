'use strict';

/**
 * The public "living network" snapshot. It is the website's strongest claim
 * about the railway, so these pin its honesty rules: delay figures only from
 * trains that have one, null — not 0, not an estimate — when there is no feed,
 * measured positions only, and a schedule that never invents a train.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const zlib   = require('node:zlib');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-network-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');

const cache      = require('../services/realtime/cache');
const schedule   = require('../services/network/schedule');
const boards     = require('../services/network/boards');
const snapshot   = require('../services/network/snapshot');
const controller = require('../controllers/networkController');

// 2026-10-04 18:00 in Sofia (EEST, UTC+3)
const NOW = Date.parse('2026-10-04T15:00:00Z');
const NOW_SEC = NOW / 1000;
const DAY = '2026-10-04';
const YDAY = '2026-10-03';

// ── fixture: a small timetable ───────────────────────────────────────────────

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    [[1, 'София', 42.0, 23.0], [2, 'Пловдив', 42.0, 24.0], [3, 'Бургас', 42.5, 27.0],
     [4, 'Варна', 43.2, 27.9], [5, 'Русе', 43.8, 25.9]].forEach(([id, n, la, lo]) => st.run(id, n, n, la, lo));

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const day  = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const add = (id, num, cat, date, stops) => {
        trip.run(id, num, cat); day.run(id, date);
        stops.forEach(([sid, a, d], i) => stop.run(id, i + 1, sid, a, d));
    };

    add('T-8627', '8627', 'БВ', DAY, [[1, null, '16:00'], [2, '17:30', '17:32'], [3, '20:00', null]]);   // on the road at 18:00
    add('T-2612', '2612', 'ПВ', DAY, [[1, null, '17:00'], [2, '19:00', null]]);                          // on the road
    add('T-9001', '9001', 'ПВ', DAY, [[1, null, '19:30'], [2, '21:00', null]]);                          // not yet
    add('T-9002', '9002', 'ПВ', DAY, [[1, null, '06:00'], [2, '08:00', null]]);                          // already done
    add('T-BUS',  '7700', 'АВТ', DAY, [[1, null, '17:00'], [2, '19:00', null]]);                         // a bus is not a train
    // overnight: left yesterday 23:24, arrives 02:09
    add('T-13154', '13154', 'МБВ', YDAY, [[4, null, '23:24'], [5, '00:31', '00:40'], [1, '02:09', null]]);
    // overnight that left yesterday and reached the terminus long ago
    add('T-4000', '4000', 'БВ', YDAY, [[1, null, '20:00'], [2, '23:00', null]]);
    // one number, two chained legs (train then train)
    add('T-3000-A', '3000', 'ПВ', DAY, [[1, null, '15:00'], [2, '16:00', null]]);
    add('T-3000-B', '3000', 'ПВ', DAY, [[2, null, '16:10'], [3, '18:30', null]]);
    db.close();
}

// ── schedule windows ─────────────────────────────────────────────────────────

test('schedule: only trains inside their first-departure → last-arrival window; no buses', () => {
    schedule._reset();
    const nums = [...schedule.runningAt(NOW).keys()].sort();
    assert.deepStrictEqual(nums, ['2612', '3000', '8627']);
    assert.ok(!nums.includes('7700'), 'a replacement bus is not a train');
    assert.ok(!nums.includes('9001'), 'has not left yet');
    assert.ok(!nums.includes('9002'), 'has arrived');
});

test('schedule: a journey of chained legs reads origin → final destination', () => {
    const j = schedule.runningAt(NOW).get('3000');
    assert.strictEqual(j.fromId, 1);
    assert.strictEqual(j.toId, 3);
});

test('schedule: an overnight run belongs to the day it left, after midnight too', () => {
    schedule._reset();
    const at0040 = Date.parse('2026-10-03T21:40:00Z');          // 00:40 Sofia on the 4th
    const run = schedule.runningAt(at0040);
    assert.ok(run.has('13154'), 'left on the 3rd, still on the road at 00:40 on the 4th');
    assert.ok(!run.has('4000'), 'that one arrived at 23:00 on the 3rd');

    const at0300 = Date.parse('2026-10-04T00:00:00Z');          // 03:00 Sofia
    assert.ok(!schedule.runningAt(at0300).has('13154'), 'arrived at 02:09');
});

// ── compute(): the honesty rules ─────────────────────────────────────────────

const stop = (stationId, station, delaySec, atSec) => ({
    stationId, station, arrivalDelay: delaySec, arrivalTime: atSec,
    departureDelay: delaySec, departureTime: atSec + 60, skipped: false,
});
const trip = (tripId, delaySec) => ({
    tripId,
    stops: [stop(1, 'София', delaySec, NOW_SEC - 3600), stop(2, 'Пловдив', delaySec, NOW_SEC + 1800)],
});
const geo = {   // west → east along 42°N; a vehicle at 23.5 is halfway
    stops: [{ stationId: 1, name: 'София', lat: 42, lon: 23 }, { stationId: 2, name: 'Пловдив', lat: 42, lon: 24 }],
    shape: [{ lat: 42, lon: 23 }, { lat: 42, lon: 24 }],
};
const vehicle = (tripId, lat, lon) => ({ tripId, lat, lon, bearing: 90, positionTimestamp: NOW, stopStatus: 'IN_TRANSIT_TO' });

function deps(over = {}) {
    const runs = new Map(over.runs || [
        ['8627', { category: 'БВ', fromId: 1, toId: 3 }],
        ['2612', { category: 'ПВ', fromId: 1, toId: 2 }],
        ['3000', { category: 'ПВ', fromId: 1, toId: 3 }],
    ]);
    const rts = over.rts || { '8627': trip('8627-BV-1', 38 * 60), '2612': trip('2612-PV-1', 60) };
    return {
        status: { tripFresh: true, vehicleFresh: true, tripFeedTs: NOW - 20000, vehicleFeedTs: NOW - 20000 },
        running: runs,
        vehicles: over.vehicles || [['8627', vehicle('8627-BV-1', 42, 23.5)], ['2612', vehicle('2612-PV-1', 42, 23.2)]],
        trains: over.trains || Object.entries(rts),
        getTrain: (n) => rts[n] || null,
        getTripFor: (n, id) => (rts[n] && rts[n].tripId === id ? rts[n] : null),
        geoFor: () => geo,
        metaFor: () => null,
        nameOf: (id) => ({ 1: 'София', 2: 'Пловдив', 3: 'Бургас' }[id] || null),
        boards: () => ({}),
        ...over.deps,
    };
}

test('compute: headline numbers come only from trains that have a delay', () => {
    const { network, radar } = snapshot.compute(NOW, deps());
    const s = network.summary;
    assert.strictEqual(s.running, 3, '8627, 2612 and 3000 (no realtime)');
    assert.strictEqual(s.withRealtime, 2);
    assert.strictEqual(s.onTimePercent, 50, '2612 is 1 min late (on time), 8627 is 38 min late');
    assert.strictEqual(s.avgDelayMin, 20, '(38 + 1) / 2 rounded');
    assert.deepStrictEqual(s.maxDelay, { min: 38, type: 'БВ', trainNum: '8627', to: 'Бургас' });
    assert.strictEqual(radar.count, 3);
});

test('compute: a train with no realtime keeps null — not 0, no position, no progress', () => {
    const t = snapshot.compute(NOW, deps()).radar.trains.find(x => x.trainNum === '3000');
    assert.strictEqual(t.delayMin, null);
    assert.strictEqual(t.lat, null);
    assert.strictEqual(t.lon, null);
    assert.strictEqual(t.progress, null, 'never projected from the schedule');
    assert.strictEqual(t.from, 'София');
    assert.strictEqual(t.to, 'Бургас');
});

test('compute: radar carries the measured position and progress along the route', () => {
    const t = snapshot.compute(NOW, deps()).radar.trains.find(x => x.trainNum === '8627');
    assert.deepStrictEqual(
        { type: t.type, delayMin: t.delayMin, lat: t.lat, lon: t.lon },
        { type: 'БВ', delayMin: 38, lat: 42, lon: 23.5 });
    assert.ok(Math.abs(t.progress - 0.5) < 0.01, `progress ${t.progress}`);
});

test('compute: no usable realtime ⇒ available:false and every delay figure null', () => {
    const { network, radar } = snapshot.compute(NOW, deps({
        deps: { status: { tripFresh: false, vehicleFresh: false, tripFeedTs: NOW - 900000, vehicleFeedTs: NOW - 900000 },
                getTrain: () => null, getTripFor: () => null },
        vehicles: [], trains: [],
    }));
    assert.strictEqual(network.realtime.available, false);
    assert.strictEqual(network.realtime.feedUpdatedAt, new Date(NOW - 900000).toISOString(), 'the age of the last data stays visible');
    assert.strictEqual(network.summary.withRealtime, 0);
    assert.strictEqual(network.summary.onTimePercent, null);
    assert.strictEqual(network.summary.avgDelayMin, null);
    assert.strictEqual(network.summary.maxDelay, null);
    assert.strictEqual(network.summary.running, 3, 'the schedule still knows what should be running');
    assert.ok(radar.trains.every(t => t.delayMin === null && t.lat === null));
});

test('compute: nobody is late ⇒ maxDelay is null, percentages stay real; early counts as 0 in the average', () => {
    const rts = { '8627': trip('8627-BV-1', -180), '2612': trip('2612-PV-1', 0) };   // 3 min early, on time
    const { network } = snapshot.compute(NOW, deps({ rts }));
    assert.strictEqual(network.summary.onTimePercent, 100);
    assert.strictEqual(network.summary.avgDelayMin, 0, 'early does not cancel out lateness');
    assert.strictEqual(network.summary.maxDelay, null);
});

test('compute: tomorrow’s run of a number is never borrowed for a train seen only on the schedule', () => {
    const tomorrow = { tripId: '3000-PV-2', stops: [
        stop(1, 'София', 1500 * 60, NOW_SEC + 20 * 3600), stop(2, 'Пловдив', 1500 * 60, NOW_SEC + 22 * 3600),
    ] };
    const { radar } = snapshot.compute(NOW, deps({
        rts: { '8627': trip('8627-BV-1', 60), '2612': trip('2612-PV-1', 60), '3000': tomorrow },
    }));
    assert.strictEqual(radar.trains.find(t => t.trainNum === '3000').delayMin, null);
});

test('compute: a vehicle’s own run only — and a train only the feeds know is counted, once', () => {
    const only = trip('5555-PV-1', 120);
    const { network, radar } = snapshot.compute(NOW, deps({
        runs: [],                                         // the schedule knows nothing
        rts: { '5555': only },
        vehicles: [['5555', vehicle('5555-PV-1', 42, 23.5)], ['6666', vehicle('6666-PV-1', 42, 23.6)]],
        deps: { metaFor: (id) => (id && id.startsWith('5555') ? { category: 'ПВ', originStationId: 1, destinationStationId: 2 } : null) },
    }));
    assert.strictEqual(network.summary.running, 2);
    assert.deepStrictEqual(radar.trains.map(t => t.trainNum), ['5555', '6666']);
    const five = radar.trains.find(t => t.trainNum === '5555');
    assert.strictEqual(five.from, 'София');
    assert.strictEqual(five.delayMin, 2);
    assert.strictEqual(radar.trains.find(t => t.trainNum === '6666').delayMin, null, 'a position alone says nothing about delay');
});

// ── boards ───────────────────────────────────────────────────────────────────

test('boards: up to 8 trains; a failed refresh keeps the last board only for a while', async () => {
    boards._reset();
    const rows = Array.from({ length: 12 }, (_, i) => ({ trainNum: String(i), direction: 'X', time: '10:00' }));
    boards._setFetcher(async () => rows);
    await boards.refresh(NOW);
    assert.strictEqual(boards.view(NOW).sofia.trains.length, 8);
    assert.strictEqual(boards.view(NOW).sofia.name, 'София');

    boards._setFetcher(async () => { throw new Error('БДЖ is down'); });
    await boards.refresh(NOW + 60000);
    assert.strictEqual(boards.view(NOW + 2 * 60000).sofia.trains.length, 8, 'still recent: kept');
    assert.strictEqual(boards.view(NOW + boards.KEEP_MS + 1000).sofia.trains, null,
        'too old to be called current: unavailable, not stale departures');
    assert.ok(boards.view(NOW + boards.KEEP_MS + 1000).sofia.fetchedAt, 'and it says when it last worked');
    boards._setFetcher(null);
    boards._reset();
});

test('boards: never fetched ⇒ trains null', () => {
    boards._reset();
    assert.deepStrictEqual(boards.view(NOW).plovdiv, { name: 'Пловдив', trains: null, fetchedAt: null });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

function call(handler, headers = {}) {
    const res = {
        statusCode: 200, headers: {}, body: null,
        status(c) { this.statusCode = c; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(o) { this.body = o; return this; },
        end(b) { if (b !== undefined) this.body = b; return this; },
    };
    handler({ headers }, res);
    return res;
}

test('http: 503 + Retry-After until the first snapshot exists', () => {
    snapshot._reset();
    const r = call(controller.getNetwork);
    assert.strictEqual(r.statusCode, 503);
    assert.strictEqual(r.headers['Retry-After'], '15');
});

test('http: served from the prebuilt buffer — gzip when accepted, identity otherwise', () => {
    cache.setTrips(new Map(), Date.now());
    cache.setVehicles(new Map(), Date.now());
    boards._reset();
    snapshot.build(Date.now());

    const gz = call(controller.getNetwork, { 'accept-encoding': 'gzip, deflate, br' });
    assert.strictEqual(gz.statusCode, 200);
    assert.strictEqual(gz.headers['Content-Encoding'], 'gzip');
    const parsed = JSON.parse(zlib.gunzipSync(gz.body).toString());
    assert.ok(parsed.generatedAt && parsed.summary && parsed.boards && parsed.realtime);

    const plain = call(controller.getNetwork, {});
    assert.strictEqual(plain.headers['Content-Encoding'], undefined);
    assert.deepStrictEqual(JSON.parse(plain.body.toString()), parsed);

    const noGz = call(controller.getNetwork, { 'accept-encoding': 'gzip;q=0' });
    assert.strictEqual(noGz.headers['Content-Encoding'], undefined, 'gzip;q=0 means no');

    const radar = call(controller.getRadar, { 'accept-encoding': 'gzip' });
    assert.strictEqual(radar.statusCode, 200);
    const rp = JSON.parse(zlib.gunzipSync(radar.body).toString());
    assert.ok(Array.isArray(rp.trains) && rp.count === rp.trains.length);
});

test('http: caches may keep it for at most one build interval; ETag → 304', () => {
    snapshot.build(Date.now());
    const first = call(controller.getNetwork, { 'accept-encoding': 'gzip' });
    const m = /^public, max-age=(\d+)$/.exec(first.headers['Cache-Control']);
    assert.ok(m, first.headers['Cache-Control']);
    assert.ok(Number(m[1]) >= 5 && Number(m[1]) <= 60);

    const again = call(controller.getNetwork, { 'if-none-match': first.headers.ETag });
    assert.strictEqual(again.statusCode, 304);
});

test('http: CORS echoes only the website and local development', () => {
    snapshot.build(Date.now());
    const site = call(controller.getNetwork, { origin: 'https://bultrain.eu' });
    assert.strictEqual(site.headers['Access-Control-Allow-Origin'], 'https://bultrain.eu');
    const dev = call(controller.getNetwork, { origin: 'http://localhost:5173' });
    assert.strictEqual(dev.headers['Access-Control-Allow-Origin'], 'http://localhost:5173');
    const evil = call(controller.getNetwork, { origin: 'https://evil.example' });
    assert.strictEqual(evil.headers['Access-Control-Allow-Origin'], undefined);
    assert.match(evil.headers.Vary, /Origin/);
});

test('build: the real inputs (cache + schedule) produce a snapshot in a few milliseconds', () => {
    cache.setTrips(new Map([['8627', [trip('8627-BV-1', 600)]]]), Date.now());
    cache.setVehicles(new Map([['8627', vehicle('8627-BV-1', 42, 23.5)]]), Date.now());
    const ms = snapshot.build(NOW);
    assert.ok(ms < 250, `build took ${ms} ms`);
    const radar = JSON.parse(snapshot.get('radar').json.toString());
    assert.ok(radar.trains.some(t => t.trainNum === '8627' && t.lat === 42));
});
