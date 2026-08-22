'use strict';

/**
 * Android parity for server-driven tracking.
 *
 * The decision logic (armedLogic) is shared and already covered; what needs
 * pinning here is the delivery split — that an Android install registers and
 * resolves correctly, that FCM errors map onto the same vocabulary the watcher
 * branches on, and above all that none of it changed how iOS behaves.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-android-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const store = require('../services/liveactivity/armedStore');
const ctrl  = require('../controllers/armedJourneyController');
const fcm   = require('../services/liveactivity/fcm');

// A realistically shaped FCM registration token: not hex, has a colon.
const FCM_TOKEN = 'fMEQFCa9RQyIrPhZ8VkG3H:APA91bF' + 'x7Qm2_-Zk'.repeat(12);
const hex = (c) => String(c).repeat(64).slice(0, 64);

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
const register = (body) => { const res = mockRes(); ctrl.registerDevice({ body }, res); return res; };

// ── Registration ─────────────────────────────────────────────────────────────

test('an Android install registers one token, without kind or environment', () => {
    const res = register({ installId: 'install-android-0001', token: FCM_TOKEN, platform: 'android' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.platform, 'android');
    assert.strictEqual(res.body.kind, 'fcm');

    const db = new Database(TMP, { readonly: true });
    const row = db.prepare('SELECT kind, platform, environment FROM device_tokens WHERE token = ?').get(FCM_TOKEN);
    db.close();
    assert.strictEqual(row.kind, 'fcm');
    assert.strictEqual(row.platform, 'android');
    assert.strictEqual(row.environment, 'n/a', "APNs' sandbox/production split is meaningless for FCM");
});

test('the FCM token shape is accepted where the APNs hex rule would reject it', () => {
    const { isValidToken } = require('../controllers/liveActivityController');
    assert.strictEqual(isValidToken(FCM_TOKEN), false,
        'precondition: an FCM token is not hex, so the iOS validator refuses it');
    assert.strictEqual(register({ installId: 'install-android-0002', token: FCM_TOKEN + 'A', platform: 'android' }).statusCode, 200);
});

test('Android registration still rejects nonsense', () => {
    assert.strictEqual(register({ installId: 'short', token: FCM_TOKEN, platform: 'android' }).statusCode, 400);
    assert.strictEqual(register({ installId: 'install-android-0003', token: 'too-short', platform: 'android' }).statusCode, 400);
    assert.strictEqual(register({ installId: 'install-android-0003', token: FCM_TOKEN, platform: 'windows' }).statusCode, 400);
});

// ── iOS must be untouched ────────────────────────────────────────────────────

test('iOS registration is unchanged and defaults to platform ios', () => {
    const res = register({ installId: 'install-ios-000001', token: hex('a'), kind: 'push_to_start', environment: 'production' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.platform, 'ios', 'omitting platform keeps shipped builds working');

    const db = new Database(TMP, { readonly: true });
    assert.strictEqual(db.prepare('SELECT platform FROM device_tokens WHERE token = ?').get(hex('a')).platform, 'ios');
    db.close();

    // The iOS requirements still hold.
    assert.strictEqual(register({ installId: 'install-ios-000001', token: hex('b'), environment: 'production' }).statusCode, 400,
        'iOS still needs a kind');
    assert.strictEqual(register({ installId: 'install-ios-000001', token: hex('b'), kind: 'alert' }).statusCode, 400,
        'iOS still needs an environment');
    assert.strictEqual(register({ installId: 'install-ios-000001', token: FCM_TOKEN, kind: 'alert', environment: 'production' }).statusCode, 400,
        'iOS still needs a hex token');
});

// ── Token resolution ─────────────────────────────────────────────────────────

test('one Android token answers for both purposes', () => {
    const inst = 'install-android-resolve';
    register({ installId: inst, token: FCM_TOKEN + 'BB', platform: 'android' });

    for (const kind of ['push_to_start', 'alert']) {
        const t = store.getToken(inst, kind);
        assert.ok(t, `android token resolves for ${kind}`);
        assert.strictEqual(t.platform, 'android');
        assert.strictEqual(t.kind, 'fcm');
    }
});

test('REGRESSION: an iOS install never falls back to another token', () => {
    const inst = 'install-ios-partial01';
    register({ installId: inst, token: hex('c'), kind: 'push_to_start', environment: 'sandbox' });

    const start = store.getToken(inst, 'push_to_start');
    assert.strictEqual(start.token, hex('c'));
    assert.strictEqual(start.platform, 'ios');

    assert.strictEqual(store.getToken(inst, 'alert'), null,
        'no alert token registered means no alert token — never substitute one');
});

test('arm reports canAutoStart for an Android install', () => {
    const inst = 'install-android-arming';
    register({ installId: inst, token: FCM_TOKEN + 'CC', platform: 'android' });

    const res = mockRes();
    ctrl.arm({ body: {
        installId: inst, journeyId: 'j-android', trainNumber: '2612',
        boardingStation: 'София', destinationStation: 'Пловдив',
        scheduledDeparture: '2026-08-22T11:30:00Z', scheduledArrival: '2026-08-22T13:45:00Z',
    } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.canAutoStart, true);
});

// ── FCM error classification ─────────────────────────────────────────────────

test('FCM errors map onto the same vocabulary the watcher branches on', () => {
    assert.strictEqual(fcm.classify(200, null), 'ok');
    // A handset that uninstalled or cleared data: drop the row, never retry.
    assert.strictEqual(fcm.classify(404, 'UNREGISTERED'), 'invalid-token');
    assert.strictEqual(fcm.classify(400, 'INVALID_ARGUMENT'), 'invalid-token');
    assert.strictEqual(fcm.classify(401, 'UNAUTHENTICATED'), 'auth');
    assert.strictEqual(fcm.classify(403, 'SENDER_ID_MISMATCH'), 'auth');
    assert.strictEqual(fcm.classify(429, 'QUOTA_EXCEEDED'), 'rate-limited');
    assert.strictEqual(fcm.classify(503, 'UNAVAILABLE'), 'server');
    assert.strictEqual(fcm.classify(418, 'SOMETHING_NEW'), 'error');
});

test('the FcmError code is dug out of the v1 error body', () => {
    const body = { error: { code: 404, status: 'NOT_FOUND', details: [
        { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' },
    ] } };
    assert.strictEqual(fcm.errorCodeOf(body), 'UNREGISTERED');
    assert.strictEqual(fcm.errorCodeOf({ error: { status: 'PERMISSION_DENIED' } }), 'PERMISSION_DENIED');
    assert.strictEqual(fcm.errorCodeOf(null), null);
});

test('FCM is reported as unconfigured rather than throwing when creds are absent', () => {
    const saved = { ...process.env };
    delete process.env.FCM_SERVICE_ACCOUNT;
    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_CLIENT_EMAIL;
    delete process.env.FCM_PRIVATE_KEY;
    assert.strictEqual(fcm.isConfigured(), false);
    Object.assign(process.env, saved);
});
