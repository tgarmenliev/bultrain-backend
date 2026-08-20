'use strict';

/**
 * measure-pushstart-budget.js — find Apple's real push-to-start budget.
 *
 * Apple documents that a device stops starting Live Activities after "about 10"
 * push-to-start pushes "in a short time frame", that the budget is fixed and
 * cannot be raised, and that replenishing "can take up to 24 hours" — but DTS
 * explicitly declines to give the window. Our own guard (3/hour, 8/day) is a
 * deliberate guess under that uncertainty. This measures the real thing so the
 * guess can be replaced with a number.
 *
 * The server CANNOT see the limit: APNs keeps returning 200 while the device
 * silently drops the starts. So this tool sends numbered starts and you watch
 * the device — either the Live Activity appears or it does not. On a Mac with
 * the phone attached, Console.app shows the giveaway line:
 *
 *     Push-to-start budget exceeded for <bundle>::pushToStart; not starting activity
 *
 * Usage:
 *   node scripts/measure-pushstart-budget.js --token <hex> --env sandbox
 *   node scripts/measure-pushstart-budget.js --token <hex> --count 15 --interval 45
 *   node scripts/measure-pushstart-budget.js --token <hex> --probe        # recovery
 *
 * TEST DEVICES ONLY. It deliberately burns the device's budget, which can leave
 * that phone unable to start Live Activities for up to 24 hours.
 */

const apns = require('../services/liveactivity/apns');

const args = process.argv.slice(2);
const flag = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const token    = flag('token');
const env      = flag('env', 'sandbox');
const count    = Number(flag('count', 15));
const interval = Number(flag('interval', 60));   // seconds between sends
const probe    = has('probe');
const force    = has('force');

if (!token || !/^[0-9a-fA-F]{32,512}$/.test(token)) {
    console.error('Usage: node scripts/measure-pushstart-budget.js --token <hex> [--env sandbox] [--count 15] [--interval 60] [--probe]');
    process.exit(1);
}
if (!apns.isConfigured()) {
    console.error('APNs is not configured — set APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID.');
    process.exit(1);
}

// ── Safety: never burn the budget of a phone with a real journey on it ───────
try {
    const armedStore = require('../services/liveactivity/armedStore');
    const db = require('better-sqlite3')(
        process.env.BULTRAIN_DB || require('path').join(__dirname, '..', 'bultrain.sqlite'),
        { readonly: true }
    );
    const row = db.prepare('SELECT install_id FROM device_tokens WHERE token = ?').get(token);
    if (row) {
        const active = db.prepare(
            "SELECT COUNT(*) AS n FROM armed_journeys WHERE install_id = ? AND state IN ('armed','started')"
        ).get(row.install_id).n;
        if (active > 0 && !force) {
            console.error(`REFUSING: this token belongs to install ${row.install_id}, which has ${active} active armed journey(s).`);
            console.error('Measuring would burn that phone\'s budget mid-journey. Use a test device, or --force if you are certain.');
            process.exit(1);
        }
    }
    db.close();
    void armedStore;
} catch (err) {
    console.warn(`(could not run the safety check: ${err.message} — continuing)`);
}

const ATTRIBUTES_TYPE = process.env.APNS_ATTRIBUTES_TYPE || 'JourneyLiveActivityAttributes';

function startBody(n) {
    const nowSec = Math.floor(Date.now() / 1000);
    return JSON.stringify({
        aps: {
            'timestamp': nowSec,
            'event': 'start',
            'attributes-type': ATTRIBUTES_TYPE,
            'attributes': {
                trainNumber: `TEST-${n}`,
                boardingStation: 'Тест A',
                destinationStation: 'Тест Б',
                journeyId: `budget-probe-${n}`,
            },
            // Mandatory content-state fields only — this is about the budget,
            // not about the payload.
            'content-state': {
                progressPercentage: 0.5,
                isDelayed: false,
                lastUpdated: nowSec - 978307200,
                phase: 'inTransit',
                directionStation: 'Тест Б',
                currentLegIndex: 0,
                isNextTransportBus: false,
                isCurrentTransportBus: false,
            },
            'alert': { title: `Бюджет тест #${n}`, body: `Проба ${n}` },
            'stale-date': nowSec + 900,
        },
    });
}

const stamp = () => new Date().toISOString().slice(11, 19);

async function sendOne(n) {
    const t0 = Date.now();
    const res = await apns.send({
        token, environment: env, body: startBody(n),
        priority: 10, pushType: 'liveactivity', noRetry: true,
    });
    console.log(`${stamp()}  #${String(n).padStart(2)}  ${res.outcome.padEnd(14)} ` +
                `status=${res.status} reason=${res.reason || '—'}  (${Date.now() - t0} ms)`);
    return res;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    if (probe) {
        console.log('Recovery probe: one start every 30 minutes until it appears on the device again.');
        console.log('Watch the phone. Ctrl-C when a card shows up, and note the elapsed time.\n');
        for (let n = 1; ; n++) {
            await sendOne(n);
            console.log(`   …sleeping 30 min (elapsed ${((n - 1) * 30)} min so far)\n`);
            await sleep(30 * 60 * 1000);
        }
    }

    console.log(`Sending ${count} push-to-start pushes, ${interval}s apart, to ${env}.`);
    console.log('APNs will report 200 for all of them — the limit is invisible from here.');
    console.log('WATCH THE DEVICE and note the LAST number whose card actually appeared.\n');

    for (let n = 1; n <= count; n++) {
        await sendOne(n);
        if (n < count) await sleep(interval * 1000);
    }

    console.log('\nDone. On the device, the highest card number that appeared is the budget.');
    console.log('Then run with --probe to measure how long replenishing takes.');
    apns.closeSessions();
})().catch(err => { console.error('failed:', err.message); process.exit(1); });
