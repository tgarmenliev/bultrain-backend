'use strict';

/**
 * routeShape.js — the track geometry of one train on one day, for the app's
 * per-train map: a simplified polyline plus how far along it each calling stop
 * sits, so the client can say "between stop X and Y" without geometry maths.
 *
 * The geometry is the GTFS shapes.txt that BDZ publishes (verified to follow the
 * track: stops lie a median 16 m from it). Nothing is synthesised: a train with
 * no shape simply has none, and the caller answers 404.
 *
 * Stop distances are computed by projecting the stop coordinates onto the
 * polyline, monotonically (a stop can never sit before the previous one), because
 * the feed's stop_times carries no shape_dist_traveled. The projection is done on
 * the SIMPLIFIED line that is sent, so a client that measures along the polyline
 * it received gets the same numbers.
 *
 * The pure geometry is exported separately (build) so it is tested without a
 * database.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const progress = require('../realtime/progress');
const polyline = require('./polyline');

const DB_PATH      = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES  = 2000;

// Douglas–Peucker tolerance. Rail curves are gentle; 10 m is invisible at city
// zoom and the encoded shape stays around a couple of kilobytes.
const SIMPLIFY_TOL_M = 10;

// A stop further than this from the line is not on this shape (a coordinate
// defect, a skipped branch): it is left out rather than pinned to the wrong spot.
const STOP_MAX_OFFSET_M = 1500;

const BACKTRACK_TOL_M = 1;
const MAX_CANDIDATES  = 6;

let db = null;
const cache = new Map();   // trip_id -> { at, value }

function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Indices of the vertices Douglas–Peucker keeps (always both ends). */
function simplifyIndices(xy, tol) {
    const n = xy.length;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        if (b <= a + 1) continue;
        const ax = xy[a].x, ay = xy[a].y, dx = xy[b].x - ax, dy = xy[b].y - ay;
        const len2 = dx * dx + dy * dy;
        let worst = -1;
        let worstD = tol;
        for (let i = a + 1; i < b; i++) {
            let d;
            if (len2 === 0) {
                d = Math.hypot(xy[i].x - ax, xy[i].y - ay);
            } else {
                const t = Math.max(0, Math.min(1, ((xy[i].x - ax) * dx + (xy[i].y - ay) * dy) / len2));
                d = Math.hypot(xy[i].x - (ax + t * dx), xy[i].y - (ay + t * dy));
            }
            if (d > worstD) { worstD = d; worst = i; }
        }
        if (worst !== -1) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    const idx = [];
    for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    return idx;
}

