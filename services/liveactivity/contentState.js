'use strict';

/**
 * contentState.js — turns a registered token plus the in-memory realtime status
 * into the `content-state` object ActivityKit hands to Swift's JSONDecoder.
 *
 * Three rules here are load-bearing, and breaking any of them fails SILENTLY:
 * Apple accepts the push, the device receives it, and the card just never
 * changes.
 *
 *  1. Keys and types must match JourneyLiveActivityAttributes.ContentState.
 *  2. Every non-optional Swift property must be present in EVERY push — the
 *     synthesized decoder throws on a missing key instead of using a default,
 *     and one throw discards the whole update.
 *  3. Dates are seconds since the SWIFT REFERENCE DATE (2001-01-01 UTC), sent
 *     as JSON numbers — not ISO strings, not Unix epochs.
 */

// 2001-01-01T00:00:00Z expressed in Unix seconds.
const SWIFT_EPOCH_OFFSET = 978307200;

// Matches the app's own UI threshold — must not diverge from it.
const DELAY_THRESHOLD_MIN = 2;

// Same guard the realtime controller uses: real delays can be huge (Optima
// Express runs 700+ min late), so this only rejects multi-day feed glitches.
const MAX_ABS_DELAY_SEC = 20 * 3600;

/** Unix seconds → Swift reference-date seconds. */
function toSwiftDate(unixSeconds) {
    return unixSeconds == null ? null : unixSeconds - SWIFT_EPOCH_OFFSET;
}

/** Swift reference-date seconds → Unix seconds (used by tests and the sender). */
function fromSwiftDate(swiftSeconds) {
    return swiftSeconds == null ? null : swiftSeconds + SWIFT_EPOCH_OFFSET;
}

/**
 * Tolerant station-name matching. The app registers Bulgarian names to line up
 * with the feed, but spelling drifts ("Ловеч-север" vs "Ловеч - Север",
 * "Вр.депо" vs "Вр депо"), so compare on a folded form rather than equality.
 */
