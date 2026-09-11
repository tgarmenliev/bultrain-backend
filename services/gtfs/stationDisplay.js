'use strict';

/**
 * stationDisplay.js — the passenger-facing name for a station, in the app's
 * own language.
 *
 * The client always registers armed journeys and Live Activity tokens with
 * the BULGARIAN station name (contentState.js's own comment: "The app
 * registers Bulgarian names to line up with the feed") — the GTFS-RT feed
 * only ever knows stations by that name, so boarding_station/
 * destination_station have to stay Bulgarian for matching regardless of the
 * app's language. That name then leaked straight onto the card/push text
 * verbatim: an English-language journey got a fully English Live Activity
 * except for the two station names, which stayed Bulgarian — the exact same
 * class of bug as the English schedule-search delay fix, just on the
 * journey-tracking side.
 *
 * This resolves a Bulgarian name to its english_name from the `stations`
 * table for display only; the raw name used for feed/coordinate matching is
 * never touched.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

let db = null;
function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

// Same tolerant matching contentState.js/segmentMode.js use — station names
// drift in spelling ("Ловеч-север" vs "Ловеч - Север") between sources.
function normalize(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // combining marks (й → и, etc.)
        .replace(/[.\-–—]/g, ' ') // dots and dashes are noise here
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string} bgName   the Bulgarian name the client registered
 * @param {string} language 'en' triggers translation; anything else (or
 *                          missing/unrecognized, same convention as
 *                          armedLogic.js's alertText) returns bgName as-is
 * @returns {string} the English name when found, else the original Bulgarian
 *          name unchanged — never invents a translation, never throws.
 */
function displayStationName(bgName, language) {
    if (language !== 'en' || !bgName) return bgName;
    try {
        const c = conn();
        const exact = c.prepare('SELECT english_name FROM stations WHERE name = ?').get(bgName);
        if (exact && exact.english_name) return exact.english_name;

        const target = normalize(bgName);
        const hit = c.prepare('SELECT name, english_name FROM stations').all()
            .find(r => normalize(r.name) === target);
        return (hit && hit.english_name) || bgName;
    } catch (err) {
        console.warn(`[stationDisplay] lookup failed for "${bgName}": ${err.message}`);
        return bgName;
    }
}

module.exports = { displayStationName };
