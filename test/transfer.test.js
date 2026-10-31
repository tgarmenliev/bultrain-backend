'use strict';

/**
 * The change between two trains. Real journey, 2026-10-30: София → Септември (БВ 8611), change,
 * Септември → Банско (БВ 1661).
 *
 * What went wrong: the app reported the arrival, the server moved the card on to the second train
 * four seconds later — and then the app's cold start in the middle of the change registered the
 * FIRST train again, overwrote the card's row, and nothing ever moved it on until the second train
 * had left. And even when the card was right it had no layout for the change itself.
 *
 *  - register never moves a card back to an earlier leg
 *  - between the legs the card is the transfer: where, what to wait for, whether it works out
 *  - the server does not hang the whole journey on one callback from the phone
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-transfer-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const cache        = require('../services/realtime/cache');
const armedStore   = require('../services/liveactivity/armedStore');
const laStore      = require('../services/liveactivity/store');
const apns         = require('../services/liveactivity/apns');
const armedWatcher = require('../services/liveactivity/armedWatcher');
const worker       = require('../services/liveactivity/worker');
const contentState = require('../services/liveactivity/contentState');
const transfer     = require('../services/liveactivity/transfer');
const liveController  = require('../controllers/liveActivityController');
const armedController = require('../controllers/armedJourneyController');

const MIN = 60;
const INSTALL = 'install-transfer-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);
const T0 = Math.floor(Date.now() / 1000);                // "now", in unix seconds
const iso = (sec) => new Date(sec * 1000).toISOString();

// Stations of the two runs: 1 София, 2 Септември, 3 Банско.
const SOFIA = 1, SEPTEMBRI = 2, BANSKO = 3;

/** A run of one leg: [stationId, station, arrival, arrivalDelay, departure, departureDelay]. */
const run = (tripId, stops) => ({
    tripId,
    stops: stops.map(([stationId, station, arrivalTime, arrivalDelay, departureTime, departureDelay]) =>
        ({ stationId, station, arrivalTime, arrivalDelay, departureTime, departureDelay, skipped: false })),
});

/**
 * The journey: leg 0 arrives at Септември at `arr0` (scheduled T0-3min), leg 1 leaves it at
 * `dep1` (scheduled T0+10min). Feed delays are given in minutes.
 */
