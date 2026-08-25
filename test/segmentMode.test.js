'use strict';

/**
 * Real incident (2026-08-23): train 30122, train as far as Волуяк, replacement
 * bus onward to Драгоман. A passenger travelling Антон→София — entirely on the
 * train portion — was shown "АВТ 30122" because trainCategory.displayFor()
 * picks whichever of the train's several trip rows (one per category) happens
 * to load first, with no idea which leg the passenger is even on.
 * segmentMode.js resolves the category for the SPECIFIC boarding station instead.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-segmode-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const { resolveBoardingCategory, sofiaServiceDate } = require('../services/gtfs/segmentMode');

const DATE = '2026-08-23';

function seedStation(db, id, name) {
    db.prepare('INSERT OR IGNORE INTO stations (id, name) VALUES (?, ?)').run(id, name);
}

function seedTrip(db, tripId, trainNumber, category, stops) {
    db.prepare('INSERT INTO trip (trip_id, train_number, category) VALUES (?, ?, ?)').run(tripId, trainNumber, category);
    db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)').run(tripId, DATE);
    stops.forEach((s, i) => {
        seedStation(db, s.id, s.name);
        db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)')
            .run(tripId, i, s.id, s.arrive || null, s.depart || null);
    });
}

const db = new Database(TMP);
// Train leg: Антон -> ... -> Волуяк (the transfer point).
seedTrip(db, '30122-PV-20260823', '30122', 'ПВ', [
    { id: 101, name: 'Антон', depart: '06:00' },
    { id: 102, name: 'София', arrive: '06:40', depart: '06:45' },
    { id: 103, name: 'Волуяк', arrive: '07:00', depart: '07:05' },
]);
// Bus leg: Волуяк (shared transfer name) -> ... -> Драгоман.
seedTrip(db, '30122-A-20260823', '30122', 'АВТ', [
    { id: 103, name: 'Волуяк', arrive: '07:05', depart: '07:10' },
    { id: 104, name: 'Костинброд', arrive: '07:25', depart: '07:26' },
    { id: 105, name: 'Драгоман', arrive: '08:00' },
]);
db.close();

test('boarding entirely on the train portion resolves to the train category, not the bus one', () => {
    assert.deepStrictEqual(resolveBoardingCategory('30122', DATE, 'Антон'), { category: 'ПВ' });
    assert.deepStrictEqual(resolveBoardingCategory('30122', DATE, 'София'), { category: 'ПВ' });
});

test('boarding AT the transfer point resolves to the ONWARD (bus) leg', () => {
    assert.deepStrictEqual(resolveBoardingCategory('30122', DATE, 'Волуяк'), { category: 'АВТ' });
});

test('boarding on the bus portion resolves to bus', () => {
    assert.deepStrictEqual(resolveBoardingCategory('30122', DATE, 'Костинброд'), { category: 'АВТ' });
});

test('the route\'s final stop is nobody\'s boarding station — resolves to null, caller falls back', () => {
    assert.strictEqual(resolveBoardingCategory('30122', DATE, 'Драгоман'), null);
});

test('an unknown train, date, or station resolves to null rather than throwing', () => {
    assert.strictEqual(resolveBoardingCategory('99999', DATE, 'Антон'), null);
    assert.strictEqual(resolveBoardingCategory('30122', '2099-01-01', 'Антон'), null);
    assert.strictEqual(resolveBoardingCategory('30122', DATE, 'Никаквогара'), null);
    assert.strictEqual(resolveBoardingCategory(null, DATE, 'Антон'), null);
});

test('sofiaServiceDate formats as YYYY-MM-DD in Europe/Sofia, not UTC', () => {
    // 23:30 Sofia time (summer, UTC+3) on the 22nd is still 22nd locally,
    // even though the UTC instant has already rolled to the 23rd.
    assert.strictEqual(sofiaServiceDate('2026-08-22T20:30:00.000Z'), '2026-08-22');
    assert.strictEqual(sofiaServiceDate('2026-08-22T21:30:00.000Z'), '2026-08-23');
});
