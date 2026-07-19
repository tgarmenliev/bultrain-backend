'use strict';

/**
 * build-crosswalk.js — match every GTFS stop to one of our stations.
 *
 * Two independent signals, name and coordinates, cross-checked:
 *   high    — names match AND coordinates agree (< HIGH_KM). Trust automatically.
 *   medium  — only one signal: same name but coords far/missing, OR different
 *             name but coords nearly identical (< COORD_KM). Needs a human look.
 *   none    — neither. A genuinely new stop; no station_id.
 *
 * Rebuilds station_map from scratch each run (deterministic from feed + stations).
 * Reads and writes one DB. Prints a review report of everything not 'high'.
 *
 * Usage:  node services/gtfs/build-crosswalk.js [db.sqlite]
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DEFAULT_DB = path.join(__dirname, '..', '..', 'bultrain.sqlite');
const ALIASES_PATH = path.join(__dirname, 'station-aliases.json');

// Human-verified GTFS stop_id -> our station.id overrides (the translation
// layer). Applied before automatic matching. station_id null = confirmed new.
function loadAliases() {
    try {
        const raw = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
        const m = new Map();
        for (const [stopId, v] of Object.entries(raw)) {
            if (stopId.startsWith('_')) continue; // skip _comment
            m.set(stopId, v);
        }
        return m;
    } catch (_) {
        return new Map();
    }
}

const HIGH_KM      = 2.0;   // name match + coords within this = high confidence
const COORD_HIGH_KM = 0.2;  // coords this close = same point, name spelling aside → high
const COORD_KM     = 0.5;   // different name but this close = same place (medium)

// Same normalisation the schedule importer uses, so names line up.
function norm(s) {
    return String(s || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*-\s*сп\.?\s*$/, ' - спирка')
        .replace(/\s*-\s*/g, '-');
}

function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (c - a) * r, dLon = (d - b) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// gtfs_stop_id → station_id for the station/halt ("X" / "X - Спирка") pairs.
function computeSiblingHalts(stations, stops) {
    // normalised base name → { base, halt }
    const pairs = new Map();
    for (const s of stations) {
        // "X - Спирка" and the abbreviated "X - Сп."
        const m = /^(.*?)\s*-\s*(?:спирка|сп\.?)$/i.exec(s.name);
        if (!m) continue;
        const baseName = m[1].trim();
        const base = stations.find(b => b.name === baseName);
        if (base && base.lat != null) pairs.set(norm(baseName), { base, halt: s });
    }

    const byNorm = new Map();
    for (const st of stops) {
        const k = norm(st.stop_name);
        if (!byNorm.has(k)) byNorm.set(k, []);
        byNorm.get(k).push(st);
    }

    const forced = new Map();
    for (const [k, { base, halt }] of pairs) {
        const gstops = (byNorm.get(k) || []).filter(g => g.stop_lat != null);
        if (gstops.length < 2) continue; // need two GTFS points to split
        const ranked = gstops
            .map(g => ({ g, d: haversine(base.lat, base.lon, g.stop_lat, g.stop_lon) }))
            .sort((a, b) => a.d - b.d);
        forced.set(ranked[0].g.stop_id, base.id);              // closest → station
        forced.set(ranked[1].g.stop_id, halt.id);              // next → halt
        for (let i = 2; i < ranked.length; i++) forced.set(ranked[i].g.stop_id, base.id);
    }
    return forced;
}

