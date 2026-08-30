#!/usr/bin/env node
'use strict';

/**
 * scripts/check-station-coords.js — read-only. Compares stations.json (what
 * reconcile-coords.js treats as the historical/OSM coordinate, and what
 * stationCoords.js prefers for Live Activity distance) against the `stations`
 * DB table (what GET /api/stations actually serves to the app for its own
 * arrival-geofence alarm) for named stations, plus which GTFS stop each one
 * is crosswalked to and why reconcile-coords.js moved it (if it did).
 *
 * Triggered by: repeated false arrival alarms travelling Антон/Пирдоп→София.
 *
 * Usage: node scripts/check-station-coords.js "София" "Подуяне Пътническа" "Подуяне Разпр.ср.р."
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const stationsJson = require('../stations.json');

function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (c - a) * r, dLon = (d - b) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const names = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['София', 'Подуяне Пътническа', 'Подуяне Разпр.ср.р.'];

for (const name of names) {
    console.log(`\n═══ ${name} ═══`);

    const j = stationsJson.find(s => s.name === name);
    const d = db.prepare('SELECT id, name, lat, lon FROM stations WHERE name = ?').get(name);

    console.log('stations.json :', j ? `id=${j.id} lat=${j.lat} lon=${j.lon}` : '(not found)');
    console.log('DB stations   :', d ? `id=${d.id} lat=${d.lat} lon=${d.lon}` : '(not found)');

    if (j && d && j.lat != null && d.lat != null) {
        const km = haversine(j.lat, j.lon, d.lat, d.lon);
        console.log(`  -> drift between the two sources: ${km.toFixed(2)} km` + (km > 1 ? '  ⚠ SUSPECT' : ''));
    }

    if (d) {
        const crosswalk = db.prepare(`
            SELECT sm.gtfs_stop_id, sm.method, g.stop_name, g.stop_lat, g.stop_lon
            FROM station_map sm LEFT JOIN gtfs_stops g ON g.stop_id = sm.gtfs_stop_id
            WHERE sm.station_id = ?
        `).all(d.id);
        if (!crosswalk.length) {
            console.log('  crosswalk: (no station_map row — reconcile-coords.js has nothing to match against)');
        } else {
            for (const c of crosswalk) {
                console.log(`  crosswalk -> gtfs_stop_id=${c.gtfs_stop_id} method=${c.method} name="${c.stop_name}" lat=${c.stop_lat} lon=${c.stop_lon}`);
                if (c.stop_lat != null && d.lat != null) {
                    console.log(`    DB coord vs THIS gtfs stop: ${haversine(d.lat, d.lon, c.stop_lat, c.stop_lon).toFixed(2)} km`);
                }
            }
        }
    }
}

console.log('\nIf "DB stations" differs from "stations.json" by more than ~1km for София, that is what');
console.log('GET /api/stations is currently serving the app for its OWN arrival-geofence alarm.');
