'use strict';

/**
 * armedWatcher.js — the server-driven half of journey tracking, run from the
 * existing Live Activity worker tick (NOT a separate process: that would mean a
 * second database handle, a second APNs session and duplicated throttling, for
 * no parallelism under pm2 fork mode).
 *
 * Per tick, for every armed leg:
 *   1. decide whether the moment has come to push-to-start the card,
 *   2. alert on a delay that appeared or materially changed,
 *   3. stop silently when a journey was armed but evidently never taken.
 *
 * Reads the realtime cache the poller already fills — it adds no feed traffic.
 *
 * Logging here is deliberately verbose (every computed instant and every
 * decision), because this runs unattended overnight and the first morning after
 * must be debuggable in minutes.
 */

const cache        = require('../realtime/cache');
const testFeed     = require('./testFeed');
const geometryOf   = require('../gtfs/tripGeometry');
const stationCoords = require('../gtfs/stationCoords');
const trainCategory = require('../gtfs/trainCategory');
const store        = require('./armedStore');
const laStore      = require('./store');
const apns         = require('./apns');
const fcm          = require('./fcm');
const contentState = require('./contentState');
const stationDisplay = require('../gtfs/stationDisplay');
const logic        = require('./armedLogic');
const metrics      = require('./metrics');
const pushBody     = require('./pushBody');

// Reserved TEST-prefixed numbers resolve from testFeed (see its header for why
// that lives outside services/realtime/cache.js); every real number falls
// straight through unaffected, since testFeed returns null for anything not
// in its own reserved namespace.
const getTrain = (num) => testFeed.getTrain(num) ?? cache.getTrain(num);
const getVehicle = (num) => testFeed.getVehicle(num) ?? cache.getVehicle(num);

// The Swift ActivityAttributes type name and the static attributes must match
// the app exactly, or the start push is accepted and silently discarded.
const ATTRIBUTES_TYPE = process.env.APNS_ATTRIBUTES_TYPE || 'JourneyAttributes';

// scheduledDeparture / scheduledArrival are Date in JourneyAttributes, so they
// go through the same un-customized decode the content-state dates already
// proved on a live device: seconds since the 2001 reference date, as NUMBERS.
// An ISO string here fails exactly as silently as a missing key. Set
// APNS_ATTRIBUTES_DATE_FORMAT=iso only if those properties ever become String.
const ATTR_DATE_FORMAT = process.env.APNS_ATTRIBUTES_DATE_FORMAT === 'iso' ? 'iso' : 'swift';
const attrDate = (iso) => {
    if (ATTR_DATE_FORMAT === 'swift') {
        const ms = new Date(iso).getTime();
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000) - 978307200;
    }
    return iso;
};

const hhmm = (iso) => {
    try {
        return new Date(iso).toLocaleTimeString('en-GB', {
            timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
        });
    } catch { return String(iso); }
};
const mins = (ms) => `${Math.round(ms / 60000)}m`;

/**
 * What the passenger should see: "БВ 3637" when the client sent the display
 * form, otherwise the bare number with a word in front so it still reads as a
 * train rather than a stray number.
 */
const trainLabel = (row) => row.train_number_display || `Влак ${row.train_number}`;

/** Map an armed_journeys row onto the shape contentState.build expects. */
function asTokenRow(row) {
    return {
        train_number: row.train_number,
        // The card's per-leg field wants the passenger-facing form. Prefer what
        // the client sent, else compose it from the train's GTFS category.
        train_number_display: row.train_number_display || trainCategory.displayFor(row.train_number, row.app_language),
        app_language: row.app_language,
        boarding_station: row.boarding_station,
        destination_station: row.destination_station,
        direction_station: row.direction_station,
        scheduled_departure: row.scheduled_departure,
        scheduled_arrival: row.scheduled_arrival,
        current_leg_index: row.leg_index,
        is_current_bus: row.is_current_bus,
        next_transport_number: row.next_transport_number,
        next_transport_departure: row.next_transport_departure,
        is_next_transport_bus: row.is_next_transport_bus,
    };
}