function build(dbPath = DEFAULT_DB) {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    const stations = db.prepare('SELECT id, name, lat, lon FROM stations').all();
    const byId = new Map(stations.map(s => [s.id, s]));
    const byName = new Map();
    for (const s of stations) {
        const k = norm(s.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(s);
    }

    const aliases = loadAliases();

    const stops = db.prepare('SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops').all();

    // ── Sibling-halt resolution ──────────────────────────────────────────────
    // Our data splits many places into a station "X" and its halt "X - Спирка"
    // (often at an identical placeholder coord). GTFS instead ships two stops
    // BOTH named "X" at their true, distinct coordinates. Matching by name alone
    // sends both onto "X" and the materialiser then collapses them, deleting the
    // halt. Here we pair them up: the GTFS stop closest to our "X" coord is the
    // station, the next one is the halt.
    const siblingHalt = computeSiblingHalts(stations, stops);

    const nearest = (lat, lon) => {
        if (lat == null || lon == null) return { s: null, km: null };
        let best = null, bestKm = Infinity;
        for (const s of stations) {
            if (s.lat == null || s.lon == null) continue;
            const km = haversine(lat, lon, s.lat, s.lon);
            if (km < bestKm) { bestKm = km; best = s; }
        }
        return { s: best, km: best ? bestKm : null };
    };

    const rows = [];
    for (const st of stops) {
        // Human-verified override wins over any automatic guess.
        const alias = aliases.get(String(st.stop_id));
        if (alias) {
            const target = alias.station_id != null ? byId.get(alias.station_id) : null;
            rows.push({
                gtfs_stop_id: st.stop_id,
                station_id: alias.station_id ?? null,
                gtfs_stop_name: st.stop_name,
                station_name: target ? target.name : null,
                method: 'manual',
                confidence: alias.station_id != null ? 'high' : 'none',
                coord_dist_km: null,
                reviewed: 1,
            });
            continue;
        }

        // Station/halt pair: send the two same-named GTFS points to "X" and
        // "X - Спирка" respectively instead of collapsing both onto "X".
        if (siblingHalt.has(st.stop_id)) {
            const sid = siblingHalt.get(st.stop_id);
            const target = byId.get(sid);
            rows.push({
                gtfs_stop_id: st.stop_id,
                station_id: sid,
                gtfs_stop_name: st.stop_name,
                station_name: target ? target.name : null,
                method: 'sibling-halt',
                confidence: 'high',
                coord_dist_km: (target && target.lat != null && st.stop_lat != null)
                    ? Math.round(haversine(st.stop_lat, st.stop_lon, target.lat, target.lon) * 1000) / 1000 : null,
                reviewed: 0,
            });
            continue;
        }

        const nameMatches = byName.get(norm(st.stop_name)) || [];
        const near = nearest(st.stop_lat, st.stop_lon);

        let station = null, method = 'none', confidence = 'none', dist = near.km;

        if (nameMatches.length) {
            // If several stations share the name, pick the coord-closest.
            if (nameMatches.length === 1 || st.stop_lat == null) {
                station = nameMatches[0];
                dist = (station.lat != null && st.stop_lat != null)
                    ? haversine(st.stop_lat, st.stop_lon, station.lat, station.lon) : null;
            } else {
                let best = nameMatches[0], bestKm = Infinity;
                for (const s of nameMatches) {
                    if (s.lat == null) continue;
                    const km = haversine(st.stop_lat, st.stop_lon, s.lat, s.lon);
                    if (km < bestKm) { bestKm = km; best = s; }
                }
                station = best; dist = Number.isFinite(bestKm) ? bestKm : null;
            }
            method = 'name';
            confidence = 'medium';
            if (dist != null && dist <= HIGH_KM) { method = 'name+coord'; confidence = 'high'; }
        } else if (near.s && near.km != null && near.km <= COORD_KM) {
            // Same coordinates within COORD_KM but a different spelling. Under
            // COORD_HIGH_KM two points are the same station beyond doubt.
            station = near.s; method = 'coord'; dist = near.km;
            confidence = near.km <= COORD_HIGH_KM ? 'high' : 'medium';
        }

        rows.push({
            gtfs_stop_id: st.stop_id,
            station_id: station ? station.id : null,
            gtfs_stop_name: st.stop_name,
            station_name: station ? station.name : null,
            method, confidence,
            coord_dist_km: dist != null ? Math.round(dist * 1000) / 1000 : null,
            reviewed: 0,
        });
    }

    const write = db.transaction(() => {
        db.prepare('DELETE FROM station_map').run();
        const ins = db.prepare(`
            INSERT INTO station_map
              (gtfs_stop_id, station_id, gtfs_stop_name, station_name, method, confidence, coord_dist_km, reviewed)
            VALUES (@gtfs_stop_id, @station_id, @gtfs_stop_name, @station_name, @method, @confidence, @coord_dist_km, @reviewed)
        `);
        for (const r of rows) ins.run(r);
    });
    write();

    const by = (c) => rows.filter(r => r.confidence === c);
    const summary = { total: rows.length, high: by('high').length, medium: by('medium').length, none: by('none').length };
    db.close();
    return { summary, review: rows.filter(r => r.confidence !== 'high') };
}

if (require.main === module) {
    const dbPath = process.argv[2] || DEFAULT_DB;
    const { summary, review } = build(dbPath);
    console.log(`stops: ${summary.total}  |  high: ${summary.high}  medium: ${summary.medium}  none: ${summary.none}`);
    console.log(`auto-accepted (high): ${(100 * summary.high / summary.total).toFixed(1)}%\n`);

    const med = review.filter(r => r.confidence === 'medium');
    const non = review.filter(r => r.confidence === 'none');

    if (med.length) {
        console.log(`── MEDIUM — needs a look (${med.length}) ─────────────────────────────`);
        for (const r of med) {
            console.log(`  ${(r.gtfs_stop_name || '').padEnd(28)} → ${(r.station_name || '?').padEnd(28)} [${r.method}, ${r.coord_dist_km ?? '?'} km]`);
        }
        console.log('');
    }
    if (non.length) {
        console.log(`── NONE — new stops, no counterpart (${non.length}) ──────────────────`);
        for (const r of non) console.log(`  ${r.gtfs_stop_name} (${r.gtfs_stop_id})`);
    }
}

module.exports = { build };
