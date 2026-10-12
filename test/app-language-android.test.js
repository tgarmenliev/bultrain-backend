'use strict';

/**
 * appLanguage on arm — one code path for iOS and Android. An Android install that sends it
 * gets English alert text and English station names, exactly like iOS. The Android start
 * message is data-only (the app builds its own notification), so the language matters for
 * the delay alert, whose title/body the server writes for both platforms.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-lang-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

{
    const db = new Database(TMP);
    const st = db.prepare('INSERT INTO stations (id, name, english_name, lat, lon) VALUES (?, ?, ?, 42, 25)');
    st.run(2, 'София', 'Sofia'); st.run(3, 'Пловдив', 'Plovdiv'); st.run(4, 'Бургас', 'Burgas');
    db.close();
}

const ctrl    = require('../controllers/armedJourneyController');
const live    = require('../controllers/liveActivityController');
const logic   = require('../services/liveactivity/armedLogic');
const display = require('../services/gtfs/stationDisplay');

const ANDROID = 'android-install-0001';
const FCM_TOKEN = 'f'.repeat(40) + ':APA91b' + 'x'.repeat(80);

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });
const dep = new Date(Date.now() + 3600e3).toISOString();
const arr = new Date(Date.now() + 7200e3).toISOString();

function armBody(over = {}) {
    return {
        installId: ANDROID, journeyId: 'j-lang', legIndex: 0, trainNumber: '2612',
        boardingStation: 'София', destinationStation: 'Пловдив', directionStation: 'Бургас',
        scheduledDeparture: dep, scheduledArrival: arr, ...over,
    };
}
const storedLanguage = (journeyId) => {
    const db = new Database(TMP, { readonly: true });
    try { return db.prepare('SELECT app_language AS l FROM armed_journeys WHERE journey_id=?').get(journeyId).l; }
    finally { db.close(); }
};

test('an Android install registers like any other and arms with appLanguage', () => {
    const r = res();
    ctrl.registerDevice({ body: { installId: ANDROID, token: FCM_TOKEN, platform: 'android' } }, r);
    assert.strictEqual(r.statusCode, 200);

    const a = res();
    ctrl.arm({ body: armBody({ appLanguage: 'en' }) }, a);
    assert.strictEqual(a.statusCode, 200);
    assert.strictEqual(a.body.canAutoStart, true, 'Android registers one fcm token that serves as its start token');
    assert.strictEqual(storedLanguage('j-lang'), 'en');
});

test('locale tags as Android hands them out are understood; unknown stays unset (Bulgarian)', () => {
    for (const [sent, stored] of [['en', 'en'], ['bg', 'bg'], ['en-US', 'en'], ['en_GB', 'en'], ['EN', 'en'],
                                  ['bg-BG', 'bg'], [' en ', 'en'], ['fr', null], ['', null], [null, null], [undefined, null], [42, null]]) {
        assert.strictEqual(live.parseAppLanguage(sent), stored, JSON.stringify(sent));
    }
    const a = res();
    ctrl.arm({ body: armBody({ journeyId: 'j-tag', appLanguage: 'en-US' }) }, a);
    assert.strictEqual(storedLanguage('j-tag'), 'en');
});

test('the delay alert of that Android leg is written in English with English station names', () => {
    const row = { train_number: '2612', destination_station: 'Пловдив' };
    const language = storedLanguage('j-lang');
    const ctx = { phase: 'preDeparture', role: 'active', language, destinationDisplay: display.displayStationName('Пловдив', language) };
    const t = logic.alertText(row, 12, 'appeared', 'FT 2612', ctx);
    assert.match(t.title, /delayed by 12/);
    assert.match(t.body, /Plovdiv/);
    assert.doesNotMatch(t.title + t.body, /Пловдив|закъснява/);
});

test('without appLanguage the same leg is Bulgarian, as before', () => {
    const a = res();
    ctrl.arm({ body: armBody({ journeyId: 'j-none' }) }, a);
    assert.strictEqual(storedLanguage('j-none'), null);
    const t = logic.alertText({ train_number: '2612', destination_station: 'Пловдив' }, 12, 'appeared', 'БВ 2612', { language: null });
    assert.match(t.title + t.body, /Пловдив|закъснява|Закъснява/);
});

test('station names are accepted in Bulgarian (what the feed uses) and stored as sent', () => {
    const db = new Database(TMP, { readonly: true });
    const row = db.prepare("SELECT boarding_station b, destination_station d, direction_station x FROM armed_journeys WHERE journey_id='j-lang'").get();
    db.close();
    assert.deepStrictEqual(row, { b: 'София', d: 'Пловдив', x: 'Бургас' });
});
