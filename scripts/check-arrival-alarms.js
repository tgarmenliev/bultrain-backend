#!/usr/bin/env node
'use strict';

/**
 * scripts/check-arrival-alarms.js — read-only. Lists recent armed_journeys
 * rows (the server-side record of "track/arm this journey") matching a
 * boarding/destination substring, so a specific reported route (e.g. false
 * arrival alarms travelling Антон/Пирдоп -> София) can be inspected directly
 * — which train, which exact station names were stored, and how the leg
 * actually ended (arrived / stopped / why).
 *
 * Usage:
 *   node scripts/check-arrival-alarms.js "офия"          # destination filter only
 *   node scripts/check-arrival-alarms.js "офия" "нтон"    # + boarding filter
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const [destPart, boardPart] = process.argv.slice(2);
if (!destPart) {
    console.error('Usage: node scripts/check-arrival-alarms.js <destination substring> [boarding substring]');
    process.exit(1);
}

const rows = db.prepare(`
    SELECT id, install_id, journey_id, leg_index, train_number,
           boarding_station, destination_station,
           scheduled_departure, scheduled_arrival,
           state, started_at, arrived_at, stopped_at, stopped_reason
    FROM armed_journeys
    WHERE destination_station LIKE ?
      ${boardPart ? 'AND boarding_station LIKE ?' : ''}
    ORDER BY id DESC LIMIT 20
`).all(...(boardPart ? [`%${destPart}%`, `%${boardPart}%`] : [`%${destPart}%`]));

console.log(`${rows.length} matching row(s):\n`);
for (const r of rows) {
    console.log(
        `#${r.id} j=${r.journey_id}/${r.leg_index} train=${r.train_number} ` +
        `${r.boarding_station} -> ${r.destination_station}\n` +
        `  sched dep=${r.scheduled_departure} arr=${r.scheduled_arrival}\n` +
        `  state=${r.state} started=${r.started_at || '—'} arrived=${r.arrived_at || '—'} ` +
        `stopped=${r.stopped_at || '—'} (${r.stopped_reason || '—'})\n`
    );
}
