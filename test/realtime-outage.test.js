'use strict';

/**
 * What every realtime output says when the official source (the national access
 * point) breaks. Real incident: the Ministry's stream went down, the apps showed
 * only the schedule. The question this answers is "is every output honest while
 * the source is down, and can the apps tell WHY there is no live data?"
 *
 * It runs the REAL poller against a fake source that can fail in each way the real
 * one can (connection error, an HTML error page with HTTP 200, a valid but empty
 * message, a file with no timestamp, a frozen old file, one feed down and one up),
 * then reads every output: /vehicles, /vehicle/:n, /train/:n, /status, /health, the
 * public network snapshot + radar, the station board, the Live Activity gate.
 * Time is moved forward (Date.now) to cross the 3-minute freshness limit.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-outage-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
process.env.REALTIME = 'on';
require('../database/migrate')(TMP);

const axios    = require('axios');
const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');

const cfg        = require('../services/gtfs/config');
const cache      = require('../services/realtime/cache');
const poller     = require('../services/realtime/poller');
const tripMeta   = require('../services/realtime/tripMeta');
const snapshot   = require('../services/network/snapshot');
const ownBoard   = require('../services/live/ownBoard');
const realtimeGate = require('../services/liveactivity/realtimeGate');
const realtime   = require('../controllers/realtimeController');
const health     = require('../controllers/healthController');
const scheduleSearch = require('../controllers/scheduleController').__test;

const FeedMessage = B.transit_realtime.FeedMessage;

// ── a clock we can move ──────────────────────────────────────────────────────

const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
test.after(() => { Date.now = realNow; });
const advance = (min) => { skewMs += min * 60000; };

// ── fixture: one train that departs Sofia in 30 min, and a second, position-only one ─

const DEP = new Date(realNow() + 30 * 60000);
const DEP_YMD = tripMeta.sofiaYmd(DEP.getTime());
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' });
const DEP_SEC = Math.floor(DEP.getTime() / 1000);

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(2, 'София', 'Sofia', 42.0, 23.0);
    st.run(3, 'Пловдив', 'Plovdiv', 42.0, 24.0);
    st.run(4, 'Бургас', 'Burgas', 42.0, 27.0);
    const map = db.prepare("INSERT INTO station_map (gtfs_stop_id, station_id, station_name, method, confidence) VALUES (?, ?, ?, 'name', 'high')");
    map.run('S2', 2, 'София'); map.run('S3', 3, 'Пловдив'); map.run('S4', 4, 'Бургас');

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const date = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const t1 = '8627-BV-X';
    trip.run(t1, '8627', 'БВ'); date.run(t1, DEP_YMD);
    stop.run(t1, 1, 2, null, hhmm(DEP.getTime()));
    stop.run(t1, 2, 3, hhmm(DEP.getTime() + 60 * 60000), hhmm(DEP.getTime() + 62 * 60000));
    stop.run(t1, 3, 4, hhmm(DEP.getTime() + 180 * 60000), null);
    const t2 = '5614-PV-X';
    trip.run(t2, '5614', 'ПВ'); date.run(t2, DEP_YMD);
    stop.run(t2, 1, 2, null, hhmm(DEP.getTime() + 20 * 60000));
    stop.run(t2, 2, 4, hhmm(DEP.getTime() + 200 * 60000), null);
    db.close();
}

// ── a source that can fail every way ─────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

const tripFeed = (ts, extra = {}) => FeedMessage.encode(FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', ...(ts == null ? {} : { timestamp: ts }) },
    entity: extra.entity ?? [{
        id: '1',
        tripUpdate: {
            trip: { tripId: '8627-BV-X' },
            stopTimeUpdate: [
                { stopId: 'S2', departure: { time: DEP_SEC + 300, delay: 300 } },
                { stopId: 'S3', arrival: { time: DEP_SEC + 3900, delay: 300 }, departure: { time: DEP_SEC + 4020, delay: 300 } },
            ],
        },
    }],
})).finish();

const vehicleFeed = (ts, extra = {}) => FeedMessage.encode(FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', ...(ts == null ? {} : { timestamp: ts }) },
    entity: extra.entity ?? [
        { id: '1', vehicle: { trip: { tripId: '8627-BV-X' }, position: { latitude: 42.0, longitude: 23.2 }, timestamp: ts || 0, currentStatus: 2, stopId: 'S3' } },
        { id: '2', vehicle: { trip: { tripId: '5614-PV-X' }, position: { latitude: 42.0, longitude: 23.5 }, timestamp: ts || 0, currentStatus: 2, stopId: 'S4' } },
    ],
})).finish();

// what the fake source does for each feed: a function returning bytes, or throwing
const source = { trips: null, vehicles: null };
axios.get = async (url) => {
    const kind = url === cfg.RT.tripUpdates ? 'trips' : 'vehicles';
    return { data: Buffer.from(await source[kind]()) };
};
const healthy = () => {
    source.trips = async () => tripFeed(nowSec());
    source.vehicles = async () => vehicleFeed(nowSec());
};
const down = (kind) => { source[kind] = async () => { throw new Error('connect ETIMEDOUT sipbg.gov.bg'); }; };

async function pollBoth() { await poller.pollTripUpdates(); await poller.pollVehicles(); }

// quiet the expected "[rt] ... poll failed" lines
const origErr = console.error;
const origLog = console.log;
const logged = [];
console.error = (...a) => logged.push(a.join(' '));
console.log = (...a) => logged.push(a.join(' '));
test.after(() => { console.error = origErr; console.log = origLog; });

function resetCache() {
    cache.setTrips(new Map(), 0);
    cache.setVehicles(new Map(), 0);
}

const res = () => ({
    code: 200, h: {}, body: null,
    status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; },
    set(k, v) { this.h[k] = v; return this; }, end() { return this; },
});
const call = (fn, req = {}) => { const r = res(); fn({ params: {}, headers: {}, query: {}, ...req }, r); return r; };

/** Every realtime output, read at the current moment. */
function outputs() {
    snapshot._reset(); snapshot.build(Date.now());
    const net = JSON.parse(snapshot.get('network').json);
    const radar = JSON.parse(snapshot.get('radar').json);
    return {
        vehicles: call(realtime.getVehicles).body,
        train: call(realtime.getTrain, { params: { trainNo: '8627' } }),
        positionTrain: call(realtime.getTrain, { params: { trainNo: '5614' } }),
        ghost: call(realtime.getTrain, { params: { trainNo: '99999' } }),
        vehicle: call(realtime.getVehicle, { params: { trainNo: '8627' } }),
        status: call(realtime.getStatus).body,
        health: call(health.getHealth).body,
        net, radar,
        board: ownBoard.build({ stationId: 2, nowMs: Date.now(), extended: true }),
        gate: realtimeGate.holds('8627', Date.now(), new Date(Date.now() + 3 * 3600000).toISOString()),
    };
}

