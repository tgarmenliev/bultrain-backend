'use strict';

const cache      = require('../services/realtime/cache');
const geometryOf = require('../services/gtfs/tripGeometry');
const tripMeta   = require('../services/realtime/tripMeta');
const { summarize, positionOf } = require('../services/realtime/trainStatus');
const { etagMatches } = require('../services/httpCache');

/**
 * Pure builder for GET /api/realtime/train/:no — no req/res, so it's unit
 * testable with synthetic inputs. Merges the two realtime feeds and, for a
 * position-only train, derives progress from static geometry.
 */
function buildTrainStatus({ num, rt, v, geo, calling = null, now = new Date() }) {
    if (!rt && !v) return { status: 404, body: { error: 'No live data for this train.' } };

    const r = summarize({ rt, v, geo, nowSec: now.getTime() / 1000, calling });

    return {
        status: 200,
        body: {
            trainNumber:  num,
            delayMinutes: r.delayMinutes,     // null unless there's a TripUpdate
            hasLiveDelay: !!rt,               // false ⇒ running on position alone
            progressSource: r.progressSource, // 'feed' | 'position' | null
            progressPercentage: r.progressPercentage, // set only when derived from position
            nextStation:  r.nextStation,
            nextStationId: r.nextStationId,
            previousStationId: r.previousStationId,
            stops:        r.stops,
            position:     v ? positionOf(v) : null,
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
    const v  = cache.getVehicle(num);
    // With a position, the TripUpdate must be that vehicle's OWN run.
    const rt = v ? cache.getTripFor(num, v.tripId) : cache.getTrain(num);

    // Static geometry only matters when we're deriving progress from a position
    // (no TripUpdate). Loaded by the vehicle's own trip_id, so a number with two
    // active trips resolves to the exact run we have a position for.
    const geo = (!rt && v && v.tripId) ? geometryOf.getByTripId(v.tripId) : null;
    const meta = rt ? tripMeta.get(rt.tripId) : null;

    const { status, body } = buildTrainStatus({ num, rt, v, geo, calling: meta ? meta.callingStationIds : null });
    res.status(status).json(body);
};

exports._buildTrainStatus = buildTrainStatus; // exported for unit tests
exports._buildVehicleEntry = buildVehicleEntry;

/**
 * GET /api/realtime/vehicle/:trainNo
 * Live GPS position + bearing of a running train.
 */
exports.getVehicle = (req, res) => {
    const num = req.params.trainNo;
    const v = cache.getVehicle(num);
    if (!v) return res.status(404).json({ error: 'No live position for this train.' });
    res.json({ trainNumber: num, ...positionOf(v) });
};

// ETag for /vehicles: changes exactly when either feed ticks or a feed goes
// stale (the body then empties / loses its delays), so a 304 is never wrong
// about anything but a next-stop that moved inside one feed tick.
function vehiclesEtag(st) {
    return `"v${st.vehicleFeedTs || 0}-t${st.tripFeedTs || 0}-${st.vehicleFresh ? 1 : 0}${st.tripFresh ? 1 : 0}"`;
}

/**
 * One map dot: the position as published, plus what the dot needs to be coloured
 * and labelled without a request per train. Delay fields come from the same
 * summarize() as /train/:no, for the vehicle's own run.
 */
function buildVehicleEntry(num, v, nowMs) {
    const rt   = cache.getTripFor(num, v.tripId);
    const geo  = (!rt && v.tripId) ? geometryOf.getByTripId(v.tripId) : null;
    const meta = tripMeta.get(v.tripId);
    const r = summarize({
        rt, v, geo, nowSec: nowMs / 1000,
        calling: meta ? meta.callingStationIds : null,
    });
    return {
        trainNumber: num,
        ...positionOf(v),
        delayMinutes: r.delayMinutes,
        hasLiveDelay: !!rt,
        progressSource: r.progressSource,
        trainType: meta ? meta.trainType : null,
        originStationId: meta ? meta.originStationId : null,
        destinationStationId: meta ? meta.destinationStationId : null,
        nextStationId: r.nextStationId,
        previousStationId: r.previousStationId,
        serviceDate: meta ? tripMeta.deriveServiceDate(meta, v.positionTimestamp ?? nowMs) : null,
    };
}

/**
 * GET /api/realtime/vehicles
 * Every running train's MEASURED position — for the map / "radar". Every entry
 * is a VehiclePositions fix; nothing is interpolated or projected. Stale
 * vehicles are not filtered: positionTimestamp says how old each one is.
 *
 * Polling is cheap: ETag + If-None-Match → 304 while neither feed has ticked.
 */
exports.getVehicles = (req, res) => {
    const st = cache.status();
    const etag = vehiclesEtag(st);
    res.set('ETag', etag);
    // private: the response sits behind the API key, a shared cache must not replay it.
    res.set('Cache-Control', 'private, max-age=5');
    if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();

    const nowMs = Date.now();
    const vehicles = cache.getAllVehicles().map(([num, v]) => buildVehicleEntry(num, v, nowMs));
    res.json({ count: vehicles.length, feedTimestamp: st.vehicleFeedTs, vehicles });
};

/**
 * GET /api/realtime/status  — poller/cache health (debugging).
 */
exports.getStatus = (req, res) => res.json(cache.status());