let n = 0;
function journey({ arrDelay0 = 0, depDelay1 = 0, feed1 = true, withTokenOnLeg0 = true } = {}) {
    n++;
    const id = `j-transfer-${n}`;
    const t8611 = String(8600 + n), t1661 = String(1600 + n);
    const sched = {
        dep0: T0 - 60 * MIN, arr0: T0 - 3 * MIN,
        dep1: T0 + 10 * MIN, arr1: T0 + 130 * MIN,
    };
    const token = hexToken(n.toString(16).padStart(1, '0'));
    const trips = new Map();
    trips.set(t8611, [run(`${t8611}-A`, [
        [SOFIA, 'София', null, null, sched.dep0, 0],
        [SEPTEMBRI, 'Септември', sched.arr0 + arrDelay0 * MIN, arrDelay0 * MIN, null, null],
    ])]);
    if (feed1) {
        trips.set(t1661, [run(`${t1661}-A`, [
            [SEPTEMBRI, 'Септември', null, null, sched.dep1 + depDelay1 * MIN, depDelay1 * MIN],
            [BANSKO, 'Банско', sched.arr1 + depDelay1 * MIN, depDelay1 * MIN, null, null],
        ])]);
        // the feed carries the delay only on the stops that have a reading; no delay field at all
        // is simulated by the caller passing depDelay1 = null
    }

    const leg = (idx, train, boarding, destination, dep, arr, display) => armedStore.arm({
        install_id: INSTALL, journey_id: id, leg_index: idx, train_number: train, train_number_display: display,
        boarding_station: boarding, destination_station: destination, direction_station: destination,
        scheduled_departure: iso(dep), scheduled_arrival: iso(arr),
        is_current_bus: 0, next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    leg(0, t8611, 'София', 'Септември', sched.dep0, sched.arr0, `БВ ${t8611}`);
    leg(1, t1661, 'Септември', 'Банско', sched.dep1, sched.arr1, `БВ ${t1661}`);
    const rows = () => [armedStore.getLeg(id, 0), armedStore.getLeg(id, 1)];
    rows().forEach(r => { if (r.leg_index === 0) armedStore.markStarted(r.id); });

    if (withTokenOnLeg0) {
        laStore.upsert({
            token, environment: 'sandbox', journey_id: id, train_number: t8611, train_number_display: `БВ ${t8611}`,
            boarding_station: 'София', destination_station: 'Септември', direction_station: 'Септември',
            scheduled_departure: iso(sched.dep0), scheduled_arrival: iso(sched.arr0),
            current_leg_index: 0, is_current_bus: 0,
            next_transport_number: `БВ ${t1661}`, next_transport_departure: iso(sched.dep1), is_next_transport_bus: 0,
        });
    }
    cache.setTrips(trips, Date.now());
    cache.setVehicles(new Map(), Date.now());
    return { id, token, t8611, t1661, sched, trips, rows };
}

function mockApns(outcome = 'ok') {
    const calls = [];
    const original = apns.send, sendAll = apns.sendAll, configured = apns.isConfigured;
    apns.send = async (a) => { calls.push(a); return { outcome, status: outcome === 'ok' ? 200 : 500 }; };
    apns.sendAll = async (tasks) => Promise.all(tasks.map(t => t()));
    apns.isConfigured = () => true;
    return { calls, restore() { apns.send = original; apns.sendAll = sendAll; apns.isConfigured = configured; },
             to(token) { return calls.filter(c => c.token === token).map(c => JSON.parse(c.body).aps); } };
}

const stateOf = (aps) => aps['content-state'];
const unix = (swift) => contentState.fromSwiftDate(swift);

/** Let the push throttle (one per token per minute) pass without waiting. */
function ageLastPush(token) {
    const db = new Database(TMP);
    db.prepare('UPDATE live_activity_tokens SET last_pushed_at = ? WHERE token = ?')
        .run(new Date(Date.now() - 5 * 60000).toISOString(), token);
    db.close();
}

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } });

function register(j, legIndex, over = {}) {
    const leg = legIndex === 0
        ? { trainNumber: j.t8611, boardingStation: 'София', destinationStation: 'Септември', dep: j.sched.dep0, arr: j.sched.arr0 }
        : { trainNumber: j.t1661, boardingStation: 'Септември', destinationStation: 'Банско', dep: j.sched.dep1, arr: j.sched.arr1 };
    const r = res();
    liveController.register({ body: {
        token: j.token, environment: 'sandbox', journeyId: j.id, trainNumber: leg.trainNumber,
        boardingStation: leg.boardingStation, destinationStation: leg.destinationStation,
        directionStation: leg.destinationStation, scheduledDeparture: iso(leg.dep), scheduledArrival: iso(leg.arr),
        currentLegIndex: legIndex, ...over,
    } }, r);
    return r;
}

// ── 1. the card between the trains ───────────────────────────────────────────

