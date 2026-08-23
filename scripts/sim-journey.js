#!/usr/bin/env node
'use strict';

/**
 * scripts/sim-journey.js — drives the armed-journey pipeline (arm ->
 * push-to-start -> live content -> delay alert -> leg transition ->
 * leg-arrived) through a synthetic two-leg transfer, entirely through the
 * SAME HTTP endpoints the real app calls. Nothing here is a special test
 * code path in the pipeline itself — it is the real code, fed synthetic
 * input, which is the whole point.
 *
 * Safety: uses reserved TEST-prefixed train numbers (see testFeed.js). The
 * server refuses (400) to store synthetic data for any number not in that
 * namespace, and testFeed is never merged into the public realtime cache, so
 * it can never appear on the map radar or anywhere else a real user looks.
 * Requires ENABLE_JOURNEY_SIM=on on the target server (404s otherwise).
 *
 * PREREQUISITE, one-time, before this script can do anything: a push-to-start
 * token must already be registered for your install. Simply having the app
 * open is NOT enough — the app only requests/registers that token when you
 * actually track a real journey (search a real train, do whatever the app
 * calls "track/save this journey"). Do that once, for any real train, then
 * find your install id: `pm2 logs bultrain | grep 'device registered'`.
 * `arm` below checks this itself and tells you plainly if it's still missing
 * — pushes go only to that install's own tokens, never to anyone else's.
 *
 * Usage (Плодив -> Карлово -> Антон, matching a real transfer route):
 *   BASE_URL=https://api.bultrain.eu IOS_API_KEY=... INSTALL_ID=... \
 *     node scripts/sim-journey.js arm
 *
 *   node scripts/sim-journey.js delay 1 7      # leg 1 shows +7 min delay
 *   node scripts/sim-journey.js arrive 1       # simulate the geofence firing
 *   node scripts/sim-journey.js delay 2 0      # seed leg 2's feed (0 min, on time)
 *   node scripts/sim-journey.js delay 2 4      # then a delay on leg 2 too, if wanted
 *   node scripts/sim-journey.js arrive 2
 *   node scripts/sim-journey.js disarm         # always clean up when done
 *
 * BASE_URL/IOS_API_KEY/INSTALL_ID/JOURNEY_ID are read fresh from the
 * environment on every invocation, so each command is a separate `node`
 * call — that's deliberate, it's what lets you watch the phone between steps.
 */

const axios = require('axios');

const BASE_URL    = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY     = process.env.IOS_API_KEY || '';
const INSTALL_ID  = process.env.INSTALL_ID || '';
const JOURNEY_ID  = process.env.JOURNEY_ID || 'sim-journey';

const LEGS = {
    1: { train: 'TEST-LEG1', display: 'ТЕСТ 1', boarding: 'Пловдив', destination: 'Карлово' },
    2: { train: 'TEST-LEG2', display: 'ТЕСТ 2', boarding: 'Карлово', destination: 'Антон' },
};

const client = axios.create({
    baseURL: BASE_URL,
    headers: { 'X-Bultrain-Api-Key': API_KEY, 'User-Agent': 'BulTrainMobile' },
    timeout: 10_000,
});

function requireEnv(name, value) {
    if (!value) {
        console.error(`Missing ${name} — set it as an env var (see the header comment of this script).`);
        process.exit(1);
    }
}

async function setFeed(train, stops) {
    await client.post('/api/live-activity/sim/train', { trainNumber: train, stops });
}

