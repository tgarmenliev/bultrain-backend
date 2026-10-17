'use strict';

/**
 * Android's own exact alarms run 15-18 minutes late (Doze, vendor battery managers); an FCM
 * high-priority push arrives within seconds. So the server sends, for ANDROID legs only:
 *   - departure_reminder at (scheduled departure - 30 min), once
 *   - start_tracking again at (arrival - 40 min), the arrival being the feed's prediction when
 *     it has one, and again if that prediction moves by more than 10 minutes
 * and says nothing it cannot back: no "on time" without a live report.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-timed-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    st.run(2, 'София', 'Sofia', 42.7, 23.3);
    st.run(3, 'Пловдив', 'Plovdiv', 42.1, 24.7);
    st.run(99, 'Пирдоп', 'Pirdop', 42.7, 24.2);
    db.close();
}

const store   = require('../services/liveactivity/armedStore');
const watcher = require('../services/liveactivity/armedWatcher');
const logic   = require('../services/liveactivity/armedLogic');
const cache   = require('../services/realtime/cache');
const fcm     = require('../services/liveactivity/fcm');
const apns    = require('../services/liveactivity/apns');
const controller = require('../controllers/realtimeController');

const MIN = 60 * 1000;
// БВ 3625: leaves София 16:45 (EEST) = 13:45Z, arrives 90 minutes later
const DEP = Date.parse('2026-10-17T13:45:00Z');
const ARR = DEP + 90 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const unix = (ms) => ms / 1000;
const at = (offsetMin) => new Date(DEP + offsetMin * MIN);

const FCM_TOKEN = 'fMEQFCa9RQyIrPhZ8VkG3H:APA91bF' + 'x7Qm2_-Zk'.repeat(12);
const hex = (c) => String(c).repeat(64).slice(0, 64);

// ── what the phone would have received ───────────────────────────────────────

const sent = [];
fcm.send = async (args) => { sent.push(args); return { outcome: 'ok', status: 200, reason: null }; };
apns.send = async () => ({ outcome: 'ok', status: 200, reason: null });    // never the network
const ofType = (type) => sent.filter(s => s.data.type === type);
const reset = () => { sent.length = 0; };

function armLeg(installId, journeyId, over = {}) {
    store.arm({
        install_id: installId, journey_id: journeyId, leg_index: 0, train_number: '3625',
        train_number_display: 'БВ 3625',
        boarding_station: 'София', destination_station: 'Пирдоп', direction_station: 'Пирдоп',
        scheduled_departure: iso(DEP), scheduled_arrival: iso(ARR),
        app_language: null, ...over,
    });
}
const rowOf = (journeyId) => {
    const db = new Database(TMP, { readonly: true });
    try { return db.prepare('SELECT * FROM armed_journeys WHERE journey_id = ?').get(journeyId); } finally { db.close(); }
};

/** A TripUpdate for 3625: leaves София at DEP+depDelay, arrives Пирдоп at ARR+arrDelay. */
function seedFeed({ depDelayMin = 0, arrDelayMin = 0 } = {}) {
    cache.setTrips(new Map([['3625', [{ tripId: '3625-BV-20261017', stops: [
        { stationId: 2,  station: 'София',   arrivalTime: null, arrivalDelay: null,
          departureTime: unix(DEP) + depDelayMin * 60, departureDelay: depDelayMin * 60, skipped: false },
        { stationId: 3,  station: 'Пловдив', arrivalTime: unix(DEP + 40 * MIN) + arrDelayMin * 60, arrivalDelay: arrDelayMin * 60,
          departureTime: unix(DEP + 42 * MIN) + arrDelayMin * 60, departureDelay: arrDelayMin * 60, skipped: false },
        { stationId: 99, station: 'Пирдоп',  arrivalTime: unix(ARR) + arrDelayMin * 60, arrivalDelay: arrDelayMin * 60,
          departureTime: null, departureDelay: null, skipped: false },
    ] }]]]), Date.now());
    cache.setVehicles(new Map(), Date.now());
}
const noFeed = () => { cache.setTrips(new Map(), Date.now()); cache.setVehicles(new Map(), Date.now()); };

// ── the rules, on their own ──────────────────────────────────────────────────

