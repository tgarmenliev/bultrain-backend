'use strict';

/**
 * routeShapeBundle.js — every route shape of one service day, in one download.
 *
 * One request per tap (GET /route-shape/:trainNo, ~180 ms each) made the map feel
 * slow. This ships the whole day at once so a tap is local. Trains on the same
 * route share one polyline, so the shapes are deduplicated: `shapes` is keyed by
 * shape id and each train points at one.
 *
 * It is NOT a second implementation: every shape comes from the same
 * prepareShape() and every stop distance from the same placeOn() that the
 * per-train endpoint uses, for the same trip choice (pickTripsFor mirrors
 * pickTrip). For any train, bundle and per-train endpoint agree to the byte —
 * the test compares them for every train of the day.
 *
 * Building a day takes a second or so, so it is done once per feed import (and at
 * most hourly), in slices that hand the event loop back, never per request; the
 * packed result (JSON + gzip) is what gets served.
 */

const crypto = require('crypto');
const zlib   = require('zlib');
const { promisify } = require('util');

const routeShape = require('./routeShape');

const gzip = promisify(zlib.gzip);

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_DATES    = 4;
const SLICE        = 15;   // trains per slice before yielding to the event loop

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

const cache = new Map();      // date -> { at, dataVersion, value }
const inFlight = new Map();   // date -> Promise

/** @returns {Promise<object|null>} null when no train has a shape that day */
async function build(date) {
    const picks = routeShape.pickTripsFor(date);
    if (picks.size === 0) return null;

    const nums = [...picks.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const shapes = {};
    const trains = {};
    let i = 0;
    for (const num of nums) {
        const { tripId, shapeId } = picks.get(num);
        const prepared = routeShape.preparedShape(shapeId);
        if (prepared) {                                   // an unusable shape is simply absent, as a 404 is
            const placed = routeShape.placeOn(prepared, routeShape.stopsOfTrip(tripId));
            if (!shapes[shapeId]) {
                shapes[shapeId] = { encoding: 'polyline6', shape: prepared.shape, totalMeters: prepared.totalMeters };
            }
            trains[num] = { shapeId, stops: placed.stops };
        }
        if (++i % SLICE === 0) await yieldLoop();
    }
    if (Object.keys(trains).length === 0) return null;

    // Deterministic order, so the version only moves when the content does.
    const sortedShapes = Object.fromEntries(Object.keys(shapes).sort().map(k => [k, shapes[k]]));
    const content = { serviceDate: date, shapes: sortedShapes, trains };
    const version = crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex').slice(0, 16);

    const json = Buffer.from(JSON.stringify({ version, ...content }));
    return {
        version,
        serviceDate: date,
        json,
        gzip: await gzip(json, { level: 9 }),
        etag: `"${version}"`,
        shapesCount: Object.keys(sortedShapes).length,
        trainsCount: Object.keys(trains).length,
    };
}

/**
 * The packed bundle for `date`, built at most once per feed import and hour.
 * Concurrent requests for a date that is still building share that one build.
 */
async function bundleFor(date) {
    const dv = routeShape.dataVersion();
    const hit = cache.get(date);
    if (hit && hit.dataVersion === dv && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    if (inFlight.has(date)) return inFlight.get(date);
    const job = (async () => {
        const value = await build(date);
        if (value) {                       // an empty day is not cached: nothing to be saved by it
            cache.set(date, { at: Date.now(), dataVersion: dv, value });
            while (cache.size > MAX_DATES) cache.delete(cache.keys().next().value);
        }
        return value;
    })().finally(() => inFlight.delete(date));
    inFlight.set(date, job);
    return job;
}

function _reset() { cache.clear(); inFlight.clear(); }

module.exports = { bundleFor, build, _reset };
