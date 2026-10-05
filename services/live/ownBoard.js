'use strict';

/**
 * ownBoard.js — a station's departure / arrival board built from OUR data: the
 * saved GTFS schedule plus the delays from the realtime feed. No request to БДЖ.
 *
 * Why it exists: БДЖ's live site (live.bdz.bg) can be unreachable from the server
 * (it was: connect timeouts for hours), and the board then simply did not load.
 * This reproduces the board БДЖ's page shows — same JSON shape the E-ink screen
 * and the website already read — from data we hold and trust:
 *
 *   - which trains call, and when, is the schedule (all trips of the service days
 *     around now, overnight runs included)
 *   - a delay is shown only for a train the realtime feed has a delay for at THIS
 *     station; a train without one keeps its scheduled time and is not marked
 *     delayed (and `hasLiveDelay` says so for the clients that ask) — we never
 *     guess punctuality
 *   - a trip the feed marks CANCELED (or every stop SKIPPED), or a call it marks SKIPPED, is
 *     not listed on the E-ink shape; the website's rows carry `status` ('cancelled' |
 *     'not_stopping') so it can say so. A train missing from the feed is NOT taken as
 *     cancelled — absence means "no data" (most trains have none)
 *
 * Like БДЖ's board: ordered by SCHEDULED time, a window from a few minutes ago to
 * ~6 hours ahead, a delayed train stays until its EXPECTED time has passed, and
 * `time` is the expected time with `delayedTime` the scheduled one when delayed (an
 * early train keeps its scheduled time, as on БДЖ's page).
 */

const path     = require('path');
const Database = require('better-sqlite3');

const cache    = require('../realtime/cache');
const tripMeta = require('../realtime/tripMeta');
const { abbrevFor }          = require('../gtfs/categoryDisplay');
const { displayStationName } = require('../gtfs/stationDisplay');
const { nameOf }             = require('../network/schedule');

const DB_PATH      = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES  = 600;

const BACK_MS     = 5 * 60 * 1000;        // still listed this long after its (expected) time
const HORIZON_MS  = 6 * 60 * 60 * 1000;   // БДЖ's page reaches about this far ahead
const MATCH_MS    = 5 * 60 * 1000;        // a feed stop belongs to a scheduled call within this
const MAX_ABS_DELAY_SEC = 20 * 3600;      // same guard as the train endpoint

let db = null;
const conn = () => (db || (db = new Database(DB_PATH, { readonly: true, fileMustExist: true })));

const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Epoch ms of 00:00 Sofia time on `ymd`. */
function sofiaMidnightMs(ymd) {
    const guess = Date.parse(`${ymd}T00:00:00Z`);
    const wall = new Date(guess).toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' });   // "2026-10-04 03:00:00"
    const offset = Date.parse(`${wall.replace(' ', 'T')}Z`) - guess;
    return guess - offset;
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
});

// ── The schedule at one station on one service day ───────────────────────────

/**
 * Every call at `stationId` on `date`: minutes from that date's midnight (an
 * after-midnight time is > 1440), the trip's ends, and its category.
 * materialize.js wraps times past 24:00 to HH:MM, so a backwards jump while
 * walking a trip's stops is a midnight crossing.
 */
function loadStationDay(stationId, date) {
    const rows = conn().prepare(`
        SELECT t.trip_id AS tripId, t.train_number AS num, t.category, ts.station_id AS stationId,
               ts.arrive, ts.depart
          FROM trip_date td
          JOIN trip t       ON t.trip_id = td.trip_id
          JOIN trip_stop ts ON ts.trip_id = t.trip_id
         WHERE td.date = ?
           AND t.trip_id IN (SELECT trip_id FROM trip_stop WHERE station_id = ?)
         ORDER BY t.trip_id, ts.seq
    `).all(date, stationId);

    const calls = [];
    let cur = null;
    let day = 0;
    let prev = null;
    // A trip's calls here become known as its rows go by; whether one is the first or
    // the last stop is known only once the trip's rows have all been seen.
    const flush = () => {
        if (!cur) return;
        for (const c of cur.here) {
            calls.push({
                tripId: cur.tripId, num: cur.num, category: cur.category, fromId: cur.fromId, toId: cur.toId,
                isFirst: c.idx === 0, isLast: c.idx === cur.count - 1, arrAbs: c.arrAbs, depAbs: c.depAbs,
            });
        }
    };
    for (const r of rows) {
        if (!cur || cur.tripId !== r.tripId) {
            flush();
            cur = { tripId: r.tripId, num: r.num, category: r.category, fromId: r.stationId, toId: null, here: [], count: 0 };
            day = 0;
            prev = null;
        }
        const abs = (t) => {
            const m = toMin(t);
            if (m == null) return null;
            if (prev != null && m < prev) day += 1;
            prev = m;
            return day * 1440 + m;
        };
        const arrAbs = abs(r.arrive);
        const depAbs = abs(r.depart);
        cur.toId = r.stationId;
        if (r.stationId === stationId) cur.here.push({ idx: cur.count, arrAbs, depAbs });
        cur.count += 1;
    }
    flush();
    return calls;
}

const dayCache = new Map();   // "station|date" -> { at, value }
function stationDay(stationId, date) {
    const key = `${stationId}|${date}`;
    const hit = dayCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = loadStationDay(stationId, date);
    if (dayCache.size >= MAX_ENTRIES) dayCache.clear();
    dayCache.set(key, { at: Date.now(), value });
    return value;
}

