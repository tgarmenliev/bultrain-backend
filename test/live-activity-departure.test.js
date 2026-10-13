'use strict';

/**
 * "When does my train leave?" — the real case of 2026-10-13: БВ 1611 reaches Sofia at 08:11
 * (+5), STANDS for 11 minutes and leaves at 08:22 on time (the dwell swallowed the delay),
 * then runs +3. The card must say what the passenger needs at each moment:
 *
 *   - until the train has LEFT the boarding stop: that stop's DEPARTURE time and delay —
 *     through the whole dwell, not the delay of the next stop, and not "under way" at the
 *     scheduled minute while a late train is still on the platform
 *   - after: under way, with the train's current delay
 *
 * The fixture is the real /api/realtime/train/1611 answer recorded at 08:33.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-departure-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const cache        = require('../services/realtime/cache');
const contentState = require('../services/liveactivity/contentState');
const worker       = require('../services/liveactivity/worker');
const watcher      = require('../services/liveactivity/armedWatcher');
const logic        = require('../services/liveactivity/armedLogic');
const controller   = require('../controllers/realtimeController');

const fixture = require('./fixtures/realtime-train-1611-2026-10-13.json');

// ── helpers ──────────────────────────────────────────────────────────────────

const unix = (hhmm, ss = 0) => Date.parse(`2026-10-13T${hhmm}:${String(ss).padStart(2, '0')}+03:00`) / 1000;
const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' });
const TRIP = '1611-BV-20261013';

/** The recorded answer, turned back into the shape the realtime cache holds. */
function rtFromFixture(patch = {}) {
    const stops = fixture.stops.map(s => ({
        stationId: s.stationId, station: s.station,
        arrivalTime:    s.predictedArrival   ? unix(s.predictedArrival)   : null,
        arrivalDelay:   s.arrivalDelayMin   == null ? null : s.arrivalDelayMin * 60,
        departureTime:  s.predictedDeparture ? unix(s.predictedDeparture) : null,
        departureDelay: s.departureDelayMin == null ? null : s.departureDelayMin * 60,
        skipped: false,
    }));
    for (const [station, fields] of Object.entries(patch)) {
        Object.assign(stops.find(s => s.station === station), fields);
    }
    return { tripId: TRIP, stops };
}

const row = (over = {}) => ({
    token: 'a'.repeat(64), train_number: '1611',
    boarding_station: 'София', destination_station: 'Казичене', direction_station: 'Свиленград',
    scheduled_departure: new Date(unix('08:22') * 1000).toISOString(),
    scheduled_arrival:   new Date(unix('08:50') * 1000).toISOString(),
    current_leg_index: 0, is_current_bus: 0, is_next_transport_bus: 0, app_language: null,
    ...over,
});

const SOFIA = 2, PODUYANE = 35, ISKARSKO = 696;
const veh = (stopStationId, stopStatus, over = {}) => ({
    tripId: TRIP, lat: 42.7, lon: 23.3, bearing: 0, positionTimestamp: Date.now(),
    stopStatus, stopStationId, ...over,
});

/** The card at a moment: what the passenger would see. */
function card(at, { rt = rtFromFixture(), vehicle = null, tokenRow = row() } = {}) {
    const { state, meta } = contentState.build(tokenRow, rt, new Date(at * 1000), vehicle, null);
    return {
        phase: state.phase,
        delay: state.delayMinutes ?? null,
        dep: state.predictedDeparture == null ? null : hhmm(contentState.fromSwiftDate(state.predictedDeparture)),
        arr: state.predictedArrival == null ? null : hhmm(contentState.fromSwiftDate(state.predictedArrival)),
        meta,
    };
}

// ── the recorded case ────────────────────────────────────────────────────────

test('before the train arrives: the card is about the DEPARTURE at 08:22, on time', () => {
    const c = card(unix('08:14'));
    assert.deepStrictEqual([c.phase, c.delay, c.dep, c.arr], ['preDeparture', 0, '08:22', '08:53']);

    // heading to Sofia (the feed's current stop is Sofia): still before
    const d = card(unix('08:14'), { vehicle: veh(SOFIA, 'IN_TRANSIT_TO') });
    assert.strictEqual(d.phase, 'preDeparture');
});

