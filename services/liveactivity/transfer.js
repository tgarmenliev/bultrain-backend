'use strict';

/**
 * transfer.js — the moment between two legs of a journey, from the server's side.
 *
 * Two questions, both answered from what the server already holds:
 *
 *  - forRow(): the passenger has got off leg k-1 and is waiting for leg k (the row's own train).
 *    The card then shows the transfer — where to change, what to wait for, and whether the change
 *    works out — instead of the train they have just left.
 *  - legArrivedByFeed(): did the feed see leg k-1 reach its destination? The app says so itself
 *    (/leg-arrived, its arrival geofence), but one callback from a phone is not a thing a journey
 *    should hang on: with no network, or the app killed, the card would sit on the finished train
 *    and then be ended or deleted in the middle of the change.
 */

const armedStore   = require('./armedStore');
const contentState = require('./contentState');
const { getRunFor, getVehicle } = require('./feedFor');

// The feed's arrival time for the destination, plus this, before the train counts as arrived when
// nothing better (a position at the platform, or past it) says so. A late train's prediction slides
// forward while it is on its way, so a prediction that has stayed in the past this long is real.
const FEED_ARRIVED_GRACE_S = 5 * 60;

// A leg stopped because its arrival was never confirmed did finish, as far as the next leg cares.
const FINISHED_REASONS = new Set(['arrival-not-confirmed']);

const legIsFinished = (leg) =>
    leg.state === 'arrived' || (leg.state === 'stopped' && FINISHED_REASONS.has(leg.stopped_reason));

/**
 * @param {object} tokenRow  live_activity_tokens row (or an armed_journeys row asTokenRow()'d): the leg k
 * @returns {{arrivalUnix:number}|null}  null when this is not a transfer
 *          (first leg, previous leg unknown or still under way)
 */
function forRow(tokenRow) {
    const k = tokenRow.current_leg_index ?? 0;
    if (k <= 0 || !tokenRow.journey_id) return null;

    const prev = armedStore.getLeg(tokenRow.journey_id, k - 1);
    if (!prev || !legIsFinished(prev)) return null;

    // When the train they got off reached (or reaches) the station where they change: the feed's
    // own prediction, else its timetable — the same rule the connection check uses elsewhere.
    const rt = getRunFor(prev);
    const stops = rt && Array.isArray(rt.stops) ? rt.stops.filter(s => s.station) : [];
    const dIdx = stops.length ? contentState.findStopIndex(stops, prev.destination_station) : -1;
    const predicted = dIdx >= 0 ? (stops[dIdx].arrivalTime ?? stops[dIdx].departureTime ?? null) : null;

    return { arrivalUnix: predicted ?? Math.floor(Date.parse(prev.scheduled_arrival) / 1000) };
}

/**
 * Has the feed seen this leg reach its destination?
 *
 * The train's position decides when it has one (past the destination, or standing at it); a
 * position that is still short of the destination says "not yet" whatever the clock says. Without
 * a usable position the destination's predicted arrival has to be a few minutes in the past.
 * Nothing at all from the feed (no run, stop not found, no times) is "don't know", never "yes".
 *
 * @param {object} row  armed_journeys row of the leg
 * @param {number} nowSec
 */
function legArrivedByFeed(row, nowSec) {
    const rt = getRunFor(row);
    if (!rt || !Array.isArray(rt.stops)) return false;
    const stops = rt.stops.filter(s => s.station);
    const dIdx = contentState.findStopIndex(stops, row.destination_station);
    if (dIdx < 0) return false;

    const v = getVehicle(row.train_number);
    const sameRun = v && v.stopStationId != null && (!v.tripId || !rt.tripId || v.tripId === rt.tripId);
    if (sameRun) {
        const at = stops.findIndex(s => s.stationId === v.stopStationId);
        if (at > dIdx) return true;                                    // already past it
        if (at === dIdx && v.stopStatus === 'STOPPED_AT') return true; // standing at the platform
        if (at >= 0 && at < dIdx) return false;                        // still on its way to it
    }
    const arr = stops[dIdx].arrivalTime ?? stops[dIdx].departureTime ?? null;
    return arr != null && nowSec >= arr + FEED_ARRIVED_GRACE_S;
}

module.exports = { forRow, legArrivedByFeed, legIsFinished, FEED_ARRIVED_GRACE_S };
