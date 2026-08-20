'use strict';

/**
 * armedLogic.js — the decisions behind server-driven tracking, as pure
 * functions: when to start the card, when a delay is worth a notification, and
 * when to give up on a journey that was armed but never taken.
 *
 * Kept free of the database, the clock and APNs so every rule can be tested
 * directly — these are the parts that run unattended overnight.
 */

// ── Task 1: when to push-to-start ────────────────────────────────────────────

const START_WINDOW_MS = 40 * 60 * 1000;   // W — how early the card appears
const CLAMP_EARLY_MS  = 2 * 60 * 60 * 1000; // never trigger absurdly early…
const CLAMP_LATE_MS   = 15 * 60 * 1000;     // …nor keep waiting past this
// A Live Activity lives at most 8h active + 4h stale. Starting one for a
// journey that ends beyond that would be misleading from the first second.
const MAX_JOURNEY_AHEAD_MS = 11 * 60 * 60 * 1000;

/**
 * @param {object} row                armed_journeys row
 * @param {number|null} predictedDepUnix  live predicted departure from the
 *                                        boarding station, if the trip is in the
 *                                        feed (it can be there before departure)
 * @param {Date} now
 * @returns {{shouldStart:boolean, reason:string, tSchedMs:number,
 *            tEffectiveMs:number, tTriggerMs:number, source:'schedule'|'predicted'}}
 */
function evaluateTrigger(row, predictedDepUnix, now = new Date()) {
    const nowMs   = now.getTime();
    const tSched  = new Date(row.scheduled_departure).getTime();
    const tArrive = new Date(row.scheduled_arrival).getTime();
    const tPred   = predictedDepUnix != null ? predictedDepUnix * 1000 : null;

    // Both branches are first-class: a train can be in the feed before it moves,
    // and one leaving EARLY matters more than one running late.
    const usePredicted = tPred != null && tPred < tSched;
    const tEffective = usePredicted ? tPred : tSched;

    let tTrigger = tEffective - START_WINDOW_MS;
    // Guard against a nonsense prediction dragging the card hours out of place.
    tTrigger = Math.max(tTrigger, tSched - CLAMP_EARLY_MS);
    tTrigger = Math.min(tTrigger, tSched + CLAMP_LATE_MS);

    const base = {
        tSchedMs: tSched,
        tEffectiveMs: tEffective,
        tTriggerMs: tTrigger,
        source: usePredicted ? 'predicted' : 'schedule',
    };

    if (row.state !== 'armed')            return { ...base, shouldStart: false, reason: 'not-armed' };
    if (tArrive - nowMs > MAX_JOURNEY_AHEAD_MS) {
        return { ...base, shouldStart: false, reason: 'ends-beyond-activity-lifetime' };
    }
    if (nowMs < tTrigger)                 return { ...base, shouldStart: false, reason: 'too-early' };
    return { ...base, shouldStart: true, reason: usePredicted ? 'predicted-departure' : 'scheduled-departure' };
}

// ── Task 2: when a delay is worth a notification ─────────────────────────────

const ALERT_MIN_DELAY_MIN  = 5;                // below this, not worth a push
const ALERT_CHANGE_MIN     = 5;                // material change since last told
const ALERT_MIN_INTERVAL_MS = 10 * 60 * 1000;  // never two alerts back to back
const ALERT_MAX_PER_LEG    = 5;

/**
 * @param {object} row      armed_journeys row (carries last_delay_min, alerts_sent)
 * @param {number|null} delayMin  the delay we can actually measure, or null when
 *                                the train has no realtime coverage at all
 * @returns {{shouldAlert:boolean, reason:string, kind?:'appeared'|'worse'|'better'|'recovered'}}
 */
