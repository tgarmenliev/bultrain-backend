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

// ── Leg sequencing across a multi-leg journey ────────────────────────────────

// A leg the watcher no longer has work for.
const FINISHED_STATES = new Set(['arrived', 'stopped']);

// How close to the current leg's arrival the connection becomes worth warning
// about. Before that, a delay on a later train is noise the passenger cannot
// act on — and worse, reads as if their CURRENT train were the late one.
const CONNECTION_ALERT_WINDOW_MS = 45 * 60 * 1000;

/**
 * Where a leg sits relative to the passenger right now.
 *
 * The client arms every leg of a journey up front, so the server holds several
 * live legs at once and must not treat them as equals: only one is being
 * travelled, and the rest are the future. `liveLegs` is the set still in play
 * (anything not arrived or stopped), so the lowest index among them is the leg
 * the passenger is on or about to board.
 *
 * @returns {{role:'active'|'connection'|'later', activeIndex:number|null}}
 */
function legRole(row, liveLegs, now = new Date()) {
    const indices = liveLegs
        .filter(l => !FINISHED_STATES.has(l.state))
        .map(l => l.leg_index)
        .sort((a, b) => a - b);

    if (!indices.length) return { role: 'later', activeIndex: null };
    const activeIndex = indices[0];

    if (row.leg_index === activeIndex) return { role: 'active', activeIndex };
    if (row.leg_index !== activeIndex + 1) return { role: 'later', activeIndex };

    // The immediate connection: relevant only once the transfer is close.
    const active = liveLegs.find(l => l.leg_index === activeIndex);
    const activeArrival = active ? new Date(active.scheduled_arrival).getTime() : null;
    const near = activeArrival != null
        && (activeArrival - now.getTime()) <= CONNECTION_ALERT_WINDOW_MS;

    return { role: near ? 'connection' : 'later', activeIndex };
}

/** A leg's card may only be started once every earlier leg has finished. */
function mayStartLeg(row, liveLegs, now = new Date()) {
    return legRole(row, liveLegs, now).role === 'active';
}

/** Before departure or already rolling — decides both wording and threshold. */
function legPhase(row, predictedDepUnix, now = new Date()) {
    const dep = predictedDepUnix != null
        ? predictedDepUnix * 1000
        : new Date(row.scheduled_departure).getTime();
    return now.getTime() < dep ? 'preDeparture' : 'inTransit';
}

// ── Task 2: when a delay is worth a notification ─────────────────────────────

const ALERT_MIN_DELAY_MIN  = 5;                // below this, not worth a push
const ALERT_CHANGE_MIN     = 5;                // material change before departure
// Once rolling, the card itself shows the delay, so a notification repeating it
// is noise. Only a substantial further change earns an interruption.
const ALERT_CHANGE_MIN_IN_TRANSIT = 10;
const ALERT_MIN_INTERVAL_MS = 10 * 60 * 1000;  // never two alerts back to back
const ALERT_MAX_PER_LEG    = 5;
// A delay already present at arm time reads as spam if the very first tick
// after /arm fires it instantly — the passenger just registered the journey
// and hasn't looked away yet, and the Live Activity already shows it without
// waiting. Held back only for the leg's very first alert (see maybeAlert in
// armedWatcher.js), never for one discovered after this window has passed.
const ALERT_ARM_GRACE_MS = 4 * 60 * 1000;

/**
 * @param {object} row      armed_journeys row (carries last_delay_min, alerts_sent)
 * @param {number|null} delayMin  the delay we can actually measure, or null when
 *                                the train has no realtime coverage at all
 * @param {Date} now
 * @param {{phase?:string, role?:string}} ctx  where this leg stands
 * @returns {{shouldAlert:boolean, reason:string, kind?:string}}
 */
function evaluateDelayAlert(row, delayMin, now = new Date(), ctx = {}) {
    const phase = ctx.phase || 'preDeparture';
    const role  = ctx.role  || 'active';

    // Never warn about a train the passenger is not on and cannot yet act on.
    // Getting "8611 is late" while sitting on 4632 reads as if THIS train were
    // the late one — the single most misleading thing this system could send.
    if (role === 'later') return { shouldAlert: false, reason: 'not-the-current-leg' };

    // Hard project rule: no data means no claim. Never "on time" without a
    // measurement behind it, and never a notification built on nothing.
    if (delayMin == null) return { shouldAlert: false, reason: 'no-coverage' };

    if (row.alerts_sent >= ALERT_MAX_PER_LEG) return { shouldAlert: false, reason: 'alert-cap' };
    if (row.last_alert_at) {
        const since = now.getTime() - new Date(row.last_alert_at).getTime();
        if (since < ALERT_MIN_INTERVAL_MS) return { shouldAlert: false, reason: 'too-soon' };
    }

    const changeBar = phase === 'inTransit' ? ALERT_CHANGE_MIN_IN_TRANSIT : ALERT_CHANGE_MIN;
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
    if (Math.abs(change) >= changeBar && delayMin >= ALERT_MIN_DELAY_MIN) {
        return {
            shouldAlert: true,
            reason: change > 0 ? 'delay-worse' : 'delay-better',
            kind: change > 0 ? 'worse' : 'better',
        };
    }
    return { shouldAlert: false, reason: 'no-material-change' };
}

