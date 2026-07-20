'use strict';

/**
 * poller.js — singleton GTFS-Realtime poller.
 *
 * Started once from server.js (the app runs in pm2 fork mode, single instance,
 * so there is exactly one poller). Fetches TripUpdates and VehiclePositions on
 * their own intervals, decodes the protobuf, resolves the feed's trip_id /
 * stop_id to our train_number / station via the DB, and updates the in-memory
 * cache. Never writes to SQLite. A failed poll is logged and skipped — the
 * cache simply keeps the last data until it goes stale.
 */

const axios    = require('axios');
const path     = require('path');
const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');

const cfg   = require('../gtfs/config');
const cache = require('./cache');

const DB_PATH     = path.join(__dirname, '..', '..', 'bultrain.sqlite');
const FeedMessage = B.transit_realtime.FeedMessage;

const TRIP_INTERVAL_MS    = 30000; // delays change slowly
const VEHICLE_INTERVAL_MS = 15000; // positions change faster
const LOOKUP_REFRESH_MS   = 60 * 60 * 1000; // reload DB lookups hourly (after daily GTFS refresh)
const HTTP_TIMEOUT_MS     = 20000;

let started = false;
let db = null;
let stopToStation = new Map();   // gtfs stop_id -> { station_id, name }
let tripToNumber  = new Map();   // gtfs trip_id  -> train_number
let lookupsAt = 0;

function refreshLookups() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    const s = new Map();
    for (const r of db.prepare(
        'SELECT sm.gtfs_stop_id AS id, sm.station_id AS sid, st.name AS name ' +
        'FROM station_map sm LEFT JOIN stations st ON st.id = sm.station_id'
    ).all()) {
        s.set(r.id, { station_id: r.sid, name: r.name });
    }
    stopToStation = s;

    const t = new Map();
    for (const r of db.prepare('SELECT trip_id, train_number FROM trip').all()) {
        t.set(r.trip_id, r.train_number);
    }
    tripToNumber = t;
    lookupsAt = Date.now();
}

function ensureLookups() {
    if (stopToStation.size === 0 || Date.now() - lookupsAt > LOOKUP_REFRESH_MS) refreshLookups();
}

// trip_id is "{number}-{cat}-{date}"; prefer the DB mapping, fall back to prefix.
function numberOf(tripId) {
    if (!tripId) return null;
    return tripToNumber.get(tripId) || String(tripId).split('-')[0] || null;
}

async function fetchFeed(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: HTTP_TIMEOUT_MS });
    return FeedMessage.decode(Buffer.from(res.data));
}

async function pollTripUpdates() {
    try {
        ensureLookups();
        const feed = await fetchFeed(cfg.RT.tripUpdates);
        const feedTs = (Number(feed.header.timestamp) * 1000) || Date.now();

        const map = new Map();
        for (const e of feed.entity) {
            const tu = e.tripUpdate;
            if (!tu || !tu.trip) continue;
            const num = numberOf(tu.trip.tripId);
            if (!num) continue;

            const stops = (tu.stopTimeUpdate || []).map(su => {
                const st = stopToStation.get(su.stopId);
                return {
                    stationId:      st ? st.station_id : null,
                    station:        st ? st.name : null,
                    arrivalDelay:   su.arrival   ? (su.arrival.delay   ?? null) : null,
                    arrivalTime:    su.arrival   && su.arrival.time   ? Number(su.arrival.time)   : null,
                    departureDelay: su.departure ? (su.departure.delay ?? null) : null,
                    departureTime:  su.departure && su.departure.time ? Number(su.departure.time) : null,
                };
            });
            map.set(num, { tripId: tu.trip.tripId, stops });
        }
        cache.setTrips(map, feedTs);
    } catch (err) {
        console.error('[rt] tripUpdates poll failed:', err.message);
    }
}

async function pollVehicles() {
    try {
        ensureLookups();
        const feed = await fetchFeed(cfg.RT.vehiclePositions);
        const feedTs = (Number(feed.header.timestamp) * 1000) || Date.now();

        const map = new Map();
        for (const e of feed.entity) {
            const v = e.vehicle;
            if (!v || !v.position) continue;
            const num = numberOf(v.trip && v.trip.tripId);
            if (!num) continue;
            map.set(num, {
                tripId:  v.trip && v.trip.tripId,
                lat:     v.position.latitude,
                lon:     v.position.longitude,
                bearing: v.position.bearing ?? null,
            });
        }
        cache.setVehicles(map, feedTs);
    } catch (err) {
        console.error('[rt] vehiclePositions poll failed:', err.message);
    }
}

function start() {
    if (started) return;
    started = true;
    refreshLookups();
    pollTripUpdates();
    pollVehicles();
    setInterval(pollTripUpdates, TRIP_INTERVAL_MS);
    setInterval(pollVehicles,    VEHICLE_INTERVAL_MS);
    console.log('[rt] realtime poller started');
}

module.exports = { start, pollTripUpdates, pollVehicles };
