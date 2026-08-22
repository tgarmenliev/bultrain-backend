'use strict';

/**
 * worker.js — change-detection loop that keeps Live Activities current.
 *
 * Runs on a timer, reads ONLY the in-memory realtime cache (it adds no polling
 * of BDZ or the GTFS feed — it is a diff over data the realtime poller already
 * holds), and pushes exclusively when something a passenger would notice has
 * actually changed.
 *
 * Kept free of Express so it can be lifted into its own process later without
 * touching the API layer: it talks to store/apns/cache and nothing else.
 *
 * NOTE on batching: the brief says to build the content-state once per train.
 * That is only safe when every token on a train describes the same journey —
 * but two passengers on one train have different boarding/destination stops and
 * therefore different progress and predicted times. Building once per train
 * would send one passenger's progress to another. We memoise per REGISTRATION
 * CONTEXT instead, which keeps the intended saving (one build + one serialise
 * per distinct payload, shared by a journey's rotated tokens) and stays correct.
 */

const crypto = require('crypto');

const cache        = require('../realtime/cache');
const geometryOf   = require('../gtfs/tripGeometry');
const trainCategory = require('../gtfs/trainCategory');
const store        = require('./store');
const armedStore   = require('./armedStore');
const armedWatcher = require('./armedWatcher');
const apns         = require('./apns');
const contentState = require('./contentState');
const metrics      = require('./metrics');

const TICK_MS                  = 30 * 1000;
const CLEANUP_MS               = 60 * 60 * 1000;
// How far the progress bar must move to be worth a push (2% of the passenger's
// own segment), and how long a GPS-tracked card may go without any push.
const PROGRESS_DELTA           = 0.02;
const GPS_HEARTBEAT_MS         = 5 * 60 * 1000;
const PER_TOKEN_MIN_INTERVAL_MS = 60 * 1000;   // at most one push per token per minute
const END_AFTER_ARRIVAL_MS     = 10 * 60 * 1000;
const STALE_AFTER_MS           = 15 * 60 * 1000;
const LARGE_DELAY_JUMP_MIN     = 5;            // worth spending an urgent push on

let tickTimer = null;
let cleanupTimer = null;
let started = false;
const departureTimers = new Map(); // token -> Timeout, so we only schedule once

// ── Change detection ─────────────────────────────────────────────────────────

/**
 * Pure predicate: does this token need a push?
 * Exported for tests — it is the piece that decides all push volume.
 *
 * @param {object} row  live_activity_tokens row (carries the last_* state)
 * @param {object} meta contentState.build().meta for the current feed state
 * @returns {{changed: boolean, reason?: string, priority?: number}}
 */
function hasChanged(row, meta) {
    if (!row.last_pushed_at) return { changed: true, reason: 'initial', priority: 5 };

    // The card's whole layout flips at departure, so this is worth an urgent push.
    if ((row.last_phase || null) !== (meta.phase || null)) {
        return { changed: true, reason: 'phase', priority: 10 };
    }

    const prev = row.last_delay_min == null ? null : Number(row.last_delay_min);
    const cur  = meta.delayMinutes == null ? null : Number(meta.delayMinutes);

    // Delay information appearing or disappearing changes what the card shows.
    if ((prev == null) !== (cur == null)) {
        return { changed: true, reason: 'delay-availability', priority: 5 };
    }

    if (prev != null && cur != null) {
        const wasDelayed = prev >= contentState.DELAY_THRESHOLD_MIN;
        const isDelayed  = cur  >= contentState.DELAY_THRESHOLD_MIN;
        // Crossing the on-time/delayed line matters in BOTH directions: going
        // late, and recovering back to on time.
        if (wasDelayed !== isDelayed) {
            return { changed: true, reason: 'delay-threshold', priority: 10 };
        }
        const jump = Math.abs(cur - prev);
        if (jump >= LARGE_DELAY_JUMP_MIN) return { changed: true, reason: 'delay-jump', priority: 10 };
        if (jump >= 2) return { changed: true, reason: 'delay', priority: 5 };
    }

    if ((row.last_next_stop || null) !== (meta.nextStop || null)) {
        return { changed: true, reason: 'next-stop', priority: 5 };
    }

    // The bar moved far enough to be visible. Priority 5 on purpose: Apple
    // documents priority 5 as having NO update limit, while priority 10 is
    // metered against an undocumented per-device budget that takes up to 24
    // hours to refill. Spending that budget on a progress bar would silence the
    // updates that actually matter.
    const prevProgress = row.last_progress == null ? null : Number(row.last_progress);
    if (prevProgress != null && meta.progress != null
        && Math.abs(meta.progress - prevProgress) >= PROGRESS_DELTA) {
        return { changed: true, reason: 'progress', priority: 5 };
    }

    // Floor for a GPS-tracked train: it has no feed events to react to, so
    // without a heartbeat a long stretch between stops would show a frozen card.
    // Trains WITH a feed need no floor — their stops and delays keep it alive.
    if (meta.isGPSTracked && row.last_pushed_at) {
        const since = Date.now() - new Date(row.last_pushed_at).getTime();
        if (since >= GPS_HEARTBEAT_MS) {
            return { changed: true, reason: 'gps-heartbeat', priority: 5 };
        }
    }

    return { changed: false };
}

