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

/**
 * Before departure or already rolling — decides both wording and threshold.
 *
 * `departed` is contentState.hasDeparted() (the train's position, else its predicted
 * departure): when the caller has it, it decides. Otherwise the predicted departure, else
 * the schedule — as before.
 */
function legPhase(row, predictedDepUnix, now = new Date(), departed = null) {
    if (typeof departed === 'boolean') return departed ? 'inTransit' : 'preDeparture';
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


// ── Android: two moments the phone cannot be trusted with ────────────────────
//
// Android holds back an app's exact alarms (Doze, vendor battery managers) and runs them
// 15-18 minutes late; an FCM high-priority push arrives within seconds. So the two moments
// that matter most are pushed from here, for ANDROID legs only (an iPhone has the Live
// Activity, which the OS keeps current on its own):
//   - departure_reminder: scheduled departure - 30 min — "time to set off"
//   - start_tracking again at arrival - 40 min — the approach to the stop

const REMINDER_BEFORE_MS     = 30 * 60 * 1000;
const REMINDER_MIN_LEAD_MS   = 5 * 60 * 1000;   // a "set off" nudge less than this before departure is noise
const APPROACH_BEFORE_MS     = 40 * 60 * 1000;
const APPROACH_MOVE_MS       = 10 * 60 * 1000;  // send again if the arrival moved by more than this
const APPROACH_MIN_GAP_MS    = 5 * 60 * 1000;   // …but never two within this
const APPROACH_MAX_PER_LEG   = 3;
const APPROACH_AFTER_START_MS = 15 * 60 * 1000; // a start_tracking this recent already covers it

/**
 * Should the "time to set off" reminder go out now?
 *
 * Once per leg; from (scheduled departure - 30 min) until 5 minutes before the train
 * actually leaves (the feed's predicted departure when it has one, else the schedule), so a
 * leg armed late still gets it if there is time to act, and a train that has gone does not.
 *
 * @param {object} row   armed_journeys row (reminder_sent_at)
 * @param {{predictedDepUnix:number|null, departed:boolean|null}} feed  readFeed()
 */
function evaluateDepartureReminder(row, feed, now = new Date()) {
    const nowMs  = now.getTime();
    const tSched = new Date(row.scheduled_departure).getTime();
    const tEff   = feed.predictedDepUnix != null ? feed.predictedDepUnix * 1000 : tSched;
    const tRemindMs = tSched - REMINDER_BEFORE_MS;

    if (row.reminder_sent_at)       return { shouldSend: false, reason: 'already-sent', tRemindMs };
    if (feed.departed === true)     return { shouldSend: false, reason: 'already-departed', tRemindMs };
    if (nowMs < tRemindMs)          return { shouldSend: false, reason: 'too-early', tRemindMs };
    if (nowMs > tEff - REMINDER_MIN_LEAD_MS) return { shouldSend: false, reason: 'too-close-to-departure', tRemindMs };
    return { shouldSend: true, reason: 'departure-in-30', tRemindMs };
}

/**
 * Should another start_tracking go out for the approach to the arrival stop?
 *
 * At (arrival - 40 min), the arrival being the feed's prediction when it has one, else the
 * schedule. Sent again when the arrival then moves by more than 10 minutes (the tracking the
 * phone started would otherwise be aimed at the wrong time), at most 3 times, never two within
 * 5 minutes. Not for a leg shorter than the window — its departure start_tracking already
 * covers the approach — and not for a train that has not left yet.
 *
 * @param {object} row   armed_journeys row (approach_sent_at, approach_arrival, approach_count, started_at)
 * @param {{predictedArrUnix:number|null, predictedDepUnix:number|null, departed:boolean|null}} feed
 */
function evaluateApproach(row, feed, now = new Date()) {
    const nowMs = now.getTime();
    const tArr  = feed.predictedArrUnix != null ? feed.predictedArrUnix * 1000 : new Date(row.scheduled_arrival).getTime();
    const tDep  = feed.predictedDepUnix != null ? feed.predictedDepUnix * 1000 : new Date(row.scheduled_departure).getTime();
    const tApproachMs = tArr - APPROACH_BEFORE_MS;
    const base = { tApproachMs, arrivalUnix: Math.floor(tArr / 1000) };

    if (nowMs < tApproachMs)        return { ...base, shouldSend: false, reason: 'too-early' };
    if (nowMs >= tArr)              return { ...base, shouldSend: false, reason: 'arrival-passed' };
    if (tApproachMs <= tDep)        return { ...base, shouldSend: false, reason: 'leg-shorter-than-window' };
    if (feed.departed === false)    return { ...base, shouldSend: false, reason: 'not-departed' };
    if ((row.approach_count || 0) >= APPROACH_MAX_PER_LEG) return { ...base, shouldSend: false, reason: 'cap' };

    if (!row.approach_sent_at) {
        if (row.started_at && nowMs - new Date(row.started_at).getTime() < APPROACH_AFTER_START_MS) {
            return { ...base, shouldSend: false, reason: 'just-started' };
        }
        return { ...base, shouldSend: true, reason: 'arrival-in-40' };
    }

    const moved = row.approach_arrival == null
        || Math.abs(tArr - row.approach_arrival * 1000) > APPROACH_MOVE_MS;
    if (!moved)                     return { ...base, shouldSend: false, reason: 'unchanged' };
    if (nowMs - new Date(row.approach_sent_at).getTime() < APPROACH_MIN_GAP_MS) {
        return { ...base, shouldSend: false, reason: 'rate-limited' };
    }
    return { ...base, shouldSend: true, reason: 'arrival-moved' };
}

const sofiaHm = (ms) => new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
});