// ── Task 2b: whether a delay alert deserves to bypass Focus/DND ─────────────
//
// Ported 1:1 from the client's own connection-risk banner (see the mobile
// team's answer, JourneyLiveActivityAttributes.swift's ContentState —
// connectionGapMinutes / connectionRisk), so the push priority and the Live
// Activity's own transfer banner can never disagree with each other. Not a
// server reinterpretation — the exact same formula and thresholds.

// The tight/fine boundary — the client's one named constant
// (comfortableTransferMinutes). <= 0 (not < 1) is the at-risk boundary:
// exactly 0 counts as at-risk, not tight.
const COMFORTABLE_TRANSFER_MIN = 10;

/**
 * Minutes between the connecting leg's departure and the arriving leg's
 * predicted arrival at the transfer station. Both inputs are expected to
 * already carry the client's own fallback (predicted, else scheduled) — see
 * transferArrivalUnix/nextDepartureUnix below — so this is just the
 * subtraction. No midnight-rollover correction is needed the way the
 * client's predictedDate(forStation:) needs one: our timestamps (both
 * predicted, from the GTFS-RT feed's own absolute epoch, and scheduled, ISO-
 * 8601 with a real date) are full instants end to end, never a bare HH:MM
 * that needs a reference day guessed for it.
 *
 * @returns {number|null} floor()'d minutes; null when either side is unknown.
 */
function connectionGapMinutes(transferArrivalUnix, nextDepartureUnix) {
    if (transferArrivalUnix == null || nextDepartureUnix == null) return null;
    return Math.floor((nextDepartureUnix - transferArrivalUnix) / 60);
}

/** The arriving leg's own realtime prediction for the transfer station, else its schedule. */
function transferArrivalUnix(activeRow, activeFeed) {
    return activeFeed.predictedArrUnix ?? Math.floor(new Date(activeRow.scheduled_arrival).getTime() / 1000);
}

/** The connecting leg's own realtime prediction for its departure, else its schedule. */
function nextDepartureUnix(nextRow, nextFeed) {
    return (nextFeed && nextFeed.predictedDepUnix) ?? Math.floor(new Date(nextRow.scheduled_departure).getTime() / 1000);
}

/** 'departsBeforeArrival' | 'tight' | 'fine' | null (nothing to assess). Mirrors the client's enum names exactly. */
function connectionRiskBand(gapMin) {
    if (gapMin == null) return null;
    if (gapMin <= 0) return 'departsBeforeArrival';
    if (gapMin < COMFORTABLE_TRANSFER_MIN) return 'tight';
    return 'fine';
}

/**
 * Whether THIS delay alert is worth interrupting Focus/DND for — actionable
 * exactly when the passenger hasn't boarded yet (can still change plans), or
 * a transfer they're relying on is tight/at-risk. A delay on the leg they're
 * already riding, with nothing downstream to protect, is something the Live
 * Activity already shows passively every time they glance at the phone —
 * not worth an interruption on its own.
 *
 * @param {{phase:string, role:string}} ctx
 * @param {string|null} band          connectionRiskBand() for the relevant
 *        transfer, or null if none was computed (see hasTransfer).
 * @param {boolean} hasTransfer       false only for role 'active' on the
 *        journey's LAST leg — nothing downstream to protect at all.
 */
function isAlertActionable(ctx, band, hasTransfer) {
    if (ctx.role === 'active' && ctx.phase !== 'inTransit') return true; // not boarded yet
    if (!hasTransfer) return false; // riding, no transfer at stake
    return band == null || band !== 'fine';
}

/**
 * Bilingual copy for the alert, one language object per locale so both read
 * side by side and can't silently drift apart. Real incident: this used to be
 * Bulgarian-only regardless of the app's language — an English-language app
 * with a correctly English Live Activity card still got a Bulgarian delay
 * push, because this text is composed server-side and nothing carried the
 * client's language here at all (see migration 015_app_language.sql).
 */
