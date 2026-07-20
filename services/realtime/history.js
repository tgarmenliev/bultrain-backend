'use strict';

/**
 * history.js — quiet delay-history collection.
 *
 * The poller feeds record() the current delay for each (train, station, service
 * date) on every TripUpdates poll; we keep only the LATEST value per key in
 * memory (a scoreboard, not a recording). A timer flushes the buffer to
 * delay_history with an UPSERT, so the table gains ~one row per train-stop-day
 * and writes stay bounded. Entries for past dates are finalised and pruned.
 *
 * Enabled by RT_HISTORY=on; independent of the serving endpoints.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH           = path.join(__dirname, '..', '..', 'bultrain.sqlite');
const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
// Only a guard against a hypothetical multi-day feed glitch — NOT against big
// delays. International transit trains (route MBV, e.g. Optima Express) really
// do run 700-1000+ min late due to border checks / upstream delays, and those
// extremes are exactly the data that makes this valuable. The feed shows no
// day-boundary anomalies in practice; the stats use MEDIAN, so rare outliers
// wash out anyway. 20h keeps every plausible real delay.
const MAX_ABS_DELAY_SEC = 20 * 3600;

let db = null;
let started = false;
const buffer = new Map(); // "num|stationId|date" -> { trainNumber, stationId, date, delaySeconds }

function record(trainNumber, stationId, date, delaySeconds) {
    if (stationId == null || delaySeconds == null || !date) return;
    if (Math.abs(delaySeconds) > MAX_ABS_DELAY_SEC) return; // feed anomaly
    buffer.set(`${trainNumber}|${stationId}|${date}`, { trainNumber, stationId, date, delaySeconds });
}

function sofiaToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' }); // YYYY-MM-DD
}

function flush() {
    if (buffer.size === 0) return;
    try {
        if (!db) db = new Database(DB_PATH, { fileMustExist: true });
        const up = db.prepare(`
            INSERT INTO delay_history (train_number, station_id, date, delay_seconds)
            VALUES (@trainNumber, @stationId, @date, @delaySeconds)
            ON CONFLICT(train_number, station_id, date)
            DO UPDATE SET delay_seconds = excluded.delay_seconds
        `);
        const rows = [...buffer.values()];
        db.transaction(() => { for (const r of rows) up.run(r); })();

        // Past-date entries are final now — flushed above, drop from memory.
        const today = sofiaToday();
        for (const [k, v] of buffer) if (v.date < today) buffer.delete(k);
    } catch (err) {
        console.error('[rt] delay-history flush failed:', err.message);
    }
}

function start() {
    if (started) return;
    started = true;
    setInterval(flush, FLUSH_INTERVAL_MS);
    console.log('[rt] delay-history collection started');
}

module.exports = { record, flush, start };
