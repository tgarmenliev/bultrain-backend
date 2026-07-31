'use strict';

/**
 * Unit tests for the per-stop `mode` tag on the merged train-info route.
 *
 * The point being pinned: a route that is train → bus → train must not read as
 * one continuous train. `mode` is the mode of the leg DEPARTING each stop, and a
 * transfer station takes the ONWARD leg's mode. Existing fields
 * (station/arrive/depart) must be untouched — additive only.
 */

const test   = require('node:test');
const assert = require('node:assert');
const { buildStations, modeOf } = require('../services/gtfs/serving');

// Rows carry bg_name; nameOf just reads it here.
const nameOf = (r) => r.bg_name;
const stop = (name, arrive, depart) => ({ bg_name: name, arrive, depart });

test('modeOf maps the bus category, everything else is train', () => {
    assert.strictEqual(modeOf('АВТ'), 'bus');
    assert.strictEqual(modeOf('ПВ'), 'train');
    assert.strictEqual(modeOf('БВ'), 'train');
    assert.strictEqual(modeOf('anything-else'), 'train');
});

test('a plain train: every stop is mode train, endpoints marked', () => {
    const legs = [{ category: 'ПВ', stops: [
        stop('София', '10:00', '10:00'),
        stop('Пловдив', '11:30', '11:35'),
        stop('Бургас', '13:00', '13:00'),
    ] }];
    const out = buildStations(legs, nameOf);
    assert.deepStrictEqual(out.map(s => s.mode), ['train', 'train', 'train']);
    assert.strictEqual(out[0].arrive, '↦');
    assert.strictEqual(out[out.length - 1].depart, '↤');
    // Existing fields intact.
    assert.strictEqual(out[1].station, 'Пловдив');
    assert.strictEqual(out[1].depart, '11:35');
});

test('train → bus → train: mode flips at the transfer stations', () => {
    const legs = [
        { category: 'ПВ',  stops: [ stop('София', '09:00', '09:00'), stop('Мездра', '10:00', '10:05') ] },
        { category: 'АВТ', stops: [ stop('Мездра', '10:05', '10:10'), stop('Враца', '10:50', '10:55') ] },
        { category: 'БВ',  stops: [ stop('Враца', '10:55', '11:00'), stop('Видин', '12:30', '12:30') ] },
    ];
    const out = buildStations(legs, nameOf);

    // Five distinct stops after merging the two shared transfer stations.
    assert.deepStrictEqual(out.map(s => s.station), ['София', 'Мездра', 'Враца', 'Видин']);

    // Departing modes: София(train) → Мездра departs by BUS → Враца departs by
    // TRAIN → Видин is the end (keeps arriving mode: train).
    assert.deepStrictEqual(out.map(s => s.mode), ['train', 'bus', 'train', 'train']);

    // Transfer stop kept its arrival but took the onward departure.
    const mezdra = out[1];
    assert.strictEqual(mezdra.arrive, '10:00', 'arrival is the train leg’s');
    assert.strictEqual(mezdra.depart, '10:10', 'departure is the bus leg’s');
});

test('a bus-ending route reads as bus at its final stop', () => {
    const legs = [
        { category: 'ПВ',  stops: [ stop('София', '09:00', '09:00'), stop('Мездра', '10:00', '10:05') ] },
        { category: 'АВТ', stops: [ stop('Мездра', '10:05', '10:10'), stop('Враца', '10:50', '10:50') ] },
    ];
    const out = buildStations(legs, nameOf);
    assert.deepStrictEqual(out.map(s => s.mode), ['train', 'bus', 'bus']);
});

test('mode is added without disturbing the existing keys', () => {
    const legs = [{ category: 'ПВ', stops: [ stop('А', '08:00', '08:00'), stop('Б', '09:00', '09:00') ] }];
    const out = buildStations(legs, nameOf);
    assert.deepStrictEqual(Object.keys(out[0]), ['station', 'arrive', 'depart', 'mode']);
});
