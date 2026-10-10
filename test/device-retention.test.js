'use strict';

/**
 * How long a device identifier is kept. A token is removed (a) at once, when Apple or
 * Google say the app is gone, and (b) after a long silence — but silence is measured
 * by every call the app makes, and never applies to a device with a journey in play.
 * Nothing here may end someone's alerts because of a mistake of ours.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-retention-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const store = require('../services/liveactivity/armedStore');

const hex = (c) => String(c).repeat(64).slice(0, 64);
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

function db(fn) { const d = new Database(TMP); try { return fn(d); } finally { d.close(); } }
const exists = (token) => db(d => d.prepare('SELECT COUNT(*) AS n FROM device_tokens WHERE token=?').get(token).n === 1);
const backdate = (installId, days) => db(d => d.prepare('UPDATE device_tokens SET updated_at=?, created_at=? WHERE install_id=?').run(ago(days), ago(days), installId));
const reg = (installId, token, kind = 'alert') => store.registerDevice({ installId, token, kind, environment: 'sandbox' });

test('a device silent for more than 180 days is removed; one heard from recently is not', () => {
    delete process.env.DEVICE_TOKEN_TTL_DAYS;
    reg('install-idle-0001', hex('1')); reg('install-live-0002', hex('2'));
    backdate('install-idle-0001', 181); backdate('install-live-0002', 179);

    const r = store.prune();
    assert.strictEqual(r.devices, 1);
    assert.strictEqual(exists(hex('1')), false);
    assert.strictEqual(exists(hex('2')), true);
});

test('any call from the app counts as being heard from — a returning user keeps the registration', () => {
    reg('install-quiet-003', hex('3'));
    backdate('install-quiet-003', 400);                       // a year of silence …
    store.touchInstall('install-quiet-003');                  // … then the app does something (arm, disarm, arrival)
    assert.strictEqual(store.prune().devices, 0);
    assert.strictEqual(exists(hex('3')), true);
});

test('re-registering (the app opening) refreshes it too', () => {
    reg('install-again-004', hex('4'));
    backdate('install-again-004', 400);
    reg('install-again-004', hex('4'));                       // same token, registered again
    assert.strictEqual(store.prune().devices, 0);
    assert.strictEqual(exists(hex('4')), true);
});

test('a device with a journey still in play is never removed for silence', () => {
    reg('install-trip-0005', hex('5'));
    store.arm({
        install_id: 'install-trip-0005', journey_id: 'j5', leg_index: 0, train_number: '2612',
        boarding_station: 'София', destination_station: 'Пловдив',
        scheduled_departure: ago(-1), scheduled_arrival: ago(-2),
    });
    backdate('install-trip-0005', 400);
    assert.strictEqual(store.prune().devices, 0);
    assert.strictEqual(exists(hex('5')), true);
});

test('a row with no date at all (legacy) counts as old', () => {
    db(d => d.prepare("INSERT INTO device_tokens (token, install_id, kind, environment) VALUES (?, 'install-null-0006', 'alert', 'sandbox')").run(hex('6')));
    assert.strictEqual(store.prune().devices, 1);
    assert.strictEqual(exists(hex('6')), false);
});

test('the limit is configurable and 0 turns the expiry off', () => {
    reg('install-cfg-00007', hex('7')); backdate('install-cfg-00007', 100);
    process.env.DEVICE_TOKEN_TTL_DAYS = '90';
    store.prune();
    assert.strictEqual(exists(hex('7')), false, '100 days idle > 90');
    assert.strictEqual(exists(hex('3')), true, 'one heard from today is untouched');
    reg('install-off-00008', hex('8')); backdate('install-off-00008', 5000);
    process.env.DEVICE_TOKEN_TTL_DAYS = '0';
    assert.strictEqual(store.prune().devices, 0, 'disabled');
    assert.strictEqual(exists(hex('8')), true);
    delete process.env.DEVICE_TOKEN_TTL_DAYS;
});

// ── Apple / Google say the app is gone ───────────────────────────────────────

test('APNs 410 / FCM UNREGISTERED: the token is removed at once', () => {
    reg('install-gone-0009', hex('9'), 'push_to_start');
    const dev = store.getToken('install-gone-0009', 'push_to_start');
    assert.strictEqual(store.forgetTokenIfGone(dev, { outcome: 'invalid-token', status: 410, reason: 'Unregistered' }), true);
    assert.strictEqual(exists(hex('9')), false);

    reg('install-gone-0010', hex('a'), 'fcm');
    const fcm = store.getToken('install-gone-0010', 'fcm') || { token: hex('a') };
    assert.strictEqual(store.forgetTokenIfGone(fcm, { outcome: 'invalid-token', status: 404, reason: 'UNREGISTERED' }), true);
    assert.strictEqual(exists(hex('a')), false);
});

test('but not on BadDeviceToken / INVALID_ARGUMENT / success / outages: a mistake of ours must not end alerts', () => {
    reg('install-keep-0011', hex('b'));
    const dev = { token: hex('b') };
    for (const res of [
        { outcome: 'invalid-token', status: 400, reason: 'BadDeviceToken' },     // wrong environment looks like this
        { outcome: 'invalid-token', status: 400, reason: 'INVALID_ARGUMENT' },
        { outcome: 'ok', status: 200, reason: undefined },
        { outcome: 'server', status: 503, reason: 'ServiceUnavailable' },
        { outcome: 'server', status: 0, reason: 'connect ETIMEDOUT' },
        { outcome: 'auth', status: 403, reason: 'InvalidProviderToken' },
    ]) {
        assert.strictEqual(store.forgetTokenIfGone(dev, res), false, JSON.stringify(res));
    }
    assert.strictEqual(store.forgetTokenIfGone(null, { status: 410 }), false);
    assert.strictEqual(exists(hex('b')), true);
});

test('logs carry only the first characters of an install id', () => {
    assert.strictEqual(store.idTag('install-ABCDEFGH-1234-5678'), 'install-…');
});