test('while the train STANDS in Sofia (08:16 → 08:22) it is still pre-departure, delay of the DEPARTURE', () => {
    for (const [t, vehicle] of [['08:16', veh(SOFIA, 'STOPPED_AT')], ['08:20', veh(SOFIA, 'STOPPED_AT')], ['08:20', null]]) {
        const c = card(unix(t, 30), { vehicle });
        assert.deepStrictEqual([c.phase, c.delay, c.dep], ['preDeparture', 0, '08:22'], `${t} ${vehicle ? 'with position' : 'no position'}`);
    }
});

test('once it has left it is under way, with the train’s current delay', () => {
    const left = card(unix('08:22', 30), { vehicle: veh(PODUYANE, 'IN_TRANSIT_TO') });
    assert.strictEqual(left.phase, 'inTransit');
    // right after Sofia the next stop is Подуяне, which the feed predicts ON TIME (arrival delay 0):
    // that, not a figure borrowed from later stops, is the train's current delay.
    assert.strictEqual(left.delay, 0);
    assert.strictEqual(left.dep, '08:22');

    const later = card(unix('08:40'), { vehicle: veh(ISKARSKO, 'IN_TRANSIT_TO') });
    assert.deepStrictEqual([later.phase, later.delay, later.arr], ['inTransit', 3, '08:53']);

    // without a position the predicted departure alone says it has gone
    assert.strictEqual(card(unix('08:22', 30)).phase, 'inTransit');
});

// ── the position beats the clock ─────────────────────────────────────────────

test('a late train still on the platform is NOT under way after its predicted departure', () => {
    const c = card(unix('08:25'), { vehicle: veh(SOFIA, 'STOPPED_AT') });
    assert.strictEqual(c.phase, 'preDeparture');
    assert.strictEqual(c.delay, 0, 'the departure delay the feed has — nothing is made up');
});

test('and one that has already gone is under way before its predicted departure', () => {
    const c = card(unix('08:20'), { vehicle: veh(PODUYANE, 'IN_TRANSIT_TO') });
    assert.strictEqual(c.phase, 'inTransit');
});

test('a position of ANOTHER run of the same number (yesterday’s overnight one) is ignored', () => {
    const c = card(unix('08:20'), { vehicle: veh(PODUYANE, 'IN_TRANSIT_TO', { tripId: '1611-BV-20261012' }) });
    assert.strictEqual(c.phase, 'preDeparture', 'the clock decides, not a stranger’s position');
});

test('a position at a stop we cannot place falls back to the clock', () => {
    assert.strictEqual(card(unix('08:20'), { vehicle: veh(null, 'IN_TRANSIT_TO') }).phase, 'preDeparture');
    assert.strictEqual(card(unix('08:20'), { vehicle: veh(99999, 'IN_TRANSIT_TO') }).phase, 'preDeparture');
});

// ── the other cases of the brief ─────────────────────────────────────────────

test('a train leaving +20 is +20 until it leaves, however much the later stops have caught up', () => {
    // leaves Sofia at 08:42, 20 min late; the stops after it are only +3
    const rt = rtFromFixture({ 'София': { departureTime: unix('08:42'), departureDelay: 20 * 60 } });
    for (const t of ['08:24', '08:30', '08:41']) {
        const c = card(unix(t), { rt });
        assert.deepStrictEqual([c.phase, c.delay, c.dep], ['preDeparture', 20, '08:42'], t);
    }
    assert.strictEqual(card(unix('08:43'), { rt }).phase, 'inTransit');
    // standing on the platform past 08:42 with the feed not yet updated: the position holds it
    assert.strictEqual(card(unix('08:45'), { rt, vehicle: veh(SOFIA, 'STOPPED_AT') }).phase, 'preDeparture');
});

test('boarding at the FIRST stop (no arrival time): the departure delay applies until it leaves', () => {
    const rt = rtFromFixture({ 'Перник': { departureTime: unix('07:17'), departureDelay: 120 } });
    const first = row({ boarding_station: 'Перник', scheduled_departure: new Date(unix('07:15') * 1000).toISOString() });
    const before = card(unix('07:10'), { rt, tokenRow: first });
    assert.deepStrictEqual([before.phase, before.delay, before.dep], ['preDeparture', 2, '07:17']);
    assert.strictEqual(card(unix('07:16'), { rt, tokenRow: first }).phase, 'preDeparture', 'scheduled 07:15 has passed, the train has not left');
    assert.strictEqual(card(unix('07:18'), { rt, tokenRow: first }).phase, 'inTransit');
});

