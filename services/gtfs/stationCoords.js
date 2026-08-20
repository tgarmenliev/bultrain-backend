'use strict';

/**
 * stationCoords.js — resolve a station NAME to coordinates, and the great-circle
 * distance between two of them.
 *
 * Needed for the Live Activity attributes: the app carries totalDistanceKm and
 * computes it client-side as a straight line origin→destination, so the number
 * the server sends has to be the same kind of number — not route mileage, which
 * would disagree with the progress the app draws against it.
 *
 * Names come from the client and drift in spelling, so matching goes through the
 * same tolerant fold the Live Activity payload uses.
 */

const path     = require('path');
const Database = require('better-sqlite3');
const { normalizeStation } = require('../liveactivity/contentState');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');
const CACHE_TTL_MS = 60 * 60 * 1000;

let index = null;      // normalised name -> { lat, lon, name }
let loadedAt = 0;

function load() {
    if (index && Date.now() - loadedAt < CACHE_TTL_MS) return index;
    const map = new Map();
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        for (const r of db.prepare('SELECT name, lat, lon FROM stations WHERE lat IS NOT NULL AND lon IS NOT NULL').all()) {
            const key = normalizeStation(r.name);
            if (key && !map.has(key)) map.set(key, { lat: r.lat, lon: r.lon, name: r.name });
        }
        db.close();
    } catch (err) {
        console.error('[stations] coordinate index failed:', err.message);
    }
    index = map;
    loadedAt = Date.now();
    return index;
}

/** @returns {{lat:number, lon:number, name:string}|null} */
function find(stationName) {
    const map = load();
    const target = normalizeStation(stationName);
    if (!target) return null;
    if (map.has(target)) return map.get(target);
    // Fall back to a prefix match, the same leniency findStopIndex uses.
    for (const [key, value] of map) {
        if (key.startsWith(target) || target.startsWith(key)) return value;
    }
    return null;
}

const EARTH_R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two {lat, lon} points. */
function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Straight-line distance between two stations by name, to one decimal.
 * @returns {number|null} null when either station cannot be resolved — the
 *          caller must then decide, because this field is NOT optional in the
 *          app and a wrong number is worse than a considered fallback.
 */
function distanceKm(fromName, toName) {
    const a = find(fromName);
    const b = find(toName);
    if (!a || !b) return null;
    return Math.round(haversineKm(a, b) * 10) / 10;
}

module.exports = { find, distanceKm, haversineKm };