function evaluateDelayAlert(row, delayMin, now = new Date()) {
    // Hard project rule: no data means no claim. Never "on time" without a
    // measurement behind it, and never a notification built on nothing.
    if (delayMin == null) return { shouldAlert: false, reason: 'no-coverage' };

    if (row.alerts_sent >= ALERT_MAX_PER_LEG) return { shouldAlert: false, reason: 'alert-cap' };
    if (row.last_alert_at) {
        const since = now.getTime() - new Date(row.last_alert_at).getTime();
        if (since < ALERT_MIN_INTERVAL_MS) return { shouldAlert: false, reason: 'too-soon' };
    }

    const last = row.last_delay_min;

    if (last == null) {
        return delayMin >= ALERT_MIN_DELAY_MIN
            ? { shouldAlert: true, reason: 'delay-appeared', kind: 'appeared' }
            : { shouldAlert: false, reason: 'below-threshold' };
    }

    // Already told them about a delay that has since been made up.
    if (last >= ALERT_MIN_DELAY_MIN && delayMin < ALERT_MIN_DELAY_MIN) {
        return { shouldAlert: true, reason: 'delay-recovered', kind: 'recovered' };
    }

    const change = delayMin - last;
    if (Math.abs(change) >= ALERT_CHANGE_MIN && delayMin >= ALERT_MIN_DELAY_MIN) {
        return {
            shouldAlert: true,
            reason: change > 0 ? 'delay-worse' : 'delay-better',
            kind: change > 0 ? 'worse' : 'better',
        };
    }
    return { shouldAlert: false, reason: 'no-material-change' };
}

/** Bulgarian copy for the alert. Kept next to the rule that produces it. */
function alertText(row, delayMin, kind) {
    const train = row.train_number;
    const to = row.destination_station;
    if (kind === 'recovered') {
        return {
            title: `Влак ${train} наваксва`,
            body: `Закъснението към ${to} е под 5 минути.`,
        };
    }
    const word = delayMin === 1 ? 'минута' : 'минути';
    return {
        title: `Влак ${train} закъснява с ${delayMin} ${word}`,
        body: kind === 'better'
            ? `Закъснението намаля. Пътуване към ${to}.`
            : `Пътуване към ${to}. Проверете преди да тръгнете.`,
    };
}

// ── Auto-stop: a journey that was armed but never taken ──────────────────────

const DEADLINE_AFTER_PREDICTED_MS = 20 * 60 * 1000;
const DEADLINE_AFTER_SCHEDULED_MS = 45 * 60 * 1000;
const ABSOLUTE_CAP_MS             = 12 * 60 * 60 * 1000; // Apple kills it anyway

/**
 * Deadline-aware of the live prediction: measuring the margin from the SCHEDULED
 * arrival would stop tracking exactly on the delayed trains, which is where
 * tracking is worth most. With coverage we wait for the predicted arrival
 * instead, recomputed each tick.
 *
 * @returns {{shouldStop:boolean, reason:string, deadlineMs:number}}
 */
function evaluateDeadline(row, predictedArrivalUnix, now = new Date()) {
    const nowMs = now.getTime();
    const schedArr = new Date(row.scheduled_arrival).getTime();
    const anchor = new Date(row.started_at || row.scheduled_departure).getTime();

    const deadline = predictedArrivalUnix != null
        ? predictedArrivalUnix * 1000 + DEADLINE_AFTER_PREDICTED_MS
        : schedArr + DEADLINE_AFTER_SCHEDULED_MS;

    const capped = Math.min(deadline, anchor + ABSOLUTE_CAP_MS);

    if (nowMs > capped) {
        return {
            shouldStop: true,
            reason: capped < deadline ? 'activity-lifetime-cap' : 'arrival-not-confirmed',
            deadlineMs: capped,
        };
    }
    return { shouldStop: false, reason: 'within-deadline', deadlineMs: capped };
}

module.exports = {
    evaluateTrigger, evaluateDelayAlert, alertText, evaluateDeadline,
    START_WINDOW_MS, ALERT_MIN_DELAY_MIN, ALERT_CHANGE_MIN,
    ALERT_MIN_INTERVAL_MS, ALERT_MAX_PER_LEG, MAX_JOURNEY_AHEAD_MS,
};
