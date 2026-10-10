'use strict';

/**
 * rt-train.js — what the SOURCE (the national access point) says about one or more
 * trains right now, straight from its two feeds and not through our API:
 *
 *   - TripUpdates     → does the train have a delay / stop times?
 *   - VehiclePositions → does the train have a GPS position?
 *
 * Built for "this train has a delay but no dot on the map": it shows which of the two
 * the source publishes, and, when there is no position, whether a vehicle sits where
 * the train should be under some OTHER number (it does not, so far as measured).
 *
 * Usage:   node scripts/rt-train.js 3624 3625 3623
 * Read-only: two GETs to the source, a read of the local database, nothing written.
 */

const path     = require('path');
const axios    = require('axios');
const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');
const cfg      = require('../services/gtfs/config');

const FeedMessage = B.transit_realtime.FeedMessage;
const STATUS = B.transit_realtime.VehiclePosition.VehicleStopStatus;

const numbers = process.argv.slice(2).filter(a => /^\d+$/.test(a));
if (numbers.length === 0) {
    console.error('usage: node scripts/rt-train.js <train number> [<train number> ...]');
    process.exit(1);
}

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const stopCoords = new Map();      // gtfs stop_id -> { name, lat, lon }
const tripToNumber = new Map();    // exactly what the poller uses
try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    for (const r of db.prepare(`SELECT sm.gtfs_stop_id AS id, s.name, s.lat, s.lon
                                  FROM station_map sm JOIN stations s ON s.id = sm.station_id`).all()) {
        stopCoords.set(r.id, { name: r.name, lat: r.lat, lon: r.lon });
    }
    for (const r of db.prepare('SELECT trip_id, train_number FROM trip').all()) tripToNumber.set(r.trip_id, r.train_number);
    db.close();
} catch (e) {
    console.warn(`(no database at ${DB_PATH}: ${e.message} — positions along the route cannot be estimated)\n`);
}
const numberOf = (tripId) => String(tripToNumber.get(tripId) || String(tripId || '').split('-')[0] || '');

const km = (a, b, c, d) => {
    const p = Math.PI / 180;
    const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(x)) * 10) / 10;
};
const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' });

async function feed(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    return FeedMessage.decode(Buffer.from(res.data));
}

/** Where the delay feed says the train is now: between two stops, by their times. */
function expectedPlace(tu, nowSec) {
    const st = tu.stopTimeUpdate
        .map(s => ({
            id: s.stopId,
            t: Number((s.arrival && s.arrival.time) || (s.departure && s.departure.time) || 0),
            delay: (s.arrival && s.arrival.delay) ?? (s.departure && s.departure.delay) ?? null,
        }))
        .filter(s => s.t);
    const ahead = st.findIndex(s => s.t >= nowSec);
    const passed = ahead === -1 ? st.length : ahead;
    const out = { stops: st.length, passed, ahead: st.length - passed, next: null, delayMin: null, point: null };
    if (ahead <= 0) return out;                                    // not started, or finished
    const next = st[ahead], prev = st[ahead - 1];
    out.next = (stopCoords.get(next.id) || {}).name || next.id;
    out.delayMin = next.delay == null ? null : Math.round(next.delay / 60);
    const A = stopCoords.get(prev.id), Bc = stopCoords.get(next.id);
    if (A && Bc && next.t > prev.t) {
        const f = (nowSec - prev.t) / (next.t - prev.t);
        out.point = { lat: A.lat + (Bc.lat - A.lat) * f, lon: A.lon + (Bc.lon - A.lon) * f, from: A.name, to: Bc.name };
    }
    return out;
}

(async () => {
    const [tuFeed, vpFeed] = await Promise.all([feed(cfg.RT.tripUpdates), feed(cfg.RT.vehiclePositions)]);
    const nowSec = Date.now() / 1000;
    const age = (f) => Math.round(nowSec - Number(f.header.timestamp));
    console.log(`Source right now: TripUpdates ${tuFeed.entity.length} trains (${age(tuFeed)} s old), ` +
                `VehiclePositions ${vpFeed.entity.length} vehicles (${age(vpFeed)} s old)\n`);

    const vehicles = vpFeed.entity.map(e => e.vehicle).filter(v => v && v.position);

    for (const n of numbers) {
        console.log(`== Train ${n}`);

        const tus = tuFeed.entity.map(e => e.tripUpdate).filter(t => t && t.trip && numberOf(t.trip.tripId) === n);
        const mine = vehicles.filter(v => (v.trip && numberOf(v.trip.tripId) === n)
            || (v.vehicle && (v.vehicle.id === n || new RegExp(`\\b${n}\\b`).test(String(v.vehicle.label || '')))));

        // 1. delay feed
        let place = null;
        if (tus.length === 0) {
            console.log('  TripUpdates   : NOT in the feed (no delay, no stop times)');
        }
        for (const tu of tus) {
            place = expectedPlace(tu, nowSec);
            const state = place.passed === 0 ? 'not started yet' : (place.ahead === 0 ? 'finished' : 'RUNNING');
            console.log(`  TripUpdates   : ${tu.trip.tripId} — ${place.stops} stops, ${state} (${place.passed} passed, ${place.ahead} ahead)` +
                (place.delayMin == null ? '' : `, delay ${place.delayMin >= 0 ? '+' : ''}${place.delayMin} min at ${place.next}`));
        }

        // 2. position feed
        if (mine.length === 0) {
            console.log('  VehiclePosition: NOT PUBLISHED — no vehicle for this train (searched trip id, vehicle id and label)');
        }
        for (const v of mine) {
            console.log(`  VehiclePosition: ${v.trip && v.trip.tripId} at ${v.position.latitude.toFixed(5)},${v.position.longitude.toFixed(5)}` +
                `, ${STATUS[v.currentStatus]}, fix ${hhmm(Number(v.timestamp))}, stop ${v.stopId}`);
        }

        // 3. no dot although the train is running: is it hiding under another number?
        if (mine.length === 0 && place && place.point) {
            console.log(`  Should be now : between ${place.point.from} and ${place.point.to} ` +
                `(≈ ${place.point.lat.toFixed(3)},${place.point.lon.toFixed(3)} by its times)`);
            const near = vehicles
                .map(v => ({ v, d: km(place.point.lat, place.point.lon, v.position.latitude, v.position.longitude) }))
                .sort((a, b) => a.d - b.d).slice(0, 2);
            for (const { v, d } of near) {
                console.log(`  Nearest vehicle: ${d} km away — train ${numberOf(v.trip && v.trip.tripId)} (${v.vehicle && v.vehicle.label})`);
            }
        }

        // verdict
        if (tus.length && !mine.length && place && place.passed > 0 && place.ahead > 0) {
            console.log('  => The source publishes a delay for this running train but NO position. ' +
                'Nothing on our side can show a dot for it; it is missing from the source.');
        } else if (mine.length && !tus.length) {
            console.log('  => A position, but no delay: the dot is shown, the delay is unknown.');
        } else if (mine.length && tus.length) {
            console.log('  => Both published: the app should show the dot and the delay.');
        } else if (!mine.length && !tus.length) {
            console.log('  => Not in either feed (not running now, or not published).');
        }
        console.log('');
    }
    process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
