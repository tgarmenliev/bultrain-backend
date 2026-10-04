'use strict';

/**
 * tripMeta.js — what the saved GTFS schedule knows about one trip, for the
 * live map: its type, origin/destination, the stations it actually CALLS at,
 * and the dates it runs.
 *
 * The realtime feeds identify a run only by trip_id. Everything here is looked
 * up by that id in the materialised trip / trip_stop / trip_date tables, cached
 * per trip (it only changes with the daily GTFS refresh), and degrades to null
 * when the trip or the tables are missing — a missing answer is sent as null,
 * never guessed.
 */

const path     = require('path');
const Database = require('better-sqlite3');
const { typeCodeFor } = require('../gtfs/categoryDisplay');

const DB_PATH      = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const TTL_MS       = 60 * 60 * 1000;
const MISS_TTL_MS  = 10 * 60 * 1000;   // a trip not materialised yet may be, soon
const MAX_ENTRIES  = 5000;

let db = null;
const cache = new Map();   // trip_id -> { at, value }

function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** True when the (midnight-wrapped) stop times ever go backwards: the trip runs past 24:00. */
function crossesMidnight(stops) {
    let prev = null;
    for (const s of stops) {
        for (const t of [s.arrive, s.depart]) {
            const m = toMin(t);
            if (m == null) continue;
            if (prev != null && m < prev) return true;
            prev = m;
        }
    }
    return false;
}

function load(tripId) {
    const c = conn();
    const trip = c.prepare('SELECT category FROM trip WHERE trip_id = ?').get(tripId);
    if (!trip) return null;

    const stops = c.prepare(
        'SELECT station_id, arrive, depart FROM trip_stop WHERE trip_id = ? ORDER BY seq'
    ).all(tripId);
    const dates = c.prepare('SELECT date FROM trip_date WHERE trip_id = ?').all(tripId).map(r => r.date);

    const first = stops[0];
    const last  = stops[stops.length - 1];
    return {
        category: trip.category,
        trainType: typeCodeFor(trip.category),
        // Strictly the first/last stop of THIS trip: if that stop is not mapped to
        // a station we say null, we do not quietly promote the next one.
        originStationId:      first && first.station_id != null ? first.station_id : null,
        destinationStationId: last  && last.station_id  != null ? last.station_id  : null,
        callingStationIds: new Set(stops.filter(s => s.station_id != null).map(s => s.station_id)),
        dates: new Set(dates),
        crossesMidnight: crossesMidnight(stops),
        firstMin: first ? (toMin(first.depart) ?? toMin(first.arrive)) : null,
        lastMin:  last  ? (toMin(last.arrive)  ?? toMin(last.depart))  : null,
    };
}

/** @returns {object|null} null when the trip is unknown to the saved schedule. */
function get(tripId) {
    if (!tripId) return null;
    const hit = cache.get(tripId);
    if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;

    let value = null;
    try {
        value = load(tripId);
    } catch (err) {
        console.error('[rt] tripMeta failed:', err.message);   // missing tables / DB: degrade to null
    }
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(tripId, { at: Date.now(), value });
    return value;
}

// ── Service date ─────────────────────────────────────────────────────────────

const sofiaYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });

function sofiaMinuteOfDay(ms) {
    const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const part = (t) => Number(p.find(x => x.type === t).value);
    return part('hour') * 60 + part('minute');
}

const prevDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

// How far past its scheduled arrival an overnight run is still taken to be
// "yesterday's" run rather than today's. Delays beyond 3 h on an overnight
// service are rare and the alternative (today's run) hasn't started yet then.
const LATE_SLACK_MIN = 180;

/**
 * The service day of a LIVE run. The feed does not publish TripDescriptor
 * start_date, and the date suffix of the trip_id is NOT the service day (one
 * trip runs on many dates), so it is derived from the saved schedule: the trip
 * must actually run on the date we name. Only the overnight case is ambiguous —
 * a run that crossed midnight and is still on the road the next morning belongs
 * to the previous day.
 *
 * @returns {string|null} YYYY-MM-DD, or null when it cannot be told.
 */
function deriveServiceDate(meta, atMs) {
    if (!meta || !Number.isFinite(atMs)) return null;
    const today = sofiaYmd(atMs);
    const yday  = prevDay(today);

    if (meta.crossesMidnight && meta.dates.has(yday) && meta.firstMin != null && meta.lastMin != null) {
        const now = sofiaMinuteOfDay(atMs);
        if (now < meta.firstMin && now <= meta.lastMin + LATE_SLACK_MIN) return yday;
    }
    if (meta.dates.has(today)) return today;
    if (meta.crossesMidnight && meta.dates.has(yday)) return yday;
    return null;
}

/** Tests only. */
function _reset() { cache.clear(); }

module.exports = { get, deriveServiceDate, crossesMidnight, sofiaYmd, sofiaMinuteOfDay, prevDay, _reset };
