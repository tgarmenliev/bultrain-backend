'use strict';

/**
 * Multi-leg journeys, after two real trips exposed three faults:
 *
 *   - the card showed the first train and the final station for the whole ride,
 *     because the immutable attributes describe the journey, not the leg;
 *   - a passenger on leg 1 got no delay alerts at all, because only leg 0 was
 *     being watched;
 *   - and now that every leg is armed up front, leg 1's trigger falls WHILE the
 *     passenger is still riding leg 0 — which would push a second card, and
 *     would warn about a train they are not on.
 */

const test   = require('node:test');
const assert = require('node:assert');
const logic  = require('../services/liveactivity/armedLogic');
const contentState = require('../services/liveactivity/contentState');

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const T = Date.parse('2026-08-22T09:00:00.000Z');   // leg 0 departs

// Sofia → Mezdra (leg 0), change, Mezdra → Vidin (leg 1).
const leg = (i, over = {}) => ({
    id: i + 1, journey_id: 'j-multi', leg_index: i, state: 'armed',
    train_number: i === 0 ? '4632' : '8611',
    train_number_display: i === 0 ? 'ПВ 4632' : 'БВ 8611',
    boarding_station:    i === 0 ? 'София' : 'Мездра',
    destination_station: i === 0 ? 'Мездра' : 'Видин',
    scheduled_departure: iso(i === 0 ? T : T + 150 * MIN),
    scheduled_arrival:   iso(i === 0 ? T + 120 * MIN : T + 260 * MIN),
    last_delay_min: null, last_alert_at: null, alerts_sent: 0, started_at: null,
    current_leg_index: i, is_current_bus: 0,
    next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    ...over,
});

// ── Leg sequencing ───────────────────────────────────────────────────────────

test('only the leg being travelled may have its card started', () => {
    const legs = [leg(0, { state: 'started' }), leg(1)];

    assert.strictEqual(logic.mayStartLeg(legs[0], legs, new Date(T + 30 * MIN)), true);
    assert.strictEqual(logic.mayStartLeg(legs[1], legs, new Date(T + 30 * MIN)), false,
        "leg 1's trigger falls mid-ride on leg 0 — starting it would give a second card");
});

test('the next leg becomes startable once the previous one finishes', () => {
    // arrived legs drop out of listActive, so the live set is leg 1 alone.
    const legs = [leg(1)];
    assert.strictEqual(logic.mayStartLeg(legs[0], legs, new Date(T + 130 * MIN)), true);
});

// ── Who may be alerted about ─────────────────────────────────────────────────

test('a delay on a LATER leg is never announced mid-ride', () => {
    const legs = [leg(0, { state: 'started' }), leg(1)];
    // Deep into leg 0: the transfer is still two hours away.
    const now = new Date(T + 20 * MIN);
    const ctx = logic.legRole(legs[1], legs, now);
    assert.strictEqual(ctx.role, 'later');

    const d = logic.evaluateDelayAlert(legs[1], 31, now, { phase: 'preDeparture', role: ctx.role });
    assert.strictEqual(d.shouldAlert, false);
    assert.strictEqual(d.reason, 'not-the-current-leg',
        '"8611 is late" while sitting on 4632 reads as if THIS train were late');
});

test('the connection becomes announceable as the transfer approaches', () => {
    const legs = [leg(0, { state: 'started' }), leg(1)];
    // Leg 0 arrives at T+120; inside the 45-minute window before that.
    const now = new Date(T + 90 * MIN);
    const ctx = logic.legRole(legs[1], legs, now);
    assert.strictEqual(ctx.role, 'connection');

    const d = logic.evaluateDelayAlert(legs[1], 31, now, { phase: 'preDeparture', role: 'connection' });
    assert.strictEqual(d.shouldAlert, true);
});

test('a connection alert says plainly that it is about the NEXT train', () => {
    const t = logic.alertText(leg(1), 31, 'appeared', 'БВ 8611', { role: 'connection', phase: 'preDeparture' });
    assert.match(t.title, /Следващият ви влак/);
    assert.match(t.title, /БВ 8611/);
    assert.match(t.body, /не влакът, в който сте/);
});

// ── Phase-aware wording and thresholds ───────────────────────────────────────

test('"check before you leave" is never said to someone already aboard', () => {
    const before = logic.alertText(leg(0), 12, 'appeared', 'ПВ 4632', { phase: 'preDeparture', role: 'active' });
    assert.match(before.body, /Проверете преди да тръгнете/);

    const during = logic.alertText(leg(0), 12, 'worse', 'ПВ 4632', { phase: 'inTransit', role: 'active' });
    assert.ok(!/преди да тръгнете/.test(during.body), 'nonsense once the train has left');
    assert.match(during.body, /Закъснението нарасна/);
});

test('in transit the bar is higher, because the card already shows the delay', () => {
    // Anchored to the same synthetic timeline as `now`, not the wall clock.
    const told = leg(0, { state: 'started', last_delay_min: 10, last_alert_at: iso(T - 30 * MIN) });
    const now = new Date(T + 30 * MIN);

    const beforeDeparture = logic.evaluateDelayAlert(told, 16, now, { phase: 'preDeparture', role: 'active' });
    assert.strictEqual(beforeDeparture.shouldAlert, true, '6 minutes more matters before you set off');

    const inTransit = logic.evaluateDelayAlert(told, 16, now, { phase: 'inTransit', role: 'active' });
    assert.strictEqual(inTransit.shouldAlert, false, 'the same 6 minutes is noise once aboard');

    const substantial = logic.evaluateDelayAlert(told, 25, now, { phase: 'inTransit', role: 'active' });
    assert.strictEqual(substantial.shouldAlert, true, '15 minutes more still earns an interruption');
});

test('legPhase follows the live prediction, not just the timetable', () => {
    const row = leg(0);
    assert.strictEqual(logic.legPhase(row, null, new Date(T - 10 * MIN)), 'preDeparture');
    assert.strictEqual(logic.legPhase(row, null, new Date(T + 10 * MIN)), 'inTransit');
    // Running 40 minutes late: still on the platform, not in transit.
    const predicted = (T + 40 * MIN) / 1000;
    assert.strictEqual(logic.legPhase(row, predicted, new Date(T + 10 * MIN)), 'preDeparture');
});

// ── Per-leg content-state fields ─────────────────────────────────────────────

test('the content-state carries THIS leg, not the whole journey', () => {
    const { state } = contentState.build(leg(1), null, new Date(T + 150 * MIN));

    assert.strictEqual(state.legTransportNumber, 'БВ 8611');
    assert.strictEqual(state.legOriginStation, 'Мездра');
    assert.strictEqual(state.legDestinationStation, 'Видин');
    // Dates follow the same 2001-epoch rule as every other Date in the payload.
    assert.strictEqual(typeof state.legScheduledDeparture, 'number');
    assert.strictEqual(state.legScheduledDeparture,
        Math.floor((T + 150 * MIN) / 1000) - 978307200);
    assert.ok(state.legScheduledArrival > state.legScheduledDeparture);
});

test('the leg fields stay optional — omitted, never null', () => {
    const bare = { ...leg(0), train_number_display: null, boarding_station: '', destination_station: '' };
    const { state } = contentState.build(bare, null, new Date(T));
    for (const key of ['legTransportNumber', 'legOriginStation', 'legDestinationStation']) {
        assert.ok(!(key in state), `${key} must be omitted rather than sent empty or null`);
    }
});