/** The common promise when there is NO live data: nothing live is claimed. */
function assertNothingLiveClaimed(o, why) {
    assert.strictEqual(o.vehicles.count, 0, `${why}: no dots`);
    assert.strictEqual(o.vehicles.feedFresh, false, `${why}: feedFresh`);
    assert.strictEqual(o.vehicles.delaysFresh, false, `${why}: delaysFresh`);
    assert.strictEqual(o.train.code, 404, `${why}: /train 404`);
    assert.strictEqual(o.train.body.realtimeAvailable, false, `${why}: the 404 says the source is the reason`);
    assert.strictEqual(o.vehicle.code, 404);
    assert.strictEqual(o.vehicle.body.realtimeAvailable, false);
    assert.strictEqual(o.net.realtime.available, false, `${why}: network.available`);
    assert.strictEqual(o.net.summary.withRealtime, 0);
    assert.strictEqual(o.net.summary.onTimePercent, null, `${why}: no percentage invented`);
    assert.strictEqual(o.net.summary.avgDelayMin, null);
    assert.strictEqual(o.net.summary.maxDelay, null);
    assert.ok(o.radar.trains.every(t => t.delayMin === null && t.lat === null && t.lon === null && t.progress === null),
        `${why}: radar carries no delay and no position`);
    assert.ok(o.board.trains.every(t => t.hasLiveDelay === false && t.isDelayed === false),
        `${why}: board rows are schedule only, none marked late`);
    assert.strictEqual(o.health.realtime.tripFresh, false);
    assert.strictEqual(o.health.realtime.vehicleFresh, false);
}

// ── 0. healthy: the reference ────────────────────────────────────────────────

