'use strict';

/**
 * The connection between two legs. A delay on the ARRIVING train can make a transfer impossible without
 * the connecting train being late at all — and neither delay alert said so: the arriving train's alert is
 * about its own delay, the connecting train's about that train. So the transfer has its own alert
 * ("tight", "you will probably miss it", "it holds again"), measured on the arriving side and honest about
 * what is known of the connecting one. Only connection alerts interrupt Focus/DND.
 *
 * Pure rules first, then the whole thing through the real watcher tick (the 2026-10-30 Септември → Банско
 * transfer is the model).
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-connrisk-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database     = require('better-sqlite3');
const logic        = require('../services/liveactivity/armedLogic');
const armedStore   = require('../services/liveactivity/armedStore');
const apns         = require('../services/liveactivity/apns');
const fcm          = require('../services/liveactivity/fcm');
const testFeed     = require('../services/liveactivity/testFeed');
const armedWatcher = require('../services/liveactivity/armedWatcher');

const MIN = 60 * 1000;

// ── The rules ────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-30T08:30:00.000Z');
const U = (ms) => Math.floor(ms / 1000);

/** Arriving train due at +arr min, connecting one leaving at +dep min; scheduled 10 / 25 unless given. */
function ctx(arrMin, depMin, sched = { arr: 10, dep: 25 }) {
    return {
        arrivalUnix: arrMin == null ? null : U(NOW + arrMin * MIN),
        departUnix: depMin == null ? null : U(NOW + depMin * MIN),
        schedArrivalUnix: U(NOW + sched.arr * MIN),
        schedDepartUnix: U(NOW + sched.dep * MIN),
    };
}
const evalAt = (row, c) => logic.evaluateConnectionRisk(row, c, new Date(NOW));

test('no live arrival for the arriving train: nothing to say, never a guess', () => {
    assert.strictEqual(evalAt({}, ctx(null, 25)).reason, 'no-coverage');
});

test('a transfer that was comfortable and now is not: told, once, by how bad', () => {
    // scheduled gap 15 (fine); the arriving train is 9 min late → 6 min left: tight
    let r = evalAt({}, ctx(19, 25));
    assert.deepStrictEqual([r.shouldAlert, r.kind, r.band, r.gap], [true, 'tight', 'tight', 6]);

    // …20 min late → arrives after the other has left
    r = evalAt({}, ctx(30, 25));
    assert.deepStrictEqual([r.shouldAlert, r.kind, r.band], [true, 'missed', 'departsBeforeArrival']);
    assert.strictEqual(r.gap, -5);

    // exactly zero is the at-risk side, not tight (the client's own boundary)
    assert.strictEqual(evalAt({}, ctx(25, 25)).kind, 'missed');
});

test('not repeated while it stays the same, told again when it gets worse', () => {
    const told = { conn_band: 'tight', conn_alerts_sent: 1, conn_alert_at: new Date(NOW - 10 * MIN).toISOString() };
    assert.strictEqual(evalAt(told, ctx(19, 25)).shouldAlert, false, 'still tight');
    assert.strictEqual(evalAt(told, ctx(30, 25)).kind, 'missed', 'tight → missed');
});

test('a transfer that is tight on the TIMETABLE is not news until it gets worse', () => {
    const planned = { arr: 10, dep: 16 };   // six minutes, as the passenger chose it
    assert.strictEqual(evalAt({}, ctx(10, 16, planned)).shouldAlert, false, 'on time: nothing to say');
    assert.strictEqual(evalAt({}, ctx(12, 16, planned)).shouldAlert, false, 'still tight, as planned');
    assert.strictEqual(evalAt({}, ctx(17, 16, planned)).kind, 'missed', 'but now it is gone');
});

test('it recovers: told once, with room to spare so a hovering gap does not flap', () => {
    const missed = { conn_band: 'departsBeforeArrival', conn_alerts_sent: 1, conn_alert_at: new Date(NOW - 10 * MIN).toISOString() };
    assert.strictEqual(evalAt(missed, ctx(24, 25)).shouldAlert, false, 'gap 1: still tight, just barely — not yet "holds"');
    assert.deepStrictEqual([evalAt(missed, ctx(20, 25)).kind, evalAt(missed, ctx(20, 25)).reason], ['holds', 'better']);

    const tight = { conn_band: 'tight', conn_alerts_sent: 1, conn_alert_at: new Date(NOW - 10 * MIN).toISOString() };
    assert.strictEqual(evalAt(tight, ctx(16, 25)).shouldAlert, false, 'gap 9: hovering under the line');
    assert.strictEqual(evalAt(tight, ctx(12, 25)).kind, 'holds', 'gap 13: comfortably fine');
});