test('the app reports the arrival: the card moves to the second train AS THE TRANSFER', async () => {
    const j = journey({ arrDelay0: 5, depDelay1: 2 });
    armedStore.markArrived(INSTALL, j.id, 0);                     // /leg-arrived
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }

    const pushes = mock.to(j.token);
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].event, 'update');
    const s = stateOf(pushes[0]);
    assert.strictEqual(s.phase, 'transferWindow');
    assert.strictEqual(s.transferStation, 'Септември');
    assert.strictEqual(s.nextTransportNumber, `БВ ${j.t1661}`, 'the train being waited for — this row’s, not the one after it');
    assert.strictEqual(s.nextTransportDirection, 'Банско');
    assert.strictEqual(unix(s.nextTransportDeparture), j.sched.dep1);
    assert.strictEqual(unix(s.nextTransportPredictedDeparture), j.sched.dep1 + 2 * MIN);
    assert.strictEqual(s.nextTransportDelayMinutes, 2, 'the delay of the DEPARTURE being waited for');
    assert.strictEqual(unix(s.transferArrival), j.sched.arr0 + 5 * MIN, 'when the train they got off reaches the change station');
    assert.strictEqual(s.progressPercentage, 1);
    assert.strictEqual(s.currentLegIndex, 0, 'the app’s convention: the leg just completed');
    assert.strictEqual(s.isNextTransportBus, false);
    assert.strictEqual(s.isCurrentTransportBus, false, 'standing on a platform is not being on the vehicle just left');
    assert.strictEqual(s.delayMinutes, undefined, 'the first train’s delay is not the card’s business any more');
    assert.strictEqual(s.isDelayed, false);
    // still the required keys, every push
    for (const k of ['progressPercentage', 'isDelayed', 'lastUpdated', 'phase', 'directionStation', 'currentLegIndex',
                     'isNextTransportBus', 'isCurrentTransportBus']) assert.ok(k in s, `${k} present`);

    const row = laStore.getByToken(j.token);
    assert.strictEqual(row.current_leg_index, 1);
    assert.strictEqual(row.last_phase, 'transferWindow');
});

test('when the second train leaves, the card becomes in-transit for it', async () => {
    const j = journey({ depDelay1: 2 });
    armedStore.markArrived(INSTALL, j.id, 0);
    let mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }

    // the feed now says it has gone
    const gone = new Map(j.trips);
    gone.set(j.t1661, [run(`${j.t1661}-A`, [
        [SEPTEMBRI, 'Септември', null, null, T0 - 1 * MIN, 2 * MIN],
        [BANSKO, 'Банско', j.sched.arr1 + 2 * MIN, 2 * MIN, null, null],
    ])]);
    cache.setTrips(gone, Date.now());
    ageLastPush(j.token);

    mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }
    const pushes = mock.to(j.token);
    assert.strictEqual(pushes.length, 1);
    const s = stateOf(pushes[0]);
    assert.strictEqual(s.phase, 'inTransit');
    assert.strictEqual(s.currentLegIndex, 1);
    assert.strictEqual(s.nextTransportPredictedDeparture, undefined, 'transfer fields are for the transfer only');
    assert.strictEqual(s.transferStation, undefined);
    assert.strictEqual(s.delayMinutes, 2);
});

test('no reading for the departure: the delay is ABSENT, never 0', async () => {
    const j = journey();
    // a feed run for the second train with times but no delay field at all
    const t = new Map(j.trips);
    t.set(j.t1661, [run(`${j.t1661}-A`, [
        [SEPTEMBRI, 'Септември', null, null, j.sched.dep1, null],
        [BANSKO, 'Банско', j.sched.arr1, null, null, null],
    ])]);
    cache.setTrips(t, Date.now());
    armedStore.markArrived(INSTALL, j.id, 0);
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    const s = stateOf(mock.to(j.token)[0]);
    assert.strictEqual(s.phase, 'transferWindow');
    assert.strictEqual(s.nextTransportDelayMinutes, undefined);
    assert.ok(s.nextTransportDeparture != null, 'but the timetable departure is there');
});

test('a connection that does not work out: the arrival is after the predicted departure', async () => {
    const j = journey({ arrDelay0: 20, depDelay1: 2 });              // arrives 17 min after, leaves in 10+2
    armedStore.markArrived(INSTALL, j.id, 0);
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    const s = stateOf(mock.to(j.token)[0]);
    assert.ok(unix(s.transferArrival) > unix(s.nextTransportPredictedDeparture), 'the app can show "no time to change"');
});

test('no feed for the first train any more: its timetable arrival stands in', () => {
    const j = journey();
    armedStore.markArrived(INSTALL, j.id, 0);
    cache.setTrips(new Map(), Date.now());
    const t = transfer.forRow(laStore.getByToken(j.token) && { journey_id: j.id, current_leg_index: 1 });
    assert.strictEqual(t.arrivalUnix, j.sched.arr0);
});

