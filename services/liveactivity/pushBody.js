'use strict';

/**
 * pushBody.js — wraps a content-state object in the APNs aps body.
 *
 * Pulled out of worker.js so armedWatcher.js can build an ordinary 'update'
 * push (for retargeting an existing Activity onto the next leg, see
 * retargetExistingActivity in armedWatcher.js) without requiring worker.js —
 * worker.js already requires armedWatcher.js, and a require the other way
 * would be circular (CommonJS would hand back a still-empty module.exports,
 * since worker.js's own exports are only assigned at the bottom of the file,
 * after its top-level requires — including this one — have already run).
 */

const STALE_AFTER_MS = 15 * 60 * 1000;

/** Wrap a content-state in the APNs body. */
function buildBody(state, { nowSec, predictedArrivalUnix, event = 'update', dismissalUnix }) {
    // A visibly stale card is better than a confidently wrong one: if pushes
    // stop, iOS dims it rather than presenting old data as current.
    let staleDate = nowSec + STALE_AFTER_MS / 1000;
    if (predictedArrivalUnix && predictedArrivalUnix > nowSec && predictedArrivalUnix < staleDate) {
        staleDate = predictedArrivalUnix;
    }
    const aps = {
        // This one IS a plain Unix timestamp — only the fields inside
        // content-state use the 2001 reference date.
        timestamp: nowSec,
        event,
        'stale-date': Math.floor(staleDate),
        'content-state': state,
    };
    if (event === 'end') aps['dismissal-date'] = Math.floor(dismissalUnix ?? nowSec);
    return JSON.stringify({ aps });
}

module.exports = { buildBody, STALE_AFTER_MS };