test('spacing and the cap', () => {
    const justTold = { conn_band: 'tight', conn_alerts_sent: 1, conn_alert_at: new Date(NOW - 1 * MIN).toISOString() };
    assert.strictEqual(evalAt(justTold, ctx(30, 25)).reason, 'too-soon');
    const spent = { conn_band: 'tight', conn_alerts_sent: logic.CONNECTION_ALERT_MAX_PER_LEG, conn_alert_at: new Date(NOW - 60 * MIN).toISOString() };
    assert.strictEqual(evalAt(spent, ctx(30, 25)).reason, 'cap');
});

test('only when it can still be acted on', () => {
    assert.strictEqual(evalAt({}, ctx(-1, 25)).reason, 'already-arrived');
    assert.strictEqual(evalAt({}, ctx(70, 90, { arr: 70, dep: 85 })).reason, 'too-early', 'more than an hour before the arrival');
    assert.strictEqual(evalAt({}, ctx(20, -1)).reason, 'connection-departed');
});

// ── The words ────────────────────────────────────────────────────────────────

const T = (kind, over = {}) => logic.connectionRiskText(kind, {
    arrivalUnix: U(Date.parse('2026-10-30T06:50:00Z')),   // 08:50 in Sofia (EET, UTC+2: summer time ended on 25 October)
    departUnix:  U(Date.parse('2026-10-30T06:55:00Z')),
    gap: 5, connectionLive: true, label: 'БВ 8611', ...over,
});

test('Bulgarian: short titles, the times in the body', () => {
    assert.deepStrictEqual(T('tight'), { title: 'Малко време за прекачване', body: 'Пристигате в 08:50, а БВ 8611 тръгва в 08:55 (5 мин).' });
    assert.deepStrictEqual(T('missed'), { title: 'Вероятно ще изпуснете връзката', body: 'Пристигате в 08:50, а БВ 8611 тръгва в 08:55.' });
    assert.deepStrictEqual(T('holds'), { title: 'Връзката се запазва', body: 'Пристигате в 08:50, а БВ 8611 тръгва в 08:55 (5 мин).' });
});

test('with no live data for the connecting train: "may", and it says whose time it is', () => {
    const m = T('missed', { connectionLive: false });
    assert.strictEqual(m.title, 'Възможно е да изпуснете връзката');
    assert.match(m.body, /тръгва по разписание в 08:55 \(няма данни на живо за него\)/);
    assert.match(T('tight', { connectionLive: false }).body, /тръгва по разписание в 08:55/);
    assert.ok(!/навреме/.test(JSON.stringify(m)), 'never claims "on time"');
});

test('English', () => {
    const live = (k, o = {}) => T(k, { language: 'en', label: 'FT 8611', ...o });
    assert.strictEqual(live('tight').title, 'Tight connection');
    assert.strictEqual(live('tight').body, 'You arrive at 08:50 and FT 8611 leaves at 08:55 (5 min).');
    assert.strictEqual(live('missed').title, 'You will probably miss your connection');
    assert.strictEqual(live('missed', { connectionLive: false }).title, 'You may miss your connection');
    assert.match(live('missed', { connectionLive: false }).body, /leaves on schedule at 08:55 \(no live data for it\)/);
    assert.strictEqual(live('holds').title, 'Your connection holds');
});

// ── Through the real tick ────────────────────────────────────────────────────

const INSTALL = 'install-connrisk-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockApns() {
    const calls = [];
    const original = apns.send;
    apns.send = async (args) => { if (args.pushType === 'alert') calls.push(args); return { outcome: 'ok', status: 200 }; };
    return { calls, restore: () => { apns.send = original; } };
}
const alertOf = (call) => JSON.parse(call.body).aps;