test('the first leg, and a second leg whose first is still under way, are not transfers', () => {
    const j = journey();
    assert.strictEqual(transfer.forRow({ journey_id: j.id, current_leg_index: 0 }), null);
    assert.strictEqual(transfer.forRow({ journey_id: j.id, current_leg_index: 1 }), null, 'leg 0 is still going');
    assert.strictEqual(transfer.forRow({ journey_id: 'unknown', current_leg_index: 1 }), null, 'not armed: no transfer to describe');
});

// ── 2. registration never goes back ──────────────────────────────────────────

test('THE INCIDENT: a cold start registers the first train again — the card stays on the second', async () => {
    const j = journey({ depDelay1: 2 });
    armedStore.markArrived(INSTALL, j.id, 0);
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(laStore.getByToken(j.token).current_leg_index, 1);

    const r = register(j, 0);                                        // 08:50 cold start: the leg that ARRIVED
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ignored, 'older-leg');
    assert.strictEqual(r.body.currentLegIndex, 1);
    const row = laStore.getByToken(j.token);
    assert.strictEqual(row.current_leg_index, 1);
    assert.strictEqual(row.train_number, j.t1661, 'still the second train');
    assert.strictEqual(row.last_phase, 'transferWindow', 'and its bookkeeping was not reset');
});

test('registering the leg the card is on, or a later one, still works; another journey on the same token too', () => {
    const j = journey({ withTokenOnLeg0: false });
    assert.strictEqual(register(j, 0).body.ignored, undefined, 'a new token');
    assert.strictEqual(register(j, 1).body.ignored, undefined, 'forward');
    assert.strictEqual(laStore.getByToken(j.token).train_number, j.t1661);
    assert.strictEqual(register(j, 1).body.ignored, undefined, 'the same leg again (token rotation)');
    // the token now belongs to another journey, whose leg 0 is legitimate
    const other = journey({ withTokenOnLeg0: false });
    other.token = j.token;
    const r = register(other, 0);
    assert.strictEqual(r.body.ignored, undefined);
    assert.strictEqual(laStore.getByToken(j.token).journey_id, other.id);
});

test('re-arming a leg that has ARRIVED does not bring it back; a new departure does', () => {
    const j = journey();
    armedStore.markArrived(INSTALL, j.id, 0);
    const leg0 = armedStore.getLeg(j.id, 0);
    const again = (dep) => armedStore.arm({
        install_id: INSTALL, journey_id: j.id, leg_index: 0, train_number: leg0.train_number,
        boarding_station: leg0.boarding_station, destination_station: leg0.destination_station,
        scheduled_departure: dep, scheduled_arrival: leg0.scheduled_arrival, now: armedStore.nowIso(),
    });
    again(leg0.scheduled_departure);
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'arrived', 'the app re-arms on every start; a finished leg stays finished');
    again(iso(Date.parse(leg0.scheduled_departure) / 1000 + 7 * 86400));
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'armed', 'the same saved journey travelled next week starts over');
});

test('re-arming a leg whose card is already started changes nothing, so it is not started twice', async () => {
    const j = journey();
    const leg0 = armedStore.getLeg(j.id, 0);                          // journey() marked it started
    armedStore.markStarted(leg0.id);
    const db = new Database(TMP);
    db.prepare('UPDATE armed_journeys SET alerts_sent = 2, last_delay_min = 7 WHERE id = ?').run(leg0.id);
    db.close();
    const before = armedStore.getLeg(j.id, 0);
    const again = (over = {}) => armedStore.arm({
        install_id: INSTALL, journey_id: j.id, leg_index: 0, train_number: leg0.train_number,
        train_number_display: leg0.train_number_display, boarding_station: leg0.boarding_station,
        destination_station: leg0.destination_station, scheduled_departure: leg0.scheduled_departure,
        scheduled_arrival: leg0.scheduled_arrival, now: armedStore.nowIso(), ...over,
    });
    again();
    const after = armedStore.getLeg(j.id, 0);
    assert.strictEqual(after.state, 'started');
    assert.strictEqual(after.started_at, before.started_at);
    assert.strictEqual(after.alerts_sent, 2, 'what was already alerted is not forgotten');
    assert.strictEqual(after.last_delay_min, 7);

    again({ train_number: '9999' });
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'armed', 'another train is another trip');
    armedStore.markStarted(leg0.id);
    armedStore.disarm(INSTALL, j.id, 0);
    again({ train_number: '9999' });
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'armed', 'and a leg stopped in between starts over');
});

