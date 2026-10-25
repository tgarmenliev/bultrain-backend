'use strict';

/**
 * Real incident, 2026-10-25 (the day the clocks went back). The realtime feed still carried fifteen
 * runs from the 24th at 11:00 — among them train 30122, "departs 11:09" on the 24th. A passenger saved
 * the 11:09 train that morning; the server took the feed's run for that NUMBER, whose departure was a
 * day in the past: the card started at once, said the train had already left, and counted down to
 * yesterday's arrival (12:11 on a phone in winter time).
 *
 * A run belongs to a journey only if the instant the feed says its boarding stop was scheduled for
 * is the one the passenger registered; and a run that ended hours ago is not live data.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-stale-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const cache      = require('../services/realtime/cache');
const { matchRun } = require('../services/liveactivity/runMatch');
const contentState = require('../services/liveactivity/contentState');
const store      = require('../services/liveactivity/store');
const worker     = require('../services/liveactivity/worker');
const apns       = require('../services/liveactivity/apns');
const controller = require('../controllers/realtimeController');

const MIN = 60, H = 3600, DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

/** A run of train 30122: boarding stop Антон `depSec`, София `arrSec`, both on schedule. */
const run = (tripId, depSec, arrSec, over = {}) => ({
    tripId,
    stops: [
        { stationId: 1, station: 'Антон', arrivalTime: null, arrivalDelay: null,
          departureTime: depSec, departureDelay: 0, skipped: false, ...(over.board || {}) },
        { stationId: 2, station: 'София', arrivalTime: arrSec, arrivalDelay: 0,
          departureTime: null, departureDelay: null, skipped: false },
    ],
});

// The journey: leaves 55 minutes from now (saved at 10:14 for 11:09), arrives 2 hours later.
const DEP = nowSec() + 55 * MIN;
const ARR = DEP + 122 * MIN;
const row = (over = {}) => ({
    token: 'a'.repeat(100), environment: 'sandbox', journey_id: 'j-30122', train_number: '30122',
    train_number_display: 'ПВ 30122', boarding_station: 'Антон', destination_station: 'София',
    direction_station: 'София', scheduled_departure: new Date(DEP * 1000).toISOString(),
    scheduled_arrival: new Date(ARR * 1000).toISOString(),
    current_leg_index: 0, is_current_bus: 0, next_transport_number: null,
    next_transport_departure: null, is_next_transport_bus: 0, app_language: null, ...over,
});

const yesterdaysRun = () => run('30122-PV-20261024', DEP - DAY, ARR - DAY);   // 11:09 YESTERDAY, all passed
const todaysRun     = (delaySec = 0) => run('30122-PV-20261025', DEP + delaySec, ARR + delaySec, {
    board: { departureDelay: delaySec },
});

// ── a run that ended hours ago is not live ───────────────────────────────────

test('a run that ended more than 3 hours ago is not live data; one still on the road, or just finished, is', () => {
    const ended = (hoursAgo) => run('x', nowSec() - hoursAgo * H - 2 * H, nowSec() - hoursAgo * H);
    assert.strictEqual(cache.isDeadRun(ended(4)), true);
    assert.strictEqual(cache.isDeadRun(ended(2)), false, 'finished two hours ago: still the current picture of that train');
    assert.strictEqual(cache.isDeadRun(run('x', nowSec() - H, nowSec() + H)), false, 'under way');
    assert.strictEqual(cache.isDeadRun({ tripId: 'x', stops: [] }), false, 'no times: cannot tell, so not dead');
});

