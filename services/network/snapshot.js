'use strict';

/**
 * snapshot.js — "the living network": one honest picture of the rail network,
 * computed by the server on a timer and served from memory.
 *
 * Visitors never trigger work. A build takes tens of milliseconds and touches
 * only the in-memory realtime cache plus a per-day schedule window list, so it
 * runs once a MINUTE (the realtime feeds tick every 30–60 s; building more
 * often would only re-describe the same data). Nothing in a build leaves the
 * process: even the departure boards are built from our own schedule and delays
 * (boards.js), because БДЖ's live site is unreachable from the server.
 * What a build produces is serialised and gzipped ONCE; every request is a
 * buffer write.
 *
 * Honesty rules (the same ones the apps follow):
 *   - delay figures come only from trains that have a TripUpdate; they are null
 *     when the feed is stale or no train has one — never estimated, never 0
 *   - a position is a measured fix, never projected from the schedule
 *   - "running" is the schedule's answer, widened only by trains the realtime
 *     feeds themselves say are on the road
 */

const crypto = require('crypto');
const zlib   = require('zlib');

const cache      = require('../realtime/cache');
const tripMeta   = require('../realtime/tripMeta');
const geometryOf = require('../gtfs/tripGeometry');
const { summarize, progressOf } = require('../realtime/trainStatus');
const schedule   = require('./schedule');
const boards     = require('./boards');

const BUILD_EVERY_MS = 60 * 1000;
const FIRST_BUILD_MS = 10 * 1000;     // let the poller land its first feeds
const ON_TIME_BELOW_MIN = 5;          // "on time" = under 5 minutes late
const STARTED_SLACK_SEC = 30 * 60;    // a TripUpdate whose first stop is further off than this is another run

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const times = (rt) => (rt.stops || []).map(s => s.arrivalTime ?? s.departureTime).filter(x => x != null);

/** Under way: some stop already behind it and some still ahead. */
function midRoute(rt, nowSec) {
    const t = times(rt);
    return t.some(x => x < nowSec) && t.some(x => x >= nowSec);
}

/** Is this TripUpdate the run that is on the road now (not tomorrow's, not finished)? */
function isCurrentRun(rt, nowSec) {
    if (midRoute(rt, nowSec)) return true;
    const t = times(rt);
    return t.length > 0 && t.every(x => x >= nowSec) && Math.min(...t) <= nowSec + STARTED_SLACK_SEC;
}

function defaultDeps() {
    return {
        status:   cache.status(),
        vehicles: cache.getAllVehicles(),
        trains:   cache.getAllTrains(),
        getTrain: cache.getTrain,
        getTripFor: cache.getTripFor,
        running:  null,   // filled below (needs nowMs)
        geoFor:   geometryOf.getByTripId,
        metaFor:  tripMeta.get,
        nameOf:   schedule.nameOf,
        boards:   boards.view,
    };
}

/**
 * Pure: everything the snapshot says, from its inputs. Exported for tests.
 * @returns {{network:object, radar:object}}
 */
