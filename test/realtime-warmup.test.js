'use strict';

/**
 * Restart safety. Right after `pm2 restart` the realtime cache is EMPTY for the
 * first poll (server.js fires the poller without awaiting it, then the worker
 * ticks immediately). With no feed data, contentState.build() falls back to the
 * SCHEDULED arrival, so the first tick could:
 *   - send an 'end' event to a late train whose scheduled arrival had already
 *     passed and delete its token — the Live Activity was gone for good;
 *   - push an update with no delayMinutes, blanking the delay on the card;
 *   - (armedWatcher) auto-stop a journey more than 45 min late, off the
 *     scheduled arrival.
 * realtimeGate.js holds real-train work until the cache has a FRESH trip feed,
 * with a bounded grace so a dead feed cannot freeze tracking forever.
 *
 * The same "no data is not evidence of arrival" rule covers a feed that goes
 * STALE mid-journey (it is 3 minutes old and cache.getTrain() starts returning
 * null): a late train's card is not ended and its journey not auto-stopped —
 * but only until 90 min past its own scheduled arrival, never for ever.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-warmup-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);
process.env.REALTIME = 'on';

const Database     = require('better-sqlite3');
const cache        = require('../services/realtime/cache');
const store        = require('../services/liveactivity/store');
const armedStore   = require('../services/liveactivity/armedStore');
const apns         = require('../services/liveactivity/apns');
const testFeed     = require('../services/liveactivity/testFeed');
const gate         = require('../services/liveactivity/realtimeGate');
const worker       = require('../services/liveactivity/worker');
const armedWatcher = require('../services/liveactivity/armedWatcher');

const INSTALL = 'install-warmup-test01';
const hexToken = (c) => String(c).repeat(64).slice(0, 64);
const MIN = 60 * 1000;

function mockApns() {
    const calls = [];
    const orig = { send: apns.send, sendAll: apns.sendAll, isConfigured: apns.isConfigured };
    apns.isConfigured = () => true;
    apns.send = async (args) => { calls.push(args); return { outcome: 'ok', status: 200 }; };
    apns.sendAll = (tasks) => Promise.all(tasks.map(t => t()));
    return { calls, restore: () => Object.assign(apns, orig) };
}

const bodyOf = (call) => JSON.parse(call.body).aps;

function register(token, train, { depOffsetMs, arrOffsetMs }) {
    store.upsert({
        token, environment: 'sandbox', journey_id: `j-${token.slice(0, 6)}`,
        train_number: train,
        boarding_station: 'Board', destination_station: 'End', direction_station: null,
        scheduled_departure: new Date(Date.now() + depOffsetMs).toISOString(),
        scheduled_arrival:   new Date(Date.now() + arrOffsetMs).toISOString(),
        current_leg_index: 0, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    });
}

/** A card the worker has already pushed to once, showing a 15-min delay. */
function markAlreadyPushedWithDelay(token, delayMin) {
    store.markPushed(token, { delayMin, nextStop: 'End', contentHash: 'old-hash', phase: 'inTransit', progress: 0.5 });
    // Past the per-token throttle, so a push is decided on its merits alone.
    const db = new Database(TMP);
    db.prepare('UPDATE live_activity_tokens SET last_pushed_at = ? WHERE token = ?')
        .run(new Date(Date.now() - 5 * MIN).toISOString(), token);
    db.close();
}

/** Two stops, both running `delaySec` late; arrival is `arrInMs` from now. */
function feedTrip(delaySec, arrInMs) {
    const nowSec = Math.floor(Date.now() / 1000);
    return { tripId: 'trip-warmup', stops: [
        { station: 'Board', arrivalTime: nowSec - 30 * 60 + delaySec, departureTime: nowSec - 28 * 60 + delaySec,
          arrivalDelay: delaySec, departureDelay: delaySec },
        { station: 'End', arrivalTime: nowSec + Math.floor(arrInMs / 1000), departureTime: null,
          arrivalDelay: delaySec, departureDelay: null },
    ] };
}

const emptyCache = () => cache.setTrips(new Map(), 0);
const loadCache = (train, trip) => cache.setTrips(new Map([[train, [trip]]]), Date.now());