/** Every plausible place along `line` for one stop: its local nearest points. */
function candidatesFor(line, pt) {
    const p = progress._toXY(pt, line.refLatRad);
    const segs = [];
    for (let i = 0; i < line.xy.length - 1; i++) {
        const a = line.xy[i];
        const b = line.xy[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const offset = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        segs.push({ along: line.cum[i] + t * Math.sqrt(len2), offset });
    }
    const out = [];
    for (let i = 0; i < segs.length; i++) {
        const lo = i === 0 || segs[i].offset <= segs[i - 1].offset;
        const hi = i === segs.length - 1 || segs[i].offset < segs[i + 1].offset;
        if (lo && hi && segs[i].offset <= STOP_MAX_OFFSET_M) out.push(segs[i]);
    }
    out.sort((x, y) => x.offset - y.offset);
    return out.slice(0, MAX_CANDIDATES).sort((x, y) => x.along - y.along);
}

/**
 * Place stops along the line, in order, choosing among each stop's candidates
 * the combination with the least total offset that never goes backwards. A line
 * that passes the same station twice (a reversing branch) is therefore resolved
 * by the stops around it, not by whichever pass happens to be nearer.
 * @returns {({along:number}|null)[]} one entry per stop, null when it has no place.
 */
function placeStops(line, stops) {
    let layer = [{ along: -Infinity, cost: 0, prev: null, stopIdx: -1 }];

    stops.forEach((s, i) => {
        const cands = candidatesFor(line, s);
        const next = [];
        for (const c of cands) {
            let best = null;
            for (const p of layer) {
                if (p.along <= c.along + BACKTRACK_TOL_M && (!best || p.cost < best.cost)) best = p;
            }
            if (best) next.push({ along: c.along, cost: best.cost + c.offset, prev: best, stopIdx: i });
        }
        if (next.length) {
            layer = next;
        }
    });

    const placed = new Array(stops.length).fill(null);
    let end = layer.reduce((b, n) => (!b || n.cost < b.cost ? n : b), null);
    while (end && end.stopIdx >= 0) {
        placed[end.stopIdx] = { along: end.along };
        end = end.prev;
    }
    return placed;
}

/**
 * @param {{lat:number,lon:number}[]} shapePts  full-resolution shape, in order
 * @param {{stationId:number,lat:number,lon:number}[]} stops  calling stops, in order
 * @returns {{shape:string, totalMeters:number, stops:{stationId:number,distanceMeters:number}[],
 *            droppedStops:number}|null} null when the shape is unusable
 */
function build(shapePts, stops) {
    if (!Array.isArray(shapePts) || shapePts.length < 2) return null;

    const full = progress.prepareLine(shapePts);
    const kept = simplifyIndices(full.xy, SIMPLIFY_TOL_M).map(i => shapePts[i]);
    const line = progress.prepareLine(kept);

    const placed = placeStops(line, stops);
    const out = [];
    let last = 0;
    stops.forEach((s, i) => {
        if (!placed[i]) return;
        last = Math.max(last, Math.round(placed[i].along));   // never backwards after rounding
        out.push({ stationId: s.stationId, distanceMeters: last });
    });

    return {
        shape: polyline.encode(kept, 6),
        totalMeters: Math.round(line.total),
        stops: out,
        droppedStops: stops.length - out.length,
    };
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * The rail leg of `trainNo` on `date` that has a shape. A number can be several
 * chained trips (a train plus its replacement bus); the bus leg is road, not
 * track, so only non-bus legs count, and the one with the most stops wins.
 * @returns {{tripId:string, shapeId:string}|null}
 */
function pickTrip(trainNo, date) {
    const rows = conn().prepare(`
        SELECT t.trip_id AS tripId, g.shape_id AS shapeId,
               (SELECT COUNT(*) FROM trip_stop s WHERE s.trip_id = t.trip_id) AS n
          FROM trip t
          JOIN trip_date td ON td.trip_id = t.trip_id
          JOIN gtfs_trips g ON g.trip_id = t.trip_id
         WHERE t.train_number = ? AND td.date = ?
           AND t.category <> 'АВТ' AND g.shape_id IS NOT NULL AND g.shape_id <> ''
         ORDER BY n DESC, t.trip_id
    `).all(String(trainNo), date);
    return rows[0] || null;
}

function loadFor(tripId, shapeId) {
    const c = conn();
    const shapePts = c.prepare(
        'SELECT shape_pt_lat AS lat, shape_pt_lon AS lon FROM gtfs_shapes WHERE shape_id = ? ORDER BY shape_pt_sequence'
    ).all(shapeId);

    const raw = c.prepare(`
        SELECT ts.station_id AS stationId, s.lat, s.lon
          FROM trip_stop ts LEFT JOIN stations s ON s.id = ts.station_id
         WHERE ts.trip_id = ? ORDER BY ts.seq
    `).all(tripId).filter(r => r.stationId != null && r.lat != null && r.lon != null);

    const stops = raw.filter((r, i) => i === 0 || r.stationId !== raw[i - 1].stationId);
    return build(shapePts, stops);
}

/**
 * @returns {{trainNumber:string, serviceDate:string, encoding:'polyline6', shape:string,
 *            totalMeters:number, stops:object[], distanceSource:'computed'}|null}
 *          null for an unknown train/date, or a train with no shape — a normal answer.
 */
function forTrain(trainNo, date) {
    let pick;
    try {
        pick = pickTrip(trainNo, date);
    } catch (err) {
        console.error('[shape] lookup failed:', err.message);   // missing tables: no shape
        return null;
    }
    if (!pick) return null;

    let hit = cache.get(pick.tripId);
    if (!(hit && Date.now() - hit.at < CACHE_TTL_MS)) {
        let value = null;
        try {
            value = loadFor(pick.tripId, pick.shapeId);
        } catch (err) {
            console.error('[shape] build failed:', err.message);
        }
        if (cache.size >= MAX_ENTRIES) cache.clear();
        hit = { at: Date.now(), value };
        cache.set(pick.tripId, hit);
    }
    if (!hit.value) return null;

    return {
        trainNumber: String(trainNo),
        serviceDate: date,
        encoding: 'polyline6',
        shape: hit.value.shape,
        totalMeters: hit.value.totalMeters,
        stops: hit.value.stops,
        distanceSource: 'computed',
    };
}

function _reset() { cache.clear(); }

module.exports = { build, forTrain, simplifyIndices, _reset, SIMPLIFY_TOL_M, STOP_MAX_OFFSET_M };