function compute(nowMs, deps) {
    const d = { ...defaultDeps(), ...deps };
    const nowSec = nowMs / 1000;
    const running = d.running || schedule.runningAt(nowMs);

    // ── who is on the road ──────────────────────────────────────────────────
    const entries = new Map();
    const entry = (num) => {
        if (!entries.has(num)) entries.set(num, { num, sched: null, v: null });
        return entries.get(num);
    };
    for (const [num, info] of running) entry(num).sched = info;
    for (const [num, v] of d.vehicles) entry(num).v = v;                   // a live fix: it IS running
    for (const [num, rt] of d.trains) if (!entries.has(num) && midRoute(rt, nowSec)) entry(num);

    // ── one object per train ────────────────────────────────────────────────
    const radar = [];
    const known = [];   // trains that have a real delay figure
    for (const e of entries.values()) {
        // The vehicle's own run; for a train seen only on the schedule, the run
        // that is actually current (never tomorrow's or yesterday's).
        let rt = e.v ? d.getTripFor(e.num, e.v.tripId) : d.getTrain(e.num);
        if (rt && !e.v && !isCurrentRun(rt, nowSec)) rt = null;

        const delayMin = rt ? summarize({ rt, v: null, geo: null, nowSec }).delayMinutes : null;

        const meta = e.sched ? null : d.metaFor((e.v && e.v.tripId) || (rt && rt.tripId));
        const category = e.sched ? e.sched.category : (meta ? meta.category : null);
        const fromId = e.sched ? e.sched.fromId : (meta ? meta.originStationId : null);
        const toId   = e.sched ? e.sched.toId   : (meta ? meta.destinationStationId : null);

        const geo = e.v && e.v.tripId ? d.geoFor(e.v.tripId) : null;
        const prog = e.v ? progressOf(e.v, geo) : null;

        const t = {
            type: category,
            trainNum: e.num,
            from: d.nameOf(fromId),
            to: d.nameOf(toId),
            fromId: fromId ?? null,
            toId: toId ?? null,
            delayMin,
            progress: prog == null ? null : Math.round(prog * 1000) / 1000,
            lat: e.v ? Math.round(e.v.lat * 1e5) / 1e5 : null,
            lon: e.v ? Math.round(e.v.lon * 1e5) / 1e5 : null,
        };
        radar.push(t);
        if (delayMin != null) known.push(t);
    }
    radar.sort((a, b) => a.trainNum.localeCompare(b.trainNum, undefined, { numeric: true }));

    // ── the headline numbers ────────────────────────────────────────────────
    const available = !!d.status.tripFresh;
    const summary = {
        running: radar.length,
        withRealtime: available ? known.length : 0,
        onTimePercent: null,
        avgDelayMin: null,
        maxDelay: null,
    };
    if (available && known.length > 0) {
        const onTime = known.filter(t => t.delayMin < ON_TIME_BELOW_MIN).length;
        summary.onTimePercent = Math.round((100 * onTime) / known.length);
        // Early arrivals do not cancel out lateness: they count as on time (0).
        summary.avgDelayMin = Math.round(known.reduce((s, t) => s + Math.max(0, t.delayMin), 0) / known.length);
        const worst = known.reduce((a, b) => (b.delayMin > a.delayMin ? b : a));
        if (worst.delayMin >= 1) {
            summary.maxDelay = { min: worst.delayMin, type: worst.type, trainNum: worst.trainNum, to: worst.to };
        }
    }

    const realtime = {
        available,
        feedUpdatedAt: iso(d.status.tripFeedTs),          // the delays come from this feed
        positionsUpdatedAt: iso(d.status.vehicleFeedTs),  // the dots come from this one
    };
    const generatedAt = new Date(nowMs).toISOString();

    return {
        network: { generatedAt, realtime, summary, boards: d.boards(nowMs) },
        radar: { generatedAt, realtime, count: radar.length, trains: radar },
    };
}

// ── The published copy: serialised and gzipped once per build ────────────────

const published = { network: null, radar: null };

function pack(obj, builtAtMs) {
    const json = Buffer.from(JSON.stringify(obj));
    return {
        json,
        gzip: zlib.gzipSync(json, { level: 9 }),
        etag: `"${crypto.createHash('sha1').update(json).digest('hex').slice(0, 16)}"`,
        builtAtMs,
        nextBuildMs: builtAtMs + BUILD_EVERY_MS,
    };
}

function build(nowMs = Date.now(), deps) {
    const t0 = process.hrtime.bigint();
    const { network, radar } = compute(nowMs, deps);
    published.network = pack(network, nowMs);
    published.radar = pack(radar, nowMs);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > 250) console.warn(`[network] snapshot build took ${Math.round(ms)} ms`);
    return ms;
}

/** The current published copy for 'network' | 'radar', or null before the first build. */
const get = (kind) => published[kind] || null;

let started = false;
function start() {
    if (started) return;
    started = true;
    const run = () => {
        try { build(); } catch (err) { console.error('[network] snapshot build failed:', err.message); }
    };
    const first = setTimeout(run, FIRST_BUILD_MS);
    const every = setInterval(run, BUILD_EVERY_MS);
    first.unref(); every.unref();
    console.log('[network] public network snapshot started (rebuilt every 60 s)');
}

/** Tests only. */
function _reset() { published.network = null; published.radar = null; }

module.exports = { compute, build, get, start, _reset, BUILD_EVERY_MS, ON_TIME_BELOW_MIN };
