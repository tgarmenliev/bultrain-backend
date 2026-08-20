'use strict';

/**
 * Unit tests for the Live Activity pipeline.
 *
 * Uses Node's built-in test runner (node --test) — no new dependency. Run with
 * `npm test`, which is also what CI runs.
 *
 * The four areas covered are the ones where a mistake is invisible: the 2001
 * reference date, the change-detection predicate that governs all push volume,
 * the segment-progress maths, and the pruning rules.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// Point the store at a throwaway database BEFORE requiring it.
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-la-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP_DB;

const contentState = require('../services/liveactivity/contentState');
const worker       = require('../services/liveactivity/worker');

// ── 1. The 2001 reference date ───────────────────────────────────────────────

test('dates use the Swift reference epoch (2001-01-01), as numbers', async (t) => {
    await t.test('the epoch itself maps to zero', () => {
        assert.strictEqual(contentState.toSwiftDate(978307200), 0);
    });

    await t.test('offsets are preserved', () => {
        assert.strictEqual(contentState.toSwiftDate(978307200 + 3600), 3600);
    });

    await t.test('a real timestamp converts correctly', () => {
        const unix = Math.floor(Date.UTC(2026, 6, 23, 13, 44, 0) / 1000);
        assert.strictEqual(contentState.toSwiftDate(unix), unix - 978307200);
    });

    await t.test('round-trips', () => {
        const unix = 1784586416;
        assert.strictEqual(contentState.fromSwiftDate(contentState.toSwiftDate(unix)), unix);
    });

    await t.test('null stays null (so the field can be omitted)', () => {
        assert.strictEqual(contentState.toSwiftDate(null), null);
    });

    await t.test('emitted as a JSON number, never a string or ISO date', () => {
        const row = makeRow();
        const { state } = contentState.build(row, null, new Date('2026-07-23T13:00:00Z'));
        assert.strictEqual(typeof state.lastUpdated, 'number');
        const parsed = JSON.parse(JSON.stringify(state));
        assert.strictEqual(typeof parsed.lastUpdated, 'number');
    });
});

// ── 2. Change detection, including the threshold in both directions ──────────

const pushed = (over) => makeRow({ last_pushed_at: '2026-07-23T13:00:00.000Z', ...over });
const meta = (over) => ({ delayMinutes: 0, nextStop: 'Пловдив', phase: 'inTransit', ...over });

test('change detection governs push volume', async (t) => {
    await t.test('a token that has never been pushed always sends', () => {
        const d = worker.hasChanged(makeRow({ last_pushed_at: null }), meta());
        assert.strictEqual(d.changed, true);
        assert.strictEqual(d.reason, 'initial');
    });

    await t.test('nothing changed ⇒ no push', () => {
        const row = pushed({ last_delay_min: 4, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        assert.strictEqual(worker.hasChanged(row, meta({ delayMinutes: 4 })).changed, false);
    });

    await t.test('a phase flip is urgent', () => {
        const row = pushed({ last_phase: 'preDeparture', last_delay_min: 0, last_next_stop: 'Пловдив' });
        const d = worker.hasChanged(row, meta({ phase: 'inTransit' }));
        assert.strictEqual(d.changed, true);
        assert.strictEqual(d.reason, 'phase');
        assert.strictEqual(d.priority, 10);
    });

    await t.test('crossing the 2-minute line upward (on time → delayed)', () => {
        const row = pushed({ last_delay_min: 1, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        const d = worker.hasChanged(row, meta({ delayMinutes: 3 }));
        assert.strictEqual(d.changed, true);
        assert.strictEqual(d.reason, 'delay-threshold');
    });

    await t.test('crossing the 2-minute line downward (delayed → on time)', () => {
        const row = pushed({ last_delay_min: 3, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        const d = worker.hasChanged(row, meta({ delayMinutes: 1 }));
        assert.strictEqual(d.changed, true, 'recovering to on time must also push');
        assert.strictEqual(d.reason, 'delay-threshold');
    });

    await t.test('a 1-minute wobble below the threshold is ignored', () => {
        const row = pushed({ last_delay_min: 0, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        assert.strictEqual(worker.hasChanged(row, meta({ delayMinutes: 1 })).changed, false);
    });

    await t.test('a 1-minute wobble above the threshold is also ignored', () => {
        const row = pushed({ last_delay_min: 5, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        assert.strictEqual(worker.hasChanged(row, meta({ delayMinutes: 6 })).changed, false);
    });

    await t.test('a 2-minute move pushes', () => {
        const row = pushed({ last_delay_min: 5, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        const d = worker.hasChanged(row, meta({ delayMinutes: 7 }));
        assert.strictEqual(d.changed, true);
        assert.strictEqual(d.reason, 'delay');
        assert.strictEqual(d.priority, 5, 'ordinary drift must not burn the urgent budget');
    });

    await t.test('a large jump is urgent', () => {
        const row = pushed({ last_delay_min: 5, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        const d = worker.hasChanged(row, meta({ delayMinutes: 20 }));
        assert.strictEqual(d.reason, 'delay-jump');
        assert.strictEqual(d.priority, 10);
    });

    await t.test('delay information appearing or vanishing pushes', () => {
        const gained = pushed({ last_delay_min: null, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        assert.strictEqual(worker.hasChanged(gained, meta({ delayMinutes: 4 })).reason, 'delay-availability');

        const lost = pushed({ last_delay_min: 4, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        assert.strictEqual(worker.hasChanged(lost, meta({ delayMinutes: null })).reason, 'delay-availability');
    });

    await t.test('reaching the next stop pushes', () => {
        const row = pushed({ last_delay_min: 0, last_next_stop: 'Пловдив', last_phase: 'inTransit' });
        const d = worker.hasChanged(row, meta({ nextStop: 'Стара Загора' }));
        assert.strictEqual(d.changed, true);
        assert.strictEqual(d.reason, 'next-stop');
    });

    // The bar has to follow a moving train between two distant stops, where no
    // other signal fires — but must NOT fire for a train standing still, which
    // is what a fixed timer would do.
    await t.test('progress moving visibly pushes, at priority 5', () => {
        const base = { last_delay_min: 0, last_next_stop: 'Пловдив', last_phase: 'inTransit' };
        const row = pushed({ ...base, last_progress: 0.40 });

        const still = worker.hasChanged(row, meta({ progress: 0.405 }));
        assert.strictEqual(still.changed, false, '0.5% is not worth waking the phone');

        const moved = worker.hasChanged(row, meta({ progress: 0.44 }));
        assert.strictEqual(moved.changed, true);
        assert.strictEqual(moved.reason, 'progress');
        assert.strictEqual(moved.priority, 5, 'priority 10 is metered; the bar must not spend that budget');
    });

    await t.test('a GPS-tracked card gets a heartbeat; a fed one does not need it', () => {
        const base = { last_delay_min: 0, last_next_stop: 'Пловдив', last_phase: 'inTransit', last_progress: 0.4 };
        const stale = makeRow({ ...base, last_pushed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() });

        const gps = worker.hasChanged(stale, meta({ progress: 0.4, isGPSTracked: true }));
        assert.strictEqual(gps.reason, 'gps-heartbeat');
        assert.strictEqual(gps.priority, 5);

        const fed = worker.hasChanged(stale, meta({ progress: 0.4, isGPSTracked: false }));
        assert.strictEqual(fed.changed, false, 'a train with a feed has its own events');

        const recent = makeRow({ ...base, last_pushed_at: new Date(Date.now() - 60 * 1000).toISOString() });
        assert.strictEqual(worker.hasChanged(recent, meta({ progress: 0.4, isGPSTracked: true })).changed, false);
    });

    await t.test('no stored progress means no basis for comparison, not zero', () => {
        const row = pushed({ last_delay_min: 0, last_next_stop: 'Пловдив', last_phase: 'inTransit', last_progress: null });
        assert.strictEqual(worker.hasChanged(row, meta({ progress: 0.9 })).changed, false);
    });
});

// ── 3. Segment progress ──────────────────────────────────────────────────────

test('progress covers the passenger segment, not the whole train', async (t) => {
    const nowSec = 1_800_000_000;
    // Six stops; the passenger boards at index 1 and alights at index 5.
    const stops = [
        { station: 'София',        arrivalTime: nowSec - 5000 },
        { station: 'Пловдив',      arrivalTime: nowSec - 4000 },
        { station: 'Димитровград', arrivalTime: nowSec - 3000 },
        { station: 'Стара Загора', arrivalTime: nowSec - 2000 },
        { station: 'Сливен',       arrivalTime: nowSec + 1000 },
        { station: 'Бургас',       arrivalTime: nowSec + 2000 },
    ];

    await t.test('counts passed stops within the segment', () => {
        // Segment 1→5 is four hops; two of them (idx 2, 3) are behind us.
        const p = contentState.computeProgress({ stops, bIdx: 1, dIdx: 5, nowSec });
        assert.strictEqual(p, 0.5);
    });

    await t.test('is 0 before the segment starts moving', () => {
        const p = contentState.computeProgress({ stops, bIdx: 4, dIdx: 5, nowSec });
        assert.strictEqual(p, 0);
    });

    await t.test('is 1 once the destination is behind us', () => {
        const p = contentState.computeProgress({ stops, bIdx: 0, dIdx: 3, nowSec });
        assert.strictEqual(p, 1);
    });

    await t.test('falls back to the clock when the feed does not cover the stops', () => {
        const p = contentState.computeProgress({
            stops: null, bIdx: -1, dIdx: -1, nowSec,
            schedDepSec: nowSec - 1000, schedArrSec: nowSec + 1000,
        });
        assert.ok(Math.abs(p - 0.5) < 0.001, `expected ~0.5, got ${p}`);
    });

    await t.test('stays clamped to 0…1', () => {
        const late = contentState.computeProgress({
            stops: null, bIdx: -1, dIdx: -1, nowSec,
            schedDepSec: nowSec - 10000, schedArrSec: nowSec - 5000,
        });
        assert.strictEqual(late, 1);
    });

    await t.test('geometry segment progress is scoped to boarding→destination', () => {
        // Straight west→east line; five stops A..E evenly spaced.
        const geoStops = [
            { name: 'A', lat: 42.0, lon: 25.00 },
            { name: 'B', lat: 42.0, lon: 25.10 },
            { name: 'C', lat: 42.0, lon: 25.20 },
            { name: 'D', lat: 42.0, lon: 25.30 },
            { name: 'E', lat: 42.0, lon: 25.40 },
        ];
        const shape = geoStops.map(s => ({ lat: s.lat, lon: s.lon }));
        const call = (lon) => contentState.geometrySegmentProgress({
            geoStops, shape, vehicle: { lat: 42.0, lon }, boardingName: 'B', destName: 'D',
        });

        // A passenger riding B→D: at C (the midpoint of that segment) → ~0.5,
        // NOT ~0.5 of the whole A→E route by coincidence — check the ends too.
        assert.ok(Math.abs(call(25.20) - 0.5) < 0.02, `mid-segment ${call(25.20)}`);
        assert.ok(call(25.10) < 0.02, 'at boarding B → ~0');
        assert.ok(call(25.30) > 0.98, 'at destination D → ~1');
        // Standing at A (before boarding) clamps to 0, does not go negative.
        assert.strictEqual(call(25.00), 0);
    });

    await t.test('geometry progress returns null when the position is off the route', () => {
        const geoStops = [{ name: 'A', lat: 42.0, lon: 25.0 }, { name: 'B', lat: 42.0, lon: 25.4 }];
        const p = contentState.geometrySegmentProgress({
            geoStops, shape: [], vehicle: { lat: 43.0, lon: 25.2 }, boardingName: 'A', destName: 'B',
        });
        assert.strictEqual(p, null, 'a position 100+ km off the line must not yield progress');
    });

    await t.test('build prefers geometry progress over the clock when a position exists', () => {
        const row = makeRow({ boarding_station: 'B', destination_station: 'D' });
        const geo = { stops: [
            { name: 'A', lat: 42.0, lon: 25.00 }, { name: 'B', lat: 42.0, lon: 25.10 },
            { name: 'C', lat: 42.0, lon: 25.20 }, { name: 'D', lat: 42.0, lon: 25.30 },
        ], shape: [] };
        const vehicle = { lat: 42.0, lon: 25.20 }; // at C, midway B→D
        const { state } = contentState.build(row, null, new Date('2026-07-23T13:00:00Z'), vehicle, geo);
        assert.ok(Math.abs(state.progressPercentage - 0.5) < 0.02, `geometry-based ${state.progressPercentage}`);
    });

    await t.test('matches stations tolerantly (dashes, dots, case)', () => {
        const list = [{ station: 'Ловеч - Север' }, { station: 'Вр.депо Пловдив' }];
        assert.strictEqual(contentState.findStopIndex(list, 'Ловеч-север'), 0);
        assert.strictEqual(contentState.findStopIndex(list, 'вр депо пловдив'), 1);
    });
});

// ── 4. The content-state contract (silent-failure guard) ─────────────────────

test('content-state satisfies the Swift decoder', async (t) => {
    const MANDATORY = [
        'progressPercentage', 'isDelayed', 'lastUpdated', 'phase',
        'directionStation', 'currentLegIndex', 'isNextTransportBus', 'isCurrentTransportBus',
    ];

    await t.test('every mandatory field is present even with no feed at all', () => {
        const { state } = contentState.build(makeRow(), null, new Date('2026-07-23T13:00:00Z'));
        for (const key of MANDATORY) {
            assert.ok(key in state, `missing mandatory field: ${key}`);
            assert.notStrictEqual(state[key], null, `${key} must never be null`);
        }
    });

    await t.test('unknown optionals are omitted, not null', () => {
        const { state } = contentState.build(makeRow(), null, new Date('2026-07-23T13:00:00Z'));
        for (const key of ['delayMinutes', 'predictedDeparture', 'predictedArrival', 'nextTransportNumber']) {
            assert.ok(!(key in state), `${key} should be omitted when unknown`);
        }
    });

    await t.test('isDelayed follows the 2-minute rule', () => {
        const now = new Date('2026-07-23T13:00:00Z');
        const nowSec = Math.floor(now.getTime() / 1000);
        const rt = (delaySec) => ({
            stops: [
                { station: 'София',   arrivalTime: nowSec - 100, arrivalDelay: delaySec },
                { station: 'Пловдив', arrivalTime: nowSec + 900, arrivalDelay: delaySec },
            ],
        });
        assert.strictEqual(contentState.build(makeRow(), rt(60), now).state.isDelayed, false, '1 min is on time');
        assert.strictEqual(contentState.build(makeRow(), rt(120), now).state.isDelayed, true, '2 min is delayed');
    });

    await t.test('isGPSTracked is set only when a position exists without a feed', () => {
        const now = new Date('2026-07-23T13:00:00Z');
        const nowSec = Math.floor(now.getTime() / 1000);
        const feed = { stops: [{ station: 'София', arrivalTime: nowSec + 900, arrivalDelay: 0 }] };
        const vehicle = { lat: 42.7, lon: 23.3, bearing: 90 };

        // Position but no feed → GPS-tracked.
        const gps = contentState.build(makeRow(), null, now, vehicle).state;
        assert.strictEqual(gps.isGPSTracked, true, 'position-only train must be flagged');

        // Has a feed → omitted (never claim GPS-only when we have real delay data).
        const withFeed = contentState.build(makeRow(), feed, now, vehicle).state;
        assert.ok(!('isGPSTracked' in withFeed), 'a fed train must not be flagged GPS-tracked');

        // Neither feed nor position → omitted (optional, never null/false).
        const neither = contentState.build(makeRow(), null, now, null).state;
        assert.ok(!('isGPSTracked' in neither), 'omit when there is no position either');
    });

    await t.test('phase is preDeparture before the scheduled departure', () => {
        const row = makeRow({
            scheduled_departure: '2026-07-23T14:00:00.000Z',
            scheduled_arrival:   '2026-07-23T15:00:00.000Z',
        });
        assert.strictEqual(contentState.build(row, null, new Date('2026-07-23T13:00:00Z')).state.phase, 'preDeparture');
        assert.strictEqual(contentState.build(row, null, new Date('2026-07-23T14:30:00Z')).state.phase, 'inTransit');
    });
});

// ── 5. Pruning rules ─────────────────────────────────────────────────────────

test('token pruning keeps live journeys and drops finished ones', async (t) => {
    // Build the schema in the throwaway database.
    require('../database/migrate')(TMP_DB);
    const store = require('../services/liveactivity/store');

    const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
    const hex = (n) => String(n).repeat(64).slice(0, 64);

    const base = {
        environment: 'sandbox', journey_id: null, train_number: '8611',
        boarding_station: 'София', destination_station: 'Пловдив', direction_station: 'Бургас',
        current_leg_index: 0, is_current_bus: 0,
        next_transport_number: null, next_transport_departure: null, is_next_transport_bus: 0,
    };

    store.upsert({ ...base, token: hex(1), scheduled_departure: iso(-3 * 3600e3), scheduled_arrival: iso(-3 * 3600e3) }); // long done
    store.upsert({ ...base, token: hex(2), scheduled_departure: iso(-90 * 60e3),  scheduled_arrival: iso(-60 * 60e3) });  // 1h ago
    store.upsert({ ...base, token: hex(3), scheduled_departure: iso(-10 * 60e3),  scheduled_arrival: iso(30 * 60e3) });   // running
    store.upsert({ ...base, token: hex(4), scheduled_departure: iso(60 * 60e3),   scheduled_arrival: iso(120 * 60e3) });  // upcoming

    await t.test('active list keeps anything within the 2h grace window', () => {
        const active = store.listActive().map(r => r.token).sort();
        assert.deepStrictEqual(active, [hex(2), hex(3), hex(4)].sort());
    });

    await t.test('pruning removes only journeys finished more than 2h ago', () => {
        assert.strictEqual(store.pruneExpired(), 1);
        assert.strictEqual(store.getByToken(hex(1)), null);
        assert.ok(store.getByToken(hex(2)), 'a journey that ended an hour ago is still worth ending cleanly');
    });

    await t.test('unregistering is idempotent', () => {
        assert.strictEqual(store.remove(hex(3)), 1);
        assert.strictEqual(store.remove(hex(3)), 0, 'removing an unknown token must not throw');
    });

    await t.test('re-registering the same token overwrites its context and resets push state', () => {
        store.upsert({ ...base, token: hex(4), destination_station: 'Варна', scheduled_departure: iso(60 * 60e3), scheduled_arrival: iso(180 * 60e3) });
        store.markPushed(hex(4), { delayMin: 5, nextStop: 'X', contentHash: 'abc', phase: 'inTransit' });
        assert.strictEqual(store.getByToken(hex(4)).last_content_hash, 'abc');

        store.upsert({ ...base, token: hex(4), destination_station: 'Русе', scheduled_departure: iso(60 * 60e3), scheduled_arrival: iso(180 * 60e3) });
        const row = store.getByToken(hex(4));
        assert.strictEqual(row.destination_station, 'Русе');
        assert.strictEqual(row.last_content_hash, null, 'stale push bookkeeping must not survive a re-registration');
    });
});

// ── 5. Token-shape validation ────────────────────────────────────────────────
// The register endpoint once required exactly 64 hex chars — the length of a
// standard device token. ActivityKit push tokens are far longer, so that rule
// silently rejected every real token. These pin the corrected shape.

test('token validation accepts real ActivityKit tokens, not just 64-char ones', async (t) => {
    const { isValidToken } = require('../controllers/liveActivityController');

    await t.test('a long (160-byte) token is accepted', () => {
        assert.strictEqual(isValidToken('a'.repeat(320)), true);
    });
    await t.test('the old 64-char device token still validates', () => {
        assert.strictEqual(isValidToken('a'.repeat(64)), true);
    });
    await t.test('uppercase hex is accepted (app may format with %02X)', () => {
        assert.strictEqual(isValidToken('AbCdEf'.repeat(20)), true);
    });
    await t.test('odd length is rejected (hex comes in byte pairs)', () => {
        assert.strictEqual(isValidToken('a'.repeat(65)), false);
    });
    await t.test('non-hex characters are rejected', () => {
        assert.strictEqual(isValidToken('z'.repeat(64)), false);
        assert.strictEqual(isValidToken(`${'a'.repeat(62)}  `), false);
    });
    await t.test('too short and too long are rejected', () => {
        assert.strictEqual(isValidToken('ab'), false);
        assert.strictEqual(isValidToken('a'.repeat(514)), false);
    });
    await t.test('non-strings are rejected without throwing', () => {
        assert.strictEqual(isValidToken(null), false);
        assert.strictEqual(isValidToken(undefined), false);
        assert.strictEqual(isValidToken(12345678), false);
    });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRow(over = {}) {
    return {
        token: 'a'.repeat(64),
        environment: 'sandbox',
        train_number: '8611',
        boarding_station: 'София',
        destination_station: 'Пловдив',
        direction_station: 'Бургас',
        scheduled_departure: '2026-07-23T12:00:00.000Z',
        scheduled_arrival: '2026-07-23T14:00:00.000Z',
        current_leg_index: 0,
        is_current_bus: 0,
        next_transport_number: null,
        next_transport_departure: null,
        is_next_transport_bus: 0,
        last_pushed_at: null,
        last_delay_min: null,
        last_next_stop: null,
        last_content_hash: null,
        last_phase: null,
        ...over,
    };
}
