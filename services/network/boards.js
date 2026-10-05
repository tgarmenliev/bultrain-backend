'use strict';

/**
 * boards.js — the departure boards of Sofia and Plovdiv for the public network
 * snapshot.
 *
 * Built from our own data (services/live/ownBoard.js: the saved schedule plus the
 * realtime delays), NOT scraped from БДЖ. The first version scraped live.bdz.bg,
 * and from the server that site never answered (connect timeouts for hours), so
 * the boards never loaded. Nothing here makes a request outside the process, which
 * also makes it as cheap as the rest of the snapshot: a few milliseconds per build.
 *
 * Each train carries `hasLiveDelay`: true when the realtime feed has a delay for it
 * at this station, false when the time shown is the schedule's and nothing is known
 * about punctuality. `trains` is null only when the board could not be built.
 */

const ownBoard = require('../live/ownBoard');

const BOARDS = [
    { key: 'sofia',   name: 'София',   stationId: 2 },
    { key: 'plovdiv', name: 'Пловдив', stationId: 3 },
];

const MAX_TRAINS = 8;

let loggedFailure = false;

/** What the snapshot publishes for the boards at `nowMs`. */
function view(nowMs = Date.now()) {
    const out = {};
    for (const b of BOARDS) {
        let trains = null;
        try {
            const board = ownBoard.build({
                stationId: b.stationId, type: 'departures', language: 'bg',
                nowMs, limit: MAX_TRAINS, extended: true,
            });
            trains = board ? board.trains : null;
            loggedFailure = false;
        } catch (err) {
            if (!loggedFailure) console.error(`[network] board "${b.key}" failed:`, err.message);
            loggedFailure = true;
        }
        out[b.key] = { name: b.name, trains, fetchedAt: new Date(nowMs).toISOString() };
    }
    return out;
}

/** Tests only. */
function _reset() { loggedFailure = false; }

module.exports = { view, _reset, MAX_TRAINS };
