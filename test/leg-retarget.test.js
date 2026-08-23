'use strict';

/**
 * A later leg of a multi-leg journey must retarget the EXISTING Live Activity
 * with an ordinary content-state push, not start a second one — ActivityKit
 * attributes are immutable, but the app now reads the current leg from
 * contentState.js's leg* fields (confirmed with the mobile side). This also
 * means a transfer must never consume push-to-start budget: only the very
 * first leg of a journey ever needs one.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-retarget-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const armedStore   = require('../services/liveactivity/armedStore');
const laStore      = require('../services/liveactivity/store');
const apns         = require('../services/liveactivity/apns');
const armedWatcher = require('../services/liveactivity/armedWatcher');

const INSTALL = 'install-retarget-test1';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockApns(outcome = 'ok') {
    const calls = [];
    const original = apns.send;
    apns.send = async (args) => { calls.push(args); return { outcome, status: outcome === 'ok' ? 200 : 500 }; };
    return { calls, restore: () => { apns.send = original; } };
}

function armLeg(journeyId, legIndex, train, boarding, destination, depOffsetMs) {
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: legIndex,
        train_number: train, boarding_station: boarding, destination_station: destination,
        direction_station: null,
        scheduled_departure: new Date(Date.now() + depOffsetMs).toISOString(),
        scheduled_arrival:   new Date(Date.now() + depOffsetMs + 60 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    return armedStore.listActive().find(r => r.journey_id === journeyId && r.leg_index === legIndex);
}

test('leg 2 retargets leg 1\'s existing token instead of a second push-to-start', async () => {
    const journeyId = 'j-retarget-1';
    // Leg 0 already happened: its card is registered (an existing token to
    // retarget) and its armed row has arrived (so leg 1 becomes 'active').
    laStore.upsert({
        token: hexToken('a'), environment: 'sandbox', journey_id: journeyId,
        train_number: '1000', boarding_station: 'Пловдив', destination_station: 'Карлово',
        direction_station: null,
        scheduled_departure: new Date(Date.now() - 30 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() - 5 * 60000).toISOString(),
        current_leg_index: 0, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
    armLeg(journeyId, 0, '1000', 'Пловдив', 'Карлово', -30 * 60000);
    armedStore.markArrived(INSTALL, journeyId, 0);

    // Leg 1: a different train, different stations — departure already due.
    const leg1 = armLeg(journeyId, 1, '2000', 'Карлово', 'Антон', -1 * 60000);

    const mock = mockApns('ok');
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    assert.strictEqual(mock.calls.length, 1, 'exactly one push sent');
    assert.strictEqual(mock.calls[0].token, hexToken('a'), 'reused leg 0\'s existing token, not a new one');
    assert.strictEqual(mock.calls[0].pushType, 'liveactivity');
    const bodyObj = JSON.parse(mock.calls[0].body);
    assert.strictEqual(bodyObj.aps.event, 'update', 'an ordinary update, not a start');

    const tokenRow = laStore.getByToken(hexToken('a'));
    assert.strictEqual(tokenRow.train_number, '2000', 'the SAME token now points at leg 1\'s train');
    assert.strictEqual(tokenRow.boarding_station, 'Карлово');
    assert.strictEqual(tokenRow.destination_station, 'Антон');
    assert.strictEqual(tokenRow.current_leg_index, 1);

    const after = armedStore.getById(leg1.id);
    assert.strictEqual(after.state, 'started');

    const db = new Database(TMP, { readonly: true });
    const log = db.prepare('SELECT outcome FROM push_start_log WHERE journey_id=? ORDER BY id DESC LIMIT 1').get(journeyId);
    db.close();
    assert.strictEqual(log.outcome, 'retargeted', 'logged distinctly from a real push-to-start "ok"');
});

test('the retarget does not count against the push-to-start budget', async () => {
    const journeyId = 'j-retarget-budget';
    laStore.upsert({
        token: hexToken('b'), environment: 'sandbox', journey_id: journeyId,
        train_number: '1001', boarding_station: 'Пловдив', destination_station: 'Карлово',
        direction_station: null,
        scheduled_departure: new Date(Date.now() - 30 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() - 5 * 60000).toISOString(),
        current_leg_index: 0, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
    armLeg(journeyId, 0, '1001', 'Пловдив', 'Карлово', -30 * 60000);
    armedStore.markArrived(INSTALL, journeyId, 0);
    armLeg(journeyId, 1, '2001', 'Карлово', 'Антон', -1 * 60000);

    const before = armedStore.checkStartBudget(INSTALL);
    const mock = mockApns('ok');
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }
    const after = armedStore.checkStartBudget(INSTALL);
    assert.strictEqual(after.lastHour, before.lastHour, 'retargeting spent none of the push-to-start budget');
});

test('a failed retarget leaves the leg armed for the next tick to retry, not stopped', async () => {
    const journeyId = 'j-retarget-fail';
    laStore.upsert({
        token: hexToken('c'), environment: 'sandbox', journey_id: journeyId,
        train_number: '1002', boarding_station: 'Пловдив', destination_station: 'Карлово',
        direction_station: null,
        scheduled_departure: new Date(Date.now() - 30 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() - 5 * 60000).toISOString(),
        current_leg_index: 0, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
    armLeg(journeyId, 0, '1002', 'Пловдив', 'Карлово', -30 * 60000);
    armedStore.markArrived(INSTALL, journeyId, 0);
    const leg1 = armLeg(journeyId, 1, '2002', 'Карлово', 'Антон', -1 * 60000);

    const mock = mockApns('bad-device-token');
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    const after = armedStore.getById(leg1.id);
    assert.strictEqual(after.state, 'armed', 'not started (nothing landed) and not stopped (worth retrying)');

    // Left 'armed' on purpose (that's the assertion above) — clean it up so it
    // doesn't retry into the next test's tick() and pad its call count.
    armedStore.disarm(INSTALL, journeyId, 1);
});

test('no existing token for the journey falls through to a normal push-to-start', async () => {
    const journeyId = 'j-retarget-notoken';
    // Leg 0 arrived, but its card was NEVER registered (no live_activity_tokens row).
    armLeg(journeyId, 0, '1003', 'Пловдив', 'Карлово', -30 * 60000);
    armedStore.markArrived(INSTALL, journeyId, 0);
    armLeg(journeyId, 1, '2003', 'Карлово', 'Антон', -1 * 60000);

    armedStore.registerDevice({ installId: INSTALL, token: hexToken('d'), kind: 'push_to_start', environment: 'sandbox' });

    const mock = mockApns('ok');
    try {
        await armedWatcher.tick();
    } finally {
        mock.restore();
    }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].pushType, 'liveactivity');
    const bodyObj = JSON.parse(mock.calls[0].body);
    assert.strictEqual(bodyObj.aps.event, 'start', 'a real push-to-start, since there was nothing to retarget');
});
