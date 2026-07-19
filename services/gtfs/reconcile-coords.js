'use strict';

/**
 * reconcile-coords.js — adopt authoritative GTFS coordinates for stations whose
 * coordinate is clearly wrong.
 *
 * Our stations.json coords came from a one-time OpenStreetMap import; a handful
 * were geocoded to the wrong place (an ambiguous name) or got a placeholder.
 * GTFS coords are official, surveyed, and refreshed with each feed. Where our
 * coord sits far from the name-matched GTFS stop, GTFS wins.
 *
 * Surgical by design: only touches stations that are > THRESHOLD_KM from their
 * name-matched GTFS stop, so the 95% of already-correct coords (and multi-point
 * cities) are left untouched. Names and ids are never changed.
 *
 * Modes:
 *   (default)  report only — prints what would change
 *   --apply    write the updates (transaction)
 *   --export <file>  also write every corrected station coord as JSON, for the
 *                    app team to bundle into the alarm's own station list
 *
 * Usage:  node services/gtfs/reconcile-coords.js [db.sqlite] [--apply] [--export coords.json]
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DEFAULT_DB   = path.join(__dirname, '..', '..', 'bultrain.sqlite');
const THRESHOLD_KM = 1.0;

function norm(s) {
    return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-');
}
function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (c - a) * r, dLon = (d - b) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function reconcile(dbPath = DEFAULT_DB, { apply = false, exportPath = null } = {}) {
    const db = new Database(dbPath);

    // Every station with the GTFS stop(s) the crosswalk mapped to it. Using the
    // crosswalk (not name matching) as the coord source means halts — "X - Спирка"
    // stations mapped to their own GTFS point via the sibling-halt rule, whose
    // name never matches — also get their true coordinate, instead of the
    // placeholder they inherited from the main station.
    const rows = db.prepare(`
        SELECT st.id, st.name, st.lat AS olat, st.lon AS olon,
               g.stop_name AS gname, g.stop_lat AS glat, g.stop_lon AS glon
        FROM station_map sm
        JOIN stations st  ON st.id = sm.station_id
        JOIN gtfs_stops g ON g.stop_id = sm.gtfs_stop_id
        WHERE g.stop_lat IS NOT NULL AND sm.station_id IS NOT NULL
    `).all();

    // station_id -> the mapped GTFS stop CLOSEST to our current coord. Closest
    // matters when a station has several mapped points: if our coord already
    // sits on one it is correct and kept; only when it is far from ALL of them
    // (a placeholder or a geocode error) do we adopt the nearest GTFS coord.
    const pick = new Map();
    for (const r of rows) {
        const d = (r.olat != null) ? haversine(r.olat, r.olon, r.glat, r.glon) : Infinity;
        const cur = pick.get(r.id);
        if (!cur || d < cur.dist) pick.set(r.id, { ...r, dist: d });
    }

    const updates = [];
    for (const r of pick.values()) {
        if (r.olat == null || r.olon == null) {
            updates.push({ ...r, dist: null, reason: 'missing coord' });
        } else if (r.dist > THRESHOLD_KM) {
            // Our coord is far from even the closest same-named GTFS stop → suspect.
            updates.push(r);
        }
    }
    updates.sort((a, b) => (b.dist || 1e9) - (a.dist || 1e9));

    if (apply) {
        const upd = db.prepare('UPDATE stations SET lat = ?, lon = ? WHERE id = ?');
        const tx = db.transaction(() => { for (const u of updates) upd.run(u.glat, u.glon, u.id); });
        tx();
    }

    if (exportPath) {
        const all = db.prepare('SELECT id, name, lat, lon FROM stations ORDER BY id').all();
        fs.writeFileSync(exportPath, JSON.stringify(all, null, 2));
    }

    db.close();
    return updates;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const dbPath = args.find(a => a.endsWith('.sqlite')) || DEFAULT_DB;
    const apply = args.includes('--apply');
    const ei = args.indexOf('--export');
    const exportPath = ei >= 0 ? args[ei + 1] : null;

    const updates = reconcile(dbPath, { apply, exportPath });
    console.log(`${apply ? 'APPLIED' : 'would update'} ${updates.length} station coordinate(s) (> ${THRESHOLD_KM} km from GTFS):\n`);
    for (const u of updates) {
        console.log(`  ${u.name.padEnd(24)} ${u.dist != null ? (u.dist.toFixed(1) + ' km').padStart(9) : '  (no coord)'}  ` +
            `[${u.olat?.toFixed(3) ?? '—'},${u.olon?.toFixed(3) ?? '—'}] → [${u.glat.toFixed(3)},${u.glon.toFixed(3)}]`);
    }
    if (exportPath) console.log(`\nexported full corrected coord list → ${exportPath}`);
    if (!apply) console.log('\n(report only — re-run with --apply to write)');
}

module.exports = { reconcile };