test('the cache does not hand out yesterday’s run: /train says "no live data", not a finished run', () => {
    cache.setTrips(new Map([['30122', [yesterdaysRun()]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());
    assert.strictEqual(cache.getTrain('30122'), null);
    assert.deepStrictEqual(cache.getTrips('30122'), []);

    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    controller.getTrain({ params: { trainNo: '30122' } }, res);
    assert.strictEqual(res.code, 404);
    assert.strictEqual(res.body.realtimeAvailable, true, 'the feed is up; this train simply has no run now');
});

test('when yesterday’s and today’s run are both there, today’s is the one served', () => {
    cache.setTrips(new Map([['30122', [yesterdaysRun(), todaysRun()]]]), Date.now());
    assert.strictEqual(cache.getTrain('30122').tripId, '30122-PV-20261025');
});

// ── which run is this journey's ──────────────────────────────────────────────

test('matchRun: the run whose scheduled boarding instant is the registered one — never another day’s', () => {
    assert.strictEqual(matchRun([yesterdaysRun(), todaysRun()], row()).tripId, '30122-PV-20261025');
    assert.strictEqual(matchRun([todaysRun()], row()).tripId, '30122-PV-20261025');
    // a late train is still the SAME run: the feed's time minus its delay is the schedule
    assert.strictEqual(matchRun([todaysRun(45 * MIN)], row()).tripId, '30122-PV-20261025');
});

test('matchRun: a run that is still “live” but is another day’s or another hour’s is rejected', () => {
    // yesterday's run that finished 2 hours ago (not dead yet) — scheduled a day before
    const lately = run('30122-PV-20261024', nowSec() - 4 * H, nowSec() - 2 * H);
    assert.strictEqual(matchRun([lately], row()), null);
    // the feed an hour off (a time-zone defect on its side) is not accepted as this journey either
    assert.strictEqual(matchRun([run('x', DEP - H, ARR - H)], row()), null);
});

test('matchRun: with no delay on the boarding stop it still refuses the wrong DAY', () => {
    const noDelay = (offset) => run('x', DEP + offset, ARR + offset, { board: { departureDelay: null } });
    assert.ok(matchRun([noDelay(0)], row()));
    assert.strictEqual(matchRun([noDelay(-DAY)], row()), null);
});

test('matchRun: a run it cannot check (boarding stop not in the feed) is used as before', () => {
    const odd = { tripId: 'x', stops: [{ stationId: 9, station: 'Другаде', arrivalTime: DEP, arrivalDelay: 0, departureTime: DEP, departureDelay: 0 }] };
    assert.strictEqual(matchRun([odd], row()), odd);
    assert.strictEqual(matchRun([], row()), null);
});

// ── the whole incident, through the card ─────────────────────────────────────

function mockApns() {
    const calls = [];
    const originals = { send: apns.send, sendAll: apns.sendAll, isConfigured: apns.isConfigured };
    apns.send = async (a) => { calls.push(a); return { outcome: 'ok', status: 200, reason: null }; };
    apns.sendAll = async (tasks) => Promise.all(tasks.map(t => t()));
    apns.isConfigured = () => true;
    return { calls, restore() { Object.assign(apns, originals); } };
}

test('THE INCIDENT: only yesterday’s run in the feed — the card says "not yet", with the schedule, not the past', () => {
    const rt = matchRun(cache.getTrips('30122'), row());           // what the worker now asks for
    cache.setTrips(new Map([['30122', [yesterdaysRun()]]]), Date.now());
    const mine = matchRun(cache.getTrips('30122'), row());
    assert.strictEqual(mine, null, 'yesterday’s run is not used');

    const { state, meta } = contentState.build(row(), mine, new Date(), null, null);
    assert.strictEqual(state.phase, 'preDeparture', 'the train leaves in 55 minutes — not "already under way"');
    assert.strictEqual(state.predictedArrival, undefined, 'and no arrival time borrowed from yesterday');
    assert.strictEqual(meta.hasFeed, false);
    assert.ok(rt === null || rt, 'sanity');

    // the schedule counts down to the right instants
    assert.strictEqual(contentState.fromSwiftDate(state.legScheduledDeparture), DEP);
    assert.strictEqual(contentState.fromSwiftDate(state.legScheduledArrival), ARR);
});

test('THE INCIDENT, through the worker: the registered card is updated as pre-departure, with no yesterday in it', async () => {
    cache.setTrips(new Map([['30122', [yesterdaysRun()]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());
    store.upsert(row({ token: 'b'.repeat(100) }));
    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }
    assert.strictEqual(mock.calls.length, 1);
    const aps = JSON.parse(mock.calls[0].body).aps;
    assert.strictEqual(aps['content-state'].phase, 'preDeparture');
    assert.strictEqual(aps['content-state'].predictedDeparture, undefined);
    assert.strictEqual(aps['content-state'].predictedArrival, undefined);
});

test('and when today’s run IS in the feed it is used, with its real delay', async () => {
    cache.setTrips(new Map([['30122', [yesterdaysRun(), todaysRun(12 * MIN)]]]), Date.now());
    const { state } = contentState.build(row(), matchRun(cache.getTrips('30122'), row()), new Date(), null, null);
    assert.strictEqual(state.phase, 'preDeparture');
    assert.strictEqual(state.delayMinutes, 12);
    assert.strictEqual(contentState.fromSwiftDate(state.predictedDeparture), DEP + 12 * MIN);
});
