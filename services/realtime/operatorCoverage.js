'use strict';

/**
 * operatorCoverage.js — for each train operator, how many of its trains the saved schedule says are
 * on the road right now, and how many of those the realtime feeds actually cover.
 *
 * Built for 2026-12-13, when "Ивкони Експрес" starts running part of the network (143 of its 190
 * train numbers are БДЖ's today). Whether the national feed will carry the new operator's trains is
 * not something that can be known beforehand; this shows it the first morning, in the admin overview,
 * instead of it being found out from passengers: "0 of 40 trains with data" for one operator and
 * 60% for the other means the gap is theirs, not ours.
 *
 * "Covered" is the same test the rest of the system applies: the cache holds a FRESH trip update
 * (the delay) / vehicle position for that number. Read-only; no feed traffic.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const cache    = require('./cache');
const schedule = require('../network/schedule');
const { describe } = require('../gtfs/operatorDisplay');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const KNOWN_TTL_MS = 10 * 60 * 1000;

let db = null;
let known = null;
let knownAt = 0;

/** Every operator that has trips in the saved schedule, even one that runs nothing right now. */
function knownOperators() {
    if (known && Date.now() - knownAt < KNOWN_TTL_MS) return known;
    try {
        if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        known = db.prepare('SELECT DISTINCT operator FROM trip WHERE operator IS NOT NULL ORDER BY operator').all().map(r => r.operator);
    } catch (err) {
        console.error('[rt] operator list failed:', err.message);
        known = known || [];
    }
    knownAt = Date.now();
    return known;
}

/**
 * @returns {{id:string|null, name:string, nameEn:string, running:number, withDelay:number, withPosition:number}[]}
 *   БДЖ first, then the others by id; `id: null` (trips with no operator on record) only when some run.
 */
function snapshot(nowMs = Date.now()) {
    const rows = new Map();
    const bucket = (id) => {
        if (!rows.has(id)) rows.set(id, { id, running: 0, withDelay: 0, withPosition: 0 });
        return rows.get(id);
    };
    for (const id of knownOperators()) bucket(id);

    for (const [num, j] of schedule.runningAt(nowMs)) {
        const b = bucket(j.operator || null);
        b.running++;
        if (cache.getTrain(num)) b.withDelay++;
        if (cache.getVehicle(num)) b.withPosition++;
    }

    const rank = (id) => (id === 'BDZ' ? 0 : id == null ? 2 : 1);
    return [...rows.values()]
        .filter(r => r.id != null || r.running > 0)
        .sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)))
        .map(r => {
            const d = describe(r.id);
            return { ...r, name: d ? d.name : 'Без данни за оператор', nameEn: d ? d.nameEn : 'Operator unknown' };
        });
}

/** Tests only. */
function _reset() { known = null; knownAt = 0; db = null; }

module.exports = { snapshot, knownOperators, _reset };