test.beforeEach(() => { emptyCache(); gate._reset(); });
test.afterEach(() => {
    emptyCache();
    testFeed.clearAll();
    for (const r of store.listActive()) store.remove(r.token);
});

// ── (a) the Live Activity must not be ended off the scheduled arrival ────────

test('empty cache + late train past its SCHEDULED arrival: no end push, token kept', async () => {
    const token = hexToken('a');
    // Scheduled to arrive 30 min ago — the train is really 45 min late, so it
    // has not arrived. Only the (missing) feed knows that.
    register(token, '9101', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });

    const mock = mockApns();
    try {
        const r = await worker.tick();
        assert.strictEqual(r.sent, 0);
    } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 0, 'nothing may be pushed while the cache is cold');
    assert.ok(store.getByToken(token), 'the token must survive so the next tick can update the card');
});

// ── (b) the delay must not be blanked ────────────────────────────────────────

test('empty cache + started leg that had a delay: no update push blanking it', async () => {
    const token = hexToken('b');
    register(token, '9102', { depOffsetMs: -60 * MIN, arrOffsetMs: 60 * MIN });
    markAlreadyPushedWithDelay(token, 15);

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 0, 'an update built from no data would drop delayMinutes');
    assert.strictEqual(store.getByToken(token).last_delay_min, 15, 'bookkeeping still describes what the card shows');
});

// ── (c) once the cache has data, nothing changes ─────────────────────────────

test('once the cache has data the same late train is updated WITH its delay, not ended', async () => {
    const token = hexToken('c');
    register(token, '9103', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    // Feed says: 45 min late, arriving in 15 min.
    loadCache('9103', feedTrip(45 * 60, 15 * MIN));

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 1);
    const aps = bodyOf(mock.calls[0]);
    assert.strictEqual(aps.event, 'update');
    assert.strictEqual(aps['content-state'].delayMinutes, 45);
    assert.strictEqual(aps['content-state'].isDelayed, true);
    assert.ok(store.getByToken(token));
});

test('once the cache has data a train that really has arrived is still ended', async () => {
    const token = hexToken('d');
    register(token, '9104', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    // Feed says: arrived 20 min ago (10 min past the end threshold).
    loadCache('9104', feedTrip(0, -20 * MIN));

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(bodyOf(mock.calls[0]).event, 'end');
    assert.strictEqual(store.getByToken(token), null);
});

test('a feed that loaded but does not list this train behaves as before (scheduled fallback)', async () => {
    const token = hexToken('e');
    register(token, '9105', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    loadCache('some-other-train', feedTrip(0, 10 * MIN));   // cache is populated, just not with our train

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(bodyOf(mock.calls[0]).event, 'end');
});

// ── (d) a dead feed must not freeze tracking forever ─────────────────────────

test('grace expiry: with the feed still dead, a journey long past its arrival is finally treated as over', async () => {
    const token = hexToken('f');
    // Scheduled to arrive 105 min ago: beyond the stale-feed bound (90 min) but
    // still inside the 2 h after which a token is pruned from the active list.
    register(token, '9106', { depOffsetMs: -5 * 60 * MIN, arrOffsetMs: -105 * MIN });

    const mock = mockApns();
    try {
        // Just inside the grace: still held.
        await worker.tick(new Date(Date.now() + gate.WARMUP_GRACE_MS - 5000));
        assert.strictEqual(mock.calls.length, 0);
        assert.ok(store.getByToken(token));

        // Just past it: the feed is presumed dead and the worker carries on as it always did.
        await worker.tick(new Date(Date.now() + gate.WARMUP_GRACE_MS + 5000));
        assert.strictEqual(mock.calls.length, 1);
        assert.strictEqual(bodyOf(mock.calls[0]).event, 'end');
    } finally { mock.restore(); }
});

test('the hold releases as soon as the first trip feed lands, well inside the grace', async () => {
    const token = hexToken('1');
    register(token, '9107', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });

    const mock = mockApns();
    try {
        await worker.tick();
        assert.strictEqual(mock.calls.length, 0, 'held while cold');

        loadCache('9107', feedTrip(45 * 60, 15 * MIN));
        await worker.tick();
        assert.strictEqual(mock.calls.length, 1);
        assert.strictEqual(bodyOf(mock.calls[0]).event, 'update');
    } finally { mock.restore(); }
});

// ── unchanged where it must be ───────────────────────────────────────────────

test('REALTIME off: the gate is inert (behaviour is exactly as before)', async () => {
    const token = hexToken('2');
    register(token, '9108', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });

    process.env.REALTIME = 'off';
    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); process.env.REALTIME = 'on'; }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(bodyOf(mock.calls[0]).event, 'end');
});