test('reminder: once, from departure-30 min until 5 min before the train really leaves', () => {
    const row = { scheduled_departure: iso(DEP), reminder_sent_at: null };
    const feed = { predictedDepUnix: null, departed: null };
    const ask = (min, f = feed, r = row) => logic.evaluateDepartureReminder(r, f, at(min));

    assert.deepStrictEqual([ask(-31).shouldSend, ask(-31).reason], [false, 'too-early']);
    assert.deepStrictEqual([ask(-30).shouldSend, ask(-30).reason], [true, 'departure-in-30']);
    assert.strictEqual(ask(-6).shouldSend, true, 'armed late: still worth it with 6 minutes to go');
    assert.strictEqual(ask(-4).reason, 'too-close-to-departure');
    assert.strictEqual(ask(-20, feed, { ...row, reminder_sent_at: iso(DEP - 25 * MIN) }).reason, 'already-sent');
    assert.strictEqual(ask(-20, { predictedDepUnix: null, departed: true }).reason, 'already-departed');
    // a late train: the "too close" test is against when it really leaves, not the schedule
    assert.strictEqual(ask(-2, { predictedDepUnix: unix(DEP + 20 * MIN), departed: false }).shouldSend, true, '18 minutes before it really leaves');
});

test('approach: arrival-40 min, moved arrival, cap, and the cases it must stay quiet', () => {
    const row = (over = {}) => ({
        scheduled_departure: iso(DEP), scheduled_arrival: iso(ARR),
        started_at: iso(DEP - 39 * MIN), approach_sent_at: null, approach_arrival: null, approach_count: 0, ...over,
    });
    const feed = (over = {}) => ({ predictedDepUnix: null, predictedArrUnix: null, departed: true, ...over });
    const ask = (min, r = row(), f = feed()) => logic.evaluateApproach(r, f, at(min));

    assert.deepStrictEqual([ask(49).shouldSend, ask(49).reason], [false, 'too-early']);
    assert.deepStrictEqual([ask(50).shouldSend, ask(50).reason], [true, 'arrival-in-40']);
    assert.strictEqual(ask(91).reason, 'arrival-passed');
    assert.strictEqual(ask(60, row(), feed({ departed: false })).reason, 'not-departed', 'the train has not even left');

    // computed from the PREDICTED arrival when there is one
    assert.strictEqual(ask(55, row(), feed({ predictedArrUnix: unix(ARR + 30 * MIN) })).reason, 'too-early', 'arrives 30 min late: not yet');
    assert.strictEqual(ask(80, row(), feed({ predictedArrUnix: unix(ARR + 30 * MIN) })).shouldSend, true);

    // a leg shorter than the window: the departure start_tracking already covers it
    const short = row({ scheduled_arrival: iso(DEP + 30 * MIN) });
    assert.strictEqual(logic.evaluateApproach(short, feed(), at(-5)).reason, 'leg-shorter-than-window');

    // start_tracking was sent moments ago
    assert.strictEqual(ask(50, row({ started_at: iso(DEP + 45 * MIN) })).reason, 'just-started');

    // already sent: quiet unless the arrival moved by more than 10 minutes
    const sentRow = row({ approach_sent_at: iso(DEP + 50 * MIN), approach_arrival: unix(ARR), approach_count: 1 });
    assert.strictEqual(ask(70, sentRow).reason, 'unchanged');
    assert.strictEqual(ask(70, sentRow, feed({ predictedArrUnix: unix(ARR + 8 * MIN) })).reason, 'unchanged', '8 min is not enough');
    assert.strictEqual(ask(70, sentRow, feed({ predictedArrUnix: unix(ARR - 12 * MIN) })).shouldSend, true, 'recovered 12 min: say so');
    assert.strictEqual(ask(53, sentRow, feed({ predictedArrUnix: unix(ARR - 12 * MIN) })).reason, 'rate-limited', 'never two within 5 minutes');
    assert.strictEqual(ask(70, { ...sentRow, approach_count: 3 }, feed({ predictedArrUnix: unix(ARR - 12 * MIN) })).reason, 'cap');
});

// ── the words ────────────────────────────────────────────────────────────────

