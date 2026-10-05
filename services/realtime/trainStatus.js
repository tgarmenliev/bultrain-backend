'use strict';

/**
 * trainStatus.js — how a running train's delay, progress and next stop are
 * decided from the two realtime feeds and the trip's static geometry.
 *
 * Pure (no req/res, no DB): GET /realtime/train/:no, GET /realtime/vehicles and
 * the public network snapshot all go through summarize(), so the dot on the
 * map, the screen it opens and the numbers on the website can never disagree.
 */

const progress = require('./progress');

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
    // The last stop the train has already passed AND calls at: the same `passed`
    // and callingPoint as in `stops`, so the stop list, the dot and this cannot disagree.
    let previousStationId = null;
    named.forEach((s, i) => {
        if (stops[i].passed === true && stops[i].callingPoint !== false) previousStationId = s.stationId;
    });
    return {
        stops,
        delayMinutes:  ref ? toMin(ref.arrivalDelay ?? ref.departureDelay) : null,
        nextStation:   upcoming[0] ? upcoming[0].station : null,
        nextStationId: nextCalling ? nextCalling.stationId : null,
        previousStationId,
    };
}

// Where a measured position sits on the trip's own route, or null when the
// geometry is unusable or the position doesn't match the route.
function locateOnRoute(v, geo) {
    const stopPts = geo.stops.map(s => ({ lat: s.lat, lon: s.lon }));
    const linePts = (geo.shape && geo.shape.length >= 2) ? geo.shape : stopPts;

    let line;
    try { line = progress.prepareLine(linePts); } catch { return null; }

    const loc = progress.locate(line, stopPts, { lat: v.lat, lon: v.lon });
    if (loc.offsetMeters > MAX_OFFSET_M) return null; // position off this route
    return loc;
}

// 0..1 along the route for a measured position, null when it cannot be placed.
function progressOf(v, geo) {
    if (!v || !geo) return null;
    const loc = locateOnRoute(v, geo);
    return loc ? Number(loc.progress.toFixed(4)) : null;
}

// Stops + progress from a GPS position projected onto the trip's static
// geometry. Honest by construction: it reports where the train IS and which
// stop is ahead, and NO delay or predicted time (we have neither). Returns null
// when the geometry is unusable or the position doesn't match the route.
function fromPosition(v, geo) {
    const loc = locateOnRoute(v, geo);
    if (!loc) return null;

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
        previousStationId: loc.lastPassedIndex >= 0 ? geo.stops[loc.lastPassedIndex].stationId : null,
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
            nextStationId: f.nextStationId, previousStationId: f.previousStationId,
            progressSource: 'feed', progressPercentage: null,
        };
    }
    if (v && geo) {
        const p = fromPosition(v, geo);
        if (p) {
            return {
                stops: p.stops, delayMinutes: null, nextStation: p.nextStation,
                nextStationId: p.nextStationId, previousStationId: p.previousStationId,
                progressSource: 'position',
                progressPercentage: p.progressPercentage,
            };
        }
    }
    return {
        stops: [], delayMinutes: null, nextStation: null, nextStationId: null,
        previousStationId: null, progressSource: null, progressPercentage: null,
    };
}

// The vehicle as sent to clients: where, when it was measured, and whether it is
// at a stop. Both timestamp and status are null when the feed did not say.
// lat/lon/bearing are passed through exactly as before — shipped apps read them.
const positionOf = (v) => ({
    lat: v.lat, lon: v.lon, bearing: v.bearing,
    positionTimestamp: v.positionTimestamp ?? null,
    stopStatus: v.stopStatus ?? null,
    // Which station a STOPPED_AT train stands at; null in transit or when the feed's
    // stop is not one of ours.
    stoppedAtStationId: v.stopStatus === 'STOPPED_AT' ? (v.stopStationId ?? null) : null,
});

module.exports = { hhmm, toMin, summarize, fromFeed, fromPosition, progressOf, positionOf, callingPointOf, MAX_OFFSET_M };
