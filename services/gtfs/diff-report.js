'use strict';

/**
 * diff-report.js — the go/no-go gate.
 *
 * For a given date, resolve the schedule two ways and compare:
 *   GTFS  — services active that date (calendar_dates) → trips → stop_times,
 *           stop_id translated to our station_id via station_map.
 *   Current — the day-of-week validity the app serves today (runs_<dow>,
 *           temporary window preferred over general), joined to schedules.
 *
 * Compares per train number: does it run that day in each source, and for
 * trains in both, do the stop sequences and times agree? This also prototypes
 * the date-based resolution the new serving model would use.
 *
 * Usage:  node services/gtfs/diff-report.js <YYYY-MM-DD> [db.sqlite]
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DEFAULT_DB = path.join(__dirname, '..', '..', 'bultrain.sqlite');

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// GTFS HH:MM:SS (may exceed 24) → HH:MM in 24h clock, for comparison.
function hm(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return String(h % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function gtfsForDate(db, ymd) {
    const compact = ymd.replace(/-/g, '');
    const trips = db.prepare(`
        SELECT t.trip_id, t.trip_short_name
        FROM gtfs_trips t
        WHERE t.service_id IN (
            SELECT service_id FROM gtfs_calendar_dates WHERE date = ? AND exception_type = 1
        )
    `).all(compact);

    const stopsStmt = db.prepare(`
        SELECT sm.station_id, st.arrival_time, st.departure_time, st.stop_sequence
        FROM gtfs_stop_times st
        LEFT JOIN station_map sm ON sm.gtfs_stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY st.stop_sequence
    `);

    const byTrain = new Map();
    for (const t of trips) {
        const stops = stopsStmt.all(t.trip_id).map(s => ({
            station_id: s.station_id,           // null if stop unmapped
            arr: hm(s.arrival_time),
            dep: hm(s.departure_time),
        }));
        // A train number can appear as multiple trips (date-range variants);
        // for a single date they resolve to the same run. Keep the first.
        if (!byTrain.has(t.trip_short_name)) byTrain.set(t.trip_short_name, stops);
    }
    return byTrain;
}

function currentForDate(db, ymd) {
    const dow = DOW[new Date(ymd + 'T00:00:00').getDay()];
    const col = `runs_${dow}`;

    // Per train: prefer a temporary validity whose window covers the date,
    // else the general (NULL window) one — mirrors routeWorker.loadDayData.
    const rows = db.prepare(`
        WITH ranked AS (
            SELECT tv.validity_id, tv.train_number,
                   CASE WHEN tv.valid_from IS NOT NULL AND tv.valid_to IS NOT NULL
                             AND tv.valid_from <= ? AND tv.valid_to >= ? THEN 1
                        WHEN tv.valid_from IS NULL AND tv.valid_to IS NULL THEN 2
                        ELSE NULL END AS pri
            FROM train_validity tv
            WHERE tv.${col} = 1
        ),
        best AS (SELECT train_number, MIN(pri) pri FROM ranked WHERE pri IS NOT NULL GROUP BY train_number)
        SELECT r.train_number, s.station_id, s.arrival_time, s.departure_time, s.stop_sequence
        FROM ranked r
        JOIN best b ON b.train_number = r.train_number AND b.pri = r.pri
        JOIN schedules s ON s.validity_id = r.validity_id
        ORDER BY r.train_number, s.stop_sequence
    `).all(ymd, ymd);

    const byTrain = new Map();
    for (const r of rows) {
        if (!byTrain.has(r.train_number)) byTrain.set(r.train_number, []);
        byTrain.get(r.train_number).push({
            station_id: r.station_id,
            arr: r.arrival_time,
            dep: r.departure_time,
        });
    }
    return byTrain;
}

function seqKey(stops) {
    return stops.map(s => s.station_id ?? 'X').join('>');
}

function run(ymd, dbPath = DEFAULT_DB) {
    const db = new Database(dbPath, { readonly: true });
    const gtfs = gtfsForDate(db, ymd);
    const cur  = currentForDate(db, ymd);
    db.close();

    const gTrains = new Set(gtfs.keys());
    const cTrains = new Set(cur.keys());
    const onlyG = [...gTrains].filter(t => !cTrains.has(t));
    const onlyC = [...cTrains].filter(t => !gTrains.has(t));
    const both  = [...gTrains].filter(t => cTrains.has(t));

    let sameSeq = 0, diffSeq = 0, sameTimes = 0, diffTimes = 0;
    const seqSamples = [], timeSamples = [];
    let unmappedStopHits = 0;

    for (const t of both) {
        const g = gtfs.get(t), c = cur.get(t);
        if (g.some(s => s.station_id == null)) unmappedStopHits++;

        if (seqKey(g) === seqKey(c)) {
            sameSeq++;
            // Compare times where both sides have them (skip endpoint NULLs).
            let differs = false;
            for (let i = 0; i < g.length; i++) {
                const a = g[i], b = c[i];
                if (a.arr && b.arr && a.arr !== b.arr) differs = true;
                if (a.dep && b.dep && a.dep !== b.dep) differs = true;
            }
            if (differs) { diffTimes++; if (timeSamples.length < 8) timeSamples.push(t); }
            else sameTimes++;
        } else {
            diffSeq++;
            if (seqSamples.length < 8) seqSamples.push({ t, g: g.length, c: c.length });
        }
    }

    console.log(`══ DIFF for ${ymd} (${DOW[new Date(ymd + 'T00:00:00').getDay()]}) ══\n`);
    console.log(`trains running that day:  GTFS ${gTrains.size}   current ${cTrains.size}   in both ${both.length}`);
    console.log(`  only in GTFS (new):     ${onlyG.length}${onlyG.length ? '  ' + onlyG.slice(0, 12).join(', ') + (onlyG.length > 12 ? ' …' : '') : ''}`);
    console.log(`  only in current:        ${onlyC.length}${onlyC.length ? '  ' + onlyC.slice(0, 12).join(', ') + (onlyC.length > 12 ? ' …' : '') : ''}`);
    console.log('');
    console.log(`among the ${both.length} in both:`);
    console.log(`  identical stop sequence: ${sameSeq}`);
    console.log(`     ├ identical times:    ${sameTimes}`);
    console.log(`     └ times differ:       ${diffTimes}${timeSamples.length ? '  e.g. ' + timeSamples.join(', ') : ''}`);
    console.log(`  different stop sequence: ${diffSeq}${seqSamples.length ? '  e.g. ' + seqSamples.map(s => `${s.t}(G${s.g}/C${s.c})`).join(', ') : ''}`);
    console.log(`  touch an unmapped stop:  ${unmappedStopHits}`);
}

if (require.main === module) {
    const ymd = process.argv[2];
    const dbPath = process.argv[3] || DEFAULT_DB;
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
        console.error('usage: node services/gtfs/diff-report.js <YYYY-MM-DD> [db.sqlite]');
        process.exit(1);
    }
    run(ymd, dbPath);
}

module.exports = { run, gtfsForDate, currentForDate };
