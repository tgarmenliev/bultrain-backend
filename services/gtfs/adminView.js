'use strict';

/**
 * adminView.js — read-only views of the saved GTFS schedule for the admin panel.
 *
 * The admin used to list trains from the legacy scraped tables (trains /
 * schedules), which are no longer correct. The authoritative schedule is the
 * GTFS data materialised into trip / trip_date / trip_stop (see materialize.js),
 * and that is what the mobile app is served from. This reads exactly those
 * tables, by SERVICE DATE, so what the admin sees is what the app serves.
 *
 * Connection is lazy and honours BULTRAIN_DB (same convention as segmentMode.js)
 * so tests never touch a real database.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

let db = null;
function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30 and the like). */
function isValidYmd(s) {
    if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "Today" for a Bulgarian schedule is the Sofia calendar day, not the server's. */
const sofiaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });

const dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);

/** {from,to} of every date the saved schedule covers, or null when it is empty. */
function dateRange() {
    const r = conn().prepare('SELECT MIN(date) AS lo, MAX(date) AS hi FROM trip_date').get();
    return r && r.lo ? { from: r.lo, to: r.hi } : null;
}

/** Today if the schedule covers it, else the nearest covered day. */
function defaultDate(range, today = sofiaToday()) {
    if (!range) return today;
    if (today < range.from) return range.from;
    if (today > range.to) return range.to;
    return today;
}

// ── Times ────────────────────────────────────────────────────────────────────

const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/**
 * materialize.js wraps GTFS times past 24:00 to HH:MM, so "00:31" after "23:00"
 * is really the next day. Walk the stops in order and count each backwards jump
 * as a midnight crossing, so the admin can show "+1" instead of a time that
 * looks earlier than the departure. `state` carries across chained legs.
 */
function withDayOffsets(stops, state) {
    return stops.map((s) => {
        const bump = (t) => {
            const m = toMin(t);
            if (m == null) return state.day;
            if (state.prev != null && m < state.prev) state.day += 1;
            state.prev = m;
            return state.day;
        };
        const arriveDay = bump(s.arrive);
        const departDay = bump(s.depart);
        return { ...s, arriveDay, departDay };
    });
}

const startMin = (leg) => toMin(leg.firstTime) ?? Number.MAX_SAFE_INTEGER;

// ── Train list for one date ──────────────────────────────────────────────────

/**
 * One row per TRAIN NUMBER running on `date`. A number can be several trips at
 * once (a train leg plus a replacement-bus leg), chained by time — they are
 * merged into a single row so the list reads like the timetable does.
 */
function listTrainsOn(date) {
    const rows = conn().prepare(`
        WITH day_trips AS (
            SELECT t.trip_id, t.train_number, t.category
            FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
            WHERE td.date = ?
        ),
        bounds AS (
            SELECT ts.trip_id, MIN(ts.seq) AS s0, MAX(ts.seq) AS s1, COUNT(*) AS n
            FROM trip_stop ts JOIN day_trips d ON d.trip_id = ts.trip_id
            GROUP BY ts.trip_id
        )
        SELECT d.trip_id, d.train_number, d.category, b.n,
               fs.name AS from_name, f.depart AS first_depart, f.arrive AS first_arrive,
               ls.name AS to_name,   l.arrive AS last_arrive,  l.depart AS last_depart
        FROM day_trips d
        JOIN bounds b ON b.trip_id = d.trip_id
        JOIN trip_stop f ON f.trip_id = d.trip_id AND f.seq = b.s0
        LEFT JOIN stations fs ON fs.id = f.station_id
        JOIN trip_stop l ON l.trip_id = d.trip_id AND l.seq = b.s1
        LEFT JOIN stations ls ON ls.id = l.station_id
    `).all(date);

    const byTrain = new Map();
    for (const r of rows) {
        const leg = {
            category: r.category,
            from: r.from_name || null,
            to: r.to_name || null,
            departs: r.first_depart || r.first_arrive || null,
            arrives: r.last_arrive || r.last_depart || null,
            firstTime: r.first_depart || r.first_arrive || null,
            stops: r.n,
        };
        if (!byTrain.has(r.train_number)) byTrain.set(r.train_number, []);
        byTrain.get(r.train_number).push(leg);
    }

    const trains = [];
    for (const [trainNumber, legs] of byTrain) {
        legs.sort((a, b) => startMin(a) - startMin(b));

        // Midnight crossings over departure → arrival of every chained leg.
        let day = 0;
        let prev = null;
        for (const leg of legs) {
            for (const t of [leg.departs, leg.arrives]) {
                const m = toMin(t);
                if (m == null) continue;
                if (prev != null && m < prev) day += 1;
                prev = m;
            }
        }

        trains.push({
            trainNumber,
            categories: [...new Set(legs.map((l) => l.category))],
            from: legs[0].from,
            to: legs[legs.length - 1].to,
            departs: legs[0].departs,
            arrives: legs[legs.length - 1].arrives,
            arrivesDay: day,
            stops: legs.reduce((sum, l) => sum + l.stops, 0),
            legs: legs.length,
        });
    }

    trains.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, undefined, { numeric: true }));
    return trains;
}

