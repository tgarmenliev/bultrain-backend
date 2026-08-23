'use strict';

/**
 * disarm() never touched live_activity_tokens — a whole-journey disarm left
 * the Activity's registration orphaned (worker.js kept pushing to it) until
 * scheduled_arrival aged it out, hours later. Surfaced by a stale token from
 * an old test session getting picked up by a brand new one.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-disarm-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const armedStore = require('../services/liveactivity/armedStore');
const laStore     = require('../services/liveactivity/store');
const ctrl        = require('../controllers/armedJourneyController');

const INSTALL = 'install-disarm-test12';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
function armLeg(journeyId, legIndex = 0) {
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: legIndex,
        train_number: '5000', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 150 * 60000).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
}
function seedToken(journeyId, legIndex = 0) {
    laStore.upsert({
        token: hexToken('e'), environment: 'sandbox', journey_id: journeyId,
        train_number: '5000', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 20 * 60000).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 150 * 60000).toISOString(),
        current_leg_index: legIndex, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
}

test('a whole-journey disarm removes its live_activity_tokens row too', () => {
    armLeg('j-disarm-whole');
    seedToken('j-disarm-whole');
    assert.ok(laStore.getActiveTokenForJourney('j-disarm-whole'), 'precondition: the token exists');

    const res = mockRes();
    ctrl.disarm({ body: { installId: INSTALL, journeyId: 'j-disarm-whole' } }, res);

    assert.strictEqual(res.body.tokensRemoved, 1);
    assert.strictEqual(laStore.getActiveTokenForJourney('j-disarm-whole'), null,
        'no orphaned registration left for a future, unrelated journey to stumble on');
});

test('disarming a SINGLE leg leaves the token alone — it may still serve a later leg', () => {
    armLeg('j-disarm-one', 0);
    armLeg('j-disarm-one', 1);
    seedToken('j-disarm-one', 0);

    const res = mockRes();
    ctrl.disarm({ body: { installId: INSTALL, journeyId: 'j-disarm-one', legIndex: 0 } }, res);

    assert.strictEqual(res.body.tokensRemoved, 0);
    assert.ok(laStore.getActiveTokenForJourney('j-disarm-one'), 'token untouched — leg 1 may still retarget it');
});