async function cmdArm() {
    requireEnv('INSTALL_ID', INSTALL_ID);
    requireEnv('IOS_API_KEY', API_KEY);

    const now = Date.now();
    // Deliberately close, not "40+ min before departure" realistic timing —
    // the whole point is not waiting on the real schedule. Any near-future
    // departure makes the trigger (departure - 40min) already past, so
    // push-to-start fires on the very first 30s tick.
    const legs = [
        { index: 0, leg: LEGS[1], dep: new Date(now + 2 * 60_000), arr: new Date(now + 20 * 60_000) },
        { index: 1, leg: LEGS[2], dep: new Date(now + 25 * 60_000), arr: new Date(now + 45 * 60_000) },
    ];

    let canAutoStart = true;
    for (const { index, leg, dep, arr } of legs) {
        const res = await client.post('/api/live-activity/arm', {
            installId: INSTALL_ID,
            journeyId: JOURNEY_ID,
            legIndex: index,
            trainNumber: leg.train,
            trainNumberDisplay: leg.display,
            boardingStation: leg.boarding,
            destinationStation: leg.destination,
            scheduledDeparture: dep.toISOString(),
            scheduledArrival: arr.toISOString(),
        });
        console.log(`armed leg ${index}: ${leg.train} ${leg.boarding} -> ${leg.destination}, dep ${dep.toLocaleTimeString('bg-BG')}`);
        if (!res.data.canAutoStart) canAutoStart = false;
    }

    if (!canAutoStart) {
        console.warn('\n⚠  No push-to-start token on file for this install yet — the card will NOT appear, and nothing else here will help until that exists.');
        console.warn('   Open the BulTrain app, pick any REAL journey, and do whatever it calls "track/save this journey" — once, for any train.');
        console.warn('   That is what makes the app request and register a push-to-start token — simply opening the app is not enough.');
        console.warn(`   Then re-run:  node scripts/sim-journey.js arm\n`);
        return;
    }

    // Seed leg 1 immediately so the trigger has a predicted departure on the
    // very first tick, not just the (also usable) scheduled fallback.
    await setFeed(LEGS[1].train, [
        { station: LEGS[1].boarding, departureInSec: 120, delayMin: 0 },
        { station: LEGS[1].destination, arrivalInSec: 1200, delayMin: 0 },
    ]);

    console.log('\nArmed. Watch your phone — push-to-start should land within ~30s.');
    console.log('Tail the decision log with:  pm2 logs bultrain | grep armed');
}

async function cmdDelay(legNum, minutes) {
    const leg = LEGS[legNum];
    requireEnv('leg (1 or 2)', leg);
    const min = Number(minutes);
    if (!Number.isFinite(min)) { console.error('minutes must be a number.'); process.exit(1); }

    await setFeed(leg.train, [
        { station: leg.boarding, departureInSec: 60, delayMin: min },
        { station: leg.destination, arrivalInSec: 1200, delayMin: min },
    ]);
    console.log(`leg ${legNum} (${leg.train}) now shows ${min} min delay.`);
    console.log(min > 0 ? 'A delay alert should follow within ~30s if this crosses the alert threshold.' : '');
}

async function cmdArrive(legNum) {
    requireEnv('INSTALL_ID', INSTALL_ID);
    const legIndex = Number(legNum) - 1;
    await client.post('/api/live-activity/leg-arrived', { installId: INSTALL_ID, journeyId: JOURNEY_ID, legIndex });
    console.log(`leg ${legNum} marked arrived.`);
    if (legNum === '1') console.log("Run 'delay 2 0' next to seed leg 2's feed — its push-to-start should now be eligible.");
}

async function cmdDisarm() {
    requireEnv('INSTALL_ID', INSTALL_ID);
    await client.post('/api/live-activity/disarm', { installId: INSTALL_ID, journeyId: JOURNEY_ID });
    for (const leg of Object.values(LEGS)) {
        await client.delete(`/api/live-activity/sim/train/${leg.train}`).catch(() => {});
    }
    console.log('disarmed and cleared synthetic feed data.');
}

const [, , cmd, a, b] = process.argv;

(async () => {
    try {
        if (cmd === 'arm') await cmdArm();
        else if (cmd === 'delay' && a && b !== undefined) await cmdDelay(a, b);
        else if (cmd === 'arrive' && a) await cmdArrive(a);
        else if (cmd === 'disarm') await cmdDisarm();
        else {
            console.log('Usage:');
            console.log('  node scripts/sim-journey.js arm');
            console.log('  node scripts/sim-journey.js delay <1|2> <minutes>');
            console.log('  node scripts/sim-journey.js arrive <1|2>');
            console.log('  node scripts/sim-journey.js disarm');
            process.exit(1);
        }
    } catch (err) {
        const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
        console.error('Failed:', detail);
        process.exit(1);
    }
})();
