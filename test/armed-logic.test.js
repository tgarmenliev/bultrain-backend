'use strict';

/**
 * The unattended decisions: when to start the card, when a delay is worth a
 * notification, and when to give up on a journey that was never taken.
 */

const test   = require('node:test');
const assert = require('node:assert');
const logic  = require('../services/liveactivity/armedLogic');

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Departure at T, arrival two hours later.
const T = Date.parse('2026-08-21T11:30:00.000Z');
function row(over = {}) {
    return {
        id: 1, journey_id: 'j1', leg_index: 0, state: 'armed',
        train_number: '2612', boarding_station: 'София', destination_station: 'Пловдив',
        scheduled_departure: iso(T),
        scheduled_arrival:   iso(T + 135 * MIN),
        last_delay_min: null, last_alert_at: null, alerts_sent: 0, started_at: null,
        ...over,
    };
}

// ── Trigger ──────────────────────────────────────────────────────────────────

test('no start while the window has not opened', () => {
    const r = logic.evaluateTrigger(row(), null, new Date(T - 60 * MIN));
    assert.strictEqual(r.shouldStart, false);
    assert.strictEqual(r.reason, 'too-early');
    assert.strictEqual(r.tTriggerMs, T - logic.START_WINDOW_MS);
});

test('starts once the scheduled window opens, when there is no prediction', () => {
    const r = logic.evaluateTrigger(row(), null, new Date(T - 40 * MIN));
    assert.strictEqual(r.shouldStart, true);
    assert.strictEqual(r.source, 'schedule');
});

test('an EARLIER prediction pulls the trigger earlier — the dangerous case', () => {
    // Train predicted to leave 25 minutes early.
    const predicted = (T - 25 * MIN) / 1000;
    const at = new Date(T - 60 * MIN);           // before the scheduled window
    const r = logic.evaluateTrigger(row(), predicted, at);
    assert.strictEqual(r.source, 'predicted');
    assert.strictEqual(r.tTriggerMs, T - 25 * MIN - logic.START_WINDOW_MS);
    assert.strictEqual(r.shouldStart, true, 'the window has already opened against the prediction');
});

test('a LATER prediction (delay) does not postpone the card — earlier of the two wins', () => {
    const predicted = (T + 50 * MIN) / 1000;     // running 50 minutes late
    const r = logic.evaluateTrigger(row(), predicted, new Date(T - 40 * MIN));
    assert.strictEqual(r.source, 'schedule', 'min(schedule, prediction) keeps the schedule');
    assert.strictEqual(r.shouldStart, true);
});

test('an absurd prediction cannot drag the card hours out of place', () => {
    const absurd = (T - 10 * 60 * MIN) / 1000;   // "leaving" 10 hours early
    const r = logic.evaluateTrigger(row(), absurd, new Date(T - 6 * 60 * MIN));
    assert.strictEqual(r.tTriggerMs, T - 2 * 60 * MIN, 'clamped to two hours before schedule');
    assert.strictEqual(r.shouldStart, false, 'still too early — the clamp held');
});

test('a journey ending beyond the activity lifetime is never started', () => {
    const r = logic.evaluateTrigger(
        row({ scheduled_arrival: iso(T + 13 * 60 * MIN) }), null, new Date(T - 40 * MIN));
    assert.strictEqual(r.shouldStart, false);
    assert.strictEqual(r.reason, 'ends-beyond-activity-lifetime');
});

test('an already-started leg is not started again', () => {
    const r = logic.evaluateTrigger(row({ state: 'started' }), null, new Date(T));
    assert.strictEqual(r.shouldStart, false);
    assert.strictEqual(r.reason, 'not-armed');
});

// ── Delay alert ──────────────────────────────────────────────────────────────

test('no coverage means no alert — never a claim without a measurement', () => {
    const r = logic.evaluateDelayAlert(row(), null);
    assert.strictEqual(r.shouldAlert, false);
    assert.strictEqual(r.reason, 'no-coverage');
});

test('a delay appearing above the bar alerts; below it stays quiet', () => {
    assert.strictEqual(logic.evaluateDelayAlert(row(), 12).shouldAlert, true);
    assert.strictEqual(logic.evaluateDelayAlert(row(), 12).kind, 'appeared');
    assert.strictEqual(logic.evaluateDelayAlert(row(), 3).shouldAlert, false);
});

test('only a material change re-alerts', () => {
    const told = row({ last_delay_min: 10, alerts_sent: 1, last_alert_at: iso(Date.now() - 30 * MIN) });
    assert.strictEqual(logic.evaluateDelayAlert(told, 12).shouldAlert, false, '2 min more is noise');
    assert.strictEqual(logic.evaluateDelayAlert(told, 20).shouldAlert, true, '10 min more matters');
    assert.strictEqual(logic.evaluateDelayAlert(told, 20).kind, 'worse');
    assert.strictEqual(logic.evaluateDelayAlert(told, 4).kind, 'recovered', 'made the time up');
});