test('healthy source: everything is live and says so', async () => {
    resetCache(); healthy(); await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.count, 2);
    assert.strictEqual(o.vehicles.feedFresh, true);
    assert.strictEqual(o.vehicles.delaysFresh, true);
    assert.strictEqual(o.train.code, 200);
    assert.strictEqual(o.train.body.delayMinutes, 5);
    assert.strictEqual(o.net.realtime.available, true);
    assert.strictEqual(o.net.summary.withRealtime, 1);
    assert.strictEqual(o.net.summary.onTimePercent, 0, 'a 5-minute delay is not "on time"');
    assert.ok(o.board.trains.find(t => t.trainNum === '8627').hasLiveDelay, 'the board knows this one');
    assert.strictEqual(o.gate, false);
    assert.strictEqual(o.health.realtime.tripFresh, true);
    assert.strictEqual(o.status.polls.trips.failures, 0);
    assert.ok(o.status.polls.trips.lastOkAt);
});

test('a train in neither feed is a 404 that says the source is UP (so: no data for this train)', () => {
    const o = outputs();
    assert.strictEqual(o.ghost.code, 404);
    assert.strictEqual(o.ghost.body.realtimeAvailable, true);
});

// ── 1. the source stops answering ────────────────────────────────────────────

test('source down: the last data is served while it is still fresh, then everything flips to "no live data"', async () => {
    resetCache(); healthy(); await pollBoth();
    down('trips'); down('vehicles');
    await pollBoth();                                           // the poll fails, nothing is thrown

    let o = outputs();
    assert.strictEqual(o.status.polls.trips.failures, 1, 'the failure is counted');
    assert.match(o.status.polls.trips.lastError, /ETIMEDOUT/, 'and its reason is kept for the operator');
    assert.strictEqual(o.vehicles.count, 2, 'data under 3 minutes old is still the truth');
    assert.strictEqual(o.vehicles.feedFresh, true);

    advance(4);                                                 // past the 3-minute limit
    await pollBoth();
    o = outputs();
    assertNothingLiveClaimed(o, 'source down');
    assert.ok(o.status.polls.trips.failures >= 2);
    assert.strictEqual(o.gate, true, 'Live Activities are left alone (no end, no blank) while the feed is down');
    assert.strictEqual(o.net.summary.running >= 0, true);
});

test('the schedule keeps working while the source is down: boards still list trains, honestly unmarked', () => {
    const o = outputs();
    const row = o.board.trains.find(t => t.trainNum === '8627');
    assert.ok(row, 'the train is still on the board — it is in the schedule');
    assert.strictEqual(row.hasLiveDelay, false);
    assert.strictEqual(row.isDelayed, false);
    assert.strictEqual(row.time, hhmm(DEP.getTime()), 'its scheduled time');
});

test('the log says it once, not every 30 seconds, and says when the source is back', async () => {
    resetCache(); healthy(); await pollBoth();
    logged.length = 0;
    down('trips'); down('vehicles');
    for (let i = 0; i < 6; i++) await pollBoth();
    const failures = logged.filter(l => /poll failed/.test(l));
    assert.strictEqual(failures.length, 2, 'one line per feed for six failed polls');

    healthy();
    await pollBoth();
    assert.ok(logged.some(l => /tripUpdates feed is back/.test(l)));
    assert.ok(logged.some(l => /vehiclePositions feed is back/.test(l)));
    const o = outputs();
    assert.strictEqual(o.status.polls.trips.failures, 0, 'the counter starts over');
    assert.strictEqual(o.vehicles.feedFresh, true);
});

// ── 2. the source answers, but with rubbish ──────────────────────────────────

test('HTTP 200 with an HTML error page: no crash, no fake data, the old data just ages out', async () => {
    resetCache(); healthy(); await pollBoth();
    const html = async () => '<html><body><h1>503 Service Unavailable</h1></body></html>';
    source.trips = html; source.vehicles = html;
    await pollBoth();

    let o = outputs();
    assert.ok(o.status.polls.trips.failures >= 1, 'counted as a failure, not as data');
    assert.strictEqual(o.vehicles.count, 2, 'previous data untouched while fresh');
    advance(4);
    await pollBoth();
    assertNothingLiveClaimed(outputs(), 'html page');
});

