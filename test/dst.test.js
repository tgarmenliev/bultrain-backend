'use strict';

/**
 * The day the clocks change. A timetable is on the WALL CLOCK; on 2026-10-25 (clocks back, the day has
 * 25 hours) and 2027-03-28 (clocks forward, 23 hours) "midnight + minutes" is an hour off for
 * everything after the change. Real incident: on 2026-10-25 every board showed each train an hour
 * early ("10:09" for the 11:09 train).
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-dst-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const { wallToInstant, midnightOf, offsetMs } = require('../services/time/sofia');
const ownBoard = require('../services/live/ownBoard');

const wall = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const hm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

// ── the conversion ───────────────────────────────────────────────────────────

test('the offset is +3 in summer and +2 in winter, and changes at the right instant', () => {
    const H = 3600000;
    assert.strictEqual(offsetMs(Date.parse('2026-10-24T12:00:00Z')), 3 * H);
    assert.strictEqual(offsetMs(Date.parse('2026-10-25T12:00:00Z')), 2 * H);
    assert.strictEqual(offsetMs(Date.parse('2026-10-25T00:59:59Z')), 3 * H, 'still summer time before 01:00 UTC');
    assert.strictEqual(offsetMs(Date.parse('2026-10-25T01:00:00Z')), 2 * H, 'winter time from 01:00 UTC');
    assert.strictEqual(offsetMs(Date.parse('2027-03-28T00:59:59Z')), 2 * H);
    assert.strictEqual(offsetMs(Date.parse('2027-03-28T01:00:00Z')), 3 * H);
});

test('a timetable time on the day the clocks went back: after the change it is UTC+2', () => {
    const at = (m) => new Date(wallToInstant('2026-10-25', m)).toISOString();
    assert.strictEqual(at(2 * 60 + 30), '2026-10-24T23:30:00.000Z', '02:30 is still summer time (+3)');
    assert.strictEqual(at(5 * 60), '2026-10-25T03:00:00.000Z', '05:00 is winter time (+2)');
    assert.strictEqual(at(11 * 60 + 9), '2026-10-25T09:09:00.000Z', 'THE case: 11:09 is 09:09 UTC, not 08:09');
    assert.strictEqual(at(13 * 60 + 9), '2026-10-25T11:09:00.000Z');
    assert.strictEqual(at(24 * 60 + 30), '2026-10-25T22:30:00.000Z', '00:30 the NEXT day is winter time');
});

test('and on the day they went forward', () => {
    const at = (ymd, m) => new Date(wallToInstant(ymd, m)).toISOString();
    assert.strictEqual(at('2027-03-28', 2 * 60 + 30), '2027-03-28T00:30:00.000Z', '02:30 is still winter time (+2)');
    assert.strictEqual(at('2027-03-28', 11 * 60 + 9), '2027-03-28T08:09:00.000Z', '11:09 is summer time (+3)');
});

test('every minute of the changing days, and an ordinary one, reads back as the same wall time', () => {
    for (const ymd of ['2026-10-24', '2026-10-25', '2026-10-26', '2027-03-27', '2027-03-28', '2027-03-29', '2026-07-15']) {
        let checked = 0;
        for (let m = 0; m < 24 * 60; m++) {
            const ms = wallToInstant(ymd, m);
            const gotDate = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
            if (ymd === '2027-03-28' && m >= 3 * 60 && m < 4 * 60) continue;     // that hour does not exist
            assert.strictEqual(`${gotDate} ${wall(ms)}`, `${ymd} ${hm(m)}`, `${ymd} ${hm(m)}`);
            checked++;
        }
        assert.ok(checked >= 1380);
    }
});

test('midnightOf is the instant the wall clock reads 00:00', () => {
    assert.strictEqual(new Date(midnightOf('2026-10-25')).toISOString(), '2026-10-24T21:00:00.000Z');
    assert.strictEqual(new Date(midnightOf('2026-10-26')).toISOString(), '2026-10-25T22:00:00.000Z');
});

// ── the boards, on that day ──────────────────────────────────────────────────

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, 42, 25)');
    st.run(2, 'София', 'Sofia'); st.run(3, 'Пловдив', 'Plovdiv'); st.run(4, 'Бургас', 'Burgas');
    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const date = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');
    // leaves София 11:09, Пловдив 13:09
    trip.run('T-3621', '3621', 'БВ'); date.run('T-3621', '2026-10-25');
    stop.run('T-3621', 1, 2, null, '11:09'); stop.run('T-3621', 2, 3, '13:09', null);
    // a night train from the 24th, after midnight: София 23:30 on the 24th, Бургас 03:40 on the 25th (a 4h10 trip on the wall clock)
    trip.run('T-NIGHT', '8100', 'БВ'); date.run('T-NIGHT', '2026-10-24');
    stop.run('T-NIGHT', 1, 2, null, '23:30'); stop.run('T-NIGHT', 2, 4, '03:40', null);
    db.close();
}

const feed = (num, schedMs, delaySec) => (n) => (n === num ? [{ tripId: 'x', stops: [{
    stationId: 2, station: 'x', departureTime: schedMs / 1000 + delaySec, departureDelay: delaySec,
    arrivalTime: null, arrivalDelay: null, skipped: false,
}] }] : []);

test('on 2026-10-25 the 11:09 train is listed at 11:09, not 10:09', () => {
    const now = Date.parse('2026-10-25T08:30:00Z');                  // 10:30 on the wall clock
    const b = ownBoard.build({ stationId: 2, nowMs: now, getTrips: () => [] });
    const t = b.trains.find(x => x.trainNum === '3621');
    assert.ok(t, 'it is 39 minutes away, so it is on the board');
    assert.strictEqual(t.time, '11:09');
});

test('and the live delay is matched to the right departure (the feed is in real instants)', () => {
    const sched = Date.parse('2026-10-25T09:09:00Z');                 // 11:09 EET
    const now = Date.parse('2026-10-25T08:30:00Z');
    const t = ownBoard.build({ stationId: 2, nowMs: now, extended: true, getTrips: feed('3621', sched, 5 * 60) })
        .trains.find(x => x.trainNum === '3621');
    assert.strictEqual(t.hasLiveDelay, true, 'before the fix the schedule was an hour off, so no feed stop matched');
    assert.deepStrictEqual([t.time, t.delayedTime, t.isDelayed], ['11:14', '11:09', true], '11:09 + 5 minutes');
});

test('a train that leaves in the evening before the change is listed at its wall-clock time', () => {
    const now = Date.parse('2026-10-24T20:00:00Z');                  // 23:00 EEST on the 24th, 4 hours before the change
    const t = ownBoard.build({ stationId: 2, nowMs: now, getTrips: () => [] }).trains.find(x => x.trainNum === '8100');
    assert.ok(t, 'it leaves in 30 minutes');
    assert.strictEqual(t.time, '23:30');
});
