'use strict';

/**
 * Real incident, 2026-10-25 (the day the clocks went back): a train at 11:09 was saved at 10:15 and
 * a minute later the Live Activity showed "under way", counting down to an arrival an hour early.
 * Both times the app registered were exactly an hour off. The server holds the timetable, so it
 * checks what it is sent: an exact hour is a time-zone mistake and the timetable's instant is used.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-ttcheck-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, 42, 25)');
    st.run(1, 'Казичене', 'Kazichene'); st.run(2, 'София', 'Sofia'); st.run(3, 'Пловдив', 'Plovdiv'); st.run(4, 'Бургас', 'Burgas');
    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const date = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    // 11:09 from Казичене, София 11:40, Пловдив 13:09 — on the day the clocks went back
    trip.run('T-1', '1611', 'БВ'); date.run('T-1', '2026-10-25');
    stop.run('T-1', 1, 1, null, '11:09'); stop.run('T-1', 2, 2, '11:40', '11:45'); stop.run('T-1', 3, 3, '13:09', null);
    // a night train: София 23:30, Бургас 03:40 the next day
    trip.run('T-N', '8100', 'БВ'); date.run('T-N', '2026-10-25');
    stop.run('T-N', 1, 2, null, '23:30'); stop.run('T-N', 2, 4, '03:40', null);
    db.close();
}

const { reconcileClientTimes, timetableTimes } = require('../services/gtfs/timetableCheck');
const ctrl  = require('../controllers/armedJourneyController');
const laCtl = require('../controllers/liveActivityController');
const logic = require('../services/liveactivity/armedLogic');

const Z = (iso) => new Date(iso);
// 11:09 on the wall clock of 2026-10-25 (winter time, UTC+2) is 09:09Z; 13:09 is 11:09Z
const OK_DEP = '2026-10-25T09:09:00.000Z', OK_ARR = '2026-10-25T11:09:00.000Z';
// what an app that still used the SUMMER offset (+3) sent: an hour early
const BAD_DEP = '2026-10-25T08:09:00.000Z', BAD_ARR = '2026-10-25T10:09:00.000Z';

const ask = (dep, arr, over = {}) => reconcileClientTimes({
    trainNumber: '1611', boardingStation: 'Казичене', destinationStation: 'Пловдив',
    departure: Z(dep), arrival: Z(arr), ...over,
});
const silenced = (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

test('the timetable gives the right instants on the day the clocks went back', () => {
    const tt = timetableTimes({ trainNumber: '1611', boardingStation: 'Казичене', destinationStation: 'Пловдив', nearMs: Z(OK_DEP).getTime() });
    assert.strictEqual(new Date(tt.departureMs).toISOString(), OK_DEP);
    assert.strictEqual(new Date(tt.arrivalMs).toISOString(), OK_ARR);
});

test('times that agree with the timetable are left alone, silently', () => {
    const r = ask(OK_DEP, OK_ARR);
    assert.deepStrictEqual([r.corrected, r.notes.length], [false, 0]);
    assert.strictEqual(r.departure.toISOString(), OK_DEP);
});

test('an hour early (the summer offset used after the clocks went back): the timetable’s instants are used', () => {
    const r = ask(BAD_DEP, BAD_ARR);
    assert.strictEqual(r.corrected, true);
    assert.strictEqual(r.departure.toISOString(), OK_DEP);
    assert.strictEqual(r.arrival.toISOString(), OK_ARR);
    assert.match(r.notes.join(' '), /time-zone mistake/);
});

test('an hour LATE (the opposite mistake, in spring) is corrected the same way', () => {
    const r = ask('2026-10-25T10:09:00.000Z', '2026-10-25T12:09:00.000Z');
    assert.strictEqual(r.departure.toISOString(), OK_DEP);
    assert.strictEqual(r.arrival.toISOString(), OK_ARR);
});

test('any other difference is left as sent (the app may know better), and noted only if it is not trivial', () => {
    const ten = ask('2026-10-25T09:19:00.000Z', OK_ARR);
    assert.strictEqual(ten.corrected, false);
    assert.strictEqual(ten.departure.toISOString(), '2026-10-25T09:19:00.000Z');
    assert.strictEqual(ten.notes.length, 1, 'ten minutes is worth a log line');
    assert.strictEqual(ask('2026-10-25T09:10:30.000Z', OK_ARR).notes.length, 0, 'seconds are not');
    assert.strictEqual(ask('2026-10-25T07:09:00.000Z', OK_ARR).corrected, false, 'two hours is NOT a time-zone mistake of the kind we fix');
});

test('only the field that is off is corrected', () => {
    const r = ask(OK_DEP, BAD_ARR);
    assert.strictEqual(r.departure.toISOString(), OK_DEP);
    assert.strictEqual(r.arrival.toISOString(), OK_ARR);
});

test('a middle stop, a night train that crosses midnight, and an unknown train', () => {
    const mid = ask('2026-10-25T09:40:00.000Z', OK_ARR, { boardingStation: 'София' });       // София 11:45 = 09:45Z; sent 09:40
    assert.strictEqual(mid.corrected, false);

    // София 23:30 on the 25th (winter time, 21:30Z); Бургас 03:40 the next day = 01:40Z. Sent an hour early.
    const night = reconcileClientTimes({
        trainNumber: '8100', boardingStation: 'София', destinationStation: 'Бургас',
        departure: Z('2026-10-25T20:30:00.000Z'), arrival: Z('2026-10-26T00:40:00.000Z'),
    });
    assert.strictEqual(night.departure.toISOString(), '2026-10-25T21:30:00.000Z');
    assert.strictEqual(night.arrival.toISOString(), '2026-10-26T01:40:00.000Z');

    const unknown = ask(BAD_DEP, BAD_ARR, { trainNumber: '99999' });
    assert.deepStrictEqual([unknown.corrected, unknown.departure.toISOString()], [false, BAD_DEP], 'no timetable: nothing is claimed');
});

// ── through the endpoints ────────────────────────────────────────────────────

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });
const hex = (c, n = 100) => String(c).repeat(n).slice(0, n);

test('/arm stores the timetable’s instants when the app sent them an hour off, and says so', () => {
    const IN = 'install-ttcheck-0001';
    const reg = res();
    ctrl.registerDevice({ body: { installId: IN, token: hex('a', 64), kind: 'push_to_start', environment: 'sandbox' } }, reg);
    const r = res();
    silenced(() => ctrl.arm({ body: {
        installId: IN, journeyId: 'j-dst', legIndex: 0, trainNumber: '1611',
        boardingStation: 'Казичене', destinationStation: 'Пловдив',
        scheduledDeparture: BAD_DEP, scheduledArrival: BAD_ARR,
    } }, r));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.timesAdjusted, true);
    assert.strictEqual(r.body.scheduledDeparture, OK_DEP);

    const db = new Database(TMP, { readonly: true });
    const row = db.prepare("SELECT scheduled_departure d, scheduled_arrival a FROM armed_journeys WHERE journey_id='j-dst'").get();
    db.close();
    assert.deepStrictEqual(row, { d: OK_DEP, a: OK_ARR });

    // and what it means for the passenger: at 10:16 (the app’s “now”) the card must NOT start yet
    const now = new Date('2026-10-25T08:16:00.000Z');               // 10:16 on the wall clock
    const stored = { state: 'armed', scheduled_departure: row.d, scheduled_arrival: row.a };
    assert.strictEqual(logic.evaluateTrigger(stored, null, now).shouldStart, false, 'the train leaves in 53 minutes');
    const asSent = { state: 'armed', scheduled_departure: BAD_DEP, scheduled_arrival: BAD_ARR };
    assert.strictEqual(logic.evaluateTrigger(asSent, null, now).shouldStart, true, 'with the times as the app sent them it would have started at once — the bug');
});

test('/arm leaves correct times alone and reports nothing adjusted', () => {
    const r = res();
    silenced(() => ctrl.arm({ body: {
        installId: 'install-ttcheck-0001', journeyId: 'j-ok', legIndex: 0, trainNumber: '1611',
        boardingStation: 'Казичене', destinationStation: 'Пловдив',
        scheduledDeparture: OK_DEP, scheduledArrival: OK_ARR,
    } }, r));
    assert.strictEqual(r.body.timesAdjusted, false);
    assert.strictEqual(r.body.scheduledDeparture, OK_DEP);
});

test('/register (the Live Activity token) is checked too', () => {
    const r = res();
    silenced(() => laCtl.register({ body: {
        token: hex('c'), environment: 'sandbox', journeyId: 'j-la', trainNumber: '1611',
        boardingStation: 'Казичене', destinationStation: 'Пловдив',
        scheduledDeparture: BAD_DEP, scheduledArrival: BAD_ARR,
    } }, r));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const db = new Database(TMP, { readonly: true });
    const row = db.prepare("SELECT scheduled_departure d, scheduled_arrival a FROM live_activity_tokens WHERE journey_id='j-la'").get();
    db.close();
    assert.deepStrictEqual(row, { d: OK_DEP, a: OK_ARR });
});
