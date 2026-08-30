#!/usr/bin/env node
'use strict';

/**
 * scripts/fix-station-coord.js — correct one station's `stations` DB row to
 * match its stations.json coordinate (the source already confirmed correct
 * against a real map, for the Подуяне incident and in general — see
 * reconcile-coords.js's own header: stations.json came from a one-time OSM
 * import, generally trustworthy except for a handful of known geocode errors).
 *
 * Deliberately narrow and explicit — one named station per run, report-only
 * by default, same safety pattern as reconcile-coords.js.
 *
 * Usage:
 *   node scripts/fix-station-coord.js "Подуяне Пътническа"            # report only
 *   node scripts/fix-station-coord.js "Подуяне Пътническа" --apply    # write it
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const stationsJson = require('../stations.json');

const name = process.argv[2];
const apply = process.argv.includes('--apply');

if (!name) {
    console.error('Usage: node scripts/fix-station-coord.js "<station name>" [--apply]');
    process.exit(1);
}

const db = new Database(DB_PATH, { fileMustExist: true });

const current = db.prepare('SELECT id, name, lat, lon FROM stations WHERE name = ?').get(name);
if (!current) {
    console.error(`No station named "${name}" in the DB.`);
    process.exit(1);
}

const correct = stationsJson.find(s => s.name === name);
if (!correct || correct.lat == null || correct.lon == null) {
    console.error(`No coordinate for "${name}" in stations.json — nothing to correct against.`);
    process.exit(1);
}

console.log(`${name} (id=${current.id})`);
console.log(`  current DB coord     : ${current.lat}, ${current.lon}`);
console.log(`  stations.json coord  : ${correct.lat}, ${correct.lon}`);

if (current.lat === correct.lat && current.lon === correct.lon) {
    console.log('  already matches — nothing to do.');
    process.exit(0);
}

if (!apply) {
    console.log('\n(report only — re-run with --apply to write this change)');
    process.exit(0);
}

db.prepare('UPDATE stations SET lat = ?, lon = ? WHERE id = ?').run(correct.lat, correct.lon, current.id);
console.log(`\nAPPLIED — id=${current.id} now points at stations.json's coordinate.`);
console.log('The app will pick this up on its next GET /api/stations refresh (ETag/version changes automatically).');