/**
 * Pull the three numbers this row cares about out of the realtime cache:
 * predicted departure from ITS boarding station, predicted arrival at ITS
 * destination, and the delay to report. All null when there is no coverage.
 */
function readFeed(row, rt, nowSec) {
    if (!rt || !Array.isArray(rt.stops)) {
        return { predictedDepUnix: null, predictedArrUnix: null, delayMin: null };
    }
    const stops = rt.stops.filter(s => s.station);
    const bIdx = contentState.findStopIndex(stops, row.boarding_station);
    const dIdx = contentState.findStopIndex(stops, row.destination_station);

    const predictedDepUnix = bIdx >= 0
        ? (stops[bIdx].departureTime ?? stops[bIdx].arrivalTime ?? null) : null;
    const predictedArrUnix = dIdx >= 0
        ? (stops[dIdx].arrivalTime ?? stops[dIdx].departureTime ?? null) : null;

    // The delay that matters to this passenger: at the boarding station while
    // still waiting, otherwise the next stop ahead. Shared with
    // contentState.build() (see its currentDelay() doc) — they used to
    // compute this independently and could disagree with each other.
    const { delaySec } = contentState.currentDelay(stops, bIdx, nowSec);
    const delayMin = (delaySec == null || Math.abs(delaySec) > 20 * 3600)
        ? null : Math.round(delaySec / 60);

    return { predictedDepUnix, predictedArrUnix, delayMin };
}

// ── 1. Push-to-start ─────────────────────────────────────────────────────────

/**
 * Every property here is non-optional in JourneyAttributes, so a missing one
 * fails the decode exactly like a missing content-state key: Apple returns 200,
 * the device drops the start, and nothing is logged anywhere.
 *
 * totalDistanceKm is a STRAIGHT LINE origin→destination, deliberately — the app
 * computes it the same way and draws progress against it. Sending route mileage
 * instead would silently disagree with the bar the user sees.
 *
 * @returns {string|null} null when the distance cannot be computed; the caller
 *          must then refuse to start rather than send a payload we know is wrong.
 */
function buildStartBody(row, state, nowSec) {
    const totalDistanceKm = stationCoords.distanceKm(row.boarding_station, row.destination_station);
    if (totalDistanceKm == null) return null;

    // row.boarding_station/destination_station are always Bulgarian — the
    // client registers them that way so they line up with the feed (see
    // stationDisplay.js) — so the passenger-facing text is translated here,
    // not stored translated.
    const originDisplay = stationDisplay.displayStationName(row.boarding_station, row.app_language);
    const destinationDisplay = stationDisplay.displayStationName(row.destination_station, row.app_language);

    const attributes = {
        journeyId: row.journey_id,
        // The DISPLAY form ("БВ 3637") — the card names the train the way
        // the rest of the app does. The bare number stays in train_number
        // for feed matching and never reaches the passenger.
        trainNumber: trainLabel(row),
        originStation: originDisplay,
        destinationStation: destinationDisplay,
        totalDistanceKm,
        scheduledDeparture: attrDate(row.scheduled_departure),
        scheduledArrival: attrDate(row.scheduled_arrival),
    };
    // Optional, per JourneyAttributes — omitted (not guessed) when the client
    // never told us. The widget extension can't see the host app's per-app
    // language override, which is exactly why this field exists.
    if (row.app_language) attributes.appLanguage = row.app_language;

    return JSON.stringify({
        aps: {
            'timestamp': nowSec,
            'event': 'start',
            'content-state': state,
            'attributes-type': ATTRIBUTES_TYPE,
            attributes,
            'alert': {
                title: trainLabel(row),
                body: row.app_language === 'en'
                    ? `Travelling to ${destinationDisplay}`
                    : `Пътуване към ${destinationDisplay}`,
            },
            'stale-date': nowSec + 15 * 60,
        },
    });
}

