'use strict';

/**
 * fix_arrow_times.js
 *
 * Repairs stop times stored as literal arrows instead of NULL.
 *
 * The admin panel's single-train import used to write the payload's ↦ / ↤
 * markers straight into the schedules table. routeWorker reads a falsy time as
 * "cannot board/alight here", so an arrow — being truthy — makes an origin look
 * like a stop you can get off at, and feeds NaN into the transfer-window check
 * via timeToMin().
 *
 * Idempotent: running it twice reports 0 the second time.
 *
 * Usage:  node database/fix_arrow_times.js
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const ARROWS  = ['↦', '↤'];

const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma('foreign_keys = ON');

const before = db.prepare(`
    SELECT s.schedule_id, tv.train_number, st.name AS station,
           s.arrival_time, s.departure_time, s.stop_sequence
    FROM   schedules      s
    JOIN   train_validity tv ON tv.validity_id = s.validity_id
    JOIN   stations       st ON st.id          = s.station_id
    WHERE  s.arrival_time IN (?, ?) OR s.departure_time IN (?, ?)
    ORDER  BY tv.train_number, s.stop_sequence
`).all(...ARROWS, ...ARROWS);

if (before.length === 0) {
    console.log('No arrow-valued stop times found — nothing to do.');
    db.close();
    process.exit(0);
}

console.log(`Found ${before.length} row(s) to repair:\n`);
for (const r of before) {
    console.log(
        `  #${r.schedule_id}  train ${r.train_number}  seq ${r.stop_sequence}  ` +
        `${r.station}  arrive=${r.arrival_time}  depart=${r.departure_time}`
    );
}

const repair = db.transaction(() => {
    const a = db.prepare('UPDATE schedules SET arrival_time   = NULL WHERE arrival_time   IN (?, ?)').run(...ARROWS);
    const d = db.prepare('UPDATE schedules SET departure_time = NULL WHERE departure_time IN (?, ?)').run(...ARROWS);
    return a.changes + d.changes;
});

const changed = repair();

const remaining = db.prepare(
    'SELECT COUNT(*) AS c FROM schedules WHERE arrival_time IN (?, ?) OR departure_time IN (?, ?)'
).get(...ARROWS, ...ARROWS).c;

db.close();

console.log(`\nRepaired ${changed} column value(s). Remaining arrows: ${remaining}.`);
if (remaining !== 0) {
    console.error('Expected 0 remaining — please investigate.');
    process.exit(1);
}
