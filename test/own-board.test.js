'use strict';

/**
 * A station board built from our own schedule + realtime delays, because БДЖ's
 * live site cannot be reached from the server. It must read like БДЖ's board
 * (the E-ink screen and the website parse that shape) and stay honest: a delay
 * only where the feed has one for THIS station, never a guess.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-board-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const ownBoard = require('../services/live/ownBoard');
const boards   = require('../services/network/boards');
const live     = require('../controllers/liveController');

// 2026-10-04 18:00 in Sofia (EEST, UTC+3)
const NOW = Date.parse('2026-10-04T15:00:00Z');
const DAY = '2026-10-04';
const YDAY = '2026-10-03';
const TOMORROW = '2026-10-05';
const midnight = ownBoard.sofiaMidnightMs(DAY);
const at = (hh, mm = 0) => midnight + (hh * 60 + mm) * 60000;     // epoch ms of HH:MM on DAY

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, 42, 25)');
    [[2, 'София', 'Sofia'], [3, 'Пловдив', 'Plovdiv'], [4, 'Бургас', 'Burgas'], [5, 'Перник', 'Pernik'], [6, 'Варна', 'Varna']]
        .forEach(([id, n, e]) => st.run(id, n, e));

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const date = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    const add = (id, num, cat, day, rows) => {
        trip.run(id, num, cat); date.run(id, day);
        rows.forEach(([sid, a, d], i) => stop.run(id, i + 1, sid, a, d));
    };

    // Sofia → Burgas, 18:30 (live feed will say 10 min late)
    add('T-8627', '8627', 'БВ', DAY, [[2, null, '18:30'], [3, '19:30', '19:32'], [4, '22:00', null]]);
    // Sofia → Pernik, 18:10 (no realtime at all)
    add('T-50207', '50207', 'КПВ', DAY, [[2, null, '18:10'], [5, '18:50', null]]);
    // Varna → Sofia, arrives 19:00, 3 min EARLY in the feed
    add('T-3601', '3601', 'БВ', DAY, [[6, null, '12:00'], [2, '19:00', null]]);
    // Sofia → Burgas, 18:20, but the feed marks the Sofia call SKIPPED
    add('T-9100', '9100', 'ПВ', DAY, [[2, null, '18:20'], [4, '21:00', null]]);
    // passes through Sofia at 18:00 on its way to Burgas, 2 min late
    add('T-1000', '1000', 'БВ', DAY, [[5, null, '17:00'], [2, '18:00', '18:02'], [4, '21:00', null]]);
    // left Sofia long ago, and one far in the future
    add('T-OLD', '7000', 'ПВ', DAY, [[2, null, '08:00'], [4, '12:00', null]]);
    add('T-LATE', '7001', 'ПВ', DAY, [[2, null, '23:50'], [4, '23:59', null]]);
    // overnight: leaves Sofia at 23:50 yesterday... and one that leaves Sofia at 00:20 TODAY (service day TOMORROW? no: DAY)
    add('T-NIGHT', '4000', 'БВ', YDAY, [[6, null, '22:00'], [2, '23:30', '23:40'], [4, '02:00', null]]);
    // after midnight tomorrow, seen from 23:30 today: service day TOMORROW, 00:10
    add('T-DAWN', '5000', 'ПВ', TOMORROW, [[2, null, '00:10'], [4, '03:00', null]]);
    // a replacement bus
    add('T-BUS', '6000', 'АВТ', DAY, [[2, null, '18:40'], [4, '20:00', null]]);
    db.close();
}

const feedStop = (stationId, schedMs, delaySec, over = {}) => ({
    stationId, station: 'x',
    arrivalTime: (schedMs / 1000) + delaySec, arrivalDelay: delaySec,
    departureTime: (schedMs / 1000) + delaySec, departureDelay: delaySec, skipped: false, ...over,
});
const feed = (map) => (num) => map[num] || [];

const BDZ_KEYS = ['delayInfo', 'delayedTime', 'direction', 'isDelayed', 'time', 'trainNum', 'type'];

// ── shape ────────────────────────────────────────────────────────────────────

test('the board has exactly the shape БДЖ’s page gives (what the E-ink screen parses)', () => {
    const b = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}) });
    assert.strictEqual(b.station, 'София ');
    const t = b.trains.find(x => x.trainNum === '50207');
    assert.deepStrictEqual(Object.keys(t).sort(), BDZ_KEYS);
    assert.deepStrictEqual(t, {
        direction: 'Перник ', time: '18:10', isDelayed: false, delayedTime: 0,
        delayInfo: { delayMinutes: 0, delayString: '', delayInfo: '' }, type: 'КПВ', trainNum: '50207',
    });
});

// ── honesty ──────────────────────────────────────────────────────────────────

test('a delay shows only where the feed has one at THIS station: expected time + scheduled time', () => {
    const runs = { '8627': [{ tripId: 'x', stops: [feedStop(2, at(18, 30), 600), feedStop(3, at(19, 30), 600)] }] };
    const b = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs), extended: true });
    const t = b.trains.find(x => x.trainNum === '8627');
    assert.deepStrictEqual(t, {
        direction: 'Бургас ', time: '18:40', isDelayed: true, delayedTime: '18:30',
        delayInfo: { delayMinutes: 10, delayString: 'Закъснение 10 мин. ', delayInfo: '' },
        type: 'БВ', trainNum: '8627', hasLiveDelay: true,
    });
});

test('no realtime for a train: scheduled time, not marked delayed, and hasLiveDelay says it is unknown', () => {
    const t = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}), extended: true })
        .trains.find(x => x.trainNum === '50207');
    assert.strictEqual(t.isDelayed, false);
    assert.strictEqual(t.hasLiveDelay, false);
    assert.strictEqual(t.time, '18:10');
});

test('hasLiveDelay is not part of the E-ink shape unless asked for', () => {
    const t = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}) }).trains[0];
    assert.ok(!('hasLiveDelay' in t));
});

test('an early train keeps its scheduled time and is not marked, like БДЖ', () => {
    const runs = { '3601': [{ tripId: 'x', stops: [feedStop(2, at(19, 0), -180)] }] };
    const t = ownBoard.build({ stationId: 2, type: 'arrivals', nowMs: NOW, getTrips: feed(runs), extended: true })
        .trains.find(x => x.trainNum === '3601');
    assert.strictEqual(t.time, '19:00');
    assert.strictEqual(t.isDelayed, false);
    assert.strictEqual(t.hasLiveDelay, true, 'the feed does know it');
});

test('a feed stop belongs to the call it is scheduled for, not to another run of the number', () => {
    // a feed stop 3 hours away from the scheduled call must not lend its delay
    const runs = { '50207': [{ tripId: 'x', stops: [feedStop(2, at(21, 10), 900)] }] };
    const t = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs), extended: true })
        .trains.find(x => x.trainNum === '50207');
    assert.strictEqual(t.hasLiveDelay, false);
    assert.strictEqual(t.isDelayed, false);
});

test('a call the feed marks SKIPPED is not listed', () => {
    const runs = { '9100': [{ tripId: 'x', stops: [feedStop(2, at(18, 20), 0, { skipped: true })] }] };
    const nums = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs) }).trains.map(t => t.trainNum);
    assert.ok(!nums.includes('9100'));
    assert.ok(ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}) }).trains.some(t => t.trainNum === '9100'));
});

// ── cancellations ────────────────────────────────────────────────────────────

test('a trip the feed marks CANCELED is not on the E-ink board, and the website row says so', () => {
    const runs = { '50207': [{ tripId: 'T-50207', canceled: true, stops: [] }] };      // a cancelled trip may carry no times
    const eink = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs) }).trains.map(t => t.trainNum);
    assert.ok(!eink.includes('50207'));
    const row = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs), extended: true })
        .trains.find(t => t.trainNum === '50207');
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.hasLiveDelay, false, 'no punctuality is claimed for a train that does not run');
    assert.strictEqual(row.isDelayed, false);
    assert.strictEqual(row.time, '18:10', 'it keeps its scheduled time, crossed out by the client');
});

test('a trip with every stop SKIPPED is cancelled too', () => {
    const runs = { '8627': [{ tripId: 'T-8627', stops: [
        feedStop(2, at(18, 30), 0, { skipped: true }), feedStop(3, at(19, 30), 0, { skipped: true }),
    ] }] };
    const row = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs), extended: true })
        .trains.find(t => t.trainNum === '8627');
    assert.strictEqual(row.status, 'cancelled');
});

test('a train that runs but skips THIS stop is marked not_stopping on the website, not listed on E-ink', () => {
    const runs = { '8627': [{ tripId: 'T-8627', stops: [
        feedStop(2, at(18, 30), 0, { skipped: true }), feedStop(3, at(19, 30), 600),
    ] }] };
    const row = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs), extended: true })
        .trains.find(t => t.trainNum === '8627');
    assert.strictEqual(row.status, 'not_stopping');
    assert.ok(!ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed(runs) }).trains.some(t => t.trainNum === '8627'));
});

test('a train ABSENT from the feed is never taken as cancelled', () => {
    const rows = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}), extended: true }).trains;
    assert.ok(rows.length > 0);
    assert.ok(rows.every(t => t.status === undefined), 'no data means no data, not "cancelled"');
});

// ── which trains, in what order ──────────────────────────────────────────────

test('departures: every call but the last, ordered by scheduled time; a bus is listed as a bus', () => {
    const b = ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}) });
    assert.deepStrictEqual(b.trains.map(t => t.trainNum), ['1000', '50207', '9100', '8627', '6000', '7001']);
    assert.strictEqual(b.trains.find(t => t.trainNum === '6000').type, 'АВТ');
    assert.ok(!b.trains.some(t => t.trainNum === '3601'), 'it ends in Sofia: an arrival, not a departure');
    assert.ok(!b.trains.some(t => t.trainNum === '7000'), 'left this morning');
});

test('arrivals: every call but the first, showing where the train comes from', () => {
    const b = ownBoard.build({ stationId: 2, type: 'arrivals', nowMs: NOW, getTrips: feed({}) });
    const t3601 = b.trains.find(t => t.trainNum === '3601');
    assert.strictEqual(t3601.direction, 'Варна ');
    assert.ok(!b.trains.some(t => t.trainNum === '8627'), 'it starts in Sofia');
});

test('a late train stays on the board until its EXPECTED time has passed', () => {
    const runs = { '50207': [{ tripId: 'x', stops: [feedStop(2, at(18, 10), 3600)] }] };   // 18:10 → 19:10
    const ids = (now) => ownBoard.build({ stationId: 2, nowMs: now, getTrips: feed(runs) }).trains.map(t => t.trainNum);
    assert.ok(ids(at(18, 40)).includes('50207'), 'scheduled 30 min ago but expected at 19:10');
    assert.ok(!ids(at(19, 30)).includes('50207'), 'gone once 19:10 has passed');
});

test('the window reaches about 6 hours ahead and not further', () => {
    const near = ownBoard.build({ stationId: 2, nowMs: at(18, 0), getTrips: feed({}) }).trains.map(t => t.trainNum);
    assert.ok(near.includes('7001'), '23:50 is 5 h 50 min away');
    const early = ownBoard.build({ stationId: 2, nowMs: at(17, 0), getTrips: feed({}) }).trains.map(t => t.trainNum);
    assert.ok(!early.includes('7001'), '6 h 50 min away');
});

test('across midnight: tonight’s overnight calls and tomorrow’s early ones', () => {
    // 4000 left Varna yesterday and reaches Sofia at 23:30 yesterday; nothing for Sofia after midnight there.
    // 00:10 tomorrow is on the service day TOMORROW; at 23:30 today it is 40 min away.
    const late = ownBoard.build({ stationId: 2, nowMs: at(23, 30), getTrips: feed({}) }).trains.map(t => t.trainNum);
    assert.ok(late.includes('5000'));
    assert.ok(late.includes('7001'));
    const t = ownBoard.build({ stationId: 2, nowMs: at(23, 30), getTrips: feed({}) }).trains.find(x => x.trainNum === '5000');
    assert.strictEqual(t.time, '00:10');
});

test('English: translated names and wording; an unknown station is null', () => {
    const runs = { '8627': [{ tripId: 'x', stops: [feedStop(2, at(18, 30), 600)] }] };
    const b = ownBoard.build({ stationId: 2, language: 'en', nowMs: NOW, getTrips: feed(runs) });
    assert.strictEqual(b.station, 'Sofia ');
    const t = b.trains.find(x => x.trainNum === '8627');
    assert.strictEqual(t.direction, 'Burgas ');
    assert.strictEqual(t.delayInfo.delayString, 'Delay 10 min. ');
    assert.strictEqual(t.type, 'FT');
    assert.strictEqual(ownBoard.build({ stationId: 99999, nowMs: NOW, getTrips: feed({}) }), null);
});

test('limit caps the list', () => {
    assert.strictEqual(ownBoard.build({ stationId: 2, nowMs: NOW, getTrips: feed({}), limit: 3 }).trains.length, 3);
});

// ── the website boards ───────────────────────────────────────────────────────

test('website boards: up to 8 trains with hasLiveDelay, from our own data (no БДЖ request)', () => {
    const v = boards.view(NOW);
    assert.strictEqual(v.sofia.name, 'София');
    assert.ok(Array.isArray(v.sofia.trains) && v.sofia.trains.length > 0 && v.sofia.trains.length <= 8);
    assert.ok(v.sofia.trains.every(t => 'hasLiveDelay' in t));
    assert.strictEqual(v.sofia.fetchedAt, new Date(NOW).toISOString());
    assert.strictEqual(v.plovdiv.name, 'Пловдив');
});

// ── /api/live when БДЖ is unreachable ────────────────────────────────────────

const axios = require('axios');

function liveCall(params) {
    return new Promise((resolve) => {
        const res = {
            code: 200,
            status(c) { this.code = c; return this; },
            json(b) { resolve({ code: this.code, body: b }); },
        };
        live.getLiveBoard({ params }, res);
    });
}

test('/api/live: by default БДЖ is not asked at all — the board comes from our own data', async () => {
    live._resetBreaker();
    const realGet = axios.get;
    let calls = 0;
    axios.get = async () => { calls += 1; throw new Error('must not be called'); };
    try {
        delete process.env.LIVE_BDZ;
        const r = await liveCall({ language: 'bg', stationNumber: '2', type: 'departures' });
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.station, 'София ');
        assert.ok(Array.isArray(r.body.trains), 'a list, as БДЖ’s board is (its row shape is pinned above)');
        assert.strictEqual(calls, 0, 'no request to a site that has blocked the server');
    } finally { axios.get = realGet; }
});

test('/api/live with LIVE_BDZ=on: БДЖ down → the same shape from our own data; after two failures it stops waiting for БДЖ', async () => {
    process.env.LIVE_BDZ = 'on';
    live._resetBreaker();
    const realGet = axios.get;
    let calls = 0;
    axios.get = async () => { calls += 1; throw new Error('timeout of 8000ms exceeded'); };
    const origErr = console.error; const origWarn = console.warn;
    console.error = () => {}; console.warn = () => {};
    try {
        const params = { language: 'bg', stationNumber: '2', type: 'departures' };
        const a = await liveCall(params);
        assert.strictEqual(a.code, 200, 'still answers');
        assert.strictEqual(a.body.station, 'София ');
        assert.ok(Array.isArray(a.body.trains));
        await liveCall(params);                                  // second failure opens the breaker
        assert.strictEqual(live._bdz.open, true);

        const before = calls;
        const c = await liveCall(params);
        assert.strictEqual(c.code, 200);
        assert.strictEqual(calls, before, 'no request is made to БДЖ while it is down');
    } finally {
        axios.get = realGet; console.error = origErr; console.warn = origWarn;
        delete process.env.LIVE_BDZ;
        live._resetBreaker();
    }
});

test('/api/live: validation errors are unchanged', async () => {
    live._resetBreaker();
    assert.strictEqual((await liveCall({ language: 'xx', stationNumber: '2', type: 'departures' })).code, 400);
    assert.strictEqual((await liveCall({ language: 'bg', stationNumber: '2', type: 'nope' })).code, 400);
    assert.strictEqual((await liveCall({ language: 'bg', stationNumber: 'abc', type: 'departures' })).code, 400);
    assert.strictEqual((await liveCall({ language: 'bg', stationNumber: '1002', type: 'departures' })).code, 400);
    assert.strictEqual((await liveCall({ language: 'bg', stationNumber: '999999', type: 'departures' })).code, 404);
});