async function maybeStart(row, feed, now, legCtx) {
    // Every leg of a journey is armed up front, so leg 1's trigger (departure
    // minus 40 minutes) falls while the passenger is still riding leg 0. Without
    // this guard the server would push a SECOND card mid-journey.
    if (legCtx.role !== 'active') {
        console.log(`[armed] trigger j=${row.journey_id}/${row.leg_index} train=${row.train_number} ` +
                    `decision=wait (waiting for leg ${legCtx.activeIndex} to finish)`);
        return;
    }

    const t = logic.evaluateTrigger(row, feed.predictedDepUnix, now);
    const nowMs = now.getTime();

    console.log(
        `[armed] trigger j=${row.journey_id}/${row.leg_index} train=${row.train_number} ` +
        `sched=${hhmm(row.scheduled_departure)} ` +
        `pred=${feed.predictedDepUnix ? hhmm(feed.predictedDepUnix * 1000) : '—'} ` +
        `effective=${hhmm(t.tEffectiveMs)} (${t.source}) ` +
        `trigger=${hhmm(t.tTriggerMs)} in=${mins(t.tTriggerMs - nowMs)} ` +
        `decision=${t.shouldStart ? 'START' : 'wait'} (${t.reason})`
    );

    if (!t.shouldStart) return;

    // A later leg of a multi-leg journey: if an Activity is already tracking
    // this journey (started by an earlier leg), retarget it with an ordinary
    // content-state update instead of a second push-to-start. ActivityKit
    // attributes (train/stations/distance) are immutable and stay whatever
    // leg 0 started with — what the passenger reads for the CURRENT leg comes
    // from contentState.js's leg* fields, which the app renders in preference
    // to attributes (confirmed with the mobile side). live_activity_tokens is
    // iOS-only by construction — Android's FCM path never registers there, so
    // finding a row always means "there's an Activity to redirect", not a
    // platform guess.
    if (row.leg_index > 0) {
        const existing = laStore.getActiveTokenForJourney(row.journey_id);
        if (existing) {
            await retargetExistingActivity(row, existing, now);
            return;
        }
        // No existing token (leg 0's card was never registered, or its token
        // was since pruned) — fall through to a normal push-to-start so this
        // leg is never silently left untracked.
    }

    const device = store.getToken(row.install_id, 'push_to_start');
    if (!device) {
        console.warn(`[armed] no push-to-start token for install=${row.install_id} — cannot start j=${row.journey_id}`);
        store.markStopped(row.id, 'no-start-token');
        return;
    }

    // Our own ceiling, stricter than Apple's fixed, undocumented one. Refusing
    // here costs one card; blowing Apple's costs every card for up to 24 hours.
    const budget = store.checkStartBudget(row.install_id);
    if (!budget.allowed) {
        console.warn(`[armed] push-to-start REFUSED by our guard install=${row.install_id} ` +
                     `(${budget.reason}; 1h=${budget.lastHour} 24h=${budget.lastDay}) j=${row.journey_id}`);
        store.logStart(row.install_id, row.journey_id, 'refused-budget');
        store.markStopped(row.id, 'budget-refused');
        metrics.inc('push_to_start_refused');
        return;
    }

    // ── Build the send, per platform ─────────────────────────────────────────
    // The decision to start is identical everywhere; only the delivery differs.
    let dispatch;

    if (device.platform === 'android') {
        // Deliberately thin. Android's ongoing notification is built and posted
        // by the app itself, not rendered by the OS from pushed structure the
        // way ActivityKit is — so the message only has to say "this leg needs
        // attention now" and the client rebuilds the rest from its own state.
        dispatch = () => fcm.send({
            token: device.token,
            data: {
                type: 'start_tracking',
                journeyId: row.journey_id,
                legIndex: row.leg_index,
                trainNumber: row.train_number,
            },
            noRetry: true,
        });
    } else {
        const rt = getTrain(row.train_number);
        const v  = getVehicle(row.train_number);
        const geoTripId = (rt && rt.tripId) || (v && v.tripId) || null;
        const geo = geoTripId ? geometryOf.getByTripId(geoTripId) : null;
        const { state } = contentState.build(asTokenRow(row), rt, now, v, geo);
        const nowSec = Math.floor(nowMs / 1000);

        const body = buildStartBody(row, state, nowSec);
        if (!body) {
            // totalDistanceKm is non-optional in the app. Sending a guessed number
            // would corrupt the progress bar; omitting it would fail the decode with
            // no trace at all. Refusing is the only loud option — and it names the
            // station so an alias can be added. (Android is unaffected: its payload
            // carries no distance, so an unresolvable station cannot block a start.)
            console.error(`[armed] REFUSING start j=${row.journey_id}: cannot resolve coordinates for ` +
                          `"${row.boarding_station}" → "${row.destination_station}" (totalDistanceKm unknown)`);
            store.markStopped(row.id, 'no-distance');
            metrics.inc('push_to_start_failed');
            return;
        }

        dispatch = () => apns.send({
            token: device.token,
            environment: device.environment,
            body,
            priority: 10,          // the card appearing on time is the whole point
            pushType: 'liveactivity',
            noRetry: true,
        });
    }

    // Last look before committing. Building the payload does I/O, and a manual
    // start landing in that gap would otherwise still get a duplicate card —
    // the row we are holding was read at the top of the tick.
    const fresh = store.getById(row.id);
    if (!fresh || fresh.state !== 'armed') {
        console.log(`[armed] push-to-start ABORTED j=${row.journey_id}: state is now ` +
                    `${fresh ? fresh.state : 'gone'} (the app started it first)`);
        return;
    }

    // HARD RULE: exactly one attempt, no retry, ever.
    const res = await dispatch();

    store.logStart(row.install_id, row.journey_id, res.outcome);
    console.log(`[armed] push-to-start SENT j=${row.journey_id} train=${row.train_number} ` +
                `platform=${device.platform} -> ${res.outcome} status=${res.status} reason=${res.reason || '—'} ` +
                `(budget 1h=${budget.lastHour + (res.outcome === 'ok' ? 1 : 0)}/${store.MAX_STARTS_PER_HOUR})`);

    if (res.outcome === 'ok') {
        store.markStarted(row.id);
        metrics.inc('push_to_start_sent');
    } else {
        // No retry. Log loudly and stop, rather than burn the device's budget.
        console.error(`[armed] push-to-start failed, NOT retrying j=${row.journey_id}: ${res.outcome} ${res.reason || ''}`);
        store.markStopped(row.id, `start-failed:${res.outcome}`);
        metrics.inc('push_to_start_failed');
    }
}

