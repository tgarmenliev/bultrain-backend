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
 *
 * Distinguishes a delay of 0 (present, on time) from an ABSENT delay field —
 * the whole point of the investigation — so don't collapse them.
 */

const axios = require('axios');
const B     = require('gtfs-realtime-bindings');
const cfg   = require('../services/gtfs/config');

const FeedMessage = B.transit_realtime.FeedMessage;
const wanted = process.argv[2] ? String(process.argv[2]) : null;

// prefix of "{number}-{cat}-{date}" — no DB needed for a diagnostic
const numberOf = (tripId) => String(tripId || '').split('-')[0] || '(none)';

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
