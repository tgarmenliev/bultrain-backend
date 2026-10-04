'use strict';

/**
 * The live-map contract. The map's strongest claim is "this train is here, now",
 * so these pin the rules it rests on:
 *   - a vehicle's time and stop status are the feed's own, or null — never invented
 *   - a train with no TripUpdate has delayMinutes null / hasLiveDelay false
 *   - the dot (/vehicles) and the screen it opens (/train/:no) agree
 *   - old fields and types are untouched; new ones are additive
 *   - /vehicles polls cheaply (ETag → 304)
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-livemap-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');

const cache      = require('../services/realtime/cache');
const controller = require('../controllers/realtimeController');
const tripMeta   = require('../services/realtime/tripMeta');
const { fromEntity } = require('../services/realtime/vehicleFields');

const FeedMessage = B.transit_realtime.FeedMessage;

// ── Fixture: one feed train, one position-only train, on a straight line ────

const NOW_SEC = Math.floor(Date.now() / 1000);

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(1, 'А', 'A', 42.0, 25.00);
    st.run(2, 'Б', 'B', 42.0, 25.20);
    st.run(3, 'В', 'C', 42.0, 25.40);
    st.run(4, 'Т', 'T', 42.0, 25.30);   // a timing point the train passes without calling

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');

    // 8613: a fast train, calls at А, Б, В.
    trip.run('8613-BV-20261004', '8613', 'БВ');
    stop.run('8613-BV-20261004', 1, 1, null, '10:00');
    stop.run('8613-BV-20261004', 2, 2, '10:30', '10:32');
    stop.run('8613-BV-20261004', 3, 3, '11:00', null);

    // 5614: a plain train, position only.
    trip.run('5614-PV-20261004', '5614', 'ПВ');
    stop.run('5614-PV-20261004', 1, 1, null, '10:00');
    stop.run('5614-PV-20261004', 2, 2, '10:30', '10:32');
    stop.run('5614-PV-20261004', 3, 3, '11:00', null);
    db.close();
}

function mockRes() {
    return {
        statusCode: 200, body: null, headers: {},
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        end() { return this; },
    };
}

const call = (fn, req = {}) => {
    const res = mockRes();
    fn({ params: {}, headers: {}, query: {}, ...req }, res);
    return res;
};

const FEED_TS = Date.now();

// 8613 has a TripUpdate (with a timing point Т it doesn't call at); 5614 only a position.
function seedFeeds(vehicleExtra = {}) {
    const rt = { tripId: '8613-BV-20261004', stops: [
        { stationId: 1, station: 'А', arrivalDelay: null, arrivalTime: null, departureDelay: 300, departureTime: NOW_SEC - 600, skipped: false },
        { stationId: 4, station: 'Т', arrivalDelay: 420, arrivalTime: NOW_SEC + 120, departureDelay: 420, departureTime: NOW_SEC + 120, skipped: false },
        { stationId: 2, station: 'Б', arrivalDelay: 480, arrivalTime: NOW_SEC + 900, departureDelay: 480, departureTime: NOW_SEC + 960, skipped: false },
    ] };
    cache.setTrips(new Map([['8613', [rt]]]), FEED_TS);
    cache.setVehicles(new Map([
        ['8613', { tripId: '8613-BV-20261004', lat: 42.0, lon: 25.10, bearing: 90,
                   positionTimestamp: FEED_TS, stopStatus: 'IN_TRANSIT_TO', ...vehicleExtra }],
        ['5614', { tripId: '5614-PV-20261004', lat: 42.0, lon: 25.30, bearing: 90,
                   positionTimestamp: FEED_TS, stopStatus: 'STOPPED_AT' }],
    ]), FEED_TS);
}

// ── vehicleFields: pass through, never invent ────────────────────────────────

test('vehicle time and stop status come from the entity; absent means null, not a default', () => {
    const buf = FeedMessage.encode(FeedMessage.create({
        header: { gtfsRealtimeVersion: '2.0', timestamp: 1791124131 },
        entity: [
            { id: 'a', vehicle: {
                trip: { tripId: 'x' }, position: { latitude: 42, longitude: 25 },
                timestamp: 1791124000, currentStatus: 1,        // STOPPED_AT
            } },
            // The feed said nothing about time or status.
            { id: 'b', vehicle: { trip: { tripId: 'y' }, position: { latitude: 42, longitude: 25 } } },
            // INCOMING_AT is enum value 0 — the protobuf default; it must survive when it IS sent.
            { id: 'c', vehicle: { trip: { tripId: 'z' }, position: { latitude: 42, longitude: 25 }, currentStatus: 0 } },
        ],
    })).finish();
    const feed = FeedMessage.decode(buf);

    assert.deepStrictEqual(fromEntity(feed.entity[0].vehicle),
        { positionTimestamp: 1791124000 * 1000, stopStatus: 'STOPPED_AT' });
    assert.deepStrictEqual(fromEntity(feed.entity[1].vehicle),
        { positionTimestamp: null, stopStatus: null },
        'a missing timestamp/status must stay null — not the feed time, not INCOMING_AT');
    assert.strictEqual(fromEntity(feed.entity[2].vehicle).stopStatus, 'INCOMING_AT');
});

// ── /vehicles ────────────────────────────────────────────────────────────────

test('/vehicles keeps the old fields and adds the new ones, flat', () => {
    seedFeeds();
    const res = call(controller.getVehicles);
    const b = res.body;

    assert.strictEqual(b.count, 2);
    assert.strictEqual(b.feedTimestamp, FEED_TS, 'same value as vehicleFeedTs in /status');
    assert.strictEqual(b.feedTimestamp, cache.status().vehicleFeedTs);

    const v = b.vehicles.find(x => x.trainNumber === '8613');
    // untouched
    assert.strictEqual(v.lat, 42.0);
    assert.strictEqual(v.lon, 25.10);
    assert.strictEqual(v.bearing, 90);
    // new
    assert.strictEqual(v.positionTimestamp, FEED_TS);
    assert.strictEqual(v.stopStatus, 'IN_TRANSIT_TO');
    assert.strictEqual(v.trainType, 'FAST');
    assert.strictEqual(v.originStationId, 1);
    assert.strictEqual(v.destinationStationId, 3);
    for (const k of ['delayMinutes', 'hasLiveDelay', 'progressSource', 'nextStationId', 'serviceDate']) {
        assert.ok(k in v, `${k} present`);
    }
});

test('a train with no TripUpdate never carries a delay: null / false, not 0', () => {
    seedFeeds();
    const v = call(controller.getVehicles).body.vehicles.find(x => x.trainNumber === '5614');
    assert.strictEqual(v.hasLiveDelay, false);
    assert.strictEqual(v.delayMinutes, null);
    assert.strictEqual(v.progressSource, 'position', 'a position that fits its trip is placed on it');
    assert.strictEqual(v.nextStationId, 3, 'at 25.30, between Б and В');
});

test('the dot and the screen it opens agree on delay, source and next stop', () => {
    seedFeeds();
    const dots = call(controller.getVehicles).body.vehicles;
    for (const dot of dots) {
        const screen = call(controller.getTrain, { params: { trainNo: dot.trainNumber } }).body;
        assert.strictEqual(dot.delayMinutes,   screen.delayMinutes,   `${dot.trainNumber} delayMinutes`);
        assert.strictEqual(dot.hasLiveDelay,   screen.hasLiveDelay,   `${dot.trainNumber} hasLiveDelay`);
        assert.strictEqual(dot.progressSource, screen.progressSource, `${dot.trainNumber} progressSource`);
        assert.strictEqual(dot.nextStationId,  screen.nextStationId,  `${dot.trainNumber} nextStationId`);
    }
});

test('the feed train: real delay, and the next CALLING stop skips the timing point', () => {
    seedFeeds();
    const dot = call(controller.getVehicles).body.vehicles.find(x => x.trainNumber === '8613');
    assert.strictEqual(dot.hasLiveDelay, true);
    assert.strictEqual(dot.progressSource, 'feed');
    assert.strictEqual(dot.delayMinutes, 7, 'headline delay is the next upcoming stop (the timing point), as before');
    assert.strictEqual(dot.nextStationId, 2, 'Т is only passed; the next stop the train calls at is Б');

    const screen = call(controller.getTrain, { params: { trainNo: '8613' } }).body;
    assert.strictEqual(screen.nextStation, 'Т', 'the existing field is unchanged');
    const flags = Object.fromEntries(screen.stops.map(s => [s.station, s.callingPoint]));
    assert.deepStrictEqual(flags, { 'А': true, 'Т': false, 'Б': true });
});

test('a stop the feed marks SKIPPED is not a calling point', () => {
    seedFeeds();
    const rt = cache.getTrain('8613');
    rt.stops[2].skipped = true;      // Б
    const dot = call(controller.getVehicles).body.vehicles.find(x => x.trainNumber === '8613');
    assert.notStrictEqual(dot.nextStationId, 2);
});

test('a missing timestamp from the feed reaches the client as null, not as the feed time', () => {
    seedFeeds({ positionTimestamp: null, stopStatus: null });
    const dot = call(controller.getVehicles).body.vehicles.find(x => x.trainNumber === '8613');
    assert.strictEqual(dot.positionTimestamp, null);
    assert.strictEqual(dot.stopStatus, null);
    const screen = call(controller.getTrain, { params: { trainNo: '8613' } }).body;
    assert.strictEqual(screen.position.positionTimestamp, null);
});

test('/train/:no: position carries the new fields; old ones keep their types', () => {
    seedFeeds();
    const b = call(controller.getTrain, { params: { trainNo: '8613' } }).body;
    assert.deepStrictEqual(b.position, {
        lat: 42.0, lon: 25.10, bearing: 90, positionTimestamp: FEED_TS, stopStatus: 'IN_TRANSIT_TO',
    });
    assert.strictEqual(typeof b.trainNumber, 'string');
    assert.strictEqual(typeof b.delayMinutes, 'number');
    assert.strictEqual(typeof b.hasLiveDelay, 'boolean');
    assert.ok(Array.isArray(b.stops));
});

test('the vehicle is paired with its OWN run, never another run of the same number', () => {
    // Two runs of 8613 in the feed; the vehicle belongs to the 20261004 one.
    const other = { tripId: '8613-BV-20261003', stops: [
        { stationId: 2, station: 'Б', arrivalDelay: 3000, arrivalTime: NOW_SEC + 60, departureDelay: 3000, departureTime: NOW_SEC + 90, skipped: false },
    ] };
    const mine = { tripId: '8613-BV-20261004', stops: [
        { stationId: 2, station: 'Б', arrivalDelay: 60, arrivalTime: NOW_SEC + 900, departureDelay: 60, departureTime: NOW_SEC + 960, skipped: false },
    ] };
    cache.setTrips(new Map([['8613', [other, mine]]]), FEED_TS);
    cache.setVehicles(new Map([['8613', { tripId: '8613-BV-20261004', lat: 42, lon: 25.1, bearing: 0,
        positionTimestamp: FEED_TS, stopStatus: null }]]), FEED_TS);
    const dot = call(controller.getVehicles).body.vehicles[0];
    assert.strictEqual(dot.delayMinutes, 1, 'the vehicle’s own run, not the 50-minute-late other one');

    // And when its own run is absent from TripUpdates, another run's delay must not be borrowed.
    cache.setTrips(new Map([['8613', [other]]]), FEED_TS);
    const dot2 = call(controller.getVehicles).body.vehicles[0];
    assert.strictEqual(dot2.hasLiveDelay, false);
    assert.strictEqual(dot2.delayMinutes, null);
});

test('stale vehicles are kept; a wholly stale feed is empty, as before', () => {
    seedFeeds({ positionTimestamp: FEED_TS - 20 * 60 * 1000 });
    const dot = call(controller.getVehicles).body.vehicles.find(x => x.trainNumber === '8613');
    assert.strictEqual(dot.positionTimestamp, FEED_TS - 20 * 60 * 1000, 'the old time is shown, the dot is not dropped');

    cache.setVehicles(new Map([['8613', { tripId: 'x', lat: 1, lon: 1, bearing: 0 }]]), Date.now() - 10 * 60 * 1000);
    assert.strictEqual(call(controller.getVehicles).body.count, 0);
});

// ── Polling cost ─────────────────────────────────────────────────────────────

test('/vehicles: ETag + If-None-Match → 304 within the same tick, 200 after it', () => {
    seedFeeds();
    const first = call(controller.getVehicles);
    const etag = first.headers.ETag;
    assert.ok(etag, 'ETag is sent');
    assert.match(first.headers['Cache-Control'], /max-age=\d+/);
    assert.match(first.headers['Cache-Control'], /private/, 'behind the API key: no shared caching');

    const again = call(controller.getVehicles, { headers: { 'if-none-match': etag } });
    assert.strictEqual(again.statusCode, 304);
    assert.strictEqual(again.headers.ETag, etag);

    const weak = call(controller.getVehicles, { headers: { 'if-none-match': `W/${etag}` } });
    assert.strictEqual(weak.statusCode, 304, 'a proxy-weakened tag still matches');

    // the vehicle feed ticks → new tag → full body
    cache.setVehicles(cache.getAllVehicles().length ? new Map(cache.getAllVehicles()) : new Map(), FEED_TS + 30000);
    const next = call(controller.getVehicles, { headers: { 'if-none-match': etag } });
    assert.strictEqual(next.statusCode, 200);
    assert.notStrictEqual(next.headers.ETag, etag);
});

// ── Service date ─────────────────────────────────────────────────────────────

test('serviceDate comes from the saved schedule, and an overnight run is still yesterday’s after midnight', () => {
    const meta = (over) => ({
        crossesMidnight: false, firstMin: 10 * 60, lastMin: 12 * 60,
        dates: new Set(['2026-10-03', '2026-10-04']), ...over,
    });
    const at = (iso) => Date.parse(iso);

    // an ordinary daytime run belongs to the day it is on the road
    assert.strictEqual(tripMeta.deriveServiceDate(meta(), at('2026-10-04T09:00:00Z')), '2026-10-04');
    // not scheduled that day → we do not claim one
    assert.strictEqual(tripMeta.deriveServiceDate(meta({ dates: new Set(['2026-09-01']) }), at('2026-10-04T09:00:00Z')), null);

    // overnight 23:24 → 02:09: at 00:40 Sofia (21:40Z the evening before) it is the run that left yesterday
    const night = meta({ crossesMidnight: true, firstMin: 23 * 60 + 24, lastMin: 2 * 60 + 9 });
    assert.strictEqual(tripMeta.deriveServiceDate(night, at('2026-10-03T21:40:00Z')), '2026-10-03');
    // …and at 23:50 Sofia the same trip is today's run
    assert.strictEqual(tripMeta.deriveServiceDate(night, at('2026-10-04T20:50:00Z')), '2026-10-04');
    // a run that left yesterday and only runs yesterday is still yesterday's after midnight
    const onlyYday = { ...night, dates: new Set(['2026-10-03']) };
    assert.strictEqual(tripMeta.deriveServiceDate(onlyYday, at('2026-10-03T21:40:00Z')), '2026-10-03');
    assert.strictEqual(tripMeta.deriveServiceDate(null, Date.now()), null);
});

test('origin/destination are null when that end of the trip is not a mapped station', () => {
    const db = new Database(TMP);
    db.prepare("INSERT INTO trip (trip_id, train_number, category) VALUES ('9000-PV-20261004', '9000', 'ПВ')").run();
    db.prepare("INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES ('9000-PV-20261004', 1, NULL, NULL, '10:00')").run();
    db.prepare("INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES ('9000-PV-20261004', 2, 2, '10:30', NULL)").run();
    db.close();
    tripMeta._reset();
    const m = tripMeta.get('9000-PV-20261004');
    assert.strictEqual(m.originStationId, null, 'the first stop is unmapped: do not promote the second');
    assert.strictEqual(m.destinationStationId, 2);
    assert.strictEqual(tripMeta.get('no-such-trip'), null);
});
