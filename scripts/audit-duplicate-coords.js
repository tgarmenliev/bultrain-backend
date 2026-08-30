#!/usr/bin/env node
'use strict';

/**
 * scripts/audit-duplicate-coords.js — read-only. For every group of stations
 * sharing an identical DB coordinate (see find-duplicate-coords.js), shows
 * each member's stations.json coordinate too — so it's obvious at a glance
 * which ones stations.json can actually FIX (it has a distinct, real value)
 * versus which are still genuinely unresolved even there (stations.json
 * itself has nothing better — usually the expected halt/parent-station
 * placeholder pattern, not urgent).
 *
 * Usage: node scripts/audit-duplicate-coords.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const stationsJson = require('../stations.json');
const byName = new Map(stationsJson.map(s => [s.name, s]));

const groups = db.prepare(`
    SELECT lat, lon FROM stations
    WHERE lat IS NOT NULL AND lon IS NOT NULL
    GROUP BY lat, lon HAVING COUNT(*) > 1
`).all();

for (const g of groups) {
    const members = db.prepare('SELECT id, name FROM stations WHERE lat = ? AND lon = ?').all(g.lat, g.lon);
    console.log(`\n[${g.lat}, ${g.lon}] shared by ${members.length}:`);
    let anyFixable = false;
    for (const m of members) {
        const j = byName.get(m.name);
        if (!j || j.lat == null) {
            console.log(`  ${m.id}:${m.name} — not in stations.json, nothing to fix against`);
            continue;
        }
        const matches = j.lat === g.lat && j.lon === g.lon;
        console.log(`  ${m.id}:${m.name} — stations.json: ${j.lat}, ${j.lon}` +
            (matches ? '  (same — unresolved there too, not urgent)' : '  ⚠ DIFFERENT — this one is fixable'));
        if (!matches) anyFixable = true;
    }
    if (anyFixable) {
        console.log('  -> run:  ' + members.map(m => `node scripts/fix-station-coord.js "${m.name}"`).join('  /  '));
    }
}
