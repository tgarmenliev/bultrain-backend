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
// `v` is the train's own vehicle (cache), when it has one.
function fromFeed(rt, nowSec, calling = null, v = null) {
    const named = rt.stops.filter(s => s.stationId != null);

    // Where the train IS, when the vehicle feed says so — the stop it stands at or is heading
    // to, as an index into this trip — and only for the SAME run (an overnight run of the same
    // number may still be on the road). The feed's predicted times are often stale; a position
    // is a measurement, so it outranks them wherever it speaks.
    let at = -1;
    if (v && v.stopStationId != null && (!v.tripId || !rt.tripId || v.tripId === rt.tripId)) {
        at = named.findIndex(s => s.stationId === v.stopStationId);
    }
    const standing = at >= 0 && v.stopStatus === 'STOPPED_AT';

    const stops = named.map((s, i) => {
        // A stop is PASSED once the train has LEFT it: its departure, else its arrival. A train
        // that has pulled in and is standing there (a long dwell: 11 minutes in Sofia) has not
        // passed the stop, and a passenger waiting to board on that platform must not be told it
        // has. A trip's ORIGIN has no arrival at all, only a departure, and a terminus only an
        // arrival — each uses what it has, so neither is ever stuck "not passed".
        const refTime = s.departureTime ?? s.arrivalTime;
        const calls = callingPointOf(s, calling);
        let passed = refTime ? (refTime < nowSec) : null;

        // With the train's position: the stop it stands at, is heading to, or is yet to reach is
        // NOT passed however stale the clock is (a late train that is still approaching, or
        // standing on its platform, after its predicted time); a CALLING stop before it is passed
        // even if the feed's times still say otherwise. A timing point before it may lie between
        // the train and its next calling stop, so for those the clock still decides.
        if (at >= 0) {
            if (i >= at) passed = false;
            else if (calls === true) passed = true;
        }
        return {
            station:            s.station,
            stationId:          s.stationId,
            predictedArrival:   hhmm(s.arrivalTime),
            predictedDeparture: hhmm(s.departureTime),
            arrivalDelayMin:    toMin(s.arrivalDelay),
            departureDelayMin:  toMin(s.departureDelay),
            passed,
            callingPoint:       calls,
        };
    });
    const upcoming = named.filter(s => s.arrivalTime && s.arrivalTime >= nowSec);
    const ref = upcoming[0] || named[named.length - 1];
    // nextStation is unchanged (it may name a timing point); nextStationId is
    // the next stop the train really CALLS at: by position when the train has one (the stop it is
    // heading to; the one after it while it stands at a stop), else by the predicted arrivals.
    let nextCalling;
    if (at >= 0) {
        nextCalling = named.find((s, i) => i >= (standing ? at + 1 : at) && callingPointOf(s, calling) !== false);
    } else {
        nextCalling = upcoming.find(s => callingPointOf(s, calling) !== false);
    }
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

// A trip's route, prepared once: the planar line and where each stop sits on it.
// Neither depends on the train, and `geo` is the object tripGeometry caches for an
// hour, so keying on it means a route is prepared once per trip, not once per
// vehicle per request (which cost ~20 ms per /vehicles call on a developer laptop
// and over 250 ms per map refresh on the server).
const routeIndex = new WeakMap();   // geo -> { line, stopAlong } | null
function indexOf(geo) {
    let idx = routeIndex.get(geo);
    if (idx === undefined) {
        const stopPts = geo.stops.map(s => ({ lat: s.lat, lon: s.lon }));
        const linePts = (geo.shape && geo.shape.length >= 2) ? geo.shape : stopPts;
        try {
            const line = progress.prepareLine(linePts);
            idx = { line, stopAlong: progress.prepareStops(line, stopPts) };
        } catch { idx = null; }
        routeIndex.set(geo, idx);
    }
    return idx;
}

// Where a measured position sits on the trip's own route, or null when the
// geometry is unusable or the position doesn't match the route.
function locateOnRoute(v, geo) {
    const idx = indexOf(geo);
    if (!idx) return null;
    const loc = progress.locatePrepared(idx.line, idx.stopAlong, { lat: v.lat, lon: v.lon });
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
        const f = fromFeed(rt, nowSec, calling, v);
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
