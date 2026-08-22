'use strict';

/**
 * armedJourneyController.js — the client-facing surface for server-driven
 * journey tracking: registering the per-install tokens, arming/disarming a leg,
 * and reporting that the arrival geofence fired.
 *
 * Like register/unregister for the Live Activity update token, none of this
 * touches APNs. A device must always be able to arm, disarm, and report arrival
 * even when Apple is unreachable or our credentials are wrong — the push side
 * discovers those problems on its own.
 */

const store = require('../services/liveactivity/armedStore');
const { isValidToken } = require('./liveActivityController');

const ENVIRONMENTS = new Set(['sandbox', 'production']);
const IOS_KINDS    = new Set(['push_to_start', 'alert']);
const PLATFORMS    = new Set(['ios', 'android']);
const INSTALL_RE   = /^[A-Za-z0-9._:-]{8,128}$/;

// FCM registration tokens are NOT hex — they look like "<id>:APA91b<...>", with
// colons, dashes and underscores, and they are long. Reusing the APNs hex check
// here would reject every Android registration, the same way the old exact-64
// rule rejected every real ActivityKit token. Validate the shape loosely and
// let FCM be the authority on whether a token actually works.
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.\-]{64,4096}$/;
const isValidFcmToken = (t) => typeof t === 'string' && FCM_TOKEN_RE.test(t);

const bad = (res, message) => res.status(400).json({ error: message });
const maskToken = (t) => (typeof t === 'string' && t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : '(invalid)');

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/live-activity/register-device
 *
 * iOS:      { installId, token, kind: 'push_to_start'|'alert', environment, platform?: 'ios' }
 * Android:  { installId, token, platform: 'android' }        // kind and environment implied
 *
 * Called once per app launch. Tokens rotate, so the store keeps only the newest
 * token per (install, kind).
 *
 * `platform` is optional and defaults to 'ios', so every already-shipped iOS
 * build keeps registering exactly as it does today without an app update.
 */
