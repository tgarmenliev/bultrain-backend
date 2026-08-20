'use strict';

/**
 * Server-driven journey tracking: device tokens, armed journeys, and the
 * push-to-start budget guard.
 *
 * The budget guard is the one that matters most: Apple's own push-to-start
 * limit is fixed, undocumented, and when exceeded the device silently ignores
 * starts for up to 24 hours while APNs still returns 200. Our stricter counter
 * has to refuse first, so a runaway loop costs one missing card instead.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-armed-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const store = require('../services/liveactivity/armedStore');
const ctrl  = require('../controllers/armedJourneyController');

const INSTALL = 'install-abcdef123456';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
function armRow(over = {}) {
    return {
        install_id: INSTALL, journey_id: 'j1', leg_index: 0,
        train_number: '2612', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: 'Бургас',
        scheduled_departure: '2026-08-21T11:30:00.000Z',
        scheduled_arrival:   '2026-08-21T13:45:00.000Z',
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: store.nowIso(),
        ...over,
    };
}

// ── device tokens ────────────────────────────────────────────────────────────

test('a rotated token replaces its predecessor for the same install and kind', () => {
    store.registerDevice({ installId: INSTALL, token: hexToken('a'), kind: 'push_to_start', environment: 'sandbox' });
    store.registerDevice({ installId: INSTALL, token: hexToken('b'), kind: 'push_to_start', environment: 'sandbox' });

    const current = store.getToken(INSTALL, 'push_to_start');
    assert.strictEqual(current.token, hexToken('b'), 'newest token wins');

    const db = new Database(TMP, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE install_id=? AND kind='push_to_start'").get(INSTALL).n;
    db.close();
    assert.strictEqual(n, 1, 'the dead token is not left behind to push to forever');
});

test('the two token kinds coexist and are looked up separately', () => {
    store.registerDevice({ installId: INSTALL, token: hexToken('c'), kind: 'alert', environment: 'sandbox' });
    assert.strictEqual(store.getToken(INSTALL, 'alert').token, hexToken('c'));
    assert.strictEqual(store.getToken(INSTALL, 'push_to_start').token, hexToken('b'), 'alert token did not clobber the start token');
    assert.strictEqual(store.getToken('nobody', 'alert'), null);
});

// ── arming ───────────────────────────────────────────────────────────────────

test('arming stores the leg; re-arming updates it and clears stale bookkeeping', () => {
    store.arm(armRow());
    let row = store.listActive().find(r => r.journey_id === 'j1');
    assert.ok(row, 'the armed leg is active');
    assert.strictEqual(row.state, 'armed');
    assert.strictEqual(row.train_number, '2612');

    // Simulate progress, then re-arm with a different train.
    store.markStarted(row.id);
    store.recordAlert(row.id, 12);
    store.arm(armRow({ train_number: '8611' }));

    row = store.listActive().find(r => r.journey_id === 'j1');
    assert.strictEqual(row.train_number, '8611', 'context replaced');
    assert.strictEqual(row.state, 'armed', 'back to armed');
    assert.strictEqual(row.started_at, null, 'stale start cleared');
    assert.strictEqual(row.last_delay_min, null, 'stale alert bookkeeping cleared');
    assert.strictEqual(row.alerts_sent, 0);
});

test('disarm and arrival take the leg out of the active set, idempotently', () => {
    store.arm(armRow({ journey_id: 'j-disarm' }));
    assert.strictEqual(store.disarm(INSTALL, 'j-disarm', 0), 1);
    assert.strictEqual(store.disarm(INSTALL, 'j-disarm', 0), 0, 'second disarm is a no-op, not an error');
    assert.ok(!store.listActive().some(r => r.journey_id === 'j-disarm'));

    store.arm(armRow({ journey_id: 'j-arrive' }));
    assert.strictEqual(store.markArrived(INSTALL, 'j-arrive', 0), 1);
    assert.ok(!store.listActive().some(r => r.journey_id === 'j-arrive'));
});

// ── push-to-start budget guard ───────────────────────────────────────────────

test('the budget guard refuses past our hourly cap, before Apple would', () => {
    const inst = 'install-budget-test1';
    for (let i = 0; i < store.MAX_STARTS_PER_HOUR; i++) {
        assert.strictEqual(store.checkStartBudget(inst).allowed, true, `start ${i + 1} allowed`);
        store.logStart(inst, `j${i}`, 'ok');
    }
    const blocked = store.checkStartBudget(inst);
    assert.strictEqual(blocked.allowed, false, 'the cap holds');
    assert.match(blocked.reason, /hourly/);
    assert.strictEqual(blocked.lastHour, store.MAX_STARTS_PER_HOUR);
});

test('refused and failed starts do not consume the budget', () => {
    const inst = 'install-budget-test2';
    store.logStart(inst, 'j1', 'refused-budget');
    store.logStart(inst, 'j2', 'invalid-token');
    assert.strictEqual(store.checkStartBudget(inst).lastHour, 0, 'only successful sends count');
    assert.strictEqual(store.checkStartBudget(inst).allowed, true);
});

test('the daily cap holds even when the hourly window has drained', () => {
    const inst = 'install-budget-test3';
    const db = new Database(TMP);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < store.MAX_STARTS_PER_DAY; i++) {
        db.prepare("INSERT INTO push_start_log (install_id, sent_at, outcome) VALUES (?,?,'ok')").run(inst, twoHoursAgo);
    }
    db.close();

    const r = store.checkStartBudget(inst);
    assert.strictEqual(r.lastHour, 0, 'nothing in the last hour');
    assert.strictEqual(r.allowed, false, 'but the day is spent');
    assert.match(r.reason, /daily/);
});

// ── endpoint validation ──────────────────────────────────────────────────────

test('register-device rejects a bad install id, kind, environment and token', () => {
    const call = (body) => { const res = mockRes(); ctrl.registerDevice({ body }, res); return res; };
    assert.strictEqual(call({ installId: 'short', token: hexToken('a'), kind: 'alert', environment: 'sandbox' }).statusCode, 400);
    assert.strictEqual(call({ installId: INSTALL, token: 'nothex', kind: 'alert', environment: 'sandbox' }).statusCode, 400);
    assert.strictEqual(call({ installId: INSTALL, token: hexToken('a'), kind: 'wrong', environment: 'sandbox' }).statusCode, 400);
    assert.strictEqual(call({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'nope' }).statusCode, 400);
    assert.strictEqual(call({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'sandbox' }).statusCode, 200);
});

test('arm validates the journey and reports whether we can actually auto-start', () => {
    const res = mockRes();
    ctrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-api', trainNumber: '2612',
        boardingStation: 'София', destinationStation: 'Пловдив',
        scheduledDeparture: '2026-08-21T11:30:00Z', scheduledArrival: '2026-08-21T13:45:00Z',
    } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.canAutoStart, true, 'this install has a push-to-start token');

    // arrival before departure is rejected
    const bad = mockRes();
    ctrl.arm({ body: {
        installId: INSTALL, journeyId: 'j-bad', trainNumber: '2612',
        boardingStation: 'София', destinationStation: 'Пловдив',
        scheduledDeparture: '2026-08-21T13:45:00Z', scheduledArrival: '2026-08-21T11:30:00Z',
    } }, bad);
    assert.strictEqual(bad.statusCode, 400);

    // an install with no start token is told so, rather than silently accepted
    const noToken = mockRes();
    ctrl.arm({ body: {
        installId: 'install-without-token1', journeyId: 'j-x', trainNumber: '2612',
        boardingStation: 'София', destinationStation: 'Пловдив',
        scheduledDeparture: '2026-08-21T11:30:00Z', scheduledArrival: '2026-08-21T13:45:00Z',
    } }, noToken);
    assert.strictEqual(noToken.body.canAutoStart, false);
});
