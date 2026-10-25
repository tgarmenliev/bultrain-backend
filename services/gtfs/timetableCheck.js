'use strict';

/**
 * timetableCheck.js — a sanity check of the times an app sends when it arms or registers a leg
 * (scheduledDeparture / scheduledArrival) against OUR timetable.
 *
 * Why: a phone turns the timetable's wall-clock "11:09" into an instant itself. If it does so with
 * the wrong UTC offset — the day the clocks change is where that bites — every time it sends is
 * exactly an hour off, and the card then says the train has already left and counts down to an
 * arrival an hour early. The server holds the timetable and can tell, whatever the app version.
 *
 * What it does about a mismatch:
 *   - exactly one hour apart (59-61 min): that is a time-zone mistake, nothing else produces it —
 *     the app's times came from this same timetable — so the TIMETABLE's instant is used
 *   - any other difference: left alone (the app may know better), but logged
 *   - no timetable for that train/day/stops (a bus, a new train, tables not loaded): left alone
 */

const path     = require('path');
const Database = require('better-sqlite3');

const { wallToInstant } = require('../time/sofia');
const { normalizeStation } = require('../liveactivity/contentState');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const HOUR_TOLERANCE_MIN = 1;
const NOTE_FROM_MIN = 3;          // smaller differences are rounding, not worth a log line

let db = null;
const conn = () => (db || (db = new Database(DB_PATH, { readonly: true, fileMustExist: true })));

const ymdOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

/** Wall-clock minutes (from the trip's first day, after-midnight times > 1440) for every time of every stop. */
function withAbsoluteMinutes(stops) {
    let day = 0;
    let prev = null;
    return stops.map((s) => {
        const abs = (t) => {
            const m = toMin(t);
            if (m == null) return null;
            if (prev != null && m < prev) day += 1;     // materialize.js wraps past-midnight times to HH:MM
            prev = m;
            return day * 1440 + m;
        };
        return { name: s.name, arrive: abs(s.arrive), depart: abs(s.depart) };
    });
}

/**
 * The timetable's instants for a leg: when the train leaves `boardingStation` and reaches
 * `destinationStation`, on the service day nearest to `nearMs`.
 * @returns {{departureMs:number, arrivalMs:number, ymd:string}|null}
 */
function timetableTimes({ trainNumber, boardingStation, destinationStation, nearMs }) {
    if (!trainNumber || !boardingStation || !destinationStation || !Number.isFinite(nearMs)) return null;
    try {
        const c = conn();
        const tripsOn = c.prepare(`
            SELECT t.trip_id FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
            WHERE t.train_number = ? AND td.date = ?`);
        const stopsOf = c.prepare(`
            SELECT ts.arrive, ts.depart, st.name AS name
            FROM trip_stop ts LEFT JOIN stations st ON st.id = ts.station_id
            WHERE ts.trip_id = ? ORDER BY ts.seq`);

        const b = normalizeStation(boardingStation);
        const d = normalizeStation(destinationStation);
        let best = null;
        // The service day is the one the leg departs on — look a day either side of the app's
        // own idea of it, since a time-zone error can also push it across midnight.
        for (const ymd of new Set([ymdOf(nearMs - 3600000), ymdOf(nearMs), ymdOf(nearMs + 3600000)])) {
            for (const { trip_id } of tripsOn.all(String(trainNumber), ymd)) {
                const stops = withAbsoluteMinutes(stopsOf.all(trip_id));
                const bi = stops.findIndex(s => s.name && normalizeStation(s.name) === b);
                if (bi < 0) continue;
                const di = stops.findIndex((s, i) => i > bi && s.name && normalizeStation(s.name) === d);
                if (di < 0) continue;
                const dep = stops[bi].depart ?? stops[bi].arrive;
                const arr = stops[di].arrive ?? stops[di].depart;
                if (dep == null || arr == null) continue;
                const departureMs = wallToInstant(ymd, dep);
                if (!best || Math.abs(departureMs - nearMs) < Math.abs(best.departureMs - nearMs)) {
                    best = { departureMs, arrivalMs: wallToInstant(ymd, arr), ymd };
                }
            }
        }
        return best;
    } catch (err) {
        console.error('[timetable] check failed:', err.message);   // no tables: nothing to compare with
        return null;
    }
}

const isAnHour = (diffMin) => Math.abs(Math.abs(diffMin) - 60) <= HOUR_TOLERANCE_MIN;

/**
 * Compare what an app sent with the timetable.
 * @returns {{departure:Date, arrival:Date, corrected:boolean, notes:string[]}}
 */
function reconcileClientTimes({ trainNumber, boardingStation, destinationStation, departure, arrival }) {
    const out = { departure, arrival, corrected: false, notes: [] };
    const tt = timetableTimes({ trainNumber, boardingStation, destinationStation, nearMs: departure.getTime() });
    if (!tt) return out;

    const fix = (label, sent, ttMs) => {
        const diff = Math.round((sent.getTime() - ttMs) / 60000);
        if (isAnHour(diff)) {
            out.corrected = true;
            out.notes.push(`${label} ${diff > 0 ? '+' : ''}${diff} min off the timetable (a time-zone mistake): ${sent.toISOString()} -> ${new Date(ttMs).toISOString()}`);
            return new Date(ttMs);
        }
        if (Math.abs(diff) >= NOTE_FROM_MIN) {
            out.notes.push(`${label} ${diff > 0 ? '+' : ''}${diff} min from the timetable (${sent.toISOString()} vs ${new Date(ttMs).toISOString()}); left as sent`);
        }
        return sent;
    };
    out.departure = fix('departure', departure, tt.departureMs);
    out.arrival = fix('arrival', arrival, tt.arrivalMs);
    return out;
}

module.exports = { reconcileClientTimes, timetableTimes };
