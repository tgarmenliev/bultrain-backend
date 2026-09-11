'use strict';

/**
 * scripts/inspect-train-source.js — dump everything the GTFS feed and our own
 * materialized tables know about one train number, to answer a specific
 * question: is there ANY field in NAP's feed that distinguishes a real BDZ
 * domestic train from an international/private one (like Optima Express) that
 * merely transits Bulgarian track without taking on passengers here?
 *
 * Read-only. Safe to run against the live production database.
 *
 * Usage:  node scripts/inspect-train-source.js <trainNumber> [db.sqlite]
 */

const path     = require('path');
const Database = require('better-sqlite3');

const trainNumber = process.argv[2];
const dbPath = process.argv[3] || path.join(__dirname, '..', 'bultrain.sqlite');

if (!trainNumber) {
    console.error('Usage: node scripts/inspect-train-source.js <trainNumber> [db.sqlite]');
    process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

console.log(`\n=== gtfs_trips for trip_short_name = "${trainNumber}" ===`);
const trips = db.prepare('SELECT * FROM gtfs_trips WHERE trip_short_name = ?').all(trainNumber);
console.log(trips);

if (!trips.length) {
    console.log('(none — checking materialized `trip` table instead)');
} else {
    for (const t of trips) {
        console.log(`\n--- trip_id=${t.trip_id} route_id=${t.route_id} service_id=${t.service_id} ---`);

        const route = db.prepare('SELECT * FROM gtfs_routes WHERE route_id = ?').get(t.route_id);
        console.log('gtfs_routes row:', route);

        if (route) {
            const agency = db.prepare('SELECT * FROM gtfs_agency WHERE agency_id = ?').get(route.agency_id);
            console.log('gtfs_agency row:', agency);
        }

        const stopTimes = db.prepare(
            'SELECT stop_id, arrival_time, departure_time, stop_sequence FROM gtfs_stop_times WHERE trip_id = ? ORDER BY stop_sequence'
        ).all(t.trip_id);
        console.log(`stop_times: ${stopTimes.length} rows`);
        console.log(stopTimes.map(s => `${s.stop_sequence}: ${s.stop_id} arr=${s.arrival_time} dep=${s.departure_time}`).join('\n'));

        const dates = db.prepare('SELECT date, exception_type FROM gtfs_calendar_dates WHERE service_id = ? ORDER BY date').all(t.service_id);
        console.log(`calendar_dates: ${dates.length} rows (first 5):`, dates.slice(0, 5));
    }
}

// How many DISTINCT agencies/route_short_names exist in the whole feed at
// all — tells us whether NAP's feed even carries per-operator information,
// or whether every trip (BDZ and anyone else) is lumped under one agency.
console.log('\n=== All agencies in the feed ===');
console.log(db.prepare('SELECT * FROM gtfs_agency').all());

console.log('\n=== Distinct route_short_name / route_type / agency_id combos ===');
console.log(db.prepare(`
    SELECT agency_id, route_short_name, route_type, COUNT(*) AS n
    FROM gtfs_routes GROUP BY agency_id, route_short_name, route_type
`).all());

console.log('\n=== Materialized trip/trip_stop rows for this train number ===');
const materialized = db.prepare('SELECT * FROM trip WHERE train_number = ?').all(trainNumber);
console.log(materialized);
for (const m of materialized) {
    const stops = db.prepare(`
        SELECT ts.seq, ts.arrive, ts.depart, st.name
        FROM trip_stop ts JOIN stations st ON st.id = ts.station_id
        WHERE ts.trip_id = ? ORDER BY ts.seq
    `).all(m.trip_id);
    console.log(`  stops for trip_id=${m.trip_id}:`, stops.map(s => `${s.name} (${s.arrive}-${s.depart})`).join(' -> '));
}

db.close();