test('reminder text: with no report it says "on schedule at HH:MM", never "on time"', () => {
    const row = { train_number: '3625', scheduled_departure: iso(DEP), boarding_station: 'София', direction_station: 'Пирдоп' };
    const t = logic.departureReminderText(row, { delayMin: null, predictedDepUnix: null }, 'БВ 3625', {});
    assert.strictEqual(t.title, 'БВ 3625 към Пирдоп');
    assert.strictEqual(t.body, 'Тръгва от София по разписание в 16:45.');
    assert.doesNotMatch(t.body, /навреме|без закъснение/);
});

test('reminder text: a live report gives the expected time; on time says where that comes from', () => {
    const row = { train_number: '3625', scheduled_departure: iso(DEP), boarding_station: 'София', direction_station: 'Пирдоп' };
    const late = logic.departureReminderText(row, { delayMin: 12, predictedDepUnix: unix(DEP + 12 * MIN) }, 'БВ 3625', {});
    assert.strictEqual(late.body, 'Тръгва от София по разписание в 16:45, очаква се в 16:57 (закъснение 12 минути).');
    const one = logic.departureReminderText(row, { delayMin: 1, predictedDepUnix: unix(DEP + 1 * MIN) }, 'БВ 3625', {});
    assert.match(one.body, /закъснение 1 минута\)/);
    const ok = logic.departureReminderText(row, { delayMin: 0, predictedDepUnix: unix(DEP) }, 'БВ 3625', {});
    assert.strictEqual(ok.body, 'Тръгва от София в 16:45, по данни на живо без закъснение.');
});

test('reminder text: English, with translated names', () => {
    const row = { train_number: '3625', scheduled_departure: iso(DEP), boarding_station: 'София', direction_station: 'Пирдоп' };
    const ctx = { language: 'en', fromDisplay: 'Sofia', directionDisplay: 'Pirdop' };
    assert.deepStrictEqual(logic.departureReminderText(row, { delayMin: null }, 'FT 3625', ctx),
        { title: 'FT 3625 to Pirdop', body: 'Departs Sofia on schedule at 16:45.' });
    assert.strictEqual(logic.departureReminderText(row, { delayMin: 20, predictedDepUnix: unix(DEP + 20 * MIN) }, 'FT 3625', ctx).body,
        'Departs Sofia on schedule at 16:45, expected at 17:05 (20 minutes late).');
});

// ── the whole path: the watcher, with FCM replaced ───────────────────────────

test('an Android leg gets the reminder once, the departure start, and the approach — each at its moment', async () => {
    const IN = 'install-android-timed-1';
    store.registerDevice({ installId: IN, token: FCM_TOKEN, kind: 'fcm', environment: 'n/a', platform: 'android' });
    armLeg(IN, 'j-android');
    seedFeed();                                          // on time, with a live report
    reset();

    await watcher.tick(at(-41));
    assert.strictEqual(sent.length, 0, 'nothing before the window');

    await watcher.tick(at(-39));
    assert.strictEqual(ofType('start_tracking').length, 1, 'the departure start, unchanged');
    assert.strictEqual(ofType('departure_reminder').length, 0, 'not yet: 30 minutes is later');

    await watcher.tick(at(-29));
    const reminders = ofType('departure_reminder');
    assert.strictEqual(reminders.length, 1);
    const r = reminders[0];
    assert.deepStrictEqual(Object.keys(r.data).sort(),
        ['body', 'delayMinutes', 'journeyId', 'legIndex', 'scheduledDeparture', 'title', 'trainNumber', 'type']);
    assert.strictEqual(r.data.journeyId, 'j-android');
    assert.strictEqual(r.data.legIndex, 0);
    assert.strictEqual(r.data.trainNumber, '3625');
    assert.strictEqual(r.data.scheduledDeparture, iso(DEP));
    assert.strictEqual(r.data.delayMinutes, 0);
    assert.strictEqual(r.data.title, 'БВ 3625 към Пирдоп');
    assert.strictEqual(r.data.body, 'Тръгва от София в 16:45, по данни на живо без закъснение.');
    assert.ok(r.ttlSeconds > 0 && r.ttlSeconds <= 30 * 60, 'a reminder that cannot be delivered soon is dropped, not delivered late');
    assert.ok(rowOf('j-android').reminder_sent_at);

    reset();
    await watcher.tick(at(-28));
    await watcher.tick(at(-20));
    assert.strictEqual(ofType('departure_reminder').length, 0, 'once');

    // the app re-arms the same leg on every start: that must not repeat the reminder
    armLeg(IN, 'j-android');
    await watcher.tick(at(-15));
    assert.strictEqual(ofType('departure_reminder').length, 0, 'a re-arm of the same leg does not repeat it');
    assert.ok(rowOf('j-android').reminder_sent_at, 'and the record survives the re-arm');
});

