'use strict';

/**
 * armedStore.js — persistence for server-driven journey tracking: device tokens
 * (push-to-start + plain alert), armed journeys, and the push-to-start budget
 * guard. The only module that touches those three tables.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

// Our own push-to-start ceiling, deliberately stricter than Apple's (~10 in an
// unpublished window). Hitting ours costs one missing card; hitting theirs makes
// the device ignore starts for up to 24h, invisibly.
const MAX_STARTS_PER_HOUR = 3;
const MAX_STARTS_PER_DAY  = 8;

// iOS registers two distinct tokens: Apple's push-to-start token is a different
// object from the ordinary alert token. FCM has no such split — one Android
// token receives both the start message and the delay alert — so Android
// registers a single 'fcm' row.
const KINDS = new Set(['push_to_start', 'alert', 'fcm']);
const PLATFORMS = new Set(['ios', 'android']);

let db = null;
function conn() {
    if (!db) {
        db = new Database(DB_PATH, { fileMustExist: true });
        db.pragma('foreign_keys = ON');
    }
    return db;
}

const nowIso = () => new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

/** Normalise any parseable date to ISO-8601 UTC, or null. */
function toUtcIso(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Device tokens ────────────────────────────────────────────────────────────

/**
 * Record a token for an install. Upsert on the token, and drop any older token
 * of the same kind for the same install — a rotated token replaces its
 * predecessor rather than accumulating dead rows we would push to forever.
 */
function registerDevice({ installId, token, kind, environment, platform = 'ios' }) {
    const c = conn();
    const tx = c.transaction(() => {
        c.prepare(
            'DELETE FROM device_tokens WHERE install_id = ? AND kind = ? AND token != ?'
        ).run(installId, kind, token);
        c.prepare(`
            INSERT INTO device_tokens (token, install_id, kind, environment, platform, created_at, updated_at)
            VALUES (@token, @installId, @kind, @environment, @platform, @now, @now)
            ON CONFLICT(token) DO UPDATE SET
                install_id = excluded.install_id,
                kind       = excluded.kind,
                environment= excluded.environment,
                platform   = excluded.platform,
                updated_at = excluded.updated_at
        `).run({ token, installId, kind, environment, platform, now: nowIso() });
    });
    tx();
}

/**
 * The token to push to for a given purpose.
 *
 * iOS keeps a separate row per kind, so the exact match is what it needs and
 * what it has always got. Android registers ONE token that serves both purposes
 * (FCM has no push-to-start/alert distinction), so when there is no exact-kind
 * row we fall back to that install's Android token.
 *
 * The fallback cannot disturb iOS: it only fires when the exact kind is absent,
 * and it only matches rows whose platform is 'android'. An iOS install that has
 * registered only one of its two kinds still correctly gets null for the other.
 */
function getToken(installId, kind) {
    const exact = conn().prepare(
        'SELECT token, environment, platform, kind FROM device_tokens WHERE install_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(installId, kind);
    if (exact) return exact;

    return conn().prepare(
        "SELECT token, environment, platform, kind FROM device_tokens WHERE install_id = ? AND platform = 'android' ORDER BY updated_at DESC LIMIT 1"
    ).get(installId) || null;
}

// ── Armed journeys ───────────────────────────────────────────────────────────

/**
 * Arm a leg (or re-arm it with fresh context). Resets tracking bookkeeping.
 *
 * Optional columns are defaulted here rather than demanded of every caller:
 * better-sqlite3 throws on a missing named parameter, so adding a nullable
 * column would otherwise break each existing call site at once.
 */
function arm(row) {
    const params = {
        train_number_display: null,
        direction_station: null,
        next_transport_number: null,
        next_transport_departure: null,
        is_next_transport_bus: 0,
        is_current_bus: 0,
        leg_index: 0,
        now: nowIso(),
        ...row,
    };
    conn().prepare(`
        INSERT INTO armed_journeys (
            install_id, journey_id, leg_index, train_number, train_number_display,
            boarding_station, destination_station, direction_station,
            scheduled_departure, scheduled_arrival, is_current_bus,
            next_transport_number, next_transport_departure, is_next_transport_bus,
            state, next_action_at, created_at, updated_at
        ) VALUES (
            @install_id, @journey_id, @leg_index, @train_number, @train_number_display,
            @boarding_station, @destination_station, @direction_station,
            @scheduled_departure, @scheduled_arrival, @is_current_bus,
            @next_transport_number, @next_transport_departure, @is_next_transport_bus,
            'armed', @now, @now, @now
        )
        ON CONFLICT(install_id, journey_id, leg_index) DO UPDATE SET
            train_number             = excluded.train_number,
            train_number_display     = excluded.train_number_display,
            boarding_station         = excluded.boarding_station,
            destination_station      = excluded.destination_station,
            direction_station        = excluded.direction_station,
            scheduled_departure      = excluded.scheduled_departure,
            scheduled_arrival        = excluded.scheduled_arrival,
            is_current_bus           = excluded.is_current_bus,
            next_transport_number    = excluded.next_transport_number,
            next_transport_departure = excluded.next_transport_departure,
            is_next_transport_bus    = excluded.is_next_transport_bus,
            state          = 'armed',
            started_at     = NULL,
            arrived_at     = NULL,
            stopped_at     = NULL,
            stopped_reason = NULL,
            last_delay_min = NULL,
            last_alert_at  = NULL,
            alerts_sent    = 0,
            next_action_at = excluded.next_action_at,
            updated_at     = excluded.updated_at
    `).run(params);
}

/** Rows the watcher still has work for. */
function listActive() {
    return conn().prepare(
        "SELECT * FROM armed_journeys WHERE state IN ('armed','started') ORDER BY train_number"
    ).all();
}

function getById(id) {
    return conn().prepare('SELECT * FROM armed_journeys WHERE id = ?').get(id) || null;
}

/** Idempotent — disarming an unknown journey is not an error. */
function disarm(installId, journeyId, legIndex) {
    const stmt = legIndex == null
        ? conn().prepare("UPDATE armed_journeys SET state='stopped', stopped_at=?, stopped_reason='disarmed', updated_at=? WHERE install_id=? AND journey_id=? AND state IN ('armed','started')")
        : conn().prepare("UPDATE armed_journeys SET state='stopped', stopped_at=?, stopped_reason='disarmed', updated_at=? WHERE install_id=? AND journey_id=? AND leg_index=? AND state IN ('armed','started')");
    const args = legIndex == null
        ? [nowIso(), nowIso(), installId, journeyId]
        : [nowIso(), nowIso(), installId, journeyId, legIndex];
    return stmt.run(...args).changes;
}

/** The client's arrival geofence fired — the journey was really taken. */
function markArrived(installId, journeyId, legIndex) {
    return conn().prepare(`
        UPDATE armed_journeys SET state='arrived', arrived_at=?, updated_at=?
        WHERE install_id=? AND journey_id=? AND leg_index=? AND state IN ('armed','started')
    `).run(nowIso(), nowIso(), installId, journeyId, legIndex).changes;
}

function markStarted(id) {
    conn().prepare("UPDATE armed_journeys SET state='started', started_at=?, updated_at=? WHERE id=?")
        .run(nowIso(), nowIso(), id);
}

/**
 * The app started the card ITSELF (the alarm firing, or any manual start), so
 * this leg must never also get a push-to-start — that produced a second, orphan
 * Activity the app's manager does not track, which then froze until it expired.
 *
 * Matched on journey + leg because that is what the Live Activity registration
 * carries; install_id is not in that payload. Only 'armed' rows are touched, so
 * it is idempotent and cannot disturb a leg already running.
 *
 * @returns {number} rows claimed
 */
function markStartedByJourney(journeyId, legIndex) {
    if (!journeyId) return 0;
    return conn().prepare(`
        UPDATE armed_journeys SET state='started', started_at=?, updated_at=?
        WHERE journey_id=? AND leg_index=? AND state='armed'
    `).run(nowIso(), nowIso(), String(journeyId), legIndex ?? 0).changes;
}

function markStopped(id, reason) {
    conn().prepare("UPDATE armed_journeys SET state='stopped', stopped_at=?, stopped_reason=?, updated_at=? WHERE id=?")
        .run(nowIso(), reason, nowIso(), id);
}

/** Record that we told the user about a delay, so we only alert on change. */
function recordAlert(id, delayMin) {
    conn().prepare(
        'UPDATE armed_journeys SET last_delay_min=?, last_alert_at=?, alerts_sent=alerts_sent+1, updated_at=? WHERE id=?'
    ).run(delayMin ?? null, nowIso(), nowIso(), id);
}

/** Remember the delay we observed without alerting (below the alert bar). */
function recordDelaySeen(id, delayMin) {
    conn().prepare('UPDATE armed_journeys SET last_delay_min=?, updated_at=? WHERE id=?')
        .run(delayMin ?? null, nowIso(), id);
}

// ── Push-to-start budget guard ───────────────────────────────────────────────

/**
 * @returns {{allowed:boolean, reason?:string, lastHour:number, lastDay:number}}
 */
function checkStartBudget(installId) {
    const c = conn();
    const lastHour = c.prepare(
        "SELECT COUNT(*) AS n FROM push_start_log WHERE install_id=? AND outcome='ok' AND sent_at > ?"
    ).get(installId, isoAgo(60 * 60 * 1000)).n;
    const lastDay = c.prepare(
        "SELECT COUNT(*) AS n FROM push_start_log WHERE install_id=? AND outcome='ok' AND sent_at > ?"
    ).get(installId, isoAgo(24 * 60 * 60 * 1000)).n;

    if (lastHour >= MAX_STARTS_PER_HOUR) {
        return { allowed: false, reason: `hourly cap ${MAX_STARTS_PER_HOUR}`, lastHour, lastDay };
    }
    if (lastDay >= MAX_STARTS_PER_DAY) {
        return { allowed: false, reason: `daily cap ${MAX_STARTS_PER_DAY}`, lastHour, lastDay };
    }
    return { allowed: true, lastHour, lastDay };
}

function logStart(installId, journeyId, outcome) {
    conn().prepare(
        'INSERT INTO push_start_log (install_id, sent_at, journey_id, outcome) VALUES (?,?,?,?)'
    ).run(installId, nowIso(), journeyId ?? null, outcome);
}

/** Hourly cleanup: budget log older than 48h, and long-finished journeys. */
function prune() {
    const c = conn();
    const logs = c.prepare('DELETE FROM push_start_log WHERE sent_at < ?')
        .run(isoAgo(48 * 60 * 60 * 1000)).changes;
    const rows = c.prepare(
        "DELETE FROM armed_journeys WHERE state IN ('arrived','stopped') AND updated_at < ?"
    ).run(isoAgo(7 * 24 * 60 * 60 * 1000)).changes;
    return { logs, rows };
}

function counts() {
    const c = conn();
    return {
        armed:   c.prepare("SELECT COUNT(*) AS n FROM armed_journeys WHERE state='armed'").get().n,
        started: c.prepare("SELECT COUNT(*) AS n FROM armed_journeys WHERE state='started'").get().n,
        devices: c.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM device_tokens').get().n,
        devices_ios: c.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM device_tokens WHERE platform = 'ios'").get().n,
        devices_android: c.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM device_tokens WHERE platform = 'android'").get().n,
    };
}

module.exports = {
    registerDevice, getToken, arm, disarm, markArrived, listActive, getById,
    markStarted, markStartedByJourney, markStopped, recordAlert, recordDelaySeen,
    checkStartBudget, logStart, prune, counts, toUtcIso, nowIso,
    KINDS, PLATFORMS, MAX_STARTS_PER_HOUR, MAX_STARTS_PER_DAY,
};
