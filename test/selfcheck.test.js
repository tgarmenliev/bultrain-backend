'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const selfCheck = require('../services/liveactivity/selfCheck');
const email     = require('../services/alerts/email');

// ── diffCounters / diffReasons: pure arithmetic ─────────────────────────────

test('diffCounters: delta against the previous snapshot, first-tick-safe', () => {
    const prev = { push_to_start_sent: 5, push_to_start_failed: 1, apns_errors_by_reason: {}, apns_latency_p95_ms: 40 };
    const curr = { push_to_start_sent: 5, push_to_start_failed: 4, apns_errors_by_reason: {}, apns_latency_p95_ms: 55 };
    const delta = selfCheck.diffCounters(prev, curr);
    assert.strictEqual(delta.push_to_start_sent, 0);
    assert.strictEqual(delta.push_to_start_failed, 3);
    assert.strictEqual('apns_errors_by_reason' in delta, false, 'the reason map has its own diff, not a raw subtraction');
});

test('diffCounters: no previous snapshot means the delta is just the current value', () => {
    const curr = { push_to_start_sent: 2, push_to_start_failed: 0 };
    const delta = selfCheck.diffCounters(null, curr);
    assert.strictEqual(delta.push_to_start_sent, 2);
});

test('diffReasons: per-reason delta, new reasons default from zero', () => {
    const prev = { apns_errors_by_reason: { BadDeviceToken: 2 } };
    const curr = { apns_errors_by_reason: { BadDeviceToken: 5, TopicDisallowed: 1 } };
    const delta = selfCheck.diffReasons(prev, curr);
    assert.strictEqual(delta.BadDeviceToken, 3);
    assert.strictEqual(delta.TopicDisallowed, 1);
});

// ── evaluate(): the actual rules ────────────────────────────────────────────

test('evaluate: failing with zero successes reads as broken', () => {
    const findings = selfCheck.evaluate({ push_to_start_failed: 4, push_to_start_sent: 0 }, {});
    const f = findings.find(x => x.key === 'push_to_start_broken');
    assert.strictEqual(f.bad, true);
});

test('evaluate: failures alongside at least one success do NOT count as broken', () => {
    // One bad token failing while others succeed is normal noise, not a systemic break.
    const findings = selfCheck.evaluate({ push_to_start_failed: 2, push_to_start_sent: 6 }, {});
    const f = findings.find(x => x.key === 'push_to_start_broken');
    assert.strictEqual(f.bad, false);
});

test('evaluate: a quiet window (nothing armed) is not an alert', () => {
    const findings = selfCheck.evaluate({ push_to_start_failed: 0, push_to_start_sent: 0 }, {});
    const f = findings.find(x => x.key === 'push_to_start_broken');
    assert.strictEqual(f.bad, false, 'zero attempts is not the same as zero successes out of some attempts');
});

test('evaluate: a repeated APNs error reason crosses the threshold', () => {
    const findings = selfCheck.evaluate({}, { BadDeviceToken: 3 });
    assert.ok(findings.some(f => f.key === 'apns_reason:BadDeviceToken' && f.bad));
});

test('evaluate: a one-off APNs error reason stays below threshold', () => {
    const findings = selfCheck.evaluate({}, { BadDeviceToken: 1 });
    assert.strictEqual(findings.some(f => f.key === 'apns_reason:BadDeviceToken'), false);
});

// ── run(): transitions, cooldown, recovery ──────────────────────────────────

function mockEmail() {
    const sent = [];
    const original = email.send;
    email.send = async (msg) => { sent.push(msg); return { sent: true }; };
    return { sent, restore: () => { email.send = original; } };
}

test('run: alerts once on the transition into "bad", not every tick while it stays bad', async () => {
    selfCheck.stop();
    const mock = mockEmail();
    try {
        await selfCheck.run(); // establishes the baseline snapshot, no diff yet
        require('../services/liveactivity/metrics').inc('push_to_start_failed', 3);
        await selfCheck.run(); // first bad tick -> alert
        await selfCheck.run(); // still bad, same window's worth of failure -> no NEW failures this tick, so no new alert either
        assert.strictEqual(mock.sent.filter(m => m.subject.includes('ALERT')).length, 1);
    } finally {
        mock.restore();
        selfCheck.stop();
    }
});

test('run: emails a recovery once the rule clears', async () => {
    selfCheck.stop();
    const mock = mockEmail();
    const metrics = require('../services/liveactivity/metrics');
    try {
        await selfCheck.run();
        metrics.inc('push_to_start_failed', 2);
        await selfCheck.run(); // bad -> alert
        metrics.inc('push_to_start_sent', 1); // a success arrives, no new failures
        await selfCheck.run(); // recovered -> "OK" email
        const subjects = mock.sent.map(m => m.subject);
        assert.ok(subjects.some(s => s.includes('ALERT')));
        assert.ok(subjects.some(s => s.includes('OK') && s.includes('оправи')));
    } finally {
        mock.restore();
        selfCheck.stop();
    }
});