const ALERT_COPY = {
    bg: {
        word: (n) => (n === 1 ? 'минута' : 'минути'),
        bareTrain: (num) => `Влак ${num}`,
        connectionRecovered: (train) => ({
            title: 'Връзката ви наваксва',
            body: `Следващият влак ${train} вече не закъснява съществено.`,
        }),
        connectionDelayed: (train, delayMin, word) => ({
            title: `Следващият ви влак ${train} закъснява с ${delayMin} ${word}`,
            body: 'Това е връзката ви след прекачването, не влакът, в който сте.',
        }),
        recovered: (train, to) => ({
            title: `${train} наваксва`,
            body: `Закъснението към ${to} е под 5 минути.`,
        }),
        inTransit: (train, delayMin, word, better, to) => ({
            title: `${train} закъснява с ${delayMin} ${word}`,
            body: better ? `Закъснението намаля. Пътуване към ${to}.` : `Закъснението нарасна. Пътуване към ${to}.`,
        }),
        preDeparture: (train, delayMin, word, better, to) => ({
            title: `${train} закъснява с ${delayMin} ${word}`,
            body: better ? `Закъснението намаля. Пътуване към ${to}.` : `Пътуване към ${to}. Проверете преди да тръгнете.`,
        }),
    },
    en: {
        word: (n) => (n === 1 ? 'minute' : 'minutes'),
        bareTrain: (num) => `Train ${num}`,
        connectionRecovered: (train) => ({
            title: 'Your connection is catching up',
            body: `The next train ${train} is no longer significantly delayed.`,
        }),
        connectionDelayed: (train, delayMin, word) => ({
            title: `Your next train ${train} is delayed by ${delayMin} ${word}`,
            body: 'This is your connecting train after the transfer, not the one you are on.',
        }),
        recovered: (train, to) => ({
            title: `${train} is catching up`,
            body: `The delay to ${to} is now under 5 minutes.`,
        }),
        inTransit: (train, delayMin, word, better, to) => ({
            title: `${train} is delayed by ${delayMin} ${word}`,
            body: better ? `The delay has decreased. Travelling to ${to}.` : `The delay has increased. Travelling to ${to}.`,
        }),
        preDeparture: (train, delayMin, word, better, to) => ({
            title: `${train} is delayed by ${delayMin} ${word}`,
            body: better ? `The delay has decreased. Travelling to ${to}.` : `Travelling to ${to}. Check before you leave.`,
        }),
    },
};

/**
 * `label` is what the passenger reads — "БВ 3637" where the client supplied a
 * display number, otherwise a bare-number fallback in the same language.
 * `ctx` decides the wording: telling someone already aboard to "check before
 * you leave" is nonsense, and a connection warning has to name itself as
 * being about the NEXT train or it will be read as being about the current
 * one. `ctx.language` — 'en' or anything else ('bg', missing, unrecognized).
 *
 * `ctx.destinationDisplay`, when given, is used in place of
 * `row.destination_station` — this function stays free of the database, so
 * it cannot translate the (always-Bulgarian, see stationDisplay.js) station
 * name itself; the caller resolves it first. Falls back to the raw row value
 * so existing callers that don't pass it keep working unchanged.
 */
function alertText(row, delayMin, kind, label, ctx = {}) {
    const phase = ctx.phase || 'preDeparture';
    const role  = ctx.role  || 'active';
    const c = ALERT_COPY[ctx.language === 'en' ? 'en' : 'bg'];
    const train = label || c.bareTrain(row.train_number);
    const to = ctx.destinationDisplay || row.destination_station;
    const word = c.word(delayMin);

    if (role === 'connection') {
        return kind === 'recovered' ? c.connectionRecovered(train) : c.connectionDelayed(train, delayMin, word);
    }
    if (kind === 'recovered') return c.recovered(train, to);
    if (phase === 'inTransit') return c.inTransit(train, delayMin, word, kind === 'better', to);
    return c.preDeparture(train, delayMin, word, kind === 'better', to);
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
    legRole, mayStartLeg, legPhase,
    connectionGapMinutes, transferArrivalUnix, nextDepartureUnix,
    connectionRiskBand, isAlertActionable,
    START_WINDOW_MS, ALERT_MIN_DELAY_MIN, ALERT_CHANGE_MIN,
    ALERT_CHANGE_MIN_IN_TRANSIT, ALERT_MIN_INTERVAL_MS, ALERT_MAX_PER_LEG,
    ALERT_ARM_GRACE_MS,
    MAX_JOURNEY_AHEAD_MS, CONNECTION_ALERT_WINDOW_MS, COMFORTABLE_TRANSFER_MIN,
};