test('no TripUpdate at all: the schedule decides, as before', () => {
    const noFeed = (t) => contentState.build(row(), null, new Date(unix(t) * 1000), null, null).state.phase;
    assert.strictEqual(noFeed('08:21'), 'preDeparture');
    assert.strictEqual(noFeed('08:23'), 'inTransit');
});

// ── the notifications read the same truth ────────────────────────────────────

test('the delay alert pipeline sees the same delay and the same phase as the card', () => {
    const rt = rtFromFixture({ 'София': { departureTime: unix('08:42'), departureDelay: 20 * 60 } });
    for (const [t, vehicle] of [['08:16', null], ['08:30', veh(SOFIA, 'STOPPED_AT')], ['08:50', veh(PODUYANE, 'IN_TRANSIT_TO')]]) {
        const now = unix(t);
        const c = card(now, { rt, vehicle });
        const feed = watcher.readFeed(row(), rt, now, vehicle);
        assert.strictEqual(feed.delayMin, c.delay, `${t} delay`);
        assert.strictEqual(logic.legPhase(row(), feed.predictedDepUnix, new Date(now * 1000), feed.departed), c.phase, `${t} phase`);
    }
});

test('legPhase keeps its old answer when it is not told whether the train has left', () => {
    const r = row();
    assert.strictEqual(logic.legPhase(r, null, new Date(unix('08:10') * 1000)), 'preDeparture');
    assert.strictEqual(logic.legPhase(r, null, new Date(unix('08:30') * 1000)), 'inTransit');
    assert.strictEqual(logic.legPhase(r, unix('08:42'), new Date(unix('08:30') * 1000)), 'preDeparture');
    assert.strictEqual(logic.legPhase(r, unix('08:42'), new Date(unix('08:30') * 1000), true), 'inTransit', 'the position wins');
});

// ── the departure timer follows the prediction ───────────────────────────────

test('the “departure” timer is set for the PREDICTED departure, not the scheduled minute', () => {
    cache.setTrips(new Map([['1611', [rtFromFixture({ 'София': { departureTime: unix('08:42'), departureDelay: 20 * 60 } })]]]), Date.now());
    assert.strictEqual(worker.departureMomentMs(row()), unix('08:42') * 1000);

    cache.setTrips(new Map(), Date.now());
    assert.strictEqual(worker.departureMomentMs(row()), unix('08:22') * 1000, 'no feed: the schedule');
});

// ── a card nobody writes to must not go stale ────────────────────────────────

test('unchanged content is still refreshed every 10 minutes (the card dims after 15)', () => {
    const base = card(unix('08:14')).meta;
    const fresh = (minutesAgo) => ({
        last_pushed_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
        last_phase: base.phase, last_delay_min: base.delayMinutes, last_next_stop: base.nextStop, last_progress: base.progress,
    });
    assert.strictEqual(worker.hasChanged(fresh(5), base).changed, false, '5 minutes: nothing to say');
    assert.strictEqual(worker.hasChanged(fresh(9.5), base).changed, false);
    const hb = worker.hasChanged(fresh(10.5), base);
    assert.deepStrictEqual([hb.changed, hb.reason, hb.priority], [true, 'heartbeat', 5], 'priority 5: not metered');
    assert.strictEqual(worker.HEARTBEAT_MS, 10 * 60 * 1000);
});

// ── /train: a stop is passed when the train has LEFT it ──────────────────────

test('/train: a stop the train is standing at is not "passed"; previousStationId follows', () => {
    const ask = (t) => controller._buildTrainStatus({ num: '1611', rt: rtFromFixture(), v: null, geo: null, now: new Date(unix(t) * 1000) }).body;
    const flag = (b, name) => b.stops.find(s => s.station === name).passed;

    const standing = ask('08:18');                      // arrived 08:16, leaves 08:22
    assert.strictEqual(flag(standing, 'София'), false, 'still in Sofia');
    assert.strictEqual(flag(standing, 'Захарна Фабрика'), true);
    assert.strictEqual(standing.previousStationId, 21, 'the last stop it has LEFT');

    const gone = ask('08:23');
    assert.strictEqual(flag(gone, 'София'), true);
    assert.strictEqual(gone.previousStationId, SOFIA);

    // the origin has only a departure and the terminus only an arrival: neither is ever stuck
    assert.strictEqual(flag(ask('07:00'), 'Перник'), false);
    assert.strictEqual(flag(ask('07:16'), 'Перник'), true);
    assert.strictEqual(flag(ask('13:30'), 'Свиленград'), true);
});
