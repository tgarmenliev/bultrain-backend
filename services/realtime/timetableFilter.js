'use strict';

/**
 * timetableFilter.js — which live trains the apps and the website may see.
 *
 * The national feed also carries runs that are in no timetable: service, freight or one-off
 * movements (3401 / 3402 on 2026-11-25: trip id "3401-20261125", no category, no operator, no
 * position). Nobody can travel on them, so a train number the saved schedule does not know on ANY
 * date is kept out of the live cache — and with it out of every public answer.
 *
 * Kept from view, not thrown away: the poller records delay history for every train BEFORE this.
 */

// With at least this many trains in a feed, "most of them are unknown" means the schedule is wrong.
const MIN_TRAINS_TO_DOUBT = 20;

/**
 * @param {Map<string, any>} byNumber  one feed, keyed by train number
 * @param {Set<string>} scheduled      every train number in the saved schedule
 * @returns {{shown: Map, hidden: string[], outOfStep: number}} `outOfStep` > 0: that many are
 *   unknown, too many to believe, so nothing was hidden.
 */
function publicOnly(byNumber, scheduled) {
    const all = { shown: byNumber, hidden: [], outOfStep: 0 };
    if (scheduled.size === 0) return all;   // no schedule: nothing to judge by

    const unknown = [...byNumber.keys()].filter(num => !scheduled.has(num));
    if (unknown.length === 0) return all;
    // A schedule that knows less than half of what is running (a renumbering that reached the feed
    // first) would empty the map. Better to show everything and say so in the log.
    if (byNumber.size >= MIN_TRAINS_TO_DOUBT && unknown.length * 2 > byNumber.size) {
        return { ...all, outOfStep: unknown.length };
    }

    return {
        shown: new Map([...byNumber].filter(([num]) => scheduled.has(num))),
        hidden: unknown.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        outOfStep: 0,
    };
}

module.exports = { publicOnly, MIN_TRAINS_TO_DOUBT };
