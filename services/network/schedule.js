'use strict';

/**
 * schedule.js — which trains the SAVED SCHEDULE says are on the road right now.
 *
 * A train is "running" between its first departure and its last arrival as
 * published (an overnight run belongs to the day it left, so yesterday's trips
 * are checked too). Replacement buses are not trains and are left out.
 *
 * The windows of a service day never change within the day, so they are built
 * once per date (one query, a few thousand rows) and re-used; a per-minute
 * snapshot then only filters an in-memory list.
 */

const path     = require('path');
const Database = require('better-sqlite3');
const tripMeta = require('../realtime/tripMeta');

const DB_PATH      = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000;   // the daily GTFS refresh can replace a day's trips

let db = null;
const conn = () => (db || (db = new Database(DB_PATH, { readonly: true, fileMustExist: true })));

const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

// ── Station names ────────────────────────────────────────────────────────────

let names = null;
let namesAt = 0;
function nameOf(stationId) {
    if (stationId == null) return null;
    if (!names || Date.now() - namesAt > CACHE_TTL_MS) {
        try {
            names = new Map(conn().prepare('SELECT id, name FROM stations').all().map(r => [r.id, r.name]));
        } catch (err) {
            console.error('[network] station names failed:', err.message);
            names = names || new Map();
        }
        namesAt = Date.now();
    }
    return names.get(stationId) || null;
}

// ── Windows of one service day ───────────────────────────────────────────────

/**
 * @returns {Map<string, {category:string, fromId:number|null, toId:number|null,
 *            legs:{start:number,end:number}[]}>}
 *   train number → its journey; legs in minutes from that date's midnight
 *   (an arrival after midnight is > 1440).
 */
function loadDay(date) {
    const rows = conn().prepare(`
        SELECT t.trip_id AS tripId, t.train_number AS num, t.category, ts.station_id AS stationId,
               ts.arrive, ts.depart
          FROM trip_date td
          JOIN trip t       ON t.trip_id = td.trip_id
          JOIN trip_stop ts ON ts.trip_id = t.trip_id
         WHERE td.date = ? AND t.category <> 'АВТ'
         ORDER BY t.trip_id, ts.seq
    `).all(date);

    // One leg per trip. materialize.js wraps times past 24:00 to HH:MM, so a
    // backwards jump is a midnight crossing.
    const legs = new Map();
    let cur = null;
    let day = 0;
    let prev = null;
    for (const r of rows) {
        if (!cur || cur.tripId !== r.tripId) {
            // origin = the leg's first stop, strictly: an unmapped one stays null
            cur = { tripId: r.tripId, num: r.num, category: r.category, start: null, end: null,
                    fromId: r.stationId, toId: null };
            legs.set(r.tripId, cur);
            day = 0;
            prev = null;
        }
        for (const t of [r.arrive, r.depart]) {
            const m = toMin(t);
            if (m == null) continue;
            if (prev != null && m < prev) day += 1;
            prev = m;
            const abs = day * 1440 + m;
            if (cur.start == null) cur.start = abs;
            cur.end = abs;
        }
        cur.toId = r.stationId;            // ends up as the last stop's
    }

    const byNum = new Map();
    for (const l of legs.values()) {
        if (l.start == null || l.end == null) continue;
        let j = byNum.get(l.num);
        if (!j) { j = { category: l.category, first: l, last: l, legs: [] }; byNum.set(l.num, j); }
        j.legs.push({ start: l.start, end: l.end });
        if (l.start < j.first.start) { j.first = l; j.category = l.category; }
        if (l.end > j.last.end) j.last = l;
    }
    const out = new Map();
    for (const [num, j] of byNum) {
        out.set(num, { category: j.category, fromId: j.first.fromId, toId: j.last.toId, legs: j.legs });
    }
    return out;
}

const dayCache = new Map();   // date -> { at, value }
function day(date) {
    const hit = dayCache.get(date);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    let value;
    try {
        value = loadDay(date);
    } catch (err) {
        console.error('[network] schedule load failed:', err.message);   // no tables yet: nothing scheduled
        value = new Map();
    }
    dayCache.set(date, { at: Date.now(), value });
    if (dayCache.size > 4) dayCache.delete(dayCache.keys().next().value);
    return value;
}

/**
 * Trains running at `nowMs` according to the saved schedule.
 * @returns {Map<string, {category:string, fromId:number|null, toId:number|null}>}
 */
function runningAt(nowMs) {
    const today = tripMeta.sofiaYmd(nowMs);
    const nowMin = tripMeta.sofiaMinuteOfDay(nowMs);
    const out = new Map();

    const scan = (date, minute) => {
        for (const [num, j] of day(date)) {
            if (out.has(num)) continue;
            if (j.legs.some(l => l.start <= minute && minute <= l.end)) {
                out.set(num, { category: j.category, fromId: j.fromId, toId: j.toId });
            }
        }
    };
    scan(today, nowMin);
    scan(tripMeta.prevDay(today), nowMin + 1440);   // yesterday's overnight runs
    return out;
}

function _reset() { dayCache.clear(); names = null; }

module.exports = { runningAt, nameOf, loadDay, _reset };