function normalizeStation(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // combining marks (й → и, etc.)
        .replace(/[.\-–—]/g, ' ')        // dots and dashes are noise here
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const toMin = (sec) =>
    (sec == null || Math.abs(sec) > MAX_ABS_DELAY_SEC) ? null : Math.round(sec / 60);

function findStopIndex(stops, stationName) {
    const target = normalizeStation(stationName);
    if (!target) return -1;
    let exact = -1, partial = -1;
    for (let i = 0; i < stops.length; i++) {
        const s = normalizeStation(stops[i].station);
        if (!s) continue;
        if (s === target) { exact = i; break; }
        if (partial === -1 && (s.startsWith(target) || target.startsWith(s))) partial = i;
    }
    return exact !== -1 ? exact : partial;
}

/**
 * Fraction of the passenger's OWN segment already covered.
 * Feed-based when the trip covers both ends; otherwise a clock-based estimate.
 *
 * (The brief allows falling back to 0.0, but we do not store a previous value,
 * and emitting 0.0 mid-journey would visibly rewind the progress bar. A clock
 * estimate between the scheduled times degrades far more gracefully.)
 */
function computeProgress({ stops, bIdx, dIdx, nowSec, schedDepSec, schedArrSec }) {
    if (stops && bIdx >= 0 && dIdx > bIdx) {
        const hops = dIdx - bIdx;
        let passed = 0;
        for (let i = bIdx + 1; i <= dIdx; i++) {
            const t = stops[i].arrivalTime;
            if (t != null && t < nowSec) passed++;
        }
        return Math.min(1, Math.max(0, passed / hops));
    }
    if (schedDepSec != null && schedArrSec != null && schedArrSec > schedDepSec) {
        return Math.min(1, Math.max(0, (nowSec - schedDepSec) / (schedArrSec - schedDepSec)));
    }
    return 0;
}

/**
 * Build the push payload's content-state for one token.
 *
 * @param {object}      tokenRow  row from live_activity_tokens
 * @param {object|null} rt        cache.getTrain(trainNumber) — raw in-memory
 *                                stops with Unix-second times, or null
 * @param {Date}        now
 * @returns {{ state: object, meta: object }}
 *          `meta` carries the values the worker diffs against the stored ones.
 */
function build(tokenRow, rt, now = new Date()) {
    const nowSec = Math.floor(now.getTime() / 1000);
    const schedDepSec = Math.floor(new Date(tokenRow.scheduled_departure).getTime() / 1000);
    const schedArrSec = Math.floor(new Date(tokenRow.scheduled_arrival).getTime() / 1000);

    const stops = rt && Array.isArray(rt.stops)
        ? rt.stops.filter(s => s.station)   // unnamed technical points are useless here
        : null;

    const bIdx = stops ? findStopIndex(stops, tokenRow.boarding_station) : -1;
    const dIdx = stops ? findStopIndex(stops, tokenRow.destination_station) : -1;

    // Current delay = the delay where the train is heading next, matching what
    // GET /api/realtime/train/:n reports as its headline.
    let delayMinutes = null;
    let nextStop = null;
    if (stops && stops.length) {
        const upcoming = stops.filter(s => s.arrivalTime != null && s.arrivalTime >= nowSec);
        const ref = upcoming[0] || stops[stops.length - 1];
        if (ref) {
            delayMinutes = toMin(ref.arrivalDelay ?? ref.departureDelay);
            nextStop = upcoming[0] ? upcoming[0].station : null;
        }
    }

    const phase = nowSec < schedDepSec ? 'preDeparture' : 'inTransit';

    const progress = computeProgress({ stops, bIdx, dIdx, nowSec, schedDepSec, schedArrSec });

    const predictedDepartureUnix = (stops && bIdx >= 0)
        ? (stops[bIdx].departureTime ?? stops[bIdx].arrivalTime ?? null) : null;
    const predictedArrivalUnix = (stops && dIdx >= 0)
        ? (stops[dIdx].arrivalTime ?? stops[dIdx].departureTime ?? null) : null;

    // ── Mandatory fields: present on every single push, no exceptions ────────
    const state = {
        progressPercentage:    Number(progress.toFixed(4)),
        isDelayed:             delayMinutes != null && delayMinutes >= DELAY_THRESHOLD_MIN,
        lastUpdated:           toSwiftDate(nowSec),
        phase,
        directionStation:      tokenRow.direction_station || tokenRow.destination_station || '',
        currentLegIndex:       tokenRow.current_leg_index ?? 0,
        isNextTransportBus:    !!tokenRow.is_next_transport_bus,
        isCurrentTransportBus: !!tokenRow.is_current_bus,
    };

    // ── Optional fields: omitted entirely when unknown, never sent as null ───
    if (delayMinutes != null) state.delayMinutes = delayMinutes;
    if (predictedDepartureUnix != null) state.predictedDeparture = toSwiftDate(predictedDepartureUnix);
    if (predictedArrivalUnix != null) state.predictedArrival = toSwiftDate(predictedArrivalUnix);
    if (tokenRow.next_transport_number) state.nextTransportNumber = tokenRow.next_transport_number;
    if (tokenRow.next_transport_departure) {
        const t = new Date(tokenRow.next_transport_departure).getTime();
        if (!Number.isNaN(t)) state.nextTransportDeparture = toSwiftDate(Math.floor(t / 1000));
    }

    return {
        state,
        meta: {
            delayMinutes,
            nextStop,
            phase,
            hasFeed: !!stops,
            // Unix seconds; the worker uses it to decide when to end the activity.
            predictedArrivalUnix: predictedArrivalUnix ?? schedArrSec,
        },
    };
}

module.exports = {
    build, toSwiftDate, fromSwiftDate, normalizeStation, findStopIndex,
    computeProgress, SWIFT_EPOCH_OFFSET, DELAY_THRESHOLD_MIN,
};