/**
 * Re-point an EXISTING, already-started Activity's token onto this (later)
 * leg via an ordinary content-state push — not a second push-to-start. Not
 * subject to the push-to-start budget at all: it never touches Apple's
 * push-to-start allowance, only the far more generous ordinary-update one.
 *
 * Unlike push-to-start, a failure here is NOT fatal to the leg: the row stays
 * 'armed' so the next tick simply tries again, the same way worker.js's own
 * ordinary content pushes already retry every tick until they land.
 */
async function retargetExistingActivity(row, existing, now) {
    const nowSec = Math.floor(now.getTime() / 1000);

    laStore.upsert({
        token: existing.token,
        environment: existing.environment,
        journey_id: row.journey_id,
        train_number: row.train_number,
        train_number_display: row.train_number_display,
        app_language: row.app_language,
        boarding_station: row.boarding_station,
        destination_station: row.destination_station,
        direction_station: row.direction_station,
        scheduled_departure: row.scheduled_departure,
        scheduled_arrival: row.scheduled_arrival,
        current_leg_index: row.leg_index,
        is_current_bus: row.is_current_bus,
        next_transport_number: row.next_transport_number,
        next_transport_departure: row.next_transport_departure,
        is_next_transport_bus: row.is_next_transport_bus,
    });

    const rt = getTrain(row.train_number);
    const v  = getVehicle(row.train_number);
    const geoTripId = (rt && rt.tripId) || (v && v.tripId) || null;
    const geo = geoTripId ? geometryOf.getByTripId(geoTripId) : null;
    const { state, meta } = contentState.build(asTokenRow(row), rt, now, v, geo);

    const body = pushBody.buildBody(state, { nowSec, predictedArrivalUnix: meta.predictedArrivalUnix });

    const res = await apns.send({
        token: existing.token,
        environment: existing.environment,
        body,
        priority: 10,
        pushType: 'liveactivity',
        noRetry: true,
    });

    console.log(`[armed] retarget j=${row.journey_id} token=${existing.token.slice(0, 8)}… ` +
                `-> leg=${row.leg_index} train=${row.train_number} outcome=${res.outcome}`);

    if (res.outcome === 'ok') {
        // last_content_hash is left null rather than replicating worker.js's
        // internal hash here — worst case is one harmless extra push on the
        // very next regular tick, comparing against a null hash and deciding
        // "changed" once more. Far cheaper than the coupling of sharing it.
        laStore.markPushed(existing.token, {
            delayMin: meta.delayMinutes, nextStop: meta.nextStop,
            contentHash: null, phase: meta.phase, progress: meta.progress,
        });
        store.markStarted(row.id);
        store.logStart(row.install_id, row.journey_id, 'retargeted');
        metrics.inc('leg_retargeted_sent');
    } else {
        store.logStart(row.install_id, row.journey_id, `retarget-failed:${res.outcome}`);
        metrics.inc('leg_retargeted_failed');
    }
}