exports.registerDevice = (req, res) => {
    try {
        const b = req.body || {};
        if (!b.installId || !INSTALL_RE.test(String(b.installId))) {
            return bad(res, 'installId must be 8–128 chars of [A-Za-z0-9._:-].');
        }

        const platform = b.platform === undefined ? 'ios' : String(b.platform);
        if (!PLATFORMS.has(platform)) {
            return bad(res, "platform must be either 'ios' or 'android'.");
        }

        if (platform === 'android') {
            // One FCM token per install receives both the start message and the
            // delay alert — FCM has no equivalent of Apple's separate,
            // budget-limited push-to-start token.
            if (!isValidFcmToken(b.token)) {
                return bad(res, 'token must be an FCM registration token (64–4096 chars of [A-Za-z0-9_:.-]).');
            }
            // 'environment' is an APNs concept (which of Apple's two hosts a
            // token belongs to). FCM has no such split, so it is ignored here
            // rather than demanded of the Android client.
            store.registerDevice({
                installId: String(b.installId),
                token: b.token,
                kind: 'fcm',
                environment: 'n/a',
                platform: 'android',
            });

            console.log(`[armed] device registered install=${b.installId} platform=android kind=fcm token=${maskToken(b.token)}`);
            return res.json({ ok: true, platform: 'android', kind: 'fcm', token: maskToken(b.token) });
        }

        // ── iOS, unchanged ───────────────────────────────────────────────────
        if (!isValidToken(b.token)) {
            return bad(res, 'token must be an even-length hex string (32–512 chars).');
        }
        if (!IOS_KINDS.has(b.kind)) {
            return bad(res, "kind must be either 'push_to_start' or 'alert'.");
        }
        if (!ENVIRONMENTS.has(b.environment)) {
            return bad(res, "environment must be either 'sandbox' or 'production'.");
        }

        store.registerDevice({
            installId: String(b.installId),
            token: b.token,
            kind: b.kind,
            environment: b.environment,
            platform: 'ios',
        });

        console.log(`[armed] device registered install=${b.installId} platform=ios kind=${b.kind} token=${maskToken(b.token)}`);
        res.json({ ok: true, platform: 'ios', kind: b.kind, token: maskToken(b.token) });
    } catch (err) {
        console.error('[armed] register-device failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/live-activity/arm
 * Marks one leg for automatic tracking: the server will start the Live Activity
 * on its own, alert on delay, and stop silently if the journey is never taken.
 */
exports.arm = (req, res) => {
    try {
        const b = req.body || {};
        if (!b.installId || !INSTALL_RE.test(String(b.installId))) {
            return bad(res, 'installId must be 8–128 chars of [A-Za-z0-9._:-].');
        }
        if (!b.journeyId || String(b.journeyId).length > 128) {
            return bad(res, 'journeyId is required (max 128 chars).');
        }

        const trainNumber = String(b.trainNumber ?? '').trim();
        const boarding    = String(b.boardingStation ?? '').trim();
        const destination = String(b.destinationStation ?? '').trim();
        if (!trainNumber) return bad(res, 'trainNumber is required.');
        if (!boarding)    return bad(res, 'boardingStation is required.');
        if (!destination) return bad(res, 'destinationStation is required.');

        const departure = parseDate(b.scheduledDeparture);
        const arrival   = parseDate(b.scheduledArrival);
        if (!departure) return bad(res, 'scheduledDeparture must be a valid date.');
        if (!arrival)   return bad(res, 'scheduledArrival must be a valid date.');
        if (arrival <= departure) return bad(res, 'scheduledArrival must be after scheduledDeparture.');

        const legIndex = Number.isInteger(b.legIndex) ? b.legIndex : 0;
        if (legIndex < 0) return bad(res, 'legIndex must be zero or greater.');

        // Arming needs a push-to-start token to be of any use; say so plainly
        // rather than silently accepting a journey we can never start.
        const startToken = store.getToken(String(b.installId), 'push_to_start');

        store.arm({
            install_id: String(b.installId),
            journey_id: String(b.journeyId),
            leg_index: legIndex,
            train_number: trainNumber,
            // The bare number matches the feed; the display form ("БВ 3637") is
            // what the passenger reads on the card.
            train_number_display: b.trainNumberDisplay ? String(b.trainNumberDisplay).trim() : null,
            boarding_station: boarding,
            destination_station: destination,
            direction_station: b.directionStation ? String(b.directionStation).trim() : null,
            scheduled_departure: departure.toISOString(),
            scheduled_arrival: arrival.toISOString(),
            is_current_bus: b.isCurrentTransportBus ? 1 : 0,
            next_transport_number: b.nextTransportNumber ? String(b.nextTransportNumber) : null,
            next_transport_departure: parseDate(b.nextTransportDeparture)?.toISOString() ?? null,
            is_next_transport_bus: b.isNextTransportBus ? 1 : 0,
            now: store.nowIso(),
        });

        console.log(`[armed] armed journey=${b.journeyId} leg=${legIndex} train=${trainNumber} ` +
                    `dep=${departure.toISOString()} startToken=${startToken ? 'yes' : 'MISSING'}`);

        res.json({
            ok: true,
            journeyId: String(b.journeyId),
            legIndex,
            canAutoStart: !!startToken,
        });
    } catch (err) {
        console.error('[armed] arm failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/live-activity/disarm
 * Idempotent: the app may call it twice, or for a leg we already stopped.
 */
exports.disarm = (req, res) => {
    try {
        const b = req.body || {};
        if (!b.installId || !b.journeyId) return bad(res, 'installId and journeyId are required.');
        const legIndex = Number.isInteger(b.legIndex) ? b.legIndex : null;
        const stopped = store.disarm(String(b.installId), String(b.journeyId), legIndex);
        console.log(`[armed] disarm journey=${b.journeyId} leg=${legIndex ?? 'all'} stopped=${stopped}`);
        res.json({ ok: true, stopped });
    } catch (err) {
        console.error('[armed] disarm failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/live-activity/leg-arrived
 * The client's arrival geofence fired — the journey really happened. Without
 * this the watcher eventually stops the leg on its deadline, silently.
 */
exports.legArrived = (req, res) => {
    try {
        const b = req.body || {};
        if (!b.installId || !b.journeyId) return bad(res, 'installId and journeyId are required.');
        const legIndex = Number.isInteger(b.legIndex) ? b.legIndex : 0;
        const changed = store.markArrived(String(b.installId), String(b.journeyId), legIndex);
        console.log(`[armed] leg-arrived journey=${b.journeyId} leg=${legIndex} matched=${changed}`);
        res.json({ ok: true, matched: changed });
    } catch (err) {
        console.error('[armed] leg-arrived failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};
