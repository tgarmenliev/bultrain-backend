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
    trips:    new Map(),  // trainNumber -> { tripId, stops: [...] }
    vehicles: new Map(),  // trainNumber -> { tripId, lat, lon, bearing }
    tripFeedTs:    0,     // ms epoch from the TripUpdates feed header
    vehicleFeedTs: 0,     // ms epoch from the VehiclePositions feed header
};

const fresh = (ts) => ts > 0 && (Date.now() - ts) < MAX_AGE_MS;

function setTrips(map, feedTsMs)    { state.trips = map;    state.tripFeedTs = feedTsMs; }
function setVehicles(map, feedTsMs) { state.vehicles = map; state.vehicleFeedTs = feedTsMs; }

function getTrain(num)   { return fresh(state.tripFeedTs)    ? (state.trips.get(num)    || null) : null; }
function getVehicle(num) { return fresh(state.vehicleFeedTs) ? (state.vehicles.get(num) || null) : null; }
function getAllVehicles(){ return fresh(state.vehicleFeedTs) ? [...state.vehicles.entries()] : []; }

function status() {
    return {
        tripFeedTs:     state.tripFeedTs || null,
        vehicleFeedTs:  state.vehicleFeedTs || null,
        trips:          state.trips.size,
        vehicles:       state.vehicles.size,
        tripFresh:      fresh(state.tripFeedTs),
        vehicleFresh:   fresh(state.vehicleFeedTs),
    };
}

module.exports = { setTrips, setVehicles, getTrain, getVehicle, getAllVehicles, status, MAX_AGE_MS };