/** Leg 0 is being ridden (started), leg 1 waits; both armed a while ago so the arm-time grace is over. */
function journey(id, { arrIn, depIn, language = null }) {
    const make = (leg, train, from, to, dep, arr, started) => {
        armedStore.arm({
            install_id: INSTALL, journey_id: id, leg_index: leg,
            train_number: train, train_number_display: 'БВ 8611', app_language: language,
            boarding_station: from, destination_station: to, direction_station: leg === 1 ? 'Банско' : null,
            scheduled_departure: new Date(Date.now() + dep).toISOString(),
            scheduled_arrival:   new Date(Date.now() + arr).toISOString(),
            is_current_bus: 0, next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
            now: armedStore.nowIso(),
        });
        const row = armedStore.listActive().find(r => r.journey_id === id && r.leg_index === leg);
        if (started) armedStore.markStarted(row.id);
        const db = new Database(TMP);
        db.prepare('UPDATE armed_journeys SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * MIN).toISOString(), row.id);
        db.close();
    };
    make(0, `TEST-CR-${id}-A`, 'Board', 'Transfer', -30 * MIN, arrIn * MIN, true);
    make(1, `TEST-CR-${id}-B`, 'Transfer', 'End', depIn * MIN, (depIn + 60) * MIN, false);
    return { a: `TEST-CR-${id}-A`, b: `TEST-CR-${id}-B` };
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** The arriving train: left Board 30 min ago, predicted into Transfer in `arrIn` min, running `delayMin` late. */
function feedA(train, arrIn, delayMin) {
    testFeed.set(train, { trip: { stops: [
        { station: 'Board', arrivalTime: nowSec() - 35 * 60, departureTime: nowSec() - 30 * 60 + delayMin * 60, arrivalDelay: 0, departureDelay: delayMin * 60 },
        { station: 'Transfer', arrivalTime: nowSec() + arrIn * 60, departureTime: null, arrivalDelay: delayMin * 60, departureDelay: null },
    ] } });
}
/** The connecting train: leaves Transfer in `depIn` min (predicted), `delayMin` late. */
function feedB(train, depIn, delayMin) {
    testFeed.set(train, { trip: { stops: [
        { station: 'Transfer', arrivalTime: nowSec() + (depIn - 3) * 60, departureTime: nowSec() + depIn * 60, arrivalDelay: delayMin * 60, departureDelay: delayMin * 60 },
        { station: 'End', arrivalTime: nowSec() + (depIn + 60) * 60, departureTime: null, arrivalDelay: delayMin * 60, departureDelay: null },
    ] } });
}

test.beforeEach(() => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('c'), kind: 'alert', environment: 'sandbox' });
});
test.afterEach(() => testFeed.clearAll());

async function tickWith(fn) {
    const mock = mockApns();
    try { await fn(mock); } finally { mock.restore(); }
    return mock;
}

test('the Септември case: late in, the other train has no live data → "may miss", time-sensitive; the train\'s own delay is NOT', async () => {
    const j = journey('seq', { arrIn: 20, depIn: 30 });         // 10 min to change, on the timetable
    feedA(j.a, 35, 15);                                         // 15 late: in 5 minutes AFTER the other has left

    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'seq', null);

    assert.strictEqual(mock.calls.length, 2, 'the arriving train\'s own delay, and the transfer');
    const own  = alertOf(mock.calls.find(c => JSON.parse(c.body).connection === undefined));
    const conn = alertOf(mock.calls.find(c => JSON.parse(c.body).connection === 'missed'));

    assert.match(own.alert.title, /закъснява с 15 минути/);
    assert.strictEqual(own['interruption-level'], 'active', 'the delay of the train being ridden does not interrupt');

    assert.strictEqual(conn.alert.title, 'Възможно е да изпуснете връзката');
    assert.match(conn.alert.body, /по разписание/);
    assert.match(conn.alert.body, /няма данни на живо за него/);
    assert.strictEqual(conn['interruption-level'], 'time-sensitive');
});

test('the same, but the connecting train has live data → "probably", with the time it really leaves', async () => {
    const j = journey('seqlive', { arrIn: 20, depIn: 30 });
    feedA(j.a, 35, 15);
    feedB(j.b, 31, 1);                                          // it is a minute late: leaves 5 min BEFORE we arrive

    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'seqlive', null);

    const conn = mock.calls.map(alertOf).find(a => /изпуснете/.test(a.alert.title));
    assert.strictEqual(conn.alert.title, 'Вероятно ще изпуснете връзката');
    assert.ok(!/по разписание/.test(conn.alert.body) && !/няма данни/.test(conn.alert.body));
});

test('nothing is repeated on the next tick, and the state is remembered', async () => {
    const j = journey('rep', { arrIn: 20, depIn: 30 });
    feedA(j.a, 35, 15);

    const first = await tickWith(() => armedWatcher.tick());
    const second = await tickWith(() => armedWatcher.tick());
    const row = armedStore.listActive().find(r => r.journey_id === 'rep' && r.leg_index === 0);
    armedStore.disarm(INSTALL, 'rep', null);

    assert.strictEqual(first.calls.length, 2);
    assert.strictEqual(second.calls.length, 0, 'same situation, nothing new to say');
    assert.strictEqual(row.conn_band, 'departsBeforeArrival');
    assert.strictEqual(row.conn_alerts_sent, 1);
});

