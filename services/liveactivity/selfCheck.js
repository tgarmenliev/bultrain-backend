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
 *
 * A second, independent thing rides the same tick: a heartbeat report every
 * REPORT_MS (~weekly) regardless of whether anything broke — so a server that
 * has gone completely silent (not just "broken but still ticking") is itself
 * noticeable, as the absence of an expected email rather than nothing at all.
 */

const fs      = require('fs');
const path    = require('path');
const metrics = require('./metrics');
const email   = require('../alerts/email');

const CHECK_MS   = 15 * 60 * 1000;      // how often to look
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-notify at most this often while still bad
const REPORT_MS  = 7 * 24 * 60 * 60 * 1000; // heartbeat report cadence

// Same reason repeating this many times inside one window reads as systemic
// (e.g. BadDeviceToken from a misconfigured environment), not one-off noise.
const REPEATED_ERROR_THRESHOLD = 3;

// Overridable for tests. Deploys restart the process often, which would reset
// an in-memory "last sent" clock long before 7 days pass — persisted to disk
// so the cadence survives a `pm2 restart`, not just a quiet process.
const STATE_FILE = process.env.SELF_CHECK_STATE_FILE
    || path.join(__dirname, '..', '..', 'data', 'self-check-state.json');

let prevSnapshot = null;
let timer = null;

// The counters this process has seen since the last heartbeat report (or
// since it started, if no report has fired yet this run). Reset whenever a
// report actually sends — NOT persisted, so after a restart it naturally
// starts over from that moment; the report reads "since the last report or
// the last restart, whichever is more recent" rather than claiming an exact
// 7-day figure it cannot reconstruct from in-memory-only counters.
let reportBaseline = null;

// key -> { bad: boolean, lastNotifiedAt: number|null }
const ruleState = new Map();

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (err) {
        console.error('[selfcheck] failed to persist state:', err.message);
    }
}

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
    const res = await email.send({
        subject,
        text,
        kind: kind === 'bad' ? 'alert' : 'ok',
        title: kind === 'bad' ? f.subject : `${f.subject} — оправи се`,
        lines: [text],
    });
    console.log(`[selfcheck] ${kind === 'bad' ? 'ALERT' : 'recovered'} ${f.key} -> email ${res.sent ? 'sent' : `NOT sent (${res.reason})`}`);
}

const REPORT_ROWS = [
    ['push_to_start_sent', 'Push-to-start изпратени'],
    ['push_to_start_failed', 'Push-to-start неуспешни'],
    ['push_to_start_refused', 'Push-to-start отказани (наш бюджет)'],
    ['delay_alerts_sent', 'Известия за закъснение'],
    ['armed_auto_stopped', 'Тихо спрени пътувания'],
    ['live_activity_pushes_sent', 'Live Activity обновявания'],
];

/**
 * The heartbeat: fires roughly every REPORT_MS regardless of whether
 * anything broke, so silence itself is never mistaken for "all good" — a
 * server that stopped ticking entirely also stops sending these.
 */
async function maybeSendReport(curr) {
    const state = readState();
    const lastAt = state.lastReportAt ? new Date(state.lastReportAt).getTime() : 0;
    if (Date.now() - lastAt < REPORT_MS) return;

    const delta = diffCounters(reportBaseline, curr);
    const reasonDelta = diffReasons(reportBaseline, curr);
    const sinceLabel = reportBaseline ? 'от последния отчет' : 'от последния рестарт на сървъра';

    const tableRows = REPORT_ROWS.map(([k, label]) => [label, delta[k] || 0]);
    const reasonLines = Object.entries(reasonDelta).filter(([, c]) => c > 0).map(([r, c]) => `${r}: ${c}`);
    const hadFailures = (delta.push_to_start_failed || 0) > 0 || reasonLines.length > 0;

    const lines = [`Обхваща периода ${sinceLabel}.`];
    lines.push(hadFailures ? 'Има грешки през периода — виж таблицата и APNs причините по-долу.' : 'Всичко изглежда наред.');
    if (reasonLines.length) lines.push(`APNs грешки: ${reasonLines.join(', ')}.`);

    const res = await email.send({
        subject: `[BulTrain] седмичен отчет${hadFailures ? ' — има грешки' : ''}`,
        kind: hadFailures ? 'report_warn' : 'report',
        title: 'Седмичен отчет',
        lines,
        tableRows,
    });
    console.log(`[selfcheck] weekly report -> email ${res.sent ? 'sent' : `NOT sent (${res.reason})`}`);

    reportBaseline = curr;
    writeState({ ...state, lastReportAt: new Date().toISOString() });
}

async function run() {
    try {
        const curr = metrics.snapshot();
        if (!prevSnapshot) {
            prevSnapshot = curr;
            if (reportBaseline == null) reportBaseline = curr;
            return; // first tick: nothing to diff yet
        }

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
        await maybeSendReport(curr);
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
    reportBaseline = null;
    ruleState.clear();
}

module.exports = {
    start, stop, run, evaluate, diffCounters, diffReasons, maybeSendReport,
    CHECK_MS, COOLDOWN_MS, REPORT_MS,
};
