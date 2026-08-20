'use strict';

/**
 * The duplicate-Activity race, seen live: the alarm started a card locally, and
 * seconds later the watcher independently decided the trigger window had opened
 * and pushed a start of its own. The second Activity is an orphan — the app's
 * manager only tracks the one it started — so it never updates and sits frozen
 * until it expires.
 *
 * Registering an update token is proof the app already has a card for that leg,
 * so it must claim the armed row and cancel the pending push-to-start.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-dup-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
require('../database/migrate')(TMP);

const store = require('../services/liveactivity/armedStore');
const la    = require('../controllers/liveActivityController');
const logic = require('../services/liveactivity/armedLogic');

const INSTALL = 'install-dup-test1234';
const token = (c) => String(c).repeat(64).slice(0, 64);

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
function armLeg(journeyId, legIndex = 0) {
    store.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: legIndex,
        train_number: '2612', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 150 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: store.nowIso(),
    });
    return store.listActive().find(r => r.journey_id === journeyId);
}
function registerCard(journeyId, legIndex = 0) {
    const res = mockRes();
    la.register({ body: {
        token: token('a'), environment: 'sandbox', journeyId, currentLegIndex: legIndex,
        trainNumber: '2612', boardingStation: 'София', destinationStation: 'Пловдив',
        scheduledDeparture: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduledArrival:   new Date(Date.now() + 150 * 60000).toISOString(),
    } }, res);
    return res;
}

test('registering a locally started card cancels the pending push-to-start', () => {
    const row = armLeg('j-dup');
    assert.strictEqual(row.state, 'armed');

    // The trigger window is open — without the fix this leg would be pushed.
    const before = logic.evaluateTrigger(row, null, new Date());
    assert.strictEqual(before.shouldStart, true, 'precondition: the watcher would have started it');

    const res = registerCard('j-dup');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.autoStartCancelled, true);

    const after = store.listActive().find(r => r.journey_id === 'j-dup');
    assert.strictEqual(after.state, 'started', 'the row is claimed');
    assert.ok(after.started_at, 'and stamped, so the auto-stop deadline anchors correctly');

    assert.strictEqual(logic.evaluateTrigger(after, null, new Date()).shouldStart, false);
    assert.strictEqual(logic.evaluateTrigger(after, null, new Date()).reason, 'not-armed');
});

test('claiming is idempotent and never disturbs a leg already running', () => {
    armLeg('j-twice');
    assert.strictEqual(registerCard('j-twice').body.autoStartCancelled, true);
    // A token rotation re-registers the same leg; nothing more to claim.
    assert.strictEqual(registerCard('j-twice').body.autoStartCancelled, false);
    assert.strictEqual(store.listActive().find(r => r.journey_id === 'j-twice').state, 'started');
});

test('a different leg of the same journey is left armed', () => {
    armLeg('j-legs', 0);
    armLeg('j-legs', 1);
    registerCard('j-legs', 0);

    const legs = store.listActive().filter(r => r.journey_id === 'j-legs');
    assert.strictEqual(legs.find(r => r.leg_index === 0).state, 'started');
    assert.strictEqual(legs.find(r => r.leg_index === 1).state, 'armed',
        'the next leg still needs its own automatic start');
});

test('registering for a journey that was never armed is harmless', () => {
    const res = registerCard('j-never-armed');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.autoStartCancelled, false);
});