test('the approach start_tracking comes at arrival-40, again when the arrival moves, and carries the same fields', async () => {
    const IN = 'install-android-timed-1';
    seedFeed();
    reset();

    await watcher.tick(at(49));
    assert.strictEqual(ofType('start_tracking').filter(s => s.data.reason === 'approach').length, 0, 'too early');

    await watcher.tick(at(51));
    let approach = ofType('start_tracking').filter(s => s.data.reason === 'approach');
    assert.strictEqual(approach.length, 1);
    assert.deepStrictEqual(
        { type: approach[0].data.type, journeyId: approach[0].data.journeyId, legIndex: approach[0].data.legIndex, trainNumber: approach[0].data.trainNumber },
        { type: 'start_tracking', journeyId: 'j-android', legIndex: 0, trainNumber: '3625' },
        'the same message the app already handles');
    assert.strictEqual(approach[0].noRetry, true);
    assert.ok(approach[0].ttlSeconds > 0);
    assert.strictEqual(rowOf('j-android').approach_count, 1);

    reset();
    await watcher.tick(at(52));
    await watcher.tick(at(60));
    assert.strictEqual(ofType('start_tracking').filter(s => s.data.reason === 'approach').length, 0, 'not again while the arrival holds');

    // the train slips 15 minutes: its approach is now at 65, not before
    seedFeed({ arrDelayMin: 15 });
    await watcher.tick(at(61));
    assert.strictEqual(ofType('start_tracking').filter(s => s.data.reason === 'approach').length, 0, 'too early for the NEW arrival');
    await watcher.tick(at(66));
    approach = ofType('start_tracking').filter(s => s.data.reason === 'approach');
    assert.strictEqual(approach.length, 1, 'sent again for the moved arrival');
    assert.strictEqual(rowOf('j-android').approach_count, 2);
    assert.strictEqual(rowOf('j-android').approach_arrival, unix(ARR) + 15 * 60);
});

test('a delayed train: the reminder gives the expected time; with no feed it never says "on time"', async () => {
    const IN = 'install-android-timed-2';
    store.registerDevice({ installId: IN, token: FCM_TOKEN + 'B', kind: 'fcm', environment: 'n/a', platform: 'android' });

    armLeg(IN, 'j-late');
    seedFeed({ depDelayMin: 20, arrDelayMin: 20 });
    reset();
    await watcher.tick(at(-29));
    const late = ofType('departure_reminder')[0];
    assert.strictEqual(late.data.body, 'Тръгва от София по разписание в 16:45, очаква се в 17:05 (закъснение 20 минути).');
    assert.strictEqual(late.data.delayMinutes, 20);

    armLeg(IN, 'j-nofeed', { train_number: '3625' });
    noFeed();
    reset();
    await watcher.tick(at(-29));
    const none = ofType('departure_reminder').find(s => s.data.journeyId === 'j-nofeed');
    assert.ok(none);
    assert.strictEqual(none.data.body, 'Тръгва от София по разписание в 16:45.');
    assert.ok(!('delayMinutes' in none.data), 'no report, no delayMinutes — not 0');
});

test('English app: English reminder, translated names', async () => {
    const IN = 'install-android-timed-3';
    store.registerDevice({ installId: IN, token: FCM_TOKEN + 'C', kind: 'fcm', environment: 'n/a', platform: 'android' });
    armLeg(IN, 'j-en', { app_language: 'en', train_number_display: 'FT 3625' });
    noFeed();
    reset();
    await watcher.tick(at(-29));
    const m = ofType('departure_reminder').find(s => s.data.journeyId === 'j-en');
    assert.deepStrictEqual([m.data.title, m.data.body], ['FT 3625 to Pirdop', 'Departs Sofia on schedule at 16:45.']);
});