/** Tokens describing the same journey share a payload; different ones must not. */
function contextKey(row) {
    return [
        row.train_number, row.boarding_station, row.destination_station,
        row.direction_station, row.current_leg_index, row.is_current_bus,
        row.next_transport_number, row.next_transport_departure,
        row.is_next_transport_bus, row.scheduled_departure, row.scheduled_arrival,
    ].join('|');
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * The card's per-leg transport number wants the passenger-facing form
 * ("БВ 8611"). Prefer what the client registered; otherwise compose it from the
 * train's GTFS category, so an older client still gets a sensible label instead
 * of a bare number.
 */
function withLegDisplay(row) {
    if (!row || row.train_number_display) return row;
    return { ...row, train_number_display: trainCategory.displayFor(row.train_number) };
}

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

// ── One tick ─────────────────────────────────────────────────────────────────

async function tick(now = new Date()) {
    metrics.inc('live_activity_worker_ticks');
    if (!apns.isConfigured()) return { sent: 0, skipped: 0, reason: 'apns-not-configured' };

    const nowMs  = now.getTime();
    const nowSec = Math.floor(nowMs / 1000);

    const rows = store.listActive();
    if (!rows.length) return { sent: 0, skipped: 0 };

    // Group by train so the realtime lookup happens once per train.
    const byTrain = new Map();
    for (const row of rows) {
        if (!byTrain.has(row.train_number)) byTrain.set(row.train_number, []);
        byTrain.get(row.train_number).push(row);
    }

    const tasks = [];
    let skipped = 0;

    for (const [trainNumber, tokens] of byTrain) {
        const rt = cache.getTrain(trainNumber);     // in-memory only, no network
        const v  = cache.getVehicle(trainNumber);   // for the GPS-tracked flag + progress
        // Static geometry for segment progress, by whichever trip_id we have.
        const geoTripId = (rt && rt.tripId) || (v && v.tripId) || null;
        const geo = geoTripId ? geometryOf.getByTripId(geoTripId) : null;
        const built = new Map();                  // contextKey -> { state, meta, body, hash }

        for (const row of tokens) {
            const key = contextKey(row);

            if (!built.has(key)) {
                const { state, meta } = contentState.build(withLegDisplay(row), rt, now, v, geo);
                built.set(key, { state, meta, body: null, hash: null, endBody: null });
            }
            const ctx = built.get(key);

            // The journey is over: end the activity instead of updating it.
            const arrived = ctx.meta.predictedArrivalUnix != null &&
                nowSec > ctx.meta.predictedArrivalUnix + END_AFTER_ARRIVAL_MS / 1000;

            if (arrived) {
                if (!ctx.endBody) {
                    ctx.endBody = buildBody(ctx.state, {
                        nowSec, predictedArrivalUnix: ctx.meta.predictedArrivalUnix,
                        event: 'end', dismissalUnix: nowSec,
                    });
                }
                tasks.push(makeTask(row, ctx.endBody, 10, ctx.meta, { end: true }));
                continue;
            }

            const decision = hasChanged(row, ctx.meta);
            if (!decision.changed) { skipped++; metrics.inc('live_activity_pushes_skipped_unchanged'); continue; }

            // One push per token per minute, whatever the feed does.
            if (row.last_pushed_at && (nowMs - new Date(row.last_pushed_at).getTime()) < PER_TOKEN_MIN_INTERVAL_MS) {
                skipped++; metrics.inc('live_activity_pushes_skipped_throttled'); continue;
            }

            if (!ctx.body) {
                ctx.body = buildBody(ctx.state, { nowSec, predictedArrivalUnix: ctx.meta.predictedArrivalUnix });
                ctx.hash = hash(ctx.body);
            }
            // Identical content is not worth a push, even if a field wobbled.
            if (row.last_content_hash && row.last_content_hash === ctx.hash) {
                skipped++; metrics.inc('live_activity_pushes_skipped_unchanged'); continue;
            }

            tasks.push(makeTask(row, ctx.body, decision.priority || 5, ctx.meta, { hash: ctx.hash }));
        }
    }

    const results = await apns.sendAll(tasks);
    const sent = results.filter(r => r && r.ok).length;
    return { sent, skipped, queued: tasks.length };
}

/** A closure the bounded-concurrency sender can call. */
function makeTask(row, body, priority, meta, { end = false, hash: contentHash } = {}) {
    return async () => {
        const res = await apns.send({
            token: row.token, environment: row.environment, body, priority,
        });

        if (res.outcome === 'invalid-token') {
            // Dead token — drop it and never retry.
            store.remove(row.token);
            metrics.inc('live_activity_tokens_pruned');
            return { ok: false, outcome: res.outcome };
        }

        if (res.outcome === 'ok') {
            if (end) {
                store.remove(row.token);
                metrics.inc('live_activity_ends_sent');
            } else {
                store.markPushed(row.token, {
                    delayMin: meta.delayMinutes,
                    nextStop: meta.nextStop,
                    contentHash,
                    phase: meta.phase,
                    progress: meta.progress,
                });
            }
            return { ok: true };
        }

        // rate-limited / server / error: leave the row untouched so the next
        // tick reconsiders it with fresher state.
        return { ok: false, outcome: res.outcome };
    };
}

// ── Departure-moment pushes ──────────────────────────────────────────────────

/**
 * The card flips from the pre-departure layout to in-transit at the scheduled
 * departure. Waiting for the next 30s tick would show that up to half a minute
 * late, so tokens departing within this tick get their own timer.
 */
function scheduleDepartures(now = new Date()) {
    const rows = store.listActive();
    for (const row of rows) {
        const depMs = new Date(row.scheduled_departure).getTime();
        const delta = depMs - now.getTime();
        if (delta <= 0 || delta > TICK_MS) continue;
        if (departureTimers.has(row.token)) continue;

        const timer = setTimeout(async () => {
            departureTimers.delete(row.token);
            try {
                const fresh = store.getByToken(row.token);
                if (!fresh) return;
                const rt = cache.getTrain(fresh.train_number);
                const v  = cache.getVehicle(fresh.train_number);
                const geoTripId = (rt && rt.tripId) || (v && v.tripId) || null;
                const geo = geoTripId ? geometryOf.getByTripId(geoTripId) : null;
                const nowSec = Math.floor(Date.now() / 1000);
                const { state, meta } = contentState.build(withLegDisplay(fresh), rt, new Date(), v, geo);
                const body = buildBody(state, { nowSec, predictedArrivalUnix: meta.predictedArrivalUnix });
                // Phase change: worth priority 10 and worth bypassing the
                // per-minute throttle, which exists for feed noise, not this.
                await makeTask(fresh, body, 10, meta, { hash: hash(body) })();
            } catch (err) {
                console.error('[la] departure push failed:', err.message);
            }
        }, delta);
        if (timer.unref) timer.unref();
        departureTimers.set(row.token, timer);
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function runTick() {
    try {
        const r = await tick();
        if (r.queued) console.log(`[la] tick: ${r.sent} sent, ${r.skipped} skipped of ${r.queued} queued`);
        scheduleDepartures();
    } catch (err) {
        console.error('[la] worker tick failed:', err.message);
    }

    // Server-driven tracking rides the same tick: one process, one database
    // handle, one APNs session. Isolated in its own try so a failure there can
    // never stop the card updates above.
    try {
        await armedWatcher.tick();
    } catch (err) {
        console.error('[armed] watcher tick failed:', err.message);
    }
}

function runCleanup() {
    try {
        const removed = store.pruneExpired();
        if (removed) {
            metrics.inc('live_activity_tokens_pruned', removed);
            console.log(`[la] cleanup: pruned ${removed} expired token(s)`);
        }
    } catch (err) {
        console.error('[la] cleanup failed:', err.message);
    }
    try {
        const { logs, rows } = armedStore.prune();
        if (logs || rows) console.log(`[armed] cleanup: pruned ${rows} finished journey(s), ${logs} budget log row(s)`);
    } catch (err) {
        console.error('[armed] cleanup failed:', err.message);
    }
}

function start() {
    if (started) return;
    started = true;
    if (!apns.isConfigured()) {
        console.warn('[la] Live Activity worker started but APNs is not configured — registration still works, no pushes will be sent');
    }
    tickTimer = setInterval(runTick, TICK_MS);
    cleanupTimer = setInterval(runCleanup, CLEANUP_MS);
    if (tickTimer.unref) tickTimer.unref();
    if (cleanupTimer.unref) cleanupTimer.unref();
    runTick();
    runCleanup();
    console.log('[la] Live Activity push worker started');
}

function stop() {
    clearInterval(tickTimer);
    clearInterval(cleanupTimer);
    for (const t of departureTimers.values()) clearTimeout(t);
    departureTimers.clear();
    started = false;
}

module.exports = {
    start, stop, tick, runCleanup, hasChanged, buildBody, contextKey,
    TICK_MS, PER_TOKEN_MIN_INTERVAL_MS, END_AFTER_ARRIVAL_MS, LARGE_DELAY_JUMP_MIN,
};