test('TEST- trains use testFeed, not the cache, so a cold cache does not hold them', async () => {
    const token = hexToken('3');
    register(token, 'TEST-WARMUP-1', { depOffsetMs: -60 * MIN, arrOffsetMs: 60 * MIN });
    testFeed.set('TEST-WARMUP-1', { trip: feedTrip(10 * 60, 30 * MIN) });

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(bodyOf(mock.calls[0])['content-state'].delayMinutes, 10);
});

test('only the cold real train is held; a TEST- train in the same tick still goes out', async () => {
    const real = hexToken('4'), synth = hexToken('5');
    register(real,  '9109', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    register(synth, 'TEST-WARMUP-2', { depOffsetMs: -60 * MIN, arrOffsetMs: 60 * MIN });
    testFeed.set('TEST-WARMUP-2', { trip: feedTrip(10 * 60, 30 * MIN) });

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].token, synth);
    assert.ok(store.getByToken(real), 'the real train\'s card is untouched');
});

// ── armedWatcher: must not auto-stop off the scheduled arrival ───────────────

function armStarted(journeyId, train, { depOffsetMs, arrOffsetMs }) {
    armedStore.arm({
        install_id: INSTALL, journey_id: journeyId, leg_index: 0,
        train_number: train, boarding_station: 'Board', destination_station: 'End',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + depOffsetMs).toISOString(),
        scheduled_arrival:   new Date(Date.now() + arrOffsetMs).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    const row = armedStore.listActive().find(r => r.journey_id === journeyId);
    armedStore.markStarted(row.id);
    return row.id;
}

// Scheduled arrival 50 min ago is past scheduled+45min, so with no feed the
// deadline rule stops the journey; a live feed showing it 70 min late would not.
test('armedWatcher: empty cache does not auto-stop a journey that is >45 min late', async () => {
    const id = armStarted('j-warmup-armed-1', '9201', { depOffsetMs: -4 * 60 * MIN, arrOffsetMs: -50 * MIN });

    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }

    assert.strictEqual(armedStore.getById(id).state, 'started', 'must not be stopped on scheduled times alone');
    armedStore.disarm(INSTALL, 'j-warmup-armed-1', null);
});

test('armedWatcher: with feed data the same journey is judged on its predicted arrival', async () => {
    const id = armStarted('j-warmup-armed-2', '9202', { depOffsetMs: -4 * 60 * MIN, arrOffsetMs: -50 * MIN });
    loadCache('9202', feedTrip(70 * 60, 20 * MIN));   // 70 min late, arriving in 20 min

    const mock = mockApns();
    try { await armedWatcher.tick(); } finally { mock.restore(); }

    assert.strictEqual(armedStore.getById(id).state, 'started');
    armedStore.disarm(INSTALL, 'j-warmup-armed-2', null);
});

test('armedWatcher: grace expiry with the feed still dead, a journey long past its arrival is stopped', async () => {
    const id = armStarted('j-warmup-armed-3', '9203', { depOffsetMs: -5 * 60 * MIN, arrOffsetMs: -120 * MIN });

    const mock = mockApns();
    try {
        await armedWatcher.tick(new Date(Date.now() + gate.WARMUP_GRACE_MS - 5000));
        assert.strictEqual(armedStore.getById(id).state, 'started');

        await armedWatcher.tick(new Date(Date.now() + gate.WARMUP_GRACE_MS + 5000));
        assert.strictEqual(armedStore.getById(id).state, 'stopped', 'a dead feed must not freeze the watcher forever');
    } finally {
        mock.restore();
        armedStore.disarm(INSTALL, 'j-warmup-armed-3', null);
    }
});


