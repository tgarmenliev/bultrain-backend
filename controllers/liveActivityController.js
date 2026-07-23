'use strict';

/**
 * liveActivityController.js — registration surface for Live Activity pushes.
 *
 * register/unregister touch ONLY the database. They must keep working when APNs
 * is unreachable or unconfigured: a device that cannot register is a card that
 * can never be updated, which is strictly worse than a delayed first push.
 */

const store   = require('../services/liveactivity/store');
const apns    = require('../services/liveactivity/apns');
const metrics = require('../services/liveactivity/metrics');

const MAX_TOKENS_PER_JOURNEY = 5;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const ENVIRONMENTS = new Set(['sandbox', 'production']);

const bad = (res, message) => res.status(400).json({ error: message });

/** Never log a full push token. */
const maskToken = (t) => (typeof t === 'string' && t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : '(invalid)');

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/live-activity/register
 * Upsert on token: iOS rotates the token during an activity's life, and a
 * multi-leg journey re-registers with new context at each transfer.
 */
exports.register = (req, res) => {
    try {
        const b = req.body || {};

        if (!b.token || typeof b.token !== 'string' || !HEX64.test(b.token)) {
            return bad(res, 'token must be a 64-character hex string.');
        }
        if (!ENVIRONMENTS.has(b.environment)) {
            return bad(res, "environment must be either 'sandbox' or 'production'.");
        }
        const trainNumber = String(b.trainNumber ?? '').trim();
        if (!trainNumber) return bad(res, 'trainNumber is required.');

        const boarding = String(b.boardingStation ?? '').trim();
        const destination = String(b.destinationStation ?? '').trim();
        if (!boarding) return bad(res, 'boardingStation is required.');
        if (!destination) return bad(res, 'destinationStation is required.');

        const departure = parseDate(b.scheduledDeparture);
        const arrival   = parseDate(b.scheduledArrival);
        if (!departure) return bad(res, 'scheduledDeparture must be a valid date.');
        if (!arrival)   return bad(res, 'scheduledArrival must be a valid date.');
        if (arrival <= departure) {
            return bad(res, 'scheduledArrival must be after scheduledDeparture.');
        }

        const legIndex = Number.isInteger(b.currentLegIndex) ? b.currentLegIndex : 0;
        if (legIndex < 0) return bad(res, 'currentLegIndex must be zero or greater.');

        // Cap live tokens per journey so registration cannot be used to flood.
        if (b.journeyId && store.countForJourney(b.journeyId, b.token) >= MAX_TOKENS_PER_JOURNEY) {
            return res.status(429).json({
                error: `This journey already has ${MAX_TOKENS_PER_JOURNEY} registered tokens.`,
            });
        }

        store.upsert({
            token: b.token,
            environment: b.environment,
            journey_id: b.journeyId ? String(b.journeyId) : null,
            train_number: trainNumber,
            boarding_station: boarding,
            destination_station: destination,
            direction_station: b.directionStation ? String(b.directionStation).trim() : null,
            scheduled_departure: departure.toISOString(),
            scheduled_arrival: arrival.toISOString(),
            current_leg_index: legIndex,
            is_current_bus: b.isCurrentTransportBus ? 1 : 0,
            next_transport_number: b.nextTransportNumber ? String(b.nextTransportNumber) : null,
            next_transport_departure: parseDate(b.nextTransportDeparture)?.toISOString() ?? null,
            is_next_transport_bus: b.isNextTransportBus ? 1 : 0,
        });

        res.json({ ok: true, token: maskToken(b.token), apnsConfigured: apns.isConfigured() });
    } catch (err) {
        console.error('[la] register failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/live-activity/unregister
 * Idempotent by design — the app calls this on arrival and on manual end, and
 * may well call it twice or for a token we already pruned.
 */
exports.unregister = (req, res) => {
    try {
        const token = req.body?.token;
        if (!token || typeof token !== 'string' || !HEX64.test(token)) {
            return bad(res, 'token must be a 64-character hex string.');
        }
        const removed = store.remove(token);
        res.json({ ok: true, removed });
    } catch (err) {
        console.error('[la] unregister failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/live-activity/test-push   (only when ENABLE_LIVE_ACTIVITY_TEST_PUSH=on)
 * Sends a hand-written content-state at a real device — the fastest way to
 * confirm the Swift decoding end-to-end while the iOS side is being built.
 */
exports.testPush = async (req, res) => {
    if (process.env.ENABLE_LIVE_ACTIVITY_TEST_PUSH !== 'on') {
        return res.status(404).json({ error: 'Not found.' });
    }
    if (!apns.isConfigured()) {
        return res.status(503).json({ error: 'APNs is not configured on this server.' });
    }

    const { token, environment, contentState } = req.body || {};
    if (!token || !HEX64.test(String(token))) return bad(res, 'token must be a 64-character hex string.');
    if (!ENVIRONMENTS.has(environment)) return bad(res, "environment must be either 'sandbox' or 'production'.");
    if (!contentState || typeof contentState !== 'object') return bad(res, 'contentState object is required.');

    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
        aps: {
            timestamp: nowSec,
            event: 'update',
            'stale-date': nowSec + 15 * 60,
            'content-state': contentState,
        },
    });

    const result = await apns.send({ token, environment, body, priority: 10 });
    res.status(result.outcome === 'ok' ? 200 : 502).json(result);
};

/** GET /api/live-activity/metrics — counters for this process. */
exports.getMetrics = (req, res) => {
    res.json(metrics.snapshot({
        live_activity_tokens_active: store.listActive().length,
        live_activity_tokens_total: store.countAll(),
        apns_configured: apns.isConfigured(),
    }));
};
