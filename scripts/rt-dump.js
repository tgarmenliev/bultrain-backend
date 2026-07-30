'use strict';

/**
 * rt-dump.js — decode the live GTFS-Realtime TripUpdates feed and answer one
 * question: does an on-time running train appear in the feed at all?
 *
 * Background: /api/realtime/train/:no returns 404 for trains KIS shows running
 * on time, while delayed trains work. Our ingestion and handler preserve a
 * delay of 0 end to end (verified), so a train can only 404 by being absent
 * from the feed. This tool checks whether that's what's happening.
 *
 * Usage:
 *   node scripts/rt-dump.js            # feed-wide summary
 *   node scripts/rt-dump.js 2612       # + every TripUpdate for train 2612
 *   node scripts/rt-dump.js --list     # every resolved train number in the feed
 *
 * Resolves trip_id → train_number exactly like the poller (DB mapping first,
 * prefix fallback), so "not in the feed" here means the same as it does to the
 * live cache — no false negative from a trip_id whose prefix isn't the number.
 *
 * Distinguishes a delay of 0 (present, on time) from an ABSENT delay field —
 * the whole point of the investigation — so don't collapse them.
 */

const path     = require('path');
const axios    = require('axios');
const Database = require('better-sqlite3');
const B        = require('gtfs-realtime-bindings');
const cfg      = require('../services/gtfs/config');

const FeedMessage = B.transit_realtime.FeedMessage;
const args   = process.argv.slice(2);
const doList = args.includes('--list');
const wanted = args.find(a => !a.startsWith('--')) || null;

// Same resolution as services/realtime/poller.js: DB trip mapping, then the
// "{number}-{cat}-{date}" prefix as a fallback.
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
let tripToNumber = new Map();
try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    for (const r of db.prepare('SELECT trip_id, train_number FROM trip').all()) {
        tripToNumber.set(r.trip_id, r.train_number);
    }
    db.close();
} catch (e) {
    console.warn(`(could not load DB trip mapping: ${e.message} — prefix fallback only)\n`);
}
const numberOf = (tripId) =>
    String(tripToNumber.get(tripId) || String(tripId || '').split('-')[0] || '(none)');

// null → absent field; a number (incl. 0) → present
function delayOf(evt) {
    if (!evt) return { present: false, value: null };
    const has = Object.prototype.hasOwnProperty.call(evt, 'delay') && evt.delay != null;
    return { present: has, value: has ? Number(evt.delay) : null };
}

(async () => {
    const res  = await axios.get(cfg.RT.tripUpdates, { responseType: 'arraybuffer', timeout: 20000 });
    const feed = FeedMessage.decode(Buffer.from(res.data));

    const headerTs = Number(feed.header.timestamp) * 1000;
    const ageSec   = headerTs ? Math.round((Date.now() - headerTs) / 1000) : null;
    console.log(`feed header timestamp: ${headerTs ? new Date(headerTs).toISOString() : '(none)'}  (age ${ageSec}s)`);

    const entities = feed.entity.filter(e => e.tripUpdate && e.tripUpdate.trip);
    console.log(`TripUpdate entities: ${entities.length}\n`);

    let allOnTime = 0;   // every stop delay is present-and-0 or absent
    let hasDeviation = 0; // at least one stop with a non-zero delay
    let anyPresentZero = 0; // trips that carry an explicit delay of exactly 0
    const present = [];   // { num, onTime } for --list

    for (const e of entities) {
        const tu = e.tripUpdate;
        const stus = tu.stopTimeUpdate || [];
        let maxAbs = 0;
        let sawPresentZero = false;
        for (const su of stus) {
            const a = delayOf(su.arrival);
            const d = delayOf(su.departure);
            for (const x of [a, d]) {
                if (x.present) {
                    if (x.value === 0) sawPresentZero = true;
                    maxAbs = Math.max(maxAbs, Math.abs(x.value));
                }
            }
        }
        if (maxAbs > 0) hasDeviation++; else allOnTime++;
        if (sawPresentZero) anyPresentZero++;
        present.push({ num: numberOf(tu.trip.tripId), onTime: maxAbs === 0 });

        if (wanted && numberOf(tu.trip.tripId) === wanted) {
            console.log(`── train ${wanted}  trip_id=${tu.trip.tripId}  stops=${stus.length}`);
            for (const su of stus) {
                const a = delayOf(su.arrival);
                const d = delayOf(su.departure);
                const fmt = (x) => x.present ? `${x.value}s` : 'absent';
                console.log(`   stop ${su.stopId}: arr ${fmt(a)}, dep ${fmt(d)}`);
            }
            console.log('');
        }
    }

    if (doList) {
        console.log('── train numbers in the feed (● on time · ▲ delayed) ──');
        present.sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
        for (const p of present) console.log(`   ${p.onTime ? '●' : '▲'} ${p.num}`);
        console.log('');
    }

    console.log('── summary ─────────────────────────────');
    console.log(`trips with a non-zero delay somewhere : ${hasDeviation}`);
    console.log(`trips entirely on time (all 0/absent) : ${allOnTime}`);
    console.log(`trips carrying an explicit delay of 0 : ${anyPresentZero}`);
    console.log('');
    console.log(allOnTime === 0
        ? 'VERDICT: the feed only publishes deviating trips. On-time trains are\n'
          + '         absent from the feed itself — this is NOT a backend bug. Whether\n'
          + '         to synthesise an "on time, running" record from KIS is a product\n'
          + '         decision.'
        : 'VERDICT: the feed DOES carry on-time trips, so a 404 for one is a backend\n'
          + '         bug — run this with that train number and trace where it drops.');

    if (wanted && !entities.some(e => numberOf(e.tripUpdate.trip.tripId) === wanted)) {
        console.log(`\nNOTE: train ${wanted} has NO TripUpdate in this feed snapshot.`);
    }
})().catch(err => { console.error('failed:', err.message); process.exit(1); });