test('the connecting train late by itself: "Връзката закъснява", with when it now leaves, time-sensitive', async () => {
    const j = journey('blate', { arrIn: 20, depIn: 30 });
    feedA(j.a, 20, 0);                                          // the arriving train is on time
    feedB(j.b, 50, 20);                                         // the connection leaves 20 min late: at +50

    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'blate', null);

    assert.strictEqual(mock.calls.length, 1, 'the gap only grew — no transfer alert');
    const a = alertOf(mock.calls[0]);
    assert.strictEqual(a.alert.title, 'Връзката закъснява с 20 минути');
    assert.match(a.alert.body, /^БВ 8611 към Банско тръгва в \d\d:\d\d вместо \d\d:\d\d\.$/);
    assert.strictEqual(a['interruption-level'], 'time-sensitive');
});

test('a transfer that was tight on the timetable and still is: silence', async () => {
    const j = journey('planned', { arrIn: 20, depIn: 26 });     // six minutes, as the passenger chose
    feedA(j.a, 20, 0);

    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'planned', null);
    assert.strictEqual(mock.calls.length, 0);
});

test('no live data for the arriving train: no transfer alert (the evidence has to be measured)', async () => {
    journey('nodata', { arrIn: 20, depIn: 30 });                // no feed at all
    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'nodata', null);
    assert.strictEqual(mock.calls.length, 0);
});

test('it comes back: "holds", once', async () => {
    const j = journey('back', { arrIn: 20, depIn: 40 });        // 20 min to change
    const db = new Database(TMP);
    db.prepare("UPDATE armed_journeys SET conn_band = 'departsBeforeArrival', conn_alerts_sent = 1, conn_alert_at = ? WHERE journey_id = 'back' AND leg_index = 0")
        .run(new Date(Date.now() - 20 * MIN).toISOString());
    db.close();
    feedA(j.a, 22, 2);                                          // fine again: 18 min

    const mock = await tickWith(() => armedWatcher.tick());
    armedStore.disarm(INSTALL, 'back', null);

    const conn = mock.calls.map(alertOf).find(a => a.alert.title === 'Връзката се запазва');
    assert.ok(conn, 'told it holds');
    assert.strictEqual(conn['interruption-level'], 'time-sensitive');
});

test('English app, Android phone: the same words and the same message type, plus which kind', async () => {
    const droid = 'install-connrisk-droid1';
    armedStore.registerDevice({ installId: droid, token: `fcm:${'x'.repeat(70)}`, kind: 'fcm', environment: 'n/a', platform: 'android' });
    const j = journey('droid', { arrIn: 20, depIn: 30, language: 'en' });
    const db = new Database(TMP);
    db.prepare("UPDATE armed_journeys SET install_id = ? WHERE journey_id = 'droid'").run(droid);
    db.close();
    feedA(j.a, 35, 15);

    const sent = [];
    const original = fcm.send;
    fcm.send = async (args) => { sent.push(args); return { outcome: 'ok', status: 200 }; };
    try { await armedWatcher.tick(); } finally { fcm.send = original; armedStore.disarm(droid, 'droid', null); }

    const conn = sent.find(s => s.data.connection === 'missed');
    assert.ok(conn, 'a connection message was sent');
    assert.strictEqual(conn.data.type, 'delay_alert', 'the contract the app already handles');
    assert.strictEqual(conn.data.title, 'You may miss your connection');
    assert.strictEqual(conn.data.interruptionLevel, 'time-sensitive');
});

test('a failed send is tried again later, not on the very next tick', async () => {
    const j = journey('fail', { arrIn: 20, depIn: 30 });
    feedA(j.a, 35, 15);

    let calls = 0;
    const original = apns.send;
    apns.send = async (a) => { if (a.pushType === 'alert') calls++; return { outcome: 'invalid-token', status: 400, reason: 'BadDeviceToken' }; };
    try {
        await armedWatcher.tick();
        const afterFirst = calls;
        await armedWatcher.tick();
        assert.ok(afterFirst >= 1);
        assert.strictEqual(calls, afterFirst, 'a token that just failed is not asked again 30 seconds later');
    } finally {
        apns.send = original;
        armedStore.disarm(INSTALL, 'fail', null);
    }
});