test('a valid but EMPTY message while the feed was full: treated as the source breaking, not as "no trains"', async () => {
    resetCache(); healthy(); await pollBoth();
    // make the feed look full enough that an instant "nothing" is not believable
    const many = Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        vehicle: { trip: { tripId: `${9000 + i}-PV-X` }, position: { latitude: 42, longitude: 23 + i / 100 }, timestamp: nowSec(), currentStatus: 2, stopId: 'S3' },
    }));
    source.vehicles = async () => vehicleFeed(nowSec(), { entity: many });
    await poller.pollVehicles();
    assert.strictEqual(call(realtime.getVehicles).body.count, 12);

    source.vehicles = async () => vehicleFeed(nowSec(), { entity: [] });
    await poller.pollVehicles();
    const o = outputs();
    assert.strictEqual(o.vehicles.count, 12, 'the 12 trains are not wiped by one empty answer');
    assert.match(o.status.polls.vehicles.lastError, /empty/);

    advance(4);
    await poller.pollVehicles();                                // still empty; the old data is stale now
    assert.strictEqual(call(realtime.getVehicles).body.count, 0);
    // With little scheduled on the road an empty answer is believable (see the night test below).
});

test('an empty message in the DAY (the schedule has many trains on the road) is never claimed to be fresh', async () => {
    // 16 trains scheduled on the road right now
    const db = new Database(TMP);
    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const date = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const from = hhmm(Date.now() - 10 * 60000), to = hhmm(Date.now() + 60 * 60000);
    const ymd = tripMeta.sofiaYmd(Date.now());
    for (let i = 0; i < 16; i++) {
        trip.run(`B${i}-PV-X`, `B${i}`, 'ПВ'); date.run(`B${i}-PV-X`, ymd);
        stop.run(`B${i}-PV-X`, 1, 2, null, from); stop.run(`B${i}-PV-X`, 2, 3, to, null);
    }
    db.close();
    require('../services/network/schedule')._reset();
    try {
        resetCache();
        source.vehicles = async () => vehicleFeed(nowSec(), { entity: [] });
        source.trips = async () => tripFeed(nowSec(), { entity: [] });
        await pollBoth();
        const o = call(realtime.getVehicles).body;
        assert.strictEqual(o.feedFresh, false, 'the source says "no trains" while the schedule has 16 on the road: not believed');
        assert.match(cache.status().polls.vehicles.lastError, /schedule has 16 trains/);
        assert.strictEqual(call(realtime.getTrain, { params: { trainNo: '8627' } }).body.realtimeAvailable, false);
    } finally {
        const cleanup = new Database(TMP);
        cleanup.prepare("DELETE FROM trip_stop WHERE trip_id LIKE 'B%-PV-X'").run();
        cleanup.prepare("DELETE FROM trip_date WHERE trip_id LIKE 'B%-PV-X'").run();
        cleanup.prepare("DELETE FROM trip WHERE trip_id LIKE 'B%-PV-X'").run();
        cleanup.close();
        require('../services/network/schedule')._reset();
    }
});

test('an empty message at night (nothing was running) is accepted: fresh, zero trains', async () => {
    resetCache();
    source.trips = async () => tripFeed(nowSec(), { entity: [] });
    source.vehicles = async () => vehicleFeed(nowSec(), { entity: [] });
    await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.count, 0);
    assert.strictEqual(o.vehicles.feedFresh, true, 'the source is up and says no trains');
    assert.strictEqual(o.train.body.realtimeAvailable, true);
});

test('a message with NO timestamp is never treated as fresh (a frozen file must not look live)', async () => {
    resetCache();
    source.trips = async () => tripFeed(null);
    source.vehicles = async () => vehicleFeed(null, { entity: [
        { id: '1', vehicle: { trip: { tripId: '8627-BV-X' }, position: { latitude: 42, longitude: 23.2 } } },
    ] });
    await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.feedFresh, false, 'no header time and no entity time: unknown, so not fresh');
    assert.strictEqual(o.vehicles.count, 0);
    assert.strictEqual(poller.feedTimestampMs(FeedMessage.decode(vehicleFeed(null, { entity: [] }))), 0);

    // with entity times but no header time, the newest entity time is used
    const stamped = FeedMessage.decode(vehicleFeed(null, { entity: [
        { id: '1', vehicle: { trip: { tripId: 'x' }, position: { latitude: 1, longitude: 1 }, timestamp: 1790000000 } },
        { id: '2', vehicle: { trip: { tripId: 'y' }, position: { latitude: 1, longitude: 1 }, timestamp: 1790000100 } },
    ] }));
    assert.strictEqual(poller.feedTimestampMs(stamped), 1790000100 * 1000);
});

