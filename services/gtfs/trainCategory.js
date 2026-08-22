'use strict';

/**
 * trainCategory.js — the passenger-facing form of a train number ("БВ 8611").
 *
 * The clients send a display number where they can, but not every path does,
 * and the Live Activity's per-leg field looks wrong as a bare number. We
 * already hold the category in the GTFS trip table, so compose it here rather
 * than leaving the card to show "8611" on its own.
 *
 * Read-only and cached: categories change only with the daily GTFS refresh.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000;

let index = null;   // train_number -> category ('БВ', 'ПВ', 'АВТ', …)
let loadedAt = 0;

function load() {
    if (index && Date.now() - loadedAt < CACHE_TTL_MS) return index;
    const map = new Map();
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        // Prefer the GTFS trip table (current, and the source the realtime feed
        // is matched against); fall back to the legacy trains table.
        for (const source of ['trip', 'trains']) {
            try {
                for (const r of db.prepare(`SELECT train_number, category FROM ${source}`).all()) {
                    if (r.category && !map.has(String(r.train_number))) {
                        map.set(String(r.train_number), r.category);
                    }
                }
            } catch { /* table absent in this database — try the next */ }
        }
        db.close();
    } catch (err) {
        console.error('[trains] category index failed:', err.message);
    }
    index = map;
    loadedAt = Date.now();
    return index;
}

/**
 * "БВ 8611" when the category is known, otherwise null so the caller can decide
 * its own fallback rather than being handed a half-formed label.
 */
function displayFor(trainNumber) {
    if (!trainNumber) return null;
    const category = load().get(String(trainNumber));
    return category ? `${category} ${trainNumber}` : null;
}

module.exports = { displayFor };
