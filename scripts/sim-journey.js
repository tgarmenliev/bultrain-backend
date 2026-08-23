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
 * BASE_URL/IOS_API_KEY/INSTALL_ID are read fresh from the environment on
 * every invocation, so each command is a separate `node` call — that's
 * deliberate, it's what lets you watch the phone between steps.
 *
 * journeyId is NOT a fixed constant: `arm` generates a fresh one each time
 * and remembers it (data/sim-journey-session.json), and every other command
 * reads that back automatically. Reusing one hardcoded id across sessions
 * meant a leftover live_activity_tokens row from a PREVIOUS test could get
 * picked up by a brand new one — exactly what produced a confusing mix of an
 * old, already-retargeted token next to a freshly armed leg 0. Override with
 * an explicit JOURNEY_ID env var only if you deliberately want to resume a
 * specific past session.
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL    = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY     = process.env.IOS_API_KEY || '';
const INSTALL_ID  = process.env.INSTALL_ID || '';

const SESSION_FILE = path.join(__dirname, '..', 'data', 'sim-journey-session.json');

function readSession() {
    try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
}
function writeSession(journeyId) {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ journeyId, armedAt: new Date().toISOString() }));
}
function clearSession() {
    try { fs.unlinkSync(SESSION_FILE); } catch { /* nothing to clear */ }
}
/** The journey every command but `arm` operates on. */
function currentJourneyId() {
    if (process.env.JOURNEY_ID) return process.env.JOURNEY_ID;
    const session = readSession();
    if (session) return session.journeyId;
    console.error('No sim-journey session found — run "arm" first (or set JOURNEY_ID explicitly).');
    process.exit(1);
}

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

    const journeyId = process.env.JOURNEY_ID || `sim-${Date.now()}`;
    writeSession(journeyId);
    console.log(`journey id: ${journeyId} (remembered — every other command will use this automatically)`);

    const now = Date.now();
    // Deliberately close, not "40+ min before departure" realistic timing —
    // the whole point is not waiting on the real schedule. Any near-future
    // departure makes the trigger (departure - 40min) already past, so
    // push-to-start fires on the very first 30s tick.
    const dep2 = new Date(now + 25 * 60_000);
    const legs = [
        {
            index: 0, leg: LEGS[1], dep: new Date(now + 2 * 60_000), arr: new Date(now + 20 * 60_000),
            // A real multi-leg journey arms leg 0 already knowing the connection —
            // this is what makes the card show "next: TEST-LEG2 at HH:MM" ahead of
            // the transfer. Without it, leg 0's card looks like a plain single-leg
            // trip; nothing wrong happens, it just under-represents what a real
            // transfer journey's card looks like.
            next: { number: LEGS[2].display, departure: dep2 },
        },
        { index: 1, leg: LEGS[2], dep: dep2, arr: new Date(now + 45 * 60_000) },
    ];

    let canAutoStart = true;
    for (const { index, leg, dep, arr, next } of legs) {
        const res = await client.post('/api/live-activity/arm', {
            installId: INSTALL_ID,
            journeyId,
            legIndex: index,
            trainNumber: leg.train,
            trainNumberDisplay: leg.display,
            boardingStation: leg.boarding,
            destinationStation: leg.destination,
            scheduledDeparture: dep.toISOString(),
            scheduledArrival: arr.toISOString(),
            ...(next ? { nextTransportNumber: next.number, nextTransportDeparture: next.departure.toISOString() } : {}),
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
    console.log('\nAfter the card appears, wait past its departure time and check whether the');
    console.log('CONTENT actually keeps updating (phase should flip preDeparture -> inTransit):');
    console.log('  node scripts/check-test-journey.js');
    console.log('An empty live_activity_tokens section there means the app never registered an');
    console.log('update token for this activity — worth flagging to the mobile side, not a retry-able server issue.');
}

async function cmdDelay(legNum, minutes) {
    const leg = LEGS[legNum];
    requireEnv('leg (1 or 2)', leg);
    const min = Number(minutes);
    if (!Number.isFinite(min)) { console.error('minutes must be a number.'); process.exit(1); }

    // Boarding is pinned safely in the past — this command is for testing a
    // delay while the leg is already rolling (or just about to, from arm's own
    // seed). Previously it re-set the boarding departure to "60s from now" on
    // EVERY call, so calling this after the train had "left" made legPhase()
    // read it as still pre-departure — which is exactly why the alert said
    // "check before you leave" while the tester was already mid-journey.
    await setFeed(leg.train, [
        { station: leg.boarding, arrivalInSec: -99999, departureInSec: -99999, delayMin: min },
        { station: leg.destination, arrivalInSec: 1200, delayMin: min },
    ]);
    console.log(`leg ${legNum} (${leg.train}) now shows ${min} min delay.`);
    console.log(min > 0 ? 'A delay alert should follow within ~30s if this crosses the alert threshold.' : '');
}

async function cmdArrive(legNum) {
    requireEnv('INSTALL_ID', INSTALL_ID);
    const leg = LEGS[legNum];
    requireEnv('leg (1 or 2)', leg);
    const legIndex = Number(legNum) - 1;
    const journeyId = currentJourneyId();

    await client.post('/api/live-activity/leg-arrived', { installId: INSTALL_ID, journeyId, legIndex });

    // /leg-arrived only unblocks the NEXT leg's push-to-start trigger — it does
    // NOT end THIS leg's already-started card. Ending is worker.js's own job,
    // decided purely from the feed's predicted arrival time plus a grace
    // period (same as it would be for a real train, whose feed naturally
    // updates as it actually arrives). Without this, the card would just sit
    // there until the untouched, far-future synthetic arrival time we seeded
    // at `arm` finally passes — which is why a second leg-2 card could appear
    // while leg 1's was still showing.
    await setFeed(leg.train, [
        { station: leg.boarding, departureInSec: -1400, delayMin: 0 },
        { station: leg.destination, arrivalInSec: -700, delayMin: 0 },
    ]);

    console.log(`leg ${legNum} marked arrived — its card should END within the next ~30s worker tick (single-leg journeys only — see below for a transfer).`);

    if (legNum === '1' && LEGS[2]) {
        // The next leg's trigger can fire on the very NEXT tick — its own
        // scheduled_departure was fixed back at `arm` time, so however long you
        // took between `arm` and this `arrive` may already be past it. Waiting
        // for a separate manual 'delay 2 0' left a real window where the
        // retarget/push-to-start fired with NOTHING in leg 2's feed yet, which
        // is exactly why the card showed "no live data" instead of a delay.
        // Seed it here, immediately, so there is never a gap.
        await setFeed(LEGS[2].train, [
            { station: LEGS[2].boarding, departureInSec: 60, delayMin: 0 },
            { station: LEGS[2].destination, arrivalInSec: 1200, delayMin: 0 },
        ]);
        console.log("Leg 2's feed is already seeded (on time) — no separate step needed.");
        console.log('The SAME card should now update in place for leg 2 (no second push-to-start) —');
        console.log('check pm2 logs for "[armed] retarget" vs "[armed] push-to-start SENT".');
        console.log("Run 'delay 2 <min>' whenever you want to test a delay on leg 2.");
    }
}

async function cmdDisarm() {
    requireEnv('INSTALL_ID', INSTALL_ID);
    const journeyId = currentJourneyId();
    const res = await client.post('/api/live-activity/disarm', { installId: INSTALL_ID, journeyId });
    for (const leg of Object.values(LEGS)) {
        await client.delete(`/api/live-activity/sim/train/${leg.train}`).catch(() => {});
    }
    clearSession();
    console.log(`disarmed j=${journeyId}, cleared synthetic feed data, removed ${res.data.tokensRemoved ?? 0} live_activity_tokens row(s).`);
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