test('the source keeps serving an OLD file with HTTP 200: stale by its own clock', async () => {
    resetCache();
    const old = nowSec() - 3600;                                // an hour old
    source.trips = async () => tripFeed(old);
    source.vehicles = async () => vehicleFeed(old);
    await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.count, 0, 'an hour-old position is not a position');
    assert.strictEqual(o.vehicles.feedFresh, false);
    assert.strictEqual(o.train.body.realtimeAvailable, false);
    assert.strictEqual(o.net.realtime.available, false);
    assert.ok(o.net.realtime.feedUpdatedAt, 'the site can say how old it is');
    assert.strictEqual(o.status.polls.trips.failures, 0, 'the poll itself succeeded — the data was old, and /status shows both facts');
});

// ── 3. one feed down, the other up ───────────────────────────────────────────

test('trips down, positions up: dots stay, but no delay is claimed for any of them', async () => {
    resetCache(); healthy(); await pollBoth();
    down('trips'); advance(4);
    source.vehicles = async () => vehicleFeed(nowSec());        // positions keep coming
    await pollBoth();

    const o = outputs();
    assert.strictEqual(o.vehicles.feedFresh, true, 'the positions are live');
    assert.strictEqual(o.vehicles.delaysFresh, false, 'the delays are not — the apps can say so');
    assert.ok(o.vehicles.vehicles.every(v => v.delayMinutes === null && v.hasLiveDelay === false),
        'no stale delay survives on any dot');
    assert.strictEqual(o.net.realtime.available, false, 'the headline numbers rest on the delays');
    assert.strictEqual(o.net.summary.onTimePercent, null);
    assert.ok(o.radar.trains.some(t => t.lat !== null), 'but the radar still has the measured positions');
    assert.strictEqual(o.positionTrain.code, 200, 'a position-only train still opens');
    assert.strictEqual(o.positionTrain.body.hasLiveDelay, false);
    assert.strictEqual(o.positionTrain.body.delayMinutes, null);
});

test('positions down, trips up: delays stay, no position is shown', async () => {
    resetCache(); healthy(); await pollBoth();
    down('vehicles'); advance(4);
    source.trips = async () => tripFeed(nowSec());
    await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.count, 0);
    assert.strictEqual(o.vehicles.feedFresh, false);
    assert.strictEqual(o.vehicles.delaysFresh, true);
    assert.strictEqual(o.train.code, 200, 'the train still has its delay');
    assert.strictEqual(o.train.body.delayMinutes, 5);
    assert.strictEqual(o.train.body.position, null, 'and no position');
    assert.ok(o.radar.trains.every(t => t.lat === null));
});

// ── 4. never had data at all (a restart in the middle of an outage) ──────────

test('restart during an outage: empty cache, no source — everything says "no live data"', async () => {
    resetCache();
    down('trips'); down('vehicles');
    await pollBoth();
    assertNothingLiveClaimed(outputs(), 'restart during outage');
    assert.match(outputs().status.polls.trips.lastError, /ETIMEDOUT/, 'and the operator can see why');
});

// ── 4b. the train search (journey results) ───────────────────────────────────

test('train search: a leg shows its live delay while the feed is live, and "no coverage" — never a stale delay — when it is not', async () => {
    const legs = () => scheduleSearch.withLiveDelay([{ trainNumber: '8627', from: 'София', _fromStationId: 2 }]);

    resetCache(); healthy(); await pollBoth();
    assert.deepStrictEqual(
        legs().map(l => [l.hasLiveDelay, l.delayMinutes]), [[true, 5]], 'live: the delay at the boarding station');

    down('trips'); advance(4);
    await poller.pollTripUpdates();
    assert.deepStrictEqual(
        legs().map(l => [l.hasLiveDelay, l.delayMinutes]), [[false, null]],
        'outage: hasLiveDelay false and delay null — the 5 minutes from before the outage is not repeated');
});

// ── 5. coming back ───────────────────────────────────────────────────────────

test('recovery: when the source returns, every output is live again with no manual step', async () => {
    resetCache();
    down('trips'); down('vehicles');
    await pollBoth();
    healthy();
    await pollBoth();
    const o = outputs();
    assert.strictEqual(o.vehicles.feedFresh, true);
    assert.strictEqual(o.vehicles.count, 2);
    assert.strictEqual(o.train.code, 200);
    assert.strictEqual(o.net.realtime.available, true);
    assert.strictEqual(o.gate, false);
    assert.strictEqual(o.status.polls.vehicles.failures, 0);
});
