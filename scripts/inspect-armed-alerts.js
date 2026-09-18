'use strict';

/**
 * scripts/inspect-armed-alerts.js — read-only. For one installId (or
 * journeyId), dumps everything that decides whether a delay alert can fire:
 * the armed_journeys row(s) (state, alerts_sent, last_alert_at,
 * last_delay_min, created_at) and the device_tokens row(s) (kind, platform,
 * how recently registered).
 *
 * Written for the Android "delay_alert never arrives" report: evaluateDelayAlert
 * in armedLogic.js can refuse to alert for several silent reasons (no realtime
 * coverage, below the 5-min threshold, the 10-min cooldown, the 5-alert cap,
 * or the new post-arm grace period) — none of which were logged before
 * maybeAlert's skip-path logging was added alongside this script. This gives
 * the CURRENT state directly from the database without needing that log line
 * to have already fired at the right moment.
 *
 * Usage:  node scripts/inspect-armed-alerts.js <installId|journeyId> [db.sqlite]
 */

const path     = require('path');
const Database = require('better-sqlite3');

const key = process.argv[2];
const dbPath = process.argv[3] || path.join(__dirname, '..', 'bultrain.sqlite');

if (!key) {
    console.error('Usage: node scripts/inspect-armed-alerts.js <installId|journeyId> [db.sqlite]');
    process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

console.log(`── armed_journeys matching install_id or journey_id = "${key}" ──`);
const armed = db.prepare(`
    SELECT id, install_id, journey_id, leg_index, train_number, app_language, state,
           scheduled_departure, scheduled_arrival, started_at,
           last_delay_min, last_alert_at, alerts_sent, next_action_at, created_at, updated_at
    FROM armed_journeys WHERE install_id = ? OR journey_id = ?
    ORDER BY id DESC LIMIT 20
`).all(key, key);

if (!armed.length) {
    console.log('(none — either already pruned after finishing, or this key does not match anything)');
} else {
    for (const r of armed) {
        console.log(
            `#${r.id} install=${r.install_id} journey=${r.journey_id} leg=${r.leg_index} train=${r.train_number} ` +
            `lang=${r.app_language || '—'} state=${r.state}\n` +
            `    sched dep=${r.scheduled_departure} arr=${r.scheduled_arrival} started=${r.started_at || '—'}\n` +
            `    last_delay_min=${r.last_delay_min ?? '—'} alerts_sent=${r.alerts_sent} last_alert_at=${r.last_alert_at || 'never'}\n` +
            `    created_at=${r.created_at} updated_at=${r.updated_at}`
        );
    }
}

console.log(`\n── device_tokens for install_id = "${key}" ──`);
const tokens = db.prepare(`
    SELECT token, kind, environment, platform, created_at, updated_at
    FROM device_tokens WHERE install_id = ? ORDER BY updated_at DESC
`).all(key);

if (!tokens.length) {
    console.log('(none registered under this install_id)');
} else {
    for (const t of tokens) {
        const masked = t.token.length > 12 ? `${t.token.slice(0, 8)}…${t.token.slice(-4)}` : '(short)';
        console.log(`kind=${t.kind} platform=${t.platform} env=${t.environment} token=${masked} ` +
            `registered=${t.created_at} lastUpdated=${t.updated_at}`);
    }
}

db.close();
