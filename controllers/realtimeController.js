'use strict';

const cache      = require('../services/realtime/cache');
const geometryOf = require('../services/gtfs/tripGeometry');
const progress   = require('../services/realtime/progress');
const tripMeta   = require('../services/realtime/tripMeta');

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

// Is this stop one the train really calls at? The feed lists timing points the
// train only passes (a 27-stop itinerary arrives as 47 stops) and marks stops it
// will skip. true/false when we can tell, null when we cannot (trip unknown to
// the saved schedule) — never guessed.
function callingPointOf(s, calling) {
    if (s.skipped) return false;
    return calling ? calling.has(s.stationId) : null;
}

// Stops + headline delay from a TripUpdate (the feed's own predicted times).
// `calling` is the Set of station ids the trip calls at, or null when unknown.
function fromFeed(rt, nowSec, calling = null) {
    const named = rt.stops.filter(s => s.stationId != null);
    const stops = named.map(s => {
        // A trip's ORIGIN has no arrival at all — only departure. Without this
        // fallback, predictedArrival/passed were both null there forever, even
        // once the train had clearly left: the one stop where a delay matters
        // most (waiting at the boarding platform) was the one stop the response
        // could never actually confirm.
        const refTime = s.arrivalTime ?? s.departureTime;
        return {
            station:            s.station,
            stationId:          s.stationId,
            predictedArrival:   hhmm(s.arrivalTime),
            predictedDeparture: hhmm(s.departureTime),
            arrivalDelayMin:    toMin(s.arrivalDelay),
            departureDelayMin:  toMin(s.departureDelay),
            passed:             refTime ? (refTime < nowSec) : null,
            callingPoint:       callingPointOf(s, calling),
        };
    });
    const upcoming = named.filter(s => s.arrivalTime && s.arrivalTime >= nowSec);
    const ref = upcoming[0] || named[named.length - 1];
    // nextStation is unchanged (it may name a timing point); nextStationId is
    // the next stop the train really CALLS at.
    const nextCalling = upcoming.find(s => callingPointOf(s, calling) !== false);
    return {
        stops,
        delayMinutes:  ref ? toMin(ref.arrivalDelay ?? ref.departureDelay) : null,
        nextStation:   upcoming[0] ? upcoming[0].station : null,
        nextStationId: nextCalling ? nextCalling.stationId : null,
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
        nextStationId: loc.nextIndex != null ? geo.stops[loc.nextIndex].stationId : null,
    };
}

/**
 * The one place that decides a train's delay / progress, shared by
 * GET /train/:no and GET /vehicles so the dot on the map and the screen it
 * opens can never disagree. A TripUpdate wins; otherwise a position that fits
 * the trip's route; otherwise nothing — and with no TripUpdate the delay is
 * null, never 0.
 */
function summarize({ rt, v, geo, nowSec, calling = null }) {
    if (rt) {
        const f = fromFeed(rt, nowSec, calling);
        return {
            stops: f.stops, delayMinutes: f.delayMinutes, nextStation: f.nextStation,
            nextStationId: f.nextStationId, progressSource: 'feed', progressPercentage: null,
        };
    }
    if (v && geo) {
        const p = fromPosition(v, geo);
        if (p) {
            return {
                stops: p.stops, delayMinutes: null, nextStation: p.nextStation,
                nextStationId: p.nextStationId, progressSource: 'position',
                progressPercentage: p.progressPercentage,
            };
        }
    }
    return {
        stops: [], delayMinutes: null, nextStation: null, nextStationId: null,
        progressSource: null, progressPercentage: null,
    };
}

// The vehicle as sent to clients: where, when it was measured, and whether it is
// at a stop. Both timestamp and status are null when the feed did not say.
// lat/lon/bearing are passed through exactly as before — shipped apps read them.
const positionOf = (v) => ({
    lat: v.lat, lon: v.lon, bearing: v.bearing,
    positionTimestamp: v.positionTimestamp ?? null,
    stopStatus: v.stopStatus ?? null,
});

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

const etagMatches = (header, etag) => {
    if (!header) return false;
    return header.split(',').some(t => {
        const v = t.trim();
        return v === '*' || v.replace(/^W\//, '') === etag;
    });
};

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
