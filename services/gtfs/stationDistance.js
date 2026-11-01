'use strict';

/**
 * stationDistance.js — how far apart two stations are ALONG THE TRACK, for the
 * admin panel's distance calculator.
 *
 * There is no distance table in the data (the feed has no shape_dist_traveled), so
 * the figure is measured the way route-shape does it: a train that calls at both
 * stations has a GTFS shape, both stops are placed on that line, and the distance
 * is the length of line between them. Stops sit a median 16 m from the line, so
 * this is the real track length, not the straight line (which is also returned,
 * as a sanity reference).
 *
 * "On the same line" needs no separate check: if no train calls at both stations
 * there is nothing to measure along, and the answer says so.
 *
 * Several trains can link the same two stations over different shapes (a branch,
 * a variant). One trip per distinct shape is measured; the headline is the median
 * and the spread is reported so a disagreement is visible rather than averaged away.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const routeShape = require('./routeShape');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

// Enough to cover every real variant between two stations; stops a pair served by
// hundreds of trips from measuring the same line again and again.
const MAX_SHAPES = 40;

let db = null;
function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

/** Great-circle distance in km. */
function haversineKm(a, b) {
    const R = 6371.0088;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

const round1 = (km) => Math.round(km * 10) / 10;

/** Every station, by name — what the calculator's two pickers offer. */
function listStations() {
    return conn().prepare(
        'SELECT id, name, english_name AS englishName FROM stations ORDER BY name COLLATE NOCASE'
    ).all();
}

function median(sorted) {
    const m = sorted.length >> 1;
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * One rail trip per distinct shape that calls at both stations (either direction).
 * Bus legs are road, not track, and are left out.
 * @returns {{tripId:string, shapeId:string, trainNumber:string}[]}
 */
function tripsCalling(fromId, toId) {
    const rows = conn().prepare(`
        SELECT t.trip_id AS tripId, t.train_number AS trainNumber, g.shape_id AS shapeId
          FROM trip_stop a
          JOIN trip_stop b ON b.trip_id = a.trip_id AND b.station_id = ? AND b.seq <> a.seq
          JOIN trip t      ON t.trip_id = a.trip_id
          JOIN gtfs_trips g ON g.trip_id = a.trip_id
         WHERE a.station_id = ?
           AND t.category <> 'АВТ'
           AND g.shape_id IS NOT NULL AND g.shape_id <> ''
         ORDER BY t.trip_id
    `).all(toId, fromId);

    const byShape = new Map();
    for (const r of rows) if (!byShape.has(r.shapeId)) byShape.set(r.shapeId, r);
    return [...byShape.values()].slice(0, MAX_SHAPES);
}

/**
 * @returns {{
 *   from:{id:number,name:string}, to:{id:number,name:string},
 *   airKm:number|null,
 *   found:boolean,           // false: no train calls at both stations
 *   km?:number, minKm?:number, maxKm?:number,
 *   shapes?:number,          // distinct lines measured
 *   exampleTrain?:string,
 * }|null}  null when either station id is unknown
 */
function between(fromId, toId) {
    const stn = conn().prepare('SELECT id, name, lat, lon FROM stations WHERE id = ?');
    const a = stn.get(fromId);
    const b = stn.get(toId);
    if (!a || !b) return null;

    const hasXY = (s) => s.lat != null && s.lon != null;
    const out = {
        from: { id: a.id, name: a.name },
        to:   { id: b.id, name: b.name },
        airKm: hasXY(a) && hasXY(b) ? round1(haversineKm(a, b)) : null,
        found: false,
    };

    if (a.id === b.id) return { ...out, found: true, km: 0, minKm: 0, maxKm: 0, shapes: 0 };

    const measured = [];
    for (const trip of tripsCalling(a.id, b.id)) {
        const prepared = routeShape.preparedShape(trip.shapeId);
        if (!prepared) continue;
        const placed = routeShape.placeOn(prepared, routeShape.stopsOfTrip(trip.tripId)).stops;
        const pa = placed.find((s) => s.stationId === a.id);
        const pb = placed.find((s) => s.stationId === b.id);
        if (!pa || !pb) continue;
        measured.push({ km: Math.abs(pb.distanceMeters - pa.distanceMeters) / 1000, trainNumber: trip.trainNumber });
    }
    if (measured.length === 0) return out;

    const kms = measured.map((m) => m.km).sort((x, y) => x - y);
    const mid = median(kms);
    // The example is the train closest to the headline figure, so "see train N" matches it.
    const example = measured.reduce((best, m) => (Math.abs(m.km - mid) < Math.abs(best.km - mid) ? m : best));

    return {
        ...out,
        found: true,
        km: round1(mid),
        minKm: round1(kms[0]),
        maxKm: round1(kms[kms.length - 1]),
        shapes: measured.length,
        exampleTrain: example.trainNumber,
    };
}

module.exports = { listStations, between, haversineKm };
