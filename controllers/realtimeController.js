'use strict';

const cache      = require('../services/realtime/cache');
const geometryOf = require('../services/gtfs/tripGeometry');
const progress   = require('../services/realtime/progress');

// Unix epoch (seconds) → HH:MM in Europe/Sofia.
function hhmm(epochSec) {
    if (!epochSec) return null;
    return new Date(epochSec * 1000).toLocaleTimeString('en-GB', {
        timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
    });
}

// Guard only against a hypothetical multi-day feed glitch. Real delays can be
// huge — international transit trains (Optima Express etc.) genuinely run 700+
// min late — and showing that accurately is a feature, not a bug.
const MAX_ABS_DELAY_SEC = 20 * 3600;
const toMin = (sec) =>
    (sec == null || Math.abs(sec) > MAX_ABS_DELAY_SEC) ? null : Math.round(sec / 60);

// If the position sits further than this off the trip's own route, we don't
// trust the match enough to derive stops from it — better to show just the dot
// than a confidently wrong "next stop".
const MAX_OFFSET_M = 3000;

// Stops + headline delay from a TripUpdate (the feed's own predicted times).
function fromFeed(rt, nowSec) {
    const named = rt.stops.filter(s => s.stationId != null);
    const stops = named.map(s => ({
        station:           s.station,
        stationId:         s.stationId,
        predictedArrival:  hhmm(s.arrivalTime),
        arrivalDelayMin:   toMin(s.arrivalDelay),
        departureDelayMin: toMin(s.departureDelay),
        passed:            s.arrivalTime ? (s.arrivalTime < nowSec) : null,
    }));
    const upcoming = named.filter(s => s.arrivalTime && s.arrivalTime >= nowSec);
    const ref = upcoming[0] || named[named.length - 1];
    return {
        stops,
        delayMinutes: ref ? toMin(ref.arrivalDelay ?? ref.departureDelay) : null,
        nextStation:  upcoming[0] ? upcoming[0].station : null,
    };
}

// Stops + progress from a GPS position projected onto the trip's static
// geometry. Honest by construction: it reports where the train IS and which
// stop is ahead, and NO delay or predicted time (we have neither). Returns null
// when the geometry is unusable or the position doesn't match the route.
function fromPosition(v, geo) {
    const stopPts = geo.stops.map(s => ({ lat: s.lat, lon: s.lon }));
    const linePts = (geo.shape && geo.shape.length >= 2) ? geo.shape : stopPts;

    let line;
    try { line = progress.prepareLine(linePts); } catch { return null; }

    const loc = progress.locate(line, stopPts, { lat: v.lat, lon: v.lon });
    if (loc.offsetMeters > MAX_OFFSET_M) return null; // position off this route

    const stops = geo.stops.map((s, i) => ({
        station:            s.name,
        stationId:          s.stationId,
        scheduledArrival:   s.arrive || null,
        scheduledDeparture: s.depart || null,
        passed:             i <= loc.lastPassedIndex,
        isNext:             i === loc.nextIndex,
    }));
    return {
        stops,
        progressPercentage: Number(loc.progress.toFixed(4)),
        nextStation: loc.nextIndex != null ? geo.stops[loc.nextIndex].name : null,
    };
}

/**
 * Pure builder for GET /api/realtime/train/:no — no req/res, so it's unit
 * testable with synthetic inputs. Merges the two realtime feeds and, for a
 * position-only train, derives progress from static geometry.
 */
function buildTrainStatus({ num, rt, v, geo, now = new Date() }) {
    if (!rt && !v) return { status: 404, body: { error: 'No live data for this train.' } };

    const nowSec = now.getTime() / 1000;
    let stops = [];
    let delayMinutes = null;
    let progressPercentage = null;
    let nextStation = null;
    let progressSource = null;

    if (rt) {
        const f = fromFeed(rt, nowSec);
        stops = f.stops;
        delayMinutes = f.delayMinutes;
        nextStation = f.nextStation;
        progressSource = 'feed';
    } else if (v && geo) {
        const p = fromPosition(v, geo);
        if (p) {
            stops = p.stops;
            progressPercentage = p.progressPercentage;
            nextStation = p.nextStation;
            progressSource = 'position';
        }
    }

    return {
        status: 200,
        body: {
            trainNumber:  num,
            delayMinutes,                 // null unless there's a TripUpdate
            hasLiveDelay: !!rt,           // false ⇒ running on position alone
            progressSource,               // 'feed' | 'position' | null
            progressPercentage,           // set only when derived from position
            nextStation,
            stops,
            position: v ? { lat: v.lat, lon: v.lon, bearing: v.bearing } : null,
        },
    };
}

/**
 * GET /api/realtime/train/:trainNo
 * Live status for a running train, merged from the two realtime feeds.
 *
 * NAP publishes TripUpdates (delay + per-stop times) and VehiclePositions (GPS)
 * as SEPARATE feeds with different coverage — there are consistently more trains
 * with a position than with a TripUpdate. So a train can be visibly running (we
 * have its position) yet have no delay data. Instead of 404ing, we report it as
 * running: for these we derive stops and progress from the GPS position against
 * the trip's static geometry (progressSource:'position'), inventing no delay or
 * predicted time. A train WITH a TripUpdate keeps the feed's own data
 * (progressSource:'feed'). 404 only when it's in neither feed.
 *
 * Additive response: trainNumber/delayMinutes/stops as before; hasLiveDelay,
 * position, progressSource, progressPercentage, nextStation are new.
 */
exports.getTrain = (req, res) => {
    const num = req.params.trainNo;
    const rt = cache.getTrain(num);
    const v  = cache.getVehicle(num);

    // Static geometry only matters when we're deriving progress from a position
    // (no TripUpdate). Loaded by the vehicle's own trip_id, so a number with two
    // active trips resolves to the exact run we have a position for.
    const geo = (!rt && v && v.tripId) ? geometryOf.getByTripId(v.tripId) : null;

    const { status, body } = buildTrainStatus({ num, rt, v, geo });
    res.status(status).json(body);
};

exports._buildTrainStatus = buildTrainStatus; // exported for unit tests

/**
 * GET /api/realtime/vehicle/:trainNo
 * Live GPS position + bearing of a running train.
 */
exports.getVehicle = (req, res) => {
    const num = req.params.trainNo;
    const v = cache.getVehicle(num);
    if (!v) return res.status(404).json({ error: 'No live position for this train.' });
    res.json({ trainNumber: num, lat: v.lat, lon: v.lon, bearing: v.bearing });
};

/**
 * GET /api/realtime/vehicles
 * Every running train's position — for the map / "radar".
 */
exports.getVehicles = (req, res) => {
    const vehicles = cache.getAllVehicles().map(([num, v]) => ({
        trainNumber: num, lat: v.lat, lon: v.lon, bearing: v.bearing,
    }));
    res.json({ count: vehicles.length, vehicles });
};

/**
 * GET /api/realtime/status  — poller/cache health (debugging).
 */
exports.getStatus = (req, res) => res.json(cache.status());
