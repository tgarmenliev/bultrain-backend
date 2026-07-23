'use strict';

/**
 * store.js — persistence for Live Activity push tokens.
 *
 * Deliberately the only module that touches the table, so the API layer and the
 * worker share one definition of "active token" and one upsert. Opens a
 * writable connection (the API registers/unregisters, the worker records push
 * bookkeeping); everything else in the process stays readonly.
 */

const path     = require('path');
const Database = require('better-sqlite3');

// BULTRAIN_DB lets the tests (and scripts/gtfs-refresh.sh) point at another
// database without touching the live one.
const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

// A token is worth pushing to until well after the journey should have ended.
const ACTIVE_GRACE_MS = 2 * 60 * 60 * 1000; // 2h past scheduled arrival

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

/**
 * Insert or replace the row for a token. The same activity re-registers when
 * iOS rotates its token and when the journey moves to the next leg, so the
 * newest registration always wins. Push bookkeeping is reset, because the
 * context it described no longer applies.
 */
function upsert(row) {
    conn().prepare(`
        INSERT INTO live_activity_tokens (
            token, environment, journey_id, train_number,
            boarding_station, destination_station, direction_station,
            scheduled_departure, scheduled_arrival,
            current_leg_index, is_current_bus,
            next_transport_number, next_transport_departure, is_next_transport_bus
        ) VALUES (
            @token, @environment, @journey_id, @train_number,
            @boarding_station, @destination_station, @direction_station,
            @scheduled_departure, @scheduled_arrival,
            @current_leg_index, @is_current_bus,
            @next_transport_number, @next_transport_departure, @is_next_transport_bus
        )
        ON CONFLICT(token) DO UPDATE SET
            environment              = excluded.environment,
            journey_id               = excluded.journey_id,
            train_number             = excluded.train_number,
            boarding_station         = excluded.boarding_station,
            destination_station      = excluded.destination_station,
            direction_station        = excluded.direction_station,
            scheduled_departure      = excluded.scheduled_departure,
            scheduled_arrival        = excluded.scheduled_arrival,
            current_leg_index        = excluded.current_leg_index,
            is_current_bus           = excluded.is_current_bus,
            next_transport_number    = excluded.next_transport_number,
            next_transport_departure = excluded.next_transport_departure,
            is_next_transport_bus    = excluded.is_next_transport_bus,
            last_pushed_at    = NULL,
            last_delay_min    = NULL,
            last_next_stop    = NULL,
            last_content_hash = NULL,
            last_phase        = NULL
    `).run(row);
}

/** How many tokens are already registered for this journey (flood cap). */
function countForJourney(journeyId, excludeToken) {
    if (!journeyId) return 0;
    return conn().prepare(
        'SELECT COUNT(*) AS c FROM live_activity_tokens WHERE journey_id = ? AND token != ?'
    ).get(journeyId, excludeToken || '').c;
}

function getByToken(token) {
    return conn().prepare('SELECT * FROM live_activity_tokens WHERE token = ?').get(token) || null;
}

/** Tokens still worth pushing to. */
function listActive() {
    return conn().prepare(
        'SELECT * FROM live_activity_tokens WHERE scheduled_arrival > ? ORDER BY train_number'
    ).all(isoAgo(ACTIVE_GRACE_MS));
}

/** Idempotent — removing an unknown token is not an error. */
function remove(token) {
    return conn().prepare('DELETE FROM live_activity_tokens WHERE token = ?').run(token).changes;
}

/** Record what we last pushed, so the next tick can diff against it. */
function markPushed(token, { delayMin, nextStop, contentHash, phase }) {
    conn().prepare(`
        UPDATE live_activity_tokens
        SET last_pushed_at = ?, last_delay_min = ?, last_next_stop = ?,
            last_content_hash = ?, last_phase = ?
        WHERE token = ?
    `).run(nowIso(), delayMin ?? null, nextStop ?? null, contentHash ?? null, phase ?? null, token);
}

/** Hourly cleanup: journeys that ended long ago. Returns rows removed. */
function pruneExpired() {
    return conn().prepare(
        'DELETE FROM live_activity_tokens WHERE scheduled_arrival < ?'
    ).run(isoAgo(ACTIVE_GRACE_MS)).changes;
}

function countAll() {
    return conn().prepare('SELECT COUNT(*) AS c FROM live_activity_tokens').get().c;
}

module.exports = {
    upsert, countForJourney, getByToken, listActive, remove, markPushed,
    pruneExpired, countAll, toUtcIso, nowIso, ACTIVE_GRACE_MS,
};
