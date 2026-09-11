'use strict';

/**
 * scripts/inspect-international-trains.js — how big is the "through train,
 * not domestically bookable" problem, really?
 *
 * Triggered by a real report: train 13154 (GTFS category "МБВ") runs
 * Kapikule (Turkey) -> ... -> Tsaribrod (Serbia), touching real Bulgarian
 * stations along the way, and is offered as an ordinary schedule option
 * between Plovdiv and Sofia even though it does not sell domestic tickets.
 *
 * Three of our own `stations` rows are already manually annotated as
 * foreign, in english_name: "Golenti (Romania)", "Giurgiu Nord (Romania)",
 * "Kapikule (Turkey)" — someone tagged these deliberately, at some point,
 * for GTFS trip continuity. "Цариброд" (Tsaribrod / Dimitrovgrad, Serbia)
 * is NOT tagged, despite being just as foreign — this script also surfaces
 * any other untagged station that only ever appears as a trip'S FIRST or
 * LAST stop, which is the pattern a border-crossing point produces.
 *
 * Read-only. Safe to run against the live production database.
 *
 * Usage:  node scripts/inspect-international-trains.js [db.sqlite]
 */

const path     = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

console.log('=== Every category in `trip`, with how many distinct train numbers ===');
console.log(db.prepare(`
    SELECT category, COUNT(DISTINCT train_number) AS n_trains, COUNT(*) AS n_trips
    FROM trip GROUP BY category ORDER BY n_trains DESC
`).all());

console.log('\n=== Every МБВ train: first and last stop of each of its trips ===');
const mbvTrips = db.prepare("SELECT trip_id, train_number FROM trip WHERE category = 'МБВ'").all();
for (const t of mbvTrips) {
    const stops = db.prepare(`
        SELECT st.name FROM trip_stop ts JOIN stations st ON st.id = ts.station_id
        WHERE ts.trip_id = ? ORDER BY ts.seq
    `).all(t.trip_id);
    if (!stops.length) continue;
    console.log(`  ${t.train_number} (trip_id=${t.trip_id}): ${stops[0].name} -> ... -> ${stops[stops.length - 1].name}  (${stops.length} stops)`);
}

console.log('\n=== Already-tagged foreign stations (english_name contains "(") ===');
const taggedForeign = db.prepare("SELECT id, name, english_name FROM stations WHERE english_name LIKE '%(%'").all();
console.log(taggedForeign);

console.log('\n=== Stations that ONLY ever appear as a trip\'s very first or very last stop ===');
console.log('(the pattern a border-crossing endpoint produces — a real domestic station is normally passed through, not always at the edge)');
const stationStats = db.prepare(`
    WITH ends AS (
        SELECT ts.trip_id,
               (SELECT station_id FROM trip_stop WHERE trip_id = ts.trip_id ORDER BY seq ASC LIMIT 1)  AS first_station,
               (SELECT station_id FROM trip_stop WHERE trip_id = ts.trip_id ORDER BY seq DESC LIMIT 1) AS last_station
        FROM trip_stop ts GROUP BY ts.trip_id
    )
    SELECT st.id, st.name, st.english_name,
           COUNT(DISTINCT tsAll.trip_id) AS n_trips_visited,
           SUM(CASE WHEN e.first_station = st.id OR e.last_station = st.id THEN 1 ELSE 0 END) AS n_trips_as_endpoint
    FROM trip_stop tsAll
    JOIN stations st ON st.id = tsAll.station_id
    JOIN ends e ON e.trip_id = tsAll.trip_id
    GROUP BY st.id
    HAVING n_trips_visited = n_trips_as_endpoint
    ORDER BY n_trips_visited DESC
`).all();
console.log(stationStats);

db.close();
