'use strict';

/**
 * Trains the timetable does not know. The national feed carries runs nobody can travel on (3401 /
 * 3402, 2026-11-25). They must not reach any public answer — and their delay history must still be
 * recorded. Runs the REAL poller against a fake source, then reads the real outputs.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-hidden-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
process.env.REALTIME = 'on';
process.env.RT_HISTORY = 'on';
require('../database/migrate')(TMP);

const axios    = require('axios');
const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');

const cfg      = require('../services/gtfs/config');
const history  = require('../services/realtime/history');
const cache    = require('../services/realtime/cache');
const poller   = require('../services/realtime/poller');
const tripMeta = require('../services/realtime/tripMeta');
const snapshot = require('../services/network/snapshot');
const realtime = require('../controllers/realtimeController');
const { publicOnly, MIN_TRAINS_TO_DOUBT } = require('../services/realtime/timetableFilter');

// history.record() is what writes the permanent record: capture it instead of touching a database
const recorded = [];
history.record = (num, stationId, date, delay) => recorded.push({ num, stationId, date, delay });

const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const logged = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));
test.after(() => { Date.now = realNow; console.log = origLog; console.error = origErr; });

const nowSec = () => Math.floor(Date.now() / 1000);
const today = tripMeta.sofiaYmd(Date.now());
const ymd = today.replace(/-/g, '');

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(2, 'София', 'Sofia', 42.0, 23.0);
    st.run(4, 'Бургас', 'Burgas', 42.0, 27.0);
    const map = db.prepare("INSERT INTO station_map (gtfs_stop_id, station_id, station_name, method, confidence) VALUES (?, ?, ?, 'name', 'high')");
    map.run('S2', 2, 'София'); map.run('S4', 4, 'Бургас');
    db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)').run('8627-BV-X', '8627', 'БВ');
    db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)').run('8627-BV-X', today);
    db.close();
}

// what the source publishes: trip ids, each mid-route, the unknown ones later than everyone else
let live = [];
const delayOf = (tripId) => (tripId.startsWith('8627') ? 300 : 3300);
const trips = () => live.map((tripId, i) => ({
    id: String(i),
    tripUpdate: {
        trip: { tripId },
        stopTimeUpdate: [
            { stopId: 'S2', departure: { time: nowSec() - 3600, delay: delayOf(tripId) } },
            { stopId: 'S4', arrival: { time: nowSec() + 3600, delay: delayOf(tripId) } },
        ],
    },
}));
const vehicles = () => live.map((tripId, i) => ({
    id: String(i),
    vehicle: { trip: { tripId }, position: { latitude: 42, longitude: 24 }, timestamp: nowSec() },
}));
axios.get = async (url) => ({
    data: Buffer.from(B.transit_realtime.FeedMessage.encode({
        header: { gtfsRealtimeVersion: '2.0', timestamp: nowSec() },
        entity: url === cfg.RT.tripUpdates ? trips() : vehicles(),
    }).finish()),
});

async function poll() { await poller.pollTripUpdates(); await poller.pollVehicles(); }
const call = (fn, req = {}) => {
    const r = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, set() { return this; }, end() { return this; } };
    fn({ params: {}, headers: {}, query: {}, ...req }, r);
    return r;
};
const publicView = () => {
    snapshot._reset(); snapshot.build(Date.now());
    return {
        net: JSON.parse(snapshot.get('network').json),
        radar: JSON.parse(snapshot.get('radar').json),
        vehicles: call(realtime.getVehicles).body,
    };
};

test('a train no timetable knows reaches no public answer', async () => {
    live = ['8627-BV-X', `3401-${ymd}`, `3402-${ymd}`];
    await poll();
    const v = publicView();

    assert.deepStrictEqual(v.radar.trains.map(t => t.trainNum), ['8627']);
    assert.strictEqual(v.net.summary.running, 1, 'not counted as running');
    assert.strictEqual(v.net.summary.withRealtime, 1);
    assert.strictEqual(v.net.summary.maxDelay.trainNum, '8627', 'its 55 minutes are not the network\'s worst delay');
    assert.strictEqual(v.net.summary.avgDelayMin, 5);
    assert.deepStrictEqual(v.vehicles.vehicles.map(x => x.trainNumber), ['8627'], 'no dot on the map, even with a position');
    for (const trainNo of ['3401', '3402']) {
        assert.strictEqual(call(realtime.getTrain, { params: { trainNo } }).code, 404);
        assert.strictEqual(call(realtime.getVehicle, { params: { trainNo } }).code, 404);
        assert.strictEqual(cache.getTrain(trainNo), null);
        assert.deepStrictEqual(cache.getTrips(trainNo), []);
    }
    assert.strictEqual(call(realtime.getTrain, { params: { trainNo: '8627' } }).code, 200);
});

test('its history is recorded all the same', () => {
    const of = (num) => recorded.filter(r => r.num === num);
    assert.deepStrictEqual(of('3402').map(r => [r.stationId, r.date, r.delay]), [[2, today, 3300], [4, today, 3300]]);
    assert.strictEqual(of('3401').length, 2);
    assert.strictEqual(of('8627').length, 2);
});

test('the log names what is withheld, once and not on every poll', async () => {
    await poll(); await poll();
    const lines = logged.filter(l => l.includes('kept from apps and website'));
    assert.strictEqual(lines.length, 2, 'one for each feed');
    assert.ok(lines.every(l => l.endsWith('3401, 3402')));
});

test('a known number under a trip id we do not have is still shown', async () => {
    live = [`8627-BV-${ymd}`];   // the feed renamed the run; the number is in the timetable
    await poll();
    assert.deepStrictEqual(publicView().radar.trains.map(t => t.trainNum), ['8627']);
});

test('a train the daily refresh adds to the timetable appears without a restart', async () => {
    live = ['8627-BV-X', `8400-${ymd}`];
    await poll();
    assert.strictEqual(cache.getTrain('8400'), null);

    const db = new Database(TMP);
    db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)').run('8400-PV-X', '8400', 'ПВ');
    db.close();
    skewMs += 11 * 60000;
    await poll();
    assert.ok(cache.getTrain('8400'));
});

test('nothing is hidden when the timetable cannot be the judge', () => {
    const feed = (n) => new Map(Array.from({ length: n }, (_, i) => [String(1000 + i), i]));

    assert.strictEqual(publicOnly(feed(3), new Set()).shown.size, 3, 'no timetable at all');

    const big = feed(MIN_TRAINS_TO_DOUBT);
    const few = new Set([...big.keys()].slice(0, 5));
    const doubted = publicOnly(big, few);
    assert.strictEqual(doubted.shown.size, big.size, 'it knows a quarter of what runs: it is out of date');
    assert.strictEqual(doubted.outOfStep, big.size - 5);

    const half = new Set([...big.keys()].slice(0, MIN_TRAINS_TO_DOUBT / 2));
    assert.strictEqual(publicOnly(big, half).shown.size, MIN_TRAINS_TO_DOUBT / 2, 'half unknown is still believed');

    // a quiet night: two unknown of three is just two service trains
    const night = publicOnly(feed(3), new Set(['1000']));
    assert.deepStrictEqual([night.shown.size, night.hidden], [1, ['1001', '1002']]);
});
