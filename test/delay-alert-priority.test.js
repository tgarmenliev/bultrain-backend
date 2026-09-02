'use strict';

/**
 * End-to-end check that the connection-risk wiring in armedWatcher.js's
 * maybeAlert()/connectionRiskForAlert() actually reaches the real APNs
 * payload — the pure-function tests in armed-logic.test.js cover the exact
 * banding math, this covers the plumbing that feeds it (fetching the SIBLING
 * leg's own feed, not just the alerting leg's).
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-prio-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const armedStore   = require('../services/liveactivity/armedStore');
const apns         = require('../services/liveactivity/apns');
const testFeed     = require('../services/liveactivity/testFeed');
const armedWatcher = require('../services/liveactivity/armedWatcher');

const INSTALL = 'install-priority-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockApns() {
    const calls = [];
    const original = apns.send;
    apns.send = async (args) => { calls.push(args); return { outcome: 'ok', status: 200 }; };
    return { calls, restore: () => { apns.send = original; } };
}

function armLeg(journeyId, legIndex, train, boarding, destination, depOffsetMs, arrOffsetMs) {
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: legIndex,
        train_number: train, boarding_station: boarding, destination_station: destination,
        direction_station: null,
        scheduled_departure: new Date(Date.now() + depOffsetMs).toISOString(),
        scheduled_arrival:   new Date(Date.now() + arrOffsetMs).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    // Mark it already rolling (departed a while ago, per the caller's
    // negative depOffsetMs), so legPhase() reads 'inTransit'.
    const row = armedStore.listActive().find(r => r.journey_id === journeyId && r.leg_index === legIndex);
    armedStore.markStarted(row.id);
}

test.beforeEach(() => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('a'), kind: 'alert', environment: 'sandbox' });
});
test.afterEach(() => testFeed.clearAll());

test('a delayed leg with NO downstream connection gets normal priority, not time-sensitive', async () => {
    const journeyId = 'j-prio-solo';
    armLeg(journeyId, 0, 'TEST-PRIO-S', 'Board', 'End', -10 * 60000, 60 * 60000);

    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-PRIO-S', { trip: { stops: [
        { station: 'Board', arrivalTime: nowSec - 900, departureTime: nowSec - 600, arrivalDelay: 1200, departureDelay: 1200 },
        { station: 'End', arrivalTime: nowSec + 40 * 60, departureTime: null, arrivalDelay: 1200, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
        armedStore.disarm(INSTALL, journeyId, 0);
    }

    assert.strictEqual(mock.calls.length, 1);
    const body = JSON.parse(mock.calls[0].body);
    assert.strictEqual(body.aps['interruption-level'], 'active', 'nothing downstream to protect — normal priority');
});

test('the CURRENT leg\'s own delay shrinking a downstream connection escalates to time-sensitive', async () => {
    const journeyId = 'j-prio-risk';
    // Comfortable 15-min gap under normal (no-delay) conditions.
    armLeg(journeyId, 0, 'TEST-PRIO-R1', 'Board', 'Transfer', -10 * 60000, 20 * 60000);
    armLeg(journeyId, 1, 'TEST-PRIO-R2', 'Transfer', 'End', 35 * 60000, 60 * 60000);

    // A 20-min delay on leg 0 pushes its predicted arrival at the transfer
    // station to now+40min — PAST leg 1's scheduled departure (now+35min).
    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-PRIO-R1', { trip: { stops: [
        { station: 'Board', arrivalTime: nowSec - 900, departureTime: nowSec - 600, arrivalDelay: 1200, departureDelay: 1200 },
        { station: 'Transfer', arrivalTime: nowSec + 40 * 60, departureTime: null, arrivalDelay: 1200, departureDelay: null },
    ] } });
    // Leg 2 has no live feed at all — falls back to its own schedule, exactly
    // as the client's effectiveNextTransportDeparture would.

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
        armedStore.disarm(INSTALL, journeyId, null);
    }

    // Only leg 0 has coverage to alert on (leg 1 has no delayMin at all).
    assert.strictEqual(mock.calls.length, 1);
    const body = JSON.parse(mock.calls[0].body);
    assert.strictEqual(body.aps['interruption-level'], 'time-sensitive',
        'the delay on the leg being RIDDEN, not the connecting train itself, is what created the risk');
});

test('the same downstream connection, comfortably on schedule, stays normal priority', async () => {
    const journeyId = 'j-prio-fine';
    armLeg(journeyId, 0, 'TEST-PRIO-F1', 'Board', 'Transfer', -10 * 60000, 20 * 60000);
    armLeg(journeyId, 1, 'TEST-PRIO-F2', 'Transfer', 'End', 35 * 60000, 60 * 60000);

    // Only a small delay this time — predicted arrival now+22min, still a
    // comfortable 13-min gap before leg 1's scheduled now+35min departure.
    const nowSec = Math.floor(Date.now() / 1000);
    testFeed.set('TEST-PRIO-F1', { trip: { stops: [
        { station: 'Board', arrivalTime: nowSec - 900, departureTime: nowSec - 600, arrivalDelay: 300, departureDelay: 300 },
        { station: 'Transfer', arrivalTime: nowSec + 22 * 60, departureTime: null, arrivalDelay: 300, departureDelay: null },
    ] } });

    const mock = mockApns();
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
        armedStore.disarm(INSTALL, journeyId, null);
    }

    assert.strictEqual(mock.calls.length, 1);
    const body = JSON.parse(mock.calls[0].body);
    assert.strictEqual(body.aps['interruption-level'], 'active', 'a 13-min buffer is comfortable — the Live Activity already shows this passively');
});