// Real: alerts that "sometimes come and sometimes don't". A reading below the bar used to be stored as the
// baseline, so the next alert needed the delay to grow 5 minutes PAST it: first reading 2 → silent at 6,
// first reading 4 → silent until 9. Only what the passenger was TOLD is a baseline.
test('a delay above the bar alerts however small the first reading was', () => {
    for (const first of [0, 1, 2, 3, 4]) {
        const seen = row({ last_delay_min: first, alerts_sent: 0 });   // what an older version stored while "seeing"
        const r = logic.evaluateDelayAlert(seen, 5);
        assert.strictEqual(r.shouldAlert, true, `first reading ${first}, now 5`);
        assert.strictEqual(r.kind, 'appeared');
    }
    assert.strictEqual(logic.evaluateDelayAlert(row({ last_delay_min: 2 }), 6).shouldAlert, true, '2 then 6');
    assert.strictEqual(logic.evaluateDelayAlert(row({ last_delay_min: 4 }), 4).shouldAlert, false, 'still below the bar');
});

test('after an alert, the baseline is what was told', () => {
    const told = row({ last_delay_min: 6, alerts_sent: 1, last_alert_at: iso(Date.now() - 30 * MIN) });
    assert.strictEqual(logic.evaluateDelayAlert(told, 9).shouldAlert, false, '+3 is noise');
    assert.strictEqual(logic.evaluateDelayAlert(told, 11).kind, 'worse', '+5 over what they were told');
});

test('alerts are spaced out and capped', () => {
    const justTold = row({ last_delay_min: 10, alerts_sent: 1, last_alert_at: iso(Date.now() - 2 * MIN) });
    assert.strictEqual(logic.evaluateDelayAlert(justTold, 40).shouldAlert, false, 'too soon');

    const spent = row({ last_delay_min: 10, alerts_sent: logic.ALERT_MAX_PER_LEG,
                        last_alert_at: iso(Date.now() - 60 * MIN) });
    assert.strictEqual(logic.evaluateDelayAlert(spent, 40).shouldAlert, false, 'cap reached');
});

// ── Auto-stop deadline ───────────────────────────────────────────────────────

test('within the deadline nothing is stopped', () => {
    const r = logic.evaluateDeadline(row(), null, new Date(T + 60 * MIN));
    assert.strictEqual(r.shouldStop, false);
});

test('a journey never taken stops silently after scheduled arrival plus margin', () => {
    const arrival = T + 135 * MIN;
    assert.strictEqual(logic.evaluateDeadline(row(), null, new Date(arrival + 30 * MIN)).shouldStop, false);
    const late = logic.evaluateDeadline(row(), null, new Date(arrival + 50 * MIN));
    assert.strictEqual(late.shouldStop, true);
    assert.strictEqual(late.reason, 'arrival-not-confirmed');
});

test('a genuinely delayed train is NOT cut off — the deadline follows the prediction', () => {
    const arrival = T + 135 * MIN;
    const predictedArrival = (arrival + 90 * MIN) / 1000;   // running 90 minutes late
    // Well past scheduled arrival + margin, which would have killed it…
    const r = logic.evaluateDeadline(row(), predictedArrival, new Date(arrival + 60 * MIN));
    assert.strictEqual(r.shouldStop, false, 'still travelling — do not stop tracking');
    // …but it does end once the predicted arrival itself is past.
    const after = logic.evaluateDeadline(row(), predictedArrival, new Date(arrival + 120 * MIN));
    assert.strictEqual(after.shouldStop, true);
});

