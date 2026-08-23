'use strict';

/**
 * testFeed.js — synthetic realtime data for END-TO-END TESTING of the armed-
 * journey pipeline (arm → push-to-start → live content → delay alert → leg
 * transition), without waiting for a real train.
 *
 * DELIBERATELY NOT part of services/realtime/cache.js. That module backs
 * GET /api/realtime/vehicles — the public map "radar" — which dumps its
 * entire in-memory state with no cross-check against the real schedule. A
 * synthetic entry living there would appear as a live train to every real
 * user browsing the map while a test is running. This module is consulted
 * ONLY by armedWatcher.js and worker.js, each call site falling back to the
 * real cache for anything not a reserved test number — so it is invisible to
 * every read path a real user's device calls.
 *
 * The prefix check in set() is a hard guarantee, not just a convention: this
 * module structurally cannot hold data for a real (always-numeric) BDZ train
 * number, so it can never be used — by mistake or otherwise — to corrupt what
 * a real user sees for a real train.
 */

const TEST_TRAIN_PREFIX = 'TEST-';

const overrides = new Map(); // trainNumber -> { trip: {tripId, stops}, vehicle: {...}|null }

function isTestTrain(num) {
    return typeof num === 'string' && num.startsWith(TEST_TRAIN_PREFIX);
}

/**
 * @param trainNumber must start with TEST_TRAIN_PREFIX.
 * @param trip   { tripId?: string, stops: [{ station, arrivalTime?, departureTime?, arrivalDelay?, departureDelay? }] }
 * @param vehicle { lat, lon, bearing, tripId? } | null
 */
function set(trainNumber, { trip, vehicle = null } = {}) {
    if (!isTestTrain(trainNumber)) {
        throw new Error(`testFeed.set refused: "${trainNumber}" does not start with "${TEST_TRAIN_PREFIX}"`);
    }
    overrides.set(trainNumber, { trip: trip || null, vehicle });
}

function clear(trainNumber) { overrides.delete(trainNumber); }
function clearAll() { overrides.clear(); }

/** Same shape cache.getTrain() returns; null for anything not a live test override. */
function getTrain(num) {
    if (!isTestTrain(num)) return null;
    const entry = overrides.get(num);
    return entry ? entry.trip : null;
}

/** Same shape cache.getVehicle() returns; null for anything not a live test override. */
function getVehicle(num) {
    if (!isTestTrain(num)) return null;
    const entry = overrides.get(num);
    return entry ? entry.vehicle : null;
}

function list() { return [...overrides.keys()]; }

module.exports = { TEST_TRAIN_PREFIX, isTestTrain, set, clear, clearAll, getTrain, getVehicle, list };