// ── The feed's say on one call ───────────────────────────────────────────────

/**
 * What the realtime feed says about THIS scheduled call, or null when it says nothing.
 *
 * A feed stop belongs to a call when its scheduled time (feed time minus delay) is the
 * call's scheduled time: that picks the right run of a number without trusting trip ids.
 * Cancellations are the exception — a cancelled trip may carry no times at all — so the
 * trip id (exact match) is used for those.
 *
 * @returns {{expectedMs:number, delaySec:number}   a delay
 *          |{cancelled:true}                         the whole trip does not run
 *          |{notStopping:true}                       the trip runs but skips this stop
 *          |null}
 */
function liveCall(runs, call, stationId, kind, schedMs) {
    const allSkipped = (run) => run.stops.length > 0 && run.stops.every(s => s.skipped);

    for (const run of runs) {
        if (run.tripId === call.tripId && (run.canceled || allSkipped(run))) return { cancelled: true };
    }
    for (const run of runs) {
        for (const s of run.stops) {
            if (s.stationId !== stationId) continue;
            const time  = kind === 'dep' ? (s.departureTime ?? s.arrivalTime)   : (s.arrivalTime ?? s.departureTime);
            const delay = kind === 'dep' ? (s.departureDelay ?? s.arrivalDelay) : (s.arrivalDelay ?? s.departureDelay);
            if (time == null || delay == null) continue;
            if (Math.abs((time - delay) * 1000 - schedMs) > MATCH_MS) continue;
            if (run.canceled || allSkipped(run)) return { cancelled: true };
            if (s.skipped) return { notStopping: true };
            if (Math.abs(delay) > MAX_ABS_DELAY_SEC) return null;
            return { expectedMs: time * 1000, delaySec: delay };
        }
    }
    return null;
}

// ── The board ────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {number} o.stationId
 * @param {'departures'|'arrivals'} [o.type]
 * @param {'bg'|'en'} [o.language]
 * @param {number} [o.nowMs]
 * @param {number} [o.limit]       at most this many trains
 * @param {boolean} [o.extended]   add `hasLiveDelay` to each train (not for the E-ink shape)
 * @param {(num:string)=>object[]} [o.getTrips]  realtime runs of a number (tests inject)
 * @returns {{station:string, trains:object[]}|null}  null for an unknown station
 */
function build({ stationId, type = 'departures', language = 'bg', nowMs = Date.now(), limit = 40,
                 extended = false, getTrips = cache.getTrips }) {
    const stationBg = nameOf(stationId);
    if (!stationBg) return null;
    const en = language === 'en';
    const label = (bg) => (bg == null ? '' : `${en ? displayStationName(bg, 'en') : bg} `);

    const dep = type === 'departures';
    const today = tripMeta.sofiaYmd(nowMs);
    const entries = [];

    for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
        const midnight = sofiaMidnightMs(date);
        for (const c of stationDay(stationId, date)) {
            // departures leave from every call but the last; arrivals come to every call but the first
            if (dep ? c.isLast : c.isFirst) continue;
            const abs = dep ? (c.depAbs ?? c.arrAbs) : (c.arrAbs ?? c.depAbs);
            if (abs == null) continue;
            const schedMs = midnight + abs * 60000;

            const live = liveCall(getTrips(c.num), c, stationId, dep ? 'dep' : 'arr', schedMs);
            const status = live && live.cancelled ? 'cancelled' : (live && live.notStopping ? 'not_stopping' : null);
            // The E-ink shape has no place for "cancelled": a train that does not run, or does not
            // stop here, is simply not listed. The website's rows say so (`status`).
            if (status && !extended) continue;
            const delayMin = live && !status ? Math.round(live.delaySec / 60) : null;
            const delayed = delayMin != null && delayMin >= 1;
            // Like БДЖ: a late train shows its expected time; an early or on-time one keeps
            // its scheduled time and is not marked.
            const shownMs = delayed ? live.expectedMs : schedMs;
            if (shownMs < nowMs - BACK_MS || shownMs > nowMs + HORIZON_MS) continue;

            const entry = {
                direction: label(nameOf(dep ? c.toId : c.fromId)),
                time: hhmm(shownMs),
                isDelayed: delayed,
                delayedTime: delayed ? hhmm(schedMs) : 0,
                delayInfo: delayed
                    ? { delayMinutes: delayMin, delayString: `${en ? 'Delay' : 'Закъснение'} ${delayMin} ${en ? 'min.' : 'мин.'} `, delayInfo: '' }
                    : { delayMinutes: 0, delayString: '', delayInfo: '' },
                type: abbrevFor(c.category, language),
                trainNum: c.num,
            };
            if (extended) {
                entry.hasLiveDelay = !!live && !status;
                if (status) entry.status = status;
            }
            entries.push({ schedMs, entry });
        }
    }

    // БДЖ orders by scheduled time; the same number never appears twice for one call.
    entries.sort((a, b) => a.schedMs - b.schedMs || a.entry.trainNum.localeCompare(b.entry.trainNum, undefined, { numeric: true }));
    return {
        station: label(stationBg),
        trains: entries.slice(0, limit).map(e => e.entry),
    };
}

function _reset() { dayCache.clear(); }

module.exports = { build, sofiaMidnightMs, _reset, BACK_MS, HORIZON_MS };
