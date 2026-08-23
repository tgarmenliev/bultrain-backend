'use strict';

/**
 * selfCheck.js — notices when the Live Activity pipeline breaks quietly.
 *
 * The concrete incident this exists for: a device stuck sending 'sandbox' to
 * APNs for two days, push_to_start_failed climbing while push_to_start_sent
 * sat at zero, discovered only because a real journey happened to be running.
 * metrics.js already counts everything needed — nobody was watching it.
 *
 * Runs every CHECK_MS off metrics.snapshot() (in-memory counters, monotonic
 * since the last restart), diffs against the previous snapshot, and evaluates
 * a couple of concrete rules. Alerting is transition-based (email once when a
 * rule goes bad, once when it recovers) with a cooldown while it stays bad, so
 * a persistent problem doesn't fall silent but also doesn't spam every tick.
 */

const metrics = require('./metrics');
const email   = require('../alerts/email');

const CHECK_MS   = 15 * 60 * 1000;      // how often to look
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-notify at most this often while still bad

// Same reason repeating this many times inside one window reads as systemic
// (e.g. BadDeviceToken from a misconfigured environment), not one-off noise.
const REPEATED_ERROR_THRESHOLD = 3;

let prevSnapshot = null;
let timer = null;

// key -> { bad: boolean, lastNotifiedAt: number|null }
const ruleState = new Map();

function diffCounters(prev, curr) {
    const delta = {};
    for (const k of Object.keys(curr)) {
        if (k === 'apns_errors_by_reason' || k === 'apns_latency_p95_ms') continue;
        delta[k] = (curr[k] || 0) - (prev ? (prev[k] || 0) : 0);
    }
    return delta;
}

function diffReasons(prev, curr) {
    const prevReasons = (prev && prev.apns_errors_by_reason) || {};
    const currReasons = curr.apns_errors_by_reason || {};
    const delta = {};
    for (const k of Object.keys(currReasons)) {
        delta[k] = currReasons[k] - (prevReasons[k] || 0);
    }
    return delta;
}

const windowMin = CHECK_MS / 60000;

/**
 * Pure: given one window's counter delta and APNs-reason delta, return every
 * rule's current verdict. Kept separate from the timer/email side so it is
 * directly testable without mocking anything.
 */
function evaluate(delta, reasonDelta) {
    const findings = [];

    const startBroken = (delta.push_to_start_failed || 0) > 0 && (delta.push_to_start_sent || 0) === 0;
    findings.push({
        key: 'push_to_start_broken',
        bad: startBroken,
        subject: 'push-to-start изглежда счупен',
        body: `Последните ${windowMin} мин: ${delta.push_to_start_failed || 0} неуспешни push-to-start, 0 успешни.`,
    });

    for (const [reason, count] of Object.entries(reasonDelta)) {
        if (count >= REPEATED_ERROR_THRESHOLD) {
            findings.push({
                key: `apns_reason:${reason}`,
                bad: true,
                subject: `повтаряща се APNs грешка: ${reason}`,
                body: `"${reason}" се появи ${count} пъти през последните ${windowMin} мин — прилича на траен, а не еднократен проблем.`,
            });
        }
    }

    return findings;
}

async function notify(kind, f) {
    const prefix = kind === 'bad' ? '[BulTrain] ALERT' : '[BulTrain] OK';
    const subject = kind === 'bad' ? `${prefix}: ${f.subject}` : `${prefix}: ${f.subject} — оправи се`;
    const text = kind === 'bad' ? f.body : 'Вече не се наблюдава в последния прозорец.';
    const res = await email.send({ subject, text });
    console.log(`[selfcheck] ${kind === 'bad' ? 'ALERT' : 'recovered'} ${f.key} -> email ${res.sent ? 'sent' : `NOT sent (${res.reason})`}`);
}

async function run() {
    try {
        const curr = metrics.snapshot();
        if (!prevSnapshot) { prevSnapshot = curr; return; } // first tick: nothing to diff yet

        const delta = diffCounters(prevSnapshot, curr);
        const reasonDelta = diffReasons(prevSnapshot, curr);
        const findings = evaluate(delta, reasonDelta);
        const findingByKey = new Map(findings.map(f => [f.key, f]));

        // Union of this window's findings and any key still marked bad from
        // before — the latter catches a reason-spike that doesn't repeat and
        // needs a "recovered" email even though evaluate() no longer names it.
        const keys = new Set([
            ...findings.map(f => f.key),
            ...[...ruleState.entries()].filter(([, s]) => s.bad).map(([k]) => k),
        ]);

        const now = Date.now();
        for (const key of keys) {
            const f = findingByKey.get(key);
            const state = ruleState.get(key) || { bad: false, lastNotifiedAt: null };

            if (f && f.bad) {
                const justWentBad = !state.bad;
                const cooldownElapsed = state.lastNotifiedAt != null && (now - state.lastNotifiedAt) > COOLDOWN_MS;
                if (justWentBad || cooldownElapsed) {
                    await notify('bad', f);
                    state.lastNotifiedAt = now;
                }
                state.bad = true;
            } else if (state.bad) {
                await notify('ok', findingByKey.get(key) || { key, subject: key.replace(/^apns_reason:/, '') });
                state.bad = false;
                state.lastNotifiedAt = null;
            }
            ruleState.set(key, state);
        }

        prevSnapshot = curr;
    } catch (err) {
        console.error('[selfcheck] run failed:', err.message);
    }
}

function start() {
    if (timer) return;
    if (!email.isConfigured()) {
        console.warn('[selfcheck] started but ALERT_EMAIL_* is not set — checks will run, nothing will be emailed');
    }
    timer = setInterval(run, CHECK_MS);
    if (timer.unref) timer.unref();
    console.log(`[selfcheck] self-monitoring started (every ${windowMin} min)`);
}

function stop() {
    clearInterval(timer);
    timer = null;
    prevSnapshot = null;
    ruleState.clear();
}

module.exports = { start, stop, run, evaluate, diffCounters, diffReasons, CHECK_MS, COOLDOWN_MS };
