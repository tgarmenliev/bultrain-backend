'use strict';

/**
 * cache.js — in-memory store for the latest GTFS-Realtime data.
 *
 * Realtime changes every few seconds, so it lives only in memory (never
 * SQLite — that would be pure write amplification). Freshness is judged by the
 * feed's OWN timestamp, not our fetch time: if БДЖ stops publishing, the data
 * goes stale and we report "no live data" rather than serving a frozen delay.
 */

const MAX_AGE_MS = 3 * 60 * 1000; // older than this ⇒ treated as no live data

const state = {
    trips:    new Map(),  // trainNumber -> [{ tripId, stops: [...] }, ...]
    vehicles: new Map(),  // trainNumber -> { tripId, lat, lon, bearing, positionTimestamp, stopStatus }
    tripFeedTs:    0,     // ms epoch from the TripUpdates feed header
    vehicleFeedTs: 0,     // ms epoch from the VehiclePositions feed header
    version: 0,           // bumps whenever either feed's data is replaced
};

const fresh = (ts) => ts > 0 && (Date.now() - ts) < MAX_AGE_MS;

// How the polls themselves are doing — separate from how fresh the DATA is, so an
// operator can tell "БДЖ publishes nothing" from "we cannot reach the source".
const polls = {
    trips:    { lastOkAt: 0, failures: 0, lastError: null },
    vehicles: { lastOkAt: 0, failures: 0, lastError: null },
};
function pollOk(kind)           { Object.assign(polls[kind], { lastOkAt: Date.now(), failures: 0, lastError: null }); }
function pollFailed(kind, msg)  { polls[kind].failures += 1; polls[kind].lastError = String(msg).slice(0, 200); }

function setTrips(map, feedTsMs)    { state.trips = map;    state.tripFeedTs = feedTsMs; state.version++; }
function setVehicles(map, feedTsMs) { state.vehicles = map; state.vehicleFeedTs = feedTsMs; state.version++; }

// Changes exactly when the cached data does — a key for anything derived from it.
function version() { return state.version; }

// A train number can carry more than one active trip at once — an overnight
// service where yesterday's run is still on the road while today's is scheduled
// (16102 does this). Keying the cache by number alone dropped one; we keep them
// all and, for a by-number query, return the run that's actually in progress:
// mid-route first (some stop passed AND some still ahead), then the one whose
// next stop is soonest. Callers still get a single trip, so nothing downstream
// changes.
function pickActive(trips) {
    if (!Array.isArray(trips)) return trips || null;   // tolerate legacy shape
    if (trips.length <= 1) return trips[0] || null;

    const nowSec = Date.now() / 1000;
    let best = null;
    let bestRank = null;
    for (const t of trips) {
        const times = (t.stops || [])
            .map(s => s.arrivalTime ?? s.departureTime)
            .filter(x => x != null);
        const upcoming = times.filter(x => x >= nowSec).sort((a, b) => a - b);
        const midRoute = upcoming.length > 0 && times.some(x => x < nowSec);
        const nextUp = upcoming[0] ?? Infinity;
        const rank = { midRoute, nextUp };
        // mid-route beats not; among equals, the sooner next stop wins.
        if (!best
            || (rank.midRoute && !bestRank.midRoute)
            || (rank.midRoute === bestRank.midRoute && rank.nextUp < bestRank.nextUp)) {
            best = t;
            bestRank = rank;
        }
    }
    return best;
}

function getTrain(num)   { return fresh(state.tripFeedTs)    ? pickActive(state.trips.get(num)) : null; }
// The TripUpdate of the EXACT run a vehicle belongs to. When the vehicle's own
// trip is not in the feed we return null rather than another run of the same
// number: attaching tomorrow's (or yesterday's) delay to this dot would be a
// confident claim about the wrong train. Without a trip id, fall back to the
// by-number pick.
function getTripFor(num, tripId) {
    if (!fresh(state.tripFeedTs)) return null;
    const list = state.trips.get(num);
    if (!tripId) return pickActive(list);
    return (Array.isArray(list) ? list : []).find(t => t.tripId === tripId) || null;
}
function getTrips(num)   { return fresh(state.tripFeedTs)    ? (state.trips.get(num) || [])   : []; }
function getVehicle(num) { return fresh(state.vehicleFeedTs) ? (state.vehicles.get(num) || null) : null; }
// Every number the TripUpdates feed lists, each with its in-progress run — for
// anything that must enumerate trains rather than look one up by number.
function getAllTrains() {
    if (!fresh(state.tripFeedTs)) return [];
    return [...state.trips.keys()].map(num => [num, pickActive(state.trips.get(num))]).filter(([, t]) => t);
}
function getAllVehicles(){ return fresh(state.vehicleFeedTs) ? [...state.vehicles.entries()] : []; }

function status() {
    return {
        tripFeedTs:     state.tripFeedTs || null,
        vehicleFeedTs:  state.vehicleFeedTs || null,
        trips:          state.trips.size,
        vehicles:       state.vehicles.size,
        tripFresh:      fresh(state.tripFeedTs),
        vehicleFresh:   fresh(state.vehicleFeedTs),
        polls: {
            trips:    { ...polls.trips,    lastOkAt: polls.trips.lastOkAt || null },
            vehicles: { ...polls.vehicles, lastOkAt: polls.vehicles.lastOkAt || null },
        },
    };
}

module.exports = { setTrips, setVehicles, getTrain, getTripFor, getTrips, getVehicle, getAllVehicles, getAllTrains, status, version, pollOk, pollFailed, MAX_AGE_MS };
