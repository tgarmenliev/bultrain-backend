'use strict';

/**
 * realtimeGate.js — keeps the Live Activity worker and the armed-journey watcher
 * from acting on realtime data that is not there.
 *
 * With no usable trip feed, contentState.build() falls back to the SCHEDULED
 * arrival, which for a late train is wrong in ways that cannot be undone: the
 * worker ends the activity and deletes its token, the armed watcher auto-stops
 * the journey off scheduled+45min, and an ordinary update blanks the delay off
 * the card. "No data" is not evidence that the train has arrived, so while the
 * feed is unusable a real train is simply left alone. Two situations, one rule:
 *
 *  1. WARM-UP after a restart. server.js starts the poller without awaiting it
 *     and the worker ticks at once, so the first tick runs against an EMPTY
 *     cache. Held for at most WARMUP_GRACE_MS from process start.
 *
 *  2. STALE feed mid-journey. cache.getTrain() returns null once the trip feed
 *     is over 3 minutes old (BDZ hiccups, network trouble). A late train would
 *     hit exactly the same fallback. Held, but never for ever: only until the
 *     train's own SCHEDULED arrival + STALE_HOLD_AFTER_ARRIVAL_MS. Past that the
 *     journey is treated as over even without data, as it always was.
 *
 * "Usable" means FRESH (cache.status().tripFresh), not merely "a feed has ever
 * arrived": a feed that loaded with an old timestamp still makes getTrain()
 * return null, so it must not release the hold.
 *
 * Inert unless REALTIME=on, and never applies to TEST- trains, which resolve
 * from testFeed and not from the cache.
 */

const cache    = require('../realtime/cache');
const testFeed = require('./testFeed');

const WARMUP_GRACE_MS = 2 * 60 * 1000;

// How long past its scheduled arrival a journey is still left alone while the
// feed is stale. Kept below the 2h after which tokens are pruned anyway.
const STALE_HOLD_AFTER_ARRIVAL_MS = 90 * 60 * 1000;

let bootMs = Date.now();
let warmupHeldLogged = false;
let warmupReleasedLogged = false;
let staleLogged = false;

/**
 * True while `trainNumber`'s data cannot be trusted and acting on it would be
 * destructive or misleading.
 *
 * @param {string} trainNumber
 * @param {number} nowMs
 * @param {string|null} scheduledArrival  ISO time. Pass it to ALSO apply the
 *        stale-feed hold (worker rows, and the watcher's auto-stop). Omit it to
 *        apply only the post-restart warm-up hold (e.g. before starting a card,
 *        which should go out on schedule whether or not the feed is up).
 */
function holds(trainNumber, nowMs = Date.now(), scheduledArrival = null) {
    if (process.env.REALTIME !== 'on') return false;
    if (testFeed.isTestTrain(trainNumber)) return false;

    if (cache.status().tripFresh) {
        if (warmupHeldLogged && !warmupReleasedLogged) {
            warmupReleasedLogged = true;
            console.log(`[rt-gate] fresh trip feed after ${Math.round((nowMs - bootMs) / 1000)}s — resuming`);
        }
        if (staleLogged) {
            staleLogged = false;
            console.log('[rt-gate] trip feed is fresh again — resuming normal handling');
        }
        return false;
    }

    // 1. Warm-up.
    const waitedMs = nowMs - bootMs;
    if (waitedMs < WARMUP_GRACE_MS) {
        if (!warmupHeldLogged) {
            warmupHeldLogged = true;
            console.log(`[rt-gate] no fresh trip feed yet — holding Live Activity pushes and journey ` +
                        `tracking until it lands (at most ${WARMUP_GRACE_MS / 1000}s)`);
        }
        return true;
    }
    if (warmupHeldLogged && !warmupReleasedLogged) {
        warmupReleasedLogged = true;
        console.log(`[rt-gate] no fresh trip feed after ${Math.round(waitedMs / 1000)}s — warm-up hold over`);
    }

    // 2. Stale feed: leave a journey alone until its own arrival + the bound.
    if (scheduledArrival != null) {
        const arrivalMs = Date.parse(scheduledArrival);
        if (Number.isFinite(arrivalMs) && nowMs < arrivalMs + STALE_HOLD_AFTER_ARRIVAL_MS) {
            if (!staleLogged) {
                staleLogged = true;
                console.log(`[rt-gate] trip feed is stale — leaving live journeys as they are (no end, no auto-stop, ` +
                            `no update) until ${STALE_HOLD_AFTER_ARRIVAL_MS / 60000} min past each one's scheduled arrival`);
            }
            return true;
        }
    }
    return false;
}

/** Tests only: start the clock and the log-once flags over. */
function _reset() {
    bootMs = Date.now();
    warmupHeldLogged = false;
    warmupReleasedLogged = false;
    staleLogged = false;
}

module.exports = { holds, _reset, WARMUP_GRACE_MS, STALE_HOLD_AFTER_ARRIVAL_MS };