// ── 3. not hanging on one callback ───────────────────────────────────────────

test('/leg-arrived never comes: the feed has the first train at Септември — the card moves over anyway', async () => {
    const j = journey({ arrDelay0: 0 });                             // predicted arrival T0-3 min: 5-min grace not yet over
    const t = new Map(j.trips);
    t.set(j.t8611, [run(`${j.t8611}-A`, [
        [SOFIA, 'София', null, null, j.sched.dep0, 0],
        [SEPTEMBRI, 'Септември', T0 - 8 * MIN, 0, null, null],       // arrived 8 min ago
    ])]);
    cache.setTrips(t, Date.now());

    let mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'arrived', 'marked by the feed');
    assert.strictEqual(mock.to(j.token).length, 0, 'the second leg becomes active on the next pass');

    mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    const s = stateOf(mock.to(j.token)[0]);
    assert.strictEqual(s.phase, 'transferWindow');
    assert.strictEqual(laStore.getByToken(j.token).current_leg_index, 1);
});

test('the feed does not say so on the clock alone while the train’s position says it is still short of the station', async () => {
    const j = journey();
    const t = new Map(j.trips);
    t.set(j.t8611, [run(`${j.t8611}-A`, [
        [SOFIA, 'София', null, null, j.sched.dep0, 0],
        [SEPTEMBRI, 'Септември', T0 - 8 * MIN, 0, null, null],
    ])]);
    cache.setTrips(t, Date.now());
    cache.setVehicles(new Map([[j.t8611, { tripId: `${j.t8611}-A`, lat: 42, lon: 23, stopStationId: SOFIA, stopStatus: 'IN_TRANSIT_TO' }]]), Date.now());
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'started', 'still on its way to the station, whatever the prediction');
});

test('a train standing at the station counts as arrived at once, a prediction that is merely due does not', async () => {
    const standing = journey();
    const t = new Map(standing.trips);
    t.set(standing.t8611, [run(`${standing.t8611}-A`, [
        [SOFIA, 'София', null, null, standing.sched.dep0, 0],
        [SEPTEMBRI, 'Септември', T0 + 1 * MIN, 0, null, null],
    ])]);
    cache.setTrips(t, Date.now());
    let mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(standing.id, 0).state, 'started', 'due in a minute: not yet');

    cache.setVehicles(new Map([[standing.t8611, { tripId: `${standing.t8611}-A`, lat: 42, lon: 23, stopStationId: SEPTEMBRI, stopStatus: 'STOPPED_AT' }]]), Date.now());
    mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(standing.id, 0).state, 'arrived');
});

test('a train whose next stop is already beyond the station has been through it, whatever the prediction says', async () => {
    const j = journey();
    const t = new Map(j.trips);
    t.set(j.t8611, [run(`${j.t8611}-A`, [
        [SOFIA, 'София', null, null, j.sched.dep0, 0],
        [SEPTEMBRI, 'Септември', T0 + 1 * MIN, 0, T0 + 2 * MIN, 0],
        [4, 'Пловдив', T0 + 40 * MIN, 0, null, null],
    ])]);
    cache.setTrips(t, Date.now());
    cache.setVehicles(new Map([[j.t8611, { tripId: `${j.t8611}-A`, lat: 42, lon: 23, stopStationId: 4, stopStatus: 'IN_TRANSIT_TO' }]]), Date.now());
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(j.id, 0).state, 'arrived');
});

test('the LAST leg is never ended on the feed’s word', async () => {
    const j = journey();
    const t = new Map(j.trips);
    t.set(j.t1661, [run(`${j.t1661}-A`, [
        [SEPTEMBRI, 'Септември', null, null, T0 - 130 * MIN, 0],
        [BANSKO, 'Банско', T0 - 10 * MIN, 0, null, null],
    ])]);
    cache.setTrips(t, Date.now());
    armedStore.markArrived(INSTALL, j.id, 0);
    armedStore.markStarted(armedStore.getLeg(j.id, 1).id);
    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    assert.strictEqual(armedStore.getLeg(j.id, 1).state, 'started');
});