// ── One train on one date ────────────────────────────────────────────────────

const UNMAPPED = null;

/**
 * Full stop list of `trainNo` on `date`, one entry per chained leg. Stops the
 * crosswalk could not map to a station are KEPT (name null, mapped:false):
 * hiding them would make the admin view look cleaner than the data really is.
 *
 * @returns {{trainNumber:string,date:string,legs:object[]}|null} null when the
 *          train does not run that day.
 */
function getTrainOn(trainNo, date) {
    const c = conn();
    const trips = c.prepare(`
        SELECT t.trip_id, t.category
        FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
        WHERE t.train_number = ? AND td.date = ?
    `).all(String(trainNo), date);
    if (!trips.length) return null;

    const stopStmt = c.prepare(`
        SELECT ts.seq, ts.arrive, ts.depart, ts.station_id, st.name AS station
        FROM trip_stop ts LEFT JOIN stations st ON st.id = ts.station_id
        WHERE ts.trip_id = ? ORDER BY ts.seq
    `);

    const legs = trips
        .map((t) => {
            const stops = stopStmt.all(t.trip_id);
            const first = stops[0];
            return {
                tripId: t.trip_id,
                category: t.category,
                firstTime: first ? (first.depart || first.arrive) : null,
                rawStops: stops,
            };
        })
        .filter((l) => l.rawStops.length > 0)
        .sort((a, b) => startMin(a) - startMin(b));

    const state = { day: 0, prev: null };
    const out = legs.map((l) => ({
        tripId: l.tripId,
        category: l.category,
        stops: withDayOffsets(
            l.rawStops.map((s) => ({
                seq: s.seq,
                station: s.station || UNMAPPED,
                mapped: s.station_id != null && !!s.station,
                arrive: s.arrive || null,
                depart: s.depart || null,
            })),
            state,
        ),
    }));

    return { trainNumber: String(trainNo), date, legs: out };
}

// ── Dashboard numbers that come from the database ────────────────────────────

/**
 * Everything the overview needs that lives in SQLite. Realtime cache state and
 * live-tracking counters come from their own modules (see the controller).
 */
function overview() {
    const c = conn();
    const today = sofiaToday();
    const one = (sql, ...args) => c.prepare(sql).get(...args);

    const tripsTotal  = one('SELECT COUNT(*) AS n FROM trip').n;
    const trainsTotal = one('SELECT COUNT(DISTINCT train_number) AS n FROM trip').n;
    const range = dateRange();
    const imp = one(`SELECT feed_version, feed_start, feed_end, imported_at, status
                     FROM gtfs_import ORDER BY id DESC LIMIT 1`) || null;
    const trainsToday = one(`
        SELECT COUNT(DISTINCT t.train_number) AS n
        FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
        WHERE td.date = ?`, today).n;

    const ideas = Object.fromEntries(
        c.prepare(`SELECT status, COUNT(*) AS n FROM handbook_topics
                   WHERE category = 'travel_idea' GROUP BY status`).all().map((r) => [r.status, r.n]),
    );

    const delay = one(`SELECT COUNT(DISTINCT train_number) AS n, AVG(delay_seconds) AS avg
                       FROM delay_history WHERE date = ?`, today);

    return {
        // Trains = GTFS distinct numbers once the schedule is loaded; the legacy
        // table only stands in when GTFS has not been imported yet.
        trains: tripsTotal > 0 ? trainsTotal : one('SELECT COUNT(*) AS n FROM trains').n,
        stations: one('SELECT COUNT(*) AS n FROM stations').n,
        guideTopics: one(`SELECT COUNT(*) AS n FROM handbook_topics WHERE category = 'guide'`).n,
        gtfs: {
            hasData: tripsTotal > 0,
            tripsTotal,
            trainsTotal,
            from: range ? range.from : null,
            to: range ? range.to : null,
            // Whole days from today to the last covered day (negative = expired).
            daysLeft: range ? dayNumber(range.to) - dayNumber(today) : null,
            feedVersion: imp ? imp.feed_version : null,
            importedAt: imp ? imp.imported_at : null,
            importStatus: imp ? imp.status : null,
        },
        today: { date: today, trains: trainsToday },
        content: {
            ideasPublished: ideas.published || 0,
            ideasDraft: ideas.draft || 0,
        },
        // Only claim a delay figure when there is an observation behind it.
        delays: delay.n > 0
            ? { trainsObserved: delay.n, avgDelayMin: Math.round(delay.avg / 60) }
            : null,
    };
}

module.exports = {
    isValidYmd, sofiaToday, dateRange, defaultDate,
    listTrainsOn, getTrainOn, overview,
};
