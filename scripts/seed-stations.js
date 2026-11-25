'use strict';

/**
 * seed-stations.js — load the canonical station list (stations.json) into a database.
 *
 *   node scripts/seed-stations.js [db.sqlite]      (default: $BULTRAIN_DB, else ./bultrain.sqlite)
 *
 * For a new checkout: the GTFS import maps the feed's stops onto OUR stations, so they have to be
 * there first. Migrates the database, then adds every station that is missing.
 *
 * Safe on a live database, and idempotent: it only ADDS stations whose id is not there yet and never
 * touches an existing row — a station's id is what saved alarms are keyed to, and its coordinates may
 * since have been corrected from the feed (reconcile-coords.js), which a re-seed must not undo.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(process.argv[2] || process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite'));
require('../database/migrate')(dbPath);

const stations = require('../stations.json');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const insert = db.prepare('INSERT OR IGNORE INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
const before = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n;
db.transaction((rows) => { for (const s of rows) insert.run(s.id, s.name, s.englishName ?? null, s.lat ?? null, s.lon ?? null); })(stations);
const after = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n;
db.close();

console.log(`stations: ${before} → ${after} (+${after - before}) in ${dbPath}`);