// ── 2. Delay alert ───────────────────────────────────────────────────────────

/**
 * The connection-risk band relevant to THIS alert, ported 1:1 from the
 * client's own transfer banner (see armedLogic.js's connectionGapMinutes doc)
 * — computed here rather than in armedLogic.js because it needs the SIBLING
 * leg's own live feed, which only armedWatcher.js has access to.
 *
 *  - role 'connection': this row IS the connecting leg — the other side of
 *    the gap is the ACTIVE leg (siblings[legCtx.activeIndex]), refetched for
 *    its own current prediction.
 *  - role 'active' + already rolling: the other side is the NEXT leg, if one
 *    exists — refetched the same way. No next leg = nothing to protect.
 *  - role 'active' + not yet departed: irrelevant (isAlertActionable() never
 *    consults it for that case), so not computed.
 *
 * @returns {{band: string|null, hasTransfer: boolean}}
 */
function connectionRiskForAlert(row, feed, ctx, legCtx, siblings, nowSec) {
    let activeRow, activeFeed, nextRow, nextFeed;

    if (ctx.role === 'connection') {
        activeRow = siblings.find(s => s.leg_index === legCtx.activeIndex);
        if (!activeRow) return { band: null, hasTransfer: true }; // shouldn't happen; err on the safe side
        activeFeed = readFeed(activeRow, getTrain(activeRow.train_number), nowSec);
        nextRow = row;
        nextFeed = feed;
    } else if (ctx.phase === 'inTransit') {
        nextRow = siblings.find(s => s.leg_index === row.leg_index + 1);
        if (!nextRow) return { band: null, hasTransfer: false }; // last leg — nothing downstream
        activeRow = row;
        activeFeed = feed;
        nextFeed = readFeed(nextRow, getTrain(nextRow.train_number), nowSec);
    } else {
        return { band: null, hasTransfer: false }; // not consulted for this case anyway
    }

    const gap = logic.connectionGapMinutes(
        logic.transferArrivalUnix(activeRow, activeFeed),
        logic.nextDepartureUnix(nextRow, nextFeed)
    );
    return { band: logic.connectionRiskBand(gap), hasTransfer: true };
}