test('the absolute lifetime cap wins over any prediction', () => {
    const silly = (T + 20 * 60 * MIN) / 1000;   // "arriving" in 20 hours
    const r = logic.evaluateDeadline(row(), silly, new Date(T + 13 * 60 * MIN));
    assert.strictEqual(r.shouldStop, true);
    assert.strictEqual(r.reason, 'activity-lifetime-cap');
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('alert copy names the train and never claims "on time"', () => {
    const t = logic.alertText(row(), 12, 'appeared');
    assert.match(t.title, /2612/);
    assert.match(t.title, /12 минути/);
    assert.ok(!/навреме/.test(t.title + t.body));

    const rec = logic.alertText(row(), 2, 'recovered');
    assert.match(rec.title, /наваксва/);
});

test('alert copy prefers the display number when the client sent one', () => {
    const t = logic.alertText(row(), 12, 'appeared', 'БВ 3637');
    assert.strictEqual(t.title, 'БВ 3637 закъснява с 12 минути');
    // No display form: still reads as a train, not a bare number.
    assert.match(logic.alertText(row(), 12, 'appeared').title, /^Влак 2612/);
    // Singular is respected.
    assert.match(logic.alertText(row(), 1, 'appeared', 'ПВ 30114').title, /1 минута$/);
});

// ── Copy, English ────────────────────────────────────────────────────────────
// Real incident: an English-language app with a correctly English Live
// Activity card still got a Bulgarian delay push, because nothing carried
// the client's language to alertText() at all — ctx.language fixes that.

test('language defaults to Bulgarian when unset, unrecognized, or ctx omitted entirely', () => {
    assert.match(logic.alertText(row(), 12, 'appeared').title, /закъснява/);
    assert.match(logic.alertText(row(), 12, 'appeared', null, {}).title, /закъснява/);
    assert.match(logic.alertText(row(), 12, 'appeared', null, { language: 'fr' }).title, /закъснява/, 'unrecognized language is not English either');
});

test('English: names the train, never claims "on time", respects singular', () => {
    const t = logic.alertText(row(), 12, 'appeared', 'FT 3637', { language: 'en' });
    assert.strictEqual(t.title, 'FT 3637 is delayed by 12 minutes');
    assert.ok(!/on time/i.test(t.title + t.body));

    const rec = logic.alertText(row(), 2, 'recovered', 'FT 3637', { language: 'en' });
    assert.match(rec.title, /catching up/);

    assert.match(logic.alertText(row(), 12, 'appeared', null, { language: 'en' }).title, /^Train 2612/, 'bare fallback is English too, not "Влак"');
    assert.match(logic.alertText(row(), 1, 'appeared', 'PT 30114', { language: 'en' }).title, /1 minute$/, 'not "1 minutes"');
});

test('English: a connection alert is about the connection, and says when it now leaves', () => {
    const t = logic.alertText(row(), 31, 'appeared', 'FT 8611', {
        role: 'connection', phase: 'preDeparture', language: 'en', destinationDisplay: 'Bansko', expectedHm: '09:26', scheduledHm: '08:55',
    });
    assert.strictEqual(t.title, 'Connection delayed by 31 minutes');
    assert.strictEqual(t.body, 'FT 8611 to Bansko leaves at 09:26 instead of 08:55.');

    const rec = logic.alertText(row(), 2, 'recovered', 'FT 8611', { role: 'connection', language: 'en' });
    assert.match(rec.title, /catching up/);
});

test('English: pre-departure vs in-transit wording differs, same as Bulgarian', () => {
    const before = logic.alertText(row(), 12, 'appeared', 'PT 4632', { phase: 'preDeparture', role: 'active', language: 'en' });
    assert.match(before.body, /Check before you leave/);

    const during = logic.alertText(row(), 12, 'worse', 'PT 4632', { phase: 'inTransit', role: 'active', language: 'en' });
    assert.match(during.body, /delay has increased/);
    assert.ok(!/Check before you leave/.test(during.body), 'nonsense once already aboard');
});

// ── Connection-risk banding, ported 1:1 from the client's transfer banner ──
// (JourneyLiveActivityAttributes.swift's ContentState.connectionRisk).

test('connectionGapMinutes: null when either side is unknown, floor()s otherwise', () => {
    assert.strictEqual(logic.connectionGapMinutes(null, 1000), null);
    assert.strictEqual(logic.connectionGapMinutes(1000, null), null);
    // 9.9 minutes -> 9, not rounded up to 10 (matters right at the tight/fine line).
    assert.strictEqual(logic.connectionGapMinutes(0, 9.9 * 60), 9);
});

test('connectionRiskBand: <=0 is departsBeforeArrival (inclusive), not just negative', () => {
    assert.strictEqual(logic.connectionRiskBand(null), null);
    assert.strictEqual(logic.connectionRiskBand(0), 'departsBeforeArrival');
    assert.strictEqual(logic.connectionRiskBand(-5), 'departsBeforeArrival');
    assert.strictEqual(logic.connectionRiskBand(1), 'tight');
    assert.strictEqual(logic.connectionRiskBand(9), 'tight');
    assert.strictEqual(logic.connectionRiskBand(10), 'fine', '10 is the boundary — comfortable, not tight');
    assert.strictEqual(logic.connectionRiskBand(30), 'fine');
});

test('transferArrivalUnix / nextDepartureUnix: predicted preferred, scheduled as fallback', () => {
    const r = row();
    assert.strictEqual(logic.transferArrivalUnix(r, { predictedArrUnix: 1000 }), 1000);
    assert.strictEqual(
        logic.transferArrivalUnix(r, { predictedArrUnix: null }),
        Math.floor(new Date(r.scheduled_arrival).getTime() / 1000)
    );
    assert.strictEqual(logic.nextDepartureUnix(r, { predictedDepUnix: 2000 }), 2000);
    assert.strictEqual(
        logic.nextDepartureUnix(r, null),
        Math.floor(new Date(r.scheduled_departure).getTime() / 1000),
        'no feed at all for the sibling leg — still falls back to its schedule'
    );
});

// Only a CONNECTION interrupts Focus/DND. The delay of the train being ridden (or about to be boarded) is on
// the card every time the passenger looks; the connecting train is where a minute decides the journey.
test('isAlertActionable: only the connection is time-sensitive', () => {
    assert.strictEqual(logic.isAlertActionable({ role: 'connection', phase: 'preDeparture' }), true);
    assert.strictEqual(logic.isAlertActionable({ role: 'connection', phase: 'inTransit' }), true);
    assert.strictEqual(logic.isAlertActionable({ role: 'active', phase: 'preDeparture' }), false, 'not boarded yet is no longer enough');
    assert.strictEqual(logic.isAlertActionable({ role: 'active', phase: 'inTransit' }), false);
});
