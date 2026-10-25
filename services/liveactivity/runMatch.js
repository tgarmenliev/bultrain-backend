'use strict';

/**
 * runMatch.js — which TripUpdate belongs to THIS journey.
 *
 * The realtime feed is keyed by train number, but a number runs every day, and the feed does not
 * always drop yesterday's run in time: on 2026-10-25, the day the clocks changed, it still carried
 * fifteen runs from the 24th at 11:00. For a passenger who saved the 11:09 train that morning the
 * server picked yesterday's run by number — whose "departure 11:09" was a day in the past, so the card
 * started at once, said the train had already left, and counted down to yesterday's arrival (12:11
 * on a phone in winter time).
 *
 * A run belongs to a journey when the instant the FEED says the boarding stop was scheduled for
 * (its time minus its delay) is the instant the passenger registered. Anything else is another day's
 * train, however well the number matches, and is not used: no live data is honest, yesterday's is not.
 */

const contentState = require('./contentState');

const SCHEDULE_MATCH_S = 30 * 60;      // the feed's scheduled instant vs the registered one (a run of the same number never comes twice in half an hour)
const LOOSE_MATCH_S    = 3 * 60 * 60;  // when the feed gives a time but no delay: at least the right DAY

/** The scheduled instant (unix s) the feed implies for a stop, or an approximation, or null. */
function impliedSchedule(stop) {
    if (stop.departureTime != null && stop.departureDelay != null) return { at: stop.departureTime - stop.departureDelay, exact: true };
    if (stop.arrivalTime != null && stop.arrivalDelay != null)     return { at: stop.arrivalTime - stop.arrivalDelay, exact: true };
    const t = stop.departureTime ?? stop.arrivalTime;
    return t != null ? { at: t, exact: false } : null;
}

/**
 * @param {object[]} runs  the TripUpdate runs the feed holds for the train number
 * @param {object} row     a journey: boarding_station, scheduled_departure (ISO)
 * @returns {object|null}  the run that is this journey's, or null
 */
function matchRun(runs, row) {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    const want = Date.parse(row.scheduled_departure) / 1000;
    if (!Number.isFinite(want)) return runs.length === 1 ? runs[0] : null;

    let unverifiable = null;
    for (const run of runs) {
        const stops = (run.stops || []).filter(s => s.station);
        const b = contentState.findStopIndex(stops, row.boarding_station);
        const implied = b >= 0 ? impliedSchedule(stops[b]) : null;
        if (!implied) { unverifiable = unverifiable || run; continue; }      // cannot be checked: as before
        if (Math.abs(implied.at - want) <= (implied.exact ? SCHEDULE_MATCH_S : LOOSE_MATCH_S)) return run;
    }
    return unverifiable;     // runs that WERE checked and disagreed are never returned
}

module.exports = { matchRun, impliedSchedule, SCHEDULE_MATCH_S };