async function maybeAlert(row, feed, now, legCtx, siblings) {
    const phase = logic.legPhase(row, feed.predictedDepUnix, now);
    // row.destination_station is always Bulgarian (see stationDisplay.js) —
    // translated here so alertText() (kept DB-free by design) never has to.
    const destinationDisplay = stationDisplay.displayStationName(row.destination_station, row.app_language);
    const ctx = { phase, role: legCtx.role, language: row.app_language, destinationDisplay };

    const d = logic.evaluateDelayAlert(row, feed.delayMin, now, ctx);
    if (!d.shouldAlert) {
        // Still remember what we saw, so the next comparison is against truth.
        if (feed.delayMin != null && feed.delayMin !== row.last_delay_min && d.reason === 'below-threshold') {
            store.recordDelaySeen(row.id, feed.delayMin);
        }
        return;
    }

    // A delay already sitting there when the leg was armed shouldn't reach the
    // passenger as an interruption seconds later — they just registered the
    // journey, the Live Activity already shows it immediately, and in most
    // cases they saw it in the schedule search results before arming at all.
    // Held back only for this leg's very first alert; anything discovered
    // after the grace window, or any alert once one has already been sent,
    // fires exactly as before.
    if (row.alerts_sent === 0) {
        const sinceArm = now.getTime() - new Date(row.created_at).getTime();
        if (sinceArm < logic.ALERT_ARM_GRACE_MS) {
            if (feed.delayMin != null && feed.delayMin !== row.last_delay_min) {
                store.recordDelaySeen(row.id, feed.delayMin);
            }
            return;
        }
    }

    const device = store.getToken(row.install_id, 'alert');
    if (!device) {
        console.warn(`[armed] no alert token for install=${row.install_id} — skipping delay alert j=${row.journey_id}`);
        return;
    }

    // The wording lives server-side for both platforms — the Bulgarian
    // pluralisation and the "never claim on time" rule are in alertText(), and
    // duplicating them in two clients is how they drift apart.
    const text = logic.alertText(row, feed.delayMin, d.kind, trainLabel(row), ctx);

    // Whether this specific alert is worth bypassing Focus/DND for — ported
    // 1:1 from the client's own transfer-risk banner (see connectionRiskForAlert
    // and armedLogic.js's connectionGapMinutes doc), so the push priority and
    // what the Live Activity shows can never disagree with each other.
    const nowSec = Math.floor(now.getTime() / 1000);
    const { band, hasTransfer } = connectionRiskForAlert(row, feed, ctx, legCtx, siblings, nowSec);
    const actionable = logic.isAlertActionable(ctx, band, hasTransfer);
    const interruptionLevel = actionable ? 'time-sensitive' : 'active';

    let res;
    if (device.platform === 'android') {
        res = await fcm.send({
            token: device.token,
            data: {
                type: 'delay_alert',
                journeyId: row.journey_id,
                legIndex: row.leg_index,
                trainNumber: row.train_number,
                delayMinutes: feed.delayMin,
                title: text.title,
                body: text.body,
                // Same computed signal as iOS's interruption-level, same
                // vocabulary deliberately — Android has no per-message DND
                // bypass field the way APNs does, so acting on this requires
                // the app routing to a high-importance vs normal notification
                // channel client-side. Sent now regardless so the data exists
                // whenever that's wired up; unused today costs nothing.
                interruptionLevel,
            },
        });
    } else {
        const body = JSON.stringify({
            aps: {
                alert: { title: text.title, body: text.body },
                sound: 'default',
                // Without this, Do Not Disturb swallows the alert silently — exactly
                // when it matters most, since an actionable delay is worth knowing
                // about before leaving for the station or missing a connection. The
                // entitlement is in place on the app. Dropped to 'active' (normal
                // priority) when there's nothing the passenger can act on right now
                // — see isAlertActionable().
                'interruption-level': interruptionLevel,
                'thread-id': `journey-${row.journey_id}`,
            },
            journeyId: row.journey_id,
            legIndex: row.leg_index,
            trainNumber: row.train_number,
            delayMinutes: feed.delayMin,
        });

        // A plain alert notification — not a Live Activity push, so it does not
        // touch the Live Activity update budget at all.
        res = await apns.send({
            token: device.token,
            environment: device.environment,
            body,
            priority: 10,
            pushType: 'alert',
        });
    }

    console.log(`[armed] delay alert j=${row.journey_id}/${row.leg_index} train=${row.train_number} ` +
                `platform=${device.platform} role=${ctx.role} phase=${ctx.phase} ` +
                `delay=${feed.delayMin}m was=${row.last_delay_min ?? '—'} (${d.reason}) ` +
                `connectionBand=${band ?? '—'} interruption=${interruptionLevel} -> ${res.outcome}`);

    if (res.outcome === 'ok') {
        store.recordAlert(row.id, feed.delayMin);
        metrics.inc('delay_alerts_sent');
    } else if (res.outcome === 'invalid-token') {
        console.warn(`[armed] alert token dead for install=${row.install_id}`);
    }
}

