'use strict';

/**
 * Real user report: arming a leg close to departure, when a delay already
 * exists at that moment, fired the delay-alert push within seconds — before
 * the passenger had even put the phone down. The Live Activity itself was
 * never the complaint (it appears immediately, correctly); only the extra
 * push interruption was. See maybeAlert() in armedWatcher.js and
 * ALERT_ARM_GRACE_MS in armedLogic.js.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-armgrace-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database     = require('better-sqlite3');
const armedStore   = require('../services/liveactivity/armedStore');
const apns         = require('../services/liveactivity/apns');
const testFeed     = require('../services/liveactivity/testFeed');
const armedWatcher = require('../services/liveactivity/armedWatcher');
const logic        = require('../services/liveactivity/armedLogic');

const INSTALL = 'install-armgrace-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockApns() {
    const calls = [];
    const original = apns.send;
    apns.send = async (args) => { calls.push(args); return { outcome: 'ok', status: 200 }; };
    return { calls, restore: () => { apns.send = original; } };
}

function setCreatedAt(id, iso) {
    const db = new Database(TMP);
    db.prepare('UPDATE armed_journeys SET created_at = ? WHERE id = ?').run(iso, id);
    db.close();
}

test.beforeEach(() => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'sandbox' });
});
test.afterEach(() => testFeed.clearAll());

test('a delay already present at arm time does not alert on the very first tick', async () => {
    const journeyId = 'j-armgrace-fresh';
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: 'TEST-ARMGRACE-1', boarding_station: 'Board', destination_station: 'End',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 80 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    // created_at defaults to "now" via armedStore.arm — exactly the just-armed case.
    // Mark it started so the tick doesn't take the push-to-start path at all (no
    // 'start' token is registered in this file — only 'alert' — and failing to
    // start there would mark the row stopped before delay-alert logic even
    // runs). This does not touch created_at, so the arm-grace clock is unaffected.
    armedStore.markStarted(armedStore.listActive().find(r => r.journey_id === journeyId).id);

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-ARMGRACE-1', { trip: { stops: [
        { station: 'Board', arrivalTime: null, departureTime: nowSec + 20 * 60, arrivalDelay: null, departureDelay: 900 },
        { station: 'End', arrivalTime: nowSec + 80 * 60, departureTime: null, arrivalDelay: 900, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    assert.strictEqual(mock.calls.length, 0, 'held back — the leg was armed seconds ago');

    const row = armedStore.listActive().find(r => r.journey_id === journeyId);
    assert.strictEqual(row.last_delay_min, 15, 'still recorded via recordDelaySeen, so a later comparison is against truth, not stale null');
    assert.strictEqual(row.alerts_sent, 0);

    armedStore.disarm(INSTALL, journeyId, 0);
});

test('the same delay alerts normally once the arm grace window has passed', async () => {
    const journeyId = 'j-armgrace-expired';
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: 'TEST-ARMGRACE-2', boarding_station: 'Board', destination_station: 'End',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 80 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    const row0 = armedStore.listActive().find(r => r.journey_id === journeyId);
    armedStore.markStarted(row0.id);
    // Simulate the grace window having already elapsed since arming.
    setCreatedAt(row0.id, new Date(Date.now() - (logic.ALERT_ARM_GRACE_MS + 60000)).toISOString());

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-ARMGRACE-2', { trip: { stops: [
        { station: 'Board', arrivalTime: null, departureTime: nowSec + 20 * 60, arrivalDelay: null, departureDelay: 900 },
        { station: 'End', arrivalTime: nowSec + 80 * 60, departureTime: null, arrivalDelay: 900, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    assert.strictEqual(mock.calls.length, 1, 'grace window elapsed — the normal first-alert rule applies');

    const row = armedStore.listActive().find(r => r.journey_id === journeyId);
    assert.strictEqual(row.alerts_sent, 1);

    armedStore.disarm(INSTALL, journeyId, 0);
});

test('once an alert has already been sent for the leg, grace never applies again', async () => {
    const journeyId = 'j-armgrace-already-alerted';
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: 'TEST-ARMGRACE-3', boarding_station: 'Board', destination_station: 'End',
        direction_station: null,
        scheduled_departure: new Date(Date.now() - 5 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 60 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    const row0 = armedStore.listActive().find(r => r.journey_id === journeyId);
    armedStore.markStarted(row0.id);
    // Pretend it was already alerted once, well inside what would otherwise
    // still be the grace window relative to created_at.
    armedStore.recordAlert(row0.id, 6);

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-ARMGRACE-3', { trip: { stops: [
        { station: 'Board', arrivalTime: nowSec - 300, departureTime: nowSec - 300, arrivalDelay: 1200, departureDelay: 1200 },
        { station: 'End', arrivalTime: nowSec + 60 * 60, departureTime: null, arrivalDelay: 1200, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    // last_alert_at was just set by recordAlert above, so ALERT_MIN_INTERVAL_MS
    // (the ordinary back-to-back cooldown) is what should suppress this tick —
    // not the arm grace, which only ever looks at alerts_sent === 0.
    assert.strictEqual(mock.calls.length, 0, 'suppressed by the ordinary cooldown, unrelated to arm grace');

    armedStore.disarm(INSTALL, journeyId, 0);
});
