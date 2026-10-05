'use strict';

/**
 * progress.js — derive journey progress from a live GPS position and the trip's
 * static geometry, for trains NAP publishes a VehiclePosition but no TripUpdate
 * for. It answers only what the position honestly supports: how far along the
 * route the train is, which stop is next, and which are behind. It invents no
 * delay and no predicted times — those are unknown when there's no TripUpdate.
 *
 * Everything here is pure (lat/lon in, numbers out) so it is unit-tested without
 * a database or a network. The DB-backed geometry loader lives elsewhere.
 *
 * Method: project the point onto the route polyline (the GTFS shape when
 * present, otherwise the straight segments between consecutive stops), take the
 * distance travelled ALONG the line, and place the train against each stop's own
 * distance-along. Distances use a local equirectangular projection to metres —
 * exact enough at rail scale, and cheap.
 */

const EARTH_R = 6371000; // metres
const toRad = (d) => (d * Math.PI) / 180;

// Project a {lat, lon} to local planar metres about a reference latitude.
function toXY(pt, refLatRad) {
    return {
        x: toRad(pt.lon) * Math.cos(refLatRad) * EARTH_R,
        y: toRad(pt.lat) * EARTH_R,
    };
}

/**
 * Precompute a polyline for repeated projection: planar vertices plus the
 * cumulative distance to each, so a projection can report distance-along.
 * @param {{lat:number,lon:number}[]} points  ordered vertices (shape or stops)
 */
function prepareLine(points) {
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error('a polyline needs at least two points');
    }
    const refLatRad = toRad(points.reduce((s, p) => s + p.lat, 0) / points.length);
    const xy = points.map((p) => toXY(p, refLatRad));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
    }
    return { xy, cum, refLatRad, total: cum[cum.length - 1] };
}

/**
 * Distance ALONG the line to the nearest point on it, plus the perpendicular
 * distance (how far off the line the point sits — a confidence signal).
 * @returns {{along:number, offset:number}}
 */
function project(line, pt) {
    const p = toXY(pt, line.refLatRad);
    let best = { along: 0, offset: Infinity };
    for (let i = 0; i < line.xy.length - 1; i++) {
        const a = line.xy[i];
        const b = line.xy[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const segLen2 = dx * dx + dy * dy;
        // t = clamped scalar projection of P onto segment AB
        const t = segLen2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLen2));
        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        const offset = Math.hypot(p.x - projX, p.y - projY);
        if (offset < best.offset) {
            best = { along: line.cum[i] + t * Math.sqrt(segLen2), offset };
        }
    }
    return best;
}

/**
 * Distance-along of each stop on a prepared line. This depends only on the route,
 * not on the train's position, so callers that locate many positions on one route
 * compute it once and reuse it with locatePrepared().
 */
function prepareStops(line, stops) {
    return stops.map((s) => project(line, s).along);
}

/**
 * Where the train is against its stops, given the stops' distances already
 * computed by prepareStops(): one projection of the position, nothing else.
 *
 * @param {object} line         from prepareLine (shape or stop-to-stop)
 * @param {number[]} stopAlong  from prepareStops(line, stops)
 * @param {{lat,lon}} pos       live vehicle position
 * @returns {{
 *   progress:number,          // 0..1 along the whole route
 *   lastPassedIndex:number,   // -1 before the first stop
 *   nextIndex:number|null,    // null once past the last stop
 *   offsetMeters:number       // how far the position sat off the line
 * }}
 */
function locatePrepared(line, stopAlong, pos) {
    const here = project(line, pos);

    let lastPassedIndex = -1;
    for (let i = 0; i < stopAlong.length; i++) {
        if (stopAlong[i] <= here.along + 1) lastPassedIndex = i; // +1m tolerance at a stop
        else break;
    }
    const nextIndex = lastPassedIndex + 1 < stopAlong.length ? lastPassedIndex + 1 : null;

    const progress = line.total > 0 ? Math.max(0, Math.min(1, here.along / line.total)) : 0;
    return { progress, lastPassedIndex, nextIndex, offsetMeters: here.offset };
}

/**
 * Where the train is against its stops (one-shot form of prepareStops + locatePrepared).
 * @param {{lat,lon}[]} stops ordered stop coordinates
 */
function locate(line, stops, pos) {
    return locatePrepared(line, prepareStops(line, stops), pos);
}

module.exports = { prepareLine, project, prepareStops, locatePrepared, locate, _toXY: toXY };
