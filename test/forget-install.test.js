'use strict';

/**
 * "Delete my data": everything held for one installation can be erased on request,
 * and only that installation's. Backs the privacy policy's promise.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-forget-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const store   = require('../services/liveactivity/armedStore');
const laStore = require('../services/liveactivity/store');
const ctrl    = require('../controllers/armedJourneyController');

const A = 'install-AAAAAAAA';
const B = 'install-BBBBBBBB';
const hex = (c) => String(c).repeat(64).slice(0, 64);

const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });
const arm = (install, journey, leg = 0) => store.arm({
    install_id: install, journey_id: journey, leg_index: leg, train_number: '2612',
    boarding_station: 'София', destination_station: 'Пловдив',
    scheduled_departure: '2026-10-10T11:30:00.000Z', scheduled_arrival: '2026-10-10T13:45:00.000Z',
});
const laToken = (token, journey) => laStore.upsert({
    token, environment: 'sandbox', journey_id: journey, train_number: '2612',
    boarding_station: 'София', destination_station: 'Пловдив', direction_station: null,
    scheduled_departure: '2026-10-10T11:30:00.000Z', scheduled_arrival: '2026-10-10T13:45:00.000Z',
    current_leg_index: 0, is_current_bus: 0, next_transport_number: null,
    next_transport_departure: null, is_next_transport_bus: 0,
});
const count = (sql, ...a) => { const db = new Database(TMP, { readonly: true }); try { return db.prepare(sql).get(...a).n; } finally { db.close(); } };

function seed() {
    for (const [inst, j, c] of [[A, 'jA', 'a'], [B, 'jB', 'b']]) {
        store.registerDevice({ installId: inst, token: hex(c), kind: 'push_to_start', environment: 'sandbox' });
        store.registerDevice({ installId: inst, token: hex(c.toUpperCase().toLowerCase() + '1').slice(0, 64), kind: 'alert', environment: 'sandbox' });
        arm(inst, j, 0); arm(inst, j, 1);
        store.logStart(inst, j, 'ok');
        laToken(hex(inst === A ? '1' : '2'), j);
    }
}

test('forgetting one installation erases its tokens, journeys, log and Live Activity tokens', () => {
    seed();
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM device_tokens WHERE install_id=?', A), 2);

    const r = store.forgetInstall(A);
    assert.deepStrictEqual(r, { devices: 2, armedJourneys: 2, startLog: 1, liveActivityTokens: 1 });

    assert.strictEqual(count('SELECT COUNT(*) AS n FROM device_tokens WHERE install_id=?', A), 0);
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM armed_journeys WHERE install_id=?', A), 0);
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM push_start_log WHERE install_id=?', A), 0);
    assert.strictEqual(count("SELECT COUNT(*) AS n FROM live_activity_tokens WHERE journey_id='jA'"), 0);
});

test('and nobody else’s', () => {
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM device_tokens WHERE install_id=?', B), 2);
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM armed_journeys WHERE install_id=?', B), 2);
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM push_start_log WHERE install_id=?', B), 1);
    assert.strictEqual(count("SELECT COUNT(*) AS n FROM live_activity_tokens WHERE journey_id='jB'"), 1);
});

test('forgetting is idempotent: a second request, or an unknown installation, is not an error', () => {
    assert.deepStrictEqual(store.forgetInstall(A), { devices: 0, armedJourneys: 0, startLog: 0, liveActivityTokens: 0 });
    assert.deepStrictEqual(store.forgetInstall('install-never-seen'), { devices: 0, armedJourneys: 0, startLog: 0, liveActivityTokens: 0 });
});

test('POST /forget: validates the id, answers with counts, and does not log the id', () => {
    const bad = mockRes();
    ctrl.forget({ body: { installId: 'x' } }, bad);
    assert.strictEqual(bad.statusCode, 400);
    const missing = mockRes();
    ctrl.forget({ body: {} }, missing);
    assert.strictEqual(missing.statusCode, 400);

    const logged = [];
    const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
    const ok = mockRes();
    try { ctrl.forget({ body: { installId: B } }, ok); } finally { console.log = orig; }
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.ok, true);
    assert.deepStrictEqual(ok.body.deleted, { devices: 2, armedJourneys: 2, startLog: 1, liveActivityTokens: 1 });
    assert.ok(logged.some(l => /forget/.test(l)));
    assert.ok(!logged.some(l => l.includes(B)), 'the install id never reaches the log');
    assert.strictEqual(count('SELECT COUNT(*) AS n FROM device_tokens'), 0);
});