test('giving up on the first train does not delete the card the second one needs', async () => {
    const j = journey({ feed1: false });
    cache.setTrips(new Map(), Date.now());                           // no feed: the deadline is the timetable's + 45 min
    // make the first leg's deadline long gone
    const db = new Database(TMP);
    db.prepare('UPDATE armed_journeys SET scheduled_departure = ?, scheduled_arrival = ? WHERE journey_id = ? AND leg_index = 0')
        .run(iso(T0 - 4 * 3600), iso(T0 - 3 * 3600), j.id);
    db.close();

    let mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    const leg0 = armedStore.getLeg(j.id, 0);
    assert.strictEqual(leg0.state, 'stopped');
    assert.strictEqual(leg0.stopped_reason, 'arrival-not-confirmed');
    assert.ok(laStore.getByToken(j.token), 'the card is still there');

    mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }
    const s = stateOf(mock.to(j.token)[0]);
    assert.strictEqual(s.phase, 'transferWindow', 'and it moves on to the second train, as the change');
});

test('the worker does not end the card of a journey that still has a train to come', async () => {
    const withNext = journey();
    const db = new Database(TMP);
    db.prepare('UPDATE live_activity_tokens SET scheduled_arrival = ? WHERE token = ?').run(iso(T0 - 30 * MIN), withNext.token);
    db.close();
    const t = new Map(withNext.trips);
    t.set(withNext.t8611, [run(`${withNext.t8611}-A`, [
        [SOFIA, 'София', null, null, withNext.sched.dep0, 0],
        [SEPTEMBRI, 'Септември', T0 - 30 * MIN, 0, null, null],       // arrived half an hour ago: past the 10-minute end rule
    ])]);
    cache.setTrips(t, Date.now());
    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }
    assert.strictEqual(mock.to(withNext.token).filter(a => a.event === 'end').length, 0);
    assert.ok(laStore.getByToken(withNext.token), 'token kept');
});

test('a single-leg journey is still ended after its arrival', async () => {
    n++;
    const token = hexToken('e'), id = `j-single-${n}`, train = String(7000 + n);
    laStore.upsert({
        token, environment: 'sandbox', journey_id: id, train_number: train, boarding_station: 'София',
        destination_station: 'Септември', direction_station: 'Септември',
        scheduled_departure: iso(T0 - 90 * MIN), scheduled_arrival: iso(T0 - 30 * MIN),
        current_leg_index: 0, is_current_bus: 0, next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
    cache.setTrips(new Map([[train, [run(`${train}-A`, [
        [SOFIA, 'София', null, null, T0 - 90 * MIN, 0], [SEPTEMBRI, 'Септември', T0 - 30 * MIN, 0, null, null],
    ])]]]), Date.now());
    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }
    assert.strictEqual(mock.to(token).filter(a => a.event === 'end').length, 1);
});

// ── 4. the first leg is never a transfer ─────────────────────────────────────

test('build(): a first-leg row, or no transfer given, is exactly what it was', () => {
    const row = {
        journey_id: 'x', train_number: '1', train_number_display: 'БВ 1', boarding_station: 'София',
        destination_station: 'Септември', direction_station: 'Септември', current_leg_index: 0,
        scheduled_departure: iso(T0 + 600), scheduled_arrival: iso(T0 + 3600), is_current_bus: 0,
        is_next_transport_bus: 0, next_transport_number: 'БВ 2', next_transport_departure: iso(T0 + 5000),
    };
    const { state } = contentState.build(row, null, new Date(), null, null, { arrivalUnix: T0 });
    assert.strictEqual(state.phase, 'preDeparture', 'a first leg cannot be a transfer');
    assert.strictEqual(state.nextTransportNumber, 'БВ 2');
    assert.strictEqual(state.transferStation, undefined);
});