test('an iPhone gets neither: it has the Live Activity', async () => {
    const IN = 'install-ios-timed-0001';
    store.registerDevice({ installId: IN, token: hex('a'), kind: 'push_to_start', environment: 'sandbox' });
    store.registerDevice({ installId: IN, token: hex('b'), kind: 'alert', environment: 'sandbox' });
    armLeg(IN, 'j-ios');
    seedFeed();
    reset();
    for (const m of [-29, -20, 49, 51, 66]) await watcher.tick(at(m));
    assert.strictEqual(sent.filter(s => s.data && s.data.journeyId === 'j-ios').length, 0, 'no FCM message for an iOS install');
    assert.strictEqual(rowOf('j-ios').reminder_sent_at, null);
    assert.strictEqual(rowOf('j-ios').approach_count, 0);
});

test('a re-arm with changed times starts the bookkeeping over; one that says nothing about language keeps it', () => {
    const IN = 'install-android-timed-1';
    assert.ok(rowOf('j-android').reminder_sent_at);
    armLeg(IN, 'j-android', { scheduled_departure: iso(DEP + 60 * MIN), scheduled_arrival: iso(ARR + 60 * MIN) });
    const after = rowOf('j-android');
    assert.strictEqual(after.reminder_sent_at, null, 'a different departure is a different reminder');
    assert.strictEqual(after.approach_count, 0);

    armLeg('install-android-timed-3', 'j-en', { app_language: null, train_number_display: 'FT 3625' });
    assert.strictEqual(rowOf('j-en').app_language, 'en', 'the language the leg was armed with is not forgotten');
    armLeg('install-android-timed-3', 'j-en', { app_language: 'bg', train_number_display: 'БВ 3625' });
    assert.strictEqual(rowOf('j-en').app_language, 'bg', 'but a language that is sent wins');
});

// ── /train: a stop is passed by where the train IS ───────────────────────────

test('/train: the train’s position outranks stale predicted times', () => {
    const NOW = DEP + 10 * MIN;
    const rt = { tripId: 'T', stops: [
        { stationId: 2,  station: 'София',   arrivalTime: unix(DEP - 20 * MIN), arrivalDelay: 0, departureTime: unix(DEP), departureDelay: 0 },
        { stationId: 3,  station: 'Пловдив', arrivalTime: unix(DEP + 5 * MIN),  arrivalDelay: 0, departureTime: unix(DEP + 6 * MIN), departureDelay: 0 },
        { stationId: 99, station: 'Пирдоп',  arrivalTime: unix(ARR),            arrivalDelay: 0, departureTime: null, departureDelay: null },
    ] };
    const ask = (v) => controller._buildTrainStatus({ num: '3625', rt, v, geo: null, now: new Date(NOW) }).body;
    const flags = (b) => b.stops.map(s => s.passed);

    // the clock alone: Пловдив's predicted departure (DEP+6) has passed at DEP+10
    assert.deepStrictEqual(flags(ask(null)), [true, true, false]);

    // the train is actually still approaching Пловдив (the predicted times are stale)
    const approaching = ask({ tripId: 'T', stopStatus: 'IN_TRANSIT_TO', stopStationId: 3, lat: 1, lon: 1 });
    assert.deepStrictEqual(flags(approaching), [true, false, false], 'not passed Пловдив: the train has not reached it');
    assert.strictEqual(approaching.nextStationId, 3);
    assert.strictEqual(approaching.previousStationId, 2);

    // standing at the origin 13 minutes before it leaves (the arrival time is long past)
    const origin = ask({ tripId: 'T', stopStatus: 'STOPPED_AT', stopStationId: 2, lat: 1, lon: 1 });
    assert.deepStrictEqual(flags(origin), [false, false, false], 'still in София: not passed');
    assert.strictEqual(origin.previousStationId, null);
    assert.strictEqual(origin.nextStationId, 3, 'standing at S: the next stop is the one after');

    // a position of another run does not count
    assert.deepStrictEqual(flags(ask({ tripId: 'OTHER', stopStatus: 'IN_TRANSIT_TO', stopStationId: 3, lat: 1, lon: 1 })), [true, true, false]);
});