// ── 3. Silent auto-stop ──────────────────────────────────────────────────────

function maybeStop(row, feed, now) {
    const d = logic.evaluateDeadline(row, feed.predictedArrUnix, now);
    if (!d.shouldStop) return false;

    // Silent by requirement: no notification, no end alert — the tracking simply
    // ends. Also drop any Live Activity token for this journey so the worker
    // stops pushing to a card nobody is travelling with.
    const removed = laStore.removeByJourney(row.journey_id);
    store.markStopped(row.id, d.reason);
    console.log(`[armed] auto-stop j=${row.journey_id}/${row.leg_index} train=${row.train_number} ` +
                `reason=${d.reason} deadline=${hhmm(d.deadlineMs)} laTokensRemoved=${removed}`);
    metrics.inc('armed_auto_stopped');
    return true;
}

// ── Tick ─────────────────────────────────────────────────────────────────────

/** One pass over every armed leg. Called from the Live Activity worker tick. */
async function tick(now = new Date()) {
    const rows = store.listActive();
    if (!rows.length) return { checked: 0 };

    const nowSec = Math.floor(now.getTime() / 1000);
    let started = 0, alerted = 0, stopped = 0;

    // Group the live legs by journey. listActive() returns only legs still in
    // play, so the lowest leg_index within a group IS the leg being travelled —
    // no extra query needed to work out where the passenger is.
    const byJourney = new Map();
    for (const r of rows) {
        const key = `${r.install_id}|${r.journey_id}`;
        if (!byJourney.has(key)) byJourney.set(key, []);
        byJourney.get(key).push(r);
    }

    for (const row of rows) {
        try {
            const siblings = byJourney.get(`${row.install_id}|${row.journey_id}`) || [row];
            const legCtx = logic.legRole(row, siblings, now);

            const rt = getTrain(row.train_number);
            const feed = readFeed(row, rt, nowSec);

            if (maybeStop(row, feed, now)) { stopped++; continue; }

            const before = row.state;
            await maybeStart(row, feed, now, legCtx);
            if (before === 'armed' && store.getById(row.id)?.state === 'started') started++;

            await maybeAlert(row, feed, now, legCtx, siblings);
            if (store.getById(row.id)?.alerts_sent > row.alerts_sent) alerted++;
        } catch (err) {
            console.error(`[armed] row ${row.id} (j=${row.journey_id}) failed:`, err.message);
        }
    }

    console.log(`[armed] tick: ${rows.length} active, ${started} started, ${alerted} alerted, ${stopped} stopped`);
    return { checked: rows.length, started, alerted, stopped };
}

module.exports = { tick, readFeed, asTokenRow, buildStartBody };