const REMINDER_COPY = {
    bg: {
        title: (train, to) => `${train} към ${to}`,
        scheduled: (from, hm) => `Тръгва от ${from} по разписание в ${hm}.`,
        delayed: (from, hm, exp, n, word) => `Тръгва от ${from} по разписание в ${hm}, очаква се в ${exp} (закъснение ${n} ${word}).`,
        noDelay: (from, hm) => `Тръгва от ${from} в ${hm}, по данни на живо без закъснение.`,
    },
    en: {
        title: (train, to) => `${train} to ${to}`,
        scheduled: (from, hm) => `Departs ${from} on schedule at ${hm}.`,
        delayed: (from, hm, exp, n, word) => `Departs ${from} on schedule at ${hm}, expected at ${exp} (${n} ${word} late).`,
        noDelay: (from, hm) => `Departs ${from} at ${hm}, no delay reported live.`,
    },
};

/**
 * The words of the "time to set off" reminder: train, direction, the scheduled time and — ONLY
 * when the feed has a real report for this departure — the expected one. With no report it
 * says "on schedule at HH:MM" and nothing more: not "on time", which would be a claim.
 *
 * @param {object} ctx  { language, fromDisplay, directionDisplay }  (names already translated)
 */
function departureReminderText(row, feed, label, ctx = {}) {
    const lang = ctx.language === 'en' ? 'en' : 'bg';
    const c = REMINDER_COPY[lang];
    const word = ALERT_COPY[lang].word;
    const train = label || ALERT_COPY[lang].bareTrain(row.train_number);
    const hm = sofiaHm(new Date(row.scheduled_departure).getTime());
    const from = ctx.fromDisplay || row.boarding_station;
    const to = ctx.directionDisplay || row.direction_station || row.destination_station;

    let body;
    if (feed.delayMin == null) {
        body = c.scheduled(from, hm);
    } else if (feed.delayMin >= 1 && feed.predictedDepUnix != null) {
        body = c.delayed(from, hm, sofiaHm(feed.predictedDepUnix * 1000), feed.delayMin, word(feed.delayMin));
    } else {
        body = c.noDelay(from, hm);
    }
    return { title: c.title(train, to), body };
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
    evaluateDepartureReminder, evaluateApproach, departureReminderText,
    REMINDER_BEFORE_MS, REMINDER_MIN_LEAD_MS, APPROACH_BEFORE_MS, APPROACH_MOVE_MS, APPROACH_MIN_GAP_MS, APPROACH_MAX_PER_LEG,
    legRole, mayStartLeg, legPhase,
    connectionGapMinutes, transferArrivalUnix, nextDepartureUnix,
    connectionRiskBand, isAlertActionable,
    START_WINDOW_MS, ALERT_MIN_DELAY_MIN, ALERT_CHANGE_MIN,
    ALERT_CHANGE_MIN_IN_TRANSIT, ALERT_MIN_INTERVAL_MS, ALERT_MAX_PER_LEG,
    ALERT_ARM_GRACE_MS,
    MAX_JOURNEY_AHEAD_MS, CONNECTION_ALERT_WINDOW_MS, COMFORTABLE_TRANSFER_MIN,
};
