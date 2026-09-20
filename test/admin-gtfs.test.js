'use strict';

/**
 * The admin panel's train list used to come from the legacy scraped tables,
 * which are wrong. adminView.js reads the saved GTFS schedule (trip /
 * trip_date / trip_stop) by service date instead — same tables the app is
 * served from. These pin what the admin sees for a chosen date.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-adminview-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
const view     = require('../services/gtfs/adminView');
const ctrl     = require('../controllers/adminGtfsController');

// Dates relative to today (Sofia), so the suite never goes stale.
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const D0 = view.sofiaToday();
const D1 = addDays(D0, 1);
const D5 = addDays(D0, 5);

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, 42, 23)');
    [[1, 'София'], [2, 'Перник'], [3, 'Радомир'], [4, 'Волуяк'], [5, 'Драгоман'],
     [6, 'Пловдив'], [7, 'Костенец']].forEach(([id, n]) => st.run(id, n, n));

    const trip = db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)');
    const day  = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const stop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');

    // A plain train, runs today and tomorrow.
    trip.run('T-1600', '1600', 'ПВ'); day.run('T-1600', D0); day.run('T-1600', D1);
    stop.run('T-1600', 1, 1, null, '06:12');
    stop.run('T-1600', 2, 2, '07:00', '07:02');
    stop.run('T-1600', 3, 3, '07:40', null);

    // One number = a train leg plus a replacement-bus leg (inserted bus-first on purpose).
    trip.run('T-30122-B', '30122', 'АВТ'); day.run('T-30122-B', D0);
    stop.run('T-30122-B', 1, 4, null, '05:30');
    stop.run('T-30122-B', 2, 5, '06:40', null);
    trip.run('T-30122-A', '30122', 'ПВ'); day.run('T-30122-A', D0);
    stop.run('T-30122-A', 1, 1, null, '05:00');
    stop.run('T-30122-A', 2, 4, '05:20', '05:30');

    // Overnight: 23:24 → 00:31 → 02:09 (materialize wraps past-midnight times to HH:MM).
    trip.run('T-13154', '13154', 'МБВ'); day.run('T-13154', D0);
    stop.run('T-13154', 1, 6, null, '23:24');
    stop.run('T-13154', 2, 7, '00:31', '00:40');
    stop.run('T-13154', 3, 1, '02:09', null);

    // A stop the crosswalk could not map (station_id NULL).
    trip.run('T-8000', '8000', 'ПВ'); day.run('T-8000', D0);
    stop.run('T-8000', 1, 1, null, '10:00');
    stop.run('T-8000', 2, null, '10:30', '10:31');
    stop.run('T-8000', 3, 2, '11:00', null);

    // Only on a later day.
    trip.run('T-9999', '9999', 'БВ'); day.run('T-9999', D5);
    stop.run('T-9999', 1, 1, null, '12:00');
    stop.run('T-9999', 2, 2, '13:00', null);

    db.prepare(`INSERT INTO gtfs_import (file_id, filename, checksum, feed_version, feed_start, feed_end, imported_at, status)
                VALUES ('f', 'x.zip', 'c', 'v42', ?, ?, '2026-09-20T03:00:00Z', 'ok')`).run(D0, D5);

    const topic = db.prepare("INSERT INTO handbook_topics (app_topic_id, language, title, category, status) VALUES (?, 'bg', ?, ?, ?)");
    topic.run(1, 'Как се чете табло', 'guide', 'published');
    topic.run(2, 'Идея 1', 'travel_idea', 'published');
    topic.run(3, 'Идея 2', 'travel_idea', 'published');
    topic.run(4, 'Идея 3', 'travel_idea', 'draft');

    const dh = db.prepare('INSERT INTO delay_history (train_number, station_id, date, delay_seconds) VALUES (?, ?, ?, ?)');
    dh.run('1600', 1, D0, 600); dh.run('1600', 2, D0, 1200); dh.run('30122', 1, D0, 0);
    dh.run('1600', 1, addDays(D0, -3), 9000); // another day — must not count
    db.close();
}

const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });

// ── dates ────────────────────────────────────────────────────────────────────

test('isValidYmd accepts real dates only', () => {
    assert.strictEqual(view.isValidYmd('2026-09-20'), true);
    assert.strictEqual(view.isValidYmd('2026-02-30'), false, 'no such day');
    assert.strictEqual(view.isValidYmd('20-09-2026'), false);
    assert.strictEqual(view.isValidYmd('2026-9-2'), false);
    assert.strictEqual(view.isValidYmd(undefined), false);
    assert.strictEqual(view.isValidYmd(['2026-09-20']), false);
});

test('defaultDate: today when covered, else the nearest covered day', () => {
    const range = { from: '2026-09-10', to: '2026-12-01' };
    assert.strictEqual(view.defaultDate(range, '2026-09-20'), '2026-09-20');
    assert.strictEqual(view.defaultDate(range, '2026-09-01'), '2026-09-10');
    assert.strictEqual(view.defaultDate(range, '2027-01-05'), '2026-12-01');
    assert.strictEqual(view.defaultDate(null, '2026-09-20'), '2026-09-20');
});

test('dateRange spans every saved run date', () => {
    assert.deepStrictEqual(view.dateRange(), { from: D0, to: D5 });
});

// ── list for one date ────────────────────────────────────────────────────────

test('listTrainsOn returns only the trains that run that day, in numeric order', () => {
    const numbers = view.listTrainsOn(D0).map(t => t.trainNumber);
    assert.deepStrictEqual(numbers, ['1600', '8000', '13154', '30122']);

    assert.deepStrictEqual(view.listTrainsOn(D1).map(t => t.trainNumber), ['1600'], 'only 1600 runs tomorrow');
    assert.deepStrictEqual(view.listTrainsOn(D5).map(t => t.trainNumber), ['9999']);
    assert.deepStrictEqual(view.listTrainsOn(addDays(D0, 90)), [], 'a day outside the schedule is simply empty');
});

test('a row carries the route ends, times and stop count', () => {
    const t = view.listTrainsOn(D0).find(x => x.trainNumber === '1600');
    assert.strictEqual(t.from, 'София');
    assert.strictEqual(t.to, 'Радомир');
    assert.strictEqual(t.departs, '06:12');
    assert.strictEqual(t.arrives, '07:40');
    assert.strictEqual(t.stops, 3);
    assert.deepStrictEqual(t.categories, ['ПВ']);
    assert.strictEqual(t.arrivesDay, 0);
});

test('a train leg plus a replacement-bus leg is ONE row, in travel order', () => {
    const t = view.listTrainsOn(D0).find(x => x.trainNumber === '30122');
    assert.deepStrictEqual(t.categories, ['ПВ', 'АВТ'], 'train first, bus second — not insertion order');
    assert.strictEqual(t.from, 'София');
    assert.strictEqual(t.to, 'Драгоман');
    assert.strictEqual(t.legs, 2);
    assert.strictEqual(t.stops, 4);
});

test('an overnight train arrives on the next day (+1), not "before" it left', () => {
    const t = view.listTrainsOn(D0).find(x => x.trainNumber === '13154');
    assert.strictEqual(t.departs, '23:24');
    assert.strictEqual(t.arrives, '02:09');
    assert.strictEqual(t.arrivesDay, 1);
});

// ── one train ────────────────────────────────────────────────────────────────

test('getTrainOn: null when the train does not run that day', () => {
    assert.strictEqual(view.getTrainOn('1600', D5), null);
    assert.strictEqual(view.getTrainOn('0000', D0), null);
});

test('getTrainOn: midnight crossings are counted per stop', () => {
    const { legs } = view.getTrainOn('13154', D0);
    const [a, b, c] = legs[0].stops;
    assert.deepStrictEqual([a.departDay], [0]);
    assert.deepStrictEqual([b.arriveDay, b.departDay], [1, 1], 'past midnight: 00:31 and 00:40 are day +1');
    assert.deepStrictEqual([c.arriveDay], [1]);
});

test('getTrainOn: replacement-bus legs stay separate and ordered by time', () => {
    const { legs } = view.getTrainOn('30122', D0);
    assert.deepStrictEqual(legs.map(l => l.category), ['ПВ', 'АВТ']);
    assert.deepStrictEqual(legs[0].stops.map(s => s.station), ['София', 'Волуяк']);
    assert.deepStrictEqual(legs[1].stops.map(s => s.station), ['Волуяк', 'Драгоман']);
});

test('getTrainOn keeps a stop the crosswalk could not map — visible, not hidden', () => {
    const { legs } = view.getTrainOn('8000', D0);
    const mid = legs[0].stops[1];
    assert.strictEqual(mid.station, null);
    assert.strictEqual(mid.mapped, false);
    assert.strictEqual(legs[0].stops.length, 3, 'the unmapped stop is not dropped');
    assert.strictEqual(legs[0].stops[0].mapped, true);
});

// ── overview ─────────────────────────────────────────────────────────────────

test('overview reports the saved schedule, not the legacy table', () => {
    const o = view.overview();
    assert.strictEqual(o.gtfs.hasData, true);
    assert.strictEqual(o.trains, 5, 'distinct GTFS train numbers: 1600, 30122, 13154, 8000, 9999');
    assert.strictEqual(o.today.trains, 4);
    assert.strictEqual(o.gtfs.from, D0);
    assert.strictEqual(o.gtfs.to, D5);
    assert.strictEqual(o.gtfs.daysLeft, 5);
    assert.strictEqual(o.gtfs.feedVersion, 'v42');
    assert.strictEqual(o.gtfs.importedAt, '2026-09-20T03:00:00Z');
    // Migrations seed a few extra stations of their own, so compare with the
    // table itself rather than a hard-coded number.
    const db = new Database(TMP, { readonly: true });
    assert.strictEqual(o.stations, db.prepare('SELECT COUNT(*) AS n FROM stations').get().n);
    db.close();
});

test('overview: guide topics and ideas are counted by what they are', () => {
    const o = view.overview();
    assert.strictEqual(o.guideTopics, 1, 'travel ideas are not guide topics');
    assert.deepStrictEqual(o.content, { ideasPublished: 2, ideasDraft: 1 });
});

test("overview: delay figures come only from today's observations", () => {
    const o = view.overview();
    assert.strictEqual(o.delays.trainsObserved, 2);
    assert.strictEqual(o.delays.avgDelayMin, 10, '(600 + 1200 + 0) / 3 rows = 600s = 10 min; the 9000s row is from another day');
});

// ── controller ───────────────────────────────────────────────────────────────

test('listTrains: no date means the default day; a bad date is a 400', () => {
    let res = mockRes();
    ctrl.listTrains({ query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.date, D0);
    assert.strictEqual(res.body.hasData, true);
    assert.deepStrictEqual(res.body.range, { from: D0, to: D5 });
    assert.ok(res.body.trains.length >= 4);

    res = mockRes();
    ctrl.listTrains({ query: { date: '2026-02-30' } }, res);
    assert.strictEqual(res.statusCode, 400);

    res = mockRes();
    ctrl.listTrains({ query: { date: ['2026-09-20', '2026-09-21'] } }, res);
    assert.strictEqual(res.statusCode, 400, 'a repeated ?date= must not slip through');
});

test('getTrain: 200 with legs, 404 when it does not run, 400 on nonsense', () => {
    let res = mockRes();
    ctrl.getTrain({ params: { trainNo: '1600' }, query: { date: D0 } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.trainNumber, '1600');
    assert.strictEqual(res.body.legs[0].stops.length, 3);

    res = mockRes();
    ctrl.getTrain({ params: { trainNo: '1600' }, query: { date: D5 } }, res);
    assert.strictEqual(res.statusCode, 404);

    res = mockRes();
    ctrl.getTrain({ params: { trainNo: 'x'.repeat(40) }, query: { date: D0 } }, res);
    assert.strictEqual(res.statusCode, 400);
});

test('overview endpoint: schedule numbers plus the live blocks', () => {
    const res = mockRes();
    ctrl.overview({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.gtfs.hasData, true);
    assert.ok(res.body.realtime && 'tripFresh' in res.body.realtime, 'realtime block present');
    assert.ok(res.body.tracking && 'devicesAndroid' in res.body.tracking, 'tracking block present');
});
