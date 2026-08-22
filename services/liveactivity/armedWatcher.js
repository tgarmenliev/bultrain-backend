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
const geometryOf   = require('../gtfs/tripGeometry');
const stationCoords = require('../gtfs/stationCoords');
const trainCategory = require('../gtfs/trainCategory');
const store        = require('./armedStore');
const laStore      = require('./store');
const apns         = require('./apns');
const fcm          = require('./fcm');
const contentState = require('./contentState');
const logic        = require('./armedLogic');
const metrics      = require('./metrics');

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
        train_number_display: row.train_number_display || trainCategory.displayFor(row.train_number),
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
    // still waiting, otherwise the next stop ahead.
    let delaySec = null;
    if (bIdx >= 0 && (stops[bIdx].arrivalTime ?? 0) >= nowSec) {
        delaySec = stops[bIdx].departureDelay ?? stops[bIdx].arrivalDelay ?? null;
    } else {
        const upcoming = stops.filter(s => s.arrivalTime != null && s.arrivalTime >= nowSec);
        const ref = upcoming[0] || stops[stops.length - 1];
        if (ref) delaySec = ref.arrivalDelay ?? ref.departureDelay ?? null;
    }
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

    return JSON.stringify({
        aps: {
            'timestamp': nowSec,
            'event': 'start',
            'content-state': state,
            'attributes-type': ATTRIBUTES_TYPE,
            'attributes': {
                journeyId: row.journey_id,
                // The DISPLAY form ("БВ 3637") — the card names the train the way
                // the rest of the app does. The bare number stays in train_number
                // for feed matching and never reaches the passenger.
                trainNumber: trainLabel(row),
                originStation: row.boarding_station,
                destinationStation: row.destination_station,
                totalDistanceKm,
                scheduledDeparture: attrDate(row.scheduled_departure),
                scheduledArrival: attrDate(row.scheduled_arrival),
                // appLanguage is optional — omitted rather than guessed.
            },
            'alert': {
                title: trainLabel(row),
                body: `Пътуване към ${row.destination_station}`,
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
        const rt = cache.getTrain(row.train_number);
        const v  = cache.getVehicle(row.train_number);
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

// ── 2. Delay alert ───────────────────────────────────────────────────────────

async function maybeAlert(row, feed, now, legCtx) {
    const phase = logic.legPhase(row, feed.predictedDepUnix, now);
    const ctx = { phase, role: legCtx.role };

    const d = logic.evaluateDelayAlert(row, feed.delayMin, now, ctx);
    if (!d.shouldAlert) {
        // Still remember what we saw, so the next comparison is against truth.
        if (feed.delayMin != null && feed.delayMin !== row.last_delay_min && d.reason === 'below-threshold') {
            store.recordDelaySeen(row.id, feed.delayMin);
        }
        return;
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
            },
        });
    } else {
        const body = JSON.stringify({
            aps: {
                alert: { title: text.title, body: text.body },
                sound: 'default',
                // Without this, Do Not Disturb swallows the alert silently — exactly
                // when it matters most, since a delay is worth knowing about before
                // leaving for the station. The entitlement is in place on the app.
                'interruption-level': 'time-sensitive',
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
                `delay=${feed.delayMin}m was=${row.last_delay_min ?? '—'} (${d.reason}) -> ${res.outcome}`);

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

            const rt = cache.getTrain(row.train_number);
            const feed = readFeed(row, rt, nowSec);

            if (maybeStop(row, feed, now)) { stopped++; continue; }

            const before = row.state;
            await maybeStart(row, feed, now, legCtx);
            if (before === 'armed' && store.getById(row.id)?.state === 'started') started++;

            await maybeAlert(row, feed, now, legCtx);
            if (store.getById(row.id)?.alerts_sent > row.alerts_sent) alerted++;
        } catch (err) {
            console.error(`[armed] row ${row.id} (j=${row.journey_id}) failed:`, err.message);
        }
    }

    console.log(`[armed] tick: ${rows.length} active, ${started} started, ${alerted} alerted, ${stopped} stopped`);
    return { checked: rows.length, started, alerted, stopped };
}

module.exports = { tick, readFeed, asTokenRow, buildStartBody };
