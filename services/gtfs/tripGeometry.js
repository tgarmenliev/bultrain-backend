'use strict';

/**
 * tripGeometry.js — static geometry for a trip: its ordered stops (with station
 * coordinates and scheduled times) and its route polyline (the GTFS shape).
 *
 * Used to derive progress for a running train that has a GPS position but no
 * TripUpdate. Loaded by the trip_id the VehiclePosition carries, so a number
 * with two active trips resolves to the exact run we have a position for.
 *
 * Read-only, and cached per trip_id: this data changes only with the daily GTFS
 * refresh, so there's no reason to hit the DB on every request.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000; // an hour; the refresh runs daily

let db = null;
const cache = new Map(); // trip_id -> { at, value }

function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

/**
 * @returns {{ stops: Array<{seq,stationId,name,lat,lon,arrive,depart}>,
 *             shape: Array<{lat,lon}> }|null}
 *          null when the trip is unknown or has too few located stops to place a
 *          train against (progress would be meaningless).
 */
function getByTripId(tripId) {
    if (!tripId) return null;

    const hit = cache.get(tripId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let value = null;
    try {
        const stops = conn().prepare(
            `SELECT ts.seq, ts.station_id AS stationId, s.name, s.lat, s.lon, ts.arrive, ts.depart
               FROM trip_stop ts
               LEFT JOIN stations s ON s.id = ts.station_id
              WHERE ts.trip_id = ?
              ORDER BY ts.seq`
        ).all(tripId).filter(r => r.lat != null && r.lon != null);

        if (stops.length >= 2) {
            const shape = conn().prepare(
                `SELECT g.shape_pt_lat AS lat, g.shape_pt_lon AS lon
                   FROM gtfs_trips t
                   JOIN gtfs_shapes g ON g.shape_id = t.shape_id
                  WHERE t.trip_id = ?
                  ORDER BY g.shape_pt_sequence`
            ).all(tripId);
            value = { stops, shape };
        }
    } catch (err) {
        // Missing GTFS tables (a very old DB) or any query error: degrade to no
        // geometry rather than failing the request.
        console.error('[rt] tripGeometry failed:', err.message);
        value = null;
    }

    cache.set(tripId, { at: Date.now(), value });
    return value;
}

module.exports = { getByTripId };
