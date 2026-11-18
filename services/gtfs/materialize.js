'use strict';

/**
 * materialize.js — build the date-based serving tables from the raw GTFS
 * tables + the station crosswalk.
 *
 * For every GTFS trip:
 *   - category from its route (see categoryOf; "A" = replacement bus → АВТ)
 *   - stops from stop_times, stop_id translated to our station_id via
 *     station_map, times to HH:MM, and CONSECUTIVE duplicate station_ids
 *     collapsed (GTFS models some stations as two adjacent points)
 *   - run dates from calendar_dates (exception_type 1 = added)
 *
 * Truncate + rebuild trip / trip_date / trip_stop in ONE transaction, so
 * readers never see a half-built schedule. Touches nothing else.
 *
 * Usage:  node services/gtfs/materialize.js [db.sqlite]
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DEFAULT_DB = path.join(__dirname, '..', '..', 'bultrain.sqlite');

// GTFS category code → our category code.
const ROUTE_CATEGORY = { PV: 'ПВ', BV: 'БВ', KPV: 'КПВ', MBV: 'МБВ', EV: 'ЕВ', A: 'АВТ' };

// More trips than this share with a category we could not read and the feed is
// refused: the previous schedule keeps serving rather than a wrong one replacing it.
const MAX_UNKNOWN_CATEGORY_SHARE = 0.02;

/**
 * Our category for a GTFS route, or null when it cannot be told.
 *
 * The feed has been published in two shapes:
 *   - until 2026-11-16: five routes, one per category; route_short_name IS the code ("PV");
 *   - from 2026-11-17: one route per TRAIN; route_short_name is the train number and the
 *     code sits in the route_id, "<operator>-<code>_<number>" ("BDZ-PV_30121",
 *     "IVKONI-KPV_19201").
 * Taking route_short_name on trust in the second shape stored the train number as the
 * category (every train showed up as "30121 30121").
 */
function categoryOf(route) {
    const direct = ROUTE_CATEGORY[route.route_short_name];
    if (direct) return direct;
    const m = /-([A-Z]+)_[^_]*$/.exec(String(route.route_id || ''));
    return (m && ROUTE_CATEGORY[m[1]]) || null;
}

// GTFS HH:MM:SS (may exceed 24) → HH:MM, 24h clock.
function hm(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return String(h % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function ymd(compact) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function materialize(dbPath = DEFAULT_DB) {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    const catByRoute = new Map(
        db.prepare('SELECT route_id, route_short_name FROM gtfs_routes').all()
          .map(r => [r.route_id, categoryOf(r)])
    );
    const stationOf = new Map(
        db.prepare('SELECT gtfs_stop_id, station_id FROM station_map').all()
          .map(r => [r.gtfs_stop_id, r.station_id])
    );

    const trips = db.prepare('SELECT trip_id, route_id, service_id, trip_short_name FROM gtfs_trips').all();
    const stopTimesStmt = db.prepare(
        'SELECT stop_id, arrival_time, departure_time, stop_sequence FROM gtfs_stop_times WHERE trip_id = ? ORDER BY stop_sequence'
    );
    const datesStmt = db.prepare(
        'SELECT date FROM gtfs_calendar_dates WHERE service_id = ? AND exception_type = 1'
    );

    const insTrip = db.prepare('INSERT INTO trip (trip_id, train_number, category, service_start, service_end) VALUES (?, ?, ?, ?, ?)');
    const insDate = db.prepare('INSERT INTO trip_date (trip_id, date) VALUES (?, ?)');
    const insStop = db.prepare('INSERT INTO trip_stop (trip_id, seq, station_id, arrive, depart) VALUES (?, ?, ?, ?, ?)');

    let nTrips = 0, nStops = 0, nDates = 0, unmapped = 0;
    const unknownRoutes = new Set();   // route_ids whose category could not be read
    let nUnknown = 0;

    const build = db.transaction(() => {
        db.prepare('DELETE FROM trip_stop').run();
        db.prepare('DELETE FROM trip_date').run();
        db.prepare('DELETE FROM trip').run();

        for (const t of trips) {
            const category = catByRoute.get(t.route_id) || '??';
            if (category === '??') { nUnknown++; unknownRoutes.add(t.route_id); }

            // Translate + collapse consecutive duplicate stations.
            const raw = stopTimesStmt.all(t.trip_id);
            const stops = [];
            for (const s of raw) {
                const stationId = stationOf.has(s.stop_id) ? stationOf.get(s.stop_id) : null;
                if (stationId == null) unmapped++;
                const prev = stops[stops.length - 1];
                if (prev && prev.station_id === stationId && stationId != null) {
                    // same station, second point: keep earliest arrival, latest departure
                    prev.depart = hm(s.departure_time) || prev.depart;
                    continue;
                }
                stops.push({ station_id: stationId, arrive: hm(s.arrival_time), depart: hm(s.departure_time) });
            }
            if (stops.length === 0) continue;

            // service_id encodes the window as {num}-{cat}-{start}-{end}
            const parts = String(t.service_id).split('-');
            const start = parts.length >= 2 ? ymd(parts[parts.length - 2]) : null;
            const end   = parts.length >= 1 ? ymd(parts[parts.length - 1]) : null;

            insTrip.run(t.trip_id, t.trip_short_name, category, start, end);
            nTrips++;

            stops.forEach((s, i) => { insStop.run(t.trip_id, i + 1, s.station_id, s.arrive, s.depart); nStops++; });

            for (const d of datesStmt.all(t.service_id)) { insDate.run(t.trip_id, ymd(d.date)); nDates++; }
        }

        // Thrown inside the transaction: it rolls back and the schedule that was serving stays.
        if (nTrips > 0 && nUnknown / nTrips > MAX_UNKNOWN_CATEGORY_SHARE) {
            throw new Error(`${nUnknown} of ${nTrips} trips have a route whose category cannot be read ` +
                `(e.g. ${[...unknownRoutes].slice(0, 3).join(', ')}) — the feed's routes.txt probably changed shape; ` +
                'the previous schedule is kept');
        }
    });

    try {
        build();
    } finally {
        db.close();
    }
    return { nTrips, nStops, nDates, unmapped, nUnknown, unknownRoutes: [...unknownRoutes] };
}

if (require.main === module) {
    const dbPath = process.argv[2] || DEFAULT_DB;
    let r;
    try {
        r = materialize(dbPath);
    } catch (err) {
        console.error(`materialize FAILED: ${err.message}`);
        process.exit(1);
    }
    console.log(`materialised: ${r.nTrips} trips, ${r.nStops} stops, ${r.nDates} run-dates` +
        (r.unmapped ? `  (${r.unmapped} stop-times hit an unmapped stop)` : ''));
    if (r.nUnknown) {
        console.warn(`WARNING: ${r.nUnknown} trips have an unreadable category (stored as '??'): ${r.unknownRoutes.slice(0, 10).join(', ')}`);
    }
}

module.exports = { materialize, categoryOf };
