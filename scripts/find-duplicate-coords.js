#!/usr/bin/env node
'use strict';

/**
 * scripts/find-duplicate-coords.js — read-only. Lists every pair (or group)
 * of stations that share the EXACT same lat/lon in the `stations` DB table.
 *
 * Triggered by finding "Подуяне Пътническа" and "Подуяне Разпр.ср.р." sharing
 * an identical coordinate — two real, distinct stations ~1km apart that
 * should never have the same point. Not explained by reconcile-coords.js
 * (its 'manual' crosswalk method is deliberately excluded from auto-
 * correction, per its own comment), so likely a direct data-entry error —
 * this checks whether it's an isolated incident or a wider pattern.
 *
 * Usage: node scripts/find-duplicate-coords.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const groups = db.prepare(`
    SELECT lat, lon, COUNT(*) AS n, GROUP_CONCAT(id || ':' || name, ' | ') AS members
    FROM stations
    WHERE lat IS NOT NULL AND lon IS NOT NULL
    GROUP BY lat, lon
    HAVING COUNT(*) > 1
    ORDER BY n DESC
`).all();

if (!groups.length) {
    console.log('No duplicate coordinates found — the Подуяне pair was an isolated incident.');
} else {
    console.log(`${groups.length} coordinate(s) shared by more than one station:\n`);
    for (const g of groups) {
        console.log(`[${g.lat}, ${g.lon}] shared by ${g.n} stations: ${g.members}`);
    }
}