// ══════════════════════════════════════════════════════════════════════════════
// A feed that is present but STALE (mid-journey, or loaded with an old stamp)
// ══════════════════════════════════════════════════════════════════════════════

const STALE_AGE_MS = 10 * MIN;                            // > the cache's 3 min freshness
const afterWarmup = () => new Date(Date.now() + gate.WARMUP_GRACE_MS + 5000);
/** The feed DID arrive — it is just old, so cache.getTrain() returns null. */
const staleCache = (train = '0000') => cache.setTrips(new Map([[train, [feedTrip(0, 10 * MIN)]]]), Date.now() - STALE_AGE_MS);

test('a feed that landed but is already stale does NOT release the warm-up hold', async () => {
    const token = hexToken('6');
    register(token, '9301', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    staleCache();
    assert.notStrictEqual(cache.status().tripFeedTs, null, 'precondition: a feed HAS arrived (the old "ever landed" test would release)');
    assert.strictEqual(cache.status().tripFresh, false);

    const mock = mockApns();
    try { await worker.tick(); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 0);
    assert.ok(store.getByToken(token));
});

test('stale feed mid-journey: a late train is NOT ended and its token stays', async () => {
    const token = hexToken('7');
    // Scheduled to arrive 30 min ago; really running late. The feed has gone stale.
    register(token, '9302', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    staleCache();

    const mock = mockApns();
    try { await worker.tick(afterWarmup()); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 0, 'no end, no update, while the data is missing');
    assert.ok(store.getByToken(token), 'the card must survive');
});

test('stale feed mid-journey: the delay on the card is not blanked', async () => {
    const token = hexToken('8');
    register(token, '9303', { depOffsetMs: -60 * MIN, arrOffsetMs: 60 * MIN });
    markAlreadyPushedWithDelay(token, 15);
    staleCache();

    const mock = mockApns();
    try { await worker.tick(afterWarmup()); } finally { mock.restore(); }

    assert.strictEqual(mock.calls.length, 0);
    assert.strictEqual(store.getByToken(token).last_delay_min, 15);
});

test('the stale hold is BOUNDED: inside 90 min past the scheduled arrival held, beyond it ended', async () => {
    const inside = hexToken('9'), beyond = hexToken('A');
    register(inside, '9304', { depOffsetMs: -6 * 60 * MIN, arrOffsetMs: -80 * MIN });   // 80 min past — still held
    register(beyond, '9305', { depOffsetMs: -6 * 60 * MIN, arrOffsetMs: -100 * MIN });  // 100 min past — over the bound
    staleCache();

    const mock = mockApns();
    try { await worker.tick(afterWarmup()); } finally { mock.restore(); }

    assert.ok(store.getByToken(inside), 'held: still within the bound');
    assert.strictEqual(store.getByToken(beyond), null, 'not held for ever: past the bound the journey is treated as over');
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(bodyOf(mock.calls[0]).event, 'end');
    assert.strictEqual(mock.calls[0].token, beyond);
});

test('when the feed comes back the held train is updated with its real delay, not ended', async () => {
    const token = hexToken('B');
    register(token, '9306', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    staleCache('9306');

    const mock = mockApns();
    try {
        await worker.tick(afterWarmup());
        assert.strictEqual(mock.calls.length, 0, 'held while stale');

        loadCache('9306', feedTrip(45 * 60, 15 * MIN));   // fresh again: 45 min late, arriving in 15
        await worker.tick(afterWarmup());
        assert.strictEqual(mock.calls.length, 1);
        assert.strictEqual(bodyOf(mock.calls[0]).event, 'update');
        assert.strictEqual(bodyOf(mock.calls[0])['content-state'].delayMinutes, 45);
    } finally { mock.restore(); }
    assert.ok(store.getByToken(token));
});

test('stale feed: TEST- trains and REALTIME=off are not held', async () => {
    const synth = hexToken('C'), real = hexToken('D');
    register(synth, 'TEST-STALE-1', { depOffsetMs: -60 * MIN, arrOffsetMs: 60 * MIN });
    testFeed.set('TEST-STALE-1', { trip: feedTrip(10 * 60, 30 * MIN) });
    register(real, '9307', { depOffsetMs: -3 * 60 * MIN, arrOffsetMs: -30 * MIN });
    staleCache();

    let mock = mockApns();
    try { await worker.tick(afterWarmup()); } finally { mock.restore(); }
    assert.strictEqual(mock.calls.length, 1, 'only the synthetic train goes out');
    assert.strictEqual(mock.calls[0].token, synth);

    process.env.REALTIME = 'off';
    mock = mockApns();
    try { await worker.tick(afterWarmup()); } finally { mock.restore(); process.env.REALTIME = 'on'; }
    assert.ok(mock.calls.some(c => c.token === real && bodyOf(c).event === 'end'), 'REALTIME off = exactly the old behaviour');
});

// ── the pure decision ────────────────────────────────────────────────────────

test('gate.holds: the arrival argument is what switches the stale-feed hold on', () => {
    staleCache();
    const now = afterWarmup().getTime();
    const arrivedAgo = (min) => new Date(Date.now() - min * MIN).toISOString();

    assert.strictEqual(gate.holds('9401', now), false, 'no arrival given: only the warm-up hold applies');
    assert.strictEqual(gate.holds('9401', now, arrivedAgo(30)), true, 'stale feed, 30 min past arrival: held');
    assert.strictEqual(gate.holds('9401', now, arrivedAgo(200)), false, 'far past arrival: not held');
    assert.strictEqual(gate.holds('9401', now, 'not-a-date'), false, 'an unreadable time never freezes anything');

    loadCache('9401', feedTrip(0, 10 * MIN));
    assert.strictEqual(gate.holds('9401', now, arrivedAgo(30)), false, 'fresh feed: never held');
});

// ── armedWatcher under a stale feed ──────────────────────────────────────────

test('armedWatcher: a stale feed does not auto-stop a journey that is late, but only up to the bound', async () => {
    const held   = armStarted('j-stale-armed-1', '9501', { depOffsetMs: -4 * 60 * MIN, arrOffsetMs: -50 * MIN });
    const beyond = armStarted('j-stale-armed-2', '9502', { depOffsetMs: -6 * 60 * MIN, arrOffsetMs: -100 * MIN });
    staleCache();

    const mock = mockApns();
    try { await armedWatcher.tick(afterWarmup()); } finally { mock.restore(); }

    assert.strictEqual(armedStore.getById(held).state, 'started', 'held while the feed is stale');
    assert.strictEqual(armedStore.getById(beyond).state, 'stopped', 'not held for ever');
    armedStore.disarm(INSTALL, 'j-stale-armed-1', null);
    armedStore.disarm(INSTALL, 'j-stale-armed-2', null);
});

test('armedWatcher: a stale feed does NOT stop a card from starting on schedule', async () => {
    armedStore.registerDevice({ installId: INSTALL, token: hexToken('E'), kind: 'push_to_start', environment: 'sandbox' });
    armedStore.arm({
        install_id: INSTALL, journey_id: 'j-stale-start', leg_index: 0,
        train_number: '9503', boarding_station: 'София', destination_station: 'Пловдив',
        direction_station: null,
        scheduled_departure: new Date(Date.now() + 10 * MIN).toISOString(),
        scheduled_arrival:   new Date(Date.now() + 100 * MIN).toISOString(),
        is_current_bus: 0, next_transport_number: null,
        next_transport_departure: null, is_next_transport_bus: 0,
        now: armedStore.nowIso(),
    });
    staleCache();

    const mock = mockApns();
    try { await armedWatcher.tick(afterWarmup()); } finally { mock.restore(); }

    assert.ok(mock.calls.some(c => c.pushType === 'liveactivity'), 'the start push must still go out on schedule');
    assert.strictEqual(armedStore.listActive().find(r => r.journey_id === 'j-stale-start').state, 'started');
    armedStore.disarm(INSTALL, 'j-stale-start', null);
});
